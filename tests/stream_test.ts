/**
 * Web Streams + push codec.
 *
 * Exercise it the way a caller would: arbitrary chunk boundaries, real
 * backpressure through `pipeThrough`, and failure as a stream rejection.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gzipSync as nodeGzip, gunzipSync as nodeGunzip } from "node:zlib";
import { gzipSync as fflateGzip, gunzipSync as fflateGunzip } from "fflate";
import {
	CompressFast,
	CompressStrong,
	compressFast,
	compressFastStream,
	compressStrong,
	compressStrongStream,
	Decompress,
	decompress,
	decompressStream,
	GzipError,
	GzipErrorCode,
} from "../dist/index.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function payload(n: number): Uint8Array {
	const out = new Uint8Array(n);
	const unit = bytes('{"id":0,"name":"alpha","v":123456}\n');
	for (let i = 0; i < n; i += unit.length) {
		out.set(unit.subarray(0, Math.min(unit.length, n - i)), i);
	}
	return out;
}

function concat(parts: Array<Uint8Array>): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

async function runStream(
	frame: Uint8Array,
	chunk: number,
	opts?: { checksum?: boolean },
): Promise<Uint8Array> {
	const src = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < frame.length; i += chunk) {
				controller.enqueue(
					frame.subarray(i, Math.min(i + chunk, frame.length)),
				);
			}
			controller.close();
		},
	});
	const parts: Array<Uint8Array> = [];
	for await (const part of src.pipeThrough(decompressStream(opts))) {
		parts.push(part);
	}
	return concat(parts);
}

function runPush(frame: Uint8Array, chunk: number): Uint8Array {
	const parts: Array<Uint8Array> = [];
	const dec = new Decompress((data: Uint8Array, final?: boolean) => {
		if (!final && data.length) parts.push(data);
	});
	for (let i = 0; i < frame.length; i += chunk) {
		dec.push(frame.subarray(i, Math.min(i + chunk, frame.length)));
	}
	dec.push(new Uint8Array(0), true);
	return concat(parts);
}

describe("decompressStream", () => {
	test("matches one-shot decompress across chunk sizes", async () => {
		const src = payload(80_000);
		const frame = compressStrong(src);
		for (const chunk of [1, 7, 64, 1024, 65_536, frame.length * 2]) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- chunk sizes run in sequence
			assert.deepEqual(await runStream(frame, chunk), src, `chunk=${chunk}`);
		}
	});

	test("push API matches one-shot across chunk sizes", () => {
		const src = payload(40_000);
		const frame = compressFast(src);
		for (const chunk of [1, 13, 4096]) {
			assert.deepEqual(runPush(frame, chunk), src, `chunk=${chunk}`);
		}
	});

	test("multi-member input concatenates", async () => {
		const a = bytes("aaa".repeat(200));
		const b = bytes("bbb".repeat(300));
		const fa = compressFast(a);
		const fb = compressStrong(b);
		const joined = new Uint8Array(fa.length + fb.length);
		joined.set(fa);
		joined.set(fb, fa.length);
		const expected = new Uint8Array(a.length + b.length);
		expected.set(a);
		expected.set(b, a.length);
		assert.deepEqual(await runStream(joined, 17), expected);
		assert.deepEqual(runPush(joined, 9), expected);
	});

	test("empty member yields empty output", async () => {
		const frame = compressStrong(new Uint8Array(0));
		assert.deepEqual(await runStream(frame, 8), new Uint8Array(0));
	});

	test("truncated input rejects the stream", async () => {
		const frame = compressStrong(payload(20_000));
		await assert.rejects(
			() => runStream(frame.subarray(0, frame.length - 20), 64),
			(err: unknown) => err instanceof GzipError,
		);
	});

	test("bad CRC rejects by default; checksum:false still returns", async () => {
		const src = bytes("stream-crc");
		const gz = compressFast(src);
		const bad = gz.slice();
		bad[bad.length - 8] = (bad[bad.length - 8] ?? 0) ^ 0xff;
		await assert.rejects(
			() => runStream(bad, 4),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.ChecksumMismatch,
		);
		assert.deepEqual(await runStream(bad, 4, { checksum: false }), src);
	});

	test("output slices are owned, not views into decoder state", async () => {
		const src = payload(120_000);
		const out = await runStream(compressStrong(src), 2048);
		assert.deepEqual(out, src);
		assert.deepEqual(decompress(compressStrong(src)), src);
	});

	test("trailing padding after a member is rejected", async () => {
		const src = bytes("pad-after-gzip");
		const gz = compressFast(src);
		const padded = new Uint8Array(gz.length + 4);
		padded.set(gz);
		assert.throws(
			() => decompress(padded),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
		);
		await assert.rejects(
			() => runStream(padded, 5),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
		);
		assert.throws(
			() => runPush(padded, 3),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
		);
	});

	test("lone trailing 0x1f after a member is rejected", async () => {
		const src = bytes("lone-1f");
		const gz = compressFast(src);
		const junk = new Uint8Array(gz.length + 1);
		junk.set(gz);
		junk[gz.length] = 0x1f;
		assert.throws(() => decompress(junk), GzipError);
		await assert.rejects(() => runStream(junk, 3), GzipError);
		assert.throws(() => runPush(junk, 1), GzipError);
	});

	test("trailing 0x1f-prefixed junk after a member is rejected", async () => {
		const src = bytes("onef-junk");
		const gz = compressFast(src);
		const junk = new Uint8Array(gz.length + 3);
		junk.set(gz);
		junk[gz.length] = 0x1f;
		junk[gz.length + 1] = 0x00;
		junk[gz.length + 2] = 0xff;
		assert.throws(
			() => decompress(junk),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
		);
		await assert.rejects(
			() => runStream(junk, 4),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
		);
		assert.throws(
			() => runPush(junk, 2),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
		);
	});

	test("leftover input is copied off a reusable scratch buffer", () => {
		const src = payload(8_000);
		const frame = compressFast(src);
		const scratch = new Uint8Array(7);
		const parts: Array<Uint8Array> = [];
		const dec = new Decompress((data: Uint8Array, final?: boolean) => {
			if (!final && data.length) parts.push(data);
		});
		for (let i = 0; i < frame.length; i += scratch.length) {
			const n = Math.min(scratch.length, frame.length - i);
			scratch.fill(0xaa);
			scratch.set(frame.subarray(i, i + n));
			dec.push(scratch.subarray(0, n));
		}
		dec.push(new Uint8Array(0), true);
		assert.deepEqual(concat(parts), src);
	});

	test("push checksum:false skips a bad CRC", () => {
		const src = bytes("push-crc");
		const gz = compressFast(src);
		const bad = gz.slice();
		bad[bad.length - 8] = (bad[bad.length - 8] ?? 0) ^ 0xff;
		const dec = new Decompress(undefined, { checksum: false });
		const parts: Array<Uint8Array> = [];
		dec.ondata = (data, final) => {
			if (!final && data.length) parts.push(data);
		};
		dec.push(bad, true);
		assert.deepEqual(concat(parts), src);
	});

	test("bad ISIZE rejects; checksum:false still returns", async () => {
		const src = bytes("isize-stream");
		const gz = compressFast(src);
		const bad = gz.slice();
		bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
		await assert.rejects(
			() => runStream(bad, 3),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch,
		);
		assert.deepEqual(await runStream(bad, 3, { checksum: false }), src);
		const dec = new Decompress();
		assert.throws(
			() => dec.push(bad, true),
			(err: unknown) =>
				err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch,
		);
	});

	test("truncated push throws GzipError", () => {
		const frame = compressStrong(payload(8_000));
		const dec = new Decompress();
		assert.throws(
			() => dec.push(frame.subarray(0, frame.length - 12), true),
			(err: unknown) => err instanceof GzipError,
		);
	});

	test("push after final throws", () => {
		const dec = new Decompress();
		dec.push(compressFast(bytes("done")), true);
		assert.throws(
			() => dec.push(bytes("more")),
			(err: unknown) =>
				err instanceof TypeError &&
				err.message === "Decompress.push called after final",
		);
	});

	test("ondata final is one empty chunk", () => {
		let finals = 0;
		let finalLen = -1;
		const dec = new Decompress((data, final) => {
			if (final) {
				finals++;
				finalLen = data.length;
			}
		});
		dec.push(compressFast(bytes("fin")), true);
		assert.equal(finals, 1);
		assert.equal(finalLen, 0);
	});

	test("emitted slices survive later window writes", () => {
		const src = payload(80_000);
		const frame = compressStrong(src);
		const parts: Array<Uint8Array> = [];
		const dec = new Decompress((data, final) => {
			if (!final && data.length) parts.push(data);
		});
		const mid = (frame.length / 2) | 0;
		dec.push(frame.subarray(0, mid));
		assert.ok(parts.length > 0, "expected output before the window slides");
		const first = parts[0] ?? new Uint8Array(0);
		const snap = first.slice();
		first.fill(0x55);
		dec.push(frame.subarray(mid), true);
		assert.deepEqual(snap, src.subarray(0, snap.length));
		parts[0] = snap;
		assert.deepEqual(concat(parts), src);
	});

	test("node and fflate gzip decode through the stream", async () => {
		const src = payload(12_000);
		const viaNode = new Uint8Array(nodeGzip(src));
		const viaFflate = fflateGzip(src);
		assert.deepEqual(await runStream(viaNode, 17), src);
		assert.deepEqual(await runStream(viaFflate, 9), src);
		assert.deepEqual(runPush(viaNode, 5), src);
	});

	test("FNAME extra header is skipped", async () => {
		const src = bytes("named-member");
		const gz = compressFast(src);
		const name = bytes("note.txt\0");
		const withName = new Uint8Array(gz.length + name.length);
		withName.set(gz.subarray(0, 10));
		withName[3] = (withName[3] ?? 0) | 8;
		withName.set(name, 10);
		withName.set(gz.subarray(10), 10 + name.length);
		assert.deepEqual(decompress(withName), src);
		assert.deepEqual(await runStream(withName, 4), src);
		assert.deepEqual(runPush(withName, 6), src);
	});

	test("corrupt input rejects as GzipError", async () => {
		const frame = compressStrong(payload(16_000));
		let seed = 24_601;
		const rnd = (): number =>
			(seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
		let saw = 0;
		for (let trial = 0; trial < 24; trial++) {
			const bad = frame.slice();
			for (let k = 0; k < 3; k++) {
				const at = 12 + Math.floor(rnd() * (bad.length - 16));
				bad[at] = Math.floor(rnd() * 256);
			}
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- trials run in sequence
				await runStream(bad, 64);
			} catch (err) {
				assert.ok(
					err instanceof GzipError,
					`expected GzipError, got ${err instanceof Error ? err.constructor.name : typeof err}`,
				);
				saw++;
			}
		}
		assert.ok(saw > 0, "corruption had no observable reject");
	});
});

const STREAM_BLOCK = 32768;

type Ctor = new (ondata?: (data: Uint8Array, final?: boolean) => unknown) => {
	push(chunk: Uint8Array, final?: boolean): void;
};

function collectPush(Ctor: Ctor, src: Uint8Array, chunk: number): Uint8Array {
	const parts: Array<Uint8Array> = [];
	const enc = new Ctor((data) => {
		if (data.length > 0) parts.push(data.slice());
	});
	if (src.length === 0 || chunk <= 0 || chunk >= src.length) {
		enc.push(src, true);
	} else {
		for (let i = 0; i < src.length; i += chunk) {
			const end = Math.min(i + chunk, src.length);
			enc.push(src.subarray(i, end), end === src.length);
		}
	}
	return concat(parts);
}

async function runCompressStream(
	factory: () => TransformStream<Uint8Array, Uint8Array>,
	src: Uint8Array,
	chunk: number,
): Promise<Uint8Array> {
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			if (src.length === 0) {
				controller.close();
				return;
			}
			for (let i = 0; i < src.length; i += chunk) {
				controller.enqueue(src.subarray(i, Math.min(i + chunk, src.length)));
			}
			controller.close();
		},
	});
	const parts: Array<Uint8Array> = [];
	for await (const part of input.pipeThrough(factory())) {
		parts.push(part);
	}
	return concat(parts);
}

function assertGzipMember(
	frame: Uint8Array,
	src: Uint8Array,
	label: string,
): void {
	assert.equal(frame[0], 31, `${label}: ID1`);
	assert.equal(frame[1], 139, `${label}: ID2`);
	assert.equal(frame[2], 8, `${label}: CM`);
	assert.deepEqual(decompress(frame), src, `${label} wgzip`);
	assert.deepEqual(new Uint8Array(nodeGunzip(frame)), src, `${label} node`);
	assert.deepEqual(fflateGunzip(frame), src, `${label} fflate`);
}

describe("compressFast / compressStrong streams", () => {
	const tiers = [
		["Fast", CompressFast, compressFastStream, 4],
		["Strong", CompressStrong, compressStrongStream, 2],
	] as const;

	for (const [name, Ctor, factory, xfl] of tiers) {
		test(`${name} push matches decode across chunk sizes`, () => {
			const src = payload(80_000);
			for (const chunk of [1, 7, 64, 1024, 65_536, src.length * 2]) {
				const frame = collectPush(Ctor, src, chunk);
				assert.equal(frame[8], xfl, `${name} XFL`);
				assertGzipMember(frame, src, `${name} push chunk=${chunk}`);
			}
		});

		test(`${name} TransformStream matches push`, async () => {
			const src = payload(60_000);
			const viaPush = collectPush(Ctor, src, 4096);
			const viaStream = await runCompressStream(factory, src, 4096);
			assertGzipMember(viaStream, src, `${name} TransformStream`);
			assert.deepEqual(viaStream, viaPush);
		});

		test(`${name} empty input is a valid gzip member`, () => {
			const frame = collectPush(Ctor, new Uint8Array(0), 8);
			assert.equal(frame[8], xfl, `${name} empty XFL`);
			assertGzipMember(frame, new Uint8Array(0), `${name} empty`);
		});

		test(`${name} round-trips past the 32 KiB window`, () => {
			const src = payload(STREAM_BLOCK + 50_000);
			const frame = collectPush(Ctor, src, 20_000);
			assertGzipMember(frame, src, `${name} >window`);
		});

		test(`${name} emits blocks before flush`, () => {
			const src = payload(STREAM_BLOCK * 2 + 20_000);
			const parts: Array<Uint8Array> = [];
			const enc = new Ctor((data: Uint8Array) => {
				if (data.length > 0) parts.push(data.slice());
			});
			enc.push(src.subarray(0, STREAM_BLOCK + 8_000));
			assert.ok(
				parts.length > 0,
				`${name}: header + first block should leave before flush`,
			);
			enc.push(src.subarray(STREAM_BLOCK + 8_000), true);
			assertGzipMember(concat(parts), src, `${name} early emit`);
		});

		test(`${name} push after final throws`, () => {
			const enc = new Ctor();
			enc.push(bytes("ok"), true);
			assert.throws(() => enc.push(bytes("more")), TypeError);
		});
	}

	test("a match that starts on a 32 KiB block seam is taken", () => {
		const src = new Uint8Array(STREAM_BLOCK + 64);
		for (let i = 0; i < src.length; i++) {
			src[i] = (Math.imul(i + 17, 1103515245) >>> 24) & 0xff;
		}
		src.set(src.subarray(STREAM_BLOCK - 32, STREAM_BLOCK), STREAM_BLOCK);
		const streamed = collectPush(CompressFast, src, STREAM_BLOCK);
		const oneshot = compressFast(src);
		assertGzipMember(streamed, src, "seam");
		assert.ok(
			streamed.length <= oneshot.length + 32,
			`streaming ${streamed.length} vs one-shot ${oneshot.length}`,
		);
	});

	test("a single large push past the window round-trips", () => {
		const src = payload(STREAM_BLOCK + 80_000);
		const frame = collectPush(CompressFast, src, src.length);
		assertGzipMember(frame, src, "Fast single large push");
	});

	test("a match on a 32 KiB seam is taken by Strong too", () => {
		const src = new Uint8Array(STREAM_BLOCK + 64);
		for (let i = 0; i < src.length; i++) {
			src[i] = (Math.imul(i + 17, 1103515245) >>> 24) & 0xff;
		}
		src.set(src.subarray(STREAM_BLOCK - 32, STREAM_BLOCK), STREAM_BLOCK);
		const streamed = collectPush(CompressStrong, src, STREAM_BLOCK);
		assertGzipMember(streamed, src, "strong seam");
	});

	test("ondata can be assigned after construct", () => {
		const src = bytes("late-handler");
		const parts: Array<Uint8Array> = [];
		const enc = new CompressFast();
		enc.ondata = (data) => {
			if (data.length > 0) parts.push(data.slice());
		};
		enc.push(src, true);
		assertGzipMember(concat(parts), src, "late ondata");
	});

	test("empty TransformStream readable is a valid member", async () => {
		const frame = await runCompressStream(
			compressFastStream,
			new Uint8Array(0),
			8,
		);
		assertGzipMember(frame, new Uint8Array(0), "ts empty");
	});
});

describe("compress then decompress pipelines", () => {
	test("one-shot encode still round-trips through streaming decode", async () => {
		const src = payload(25_000);
		const fast = compressFast(src);
		const strong = compressStrong(src);
		assert.deepEqual(await runStream(fast, 1), src);
		assert.deepEqual(runPush(strong, 7), src);
		assert.deepEqual(decompress(fast), src);
		assert.deepEqual(decompress(strong), src);
	});

	test("streaming encode still round-trips through one-shot decode", () => {
		const src = payload(40_000);
		const streamed = collectPush(CompressFast, src, 1024);
		assert.deepEqual(decompress(streamed), src);
		assert.deepEqual(new Uint8Array(nodeGunzip(streamed)), src);
	});

	test("TransformStream encode pipes into TransformStream decode", async () => {
		const src = payload(50_000);
		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < src.length; i += 3000) {
					controller.enqueue(src.subarray(i, Math.min(i + 3000, src.length)));
				}
				controller.close();
			},
		});
		const parts: Array<Uint8Array> = [];
		for await (const part of input
			.pipeThrough(compressStrongStream())
			.pipeThrough(decompressStream())) {
			parts.push(part);
		}
		assert.deepEqual(concat(parts), src);
	});

	test("one-shot Fast/Strong stay deterministic", () => {
		const src = payload(8_000);
		assert.deepEqual(compressFast(src), compressFast(src));
		assert.deepEqual(compressStrong(src), compressStrong(src));
	});
});
