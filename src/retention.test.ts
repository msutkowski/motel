import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { config } from "./config.js"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "./otlp.js"

type StoreModule = Awaited<typeof import("./services/TelemetryStore.ts")>

const HOUR_MS = 60 * 60 * 1000

const tracePayload = (traceId: string, endedAtMs: number, opts?: { spans?: number; padBytes?: number }): OtlpTraceExportRequest => {
	const spans = opts?.spans ?? 2
	const pad = "x".repeat(opts?.padBytes ?? 0)
	const toNanos = (ms: number) => String(BigInt(ms) * 1_000_000n)
	return {
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "retention-test" } }] },
			scopeSpans: [{
				scope: { name: "test" },
				spans: Array.from({ length: spans }, (_, i) => ({
					traceId,
					spanId: `${traceId}-span-${i}`,
					parentSpanId: i === 0 ? undefined : `${traceId}-span-0`,
					name: `op-${i}`,
					kind: 1,
					startTimeUnixNano: toNanos(endedAtMs - 1000),
					endTimeUnixNano: toNanos(endedAtMs),
					attributes: [{ key: "payload", value: { stringValue: pad } }],
				})),
			}],
		}],
	}
}

const logPayload = (traceId: string | null, timestampMs: number, body: string): OtlpLogExportRequest => ({
	resourceLogs: [{
		resource: { attributes: [{ key: "service.name", value: { stringValue: "retention-test" } }] },
		scopeLogs: [{
			scope: { name: "test" },
			logRecords: [{
				timeUnixNano: String(BigInt(timestampMs) * 1_000_000n),
				severityText: "INFO",
				body: { stringValue: body },
				attributes: [{ key: "k", value: { stringValue: "v" } }],
				...(traceId ? { traceId } : {}),
			}],
		}],
	}],
})

describe("retention pass", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-retention-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	let mod: StoreModule
	let runtime: ManagedRuntime.ManagedRuntime<InstanceType<StoreModule["TelemetryStore"]>, never>

	const run = <A, E>(f: (store: StoreModule["TelemetryStore"]["Service"]) => Effect.Effect<A, E>) =>
		runtime.runPromise(Effect.flatMap(mod.TelemetryStore.asEffect(), f))

	const count = (sql: string, ...args: ReadonlyArray<string | number>) => {
		const db = new Database(dbPath, { readonly: true })
		try {
			return (db.query(sql).get(...args) as { c: number }).c
		} finally {
			db.close()
		}
	}

	// `config` is evaluated once per process and shared by every test file,
	// so env vars set here would be ignored; patch the live object instead.
	const otel = config.otel as { databasePath: string; retentionHours: number; maxDbSizeMb: number }
	const original = { databasePath: otel.databasePath, retentionHours: otel.retentionHours, maxDbSizeMb: otel.maxDbSizeMb }

	beforeAll(async () => {
		Object.assign(otel, { databasePath: dbPath, retentionHours: 1, maxDbSizeMb: 1 })
		mod = await import(`./services/TelemetryStore.ts?retention=${Date.now()}`)
		runtime = ManagedRuntime.make(mod.makeTelemetryStoreLayer({ readonly: false, runRetention: false }))
	})

	afterAll(async () => {
		await runtime.dispose()
		Object.assign(otel, original)
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("evicts expired traces with every dependent row, and keeps fresh ones", async () => {
		const now = Date.now()
		await run((store) => store.ingestTraces(tracePayload("old-trace", now - 3 * HOUR_MS)))
		await run((store) => store.ingestTraces(tracePayload("fresh-trace", now)))
		await run((store) => store.ingestLogs(logPayload("old-trace", now - 3 * HOUR_MS, "old body")))
		await run((store) => store.ingestLogs(logPayload("fresh-trace", now, "fresh body")))
		await run((store) => store.ingestLogs(logPayload(null, now - 3 * HOUR_MS, "old orphan")))
		await run((store) => store.ingestLogs(logPayload(null, now, "fresh orphan")))

		expect(count(`SELECT COUNT(*) c FROM trace_summaries`)).toBe(2)
		expect(count(`SELECT COUNT(*) c FROM logs`)).toBe(4)

		await run((store) => store.runRetentionPass)

		expect(count(`SELECT COUNT(*) c FROM trace_summaries WHERE trace_id = 'old-trace'`)).toBe(0)
		expect(count(`SELECT COUNT(*) c FROM spans WHERE trace_id = 'old-trace'`)).toBe(0)
		expect(count(`SELECT COUNT(*) c FROM span_attributes WHERE trace_id = 'old-trace'`)).toBe(0)
		// Both traces share operation names; only the fresh trace's two spans stay indexed.
		expect(count(`SELECT COUNT(*) c FROM span_operation_fts WHERE span_operation_fts MATCH 'op'`)).toBe(2)
		expect(count(`SELECT COUNT(*) c FROM logs WHERE trace_id = 'old-trace'`)).toBe(0)
		expect(count(`SELECT COUNT(*) c FROM logs WHERE body = 'old orphan'`)).toBe(0)
		// Nothing left dangling off deleted logs.
		expect(count(`SELECT COUNT(*) c FROM log_attributes WHERE NOT EXISTS (SELECT 1 FROM logs WHERE logs.id = log_attributes.log_id)`)).toBe(0)
		expect(count(`SELECT COUNT(*) c FROM log_body_fts WHERE body MATCH 'old'`)).toBe(0)

		expect(count(`SELECT COUNT(*) c FROM trace_summaries WHERE trace_id = 'fresh-trace'`)).toBe(1)
		expect(count(`SELECT COUNT(*) c FROM spans WHERE trace_id = 'fresh-trace'`)).toBe(2)
		expect(count(`SELECT COUNT(*) c FROM logs`)).toBe(2)
		expect(count(`SELECT COUNT(*) c FROM log_attributes`)).toBe(4)
		expect(count(`SELECT COUNT(*) c FROM log_body_fts WHERE body MATCH 'fresh'`)).toBe(2)
	})

	it("evicts the oldest completed traces once data exceeds maxDbSizeMb", async () => {
		const now = Date.now()
		let ingested = 0
		while (true) {
			// Fresh traces, oldest first, so only the size cap can evict them.
			await run((store) => store.ingestTraces(tracePayload(`big-${ingested}`, now - 1000 * (1000 - ingested), { spans: 4, padBytes: 4096 })))
			ingested += 1
			const stats = await run((store) => store.databaseStats)
			if (stats.effectiveBytes > 1024 * 1024) break
			if (ingested > 2000) throw new Error("database never crossed the 1MB cap")
		}
		const before = count(`SELECT COUNT(*) c FROM trace_summaries WHERE trace_id LIKE 'big-%'`)

		await run((store) => store.runRetentionPass)

		const after = count(`SELECT COUNT(*) c FROM trace_summaries WHERE trace_id LIKE 'big-%'`)
		expect(after).toBeLessThan(before)
		// One pass runs down to 90% of the cap, leaving room for ingest before the next.
		expect((await run((store) => store.databaseStats)).effectiveBytes).toBeLessThanOrEqual(0.9 * 1024 * 1024)
		// Oldest goes first; the newest survives.
		expect(count(`SELECT COUNT(*) c FROM trace_summaries WHERE trace_id = 'big-0'`)).toBe(0)
		expect(count(`SELECT COUNT(*) c FROM trace_summaries WHERE trace_id = 'big-${ingested - 1}'`)).toBe(1)
		expect(count(`SELECT COUNT(*) c FROM spans WHERE trace_id = 'big-0'`)).toBe(0)
	})
})
