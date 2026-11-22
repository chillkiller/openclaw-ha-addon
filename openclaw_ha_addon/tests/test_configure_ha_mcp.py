#!/usr/bin/env python3
"""Hermetic regression tests for the standard Home Assistant MCP route."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


ADDON_DIR = Path(__file__).resolve().parents[1]
RUN_TEXT = (ADDON_DIR / "run.sh").read_text(encoding="utf-8")
INITIALIZE = (
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":'
    '{"protocolVersion":"2024-11-05","capabilities":{},'
    '"clientInfo":{"name":"probe","version":"0"}}}'
)


def shell_function(name: str, source: str = RUN_TEXT) -> str:
    lines = source.splitlines()
    start = lines.index(f"{name}() {{")
    end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[start : end + 1])


class ConfigureHaMcpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.home = self.root / "home"
        self.home.mkdir()
        self.xdg = self.root / "xdg"
        self.xdg.mkdir()
        self.config = self.root / "config"
        self.config.mkdir()
        self.homebrew_bin = self.root / "homebrew" / "bin"
        self.homebrew_bin.mkdir(parents=True)
        self.log = self.root / "calls.jsonl"
        self.ha_token = "test-home-assistant-credential"
        self.supervisor_token = "test-supervisor-credential"
        self.npm_prefix = self.root / "node_global"
        self.package = self.npm_prefix / "lib" / "node_modules" / "mcporter"
        self.mcporter = self.package / "dist" / "cli.js"
        self.mcporter_link = self.npm_prefix / "bin" / "mcporter"
        self.mcporter_template = self.root / "mcporter-template"
        self.version_state = self.root / "installed-version"
        self.registry = self.xdg / "mcporter" / "mcporter.json"
        self.project_registry = self.root / "config" / "mcporter.json"

        self.write_stub("mcporter", self.mcporter_template)
        self.install_mcporter_stub()
        for name in ("npm", "curl", "timeout", "sha256sum"):
            self.write_stub(name, self.bin / name)

        # The cleanup implementation imports this rule from the installed
        # package. Mirror the pinned module's XDG/HOME behavior in the fixture.
        (self.package / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
        (self.package / "dist" / "paths.js").write_text(
            "import os from 'node:os';\n"
            "import path from 'node:path';\n"
            "export function mcporterDir(kind) {\n"
            "  const names = {config: 'XDG_CONFIG_HOME', data: 'XDG_DATA_HOME', state: 'XDG_STATE_HOME', cache: 'XDG_CACHE_HOME'};\n"
            "  const raw = process.env[names[kind]];\n"
            "  if (raw && raw.trim() && path.isAbsolute(raw.trim())) return path.join(raw.trim(), 'mcporter');\n"
            "  return path.join(os.homedir(), '.mcporter');\n"
            "}\n",
            encoding="utf-8",
        )

        (self.package / "dist" / "fs-json.js").write_text(
            "import fs from 'node:fs';\n"
            "import path from 'node:path';\n"
            "export async function withFileLock(_filePath, task) { return task(); }\n"
            "export async function writeTextFileAtomic(filePath, data) {\n"
            "  const target = fs.realpathSync(filePath);\n"
            "  const mode = fs.statSync(target).mode & 0o7777;\n"
            "  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);\n"
            "  try {\n"
            "    fs.writeFileSync(temporary, data, {encoding: 'utf8', flag: 'wx', mode});\n"
            "    fs.chmodSync(temporary, mode);\n"
            "    fs.renameSync(temporary, target);\n"
            "  } finally { try { fs.unlinkSync(temporary); } catch {} }\n"
            "}\n",
            encoding="utf-8",
        )

        self.env = {
            "PATH": f"{self.bin}:{self.homebrew_bin}:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.xdg),
            "OPENCLAW_CONFIG_DIR": str(self.config),
            "AUTO_CONFIGURE_MCP": "true",
            "HA_TOKEN": self.ha_token,
            "SUPERVISOR_TOKEN": self.supervisor_token,
            "MCP_TEST_LOG": str(self.log),
            "STUB_MCPORTER_VERSION": "0.17.0",
            "STUB_MCPORTER_VERSION_EXIT": "0",
            "STUB_MCPORTER_SOURCE": str(self.mcporter_template),
            "STUB_MCPORTER_TARGET": str(self.mcporter),
            "STUB_MCPORTER_STATE": str(self.version_state),
            "STUB_NPM_PREFIX": str(self.npm_prefix),
            "STUB_CURL_STATUS": "200",
            "STUB_CURL_EXIT": "0",
            "STUB_NPM_EXIT": "0",
            "STUB_SHA256SUM_EXIT": "0",
        }

    def write_stub(self, name: str, path: Path) -> None:
        del name  # The dispatched name comes from argv[0], including symlinks.
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"#!{sys.executable}\n"
            """import json
