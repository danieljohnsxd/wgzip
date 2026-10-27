# Extra bench corpus (opt-in)

Put any files here for ad-hoc encode/decode experiments. Payloads are
**gitignored**; an empty directory is normal on a fresh clone.

Default benches use the pinned Silesia subset under `bench-data/silesia/`
(see `scripts/helpers/silesia.ts`). This directory is only for your own
optional data — not loaded automatically.

```bash
pnpm bench:encode
pnpm bench:decode
# Optional: pass a single file path into a one-off node script if needed.
```
