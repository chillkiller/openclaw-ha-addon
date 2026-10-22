"""Guard package-local bundled skills and preservation of managed overrides."""
import pathlib
import subprocess
import tempfile
import unittest

RUN = pathlib.Path(__file__).resolve().parents[1] / "run.sh"

class SkillsLayoutTest(unittest.TestCase):
    def test_boot_preserves_bundled_and_managed_skills(self):
        script = RUN.read_text()
        start = script.index("# Keep bundled skills")
        end = script.index("# Persist user-installed node skills", start)
        block = script[start:end]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            managed = root / "state" / "skills"
            bundled = root / "package" / "skills"
            managed.mkdir(parents=True)
            bundled.mkdir(parents=True)
            (managed / "custom.md").write_text("user data")
            (bundled / "builtin.md").write_text("bundled data")
            block = block.replace("/config/.openclaw/skills", str(managed))
            for _ in range(2):
                subprocess.run(["bash", "-eu", "-c", block], check=True)
            self.assertFalse(bundled.is_symlink())
            self.assertEqual((managed / "custom.md").read_text(), "user data")
            self.assertEqual((bundled / "builtin.md").read_text(), "bundled data")
            self.assertFalse((managed / "builtin.md").exists())
        self.assertNotIn('ln -sf "$PERSISTENT_SKILLS_DIR"', script)
        self.assertNotIn('rm -rf "$IMAGE_SKILLS_DIR"', script)

if __name__ == "__main__":
    unittest.main()
