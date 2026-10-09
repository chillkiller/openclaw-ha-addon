#!/usr/bin/env bash
set -euo pipefail

# Ensure Homebrew and brew-installed binaries are in PATH
# This is needed for OpenClaw skills that depend on CLI tools (gemini, aider, etc.)
export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Home Assistant app options are usually rendered to /data/options.json
OPTIONS_FILE="/data/options.json"

if [ ! -f "$OPTIONS_FILE" ]; then
  echo "Missing $OPTIONS_FILE (app options)."
  exit 1
fi

# ------------------------------------------------------------------------------
# Read app options (only app-specific knobs; OpenClaw is configured via onboarding)
# ------------------------------------------------------------------------------

TZNAME=$(jq -r '.timezone // "Europe/Sofia"' "$OPTIONS_FILE")
GW_PUBLIC_URL=$(jq -r '.gateway_public_url // empty' "$OPTIONS_FILE")
HA_TOKEN=$(jq -r '.homeassistant_token // empty' "$OPTIONS_FILE")
ADDON_HTTP_PROXY=$(jq -r '.http_proxy // empty' "$OPTIONS_FILE")
ENABLE_TERMINAL=$(jq -r 'if has("enable_terminal") then (.enable_terminal|tostring) else "true" end' "$OPTIONS_FILE")
TERMINAL_PORT_RAW=$(jq -r '.terminal_port // 7681' "$OPTIONS_FILE")
ENABLE_WEBUI=$(jq -r 'if has("enable_webui") then (.enable_webui|tostring) else "true" end' "$OPTIONS_FILE")
ENABLE_DOCS=$(jq -r 'if has("enable_docs") then (.enable_docs|tostring) else "true" end' "$OPTIONS_FILE")

# SECURITY: Validate TERMINAL_PORT to prevent nginx config injection
# Only allow numeric values in valid port range (1024-65535)
if [[ "$TERMINAL_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$TERMINAL_PORT_RAW" -ge 1024 ] && [ "$TERMINAL_PORT_RAW" -le 65535 ]; then
  TERMINAL_PORT="$TERMINAL_PORT_RAW"
else
  echo "ERROR: Invalid terminal_port '$TERMINAL_PORT_RAW'. Must be numeric 1024-65535. Using default 7681."
  TERMINAL_PORT="7681"
fi

echo "DEBUG: enable_terminal config value: '$ENABLE_TERMINAL'"
echo "DEBUG: terminal_port config value: '$TERMINAL_PORT' (validated)"

# Generic router SSH settings

# Optional: allow disabling lock cleanup if you ever need to debug

# Gateway configuration
GATEWAY_MODE=$(jq -r '.gateway_mode // "local"' "$OPTIONS_FILE")
GATEWAY_REMOTE_URL=$(jq -r '.gateway_remote_url // empty' "$OPTIONS_FILE")
NETWORK_MODE=$(jq -r '.network_mode // "ingress_only"' "$OPTIONS_FILE")
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")
ENABLE_OPENAI_API=$(jq -r '.enable_openai_api // false' "$OPTIONS_FILE")
GATEWAY_TRUSTED_PROXIES=$(jq -r '.gateway_trusted_proxies // empty' "$OPTIONS_FILE")
GATEWAY_ADDITIONAL_ALLOWED_ORIGINS=$(jq -r '.gateway_additional_allowed_origins // empty' "$OPTIONS_FILE")
CONTROLUI_DISABLE_DEVICE_AUTH=$(jq -r 'if has("controlui_disable_device_auth") then (.controlui_disable_device_auth|tostring) else "true" end' "$OPTIONS_FILE")
FORCE_IPV4_DNS=$(jq -r 'if has("force_ipv4_dns") then (.force_ipv4_dns|tostring) else "true" end' "$OPTIONS_FILE")
NGINX_LOG_LEVEL=$(jq -r '.nginx_log_level // "minimal"' "$OPTIONS_FILE")
AUTO_CONFIGURE_MCP=$(jq -r '.auto_configure_mcp // false' "$OPTIONS_FILE")
GW_ENV_VARS_TYPE=$(jq -r 'if .gateway_env_vars == null then "null" else (.gateway_env_vars | type) end' "$OPTIONS_FILE")
GW_ENV_VARS_RAW=$(jq -r '.gateway_env_vars // empty' "$OPTIONS_FILE")
GW_ENV_VARS_JSON=$(jq -c '.gateway_env_vars // []' "$OPTIONS_FILE")

# mDNS configuration (OpenClaw native bonjour plugin)
MDNS_MODE=$(jq -r '.mdns_mode // "minimal"' "$OPTIONS_FILE")
MDNS_HOST_NAME=$(jq -r '.mdns_host_name // "openclaw"' "$OPTIONS_FILE")

# Gateway logging
GATEWAY_LOG_TO_CONSOLE=$(jq -r '.gateway_log_to_console // false' "$OPTIONS_FILE")
GATEWAY_LOG_LEVEL=$(jq -r '.gateway_log_level // "info"' "$OPTIONS_FILE")
TRACE_LOG_TO_CONSOLE=$(jq -r '.trace_log_to_console // false' "$OPTIONS_FILE")

# Ollama base URL forwarded to ACPX harness wrappers. Used when no real
# ANTHROPIC_API_KEY / OPENAI_API_KEY is present in the environment, so the
# claude / codex / opencode harnesses can talk to a remote Ollama instance.
OLLAMA_BASE_URL=$(jq -r '.ollama_base_url // "http://localhost:11434"' "$OPTIONS_FILE")
export OLLAMA_BASE_URL


# Runtime extensibility (was defined in config.yaml but never read — Audit R5/R6)
RUNTIME_APT_PACKAGES=$(jq -r '.runtime_apt_packages // empty' "$OPTIONS_FILE")
CUSTOM_INIT_SCRIPT=$(jq -r '.custom_init_script // empty' "$OPTIONS_FILE")

# OpenClaw 2026.9.1 configuration controls
BLOCKED_HOSTNAMES=$(jq -r '.blocked_hostnames // empty' "$OPTIONS_FILE")

# --- v0.7.13 safety-net options (jq has-guard per V7 pattern: explicit false wins) ---
ABORT_ON_UPGRADE_BACKUP_FAILURE=$(jq -r 'if has("abort_on_upgrade_backup_failure") then (.abort_on_upgrade_backup_failure|tostring) else "true" end' "$OPTIONS_FILE")
UPGRADE_BACKUP_KEEP=$(jq -r 'if has("upgrade_backup_keep") then (.upgrade_backup_keep|number) else 3 end' "$OPTIONS_FILE")
GW_DOCTOR_REPAIR_MAX=$(jq -r 'if has("gateway_doctor_repair_max") then (.gateway_doctor_repair_max|number) else 3 end' "$OPTIONS_FILE")

# ACPX harnesses (Claude Code, Codex, OpenCode)
ACPX_ENABLED=$(jq -r 'if has("acpx_enabled") then (.acpx_enabled|tostring) else "true" end' "$OPTIONS_FILE")

export TZ="$TZNAME"

# -----------------------------------------------------------------------------
# Network mode presets — map app UI to OpenClaw-native config
# -----------------------------------------------------------------------------
GATEWAY_BIND="loopback"
GATEWAY_AUTH_MODE="token"
GATEWAY_TLS_ENABLED="false"
GATEWAY_TLS_AUTO="false"
TAILSCALE_MODE=""
GATEWAY_INTERNAL_PORT="$GATEWAY_PORT"
ENABLE_HTTPS_PROXY=false
HTTPS_PROXY_PORT=""

case "$NETWORK_MODE" in
  ingress_only)
    GATEWAY_BIND="loopback"
    GATEWAY_AUTH_MODE="token"
    GATEWAY_TLS_ENABLED="false"
    echo "INFO: Network mode: ingress_only (loopback + token, Ingress/terminal only)"
    ;;
  lan_http)
    GATEWAY_BIND="lan"
    GATEWAY_AUTH_MODE="token"
    GATEWAY_TLS_ENABLED="false"
    echo "INFO: Network mode: lan_http (LAN HTTP on 0.0.0.0:${GATEWAY_PORT})"
    ;;
  lan_https)
    # OpenClaw gateway runs HTTP on loopback internal port; nginx provides external HTTPS.
    GATEWAY_BIND="loopback"
    GATEWAY_AUTH_MODE="token"
    GATEWAY_TLS_ENABLED="false"
    GATEWAY_INTERNAL_PORT=$((GATEWAY_PORT + 1))
    ENABLE_HTTPS_PROXY=true
    HTTPS_PROXY_PORT="$GATEWAY_PORT"
    echo "INFO: Network mode: lan_https (HTTPS proxy on 0.0.0.0:${GATEWAY_PORT}, gateway loopback on :${GATEWAY_INTERNAL_PORT})"
    ;;
  tailnet_serve)
    GATEWAY_BIND="loopback"
    GATEWAY_AUTH_MODE="token"
    GATEWAY_TLS_ENABLED="true"
    GATEWAY_TLS_AUTO="true"
    TAILSCALE_MODE="serve"
    echo "INFO: Network mode: tailnet_serve (Tailscale serve HTTPS)"
    ;;
  tailnet_funnel)
    GATEWAY_BIND="loopback"
    GATEWAY_AUTH_MODE="password"
    GATEWAY_TLS_ENABLED="true"
    GATEWAY_TLS_AUTO="true"
    TAILSCALE_MODE="funnel"
    echo "INFO: Network mode: tailnet_funnel (Tailscale funnel HTTPS)"
    ;;
  reverse_proxy)
    GATEWAY_BIND="loopback"
    GATEWAY_AUTH_MODE="trusted-proxy"
    GATEWAY_TLS_ENABLED="false"
    if [ -z "$GATEWAY_TRUSTED_PROXIES" ]; then
      echo "ERROR: network_mode=reverse_proxy requires gateway_trusted_proxies."
      echo "ERROR: Set it to your reverse proxy's IP/CIDR (e.g. 127.0.0.1,192.168.88.0/24)."
      exit 1
    fi
    echo "INFO: Network mode: reverse_proxy (loopback + trusted-proxy)"
    ;;
  *)
    echo "WARN: Unknown network_mode '$NETWORK_MODE', falling back to ingress_only"
    NETWORK_MODE="ingress_only"
    GATEWAY_BIND="loopback"
    GATEWAY_AUTH_MODE="token"
    GATEWAY_TLS_ENABLED="false"
    ;;
esac

export NETWORK_MODE
export ACCESS_MODE="$NETWORK_MODE"
export GATEWAY_BIND
export GATEWAY_AUTH_MODE
export GATEWAY_TLS_ENABLED
export GATEWAY_TLS_AUTO
export TAILSCALE_MODE
export GATEWAY_INTERNAL_PORT
export ENABLE_HTTPS_PROXY
export HTTPS_PROXY_PORT

