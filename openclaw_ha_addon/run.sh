#!/usr/bin/env bash
set -euo pipefail

# Ensure Homebrew and brew-installed binaries are in PATH
# This is needed for OpenClaw skills that depend on CLI tools (gemini, aider, etc.)
# The brew directories are appended, not prepended: Homebrew ships its own
# Node.js release, and the OpenClaw CLI resolves `node` through PATH. With the
# brew prefix first, the CLI (and therefore `openclaw doctor` and
# `openclaw backup`) would run on a different runtime than the Gateway.
export PATH="${PATH}:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin"
OPENCLAW_NODE_BIN="/usr/bin/node"

# Home Assistant app options are usually rendered to /data/options.json
OPTIONS_FILE="/data/options.json"

if [ ! -f "$OPTIONS_FILE" ]; then
  echo "Missing $OPTIONS_FILE (app options)."
  exit 1
fi

# ------------------------------------------------------------------------------
# Options layout normalization (sections, v0.7.13.30+)
#
# The config schema groups options into collapsible sections (config.yaml
# "Options layout"). A pre-migration install stores the OLD flat layout.
# The schema change also means: a flat stored options file must be migrated
# ONCE (via the Supervisor options API) before a new-schema update boots —
# see DEPLOYMENT.md "Options sections migration". Until then the flat
# layout passes through unchanged below; a sectioned layout is flattened
# into the same view so every read keeps its exact has()-based semantics.
# ------------------------------------------------------------------------------

OPTIONS_FLAT="/tmp/options.flat.json"

# v0.7.13.30 restructure: surfaces + plugin switches top-level, groups
# ha_integration / harness / gateway_ext / logging_diag / safety_nets / legacy.
# Legacy flat stores (pre-migration, ollama_* / acp_additional_allowed_agents
# naming) keep their keys at top level — the individual reads below coalesce
# the renamed keys. enable_terminal is retired: the terminal is always on.
if jq -e 'has("harness") or has("ha_integration")' "$OPTIONS_FILE" >/dev/null 2>&1; then
  echo "DEBUG: options layout: sectioned -> flattening for reads"
  jq '
    {
      timezone: .timezone,
      network_mode: .network_mode,
      gateway_port: .gateway_port,
      gateway_mode: .gateway_mode,
      gateway_env_vars: .gateway_env_vars,
      terminal_port: .terminal_port,
      enable_webui: .enable_webui,
      enable_docs: .enable_docs,
      acpx_enabled: .acpx_enabled,
      harness_config_writer_enabled: .harness_config_writer_enabled,
      homeassistant_token: .ha_integration.homeassistant_token,
      mcp_urls: .ha_integration.mcp_urls,
      mcp_enabled: .ha_integration.mcp_enabled,
      ha_official_mcp_url: .ha_integration.ha_official_mcp_url,
      ha_official_mcp_enabled: .ha_integration.ha_official_mcp_enabled,
      http_proxy: .ha_integration.http_proxy,
      enable_openai_api: .ha_integration.enable_openai_api,
      harness_base_url: .harness.harness_base_url,
      harness_api_key: .harness.harness_api_key,
      harness_model: .harness.harness_model,
      utility_model: .harness.utility_model,
      harness_opencode_model: .harness.harness_opencode_model,
      harness_claude_model: .harness.harness_claude_model,
      harness_codex_model: .harness.harness_codex_model,
      harness_pi_model: .harness.harness_pi_model,
      harness_excluded_agents: .harness.harness_excluded_agents,
      additional_agents: .harness.additional_agents,
      gateway_public_url: .gateway_ext.gateway_public_url,
      gateway_remote_url: .gateway_ext.gateway_remote_url,
      gateway_trusted_proxies: .gateway_ext.gateway_trusted_proxies,
      gateway_additional_allowed_origins: .gateway_ext.gateway_additional_allowed_origins,
      gateway_log_to_console: .logging_diag.gateway_log_to_console,
      gateway_log_level: .logging_diag.gateway_log_level,
      trace_log_to_console: .logging_diag.trace_log_to_console,
      gateway_startup_trace: .logging_diag.gateway_startup_trace,
      nginx_log_level: .logging_diag.nginx_log_level,
      force_ipv4_dns: .logging_diag.force_ipv4_dns,
      mdns_mode: .logging_diag.mdns_mode,
      mdns_host_name: .logging_diag.mdns_host_name,
      abort_on_upgrade_backup_failure: .safety_nets.abort_on_upgrade_backup_failure,
      upgrade_backup_keep: .safety_nets.upgrade_backup_keep,
      gateway_doctor_repair_max: .safety_nets.gateway_doctor_repair_max,
      gateway_doctor_repair_timeout: .safety_nets.gateway_doctor_repair_timeout,
      gateway_doctor_capture_keep: .safety_nets.gateway_doctor_capture_keep,
      runtime_apt_packages: .runtime.runtime_apt_packages,
      custom_init_script: .runtime.custom_init_script,
      blocked_hostnames: .runtime.blocked_hostnames,
      controlui_disable_device_auth: .legacy.controlui_disable_device_auth
    }
  ' "$OPTIONS_FILE" > "$OPTIONS_FLAT"
  OPTIONS_FILE="$OPTIONS_FLAT"
else
  echo "DEBUG: options layout: legacy flat (sections not set) -> passthrough"
fi

# ------------------------------------------------------------------------------
# Read app options (only app-specific knobs; OpenClaw is configured via onboarding)
# ------------------------------------------------------------------------------

TZNAME=$(jq -r '.timezone // "Europe/Berlin"' "$OPTIONS_FILE")
GW_PUBLIC_URL=$(jq -r '.gateway_public_url // empty' "$OPTIONS_FILE")
HA_TOKEN=$(jq -r '.homeassistant_token // empty' "$OPTIONS_FILE")
# Way 3: comma-separated list of community/custom MCP server URLs. The secret
# is part of each URL. Way 2: the official Home Assistant MCP server.
MCP_URLS=$(jq -r '.mcp_urls // empty' "$OPTIONS_FILE")
MCP_ENABLED=$(jq -r 'if .mcp_enabled == null then true else (.mcp_enabled | tostring) end' "$OPTIONS_FILE")
HA_OFFICIAL_MCP_URL=$(jq -r '.ha_official_mcp_url // empty' "$OPTIONS_FILE")
HA_OFFICIAL_MCP_ENABLED=$(jq -r 'if .ha_official_mcp_enabled == null then false else (.ha_official_mcp_enabled | tostring) end' "$OPTIONS_FILE")
ADDON_HTTP_PROXY=$(jq -r '.http_proxy // empty' "$OPTIONS_FILE")
# enable_terminal is retired: the web terminal is always on (Ingress
# maintenance/repair surface); only terminal_port is configurable.
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

echo "DEBUG: terminal_port config value: '$TERMINAL_PORT' (validated)"

# Generic router SSH settings

# Optional: allow disabling lock cleanup if you ever need to debug

# Gateway configuration
GATEWAY_MODE=$(jq -r '.gateway_mode // "local"' "$OPTIONS_FILE")
GATEWAY_REMOTE_URL=$(jq -r '.gateway_remote_url // empty' "$OPTIONS_FILE")
NETWORK_MODE=$(jq -r '.network_mode // "ingress_only"' "$OPTIONS_FILE")
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")
# Validate at the boundary (follow-up audit): downstream users rely on a
# numeric port — bash arithmetic ($((GATEWAY_PORT + 1))), render_nginx.py
# and the openclaw.json bootstrap all run before/without re-checks.
if [[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] && [ "$GATEWAY_PORT" -ge 1024 ] && [ "$GATEWAY_PORT" -le 65535 ]; then
  :
else
  echo "ERROR: Invalid gateway_port '$GATEWAY_PORT'. Must be numeric 1024-65535. Using default 18789."
  GATEWAY_PORT="18789"
fi
ENABLE_OPENAI_API=$(jq -r '.enable_openai_api // false' "$OPTIONS_FILE")
GATEWAY_TRUSTED_PROXIES=$(jq -r '.gateway_trusted_proxies // empty' "$OPTIONS_FILE")
GATEWAY_ADDITIONAL_ALLOWED_ORIGINS=$(jq -r '.gateway_additional_allowed_origins // empty' "$OPTIONS_FILE")
CONTROLUI_DISABLE_DEVICE_AUTH=$(jq -r 'if has("controlui_disable_device_auth") then (.controlui_disable_device_auth|tostring) else "true" end' "$OPTIONS_FILE")
FORCE_IPV4_DNS=$(jq -r 'if has("force_ipv4_dns") then (.force_ipv4_dns|tostring) else "true" end' "$OPTIONS_FILE")
NGINX_LOG_LEVEL=$(jq -r '.nginx_log_level // "minimal"' "$OPTIONS_FILE")
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

# Harness backend endpoint (any OpenAI-compatible API, not just Ollama —
# v0.7.13.30 renamed/restructured: harness_base_url replaces ollama_base_url).
# Feeds the acpx wrapper templates AND the ambient Anthropic/OpenAI-compatible
# routing below. Empty/unset falls back to the built-in localhost default (the
# value the old option default provided), so the wrappers never see an empty
# endpoint.
# NOTE on the coalesces below: jq's `//` does NOT fall through on an empty
# string ("" is truthy), so a plain `new // old` read would shadow a legacy
# value with the new key's empty default. Every coalesce therefore drops
# empty-string new values via `select(length > 0)` before falling back to the
# legacy key.
HARNESS_BASE_URL=$(jq -r '(.harness_base_url // "" | select(length > 0)) // .ollama_base_url // empty' "$OPTIONS_FILE")
export OLLAMA_BASE_URL="${HARNESS_BASE_URL:-http://localhost:11434}"
# Harness model overrides + user-owned allowed agent extras (generic app rule,
# GaRoN 2026-10-10): forwarded as env for oc_acpx_helper.py + acpx templates.
# v0.7.13.30 renames (harness_* / additional_agents) coalesced with the legacy
# ollama_acp_* / acp_additional_allowed_agents keys for pre-migration stores.
# v0.7.13.30 gating (Owner decision 2026-10-15): with NO harness_base_url set,
# EVERY value below the switches in the acp/harness world is IGNORED — only
# the switches apply (a harness world without a backend endpoint has no
# meaning). The helpers keep their built-in defaults for wrapper infra.
if [ -n "$HARNESS_BASE_URL" ]; then
  export OLLAMA_CODEX_MODEL=$(jq -r '(.harness_codex_model // "" | select(length > 0)) // .ollama_acp_codex_model // empty' "$OPTIONS_FILE")
  export OLLAMA_OPENCODE_MODEL=$(jq -r '(.harness_opencode_model // "" | select(length > 0)) // .ollama_acp_opencode_model // empty' "$OPTIONS_FILE")
  # γ (2026-10-13): third flagship harness default (claude) — mirrors the
  # helper's _writer_model_for claude ladder (OLLAMA_CLAUDE_MODEL → legacy
  # OLLAMA_ACP_MODEL → default glm-5.3-flash:cloud).
  export OLLAMA_CLAUDE_MODEL=$(jq -r '(.harness_claude_model // "" | select(length > 0)) // .ollama_acp_claude_model // empty' "$OPTIONS_FILE")
  # pi (2026-11-13): the pi harness default — mirrors the helper's
  # _writer_model_for pi ladder (OLLAMA_PI_MODEL → default kimi-k2.7-code:cloud;
  # pi is a coding agent, so the default is a coding model).
  export OLLAMA_PI_MODEL=$(jq -r '(.harness_pi_model // "" | select(length > 0)) // .ollama_acp_pi_model // empty' "$OPTIONS_FILE")
  export ACP_ADDITIONAL_ALLOWED_AGENTS=$(jq -r '(.additional_agents // "" | select(length > 0)) // .acp_additional_allowed_agents // empty' "$OPTIONS_FILE")
  # V36.2 (2026-10-13): utility_model → agents.defaults.utilityModel (helper
  # merge_utility_model). UNSET/empty = no write — operator owns the value.
  export OPENCLAW_UTILITY_MODEL=$(jq -r '.utility_model // empty' "$OPTIONS_FILE" 2>/dev/null)
else
  echo "INFO: harness_base_url not configured — harness-group values (models, utility_model, additional_agents) are IGNORED; only the switches apply"
fi
# Repo-Split A2 (2026-10-11): the harness-config-writer is its own plugin.
# v0.7.13.30: INDEPENDENT switch, default false. It only runs when explicitly true AND does
# nothing without HARNESS_WRITER_BASE_URL below (base_url = activator).
export HARNESS_CONFIG_WRITER_ENABLED=$(jq -r '.harness_config_writer_enabled // empty' "$OPTIONS_FILE" 2>/dev/null)

# Kammerjäger #1 (Restart-Log 2026-10-11): startup trace — per-phase/plugin
# breakdown of the gateway boot ("startup trace: plugins.runtime-post-bind
# …ms" lines). Diagnostic option, default off.
export OPENCLAW_GATEWAY_STARTUP_TRACE=$(jq -r '.gateway_startup_trace // false' "$OPTIONS_FILE" 2>/dev/null)

# Add-on-Level-Harness-Defaults (GaRoN 2026-10-11): shared writer defaults.
# base_url is the ACTIVATOR (empty = no generation); model applies to all
# non-excluded harnesses (codex/opencode keep their dedicated harness_*_model
# defaults unless set); excluded_agents is comma-separated harness ids.
# STRICT read on the new key: the writer activates only when the migrated
# sectioned options carry harness_base_url — the ollama_base_url legacy name
# feeds the wrappers (via OLLAMA_BASE_URL above) but does NOT start generation
# before the options migration ran.
export HARNESS_WRITER_BASE_URL=$(jq -r '.harness_base_url // empty' "$OPTIONS_FILE" 2>/dev/null)
export HARNESS_WRITER_MODEL=$(jq -r '.harness_model // empty' "$OPTIONS_FILE" 2>/dev/null)
export HARNESS_WRITER_API_KEY=$(jq -r '.harness_api_key // empty' "$OPTIONS_FILE" 2>/dev/null)
export HARNESS_WRITER_EXCLUDED_AGENTS=$(jq -r '.harness_excluded_agents // empty' "$OPTIONS_FILE" 2>/dev/null)

# (utility_model → OPENCLAW_UTILITY_MODEL is exported in the BASE_URL-gated
# block above: without a harness_base_url it is ignored like the rest of the
# acp/harness group values — only the switches apply.)

# Local-model provider routing for ACP harnesses (verified 2026-10-09):
# The acpx generated codex/claude wrappers passthrough this ambient env, so
# Claude Code reaches the Ollama backend without any custom wrapper.
# ANTHROPIC_MODEL is the Claude Code harness model; override per app option
# if a different Ollama model is wanted for Claude sessions.
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_BASE_URL="$OLLAMA_BASE_URL"
  export ANTHROPIC_AUTH_TOKEN="ollama"
  # γ (2026-10-13): ambient ladder mirrors the helper's claude default
  # (ollama_acp_claude_model → legacy OLLAMA_ACP_MODEL → default).
  export ANTHROPIC_MODEL="${OLLAMA_CLAUDE_MODEL:-${OLLAMA_ACP_MODEL:-glm-5.3-flash:cloud}}"
fi


# Runtime extensibility (was defined in config.yaml but never read — Audit R5/R6)
RUNTIME_APT_PACKAGES=$(jq -r '.runtime_apt_packages // empty' "$OPTIONS_FILE")
CUSTOM_INIT_SCRIPT=$(jq -r '.custom_init_script // empty' "$OPTIONS_FILE")

# OpenClaw 2026.9.1 configuration controls
BLOCKED_HOSTNAMES=$(jq -r '.blocked_hostnames // empty' "$OPTIONS_FILE")

# --- v0.7.13 safety-net options (jq has-guard per V7 pattern: explicit false wins) ---
ABORT_ON_UPGRADE_BACKUP_FAILURE=$(jq -r 'if has("abort_on_upgrade_backup_failure") then (.abort_on_upgrade_backup_failure|tostring) else "true" end' "$OPTIONS_FILE")
UPGRADE_BACKUP_KEEP=$(jq -r 'if has("upgrade_backup_keep") and (.upgrade_backup_keep != null) then (.upgrade_backup_keep|tonumber) else 3 end' "$OPTIONS_FILE")
GW_DOCTOR_REPAIR_MAX=$(jq -r 'if has("gateway_doctor_repair_max") and (.gateway_doctor_repair_max != null) then (.gateway_doctor_repair_max|tonumber) else 3 end' "$OPTIONS_FILE")
# Timeout for one automatic repair run (seconds). The repair has to finish: with
# several agent databases the full inspection set takes far longer than 300 s.
# Thirteen multi-GB agent databases each require an integrity check before the
# schema migration, so the default funds two hours per repair invocation. The
# measured duration is logged after every invocation to guide an explicit
# operator override. Clamped to 300..7200 s.
if ! GW_DOCTOR_REPAIR_TIMEOUT=$(jq -r 'if has("gateway_doctor_repair_timeout") and (.gateway_doctor_repair_timeout != null) then (.gateway_doctor_repair_timeout|tonumber) else 7200 end' "$OPTIONS_FILE"); then
  GW_DOCTOR_REPAIR_TIMEOUT=7200
  echo "WARN: Could not read gateway_doctor_repair_timeout from $OPTIONS_FILE; using the built-in default of 7200s." >&2
fi
case "$GW_DOCTOR_REPAIR_TIMEOUT" in
  ''|*[!0-9]*) GW_DOCTOR_REPAIR_TIMEOUT=7200 ;;
