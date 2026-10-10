/**
 * Side-effect-only bootstrap: when imported, fills `MOTEL_OTEL_*` env
 * vars from any live daemon registry entry that matches this workdir.
 *
 * Must be imported BEFORE `./config.js` (or anything that transitively
 * imports it, like `./daemon.js`). `./config.js` captures
 * `MOTEL_OTEL_BASE_URL` into a top-level const at evaluation time, so
 * later mutations to `process.env` don't change URL helpers — the env
 * has to be correct at import time.
 *
 * Has no effect when the caller already set `MOTEL_OTEL_BASE_URL` /
 * `MOTEL_OTEL_PORT` / `MOTEL_OTEL_QUERY_URL` explicitly; explicit env
 * always wins.
 */
import { adoptRunningDaemonEnv } from "./registry.js"

adoptRunningDaemonEnv()
