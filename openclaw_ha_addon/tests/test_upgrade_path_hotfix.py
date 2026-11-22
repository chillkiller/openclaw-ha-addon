#!/usr/bin/env python3
"""Regression tests for the 0.7.13.42 upgrade-path hotfix."""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ADDON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_DIR))

import oc_acpx_helper as acpx_helper  # noqa: E402
import oc_config_helper as config_helper  # noqa: E402


class RetiredHeartbeatMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config_path = self.root / "openclaw.json"
        self.original = {
            "agents": {
                "defaults": {
                    "heartbeat": {"every": "30m", "target": "main"},
                    "heartbeatEvery": "unrelated-and-preserved",
                    "workspace": "/config/clawd",
                },
                "heartbeat": "unrelated-and-preserved",
            },
            "gateway": {"mode": "local", "port": 18790},
            "plugins": {"entries": {"operator-plugin": {"enabled": True}}},
        }
        self.original_bytes = (json.dumps(self.original, indent=2) + "\n").encode()
        self.config_path.write_bytes(self.original_bytes)
        self.config_patch = mock.patch.object(config_helper, "CONFIG_PATH", self.config_path)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)

    def migrate(self) -> tuple[bool, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = config_helper.migrate_retired_heartbeat_config()
        return result, output.getvalue()

    def backups(self) -> list[Path]:
        return list(self.root.glob("openclaw.json.pre-doctor-*"))

    def test_only_exact_retired_key_changes_and_timestamped_backup_preserves_original(self) -> None:
        result, output = self.migrate()
        self.assertTrue(result)
        expected = json.loads(json.dumps(self.original))
        del expected["agents"]["defaults"]["heartbeat"]
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf-8")), expected)
        self.assertEqual(self.config_path.read_text(encoding="utf-8").count("heartbeat"), 2)
        backups = self.backups()
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original_bytes)
        self.assertIn("agents.defaults.heartbeat", output)
        self.assertIn("runtime removed the heartbeat feature", output)
        self.assertTrue(self.config_path.is_file())
        self.assertFalse((self.root / "openclaw.json.tmp").exists())

    def test_second_migration_is_a_byte_stable_noop_without_a_second_backup(self) -> None:
        self.assertTrue(self.migrate()[0])
        first_bytes = self.config_path.read_bytes()
        first_backups = self.backups()
        result, output = self.migrate()
        self.assertTrue(result)
        self.assertEqual(output, "")
        self.assertEqual(self.config_path.read_bytes(), first_bytes)
        self.assertEqual(self.backups(), first_backups)

    def test_migration_command_runs_before_any_gateway_start(self) -> None:
        run_text = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
        migration = 'python3 "$HELPER_PATH" migrate-retired-heartbeat'
        self.assertIn(migration, run_text)
        self.assertLess(run_text.index(migration), run_text.index("start_openclaw_runtime()"))

    def test_migration_failure_is_deliberately_fail_closed_with_operator_remedy(self) -> None:
        run_text = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
        start_marker = '    rc=0\n    python3 "$HELPER_PATH" migrate-retired-heartbeat || rc=$?'
        start = run_text.index(start_marker)
        end = run_text.index("    # Audit H2:", start)
        migration_block = run_text[start:end]
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        python = fake_bin / "python3"
        python.write_text("#!/usr/bin/env bash\nexit 42\n", encoding="utf-8")
        python.chmod(0o755)
        result = subprocess.run(
            ["bash", "-c", (
                "set -euo pipefail\n"
                "HELPER_PATH=/migration-test-helper\n"
                "OPENCLAW_CONFIG_PATH=/migration-test-openclaw.json\n"
                f"{migration_block}\n"
                "printf 'START_PATH_REACHED\\n'\n"
            )],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
            env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}"},
        )
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 42, output)
        self.assertNotIn("START_PATH_REACHED", output)
        self.assertIn("agents.defaults.heartbeat", output)
        self.assertIn("deliberately fail-closed", output)
        self.assertIn("original configuration was preserved", output)
        self.assertIn("Remove only agents.defaults.heartbeat", output)
        self.assertIn("maintenance window", output)
        self.assertIn("Automatic doctor repair is not attempted", output)
        self.assertNotIn("run_automatic_doctor_repair", migration_block)
        self.assertEqual(self.config_path.read_bytes(), self.original_bytes)


class StaleLeaseCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "openclaw.sqlite"
        process = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.dead_pid = process.pid
        self.assertEqual(process.wait(timeout=10), 0)
        self.live_pid = os.getpid()
        with sqlite3.connect(self.db_path) as conn:
            conn.executescript(
                """
                CREATE TABLE state_leases (
                    scope TEXT NOT NULL,
                    lease_key TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    payload_json TEXT,
                    PRIMARY KEY (scope, lease_key)
                );
                CREATE TABLE agent_database_leases (
                    lease_id TEXT PRIMARY KEY,
                    owner_pid INTEGER NOT NULL
                );
                """
            )

    @staticmethod
    def state_payload(pid: int) -> str:
        return json.dumps({"owner": {"pid": pid, "host": "test-host", "startedAt": None}})

    def seed_leases(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO state_leases(scope, lease_key, owner, payload_json) VALUES (?, ?, ?, ?)",
                [
                    ("core:agent-database-maintenance", "global", "dead", self.state_payload(self.dead_pid)),
                    ("core:agent-database-maintenance", "live", "live", self.state_payload(self.live_pid)),
                    ("core:unrelated", "unknown-owner", "unknown", "not-json"),
                ],
            )
            conn.executemany(
                "INSERT INTO agent_database_leases(lease_id, owner_pid) VALUES (?, ?)",
                [("dead-agent-lease", self.dead_pid), ("live-agent-lease", self.live_pid)],
            )

    def lease_ids(self) -> tuple[set[str], set[str]]:
        with sqlite3.connect(self.db_path) as conn:
            state = {row[0] for row in conn.execute("SELECT lease_key FROM state_leases")}
            agent = {row[0] for row in conn.execute("SELECT lease_id FROM agent_database_leases")}
        return state, agent

    def test_dead_state_and_agent_database_lease_rows_are_removed_and_logged(self) -> None:
        self.seed_leases()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = config_helper.cleanup_stale_state_leases(self.db_path)
        self.assertTrue(result)
        self.assertEqual(self.lease_ids(), ({"live", "unknown-owner"}, {"live-agent-lease"}))
        self.assertIn("state_leases", output.getvalue())
        self.assertIn("agent_database_leases", output.getvalue())
        self.assertIn(str(self.dead_pid), output.getvalue())
        self.assertIn("owner pid", output.getvalue())

    def test_live_and_unknown_lease_owners_are_kept(self) -> None:
        self.seed_leases()
        with mock.patch.object(config_helper, "_pid_is_alive", side_effect=lambda pid: True):
            self.assertTrue(config_helper.cleanup_stale_state_leases(self.db_path))
        self.assertEqual(
            self.lease_ids(),
            ({"global", "live", "unknown-owner"}, {"dead-agent-lease", "live-agent-lease"}),
        )

    def test_stale_lease_cleanup_is_called_by_automatic_repair_before_latch_release(self) -> None:
        run_text = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
        cleanup = 'python3 "$HELPER_PATH" cleanup-stale-leases'
        self.assertIn(cleanup, run_text)
        self.assertLess(
            run_text.index(cleanup),
            run_text.index("release_automatic_doctor_latch\n}", run_text.index("run_automatic_doctor_repair()")),
        )


class LegacyCodexWrapperCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.acpx = self.root / "acpx"
        self.acpx_patch = mock.patch.object(acpx_helper, "ACPX_DIR", self.acpx)
        self.acpx_patch.start()
        self.addCleanup(self.acpx_patch.stop)

    def test_only_three_named_artifacts_are_removed_and_second_run_is_noop(self) -> None:
        legacy_home = self.acpx / "codex-home-hcw"
        legacy_home.mkdir(parents=True)
        (legacy_home / "nested").mkdir()
        (legacy_home / "nested" / "old.json").write_text("old", encoding="utf-8")
        wrapper = self.acpx / "codex-acp-hcw-wrapper.mjs"
        adapter = self.acpx / "adapter-paths.json"
        wrapper.write_text("old", encoding="utf-8")
        adapter.write_text("{}", encoding="utf-8")
        survivors = {
            self.acpx / "codex-home" / "operator.json": "acpx-owned",
            self.acpx / "codex-home-hcw-keep" / "keep.json": "similar-name",
            self.acpx / "adapter-paths.json.backup": "backup",
            self.acpx / "unrelated.txt": "unrelated",
        }
        for path, content in survivors.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertTrue(acpx_helper.remove_legacy_codex_wrapper_artifacts())
        self.assertFalse(legacy_home.exists())
        self.assertFalse(wrapper.exists())
        self.assertFalse(adapter.exists())
        for path, content in survivors.items():
            self.assertEqual(path.read_text(encoding="utf-8"), content)
        self.assertEqual(output.getvalue().count("removed legacy Codex wrapper artifact"), 3)

        second_output = io.StringIO()
        with contextlib.redirect_stdout(second_output):
            self.assertTrue(acpx_helper.remove_legacy_codex_wrapper_artifacts())
        self.assertEqual(second_output.getvalue(), "")

    def test_absent_artifacts_do_not_create_the_acpx_directory(self) -> None:
        self.assertTrue(acpx_helper.remove_legacy_codex_wrapper_artifacts())
        self.assertFalse(self.acpx.exists())

    def test_named_symlinks_are_unlinked_without_touching_external_targets(self) -> None:
        external = self.root / "external"
        external.mkdir()
        external_file = external / "keep.txt"
        external_file.write_text("keep", encoding="utf-8")
        self.acpx.mkdir()
        (self.acpx / "codex-home-hcw").symlink_to(external, target_is_directory=True)
        (self.acpx / "codex-acp-hcw-wrapper.mjs").symlink_to(external_file)
        self.assertTrue(acpx_helper.remove_legacy_codex_wrapper_artifacts())
        self.assertFalse((self.acpx / "codex-home-hcw").exists())
        self.assertFalse((self.acpx / "codex-acp-hcw-wrapper.mjs").exists())
        self.assertEqual(external_file.read_text(encoding="utf-8"), "keep")
        self.assertTrue(external.is_dir())

    def test_unconditional_upgrade_path_reaches_legacy_cleanup(self) -> None:
        run_text = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
        helper_source = (ADDON_DIR / "oc_acpx_helper.py").read_text(encoding="utf-8")
        call = 'python3 "$ACPX_HELPER_PATH" --migrate-retired-binding'
        self.assertIn(call, run_text)
        self.assertLess(run_text.index(call), run_text.index("start_openclaw_runtime()"))
        migration_body = helper_source.split("def migrate_retired_binding_installation()", 1)[1].split("\ndef ", 1)[0]
        self.assertIn("remove_legacy_codex_wrapper_artifacts()", migration_body)


if __name__ == "__main__":
    unittest.main()
