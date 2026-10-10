/**
 * Guards the load-bearing import order in `src/motel.ts`.
 *
 * `./registryEnvBootstrap.js` must run before anything that transitively
 * imports `./config.js`, because `./config.js` snapshots
 * `MOTEL_OTEL_BASE_URL` (and friends) into top-level consts at module
 * evaluation. If a future edit slides another relative import above the
 * bootstrap, URL helpers in the TUI silently revert to the default port
 * and `o` / `O` / `c` start pointing at a port nothing is listening on.
 *
 * This is a static text check rather than a runtime smoke test on
 * purpose: the failure mode is import ordering, which is decided at
 * parse time and is faithfully reflected in the source text.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

const motelEntry = path.join(import.meta.dir, "motel.ts")

const relativeImportLines = (source: string): string[] =>
	source
		.split("\n")
		.filter((line) => /^\s*import\s+.*from\s+["']\.{1,2}\//.test(line) || /^\s*import\s+["']\.{1,2}\//.test(line))

describe("motel.ts import order", () => {
	test("./registryEnvBootstrap.js is the very first relative import", () => {
		const source = readFileSync(motelEntry, "utf8")
		const relImports = relativeImportLines(source)
		expect(relImports.length).toBeGreaterThan(0)
		expect(relImports[0]).toContain("./registryEnvBootstrap.js")
	})
})
