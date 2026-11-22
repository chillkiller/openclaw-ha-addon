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
import subprocess
import tempfile
import time
import unittest


ADDON_DIR = Path(__file__).resolve().parents[1]
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


class HaMcpCredentialTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "config"
        self.config.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.npm_prefix = self.root / "npm-prefix"
        persistent_bin = self.npm_prefix / "bin"
        persistent_bin.mkdir(parents=True)
        self.log = self.root / "mcporter-log"
        self.probe_log = self.root / "probe-log"
        self.npm_log = self.root / "npm-log"
        mcporter = persistent_bin / "mcporter"
        mcporter.write_text(
            "#!/usr/bin/env bash\n"
            "if [ \"${1:-}\" = --version ]; then printf '0.17.1\\n'; exit 0; fi\n"
            "{ printf 'CALL'; printf '\\t%s' \"$@\"; printf '\\n'; } >> \"$MCPORTER_LOG\"\n",
            encoding="utf-8",
        )
        mcporter.chmod(0o755)
        curl = self.bin / "curl"
        curl.write_text(
            "#!/usr/bin/env bash\n"
            "{ printf 'PROBE'; printf '\\t%s' \"$@\"; printf '\\n'; } >> \"$MCP_PROBE_LOG\"\n"
            "printf '%s' \"${MCP_PROBE_STATUS:-200}\"\n",
            encoding="utf-8",
        )
        curl.chmod(0o755)
        npm = self.bin / "npm"
        npm.write_text(
            "#!/usr/bin/env bash\n"
            "if [ \"${1:-}\" = prefix ] && [ \"${2:-}\" = -g ]; then printf '%s\\n' \"$MCP_NPM_PREFIX\"; exit 0; fi\n"
            "{ printf 'NPM'; printf '\\t%s' \"$@\"; printf '\\n'; } >> \"$MCP_NPM_LOG\"\n",
            encoding="utf-8",
        )
        npm.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update(
            PATH=f"{self.bin}:{self.env['PATH']}",
            MCPORTER_LOG=str(self.log),
            MCP_PROBE_LOG=str(self.probe_log),
            MCP_NPM_LOG=str(self.npm_log),
            MCP_NPM_PREFIX=str(self.npm_prefix),
            HOME=str(self.root),
            XDG_CONFIG_HOME=str(self.root / "xdg"),
            OPENCLAW_CONFIG_DIR=str(self.config),
            AUTO_CONFIGURE_MCP="true",
            HA_TOKEN="user-token",
            SUPERVISOR_TOKEN="supervisor-token",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def configure(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return run_bash(["configure_ha_mcp"], "configure_ha_mcp", env=env)

    def test_supervisor_proxy_uses_ha_token_not_supervisor_token(self) -> None:
        result = self.configure(self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.log.exists(), result.stdout + result.stderr)
        calls = self.log.read_text(encoding="utf-8")
        self.assertIn("http://supervisor/core/api/mcp", calls)
        self.assertIn("Authorization=Bearer user-token", calls)
        self.assertNotIn("Authorization=Bearer supervisor-token", calls)
        self.assertIn("Authorization: Bearer user-token", self.probe_log.read_text(encoding="utf-8"))
        self.assertFalse(self.npm_log.exists())

    def test_supervisor_token_does_not_require_configured_ha_token(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.log.exists(), result.stdout + result.stderr)
        self.assertIn("Authorization=Bearer supervisor-token", self.log.read_text(encoding="utf-8"))
        self.assertIn("Authorization: Bearer supervisor-token", self.probe_log.read_text(encoding="utf-8"))

    def test_localhost_fallback_uses_ha_token(self) -> None:
        env = self.env.copy()
        env.pop("SUPERVISOR_TOKEN")
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.log.exists(), result.stdout + result.stderr)
        calls = self.log.read_text(encoding="utf-8")
        self.assertIn("http://localhost:8123/api/mcp", calls)
        self.assertIn("Authorization=Bearer user-token", calls)
        self.assertNotIn("supervisor-token", calls)
        self.assertIn("http://localhost:8123/api/mcp", self.probe_log.read_text(encoding="utf-8"))

    def test_failed_ha_token_probe_skips_registration_without_leaking(self) -> None:
        env = self.env.copy()
        env["MCP_PROBE_STATUS"] = "401"
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("could not authenticate", result.stdout)
        self.assertIn("skipping registration", result.stdout)
        self.assertFalse(self.log.exists())
        self.assertNotIn("user-token", result.stdout + result.stderr)
        self.assertNotIn("supervisor-token", result.stdout + result.stderr)

    def test_no_credentials_is_a_noop_negative_control(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        env.pop("SUPERVISOR_TOKEN")
        result = self.configure(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.log.exists())
        self.assertFalse(self.probe_log.exists())
        self.assertIn("no Supervisor or Home Assistant token", result.stdout)


class DockerGuardTests(unittest.TestCase):
    def test_image_node_is_exactly_pinned_and_used_for_openclaw_build(self) -> None:
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("ARG OPENCLAW_NODE_VERSION=24.22.3", dockerfile)
        self.assertIn('nodejs="${OPENCLAW_NODE_VERSION}-1nodesource1"', dockerfile)
        self.assertIn("NodeSource pin verified: '+process.versions.node", dockerfile)
        self.assertIn('RUN export PATH="/usr/bin:/bin:${PATH}";', dockerfile)
        self.assertNotIn("RUN node ", dockerfile)
        self.assertIn("npm install -g openclaw@2026.11.6", dockerfile)

    @unittest.skipUnless(NODE, "node is required to execute the engine gate")
    def test_node_engine_range_and_negative_controls(self) -> None:
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        line = next(line.strip() for line in dockerfile.splitlines() if "const [maj,min]" in line)
        script = line.split('node -e "', 1)[1].rsplit('"', 1)[0]
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
                executable = script.replace("process.versions.node", json.dumps(version))
                result = subprocess.run(
                    [NODE, "-e", executable], text=True, capture_output=True, timeout=10, check=False
                )
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)
                if not accepted:
                    self.assertIn(">=24.16.0 <25 or >=26.1.0", result.stderr)
        self.assertIn("npm install -g openclaw@2026.11.6", dockerfile)

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
        self.assertNotIn("192.168.178.34", native_test)
        self.assertIn("http://192.0.2.34:11434", native_test)


if __name__ == "__main__":
    unittest.main()