import os
from pathlib import Path
import shutil
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
record = {
    "tool": name,
    "args": args,
    "executable": str(Path(sys.argv[0]).resolve()),
    "path": os.environ.get("PATH", ""),
    "home": os.environ.get("HOME", ""),
    "xdg": os.environ.get("XDG_CONFIG_HOME", ""),
}
with open(os.environ["MCP_TEST_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record) + "\\n")

if name == "timeout":
    os.execv("/usr/bin/timeout", ["/usr/bin/timeout", *args])

if name == "sha256sum":
    status = int(os.environ.get("STUB_SHA256SUM_EXIT", "0"))
    if status:
        raise SystemExit(status)
    os.execv("/usr/bin/sha256sum", ["/usr/bin/sha256sum", *args])

if name == "mcporter" and args == ["--version"]:
    state = Path(os.environ["STUB_MCPORTER_STATE"])
    version = state.read_text(encoding="utf-8").strip() if state.exists() else os.environ.get("STUB_MCPORTER_VERSION", "")
    if version:
        print(version)
        raise SystemExit(int(os.environ.get("STUB_MCPORTER_VERSION_EXIT", "0")))
    raise SystemExit(127)

if name == "mcporter" and args[:3] == ["config", "add", "HA"]:
    if "--scope" not in args or args[args.index("--scope") + 1] != "home":
        raise SystemExit(2)
    xdg = os.environ.get("XDG_CONFIG_HOME", "")
    registry = Path(xdg) / "mcporter" / "mcporter.json" if xdg else Path(os.environ["HOME"]) / ".mcporter" / "mcporter.json"
    registry.parent.mkdir(parents=True, exist_ok=True)
    config = json.loads(registry.read_text(encoding="utf-8")) if registry.exists() else {}
    config.setdefault("mcpServers", {})["HA"] = {
        "baseUrl": args[3],
        "headers": {"Authorization": args[args.index("--header") + 1]},
    }
    registry.write_text(json.dumps(config, indent=2) + "\\n", encoding="utf-8")

if name == "mcporter" and args != ["--version"] and os.environ.get("STUB_MCPORTER_ECHO_ARGS") == "1":
    print(" ".join(args))

if name == "curl":
    print(os.environ.get("STUB_CURL_STATUS", "200"), end="")
    raise SystemExit(int(os.environ.get("STUB_CURL_EXIT", "0")))

if name == "npm" and args == ["prefix", "-g"]:
    print(os.environ["STUB_NPM_PREFIX"])
    raise SystemExit(0)

if name == "npm":
    status = int(os.environ.get("STUB_NPM_EXIT", "0"))
    if status:
        print("simulated npm install failure", file=sys.stderr)
        raise SystemExit(status)
    if args[:1] == ["install"]:
        Path(os.environ["STUB_MCPORTER_STATE"]).write_text("0.17.0", encoding="utf-8")
        target = Path(os.environ["STUB_MCPORTER_TARGET"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(os.environ["STUB_MCPORTER_SOURCE"], target)
        target.chmod(0o755)
        prefix = Path(os.environ["STUB_NPM_PREFIX"])
        link = prefix / "bin" / "mcporter"
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.exists() and not link.is_symlink():
            link.symlink_to(Path("../lib/node_modules/mcporter/dist/cli.js"))
    raise SystemExit(0)

raise SystemExit(0)
""",
            encoding="utf-8",
        )
        path.chmod(0o755)

    def install_mcporter_stub(self) -> None:
        self.mcporter.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.mcporter_template, self.mcporter)
        self.mcporter.chmod(0o755)
        self.mcporter_link.parent.mkdir(parents=True, exist_ok=True)
        if not self.mcporter_link.exists() and not self.mcporter_link.is_symlink():
            self.mcporter_link.symlink_to(Path("../lib/node_modules/mcporter/dist/cli.js"))

    def configure(
        self,
        *,
        env: dict[str, str] | None = None,
        source: str = RUN_TEXT,
    ) -> subprocess.CompletedProcess[str]:
        script = (
            "set -euo pipefail\n"
            f"{shell_function('configure_ha_mcp', source)}\n"
            "configure_ha_mcp\n"
            "printf 'BOOT_CONTINUED\\n'\n"
        )
        result = subprocess.run(
            ["/bin/bash", "-c", script],
            text=True,
            capture_output=True,
            env=env or self.env,
            cwd=self.root,
            timeout=15,
            check=False,
        )
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)
        return result

    def calls(self, tool: str | None = None) -> list[dict]:
        if not self.log.exists():
            return []
        records = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        if tool is not None:
            records = [record for record in records if record["tool"] == tool]
        for record in records:
            self.assertEqual(record["home"], str(self.home))
            self.assertEqual(record["xdg"], str(self.xdg))
        return records

    def add_calls(self) -> list[dict]:
        return [
            record
            for record in self.calls("mcporter")
            if record["args"][:3] == ["config", "add", "HA"]
        ]

    def npm_install_calls(self) -> list[dict]:
        return [record for record in self.calls("npm") if record["args"][:1] == ["install"]]

    def assert_booted(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("BOOT_CONTINUED", result.stdout)

    def assert_timeout_call(self, duration: str, *arguments: str) -> None:
        for call in self.calls("timeout"):
            args = call["args"]
            if args[:1] == [duration] and all(argument in args for argument in arguments):
                return
        self.fail(f"missing timeout {duration} for {arguments}: {self.calls('timeout')}")

    def write_registry(self, path: Path, servers: dict, *, mode: int = 0o600) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"mcpServers": servers, "preserved": {"enabled": True}}, indent=2) + "\n", encoding="utf-8")
        path.chmod(mode)

    def test_home_assistant_token_authenticates_standard_route(self) -> None:
        result = self.configure()
        self.assert_booted(result)
        self.assertIn("MCP server 'HA' registered", result.stdout)
        adds = self.add_calls()
        self.assertEqual(len(adds), 1)
        args = adds[0]["args"]
        self.assertEqual(args[3], "http://supervisor/core/api/mcp")
        self.assertEqual(args[args.index("--header") + 1], f"Authorization=Bearer {self.ha_token}")
        probes = self.calls("curl")
        self.assertEqual(len(probes), 1)
        self.assertIn(f"Authorization: Bearer {self.ha_token}", probes[0]["args"])
        for call in self.calls("mcporter"):
            if call["args"][:1] == ["config"]:
                self.assertIn("HA", call["args"])
                self.assertNotIn("penpot", call["args"])
        self.assert_timeout_call("30s", "--version")
        self.assert_timeout_call("30s", "config", "add", "HA")

    def test_supervisor_fallback_probe_200_registers(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("MCP server 'HA' registered", result.stdout)
        adds = self.add_calls()
        self.assertEqual(len(adds), 1)
        args = adds[0]["args"]
        self.assertEqual(args[3], "http://supervisor/core/api/mcp")
        self.assertEqual(args[args.index("--header") + 1], f"Authorization=Bearer {self.supervisor_token}")
        probe = self.calls("curl")[0]["args"]
        self.assertIn(f"Authorization: Bearer {self.supervisor_token}", probe)
        self.assertIn("Content-Type: application/json", probe)
        self.assertIn("Accept: application/json, text/event-stream", probe)
        self.assertIn(INITIALIZE, probe)
        self.assertEqual(probe[probe.index("--max-time") + 1], "10")

    def test_supervisor_fallback_probe_401_skips_registration(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        env["STUB_CURL_STATUS"] = "401"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("could not authenticate", result.stdout)
        self.assertIn("HTTP 401", result.stdout)
        self.assertIn("skipping registration", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.add_calls(), [])
        self.assertFalse(any(call["args"][:1] == ["config"] for call in self.calls("mcporter")))

    def test_home_assistant_token_probe_401_skips_registration(self) -> None:
        env = self.env.copy()
        env["STUB_CURL_STATUS"] = "401"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("could not authenticate", result.stdout)
        self.assertIn("HTTP 401", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.add_calls(), [])
        self.assertFalse(any(call["args"][:1] == ["config"] for call in self.calls("mcporter")))

    def test_probe_transport_failure_skips_registration_and_continues(self) -> None:
        env = self.env.copy()
        env["STUB_CURL_EXIT"] = "7"
        env["STUB_CURL_STATUS"] = "000"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("probe could not connect", result.stdout)
        self.assertIn("skipping registration", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.add_calls(), [])

    def test_missing_mcporter_installs_pinned_version(self) -> None:
        self.mcporter.unlink()
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        env.pop("SUPERVISOR_TOKEN")
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("Ensuring mcporter 0.17.0", result.stdout)
        npm = self.npm_install_calls()
        self.assertEqual(len(npm), 1)
        self.assertEqual(npm[0]["args"], ["install", "-g", "mcporter@0.17.0"])
        self.assertEqual(self.calls("curl"), [])
        self.assertTrue(self.mcporter.is_file())
        self.assertEqual(self.version_state.read_text(encoding="utf-8"), "0.17.0")
        self.assert_timeout_call("120s", "install", "-g", "mcporter@0.17.0")

    def test_pinned_mcporter_requires_no_install(self) -> None:
        result = self.configure()
        self.assert_booted(result)
        self.assertIn("MCP server 'HA' registered", result.stdout)
        self.assertEqual(self.npm_install_calls(), [])
        self.assertTrue(any(call["args"] == ["--version"] for call in self.calls("mcporter")))

    def test_successful_repair_re_resolves_persistent_binary_probes_and_registers(self) -> None:
        image_mcporter = self.root / "image-bin" / "mcporter"
        self.write_stub("mcporter", image_mcporter)
        source = RUN_TEXT.replace("/usr/bin/mcporter", str(image_mcporter))
        self.assertNotEqual(source, RUN_TEXT)
        env = self.env.copy()
        env["STUB_MCPORTER_VERSION"] = "0.16.9"
        result = self.configure(env=env, source=source)
        self.assert_booted(result)
        self.assertIn("Ensuring mcporter 0.17.0", result.stdout)
        self.assertIn("MCP server 'HA' registered", result.stdout)
        self.assertEqual(len(self.npm_install_calls()), 1)
        versions = [call for call in self.calls("mcporter") if call["args"] == ["--version"]]
        self.assertEqual(len(versions), 2)
        self.assertEqual(versions[0]["executable"], str(image_mcporter.resolve()))
        self.assertEqual(versions[1]["executable"], str(self.mcporter.resolve()))
        self.assertEqual(self.add_calls()[0]["executable"], str(self.mcporter.resolve()))
        self.assertEqual(self.version_state.read_text(encoding="utf-8"), "0.17.0")
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(len(self.add_calls()), 1)
        self.assert_timeout_call("120s", "install", "mcporter@0.17.0")
        self.assert_timeout_call("30s", "config", "add", "HA")

    def test_npm_install_failure_warns_without_aborting_boot(self) -> None:
        env = self.env.copy()
        env["STUB_MCPORTER_VERSION"] = "0.16.9"
        env["STUB_NPM_EXIT"] = "1"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("WARN: Could not install mcporter 0.17.0", result.stdout)
        self.assertEqual(len(self.npm_install_calls()), 1)
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.add_calls(), [])

    def test_nonzero_version_output_is_not_accepted(self) -> None:
        env = self.env.copy()
        env["STUB_MCPORTER_VERSION"] = "0.17.0"
        env["STUB_MCPORTER_VERSION_EXIT"] = "9"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertEqual(len(self.npm_install_calls()), 1)
        self.assertIn("could not be verified after installation", result.stdout)
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.add_calls(), [])

    def test_missing_timeout_warns_and_skips_external_mcp_calls(self) -> None:
        (self.bin / "timeout").unlink()
        env = self.env.copy()
        env["PATH"] = str(self.bin)
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("coreutils timeout was not found", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_mcporter_path_prefers_image_node_over_homebrew(self) -> None:
        result = self.configure()
        self.assert_booted(result)
        calls = self.calls("mcporter")
        self.assertGreaterEqual(len(calls), 2)
        for call in calls:
            path = call["path"].split(":")
            self.assertEqual(path[0], "/usr/bin")
            self.assertLess(path.index("/usr/bin"), path.index(str(self.homebrew_bin)))

    def test_failing_sha256sum_warns_and_never_aborts_boot(self) -> None:
        env = self.env.copy()
        env["STUB_SHA256SUM_EXIT"] = "1"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("Could not hash the Home Assistant MCP configuration", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.add_calls(), [])

    def test_unwritable_marker_directory_warns_and_never_aborts_boot(self) -> None:
        (self.config / ".mcp_ha_configured").mkdir()
        result = self.configure()
        self.assert_booted(result)
        self.assertIn("ownership marker could not be written", result.stdout)
        self.assertEqual(len(self.add_calls()), 1)
        self.assertTrue((self.config / ".mcp_ha_configured").is_dir())

    def test_failed_probe_removes_marked_exact_home_entry_atomically(self) -> None:
        servers = {
            "HA": {"baseUrl": "http://stale", "headers": {"Authorization": "old"}},
            "ha": {"baseUrl": "http://user-lowercase"},
            "HA2": {"baseUrl": "http://user-similar"},
            "penpot": {"baseUrl": "http://user-penpot"},
        }
        self.write_registry(self.registry, servers, mode=0o640)
        project_servers = {"HA": {"baseUrl": "http://project"}, "penpot": {"baseUrl": "http://project-penpot"}}
        self.write_registry(self.project_registry, project_servers)
        project_before = self.project_registry.read_bytes()
        marker = self.config / ".mcp_ha_configured"
        marker.write_text("stale-configuration-hash", encoding="utf-8")
        env = self.env.copy()
        env["STUB_CURL_STATUS"] = "401"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertIn("Removed the stale add-on-owned HA entry", result.stdout)
        self.assertFalse(marker.exists())
        updated = json.loads(self.registry.read_text(encoding="utf-8"))
        self.assertNotIn("HA", updated["mcpServers"])
        self.assertEqual(updated["mcpServers"]["ha"], servers["ha"])
        self.assertEqual(updated["mcpServers"]["HA2"], servers["HA2"])
        self.assertEqual(updated["mcpServers"]["penpot"], servers["penpot"])
        self.assertEqual(updated["preserved"], {"enabled": True})
        self.assertEqual(stat.S_IMODE(self.registry.stat().st_mode), 0o640)
        self.assertEqual(self.project_registry.read_bytes(), project_before)
        self.assertEqual(self.add_calls(), [])
        self.assert_timeout_call("30s", "/usr/bin/node", "--input-type=module")

    def test_failed_probe_preserves_unmarked_entry_and_all_registries(self) -> None:
        servers = {"HA": {"baseUrl": "http://user-owned"}, "ha": {"baseUrl": "http://lowercase"}}
        self.write_registry(self.registry, servers)
        self.write_registry(self.project_registry, {"HA": {"baseUrl": "http://project"}})
        before = self.registry.read_bytes()
        project_before = self.project_registry.read_bytes()
        env = self.env.copy()
        env["STUB_CURL_STATUS"] = "401"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertNotIn("Removed the stale add-on-owned HA entry", result.stdout)
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertEqual(self.project_registry.read_bytes(), project_before)
        self.assertFalse(any("/usr/bin/node" in call["args"] for call in self.calls("timeout")))

    def test_add_changes_only_exact_home_ha_and_never_project_or_fuzzy_names(self) -> None:
        servers = {
            "HA": {"baseUrl": "http://old"},
            "ha": {"baseUrl": "http://user-lowercase"},
            "HA2": {"baseUrl": "http://user-similar"},
            "penpot": {"baseUrl": "http://user-penpot"},
        }
        self.write_registry(self.registry, servers)
        project_servers = {"HA": {"baseUrl": "http://project"}, "ha": {"baseUrl": "http://project-lowercase"}}
        self.write_registry(self.project_registry, project_servers)
        project_before = self.project_registry.read_bytes()

        result = self.configure()

        self.assert_booted(result)
        updated = json.loads(self.registry.read_text(encoding="utf-8"))
        self.assertEqual(updated["mcpServers"]["HA"]["baseUrl"], "http://supervisor/core/api/mcp")
        self.assertEqual(updated["mcpServers"]["ha"], servers["ha"])
        self.assertEqual(updated["mcpServers"]["HA2"], servers["HA2"])
        self.assertEqual(updated["mcpServers"]["penpot"], servers["penpot"])
        self.assertEqual(updated["preserved"], {"enabled": True})
        self.assertEqual(self.project_registry.read_bytes(), project_before)
        self.assertFalse(any(call["args"][:2] == ["config", "remove"] for call in self.calls("mcporter")))
        function = shell_function("configure_ha_mcp")
        self.assertNotRegex(function, r"\$mcporter_bin[^\n]*config\s+remove")

    def test_no_credential_value_reaches_stdout_or_stderr(self) -> None:
        env = self.env.copy()
        env["STUB_MCPORTER_ECHO_ARGS"] = "1"
        result = self.configure(env=env)
        self.assert_booted(result)
        self.assertIn("MCP server 'HA' registered", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(len(self.add_calls()), 1)
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)

    def test_old_supervisor_first_order_negative_control(self) -> None:
        old_order = RUN_TEXT.replace(
            'mcp_ha_token="$HA_TOKEN"',
            'mcp_ha_token="${SUPERVISOR_TOKEN:-$HA_TOKEN}"',
            1,
        )
        self.assertNotEqual(old_order, RUN_TEXT)
        result = self.configure(source=old_order)
        self.assert_booted(result)
        self.assertIn("MCP server 'HA' registered", result.stdout)
        adds = self.add_calls()
        self.assertEqual(len(adds), 1)
        args = adds[0]["args"]
        header = args[args.index("--header") + 1]
        self.assertEqual(header, f"Authorization=Bearer {self.supervisor_token}")
        self.assertNotEqual(header, f"Authorization=Bearer {self.ha_token}")


if __name__ == "__main__":
    unittest.main()
