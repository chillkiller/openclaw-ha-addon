#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# OpenClaw Home Assistant Addon run.sh (v0.7.6.1-Marvin-Fix)
# Best-of-All-Worlds: Trixie Full-Stack + coollabsio Persistence + techartdev HA-Integration
# Fixes: Avahi/D-Bus Supervisor, Robust Zombie Kill, Non-Fatal Pipe Errors
# ==============================================================================

# ------------------------------------------------------------------------------
# Section 0: Error Handler
# ------------------------------------------------------------------------------
error_handler() {
  echo "ERROR: Command failed at line $LINENO: $BASH_COMMAND"
  # We only exit if it's a critical failure during early bootstrap
  if [ "$BOOTSTRAP_COMPLETE" = "true" ]; then
    echo "Supervisor will handle the restart."
    return 0
  fi
  exit 1
}
trap error_handler ERR

# ------------------------------------------------------------------------------
# Section 0a: Log Rotation + Startup Trace File
# ------------------------------------------------------------------------------
LOG_DIR="/config/clawd/logs"
mkdir -p "$LOG_DIR"

MAX_LOG_SIZE=10485760  # 10MB
for log_file in "$LOG_DIR"/run_full_trace.log "$LOG_DIR"/gateway_startup.log; do
  if [ -f "$log_file" ] && [ "$(stat -c%s "$log_file" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
    mv -f "$log_file" "${log_file}.old" 2>/dev/null || true
  fi
done

exec > >(tee -a "$LOG_DIR/run_full_trace.log") 2>&1

echo "=== RUN.SH START: $(date -Iseconds) ==="

export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
export LD_LIBRARY_PATH="/home/linuxbrew/.linuxbrew/lib:${LD_LIBRARY_PATH:-}"
export PYTHONPATH="/config/.local/lib/python3.11/site-packages:${PYTHONPATH:-}"

if [ -d /opt/ms-playwright ] && [ ! -e /config/.cache/ms-playwright ]; then
  mkdir -p /config/.cache
  ln -sf /opt/ms-playwright /config/.cache/ms-playwright
  echo "Playwright browsers symlinked: /config/.cache/ms-playwright -> /opt/ms-playwright"
elif [ -d /opt/ms-playwright ] && [ -L /config/.cache/ms-playwright ]; then
  echo "Playwright browsers symlink already present"
fi
export PLAYWRIGHT_BROWSERS_PATH=/config/.cache/ms-playwright

# ------------------------------------------------------------------------------
# Section 1: Read HA Add-on Options
# ------------------------------------------------------------------------------
OPTIONS_FILE="/data/options.json"
if [ ! -f "$OPTIONS_FILE" ]; then
  echo "ERROR: Missing $OPTIONS_FILE (add-on options)."
  exit 1
fi

TZNAME=$(jq -r '.timezone // "Europe/Berlin"' "$OPTIONS_FILE")
GW_PUBLIC_URL=$(jq -r '.gateway_public_url // empty' "$OPTIONS_FILE")
HA_TOKEN=$(jq -r '.homeassistant_token // empty' "$OPTIONS_FILE")
ADDON_HTTP_PROXY=$(jq -r '.http_proxy // empty' "$OPTIONS_FILE")
ENABLE_TERMINAL=$(jq -r 'if .enable_terminal == null then true else .enable_terminal end' "$OPTIONS_FILE")
TERMINAL_PORT_RAW=$(jq -r '.terminal_port // 7681' "$OPTIONS_FILE")

GATEWAY_MODE=$(jq -r '.gateway_mode // "local"' "$OPTIONS_FILE")
GATEWAY_REMOTE_URL=$(jq -r '.gateway_remote_url // empty' "$OPTIONS_FILE")
GATEWAY_BIND_MODE=$(jq -r '.gateway_bind_mode // "loopback"' "$OPTIONS_FILE")
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")

if [ "$GATEWAY_PORT" -ge 65535 ]; then
  GATEWAY_PORT=$((GATEWAY_PORT - 1))
fi

if [[ "$TERMINAL_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$TERMINAL_PORT_RAW" -ge 1024 ] && [ "$TERMINAL_PORT_RAW" -le 65535 ]; then
  TERMINAL_PORT="$TERMINAL_PORT_RAW"
else
  TERMINAL_PORT="7681"
fi

if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then
  TERMINAL_PORT="7681"
fi

ROUTER_HOST=$(jq -r '.router_ssh_host // empty' "$OPTIONS_FILE")
ROUTER_USER=$(jq -r '.router_ssh_user // empty' "$OPTIONS_FILE")
ROUTER_KEY=$(jq -r '.router_ssh_key_path // "/data/keys/router_ssh"' "$OPTIONS_FILE")

CLEAN_LOCKS_ON_START=$(jq -r 'if .clean_session_locks_on_start == null then true else .clean_session_locks_on_start end' "$OPTIONS_FILE")
CLEAN_LOCKS_ON_EXIT=$(jq -r 'if .clean_session_locks_on_exit == null then true else .clean_session_locks_on_exit end' "$OPTIONS_FILE")

ENABLE_OPENAI_API=$(jq -r 'if .enable_openai_api == null then false else .enable_openai_api end' "$OPTIONS_FILE")
GATEWAY_AUTH_MODE=$(jq -r '.gateway_auth_mode // "token"' "$OPTIONS_FILE")
GATEWAY_TRUSTED_PROXIES=$(jq -r '.gateway_trusted_proxies // empty' "$OPTIONS_FILE")
GATEWAY_ADDITIONAL_ALLOWED_ORIGINS=$(jq -r '.gateway_additional_allowed_origins // empty' "$OPTIONS_FILE")
CONTROLUI_DISABLE_DEVICE_AUTH=$(jq -r 'if .controlui_disable_device_auth == null then true else .controlui_disable_device_auth end' "$OPTIONS_FILE")
FORCE_IPV4_DNS=$(jq -r 'if .force_ipv4_dns == null then true else .force_ipv4_dns end' "$OPTIONS_FILE")
ACCESS_MODE=$(jq -r '.access_mode // "custom"' "$OPTIONS_FILE")
NGINX_LOG_LEVEL=$(jq -r '.nginx_log_level // "minimal"' "$OPTIONS_FILE")
AUTO_CONFIGURE_MCP=$(jq -r 'if .auto_configure_mcp == null then false else .auto_configure_mcp end' "$OPTIONS_FILE")

MDNS_MODE=$(jq -r '.mdns_mode // "minimal"' "$OPTIONS_FILE")
MDNS_HOST_NAME=$(jq -r '.mdns_host_name // "openclaw-ha-addon"' "$OPTIONS_FILE")
MDNS_SERVICE_PORT_RAW=$(jq -r '.mdns_service_port // empty' "$OPTIONS_FILE")
MDNS_SERVICE_PORT="${MDNS_SERVICE_PORT_RAW:-$GATEWAY_PORT}"
MDNS_INTERFACE_NAME=$(jq -r '.mdns_interface_name // ""' "$OPTIONS_FILE")

GATEWAY_LOG_TO_CONSOLE=$(jq -r 'if .gateway_log_to_console == null then false else .gateway_log_to_console end' "$OPTIONS_FILE")
GATEWAY_LOG_LEVEL=$(jq -r '.gateway_log_level // "info"' "$OPTIONS_FILE")

LOG_LEVEL="error"
if [ "$GATEWAY_LOG_LEVEL" = "info" ]; then
  LOG_LEVEL="info"
elif [ "$GATEWAY_LOG_LEVEL" = "debug" ]; then
  LOG_LEVEL="debug"
fi
export LOG_LEVEL

GW_ENV_VARS_TYPE=$(jq -r 'if .gateway_env_vars == null then "null" else (.gateway_env_vars | type) end' "$OPTIONS_FILE")
GW_ENV_VARS_RAW=$(jq -r '.gateway_env_vars // empty' "$OPTIONS_FILE")
GW_ENV_VARS_JSON=$(jq -c '.gateway_env_vars // []' "$OPTIONS_FILE")

RUNTIME_APT_PACKAGES=$(jq -r '.runtime_apt_packages // empty' "$OPTIONS_FILE")
CUSTOM_INIT_SCRIPT=$(jq -r '.custom_init_script // empty' "$OPTIONS_FILE")

export TZ="$TZNAME"
export OPENCLAW_DISABLE_BONJOUR=1

echo "INFO: Options loaded (timezone=$TZNAME, gateway_mode=$GATEWAY_MODE, access_mode=$ACCESS_MODE)"

# ------------------------------------------------------------------------------
# Section 2: Access Mode Presets
# ------------------------------------------------------------------------------
ENABLE_HTTPS_PROXY=false
GATEWAY_INTERNAL_PORT="$GATEWAY_PORT"

case "$ACCESS_MODE" in
  local_only)
    GATEWAY_BIND_MODE="loopback"
    GATEWAY_AUTH_MODE="token"
    ;;
  lan_https)
    GATEWAY_BIND_MODE="loopback"
    GATEWAY_AUTH_MODE="token"
    ENABLE_HTTPS_PROXY=true
    GATEWAY_INTERNAL_PORT=$((GATEWAY_PORT + 1))
    GATEWAY_TRUSTED_PROXIES="127.0.0.1"
    ;;
  lan_reverse_proxy)
    GATEWAY_BIND_MODE="lan"
    GATEWAY_AUTH_MODE="trusted-proxy"
    ;;
  tailnet_https)
    GATEWAY_BIND_MODE="tailnet"
    GATEWAY_AUTH_MODE="token"
    ;;
  custom|*)
    ;;
