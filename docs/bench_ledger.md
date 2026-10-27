# Bench ledger

Standing scores and the insights that follow from them. Re-run benches after
any encode/decode change and update the dated section — do not compare absolute
MB/s across machines or cold/hot process state without saying so.

## How to reproduce

```bash
pnpm build
pnpm bench:encode              # synthetic + Silesia; fflate L1/L6/L9 + node L1/L6/L9
pnpm bench:decode              # Strong frames; wgzip / wgzip nv / node / fflate
pnpm bench:encode --silesia-only
pnpm bench:encode --synthetic-only --limit 10
```

| Flag                                  | Meaning                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| (default)                             | Both corpora, reported **separately** (never pooled)                         |
| `--silesia-only` / `--synthetic-only` | One corpus                                                                   |
| `--limit N`                           | First N payloads **per corpus**                                              |
| `--cap BYTES`                         | Throughput prefix (default **4 MiB**). **Ratio always uses the whole file.** |

**Encoders timed:** `wgzip Fast`, `wgzip Strong`, `fflate` L1/L6/L9, `node:zlib` gzip L1/L6/L9.

**Decoders timed:** `wgzip` (CRC on), `wgzip nv` (`checksum: false`), `node gunzip`, `fflate gunzip`.

**Interop gate (encode + decode harnesses):** every **wgzip** frame is fully
decompressed with **node:zlib** and **fflate** and compared byte-for-byte to the
plaintext before any timing row is accepted. CI also pins a focused synthetic set
plus Silesia 1 MiB prefixes in `tests/cross_gunzip_test.ts`.

### Corpora

| Corpus                | Source                                                                             | Size (this machine)       |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| **In-repo synthetic** | `tests/helpers/corpus.ts` → `benchPayloads()` (same generators as wzstd)           | **78 payloads / ~141 MB** |
| **Silesia subset**    | `bench-data/silesia/` via `scripts/helpers/silesia.ts` (dickens, xml, osdb, x-ray) | **4 files / ~34 MB**      |

Silesia provenance: Deorowicz, Silesian University of Technology —
https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia

---

---

## Snapshot — 2026-10-27 (decode, hardening pass)

Full `pnpm bench:decode`, same session, baseline build vs this change. The
hardening (zlib-parity checks, incremental header, streamed stored blocks,
10-bit root LUT + subtables) left the hot path where it was:

| decoder      | synthetic before | after | Silesia before | after |
| ------------ | ---------------: | ----: | -------------: | ----: |
| **wgzip**    |            423.8 | 427.9 |          254.6 | 260.0 |
| **wgzip nv** |            581.8 | 595.6 |          305.0 | 310.6 |

Tiny dynamic blocks declaring 15-bit codes (`pnpm bench:check`): 20× zlib →
2.6× zlib. Rejected on the way: a canonical (puff-style) slow path for codes
over the root (−15% nv on Silesia); a closure for the stored copy (−25%).

---

## Snapshot — 2026-08-27 (partial: `--synthetic-only --limit 8`, decode)

Not a full re-run. Recorded to show the decode rewrite (strict node-matching
parser, `maxSize` cap enforced in `inflateRaw`, one padded input copy per
call, bounded first allocation) did not move the hot path. Full corpora
re-run is still owed before quoting new absolutes.

| decoder      | before | after |
| ------------ | -----: | ----: |
| **wgzip**    |  404.5 | 403.6 |
| **wgzip nv** |  558.6 | 558.2 |

`zeros-100k` 464 → 610 MB/s (input no longer copied when the caller's buffer
already has 4 readable pad bytes). Multi-member walker: 40k empty members
1,948 ms → 16 ms (was O(members²) — per-member copy and 3× allocation of all
remaining input). Encode (`--limit 6`): compressed sizes byte-identical
before/after `flush()`; MB/s within noise (Fast 85 → 92, Strong 75 → 87).

## Snapshot — 2026-08-13

