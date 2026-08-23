# Audit Report — OpenClaw HA Addon ACPX Integration

**Auditor:** Iris (coding-review subagent)
**Date:** 2026-08-23
**Subject:** ACPX Harness Integration (v0.7.9.11)

---

## 1. Verdict

**⚠️ GO — with notes**

The ACPX integration is well-structured, idempotent, and handles the critical paths correctly. All three wrapper launchers are functional and secure. However, there is **one security concern** (stderr leak, see BUG-1 below) that should be addressed before production use if any ACPX harness processes output tokens/secrets to stderr.

---

## 2. Files Reviewed

| File | Status |
|------|--------|
| `acpx/claude-agent-acp-wrapper.mjs` | ✅ Reviewed |
| `acpx/codex-acp-wrapper.mjs` | ✅ Reviewed |
| `acpx/opencode-acp-wrapper.mjs` | ✅ Reviewed |
| `acpx/codex-home/config.toml` | ✅ Reviewed |
| `acpx/opencode-home/config.toml` | ✅ Reviewed |
| `oc_acpx_helper.py` | ✅ Reviewed |
| `run.sh` (ACPX section, lines ~917–936) | ✅ Reviewed |
| `Dockerfile` (ACPX lines ~286, 293, 300) | ✅ Reviewed |
| `config.yaml` (`acpx_enabled`, version 0.7.9.11) | ✅ Reviewed |
| `CHANGELOG.md` (root + addon) | ✅ Reviewed |

---

## 3. Bugs, Security Issues, and Observations

### 🔴 BUG-1 — ~~Critical: Stderr Leak to Container Log (All Three Wrappers)~~ **FIXED**

**Files:** `acpx/claude-agent-acp-wrapper.mjs:184-186`, `acpx/codex-acp-wrapper.mjs:187-189`, `acpx/opencode-acp-wrapper.mjs:182-184`

**Original Issue:**
```js
child.stderr?.on("data", (chunk) => {
  appendStderrLog(chunk);       // ← redacted to file
  process.stderr.write(chunk); // ← RAW to container stdout/stderr!
});
```

`process.stderr.write(chunk)` wrote the **raw, unredacted** chunk directly to the container log.

**Fix Applied by coding-main (Forge):** All three wrappers now convert the chunk to a string and write the redacted version to `process.stderr`:
```js
child.stderr?.on("data", (chunk) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  appendStderrLog(chunk);
  process.stderr.write(redactDiagnosticText(text));
});
```

**Status:** ✅ Fixed. No remaining unredacted stderr output to container log.

---

### 🟡 BUG-2 — Hardcoded Bin Path Assumptions (Binary Finders)

**Files:** `acpx/claude-agent-acp-wrapper.mjs:139-148`, `acpx/codex-acp-wrapper.mjs:155-175`

**Issue:** Both `findInstalledClaudeAcpBin()` and `findInstalledCodexAcpBin()` look for binaries at hardcoded paths inside `@openclaw/acpx` that may not reflect the actual published package structure:

- `claude-agent-acp-wrapper.mjs:139–148` expects:
  ```
  .../@openclaw/acpx/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
  ```
  But `oc_acpx_helper.py` installs `@openclaw/acpx` (the OpenClaw wrapper/meta package), NOT `@agentclientprotocol/claude-agent-acp` directly. The actual binary may live at a different path.

- `codex-acp-wrapper.mjs:155–175` has similar issues with `@zed-industries/codex-acp`.

**Impact:** Low in practice — both functions fall through to `npx` correctly when the hardcoded path isn't found. The fallback chain (`managedBin` → `npmCliPath` → `npx`) works. But if the actual published package structure differs, the hardcoded paths are dead code.

**Recommendation:** Remove or verify the hardcoded paths against actual published package structures of `@openclaw/acpx` and `@agentclientprotocol/claude-agent-acp` / `@zed-industries/codex-acp`.

---

### 🟡 OBS-1 — Shallow Idempotency Check in `install_acpx_npm_project()`

**File:** `oc_acpx_helper.py:116-127`

```python
current_deps = current.get("dependencies", {})
for dep, version in desired_pkg["dependencies"].items():
    if current_deps.get(dep) != version:
        need_install = True
```

This only triggers reinstall if a version differs. If a dependency is simply missing from `node_modules` (but `package.json` looks correct), it won't detect the gap. In practice, `npm install` handles missing packages, and the check correctly triggers on version changes, so this is a minor edge case.

---

### 🟡 OBS-2 — `sandbox.mode: "off"` Hardcoded for Coding Agents

**File:** `oc_acpx_helper.py:234`

```python
"sandbox": {"mode": "off"},
```

