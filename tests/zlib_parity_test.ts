/**
 * DEFLATE parser parity with node:zlib (zlib's inflate): stored-block NLEN,
 * Huffman code-set completeness (inflate_table), repeat codes, symbol
 * counts, and reserved fixed-code symbols. Each crafted stream must get the
 * same verdict — and, when accepted, the same bytes — from wgzip and zlib.
 * A seeded mutation sweep then checks that no wgzip-accepts / zlib-rejects
 * case remains.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import {
	constants,
	deflateRawSync,
	gunzipSync,
	inflateRawSync,
	crc32 as nodeCrc32,
} from "node:zlib";
import {
	compressFast,
	compressStrong,
	Decompress,
	decompress,
	GzipError,
} from "../dist/index.js";
import {
	Bits,
	CL_ALL,
	CL_PLAIN,
	canonical,
	dynBlock,
	dynHeader,
	gzipWrap,
	plainSeq,
	storedBlock,
} from "./helpers/craft.ts";

register(
	new URL("./helpers/resolve_ts_js.mjs", import.meta.url),
	import.meta.url,
);

const { inflateRaw } = await import("../src/inflate.ts");

type Verdict = { ok: true; out: Uint8Array; used: number } | { ok: false };

function zlibRaw(raw: Uint8Array): Verdict {
	try {
		// `{ info: true }` returns { buffer, engine }; @types/node only types
		// the Buffer overload.
		const infoSync =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
			inflateRawSync as unknown as (
				b: Uint8Array,
				o: { info: true },
			) => { buffer: Uint8Array; engine: { bytesWritten: number } };
		const r = infoSync(raw, { info: true });
		return {
			ok: true,
			out: new Uint8Array(r.buffer),
			used: r.engine.bytesWritten,
		};
	} catch {
		return { ok: false };
	}
}

function wgzipRaw(raw: Uint8Array): Verdict {
	const st: { i: number; p?: number } = { i: 1 };
	try {
		const out = inflateRaw(raw, st);
		return { ok: true, out, used: Math.ceil((st.p ?? 0) / 8) };
	} catch (err) {
		if (!(err instanceof Error && err.name === "GzipError")) throw err;
		return { ok: false };
	}
}

function pushBytewise(gz: Uint8Array, checksum: boolean): Verdict {
	const parts: Array<number> = [];
	const dec = new Decompress(
		(c) => {
			for (const b of c) parts.push(b);
		},
		{ checksum },
	);
	try {
		for (let i = 0; i < gz.length; i++) dec.push(gz.subarray(i, i + 1));
		dec.push(new Uint8Array(0), true);
		return { ok: true, out: new Uint8Array(parts), used: gz.length };
	} catch (err) {
		if (!(err instanceof GzipError)) throw err;
		return { ok: false };
	}
}

/** Same verdict and bytes from zlib and every wgzip decode path. */
function assertParity(name: string, raw: Uint8Array, expectOk: boolean): void {
	const z = zlibRaw(raw);
	assert.equal(z.ok, expectOk, `${name}: zlib verdict`);
	const w = wgzipRaw(raw);
	assert.equal(w.ok, z.ok, `${name}: raw inflate vs zlib`);
	if (z.ok && w.ok) {
		assert.deepEqual(w.out, z.out, `${name}: bytes`);
		assert.equal(w.used, z.used, `${name}: bytes consumed`);
	}
	// GZIP-wrapped: checksum off so a reject can only be structural.
	const gz = gzipWrap(raw, z.ok ? z.out : new Uint8Array(0));
	const one = ((): boolean => {
		try {
			decompress(gz, { checksum: false });
			return true;
		} catch (err) {
			if (!(err instanceof GzipError)) throw err;
			return false;
		}
	})();
	assert.equal(one, z.ok, `${name}: one-shot vs zlib`);
	assert.equal(pushBytewise(gz, false).ok, z.ok, `${name}: push vs zlib`);
	if (z.ok) {
		assert.deepEqual(new Uint8Array(gunzipSync(gz)), z.out);
		assert.deepEqual(decompress(gz), z.out, `${name}: verified one-shot`);
	}
}

