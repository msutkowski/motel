import { Database } from "bun:sqlite"
import { afterEach, beforeAll, afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { config } from "./config.js"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "./otlp.js"

type StoreModule = Awaited<typeof import("./services/TelemetryStore.ts")>
type Store = StoreModule["TelemetryStore"]["Service"]

const toNanos = (ms: number) => String(BigInt(ms) * 1_000_000n)

const spanPayload = (traceId: string, spanId: string, name: string): OtlpTraceExportRequest => {
	const now = Date.now()
	return {
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "search-test" } }] },
			scopeSpans: [{
				scope: { name: "test" },
				spans: [{ traceId, spanId, name, kind: 1, startTimeUnixNano: toNanos(now - 10), endTimeUnixNano: toNanos(now) }],
			}],
		}],
	}
}

const logPayload = (body: string): OtlpLogExportRequest => ({
	resourceLogs: [{
		resource: { attributes: [{ key: "service.name", value: { stringValue: "search-test" } }] },
		scopeLogs: [{ scope: { name: "test" }, logRecords: [{ timeUnixNano: toNanos(Date.now()), severityText: "INFO", body: { stringValue: body } }] }],
	}],
})

const LEGACY_DDL = `
	DROP TRIGGER span_operation_fts_ai; DROP TRIGGER span_operation_fts_ad; DROP TRIGGER span_operation_fts_au;
	DROP TABLE span_operation_fts;
	CREATE VIRTUAL TABLE span_operation_fts USING fts5(trace_id UNINDEXED, span_id UNINDEXED, operation_name, tokenize='unicode61');
	INSERT INTO span_operation_fts (trace_id, span_id, operation_name) SELECT trace_id, span_id, operation_name FROM spans;
	DROP TRIGGER log_body_fts_ai; DROP TRIGGER log_body_fts_ad; DROP TRIGGER log_body_fts_au;
	DROP TABLE log_body_fts;
	CREATE VIRTUAL TABLE log_body_fts USING fts5(log_id UNINDEXED, body, tokenize='unicode61');
	INSERT INTO log_body_fts (log_id, body) SELECT CAST(id AS TEXT), body FROM logs;
`

describe("search indexes", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-search-"))
	const otel = config.otel as { databasePath: string }
	const originalPath = otel.databasePath
	let mod: StoreModule
	let runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, unknown>> = []
	let dbCount = 0

	const freshDbPath = () => {
		otel.databasePath = join(tempDir, `telemetry-${dbCount++}.sqlite`)
		return otel.databasePath
	}

	const openStore = (opts: { readonly: boolean; runRetention: boolean }) => {
		const runtime = ManagedRuntime.make(mod.makeTelemetryStoreLayer(opts))
		runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, unknown>)
		return <A, E>(f: (store: Store) => Effect.Effect<A, E>) => runtime.runPromise(Effect.flatMap(mod.TelemetryStore.asEffect(), f))
	}

	const withDb = <A>(path: string, f: (db: Database) => A): A => {
		const db = new Database(path)
		try {
			return f(db)
		} finally {
			db.close()
		}
	}

	const tableSql = (path: string, table: string) =>
		withDb(path, (db) => (db.query(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as { sql: string }).sql)

	// Throws if an external-content index disagrees with its content table.
	const integrityCheck = (path: string) =>
		withDb(path, (db) => {
			for (const table of ["span_operation_fts", "log_body_fts"]) {
				db.exec(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`)
			}
		})

	beforeAll(async () => {
		mod = await import(`./services/TelemetryStore.ts?search=${Date.now()}`)
	})

	afterEach(async () => {
		for (const runtime of runtimes) await runtime.dispose()
		runtimes = []
	})

	afterAll(() => {
		otel.databasePath = originalPath
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("keeps one index row per span across re-exports", async () => {
		const path = freshDbPath()
		const run = openStore({ readonly: false, runRetention: false })

		await run((store) => store.ingestTraces(spanPayload("t1", "s1", "checkout.create")))
		await run((store) => store.ingestTraces(spanPayload("t1", "s1", "checkout.create")))
		await run((store) => store.ingestTraces(spanPayload("t1", "s1", "payment.charge")))

		const byNew = await run((store) => store.searchSpans({ operation: "payment" }))
		const byOld = await run((store) => store.searchSpans({ operation: "checkout" }))
		expect(byNew.map((item) => item.span.spanId)).toEqual(["s1"])
		expect(byOld).toEqual([])
		expect(withDb(path, (db) => (db.query(`SELECT COUNT(*) c FROM span_operation_fts WHERE span_operation_fts MATCH 'payment'`).get() as { c: number }).c)).toBe(1)
		integrityCheck(path)
	})

	it("matches trace and log search through the rowid join", async () => {
		freshDbPath()
		const run = openStore({ readonly: false, runRetention: false })
		await run((store) => store.ingestTraces(spanPayload("t1", "s1", "inventory.allocate")))
		await run((store) => store.ingestTraces(spanPayload("t2", "s2", "orders.create")))
		await run((store) => store.ingestLogs(logPayload("allocation failed for sku")))
		await run((store) => store.ingestLogs(logPayload("order created")))

		const traces = await run((store) => store.searchTraceSummaries({ operation: "allocate" }))
		expect(traces.map((trace) => trace.traceId)).toEqual(["t1"])
		const logs = await run((store) => store.searchLogs({ body: "allocation" }))
		expect(logs.map((log) => log.body)).toEqual(["allocation failed for sku"])
	})

	it("migrates a legacy layout when it owns retention, and leaves it alone otherwise", async () => {
		const path = freshDbPath()
		const seed = openStore({ readonly: false, runRetention: false })
		await seed((store) => store.ingestTraces(spanPayload("t1", "s1", "inventory.allocate")))
		await seed((store) => store.ingestLogs(logPayload("allocation failed")))
		for (const runtime of runtimes) await runtime.dispose()
		runtimes = []
		withDb(path, (db) => db.exec(LEGACY_DDL))

		// A non-owner writer keeps the legacy table and searches by LIKE.
		const follower = openStore({ readonly: false, runRetention: false })
		expect((await follower((store) => store.searchSpans({ operation: "allocate" }))).map((item) => item.span.spanId)).toEqual(["s1"])
		expect(tableSql(path, "span_operation_fts")).toContain("UNINDEXED")

		const owner = openStore({ readonly: false, runRetention: true })
		await owner((store) => store.listServices)
		expect(tableSql(path, "span_operation_fts")).toContain("content='spans'")
		expect(tableSql(path, "log_body_fts")).toContain("content='logs'")
		integrityCheck(path)

		// The follower picks up the new layout without reopening.
		expect((await follower((store) => store.searchSpans({ operation: "allocate" }))).map((item) => item.span.spanId)).toEqual(["s1"])
		expect((await owner((store) => store.searchLogs({ body: "allocation" }))).map((log) => log.body)).toEqual(["allocation failed"])

		await owner((store) => store.ingestTraces(spanPayload("t2", "s2", "orders.create")))
		await owner((store) => store.ingestTraces(spanPayload("t2", "s2", "orders.update")))
		integrityCheck(path)
	})
})
