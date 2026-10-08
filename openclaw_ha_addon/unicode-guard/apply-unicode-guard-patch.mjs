#!/usr/bin/env node
// [openclaw-ha-addon unicode-guard v1.1] Build-time dist patch for OpenClaw.
//
// Implements OWASP LLM01:2026 Control #5 at ALL external-content ingest
// boundaries of the OpenClaw Gateway inside the HA add-on — including the
// spawned worker bundles (audit 2026-10-08, F1):
//
//   1. Replaces EVERY naive `stripInvisibleUnicode` copy in the dist tree —
//      top-level modules, the Gateway bundle, AND the minified worker bundles
//      (`dist/worker/worker.mjs`, `dist/worker/sqlite-store.worker.mjs`, each
//      with its own self-contained copy) — with the context-sensitive
//      implementation from `strip-invisible-unicode.mjs` (single source of
//      truth; fixes ZWJ-emoji destruction and the isolated-variation-selector
//      smuggling gap).
//   2. Patches EVERY `sanitizeExternalContentText` copy — the funnel used by
//      wrapExternalContent/wrapWebContent for web_search results, web_fetch
//      content, email/webhook/cron/browser/channel-metadata content and their
//      metadata fields — to strip invisible Unicode first.
//
// Anchor classes:
//   * Byte-exact anchors for the stable top-level copies (tabs significant).
//   * Whitespace- and parameter-tolerant regex anchors for minified worker
//     copies (the captured parameter name is re-used in the replacement, so
//     any minifier renaming still patches correctly).
//
// F1 (audit 2026-10-08): after patching, a UNIVERSALITY SWEEP runs recursively
// over the ENTIRE dist tree (.mjs/.js) and fails the build LOUDLY (exit 1 with
// a file list) when ANY naive remnant of either target survives — including
// drifted forms the patch anchors no longer recognize. Coverage is a
// universality quantor, not an existence check: a security control must never
// disappear silently.
//
// Usage:
//   node apply-unicode-guard-patch.mjs [openclaw-install-dir] [--backup]
//     openclaw-install-dir  default: /usr/lib/node_modules/openclaw
//     --backup              write <file>.oc-unicode-guard.bak next to each
//                           patched file (for live patches; not needed at
//                           build time where the image layer is the baseline).
//
// Idempotent: re-runs detect the patched state and only re-assert universality.
//
// Maintenance: on an OpenClaw version bump this script runs in the Docker build
// right after `npm install -g openclaw@<version>`. If anchors or the sweep
// fail, port them to the new dist layout — never skip: a skipped patch or
// sweep is a silently lost security control. If upstream ships a native fix,
// REMOVE this patch block (the sweep will fail loudly until you do, which is
// the intended decision trigger).

import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_MARKER = "// [openclaw-ha-addon unicode-guard v1]";
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const backup = args.includes("--backup");
const installDir = args.find((arg) => !arg.startsWith("--")) ?? "/usr/lib/node_modules/openclaw";
const distDir = join(installDir, "dist");

function fail(message) {
	console.error(`ERROR: ${message}`);
	process.exit(1);
}

