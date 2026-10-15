#!/usr/bin/env node
// [openclaw-ha-addon ciao-mdns-guard v1] Build-time dist patch for @homebridge/ciao.
//
// Root cause (live-verified 2026-10-15, v0.7.13.30 boot): ciao's
// CiaoService.rebuildServiceRecords() keys `reverseAddressPTRs` with the RAW
// `os.networkInterfaces()` address strings (Node emits the FULL form, e.g.
// `fd12:8ca5:a145:0:872:3e15:dee0:e044`), while every INBOUND AAAA rdata is
// decoded through `shortenIPv6` (RFC-compressed, e.g.
// `fd12:8ca5:a145::872:3e15:dee0:e044`). `hasAddress()` is a raw string map
// lookup, so ciao's own address (typically the ULA — on HAOS/FRITZ!Box every
// LAN interface carries `fd12:8ca5:a145::/48`) looks FOREIGN in the
// RFC 6762 9 conflict check. Every reflection of ciao's own announcement is
// then treated as a conflicting record: probe → rename ("name (N)") →
// republish → echo → conflict … measured ~1 rename/s in a fresh responder and
// 76 renames in ~4.5 h on the live gateway (instance "(76)" at 00:44). RFC
// 6762 9 says identical rdata is NEVER a conflict — the identical-rdata
// exemption is exactly what the raw-string lookup breaks.
//
// Fix (minimal, upstream-agnostic): normalize all reverseAddressPTRs keys to
// the decoded (`shortenIPv6 ∘ enlargeIPv6`) form at map-build time. Foreign
// responder claims (a real conflict, different 16 bytes) still normalize
// differently and still conflict; only the self-reflection false positive
// disappears. A-records (IPv4) are unaffected by format.
//
// Anchored exactly like the unicode-guard patch (openclaw_ha_addon/
// unicode-guard/): byte-tolerant anchor, idempotent via version marker,
// `node --check` on every written file, universality sweep over the install
// tree, and fail-loud everywhere — a skipped patch is a silently lost fix.
//
// Usage:
//   node apply-ciao-mdns-guard-patch.mjs [openclaw-install-dir]
//     openclaw-install-dir  default: /usr/lib/node_modules/openclaw
//
// Maintenance: on an OpenClaw version bump this runs in the Docker build right
// after the unicode-guard patch. If the anchor no longer matches, PORT it —
// never skip: the sweep fails the build loudly until you do. If upstream
// ships a native fix (shorten/enlarge on the reverse map), REMOVE this patch
// block (the sweep fails loudly until you do, which is the decision trigger).

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_MARKER = "// [openclaw-ha-addon ciao-mdns-guard v1]";
const here = dirname(fileURLToPath(import.meta.url));
const installDir = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "/usr/lib/node_modules/openclaw";

function fail(message) {
	console.error(`ERROR: ${message}`);
	process.exit(1);
}

// The injection: key-normalization loop in front of the subTypePTRs block of
// rebuildServiceRecords (the loop local `reverseAddressMap` is in scope there).
const INJECTION =
	"        // [openclaw-ha-addon ciao-mdns-guard v1] Normalize reverseAddressPTRs keys:\n" +
	"        // inbound AAAA rdata is decoded via shortenIPv6 (RFC-compressed), while the\n" +
	"        // map keys above use Node's full-form os.networkInterfaces() strings. Any\n" +
	"        // interface with a ULA (e.g. FRITZ!Box fd12:...::/48, Docker, or any other\n" +
	"        // fd.. prefix) then makes every self-reflection look like a FOREIGN AAAA\n" +
	"        // (hasAddress() misses) and each own-announcement echo triggers\n" +
	'        // probe/rename/republish forever ("name (N)" storm). RFC 6762 9: identical\n' +
	"        // rdata is never a conflict. Normalize the keys to the decoded form; A\n" +
	"        // records (IPv4) are unaffected by format.\n" +
	"        for (const key of Object.keys(reverseAddressMap)) {\n" +
	"            if (!net_1.default.isIPv6(key)) continue;\n" +
	"            const normalized = (0, domain_formatter_1.shortenIPv6)((0, domain_formatter_1.enlargeIPv6)(key));\n" +
	"            if (key === normalized) continue;\n" +
	"            reverseAddressMap[normalized] = reverseAddressMap[key];\n" +
	"            delete reverseAddressMap[key];\n" +
	"        }\n";

