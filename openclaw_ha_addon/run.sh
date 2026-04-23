#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# OpenClaw Home Assistant Addon run.sh (v0.7.5.2)
# Best-of-All-Worlds: Trixie Full-Stack + coollabsio Persistence + techartdev HA-Integration
# ==============================================================================

# ------------------------------------------------------------------------------
# Section 0: Error Handler
# ------------------------------------------------------------------------------
error_handler() {
  echo "ERROR: Command failed at line $LINENO: $BASH_COMMAND"
  exit 1
}
trap error_handler ERR

# ------------------------------------------------------------------------------
# Section 0a: Log Rotation + Startup Trace File
# Add-on only: log everything to file for debugging startup issues.
# Console output is NOT touched — it flows naturally like the upstream repo.
# ------------------------------------------------------------------------------
LOG_DIR="/config/clawd/logs"
mkdir -p "$LOG_DIR"

# Log rotation: rotate files > 10MB before writing
MAX_LOG_SIZE=10485760  # 10MB
for log_file in "$LOG_DIR"/run_full_trace.log "$LOG_DIR"/gateway_startup.log; do
  if [ -f "$log_file" ] && [ "$(stat -c%s "$log_file" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
    mv -f "$log_file" "${log_file}.old" 2>/dev/null || true
  fi
done

# Mirror all console output (stdout+stderr) to the trace log file.
# The console itself is untouched — everything still shows up in the HA log window.
exec > >(tee -a "$LOG_DIR/run_full_trace.log") 2>&1

echo "=== RUN.SH START: $(date -Iseconds) ==="

# Ensure Homebrew and brew-installed binaries are in PATH
export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
# Force lookup of shared libraries in Homebrew (Critical for native modules!)
export LD_LIBRARY_PATH="/home/linuxbrew/.linuxbrew/lib:${LD_LIBRARY_PATH:-}"
# Force Python package paths in persistent config
export PYTHONPATH="/config/.local/lib/python3.11/site-packages:${PYTHONPATH:-}"

# ------------------------------------------------------------------------------
# Section 0b: Playwright Browser Cache
# Playwright is installed in the image at /opt/ms-playwright.
# Symlink it to /config/.cache/ms-playwright so tools (crawl4ai etc.)
# find the browser binary at the expected location.
# ------------------------------------------------------------------------------
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

# Gateway configuration
GATEWAY_MODE=$(jq -r '.gateway_mode // "local"' "$OPTIONS_FILE")
GATEWAY_REMOTE_URL=$(jq -r '.gateway_remote_url // empty' "$OPTIONS_FILE")
GATEWAY_BIND_MODE=$(jq -r '.gateway_bind_mode // "loopback"' "$OPTIONS_FILE")
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")

# Port safety
if [ "$GATEWAY_PORT" -ge 65535 ]; then
  echo "WARN: gateway_port $GATEWAY_PORT at max, using $((GATEWAY_PORT - 1))"
  GATEWAY_PORT=$((GATEWAY_PORT - 1))
fi

# SECURITY: Validate TERMINAL_PORT
if [[ "$TERMINAL_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$TERMINAL_PORT_RAW" -ge 1024 ] && [ "$TERMINAL_PORT_RAW" -le 65535 ]; then
  TERMINAL_PORT="$TERMINAL_PORT_RAW"
else
  echo "ERROR: Invalid terminal_port '$TERMINAL_PORT_RAW'. Must be numeric 1024-65535. Using default 7681."
  TERMINAL_PORT="7681"
fi

# SECURITY: Check for port conflicts with Gateway
if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then
  echo "ERROR: terminal_port conflicts with gateway_port ($GATEWAY_PORT). Using default 7681."
  TERMINAL_PORT="7681"
fi

# Router SSH settings
ROUTER_HOST=$(jq -r '.router_ssh_host // empty' "$OPTIONS_FILE")
ROUTER_USER=$(jq -r '.router_ssh_user // empty' "$OPTIONS_FILE")
ROUTER_KEY=$(jq -r '.router_ssh_key_path // "/data/keys/router_ssh"' "$OPTIONS_FILE")

# Lock cleanup
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

# mDNS/Bonjour configuration
MDNS_MODE=$(jq -r '.mdns_mode // "minimal"' "$OPTIONS_FILE")
MDNS_HOST_NAME=$(jq -r '.mdns_host_name // "openclaw-ha-addon"' "$OPTIONS_FILE")
MDNS_SERVICE_PORT_RAW=$(jq -r '.mdns_service_port // empty' "$OPTIONS_FILE")
MDNS_SERVICE_PORT="${MDNS_SERVICE_PORT_RAW:-$GATEWAY_PORT}"
MDNS_INTERFACE_NAME=$(jq -r '.mdns_interface_name // ""' "$OPTIONS_FILE")

# Gateway log-to-console option (read in Section 0, re-read for clarity)
# Default: false — gateway logs go to /config/clawd/logs/gateway_startup.log only
# When true: gateway output also visible on HA console (useful for debugging)
GATEWAY_LOG_TO_CONSOLE=$(jq -r 'if .gateway_log_to_console == null then false else .gateway_log_to_console end' "$OPTIONS_FILE")

# Gateway environment variables
GW_ENV_VARS_TYPE=$(jq -r 'if .gateway_env_vars == null then "null" else (.gateway_env_vars | type) end' "$OPTIONS_FILE")
GW_ENV_VARS_RAW=$(jq -r '.gateway_env_vars // empty' "$OPTIONS_FILE")
GW_ENV_VARS_JSON=$(jq -c '.gateway_env_vars // []' "$OPTIONS_FILE")

# Runtime apt packages (coollabsio pattern)
RUNTIME_APT_PACKAGES=$(jq -r '.runtime_apt_packages // empty' "$OPTIONS_FILE")

# Custom init script (coollabsio pattern)
CUSTOM_INIT_SCRIPT=$(jq -r '.custom_init_script // empty' "$OPTIONS_FILE")

export TZ="$TZNAME"

# Disable built-in Bonjour advertiser — causes probing loops in containers.
# Avahi handles mDNS at OS level when enabled.
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
    echo "INFO: Access mode: local_only (loopback + token, Ingress/terminal only)"
    ;;
  lan_https)
    GATEWAY_BIND_MODE="loopback"
    GATEWAY_AUTH_MODE="token"
    ENABLE_HTTPS_PROXY=true
    GATEWAY_INTERNAL_PORT=$((GATEWAY_PORT + 1))
    GATEWAY_TRUSTED_PROXIES="127.0.0.1"
    echo "INFO: Access mode: lan_https (built-in HTTPS proxy on 0.0.0.0:${GATEWAY_PORT}, device auth from config)"
    ;;
  lan_reverse_proxy)
    GATEWAY_BIND_MODE="lan"
    GATEWAY_AUTH_MODE="trusted-proxy"
    if [ -z "$GATEWAY_TRUSTED_PROXIES" ]; then
      echo "ERROR: access_mode=lan_reverse_proxy requires gateway_trusted_proxies"
    fi
    echo "INFO: Access mode: lan_reverse_proxy (LAN bind + trusted-proxy auth)"
    ;;
  tailnet_https)
    GATEWAY_BIND_MODE="tailnet"
    GATEWAY_AUTH_MODE="token"
    echo "INFO: Access mode: tailnet_https (Tailscale bind + token auth)"
    ;;
  custom|*)
    echo "INFO: Access mode: custom (using individual gateway_bind_mode/auth_mode settings)"
    ;;
