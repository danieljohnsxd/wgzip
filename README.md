# wgzip

Pure-TypeScript **GZIP** codec for runtimes that still center on **ES2022 / Node 22**: Node, Deno, Bun, Cloudflare Workers, Convex, Supabase Edge, and anything else with typed arrays. One-shot, push, and `TransformStream` in both directions. Two compressor tiers — **Fast** and **Strong** — no level knob. Decode **verifies CRC32 + ISIZE by default** and **refuses decompression bombs**: output is capped at 64 MiB unless you set `maxSize`.

The `w` prefix is a house prefix (see [wzstd](https://github.com/danieljohnsxd/wzstd)). No WebAssembly — this is plain TypeScript.

```bash
npm install wgzip
# pnpm add wgzip · yarn add wgzip · bun add wgzip · deno add npm:wgzip
```

```ts
import { compressStrong, decompress } from "wgzip";

const gz = compressStrong(bytes);
const back = decompress(gz); // verified; output capped at 64 MiB by default
```

## When to use this

- You need **synchronous** gzip (`Uint8Array → Uint8Array`), a **bounded decode** of untrusted input, **deterministic** output, a mid-stream `flush()`, or a runtime without `CompressionStream`.
- Async streaming of trusted data: the built-in `CompressionStream("gzip")` is fine.
- Node-only code that can use native: `node:zlib` is faster.
- A browser `fetch` with `Content-Encoding: gzip` is already decoded — don't gunzip it again. Precompress static assets at build time with native tools.
- zstd: sibling package [wzstd](https://github.com/danieljohnsxd/wzstd). Image uploads (resize / re-encode): sibling package [wimgs](https://github.com/danieljohnsxd/wimgs).

An agent skill with the same guidance ships in the package: [`skills/gzip/SKILL.md`](skills/gzip/SKILL.md).

## Design choices

- **Two named tiers, no levels.** Fast ≈ zlib L1, Strong ≈ zlib L9 (measured ratios below). Nothing in between earned a place.
- **Safe by default.** Decode caps output at 64 MiB (`maxSize`; `Infinity` opts out), verifies CRC32 + ISIZE, and never lets header fields (ISIZE, FNAME, FCOMMENT) drive large allocations or unbounded work. Limits are fixed internally, not knobs.
- **Strict, matching `node:zlib`.** Anything zlib rejects — bad header CRC, trailing garbage, stored blocks with bad NLEN, over-subscribed or incomplete Huffman codes — wgzip rejects too, on every entry point, so a proxy and an origin agree on what a valid stream is.
- **Deterministic output.** MTIME 0, no OS-specific fields, fixed matcher: same input, same bytes, every runtime.

## Why not `CompressionStream("gzip")`?

The platform streams are the right default when they fit. Reach for wgzip when one of these matters:

| Need                                               | Platform streams        | wgzip                                                      |
| -------------------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| Synchronous one-shot `Uint8Array → Uint8Array`     | No — async, stream-only | `compressFast` / `compressStrong` / `decompress`           |
| Refuse a decompression bomb before it expands      | No size cap             | `maxSize` (default 64 MiB) — throws `OutputTooLarge`       |
| Choose ratio vs speed                              | No control              | Fast tier ≈ zlib L1, Strong tier ≈ zlib L9                 |
| Deterministic bytes (same input → same output)     | Runtime-dependent       | Yes — mtime 0, no OS-specific header fields, fixed matcher |
| Runtimes / sandboxes without `CompressionStream`   | Unavailable             | Only needs typed arrays                                    |
| Force a block boundary mid-stream (logs, SSE, RPC) | No                      | `flush()` on the push encoders (Z_SYNC_FLUSH equivalent)   |
| Decode into a caller-owned buffer                  | No                      | `decompress(gz, { out })`                                  |
| Skip trailer verification for speed, explicitly    | No                      | `{ checksum: false }` — never a silent default             |

If you are on Node and can take a native dependency, `node:zlib` is faster than any pure-JS codec (see [Benchmarks](#benchmarks)). wgzip is for when you can't, or when you want the same bytes everywhere.

## Why not fflate?

fflate is excellent and wgzip's DEFLATE core descends from it (MIT, Arjun Barrett). Two measured differences:

**1. fflate's sync `gunzipSync` never verifies the GZIP trailer.** Flip one CRC32 or ISIZE byte on a valid member:

| Decoder                          | CRC32 checked | ISIZE checked | Corrupt trailer →                          |
| -------------------------------- | ------------- | ------------- | ------------------------------------------ |
| **wgzip** `decompress` (default) | **Yes**       | **Yes**       | throws `ChecksumMismatch` / `SizeMismatch` |
| wgzip `{ checksum: false }`      | No            | No            | returns payload (explicit opt-out)         |
| **node:zlib** `gunzipSync`       | Yes           | Yes           | `Z_DATA_ERROR`                             |
| **fflate** `gunzipSync`          | **No**        | **No**        | **returns payload**                        |

fflate writes the trailer on compress, but its sync decoder only strips it and uses ISIZE as a buffer-size hint. If the bytes came over a network, that check is the whole point of GZIP's trailer.

**2. Bounded decode.** fflate has no output cap either. wgzip's `maxSize` is enforced inside the inflate loop, so a 65 KB member that claims to expand to 64 MiB throws before the allocation happens, not after.

On speed, wgzip's non-verifying decode is at or slightly ahead of fflate on both corpora, and the verifying (default) decode pays for CRC32 on top — numbers below. Encode: Fast ≈ fflate L1, Strong ≈ fflate L9 (often byte-identical output on Silesia).

## API

Every direction has three shapes. Encode has two tiers; decode has one entry that reads anything RFC 1952.

|                   | One-shot         | Push (`push(chunk, final?)`)      | `TransformStream`        |
| ----------------- | ---------------- | --------------------------------- | ------------------------ |
| **Encode Fast**   | `compressFast`   | `CompressFast` — also `flush()`   | `compressFastStream()`   |
| **Encode Strong** | `compressStrong` | `CompressStrong` — also `flush()` | `compressStrongStream()` |
| **Decode**        | `decompress`     | `Decompress`                      | `decompressStream()`     |

Subpath entries keep the tiers physically separate; import only what you ship:

```ts
import {
	compressFast,
	CompressFast,
	compressFastStream,
} from "wgzip/compressFast";
import {
	compressStrong,
	CompressStrong,
	compressStrongStream,
} from "wgzip/compressStrong";
import {
	decompress,
	Decompress,
	GzipError,
	GzipErrorCode,
} from "wgzip/decompress";
// decompressStream is barrel-only (needs the host TransformStream)
import { decompressStream } from "wgzip";
```

### One-shot

```ts
const gz = compressFast(data); // XFL = 4 (fastest)
const gz2 = compressStrong(data); // XFL = 2 (maximum)
const plain = decompress(gz, { maxSize: 32 * 1024 * 1024 }); // tighter than the 64 MiB default
```

`decompress` accepts one or more concatenated members and returns them joined.

### Push

```ts
const enc = new CompressFast((chunk, final) => sink(chunk));
enc.push(part1);
enc.push(part2);
enc.flush(); // byte-aligned sync flush; everything so far is decodable
enc.push(new Uint8Array(0), true); // last block + trailer

const dec = new Decompress((chunk, final) => sink(chunk), { maxSize: 1 << 30 });
dec.push(gzChunk);
dec.push(new Uint8Array(0), true); // truncated input errors here instead of hanging
```

`flush()` emits the buffered input as a DEFLATE block followed by an empty stored block (the standard `Z_SYNC_FLUSH` marker). The match window survives a flush; the member continues. Calling `push` or `flush` after `final` throws `TypeError` on both encoder and decoder.

### Streams

```ts
file.stream().pipeThrough(compressStrongStream());
response.body!.pipeThrough(decompressStream({ maxSize: 256 * 1024 * 1024 }));
```

`TransformStream` is referenced lazily inside the factories, so importing the barrel works where the host API is absent. wgzip never `extends` it.

### Decode options

```ts
type GzipDecodeOptions = {
	/** Cap on TOTAL decompressed bytes (all members). Default 64 MiB; Infinity opts out. */
	maxSize?: number;
	/** Verify CRC32 + ISIZE per member. Default true. Only an explicit false skips. */
	checksum?: boolean;
	/** One-shot only: decode into this buffer. Single member; never truncates. */
	out?: Uint8Array;
};
```

- **`maxSize` defaults to 64 MiB** (`64 * 1024 * 1024`) on every decode entry. A 65 KB member can legally expand to 64 MiB (DEFLATE's ratio ceiling is ~1032:1) and a decoder cannot know before inflating, so the cap is on unless you pass `maxSize: Infinity` (only for data you produced). With `{ out }` and no `maxSize`, `out.length` is the cap. `maxSize` must be `Infinity` or a non-negative safe integer; anything else (`NaN`, `-1`, `1.5`, `"10"`) throws `TypeError` at call time.
- `{ out }`: the member must fit exactly or with room to spare; undersized `out` throws `SizeMismatch` (never truncates). Same buffer identity is returned when sizes match exactly, otherwise a subarray view.
- `{ checksum: false }` skips the trailer check and the optional header CRC (FHCRC). It never disables `maxSize`, other header validation, or the trailing-garbage rule.

### Errors

Every data error is a `GzipError` with a numeric `code`. Programmer errors (push after final, bad option types or values) are `TypeError`.

```ts
import { decompress, GzipError, GzipErrorCode } from "wgzip";

try {
	decompress(untrusted, { maxSize: 8 << 20 });
} catch (e) {
	if (e instanceof GzipError && e.code === GzipErrorCode.OutputTooLarge) {
		return new Response("payload too large", { status: 413 });
	}
	throw e;
}
```

| Code                   | Value | Raised when                                                                              |
| ---------------------- | ----: | ---------------------------------------------------------------------------------------- |
| `UnexpectedEOF`        |     0 | Input ends inside a header, block, or trailer                                            |
| `InvalidBlockType`     |     1 | DEFLATE block type 3, or stored block with NLEN ≠ ~LEN                                   |
| `InvalidLengthLiteral` |     2 | Undecodable length/literal symbol, or invalid code-length / literal code set             |
| `InvalidDistance`      |     3 | Distance before the start of output, or invalid distance code set                        |
| `InvalidHeader`        |     6 | Bad magic / CM, reserved FLG bits, header CRC, FNAME+FCOMMENT > 64 KiB, trailing garbage |
| `ChecksumMismatch`     |    15 | CRC32 trailer mismatch                                                                   |
| `SizeMismatch`         |    16 | ISIZE trailer mismatch, or `out` too small                                               |
| `OutputTooLarge`       |    17 | Decompressed size would exceed `maxSize`                                                 |

Codes 0–6 match fflate's numbering; 15–17 are wgzip's own (fflate has no trailer or limit checks). `err.name === "GzipError"` and `instanceof GzipError` are stable across the minified build; `err.constructor.name` is not.

## Limits and threat model

wgzip's parser is **strict, matching `node:zlib`**. Where fflate is more lenient, wgzip follows node, so a proxy and origin using wgzip and zlib agree on what is a valid stream.

| Input                                           | wgzip                                            | node:zlib | fflate           |
| ----------------------------------------------- | ------------------------------------------------ | --------- | ---------------- |
| Reserved FLG bits (0xE0) set                    | `InvalidHeader`                                  | rejects   | accepts          |
| Bytes after the last member that aren't `1f 8b` | `InvalidHeader` (all entry points)               | rejects   | ignores          |
| Concatenated members                            | joined                                           | joined    | first only       |
| Truncated member                                | `UnexpectedEOF`                                  | rejects   | rejects          |
| Corrupt CRC32 / ISIZE                           | throws (unless `checksum:false`)                 | rejects   | **accepts**      |
| Output larger than `maxSize`                    | `OutputTooLarge`, before expansion               | no cap    | no cap           |
| FHCRC header CRC16 mismatch                     | `InvalidHeader` (unless `checksum:false`)        | rejects   | accepts          |
| Stored block with NLEN ≠ ~LEN                   | `InvalidBlockType`                               | rejects   | accepts          |
| Over-subscribed / incomplete Huffman code set   | rejected (zlib's lone-1-bit-code exception kept) | rejects   | accepts          |
| Fixed-code symbols 286/287, distances 30/31     | rejected                                         | rejects   | 286/287 accepted |
| FNAME + FCOMMENT over 64 KiB                    | `InvalidHeader`                                  | accepts   | accepts          |

Other things to know:

- **ISIZE is mod 2³²** per RFC 1952. Members over 4 GiB verify their size modulo 2³²; use `maxSize` if that matters to you.
- **Header cap (the one deviation from zlib)**: FNAME + FCOMMENT together may not exceed 64 KiB. zlib scans them without limit; wgzip refuses, because an unterminated name never produces output and so `maxSize` would never stop it. 64 KiB matches FEXTRA's own 16-bit bound.
- **Memory**: one-shot decode preallocates from ISIZE, capped by `maxSize` and by 1032× the input (DEFLATE's ceiling), and grows from there; multi-member decode is linear in total input. The push decoder holds a 32 KiB window plus at most one input chunk, parses headers incrementally, and copies stored blocks as they arrive, so byte-by-byte input stays linear. Encoders hold a 32 KiB window plus the current block.
- **Not covered**: the zlib (RFC 1950) wrapper, preset dictionaries, ZIP containers. Encode is a single member per instance.
- Header is deterministic: MTIME 0, OS 3, no FNAME/FEXTRA/FCOMMENT.

## Benchmarks

From [`docs/bench_ledger.md`](docs/bench_ledger.md), 2026-08-13 snapshot, single developer machine, Node 24. **Treat as relative ranking, not portable absolutes** — re-run `pnpm bench:encode` / `pnpm bench:decode` on your own box. Synthetic and Silesia are reported separately, never pooled. Every wgzip frame is decoded by **node:zlib and fflate** and compared byte-for-byte before a timing row counts.

**Encode — Silesia subset** (dickens, xml, osdb, x-ray; ratio on whole files)

| encoder          | Σraw/Σout | med MB/s |
| ---------------- | --------: | -------: |
| **wgzip Fast**   |     2.192 |     66.7 |
| fflate L1        |     2.193 |     67.1 |
| **wgzip Strong** |     2.367 |     52.5 |
| fflate L9        |     2.367 |     54.3 |
| node L9 (native) |     2.365 |     83.7 |

**Decode — median MB/s of output** (Strong frames)

| decoder                         | synthetic | Silesia |
| ------------------------------- | --------: | ------: |
| **wgzip** (verifying, default)  |       438 |     273 |
| **wgzip** `{ checksum: false }` |       615 |     337 |
| fflate (never verifies)         |       544 |     267 |
| node gunzip (native, verifies)  |      1773 |     594 |

The like-for-like pure-JS comparison is `checksum:false` vs fflate — both skip trailer work. The product number is the verifying row.

## Correctness

- Every benchmarked frame round-trips through node:zlib **and** fflate before its timing is accepted; `tests/cross_gunzip_test.ts` pins the same on a synthetic set plus Silesia prefixes.
- Tests sweep push chunk sizes 1 … 64 KiB, block seams, scratch-buffer aliasing (emitted slices survive later window writes), `{ out }` sizing, forged trailers, forged ISIZE, reserved header bits, trailing garbage (asserted against node's verdict), multi-member scaling, and `maxSize` on all three decode entries.
- `tests/zlib_parity_test.ts` crafts streams for every zlib rejection rule above and runs a seeded mutation sweep (4000 variants) against `inflateRawSync`: same verdict, same bytes, same bytes consumed. Decoder DoS regressions live in `tests/hardening_test.ts`.
- Strict TypeScript + type-aware oxlint; `src/**` bans host globals so the library stays runtime-neutral.
- CI runs the suite on Node 22 / 24 and a smoke round-trip on Deno and Bun. Releases publish with npm provenance.

## Development

```bash
pnpm install
pnpm check            # fmt + lint + tsc --noEmit
pnpm test             # build, then node --test
pnpm bench:encode     # synthetic + Silesia; fflate L1/L6/L9 + node L1/L6/L9
pnpm bench:decode
pnpm bench:check      # perf regression checks (generous ratio thresholds)
```

Maintainer notes: [`HANDOFF.md`](HANDOFF.md). Standing scores and their history: [`docs/bench_ledger.md`](docs/bench_ledger.md).

## License

MIT. DEFLATE core adapted from [fflate](https://github.com/101arrowz/fflate) (MIT, Arjun Barrett). Dynamic Huffman construction shares its two-queue length-limited design with [wzstd](https://github.com/danieljohnsxd/wzstd).
