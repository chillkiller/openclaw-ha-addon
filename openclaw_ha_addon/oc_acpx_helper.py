#!/usr/bin/env python3
"""
OpenClaw HA Add-on — ACPX harness initializer.

This helper runs during add-on startup (called from run.sh) and ensures that
Claude Code, Codex and OpenCode ACP harnesses are ready to use:

  1. Copies wrapper launchers into /config/.openclaw/acpx/
  2. Creates a small managed npm project in /config/.openclaw/acpx/.node_project
     with @openclaw/acpx, @openclaw/codex and opencode installed
  3. Patches /config/.openclaw/openclaw.json to enable ACPX and define the
     coding-main (Forge) and coding-review (Audit) agents with their harnesses
  4. Makes wrapper files executable

All operations are idempotent and safe to run on every add-on restart.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

# Directories
CONFIG_DIR = Path("/config/.openclaw")
ACPX_DIR = CONFIG_DIR / "acpx"
WRAPPER_SRC_DIR = Path("/openclaw_ha_addon/acpx")
PROJECT_DIR = ACPX_DIR / ".node_project"

# npm package versions (bump when the add-on image is rebuilt)
OPENCLAW_ACPX_VERSION = os.environ.get("OPENCLAW_ACPX_VERSION", "2026.7.1")
OPENCLAW_CODEX_VERSION = os.environ.get("OPENCLAW_CODEX_VERSION", "2026.7.1-1")
OPENCODE_VERSION = os.environ.get("OPENCODE_VERSION", "latest")
OPENCODE_PACKAGE = os.environ.get("OPENCODE_PACKAGE", "opencode-ai")


def log(msg: str) -> None:
    print(f"[acpx-init] {msg}", flush=True)


def read_json(path: Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def make_executable(path: Path) -> None:
    if not path.exists():
        return
    mode = path.stat().st_mode
    if not (mode & stat.S_IXUSR):
        path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def copy_wrapper_files() -> None:
    """Copy wrapper launchers and home directories into persistent storage."""
    if not WRAPPER_SRC_DIR.exists():
        log(f"WARNING: wrapper source directory not found: {WRAPPER_SRC_DIR}")
        return

    ACPX_DIR.mkdir(parents=True, exist_ok=True)

    files_to_copy = [
        "claude-agent-acp-wrapper.mjs",
        "codex-acp-wrapper.mjs",
        "opencode-acp-wrapper.mjs",
    ]
    for name in files_to_copy:
        src = WRAPPER_SRC_DIR / name
        dst = ACPX_DIR / name
        if src.exists() and (not dst.exists() or src.read_bytes() != dst.read_bytes()):
            shutil.copy2(src, dst)
            log(f"Installed/updated wrapper: {name}")
        make_executable(dst)

    # Copy home directories (Codex / OpenCode config)
    for home_name in ("codex-home", "opencode-home"):
        src_home = WRAPPER_SRC_DIR / home_name
        dst_home = ACPX_DIR / home_name
        if src_home.exists():
            if dst_home.exists():
                # Merge: overwrite config.toml if source differs
                src_config = src_home / "config.toml"
                dst_config = dst_home / "config.toml"
                if src_config.exists():
                    dst_home.mkdir(parents=True, exist_ok=True)
                    if (
                        not dst_config.exists()
                        or src_config.read_bytes() != dst_config.read_bytes()
                    ):
                        shutil.copy2(src_config, dst_config)
                        log(f"Updated {home_name}/config.toml")
            else:
                shutil.copytree(src_home, dst_home)
                log(f"Installed {home_name}")


def install_acpx_npm_project() -> None:
    """Ensure a managed npm project exists with the required ACP packages."""
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)

    package_json = PROJECT_DIR / "package.json"
    desired_pkg = {
        "private": True,
        "name": "openclaw-acpx-managed",
        "version": "1.0.0",
        "dependencies": {
            "@openclaw/acpx": OPENCLAW_ACPX_VERSION,
            "@openclaw/codex": OPENCLAW_CODEX_VERSION,
        },
    }

    if OPENCODE_VERSION.lower() not in ("none", "false", ""):
        desired_pkg["dependencies"][OPENCODE_PACKAGE] = OPENCODE_VERSION

    need_install = False
    if not package_json.exists():
        need_install = True
    else:
        try:
            current = read_json(package_json)
            current_deps = current.get("dependencies", {})
            for dep, version in desired_pkg["dependencies"].items():
                if current_deps.get(dep) != version:
                    need_install = True
                    break
        except Exception:
            need_install = True

    if need_install:
        write_json(package_json, desired_pkg)
        log(f"Installing ACPX npm project in {PROJECT_DIR}")
        try:
            # Use npm install; hide most output unless it fails
            result = subprocess.run(
                ["npm", "install", "--no-save"],
                cwd=PROJECT_DIR,
                capture_output=True,
                text=True,
                timeout=600,
            )
            if result.returncode != 0:
                log(f"ERROR: npm install failed:\n{result.stderr}")
                # Do not abort; the wrappers can fall back to npx
            else:
                log("ACPX npm project installed successfully")
        except subprocess.TimeoutExpired:
            log("ERROR: npm install timed out after 10 minutes")
        except Exception as e:
            log(f"ERROR: npm install raised exception: {e}")
    else:
        log("ACPX npm project already up to date")


def find_installed_acp_binary(package_name: str, relative_path: str) -> str | None:
    """Find a binary inside the managed ACPX npm project."""
    candidate = PROJECT_DIR / "node_modules" / package_name / relative_path
    if candidate.exists():
        return str(candidate)
    return None


def patch_openclaw_config() -> None:
    """Ensure the top-level cp section exists with a sane backend.

    This function is intentionally minimal. We do NOT create or modify
    agents.list entries here. User-configured coding agents (with
    runtime.acp.agent / runtime.acp.backend) are preserved as-is.

    The only edits we make to openclaw.json are:
      - Bootstrap a minimal config if it is missing (first start only).
      - Set acp.enabled = true if it is missing/false.
      - Set acp.backend = 'acpx' if it is missing.
      - Ensure acp.allowedAgents contains the four required harness names.
    """
    config_path = CONFIG_DIR / "openclaw.json"

    if not config_path.exists():
        log(f"INFO: {config_path} does not exist yet; bootstrapping minimal config")
        cfg = {
            "gateway": {
                "mode": "local",
                "port": 18789,
                "bind": "loopback",
                "auth": {"mode": "token", "token": "PLACEHOLDER_ONBOARDING_TOKEN"},
            },
            "agents": {"defaults": {"workspace": "/config/clawd"}},
        }
        try:
            write_json(config_path, cfg)
            log("Bootstrapped minimal openclaw.json")
        except Exception as e:
            log(f"ERROR: failed to create {config_path}: {e}")
        return

    try:
        cfg = read_json(config_path)
    except Exception as e:
        log(f"ERROR: failed to read {config_path}: {e}")
        return

    changed = False

    # Only ensure the top-level acp block. Do not touch agents.list.
    acp = cfg.setdefault("acp", {})
    if not isinstance(acp, dict):
        log("WARN: openclaw.json has a non-object acp section; leaving it untouched")
        return

    if acp.get("enabled") is not True:
        acp["enabled"] = True
        changed = True

    if not acp.get("backend"):
        acp["backend"] = "acpx"
        changed = True

    allowed = set(acp.get("allowedAgents", []) or [])
    required_allowed = {"claude", "codex", "opencode", "openclaw"}
    missing = required_allowed - allowed
    if missing:
        acp["allowedAgents"] = sorted(allowed | required_allowed)
        changed = True

    if changed:
        try:
            write_json(config_path, cfg)
            log("Updated top-level acp section in openclaw.json (agents preserved)")
        except Exception as e:
            log(f"ERROR: failed to write {config_path}: {e}")
    else:
        log("NOTE: openclaw.json already has acp configuration; agents preserved")

def main() -> int:
    log("Initializing ACPX harnesses (Claude Code, Codex, OpenCode)")
    copy_wrapper_files()
    install_acpx_npm_project()
    patch_openclaw_config()
    log("ACPX initialization complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
