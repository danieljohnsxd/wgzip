/**
 * Cross-runtime smoke: Node, Deno, Bun.
 *
 *   node scripts/smoke_runtime.ts
 *   deno run -A scripts/smoke_runtime.ts
 *   bun scripts/smoke_runtime.ts
 *
 * Expects `dist/` to already be built.
 */
import {
	CompressFast,
	compressFast,
	compressFastStream,
	compressStrong,
	decompress,
	decompressStream,
} from "../dist/index.js";

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

function eq(a: Uint8Array, b: Uint8Array, label: string): void {
	if (a.length !== b.length) {
		throw new Error(`${label}: length ${a.length} !== ${b.length}`);
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			throw new Error(`${label}: byte ${i}`);
		}
	}
}

async function readAll(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Array<Uint8Array> = [];
	for (;;) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- sequential stream read
		const step = await reader.read();
		if (step.done) break;
		if (step.value.length > 0) parts.push(step.value);
	}
	return concat(parts);
}

const src = new Uint8Array(8 * 1024);
for (let i = 0; i < src.length; i++) {
	src[i] = (Math.imul(i + 17, 1103515245) >>> 24) & 0xff;
}

eq(decompress(compressFast(src)), src, "compressFast");
eq(decompress(compressStrong(src)), src, "compressStrong");

const pushParts: Array<Uint8Array> = [];
const enc = new CompressFast((chunk) => {
	if (chunk.length > 0) pushParts.push(chunk.slice());
});
enc.push(src.subarray(0, 3000));
enc.push(src.subarray(3000), true);
eq(decompress(concat(pushParts)), src, "push encode/decode");

const input = new ReadableStream<Uint8Array>({
	start(controller) {
		for (let i = 0; i < src.length; i += 1500) {
			controller.enqueue(src.subarray(i, Math.min(i + 1500, src.length)));
		}
		controller.close();
	},
});
const piped = await readAll(
	input.pipeThrough(compressFastStream()).pipeThrough(decompressStream()),
);
eq(piped, src, "TransformStream pipe");

console.log("OK");
