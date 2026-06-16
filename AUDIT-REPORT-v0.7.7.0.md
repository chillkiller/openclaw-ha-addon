# Audit Report — openclaw-ha-addon v0.7.7.0

**Version:** 0.7.7.0  
**Commit:** c5f503c  
**Date:** 2026-06-16  
**Auditor:** coding-review (independent)  
**Scope:** Full repository audit — every file, every option, every contract

---

## Gesamturteil: ⚠️ APPROVED WITH CHANGES

The addon is functionally solid. Core services (gateway, nginx, ttyd, D-Bus/Avahi, skills sync, Homebrew persist, TLS) are well-implemented. However, there are **7 required changes** (5 config/run.sh option gaps, 1 version mismatch, 1 missing browser config key) and **11 advisory items** that should be addressed before or shortly after release.

---

## 1. Dockerfile

**File:** `openclaw_ha_addon/Dockerfile`

### ✅ Good
- OpenClaw 2026.6.8 pinning correct (`npm install -g openclaw@2026.6.8`)
- Go 1.24.1 binary install with golang-go purge — correct
- CUPS/Scanner packages in Zone 1 — correct (cups, cups-client, cups-daemon, cups-filters, cups-ipp-utils, cups-browsed, sane-airscan, sane-utils)
- crawl4ai installed via `uv pip install --system crawl4ai` (no `[all]`)
- Playwright shared at `/opt/ms-playwright` with ENV `PLAYWRIGHT_BROWSERS_PATH`
- tini as PID 1 (`ENTRYPOINT [ "/usr/bin/tini", "-g", "--" ]`)
- HEALTHCHECK present with sensible 120s start-period
- Multi-arch support (TARGETARCH for Go, Bun, uv, ttyd)
- Node.js 22 LTS from NodeSource
- Chromium symlinks created for `/usr/bin/chromium-browser` and `/usr/bin/chromium`

### ⚠️ Required Changes

| # | File | Line | Problem | Fix |
|---|------|------|---------|-----|
| R1 | Dockerfile | 3 | **Builder stage defined but never used.** `FROM debian:bookworm-slim AS builder` installs build-essential, cmake, git etc. but no `COPY --from=builder` exists. The builder stage wastes build time and cache for nothing. | Either: (A) Remove the entire builder stage and its `RUN apt-get` block (lines 3-17), OR (B) Move `build-essential` and `cmake` into the builder, compile what needs compiling, and `COPY --from=builder` the results. Currently the runtime image re-installs `build-essential` anyway (Zone 1), making the builder entirely redundant. |
| R2 | Dockerfile | 68 | **`build-essential` in runtime image (~200MB).** Currently installed in Zone 1 for "node-gyp fallback compile". This is a significant image size penalty. The builder stage was presumably meant to avoid this. | If node-gyp is only needed at image build time, move it to the builder stage and `COPY --from=builder` compiled artifacts. If it must stay in runtime for user npm installs, document the tradeoff. Consider removing `cmake` from runtime (only needed in builder). |

### 💡 Observations

- **O1** Line 117: Dockerfile comment says `Install OpenClaw v0.7.5.4 (pinned version)` but actual install is `openclaw@2026.6.8`. Comment is stale and misleading — should say `OpenClaw 2026.6.8`.
- **O2** `crawl4ai` installs all default dependencies. The memory decision says "torch, transformers, scipy EXPLIZIT AUSSCHLIESSEN" but there is no `--no-deps` flag or exclusion mechanism. If `crawl4ai`'s default deps include any of these (transitively), they will be in the image. The `pip install crawl4ai` without `[all]` is correct for avoiding ML extras, but if a base dependency pulls in numpy/scipy, those still land. **Verify at build time** that `pip show crawl4ai` doesn't list torch/transformers/scipy as transitive deps.
- **O3** `libvips-dev` and `libopenblas-dev` are dev packages in runtime image. `-dev` packages include headers and .so symlinks — these are only needed at compile time. Consider using `libvips` (without `-dev`) and `libopenblas0` (runtime shared lib only) instead.
- **O4** `portaudio19-dev` and `libasound2-dev` — same issue, dev packages in runtime. Use `libportaudio2` and `libasound2` (runtime) instead.
- **O5** `PYTHONPATH=/config/.local/lib/python3.11/site-packages:` has a trailing colon, making the last entry an empty string in PYTHONPATH. This means Python will search `""` (cwd) as a module path — minor security concern (import from cwd). Remove trailing colon.

