/**
 * Raw DEFLATE inflater (no GZIP/ZLIB wrapper).
 *
 * Adapted from fflate (MIT, Arjun Barrett).
 */

import { maxU8, shft, slc } from "./bitio.js";
import { GzipErrorCode, gzipErr } from "./errors.js";
import {
	clim,
	fdeb,
	fd,
	fdrm,
	fleb,
	fl,
	flrm,
	HUFF_BAD,
	HUFF_FULL,
	hDecode,
	huffCheck,
	lutSize,
	ROOT_BITS,
	type SubState,
	subState,
} from "./tables.js";

/** Trailing slack so a 32-bit load at the last stream byte stays in range. */
export const INFLATE_PAD = 4;

/**
 * Cap on the first no-`buf` allocation. Must not scale with remaining
 * input (that made concatenated members allocate 3× leftover per member).
 * `cbuf` doubles from here; the ISIZE path passes an exact `buf`.
 */
const INIT_OUT = 1 << 17;

/** Reusable decode tables for dynamic blocks (~30 KB). */
export type InflateTables = {
	/** Code-length alphabet (7-bit max). */
	c: Uint16Array;
	/** Literal/length LUT (root + subtables). */
	l: Uint16Array;
	/** Distance LUT (root + subtables). */
	d: Uint16Array;
	s: SubState;
};

/** Fresh dynamic-block tables. */
export function inflateTables(): InflateTables {
	return {
		c: new Uint16Array(1 << 7),
		l: new Uint16Array(lutSize(286)),
		d: new Uint16Array(lutSize(30)),
		s: subState(),
	};
}

/** Inflate state for one-shot and streaming decode. */
export type InflateState = {
	/** Length Huffman decode map. Cleared between blocks when undefined. */
	l?: Uint16Array | undefined;
	/** Distance Huffman decode map. */
	d?: Uint16Array | undefined;
	/** Length max bits. */
	m?: number | undefined;
	/** Distance max bits. */
	n?: number | undefined;
	/** Final block flag. */
	f?: number | undefined;
	/** Bit position. */
	p?: number | undefined;
	/** Output byte count (write cursor in `buf`). */
	b?: number | undefined;
	/**
	 * `0` = more input may follow (no pad; OOB bits must not look like data);
	 * `1` = last chunk (pad, throw on over-read);
	 * `2` = one-shot strict (no grow, may use exact `out`).
	 */
	i: number;
	/**
	 * Throw {@link GzipErrorCode.OutputTooLarge} if the write cursor `b`
	 * would exceed this. Callers that slide a window set it to
	 * `st.b + remainingCap`, not the stream-total cap.
	 */
	max?: number | undefined;
	/** Bytes left in the current stored block (streaming resumes mid-block). */
	s?: number | undefined;
	/** Dynamic-block tables, created on first use and reused per block. */
	t?: InflateTables | undefined;
};

function badRepeat(): never {
	gzipErr(GzipErrorCode.InvalidLengthLiteral, "invalid bit length repeat");
}

/**
 * Expand raw DEFLATE data into `buf` (or a grown buffer).
 *
 * When `buf` is provided and `st.i === 2` (one-shot strict), the buffer is not
 * grown. Writing past `buf.length` throws {@link GzipErrorCode.SizeMismatch}.
 *
 * If `dat` is a view with at least {@link INFLATE_PAD} readable bytes past
 * `dat.length`, the inflater does not copy — construct the padded DataView as
 * `new DataView(dat.buffer, dat.byteOffset, dat.length + INFLATE_PAD)` so
 * `pos > tbts` keeps its meaning against `dat.length`.
 */
