/**
 * GZIP decompression (one or more concatenated members).
 *
 * Strict, matching `node:zlib`: reserved FLG bits and trailing garbage are
 * rejected; CRC32 + ISIZE are verified unless `checksum: false`. Output is
 * capped at {@link GzipDecodeOptions.maxSize} (default 64 MiB).
 */

import { slc } from "./bitio.js";
import { crc32, type Crc32 } from "./crc32.js";
import { GzipError, GzipErrorCode, gzipErr } from "./errors.js";
import {
	GzipHeaderParser,
	gzipCrc,
	gzipHeaderLength,
	gzipISize,
} from "./gzip.js";
import {
	inflateRaw,
	INFLATE_PAD,
	inflateTables,
	type InflateState,
	type InflateTables,
} from "./inflate.js";

/** DEFLATE match window — streaming keeps this much history. */
const WINDOW = 32768;

/** Default {@link GzipDecodeOptions.maxSize}: 64 MiB. */
const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;

/**
 * DEFLATE's expansion ceiling: a 258-byte match costs at least 2 bits
 * (1-bit length code + 1-bit distance code), so 1032 output bytes per input
 * byte. An ISIZE above this for the input at hand is forged; never
 * preallocate past it.
 */
const DEFLATE_MAX_RATIO = 1032;

export { GzipError, GzipErrorCode, type GzipErrorCodeValue } from "./errors.js";

/** Options for GZIP decompress (one-shot, push, and `TransformStream`). */
export type GzipDecodeOptions = {
	/**
	 * Preallocated output buffer. When set, input must be a **single** GZIP
	 * member whose decompressed size fits in `out`.
	 *
	 * - If decompressed size exceeds `out.length`, throws `SizeMismatch`
	 *   (never truncates), even with `checksum: false`.
	 * - A second member, or any trailing bytes after the member, is
	 *   rejected with `InvalidHeader`.
	 * - When the size matches exactly, the same buffer identity is returned.
	 * - When `out` is larger than needed, a subarray view is returned.
	 * - `maxSize` larger than `out.length` is irrelevant (`out` already
	 *   bounds the write); a smaller `maxSize` still caps with
	 *   `OutputTooLarge`.
	 */
	out?: Uint8Array;
	/**
	 * Verify the per-member CRC32 (and ISIZE). Defaults to `true`.
	 * Only an explicit `false` skips the check — omitting the field, or
	 * passing `{}` / `undefined`, always verifies. Header rules, trailing
	 * garbage, and `maxSize` still apply.
	 */
	checksum?: boolean | undefined;
	/**
	 * Maximum **total** decompressed bytes across all members. Exceeding it
	 * throws {@link GzipErrorCode.OutputTooLarge} from inside inflate (a
	 * 64 KiB compressed chunk can expand to tens of MiB, so a between-chunk
	 * check is not enough).
	 *
	 * Defaults to 64 MiB (`64 * 1024 * 1024`); with `out`, defaults to no cap
	 * beyond `out.length`. Pass `Infinity` to opt out. Must be `Infinity` or
	 * a non-negative safe integer, else `TypeError`.
	 */
	maxSize?: number | undefined;
};

/** Validated options. `max` undefined = uncapped. */
type Resolved = { verify: boolean; max: number | undefined };

function resolveOpts(
	opts: GzipDecodeOptions | undefined,
	hasOut: boolean,
): Resolved {
	const raw: unknown = opts;
	if (raw === undefined || raw === null) {
		return { verify: true, max: hasOut ? undefined : DEFAULT_MAX_SIZE };
	}
	if (typeof raw !== "object") {
		throw new TypeError("wgzip: options must be an object");
	}
	const checksum: unknown = opts?.checksum;
	const maxSize: unknown = opts?.maxSize;
	if (checksum !== undefined && typeof checksum !== "boolean") {
		throw new TypeError("wgzip: checksum must be a boolean");
	}
	let max: number | undefined;
	if (maxSize === undefined) {
		max = hasOut ? undefined : DEFAULT_MAX_SIZE;
	} else if (maxSize === Infinity) {
		max = undefined;
	} else if (
		typeof maxSize === "number" &&
		Number.isSafeInteger(maxSize) &&
		maxSize >= 0
	) {
		max = maxSize;
	} else {
		throw new TypeError(
			"wgzip: maxSize must be Infinity or a non-negative safe integer",
		);
	}
	return { verify: checksum !== false, max };
}

