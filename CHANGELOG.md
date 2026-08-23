## [0.7.9.22] - 2026-08-23

### Fixed
- **Ingress Gateway health sensor was misleading.** `/api/health` returned a static nginx-only 200 OK, so the titlebar badge showed "Gateway OK" even when the OpenClaw Gateway process was down. The location now proxies to the actual gateway `/health` endpoint (`{"ok":true,"status":"live"}`) and the landing, TUI, and docs pages parse the JSON response and check `data.ok`.
- **TUI/docs health status wording updated** from "reachable (nginx health)" to "reachable (gateway live)" to reflect the real check.

# Changelog

## [0.7.9.21] - 2026-08-23

### Fixed
- **Codex ACPX wrapper auth.json with Ollama fallback.** The wrapper now resolves provider environment before deciding whether to write `codex-home/auth.json`, so the Ollama placeholder `OPENAI_API_KEY` is visible and Codex no longer exits with `Authentication required` when no real OpenAI key is configured.

## [0.7.9.20] - 2026-08-23

### Fixed
- **ACPX/Codex harnesses failed to load on OpenClaw 2026.7.1-2.** `run.sh` now strips the `OpenClaw ` prefix and parenthesized build suffix from `OPENCLAW_VERSION` so the plugin API compatibility check receives a valid semver string.

## [0.7.9.4] - 2026-08-13

### Added
- **TUI iframe terminal**: The TUI tab now uses a dedicated `ttyd` instance that runs `openclaw tui` directly, instead of showing a static placeholder page.
- Add `tui_port` option (default 7682) to configure the TUI ttyd listener.

### Changed
- `run.sh` starts a second `ttyd` process for TUI when `enable_tui: true`.
- `nginx.conf.tpl` proxies `/tui/` to the TUI ttyd port and preserves the `/tui/` base path.
- `render_nginx.py` substitutes the new `__TUI_PORT__` placeholder.

## [0.7.9.3] - 2026-08-13

### Added
- **Ingress iframe auto-login**: Control UI WebUI tab now appends the gateway token as a URL fragment (`#token=...`) so the user no longer has to paste the token manually.
- **Ingress iframe CSP override**: nginx now strips OpenClaw Control UI's restrictive `X-Frame-Options: DENY` / `frame-ancestors 'none'` headers and replaces them with iframe-friendly `SAMEORIGIN` / `frame-ancestors 'self'` when proxying `/webui/`.
- **Ingress terminal fix**: nginx `/terminal/` proxy now preserves the `/terminal/` base path that `ttyd` expects (`ttyd -b /terminal`), so the terminal iframe loads instead of showing a black screen.
- **HTTP Ingress origins allowed**: `gateway.controlUi.allowedOrigins` now includes `http://<ha-host>:8123` and local HA hostnames so the Control UI accepts the Home Assistant Ingress iframe origin.

### Changed
- Hide the "OpenClaw WebUI requires HTTPS/secure context" banner when running inside the HA Ingress iframe.

## [0.7.9.2] - 2026-08-13

### Changed
- **OpenClaw 2026.7.1 → 2026.7.1-2** — latest stable patch release
- **node-llama-cpp 3.19.0 → 3.20.0** — latest stable release

## [0.7.9.1] - 2026-08-13

### Added
- **Ingress-UI Refactor**: Tab-basierte Landing Page mit WebUI, Terminal, TUI und Docs.
- **Statische Ingress-Assets**: `tui/index.html`, `docs/index.html`, `loading.html`, `icon.png` und `logo.png` werden jetzt ins Docker-Image kopiert und zur Laufzeit nach `/etc/nginx/html/` synchronisiert.

### Fixed
- **ControlUI im Ingress iframe**: Der WebUI-Tab wird jetzt immer innerhalb des HA-Ingress-iframes angezeigt, auch wenn der Browser-Kontext nicht als `secure context` gilt. Externer Link erscheint nur noch außerhalb des Ingress.
- **TUI-Verzeichnis**: `run.sh` erzeugt jetzt `/etc/nginx/html/tui` vor dem Kopieren der TUI-Datei.
- **HEALTHCHECK-Port**: Auf `http://localhost:49200/api/health` korrigiert, um mit `ingress_port: 49200` in `config.yaml` übereinzustimmen.
- **Repository-Metadaten**: `repository.yaml` auf `ingress_port: 49200` und Version `0.7.9.1` aktualisiert.

## [0.7.8.0] - 2026-07-14

### Upgraded
- **OpenClaw 2026.6.11 → 2026.7.1** — siehe https://github.com/openclaw/openclaw/releases/tag/v2026.7.1
- Node-llama-cpp bleibt bei 3.19.0 (keine Änderung)