export function inflateRaw(
	dat: Uint8Array,
	st: InflateState,
	buf?: Uint8Array,
): Uint8Array {
	const sl = dat.length;
	if (st.f && !st.l && !st.s) return buf ?? new Uint8Array(0);
	if (!sl) {
		// Complete input with no DEFLATE data at all (zlib: unexpected end).
		if (st.i !== 0) gzipErr(GzipErrorCode.UnexpectedEOF);
		return buf ?? new Uint8Array(0);
	}
	const noBuf = buf === undefined;
	const resize = noBuf || st.i !== 2;
	const noSt = st.i;
	const maxOut = st.max;
	// i === 0: more input may follow. Do not pad — zeros would look like
	// more bitstream. i !== 0: input is complete (one-shot or final).
	const complete = st.i !== 0;
	// Bound the first allocation: never 3× all remaining input (that made
	// concatenated members quadratic). ISIZE prealloc covers honest one-shot.
	let init = Math.min(sl * 3, INIT_OUT);
	if (maxOut !== undefined && init > maxOut) init = maxOut < 0 ? 0 : maxOut;
	let out = buf ?? new Uint8Array(init);
	let outCap = out.length;
	if (maxOut !== undefined && outCap > maxOut) outCap = maxOut;

	let src: Uint8Array;
	let dv: DataView | undefined;
	if (complete) {
		if (dat.byteOffset + sl + INFLATE_PAD <= dat.buffer.byteLength) {
			src = dat;
			dv = new DataView(dat.buffer, dat.byteOffset, sl + INFLATE_PAD);
		} else {
			src = new Uint8Array(sl + INFLATE_PAD);
			src.set(dat);
			dv = new DataView(src.buffer);
		}
	} else {
		src = dat;
	}
	const word = (p: number): number => {
		const o = (p / 8) | 0;
		if (dv) return dv.getUint32(o, true) >>> (p & 7);
		return (src[o]! | (src[o + 1]! << 8) | (src[o + 2]! << 16)) >>> (p & 7);
	};
	const bits = (p: number, mask: number): number => word(p) & mask;
	const can = (n: number): boolean => complete || pos + n <= sl * 8;

	// Object, not a `let`: the flag is flipped inside the `cbuf` closure.
	const alloc = { on: false };
	const cbuf = (l: number): void => {
		if (maxOut !== undefined && l > maxOut) {
			gzipErr(GzipErrorCode.OutputTooLarge, "output exceeds maxSize");
		}
		if (l > outCap) {
			if (!resize) {
				gzipErr(GzipErrorCode.SizeMismatch, "output buffer too small");
			}
			let next = Math.max(outCap * 2, l);
			if (maxOut !== undefined && next > maxOut) next = maxOut;
			// A failed allocation is a RangeError too; keep it distinct from
			// the over-read RangeError that the catch below maps to EOF.
			alloc.on = true;
			const nbuf = new Uint8Array(next);
			alloc.on = false;
			nbuf.set(out);
			out = nbuf;
			outCap = nbuf.length;
			if (maxOut !== undefined && outCap > maxOut) outCap = maxOut;
		}
	};

	let final = st.f ?? 0;
	let pos = st.p ?? 0;
	let bt = st.b ?? 0;
	let lm = st.l;
	let dm = st.d;
	let lbt = st.m;
	let dbt = st.n;
	let stored = st.s ?? 0;
	const tbts = sl * 8;

	try {
		do {
			if (stored) {
				// Copy as much of the stored block as input allows; streaming
				// resumes here on the next chunk. (Inline, not a closure: a
				// closure writing `bt` would slow the symbol loop.)
				const at = pos / 8;
				let take = sl - at;
				if (take > stored) take = stored;
				if (take > 0) {
					cbuf(bt + take);
					out.set(src.subarray(at, at + take), bt);
					bt += take;
					pos += take * 8;
					stored -= take;
				}
				if (stored) {
					st.s = stored;
					st.p = pos;
					st.b = bt;
					break;
				}
				st.s = 0;
				st.p = pos;
				st.b = bt;
				continue;
			}
			if (!lm) {
				if (!can(17)) {
					st.p = pos;
					st.b = bt;
					st.f = final;
					break;
				}
				const blockStart = pos;
				final = bits(pos, 1);
				const type = bits(pos + 1, 3);
				pos += 3;
				if (!type) {
					const s = shft(pos) + 4;
					if (s > sl) {
						if (noSt) gzipErr(GzipErrorCode.UnexpectedEOF);
						pos = blockStart;
						st.p = pos;
						st.b = bt;
						break;
					}
					const l = src[s - 4]! | (src[s - 3]! << 8);
					if ((l ^ (src[s - 2]! | (src[s - 1]! << 8))) !== 0xffff) {
						gzipErr(
							GzipErrorCode.InvalidBlockType,
							"invalid stored block lengths",
						);
					}
					if (noSt && s + l > sl) gzipErr(GzipErrorCode.UnexpectedEOF);
					// Streaming copies what it has and resumes next call, so a
					// stored block fed byte by byte stays linear.
					stored = l;
					pos = s * 8;
					st.f = final;
					st.p = pos;
					st.b = bt;
					// The copy happens at the top of the loop (`while` below
					// keeps going while `stored` is non-zero).
					continue;
				} else if (type === 1) {
					lm = flrm;
					dm = fdrm;
					lbt = 9;
					dbt = 5;
				} else if (type === 2) {
					if (!can(14)) {
						pos = blockStart;
						st.p = pos;
						st.b = bt;
						break;
					}
					const hLit = bits(pos, 31) + 257;
					const hDist = bits(pos + 5, 31) + 1;
					const hcLen = bits(pos + 10, 15) + 4;
					const tl = hLit + hDist;
					// zlib: "too many length or distance symbols".
					if (hLit > 286 || hDist > 30) {
						gzipErr(
							GzipErrorCode.InvalidLengthLiteral,
							"too many length or distance symbols",
						);
					}
					pos += 14;
					const ldt = new Uint8Array(tl);
					const clt = new Uint8Array(19);
					if (!can(hcLen * 3)) {
						pos = blockStart;
						st.b = bt;
						st.p = pos;
						break;
					}
					for (let i = 0; i < hcLen; ++i) {
						clt[clim[i]!] = bits(pos + i * 3, 7);
					}
					pos += hcLen * 3;
					const clk = huffCheck(clt, true);
					if (clk === HUFF_BAD) {
						gzipErr(
							GzipErrorCode.InvalidLengthLiteral,
							"invalid code lengths set",
						);
					}
					const tabs = (st.t ??= inflateTables());
					const clb = maxU8(clt);
					const clbmsk = (1 << clb) - 1;
					const clm = hDecode(clt, clb, tabs.c, clk === HUFF_FULL, tabs.s);
					let wait = false;
					for (let i = 0; i < tl;) {
						if (!can(clb + 7)) {
							wait = true;
							break;
						}
						const r = clm[bits(pos, clbmsk)]!;
						pos += r & 15;
						const s = r >> 4;
						if (s < 16) {
							ldt[i++] = s;
						} else {
							let c = 0;
							let n = 0;
							if (s === 16) {
								if (i === 0) badRepeat();
								n = 3 + bits(pos, 3);
								pos += 2;
								c = ldt[i - 1]!;
							} else if (s === 17) {
								n = 3 + bits(pos, 7);
								pos += 3;
							} else if (s === 18) {
								n = 11 + bits(pos, 127);
								pos += 7;
							}
							if (i + n > tl) badRepeat();
							while (n--) ldt[i++] = c;
						}
					}
					if (wait) {
						pos = blockStart;
						st.p = pos;
						st.b = bt;
						break;
					}
					const lt = ldt.subarray(0, hLit);
					const dt = ldt.subarray(hLit);
					if (!lt[256]) {
						gzipErr(
							GzipErrorCode.InvalidLengthLiteral,
							"invalid code -- missing end-of-block",
						);
					}
					const lk = huffCheck(lt, false);
					if (lk === HUFF_BAD) {
						gzipErr(
							GzipErrorCode.InvalidLengthLiteral,
							"invalid literal/lengths set",
						);
					}
					const dk = huffCheck(dt, false);
					if (dk === HUFF_BAD) {
						gzipErr(GzipErrorCode.InvalidDistance, "invalid distances set");
					}
					lbt = maxU8(lt);
					dbt = maxU8(dt);
					lm = hDecode(lt, lbt, tabs.l, lk === HUFF_FULL, tabs.s);
					dm = hDecode(dt, dbt, tabs.d, dk === HUFF_FULL, tabs.s);
				} else {
					gzipErr(GzipErrorCode.InvalidBlockType);
				}
				if (pos > tbts) {
					if (noSt) gzipErr(GzipErrorCode.UnexpectedEOF);
					break;
				}
			}

			if (resize) {
				// Speculative grow — clamp to `max` so this is not a false
				// OutputTooLarge. Throw only when real output would exceed it.
				let want = bt + 131072;
				if (maxOut !== undefined && want > maxOut) want = maxOut;
				cbuf(want);
			}
			// Local copies so the symbol loop can clear `lm` without losing the maps.
			if (dm === undefined) gzipErr(GzipErrorCode.InvalidLengthLiteral);
			const lengthMap = lm;
			const distMap = dm;
			// Root LUT width; `lbt` / `dbt` stay the true max for input checks.
			const lms = (1 << Math.min(lbt ?? 9, ROOT_BITS)) - 1;
			const dms = (1 << Math.min(dbt ?? 5, ROOT_BITS)) - 1;
			let lpos = pos;

			// Streaming cannot pad, so it uses a 3-byte load; one-shot uses
			// padded getUint32.
			if (dv) {
				for (; ; lpos = pos) {
					let c =
						lengthMap[(dv.getUint32((pos / 8) | 0, true) >>> (pos & 7)) & lms]!;
					if (!(c & 15)) {
						// 0 = invalid code; otherwise a link to a subtable for a long code.
						if (c) {
							c =
								lengthMap[
									((c >> 4) << 5) |
										((dv.getUint32((pos / 8) | 0, true) >>>
											((pos & 7) + ROOT_BITS)) &
											31)
								]!;
						}
						if (!c) gzipErr(GzipErrorCode.InvalidLengthLiteral);
					}
					const sym = c >> 4;
					pos += c & 15;
					if (pos > tbts) {
						if (noSt) gzipErr(GzipErrorCode.UnexpectedEOF);
						break;
					}
					if (sym < 256) {
						if (bt >= outCap) cbuf(bt + 1);
						out[bt++] = sym;
					} else if (sym === 256) {
						lpos = pos;
						lm = undefined;
						break;
					} else {
						let add = sym - 254;
						if (sym > 264) {
							const i = sym - 257;
							const b = fleb[i]!;
							add =
								((dv.getUint32((pos / 8) | 0, true) >>> (pos & 7)) &
									((1 << b) - 1)) +
								fl[i]!;
							pos += b;
						}
						let d =
							distMap[(dv.getUint32((pos / 8) | 0, true) >>> (pos & 7)) & dms]!;
						if (!(d & 15)) {
							if (d) {
								d =
									distMap[
										((d >> 4) << 5) |
											((dv.getUint32((pos / 8) | 0, true) >>>
												((pos & 7) + ROOT_BITS)) &
												31)
									]!;
							}
							if (!d) gzipErr(GzipErrorCode.InvalidDistance);
						}
						const dsym = d >> 4;
						pos += d & 15;
						let dt = fd[dsym]!;
						if (dsym > 3) {
							const b = fdeb[dsym]!;
							dt +=
								(dv.getUint32((pos / 8) | 0, true) >>> (pos & 7)) &
								((1 << b) - 1);
							pos += b;
						}
						if (pos > tbts) {
							if (noSt) gzipErr(GzipErrorCode.UnexpectedEOF);
							break;
						}
						const end = bt + add;
						if (end > outCap) cbuf(end);
						if (bt < dt) gzipErr(GzipErrorCode.InvalidDistance);
						for (; bt < end; ++bt) out[bt] = out[bt - dt]!;
					}
				}
			} else {
				for (; ; lpos = pos) {
					if (pos + (lbt ?? 9) > tbts) break;
					let c = lengthMap[word(pos) & lms]!;
					if (!(c & 15)) {
						if (c)
							c =
								lengthMap[((c >> 4) << 5) | ((word(pos) >>> ROOT_BITS) & 31)]!;
						if (!c) gzipErr(GzipErrorCode.InvalidLengthLiteral);
					}
					const sym = c >> 4;
					pos += c & 15;
					if (pos > tbts) break;
					if (sym < 256) {
						if (bt >= outCap) cbuf(bt + 1);
						out[bt++] = sym;
					} else if (sym === 256) {
						lpos = pos;
						lm = undefined;
						break;
					} else {
						let add = sym - 254;
						if (sym > 264) {
							const i = sym - 257;
							const b = fleb[i]!;
							if (!can(b + (dbt ?? 5) + 13)) {
								pos = lpos;
								break;
							}
							add = (word(pos) & ((1 << b) - 1)) + fl[i]!;
							pos += b;
						} else if (!can((dbt ?? 5) + 13)) {
							pos = lpos;
							break;
						}
						let d = distMap[word(pos) & dms]!;
						if (!(d & 15)) {
							if (d)
								d =
									distMap[((d >> 4) << 5) | ((word(pos) >>> ROOT_BITS) & 31)]!;
							if (!d) gzipErr(GzipErrorCode.InvalidDistance);
						}
						const dsym = d >> 4;
						pos += d & 15;
						let dt = fd[dsym]!;
						if (dsym > 3) {
							const b = fdeb[dsym]!;
							dt += word(pos) & ((1 << b) - 1);
							pos += b;
						}
						if (pos > tbts) break;
						const end = bt + add;
						if (end > outCap) cbuf(end);
						if (bt < dt) gzipErr(GzipErrorCode.InvalidDistance);
						for (; bt < end; ++bt) out[bt] = out[bt - dt]!;
					}
				}
			}
			st.l = lm;
			st.p = lpos;
			st.b = bt;
			st.f = final;
			if (lm) {
				final = 1;
				st.m = lbt;
				st.d = dm;
				st.n = dbt;
			}
		} while (!final || stored);
	} catch (e) {
		// Wide loads past the pad only happen on corrupt input. A failed
		// output allocation is rethrown as-is.
		if (e instanceof RangeError && !alloc.on) {
			gzipErr(GzipErrorCode.UnexpectedEOF);
		}
		throw e;
	}

	if (noBuf) {
		return bt !== out.length ? slc(out, 0, bt) : out;
	}
	// Streaming reuses the allocation as match history — never trim it.
	if (st.i !== 2) return out;
	// One-shot caller `out`: same identity when exact, else a view.
	return bt === out.length ? out : out.subarray(0, bt);
}
