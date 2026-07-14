# Changelog

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