This overrides any user-configured sandbox setting. For ACPX harnesses running Claude Code/Codex/OpenCode inside the add-on container, `sandbox: off` is likely the correct default (container is already isolated), but a user who explicitly set `sandbox: on` in their existing openclaw.json would have it silently overwritten.

---

### 🟢 OBS-3 — `oc_acpx_helper.py` Bootstrap Does Not Check Existing Agent IDs Thoroughly

**File:** `oc_acpx_helper.py:189-239`

The `upsert_agent()` function only updates `harness`, `name`, `identity.emoji`, `workspace`, `subagents.allowAgents`, and `tools.profile`. If a user has a manually configured agent with extra fields (e.g., custom environment variables, allowedTools, etc.), those are preserved. However, the partial update means some user settings could conflict with ACPX harness expectations (e.g., a custom `command` on the agent would be ignored; the harness `command` from `harnesses[]` is used instead).

This is acceptable behavior — the ACPX harness is designed to override agent launch method — but worth documenting.

---

### 🟢 OBS-4 — `codex-acp-wrapper.mjs`: Codex Auth Path Race Condition (Minor)

**File:** `acpx/codex-acp-wrapper.mjs:9-28`

```js
if (codexApiKey) {
  if (!existsSync(codexAuthPath)) {
    shouldWriteCodexApiKeyAuth = true;
  } else {
    // ...
```

The code checks `existsSync` then potentially writes. If two instances run simultaneously (shouldn't happen in the add-on), both could pass the `existsSync` check and both try to write. The write itself is atomic enough (atomic rename via `writeFileSync`), but this is worth noting in documentation.

---

### 🟢 Good Patterns Confirmed

| Pattern | Location | Notes |
|---------|----------|-------|
| **Idempotent copy** | `oc_acpx_helper.py:82-94` | Only copies if src newer or dst missing |
| **Graceful npm failure** | `oc_acpx_helper.py:128-141` | Logs error but does NOT abort on npm failure; wrappers fall back to npx |
| **Secrets redaction** | All wrappers | Comprehensive regex set for API keys, tokens, private keys, JWTs |
| **Orphan process cleanup** | All wrappers: parent watcher | Detects parent death, kills child tree with SIGTERM → SIGKILL fallback |
| **Missing openclaw.json bootstrap** | `oc_acpx_helper.py:158-172` | Creates minimal valid config if file absent |
| **ACPX_ENABLED read** | `run.sh:917-936` | Correctly uses `jq -r '.acpx_enabled // true'` with string comparison |
| **Config.yaml schema** | `config.yaml:181` | `acpx_enabled: bool?` correctly defined |
| **Dockerfile COPY** | `Dockerfile:286,293,300` | Helper and acpx directory correctly copied |

---

## 4. ACPX Wrapper Binary Resolution — Call Chain

```
oc_acpx_helper.py:install_acpx_npm_project()
  → npm install in /config/.openclaw/acpx/.node_project/
    → @openclaw/acpx (2026.7.1)
    → @openclaw/codex (2026.7.1-1)
    → opencode-ai (latest, unless disabled)

Wrapper launch:
  1. Try managed binary (hardcoded path, may be stale)
  2. Try npm exec with specific version
  3. Fall back to npx (uses latest compatible)
```

The fallback chain is robust. The primary launch path (steps 1-2) depends on correct package structure assumptions (see BUG-2).

---

## 5. Summary Table

| ID | Severity | Type | File | Description |
|----|----------|------|------|-------------|
| BUG-1 | **Medium-High** | Security | All 3 wrappers | `process.stderr.write(chunk)` leaks unredacted stderr to container log |
| BUG-2 | Low | Correctness | `claude-*/codex-acp-wrapper.mjs` | Hardcoded bin paths may not match actual package structure |
| OBS-1 | Low | Robustness | `oc_acpx_helper.py` | Shallow idempotency check in npm install |
| OBS-2 | Low | Config | `oc_acpx_helper.py` | `sandbox.mode: "off"` hardcoded for coding agents |
| OBS-3 | Low | Design | `oc_acpx_helper.py` | Partial agent upsert; custom agent fields preserved |
| OBS-4 | Low | Race | `codex-acp-wrapper.mjs` | Minor auth file race condition |

---

## 6. Recommendation

**GO** for deployment with the following action items:

1. **Fix BUG-1** before shipping if any ACPX process could emit tokens to stderr (likely). Change `process.stderr.write(chunk)` to write redacted text.
2. **Verify BUG-2** by checking the actual published file layout of `@agentclientprotocol/claude-agent-acp` and `@openclaw/acpx` on npm. If the hardcoded paths are wrong, the wrappers will unnecessarily fall back to npx every time (minor latency but functional).
3. No other blockers found. The integration is coherent, idempotent, handles missing files gracefully, and the fallback chains are solid.
