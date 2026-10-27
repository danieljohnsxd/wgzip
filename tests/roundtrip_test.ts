import assert from "node:assert/strict";
import { crc32 as nodeCrc32, gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import { gzipSync as fflateGzip, gunzipSync as fflateGunzip } from "fflate";
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

const samples: Array<{ name: string; data: Uint8Array }> = [
	{ name: "empty", data: new Uint8Array(0) },
	{ name: "single byte", data: new Uint8Array([0x42]) },
	{ name: "hello", data: utf8("hello world") },
	{
		name: "lorem",
		data: utf8(
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
		),
	},
	{ name: "zeros 1k", data: new Uint8Array(1024) },
	{
		name: "random-ish",
		data: Uint8Array.from({ length: 4096 }, (_, i) => (i * 17 + 31) & 255),
	},
	{
		name: "repeats",
		data: utf8("abc".repeat(2000)),
	},
];

for (const { name, data } of samples) {
	test(`compressFast round-trip: ${name}`, () => {
		const gz = compressFast(data);
		assert.equal(gz[0], 31);
		assert.equal(gz[1], 139);
		const out = decompress(gz);
		assert.deepEqual(out, data);
	});

	test(`compressStrong round-trip: ${name}`, () => {
		const gz = compressStrong(data);
		const out = decompress(gz);
		assert.deepEqual(out, data);
	});

	test(`node gunzip accepts compressFast: ${name}`, () => {
		const gz = compressFast(data);
		const out = gunzipSync(gz);
		assert.deepEqual(new Uint8Array(out), data);
	});

	test(`node gunzip accepts compressStrong: ${name}`, () => {
		const gz = compressStrong(data);
		const out = gunzipSync(gz);
		assert.deepEqual(new Uint8Array(out), data);
	});

	test(`decompress node gzip: ${name}`, () => {
		const gz = new Uint8Array(gzipSync(data));
		const out = decompress(gz);
		assert.deepEqual(out, data);
	});

	test(`decompress fflate gzip: ${name}`, () => {
		const gz = fflateGzip(data);
		const out = decompress(gz);
		assert.deepEqual(out, data);
	});

	test(`fflate gunzip accepts our Strong: ${name}`, () => {
		const gz = compressStrong(data);
		const out = fflateGunzip(gz);
		assert.deepEqual(out, data);
	});
}

test("multi-member gzip", () => {
	const a = compressFast(utf8("aaa"));
	const b = compressStrong(utf8("bbb"));
	const joined = concat(a, b);
	const out = decompress(joined);
	assert.equal(new TextDecoder().decode(out), "aaabbb");
});

test("checksum detects corruption", () => {
	const gz = compressFast(utf8("payload"));
	const corrupt = gz.slice();
	// Flip a byte in the deflate body (past 10-byte header).
	corrupt[12] = (corrupt[12] ?? 0) ^ 0xff;
	assert.throws(
		() => decompress(corrupt),
		(err: unknown) =>
			err instanceof GzipError &&
			(err.code === GzipErrorCode.ChecksumMismatch ||
				err.code === GzipErrorCode.InvalidLengthLiteral ||
				err.code === GzipErrorCode.InvalidDistance ||
				err.code === GzipErrorCode.UnexpectedEOF ||
				err.code === GzipErrorCode.InvalidBlockType),
	);
});

test("checksum: false skips CRC", () => {
	// Valid stream still works with checksum disabled.
	const data = utf8("skip check");
	const gz = compressFast(data);
	const out = decompress(gz, { checksum: false });
	assert.deepEqual(out, data);
});

test("invalid header", () => {
	assert.throws(
		() => decompress(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.InvalidHeader,
	);
});

test("preallocated out buffer", () => {
	const data = utf8("outbuf");
	const gz = compressStrong(data);
	const buf = new Uint8Array(data.length);
	const out = decompress(gz, { out: buf });
	assert.equal(out, buf);
	assert.deepEqual(out, data);
});

test("FNAME / FEXTRA / FHCRC headers decode; bad FHCRC rejected like node", () => {
	const data = utf8("optional-header-fields");
	const gz = compressFast(data);
	const name = utf8("a.txt\0");
	const extra = new Uint8Array([2, 0, 0xaa, 0xbb]);
	const flg = 2 | 4 | 8;
	const out = new Uint8Array(gz.length + extra.length + name.length + 2);
	out.set(gz.subarray(0, 10));
	out[3] = flg;
	let at = 10;
	out.set(extra, at);
	at += extra.length;
	out.set(name, at);
	at += name.length;
	// FHCRC = low 16 bits of CRC32 over every header byte before it.
	const hcrc = nodeCrc32(out.subarray(0, at)) & 0xffff;
	out[at] = hcrc & 255;
	out[at + 1] = hcrc >> 8;
	at += 2;
	out.set(gz.subarray(10), at);
	assert.deepEqual(new Uint8Array(gunzipSync(out)), data);
	assert.deepEqual(decompress(out), data);

	const bad = out.slice();
	bad[at - 2] = (bad[at - 2] ?? 0) ^ 1;
	assert.throws(() => gunzipSync(bad));
	assert.throws(
		() => decompress(bad),
		(err: unknown) =>
			err instanceof GzipError &&
			err.code === GzipErrorCode.InvalidHeader &&
			err.message === "header crc mismatch",
	);
	// checksum:false skips header CRC too (zlib's inflateValidate does the same).
	assert.deepEqual(decompress(bad, { checksum: false }), data);
});
