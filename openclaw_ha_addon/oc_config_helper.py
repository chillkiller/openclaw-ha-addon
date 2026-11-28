#!/usr/bin/env python3
"""
OpenClaw config helper for Home Assistant app (v0.7.0).

Safely reads/writes openclaw.json without corrupting it.
Implements 3-layer merge: Custom JSON -> Persisted config -> HA options.

Also handles mDNS via nginx config injection (not openclaw.json,
since OpenClaw 2026.4.10+ deprecated discovery.mDNS in config).

Based on patterns from coollabsio/configure.js + techartdev oc_config_helper.py.
"""

import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path

CONFIG_PATH = Path(
    os.environ.get("OPENCLAW_CONFIG_PATH", "/config/.openclaw/openclaw.json")
)


def read_config():
    """Read and parse openclaw.json.

    SECURITY/DATA-LOSS invariant (audit 2026-10-09): a corrupt (unparseable)
    config is quarantined as openclaw.json.corrupt and this helper exits 1.
    Callers historically fell back to `read_config() or {}` and wrote a
    minimal stub back over the corrupt file — silently destroying provider
    keys, agents and plugin entries. A quarantine must never be overwritten;
    the operator restores from the .corrupt copy (or a pre-upgrade backup).
    """
    if not CONFIG_PATH.exists():
        return None
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        # Corrupt CONTENT: quarantine so the bytes are never silently
        # overwritten by a write-back stub, and exit 1 (fail-closed).
        print(f"ERROR: openclaw.json is corrupt ({e}); refusing to treat it as an empty config", file=sys.stderr)
        import datetime
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
        quarantine = CONFIG_PATH.with_name(CONFIG_PATH.name + ".corrupt")
        if quarantine.exists():
            # Never clobber an existing recovery copy.
            quarantine = CONFIG_PATH.with_name(f"{CONFIG_PATH.name}.corrupt.{stamp}")
        try:
            CONFIG_PATH.rename(quarantine)
            print(f"INFO: corrupt config quarantined as {quarantine} — restore it manually after repair", file=sys.stderr)
        except OSError as qe:
            print(f"ERROR: quarantine failed: {qe} — the corrupt file was left in place", file=sys.stderr)
        sys.exit(1)
    except IOError as e:
        # Unreadable (transient EIO, EACCES, ...), NOT necessarily corrupt.
        # A one-off storage hiccup is no reason to rename a possibly-good
        # config to .corrupt — that would brick the next boot behind the
        # corrupt-copy guard. Fail closed WITHOUT touching the file.
        print(f"ERROR: openclaw.json could not be read ({e}); refusing to treat it as an empty config", file=sys.stderr)
        sys.exit(1)


def write_config(cfg):
    """Atomic write to prevent corruption on crash."""
    temp_path = None
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        temp_path = CONFIG_PATH.with_suffix(".json.tmp")
        temp_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        temp_path.rename(CONFIG_PATH)
        return True
    except IOError as e:
        print(f"ERROR: Failed to write config: {e}", file=sys.stderr)
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        return False


def migrate_retired_heartbeat_config():
    """Remove the one configuration key retired by OpenClaw 2026.11.6.

    The pre-change snapshot deliberately uses the same UTC timestamped
    ``openclaw.json.pre-doctor-*`` naming as the automatic repair path. A
    successful second run has no key to remove and therefore writes no backup.
    """
    cfg = read_config()
    if cfg is None:
        return True
    agents = cfg.get("agents") if isinstance(cfg, dict) else None
    defaults = agents.get("defaults") if isinstance(agents, dict) else None
    if not isinstance(defaults, dict) or "heartbeat" not in defaults:
        return True

    import datetime

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = CONFIG_PATH.with_name(f"{CONFIG_PATH.name}.pre-doctor-{stamp}")
    if backup.exists():
        # Do not overwrite an independent repair snapshot created in the same
        # second. The fractional suffix is only a collision guard.
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
        backup = CONFIG_PATH.with_name(f"{CONFIG_PATH.name}.pre-doctor-{stamp}")
    try:
        shutil.copy2(CONFIG_PATH, backup)
    except OSError as exc:
        print(f"ERROR: Could not snapshot openclaw.json before retiring agents.defaults.heartbeat: {exc}", file=sys.stderr)
        return False

    del defaults["heartbeat"]
    if not write_config(cfg):
        print("ERROR: Could not remove retired key agents.defaults.heartbeat; the original config remains active", file=sys.stderr)
        return False
    print(
        "INFO: Retired configuration key agents.defaults.heartbeat removed; "
        f"the runtime removed the heartbeat feature. Pre-change snapshot: {backup}"
    )
    return True


