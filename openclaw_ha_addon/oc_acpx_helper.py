#!/usr/bin/env python3
"""
OpenClaw HA App — ACPX harness initializer.

This helper runs during app startup (called from run.sh) and ensures that
the local-model ACP harnesses are ready to use:

  1. (RETIRED, Phase 3 / v0.7.13.16) Harness config generation (the codex
     auth.json + /config/.codex/config.toml that the Codex client reads,
     opencode jsonc) moved into the harness-config-writer feature plugin (Repo-Split
     A2, 2026-10-11: previously plugins.entries['acp-dashboard-binding']
     .config.harnesses, the 15 design (generalized harness config (HCW phase 3))); deploy_harness_configs/
     prepare_opencode_home are no-ops now.
  2. Creates a small managed npm project in /config/.openclaw/acpx/.node_project
     with ACPX and the vendor-verified persistent harness CLIs installed
  3. Patches /config/.openclaw/openclaw.json to enable ACPX (agents preserved)

Custom wrapper launchers are NO longer used (2026-10-09): the acpx plugin
generates passthrough wrappers for codex/claude at gateway start, and the
provider env is exported by run.sh (ambient env). Native harness config is
owned by harness-config-writer.

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
# The image no longer ships the legacy acpx/ template directory; the plugin
# payload lives directly under /openclaw_ha_addon/plugins.
PLUGIN_SRC_DIR = Path("/openclaw_ha_addon/plugins")
PROJECT_DIR = ACPX_DIR / ".node_project"
# run.sh puts this directory on PATH. Publish project-local harness entry
# points here so ACPX can resolve them by their vendor command names.
PERSISTENT_BIN_DIR = CONFIG_DIR.parent / ".node_global" / "bin"
# OpenCode's global config dir. Resolution rule (verified 2026-11-05 against
# the installed opencode binary): `XDG_CONFIG_HOME || homedir()/.config` —
# XDG FIRST. The add-on exports XDG_CONFIG_HOME=/config and the acpx wrappers
# hand the full process env to the harness child (oc_provider_env.mjs:
# resolveProviderEnv -> {...processEnv}), so OpenCode reads
# $XDG_CONFIG_HOME/opencode = /config/opencode. The harness-config-writer
# resolves identically (resolveOpencodeGlobalDir: XDG first). Do NOT switch
# this to /config/.config/opencode — that would break writer/reader agreement.
OPENCODE_GLOBAL_DIR = Path("/config/opencode")
# Bundled plugin payload shipped in the add-on image (copied to
# CONFIG_DIR/plugins/<name> at start; never copied recursively from the
# running acpx project dir, which has live node_modules).
PLUGIN_SRC_FALLBACK_DIRS = (
    Path(__file__).resolve().parent / "plugins",
)
HARNESS_CONFIG_WRITER_PLUGIN_NAME = "harness-config-writer"
LEGACY_BINDING_PLUGIN_NAME = "acp-dashboard-binding"
BUNDLED_PLUGIN_NAMES = [HARNESS_CONFIG_WRITER_PLUGIN_NAME]
# Bundled-Root-Trust-Deploy (Kammerjäger 2026-10-11, Restart-Log v0.7.13.17):
# the gateway grants the trusted plugin runtime API (api.runtime.state.
# openKeyedStore etc.) ONLY to plugins whose record is origin "bundled"
# (physical root under the pinned gateway package's dist/extensions) or an
# official-catalog install (trustedOfficialInstall — unreachable for path
# plugins). A config-origin deploy cannot access that trusted runtime API.
# This helper therefore deploys a COMPILED bundle into the gateway's bundled
# extensions root: bundled plugins load with full trust and without the
# TypeScript-stripping startup cost.
BUNDLED_EXTENSIONS_DIR = Path("/usr/lib/node_modules/openclaw/dist/extensions")
# The runtime resolves its managed plugin installs through
# resolveActivePluginInstallDir("extensions", ...) - on an add-on install that
# is <state>/extensions. Only plugins found there count as *installed*, so the
# runtime owns their data/settings migration; a plugin that only exists in the
# package's bundled root has no migration owner and its retained data can
# never converge. The directory is resolved from CONFIG_DIR at call time so it
# follows the configuration root of the running installation.
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
# γ.2 writer targets (HCW gamma.2, 2026-11-05): the file-based claude/pi
# harnesses and the standard Codex home live outside the acpx dir. The writer
# paths mirror harness-config-writer.ts resolveHarnessWriterPaths(): the
# state dir is /config/.openclaw, its parent (/config) carries .claude/ and
# .pi/agent/. These constants must stay in sync with the plugin — a target
# missing here is NOT rolled back when the writer is disabled.
CLAUDE_SOURCE_HOME = Path("/config/.claude")
PI_AGENT_DIR = Path("/config/.pi/agent")

# npm package versions (bump when the app image is rebuilt)
ACPX_PACKAGE = "@openclaw/acpx"
OPENCLAW_ACPX_VERSION = os.environ.get("OPENCLAW_ACPX_VERSION", "2026.11.11")
OPENCODE_VERSION = os.environ.get("OPENCODE_VERSION", "1.19.6")
OPENCODE_PACKAGE = os.environ.get("OPENCODE_PACKAGE", "opencode-ai")
# Vendor package names and versions verified against the packages' own npm
# metadata on 2026-11-22. Explicit pins keep restored installations repeatable.
PI_PACKAGE = "@mariozechner/pi-coding-agent"
PI_VERSION = os.environ.get("PI_VERSION", "0.73.1")
COPILOT_PACKAGE = "@github/copilot"
COPILOT_VERSION = os.environ.get("COPILOT_VERSION", "1.0.116")
KILO_PACKAGE = "@kilocode/cli"
KILO_VERSION = os.environ.get("KILO_VERSION", "7.8.32")
QWEN_PACKAGE = "@qwen-code/qwen-code"
QWEN_VERSION = os.environ.get("QWEN_VERSION", "0.28.7")
GEMINI_PACKAGE = "@google/gemini-cli"
GEMINI_VERSION = os.environ.get("GEMINI_VERSION", "0.71.1")
DROID_PACKAGE = "@factory/cli"
DROID_VERSION = os.environ.get("DROID_VERSION", "1.21.1")
IFLOW_PACKAGE = "@iflow-ai/iflow-cli"
IFLOW_VERSION = os.environ.get("IFLOW_VERSION", "0.5.19")
REFERENCE_WORKER_AGENTS = frozenset({"codex", "claude", "opencode", "pi"})
# Executable names verified in the vendor npm `bin` metadata. Kilo deliberately
# publishes both aliases supplied by @kilocode/cli.
HARNESS_EXECUTABLES = {
    "opencode": "opencode",
    "pi": "pi",
    "copilot": "copilot",
    "kilo": "kilo",
    "kilocode": "kilocode",
    "qwen": "qwen",
    "gemini": "gemini",
    "droid": "droid",
    "iflow": "iflow",
}
# Harness model defaults. Generic app rule (GaRoN 2026-10-10): the add-on must
# work user-independent — these are only DEFAULTS; real overrides come from
# add-on options (run.sh forwards them as env; renamed to harness_* in the
# 0.7.13.30 sectioned layout, old flat names still coalesce).
#   acp codex models  : OLLAMA_CODEX_MODEL  (add-on option: harness_codex_model)
#   acp opencode models: OLLAMA_OPENCODE_MODEL (add-on option: harness_opencode_model)
# gemma4 was only ever a budget-emergency placeholder; never ship it as default.
# Modell-Optionen des Add-ons (leer = weitersuchen, KEIN fest verdrahteter Default):
#   harness_codex_model    -> OLLAMA_CODEX_MODEL
#   harness_claude_model   -> OLLAMA_CLAUDE_MODEL
#   harness_opencode_model -> OLLAMA_OPENCODE_MODEL
#   harness_pi_model       -> OLLAMA_PI_MODEL
#   harness_model (geteilt) -> HARNESS_WRITER_MODEL
# Ohne Optionen greift der Gateway-Default (agents.defaults.model.primary).
# pi (2026-11-13): der pi-Harness war bisher NICHT in KNOWN_WRITER_HARNESS_IDS —
# der add-on konnte ihn also nie generieren und ein pi-Entry in der config
# war immer hand-edited (der Helper schützt hand-edits mit "operator wins").
# Der pi-Harness nutzt den FILE-Mechanismus (models.json + settings.json) und
# kennt jetzt den vollen Gateway-Katalog (HCW-Fix: Provider-Key-Vererbung).

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


def resolve_plugin_src_dir(plugin_name: str) -> Path | None:
    """Locate the bundled plugin payload directory (F1, Phase 2.10).

    The image COPYs /openclaw_ha_addon/plugins, but older images and bare
    repo checkouts may lack it — so the first candidate that actually
    contains <plugin_name>/openclaw.plugin.json wins:

      1. PLUGIN_SRC_DIR (canonical image payload; mocked in tests)
      2. <this helper's dir>/plugins          (repo checkout / dev runs)

    The chosen source is logged so a wrong/missing bundle is visible at
    start instead of failing silently in deploy_plugins().
    """
    candidates = [
        PLUGIN_SRC_DIR,
        *PLUGIN_SRC_FALLBACK_DIRS,
    ]
    for candidate in candidates:
        if (candidate / plugin_name / "openclaw.plugin.json").is_file():
            if candidate != PLUGIN_SRC_DIR:
                log(f"INFO: plugin source fallback in use: {candidate}")
            return candidate
    log(
        f"WARNING: plugin source for {plugin_name} not found; probed: "
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
    # Development and checkout hosts: the esbuild that belongs to the
    # OpenClaw installation next to the running `openclaw` binary. The
    # package directory is derived from PATH (npm global roots) and from the
    # `openclaw` binary itself, because the binary can be a wrapper.
    for package_dir in _openclaw_package_dirs():
        for relative in (
            Path("node_modules") / ".bin" / "esbuild",
            Path("node_modules") / "esbuild" / "bin" / "esbuild",
        ):
            candidate = package_dir / relative
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return shutil.which("esbuild")


def _openclaw_package_dirs() -> list[Path]:
    """Return the directories that may hold an npm-installed OpenClaw."""
    dirs: list[Path] = []
    seen: set[str] = set()

    def add(candidate: Path) -> None:
        resolved = str(candidate)
        if resolved not in seen:
            seen.add(resolved)
            dirs.append(candidate)

    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        base = Path(entry)
        add(base.parent / "lib" / "node_modules" / "openclaw")
        add(base / "node_modules" / "openclaw")
    openclaw_bin = shutil.which("openclaw")
    if openclaw_bin:
        add(Path(openclaw_bin).resolve().parent.parent)
    return dirs


def _image_node_subprocess_env() -> dict[str, str]:
    """Return an environment whose `/usr/bin/env node` resolves to image Node.

    npm and the OpenClaw-pinned esbuild are commonly Node scripts with an env
    shebang. run.sh deliberately puts persistent npm/pnpm and Homebrew bins
    first for ordinary tools, so those subprocesses need the same image-first
    path guard as gateway children instead of inheriting a restored Node.
    """
    env = os.environ.copy()
    env["PATH"] = f"/usr/bin:/bin:{env.get('PATH', '')}"
    return env


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
            "--bundle", "--format=esm", "--platform=node", f"--target={_esbuild_node_target()}",
            "--external:openclaw", "--external:openclaw/*", "--external:@openclaw/*",
            f"--outfile={outfile}",
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,
                env=_image_node_subprocess_env(),
            )
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


def _deploy_and_register_plugin(plugin_name: str) -> bool:
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

    Repo-Split A2 (2026-10-11): harness-config-writer is deployed by this
    helper; option gating lives in deploy_plugins().

    Phase 2.15 (GaRoN, origin semantics kept): deploying/registering is
    OPT-IN per plugin via the add-on options forwarded by run.sh as env;
    when the option is absent or unset/false the deploy is skipped entirely
    and nothing is written to openclaw.json.
    """
    src_dir = resolve_plugin_src_dir(plugin_name)
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
            written: list[str] = []
            # Two targets: the package's bundled root (trusted runtime API) and
            # the runtime's managed install root (the runtime only owns the
            # data/settings migration of plugins it finds as *installed*).
            for dst in (BUNDLED_EXTENSIONS_DIR / plugin_name,
                        CONFIG_DIR / "extensions" / plugin_name):
                dst.mkdir(parents=True, exist_ok=True)
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
                # Runtime assets: the bundled extension is a compiled bundle, so
                # non-source assets are not part of index.mjs and would be lost.
                # The writer resolves them relative to the module directory
                # (fixtures/<file> next to index.mjs) - without this copy the
                # Codex catalog is written without base_instructions.
                for asset_rel in ("fixtures/codex-base-instructions.txt",):
                    asset_src = src / "src" / asset_rel
                    if asset_src.is_file():
                        asset_dst = dst / asset_rel
                        asset_dst.parent.mkdir(parents=True, exist_ok=True)
                        _write_bytes_and_cache(asset_dst, asset_src.read_bytes(), written)
                log(f"Deployed plugin {plugin_name} -> {dst} (esbuild {esbuild_bin})")
            if external_dst.exists():
                shutil.rmtree(external_dst)
                log(f"Removed stale external plugin deploy {external_dst} "
                    "(superseded by bundled-root deploy)")
            if written:
                for path in written:
                    log(f"  wrote {path}")
            else:
                log(f"Plugin {plugin_name} already up to date "
                    "(byte-identical - read-only boot)")
            return _register_plugin_entry(plugin_name)
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
    return _register_plugin_entry(plugin_name)


