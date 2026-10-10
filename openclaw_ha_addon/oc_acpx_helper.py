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

import hashlib
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
# Bundled plugin payloads shipped in the add-on image (copied to
# CONFIG_DIR/plugins/<name> at start; never copied recursively from the
# running acpx project dir, which has live node_modules).
PLUGIN_SRC_DIR = WRAPPER_SRC_DIR.parent / "plugins"
PLUGIN_NAME = "acp-dashboard-binding"
# Target-owned directories that a copytree from the pristine source must
# never clobber (npm-managed or VCS-managed payload added at runtime).
PRUNED_PLUGIN_DIRS = {"node_modules", ".git", "__pycache__"}
CODEX_SOURCE_HOME = Path("/config/.codex")

# npm package versions (bump when the app image is rebuilt)
OPENCLAW_ACPX_VERSION = os.environ.get("OPENCLAW_ACPX_VERSION", "2026.7.1")
OPENCLAW_CODEX_VERSION = os.environ.get("OPENCLAW_CODEX_VERSION", "2026.7.1-1")
OPENCODE_VERSION = os.environ.get("OPENCODE_VERSION", "latest")
OPENCODE_PACKAGE = os.environ.get("OPENCODE_PACKAGE", "opencode-ai")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
# Harness model defaults. Generic app rule (GaRoN 2026-10-10): the add-on must
# work user-independent — these are only DEFAULTS; real overrides come from
# add-on options (run.sh forwards them as env: ollama_acp_*_model).
#   acp codex models  : OLLAMA_CODEX_MODEL  (add-on option: ollama_acp_codex_model)
#   acp opencode models: OLLAMA_OPENCODE_MODEL (add-on option: ollama_acp_opencode_model)
# gemma4 was only ever a budget-emergency placeholder; never ship it as default.
OLLAMA_CODEX_MODEL = os.environ.get("OLLAMA_CODEX_MODEL") or "kimi-k2.7-code:cloud"
OLLAMA_OPENCODE_MODEL = os.environ.get("OLLAMA_OPENCODE_MODEL") or "glm-5.3-flash:cloud"

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


def resolve_plugin_src_dir() -> Path | None:
    """Locate the bundled plugin payload directory (F1, Phase 2.10).

    The image COPYs /openclaw_ha_addon/plugins, but older images and bare
    repo checkouts may lack it — so the first candidate that actually
    contains PLUGIN_NAME/openclaw.plugin.json wins:

      1. /openclaw_ha_addon/plugins           (canonical image payload)
      2. <this helper's dir>/plugins          (repo checkout / dev runs)
      3. /share/projekte/github/.../plugins   (host-side checkout fallback)

    The chosen source is logged so a wrong/missing bundle is visible at
    start instead of failing silently in deploy_plugin().
    """
    candidates = [
        WRAPPER_SRC_DIR.parent / "plugins",
        Path(__file__).resolve().parent / "plugins",
        Path("/share/projekte/github/openclaw-ha-addon/openclaw_ha_addon/plugins"),
    ]
    for candidate in candidates:
        if (candidate / PLUGIN_NAME / "openclaw.plugin.json").is_file():
            if candidate != PLUGIN_SRC_DIR:
                log(f"INFO: plugin source fallback in use: {candidate}")
            return candidate
    log(
        "WARNING: plugin source not found; probed: "
        + ", ".join(str(c) for c in candidates)
    )
    return None


