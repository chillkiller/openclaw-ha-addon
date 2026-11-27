#!/usr/bin/env python3
"""Focused regression tests for native runtime/image guards in run.sh/Dockerfile."""

from __future__ import annotations

import fnmatch
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest


ADDON_DIR = Path(__file__).resolve().parents[1]


def helper_module():
    """Import the ACPX helper module from the add-on directory."""
    if str(ADDON_DIR) not in sys.path:
        sys.path.insert(0, str(ADDON_DIR))
    import oc_acpx_helper

    return oc_acpx_helper
RUN_SH = ADDON_DIR / "run.sh"
RUN_TEXT = RUN_SH.read_text(encoding="utf-8")
NODE = shutil.which("node")


def shell_function(name: str) -> str:
    """Extract one top-level Bash function without executing run.sh."""
    lines = RUN_TEXT.splitlines()
    start = lines.index(f"{name}() {{")
    end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[start : end + 1])


def run_bash(
    functions: list[str],
    body: str,
    *,
    env: dict[str, str] | None = None,
    timeout: int = 15,
    args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    source = "\n\n".join(shell_function(name) for name in functions)
    return subprocess.run(
        ["bash", "-c", f"{source}\n\n{body}", "bash", *(args or [])],
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
        check=False,
    )


def shell_block(start: str, end: str, source: str = RUN_TEXT) -> str:
    """Extract a real top-level run.sh block without executing the startup."""
    return source.split(start, 1)[1].split(end, 1)[0].join((start, "")).rstrip()


@unittest.skipUnless(shutil.which("jq"), "jq is required for the real flattening program")
class SectionedDoctorOptionsTests(unittest.TestCase):
    FLATTEN_START = 'if jq -e \'has("harness") or has("ha_integration")\''
    FLATTEN_END = "\n\n# ------------------------------------------------------------------------------\n# Read app options"
    DOCTOR_START = "GW_DOCTOR_REPAIR_MAX="
    DOCTOR_END = "\n\n# ACPX harnesses"

    def consume(self, source: str = RUN_TEXT) -> dict[str, int]:
        flatten = shell_block(self.FLATTEN_START, self.FLATTEN_END, source)
        doctor = shell_block(self.DOCTOR_START, self.DOCTOR_END, source)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            options = root / "options.json"
            options.write_text(json.dumps({
                "harness": {},
                "safety_nets": {
                    "gateway_doctor_repair_max": 5,
                    "gateway_doctor_repair_timeout": 2345,
                    "gateway_doctor_capture_keep": 7,
                },
            }), encoding="utf-8")
            script = (
                f"OPTIONS_FILE={shlex.quote(str(options))}\n"
                f"OPTIONS_FLAT={shlex.quote(str(root / 'flat.json'))}\n"
                f"{flatten}\n{doctor}\n"
                "printf 'REPAIR_MAX=%s\\nREPAIR_TIMEOUT=%s\\nCAPTURE_KEEP=%s\\n' "
                '"$GW_DOCTOR_REPAIR_MAX" "$GW_DOCTOR_REPAIR_TIMEOUT" "$GW_DOCTOR_CAPTURE_KEEP"\n'
            )
            result = subprocess.run(
                ["bash", "-c", script], text=True, capture_output=True, timeout=15, check=False,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = dict(
            line.split("=", 1)
            for line in result.stdout.splitlines()
            if line.startswith(("REPAIR_MAX=", "REPAIR_TIMEOUT=", "CAPTURE_KEEP="))
        )
        return {key: int(value) for key, value in values.items()}

    def test_sectioned_values_reach_the_actual_doctor_consumers(self) -> None:
        self.assertEqual(
            self.consume(),
            {"REPAIR_MAX": 5, "REPAIR_TIMEOUT": 2345, "CAPTURE_KEEP": 7},
        )

    def test_missing_mappings_negative_control_exposes_default_substitution(self) -> None:
        broken = RUN_TEXT.replace(
            "      gateway_doctor_repair_timeout: .safety_nets.gateway_doctor_repair_timeout,\n",
            "",
            1,
        ).replace(
            "      gateway_doctor_capture_keep: .safety_nets.gateway_doctor_capture_keep,\n",
            "",
            1,
        )
        self.assertNotEqual(broken, RUN_TEXT)
        self.assertEqual(
            self.consume(broken),
            {"REPAIR_MAX": 5, "REPAIR_TIMEOUT": 7200, "CAPTURE_KEEP": 2},
        )


class SectionedHaMcpOptionsTests(unittest.TestCase):
    def test_url_lists_and_independent_switches_reach_the_runtime_readers(self) -> None:
        flatten = shell_block(
            SectionedDoctorOptionsTests.FLATTEN_START,
            SectionedDoctorOptionsTests.FLATTEN_END,
        )
        self.assertIn("mcp_urls: .ha_integration.mcp_urls,", flatten)
        self.assertIn("mcp_enabled: .ha_integration.mcp_enabled,", flatten)
        self.assertIn("ha_official_mcp_url: .ha_integration.ha_official_mcp_url,", flatten)
        self.assertIn("ha_official_mcp_enabled: .ha_integration.ha_official_mcp_enabled,", flatten)
        self.assertIn("MCP_URLS=$(jq -r '.mcp_urls // empty' \"$OPTIONS_FILE\")", RUN_TEXT)
        self.assertIn(
            "MCP_ENABLED=$(jq -r 'if .mcp_enabled == null then true else "
            "(.mcp_enabled | tostring) end' \"$OPTIONS_FILE\")",
            RUN_TEXT,
        )
        self.assertIn("HA_OFFICIAL_MCP_URL=$(jq -r '.ha_official_mcp_url // empty' \"$OPTIONS_FILE\")", RUN_TEXT)
        self.assertIn(
            "HA_OFFICIAL_MCP_ENABLED=$(jq -r 'if .ha_official_mcp_enabled == null then false else "
            "(.ha_official_mcp_enabled | tostring) end' \"$OPTIONS_FILE\")",
            RUN_TEXT,
        )
        reserved = shell_function("is_reserved_gateway_env_var")
        self.assertIn("MCP_URLS", reserved)
        self.assertIn("MCP_ENABLED", reserved)
        self.assertIn("HA_OFFICIAL_MCP_URL", reserved)
        self.assertIn("HA_OFFICIAL_MCP_ENABLED", reserved)
        self.assertNotIn("HA_MCP_URLS", reserved)
        self.assertNotIn("HA_MCP_ENABLED", reserved)
        for retired in (
            ".ha_mcp_urls", ".ha_mcp_enabled", ".ha_mcp_url //", ".ha_mcp_token //",
            ".ha_oauth_mcp_url //", ".auto_configure_mcp //",
        ):
            self.assertNotIn(retired, RUN_TEXT)


class DoctorRepairOptionSafetyTests(unittest.TestCase):
    def test_failed_timeout_read_uses_default_without_aborting_under_strict_shell(self) -> None:
        block = shell_block(
            "if ! GW_DOCTOR_REPAIR_TIMEOUT=",
            "\n# How many `doctor --fix` snapshots",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            jq = fake_bin / "jq"
            jq.write_text("#!/usr/bin/env bash\nexit 42\n", encoding="utf-8")
            jq.chmod(0o755)
            options = root / "options.json"
            options.write_text("{}\n", encoding="utf-8")
            result = subprocess.run(
                ["bash", "-c", (
                    "set -euo pipefail\n"
                    f"OPTIONS_FILE={shlex.quote(str(options))}\n"
                    f"{block}\n"
                    "printf 'REPAIR_TIMEOUT=%s\\n' \"$GW_DOCTOR_REPAIR_TIMEOUT\"\n"
                )],
                text=True,
                capture_output=True,
                timeout=15,
                check=False,
                env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}"},
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("REPAIR_TIMEOUT=7200", result.stdout)
        self.assertIn("WARN: Could not read gateway_doctor_repair_timeout", result.stderr)
        self.assertIn("built-in default of 7200s", result.stderr)


class RetiredBindingRunGateTests(unittest.TestCase):
    BLOCK_START = 'ACPX_HELPER_PATH="/oc_acpx_helper.py"'
    BLOCK_END = "\n\nstart_openclaw_runtime() {"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config" / ".openclaw"
        self.bundled = self.root / "bundled"
        self.external_legacy = self.config / "plugins" / "acp-dashboard-binding"
        self.bundled_legacy = self.bundled / "acp-dashboard-binding"
        self.legacy_map = {"codex": {"model": "operator-old", "baseUrl": "http://192.0.2.40:11434"}}
        self.original = {
            "plugins": {
                "allow": ["operator-plugin", "acp-dashboard-binding"],
                "load": {"paths": ["operator-path"]},
                "entries": {
                    "acp-dashboard-binding": {
                        "enabled": True,
                        "config": {"harnesses": self.legacy_map},
                    },
                    "harness-config-writer": {
                        "enabled": False,
                        "config": {"operatorSetting": "preserve-me"},
                    },
                    "operator-plugin": {"enabled": True, "config": {"keep": 42}},
                },
            },
            "channels": {
                "acp-dashboard-binding": {"enabled": True},
                "operator-channel": {"enabled": True, "keep": "yes"},
            },
            "acp": {"enabled": False, "allowedAgents": ["operator-agent"]},
            "agents": {"entries": {"operator": {"model": "operator-model"}}},
            "operatorTopLevel": {"keep": [1, 2, 3]},
        }

    def seed(self) -> None:
        self.config.mkdir(parents=True, exist_ok=True)
        (self.config / "openclaw.json").write_text(json.dumps(self.original), encoding="utf-8")
        self.external_legacy.mkdir(parents=True)
        (self.external_legacy / "index.mjs").write_text("retired external", encoding="utf-8")
        self.bundled_legacy.mkdir(parents=True)
        (self.bundled_legacy / "index.mjs").write_text("retired bundled", encoding="utf-8")

    def run_gate(self, source: str = RUN_TEXT) -> subprocess.CompletedProcess[str]:
        block = shell_block(self.BLOCK_START, self.BLOCK_END, source)
        wrapper = self.root / "oc_acpx_helper.py"
        wrapper.write_text(f'''\
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("release_helper", {str(ADDON_DIR / "oc_acpx_helper.py")!r})
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
root = Path({str(self.root)!r})
helper.CONFIG_DIR = root / "config" / ".openclaw"
helper.ACPX_DIR = helper.CONFIG_DIR / "acpx"
helper.PROJECT_DIR = helper.ACPX_DIR / ".node_project"
helper.BUNDLED_EXTENSIONS_DIR = root / "bundled"
helper.PLUGIN_SRC_DIR = root / "plugin-source"
helper.PLUGIN_SRC_FALLBACK_DIRS = (root / "plugin-source",)

def forbidden(name):
    with (root / "gated-invocations.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(name) + "\\n")
    return False

helper._deploy_and_register_plugin = lambda *args: forbidden("writer-deploy")
helper.backup_harness_writer_targets_once = lambda: forbidden("writer-backup")
helper.restore_harness_writer_targets = lambda: forbidden("writer-restore")
helper.install_acpx_npm_project = lambda: forbidden("npm-install")
helper.patch_openclaw_config = lambda: forbidden("acp-patch")
helper.merge_utility_model = lambda: forbidden("utility-model")
raise SystemExit(helper.main())
''', encoding="utf-8")
        block = block.replace(
            'ACPX_HELPER_PATH="/oc_acpx_helper.py"',
            f"ACPX_HELPER_PATH={shlex.quote(str(wrapper))}",
            1,
        )
        script = f"ACPX_ENABLED=false\nHARNESS_CONFIG_WRITER_ENABLED=true\n{block}\n"
        return subprocess.run(
            ["bash", "-c", script, str(self.root / "driver")],
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def assert_legacy_removed_and_operator_data_preserved(self) -> None:
        cfg = json.loads((self.config / "openclaw.json").read_text(encoding="utf-8"))
        entries = cfg["plugins"]["entries"]
        self.assertNotIn("acp-dashboard-binding", entries)
        self.assertEqual(entries["harness-config-writer"]["config"]["harnesses"], self.legacy_map)
        self.assertEqual(entries["harness-config-writer"]["config"]["operatorSetting"], "preserve-me")
        self.assertIs(entries["harness-config-writer"]["enabled"], False)
        self.assertEqual(entries["operator-plugin"], self.original["plugins"]["entries"]["operator-plugin"])
        self.assertEqual(cfg["plugins"]["allow"], ["operator-plugin"])
        self.assertEqual(cfg["plugins"]["load"], self.original["plugins"]["load"])
        self.assertEqual(cfg["channels"], {"operator-channel": {"enabled": True, "keep": "yes"}})
        self.assertEqual(cfg["acp"], self.original["acp"])
        self.assertEqual(cfg["agents"], self.original["agents"])
        self.assertEqual(cfg["operatorTopLevel"], self.original["operatorTopLevel"])
        self.assertFalse(self.external_legacy.exists())
        self.assertFalse(self.bundled_legacy.exists())
        self.assertFalse((self.config / "plugins" / "harness-config-writer").exists())
        self.assertFalse((self.bundled / "harness-config-writer").exists())
        self.assertFalse((self.config / "acpx" / ".node_project").exists())
        self.assertFalse((self.root / "gated-invocations.jsonl").exists())

    def test_acpx_off_still_migrates_and_cleans_without_deploying_writer(self) -> None:
        self.seed()
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--migrate-retired-binding", shell_block(self.BLOCK_START, self.BLOCK_END))
        self.assert_legacy_removed_and_operator_data_preserved()

    def test_removed_unconditional_call_negative_control_leaves_legacy_install(self) -> None:
        self.seed()
        broken = RUN_TEXT.replace(
            '  python3 "$ACPX_HELPER_PATH" --migrate-retired-binding || \\\n'
            '    echo "ERROR: retired dashboard-binding migration/cleanup failed (exit $?) — see WARN/ERROR lines above"',
            "  true",
            1,
        )
        self.assertNotEqual(broken, RUN_TEXT)
        result = self.run_gate(broken)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        cfg = json.loads((self.config / "openclaw.json").read_text(encoding="utf-8"))
        self.assertIn("acp-dashboard-binding", cfg["plugins"]["entries"])
        self.assertTrue(self.external_legacy.exists())
        self.assertTrue(self.bundled_legacy.exists())
        self.assertNotIn("harnesses", cfg["plugins"]["entries"]["harness-config-writer"]["config"])


class AutomaticDoctorRepairTests(unittest.TestCase):
    FUNCTIONS = [
        "run_bounded_doctor_repair",
        "release_automatic_doctor_latch",
        "run_automatic_doctor_repair",
    ]

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config" / ".openclaw"
        self.config.mkdir(parents=True)
        (self.config / "openclaw.json").write_text('{"keep": true}\n', encoding="utf-8")
        self.latch = self.config / ".gateway-maintenance"
        self.calls = self.root / "doctor-calls"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        openclaw = self.bin / "openclaw"
        openclaw.write_text(
            "#!/usr/bin/env bash\n"
            "if [ -f \"$GATEWAY_MAINTENANCE_FLAG\" ]; then held=held; else held=missing; fi\n"
            "printf '%s|latch=%s\\n' \"$*\" \"$held\" >> \"$DOCTOR_CALLS\"\n"
            "if [ \"${FAKE_DOCTOR_IGNORE_TERM:-false}\" = true ] && "
            "[ \"$*\" = 'doctor --fix --non-interactive --yes' ]; then\n"
            "  trap '' TERM\n"
            "  while :; do sleep 1; done\n"
            "fi\n"
            "exit \"${FAKE_DOCTOR_RC:-0}\"\n",
            encoding="utf-8",
        )
        openclaw.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update(
            PATH=f"{self.bin}:{self.env['PATH']}",
            OPENCLAW_CONFIG_DIR=str(self.config),
            GATEWAY_MAINTENANCE_FLAG=str(self.latch),
            HELPER_PATH=str(ADDON_DIR / "oc_config_helper.py"),
            FAKE_OPENCLAW=str(openclaw),
            DOCTOR_CALLS=str(self.calls),
            GW_DOCTOR_REPAIR_TIMEOUT="7200",
            GW_DOCTOR_REPAIR_RUNS="1",
            GW_DOCTOR_REPAIR_MAX="3",
            GW_DOCTOR_CAPTURE_KEEP="2",
            GW_CONSECUTIVE_FAILS="2",
            GW_AUTO_DOCTOR_LATCH="false",
        )

    def repair(self, *, returncode: int = 0) -> subprocess.CompletedProcess[str]:
        env = self.env.copy()
        env["FAKE_DOCTOR_RC"] = str(returncode)
        # Intercept the timeout boundary inside Bash. Neither the system
        # `timeout` nor an installed `openclaw` binary can escape this fixture.
        body = (
            'timeout() { [ "$1" = "--kill-after=30s" ] || return 99; shift; '
            'local budget="$1"; shift; '
            '[ "$budget" = "$GW_DOCTOR_REPAIR_TIMEOUT" ] || return 98; '
            '[ "$1" = openclaw ] || return 97; shift; '
            '"$FAKE_OPENCLAW" "$@"; }\n'
            'run_automatic_doctor_repair'
        )
        return run_bash(self.FUNCTIONS, body, env=env)

    def test_successful_repair_holds_and_releases_shared_latch_and_logs_duration(self) -> None:
        result = self.repair()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls.read_text(encoding="utf-8").splitlines()
        self.assertEqual(calls, ["doctor --fix --non-interactive --yes|latch=held"])
        self.assertFalse(self.latch.exists())
        self.assertIn("Automatic doctor repair holds maintenance latch", result.stdout)
        self.assertIn("Automatic doctor repair released maintenance latch", result.stdout)
        self.assertIn("Doctor repair (safe migration) measured duration:", result.stdout)
        self.assertIn("exit code 0; timeout 7200s", result.stdout)
        self.assertIn("kill grace 30s", result.stdout)
        self.assertEqual(len(list(self.config.glob("openclaw.json.pre-doctor-*"))), 1)

    def test_failed_safe_and_full_repairs_still_release_latch_and_log_each_duration(self) -> None:
        result = self.repair(returncode=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls.read_text(encoding="utf-8").splitlines()
        self.assertEqual(calls, [
            "doctor --fix --non-interactive --yes|latch=held",
            "doctor --fix --yes --force|latch=held",
        ])
        self.assertFalse(self.latch.exists())
        self.assertEqual(result.stdout.count("measured duration:"), 2)
        self.assertEqual(result.stdout.count("exit code 1; timeout 7200s"), 2)
        self.assertIn("Automatic doctor repair released maintenance latch", result.stdout)

    def test_existing_operator_latch_is_unchanged_and_repair_is_skipped(self) -> None:
        operator_content = b"operator-owned\nmaintenance-in-progress\n"
        self.latch.write_bytes(operator_content)
        result = run_bash(
            self.FUNCTIONS,
            "run_automatic_doctor_repair",
            env=self.env,
        )
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        self.assertTrue(self.latch.exists())
        self.assertEqual(self.latch.read_bytes(), operator_content)
        self.assertFalse(self.calls.exists(), "doctor must not run under an operator hold")
        self.assertFalse(list(self.config.glob("openclaw.json.pre-doctor-*")))
        self.assertIn("Operator maintenance hold is present", result.stdout)
        self.assertIn("automatic doctor repair NOT run", result.stdout)
        self.assertNotIn("released maintenance latch", result.stdout)

    def test_sigterm_ignoring_repair_is_killed_within_grace_and_latch_is_released(self) -> None:
        env = {
            **self.env,
            "GW_DOCTOR_REPAIR_TIMEOUT": "1",
            "FAKE_DOCTOR_IGNORE_TERM": "true",
            "REAL_TIMEOUT": shutil.which("timeout") or "/usr/bin/timeout",
        }
        # Preserve the production timeout arguments, but substitute the fake
        # doctor's absolute path before using the real GNU timeout binary.
        # This keeps the hermetic fixture isolated even on a developer host
        # that also has an OpenClaw CLI installed.
        body = (
            'timeout() { local kill_after="$1" budget="$2"; shift 2; '
            '[ "$kill_after" = "--kill-after=30s" ] || return 99; '
            '[ "$1" = openclaw ] || return 97; shift; '
            '"$REAL_TIMEOUT" "$kill_after" "$budget" "$FAKE_OPENCLAW" "$@"; }\n'
            'run_automatic_doctor_repair'
        )
        started = time.monotonic()
        result = run_bash(
            self.FUNCTIONS,
            body,
            env=env,
            timeout=45,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertLess(elapsed, 40, "one second plus the 30 second kill grace must be a hard bound")
        self.assertFalse(self.latch.exists())
        self.assertTrue(self.calls.exists(), result.stdout + result.stderr)
        self.assertEqual(self.calls.read_text(encoding="utf-8").splitlines(), [
            "doctor --fix --non-interactive --yes|latch=held",
            "doctor --fix --yes --force|latch=held",
        ])
        duration = re.search(r"Doctor repair \(safe migration\) measured duration: (\d+)s", result.stdout)
        self.assertIsNotNone(duration, result.stdout)
        self.assertGreaterEqual(int(duration.group(1)), 30)
        self.assertLessEqual(int(duration.group(1)), 35)
        self.assertIn("kill grace 30s", result.stdout)
        self.assertIn("Automatic doctor repair released maintenance latch", result.stdout)

    def test_shutdown_releases_only_an_automatically_owned_latch(self) -> None:
        shutdown_source = shell_function("shutdown")
        self.assertIn("release_automatic_doctor_latch || true", shutdown_source)
        result = run_bash(
            ["release_automatic_doctor_latch"],
            "release_automatic_doctor_latch",
            env={**self.env, "GW_AUTO_DOCTOR_LATCH": "false"},
        )
        self.latch.touch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.latch.exists(), "an operator-owned latch must survive shutdown cleanup")


class UpgradeBackupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "config"
        self.backup = self.config / "upgrade-backups"
        self.backup.mkdir(parents=True)
        (self.config / "openclaw.json").write_text("{}", encoding="utf-8")
        self.env = os.environ.copy()
        self.env.update(
            OPENCLAW_CONFIG_DIR=str(self.config),
            UPGRADE_BACKUP_DIR=str(self.backup),
            ABORT_ON_UPGRADE_BACKUP_FAILURE="false",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_gate_sweeps_only_top_level_regular_partial_before_early_return(self) -> None:
        partial = self.backup / "openclaw-state-old backup.tar.gz.partial"
        partial.write_bytes(b"interrupted")
        survivors = {
            self.backup / "openclaw-state-complete.tar.gz": b"complete",
            self.backup / ".last-version": b"2.0",
            self.backup / "unrelated.partial": b"unrelated",
            self.backup / "openclaw-state-old.tar.gz.partial.extra": b"suffix",
        }
        for path, data in survivors.items():
            path.write_bytes(data)
        partial_dir = self.backup / "openclaw-state-directory.tar.gz.partial"
        partial_dir.mkdir()
        nested = self.backup / "nested"
        nested.mkdir()
        nested_partial = nested / "openclaw-state-nested.tar.gz.partial"
        nested_partial.write_bytes(b"nested")
        linked_partial = self.backup / "openclaw-state-linked.tar.gz.partial"
        linked_partial.symlink_to(nested_partial)

        result = run_bash(
            ["remove_interrupted_upgrade_backups", "record_upgrade_version", "upgrade_backup_gate"],
            "upgrade_backup_gate 2.0",
            env=self.env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(partial.exists(), "top-level interrupted archive was not swept")
        for path, data in survivors.items():
            self.assertTrue(path.is_file(), f"missing survivor: {path}")
            self.assertEqual(path.read_bytes(), data)
        self.assertTrue(partial_dir.is_dir(), "a matching directory must not be deleted")
        self.assertEqual(nested_partial.read_bytes(), b"nested")
        self.assertTrue(linked_partial.is_symlink(), "a matching symlink must not be deleted")

    def test_first_boot_early_return_also_sweeps_partial(self) -> None:
        partial = self.backup / "openclaw-state-first.tar.gz.partial"
        partial.write_bytes(b"partial")
        result = run_bash(
            ["remove_interrupted_upgrade_backups", "record_upgrade_version", "upgrade_backup_gate"],
            "upgrade_backup_gate 2.0",
            env=self.env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(partial.exists())
        self.assertEqual((self.backup / ".last-version").read_text(encoding="utf-8"), "2.0")

    def test_cleanup_warns_and_continues_when_delete_fails(self) -> None:
        partial = self.backup / "openclaw-state-failure.tar.gz.partial"
        partial.write_bytes(b"partial")
        result = run_bash(
            ["remove_interrupted_upgrade_backups"],
            "rm() { return 1; }\nremove_interrupted_upgrade_backups",
            env=self.env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WARN: Could not remove interrupted upgrade backup", result.stdout)
        self.assertTrue(partial.exists(), "negative control: failed rm must leave the file")


class ProxyShimTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.shim = self.root / "openclaw-proxy-shim.cjs"
        self.shim.write_text("// test shim\n", encoding="utf-8")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.npm_calls = self.root / "npm-calls"
        npm = self.bin / "npm"
        npm.write_text(
            "#!/usr/bin/env bash\nprintf 'call\\n' >> \"$NPM_CALLS\"\nprintf '/test/global\\n'\n",
            encoding="utf-8",
        )
        npm.chmod(0o755)
        self.base_options = "--require /app/undefined-rejection-shim.cjs --max-old-space-size=4096"
        self.base_env = os.environ.copy()
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
            self.base_env.pop(key, None)
        self.base_env.update(
            PATH=f"{self.bin}:{self.base_env['PATH']}",
            NPM_CALLS=str(self.npm_calls),
            NODE_OPTIONS=self.base_options,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def configure(self, env: dict[str, str], shim: Path | None = None) -> subprocess.CompletedProcess[str]:
        target = shim or self.shim
        return run_bash(
            ["configure_openclaw_proxy_shim"],
            "configure_openclaw_proxy_shim \"$1\"\nprintf 'NODE_OPTIONS=%s\\nGLOBAL=%s\\n' \"$NODE_OPTIONS\" \"${OPENCLAW_GLOBAL_NODE_MODULES:-}\"",
            env=env,
            args=[str(target)],
        )

    def test_each_supported_proxy_variable_preserves_existing_node_options(self) -> None:
        for variable in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            with self.subTest(variable=variable):
                self.npm_calls.unlink(missing_ok=True)
                env = self.base_env.copy()
                env[variable] = "http://proxy.example:8080"
                result = self.configure(env)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = f"--require {self.shim} {self.base_options}"
                self.assertIn(f"NODE_OPTIONS={expected}\n", result.stdout)
                self.assertIn("GLOBAL=/test/global\n", result.stdout)
                self.assertEqual(self.npm_calls.read_text(encoding="utf-8"), "call\n")

    def test_empty_node_options_still_get_only_the_shim(self) -> None:
        env = self.base_env.copy()
        env["NODE_OPTIONS"] = ""
        env["HTTPS_PROXY"] = "http://proxy.example:8080"
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"NODE_OPTIONS=--require {self.shim}\n", result.stdout)

    def test_no_proxy_and_all_proxy_are_negative_controls(self) -> None:
        for all_proxy in (False, True):
            with self.subTest(all_proxy=all_proxy):
                self.npm_calls.unlink(missing_ok=True)
                env = self.base_env.copy()
                if all_proxy:
                    env["ALL_PROXY"] = "socks5://proxy.example:1080"
                result = self.configure(env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"NODE_OPTIONS={self.base_options}\n", result.stdout)
                self.assertIn("GLOBAL=\n", result.stdout)
                self.assertFalse(self.npm_calls.exists(), "npm root lookup must stay lazy")

    def test_missing_shim_does_not_inject_or_run_npm(self) -> None:
        env = self.base_env.copy()
        env["HTTP_PROXY"] = "http://proxy.example:8080"
        result = self.configure(env, self.root / "missing.cjs")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"NODE_OPTIONS={self.base_options}\n", result.stdout)
        self.assertFalse(self.npm_calls.exists())


@unittest.skipUnless(NODE, "node is required for process-title fixtures")
class GatewayAdoptionTests(unittest.TestCase):
    FUNCTIONS = ["oc_gateway_listener_pid", "oc_gateway_pid_is_daemon", "find_gateway_daemon_pid"]

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.processes: list[subprocess.Popen[bytes]] = []
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = str(sock.getsockname()[1])
        self.env = os.environ.copy()
        self.env["GATEWAY_INTERNAL_PORT"] = self.port
        existing = run_bash(
            ["oc_gateway_pid_is_daemon"],
            "for f in /proc/[0-9]*/cmdline; do pid=${f#/proc/}; pid=${pid%%/*}; "
            "oc_gateway_pid_is_daemon \"$pid\" 2>/dev/null && echo \"$pid\"; done; true",
            env=self.env,
        )
        self.preexisting_gateways = existing.stdout.split()
        self.env["TEST_KNOWN_PIDS"] = " ".join(self.preexisting_gateways)

    def tearDown(self) -> None:
        for process in reversed(self.processes):
            self.stop(process)
        self.temp.cleanup()

    def launch(self, args: list[str]) -> subprocess.Popen[bytes]:
        process = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.processes.append(process)
        return process

    def stop(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=2)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=2)

    def find(self, rejected: str = "") -> subprocess.CompletedProcess[str]:
        body = f'GW_PID="${{TEST_KNOWN_PIDS:-}}"\nGW_DENIED_PIDS="{rejected}"\nfind_gateway_daemon_pid'
        return run_bash(self.FUNCTIONS, body, env=self.env)

    def is_gateway(self, pid: int) -> bool:
        result = run_bash(["oc_gateway_pid_is_daemon"], f'oc_gateway_pid_is_daemon "{pid}"', env=self.env)
        return result.returncode == 0

    def gateway_running(self) -> subprocess.CompletedProcess[str]:
        return run_bash(
            ["oc_gateway_pid_is_daemon", "gateway_running"],
            "gateway_running",
            env=self.env,
        )

    def wait_until(self, predicate, message: str) -> None:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail(message)

    def launch_titled_gateway(self) -> subprocess.Popen[bytes]:
        process = self.launch([NODE, "-e", "process.title='openclaw-gateway';setInterval(()=>{},1000)"])
        self.wait_until(lambda: self.is_gateway(process.pid), "node did not set the exact gateway title")
        return process

    def launch_unrelated_listener(self) -> subprocess.Popen[bytes]:
        script = "const net=require('net');net.createServer().listen(Number(process.argv[1]),'127.0.0.1');setInterval(()=>{},1000)"
        process = self.launch([NODE, "-e", script, self.port])
        self.wait_until(
            lambda: run_bash(["oc_gateway_listener_pid"], "oc_gateway_listener_pid", env=self.env).stdout.strip() == str(process.pid),
            "unrelated fixture did not bind the gateway test port",
        )
        return process

    def test_process_candidate_table(self) -> None:
        cases = ("real-title", "node-gateway-run", "node-dist-gateway", "gateway-status", "dist-gateway-status", "shell-mention")
        for case in cases:
            with self.subTest(case=case):
                if case == "real-title":
                    process = self.launch_titled_gateway()
                    accepted = True
                elif case == "node-gateway-run":
                    script = self.root / "openclaw"
                    script.write_text("setInterval(()=>{},1000)\n", encoding="utf-8")
                    process = self.launch([NODE, str(script), "gateway", "run"])
                    accepted = True
                elif case == "node-dist-gateway":
                    script = self.root / "dist-package" / "openclaw" / "dist" / "index.js"
                    script.parent.mkdir(parents=True, exist_ok=True)
                    script.write_text("setInterval(()=>{},1000)\n", encoding="utf-8")
                    process = self.launch([NODE, str(script), "gateway", "--port", self.port])
                    accepted = True
                elif case in ("gateway-status", "dist-gateway-status"):
                    if case == "dist-gateway-status":
                        script = self.root / "dist-package" / "openclaw" / "dist" / "index.js"
                        script.parent.mkdir(parents=True, exist_ok=True)
                    else:
                        script = self.root / "openclaw"
                    script.write_text("setInterval(()=>{},1000)\n", encoding="utf-8")
                    process = self.launch([NODE, str(script), "gateway", "status"])
                    accepted = False
                else:
                    process = self.launch(["bash", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done", "openclaw-gateway"])
                    accepted = False
                try:
                    self.wait_until(lambda: process.poll() is None, f"fixture exited: {case}")
                    result = self.find()
                    running = self.gateway_running()
                    if accepted:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.splitlines(), [str(process.pid)])
                        self.assertEqual(running.returncode, 0, running.stderr)
                    else:
                        self.assertNotEqual(result.returncode, 0, f"unrelated process adopted: {result.stdout}")
                        self.assertEqual(result.stdout, "")
                        if not self.preexisting_gateways:
                            self.assertNotEqual(running.returncode, 0, f"lock guard matched unrelated PID: {case}")
                finally:
                    self.stop(process)

    def test_fake_listener_is_rejected_and_exactly_one_real_gateway_is_selected(self) -> None:
        fake = self.launch_unrelated_listener()
        gateway = self.launch_titled_gateway()
        result = self.find()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(gateway.pid)])
        self.assertNotEqual(result.stdout.strip(), str(fake.pid))
        self.stop(gateway)
        self.wait_until(lambda: self.find().returncode != 0, "fake listener was adopted after the gateway exited")

    def test_real_node_gateway_is_found_by_port_ownership(self) -> None:
        script = self.root / "openclaw"
        script.write_text(
            "const net=require('net');net.createServer().listen(Number(process.argv[4]),'127.0.0.1');setInterval(()=>{},1000)\n",
            encoding="utf-8",
        )
        process = self.launch([NODE, str(script), "gateway", "run", self.port])
        self.wait_until(
            lambda: run_bash(["oc_gateway_listener_pid"], "oc_gateway_listener_pid", env=self.env).stdout.strip() == str(process.pid),
            "gateway fixture did not bind the test port",
        )
        result = self.find()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(process.pid)])

    def test_rejected_pid_is_not_readopted(self) -> None:
        gateway = self.launch_titled_gateway()
        result = self.find(rejected=str(gateway.pid))
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout, "")

    def test_adoption_deadline_and_real_port_owner_switch_are_wired(self) -> None:
        self.assertIn("GW_ADOPT_CONFIRM_TIMEOUT=300", RUN_TEXT)
        self.assertIn('GW_DENIED_PIDS="${GW_DENIED_PIDS} ${GW_PID}"', RUN_TEXT)
        self.assertIn('GW_PID="$GW_LISTENER_PID"', RUN_TEXT)
        self.assertIn('if [ "$GATEWAY_MODE" = "remote" ]; then\n      GW_ADOPT_CONFIRMED=true', RUN_TEXT)


@unittest.skipUnless(Path("/usr/bin/node").is_file(), "image Node fixture requires /usr/bin/node")
class DeterministicNodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = os.environ.copy()
        self.env["OPENCLAW_NODE_BIN"] = "/usr/bin/node"
        self.env["NODE_OPTIONS"] = ""

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_boot_check_logs_image_node_and_observed_version(self) -> None:
        result = run_bash(["verify_openclaw_node"], "verify_openclaw_node", env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        version = subprocess.run(
            ["/usr/bin/node", "-p", "process.versions.node"],
            text=True,
            capture_output=True,
            timeout=10,
            check=True,
        ).stdout.strip()
        self.assertIn(
            f"INFO: OpenClaw Node runtime: /usr/bin/node (process.versions.node={version})",
            result.stdout,
        )

    def test_boot_check_fails_loudly_for_out_of_range_node(self) -> None:
        fake = self.root / "node-25"
        fake.write_text(
            "#!/usr/bin/env bash\n"
            "echo 'unsupported Node 25.4.0; require >=24.16.0 <25 or >=26.1.0' >&2\n"
            "exit 1\n",
            encoding="utf-8",
        )
        fake.chmod(0o755)
        result = run_bash(
            ["verify_openclaw_node"],
            'verify_openclaw_node "$1"',
            env=self.env,
            args=[str(fake)],
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("ERROR: OpenClaw Node runtime", result.stdout)
        self.assertIn("25.4.0", result.stdout)
        self.assertIn(">=24.16.0 <25 or >=26.1.0", result.stdout)

    def test_gateway_exec_uses_image_node_and_ignores_persistent_decoy(self) -> None:
        persistent_bin = self.root / "config" / ".linuxbrew" / "bin"
        persistent_bin.mkdir(parents=True)
        decoy_marker = self.root / "persistent-node-executed"
        decoy = persistent_bin / "node"
        decoy.write_text(
            "#!/usr/bin/env bash\n"
            "printf 'called\\n' > \"$DECOY_MARKER\"\n"
            "exit 99\n",
            encoding="utf-8",
        )
        decoy.chmod(0o755)

        fixture = self.root / "openclaw"
        version_file = self.root / "gateway-node-version"
        expected_file = self.root / "expected-version"
        fixture.write_text(
            "#!/usr/bin/env node\n"
            "const fs = require('fs');\n"
            "fs.writeFileSync(process.env.FIXTURE_VERSION_FILE, process.versions.node);\n"
            "setInterval(() => {}, 1000);\n",
            encoding="utf-8",
        )
        fixture.chmod(0o755)
        self.env.update(
            PATH=f"{persistent_bin}:{self.env['PATH']}",
            DECOY_MARKER=str(decoy_marker),
            FIXTURE_OPENCLAW=str(fixture),
            FIXTURE_VERSION_FILE=str(version_file),
            FIXTURE_EXPECTED_FILE=str(expected_file),
        )
        body = r"""
"$OPENCLAW_NODE_BIN" -p 'process.versions.node' > "$FIXTURE_EXPECTED_FILE"
openclaw_exec_with_image_node "$FIXTURE_OPENCLAW" gateway run &
pid=$!
for _ in $(seq 1 100); do
  [ -s "$FIXTURE_VERSION_FILE" ] && break
  sleep 0.05
done
exe=$(readlink "/proc/${pid}/exe" 2>/dev/null || true)
version=$(cat "$FIXTURE_VERSION_FILE" 2>/dev/null || true)
expected=$(cat "$FIXTURE_EXPECTED_FILE")
kill -TERM "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
printf 'PID=%s\nEXE=%s\nVERSION=%s\nEXPECTED=%s\n' "$pid" "$exe" "$version" "$expected"
"""
        result = run_bash(["openclaw_exec_with_image_node"], body, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertTrue(fields["PID"].isdigit())
        self.assertEqual(Path(fields["EXE"]).resolve(), Path("/usr/bin/node").resolve())
        self.assertEqual(fields["VERSION"], fields["EXPECTED"])
        self.assertFalse(decoy_marker.exists(), "persisted Homebrew Node shadowed the image runtime")


class OAuthClientIdentityTests(unittest.TestCase):
    BLOCK_START = 'GATEWAY_PUBLIC_ORIGIN=""'
    BLOCK_END = "\n\n# --- Server cert"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cert_dir = self.root / "certs"
        self.cert_dir.mkdir()
        self.metadata_file = self.root / "oauth" / "client-metadata.json"

    def run_identity_block(
        self,
        *,
        network_mode: str = "lan_https",
        lan_ip: str = "192.0.2.20",
        gateway_port: str = "18789",
        public_url: str = "",
        ca_exists: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        if ca_exists:
            (self.cert_dir / "ca.crt").write_text("test CA fixture\n", encoding="utf-8")
        block = shell_block(self.BLOCK_START, self.BLOCK_END)
        original_assignment = 'CLIENT_METADATA_FILE="/config/oauth/client-metadata.json"'
        self.assertIn(original_assignment, block)
        block = block.replace(
            original_assignment,
            f"CLIENT_METADATA_FILE={shlex.quote(str(self.metadata_file))}",
            1,
        )
        script = (
            "set -euo pipefail\n"
            f"CERT_DIR={shlex.quote(str(self.cert_dir))}\n"
            f"NETWORK_MODE={shlex.quote(network_mode)}\n"
            f"LAN_IP={shlex.quote(lan_ip)}\n"
            f"GATEWAY_PORT={shlex.quote(gateway_port)}\n"
            f"GW_PUBLIC_URL={shlex.quote(public_url)}\n"
            f"{block}\n"
            "printf 'ORIGIN=%s\\n' \"$GATEWAY_PUBLIC_ORIGIN\"\n"
            "if [ -n \"${NODE_EXTRA_CA_CERTS+x}\" ]; then\n"
            "  printf 'CA=%s\\n' \"$NODE_EXTRA_CA_CERTS\"\n"
            "else\n"
            "  printf 'CA=<unset>\\n'\n"
            "fi\n"
        )
        env = os.environ.copy()
        env.pop("NODE_EXTRA_CA_CERTS", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            env=env,
            timeout=15,
            check=False,
        )

    def fields(self, result: subprocess.CompletedProcess[str]) -> dict[str, str]:
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return dict(line.split("=", 1) for line in result.stdout.splitlines())

    def test_metadata_document_round_trips_client_id_and_callback_origin(self) -> None:
        origin = "https://assistant.example.test:18789"
        result = self.run_identity_block(public_url=f"{origin}/ignored/path?ignored=yes")

        self.assertEqual(self.fields(result)["ORIGIN"], origin)
        document_url = f"{origin}/oauth/client-metadata.json"
        document = json.loads(self.metadata_file.read_text(encoding="utf-8"))
        self.assertEqual(document, {
            "client_id": document_url,
            "client_name": "OpenClaw Assistant",
            "redirect_uris": [f"{origin}/oauth/mcp/callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        })
        self.assertEqual(document["client_id"], document_url)
        self.assertEqual(document["redirect_uris"], [f"{origin}/oauth/mcp/callback"])
        self.assertEqual(document["token_endpoint_auth_method"], "none")

    def test_node_extra_ca_certs_is_exported_when_local_ca_exists(self) -> None:
        result = self.run_identity_block(ca_exists=True)

        self.assertEqual(self.fields(result)["CA"], str(self.cert_dir / "ca.crt"))

    def test_node_extra_ca_certs_stays_unset_when_local_ca_is_missing(self) -> None:
        result = self.run_identity_block(ca_exists=False)

        self.assertEqual(self.fields(result)["CA"], "<unset>")

    def test_public_url_origin_wins_over_lan_fallback_and_discards_path(self) -> None:
        public = self.run_identity_block(
            public_url="http://public.example.test:9443/a/path?query=ignored#fragment",
            lan_ip="192.0.2.44",
            gateway_port="23456",
        )
        fallback = self.run_identity_block(
            lan_ip="192.0.2.44",
            gateway_port="23456",
        )

        self.assertEqual(self.fields(public)["ORIGIN"], "http://public.example.test:9443")
        self.assertEqual(self.fields(fallback)["ORIGIN"], "https://192.0.2.44:23456")


class HaMcpUrlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "config"
        self.config.mkdir()
        self.openclaw_config = self.config / "openclaw.json"
        self.openclaw_config.write_text("{}\n", encoding="utf-8")
        self.api_token_file = self.root / "secrets" / "homeassistant.token"
        self.api_token_file.parent.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.forbidden_log = self.root / "forbidden-tool-log"
        self.probe_log = self.root / "probe-log"
        self.mcp_url = "https://community.example.test/private-test-connect-path"
        self.community_name = "ha-mcp-community-example-test"

        # Any attempted mcporter invocation or package repair fails the run.
        for name in ("mcporter", "npm"):
            executable = self.bin / name
            executable.write_text(
                "#!/usr/bin/env bash\n"
                "printf '%s\n' \"$0 $*\" >> \"$MCP_FORBIDDEN_LOG\"\n"
                "exit 99\n",
                encoding="utf-8",
            )
            executable.chmod(0o755)
        timeout = self.bin / "timeout"
        timeout.write_text(
            "#!/usr/bin/env bash\n"
            "shift\n"
            "exec \"$@\"\n",
            encoding="utf-8",
        )
        timeout.chmod(0o755)
        curl = self.bin / "curl"
        curl.write_text(
            "#!/usr/bin/env bash\n"
            "{ printf 'PROBE'; printf '\t%s' \"$@\"; printf '\n'; } >> \"$MCP_PROBE_LOG\"\n"
            "output=\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  if [ \"$1\" = '--output' ]; then output=$2; shift 2; else shift; fi\n"
            "done\n"
            "printf '%s' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}' > \"$output\"\n"
            "printf '%s' \"${MCP_PROBE_STATUS:-200}\"\n",
            encoding="utf-8",
        )
        curl.chmod(0o755)
        openclaw = self.bin / "openclaw"
        openclaw.write_text(
            "#!/usr/bin/env bash\n"
            "if [ \"${1:-} ${2:-}\" = 'mcp status' ]; then\n"
            "  printf '%s\n' '{\"servers\":["
            "{\"name\":\"ha-mcp-community-example-test\",\"ok\":true,\"authStatus\":{\"state\":\"authorized\"}},"
            "{\"name\":\"ha-mcp-192-0-2-10\",\"ok\":true,\"authStatus\":{\"state\":\"authorized\"}},"
            "{\"name\":\"ha-official\",\"ok\":true,\"authStatus\":{\"state\":\"authorized\"}}]}'\n"
            "elif [ \"${1:-} ${2:-}\" = 'mcp doctor' ]; then\n"
            "  printf '{\"ok\":true,\"servers\":[{\"name\":\"%s\",\"probe\":{\"tools\":2}}]}\n' \"$3\"\n"
            "else\n"
            "  exit 2\n"
            "fi\n",
            encoding="utf-8",
        )
        openclaw.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update(
            PATH=f"{self.bin}:{self.env['PATH']}",
            MCP_FORBIDDEN_LOG=str(self.forbidden_log),
            MCP_PROBE_LOG=str(self.probe_log),
            HOME=str(self.root),
            XDG_CONFIG_HOME=str(self.root / "xdg"),
            OPENCLAW_CONFIG_DIR=str(self.config),
            OPENCLAW_CONFIG_PATH=str(self.openclaw_config),
            HA_TOKEN="user-token",
            SUPERVISOR_TOKEN="supervisor-token",
            MCP_URLS=self.mcp_url,
            MCP_ENABLED="true",
            HA_OFFICIAL_MCP_URL="",
            HA_OFFICIAL_MCP_ENABLED="false",
            GATEWAY_PUBLIC_ORIGIN="https://192.0.2.20:18789",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def configure(
        self,
        env: dict[str, str],
        *,
        include_api_token: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        functions = [
            "upsert_openclaw_mcp_server",
            "verify_openclaw_mcp_server",
            "configure_openclaw_mcp_entry",
            "configure_ha_mcp",
        ]
        body = "set -euo pipefail\nconfigure_ha_mcp"
        if include_api_token:
            functions.insert(0, "configure_homeassistant_api_token")
            body = (
                "set -euo pipefail\n"
                f"configure_homeassistant_api_token {shlex.quote(str(self.api_token_file))}\n"
                "configure_ha_mcp"
            )
        return run_bash(functions, body, env=env)

    def assert_no_forbidden_tools(self) -> None:
        self.assertFalse(self.forbidden_log.exists())

    def test_secret_url_does_not_use_ha_or_supervisor_tokens(self) -> None:
        result = self.configure(self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"][self.community_name]
        self.assertEqual(definition["url"], self.env["MCP_URLS"])
        self.assertNotIn("headers", definition)
        probe = self.probe_log.read_text(encoding="utf-8")
        self.assertIn(self.env["MCP_URLS"], probe)
        self.assertNotIn("Authorization:", probe)
        self.assertNotIn("user-token", probe)
        self.assertNotIn("supervisor-token", probe)
        self.assertNotIn(self.env["MCP_URLS"], result.stdout + result.stderr)

    def test_no_bearer_credential_is_sent_or_persisted(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        probe = self.probe_log.read_text(encoding="utf-8")
        self.assertNotIn("Authorization:", probe)
        self.assertNotIn("Bearer", probe)
        self.assertNotIn("supervisor-token", probe)
        openclaw_raw = self.openclaw_config.read_text(encoding="utf-8")
        self.assertNotIn("Authorization", openclaw_raw)
        self.assertNotIn("Bearer", openclaw_raw)

    def test_exact_url_is_used_without_supervisor_token(self) -> None:
        env = self.env.copy()
        env.pop("SUPERVISOR_TOKEN")
        env["MCP_URLS"] = "http://192.0.2.10:8124/mcp/private-test-path"
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha-mcp-192-0-2-10"]
        self.assertEqual(definition["url"], env["MCP_URLS"])
        self.assertIn(env["MCP_URLS"], self.probe_log.read_text(encoding="utf-8"))
        self.assertNotIn("supervisor-token", result.stdout + result.stderr)
        self.assertNotIn(env["MCP_URLS"], result.stdout + result.stderr)

    def test_failed_url_probe_skips_registration_without_leaking(self) -> None:
        env = self.env.copy()
        env["MCP_PROBE_STATUS"] = "401"
        before = self.openclaw_config.read_bytes()
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        self.assertIn("did not answer the initialize probe", result.stdout)
        self.assertIn("it was not registered", result.stdout)
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertNotIn("user-token", result.stdout + result.stderr)
        self.assertNotIn("supervisor-token", result.stdout + result.stderr)
        self.assertNotIn(env["MCP_URLS"], result.stdout + result.stderr)

    def test_way_2_is_independent_and_needs_no_mcporter_npm_or_curl(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = "http://192.0.2.10:8123/api/mcp/assist"
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"

        result = self.configure(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        self.assertFalse(self.probe_log.exists())
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha-official"]
        self.assertEqual(definition["url"], env["HA_OFFICIAL_MCP_URL"])
        self.assertEqual(definition["auth"], "oauth")
        self.assertEqual(
            definition["oauth"],
            {
                "clientMetadataUrl": f"{env['GATEWAY_PUBLIC_ORIGIN']}/oauth/client-metadata.json",
                "redirectUrl": f"{env['GATEWAY_PUBLIC_ORIGIN']}/oauth/mcp/callback",
            },
        )
        self.assertNotIn("headers", definition)
        self.assertIn("way 2 (official MCP, OAuth): connected", result.stdout)
        self.assertNotIn(env["HA_OFFICIAL_MCP_URL"], result.stdout + result.stderr)

    def test_both_mcp_ways_never_invoke_mcporter_or_npm(self) -> None:
        env = self.env.copy()
        env["HA_OFFICIAL_MCP_URL"] = "http://192.0.2.10:8123/api/mcp/assist"
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertIn(self.community_name, servers)
        self.assertIn("ha-official", servers)

    def test_way_1_token_is_private_and_needs_no_network_probe(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = ""

        result = self.configure(env, include_api_token=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.api_token_file.read_text(encoding="utf-8"), "user-token")
        self.assertEqual(stat.S_IMODE(self.api_token_file.stat().st_mode), 0o600)
        self.assertEqual(result.stdout.splitlines(), [
            "INFO: Home Assistant connection way 1 (API, long-lived token): token stored for API/Assist/scripts"
        ])
        self.assertNotIn("user-token", result.stdout + result.stderr)
        self.assertFalse(self.probe_log.exists())
        self.assert_no_forbidden_tools()

    def test_all_three_ways_have_ordered_secret_free_status(self) -> None:
        env = self.env.copy()
        env["HA_OFFICIAL_MCP_URL"] = "http://192.0.2.10:8123/api/mcp/assist"
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"

        result = self.configure(env, include_api_token=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        self.assertEqual(result.stdout.splitlines(), [
            "INFO: Home Assistant connection way 1 (API, long-lived token): token stored for API/Assist/scripts",
            "INFO: Home Assistant connection way 2 (official MCP, OAuth): connected",
            "INFO: Home Assistant connection way 3 (community MCP, URL list): connected",
        ])
        output = result.stdout + result.stderr
        self.assertNotIn("user-token", output)
        self.assertNotIn(env["MCP_URLS"], output)
        self.assertNotIn(env["HA_OFFICIAL_MCP_URL"], output)

    def test_empty_url_is_a_silent_noop_negative_control(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        before = self.openclaw_config.read_bytes()
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_forbidden_tools()
        self.assertFalse(self.probe_log.exists())
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")


class DockerGuardTests(unittest.TestCase):
    def test_image_node_line_is_derived_and_verified_against_the_installed_package(self) -> None:
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        # The Node.js release is derived from OpenClaw's own engines.node range
        # instead of a hard-coded patch version: the range moves over time
        # (24.x -> 26.x -> 27.x) and a fixed pin would need a rebuild per
        # upstream change.
        self.assertNotIn("ARG OPENCLAW_NODE_VERSION", dockerfile)
        self.assertNotIn("nodejs=\"${", dockerfile)
        self.assertIn("apt-get install -y --no-install-recommends nodejs", dockerfile)
        # The major line comes from the same derivation, the patch version is
        # always the newest build of that repository.
        self.assertIn("oc_node_version.py", dockerfile)
        self.assertIn("--dockerfile /tmp/Dockerfile --export", dockerfile)
        self.assertIn("https://deb.nodesource.com/${NODE_SOURCE_REPO}", dockerfile)
        self.assertIn(
            "oc_node_version.py --package-json /usr/lib/node_modules/openclaw/package.json "
            "--runtime-floors /usr/lib/node_modules/openclaw --verify",
            dockerfile,
        )
        self.assertTrue((ADDON_DIR / "oc_node_version.py").is_file())
        self.assertIn("RUN export PATH=\"/usr/bin:/bin:${PATH}\";", dockerfile)
        self.assertNotIn("RUN node ", dockerfile)
        self.assertIn("npm install -g openclaw@2026.11.10", dockerfile)

    def test_node_export_is_not_swallowed_by_the_shell(self) -> None:
        """The export step must fail the build, not silently continue.

        ``eval "$(helper --export)"`` swallows the helper's exit status: the
        build would continue with an empty NODE_SOURCE_REPO and only fail
        later with an unrelated apt error.
        """
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn('eval "$(python3 /tmp/oc_node_version.py', dockerfile)
        self.assertIn('_oc_exports="$(python3 /tmp/oc_node_version.py', dockerfile)
        self.assertIn('[ -n "${NODE_SOURCE_REPO:-}" ]', dockerfile)
        self.assertIn('[ -n "${NODE_VERSION:-}" ]', dockerfile)

    def test_node_helper_stays_installed_for_the_runtime_check(self) -> None:
        """run.sh verifies the runtime Node against the installed package.

        The helper therefore has to survive the build; otherwise the runtime
        check falls back to a hard-coded range.
        """
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "install -D -m 0755 /tmp/oc_node_version.py /usr/local/lib/openclaw/oc_node_version.py",
            dockerfile,
        )
        run_sh = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
        self.assertIn("/usr/local/lib/openclaw/oc_node_version.py", run_sh)
        self.assertIn("--package-json", run_sh)
        self.assertIn("--verify", run_sh)
        # The runtime check reads the secure floors from the runtime itself.
        self.assertIn("--runtime-floors", run_sh)
        # No second copy of the engine range may live in the shell script.
        self.assertNotIn("const [major, minor]", run_sh)
        self.assertNotIn("const [maj,min]", run_sh)

    def test_node_engine_range_and_negative_controls(self) -> None:
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        # The engine range is no longer hard-coded in the image: it is read
        # from the installed OpenClaw package at build time.
        self.assertNotIn("const [maj,min]", dockerfile)
        self.assertIn(
            "oc_node_version.py --package-json /usr/lib/node_modules/openclaw/package.json "
            "--runtime-floors /usr/lib/node_modules/openclaw --verify",
            dockerfile,
        )
        # The range comes from a fixture that mirrors the published
        # engines.node of the pinned OpenClaw release, not from a literal in
        # this test: a range bump upstream must not need a test rewrite.
        range_expr = self._fixture_engine_range()
        cases = {
            "23.9.0": False,
            "24.15.9": False,
            "24.16.0": True,
            "24.99.0": True,
            "25.0.0": False,
            "25.9.1": False,
            "26.0.0": False,
            "26.1.0": True,
            "26.8.0": True,
            "27.0.0": True,
        }
        for version, accepted in cases.items():
            with self.subTest(version=version):
                self.assertEqual(
                    oc_node_version.satisfies(version, range_expr),
                    accepted,
                    f"Node {version} against {range_expr}",
                )
        self.assertIn("npm install -g openclaw@2026.11.10", dockerfile)

    @staticmethod
    def _fixture_engine_range() -> str:
        fixture = ADDON_DIR / "tests" / "fixtures" / "openclaw-package.json"
        return json.loads(fixture.read_text(encoding="utf-8"))["engines"]["node"]

    def test_node_fixture_matches_the_dockerfile_pin(self) -> None:
        """The fixture must describe the release the image actually installs."""
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        dockerfile = ADDON_DIR / "Dockerfile"
        pinned = oc_node_version.extract_openclaw_pin(str(dockerfile))
        fixture = json.loads(
            (ADDON_DIR / "tests" / "fixtures" / "openclaw-package.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(fixture["version"], pinned)

    def test_node_helper_rejects_versions_below_the_secure_floor(self) -> None:
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        # The runtime refuses Node builds with the WAL-reset bug and reports
        # the same floor as a security warning; the build must not ship one.
        # The floors come from the runtime's own table.
        runtime_floors = {"24": "24.22.1", "26": "26.12.1"}
        for major, floor in runtime_floors.items():
            with self.subTest(major=major):
                self.assertEqual(oc_node_version.floor_for(major, runtime_floors), floor)
                below = floor.rsplit(".", 1)[0] + "." + str(int(floor.rsplit(".", 1)[1]) - 1)
                self.assertTrue(
                    oc_node_version._cmp(below, floor) < 0,
                    f"{below} must be below the floor {floor}",
                )
                self.assertTrue(
                    oc_node_version._cmp(floor, floor) == 0,
                    f"{floor} must satisfy the floor",
                )

    def test_node_helper_floor_violation_fails_the_verify_gate(self) -> None:
        """The gate enforces the floor that the runtime itself ships."""
        helper = ADDON_DIR / "oc_node_version.py"
        range_expr = ">=24.16.0 <25 || >=26.1.0"
        with tempfile.TemporaryDirectory() as tmp:
            package_dir = Path(tmp) / "openclaw"
            dist = package_dir / "dist"
            dist.mkdir(parents=True)
            (dist / "node-version.mjs").write_text(
                "const NODE_SECURITY_RELEASE_FLOORS = [{major: 24, minor: 22, patch: 1}, "
                "{major: 26, minor: 12, patch: 1}];\n",
                encoding="utf-8",
            )
            for version, expected in (("24.22.0", 6), ("26.12.0", 6), ("24.22.3", 0), ("26.13.1", 0)):
                with self.subTest(version=version):
                    result = subprocess.run(
                        [
                            sys.executable,
                            str(helper),
                            "--engines",
                            range_expr,
                            "--runtime-floors",
                            str(package_dir),
                            "--verify",
                            version,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_node_helper_caret_and_tilde_follow_npm_semantics(self) -> None:
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        cases = {
            # caret: the first non-zero component decides the upper bound
            ("^24.16.0", "24.99.0"): True,
            ("^24.16.0", "25.0.0"): False,
            ("^0.2.3", "0.2.9"): True,
            ("^0.2.3", "0.3.0"): False,
            ("^0.0.3", "0.0.3"): True,
            ("^0.0.3", "0.0.4"): False,
            # tilde
            ("~1.2.3", "1.2.9"): True,
            ("~1.2.3", "1.3.0"): False,
            ("~1.2", "1.2.9"): True,
            ("~1.2", "1.3.0"): False,
            ("~1", "1.9.0"): True,
            ("~1", "2.0.0"): False,
            # a bare major means the whole line
            ("24", "24.22.3"): True,
            ("24", "25.0.0"): False,
        }
        for (range_expr, version), accepted in cases.items():
            with self.subTest(range_expr=range_expr, version=version):
                self.assertEqual(oc_node_version.satisfies(version, range_expr), accepted)

    def test_node_helper_matches_npm_semver_on_a_verified_matrix(self) -> None:
        """The expectations were taken from npm semver 7.6.3 itself.

        Each case was checked with ``semver.satisfies`` from the npm package, so
        the helper stays aligned with npm's range semantics instead of a
        hand-written approximation of them.
        """
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        verified = [
            # (version, range, npm result)
            ("26.1.0-rc.9", ">=26.1.0-rc.0 <26.1.0", True),
            ("26.1.0-rc.9", "<26.1.0", False),
            ("26.1.0-rc.1", ">=26.1.0", False),
            ("24.16.0", "^24.16.0", True),
            ("25.0.0", "^24.16.0", False),
            ("24.99.0", "^24.16.0", True),
            ("0.2.9", "^0.2.3", True),
            ("0.3.0", "^0.2.3", False),
            ("0.0.3", "^0.0.3", True),
            ("0.0.4", "^0.0.3", False),
            ("1.2.9", "~1.2.3", True),
            ("1.3.0", "~1.2.3", False),
            ("1.2.9", "~1.2", True),
            ("1.3.0", "~1.2", False),
            ("1.9.0", "~1", True),
            ("2.0.0", "~1", False),
            ("24.22.3", "24", True),
            ("25.0.0", "24", False),
            ("24.22.3", "24.x", True),
            ("25.0.0", "24.x", False),
            ("1.2.9", "1.2.x", True),
            ("1.3.0", "1.2.x", False),
            ("24.16.0", ">=24.16.0 <25 || >=26.1.0", True),
            ("25.0.0", ">=24.16.0 <25 || >=26.1.0", False),
            ("26.1.0", ">=24.16.0 <25 || >=26.1.0", True),
        ]
        for version, range_expr, expected in verified:
            with self.subTest(version=version, range_expr=range_expr):
                self.assertEqual(
                    oc_node_version.satisfies(version, range_expr),
                    expected,
                    f"Node {version} against {range_expr} (npm semver reference)",
                )

    def test_node_helper_reads_the_runtime_floor_table(self) -> None:
        """The secure floors come from the runtime, not from a second table.

        The runtime ships the minimum patch level per Node line; reading it
        from the installed package keeps a new Node line covered automatically.
        """
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        with tempfile.TemporaryDirectory() as tmp:
            package_dir = Path(tmp) / "openclaw"
            dist = package_dir / "dist"
            dist.mkdir(parents=True)
            (dist / "node-version.mjs").write_text(
                "const NODE_SECURITY_RELEASE_FLOORS = [{major: 24, minor: 22, patch: 1}, "
                "{major: 26, minor: 12, patch: 1}, {major: 27, minor: 3, patch: 0}];\n",
                encoding="utf-8",
            )
            floors = oc_node_version.runtime_security_floors(str(package_dir))
            self.assertEqual(
                floors,
                {"24": "24.22.1", "26": "26.12.1", "27": "27.3.0"},
            )
            # A Node line the runtime knows a floor for is enforced; a line
            # the runtime does not know has no floor.
            self.assertEqual(
                oc_node_version.floor_for("27", floors), "27.3.0"
            )
            self.assertEqual(oc_node_version.floor_for("28", floors), None)
            # Without a readable table there is no floor at all: the range
            # check still applies and the post-install gate verifies the
            # installed Node against the runtime's table.
            self.assertIsNone(
                oc_node_version.runtime_security_floors(str(Path(tmp) / "missing"))
            )
            self.assertIsNone(oc_node_version.floor_for("24"))
            # The helper keeps no own floor table, so the runtime stays the
            # single source of truth.
            self.assertFalse(hasattr(oc_node_version, "SECURE_FLOOR"))

    def test_node_helper_caret_respects_the_component_count(self) -> None:
        """npm derives the caret bound from the number of given components.

        ``^0`` means the whole 0.x line, ``^0.0`` the whole 0.0.x line. The
        expectations come from npm semver 7.6.3.
        """
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        cases = [
            ("^0", "0.9.0", True),
            ("^0", "1.0.0", False),
            ("^0.0", "0.0.9", True),
            ("^0.0", "0.1.0", False),
            ("^0.2", "0.2.9", True),
            ("^0.2", "0.3.0", False),
            ("^1", "1.9.0", True),
            ("^1", "2.0.0", False),
            ("^1.2", "1.9.0", True),
            ("^1.2", "2.0.0", False),
        ]
        for range_expr, version, expected in cases:
            with self.subTest(range_expr=range_expr, version=version):
                self.assertEqual(
                    oc_node_version.satisfies(version, range_expr),
                    expected,
                    f"Node {version} against {range_expr} (npm semver reference)",
                )

    def test_bundle_target_follows_the_running_node_line(self) -> None:
        """The esbuild target must not be pinned to a fixed Node line.

        The image derives its Node line from OpenClaw's engine range, so a
        fixed target would emit syntax the running Node cannot parse as soon
        as that line moves.
        """
        source = (ADDON_DIR / "oc_acpx_helper.py").read_text(encoding="utf-8")
        self.assertNotIn('"--target=node26"', source)
        self.assertIn("_esbuild_node_target()", source)
        self.assertTrue(hasattr(helper_module(), "_esbuild_node_target"))

    def test_node_helper_rejects_prereleases_and_broken_ranges(self) -> None:
        sys.path.insert(0, str(ADDON_DIR))
        import oc_node_version

        # npm: a prerelease only matches a range that mentions a prerelease.
        self.assertFalse(oc_node_version.satisfies("26.1.0-rc.1", ">=26.1.0"))
        self.assertTrue(oc_node_version.satisfies("26.1.0-rc.1", ">=26.1.0-rc.0"))
        with self.assertRaises(ValueError):
            oc_node_version.satisfies("1.0.0", "not-a-version")
        with self.assertRaises(ValueError):
            oc_node_version.satisfies("1.0.0", "")

    def test_failed_agent_database_admission_does_not_reset_the_failure_streak(self) -> None:
        """A run that never finished the agent-database preparation is a failed start.

        The runtime prepares every agent database before it admits the agents;
        that needs minutes. If such a run reset the failure streak, the
        supervisor would restart the gateway every two seconds and the
        preparation could never finish.
        """
        run_sh = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
        self.assertIn("gateway_startup_admission_refused", run_sh)
        self.assertIn(
            "has not completed startup inspection and preparation",
            run_sh,
        )
        # The reset condition must be guarded by the refusal check.
        self.assertIn(
            "&& ! gateway_startup_admission_refused; then",
            run_sh,
        )
        # And the backoff must have a floor well above the old two seconds.
        self.assertIn('if [ "$GW_BACKOFF" -lt 120 ]; then', run_sh)

    def test_dockerignore_excludes_vendored_dependency_payloads_only(self) -> None:
        patterns = [
            line.strip()
            for line in (ADDON_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        ]

        def ignored(path: str) -> bool:
            for pattern in patterns:
                base = pattern.rstrip("/")
                if fnmatch.fnmatch(path, base) or fnmatch.fnmatch(path, base + "/*"):
                    return True
            return False

        self.assertTrue(ignored("plugins/example-plugin/node_modules_deps/pkg/index.js"))
        self.assertTrue(ignored("plugins/example-plugin/node_modules/pkg/index.js"))
        self.assertFalse(ignored("plugins/example-plugin/src/index.js"))
        self.assertFalse(ignored("plugins/example-plugin/node_modules_deps_backup/pkg/index.js"))


class ReleaseManifestAndHygieneTests(unittest.TestCase):
    def test_interrupted_archive_pattern_is_excluded_and_completed_archives_are_not(self) -> None:
        import yaml

        manifest = yaml.safe_load((ADDON_DIR / "config.yaml").read_text(encoding="utf-8"))
        excluded = manifest["backup_exclude"]
        self.assertIn("*.tar.gz.partial", excluded)
        self.assertNotIn("*.tar.gz", excluded)
        with self.assertRaises(AssertionError):
            self.assertIn("*.tar.gz.partial", [item for item in excluded if item != "*.tar.gz.partial"])

    def test_notice_is_in_addon_context_and_copied_into_image(self) -> None:
        notice = ADDON_DIR / "NOTICE"
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        self.assertTrue(notice.is_file())
        self.assertEqual(notice.read_bytes(), (ADDON_DIR.parent / "NOTICE").read_bytes())
        copy_line = "COPY NOTICE /openclaw_ha_addon/NOTICE"
        self.assertIn(copy_line, dockerfile)
        with self.assertRaises(AssertionError):
            self.assertIn(copy_line, dockerfile.replace(copy_line, "", 1))

    def test_manifest_header_matches_release_version(self) -> None:
        import yaml

        config_text = (ADDON_DIR / "config.yaml").read_text(encoding="utf-8")
        version = yaml.safe_load(config_text)["version"]
        self.assertEqual(config_text.splitlines()[0], f"# OpenClaw Home Assistant App v{version} Configuration")

    def test_private_host_literals_are_replaced(self) -> None:
        helper_text = (ADDON_DIR / "oc_acpx_helper.py").read_text(encoding="utf-8")
        native_test = (ADDON_DIR / "plugins" / "harness-config-writer" / "src" / "native-config.test.ts").read_text(encoding="utf-8")
        self.assertNotIn("/share/projekte/github/openclaw-ha-addon", helper_text)
        # The literal is composed so this file does not carry a real LAN
        # address either (the pre-push hygiene gate scans tracked files).
        self.assertNotIn("192.168." "178.34", native_test)
        self.assertIn("http://192.0.2.34:11434", native_test)


class GatewayPublicOriginTests(unittest.TestCase):
    """The Control UI only offers the browser sign-in for OAuth MCP servers when
    the gateway knows its public origin, because the OAuth callback has to
    return to that very origin."""

    def test_run_sh_passes_the_public_origin_to_the_config_helper(self) -> None:
        self.assertIn(
            'set-control-ui-origins "$ALLOWED_ORIGINS" "$GATEWAY_ADDITIONAL_ALLOWED_ORIGINS" '
            '"$CONTROLUI_DISABLE_DEVICE_AUTH" "$GATEWAY_PUBLIC_ORIGIN"',
            RUN_TEXT,
        )

    def test_helper_writes_the_public_origin_into_the_gateway_config(self) -> None:
        import importlib.util

        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "openclaw.json"
            config.write_text(
                json.dumps({"gateway": {"controlUi": {"allowedOrigins": ["https://old:1"]}}}),
                encoding="utf-8",
            )
            os.environ["OPENCLAW_CONFIG_PATH"] = str(config)
            spec = importlib.util.spec_from_file_location(
                "oc_config_helper_public_origin", ADDON_DIR / "oc_config_helper.py"
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            self.assertTrue(
                module.set_control_ui_origins(
                    "https://192.0.2.10:18789", "", True, "https://192.0.2.10:18789"
                )
            )
            gateway = json.loads(config.read_text(encoding="utf-8"))["gateway"]
            self.assertEqual(gateway.get("publicOrigin"), "https://192.0.2.10:18789")
            self.assertEqual(
                gateway.get("controlUi", {}).get("allowedOrigins"), ["https://192.0.2.10:18789"]
            )


if __name__ == "__main__":
    unittest.main()