esac

echo "INFO: Section 2 done (access mode resolved)"

# ------------------------------------------------------------------------------
# Section 3: Network Configuration (Proxy, IPv4, Environment)
# ------------------------------------------------------------------------------

# Reduce risk of secrets in logs
set +x

# Optional outbound proxy
if [ -n "$ADDON_HTTP_PROXY" ]; then
  if [[ "$ADDON_HTTP_PROXY" =~ ^https?://[^[:space:]]+$ ]]; then
    DEFAULT_NO_PROXY="localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.local"
    export HTTP_PROXY="$ADDON_HTTP_PROXY"
    export HTTPS_PROXY="$ADDON_HTTP_PROXY"
    export http_proxy="$ADDON_HTTP_PROXY"
    export https_proxy="$ADDON_HTTP_PROXY"
    export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${DEFAULT_NO_PROXY}"
    export no_proxy="${no_proxy:+${no_proxy},}${DEFAULT_NO_PROXY}"
    echo "INFO: Outbound HTTP/HTTPS proxy enabled"
  else
    echo "WARN: Invalid http_proxy value; expected URL like http://host:port"
  fi
fi

# Force IPv4-first DNS ordering
if [ "$FORCE_IPV4_DNS" = "true" ] || [ "$FORCE_IPV4_DNS" = "1" ]; then
  if [ -n "${NODE_OPTIONS:-}" ]; then
    export NODE_OPTIONS="${NODE_OPTIONS} --dns-result-order=ipv4first"
  else
    export NODE_OPTIONS="--dns-result-order=ipv4first"
  fi
  echo "INFO: IPv4-first DNS ordering enabled"
fi

# Export gateway env vars from add-on config
if [ "$GW_ENV_VARS_TYPE" = "array" ] || [ "$GW_ENV_VARS_TYPE" = "object" ] || { [ "$GW_ENV_VARS_TYPE" = "string" ] && [ -n "$GW_ENV_VARS_RAW" ]; }; then
  env_count=0
  max_env_vars=50
  max_var_name_size=255
  max_var_value_size=10000

  is_reserved_gateway_env_var() {
    case "$1" in
      HOME|PATH|PWD|OLDPWD|SHLVL|TZ|XDG_CONFIG_HOME|PNPM_HOME|NODE_PATH|NODE_OPTIONS|NODE_NO_WARNINGS) return 0 ;;
      LD_*|DYLD_*|BASH_ENV|ENV|BASH_FUNC_*) return 0 ;;
      HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy) return 0 ;;
      OPENCLAW_*) return 0 ;;
      *) return 1 ;;
    esac
  }

  try_export_gateway_env_var() {
    local key="$1" value="$2"
    [ -z "$key" ] && return 0
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "WARN: Invalid env var name: '$key'"; return 0; }
    is_reserved_gateway_env_var "$key" && { echo "WARN: Reserved env var '$key' skipped"; return 0; }
    [ ${#key} -gt $max_var_name_size ] && { echo "WARN: Env var name too long: '$key'"; return 0; }
    [ ${#value} -gt $max_var_value_size ] && { echo "WARN: Env var value too long for '$key'"; return 0; }
    [ $env_count -ge $max_env_vars ] && { echo "WARN: Max env vars ($max_env_vars) reached"; return 0; }
    export "$key=$value"
    env_count=$((env_count + 1))
    echo "INFO: Exported gateway env var: $key"
  }

  if [ "$GW_ENV_VARS_TYPE" = "array" ] && [ "$GW_ENV_VARS_JSON" != "[]" ]; then
    echo "INFO: Setting gateway env vars from list config..."
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
      try_export_gateway_env_var "$key" "$value"
    done < <(printf '%s' "$GW_ENV_VARS_JSON" | jq -j '.[] | select((type == "object") and ((.name | type) == "string") and (has("value"))) | .name, "\u0000", (.value | tostring), "\u0000"')
  elif [ "$GW_ENV_VARS_TYPE" = "object" ] && [ "$GW_ENV_VARS_JSON" != "{}" ]; then
    echo "INFO: Setting gateway env vars from object config (legacy)..."
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
      try_export_gateway_env_var "$key" "$value"
    done < <(printf '%s' "$GW_ENV_VARS_JSON" | jq -j 'to_entries[] | .key, "\u0000", (.value | tostring), "\u0000"')
  elif [ "$GW_ENV_VARS_TYPE" = "string" ] && [ -n "$GW_ENV_VARS_RAW" ]; then
    if printf '%s' "$GW_ENV_VARS_RAW" | jq -e 'type == "object"' >/dev/null 2>&1; then
      echo "INFO: Setting gateway env vars from JSON string..."
      while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        try_export_gateway_env_var "$key" "$value"
      done < <(printf '%s' "$GW_ENV_VARS_RAW" | jq -j 'to_entries[] | .key, "\u0000", (.value | tostring), "\u0000"')
    else
      echo "INFO: Setting gateway env vars from KEY=VALUE string..."
      while IFS= read -r entry; do
        entry="${entry%$'\r'}"
        trimmed="$(printf '%s' "$entry" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"
        [ -z "$trimmed" ] || [[ "$trimmed" == \#* ]] && continue
        [[ "$trimmed" != *=* ]] && { echo "WARN: Invalid env var entry '$trimmed'"; continue; }
        key="${trimmed%%=*}"; value="${trimmed#*=}"
        key="$(printf '%s' "$key" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"
        try_export_gateway_env_var "$key" "$value"
      done < <(printf '%s' "$GW_ENV_VARS_RAW" | tr ';' '\n')
    fi
  fi
  [ $env_count -gt 0 ] && echo "INFO: Exported $env_count gateway env var(s)"
elif [ "$GW_ENV_VARS_TYPE" != "null" ]; then
  echo "WARN: Invalid gateway_env_vars format, skipping"
fi

echo "INFO: Section 3 done (network + env vars)"

# ------------------------------------------------------------------------------
# Section 4: Adaptive RAM Detection + Node.js Memory
# ------------------------------------------------------------------------------
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))
RAM_MODE="power"
[ "$TOTAL_RAM_GB" -le 8 ] && RAM_MODE="safe"
echo "INFO: Detected ${TOTAL_RAM_GB}GB RAM -> ${RAM_MODE} mode"

if [ "$RAM_MODE" = "power" ]; then
  NODE_HEAP_SIZE=3072
else
  NODE_HEAP_SIZE=2048
fi

if [ -z "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_SIZE}"
else
  export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=${NODE_HEAP_SIZE}"
fi
echo "INFO: Node.js memory: max-old-space-size=${NODE_HEAP_SIZE}"
echo "INFO: Section 4 done (RAM + Node.js memory)"

# ------------------------------------------------------------------------------
# Section 5: Paths + HOME Consistency
# ------------------------------------------------------------------------------
# HA add-ons mount persistent storage at /config
export HOME=/config
export OPENCLAW_CONFIG_DIR=/config/.openclaw
export OPENCLAW_WORKSPACE_DIR=/config/clawd
export XDG_CONFIG_HOME=/config

# V8 compile cache for faster CLI startups
export NODE_COMPILE_CACHE=/config/.node-compile-cache
mkdir -p "$NODE_COMPILE_CACHE"
echo "INFO: NODE_COMPILE_CACHE=$NODE_COMPILE_CACHE"

# Chromium cache
export CHROMIUM_CACHE=/tmp/openclaw/chromium_cache
mkdir -p "$CHROMIUM_CACHE"

# Resource limits: prevent WASM virtual memory exhaustion
# Virtual memory: NO hard ulimit -v (WASM needs large virtual address space)
# Container cgroups enforce real memory limits anyway
# Old: ulimit -v 4194304 caused WASM OOM in undici/llhttp
ulimit -v unlimited 2>/dev/null || true
echo "INFO: Virtual memory unlimited (WASM-safe, cgroups enforce real limits)"

# Create essential persistent directories
mkdir -p \
  /config/.openclaw \
  /config/.openclaw/identity \
  /config/clawd \
  /config/keys \
  /config/secrets \
  /config/.node_global \
  /config/.npm-global \
  /config/.uv-tools \
  /config/.go \
  /config/.openclaw/agents \
  /config/.openclaw/skills \
  /config/certs \
  /config/logs \
  /data \
  2>/dev/null || true

# Back-compat symlink
[ ! -e /data ] && ln -s /config /data || true

# Node global packages persistent (coollabsio pattern)
npm config set prefix /config/.npm-global 2>/dev/null || true
export PATH="/config/.npm-global/bin:${PATH}"
export NODE_PATH="/config/.npm-global/lib/node_modules:${NODE_PATH:-}"

# pnpm global persistent
export PNPM_HOME="/config/.npm-global/pnpm"
mkdir -p "$PNPM_HOME"
export PATH="${PNPM_HOME}:${PATH}"

# Go persistent (coollabsio pattern)
export GOPATH=/config/.go
export PATH="/usr/local/go/bin:${GOPATH}/bin:${PATH}"

# uv persistent (coollabsio pattern)
export UV_TOOL_DIR=/config/.uv-tools
export UV_CACHE_DIR=/config/.uv-cache
export PATH="/config/.local/bin:${UV_TOOL_DIR}/bin:${PATH}"
mkdir -p "$UV_TOOL_DIR" "$UV_CACHE_DIR"

echo "INFO: Section 5 done (paths + persistence dirs)"

# ------------------------------------------------------------------------------
# Section 6: Homebrew Persistence (Best-of-All-Worlds)
# ------------------------------------------------------------------------------
IMAGE_BREW_DIR="/home/linuxbrew/.linuxbrew"
PERSISTENT_BREW_DIR="/config/.linuxbrew"

if [ -d "$IMAGE_BREW_DIR" ] && [ ! -L "$IMAGE_BREW_DIR" ]; then
  if [ -d "$PERSISTENT_BREW_DIR" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --update "$IMAGE_BREW_DIR/" "$PERSISTENT_BREW_DIR/" 2>/dev/null || true
    else
      cp -ru "$IMAGE_BREW_DIR/"* "$PERSISTENT_BREW_DIR/" 2>/dev/null || true
    fi
    echo "INFO: Homebrew synced to persistent storage"
  else
    cp -a "$IMAGE_BREW_DIR" "$PERSISTENT_BREW_DIR" 2>/dev/null || true
    echo "INFO: Homebrew copied to persistent storage"
  fi
  rm -rf "$IMAGE_BREW_DIR"
  ln -sf "$PERSISTENT_BREW_DIR" "$IMAGE_BREW_DIR"
elif [ -L "$IMAGE_BREW_DIR" ]; then
  echo "INFO: Homebrew already linked to persistent storage"
elif [ -d "$PERSISTENT_BREW_DIR" ]; then
  ln -sf "$PERSISTENT_BREW_DIR" "$IMAGE_BREW_DIR"
  echo "INFO: Homebrew restored from persistent storage"
else
  echo "INFO: Homebrew not available (may have failed during image build)"
fi

# Fix safe.directory for Homebrew Git
echo "INFO: Git safe.directory=/home/linuxbrew/.linuxbrew/Homebrew"
git config --global --add safe.directory /home/linuxbrew/.linuxbrew/Homebrew 2>/dev/null || true

echo "INFO: Section 6 done (Homebrew persistence)"

# ------------------------------------------------------------------------------
# Section 7: OpenClaw Skills Sync (Best-of-All-Worlds)
# ------------------------------------------------------------------------------
# Sync built-in skills from image to persistent storage so they survive rebuilds.
IMAGE_SKILLS_DIR="/usr/lib/node_modules/openclaw/skills"
PERSISTENT_SKILLS_DIR="/config/.openclaw/skills"

if [ -d "$IMAGE_SKILLS_DIR" ] && [ ! -L "$IMAGE_SKILLS_DIR" ]; then
  mkdir -p "$PERSISTENT_SKILLS_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --update "$IMAGE_SKILLS_DIR/" "$PERSISTENT_SKILLS_DIR/" 2>/dev/null || true
  else
    cp -ru "$IMAGE_SKILLS_DIR/"* "$PERSISTENT_SKILLS_DIR/" 2>/dev/null || true
  fi
  rm -rf "$IMAGE_SKILLS_DIR"
  ln -sf "$PERSISTENT_SKILLS_DIR" "$IMAGE_SKILLS_DIR"
  echo "INFO: Skills synced to persistent storage at $PERSISTENT_SKILLS_DIR"
elif [ -L "$IMAGE_SKILLS_DIR" ]; then
  echo "INFO: Skills already linked to persistent storage"
else
  echo "INFO: Skills directory not found at $IMAGE_SKILLS_DIR (may be installed elsewhere)"
fi

echo "INFO: Section 7 done (skills sync)"

# ------------------------------------------------------------------------------
# Section 8: Custom Init Script (coollabsio pattern)
# ------------------------------------------------------------------------------
if [ -n "$CUSTOM_INIT_SCRIPT" ]; then
  if [ -f "$CUSTOM_INIT_SCRIPT" ]; then
    chmod +x "$CUSTOM_INIT_SCRIPT" 2>/dev/null || true
    echo "INFO: Running custom init script: $CUSTOM_INIT_SCRIPT"
    "$CUSTOM_INIT_SCRIPT" || echo "WARN: Init script exited with code $?"
  else
    echo "WARN: Custom init script not found: $CUSTOM_INIT_SCRIPT"
  fi
fi

# ------------------------------------------------------------------------------
# Section 9: Runtime apt Packages (coollabsio pattern)
# ------------------------------------------------------------------------------
if [ -n "$RUNTIME_APT_PACKAGES" ]; then
  echo "INFO: Installing runtime apt packages: $RUNTIME_APT_PACKAGES"
  apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      $RUNTIME_APT_PACKAGES \
    && rm -rf /var/lib/apt/lists/*
  echo "INFO: Runtime apt packages installed"
fi

echo "INFO: Section 8+9 done (init script + runtime apt)"

# ------------------------------------------------------------------------------
# Section 10: Session Lock Cleanup Helpers
# ------------------------------------------------------------------------------
gateway_running() {
  pgrep -f "openclaw-gateway" >/dev/null 2>&1
}

cleanup_session_locks() {
  local agents_dir="/config/.openclaw/agents"
  local total_locks=0
  local cleaned_dirs=()
  shopt -s nullglob
  local all_locks=()
  for agent_sessions_dir in "${agents_dir}"/*/sessions; do
    local agent_locks=( "${agent_sessions_dir}"/*.jsonl.lock )
    if [ ${#agent_locks[@]} -gt 0 ]; then
      all_locks+=( "${agent_locks[@]}" )
      cleaned_dirs+=( "$agent_sessions_dir" )
      total_locks=$(( total_locks + ${#agent_locks[@]} ))
    fi
  done
  shopt -u nullglob

  [ "$total_locks" -eq 0 ] && return 0

  if gateway_running; then
    echo "INFO: Gateway running; leaving $total_locks session lock(s) untouched"
    return 0
  fi

  echo "INFO: Removing $total_locks stale session lock(s)"
  for agent_sessions_dir in "${cleaned_dirs[@]}"; do
    rm -f "${agent_sessions_dir}"/*.jsonl.lock 2>/dev/null || true
  done
}

if [ "$CLEAN_LOCKS_ON_START" = "true" ]; then
  cleanup_session_locks
else
  echo "INFO: clean_session_locks_on_start=false; skipping"
fi

# Store HA token
if [ -n "$HA_TOKEN" ]; then
  umask 077
  mkdir -p /config/secrets
  printf '%s' "$HA_TOKEN" > /config/secrets/homeassistant.token
  echo "INFO: HA token stored"
fi

# Connection notes
cat > /config/CONNECTION_NOTES.txt <<EOF
Home Assistant token (if set): /config/secrets/homeassistant.token
Router SSH: host=${ROUTER_HOST} user=${ROUTER_USER} key=${ROUTER_KEY}
EOF

echo "INFO: Section 10 done (locks + HA token)"

# ------------------------------------------------------------------------------
# Section 11: Single-Instance Guard
# ------------------------------------------------------------------------------
STARTUP_LOCK="/config/.openclaw/gateway.start.lock"
exec 9>"$STARTUP_LOCK"
if ! flock -n 9; then
  echo "ERROR: Another instance appears to be running (could not acquire $STARTUP_LOCK)."
  exit 1
fi

# Zombie cleanup
ZOMBIE_PIDS=$(ps aux | grep -E '<defunct>' | awk '{print $2}')
if [ -n "$ZOMBIE_PIDS" ]; then
  echo "INFO: Cleaning up $(($(echo "$ZOMBIE_PIDS" | wc -w))) zombie process(es)"
  for zp in $ZOMBIE_PIDS; do wait "$zp" 2>/dev/null || true; done
fi

echo "INFO: Section 11 done (single-instance guard)"

# ------------------------------------------------------------------------------
# Section 12: OpenClaw Binary Check + Config Bootstrap
# ------------------------------------------------------------------------------
if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw is not installed."
  exit 1
fi

OPENCLAW_CONFIG_PATH="/config/.openclaw/openclaw.json"
HELPER_PATH="/oc_config_helper.py"

if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "INFO: Bootstrapping minimal OpenClaw config at $OPENCLAW_CONFIG_PATH"
  python3 - <<'PY'
import json, secrets
from pathlib import Path
p = Path('/config/.openclaw/openclaw.json')
p.parent.mkdir(parents=True, exist_ok=True)
cfg = {
    "gateway": {
        "mode": "local",
        "port": 18789,
        "bind": "loopback",
        "auth": {"mode": "token", "token": secrets.token_urlsafe(24)}
    },
    "agents": {"defaults": {"workspace": "/config/clawd"}}
}
p.write_text(json.dumps(cfg, indent=2) + "\n", encoding='utf-8')
print("INFO: Minimal OpenClaw config written")
PY
fi

echo "INFO: Section 12 done (binary check + config bootstrap)"

# ------------------------------------------------------------------------------
# Section 13: Apply Gateway Settings via oc_config_helper
# ------------------------------------------------------------------------------
if [ -f "$OPENCLAW_CONFIG_PATH" ] && [ -f "$HELPER_PATH" ]; then
  EFFECTIVE_GW_PORT="$GATEWAY_INTERNAL_PORT"
  if ! python3 "$HELPER_PATH" apply-gateway-settings \
    "$GATEWAY_MODE" \
    "$GATEWAY_REMOTE_URL" \
    "$GATEWAY_BIND_MODE" \
    "$EFFECTIVE_GW_PORT" \
    "$ENABLE_OPENAI_API" \
    "$GATEWAY_AUTH_MODE" \
    "$GATEWAY_TRUSTED_PROXIES"; then
    echo "ERROR: Failed to apply gateway settings (exit code $?)"
    exit 1
  fi
else
  echo "WARN: oc_config_helper.py or openclaw.json not found; skipping gateway settings"
fi

echo "INFO: Section 13 done (gateway settings)"

# ------------------------------------------------------------------------------
# Section 13b: Ensure critical plugins (ollama for web search)
# ------------------------------------------------------------------------------
if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  python3 "$HELPER_PATH" ensure-plugins 2>/dev/null || echo "WARN: ensure-plugins failed (non-fatal)"
fi

# ------------------------------------------------------------------------------
# Section 14: TLS Certificate Generation (lan_https mode)
# ------------------------------------------------------------------------------
CERT_LAN_IP=""
if [ "$ENABLE_HTTPS_PROXY" = "true" ]; then
  CERT_DIR="/config/certs"
  mkdir -p "$CERT_DIR"
  CERT_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  STORED_IP=$(cat "$CERT_DIR/.cert_ip" 2>/dev/null || echo "")

  # Generate CA if missing
  if [ ! -f "$CERT_DIR/ca.key" ]; then
    echo "INFO: Generating local CA certificate (one-time)..."
    openssl genrsa -out "$CERT_DIR/ca.key" 2048 2>/dev/null
    openssl req -new -x509 -key "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
      -days 3650 -nodes -subj "/CN=OpenClaw Local CA" 2>/dev/null
    chmod 600 "$CERT_DIR/ca.key"
    STORED_IP=""
  fi

  # Extra SANs from gateway_additional_allowed_origins + gateway_public_url
  EXTRA_SANS=""
  EXTRA_SAN_SOURCES="${GATEWAY_ADDITIONAL_ALLOWED_ORIGINS},${GW_PUBLIC_URL}"
  if [ "$EXTRA_SAN_SOURCES" != "," ]; then
    EXTRA_SANS="$(python3 - "$EXTRA_SAN_SOURCES" "${CERT_LAN_IP:-}" <<'PY'
import sys, re
from urllib.parse import urlparse
raw = sys.argv[1] if len(sys.argv) > 1 else ""
lan_ip = sys.argv[2] if len(sys.argv) > 2 else ""
entries = [e.strip() for e in raw.split(",") if e.strip()]
sans = []
seen = {"127.0.0.1", "localhost", "homeassistant", "homeassistant.local"}
if lan_ip: seen.add(lan_ip)
for entry in entries:
    if "://" not in entry: entry = "https://" + entry
    host = urlparse(entry).hostname or ""
    if host and host not in seen:
        seen.add(host)
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host): sans.append(f"IP:{host}")
        else: sans.append(f"DNS:{host}")
print(",".join(sans), end="")
PY
)"
  fi

  # Generate server cert if needed
  STORED_EXTRA_SANS=$(cat "$CERT_DIR/.cert_extra_sans" 2>/dev/null || echo "")
  if [ ! -f "$CERT_DIR/gateway.crt" ] || [ "$CERT_LAN_IP" != "$STORED_IP" ] || [ "$EXTRA_SANS" != "$STORED_EXTRA_SANS" ]; then
    echo "INFO: Generating server TLS certificate (LAN IP: ${CERT_LAN_IP:-unknown})..."
    openssl genrsa -out "$CERT_DIR/gateway.key" 2048 2>/dev/null
    openssl req -new -key "$CERT_DIR/gateway.key" -out "$CERT_DIR/gateway.csr" \
      -subj "/CN=OpenClaw Gateway" 2>/dev/null
    cat > "$CERT_DIR/_san.ext" <<SANEOF
subjectAltName=IP:${CERT_LAN_IP:-127.0.0.1},IP:127.0.0.1,DNS:localhost,DNS:homeassistant,DNS:homeassistant.local${MDNS_HOST_NAME:+,DNS:${MDNS_HOST_NAME}.local}${EXTRA_SANS:+,${EXTRA_SANS}}
SANEOF
    openssl x509 -req -in "$CERT_DIR/gateway.csr" \
      -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
      -out "$CERT_DIR/gateway.crt" -days 3650 \
      -extfile "$CERT_DIR/_san.ext" 2>/dev/null
    rm -f "$CERT_DIR/gateway.csr" "$CERT_DIR/_san.ext" "$CERT_DIR/ca.srl"
    chmod 600 "$CERT_DIR/gateway.key"
    printf '%s' "$CERT_LAN_IP" > "$CERT_DIR/.cert_ip"
    printf '%s' "$EXTRA_SANS" > "$CERT_DIR/.cert_extra_sans"
  fi
  # Make CA cert downloadable
  mkdir -p /etc/nginx/html
  cp "$CERT_DIR/ca.crt" /etc/nginx/html/openclaw-ca.crt 2>/dev/null || true
  echo "INFO: TLS certificates ready (CA: $CERT_DIR/ca.crt, Server: $CERT_DIR/gateway.crt)"
fi

echo "INFO: Section 14 done (TLS certificates)"

# ------------------------------------------------------------------------------
# Section 15: Control UI Origins
# ------------------------------------------------------------------------------
if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  ALLOWED_ORIGINS=""
  if [ "$ENABLE_HTTPS_PROXY" = "true" ] && [ -n "$CERT_LAN_IP" ]; then
    ALLOWED_ORIGINS="https://${CERT_LAN_IP}:${GATEWAY_PORT},https://homeassistant.local:${GATEWAY_PORT},https://homeassistant:${GATEWAY_PORT}"
    # Add mDNS hostname to allowed origins if configured
    if [ -n "$MDNS_HOST_NAME" ]; then
      ALLOWED_ORIGINS="${ALLOWED_ORIGINS},https://${MDNS_HOST_NAME}.local:${GATEWAY_PORT}"
    fi
  fi
  GW_PUBLIC_ORIGIN=""
  if [ -n "$GW_PUBLIC_URL" ]; then
    GW_PUBLIC_ORIGIN="$(python3 - "$GW_PUBLIC_URL" <<'PY'
import sys; from urllib.parse import urlparse
u = (sys.argv[1] or '').strip(); p = urlparse(u)
if p.scheme in ('http', 'https') and p.netloc: print(f"{p.scheme}://{p.netloc}", end='')
PY
)"
    [ -n "$GW_PUBLIC_ORIGIN" ] && ALLOWED_ORIGINS="${ALLOWED_ORIGINS:+${ALLOWED_ORIGINS},}${GW_PUBLIC_ORIGIN}"
  fi
  python3 "$HELPER_PATH" set-control-ui-origins \
    "$ALLOWED_ORIGINS" \
    "$GATEWAY_ADDITIONAL_ALLOWED_ORIGINS" \
    "$CONTROLUI_DISABLE_DEVICE_AUTH" || echo "WARN: Could not set controlUi settings"
fi

echo "INFO: Section 15 done (control UI origins)"

# --- Control UI Debug Dump ---
echo "DEBUG: access_mode=$ACCESS_MODE, ENABLE_HTTPS_PROXY=$ENABLE_HTTPS_PROXY"
echo "DEBUG: CONTROLUI_DISABLE_DEVICE_AUTH=$CONTROLUI_DISABLE_DEVICE_AUTH"
echo "DEBUG: GATEWAY_BIND_MODE=$GATEWAY_BIND_MODE, GATEWAY_PORT=$GATEWAY_PORT, GATEWAY_INTERNAL_PORT=$GATEWAY_INTERNAL_PORT"
if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "DEBUG: controlUi=$(jq -c '.gateway.controlUi' "$OPENCLAW_CONFIG_PATH" 2>/dev/null || echo 'not readable')"
  echo "DEBUG: gateway.bind=$(jq -r '.gateway.bind' "$OPENCLAW_CONFIG_PATH" 2>/dev/null || echo 'not readable')"
  echo "DEBUG: gateway.port=$(jq -r '.gateway.port' "$OPENCLAW_CONFIG_PATH" 2>/dev/null || echo 'not readable')"
  echo "DEBUG: gateway.auth.mode=$(jq -r '.gateway.auth.mode' "$OPENCLAW_CONFIG_PATH" 2>/dev/null || echo 'not readable')"
fi

# ------------------------------------------------------------------------------
# Section 16: Proxy Shim
# ------------------------------------------------------------------------------
OPENCLAW_GLOBAL_NODE_MODULES="/config/.npm-global/lib/node_modules"
if [ -f /usr/local/lib/openclaw-proxy-shim.cjs ]; then
  export NODE_OPTIONS="--require /usr/local/lib/openclaw-proxy-shim.cjs ${NODE_OPTIONS}"
  export OPENCLAW_GLOBAL_NODE_MODULES
  echo "INFO: Proxy shim loaded"
fi

# ------------------------------------------------------------------------------
# Section 17: MCP Auto-Configure
# ------------------------------------------------------------------------------
if [ "$AUTO_CONFIGURE_MCP" = "true" ] && [ -n "$HA_TOKEN" ]; then
  if command -v mcporter >/dev/null 2>&1; then
    MCP_HA_URL="http://supervisor/core/api/mcp"
    [ -z "${SUPERVISOR_TOKEN:-}" ] && MCP_HA_URL="http://localhost:8123/api/mcp"
    MCP_FLAG="/config/.openclaw/.mcp_ha_configured"
    MCP_TOKEN_HASH=$(printf '%s' "$HA_TOKEN" | sha256sum | cut -d' ' -f1)
    if [ -f "$MCP_FLAG" ] && [ "$(cat "$MCP_FLAG" 2>/dev/null)" = "$MCP_TOKEN_HASH" ]; then
      echo "INFO: MCP Home Assistant already configured (token unchanged)"
    else
      echo "INFO: Configuring MCP for Home Assistant at $MCP_HA_URL ..."
      mcporter config remove HA 2>/dev/null || true
      if mcporter config add HA "$MCP_HA_URL" --header "Authorization=Bearer $HA_TOKEN" --scope home 2>&1; then
        printf '%s' "$MCP_TOKEN_HASH" > "$MCP_FLAG"
        echo "INFO: MCP server 'HA' registered"
      else
        echo "WARN: MCP auto-configuration failed"
      fi
    fi
  else
    echo "INFO: mcporter not available; skipping MCP auto-configuration"
  fi
fi

echo "INFO: Section 16+17 done (proxy shim + MCP)"

# ------------------------------------------------------------------------------
# Section 18: Gateway Start Functions
# ------------------------------------------------------------------------------
start_openclaw_runtime() {
  echo "INFO: Starting OpenClaw runtime (mode=$GATEWAY_MODE) ..."
  if [ "$GATEWAY_MODE" = "remote" ]; then
    REMOTE_URL="$GATEWAY_REMOTE_URL"
    if [ -z "$REMOTE_URL" ]; then
      echo "ERROR: gateway_mode=remote but gateway_remote_url is not set"
      return 1
    fi
    eval "$(python3 - "$REMOTE_URL" <<'PY'
import sys; from urllib.parse import urlparse
url = (sys.argv[1] or '').strip(); p = urlparse(url)
if p.scheme not in ('ws', 'wss') or not p.hostname:
    print('echo "ERROR: Invalid gateway.remote.url"'); print('exit 1'); raise SystemExit(0)
port = p.port or (443 if p.scheme == 'wss' else 80)
print(f'NODE_HOST={p.hostname}'); print(f'NODE_PORT={port}')
print(f'NODE_TLS_FLAG={"--tls" if p.scheme == "wss" else ""}')
PY
)"
    openclaw node run --host "$NODE_HOST" --port "$NODE_PORT" $NODE_TLS_FLAG &
  else
    mkdir -p /config/clawd/logs
    if [ "$GATEWAY_LOG_TO_CONSOLE" = "true" ] || [ "$GATEWAY_LOG_TO_CONSOLE" = "1" ]; then
      # Gateway output to console AND file (useful for debugging)
      openclaw gateway run 2>&1 | tee -a /config/clawd/logs/gateway_startup.log &
    else
      # Gateway output to file only (default — keeps HA console cleaner)
      openclaw gateway run > /config/clawd/logs/gateway_startup.log 2>&1 &
    fi
  fi
  GW_PID=$!
  return 0
}

# Loopback relay for tailnet mode
start_gw_relay() {
  [ "$GATEWAY_BIND_MODE" != "tailnet" ] && return 0
  local ts_ip
  ts_ip=$(ip -4 addr show tailscale0 2>/dev/null | awk '/inet /{gsub(/\/.*\//,"",$2); print $2; exit}' || true)
  if [[ "${ts_ip:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "INFO: Starting loopback relay (127.0.0.1:${GATEWAY_PORT} -> ${ts_ip}:${GATEWAY_PORT})"
    node -e "
const net = require('net');
const TARGET_HOST = '${ts_ip}'; const TARGET_PORT = ${GATEWAY_PORT};
const server = net.createServer(function(c) { const t = net.createConnection(TARGET_PORT, TARGET_HOST); c.pipe(t); t.pipe(c); c.on('error', function() { t.destroy(); }); t.on('error', function() { c.destroy(); }); });
server.listen(TARGET_PORT, '127.0.0.1');" &
    GW_RELAY_PID=$!
  else
    echo "WARN: tailnet mode but Tailscale IP not found on tailscale0"
  fi
}

stop_gw_relay() {
  if [ -n "${GW_RELAY_PID:-}" ] && kill -0 "${GW_RELAY_PID}" 2>/dev/null; then
    kill -TERM "${GW_RELAY_PID}" 2>/dev/null || true
    wait "${GW_RELAY_PID}" 2>/dev/null || true
    GW_RELAY_PID=""
  fi
}

find_gateway_daemon_pid() {
  local pid=""
  # Tier 1: port ownership
  pid=$(ss -tlnp 2>/dev/null | grep ":${GATEWAY_INTERNAL_PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  [ -n "$pid" ] && { echo "$pid"; return 0; }
  # Tier 2: process title
  pid=$(pgrep -f "openclaw-gateway" 2>/dev/null | head -1)
  [ -n "$pid" ] && { echo "$pid"; return 0; }
  # Tier 3: /proc scan
  local known=" ${NGINX_PID:-0} ${TTYD_PID:-0} ${GW_RELAY_PID:-0} ${GW_PID:-0} $$ "
  for f in /proc/[0-9]*/cmdline; do
    [ -r "$f" ] || continue
    if tr '\0' ' ' < "$f" 2>/dev/null | grep -q "openclaw"; then
      cand="${f#/proc/}"; cand="${cand%%/*}"
      case "$known" in *" $cand "*) continue ;; esac
      echo "$cand"; return 0
    fi
  done
  return 1
}

echo "INFO: Section 18 done (gateway start functions defined)"

# ------------------------------------------------------------------------------
# Section 19: Graceful Shutdown Handler
# ------------------------------------------------------------------------------
GW_PID=""
GW_RELAY_PID=""
NGINX_PID=""
TTYD_PID=""
SHUTTING_DOWN="false"

shutdown() {
  SHUTTING_DOWN="true"
  echo "INFO: Shutdown requested; stopping services..."
  for pid_var in NGINX_PID TTYD_PID GW_PID; do
    local pid="${!pid_var}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  stop_gw_relay
  if [ "$CLEAN_LOCKS_ON_EXIT" = "true" ]; then
    cleanup_session_locks || true
  fi
}
trap shutdown INT TERM

echo "INFO: Section 19 done (shutdown handler)"

# ------------------------------------------------------------------------------
# Section 20: Start Gateway
# ------------------------------------------------------------------------------
if ! start_openclaw_runtime; then
  echo "ERROR: Failed to start OpenClaw runtime"
  exit 1
fi

# Wait for gateway to actually bind the port before proceeding to Nginx/ttyd
echo "INFO: Waiting for gateway to bind port ${GATEWAY_INTERNAL_PORT}..."
MAX_WAIT=30
COUNT=0
while ! ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_INTERNAL_PORT} "; do
  [ "$COUNT" -ge "$MAX_WAIT" ] && { echo "WARN: Gateway took too long to bind port; proceeding anyway"; break; }
  sleep 1
  COUNT=$((COUNT + 1))
done
echo "INFO: Gateway port bound."

start_gw_relay
echo "INFO: Section 20 done (gateway started, PID=$GW_PID)"

# ------------------------------------------------------------------------------
# Section 21: Start Web Terminal (ttyd)
# ------------------------------------------------------------------------------
TTYD_PID_FILE="/var/run/openclaw-ttyd.pid"
if [ -f "$TTYD_PID_FILE" ]; then
  OLD_PID=$(cat "$TTYD_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true; sleep 1; kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$TTYD_PID_FILE"
fi

if [ "$ENABLE_TERMINAL" = "true" ] || [ "$ENABLE_TERMINAL" = "1" ]; then
  if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${TERMINAL_PORT} "; then
    echo "WARN: terminal_port ${TERMINAL_PORT} already in use!"
  fi
  ttyd -W -i 127.0.0.1 -p "${TERMINAL_PORT}" -b /terminal bash &
  TTYD_PID=$!
  echo "$TTYD_PID" > "$TTYD_PID_FILE"
  echo "INFO: ttyd started (PID $TTYD_PID, port $TERMINAL_PORT)"
else
  echo "INFO: Terminal disabled"
fi

echo "INFO: Section 21 done (ttyd)"

# ------------------------------------------------------------------------------
# Section 22: Ingress Reverse Proxy (nginx)
# ------------------------------------------------------------------------------
NGINX_PID_FILE="/var/run/openclaw-nginx.pid"
if [ -f "$NGINX_PID_FILE" ]; then
  OLD_NGINX_PID=$(cat "$NGINX_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_NGINX_PID" ] && kill -0 "$OLD_NGINX_PID" 2>/dev/null; then
    kill "$OLD_NGINX_PID" 2>/dev/null || true; sleep 1; kill -9 "$OLD_NGINX_PID" 2>/dev/null || true
  fi
  rm -f "$NGINX_PID_FILE"
fi

if command -v pkill >/dev/null 2>&1; then
  pkill -f "nginx.*-c /etc/nginx/nginx.conf" 2>/dev/null || true; sleep 1
fi

if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ':48099 '; then
  echo "WARN: Port 48099 still in use; nginx may fail"
fi

# Helper function: render landing page + nginx config
render_landing() {
  local label="${1:-startup}"
  local token=""
  token="$(python3 -c "import json,sys; p=sys.argv[1]; print(json.load(open(p)).get('gateway',{}).get('auth',{}).get('token',''), end='')" "$OPENCLAW_CONFIG_PATH" 2>/dev/null || true)"

  local disk_info=""
  if df -h /config >/dev/null 2>&1; then
    disk_info="$(df -h /config | awk 'NR==2{print $3"/"$2" ("$5" used, "$4" free)"}')"
    if [ "$label" = "startup" ]; then
      echo "INFO: Disk usage: $disk_info"
    fi
  fi

  GW_PUBLIC_URL="$GW_PUBLIC_URL" GW_TOKEN="$token" TERMINAL_PORT="$TERMINAL_PORT" \
    ENABLE_HTTPS_PROXY="$ENABLE_HTTPS_PROXY" HTTPS_PROXY_PORT="$GATEWAY_PORT" \
    GATEWAY_INTERNAL_PORT="$GATEWAY_INTERNAL_PORT" ACCESS_MODE="$ACCESS_MODE" \
    NGINX_LOG_LEVEL="$NGINX_LOG_LEVEL" \
    python3 /render_nginx.py

  if [ "$label" != "startup" ]; then
    local nginx_pid
    nginx_pid="$(cat "${NGINX_PID_FILE:-/var/run/openclaw-nginx.pid}" 2>/dev/null || true)"
    if [ -n "$nginx_pid" ] && kill -0 "$nginx_pid" 2>/dev/null; then
      kill -HUP "$nginx_pid" 2>/dev/null || true
      echo "INFO: Landing page re-rendered (nginx reloaded)"
    fi
  fi
}

# Initial render
render_landing startup
echo "INFO: Starting ingress proxy (nginx) on :48099 ..."
nginx -g 'daemon off;' &
NGINX_PID=$!
NGINX_PORT=48099
sleep 1
if kill -0 "$NGINX_PID" 2>/dev/null; then
  echo "$NGINX_PID" > "$NGINX_PID_FILE"
  echo "INFO: nginx started (PID $NGINX_PID)"
else
  echo "WARN: nginx failed to start"
fi

echo "INFO: Section 22 done (nginx started)"

# ------------------------------------------------------------------------------
# Section 23: mDNS / Avahi Configuration (EXCLUSIVE MODES)
# ------------------------------------------------------------------------------
# STRICT EXCLUSIVITY: Only ONE mDNS mechanism can be active at a time
# - off: nothing runs
# - minimal/full: ONLY Gateway internal mDNS mode (no Avahi, no D-Bus)
# - avahi: ONLY Avahi daemon + D-Bus (Gateway mDNS explicitly OFF)
# ------------------------------------------------------------------------------

# Determine hostname for mDNS (used by both Gateway and Avahi modes)
# Priority: user-provided mdns_host_name > container hostname
if [ -n "$MDNS_HOST_NAME" ]; then
  # Use user-provided hostname
  MDNS_HOSTNAME="$MDNS_HOST_NAME"
else
  # Auto-detect from container hostname (NO random generation, NO sanitization)
  MDNS_HOSTNAME=$(hostname 2>/dev/null || echo "openclaw")
fi
# Ensure .local suffix
MDNS_HOSTNAME="${MDNS_HOSTNAME}.local"

# Add .local entry to avahi hosts file (used by Avahi mode)
MDNS_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$MDNS_LAN_IP" ] && [ -n "$MDNS_HOSTNAME" ]; then
  mkdir -p /etc/avahi
  # Update hosts file (replace existing entry for this hostname)
  if grep -q "$MDNS_HOSTNAME" /etc/avahi/hosts 2>/dev/null; then
    sed -i "s/^.*$MDNS_HOSTNAME.*$/$MDNS_LAN_IP $MDNS_HOSTNAME/" /etc/avahi/hosts
  else
    echo "$MDNS_LAN_IP $MDNS_HOSTNAME" >> /etc/avahi/hosts
  fi
  echo "INFO: Hostname set to $MDNS_HOSTNAME for mDNS (IP: $MDNS_LAN_IP)"
fi

# EXCLUSIVE MODE HANDLING
case "$MDNS_MODE" in
  off)
    # MODE 1: OFF - Nothing runs
    echo "INFO: mDNS mode is OFF - no mDNS services active"
    
    # Ensure Gateway mDNS is explicitly disabled
    if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
      python3 "$HELPER_PATH" set-mdns-settings "off" 0 "" 2>/dev/null || true
    fi
    ;;
    
  minimal|full)
    # MODE 2: GATEWAY INTERNAL ONLY - No Avahi, no D-Bus
    echo "INFO: mDNS mode is $MDNS_MODE - using Gateway internal mDNS only (Avahi disabled)"
    
    # Configure Gateway internal mDNS mode
    MDNS_HOSTNAME_FOR_OC="${MDNS_HOSTNAME%.local}"
    MDNS_PORT="${MDNS_SERVICE_PORT:-$GATEWAY_PORT}"
    if [ "$ENABLE_HTTPS_PROXY" = "true" ]; then
      MDNS_PORT="$GATEWAY_PORT"
      echo "INFO: mDNS advertising public HTTPS port $MDNS_PORT"
    fi
    
    if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
      if python3 "$HELPER_PATH" set-mdns-settings "$MDNS_MODE" "$MDNS_PORT" "$MDNS_HOSTNAME_FOR_OC" 2>/dev/null; then
        echo "INFO: Gateway mDNS configured (mode=$MDNS_MODE, port=$MDNS_PORT, host=$MDNS_HOSTNAME_FOR_OC)"
      else
        echo "WARN: Gateway mDNS configuration via helper failed"
      fi
    else
      echo "WARN: oc_config_helper.py not found; skipping mDNS config"
    fi
    ;;
    
  avahi)
    # MODE 3: AVAHI ONLY - Avahi + D-Bus, Gateway mDNS OFF
    echo "INFO: mDNS mode is avahi - using Avahi daemon only (Gateway mDNS disabled)"
    
    # Ensure Gateway mDNS is explicitly OFF to prevent collisions
    if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
      python3 "$HELPER_PATH" set-mdns-settings "off" 0 "" 2>/dev/null || true
      echo "INFO: Gateway mDNS explicitly disabled (collision prevention)"
    fi
    
    # Start D-Bus system bus (required by avahi-daemon in containers)
    if ! pgrep dbus-daemon >/dev/null 2>&1; then
      if command -v dbus-daemon >/dev/null 2>&1; then
        mkdir -p /run/dbus
        # IMPORTANT: chmod 777 required because dbus-daemon runs as 'message+' user
        chmod 777 /run/dbus 2>/dev/null || true
        # Clean up stale pid file and socket from previous runs
        rm -f /run/dbus/pid /run/dbus/system_bus_socket 2>/dev/null || true
        rm -f /home/linuxbrew/.linuxbrew/var/run/dbus/pid /home/linuxbrew/.linuxbrew/var/run/dbus/system_bus_socket 2>/dev/null || true
        # IMPORTANT: Create Homebrew dbus path (required by Homebrew dbus config)
        mkdir -p /home/linuxbrew/.linuxbrew/var/run/dbus 2>/dev/null || true
        chown messagebus:messagebus /home/linuxbrew/.linuxbrew/var/run/dbus 2>/dev/null || true
        chmod 755 /home/linuxbrew/.linuxbrew/var/run/dbus 2>/dev/null || true
        # IMPORTANT: Create custom dbus config to override Homebrew defaults
        # (Homebrew dbus config uses /home/linuxbrew/.linuxbrew/var/run/dbus/)
        mkdir -p /etc/dbus-1 2>/dev/null || true
        # IMPORTANT: Always overwrite existing config to avoid syntax errors
        cat > /etc/dbus-1/system.conf << 'DBUS_CONF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>system</type>
  <user>messagebus</user>
  <fork/>
  <pidfile>/run/dbus/pid</pidfile>
  <listen>unix:path=/run/dbus/system_bus_socket</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow user="*"/>
    <deny own="*"/>
    <!-- FIXED: Allow method_call for Avahi and other services -->
    <allow send_type="method_call"/>
    <allow send_type="signal"/>
    <allow send_requested_reply="true" send_type="method_return"/>
    <allow send_requested_reply="true" send_type="error"/>
    <allow receive_type="method_call"/>
    <allow receive_type="method_return"/>
    <allow receive_type="error"/>
    <allow receive_type="signal"/>
    <allow send_destination="org.freedesktop.DBus" send_interface="org.freedesktop.DBus" />
  </policy>
</busconfig>
DBUS_CONF
        # Start dbus-daemon with custom config
        dbus-daemon --system --fork 2>&1 || echo "WARN: dbus-daemon failed to start"
        # Wait for D-Bus socket to be available (up to 5 seconds)
        for _i in $(seq 1 10); do
          if [ -S /run/dbus/system_bus_socket ]; then
            echo "INFO: D-Bus system bus started"
            break
          fi
          sleep 0.5
        done
        if [ ! -S /run/dbus/system_bus_socket ]; then
          echo "WARN: D-Bus socket not found after start (avahi may fail)"
        fi
      else
        echo "WARN: dbus-daemon not installed; avahi may fail to start"
      fi
    else
      echo "INFO: D-Bus system bus already running"
    fi
    
    # Start avahi-daemon
    if command -v avahi-daemon >/dev/null 2>&1; then
      if ! pgrep avahi-daemon >/dev/null 2>&1; then
        echo "INFO: Starting avahi-daemon for mDNS discovery..."
        # Ensure avahi socket dir exists with correct permissions
        mkdir -p /run/avahi-daemon 2>/dev/null || true
        chmod 777 /run/avahi-daemon 2>/dev/null || true
        # Clean up stale pid file
        rm -f /run/avahi-daemon/pid 2>/dev/null || true
        # Generate minimal avahi config if missing
        if [ ! -f /etc/avahi/avahi-daemon.conf ]; then
          mkdir -p /etc/avahi
          cat > /etc/avahi/avahi-daemon.conf << 'AVAHI_CONF'
[server]
use-ipv4=yes
use-ipv6=no
disallow-other-stacks=yes
host-name=auto

[wide-area]
enable-wide-area=no

[publish]
publish-hinfo=no
publish-addresses=yes
publish-domain=yes
publish-workstation=no
AVAHI_CONF
        fi
        # Start avahi-daemon with --no-drop-root (required in containers)
        # and --no-chroot to avoid chroot issues
        avahi-daemon -D --no-drop-root --no-chroot 2>/dev/null || echo "WARN: avahi-daemon failed to start (mDNS may not work)"
        sleep 2
        if pgrep avahi-daemon >/dev/null 2>&1; then
          echo "INFO: avahi-daemon started successfully"
        else
          echo "WARN: avahi-daemon not running after start attempt"
        fi
      else
        echo "INFO: avahi-daemon already running"
      fi
    else
      echo "WARN: avahi-daemon not installed — mDNS will not work. Install avahi-daemon in the Dockerfile."
    fi
    ;;
    
  *)
    echo "WARN: Unknown mdns_mode '$MDNS_MODE' - treating as OFF"
    ;;