// Anchor: the subTypePTRs block that closes rebuildServiceRecords' address
// build (space-indented — ciao's compiled output uses spaces). Scope-guarded
// (the declaration must precede it in the same window).
const RE_ANCHOR = /^ {8}if \(this\.subTypePTRs\) \{$/gm;

if (!existsSync(join(installDir, "node_modules"))) {
	fail(`OpenClaw install dir has no node_modules: ${installDir} (is openclaw installed?)`);
}

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
		else if (entry.isFile() && entry.name === "CiaoService.js") files.push(entryPath);
	}
	return files;
}

const searchRoots = [...new Set([join(installDir, "node_modules"), join(installDir, "..", "..", "node_modules")])].filter(
	(dir) => existsSync(dir),
);
const candidates = [];
for (const root of searchRoots) {
	candidates.push(...walk(root));
}
const candidatesDeduped = [...new Set(candidates)].filter((f) => /node_modules\/@homebridge\/ciao\/lib\/CiaoService\.js$/.test(f));
if (candidatesDeduped.length === 0) {
	fail("no @homebridge/ciao lib/CiaoService.js found under node_modules — dependency layout changed, re-port required");
}

const modified = [];
for (const filePath of candidatesDeduped) {
	const rel = relative(installDir, filePath);
	const content = readFileSync(filePath, "utf8");

	const already = content.includes(PATCH_MARKER);
	if (already) {
		if (!RE_ANCHOR.test(content)) fail(`${rel}: patch marker present but the subTypePTRs anchor is gone — manual re-port required`);
		// Idempotent: the injection must sit immediately before its anchor.
		const idx = content.search(RE_ANCHOR);
		const before = content.slice(0, idx);
		if (!before.endsWith(INJECTION)) {
			fail(`${rel}: marker present but the injected block is not in front of the anchor — manual re-port required`);
		}
		console.log(`already patched: ${rel}`);
		continue;
	}

	if (!content.includes("reverseAddressPTRs")) {
		fail(`${rel}: no reverseAddressPTRs map — ciao layout changed, re-port required`);
	}
	if (!content.includes("const net_1") || !content.includes("domain_formatter_1")) {
		fail(`${rel}: expected net_1/domain_formatter_1 imports not found — ciao layout changed, re-port required`);
	}
	const matches = [...content.matchAll(RE_ANCHOR)];
	if (matches.length !== 1) {
		fail(`${rel}: expected exactly 1 'if (this.subTypePTRs) {' anchor, found ${matches.length} — re-port required`);
	}
	const scopeIdx = content.indexOf("const reverseAddressMap = {};");
	const anchorIdx = matches[0].index;
	if (scopeIdx === -1 || anchorIdx === -1 || anchorIdx < scopeIdx || anchorIdx - scopeIdx > 4000) {
		fail(`${rel}: anchor not in the rebuildServiceRecords scope (reverseAddressMap declaration too far away) — re-port required`);
	}

	const patched = content.replace(RE_ANCHOR, (m) => INJECTION + m);
	if (patched === content) fail(`${rel}: anchor replace had no effect`);

	writeFileSync(filePath, patched);
	modified.push(rel);
	const check = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
	if (check.status !== 0) fail(`node --check failed for ${rel}:\n${check.stderr}`);
	console.log(`patched + node --check ok: ${rel}`);
}

console.log(
	`ciao-mdns-guard patch complete: ${modified.length} file(s) patched, self-conflict (ULA IPv6 raw-string) fix applied.`,
);