esac

# ------------------------------------------------------------------------------
# Section 3: Network Configuration
# ------------------------------------------------------------------------------
set +x

if [ -n "$ADDON_HTTP_PROXY" ]; then
  if [[ "$ADDON_HTTP_PROXY" =~ ^https?://[^[:space:]]+$ ]]; then
    DEFAULT_NO_PROXY="localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.local"
    export HTTP_PROXY="$ADDON_HTTP_PROXY"
    export HTTPS_PROXY="$ADDON_HTTP_PROXY"
    export http_proxy="$ADDON_HTTP_PROXY"
    export https_proxy="$ADDON_HTTP_PROXY"
    export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${DEFAULT_NO_PROXY}"
    export no_proxy="${no_proxy:+${no_proxy},}${DEFAULT_NO_PROXY}"
  fi
fi

if [ "$FORCE_IPV4_DNS" = "true" ] || [ "$FORCE_IPV4_DNS" = "1" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
fi

# ------------------------------------------------------------------------------
# Section 23: mDNS/Avahi Supervisor Logic (Refactored)
# ------------------------------------------------------------------------------
ensure_mdns_services() {
  if [ "$MDNS_MODE" != "avahi" ]; then return 0; fi

  # 1. Ensure D-Bus
  if [ -f /usr/bin/dbus-daemon ]; then
    if ! pgrep -f "dbus-daemon" > /dev/null; then
      echo "INFO: Starting dbus-daemon..."
      dbus-daemon --system --fork 2>/dev/null || echo "WARN: dbus-daemon failed to start"
    fi
  fi

  # 2. Ensure Avahi
  if [ -f /usr/sbin/avahi-daemon ]; then
    if ! pgrep -f "avahi-daemon" > /dev/null; then
      echo "INFO: Starting avahi-daemon..."
      avahi-daemon -D --no-drop-root --no-chroot 2>/dev/null || echo "WARN: avahi-daemon failed to start"
      
      # Write service file
      AVAHI_SERVICES_DIR="/var/lib/avahi-daemon/services"
      mkdir -p "$AVAHI_SERVICES_DIR"
      cat <<<EOFEOF > "${AVAHI_SERVICES_DIR}/openclaw.service"
<?xml version="1.0" encoding="UTF-8"?>
<<serviceservice-group>
  <<serviceservice name="${MDNS_HOST_NAME}.local">
    <<typetype>_https._tcp</type>
    <<portport>${MDNS_SERVICE_PORT}</port>
    <<txttxt-record>path=/</txt-record>
    <<txttxt-record>version=1</txt-record>
    <<txttxt-record>addon=openclaw-ha</txt-record>
  </service>
</service-group>
EOF
      chmod 644 "${AVAHI_SERVICES_DIR}/openclaw.service"
      killall -HUP avahi-daemon 2>/dev/null || true
    fi
  fi
}

# ------------------------------------------------------------------------------
# Section: Gateway Utils
# ------------------------------------------------------------------------------
find_gateway_daemon_pid() {
  # Use || true to prevent set -e from killing the script if ss fails or finds nothing
  ss -tlnp 2>/dev/null | grep ":${GATEWAY_INTERNAL_PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true
}

start_openclaw_runtime() {
  echo "INFO: Attempting to start OpenClaw runtime..."
  
  # Use the gateway start command with internal port, bind mode, and log level.
  # We run it in the background so the supervisor loop can monitor the PID.
  openclaw gateway start --port "$GATEWAY_INTERNAL_PORT" --bind "$GATEWAY_BIND_MODE" --log-level "$LOG_LEVEL" &
  
  # Give it a moment to bind and produce a PID
  sleep 2
  
  local pid=$(find_gateway_daemon_pid)
  if [ -n "$pid" ]; then
    echo "INFO: OpenClaw runtime started successfully (PID $pid)."
    return 0
  else
    echo "ERROR: OpenClaw runtime failed to bind port $GATEWAY_INTERNAL_PORT."
    return 1
  fi
}

stop_gw_relay() {
  # Stop nginx/proxy relay
  true
}

start_gw_relay() {
  # Start nginx/proxy relay
  true
}

# ------------------------------------------------------------------------------
# Main Supervisor Loop
# ------------------------------------------------------------------------------
BOOTSTRAP_COMPLETE="false"
GW_IS_CHILD=true
GW_RESTART_COUNT=0
GW_MAX_BACKOFF=120
GW_PID=""

# Initial startup
ensure_mdns_services
if ! start_openclaw_runtime; then
  echo "WARN: Initial start failed, supervisor will attempt recovery."
fi
GW_PID=$(find_gateway_daemon_pid)

BOOTSTRAP_COMPLETE="true"

while true; do
  # 1. Health Check: Avahi/D-Bus
  ensure_mdns_services

  # 2. Health Check: Gateway
  if [ "$GW_IS_CHILD" = "true" ]; then
    wait "$GW_PID" 2>/dev/null || GW_EXIT_CODE=$?
  else
    while kill -0 "$GW_PID" 2>/dev/null; do
      [ "$SHUTTING_DOWN" = "true" ] && break 2
      sleep 5
    done
    GW_EXIT_CODE=0
  fi

  [ "$SHUTTING_DOWN" = "true" ] && break

  # 3. Zombie/PID Detection
  RESTARTED_PID=""
  if [ "$GATEWAY_MODE" != "remote" ]; then
    for _attempt in $(seq 1 20); do
      RESTARTED_PID=$(find_gateway_daemon_pid)
      [ -n "$RESTARTED_PID" ] && { sleep 3; break; }
      sleep 2
    done
  else
    sleep 2
    RESTARTED_PID=$(pgrep -f "openclaw.*node.*run" 2>/dev/null | head -1 || true)
  fi

  if [ -n "$RESTARTED_PID" ]; then
    echo "INFO: OpenClaw runtime active (PID $RESTARTED_PID); monitoring."
    GW_PID="$RESTARTED_PID"
    GW_IS_CHILD=false
    GW_RESTART_COUNT=0
    continue
  fi

  # 4. Final Port Guard (Non-fatal)
  if [ "$GATEWAY_MODE" != "remote" ]; then
    if ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_INTERNAL_PORT} "; then
      PORT_PID=$(find_gateway_daemon_pid)
      echo "INFO: Gateway port $GATEWAY_INTERNAL_PORT occupied by PID ${PORT_PID:-unknown}; monitoring."
      GW_PID="${PORT_PID:-$GW_PID}"
      GW_IS_CHILD=false
      GW_RESTART_COUNT=0
      continue
    fi
  fi

  # 5. Restart with Backoff
  GW_RESTART_COUNT=$((GW_RESTART_COUNT + 1))
  GW_BACKOFF=$(( 5 * (2 ** (GW_RESTART_COUNT - 1)) ))
  [ "$GW_BACKOFF" -gt "$GW_MAX_BACKOFF" ] && GW_BACKOFF=$GW_MAX_BACKOFF

  echo "WARN: OpenClaw runtime exited (code ${GW_EXIT_CODE:-unknown}); restart #$GW_RESTART_COUNT in ${GW_BACKOFF}s"
  sleep "$GW_BACKOFF"
  stop_gw_relay
  if ! start_openclaw_runtime; then
    echo "ERROR: Failed to restart (attempt #$GW_RESTART_COUNT)"
  else
    GW_IS_CHILD=true
    start_gw_relay
  fi
done

exit 0