def _register_plugin_entry(plugin_name: str) -> bool:
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
        # gate — an allowlist PRESENT but missing the plugin id yields
        # "plugin disabled (not in allowlist)". 
        # Phase 2.20 fix (GaRoN 2026-10-17, config-bug report): setdefault
        # CREATES the list when absent — and an allowlist, once created,
        # is EXCLUSIVE (plugins loaded only if their id is in it), so a
        # fresh list silently blocked every other plugin including all
        # provider plugins. Absence of plugins.allow means nothing is
        # blocked — never create it; only union into a PRE-EXISTING list
        # (operator/other-tool authored, removals of other ids preserved).
        allow_list = plugins.get("allow")
        if allow_list is None:
            log(f"INFO: plugins.allow not set (nothing blocked); not creating an allowlist")
        elif not isinstance(allow_list, list):
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


def migrate_legacy_harnesses_config(enable_fresh_entry: bool = True) -> None:
    """Repo-Split A2 (2026-10-11) one-time config key migration.

    The generalized harness config surface moved from
    plugins.entries['acp-dashboard-binding'].config.harnesses (pre-split,
    Phase 3 in the channel plugin) to
    plugins.entries['harness-config-writer'].config.harnesses.

    Semantics (idempotent, fail-soft):
      - legacy key present, new key absent -> copy + remove the legacy key;
        a FRESH writer entry gets enabled:true only when the caller passes
        enable_fresh_entry (v0.7.13.30: the writer switch is an independent
        opt-in — when it is off, the migrated entry carries the config
        WITHOUT an enabled flag and the deploy block decides on enable).
      - both keys present -> leave BOTH untouched + WARN (operator must
        decide; we never guess which is authoritative).
      - nothing present -> no-op.
      - a PRE-EXISTING writer entry keeps its enabled flag untouched: true /
        unset both deploy-legal (the deploy block decides nothing here), an
        explicit enabled:false operator opt-out is NEVER flipped (audit B3,
        GaRoN invariant 2026-10-10) — config transport is independent of the
        enable decision.
    The old plugin is retired; only this data-preserving migration remains."""
    config_path = CONFIG_DIR / "openclaw.json"
    if not config_path.exists():
        return
    try:
        cfg = read_json(config_path)
        entries = cfg.get("plugins", {}).get("entries", {})
        if not isinstance(entries, dict):
            return
        legacy_entry = entries.get(LEGACY_BINDING_PLUGIN_NAME) or {}
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
                "BOTH untouched (operator decision required). Verify the new "
                "surface, then remove the legacy key manually."
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
        elif not writer_pre_existed and enable_fresh_entry:
            writer_entry["enabled"] = True
        legacy_cfg.pop("harnesses", None)
        write_json(config_path, cfg)
        log(
            "INFO: migrated plugins.entries['acp-dashboard-binding'].config.harnesses "
            f"-> plugins.entries['{HARNESS_CONFIG_WRITER_PLUGIN_NAME}'].config.harnesses"
        )
    except Exception as e:
        log(f"WARN: legacy harnesses config migration failed: {e}")


