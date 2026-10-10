import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, unlinkSync } from "node:fs"
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
			resource: { attributes: [{ key: "service.name", value: { stringValue: "reopen-test" } }] },
			scopeSpans: [{
				scope: { name: "test" },
				spans: [{ traceId, spanId: `${traceId}-root`, name: "root", kind: 1, startTimeUnixNano: toNanos(now - 10), endTimeUnixNano: toNanos(now) }],
			}],
		}],
	}
}

describe("readonly store", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-reopen-"))
	const otel = config.otel as { databasePath: string }
	const originalPath = otel.databasePath

	afterAll(() => {
		otel.databasePath = originalPath
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("follows the database file when it is replaced", async () => {
		const dbPath = join(tempDir, "telemetry.sqlite")
		otel.databasePath = dbPath
		const mod: StoreModule = await import(`./services/TelemetryStore.ts?reopen=${Date.now()}`)
		const writerRuntime = () => ManagedRuntime.make(mod.makeTelemetryStoreLayer({ readonly: false, runRetention: false }))
		const using = <A, E>(runtime: ManagedRuntime.ManagedRuntime<InstanceType<StoreModule["TelemetryStore"]>, never>, f: (store: Store) => Effect.Effect<A, E>) =>
			runtime.runPromise(Effect.flatMap(mod.TelemetryStore.asEffect(), f))
		const traceIds = async () => (await using(reader, (store) => store.listTraceSummaries(null))).map((trace) => trace.traceId)

		const before = writerRuntime()
		await using(before, (store) => store.ingestTraces(tracePayload("before-reset")))
		const reader = ManagedRuntime.make(mod.TelemetryStoreReadonlyLive)
		expect(await traceIds()).toEqual(["before-reset"])

		// What `motel reset` does: stop the writer, delete the files, start fresh.
		await before.dispose()
		for (const suffix of ["", "-wal", "-shm"]) {
			try { unlinkSync(`${dbPath}${suffix}`) } catch { /* not every suffix exists */ }
		}
		const after = writerRuntime()
		await using(after, (store) => store.ingestTraces(tracePayload("after-reset")))

		expect(await traceIds()).toEqual(["after-reset"])
		expect((await using(reader, (store) => store.databaseStats)).traceCount).toBe(1)

		await reader.dispose()
		await after.dispose()
	})
})
