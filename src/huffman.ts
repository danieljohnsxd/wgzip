/**
 * Huffman tree construction for DEFLATE dynamic blocks (encode path).
 *
 * Code lengths via the two-queue method (one sort, then a linear merge) with
 * frequency-halving when depths exceed the DEFLATE cap.
 */

import { emptyCodes } from "./tables.js";

/**
 * Canonical Huffman depths for symbols with positive frequency.
 * Two-queue linear merge: leaves sorted by (freq, symbol); internal nodes are
 * produced in non-decreasing weight order so two cursors replace a heap.
 * Prefer the leaf queue on weight ties (shallower trees).
 * Depths assigned iteratively (descending pass over internal nodes).
 * `depths[s]` is 0 for absent symbols. Returns null when fewer than two
 * present symbols.
 */
function buildHuffmanDepths(
	freq: Int32Array,
): { depths: Uint8Array; maxDepth: number } | null {
	const symbolCount = freq.length;
	const order: Array<number> = [];
	for (let s = 0; s < symbolCount; s++) {
		if ((freq[s] ?? 0) > 0) order.push(s);
	}
	const n = order.length;
	if (n < 2) return null;
	order.sort((a, b) => {
		const fa = freq[a] ?? 0;
		const fb = freq[b] ?? 0;
		return fa !== fb ? fa - fb : a - b;
	});

	// Nodes 0..n-1 are leaves in ascending weight; n..2n-2 are internal nodes in
	// creation order, which is also ascending weight.
	const total = 2 * n - 1;
	const weight = new Int32Array(total);
	const left = new Int32Array(total);
	const right = new Int32Array(total);
	for (let i = 0; i < n; i++) weight[i] = freq[order[i] ?? 0] ?? 0;

	let leaf = 0;
	let internal = n;
	for (let next = n; next < total; next++) {
		// Prefer the leaf queue on ties: fewer deep nodes, so the length limit
		// below is reached less often.
		let a = 0;
		if (
			leaf < n &&
			(internal >= next || (weight[leaf] ?? 0) <= (weight[internal] ?? 0))
		) {
			a = leaf++;
		} else a = internal++;
		let b = 0;
		if (
			leaf < n &&
			(internal >= next || (weight[leaf] ?? 0) <= (weight[internal] ?? 0))
		) {
			b = leaf++;
		} else b = internal++;
		weight[next] = (weight[a] ?? 0) + (weight[b] ?? 0);
		left[next] = a;
		right[next] = b;
	}

	// Every child index is below its parent's, so one descending pass over the
	// internal nodes assigns all depths after the root's implicit 0.
	const nodeDepth = new Int32Array(total);
	for (let i = total - 1; i >= n; i--) {
		const d = (nodeDepth[i] ?? 0) + 1;
		nodeDepth[left[i] ?? 0] = d;
		nodeDepth[right[i] ?? 0] = d;
	}

	const depths = new Uint8Array(symbolCount);
	let maxDepth = 0;
	for (let i = 0; i < n; i++) {
		const d = nodeDepth[i] ?? 0;
		const depth = d < 1 ? 1 : d;
		depths[order[i] ?? 0] = depth;
		if (depth > maxDepth) maxDepth = depth;
	}
	return { depths, maxDepth };
}

/**
 * Length-limited Huffman code lengths from frequencies.
 * Rebuilds on halved frequencies when max depth exceeds `maxBits`; once every
 * present symbol weighs 1 the tree is at most ceil(log2 n) deep, which for
 * DEFLATE alphabets (≤286) is ≤9 — well under the 15 / 7 caps.
 *
 * @param freq symbol frequencies (zeros skipped)
 * @param maxBits length cap (15 for lit/dist, 7 for code-length)
 */
export function hTree(
	freq: Uint16Array,
	maxBits: number,
): { t: Uint8Array; l: number } {
	let nSym = 0;
	let maxSym = -1;
	for (let i = 0; i < freq.length; ++i) {
		if ((freq[i] ?? 0) > 0) {
			++nSym;
			maxSym = i;
		}
	}
	if (nSym === 0) return { t: emptyCodes, l: 0 };
	if (nSym === 1) {
		const v = new Uint8Array(maxSym + 1);
		v[maxSym] = 1;
		return { t: v, l: 1 };
	}

	// Work copy so frequency-halving never mutates the caller's histogram.
	const work = new Int32Array(maxSym + 1);
	for (let i = 0; i <= maxSym; ++i) work[i] = freq[i] ?? 0;

	for (;;) {
		const built = buildHuffmanDepths(work);
		if (!built) return { t: emptyCodes, l: 0 };
		const { depths, maxDepth } = built;
		if (maxDepth <= maxBits) return { t: depths, l: maxDepth };

		// Flatten by halving positive frequencies (>1). Never touch zero-freq.
		let changed = false;
		for (let i = 0; i <= maxSym; ++i) {
			const f = work[i] ?? 0;
			if (f > 1) {
				work[i] = (f + 1) >>> 1;
				changed = true;
			}
		}
		// All present weights are 1 → depth is ceil(log2 n). Under DEFLATE
		// alphabets that is ≤9 (lit) / ≤5 (dist, code-len) — always ≤ maxBits.
		// If a caller ever passes an impossible (alphabet, cap) pair, return
		// the flat tree rather than loop forever.
		if (!changed) return { t: depths, l: maxDepth };
	}
}

/**
 * Run-length encode code lengths for the dynamic header (symbols 0–18).
 * Packed as: low 5 bits = symbol; for 16–18, next fields hold count extras.
 */
export function lc(c: Uint8Array): { c: Uint16Array; n: number } {
	let s = c.length;
	while (s && !(c[--s] ?? 0));
	const cl = new Uint16Array(++s);
	let cli = 0;
	let cln = c[0] ?? 0;
	let cls = 1;
	const w = (v: number): void => {
		cl[cli++] = v;
	};
	for (let i = 1; i <= s; ++i) {
		if ((c[i] ?? 0) === cln && i !== s) {
			++cls;
		} else {
			if (!cln && cls > 2) {
				for (; cls > 138; cls -= 138) w(32754);
				if (cls > 2) {
					w(cls > 10 ? ((cls - 11) << 5) | 28690 : ((cls - 3) << 5) | 12305);
					cls = 0;
				}
			} else if (cls > 3) {
				w(cln);
				--cls;
				for (; cls > 6; cls -= 6) w(8304);
				if (cls > 2) {
					w(((cls - 3) << 5) | 8208);
					cls = 0;
				}
			}
			while (cls--) w(cln);
			cls = 1;
			cln = c[i] ?? 0;
		}
	}
	return { c: cl.subarray(0, cli), n: s };
}

/** Weighted bit cost of emitting `freq` under code lengths `cl`. */
export function clen(freq: Uint16Array, cl: Uint8Array): number {
	let l = 0;
	for (let i = 0; i < cl.length; ++i) {
		l += (freq[i] ?? 0) * (cl[i] ?? 0);
	}
	return l;
}