---

## 2. run.sh

**File:** `openclaw_ha_addon/run.sh`

### ✅ Good
- D-Bus/Avahi startup: `dbus-daemon --system --fork` with socket wait loop, then `avahi-daemon --daemonize --no-drop-root` — correct
- Browser config bootstrap: `python3 "$HELPER_PATH" ensure-browser-config` — called
- Memory-core bootstrap: `python3 "$HELPER_PATH" ensure-memory-core` — called
- Gateway supervisor loop with 3-tier PID detection (port → pgrep → /proc scan) — well designed
- Shutdown trap for nginx, ttyd, gateway, relay — complete
- jq parsings with `// empty` and `// "default"` — no falsy-fall traps
- Skills sync with rsync/cp fallback — robust
- Homebrew persist with symlink — robust
- npm global redirect to `/config/.node_global/` — correct
- TLS cert generation with SANs, CA persistence, IP change detection — solid
- Single-instance guard with flock — correct
- Stale PID cleanup for nginx and ttyd — correct
- Gateway env var protection (reserved keys, validation, limits) — comprehensive
- Terminal port validation (1024-65535, numeric check) — correct
- Proxy shim for undici — correct

### ⚠️ Required Changes

| # | File | Line(s) | Problem | Fix |
|---|------|---------|---------|-----|
| R3 | run.sh | N/A | **`mdns_mode`, `mdns_host_name`, `mdns_service_port`, `mdns_interface_name` options are defined in config.yaml but NEVER read or used in run.sh.** Users can configure these in the HA UI but they have zero effect. | Read these options from `$OPTIONS_FILE` and pass them to `oc_config_helper.py set-mdns-settings`. Example: `MDNS_MODE=$(jq -r '.mdns_mode // "minimal"' "$OPTIONS_FILE")` etc., then call `python3 "$HELPER_PATH" set-mdns-settings "$MDNS_MODE" "$MDNS_SERVICE_PORT" "$MDNS_HOST_NAME" "$MDNS_INTERFACE_NAME"`. |
| R4 | run.sh | N/A | **`gateway_log_to_console`, `gateway_log_level`, `trace_log_to_console` options are defined in config.yaml but NEVER read or implemented in run.sh.** Users can toggle these in the HA UI but nothing happens. | Read these options and implement: (1) `gateway_log_to_console=true` → pipe gateway stdout/stderr to the HA log (add `2>&1 | tee -a ...` or similar). (2) `gateway_log_level` → set `LOG_LEVEL` env var or pass to `openclaw gateway run --log-level`. (3) `trace_log_to_console=true` → enable `set -x` before gateway start and pipe trace output. |
| R5 | run.sh | N/A | **`runtime_apt_packages` option is defined in config.yaml but NEVER read or implemented in run.sh.** | Read `RUNTIME_APT_PACKAGES=$(jq -r '.runtime_apt_packages // empty' "$OPTIONS_FILE")`, and if non-empty, run `apt-get update && apt-get install -y --no-install-recommends $RUNTIME_APT_PACKAGES` before gateway start. Add timeout/error handling. |
| R6 | run.sh | N/A | **`custom_init_script` option is defined in config.yaml but NEVER read or implemented in run.sh.** | Read `CUSTOM_INIT_SCRIPT=$(jq -r '.custom_init_script // empty' "$OPTIONS_FILE")`, and if non-empty and the file exists + is executable, run it before gateway start. Log output. |
| R7 | run.sh | ~line 25 | **`controlui_disable_device_auth` default mismatch.** config.yaml defines default as `false`, but run.sh reads it with `// true` (`jq -r '.controlui_disable_device_auth // true'`). This means when the option is absent/not set, the behavior contradicts the declared default. | Change run.sh to `jq -r '.controlui_disable_device_auth // false'` to match config.yaml default. OR change config.yaml default to `true` to match DOCS.md which says "ON recommended". The current state is that config says default=false, run.sh effectively defaults=true, and DOCS.md recommends true — pick one and make all three consistent. |