Machine: local macOS (developer workstation). Single-process wall clock;
not isolate-per-encoder. Treat MB/s as **relative ranking**, not product claims
across boxes. Peers (fflate / node) held within a few percent of the 2026-08-10
snapshot, so the wgzip deltas below are not a colder/hotter machine.

Commands:

```text
pnpm bench:encode --synthetic-only
pnpm bench:encode --silesia-only
pnpm bench:decode
```

### Encode — synthetic (78 payloads)

| encoder          | Σraw/Σout | geomean ratio |  med MB/s |
| ---------------- | --------: | ------------: | --------: |
| **wgzip Fast**   | **4.050** |     **7.308** | **113.7** |
| **wgzip Strong** | **4.910** |    **10.004** |  **68.3** |
| fflate L1        |     4.048 |         7.307 |      96.0 |
| fflate L6        |     4.892 |         9.966 |      65.4 |
| fflate L9        |     4.910 |        10.004 |      63.9 |
| node L1          |     4.280 |         7.058 |     611.2 |
| node L6          |     4.917 |        10.163 |     178.2 |
| node L9          |     4.990 |        10.340 |      77.7 |

### Encode — Silesia subset (4 files, full size for ratio)

| encoder          | Σraw/Σout | geomean ratio | med MB/s |
| ---------------- | --------: | ------------: | -------: |
| **wgzip Fast**   | **2.192** |     **2.561** | **66.7** |
| **wgzip Strong** | **2.367** |     **2.934** | **52.5** |
| fflate L1        |     2.193 |         2.563 |     67.1 |
| fflate L6        |     2.366 |         2.931 |     53.8 |
| fflate L9        |     2.367 |         2.934 |     54.3 |
| node L1          |     2.191 |         2.618 |    176.9 |
| node L6          |     2.360 |         2.965 |     93.4 |
| node L9          |     2.365 |         2.994 |     83.7 |

#### Silesia per-file ratio (and compressed size)

| file              | Fast               | Strong                 | fflate L1 | fflate L6 | fflate L9          | node L9 |
| ----------------- | ------------------ | ---------------------- | --------- | --------- | ------------------ | ------- |
| xml (5.3 MB)      | 5.420× / 986 269   | **7.594×** / 703 922   | 5.423×    | 7.561×    | 7.594× / 703 918   | 8.115×  |
| dickens (10.2 MB) | 2.281× / 4 468 113 | **2.578×** / 3 952 890 | 2.284×    | 2.576×    | 2.578× / 3 952 890 | 2.654×  |
| osdb (10.1 MB)    | 2.476× / 4 073 643 | **2.666×** / 3 783 362 | 2.474×    | 2.665×    | 2.666× / 3 783 360 | 2.753×  |
| x-ray (8.5 MB)    | 1.406× / 6 027 247 | **1.421×** / 5 965 422 | 1.407×    | 1.421×    | 1.421× / 5 965 401 | 1.354×  |

### Decode — median MB/s of **output** (Strong frames)

| decoder                | synthetic | silesia |
| ---------------------- | --------: | ------: |
| **wgzip** (CRC on)     |   **438** | **273** |
| **wgzip nv** (CRC off) |   **615** | **337** |
| fflate                 |       544 |     267 |
| node gunzip            |      1773 |     594 |

### What moved vs 2026-08-10

- **Fast hashBits 15 → 18.** Shallow chain of 4 was spending probes on 3-byte
  hash collisions. Wider table is work-removed for Fast (fewer wasted walks)
  and a small ratio win. Silesia Fast 2.183 → 2.192 Σraw/Σout, 63 → 67 med
  MB/s against a stable fflate L1 (~67). Synthetic Fast 79 → 114 med MB/s
  and now _ahead_ of fflate L1 (96). Strong sizes unchanged (byte-identical
  on the usual Silesia rows).
