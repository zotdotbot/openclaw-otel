// SPDX-License-Identifier: Apache-2.0
// Bundles the plugin into ONE self-contained ESM file at dist/index.js.
//
// Design: the published plugin has ZERO runtime dependencies. Every
// @opentelemetry/* package is inlined at build time. This is safe — and
// deliberately different from in-tree OpenClaw plugins — because the plugin
// uses OTel provider INSTANCES directly (it never calls
// setGlobalTracerProvider) and never shares OTel context with the host
// process. A private, bundled copy of the OTel SDK is therefore internally
// consistent and sidesteps the @opentelemetry/api globalThis-singleton /
// node_modules-symlink problems that plague plugins which register globally.
//
// The only externals are the host-provided OpenClaw modules, which MUST be
// resolved from the gateway at runtime and must never be bundled.

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/index.js",
  sourcemap: true,
  logLevel: "info",
  // Host-provided OpenClaw APIs — resolve at runtime, never bundle.
  external: ["openclaw", "openclaw/*"],
  // The OTel SDK and grpc-js are CommonJS and `require()` Node built-ins.
  // In an ESM bundle there is no ambient `require`, so esbuild's __require
  // shim throws "Dynamic require of 'util' is not supported". Inject a real
  // createRequire-backed `require` at the top — the shim picks it up.
  banner: {
    js: "import { createRequire as __ocCreateRequire } from 'node:module'; const require = __ocCreateRequire(import.meta.url);",
  },
});

// ── Post-build sanity check ──────────────────────────────────────────────────
// Load the freshly-built bundle and confirm it exposes the plugin default export
// + the public propagation helpers, so a broken build fails HERE (and on
// prepublishOnly) instead of silently shipping. Full install verification (zero
// runtime deps, clean-project install) remains in `npm run verify:package`.
const fail = (msg) => {
  console.error(`✗ build sanity check failed: ${msg}`);
  process.exit(1);
};
const mod = await import(pathToFileURL(resolve("dist/index.js")).href);
if (!mod.default || mod.default.id !== "openclaw-otel") {
  fail("default export is not the openclaw-otel plugin");
}
for (const name of ["injectTraceContext", "extractTraceContext", "propagationFields"]) {
  if (typeof mod[name] !== "function") fail(`missing public export: ${name}`);
}
// One behavioral assertion so the check fails on a stubbed/broken export, not
// just a missing one: propagationFields() must return the W3C carrier keys.
const fields = mod.propagationFields();
if (!Array.isArray(fields) || !fields.includes("traceparent")) {
  fail("propagationFields() did not return the expected W3C carrier keys");
}
console.log("✓ build sanity check: plugin default export + working propagation helpers present");
