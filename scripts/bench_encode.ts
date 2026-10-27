/**
 * Encode bench: ratio (whole file) + throughput (capped prefix).
 *
 * Encoders: wgzip Fast/Strong, fflate L1/L6/L9, node gzip L1/L6/L9.
 * Every wgzip frame is verified with node + fflate gunzip (universal interop).
 *
 * ```
 *   pnpm bench:encode
 *   pnpm bench:encode --silesia-only
 *   pnpm bench:encode --synthetic-only --limit 10
 *   pnpm bench:encode --cap 1048576
 * ```
 *
 * Corpora are reported **separately** (never pooled into one median).
 */
import { gzipSync as nodeGzipSync } from "node:zlib";
import { gzipSync as fflateGzip } from "fflate";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { selectCorpora } from "./helpers/corpora.ts";
import { assertUniversalGunzip } from "./helpers/verify_gunzip.ts";

const { cap: CAP, corpora } = selectCorpora();

type Encoder = {
	label: string;
	ours: boolean;
	encode: (d: Uint8Array) => Uint8Array;
};

const ENCODERS: Array<Encoder> = [
	{ label: "wgzip Fast", ours: true, encode: (d) => compressFast(d) },
	{ label: "wgzip Strong", ours: true, encode: (d) => compressStrong(d) },
	{
		label: "fflate L1",
		ours: false,
		encode: (d) => fflateGzip(d, { level: 1 }),
	},
	{
		label: "fflate L6",
		ours: false,
		encode: (d) => fflateGzip(d, { level: 6 }),
	},
	{
		label: "fflate L9",
		ours: false,
		encode: (d) => fflateGzip(d, { level: 9 }),
	},
	{
		label: "node L1",
		ours: false,
		encode: (d) => new Uint8Array(nodeGzipSync(d, { level: 1 })),
	},
	{
		label: "node L6",
		ours: false,
		encode: (d) => new Uint8Array(nodeGzipSync(d, { level: 6 })),
	},
	{
		label: "node L9",
		ours: false,
		encode: (d) => new Uint8Array(nodeGzipSync(d, { level: 9 })),
	},
];

function median(xs: Array<number>): number {
	// oxlint-disable-next-line unicorn/no-array-sort -- filter() copies
	const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	return s[s.length >> 1] ?? Number.NaN;
}

function geomean(xs: Array<number>): number {
	const v = xs.filter((x) => Number.isFinite(x) && x > 0);
	if (v.length === 0) return Number.NaN;
	let sum = 0;
	for (const x of v) sum += Math.log(x);
	return Math.exp(sum / v.length);
}

function timeEncode(
	encode: (d: Uint8Array) => Uint8Array,
	data: Uint8Array,
	iters: number,
): number {
	encode(data);
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) encode(data);
	const ms = performance.now() - t0;
	return (data.length * iters) / (ms / 1000) / (1 << 20);
}

function pickIters(n: number): number {
	if (n < 1 << 14) return 80;
	if (n < 1 << 16) return 40;
	if (n < 1 << 20) return 12;
	return 4;
}

type Row = {
	name: string;
	inBytes: number;
	byEnc: Map<string, { size: number; ratio: number; mbs: number }>;
};

console.log(
	`wgzip encode bench — throughput cap ${CAP} B; ratio on whole payloads`,
);
console.log(`encoders: ${ENCODERS.map((e) => e.label).join(", ")}`);
console.log(`interop: every wgzip frame checked with node + fflate gunzip\n`);

for (const corpus of corpora) {
	console.log(`=== ${corpus.label} (${corpus.payloads.length} payloads) ===\n`);
	console.log(
		`${"file".padEnd(22)} ${"encoder".padEnd(14)} ${"size".padStart(10)} ${"ratio".padStart(8)} ${"MB/s".padStart(10)}`,
	);
	console.log("-".repeat(68));

	const rows: Array<Row> = [];
	// Totals for compressed size sum / raw sum (raw-weighted ratio).
	const sumRaw = { n: 0 };
	const sumOut = new Map<string, number>();
	const ratios = new Map<string, Array<number>>();
	const speeds = new Map<string, Array<number>>();
	for (const e of ENCODERS) {
		sumOut.set(e.label, 0);
		ratios.set(e.label, []);
		speeds.set(e.label, []);
	}

	for (const { name, data } of corpus.payloads) {
		const slice = data.length > CAP ? data.subarray(0, CAP) : data;
		const iters = pickIters(slice.length);
		const row: Row = { name, inBytes: data.length, byEnc: new Map() };
		sumRaw.n += data.length;

		for (const enc of ENCODERS) {
			const whole = enc.encode(data);
			const ratio = data.length > 0 ? data.length / whole.length : 1;

			// Universal decompressibility for *our* streams.
			if (enc.ours) {
				assertUniversalGunzip(`${enc.label}/${name}`, whole, data);
			}

			const samples: Array<number> = [];
			for (let r = 0; r < 3; r++) {
				samples.push(timeEncode(enc.encode, slice, iters));
			}
			const mbs = median(samples);
			row.byEnc.set(enc.label, { size: whole.length, ratio, mbs });
			sumOut.set(enc.label, (sumOut.get(enc.label) ?? 0) + whole.length);
			ratios.get(enc.label)?.push(ratio);
			speeds.get(enc.label)?.push(mbs);

			console.log(
				`${name.padEnd(22)} ${enc.label.padEnd(14)} ${String(whole.length).padStart(10)} ${ratio.toFixed(3).padStart(8)} ${mbs.toFixed(1).padStart(10)}`,
			);
		}
		rows.push(row);
		console.log("");
	}

	// Summary: do not pool with other corpora.
	console.log(`--- ${corpus.id} summary ---`);
	console.log(
		`${"encoder".padEnd(14)} ${"Σraw/Σout".padStart(10)} ${"geomean r".padStart(10)} ${"med MB/s".padStart(10)}`,
	);
	console.log("-".repeat(48));
	for (const enc of ENCODERS) {
		const out = sumOut.get(enc.label) ?? 0;
		const weighted = sumRaw.n > 0 && out > 0 ? sumRaw.n / out : Number.NaN;
		const geo = geomean(ratios.get(enc.label) ?? []);
		const medSpd = median(speeds.get(enc.label) ?? []);
		console.log(
			`${enc.label.padEnd(14)} ${weighted.toFixed(3).padStart(10)} ${geo.toFixed(3).padStart(10)} ${medSpd.toFixed(1).padStart(10)}`,
		);
	}
	console.log("");
}
