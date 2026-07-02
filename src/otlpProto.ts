/**
 * Decodes OTLP/HTTP protobuf bodies into the OTLP/JSON canonical shape
 * that the rest of motel already speaks.
 *
 * We decode with the official OTLP descriptors shipped in
 * `@opentelemetry/otlp-transformer` (the same generated protobufjs root
 * the OTel SDK uses) instead of maintaining a parallel `.proto`. That
 * tracks the spec automatically and skips a runtime `.proto` parse.
 *
 * `protobufjs.toObject` with `bytes: Array` emits every bytes field as a
 * `number[]`. OTLP/JSON instead wants trace/span IDs as lowercase hex
 * and `AnyValue.bytesValue` as base64, so `normalizeProtobufJson` walks
 * the decoded tree and rewrites those fields by name — which also fixes
 * the IDs nested inside span links, not just the top-level span IDs.
 *
 * Why protobuf at all: the Erlang `opentelemetry_exporter` (used by every
 * Elixir/Erlang OTel app) only implements `http_protobuf` and `grpc`; its
 * `http_json` branch returns `{error, unimplemented}`. Most non-JS SDKs
 * default to protobuf too. Accepting it here is what lets motel ingest
 * from those services without a sidecar collector.
 */
import { gunzipSync } from "node:zlib"
// Deep import: the generated descriptors aren't re-exported from the
// package root, so we reach into the build output and cast below.
import root from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "./otlp.js"

type ProtobufMessageType = {
	decode: (bytes: Uint8Array) => unknown
	create: (message: unknown) => unknown
	encode: (message: unknown) => { finish: () => Uint8Array }
	toObject: (message: unknown, options: { readonly bytes: ArrayConstructor; readonly longs: StringConstructor }) => unknown
}

const otlpRoot = root as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly trace: { readonly v1: { readonly ExportTraceServiceRequest: ProtobufMessageType } }
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: ProtobufMessageType } }
			}
		}
	}
}

const ExportTraceServiceRequest = otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
const ExportLogsServiceRequest = otlpRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest

// `longs: String` keeps 64-bit nanosecond timestamps lossless (OTLP/JSON
// carries them as decimal strings); `bytes: Array` gives us number[] that
// normalizeProtobufJson rewrites into the OTLP/JSON encodings below.
const toObjectOptions = { bytes: Array, longs: String } as const

const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"])

/**
 * Rewrite the bytes fields of a `toObject` result in place to their
 * OTLP/JSON encodings: trace/span correlation IDs to lowercase hex,
 * opaque `AnyValue.bytesValue` payloads to base64. Keyed on field name
 * so it applies uniformly however deeply nested (e.g. `Link.traceId`).
 * Mutates the freshly-decoded tree rather than rebuilding it, since the
 * objects are ours and this runs on the ingest hot path.
 */
const normalizeProtobufJson = (obj: Record<string, unknown>): Record<string, unknown> => {
	for (const key of Object.keys(obj)) {
		const value = obj[key]
		if (Array.isArray(value)) {
			if (ID_FIELDS.has(key)) obj[key] = Buffer.from(value as number[]).toString("hex")
			else if (key === "bytesValue") obj[key] = Buffer.from(value as number[]).toString("base64")
			else for (const entry of value) if (entry && typeof entry === "object") normalizeProtobufJson(entry as Record<string, unknown>)
		} else if (value && typeof value === "object") {
			normalizeProtobufJson(value as Record<string, unknown>)
		}
	}
	return obj
}

const decodeRequest = (service: ProtobufMessageType, body: Uint8Array): Record<string, unknown> =>
	normalizeProtobufJson(service.toObject(service.decode(body), toObjectOptions) as Record<string, unknown>)

export const decodeTraceExportRequest = (body: Uint8Array): OtlpTraceExportRequest => {
	const obj = decodeRequest(ExportTraceServiceRequest, body) as {
		resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }>
	}
	// Drop spans without a usable trace/span ID rather than letting a
	// malformed exporter write IDless rows into the store. An explicitly
	// empty bytes field decodes to "", so require a non-empty hex ID.
	const hasId = (value: unknown): value is string => typeof value === "string" && value.length > 0
	for (const rs of obj.resourceSpans ?? []) {
		for (const ss of rs.scopeSpans ?? []) {
			if (ss.spans) {
				ss.spans = ss.spans.filter((span) => hasId(span.traceId) && hasId(span.spanId))
			}
		}
	}
	return obj as unknown as OtlpTraceExportRequest
}

export const decodeLogsExportRequest = (body: Uint8Array): OtlpLogExportRequest =>
	decodeRequest(ExportLogsServiceRequest, body) as unknown as OtlpLogExportRequest

export const isProtobufContentType = (contentType: string | undefined): boolean => {
	// Match the bare media type so `application/x-protobuf; charset=...`
	// (and odd casing) still counts.
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
	return mediaType === "application/x-protobuf" || mediaType === "application/protobuf"
}

/**
 * OTLP/HTTP allows the exporter to gzip the body and signal via
 * `Content-Encoding: gzip`. Many SDKs do this by default (the Node SDK
 * gzips above ~1KB, the Erlang exporter gzips unconditionally when
 * `otel_exporter_otlp_compression=gzip` is set, which is a common
 * config). Without honoring this header, those exporters get a 500
 * because protobuf decode (or `JSON.parse`) chokes on compressed bytes.
 */
export const isGzipContentEncoding = (contentEncoding: string | undefined): boolean => {
	if (!contentEncoding) return false
	return contentEncoding.toLowerCase().split(",").map((s) => s.trim()).includes("gzip")
}

export const maybeGunzip = (bytes: Uint8Array, contentEncoding: string | undefined): Uint8Array =>
	isGzipContentEncoding(contentEncoding) ? new Uint8Array(gunzipSync(bytes)) : bytes

/**
 * Exposed for tests: encode an OTLP/HTTP protobuf body using the same
 * official descriptors the decoder uses, so a roundtrip test exercises
 * the real wire format without maintaining a parallel proto definition.
 */
export const encodeTraceExportRequest = (payload: unknown): Uint8Array =>
	ExportTraceServiceRequest.encode(ExportTraceServiceRequest.create(payload)).finish()

export const encodeLogsExportRequest = (payload: unknown): Uint8Array =>
	ExportLogsServiceRequest.encode(ExportLogsServiceRequest.create(payload)).finish()
