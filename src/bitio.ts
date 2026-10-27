/** Bit-level helpers for DEFLATE bitstreams (LSB-first). */

/** Byte index of the first full byte after bit position `p`. */
export function shft(p: number): number {
	return ((p + 7) / 8) | 0;
}

/** Copy a subarray into a fresh `Uint8Array` (helps GC drop the source). */
export function slc(v: Uint8Array, s: number, e?: number): Uint8Array {
	let start = s;
	let end = e;
	if (start < 0) start = 0;
	if (end === undefined || end > v.length) end = v.length;
	return new Uint8Array(v.subarray(start, end));
}

/** Max value in a length array. */
export function maxU8(a: Uint8Array): number {
	let m = a[0] ?? 0;
	for (let i = 1; i < a.length; ++i) {
		const v = a[i] ?? 0;
		if (v > m) m = v;
	}
	return m;
}

/** Write the minimum number of bits that can hold `v` at bit position `p`. */
export function wbits(d: Uint8Array, p: number, v: number): void {
	const shifted = v << (p & 7);
	const o = (p / 8) | 0;
	d[o] = d[o]! | shifted;
	d[o + 1] = d[o + 1]! | (shifted >> 8);
}

/** Write >8 bits of `v` at bit position `p`. */
export function wbits16(d: Uint8Array, p: number, v: number): void {
	const shifted = v << (p & 7);
	const o = (p / 8) | 0;
	d[o] = d[o]! | shifted;
	d[o + 1] = d[o + 1]! | (shifted >> 8);
	d[o + 2] = d[o + 2]! | (shifted >> 16);
}

/** Write little-endian multi-byte integer `v` starting at byte `b`. */
export function wbytes(d: Uint8Array, b: number, v: number): void {
	let val = v >>> 0;
	let i = b;
	while (val) {
		d[i] = val & 255;
		val >>>= 8;
		++i;
	}
}