- **CRC-32 slice-by-8.** Isolated: ~464 → ~1023 MB/s on a 4 MiB buffer
  (node zlib still ~30 GB/s). Verifying decode 253 → 422 synthetic, 178 →
  249 Silesia. nv unchanged (578 → 581 / 299 → 298) — CRC is not on that
  path. Isolated CRC check vectors pin ISO 3309 (`""`, `"a"`, `"123456789"`)
  plus node `crc32` at every remainder 0–16.
- **Unguarded own-structure reads** in inflate / bitio / matcher (`?? 0`
  before a bitwise op is a dead nullish check; OOB already becomes 0).
- **4-byte match extension** in the matcher (word XOR, tail still byte-scan).
  Strong output byte-identical; encode speed up with peers flat.
- **Rejected:** per-match `fill` / `copyWithin` / dt-tier branches. First
  Silesia pass put nv at 227 vs fflate 272 (a real regression). Same lesson
  as wzstd: work-removed pays; per-symbol extra loops and branches do not.
- **Wide `getUint32` bit reader** after a 4-byte zero pad of the compressed
  body. `bits16` was a cross-chunk call of three byte loads; it is now a
  local unguarded word load in the decompress chunk (same OOB=0 contract).
- **ISIZE prealloc** on the one-member path. Trailer ISIZE sizes the output
  exactly, so inflate neither grows nor `slc`-copies the result. Multi-member
  and a too-small ISIZE (`{ checksum: false }` still has to return the
  payload) miss the consume check or `SizeMismatch` and fall through to the
  walker. nv 581 → 615 synthetic, 298 → 337 Silesia; verifying 422 → 438 /
  249 → 273. fflate held flat (547 → 544 / 264 → 267).
- **Streaming decode** (`Decompress` push + `decompressStream`
  `TransformStream`), same shape as wzstd: push API owns a 32 KiB match
  window, `TransformStream` is a lazy host adapter. Incomplete input does
  not pad the bitstream (zeros would decode as symbols). One-shot still
  pads + inlines `getUint32`.
- **Streaming encode** (`CompressFast` / `CompressStrong` push +
  `compressFastStream` / `compressStrongStream`). Real 32 KiB-input DEFLATE
  blocks, not buffer-until-flush. One instance is one GZIP member.

---

## Snapshot — 2026-08-10

Machine: local macOS (developer workstation). Single-process wall clock;
not isolate-per-encoder. Treat MB/s as **relative ranking**, not product claims
across boxes.

Commands:

```text
pnpm bench:encode   # cap 4 MiB, full synthetic + full Silesia
pnpm bench:decode   # same corpora, Strong frames
```

### Encode — synthetic (78 payloads)

| encoder          | Σraw/Σout | geomean ratio | med MB/s |
| ---------------- | --------: | ------------: | -------: |
| **wgzip Fast**   | **4.046** |     **7.304** | **79.4** |
| **wgzip Strong** | **4.910** |    **10.004** | **50.7** |
| fflate L1        |     4.048 |         7.307 |     98.0 |
| fflate L6        |     4.892 |         9.966 |     65.5 |
| fflate L9        |     4.910 |        10.004 |     63.3 |
| node L1          |     4.280 |         7.058 |    626.7 |
| node L6          |     4.917 |        10.163 |    176.7 |
| node L9          |     4.990 |        10.340 |     77.7 |

`Σraw/Σout` = total plaintext bytes / total compressed bytes (raw-weighted).
`geomean r` = geometric mean of per-payload ratios. `med MB/s` = median of
per-payload encode throughput (capped prefix).

### Encode — Silesia subset (4 files, full size for ratio)

| encoder          | Σraw/Σout | geomean ratio | med MB/s |
| ---------------- | --------: | ------------: | -------: |
| **wgzip Fast**   | **2.183** |     **2.551** | **63.4** |
| **wgzip Strong** | **2.367** |     **2.934** | **56.6** |
| fflate L1        |     2.193 |         2.563 |     76.3 |
| fflate L6        |     2.366 |         2.931 |     61.2 |
| fflate L9        |     2.367 |         2.934 |     62.6 |
| node L1          |     2.191 |         2.618 |    174.6 |
| node L6          |     2.360 |         2.965 |     93.2 |
| node L9          |     2.365 |         2.994 |     83.8 |

