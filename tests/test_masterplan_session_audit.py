import unittest
from pathlib import Path
from unittest.mock import patch

from lib import masterplan_session_audit as audit


FIXTURES = Path(__file__).parent / "fixtures" / "session-audit"


class SessionAuditTests(unittest.TestCase):
    def run_fixture_audit(self):
        return audit.run_audit(
            since_arg="2026-05-11T00:00:00Z",
            hours_arg="24",
            fmt="json",
            claude_dir=str(FIXTURES / "claude"),
            codex_dir=str(FIXTURES / "codex"),
            repo_roots=str(FIXTURES / "repos"),
        )

    def test_ambient_masterplan_mentions_do_not_require_telemetry(self):
        data = self.run_fixture_audit()
        warnings = [
            warning
            for warning in data["warnings"]
            if warning["code"] == "active_masterplan_missing_telemetry"
        ]
        repos = {warning["repo"] for warning in warnings}

        self.assertNotIn("ambient-repo", repos)
        self.assertNotIn("claude-ambient", repos)
        self.assertIn("active-missing", repos)

    def test_existing_telemetry_suppresses_missing_telemetry_warning(self):
        data = self.run_fixture_audit()
        warnings = [
            warning
            for warning in data["warnings"]
            if warning["code"] == "active_masterplan_missing_telemetry"
        ]
        repos = {warning["repo"] for warning in warnings}

        self.assertNotIn("active-with-telemetry", repos)

    def test_duplicate_warning_entries_are_collapsed(self):
        data = self.run_fixture_audit()
        duplicate_warnings = [
            warning
            for warning in data["warnings"]
            if warning["repo"] == "duplicate-repo"
            and warning["code"] == "active_masterplan_missing_telemetry"
        ]

        self.assertEqual(1, len(duplicate_warnings))
        self.assertEqual(1, data["repo_totals"]["duplicate-repo"]["warnings"])

    def test_warning_codes_are_present_for_every_warning(self):
        data = self.run_fixture_audit()

        self.assertTrue(data["warnings"])
        self.assertTrue(all(warning.get("code") for warning in data["warnings"]))

    def test_codex_threshold_warnings_have_stable_codes(self):
        original_call_limit = audit.CODEX_CALL_LIMIT
        original_question_limit = audit.CODEX_QUESTION_LIMIT
        try:
            audit.CODEX_CALL_LIMIT = 2
            audit.CODEX_QUESTION_LIMIT = 1
            data = self.run_fixture_audit()
        finally:
            audit.CODEX_CALL_LIMIT = original_call_limit
            audit.CODEX_QUESTION_LIMIT = original_question_limit

        threshold_codes = {
            warning["code"]
            for warning in data["warnings"]
            if warning["repo"] == "threshold-repo"
        }

        self.assertIn("codex_calls_high", threshold_codes)
        self.assertIn("codex_questions_high", threshold_codes)

    def test_masterplan_stop_reasons_are_classified(self):
        data = self.run_fixture_audit()
        sessions = {session["repo"]: session for session in data["codex_sessions"]}

        self.assertEqual("question", sessions["stop-question"]["stop_kind"])
        self.assertEqual("critical_error", sessions["stop-critical"]["stop_kind"])
        self.assertEqual("complete", sessions["stop-complete"]["stop_kind"])
        self.assertEqual("scheduled_yield", sessions["stop-scheduled"]["stop_kind"])
        self.assertEqual("unknown", sessions["stop-unknown"]["stop_kind"])

    def test_unknown_active_masterplan_close_warns(self):
        data = self.run_fixture_audit()
        warnings = [
            warning
            for warning in data["warnings"]
            if warning["repo"] == "stop-unknown"
            and warning["code"] == "active_masterplan_unclassified_stop"
        ]

        self.assertEqual(1, len(warnings))

    def test_parse_args_preserves_environment_default_paths(self):
        with patch.dict(
            "os.environ",
            {
                "CLAUDE_PROJECTS_DIR": "/tmp/masterplan-claude",
                "CODEX_SESSIONS_DIR": "/tmp/masterplan-codex",
                "MASTERPLAN_REPO_ROOTS": "/tmp/masterplan-repos",
            },
        ):
            _since, _hours, _fmt, claude_dir, codex_dir, repo_roots = audit.parse_args([])

        self.assertEqual("/tmp/masterplan-claude", claude_dir)
        self.assertEqual("/tmp/masterplan-codex", codex_dir)
        self.assertEqual("/tmp/masterplan-repos", repo_roots)


if __name__ == "__main__":
    unittest.main()
