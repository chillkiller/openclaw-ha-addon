# OpenClaw HA Add-on Update Audit: 2026.8.2 / v0.7.9.27

**Branch:** `update-2026.8.2`  
**Files reviewed:**
- `openclaw_ha_addon/Dockerfile`
- `openclaw_ha_addon/config.yaml`
- `openclaw_ha_addon/run.sh`
- `openclaw_ha_addon/CHANGELOG.md`
- Upstream release notes: `v2026.8.2`, `v2026.8.1`, `docs.openclaw.ai`

**Audit date:** 2026-09-02  
**Auditor:** coding-main subagent

---

## Executive Verdict: APPROVED_WITH_CHANGES

The update is **fundamentally sound** — all four changed files are consistent, the new upstream versions exist and are stable, and the intended compatibility matrix (Node 24 + OpenClaw 2026.8.2 + node-llama-cpp 3.20.0 + mcporter 0.12.3) is viable.

However, **one functional regression in `run.sh` line 758 must be fixed before merge**; the sed regex that strips the human-readable `openclaw --version` label is broken for the new label format and will export `unknown` as `OPENCLAW_VERSION`. That disables the plugin API compatibility check and will break ACPX plugin loading.

A second recommended change is to **split the global npm install** in the Dockerfile to avoid cross-package lifecycle ordering surprises and make build failures easier to diagnose.

---

## 1. Per-Change Verification

### 1.1 Dockerfile — Node 22 → 24

- **Change:** NodeSource repo `node_22.x` replaced by `node_24.x`.
- **NodeSource URL format:** `https://deb.nodesource.com/node_24.x nodistro main` is the documented and current URL for Node 24 on Debian/Ubuntu.
- **Debian bookworm-slim compatibility:** NodeSource `nodistro` repositories are distribution-agnostic and work on bookworm-slim.
- **Result:** ✅ OK.

### 1.2 Dockerfile — OpenClaw 2026.7.1-2 → 2026.8.2

- `openclaw@2026.8.2` is the current npm `latest` dist-tag (published 2026-09-01).
- GitHub release `v2026.8.2` exists and is published.
- Upstream notes identify 2026.8.2 as a follow-up correction to 2026.8.1; it is a stable release.
- **Result:** ✅ OK.

### 1.3 Dockerfile — mcporter 0.12.3 added

- `mcporter@0.12.3` exists on npm and the corresponding GitHub tag exists.
- `mcporter@0.12.3` declares `engines.node: ">=24"`, matching the Node 24 bump.
- `run.sh` already contains auto-configuration logic for MCP (HA server) using the `mcporter` CLI.
- **Result:** ✅ OK, with the caveat that `mcporter@0.12.3` is **not** the latest release (latest is `0.13.8`). Pinning to `0.12.3` is acceptable if that is the version explicitly requested and tested by the maintainer.

### 1.4 Dockerfile — node-llama-cpp 3.20.0 kept

- `node-llama-cpp@3.20.0` declares `node: ">=20.0.0"`, so Node 24 satisfies the engine requirement.
- The project provides prebuilt binaries and falls back to a cmake source build. Build tools (cmake, build-essential, python3-dev) are present in the image.
- The Dockerfile already patches `compileLLamaCpp.js` to honor `NLC_BUILD_PARALLEL=2` and runs the postinstall manually.
- **Result:** ✅ OK for aarch64/RPi5 in principle, but note that compiling llama.cpp from source on a Raspberry Pi 5 at 2 threads is still a lengthy build step. Monitor first build.

### 1.5 config.yaml — version bump

- Version changed from `0.7.9.26` to `0.7.9.27`.
- Consistent with Dockerfile header comment and CHANGELOG entry.
- **Result:** ✅ OK.

### 1.6 run.sh — comment update only (line 755–758)

- The only code change is the example string in the comment above the `OPENCLAW_VERSION` sed pipeline.
- The sed regex itself is unchanged.
- **Result:** ⚠️ The regex is **defective** (see section 2).

### 1.7 CHANGELOG.md — new entry added

- Entry is consistent with the actual changes.
- Notes the SQLite session/transcript migration and the `/config` backup recommendation.
- **Result:** ✅ OK.

---

## 2. Issues Found

### 2.1 [BLOCKING] `run.sh` line 758 — `OPENCLAW_VERSION` extraction fails for `2026.8.2`