def plugin_source_manifest(src: Path) -> dict[str, str]:
    """sha256 manifest of the pristine plugin source (relative path -> hex)."""
    manifest: dict[str, str] = {}
    for path in sorted(src.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(src).as_posix()
        if any(part in PRUNED_PLUGIN_DIRS for part in path.relative_to(src).parts):
            continue
        manifest[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return manifest


def deploy_plugin() -> bool:
    """Idempotently deploy the bundled ACP dashboard binding plugin.

    Copies PLUGIN_SRC_DIR/<PLUGIN_NAME> (TS sources + openclaw.plugin.json
    manifest + package.json, NO node_modules — npm layout is plugin-local)
    into CONFIG_DIR/plugins/<PLUGIN_NAME> so the gateway can load it from
    its user-owned plugin root, and registers
    plugins.entries['<PLUGIN_NAME>'] = {enabled: true} in openclaw.json
    (agents and user plugin entries preserved — same patch pattern as
    patch_openclaw_config). An explicit operator opt-out enabled:false
    is respected and NEVER flipped back across boots.
    patch_openclaw_config). The copy fires only when the source actually
    differs from the target (sha256 comparison per file), so unchanged
    restarts stay read-only.

    Phase 2.15 (GaRoN): deploying/registering the plugin is OPT-IN — the
    add-on option acp_dashboard_binding_enabled (run.sh forwards it as env
    ACP_DASHBOARD_BINDING_ENABLED) defaults to OFF, so the default add-on
    boots WITHOUT the dashboard binding feature. When the option is absent
    or unset/false the deploy is skipped entirely and nothing is written to
    openclaw.json; when true, deploy + register + load.paths all run.
    """
    # Everything addon-config steerable, nothing hardcoded (GaRoN): the
    # option is checked here, BEFORE any payload or openclaw.json is touched.
    # Intentional skip is success for callers, not a failure.
    if os.environ.get("ACP_DASHBOARD_BINDING_ENABLED", "").strip().lower() not in \
            ("1", "true", "yes", "on"):
        log(f"INFO: plugin {PLUGIN_NAME} deploy disabled by option "
            "(acp_dashboard_binding_enabled=false)")
        return True

    src_dir = resolve_plugin_src_dir()
    src = (src_dir / PLUGIN_NAME) if src_dir else None
    dst = CONFIG_DIR / "plugins" / PLUGIN_NAME

    if src is None or not (src / "openclaw.plugin.json").exists():
        log("WARNING: deploy_plugin skipped — no bundled plugin source with a manifest")
        return False

    desired = plugin_source_manifest(src)

    needs_copy = False
    for rel, digest in desired.items():
        target = dst / rel
        try:
            current = hashlib.sha256(target.read_bytes()).hexdigest()
        except (OSError, FileNotFoundError):
            needs_copy = True
            break
        if current != digest:
            needs_copy = True
            break

    if not needs_copy:
        log(f"Plugin {PLUGIN_NAME} already up to date at {dst}")
    else:
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            src,
            dst,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(*PRUNED_PLUGIN_DIRS),
        )
        log(f"Deployed plugin {PLUGIN_NAME} -> {dst}")

    # Phase 2.10: drop orphaned payload left behind by older releases — a
    # source file removed/renamed in a new release never disappears on its
    # own, because the sha-compare above only inspects files the manifest
    # still knows. Only manifest-scope files are pruned; target-owned dirs
    # (node_modules etc., possibly npm-populated by the gateway) stay.
    removed = 0
    for path in sorted(dst.rglob("*")):
        if path.is_dir():
            continue
        rel_dir = path.relative_to(dst)
        if rel_dir.as_posix() in desired:
            continue
        if any(part in PRUNED_PLUGIN_DIRS for part in rel_dir.parts):
            continue
        try:
            path.unlink()
            removed += 1
        except OSError as e:
            log(f"WARN: could not prune orphaned plugin file {path}: {e}")
    if removed:
        log(f"Pruned {removed} orphaned file(s) from {dst}")

    # Register the plugin as enabled — but NEVER overwrite an explicit
    # operator opt-out: an entry carrying enabled:false stays false across
    # boots (single-plugin disable without touching ACP/harnesses).
    config_path = CONFIG_DIR / "openclaw.json"
    try:
        if not config_path.exists():
            log(f"INFO: {config_path} does not exist; skipping plugin registration")
            return True
        cfg = read_json(config_path)
        plugins = cfg.setdefault("plugins", {})
        entries = plugins.setdefault("entries", {})
        entry = entries.setdefault(PLUGIN_NAME, {})
        if not isinstance(entry, dict):
            log(f"WARN: plugins.entries.{PLUGIN_NAME} is not an object; leaving it untouched")
            return True
        changed_entry = False
        if entry.get("enabled") is False:
            # Operator opt-out (GaRoN 2026-10-10 finding): an explicit
            # enabled:false is NEVER flipped back by this helper. The plugin
            # payload stays deployed (copy above), so re-enabling needs no
            # rebuild; the early return leaves plugins.load.paths untouched
            # while the plugin is disabled.
            log(f"INFO: plugins.entries.{PLUGIN_NAME}.enabled=false (operator opt-out) respected")
            return True
        if entry.get("enabled") is not True:
            entry["enabled"] = True
            changed_entry = True
            log(f"Registered plugins.entries.{PLUGIN_NAME}.enabled=true in openclaw.json")

        # Phase 2.12 (proof 08:10): plugins.entries alone does not make the
        # gateway DISCOVER the plugin — external plugins load only from
        # paths listed in plugins.load.paths. Ensure the user-plugins root
        # (only the exact path this plugin deploys to; user paths preserved).
        load = plugins.setdefault("load", {})
        paths = load.setdefault("paths", [])
        plugins_root = str(CONFIG_DIR / "plugins")
        if not isinstance(paths, list):
            log(f"WARN: plugins.load.paths is not a list; not patching discovery path")
        elif plugins_root not in paths:
            paths.insert(0, plugins_root)
            changed_entry = True
            log(f"Added plugins.load.paths entry: {plugins_root}")

        if changed_entry:
            write_json(config_path, cfg)
        return True
    except Exception as e:
        log(f"ERROR: plugin registration failed: {e}")
        return False


def install_acpx_npm_project() -> bool:
    """Ensure a managed npm project exists with the required ACP packages.

    Returns True on success (or already-up-to-date), False on install failure.
    Callers (run.sh) treat False as "harnesses unavailable this boot"."""
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

    # Follow-up audit: package.json alone says nothing about node_modules —
    # a failed npm install wrote package.json first, so every later boot
    # took the "already up to date" path while node_modules stayed absent
    # (harnesses silently broken until a version pin changed). Check every
    # pinned dependency landed in node_modules ("@openclaw/acpx" ->
    # node_modules/@openclaw/acpx, "opencode-ai" -> node_modules/opencode-ai).
    if not need_install:
        for dep in desired_pkg["dependencies"]:
            if not (PROJECT_DIR / "node_modules" / Path(dep)).exists():
                log(f"node_modules incomplete ({dep} missing); reinstalling")
                need_install = True
                break

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
    # Generic app rule (GaRoN 2026-10-10): never overwrite a user-owned
    # allowedAgents list. We only union in the built-in harness names plus
    # user extras (add-on option acp_additional_allowed_agents, forwarded
    # by run.sh as ACP_ADDITIONAL_ALLOWED_AGENTS env; CSV).
    base_allowed = {"claude", "codex", "opencode", "openclaw"}
    extra_raw = os.environ.get("ACP_ADDITIONAL_ALLOWED_AGENTS", "")
    extra_allowed = {a.strip() for a in extra_raw.split(",") if a.strip()}
    missing = (base_allowed | extra_allowed) - allowed
    if missing:
        acp["allowedAgents"] = sorted(allowed | base_allowed | extra_allowed)
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
    ok = deploy_plugin()
    ok = install_acpx_npm_project() and ok
    ok = patch_openclaw_config() and ok
    if ok:
        log("ACPX initialization complete")
    else:
        log("ACPX initialization completed WITH FAILURES (harnesses may be unavailable this boot)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
