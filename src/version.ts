// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin version, surfaced as `service.version` on the emitted OTel Resource.
 * Keep in sync with package.json `version`.
 */
export const PLUGIN_VERSION = "0.2.1";

/** Stable plugin identity, surfaced as the `openclaw.plugin` resource attribute. */
export const PLUGIN_ID = "openclaw-otel";
