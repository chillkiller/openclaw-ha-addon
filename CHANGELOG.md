
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

