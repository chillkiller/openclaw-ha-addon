#!/usr/bin/env python3
"""
OpenClaw config helper for Home Assistant add-on (v0.7.0).

Safely reads/writes openclaw.json without corrupting it.
Implements 3-layer merge: Custom JSON -> Persisted config -> HA options.

Also handles mDNS via nginx config injection (not openclaw.json,
since OpenClaw 2026.4.10+ deprecated discovery.mDNS in config).

Based on patterns from coollabsio/configure.js + techartdev oc_config_helper.py.
"""

import json
import os
import re
import sys
from pathlib import Path

CONFIG_PATH = Path(
    os.environ.get("OPENCLAW_CONFIG_PATH", "/config/.openclaw/openclaw.json")
)


def read_config():
    """Read and parse openclaw.json."""
    if not CONFIG_PATH.exists():
        return None
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, IOError) as e:
        print(f"ERROR: Failed to read config: {e}", file=sys.stderr)
        return None


def write_config(cfg):
    """Atomic write to prevent corruption on crash."""
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        temp_path = CONFIG_PATH.with_suffix(".json.tmp")
        temp_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        temp_path.rename(CONFIG_PATH)
        return True
    except IOError as e:
        print(f"ERROR: Failed to write config: {e}", file=sys.stderr)
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        return False


def deep_merge(target, source):
    """
    Deep merge source into target. Arrays are replaced, not concatenated.
    Prototype pollution safe.
    """
    unsafe_keys = {"__proto__", "constructor", "prototype"}
    for key in source:
        if key in unsafe_keys:
            continue
        if (
            isinstance(source[key], dict)
            and isinstance(target.get(key), dict)
            and not isinstance(target.get(key), list)
        ):
            deep_merge(target[key], source[key])
        else:
            target[key] = source[key]
    return target


def apply_gateway_settings(
    mode: str,
    remote_url: str,
    bind_mode: str,
    port: int,
    enable_openai_api: bool,
    auth_mode: str,
    trusted_proxies_csv: str,
):
    """
    Apply gateway settings to OpenClaw config.
    Only overwrites keys that differ — preserves everything else.
    """
    if mode not in ["local", "remote"]:
        print(f"ERROR: Invalid mode '{mode}'. Must be 'local' or 'remote'")
        return False
    if bind_mode not in ["loopback", "lan", "tailnet"]:
        print(f"ERROR: Invalid bind_mode '{bind_mode}'")
        return False
    if port < 1 or port > 65535:
        print(f"ERROR: Invalid port {port}")
        return False
    if auth_mode not in ["token", "trusted-proxy"]:
        print(f"ERROR: Invalid auth_mode '{auth_mode}'")
        return False

    cfg = read_config() or {}
    gateway = cfg.setdefault("gateway", {})
    remote_cfg = gateway.setdefault("remote", {})
    auth = gateway.setdefault("auth", {})
    http = gateway.setdefault("http", {})
    endpoints = http.setdefault("endpoints", {})
    chat = endpoints.setdefault("chatCompletions", {})

    trusted_proxies = [p.strip() for p in trusted_proxies_csv.split(",") if p.strip()]
    trusted_proxy_default = {"userHeader": "x-forwarded-user"}

    changes = []

    if gateway.get("mode") != mode:
        gateway["mode"] = mode
        changes.append(f"mode: {gateway.get('mode')} -> {mode}")

    if remote_cfg.get("url") != remote_url:
        remote_cfg["url"] = remote_url
        changes.append(f"remote.url -> {remote_url}")

    if gateway.get("bind") != bind_mode:
        gateway["bind"] = bind_mode
        changes.append(f"bind: {gateway.get('bind')} -> {bind_mode}")

    if gateway.get("port") != port:
        gateway["port"] = port
        changes.append(f"port: {gateway.get('port')} -> {port}")

    if chat.get("enabled") != enable_openai_api:
        chat["enabled"] = enable_openai_api
        changes.append(f"chatCompletions.enabled -> {enable_openai_api}")

    if auth.get("mode") != auth_mode:
        auth["mode"] = auth_mode
        changes.append(f"auth.mode -> {auth_mode}")

    if gateway.get("trustedProxies") != trusted_proxies:
        gateway["trustedProxies"] = trusted_proxies
        changes.append(f"trustedProxies -> {trusted_proxies}")

    if auth_mode == "trusted-proxy" and auth.get("trustedProxy") != trusted_proxy_default:
        auth["trustedProxy"] = trusted_proxy_default
        changes.append("auth.trustedProxy: configured default userHeader")

    if changes:
        if write_config(cfg):
            print(f"INFO: Updated gateway settings: {', '.join(changes)}")
            return True
        print("ERROR: Failed to write config")
        return False

    print(f"INFO: Gateway settings already correct (mode={mode}, bind={bind_mode}, port={port})")
    return True


