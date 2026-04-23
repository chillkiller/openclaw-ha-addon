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
