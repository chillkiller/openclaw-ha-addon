## [0.7.7.0] - 2026-06-16
- **UPGRADE:** OpenClaw 2026.6.1 → 2026.6.8 (Security-Härtung, Telegram Rich-Text, Memory-Fixes, GLM-5.2, Haiku 4.5)
- **FIX:** Go-PATH-Konflikt — golang-go (apt 1.19.8) wird nach Go 1.24.1 Binary gepurged
- **FIX:** D-Bus + Avahi Startup in run.sh — dbus-daemon wird vor Gateway gestartet, mDNS funktioniert jetzt
- **ADD:** CUPS-Stack (cups, cups-client, cups-daemon, cups-filters, cups-ipp-utils, cups-browsed) für AirPrint/IPP-Druck
- **ADD:** Scanner-Stack (sane-airscan, sane-utils) für eSCL/AirScan/WSD
- **ADD:** crawl4ai Basis im Image (uv pip install, ohne torch/transformers) — shared Playwright Chromium
- **ADD:** Browser-Config Bootstrap (headless, noSandbox, extraArgs) via oc_config_helper.py
- **ADD:** memory-core Dreaming enabled via oc_config_helper.py

## [0.7.6.1] - 2026-06-06
- **UPGRADE:** OpenClaw 2026.4.26 → 2026.6.1
- **FIX:** Go 1.19 (golang-go apt) → Go 1.24.1 (official binary)
- **FIX:** Node.js memory limits (--max-old-space-size=4096)
- **FIX:** Debian Trixie (testing) → Bookworm (stable) — APT dependency stability
- **ADD:** Embeddings configuration guide (DOCS.md)
- **ADD:** Local embeddings via node-llama-cpp@3.18.1 bundled in image

## [0.7.6.0] - 2026-04-24
- **UPGRADE:** OpenClaw 2026.4.21 → 2026.4.22 (fixes compaction/streaming issues)
- **FIX:** D-Bus "Scorched Earth" start sequence (killall, clean dirs, fresh socket)
- **FIX:** Skills sync now uses COPY instead of symlink (Jiti loader compatibility)
- **ADD:** ENV OPENCLAW_CHILD_OOM_SCORE_ADJ=0 (OOM shim disabled for Trixie stability)

## [0.7.5.2] - 2026-04-23
- **FIX:** GATEWAY_PORT vor TERMINAL_PORT-Validierung verschoben (Crash "unbound variable")
- **FIX:** MDNS_SERVICE_PORT jq-Interpolation durch bash-Default ersetzt (fragil → robust)
- **FIX:** LAN_IP doppelt definiert → aufgeteilt in CERT_LAN_IP (TLS) und MDNS_LAN_IP (mDNS)
- **FIX:** D-Bus Config XML DOCTYPE schließendes `>` hinzugefügt (Avahi-Mode kaputt)
- **FIX:** Dockerfile Paket `dbus-daemon` → `dbus` (Debian Trixie)
- **FIX:** build.yaml gelöscht (obsolet für HA lokale Addons)
- **ADD:** trace_log_to_console in config.yaml options/schema aufgenommen
- **ADD:** gateway_log_level Option (off|info|debug) mit LOG_LEVEL-Mapping
- **ADD:** avahi-Option in allen 6 Übersetzungsdateien
- **ADD:** mdns_host_name Default "openclaw-ha-addon" statt leer (kryptischer Container-Name)

## [0.7.5.1] - 2026-04-19
- **FIX:** Gateway-Bonjour/mDNS abgeschaltet — OPENCLAW_DISABLE_BONJOUR=1 immer setzen und discovery.mdns.mode=off schreiben
- **FIX:** D-Bus system bus wird vor Avahi gestartet
- **FIX:** TLS-SANs um mDNS-Hostname erweitert
- **FIX:** allowedOrigins um mDNS-Hostname erweitert
- **FIX:** mDNS advertised korrekten GATEWAY_PORT
- **FIX:** hostname und /etc/hostname-Override entfernt
- **UPGRADE:** OpenClaw 2026.4.14 → 2026.4.15

## [0.7.5] - 2026-04-17
- **CRITICAL FIX:** jq-Falsy-Falle – Alle `// true`/`// false` durch Null-Checks ersetzt
- **FIX:** CONTROLUI_DISABLE_DEVICE_AUTH=true im lan_https-Case entfernt
- **FIX:** controlui_disable_device_auth Default auf false
- **FIX:** Dockerfile aufgeräumt
- **FIX:** ensure-plugins in oc_config_helper.py sichert plugins.entries.ollama
- **UPGRADE:** OpenClaw 2026.4.14 → 2026.4.15