def _pid_is_alive(pid):
    """Return False only for a definitely absent process, True when alive/unknown."""
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # An unusual process-query failure is not proof that the owner died.
        return True
    return True


def cleanup_stale_state_leases(state_db_path=None):
    """Delete only lease rows whose recorded owner process is definitely dead.

    OpenClaw stores state-lease process facts in payload_json.owner.pid and
    agent-database lease pids in agent_database_leases.owner_pid. Both tables
    live in the shared state database; agent content databases are never
    opened or modified by this cleanup.
    """
    if state_db_path is None:
        config_dir = Path(os.environ.get("OPENCLAW_CONFIG_DIR", str(CONFIG_PATH.parent)))
        state_db_path = config_dir / "state" / "openclaw.sqlite"
    state_db_path = Path(state_db_path)
    if not state_db_path.is_file():
        return True

    removed = []
    try:
        with sqlite3.connect(str(state_db_path), timeout=5) as conn:
            conn.execute("PRAGMA busy_timeout=5000")
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('state_leases', 'agent_database_leases')"
                )
            }
            with conn:
                if "state_leases" in tables:
                    columns = {row[1] for row in conn.execute("PRAGMA table_info(state_leases)")}
                    required = {"scope", "lease_key", "owner", "payload_json"}
                    if required.issubset(columns):
                        rows = conn.execute(
                            "SELECT scope, lease_key, owner, payload_json FROM state_leases"
                        ).fetchall()
                        for scope, lease_key, owner, payload_json in rows:
                            try:
                                payload = json.loads(payload_json) if payload_json else None
                            except (json.JSONDecodeError, TypeError):
                                continue
                            process_owner = payload.get("owner") if isinstance(payload, dict) else None
                            pid = process_owner.get("pid") if isinstance(process_owner, dict) else None
                            if _pid_is_alive(pid):
                                continue
                            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                                # Missing/malformed owner metadata is unknown,
                                # not proof of death; leave that row untouched.
                                continue
                            cursor = conn.execute(
                                "DELETE FROM state_leases WHERE scope=? AND lease_key=? AND owner=? AND payload_json=?",
                                (scope, lease_key, owner, payload_json),
                            )
                            if cursor.rowcount == 1:
                                removed.append(("state_leases", f"{scope}/{lease_key}", pid))

                if "agent_database_leases" in tables:
                    columns = {row[1] for row in conn.execute("PRAGMA table_info(agent_database_leases)")}
                    if {"lease_id", "owner_pid"}.issubset(columns):
                        rows = conn.execute(
                            "SELECT lease_id, owner_pid FROM agent_database_leases"
                        ).fetchall()
                        for lease_id, pid in rows:
                            if _pid_is_alive(pid):
                                continue
                            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                                continue
                            cursor = conn.execute(
                                "DELETE FROM agent_database_leases WHERE lease_id=? AND owner_pid=?",
                                (lease_id, pid),
                            )
                            if cursor.rowcount == 1:
                                removed.append(("agent_database_leases", str(lease_id), pid))
    except (OSError, sqlite3.Error) as exc:
        print(f"ERROR: Could not check/remove stale state lease rows: {exc}", file=sys.stderr)
        return False

    for table, identity, pid in removed:
        print(f"INFO: Removed stale {table} row {identity}; owner pid {pid} is dead")
    if not removed:
        print("INFO: No stale state or agent-database lease rows with a dead owner pid found")
    return True


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


VALID_NETWORK_MODES = [
    "ingress_only",
    "lan_http",
    "lan_https",
    "tailnet_serve",
    "tailnet_funnel",
    "reverse_proxy",
]


