/**
 * Perf regression checks with generous thresholds. Not part of `pnpm test`
 * (correctness only, no timing); run on a quiet machine:
 *
 * ```
 *   pnpm bench:check
 * ```
 *
 * Exits non-zero if a check fails. Thresholds are ratios against a
 * same-run reference, so they hold across machines.
 */
import { gunzipSync } from "node:zlib";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { decompress } from "../dist/decompress.js";
import {
	Bits,
	CL_ALL,
	canonical,
	type ClSym,
	dynHeader,
	gzipWrap,
} from "../tests/helpers/craft.ts";

type Check = { name: string; run: () => { ok: boolean; detail: string } };

function best(fn: () => void, reps = 5): number {
	let min = Infinity;
	for (let i = 0; i < reps; i++) {
		const t = performance.now();
		fn();
		min = Math.min(min, performance.now() - t);
	}
	return min;
}

function concatN(member: Uint8Array, n: number): Uint8Array {
	const out = new Uint8Array(member.length * n);
	for (let i = 0; i < n; i++) out.set(member, i * member.length);
	return out;
}

/**
 * ~23-byte dynamic blocks that each declare a 15-bit literal code. A flat
 * 15-bit decode LUT made this ~20x slower than zlib; the 10-bit root LUT
 * keeps it within a small factor.
 */
function tinyDynamicBlocks(n: number): Uint8Array {
	const lit = Array.from<number>({ length: 257 }).fill(0);
	for (let i = 0; i < 14; i++) lit[i] = i + 1;
	lit[14] = 15;
	lit[256] = 15;
	const seq: Array<ClSym> = [];
	for (let i = 0; i < 15; i++) seq.push([lit[i] ?? 0]);
	seq.push([18, 127], [18, 92], [15], [0]);
	const eob = canonical(lit)[256] ?? 0;
	const w = new Bits();
	for (let b = 0; b < n; b++) {
		dynHeader(w, b === n - 1, 257, 1, CL_ALL, seq);
		w.code(eob, 15);
	}
	return gzipWrap(w.done(), new Uint8Array(0));
}

const checks: Array<Check> = [
	{
		name: "Strong is not larger than Fast on repetitive text",
		run: () => {
			const data = new TextEncoder().encode(
				"the quick brown fox jumps over the lazy dog\n".repeat(100),
			);
			const fast = compressFast(data).length;
			const strong = compressStrong(data).length;
			return {
				ok: strong <= fast * 1.05,
				detail: `strong ${strong} B, fast ${fast} B (limit 1.05x)`,
			};
		},
	},
	{
		name: "multi-member decode is linear (40k vs 10k empty members)",
		run: () => {
			const empty = compressFast(new Uint8Array(0));
			const a = concatN(empty, 10_000);
			const b = concatN(empty, 40_000);
			const ratio = best(() => decompress(b)) / best(() => decompress(a));
			return { ok: ratio < 6, detail: `ratio ${ratio.toFixed(2)} (limit 6)` };
		},
	},
	{
		name: "tiny dynamic blocks with 15-bit codes vs zlib",
		run: () => {
			const gz = tinyDynamicBlocks(20_000);
			const w = best(() => decompress(gz), 3);
			const z = best(() => gunzipSync(gz), 3);
			const ratio = w / z;
			return {
				ok: ratio < 8,
				detail: `wgzip ${w.toFixed(0)} ms, zlib ${z.toFixed(0)} ms, ratio ${ratio.toFixed(1)} (limit 8)`,
			};
		},
	},
];

let failed = 0;
for (const c of checks) {
	const { ok, detail } = c.run();
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: ${detail}`);
}
process.exit(failed ? 1 : 0);