def remove_retired_binding_installation() -> bool:
    """Remove previously deployed binding artifacts after data migration.

    Successful migration removes the legacy harnesses key, so the empty plugin
    entry can go as well. A divergent legacy/new harness map remains as an
    explicit, disabled reconciliation record instead of being destroyed.
    """
    ok = True
    for root in (
        CONFIG_DIR / "plugins" / LEGACY_BINDING_PLUGIN_NAME,
        BUNDLED_EXTENSIONS_DIR / LEGACY_BINDING_PLUGIN_NAME,
    ):
        if not root.exists() and not root.is_symlink():
            continue
        try:
            if root.is_symlink() or root.is_file():
                root.unlink()
            else:
                shutil.rmtree(root)
            log(f"INFO: removed retired plugin payload {root}")
        except OSError as e:
            log(f"ERROR: could not remove retired plugin payload {root}: {e}")
            ok = False

    config_path = CONFIG_DIR / "openclaw.json"
    if not config_path.exists():
        return ok
    try:
        cfg = read_json(config_path)
        changed = False
        plugins = cfg.get("plugins")
        entries = plugins.get("entries") if isinstance(plugins, dict) else None
        if isinstance(entries, dict):
            legacy = entries.get(LEGACY_BINDING_PLUGIN_NAME)
            legacy_config = legacy.get("config") if isinstance(legacy, dict) else None
            unresolved = (
                isinstance(legacy_config, dict)
                and isinstance(legacy_config.get("harnesses"), dict)
                and bool(legacy_config["harnesses"])
            )
            if unresolved:
                if legacy.get("enabled") is not False:
                    legacy["enabled"] = False
                    changed = True
                log("WARN: retired plugin entry kept disabled because its "
                    "harnesses mapping conflicts with the writer entry")
            elif LEGACY_BINDING_PLUGIN_NAME in entries:
                del entries[LEGACY_BINDING_PLUGIN_NAME]
                changed = True
        allow = plugins.get("allow") if isinstance(plugins, dict) else None
        if isinstance(allow, list) and LEGACY_BINDING_PLUGIN_NAME in allow:
            plugins["allow"] = [
                item for item in allow if item != LEGACY_BINDING_PLUGIN_NAME
            ]
            changed = True
        channels = cfg.get("channels")
        if isinstance(channels, dict) and LEGACY_BINDING_PLUGIN_NAME in channels:
            del channels[LEGACY_BINDING_PLUGIN_NAME]
            changed = True
        if changed:
            write_json(config_path, cfg)
            log("INFO: removed retired plugin registration/channel configuration")
    except Exception as e:
        log(f"ERROR: retired plugin registration cleanup failed: {e}")
        return False
    return ok


def remove_native_codex_plugin_registration() -> bool:
    """Remove only the retired native Codex plugin from gateway discovery.

    The Codex ACP agent is a different surface: its acpx command, the HCW
    harness entry and every ACP roster entry stay untouched. The allowlist is
    edited only when it already exists and all unrelated ids retain their
    order. No plugin or allowlist key is created by this cleanup.
    """
    config_path = CONFIG_DIR / "openclaw.json"
    if not config_path.exists():
        return True
    try:
        cfg = read_json(config_path)
        plugins = cfg.get("plugins")
        if not isinstance(plugins, dict):
            return True
        changed = False
        entries = plugins.get("entries")
        if isinstance(entries, dict) and "codex" in entries:
            del entries["codex"]
            changed = True
        allow = plugins.get("allow")
        if isinstance(allow, list) and "codex" in allow:
            plugins["allow"] = [item for item in allow if item != "codex"]
            changed = True
        if changed:
            write_json(config_path, cfg)
            log("INFO: native Codex plugin registration and allow id removed; "
                "Codex ACP harness and native writer configuration preserved")
        return True
    except Exception as e:
        log(f"ERROR: native Codex plugin registration cleanup failed: {e}")
        return False


