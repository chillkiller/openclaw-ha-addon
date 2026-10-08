## [0.7.5.2] - 2026-04-23
- **FIX:** GATEWAY_PORT vor TERMINAL_PORT-Validierung verschoben (Crash "unbound variable")
- **FIX:** MDNS_SERVICE_PORT jq-Interpolation durch bash-Default ersetzt (fragil → robust)
- **FIX:** LAN_IP was defined twice → split into CERT_LAN_IP (TLS) and MDNS_LAN_IP (mDNS)
- **FIX:** added the missing closing `>` to the D-Bus config XML DOCTYPE (Avahi mode was broken)
- **FIX:** Dockerfile Paket `dbus-daemon` → `dbus` (Debian Trixie)
- **FIX:** build.yaml removed (obsolete for local HA apps)
- **ADD:** trace_log_to_console in config.yaml options/schema aufgenommen
- **ADD:** gateway_log_level Option (off|info|debug) mit LOG_LEVEL-Mapping
- **ADD:** avahi option in all 6 translation files
- **ADD:** mdns_host_name Default "openclaw-ha-addon" statt leer (kryptischer Container-Name)

## [0.7.5.1] - 2026-04-19
- **FIX:** gateway Bonjour/mDNS disabled — always set OPENCLAW_DISABLE_BONJOUR=1 and write discovery.mdns.mode=off
- **FIX:** D-Bus system bus starts before Avahi
- **FIX:** TLS-SANs um mDNS-Hostname erweitert
- **FIX:** allowedOrigins um mDNS-Hostname erweitert
- **FIX:** mDNS advertised korrekten GATEWAY_PORT
- **FIX:** hostname and /etc/hostname override removed
- **UPGRADE:** OpenClaw 2026.4.14 → 2026.4.15

## [0.7.5] - 2026-04-17
- **CRITICAL FIX:** jq-Falsy-Falle – Alle `// true`/`// false` durch Null-Checks ersetzt
- **FIX:** removed CONTROLUI_DISABLE_DEVICE_AUTH=true from the lan_https case
- **FIX:** controlui_disable_device_auth Default auf false
- **FIX:** Dockerfile cleaned up
- **FIX:** ensure-plugins in oc_config_helper.py sichert plugins.entries.ollama
- **UPGRADE:** OpenClaw 2026.4.14 → 2026.4.15