/** Callback for push-based streaming encode and decode. */
export type GzipStreamHandler = (data: Uint8Array, final?: boolean) => unknown;

function verifyMember(
	raw: Uint8Array,
	member: Uint8Array,
	verify: boolean,
): void {
	if (!verify) return;
	const expectCrc = gzipCrc(member);
	const expectSize = gzipISize(member);
	const got = crc32();
	got.p(raw);
	if (got.d() !== expectCrc) {
		gzipErr(GzipErrorCode.ChecksumMismatch);
	}
	if (raw.length >>> 0 !== expectSize) {
		gzipErr(GzipErrorCode.SizeMismatch);
	}
}

/** True if bytes at `i` are `1f 8b`, or a lone `1f` that could still become that. */
function looksLikeMember(d: Uint8Array, i: number): boolean {
	if (d[i] !== 31) return false;
	if (i + 1 >= d.length) return true;
	return d[i + 1] === 139;
}

function trailingGarbage(): never {
	gzipErr(GzipErrorCode.InvalidHeader, "trailing garbage after gzip member");
}

type MemberOpts = {
	verify: boolean;
	max?: number | undefined;
	out?: Uint8Array | undefined;
	/** When set (walker scratch), inflate may grow this buffer (`i = 1`). */
	scratch?: Uint8Array | undefined;
};

type MemberResult = {
	raw: Uint8Array;
	end: number;
	scratch?: Uint8Array | undefined;
};

/**
 * Header → inflate → trailer for one member starting at `offset`.
 * `{ out }` uses one-shot strict (`i = 2`); the walker reuses `scratch`.
 */
function inflateMember(
	src: Uint8Array,
	offset: number,
	opts: MemberOpts,
): MemberResult {
	const view = src.subarray(offset);
	if (view.length < 10) gzipErr(GzipErrorCode.UnexpectedEOF);
	const hl = gzipHeaderLength(view, opts.verify, offset > 0);
	if (hl + 8 > view.length) gzipErr(GzipErrorCode.UnexpectedEOF);

	const useOut = opts.out !== undefined;
	const st: InflateState = {
		i: useOut ? 2 : 1,
		max: opts.max,
	};
	const body = view.subarray(hl);
	const buf = useOut
		? (opts.out ?? new Uint8Array(0))
		: (opts.scratch ?? new Uint8Array(0));
	const grown = inflateRaw(body, st, buf);
	const bitPos = st.p ?? 0;
	const deflateBytes = ((bitPos + 7) / 8) | 0;
	const memberEnd = hl + deflateBytes + 8;
	if (memberEnd > view.length) gzipErr(GzipErrorCode.UnexpectedEOF);

	const bt = st.b ?? 0;
	const raw = useOut ? grown : slc(grown, 0, bt);
	verifyMember(raw, view.subarray(0, memberEnd), opts.verify);
	return { raw, end: offset + memberEnd, scratch: useOut ? undefined : grown };
}

/**
 * One-shot GZIP decompress (RFC 1952). Concatenated members are joined.
 * Streaming: {@link Decompress}, {@link import("./stream.js").decompressStream}.
 *
 * Strict (matches node:zlib): reserved FLG bits and trailing garbage are
 * rejected; CRC32 and ISIZE are verified unless `checksum: false`. Output is
 * capped at `maxSize` (default 64 MiB; `Infinity` opts out).
 *
 * @param data GZIP bytes (one or more members)
 * @param opts Optional output buffer, checksum flag, and `maxSize`
 */
export function decompress(
	data: Uint8Array,
	opts?: GzipDecodeOptions,
): Uint8Array {
	const outOpt = opts?.out;
	if (outOpt !== undefined && !(outOpt instanceof Uint8Array)) {
		throw new TypeError("wgzip: out must be a Uint8Array");
	}
	const { verify, max: maxSize } = resolveOpts(opts, outOpt !== undefined);

	if (data.length < 18) {
		gzipErr(GzipErrorCode.InvalidHeader, "invalid gzip data");
	}

	// One padded copy for the whole call so inflateRaw never copies per member.
	const padded = new Uint8Array(data.length + INFLATE_PAD);
	padded.set(data);
	const src = padded.subarray(0, data.length);

	if (outOpt !== undefined) {
		const { raw, end } = inflateMember(src, 0, {
			out: outOpt,
			max: maxSize,
			verify,
		});
		if (end < src.length) {
			if (!looksLikeMember(src, end)) trailingGarbage();
			gzipErr(GzipErrorCode.InvalidHeader, "invalid gzip data");
		}
		return raw;
	}

	return decodeMembers(src, verify, maxSize);
}