def prune_native_codex_managed_project() -> bool:
    """Remove only the retired native Codex package from an existing project.

    This unconditional upgrade cleanup deliberately does not invoke npm. It
    therefore cannot install packages, create a missing managed project or
    enable ACPX. Both the manifest entry and the exact package payload are
    handled independently so interrupted/partial upgrades converge on the
    next boot without touching any other dependency.
    """
    if not PROJECT_DIR.is_dir():
        return True

    ok = True
    package_json = PROJECT_DIR / "package.json"
    if package_json.is_file():
        try:
            manifest = read_json(package_json)
            dependencies = manifest.get("dependencies")
            if isinstance(dependencies, dict) and "@openclaw/codex" in dependencies:
                del dependencies["@openclaw/codex"]
                write_json(package_json, manifest)
                log("INFO: native Codex dependency removed from the managed npm manifest")
        except Exception as e:
            log(f"ERROR: native Codex managed-manifest cleanup failed: {e}")
            ok = False

    # Do not remove or recreate the @openclaw scope directory: it can contain
    # ACPX and unrelated operator packages. Only this exact retired payload is
    # ours to prune.
    payload = PROJECT_DIR / "node_modules" / "@openclaw" / "codex"
    if payload.exists() or payload.is_symlink():
        try:
            if payload.is_symlink() or not payload.is_dir():
                payload.unlink()
            else:
                shutil.rmtree(payload)
            log("INFO: native Codex package payload removed; Codex ACP adapter preserved")
        except OSError as e:
            log(f"ERROR: native Codex package payload cleanup failed: {e}")
            ok = False
    return ok


# Backup-Rewrite (GaRoN 2026-10-11): the writer plugin writes into
# operator-adjacent surfaces (/config/.codex, /config/opencode, acpx
# opencode-home + harness-env). To make enable/disable fully
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
# copilot added 2026-10-16 (BYOK/OpenAI-compatible surface, Ollama-Doku +
# binary-verified; sync with ENV_MECHANISM in harness-config-writer.ts).
HARNESS_WRITER_ENV_IDS = ("claude", "copilot", "droid", "gemini", "iflow", "kimi", "kiro", "qwen")
HARNESS_WRITER_BACKUP_VERSION = 1


def _hcw_env_value(env: Any, key: str) -> str:
    value = env.get(key)
    return value.strip() if isinstance(value, str) else ""


def _absolute_native_path(value: str | Path) -> Path:
    """Absolute lexical path, matching Node's path resolution without
    dereferencing symlinks. HCW accepts relative QWEN/COPILOT/KIMI homes;
    making the same location absolute keeps backup entries restorable."""
    return Path(os.path.abspath(os.fspath(value)))


def _resolve_codex_native_home(env: Any = None) -> Path:
    """Mirror HCW: CODEX_HOME first, then HOME/.codex, with the add-on path
    retained only as the no-HOME fallback for the fixed container layout."""
    e = os.environ if env is None else env
    configured = _hcw_env_value(e, "CODEX_HOME")
    if configured:
        return _absolute_native_path(configured)
    home = _hcw_env_value(e, "HOME").rstrip("/")
    if home:
        return _absolute_native_path(f"{home}/.codex")
    return _absolute_native_path(CODEX_SOURCE_HOME)


def _resolve_xdg_native_root(dirname: str, env: Any = None) -> Path | None:
    """Mirror HCW resolveOpencodeGlobalDir/resolveKiloGlobalDir: trimmed XDG
    first, then HOME/.config. Trailing slashes are removed like the TS code."""
    e = os.environ if env is None else env
    xdg = _hcw_env_value(e, "XDG_CONFIG_HOME")
    if xdg:
        return _absolute_native_path(f"{xdg.rstrip('/')}/{dirname}")
    home = _hcw_env_value(e, "HOME")
    if home:
        return _absolute_native_path(f"{home.rstrip('/')}/.config/{dirname}")
    return None


def _resolve_qwen_native_home(env: Any = None) -> Path | None:
    """Mirror HCW resolveQwenHome, including ~, ~/, ~\\, relative paths,
    absolute/normalized paths and QWEN_HOME=/."""
    e = os.environ if env is None else env
    configured_home = _hcw_env_value(e, "HOME")
    home = (
        _absolute_native_path(configured_home)
        if configured_home
        else None
    )
    qwen_home = _hcw_env_value(e, "QWEN_HOME")
    if qwen_home == "~" or qwen_home.startswith(("~/", "~\\")):
        if home is None:
            return None
        return home if qwen_home == "~" else home / qwen_home[2:]
    if qwen_home:
        return _absolute_native_path(qwen_home)
    return home / ".qwen" if home is not None else None


def _harness_writer_native_roots() -> dict[str, Path]:
    """Current HCW roots, resolved at call time from the process environment.

    This never adds HOME as a general restore root. An explicitly configured
    QWEN_HOME can equal HOME, but the restore path also requires an exact
    inventoried target, so other home files remain inaccessible.
    """
    e = os.environ
    roots = {
        "acpx": _absolute_native_path(ACPX_DIR),
        "codex": _resolve_codex_native_home(e),
        "claude": _absolute_native_path(CLAUDE_SOURCE_HOME),
        "pi": _absolute_native_path(PI_AGENT_DIR),
    }
    for harness_id, root in (
        ("opencode", _resolve_xdg_native_root("opencode", e)),
        ("kilo", _resolve_xdg_native_root("kilo", e)),
        ("qwen", _resolve_qwen_native_home(e)),
    ):
        if root is not None:
            roots[harness_id] = root

    home = _hcw_env_value(e, "HOME").rstrip("/")
    if home:
        for harness_id, dirname in (
            ("gemini", ".gemini"),
            ("iflow", ".iflow"),
            ("droid", ".factory"),
            ("kiro", ".kiro"),
        ):
            roots[harness_id] = _absolute_native_path(f"{home}/{dirname}")

    def explicit_home(key: str) -> str:
        # HCW explicitHome(): trim and remove all trailing slashes; unlike
        # QWEN_HOME it performs no tilde expansion of its own.
        return _hcw_env_value(e, key).rstrip("/")

    copilot = explicit_home("COPILOT_HOME") or (f"{home}/.copilot" if home else "")
    kimi = explicit_home("KIMI_CODE_HOME") or (f"{home}/.kimi-code" if home else "")
    if copilot:
        roots["copilot"] = _absolute_native_path(copilot)
    if kimi:
        roots["kimi"] = _absolute_native_path(kimi)
    return roots


def _managed_json_sidecar(config_path: Path) -> Path:
    """TS managedJsonStatePath(): append, never replace, the JSON suffix."""
    return Path(f"{config_path}.hcw-managed.json")


