# OpenClaw HA App Deployment

## Version Matrix

| App Version | OpenClaw Version | Release Date |
|--------------|------------------|---------------|
| 0.7.13.8 | 2026.9.9 | 2026-10-10 |
> **Note (0.7.13.8):** the helper's plugin registration respects an explicit operator opt-out: with `plugins.entries["acp-dashboard-binding"].enabled=false`, the flag is never flipped back across boots, the plugin payload stays deployed (re-enable needs no rebuild), and no `plugins.load.paths` entry is written while disabled.
| 0.7.13.7 | 2026.9.9 | 2026-10-10 |
| 0.7.13.6 | 2026.9.9 | 2026-10-10 |
| 0.7.13.5 | 2026.9.9 | 2026-10-10 |
| 0.7.13.4 | 2026.9.9 | 2026-10-10 |

| 0.7.13.3 | 2026.9.9 | 2026-10-09 |
| 0.7.13.2 | 2026.9.9 | 2026-10-09 |
| 0.7.13.1 | 2026.9.9 | 2026-10-09 |
| 0.7.13 | 2026.9.9 | 2026-10-09 |
| 0.7.12.7 | 2026.9.8 | 2026-10-08 |
| 0.7.12.6 | 2026.9.8 | 2026-10-07 |
| 0.7.12.5 | 2026.9.8 | 2026-10-05 |
| 0.7.12.4 | 2026.9.8 | 2026-10-03 |
| 0.7.12.3 | 2026.9.6 | 2026-09-26 |
| 0.7.12.2 | 2026.9.6 | 2026-09-26 |
| 0.7.12.1 | 2026.9.6 | 2026-09-25 |
| 0.7.12.0 | 2026.9.6 | 2026-09-25 |
| 0.7.11.15.3 | 2026.9.5 | 2026-09-25 |
| 0.7.11.15.2 | 2026.9.5 | 2026-09-24 |
| 0.7.11.3 | 2026.9.4 | 2026-09-19 |
| 0.7.10.2 | 2026.8.2 | 2026-09-04 |
| 0.7.10.1 | 2026.8.2 | 2026-09-04 |
| 0.7.9.28 | 2026.8.2 | 2026-09-03 |
| 0.7.9.11 | 2026.7.1 | 2026-08-23 |
| 0.7.5.3 | 2026.4.21 | 2026-04-24 |
| 0.7.5.2 | 2026.4.21 | 2026-04-23 |
| 0.7.5.1 | 2026.4.15 | 2026-04-20 |

## RAM Configuration

The Node.js heap is **RAM-adaptive** since v0.7.12.4 (`--max-old-space-size` set from host RAM in `run.sh`):

| System RAM | Heap |
|---|---|
| ≥ 24 GB | 8192 MB |
| ≥ 12 GB | 6144 MB |
| ≥ 8 GB | 4096 MB |
| < 8 GB | 2048 MB |

- **8 GB+ system RAM**: works with defaults
- **Less than 8 GB**: the app already selects a 2048 MB heap automatically; reduce further only for special cases — e.g. `docker exec` into the container or use the app terminal to set `NODE_OPTIONS=--max-old-space-size=2048` for testing, and for persistence use the `gateway_env_vars` mechanism with care (Node options are reserved keys; the supported path is editing `run.sh` for custom builds)

## Port Safety

- Gateway port defaults to `18789` (configurable via `gateway_port`, range 1–65535; the internal gateway loopback port is derived at runtime)
- Ingress proxy: fixed port `49200` (`ingress_port` in `config.yaml`)
- Web terminal: configurable, default `7681`

## Image Size

Measured on the released aarch64 build (v0.7.12.1):

- **Unique image size: ~1.8 GB** (layers not shared with the HA base image)
- **Total size on disk: ~7.3 GB** (uncompressed, including layers shared with the Home Assistant base image and other apps)

Main contributors: OpenClaw runtime + npm packages, Playwright Chromium, Python tooling (`node-llama-cpp`, crawl4ai basis), Homebrew (installed under `/config`, persisted outside the image), CUPS/scanner stack.

> Plan disk space for the uncompressed image plus HA backups. On a Raspberry Pi booting from SD card, an SSD is strongly recommended.