const zeros = (n: number): Array<number> =>
	Array.from<number>({ length: n }).fill(0);

/** Literal lengths: `set` maps symbol → length, 257 symbols total. */
function lit(set: Record<number, number>, n = 257): Array<number> {
	const l = zeros(n);
	for (const [k, v] of Object.entries(set)) l[Number(k)] = v;
	return l;
}

test("stored block: NLEN must be ~LEN", () => {
	const data = new TextEncoder().encode("stored");
	const good = new Bits();
	storedBlock(good, true, data);
	assertParity("stored ok", good.done(), true);
	const bad = new Bits();
	storedBlock(bad, true, data, 0x1234);
	assertParity("stored bad NLEN", bad.done(), false);
	const gz = gzipWrap(bad.done(), data);
	assert.throws(
		() => decompress(gz),
		(e: unknown) =>
			e instanceof GzipError && e.message === "invalid stored block lengths",
	);
});

/** Complete literal code: 0..11 at 1..12 bits, 257 at 13, 256 at 14, A/B at 15. */
function longLit(extra = 0): Array<number> {
	const l = zeros(258);
	for (let i = 0; i < 12; i++) l[i] = i + 1;
	l[257] = 13;
	l[256] = 14;
	l[65] = 15;
	l[66] = 15;
	if (extra) l[67] = 15;
	return l;
}

/** Complete distance code: 0/1 at 15 bits, 2..15 at 14..1. */
function longDist(): Array<number> {
	const d = zeros(16);
	d[0] = 15;
	d[1] = 15;
	for (let i = 2; i < 16; i++) d[i] = 16 - i;
	return d;
}

test("Huffman sets: over-subscribed and incomplete rejected, lone 1-bit code allowed", () => {
	const A = 65;
	const cases: Array<
		[string, Array<number>, Array<number>, Array<number>, boolean]
	> = [
		// name, lit lengths, dist lengths, symbols, zlib accepts?
		["complete", lit({ [A]: 1, 256: 1 }), [0], [A, A, 256], true],
		["lit over-subscribed", lit({ [A]: 1, 66: 1, 256: 1 }), [0], [256], false],
		["lit incomplete", lit({ [A]: 2, 256: 2 }), [0], [A, 256], false],
		["lone EOB, 1 bit", lit({ 256: 1 }), [0], [256], true],
		["lone EOB, 2 bits", lit({ 256: 2 }), [0], [256], false],
		["missing end-of-block", lit({ [A]: 1, 66: 1 }), [0], [A], false],
		// 257 = length 3; distance symbol 0 = distance 1 → "AAAA".
		[
			"lone 1-bit distance",
			lit({ [A]: 1, 256: 2, 257: 2 }, 258),
			[1],
			[A, 257, -1, 256],
			true,
		],
		[
			"dist incomplete (2 of 4)",
			lit({ [A]: 1, 256: 2, 257: 2 }, 258),
			[2, 2],
			[A, 257, -1, 256],
			false,
		],
		[
			"dist over-subscribed",
			lit({ [A]: 1, 256: 2, 257: 2 }, 258),
			[1, 1, 1],
			[A, 257, -1, 256],
			false,
		],
		["no distance codes", lit({ [A]: 1, 256: 1 }), [0], [A, 256], true],
		// 13..15-bit codes exercise the decoder's root-LUT subtables.
		[
			"15-bit codes",
			longLit(),
			longDist(),
			[A, 66, 257, -1, 257, -2, 256],
			true,
		],
		["15-bit codes, over-subscribed", longLit(1), longDist(), [256], false],
	];
	for (const [name, l, d, syms, ok] of cases) {
		const w = new Bits();
		dynBlock(w, true, l, d, syms);
		assertParity(name, w.done(), ok);
	}
});