def apply_network_settings(
    network_mode: str,
    mode: str,
    remote_url: str,
    bind_mode: str,
    port: int,
    internal_port: int,
    enable_openai_api: bool,
    auth_mode: str,
    trusted_proxies_csv: str,
    tls_enabled_str: str,
    tls_auto_str: str,
    tailscale_mode: str,
):
    """Apply OpenClaw-native network, TLS, auth and Tailscale settings."""
    if network_mode not in VALID_NETWORK_MODES:
        print(f"ERROR: Invalid network_mode '{network_mode}'")
        return False
    if mode not in ["local", "remote"]:
        print(f"ERROR: Invalid gateway mode '{mode}'")
        return False
    if bind_mode not in ["loopback", "lan", "tailnet", "auto", "custom"]:
        print(f"ERROR: Invalid bind_mode '{bind_mode}'")
        return False
    if port < 1 or port > 65535:
        print(f"ERROR: Invalid port {port}")
        return False
    if internal_port < 1 or internal_port > 65535:
        print(f"ERROR: Invalid internal_port {internal_port}")
        return False
    if auth_mode not in ["token", "trusted-proxy", "password"]:
        print(f"ERROR: Invalid auth_mode '{auth_mode}'")
        return False

    cfg = read_config() or {}
    gateway = cfg.setdefault("gateway", {})
    remote_cfg = gateway.setdefault("remote", {})
    auth = gateway.setdefault("auth", {})
    http = gateway.setdefault("http", {})
    endpoints = http.setdefault("endpoints", {})
    chat = endpoints.setdefault("chatCompletions", {})
    tls = gateway.setdefault("tls", {})
    tailscale = gateway.setdefault("tailscale", {})

    changes = []

    if gateway.get("mode") != mode:
        gateway["mode"] = mode
        changes.append(f"mode -> {mode}")

    if remote_cfg.get("url") != remote_url:
        remote_cfg["url"] = remote_url
        changes.append(f"remote.url -> {remote_url}")

    effective_bind = bind_mode
    effective_port = port
    tls_enabled = tls_enabled_str.lower() == "true"
    tls_auto = tls_auto_str.lower() == "true"

    # In lan_https mode the OpenClaw gateway runs HTTP on a loopback internal port;
    # nginx provides the external HTTPS proxy on the configured gateway_port.
    if network_mode == "lan_https":
        effective_bind = "loopback"
        effective_port = internal_port
        tls_enabled = False

    if gateway.get("bind") != effective_bind:
        gateway["bind"] = effective_bind
        changes.append(f"bind -> {effective_bind}")

    if gateway.get("port") != effective_port:
        gateway["port"] = effective_port
        changes.append(f"port -> {effective_port}")

    desired_tls = {"enabled": tls_enabled}
    if tls_enabled:
        desired_tls["autoGenerate"] = tls_auto

    # Preserve explicit operator-provided certPath/keyPath.
    for keep in ("certPath", "keyPath"):
        if keep in tls:
            desired_tls[keep] = tls[keep]

    if tls != desired_tls:
        gateway["tls"] = desired_tls
        changes.append(f"tls -> {desired_tls}")

    if tailscale_mode and tailscale.get("mode") != tailscale_mode:
        tailscale["mode"] = tailscale_mode
        changes.append(f"tailscale.mode -> {tailscale_mode}")
    elif not tailscale_mode and "mode" in tailscale:
        del tailscale["mode"]
        changes.append("removed tailscale.mode")

    if chat.get("enabled") != enable_openai_api:
        chat["enabled"] = enable_openai_api
        changes.append(f"chatCompletions.enabled -> {enable_openai_api}")

    if auth.get("mode") != auth_mode:
        auth["mode"] = auth_mode
        changes.append(f"auth.mode -> {auth_mode}")

    trusted_proxy_default = {"userHeader": "x-forwarded-user", "allowLoopback": True}
    if auth_mode == "trusted-proxy":
        raw_proxies = [p.strip() for p in trusted_proxies_csv.split(",") if p.strip()]
        if not raw_proxies:
            print("ERROR: auth_mode=trusted-proxy requires non-empty gateway_trusted_proxies")
            return False
        if gateway.get("trustedProxies") != raw_proxies:
            gateway["trustedProxies"] = raw_proxies
            changes.append(f"trustedProxies -> {raw_proxies}")
        if auth.get("trustedProxy") != trusted_proxy_default:
            auth["trustedProxy"] = trusted_proxy_default
            changes.append("auth.trustedProxy -> default")
    else:
        if "trustedProxy" in auth:
            del auth["trustedProxy"]
            changes.append("removed auth.trustedProxy")

    # Remove legacy/deprecated keys from earlier app versions.
    for stale in ("access_mode", "gateway_bind_mode", "gateway_auth_mode"):
        if stale in gateway:
            del gateway[stale]
            changes.append(f"removed stale key: {stale}")

    if changes:
        if write_config(cfg):
            print(f"INFO: Updated network settings: {', '.join(changes)}")
            return True
        print("ERROR: Failed to write config")
        return False

    print(f"INFO: Network settings already correct (mode={network_mode}, bind={bind_mode}, port={port})")
    return True


