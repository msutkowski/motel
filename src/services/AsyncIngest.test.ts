import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { WorkerError, WorkerUnknownError } from "effect/unstable/workers/WorkerError"
import { IngestError } from "./ingestRpc.ts"
import { makeAsyncIngest, type IngestClient, type TransportError } from "./AsyncIngest.ts"

const transportError = (message: string) =>
	new WorkerError({ reason: new WorkerUnknownError({ message }) })

const stubClient = (ingest: () => Effect.Effect<unknown, IngestError | TransportError>): IngestClient =>
	({
		ingestTraces: () => ingest(),
		ingestLogs: () => ingest(),
	}) as unknown as IngestClient

const payload = { payload: {} } as never

/** Run `f` inside a fresh scope that is closed afterwards. */
const scoped = <A, E>(f: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(f))

describe("AsyncIngest worker client", () => {
	test("a failed build fails every concurrent caller as an error, then rebuilds on the next call", async () => {
		let attempts = 0
		const build: Effect.Effect<IngestClient, TransportError, Scope.Scope> = Effect.suspend(() => {
			attempts += 1
			return attempts === 1
				? Effect.fail(transportError("worker died during spawn"))
				: Effect.succeed(stubClient(() => Effect.succeed({ insertedSpans: 1 })))
		})

		await scoped(Effect.gen(function*() {
			const { client } = yield* makeAsyncIngest(build)
			const exits = yield* Effect.all(
				Array.from({ length: 25 }, () => Effect.exit(client.ingestTraces(payload))),
				{ concurrency: "unbounded" },
			)
			for (const exit of exits) {
				expect(Exit.isFailure(exit)).toBe(true)
				if (Exit.isFailure(exit)) {
					// A typed failure, never a defect like "Not a valid effect: undefined".
					expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false)
					expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkerError)
				}
			}
			expect(attempts).toBe(1)

			const result = yield* client.ingestTraces(payload)
			expect(result).toEqual({ insertedSpans: 1 })
			expect(attempts).toBe(2)
		}))
	})

	test("a caller interrupted mid-build does not poison the client for later callers", async () => {
		let attempts = 0
		const build: Effect.Effect<IngestClient, TransportError, Scope.Scope> = Effect.suspend(() => {
			attempts += 1
			return Effect.delay(Effect.succeed(stubClient(() => Effect.succeed({ insertedSpans: 1 }))), "50 millis")
		})

		await scoped(Effect.gen(function*() {
			const { client } = yield* makeAsyncIngest(build)
			const first = yield* Effect.forkChild(client.ingestTraces(payload))
			yield* Effect.sleep("10 millis")
			yield* Fiber.interrupt(first)

			const result = yield* client.ingestTraces(payload)
			expect(result).toEqual({ insertedSpans: 1 })
			expect(attempts).toBe(1)
		}))
	})

	test("transport errors retire the worker and close its scope; ingest errors do not", async () => {
		let attempts = 0
		let closed = 0
		let nextFailure: IngestError | TransportError | null = null
		const build: Effect.Effect<IngestClient, TransportError, Scope.Scope> = Effect.gen(function*() {
			attempts += 1
			yield* Effect.addFinalizer(() => Effect.sync(() => { closed += 1 }))
			return stubClient(() => nextFailure ? Effect.fail(nextFailure) : Effect.succeed({ insertedSpans: 1 }))
		})

		await scoped(Effect.gen(function*() {
			const { client } = yield* makeAsyncIngest(build)
			expect(yield* client.ingestTraces(payload)).toEqual({ insertedSpans: 1 })
			expect(attempts).toBe(1)

			nextFailure = new IngestError({ message: "bad payload" })
			const bad = yield* Effect.exit(client.ingestTraces(payload))
			expect(Exit.isFailure(bad)).toBe(true)
			expect(closed).toBe(0)
			expect(attempts).toBe(1)

			nextFailure = transportError("worker crashed")
			const crashed = yield* Effect.exit(client.ingestTraces(payload))
			expect(Exit.isFailure(crashed)).toBe(true)
			expect(closed).toBe(1)

			nextFailure = null
			expect(yield* client.ingestTraces(payload)).toEqual({ insertedSpans: 1 })
			expect(attempts).toBe(2)
			expect(closed).toBe(1)
		}))
	})

	test("warmup builds the worker without a request and never fails", async () => {
		let attempts = 0
		const build: Effect.Effect<IngestClient, TransportError, Scope.Scope> = Effect.suspend(() => {
			attempts += 1
			return Effect.fail(transportError("no worker today"))
		})
		await scoped(Effect.gen(function*() {
			const { warmup } = yield* makeAsyncIngest(build)
			yield* warmup
			yield* Effect.sleep("10 millis")
			expect(attempts).toBe(1)
		}))
	})
})
