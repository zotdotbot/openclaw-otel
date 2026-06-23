// SPDX-License-Identifier: Apache-2.0

/**
 * W3C trace-context propagation helpers (`traceparent` + `tracestate` +
 * baggage), usable WITHOUT the plugin's register lifecycle so user code (custom
 * RPC, message queues, sub-agent transports) can carry trace context across
 * process boundaries.
 *
 * Consistent with the rest of the plugin, this uses a LOCAL composite
 * propagator instance and never registers a global one. There is also no global
 * context manager, so `context.active()` is just ROOT — pass the span's Context
 * explicitly (e.g. `trace.setSpan(ROOT_CONTEXT, span)`) to inject a real
 * `traceparent`.
 */

import {
  context as otelContext,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Context,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

/** A mutable header bag (e.g. outgoing HTTP headers, a message envelope). */
export interface HeaderCarrier {
  [key: string]: string | string[] | undefined;
}

const propagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

/**
 * Inject the trace context from `ctx` (default: the active context, which is
 * ROOT without a context manager — so pass the span's context) into `carrier`
 * as W3C `traceparent` / `tracestate` headers.
 */
export function injectTraceContext(carrier: HeaderCarrier, ctx?: Context): void {
  propagator.inject(ctx ?? otelContext.active(), carrier, defaultTextMapSetter);
}

/**
 * Extract a trace context from `carrier`'s W3C headers, returning a Context
 * (based on `ctx`, default the active context) that a new span can parent to.
 */
export function extractTraceContext(carrier: HeaderCarrier, ctx?: Context): Context {
  return propagator.extract(ctx ?? otelContext.active(), carrier, defaultTextMapGetter);
}

/** The carrier header keys this propagator reads/writes (e.g. `traceparent`). */
export function propagationFields(): string[] {
  return propagator.fields();
}
