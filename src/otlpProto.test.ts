import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import {
	decodeLogsExportRequest,
	decodeTraceExportRequest,
	encodeLogsExportRequest,
	encodeTraceExportRequest,
	isGzipContentEncoding,
	isProtobufContentType,
	maybeGunzip,
} from "./otlpProto.js"

const TRACE_ID = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00])
const SPAN_ID = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11])
const PARENT_SPAN_ID = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])

const TRACE_ID_HEX = "112233445566778899aabbccddeeff00"
const SPAN_ID_HEX = "aabbccddeeff0011"
const PARENT_SPAN_ID_HEX = "0102030405060708"

describe("decodeTraceExportRequest", () => {
	test("roundtrips a span and normalizes byte IDs to hex strings", () => {
		const bytes = encodeTraceExportRequest({
			resourceSpans: [
				{
					resource: { attributes: [{ key: "service.name", value: { stringValue: "test-svc" } }] },
					scopeSpans: [
						{
							scope: { name: "test-scope", version: "1.0" },
							spans: [
								{
									traceId: TRACE_ID,
									spanId: SPAN_ID,
									parentSpanId: PARENT_SPAN_ID,
									name: "GET /things",
									kind: 2,
									startTimeUnixNano: "1700000000000000000",
									endTimeUnixNano: "1700000000010000000",
								},
							],
						},
					],
				},
			],
		})

		const decoded = decodeTraceExportRequest(bytes) as unknown as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>
		}
		const span = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
		expect(span.traceId).toBe(TRACE_ID_HEX)
		expect(span.spanId).toBe(SPAN_ID_HEX)
		expect(span.parentSpanId).toBe(PARENT_SPAN_ID_HEX)
		expect(span.name).toBe("GET /things")
		// 64-bit timestamps survive as lossless decimal strings.
		expect(span.startTimeUnixNano).toBe("1700000000000000000")
	})

	test("normalizes nested link IDs to hex and bytesValue attributes to base64", () => {
		const bytes = encodeTraceExportRequest({
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{
									traceId: TRACE_ID,
									spanId: SPAN_ID,
									name: "with-link",
									attributes: [{ key: "payload", value: { bytesValue: Uint8Array.from([0x01, 0x02, 0x03]) } }],
									links: [{ traceId: TRACE_ID, spanId: PARENT_SPAN_ID }],
								},
							],
						},
					],
				},
			],
		})

		const decoded = decodeTraceExportRequest(bytes) as unknown as {
			resourceSpans: Array<{
				scopeSpans: Array<{
					spans: Array<{
						attributes: Array<{ value: { bytesValue: string } }>
						links: Array<{ traceId: string; spanId: string }>
					}>
				}>
			}>
		}
		const span = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
		expect(span.attributes[0]!.value.bytesValue).toBe(Buffer.from([0x01, 0x02, 0x03]).toString("base64"))
		expect(span.links[0]!.traceId).toBe(TRACE_ID_HEX)
		expect(span.links[0]!.spanId).toBe(PARENT_SPAN_ID_HEX)
	})

	test("strips parentSpanId when the wire value is absent", () => {
		const bytes = encodeTraceExportRequest({
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{ traceId: TRACE_ID, spanId: SPAN_ID, name: "root" },
							],
						},
					],
				},
			],
		})

		const decoded = decodeTraceExportRequest(bytes) as unknown as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>
		}
		const span = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
		expect("parentSpanId" in span).toBe(false)
	})

	test("drops spans missing traceId or spanId rather than emitting empty strings", () => {
		// proto3 omits empty bytes on the wire, so the decoder sees these
		// IDs as absent and the IDless spans should be filtered out.
		const bytes = encodeTraceExportRequest({
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{ traceId: new Uint8Array(0), spanId: SPAN_ID, name: "bad-trace" },
								{ traceId: TRACE_ID, spanId: new Uint8Array(0), name: "bad-span" },
								{ traceId: TRACE_ID, spanId: SPAN_ID, name: "good" },
							],
						},
					],
				},
			],
		})

		const decoded = decodeTraceExportRequest(bytes) as unknown as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
		}
		const spans = decoded.resourceSpans[0]!.scopeSpans[0]!.spans
		expect(spans.map((s) => s.name)).toEqual(["good"])
	})
})

describe("decodeLogsExportRequest", () => {
	test("hexifies trace/span correlation IDs when present and omits them otherwise", () => {
		const bytes = encodeLogsExportRequest({
			resourceLogs: [
				{
					scopeLogs: [
						{
							logRecords: [
								{ severityText: "INFO", body: { stringValue: "hello" }, traceId: TRACE_ID, spanId: SPAN_ID },
								{ severityText: "INFO", body: { stringValue: "no-correlation" } },
							],
						},
					],
				},
			],
		})

		const decoded = decodeLogsExportRequest(bytes) as unknown as {
			resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }> }>
		}
		const [withIds, withoutIds] = decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords
		expect(withIds!.traceId).toBe(TRACE_ID_HEX)
		expect(withIds!.spanId).toBe(SPAN_ID_HEX)
		expect("traceId" in withoutIds!).toBe(false)
		expect("spanId" in withoutIds!).toBe(false)
	})
})

describe("content negotiation helpers", () => {
	test("isProtobufContentType matches the two spelled OTLP variants", () => {
		expect(isProtobufContentType("application/x-protobuf")).toBe(true)
		expect(isProtobufContentType("application/protobuf")).toBe(true)
		expect(isProtobufContentType("application/x-protobuf; charset=utf-8")).toBe(true)
		expect(isProtobufContentType("application/json")).toBe(false)
		expect(isProtobufContentType(undefined)).toBe(false)
	})

	test("isGzipContentEncoding recognizes gzip in single and comma-listed values", () => {
		expect(isGzipContentEncoding("gzip")).toBe(true)
		expect(isGzipContentEncoding("GZIP")).toBe(true)
		expect(isGzipContentEncoding("gzip, br")).toBe(true)
		expect(isGzipContentEncoding("identity")).toBe(false)
		expect(isGzipContentEncoding(undefined)).toBe(false)
	})

	test("maybeGunzip decompresses gzipped bodies and passes plain bytes through", () => {
		const plain = new TextEncoder().encode(JSON.stringify({ hello: "world" }))
		const gzipped = new Uint8Array(gzipSync(plain))
		const out = maybeGunzip(gzipped, "gzip")
		expect(new TextDecoder().decode(out)).toBe('{"hello":"world"}')
		const passthrough = maybeGunzip(plain, undefined)
		expect(passthrough).toBe(plain)
	})

	test("a gzipped OTLP protobuf body roundtrips through maybeGunzip + decodeTraceExportRequest", () => {
		const bytes = encodeTraceExportRequest({
			resourceSpans: [
				{
					scopeSpans: [{ spans: [{ traceId: TRACE_ID, spanId: SPAN_ID, name: "compressed" }] }],
				},
			],
		})
		const gzipped = new Uint8Array(gzipSync(bytes))
		const decoded = decodeTraceExportRequest(maybeGunzip(gzipped, "gzip")) as unknown as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string }> }> }>
		}
		const span = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
		expect(span.name).toBe("compressed")
		expect(span.traceId).toBe(TRACE_ID_HEX)
	})
})