test("code-length code: incomplete rejected, repeats bounded", () => {
	const l = lit({ 65: 1, 256: 1 });
	const build = (
		cl: Array<number>,
		seq: Array<[number] | [number, number]>,
		hlit = 257,
		hdist = 1,
	): Uint8Array => {
		const w = new Bits();
		dynHeader(w, true, hlit, hdist, cl, seq);
		const codes = canonical(l);
		w.code(codes[256] ?? 0, 1);
		return w.done();
	};
	const plain = [...plainSeq(l), [0] as [number]];
	assertParity("plain", build(CL_PLAIN, plain), true);
	// Only symbols 0 and 1 at 2 bits: half the code space unused.
	const incomplete = zeros(19);
	incomplete[0] = 2;
	incomplete[1] = 2;
	assertParity("incomplete code-length code", build(incomplete, plain), false);
	// A lone 1-bit code is fine for lit/dist but never for code lengths.
	const lone = zeros(19);
	lone[0] = 1;
	assertParity("lone 1-bit code-length code", build(lone, plain), false);
	// Repeat-previous (16) with nothing before it.
	assertParity("16 first", build(CL_ALL, [[16, 0], ...plain]), false);
	// 18 x 138 zeros overruns hlit + hdist.
	const overrun: Array<[number] | [number, number]> = [
		...plainSeq(l.slice(0, 200)),
		[18, 127],
	];
	assertParity("repeat past end", build(CL_ALL, overrun), false);
	// A repeat may run across the lit/dist boundary (zlib allows it):
	// HLIT 258 + HDIST 2, then 17 x 3 zeros covers lit[257], dist[0], dist[1].
	assertParity(
		"zero repeat into dist",
		build(CL_ALL, [...plainSeq(l), [17, 0]], 258, 2),
		true,
	);
	// HLIT 287 / HDIST 31 exceed RFC 1951's 286 / 30.
	assertParity(
		"hlit 287",
		build(CL_PLAIN, [...plainSeq(lit({ 65: 1, 256: 1 }, 287)), [0]], 287),
		false,
	);
	const w = new Bits();
	dynHeader(w, true, 257, 31, CL_PLAIN, [
		...plainSeq(l),
		...plainSeq(zeros(31)),
	]);
	w.code(canonical(l)[256] ?? 0, 1);
	assertParity("hdist 31", w.done(), false);
});

test("fixed Huffman: symbols 286/287 and distances 30/31 rejected", () => {
	// Fixed literal 'A' = 0x30 + 65 (8 bits); 286 = 0xC0 + 6 (8 bits);
	// length 257 = 7-bit 0000001; distances are 5-bit codes.
	const lit286 = new Bits()
		.put(1, 1)
		.put(1, 2)
		.code(0x30 + 65, 8)
		.code(0xc6, 8);
	assertParity("literal/length 286", lit286.done(), false);
	const lit287 = new Bits()
		.put(1, 1)
		.put(1, 2)
		.code(0x30 + 65, 8)
		.code(0xc7, 8);
	assertParity("literal/length 287", lit287.done(), false);
	for (const dcode of [30, 31]) {
		const w = new Bits()
			.put(1, 1)
			.put(1, 2)
			.code(0x30 + 65, 8)
			.code(1, 7)
			.code(dcode, 5);
		w.code(0, 7); // EOB
		assertParity(`distance ${dcode}`, w.done(), false);
	}
	const ok = new Bits()
		.put(1, 1)
		.put(1, 2)
		.code(0x30 + 65, 8)
		.code(1, 7)
		.code(0, 5)
		.code(0, 7);
	assertParity("fixed control", ok.done(), true);
});

