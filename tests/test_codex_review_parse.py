"""
Unit tests for the CodexReviewParser degraded-parse path.

Tests validate D5, D21, D23 from parts/contracts/codex-review.md §Parse algorithm.
All five test functions correspond to spec.md lines 1233-1239.

Run with: python3 -m pytest tests/test_codex_review_parse.py -v
"""

import json
import re
import unittest
from datetime import datetime, timezone


class CodexReviewParser:
    """
    Implements the codex-review parse algorithm from parts/contracts/codex-review.md §Parse algorithm.

    D5  — on parse failure, preserve raw_excerpt and mark degraded=True
    D21 — raw_excerpt is the first 2048 bytes of the raw return text
    D23 — regex fallback for verdict and findings_count when parse fails
    D12 — shape validation: verdict in {"pass","fail","warn"}, findings/dimensions/summary typed
    """

    RAW_EXCERPT_MAX = 2048

    # D23: primary verdict regex — matches verdict/status = "pass"|"fail"|"warn"
    _VERDICT_PRIMARY_RE = re.compile(
        r'\b(verdict|status)\s*[:=]\s*"?(pass|fail|warn)"?\b',
        re.IGNORECASE,
    )

    # D23: secondary verdict keywords — if any of these appear, verdict = "fail"
    _VERDICT_FAIL_KEYWORDS_RE = re.compile(
        r'\b(critical|fatal|serious|blocking|fundamental|wrong assumption)\b',
        re.IGNORECASE,
    )

    # D23: markdown bullet with H/M/L+digit pattern (findings count)
    _FINDINGS_BULLET_RE = re.compile(
        r'^\s*[-*]\s+\[?[HMLhml]\d',
        re.MULTILINE,
    )

    def parse(self, raw_text: str) -> dict:
        """
        Parse a Codex review return value.

        Returns a dict representing a codex_review_returned event.
        On success: verdict, findings, dimensions, summary populated from JSON.
        On failure (D5): degraded=True, raw_excerpt, verdict from regex, findings=[], dimensions=[],
            summary="(parse failed — degraded heuristic)".
        """
        # Strip whitespace and code fences
        stripped = raw_text.strip()
        for fence in ("```json", "```"):
            if stripped.startswith(fence):
                stripped = stripped[len(fence):]
                break
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        stripped = stripped.strip()

        # Attempt JSON parse
        try:
            data = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            return self._degraded(raw_text)

        # D12 shape validation
        if not isinstance(data, dict):
            return self._degraded(raw_text)
        verdict = data.get("verdict")
        findings = data.get("findings")
        summary = data.get("summary")
        dimensions = data.get("dimensions")

        if verdict not in ("pass", "fail", "warn"):
            return self._degraded(raw_text)
        if not isinstance(findings, list):
            return self._degraded(raw_text)
        if not isinstance(summary, str):
            return self._degraded(raw_text)
        if not isinstance(dimensions, list):
            return self._degraded(raw_text)

        # Parse success
        return {
            "event": "codex_review_returned",
            "degraded": False,
            "verdict": verdict,
            "findings": findings,
            "findings_count": len(findings),
            "dimensions": dimensions,
            "summary": summary,
            "raw_excerpt": None,
            "ts": datetime.now(timezone.utc).isoformat(),
        }

    def _degraded(self, raw_text: str) -> dict:
        """
        D5, D21, D23: degraded-parse path.
        Preserves raw_excerpt, applies regex fallback for verdict + findings_count.
        """
        # D21: first 2048 bytes as raw_excerpt
        raw_bytes = raw_text.encode("utf-8")
        raw_excerpt_bytes = raw_bytes[: self.RAW_EXCERPT_MAX]
        raw_excerpt = raw_excerpt_bytes.decode("utf-8", errors="replace")

        # D23: verdict fallback
        verdict = self._extract_verdict(raw_text)

        # D23: findings count via markdown bullets
        bullet_matches = self._FINDINGS_BULLET_RE.findall(raw_text)
        findings_count = len(bullet_matches)

        return {
            "event": "codex_review_returned",
            "degraded": True,
            "verdict": verdict,
            "findings": [],
            "findings_count": findings_count,
            "dimensions": [],
            "summary": "(parse failed — degraded heuristic)",
            "raw_excerpt": raw_excerpt,
            "ts": datetime.now(timezone.utc).isoformat(),
        }

    def _extract_verdict(self, text: str) -> str:
        """D23 verdict extraction: primary regex, then keyword fallback, default 'warn'."""
        m = self._VERDICT_PRIMARY_RE.search(text)
        if m:
            return m.group(2).lower()
        if self._VERDICT_FAIL_KEYWORDS_RE.search(text):
            return "fail"
        return "warn"