def apply_gateway_settings(
    mode: str,
    remote_url: str,
    bind_mode: str,
    port: int,
    enable_openai_api: bool,
    auth_mode: str,
    trusted_proxies_csv: str,
):
    """DEPRECATED: use apply_network_settings. Kept for emergency CLI use only."""
    print("WARN: apply_gateway_settings is deprecated; use apply_network_settings")
    return apply_network_settings(
        network_mode="ingress_only",
        mode=mode,
        remote_url=remote_url,
        bind_mode=bind_mode,
        port=port,
        internal_port=port,
        enable_openai_api=enable_openai_api,
        auth_mode=auth_mode,
        trusted_proxies_csv=trusted_proxies_csv,
        tls_enabled_str="false",
        tls_auto_str="false",
        tailscale_mode="",
    )


def set_control_ui_origins(
    origins_csv: str,
    additional_origins_csv: str = "",
    disable_device_auth: bool = True,
    public_origin: str = "",
):
    """Configure gateway.controlUi and the public origin for the HTTPS proxy."""
    cfg = read_config() or {}
    gateway = cfg.setdefault("gateway", {})
    control_ui = gateway.setdefault("controlUi", {})
    changes: list[str] = []

    # The gateway's public origin is the externally reachable HTTPS address. The
    # Control UI needs it to offer the browser sign-in for OAuth MCP servers,
    # because the OAuth callback has to return to this very origin.
    public_origin = (public_origin or "").strip()
    if public_origin and gateway.get("publicOrigin") != public_origin:
        gateway["publicOrigin"] = public_origin
        changes.append(f"publicOrigin -> {public_origin}")

    default_origins = [o.strip() for o in origins_csv.split(",") if o.strip()]
    additional_origins = [o.strip() for o in (additional_origins_csv or "").split(",") if o.strip()]
    current_origins = control_ui.get("allowedOrigins", [])
    if not isinstance(current_origins, list):
        current_origins = []

    # Deterministic replace (audit 2026-10-09): the previous union-merge kept
    # stale entries forever (e.g. origins from old LAN IPs after a DHCP change
    # grew the list unboundedly and stayed CORS-allowed). The app-managed list
    # is rebuilt each boot from config-derived defaults + the explicit
    # user-extras option (`gateway_additional_allowed_origins`). Dropped
    # entries are logged so a hand-added origin can be re-added via the option.
    merged = []
    for origin in [*default_origins, *additional_origins]:
        if isinstance(origin, str) and origin and origin not in merged:
            merged.append(origin)

    dropped_origins = [o for o in current_origins if isinstance(o, str) and o and o not in merged]
    if dropped_origins:
        print(
            "INFO: pruned stale ControlUI allowedOrigins (re-add permanently via "
            f"gateway_additional_allowed_origins if still needed): {dropped_origins}"
        )

    if current_origins != merged:
        control_ui["allowedOrigins"] = merged
        changes.append(f"allowedOrigins -> {merged}")

    # v0.7.13 (B2, TechArtDev 0.5.90 parity): gateway.controlUi
    # .dangerouslyDisableDeviceAuth is RETIRED and ignored since OpenClaw
    # 2026.9.8 (dist-verified: legacy lint rule says "retired and ignored",
    # doctor deletes the key). Writing it every boot only fights
    # `openclaw doctor --fix`. Keep the config honest: REMOVE the legacy key
    # instead of setting it. The disable_device_auth argument is kept for CLI
    # signature compatibility but no longer influences the gateway config.
    if "dangerouslyDisableDeviceAuth" in control_ui:
        del control_ui["dangerouslyDisableDeviceAuth"]
        changes.append("removed retired key: dangerouslyDisableDeviceAuth")

    # Remove stale keys from earlier app versions
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