esac
if [ "$GW_DOCTOR_REPAIR_TIMEOUT" -lt 300 ]; then GW_DOCTOR_REPAIR_TIMEOUT=300; fi
if [ "$GW_DOCTOR_REPAIR_TIMEOUT" -gt 7200 ]; then GW_DOCTOR_REPAIR_TIMEOUT=7200; fi
# How many `doctor --fix` snapshots to keep. Every repair run snapshots the
# complete agent database set (1-6 GB per run), so an unbounded number of
# snapshots fills the config volume and every snapshot copy pulls gigabytes
# through the page cache.
GW_DOCTOR_CAPTURE_KEEP=$(jq -r 'if has("gateway_doctor_capture_keep") and (.gateway_doctor_capture_keep != null) then (.gateway_doctor_capture_keep|tonumber) else 2 end' "$OPTIONS_FILE")
case "$GW_DOCTOR_CAPTURE_KEEP" in
  ''|*[!0-9]*) GW_DOCTOR_CAPTURE_KEEP=2 ;;
esac
if [ "$GW_DOCTOR_CAPTURE_KEEP" -lt 1 ]; then GW_DOCTOR_CAPTURE_KEEP=1; fi
if [ "$GW_DOCTOR_CAPTURE_KEEP" -gt 10 ]; then GW_DOCTOR_CAPTURE_KEEP=10; fi

# ACPX harnesses (Claude Code, Codex, OpenCode). Default OFF (v0.7.13.30):
# acpx_enabled and harness_config_writer_enabled are independent opt-ins.
ACPX_ENABLED=$(jq -r 'if has("acpx_enabled") then (.acpx_enabled|tostring) else "false" end' "$OPTIONS_FILE")

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
      echo "ERROR: Set it to your reverse proxy's IP/CIDR (e.g. 127.0.0.1,198.51.100.0/24)."
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

# Force the native OpenClaw bonjour advertiser to match the mDNS option.
# OpenClaw auto-disables LAN mDNS advertising when it detects a container
# (isDisabledByEnv: OPENCLAW_DISABLE_BONJOUR unset -> isContainerEnvironment()).
# This addon runs host-networked (host_network: true), so multicast reaches the
# LAN directly; without this export the native responder silently never runs
# even though discovery.mdns.mode is set — that was the openclaw.local outage.
# OPENCLAW_DISABLE_BONJOUR is also protected from gateway_env_vars overrides
# (reserved OPENCLAW_* pattern), so run.sh's decision here is authoritative.
if [ "$MDNS_MODE" = "off" ]; then
  export OPENCLAW_DISABLE_BONJOUR="true"
  echo "INFO: mDNS mode 'off' — native bonjour advertising explicitly disabled"
else
  export OPENCLAW_DISABLE_BONJOUR="false"
  echo "INFO: mDNS mode '$MDNS_MODE' — native bonjour advertising enabled (host networking: multicast reaches the LAN)"
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
# ------------------------------------------------------------------------------
# Bundled OpenClaw skills stay package-local (v0.7.13.38).
# The bundled skills ship inside the OpenClaw package and are loaded from
# there. OpenClaw additionally loads MANAGED skills from
# $OPENCLAW_CONFIG_DIR/skills with higher precedence, so operator-added and
# operator-edited skills keep working from the persistent directory without
# any copy or symlink.
# Copying the bundles into the state directory was removed on purpose: those
# copies would shadow every future bundle update (managed skills win).
# Replacing the package directory with a symlink was removed because it broke
# the package-swap rollback scan of an OpenClaw runtime update
# ("Package rollback symlink leaves the retained tree"), and the gateway
# never runs a runtime update inside the container - runtime updates ship
# exclusively with a new add-on release.
# Existing managed skills in /config/.openclaw/skills are preserved as-is;
# they retain managed precedence. Remove a copied skill there when it should
# follow the bundled update again.
# NOTE: We cannot use `npm root -g` with the regular HOME here because
# HOME=/config may contain a persisted .npmrc with a custom prefix set below.
# ------------------------------------------------------------------------------
IMAGE_SKILLS_DIR="$(HOME=/root npm root -g 2>/dev/null)/openclaw/skills"
if [ -d "$IMAGE_SKILLS_DIR" ]; then
  echo "INFO: Bundled skills remain package-local at $IMAGE_SKILLS_DIR (managed skills dir: $OPENCLAW_CONFIG_DIR/skills)"
else
  echo "WARN: Bundled skills directory not found at $IMAGE_SKILLS_DIR"
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
export NODE_PATH="${PERSISTENT_NODE_GLOBAL}/lib/node_modules${NODE_PATH:+:${NODE_PATH}}"

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
    # SECURITY (audit): app-validated runtime variables consumed by run.sh
    # (nginx/node-relay config rendering, port guards, cert SANs). Allowing
    # them via gateway_env_vars would invalidate the explicit validation
    # run.sh and render_nginx.py perform (nginx/node config injection vector).
    GATEWAY_PORT|GATEWAY_INTERNAL_PORT|GATEWAY_MODE|GATEWAY_BIND|GATEWAY_AUTH_MODE|GATEWAY_REMOTE_URL|GATEWAY_TLS_ENABLED|GATEWAY_TLS_AUTO|GATEWAY_LOG_LEVEL|GATEWAY_TRUSTED_PROXIES|NETWORK_MODE|ACCESS_MODE|INGRESS_PORT|TERMINAL_PORT|HTTPS_PROXY_PORT|ENABLE_HTTPS_PROXY|CERTS_DIR|LAN_IP|GW_PUBLIC_URL|GW_TOKEN|NGINX_LOG_LEVEL|SHOW_WEBUI|SHOW_TERMINAL|SHOW_DOCS|TAILSCALE_MODE|GATEWAY_ADDITIONAL_ALLOWED_ORIGINS|MDNS_MODE|CONTROLUI_DISABLE_DEVICE_AUTH|ACPX_ENABLED|ENABLE_OPENAI_API|BLOCKED_HOSTNAMES|MCP_URLS|MCP_ENABLED|HA_OFFICIAL_MCP_URL|HA_OFFICIAL_MCP_ENABLED|TRACE_LOG_TO_CONSOLE|GATEWAY_LOG_TO_CONSOLE)
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
  # Unlike the bundled skills (v0.7.13.38), the symlink stays correct here:
  # brew lives outside the OpenClaw package tree, so the runtime's package-swap
  # rollback scan never sees it, and Homebrew has no native persistence in the
  # state directory to replace this mechanism with.
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

# The package-manager Node belongs to the image, unlike the Homebrew tree
# above which may have been restored from /config. Check that exact binary
# before any gateway process is launched.
verify_openclaw_node() {
  local node_bin="${1:-$OPENCLAW_NODE_BIN}" version raw
  if [ ! -x "$node_bin" ]; then
    echo "ERROR: OpenClaw Node runtime is missing or not executable: ${node_bin}"
    return 1
  fi
  if ! raw="$("${node_bin}" --version 2>&1)"; then
    echo "ERROR: OpenClaw Node runtime ${node_bin} failed its engine check: ${raw}"
    return 1
  fi
  version="$(printf '%s' "${raw}" | sed 's/^v//')"
  if [ -z "${version}" ]; then
    echo "ERROR: OpenClaw Node runtime ${node_bin} failed its engine check: the Node version could not be read"
    return 1
  fi
  # The engine range and the secure patch floor are checked with the same
  # helper the image build used, against the *installed* OpenClaw package. No
  # second copy of the range lives in this script.
  local helper="/usr/local/lib/openclaw/oc_node_version.py"
  local package_json="/usr/lib/node_modules/openclaw/package.json"
  if [ ! -f "${package_json}" ]; then
    package_json="$(npm root -g 2>/dev/null)/openclaw/package.json"
  fi
  if [ -f "${helper}" ] && [ -f "${package_json}" ] && command -v python3 >/dev/null 2>&1; then
    if ! python3 "${helper}" --package-json "${package_json}" --runtime-floors "$(dirname "${package_json}")" --verify "${version}"; then
      echo "ERROR: OpenClaw Node runtime ${node_bin} (${version}) does not satisfy the engine range and the secure patch floor of the installed OpenClaw package."
      return 1
    fi
  else
    # Emergency anchor only. Without the helper the exact engine range and the
    # secure patch floor cannot be checked at runtime. This rejects a Node
    # that is clearly older than every supported line; everything else is
    # left to the build-time gate, which verified the range and the floor.
    case "${version}" in
      24.*|25.*|26.*|27.*|28.*|29.*|3[0-9].*) ;;
      *)
        echo "ERROR: unsupported Node ${version}; the OpenClaw runtime requires a Node.js release of the 24.x line or newer"
        return 1
        ;;
    esac
    echo "WARN: the Node engine helper is not installed; the exact engine range and the secure patch floor were NOT checked at runtime (the build-time gate verified them)."
  fi
  echo "INFO: OpenClaw Node runtime: ${node_bin} (process.versions.node=${version})"
}

# OpenClaw and every child it spawns inherit this path. /usr/bin therefore
# wins over both persistent npm/pnpm bins and the persistent Homebrew Node,
# without hiding any of those tools from the rest of the add-on.
openclaw_exec_with_image_node() {
  PATH="/usr/bin:/bin:${PATH}" exec "$@"
}

verify_openclaw_node

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

# A gateway candidate must have a complete daemon argv, not merely a familiar
# substring. Read the kernel's NUL-separated argv and require one of our two
# supported launch shapes (CLI wrapper or long-running dist entrypoint).
oc_gateway_pid_is_daemon() {
  local pid="$1" item program entry command action
  local cursor=0
  local -a raw=() argv=()

  [ -r "/proc/${pid}/cmdline" ] || return 1
  mapfile -d '' -t raw < "/proc/${pid}/cmdline" 2>/dev/null || true
  for item in "${raw[@]}"; do
    [ -n "$item" ] && argv+=("$item")
  done
  [ "${#argv[@]}" -gt 0 ] || return 1

  if [ "${#argv[@]}" -eq 1 ] && [ "${argv[0]}" = "openclaw-gateway" ]; then
    return 0
  fi

  program="${argv[0]##*/}"
  if [ "$program" = "node" ] || [ "$program" = "nodejs" ]; then
    cursor=1
  fi
  [ "${#argv[@]}" -ge $((cursor + 3)) ] || return 1
  entry="${argv[$cursor]}"
  command="${argv[$((cursor + 1))]}"
  action="${argv[$((cursor + 2))]}"
  [ "$command" = "gateway" ] || return 1
  case "$action" in
    run|-*) ;;
    *) return 1 ;;
  esac

  case "${entry##*/}" in
    openclaw|openclaw.mjs|openclaw.js) return 0 ;;
    index.js)
      [[ "$entry" == */openclaw/dist/index.js ]] && return 0
      ;;
  esac
  return 1
}