# ---------------------------------------------------------------------------
# Test functions
# ---------------------------------------------------------------------------


def test_degraded_parse_preserves_raw_excerpt():
    """Spec line 1233: 3KB non-JSON → degraded=True, raw_excerpt ≤2048 bytes, matches first 2048."""
    # Build ~3KB non-JSON prose
    chunk = "This is a non-JSON prose review output with some content. " * 60
    assert len(chunk.encode("utf-8")) > 3000, "input must be >3KB"

    parser = CodexReviewParser()
    result = parser.parse(chunk)

    assert result["degraded"] is True, "degraded must be True for non-JSON input"
    assert result["raw_excerpt"] is not None, "raw_excerpt must not be None"
    assert len(result["raw_excerpt"].encode("utf-8")) <= 2048, "raw_excerpt must be ≤2048 bytes"

    expected_excerpt = chunk.encode("utf-8")[:2048].decode("utf-8", errors="replace")
    assert result["raw_excerpt"] == expected_excerpt, (
        "raw_excerpt must match first 2048 bytes of input"
    )


def test_degraded_parse_verdict_keyword_fail():
    """Spec line 1234: input contains 'fatal' → D23 keyword regex → verdict=='fail'."""
    raw = (
        "The review found a fatal error in the implementation. "
        "Multiple correctness problems detected."
    )
    parser = CodexReviewParser()
    result = parser.parse(raw)

    assert result["degraded"] is True
    assert result["verdict"] == "fail", (
        f"Expected verdict 'fail' due to 'fatal' keyword, got '{result['verdict']}'"
    )


def test_degraded_parse_verdict_keyword_warn_default():
    """Spec line 1235: no verdict/severity keywords → verdict=='warn' (never 'pass')."""
    raw = "The implementation looks reasonable and mostly complete."
    parser = CodexReviewParser()
    result = parser.parse(raw)

    assert result["degraded"] is True
    assert result["verdict"] == "warn", (
        f"Expected default verdict 'warn' for neutral text, got '{result['verdict']}'"
    )
    assert result["verdict"] != "pass", "verdict must never be 'pass' on degraded parse"


def test_degraded_parse_findings_count_via_markdown_bullets():
    """Spec line 1236-1237: 5 bullets matching ^\\s*[-*]\\s+\\[?[HMLhml]\\d → findings_count==5."""
    raw = """Some degraded review prose.

- [H1] file.py:42 — critical issue
- [M2] lib.py:10 — medium issue
* [L3] main.py:5 — low issue
- [h4] helper.py:99 — another high issue
* [M5] utils.py:7 — another medium
- This bullet does NOT match (no H/M/L prefix)
- Regular bullet without severity
"""
    parser = CodexReviewParser()
    result = parser.parse(raw)

    assert result["degraded"] is True
    assert result["findings_count"] == 5, (
        f"Expected findings_count=5 from 5 matching bullets, got {result['findings_count']}"
    )


def test_degraded_parse_event_record_shape():
    """Spec line 1238-1239: resulting event has required shape with all mandatory fields."""
    raw = "Totally unparseable review output -- not JSON at all."
    parser = CodexReviewParser()
    result = parser.parse(raw)

    # All mandatory fields from spec
    assert result.get("degraded") is True, "degraded must be True"
    assert isinstance(result.get("raw_excerpt"), str), "raw_excerpt must be a string"
    assert len(result["raw_excerpt"].encode("utf-8")) <= 2048, "raw_excerpt must be ≤2048 bytes"
    assert result.get("findings") == [], "findings must be empty list []"
    assert result.get("dimensions") == [], "dimensions must be empty list []"
    assert result.get("summary") == "(parse failed — degraded heuristic)", (
        f"summary mismatch: got '{result.get('summary')}'"
    )


if __name__ == "__main__":
    unittest.main(module=None, argv=["", "-v",
        "test_degraded_parse_preserves_raw_excerpt",
        "test_degraded_parse_verdict_keyword_fail",
        "test_degraded_parse_verdict_keyword_warn_default",
        "test_degraded_parse_findings_count_via_markdown_bullets",
        "test_degraded_parse_event_record_shape",
    ])
