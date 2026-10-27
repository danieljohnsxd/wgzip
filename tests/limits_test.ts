/**
 * Decompress size cap (`maxSize` / OutputTooLarge) and linear multi-member
 * decode. Zip-bomb frames are built here so the product never emits them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compressFast,
	Decompress,
	decompress,
	decompressStream,
	GzipError,
	GzipErrorCode,
} from "../dist/index.js";
import { spyAllocs } from "./helpers/alloc_spy.ts";

function concat(parts: Array<Uint8Array>): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function concatN(member: Uint8Array, n: number): Uint8Array {
	const out = new Uint8Array(member.length * n);
	for (let i = 0; i < n; i++) out.set(member, i * member.length);
	return out;
}

function pushChunks(frame: Uint8Array, chunk: number, maxSize: number): void {
	const dec = new Decompress(undefined, { maxSize });
	for (let i = 0; i < frame.length; i += chunk) {
		dec.push(frame.subarray(i, Math.min(i + chunk, frame.length)));
	}
	dec.push(new Uint8Array(0), true);
}

async function streamChunks(
	frame: Uint8Array,
	chunk: number,
	maxSize: number,
): Promise<Uint8Array> {
	const src = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < frame.length; i += chunk) {
				controller.enqueue(
					frame.subarray(i, Math.min(i + chunk, frame.length)),
				);
			}
			controller.close();
		},
	});
	const parts: Array<Uint8Array> = [];
	for await (const part of src.pipeThrough(decompressStream({ maxSize }))) {
		parts.push(part);
	}
	return concat(parts);
}

function isOutputTooLarge(err: unknown): boolean {
	return (
		err instanceof GzipError &&
		err.code === GzipErrorCode.OutputTooLarge &&
		err.message === "output exceeds maxSize"
	);
}

test("GzipErrorCode.OutputTooLarge is 17", () => {
	assert.equal(GzipErrorCode.OutputTooLarge, 17);
});

test("64 MiB zeros with maxSize 1 MiB throws on all three entry points, before expanding", async () => {
	const zeros = new Uint8Array(64 << 20);
	const gz = compressFast(zeros);
	assert.ok(gz.length < 80_000, `compressed size ${gz.length}`);
	const cap = 1 << 20;

	// Bounded work, not timing: no buffer much past the cap is ever allocated.
	const one = spyAllocs(() => {
		assert.throws(() => decompress(gz, { maxSize: cap }), isOutputTooLarge);
	});
	assert.ok(one.max <= 2 * cap, `one-shot allocated ${one.max}`);
	const push = spyAllocs(() => {
		assert.throws(() => pushChunks(gz, 4096, cap), isOutputTooLarge);
	});
	assert.ok(push.max <= 2 * cap, `push allocated ${push.max}`);
	await assert.rejects(() => streamChunks(gz, 4096, cap), isOutputTooLarge);
});

test("multi-member total counts toward maxSize", () => {
	const a = compressFast(new Uint8Array(600_000));
	const b = compressFast(new Uint8Array(600_000));
	const joined = concat([a, b]);
	assert.throws(
		() => decompress(joined, { maxSize: 1_000_000 }),
		isOutputTooLarge,
	);
	assert.throws(() => pushChunks(joined, 4096, 1_000_000), isOutputTooLarge);
});

test("maxSize exactly equal to output succeeds", async () => {
	const data = new Uint8Array(8000).fill(7);
	const gz = compressFast(data);
	assert.deepEqual(decompress(gz, { maxSize: data.length }), data);

	const parts: Array<Uint8Array> = [];
	const dec = new Decompress(
		(chunk, final) => {
			if (!final && chunk.length) parts.push(chunk);
		},
		{ maxSize: data.length },
	);
	dec.push(gz, true);
	assert.deepEqual(concat(parts), data);

	assert.deepEqual(await streamChunks(gz, 64, data.length), data);
});

// Quadratic multi-member walking was a DoS; the linearity ratio itself is a
// perf check in `pnpm bench:check`.
test("40k concatenated empty members decode in well under a second", () => {
	const fortyK = concatN(compressFast(new Uint8Array(0)), 40_000);
	const t40 = performance.now();
	const out40 = decompress(fortyK);
	const ms40 = performance.now() - t40;
	assert.equal(out40.length, 0);
	assert.ok(ms40 < 1000, `40k members took ${ms40.toFixed(1)} ms`);
});

test("honest ISIZE still allocates a tight buffer", () => {
	const data = new Uint8Array(4096).fill(3);
	const gz = compressFast(data);
	const out = decompress(gz);
	assert.deepEqual(out, data);
	assert.ok(
		out.buffer.byteLength <= out.length + 64,
		`honest ISIZE buffer ${out.buffer.byteLength} for length ${out.length}`,
	);
});
