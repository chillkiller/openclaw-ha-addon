#!/usr/bin/env python3
"""Tests for the deploy_plugin option gate (Phase 2.15, GaRoN finding).

The acp-dashboard-binding plugin deploy must be OPT-IN via the add-on option
acp_dashboard_binding_enabled (forwarded by run.sh as env
ACP_DASHBOARD_BINDING_ENABLED). Default (unset or false) = no deploy, no
openclaw.json registration. Run with:

    python3 -m unittest discover -s openclaw_ha_addon/tests -v
"""

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
    """A manifest + one source file, the minimum deploy_plugin needs."""
    (src / helper.PLUGIN_NAME / "src").mkdir(parents=True)
    (src / helper.PLUGIN_NAME / "openclaw.plugin.json").write_text('{"id": "' + helper.PLUGIN_NAME + '"}')
    (src / helper.PLUGIN_NAME / "package.json").write_text('{"name": "' + helper.PLUGIN_NAME + '"}')
    (src / helper.PLUGIN_NAME / "src" / "agent-map.ts").write_text("export {};\n")


class DeployPluginEnabledOptionTest(unittest.TestCase):
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
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def read_entry(self) -> dict:
        cfg = json.loads((self.config_dir / "openclaw.json").read_text())
        return cfg.get("plugins", {}).get("entries", {}).get(helper.PLUGIN_NAME, {})

    def set_env(self, value: str | None) -> None:
        # unset/empty option: run.sh forwards it as empty string (or unset)
        if value is None:
            os.environ.pop("ACP_DASHBOARD_BINDING_ENABLED", None)
        else:
            os.environ["ACP_DASHBOARD_BINDING_ENABLED"] = value
        self.addCleanup(os.environ.pop, "ACP_DASHBOARD_BINDING_ENABLED", None)

    def test_option_unset_skips_deploy_and_registration(self) -> None:
        self.set_env(None)
        self.assertTrue(helper.deploy_plugin())
        self.assertFalse((self.config_dir / "plugins" / helper.PLUGIN_NAME).exists())
        self.assertEqual(self.read_entry(), {})

    def test_option_false_skips_deploy_and_registration(self) -> None:
        self.set_env("false")
        self.assertTrue(helper.deploy_plugin())
        self.assertFalse((self.config_dir / "plugins" / helper.PLUGIN_NAME).exists())
        self.assertEqual(self.read_entry(), {})

    def test_option_true_deploys_and_registers(self) -> None:
        self.set_env("true")
        self.assertTrue(helper.deploy_plugin())
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
        self.set_env("TRUE")
        self.assertTrue(helper.deploy_plugin())
        self.assertTrue(helper.deploy_plugin())
        self.assertTrue(self.read_entry().get("enabled") is True)

    def test_option_true_respects_operator_opt_out_enabled_false(self) -> None:
        self.set_env("true")
        path = self.config_dir / "openclaw.json"
        cfg = json.loads(path.read_text())
        cfg.setdefault("plugins", {}).setdefault("entries", {})[helper.PLUGIN_NAME] = {"enabled": False}
        path.write_text(json.dumps(cfg))
        self.assertTrue(helper.deploy_plugin())
        cfg = json.loads(path.read_text())
        self.assertIs(cfg["plugins"]["entries"][helper.PLUGIN_NAME]["enabled"], False)


if __name__ == "__main__":
    unittest.main()