import { defineConfig } from "tsdown";

/**
 * Library build (Rolldown/tsdown — the lib piece of the Vite+ stack).
 * ESM-only ES2022 emit for multi-runtime consumers (Node, Workers, Convex, …).
 */
export default defineConfig({
	// Separate entries give physical isolation:
	// - compressFast / compressStrong are product tiers (one-shot + push +
	//   TransformStream; no level param)
	// - decompress stays independent (one-shot + Decompress). decompressStream
	//   is barrel-only so the host TransformStream is not loaded from this entry.
	// - index re-exports for `import { … } from "wgzip"`
	entry: {
		index: "src/index.ts",
		compressFast: "src/compress/fast.ts",
		compressStrong: "src/compress/strong.ts",
		decompress: "src/decompress.ts",
	},
	format: ["esm"],
	platform: "neutral",
	target: "es2022",
	outDir: "dist",
	clean: true,
	dts: true,
	// No sourcemaps in the package: they doubled dist size and pointed at
	// sources that are not published.
	sourcemap: false,
	minify: true,
	treeshake: true,
	unbundle: false,
});
