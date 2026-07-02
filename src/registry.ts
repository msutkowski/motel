import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const MOTEL_VERSION = "0.1.0"
export const MOTEL_SERVICE_ID = "motel-local-server"

const stateHome = () =>
	process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state")

/**
 * The shared, machine-global motel state directory. Holds the SQLite
 * database, daemon log, daemon lock, and the per-pid instance registry.
 * One motel daemon serves every project on this machine — there is no
 * per-cwd state.
 */
export const motelStateDir = () => path.join(stateHome(), "motel")

export const registryDir = () => path.join(motelStateDir(), "instances")

export type RegistryEntry = {
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly startedAt: string
	readonly version: string
	/**
	 * The SQLite database path the daemon is serving. Optional because
	 * older daemon builds omit it; consumers should treat a missing
	 * value as "unknown" and fall back to whatever validation path
	 * they would have used before this field existed (typically an
	 * HTTP /api/health probe).
	 */
	readonly databasePath?: string
}

const entryPath = (pid: number) => path.join(registryDir(), `${pid}.json`)

export const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

export const listAliveEntries = (): RegistryEntry[] => {
	const dir = registryDir()
	let files: string[]
	try {
		files = fs.readdirSync(dir)
	} catch {
		return []
	}
	const alive: RegistryEntry[] = []
	for (const f of files) {
		if (!f.endsWith(".json")) continue
		const full = path.join(dir, f)
		try {
			const entry = JSON.parse(fs.readFileSync(full, "utf8")) as RegistryEntry
			if (isAlive(entry.pid)) {
				alive.push(entry)
			} else {
				try { fs.unlinkSync(full) } catch {}
			}
		} catch {
			try { fs.unlinkSync(full) } catch {}
		}
	}
	return alive
}

export const writeRegistryEntry = (entry: RegistryEntry) => {
	fs.mkdirSync(registryDir(), { recursive: true })
	const file = entryPath(entry.pid)
	fs.writeFileSync(file, JSON.stringify(entry, null, 2), "utf8")
}

/**
 * Remove this daemon's registry entry. Intended to be called from a
 * Layer release so the scope-managed server shutdown removes the entry
 * in the same finalizer chain that stops the socket. Historically this
 * was done via ad-hoc process-signal handlers installed here that ran
 * `process.exit(0)` — which races with the Effect runtime's own SIGINT
 * handling and short-circuits the Bun server's graceful stop. The
 * server (via BunRuntime.runMain) now owns signal handling; registry
 * cleanup rides along on scope release.
 */
export const removeRegistryEntry = (pid: number) => {
	try {
		fs.unlinkSync(entryPath(pid))
	} catch {
		// Already gone — another cleanup path won the race, or the entry
		// was never written.
	}
}

/**
 * Pick the live registry entry whose workdir is the deepest match for
 * `targetWorkdir` (prefix-matched on path separators). Mirrors
 * `pickByWorkdir` in `./daemon.ts` but lives here so it can be used by
 * code paths that must run before `./config.ts` is evaluated.
 */
export const pickRegistryEntryForWorkdir = (targetWorkdir: string): RegistryEntry | null => {
	const withSep = targetWorkdir.endsWith(path.sep) ? targetWorkdir : `${targetWorkdir}${path.sep}`
	return listAliveEntries()
		.filter((entry) => {
			const workdir = entry.workdir.endsWith(path.sep) ? entry.workdir : `${entry.workdir}${path.sep}`
			return withSep === workdir || withSep.startsWith(workdir)
		})
		.sort((a, b) => b.workdir.length - a.workdir.length)[0] ?? null
}

/**
 * Adopt the URL of an already-running daemon for the current workdir by
 * populating `MOTEL_OTEL_*` env vars before `./config.ts` is evaluated.
 *
 * Without this, the TUI process and the daemon process can disagree on
 * which port motel is serving on. The TUI reads SQLite directly so it
 * still sees data, but URL-producing commands like `o`/`O` (open in
 * browser) and `c` (copy OTLP setup instructions) emit URLs pointing at
 * the default port — a port nothing is listening on if the user started
 * the daemon on a non-default port.
 *
 * Only fills variables the caller hasn't already set. An explicit
 * `MOTEL_OTEL_BASE_URL` (or `MOTEL_OTEL_PORT`) on the command line
 * always wins.
 */
export const adoptRunningDaemonEnv = (): void => {
	if (process.env.MOTEL_OTEL_BASE_URL?.trim()) return
	if (process.env.MOTEL_OTEL_QUERY_URL?.trim()) return
	if (process.env.MOTEL_OTEL_PORT?.trim()) return
	const entry = pickRegistryEntryForWorkdir(process.cwd())
	if (!entry) return
	try {
		const parsed = new URL(entry.url)
		// Adopt the registry URL only if it carries an explicit port. A
		// portless URL would force us to guess (80 for http, 443 for
		// https) and almost certainly point at a port nothing is
		// listening on — worse than letting config.ts use its defaults.
		if (!parsed.port) return
		process.env.MOTEL_OTEL_BASE_URL = entry.url
		if (!process.env.MOTEL_OTEL_HOST?.trim()) process.env.MOTEL_OTEL_HOST = parsed.hostname
		process.env.MOTEL_OTEL_PORT = parsed.port
	} catch {
		// Registry entry has a malformed URL — leave env alone and let
		// config.ts resolve from its usual defaults.
	}
}