esac

echo "INFO: Section 23 done (mDNS/avahi - exclusive mode: $MDNS_MODE)"
# ------------------------------------------------------------------------------
# Section 24: Background Token Re-render
# ------------------------------------------------------------------------------
(
  CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/config/.openclaw/openclaw.json}"
  for _i in $(seq 1 24); do
    sleep 5
    token="$(python3 -c 'import json,sys; p=sys.argv[1]; print(json.load(open(p)).get("gateway",{}).get("auth",{}).get("token",""), end="")' "$CONFIG_PATH" 2>/dev/null || true)"
    [ -n "$token" ] && { render_landing post-onboard; break; }
  done
) &

echo "INFO: Section 24 done (background token re-render)"

GW_IS_CHILD=true
GW_RESTART_COUNT=0
GW_MAX_BACKOFF=120  # max seconds between restarts

while true; do
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

  RESTARTED_PID=""
  if [ "$GATEWAY_MODE" != "remote" ]; then
    for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      RESTARTED_PID=$(find_gateway_daemon_pid 2>/dev/null || true)
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
    GW_RESTART_COUNT=0  # reset on successful detection
    continue
  fi

  # Final port guard
  if [ "$GATEWAY_MODE" != "remote" ]; then
    for _port_wait in 1 2 3 4 5 6 7 8 9 10; do
      ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_INTERNAL_PORT} " && break
      sleep 1
    done
    if ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_INTERNAL_PORT} "; then
      PORT_PID=$(ss -tlnp 2>/dev/null | grep ":${GATEWAY_INTERNAL_PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)
      echo "INFO: Gateway port $GATEWAY_INTERNAL_PORT occupied by PID ${PORT_PID:-unknown}; monitoring."
      GW_PID="${PORT_PID:-$GW_PID}"
      GW_IS_CHILD=false
      GW_RESTART_COUNT=0
      continue
    fi
  fi

  # Exponential backoff: 5s, 10s, 20s, 40s, 80s, 120s (max)
  GW_RESTART_COUNT=$((GW_RESTART_COUNT + 1))
  GW_BACKOFF=$(( 5 * (2 ** (GW_RESTART_COUNT - 1)) ))
  [ "$GW_BACKOFF" -gt "$GW_MAX_BACKOFF" ] && GW_BACKOFF=$GW_MAX_BACKOFF

  echo "WARN: OpenClaw runtime exited (code $GW_EXIT_CODE); restart #$GW_RESTART_COUNT in ${GW_BACKOFF}s (exponential backoff)"
  sleep "$GW_BACKOFF"
  stop_gw_relay
  if ! start_openclaw_runtime; then
    echo "ERROR: Failed to restart (attempt #$GW_RESTART_COUNT)"
  else
    GW_IS_CHILD=true
    start_gw_relay
  fi
done

echo "INFO: Supervisor loop exited (shutdown requested)"

# Final cleanup
if [ "$CLEAN_LOCKS_ON_EXIT" = "true" ]; then
  cleanup_session_locks || true
fi
stop_gw_relay

if [ -f "$STARTUP_LOCK" ]; then
  rm -f "$STARTUP_LOCK"
fi

echo "=== RUN.SH END: $(date -Iseconds) ==="
exit 0