### Notes
- Add-on-Version synchronisiert: `0.7.8.0` (config.yaml, repository.yaml, Dockerfile)

## [0.7.7.7] - 2026-07-08

### Fixed
- **Regression in v0.7.7.6:** D-Bus/Avahi startup used `$!` without placing the daemon in the background, causing `/run.sh: line 1054: $!: unbound variable` and crash loop. D-Bus and Avahi are now started with `&` so `$!` is defined.

## [0.7.7.6] - 2026-07-08

### Fixed
- **D-Bus / Avahi startup crash after Homebrew skill installs**
  - Pin `dbus-daemon` and `avahi-daemon` to Debian system paths (`/usr/bin`, `/usr/sbin`) to avoid Homebrew binaries shadowing them via PATH.
  - Remove stale PID files (`/run/dbus/pid`, `/var/run/dbus/pid`, `/run/avahi-daemon/pid`, `/var/run/avahi-daemon/pid`) before starting, so unclean container restarts do not deadlock D-Bus.
  - Track and gracefully stop D-Bus and Avahi in the shutdown trap, reducing stale state on restart.

## [0.7.7.5] - 2026-07-03

### Changed
- Bumped OpenClaw to **2026.6.11** (latest stable)
- Bumped `node-llama-cpp` to **3.19.0** (latest stable)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.7.4] - 2026-06-26

### Changed
- Removed automatic `browser` and `memory-core` configuration from `oc_config_helper.py`
- Users now configure both sections manually in `openclaw.json`

## [0.7.7.3] - 2026-06-26

### Fixed
- `browser.actionTimeoutMs` corrected to `browser.timeoutMs` in `oc_config_helper.py`
- Remove broken auto-generated `memory-core.config.dreaming.enabled` entry instead of re-injecting it

### Changed
- `memory-core` is no longer auto-configured; users enable it manually in `openclaw.json`

## [0.7.7.2] - 2026-06-26

### Fixed
- Build dependencies (`build-essential`, `cmake`, `python3-dev`) are now kept in the final image so runtime native module builds do not fail
- `node-llama-cpp` is fully compiled during the Docker image build; the native binary is baked into the image
- Limit `node-llama-cpp` compilation to 2 parallel threads (`NLC_BUILD_PARALLEL=2`) to reduce CPU spikes on Raspberry Pi 5

### Removed
- Dropped obsolete `AUDIT-REPORT-v0.7.7.*.md` files from the repository

## [0.7.6.1] - 2026-06-06

### Fixed
- **Go Runtime:** Replaced outdated `golang-go` apt package (Go 1.19, Bookworm) with
  official Go 1.24.1 binary download, following the same pattern as Bun/uv
- Go 1.19 from Debian Bookworm is EOL, lacks security support, and fails to build
  modern Go modules — now resolved by downloading the latest Go binary directly

## [0.7.6.0] - 2026-06-03

### Fixed
- **Critical Base Image Issue:**
  - Switched from Debian Trixie (Testing) to Debian Bookworm (Stable)
  - Resolves APT dependency failures during Docker build (libsoup-3.0-0, avahi-daemon, dbus)
  - Trixie repositories were unstable causing repeated build failures

- **Node.js Memory Limits:**
  - Added `--max-old-space-size=4096` to prevent OOM crashes in containerized environments
  - Without explicit limits, Node.js tries to use all RAM and hits HA's cgroup limits
  - Set to 4GB by default; preserves existing NODE_OPTIONS when present

### Changed
- Updated base image for all stages: `debian:bookworm-slim` (stable, production-ready)
- Version bump to reflect breaking change in base image
- All OpenClaw skills, plugins, and services remain fully supported on Bookworm

### Security
- Stable base image reduces risk of unexpected package updates
- Predictable dependency tree for security audits

## [0.7.5.3] - 2026-04-24

### Fixed
- **D-Bus & Avahi mDNS Fixes:**
  - Fixed silent crashes by implementing a production-safe system.conf
  - Implemented dynamic mDNS service advertisement with automatic port extraction from GW_PUBLIC_URL
  - Added XML-escaping for service names to prevent discovery bugs
  - Resolved 'unbound variable' risks in the run.sh Avahi section

### Changed
- Updated mDNS service advertisement to dynamically extract port from GW_PUBLIC_URL
- Enhanced Avahi integration with proper XML escaping for service names

## [0.7.5.2] - 2026-04-22

### Fixed
- **Stability Fixes:**
  - Log rotation improvements
  - RAM management optimizations
  - mDNS/Avahi integration fixes
  - Session-lock cleanup on startup/exit

## [0.7.5.1] - 2026-04-20

### Added
- Initial production release of the independent repository
- Complete OpenClaw Home Assistant Add-on implementation