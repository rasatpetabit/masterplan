import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "bin" / "masterplan-audit-schedule.sh"


class MasterplanAuditScheduleTests(unittest.TestCase):
    def run_script(self, tempdir, *args):
        cron_file = Path(tempdir) / "crontab"
        env = os.environ.copy()
        env["CRONTAB_FILE"] = str(cron_file)
        env["MASTERPLAN_AUDIT_STATE_DIR"] = str(Path(tempdir) / "audit-state")
        env["MASTERPLAN_AUDIT_CRON"] = "7 * * * *"
        result = subprocess.run(
            [str(SCRIPT), *args],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        return result, cron_file

    def test_install_is_idempotent_and_preserves_unmanaged_entries(self):
        with tempfile.TemporaryDirectory() as tempdir:
            cron_file = Path(tempdir) / "crontab"
            cron_file.write_text("# existing\n0 0 * * * echo old\n")

            first, _ = self.run_script(tempdir, "install")
            self.assertEqual(0, first.returncode, first.stderr)

            second, _ = self.run_script(tempdir, "install")
            self.assertEqual(0, second.returncode, second.stderr)

            content = cron_file.read_text()
            self.assertIn("0 0 * * * echo old", content)
            self.assertEqual(1, content.count("# BEGIN MASTERPLAN RECURRING AUDIT"))
            self.assertEqual(1, content.count("# END MASTERPLAN RECURRING AUDIT"))
            self.assertIn("7 * * * * MASTERPLAN_AUDIT_STATE_DIR=", content)
            self.assertIn("bin/masterplan-recurring-audit.sh", content)

    def test_status_and_uninstall_use_the_managed_block_only(self):
        with tempfile.TemporaryDirectory() as tempdir:
            cron_file = Path(tempdir) / "crontab"
            cron_file.write_text("# existing\n0 0 * * * echo old\n")

            install, _ = self.run_script(tempdir, "install")
            self.assertEqual(0, install.returncode, install.stderr)

            status, _ = self.run_script(tempdir, "status")
            self.assertEqual(0, status.returncode, status.stderr)
            self.assertIn("# BEGIN MASTERPLAN RECURRING AUDIT", status.stdout)
            self.assertNotIn("echo old", status.stdout)

            uninstall, _ = self.run_script(tempdir, "uninstall")
            self.assertEqual(0, uninstall.returncode, uninstall.stderr)

            content = cron_file.read_text()
            self.assertIn("0 0 * * * echo old", content)
            self.assertNotIn("# BEGIN MASTERPLAN RECURRING AUDIT", content)


if __name__ == "__main__":
    unittest.main()
