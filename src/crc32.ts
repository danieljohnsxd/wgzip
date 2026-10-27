/**
 * CRC-32 (ISO 3309 / ITU-T V.42), as used by GZIP.
 * Slice-by-8 over the one-byte table; remainder uses the same polynomial.
 */

const T0 = new Int32Array(256);
const T1 = new Int32Array(256);
const T2 = new Int32Array(256);
const T3 = new Int32Array(256);
const T4 = new Int32Array(256);
const T5 = new Int32Array(256);
const T6 = new Int32Array(256);
const T7 = new Int32Array(256);

{
	for (let i = 0; i < 256; ++i) {
		let c = i;
		for (let k = 0; k < 8; ++k) {
			c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
		}
		T0[i] = c;
	}
	for (let i = 0; i < 256; ++i) {
		let c = T0[i]!;
		T1[i] = T0[c & 255]! ^ (c >>> 8);
		c = T1[i]!;
		T2[i] = T0[c & 255]! ^ (c >>> 8);
		c = T2[i]!;
		T3[i] = T0[c & 255]! ^ (c >>> 8);
		c = T3[i]!;
		T4[i] = T0[c & 255]! ^ (c >>> 8);
		c = T4[i]!;
		T5[i] = T0[c & 255]! ^ (c >>> 8);
		c = T5[i]!;
		T6[i] = T0[c & 255]! ^ (c >>> 8);
		c = T6[i]!;
		T7[i] = T0[c & 255]! ^ (c >>> 8);
	}
}

/** Incremental CRC-32 (starts at 0xFFFFFFFF, finalize with `~c`). */
export type Crc32 = {
	/** Feed more bytes. */
	p(d: Uint8Array): void;
	/** Final digest as unsigned 32-bit. */
	d(): number;
};

function crc32Update(crc: number, d: Uint8Array): number {
	let cr = crc;
	const n = d.length;
	let i = 0;
	const end = n - 7;
	for (; i < end; i += 8) {
		const x =
			cr ^ (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24));
		cr =
			T7[x & 255]! ^
			T6[(x >>> 8) & 255]! ^
			T5[(x >>> 16) & 255]! ^
			T4[x >>> 24]! ^
			T3[d[i + 4]!]! ^
			T2[d[i + 5]!]! ^
			T1[d[i + 6]!]! ^
			T0[d[i + 7]!]!;
	}
	for (; i < n; ++i) {
		cr = T0[(cr & 255) ^ d[i]!]! ^ (cr >>> 8);
	}
	return cr;
}

export function crc32(): Crc32 {
	let c = -1;
	return {
		p(d: Uint8Array): void {
			c = crc32Update(c, d);
		},
		d(): number {
			return ~c >>> 0;
		},
	};
}

/** One-shot CRC-32 of `d`. */
export function crc32Of(d: Uint8Array): number {
	return ~crc32Update(-1, d) >>> 0;
}
