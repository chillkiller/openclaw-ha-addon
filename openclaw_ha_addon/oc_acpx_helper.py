#!/usr/bin/env python3
"""
OpenClaw HA App — ACPX harness initializer.

This helper runs during app startup (called from run.sh) and ensures that
the local-model ACP harnesses are ready to use:

  1. (RETIRED, Phase 3 / v0.7.13.16) Harness config generation (codex
     auth.json + /config/.codex/config.toml inheritance source, opencode
     jsonc) moved into the harness-config-writer feature plugin (Repo-Split
     A2, 2026-10-11: previously plugins.entries['acp-dashboard-binding']
     .config.harnesses, BRIDGE.md §15); deploy_harness_configs/
     prepare_opencode_home are no-ops now.
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
import base64
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
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
# Repo-Split A2 (2026-10-11): the harness-config-writer lives as its OWN
# plugin (GaRoN's split idea: config-writer independent of the channel
# plugin). Both are deployed/registered by this helper from the image-baked
# PLUGIN_SRC_DIR (kept in-sync with openclaw_ha_addon/plugins/).
HARNESS_CONFIG_WRITER_PLUGIN_NAME = "harness-config-writer"
BUNDLED_PLUGIN_NAMES = [PLUGIN_NAME, HARNESS_CONFIG_WRITER_PLUGIN_NAME]
# Bundled-Root-Trust-Deploy (Kammerjäger 2026-10-11, Restart-Log v0.7.13.17):
# the gateway grants the trusted plugin runtime API (api.runtime.state.
# openKeyedStore etc.) ONLY to plugins whose record is origin "bundled"
# (physical root under the pinned gateway package's dist/extensions) or an
# official-catalog install (trustedOfficialInstall — unreachable for path
# plugins). Deployed at /config/.openclaw/plugins the plugins load with
# origin "config" and every openKeyedStore call throws PluginTrustRefusal →
# the dashboard bridge ran "persisted bridge state unavailable; memory-only
# rows" at every boot. This helper therefore deploys a COMPILED bundle into
# the gateway's bundled extensions root: bundled plugins load with full
# trust, and the TS-stripping cost (heavy part of the 64s runtime-post-bind
# boot block) disappears because the bundle arrives pre-compiled.
BUNDLED_EXTENSIONS_DIR = Path("/usr/lib/node_modules/openclaw/dist/extensions")
# esbuild bundles the TS entry into ONE ESM module (relative imports inlined;
# "openclaw/plugin-sdk/*" stays a bare specifier resolved by the gateway's
# plugin loader alias, same mechanism that serves the config-origin TS load).
# The openclaw package ships its own esbuild — same lifecycle as the gateway.
ESBUILD_BIN_CANDIDATES = (
    "/usr/lib/node_modules/openclaw/node_modules/.bin/esbuild",
    "/usr/lib/node_modules/esbuild/bin/esbuild",
)
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
# γ (2026-10-13): the third flagship harness default — claude never had a
# config.yaml option (historically ambient OLLAMA_ACP_MODEL via run.sh:125ff).
# Mirror ladder lives in run.sh's ANTHROPIC_MODEL fallback (sync rule).
OLLAMA_CLAUDE_MODEL_DEFAULT = "glm-5.3-flash:cloud"

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
    """Retired (Phase 3 / v0.7.13.16, Repo-Split A2 2026-10-11): harness
    config generation moved into the standalone harness-config-writer
    feature plugin (src/harness-config-writer.ts, fed by
    plugins.entries['harness-config-writer'].config.harnesses). Kept as an
    idempotent no-op for the stable main()/run.sh call surface.
    """
    log("INFO: harness config deployment moved to harness-config-writer plugin")


def prepare_opencode_home() -> None:
    """Retired (Phase 3 / v0.7.13.16, Repo-Split A2 2026-10-11): opencode
    provider config generation moved into the standalone harness-config-writer
    plugin (both deploy dirs + legacy config.toml neutralization, same
    semantics). Kept as an idempotent no-op for callers/tests of the stable
    surface.
    """
    log("INFO: harness config deployment moved to harness-config-writer plugin")


def resolve_plugin_src_dir() -> Path | None:
    """Locate the bundled plugin payload directory (F1, Phase 2.10).

    The image COPYs /openclaw_ha_addon/plugins, but older images and bare
    repo checkouts may lack it — so the first candidate that actually
    contains PLUGIN_NAME/openclaw.plugin.json wins:

      1. PLUGIN_SRC_DIR (canonical image payload; mocked in tests)
      2. <this helper's dir>/plugins          (repo checkout / dev runs)
      3. /share/projekte/github/.../plugins   (host-side checkout fallback)

    The chosen source is logged so a wrong/missing bundle is visible at
    start instead of failing silently in deploy_plugins().
    """
    candidates = [
        PLUGIN_SRC_DIR,
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


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _find_esbuild() -> str | None:
    """Locate an esbuild binary — pinned to the gateway package's own copy
    first (same lifecycle as the pinned OpenClaw), then PATH."""
    for candidate in ESBUILD_BIN_CANDIDATES:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return shutil.which("esbuild")


def _compile_bundled_plugin(src_dir: Path, esbuild_bin: str) -> bytes | None:
    """Bundle the plugin entry (index.ts) into ONE self-contained ESM module.

    Relative imports are inlined ("./src/x.js" resolves to the TS sources);
    `openclaw` and `@openclaw/*` stay bare specifiers — the gateway plugin
    loader's alias serves them at runtime exactly as for the config-origin
    TS load. Returns the bundle bytes, or None on any failure (fail-soft:
    the caller falls back to the legacy external deploy).
    """
    entry = src_dir / "index.ts"
    if not entry.is_file():
        log(f"WARN: bundled deploy without entry file {entry}")
        return None
    with tempfile.TemporaryDirectory(prefix="oc-plugin-bundle-") as tmp:
        outfile = Path(tmp) / "index.mjs"
        cmd = [
            esbuild_bin,
            str(entry),
            "--bundle", "--format=esm", "--platform=node", "--target=node26",
            "--external:openclaw", "--external:openclaw/*", "--external:@openclaw/*",
            f"--outfile={outfile}",
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.SubprocessError) as e:
            log(f"WARN: esbuild invocation failed: {e}")
            return None
        if proc.returncode != 0:
            log(f"WARN: esbuild bundle failed for {src_dir.name} "
                f"(rc={proc.returncode}): {proc.stderr.strip()[:400]}")
            return None
        if not outfile.is_file():
            log(f"WARN: esbuild produced no output for {src_dir.name}")
            return None
        return outfile.read_bytes()


def _write_bytes_and_cache(path: Path, data: bytes, written: list[str]) -> None:
    """Write bytes atomically (tmp+rename 0o644); appends to `written` only
    when the target actually changed (byte-compare first, read-only boots)."""
    try:
        if path.read_bytes() == data:
            return
    except (OSError, FileNotFoundError):
        pass
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, path)  # type: ignore[typed-may-differ]
    written.append(str(path))


def _deploy_and_register_plugin(plugin_name: str, force_enable: bool = False) -> bool:
    """Idempotently deploy ONE bundled plugin, named <plugin_name>.

    Bundled-Root-Trust-Deploy (Kammerjäger 2026-10-11): when the pinned
    gateway's bundled extensions root is present, the plugin is deployed
    there as a PRE-COMPILED esbuild bundle (index.mjs + package.json with
    openclaw.extensions=./index.mjs + manifest) — the gateway marks it
    origin "bundled" and grants the trusted runtime API (openKeyedStore,
    previously PluginTrustRefusal → memory-only bridge rows). The stale
    external deploy under CONFIG_DIR/plugins/<name> (memory-only world,
    shadow-candidate next to the bundled one) is removed in the same boot.
    If esbuild is unavailable or the compile fails, the flow falls back
    fail-soft to the legacy external deploy below (functional, untrusted).

    Legacy path: copies PLUGIN_SRC_DIR/<plugin_name> (TS sources +
    openclaw.plugin.json manifest + package.json, NO node_modules — npm
    layout is plugin-local) into CONFIG_DIR/plugins/<plugin_name> so the
    gateway can load it from its user-owned plugin root, and registers
    plugins.entries['<plugin_name>'] = {enabled: true} in openclaw.json
    (agents and user plugin entries preserved — same patch pattern as
    patch_openclaw_config). An explicit operator opt-out enabled:false
    is respected and NEVER flipped back across boots.
    The copy fires only when the source actually differs from the target
    (sha256 comparison per file), so unchanged restarts stay read-only.

    Repo-Split A2 (2026-10-11): called once per bundled plugin —
    'acp-dashboard-binding' (channel) and 'harness-config-writer' (standalone
    feature plugin); option gating lives in deploy_plugins().

    Phase 2.15 (GaRoN, origin semantics kept): deploying/registering is
    OPT-IN per plugin via the add-on options forwarded by run.sh as env;
    when the option is absent or unset/false the deploy is skipped entirely
    and nothing is written to openclaw.json.
    """
    src_dir = resolve_plugin_src_dir()
    src = (src_dir / plugin_name) if src_dir else None

    if src is None or not (src / "openclaw.plugin.json").exists():
        log("WARNING: deploy_plugins skipped — no bundled plugin source with a manifest "
            f"(probed {plugin_name} under {src_dir})")
        return False

    external_dst = CONFIG_DIR / "plugins" / plugin_name
    if BUNDLED_EXTENSIONS_DIR.is_dir():
        esbuild_bin = _find_esbuild()
        bundle_bytes = _compile_bundled_plugin(src, esbuild_bin) if esbuild_bin else None
        if bundle_bytes is not None:
            dst = BUNDLED_EXTENSIONS_DIR / plugin_name
            dst.mkdir(parents=True, exist_ok=True)
            written: list[str] = []
            _write_bytes_and_cache(dst / "index.mjs", bundle_bytes, written)
            package_json = json.loads((src / "package.json").read_text())
            oc_meta = package_json.setdefault("openclaw", {})
            oc_meta["extensions"] = ["./index.mjs"]
            _write_bytes_and_cache(dst / "package.json",
                                   json.dumps(package_json, indent=2).encode() + b"\n",
                                   written)
            for copy_name in ("openclaw.plugin.json", "BRIDGE.md", "README.md"):
                copy_src = src / copy_name
                if copy_src.is_file():
                    _write_bytes_and_cache(dst / copy_name, copy_src.read_bytes(), written)
            if external_dst.exists():
                shutil.rmtree(external_dst)
                log(f"Removed stale external plugin deploy {external_dst} "
                    "(superseded by bundled-root deploy)")
            if written:
                log(f"Deployed plugin {plugin_name} -> {dst} "
                    f"(bundled root = trusted runtime API; esbuild {esbuild_bin})")
                for path in written:
                    log(f"  wrote {path}")
            else:
                log(f"Plugin {plugin_name} already up to date at {dst} "
                    "(bundled root, byte-identical — read-only boot)")
            return _register_plugin_entry(plugin_name, force_enable=force_enable)
        log(f"WARN: bundled deploy unavailable for {plugin_name} "
            "(esbuild missing or bundle failed) — falling back to external deploy")

    dst = external_dst
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
        log(f"Plugin {plugin_name} already up to date at {dst}")
    else:
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            src,
            dst,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(*PRUNED_PLUGIN_DIRS),
        )
        log(f"Deployed plugin {plugin_name} -> {dst}")

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
    return _register_plugin_entry(plugin_name, force_enable=force_enable)


def _register_plugin_entry(plugin_name: str, force_enable: bool = False) -> bool:
    """openclaw.json registration shared by both deploy roots.

    entries.enabled: operator opt-out (false) never flipped; load.paths
    (external-root discovery, Phase 2.12) + plugins.allow (Phase 2.19) are
    unioned idempotently. The load.paths entry is KEPT even after a
    bundled-root deploy — harmless while CONFIG_DIR/plugins carries no
    payload, and it keeps the legacy fallback functional.
    """
    config_path = CONFIG_DIR / "openclaw.json"
    try:
        if not config_path.exists():
            log(f"INFO: {config_path} does not exist; skipping plugin registration")
            return True
        cfg = read_json(config_path)
        plugins = cfg.setdefault("plugins", {})
        entries = plugins.setdefault("entries", {})
        entry = entries.setdefault(plugin_name, {})
        if not isinstance(entry, dict):
            log(f"WARN: plugins.entries.{plugin_name} is not an object; leaving it untouched")
            return True
        changed_entry = False
        if entry.get("enabled") is False:
            if force_enable:
                # GaRoN 2026-10-12 (binding plugin ONLY): the HA option is the
                # master switch — a silently respected enabled:false while the
                # option shows ON is the UI-lying failure class of the outage
                # session. The operator toggling the option ON is the newer,
                # explicit intent channel.
                entry["enabled"] = True
                changed_entry = True
                log(f"plugins.entries.{plugin_name}.enabled set true "
                    "(HA option master switch = ON; never-flip superseded for this plugin)")
            else:
                # Operator opt-out (GaRoN 2026-10-10 finding): an explicit
                # enabled:false is NEVER flipped back by this helper. The plugin
                # payload stays deployed (copy above), so re-enabling needs no
                # rebuild; the early return leaves plugins.load.paths untouched
                # while the plugin is disabled.
                log(f"INFO: plugins.entries.{plugin_name}.enabled=false (operator opt-out) respected")
                return True
        if entry.get("enabled") is not True:
            entry["enabled"] = True
            changed_entry = True
            log(f"Registered plugins.entries.{plugin_name}.enabled=true in openclaw.json")

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

        # Phase 2.19 (proof 08:26 live): plugins.allow is the 4th discovery
        # gate — an allowlist present but missing the plugin id yields
        # "plugin disabled (not in allowlist)" and the config-validation
        # runs against a schema-less stub. Union the id (user removals of
        # OTHER ids preserved; operator can still disable via entries).
        allow_list = plugins.setdefault("allow", [])
        if not isinstance(allow_list, list):
            log(f"WARN: plugins.allow is not a list; not patching allowlist")
        elif plugin_name not in allow_list:
            allow_list.append(plugin_name)
            changed_entry = True
            log(f"Added plugins.allow entry: {plugin_name}")

        if changed_entry:
            write_json(config_path, cfg)
        return True
    except Exception as e:
        log(f"ERROR: plugin registration failed: {e}")
        return False


def migrate_legacy_harnesses_config() -> None:
    """Repo-Split A2 (2026-10-11) one-time config key migration.

    The generalized harness config surface moved from
    plugins.entries['acp-dashboard-binding'].config.harnesses (pre-split,
    Phase 3 in the channel plugin) to
    plugins.entries['harness-config-writer'].config.harnesses.

    Semantics (idempotent, fail-soft):
      - legacy key present, new key absent -> copy + remove the legacy key;
        the writer entry gets enabled:true if it doesn't exist yet.
      - both keys present -> leave BOTH untouched + WARN (operator must
        decide; we never guess which is authoritative).
      - nothing present -> no-op.
      - a PRE-EXISTING writer entry keeps its enabled flag untouched: true /
        unset both deploy-legal (the deploy block decides nothing here), an
        explicit enabled:false operator opt-out is NEVER flipped (audit B3,
        GaRoN invariant 2026-10-10) — the config transport happens regardless,
        since the legacy key would break the binding manifest schema.
    A stored 'harnesses' object under the OLD entry would fail the binding
    plugin manifest schema validation (additionalProperties:false, the
    property no longer exists) once the rebuilt plugin is deployed — hence
    the removal (this helper runs BEFORE the gateway reads the config)."""
    config_path = CONFIG_DIR / "openclaw.json"
    if not config_path.exists():
        return
    try:
        cfg = read_json(config_path)
        entries = cfg.get("plugins", {}).get("entries", {})
        if not isinstance(entries, dict):
            return
        legacy_entry = entries.get(PLUGIN_NAME) or {}
        legacy_cfg = legacy_entry.get("config") if isinstance(legacy_entry, dict) else None
        legacy_harnesses = (
            legacy_cfg.get("harnesses") if isinstance(legacy_cfg, dict) else None
        )
        if not isinstance(legacy_harnesses, dict) or not legacy_harnesses:
            return
        # Audit B3 (2026-10-11): a pre-existing writer entry is the OPERATOR'S
        # surface — the migration is a config-CONTENT transport, never an
        # enable decision. enabled is set only for a FRESH entry; an explicit
        # operator opt-out (enabled:false) is NEVER flipped back (GaRoN
        # finding 2026-10-10 invariant).
        writer_pre_existed = HARNESS_CONFIG_WRITER_PLUGIN_NAME in entries
        writer_entry = entries.setdefault(HARNESS_CONFIG_WRITER_PLUGIN_NAME, {})
        if not isinstance(writer_entry, dict):
            log(f"WARN: plugins.entries.{HARNESS_CONFIG_WRITER_PLUGIN_NAME} is not an "
                "object; legacy harnesses config NOT migrated")
            return
        writer_cfg = writer_entry.setdefault("config", {})
        if isinstance(writer_cfg.get("harnesses"), dict) and writer_cfg["harnesses"]:
            log(
                "WARN: plugins.entries['harness-config-writer'].config.harnesses "
                "exists alongside the legacy 'acp-dashboard-binding' key — leaving "
                "BOTH untouched (operator decision required). Consequence: the "
                "legacy key violates the binding manifest schema "
                "(additionalProperties:false) and can fail that plugin's load — "
                "after verifying the new surface, delete the legacy key in "
                "openclaw.json (or move its content) manually."
            )
            return
        writer_cfg["harnesses"] = legacy_harnesses
        writer_enabled_now = writer_entry.get("enabled")
        if writer_enabled_now is False:
            log(
                "INFO: legacy harnesses config transported into "
                f"plugins.entries['{HARNESS_CONFIG_WRITER_PLUGIN_NAME}'].config; "
                "enabled=false (operator opt-out) respected — NOT flipped"
            )
        elif not writer_pre_existed:
            writer_entry["enabled"] = True
        legacy_cfg.pop("harnesses", None)
        write_json(config_path, cfg)
        log(
            "INFO: migrated plugins.entries['acp-dashboard-binding'].config.harnesses "
            f"-> plugins.entries['{HARNESS_CONFIG_WRITER_PLUGIN_NAME}'].config.harnesses"
        )
    except Exception as e:
        log(f"WARN: legacy harnesses config migration failed: {e}")


# Backup-Rewrite (GaRoN 2026-10-11): the writer plugin writes into
# operator-adjacent surfaces (/config/.codex, /config/opencode, acpx
# codex-home + opencode-home + harness-env). To make enable/disable fully
# reversible, this helper snapshots the pre-writer state ONCE at first
# enable — it runs BEFORE the gateway reads any config, so a snapshot can
# never capture writer-generated content — and restores it when the writer
# gate goes off. After a restore the snapshot is deleted, so a re-enable
# takes a fresh snapshot of the restored (or operator-changed) state.
HARNESS_WRITER_BACKUP_DIR_NAME = "harness-config-writer-backup"


def _harness_writer_backup_dir() -> Path:
    # Derived per call from CONFIG_DIR (tests patch only CONFIG_DIR).
    return CONFIG_DIR / HARNESS_WRITER_BACKUP_DIR_NAME
# Canonical writer env-file ids. TS sync rule (same convention as the
# resolveOpenClawStateDir copies): keep this list in sync with the
# ENV_MECHANISM keys in
# openclaw_ha_addon/plugins/harness-config-writer/src/harness-config-writer.ts.
# Extra *.env files in harness-env/ are additionally backed up when they
# already exist, but only canonical ids are ever DELETED on restore.
HARNESS_WRITER_ENV_IDS = ("claude", "droid", "gemini", "iflow", "kimi", "kiro", "qwen")
HARNESS_WRITER_BACKUP_VERSION = 1


def harness_writer_managed_files() -> list[Path]:
    """The writer plugin's complete write surface (canonical/managed set).

    Mirrors harness-config-writer.ts deploy targets:
      - codex:    <acpx>/codex-home/auth.json + <.codex>/config.toml
                  + <.codex>/model-catalog.json (γ.1 metadata catalog)
      - opencode: <acpx>/opencode-home/opencode.jsonc, <opencode>/opencode.jsonc
                  + legacy <acpx>/opencode-home/config.toml neutralization
      - env:      <acpx>/harness-env/<id>.env for canonical ENV-MECHANISM ids
    """
    files = [
        ACPX_DIR / "codex-home" / "auth.json",
        CODEX_SOURCE_HOME / "config.toml",
        CODEX_SOURCE_HOME / "model-catalog.json",
        ACPX_DIR / "opencode-home" / "opencode.jsonc",
        OPENCODE_GLOBAL_DIR / "opencode.jsonc",
        ACPX_DIR / "opencode-home" / "config.toml",
    ]
    files.extend(
        ACPX_DIR / "harness-env" / f"{harness_id}.env"
        for harness_id in HARNESS_WRITER_ENV_IDS
    )
    return files


def _backup_write_manifest(entries: list[dict[str, Any]]) -> None:
    """Atomic manifest write (temp + rename, helper write_json semantics for
    raw dicts — no orphaned .tmp on failure).

    Audit H4: the manifest holds base64 copies of secret-bearing files
    (auth.json, *.env with API keys/tokens) → 0600 manifest, 0700 dir
    (idempotent: existing dirs are tightened, never loosened)."""
    backup_dir = _harness_writer_backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(backup_dir, 0o700)
    manifest = backup_dir / "manifest.json"
    tmp_path = manifest.with_suffix(".json.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "version": HARNESS_WRITER_BACKUP_VERSION,
                    "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "files": entries,
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
            f.write("\n")
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, manifest)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def backup_harness_writer_targets_once() -> bool:
    """Snapshot the pre-writer state of the writer's write surface — exactly
    ONCE (GaRoN: 'beim ersten enabled'). Idempotent: as long as the manifest
    exists on disk nothing is re-snapshotted, so writer-generated state can
    never leak into the backup. Returns True when a snapshot is (already) in
    place; fail-soft False on an unexpected I/O error."""
    backup_dir = _harness_writer_backup_dir()
    manifest = backup_dir / "manifest.json"
    if manifest.is_file():
        log("INFO: harness-config-writer backup already present (first-enable "
            "snapshot is kept until the writer option is turned off)")
        return True
    # Audit-Hinweis (Re-Audit 2026-10-11): after a quarantine the manifest is
    # gone — a naive re-snapshot here would capture writer-generated state
    # (empirically proven by the auditor). Consistent with the quarantine
    # design intent: the operator resolves the .corrupt payload first.
    corrupt_marker = backup_dir / "manifest.json.corrupt"
    if corrupt_marker.exists():
        log("WARN: harness-config-writer snapshot quarantined earlier "
            "(manifest.json.corrupt present) — refusing to take a new snapshot "
            "until the operator resolves it (writer-generated state would leak "
            "into the first-enable backup)")
        return False
    entries: list[dict[str, Any]] = []
    try:
        managed = harness_writer_managed_files()
        env_dir = ACPX_DIR / "harness-env"
        extra_env = []
        if env_dir.is_dir():
            extra_env = sorted(
                p for p in env_dir.glob("*.env") if p not in managed
            )
        for path in [*managed, *extra_env]:
            entry: dict[str, Any] = {"path": str(path)}
            if path.is_file():
                entry["existed"] = True
                entry["mode"] = stat.S_IMODE(path.stat().st_mode)
                entry["content"] = base64.b64encode(path.read_bytes()).decode("ascii")
            else:
                entry["existed"] = False
            entries.append(entry)
        _backup_write_manifest(entries)
    except Exception as e:
        log(f"WARN: harness-config-writer backup failed (no snapshot in place, "
            f"next boot retries): {e}")
        return False
    n_existing = sum(1 for e in entries if e["existed"])
    log(f"INFO: harness-config-writer first-enable snapshot taken "
        f"({n_existing} existing, {len(entries) - n_existing} absent target files) "
        f"-> {_harness_writer_backup_dir()}")
    return True


def restore_harness_writer_targets() -> bool:
    """Restore the first-enable snapshot (writer option OFF → original
    configs come back: existing files get their pre-enable bytes + mode,
    writer-only files are deleted). Consumes the snapshot (manifest removed,
    empty backup dir removed) so a later re-enable takes a FRESH snapshot of
    the restored state.

    Fail-soft: an unreadable (parse error) or semantically invalid
    (version/shape) manifest is moved aside as manifest.json.corrupt — both
    paths behave IDENTICALLY (audit consistency note; the payload of the
    snapshot is preserved for manual rescue, nothing is applied or
    re-snapshotted on top of it) — and the function returns False. Any other
    error mid-restore keeps the manifest so the next boot retries."""
    backup_dir = _harness_writer_backup_dir()
    manifest = backup_dir / "manifest.json"
    if not manifest.is_file():
        return True

    def _quarantine(reason: str) -> bool:
        try:
            corrupt = manifest.with_suffix(".json.corrupt")
            manifest.replace(corrupt)
            log(f"WARN: harness-config-writer backup manifest unreadable/invalid "
                f"({reason}); quarantined as {corrupt.name} — nothing restored, "
                f"nothing re-snapshotted")
        except OSError as e:
            log(f"WARN: harness-config-writer manifest quarantine failed: {e}")
        return False

    try:
        try:
            with open(manifest, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            return _quarantine(f"parse error: {e}")
        entries = data.get("files")
        if not isinstance(entries, list) or (
            data.get("version") != HARNESS_WRITER_BACKUP_VERSION
        ):
            return _quarantine("wrong version/shape")
        # Path containment: only files under the known writer surfaces may be
        # touched by a restore (defense against a tampered manifest); resolved
        # lexically AND after symlink/`..`-resolution (audit H3).
        allowed_roots = tuple(
            Path(root).resolve()
            for root in (ACPX_DIR, CODEX_SOURCE_HOME, OPENCODE_GLOBAL_DIR)
        )
        restored = 0
        removed = 0
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                continue
            path = Path(entry["path"])
            if not path.is_absolute():
                log(f"WARN: relative backup entry skipped: {entry['path']}")
                continue
            if not any(
                path == root or path.resolve().is_relative_to(root)
                for root in allowed_roots
            ):
                log(f"WARN: backup entry outside managed surfaces skipped: {entry['path']}")
                continue
            if entry.get("existed") is True and isinstance(entry.get("content"), str):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(entry["content"]))
                mode = entry.get("mode")
                if isinstance(mode, int):
                    path.chmod(mode)
                restored += 1
            else:
                if path.is_file():
                    path.unlink()
                removed += 1
        manifest.unlink()
        try:
            backup_dir.rmdir()
        except OSError:
            pass  # non-empty (e.g. an earlier quarantine) — keep files visible
        log(f"INFO: harness-config-writer originals restored "
            f"({restored} file(s) rewritten, {removed} writer-only file(s) removed); "
            f"snapshot consumed")
        return True
    except Exception as e:
        log(f"WARN: harness-config-writer restore failed (snapshot kept, next boot "
            f"retries): {e}")
        return False


# --- Add-on-Level-Harness-Defaults (GaRoN 2026-10-11) ----------------------
# Einfache Add-on-Optionen (eine Zeile je Feld, geteilt über die Harnesses)
# statt nur openclaw.json-Hand-Editing. run.sh exportiert die Optionen als
# HARNESS_WRITER_*-ENVs; der Helper merged sie beim Writer-Enabled-Boot
# additiv in plugins.entries['harness-config-writer'].config.harnesses.
# base_url ist der AKTIVATOR (leer = nichts wird generiert — ADDITIV bleibt).
# Aus der Generation fallende Entries werden nur entfernt, wenn sie exakt
# dem zuletzt generierten Stand entsprechen ("never guess"):
# operator-Hände gewinnen immer.
WRITER_ADDON_DEFAULTS_MANAGER = "harness-config-writer"


def _writer_managed_defaults_file() -> Path:
    # Derived per call from CONFIG_DIR (tests patch only CONFIG_DIR).
    return CONFIG_DIR / WRITER_ADDON_DEFAULTS_MANAGER / "managed-defaults.json"
# TS sync rule (ENV_MECHANISM + FILE-Mechanismen in
# plugins/harness-config-writer/src/harness-config-writer.ts — beide Listen
# synchron halten).
KNOWN_WRITER_HARNESS_IDS = (
    "codex", "opencode", "claude", "droid", "gemini", "iflow", "kimi", "kiro", "qwen",
)


def _writer_harness_excluded() -> set[str]:
    raw = os.environ.get("HARNESS_WRITER_EXCLUDED_AGENTS", "")
    return {
        token.strip().lower()
        for token in raw.split(",")
        if token.strip()
    }


def _writer_model_for(harness_id: str) -> str:
    """Shared model line wins; codex/opencode keep their existing dedicated
    add-on options (ollama_acp_*_model) as per-harness default; claude γ: own
    option (OLLAMA_CLAUDE_MODEL) → legacy ambient OLLAMA_ACP_MODEL → default;
    remaining env-IDs ohne Modellvorgabe → "" (TS-Entry valide: model Pflicht —
    wir erzeugen sie dann NICHT statt einen unbrauchbaren Eintrag zu
    schreiben)."""
    shared = os.environ.get("HARNESS_WRITER_MODEL", "").strip()
    if shared:
        return shared
    if harness_id == "codex":
        return os.environ.get("OLLAMA_CODEX_MODEL", "").strip() or OLLAMA_CODEX_MODEL
    if harness_id == "opencode":
        return os.environ.get("OLLAMA_OPENCODE_MODEL", "").strip() or OLLAMA_OPENCODE_MODEL
    if harness_id == "claude":
        return (os.environ.get("OLLAMA_CLAUDE_MODEL", "").strip()
                or os.environ.get("OLLAMA_ACP_MODEL", "").strip()
                or OLLAMA_CLAUDE_MODEL_DEFAULT)
    return ""


def _writer_desired_harnesses() -> dict[str, dict[str, str]]:
    """Desired harnesses dict from the add-on option envs (base_url aktivator;
    apiKey nur wenn gesetzt — TS platziert bereits Placeholder 'ollama' für
    FILE-Mechanismen und NICHTS für ENV-IDs ohne key)."""
    base_url = os.environ.get("HARNESS_WRITER_BASE_URL", "").strip()
    if not base_url:
        return {}
    excluded = _writer_harness_excluded()
    api_key = os.environ.get("HARNESS_WRITER_API_KEY", "").strip()
    desired: dict[str, dict[str, str]] = {}
    for harness_id in KNOWN_WRITER_HARNESS_IDS:
        if harness_id in excluded:
            continue
        model = _writer_model_for(harness_id)
        if not model:
            continue  # ENV-ID ohne Modellvorgabe → bewusst kein Eintrag
        entry: dict[str, str] = {"model": model, "baseUrl": base_url}
        if api_key:
            entry["apiKey"] = api_key
        desired[harness_id] = entry
    return desired


def _write_managed_defaults(managed_path: Path, managed: dict[str, Any]) -> None:
    """Atomare Buch-Ablage der generierten Entries (0600/0700: kann apiKey
    halten). Audit H-B: chmod am tmp NACH vollständiger Dumps, aber VOR dem
    replace — das installierte File hat ab der ersten sichtbaren Sekunde die
    endgültigen Rechte (kein 0644→0600 Exposé-Fenster)."""
    managed_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = managed_path.with_suffix(".json.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "generated": managed}, f, indent=2,
                      ensure_ascii=False)
            f.write("\n")
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, managed_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    try:
        managed_path.parent.chmod(0o700)
    except OSError:
        pass


def merge_addon_harness_defaults() -> None:
    """Merge the add-on harness defaults (HARNESS_WRITER_* envs) into
    plugins.entries['harness-config-writer'].config.harnesses.

    Semantik (GaRoN-Regel verbatim befolgt):
      - base_url leer → kompletter no-op (Feature OFF).
      - Entry noch nicht vorhanden → generiert aus den Optionen.
      - Operator-Handeintrag existiert → UNBERÜHRT (operator wins, INFO).
      - Vorher VON UNS generierter Entry UNVERÄNDERT → von aktuellen Optionen
        aktualisiert/gelöscht (idempotenter Refresh, stale-cleanup).
      - Vorher generierter Entry VOM OPERATOR GEÄNDERT → bleibt + WARN
        (der Operator hat das Ownership übernommen; we never guess).
      - Buch über generierte Entries: managed-defaults.json (unter
        CONFIG_DIR/harness-config-writer/), atomar, 0600 (kann apiKey halten).
    Fail-soft: Fehler → WARN, Boot läuft weiter."""
    desired = _writer_desired_harnesses()
    if not desired:
        _prune_stale_addon_defaults()
        return
    config_path = CONFIG_DIR / "openclaw.json"
    try:
        if not config_path.exists():
            return
        cfg = read_json(config_path)
        harnesses = (
            cfg.setdefault("plugins", {})
            .setdefault("entries", {})
            .setdefault(WRITER_ADDON_DEFAULTS_MANAGER, {})
            .setdefault("config", {})
            .setdefault("harnesses", {})
        )
        if not isinstance(harnesses, dict):
            log("WARN: harnesses config is not an object; add-on defaults NOT merged")
            return
        managed = {}
        managed_path = _writer_managed_defaults_file()
        if managed_path.is_file():
            try:
                previously = read_json(managed_path).get("generated", {})
                if isinstance(previously, dict):
                    managed = previously
            except Exception as e:
                log(f"WARN: managed-defaults.json unreadable; treating as empty ({e})")
        changed = False
        for harness_id, entry in desired.items():
            current = harnesses.get(harness_id)
            if isinstance(current, dict):
                if current != managed.get(harness_id):
                    log(f"INFO: harness '{harness_id}' is operator-owned "
                        "(hand-edited since generation) — untouched")
                    managed.pop(harness_id, None)
                    continue
                if current != entry:
                    harnesses[harness_id] = json.loads(json.dumps(entry))
                    managed[harness_id] = entry
                    changed = True
                    log(f"INFO: refreshed generated harness '{harness_id}' "
                        "from add-on options")
            else:
                harnesses[harness_id] = json.loads(json.dumps(entry))
                managed[harness_id] = entry
                changed = True
                log(f"INFO: generated harness '{harness_id}' from add-on options")
        # Stale cleanup: ids wir generated earlier but that fell out of the
        # desired set (excluded now / base_url removed) — remove ONLY if the
        # entry is byte-identical to what we generated (never guess).
        stale = [hid for hid in managed if hid not in desired]
        for harness_id in stale:
            current = harnesses.get(harness_id)
            if isinstance(current, dict) and current != managed[harness_id]:
                log(f"INFO: harness '{harness_id}' was hand-edited after generation; "
                    "NOT removing (operator wins)")
                managed.pop(harness_id, None)
                continue
            harnesses.pop(harness_id, None)
            managed.pop(harness_id, None)
            changed = True
            log(f"INFO: removed stale generated harness '{harness_id}' "
                "(fell out of the add-on option surface)")
        if changed:
            _write_managed_defaults(managed_path, managed)
            write_json(config_path, cfg)
        else:
            log("INFO: add-on harness defaults already in place (no change)")
    except Exception as e:
        log(f"WARN: add-on harness defaults merge failed (fail-soft): {e}")


def _prune_stale_addon_defaults() -> None:
    """base_url off → previously generated entries are removed while untouched;
    hand-edited ones stay (operator wins). Fail-soft."""
    managed_path = _writer_managed_defaults_file()
    if not managed_path.is_file():
        return
    try:
        previously = read_json(managed_path).get("generated", {})
        if not isinstance(previously, dict) or not previously:
            managed_path.unlink(missing_ok=True)
            return
        config_path = CONFIG_DIR / "openclaw.json"
        if not config_path.exists():
            return
        cfg = read_json(config_path)
        harnesses = (
            cfg.get("plugins", {})
            .get("entries", {})
            .get(WRITER_ADDON_DEFAULTS_MANAGER, {})
            .get("config", {})
            .get("harnesses", {})
        )
        if not isinstance(harnesses, dict):
            return
        changed = False
        for harness_id, generated in previously.items():
            current = harnesses.get(harness_id)
            if isinstance(current, dict) and current != generated:
                log(f"INFO: harness '{harness_id}' hand-edited after generation; "
                    "NOT removing (operator wins)")
                continue
            if current is not None:
                harnesses.pop(harness_id, None)
                changed = True
                log(f"INFO: removed generated harness '{harness_id}' "
                    "(harness defaults option now off)")
            else:
                changed = True
        if changed:
            managed_path.unlink(missing_ok=True)
            write_json(config_path, cfg)
            log("INFO: managed-defaults book consumed (defaults option off)")
    except Exception as e:
        log(f"WARN: stale add-on harness defaults cleanup failed (fail-soft): {e}")


def merge_utility_model() -> bool:
    """V36.2 (2026-10-13): Utility-Modell-Override → agents.defaults.utilityModel.

    Das Utility-Modell trägt die internen Gateway-Utility-Callouten — foremost
    der Session-Observer, dessen strict-JSON-Run-Digests an der Live-Lage
    zerbrachen ("session observer returned invalid JSON twice",
    session-observer-model-9BWdD-iY.mjs strictObject + headline.min(1)) — mit
    Folge: Observer je After-Run disabled, `observerDigest` auf den Entries
    stale (V36.2). Fix an der Wurzel: eine Config-Zeile statt Plugin-Code.

    Semantik (GaRoN-Regeln der Harness-Defaults gespiegelt, ein Wert):
      - OPENCLAW_UTILITY_MODEL unset/leer → NO-OP (operator owns the value,
        wir löschen nie).
      - Setzt → idempotenter Merge: schreibt nur bei Abweichung von
        agents.defaults.utilityModel.
      - agents.entries (Identity etc.) werden NIE berührt.
    Fail-soft: Fehler → WARN, Boot läuft weiter. True bei success/no-op."""
    value = (os.environ.get("OPENCLAW_UTILITY_MODEL") or "").strip()
    if not value:
        return True
    config_path = CONFIG_DIR / "openclaw.json"
    try:
        if not config_path.exists():
            log("INFO: openclaw.json does not exist; skipping utility_model merge")
            return True
        cfg = read_json(config_path)
        agents = cfg.get("agents")
        if not isinstance(agents, dict):
            if agents is not None:
                log("WARN: agents config is not an object; utility_model NOT merged")
                return False
            agents = cfg.setdefault("agents", {})
        defaults = agents.get("defaults")
        if not isinstance(defaults, dict):
            if defaults is not None:
                log("WARN: agents.defaults is not an object; utility_model NOT merged")
                return False
            defaults = agents.setdefault("defaults", {})
        if defaults.get("utilityModel") == value:
            log("INFO: agents.defaults.utilityModel already matches the option (no change)")
            return True
        defaults["utilityModel"] = value
        write_json(config_path, cfg)
        log(f"WROTE agents.defaults.utilityModel={value} (add-on option utility_model)")
        return True
    except Exception as e:
        log(f"WARN: utility_model merge failed (fail-soft): {e}")
        return False


def _disable_binding_plugin() -> bool:
    """HA option off = REAL operator opt-out (GaRoN 2026-10-12).

    Outage finding (user report, 8h log forensics until 2026-10-12): the old
    skip-only semantics left a previously registered
    plugins.entries['acp-dashboard-binding']={enabled:true} behind, so the
    option toggle was cosmetic; and with the plugin gate off its manifest no
    longer declares the channel, so a leftover channels['acp-dashboard-binding']
    config block became an unknown-keys "Invalid config" and the gateway
    refused to BOOT — the reported "complete outage" path (the rescue was
    removing the channels block by hand).

    Semantics (idempotent, fail-soft):
      - plugins.entries['acp-dashboard-binding'].enabled := false. The HA
        option is the MASTER switch for this plugin (one truthful toggle,
        no config surgery); re-enabling via the option flips the entry back
        (see _register_plugin_entry force_enable) — the binding plugin's
        never-flip rule is deliberately superseded, because a silent
        never-flip with the UI showing ON is exactly the UI-lying failure
        class reported on 2026-10-12.
      - channels['acp-dashboard-binding'] config block removed when present
        (undeclared-channel config would refuse boot).
      - nothing to change -> no-op, no write."""
    config_path = CONFIG_DIR / "openclaw.json"
    if not config_path.exists():
        return True
    try:
        cfg = read_json(config_path)
    except Exception as e:
        log(f"WARN: binding-disable skipped, config unreadable (fail-soft): {e}")
        return True
    changed = False
    plugins = cfg.get("plugins")
    if isinstance(plugins, dict):
        entries = plugins.get("entries")
        if isinstance(entries, dict):
            entry = entries.get(PLUGIN_NAME)
            if isinstance(entry, dict) and entry.get("enabled") is not False:
                entry["enabled"] = False
                changed = True
                log(f"Set plugins.entries.{PLUGIN_NAME}.enabled=false "
                    "(option acp_dashboard_binding_enabled=off)")
        channels = cfg.get("channels")
        if isinstance(channels, dict) and PLUGIN_NAME in channels:
            del channels[PLUGIN_NAME]
            changed = True
            log(f"Stripped channels['{PLUGIN_NAME}'] while the plugin gate is off "
                "(undeclared channel key would refuse boot)")
    if changed:
        try:
            write_json(config_path, cfg)
        except Exception as e:
            log(f"WARN: binding-disable write failed (fail-soft): {e}")
            return False
    return True


def _binding_option_state() -> bool:
    """acp_dashboard_binding_enabled option, GaRoN 2026-10-12 semantics:

      - explicit false  -> OFF: real opt-out (helper disables the plugin and
        keeps the boot config valid — the operator kill switch).
      - true / unset    -> ON: the binding is the addon's core surface and
        activates out of the box (user vision 2026-10-12: harness agents are
        usable in the dashboard without any setup); protection is the
        explicit off switch, the fail-open claim path and the isolated
        plugin-load failure mode (host marks the plugin unloaded, gateway
        keeps booting)."""
    value = os.environ.get("ACP_DASHBOARD_BINDING_ENABLED", "").strip().lower()
    return value not in ("0", "false", "no", "off")


def deploy_plugins() -> bool:
    """Deploy + register all bundled plugins, gated by add-on options.

    Repo-Split A2 (2026-10-11): two plugins instead of one —

      - 'acp-dashboard-binding'  (channel plugin, dashboard key bridge):
        gated by acp_dashboard_binding_enabled (env
        ACP_DASHBOARD_BINDING_ENABLED, see _binding_option_state for the
        GaRoN 2026-10-12 semantics: unset/default ON, explicit false =
        real opt-out that flips the entries gate and strips the channel
        config block).
      - 'harness-config-writer'  (standalone feature plugin):
        gated by harness_config_writer_enabled (env
        HARNESS_CONFIG_WRITER_ENABLED). UNSET follows the channel-plugin
        option so existing setups keep the previous bundled behavior
        (binding on = writer on); explicit true/false overrides it.

    Option gating happens BEFORE any payload or openclaw.json is touched;
    a skip is success for callers, not a failure.

    Backup-Rewrite (GaRoN 2026-10-11): a writer-enabled boot takes the
    one-time pre-writer snapshot of all managed harness config surfaces
    (see backup_harness_writer_targets_once); a writer-disabled boot
    restores + consumes that snapshot, so enable/disable is fully
    reversible without touching the TS plugin."""
    binding_enabled = _binding_option_state()
    ok = True
    if not binding_enabled:
        log("INFO: plugin acp-dashboard-binding disabled "
            "(acp_dashboard_binding_enabled=false — real opt-out)")
        # GaRoN 2026-10-12: the off switch is now a REAL opt-out — flip the
        # entries gate and keep the boot config valid (no undeclared channel
        # block), instead of skip-only which left the old registration live.
        if not _disable_binding_plugin():
            ok = False

    writer_env = os.environ.get("HARNESS_CONFIG_WRITER_ENABLED", "").strip().lower()
    if writer_env == "":
        writer_enabled = binding_enabled
        if writer_enabled:
            log("INFO: plugin harness-config-writer enabled by default "
                "(follows acp_dashboard_binding_enabled=true)")
    else:
        writer_enabled = _env_flag("HARNESS_CONFIG_WRITER_ENABLED")
        if not writer_enabled:
            log("INFO: plugin harness-config-writer deploy disabled by option "
                "(harness_config_writer_enabled=false)")

    if binding_enabled:
        # Master switch ON = the binding plugin's enable decision is the HA
        # option (see _binding_option_state; force_enable supersedes the
        # entry's never-flip only for THIS plugin).
        ok = _deploy_and_register_plugin(PLUGIN_NAME, force_enable=True) and ok
    if writer_enabled:
        ok = _deploy_and_register_plugin(HARNESS_CONFIG_WRITER_PLUGIN_NAME) and ok
        migrate_legacy_harnesses_config()
        # Add-on-Level-Harness-Defaults (GaRoN 2026-10-11): HARNESS_WRITER_*
        # envs (base_url Aktivator, model, api_key, excluded_agents) additiv
        # in die writer harnesses-Entry mergen — Operator-Handeinträge
        # unangetastet, stale generierte Entries bereinigt.
        merge_addon_harness_defaults()
        # Backup-Rewrite (GaRoN 2026-10-11): first-enable snapshot of the
        # operator pre-writer state, consumed when the gate goes off again.
        ok = backup_harness_writer_targets_once() and ok
    else:
        restore_harness_writer_targets()
    return ok


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
    ok = deploy_plugins()
    ok = install_acpx_npm_project() and ok
    ok = patch_openclaw_config() and ok
    # V36.2 (2026-10-13): agents.defaults.utilityModel from the utility_model
    # option — agent entries stay untouched; unset = no write.
    ok = merge_utility_model() and ok
    if ok:
        log("ACPX initialization complete")
    else:
        log("ACPX initialization completed WITH FAILURES (harnesses may be unavailable this boot)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