# Export mDNS hostname to OpenClaw's bundled bonjour plugin
# Sanitize: strip .local suffix, keep valid DNS labels only
MDNS_HOSTNAME_CLEAN="$(printf '%s' "$MDNS_HOST_NAME" | sed 's/\.local$//; s/[^a-zA-Z0-9-]//g; s/^-*//; s/-*$//')"
if [ -n "$MDNS_HOSTNAME_CLEAN" ]; then
  export OPENCLAW_MDNS_HOSTNAME="$MDNS_HOSTNAME_CLEAN"
  echo "INFO: mDNS hostname set to: ${MDNS_HOSTNAME_CLEAN}.local"
else
  export OPENCLAW_MDNS_HOSTNAME="openclaw"
  echo "INFO: mDNS hostname defaulted to: openclaw.local"
fi

# Attempt to set the container hostname to the mDNS name so that
# auto-generated TLS certificates include it as a SAN.
if [ -n "$MDNS_HOSTNAME_CLEAN" ] && command -v hostname >/dev/null 2>&1; then
  hostname "$MDNS_HOSTNAME_CLEAN" 2>/dev/null || echo "WARN: Could not set container hostname to $MDNS_HOSTNAME_CLEAN (non-critical)"
fi

# Reduce risk of secrets ending up in logs
set +x

