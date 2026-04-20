# OpenClaw HA Addon Deployment

## Version Matrix

| Addon Version | OpenClaw Version | Release Date |
|--------------|------------------|---------------|
| 0.6.0.9      | 2026.4.10      | 2026-04-12   |

## RAM Modes

The addon automatically detects available RAM and selects the appropriate mode:

### Power Mode (>8GB RAM)
- **Heap:** 6GB (`--max-old-space-size=6144`)
- **tmpfs mounts:**
  - npm_cache: 2GB
  - node_tmp: 2GB
  - chromium_cache: 2GB
  - logs: 2GB
- **Total tmpfs:** 8GB
- Use case: High-performance workstations, desktop PCs

### Safe Mode (≤8GB RAM)
- **Heap:** 2GB (`--max-old-space-size=2048`)
- **tmpfs mounts:**
  - npm_cache: 256MB
  - node_tmp: 384MB
  - chromium_cache: 512MB
  - logs: 256MB
- **Total tmpfs:** ~1.4GB
- Use case: Raspberry Pi, low-memory hosts, containers

## Port Safety

- Gateway port defaults to `18789`
- If configured port ≥65535, fallback to port-1 (e.g., 65535 → 65534)
- Valid port range: 1024-65534