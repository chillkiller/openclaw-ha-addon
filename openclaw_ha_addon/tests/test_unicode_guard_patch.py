#!/usr/bin/env python3
"""Regression tests for the build-time unicode-guard dist patch.

The patch runs in the image build right after the OpenClaw install. When the
runtime is bumped, its dist layout can change; the patch has to keep working
for the new layout and has to fail loudly when it cannot.

The export contract of the patched module is the case that bit us on
OpenClaw 2026.11.10: the source build writes
``export { stripInvisibleUnicode as t };`` while the minified dist writes
``export{stripInvisibleUnicode as t};``. Both are the same contract.

Run with:

    python3 -m unittest discover -s openclaw_ha_addon/tests -v
"""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ADDON_DIR = Path(__file__).resolve().parents[1]
PATCH_SCRIPT = ADDON_DIR / "unicode-guard" / "apply-unicode-guard-patch.mjs"
NODE = shutil.which("node")

NAIVE_STRIP = (
    "const INVISIBLE_UNICODE_RE=/[\\u200B-\\u200F]/gu;"
    "function stripInvisibleUnicode(e){return e.replace(INVISIBLE_UNICODE_RE,``)}"
)
NAIVE_SANITIZE = (
    "function sanitizeExternalContentText(e){"
    "return sanitizeModelSpecialTokens(replaceMarkers(e))}"
)


class UnicodeGuardPatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.install_dir = Path(self.tmp.name) / "openclaw"
        self.dist = self.install_dir / "dist"
        self.dist.mkdir(parents=True)

    def _write_dist(self, export_statement: str, with_export: bool = True) -> None:
        """Build a minimal dist that looks like the upstream layout."""
        visibility = NAIVE_STRIP
        if with_export:
            visibility += export_statement
        (self.dist / "unicode-visibility-DN5RMwwF.mjs").write_text(
            visibility, encoding="utf-8"
        )
        (self.dist / "external-content-CpoNe0Vh.mjs").write_text(
            NAIVE_SANITIZE, encoding="utf-8"
        )

    def _run_patch(self) -> subprocess.CompletedProcess:
        return subprocess.run(
            [NODE, str(PATCH_SCRIPT), str(self.install_dir)],
            capture_output=True,
            text=True,
            timeout=180,
        )

    @unittest.skipUnless(NODE, "node is required to run the patch script")
    def test_minified_export_spelling_is_accepted(self) -> None:
        """The minified dist layout of OpenClaw 2026.11.10 must keep working."""
        self._write_dist("export{stripInvisibleUnicode as t};")
        result = self._run_patch()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        patched = (self.dist / "unicode-visibility-DN5RMwwF.mjs").read_text(
            encoding="utf-8"
        )
        # The export contract must survive the patch: the module has to stay
        # importable by the name the runtime expects.
        self.assertIn("stripInvisibleUnicode as t", patched)
        self.assertIn("unicodeGuard", patched)

    @unittest.skipUnless(NODE, "node is required to run the patch script")
    def test_spaced_export_spelling_is_accepted(self) -> None:
        """The source-build spelling must keep working as well."""
        self._write_dist("export { stripInvisibleUnicode as t };")
        result = self._run_patch()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        patched = (self.dist / "unicode-visibility-DN5RMwwF.mjs").read_text(
            encoding="utf-8"
        )
        self.assertIn("stripInvisibleUnicode as t", patched)

    @unittest.skipUnless(NODE, "node is required to run the patch script")
    def test_missing_export_contract_fails_loudly(self) -> None:
        """A patched module without the export must stop the build."""
        self._write_dist("", with_export=False)
        result = self._run_patch()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("export contract", result.stdout + result.stderr)

    @unittest.skipUnless(NODE, "node is required to run the patch script")
    def test_missing_dist_fails_loudly(self) -> None:
        """Without a dist there is nothing to patch - the build must stop."""
        shutil.rmtree(self.dist)
        result = self._run_patch()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("dist directory not found", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