#### Silesia per-file ratio (and compressed size)

| file              | Fast               | Strong                 | fflate L1 | fflate L6 | fflate L9          | node L9 |
| ----------------- | ------------------ | ---------------------- | --------- | --------- | ------------------ | ------- |
| xml (5.3 MB)      | 5.409× / 988 176   | **7.594×** / 703 922   | 5.423×    | 7.561×    | 7.594× / 703 918   | 8.115×  |
| dickens (10.2 MB) | 2.272× / 4 485 465 | **2.578×** / 3 952 890 | 2.284×    | 2.576×    | 2.578× / 3 952 890 | 2.654×  |
| osdb (10.1 MB)    | 2.457× / 4 105 083 | **2.666×** / 3 783 362 | 2.474×    | 2.665×    | 2.666× / 3 783 360 | 2.753×  |
| x-ray (8.5 MB)    | 1.402× / 6 043 079 | **1.421×** / 5 965 422 | 1.407×    | 1.421×    | 1.421× / 5 965 401 | 1.354×  |

### Decode — median MB/s of **output** (Strong frames)

| decoder                | synthetic | silesia |
| ---------------------- | --------: | ------: |
| **wgzip** (CRC on)     |   **253** | **178** |
| **wgzip nv** (CRC off) |   **578** | **299** |
| fflate                 |       549 |     268 |
| node gunzip            |      1852 |     605 |

Silesia decode used the capped prefix for throughput (same as encode).

---

## Insights

### Product tiers (Fast / Strong)

1. **Fast ≈ fflate L1** on ratio (synthetic Σraw/Σout 4.050 vs 4.048; Silesia
   2.192 vs 2.193). Encode speed is in the same pure-JS band and is now at or
   slightly _ahead_ of fflate L1 on both corpora (synthetic 114 vs 96; Silesia
   67 vs 67). The old ~20% hole was hashBits 15 colliding the chain-4 walk.
2. **Strong ≈ fflate L9** on ratio — synthetic weighted and geomean match fflate
   L9 to three decimals (4.910 / 10.004). On Silesia, Strong and fflate L9 sizes
   are often **byte-identical** (dickens 3 952 890; xml/osdb within a few bytes).
3. **Strong is not node L9.** Node still wins a little ratio on synthetic
   (4.990 vs 4.910) and on xml/dickens; pure-JS match-finding has no lazy parse
   and a 32 KiB window, so that gap is expected.
4. **Tiers are real:** Fast is ~1.7× Strong encode speed on synthetic medians
   (114 vs 68 MB/s) for ~18% more compressed bytes (4.05 vs 4.91 weighted). Keep
   them as separate exports — no level knob. They now share hashBits 18; the
   split is chain / nice, not table width.

### Huffman / DEFLATE (wzstd-inspired, format-safe)

5. **Tree build** is two-queue + frequency-halving (wzstd _construction_), not
   ZSTD weights/reverse bitstreams. DEFLATE still emits RFC 1951 dynamic blocks
   via `lc` / `hMap` / clim.
6. **Universal decompressibility held** after that rewrite: full synthetic +
   Silesia encode suite opened under node and fflate with full byte compare. Do
   not port ZSTD framing ideas into the bitstream.
7. Strong matching fflate L9 sizes is evidence the **match finder + block packing**
   still dominate ratio; Huffman rewrite did not change the product tier story.

### Decode / checksum (peer behavior)

Who verifies the GZIP trailer (CRC32 + ISIZE) by default? Measured 2026-08-10
(flip one trailer byte on a valid member):

