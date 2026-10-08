# Changelog — OpenClaw Assistant (Home Assistant App)

Release-facing summary. Detailed per-release engineering notes: [openclaw_ha_addon/CHANGELOG.md](openclaw_ha_addon/CHANGELOG.md).

## 0.7.12.7
- **Security — OWASP LLM01 Control #5, invisible-unicode guard:**
  - **Gap:** OpenClaw 2026.9.8's naive character-class strip broke valid ZWJ emoji, ignored isolated variation selectors (U+FE00–U+FE0F, a documented prompt-injection channel) and left web_search results completely unstripped.
  - **Fix:** build patch `unicode-guard/` splices the tested implementation into every naive copy in the dist tree (including minified worker bundles), anchor-exact with a loud build failure on upstream drift.
  - **Tests & details:** 15 tests; behavior + tradeoffs in `unicode-guard/README.md`.
  - 15 tests, behavior + tradeoffs in `unicode-guard/README.md`.
- **Watchdog kill on clean Pi boot fixed:** HEALTHCHECK start-period 120s → 420s, retries 3 → 4. Evidence — Supervisor log 2026-10-07 19:41:39 ("unhealthy, restarting" + docker kill exit 137) despite a clean boot: Homebrew sync/skill copy/gateway init can take >4 minutes on the Pi; the old window expired before the first `/startupz` response. Fails within the start period do not count against the retries; genuine hangs are still detected quickly (4 consecutive fails at 30s each).
- **V21 — external WebUI button ("WebUI ↗") always targets the ingress URL:** instead of the statically rendered `__GATEWAY_PUBLIC_URL__` (boot-time LAN IP, unusable externally) it now sets client-side same-origin `./webui/#token=<token>` — exactly the path + autologin of the working inline tab. Since 0.7.12.1 the landing runs exclusively inside the HA ingress session (local + external via Nabu/DyndNS identical), so `./webui/` is always correct. LAN-18789 bypass deliberately dropped (functionally irrelevant); no Python/nginx touch.
- **`sshpass` baked into the image (apt zone 1):** was a runtime install only and vanished on every rebuild/container swap; verified on Debian bookworm/main arm64 (1.09-1).

