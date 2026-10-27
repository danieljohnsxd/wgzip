/**
 * Round-trip the pinned Silesia subset when files are present on disk.
 * Skips cleanly if `bench-data/silesia/` payloads are missing (fresh clone).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import { compressStrong, decompress } from "../dist/index.js";
import {
	SILESIA_SUBSET,
	type SilesiaEntry,
} from "../scripts/helpers/silesia.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SILESIA_DIR = join(ROOT, "bench-data", "silesia");

/** Cap decode/encode work for speed in CI-ish runs. */
const CAP = 1 << 20; // 1 MiB

function loadIfPresent(entry: SilesiaEntry): Uint8Array | undefined {
	const path = join(SILESIA_DIR, entry.name);
	if (!existsSync(path)) return undefined;
	const data = new Uint8Array(readFileSync(path));
	if (data.length !== entry.size) {
		throw new Error(
			`silesia ${entry.name}: size ${data.length}, expected ${entry.size}`,
		);
	}
	return data;
}

function capped(data: Uint8Array): Uint8Array {
	return data.length > CAP ? data.subarray(0, CAP) : data;
}

for (const entry of SILESIA_SUBSET) {
	const full = loadIfPresent(entry);
	const reason = full === undefined ? "silesia payload missing" : false;

	test(
		`silesia ${entry.name}: compressStrong + decompress`,
		{ skip: reason },
		() => {
			// full is defined when the test is not skipped
			if (full === undefined) return;
			const data = capped(full);
			const gz = compressStrong(data);
			const out = decompress(gz);
			assert.deepEqual(out, data);
		},
	);

	test(
		`silesia ${entry.name}: decompress(node gzipSync)`,
		{ skip: reason },
		() => {
			if (full === undefined) return;
			const data = capped(full);
			const gz = new Uint8Array(gzipSync(data));
			const out = decompress(gz);
			assert.deepEqual(out, data);
			// Also: node can gunzip our Strong frame of the same slice.
			const ours = compressStrong(data);
			assert.deepEqual(new Uint8Array(gunzipSync(ours)), data);
		},
	);
}
