#!/usr/bin/env python3
"""Offline unit tests for the release-time npm pin freshness gate."""

import io
import sys
import tempfile
import unittest
from pathlib import Path

ADDON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_DIR))

import oc_pin_freshness as freshness  # noqa: E402


class PinFreshnessTests(unittest.TestCase):
    def check(self, pins, *, strict=False, latest=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        versions = latest or {}

        def lookup(package, _timeout):
            return versions.get(package, next(pin.pin for pin in pins if pin.package == package))

        result = freshness.check_pins(
            pins,
            strict=strict,
            registry_lookup=lookup,
            stdout=stdout,
            stderr=stderr,
        )
        return result, stdout.getvalue(), stderr.getvalue()

    def test_runtime_family_behind_latest_fails(self):
        pins = [freshness.PackagePin("openclaw", "2026.11.3", freshness.RUNTIME_FAMILY)]
        result, output, _ = self.check(pins, latest={"openclaw": "2026.11.6"})
        self.assertEqual(result, freshness.EXIT_DRIFT)
        self.assertIn("openclaw | pin=2026.11.3 | latest=2026.11.6 | FAIL", output)

    def test_harness_cli_behind_latest_only_warns_by_default(self):
        pins = [freshness.PackagePin("opencode-ai", "1.19.5", freshness.HARNESS_FAMILY)]
        result, output, _ = self.check(pins, latest={"opencode-ai": "1.19.6"})
        self.assertEqual(result, freshness.EXIT_OK)
        self.assertIn("opencode-ai | pin=1.19.5 | latest=1.19.6 | WARN", output)

    def test_strict_fails_on_harness_drift(self):
        pins = [freshness.PackagePin("opencode-ai", "1.19.5", freshness.HARNESS_FAMILY)]
        result, output, _ = self.check(
            pins,
            strict=True,
            latest={"opencode-ai": "1.19.6"},
        )
        self.assertEqual(result, freshness.EXIT_DRIFT)
        self.assertIn("| FAIL", output)

    def test_image_tool_behind_latest_only_warns_by_default(self):
        pins = [freshness.PackagePin("mcporter", "0.16.9", freshness.IMAGE_FAMILY)]
        result, output, _ = self.check(pins, latest={"mcporter": "0.17.1"})
        self.assertEqual(result, freshness.EXIT_OK)
        self.assertIn("mcporter | pin=0.16.9 | latest=0.17.1 | WARN", output)

    def test_strict_fails_on_image_tool_drift(self):
        pins = [freshness.PackagePin("pnpm", "12.17.0", freshness.IMAGE_FAMILY)]
        result, output, _ = self.check(
            pins,
            strict=True,
            latest={"pnpm": "12.21.0"},
        )
        self.assertEqual(result, freshness.EXIT_DRIFT)
        self.assertIn("pnpm | pin=12.17.0 | latest=12.21.0 | FAIL", output)

    def test_all_current_passes(self):
        pins = [
            freshness.PackagePin("openclaw", "2026.11.10", freshness.RUNTIME_FAMILY),
            freshness.PackagePin("opencode-ai", "1.19.6", freshness.HARNESS_FAMILY),
        ]
        result, output, error = self.check(pins)
        self.assertEqual(result, freshness.EXIT_OK)
        self.assertEqual(output.count("| OK"), 2)
        self.assertEqual(error, "")

    def test_simulated_registry_outage_exits_with_distinct_error_code(self):
        stdout = io.StringIO()
        stderr = io.StringIO()

        def outage(package, _timeout):
            raise freshness.RegistryError(f"{package}: simulated registry outage")

        result = freshness.main(
            [],
            registry_lookup=outage,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(result, freshness.EXIT_REGISTRY_ERROR)
        self.assertNotEqual(result, freshness.EXIT_DRIFT)
        self.assertIn("latest=unavailable | ERROR", stdout.getvalue())
        self.assertIn("refusing to pass the release gate", stderr.getvalue())

    def test_real_helper_pin_extraction_yields_expected_pairs(self):
        pins = freshness.extract_helper_pins()
        actual = {pin.package: pin.pin for pin in pins}
        self.assertEqual(
            actual,
            {
                "@openclaw/acpx": "2026.11.10",
                "opencode-ai": "1.19.6",
                "@mariozechner/pi-coding-agent": "0.73.1",
                "@github/copilot": "1.0.116",
                "@kilocode/cli": "7.8.32",
                "@qwen-code/qwen-code": "0.28.7",
                "@google/gemini-cli": "0.71.1",
                "@factory/cli": "1.21.1",
                "@iflow-ai/iflow-cli": "0.5.19",
            },
        )
        self.assertEqual(
            {pin.package for pin in pins if pin.family == freshness.RUNTIME_FAMILY},
            {"@openclaw/acpx"},
        )

    def test_real_dockerfile_runtime_pin_is_included(self):
        runtime = freshness.extract_runtime_pin()
        self.assertEqual(
            runtime,
            freshness.PackagePin("openclaw", "2026.11.10", freshness.RUNTIME_FAMILY),
        )
        self.assertEqual(freshness.load_pins()[0], runtime)

    def test_real_dockerfile_image_pins_are_included(self):
        pins = freshness.extract_image_pins()
        self.assertEqual(
            {pin.package: pin.pin for pin in pins},
            {
                "node-llama-cpp": "3.22.4",
                "mcporter": "0.17.1",
                "pnpm": "12.23.0",
            },
        )
        self.assertEqual({pin.family for pin in pins}, {freshness.IMAGE_FAMILY})

    def test_load_pins_enumerates_every_bundled_npm_pin(self):
        pins = freshness.load_pins()
        self.assertEqual(len(pins), 13)
        self.assertEqual(
            {pin.package for pin in pins},
            {
                "openclaw",
                "@openclaw/acpx",
                "opencode-ai",
                "@mariozechner/pi-coding-agent",
                "@github/copilot",
                "@kilocode/cli",
                "@qwen-code/qwen-code",
                "@google/gemini-cli",
                "@factory/cli",
                "@iflow-ai/iflow-cli",
                "node-llama-cpp",
                "mcporter",
                "pnpm",
            },
        )
        self.assertEqual(
            {pin.package for pin in pins if pin.family == freshness.RUNTIME_FAMILY},
            {"openclaw", "@openclaw/acpx"},
        )

    def test_new_dockerfile_global_npm_pin_is_discovered_automatically(self):
        source = """\
RUN npm install -g openclaw@2026.11.6 \\
    && npm install -g node-llama-cpp@3.22.3 \\
    && npm install -g mcporter@0.17.1 \\
    && npm install -g pnpm@12.21.0 \\
    && npm install -g example-tool@2.0.0
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "Dockerfile"
            path.write_text(source, encoding="utf-8")
            pins = freshness.extract_image_pins(path)
        self.assertIn(
            freshness.PackagePin("example-tool", "2.0.0", freshness.IMAGE_FAMILY),
            pins,
        )


if __name__ == "__main__":
    unittest.main()
