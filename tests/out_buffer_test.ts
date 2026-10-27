import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compressFast,
	compressStrong,
	decompress,
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

test("exact out size → same reference", () => {
	const data = utf8("exact-out-identity");
	const gz = compressStrong(data);
	const buf = new Uint8Array(data.length);
	const out = decompress(gz, { out: buf });
	assert.equal(out, buf);
	assert.deepEqual(out, data);
});

test("out larger than payload → subarray view of same buffer", () => {
	const data = utf8("larger-out");
	const gz = compressFast(data);
	const buf = new Uint8Array(data.length + 16);
	const out = decompress(gz, { out: buf });
	assert.equal(out.buffer, buf.buffer);
	assert.equal(out.byteOffset, buf.byteOffset);
	assert.equal(out.length, data.length);
	assert.deepEqual(out, data);
});

test("out too small → SizeMismatch (even with checksum:false)", () => {
	const data = utf8("out-too-small-payload");
	const gz = compressStrong(data);
	const buf = new Uint8Array(Math.max(0, data.length - 1));
	assert.throws(
		() => decompress(gz, { out: buf }),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch,
	);
	assert.throws(
		() => decompress(gz, { out: buf, checksum: false }),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch,
	);
});

test("multi-member + out → InvalidHeader", () => {
	const a = compressFast(utf8("aaa"));
	const b = compressStrong(utf8("bbb"));
	const joined = concat(a, b);
	const buf = new Uint8Array(6);
	assert.throws(
		() => decompress(joined, { out: buf }),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
	);
	// Without out, multi-member still works.
	assert.equal(new TextDecoder().decode(decompress(joined)), "aaabbb");
});

test("maxSize smaller than out still caps with OutputTooLarge", () => {
	const data = utf8("max-vs-out");
	const gz = compressFast(data);
	const buf = new Uint8Array(data.length + 32);
	assert.throws(
		() => decompress(gz, { out: buf, maxSize: 4 }),
		(err: unknown) =>
			err instanceof GzipError &&
			err.code === GzipErrorCode.OutputTooLarge &&
			err.message === "output exceeds maxSize",
	);
});

test("maxSize larger than out still SizeMismatch when out is too small", () => {
	const data = utf8("out-bounds-first");
	const gz = compressFast(data);
	const buf = new Uint8Array(Math.max(0, data.length - 1));
	assert.throws(
		() => decompress(gz, { out: buf, maxSize: 1 << 20 }),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch,
	);
});
