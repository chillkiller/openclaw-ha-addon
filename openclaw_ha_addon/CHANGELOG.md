## [0.7.10.25] - 2026-09-05

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