gateway_running() {
  local f pid
  for f in /proc/[0-9]*/cmdline; do
    pid="${f#/proc/}"
    pid="${pid%%/*}"
    if oc_gateway_pid_is_daemon "$pid"; then
      return 0
    fi
  done
  return 1
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

configure_homeassistant_api_token() {
  [ -n "$HA_TOKEN" ] || return 0
  local token_path="${1:-/config/secrets/homeassistant.token}"

  # Audit: the umask used to be set globally here, leaking 077 into the rest
  # of boot (backup archives, cert files, helper writes) conditionally on
  # whether an HA token was set. Keep the tight mode local to the token file.
  (
    umask 077
    printf '%s' "$HA_TOKEN" > "$token_path"
  )
  # Deliberately do not probe the API token at startup. Repeated authentication
  # failures can trigger Home Assistant IP bans; storage is the way-1 no-op gate.
  echo "INFO: Home Assistant connection way 1 (API, long-lived token): token stored for API/Assist/scripts"
}
configure_homeassistant_api_token


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
GW_AUTO_DOCTOR_LATCH="false"
# Grace period after a (re)start: the port binds ~1 s later. Without it the
# watchdog fired inside that window and killed the freshly started ttyd.
TTYD_GRACE_UNTIL=0
SHUTTING_DOWN="false"

# Bounded stop helper.
# Why: an unbounded `wait` blocks until the child exits. The gateway drains up to
# 330 s (Gateway stop policy=330000ms), so PID 1 stayed alive long past
# Docker's 10 s stop budget -> Docker SIGKILLs the container -> "exited with
# non-zero exit code 137". Poll first (bounded by the shared shutdown
# deadline), then escalate to KILL, then reap.
SHUTDOWN_DEADLINE=0
shutdown_budget_left() {
  local left=$(( SHUTDOWN_DEADLINE - $(date +%s) ))
  [ "${left}" -lt 1 ] && left=1
  echo "${left}"
}
stop_pid_bounded() {
  local pid="$1" label="$2" budget="${3:-3}" i left
  [ -n "${pid}" ] || return 0
  kill -0 "${pid}" 2>/dev/null || return 0
  kill -TERM "${pid}" 2>/dev/null || true
  left=$(shutdown_budget_left)
  [ "${left}" -lt "${budget}" ] && budget="${left}"
  for ((i = 0; i < budget; i++)); do
    kill -0 "${pid}" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "${pid}" 2>/dev/null; then
    echo "WARN: ${label} did not exit on SIGTERM within ${budget}s; escalating to KILL."
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  wait "${pid}" 2>/dev/null || true
}

release_automatic_doctor_latch() {
  [ "${GW_AUTO_DOCTOR_LATCH:-false}" = "true" ] || return 0
  local flag="${GATEWAY_MAINTENANCE_FLAG:-${OPENCLAW_CONFIG_DIR}/.gateway-maintenance}"
  if rm -f -- "$flag"; then
    GW_AUTO_DOCTOR_LATCH="false"
    echo "INFO: Automatic doctor repair released maintenance latch ($flag); gateway supervision may resume."
    return 0
  fi
  echo "ERROR: Automatic doctor repair could not release maintenance latch ($flag); gateway remains held down for safety."
  return 1
}

# Fold the SQLite write-ahead logs back into the databases so the next start
# does not have to replay them. The gateway is killed by Docker's stop budget
# long before its own drain finishes, so without this every restart pays for
# WAL recovery. Best effort: a failure only costs recovery time.
checkpoint_agent_databases() {
  local cfg="${OPENCLAW_CONFIG_PATH:-/config/.openclaw/openclaw.json}"
  command -v python3 >/dev/null 2>&1 || {
    echo "INFO: python3 unavailable; skipping the SQLite checkpoint."
    return 0
  }
  [ -f "${cfg}" ] || return 0
  timeout 2 python3 - "${cfg}" <<'PY' || echo "WARN: SQLite checkpoint failed; the next start replays the WAL."
import glob
import json
import os
import sqlite3
import sys

config_path = sys.argv[1]
state_dir = os.path.dirname(config_path)
paths = [os.path.join(state_dir, "state", "openclaw.sqlite")]
try:
    with open(config_path, encoding="utf-8") as handle:
        config = json.load(handle)
except Exception:
    config = {}
for entry in (config.get("agents", {}).get("entries", {}) or {}).values():
    agent_dir = (entry or {}).get("agentDir")
    if agent_dir:
        paths.append(os.path.join(agent_dir, "openclaw-agent.sqlite"))
# The default side stores live next to the state directory. They only carry
# bookkeeping rows, but their write-ahead logs are folded as well.
paths.extend(
    sorted(
        glob.glob(
            os.path.join(state_dir, "agents", "*", "**", "openclaw-agent.sqlite"),
            recursive=True,
        )
    )
)
seen = set()
checked = 0
for path in paths:
    if not path or path in seen:
        continue
    seen.add(path)
    if not os.path.exists(path):
        continue
    try:
        connection = sqlite3.connect(path, timeout=1)
        try:
            row = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        finally:
            connection.close()
        checked += 1
        if row and int(row[0]) != 0:
            print(f"WARN: SQLite checkpoint was busy for {path}; the next start replays its WAL.")
    except Exception as error:
        print(f"WARN: SQLite checkpoint failed for {path}: {error}")
if checked:
    print(f"INFO: SQLite write-ahead logs folded into {checked} databases.")
else:
    print("INFO: no SQLite database needed a checkpoint.")
PY
}

stop_gw_relay() {
  if [ -n "${GW_RELAY_PID}" ] && kill -0 "${GW_RELAY_PID}" >/dev/null 2>&1; then
    kill -TERM "${GW_RELAY_PID}" >/dev/null 2>&1 || true
    wait "${GW_RELAY_PID}" 2>/dev/null || true
    GW_RELAY_PID=""
  fi
}

shutdown() {
  if [ "${SHUTTING_DOWN:-}" = "true" ]; then
    echo "INFO: shutdown is already in progress; ignoring the additional signal."
    return 0
  fi
  SHUTTING_DOWN="true"
  # Only a latch acquired by the automatic repair is released here. An
  # operator-owned maintenance hold is deliberately preserved across shutdown.
  release_automatic_doctor_latch || true
  # Docker's stop budget is ~10 s; reserve 8 s for all children, 2 s for cleanup.
  SHUTDOWN_DEADLINE=$(( $(date +%s) + 8 ))
  echo "Shutdown requested; stopping services..."

  # The Gateway is stopped first (below) so it gets the largest slice of the
  # budget: its own drain is planned for up to 325 s and Docker's 10 s stop
  # budget always kills it mid-drain. The other services follow in parallel
  # afterwards so everything still fits into the stop window.

  if [ -n "${GW_PID}" ] && kill -0 "${GW_PID}" >/dev/null 2>&1; then
    kill -TERM "${GW_PID}" >/dev/null 2>&1 || true
    # wait reaps child PIDs; for non-child (re-tracked) PIDs it fails instantly,
    # so fall back to a timed kill -0 poll to let the gateway finish cleanly.
    # v0.7.13.35 escalation: a live-locked/busy daemon never reaps on TERM and
    # Docker's 10 s stop budget then SIGKILLs it mid-write (the recurring
    # "addon stops with an error" report). Escalate inside our own budget
    # instead: 3 s poll → KILL → 1 s re-check, so run.sh exits well before
    # Docker's deadline with all cleanup (relay, pid files, locks) done.
    # Poll FIRST (bounded by the shared shutdown deadline), then escalate, then reap.
    # The previous `wait` blocked for the gateway's 330 s drain, so the
    # escalation below was unreachable and Docker's 10 s budget SIGKILLed us.
    _gw_left=$(shutdown_budget_left)
    [ "${_gw_left}" -gt 3 ] && _gw_left=3
    for _i in $(seq 1 "${_gw_left}"); do
      kill -0 "${GW_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${GW_PID}" 2>/dev/null; then
      echo "WARN: gateway did not exit on SIGTERM; escalating to KILL (shutdown budget)."
      kill -KILL "${GW_PID}" 2>/dev/null || true
      for _i in 1 2; do
        kill -0 "${GW_PID}" 2>/dev/null || break
        sleep 1
      done
    fi
    wait "${GW_PID}" 2>/dev/null || true
  fi

  # The gateway is gone: fold its write-ahead logs back into the databases so
  # the next start does not have to replay them. The checkpoint runs in
  # parallel with the service stop - it only needs the SQLite files and the
  # gateway (the only writer) is already dead. That keeps the whole shutdown
  # inside Docker's ~10 s stop budget.
  checkpoint_agent_databases &
  _checkpoint_wait=$!

  # nginx and the terminal stop together, Avahi and D-Bus after them: reverse
  # startup order, but inside Docker's stop budget.
  stop_pid_bounded "${NGINX_PID}" "nginx" 2 &
  _nginx_wait=$!
  stop_pid_bounded "${TTYD_PID}" "ttyd" 2 &
  _ttyd_wait=$!
  # Stop Avahi before D-Bus; reverse startup order.
  stop_pid_bounded "${AVAHI_PID:-}" "avahi" 1 &
  _avahi_wait=$!
  # Stop the D-Bus daemon we started, if still running.
  stop_pid_bounded "${DBUS_PID:-}" "dbus" 1 &
  _dbus_wait=$!
  wait "${_nginx_wait}" || true
  wait "${_ttyd_wait}" || true
  wait "${_avahi_wait}" || true
  wait "${_dbus_wait}" || true
  wait "${_checkpoint_wait}" || true

  # Reap the stopped services: they are children of this shell, so the
  # background subshells above could not wait for them.
  for _reap_pid in "${NGINX_PID:-}" "${TTYD_PID:-}" "${AVAHI_PID:-}" "${DBUS_PID:-}"; do
    if [ -n "${_reap_pid}" ]; then
      wait "${_reap_pid}" 2>/dev/null || true
    fi
  done

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

# A relay left over from a previous run still holds the loopback port and
# would keep the new gateway from binding it. It is stopped before the trap
# is installed, so no start attempt can run into a stale relay.
stop_gw_relay || true

trap shutdown INT TERM

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw is not installed."
  exit 1
fi

# Bootstrap minimal OpenClaw config ONLY if missing.
# We do not overwrite or patch existing configs; onboarding owns everything else.
OPENCLAW_CONFIG_PATH="/config/.openclaw/openclaw.json"
if [ ! -f "$OPENCLAW_CONFIG_PATH" ] && compgen -G "${OPENCLAW_CONFIG_PATH}.corrupt*" >/dev/null 2>&1; then
  echo "ERROR: a corrupt openclaw.json was quarantined earlier (${OPENCLAW_CONFIG_PATH}.corrupt*)."
  echo "ERROR: Restore/repair it manually and restart. NOTE: the web terminal is NOT"
  echo "ERROR: available for this (fail-closed) state — repair from the Home Assistant"
  echo "ERROR: host instead: the config folder is shared via the 'addon_configs' storage"
  echo "ERROR: (Samba share 'addon_configs' or an SSH/Terminal add-on at"
  echo "ERROR: /mnt/data/supervisor/addon_configs/). A .corrupt copy or a"
  echo "ERROR: pre-upgrade backup archive can be renamed back to openclaw.json."
  echo "ERROR: NOT bootstrapping a fresh stub — a stub would silently replace the real configuration."
  exit 1
fi
if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "INFO: OpenClaw config missing; bootstrapping minimal config at $OPENCLAW_CONFIG_PATH"
  python3 - <<'PY'
import json
import os
import secrets
from pathlib import Path

cfg_path = Path('/config/.openclaw/openclaw.json')
cfg_path.parent.mkdir(parents=True, exist_ok=True)

# Use the per-mode internal gateway port (exported above), so a first boot in
# lan_https (internal 18790) is not bootstrapped with the 18789 default.
# Audit round 4: a non-numeric value must fall back to the default, not kill
# the first boot — this is the last line of defense for a hand-edited
# options export that slipped through shell validation.
try:
    gateway_port = int(os.environ.get('GATEWAY_INTERNAL_PORT', '') or 18789)
except ValueError:
    gateway_port = 18789

cfg = {
  "gateway": {
    "mode": "local",
    "port": gateway_port,
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

# Atomic write: a crash mid-write must never leave a truncated openclaw.json
# behind (the corrupt-file path used to lead to a config-wipe bug).
tmp_path = cfg_path.with_suffix('.json.tmp')
tmp_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding='utf-8')
os.replace(tmp_path, cfg_path)
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
    # OpenClaw 2026.11.6 refuses to start while this retired key exists. Migrate
    # it before any other helper or gateway start reads the configuration.
    rc=0
    python3 "$HELPER_PATH" migrate-retired-heartbeat || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "ERROR: Failed to retire agents.defaults.heartbeat; startup is deliberately fail-closed and the original configuration was preserved."
      echo "ERROR: Remove only agents.defaults.heartbeat from $OPENCLAW_CONFIG_PATH and restart the app, or schedule that one-key removal for a maintenance window. Automatic doctor repair is not attempted for this migration failure."
      exit "${rc}"
    fi
    # Audit H2: `rc=$?` after `if !` captures the exit status of the negation
    # (always 0), so real helper failures logged "exit code 0" and exited 0 —
    # a silent crash-loop before nginx/ttyd start. Capture the helper's own rc.
    rc=0
    python3 "$HELPER_PATH" apply-network-settings \
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
      "$TAILSCALE_MODE" || rc=$?
    if [ "$rc" -ne 0 ]; then
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
        # Audit M2: only allow openssl-safe SAN hostnames. An unsupported host
        # (IDN, IPv6, special chars) used to abort the whole boot at the
        # unguarded `openssl x509 -extfile` step below.
        if not re.fullmatch(r"[A-Za-z0-9.-]{1,63}", host):
            print(f"WARNING: skipped unsupported SAN host: {host}", file=sys.stderr)
            continue
        seen.add(host)
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host):
            sans.append(f"IP:{host}")
        else:
            sans.append(f"DNS:{host}")
print(",".join(sans), end="")
SANPY
)"
fi

# --- OAuth client identity for the official Home Assistant MCP server ---
# The official endpoint validates the OAuth client the IndieAuth way: the
# redirect URI has to share scheme and netloc with the client ID, or the client
# ID URL has to advertise the redirect. OpenClaw's published client points at
# loopback addresses the browser cannot reach from the LAN, so the app serves
# its own client ID metadata document on the gateway's own HTTPS origin. The
# document is regenerated on every boot because it carries the origin.
GATEWAY_PUBLIC_ORIGIN=""
if [ "$NETWORK_MODE" = "lan_https" ] && [ -n "$LAN_IP" ]; then
  GATEWAY_PUBLIC_ORIGIN="https://${LAN_IP}:${GATEWAY_PORT}"
  if [ -n "$GW_PUBLIC_URL" ]; then
    _origin_from_url="$(python3 - "$GW_PUBLIC_URL" << 'ORIGINPY'
import sys
from urllib.parse import urlparse

parts = urlparse((sys.argv[1] or "").strip())
if parts.scheme in ("http", "https") and parts.netloc:
    print(f"{parts.scheme}://{parts.netloc}", end="")
ORIGINPY
)"
    if [ -n "$_origin_from_url" ]; then
      GATEWAY_PUBLIC_ORIGIN="$_origin_from_url"
    fi
    unset _origin_from_url
  fi
fi
export GATEWAY_PUBLIC_ORIGIN

CLIENT_METADATA_FILE="/config/oauth/client-metadata.json"
if [ -n "$GATEWAY_PUBLIC_ORIGIN" ]; then
  mkdir -p "$(dirname "$CLIENT_METADATA_FILE")" 2>/dev/null || true
  python3 - "$CLIENT_METADATA_FILE" "$GATEWAY_PUBLIC_ORIGIN" << 'METADATAPY' 2>/dev/null || true
import json
import os
import sys

