## [0.7.12.0] - 2026-09-25

### Changed
- **OpenClaw**: Update to `2026.9.6` (from 2026.9.5). Major upstream improvements relevant to this add-on:
  - **Restart recovery**: unfinished conversations survive restarts with saved history, progress and tool results; interrupted subagents are continued by the leading agent instead of auto-relaunching (fixes the recurring boot-time "Cannot delete session while competing work is in flight" zombie sessions).
  - **Slow-startup detection**: health/restart checks now distinguish "still starting" from "failed" (exit code 2 = starting). Directly mitigates the SQLite session-reclamation startup timeout on high-usage SD-card installs.
  - **`openclaw doctor --session-sqlite recover`**: new repair tool for session databases.
  - **Storage compaction** (agent schema 23, shared-state schema 18): lossless history compression + compact memory vectors. Migration is one-way — downgrades require the pre-upgrade backup. A full WAL-consistent backup of all 31 agent/state DBs was taken before this release (integrity-verified).
  - **WebChat reconnect resilience**: chat stays usable during reconnects; "Forget this browser" in Settings → Connections resets stale browser sign-ins (the tool we were missing during the localStorage debugging).
  - **KillMode=mixed systemd policy repair** via Doctor (resolves the long-standing stale service-unit warning).
- **Dockerfile**: no agentId patch block needed — the openai-http agentId fix remains native in 2026.9.6 (tarball-verified).

### Notes
- Ingress fixes from 0.7.11.15.x (asset paths dbc00fe, localStorage cleanup 0d32951, /webui WS proxy d037bd1) are all retained and unaffected by the OpenClaw bump.
- Verified against the full 2026.9.6 changelog: no changes to loopback Host-header validation (proxy_attribution), controlUi.basePath, Ollama provider, or gateway auth model. Only breaking change is TypeScript-only code cells (not used by this setup).
- Disk usage at release time: 84% (37GB free). Old full backups under /share/backups (42GB) are cleanup candidates for future headroom.

## [0.7.11.15.3] - 2026-09-25

### Fixed
- **Nabu Casa / external "Gateway nicht erreichbar" after reconnects (the real killer)**: The ControlUI stores the gateway URL in its normalized localStorage form as `.../webui` *without* a trailing slash. The HA Supervisor ingress WS bridge forwards that exact path to nginx after stripping the ingress prefix, but the config only had trailing-slash locations — so `/webui` fell through to an implicit 301 redirect to `/webui/`. WebSocket clients never follow redirects: the supervisor completed the client-side 101 and then silently dropped the tunneled socket. First panel loads (via `/webui/`) worked, but every reconnect after Nabu Casa idle disconnects (1006 every ~2min) used the stored slash-less URL and died at the redirect — leaving the ControlUI in the "Gateway nicht erreichbar" connect dialog with an `ha-panel-app.ts:339 Uncaught (in promise) 3` crash. New explicit `location = /webui` proxies directly to the gateway (WebSocket headers included) instead of redirecting. Verified live: GET `/webui` -> 200 (was 301), WS upgrade `/webui` -> 101, `/webui/` unchanged, panel load 200. Confirmed working end-to-end via Nabu Casa from the iOS Companion App after the fix. (d037bd1)

## [0.7.11.15.2] - 2026-09-24

### Fixed
- **Ingress ControlUI asset 404s (local + Nabu Casa)**: HA Supervisor sends `X-Ingress-Path` *without* the `/webui` panel suffix. The previous maps built asset and base-path prefixes directly from that value, so the ControlUI bundle resolved assets as `/api/hassio_ingress/<token>/assets/...` — after the supervisor strips the ingress prefix those requests hit the nginx catch-all 404. New `$ingress_path_norm` map strips any trailing `/webui` (also defends against the 2026-09-22 double-`/webui` variant) and rebuilds **all** prefixes as `norm + "/webui/..."`. Direct nginx access without an ingress path keeps relative `./assets/` URLs. (dbc00fe)
- **Nabu Casa "Gateway nicht erreichbar" connect dialog**: The injected ControlUI cleanup script only removed localStorage `gatewayUrl`/`bootRecord` entries pointing at `127.0.0.1:18789`. Browsers that had cached a gateway URL with the bare Nabu host and no ingress path (pre-fix era) kept trying `wss://<slug>.ui.nabu.casa/` instead of the ingress route, so no WebSocket attempt ever reached the gateway. The script now removes ANY `gatewayUrl`/`bootRecord` entry whose value does not contain the current ingress base path, forcing the ControlUI to re-derive the WebSocket URL from the injected `data-openclaw-control-ui-base-path` attribute on every load. (0d32951)

