#!/usr/bin/env python3
"""Hermetic regression tests for native Home Assistant MCP configuration."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
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
        self.log = self.root / "calls.jsonl"
        self.ha_token = "test-home-assistant-credential"
        self.supervisor_token = "test-supervisor-credential"
        self.mcp_url = "https://ha-mcp.example.test/private-test-connect-path"
        self.mcp_token = "test-mcp-bearer-credential"
        self.oauth_url = "http://ha.example.test/api/mcp"
        self.openclaw_config = self.config / "openclaw.json"
        self.openclaw_config.write_text("{}\n", encoding="utf-8")
        self.api_token_file = self.root / "secrets" / "homeassistant.token"
        self.api_token_file.parent.mkdir()
        self.registry = self.xdg / "mcporter" / "mcporter.json"
        self.project_registry = self.root / "project" / "mcporter.json"

        # mcporter and npm are fail-closed sentinels: any startup automation
        # attempt is recorded and returns a nonzero status.
        for name in ("mcporter", "npm", "curl", "timeout", "openclaw"):
            self.write_stub(name, self.bin / name)

        self.env = {
            "PATH": f"{self.bin}:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.xdg),
            "OPENCLAW_CONFIG_DIR": str(self.config),
            "AUTO_CONFIGURE_MCP": "true",
            "HA_TOKEN": self.ha_token,
            "SUPERVISOR_TOKEN": self.supervisor_token,
            "HA_MCP_URL": self.mcp_url,
            "HA_MCP_TOKEN": "",
            "HA_OAUTH_MCP_URL": "",
            "OPENCLAW_CONFIG_PATH": str(self.openclaw_config),
            "MCP_TEST_LOG": str(self.log),
            "STUB_CURL_STATUS": "200",
            "STUB_CURL_EXIT": "0",
        }

    def write_stub(self, name: str, path: Path) -> None:
        del name  # The dispatched name comes from argv[0], including symlinks.
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"#!{sys.executable}\n"
            """import json
