/**
 * Decode bench: wgzip (verify / no-verify) vs node gunzip vs fflate gunzip.
 *
 * Frames built with compressStrong; every frame pre-checked under node + fflate.
 *
 * ```
 *   pnpm bench:decode
 *   pnpm bench:decode --silesia-only
 *   pnpm bench:decode --synthetic-only --limit 10
 * ```
 */
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { gunzipSync as fflateGunzip } from "fflate";
import { compressStrong } from "../dist/compressStrong.js";
import { decompress } from "../dist/decompress.js";
import { selectCorpora } from "./helpers/corpora.ts";
import { assertUniversalGunzip } from "./helpers/verify_gunzip.ts";

const { cap: CAP, corpora } = selectCorpora();

type Decoder = {
	label: string;
	decode: (gz: Uint8Array) => Uint8Array;
};

const DECODERS: Array<Decoder> = [
	{ label: "wgzip", decode: (g) => decompress(g, { maxSize: Infinity }) },
	{
		label: "wgzip nv",
		decode: (g) => decompress(g, { checksum: false, maxSize: Infinity }),
	},
	{
		label: "node gunzip",
		decode: (g) => new Uint8Array(nodeGunzipSync(g)),
	},
	{ label: "fflate", decode: (g) => fflateGunzip(g) },
];

function median(xs: Array<number>): number {
	// oxlint-disable-next-line unicorn/no-array-sort -- filter() copies
	const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	return s[s.length >> 1] ?? Number.NaN;
}

function timeDecode(
	decode: (g: Uint8Array) => Uint8Array,
	gz: Uint8Array,
	outBytes: number,
	iters: number,
): number {
	decode(gz);
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) decode(gz);
	const ms = performance.now() - t0;
	return (outBytes * iters) / (ms / 1000) / (1 << 20);
}

function pickIters(n: number): number {
	if (n < 1 << 14) return 80;
	if (n < 1 << 16) return 40;
	if (n < 1 << 20) return 12;
	return 4;
}

console.log(
	`wgzip decode bench — Strong frames; throughput on min(file, ${CAP} B)`,
);
console.log(`decoders: ${DECODERS.map((d) => d.label).join(", ")}\n`);

for (const corpus of corpora) {
	console.log(`=== ${corpus.label} (${corpus.payloads.length} payloads) ===\n`);
	console.log(
		`${"file".padEnd(22)} ${"decoder".padEnd(14)} ${"frame".padStart(10)} ${"MB/s".padStart(10)}`,
	);
	console.log("-".repeat(60));

	const speeds = new Map<string, Array<number>>();
	for (const d of DECODERS) speeds.set(d.label, []);

	for (const { name, data } of corpus.payloads) {
		const slice = data.length > CAP ? data.subarray(0, CAP) : data;
		const gz = compressStrong(slice);
		// Interop gate before timing.
		assertUniversalGunzip(`Strong/${name}`, gz, slice);

		const iters = pickIters(slice.length);
		for (const dec of DECODERS) {
			const samples: Array<number> = [];
			for (let r = 0; r < 3; r++) {
				samples.push(timeDecode(dec.decode, gz, slice.length, iters));
			}
			const mbs = median(samples);
			speeds.get(dec.label)?.push(mbs);
			console.log(
				`${name.padEnd(22)} ${dec.label.padEnd(14)} ${String(gz.length).padStart(10)} ${mbs.toFixed(1).padStart(10)}`,
			);
		}
		console.log("");
	}

	console.log(`--- ${corpus.id} summary (median MB/s) ---`);
	for (const dec of DECODERS) {
		const m = median(speeds.get(dec.label) ?? []);
		console.log(`${dec.label.padEnd(14)} ${m.toFixed(1).padStart(10)}`);
	}
	console.log("");
}
