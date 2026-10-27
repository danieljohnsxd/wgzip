/**
 * Observe (or fail) typed-array allocations made by library code.
 *
 * `dist/` reads the global `Uint8Array` binding at call time, so swapping it
 * for a subclass sees every `new Uint8Array(n)` the decoder makes. This turns
 * "does not allocate from a forged size" into an assertion on bounded work
 * instead of a timing. Only `new Uint8Array(length)` counts (views and
 * copies of existing data do not).
 */
export function spyAllocs<T>(
	fn: () => T,
	failAbove = Infinity,
): { max: number; total: number; result: T } {
	const Real = globalThis.Uint8Array;
	let max = 0;
	let total = 0;
	class Spy extends Real {
		constructor(...args: Array<unknown>) {
			const n = typeof args[0] === "number" ? args[0] : 0;
			if (n > failAbove) {
				throw new RangeError("Array buffer allocation failed (spy)");
			}
			// @ts-expect-error -- forwarding the overloads verbatim
			super(...args);
			if (n > max) max = n;
			total += n;
		}
	}
	globalThis.Uint8Array = Spy;
	try {
		const result = fn();
		return { max, total, result };
	} finally {
		globalThis.Uint8Array = Real;
	}
}
