#!/usr/bin/env python3
"""
OpenClaw HA App — ACPX harness initializer.

This helper runs during app startup (called from run.sh) and ensures that
the local-model ACP harnesses are ready to use:

  1. Deploys codex auth.json + /config/.codex/config.toml (the acpx
     inheritance source for provider routing, verified 2026-10-09)
  2. Creates a small managed npm project in /config/.openclaw/acpx/.node_project
     with @openclaw/acpx, @openclaw/codex and opencode installed
  3. Patches /config/.openclaw/openclaw.json to enable ACPX (agents preserved)

Custom wrapper launchers are NO longer used (2026-10-09): the acpx plugin
generates passthrough wrappers for codex/claude at gateway start, and the
provider env is exported by run.sh (ambient env). All harnesses reach the
local Ollama backend via config files (codex config.toml inheritance,
opencode.jsonc) or ambient env (claude ANTHROPIC_*), no wrapper edits.

All operations are idempotent and safe to run on every app restart.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# Directories
CONFIG_DIR = Path("/config/.openclaw")
ACPX_DIR = CONFIG_DIR / "acpx"
WRAPPER_SRC_DIR = Path("/openclaw_ha_addon/acpx")
PROJECT_DIR = ACPX_DIR / ".node_project"
OPENCODE_GLOBAL_DIR = Path("/config/opencode")
CODEX_SOURCE_HOME = Path("/config/.codex")

# npm package versions (bump when the app image is rebuilt)
OPENCLAW_ACPX_VERSION = os.environ.get("OPENCLAW_ACPX_VERSION", "2026.7.1")
OPENCLAW_CODEX_VERSION = os.environ.get("OPENCLAW_CODEX_VERSION", "2026.7.1-1")
OPENCODE_VERSION = os.environ.get("OPENCODE_VERSION", "latest")
OPENCODE_PACKAGE = os.environ.get("OPENCODE_PACKAGE", "opencode-ai")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
# Role-differentiated harness models (verified 2026-10-09, GaRoN decision):
#   codex = coding-review (Audit)  -> kimi-k2.7-code:cloud
#   opencode = coding-main (Forge) -> glm-5.3:cloud
# gemma4 was only ever a placeholder; never use it for audits.
OLLAMA_CODEX_MODEL = os.environ.get("OLLAMA_CODEX_MODEL", "kimi-k2.7-code:cloud")
OLLAMA_OPENCODE_MODEL = os.environ.get("OLLAMA_OPENCODE_MODEL", "glm-5.3-flash:cloud")

# Template tokens that must never be committed as real infra data (AGENTS.md
# security hygiene: LAN addresses stay out of the repository).
TEMPLATE_SUBSTITUTIONS = {
    "__OLLAMA_BASE_URL__": OLLAMA_BASE_URL.rstrip("/"),
    "__CODEX_MODEL__": OLLAMA_CODEX_MODEL,
    "__OPENCODE_MODEL__": OLLAMA_OPENCODE_MODEL,
}


def render_template(text: str) -> str:
    for token, value in TEMPLATE_SUBSTITUTIONS.items():
        text = text.replace(token, value)
    return text


def log(msg: str) -> None:
    print(f"[acpx-init] {msg}", flush=True)


def read_json(path: Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: dict[str, Any]) -> None:
    """Atomic write (temp + rename): a crash mid-write must never leave a
    truncated JSON behind — for openclaw.json that used to lead to a
    corrupt-config stub-overwrite cycle on the next start.

    A failure during dump leaves no orphaned .tmp file behind (cleaned up in
    the except branch). This is intentionally local to this helper: it is the
    only writer of the auxiliary files (package.json, opencode.jsonc,
    auth.json), so no shared abstraction is needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def deploy_harness_configs() -> None:
    """Deploy the harness config templates from the source directory.

    - codex-home/auth.json into ACPX_DIR (the acpx generated wrapper's
      CODEX_HOME; without it codex fails with "Authentication required",
      verified 2026-10-09)
    - /config/.codex/config.toml: the acpx inheritance source, from which
      the plugin regenerates the operational codex-home/config.toml at
      every gateway start (verified 2026-10-09: only model, model_provider,
      model_reasoning_effort, sandbox_mode and [model_providers.*] plus
      trust entries are inherited; regenerates once per gateway start).
    """
    if not WRAPPER_SRC_DIR.exists():
        log(f"WARNING: harness config source directory not found: {WRAPPER_SRC_DIR}")
        return

    # codex auth.json (wrapper CODEX_HOME, read at every adapter start)
    codex_home = ACPX_DIR / "codex-home"
    codex_home.mkdir(parents=True, exist_ok=True)
    auth_path = codex_home / "auth.json"
    if not auth_path.exists():
        write_json(
            auth_path,
            {"OPENAI_API_KEY": "ollama", "tokens": None, "last_refresh": None},
        )
        try:
            os.chmod(auth_path, 0o600)
        except OSError as e:
            log(f"WARN: could not chmod auth.json: {e}")
        log("Created codex auth.json (placeholder API key)")

    # Codex inheritance source for the acpx plugin (gateway-start regeneration)
    src_codex_source = WRAPPER_SRC_DIR / ".codex-source" / "config.toml"
    if src_codex_source.exists():
        CODEX_SOURCE_HOME.mkdir(parents=True, exist_ok=True)
        desired = render_template(src_codex_source.read_text(encoding="utf-8"))
        target = CODEX_SOURCE_HOME / "config.toml"
        if not target.exists():
            target.write_text(desired, encoding="utf-8")
            log("Installed /config/.codex/config.toml (acpx inheritance source)")
        else:
            current = target.read_text(encoding="utf-8")
            if "[model_providers." not in current:
                target.write_text(desired, encoding="utf-8")
                log("Upgraded /config/.codex/config.toml (provider routing)")
            elif current != desired:
                log("NOTE: /config/.codex/config.toml is customized; leaving intact")
    else:
        log(f"WARNING: {src_codex_source} not found; codex provider inheritance not applied")

    # OpenCode JSON(C) provider config (ACPX_DIR home + global dir)
    prepare_opencode_home()


