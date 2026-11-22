#!/usr/bin/env python3
"""Hermetic regression tests for native Home Assistant MCP configuration."""

from __future__ import annotations

import json
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
        self.mcp_url = "https://community.example.test/private-test-connect-path"
        self.community_name = "ha-mcp-community-example-test"
        self.oauth_url = "http://ha.example.test/api/mcp"
        self.gateway_origin = "https://192.0.2.20:18789"
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
            "HA_TOKEN": self.ha_token,
            "SUPERVISOR_TOKEN": self.supervisor_token,
            "MCP_URLS": self.mcp_url,
            "MCP_ENABLED": "true",
            "HA_OFFICIAL_MCP_URL": "",
            "HA_OFFICIAL_MCP_ENABLED": "false",
            "GATEWAY_PUBLIC_ORIGIN": self.gateway_origin,
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
    with open(os.environ["OPENCLAW_CONFIG_PATH"], encoding="utf-8") as handle:
        server_names = list(json.load(handle).get("mcp", {}).get("servers", {}))
    payload = {"servers": [
        # The gateway reports one of: authorized, requires-authorization,
        # pending-authorization, unauthenticated (live observed on 2026-11-22:
        # "state": "unauthenticated" with "requiresAuthorization": false).
        {"name": server_name, "ok": True, "authStatus": {
            "requiresAuthorization": False,
            "state": "unauthenticated" if requires_auth and server_name == "ha-official" else "authorized",
        }}
        for server_name in server_names
    ]}
    if os.environ.get("STUB_OPENCLAW_INCLUDE_SECRET") == "1":
        payload["privateDiagnostic"] = [os.environ.get("STUB_PRIVATE_URL", "")]
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
        payload["privateDiagnostic"] = [os.environ.get("STUB_PRIVATE_URL", "")]
    print(json.dumps(payload))
    raise SystemExit(int(os.environ.get("STUB_OPENCLAW_DOCTOR_EXIT", "1" if requires_auth else "0")))

