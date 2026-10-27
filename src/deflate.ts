/**
 * Raw DEFLATE compressor (no GZIP/ZLIB wrapper).
 *
 * Match-finder and block packing adapted from fflate (MIT).
 * Callers pass explicit (nice, chain, hashBits) — no numeric "level".
 */

import { shft, slc, wbits, wbits16 } from "./bitio.js";
import { clen, hTree, lc } from "./huffman.js";
import {
	clim,
	fdeb,
	fdm,
	fdt,
	fleb,
	flm,
	flt,
	hMap,
	revfd,
	revfl,
} from "./tables.js";

/** Matcher / memory policy for one encode pass. */
export type DeflateConfig = {
	/**
	 * "Nice" match length: stop searching once a match this long is found
	 * (capped at 258). Smaller = faster.
	 */
	nice: number;
	/** Max hash-chain probes per position. Smaller = faster. */
	chain: number;
	/**
	 * Primary hash table width in bits (`2^hashBits` slots).
	 * Typical 12–20; larger uses more memory and usually finds better matches.
	 */
	hashBits: number;
};

/** Hot-path read of a proven-in-range `Uint8Array` index. */
function at(a: Uint8Array, i: number): number {
	return a[i]!;
}

/** Hot-path read of a proven-in-range `Uint16Array` index. */
function at16(a: Uint16Array, i: number): number {
	return a[i]!;
}

/**
 * Write a stored (uncompressed) block.
 * Returns the new bit position.
 * Caller must ensure `dat.length <= 65535`.
 */
function writeStoredBlock(
	out: Uint8Array,
	pos: number,
	dat: Uint8Array,
	final: number,
): number {
	// BFINAL + BTYPE=00
	wbits(out, pos, final);
	const o = shft(pos + 3);
	const s = dat.length;
	out[o] = s & 255;
	out[o + 1] = s >> 8;
	out[o + 2] = at(out, o) ^ 255;
	out[o + 3] = at(out, o + 1) ^ 255;
	for (let i = 0; i < s; ++i) {
		out[o + i + 4] = at(dat, i);
	}
	return (o + 4 + s) * 8;
}

/**
 * Write one DEFLATE block (stored / fixed / dynamic — picks cheapest).
 * Returns the new bit position.
 */
function writeBlock(
	dat: Uint8Array,
	out: Uint8Array,
	final: number,
	syms: Int32Array,
	lf: Uint16Array,
	df: Uint16Array,
	eb: number,
	li: number,
	bs: number,
	bl: number,
	p: number,
): number {
	wbits(out, p++, final);
	lf[256] = at16(lf, 256) + 1;

	const { t: dlt, l: mlb } = hTree(lf, 15);
	const { t: ddt, l: mdb } = hTree(df, 15);
	const { c: lclt, n: nlc } = lc(dlt);
	const { c: lcdt, n: ndc } = lc(ddt);
	const lcfreq = new Uint16Array(19);
	for (let i = 0; i < lclt.length; ++i) {
		const sym = lclt[i]! & 31;
		lcfreq[sym] = at16(lcfreq, sym) + 1;
	}
	for (let i = 0; i < lcdt.length; ++i) {
		const sym = lcdt[i]! & 31;
		lcfreq[sym] = at16(lcfreq, sym) + 1;
	}
	const { t: lct, l: mlcb } = hTree(lcfreq, 7);
	let nlcc = 19;
	for (; nlcc > 4 && !at(lct, at(clim, nlcc - 1)); --nlcc);

	const flen = (bl + 5) << 3;
	const ftlen = clen(lf, flt) + clen(df, fdt) + eb;
	const dtlen =
		clen(lf, dlt) +
		clen(df, ddt) +
		eb +
		14 +
		3 * nlcc +
		clen(lcfreq, lct) +
		2 * at16(lcfreq, 16) +
		3 * at16(lcfreq, 17) +
		7 * at16(lcfreq, 18);

	// Stored blocks encode LEN as a 16-bit field — never emit one past 65535.
	if (bs >= 0 && bl <= 65535 && flen <= ftlen && flen <= dtlen) {
		return writeStoredBlock(out, p - 1, dat.subarray(bs, bs + bl), final);
	}

	let lm: Uint16Array;
	let ll: Uint8Array;
	let dm: Uint16Array;
	let dl: Uint8Array;
	// BTYPE: 1 = fixed, 2 = dynamic
	wbits(out, p, 1 + (dtlen < ftlen ? 1 : 0));
	p += 2;

	if (dtlen < ftlen) {
		lm = hMap(dlt, mlb, 0);
		ll = dlt;
		dm = hMap(ddt, mdb, 0);
		dl = ddt;
		const llm = hMap(lct, mlcb, 0);
		wbits(out, p, nlc - 257);
		wbits(out, p + 5, ndc - 1);
		wbits(out, p + 10, nlcc - 4);
		p += 14;
		for (let i = 0; i < nlcc; ++i) {
			wbits(out, p + 3 * i, at(lct, at(clim, i)));
		}
		p += 3 * nlcc;
		const lcts = [lclt, lcdt];
		for (let it = 0; it < 2; ++it) {
			const clct = lcts[it]!;
			for (let i = 0; i < clct.length; ++i) {
				const packed = clct[i]!;
				const len = packed & 31;
				wbits(out, p, at16(llm, len));
				p += at(lct, len);
				if (len > 15) {
					wbits(out, p, (packed >> 5) & 127);
					p += packed >> 12;
				}
			}
		}
	} else {
		lm = flm;
		ll = flt;
		dm = fdm;
		dl = fdt;
	}

	for (let i = 0; i < li; ++i) {
		const sym = syms[i]!;
		if (sym > 255) {
			const len = (sym >> 18) & 31;
			wbits16(out, p, at16(lm, len + 257));
			p += at(ll, len + 257);
			if (len > 7) {
				wbits(out, p, (sym >> 23) & 31);
				p += at(fleb, len);
			}
			const dst = sym & 31;
			wbits16(out, p, at16(dm, dst));
			p += at(dl, dst);
			if (dst > 3) {
				wbits16(out, p, (sym >> 5) & 8191);
				p += at(fdeb, dst);
			}
		} else {
			wbits16(out, p, at16(lm, sym));
			p += at(ll, sym);
		}
	}
	wbits16(out, p, at16(lm, 256));
	return p + at(ll, 256);
}