function decodeMembers(
	src: Uint8Array,
	verify: boolean,
	maxSize: number | undefined,
): Uint8Array {
	// ISIZE is a size hint for a single member. SizeMismatch or a consume
	// miss falls through to the walker.
	const isize = gzipISize(src);
	const headerEnd = gzipHeaderLength(src, verify);
	if (headerEnd + 8 <= src.length) {
		const body = src.subarray(headerEnd, src.length - 8);
		// Never let a forged ISIZE drive the allocation: bound it by the cap
		// and by what this much DEFLATE can possibly expand to.
		const prealloc = Math.min(
			isize,
			maxSize ?? isize,
			body.length * DEFLATE_MAX_RATIO,
		);
		const stObj: InflateState = { i: 2, max: maxSize };
		const buf = new Uint8Array(prealloc);
		let raw: Uint8Array | undefined;
		try {
			raw = inflateRaw(body, stObj, buf);
		} catch (err) {
			// Output outgrew the ISIZE hint: fall through to the walker.
			if (
				!(err instanceof GzipError && err.code === GzipErrorCode.SizeMismatch)
			) {
				throw err;
			}
		}
		const deflateBytes = (((stObj.p ?? 0) + 7) / 8) | 0;
		if (raw && deflateBytes === body.length) {
			verifyMember(raw, src, verify);
			// Forged ISIZE must not pin a huge ArrayBuffer behind a
			// short view: copy when the prealloc was larger than `bt`.
			if (raw.length < buf.length) return slc(raw, 0);
			return raw;
		}
	}

	const parts: Array<Uint8Array> = [];
	let offset = 0;
	let produced = 0;
	let scratch: Uint8Array | undefined;

	while (offset < src.length) {
		if (parts.length > 0 && !looksLikeMember(src, offset)) {
			trailingGarbage();
		}
		const remain = maxSize === undefined ? undefined : maxSize - produced;
		const got = inflateMember(src, offset, {
			verify,
			max: remain,
			scratch,
		});
		parts.push(got.raw);
		produced += got.raw.length;
		offset = got.end;
		scratch = got.scratch;
	}

	if (parts.length === 0) {
		gzipErr(GzipErrorCode.InvalidHeader, "invalid gzip data");
	}
	if (parts.length === 1) {
		return parts[0] ?? new Uint8Array(0);
	}
	let total = 0;
	for (const p of parts) total += p.length;
	const joined = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		joined.set(p, o);
		o += p.length;
	}
	return joined;
}

/**
 * Push GZIP decompressor. Same rules as {@link decompress}.
 * Each slice handed to {@link ondata} is a fresh buffer.
 * See {@link import("./stream.js").decompressStream}.
 *
 * Strict (matches node:zlib): reserved FLG bits and trailing garbage are
 * rejected; concatenated members are joined; CRC32 and ISIZE are verified
 * unless `checksum: false`. Output is capped at `maxSize` (default 64 MiB;
 * `Infinity` opts out).
 */
export class Decompress {
	ondata: GzipStreamHandler;
	private readonly verify: boolean;
	private readonly maxSize: number | undefined;
	private pending = new Uint8Array(0) as Uint8Array;
	private readonly tabs: InflateTables = inflateTables();
	private st: InflateState = { i: 0 };
	private hdr: GzipHeaderParser;
	private out = new Uint8Array(WINDOW) as Uint8Array;
	private emitted = 0;
	private phase: "header" | "body" | "trailer" = "header";
	private crc: Crc32 = crc32();
	private produced = 0;
	private totalOut = 0;
	private trailer = new Uint8Array(8);
	private trailerGot = 0;
	private finished = false;

	constructor(
		ondata?: GzipStreamHandler,
		opts?: Omit<GzipDecodeOptions, "out">,
	) {
		this.ondata = ondata ?? (() => {});
		const r = resolveOpts(opts, false);
		this.verify = r.verify;
		this.maxSize = r.max;
		this.hdr = new GzipHeaderParser(this.verify, false);
	}

