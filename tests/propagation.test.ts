// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { trace, ROOT_CONTEXT } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import {
  injectTraceContext,
  extractTraceContext,
  propagationFields,
} from "../src/propagation";

describe("trace-context propagation", () => {
  it("round-trips a span's trace context through a header carrier", () => {
    const tracer = new NodeTracerProvider().getTracer("test");
    const span = tracer.startSpan("s");
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    const carrier: Record<string, string> = {};
    injectTraceContext(carrier, ctx);
    expect(typeof carrier.traceparent).toBe("string");
    expect(carrier.traceparent).toContain(span.spanContext().traceId);

    const extracted = extractTraceContext(carrier);
    const sc = trace.getSpanContext(extracted)!;
    expect(sc.traceId).toBe(span.spanContext().traceId);
    expect(sc.spanId).toBe(span.spanContext().spanId);
    span.end();
  });

  it("exposes the W3C carrier fields", () => {
    expect(propagationFields()).toContain("traceparent");
  });
});
