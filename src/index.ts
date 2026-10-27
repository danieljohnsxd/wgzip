/**
 * wgzip — pure TypeScript GZIP codec (ES2022 ESM).
 *
 * One-shot, push, and `TransformStream` for each direction:
 * {@link compressFast} / {@link CompressFast} / {@link compressFastStream},
 * {@link compressStrong} / {@link CompressStrong} / {@link compressStrongStream},
 * {@link decompress} / {@link Decompress} / {@link decompressStream}.
 */

export {
	CompressFast,
	compressFast,
	compressFastStream,
} from "./compress/fast.js";
export {
	CompressStrong,
	compressStrong,
	compressStrongStream,
} from "./compress/strong.js";

export {
	Decompress,
	decompress,
	GzipError,
	GzipErrorCode,
	type GzipDecodeOptions,
	type GzipErrorCodeValue,
	type GzipStreamHandler,
} from "./decompress.js";

export { decompressStream } from "./stream.js";