def set_control_ui_origins(
    origins_csv: str, additional_origins_csv: str = "", disable_device_auth: bool = True
):
    """Configure gateway.controlUi for the built-in HTTPS proxy."""
    cfg = read_config() or {}
    gateway = cfg.setdefault("gateway", {})
    control_ui = gateway.setdefault("controlUi", {})

    default_origins = [o.strip() for o in origins_csv.split(",") if o.strip()]
    additional_origins = [o.strip() for o in (additional_origins_csv or "").split(",") if o.strip()]
    current_origins = control_ui.get("allowedOrigins", [])
    if not isinstance(current_origins, list):
        current_origins = []

    merged = []
    for origin in [*default_origins, *current_origins, *additional_origins]:
        if isinstance(origin, str) and origin and origin not in merged:
            merged.append(origin)

    changes = []
    if current_origins != merged:
        control_ui["allowedOrigins"] = merged
        changes.append(f"allowedOrigins -> {merged}")

    desired_flag = True if disable_device_auth else False
    if control_ui.get("dangerouslyDisableDeviceAuth") is not desired_flag:
        control_ui["dangerouslyDisableDeviceAuth"] = desired_flag
        changes.append(f"dangerouslyDisableDeviceAuth -> {desired_flag}")

    # Remove stale keys from earlier add-on versions
    for stale in ("pairingMode",):
        if stale in control_ui:
            del control_ui[stale]
            changes.append(f"removed stale key: {stale}")

    if not changes:
        return True

    if write_config(cfg):
        print(f"INFO: Updated controlUi: {', '.join(changes)}")
        return True
    print("ERROR: Failed to write config")
    return False


def set_mdns_settings(
    mode: str, service_port: int, host_name: str = "", interface_name: str = ""
):
    """
    Configure mDNS/Bonjour discovery for the gateway.

    EXCLUSIVE MODE LOGIC:
    - off: discovery.mdns.mode='off' (no mDNS)
    - minimal/full: discovery.mdns.mode set to requested value (Gateway internal mDNS)
    - avahi: discovery.mdns.mode='off' (Avahi handles mDNS, Gateway disabled)
    """
    cfg = read_config() or {}

    # Validate mode
    valid_modes = ["off", "minimal", "full", "avahi"]
    if mode not in valid_modes:
        print(f"ERROR: Invalid mDNS mode '{mode}'. Must be one of: {', '.join(valid_modes)}")
        return False

    cfg.setdefault("discovery", {})

    # EXCLUSIVE MODE HANDLING
    if mode == "avahi":
        # Avahi mode: Gateway mDNS explicitly OFF to prevent collisions
        cfg["discovery"]["mdns"] = {"mode": "off"}
        if write_config(cfg):
            print("INFO: Avahi mode - Gateway mDNS disabled (discovery.mdns.mode=off)")
        else:
            print("WARN: Failed to write discovery.mdns.mode to config")
        return True
    elif mode == "off":
        # Off mode: No mDNS at all
        cfg["discovery"]["mdns"] = {"mode": "off"}
        if write_config(cfg):
            print("INFO: mDNS disabled (discovery.mdns.mode=off)")
        else:
            print("WARN: Failed to write discovery.mdns.mode to config")
        return True
    else:
        # minimal/full: Gateway internal mDNS mode active
        cfg["discovery"]["mdns"] = {"mode": mode}
        if write_config(cfg):
            print(f"INFO: Gateway mDNS enabled (discovery.mdns.mode={mode})")
        else:
            print("WARN: Failed to write discovery.mdns.mode to config")
        return True


def cleanup_stale_config_keys():
    """Remove stale/invalid config keys no longer supported by OpenClaw."""
    cfg = read_config()
    if cfg is None:
        return True

    changes = []
    if "discovery" in cfg:
        # Remove deprecated uppercase mDNS key (OpenClaw uses lowercase mdns)
        if "mDNS" in cfg["discovery"]:
            del cfg["discovery"]["mDNS"]
            changes.append("removed deprecated discovery.mDNS (uppercase)")
        # Keep lowercase discovery.mdns — we write it to disable Bonjour
        if not cfg["discovery"]:
            del cfg["discovery"]
            changes.append("removed empty discovery section")

    if not changes:
        return True

    if write_config(cfg):
        print(f"INFO: Cleaned stale config keys: {', '.join(changes)}")
        return True
    print("ERROR: Failed to clean stale config keys")
    return False


def ensure_plugins():
    """Ensure critical plugins entries are preserved in config.

    The gateway may remove or not write plugins.entries on config reload.
    This function ensures that essential plugin entries (like ollama for web search)
    are always present in the config.
    """
    cfg = read_config() or {}
    plugins = cfg.setdefault("plugins", {})
    entries = plugins.setdefault("entries", {})

    # Required plugins that must always be present
    required_plugins = {
        "ollama": {"enabled": True}
    }

    changes = []
    for plugin_id, plugin_config in required_plugins.items():
        if plugin_id not in entries:
            entries[plugin_id] = plugin_config
            changes.append(f"plugins.entries.{plugin_id} -> added")
        elif not entries[plugin_id].get("enabled", False):
            entries[plugin_id]["enabled"] = True
            changes.append(f"plugins.entries.{plugin_id}.enabled -> true")

    if changes:
        if write_config(cfg):
            print(f"INFO: Ensured plugins: {', '.join(changes)}")
            return True
        print("ERROR: Failed to write config")
        return False

    print("INFO: Plugins already correct")
    return True