path, origin = sys.argv[1], sys.argv[2]
document = {
    "client_id": f"{origin}/oauth/client-metadata.json",
    "client_name": "OpenClaw Assistant",
    "redirect_uris": [f"{origin}/oauth/mcp/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none",
    "application_type": "native",
}
tmp = f"{path}.tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(document, handle, indent=2)
    handle.write("\n")
os.replace(tmp, path)
METADATAPY
  chmod 644 "$CLIENT_METADATA_FILE" 2>/dev/null || true
fi

# The gateway fetches the client ID metadata document over its own HTTPS
# origin, which uses the locally generated certificate. Trusting the local CA
# keeps that fetch working; the CA is generated once and persists in
# /config/certs, so the anchor stays valid across restarts and updates.
if [ -f "$CERT_DIR/ca.crt" ]; then
  export NODE_EXTRA_CA_CERTS="$CERT_DIR/ca.crt"
fi

# --- Server cert (regenerated when missing, IP/SAN change, or pre-extension) ---
if [ "$ENABLE_HTTPS_PROXY" = "true" ]; then
  if [ ! -f "$CERT_DIR/gateway.crt" ] || [ ! -f "$CERT_DIR/gateway.key" ] \
     || [ "$LAN_IP" != "$STORED_IP" ] || [ "$EXTRA_SANS" != "$STORED_EXTRA_SANS" ] \
     || [ ! -f "$CERT_DIR/.cert_ext" ]; then
    echo "INFO: Generating server TLS certificate for IP: ${LAN_IP:-unknown}..."
    # Audit round 4: remove any PREVIOUS cert first — otherwise a failed
    # regeneration leaves the stale cert in place, `[ -f gateway.crt ]`
    # below still succeeded and claimed the new IP/SANs for the OLD cert.
    # Missing crt = loud nginx failure + regeneration on the next boot.
    rm -f "$CERT_DIR/gateway.crt" "$CERT_DIR/.cert_ip" "$CERT_DIR/.cert_extra_sans"
    openssl genrsa -out "$CERT_DIR/gateway.key" 2048 2>/dev/null
    openssl req -new -key "$CERT_DIR/gateway.key" -out "$CERT_DIR/gateway.csr" \
      -subj "/CN=OpenClaw Gateway" 2>/dev/null
    cat > "$CERT_DIR/_san.ext" <<SANEOF
subjectAltName=IP:${LAN_IP:-127.0.0.1},IP:127.0.0.1,DNS:localhost,DNS:homeassistant,DNS:homeassistant.local${EXTRA_SANS:+,${EXTRA_SANS}}
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
SANEOF
    # Audit M2: a SAN-triggered openssl failure used to kill boot via set -e.
    # Retry once with the base SANs only; fail loud but keep boot alive.
    if ! openssl x509 -req -in "$CERT_DIR/gateway.csr" \
      -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
      -out "$CERT_DIR/gateway.crt" -days 3650 \
      -extfile "$CERT_DIR/_san.ext" 2>/dev/null; then
      echo "WARN: Server cert with extra SANs failed; retrying with base SANs only"
      cat > "$CERT_DIR/_san.ext" <<SANEOF
subjectAltName=IP:${LAN_IP:-127.0.0.1},IP:127.0.0.1,DNS:localhost,DNS:homeassistant,DNS:homeassistant.local
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
SANEOF
      if ! openssl x509 -req -in "$CERT_DIR/gateway.csr" \
        -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
        -out "$CERT_DIR/gateway.crt" -days 3650 \
        -extfile "$CERT_DIR/_san.ext" 2>/dev/null; then
        echo "ERROR: TLS server certificate generation failed entirely; HTTPS listener cannot start"
      fi
    fi
    rm -f "$CERT_DIR/gateway.csr" "$CERT_DIR/_san.ext" "$CERT_DIR/ca.srl"
    chmod 600 "$CERT_DIR/gateway.key"
    # Follow-up audit: openssl may leave a TRUNCATED gateway.crt behind when
    # the -out file was opened but signing failed (disk full, CA/key errors)
    # — `-f` alone passes for an empty file. Parse the cert for a real
    # success gate; anything unparsable is deleted so the next boot
    # regenerates and nginx fails loud instead of serving a broken cert.
    if [ -f "$CERT_DIR/gateway.crt" ] \
       && openssl x509 -in "$CERT_DIR/gateway.crt" -noout >/dev/null 2>&1; then
      printf '%s' "$LAN_IP" > "$CERT_DIR/.cert_ip"
      printf '%s' "$EXTRA_SANS" > "$CERT_DIR/.cert_extra_sans"
      touch "$CERT_DIR/.cert_ext"
      echo "INFO: Server TLS certificate generated (SAN: IP:${LAN_IP:-127.0.0.1}${EXTRA_SANS:+,${EXTRA_SANS}}, X.509v3 extensions present)"
    else
      rm -f "$CERT_DIR/gateway.crt"
      # Failed generation is not masked: the removed marker files and the
      # missing gateway.crt force regeneration on the next boot; without a
      # cert, lan_https cannot start this boot.
      echo "ERROR: Server certificate generation failed (no valid cert in $CERT_DIR) — lan_https cannot start this boot. Check gateway_additional_allowed_origins/gateway_public_url and restart."
    fi
  else
    echo "INFO: Reusing existing TLS certificate (IP: $STORED_IP)"
  fi
fi

INGRESS_PORT=49200
export INGRESS_PORT
export CERTS_DIR="/config/certs"
export SHOW_WEBUI="$ENABLE_WEBUI"
# Terminal is NOT optional (v0.7.13.30): the Ingress terminal is the always-on
# maintenance/repair surface. nginx always renders the /terminal route.
export SHOW_TERMINAL="true"
export SHOW_DOCS="$ENABLE_DOCS"
# OPENCLAW_VERSION is used by OpenClaw's plugin API compatibility check.
# `openclaw --version` prints a human-readable label like:
#   "OpenClaw 2026.8.2 (xxxxxxxx)"
# The plugin loader expects a plain semver string, so we take the
# second whitespace-delimited field which is already the version.
export OPENCLAW_VERSION="$(openclaw_exec_with_image_node openclaw --version 2>/dev/null | head -1 | awk '/^OpenClaw / { print $2; exit }' || echo 'unknown')"
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

remove_interrupted_upgrade_backups() {
  local candidate
  # The glob cannot descend into subdirectories. An unmatched glob fails the
  # regular-file test; symlinks and directories are deliberately left alone.
  for candidate in "${UPGRADE_BACKUP_DIR}"/openclaw-state-*.tar.gz.partial; do
    if [ ! -f "$candidate" ] || [ -L "$candidate" ]; then
      continue
    fi
    if ! rm -f -- "$candidate" 2>/dev/null; then
      echo "WARN: Could not remove interrupted upgrade backup ${candidate}."
    fi
  done
}

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
  # A SIGKILL can strand a partial archive; sweep it before every gate outcome.
  remove_interrupted_upgrade_backups
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
# - Helper REPLACES the app-managed origin list each boot (deterministic:
#   no stale origins from old LAN IPs); user extras belong in the
#   gateway_additional_allowed_origins option, which is preserved.
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

  python3 "$HELPER_PATH" set-control-ui-origins "$ALLOWED_ORIGINS" "$GATEWAY_ADDITIONAL_ALLOWED_ORIGINS" "$CONTROLUI_DISABLE_DEVICE_AUTH" "$GATEWAY_PUBLIC_ORIGIN" || \
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
configure_openclaw_proxy_shim() {
  local shim_path="${1:-/usr/local/lib/openclaw-proxy-shim.cjs}"
  # Match the shim's four activation variables exactly. ALL_PROXY alone must
  # not inject code (verified Codex inference rejects even a no-op --require).
  if [ -f "$shim_path" ] && {
    [ -n "${HTTPS_PROXY:-}" ] || [ -n "${HTTP_PROXY:-}" ] ||
    [ -n "${https_proxy:-}" ] || [ -n "${http_proxy:-}" ];
  }; then
    # Keep this lookup lazy: npm is not needed when no proxy is configured.
    OPENCLAW_GLOBAL_NODE_MODULES="$(HOME=/root npm root -g 2>/dev/null || true)"
    if [ -n "${NODE_OPTIONS:-}" ]; then
      export NODE_OPTIONS="--require ${shim_path} ${NODE_OPTIONS}"
    else
      export NODE_OPTIONS="--require ${shim_path}"
    fi
    export OPENCLAW_GLOBAL_NODE_MODULES
  fi
}
configure_openclaw_proxy_shim

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

# Write exactly one add-on-owned OpenClaw mcp.servers value. The JSON span
# parser replaces/inserts only that value; foreign entries and all unrelated
# bytes are copied verbatim. A semantic match returns without opening a write.
upsert_openclaw_mcp_server() {
  local server_name="$1"
  local definition="$2"
  local marker_path="$3"
  local timeout_bin="$4"
  local config_path="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_CONFIG_DIR}/openclaw.json}"

  MCP_SERVER_DEFINITION="$definition" PATH="/usr/bin:$PATH" \
    "$timeout_bin" 30s /usr/bin/node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const [configPath, serverName, markerPath] = process.argv.slice(1);
const definition = JSON.parse(process.env.MCP_SERVER_DEFINITION);
if (!definition || typeof definition !== "object" || Array.isArray(definition)) process.exit(2);

function parse(source) {
  let cursor = 0;
  const fail = () => { throw new Error("invalid JSON"); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[cursor] ?? "")) cursor++; };
  function stringNode() {
    const start = cursor;
    if (source[cursor++] !== "\"") fail();
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      const char = source[cursor++];
      if (char === "\"") {
        const raw = source.slice(start, cursor);
        return { kind: "string", start, end: cursor, value: JSON.parse(raw) };
      }
      if (code < 0x20) fail();
      if (char === "\\") {
        const escaped = source[cursor];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor + 1, cursor + 5))) fail();
          cursor += 5;
        } else {
          if (!"\"\\/bfnrt".includes(escaped ?? "")) fail();
          cursor++;
        }
      }
    }
    fail();
  }
  function valueNode() {
    whitespace();
    const start = cursor;
    const char = source[cursor];
    if (char === "\"") return stringNode();
    if (char === "{") {
      cursor++;
      whitespace();
      const properties = [];
      if (source[cursor] === "}") {
        cursor++;
        return { kind: "object", start, end: cursor, properties, value: {} };
      }
      while (cursor < source.length) {
        whitespace();
        const key = stringNode();
        whitespace();
        if (source[cursor++] !== ":") fail();
        const value = valueNode();
        properties.push({ key, value });
        whitespace();
        if (source[cursor] === "}") {
          cursor++;
          return { kind: "object", start, end: cursor, properties };
        }
        if (source[cursor++] !== ",") fail();
      }
      fail();
    }
    if (char === "[") {
      cursor++;
      whitespace();
      const values = [];
      if (source[cursor] === "]") {
        cursor++;
        return { kind: "array", start, end: cursor, values };
      }
      while (cursor < source.length) {
        values.push(valueNode());
        whitespace();
        if (source[cursor] === "]") {
          cursor++;
          return { kind: "array", start, end: cursor, values };
        }
        if (source[cursor++] !== ",") fail();
      }
      fail();
    }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    number.lastIndex = cursor;
    const match = number.exec(source);
    if (match) {
      cursor += match[0].length;
      return { kind: "number", start, end: cursor };
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, cursor)) {
        cursor += literal.length;
        return { kind: "literal", start, end: cursor };
      }
    }
    fail();
  }
  whitespace();
  const root = valueNode();
  whitespace();
  if (cursor !== source.length) fail();
  return root;
  }

function property(objectNode, name) {
  if (objectNode.kind !== "object") throw new Error("expected object");
  const matches = objectNode.properties.filter((entry) => entry.key.value === name);
  if (matches.length > 1) throw new Error("ambiguous property");
  return matches[0];
  }

function lineIndent(source, position) {
  const start = source.lastIndexOf("\n", position - 1) + 1;
  const prefix = source.slice(start, position);
  return /^[\t ]*$/.test(prefix) ? prefix : "";
  }

function render(source, name, value, indent) {
  const rendered = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  return `${JSON.stringify(name)}: ${rendered}`;
  }

function insertProperty(source, objectNode, name, value, parentIndent) {
  const close = objectNode.end - 1;
  const first = objectNode.properties[0];
  const childIndent = first
    ? (lineIndent(source, first.key.start) || `${parentIndent}  `)
    : `${parentIndent}  `;
  const addition = render(source, name, value, childIndent);
  if (!first) {
    return `${source.slice(0, objectNode.start + 1)}\n${childIndent}${addition}\n${parentIndent}${source.slice(close)}`;
  }
  const last = objectNode.properties.at(-1);
  return `${source.slice(0, last.value.end)},\n${childIndent}${addition}\n${parentIndent}${source.slice(close)}`;
  }

function atomicWrite(filePath, data, existingStat, fallbackMode) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", existingStat?.mode ?? fallbackMode);
    fs.writeFileSync(descriptor, data, { encoding: "utf8" });
    if (existingStat) {
      fs.fchmodSync(descriptor, existingStat.mode);
      fs.fchownSync(descriptor, existingStat.uid, existingStat.gid);
    } else {
      fs.fchmodSync(descriptor, fallbackMode);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
  }

try {
  const configStat = fs.lstatSync(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) process.exit(2);
  const source = fs.readFileSync(configPath, "utf8");
  const root = parse(source);
  if (root.kind !== "object") process.exit(2);
  const mcpProperty = property(root, "mcp");
  const mcpNode = mcpProperty?.value;
  if (mcpNode && mcpNode.kind !== "object") process.exit(2);
  const serversProperty = mcpNode ? property(mcpNode, "servers") : undefined;
  const serversNode = serversProperty?.value;
  if (serversNode && serversNode.kind !== "object") process.exit(2);
  const ownProperty = serversNode ? property(serversNode, serverName) : undefined;

  if (ownProperty) {
    const current = JSON.parse(source.slice(ownProperty.value.start, ownProperty.value.end));
    if (isDeepStrictEqual(current, definition)) {
      process.stdout.write("unchanged\n");
      process.exit(0);
    }
    let owned = false;
    try { owned = fs.lstatSync(markerPath).isFile(); } catch {}
    if (!owned) process.exit(10);
    const indent = lineIndent(source, ownProperty.key.start) || "  ";
    const replacement = JSON.stringify(definition, null, 2).replace(/\n/g, `\n${indent}`);
    const updated = `${source.slice(0, ownProperty.value.start)}${replacement}${source.slice(ownProperty.value.end)}`;
    atomicWrite(configPath, updated, configStat, 0o600);
  } else {
    let updated;
    if (serversNode) {
      updated = insertProperty(source, serversNode, serverName, definition, lineIndent(source, serversProperty.key.start));
    } else if (mcpNode) {
      updated = insertProperty(source, mcpNode, "servers", { [serverName]: definition }, lineIndent(source, mcpProperty.key.start));
    } else {
      updated = insertProperty(source, root, "mcp", { servers: { [serverName]: definition } }, "");
    }
    atomicWrite(configPath, updated, configStat, 0o600);
  }

  let markerStat;
  try {
    const candidate = fs.lstatSync(markerPath);
    if (!candidate.isFile() || candidate.isSymbolicLink()) process.exit(12);
    markerStat = candidate;
  } catch (error) {
    if (error.code !== "ENOENT") process.exit(12);
  }
  const digest = createHash("sha256").update(serverName).update("\0").update(process.env.MCP_SERVER_DEFINITION).digest("hex");
  atomicWrite(markerPath, `${serverName} ${digest}\n`, markerStat, 0o600);
  process.stdout.write("written\n");
} catch {
  process.exit(2);
  }
