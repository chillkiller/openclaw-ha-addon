#!/usr/bin/env node
// [openclaw-ha-addon agent-db-admission-guard v1] Build-time patch for the
// OpenClaw runtime.
//
// Root cause (measured on HA-.68, 2026-11-27): the runtime prepares every agent
// database (schema, integrity, FTS repair) before it admits the agents. On a
// large state that work needs minutes, but the startup read path only waits
//
//     const STARTUP_READ_WAIT_MS = 2e4;   // 20 s
//
// for it and then refuses the read with
// "agent-database-inspection-pending". The gateway then aborts before it binds
// its listener, and every restart starts the preparation over.
//
// The patch makes the budget configurable and keeps the upstream default, so
// the behaviour is unchanged unless the add-on asks for a longer wait:
//
//     const STARTUP_READ_WAIT_MS = Number(process.env.OPENCLAW_STARTUP_READ_WAIT_MS ?? 2e4);
//
// Like the unicode-guard patch it fails LOUDLY when the anchor is gone: a
// silently skipped patch would be a silently lost control.
//
// Usage: node apply-agent-db-admission-guard-patch.mjs [openclaw-install-dir]

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PATCH_MARKER = "// [openclaw-ha-addon agent-db-admission-guard v1]";
const ANCHOR = "const STARTUP_READ_WAIT_MS=2e4;";
const REPLACEMENT =
  "const STARTUP_READ_WAIT_MS=Number(process.env.OPENCLAW_STARTUP_READ_WAIT_MS??2e4);" +
  ` ${PATCH_MARKER}`;

const installDir = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  "/usr/lib/node_modules/openclaw";
const distDir = join(installDir, "dist");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(distDir)) {
  fail(`OpenClaw dist directory not found: ${distDir} (is openclaw installed?)`);
}

const candidates = readdirSync(distDir).filter(
  (name) => /^request-authorization-.*\.mjs$/.test(name),
);
if (candidates.length === 0) {
  fail("no request-authorization-*.mjs in the dist tree - the runtime layout changed");
}

let patched = 0;
let skipped = 0;
let anchored = 0;
for (const name of candidates) {
  const filePath = join(distDir, name);
  const original = readFileSync(filePath, "utf8");
  if (original.includes(PATCH_MARKER)) {
    skipped += 1;
    anchored += 1;
    continue;
  }
  // Not every chunk of the runtime carries the anchor; only the one that
  // defines the constant is patched.
  if (!original.includes(ANCHOR)) {
    continue;
  }
  anchored += 1;
  const updated = original.replace(ANCHOR, REPLACEMENT);
  writeFileSync(filePath, updated);
  const check = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  if (check.status !== 0) {
    fail(`node --check failed for ${name}:\n${check.stderr}`);
  }
  console.log(`patched startup read wait (configurable budget): ${name}`);
  patched += 1;
}

if (anchored === 0) {
  fail(
    `anchor '${ANCHOR}' not found in any request-authorization-*.mjs - ` +
      "re-port the patch for this OpenClaw version",
  );
}

console.log(
  `agent-db-admission-guard patch complete: ${patched} patched, ${skipped} already patched.`,
);
