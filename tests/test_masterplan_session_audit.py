import unittest
from contextlib import redirect_stdout
from io import StringIO
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

    def test_guardian_sessions_are_auxiliary_and_do_not_require_masterplan_telemetry(self):
        data = self.run_fixture_audit()
        sessions = {session["repo"]: session for session in data["codex_sessions"]}
        guardian = sessions["guardian-repo"]

        self.assertEqual("guardian", guardian["session_role"])
        self.assertEqual("auxiliary", guardian["goal_outcome"])
        self.assertEqual([], guardian["goal_failure_reasons"])

        warning_codes = {
            warning["code"]
            for warning in data["warnings"]
            if warning["repo"] == "guardian-repo"
        }
        self.assertNotIn("active_masterplan_missing_telemetry", warning_codes)
        self.assertNotIn("active_masterplan_unclassified_stop", warning_codes)

    def test_codex_task_complete_event_classifies_primary_goal_complete(self):
        data = self.run_fixture_audit()
        sessions = {session["repo"]: session for session in data["codex_sessions"]}
        session = sessions["task-complete"]

        self.assertEqual("primary", session["session_role"])
        self.assertEqual("complete", session["stop_kind"])
        self.assertEqual("complete", session["goal_outcome"])

        warning_codes = {
            warning["code"]
            for warning in data["warnings"]
            if warning["repo"] == "task-complete"
        }
        self.assertNotIn("active_masterplan_unclassified_stop", warning_codes)

    def test_table_reports_started_primary_goals_at_risk(self):
        data = self.run_fixture_audit()
        buffer = StringIO()

        with redirect_stdout(buffer):
            audit.print_table(data)

        output = buffer.getvalue()
        self.assertIn("Started goals at risk", output)
        section = output.split("Started goals at risk", 1)[1].split("\n\n", 1)[0]
        self.assertIn("stop-unknown", section)
        self.assertNotIn("guardian-repo", section)

    def test_codex_native_goal_created_but_unfinished_is_at_risk(self):
        data = self.run_fixture_audit()
        sessions = {session["repo"]: session for session in data["codex_sessions"]}
        session = sessions["native-goal-active"]

        self.assertTrue(session["native_goal_created"])
        self.assertFalse(session["native_goal_completed"])
        self.assertEqual("scheduled_yield", session["goal_outcome"])
        self.assertIn("native_goal_incomplete", session["goal_failure_reasons"])

    def test_codex_native_goal_completion_marks_goal_complete(self):
        data = self.run_fixture_audit()
        sessions = {session["repo"]: session for session in data["codex_sessions"]}
        session = sessions["native-goal-complete"]

        self.assertTrue(session["native_goal_created"])
        self.assertTrue(session["native_goal_completed"])
        self.assertEqual("complete", session["goal_outcome"])
        self.assertEqual([], session["goal_failure_reasons"])

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