### 💡 Observations

- **O6** The `set +x` (line ~76) disables xtrace before proxy/token handling, which is good. But `trace_log_to_console` (if/when implemented) would need to selectively re-enable it for the gateway startup section.
- **O7** The D-Bus startup uses `for i in $(seq 1 10); do ... sleep 0.5; done` — this waits up to 5 seconds. On slow SD cards, this might not be enough. Consider increasing to 20 iterations (10s) with a log message at halfway.
- **O8** The `find_gateway_daemon_pid` Tier 1 uses `ss -tlnp` which requires root/capabilities. In HAOS containers with dropped capabilities, this might fail silently. The fallback tiers cover this, but worth noting.
- **O9** The `start_openclaw_runtime()` function backgrounds `openclaw gateway run` with `&`, making GW_PID a child of the shell. The supervisor loop's `wait` on this PID is correct, but the comment says "thin wrapper that spawns `openclaw-gateway` as a long-running daemon and then exits" — this means `wait` returns quickly (when the wrapper exits), and then the loop must find the actual daemon PID. This is handled correctly by the 3-tier detection, but it's a subtle and fragile design. Worth documenting more explicitly.
- **O10** The `NODE_OPTIONS` construction at lines ~91-100 adds `--dns-result-order=ipv4first` twice if `FORCE_IPV4_DNS=true` AND the initial `NODE_OPTIONS` block already added it. The first block adds it unconditionally, then the `force_ipv4_dns` check adds it again. Result: `NODE_OPTIONS="--max-old-space-size=4096 --dns-result-order=ipv4first --dns-result-order=ipv4first"`. Not harmful (Node ignores duplicates) but sloppy.

---

## 3. oc_config_helper.py

**File:** `openclaw_ha_addon/oc_config_helper.py`

### ✅ Good
- Atomic write with temp-file + rename — correct
- Deep merge with prototype pollution protection (`__proto__`, `constructor`, `prototype` blocked) — correct
- CLI commands well-structured with argument validation
- `ensure_browser_config()` sets headless, noSandbox, executablePath, timeout, extraArgs — good baseline
- `ensure_memory_core()` sets `memory-core.enabled` and `dreaming.enabled` — correct
- `set_mdns_settings()` handles avahi/off/minimal/full modes — correct logic
- `cleanup_stale_config_keys()` handles deprecated keys — good

### ⚠️ Required Changes

| # | File | Line(s) | Problem | Fix |
|---|------|---------|---------|-----|
| R8 | oc_config_helper.py | `ensure_browser_config()` defaults dict | **Missing `localLaunchTimeoutMs` and `localCdpReadyTimeoutMs`** per the memory decision spec. These are critical for ARM64 where Chromium launch is slow. Without them, the default timeouts (often 10-15s) may cause browser automation failures on Raspberry Pi. | Add to the `defaults` dict: `"localLaunchTimeoutMs": 30000` and `"localCdpReadyTimeoutMs": 15000`. These match the memory decision spec. |

### 💡 Observations

- **O11** `ensure_browser_config()` sets `executablePath: "/usr/bin/chromium"` which is a symlink to the Playwright Chromium. This is correct, but the extraArgs include `--disable-software-rasterizer` and `--no-default-browser-check` per the memory spec, but NOT `--disable-background-networking`, `--disable-sync`, `--disable-default-apps`, `--disable-extensions`, `--disable-translate`, `--disable-notifications` which ARE in the code but were NOT in the memory spec. This is fine — the code is more comprehensive — but document the deviation.
- **O12** The `set` command (line ~230) only writes to `gateway` sub-key: `gateway = cfg.setdefault("gateway", {}); gateway[key] = value`. This means `oc_config_helper.py set browser.enabled true` would create `gateway.browser.enabled` instead of `browser.enabled`. This is a latent bug but not currently called with non-gateway keys from run.sh.
- **O13** `generate_mdns_nginx_snippet()` returns empty string when `public_port == internal_port` and the returned snippet never actually generates nginx config — it just returns a comment. This function is effectively a no-op placeholder.