/** mulberry32 */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function corpus(): Array<Uint8Array> {
	const text = new TextEncoder().encode(
		"The quick brown fox jumps over the lazy dog. 0123456789 ".repeat(20),
	);
	const r = rng(7);
	const noise = new Uint8Array(600).map(() => (r() * 256) | 0);
	const skew = new Uint8Array(3000).map(() =>
		r() < 0.97 ? 97 : (r() * 256) | 0,
	);
	const out: Array<Uint8Array> = [];
	for (const src of [text, noise, skew, new Uint8Array(0)]) {
		for (const opts of [
			{ level: 0 },
			{ level: 1 },
			{ level: 9 },
			{ strategy: constants.Z_FIXED },
			{ strategy: constants.Z_HUFFMAN_ONLY },
		]) {
			out.push(new Uint8Array(deflateRawSync(src, opts)));
		}
		out.push(compressFast(src).subarray(10, -8));
		out.push(compressStrong(src).subarray(10, -8));
	}
	const w = new Bits();
	dynBlock(
		w,
		true,
		lit({ 65: 1, 256: 2, 257: 2 }, 258),
		[1],
		[65, 257, -1, 256],
	);
	out.push(w.done());
	return out;
}

function mutate(base: Uint8Array, r: () => number): Uint8Array {
	const m = base.slice();
	const kind = r();
	if (m.length === 0) return m;
	if (kind < 0.6) {
		const flips = 1 + ((r() * 3) | 0);
		for (let i = 0; i < flips; i++) {
			const bit = (r() * m.length * 8) | 0;
			m[bit >> 3] = (m[bit >> 3] ?? 0) ^ (1 << (bit & 7));
		}
		return m;
	}
	if (kind < 0.85) {
		m[(r() * m.length) | 0] = (r() * 256) | 0;
		return m;
	}
	return m.subarray(0, (r() * m.length) | 0);
}

test("mutation sweep: wgzip and zlib agree on 4000 corrupted streams", () => {
	const bases = corpus();
	const r = rng(0x5eed);
	let accepted = 0;
	for (let i = 0; i < 4000; i++) {
		const base = bases[i % bases.length] ?? new Uint8Array(0);
		const raw = mutate(base, r);
		const z = zlibRaw(raw);
		const w = wgzipRaw(raw);
		const tag = `#${i} base ${i % bases.length}: ${Buffer.from(raw).toString("hex")}`;
		assert.equal(w.ok, z.ok, `verdict ${tag}`);
		if (z.ok && w.ok) {
			accepted++;
			assert.deepEqual(w.out, z.out, `bytes ${tag}`);
			assert.equal(w.used, z.used, `consumed ${tag}`);
		}
	}
	// The sweep must exercise both outcomes to mean anything.
	assert.ok(accepted > 200 && accepted < 3800, `accepted ${accepted}`);
});

test("header mutation sweep: one-shot and push agree with gunzip", () => {
	const plain = new TextEncoder().encode("header sweep payload");
	const body = compressFast(plain).subarray(10);
	const hdr = [31, 139, 8, 2 | 4 | 8 | 16, 0, 0, 0, 0, 0, 3, 3, 0, 1, 2, 3];
	for (const c of "n.txt\0c\0") hdr.push(c.charCodeAt(0));
	const crc = nodeCrc32(new Uint8Array(hdr)) & 0xffff;
	hdr.push(crc & 255, crc >> 8);
	const gz = new Uint8Array([...hdr, ...body]);
	assert.deepEqual(new Uint8Array(gunzipSync(gz)), plain);
	const r = rng(99);
	for (let i = 0; i < 1500; i++) {
		const m = gz.slice();
		const bit = (r() * hdr.length * 8) | 0;
		m[bit >> 3] = (m[bit >> 3] ?? 0) ^ (1 << (bit & 7));
		let nodeOk = true;
		try {
			gunzipSync(m);
		} catch {
			nodeOk = false;
		}
		let oneOk = true;
		try {
			decompress(m);
		} catch (err) {
			if (!(err instanceof GzipError)) throw err;
			oneOk = false;
		}
		const tag = `bit ${bit}`;
		assert.equal(oneOk, nodeOk, `one-shot ${tag}`);
		assert.equal(pushBytewise(m, true).ok, nodeOk, `push ${tag}`);
	}
});
