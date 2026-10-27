/**
 * Unit tests for DEFLATE Huffman code-length construction (`hTree`).
 *
 * Imports source (not dist) on purpose — hTree is internal. A small resolve
 * hook maps the library's `.js` import paths to sibling `.ts` files.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { compressStrong, decompress } from "../dist/index.js";

register(
	new URL("./helpers/resolve_ts_js.mjs", import.meta.url),
	pathToFileURL("./"),
);

const { hTree } = await import("../src/huffman.ts");

/** xorshift32 so histograms are deterministic across runs. */
function makeRandom(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>>= 0);
	};
}

function assertValidTree(
	freq: Uint16Array,
	maxBits: number,
	t: Uint8Array,
	l: number,
): void {
	assert.ok(l <= maxBits, `max depth ${l} exceeds cap ${maxBits}`);
	for (let i = 0; i < freq.length; i++) {
		const f = freq[i] ?? 0;
		const d = t[i] ?? 0;
		if (f === 0) {
			assert.equal(d, 0, `zero-freq symbol ${i} has length ${d}`);
		} else {
			assert.ok(d >= 1 && d <= maxBits, `symbol ${i} depth ${d}`);
			if (d > l) assert.fail(`symbol ${i} depth ${d} > reported max ${l}`);
		}
	}
	// Symbols beyond the returned array are absent (caller only had lower indices).
	for (let i = t.length; i < freq.length; i++) {
		assert.equal(freq[i] ?? 0, 0);
	}
}

test("empty frequency table", () => {
	const { t, l } = hTree(new Uint16Array(10), 15);
	assert.equal(l, 0);
	assert.equal(t.length, 0);
});

test("single symbol gets length 1", () => {
	const freq = new Uint16Array(20);
	freq[7] = 42;
	const { t, l } = hTree(freq, 15);
	assert.equal(l, 1);
	assert.equal(t[7], 1);
	for (let i = 0; i < t.length; i++) {
		if (i !== 7) assert.equal(t[i] ?? 0, 0);
	}
});

test("equal frequencies are deterministic", () => {
	const freq = new Uint16Array(16);
	for (let i = 0; i < 16; i++) freq[i] = 3;
	const a = hTree(freq, 15);
	const b = hTree(freq, 15);
	assert.equal(a.l, b.l);
	assert.deepEqual(a.t, b.t);
	assertValidTree(freq, 15, a.t, a.l);
});

test("random histograms: maxBits 15", () => {
	const rnd = makeRandom(0xc0ffee);
	for (let trial = 0; trial < 40; trial++) {
		const n = 2 + (rnd() % 280);
		const freq = new Uint16Array(n);
		for (let i = 0; i < n; i++) {
			// Mix zeros, small, and large counts; occasionally a heavy skew.
			const r = rnd() % 100;
			if (r < 20) freq[i] = 0;
			else if (r < 90) freq[i] = 1 + (rnd() % 50);
			else freq[i] = 1000 + (rnd() % 20000);
		}
		// Ensure at least two present symbols so the tree path runs.
		if ((freq[0] ?? 0) === 0) freq[0] = 1;
		if (n > 1 && (freq[1] ?? 0) === 0) freq[1] = 1;
		const { t, l } = hTree(freq, 15);
		assertValidTree(freq, 15, t, l);
	}
});

test("random histograms: maxBits 7 (code-length alphabet size)", () => {
	const rnd = makeRandom(0xbadc0de);
	for (let trial = 0; trial < 40; trial++) {
		const n = 2 + (rnd() % 18); // DEFLATE code-length alphabet is 19
		const freq = new Uint16Array(n);
		for (let i = 0; i < n; i++) {
			const r = rnd() % 100;
			if (r < 15) freq[i] = 0;
			else if (r < 85) freq[i] = 1 + (rnd() % 30);
			else freq[i] = 500 + (rnd() % 5000);
		}
		if ((freq[0] ?? 0) === 0) freq[0] = 1;
		if (n > 1 && (freq[1] ?? 0) === 0) freq[1] = 1;
		const { t, l } = hTree(freq, 7);
		assertValidTree(freq, 7, t, l);
	}
});

test("extreme skew still respects maxBits", () => {
	const freq = new Uint16Array(64);
	freq[0] = 60000;
	for (let i = 1; i < 64; i++) freq[i] = 1;
	for (const maxBits of [7, 15] as const) {
		const { t, l } = hTree(freq, maxBits);
		assertValidTree(freq, maxBits, t, l);
	}
});

test("round-trip still works after huffman rewrite", () => {
	const payloads = [
		new TextEncoder().encode("hello huffman"),
		new TextEncoder().encode("abc".repeat(500)),
		Uint8Array.from({ length: 1024 }, (_, i) => (i * 13 + 7) & 255),
	];
	for (const data of payloads) {
		const gz = compressStrong(data);
		assert.deepEqual(decompress(gz), data);
	}
});