def set_control_ui_base_path(base_path: str):
    """Set gateway.controlUi.basePath (e.g. /webui). Idempotent.

    The Control UI is served under this prefix by the gateway itself and the
    add-on nginx proxies it 1:1 (see nginx.conf.tpl). Empty string removes the
    key (UI served at /)."""
    cfg = read_config() or {}
    gateway = cfg.setdefault("gateway", {})
    control_ui = gateway.setdefault("controlUi", {})
    base_path = (base_path or "").strip()
    if base_path:
        if not base_path.startswith("/") or base_path.endswith("/") or "//" in base_path:
            print("ERROR: basePath must be an absolute path without trailing slash, e.g. /webui")
            return False
        if control_ui.get("basePath") == base_path:
            print("INFO: controlUi.basePath already set")
            return True
        control_ui["basePath"] = base_path
    else:
        if "basePath" not in control_ui:
            print("INFO: controlUi.basePath already unset")
            return True
        del control_ui["basePath"]

    if write_config(cfg):
        print(f"INFO: controlUi.basePath -> {base_path or '(removed)'}")
        return True
    print("ERROR: Failed to write config")
    return False


def set_mdns_settings(mode: str):
    """
    Configure OpenClaw's bundled Bonjour mDNS discovery.

    - off: discovery.mdns.mode='off'
    - minimal/full: discovery.mdns.mode set to requested value

    The advertised service port and hostname are derived by OpenClaw from
    gateway.port and the OPENCLAW_MDNS_HOSTNAME environment variable set by
    run.sh.
    """
    valid_modes = ["off", "minimal", "full"]
    if mode not in valid_modes:
        print(f"ERROR: Invalid mDNS mode '{mode}'. Must be one of: {', '.join(valid_modes)}")
        return False

    cfg = read_config() or {}
    cfg.setdefault("discovery", {})

    desired_mdns = {"mode": mode}
    current_mdns = cfg["discovery"].get("mdns")
    if current_mdns != desired_mdns:
        cfg["discovery"]["mdns"] = desired_mdns
        if write_config(cfg):
            print(f"INFO: mDNS mode set to: {mode}")
            return True
        print("ERROR: Failed to write mDNS settings")
        return False

    print(f"INFO: mDNS mode already correct ({mode})")
    return True


def apply_cron_settings(skip_missed_jobs: bool):
    """Apply OpenClaw 2026.9.1 cron.skipMissedJobs setting."""
    cfg = read_config() or {}
    cron = cfg.setdefault("cron", {})

    if cron.get("skipMissedJobs") != skip_missed_jobs:
        cron["skipMissedJobs"] = skip_missed_jobs
        if write_config(cfg):
            print(f"INFO: cron.skipMissedJobs -> {skip_missed_jobs}")
            return True
        print("ERROR: Failed to write cron settings")
        return False

    print(f"INFO: cron.skipMissedJobs already correct ({skip_missed_jobs})")
    return True


def apply_blocked_hostnames(blocked_hostnames_csv: str):
    """Apply OpenClaw 2026.9.1 blockedHostnames SSRF policy."""
    cfg = read_config() or {}
    security = cfg.setdefault("security", {})

    raw = [h.strip() for h in blocked_hostnames_csv.split(",") if h.strip()]
    desired = raw if raw else []

    current = security.get("blockedHostnames", [])
    if not isinstance(current, list):
        current = []

    if current != desired:
        if desired:
            security["blockedHostnames"] = desired
        elif "blockedHostnames" in security:
            del security["blockedHostnames"]
        if write_config(cfg):
            print(f"INFO: security.blockedHostnames -> {desired}")
            return True
        print("ERROR: Failed to write blockedHostnames")
        return False

    print(f"INFO: security.blockedHostnames already correct ({desired})")
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


def ensure_browser_config():
    """Browser configuration is left to the user.

    OpenClaw validates the browser section strictly and defaults
    vary by release. The app provides Playwright Chromium at
    /usr/bin/chromium; configure it manually in openclaw.json when needed.
    """
    print("INFO: browser configuration left to user (no automatic injection)")
    return True