---

## 4. config.yaml

**File:** `openclaw_ha_addon/config.yaml`

### ✅ Good
- Version `0.7.7.0` — correct
- Schema validation for all options — comprehensive
- `gateway_env_vars` uses `match(^[A-Z_][A-Z0-9_]*$)` for name validation — good
- Port ranges validated (`int(1024,65535)`, `int(1,65535)`)
- `access_mode` list type with all 5 modes — complete
- `mdns_mode` includes `avahi` option — matches helper implementation

### ⚠️ Required Changes

| # | File | Line | Problem | Fix |
|---|------|------|---------|-----|
| R9 | config.yaml | 3 | **Header comment says `v4.23` — outdated.** Should reference v0.7.7.0 changes (CUPS, Scanner, crawl4ai, Go-PATH fix, D-Bus/Avahi). | Update header comment to reflect v0.7.7.0 changes. |

### 💡 Observations

- **O14** `controlui_disable_device_auth: false` — The DOCS.md says "ON recommended" and run.sh defaults it to `true`. See R7. Should be `true` if "ON recommended" is the desired default.
- **O15** `hassio_api: false` and `homeassistant_api: false` — This means the addon can't use the HA Supervisor API or HA REST API natively. The `homeassistant_token` + MCP approach is the workaround, but worth noting that `hassio_api: true` would allow `SUPERVISOR_TOKEN` for the HA API without user-configured tokens.
- **O16** Schema for `gateway_env_vars` uses `match(^[A-Z_][A-Z0-9_]*$)` which is correct for env var names, but run.sh also allows lowercase in the legacy object/string parsing paths. Inconsistency — the schema enforces uppercase-only, but run.sh would accept lowercase from legacy formats.

---

## 5. repository.yaml

**File:** `repository.yaml`

### ⚠️ Required Changes

| # | File | Line | Problem | Fix |
|---|------|------|---------|-----|
| R10 | repository.yaml | 8 | **Version `0.7.6.0` does NOT match config.yaml version `0.7.7.0`.** Out of sync. | Update `version: "0.7.6.0"` to `version: "0.7.7.0"`. |

### 💡 Observations

- **O17** `slug: openclaw-ha-addon` in repository.yaml vs `slug: openclaw_ha_addon` in config.yaml. HA uses underscores in the addon slug (derived from folder name) but repository.yaml uses hyphens. This is actually normal (repository.yaml slug is for the repository listing, not the addon itself), but worth verifying it doesn't cause issues with HA Supervisor's slug resolution.

---

## 6. render_nginx.py

**File:** `openclaw_ha_addon/render_nginx.py`

### ✅ Good
- Template substitution for all placeholders — correct
- HTTPS block generated only when `lan_https` mode — correct
- Token from environment (not hardcoded) — correct
- CA cert download location `/cert/ca.crt` — matches nginx.conf.tpl
- Landing page disk info rendering — correct
- nginx SIGHUP reload after re-render — correct

### 💡 Observations

- **O18** The `token` from environment is set by `render_landing()` in run.sh via `GW_TOKEN` env var. It reads directly from `openclaw.json` via Python. This is secure (token not in URL params for the initial render), but the landing page HTML template has `__GATEWAY_TOKEN__` which gets embedded in the `href` attribute of the "Open Gateway Web UI" button. This means the token is in the HTML source visible to anyone who inspects the page. This is by design (convenience feature) but worth noting.

---

## 7. Docs

### CHANGELOG.md (in openclaw_ha_addon/)

### ✅ Good
- v0.7.7.0 entry present with all major changes
- v0.7.6.1 entry present
- Historical entries back to v0.7.5

### 💡 Observations

- **O19** CHANGELOG v0.7.7.0 lists "Browser-Config Bootstrap" but doesn't mention `localLaunchTimeoutMs`/`localCdpReadyTimeoutMs` (which may not be set yet — see R8). When R8 is fixed, update changelog to note these specific timeout values.

### DEPLOYMENT.md

### ✅ Good
- Version matrix up to date (0.7.7.0 / 2026.6.8 / 2026-06-16)
- RAM configuration documented (4GB heap)
- Port safety documented

