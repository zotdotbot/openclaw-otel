// SPDX-License-Identifier: Apache-2.0
//
// Ambient declaration for OpenClaw's host-provided plugin SDK. This module is
// resolved at RUNTIME from the gateway (marked external in the esbuild bundle);
// it is not an installed dependency, so we declare only the surface we use.

declare module "openclaw/plugin-sdk" {
  /** Subscribe to PUBLIC OpenClaw diagnostic events; returns an unsubscribe
   *  function. Does not carry the internal `model.usage` event. */
  export const onDiagnosticEvent: (
    listener: (evt: Record<string, unknown>) => void,
  ) => () => void;
}

declare module "openclaw/plugin-sdk/diagnostic-runtime" {
  /** Subscribe to INTERNAL OpenClaw diagnostic events (including `model.usage`
   *  and `session.stalled`); returns an unsubscribe function. */
  export const onInternalDiagnosticEvent: (
    listener: (evt: Record<string, unknown>) => void,
  ) => () => void;
}

declare module "openclaw/plugin-sdk/heartbeat-runtime" {
  /** Subscribe to OpenClaw heartbeat-tick events on the in-process bus; returns
   *  an unsubscribe function. Payload carries status/reason/channel/durationMs. */
  export const onHeartbeatEvent: (
    listener: (evt: Record<string, unknown>) => void,
  ) => () => void;
}
