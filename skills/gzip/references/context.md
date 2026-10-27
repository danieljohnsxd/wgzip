# wgzip: context and rationale

Background for the rules in `../SKILL.md`. Sources are the repo's own records
(`README.md`, `HANDOFF.md`, `docs/bench_ledger.md`, `tests/`) unless stated.

## Platform facts

- `CompressionStream` / `DecompressionStream` support `gzip`, `deflate` and
  `deflate-raw`, but are async and stream-only, have no output cap, and their
  bytes are runtime-dependent. That gap (sync one-shot, bounded decode,
  deterministic output, sync flush, caller-owned output buffer) is why wgzip
  exists.
- `node:zlib` is native: about 1.6x wgzip's encode speed at level 9 and 2-4x
  its decode speed (ledger snapshot, one machine; relative ranking only).
- DEFLATE's expansion ceiling is ~1032:1 (a 258-byte match in 2 bits), so a
  65 KB member can legally expand to 64 MiB. A decoder cannot know the real
  size before inflating; ISIZE in the trailer is attacker-controlled and only
  mod 2^32.

## Why two tiers, not levels

The API names the job instead of exposing zlib's 1-9 ladder. Measured
(Silesia subset, Σraw/Σout): Fast 2.192 (fflate L1 2.193), Strong 2.367
(fflate L9 2.367; node L9 2.365). Fast encodes ~1.7x faster than Strong for
~18% more bytes on the synthetic corpus, so both earn a place; nothing in
between does. Fast = hash chain 4, nice 8; Strong = chain 1024, nice 258;
both 18-bit hash. Output is deterministic (MTIME 0, OS 3, XFL 4/2).

## Decode posture: strict, matching node:zlib

A proxy and an origin must agree on what a valid stream is; parser
differentials are how decoders get exploited. So wgzip rejects what zlib
rejects, on every entry point (one-shot, `{ out }`, push, stream):

- reserved FLG bits, bad magic/CM, FHCRC mismatch (skipped only with
  `checksum: false`, as zlib's `inflateValidate(strm, 0)` does);
- bytes after the last member that are not another member;
- stored blocks whose NLEN is not ~LEN;
- Huffman code sets that zlib's `inflate_table` rejects: over-subscribed, or
  incomplete except a lone 1-bit literal/length or distance code (never for
  the code-length code); a repeat code with nothing to repeat or running past
  HLIT+HDIST; HLIT > 286 or HDIST > 30; a missing end-of-block code; fixed
  symbols 286/287 and distances 30/31;
- an empty DEFLATE body.

`tests/zlib_parity_test.ts` checks crafted streams for each rule and runs a
seeded 4000-variant mutation sweep against `inflateRawSync`; a one-off
300k-variant run plus 75k header mutations found no disagreement.

Known deviation: FNAME + FCOMMENT together are capped at 64 KiB
(`InvalidHeader`). zlib has no cap (it copies at most the caller's buffer and
skips the rest), but wgzip has no caller buffer to bound it, and an
unterminated name never produces output, so `maxSize` would never fire.
64 KiB equals FEXTRA's own 16-bit bound and is 16x Linux PATH_MAX.

fflate, the ancestor of the DEFLATE core, is lenient on all of the above and
never verifies the trailer (flip a CRC byte: `gunzipSync` returns the
payload). That leniency is not a spec.

## Safety defaults

- `maxSize` defaults to 64 MiB (family-wide, same name and number in wzstd),
  enforced inside the inflate loop before each grow, across all members.
  `Infinity` opts out. Validated: non-negative safe integer or `Infinity`.
- ISIZE never drives allocation beyond `min(ISIZE, maxSize, 1032 x input)`.
- Header bytes are parsed incrementally with O(1) state, and stored blocks are
  copied as they arrive, so byte-by-byte pushes stay linear (they were
  quadratic: ~2 GB of copying for one 64 KiB stored block).
- Dynamic Huffman tables use a 10-bit root LUT with 32-entry subtables for
  longer codes (zlib uses a 9-bit root). A flat 15-bit table cost 32768 writes
  per block, so ~23-byte blocks declaring 15-bit codes decoded ~20x slower
  than zlib; now ~2.6x. Honest-data decode speed is unchanged.

## Decode speed

Ledger medians (MB/s of output, Strong frames): synthetic wgzip 438 /
`checksum:false` 615 / fflate 544 / node 1773; Silesia 273 / 337 / 267 / 594.
The like-for-like pure-JS comparison is `checksum: false` vs fflate (both skip
the trailer); the product number is the verifying one.

## Rejected / not done

- A level knob, a combined `compress(level)`: tiers cover the useful range.
- A lenient decode mode: would reintroduce the parser differential.
- New options for header or table limits: fixed internal limits instead.
- zlib (RFC 1950) wrapper, preset dictionaries, ZIP: out of scope.
