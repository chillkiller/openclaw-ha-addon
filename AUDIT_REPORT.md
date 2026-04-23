# 🔍 Audit Report: OpenClaw HA Addon v0.7.5.2

**Date:** 2026-04-23  
**Auditor:** Forge (subagent)  
**Scope:** `/share/projekte/github/openclaw-ha-addon/openclaw_ha_addon/`  
**Baseline:** 13 Dev-Marvin commits after last clean stand  

---

## Executive Summary

**Overall Rating: ⚠️ NEEDS FIXES (5 Critical, 4 Warning, 7 Info)**

The addon is in a **functional but fragile** state. The known GATEWAY_PORT bug (line 87) is the most critical issue — it makes the addon crash on every startup with `set -euo pipefail`. Several other issues were found across run.sh, config.yaml, Dockerfile, translations, and helper scripts.

---

## Critical Bugs (🔴 Must Fix)

### C1: `GATEWAY_PORT` used before definition in run.sh
- **File:** `run.sh`, line 87  
- **Severity:** 🔴 CRITICAL — Addon crashes on every startup  
- **Description:** `if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then` uses `$GATEWAY_PORT` before it's defined on line 105. With `set -euo pipefail`, this triggers `"GATEWAY_PORT: unbound variable"` and the addon exits immediately.  
- **Fix:** Move the port conflict check to **after** line 105 (after `GATEWAY_PORT` is defined), or move the `GATEWAY_PORT` definition before line 87.  
  ```bash
  # Move these lines (87-90) to after line 105, like this:
  # SECURITY: Check for port conflicts with Gateway
  if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then
    echo "ERROR: terminal_port conflicts with gateway_port ($GATEWAY_PORT). Using default 7681."
    TERMINAL_PORT="7681"
  fi
  ```

### C2: `MDNS_SERVICE_PORT` default uses `$GATEWAY_PORT` in jq expression — order-dependent
- **File:** `run.sh`, line ~112  
- **Severity:** 🔴 CRITICAL — Works only by accident  
- **Description:**  
  ```bash
  MDNS_SERVICE_PORT=$(jq -r '.mdns_service_port // "'"$GATEWAY_PORT"'"' "$OPTIONS_FILE")
  ```  
  This injects `$GATEWAY_PORT` into a jq default expression. It works because `GATEWAY_PORT` is defined by line 105, and `MDNS_SERVICE_PORT` is read at line ~112. However, this is fragile: if the variable reading order changes, or if `GATEWAY_PORT` contains special characters, this breaks. It also violates the principle of not embedding shell variables inside jq string literals.  
- **Fix:** Read the raw value first, then apply default in bash:  
  ```bash
  MDNS_SERVICE_PORT_RAW=$(jq -r '.mdns_service_port // empty' "$OPTIONS_FILE")
  MDNS_SERVICE_PORT="${MDNS_SERVICE_PORT_RAW:-$GATEWAY_PORT}"
  ```

### C3: `LAN_IP` redefined in Section 23, overwrites Section 14 value
- **File:** `run.sh`, line ~1008 (Section 23)  
- **Severity:** 🔴 CRITICAL — Can cause TLS certificate SAN issues  
- **Description:** `LAN_IP` is first set in Section 14 (TLS cert generation, ~line 440) with `hostname -I | awk '{print $1}'`. Then in Section 23, it's set **again** with the same command. If the IP changed between sections (unlikely but possible in dynamic network environments) or if `hostname -I` returns nothing in one invocation, the cert SANs and the avahi hosts file would have different IPs. More importantly, Section 14 runs **before** Section 23, so if `ENABLE_HTTPS_PROXY=true` and the IP detection fails in Section 14 but succeeds in Section 23, the cert would have an empty IP SAN.  
- **Fix:** Set `LAN_IP` once near the top of the script (after options are loaded), and reuse it everywhere.