| Decoder                    | CRC32   | ISIZE   | Skip?                      | Bad trailer                                                        |
| -------------------------- | ------- | ------- | -------------------------- | ------------------------------------------------------------------ |
| **wgzip** `decompress`     | **Yes** | **Yes** | `{ checksum: false }` only | throws `ChecksumMismatch` / `SizeMismatch`                         |
| **node:zlib** `gunzipSync` | **Yes** | **Yes** | no public one-shot opt-out | `Z_DATA_ERROR` (`incorrect data check` / `incorrect length check`) |
| **fflate** `gunzipSync`    | **No**  | **No**  | never checks               | still returns inflated payload                                     |

fflate **writes** CRC/ISIZE on compress; sync gunzip only strips the 8-byte
trailer and uses ISIZE as an output buffer **hint** — it does not recompute CRC
or compare length. So timed **fflate** decode is inflate-only work.

8. **CRC was ~2× of decode** on the 2026-08-10 medians (synthetic 253 vs 578).
   Slice-by-8 plus the inflate leftovers cut that: verifying is now 438 vs
   nv 615 synthetic, 273 vs 337 Silesia. The check is still default-on
   product policy. Quote **wgzip** (verifying) as the product number.
9. **wgzip nv** is the fair pure-JS speed peer to **fflate** (both skip trailer
   work). On this snapshot: synthetic nv 615 vs fflate 544; Silesia nv 337 vs 267. Do not call verifying wgzip “slower than fflate” without naming the
   extra check.
10. **node gunzip** also verifies (same check axis as product wgzip) and remains
    the throughput ceiling (~3–7× pure JS). Native code, not a pure-TS fairness
    target.
11. Same rule as wzstd content checksums: never add a silent “fast” decode entry
    that skips verification without spelling `checksum: false`.

### Corpus discipline

12. **Never pool synthetic + Silesia** into one median. Synthetic is compressible
    generators; Silesia is real multi-MB files with different match structure
    (especially x-ray). A pooled number lies about both.
13. Tiny payloads (`tiny-ok`, short lorem) pollute **MB/s** medians if over-weighted;
    they stay for correctness. Prefer `Σraw/Σout` and geomean for ratio claims;
    for speed claims, prefer mid/large rows or know that medians include noise.
14. **Incompressible rows** (`random-*`, `farecho-*`, `longrange-*` ~1.0 ratio)
    are load-bearing honesty checks: they keep “ratio” from being only easy text.

### Interop / correctness ledger (non-score)

15. Stored blocks never emit LEN > 65535 (latent fflate-class bug closed).
16. `{ out }` never silently truncates; multi-member + `out` rejects.
17. Empty input EOB frequency no longer double-counted.
18. GZIP header is deterministic (mtime 0); XFL = 4 Fast / 2 Strong.

### Open / next levers (not yet measured as adopted)

| Idea                                              | Why it might matter                                                     | Caution                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Inflate work-removed (no extra per-symbol branch) | nv is ahead of fflate on one-shot; streaming uses a guarded 3-byte path | `fill`/`copyWithin`/dt tiers already rejected    |
| Fast hashBits 19–20                               | fflate uses ~20 on multi-MB files                                       | 18 already matches L1; watch small-payload alloc |
| Lazy match / chain decay on Strong                | Node L9 ratio left on table                                             | Must stay gunzip-universal                       |
| Streaming encode block size / seam matches        | 32 KiB blocks ship; further ratio vs one-shot is a hill-climb           | Must stay gunzip-universal                       |
| Isolate-per-encoder benches                       | Cleaner MB/s, wzstd-style                                               | Only when peer claims get noisy                  |

---

## How to update this file

After a meaningful change:

1. `pnpm test` (includes cross-gunzip).
2. `pnpm bench:encode` and `pnpm bench:decode` on a quiet machine if claiming speed.
3. Add a new **Snapshot — YYYY-MM-DD** section (or replace this one if the corpus
   harness changed in a way that invalidates old absolute MB/s).
4. Keep **Insights** as durable lessons; put ephemeral “this PR won 3%” under the
   snapshot, not as eternal truth.

Do **not** re-compare MB/s from this snapshot to a future machine without
re-running both sides the same day.
