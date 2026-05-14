import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "bin" / "masterplan-state.sh"


class MasterplanStateTests(unittest.TestCase):
    def run_script(self, repo, *args):
        return subprocess.run(
            [str(SCRIPT), *args],
            cwd=repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def init_repo(self, repo):
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)

    def write(self, repo, path, content):
        target = Path(repo) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return target

    def test_migrate_skips_date_prefixed_legacy_slug_already_represented_by_state(self):
        with tempfile.TemporaryDirectory() as tempdir:
            self.init_repo(tempdir)
            legacy_slug = "2026-05-09-phase-10-cli-parity"
            canonical_slug = "phase-10-cli-parity"
            self.write(
                tempdir,
                f"docs/superpowers/plans/{legacy_slug}-status.md",
                f"""---
slug: {legacy_slug}
plan: docs/superpowers/plans/{legacy_slug}.md
status: in-progress
---

## Activity log
- 2026-05-09T12:00:00Z Started import candidate
""",
            )
            self.write(
                tempdir,
                f"docs/superpowers/plans/{legacy_slug}.md",
                "# Phase 10 CLI parity\n",
            )
            self.write(
                tempdir,
                f"docs/masterplan/{canonical_slug}/state.yml",
                f"""schema_version: 2
slug: {canonical_slug}
artifacts:
  plan: docs/masterplan/{canonical_slug}/plan.md
  events: docs/masterplan/{canonical_slug}/events.jsonl
legacy:
  status: docs/superpowers/plans/{legacy_slug}-status.md
  plan: docs/superpowers/plans/{legacy_slug}.md
""",
            )

            result = self.run_script(tempdir, "migrate", "--dry-run", "--format=json")

            self.assertEqual(0, result.returncode, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(1, len(data["actions"]))
            self.assertEqual("skip", data["actions"][0]["action"])
            self.assertNotEqual("would-migrate", data["actions"][0]["action"])
            self.assertIn("canonical slug match", data["actions"][0]["reason"])
            self.assertEqual(f"docs/masterplan/{canonical_slug}/state.yml", data["actions"][0]["target"])

    def test_migrate_skips_legacy_artifact_represented_only_by_state_pointer(self):
        with tempfile.TemporaryDirectory() as tempdir:
            self.init_repo(tempdir)
            legacy_slug = "2026-05-09-phase-10-cli-parity"
            self.write(
                tempdir,
                f"docs/superpowers/plans/{legacy_slug}-status.md",
                f"""---
slug: {legacy_slug}
status: in-progress
---

## Activity log
- 2026-05-09T12:00:00Z Started import candidate
""",
            )
            self.write(
                tempdir,
                f"docs/superpowers/plans/{legacy_slug}-status-archive.md",
                "- 2026-05-09T13:00:00Z Archived status line\n",
            )
            self.write(
                tempdir,
                "docs/masterplan/imported-cli-parity/state.yml",
                f"""schema_version: 2
slug: imported-cli-parity
legacy:
  sidecars:
    status_archive: docs/superpowers/plans/{legacy_slug}-status-archive.md
""",
            )

            result = self.run_script(tempdir, "migrate", "--dry-run", "--format=json")

            self.assertEqual(0, result.returncode, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(1, len(data["actions"]))
            self.assertEqual("skip", data["actions"][0]["action"])
            self.assertIn("legacy: sidecar pointer reference", data["actions"][0]["reason"])
            self.assertEqual("docs/masterplan/imported-cli-parity/state.yml", data["actions"][0]["target"])

    def test_migrate_write_creates_bundle_from_status_spec_retro_and_events(self):
        with tempfile.TemporaryDirectory() as tempdir:
            self.init_repo(tempdir)
            slug = "phase-8-1-config-language"
            self.write(
                tempdir,
                f"docs/superpowers/plans/{slug}-status.md",
                f"""---
slug: {slug}
plan: docs/superpowers/plans/{slug}.md
spec: docs/superpowers/specs/{slug}-design.md
status: in-progress
current_task: Write parser
next_action: Add tests
---

## Activity log
- 2026-05-08T10:00:00Z Parser task started

## Notes
- Keep the generated bundle deterministic
""",
            )
            self.write(tempdir, f"docs/superpowers/plans/{slug}.md", "# Plan\n")
            self.write(tempdir, f"docs/superpowers/specs/{slug}-design.md", "# Spec\n")
            self.write(tempdir, f"docs/superpowers/retros/{slug}-retro.md", "# Retro\n")

            result = self.run_script(tempdir, "migrate", "--write", "--format=json")

            self.assertEqual(0, result.returncode, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual("migrated", data["actions"][0]["action"])
            bundle = Path(tempdir) / "docs" / "masterplan" / slug
            self.assertTrue((bundle / "state.yml").is_file())
            self.assertTrue((bundle / "plan.md").is_file())
            self.assertTrue((bundle / "spec.md").is_file())
            self.assertTrue((bundle / "retro.md").is_file())

            events = (bundle / "events.jsonl").read_text().splitlines()
            self.assertGreaterEqual(len(events), 2)
            for line in events:
                json.loads(line)

            state = (bundle / "state.yml").read_text()
            self.assertIn(f"legacy:\n  migrated_at:", state)
            self.assertIn(f"  status: docs/superpowers/plans/{slug}-status.md", state)
            self.assertIn(f"  spec: docs/superpowers/specs/{slug}-design.md", state)
            self.assertIn(f"  retro: docs/superpowers/retros/{slug}-retro.md", state)


if __name__ == "__main__":
    unittest.main()