**Location:**
```bash
# run.sh, around line 755–758
# OPENCLAW_VERSION is used by OpenClaw's plugin API compatibility check.
# `openclaw --version` prints a human-readable label like:
#   "OpenClaw 2026.8.2 (xxxxxxxx)"
# The plugin loader expects a plain semver string, so strip the prefix
# and the parenthesized build/suffix before exporting.
export OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | head -1 | sed -n 's/^OpenClaw \([0-9][0-9.]*\(-[0-9A-Za-z.]*\)\{0,1\}\).*$/\1/p' || echo 'unknown')"
```

**Problem:**  
The sed regex uses `\{0,1\}` BRE-style quantifier syntax inside the capture group. In GNU sed with `-n` and the `s///p` command, this does **not** match the string:

```
OpenClaw 2026.8.2 (xxxxxxxx)
```

Testing shows:
- Node.js equivalent regex `^OpenClaw ([0-9][0-9.]*(-[0-9A-Za-z.]*){0,1}).*$` extracts `2026.8.2` correctly.
- The same expression in GNU sed with BRE escape rules returns **nothing** for the new label, causing the pipeline to fall through to `unknown`.

**Why this matters:**  
`OPENCLAW_VERSION` is used by OpenClaw's plugin API compatibility check. If it becomes `unknown`, plugins that require `>=2026.7.1` (including ACPX) will fail to load. This was already the class of bug fixed in v0.7.9.20 ("Plugin API version compatibility").

**Required fix:**
Replace the line with a simpler, tested regex. The label format is stable enough to capture the first whitespace-delimited token after "OpenClaw " or use an ERE-based extraction. Recommended replacement:

```bash
export OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | head -1 | sed -n 's/^OpenClaw \([0-9]\{4\}\.[0-9]\+\.[0-9]\+\(-[0-9A-Za-z.-]\+\)\?\).*$/\1/p' || echo 'unknown')"
```

Or, more robust with `awk`:

```bash
export OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | head -1 | awk '/^OpenClaw / { print $2; exit }' || echo 'unknown')"
```

The `awk` version strips the parenthesized build hash naturally because it returns only the second field. This is the safest fix.

**Severity:** P0 / blocking.

---

### 2.2 [RECOMMENDED] Dockerfile — single `npm install -g` bundles unrelated packages

**Location:**
```dockerfile
RUN npm install -g openclaw@2026.8.2 node-llama-cpp@3.20.0 mcporter@0.12.3 \
    && npm install -g pnpm \
    && npm cache clean --force
```

**Problem:**  
Installing `openclaw`, `node-llama-cpp`, and `mcporter` in one command works, but it couples their lifecycles. If any package's install/postinstall fails, the entire layer fails, and build logs become harder to attribute. Additionally, `node-llama-cpp` has a heavy native postinstall that is explicitly skipped then re-run.

**Recommended fix:**
Split the install so each package is its own layer/step, keeping the existing `NODE_LLAMA_CPP_POSTINSTALL=skip` pattern for node-llama-cpp:

```dockerfile
ENV NODE_LLAMA_CPP_POSTINSTALL=skip
RUN npm install -g openclaw@2026.8.2 \
    && npm install -g node-llama-cpp@3.20.0 \
    && npm install -g mcporter@0.12.3 \
    && npm install -g pnpm \
    && npm cache clean --force
```

This is a build hygiene improvement, not a functional blocker.

**Severity:** P1 / recommended.

---

### 2.3 [NOTE] Node 24 + OpenClaw engine range edge case

`openclaw@2026.8.2` declares:

```json
"engines": { "node": ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0" }
```

NodeSource `node_24.x` currently ships Node 24.x LTS. As long as the installed version is `>=24.15.0`, the engine requirement is satisfied. If NodeSource were to ship an older 24.x (e.g., 24.0.x) on a particular architecture, npm might emit a non-fatal warning or, with `--engine-strict`, fail. This is unlikely but worth monitoring in CI/build logs.

**Severity:** P2 / informational.

---

## 3. OpenClaw 2026.8.x Breaking-Change Assessment

### 3.1 SQLite session/transcript migration

- Confirmed by upstream release notes and documentation. The 2026.8.x line (2026.8.1+) migrates session/transcript storage to SQLite.
- The CHANGELOG already warns users to back up `/config` before first start. This is the correct mitigation.
- The add-on does not attempt to run `openclaw doctor` or migration commands at startup; it relies on OpenClaw's own startup-safe upgrade work. This is consistent with upstream design ("gateway runs startup-safe upgrade work before readiness").
- **Risk:** If a user upgrades from a pre-2026.8.x install, the first start will perform the migration. If it fails, the gateway may exit. The add-on's supervisor loop will restart it, which is generally OK, but users should be instructed to check logs and restore from backup if migration fails. The current CHANGELOG message is adequate.

