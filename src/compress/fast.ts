/**
 * Fast encoder: shallow chain, short "nice" length, wide hash.
 * Prioritizes encode throughput over ratio.
 */

import type { GzipStreamHandler } from "../decompress.js";
import {
	type DeflateConfig,
	EncodeStream,
	compressWithConfig,
} from "./shared.js";

/** Fast matcher: nice 8, chain 4, 18-bit hash. */
const FAST_CONFIG: DeflateConfig = {
	nice: 8,
	chain: 4,
	hashBits: 18,
};

/**
 * One-shot Fast encode (GZIP member).
 * Streaming: {@link CompressFast}, {@link compressFastStream}.
 */
export function compressFast(data: Uint8Array): Uint8Array {
	// XFL = 4 → "compressor used fastest algorithm" (RFC 1952)
	return compressWithConfig(data, FAST_CONFIG, 4);
}

/**
 * Push Fast encoder. One GZIP member per instance.
 * Blocks emit as 32 KiB of input arrives. See {@link compressFastStream}.
 */
export class CompressFast {
	private readonly inner: EncodeStream;

	constructor(ondata?: GzipStreamHandler) {
		this.inner = new EncodeStream(FAST_CONFIG, 4, ondata);
	}

	get ondata(): GzipStreamHandler {
		return this.inner.ondata;
	}

	set ondata(handler: GzipStreamHandler) {
		this.inner.ondata = handler;
	}

	/**
	 * Push uncompressed bytes. Pass `final: true` on the last chunk (or an
	 * empty final push) to emit the last DEFLATE block and the GZIP trailer.
	 * Throws `TypeError` if called after final.
	 */
	push(chunk: Uint8Array, final?: boolean): void {
		this.inner.push(chunk, final);
	}

	/**
	 * Z_SYNC_FLUSH equivalent. Push-API only (Web Streams have no mid-stream
	 * flush signal). Emits buffered input plus an empty stored sync block;
	 * match history is kept. Throws `TypeError` if called after final.
	 */
	flush(): void {
		this.inner.flush();
	}
}

/**
 * `TransformStream` adapter for {@link CompressFast}.
 * The host API is referenced lazily. Never `extends` it.
 * {@link CompressFast.flush} is push-API only — Web Streams have no
 * mid-stream flush signal, so this factory does not expose one.
 *
 * ```ts
 * import { compressFastStream } from "wgzip";
 *
 * const gz = file.stream().pipeThrough(compressFastStream());
 * ```
 */
export function compressFastStream(): TransformStream<Uint8Array, Uint8Array> {
	let enc: CompressFast | undefined;
	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			enc = new CompressFast((chunk) => {
				if (chunk.length > 0) controller.enqueue(chunk);
			});
		},
		transform(chunk) {
			enc?.push(chunk);
		},
		flush() {
			enc?.push(new Uint8Array(0), true);
		},
	});
}