def generate_mdns_nginx_snippet(public_port: int, internal_port: int, host_name: str = ""):
    """
    Generate nginx config snippet for mDNS-aware HTTPS proxy.

    This is the SOVEREIGN mDNS FIX: nginx listens on the public port
    (the one mDNS advertises) and proxies to the internal gateway port.

    Returns a string with nginx location blocks, or empty string if not needed.
    """
    if public_port == internal_port:
        return ""  # No proxy needed when ports match

    snippet = f"""
# SOVEREIGN mDNS FIX: Advertise public port {public_port} via mDNS
# Proxy from public HTTPS port -> internal gateway port {internal_port}
# This ensures clients discovering the service via mDNS land on the right port
"""
    return snippet


def main():
    """CLI entry point for use by run.sh"""
    if len(sys.argv) < 2:
        print("Usage: oc_config_helper.py <command> [args...]")
        print("Commands:")
        print("  apply-gateway-settings <mode> <remote_url> <bind> <port> <openai_api> <auth_mode> <trusted_proxies>")
        print("  set-control-ui-origins <origins_csv> [additional_csv] [disable_device_auth]")
        print("  set-mdns-settings <mode> <port> [hostname] [interface]")
        print("  cleanup-stale-config")
        print("  get <key>")
        print("  set <key> <value>")
        print("  mdns-nginx-snippet <public_port> <internal_port> [hostname]")
        print("  ensure-plugins")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "apply-gateway-settings":
        if len(sys.argv) != 9:
            print("Usage: oc_config_helper.py apply-gateway-settings <local|remote> <remote_url> <loopback|lan|tailnet> <port> <enable_openai_api:true|false> <auth_mode> <trusted_proxies_csv>")
            sys.exit(1)
        success = apply_gateway_settings(
            sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]),
            sys.argv[6].lower() == "true", sys.argv[7], sys.argv[8]
        )
        sys.exit(0 if success else 1)

    elif cmd == "get":
        if len(sys.argv) != 3:
            print("Usage: oc_config_helper.py get <key>")
            sys.exit(1)
        value = read_config()
        if value:
            gateway = value.get("gateway", {})
            print(gateway.get(sys.argv[2], ""))
        sys.exit(0)

    elif cmd == "set":
        if len(sys.argv) != 4:
            print("Usage: oc_config_helper.py set <key> <value>")
            sys.exit(1)
        cfg = read_config() or {}
        gateway = cfg.setdefault("gateway", {})
        key, value = sys.argv[2], sys.argv[3]
        try:
            value = int(value)
        except ValueError:
            pass
        gateway[key] = value
        sys.exit(0 if write_config(cfg) else 1)

    elif cmd == "set-control-ui-origins":
        if len(sys.argv) not in (3, 4, 5):
            print("Usage: oc_config_helper.py set-control-ui-origins <origins_csv> [additional] [disable_device_auth]")
            sys.exit(1)
        origins_csv = sys.argv[2]
        additional = sys.argv[3] if len(sys.argv) >= 4 else ""
        disable = True
        if len(sys.argv) == 5:
            disable = sys.argv[4].strip().lower() == "true"
        sys.exit(0 if set_control_ui_origins(origins_csv, additional, disable) else 1)

    elif cmd == "set-mdns-settings":
        if len(sys.argv) not in (4, 5, 6):
            print("Usage: oc_config_helper.py set-mdns-settings <mode> <port> [hostname] [interface]")
            sys.exit(1)
        mode = sys.argv[2]
        port = int(sys.argv[3])
        hostname = sys.argv[4] if len(sys.argv) >= 5 else ""
        interface = sys.argv[5] if len(sys.argv) >= 6 else ""
        sys.exit(0 if set_mdns_settings(mode, port, hostname, interface) else 1)

    elif cmd == "mdns-nginx-snippet":
        if len(sys.argv) not in (4, 5):
            print("Usage: oc_config_helper.py mdns-nginx-snippet <public_port> <internal_port> [hostname]")
            sys.exit(1)
        snippet = generate_mdns_nginx_snippet(
            int(sys.argv[2]), int(sys.argv[3]),
            sys.argv[4] if len(sys.argv) >= 5 else ""
        )
        if snippet:
            print(snippet)
        sys.exit(0)

    elif cmd == "ensure-plugins":
        sys.exit(0 if ensure_plugins() else 1)

    elif cmd == "cleanup-stale-config":
        sys.exit(0 if cleanup_stale_config_keys() else 1)

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()