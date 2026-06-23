// SPDX-License-Identifier: Apache-2.0
//
// End-to-end proof of the headline guarantee: the PUBLISHED tarball installs
// with ZERO runtime dependencies and loads in a clean Node process.
//
// The unit suite (tests/packaging.test.ts) asserts the manifest *says* zero
// deps; this asserts the packed artifact actually *behaves* that way. It:
//   1. builds the bundle and `npm pack`s it,
//   2. installs the tarball into a throwaway consumer project (no other deps),
//   3. confirms nothing else landed in node_modules (no @opentelemetry/*),
//   4. imports the installed entry and checks the public surface loads.
//
// Step 4 is meaningful because the only host import (`openclaw/plugin-sdk`) is a
// lazy `await import()` inside register() — so the module must load standalone,
// with the OTel SDK resolved entirely from the inlined bundle. If a runtime dep
// ever creeps in, the install grows a node_modules entry and step 3 fails; if
// the bundle stops being self-contained, the import in step 4 throws.
//
// Run: `npm run verify:package` (also a CI job). Exits non-zero on any failure.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so the cwd is a native path on every OS — on
// Windows .pathname keeps a leading slash (/C:/…) and breaks execFileSync.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const fail = (msg) => {
  console.error(`\n✗ verify-package: ${msg}`);
  process.exit(1);
};

let work;
try {
  console.log("• building the bundle…");
  run("npm", ["run", "build"], repoRoot);

  work = mkdtempSync(join(tmpdir(), "ocotel-verify-"));

  console.log("• packing the tarball…");
  const packJson = run("npm", ["pack", "--json", "--pack-destination", work], repoRoot);
  let tarball;
  try {
    tarball = join(work, JSON.parse(packJson)[0].filename);
  } catch {
    fail(`could not parse \`npm pack --json\` output:\n${packJson.slice(0, 500)}`);
  }
  if (!existsSync(tarball)) fail(`npm pack did not produce ${tarball}`);

  // A bare consumer project — nothing depends on anything yet.
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }) + "\n",
  );

  console.log("• installing the tarball into a clean project…");
  // --ignore-scripts: the package has no lifecycle scripts, but never run
  // arbitrary install hooks during verification. --no-audit/--no-fund: offline,
  // quiet. A zero-dep package needs no registry round-trips.
  run("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], consumer);

  // Nothing but our own package may have been installed.
  const modules = join(consumer, "node_modules");
  const top = readdirSync(modules).filter((n) => !n.startsWith("."));
  const unexpected = top.filter((n) => n !== "@zotdotbot");
  if (unexpected.length) {
    fail(`unexpected packages installed (runtime deps leaked?): ${unexpected.join(", ")}`);
  }
  if (existsSync(join(modules, "@opentelemetry"))) {
    fail("@opentelemetry/* was installed — the OTel SDK is no longer inlined");
  }

  console.log("• importing the installed entry…");
  const entry = join(modules, "@zotdotbot", "openclaw-otel", "dist", "index.js");
  if (!existsSync(entry)) fail(`installed package is missing its entry point: ${entry}`);
  const mod = await import(pathToFileURL(entry).href);

  const plugin = mod.default;
  if (!plugin || plugin.id !== "openclaw-otel") fail("default export is not the openclaw-otel plugin");
  if (typeof plugin.register !== "function") fail("plugin.register is not a function");
  for (const name of ["injectTraceContext", "extractTraceContext", "propagationFields"]) {
    if (typeof mod[name] !== "function") fail(`missing public export: ${name}`);
  }

  console.log("\n✓ verify-package: tarball installs with zero runtime deps and loads cleanly.");
} catch (err) {
  fail(err?.message ?? String(err));
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
}