### C4: D-Bus config XML missing closing `>` in DOCTYPE
- **File:** `run.sh`, Section 23 (avahi case), heredoc `DBUS_CONF`  
- **Severity:** 🔴 CRITICAL — dbus-daemon may fail to parse config  
- **Description:** The D-Bus config heredoc contains:  
  ```xml
  <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
   "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd"
  <busconfig>
  ```  
  This is **not valid XML** — the DOCTYPE declaration is missing the closing `>`. It should be:  
  ```xml
  <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
   "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
  <busconfig>
  ```  
  Without the closing `>`, `dbus-daemon` may refuse to start, making avahi mode completely broken.  
- **Fix:** Add the missing `>` after the DTD URL.

### C5: `dbus-daemon` package name wrong in Dockerfile
- **File:** `Dockerfile`, line in Zone 1 apt install  
- **Severity:** 🔴 CRITICAL — Build fails  
- **Description:** The Dockerfile installs `dbus-daemon` as an apt package:  
  ```dockerfile
  dbus-daemon \
  ```  
  In Debian Trixie, there is **no package called `dbus-daemon`**. The correct package name is `dbus`. The `dbus-daemon` binary is provided by the `dbus` package. Running `apt-get install dbus-daemon` will fail with "Unable to locate package dbus-daemon", causing the entire Docker build to fail.  
- **Fix:** Replace `dbus-daemon` with `dbus` in the Dockerfile:  
  ```dockerfile
  dbus \
  ```

---

## Warning Bugs (🟡 Should Fix)

### W1: `build.yaml` exists but is incomplete and contradicts CHANGELOG
- **File:** `build.yaml`  
- **Severity:** 🟡 WARNING  
- **Description:** `build.yaml` exists with content:  
  ```yaml
  build_from:
    amd64: debian:trixie-slim
    aarch64: debian:trixie-slim
    armv7: debian:trixie-slim
  ```  
  But `config.yaml` only lists `amd64` and `aarch64` under `arch:` — no `armv7`. Additionally, the CHANGELOG for v0.7.5 says "FIX: build.yaml entfernt (HA-supervisor-obsolet)" but the file still exists. This is a contradiction.  
  If `build.yaml` is truly obsolete (HA supervisor builds from the Dockerfile directly), it should be deleted. If it's needed for local builds, it should match `config.yaml` arch list.  
- **Fix:** Either delete `build.yaml` (as CHANGELOG says) or update its arch list to match `config.yaml` (remove `armv7`).

### W2: Translations include `avahi` in `mdns_mode` options but translations are inconsistent
- **File:** `translations/*.yaml`  
- **Severity:** 🟡 WARNING  
- **Description:** The `config.yaml` schema lists `mdns_mode: list(off|minimal|full|avahi)?`, but the translation files for **all languages** only list 3 options (off, minimal, full) — they are missing the `avahi` option. This means users with non-English UIs won't see the `avahi` option translated, and the HA UI may show the raw key instead of a localized label.  
- **Fix:** Add `avahi` option to all translation files:  
  ```yaml
  mdns_mode:
    options:
      avahi: "Avahi (OS-level mDNS, no Gateway mode)"
  ```

### W3: `trace_log_to_console` option in translations but missing from config.yaml
- **File:** `translations/*.yaml`, `config.yaml`  
- **Severity:** 🟡 WARNING  
- **Description:** All translation files include `trace_log_to_console` (name + description), but `config.yaml` has **no** `trace_log_to_console` option in its `options` or `schema` sections. Users who see this translated option won't be able to configure it. It's dead configuration in translations.  
- **Fix:** Either add `trace_log_to_console` to `config.yaml` options/schema, or remove it from all translation files.