def harness_writer_managed_files() -> list[Path]:
    """Complete current and legacy HCW write surface.

    Native roots mirror resolveHarnessWriterPaths() and are recomputed on
    every call. Every JSON target managed through writeManagedStateIfApplied
    has its exact .hcw-managed.json sidecar listed here as well.
    """
    roots = _harness_writer_native_roots()
    acpx = roots["acpx"]
    codex = roots["codex"]
    claude = roots["claude"]
    pi = roots["pi"]
    opencode_acpx = acpx / "opencode-home" / "opencode.jsonc"
    claude_settings = claude / "settings.json"
    pi_models = pi / "models.json"
    pi_settings = pi / "settings.json"
    files = [
        # Standard Codex files belong to HCW; ACPX owns its isolated home.
        codex / "auth.json",
        codex / "config.toml",
        codex / "model-catalog.json",
        opencode_acpx,
        acpx / "opencode-home" / "config.toml",
        claude_settings,
        pi_models,
        pi_settings,
    ]
    managed_json = [opencode_acpx, claude_settings, pi_models, pi_settings]
    if "opencode" in roots:
        managed_json.append(roots["opencode"] / "opencode.jsonc")
    if "kilo" in roots:
        # kilo and kilocode intentionally share the native Kilo target.
        managed_json.append(roots["kilo"] / "kilo.json")
    if "qwen" in roots:
        managed_json.append(roots["qwen"] / "settings.json")
    for harness_id in ("gemini", "copilot", "iflow", "droid"):
        if harness_id in roots:
            managed_json.append(roots[harness_id] / "settings.json")
    if "kiro" in roots:
        managed_json.append(roots["kiro"] / "settings" / "cli.json")
    if "kimi" in roots:
        files.append(roots["kimi"] / "config.toml")  # TOML: no JSON sidecar

    # Stable manifest order simplifies audits/upgrades; sidecar ordering is
    # not semantic.
    for config_path in managed_json:
        if config_path not in files:
            files.append(config_path)
        files.append(_managed_json_sidecar(config_path))
    files.extend(
        acpx / "harness-env" / f"{harness_id}.env"
        for harness_id in HARNESS_WRITER_ENV_IDS
    )
    return list(dict.fromkeys(files))


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
        return _upgrade_legacy_harness_writer_backup(manifest)
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
        for path in _harness_writer_snapshot_targets():
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


def _harness_writer_snapshot_targets() -> list[Path]:
    """Canonical files plus pre-existing noncanonical env surfaces."""
    managed = harness_writer_managed_files()
    env_dir = _harness_writer_native_roots()["acpx"] / "harness-env"
    extra_env = []
    if env_dir.is_dir():
        extra_env = sorted(p for p in env_dir.glob("*.env") if p not in managed)
    return [*managed, *extra_env]


def _upgrade_legacy_harness_writer_backup(manifest: Path) -> bool:
    """Add newly invented targets to an existing version-1 backup safely.

    The old backup predates the expanded HCW write surface. Existing bytes at
    a newly added path may already be HCW output, so they are NEVER sampled
    retrospectively. Such paths remain explicit `upgrade_unverified` entries
    and are left untouched on OFF. A path absent at upgrade time can safely be
    recorded absent: if HCW later creates it, OFF removes it.
    """
    try:
        with open(manifest, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data.get("files")
        if data.get("version") != HARNESS_WRITER_BACKUP_VERSION or not isinstance(entries, list):
            # Preserve the established OFF-path quarantine behavior.
            return True
        known = {
            entry.get("path")
            for entry in entries
            if isinstance(entry, dict) and isinstance(entry.get("path"), str)
        }
        additions: list[dict[str, Any]] = []
        unverified = 0
        for path in _harness_writer_snapshot_targets():
            if str(path) in known:
                continue
            if path.is_file():
                additions.append({
                    "path": str(path),
                    "existed": None,
                    "upgrade_unverified": True,
                })
                unverified += 1
            else:
                additions.append({
                    "path": str(path),
                    "existed": False,
                    "upgrade_absent": True,
                })
        if additions:
            _backup_write_manifest([*entries, *additions])
            log(
                "WARN: upgraded legacy harness-config-writer backup inventory "
                f"({len(additions)} added; {unverified} existing path(s) left "
                "unverified, no retrospective content/mode snapshot)"
            )
        else:
            log("INFO: harness-config-writer backup already present (first-enable "
                "snapshot is kept until the writer option is turned off)")
        return True
    except Exception as e:
        log(f"WARN: legacy harness-config-writer backup upgrade failed: {e}")
        return False


def _restore_path_allowed(
    path: Path,
    roots: dict[str, Path],
    managed_paths: set[Path],
) -> bool:
    """Require an exact managed target AND lexical+resolved containment.

    The exact-target check keeps a deliberately broad native root (for
    example QWEN_HOME=~ or /) from turning the manifest into permission to
    touch an entire home or filesystem. Noncanonical legacy *.env files are
    the sole exception and remain confined to ACPX/harness-env.
    """
    if not path.is_absolute():
        return False
    lexical = _absolute_native_path(path)
    env_dir = roots["acpx"] / "harness-env"
    is_extra_env = lexical.parent == env_dir and lexical.suffix == ".env"
    if lexical not in managed_paths and not is_extra_env:
        return False
    resolved = path.resolve()
    for root in roots.values():
        lexical_root = _absolute_native_path(root)
        if lexical == lexical_root or not lexical.is_relative_to(lexical_root):
            continue
        resolved_root = root.resolve()
        if resolved != resolved_root and resolved.is_relative_to(resolved_root):
            return True
    return False


def _restore_original_bytes(path: Path, content: bytes, mode: int) -> None:
    """Atomic content+mode restore; secret files never appear with a loose
    temporary mode before their original mode is applied."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".restore"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        os.chmod(tmp, stat.S_IMODE(mode))
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def restore_harness_writer_targets() -> bool:
    """Restore the first-enable snapshot (writer option OFF → original
    configs come back: existing files get their pre-enable bytes + mode,
    writer-only files are deleted). A fully verified snapshot is consumed
    (manifest removed, empty backup dir removed) so a later re-enable takes a
    FRESH snapshot of the restored state. Legacy entries whose pre-HCW
    provenance is unknowable stay unresolved and retain the manifest instead.

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
        # Exact current targets plus exact dynamic-root containment, both
        # lexical and resolved. HOME is never accepted as a general surface.
        roots = _harness_writer_native_roots()
        managed_paths = {
            _absolute_native_path(path)
            for path in harness_writer_managed_files()
        }
        restored = 0
        removed = 0
        deferred: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                continue
            path = Path(entry["path"])
            if not path.is_absolute():
                log(f"WARN: relative backup entry skipped: {entry['path']}")
                continue
            if not _restore_path_allowed(path, roots, managed_paths):
                log(f"WARN: backup entry outside managed surfaces skipped: {entry['path']}")
                continue
            if entry.get("upgrade_unverified") is True:
                # A legacy backup cannot prove whether these bytes predate
                # HCW. Leave them alone and retain the unresolved manifest so
                # re-enable cannot relabel them as a fresh operator snapshot.
                deferred.append(entry)
                continue
            if entry.get("existed") is True and isinstance(entry.get("content"), str):
                mode = entry.get("mode")
                if not isinstance(mode, int) or isinstance(mode, bool):
                    raise ValueError(f"missing/invalid original mode for {path}")
                content = base64.b64decode(entry["content"], validate=True)
                _restore_original_bytes(path, content, mode)
                restored += 1
            elif entry.get("existed") is False:
                if path.is_file() or path.is_symlink():
                    path.unlink()
                removed += 1
            else:
                raise ValueError(f"invalid backup entry state for {path}")
        if deferred:
            _backup_write_manifest(deferred)
            log(
                f"WARN: {len(deferred)} legacy upgrade path(s) have unverified "
                "pre-HCW provenance; left untouched and snapshot retained. "
                "Resolve those entries manually before a fresh re-enable snapshot."
            )
            return False
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
    "codex", "opencode", "kilo", "kilocode", "claude", "copilot", "droid", "gemini", "iflow", "kimi", "kiro", "qwen",
    # pi (2026-11-13): FILE-Mechanismus, gleiche Option-Oberfläche wie die
    # übrigen — der Harness ist lokal installiert und der add-on schreibt
    # seine native Config (models.json + settings.json).
    "pi",
)


