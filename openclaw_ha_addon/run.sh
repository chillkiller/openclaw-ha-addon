#!/usr/bin/env bashio
set -euo pipefail

# ==============================================================================
# OpenClaw Home Assistant Addon run.sh (v0.9.0-IndustryStandard)
# Architecture: bashio-driven & Tini-managed
# 
# Design Principles:
# 1. Use bashio for official HA logging and configuration.
# 2. Tini (PID 1) handles signal propagation and zombie reaping.
# 3. Fail-Fast initialization of network services.
# 4. Foreground execution via 'exec' for Supervisor-driven lifecycle.
# ==============================================================================

# ------------------------------------------------------------------------------
# Section 0: Environment & Paths
# ------------------------------------------------------------------------------
export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"
export LD_LIBRARY_PATH="/home/linuxbrew/.linuxbrew/lib:${LD_LIBRARY_PATH:-}"
export PYTHONPATH="/config/.local/lib/python3.11/site-packages:${PYTHONPATH:-}"
export HOME=/config
export OPENCLAW_CONFIG_DIR=/config/.openclaw
export OPENCLAW_WORKSPACE_DIR=/config/clawd
export XDG_CONFIG_HOME=/config

# Playwright Browser Persistence
if [ -d /opt/ms-playwright ] && [ ! -e /config/.cache/ms-playwright ]; then
  mkdir -p /config/.cache
  ln -sf /opt/ms-playwright /config/.cache/ms-playwright
fi
export PLAYWRIGHT_BROWSERS_PATH=/config/.cache/ms-playwright

# ------------------------------------------------------------------------------
# Section 1: Configuration (via bashio)
# ------------------------------------------------------------------------------
# bashio handles the reading of /data/options.json internally.
TZNAME=$(bashio::config.get "timezone" "Europe/Berlin")
export TZ="$TZNAME"

GATEWAY_MODE=$(bashio::config.get "gateway_mode" "local")
GATEWAY_PORT=$(bashio::config.get "gateway_port" "18789")
GATEWAY_BIND_MODE=$(bashio::config.get "gateway_bind_mode" "loopback")
ACCESS_MODE=$(bashio::config.get "access_mode" "custom")
GATEWAY_LOG_LEVEL=$(bashio::config.get "gateway_log_level" "info")

# Access Mode Logic
ENABLE_HTTPS_PROXY=false
GATEWAY_INTERNAL_PORT="$GATEWAY_PORT"

case "$ACCESS_MODE" in
  local_only)
    GATEWAY_BIND_MODE="loopback"
    ;;
  lan_https)
    GATEWAY_BIND_MODE="loopback"
    ENABLE_HTTPS_PROXY=true
    GATEWAY_INTERNAL_PORT=$((GATEWAY_PORT + 1))
    ;;
  lan_reverse_proxy)
    GATEWAY_BIND_MODE="lan"
    ;;
  tailnet_https)
    GATEWAY_BIND_MODE="tailnet"
    ;;
esac

# Network Hardening
FORCE_IPV4_DNS=$(bashio::config.get "force_ipv4_dns" "true")
if [ "$FORCE_IPV4_DNS" = "true" ] || [ "$FORCE_IPV4_DNS" = "1" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
fi

bashio::log.info "Options loaded. Mode: $GATEWAY_MODE, Port: $GATEWAY_INTERNAL_PORT, Bind: $GATEWAY_BIND_MODE"

# ------------------------------------------------------------------------------
# Section 2: Service Initialization (D-Bus & Avahi)
# ------------------------------------------------------------------------------
MDNS_MODE=$(bashio::config.get "mdns_mode" "minimal")
MDNS_HOST_NAME=$(bashio::config.get "mdns_host_name" "openclaw-ha-addon")
MDNS_SERVICE_PORT=$(bashio::config.get "mdns_service_port" "")

# Fallback for mDNS port if empty
if [ -z "$MDNS_SERVICE_PORT" ]; then
  MDNS_SERVICE_PORT="$GATEWAY_PORT"
fi

init_network_services() {
  if [ "$MDNS_MODE" != "avahi" ]; then return 0; fi

  bashio::log.info "Initializing mDNS/Avahi stack..."

  # 1. D-Bus
  if [ -f /usr/bin/dbus-daemon ]; then
    if ! pgrep -f "dbus-daemon" > /dev/null; then
      dbus-daemon --system --fork 2>/dev/null || bashio::log.warn "dbus-daemon failed to start"
    fi
  fi

  # 2. Avahi
  if [ -f /usr/sbin/avahi-daemon ]; then
    if ! pgrep -f "avahi-daemon" > /dev/null; then
      avahi-daemon -D --no-drop-root --no-chroot 2>/dev/null || bashio::log.warn "avahi-daemon failed to start"
      
      AVAHI_SERVICES_DIR="/var/lib/avahi-daemon/services"
      mkdir -p "$AVAHI_SERVICES_DIR"
      cat <<EOF > "${AVAHI_SERVICES_DIR}/openclaw.service"
<?xml version="1.0" encoding="UTF-8"?>
<service-group>
  <service name="${MDNS_HOST_NAME}.local">
    <type>_https._tcp</type>
    <port>${MDNS_SERVICE_PORT}</port>
    <txt-record>path=/</txt-record>
    <txt-record>version=1</txt-record>
    <txt-record>addon=openclaw-ha</txt-record>
  </service>
</service-group>
EOF
      chmod 644 "${AVAHI_SERVICES_DIR}/openclaw.service"
      killall -HUP avahi-daemon 2>/dev/null || true
    fi
  fi
}

# ------------------------------------------------------------------------------
# Section 3: Final Execution
# ------------------------------------------------------------------------------

# Run network init
init_network_services

# Port Guard: Ensure we aren't colliding with a ghost process
if [ "$GATEWAY_MODE" != "remote" ]; then
  if ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_INTERNAL_PORT} "; then
    bashio::log.error "Port ${GATEWAY_INTERNAL_PORT} is already occupied. Failing fast for Supervisor restart."
    exit 1
  fi
fi

bashio::log.info "Starting OpenClaw Gateway in foreground..."

# Execution as PID 1 (managed by tini)
# We start the gateway using 'run' for container compatibility.
# We use a pipe to bashio::log.info so that gateway logs are visible in the HA Supervisor UI.
openclaw gateway run \
    --port "$GATEWAY_INTERNAL_PORT" \
    --bind "$GATEWAY_BIND_MODE" \
    --log-level "$GATEWAY_LOG_LEVEL" 2>&1 | while read line; do
      bashio::log.info "$line"
    done
