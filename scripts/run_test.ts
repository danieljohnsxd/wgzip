/**
 * Test runner: `node --test` over the tests directory.
 *
 * ```
 *   pnpm test
 *   pnpm test -- --test-name-pattern foo
 * ```
 */
import { spawnSync } from "node:child_process";

const raw = process.argv.slice(2);
const forwarded: Array<string> = [];
let afterDash = false;
for (const arg of raw) {
	if (afterDash) {
		forwarded.push(arg);
		continue;
	}
	if (arg === "--") {
		afterDash = true;
		continue;
	}
	forwarded.push(arg);
}

const run = spawnSync(
	process.execPath,
	// Only `*_test.ts` — helpers under tests/helpers/ are not test files.
	["--test", ...forwarded, "tests/**/*_test.ts"],
	{ stdio: "inherit" },
);
process.exit(run.status === null ? 1 : run.status);