def _writer_harness_excluded() -> set[str]:
    raw = os.environ.get("HARNESS_WRITER_EXCLUDED_AGENTS", "")
    return {
        token.strip().lower()
        for token in raw.split(",")
        if token.strip()
    }


def _gateway_default_model() -> str:
    """Gateway-Default = agents.defaults.model.primary aus openclaw.json.

    Der Provider-Prefix (z. B. "ollama/") wird abgeschnitten: der Writer
    arbeitet im Modellraum des zur baseUrl gehoerenden Providers. Ohne Default
    (leer/nicht gesetzt) bleibt das Modell unbestimmt — der Writer schreibt
    dann keinen Eintrag (kein unbrauchbares Modell erfinden).
    """
    try:
        cfg = read_json(CONFIG_DIR / "openclaw.json") or {}
        primary = (((cfg.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary")
        if not isinstance(primary, str):
            return ""
        primary = primary.strip()
        if not primary:
            return ""
        return primary.rsplit("/", 1)[-1] if "/" in primary else primary
    except Exception:
        return ""


def _writer_model_for(harness_id: str) -> str:
    """Modell-Aufloesung (2026-11-14, GaRoN-Vorgabe).

    Reihenfolge (spezifisch -> allgemein):
      1. pro-Harness-Option  harness_<id>_model  (leer -> weiter)
      2. geteilte Option    harness_model        (leer -> weiter)
      3. Gateway-Default    agents.defaults.model.primary (leer -> kein Writer-Eintrag)

    Es gibt KEINEN fest verdrahteten Default: ohne Optionen und ohne
    Gateway-Default bleibt das Modell unbestimmt, und der Helper erzeugt dann
    bewusst keinen Eintrag (statt ein unbrauchbares Modell zu schreiben).
    """
    per_harness_env = {
        "codex": "OLLAMA_CODEX_MODEL",
        "opencode": "OLLAMA_OPENCODE_MODEL",
        "claude": "OLLAMA_CLAUDE_MODEL",
        "pi": "OLLAMA_PI_MODEL",
    }.get(harness_id)
    if per_harness_env:
        # Env zur Aufrufzeit lesen (run.sh exportiert die Optionen beim Start;
        # ein Modul-Import-Zeitpunkt-Snapshot waere veraltet).
        option = os.environ.get(per_harness_env, "").strip()
        if option:
            return option
    shared = os.environ.get("HARNESS_WRITER_MODEL", "").strip()
    if shared:
        return shared
    return _gateway_default_model()


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


def deploy_plugins() -> bool:
    """Deploy harness-config-writer when its independent option is enabled.

    The retired dashboard-binding option, deployment and disable branches are
    intentionally gone. The legacy harnesses mapping is still transported on
    every ACPX initialization so existing installs do not lose their settings.
    """
    ok = True
    writer_enabled = _env_flag("HARNESS_CONFIG_WRITER_ENABLED")
    if not writer_enabled:
        log("INFO: plugin harness-config-writer deploy disabled "
            "(harness_config_writer_enabled unset/false)")

    if writer_enabled:
        ok = _deploy_and_register_plugin(HARNESS_CONFIG_WRITER_PLUGIN_NAME) and ok
        ok = backup_harness_writer_targets_once() and ok
    else:
        restore_harness_writer_targets()

    migrate_legacy_harnesses_config(enable_fresh_entry=writer_enabled)
    ok = remove_retired_binding_installation() and ok
    ok = remove_native_codex_plugin_registration() and ok
    ok = prune_native_codex_managed_project() and ok
    if writer_enabled:
        merge_addon_harness_defaults()
    return ok


def remove_legacy_codex_wrapper_artifacts() -> bool:
    """Remove only the three files left by the retired Codex wrapper layout.

    A symlink at a named path is unlinked itself, never followed. In
    particular, ACPX's own ``codex-home`` is not part of the removal set.
    """
    targets = (
        (ACPX_DIR / "codex-home-hcw", True),
        (ACPX_DIR / "codex-acp-hcw-wrapper.mjs", False),
        (ACPX_DIR / "adapter-paths.json", False),
    )
    ok = True
    for target, directory_expected in targets:
        try:
            if target.is_symlink():
                target.unlink()
            elif not target.exists():
                continue
            elif directory_expected and target.is_dir():
                # shutil.rmtree removes directory entries without following
                # symlinks that point outside the named legacy directory.
                shutil.rmtree(target)
            elif not directory_expected and target.is_file():
                target.unlink()
            else:
                log(f"WARN: legacy Codex wrapper artifact has an unexpected type; leaving it untouched: {target}")
                ok = False
                continue
        except OSError as exc:
            log(f"ERROR: could not remove legacy Codex wrapper artifact {target}: {exc}")
            ok = False
            continue
        log(f"INFO: removed legacy Codex wrapper artifact {target}")
    return ok


def migrate_retired_binding_installation() -> bool:
    """Run only the unconditional retired-plugin upgrade maintenance.

    This mode intentionally does not deploy the writer, restore/snapshot its
    targets, install npm packages, or patch ACP configuration. Direct removal
    of the retired native Codex dependency/payload is the narrow exception:
    it upgrades existing state even when ACPX is off and never creates a
    project. A fresh writer entry receives the migrated map without an enable
    decision; normal ACPX-gated deployment remains responsible for enabling.
    """
    migrate_legacy_harnesses_config(enable_fresh_entry=False)
    ok = remove_retired_binding_installation()
    ok = remove_native_codex_plugin_registration() and ok
    ok = prune_native_codex_managed_project() and ok
    return remove_legacy_codex_wrapper_artifacts() and ok


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
            ACPX_PACKAGE: OPENCLAW_ACPX_VERSION,
            PI_PACKAGE: PI_VERSION,
            COPILOT_PACKAGE: COPILOT_VERSION,
            KILO_PACKAGE: KILO_VERSION,
            QWEN_PACKAGE: QWEN_VERSION,
            GEMINI_PACKAGE: GEMINI_VERSION,
            DROID_PACKAGE: DROID_VERSION,
            IFLOW_PACKAGE: IFLOW_VERSION,
        },
    }

    if OPENCODE_VERSION.lower() not in ("none", "false", ""):
        desired_pkg["dependencies"][OPENCODE_PACKAGE] = OPENCODE_VERSION

    need_install = False
    current_deps = {}
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

    if not isinstance(current_deps, dict):
        current_deps = {}
    # Removed direct dependencies must be pruned as well as new ones installed.
    # Check the previous direct-dependency set, not every transitive package in
    # node_modules. npm install prunes these obsolete entries after the desired
    # manifest is written; the post-install check below proves they are gone.
    extraneous_deps = set(current_deps) - set(desired_pkg["dependencies"])
    removed_native_codex = "@openclaw/codex"
    if (PROJECT_DIR / "node_modules" / Path(removed_native_codex)).exists():
        # Also catch a partially upgraded manifest whose old payload survived.
        extraneous_deps.add(removed_native_codex)
    extraneous_deps = sorted(extraneous_deps)
    if extraneous_deps:
        log("Obsolete managed npm dependencies require pruning: " + ", ".join(extraneous_deps))
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
    if not need_install:
        for executable in _required_harness_executables().values():
            if not (PROJECT_DIR / "node_modules" / ".bin" / executable).is_file():
                log(f"harness executable incomplete ({executable} missing); reinstalling")
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
                env=_image_node_subprocess_env(),
            )
            if result.returncode != 0:
                log(f"ERROR: npm install failed:\n{result.stderr}")
                # Do not raise; run.sh surfaces the failure via the exit code
                return False
            remaining_obsolete = [
                dep for dep in extraneous_deps
                if (PROJECT_DIR / "node_modules" / Path(dep)).exists()
            ]
            if remaining_obsolete:
                log("ERROR: npm install left obsolete managed packages installed: "
                    + ", ".join(remaining_obsolete))
                return False
            if "@openclaw/codex" in extraneous_deps:
                log("INFO: native Codex plugin removed from the managed npm project; "
                    "Codex ACP adapter and native writer configuration preserved")
            missing = [
                dep for dep in desired_pkg["dependencies"]
                if not (PROJECT_DIR / "node_modules" / Path(dep)).is_dir()
            ]
            if missing:
                log("ERROR: npm install completed without all pinned packages: "
                    + ", ".join(missing))
                return False
            log("ACPX npm project and persistent harness CLIs installed successfully")
            published = _publish_persistent_harness_bins()
            _detect_unmanaged_harness_clis()
            return published
        except subprocess.TimeoutExpired:
            log("ERROR: npm install timed out after 10 minutes")
            return False
        except Exception as e:
            log(f"ERROR: npm install raised exception: {e}")
            return False
    else:
        log("ACPX npm project and persistent harness CLIs already up to date")
        published = _publish_persistent_harness_bins()
        _detect_unmanaged_harness_clis()
        return published


