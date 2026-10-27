import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { crc32 as nodeCrc32 } from "node:zlib";
import {
	compressFast,
	decompress,
	GzipError,
	GzipErrorCode,
} from "../dist/index.js";

register(
	new URL("./helpers/resolve_ts_js.mjs", import.meta.url),
	pathToFileURL("./"),
);

const { crc32Of } = await import("../src/crc32.ts");

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

test("CRC-32 ISO 3309 check vectors", () => {
	assert.equal(crc32Of(new Uint8Array(0)), 0);
	assert.equal(crc32Of(utf8("a")), 0xe8b7be43);
	assert.equal(crc32Of(utf8("123456789")), 0xcbf43926);
	// Slice-by-8 must match node at every remainder (0..15) and on a long run.
	const long = new Uint8Array(257);
	for (let i = 0; i < long.length; ++i) long[i] = (i * 37) & 255;
	for (let n = 0; n <= 16; ++n) {
		const slice = long.subarray(0, n);
		assert.equal(crc32Of(slice), nodeCrc32(slice) >>> 0, `len ${n}`);
	}
	assert.equal(crc32Of(long), nodeCrc32(long) >>> 0);
});

test("flip only CRC trailer → ChecksumMismatch", () => {
	const data = utf8("crc-payload");
	const gz = compressFast(data);
	const corrupt = gz.slice();
	// CRC is bytes [len-8, len-4).
	const i = corrupt.length - 8;
	corrupt[i] = (corrupt[i] ?? 0) ^ 0xff;
	assert.throws(
		() => decompress(corrupt),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.ChecksumMismatch,
	);
});

test("flip only ISIZE → SizeMismatch", () => {
	const data = utf8("isize-payload");
	const gz = compressFast(data);
	const corrupt = gz.slice();
	// ISIZE is the last 4 bytes.
	const i = corrupt.length - 4;
	corrupt[i] = (corrupt[i] ?? 0) ^ 0xff;
	assert.throws(
		() => decompress(corrupt),
		(err: unknown) =>
			err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch,
	);
});

test("checksum:false + bad CRC still returns payload (if deflate valid)", () => {
	const data = utf8("skip-crc-still-payload");
	const gz = compressFast(data);
	const corrupt = gz.slice();
	const i = corrupt.length - 8;
	corrupt[i] = (corrupt[i] ?? 0) ^ 0xff;
	const out = decompress(corrupt, { checksum: false });
	assert.deepEqual(out, data);
});

test("checksum:false + bad ISIZE still returns payload", () => {
	const data = utf8("skip-isize-still-payload");
	const gz = compressFast(data);
	const corrupt = gz.slice();
	const i = corrupt.length - 1;
	corrupt[i] = (corrupt[i] ?? 0) ^ 0xff;
	const out = decompress(corrupt, { checksum: false });
	assert.deepEqual(out, data);
});

test("checksum:false + forged 64 MiB ISIZE does not pin a huge buffer", () => {
	const data = utf8("12345");
	const gz = compressFast(data);
	const forged = gz.slice();
	const isize = 64 << 20;
	forged[forged.length - 4] = isize & 255;
	forged[forged.length - 3] = (isize >>> 8) & 255;
	forged[forged.length - 2] = (isize >>> 16) & 255;
	forged[forged.length - 1] = (isize >>> 24) & 255;
	const result = decompress(forged, { checksum: false });
	assert.deepEqual(result, data);
	assert.ok(
		result.buffer.byteLength <= 2 * result.length + 64,
		`pinned ${result.buffer.byteLength} behind length ${result.length}`,
	);
});
