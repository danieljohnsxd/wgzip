/**
 * Corpus selection for benches — synthetic + Silesia, never pooled.
 *
 * ```
 *   pnpm bench:encode                 # both (default)
 *   pnpm bench:encode --silesia-only
 *   pnpm bench:encode --synthetic-only
 *   pnpm bench:encode --limit 5       # first N payloads per corpus
 *   pnpm bench:encode --cap 1048576   # throughput byte cap (ratio = whole file)
 * ```
 */
import { benchPayloads, type Payload } from "../../tests/helpers/corpus.ts";
import { silesiaPayloads } from "./silesia.ts";

export type CorpusId = "synthetic" | "silesia";

export type Corpus = {
	id: CorpusId;
	label: string;
	payloads: Array<Payload>;
};

export type BenchArgs = {
	/** Throughput cap in bytes (ratio always uses whole payloads). */
	cap: number;
	corpora: Array<Corpus>;
};

function flagNum(args: Array<string>, name: string, fallback: number): number {
	const i = args.indexOf(name);
	if (i < 0) return fallback;
	const v = Number(args[i + 1]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function selectCorpora(
	argv: Array<string> = process.argv.slice(2),
): BenchArgs {
	const silesiaOnly = argv.includes("--silesia-only");
	const syntheticOnly = argv.includes("--synthetic-only");
	if (silesiaOnly && syntheticOnly) {
		throw new Error("--silesia-only and --synthetic-only contradict");
	}
	const limit = flagNum(argv, "--limit", Number.POSITIVE_INFINITY);
	const cap = flagNum(argv, "--cap", 4 << 20);

	const take = <T>(xs: Array<T>): Array<T> =>
		Number.isFinite(limit) ? xs.slice(0, limit) : xs;

	const corpora: Array<Corpus> = [];
	if (!silesiaOnly) {
		corpora.push({
			id: "synthetic",
			label: "In-repo synthetic",
			payloads: take(benchPayloads()),
		});
	}
	if (!syntheticOnly) {
		corpora.push({
			id: "silesia",
			label: "Silesia subset (Deorowicz)",
			payloads: take(silesiaPayloads()),
		});
	}
	return { cap, corpora };
}