' "$config_path" "$server_name" "$marker_path" >/dev/null 2>&1
}

# Capture all CLI output and expose only the three contracted result classes.
verify_openclaw_mcp_server() {
  local server_name="$1"
  local openclaw_bin="$2"
  local timeout_bin="$3"
  local image_path="$4"
  local connection_way="$5"
  local status_prefix="Home Assistant connection $connection_way"
  local output=""
  local command_status=0
  local classification=""

  # `openclaw mcp doctor --probe` is an offline-only command: it needs
  # exclusive offline state ownership, so it cannot run while the Gateway is
  # up and would report a failure for a healthy server. The online status is
  # the only reliable source during startup.
  output=$(PATH="$image_path" "$timeout_bin" 30s "$openclaw_bin" mcp status --verbose --json 2>&1) || command_status=$?
  classification=$(printf '%s' "$output" | /usr/bin/node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const name = process.argv[1];
  function selected(report) {
    if (!report || typeof report !== "object") return undefined;
    if (Array.isArray(report.servers)) return report.servers.find((entry) => entry?.name === name);
    return report.servers?.[name];
  }
  function needsAuth(value) {
    if (!value || typeof value !== "object") return false;
    if (value.requiresAuthorization === true) return true;
    // The gateway reports one of: authorized, requires-authorization,
    // pending-authorization, unauthenticated.
    if (typeof value.state === "string" && /^(authorization-required|requires-authorization|pending-authorization|unauthenticated)$/i.test(value.state)) return true;
    return Object.values(value).some((entry) => needsAuth(entry));
  }
  let report;
  try { report = JSON.parse(input); } catch {}
  const server = selected(report);
  if (server !== undefined) {
    if (needsAuth(server)) {
      process.stdout.write("authorization-required\n");
      return;
    }
    if (server.ok === true) {
      process.stdout.write("connected\n");
      return;
    }
    process.stdout.write("not-connected\n");
    return;
  }
  if (/authorization-required|pending-authorization|run openclaw mcp login/i.test(input)) {
    process.stdout.write("authorization-required\n");
  }
});
' "$server_name" 2>/dev/null) || classification=""

  if [ -z "$classification" ] && [ "$command_status" != "0" ]; then
    echo "WARN: $status_prefix: status unavailable"
    return 0
  fi

  case "$classification" in
    authorization-required)
      if [ -n "${GATEWAY_PUBLIC_ORIGIN:-}" ]; then
        echo "INFO: $status_prefix: authorization-required; open the Control UI at ${GATEWAY_PUBLIC_ORIGIN}/settings/mcp and choose \"Sign in\" for $server_name"
      else
        echo "INFO: $status_prefix: authorization-required; open the Control UI and choose \"Sign in\" for $server_name"
      fi
      ;;
    connected)
      echo "INFO: $status_prefix: connected"
      ;;
    *)
      echo "WARN: $status_prefix: not connected (run openclaw mcp status --verbose)"
      ;;
  esac
}

configure_openclaw_mcp_entry() {
  local server_name="$1"
  local definition="$2"
  local marker_path="$3"
  local timeout_bin="$4"
  local openclaw_bin="$5"
  local image_path="$6"
  local connection_way="$7"
  local status_prefix="Home Assistant connection $connection_way"
  local update_status=0

  upsert_openclaw_mcp_server "$server_name" "$definition" "$marker_path" "$timeout_bin" || update_status=$?
  if [ "$update_status" = "10" ]; then
    echo "WARN: $status_prefix: OpenClaw MCP server '$server_name' exists without the add-on ownership marker and differs from the requested definition; leaving it and every foreign entry untouched."
    return 0
  fi
  if [ "$update_status" != "0" ]; then
    echo "WARN: $status_prefix: could not update OpenClaw MCP server '$server_name'; leaving foreign entries untouched."
    return 0
  fi
  if [ -z "$openclaw_bin" ]; then
    echo "WARN: $status_prefix: probe failed (openclaw CLI unavailable)"
    return 0
  fi
  verify_openclaw_mcp_server "$server_name" "$openclaw_bin" "$timeout_bin" "$image_path" "$connection_way"
}

# ------------------------------------------------------------------------------
# Auto-configure the two supported Home Assistant MCP connection ways.
# Way 2 is Home Assistant's official OAuth endpoint; way 3 is the community
# server with an exact secret connect URL and an optional independent bearer.
# Empty URLs are independent no-ops. No path substitutes homeassistant_token,
# SUPERVISOR_TOKEN, another MCP server, or LLMAT for a failed authentication.
# ------------------------------------------------------------------------------
configure_ha_mcp() {
  # Way 2 and way 3 are independent. Way 2 needs the official Home Assistant
  # MCP server (OAuth 2.0/PKCE, one interactive consent). Way 3 configures
  # community/custom MCP servers whose URL carries the secret; the option holds
  # a comma-separated list and every URL becomes its own server entry.
  # Neither way substitutes a credential for the other, and neither falls back
  # to the long-lived token, the Supervisor token or another server.
  local image_path="/usr/bin:$PATH"
  local curl_bin=""
  local timeout_bin=""
  local openclaw_bin=""

  if ! timeout_bin=$(command -v timeout 2>/dev/null); then
    echo "WARN: Home Assistant connection: coreutils timeout was not found; skipping MCP configuration and verification."
    return 0
  fi

  if [ "$HA_OFFICIAL_MCP_ENABLED" = "true" ]; then
    openclaw_bin=$(command -v openclaw 2>/dev/null || true)
    local official_url="$HA_OFFICIAL_MCP_URL"
    if [ -z "$official_url" ]; then
      # The official endpoint validates the authorization server metadata
      # against the URL that was used to reach it (RFC 8414): the issuer in the
      # metadata is Home Assistant's internal URL, so the connect URL has to
      # use the very same host. The add-on runs on the Home Assistant host, so
      # the LAN address is that host.
      official_url="http://homeassistant.local:8123/api/mcp"
      if [ -n "${LAN_IP:-}" ]; then
        official_url="http://${LAN_IP}:8123/api/mcp"
      fi
    fi
    local official_definition=""
    if ! official_definition=$(MCP_URL="$official_url" CLIENT_METADATA_URL="${GATEWAY_PUBLIC_ORIGIN}/oauth/client-metadata.json" CLIENT_REDIRECT_URL="${GATEWAY_PUBLIC_ORIGIN}/oauth/mcp/callback" /usr/bin/node -e '
const definition = {
  url: process.env.MCP_URL,
  transport: "streamable-http",
  auth: "oauth",
  oauth: {
    clientMetadataUrl: process.env.CLIENT_METADATA_URL,
    redirectUrl: process.env.CLIENT_REDIRECT_URL
  },
  connectionTimeoutMs: 10000,
  requestTimeoutMs: 30000
};
process.stdout.write(JSON.stringify(definition));
'); then
      echo "WARN: Home Assistant connection way 2 (official MCP, OAuth): could not build the definition; leaving OpenClaw configuration untouched."
    else
      configure_openclaw_mcp_entry \
        "ha-official" "$official_definition" \
        "${OPENCLAW_CONFIG_DIR}/.mcp_openclaw_ha_official_owned" \
        "$timeout_bin" "$openclaw_bin" "$image_path" \
        "way 2 (official MCP, OAuth)"
    fi
  fi

  if [ "$MCP_ENABLED" != "true" ] || [ -z "$MCP_URLS" ]; then
    return 0
  fi
  if ! curl_bin=$(command -v curl 2>/dev/null); then
    echo "WARN: Home Assistant connection way 3 (community MCP, URL list): curl was not found; skipping registration and verification."
    return 0
  fi
  openclaw_bin=$(command -v openclaw 2>/dev/null || true)

  local -a mcp_url_entries=()
  local -a mcp_used_names=()
  local mcp_url=""
  local mcp_host=""
  local mcp_name=""
  local mcp_candidate=""
  local mcp_suffix=1
  local http_status=""
  local probe_body=""
  local probe_ok="false"
  local community_definition=""

  IFS=',' read -r -a mcp_url_entries <<< "$MCP_URLS"
  for mcp_url in "${mcp_url_entries[@]}"; do
    mcp_url="$(printf '%s' "$mcp_url" | tr -d '[:space:]')"
    [ -n "$mcp_url" ] || continue

    mcp_host="$(printf '%s' "$mcp_url" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|[:/].*$||')"
    mcp_candidate="ha-mcp-${mcp_host//./-}"
    mcp_name="$mcp_candidate"
    while printf '%s\n' "${mcp_used_names[@]:-}" | grep -qx "$mcp_candidate"; do
      mcp_suffix=$((mcp_suffix + 1))
      mcp_candidate="ha-mcp-${mcp_host//./-}-$mcp_suffix"
      mcp_name="$mcp_candidate"
    done
    mcp_used_names+=("$mcp_name")

    http_status=""
    probe_body="$(mktemp 2>/dev/null || true)"
    if [ -n "$probe_body" ]; then
      http_status=$(PATH="$image_path" "$curl_bin" \
        --silent --show-error --output "$probe_body" --write-out '%{http_code}' \
        --connect-timeout 5 --max-time 10 --request POST "$mcp_url" \
        --header "Content-Type: application/json" \
        --header "Accept: application/json, text/event-stream" \
        --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
        2>/dev/null) || http_status=""
    else
      http_status=""
    fi
    # An initialize request is answered with HTTP 200 and an MCP result. A
    # server that answers with a protocol error must not be registered, so the
    # body has to carry a JSON-RPC result. HTTP 202 is the answer to a
    # notification, which this probe does not send.
    probe_ok=false
    if [ "$http_status" = "200" ] && grep -q '"result"' "$probe_body" 2>/dev/null; then
      probe_ok=true
    fi
    rm -f "$probe_body"
    if [ "$probe_ok" != "true" ]; then
      echo "WARN: Home Assistant connection way 3 (community MCP, URL list): a configured URL did not answer the initialize probe (HTTP ${http_status:-no answer}); it was not registered and every existing MCP entry stays untouched."
      continue
    fi

    community_definition=""
    community_definition=$(MCP_URL="$mcp_url" /usr/bin/node -e '
process.stdout.write(JSON.stringify({
  url: process.env.MCP_URL,
  transport: "streamable-http",
  connectionTimeoutMs: 10000,
  requestTimeoutMs: 30000
}));
') || community_definition=""
    if [ -z "$community_definition" ]; then
      echo "WARN: Home Assistant connection way 3 (community MCP, URL list): could not build the definition for a configured URL; it was not registered."
      continue
    fi

    configure_openclaw_mcp_entry \
      "$mcp_name" "$community_definition" \
      "${OPENCLAW_CONFIG_DIR}/.mcp_openclaw_${mcp_name}_owned" \
      "$timeout_bin" "$openclaw_bin" "$image_path" \
      "way 3 (community MCP, URL list)"
  done
}
configure_ha_mcp

# ------------------------------------------------------------------------------
# Initialize acp(x) components (ACPX infra + custom plugins)
# v0.7.13.30: acpx_enabled is the MASTER gate. acpx_enabled=false means NO
# writer deploy / config transfer. Retired-plugin data migration and payload
# removal are upgrade maintenance, not ACP deployment: they run for every
# install before the master-gate branch. With the master on, the ACPX infrastructure
# (managed npm project + openclaw.json acp patch) is always set up when the
# helper runs. Agent definitions are NOT modified here; existing
# user-configured coding agents are preserved.
# ------------------------------------------------------------------------------
ACPX_HELPER_PATH="/oc_acpx_helper.py"
if [ ! -f "$ACPX_HELPER_PATH" ] && [ -f "$(dirname "$0")/oc_acpx_helper.py" ]; then
  ACPX_HELPER_PATH="$(dirname "$0")/oc_acpx_helper.py"
fi
if [ -f "$ACPX_HELPER_PATH" ]; then
  echo "INFO: Migrating/removing retired dashboard-binding installation (independent of acpx_enabled)..."
  python3 "$ACPX_HELPER_PATH" --migrate-retired-binding || \
    echo "ERROR: retired dashboard-binding migration/cleanup failed (exit $?) — see WARN/ERROR lines above"
else
  echo "WARN: ACPX helper not found; skipping retired dashboard-binding migration/cleanup"
fi
if [ "$ACPX_ENABLED" = "true" ] || [ "$ACPX_ENABLED" = "1" ]; then
  if [ -f "$ACPX_HELPER_PATH" ]; then
    echo "INFO: Initializing acp(x) components (acpx master on; writer per its own switch)..."
    # GATEWAY_INTERNAL_PORT is exported above (run.sh owns the config
    # bootstrap; the helper only patches the acp section).
    python3 "$ACPX_HELPER_PATH" || \
      echo "ERROR: acp(x) initialization failed (exit $?) — see per-switch WARN/ERROR lines above"
  else
    echo "WARN: ACPX helper not found; skipping acp(x) initialization"
  fi
else
  echo "INFO: acpx_enabled off — no ACP initialization; writer config transfer stays OFF (master gate)"
  case "$HARNESS_CONFIG_WRITER_ENABLED" in
    true|True|1) echo "INFO: harness_config_writer_enabled set, but acpx_enabled=false — writer config transfer remains OFF (set acpx_enabled=true to enable)" ;;
  esac
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
      echo "ERROR: Set gateway_remote_url in app Configuration (e.g. ws://192.0.2.10:18789), then restart"
      return 1
    fi

    NODE_HOST=""
    NODE_PORT=""
    NODE_TLS_FLAG=""
    # SECURITY (audit K1): never eval() generated shell code — the previous
    # design executed shell metacharacters from this user-controlled URL as
    # root ($(...) / backticks survived urlparse). Python now returns plain
    # data, one value per line, consumed only as quoted arguments below. The
    # hostname is additionally restricted to shell-safe characters.
    if ! REMOTE_PARSED="$(python3 - "$REMOTE_URL" <<'PY'
import re
import sys
from urllib.parse import urlparse
url = (sys.argv[1] or '').strip()
p = urlparse(url)
if p.scheme not in ('ws', 'wss') or not p.hostname:
    print('ERROR: Invalid gateway.remote.url (expected ws:// or wss://)', file=sys.stderr)
    sys.exit(2)
if not re.fullmatch(r'[A-Za-z0-9._:-]+', p.hostname):
    print(f'ERROR: gateway.remote.url hostname contains unsupported characters: {url}', file=sys.stderr)
    sys.exit(2)
port = p.port or (443 if p.scheme == 'wss' else 80)
print(p.hostname)
print(port)
print('--tls' if p.scheme == 'wss' else '')
PY
)"; then
      echo "ERROR: Failed to parse gateway.remote.url: $REMOTE_URL"
      return 1
    fi
    NODE_HOST="$(printf '%s\n' "$REMOTE_PARSED" | sed -n '1p')"
    NODE_PORT="$(printf '%s\n' "$REMOTE_PARSED" | sed -n '2p')"
    NODE_TLS_FLAG="$(printf '%s\n' "$REMOTE_PARSED" | sed -n '3p')"

    echo "INFO: gateway_mode=remote detected; starting node host to $NODE_HOST:$NODE_PORT ${NODE_TLS_FLAG}"
    # shellcheck disable=SC2086
    openclaw_exec_with_image_node openclaw node run --host "$NODE_HOST" --port "$NODE_PORT" $NODE_TLS_FLAG &
  else
    openclaw_exec_with_image_node openclaw gateway run &
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
    "$OPENCLAW_NODE_BIN" -e "
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


