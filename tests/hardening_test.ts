/**
 * Regressions for decoder DoS / safety findings. Each test reproduces the
 * attack with a small crafted input and asserts it is refused or bounded —
 * by error, allocation size, or a generous (< 1 s) time limit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import {
	compressFast,
	Decompress,
	decompress,
	decompressStream,
	GzipError,
	GzipErrorCode,
} from "../dist/index.js";
import { spyAllocs } from "./helpers/alloc_spy.ts";
import { gzipWrap } from "./helpers/craft.ts";

const MiB = 1024 * 1024;

function isCode(code: number, message?: string) {
	return (err: unknown): boolean =>
		err instanceof GzipError &&
		err.code === code &&
		(message === undefined || err.message === message);
}

/** Header with FNAME = `nameLen` bytes of 'a' (+ NUL unless `open`). */
function fnameHeader(nameLen: number, open = false): Uint8Array {
	const h = new Uint8Array(10 + nameLen + (open ? 0 : 1));
	h.set([31, 139, 8, 8, 0, 0, 0, 0, 0, 3]);
	h.fill(97, 10, 10 + nameLen);
	return h;
}

function withHeader(header: Uint8Array, gz: Uint8Array): Uint8Array {
	const out = new Uint8Array(header.length + gz.length - 10);
	out.set(header);
	out.set(gz.subarray(10), header.length);
	return out;
}

test("unterminated FNAME is refused after 64 KiB on every path", async () => {
	const tooLarge = isCode(GzipErrorCode.InvalidHeader, "gzip header too large");
	// Push: 8 MiB of name in 64 KiB chunks must fail early, not buffer it all.
	const dec = new Decompress(undefined, { maxSize: 1024 });
	const chunk = new Uint8Array(64 * 1024).fill(97);
	let pushed = 0;
	assert.throws(() => {
		dec.push(fnameHeader(0, true));
		for (; pushed < 8 * MiB; pushed += chunk.length) dec.push(chunk);
	}, tooLarge);
	assert.ok(pushed <= 128 * 1024, `threw after ${pushed} name bytes`);

	const big = fnameHeader(70_000, true);
	assert.throws(() => decompress(big), tooLarge);
	const src = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(big);
			c.close();
		},
	});
	await assert.rejects(async () => {
		for await (const part of src.pipeThrough(decompressStream())) void part;
	}, tooLarge);
});

test("a 60 KB FNAME fed one byte at a time stays linear", () => {
	const plain = new TextEncoder().encode("named");
	const gz = withHeader(fnameHeader(60_000), compressFast(plain));
	assert.deepEqual(new Uint8Array(gunzipSync(gz)), plain);
	assert.deepEqual(decompress(gz), plain);
	const parts: Array<Uint8Array> = [];
	const { total } = spyAllocs(() => {
		const dec = new Decompress((c) => parts.push(c));
		for (let i = 0; i < gz.length; i++) dec.push(gz.subarray(i, i + 1));
		dec.push(new Uint8Array(0), true);
	});
	assert.equal(Buffer.concat(parts).toString(), "named");
	// Re-buffering and re-scanning the header per push allocated ~1.8 GB.
	assert.ok(total < 16 * MiB, `allocated ${total} bytes in total`);
});

test("a 64 KiB stored block fed one byte at a time stays linear", () => {
	const plain = new Uint8Array(65_000).map((_, i) => (i * 131) & 255);
	const raw = new Uint8Array(deflateRawSync(plain, { level: 0 }));
	const gz = gzipWrap(raw, plain);
	let got = 0;
	const { total } = spyAllocs(() => {
		const dec = new Decompress((c) => {
			got += c.length;
		});
		for (let i = 0; i < gz.length; i++) dec.push(gz.subarray(i, i + 1));
		dec.push(new Uint8Array(0), true);
	});
	assert.equal(got, plain.length);
	// Re-buffering the block per push allocated ~2 GB here.
	assert.ok(total < 16 * MiB, `allocated ${total} bytes in total`);
});