import os
from pathlib import Path
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
    "has_ha_mcp_token": bool(os.environ.get("HA_MCP_TOKEN")),
}
with open(os.environ["MCP_TEST_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record) + "\\n")

if name == "timeout":
    if len(args) < 2:
        raise SystemExit(2)
    os.execvpe(args[1], args[1:], os.environ)

if name in {"mcporter", "npm"}:
    raise SystemExit(99)

if name == "openclaw" and args[:2] == ["mcp", "status"]:
    requires_auth = os.environ.get("STUB_OPENCLAW_AUTH_REQUIRED") == "1"
    payload = {"servers": [
        {"name": "ha", "ok": True, "authStatus": {"requiresAuthorization": False, "state": "authorized"}},
        {"name": "ha_official", "ok": True, "authStatus": {"requiresAuthorization": requires_auth, "state": "authorization-required" if requires_auth else "authorized"}},
    ]}
    if os.environ.get("STUB_OPENCLAW_INCLUDE_SECRET") == "1":
        payload["privateDiagnostic"] = [os.environ.get("HA_MCP_TOKEN", ""), os.environ.get("STUB_PRIVATE_URL", "")]
    print(json.dumps(payload))
    raise SystemExit(int(os.environ.get("STUB_OPENCLAW_STATUS_EXIT", "0")))

if name == "openclaw" and args[:2] == ["mcp", "doctor"]:
    requires_auth = os.environ.get("STUB_OPENCLAW_DOCTOR_AUTH_REQUIRED") == "1"
    payload = {"ok": not requires_auth, "servers": [{
        "name": args[2],
        "probe": {"tools": int(os.environ.get("STUB_OPENCLAW_TOOLS", "3"))},
        "issues": ([{"message": "OAuth credentials are not authorized; run openclaw mcp login " + args[2]}] if requires_auth else []),
    }]}
    if os.environ.get("STUB_OPENCLAW_INCLUDE_SECRET") == "1":
        payload["privateDiagnostic"] = [os.environ.get("HA_MCP_TOKEN", ""), os.environ.get("STUB_PRIVATE_URL", "")]
    print(json.dumps(payload))
    raise SystemExit(int(os.environ.get("STUB_OPENCLAW_DOCTOR_EXIT", "1" if requires_auth else "0")))

if name == "curl":
    print(os.environ.get("STUB_CURL_STATUS", "200"), end="")
    raise SystemExit(int(os.environ.get("STUB_CURL_EXIT", "0")))

raise SystemExit(0)
""",
            encoding="utf-8",
        )
        path.chmod(0o755)

    def configure(
        self,
        *,
        env: dict[str, str] | None = None,
        source: str = RUN_TEXT,
        include_api_token: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        function_names = [
            "upsert_openclaw_mcp_server",
            "verify_openclaw_mcp_server",
            "configure_openclaw_mcp_entry",
            "configure_ha_mcp",
        ]
        invocations = "configure_ha_mcp\n"
        if include_api_token:
            function_names.insert(0, "configure_homeassistant_api_token")
            invocations = (
                f"configure_homeassistant_api_token {shlex.quote(str(self.api_token_file))}\n"
                + invocations
            )
        script = (
            "set -euo pipefail\n"
            + "\n\n".join(shell_function(name, source) for name in function_names)
            + "\n"
            + invocations
            + "printf 'BOOT_CONTINUED\\n'\n"
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
        effective_env = env or self.env
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)
        self.assertNotIn(self.oauth_url, result.stdout + result.stderr)
        if effective_env.get("HA_MCP_TOKEN"):
            self.assertNotIn(self.mcp_token, result.stdout + result.stderr)
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

    def assert_booted(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("BOOT_CONTINUED", result.stdout)

    def assert_no_forbidden_tools(self) -> None:
        self.assertEqual(self.calls("mcporter"), [])
        self.assertEqual(self.calls("npm"), [])

    def assert_timeout_call(self, duration: str, *arguments: str) -> None:
        for call in self.calls("timeout"):
            args = call["args"]
            if args[:1] == [duration] and all(argument in args for argument in arguments):
                return
        self.fail(f"missing timeout {duration} for {arguments}: {self.calls('timeout')}")

    def write_registry(self, path: Path, servers: dict, *, mode: int = 0o600) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"mcpServers": servers, "preserved": {"enabled": True}}, indent=2) + "\n",
            encoding="utf-8",
        )
        path.chmod(mode)

    def test_way_3_without_token_registers_natively_without_mcporter_or_npm(self) -> None:
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://user-owned"}})
        registry_before = self.registry.read_bytes()

        result = self.configure()

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha"]
        self.assertEqual(definition, {
            "url": self.mcp_url,
            "transport": "streamable-http",
            "connectionTimeoutMs": 10000,
            "requestTimeoutMs": 30000,
        })
        probes = self.calls("curl")
        self.assertEqual(len(probes), 1)
        probe = probes[0]["args"]
        self.assertEqual(probe[probe.index("--request") + 2], self.mcp_url)
        self.assertFalse(any(arg.startswith("Authorization:") for arg in probe))
        self.assertNotIn(self.ha_token, probe)
        self.assertNotIn(self.supervisor_token, probe)
        self.assertIn(INITIALIZE, probe)
        self.assertEqual(probe[probe.index("--max-time") + 1], "10")
        self.assertEqual(self.registry.read_bytes(), registry_before)
        self.assertFalse((self.config / ".mcp_ha_configured").exists())
        self.assertTrue((self.config / ".mcp_openclaw_ha_owned").is_file())
        self.assertEqual([call["args"] for call in self.calls("openclaw")], [
            ["mcp", "status", "--verbose", "--json"],
        ])
        self.assertIn("Home Assistant connection way 3 (community MCP, URL + bearer): connected", result.stdout)
        self.assert_timeout_call("30s", "/usr/bin/node", "--input-type=module")

    def test_way_3_openclaw_uses_only_environment_bearer_reference(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        env["HA_MCP_TOKEN"] = self.mcp_token

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        raw = self.openclaw_config.read_bytes()
        definition = json.loads(raw)["mcp"]["servers"]["ha"]
        self.assertEqual(definition["headers"], {"Authorization": "Bearer ${HA_MCP_TOKEN}"})
        self.assertNotIn(self.mcp_token.encode(), raw)
        self.assertTrue(all(call["has_ha_mcp_token"] for call in self.calls("openclaw")))
        probe = self.calls("curl")[0]["args"]
        self.assertIn(f"Authorization: Bearer {self.mcp_token}", probe)
        self.assertNotIn(f"Authorization: Bearer {self.supervisor_token}", probe)
        self.assertIn("Content-Type: application/json", probe)
        self.assertIn("Accept: application/json, text/event-stream", probe)
        self.assertNotIn(self.mcp_token, result.stdout + result.stderr)

    def test_failed_probe_preserves_all_registries_and_markers(self) -> None:
        original = '{"mcp":{"servers":{"operator":{"command":"keep"}}},"unrelated":[1,  2]}\n'
        self.openclaw_config.write_text(original, encoding="utf-8")
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://stale"}}, mode=0o640)
        self.write_registry(self.project_registry, {"HA": {"baseUrl": "http://project"}})
        legacy_marker = self.config / ".mcp_ha_configured"
        legacy_marker.write_text("legacy-marker", encoding="utf-8")
        native_marker = self.config / ".mcp_openclaw_ha_owned"
        native_marker.write_text("native-marker", encoding="utf-8")
        before = tuple(path.read_bytes() for path in (
            self.openclaw_config, self.registry, self.project_registry, legacy_marker, native_marker,
        ))
        env = self.env.copy()
        env["STUB_CURL_STATUS"] = "401"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("probe failed", result.stdout)
        self.assertIn("HTTP 401", result.stdout)
        self.assertIn("leaving every existing MCP entry untouched", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.calls("openclaw"), [])
        after = tuple(path.read_bytes() for path in (
            self.openclaw_config, self.registry, self.project_registry, legacy_marker, native_marker,
        ))
        self.assertEqual(after, before)
        self.assertEqual(stat.S_IMODE(self.registry.stat().st_mode), 0o640)

    def test_probe_transport_failure_skips_registration_and_continues(self) -> None:
        before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["STUB_CURL_EXIT"] = "7"
        env["STUB_CURL_STATUS"] = "000"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("probe could not connect", result.stdout)
        self.assertIn("skipping registration", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(self.openclaw_config.read_bytes(), before)

    def test_switch_on_with_empty_urls_is_silent_and_does_nothing(self) -> None:
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://user-owned"}})
        before = self.registry.read_bytes()
        openclaw_before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = ""
        env["HA_MCP_TOKEN"] = self.mcp_token

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertEqual(result.stdout, "BOOT_CONTINUED\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertEqual(self.openclaw_config.read_bytes(), openclaw_before)
        self.assertFalse((self.config / ".mcp_ha_configured").exists())

    def test_switch_off_with_urls_is_silent_and_does_nothing(self) -> None:
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://user-owned"}})
        before = self.registry.read_bytes()
        openclaw_before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["AUTO_CONFIGURE_MCP"] = "false"
        env["HA_OAUTH_MCP_URL"] = self.oauth_url
        env["HA_MCP_TOKEN"] = self.mcp_token

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertEqual(result.stdout, "BOOT_CONTINUED\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertEqual(self.openclaw_config.read_bytes(), openclaw_before)

    def test_missing_timeout_warns_and_skips_external_mcp_calls(self) -> None:
        (self.bin / "timeout").unlink()
        before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["PATH"] = str(self.bin)

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertIn("coreutils timeout was not found", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.openclaw_config.read_bytes(), before)

    def test_missing_curl_skips_only_way_3_without_tool_repair(self) -> None:
        (self.bin / "curl").unlink()
        before = self.openclaw_config.read_bytes()

        result = self.configure(env={**self.env, "PATH": str(self.bin)})

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("curl was not found", result.stdout)
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(self.openclaw_config.read_bytes(), before)

    def test_no_startup_mcporter_install_or_repair_route_remains(self) -> None:
        function = shell_function("configure_ha_mcp").lower()
        self.assertNotIn("mcporter", function)
        self.assertNotIn("npm", function)
        self.assertNotIn(".mcp_ha_configured", function)
        dockerfile = (ADDON_DIR / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("npm install -g mcporter@0.17.1", dockerfile)

    def test_way_2_writes_oauth_definition_without_mcporter_or_npm(self) -> None:
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = self.oauth_url

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha_official"]
        self.assertEqual(definition, {
            "url": self.oauth_url,
            "transport": "streamable-http",
            "auth": "oauth",
            "oauth": {
                "clientMetadataUrl": "https://clawhub.ai/oauth/clients/openclaw.json",
                "redirectUrl": "http://localhost:8989/oauth/callback",
            },
            "connectionTimeoutMs": 10000,
            "requestTimeoutMs": 30000,
        })
        self.assertNotIn(self.ha_token, self.openclaw_config.read_text(encoding="utf-8"))
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual([call["args"] for call in self.calls("openclaw")], [
            ["mcp", "status", "--verbose", "--json"],
        ])
        self.assertIn("Home Assistant connection way 2 (official MCP, OAuth): connected", result.stdout)

    def test_way_2_identical_definition_does_not_write_again(self) -> None:
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = self.oauth_url
        first = self.configure(env=env)
        self.assert_booted(first)
        self.openclaw_config.chmod(0o640)
        before = self.openclaw_config.read_bytes()
        before_stat = self.openclaw_config.stat()
        marker_before = (self.config / ".mcp_openclaw_ha_official_owned").read_bytes()

        second = self.configure(env=env)

        self.assert_booted(second)
        self.assert_no_forbidden_tools()
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertEqual(self.openclaw_config.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(stat.S_IMODE(self.openclaw_config.stat().st_mode), 0o640)
        self.assertEqual((self.config / ".mcp_openclaw_ha_official_owned").read_bytes(), marker_before)

    def test_both_mcp_ways_preserve_foreign_openclaw_entries_byte_for_byte(self) -> None:
        original = (
            '{\n'
            '  "mcp": {\n'
            '    "servers": {\n'
            '      "operator"  : { "url": "http://operator.example", "headers": {"X-Test": "a  b"} },\n'
            '      "other": {"command":"/bin/example","args":[1,  2]}\n'
            '    }\n'
            '  },\n'
            '  "unrelated": [1,  2, {"keep": true}]\n'
            '}\n'
        )
        self.openclaw_config.write_text(original, encoding="utf-8")
        env = self.env.copy()
        env["HA_OAUTH_MCP_URL"] = self.oauth_url

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        updated_bytes = self.openclaw_config.read_bytes()
        foreign_operator = b'"operator"  : { "url": "http://operator.example", "headers": {"X-Test": "a  b"} }'
        foreign_other = b'"other": {"command":"/bin/example","args":[1,  2]}'
        unrelated = b'"unrelated": [1,  2, {"keep": true}]'
        self.assertEqual(updated_bytes.count(foreign_operator), 1)
        self.assertEqual(updated_bytes.count(foreign_other), 1)
        self.assertEqual(updated_bytes.count(unrelated), 1)
        servers = json.loads(updated_bytes)["mcp"]["servers"]
        self.assertIn("ha", servers)
        self.assertIn("ha_official", servers)

    def test_way_2_refuses_different_unowned_entry_without_any_probe(self) -> None:
        original = '{"mcp":{"servers":{"ha_official":{"url":"http://operator.example/api/mcp"},"operator":{"command":"keep"}}}}\n'
        self.openclaw_config.write_text(original, encoding="utf-8")
        before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = self.oauth_url

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("exists without the add-on ownership marker", result.stdout)
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertFalse((self.config / ".mcp_openclaw_ha_official_owned").exists())
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(self.calls("curl"), [])

    def test_way_3_refuses_different_unowned_entry_after_successful_probe(self) -> None:
        original = '{"mcp":{"servers":{"ha":{"url":"http://operator.example/mcp"},"operator":{"command":"keep"}}}}\n'
        self.openclaw_config.write_text(original, encoding="utf-8")
        before = self.openclaw_config.read_bytes()

        result = self.configure()

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("way 3 (community MCP, URL + bearer): OpenClaw MCP server 'ha' exists without the add-on ownership marker", result.stdout)
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertFalse((self.config / ".mcp_openclaw_ha_owned").exists())
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(len(self.calls("curl")), 1)

    def test_way_2_authorization_required_prints_exact_login_and_no_fallback(self) -> None:
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_MCP_TOKEN"] = self.mcp_token
        env["HA_OAUTH_MCP_URL"] = self.oauth_url
        env["STUB_OPENCLAW_AUTH_REQUIRED"] = "1"
        env["STUB_OPENCLAW_INCLUDE_SECRET"] = "1"
        env["STUB_PRIVATE_URL"] = self.oauth_url

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("Home Assistant connection way 2 (official MCP, OAuth): authorization-required", result.stdout)
        self.assertIn("Run exactly: openclaw mcp login ha_official", result.stdout)
        connection_lines = [
            line for line in result.stdout.splitlines() if "Home Assistant connection" in line
        ]
        self.assertEqual(connection_lines, [
            "INFO: Home Assistant connection way 2 (official MCP, OAuth): "
            "authorization-required; Run exactly: openclaw mcp login ha_official"
        ])
        self.assertNotIn("connected", result.stdout)
        self.assertEqual([call["args"] for call in self.calls("openclaw")], [["mcp", "status", "--verbose", "--json"]])
        self.assertEqual(self.calls("curl"), [])

    def test_startup_never_runs_the_offline_doctor_probe(self) -> None:
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = self.oauth_url
        env["STUB_OPENCLAW_DOCTOR_AUTH_REQUIRED"] = "1"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        # `mcp doctor --probe` needs exclusive offline state ownership and can
        # never succeed while the Gateway is running, so startup must not use it.
        self.assertEqual([call["args"] for call in self.calls("openclaw")], [["mcp", "status", "--verbose", "--json"]])
        self.assertNotIn("doctor", result.stdout)
        self.assertEqual(self.calls("curl"), [])

    def test_status_never_echoes_secret_diagnostics(self) -> None:
        env = self.env.copy()
        env["HA_MCP_TOKEN"] = self.mcp_token
        env["STUB_OPENCLAW_INCLUDE_SECRET"] = "1"
        env["STUB_PRIVATE_URL"] = self.mcp_url
        env["STUB_OPENCLAW_DOCTOR_EXIT"] = "1"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("Home Assistant connection way 3 (community MCP, URL + bearer): connected", result.stdout)
        self.assertNotIn("privateDiagnostic", result.stdout + result.stderr)
        self.assertNotIn(self.mcp_token, result.stdout + result.stderr)
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)

    def test_way_1_stores_private_token_and_announces_without_probing(self) -> None:
        env = self.env.copy()
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = ""

        result = self.configure(env=env, include_api_token=True)

        self.assert_booted(result)
        self.assertEqual(self.api_token_file.read_text(encoding="utf-8"), self.ha_token)
        self.assertEqual(stat.S_IMODE(self.api_token_file.stat().st_mode), 0o600)
        self.assertEqual(
            [line for line in result.stdout.splitlines() if "Home Assistant connection" in line],
            ["INFO: Home Assistant connection way 1 (API, long-lived token): token stored for API/Assist/scripts"],
        )
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertEqual(self.calls(), [])

    def test_no_connection_way_is_silent_and_touches_no_state(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""
        env["HA_MCP_URL"] = ""
        env["HA_OAUTH_MCP_URL"] = ""
        env["HA_MCP_TOKEN"] = self.mcp_token
        before = self.openclaw_config.read_bytes()

        result = self.configure(env=env, include_api_token=True)

        self.assert_booted(result)
        self.assertEqual(result.stdout, "BOOT_CONTINUED\n")
        self.assertEqual(result.stderr, "")
        self.assertFalse(self.api_token_file.exists())
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertEqual(self.calls(), [])

    def test_all_three_ways_emit_exactly_three_ordered_secret_free_lines(self) -> None:
        env = self.env.copy()
        env["HA_OAUTH_MCP_URL"] = self.oauth_url
        env["HA_MCP_TOKEN"] = self.mcp_token
        env["STUB_OPENCLAW_INCLUDE_SECRET"] = "1"
        env["STUB_PRIVATE_URL"] = self.mcp_url

        result = self.configure(env=env, include_api_token=True)

        self.assert_booted(result)
        connection_lines = [
            line for line in result.stdout.splitlines() if "Home Assistant connection" in line
        ]
        self.assertEqual(connection_lines, [
            "INFO: Home Assistant connection way 1 (API, long-lived token): token stored for API/Assist/scripts",
            "INFO: Home Assistant connection way 2 (official MCP, OAuth): connected",
            "INFO: Home Assistant connection way 3 (community MCP, URL + bearer): connected",
        ])
        self.assertEqual(
            [line for line in result.stdout.splitlines() if "MCP" in line],
            connection_lines[1:],
        )
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.mcp_token, result.stdout + result.stderr)
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)
        self.assertNotIn(self.oauth_url, result.stdout + result.stderr)
        self.assertEqual(self.api_token_file.read_text(encoding="utf-8"), self.ha_token)

    def test_ha_and_supervisor_tokens_are_not_mcp_credentials(self) -> None:
        function = shell_function("configure_ha_mcp")
        self.assertNotIn("HA_TOKEN", function)
        self.assertNotIn("SUPERVISOR_TOKEN", function)

        result = self.configure()

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        for call in self.calls("curl"):
            self.assertNotIn(self.ha_token, call["args"])
            self.assertNotIn(self.supervisor_token, call["args"])
            self.assertFalse(any(arg.startswith("Authorization") for arg in call["args"]))


    def write_local_mcp_config(self, payload: str) -> Path:
        path = self.root / "ha-mcp.json"
        path.write_text(payload, encoding="utf-8")
        return path

    def local_mcp_env(self, **overrides: str) -> dict[str, str]:
        env = self.env.copy()
        # The app parses the local file with python3; the stub directory alone
        # does not provide it, so the real PATH is appended behind the stubs.
        env["PATH"] = f"{self.bin}:{os.environ.get('PATH', '')}"
        env.update(overrides)
        return env

    def test_local_mcp_config_file_fills_empty_options_and_enables_the_switch(self) -> None:
        env = self.local_mcp_env(
            HA_MCP_URL="",
            HA_OAUTH_MCP_URL="",
            AUTO_CONFIGURE_MCP="false",
            LOCAL_MCP_CONFIG=str(self.write_local_mcp_config(json.dumps({
                "ha_mcp_url": self.mcp_url,
                "ha_oauth_mcp_url": self.oauth_url,
                "auto_configure_mcp": True,
            }))),
        )

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertEqual(servers["ha"]["url"], self.mcp_url)
        self.assertEqual(servers["ha_official"]["url"], self.oauth_url)
        self.assertEqual(servers["ha_official"]["auth"], "oauth")
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)

    def test_add_on_options_win_over_the_local_mcp_config_file(self) -> None:
        env = self.local_mcp_env(
            HA_MCP_URL=self.mcp_url,
            HA_OAUTH_MCP_URL=self.oauth_url,
            LOCAL_MCP_CONFIG=str(self.write_local_mcp_config(json.dumps({
                "ha_mcp_url": "http://from-file.invalid/mcp",
                "ha_oauth_mcp_url": "http://from-file.invalid/api/mcp",
            }))),
        )

        result = self.configure(env=env)

        self.assert_booted(result)
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertEqual(servers["ha"]["url"], self.mcp_url)
        self.assertEqual(servers["ha_official"]["url"], self.oauth_url)
        self.assertNotIn("from-file.invalid", json.dumps(servers))

    def test_local_mcp_config_file_can_enable_the_switch_only(self) -> None:
        env = self.local_mcp_env(
            AUTO_CONFIGURE_MCP="false",
            HA_MCP_URL="",
            LOCAL_MCP_CONFIG=str(self.write_local_mcp_config(json.dumps({
                "ha_mcp_url": self.mcp_url,
                "auto_configure_mcp": True,
            }))),
        )

        result = self.configure(env=env)

        self.assert_booted(result)
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertEqual(servers["ha"]["url"], self.mcp_url)
        self.assertNotIn("ha_official", servers)

    def test_broken_local_mcp_config_file_is_a_silent_noop(self) -> None:
        env = self.local_mcp_env(
            AUTO_CONFIGURE_MCP="false",
            HA_MCP_URL="",
            HA_OAUTH_MCP_URL="",
            LOCAL_MCP_CONFIG=str(self.write_local_mcp_config("{ not json")),
        )

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.calls("openclaw"), [])
        if self.openclaw_config.exists():
            servers = (
                json.loads(self.openclaw_config.read_text(encoding="utf-8"))
                .get("mcp", {})
                .get("servers", {})
            )
            self.assertEqual(servers, {})


if __name__ == "__main__":
    unittest.main()
