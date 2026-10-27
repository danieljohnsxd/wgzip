/**
 * Universal decompressibility: every wgzip member must open under foreign
 * GZIP decoders (node:zlib + fflate). Catches DEFLATE/GZIP framing mistakes
 * that our own inflate might paper over.
 */
import assert from "node:assert/strict";
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { test } from "node:test";
import { gunzipSync as fflateGunzip } from "fflate";
import { compressFast, compressStrong } from "../dist/index.js";
import { benchPayloads } from "./helpers/corpus.ts";
import { silesiaPayloads } from "../scripts/helpers/silesia.ts";

function assertRoundForeign(
	label: string,
	gz: Uint8Array,
	plain: Uint8Array,
): void {
	const viaNode = new Uint8Array(nodeGunzipSync(gz));
	assert.equal(viaNode.length, plain.length, `${label}/node size`);
	assert.deepEqual(viaNode, plain, `${label}/node bytes`);
	const viaFflate = fflateGunzip(gz);
	assert.equal(viaFflate.length, plain.length, `${label}/fflate size`);
	assert.deepEqual(viaFflate, plain, `${label}/fflate bytes`);
}

// Representative synthetic set (full ladder is for benches; keep CI bounded).
const SYNTH_FOCUS = new Set([
	"tiny-ok",
	"zeros-100k",
	"mixed-64k",
	"mixed-256k",
	"random-8k",
	"repeat-ascii-24k",
	"json-lines-500",
	"prose-256k",
	"csv-512k",
	"ndjson-512k",
	"utf8-heavy-2k",
	"html-256k",
	"source-256k",
	"skewed-binary-60k",
	"low-entropy-50k",
	"million-zeros",
]);

test("foreign gunzip: focused synthetic (Fast + Strong)", () => {
	const payloads = benchPayloads().filter((p) => SYNTH_FOCUS.has(p.name));
	assert.ok(payloads.length >= 10, "expected focused synthetic set");
	for (const { name, data } of payloads) {
		assertRoundForeign(`Fast/${name}`, compressFast(data), data);
		assertRoundForeign(`Strong/${name}`, compressStrong(data), data);
	}
});

test("foreign gunzip: silesia 1 MiB prefixes (Fast + Strong)", () => {
	const CAP = 1 << 20;
	for (const { name, data } of silesiaPayloads()) {
		const slice = data.length > CAP ? data.subarray(0, CAP) : data;
		assertRoundForeign(`Fast/${name}`, compressFast(slice), slice);
		assertRoundForeign(`Strong/${name}`, compressStrong(slice), slice);
	}
});