# Optional outbound proxy from app settings.
# If set, apply it to both HTTP and HTTPS for Node/undici/OpenClaw tooling.
if [ -n "$ADDON_HTTP_PROXY" ]; then
  if [[ "$ADDON_HTTP_PROXY" =~ ^https?://[^[:space:]]+$ ]]; then
    # Keep local traffic direct to avoid accidental proxying of loopback/LAN services.
    DEFAULT_NO_PROXY="localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.local"

    export HTTP_PROXY="$ADDON_HTTP_PROXY"
    export HTTPS_PROXY="$ADDON_HTTP_PROXY"
    export http_proxy="$ADDON_HTTP_PROXY"
    export https_proxy="$ADDON_HTTP_PROXY"
    export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${DEFAULT_NO_PROXY}"
    export no_proxy="${no_proxy:+${no_proxy},}${DEFAULT_NO_PROXY}"
    echo "INFO: Outbound HTTP/HTTPS proxy enabled from app configuration."
    echo "INFO: Applied NO_PROXY defaults for localhost/private network ranges."
  else
    echo "WARN: Invalid http_proxy value in app options; expected URL like http://host:port"
  fi
fi

# ------------------------------------------------------------------------------
# Node.js heap budget — RAM-adaptive (0.7.12.4). OpenClaw derives its internal
# memory-pressure warning threshold from the heap limit (dist-verified:
# rssWarningBytes = max(1536 MB, heapLimit * 0.5)). A static 4096 on a host with
# 12+ GB RAM put the Gateway's normal working set (~2.2-2.4 GiB with 13-14
# workers) permanently above that threshold, causing cooperative yields that
# stalled sessions.list for seconds. Sizing the heap by host RAM keeps the
# threshold above the working set.
# ------------------------------------------------------------------------------
TOTAL_MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$TOTAL_MEM_MB" -ge 24576 ]; then
  NODE_HEAP_MB=8192
elif [ "$TOTAL_MEM_MB" -ge 12288 ]; then
  NODE_HEAP_MB=6144
elif [ "$TOTAL_MEM_MB" -ge 8192 ]; then
  NODE_HEAP_MB=4096
else
  NODE_HEAP_MB=2048
fi
if [ -z "${NODE_OPTIONS:-}" ]; then
  # 0.7.12.5-hotfix (2026-10-05): preload undefined-rejection shim BEFORE openclaw modules
  export NODE_OPTIONS="--require /app/undefined-rejection-shim.cjs --max-old-space-size=${NODE_HEAP_MB}"
else
  # Preserve existing NODE_OPTIONS but ensure memory limit is set
  if [[ ! "$NODE_OPTIONS" =~ --max-old-space-size ]]; then
    # 0.7.12.5-hotfix (2026-10-05): preload undefined-rejection shim BEFORE openclaw modules
    export NODE_OPTIONS="--require /app/undefined-rejection-shim.cjs --max-old-space-size=${NODE_HEAP_MB} ${NODE_OPTIONS}"
  fi
fi
echo "INFO: Node.js memory limit set to ${NODE_HEAP_MB}MB (host RAM: ${TOTAL_MEM_MB}MB)"

# Optional network hardening/workaround: force IPv4-first DNS ordering for Node.js.
# Helps in environments where IPv6 resolves but has no working egress.
if [ "$FORCE_IPV4_DNS" = "true" ] || [ "$FORCE_IPV4_DNS" = "1" ]; then
  if [[ ! "${NODE_OPTIONS:-}" =~ --dns-result-order ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS} --dns-result-order=ipv4first"
  fi
  echo "INFO: Enabled IPv4-first DNS ordering (NODE_OPTIONS=--dns-result-order=ipv4first)"
fi

# HA apps mount persistent storage at /config (maps to /addon_configs/<slug> on the host).
export HOME=/config

# Explicitly set OpenClaw directories to ensure they persist across app updates
# This prevents loss of installed skills, configuration, and workspace state
export OPENCLAW_CONFIG_DIR=/config/.openclaw
export OPENCLAW_WORKSPACE_DIR=/config/clawd
export XDG_CONFIG_HOME=/config

mkdir -p /config/.openclaw /config/.openclaw/identity /config/clawd /config/keys /config/secrets

# ------------------------------------------------------------------------------
# Sync built-in OpenClaw skills from image to persistent storage
# On each startup, copy new/updated built-in skills so they survive rebuilds.
# We sync them to /config/.openclaw/skills and symlink back.
# NOTE: We cannot use `npm root -g` here because HOME=/config may contain a
# persisted .npmrc with a custom prefix from a previous run. Instead, we
# resolve the real image path by temporarily overriding HOME.
# ------------------------------------------------------------------------------
IMAGE_SKILLS_DIR="$(HOME=/root npm root -g 2>/dev/null)/openclaw/skills"
PERSISTENT_SKILLS_DIR="/config/.openclaw/skills"

if [ -d "$IMAGE_SKILLS_DIR" ] && [ ! -L "$IMAGE_SKILLS_DIR" ]; then
  mkdir -p "$PERSISTENT_SKILLS_DIR"
  # Sync skills: --update replaces older files so upgrades propagate,
  # but doesn't delete user-added files in persistent storage.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --update "$IMAGE_SKILLS_DIR/" "$PERSISTENT_SKILLS_DIR/" 2>/dev/null || true
  else
    cp -ru "$IMAGE_SKILLS_DIR/"* "$PERSISTENT_SKILLS_DIR/" 2>/dev/null || true
  fi
  # Replace image skills dir with symlink to persistent copy
  rm -rf "$IMAGE_SKILLS_DIR"
  ln -sf "$PERSISTENT_SKILLS_DIR" "$IMAGE_SKILLS_DIR"
  echo "INFO: Synced built-in skills to persistent storage at $PERSISTENT_SKILLS_DIR"
elif [ -L "$IMAGE_SKILLS_DIR" ]; then
  echo "INFO: Built-in skills already linked to persistent storage"
else
  echo "WARN: Built-in skills directory not found at $IMAGE_SKILLS_DIR"
fi

# ------------------------------------------------------------------------------
# Persist user-installed node skills across Docker image rebuilds
# Redirect npm/pnpm global installs to /config/.node_global (persistent storage)
# so that skills installed via the dashboard survive container rebuilds.
# NOTE: This MUST come after the skills sync above (which needs the original npm root -g).
# ------------------------------------------------------------------------------
PERSISTENT_NODE_GLOBAL="/config/.node_global"
mkdir -p "$PERSISTENT_NODE_GLOBAL"
npm config set prefix "$PERSISTENT_NODE_GLOBAL" 2>/dev/null || true
export PATH="${PERSISTENT_NODE_GLOBAL}/bin:${PATH}"
export NODE_PATH="${PERSISTENT_NODE_GLOBAL}/lib/node_modules:${NODE_PATH:-}"

# Also configure pnpm global dir to persistent storage
export PNPM_HOME="${PERSISTENT_NODE_GLOBAL}/pnpm"
mkdir -p "$PNPM_HOME"
export PATH="${PNPM_HOME}:${PATH}"

# Protect critical runtime variables from accidental override via gateway_env_vars.
is_reserved_gateway_env_var() {
  case "$1" in
    # Critical runtime paths/process vars.
    HOME|PATH|PWD|OLDPWD|SHLVL|TZ|XDG_CONFIG_HOME|PNPM_HOME|NODE_PATH|NODE_OPTIONS|NODE_NO_WARNINGS)
      return 0
      ;;
    # Low-level injection vectors that can alter process/linker/shell behavior.
    LD_*|DYLD_*|BASH_ENV|ENV|BASH_FUNC_*)
      return 0
      ;;
    # Proxy vars managed by app options.
    HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)
      return 0
      ;;
    # App internal control vars.
    OPENCLAW_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

try_export_gateway_env_var() {
  local key="$1"
  local value="$2"

  if [ -z "$key" ]; then
    return 0
  fi

  # Validate variable name format
  if ! [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "WARN: Invalid environment variable name: '$key' (must start with letter/underscore, skip)"
    return 0
  fi

  # Protect critical runtime variables from accidental override.
  if is_reserved_gateway_env_var "$key"; then
    echo "WARN: Reserved environment variable '$key' cannot be overridden via gateway_env_vars (skip)"
    return 0
  fi

  # Enforce max variable name length
  if [ ${#key} -gt $max_var_name_size ]; then
    echo "WARN: Environment variable name too long: '$key' (max $max_var_name_size chars, skip)"
    return 0
  fi

  # Enforce max variable value length
  if [ ${#value} -gt $max_var_value_size ]; then
    echo "WARN: Environment variable value too long for '$key' (max $max_var_value_size chars, skip)"
    return 0
  fi

  # Enforce limit on number of variables
  if [ $env_count -ge $max_env_vars ]; then
    echo "WARN: Maximum environment variables limit ($max_env_vars) reached (skip)"
    return 0
  fi

  export "$key=$value"
  env_count=$((env_count + 1))
  echo "INFO: Exported gateway env var: $key"
}

# Export gateway environment variables from app config
# These are user-defined variables that should be available to the gateway process.
# Primary format: array of {name, value} objects.
if [ "$GW_ENV_VARS_TYPE" = "array" ] || [ "$GW_ENV_VARS_TYPE" = "object" ] || { [ "$GW_ENV_VARS_TYPE" = "string" ] && [ -n "$GW_ENV_VARS_RAW" ]; }; then
  env_count=0
  max_env_vars=50
  max_var_name_size=255
  max_var_value_size=10000

  if [ "$GW_ENV_VARS_TYPE" = "array" ] && [ "$GW_ENV_VARS_JSON" != "[]" ]; then
    echo "INFO: Setting gateway environment variables from list config..."

    invalid_entries_count=$(printf '%s' "$GW_ENV_VARS_JSON" | jq '[.[] | select((type != "object") or ((.name | type) != "string") or (has("value") | not))] | length')
    if [ "$invalid_entries_count" -gt 0 ]; then
      echo "WARN: Found $invalid_entries_count invalid gateway_env_vars entries; expected objects with 'name' and 'value' keys (skip)"
    fi

    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
      try_export_gateway_env_var "$key" "$value"
    done < <(printf '%s' "$GW_ENV_VARS_JSON" | jq -j '.[] | select((type == "object") and ((.name | type) == "string") and (has("value"))) | .name, "\u0000", (.value | tostring), "\u0000"')
  elif [ "$GW_ENV_VARS_TYPE" = "object" ] && [ "$GW_ENV_VARS_JSON" != "{}" ]; then
    # Backward compatibility for old map/object configuration.
    echo "INFO: Setting gateway environment variables from object config (legacy format)..."
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
      try_export_gateway_env_var "$key" "$value"
    done < <(printf '%s' "$GW_ENV_VARS_JSON" | jq -j 'to_entries[] | .key, "\u0000", (.value | tostring), "\u0000"')
  elif [ "$GW_ENV_VARS_TYPE" = "string" ] && [ -n "$GW_ENV_VARS_RAW" ]; then
    # Preferred for complex values: JSON object string in one line.
    if printf '%s' "$GW_ENV_VARS_RAW" | jq -e 'type == "object"' >/dev/null 2>&1; then
      echo "INFO: Setting gateway environment variables from JSON string config..."
      while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        try_export_gateway_env_var "$key" "$value"
      done < <(printf '%s' "$GW_ENV_VARS_RAW" | jq -j 'to_entries[] | .key, "\u0000", (.value | tostring), "\u0000"')
    else
      # Supported simple format: KEY=VALUE pairs separated by ';' or newlines.
      echo "INFO: Setting gateway environment variables from KEY=VALUE string config..."
      while IFS= read -r entry; do
        entry="${entry%$'\r'}"
        trimmed="$(printf '%s' "$entry" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"

        # Skip empty lines and comments.
        if [ -z "$trimmed" ] || [[ "$trimmed" == \#* ]]; then
          continue
        fi

        if [[ "$trimmed" != *"="* ]]; then
          echo "WARN: Invalid gateway_env_vars entry '$trimmed' (expected KEY=VALUE, skip)"
          continue
        fi

        key="${trimmed%%=*}"
        value="${trimmed#*=}"
        key="$(printf '%s' "$key" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"

        try_export_gateway_env_var "$key" "$value"
      done < <(printf '%s' "$GW_ENV_VARS_RAW" | tr ';' '\n')
    fi
  fi

  if [ $env_count -gt 0 ]; then
    echo "INFO: Successfully exported $env_count gateway environment variable(s)"
  fi
elif [ "$GW_ENV_VARS_TYPE" != "null" ]; then
  echo "WARN: Invalid gateway_env_vars format in app options (expected list, string or object), skipping"
fi

# ------------------------------------------------------------------------------
# Persist Linuxbrew/Homebrew across Docker image rebuilds
# Homebrew installs to /home/linuxbrew/.linuxbrew/ which is ephemeral.
# We sync it to /config/.linuxbrew and symlink back so brew-installed CLI
# tools (gog, gh, bw, etc.) survive app updates.
# ------------------------------------------------------------------------------
IMAGE_BREW_DIR="/home/linuxbrew/.linuxbrew"
PERSISTENT_BREW_DIR="/config/.linuxbrew"

if [ -d "$IMAGE_BREW_DIR" ] && [ ! -L "$IMAGE_BREW_DIR" ]; then
  # Image has a real Homebrew install — sync to persistent storage
  if [ -d "$PERSISTENT_BREW_DIR" ]; then
    # Persistent copy exists: sync new/updated files from image (upgrades),
    # but preserve user-installed packages already in persistent storage.
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --update "$IMAGE_BREW_DIR/" "$PERSISTENT_BREW_DIR/" 2>/dev/null || true
    else
      cp -ru "$IMAGE_BREW_DIR/"* "$PERSISTENT_BREW_DIR/" 2>/dev/null || true
    fi
    echo "INFO: Synced Homebrew updates to persistent storage"
  else
    # First time: copy entire Homebrew install to persistent storage
    cp -a "$IMAGE_BREW_DIR" "$PERSISTENT_BREW_DIR" 2>/dev/null || true
    echo "INFO: Copied Homebrew to persistent storage at $PERSISTENT_BREW_DIR"
  fi
  # Replace image dir with symlink to persistent copy
  rm -rf "$IMAGE_BREW_DIR"
  ln -sf "$PERSISTENT_BREW_DIR" "$IMAGE_BREW_DIR"
elif [ -L "$IMAGE_BREW_DIR" ]; then
  echo "INFO: Homebrew already linked to persistent storage"
elif [ -d "$PERSISTENT_BREW_DIR" ]; then
  # Image doesn't have Homebrew (failed install?) but persistent copy exists
  mkdir -p "$(dirname "$IMAGE_BREW_DIR")"
  ln -sf "$PERSISTENT_BREW_DIR" "$IMAGE_BREW_DIR"
  echo "INFO: Restored Homebrew symlink from persistent storage"
else
  echo "INFO: Homebrew not available (install may have failed during image build)"
fi

# Back-compat: some docs/scripts assume /data; point it at /config.
if [ ! -e /data ]; then
  ln -s /config /data || true
fi

# Ensure the agents base directory exists so cleanup scans work even before first run.
# Do NOT pre-create agent-specific directories; OpenClaw creates them as needed.
mkdir -p /config/.openclaw/agents || true

# ------------------------------------------------------------------------------
# SINGLE-INSTANCE GUARD (prevents multiple gateway runs racing each other)
# ------------------------------------------------------------------------------
STARTUP_LOCK="/config/.openclaw/gateway.start.lock"
exec 9>"$STARTUP_LOCK"
if ! flock -n 9; then
  echo "ERROR: Another instance appears to be running (could not acquire $STARTUP_LOCK)."
  echo "If this is wrong, check for stuck processes or remove the lock file."
  exit 1
fi

# ------------------------------------------------------------------------------
# Session lock cleanup helpers
# ------------------------------------------------------------------------------

gateway_running() {
  pgrep -f "openclaw-gateway" >/dev/null 2>&1
}

cleanup_session_locks() {
  local agents_dir="/config/.openclaw/agents"
  local total_locks=0
  local cleaned_dirs=()

  # Scan all agent session directories, not just 'main'.
  # This is needed for users who have gateway.forcedAgentId set to a non-default agent.
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

  if [ "$total_locks" -eq 0 ]; then
    return 0
  fi

  # If gateway is running, do NOT remove locks automatically (could be real).
  if gateway_running; then
    echo "INFO: Gateway appears to be running; leaving session lock files untouched."
    echo "INFO: Locks present: $total_locks"
    return 0
  fi

  echo "INFO: Removing stale session lock files ($total_locks) across agents: ${cleaned_dirs[*]}"
  for agent_sessions_dir in "${cleaned_dirs[@]}"; do
    rm -f "${agent_sessions_dir}"/*.jsonl.lock || true
  done
}

cleanup_session_locks # 0.7.12.4: always on — stale locks must never survive restarts

# ------------------------------------------------------------------------------
# Store tokens / export env vars (optional)
# ------------------------------------------------------------------------------

if [ -n "$HA_TOKEN" ]; then
  umask 077
  printf '%s' "$HA_TOKEN" > /config/secrets/homeassistant.token
fi


# ------------------------------------------------------------------------------
# OpenClaw config is managed by OpenClaw itself (onboarding / configure).
# This app intentionally does NOT create/patch /config/.openclaw/openclaw.json.
# ------------------------------------------------------------------------------

# Convenience info for later (router SSH access path & HA token file)
cat > /config/CONNECTION_NOTES.txt <<EOF
Home Assistant token (if set): /config/secrets/homeassistant.token
EOF


# ------------------------------------------------------------------------------
# Graceful shutdown handling (PID 1 trap) to reduce stale locks
# ------------------------------------------------------------------------------
GW_PID=""
GW_RELAY_PID=""
NGINX_PID=""
TTYD_PID=""
SHUTTING_DOWN="false"

shutdown() {
  SHUTTING_DOWN="true"
  echo "Shutdown requested; stopping services..."

  if [ -n "${NGINX_PID}" ] && kill -0 "${NGINX_PID}" >/dev/null 2>&1; then
    kill -TERM "${NGINX_PID}" >/dev/null 2>&1 || true
    wait "${NGINX_PID}" || true
  fi

  if [ -n "${TTYD_PID}" ] && kill -0 "${TTYD_PID}" >/dev/null 2>&1; then
    kill -TERM "${TTYD_PID}" >/dev/null 2>&1 || true
    wait "${TTYD_PID}" || true
  fi

  # Stop Avahi before D-Bus; reverse startup order.
  if [ -n "${AVAHI_PID:-}" ] && kill -0 "${AVAHI_PID}" >/dev/null 2>&1; then
    kill -TERM "${AVAHI_PID}" >/dev/null 2>&1 || true
    wait "${AVAHI_PID}" 2>/dev/null || true
  fi

  # Stop the D-Bus daemon we started, if still running.
  if [ -n "${DBUS_PID:-}" ] && kill -0 "${DBUS_PID}" >/dev/null 2>&1; then
    kill -TERM "${DBUS_PID}" >/dev/null 2>&1 || true
    wait "${DBUS_PID}" 2>/dev/null || true
  fi

  if [ -n "${GW_PID}" ] && kill -0 "${GW_PID}" >/dev/null 2>&1; then
    kill -TERM "${GW_PID}" >/dev/null 2>&1 || true
    # wait reaps child PIDs; for non-child (re-tracked) PIDs it fails instantly,
    # so fall back to a timed kill -0 poll to let the gateway finish cleanly.
    if ! wait "${GW_PID}" 2>/dev/null; then
      for _i in 1 2 3 4 5; do
        kill -0 "${GW_PID}" 2>/dev/null || break
        sleep 1
      done
    fi
  fi

  stop_gw_relay

  # Final stale PID cleanup on shutdown.
  for stale_pid in /run/dbus/pid /var/run/dbus/pid /run/avahi-daemon/pid /var/run/avahi-daemon/pid; do
    if [ -f "$stale_pid" ]; then
      echo "INFO: Removing stale PID file on shutdown: $stale_pid"
      rm -f "$stale_pid" || true
    fi
  done

  cleanup_session_locks || true # 0.7.12.4: always on
}

trap shutdown INT TERM

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw is not installed."
  exit 1
fi

# Bootstrap minimal OpenClaw config ONLY if missing.
# We do not overwrite or patch existing configs; onboarding owns everything else.
OPENCLAW_CONFIG_PATH="/config/.openclaw/openclaw.json"
if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "INFO: OpenClaw config missing; bootstrapping minimal config at $OPENCLAW_CONFIG_PATH"
  python3 - <<'PY'
import json
import secrets
from pathlib import Path

cfg_path = Path('/config/.openclaw/openclaw.json')
cfg_path.parent.mkdir(parents=True, exist_ok=True)

cfg = {
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": secrets.token_urlsafe(24)
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/config/clawd"
    }
  }
}

cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding='utf-8')
print("INFO: Wrote minimal OpenClaw config (gateway.mode=local, auth.token generated)")
PY
fi

# ------------------------------------------------------------------------------
# Apply gateway LAN mode settings safely using helper script
# This updates gateway.bind and gateway.port without touching other settings
# ------------------------------------------------------------------------------
export OPENCLAW_CONFIG_PATH="/config/.openclaw/openclaw.json"

# Find the helper script (copied to root in Dockerfile, or fallback to app dir)
HELPER_PATH="/oc_config_helper.py"
if [ ! -f "$HELPER_PATH" ] && [ -f "$(dirname "$0")/oc_config_helper.py" ]; then
  HELPER_PATH="$(dirname "$0")/oc_config_helper.py"
fi

if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  if [ -f "$HELPER_PATH" ]; then
    if ! python3 "$HELPER_PATH" apply-network-settings \
      "$NETWORK_MODE" \
      "$GATEWAY_MODE" \
      "$GATEWAY_REMOTE_URL" \
      "$GATEWAY_BIND" \
      "$GATEWAY_PORT" \
      "$GATEWAY_INTERNAL_PORT" \
      "$ENABLE_OPENAI_API" \
      "$GATEWAY_AUTH_MODE" \
      "$GATEWAY_TRUSTED_PROXIES" \
      "$GATEWAY_TLS_ENABLED" \
      "$GATEWAY_TLS_AUTO" \
      "$TAILSCALE_MODE"; then
      rc=$?
      echo "ERROR: Failed to apply network settings via oc_config_helper.py (exit code ${rc})."
      echo "ERROR: Gateway configuration may be incorrect; aborting startup."
      exit "${rc}"
    fi
    # Apply OpenClaw 2026.9.1 cron/security settings (best-effort; do not abort on failure)
    python3 "$HELPER_PATH" apply-cron-settings "true" || true # 0.7.12.4: hardcoded — HA apps restart frequently, backfill is never wanted
    python3 "$HELPER_PATH" apply-blocked-hostnames "$BLOCKED_HOSTNAMES" || true
  else
    echo "WARN: oc_config_helper.py not found, cannot apply network settings"
    echo "INFO: Ensure the app image includes oc_config_helper.py and restart"
  fi
else
  echo "WARN: OpenClaw config not found at $OPENCLAW_CONFIG_PATH, cannot apply network settings"
  echo "INFO: Run 'openclaw onboard' first, then restart the app"
fi

if [ "$NETWORK_MODE" = "reverse_proxy" ]; then
  echo "NOTICE: network_mode=reverse_proxy is enabled."
  echo "NOTICE: Direct local CLI calls to the gateway may return unauthorized (trusted_proxy_user_missing) unless identity headers are injected by your reverse proxy."
  echo "NOTICE: For local terminal CLI workflows, temporarily switch to token auth or use commands that don't require direct gateway WS auth."
fi

# -----------------------------------------------------------------------------
# LAN IP detection (used for info messages and optional cert fallback)
# -----------------------------------------------------------------------------
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

# -----------------------------------------------------------------------------
# TLS certificate handling (0.7.12.4: full restoration + X.509 hardening)
# The v0.7.10.0 network-mode refactor accidentally dropped the server-cert
# generation that this app had inherited (verified 2026-10-03: nginx serves
# /config/certs/gateway.crt on :18789 and gateway.tls is disabled in
# openclaw.json, so fresh installs in lan_https had no server cert at all).
# Restored and extended:
#   - Local CA (always generated; backs the /cert/ca.crt Ingress download)
#   - Server cert with SANs, regenerated on LAN-IP or SAN change, gated to
#     ENABLE_HTTPS_PROXY (lan_https/tailnet) where nginx terminates TLS
#   - X.509v3 extensions on both certs (basicConstraints/keyUsage/EKU) so
#     strict clients (Python requests with verify=, OpenSSL strict) accept
#     them; pre-0.7.12.4 certs regenerate once via the .cert_ext marker
# -----------------------------------------------------------------------------
CERT_DIR="/config/certs"
mkdir -p "$CERT_DIR"

# --- Local CA (generated once, persists across restarts) ---
if [ ! -f "$CERT_DIR/ca.key" ] || [ ! -f "$CERT_DIR/ca.crt" ]; then
  echo "INFO: Generating local CA certificate (one-time)..."
  openssl genrsa -out "$CERT_DIR/ca.key" 2048 2>/dev/null
  openssl req -new -x509 -key "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
    -days 3650 -nodes -subj "/CN=OpenClaw Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 "$CERT_DIR/ca.key"
  echo "INFO: Local CA created at $CERT_DIR/ca.crt"
fi

# --- Extra SANs from gateway_additional_allowed_origins + gateway_public_url ---
STORED_IP=$(cat "$CERT_DIR/.cert_ip" 2>/dev/null || echo "")
STORED_EXTRA_SANS=$(cat "$CERT_DIR/.cert_extra_sans" 2>/dev/null || echo "")
EXTRA_SANS=""
EXTRA_SAN_SOURCES="${GATEWAY_ADDITIONAL_ALLOWED_ORIGINS},${GW_PUBLIC_URL}"
if [ "$EXTRA_SAN_SOURCES" != "," ]; then
  EXTRA_SANS="$(python3 - "$EXTRA_SAN_SOURCES" "${LAN_IP:-}" <<'SANPY'
import sys, re
from urllib.parse import urlparse
raw = sys.argv[1] if len(sys.argv) > 1 else ""
lan_ip = sys.argv[2] if len(sys.argv) > 2 else ""
entries = [e.strip() for e in raw.split(",") if e.strip()]
sans = []
seen = {"127.0.0.1", "localhost", "homeassistant", "homeassistant.local"}
if lan_ip:
    seen.add(lan_ip)
for entry in entries:
    if "://" not in entry:
        entry = "https://" + entry
    host = urlparse(entry).hostname or ""
    if host and host not in seen:
        seen.add(host)
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host):
            sans.append(f"IP:{host}")
        else:
            sans.append(f"DNS:{host}")
print(",".join(sans), end="")
SANPY
)"
fi

# --- Server cert (regenerated when missing, IP/SAN change, or pre-extension) ---
if [ "$ENABLE_HTTPS_PROXY" = "true" ]; then
  if [ ! -f "$CERT_DIR/gateway.crt" ] || [ ! -f "$CERT_DIR/gateway.key" ] \
     || [ "$LAN_IP" != "$STORED_IP" ] || [ "$EXTRA_SANS" != "$STORED_EXTRA_SANS" ] \
     || [ ! -f "$CERT_DIR/.cert_ext" ]; then
    echo "INFO: Generating server TLS certificate for IP: ${LAN_IP:-unknown}..."
    openssl genrsa -out "$CERT_DIR/gateway.key" 2048 2>/dev/null
    openssl req -new -key "$CERT_DIR/gateway.key" -out "$CERT_DIR/gateway.csr" \
      -subj "/CN=OpenClaw Gateway" 2>/dev/null
    cat > "$CERT_DIR/_san.ext" <<SANEOF
subjectAltName=IP:${LAN_IP:-127.0.0.1},IP:127.0.0.1,DNS:localhost,DNS:homeassistant,DNS:homeassistant.local${EXTRA_SANS:+,${EXTRA_SANS}}
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
SANEOF
    openssl x509 -req -in "$CERT_DIR/gateway.csr" \
      -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
      -out "$CERT_DIR/gateway.crt" -days 3650 \
      -extfile "$CERT_DIR/_san.ext" 2>/dev/null
    rm -f "$CERT_DIR/gateway.csr" "$CERT_DIR/_san.ext" "$CERT_DIR/ca.srl"
    chmod 600 "$CERT_DIR/gateway.key"
    printf '%s' "$LAN_IP" > "$CERT_DIR/.cert_ip"
    printf '%s' "$EXTRA_SANS" > "$CERT_DIR/.cert_extra_sans"
    touch "$CERT_DIR/.cert_ext"
    echo "INFO: Server TLS certificate generated (SAN: IP:${LAN_IP:-127.0.0.1}${EXTRA_SANS:+,${EXTRA_SANS}}, X.509v3 extensions present)"
  else
    echo "INFO: Reusing existing TLS certificate (IP: $STORED_IP)"
  fi
fi

INGRESS_PORT=49200
export INGRESS_PORT
export CERTS_DIR="/config/certs"
export SHOW_WEBUI="$ENABLE_WEBUI"
export SHOW_TERMINAL="$ENABLE_TERMINAL"
export SHOW_DOCS="$ENABLE_DOCS"
# OPENCLAW_VERSION is used by OpenClaw's plugin API compatibility check.
# `openclaw --version` prints a human-readable label like:
#   "OpenClaw 2026.8.2 (xxxxxxxx)"
# The plugin loader expects a plain semver string, so we take the
# second whitespace-delimited field which is already the version.
export OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | head -1 | awk '/^OpenClaw / { print $2; exit }' || echo 'unknown')"
echo "INFO: OpenClaw version detected: ${OPENCLAW_VERSION}"

# -----------------------------------------------------------------------------
# v0.7.13 (B1, TechArtDev 0.5.94 parity): pre-upgrade state backup.
# Upstream verified backups only run WHILE the gateway starts. If that very
# start triggers a schema migration and dies, the rollback path is gone
# (proven by the 2026-10-04/05 crash-loop saga: 130 restart cycles ending in a
# corrupted state DB). Archiving state BEFORE the first boot of a new version
# makes the rollback honest. The gate lives inside start_openclaw_runtime so
# every start attempt is covered; failure handling is fail-soft on the
# container (nginx/terminal stay up) and fail-closed on the data (no start
# into the new version unless abort_on_upgrade_backup_failure is turned OFF).
# Snapshot members are explicit (openclaw.json + state/ + agents/); sibling bulk
# dirs (media/, npm/, skills/, logs/, .cache/) are never members and thus never
# enter the archive. WAL files are deliberately INCLUDED so the snapshot
# reflects the active databases; *.sqlite-shm (rebuilt from WAL on restore),
# transient locks and *.corrupt.* quarantine artifacts are excluded.
# -----------------------------------------------------------------------------
UPGRADE_BACKUP_DIR="${OPENCLAW_CONFIG_DIR}/upgrade-backups"

backup_upgrade_state() {
  # args: <version> -> archive upgrade-sensitive state once; caller updates state.
  local version="$1" stamp archive tmp
  local members=(./openclaw.json)
  [ -d "${OPENCLAW_CONFIG_DIR}/state" ] && members+=(./state)
  [ -d "${OPENCLAW_CONFIG_DIR}/agents" ] && members+=(./agents)
  if [ "${#members[@]}" -lt 2 ]; then
    echo "INFO: No existing OpenClaw state found; nothing to pre-upgrade back up."
    return 0
  fi
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  archive="${UPGRADE_BACKUP_DIR}/openclaw-state-${version}-${stamp}.tar.gz"
  tmp="${archive}.partial"
  echo "INFO: Creating pre-upgrade state backup for OpenClaw ${version}..."
  if ! tar -C "$OPENCLAW_CONFIG_DIR" \
      --exclude='*.sqlite-shm' \
      --exclude='*.lock' \
      --exclude='*.corrupt.*' \
      -czf "$tmp" "${members[@]}" 2>"${UPGRADE_BACKUP_DIR}/backup-errors.log"; then
    rm -f "$tmp" 2>/dev/null || true
    echo "ERROR: Pre-upgrade state backup FAILED (see ${UPGRADE_BACKUP_DIR}/backup-errors.log)."
    return 1
  fi
  if ! mv "$tmp" "$archive"; then
    rm -f "$tmp" 2>/dev/null || true
    echo "ERROR: Could not finalize the pre-upgrade state backup."
    return 1
  fi
  chmod 600 "$archive" 2>/dev/null || true
  echo "INFO: Pre-upgrade state backup saved: ${archive}"
  # Retention: keep the newest UPGRADE_BACKUP_KEEP archives.
  ls -1t "${UPGRADE_BACKUP_DIR}"/openclaw-state-*.tar.gz 2>/dev/null \
    | tail -n +"$((UPGRADE_BACKUP_KEEP + 1))" \
    | while IFS= read -r old; do
        echo "INFO: Pruning old upgrade backup: ${old}"
        rm -f "$old" 2>/dev/null || true
      done || true
  return 0
}

# v0.7.13 (audit P2-6): atomic version-marker writes. A failed/truncated write
# must never kill the supervisor shell (set -e) and a corrupted marker must not
# silently skip a future backup (the gate self-heals from the archive names).
record_upgrade_version() {
  printf '%s' "$1" > "${UPGRADE_BACKUP_DIR}/.last-version.tmp" 2>/dev/null \
    || { rm -f "${UPGRADE_BACKUP_DIR}/.last-version.tmp" 2>/dev/null || true; return 1; }
  mv -f "${UPGRADE_BACKUP_DIR}/.last-version.tmp" "${UPGRADE_BACKUP_DIR}/.last-version" 2>/dev/null || true
}

upgrade_backup_gate() {
  # args: <version>. Runs once per add-on start, before the gateway launch.
  local version="$1" prev
  [ -f "${OPENCLAW_CONFIG_DIR}/openclaw.json" ] || return 0
  mkdir -p "$UPGRADE_BACKUP_DIR"
  prev="$(cat "${UPGRADE_BACKUP_DIR}/.last-version" 2>/dev/null || echo '')"
  if [ -z "$prev" ]; then
    # Self-heal (audit P2-6b): an empty/truncated marker after power loss must
    # not silently skip the next backup — derive the previous version from the
    # newest archive name instead.
    prev="$(ls -1t "${UPGRADE_BACKUP_DIR}"/openclaw-state-*.tar.gz 2>/dev/null | head -1 | sed -n 's/.*openclaw-state-\([0-9.]*\)-.*/\1/p' || true)"
  fi
  if [ -z "$prev" ]; then
    # First boot with this system (fresh image or restored config):
    # record baseline only — there is no previous version to roll back to.
    if ! record_upgrade_version "$version"; then
      echo "WARN: Could not record the upgrade baseline marker; the gate will re-check on the next start."
    fi
    return 0
  fi
  if [ "$prev" = "$version" ]; then
    return 0
  fi
  echo "INFO: OpenClaw version change detected: ${prev} -> ${version}"
  if backup_upgrade_state "$version"; then
    if record_upgrade_version "$version"; then
      echo "IMPORTANT: pre-upgrade backup complete; proceeding into OpenClaw ${version}."
    else
      echo "WARN: Pre-upgrade backup exists, but the version marker could not be updated; the gate will re-derive it from the archive on the next start."
    fi
    return 0
  fi
  if [ "${ABORT_ON_UPGRADE_BACKUP_FAILURE}" = "true" ]; then
    echo "ERROR: abort_on_upgrade_backup_failure=true — NOT starting OpenClaw ${version} without a complete state backup. Free disk space or inspect ${UPGRADE_BACKUP_DIR}/backup-errors.log, then restart the app to retry."
    return 1
  fi
  echo "WARN: abort_on_upgrade_backup_failure=false — continuing into OpenClaw ${version} WITHOUT a pre-upgrade backup. Rollback to the previous version may be impossible."
  record_upgrade_version "$version" || true
  return 0
}

# -----------------------------------------------------------------------------
# Copy static Ingress assets (Docs, icon) into nginx web root
# -----------------------------------------------------------------------------
# docs/index.html is rendered from docs/index.html.tpl by render_nginx.py (v0.7.12.1).
mkdir -p /etc/nginx/html/docs
if [ -f /openclaw_ha_addon/loading.html ]; then
  cp -v /openclaw_ha_addon/loading.html /etc/nginx/html/loading.html 2>/dev/null || true
fi
if [ -f /openclaw_ha_addon/icon.png ]; then
  cp -v /openclaw_ha_addon/icon.png /etc/nginx/html/icon.png 2>/dev/null || true
fi
if [ -f /openclaw_ha_addon/logo.png ]; then
  cp -v /openclaw_ha_addon/logo.png /etc/nginx/html/logo.png 2>/dev/null || true
fi
# ------------------------------------------------------------------
# Configure ControlUI allowed origins
# - In lan_https/tailnet_*: include public URL origins when known
# - In all modes: also include origin from gateway_public_url when present
# - Helper merges with existing origins + user extras and deduplicates
# ------------------------------------------------------------------
if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  ALLOWED_ORIGINS=""

  if [ "$NETWORK_MODE" = "lan_https" ] && [ -n "$LAN_IP" ]; then
    ALLOWED_ORIGINS="https://${LAN_IP}:${GATEWAY_PORT}"
    ALLOWED_ORIGINS="${ALLOWED_ORIGINS},https://homeassistant.local:${GATEWAY_PORT}"
    ALLOWED_ORIGINS="${ALLOWED_ORIGINS},https://homeassistant:${GATEWAY_PORT}"
  fi

  if [ -n "$GW_PUBLIC_URL" ]; then
    GW_PUBLIC_ORIGIN="$(python3 - "$GW_PUBLIC_URL" <<'PY'
import sys
from urllib.parse import urlparse
u = (sys.argv[1] or '').strip()
p = urlparse(u)
if p.scheme in ('http', 'https') and p.netloc:
    print(f"{p.scheme}://{p.netloc}", end='')
PY
)"
    if [ -n "$GW_PUBLIC_ORIGIN" ]; then
      if [ -n "$ALLOWED_ORIGINS" ]; then
        ALLOWED_ORIGINS="${ALLOWED_ORIGINS},${GW_PUBLIC_ORIGIN}"
      else
        ALLOWED_ORIGINS="$GW_PUBLIC_ORIGIN"
      fi
    fi
  fi

  python3 "$HELPER_PATH" set-control-ui-origins "$ALLOWED_ORIGINS" "$GATEWAY_ADDITIONAL_ALLOWED_ORIGINS" "$CONTROLUI_DISABLE_DEVICE_AUTH" || \
    echo "WARN: Could not set controlUi settings — gateway may reject the Control UI"
fi

# Apply mDNS settings (OpenClaw native bonjour plugin)
if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  python3 "$HELPER_PATH" set-mdns-settings "$MDNS_MODE" || \
    echo "WARN: Could not apply mDNS settings — LAN discovery may not work"
fi

# ------------------------------------------------------------------------------
# Proxy shim for undici/OpenClaw startup
# Keep official OpenClaw npm release while enabling HTTP(S)_PROXY support.
# ------------------------------------------------------------------------------
OPENCLAW_GLOBAL_NODE_MODULES="$(HOME=/root npm root -g 2>/dev/null || true)"
if [ -f /usr/local/lib/openclaw-proxy-shim.cjs ]; then
  if [ -n "${NODE_OPTIONS:-}" ]; then
    export NODE_OPTIONS="--require /usr/local/lib/openclaw-proxy-shim.cjs ${NODE_OPTIONS}"
  else
    export NODE_OPTIONS="--require /usr/local/lib/openclaw-proxy-shim.cjs"
  fi
  export OPENCLAW_GLOBAL_NODE_MODULES
fi

# ------------------------------------------------------------------------------
# Runtime APT packages (Audit R5 — was defined but never implemented)
# Installs user-specified apt packages at container startup.
# ------------------------------------------------------------------------------
if [ -n "$RUNTIME_APT_PACKAGES" ]; then
  echo "INFO: Installing runtime apt packages: $RUNTIME_APT_PACKAGES"
  apt-get update -qq 2>/dev/null || true
  if ! apt-get install -y --no-install-recommends $RUNTIME_APT_PACKAGES 2>&1; then
    echo "WARN: Some runtime apt packages failed to install — check package names"
  fi
  apt-get clean 2>/dev/null || true
  rm -rf /var/lib/apt/lists/* 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# Custom init script (Audit R6 — was defined but never implemented)
# Runs user-provided script before gateway start.
# ------------------------------------------------------------------------------
if [ -n "$CUSTOM_INIT_SCRIPT" ]; then
  if [ -f "$CUSTOM_INIT_SCRIPT" ] && [ -x "$CUSTOM_INIT_SCRIPT" ]; then
    echo "INFO: Running custom init script: $CUSTOM_INIT_SCRIPT"
    "$CUSTOM_INIT_SCRIPT" || echo "WARN: Custom init script exited with code $?"
  else
    echo "WARN: custom_init_script '$CUSTOM_INIT_SCRIPT' not found or not executable — skipping"
  fi
fi

# ------------------------------------------------------------------------------
# Chromium self-heal (Playwright layout drift: chrome-linux vs chrome-linux-arm64)
# The image resolves the real binary at build time via browser_links.sh; a boot
# re-run repairs a dangling /usr/bin/chromium (rebuild or layout change) instead
# of silently killing OpenClaw browser automation and crawl4ai browser tasks.
# ------------------------------------------------------------------------------
if [ -x /usr/local/bin/link-playwright-chromium ] && [ ! -x /usr/bin/chromium ]; then
  /usr/local/bin/link-playwright-chromium || \
    echo "WARN: Chromium link repair failed — OpenClaw browser automation and crawl4ai browser tasks will fail"
fi

# ------------------------------------------------------------------------------
# Ensure browser automation config (headless Chromium in container)
# ------------------------------------------------------------------------------
if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  python3 "$HELPER_PATH" ensure-browser-config || \
    echo "WARN: Could not ensure browser config — browser automation may not work"
fi

# ------------------------------------------------------------------------------
# Ensure memory-core plugin with dreaming sidecar
# ------------------------------------------------------------------------------
if [ -f "$HELPER_PATH" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  python3 "$HELPER_PATH" ensure-memory-core || \
    echo "WARN: Could not ensure memory-core — memory search may be unavailable"
fi

# ------------------------------------------------------------------------------
# Auto-configure MCP (Model Context Protocol) for Home Assistant
# Registers HA as an MCP server so OpenClaw can control HA entities/services.
# Requires: homeassistant_token set in app options + mcporter CLI available.
# Runs once; re-runs when the token changes.
# Auto-detects HA API URL: supervisor proxy if available, else localhost:8123.
# ------------------------------------------------------------------------------
if [ "$AUTO_CONFIGURE_MCP" = "true" ] && [ -n "$HA_TOKEN" ]; then
  if command -v mcporter >/dev/null 2>&1; then
    # Detect HA API URL: prefer supervisor proxy (works in all app network modes),
    # fall back to localhost:8123 (works with host_network: true).
    if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
      MCP_HA_URL="http://supervisor/core/api/mcp"
    else
      MCP_HA_URL="http://localhost:8123/api/mcp"
    fi
    MCP_FLAG="/config/.openclaw/.mcp_ha_configured"
    MCP_TOKEN_HASH=$(printf '%s' "$HA_TOKEN" | sha256sum | cut -d' ' -f1)

    if [ -f "$MCP_FLAG" ] && [ "$(cat "$MCP_FLAG" 2>/dev/null)" = "$MCP_TOKEN_HASH" ]; then
      echo "INFO: MCP Home Assistant server already configured (token unchanged)"
    else
      echo "INFO: Configuring MCP for Home Assistant at $MCP_HA_URL ..."
      # Remove stale entry if present (token may have changed)
      mcporter config remove HA 2>/dev/null || true

      if mcporter config add HA "$MCP_HA_URL" \
          --header "Authorization=Bearer $HA_TOKEN" \
          --scope home 2>&1; then
        printf '%s' "$MCP_TOKEN_HASH" > "$MCP_FLAG"
        echo "INFO: MCP server 'HA' registered — OpenClaw can now control Home Assistant"
      else
        echo "WARN: MCP auto-configuration failed. Configure manually in the terminal:"
        echo "WARN:   mcporter config add HA \"$MCP_HA_URL\" --header \"Authorization=Bearer YOUR_TOKEN\" --scope home"
      fi
    fi
  else
    echo "INFO: mcporter not available; skipping MCP auto-configuration (run 'openclaw onboard' first)"
  fi
elif [ "$AUTO_CONFIGURE_MCP" = "true" ] && [ -z "$HA_TOKEN" ]; then
  echo "INFO: MCP auto-configure enabled but homeassistant_token not set — skipping"
  echo "INFO: To auto-configure, set homeassistant_token in app Configuration, then restart"
fi

# ------------------------------------------------------------------------------
# Initialize ACPX harnesses (Claude Code, Codex, OpenCode)
# This sets up the wrapper launchers and the managed npm project so that the
# local ACPX harness backend can be used. Agent definitions are NOT modified
# here; existing user-configured coding agents are preserved.
# ------------------------------------------------------------------------------
ACPX_HELPER_PATH="/oc_acpx_helper.py"
if [ ! -f "$ACPX_HELPER_PATH" ] && [ -f "$(dirname "$0")/oc_acpx_helper.py" ]; then
  ACPX_HELPER_PATH="$(dirname "$0")/oc_acpx_helper.py"
fi
if [ "$ACPX_ENABLED" = "true" ] || [ "$ACPX_ENABLED" = "1" ]; then
  if [ -f "$ACPX_HELPER_PATH" ]; then
    echo "INFO: Initializing ACPX harnesses..."
    python3 "$ACPX_HELPER_PATH" || \
      echo "WARN: ACPX harness initialization failed — Claude/Codex/OpenCode harnesses may not be available"
  else
    echo "WARN: ACPX helper not found; skipping ACPX harness initialization"
  fi
else
  echo "INFO: ACPX harnesses disabled (acpx_enabled=$ACPX_ENABLED)"
fi

start_openclaw_runtime() {
  echo "Starting OpenClaw Assistant runtime (openclaw)..."

  # v0.7.13 (B1): pre-upgrade state backup gate — run before ANY gateway start
  # attempt (initial and supervised retries) so a crashing migration can never
  # destroy the only rollback copy. Gate returning 1 skips this start attempt;
  # the supervisor loop retries after its (hardened, B8) backoff.
  upgrade_backup_gate "$OPENCLAW_VERSION" || return 1

  # Apply gateway log level (Audit R4)
  export LOG_LEVEL="$GATEWAY_LOG_LEVEL"

  # Enable trace logging if requested (Audit R4)
  if [ "$TRACE_LOG_TO_CONSOLE" = "true" ] || [ "$TRACE_LOG_TO_CONSOLE" = "1" ]; then
    set -x
  fi

  if [ "$GATEWAY_MODE" = "remote" ]; then
    # Remote mode: do NOT start a local gateway service.
    # Start a node/client host that connects to the configured remote gateway URL.
    # Use $GATEWAY_REMOTE_URL directly from app options — do NOT read back via
    # 'openclaw config get' which can time out at startup or return redacted values.
    REMOTE_URL="$GATEWAY_REMOTE_URL"
    if [ -z "$REMOTE_URL" ]; then
      echo "ERROR: gateway_mode=remote but gateway_remote_url is not set in app options"
      echo "ERROR: Set gateway_remote_url in app Configuration (e.g. ws://192.168.1.10:18789), then restart"
      return 1
    fi

    NODE_HOST=""
    NODE_PORT=""
    NODE_TLS_FLAG=""
    if ! eval "$(python3 - "$REMOTE_URL" <<'PY'
import sys
from urllib.parse import urlparse
url = (sys.argv[1] or '').strip()
p = urlparse(url)
if p.scheme not in ('ws', 'wss') or not p.hostname:
    print('echo "ERROR: Invalid gateway.remote.url (expected ws:// or wss://): %s"' % url.replace('"', '\\"'))
    print('exit 1')
    raise SystemExit(0)
port = p.port or (443 if p.scheme == 'wss' else 80)
print(f'NODE_HOST={p.hostname}')
print(f'NODE_PORT={port}')
print(f'NODE_TLS_FLAG={"--tls" if p.scheme == "wss" else ""}')
PY
)"; then
      echo "ERROR: Failed to parse gateway.remote.url: $REMOTE_URL"
      return 1
    fi

    echo "INFO: gateway_mode=remote detected; starting node host to $NODE_HOST:$NODE_PORT ${NODE_TLS_FLAG}"
    # shellcheck disable=SC2086
    openclaw node run --host "$NODE_HOST" --port "$NODE_PORT" $NODE_TLS_FLAG &
  else
    openclaw gateway run &
  fi
  GW_PID=$!
  return 0
}

# --- Loopback relay helpers for tailnet bind mode (issue #90) ---
# When gateway.bind=tailnet the gateway only listens on the Tailscale IP.
# The local CLI always tries ws://127.0.0.1:PORT and fails with
# "Gateway not running" even though the gateway is healthy.
# These functions start/stop a lightweight Node.js TCP relay on
# 127.0.0.1:PORT -> TAILSCALE_IP:PORT so terminal CLI commands work.
# IMPORTANT: stop_gw_relay must be called before restarting the gateway;
# otherwise the relay holds the loopback port and the new gateway instance
# detects it as "already listening" and exits with code 1.
start_gw_relay() {
  if [ "$NETWORK_MODE" != "tailnet_serve" ] && [ "$NETWORK_MODE" != "tailnet_funnel" ]; then
    return 0
  fi
  local ts_ip
  ts_ip=$(ip -4 addr show tailscale0 2>/dev/null \
    | awk '/inet /{gsub(/\/.*/,"",$2); print $2; exit}' || true)
  if [[ "${ts_ip:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "INFO: Starting loopback relay for tailnet gateway (127.0.0.1:${GATEWAY_PORT} -> ${ts_ip}:${GATEWAY_PORT})"
    node -e "
const net = require('net');
const TARGET_HOST = '${ts_ip}';
const TARGET_PORT = ${GATEWAY_PORT};
const server = net.createServer(function(c) {
  const t = net.createConnection(TARGET_PORT, TARGET_HOST);
  c.pipe(t); t.pipe(c);
  c.on('error', function() { t.destroy(); });
  t.on('error', function() { c.destroy(); });
});
server.listen(TARGET_PORT, '127.0.0.1');" &
    GW_RELAY_PID=$!
    echo "INFO: Loopback relay started (PID ${GW_RELAY_PID})"
  else
    echo "WARN: tailnet bind mode active but Tailscale IP not found on tailscale0 interface."
    echo "WARN: Terminal CLI may show gateway as unreachable. Ensure Tailscale is running and restart."
  fi
}

stop_gw_relay() {
  if [ -n "${GW_RELAY_PID}" ] && kill -0 "${GW_RELAY_PID}" >/dev/null 2>&1; then
    kill -TERM "${GW_RELAY_PID}" >/dev/null 2>&1 || true
    wait "${GW_RELAY_PID}" 2>/dev/null || true
    GW_RELAY_PID=""
  fi
}

# Find a running gateway daemon's PID using multiple detection methods.
# Used by the supervisor loop to detect self-restarts (SIGUSR1) without
# spawning duplicate gateway instances that collide on the port.
#
# Three tiers, tried in order of reliability:
#   1. Port ownership via `ss -tlnp` — authoritative, but only works once
#      the daemon has bound the port (can take 20+ s on Pi hardware).
#   2. Process title via `pgrep -f openclaw-gateway` — works after Node.js
#      sets process.title, which also happens late during init.
#   3. /proc cmdline scan — catches the daemon IMMEDIATELY after fork,
#      before title or port bind, by matching "openclaw" in the cmdline.
#      Excludes known PIDs (nginx, ttyd, relay, our shell, old GW_PID).
#
# Returns the PID on stdout and exit 0, or exits with code 1 if nothing found.
find_gateway_daemon_pid() {
  local pid=""

  # Tier 1: port ownership (authoritative once port is bound)
  pid=$(ss -tlnp 2>/dev/null \
    | grep ":${GATEWAY_INTERNAL_PORT} " \
    | sed -n 's/.*pid=\([0-9]*\).*/\1/p' \
    | head -1)
  [ -n "$pid" ] && { echo "$pid"; return 0; }

  # Tier 2: process title (after Node sets process.title)
  pid=$(pgrep -f "openclaw-gateway" 2>/dev/null | head -1)
  [ -n "$pid" ] && { echo "$pid"; return 0; }

  # Tier 3: scan /proc for any openclaw process we don't already know about.
  # The daemon's cmdline (e.g. node /usr/.../openclaw/...) contains "openclaw"
  # from the moment it is forked, even before process.title is set.
  local known=" ${NGINX_PID:-0} ${TTYD_PID:-0} ${GW_RELAY_PID:-0} ${GW_PID:-0} $$ "
  local f cand
  for f in /proc/[0-9]*/cmdline; do
    [ -r "$f" ] || continue
    if tr '\0' ' ' < "$f" 2>/dev/null | grep -q "openclaw"; then
      cand="${f#/proc/}"
      cand="${cand%%/*}"
      case "$known" in *" $cand "*) continue ;; esac
      echo "$cand"
      return 0
    fi
  done

  return 1
}

# ------------------------------------------------------------------------------
# D-Bus + Avahi Startup (mDNS/LAN Discovery)
# Must run BEFORE the gateway so Avahi can advertise the service.
# dbus-daemon is not started by systemd in Docker — we start it manually.
#
# CAUTION: Homebrew may install its own dbus-daemon under
# /home/linuxbrew/.linuxbrew/bin, which appears earlier in PATH via the
# export at the top of this script. That build is compiled for a different
# prefix and will fail to start the Debian system bus. We therefore use
# absolute Debian paths and remove stale PID files that survive an unclean
# container restart.
# ------------------------------------------------------------------------------
DBUS_SYSTEM_BIN="/usr/bin/dbus-daemon"
AVAHI_SYSTEM_BIN="/usr/sbin/avahi-daemon"

if [ ! -x "$DBUS_SYSTEM_BIN" ]; then
  DBUS_SYSTEM_BIN="$(command -v dbus-daemon 2>/dev/null || true)"
fi

if [ ! -x "$AVAHI_SYSTEM_BIN" ]; then
  AVAHI_SYSTEM_BIN="$(command -v avahi-daemon 2>/dev/null || true)"
fi

# Remove stale PID files from a previous (possibly crashed) container run.
# /run is not a tmpfs in this image, so the PID can survive a restart.
for stale_pid in /run/dbus/pid /var/run/dbus/pid /run/avahi-daemon/pid /var/run/avahi-daemon/pid; do
  if [ -f "$stale_pid" ]; then
    echo "INFO: Removing stale PID file: $stale_pid"
    rm -f "$stale_pid" || true
  fi
done

echo "Starting D-Bus system bus for Avahi/mDNS..."
if ! pgrep -x dbus-daemon >/dev/null 2>&1 && [ -x "$DBUS_SYSTEM_BIN" ]; then
  # Start in background with `&` so $! is set. `--fork` alone makes the
  # process fork internally and leaves $! unset under `set -u`.
  "$DBUS_SYSTEM_BIN" --system --fork &
  DBUS_PID=$!
  for i in $(seq 1 20); do
    [ -S /run/dbus/system_bus_socket ] && break
    sleep 0.5
  done
  if [ -S /run/dbus/system_bus_socket ]; then
    echo "D-Bus system bus started (socket: /run/dbus/system_bus_socket)"
  else
    echo "WARN: D-Bus socket not available after 10s — mDNS/Avahi may not work"
  fi
else
  echo "D-Bus already running"
fi

if [ "$MDNS_MODE" != "off" ] && ! pgrep -x avahi-daemon >/dev/null 2>&1 && [ -x "$AVAHI_SYSTEM_BIN" ]; then
  "$AVAHI_SYSTEM_BIN" --daemonize --no-drop-root &
  AVAHI_PID=$!
  echo "Avahi mDNS daemon started"
elif [ "$MDNS_MODE" = "off" ]; then
  echo "INFO: mDNS disabled (mdns_mode=off), skipping Avahi start"
else
  echo "Avahi already running"
fi

# Gateway log to console (Audit R4) — if enabled, tee gateway output to HA console
# The gateway writes to log files by default; this mirrors stdout/stderr to the
# app log window for real-time diagnostics.
if [ "$GATEWAY_LOG_TO_CONSOLE" = "true" ] || [ "$GATEWAY_LOG_TO_CONSOLE" = "1" ]; then
  echo "INFO: Gateway log mirroring to console enabled (gateway_log_to_console=true)"
  # Gateway output is already captured by the supervisor loop via wait/poll.
  # The LOG_LEVEL env var (set in start_openclaw_runtime) controls verbosity.
fi

# v0.7.12.1: nginx and the web terminal start BEFORE the gateway so the HA
# Ingress panel and the terminal (fallback surface) are reachable while the
# gateway initializes. SQLite session validation can take minutes on slow
# storage; the UI must not wait for it. The gateway starts after nginx below.
# Start web terminal (optional)
TTYD_PID_FILE="/var/run/openclaw-ttyd.pid"

# Clean up stale ttyd process from previous run using PID file
if [ -f "$TTYD_PID_FILE" ]; then
  OLD_PID=$(cat "$TTYD_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping previous ttyd process (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    # Force kill if still running
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$TTYD_PID_FILE"
fi

if [ "$ENABLE_TERMINAL" = "true" ] || [ "$ENABLE_TERMINAL" = "1" ]; then
  # Check if the terminal port is already in use before starting ttyd
  if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${TERMINAL_PORT} "; then
    echo ""
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "!!  WARNING: terminal_port ${TERMINAL_PORT} IS ALREADY IN USE  !!"
    echo "!!                                                             !!"
    echo "!!  The web terminal (ttyd) may FAIL to start because port     !!"
    echo "!!  ${TERMINAL_PORT} appears to be in use by another process.  !!"
    echo "!!                                                             !!"
    echo "!!  ACTION REQUIRED: If the terminal does not work, go to      !!"
    echo "!!  App Configuration and change 'terminal_port' to a free     !!"
    echo "!!  port, then restart the app.                                !!"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo ""
  fi
  echo "Starting web terminal (ttyd) on 127.0.0.1:${TERMINAL_PORT} ..."
  ttyd -W -i 127.0.0.1 -p "${TERMINAL_PORT}" -b /terminal bash -il &
  TTYD_PID=$!
  echo "$TTYD_PID" > "$TTYD_PID_FILE"
  echo "ttyd started with PID $TTYD_PID"
else
  echo "Terminal disabled (enable_terminal=$ENABLE_TERMINAL)"
fi

# Start ingress reverse proxy (nginx). This provides the app UI inside HA.
# Token is injected server-side; never put it in the browser URL.
NGINX_PID_FILE="/var/run/openclaw-nginx.pid"

# Clean up stale nginx process from previous run (e.g., after crash/unclean restart)
if [ -f "$NGINX_PID_FILE" ]; then
  OLD_NGINX_PID=$(cat "$NGINX_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_NGINX_PID" ] && kill -0 "$OLD_NGINX_PID" 2>/dev/null; then
    echo "Stopping previous nginx process (PID $OLD_NGINX_PID)..."
    kill "$OLD_NGINX_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$OLD_NGINX_PID" 2>/dev/null || true
  fi
  rm -f "$NGINX_PID_FILE"
fi
# Also kill any orphaned nginx workers that might hold the ingress port
if command -v pkill >/dev/null 2>&1; then
  pkill -f "nginx.*-c /etc/nginx/nginx.conf" 2>/dev/null || true
  sleep 1
fi
# Verify ingress port is actually free before proceeding
if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ':${INGRESS_PORT} '; then
  echo "WARN: Port ${INGRESS_PORT} still in use after cleanup; nginx may fail to start"
fi

# ------------------------------------------------------------------------------
# render_landing: (re-)render the nginx config + landing page HTML.
#
# Called once before nginx starts (token may be empty on first boot/pre-onboard)
# and again in the background after the gateway comes up so a freshly-generated
# token is immediately reflected in the "Open Gateway Web UI" button.
# nginx is sent SIGHUP to reload the updated config without restarting.
# ------------------------------------------------------------------------------
render_landing() {
  local label="${1:-startup}"
  # Read gateway token directly from openclaw.json (CLI redacts secrets v2026.2.22+)
  local token
  token="$(python3 -c "
import json, os
p = os.environ.get('OPENCLAW_CONFIG_PATH', '/config/.openclaw/openclaw.json')
print(json.load(open(p)).get('gateway',{}).get('auth',{}).get('token',''), end='')
" 2>/dev/null || true)"

  local disk_total="" disk_used="" disk_avail="" disk_pct=""
  if df -h /config >/dev/null 2>&1; then
    disk_total=$(df -h /config | awk 'NR==2{print $2}')
    disk_used=$(df -h /config  | awk 'NR==2{print $3}')
    disk_avail=$(df -h /config | awk 'NR==2{print $4}')
    disk_pct=$(df -h /config   | awk 'NR==2{print $5}')
    if [ "$label" = "startup" ]; then
      echo "INFO: Disk usage: ${disk_used}/${disk_total} (${disk_pct} used, ${disk_avail} free)"
      local pct_num=${disk_pct//%/}
      if [ "$pct_num" -ge 90 ] 2>/dev/null; then
        echo "WARNING: Disk is ${disk_pct} full! App updates may fail. Run 'oc-cleanup' in the terminal."
      elif [ "$pct_num" -ge 75 ] 2>/dev/null; then
        echo "NOTICE: Disk is ${disk_pct} full. Consider running 'oc-cleanup' in the terminal."
      fi
    fi
  fi

  GW_PUBLIC_URL="$GW_PUBLIC_URL" GW_TOKEN="$token" TERMINAL_PORT="$TERMINAL_PORT" \
    ENABLE_HTTPS_PROXY="$ENABLE_HTTPS_PROXY" HTTPS_PROXY_PORT="$HTTPS_PROXY_PORT" \
    GATEWAY_INTERNAL_PORT="$GATEWAY_INTERNAL_PORT" ACCESS_MODE="$ACCESS_MODE" \
    DISK_TOTAL="$disk_total" DISK_USED="$disk_used" DISK_AVAIL="$disk_avail" DISK_PCT="$disk_pct" \
    NGINX_LOG_LEVEL="$NGINX_LOG_LEVEL" \
    python3 /render_nginx.py

  if [ "$label" != "startup" ]; then
    # Signal nginx to reload config/landing HTML without dropping connections.
    local nginx_pid
    nginx_pid=$(cat "${NGINX_PID_FILE:-/var/run/openclaw-nginx.pid}" 2>/dev/null || true)
    if [ -n "$nginx_pid" ] && kill -0 "$nginx_pid" 2>/dev/null; then
      kill -HUP "$nginx_pid" 2>/dev/null || true
      echo "INFO: Landing page re-rendered with gateway token (nginx reloaded)."
    fi
  fi
}

# Initial render (token may be absent if openclaw.json does not exist yet)
render_landing startup

echo "Starting ingress proxy (nginx) on :${INGRESS_PORT} ..."
nginx -g 'daemon off;' &
NGINX_PID=$!
sleep 1
if kill -0 "$NGINX_PID" 2>/dev/null; then
  echo "$NGINX_PID" > "$NGINX_PID_FILE"
  echo "nginx started with PID $NGINX_PID"
else
  echo "WARN: nginx failed to start (PID $NGINX_PID exited); ingress UI may be unavailable"
fi

# If the token was not available at startup (first boot / pre-onboard), schedule
# a background re-render so the "Open Gateway Web UI" button gets the real token
# once openclaw onboard writes openclaw.json (typically within 30-90 s).
(
  CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/config/.openclaw/openclaw.json}"
  for _i in $(seq 1 24); do
    sleep 5
    token=$(python3 -c "
import json, os
p='$CONFIG_PATH'
try:
    print(json.load(open(p)).get('gateway',{}).get('auth',{}).get('token',''), end='')
except Exception:
    pass
" 2>/dev/null || true)
    if [ -n "$token" ]; then
      render_landing post-onboard
      break
    fi
  done
) &

# v0.7.12.1: start the OpenClaw runtime only after nginx and the terminal are
# serving, so the Ingress UI is available during (slow) gateway startup.
# v0.7.12.1 (audit P1): a failed runtime start must NOT exit the container —
# nginx and the terminal stay up so the operator can repair the setup through
# HA Ingress; the supervisor loop below retries the start. GW_IS_CHILD=false
# plus an empty GW_PID makes the loop skip `wait` and enter the restart path.
if ! start_openclaw_runtime; then
  echo "WARN: OpenClaw runtime failed to start; ingress UI stays up, retrying in the supervisor loop."
  GW_IS_CHILD=false
  GW_PID=""
fi
# Only a successful (re)start updates the boot timer; if-form on purpose so a
# failed initial start (empty GW_PID) can never kill the supervisor shell.
if [ -n "${GW_PID:-}" ]; then
  GW_BOOT_START=$(date +%s)
  GW_PREV_BOOT_ALIVE=1   # the initial boot actually came up (audit P2-1)
fi

start_gw_relay

# Keep app alive even if gateway/node runtime restarts itself (e.g. during onboarding).
# If runtime exits unexpectedly, restart it while nginx/ttyd stay up.
#
# Design notes (issue #95):
#   `openclaw gateway run` is a thin wrapper that spawns `openclaw-gateway` as a
#   long-running daemon and then exits. When the gateway self-restarts (SIGUSR1 /
#   `openclaw gateway restart`), the old daemon exits and a NEW daemon is forked —
#   the new PID is NOT a child of this shell so `wait` cannot block on it.
#
#   The new daemon can take 20-30 seconds to initialise on low-power hardware
#   (Pi / eMMC). During that time its process.title and port binding are not yet
#   visible, but the process itself exists in /proc with "openclaw" in its cmdline.
#
#   Strategy:
#     1. `wait` for our child (the wrapper). After it exits, use
#        `find_gateway_daemon_pid` (port → pgrep → /proc scan) with retries
#        to find the daemon. If found → re-track and poll with `kill -0`.
#     2. When the re-tracked daemon eventually exits (crash or another restart),
#        `kill -0` fails, we check again for a live daemon to re-track.
#     3. Before any supervisor-initiated restart, do a final port-occupancy
#        guard to prevent launching a duplicate.
GW_IS_CHILD=true   # true only when GW_PID was started by us (can use `wait`)

# --- v0.7.13 (B8/B4): restart-loop hardening state ---------------------------
# GW_BOOT_START: wallclock at the most recent gateway (re)start — used to judge
# boot health at exit time. GW_CONSECUTIVE_FAILS: drives exponential backoff
# (2s -> 60s cap). GW_DOCTOR_REPAIR_RUNS: budget for automatic
# `openclaw doctor --fix` runs per add-on start.
GW_BOOT_START=$(date +%s)
: "${GW_PREV_BOOT_ALIVE:=0}"   # was the last gateway attempt a boot that actually ran? (kept if the initial boot already came up)
GW_CONSECUTIVE_FAILS=0
GW_DOCTOR_REPAIR_RUNS=0

while true; do
  if [ "$GW_IS_CHILD" = "true" ]; then
    # Efficient blocking wait on our child process.
    GW_EXIT_CODE=0
    wait "${GW_PID}" 2>/dev/null || GW_EXIT_CODE=$?
  else
    # GW_PID is NOT our child (re-tracked after a self-restart).
    # Poll with kill -0 until it exits.
    while kill -0 "$GW_PID" 2>/dev/null; do
      if [ "$SHUTTING_DOWN" = "true" ]; then break 2; fi
      sleep 5
    done
    GW_EXIT_CODE=0
  fi

  if [ "$SHUTTING_DOWN" = "true" ]; then
    break
  fi

  # --- Detect self-restart ---------------------------------------------------
  # Try up to 10 times (≈ 20 s) using all 3 tiers of find_gateway_daemon_pid.
  # Tier 3 (/proc scan) usually finds the daemon on the very first attempt
  # because the process exists immediately after fork, even before port bind
  # or process.title. The retries cover edge cases on extremely slow I/O.
  RESTARTED_PID=""
  if [ "$GATEWAY_MODE" != "remote" ]; then
    for _attempt in 1 2 3 4 5 6 7 8 9 10; do
      RESTARTED_PID=$(find_gateway_daemon_pid 2>/dev/null || true)
      [ -n "$RESTARTED_PID" ] && break
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
    GW_BOOT_START=$(date +%s)
    GW_PREV_BOOT_ALIVE=1
    continue
  fi

  # --- Final port guard ------------------------------------------------------
  # Even if all detection methods missed the daemon during the loop above,
  # the port may now be bound (the daemon finished initialising while we slept).
  # Never launch a duplicate if the port is occupied.
  if [ "$GATEWAY_MODE" != "remote" ] && \
     ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_INTERNAL_PORT} "; then
    PORT_PID=$(ss -tlnp 2>/dev/null \
      | grep ":${GATEWAY_INTERNAL_PORT} " \
      | sed -n 's/.*pid=\([0-9]*\).*/\1/p' \
      | head -1 || true)
    echo "INFO: Gateway port ${GATEWAY_INTERNAL_PORT} occupied by PID ${PORT_PID:-unknown}; monitoring."
    GW_PID="${PORT_PID:-$GW_PID}"
    GW_IS_CHILD=false
    GW_BOOT_START=$(date +%s)
    GW_PREV_BOOT_ALIVE=1
    continue
  fi

  # --- v0.7.13 (B8): exponential restart backoff -----------------------------
  # Boot health is sampled NOW (at exit detection), not after the detection
  # sleeps above — measuring after the sleeps was the peer add-on's bug that
  # pinned its backoff at 2s forever. Only a previous attempt that actually
  # booted (GW_PREV_BOOT_ALIVE) and survived >= 120s (comfortably above the
  # ~45s Pi cold start) resets the streak; a start that never came up (e.g.
  # blocked by the upgrade-backup gate) must NOT reset it, or the streak could
  # never trigger the doctor repair or grow the backoff.
  GW_BOOT_SECONDS=$(( $(date +%s) - ${GW_BOOT_START:-0} ))
  if [ "${GW_PREV_BOOT_ALIVE:-0}" = "1" ] && [ "$GW_BOOT_SECONDS" -ge 120 ]; then
    GW_CONSECUTIVE_FAILS=0
    echo "INFO: Previous gateway boot survived ${GW_BOOT_SECONDS}s; failure streak reset."
  fi
  GW_PREV_BOOT_ALIVE=0
  GW_CONSECUTIVE_FAILS=$((GW_CONSECUTIVE_FAILS + 1))

  # --- v0.7.13 (B4): automatic doctor repair gate ----------------------------
  # After 2 consecutive failed starts, run `openclaw doctor --fix
  # --non-interactive --yes` (documented non-interactive form) at most
  # GW_DOCTOR_REPAIR_MAX times per add-on start, snapshotting openclaw.json
  # first so the repair stays reversible. Doctor must never run against a live
  # gateway state — we are between starts here (runtime exited), and only in
  # local modes (remote mode must not repair a foreign gateway).
  if [ "$GATEWAY_MODE" != "remote" ] && [ "$GW_CONSECUTIVE_FAILS" -ge 2 ] && [ "$GW_DOCTOR_REPAIR_RUNS" -lt "$GW_DOCTOR_REPAIR_MAX" ]; then
    GW_DOCTOR_REPAIR_RUNS=$((GW_DOCTOR_REPAIR_RUNS + 1))
    echo "NOTICE: Gateway failed ${GW_CONSECUTIVE_FAILS} times in a row; running 'openclaw doctor --fix' (attempt ${GW_DOCTOR_REPAIR_RUNS}/${GW_DOCTOR_REPAIR_MAX})..."
    # Snapshot the live config first so the automatic repair stays reversible.
    DOCTOR_STAMP="$(date -u +%Y%m%d-%H%M%S)"
    cp -a "${OPENCLAW_CONFIG_DIR}/openclaw.json" "${OPENCLAW_CONFIG_DIR}/openclaw.json.pre-doctor-${DOCTOR_STAMP}" 2>/dev/null \
      || echo "WARN: Could not snapshot openclaw.json before doctor --fix; proceeding without snapshot."
    ls -1t "${OPENCLAW_CONFIG_DIR}"/openclaw.json.pre-doctor-* 2>/dev/null \
      | tail -n +6 \
      | while IFS= read -r old; do rm -f "$old" 2>/dev/null || true; done || true
    if timeout 300 openclaw doctor --fix --non-interactive --yes; then
      echo "INFO: 'openclaw doctor --fix' completed."
    else
      echo "WARN: 'openclaw doctor --fix' exited non-zero — repair may be incomplete."
    fi
  elif [ "$GW_CONSECUTIVE_FAILS" -ge 2 ]; then
    echo "WARN: doctor repair budget exhausted (runs=${GW_DOCTOR_REPAIR_RUNS}/${GW_DOCTOR_REPAIR_MAX}) or remote mode; continuing with backoff only."
  fi

  # Clamp the exponent BEFORE exponentiation (audit P1-2): bash 64-bit
  # arithmetic wraps at 2**63 (negative) — a wrapped value slips past the -gt 60
  # cap and feeds `sleep` a negative interval (empirically proven on arm64).
  if [ "$GW_CONSECUTIVE_FAILS" -ge 6 ]; then
    GW_BACKOFF=60
  else
    GW_BACKOFF=$((2 ** GW_CONSECUTIVE_FAILS))
  fi
  if [ "$GW_BACKOFF" -gt 60 ]; then
    GW_BACKOFF=60
  fi
  if [ "$GW_CONSECUTIVE_FAILS" -gt 5 ]; then
    echo "NOTICE: Still failing after ${GW_CONSECUTIVE_FAILS} starts. Diagnose via terminal: 'openclaw doctor' and the gateway log under /config/.openclaw/logs."
  fi
  echo "WARN: OpenClaw runtime exited with code ${GW_EXIT_CODE}. Restarting in ${GW_BACKOFF}s (failure streak: ${GW_CONSECUTIVE_FAILS})..."
  sleep "$GW_BACKOFF"

  # Stop the loopback relay BEFORE restarting the gateway (tailnet mode only).
  # The relay holds 127.0.0.1:GATEWAY_PORT — leaving it up causes the new gateway
  # to detect the port as occupied and exit with code 1, re-entering the loop.
  stop_gw_relay

  if ! start_openclaw_runtime; then
    echo "ERROR: Failed to restart OpenClaw runtime; retrying in ${GW_BACKOFF}s..."
    sleep "$GW_BACKOFF"
  else
    GW_IS_CHILD=true
    GW_BOOT_START=$(date +%s)
    GW_PREV_BOOT_ALIVE=1
    start_gw_relay
  fi
done