### Notes
- Both fixes are nginx `sub_filter`/map changes only; no OpenClaw version, add-on startup, or gateway changes.
- Server-side verified live: ControlUI HTML + script tags resolve under `/api/hassio_ingress/<token>/webui/`, WebSocket upgrade with Nabu origin returns `101 Switching Protocols` + `connect.challenge`.

## [0.7.11.15.1] - 2026-09-23

### Fixed
- **Ingress WebSocket through HA/Nabu Casa**: Force loopback `Host` header in nginx `/webui/` proxy so OpenClaw 2026.9.5 treats HA Ingress traffic as local loopback.
- **Ingress asset loading**: Add unauthenticated nginx locations under `/webui/` for static assets, themes, favicon, apple-touch-icon and manifest, so HA Supervisor can fetch them without the add-on bearer token.
- **Ingress asset paths**: Remove duplicate `/webui` suffix from X-Ingress-Path base path maps so ControlUI builds correct asset URLs under `/api/hassio_ingress/<token>/webui`.

### Notes
- Conservative fix release based on 0.7.11.15. Only nginx configuration changed; no OpenClaw version or add-on startup changes.

## [0.7.10.25] - 2026-09-05

## [0.7.11.11] - 2026-09-23

### Changed
- **Rollback**: Revert add-on code base to v0.7.11.3, which was the last release where HA Ingress (including Nabu Casa remote access) worked reliably.
- **OpenClaw**: Stay on `2026.9.4` as included in v0.7.11.3.

### Notes
- This release intentionally does **not** include the nginx/Ingress changes from v0.7.11.4–v0.7.11.10, because those releases broke the ControlUI WebSocket connection through Nabu Casa Ingress.
- The OpenAI-compatible `agentId` patch for 2026.9.4 remains in place.
- If you are already on v0.7.11.10 and seeing “Gateway not reachable” through Ingress, install this update and reload the add-on store in HA (`Settings → Add-ons → Add-on Store → ⋮ → Reload`).


### Changed
- **OpenClaw**: Update to `2026.9.1`.
- **Add-on schema**: Add `cron_skip_missed_jobs` (default `true`) and `blocked_hostnames` options for OpenClaw 2026.9.1 configuration controls.
- **run.sh**: Log detected OpenClaw version at startup for easier support diagnosis.

### Fixed
- **Ingress WebUI asset loading**: `nginx.conf.tpl` already forces uncompressed upstream HTML and rewrites ControlUI asset paths; kept compatible with 2026.9.1. Verify after upgrade.

### Notes
- OpenClaw 2026.9.1 introduces `cron.skipMissedJobs` and `blockedHostnames`. Back up `/config/clawd` before first start after update.


## [0.7.10.17] - 2026-09-04

### Fixed
- **Ingress WebUI assets with OpenClaw 2026.8.2**: OpenClaw 2026.8.2 ships the Control UI with `<base href="/">`, which caused all assets to resolve against the Home Assistant origin and return 404 inside the Ingress iframe. nginx now rewrites `<base href="/">` to the HA Ingress base path and strips `Accept-Encoding` from the upstream request so `sub_filter` can operate on uncompressed HTML.

## [0.7.10.2] - 2026-09-04

### Fixed
- **Ingress WebUI with HTTPS gateway**: nginx now proxies `/webui/` to `https://127.0.0.1:18789/` when the gateway runs in `lan_https` / TLS mode, accepting the auto-generated self-signed certificate. Previously Ingress broke when `network_mode` was switched from `ingress_only` to `lan_https`.
- **TUI startup**: `openclaw tui` now starts with `--session agent:coding-main:main` for OpenClaw 2026.8.2 multi-agent requirement (0.7.10.1).
- **Ingress base-path injection**: nginx `sub_filter` now injects the HA Ingress base path for both `data-openclaw-terminal-enabled="false"` and `"true"` (0.7.10.1).

## [0.7.10.1] - 2026-09-04

### Fixed
- **TUI startup**: `openclaw tui` now starts with `--session agent:coding-main:main` to satisfy OpenClaw 2026.8.2 multi-agent requirement.
- **Ingress WebUI**: nginx `sub_filter` now injects the HA Ingress base path for both `data-openclaw-terminal-enabled="false"` and `"true"`, fixing WebUI inside HA Ingress.

## [0.7.9.28] - 2026-09-03