if name == "curl":
    url = args[args.index("--request") + 2]
    output = args[args.index("--output") + 1]
    if url == os.environ.get("STUB_CURL_FAIL_URL"):
        status = os.environ.get("STUB_CURL_FAIL_STATUS", "503")
        exit_code = int(os.environ.get("STUB_CURL_FAIL_EXIT", "0"))
    else:
        status = os.environ.get("STUB_CURL_STATUS", "200")
        exit_code = int(os.environ.get("STUB_CURL_EXIT", "0"))
    body = os.environ.get(
        "STUB_CURL_BODY",
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}',
    )
    Path(output).write_text(body, encoding="utf-8")
    print(status, end="")
    raise SystemExit(exit_code)

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
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)
        self.assertNotIn(self.oauth_url, result.stdout + result.stderr)
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


    def test_way_3_registers_natively_without_mcporter_or_npm(self) -> None:
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://user-owned"}})
        registry_before = self.registry.read_bytes()

        result = self.configure()

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        definition = servers[self.community_name]
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
        self.assertEqual(probe[probe.index("--write-out") + 1], "%{http_code}")
        self.assertIn("--output", probe)
        self.assertEqual(probe[probe.index("--max-time") + 1], "10")
        self.assertEqual(self.registry.read_bytes(), registry_before)
        self.assertFalse((self.config / ".mcp_ha_configured").exists())
        marker = self.config / f".mcp_openclaw_{self.community_name}_owned"
        self.assertTrue(marker.is_file())
        self.assertEqual([call["args"] for call in self.calls("openclaw")], [
            ["mcp", "status", "--verbose", "--json"],
        ])
        self.assertIn("Home Assistant connection way 3 (community MCP, URL list): connected", result.stdout)
        self.assert_timeout_call("30s", "/usr/bin/node", "--input-type=module")

    def test_way_3_sends_and_persists_no_authorization_header(self) -> None:
        env = self.env.copy()
        env["HA_TOKEN"] = ""

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        raw = self.openclaw_config.read_bytes()
        definition = json.loads(raw)["mcp"]["servers"][self.community_name]
        self.assertNotIn("headers", definition)
        self.assertNotIn(b"Authorization", raw)
        self.assertNotIn(b"Bearer", raw)
        probe = self.calls("curl")[0]["args"]
        self.assertFalse(any(arg.startswith("Authorization:") for arg in probe))
        self.assertNotIn(self.supervisor_token, probe)
        self.assertIn("Content-Type: application/json", probe)
        self.assertIn("Accept: application/json, text/event-stream", probe)

    def test_failed_probe_preserves_all_registries_and_markers(self) -> None:
        original = '{"mcp":{"servers":{"operator":{"command":"keep"}}},"unrelated":[1,  2]}\n'
        self.openclaw_config.write_text(original, encoding="utf-8")
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://stale"}}, mode=0o640)
        self.write_registry(self.project_registry, {"HA": {"baseUrl": "http://project"}})
        legacy_marker = self.config / ".mcp_ha_configured"
        legacy_marker.write_text("legacy-marker", encoding="utf-8")
        native_marker = self.config / f".mcp_openclaw_{self.community_name}_owned"
        native_marker.write_text("native-marker", encoding="utf-8")
        before = tuple(path.read_bytes() for path in (
            self.openclaw_config, self.registry, self.project_registry, legacy_marker, native_marker,
        ))
        env = self.env.copy()
        env["STUB_CURL_STATUS"] = "401"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("did not answer the initialize probe", result.stdout)
        self.assertIn("HTTP 401", result.stdout)
        self.assertIn("every existing MCP entry stays untouched", result.stdout)
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
        self.assertIn("did not answer the initialize probe (HTTP no answer)", result.stdout)
        self.assertIn("it was not registered", result.stdout)
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(self.openclaw_config.read_bytes(), before)

    def test_http_200_json_rpc_error_skips_registration_and_preserves_foreign_entries(self) -> None:
        original = (
            '{"mcp":{"servers":{"operator"  : {"command":"keep"}}},'
            '"unrelated":[1,  2]}\n'
        )
        self.openclaw_config.write_text(original, encoding="utf-8")
        env = self.env.copy()
        env["STUB_CURL_BODY"] = (
            '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}'
        )

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("did not answer the initialize probe", result.stdout)
        self.assertIn("HTTP 200", result.stdout)
        self.assertIn("it was not registered", result.stdout)
        self.assertIn("every existing MCP entry stays untouched", result.stdout)
        self.assertEqual(self.openclaw_config.read_bytes(), original.encode())
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.calls("openclaw"), [])
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)

    def test_http_202_notification_response_skips_registration_and_preserves_foreign_entries(self) -> None:
        original = '{"mcp":{"servers":{"operator":{"command":"keep"}}},"unrelated":[1,  2]}\n'
        self.openclaw_config.write_text(original, encoding="utf-8")
        env = self.env.copy()
        env["STUB_CURL_STATUS"] = "202"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("did not answer the initialize probe", result.stdout)
        self.assertIn("HTTP 202", result.stdout)
        self.assertIn("it was not registered", result.stdout)
        self.assertEqual(self.openclaw_config.read_bytes(), original.encode())
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertEqual(self.calls("openclaw"), [])
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
        self.assertNotIn(self.supervisor_token, result.stdout + result.stderr)

    def test_switch_on_with_empty_urls_is_silent_and_does_nothing(self) -> None:
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://user-owned"}})
        before = self.registry.read_bytes()
        openclaw_before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = ""

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertEqual(result.stdout, "BOOT_CONTINUED\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertEqual(self.openclaw_config.read_bytes(), openclaw_before)
        self.assertFalse((self.config / ".mcp_ha_configured").exists())


    def test_way_3_switch_off_with_urls_is_silent_and_does_nothing(self) -> None:
        self.write_registry(self.registry, {"HA": {"baseUrl": "http://user-owned"}})
        before = self.registry.read_bytes()
        openclaw_before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["MCP_ENABLED"] = "false"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertEqual(result.stdout, "BOOT_CONTINUED\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertEqual(self.openclaw_config.read_bytes(), openclaw_before)
        self.assertNotIn("Home Assistant connection", result.stdout)

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
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha-official"]
        self.assertEqual(definition, {
            "url": self.oauth_url,
            "transport": "streamable-http",
            "auth": "oauth",
            "oauth": {
                "clientMetadataUrl": f"{self.gateway_origin}/oauth/client-metadata.json",
                "redirectUrl": f"{self.gateway_origin}/oauth/mcp/callback",
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
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
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
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"

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
        self.assertIn(self.community_name, servers)
        self.assertIn("ha-official", servers)

    def test_way_2_refuses_different_unowned_entry_without_any_probe(self) -> None:
        original = '{"mcp":{"servers":{"ha-official":{"url":"http://operator.example/api/mcp"},"operator":{"command":"keep"}}}}\n'
        self.openclaw_config.write_text(original, encoding="utf-8")
        before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("exists without the add-on ownership marker", result.stdout)
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        self.assertFalse((self.config / ".mcp_openclaw_ha_official_owned").exists())
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(self.calls("curl"), [])


    def test_way_3_refuses_different_unowned_entry_after_successful_probe(self) -> None:
        original = json.dumps({"mcp": {"servers": {
            self.community_name: {"url": "http://operator.example/mcp"},
            "operator": {"command": "keep"},
        }}}) + "\n"
        self.openclaw_config.write_text(original, encoding="utf-8")
        before = self.openclaw_config.read_bytes()

        result = self.configure()

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn(
            "way 3 (community MCP, URL list): OpenClaw MCP server "
            f"'{self.community_name}' exists without the add-on ownership marker",
            result.stdout,
        )
        self.assertEqual(self.openclaw_config.read_bytes(), before)
        marker = self.config / f".mcp_openclaw_{self.community_name}_owned"
        self.assertFalse(marker.exists())
        self.assertEqual(self.calls("openclaw"), [])
        self.assertEqual(len(self.calls("curl")), 1)

    def test_way_2_authorization_required_prints_control_ui_sign_in_and_no_fallback(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
        env["STUB_OPENCLAW_AUTH_REQUIRED"] = "1"
        env["STUB_OPENCLAW_INCLUDE_SECRET"] = "1"
        env["STUB_PRIVATE_URL"] = self.oauth_url

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("Home Assistant connection way 2 (official MCP, OAuth): authorization-required", result.stdout)
        self.assertIn(f"open the Control UI at {self.gateway_origin}/settings/mcp", result.stdout)
        self.assertIn('choose "Sign in" for ha-official', result.stdout)
        self.assertNotIn("openclaw mcp login", result.stdout)
        connection_lines = [
            line for line in result.stdout.splitlines() if "Home Assistant connection" in line
        ]
        self.assertEqual(connection_lines, [
            "INFO: Home Assistant connection way 2 (official MCP, OAuth): "
            f"authorization-required; open the Control UI at {self.gateway_origin}/settings/mcp "
            'and choose "Sign in" for ha-official'
        ])
        self.assertNotIn("connected", result.stdout)
        self.assertEqual([call["args"] for call in self.calls("openclaw")], [["mcp", "status", "--verbose", "--json"]])
        self.assertEqual(self.calls("curl"), [])

    def test_way_2_authorization_required_without_origin_keeps_sign_in_hint(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
        env["GATEWAY_PUBLIC_ORIGIN"] = ""
        env["STUB_OPENCLAW_AUTH_REQUIRED"] = "1"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        connection_lines = [
            line for line in result.stdout.splitlines() if "Home Assistant connection" in line
        ]
        self.assertEqual(connection_lines, [
            "INFO: Home Assistant connection way 2 (official MCP, OAuth): "
            'authorization-required; open the Control UI and choose "Sign in" for ha-official'
        ])
        self.assertNotIn("/settings/mcp", result.stdout)
        self.assertNotIn("https://", result.stdout)
        self.assertNotIn("openclaw mcp login", result.stdout)
        self.assertEqual(self.calls("curl"), [])

    def test_status_reports_authorization_required_for_the_unauthenticated_state(self) -> None:
        env = self.env.copy()
        env["HA_MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = "http://ha.example.test/api/mcp"
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
        env["STUB_OPENCLAW_AUTH_REQUIRED"] = "1"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertIn(
            "Home Assistant connection way 2 (official MCP, OAuth): authorization-required",
            result.stdout,
        )
        self.assertIn("settings/mcp", result.stdout)
        self.assertIn("ha-official", result.stdout)

    def test_startup_never_runs_the_offline_doctor_probe(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
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
        env["STUB_OPENCLAW_INCLUDE_SECRET"] = "1"
        env["STUB_PRIVATE_URL"] = self.mcp_url
        env["STUB_OPENCLAW_DOCTOR_EXIT"] = "1"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        self.assertIn("Home Assistant connection way 3 (community MCP, URL list): connected", result.stdout)
        self.assertNotIn("privateDiagnostic", result.stdout + result.stderr)
        self.assertNotIn(self.mcp_url, result.stdout + result.stderr)

    def test_way_1_stores_private_token_and_announces_without_probing(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = ""

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
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = ""
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
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
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
            "INFO: Home Assistant connection way 3 (community MCP, URL list): connected",
        ])
        self.assertEqual(
            [line for line in result.stdout.splitlines() if "MCP" in line],
            connection_lines[1:],
        )
        self.assertNotIn(self.ha_token, result.stdout + result.stderr)
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

    def test_way_3_two_reachable_urls_register_separate_native_entries(self) -> None:
        first_url = "https://alpha.example.test/first-private-path"
        second_url = "https://beta.example.test/second-private-path"
        env = self.env.copy()
        env["MCP_URLS"] = f"{first_url},{second_url}"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertEqual(servers["ha-mcp-alpha-example-test"]["url"], first_url)
        self.assertEqual(servers["ha-mcp-beta-example-test"]["url"], second_url)
        self.assertEqual(len(servers), 2)
        self.assertEqual(len(self.calls("curl")), 2)
        self.assertEqual(len(self.calls("openclaw")), 2)
        self.assertEqual(result.stdout.count("way 3 (community MCP, URL list): connected"), 2)
        self.assertNotIn(first_url, result.stdout + result.stderr)
        self.assertNotIn(second_url, result.stdout + result.stderr)

    def test_way_3_unreachable_url_preserves_foreign_entries_and_leaks_no_secret(self) -> None:
        original = (
            '{"mcp":{"servers":{"operator"  : {"command":"keep",'
            '"args":[1,  2]}}},"unrelated":[1,  2]}\n'
        )
        self.openclaw_config.write_text(original, encoding="utf-8")
        failed_url = "https://offline.example.test/private-offline-secret"
        env = self.env.copy()
        env["MCP_URLS"] = f"{self.mcp_url},{failed_url}"
        env["STUB_CURL_FAIL_URL"] = failed_url
        env["STUB_CURL_FAIL_STATUS"] = "503"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assert_no_forbidden_tools()
        updated = self.openclaw_config.read_bytes()
        self.assertIn(b'"operator"  : {"command":"keep","args":[1,  2]}', updated)
        self.assertIn(b'"unrelated":[1,  2]', updated)
        servers = json.loads(updated)["mcp"]["servers"]
        self.assertIn(self.community_name, servers)
        self.assertNotIn("ha-mcp-offline-example-test", servers)
        self.assertEqual(len(self.calls("curl")), 2)
        self.assertEqual(len(self.calls("openclaw")), 1)
        self.assertIn("HTTP 503", result.stdout)
        self.assertIn("every existing MCP entry stays untouched", result.stdout)
        self.assertNotIn(failed_url, result.stdout + result.stderr)
        self.assertNotIn("private-offline-secret", result.stdout + result.stderr)

    def test_way_3_same_host_urls_get_numeric_suffix(self) -> None:
        first_url = "https://same-host.example.test/first-secret"
        second_url = "https://same-host.example.test/second-secret"
        env = self.env.copy()
        env["MCP_URLS"] = f"{first_url},{second_url}"

        result = self.configure(env=env)

        self.assert_booted(result)
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertEqual(servers["ha-mcp-same-host-example-test"]["url"], first_url)
        self.assertEqual(servers["ha-mcp-same-host-example-test-2"]["url"], second_url)
        self.assertEqual(len(self.calls("curl")), 2)
        self.assertNotIn(first_url, result.stdout + result.stderr)
        self.assertNotIn(second_url, result.stdout + result.stderr)

    def test_way_2_switch_off_with_url_is_silent_and_does_nothing(self) -> None:
        before = self.openclaw_config.read_bytes()
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = self.oauth_url
        env["HA_OFFICIAL_MCP_ENABLED"] = "false"

        result = self.configure(env=env)

        self.assert_booted(result)
        self.assertEqual(result.stdout, "BOOT_CONTINUED\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.openclaw_config.read_bytes(), before)

    def test_way_2_empty_url_uses_official_default(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = ""
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"

        result = self.configure(env=env)

        self.assert_booted(result)
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha-official"]
        self.assertEqual(definition["url"], "http://homeassistant.local:8123/api/mcp")
        self.assertEqual(definition["auth"], "oauth")
        self.assertEqual(self.calls("curl"), [])

    def test_way_2_empty_url_uses_the_lan_host_of_home_assistant(self) -> None:
        env = self.env.copy()
        env["MCP_URLS"] = ""
        env["HA_OFFICIAL_MCP_URL"] = ""
        env["HA_OFFICIAL_MCP_ENABLED"] = "true"
        env["LAN_IP"] = "192.0.2.42"

        result = self.configure(env=env)

        self.assert_booted(result)
        definition = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]["ha-official"]
        # The authorization server metadata carries Home Assistant's internal
        # URL as issuer, so the connect URL has to use the same host.
        self.assertEqual(definition["url"], "http://192.0.2.42:8123/api/mcp")
        self.assertEqual(definition["auth"], "oauth")

    def test_way_3_list_trims_whitespace_and_skips_empty_entries(self) -> None:
        first_url = "https://trim-one.example.test/first-secret"
        second_url = "https://trim-two.example.test/second-secret"
        env = self.env.copy()
        env["MCP_URLS"] = f"  {first_url}  , ,\t{second_url} \n"

        result = self.configure(env=env)

        self.assert_booted(result)
        servers = json.loads(self.openclaw_config.read_text(encoding="utf-8"))["mcp"]["servers"]
        self.assertEqual(servers["ha-mcp-trim-one-example-test"]["url"], first_url)
        self.assertEqual(servers["ha-mcp-trim-two-example-test"]["url"], second_url)
        probed_urls = [
            call["args"][call["args"].index("--request") + 2]
            for call in self.calls("curl")
        ]
        self.assertEqual(probed_urls, [first_url, second_url])
        self.assertNotIn(first_url, result.stdout + result.stderr)
        self.assertNotIn(second_url, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