### W4: Slug change from `openclaw_assistant_dev` to `openclaw_ha_addon` breaks existing installations
- **File:** `config.yaml`, line 7  
- **Severity:** 🟡 WARNING  
- **Description:** The slug was changed from `openclaw_assistant_dev` to `openclaw_ha_addon`. HA uses the slug as the unique identifier for the addon. Changing it means:  
  1. **Existing installations see the addon as a completely new addon** — the old one appears uninstalled  
  2. **Persistent data at `/addon_configs/openclaw_assistant_dev/` is no longer mounted** — HA will mount `/addon_configs/openclaw_ha_addon/` instead  
  3. **All existing config, tokens, skills, and workspace data are "lost"** (they still exist on disk under the old path but the new addon can't see them)  
  4. **HA backups taken with the old slug won't restore to the new slug**  
  This is a **migration-breaking change** that should be documented prominently.  
- **Fix:** Either revert the slug to `openclaw_assistant_dev`, or add a prominent migration note in DOCS.md and a startup migration script that symlinks/copies data from the old path. The safest option is reverting the slug.

---

## Info Issues (🔵 Nice to Fix)

### I1: `oc_config_helper.py` `set_mdns_settings` ignores hostname and interface parameters
- **File:** `oc_config_helper.py`, `set_mdns_settings()` function  
- **Severity:** 🔵 INFO  
- **Description:** The function accepts `host_name` and `interface_name` parameters but **never writes them to the config**. Only `discovery.mdns.mode` is written. The hostname and interface are used by run.sh for avahi/Gateway config but aren't persisted in `openclaw.json`. This means if the gateway restarts independently of run.sh, it won't know the hostname/interface.  
- **Impact:** Low — run.sh always re-applies settings on startup. But it's misleading API design.

### I2: `oc_config_helper.py` `generate_mdns_nginx_snippet` is dead code
- **File:** `oc_config_helper.py`, `generate_mdns_nginx_snippet()`  
- **Severity:** 🔵 INFO  
- **Description:** This function generates a comment-only nginx snippet (no actual config directives). It's called via CLI `mdns-nginx-snippet` but nothing in run.sh or render_nginx.py ever calls it. It's effectively dead code.  
- **Fix:** Remove or implement properly.

### I3: `oc_config_helper.py` `get` command only reads gateway keys
- **File:** `oc_config_helper.py`, `cmd == "get"`  
- **Severity:** 🔵 INFO  
- **Description:** The `get` command reads `value.get("gateway", {})` and then `gateway.get(sys.argv[2], "")`. It can only read keys under `gateway.*`, not arbitrary config paths. The help text says `get <key>` without this limitation.  
- **Fix:** Either document the limitation or support dot-notation paths like `gateway.auth.mode`.

### I4: `DEPLOYMENT.md` is outdated
- **File:** `DEPLOYMENT.md`  
- **Severity:** 🔵 INFO  
- **Description:**  
  - References "0.7.5.1" in version matrix but current version is 0.7.5.2  
  - Mentions tmpfs mounts that were removed in v0.6.1.7 (CHANGELOG says "Disabled tmpfs mounts")  
  - Claims "Power Mode" heap is 6GB but run.sh uses 3072MB  
  - Claims "Safe Mode" heap is 2GB but run.sh uses 2048MB (this is correct but the tmpfs values are stale)  
- **Fix:** Update version, remove tmpfs references, align heap sizes with run.sh.

### I5: `FORGE_ROHSCHNITT.md` is a design doc with code that's never executed
- **File:** `FORGE_ROHSCHNITT.md`  
- **Severity:** 🔵 INFO  
- **Description:** Contains a detailed implementation proposal for RAM-limited systems, but none of its code is in `run.sh`. It's a design doc, not an issue, but it's stale since run.sh now has its own (simpler) RAM detection in Section 4.  
- **Fix:** Update or remove to avoid confusion.

### I6: `test_all_fixes.sh` checks wrong health endpoint
- **File:** `test_all_fixes.sh`, Gateway section  
- **Severity:** 🔵 INFO  
- **Description:** Tests `curl -s http://127.0.0.1:18790/health` but the gateway port is `18789` (or whatever `GATEWAY_PORT` is configured to). Port 18790 is never used.  
- **Fix:** Change to `http://127.0.0.1:18789/health` or better: read the port from config.

### I7: `brew-wrapper.sh` uses `su` which may fail in container
- **File:** `brew-wrapper.sh`  
- **Severity:** 🔵 INFO  
- **Description:** Uses `exec su linuxbrew -c "/home/linuxbrew/.linuxbrew/bin/brew \"$@\""` — but in the HA addon container, there's no guarantee `su` is available or that the `linuxbrew` user exists after Homebrew persistence changes. If `/home/linuxbrew/.linuxbrew` is a symlink to `/config/.linuxbrew`, the `linuxbrew` user may not have permissions.  
- **Fix:** Consider using `sudo -u linuxbrew` instead, or just run brew directly since the addon runs as root.

---

## Detailed Analysis by File

### run.sh

| # | Line | Severity | Issue |
|---|------|----------|-------|
| C1 | 87 | 🔴 | `GATEWAY_PORT` used before definition (line 105) |
| C2 | ~112 | 🔴 | `MDNS_SERVICE_PORT` default via jq string interpolation |
| C3 | ~1008 | 🔴 | `LAN_IP` redefined in Section 23 |
| C4 | ~1085 | 🔴 | D-Bus DOCTYPE missing closing `>` |
| — | 108-110 | ℹ️ | Port safety check `>= 65535` should be `> 65534` (65535 is valid, but 65534 is fine too) |
| — | 19 | ℹ️ | `error_handler` trap duplicates `set -e` behavior — both cause exit on error. The handler adds line info which is useful, but `set -e` already catches errors. Minor redundancy. |

### config.yaml

| # | Line | Severity | Issue |
|---|------|----------|-------|
| W3 | — | 🟡 | `trace_log_to_console` in translations but not in options/schema |
| W4 | 7 | 🟡 | Slug change breaks existing installations |
| — | — | ℹ️ | `schema` for `gateway_env_vars` uses regex `match(^[A-Z_][A-Z0-9_]*$)` — this prevents lowercase env var names which are valid in Linux (e.g., `my_var`). However, this may be intentional for security. |

### Dockerfile

| # | Line | Severity | Issue |
|---|------|----------|-------|
| C5 | Zone 1 | 🔴 | `dbus-daemon` package doesn't exist in Debian Trixie; should be `dbus` |
| — | — | ℹ️ | OpenClaw version 2026.4.21 **is a valid released version** (confirmed via npm registry). However, the npm search page shows "Latest version: 2026.3.28" which appears to be stale cache — 2026.4.21 does exist on the registry. |
| — | — | ℹ️ | `golang-go` is installed via apt but run.sh also sets up Go from `/usr/local/go/bin`. The apt package may conflict with a manually installed version. |
| — | — | ℹ️ | `playwright install chromium --with-deps` installs its own system dependencies which may conflict with the ones already installed in Zone 1. This works but is redundant and increases image size. |

### oc_config_helper.py

| # | Line | Severity | Issue |
|---|------|----------|-------|
| I1 | `set_mdns_settings()` | 🔵 | `host_name` and `interface_name` params ignored |
| I2 | `generate_mdns_nginx_snippet()` | 🔵 | Dead code — returns comment-only, never called |
| I3 | `cmd == "get"` | 🔵 | Only reads gateway.* keys |

### nginx.conf.tpl

No issues found. Template is clean, placeholders are properly delimited with `__DOUBLE_UNDERSCORE__` format.

### landing.html.tpl

No critical issues. The template is well-structured. Minor note: JavaScript uses `const` for all template-injected values, which is fine since they're set once at render time.

### render_nginx.py

No critical issues. Template rendering is straightforward. One minor note: it calls `hostname -I` directly instead of using the `LAN_IP` already available in run.sh — this is because it's called as a subprocess, but the result should be the same.

### Translations (all 6 languages)

| # | Severity | Issue |
|---|----------|-------|
| W2 | 🟡 | Missing `avahi` option in `mdns_mode` for all languages |
| W3 | 🟡 | `trace_log_to_console` present in all translations but absent from config.yaml |

### build.yaml

| # | Severity | Issue |
|---|----------|-------|
| W1 | 🟡 | Lists `armv7` but config.yaml doesn't; CHANGELOG says it was removed |

### Other files

- `oc-cleanup.sh`: ✅ Clean, no issues
- `openclaw-proxy-shim.cjs`: ✅ Clean, defensive coding with try/catch
- `brew-wrapper.sh`: See I7 above
- `test_all_fixes.sh`: See I6 above

---

## mDNS Section (Section 23) — Exclusive Mode Analysis

The rewrite from "always-on avahi" to "exclusive mode selection" is architecturally sound. The logic correctly ensures only one mDNS mechanism runs at a time:

| Mode | Gateway mDNS | Avahi | D-Bus | ✅/❌ |
|------|-------------|-------|-------|-------|
| off | OFF (explicit) | OFF | OFF | ✅ |
| minimal | ON (via helper) | OFF | OFF | ✅ |
| full | ON (via helper) | OFF | OFF | ✅ |
| avahi | OFF (explicit) | ON | ON | ✅ |

**Bug found in avahi case:** D-Bus config XML is malformed (C4). If dbus-daemon can't parse it, the entire avahi path fails silently.

**Variable ordering issue:** `MDNS_SERVICE_PORT` default uses `$GATEWAY_PORT` inside a jq expression (C2). While it works at runtime (GATEWAY_PORT is already set by that point), it's fragile.

**Good:** The helper `set-mdns-settings` correctly handles mode exclusivity — avahi mode sets `discovery.mdns.mode=off` to prevent Gateway from also advertising.

---

## Slug Change Impact Assessment

Changing `slug: openclaw_assistant_dev` → `slug: openclaw_ha_addon`:

1. **HA identifies addons by slug** — this is a destructive change
2. **Data path changes** from `/addon_configs/openclaw_assistant_dev/` to `/addon_configs/openclaw_ha_addon/`
3. **All persistent data** (openclaw.json, skills, workspace, tokens) stays at the old path
4. **New addon starts fresh** with no config, requiring full re-onboarding
5. **HA backups** reference the old slug — restoring won't map to new slug

**Recommendation:** Revert to `openclaw_assistant_dev` unless there's a compelling reason for the change. If the change is intentional, provide a migration path.

---

## OpenClaw Version Check

**Dockerfile:** `npm install -g openclaw@2026.4.21`  
**Status:** ✅ Version 2026.4.21 exists on npm registry (confirmed via `registry.npmjs.org/openclaw/2026.4.21`).  
**Note:** The npmjs.com search page shows "Latest: 2026.3.28" but this appears to be stale CDN cache — the registry endpoint confirms 2026.4.21 is published with SLSA provenance attestation.

---

## Recommendations (Priority Order)

1. **🔴 Fix C1:** Move GATEWAY_PORT port conflict check after GATEWAY_PORT definition
2. **🔴 Fix C4:** Add missing `>` to D-Bus DOCTYPE in run.sh heredoc
3. **🔴 Fix C5:** Replace `dbus-daemon` with `dbus` in Dockerfile
4. **🔴 Fix C2:** Refactor MDNS_SERVICE_PORT default to use bash, not jq interpolation
5. **🔴 Fix C3:** Centralize LAN_IP detection to avoid redefinition
6. **🟡 Fix W4:** Decide on slug — revert or add migration docs
7. **🟡 Fix W2:** Add `avahi` option to all translation files
8. **🟡 Fix W3:** Add or remove `trace_log_to_console` from config.yaml
9. **🟡 Fix W1:** Delete or update build.yaml
10. **🔵 Fix I4-I5:** Update DEPLOYMENT.md and FORGE_ROHSCHNITT.md

---

*End of Audit Report*