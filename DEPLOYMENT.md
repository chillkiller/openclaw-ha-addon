# OpenClaw HA Addon Deployment

## Version Matrix

| Addon Version | OpenClaw Version | Release Date |
|--------------|------------------|---------------|
| 0.7.7.4   | 2026.6.8 | 2026-06-26 |
| 0.7.7.3   | 2026.6.8 | 2026-06-26 |
| 0.7.7.2   | 2026.6.8 | 2026-06-26 |
| 0.7.7.0   | 2026.6.8 | 2026-06-16 |
| 0.7.6.1   | 2026.6.1 | 2026-06-06 |
| 0.7.6.0   | 2026.4.22 | 2026-04-24 |

## RAM Configuration

The addon uses a fixed 4GB Node.js heap (`--max-old-space-size=4096`) for robust operation on systems with 8GB+ RAM. For systems with less than 8GB, reduce to 2048 in the add-on configuration.

## Port Safety

- Gateway port defaults to `18789`
- Valid port range: 1024-65534
- Ingress proxy: fixed port `48099`
- Web terminal: configurable, default `7681`

## Image Size

| Component | Approx. Size |
|---|---|
| Core apt + runtimes (after build dep purge) | ~300 MB |
| Playwright Chromium | ~956 MB |
| OpenClaw + npm packages | ~300 MB |
| Homebrew (persistent) | ~3.2 GB |
| crawl4ai (Basis) | ~200 MB |
| CUPS + Scanner | ~55 MB |
| **Total Image** | **~1.7 GB** |