def _required_harness_executables() -> dict[str, str]:
    required = dict(HARNESS_EXECUTABLES)
    if OPENCODE_VERSION.lower() in ("none", "false", ""):
        required.pop("opencode", None)
    return required


def _publish_persistent_harness_bins() -> bool:
    """Expose verified harness commands on the add-on's persistent PATH.

    Existing operator binaries and symlinks win. Only missing links are
    created, making this step restart- and restore-safe without taking over a
    separately installed vendor CLI.
    """
    ok = True
    try:
        PERSISTENT_BIN_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log(f"ERROR: persistent harness bin directory unavailable: {e}")
        return False
    project_bin = PROJECT_DIR / "node_modules" / ".bin"
    for harness_id, executable in _required_harness_executables().items():
        source = project_bin / executable
        if not source.is_file():
            log(f"ERROR: {harness_id} executable missing after npm install: {source}")
            ok = False
            continue
        target = PERSISTENT_BIN_DIR / executable
        if target.is_symlink() and os.readlink(target) == str(source):
            continue
        if target.exists() or target.is_symlink():
            log(f"INFO: preserving existing operator {harness_id} executable: {target}")
            continue
        try:
            target.symlink_to(source)
            log(f"Published persistent {harness_id} CLI: {target} -> {source}")
        except OSError as e:
            log(f"ERROR: could not publish {harness_id} CLI at {target}: {e}")
            ok = False
    return ok


def _detect_unmanaged_harness_clis() -> None:
    """Detect harnesses for which no vendor npm package could be verified.

    ACPX invokes Kiro as `kiro-cli acp`. The public `kiro-cli` npm artifact is
    only a placeholder with a different executable (`kirox`), so installing it
    would be an unsafe guess. Detect the vendor executable instead and make a
    missing installation visible without blocking the other harnesses.
    """
    project_bin = PROJECT_DIR / "node_modules" / ".bin" / "kiro-cli"
    resolved = shutil.which("kiro-cli")
    if resolved or project_bin.is_file():
        log(f"INFO: Kiro CLI detected at {resolved or project_bin}")
        return
    log("WARNING: Kiro harness unavailable: vendor executable 'kiro-cli' was "
        "not found on PATH. No verified vendor npm package exists; install "
        "Kiro CLI through the vendor-supported channel and retry.")