/** Persistent matcher tables for one-shot and streaming encode. */
export type DeflateState = {
	prev: Uint16Array;
	head: Uint16Array;
	msk: number;
	bs1: number;
	bs2: number;
	nice: number;
	chain: number;
};

/** Worst-case DEFLATE bytes for `n` uncompressed bytes plus a bit of slack. */
export function deflateBound(n: number): number {
	return n + 5 * (1 + Math.ceil(n / 7000)) + 16;
}

export function createDeflateState(cfg: DeflateConfig): DeflateState {
	const plvl = Math.max(8, Math.min(20, cfg.hashBits | 0));
	const bs1 = Math.ceil(plvl / 3);
	return {
		prev: new Uint16Array(32768),
		head: new Uint16Array(1 << plvl),
		msk: (1 << plvl) - 1,
		bs1,
		bs2: 2 * bs1,
		nice: Math.min(258, Math.max(3, cfg.nice)),
		chain: Math.max(1, cfg.chain),
	};
}

export function resetDeflateState(st: DeflateState): void {
	st.head.fill(0);
	st.prev.fill(0);
}

/** Insert 3-byte hashes for `dat[from..to)`. Uses lookahead past `to` when present. */
export function insertHashes(
	dat: Uint8Array,
	from: number,
	to: number,
	st: DeflateState,
): void {
	const lim = Math.min(to, dat.length - 2);
	const { prev, head, msk, bs1, bs2 } = st;
	for (let i = from; i < lim; ++i) {
		const hv = (dat[i]! ^ (dat[i + 1]! << bs1) ^ (dat[i + 2]! << bs2)) & msk;
		const imod = i & 32767;
		prev[imod] = head[hv]!;
		head[hv] = imod;
	}
}

/**
 * Compress `dat[start..end)` into `out` at bit position `p`.
 * Matches may look back into `dat[0..start)`. Caller inserts those hashes.
 * `final` is set only on the last DEFLATE block of the member.
 */
