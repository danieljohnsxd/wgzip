/**
 * GZIP member framing (RFC 1952) around raw DEFLATE.
 */

import { wbytes } from "./bitio.js";
import { crc32, type Crc32 } from "./crc32.js";
import { deflateRaw, type DeflateConfig } from "./deflate.js";
import { GzipErrorCode, gzipErr } from "./errors.js";

export type { DeflateConfig };

/** XFL byte: 4 = fastest, 2 = maximum compression, 0 = default. */
export type GzipXfl = 0 | 2 | 4;

/**
 * Write a minimal 10-byte GZIP header into `c` at offset 0.
 * OS = 3 (Unix). No filename / extra / comment / FHCRC.
 */
export function writeGzipHeader(c: Uint8Array, xfl: GzipXfl): void {
	c[0] = 31;
	c[1] = 139;
	c[2] = 8; // CM = deflate
	c[3] = 0; // FLG
	// MTIME left 0 (deterministic; no clock)
	c[8] = xfl;
	c[9] = 3; // OS = Unix
}

/**
 * Budget for FNAME + FCOMMENT together, terminators included.
 *
 * zlib scans these zero-terminated fields in O(1) memory and copies at most
 * the caller's `name_max` / `comm_max`; it has no buffer of its own, so it
 * never stops. Without a caller buffer to bound us, an unterminated FNAME
 * would keep a decoder busy forever on a stream that never yields output
 * (and `maxSize` never fires). 64 KiB matches FEXTRA's own 16-bit XLEN bound
 * and is 16x Linux PATH_MAX (4096), so no real filename or comment hits it.
 * FEXTRA needs no extra cap: XLEN already limits it to 65535 bytes.
 */
export const HEADER_TEXT_MAX = 65536;

const H_FIXED = 0;
const H_XLEN = 1;
const H_EXTRA = 2;
const H_TEXT = 3;
const H_HCRC = 4;
const H_DONE = 5;

/**
 * Incremental GZIP member header parser (RFC 1952 §2.3).
 *
 * Consumes bytes as they arrive and keeps O(1) state, so a streaming caller
 * never re-buffers or re-scans a long header. Validates magic, CM, reserved
 * FLG bits, the FNAME/FCOMMENT budget, and (when `verify`) the FHCRC CRC16,
 * which zlib also checks.
 */
export class GzipHeaderParser {
	private st = H_FIXED;
	private n = 0;
	private flg = 0;
	private zs = 0;
	private text = 0;
	private hc = 0;
	private readonly fix = new Uint8Array(10);
	private crc: Crc32 | undefined;
	private readonly verify: boolean;
	private readonly after: boolean;

	/**
	 * @param verify check FHCRC when present
	 * @param after this member follows another; a bad magic is reported as
	 *   trailing garbage
	 */
	constructor(verify: boolean, after: boolean) {
		this.verify = verify;
		this.after = after;
	}

	/** Header fully parsed. */
	get done(): boolean {
		return this.st === H_DONE;
	}

	/** No byte of this header has been consumed yet. */
	get empty(): boolean {
		return this.st === H_FIXED && this.n === 0;
	}

	/** Stage after `from`, given the flags. */
	private next(from: number): number {
		const f = this.flg;
		if (from < H_XLEN && f & 4) return H_XLEN;
		if (from < H_TEXT) {
			this.zs = ((f >> 3) & 1) + ((f >> 4) & 1);
			if (this.zs) return H_TEXT;
		}
		if (from < H_HCRC && f & 2) return H_HCRC;
		return H_DONE;
	}