# Find a running gateway daemon's PID using multiple detection methods.
# Used by the supervisor loop to detect self-restarts (SIGUSR1) without
# spawning duplicate gateway instances that collide on the port.
#
# A listening socket is useful evidence only when its owner also passes the
# daemon-argv check. Otherwise scan each numeric /proc entry exactly once.
# Known wrapper PIDs and previously rejected candidates are never returned.
# A gateway run that died in the agent-database startup admission never
# finished its startup: the runtime prepares every agent database (schema,
# integrity, FTS repair) before it can admit the agents, and that work needs
# minutes on a large state. Such a run must count as a failed start - if it
# reset the failure streak, the supervisor would restart the gateway every
# couple of seconds and the preparation could never finish.
gateway_newest_log_file() {
  local log_dir="${1:-}" file
  [ -n "$log_dir" ] && [ -d "$log_dir" ] || return 0
  for file in "$log_dir"/openclaw-*.log; do
    [ -f "$file" ] || continue
    printf '%s %s\n' "$(stat -c %Y "$file" 2>/dev/null || echo 0)" "$file"
  done | sort -rn | head -1 | cut -d' ' -f2- || true
}

gateway_startup_admission_refused() {
  local log_dir="${OPENCLAW_STATE_DIR:-/config/.openclaw}/logs"
  local log_file="${GW_LOG_FILE:-}"
  [ -n "$log_file" ] || log_file="$(gateway_newest_log_file "$log_dir" || true)"
  [ -n "$log_file" ] || return 1
  [ -f "$log_file" ] || return 1
  # Only the part of the log that this boot produced: the refusal marker of an
  # older boot must not keep the failure streak alive forever. The tail is read
  # into a variable: a pipeline with `grep -q` can end in SIGPIPE, and under
  # `set -euo pipefail` that would abort the whole add-on.
  local tail_data=""
  tail_data="$(tail -c "+$(( ${GW_LOG_OFFSET:-0} + 1 ))" "$log_file" 2>/dev/null || true)"
  case "$tail_data" in
    *"has not completed startup inspection and preparation"*) return 0 ;;
  esac
  return 1
}

# Remember where the gateway log stands when a boot starts, so the exit
# detection can look at exactly the lines this boot wrote.
gateway_log_mark() {
  local log_dir="${OPENCLAW_STATE_DIR:-/config/.openclaw}/logs"
  local log_file
  # No failing pipeline in an assignment: without a log directory (fresh
  # boot) the glob does not match, `ls` exits non-zero, and under
  # `set -euo pipefail` that would end the add-on before it ever boots.
  log_file="$(gateway_newest_log_file "$log_dir" || true)"
  GW_LOG_FILE="$log_file"
  GW_LOG_OFFSET=0
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    GW_LOG_OFFSET="$(wc -c < "$log_file" 2>/dev/null || true)"
    case "$GW_LOG_OFFSET" in
      ""|*[!0-9]*) GW_LOG_OFFSET=0 ;;
    esac
  fi
}

# Print the newest gateway log file, or nothing. Never fails.

oc_gateway_listener_pid() {
  ss -tlnpH 2>/dev/null | awk -v port="${GATEWAY_INTERNAL_PORT}" '
    $4 ~ (":" port "$") {
      if (match($0, /pid=[0-9]+/)) {
        print substr($0, RSTART + 4, RLENGTH - 4)
        exit
      }
    }'
}

find_gateway_daemon_pid() {
  local listener pid path
  local known=" ${NGINX_PID:-0} ${TTYD_PID:-0} ${GW_RELAY_PID:-0} ${GW_PID:-0} $$ ${GW_DENIED_PIDS:-} "

  listener="$(oc_gateway_listener_pid || true)"
  if [ -n "$listener" ]; then
    case "$known" in
      *" $listener "*) listener="" ;;
    esac
    if [ -n "$listener" ] && oc_gateway_pid_is_daemon "$listener"; then
      echo "$listener"
      return 0
    fi
  fi

  for path in /proc/[0-9]*; do
    pid="${path#/proc/}"
    case "$known" in *" $pid "*) continue ;; esac
    if oc_gateway_pid_is_daemon "$pid"; then
      echo "$pid"
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
# /home/linuxbrew/.linuxbrew/bin. The Homebrew directories are appended at the
# end of PATH (see the export at the top of this script), so that build comes
# after the system binaries. It is compiled for a different prefix and would
# fail to start the Debian system bus, so we use absolute Debian paths and
# remove stale PID files that survive an unclean container restart.
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

# Shared ttyd liveness helpers (boot cleanup + runtime supervisor below).
stop_stale_ttyd() {
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
}
start_ttyd() {
  ttyd -W -i 127.0.0.1 -p "${TERMINAL_PORT}" -b /terminal bash -il &
  TTYD_PID=$!
  echo "$TTYD_PID" > "$TTYD_PID_FILE"
  TTYD_GRACE_UNTIL=$(( $(date +%s) + 60 ))
  echo "ttyd started with PID $TTYD_PID (no kill until ${TTYD_GRACE_UNTIL})"
}
ttyd_listening() {
  # Robust, dependency-free probe.
  # Why /proc/net/tcp first: no binary, no process column, no allocation — so it
  # cannot fail the way `ss -tlnp` did when the process column was unreadable.
  # LISTEN state is 0A; the port is the hex value of the local address column.
  local _tn port_hex
  port_hex=$(printf '%04X' "${TERMINAL_PORT}")
  for _tn in /proc/net/tcp /proc/net/tcp6; do
    [ -r "${_tn}" ] || continue
    awk -v px="${port_hex}" '{ n = split($2, a, ":"); if (n == 2 && a[2] == px && $4 == "0A") f = 1 } END { exit !f }' "${_tn}" 2>/dev/null && return 0
  done
  # Fallback: ss. The old pattern ":PORT " required a trailing space and missed
  # lines that end right after the port; accept both a separator and end-of-line.
  command -v ss >/dev/null 2>&1 || return 1
  ss -tln 2>/dev/null | grep -qE ":${TERMINAL_PORT}([[:space:]]|$)" && return 0
  ss -tlnp 2>/dev/null | grep -qE ":${TERMINAL_PORT}([[:space:]]|$)"
}

stop_stale_ttyd

# v0.7.13.30: the terminal is always on — no enable/off branch anymore. It is
# the Ingress maintenance/repair surface (the operator CLI escape hatch).
# Check if the terminal port is already in use before starting ttyd
if ttyd_listening; then
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
start_ttyd
# Boot gate: the terminal is the FIRST surface and the only way into the
# openclaw CLI (operator commands + oc-gateway maintenance), so give it a
# bounded moment to bind before the slow gateway start claims the boot.
# NOT a hard hostage-gate: if ttyd can't bind (port conflict), holding the
# gateway forever leaves NO workable surface at all — warn loudly and let
# the gateway (and via Ingress at least the landing page) come up anyway.
TTYD_BOOT_WAITS=0
until ttyd_listening || [ "$TTYD_BOOT_WAITS" -ge 6 ]; do
  TTYD_BOOT_WAITS=$((TTYD_BOOT_WAITS + 1))
  sleep 5
done
if ! ttyd_listening; then
  echo "WARN: web terminal (ttyd) did not bind 127.0.0.1:${TERMINAL_PORT} within 30 s;"
  echo "      continuing WITHOUT terminal (operator CLI unavailable) — fix"
  echo "      'terminal_port' in the app configuration."
fi
# The runtime supervisor subshell below keeps ttyd alive from here on.

# ttyd runtime supervisor: the web terminal is the operator's fallback surface
# (and the way into `oc-gateway` maintenance), but ttyd is loopback-only and
# therefore invisible to the HA watchdog (tcp://[HOST]:49200 sees only nginx).
# A dead ttyd used to leave the app terminal-less until the next full add-on
# restart; a one-line local respawn beats a container restart, so HA stays out
# of this by design. Checks the port (not just the PID — catches a process that
# stopped listening), 30 s cadence, independent of the gateway supervision loop.
supervise_ttyd() {
  # Always-on since v0.7.13.30 (enable_terminal retired, see boot gate above).
  TTYD_NOT_LISTENING=0
  while true; do
    # Skip the probe while a (re)start is still settling.
    if [ "$(date +%s)" -lt "${TTYD_GRACE_UNTIL:-0}" ]; then
      sleep 5
      continue
    fi
    if ttyd_listening; then
      TTYD_NOT_LISTENING=0
      sleep 30
      continue
    fi
    # CONFIRMATION: one observation must never kill anything. ttyd 1.7.7 drops
    # its listener for a fraction of a second now and then; the 30 s cadence hit
    # exactly that window on 2026-11-05 07:35 and killed a HEALTHY terminal
    # (the watchdog itself logged the LISTEN socket 0.33 s later). Require the
    # condition to persist over three consecutive checks.
    TTYD_NOT_LISTENING=$((TTYD_NOT_LISTENING + 1))
    if [ "${TTYD_NOT_LISTENING}" -lt 3 ]; then
      echo "NOTICE: ttyd not listening on ${TERMINAL_PORT} (${TTYD_NOT_LISTENING}/3) — waiting, no kill."
      sleep 30
      continue
    fi
    # A live ttyd is never SIGTERMed: killing it tears down the whole terminal
    # tree, so every command running in the web terminal dies with it (measured:
    # an in-flight `openclaw doctor --fix` was interrupted by SIGTERM).
    if pgrep -x ttyd >/dev/null 2>&1; then
      echo "NOTICE: ttyd is alive but not listening on ${TERMINAL_PORT}; leaving it alone (no kill, no SIGTERM to the terminal tree)."
      sleep 30
      continue
    fi
    echo "WARN: web terminal (ttyd) not listening on ${TERMINAL_PORT} for 3 consecutive checks; restarting it..."
    # Forensic snapshot of the hung process (ttyd 1.7.7 can sit ALIVE but not
    # listening — the kill -0 in stop_stale_ttyd succeeds on every revive; the
    # root cause is still open and this is the only place that sees it live).
    for FORENSIC_PID in $(pgrep -x ttyd 2>/dev/null); do
      echo "ttyd forensics pid=${FORENSIC_PID} stat=$(awk '{print $3}' /proc/${FORENSIC_PID}/stat 2>/dev/null)" \
        "wchan=$(cat /proc/${FORENSIC_PID}/wchan 2>/dev/null)" \
        "threads=$(ls /proc/${FORENSIC_PID}/task 2>/dev/null | wc -l)" \
        "fds=$(ls /proc/${FORENSIC_PID}/fd 2>/dev/null | wc -l)"
      for T in /proc/${FORENSIC_PID}/task/*; do
        echo "  tid=$(basename "$T") state=$(awk '{print $3}' "$T/stat" 2>/dev/null) wchan=$(cat "$T/wchan" 2>/dev/null)"
      done
      # fd targets make the lost-listener hypothesis falsifiable: the live
      # 05:10 snapshot (v0.7.13.31) saw 1 thread in epoll_wait with 14 fds and
      # no listener — we need to see WHICH sockets the fd table still holds.
      for F in /proc/${FORENSIC_PID}/fd/*; do
        echo "  fd=$(basename "$F") -> $(readlink "$F" 2>/dev/null)"
      done
      ss -tlnp 2>/dev/null | grep -F "pid=${FORENSIC_PID}," | head -10
    done
    stop_stale_ttyd
    start_ttyd
    sleep 30
  done
}
( supervise_ttyd ) &

# Start ingress reverse proxy (nginx). This provides the app UI inside HA.
# Token handling (audit comment fix): the token is injected server-side into
# the proxy Authorization header. The landing page additionally embeds it as a
# `#token=` fragment BY DESIGN (ControlUI in the HA sidebar via Ingress/IFrame
# needs it client-side); a URL fragment is never sent to any server.
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
# Verify ingress port is actually free before proceeding (audit M1: the
# pattern used to be single-quoted, so ${INGRESS_PORT} never expanded and the
# check could never fire)
if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${INGRESS_PORT} "; then
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
    NETWORK_MODE="$NETWORK_MODE" \
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
  # This subshell may poll for up to 2 minutes; it must not hold the
  # startup lock (fd 9) — a gateway self-restart during onboarding would
  # otherwise be blocked by flock, and a /proc-scan PID tracker could even
  # mis-track this subshell as the daemon.
  exec 9>&- || true
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

# --- Operator maintenance latch (terminal gateway lifecycle) ------------------
# HA supervises this add-on container; this loop is the only watcher the
# loopback-only gateway has (issue #95 topology). Maintenance that needs the
# gateway DOWN — `openclaw doctor` / `doctor --fix` ("must never run against a
# live gateway"), manual config surgery — was impossible: HA has no per-gateway
# watchdog (tcp://HOST:49200 only sees the nginx ingress), and `openclaw gateway
# stop` in the terminal was futile because this loop respawned the daemon.
# The latch flag is that missing "take it down and hold it" switch; the
# `oc-gateway` helper (installed below, before boot) drives it from the web terminal.
install_oc_gateway_helper() {
  # Idempotent: regenerated on every add-on start so the helper always matches
  # this run.sh (marker line documents generation). OC_GATEWAY_FLAG stays an
  # environment override for testing.
  local helper_tmp target_dir
  helper_tmp="$(mktemp /tmp/oc-gateway.XXXXXX)" || return 1
  cat > "$helper_tmp" <<'OC_GATEWAY_HELPER'
#!/bin/bash
# oc-gateway — operator tool for the OpenClaw gateway inside this add-on.
# Generated by run.sh (OC_GATEWAY_HELPER_GEN_STAMP); regenerated on every
# add-on start — hand edits here are overwritten. Test hook: OC_GATEWAY_FLAG.
set -u
export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/config/.openclaw}"
FLAG="${OC_GATEWAY_FLAG:-${OPENCLAW_CONFIG_DIR}/.gateway-maintenance}"
PORT="${OC_GATEWAY_PORT:-@@GW_PORT@@}"
SUPERVISOR_BASE="${OC_SUPERVISOR_BASE:-http://supervisor}"

usage() {
  cat <<'USAGE'
oc-gateway — gateway lifecycle from the web terminal.

  oc-gateway status      gateway status (probe capped at 10 s)
  oc-gateway health      quick health check
  oc-gateway stop        touch the maintenance latch, stop the gateway, HOLD it
                         down (supervision loop will not respawn) — use for
                         `openclaw doctor` / repairs / config surgery. If the
                         drain outwaits the window, the port-owner PIDs are
                         TERM'd, then KILLed; orphaned openclaw-owned leftover
                         processes are swept so they cannot hold the state DB.
  oc-gateway doctor      one-shot repair: stop (latch) → 'openclaw doctor --fix
                         --non-interactive --yes' → resume. Auto-resumes on
                         close/interrupt; can take 10-60 min on a Pi.
  oc-gateway resume      remove the latch; gateway respawns within ~5 s
  oc-gateway restart     restart the whole add-on (HA Supervisor API — this is
                         what also brings the gateway back, fresh)
  oc-gateway update      how to update the add-on (HA-UI / Supervisor, not CLI)

The latch flag lives at $FLAG and survives add-on restarts on purpose: an
explicit operator hold is not undone by a supervisor bounce. Clear it with
`oc-gateway resume` (or delete the file).
USAGE
}

wait_port_free() {
  local i
  for i in $(seq 1 15); do
    if ! command -v ss >/dev/null 2>&1 || ! ss -tln 2>/dev/null | grep -q ":${PORT} "; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Escalation ladder (verified live 2026-10-17 night on this addon): the SIGTERM
# drain can outwait the helper while agent DBs / spawned harness children are
# busy; pre-.35 the helper then left a half-stopped gateway plus an orphaned
# openclaw CLI process (PPID 1) holding the state database, and the follow-up
# 'openclaw doctor --fix' died with GatewayStateOwnerContentionError in that
# window. .35 escalates on VERIFIED port-owner PIDs (never a blind pkill -f)
# and sweeps orphaned openclaw-owned leftovers before reporting the hold.
port_owner_pids() {
  ss -tlnp 2>/dev/null \
    | grep -F ":${PORT} " \
    | sed -n 's/.*pid=\([0-9]*\).*/\1/p' \
    | sort -u
}
sweep_openclaw_leftovers() {
  # Kill remaining openclaw-owned processes (daemon stragglers, spawn-broker /
  # harness children, orphans of the CLI itself) that would hold the state DB.
  # Skips: our own process tree, and the in-flight 'openclaw gateway stop' CLI
  # child. Matched by exact surface (/usr/bin/openclaw, openclaw-gateway,
  # node_modules/openclaw, /.openclaw/npm/) — NOT by any substring, so benign
  # commands like "tail -f .../.openclaw/logs/x" are never touched.
  local f pid cmd ptree parent
  ptree=" $$ "
  parent=$PPID
  while [ -n "$parent" ] && [ "$parent" != "1" ]; do
    ptree="${ptree}${parent} "
    parent=$(awk '{print $4}' "/proc/${parent}/stat" 2>/dev/null)
    [ -n "$parent" ] || break
  done
  for f in /proc/[0-9]*/cmdline; do
    pid="${f#/proc/}"; pid="${pid%/cmdline}"
    case " ${ptree}" in *" ${pid} "*) continue ;; esac
    cmd=$(tr '\0' ' ' < "$f" 2>/dev/null) || continue
    case "$cmd" in
      *"openclaw gateway stop"*) continue ;;
      *openclaw-gateway*|*"/usr/bin/openclaw"*|*"node_modules/openclaw"*|*"/.openclaw/npm/"*|"openclaw"|"openclaw "*)
        kill -9 "${pid}" 2>/dev/null || true ;;
    esac
  done
}

