/**
 * Strong encoder: deep chain, full "nice" length, large hash table.
 * Prioritizes compression ratio over encode speed.
 */

import type { GzipStreamHandler } from "../decompress.js";
import {
	type DeflateConfig,
	EncodeStream,
	compressWithConfig,
} from "./shared.js";

/** Strong matcher: nice 258, chain 1024, 18-bit hash. */
const STRONG_CONFIG: DeflateConfig = {
	nice: 258,
	chain: 1024,
	hashBits: 18,
};

/**
 * One-shot Strong encode (GZIP member).
 * Streaming: {@link CompressStrong}, {@link compressStrongStream}.
 */
export function compressStrong(data: Uint8Array): Uint8Array {
	// XFL = 2 → "compressor used maximum compression" (RFC 1952)
	return compressWithConfig(data, STRONG_CONFIG, 2);
}

/**
 * Push Strong encoder. One GZIP member per instance.
 * Same framing as {@link CompressFast}. See {@link compressStrongStream}.
 */
export class CompressStrong {
	private readonly inner: EncodeStream;

	constructor(ondata?: GzipStreamHandler) {
		this.inner = new EncodeStream(STRONG_CONFIG, 2, ondata);
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
 * `TransformStream` adapter for {@link CompressStrong}.
 * The host API is referenced lazily. Never `extends` it.
 * {@link CompressStrong.flush} is push-API only — Web Streams have no
 * mid-stream flush signal, so this factory does not expose one.
 *
 * ```ts
 * import { compressStrongStream } from "wgzip";
 *
 * const gz = file.stream().pipeThrough(compressStrongStream());
 * ```
 */
export function compressStrongStream(): TransformStream<
	Uint8Array,
	Uint8Array
> {
	let enc: CompressStrong | undefined;
	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			enc = new CompressStrong((chunk) => {
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