def ensure_memory_core():
    """Memory-core configuration is left to the user.

    OpenClaw validates plugins.entries.memory-core strictly.
    Auto-injected defaults repeatedly broke gateway startup, so users
    configure memory-core manually in openclaw.json when needed.
    """
    print("INFO: memory-core configuration left to user (no automatic injection)")
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
        print("  apply-network-settings <network_mode> <mode> <remote_url> <bind> <port> <internal_port> <openai_api> <auth_mode> <trusted_proxies> <tls_enabled> <tls_auto> <tailscale_mode>")
        print("  apply-gateway-settings <mode> <remote_url> <bind> <port> <openai_api> <auth_mode> <trusted_proxies>  (deprecated)")
        print("  set-control-ui-origins <origins_csv> [additional_csv] [disable_device_auth]")
        print("  set-control-ui-base-path <base_path>  (e.g. /webui; empty string removes the key)")
        print("  set-mdns-settings <mode> [port] [hostname] [interface]")
        print("  apply-cron-settings <skip_missed_jobs:true|false>")
        print("  apply-blocked-hostnames <csv>")
        print("  migrate-retired-heartbeat")
        print("  cleanup-stale-leases")
        print("  cleanup-stale-config")
        print("  get <key>")
        print("  set <key> <value>")
        print("  mdns-nginx-snippet <public_port> <internal_port> [hostname]  (deprecated)")
        print("  ensure-plugins")
        print("  ensure-browser-config")
        print("  ensure-memory-core")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "apply-network-settings":
        if len(sys.argv) != 14:
            print("Usage: oc_config_helper.py apply-network-settings <network_mode> <local|remote> <remote_url> <bind> <port> <internal_port> <enable_openai_api:true|false> <auth_mode> <trusted_proxies_csv> <tls_enabled:true|false> <tls_auto:true|false> <tailscale_mode>")
            sys.exit(1)
        success = apply_network_settings(
            sys.argv[2],   # network_mode
            sys.argv[3],   # mode
            sys.argv[4],   # remote_url
            sys.argv[5],   # bind
            int(sys.argv[6]),  # port
            int(sys.argv[7]),  # internal_port
            sys.argv[8].lower() == "true",  # enable_openai_api
            sys.argv[9],   # auth_mode
            sys.argv[10],  # trusted_proxies_csv
            sys.argv[11],  # tls_enabled
            sys.argv[12],  # tls_auto
            sys.argv[13],  # tailscale_mode
        )
        sys.exit(0 if success else 1)

    elif cmd == "apply-gateway-settings":
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
        if len(sys.argv) not in (3, 4, 5, 6):
            print(
                "Usage: oc_config_helper.py set-control-ui-origins <origins_csv> "
                "[additional] [disable_device_auth] [public_origin]"
            )
            sys.exit(1)
        origins_csv = sys.argv[2]
        additional = sys.argv[3] if len(sys.argv) >= 4 else ""
        disable = True
        if len(sys.argv) == 5:
            disable = sys.argv[4].strip().lower() == "true"
        public_origin = sys.argv[5] if len(sys.argv) == 6 else ""
        sys.exit(0 if set_control_ui_origins(origins_csv, additional, disable, public_origin) else 1)

    elif cmd == "set-control-ui-base-path":
        if len(sys.argv) != 3:
            print("Usage: oc_config_helper.py set-control-ui-base-path <base_path>  (empty string removes the key)")
            sys.exit(1)
        sys.exit(0 if set_control_ui_base_path(sys.argv[2]) else 1)

    elif cmd == "set-mdns-settings":
        if len(sys.argv) < 3:
            print("Usage: oc_config_helper.py set-mdns-settings <mode> [port] [hostname] [interface]")
            sys.exit(1)
        mode = sys.argv[2]
        sys.exit(0 if set_mdns_settings(mode) else 1)

    elif cmd == "apply-cron-settings":
        if len(sys.argv) != 3:
            print("Usage: oc_config_helper.py apply-cron-settings <skip_missed_jobs:true|false>")
            sys.exit(1)
        skip = sys.argv[2].strip().lower() == "true"
        sys.exit(0 if apply_cron_settings(skip) else 1)

    elif cmd == "apply-blocked-hostnames":
        if len(sys.argv) != 3:
            print("Usage: oc_config_helper.py apply-blocked-hostnames <csv>")
            sys.exit(1)
        sys.exit(0 if apply_blocked_hostnames(sys.argv[2]) else 1)

    elif cmd == "migrate-retired-heartbeat":
        if len(sys.argv) != 2:
            print("Usage: oc_config_helper.py migrate-retired-heartbeat")
            sys.exit(1)
        sys.exit(0 if migrate_retired_heartbeat_config() else 1)

    elif cmd == "cleanup-stale-leases":
        if len(sys.argv) != 2:
            print("Usage: oc_config_helper.py cleanup-stale-leases")
            sys.exit(1)
        sys.exit(0 if cleanup_stale_state_leases() else 1)

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

    elif cmd == "ensure-browser-config":
        sys.exit(0 if ensure_browser_config() else 1)

    elif cmd == "ensure-memory-core":
        sys.exit(0 if ensure_memory_core() else 1)

    elif cmd == "cleanup-stale-config":
        sys.exit(0 if cleanup_stale_config_keys() else 1)

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()