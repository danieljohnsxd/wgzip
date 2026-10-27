/**
 * Parser strictness vs node:zlib.gunzipSync: reserved FLG bits, trailing
 * garbage, truncated extra members. Same reject/accept on every entry point.
 */
import assert from "node:assert/strict";
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { test } from "node:test";
import {
	compressFast,
	Decompress,
	decompress,
	decompressStream,
	GzipError,
	GzipErrorCode,
} from "../dist/index.js";

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function nodeThrows(buf: Uint8Array): boolean {
	try {
		nodeGunzipSync(buf);
		return false;
	} catch {
		return true;
	}
}

function wgzipThrows(buf: Uint8Array): boolean {
	try {
		decompress(buf);
		return false;
	} catch {
		return true;
	}
}

function pushThrows(buf: Uint8Array): unknown {
	const dec = new Decompress();
	try {
		dec.push(buf, true);
		return undefined;
	} catch (err) {
		return err;
	}
}

async function streamThrows(buf: Uint8Array): Promise<unknown> {
	const src = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(buf);
			controller.close();
		},
	});
	try {
		for await (const chunk of src.pipeThrough(decompressStream())) {
			void chunk;
		}
		return undefined;
	} catch (err) {
		return err;
	}
}

function isInvalidHeader(err: unknown, message?: string): boolean {
	return (
		err instanceof GzipError &&
		err.code === GzipErrorCode.InvalidHeader &&
		(message === undefined || err.message === message)
	);
}

test("reserved FLG bits are InvalidHeader on every path", async () => {
	const gz = compressFast(utf8("flags"));
	for (const bit of [0x20, 0x40, 0x80, 0xe0]) {
		const bad = gz.slice();
		bad[3] = (bad[3] ?? 0) | bit;
		assert.equal(wgzipThrows(bad), nodeThrows(bad), `bit ${bit.toString(16)}`);
		assert.throws(
			() => decompress(bad),
			(err: unknown) => isInvalidHeader(err, "reserved header flag set"),
		);
		assert.throws(
			() => decompress(bad, { checksum: false }),
			(err: unknown) => isInvalidHeader(err, "reserved header flag set"),
		);
		const buf = new Uint8Array(16);
		assert.throws(
			() => decompress(bad, { out: buf }),
			(err: unknown) => isInvalidHeader(err, "reserved header flag set"),
		);
		const pushed = pushThrows(bad);
		assert.ok(isInvalidHeader(pushed, "reserved header flag set"));
		// oxlint-disable-next-line eslint/no-await-in-loop -- bits run in sequence
		const streamed = await streamThrows(bad);
		assert.ok(isInvalidHeader(streamed, "reserved header flag set"));
	}
});

test("trailing garbage / truncated member: wgzip throws iff node throws", async () => {
	const gz = compressFast(utf8("hello"));
	const probes: Array<{ name: string; buf: Uint8Array }> = [
		{
			name: "reserved E0",
			buf: (() => {
				const b = gz.slice();
				b[3] = (b[3] ?? 0) | 0xe0;
				return b;
			})(),
		},
		{
			name: "6 junk bytes",
			buf: concat(gz, new Uint8Array([1, 2, 3, 4, 5, 6])),
		},
		{ name: "lone 0x1f", buf: concat(gz, new Uint8Array([0x1f])) },
		{
			name: "junk starting with 0x1f",
			buf: concat(gz, new Uint8Array([0x1f, 0x00, 0xff])),
		},
		{ name: "truncated second header", buf: concat(gz, gz.subarray(0, 10)) },
		{
			name: "truncated second member (no trailer)",
			buf: concat(gz, gz.subarray(0, gz.length - 4)),
		},
	];
	for (const { name, buf } of probes) {
		assert.equal(
			wgzipThrows(buf),
			nodeThrows(buf),
			`${name}: wgzip=${wgzipThrows(buf)} node=${nodeThrows(buf)}`,
		);
		const pushed = pushThrows(buf);
		assert.equal(pushed !== undefined, nodeThrows(buf), `${name} push vs node`);
		// oxlint-disable-next-line eslint/no-await-in-loop -- probes run in sequence
		const streamed = await streamThrows(buf);
		assert.equal(
			streamed !== undefined,
			nodeThrows(buf),
			`${name} stream vs node`,
		);
	}
});

test("6 junk bytes after a member are trailing garbage", () => {
	const gz = compressFast(utf8("hello"));
	const junk = concat(gz, new Uint8Array([1, 2, 3, 4, 5, 6]));
	assert.throws(
		() => decompress(junk),
		(err: unknown) =>
			isInvalidHeader(err, "trailing garbage after gzip member"),
	);
	assert.throws(
		() => decompress(junk, { checksum: false }),
		(err: unknown) =>
			isInvalidHeader(err, "trailing garbage after gzip member"),
	);
	const buf = new Uint8Array(16);
	assert.throws(
		() => decompress(junk, { out: buf }),
		(err: unknown) =>
			isInvalidHeader(err, "trailing garbage after gzip member"),
	);
});

test("truncated second member is UnexpectedEOF", () => {
	const gz = compressFast(utf8("hello"));
	const trunc = concat(gz, gz.subarray(0, 10));
	assert.throws(
		() => decompress(trunc),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.UnexpectedEOF,
	);
	const pushed = pushThrows(trunc);
	assert.ok(
		pushed instanceof GzipError && pushed.code === GzipErrorCode.UnexpectedEOF,
	);
});
