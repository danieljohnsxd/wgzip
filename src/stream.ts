/**
 * Web Streams adapter for the decoder.
 *
 * `TransformStream` is a host API, referenced lazily so importing the barrel
 * still works where it is absent. Never `class X extends TransformStream`.
 */
import { Decompress, type GzipDecodeOptions } from "./decompress.js";

/**
 * `TransformStream` adapter for {@link Decompress}.
 * Enqueues each decoded slice. Truncated input rejects at flush.
 *
 * Strict (matches node:zlib): reserved FLG bits and trailing garbage are
 * rejected; concatenated members are joined; CRC32 and ISIZE are verified
 * unless `checksum: false`. Output is capped at `maxSize` (default 64 MiB;
 * `Infinity` opts out). Bad options throw `TypeError` here, at call time.
 *
 * ```ts
 * import { decompressStream } from "wgzip";
 *
 * const res = await fetch(url);
 * const plain = res.body.pipeThrough(decompressStream());
 * ```
 */
export function decompressStream(
	opts?: Omit<GzipDecodeOptions, "out">,
): TransformStream<Uint8Array, Uint8Array> {
	// Built eagerly so bad options throw at call time, not on first chunk.
	const dec = new Decompress(undefined, opts);
	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			dec.ondata = (chunk) => {
				if (chunk.length > 0) controller.enqueue(chunk);
			};
		},
		transform(chunk) {
			dec.push(chunk);
		},
		flush() {
			dec.push(new Uint8Array(0), true);
		},
	});
}
