# HANDOFF

Current product orientation for maintainers. Absolute MB/s claims are
**not** portable across machines — re-run benches. Standing numbers and deeper
history live in [`docs/bench_ledger.md`](docs/bench_ledger.md).

## Product surface

Every direction has a one-shot function, a push class (`push(chunk, final?)`),
and a `TransformStream` factory. Encode factories live on the tier entries;
`decompressStream` is barrel-only (lazy host API).

| Export                                        | Role                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `compressFast`                                | One-shot Fast (nice 8, chain 4, hashBits 18, XFL=4)                                                |
| `CompressFast` / `compressFastStream`         | Streaming Fast — push + `TransformStream`; 32 KiB input blocks                                     |
| `compressStrong`                              | One-shot Strong (nice 258, chain 1024, hashBits 18, XFL=2)                                         |
| `CompressStrong` / `compressStrongStream`     | Streaming Strong — push + `TransformStream`; same block size                                       |
| `decompress`                                  | One-shot GZIP; multi-member joined; **CRC32 + ISIZE verified by default**; `{ maxSize }` cap       |
| `Decompress` / `decompressStream`             | Streaming decode — push + `TransformStream`; same checksum default and `maxSize`                   |
| `CompressFast#flush` / `CompressStrong#flush` | Sync flush: buffered input as a block + empty stored block (Z_SYNC_FLUSH marker); member continues |

No level parameter, no combined multi-level `compress`. ES2022 ESM only; pure
typed arrays. `*WithConfig` / `*_CONFIG` are **not** exported from the
product entries — bench/experiment scripts reach them through the `internal`
build entry, which is deliberately absent from `package.json#exports`.

## Decode posture (decided 2026-08-27)

Strict, **matching `node:zlib`**, identical on one-shot / `{ out }` / push /
`TransformStream`:

- Reserved FLG bits (0xE0) → `InvalidHeader`.
- Bytes after the last member that are not `1f 8b` → `InvalidHeader`
  ("trailing garbage"). No lenient path.
- Concatenated members joined; truncated member → `UnexpectedEOF`.
- `maxSize` caps **total** decompressed bytes across members and is enforced
  inside `inflateRaw` (a 64 KiB chunk can expand to 64 MiB); exceeding it →
  `OutputTooLarge` (17) before the expansion is allocated. **Default 64 MiB**
  (family convention, same as wzstd); `Infinity` opts out; with `{ out }` and
  no `maxSize`, `out.length` is the cap. Validated at call time (non-negative
  safe integer or `Infinity`, else `TypeError`; also `checksum` must be a
  boolean, `out` a `Uint8Array`). ISIZE prealloc is
  `min(ISIZE, maxSize, 1032 × deflate bytes)`.
