#!/usr/bin/env python3
"""Regression tests for HCW deployment, persistent harnesses and ACP roster.

Only harness-config-writer is bundled. The legacy dashboard-binding harnesses
mapping remains solely as a data-migration source for existing installations.
Run with:

    python3 -m unittest discover -s openclaw_ha_addon/tests -v
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

import oc_acpx_helper as helper  # noqa: E402


def write_minimal_plugin_source(src: Path) -> None:
    """Create only HCW: this is the plugin-source probe regression fixture."""
    name = helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
    (src / name / "src").mkdir(parents=True)
    (src / name / "openclaw.plugin.json").write_text('{"id": "' + name + '"}')
    (src / name / "package.json").write_text('{"name": "' + name + '"}')


class DeployPluginsEnabledOptionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src_root = Path(self.tmp.name) / "plugins"
        write_minimal_plugin_source(self.src_root)
        self.config_dir = Path(self.tmp.name) / "config"
        self.config_dir.mkdir()
        (self.config_dir / "openclaw.json").write_text(json.dumps({"agents": {"entries": {}}}))
        patches = (
            mock.patch.object(helper, "PLUGIN_SRC_DIR", self.src_root),
            mock.patch.object(helper, "PLUGIN_SRC_FALLBACK_DIRS", (self.src_root,)),
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
            mock.patch.object(helper, "ACPX_DIR", self.config_dir / "acpx"),
            mock.patch.object(helper, "CODEX_SOURCE_HOME", self.config_dir / ".codex"),
            mock.patch.object(helper, "OPENCODE_GLOBAL_DIR", self.config_dir / "opencode"),
            mock.patch.object(helper, "CLAUDE_SOURCE_HOME", self.config_dir / ".claude"),
            mock.patch.object(helper, "PI_AGENT_DIR", self.config_dir / ".pi" / "agent"),
            mock.patch.dict(os.environ, {
                "HOME": str(self.config_dir),
                "XDG_CONFIG_HOME": str(self.config_dir),
            }, clear=True),
            mock.patch.object(helper, "BUNDLED_EXTENSIONS_DIR",
                              Path(self.tmp.name) / "dist" / "extensions"),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        for key in (
            "HARNESS_CONFIG_WRITER_ENABLED",
            "HARNESS_WRITER_BASE_URL",
            "HARNESS_WRITER_MODEL",
            "HARNESS_WRITER_API_KEY",
            "HARNESS_WRITER_EXCLUDED_AGENTS",
            "OLLAMA_CODEX_MODEL",
            "OLLAMA_OPENCODE_MODEL",
        ):
            os.environ.pop(key, None)

    def read_entry(self, plugin_name: str | None = None) -> dict:
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        return (
            cfg.get("plugins", {})
            .get("entries", {})
            .get(plugin_name or helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME, {})
        )

    def write_config(self, plugins_cfg: dict) -> None:
        (self.config_dir / "openclaw.json").write_text(json.dumps(plugins_cfg))

    def test_only_hcw_is_bundled(self) -> None:
        self.assertEqual(
            helper.BUNDLED_PLUGIN_NAMES,
            [helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME],
        )

    def test_option_unset_defaults_off_and_deploys_nothing(self) -> None:
        os.environ.pop("HARNESS_CONFIG_WRITER_ENABLED", None)
        self.assertTrue(helper.deploy_plugins())
        self.assertFalse(
            (self.config_dir / "plugins"
             / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).exists()
        )
        self.assertNotIn("enabled", self.read_entry())

    def test_option_true_deploys_hcw_with_only_hcw_source_present(self) -> None:
        """Probe regression: no retired plugin directory exists in the root."""
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertEqual(
            helper.resolve_plugin_src_dir(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME),
            self.src_root,
        )
        self.assertTrue(helper.deploy_plugins())
        dst = self.config_dir / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        self.assertTrue((dst / "openclaw.plugin.json").is_file())
        self.assertTrue(self.read_entry().get("enabled") is True)
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        self.assertIn(str(self.config_dir / "plugins"), cfg["plugins"]["load"]["paths"])

    def test_missing_hcw_source_fails_loudly_negative_control(self) -> None:
        shutil.rmtree(self.src_root / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME)
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        with mock.patch.object(helper, "log") as logged:
            self.assertFalse(helper.deploy_plugins())
        messages = "\n".join(str(call) for call in logged.call_args_list)
        self.assertIn("harness-config-writer", messages)
        self.assertIn("WARNING", messages)
        self.assertFalse(self.read_entry().get("enabled", False))

    def test_option_enabled_is_case_insensitive_and_idempotent(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "TRUE"
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(self.read_entry().get("enabled") is True)

    def test_writer_respects_operator_opt_out_enabled_false(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.write_config({"plugins": {"entries": {
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {"enabled": False},
        }}})
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        self.assertIs(
            cfg["plugins"]["entries"][helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["enabled"],
            False,
        )

    def test_allowlist_absent_is_never_created(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        self.assertIsNone(cfg["plugins"].get("allow"))
        self.assertTrue(self.read_entry().get("enabled") is True)

    def test_allowlist_existing_gets_id_unioned(self) -> None:
        self.write_config({"plugins": {"allow": ["ollama", "telegram"]}})
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        allow = cfg["plugins"]["allow"]
        self.assertIn(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME, allow)
        self.assertIn("ollama", allow)
        self.assertIn("telegram", allow)

    def test_allowlist_idempotent(self) -> None:
        self.write_config({"plugins": {"allow": [
            "ollama", helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME,
        ]}})
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        self.assertEqual(
            cfg["plugins"]["allow"].count(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME), 1,
        )

    def test_legacy_harnesses_key_is_migrated_even_when_writer_is_off(self) -> None:
        os.environ.pop("HARNESS_CONFIG_WRITER_ENABLED", None)
        legacy = {"codex": {"model": "m1", "baseUrl": "http://ollama.internal:11434"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {
                "allow": ["operator-plugin", helper.LEGACY_BINDING_PLUGIN_NAME],
                "entries": {helper.LEGACY_BINDING_PLUGIN_NAME: {
                    "enabled": True, "config": {"harnesses": legacy},
                }},
            },
            "channels": {helper.LEGACY_BINDING_PLUGIN_NAME: {"enabled": True}},
        }))
        payload = self.config_dir / "plugins" / helper.LEGACY_BINDING_PLUGIN_NAME
        payload.mkdir(parents=True)
        (payload / "index.mjs").write_text("retired")
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        entries = cfg["plugins"]["entries"]
        self.assertEqual(
            entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["config"]["harnesses"],
            legacy,
        )
        self.assertNotIn("enabled", entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME])
        self.assertNotIn(helper.LEGACY_BINDING_PLUGIN_NAME, entries)
        self.assertFalse(payload.exists())
        self.assertNotIn(helper.LEGACY_BINDING_PLUGIN_NAME, cfg["plugins"]["allow"])
        self.assertIn("operator-plugin", cfg["plugins"]["allow"])
        self.assertNotIn(helper.LEGACY_BINDING_PLUGIN_NAME, cfg["channels"])

    def test_legacy_migration_not_touched_when_authoritative_new_key_exists(self) -> None:
        legacy = {"codex": {"model": "old"}}
        newer = {"codex": {"model": "new"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.LEGACY_BINDING_PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
                helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {
                    "enabled": True, "config": {"harnesses": newer},
                },
            }},
        }))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        entries = cfg["plugins"]["entries"]
        self.assertEqual(
            entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["config"]["harnesses"], newer,
        )
        self.assertEqual(
            entries[helper.LEGACY_BINDING_PLUGIN_NAME]["config"]["harnesses"], legacy,
        )
        self.assertIs(entries[helper.LEGACY_BINDING_PLUGIN_NAME]["enabled"], False)

    # --- Backup-Rewrite (GaRoN 2026-10-11) ----------------------------------

    def _seed_user_codex_config(self) -> None:
        """A pre-enable user config that the backup must capture verbatim."""
        codex_dir = self.config_dir / ".codex"
        codex_dir.mkdir()
        (codex_dir / "config.toml").write_text("model = \"user-own\"\n")

    def _seed_writer_generated_state(self) -> None:
        """Simulate what the TS writer would do at gateway boot: overwrite the
        (non-customized) codex config and drop writer-only env files."""
        codex_dir = self.config_dir / ".codex"
        (codex_dir / "config.toml").write_text("model = \"writer-generated\"\n")
        env_dir = self.config_dir / "acpx" / "harness-env"
        env_dir.mkdir(parents=True)
        (env_dir / "claude.env").write_text("ANTHROPIC_MODEL='x'\n")

    def test_first_enable_takes_snapshot_of_pre_writer_state(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self._seed_user_codex_config()
        self.assertTrue(helper.deploy_plugins())
        manifest_path = (
            self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json"
        )
        self.assertTrue(manifest_path.is_file())
        manifest = json.loads(manifest_path.read_text())
        by_path = {e["path"]: e for e in manifest["files"]}
        user_toml = str(self.config_dir / ".codex" / "config.toml")
        self.assertTrue(by_path[user_toml]["existed"])
        self.assertIn("user-own", base64.b64decode(by_path[user_toml]["content"]).decode(), "content captured")
        claude_env = str(self.config_dir / "acpx" / "harness-env" / "claude.env")
        self.assertFalse(by_path[claude_env]["existed"], "absent targets recorded")
        # Idempotent: a second enabled boot must NOT re-snapshot (the first
        # snapshot stays authoritative and can never capture writer output).
        self._seed_writer_generated_state()
        self.assertTrue(helper.deploy_plugins())
        manifest = json.loads(manifest_path.read_text())
        by_path = {e["path"]: e for e in manifest["files"]}
        self.assertIn(
            "user-own",
            base64.b64decode(by_path[user_toml]["content"]).decode(),
            "snapshot must stay the first-enable pre-writer state",
        )

    def test_disable_restores_originals_and_consumes_snapshot(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self._seed_user_codex_config()
        self.assertTrue(helper.deploy_plugins())
        self._seed_writer_generated_state()
        # Operator turns the writer option OFF:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        toml_path = self.config_dir / ".codex" / "config.toml"
        self.assertEqual(toml_path.read_text(), "model = \"user-own\"\n",
                         "original config restored verbatim")
        env_file = self.config_dir / "acpx" / "harness-env" / "claude.env"
        self.assertFalse(env_file.exists(),
                         "writer-only env file deleted on restore")
        manifest_path = (
            self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json"
        )
        self.assertFalse(manifest_path.exists(),
                         "snapshot consumed after a successful restore")

    def test_re_enable_takes_fresh_snapshot_of_restored_state(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self._seed_user_codex_config()
        self.assertTrue(helper.deploy_plugins())
        self._seed_writer_generated_state()
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        # Cycle round 2: enable again — the fresh snapshot is of the restored
        # (operator) state, NOT of any writer residue.
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        manifest_path = (
            self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json"
        )
        manifest = json.loads(manifest_path.read_text())
        user_toml = str(self.config_dir / ".codex" / "config.toml")
        by_path = {e["path"]: e for e in manifest["files"]}
        self.assertTrue(by_path[user_toml]["existed"])
        self.assertIn(
            "user-own",
            base64.b64decode(by_path[user_toml]["content"]).decode(),
            "fresh snapshot of the restored user state",
        )

    def test_expanded_surface_restores_existing_bytes_modes_and_synthetic_credentials(self) -> None:
        """Every current/legacy target round-trips arbitrary bytes and mode.
        Auth and env fixtures contain synthetic credentials only."""
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        managed = helper.harness_writer_managed_files()
        self.assertEqual(len(managed), 42, "inventory must track the complete HCW surface")
        originals: dict[Path, tuple[bytes, int]] = {}
        for index, path in enumerate(managed):
            path.parent.mkdir(parents=True, exist_ok=True)
            content = f"operator-{index}".encode() + b"\x00\xff\n"
            if path.name == "auth.json":
                content = b'{"OPENAI_API_KEY":"synthetic-original-auth"}\n\x00'
            elif path.suffix == ".env":
                content = b"API_KEY='synthetic-original-env'\n\x00"
            mode = (0o600, 0o640, 0o664)[index % 3]
            path.write_bytes(content)
            path.chmod(mode)
            originals[path] = (content, mode)

        self.assertTrue(helper.deploy_plugins())
        manifest_path = self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json"
        by_path = {
            entry["path"]: entry
            for entry in json.loads(manifest_path.read_text())["files"]
        }
        codex_auth = self.config_dir / ".codex" / "auth.json"
        qwen_env = self.config_dir / "acpx" / "harness-env" / "qwen.env"
        for secret_path in (codex_auth, qwen_env):
            entry = by_path[str(secret_path)]
            self.assertEqual(base64.b64decode(entry["content"]), originals[secret_path][0])
            self.assertEqual(entry["mode"], originals[secret_path][1])

        for path in managed:
            path.write_bytes(b"writer-generated\n")
            path.chmod(0o600)
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        for path, (content, mode) in originals.items():
            self.assertEqual(path.read_bytes(), content, str(path))
            self.assertEqual(path.stat().st_mode & 0o777, mode, str(path))

    def test_absent_expanded_targets_are_deleted_on_off_including_sidecars(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        managed = helper.harness_writer_managed_files()
        for path in managed:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"writer-created\n")
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        for path in managed:
            self.assertFalse(path.exists(), f"writer-created file survived OFF: {path}")
        self.assertFalse(
            (self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json").exists()
        )

    def test_full_native_lifecycle_off_then_reenable_takes_fresh_snapshot(self) -> None:
        """Isolated integration with the REAL TS dispatcher: first enable →
        native deployment → OFF restore → re-enable fresh snapshot → OFF."""
        node = shutil.which("node")
        if not node:
            self.skipTest("Node with TypeScript stripping is required for native dispatch")
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        managed = helper.harness_writer_managed_files()
        roots = helper._harness_writer_native_roots()
        existing = (
            roots["codex"] / "auth.json",
            roots["kilo"] / "kilo.json",
            roots["qwen"] / "settings.json",
            roots["gemini"] / "settings.json",
            roots["kimi"] / "config.toml",
            roots["acpx"] / "harness-env" / "claude.env",
        )
        original_content = (
            b'{"OPENAI_API_KEY":"synthetic-original-auth"}\n',
            b'{"operator":"kilo"}\n',
            b'{"operator":"qwen"}\n',
            b'{"operator":"gemini"}\n',
            b'default_model = "operator-kimi"\n',
            b"ANTHROPIC_AUTH_TOKEN='synthetic-original-env'\n",
        )
        originals = dict(zip(existing, original_content))
        for path, content in originals.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            path.chmod(0o640)

        def native_deploy() -> dict:
            paths = {
                "acpxDir": str(roots["acpx"]),
                "codexSourceHome": str(roots["codex"]),
                "opencodeGlobalDir": str(roots["opencode"]),
                "claudeSourceHome": str(roots["claude"]),
                "piAgentDir": str(roots["pi"]),
                "kiloGlobalDir": str(roots["kilo"]),
                "qwenHome": str(roots["qwen"]),
                "nativeHomes": {
                    harness_id: str(roots[harness_id])
                    for harness_id in ("gemini", "copilot", "iflow", "droid", "kiro", "kimi")
                },
            }
            harnesses = {
                harness_id: {
                    "model": "synthetic-model",
                    "baseUrl": "http://127.0.0.1:11434",
                    "apiKey": "synthetic-credential",
                }
                for harness_id in helper.KNOWN_WRITER_HARNESS_IDS
            }
            writer = REPO / "plugins" / "harness-config-writer" / "src" / "harness-config-writer.ts"
            script = (
                f"import {{ deployHarnessConfigs }} from {json.dumps(writer.as_uri())};\n"
                "const input = JSON.parse(process.env.HCW_TEST_INPUT);\n"
                "const report = deployHarnessConfigs({harnesses: input.harnesses}, input.paths);\n"
                "console.log(JSON.stringify(report));\n"
            )
            proc = subprocess.run(
                [node, "--experimental-strip-types", "--input-type=module", "-"],
                input=script,
                text=True,
                capture_output=True,
                env={**os.environ, "HCW_TEST_INPUT": json.dumps({"paths": paths, "harnesses": harnesses})},
                timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            reported = {
                Path(file["path"])
                for result in report["results"]
                for file in result["files"]
            }
            self.assertTrue(reported.issubset(set(managed)), "helper inventory missed a real HCW write")
            return report

        self.assertTrue(helper.deploy_plugins())  # first enable
        native_deploy()
        for path in (
            roots["codex"] / "auth.json",
            roots["kilo"] / "kilo.json.hcw-managed.json",
            roots["qwen"] / "settings.json.hcw-managed.json",
            roots["kimi"] / "config.toml",
            roots["gemini"] / "settings.json.hcw-managed.json",
            roots["copilot"] / "settings.json.hcw-managed.json",
            roots["iflow"] / "settings.json.hcw-managed.json",
            roots["droid"] / "settings.json.hcw-managed.json",
            roots["kiro"] / "settings" / "cli.json.hcw-managed.json",
        ):
            self.assertTrue(path.is_file(), f"real native deployment did not write {path}")
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())  # OFF restore
        for path in managed:
            if path in originals:
                self.assertEqual(path.read_bytes(), originals[path])
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            else:
                self.assertFalse(path.exists(), str(path))

        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())  # fresh snapshot
        manifest_path = self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json"
        by_path = {
            entry["path"]: entry
            for entry in json.loads(manifest_path.read_text())["files"]
        }
        for path in managed:
            entry = by_path[str(path)]
            if path in originals:
                self.assertIs(entry["existed"], True)
                self.assertEqual(base64.b64decode(entry["content"]), originals[path])
            else:
                self.assertIs(entry["existed"], False)
                self.assertNotIn("content", entry)
        native_deploy()
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        for path, content in originals.items():
            self.assertEqual(path.read_bytes(), content)
        for path in set(managed) - set(originals):
            self.assertFalse(path.exists(), str(path))

    def test_legacy_backup_upgrade_never_snapshots_existing_expanded_output(self) -> None:
        """An old backup can gain absent targets, but existing new targets
        have unknowable provenance and must never be captured as originals."""
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        roots = helper._harness_writer_native_roots()
        legacy_path = roots["codex"] / "config.toml"
        legacy_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_path.write_bytes(b"legacy-original\n")
        legacy_entry = {
            "path": str(legacy_path),
            "existed": True,
            "mode": 0o640,
            "content": base64.b64encode(b"legacy-original\n").decode("ascii"),
        }
        helper._backup_write_manifest([legacy_entry])
        ambiguous = roots["qwen"] / "settings.json"
        ambiguous.parent.mkdir(parents=True, exist_ok=True)
        ambiguous.write_bytes(b"possibly-existing-hcw-output\n")
        absent_at_upgrade = roots["kilo"] / "kilo.json.hcw-managed.json"

        self.assertTrue(helper.backup_harness_writer_targets_once())
        manifest_path = self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json"
        by_path = {
            entry["path"]: entry
            for entry in json.loads(manifest_path.read_text())["files"]
        }
        self.assertIsNone(by_path[str(ambiguous)]["existed"])
        self.assertIs(by_path[str(ambiguous)]["upgrade_unverified"], True)
        self.assertNotIn("content", by_path[str(ambiguous)])
        self.assertNotIn("mode", by_path[str(ambiguous)])
        self.assertIs(by_path[str(absent_at_upgrade)]["existed"], False)
        self.assertEqual(base64.b64decode(by_path[str(legacy_path)]["content"]), b"legacy-original\n")

        legacy_path.write_bytes(b"writer-output\n")
        absent_at_upgrade.parent.mkdir(parents=True, exist_ok=True)
        absent_at_upgrade.write_bytes(b"writer-created-sidecar\n")
        self.assertFalse(helper.restore_harness_writer_targets())
        self.assertEqual(legacy_path.read_bytes(), b"legacy-original\n")
        self.assertEqual(legacy_path.stat().st_mode & 0o777, 0o640)
        self.assertFalse(absent_at_upgrade.exists())
        self.assertEqual(ambiguous.read_bytes(), b"possibly-existing-hcw-output\n")
        retained = json.loads(manifest_path.read_text())["files"]
        self.assertEqual([entry["path"] for entry in retained], [str(ambiguous)])
        self.assertNotIn("content", retained[0])
        # Re-enable keeps the unresolved entry; it cannot become a fresh
        # snapshot of bytes that may have been written by HCW.
        self.assertTrue(helper.backup_harness_writer_targets_once())
        retained_again = {
            entry["path"]: entry
            for entry in json.loads(manifest_path.read_text())["files"]
        }
        self.assertIsNone(retained_again[str(ambiguous)]["existed"])
        self.assertNotIn("content", retained_again[str(ambiguous)])

    def test_legacy_backup_upgrade_with_absent_new_targets_completes_off(self) -> None:
        legacy_path = self.config_dir / ".codex" / "config.toml"
        helper._backup_write_manifest([{
            "path": str(legacy_path), "existed": False,
        }])
        self.assertTrue(helper.backup_harness_writer_targets_once())
        for path in helper.harness_writer_managed_files():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"post-upgrade-writer-output\n")
        self.assertTrue(helper.restore_harness_writer_targets())
        for path in helper.harness_writer_managed_files():
            self.assertFalse(path.exists(), str(path))
        self.assertFalse(
            (self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME / "manifest.json").exists()
        )

    def test_restore_rejects_home_and_symlink_escape_even_with_qwen_home_set_to_home(self) -> None:
        os.environ["QWEN_HOME"] = "~"
        home_file = self.config_dir / "operator-notes.txt"
        home_file.write_bytes(b"do-not-touch\n")
        outside = Path(self.tmp.name) / "outside.txt"
        outside.write_bytes(b"also-do-not-touch\n")
        qwen_settings = self.config_dir / "settings.json"
        qwen_settings.symlink_to(outside)
        unmanaged = self.config_dir / "unmanaged.json"
        unmanaged.write_bytes(b"unmanaged-survives\n")
        helper._backup_write_manifest([
            {"path": str(home_file), "existed": False},
            {"path": str(qwen_settings), "existed": False},
            {"path": str(unmanaged), "existed": False},
        ])
        self.assertTrue(helper.restore_harness_writer_targets())
        self.assertEqual(home_file.read_bytes(), b"do-not-touch\n")
        self.assertTrue(qwen_settings.is_symlink(), "resolved escape must not be unlinked")
        self.assertEqual(outside.read_bytes(), b"also-do-not-touch\n")
        self.assertEqual(unmanaged.read_bytes(), b"unmanaged-survives\n")

    def test_restore_is_noop_without_snapshot(self) -> None:
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        self.assertFalse(
            (self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME).exists()
        )

    def test_restore_quarantines_corrupt_manifest_and_fails_soft(self) -> None:
        """Corrupt manifest: moved aside as .corrupt (payload preserved for
        manual rescue), NOTHING restored, NOTHING re-snapshotted, deploy is
        fail-soft. Identical treatment for parse-error and wrong-shape paths
        (audit consistency note) — parse-error case asserted here."""
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self._seed_user_codex_config()
        self.assertTrue(helper.deploy_plugins())
        self._seed_writer_generated_state()
        backup_dir = self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME
        manifest = backup_dir / "manifest.json"
        manifest.write_text("{not json at all")
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        self.assertFalse(manifest.exists(), "stale manifest moved aside")
        self.assertTrue((backup_dir / "manifest.json.corrupt").is_file())
        # Nothing applied: the (simulated) writer output survives untouched
        # because restore must not act on a quarantined snapshot.
        toml_path = self.config_dir / ".codex" / "config.toml"
        self.assertEqual(toml_path.read_text(), "model = \"writer-generated\"\n")
        # No re-snapshot while the option stays off:
        self.assertFalse(
            ((self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME)
             / "manifest.json").exists()
        )

    def test_re_snapshot_refused_while_quarantine_unresolved(self) -> None:
        """Re-audit hint: after a quarantine the corrupt marker blocks a new
        snapshot (writer-generated state must never leak into a fresh
        first-enable backup) until the operator resolves the .corrupt file."""
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self._seed_user_codex_config()
        self.assertTrue(helper.deploy_plugins())
        backup_dir = self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME
        (backup_dir / "manifest.json").write_text("{bad")
        # Simulated post-quarantine writer-ON boot: the corrupt marker must
        # veto the snapshot (writer output would otherwise be captured):
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())  # restore cycle → quarantine
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        ok = helper.deploy_plugins()
        self.assertFalse(ok, "quarantine unresolved: backup refuses (fail-soft)")
        self.assertFalse(
            (backup_dir / "manifest.json").exists(),
            "no fresh manifest while .corrupt is unresolved",
        )
        self.assertTrue((backup_dir / "manifest.json.corrupt").is_file())

    def test_backup_manifest_and_dir_are_secret_tight(self) -> None:
        """Audit H4: manifest 0600 (holds base64 secrets), backup dir 0700."""
        os.umask(0o022)
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self._seed_user_codex_config()
        self.assertTrue(helper.deploy_plugins())
        backup_dir = self.config_dir / helper.HARNESS_WRITER_BACKUP_DIR_NAME
        self.assertEqual(os.stat(backup_dir).st_mode & 0o777, 0o700)
        manifest = backup_dir / "manifest.json"
        self.assertEqual(os.stat(manifest).st_mode & 0o777, 0o600)

    def test_legacy_migration_respects_writer_operator_opt_out(self) -> None:
        """Audit B3: pre-existing writer entry with enabled:false is NEVER
        flipped by the legacy migration — the harnesses CONFIG is still
        transported (data move, not an enable decision) and the legacy key is
        still removed."""
        legacy = {"codex": {"model": "m1"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.LEGACY_BINDING_PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
                helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {"enabled": False},
            }},
        }))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        entries = cfg["plugins"]["entries"]
        writer = entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]
        self.assertIs(writer.get("enabled"), False, "operator opt-out respected")
        self.assertEqual(writer["config"]["harnesses"], legacy,
                         "config content still transported (data move)")
        self.assertNotIn(helper.LEGACY_BINDING_PLUGIN_NAME, entries,
                         "successfully migrated legacy entry is removed")

    def test_legacy_migration_sets_enabled_only_for_fresh_entry(self) -> None:
        """A pre-existing writer entry without an enabled flag keeps that
        state (the deploy block owns enable decisions, not the migration).
        Called directly on migrate_legacy_harnesses_config — through
        deploy_plugins the deploy registration itself would set enabled=true
        (Phase 2.15 semantics) and mask what the MIGRATION decided."""
        legacy = {"codex": {"model": "m1"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.LEGACY_BINDING_PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
                helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {"config": {}},
            }},
        }))
        helper.migrate_legacy_harnesses_config()
        writer = json.loads(path.read_text())["plugins"]["entries"][
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        ]
        self.assertNotIn("enabled", writer, "pre-existing entry: no enable flip")
        self.assertEqual(writer["config"]["harnesses"], legacy)

    def test_legacy_migration_sets_enabled_for_fresh_entry(self) -> None:
        """Fresh (non-existent) writer entry: the migration sets enabled=true
        as spec'd."""
        legacy = {"codex": {"model": "m1"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.LEGACY_BINDING_PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
            }},
        }))
        helper.migrate_legacy_harnesses_config()
        writer = json.loads(path.read_text())["plugins"]["entries"][
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        ]
        self.assertTrue(writer.get("enabled") is True)
        self.assertEqual(writer["config"]["harnesses"], legacy)