### Fixed
- **Homebrew install**: Robustified Homebrew installation path for Node 24 / OpenClaw 2026.8.2.

## [0.7.9.27] - 2026-09-02

### Changed
- **OpenClaw**: Update to `2026.8.2`.
- **Node.js**: Update from NodeSource `node_22.x` to `node_24.x`.
- **mcporter**: Add global install `mcporter@0.12.3` for MCP server auto-configuration.
- **node-llama-cpp**: Keep at `3.20.0` as requested.

### Notes
- This release follows the upstream 2026.8.x line. The 2026.8.x OpenClaw release migrates sessions/transcripts to SQLite; a full `/config` backup is required before first start after update.

## [0.7.9.26] - 2026-08-23

### Changed
- **Landing Page Titlebar Redesign**: Home Assistant Material Design 3 Stil mit korrigierten Farben. Alte Titlebar-Struktur mit Tabs oben beibehalten.
- **UX**: HTTPS/Secure-Context-Warnbanner im Ingress entfernt.

### Fixed
- **Tab-Visibility**: Tabs werden korrekt basierend auf Add-on-Konfiguration und iframe-Kontext ein-/ausgeblendet.

## [0.7.9.24] - 2026-08-23

### Changed
- **Landing Page Redesign**: Home Assistant Material Design 3 Stil mit Cards, Chips und Kachel-Navigation.
- **Sicherheit**: `__GATEWAY_TOKEN__` wird in `render_nginx.py` mit `html.escape()` escaped.
- **Features wiederhergestellt**: CA-Cert-Download (nur `lan_https`) und Disk-Usage-Anzeige im Footer.

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


## [0.7.10.29] - 2026-09-12

### Changed
- **OpenClaw**: Update to `2026.9.4`.
- **Add-on version**: Bump to `0.7.10.29`; Dockerfile and metadata aligned.

### Notes
- OpenClaw 2026.9.4 introduces safer rollback for compatible failed updates. Database migrations still require a verified pre-update backup; back up `/config/clawd` before first start after update.
- No new add-on schema options in this release.

## [0.7.10.28] - 2026-09-08

### Changed
- **OpenClaw**: Update to `2026.9.3`.
- **Node.js**: NodeSource `node_24.x` channel provides Node 24.20.0, satisfying the OpenClaw 2026.9.3 minimum requirement (Node 24.16.0+ on 24.x).

### Fixed
- **Release build correctness**: Previous 0.7.10.26/27 releases bumped the add-on version while the Dockerfile still installed OpenClaw 2026.9.1/2026.9.2. This release aligns add-on version, Dockerfile, and installed OpenClaw version.

### Notes
- OpenClaw 2026.9.3 requires Node 24.16.0+ or Node 26.1.0+. The add-on continues to use the NodeSource 24.x LTS channel.
- OpenClaw 2026.9.3 introduces breaking SDK changes for plugin authors (execution-policy SDK, approval SDK, SDK aliases, search/directory callbacks) and agent-owned Workshop skills. These do not affect the add-on image itself but may affect custom plugins/skills you develop.
- Back up `/config/clawd` before first start after update.

## [0.7.10.27] - 2026-09-08

### Fixed
- **Dockerfile alignment**: Actually install `openclaw@2026.9.2` (the 0.7.10.26 release only updated `config.yaml` version metadata). Bumped add-on version to 0.7.10.27 so Home Assistant rebuilds the image.

## [0.7.10.26] - 2026-09-08

### Changed
- **OpenClaw**: Intended update to `2026.9.2`.

### Notes
- This release did not update the Dockerfile install line, so the built image still contained OpenClaw 2026.9.1. Superseded by 0.7.10.27 and 0.7.10.28.
- Compatibility note: preserves active settings, enabled skills, and default-agent ownership across Gateway restarts triggered by HA add-on updates.

## 0.7.10.30
- fix(ingress): inject OpenClaw ControlUI base path on <html> tag for 2026.9.4.
  OpenClaw 2026.9.4 no longer ships the empty `data-openclaw-control-ui-base-path` attribute,
  so nginx now adds it explicitly when missing. This fixes "Gateway not reachable 127.0.0.1:18789"
  when loading the dashboard through the HA Ingress iframe.

## 0.7.10.31
- fix(ingress): inject a client-side base-path fallback for OpenClaw 2026.9.4
  when HA Supervisor does not pass X-Ingress-Path (e.g. Companion App iframe).
  The ControlUI now reads `data-openclaw-control-ui-base-path` from the actual
  browser URL instead of falling back to `127.0.0.1:18789`.
