#!/usr/bin/env bun

// MUST come before any import that transitively pulls in ./config.js
// (e.g. ./daemon.js below). The bootstrap fills MOTEL_OTEL_* env from
// the live daemon registry so URL helpers in the TUI point at the
// actually-running daemon, not the default port.
import "./registryEnvBootstrap.js"

import { Effect } from "effect"
import { applyManagedDaemonEnv, ensureManagedDaemon, getManagedDaemonStatus, resetManagedDaemon, stopManagedDaemon } from "./daemon.js"

const [command, ...args] = process.argv.slice(2)

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

switch (command) {
case undefined:
case "tui":
case "ui": {
	await run(applyManagedDaemonEnv)
	await import("./index.js")
	break
}

case "daemon":
case "start": {
	const status = await run(ensureManagedDaemon)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "status": {
	const status = await run(getManagedDaemonStatus)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "stop": {
	const status = await run(stopManagedDaemon)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "reset": {
	// Destructive: stops the daemon, deletes the SQLite database, and
	// starts a fresh daemon. Useful when retention can't keep up or
	// you just want to start clean.
	const status = await run(resetManagedDaemon)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "restart": {
	// Stop any running managed daemon, then start a fresh one + launch the
	// TUI. Handy during local development when you've rebuilt the server
	// and want the TUI to reconnect to the new binary in one command.
	await run(stopManagedDaemon)
	await run(applyManagedDaemonEnv)
	await import("./index.js")
	break
}

case "server": {
	await run(applyManagedDaemonEnv)
	await import("./server.js")
	break
}

case "mcp": {
	await import("./mcp.js")
	break
}

case "help":
case "--help":
case "-h": {
	console.log(`Usage:
	motel
	motel tui
	motel daemon
	motel status
	motel stop
	motel restart
	motel reset
	motel server
	motel mcp
	motel services
	motel traces [service] [limit]
	motel trace <trace-id>
	motel span <span-id>
	motel trace-spans <trace-id>
	motel search-spans [service] [operation] [parent=<operation>] [attr.key=value ...]
	motel search-traces [service] [operation] [attr.key=value ...]
	motel trace-stats <groupBy> <agg> [service] [attr.key=value ...]
	motel logs [service]
	motel search-logs [service] [body] [attr.key=value ...]
	motel log-stats <groupBy> [service] [attr.key=value ...]
	motel trace-logs <trace-id>
	motel span-logs <span-id>
	motel facets <traces|logs> <field>
	motel instructions
	motel endpoints`)
	break
}

default: {
	await run(applyManagedDaemonEnv)
	process.argv = [process.argv[0]!, process.argv[1]!, command, ...args]
	await import("./cli.js")
	break
}
}