// --- 1. Load the canonical implementation region (single source of truth). ---
const libraryPath = join(here, "strip-invisible-unicode.mjs");
if (!existsSync(libraryPath)) fail(`canonical implementation not found: ${libraryPath}`);
const librarySource = readFileSync(libraryPath, "utf8");
const regionMatch = librarySource.match(/\/\/#region openclaw-ha-addon-unicode-guard-impl\r?\n([\s\S]*?)\/\/#endregion/);
if (!regionMatch) fail("impl region marker not found in strip-invisible-unicode.mjs");
const impl = regionMatch[1].trimEnd() + "\n";
if (!impl.includes("function stripInvisibleUnicode(text) {")) fail("impl region does not define stripInvisibleUnicode");
if (!impl.includes(PATCH_MARKER)) fail("impl region does not carry the patch marker comment");

// --- 2. Anchors. Byte-exact (top-level dist, tabs significant) first, then
//        minify/format-tolerant regex anchors (workers, drift). ---
const ANCHOR_NAIVE_FN = 'function stripInvisibleUnicode(text) {\n\treturn text.replace(INVISIBLE_UNICODE_RE, "");\n}';
const ANCHOR_SANITIZE_OLD = 'function sanitizeExternalContentText(content) {\n\treturn sanitizeModelSpecialTokens(replaceMarkers(content));\n}';
const ANCHOR_SANITIZE_NEW =
	'function sanitizeExternalContentText(content) {\n\treturn sanitizeModelSpecialTokens(replaceMarkers(stripInvisibleUnicode(content)));\n}';
const RE_NAIVE_STRIP = /function\s+stripInvisibleUnicode\(\s*(\w+)\s*\)\s*\{\s*return\s+\1\.replace\(\s*INVISIBLE_UNICODE_RE\s*,\s*(""|''|``)\s*\)\s*;?\s*\}/g;
const RE_NAIVE_SANITIZE = /function\s+sanitizeExternalContentText\(\s*(\w+)\s*\)\s*\{\s*return\s+sanitizeModelSpecialTokens\(\s*replaceMarkers\(\s*\1\s*\)\s*\)\s*;?\s*\}/g;
// F2 (audit): import detection must match the exact binding, not just any
// import from the module — otherwise a future import of a different symbol
// would silently leave the sanitize call unbound (runtime ReferenceError).
const RE_STRIP_IMPORT_BINDING = /import\s*\{\s*t\s+as\s+stripInvisibleUnicode\s*\}\s*from\s*"\.\/unicode-visibility-/;
const RE_LOCAL_STRIP_DEF = /function\s+stripInvisibleUnicode\s*\(/;
const RE_PATCHED_SANITIZE_CALL = /replaceMarkers\(\s*stripInvisibleUnicode\s*\(/;
// Universality-sweep markers (non-quantor safety: /g only via String.match).
const RE_SWEEP_STRIP_CALL = /\.replace\(\s*INVISIBLE_UNICODE_RE\b/g;
const RE_SWEEP_STRIP_DEF = /function\s+stripInvisibleUnicode\s*\(/g;
const RE_SWEEP_STRIP_PATCHED_IMPL = /UNICODE_GUARD_SCAN_RE\.test/g;
const RE_SWEEP_SANITIZE_NAIVE_FORM = /function\s+sanitizeExternalContentText\(\s*\w+\s*\)\s*\{\s*return\s+sanitizeModelSpecialTokens\(\s*replaceMarkers\(\s*\w+\s*\)\s*\)\s*\}/;
const RE_SWEEP_SANITIZE_DEF = /function\s+sanitizeExternalContentText\s*\(/g;
const RE_SWEEP_SANITIZE_PATCHED_CALL = /replaceMarkers\(\s*stripInvisibleUnicode\s*\(/g;

if (!existsSync(distDir)) fail(`OpenClaw dist directory not found: ${distDir} (is openclaw installed?)`);

// --- 3. Recursive walk over the ENTIRE dist tree (audit F1: never top-level only). ---
function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const entryPath = join(dir, entry.name);
		let isDir = entry.isDirectory();
		if (!isDir && entry.isSymbolicLink()) {
			try {
				isDir = statSync(entryPath).isDirectory();
			} catch {
				isDir = false;
			}
		}
		if (isDir) files.push(...walk(entryPath));
		else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) files.push(entryPath);
	}
	return files;
}

const distFiles = walk(distDir);
const unicodeVisibilityRel = distFiles
	.map((f) => relative(distDir, f))
	.filter((rel) => /(^|\/)unicode-visibility-[^/]*\.mjs$/.test(rel));
if (unicodeVisibilityRel.length !== 1) {
	fail(`expected exactly one unicode-visibility-*.mjs in the dist tree, found ${unicodeVisibilityRel.length}`);
}
const unicodeVisibilityName = unicodeVisibilityRel[0].split("/").pop();

let stripPatched = 0;
let stripAlready = 0;
let sanitizePatched = 0;
let sanitizeAlready = 0;
const modified = [];

for (const filePath of distFiles) {
	const rel = relative(distDir, filePath);
	const original = readFileSync(filePath, "utf8");
	let content = original;
	let changed = false;

	// --- Patch site A: replace every naive stripInvisibleUnicode copy. ---
	const naiveByteCount = content.split(ANCHOR_NAIVE_FN).length - 1;
	const naiveRegexMatches = [...content.matchAll(RE_NAIVE_STRIP)];
	if (naiveByteCount > 0 && content.includes(PATCH_MARKER)) {
		fail(`${rel}: inconsistent state — byte anchor and patch marker both present`);
	}
	if (naiveByteCount > 0) {
		if (naiveByteCount !== 1) fail(`${rel}: expected exactly 1 byte-exact naive strip anchor, found ${naiveByteCount}`);
		if (content.includes("unicodeGuard") && !content.includes(PATCH_MARKER)) {
			fail(`${rel}: unexpected pre-existing unicodeGuard symbols — refusing to patch blind`);
		}
		if (backup) copyFileSync(filePath, `${filePath}.oc-unicode-guard.bak`);
		content = content.replace(ANCHOR_NAIVE_FN, () => impl);
		changed = true;
		stripPatched += 1;
		console.log(`patched stripInvisibleUnicode (byte anchor): ${rel}`);
	} else if (naiveRegexMatches.length > 0) {
		if (content.includes(PATCH_MARKER) && RE_LOCAL_STRIP_DEF.test(content)) {
			fail(`${rel}: already carries a patched copy but contains another naive copy — manual re-port required`);
		}
		if (naiveRegexMatches.length > 1) {
			fail(`${rel}: ${naiveRegexMatches.length} minified naive strip copies in one file — manual re-port required`);
		}
		if (content.includes("unicodeGuard") && !content.includes(PATCH_MARKER)) {
			fail(`${rel}: unexpected pre-existing unicodeGuard symbols — refusing to patch blind`);
		}
		if (backup) copyFileSync(filePath, `${filePath}.oc-unicode-guard.bak`);
		content = content.replace(RE_NAIVE_STRIP, () => impl);
		changed = true;
		stripPatched += 1;
		console.log(`patched stripInvisibleUnicode (regex anchor, param "${naiveRegexMatches[0][1]}"): ${rel}`);
	} else if (content.includes(PATCH_MARKER) && RE_LOCAL_STRIP_DEF.test(content)) {
		stripAlready += 1;
	}

	// --- Patch site B: strip at every sanitizeExternalContentText boundary. ---
	const sanitizeOldCount = content.split(ANCHOR_SANITIZE_OLD).length - 1;
	const sanitizeNewCount = content.split(ANCHOR_SANITIZE_NEW).length - 1;
	const sanitizeRegexMatches = [...content.matchAll(RE_NAIVE_SANITIZE)];
	if (sanitizeOldCount > 0) {
		if (sanitizeOldCount !== 1) fail(`${rel}: expected exactly 1 byte-exact sanitize anchor, found ${sanitizeOldCount}`);
		if (backup) copyFileSync(filePath, `${filePath}.oc-unicode-guard.bak`);
		content = content.replace(ANCHOR_SANITIZE_OLD, () => ANCHOR_SANITIZE_NEW);
		changed = true;
		sanitizePatched += 1;
		console.log(`patched sanitizeExternalContentText (byte anchor): ${rel}`);
	} else if (sanitizeRegexMatches.length > 0) {
		if (RE_PATCHED_SANITIZE_CALL.test(content)) {
			fail(`${rel}: already carries a patched sanitize call but contains another naive copy — manual re-port required`);
		}
		if (sanitizeRegexMatches.length > 1) {
			fail(`${rel}: ${sanitizeRegexMatches.length} minified naive sanitize copies in one file — manual re-port required`);
		}
		const param = sanitizeRegexMatches[0][1];
		if (backup) copyFileSync(filePath, `${filePath}.oc-unicode-guard.bak`);
		content = content.replace(
			RE_NAIVE_SANITIZE,
			() => `function sanitizeExternalContentText(${param}){return sanitizeModelSpecialTokens(replaceMarkers(stripInvisibleUnicode(${param})))}`,
		);
		changed = true;
		sanitizePatched += 1;
		console.log(`patched sanitizeExternalContentText (regex anchor, param "${param}"): ${rel}`);
	} else if (sanitizeNewCount > 0 || RE_PATCHED_SANITIZE_CALL.test(content)) {
		sanitizeAlready += 1;
	}

	// --- F2: ensure stripInvisibleUnicode is in scope for the sanitize call. ---
	const sanitizeHandled =
		sanitizeOldCount > 0 || sanitizeNewCount > 0 || sanitizeRegexMatches.length > 0 || RE_PATCHED_SANITIZE_CALL.test(content);
	if (sanitizeHandled) {
		const hasLocalDef = RE_LOCAL_STRIP_DEF.test(content);
		const hasImport = RE_STRIP_IMPORT_BINDING.test(content);
		if (!hasLocalDef && !hasImport) {
			const importLine = `import { t as stripInvisibleUnicode } from "./${unicodeVisibilityName}";\n`;
			content = importLine + content;
			changed = true;
			console.log(`injected unicode-visibility import (exact binding): ${rel}`);
		}
	}

	if (!changed) continue;

	// --- Contract checks before writing. ---
	if (rel === unicodeVisibilityRel[0] && !content.includes("export { stripInvisibleUnicode as t };")) {
		fail(`${rel}: export contract 'export { stripInvisibleUnicode as t };' lost after patching`);
	}
	writeFileSync(filePath, content);
	modified.push(rel);
}

// --- 4. Syntax-check every modified file (loud failure, never a broken dist). ---
for (const rel of modified) {
	const check = spawnSync(process.execPath, ["--check", join(distDir, rel)], { encoding: "utf8" });
	if (check.status !== 0) fail(`node --check failed for ${rel}:\n${check.stderr}`);
	console.log(`node --check ok: ${rel}`);
}

// --- 5. Global coverage floor (existence sanity; universality is checked below). ---
if (stripPatched === 0 && stripAlready === 0) {
	fail("no stripInvisibleUnicode site patched or present — OpenClaw dist layout changed, re-port required");
}
if (sanitizePatched === 0 && sanitizeAlready === 0) {
	fail("no sanitizeExternalContentText site patched or present — external-content boundary patch not applied, re-port required");
}

// --- 6. F1: UNIVERSALITY SWEEP — recursive over the entire dist tree. ---
//     Post-patch there must be ZERO naive remnants, in ANY form:
//       STRIP-1: any behavioral naive call (`.replace(INVISIBLE_UNICODE_RE, …)`)
//       STRIP-2: every stripInvisibleUnicode definition must be a patched impl
//       SAN-1:   canonical naive sanitizeExternalContentText body
//       SAN-2:   every sanitizeExternalContentText definition must carry the
//                patched `replaceMarkers(stripInvisibleUnicode(…))` call
const findings = [];
for (const filePath of distFiles) {
	const rel = relative(distDir, filePath);
	const content = readFileSync(filePath, "utf8");
	const stripCalls = content.match(RE_SWEEP_STRIP_CALL)?.length ?? 0;
	if (stripCalls > 0) findings.push(`${rel}: ${stripCalls} naive strip call(s) [replace(INVISIBLE_UNICODE_RE,…)]`);
	const stripDefs = content.match(RE_SWEEP_STRIP_DEF)?.length ?? 0;
	const stripImpls = content.match(RE_SWEEP_STRIP_PATCHED_IMPL)?.length ?? 0;
	if (stripDefs !== stripImpls) {
		findings.push(`${rel}: ${stripDefs} stripInvisibleUnicode definition(s) but ${stripImpls} patched implementation(s)`);
	}
	if (RE_SWEEP_SANITIZE_NAIVE_FORM.test(content)) findings.push(`${rel}: naive sanitizeExternalContentText body`);
	const sanitizeDefs = content.match(RE_SWEEP_SANITIZE_DEF)?.length ?? 0;
	const sanitizePatchedCalls = content.match(RE_SWEEP_SANITIZE_PATCHED_CALL)?.length ?? 0;
	if (sanitizeDefs !== sanitizePatchedCalls) {
		findings.push(`${rel}: ${sanitizeDefs} sanitizeExternalContentText definition(s) but ${sanitizePatchedCalls} patched call(s)`);
	}
}
if (findings.length > 0) {
	console.error("ERROR: universality sweep FAILED — naive invisible-unicode copies remain in the dist tree:");
	for (const finding of findings) console.error(`  - ${finding}`);
	console.error("Re-port apply-unicode-guard-patch.mjs to the current OpenClaw dist layout. Never ship a silent coverage gap.");
	process.exit(1);
}

console.log(`universality sweep: 0 naive remnants across ${distFiles.length} dist files`);
console.log(
	[
		`unicode-guard patch complete: stripInvisibleUnicode ${stripPatched} patched / ${stripAlready} already,`,
		`sanitizeExternalContentText ${sanitizePatched} patched / ${sanitizeAlready} already,`,
		`${modified.length} file(s) written, ${modified.length} syntax-checked.`,
	].join(" "),
);