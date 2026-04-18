# Changelog — OpenClaw Assistant (Dev)

## [0.7.5.1] - 2026-04-18
- **FIX:** D-Bus system bus wird jetzt vor Avahi gestartet (Container haben kein systemd, daher muss `run.sh` D-Bus explizit starten — ohne D-Bus stirbt Avahi stillschweigend)
- **FIX:** `allowedOrigins` wird dynamisch um `${mdns_host_name}.local` erweitert, wenn `mdns_host_name` konfiguriert ist (löst "origin not allowed" beim Zugriff über mDNS-Namen)
- **FIX:** TLS-SANs werden dynamisch um `DNS:${mdns_host_name}.local` erweitert (verhindert Zertifikatswarnungen im Browser)
- **FIX:** mDNS annonciert im HTTPS-Modus jetzt korrekt `GATEWAY_PORT` (18789) statt `NGINX_PORT` (48099 Ingress-Port)
- **FIX:** Tippfehler `avaihi-daemon` → `avahi-daemon` in Warnmeldung

## [0.7.5] - 2026-04-17
- **FIX:** jq-Falsy-Falle — alle `// true`/`// false` durch Null-Checks ersetzt (verhindert, dass leere Strings als `true` interpretiert werden)
- **FIX:** `CONTROLUI_DISABLE_DEVICE_AUTH=true` im `lan_https`-Case entfernt (trustedProxies reicht aus)
- **FIX:** `controlui_disable_device_auth` Default auf `false` korrigiert (war `true`)
- **FIX:** Dockerfile aufgeräumt (doppelte ENV, leerer apt-run, doppelter npm cache clean)
- **FIX:** `ensure-plugins` in `oc_config_helper.py` sichert `plugins.entries.ollama`
- **UPGRADE:** OpenClaw 2026.4.14 → 2026.4.15
- **CLEANUP:** `build.yaml` entfernt (HA-Supervisor-obsolet), Backup-Dateien und `__pycache__` entfernt, `.gitignore` erweitert

## [0.7.1.0] - 2026-04-14
- **Operation Chromium-Konsolidierung:** Nur noch ein Chromium (Playwright) im Image, System-Chromium entfernt. Symlink `/usr/bin/chromium-browser` → Playwright-Binary.
- **FIX:** Log-Routing korrigiert — Console-Output wiederhergestellt, Trace-Logs in Datei

## [0.7.0] - 2026-04-13
- **REWRITE:** Best-of-All-Worlds — Trixie Full-Stack + coollabsio Persistence + techartdev HA-Integration
- **FEAT:** mDNS-Konfigurationsoptionen für LAN-Discovery
- **FEAT:** Runtime apt packages (coollabsio Pattern)
- **FEAT:** Custom init script (coollabsio Pattern)
- **FEAT:** Log Rotation (Dateien > 10MB rotieren)
- **FEAT:** Exponential Backoff bei Gateway-Restarts

## [0.6.1.13] - 2026-04-13
- **FIX:** tmpfs-Größen für 8GB RAM reduziert (verhindert WASM OOM)
- **FIX:** Virtual Memory Limit entfernt (`ulimit -v` war zu restriktiv für WASM)
- **FIX:** `--experimental-wasm-max-mem-pages=65536` zu NODE_OPTIONS

## [0.6.1.7] - 2026-04-13
- **FIX:** tmpfs-Mounts deaktiviert (CAP_SYS_ADMIN fehlt in HA-Containern)

## [0.6.0.9] - 2026-04-11
- **FIX:** Dockerfile CMD auf `/run.sh` geändert (systemd-Startup-Loop)
- **FIX:** Fehlende Pakete nachgetragen (nginx, jq, openssl, pnpm, ttyd)
- **FIX:** mDNS-Variablenlogik validiert

## [0.6.x] - 2026-04 (frühe Versionen)
- Node.js 20 musl → Node 22 Upgrade
- Gateway bind/port/token konfigurierbar
- Telegram-Allowlist-Support
- libstdc++/Node-Kompatibilitätsfixes für Alpine musl
- Erstes HA Add-on-Skeleton (basierend auf Papur Add-ons)