class AddonHarnessDefaultsTest(unittest.TestCase):
    """Geteilte Add-on-Optionen für den Writer (GaRoN 2026-10-11):
    base_url Aktivator, shared model/api_key, excluded_agents Kommazeile;
    operator-owned entries never touched; stale generierte Entries nur dann
    entfernt, wenn unverändert generiert."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src_root = Path(self.tmp.name) / "plugins"
        write_minimal_plugin_source(self.src_root)
        self.config_dir = Path(self.tmp.name) / "config"
        self.config_dir.mkdir()
        self.path = self.config_dir / "openclaw.json"
        self.path.write_text(json.dumps({"agents": {"entries": {}}}))
        patches = (
            mock.patch.object(helper, "PLUGIN_SRC_DIR", self.src_root),
            mock.patch.object(helper, "PLUGIN_SRC_FALLBACK_DIRS", (self.src_root,)),
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
            mock.patch.object(helper, "ACPX_DIR", self.config_dir / "acpx"),
            mock.patch.object(helper, "CODEX_SOURCE_HOME", self.config_dir / ".codex"),
            mock.patch.object(helper, "OPENCODE_GLOBAL_DIR", self.config_dir / "opencode"),
            mock.patch.object(helper, "CLAUDE_SOURCE_HOME", self.config_dir / ".claude"),
            mock.patch.object(helper, "PI_AGENT_DIR", self.config_dir / ".pi" / "agent"),
            mock.patch.dict(os.environ, {
                "HOME": str(self.config_dir),
                "XDG_CONFIG_HOME": str(self.config_dir),
            }, clear=True),
            mock.patch.object(helper, "BUNDLED_EXTENSIONS_DIR",
                              Path(self.tmp.name) / "dist" / "extensions"),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def set_env(
        self,
        *,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        excluded: str | None = None,
        writer: str = "true",
    ) -> None:
        for key in ("HARNESS_WRITER_BASE_URL", "HARNESS_WRITER_MODEL",
                    "HARNESS_WRITER_API_KEY", "HARNESS_WRITER_EXCLUDED_AGENTS"):
            os.environ.pop(key, None)
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = writer
        if base_url is not None:
            os.environ["HARNESS_WRITER_BASE_URL"] = base_url
        if model is not None:
            os.environ["HARNESS_WRITER_MODEL"] = model
        if api_key is not None:
            os.environ["HARNESS_WRITER_API_KEY"] = api_key
        if excluded is not None:
            os.environ["HARNESS_WRITER_EXCLUDED_AGENTS"] = excluded

    def harnesses(self) -> dict:
        cfg = json.loads(self.path.read_text())
        return (
            cfg.get("plugins", {})
            .get("entries", {})
            .get(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME, {})
            .get("config", {})
            .get("harnesses", {})
        )

    def test_base_url_empty_is_complete_noop(self) -> None:
        self.set_env(model="m1")
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses(), {})

    def test_shared_defaults_generated_for_all_allowed_harnesses(self) -> None:
        self.set_env(base_url="http://10.0.0.5:11434", model="shared-model")
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(
            set(harnesses),
            set(helper.KNOWN_WRITER_HARNESS_IDS),
            "all non-excluded known harnesses generated",
        )
        self.assertEqual(harnesses["codex"], {
            "model": "shared-model", "baseUrl": "http://10.0.0.5:11434",
        })
        self.assertIn("model", harnesses["claude"])
        self.assertIn("kilo", harnesses)
        self.assertIn("kilocode", harnesses)

    def test_excluded_agents_line_removes_harnesses(self) -> None:
        self.set_env(base_url="http://10.0.0.5:11434", model="m1",
                     excluded="codex, opencode")
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertNotIn("codex", harnesses)
        self.assertNotIn("opencode", harnesses)
        self.assertIn("claude", harnesses)

    def test_operator_owned_entry_untouched(self) -> None:
        manual = {"codex": {"model": "operator-model",
                            "baseUrl": "http://operator-lan:1234"}}
        self.config_dir.joinpath("openclaw.json").write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {
                    "enabled": True, "config": {"harnesses": manual},
                },
            }},
        }))
        self.set_env(base_url="http://10.0.0.5:11434", model="shared-model")
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(
            self.harnesses()["codex"], manual["codex"],
            "operator hand entry wins over the shared defaults",
        )
        self.assertIn("claude", self.harnesses(), "other harnesses generated")

    def test_stale_generated_entries_removed_when_options_cleared(self) -> None:
        self.set_env(base_url="http://10.0.0.5:11434", model="m1")
        self.assertTrue(helper.deploy_plugins())
        self.assertIn("codex", self.harnesses())
        # Options cleared (base_url off):
        self.set_env()
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses(), {})

    def test_hand_edited_generated_entry_is_kept_not_regenerated(self) -> None:
        self.set_env(base_url="http://10.0.0.5:11434", model="m1")
        self.assertTrue(helper.deploy_plugins())
        hand_edited = {"model": "operator-override", "baseUrl": "http://x:1"}
        cfg = json.loads(self.path.read_text())
        cfg["plugins"]["entries"][helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME][
            "config"
        ]["harnesses"]["codex"] = hand_edited
        self.path.write_text(json.dumps(cfg))
        # Change options + rerun: the hand-edited entry must stay untouched.
        self.set_env(base_url="http://10.0.0.5:11434", model="m2")
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(harnesses["codex"], hand_edited, "operator wins")
        self.assertEqual(harnesses["opencode"]["model"], "m2",
                         "untouched generated entries DO refresh")

    def _pop_claude_envs(self) -> None:
        for key in ("OLLAMA_CLAUDE_MODEL", "OLLAMA_ACP_MODEL",
                    "OLLAMA_CODEX_MODEL", "OLLAMA_OPENCODE_MODEL",
                    "OLLAMA_PI_MODEL"):
            os.environ.pop(key, None)

    def _write_gateway_default(self, model: str) -> None:
        """agents.defaults.model.primary setzen (Gateway-Default)."""
        self.config_dir.joinpath("openclaw.json").write_text(json.dumps({
            "agents": {"entries": {},
                       "defaults": {"model": {"primary": f"ollama/{model}"}}},
        }))

    def test_model_ladder_per_harness_then_shared_then_gateway_default(self) -> None:
        # 2026-11-14 (Owner-Vorgabe): leere Felder = weitersuchen, KEIN im Code
        # verdrahteter Default.
        #   1. pro-Harness-Option  2. geteilte Option  3. Gateway-Default
        self._pop_claude_envs()
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        self._write_gateway_default("gateway-default-model")
        os.environ["OLLAMA_CODEX_MODEL"] = "codex-option"
        os.environ["OLLAMA_OPENCODE_MODEL"] = "opencode-option"
        os.environ["OLLAMA_CLAUDE_MODEL"] = "claude-option"
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(harnesses["codex"]["model"], "codex-option")
        self.assertEqual(harnesses["opencode"]["model"], "opencode-option")
        self.assertEqual(harnesses["claude"]["model"], "claude-option")
        # ENV-IDs ohne eigene Option erben den Gateway-Default:
        self.assertEqual(harnesses["copilot"]["model"], "gateway-default-model")
        self.assertEqual(harnesses["qwen"]["model"], "gateway-default-model")
        # Die geteilte Option schlägt den Gateway-Default, aber nicht die
        # pro-Harness-Option:
        os.environ["HARNESS_WRITER_MODEL"] = "shared-option"
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(harnesses["copilot"]["model"], "shared-option")
        self.assertEqual(harnesses["codex"]["model"], "codex-option")

    def test_without_any_model_no_harness_entries_are_written(self) -> None:
        # Ohne Optionen UND ohne Gateway-Default bleibt das Modell unbestimmt →
        # der Writer erzeugt bewusst keinen Eintrag (kein unbrauchbares Modell).
        self._pop_claude_envs()
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        self.config_dir.joinpath("openclaw.json").write_text(
            json.dumps({"agents": {"entries": {}}}))
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses(), {})

    def test_claude_default_is_generated_even_without_options(self) -> None:
        # Ohne claude-Option greift die Leiter weiter: geteilte Option, dann
        # Gateway-Default (agents.defaults.model.primary).
        self._pop_claude_envs()
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        self._write_gateway_default("gateway-default-model")
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(harnesses["claude"]["model"], "gateway-default-model")

    def test_claude_model_ladder_option_then_shared_then_gateway_default(self) -> None:
        self._pop_claude_envs()
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        self._write_gateway_default("gateway-default-model")
        os.environ["OLLAMA_CLAUDE_MODEL"] = "from-new-option"
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["claude"]["model"], "from-new-option")
        # geteilte Option gewinnt vor dem Gateway-Default:
        os.environ.pop("OLLAMA_CLAUDE_MODEL")
        os.environ["HARNESS_WRITER_MODEL"] = "from-shared-option"
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["claude"]["model"], "from-shared-option")
        # beide Optionen leer → Gateway-Default:
        os.environ.pop("HARNESS_WRITER_MODEL")
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["claude"]["model"], "gateway-default-model")

    def test_operator_model_array_entry_is_untouched_and_refresh_stable(self) -> None:
        # γ multi-model: a hand-written models array differs from the managed
        # book → operator ownership (untouched), and the merge stays
        # byte-stable across boots (book never carried models).
        manual = {"codex": {"model": "operator-model",
                            "baseUrl": "http://operator-lan:1234",
                            "models": ["a", "b"]}}
        self.config_dir.joinpath("openclaw.json").write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {
                    "enabled": True, "config": {"harnesses": manual},
                },
            }},
        }))
        self.set_env(base_url="http://10.0.0.5:11434", model="shared-model")
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["codex"], manual["codex"],
                         "hand models array = operator owned, untouched")
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["codex"], manual["codex"])

    def test_merge_is_idempotent_across_boots(self) -> None:
        self.set_env(base_url="http://10.0.0.5:11434", model="m1")
        self.assertTrue(helper.deploy_plugins())
        first = json.loads(self.path.read_text())
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(first, json.loads(self.path.read_text()))

    def test_managed_defaults_book_is_secret_tight(self) -> None:
        """Audit H-B/H-C: Buch-File 0600 (kann apiKey halten), Dir 0700 —
        und die Rechte gelten ab der ersten sichtbaren Sekunde (chmod am tmp
        VOR rename, kein 0644→0600-Expose-Fenster)."""
        os.umask(0o022)
        self.set_env(base_url="http://10.0.0.5:11434", model="m1",
                     api_key="sk-secret")
        self.assertTrue(helper.deploy_plugins())
        book = self.config_dir / helper.WRITER_ADDON_DEFAULTS_MANAGER
        self.assertEqual(os.stat(book).st_mode & 0o777, 0o700)
        self.assertEqual(
            os.stat(book / "managed-defaults.json").st_mode & 0o777, 0o600
        )
        self.assertEqual(
            json.loads((book / "managed-defaults.json").read_text())[
                "generated"]["claude"]["apiKey"], "sk-secret"
        )


class BundledRootDeployTest(unittest.TestCase):
    """Bundled-Root-Trust-Deploy (Kammerjäger 2026-10-11): der Gateway
    verweigert openKeyedStore für alles außer origin "bundled" /
    trustedOfficialInstall — deployed in die bundled extensions root wird
    der Payload vorkompiliert (esbuild index.mjs), gepatcht (extensions
    ./index.mjs) und der stale External-Copy entfernt. Fallback: legacy
    externer Deploy, wenn esbuild fehlt oder der Bundling-Step scheitert."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src_root = Path(self.tmp.name) / "plugins"
        write_minimal_plugin_source(self.src_root)
        self.config_dir = Path(self.tmp.name) / "config"
        self.config_dir.mkdir()
        (self.config_dir / "openclaw.json").write_text(json.dumps({"agents": {"entries": {}}}))
        self.bundled_dir = Path(self.tmp.name) / "dist" / "extensions"
        patches = (
            mock.patch.object(helper, "PLUGIN_SRC_DIR", self.src_root),
            mock.patch.object(helper, "PLUGIN_SRC_FALLBACK_DIRS", (self.src_root,)),
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
            mock.patch.object(helper, "BUNDLED_EXTENSIONS_DIR", self.bundled_dir),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def deploy_bundled(self, bundle_bytes: bytes | None) -> bool:
        self.bundled_dir.mkdir(parents=True)
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        return bool(bundle_bytes) or bundle_bytes is not None

    def bundled_dst(self) -> Path:
        return self.bundled_dir / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME

    def test_bundled_deploy_writes_compiled_payload(self) -> None:
        self.bundled_dir.mkdir(parents=True)
        mock.patch.object(helper, "_find_esbuild",
                          lambda: "/fake/esbuild").start()
        self.addCleanup(mock.patch.stopall)
        ok = mock.patch.object(helper, "_compile_bundled_plugin",
                               lambda src, _bin: b"BUNDLE-BYTES").start()
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        dst = self.bundled_dst()
        self.assertEqual((dst / "index.mjs").read_bytes(), b"BUNDLE-BYTES")
        package = json.loads((dst / "package.json").read_text())
        self.assertEqual(package["openclaw"]["extensions"], ["./index.mjs"])
        self.assertEqual((dst / "openclaw.plugin.json").read_text(),
                         '{"id": "harness-config-writer"}')
        # no external shadow copy; only the configured entry
        self.assertFalse((self.config_dir / "plugins" /
                          helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).exists())
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        entry = cfg["plugins"]["entries"]["harness-config-writer"]
        self.assertIs(entry["enabled"], True)

    def test_bundled_deploy_copies_runtime_assets(self) -> None:
        # A compiled bundle cannot carry the codex base-instructions fixture,
        # so the deploy must copy it next to index.mjs. Without it the writer
        # finds no fixture and writes the catalog without base_instructions.
        self.bundled_dir.mkdir(parents=True)
        mock.patch.object(helper, "_find_esbuild",
                          lambda: "/fake/esbuild").start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(helper, "_compile_bundled_plugin",
                          lambda src, _bin: b"BUNDLE-BYTES").start()
        asset = (self.src_root / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
                 / "src" / "fixtures" / "codex-base-instructions.txt")
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_text("FIXTURE-BYTES\n")
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        copied = (self.bundled_dst() / "fixtures" / "codex-base-instructions.txt")
        self.assertTrue(copied.is_file())
        self.assertEqual(copied.read_text(), "FIXTURE-BYTES\n")

    def test_bundled_deploy_removes_stale_external_copy(self) -> None:
        self.bundled_dir.mkdir(parents=True)
        external = self.config_dir / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        external.mkdir(parents=True)
        (external / "index.ts").write_text("// stale")
        mock.patch.object(helper, "_find_esbuild",
                          lambda: "/fake/esbuild").start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(helper, "_compile_bundled_plugin",
                          lambda src, _bin: b"BUNDLE-BYTES").start()
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        self.assertFalse(external.exists())
        self.assertTrue(self.bundled_dst().joinpath("index.mjs").is_file())

    def test_bundled_deploy_byte_identical_second_boot_is_read_only(self) -> None:
        self.bundled_dir.mkdir(parents=True)
        mock.patch.object(helper, "_find_esbuild",
                          lambda: "/fake/esbuild").start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(helper, "_compile_bundled_plugin",
                          lambda src, _bin: b"BUNDLE-BYTES").start()
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        index = self.bundled_dst() / "index.mjs"
        first_mtime = os.stat(index).st_mtime_ns
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        self.assertEqual(os.stat(index).st_mtime_ns, first_mtime)

    def test_bundled_deploy_falls_back_to_external_when_bundle_fails(self) -> None:
        mock.patch.object(helper, "_find_esbuild",
                          lambda: "/fake/esbuild").start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(helper, "_compile_bundled_plugin",
                          lambda src, _bin: None).start()
        self.assertTrue(helper._deploy_and_register_plugin(
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME))
        # legacy external deploy happened
        external = self.config_dir / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        self.assertTrue((external / "openclaw.plugin.json").is_file())
        self.assertFalse(self.bundled_dst().exists())

    def test_compile_bundled_plugin_with_real_esbuild(self) -> None:
        """Integrations-Probe: der REALE esbuild (gateway-pinned, falls im
        Image/Der-Dev-Box verfügbar) bündelt die echte Plugin-Source; alle
        relativen Module werden inlined ('openclaw/*' bleibt bare specifier
        für den Loader-Alias). Skip, wenn esbuild nicht vorhanden."""
        esbuild_bin = helper._find_esbuild()
        if not esbuild_bin:
            self.skipTest("no esbuild available")
        src = self.config_dir.parent / "real-src" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        real_src = REPO / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        src.parent.mkdir(parents=True)
        shutil_copytree = __import__("shutil").copytree
        shutil_copytree(real_src, src,
                        ignore=__import__("shutil").ignore_patterns(
                            "node_modules", ".git", "__pycache__"))
        bundle = helper._compile_bundled_plugin(src, esbuild_bin)
        self.assertIsNotNone(bundle)
        self.assertGreater(len(bundle or b""), 1000)
        self.assertNotIn(b"from './src/", bundle)
        self.assertIn(b"definePluginEntry", bundle)


class UtilityModelMergeTest(unittest.TestCase):
    """V36.2 (2026-10-13): agents.defaults.utilityModel aus der Option
    utility_model gespiegelt — root-cause fix für "session observer returned
    invalid JSON twice" (Utility-Modell lieferte kein strict-JSON-Digest).
    UNSET = no-op; agent entries werden nie berührt; idempotenter Write."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_dir = Path(self.tmp.name)
        self.path = self.config_dir / "openclaw.json"
        os.environ.pop("OPENCLAW_UTILITY_MODEL", None)
        self.addCleanup(lambda: os.environ.pop("OPENCLAW_UTILITY_MODEL", None))
        patcher = mock.patch.object(helper, "CONFIG_DIR", self.config_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_unset_is_noop(self) -> None:
        self.path.write_text(json.dumps({"agents": {"entries": {"main": {}}}}))
        self.assertTrue(helper.merge_utility_model())
        cfg = json.loads(self.path.read_text())
        self.assertEqual(cfg, {"agents": {"entries": {"main": {}}}})

    def test_writes_defaults_and_is_idempotent(self) -> None:
        self.path.write_text(json.dumps({"agents": {"entries": {"main": {}}}}))
        os.environ["OPENCLAW_UTILITY_MODEL"] = "ollama/nemotron-3-super:cloud"
        self.assertTrue(helper.merge_utility_model())
        cfg = json.loads(self.path.read_text())
        self.assertEqual(
            cfg["agents"]["defaults"]["utilityModel"], "ollama/nemotron-3-super:cloud"
        )
        self.assertEqual(cfg["agents"]["entries"], {"main": {}})
        mtime_first = self.path.stat().st_mtime_ns
        # Idempotent: same value → no write.
        self.assertTrue(helper.merge_utility_model())
        self.assertEqual(self.path.stat().st_mtime_ns, mtime_first)

    def test_creates_agents_and_defaults_when_missing(self) -> None:
        self.path.write_text(json.dumps({}))
        os.environ["OPENCLAW_UTILITY_MODEL"] = "ollama/deepseek-v4.1-flash:cloud"
        self.assertTrue(helper.merge_utility_model())
        cfg = json.loads(self.path.read_text())
        self.assertEqual(
            cfg["agents"]["defaults"]["utilityModel"],
            "ollama/deepseek-v4.1-flash:cloud",
        )

    def test_never_replaces_non_object_defaults(self) -> None:
        self.path.write_text(json.dumps({"agents": {"defaults": "garbage"}}))
        os.environ["OPENCLAW_UTILITY_MODEL"] = "ollama/nemotron-3-super:cloud"
        with mock.patch.object(helper, "log") as logged:
            self.assertFalse(helper.merge_utility_model())
            self.assertTrue(any("NOT merged" in str(call) for call in logged.call_args_list))
        self.assertEqual(
            json.loads(self.path.read_text())["agents"]["defaults"], "garbage"
        )

    def test_missing_openclaw_json_is_soft_noop(self) -> None:
        os.environ["OPENCLAW_UTILITY_MODEL"] = "ollama/nemotron-3-super:cloud"
        self.assertTrue(helper.merge_utility_model())


class Gamma2WriterSurfaceTest(unittest.TestCase):
    """gamma.2 write surface: every file the writer plugin owns must be in
    the managed set, otherwise disabling the writer leaves files behind (the
    Codex-HCW auth.json carries the API key)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_dir = Path(self.tmp.name) / "config"
        self.config_dir.mkdir()
        patches = (
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
            mock.patch.object(helper, "ACPX_DIR", self.config_dir / "acpx"),
            mock.patch.object(helper, "CODEX_SOURCE_HOME", self.config_dir / ".codex"),
            mock.patch.object(helper, "OPENCODE_GLOBAL_DIR", self.config_dir / "opencode"),
            mock.patch.object(helper, "CLAUDE_SOURCE_HOME", self.config_dir / ".claude"),
            mock.patch.object(helper, "PI_AGENT_DIR", self.config_dir / ".pi" / "agent"),
            mock.patch.dict(os.environ, {
                "HOME": str(self.config_dir),
                "XDG_CONFIG_HOME": str(self.config_dir),
            }, clear=True),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_managed_files_cover_gamma2_targets(self) -> None:
        managed = set(helper.harness_writer_managed_files())
        acpx = self.config_dir / "acpx"
        for expected in (
            acpx / "codex-acp-hcw-wrapper.mjs",
            acpx / "codex-home-hcw" / "auth.json",
            acpx / "codex-home-hcw" / "config.toml",
            acpx / "codex-home-hcw" / "model-catalog.json",
            self.config_dir / ".claude" / "settings.json",
            self.config_dir / ".pi" / "agent" / "models.json",
            self.config_dir / ".pi" / "agent" / "settings.json",
        ):
            self.assertIn(expected, managed)

    def test_dynamic_native_inventory_and_all_json_sidecars(self) -> None:
        custom = Path(self.tmp.name) / "custom"
        env = {
            "HOME": str(custom / "home"),
            "XDG_CONFIG_HOME": str(custom / "xdg"),
            "QWEN_HOME": "~/qwen-custom",
            "COPILOT_HOME": str(custom / "copilot") + "/",
            "KIMI_CODE_HOME": "relative/kimi",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            managed = set(helper.harness_writer_managed_files())
            roots = helper._harness_writer_native_roots()
            self.assertEqual(roots["opencode"], custom / "xdg" / "opencode")
            self.assertEqual(roots["kilo"], custom / "xdg" / "kilo")
            self.assertEqual(roots["qwen"], custom / "home" / "qwen-custom")
            self.assertEqual(roots["copilot"], custom / "copilot")
            self.assertEqual(
                roots["kimi"], Path(os.path.abspath("relative/kimi"))
            )
            expected_primaries = {
                roots["codex"] / "auth.json",
                roots["codex"] / "config.toml",
                roots["codex"] / "model-catalog.json",
                roots["opencode"] / "opencode.jsonc",
                roots["acpx"] / "opencode-home" / "opencode.jsonc",
                roots["kilo"] / "kilo.json",
                roots["qwen"] / "settings.json",
                roots["kimi"] / "config.toml",
                roots["gemini"] / "settings.json",
                roots["copilot"] / "settings.json",
                roots["iflow"] / "settings.json",
                roots["droid"] / "settings.json",
                roots["kiro"] / "settings" / "cli.json",
                roots["claude"] / "settings.json",
                roots["pi"] / "models.json",
                roots["pi"] / "settings.json",
            }
            self.assertTrue(expected_primaries.issubset(managed))
            json_primaries = expected_primaries - {
                roots["codex"] / "auth.json",
                roots["codex"] / "config.toml",
                roots["codex"] / "model-catalog.json",
                roots["kimi"] / "config.toml",
            }
            for primary in json_primaries:
                self.assertIn(Path(f"{primary}.hcw-managed.json"), managed, str(primary))
            self.assertEqual(len(managed), 42)

    def test_qwen_home_resolution_matches_hcw_edge_cases(self) -> None:
        home = "/home/testuser"
        cases = {
            "~": Path(home),
            "~/qwen": Path(home) / "qwen",
            "~\\qwen": Path(home) / "qwen",
            "relative/qwen": Path(os.path.abspath("relative/qwen")),
            "/tmp/qwen/../qwen-final": Path("/tmp/qwen-final"),
            "/": Path("/"),
        }
        for configured, expected in cases.items():
            with self.subTest(configured=configured):
                self.assertEqual(
                    helper._resolve_qwen_native_home({"HOME": home, "QWEN_HOME": configured}),
                    expected,
                )
        self.assertEqual(
            helper._resolve_qwen_native_home({"HOME": "/", "QWEN_HOME": "~"}),
            Path("/"),
        )
        self.assertIsNone(helper._resolve_qwen_native_home({"QWEN_HOME": "~"}))
        self.assertIsNone(helper._resolve_qwen_native_home({}))

    def test_xdg_absent_uses_home_config_and_default_native_homes(self) -> None:
        home = Path(self.tmp.name) / "home-only"
        with mock.patch.dict(os.environ, {"HOME": str(home)}, clear=True):
            roots = helper._harness_writer_native_roots()
            self.assertEqual(roots["opencode"], home / ".config" / "opencode")
            self.assertEqual(roots["kilo"], home / ".config" / "kilo")
            self.assertEqual(roots["qwen"], home / ".qwen")
            self.assertEqual(roots["copilot"], home / ".copilot")
            self.assertEqual(roots["kimi"], home / ".kimi-code")
            self.assertEqual(roots["gemini"], home / ".gemini")
            self.assertEqual(roots["iflow"], home / ".iflow")
            self.assertEqual(roots["droid"], home / ".factory")
            self.assertEqual(roots["kiro"], home / ".kiro")

    def test_legacy_targets_still_managed(self) -> None:
        managed = set(helper.harness_writer_managed_files())
        acpx = self.config_dir / "acpx"
        for expected in (
            acpx / "codex-home" / "auth.json",
            self.config_dir / ".codex" / "config.toml",
            acpx / "opencode-home" / "opencode.jsonc",
            self.config_dir / "opencode" / "opencode.jsonc",
        ):
            self.assertIn(expected, managed)


class AdapterPathsMirrorTest(unittest.TestCase):
    """The HCW Codex wrapper resolves its ACP adapter via a stable relative
    path that does not exist in the add-on; the helper publishes the real
    candidates in <state>/acpx/adapter-paths.json."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_dir = Path(self.tmp.name) / "config"
        self.config_dir.mkdir()
        patches = (
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
            mock.patch.object(helper, "ACPX_DIR", self.config_dir / "acpx"),
            mock.patch.object(helper, "PROJECT_DIR", self.config_dir / "acpx" / ".node_project"),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_mirror_written_with_contract(self) -> None:
        self.assertTrue(helper.write_adapter_paths_mirror())
        payload = json.loads(
            (self.config_dir / "acpx" / "adapter-paths.json").read_text()
        )
        self.assertEqual(payload["version"], 1)
        self.assertIsInstance(payload["adapterPaths"], list)
        self.assertIsInstance(payload["adapterGlobs"], list)
        self.assertTrue(payload["adapterGlobs"])
        self.assertIn("@agentclientprotocol", payload["adapterGlobs"][0])

    def test_existing_candidate_is_published(self) -> None:
        entry = (
            self.config_dir / "acpx" / ".node_project" / "node_modules"
            / "@agentclientprotocol" / "codex-acp" / "dist" / "index.js"
        )
        entry.parent.mkdir(parents=True)
        entry.write_text("// adapter\n")
        self.assertTrue(helper.write_adapter_paths_mirror())
        payload = json.loads(
            (self.config_dir / "acpx" / "adapter-paths.json").read_text()
        )
        self.assertIn(str(entry), payload["adapterPaths"])


@unittest.skipUnless(Path("/usr/bin/node").is_file(), "image Node fixture requires /usr/bin/node")
class ImageNodeSubprocessTest(unittest.TestCase):
    """Persistent Homebrew Node is a decoy: helper tools must use image Node."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.persistent_bin = self.root / "config" / ".linuxbrew" / "bin"
        self.persistent_bin.mkdir(parents=True)
        self.decoy_marker = self.root / "persistent-node-executed"
        self.interpreter_log = self.root / "interpreter"
        decoy = self.persistent_bin / "node"
        decoy.write_text(
            "#!/usr/bin/env bash\n"
            "printf 'node 25.0.0 decoy\\n' > \"$DECOY_MARKER\"\n"
            "exit 99\n",
            encoding="utf-8",
        )
        decoy.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update({
            "PATH": f"{self.persistent_bin}:{self.env['PATH']}",
            "DECOY_MARKER": str(self.decoy_marker),
            "NODE_INTERPRETER_LOG": str(self.interpreter_log),
            "NODE_OPTIONS": "",
            "TEST_HARNESSES": ",".join(helper.HARNESS_EXECUTABLES.values()),
        })

    def write_node_tool(self, name: str, source: str) -> Path:
        tool = self.persistent_bin / name
        tool.write_text("#!/usr/bin/env node\n" + source, encoding="utf-8")
        tool.chmod(0o755)
        return tool

    def assert_image_node_and_no_decoy(self) -> None:
        self.assertFalse(self.decoy_marker.exists(), "persistent Node 25 decoy was executed")
        observed = Path(self.interpreter_log.read_text(encoding="utf-8").strip())
        self.assertEqual(observed.resolve(), Path("/usr/bin/node").resolve())

    def test_esbuild_env_shebang_uses_image_node_with_negative_control(self) -> None:
        esbuild = self.write_node_tool("esbuild", r'''
const fs = require("fs");
const outputArg = process.argv.slice(2).find((arg) => arg.startsWith("--outfile="));
if (!outputArg) process.exit(2);
fs.writeFileSync(process.env.NODE_INTERPRETER_LOG, process.execPath);
fs.writeFileSync(outputArg.slice("--outfile=".length), "export const bundled = true;\n");
''')
        src = self.root / "plugin"
        src.mkdir()
        (src / "index.ts").write_text("export const bundled = true;\n", encoding="utf-8")
        negative_out = self.root / "negative.mjs"
        negative = subprocess.run(
            [str(esbuild), str(src / "index.ts"), f"--outfile={negative_out}"],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(negative.returncode, 99)
        self.assertTrue(self.decoy_marker.exists(), "negative control did not select persistent Node")
        self.decoy_marker.unlink()

        with mock.patch.dict(os.environ, self.env, clear=True):
            bundle = helper._compile_bundled_plugin(src, str(esbuild))
        self.assertIsNotNone(bundle)
        self.assertIn(b"bundled", bundle or b"")
        self.assert_image_node_and_no_decoy()

    def test_npm_env_shebang_uses_image_node_with_negative_control(self) -> None:
        npm = self.write_node_tool("npm", r'''
const fs = require("fs");
const path = require("path");
const project = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
for (const dependency of Object.keys(pkg.dependencies)) {
  fs.mkdirSync(path.join(project, "node_modules", dependency), {recursive: true});
}
for (const executable of process.env.TEST_HARNESSES.split(",")) {
  const target = path.join(project, "node_modules", ".bin", executable);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, "#!/bin/sh\n");
  fs.chmodSync(target, 0o755);
}
fs.writeFileSync(process.env.NODE_INTERPRETER_LOG, process.execPath);
''')
        negative = subprocess.run(
            [str(npm), "install", "--no-save"],
            cwd=self.root,
            env=self.env,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(negative.returncode, 99)
        self.assertTrue(self.decoy_marker.exists(), "negative control did not select persistent Node")
        self.decoy_marker.unlink()

        project = self.root / "state" / "acpx" / ".node_project"
        persistent_bin = self.root / "state" / ".node_global" / "bin"
        real_run = subprocess.run

        def run_fake_npm(command, **kwargs):
            # Production resolves `npm` after applying the image-first PATH;
            # substitute the fixture at that call boundary without ever
            # invoking the host's real package installer.
            self.assertEqual(command, ["npm", "install", "--no-save"])
            self.assertTrue(kwargs["env"]["PATH"].startswith("/usr/bin:/bin:"))
            return real_run([str(npm), *command[1:]], **kwargs)

        with mock.patch.object(helper, "PROJECT_DIR", project), \
             mock.patch.object(helper, "PERSISTENT_BIN_DIR", persistent_bin), \
             mock.patch.object(helper, "_detect_unmanaged_harness_clis"), \
             mock.patch.object(helper.subprocess, "run", side_effect=run_fake_npm), \
             mock.patch.dict(os.environ, self.env, clear=True):
            self.assertTrue(helper.install_acpx_npm_project())
        self.assert_image_node_and_no_decoy()


class PersistentHarnessInstallTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name) / "acpx" / ".node_project"
        self.persistent_bin = Path(self.tmp.name) / ".node_global" / "bin"
        patcher = mock.patch.object(helper, "PROJECT_DIR", self.project)
        patcher.start()
        self.addCleanup(patcher.stop)
        bin_patcher = mock.patch.object(helper, "PERSISTENT_BIN_DIR", self.persistent_bin)
        bin_patcher.start()
        self.addCleanup(bin_patcher.stop)
        detect = mock.patch.object(helper, "_detect_unmanaged_harness_clis")
        detect.start()
        self.addCleanup(detect.stop)

    def _complete_fake_install(self, command, cwd, **_kwargs):
        self.assertEqual(command, ["npm", "install", "--no-save"])
        package = json.loads((Path(cwd) / "package.json").read_text())
        for dep in package["dependencies"]:
            (Path(cwd) / "node_modules" / Path(dep)).mkdir(parents=True, exist_ok=True)
        for executable in helper.HARNESS_EXECUTABLES.values():
            path = Path(cwd) / "node_modules" / ".bin" / executable
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("#!/bin/sh\n")
            path.chmod(0o755)
        return SimpleNamespace(returncode=0, stderr="")

    def test_all_verified_harnesses_are_pinned_and_second_boot_is_noop(self) -> None:
        with mock.patch.object(helper.subprocess, "run", side_effect=self._complete_fake_install) as run:
            self.assertTrue(helper.install_acpx_npm_project())
            package = json.loads((self.project / "package.json").read_text())
            deps = package["dependencies"]
            expected = {
                "@openclaw/acpx": "2026.7.1",
                "@openclaw/codex": "2026.7.1-1",
                "opencode-ai": "1.19.6",
                "@mariozechner/pi-coding-agent": "0.73.1",
                "@github/copilot": "1.0.114",
                "@kilocode/cli": "7.8.32",
                "@qwen-code/qwen-code": "0.28.3",
                "@google/gemini-cli": "0.70.0",
                "@factory/cli": "1.17.2",
                "@iflow-ai/iflow-cli": "0.5.19",
            }
            self.assertEqual(deps, expected)
            self.assertNotIn("kiro-cli", deps)
            for executable in helper.HARNESS_EXECUTABLES.values():
                link = self.persistent_bin / executable
                self.assertTrue(link.is_symlink(), executable)
                self.assertEqual(
                    link.resolve(),
                    (self.project / "node_modules" / ".bin" / executable).resolve(),
                )
            first = (self.project / "package.json").read_bytes()
            self.assertTrue(helper.install_acpx_npm_project())
            self.assertEqual(run.call_count, 1, "complete persistent install must be idempotent")
            self.assertEqual((self.project / "package.json").read_bytes(), first)

    def test_success_without_installed_package_fails_loudly(self) -> None:
        with mock.patch.object(
            helper.subprocess, "run",
            return_value=SimpleNamespace(returncode=0, stderr=""),
        ), mock.patch.object(helper, "log") as logged:
            self.assertFalse(helper.install_acpx_npm_project())
        self.assertIn("without all pinned packages", str(logged.call_args_list))

    def test_existing_operator_executable_is_not_overwritten(self) -> None:
        self.persistent_bin.mkdir(parents=True)
        operator = self.persistent_bin / "pi"
        operator.write_text("operator-owned\n")
        with mock.patch.object(helper.subprocess, "run", side_effect=self._complete_fake_install):
            self.assertTrue(helper.install_acpx_npm_project())
        self.assertFalse(operator.is_symlink())
        self.assertEqual(operator.read_text(), "operator-owned\n")


class KiroDetectionTest(unittest.TestCase):
    def test_missing_vendor_executable_is_a_loud_warning(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(helper, "PROJECT_DIR", Path(tmp)), \
             mock.patch.object(helper.shutil, "which", return_value=None), \
             mock.patch.object(helper, "log") as logged:
            helper._detect_unmanaged_harness_clis()
        message = str(logged.call_args_list)
        self.assertIn("WARNING", message)
        self.assertIn("kiro-cli", message)
        self.assertIn("No verified vendor npm package", message)


class SupervisorManifestTest(unittest.TestCase):
    def test_manifest_declares_hassio_role_manager(self) -> None:
        import yaml

        manifest = yaml.safe_load((REPO / "config.yaml").read_text())

        def assert_manager(candidate: dict) -> None:
            self.assertIs(candidate.get("hassio_api"), True)
            self.assertEqual(candidate.get("hassio_role"), "manager")

        assert_manager(manifest)
        # Mutation guards: deleting the key or changing the owner-authorized
        # role must make this manifest assertion fail, not silently pass.
        for invalid in (
            {"hassio_api": True},
            {"hassio_api": True, "hassio_role": "default"},
            {"hassio_api": True, "hassio_role": "admin"},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(AssertionError):
                assert_manager(invalid)


class PersistentBackupSurfaceTest(unittest.TestCase):
    def test_tool_directories_are_not_excluded_from_ha_backup(self) -> None:
        config = (REPO / "config.yaml").read_text()
        excluded = config.split("backup_exclude:", 1)[1].split("\nmap:", 1)[0]
        self.assertNotIn("- .node_global", excluded)
        self.assertNotIn("- .linuxbrew", excluded)
        self.assertIn("- .npm", excluded)
        self.assertEqual(
            helper.PERSISTENT_BIN_DIR,
            helper.CONFIG_DIR.parent / ".node_global" / "bin",
        )
        self.assertEqual(helper.PROJECT_DIR, helper.ACPX_DIR / ".node_project")

    def test_interrupted_upgrade_archives_are_excluded_from_ha_backup(self) -> None:
        import yaml

        excluded = yaml.safe_load((REPO / "config.yaml").read_text())["backup_exclude"]
        self.assertIn("*.tar.gz.partial", excluded)
        self.assertNotIn("*.tar.gz", excluded)


class ReferenceWorkerRosterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_dir = Path(self.tmp.name)
        self.path = self.config_dir / "openclaw.json"
        patcher = mock.patch.object(helper, "CONFIG_DIR", self.config_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("ACP_ADDITIONAL_ALLOWED_AGENTS", None)
        self.addCleanup(lambda: os.environ.pop("ACP_ADDITIONAL_ALLOWED_AGENTS", None))

    def test_default_is_exactly_four_workers_and_no_coordinator(self) -> None:
        self.path.write_text(json.dumps({}))
        self.assertTrue(helper.patch_openclaw_config())
        cfg = json.loads(self.path.read_text())
        self.assertEqual(set(cfg["acp"]["allowedAgents"]), {"codex", "claude", "opencode", "pi"})
        self.assertNotIn("openclaw", cfg["acp"]["allowedAgents"])
        self.assertNotIn("coordinator", cfg["acp"]["allowedAgents"])
        self.assertNotIn("agents", cfg, "the add-on must not generate an onboarding coordinator")

    def test_existing_operator_entries_and_coordinator_are_unioned(self) -> None:
        os.environ["ACP_ADDITIONAL_ALLOWED_AGENTS"] = "custom,pi"
        self.path.write_text(json.dumps({
            "acp": {"allowedAgents": ["operator-agent", "openclaw"]},
            "agents": {"entries": {
                "coordinator": {
                    "name": "onboarding-owned",
                    "subagents": {"allowAgents": ["reviewer"]},
                },
                "operator": {"runtime": {"type": "acp"}},
            }},
        }))
        self.assertTrue(helper.patch_openclaw_config())
        cfg = json.loads(self.path.read_text())
        self.assertEqual(cfg["acp"]["allowedAgents"][:2], ["operator-agent", "openclaw"])
        expected = {"codex", "claude", "opencode", "pi", "custom"}
        self.assertTrue(expected.issubset(set(cfg["acp"]["allowedAgents"])))
        coordinator = cfg["agents"]["entries"]["coordinator"]
        self.assertEqual(coordinator["name"], "onboarding-owned")
        self.assertTrue((expected | {"reviewer"}).issubset(
            set(coordinator["subagents"]["allowAgents"])
        ))
        self.assertEqual(set(cfg["agents"]["entries"]), {"coordinator", "operator"})
        first = self.path.read_bytes()
        self.assertTrue(helper.patch_openclaw_config())
        self.assertEqual(self.path.read_bytes(), first)

    def test_existing_openclaw_is_operator_owned_but_never_added(self) -> None:
        self.path.write_text(json.dumps({"acp": {"allowedAgents": ["openclaw"]}}))
        self.assertTrue(helper.patch_openclaw_config())
        allowed = json.loads(self.path.read_text())["acp"]["allowedAgents"]
        self.assertEqual(allowed.count("openclaw"), 1)
        self.assertNotIn("coordinator", allowed)


if __name__ == "__main__":
    unittest.main()
