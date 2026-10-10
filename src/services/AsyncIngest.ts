/**
 * Main-thread client for the telemetry worker's ingest RPCs.
 *
 * The HTTP handlers for POST /v1/traces and POST /v1/logs call into
 * this service instead of `TelemetryStore.ingestTraces/Logs`. Each
 * method sends a typed message to the worker, awaits the reply, and
 * returns the worker's result as an Effect. While the worker is
 * serialising a big batch into SQLite, the main thread's event loop
 * is FREE to answer /api/* queries — that's the whole point of the
 * offload.
 *
 * The worker is also the process's only SQLite writer, so it owns the
 * retention loop (see TelemetryStoreWorkerLive). It is spawned in the
 * background at layer build so retention starts without waiting for
 * the first ingest request; /api/health never waits on it.
 *
 * The protocol pool is sized at 1 because SQLite only supports a single
 * writer at a time. When the outer scope closes (server shutdown),
 * `BunWorker.layer`'s finalizer sends a close message and terminates
 * the worker if it doesn't exit gracefully in 5s.
 */

import * as BunWorker from "@effect/platform-bun/BunWorker"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { WorkerError } from "effect/unstable/workers/WorkerError"
import { IngestRpcs } from "./ingestRpc.ts"

// RpcClient.make always surfaces RpcClientError in addition to the
// group's declared errors (transport failures, worker crashes, etc.),
// so the service shape has to mirror that. Without the explicit error
// type param, TS treats the declared and observed client types as
// unrelated structural mismatches.
export type IngestClient = RpcClient.FromGroup<typeof IngestRpcs, RpcClientError | WorkerError>

export class AsyncIngest extends Context.Service<AsyncIngest, IngestClient>()("@motel/AsyncIngest") {}

export type TransportError = RpcClientError | WorkerError

// Protocol: RpcClient.layerProtocolWorker manages a worker pool and
// speaks msgpack over structured-clone messages. `size: 1` matches
// SQLite's single-writer constraint.
const WorkerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(
		BunWorker.layer(() => new Worker(new URL("./telemetryWorker.ts", import.meta.url))),
	),
)

const buildWorkerClient: Effect.Effect<IngestClient, TransportError, Scope.Scope> = Effect.gen(function*() {
	const scope = yield* Scope.Scope
	const protocolContext = yield* Layer.buildWithScope(WorkerProtocol, scope)
	return yield* RpcClient.make(IngestRpcs).pipe(
		Effect.provide(protocolContext),
		Effect.provideService(Scope.Scope, scope),
	)
})

export interface AsyncIngestHandle {
	readonly client: IngestClient
	/** Start building the worker client in the background. Never fails. */
	readonly warmup: Effect.Effect<void>
}

/**
 * Single-flight, self-healing worker client.
 *
 * Contract:
 * - Exactly one worker build is in flight at a time; concurrent callers
 *   wait on the same Deferred and each receive their own copy of the exit.
 * - The build runs in a fiber forked into the layer scope, so a caller
 *   that is interrupted mid-build (client aborts the POST) does not tear
 *   the worker down for everyone else.
 * - A failed build is never cached: its child scope is closed and the
 *   next caller rebuilds.
 * - Only transport errors (RpcClientError / WorkerError) retire the
 *   current worker. IngestError from a bad payload and the ingest shed
 *   timeout (an interrupt) leave it alone — retiring on those leaked one
 *   live worker thread + SQLite connection per failed request.
 * - Retiring closes the old worker's scope BEFORE a new one can be built,
 *   so the process never holds more than one worker.
 */
export const makeAsyncIngest = (
	build: Effect.Effect<IngestClient, TransportError, Scope.Scope>,
): Effect.Effect<AsyncIngestHandle, never, Scope.Scope> =>
	Effect.gen(function*() {
		const parentScope = yield* Scope.Scope

		interface Slot {
			readonly scope: Scope.Closeable
			readonly ready: Deferred.Deferred<IngestClient, TransportError>
		}
		let slot: Slot | undefined

		const spawn: Effect.Effect<Slot> = Effect.gen(function*() {
			const scope = yield* Scope.fork(parentScope)
			const ready = yield* Deferred.make<IngestClient, TransportError>()
			const next: Slot = { scope, ready }
			slot = next
			yield* build.pipe(
				Scope.provide(scope),
				Effect.exit,
				Effect.flatMap((exit) =>
					Effect.gen(function*() {
						if (Exit.isFailure(exit)) {
							if (slot === next) slot = undefined
							yield* Scope.close(scope, exit)
						}
						yield* Deferred.done(ready, exit)
					})
				),
				Effect.forkIn(parentScope),
			)
			return next
		})

		const acquire: Effect.Effect<Slot> = Effect.suspend(() => slot ? Effect.succeed(slot) : spawn)

		const retire = (failed: Slot): Effect.Effect<void> =>
			Effect.suspend(() => {
				if (slot !== failed) return Effect.void
				slot = undefined
				return Scope.close(failed.scope, Exit.void)
			})

		const isTransportError = (error: unknown): boolean =>
			error instanceof RpcClientError || error instanceof WorkerError

		const call = <A, E>(f: (client: IngestClient) => Effect.Effect<A, E>): Effect.Effect<A, E | TransportError> =>
			Effect.flatMap(acquire, (current) =>
				Effect.flatMap(Deferred.await(current.ready), (client) =>
					Effect.tapError(f(client), (error) => isTransportError(error) ? retire(current) : Effect.void)
				)
			)

		const client = {
			ingestTraces: (input, options) => call((c) => c.ingestTraces(input, options)),
			ingestLogs: (input, options) => call((c) => c.ingestLogs(input, options)),
		} as IngestClient

		return { client, warmup: Effect.asVoid(acquire) }
	})

export const AsyncIngestLive = Layer.effect(
	AsyncIngest,
	Effect.gen(function*() {
		const handle = yield* makeAsyncIngest(buildWorkerClient)
		yield* handle.warmup
		return handle.client
	}),
)
