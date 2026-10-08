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
- **UX**: removed the HTTPS/secure-context warning banner inside the ingress.

### Fixed
- **Tab visibility**: tabs are shown/hidden correctly based on app configuration and iframe context.

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