## 0.7.12.6
- **Build fix after the failed first Supervisor build:** import check switched to `importlib.metadata` (crawl4ai's `__version__` is a submodule; the old masked check hid the same bug). Re-tag executed: `main`=`f8b1ca0`, tag `v0.7.12.6`→`032a5c5` (forced update), release object follows the tag.
- **Durable fix — browser links decay on every arm64 rebuild**:
  - **Failure:** Playwright 1.63 installs arm64 Chromium under `chromium-<rev>/chrome-linux-arm64/`; the old Dockerfile glob `chromium-*/chrome-linux/chrome` matched only the x64 layout → `ln -sf` silently produced dangling symlinks (masked by `|| echo 'version check failed'`) → green build, dead browser tool while the binary existed at `/opt/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`.
  - **Fix:** `browser_links.sh` (in-image as `/usr/local/bin/link-playwright-chromium`) as the single source — layout-agnostic resolution (`chromium-*/chrome-linux*/chrome`, highest revision wins), links `/usr/bin/chromium` + `/usr/bin/chromium-browser`, fails the build hard when nothing is found; run.sh additionally repairs the link on every start (boot self-heal).
- **crawl4ai/patchright revision sync**: crawl4ai launches browsers through playwright AND patchright — both pin their own Chromium revision. The crawl4ai build layer reinstalls both (`playwright install chromium && patchright install chromium`, no-op at revision parity) so a future crawl4ai bump never leaves a missing revision in `/opt/ms-playwright`. Stale Dockerfile comment (a non-existent run.sh ms-playwright symlink promise) corrected.
- **Version pinning**: `crawl4ai==0.9.4`, `playwright==1.63.0`, `patchright==1.63.0` pinned (all three = PyPI latest at the 2026-10-07 survey) — reproducible builds; future updates go deliberately through the release flow (survey + audit + GO) instead of build-time chance.

## 0.7.12.5
- **Hotfix — gateway exit loop on chat start**:
  - **Trigger:** OpenClaw 2026.9.8 terminates the gateway on every unclassified unhandled rejection (`process.exit(1)`).
  - **Mechanism:** on the Pi, chat start blocks the event loop for 13–25 s (plugin-tools init, SQLite reclamation); each chat start rejects a silent promise with `reason === undefined` → immediate exit ("Unhandled promise rejection: undefined") and a restart loop.
  - **Fix:** new `undefined-rejection-shim.cjs` (via `NODE_OPTIONS=--require` ahead of all OpenClaw modules) registers a filter in the OpenClaw handler registry (`Symbol.for("openclaw.unhandledRejection.handlers")`) classifying only `reason === undefined` as handled; all other rejections continue through the 9.8 policy unchanged. Dockerfile: shim into `/app/undefined-rejection-shim.cjs`; run.sh: `--require` in both NODE_OPTIONS branches.

## 0.7.12.4
- **Performance — RAM-adaptive heap budget**: the static 4 GB Node heap kept OpenClaw's memory-pressure threshold below the gateway's normal working set on this host, stalling `sessions.list` for 5+ seconds; the heap now sizes from host RAM (≥12 GB → 6144 MB here).
- **P0 — server TLS certificate generation restored** (lost in the v0.7.10.0 refactor; fresh lan_https installs had no server cert) and hardened with X.509v3 extensions (basicConstraints/keyUsage/EKU) so strict clients accept it.
- **Fixed — boolean option trap**: explicit `false` options were silently reverted to defaults by jq's `//` operator on every start (6 reads fixed).
- **Fixed — 502 during startup** now shows the loading page (terminal hint included) instead of a raw error.
- **OpenClaw 2026.9.8** (no schema migrations, low-risk bump; agentId fix native, tarball-verified). **Added**: `openssh-client` (sandbox SSH), supervisor watchdog, `backup_exclude` (~12 GB smaller HA backups). **Removed**: dead `router_ssh_*` options; hardcoded `cron_skip_missed_jobs` and session-lock cleanup (always-on).

## 0.7.12.3
- **Terminology: Add-ons → Apps** — all user-facing texts follow the official "Apps" naming Home Assistant introduced with 2026.2 (README, DOCS, SECURITY, CONTRIBUTING, DEPLOYMENT, UI translations, landing page, runtime log messages). Technical identifiers stay untouched (slug `openclaw_ha_addon`, `addon_config` mount, Supervisor API, repo URL) — matching the upstream supervisor design. Also fixes the mDNS default in the es/bg/pl/pt-BR translations (claimed "openclaw-ha-addon", actual default "openclaw").

## 0.7.12.2
- **Ingress asset compression restored** (3.4× less transfer on ControlUI cold loads): static-asset locations pass `Accept-Encoding` through to the gateway (native brotli/gzip); HTML locations keep `identity` for `sub_filter`.
- **CSP synced with upstream 2026.9.6**: `frame-src` added (link previews were blocked), `img-src https:` added (remote avatars were blocked), `connect-src data:` added, `'unsafe-eval'` → `'wasm-unsafe-eval'` (bundle-verified, zero eval consumers).

## 0.7.12.1
- **Security — Ingress lockdown**: nginx `:49200` accepts only loopback + Supervisor network (`172.30.32.0/23`); the unauthenticated LAN root-shell (ttyd terminal/TUI) and the token-bearing landing page are now exclusively reachable through the authenticated HA Ingress session.
- **Security — token file permissions**: rendered `nginx.conf` (contains the gateway bearer token) is written with `0600` instead of `0644`.
- **Terminal-first boot**: nginx + web terminal start BEFORE the gateway — the Ingress panel is reachable during slow SQLite startup; Terminal is the default tab.
- **TUI removed** (superseded by the bash Terminal as fallback surface): tab, ttyd instance, `enable_tui`/`tui_port`/`tui_session` options.
- **Fix**: `cron_skip_missed_jobs` restored to the options schema (supervisor warning since 0.7.11.1); CRLF normalization for `oc_config_helper.py`; dead TUI/docs copy block removed; translations completed for all 6 languages (schema parity, stale keys removed); audit hardening — gateway-start failure keeps the container alive (terminal stays reachable), hardcoded `18790` replaced with the gateway-port placeholder.

## 0.7.12.0
- **OpenClaw 2026.9.6**: restart recovery for interrupted conversations and subagents, slow-startup detection (exit 2 = starting, not failed), `openclaw doctor --session-sqlite recover`, lossless history/storage compaction (schema 23/18 — one-way migration, backup taken), WebChat reconnect resilience with "Forget this browser", KillMode=mixed repair via Doctor.
- agentId patch remains native in 2026.9.6 (tarball-verified).
- All 0.7.11.15.x ingress fixes retained.


## 0.7.11.15.3

- **Fix "Gateway not reachable" through Nabu Casa/Ingress after reconnects (the real killer)**: the ControlUI stores the gateway URL without a trailing slash (`…/webui`), and nginx answered that exact path with a `301` redirect — WebSocket clients never follow redirects, so every reconnect after Supervisor idle kills died at the redirect. New explicit `location = /webui` proxies directly with WebSocket headers. Verified live: `GET /webui` → 200 (was 301), WS upgrade → 101; confirmed end-to-end via Nabu Casa from the iOS Companion App. (d037bd1)

## 0.7.11.15.2

- **Fix Ingress ControlUI asset 404s (local + Nabu Casa)**: HA Supervisor sends `X-Ingress-Path` without the `/webui` panel suffix; new `$ingress_path_norm` map normalizes all prefixes. (dbc00fe)
- **Fix stale cached gateway URLs**: the injected ControlUI cleanup script now removes any `gatewayUrl`/`bootRecord` localStorage entry that does not match the current ingress base path, forcing re-derivation on every load. (0d32951)
- nginx `sub_filter`/map changes only — no OpenClaw or startup changes.

## 0.7.11.15.1

- **Ingress WebSocket through HA/Nabu Casa**: force loopback `Host` header so OpenClaw 2026.9.5 treats Ingress traffic as local; unauthenticated nginx locations under `/webui/` for static assets so the Supervisor can fetch them without the add-on bearer token; remove duplicate `/webui` suffix from base-path maps.
- Conservative nginx-only fix release; no OpenClaw version or add-on startup changes. (Not tagged as a release; superseded by 0.7.11.15.2 within a day.)

## 0.7.11.11

- **Rollback**: revert the add-on code base to v0.7.11.3, the last release where HA Ingress (including Nabu Casa remote access) worked reliably. The nginx/Ingress changes from v0.7.11.4–v0.7.11.10 broke the ControlUI WebSocket through Nabu Casa and are intentionally excluded. (b681274)

## 0.7.11.3

- **Fix OpenClaw OpenAI-compatible endpoint for HA Assist pipeline** (OpenClaw 2026.9.4 regression):
  - The `/v1/chat/completions` endpoint was returning `500 internal error` because `buildAgentCommandInput` did not pass the resolved `agentId` to `agentCommandFromGatewayIngress`.
  - Patched `openai-http-CACctX8Y.mjs` at build time to preserve `agentId` through the request lifecycle.
  - This restores Assist Pipeline / conversation agent functionality for multi-agent (`agents.ownership: explicit`) setups.

## 0.7.11.2
- Fix the Docs/Info tab showing unrendered placeholders (`__OPENCLAW_VERSION__`, `Gateway: unreachable`, `Ingress: unknown`):
  - Convert `docs/index.html` into a rendered template (`docs/index.html.tpl`) so `render_nginx.py` can substitute version, access mode, and network mode at startup.
  - Update Dockerfile to copy the template into the image.
  - Correct the JS health probe path from `./api/health` to `../api/health` because the docs page is served under `/docs/`.
  - Remove the unrelated AI-Stack port table entries (Hermes, n8n, Ollama, etc.) from the add-on docs page to avoid confusion.

## 0.7.11.1
- Add `tui_session` configuration option (default `agent:main:main`) so the embedded OpenClaw TUI opens the correct default session after onboarding instead of hard-coded `agent:coding-main:main`.
- Update `DOCS.md`:
  - Correct Ingress port (49200) and service list (WebUI, Terminal, TUI, Docs).
  - Replace all outdated `access_mode` / `gateway_bind_mode` references with the current `network_mode` presets.
  - Add health-check documentation (`/api/health`, `/webui/healthz`, `/startupz`).
  - Document the new `tui_session` option.

## 0.7.11.0
- Improve Ingress / gateway health detection:
  - Dockerfile HEALTHCHECK now also verifies the OpenClaw gateway `/startupz` endpoint (read from persisted `openclaw.json` at check time), not just the nginx ingress port.
  - Landing page polls both ingress health and OpenClaw gateway `/healthz` for a deeper readiness indicator.
- Make CSP/X-Frame-Options stripping more precise:
  - Still replace OpenClaw's `frame-ancestors 'none'` to allow HA Ingress iframe embedding, but preserve the rest of the bundled CSP.
  - Document the upstream blocker (openclaw/openclaw#78577) so the override can be removed once a config knob exists.

## 0.7.10.32
- Fix OpenClaw ControlUI ingress WebSocket fallback to `127.0.0.1:18789`:
  - Remove duplicate `sub_filter` on `<html>` that produced an invalid double `data-openclaw-control-ui-base-path=""` attribute.
  - Inject a client-side script that derives the HA Ingress base path from `window.location.pathname`, removes any duplicate attribute, and deletes stale `localStorage` gateway/boot-record entries that still contain `127.0.0.1:18789`.

## 0.7.10.29
- Update OpenClaw to **2026.9.4**.
- No schema or Node changes required; NodeSource `node_24.x` (Node 24.20.0) continues to satisfy OpenClaw's minimum requirement.
- Highlights: safer rollback for compatible failed updates, unified Plugins workspace in Control UI, terminal question prompts, improved conversation-history recovery, read-only config mode via `OPENCLAW_CONFIG_READONLY=1`.

## 0.7.10.28
- Update OpenClaw to **2026.9.3**.
- Align add-on version, Dockerfile, and installed OpenClaw version (fixes prior 0.7.10.26/27 mismatch where the image still contained older OpenClaw releases).
- NodeSource `node_24.x` provides Node 24.20.0, satisfying OpenClaw 2026.9.3 minimum Node requirement (24.16.0+).

## 0.7.10.27
- Fix Dockerfile to actually install `openclaw@2026.9.2`; bump add-on version so HA rebuilds the image.

## 0.7.10.26
- Intended OpenClaw 2026.9.2 update (Dockerfile was not updated in this release; superseded by 0.7.10.27/28).
- Force uncompressed ControlUI HTML from the OpenClaw gateway by sending `Accept-Encoding: identity` for `/webui/` upstream requests. This allows nginx `sub_filter` to rewrite absolute asset links to the correct HA Ingress path and fixes the black screen / "Control UI did not start" error.
- Use relative asset prefixes (`./assets/`, `./themes/`, etc.) as fallback when `X-Ingress-Path` is missing.

## 0.7.10.25
- Update OpenClaw to **2026.9.1**.
- **Add-on schema**: add `cron_skip_missed_jobs` (default `true`) and `blocked_hostnames` options for OpenClaw 2026.9.1 configuration controls.
- **run.sh**: log detected OpenClaw version at startup for easier support diagnosis.
- **Note**: OpenClaw 2026.9.1 introduces `cron.skipMissedJobs` and `blockedHostnames`. Back up `/config/clawd` before the first start after updating.

## 0.7.10.23
- Fix OpenClaw ControlUI ingress loading: remove trailing slash from base path to avoid double slashes in dynamically constructed URLs (`/webui//themes/...`).
- Rewrite `/themes/` asset links inside the Ingress proxy (previously only `/assets/` was handled).
- Restrict nginx `sub_filter` to `text/html` responses to avoid corrupting JS/CSS bundles.

## 0.7.10.22
- Fix external HTTPS access (lan_https mode): remove X-Forwarded-* / X-Real-IP headers from the HTTPS proxy block so OpenClaw 2026.8.2 no longer rejects the request with proxy_attribution_required.

## 0.7.10.21
- Fix OpenClaw ControlUI asset loading inside HA Ingress when X-Ingress-Path header is missing by rewriting asset links to relative URLs (with absolute fallback when the header is present).
## [0.7.9.24] - 2026-08-23

### Changed
- **Landing page redesign**: Home Assistant Material Design 3 style with cards, chips and tile navigation.
- **Security**: `__GATEWAY_TOKEN__` is escaped with `html.escape()` in `render_nginx.py`.
- **Features restored**: CA cert download (only `lan_https`) and disk usage display in the footer.

## [0.7.9.23] - 2026-08-23

### Fixed
- **Ingress Gateway Health Sensor (HA iframe path)**: Changed health fetch from absolute `/api/health` to relative `./api/health` in landing page, TUI and docs, so requests resolve correctly inside the HA Ingress iframe context.

## [0.7.9.22] - 2026-08-23

### Fixed
- **Ingress Gateway Health Sensor**: `/api/health` now proxies to the actual OpenClaw Gateway `/health` endpoint instead of returning a static nginx 200 OK.
- landing, TUI and docs pages parse JSON response and check `data.ok`.

## [0.7.9.21] - 2026-08-23

### Fixed
- **Codex ACP Wrapper auth race**: `resolveProviderEnv()` is now called before checking/writing `auth.json`, ensuring the Ollama fallback key is correctly visible to the wrapper.

## [0.7.9.20] - 2026-08-23

### Fixed
- **Plugin API version compatibility**: `run.sh` now exports a plain semver string for `OPENCLAW_VERSION` so the plugin API compatibility check (`>=2026.7.1`) passes and ACPX loads.

## [0.7.9.19] - 2026-08-13

### Fixed
- Quote ACPX_ENABLED jq selector in run.sh.

## [0.7.9.18] - 2026-08-13

### Fixed
- Line-ending normalization in `run.sh` so HA picks up the file correctly.

## [0.7.9.4] - 2026-08-13

### Added
- Dedicated TUI terminal via ttyd running `openclaw tui`.

## [0.7.9.3] - 2026-08-13

### Added
- Ingress iframe auto-login, terminal fix, CSP override.

## [0.7.9.2] - 2026-08-13

### Changed
- Bump OpenClaw to 2026.7.1-2 and node-llama-cpp to 3.20.0.

## [0.7.9.1] - 2026-08-13

### Changed
- Ingress UI refactor fixes.
