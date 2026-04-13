## [0.6.1.13] - 2026-04-13
- Version bump to trigger Home Assistant update (HA ignores versions <= 0.6.1.12)
- Fix run.sh: Reduced tmpfs sizes for 8GB RAM system to prevent WASM OOM (npm_cache 512M, node_tmp 256M, chromium_cache 256M, logs 128M in power mode; 256M/128M/128M/64M in safe mode).
- Fix run.sh: Lowered virtual memory limit ulimit -v from 8GB to 4GB.
- Fix run.sh: Added --experimental-wasm-max-mem-pages=65536 to NODE_OPTIONS to stabilize undici/llhttp Wasm instance.

## [0.6.1.5] - 2026-04-13

## [0.6.0.9] - 2026-04-11
- Fix Dockerfile: Changed CMD to /run.sh to resolve systemd startup loop.
- Fix Dockerfile: Added missing essential packages (nginx, jq, openssl, pnpm, ttyd) and infrastructure files (COPY/chmod).
- Fix run.sh: Validated mDNS variable logic.
