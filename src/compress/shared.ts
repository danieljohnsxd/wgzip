/**
 * Shared GZIP encode entry used by Fast and Strong product tiers.
 */

import { slc, wbytes } from "../bitio.js";
import { crc32, type Crc32 } from "../crc32.js";
import type { GzipStreamHandler } from "../decompress.js";
import {
	createDeflateState,
	deflateBound,
	deflateRange,
	insertHashes,
	resetDeflateState,
	writeSyncFlush,
	type DeflateConfig,
	type DeflateState,
} from "../deflate.js";
import { encodeGzip, writeGzipHeader, type GzipXfl } from "../gzip.js";

export type { DeflateConfig };

/** DEFLATE match window — streaming keeps this much history. */
export const WINDOW = 32768;

/** Uncompressed bytes per emitted streaming block. */
export const STREAM_BLOCK = 32768;

export function compressWithConfig(
	data: Uint8Array,
	cfg: DeflateConfig,
	xfl: GzipXfl,
): Uint8Array {
	return encodeGzip(data, cfg, xfl);
}

/**
 * Push encoder used by Fast/Strong. One GZIP member per instance.
 * Emits a DEFLATE block each {@link STREAM_BLOCK} uncompressed bytes.
 * {@link EncodeStream.flush} is a push-API Z_SYNC_FLUSH; Web Streams have
 * no mid-stream flush signal, so TransformStream factories do not call it.
 */
export class EncodeStream {
	ondata: GzipStreamHandler;
	private readonly xfl: GzipXfl;
	private readonly st: DeflateState;
	private readonly crc: Crc32 = crc32();
	private isize = 0;
	private buf = new Uint8Array(Math.min(WINDOW, STREAM_BLOCK * 2));
	private hist = 0;
	private end = 0;
	private out = new Uint8Array(deflateBound(STREAM_BLOCK) + 16);
	private pos = 0;
	private headerSent = false;
	private done = false;

	constructor(cfg: DeflateConfig, xfl: GzipXfl, ondata?: GzipStreamHandler) {
		this.xfl = xfl;
		this.st = createDeflateState(cfg);
		this.ondata = ondata ?? (() => {});
	}

	push(chunk: Uint8Array, final?: boolean): void {
		if (this.done) {
			throw new TypeError("EncodeStream.push called after final");
		}
		this.append(chunk);
		while (this.end - this.hist >= STREAM_BLOCK) {
			this.emitBlock(STREAM_BLOCK, false);
		}
		if (final) this.finish();
	}

	/**
	 * Z_SYNC_FLUSH: emit buffered input as a non-final DEFLATE block (and the
	 * GZIP header if it has not gone out yet), then an empty stored block so
	 * the bitstream is byte-aligned and a decoder can reconstruct everything
	 * pushed so far. Match window and hash state are kept. Throws `TypeError`
	 * if called after final.
	 *
	 * A zero-length pending range is *not* passed to {@link deflateRange}
	 * (that would emit an extra empty Huffman/stored block); only the stored
	 * sync marker is needed then. Flush on an empty stream is still valid:
	 * header + sync marker.
	 */
	flush(): void {
		if (this.done) {
			throw new TypeError("EncodeStream.flush called after final");
		}
		if (!this.headerSent) this.emitHeader();
		const pending = this.end - this.hist;
		if (pending > 0) this.emitBlock(pending, false);
		this.ensureOut((((this.pos + 7) / 8) | 0) + 5);
		this.pos = writeSyncFlush(this.out, this.pos);
		this.takeOut((this.pos / 8) | 0);
	}

	private finish(): void {
		this.done = true;
		if (!this.headerSent) this.emitHeader();
		this.emitBlock(this.end - this.hist, true);
		const o = ((this.pos + 7) / 8) | 0;
		this.ensureOut(o + 8);
		wbytes(this.out, o, this.crc.d());
		wbytes(this.out, o + 4, this.isize >>> 0);
		this.takeOut(o + 8, true);
		this.buf = new Uint8Array(0);
	}

	private emitHeader(): void {
		const h = new Uint8Array(10);
		writeGzipHeader(h, this.xfl);
		this.ondata(h);
		this.headerSent = true;
	}

	private emitBlock(size: number, last: boolean): void {
		if (!this.headerSent) this.emitHeader();
		const start = this.hist;
		const end = start + size;
		this.ensureOut((((this.pos + 7) / 8) | 0) + deflateBound(size));
		const live = this.buf.subarray(0, this.end);
		// Last two bytes of the previous block need lookahead that only
		// exists once this block has arrived.
		if (start >= 2) insertHashes(live, start - 2, start, this.st);
		this.pos = deflateRange(
			live,
			start,
			end,
			this.out,
			this.pos,
			last ? 1 : 0,
			this.st,
		);
		this.takeOut((this.pos / 8) | 0);
		this.hist = end;
		this.compact();
	}

	private takeOut(toByte: number, final = false): void {
		if (toByte > 0) {
			this.ondata(slc(this.out, 0, toByte), final);
			const bits = this.pos & 7;
			const leftover = this.out[toByte] ?? 0;
			if (bits) this.out[0] = leftover;
			this.out.fill(0, bits ? 1 : 0, toByte + 1);
			this.pos = bits;
		} else if (final) {
			this.ondata(new Uint8Array(0), true);
		}
	}

	private append(chunk: Uint8Array): void {
		if (chunk.length) {
			this.crc.p(chunk);
			this.isize = (this.isize + chunk.length) >>> 0;
		}
		let off = 0;
		while (off < chunk.length) {
			if (this.end === this.buf.length) {
				if (this.end - this.hist >= STREAM_BLOCK) {
					this.emitBlock(STREAM_BLOCK, false);
					continue;
				}
				const before = this.buf.length;
				this.grow(chunk.length - off);
				if (this.buf.length === before) {
					if (this.end > this.hist) this.emitBlock(this.end - this.hist, false);
					else return;
				}
			}
			const n = Math.min(this.buf.length - this.end, chunk.length - off);
			this.buf.set(chunk.subarray(off, off + n), this.end);
			this.end += n;
			off += n;
		}
	}

	private grow(need: number): void {
		const max = WINDOW + STREAM_BLOCK * 8;
		if (this.buf.length >= max) return;
		const want = this.end + need;
		let cap =
			this.buf.length > 0
				? this.buf.length
				: Math.min(WINDOW, STREAM_BLOCK * 2);
		while (cap < want && cap < max) cap <<= 1;
		if (cap > max) cap = max;
		if (cap === this.buf.length) return;
		const next = new Uint8Array(cap);
		next.set(this.buf.subarray(0, this.end));
		this.buf = next;
	}

	private compact(): void {
		if (this.hist <= WINDOW) return;
		const drop = this.hist - WINDOW;
		this.buf.copyWithin(0, drop, this.end);
		this.end -= drop;
		this.hist -= drop;
		// Positions in head/prev are physical; rebuild after the shift.
		resetDeflateState(this.st);
		insertHashes(this.buf.subarray(0, this.end), 0, this.hist, this.st);
	}

	private ensureOut(n: number): void {
		if (n <= this.out.length) return;
		let cap = this.out.length;
		while (cap < n) cap <<= 1;
		const next = new Uint8Array(cap);
		next.set(this.out);
		this.out = next;
	}
}
