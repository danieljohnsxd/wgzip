/**
 * DEFLATE fixed tables and reverse-bit maps (RFC 1951).
 *
 * Algorithm adapted from fflate (MIT, Arjun Barrett), itself related to UZIP.js.
 */

/** Fixed length extra bits (codes 257–285). */
export const fleb = new Uint8Array([
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
	5, 5, 0, 0, 0, 0,
]);

/** Fixed distance extra bits (codes 0–29). */
export const fdeb = new Uint8Array([
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
	11, 12, 12, 13, 13, 0, 0,
]);

/** Code-length alphabet order (RFC 1951 §3.2.7). */
export const clim = new Uint8Array([
	16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

/** Build base lengths and reverse (value → packed index|extra) maps. */
function freb(
	eb: Uint8Array,
	start: number,
): { b: Uint16Array; r: Int32Array } {
	const b = new Uint16Array(31);
	let base = start;
	for (let i = 0; i < 31; ++i) {
		const prev = i === 0 ? 0 : (eb[i - 1] ?? 0);
		base += 1 << prev;
		b[i] = base;
	}
	// Numbers are at most 18 bits.
	const r = new Int32Array(b[30] ?? 0);
	for (let i = 1; i < 30; ++i) {
		const bi = b[i] ?? 0;
		const bn = b[i + 1] ?? 0;
		for (let j = bi; j < bn; ++j) {
			r[j] = ((j - bi) << 5) | i;
		}
	}
	return { b, r };
}

const flPair = freb(fleb, 2);
/** Length base for length codes 257–285. */
export const fl = flPair.b;
/** Reverse: match length → packed (extra << 5) | code-index. */
export const revfl = flPair.r;
// Special-case length 258 (RFC).
fl[28] = 258;
revfl[258] = 28;

const fdPair = freb(fdeb, 0);
/** Distance base for distance codes 0–29. */
export const fd = fdPair.b;
/** Reverse: distance → packed (extra << 5) | code-index. */
export const revfd = fdPair.r;

/** 15-bit bit-reverse table. */
export const rev = new Uint16Array(32768);
for (let i = 0; i < 32768; ++i) {
	let x = ((i & 0xaaaa) >> 1) | ((i & 0x5555) << 1);
	x = ((x & 0xcccc) >> 2) | ((x & 0x3333) << 2);
	x = ((x & 0xf0f0) >> 4) | ((x & 0x0f0f) << 4);
	rev[i] = (((x & 0xff00) >> 8) | ((x & 0x00ff) << 8)) >> 1;
}

/**
 * Build a Huffman map from code lengths.
 * @param cd index → code length
 * @param mb max bits (≤ 15)
 * @param decode 1 = decode LUT (symbol<<4|bits), 0 = encode map (symbol → code)
 */
export function hMap(cd: Uint8Array, mb: number, decode: 0 | 1): Uint16Array {
	const s = cd.length;
	const l = new Uint16Array(mb);
	for (let i = 0; i < s; ++i) {
		const bits = cd[i] ?? 0;
		if (bits) {
			const idx = bits - 1;
			l[idx] = (l[idx] ?? 0) + 1;
		}
	}
	const le = new Uint16Array(mb);
	for (let i = 1; i < mb; ++i) {
		le[i] = ((le[i - 1] ?? 0) + (l[i - 1] ?? 0)) << 1;
	}
	if (decode) {
		const co = new Uint16Array(1 << mb);
		const rvb = 15 - mb;
		for (let i = 0; i < s; ++i) {
			const bits = cd[i] ?? 0;
			if (bits) {
				const sv = (i << 4) | bits;
				const r = mb - bits;
				const leIdx = bits - 1;
				const start = (le[leIdx] ?? 0) << r;
				le[leIdx] = (le[leIdx] ?? 0) + 1;
				let v = start;
				const m = v | ((1 << r) - 1);
				for (; v <= m; ++v) {
					const revV = rev[v] ?? 0;
					co[revV >> rvb] = sv;
				}
			}
		}
		return co;
	}
	const co = new Uint16Array(s);
	for (let i = 0; i < s; ++i) {
		const bits = cd[i] ?? 0;
		if (bits) {
			const leIdx = bits - 1;
			const code = le[leIdx] ?? 0;
			le[leIdx] = code + 1;
			co[i] = (rev[code] ?? 0) >> (15 - bits);
		}
	}
	return co;
}

/** {@link huffCheck}: lengths do not form a usable prefix code. */
export const HUFF_BAD = 0;
/** {@link huffCheck}: complete code (every table slot is written). */
export const HUFF_FULL = 1;
/** {@link huffCheck}: no codes, or a single 1-bit code (table has holes). */
export const HUFF_PARTIAL = 2;

/**
 * Validate a set of code lengths the way zlib's `inflate_table` does:
 * over-subscribed sets are rejected; incomplete sets are rejected except a
 * lone 1-bit code (or no codes at all) for the literal/length and distance
 * alphabets. The code-length alphabet (`codes`) must be complete or empty.
 */
export function huffCheck(cd: Uint8Array, codes: boolean): number {
	const count = new Uint16Array(16);
	for (let i = 0; i < cd.length; ++i) count[cd[i]!]!++;
	let left = 1;
	let max = 0;
	for (let len = 1; len < 16; ++len) {
		left = (left << 1) - count[len]!;
		if (left < 0) return HUFF_BAD;
		if (count[len]) max = len;
	}
	// zlib builds an all-invalid table for an empty set and lets decoding fail.
	if (max === 0) return HUFF_PARTIAL;
	if (left > 0) return codes || max !== 1 ? HUFF_BAD : HUFF_PARTIAL;
	return HUFF_FULL;
}

/**
 * Root bits of a dynamic decode LUT. Codes up to this length decode with one
 * lookup; a longer code's root slot holds a link to a 32-entry subtable
 * indexed by the next 5 bits (zlib's inflate_table does the same with a 9-bit
 * root).
 *
 * A flat 15-bit LUT costs 32768 writes per dynamic block however small the
 * block is, so a stream of ~23-byte blocks that each declare a 15-bit code
 * ran ~20x slower than zlib. With a 10-bit root the per-block cost is 1024
 * writes plus 32 per long-code prefix.
 */
export const ROOT_BITS = 10;
const SUB_BITS = 15 - ROOT_BITS;

/** Slots in a dynamic LUT for an alphabet of `n` symbols. */
export function lutSize(n: number): number {
	return (1 << ROOT_BITS) + n * (1 << SUB_BITS);
}

/** Per-block dedupe of long-code prefixes (shared by the two LUTs). */
export type SubState = { stamp: Uint32Array; gen: number };

export function subState(): SubState {
	return { stamp: new Uint32Array(1 << ROOT_BITS), gen: 0 };
}

/**
 * Build a decode LUT (`symbol << 4 | bits`) into `co`. Root slots
 * `[0, 1 << min(mb, ROOT_BITS))`; a root entry with `bits === 0` and a
 * non-zero value is a subtable link: the subtable starts at
 * `(entry >> 4) << 5` and is indexed by the 5 stream bits after the root.
 *
 * `co` is reused across blocks: a complete code (`full`, see
 * {@link huffCheck}) writes every slot it can reach; otherwise the root is
 * cleared first so unused slots decode as invalid (0). Incomplete codes are
 * at most 1 bit long, so they never use subtables.
 */
export function hDecode(
	cd: Uint8Array,
	mb: number,
	co: Uint16Array,
	full: boolean,
	ss: SubState,
): Uint16Array {
	const rb = mb < ROOT_BITS ? mb : ROOT_BITS;
	if (!full) co.fill(0, 0, 1 << rb);
	const l = new Uint16Array(16);
	for (let i = 0; i < cd.length; ++i) l[cd[i]!]!++;
	const le = new Uint16Array(16);
	for (let i = 1; i < mb; ++i) le[i] = (le[i - 1]! + l[i]!) << 1;
	const rvb = 15 - rb;
	const gen = ++ss.gen;
	let nextSub = 1 << ROOT_BITS;
	for (let i = 0; i < cd.length; ++i) {
		const bits = cd[i]!;
		if (!bits) continue;
		const code = le[bits - 1]!++;
		const sv = (i << 4) | bits;
		if (bits <= rb) {
			const r = rb - bits;
			let v = code << r;
			const m = v | ((1 << r) - 1);
			for (; v <= m; ++v) co[rev[v]! >> rvb] = sv;
			continue;
		}
		// Long code: root slot from its first `rb` bits, subtable from the rest.
		const k = bits - rb;
		const slot = rev[code >> k]! >> rvb;
		let base: number;
		if (ss.stamp[slot] === gen) {
			base = (co[slot]! >> 4) << SUB_BITS;
		} else {
			ss.stamp[slot] = gen;
			base = nextSub;
			nextSub += 1 << SUB_BITS;
			co[slot] = (base >> SUB_BITS) << 4;
		}
		// Remaining k code bits arrive MSB first: as an LSB-first index they
		// are the k-bit reversal; the upper 5-k index bits are don't-care.
		const low = rev[code & ((1 << k) - 1)]! >> (15 - k);
		for (let j = 0; j < 1 << (SUB_BITS - k); ++j)
			co[base + (low | (j << k))] = sv;
	}
	return co;
}

/** Fixed length tree (code lengths). */
export const flt = new Uint8Array(288);
for (let i = 0; i < 144; ++i) flt[i] = 8;
for (let i = 144; i < 256; ++i) flt[i] = 9;
for (let i = 256; i < 280; ++i) flt[i] = 7;
for (let i = 280; i < 288; ++i) flt[i] = 8;

/** Fixed distance tree (code lengths). */
export const fdt = new Uint8Array(32);
for (let i = 0; i < 32; ++i) fdt[i] = 5;

/** Fixed length encode / decode maps. */
export const flm = hMap(flt, 9, 0);
export const flrm = hMap(flt, 9, 1);

/** Fixed distance encode / decode maps. */
export const fdm = hMap(fdt, 5, 0);
export const fdrm = hMap(fdt, 5, 1);
// Fixed codes 286/287 (lengths) and 30/31 (distances) exist in the code
// space but are invalid symbols (RFC 1951 §3.2.6); zlib rejects them. A zero
// LUT entry decodes as invalid.
for (let i = 0; i < flrm.length; ++i) if (flrm[i]! >> 4 > 285) flrm[i] = 0;
for (let i = 0; i < fdrm.length; ++i) if (fdrm[i]! >> 4 > 29) fdrm[i] = 0;

/** Empty code-length table (no symbols). */
export const emptyCodes = new Uint8Array(0);
