/**
 * Universal gunzip checks — every wgzip frame must open under foreign decoders.
 * node:zlib is the primary interoperability oracle; fflate is a second pure-JS peer.
 */
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { gunzipSync as fflateGunzip } from "fflate";

function assertSame(
	label: string,
	got: Uint8Array,
	expected: Uint8Array,
): void {
	if (got.length !== expected.length) {
		throw new Error(`${label}: size ${got.length} !== ${expected.length}`);
	}
	// Full compare — gzip interop must be bitwise-identical output.
	for (let i = 0; i < got.length; i++) {
		if (got[i] !== expected[i]) {
			throw new Error(`${label}: mismatch at byte ${i}`);
		}
	}
}

/**
 * Assert `gz` decompresses to `plain` under node and fflate.
 * Throws on any size/content mismatch.
 */
export function assertUniversalGunzip(
	label: string,
	gz: Uint8Array,
	plain: Uint8Array,
): void {
	const viaNode = new Uint8Array(nodeGunzipSync(gz));
	assertSame(`${label}/node`, viaNode, plain);
	const viaFflate = fflateGunzip(gz);
	assertSame(`${label}/fflate`, viaFflate, plain);
}
