#!/usr/bin/env python3
"""Bundled skills stay package-local (v0.7.13.38).

The startup no longer copies bundled skills into the state directory and no
longer replaces the package skills directory with a symlink. Both operations
broke the package-swap rollback scan of an in-container OpenClaw runtime
update, and state-directory copies would shadow every future bundle update
(managed skills load with higher precedence).
"""
import unittest
from pathlib import Path

RUN_SH = Path(__file__).resolve().parent.parent / "run.sh"


class BundledSkillsLayoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.content = RUN_SH.read_text(encoding="utf-8")

    def test_no_symlink_replacement_of_the_package_skills_dir(self) -> None:
        self.assertNotIn('rm -rf "$IMAGE_SKILLS_DIR"', self.content)
        self.assertNotIn('ln -sf "$PERSISTENT_SKILLS_DIR"', self.content)
        self.assertNotIn('elif [ -L "$IMAGE_SKILLS_DIR" ]', self.content)

    def test_no_bulk_copy_of_bundled_skills_into_the_state_dir(self) -> None:
        self.assertNotIn("PERSISTENT_SKILLS_DIR", self.content)
        self.assertNotIn("Synced built-in skills to persistent storage", self.content)

    def test_package_local_marker_and_managed_path_are_present(self) -> None:
        self.assertIn("Bundled skills remain package-local", self.content)
        self.assertIn("$OPENCLAW_CONFIG_DIR/skills", self.content)


if __name__ == "__main__":
    unittest.main()