test("default maxSize is 64 MiB on every entry; Infinity opts out", async () => {
	const cap = 64 * MiB;
	const bomb = new Uint8Array(gzipSync(new Uint8Array(cap + 1)));
	assert.ok(bomb.length < 100_000);
	const tooLarge = isCode(GzipErrorCode.OutputTooLarge);
	assert.throws(() => decompress(bomb), tooLarge);
	assert.throws(() => new Decompress().push(bomb, true), tooLarge);
	const src = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bomb);
			c.close();
		},
	});
	await assert.rejects(async () => {
		for await (const part of src.pipeThrough(decompressStream())) void part;
	}, tooLarge);
	assert.equal(decompress(bomb, { maxSize: Infinity }).length, cap + 1);
	// `out` bounds the write itself; no hidden 64 MiB cap on top of it.
	const exact = new Uint8Array(gzipSync(new Uint8Array(1000)));
	assert.equal(decompress(exact, { out: new Uint8Array(1000) }).length, 1000);
});

test("bad option types throw TypeError at call time on every entry", () => {
	const gz = compressFast(new Uint8Array(10));
	const bad: Array<unknown> = [
		{ maxSize: Number.NaN },
		{ maxSize: -1 },
		{ maxSize: 1.5 },
		{ maxSize: "10" },
		{ maxSize: null },
		{ maxSize: 2 ** 53 },
		{ maxSize: -Infinity },
		{ checksum: "no" },
		{ checksum: 0 },
		"opts",
	];
	for (const opts of bad) {
		const label = JSON.stringify(opts);
		// @ts-expect-error -- deliberately wrong types
		assert.throws(() => decompress(gz, opts), TypeError, `decompress ${label}`);
		// @ts-expect-error -- deliberately wrong types
		assert.throws(() => new Decompress(undefined, opts), TypeError, label);
		// @ts-expect-error -- deliberately wrong types
		assert.throws(() => decompressStream(opts), TypeError, `stream ${label}`);
	}
	// @ts-expect-error -- deliberately wrong type
	assert.throws(() => decompress(gz, { out: [0, 0] }), TypeError);
	// Valid edge values.
	assert.equal(
		decompress(compressFast(new Uint8Array(0)), { maxSize: 0 }).length,
		0,
	);
	assert.throws(
		() => decompress(gz, { maxSize: 0 }),
		isCode(GzipErrorCode.OutputTooLarge),
	);
	assert.equal(decompress(gz, { maxSize: Infinity }).length, 10);
	// @ts-expect-error -- null options behave like undefined
	assert.equal(decompress(gz, null).length, 10);
});

test("forged ISIZE never drives a large preallocation", () => {
	const gz = compressFast(new TextEncoder().encode("x"));
	const forged = gz.slice();
	new DataView(forged.buffer).setUint32(forged.length - 4, 0x0fff_ffff, true);
	const { max } = spyAllocs(() => {
		assert.throws(
			() => decompress(forged, { maxSize: Infinity }),
			isCode(GzipErrorCode.SizeMismatch),
		);
	});
	// 21-byte input: DEFLATE can expand at most ~1032x.
	assert.ok(
		max < 64 * 1024,
		`preallocated ${max} bytes from a ${gz.length}-byte input`,
	);
});

test("a failed output allocation surfaces as RangeError, not UnexpectedEOF", () => {
	const gz = new Uint8Array(gzipSync(new Uint8Array(8 * MiB)));
	// ISIZE 0 skips the exact prealloc so inflate grows its buffer.
	new DataView(gz.buffer).setUint32(gz.length - 4, 0, true);
	spyAllocs(() => {
		assert.throws(
			() => decompress(gz, { maxSize: Infinity }),
			(err: unknown) =>
				err instanceof RangeError && !(err instanceof GzipError),
		);
	}, 4 * MiB);
});

test("empty DEFLATE body is UnexpectedEOF, as in zlib", () => {
	const gz = gzipWrap(new Uint8Array(0), new Uint8Array(0));
	assert.throws(() => gunzipSync(gz));
	assert.throws(() => decompress(gz), isCode(GzipErrorCode.UnexpectedEOF));
});
