import { Database } from "bun:sqlite"
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { config } from "./config.js"
import type { OtlpTraceExportRequest } from "./otlp.js"

type StoreModule = Awaited<typeof import("./services/TelemetryStore.ts")>
type Store = StoreModule["TelemetryStore"]["Service"]

const toNanos = (ms: number) => String(BigInt(ms) * 1_000_000n)

const tracePayload = (traceId: string): OtlpTraceExportRequest => {
	const now = Date.now()
	return {
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "summary-test" } }] },
			scopeSpans: [{
				scope: { name: "test" },
				spans: [{ traceId, spanId: `${traceId}-root`, name: "root", kind: 1, startTimeUnixNano: toNanos(now - 10), endTimeUnixNano: toNanos(now) }],
			}],
		}],
	}
}

describe("trace summary rebuild", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-summaries-"))
	const otel = config.otel as { databasePath: string }
	const originalPath = otel.databasePath

	afterAll(() => {
		otel.databasePath = originalPath
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("keeps the existing summaries when the startup rebuild fails", async () => {
		const dbPath = join(tempDir, "telemetry.sqlite")
		otel.databasePath = dbPath
		const mod: StoreModule = await import(`./services/TelemetryStore.ts?summaries=${Date.now()}`)
		const using = <A, E>(runtime: ManagedRuntime.ManagedRuntime<InstanceType<StoreModule["TelemetryStore"]>, never>, f: (store: Store) => Effect.Effect<A, E>) =>
			runtime.runPromise(Effect.flatMap(mod.TelemetryStore.asEffect(), f))
		const summaryCount = () => {
			const db = new Database(dbPath, { readonly: true })
			try {
				return (db.query(`SELECT COUNT(*) AS c FROM trace_summaries`).get() as { c: number }).c
			} finally {
				db.close()
			}
		}

		const seed = ManagedRuntime.make(mod.makeTelemetryStoreLayer({ readonly: false, runRetention: false }))
		await using(seed, (store) => store.ingestTraces(tracePayload("t1")))
		await using(seed, (store) => store.ingestTraces(tracePayload("t2")))
		await seed.dispose()

		const db = new Database(dbPath)
		db.exec(`CREATE TRIGGER fail_rebuild BEFORE INSERT ON trace_summaries BEGIN SELECT RAISE(ABORT, 'rebuild failed'); END;`)
		db.close()

		// The retention owner rebuilds summaries in a forked fiber at startup.
		const owner = ManagedRuntime.make(mod.makeTelemetryStoreLayer({ readonly: false, runRetention: true }))
		await using(owner, (store) => store.listServices)
		await Bun.sleep(250)
		expect(summaryCount()).toBe(2)
		await owner.dispose()
	})
})
