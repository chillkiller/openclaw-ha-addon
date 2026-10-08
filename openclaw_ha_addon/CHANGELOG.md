## [0.7.5.1] - 2026-04-19
- **FIX:** gateway Bonjour/mDNS disabled — always set `OPENCLAW_DISABLE_BONJOUR=1` and write `discovery.mdns.mode="off"` in openclaw.json (prevents an endless loop in the container)
- **FIX:** D-Bus system bus starts before Avahi (containers have no systemd)
- **FIX:** TLS-SANs um mDNS-Hostname erweitert (`DNS:${mdns_host_name}.local`)
- **FIX:** allowedOrigins um mDNS-Hostname erweitert
- **FIX:** mDNS advertised korrekten GATEWAY_PORT (nicht NGINX_PORT/Ingress)
- **FIX:** removed the `hostname` and `/etc/hostname` override (it broke HA supervisor healthchecks)
- **FIX:** `cleanup_stale_config_keys()` entfernt nur noch uppercase `mDNS`, nicht lowercase `mdns`
- **UPGRADE:** OpenClaw 2026.4.14 → 2026.4.15

## [0.7.5] - 2026-04-17
- **CRITICAL FIX:** jq-Falsy-Falle – Alle `// true`/`// false` durch Null-Checks ersetzt
- **FIX:** `CONTROLUI_DISABLE_DEVICE_AUTH=true` im `lan_https`-Case entfernt (trustedProxies reicht)
- **FIX:** `controlui_disable_device_auth` Default auf `false` (war `true`)
- **FIX:** Dockerfile aufgeräumt (doppelte ENV, leerer apt-run, doppelter npm cache clean)
- **FIX:** `ensure-plugins` in oc_config_helper.py sichert `plugins.entries.ollama`
- **FIX:** `build.yaml` entfernt (HA-supervisor-obsolet)
- Repo aufgeräumt: Backup-Dateien, __pycache__ entfernt, .gitignore erweitert

## [0.6.1.13] - 2026-04-13
- Version bump to trigger Home Assistant update (HA ignores versions <= 0.6.1.12)
- Fix run.sh: Reduced tmpfs sizes for 8GB RAM system to prevent WASM OOM
- Fix run.sh: Lowered virtual memory limit ulimit -v from 8GB to 4GB
- Fix run.sh: Added --experimental-wasm-max-mem-pages=65536 to NODE_OPTIONS

## [0.6.1.7] - 2026-04-13
- Disabled tmpfs mounts (CAP_SYS_ADMIN missing in HA containers)

## [0.6.0.9] - 2026-04-11
- Fix Dockerfile: Changed CMD to /run.sh to resolve systemd startup loop
- Fix Dockerfile: Added missing essential packages (nginx, jq, openssl, pnpm, ttyd)
- Fix run.sh: Validated mDNS variable logic