	/**
	 * Consume header bytes from `d[at..]`.
	 * @returns index of the first byte not consumed (the DEFLATE start once
	 *   {@link done}).
	 */
	feed(d: Uint8Array, at: number): number {
		const end = d.length;
		let i = at;
		// Start of the not-yet-CRC'd span in `d`, or -1 when not tracking.
		let cf = this.crc && this.st !== H_FIXED && this.st < H_HCRC ? i : -1;
		while (i < end && this.st !== H_DONE) {
			const stage = this.st;
			if (stage === H_FIXED) {
				const b = d[i++] ?? 0;
				const k = this.n++;
				this.fix[k] = b;
				if ((k === 0 && b !== 31) || (k === 1 && b !== 139)) {
					gzipErr(
						GzipErrorCode.InvalidHeader,
						this.after
							? "trailing garbage after gzip member"
							: "invalid gzip data",
					);
				}
				if (k === 2 && b !== 8) {
					gzipErr(GzipErrorCode.InvalidHeader, "invalid gzip data");
				}
				if (k === 3) {
					// RFC 1952 §2.3.1: bits 5–7 of FLG are reserved and MUST be zero.
					if (b & 0xe0) {
						gzipErr(GzipErrorCode.InvalidHeader, "reserved header flag set");
					}
					this.flg = b;
				}
				if (this.n === 10) {
					if (this.verify && this.flg & 2) {
						this.crc = crc32();
						this.crc.p(this.fix);
						cf = i;
					}
					this.n = 0;
					this.st = this.next(H_FIXED);
				}
			} else if (stage === H_XLEN) {
				this.hc |= (d[i++] ?? 0) << (8 * this.n++);
				if (this.n === 2) {
					this.n = this.hc;
					this.hc = 0;
					this.st = this.n ? H_EXTRA : this.next(H_EXTRA);
				}
			} else if (stage === H_EXTRA) {
				const take = Math.min(this.n, end - i);
				i += take;
				this.n -= take;
				if (!this.n) this.st = this.next(H_EXTRA);
			} else if (stage === H_TEXT) {
				const lim = Math.min(end, i + (HEADER_TEXT_MAX - this.text));
				const z = d.subarray(i, lim).indexOf(0);
				if (z < 0) {
					this.text += lim - i;
					i = lim;
					if (this.text >= HEADER_TEXT_MAX) {
						gzipErr(GzipErrorCode.InvalidHeader, "gzip header too large");
					}
				} else {
					this.text += z + 1;
					i += z + 1;
					if (--this.zs === 0) this.st = this.next(H_TEXT);
				}
			} else {
				if (cf >= 0) {
					this.crc?.p(d.subarray(cf, i));
					cf = -1;
				}
				this.hc |= (d[i++] ?? 0) << (8 * this.n++);
				if (this.n === 2) {
					if (this.crc && (this.crc.d() & 0xffff) !== this.hc) {
						gzipErr(GzipErrorCode.InvalidHeader, "header crc mismatch");
					}
					this.st = H_DONE;
				}
			}
		}
		if (cf >= 0) this.crc?.p(d.subarray(cf, i));
		return i;
	}
}

/**
 * Parse a complete GZIP header at the start of `d`; return the byte offset of
 * the first DEFLATE byte. Supports FEXTRA / FNAME / FCOMMENT / FHCRC.
 */
export function gzipHeaderLength(
	d: Uint8Array,
	verify: boolean,
	after = false,
): number {
	const p = new GzipHeaderParser(verify, after);
	const n = p.feed(d, 0);
	if (!p.done) gzipErr(GzipErrorCode.UnexpectedEOF);
	return n;
}

/** ISIZE from the 8-byte trailer (last 4 bytes, mod 2^32). */
export function gzipISize(d: Uint8Array): number {
	const l = d.length;
	return (
		((d[l - 4] ?? 0) |
			((d[l - 3] ?? 0) << 8) |
			((d[l - 2] ?? 0) << 16) |
			((d[l - 1] ?? 0) << 24)) >>>
		0
	);
}

/** CRC32 from the 8-byte trailer (bytes −8…−4). */
export function gzipCrc(d: Uint8Array): number {
	const l = d.length;
	return (
		((d[l - 8] ?? 0) |
			((d[l - 7] ?? 0) << 8) |
			((d[l - 6] ?? 0) << 16) |
			((d[l - 5] ?? 0) << 24)) >>>
		0
	);
}

/**
 * Compress `data` to a single GZIP member using `cfg`.
 * Header is deterministic (mtime 0). Trailer carries CRC32 + ISIZE.
 */
export function encodeGzip(
	data: Uint8Array,
	cfg: DeflateConfig,
	xfl: GzipXfl,
): Uint8Array {
	const c = crc32();
	c.p(data);
	const out = deflateRaw(data, cfg, 10, 8);
	writeGzipHeader(out, xfl);
	const s = out.length;
	// CRC32 + ISIZE. Buffer is zero-init; wbytes no-ops when value is 0.
	wbytes(out, s - 8, c.d());
	wbytes(out, s - 4, data.length >>> 0);
	return out;
}