case "${1:-}" in
  status)
    exec timeout 20 openclaw gateway status --timeout 10000
    ;;
  health)
    exec timeout 20 openclaw gateway health
    ;;
  stop|maintenance)
    [ "${2:-}" = "--help" ] && { usage; exit 0; }
    mkdir -p "$(dirname "$FLAG")"
    touch "$FLAG"
    echo "Maintenance latch set: $FLAG"
    if command -v openclaw >/dev/null 2>&1; then
      # Non-interactive shells refuse a plain stop (operator-service guard);
      # --force is the documented intent signal for exactly this case.
      timeout 90 openclaw gateway stop --force 2>/dev/null || true
    else
      pkill -TERM -f "openclaw-gateway" 2>/dev/null || true
    fi
    # Escalation: a busy drain can outwait the TERM window. TERM, then KILL the
    # verified port-owner PIDs (ss -tlnp; never a blind pkill -f).
    owners=$(port_owner_pids)
    if [ -n "$owners" ]; then
      echo "INFO: gateway still bound (${owners}) after the drain window; escalating."
      for p in $owners; do kill -TERM "${p}" 2>/dev/null || true; done
      # ~5 s TERM grace: funds the gateway's own final-write window (docs:
      # up to 10 s reserve; 5 s keeps the whole stop well inside any sane
      # operator tolerance while KILL still guarantees the exit).
      for _i in 1 2 3 4 5; do
        [ -z "$(port_owner_pids)" ] && break
        sleep 1
      done
      owners=$(port_owner_pids)
      for p in $owners; do
        echo "INFO: kill -9 verified port owner pid ${p}"
        kill -9 "${p}" 2>/dev/null || true
      done
    fi
    sweep_openclaw_leftovers
    if wait_port_free; then
      echo "Gateway stopped and HELD down. nginx + web terminal stay up."
      echo "Run your maintenance now (e.g. 'openclaw doctor --fix')."
      echo "Resume afterwards with: oc-gateway resume"
    else
      echo "WARN: gateway port ${PORT} still occupied after 15 s; the supervision"
      echo "      loop already holds the gateway down — leaving the daemon alone."
    fi
    ;;
  doctor)
    drflag="${OC_GATEWAY_DOCTOR_FLAG:-/tmp/.oc-gateway-doctor-running}"
    : > "$drflag"
    docleanup() {
      rc=$?
      if [ -f "$drflag" ]; then
        rm -f "$drflag"
        echo "=== doctor ended (rc=${rc}); resuming gateway ==="
        "$0" resume >/dev/null 2>&1 || true
      fi
      exit "$rc"
    }
    trap 'docleanup' EXIT INT TERM HUP
    echo "One-shot repair: stop (latch) → 'openclaw doctor --fix --non-interactive --yes' → resume."
    echo "On a Pi with many agent DBs this can take 10-60 min. Keep this terminal open —"
    echo "if it closes or you Ctrl-C, the gateway auto-resumes. For a manual hold use"
    echo "'oc-gateway stop' + 'oc-gateway resume' instead."
    "$0" stop
    shift
    echo "=== doctor --fix (maintenance window, gateway HELD DOWN) ==="
    if command -v openclaw >/dev/null 2>&1; then
      openclaw doctor --fix --non-interactive --yes "$@"
      drc=$?
    else
      echo "ERROR: openclaw CLI not found; skipping the fix run."
      drc=127
    fi
    echo "=== doctor finished (rc=${drc}); resuming via EXIT trap ==="
    exit "${drc}"
    ;;
  resume)
    if [ -f "$FLAG" ]; then
      rm -f "$FLAG" && echo "Maintenance latch removed; gateway respawns within ~5 s."
    else
      echo "No maintenance latch present (gateway supervision is active)."
    fi
    ;;
  maintenance-status)
    [ -f "$FLAG" ] && { echo "HELD DOWN (latch present: $FLAG)"; exit 0; }
    echo "SUPERVISED (no latch)"; exit 1
    ;;
  restart)
    if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
      curl -sS -X POST \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        -H "Content-Type: application/json" \
        "${SUPERVISOR_BASE}/addons/self/restart" \
        && echo "Add-on restart requested — the terminal will reconnect when HA brings it back."
    else
      echo "SUPERVISOR_TOKEN not available in this shell; restart via the HA UI:"
      echo "Settings -> Add-ons -> OpenClaw HA Add-on -> Restart."
    fi
    ;;
  update)
    echo "Update the add-on via the HA UI (Settings -> Add-ons -> Updates) or the"
    echo "Supervisor add-on panel. A CLI-only update is not supported here."
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage
    echo
    echo "Unknown command: ${1:-<none>}" >&2
    exit 2
    ;;
esac
OC_GATEWAY_HELPER
  sed -i "s|@@GW_PORT@@|${GATEWAY_INTERNAL_PORT:-18790}|g" "$helper_tmp" || { rm -f "$helper_tmp"; return 1; }
  sed -i "s|OC_GATEWAY_HELPER_GEN_STAMP|generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by run.sh|" "$helper_tmp" || true
  chmod 0755 "$helper_tmp"
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    target_dir="/usr/local/bin"
  else
    target_dir="${OPENCLAW_CONFIG_DIR}/bin"
    mkdir -p "$target_dir"
  fi
  mv -f "$helper_tmp" "${target_dir}/oc-gateway" || { rm -f "$helper_tmp"; return 1; }
  case ":${PATH}:" in
    *":${target_dir}:"*) ;;
    *) echo "WARN: oc-gateway installed in ${target_dir} which is not on PATH;" >&2
       echo "      call it as '${target_dir}/oc-gateway'." >&2 ;;
  esac
  echo "INFO: oc-gateway helper installed: ${target_dir}/oc-gateway"
  return 0
}
install_oc_gateway_helper || echo "WARN: could not install oc-gateway helper; the maintenance latch still works via the flag file."

# --- Upstream image activation (mirrors openclaw/openclaw docker-entrypoint) ---
# The upstream container image repairs the retained state before the gateway
# starts: its entrypoint runs `openclaw doctor --fix --non-interactive` once,
# with an activation marker that lets a later run reuse the sealed capture
# instead of taking a new one. We do the same, so the repair happens once
# while no gateway is running instead of after failed starts.
run_image_activation() {
  local marker key root_dir
  # In remote mode there is no local gateway and therefore no local state to
  # repair; the remote host owns that.
  if [ "${GATEWAY_MODE:-local}" = "remote" ]; then
    echo "INFO: remote gateway mode; the state repair is done by the remote host."
    GW_ACTIVATION_OK=1
    return 0
  fi
  root_dir="$(dirname "$(dirname "$(readlink -f "$(command -v openclaw 2>/dev/null || echo /usr/lib/node_modules/openclaw/bin/openclaw)")")")"
  key="$(printf '%s|%s' "${root_dir}" "${GATEWAY_INTERNAL_PORT}" | sha256sum | cut -c1-32)"
  marker="/tmp/openclaw-image-activation-$(id -u)-${key}"
  echo "INFO: image activation: repairing the retained state before the first gateway start"
  # The marker applies to this repair run only. Exported globally it would
  # leak into the gateway and into every later doctor run, which would then
  # skip their fresh capture.
  local rc=0
  # The repair runs in a subshell with its own signal handling: forwarding the
  # stop signals to the repair run must not replace the shutdown trap of this
  # shell, which owns the whole shutdown sequence.
  (
    child=""
    trap 'kill -TERM "${child:-0}" 2>/dev/null' TERM INT HUP QUIT
    OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER="${marker}" \
      timeout --kill-after=30s "$GW_DOCTOR_REPAIR_TIMEOUT" openclaw doctor --fix --non-interactive &
    child=$!
    wait "${child}"
  ) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "ERROR: image activation did not finish (exit ${rc}); the gateway stays down until the state is repaired."
    return 1
  fi
  echo "INFO: image activation finished"
  GW_ACTIVATION_OK=1
  GW_ACTIVATION_RETRIES=0
  return 0
}

# Boot-time latch check: the flag survives add-on restarts on purpose, so a
# boot that starts WITH the flag present must not even attempt the initial
# start (doctor sessions survive an operator's container restart). The
# supervisor loop's latch block then holds the gateway down until resume.
GATEWAY_MAINTENANCE_FLAG="${OPENCLAW_CONFIG_DIR}/.gateway-maintenance"
if [ -f "${GATEWAY_MAINTENANCE_FLAG}" ]; then
  echo "NOTICE: Maintenance latch present at boot ($GATEWAY_MAINTENANCE_FLAG);"
  echo "        gateway NOT started. nginx + web terminal are up."
  echo "        Resume with 'oc-gateway resume'."
  GW_IS_CHILD=false
  GW_PID=""
else
  if ! run_image_activation; then
    echo "WARN: image activation did not finish; the gateway stays down until the state is repaired."
    GW_IS_CHILD=false
    GW_PID=""
  elif ! start_openclaw_runtime; then
    echo "WARN: OpenClaw runtime failed to start; ingress UI stays up, retrying in the supervisor loop."
    GW_IS_CHILD=false
    GW_PID=""
  fi
  # Only a successful (re)start updates the boot timer; if-form on purpose so a
  # failed initial start (empty GW_PID) can never kill the supervisor shell.
  if [ -n "${GW_PID:-}" ]; then
    GW_BOOT_START=$(date +%s)
    gateway_log_mark
    GW_PREV_BOOT_ALIVE=1   # the initial boot actually came up (audit P2-1)
  fi
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
# Audit N4: `wait` is only valid on a PID we actually spawned. After a failed
# initial start GW_PID is empty and the documented GW_IS_CHILD=false path must
# carry into the loop; unconditionally true used to make the loop block on
# `wait ""` and log a bogus "runtime exited with code 127".
if [ -n "${GW_PID:-}" ]; then
  GW_IS_CHILD=true   # our child (can block on `wait`)
else
  GW_IS_CHILD=false
fi

# --- v0.7.13 (B8/B4): restart-loop hardening state ---------------------------
# GW_BOOT_START: wallclock at the most recent gateway (re)start — used to judge
# boot health at exit time. GW_CONSECUTIVE_FAILS: drives exponential backoff
# (2s -> 60s cap). GW_DOCTOR_REPAIR_RUNS: budget for automatic
# `openclaw doctor --fix` runs per add-on start.
GW_BOOT_START=$(date +%s)
: "${GW_PREV_BOOT_ALIVE:=0}"   # was the last gateway attempt a boot that actually ran? (kept if the initial boot already came up)
GW_CONSECUTIVE_FAILS=0
GW_DOCTOR_REPAIR_RUNS=0
# The restart delay is used before it is assigned in some paths; keep it
# defined from the start so `set -u` cannot abort the add-on.
GW_BACKOFF=2
# The repair is retried a bounded number of times; the operator can raise the bound.
GW_ACTIVATION_RETRIES=0
GW_ACTIVATION_MAX_RETRIES=3
# The upstream activation repairs the retained state before the first gateway
# start. Until that succeeded, no gateway start is attempted.
GW_ACTIVATION_OK=0
# Give an adopted process five minutes to prove that it is the serving
# gateway. Denied PIDs stay out of all subsequent discovery passes.
GW_ADOPT_CONFIRM_TIMEOUT=300
GW_DENIED_PIDS=""

run_bounded_doctor_repair() {
  local label="$1"
  shift
  local started=$SECONDS rc=0 elapsed
  timeout --kill-after=30s "$GW_DOCTOR_REPAIR_TIMEOUT" openclaw doctor "$@" || rc=$?
  elapsed=$((SECONDS - started))
  echo "INFO: Doctor repair (${label}) measured duration: ${elapsed}s including any kill grace (exit code ${rc}; timeout ${GW_DOCTOR_REPAIR_TIMEOUT}s; kill grace 30s)."
  return "$rc"
}