### 3.2 State directory layout changes

- 2026.8.x moves authoritative state to SQLite under the state directory. The add-on already sets `OPENCLAW_CONFIG_DIR=/config/.openclaw` and `OPENCLAW_WORKSPACE_DIR=/config/clawd`, so state is on persistent storage. ✅

### 3.3 koffi native module

- `openclaw@2026.8.2` depends on `koffi@3.1.6`. koffi has optional prebuilt packages for `linux-arm64`. The Dockerfile keeps `build-essential`, `cmake`, `python3-dev`, so a fallback source build is possible if the prebuild is missing for a specific ABI/libc. ✅

### 3.4 pnpm ownership changes in 2026.8.x

- 2026.8.1/2026.8.2 fixed an issue where updates could misdetect pnpm-global installs and install a second npm copy. The add-on installs pnpm globally but installs openclaw itself via npm. The add-on does not run `openclaw update` during normal operation, so the pnpm detection bug does not directly affect this Dockerfile.
- `pnpm` global install remains useful for skills that depend on pnpm. Removing it is not required. ✅

### 3.5 No additional runtime dependencies identified

- The upstream 2026.8.2 changelog does **not** introduce new system-level runtime dependencies beyond the existing Node/npm toolchain, SQLite (included), and standard libraries already present.
- `sqlite-vec` is **not** a dependency of `openclaw@2026.8.2`; the earlier sqlite-vec issue was specific to older releases. No extra sqlite-vec package is needed.

---

## 4. Scope-Specific Checks

| # | Question | Result |
|---|----------|--------|
| 1 | NodeSource node_24.x URL and bookworm-slim compatibility | ✅ OK |
| 2 | OpenClaw 2026.8.2 exists and is stable | ✅ OK, current npm `latest` |
| 3 | mcporter@0.12.3 exists and is compatible | ✅ OK, engine `>=24` matches Node 24 |
| 4 | node-llama-cpp@3.20.0 on Node 24 aarch64 | ✅ OK (prebuilds + source fallback) |
| 5 | Other 2026.8.x breaking changes | ⚠️ SQLite migration (documented); no new system deps found |
| 6 | run.sh sed regex for OPENCLAW_VERSION | ❌ **BROKEN for 2026.8.2 label format** |
| 7 | Single npm install vs. split | ⚠️ Works, but splitting is recommended |
| 8 | pnpm global install still required? | ✅ Still useful; no need to remove |
| 9 | Missing runtime dependencies? | ✅ None identified |
| 10 | Verdict | APPROVED_WITH_CHANGES |

---

## 5. Required Changes Before Merge

1. **Fix `run.sh` line 758** so `OPENCLAW_VERSION` is extracted correctly from the `OpenClaw 2026.8.2 (xxxxxxxx)` label. Use the `awk` replacement shown in section 2.1.
2. **(Recommended)** Split the Dockerfile `npm install -g` command into separate steps for openclaw, node-llama-cpp, and mcporter.
3. **(Optional)** Add a CI/build-time smoke test that runs `openclaw --version` and asserts `OPENCLAW_VERSION` is not `unknown` and matches the expected semver.

---

## 6. How to Verify the Fix

After applying the `run.sh` fix:

```bash
# Inside a built container or local environment with openclaw installed:
OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | head -1 | awk '/^OpenClaw / { print $2; exit }' || echo 'unknown')"
[[ "$OPENCLAW_VERSION" =~ ^2026\.[0-9]+\.[0-9]+ ]] && echo "OK: $OPENCLAW_VERSION" || echo "FAIL: $OPENCLAW_VERSION"
```

---

## 7. Summary

- All target versions are real and compatible.
- Dockerfile and CHANGELOG changes are correct.
- The Node 24 + OpenClaw 2026.8.2 combination is supported upstream.
- **The only blocking issue is the `OPENCLAW_VERSION` sed regex in `run.sh`.**
- After that regex is fixed (and ideally the Dockerfile install split applied), the update is safe to merge.

**Final recommendation:** `APPROVED_WITH_CHANGES` — fix `run.sh` line 758 before merge.
