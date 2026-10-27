/**
 * Streaming encoder `flush()` (Z_SYNC_FLUSH).
 *
 * Partial output is checked with `inflateRawSync` / `createInflateRaw`
 * (`finishFlush: Z_SYNC_FLUSH`) on the DEFLATE body. Finished members are
 * checked with node and fflate `gunzipSync`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	constants as zconst,
	createInflateRaw,
	gunzipSync as nodeGunzip,
	inflateRawSync,
} from "node:zlib";
import { gunzipSync as fflateGunzip } from "fflate";
import {
	CompressFast,
	CompressStrong,
	compressFast,
	compressStrong,
} from "../dist/index.js";

const GZIP_HEADER = 10;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function payload(n: number): Uint8Array {
	const out = new Uint8Array(n);
	const unit = bytes('{"id":0,"name":"alpha","v":123456}\n');
	for (let i = 0; i < n; i += unit.length) {
		out.set(unit.subarray(0, Math.min(unit.length, n - i)), i);
	}
	return out;
}

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

function inflateFlushed(deflate: Uint8Array): Uint8Array {
	return new Uint8Array(
		inflateRawSync(deflate, { finishFlush: zconst.Z_SYNC_FLUSH }),
	);
}

/** Partial-stream check via `createInflateRaw` (same Z_SYNC_FLUSH finish). */
function inflateFlushedStream(deflate: Uint8Array): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const inf = createInflateRaw({ finishFlush: zconst.Z_SYNC_FLUSH });
		const chunks: Array<Uint8Array> = [];
		inf.on("data", (c: Buffer) => {
			chunks.push(new Uint8Array(c));
		});
		inf.on("error", reject);
		inf.on("end", () => {
			resolve(concat(chunks));
		});
		inf.end(deflate);
	});
}

type Enc = {
	push(chunk: Uint8Array, final?: boolean): void;
	flush(): void;
};

function collect(make: (ondata: (d: Uint8Array) => void) => Enc): {
	parts: Array<Uint8Array>;
	enc: Enc;
	emitted: () => Uint8Array;
} {
	const parts: Array<Uint8Array> = [];
	const enc = make((d) => {
		if (d.length > 0) parts.push(d.slice());
	});
	return {
		parts,
		enc,
		emitted: () => concat(parts),
	};
}

function assertFullGzip(
	frame: Uint8Array,
	src: Uint8Array,
	label: string,
): void {
	assert.equal(frame[0], 31, `${label}: ID1`);
	assert.equal(frame[1], 139, `${label}: ID2`);
	assert.deepEqual(new Uint8Array(nodeGunzip(frame)), src, `${label} node`);
	assert.deepEqual(fflateGunzip(frame), src, `${label} fflate`);
}

const tiers = [
	["Fast", CompressFast, compressFast],
	["Strong", CompressStrong, compressStrong],
] as const;

describe("flush()", () => {
	for (const [name, Ctor, oneshot] of tiers) {
		test(`${name}: flushed prefix inflates with Z_SYNC_FLUSH`, async () => {
			const src = payload(100 * 1024);
			const { enc, emitted } = collect((ondata) => new Ctor(ondata));
			enc.push(src);
			enc.flush();
			const frame = emitted();
			assert.ok(frame.length > GZIP_HEADER, `${name}: header + body`);
			const deflate = frame.subarray(GZIP_HEADER);
			assert.deepEqual(inflateFlushed(deflate), src, `${name} inflateRawSync`);
			assert.deepEqual(
				await inflateFlushedStream(deflate),
				src,
				`${name} createInflateRaw`,
			);
		});

		test(`${name}: push more after flush; full member gunzips`, () => {
			const first = payload(100 * 1024);
			const extra = payload(40 * 1024);
			const { enc, emitted } = collect((ondata) => new Ctor(ondata));
			enc.push(first);
			enc.flush();
			enc.push(extra, true);
			const all = new Uint8Array(first.length + extra.length);
			all.set(first);
			all.set(extra, first.length);
			assertFullGzip(emitted(), all, `${name} after flush`);
		});

		test(`${name}: flush twice, then empty-stream flush + finish`, () => {
			const src = payload(8_000);
			const { enc, emitted } = collect((ondata) => new Ctor(ondata));
			enc.push(src);
			enc.flush();
			enc.flush();
			enc.push(new Uint8Array(0), true);
			assertFullGzip(emitted(), src, `${name} double flush`);
		});

		test(`${name}: flush on empty stream then finish is empty gzip`, () => {
			const { enc, emitted } = collect((ondata) => new Ctor(ondata));
			enc.flush();
			enc.flush();
			enc.push(new Uint8Array(0), true);
			assertFullGzip(emitted(), new Uint8Array(0), `${name} empty flush`);
		});

		test(`${name}: flush after final throws TypeError`, () => {
			const enc = new Ctor();
			enc.push(bytes("done"), true);
			assert.throws(() => enc.flush(), TypeError);
			assert.throws(() => enc.push(bytes("more")), TypeError);
		});

		test(`${name}: one-shot matches streaming without flush`, () => {
			const src = payload(20_000);
			const { enc, emitted } = collect((ondata) => new Ctor(ondata));
			enc.push(src, true);
			assert.deepEqual(emitted(), oneshot(src));
		});
	}

	test("sweep: random chunks with a flush every k pushes", () => {
		const src = payload(300 * 1024);
		let seed = 0x9e3779b9;
		const rnd = (): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		const k = 5;
		const { enc, emitted } = collect((ondata) => new CompressFast(ondata));
		let i = 0;
		let pushes = 0;
		while (i < src.length) {
			const n = 1 + Math.floor(rnd() * 12_000);
			const end = Math.min(i + n, src.length);
			const last = end === src.length;
			enc.push(src.subarray(i, end), last);
			i = end;
			pushes++;
			if (!last && pushes % k === 0) enc.flush();
		}
		assertFullGzip(emitted(), src, "sweep Fast");

		const strong = collect((ondata) => new CompressStrong(ondata));
		i = 0;
		pushes = 0;
		seed = 0x9e3779b9;
		while (i < src.length) {
			const n = 1 + Math.floor(rnd() * 12_000);
			const end = Math.min(i + n, src.length);
			const last = end === src.length;
			strong.enc.push(src.subarray(i, end), last);
			i = end;
			pushes++;
			if (!last && pushes % k === 0) strong.enc.flush();
		}
		assertFullGzip(strong.emitted(), src, "sweep Strong");
	});
});
