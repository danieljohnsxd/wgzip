---
name: gzip
description: Compress or decompress GZIP in pure TypeScript with wgzip — synchronous one-shot, push, or TransformStream, on Workers, edge runtimes, Convex, Deno, Bun or Node. Load when code reads or writes .gz / gzip bytes, needs a sync gzip, deterministic gzip output, or must decode gzip from an untrusted source with a size cap.
---

# gzip with wgzip

## When to use / when not to

- Use when you need **synchronous** `Uint8Array -> Uint8Array` gzip, a **bounded decode** of untrusted input (`maxSize`), **deterministic** output bytes, a mid-stream `flush()`, or a runtime without `CompressionStream`.
- Built-in `CompressionStream("gzip")` / `DecompressionStream("gzip")` are fine when async streaming is all you need and you trust the input size. They have no output cap.
- On **Node** with no portability need, `node:zlib` (`gzipSync`, `gunzipSync`) is native: ~1.6x faster encode, 2-4x faster decode.
- **Browser `fetch` with `Content-Encoding: gzip`**: the browser already decoded it. Do not gunzip `response.body` again.
- **Static assets**: precompress at build time with native gzip/brotli/zstd; do not use a JS encoder.
- zstd data is the sibling `wzstd`; image uploads (resize / re-encode) are the sibling `wimgs`. Not covered here: zlib (RFC 1950) wrapper, raw deflate API, ZIP.

## Happy path

```ts
import {
	compressFast,
	compressStrong,
	decompress,
	decompressStream,
} from "wgzip";

const gz = compressStrong(bytes); // or compressFast for latency
const plain = decompress(untrusted); // CRC32 + ISIZE verified, output capped at 64 MiB
const body = res.body!.pipeThrough(
	decompressStream({ maxSize: 16 * 1024 * 1024 }),
);
```

Tiers: **`compressFast`** (~zlib level 1) for latency, **`compressStrong`** (~zlib level 9) when bytes matter. Push: `CompressFast` / `CompressStrong` / `Decompress` with `push(chunk, final?)`. Streams: `compressFastStream()` / `compressStrongStream()` / `decompressStream()`.

## Rules

- There is no level parameter and no `compress(level)`. Pick a tier by name.
- Keep the default `maxSize` (64 MiB) or set a smaller one for untrusted input. `maxSize: Infinity` only for data you produced. It must be `Infinity` or a non-negative safe integer.
- Never pass `checksum: false` for untrusted data; it skips the CRC32/ISIZE (and FHCRC) check. It never disables `maxSize` or header rules.
- `out` (pre-sized buffer) takes a single member and never truncates; without `maxSize`, `out.length` is the only cap.
- Push decoders: always finish with `push(new Uint8Array(0), true)` so truncated input throws instead of hanging.
- `flush()` (push encoders only) emits a Z_SYNC_FLUSH point; use it for SSE / logs, not per tiny write.
- Concatenated members are joined; any other bytes after the last member are rejected (same as `node:zlib`).

## Errors

Every data error is a `GzipError` with `code` from `GzipErrorCode`:

- `OutputTooLarge` — output would exceed `maxSize`. Reject (e.g. HTTP 413), or raise the cap if the source is trusted.
- `ChecksumMismatch`, `SizeMismatch` — corrupt trailer (`SizeMismatch` also: `out` too small).
- `InvalidHeader` — bad magic/flags, header CRC mismatch, FNAME+FCOMMENT over 64 KiB, or trailing garbage.
- `InvalidBlockType`, `InvalidLengthLiteral`, `InvalidDistance` — corrupt DEFLATE data. Reject; do not retry.
- `UnexpectedEOF` — truncated input (push/stream raise it at the final push / flush).

Bad options (`maxSize: NaN`, `-1`, a string; `checksum: "no"`) and push-after-final throw `TypeError`. Catch with `e instanceof GzipError` and branch on `e.code`.

## More

`references/context.md`: why these defaults, what matches `node:zlib`, measurements, and what was rejected.