def prepare_opencode_home() -> None:
    """Ensure OpenCode finds its JSON(C) provider config.

    OpenCode reads config files as JSON(C) even when the filename ends in
    .toml (verified 2026-10-09: "config.toml is not valid JSON(C)"). The
    real config therefore lives in opencode.jsonc, deployed into
    OPENCODE_HOME and the global /config/opencode directory.
    """
    src_config = WRAPPER_SRC_DIR / "opencode.jsonc"
    if not src_config.exists():
        log(f"WARNING: {src_config} not found; opencode provider config not applied")
        return

    desired = render_template(src_config.read_text(encoding="utf-8"))

    for target_dir in (ACPX_DIR / "opencode-home", OPENCODE_GLOBAL_DIR):
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "opencode.jsonc"
        if not target.exists() or target.read_text(encoding="utf-8") != desired:
            target.write_text(desired, encoding="utf-8")
            log(f"Updated {target} (Ollama provider config)")

    # Neutralize the legacy TOML placeholder (comment-only file).
    legacy = ACPX_DIR / "opencode-home" / "config.toml"
    legacy_src = WRAPPER_SRC_DIR / "opencode-home" / "config.toml"
    if legacy_src.exists() and (
        not legacy.exists() or legacy.read_bytes() != legacy_src.read_bytes()
    ):
        shutil.copy2(legacy_src, legacy)
        log("Replaced legacy opencode config.toml placeholder")


def install_acpx_npm_project() -> bool:
    """Ensure a managed npm project exists with the required ACP packages.

    Returns True on success (or already-up-to-date), False on install failure.
    Callers (run.sh) treat False as "harnesses unavailable this boot"."""
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
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
                # Do not raise; run.sh surfaces the failure via the exit code
                return False
            log("ACPX npm project installed successfully")
            return True
        except subprocess.TimeoutExpired:
            log("ERROR: npm install timed out after 10 minutes")
            return False
        except Exception as e:
            log(f"ERROR: npm install raised exception: {e}")
            return False
    else:
        log("ACPX npm project already up to date")
        return True


def patch_openclaw_config() -> bool:
    """Ensure the top-level acp section exists with a sane backend.

    This function is intentionally minimal. We do NOT create or modify
    agents.list entries here. User-configured coding agents (with
    runtime.acp.agent / runtime.acp.backend) are preserved as-is.

    The config itself is NOT created here — run.sh is the single bootstrap
    owner (first start only, random per-install token, per-mode port).
    The only edits we make to openclaw.json are:
      - Set acp.enabled = true if it is missing/false.
      - Set acp.backend = 'acpx' if it is missing.
      - Ensure acp.allowedAgents contains the four required harness names.
    """
    config_path = CONFIG_DIR / "openclaw.json"

    if not config_path.exists():
        # run.sh bootstraps a missing openclaw.json before this helper runs
        # (single bootstrap owner, random per-install token, per-mode port).
        # No duplicate bootstrap here: two divergent implementations drift and
        # can reintroduce the first-boot port/token bugs.
        log(f"INFO: {config_path} does not exist; skipping openclaw.json patch")
        return False

    try:
        cfg = read_json(config_path)
    except Exception as e:
        log(f"ERROR: failed to read {config_path}: {e} — NOT patching a config that cannot be parsed")
        return False

    changed = False

    # Only ensure the top-level acp block. Do not touch agents.list.
    acp = cfg.setdefault("acp", {})
    if not isinstance(acp, dict):
        log("WARN: openclaw.json has a non-object acp section; leaving it untouched")
        return False

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
            return False
        return True
    else:
        log("NOTE: openclaw.json already has acp configuration; agents preserved")
        return True

def main() -> int:
    log("Initializing local-model ACP harnesses (Codex, Claude, OpenCode)")
    deploy_harness_configs()
    ok = install_acpx_npm_project()
    ok = patch_openclaw_config() and ok
    if ok:
        log("ACPX initialization complete")
    else:
        log("ACPX initialization completed WITH FAILURES (harnesses may be unavailable this boot)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