- DEFLATE parity with zlib's `inflate_table` / `inflate.c`: stored NLEN
  checked; over-subscribed / incomplete code sets rejected (lone 1-bit
  lit/len or distance code allowed, never for the code-length code); bad
  repeats, HLIT > 286, HDIST > 30, missing EOB, fixed 286/287 and dist 30/31,
  and an empty DEFLATE body all rejected. FHCRC is verified (skipped with
  `checksum: false`, like zlib's `inflateValidate`). Pinned by
  `tests/zlib_parity_test.ts` (crafted cases + seeded mutation sweep vs
  `inflateRawSync`). The one deliberate deviation: FNAME + FCOMMENT capped at
  64 KiB (`HEADER_TEXT_MAX` in `src/gzip.ts`).
- Streaming headers parse incrementally (`GzipHeaderParser`, O(1) state);
  stored blocks stream via `st.s` (bytes left). Both were quadratic under
  byte-wise pushes. Regressions: `tests/hardening_test.ts`.
- Dynamic Huffman decode uses a 10-bit root LUT + 32-entry subtables
  (`hDecode`, `ROOT_BITS` in `src/tables.ts`), reused per state. A flat
  15-bit LUT made tiny 15-bit-code blocks ~20× slower than zlib. Subtables,
  not a canonical slow path: the slow path cost ~15% on Silesia. Keep the
  `inflateRaw` hot variables out of closures (a closure writing `bt` cost
  ~25% decode speed).
- `{ checksum: false }` skips only the trailer check — never the cap, the
  header rules, or the trailing-garbage rule.
- Push-after-final is a `TypeError` on both encoder and decoder.

Why strict: a proxy/origin pair using wgzip and zlib must agree on what a valid
member is (parser differentials are how decoders get exploited), and fflate's
leniency is not a spec. This is documented in the README "Limits and threat
model" table — keep that table and `tests/strict_test.ts` in lockstep.

Decode allocation rules: one-shot copies the input into a padded buffer
**once** per call (not per member — the old walker was O(members²));
initial inflate output is bounded, then grows. A view is never returned over
a buffer much larger than the payload (forged ISIZE with `checksum:false`). DEFLATE/GZIP inspired by fflate; dynamic Huffman tree build is
wzstd-style (two-queue + freq-halving), **not** ZSTD framing.

## Peer GZIP trailer checks (measured)

Who verifies the 8-byte GZIP trailer (CRC32 + ISIZE) by default?

| Decoder                                                      | CRC32             | ISIZE             | Skip?                      |
| ------------------------------------------------------------ | ----------------- | ----------------- | -------------------------- |
| **wgzip** (`decompress` / `Decompress` / `decompressStream`) | **Yes** (default) | **Yes** (default) | Only `{ checksum: false }` |
| **node:zlib** `gunzipSync`                                   | **Yes**           | **Yes**           | No public one-shot opt-out |
| **fflate** `gunzipSync`                                      | **No**            | **No**            | N/A — never checks         |

**Evidence (2026-08-10):** flip one CRC trailer byte or one ISIZE byte on a valid
member:

- wgzip default → `ChecksumMismatch` / `SizeMismatch`
- wgzip `{ checksum: false }` → returns inflated bytes anyway
- `node:zlib.gunzipSync` → `Z_DATA_ERROR` (`incorrect data check` / `incorrect length check`)
- `fflate.gunzipSync` → **succeeds** (returns payload)

fflate still **writes** CRC/ISIZE on compress; its sync gunzip only strips the
trailer and uses ISIZE as an output size **hint** (`inflt(..., new u8(gzl(data)))`),
without recomputing CRC or comparing length.

### How to quote decode speed

| Label        | What it measures                   | Use for                                                  |
| ------------ | ---------------------------------- | -------------------------------------------------------- |
| **wgzip**    | Verifying decode (product default) | Product claims, vs-node fairness on the _check_ axis     |
| **wgzip nv** | `checksum: false`                  | Like-for-like pure-JS speed vs **fflate**                |
| fflate       | Inflate only (no trailer check)    | Pure-JS peer; **not** equivalent work to verifying wgzip |
| node gunzip  | Native + verifies                  | Ceiling; verifying-vs-verifying vs wgzip                 |

**Do not** report fflate MB/s as “our decode vs fflate” without saying fflate
skips the trailer. Snapshot medians (see ledger): synthetic **wgzip 438 / nv 615 /
fflate 544**; Silesia **273 / 337 / 267**. nv is ahead of fflate on both
corpora; quote **wgzip** (verifying) as the product number.

Same product rule as wzstd content checksums: default on; only an explicit
`false` skips; never a second “fast” entry that forgets to name the skip.

## Standing tier read (2026-08-13 snapshot)

Full tables in the ledger. Headline:

|                  | Fast vs peers                                        | Strong vs peers                                         |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| **Ratio**        | ≈ **fflate L1** (hashBits 18 closed the old hole)    | ≈ **fflate L9** (often byte-identical sizes on Silesia) |
| **Encode speed** | Pure-JS band, at or slightly ahead of fflate L1      | Pure-JS band, at or slightly ahead of fflate L6/L9      |
| **vs node**      | Node much faster encode; slightly better ratio at L9 | Same                                                    |

Tiers are real: Fast ~1.7× Strong encode MB/s for ~18% more bytes (synthetic
weighted). Keep two exports. Fast and Strong now share hashBits 18; the split
is still chain 4 / nice 8 vs chain 1024 / nice 258.

## Interop

Every wgzip encode in `pnpm bench:encode` / `bench:decode` is checked under
**node + fflate** gunzip (full byte compare). CI: `tests/cross_gunzip_test.ts`.
Huffman/match changes must stay RFC 1951/1952 — other decoders are the oracle.
`.github/workflows/ci.yml` runs `pnpm check` + `pnpm test` on Node 22/24 and a
round-trip smoke (`scripts/smoke_runtime.ts`) on Deno and Bun; `publish.yml`
publishes with npm provenance on a GitHub release.

## Next focus (suggestions)

1. Inflate is past fflate on nv. Further symbol-loop work needs no extra
   branch; `fill` / `copyWithin` / dt tiers already rejected. The `maxSize`
   check lives on the grow path, not in the symbol loop — keep it there.
2. Streaming compress is real blocks (32 KiB input), not buffer-until-flush.
   Further hill-climb is match-across-seam and block-size, not the API.
3. ~72 KB of tables (64 KB bit-reverse + 8 KB CRC slice-by-8) are built at
   import. Lazy init would trim edge cold-start; not measured yet.

Re-run `pnpm bench:encode` and `pnpm bench:decode` after encode/decode changes;
append a new snapshot in `docs/bench_ledger.md`. `pnpm bench:check` holds perf
regression checks (ratio thresholds vs a same-run reference); `pnpm test` is
correctness only, plus DoS regressions asserted on bounded work.
