import assert from "node:assert/strict";
import { test } from "node:test";
import { compressFast, CompressFast } from "../dist/compressFast.js";
import { compressStrong, CompressStrong } from "../dist/compressStrong.js";
import { decompress } from "../dist/decompress.js";
import {
	compressFast as fastFromIndex,
	compressFastStream,
	compressStrongStream,
	decompress as decFromIndex,
} from "../dist/index.js";

test("subpath compressFast matches index", () => {
	const data = new TextEncoder().encode("subpath");
	const a = compressFast(data);
	const b = fastFromIndex(data);
	// Deterministic encode: same input → same bytes
	assert.deepEqual(a, b);
	assert.deepEqual(decompress(a), data);
	assert.deepEqual(decFromIndex(a), data);
});

test("subpath compressStrong works", () => {
	const data = new TextEncoder().encode("strong-subpath");
	const gz = compressStrong(data);
	assert.deepEqual(decompress(gz), data);
});

test("gzip magic and xfl for Fast/Strong", () => {
	const data = new TextEncoder().encode("xfl");
	const fast = compressFast(data);
	const strong = compressStrong(data);
	assert.equal(fast[8], 4, "Fast XFL=fastest");
	assert.equal(strong[8], 2, "Strong XFL=max");
});

test("streaming compress exports live on the tier entries", () => {
	assert.equal(typeof CompressFast, "function");
	assert.equal(typeof CompressStrong, "function");
	assert.equal(typeof compressFastStream, "function");
	assert.equal(typeof compressStrongStream, "function");
});

test("tier entries do not export WithConfig / _CONFIG internals", async () => {
	const fast = await import("../dist/compressFast.js");
	const strong = await import("../dist/compressStrong.js");
	for (const [label, mod] of [
		["compressFast", fast],
		["compressStrong", strong],
	] as const) {
		for (const name of Object.keys(mod)) {
			assert.ok(
				!name.includes("WithConfig") && !name.includes("_CONFIG"),
				`${label} exports ${name}`,
			);
		}
	}
});
