#!/usr/bin/env python3
"""Tests for the deploy_plugins option gates (Phase 2.15 + Repo-Split A2).

Both bundled plugins must be OPT-IN via add-on options (forwarded by run.sh
as env): acp_dashboard_binding_enabled (channel plugin) and
harness_config_writer_enabled (Repo-Split A2 standalone feature plugin,
2026-10-11). Default (unset or false) = no deploy, no openclaw.json
registration; the writer option UNSET follows the channel option so existing
setups keep the previous bundled behavior, explicit values override it.
The legacy plugins.entries['acp-dashboard-binding'].config.harnesses key is
migrated to plugins.entries['harness-config-writer'].config.harnesses once
the writer deploys. Run with:

    python3 -m unittest discover -s openclaw_ha_addon/tests -v
"""

import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

import oc_acpx_helper as helper  # noqa: E402


def write_minimal_plugin_source(src: Path) -> None:
    """A manifest + one source file, the minimum _deploy_and_register_plugin needs."""
    for name in helper.BUNDLED_PLUGIN_NAMES:
        (src / name / "src").mkdir(parents=True)
        (src / name / "openclaw.plugin.json").write_text('{"id": "' + name + '"}')
        (src / name / "package.json").write_text('{"name": "' + name + '"}')
    (src / helper.PLUGIN_NAME / "src" / "agent-map.ts").write_text("export {};\n")


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
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
            # Backup-Rewrite surfaces (derive from CONFIG_DIR in prod; the
            # constants are import-time, so patch them explicitly here):
            mock.patch.object(helper, "ACPX_DIR", self.config_dir / "acpx"),
            mock.patch.object(helper, "CODEX_SOURCE_HOME", self.config_dir / ".codex"),
            mock.patch.object(helper, "OPENCODE_GLOBAL_DIR", self.config_dir / "opencode"),
            # Bundled-root deploy (Kammerjäger-Trust-Fix): point at a
            # NON-EXISTENT tmp path by default so tests never touch the
            # real gateway's /usr/lib package — tests that exercise the
            # bundled branch create the dir explicitly.
            mock.patch.object(helper, "BUNDLED_EXTENSIONS_DIR",
                              Path(self.tmp.name) / "dist" / "extensions"),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        for key in (
            "ACP_DASHBOARD_BINDING_ENABLED",
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
            .get(plugin_name or helper.PLUGIN_NAME, {})
        )

    def write_config(self, plugins_cfg: dict) -> None:
        (self.config_dir / "openclaw.json").write_text(json.dumps(plugins_cfg))

    # --- channel plugin (Phase 2.15 semantics, unchanged) -------------------

    def test_option_unset_defaults_on_and_activates(self) -> None:
        """GaRoN 2026-10-12: unset = ON out of the box — the binding is the
        addon core surface (user vision: harness agents usable in the
        dashboard without setup). Protection is the explicit OFF switch
        (real opt-out) + the fail-open claim path."""
        os.environ.pop("ACP_DASHBOARD_BINDING_ENABLED", None)
        self.assertTrue(helper.deploy_plugins())
        dst = self.config_dir / "plugins" / helper.PLUGIN_NAME
        self.assertTrue((dst / "openclaw.plugin.json").is_file())
        self.assertTrue(self.read_entry().get("enabled") is True)
        # Legacy Phase 2.15 comment removed: writer follows the (on) option.
        self.assertTrue(
            self.read_entry(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).get("enabled") is True
        )

    def test_option_false_is_real_optout(self) -> None:
        """GaRoN 2026-10-12 outage finding: explicit false must actually
        disable a previously registered plugin AND keep the boot config
        valid (strip the channels block — undeclared channel keys refuse
        boot)."""
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        path = self.config_dir / "openclaw.json"
        cfg = json.loads(path.read_text())
        cfg.setdefault("channels", {})[helper.PLUGIN_NAME] = {"enabled": True}
        path.write_text(json.dumps(cfg))
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        self.assertIs(cfg["plugins"]["entries"][helper.PLUGIN_NAME]["enabled"], False)
        self.assertNotIn(
            helper.PLUGIN_NAME, cfg.get("channels", {}),
            "channels block of a disabled plugin must be stripped (boot-safe)",
        )
        # Payload stays deployed while the gate is OFF (re-enable needs no
        # rebuild — documented never-flip invariant in _register_plugin_entry);
        # the entries gate is the authoritative disable for the host.
        self.assertTrue(
            (self.config_dir / "plugins" / helper.PLUGIN_NAME / "openclaw.plugin.json").exists()
        )
        # Idempotent second boot with no channels block left:
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        self.assertIs(cfg["plugins"]["entries"][helper.PLUGIN_NAME]["enabled"], False)

    def test_option_false_never_touches_hand_set_false(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        path = self.config_dir / "openclaw.json"
        cfg = json.loads(path.read_text())
        cfg.setdefault("plugins", {}).setdefault("entries", {})[helper.PLUGIN_NAME] = {
            "enabled": False
        }
        path.write_text(json.dumps(cfg))
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        self.assertIs(cfg["plugins"]["entries"][helper.PLUGIN_NAME]["enabled"], False)
        self.assertNotIn(helper.PLUGIN_NAME, cfg.get("channels", {}))

    def test_option_false_strips_hand_edit_channels_block(self) -> None:
        """Boot-safety: whatever put the channels block there (hand edit or
        an older helper), gate-off strips it — the config must stay valid
        while the plugin is disabled."""
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
        path = self.config_dir / "openclaw.json"
        cfg = json.loads(path.read_text())
        cfg.setdefault("plugins", {}).setdefault("entries", {})[helper.PLUGIN_NAME] = {
            "enabled": True
        }
        cfg.setdefault("channels", {})[helper.PLUGIN_NAME] = {"enabled": True}
        path.write_text(json.dumps(cfg))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        self.assertIs(cfg["plugins"]["entries"][helper.PLUGIN_NAME]["enabled"], False)
        self.assertNotIn(helper.PLUGIN_NAME, cfg.get("channels", {}))

    def test_option_true_deploys_and_registers(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        dst = self.config_dir / "plugins" / helper.PLUGIN_NAME
        self.assertTrue((dst / "openclaw.plugin.json").is_file())
        self.assertTrue((dst / "src" / "agent-map.ts").is_file())
        entry = self.read_entry()
        self.assertTrue(entry.get("enabled") is True)
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        plugins_root = str(self.config_dir / "plugins")
        self.assertIn(
            plugins_root,
            cfg["plugins"]["load"]["paths"],
            "user-plugins root must be registered in plugins.load.paths",
        )

    def test_option_enabled_is_case_insensitive_and_idempotent(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "TRUE"
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(self.read_entry().get("enabled") is True)

    def test_option_on_is_master_switch_for_binding_plugin(self) -> None:
        """GaRoN 2026-10-12 (outage finding): the HA option is the binding
        plugin's master switch. A silently respected enabled:false while the
        option shows ON = UI-lying failure class. Re-enabling flips the
        entry back; the never-flip rule is superseded for THIS plugin only
        (the writer plugin keeps it)."""
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        path = self.config_dir / "openclaw.json"
        cfg = json.loads(path.read_text())
        cfg.setdefault("plugins", {}).setdefault("entries", {})[helper.PLUGIN_NAME] = {
            "enabled": False
        }
        path.write_text(json.dumps(cfg))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        self.assertIs(cfg["plugins"]["entries"][helper.PLUGIN_NAME]["enabled"], True)

    # --- Repo-Split A2: harness-config-writer gating ------------------------

    def test_writer_follows_binding_option_by_default(self) -> None:
        """UNSET writer option = follows the channel option (behavior-preserve
        for setups that relied on the previous bundled one-plugin surface)."""
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        os.environ.pop("HARNESS_CONFIG_WRITER_ENABLED", None)
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(self.read_entry(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).get("enabled") is True)

    def test_writer_off_override_wins_when_binding_on(self) -> None:
        """Explicit writer=false veto beats binding=on (operator veto)."""
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue((self.config_dir / "plugins" / helper.PLUGIN_NAME).exists())
        self.assertFalse(
            (self.config_dir / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).exists()
        )

    def test_writer_on_even_when_binding_off(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "true"
        self.assertTrue(helper.deploy_plugins())
        self.assertTrue(
            self.read_entry(helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).get("enabled") is True
        )
        self.assertTrue(
            (self.config_dir / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
             / "openclaw.plugin.json").is_file()
        )

    def test_writer_off_binding_off_deploys_nothing(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
        os.environ["HARNESS_CONFIG_WRITER_ENABLED"] = "false"
        self.assertTrue(helper.deploy_plugins())
        self.assertFalse((self.config_dir / "plugins" / helper.PLUGIN_NAME).exists())
        self.assertFalse(
            (self.config_dir / "plugins" / helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME).exists()
        )

    def test_writer_respects_operator_opt_out_enabled_false(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        path = self.config_dir / "openclaw.json"
        cfg = json.loads(path.read_text())
        cfg.setdefault("plugins", {}).setdefault("entries", {})[
            helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME
        ] = {"enabled": False}
        path.write_text(json.dumps(cfg))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        self.assertIs(
            cfg["plugins"]["entries"][helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["enabled"],
            False,
        )

    # --- Repo-Split A2: legacy harnesses config key migration ---------------

    def test_legacy_harnesses_key_is_migrated(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        legacy = {"codex": {"model": "m1", "baseUrl": "http://ollama.internal:11434"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {helper.PLUGIN_NAME: {
                "enabled": True, "config": {"harnesses": legacy},
            }}},
        }))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        entries = cfg["plugins"]["entries"]
        self.assertEqual(
            entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["config"]["harnesses"],
            legacy,
            "legacy key must be copied to the writer entry",
        )
        self.assertTrue(entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["enabled"] is True)
        self.assertNotIn(
            "harnesses",
            entries[helper.PLUGIN_NAME].get("config", {}),
            "legacy key must be removed from the channel entry (schema strictness)",
        )

    def test_legacy_migration_not_touched_when_authoritative_new_key_exists(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        legacy = {"codex": {"model": "old"}}
        newer = {"codex": {"model": "new"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
                helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME: {
                    "enabled": True, "config": {"harnesses": newer},
                },
            }},
        }))
        self.assertTrue(helper.deploy_plugins())
        cfg = json.loads(path.read_text())
        entries = cfg["plugins"]["entries"]
        self.assertEqual(
            entries[helper.HARNESS_CONFIG_WRITER_PLUGIN_NAME]["config"]["harnesses"],
            newer,
            "existing writer surface is authoritative; we never guess",
        )
        self.assertEqual(
            entries[helper.PLUGIN_NAME]["config"]["harnesses"],
            legacy,
            "the diverging legacy key stays untouched for the operator to decide",
        )

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
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
        self.assertIn(
            "user-own",
            base64.b64decode(manifest["files"][1]["content"]).decode(),
            "snapshot must stay the first-enable pre-writer state",
        )

    def test_disable_restores_originals_and_consumes_snapshot(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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

    def test_restore_is_noop_without_snapshot(self) -> None:
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
        still removed (binding schema strictness)."""
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "true"
        legacy = {"codex": {"model": "m1"}}
        path = self.config_dir / "openclaw.json"
        path.write_text(json.dumps({
            "agents": {"entries": {}},
            "plugins": {"entries": {
                helper.PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
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
        self.assertNotIn("harnesses", entries[helper.PLUGIN_NAME].get("config", {}),
                         "legacy key removed (schema strictness)")

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
                helper.PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
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
                helper.PLUGIN_NAME: {"enabled": True, "config": {"harnesses": legacy}},
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
            mock.patch.object(helper, "CONFIG_DIR", self.config_dir),
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
        os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = "false"
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
                    "OLLAMA_CODEX_MODEL", "OLLAMA_OPENCODE_MODEL"):
            os.environ.pop(key, None)

    def test_per_harness_model_defaults_for_flagship_trio(self) -> None:
        # γ (2026-10-13): the three flagship harnesses each carry their own
        # dedicated default (claude newly: ollama_acp_claude_model).
        os.environ["OLLAMA_CODEX_MODEL"] = "codex-default"
        os.environ["OLLAMA_OPENCODE_MODEL"] = "opencode-default"
        os.environ["OLLAMA_CLAUDE_MODEL"] = "claude-default"
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(harnesses["codex"]["model"], "codex-default")
        self.assertEqual(harnesses["opencode"]["model"], "opencode-default",
                         "dedicated ollama_acp_* defaults without shared model")
        self.assertEqual(harnesses["claude"]["model"], "claude-default")
        # env-ids without any model line → deliberately not generated:
        self.assertEqual(set(harnesses),
                         {"codex", "opencode", "claude"})

    def test_claude_default_is_generated_even_without_options(self) -> None:
        # γ behavior change (CHANGELOG-Nota): with the claude ladder (option →
        # legacy OLLAMA_ACP_MODEL → default) a base_url-enabled setup now gets
        # a claude entry out of the box. Operator-removal stays possible (set
        # the option empty does NOT suppress — exclusion is harness_excluded
        #_agents and operator hand-edit ownership).
        self._pop_claude_envs()
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        self.assertTrue(helper.deploy_plugins())
        harnesses = self.harnesses()
        self.assertEqual(harnesses["claude"]["model"],
                         helper.OLLAMA_CLAUDE_MODEL_DEFAULT)

    def test_claude_model_ladder_option_wins_then_legacy_then_default(self) -> None:
        self._pop_claude_envs()
        self.addCleanup(self._pop_claude_envs)
        self.set_env(base_url="http://10.0.0.5:11434")
        os.environ["OLLAMA_CLAUDE_MODEL"] = "from-new-option"
        os.environ["OLLAMA_ACP_MODEL"] = "from-legacy-env"
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["claude"]["model"], "from-new-option")
        # legacy ambient env wins when the new option is unset:
        os.environ.pop("OLLAMA_CLAUDE_MODEL")
        self.config_dir.joinpath("openclaw.json").write_text(
            json.dumps({"agents": {"entries": {}}}))
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["claude"]["model"], "from-legacy-env")
        # both unset → the default constant:
        os.environ.pop("OLLAMA_ACP_MODEL")
        self.config_dir.joinpath("openclaw.json").write_text(
            json.dumps({"agents": {"entries": {}}}))
        self.assertTrue(helper.deploy_plugins())
        self.assertEqual(self.harnesses()["claude"]["model"],
                         helper.OLLAMA_CLAUDE_MODEL_DEFAULT)

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


if __name__ == "__main__":
    unittest.main()
