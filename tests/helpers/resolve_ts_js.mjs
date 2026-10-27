/**
 * Resolve bare `.js` specifiers to sibling `.ts` when the `.js` file is absent.
 * Lets unit tests import library sources (`../src/foo.ts`) whose internal
 * imports use TypeScript's usual `.js` emit paths.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		if (
			typeof specifier === "string" &&
			specifier.endsWith(".js") &&
			context.parentURL
		) {
			const asTs = specifier.slice(0, -3) + ".ts";
			try {
				const candidate = await nextResolve(asTs, context);
				const path = fileURLToPath(candidate.url);
				if (existsSync(path)) return candidate;
			} catch {
				// fall through
			}
		}
		throw err;
	}
}