export function deflateRange(
	dat: Uint8Array,
	start: number,
	end: number,
	out: Uint8Array,
	p: number,
	final: number,
	st: DeflateState,
): number {
	const s = end;
	const { prev, head, msk, bs1, bs2, nice, chain } = st;
	const hsh = (i: number): number =>
		(dat[i]! ^ (dat[i + 1]! << bs1) ^ (dat[i + 2]! << bs2)) & msk;

	// Split fires when (litCount > 7000 || li > 24576) && rem > 423, checked
	// at each `wi <= i` iteration *before* the write. li can therefore reach
	// 24577 without splitting. The next symbol-writing iteration splits
	// unless rem <= 423; a 258-byte match can drop rem from 681 to 423 in
	// one step, after which the main-loop remainder plus the 2-byte tail
	// append at most 423 literals. Exact bound: 24576 + 1 + 423 = 25000.
	// Typed-array OOB writes are silent, so keep a modest margin.
	const syms = new Int32Array(25000 + 512);
	const lf = new Uint16Array(288);
	const df = new Uint16Array(32);
	let pos = p;
	let litCount = 0;
	let eb = 0;
	let i = start;
	let li = 0;
	let wi = start;
	let bs = start;

	for (; i + 2 < s; ++i) {
		const hv = hsh(i);
		const imod = i & 32767;
		const pimod0 = head[hv]!;
		prev[imod] = pimod0;
		head[hv] = imod;

		if (wi <= i) {
			const rem = s - i;
			if ((litCount > 7000 || li > 24576) && rem > 423) {
				pos = writeBlock(dat, out, 0, syms, lf, df, eb, li, bs, i - bs, pos);
				li = 0;
				litCount = 0;
				eb = 0;
				bs = i;
				lf.fill(0);
				df.fill(0);
			}

			let l = 2;
			let d = 0;
			let ch = chain;
			let im = imod;
			let pim = pimod0;
			let dif = (im - pim) & 32767;

			if (rem > 2 && hv === hsh(i - dif)) {
				const maxn = Math.min(nice, rem) - 1;
				// Never emits distance 32768 (legal; decoder ok; fflate; negligible ratio loss).
				const maxd = Math.min(32767, i);
				const ml = Math.min(258, rem);
				while (dif <= maxd && --ch && im !== pim) {
					// i+l may be == s when l === rem; undefined===undefined matches fflate.
					if (dat[i + l] === dat[i + l - dif]) {
						let nl = 0;
						const ml4 = ml - 3;
						for (; nl < ml4; nl += 4) {
							const wa =
								dat[i + nl]! |
								(dat[i + nl + 1]! << 8) |
								(dat[i + nl + 2]! << 16) |
								(dat[i + nl + 3]! << 24);
							const wb =
								dat[i + nl - dif]! |
								(dat[i + nl + 1 - dif]! << 8) |
								(dat[i + nl + 2 - dif]! << 16) |
								(dat[i + nl + 3 - dif]! << 24);
							if (wa !== wb) break;
						}
						for (; nl < ml && dat[i + nl] === dat[i + nl - dif]; ++nl);
						if (nl > l) {
							l = nl;
							d = dif;
							if (nl > maxn) break;
							// Search rarest 2-byte sequence in the match window.
							const mmd = Math.min(dif, nl - 2);
							let md = 0;
							for (let j = 0; j < mmd; ++j) {
								const ti = (i - dif + j) & 32767;
								const pti = prev[ti]!;
								const cd = (ti - pti) & 32767;
								if (cd > md) {
									md = cd;
									pim = ti;
								}
							}
						}
					}
					im = pim;
					pim = prev[im]!;
					dif += (im - pim) & 32767;
				}
			}

			if (d) {
				const revL = revfl[l]!;
				const revD = revfd[d]!;
				syms[li++] = 268435456 | (revL << 18) | revD;
				const lin = revL & 31;
				const din = revD & 31;
				eb += fleb[lin]! + fdeb[din]!;
				lf[257 + lin] = lf[257 + lin]! + 1;
				df[din] = df[din]! + 1;
				wi = i + l;
				++litCount;
			} else {
				const b = dat[i]!;
				syms[li++] = b;
				lf[b] = lf[b]! + 1;
			}
		}
	}

	for (i = Math.max(i, wi); i < s; ++i) {
		const b = dat[i]!;
		syms[li++] = b;
		lf[b] = lf[b]! + 1;
	}

	// Empty range + final: li=0, bl=0 — writeBlock still emits EOB.
	return writeBlock(dat, out, final, syms, lf, df, eb, li, bs, i - bs, pos);
}

const EMPTY = new Uint8Array(0);

/**
 * Append a Z_SYNC_FLUSH marker: empty stored block (BFINAL=0, BTYPE=00,
 * pad to a byte boundary, LEN=0, NLEN=0xFFFF). Returns the new bit position,
 * which is always byte-aligned.
 */
export function writeSyncFlush(out: Uint8Array, pos: number): number {
	return writeStoredBlock(out, pos, EMPTY, 0);
}

/**
 * Compress `dat` to raw DEFLATE.
 *
 * @param pre Bytes reserved at the front of the output (e.g. GZIP header).
 * @param post Bytes reserved at the end (e.g. GZIP CRC + ISIZE).
 */
export function deflateRaw(
	dat: Uint8Array,
	cfg: DeflateConfig,
	pre = 0,
	post = 0,
): Uint8Array {
	const s = dat.length;
	const o = new Uint8Array(pre + deflateBound(s) + post);
	const w = o.subarray(pre, o.length - post);
	const pos = deflateRange(dat, 0, s, w, 0, 1, createDeflateState(cfg));
	return slc(o, 0, pre + shft(pos) + post);
}
