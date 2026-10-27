/**
 * Hand-built DEFLATE / GZIP streams for parser tests. Lets a test say exactly
 * which code lengths, repeat codes, or stored lengths a block carries —
 * things no real encoder emits.
 */
import { crc32 as nodeCrc32 } from "node:zlib";

/** LSB-first bit writer (RFC 1951 §3.1.1). */
export class Bits {
	private readonly out: Array<number> = [];
	private acc = 0;
	private n = 0;

	/** Write `len` bits of `v`, least-significant first. */
	put(v: number, len: number): this {
		for (let i = 0; i < len; i++) {
			this.acc |= ((v >>> i) & 1) << this.n;
			if (++this.n === 8) {
				this.out.push(this.acc);
				this.acc = 0;
				this.n = 0;
			}
		}
		return this;
	}

	/** Write a Huffman code (packed most-significant bit first). */
	code(c: number, len: number): this {
		for (let i = len - 1; i >= 0; i--) this.put((c >>> i) & 1, 1);
		return this;
	}

	/** Pad to a byte boundary with zero bits. */
	align(): this {
		if (this.n) this.put(0, 8 - this.n);
		return this;
	}

	bytes(b: ArrayLike<number>): this {
		this.align();
		for (let i = 0; i < b.length; i++) this.out.push(b[i] ?? 0);
		return this;
	}

	done(): Uint8Array {
		this.align();
		return new Uint8Array(this.out);
	}
}

/** Canonical Huffman codes for `lens` (RFC 1951 §3.2.2). 0 = unused. */
export function canonical(lens: ArrayLike<number>): Array<number> {
	const count = Array.from<number>({ length: 16 }).fill(0);
	for (let i = 0; i < lens.length; i++) {
		const l = lens[i] ?? 0;
		count[l] = (count[l] ?? 0) + 1;
	}
	count[0] = 0;
	const next = Array.from<number>({ length: 16 }).fill(0);
	let code = 0;
	for (let b = 1; b < 16; b++) {
		code = (code + (count[b - 1] ?? 0)) << 1;
		next[b] = code;
	}
	const codes = Array.from<number>({ length: lens.length }).fill(0);
	for (let i = 0; i < lens.length; i++) {
		const l = lens[i] ?? 0;
		if (l) {
			codes[i] = next[l] ?? 0;
			next[l] = (next[l] ?? 0) + 1;
		}
	}
	return codes;
}

/** Code-length alphabet order (RFC 1951 §3.2.7). */
const CLIM = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** One code-length symbol: `[sym]`, or `[16|17|18, extraValue]`. */
export type ClSym = [number] | [number, number];

/** Code-length symbols that spell `lens` literally (no repeat codes). */
export function plainSeq(lens: ArrayLike<number>): Array<ClSym> {
	const seq: Array<ClSym> = [];
	for (let i = 0; i < lens.length; i++) seq.push([lens[i] ?? 0]);
	return seq;
}

/** Default code-length code: symbols 0..15 at 4 bits (complete), no repeats. */
export const CL_PLAIN: Array<number> = (() => {
	const cl = Array.from<number>({ length: 19 }).fill(0);
	for (let i = 0; i < 16; i++) cl[i] = 4;
	return cl;
})();

/** Code-length code with every symbol: 0..12 at 4 bits, 13..18 at 5 (complete). */
export const CL_ALL: Array<number> = (() => {
	const cl = Array.from<number>({ length: 19 }).fill(0);
	for (let i = 0; i < 19; i++) cl[i] = i < 13 ? 4 : 5;
	return cl;
})();

const CL_EXTRA: Record<number, number> = { 16: 2, 17: 3, 18: 7 };

/**
 * Dynamic block header (BTYPE=10). `hlit` / `hdist` are the symbol counts as
 * stored (257..288 / 1..32 — out-of-range values are allowed on purpose).
 */
export function dynHeader(
	w: Bits,
	final: boolean,
	hlit: number,
	hdist: number,
	clLens: ArrayLike<number>,
	seq: Array<ClSym>,
): void {
	w.put(final ? 1 : 0, 1).put(2, 2);
	w.put(hlit - 257, 5)
		.put(hdist - 1, 5)
		.put(19 - 4, 4);
	for (const sym of CLIM) w.put(clLens[sym] ?? 0, 3);
	const codes = canonical(clLens);
	for (const [sym, extra] of seq) {
		w.code(codes[sym] ?? 0, clLens[sym] ?? 0);
		if (sym >= 16) w.put(extra ?? 0, CL_EXTRA[sym] ?? 0);
	}
}

/**
 * A whole dynamic block: header for `lit` / `dist` lengths, then `syms`:
 * literal/length symbols (callers include 256, end-of-block), with a
 * distance symbol `d` written as `-(d + 1)`. No extra bits are written, so
 * use length/distance symbols that have none.
 */
export function dynBlock(
	w: Bits,
	final: boolean,
	lit: Array<number>,
	dist: Array<number>,
	syms: Array<number>,
): void {
	dynHeader(w, final, lit.length, dist.length, CL_PLAIN, [
		...plainSeq(lit),
		...plainSeq(dist),
	]);
	const codes = canonical(lit);
	const dcodes = canonical(dist);
	for (const s of syms) {
		if (s < 0) w.code(dcodes[-s - 1] ?? 0, dist[-s - 1] ?? 0);
		else w.code(codes[s] ?? 0, lit[s] ?? 0);
	}
}

/** Stored block with explicit LEN / NLEN. */
export function storedBlock(
	w: Bits,
	final: boolean,
	data: Uint8Array,
	nlen = ~data.length & 0xffff,
): void {
	w.put(final ? 1 : 0, 1)
		.put(0, 2)
		.align();
	w.bytes([data.length & 255, data.length >> 8, nlen & 255, nlen >> 8]);
	w.bytes(data);
}

/** Minimal 10-byte header + raw DEFLATE + CRC32/ISIZE trailer for `plain`. */
export function gzipWrap(raw: Uint8Array, plain: Uint8Array): Uint8Array {
	const out = new Uint8Array(10 + raw.length + 8);
	out.set([31, 139, 8, 0, 0, 0, 0, 0, 0, 3]);
	out.set(raw, 10);
	const dv = new DataView(out.buffer);
	dv.setUint32(10 + raw.length, nodeCrc32(plain) >>> 0, true);
	dv.setUint32(14 + raw.length, plain.length >>> 0, true);
	return out;
}