### 💡 Observations

- **O20** Image size table lists "Homebrew (persistent): ~3.2 GB" but total says "~1.9 GB". The math without Homebrew: 400+956+300+200+55 = ~1.9 GB. Homebrew is NOT in the image (it's synced to persistent at runtime from the image copy, but the image itself contains it during build). The "Total Image" should include Homebrew's image-time footprint. If Homebrew is ~3.2 GB in persistent storage but was ~1 GB at image build time (before user packages), the total image size is likely ~2.9 GB, not 1.9 GB. Clarify whether "Total Image" means Docker image size or runtime persistent storage.

### DOCS.md

### ✅ Good
- Comprehensive — covers architecture, installation, configuration, use cases, troubleshooting
- Access modes well documented
- CUPS/Scanner mentioned in Bundled Tools table

### ⚠️ Required Changes

None beyond the items already covered (config option gaps are run.sh issues).

### 💡 Observations

- **O21** DOCS.md mentions `crawl4ai` in the Bundled Tools table but doesn't explain how to use it or its limitations (no ML deps). Add a brief note about crawl4ai being base-only (no torch/transformers) and how to verify with `python3 -c 'import crawl4ai'`.

### README.md, SECURITY.md

### ✅ Good
- README covers features, installation, configuration, security
- SECURITY.md is comprehensive — covers autonomous agent risks, network exposure, prompt injection, etc.
- Both are current and well-structured

---

## 8. Translations

### en.yaml

### ✅ Good
- All config.yaml options have translations
- Descriptions are clear and match the options

### de.yaml

### ✅ Good
- Complete translation of all options
- Consistent with en.yaml structure

### bg.yaml, es.yaml, pl.yaml, pt-BR.yaml

### ✅ Good
- All 6 translation files cover every config.yaml option
- All include the `avahi` mDNS option
- All include `runtime_apt_packages`, `custom_init_script`, `gateway_log_to_console`, etc.

### 💡 Observations

- **O22** All translations describe options that don't actually work yet (mdns_*, gateway_log_*, runtime_apt_packages, custom_init_script). Users will see these options in the HA UI, configure them, and nothing will happen. This is a user experience issue tied to R3-R6.

---

## 9. Sonstige Dateien

### brew-wrapper.sh

### 💡 Observations

- **O23** Uses `su linuxbrew -c "..."` but after run.sh runs, `/home/linuxbrew/.linuxbrew` is a symlink to `/config/.linuxbrew`. The `su` command should still work (symlinks are transparent), but the wrapper is never called from run.sh or any other script in the repo. It appears to be **dead code** — no reference to it anywhere. Consider removing or documenting its intended use case.

### oom-shim.cjs

### ✅ Good
- Simple, correct — sets `oom_score_adj` to 0 for the gateway process
- Handles missing `/proc` gracefully
- Loaded via `NODE_OPTIONS --require` — correct

### openclaw-proxy-shim.cjs

### ✅ Good
- Enables HTTP(S) proxy support for undici before OpenClaw initializes
- Resilient — catches errors if module layout changes
- Uses `OPENCLAW_GLOBAL_NODE_MODULES` env var — correct

### oc-cleanup.sh

### ✅ Good
- Interactive disk space monitor with cleanup options
- Shows Docker prune commands for host-level cleanup
- Color-coded warnings for disk thresholds

### nginx.conf.tpl, landing.html.tpl

### ✅ Good
- Placeholders (`__TERMINAL_PORT__`, `__NGINX_ACCESS_LOG__`, `__HTTPS_GATEWAY_BLOCK__`, `__GATEWAY_TOKEN__`, etc.) all match `render_nginx.py` substitution calls
- Landing page has status grid, action buttons, access wizard, disk monitoring
- Client-side gateway health check and error translation
- CA cert download button for lan_https mode

---

## 10. Gesamt-Architektur

### ✅ Good
- Three-service architecture (gateway + nginx + ttyd) — clean separation
- Persistent storage strategy is well-designed: `/config/` survives rebuilds, symlinks for Homebrew/skills
- Gateway supervisor loop with self-restart detection — robust
- Security: reserved env vars, token validation, port validation, proxy protection
- Multi-arch support (ARM64 + AMD64)
- mDNS via Avahi with D-Bus — root cause correctly identified and fixed

### 💡 Observations

- **O24** **No `--no-deps` or explicit torch exclusion for crawl4ai.** The memory decision says "torch, transformers, scipy EXPLIZIT AUSSCHLIESSEN" but `uv pip install --system crawl4ai` installs all default dependencies. If crawl4ai's base dependencies include numpy (likely), it will be in the image. If torch is a transitive dep (unlikely for base), it will also land. **Verify at build time** that the installed crawl4ai doesn't pull in undesired ML deps. Run `pipdeptree -p crawl4ai` or `uv pip show crawl4ai` to check.
- **O25** **PYTHONPATH trailing colon** (Dockerfile line ~150) adds `""` (cwd) to Python module search path. This is a minor security concern — a malicious `.py` file in the working directory could be imported accidentally.
- **O26** **builder stage waste.** The `FROM debian:bookworm-slim AS builder` stage installs ~200MB of build tools that are never used (no `COPY --from=builder`). This wastes Docker build cache and network bandwidth on every build.
- **O27** **Dev packages in runtime.** `libvips-dev`, `libopenblas-dev`, `portaudio19-dev`, `libasound2-dev` include headers and static libs that are only needed at compile time. Replacing with runtime-only equivalents (`libvips`, `libopenblas0`, `libportaudio2`, `libasound2`) would save ~50-100MB in the image.

---

## Zusammenfassung: Required Changes

| # | File | Problem | Severity |
|---|------|---------|----------|
| R1 | Dockerfile:3-17 | Builder stage defined but never used — remove or wire up | Medium |
| R2 | Dockerfile:68 | `build-essential` in runtime image (~200MB) — move to builder or justify | Medium |
| R3 | run.sh | `mdns_mode`, `mdns_host_name`, `mdns_service_port`, `mdns_interface_name` options not implemented | High |
| R4 | run.sh | `gateway_log_to_console`, `gateway_log_level`, `trace_log_to_console` options not implemented | High |
| R5 | run.sh | `runtime_apt_packages` option not implemented | Medium |
| R6 | run.sh | `custom_init_script` option not implemented | Medium |
| R7 | run.sh / config.yaml | `controlui_disable_device_auth` default mismatch (false in config.yaml, true in run.sh fallback) | High |
| R8 | oc_config_helper.py | `ensure_browser_config()` missing `localLaunchTimeoutMs` and `localCdpReadyTimeoutMs` | High |
| R9 | config.yaml:3 | Header comment outdated (`v4.23`) | Low |
| R10 | repository.yaml:8 | Version `0.7.6.0` ≠ config.yaml `0.7.7.0` — out of sync | High |

---

## Advisory-Liste (nicht blockierend)

| # | File | Topic | Recommendation |
|---|------|-------|---------------|
| A1 | Dockerfile:117 | Stale comment "v0.7.5.4" | Update to "2026.6.8" |
| A2 | Dockerfile | crawl4ai transitive deps may include numpy/scipy | Verify at build time with `uv pip show crawl4ai` |
| A3 | Dockerfile | Dev packages in runtime (`-dev` suffix) | Replace with runtime-only equivalents |
| A4 | Dockerfile:150 | PYTHONPATH trailing colon | Remove trailing `:` |
| A5 | run.sh | `NODE_OPTIONS` may contain duplicate `--dns-result-order=ipv4first` | Deduplicate |
| A6 | run.sh | brew-wrapper.sh appears unused (dead code) | Remove or document |
| A7 | oc_config_helper.py | `set` command only writes to `gateway` sub-key | Document limitation or extend |
| A8 | oc_config_helper.py | `generate_mdns_nginx_snippet()` is effectively a no-op placeholder | Implement or remove |
| A9 | DEPLOYMENT.md | Image size math doesn't add up (1.9 GB total excludes Homebrew image footprint) | Clarify |
| A10 | DOCS.md | crawl4ai usage/limitations not documented | Add brief note |
| A11 | All translations | Options described that don't work yet (R3-R6) | Update after implementing R3-R6 |

---

*End of Audit Report*