def patch_openclaw_config() -> bool:
    """Ensure the top-level acp section exists with a sane backend.

    This function does NOT create agent roster entries. In particular, the
    coordinator remains an onboarding-owned default. When an operator already
    has a coordinator entry, only its subagents.allowAgents list is unioned
    with the reference workers; every other coordinator field is preserved.

    The config itself is NOT created here — run.sh is the single bootstrap
    owner (first start only, random per-install token, per-mode port).
    The only edits we make to openclaw.json are:
      - Set acp.enabled = true if it is missing/false.
      - Set acp.backend = 'acpx' if it is missing.
      - Ensure acp.allowedAgents contains the four reference workers.
      - If agents.entries.coordinator already exists, union the same workers
        into its subagents.allowAgents without creating the coordinator.
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

    raw_allowed = acp.get("allowedAgents", [])
    if raw_allowed is None:
        raw_allowed = []
    if not isinstance(raw_allowed, list):
        log("WARN: acp.allowedAgents is not a list; leaving config untouched")
        return False
    # Union, never replace: operator entries stay in their original order.
    # The add-on contributes exactly the four reference workers; `openclaw`
    # and a coordinator are not add-on roster entries.
    extra_raw = os.environ.get("ACP_ADDITIONAL_ALLOWED_AGENTS", "")
    extra_allowed = {a.strip() for a in extra_raw.split(",") if a.strip()}
    desired_allowed = REFERENCE_WORKER_AGENTS | extra_allowed
    allowed = {a for a in raw_allowed if isinstance(a, str)}
    merged_allowed = [*raw_allowed, *sorted(desired_allowed - allowed)]
    if merged_allowed != raw_allowed:
        acp["allowedAgents"] = merged_allowed
        changed = True

    agents = cfg.get("agents")
    entries = agents.get("entries") if isinstance(agents, dict) else None
    coordinator = entries.get("coordinator") if isinstance(entries, dict) else None
    if isinstance(coordinator, dict):
        subagents = coordinator.get("subagents")
        if subagents is None:
            subagents = {}
            coordinator["subagents"] = subagents
        if not isinstance(subagents, dict):
            log("WARN: coordinator.subagents is not an object; leaving config untouched")
            return False
        raw_subagent_allowed = subagents.get("allowAgents", [])
        if raw_subagent_allowed is None:
            raw_subagent_allowed = []
        if not isinstance(raw_subagent_allowed, list):
            log("WARN: coordinator.subagents.allowAgents is not a list; leaving config untouched")
            return False
        subagent_allowed = {a for a in raw_subagent_allowed if isinstance(a, str)}
        merged_subagents = [
            *raw_subagent_allowed,
            *sorted(desired_allowed - subagent_allowed),
        ]
        if merged_subagents != raw_subagent_allowed:
            subagents["allowAgents"] = merged_subagents
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

def _esbuild_node_target() -> str:
    """Return the esbuild target for the Node line the image actually runs.

    The image derives its Node line from OpenClaw's engine range, so a fixed
    target would emit syntax the running Node cannot parse as soon as that
    line moves. Without a readable Node version the conservative default is
    used and the mismatch is logged.
    """
    node = os.environ.get("OPENCLAW_NODE_BIN") or "/usr/bin/node"
    version = ""
    try:
        proc = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15
        )
        version = (proc.stdout or "").strip().lstrip("v")
    except (OSError, subprocess.SubprocessError):
        version = ""
    major = version.split(".")[0]
    if major.isdigit():
        return f"node{major}"
    log(
        f"WARN: could not read the Node version from {node}; "
        "bundling for the conservative node26 target"
    )
    return "node26"


def remove_stale_acpx_agent_overrides() -> bool:
    """Drop ACPX agent overrides whose target file does not exist.

    ACPX itself only *reads* ``plugins.entries.acpx.config.agents`` as an
    override; it generates its own wrapper scripts and falls back to its own
    default when no override is configured. The stale overrides come from the
    retired harness-config-writer codex wrapper of this add-on, which wrote
    ``agents.codex.command`` pointing at a file that the add-on cleanup
    removes. As long as such an override exists it takes precedence over the
    ACPX default ("Configured ACP agent commands take precedence over
    installed defaults") and the Codex harness never comes up.

    Safety rules (2026-11-27 review):
    * only overrides whose absolute target file is missing are removed - a
      valid override (and everything else in the config) stays untouched,
    * a relative command is never touched - its existence cannot be judged
      without knowing the working directory it is resolved against,
    * the configuration is backed up before the first write, so the cleanup is
      always reversible.
    """
    config_path = CONFIG_DIR / "openclaw.json"
    if not config_path.exists():
        return True
    try:
        data = read_json(config_path)
    except (OSError, json.JSONDecodeError) as exc:
        log(f"ERROR: could not read {config_path}: {exc}")
        return False
    config = data.get("plugins", {}).get("entries", {}).get("acpx", {}).get("config", {})
    agents = config.get("agents")
    if not isinstance(agents, dict) or not agents:
        return True
    changed = False
    for agent_id, entry in list(agents.items()):
        if not isinstance(entry, dict):
            continue
        command = entry.get("command")
        if not isinstance(command, str) or not command:
            continue
        if not os.path.isabs(command):
            log(
                f"WARN: ACPX agent command for '{agent_id}' is relative ({command}); "
                "left untouched because its target cannot be resolved reliably"
            )
            continue
        if Path(command).exists():
            continue
        # The override points at a file that does not exist, so it can only
        # break the harness. ACPX generates its own wrapper scripts and
        # falls back to its own default when no override is configured, so the
        # stale override is dropped as a whole - its arguments belong to the
        # missing wrapper. Such overrides were written by the retired
        # harness-config-writer codex wrapper of this add-on.
        # Only the key names: an override can carry credentials, and those
        # must not end up in the add-on log.
        removed = ", ".join(sorted(entry.keys()))
        agents.pop(agent_id, None)
        log(
            f"WARN: removed the stale ACPX agent override for '{agent_id}' "
            f"(target {command} does not exist); ACPX uses its own default again. "
            f"Removed: {removed}."
        )
        changed = True
    if changed:
        try:
            backup = config_path.with_name(
                f"{config_path.name}.pre-acpx-cleanup-{int(time.time())}"
            )
            shutil.copy2(config_path, backup)
            log(f"Backed up the OpenClaw configuration to {backup}")
            prune_acpx_cleanup_backups(config_path)
        except OSError as exc:
            log(f"ERROR: could not back up the OpenClaw configuration: {exc}")
            return False
        try:
            write_json(config_path, data)
        except OSError as exc:
            log(f"ERROR: could not write the repaired ACPX agent commands: {exc}")
            return False
    return True


def prune_acpx_cleanup_backups(config_path: Path, keep: int = 3) -> None:
    """Keep only the newest cleanup backups.

    Every boot that changes something writes a copy of openclaw.json. Without
    a bound the configuration directory grows with one copy per cleanup.
    """
    try:
        backups = sorted(
            [
                path
                for pattern in (
                    f"{config_path.name}.pre-acpx-cleanup-*",
                    # backups of the earlier repair naming
                    f"{config_path.name}.pre-acpx-repair-*",
                )
                for path in config_path.parent.glob(pattern)
            ],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for stale in backups[keep:]:
        try:
            stale.unlink()
            log(f"Removed the outdated repair backup {stale}")
        except OSError as exc:
            log(f"WARN: could not remove the outdated repair backup {stale}: {exc}")


def main() -> int:
    if sys.argv[1:] == ["--migrate-retired-binding"]:
        log("Migrating/removing retired dashboard binding (ACPX-independent upgrade maintenance)")
        return 0 if migrate_retired_binding_installation() else 1
    if len(sys.argv) > 1:
        log(f"ERROR: unknown arguments: {' '.join(sys.argv[1:])}")
        return 2

    # run.sh invokes this full mode only when the acpx_enabled master gate is on.
    # ACPX infrastructure is always prepared in that case; HCW remains an
    # independent opt-in and the retired binding plugin has no branch here.
    log("Initializing acp(x) components (config-writer self-gated; ACPX infra always on)")
    deploy_harness_configs()  # retired no-op (kept for the stable surface)
    ok = deploy_plugins()
    ok = install_acpx_npm_project() and ok
    ok = patch_openclaw_config() and ok
    ok = remove_stale_acpx_agent_overrides() and ok
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