run_automatic_doctor_repair() {
  # Use the exact same hold as `oc-gateway stop`: the supervisor cannot start a
  # runtime while this function owns the state database for offline repair.
  # noclobber makes creation atomic: an existing operator hold is never
  # truncated, adopted, or released by the automatic path. Keep noclobber
  # local to a subshell so the rest of the supervisor can still write files.
  if ( set -o noclobber; : > "$GATEWAY_MAINTENANCE_FLAG" ) 2>/dev/null; then
    GW_AUTO_DOCTOR_LATCH="true"
  elif [ -e "$GATEWAY_MAINTENANCE_FLAG" ] || [ -L "$GATEWAY_MAINTENANCE_FLAG" ]; then
    echo "NOTICE: Operator maintenance hold is present ($GATEWAY_MAINTENANCE_FLAG); automatic doctor repair NOT run and the gateway remains held down. Use 'oc-gateway resume' only after maintenance is complete."
    return 75
  else
    echo "ERROR: Could not create maintenance latch ($GATEWAY_MAINTENANCE_FLAG); automatic doctor repair NOT run."
    return 1
  fi

  echo "NOTICE: Gateway failed ${GW_CONSECUTIVE_FAILS} times in a row; running 'openclaw doctor --fix' (attempt ${GW_DOCTOR_REPAIR_RUNS}/${GW_DOCTOR_REPAIR_MAX})..."
  echo "INFO: Automatic doctor repair holds maintenance latch ($GATEWAY_MAINTENANCE_FLAG); gateway stays down."

  # Snapshot the live config first so the automatic repair stays reversible.
  DOCTOR_STAMP="$(date -u +%Y%m%d-%H%M%S)"
  cp -a "${OPENCLAW_CONFIG_DIR}/openclaw.json" "${OPENCLAW_CONFIG_DIR}/openclaw.json.pre-doctor-${DOCTOR_STAMP}" 2>/dev/null \
    || echo "WARN: Could not snapshot openclaw.json before doctor --fix; proceeding without snapshot."
  ls -1t "${OPENCLAW_CONFIG_DIR}"/openclaw.json.pre-doctor-* 2>/dev/null \
    | tail -n +6 \
    | while IFS= read -r old; do rm -f "$old" 2>/dev/null || true; done || true

  if run_bounded_doctor_repair "safe migration" --fix --non-interactive --yes; then
    echo "INFO: 'openclaw doctor --fix' completed."
  else
    echo "WARN: 'openclaw doctor --fix' exited non-zero — repair may be incomplete."
    # Fallback: the non-interactive form only performs safe migrations, so a
    # blocked agent-database lease can survive it. Retry once as a full repair,
    # bounded and timed independently by the same operator-controlled budget.
    echo "NOTICE: Retrying the repair as a full repair (openclaw doctor --fix --yes --force)…"
    if run_bounded_doctor_repair "full repair" --fix --yes --force; then
      echo "INFO: 'openclaw doctor --fix' (full repair) completed."
    else
      echo "WARN: 'openclaw doctor --fix' (full repair) exited non-zero — repair may be incomplete."
    fi
  fi

  # A killed repair can leave a lease whose process no longer exists. Clean up
  # only rows with a provably dead owner; live or unknown owners are preserved.
  python3 "$HELPER_PATH" cleanup-stale-leases \
    || echo "WARN: stale lease cleanup failed; live or unreadable lease rows were left untouched."

  # Every repair writes a full agent-database capture. Keep only the newest N
  # snapshots so retries cannot grow the configuration volume without bound.
  DOCTOR_CAPTURE_DIR="$(dirname "$OPENCLAW_CONFIG_DIR")/.openclaw.update-captures"
  if [ -d "$DOCTOR_CAPTURE_DIR" ]; then
    OLD_CAPTURES=$(ls -1dt "$DOCTOR_CAPTURE_DIR"/doctor-* 2>/dev/null | tail -n "+$((GW_DOCTOR_CAPTURE_KEEP + 1))")
    if [ -n "$OLD_CAPTURES" ]; then
      echo "$OLD_CAPTURES" | while IFS= read -r old; do rm -rf "$old" 2>/dev/null || true; done
      echo "INFO: Retained only the newest ${GW_DOCTOR_CAPTURE_KEEP} doctor snapshots."
    fi
  fi

  # This runs after both successful and failed repairs. The shutdown trap also
  # calls it if the add-on is stopped while a repair is in flight.
  release_automatic_doctor_latch
}

while true; do
  GW_ADOPT_CLOCK_START=$SECONDS
  if [ "$GW_IS_CHILD" = "true" ]; then
    # Efficient blocking wait on our child process.
    GW_EXIT_CODE=0
    wait "${GW_PID}" 2>/dev/null || GW_EXIT_CODE=$?
  else
    # GW_PID is NOT our child (re-tracked after a self-restart).
    # Poll with kill -0 until it exits. Adoption is provisional until this
    # exact PID (or the real gateway replacing it) owns the internal port.
    GW_ADOPT_CONFIRMED=false
    if [ "$GATEWAY_MODE" = "remote" ]; then
      GW_ADOPT_CONFIRMED=true
    fi
    while kill -0 "$GW_PID" 2>/dev/null; do
      if [ "$SHUTTING_DOWN" = "true" ]; then break 2; fi
      if [ "$GW_ADOPT_CONFIRMED" != "true" ]; then
        GW_LISTENER_PID=$(oc_gateway_listener_pid || true)
        if [ -n "$GW_LISTENER_PID" ] && oc_gateway_pid_is_daemon "$GW_LISTENER_PID"; then
          if [ "$GW_LISTENER_PID" != "$GW_PID" ]; then
            echo "INFO: Gateway port ${GATEWAY_INTERNAL_PORT} is owned by PID ${GW_LISTENER_PID}, not ${GW_PID}; monitoring ${GW_LISTENER_PID}."
            GW_PID="$GW_LISTENER_PID"
          fi
          GW_ADOPT_CONFIRMED=true
        elif [ $((SECONDS - GW_ADOPT_CLOCK_START)) -ge "$GW_ADOPT_CONFIRM_TIMEOUT" ]; then
          echo "WARN: PID ${GW_PID} did not bind gateway port ${GATEWAY_INTERNAL_PORT} within ${GW_ADOPT_CONFIRM_TIMEOUT}s; it is not the gateway. Relaunching."
          # The adopted process is not ours to leave running: on a large state
          # it can still be preparing the agent databases, and a second gateway
          # would race it for the same state (and the doctor gate must never
          # run against a live gateway). It is therefore stopped and reaped
          # before the relaunch.
          stop_pid_bounded "$GW_PID" "adopted gateway" 10 || true
          GW_DENIED_PIDS="${GW_DENIED_PIDS} ${GW_PID}"
          break
        fi
      fi
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
    gateway_log_mark
    GW_PREV_BOOT_ALIVE=1
    continue
  fi

  # --- Final port guard ------------------------------------------------------
  # Even if all detection methods missed the daemon during the loop above,
  # the port may now be bound (the daemon finished initialising while we slept).
  # Never launch a duplicate if the port is occupied.
  PORT_PID=""
  if [ "$GATEWAY_MODE" != "remote" ]; then
    PORT_PID=$(oc_gateway_listener_pid || true)
  fi
  if [ -n "$PORT_PID" ] && oc_gateway_pid_is_daemon "$PORT_PID"; then
    echo "INFO: Gateway port ${GATEWAY_INTERNAL_PORT} occupied by PID ${PORT_PID:-unknown}; monitoring."
    GW_PID="${PORT_PID:-$GW_PID}"
    GW_IS_CHILD=false
    GW_BOOT_START=$(date +%s)
    gateway_log_mark
    GW_PREV_BOOT_ALIVE=1
    continue
  fi

  # --- Operator maintenance latch: hold the gateway down on request ----------
  # Checked AFTER exit detection (so a live daemon keeps running until it
  # exits or is stopped by 'oc-gateway stop') and BEFORE backoff/doctor —
  # the whole point: `openclaw doctor` must never race the respawner. The
  # flag survives add-on restarts deliberately (explicit operator state).
  if [ -f "$GATEWAY_MAINTENANCE_FLAG" ]; then
    echo "NOTICE: Maintenance latch present; gateway held down (no respawn, no auto-doctor)."
    echo "        Run your maintenance now (e.g. 'openclaw doctor')."
    echo "        Resume with 'oc-gateway resume' — or delete ${GATEWAY_MAINTENANCE_FLAG}."
    while [ -f "$GATEWAY_MAINTENANCE_FLAG" ]; do
      sleep 5
      [ "$SHUTTING_DOWN" = "true" ] && break 2
    done
    if [ "$SHUTTING_DOWN" = "true" ]; then
      break
    fi
    echo "INFO: Maintenance latch removed; restarting gateway with a fresh state."
    GW_PID=""
    GW_IS_CHILD=false
    GW_BOOT_START=$(date +%s)
    gateway_log_mark
    GW_PREV_BOOT_ALIVE=0
    GW_CONSECUTIVE_FAILS=0
    if [ "${GW_ACTIVATION_OK}" != "1" ]; then
      echo "WARN: the retained state has not been repaired yet; retrying the repair."
      # An operator-held latch wins: the repair belongs to the operator then.
      if [ -f "${GATEWAY_MAINTENANCE_FLAG}" ]; then
        echo "NOTICE: Maintenance latch present; the repair is left to the operator."
        GW_IS_CHILD=false
        GW_PID=""
        sleep "$GW_BACKOFF"
        continue
      fi
      GW_ACTIVATION_RETRIES=$(( ${GW_ACTIVATION_RETRIES:-0} + 1 ))
      if [ "${GW_ACTIVATION_RETRIES}" -gt "${GW_ACTIVATION_MAX_RETRIES:-3}" ]; then
        echo "WARN: the repair did not succeed after ${GW_ACTIVATION_RETRIES} attempts; the gateway stays down."
        GW_IS_CHILD=false
        GW_PID=""
        sleep "$GW_BACKOFF"
        continue
      fi
      run_image_activation || true
      if [ "${GW_ACTIVATION_OK}" != "1" ]; then
        echo "WARN: the repair did not finish; the gateway is not started."
        GW_IS_CHILD=false
        GW_PID=""
        sleep "$GW_BACKOFF"
        continue
      fi
    fi
    if start_openclaw_runtime; then
      GW_IS_CHILD=true
      GW_BOOT_START=$(date +%s)
    gateway_log_mark
      GW_PREV_BOOT_ALIVE=1
      start_gw_relay
    else
      echo "ERROR: Failed to restart OpenClaw runtime after maintenance; re-entering supervision."
      GW_PID=""
      GW_IS_CHILD=false
      GW_CONSECUTIVE_FAILS=0
    fi
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
  # Only a clean exit resets the streak. A gateway that ends with a non-zero
  # exit code never finished its startup - the runtime exits with 1 while the
  # agent-database admission is still pending - so it counts as a failed start
  # no matter how long it lived. Resetting the streak there restarted the
  # gateway every few seconds and starved the preparation.
  if [ "${GW_EXIT_CODE:-1}" -eq 0 ] && [ "${GW_PREV_BOOT_ALIVE:-0}" = "1" ]; then
    GW_CONSECUTIVE_FAILS=0
    echo "INFO: Previous gateway boot ended cleanly after ${GW_BOOT_SECONDS}s; failure streak reset."
  elif [ "${GW_EXIT_CODE:-1}" -ne 0 ]; then
    echo "INFO: Previous gateway boot ended with code ${GW_EXIT_CODE:-1} after ${GW_BOOT_SECONDS}s; failure streak is kept."
  elif gateway_startup_admission_refused; then
    echo "INFO: Previous gateway boot did not finish the agent-database startup admission; \
the failure streak is kept so the preparation can make progress."
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
    GW_AUTO_DOCTOR_RC=0
    run_automatic_doctor_repair || GW_AUTO_DOCTOR_RC=$?
    if [ "$GW_AUTO_DOCTOR_RC" -eq 75 ]; then
      echo "NOTICE: Automatic doctor repair deferred to the existing operator maintenance hold."
    elif [ "$GW_AUTO_DOCTOR_RC" -ne 0 ]; then
      echo "ERROR: Automatic doctor repair could not finish safely (exit code ${GW_AUTO_DOCTOR_RC}); the maintenance hold is preserved if it could not be released."
    fi
    # If latch creation or release failed, never fall through to a runtime start
    # while the shared maintenance flag still requests a held-down gateway.
    if [ -f "$GATEWAY_MAINTENANCE_FLAG" ]; then
      echo "NOTICE: Maintenance latch remains present after the repair gate; gateway stays held down."
      continue
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
  # The agent-database startup preparation needs minutes: the runtime repairs
  # every agent database (schema, integrity, FTS) before it admits the agents,
  # and the repair of the largest databases takes longer than a restart delay.
  # A restart storm starves it, so the floor is well above the old 2s and
  # leaves the automatic doctor repair room to finish the preparation.
  if [ "$GW_BACKOFF" -lt 120 ]; then
    GW_BACKOFF=120
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

  if [ "${GW_ACTIVATION_OK}" != "1" ]; then
    echo "WARN: the retained state has not been repaired yet; retrying the repair."
    if [ -f "${GATEWAY_MAINTENANCE_FLAG}" ]; then
      echo "NOTICE: Maintenance latch present; the repair is left to the operator."
      sleep "$GW_BACKOFF"
      continue
    fi
    GW_ACTIVATION_RETRIES=$(( ${GW_ACTIVATION_RETRIES:-0} + 1 ))
    if [ "${GW_ACTIVATION_RETRIES}" -gt "${GW_ACTIVATION_MAX_RETRIES:-3}" ]; then
      echo "WARN: the repair did not succeed after ${GW_ACTIVATION_RETRIES} attempts; the gateway stays down."
      sleep "$GW_BACKOFF"
      continue
    fi
    run_image_activation || true
    if [ "${GW_ACTIVATION_OK}" != "1" ]; then
      echo "WARN: the repair did not finish; the gateway is not started."
      sleep "$GW_BACKOFF"
      continue
    fi
  fi
  if ! start_openclaw_runtime; then
    echo "ERROR: Failed to restart OpenClaw runtime; retrying in ${GW_BACKOFF}s..."
    sleep "$GW_BACKOFF"
    # Audit: a failed restart must not leave a stale (already reaped or
    # re-tracked-external) GW_PID behind — with GW_IS_CHILD still true the
    # next iteration `wait`s on the reaped child and logs a bogus
    # "exited with code 127". Mirror the failed-initial-start state here.
    GW_PID=""
    GW_IS_CHILD=false
  else
    GW_IS_CHILD=true
    GW_BOOT_START=$(date +%s)
    gateway_log_mark
    GW_PREV_BOOT_ALIVE=1
    start_gw_relay
  fi
done