	/**
	 * Push a compressed chunk. Pass `final: true` on the last chunk (or an
	 * empty final push after the last data) so a truncated member errors
	 * instead of waiting forever.
	 */
	push(chunk: Uint8Array, final?: boolean): void {
		if (this.finished) {
			throw new TypeError("Decompress.push called after final");
		}
		this.feed(chunk, final === true);
	}

	private capCursor(): void {
		if (this.maxSize === undefined) {
			this.st.max = undefined;
			return;
		}
		this.st.max = (this.st.b ?? 0) + (this.maxSize - this.totalOut);
	}

	private feed(chunk: Uint8Array, final: boolean): void {
		if (chunk.length) {
			if (this.pending.length) {
				const n = new Uint8Array(this.pending.length + chunk.length);
				n.set(this.pending);
				n.set(chunk, this.pending.length);
				this.pending = n;
			} else {
				this.pending = chunk;
			}
		}

		for (;;) {
			if (this.phase === "header") {
				// Incremental: header bytes are consumed as they arrive, never
				// re-buffered, so a long or unterminated FNAME stays linear.
				const used = this.hdr.feed(this.pending, 0);
				this.pending = this.pending.subarray(used);
				if (!this.hdr.done) {
					if (final) {
						if (this.hdr.empty) {
							this.finish();
							return;
						}
						gzipErr(GzipErrorCode.UnexpectedEOF);
					}
					return;
				}
				this.st = { i: 0, t: this.tabs };
				this.out = new Uint8Array(WINDOW);
				this.emitted = 0;
				this.crc = crc32();
				this.produced = 0;
				this.phase = "body";
			}

			if (this.phase === "body") {
				if (this.pending.length === 0 && !final) {
					this.retain(chunk);
					return;
				}
				this.st.i = final ? 1 : 0;
				this.capCursor();
				this.out = inflateRaw(this.pending, this.st, this.out);
				const bt = this.st.b ?? 0;
				if (bt > this.emitted) {
					const piece = slc(this.out, this.emitted, bt);
					if (this.verify) this.crc.p(piece);
					this.produced = (this.produced + piece.length) >>> 0;
					this.totalOut += piece.length;
					this.ondata(piece, false);
					this.emitted = bt;
				}
				if (bt > WINDOW * 2) {
					this.out.copyWithin(0, bt - WINDOW, bt);
					this.st.b = WINDOW;
					this.emitted = WINDOW;
				}
				const bitPos = this.st.p ?? 0;
				this.pending = this.pending.subarray((bitPos / 8) | 0);
				this.st.p = bitPos & 7;
				if (this.st.f && !this.st.l && !this.st.s) {
					if (this.st.p) this.pending = this.pending.subarray(1);
					this.st.p = 0;
					this.phase = "trailer";
					this.trailerGot = 0;
				} else if (final) {
					gzipErr(GzipErrorCode.UnexpectedEOF);
				} else {
					this.retain(chunk);
					return;
				}
			}

			{
				const need = 8 - this.trailerGot;
				const take = Math.min(need, this.pending.length);
				this.trailer.set(this.pending.subarray(0, take), this.trailerGot);
				this.trailerGot += take;
				this.pending = this.pending.subarray(take);
				if (this.trailerGot < 8) {
					if (final) gzipErr(GzipErrorCode.UnexpectedEOF);
					this.retain(chunk);
					return;
				}
				if (this.verify) {
					if (this.crc.d() !== gzipCrc(this.trailer)) {
						gzipErr(GzipErrorCode.ChecksumMismatch);
					}
					if (this.produced !== gzipISize(this.trailer)) {
						gzipErr(GzipErrorCode.SizeMismatch);
					}
				}
				this.hdr = new GzipHeaderParser(this.verify, true);
				this.phase = "header";
				if (this.pending.length === 0) {
					if (final) this.finish();
					return;
				}
			}
		}
	}

	/** Copy leftover input if it still aliases the caller's scratch buffer. */
	private retain(src: Uint8Array): void {
		if (this.pending.length && this.pending.buffer === src.buffer) {
			this.pending = slc(this.pending, 0);
		}
	}

	private finish(): void {
		this.finished = true;
		this.ondata(new Uint8Array(0), true);
	}
}
