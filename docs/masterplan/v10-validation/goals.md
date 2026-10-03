topic: |
  Validate the released v10.0.6 surfaces: G6 live evidence, goal-assessment replay, and the bootstrap failure table exercised against the tagged release (required successor of intent-to-completion).

## Intent
why: masterplan v10.0.6 shipped as the required successor of intent-to-completion; before that validation run is closed, its released surfaces must be validated against the real tagged v10.0.6 release rather than rehearsal fixtures, and the release disposition recorded on evidence rather than assumption (noting that v10.0.7+ has since shipped, making the disposition historical).
outcome: Documented, reproducible G6-style live evidence on both Pi and Claude harnesses (recorded transcripts or receipts running mp in the installed tagged release root on ai) that tagged v10.0.6 behaves as released and is CI-green; the full bootstrap failure table exercised against a clean checkout of tag v10.0.6 in an isolated worktree; and an explicit historical disposition recorded under the operator stated rule (docs-only commits past the tag keep 10.0.6; any shipped-surface defect forces v10.0.7, as realized by successor releases).
anti_goals:
- Do not execute goal-assessment replay as a purpose or requirement of this run (explicitly excluded per Q2/Q6; state.yml topic stands as the historical seed).
- Do not implement defect fixes within this run: record any defect found and carry the fix into v10.0.7 via the disposition (Q3).
- Do not exercise the bootstrap failure table against rehearsal fixtures or synthetic mocks; test the tagged v10.0.6 release directly in a clean isolated worktree (Q8).
- Do not declare validation complete or release closed without fresh, verifiable evidence from both Pi and Claude harnesses (Q7).
- Do not alter or re-tag historical successor releases (v10.0.7–v10.0.14); evaluate v10.0.6 on its own merits (Q5).
done_means: Live execution evidence gathered from both Pi and Claude on the tagged v10.0.6 release via installed root on ai; the full bootstrap failure table exercised against tag v10.0.6 in an isolated worktree; CI verified green on the tag; and the release disposition recorded under the rule: docs-only commits past the tag keep 10.0.6, any shipped-surface defect is recorded and documented historically.

```mp-intent-schema v1
{
  "version": 1,
  "schema": {
    "identity": "5cc997038a7dbedddc28015337c8061311097d80061dcbb6ffd23fd0773e6e73",
    "format_version": 1
  },
  "sections": {
    "purpose": {
      "body": "masterplan v10.0.6 shipped as the required successor of intent-to-completion; before that validation run is closed, its released surfaces must be validated against the real tagged v10.0.6 release rather than rehearsal fixtures, and the release disposition recorded on evidence rather than assumption (noting that v10.0.7+ has since shipped, making the disposition historical)."
    },
    "non_goals": {
      "items": [
        "Do not execute goal-assessment replay as a purpose or requirement of this run (explicitly excluded per Q2/Q6; state.yml topic stands as the historical seed).",
        "Do not implement defect fixes within this run: record any defect found and carry the fix into v10.0.7 via the disposition (Q3).",
        "Do not exercise the bootstrap failure table against rehearsal fixtures or synthetic mocks; test the tagged v10.0.6 release directly in a clean isolated worktree (Q8).",
        "Do not declare validation complete or release closed without fresh, verifiable evidence from both Pi and Claude harnesses (Q7).",
        "Do not alter or re-tag historical successor releases (v10.0.7–v10.0.14); evaluate v10.0.6 on its own merits (Q5)."
      ]
    },
    "top_invariant": {
      "body": "Validation evidence must come directly from genuine tagged release execution on host ai and clean worktree checkout, never synthetic mocks."
    },
    "direction": {
      "body": "Verify tagged release surfaces on live hosts and settle historical release disposition."
    },
    "posture": {
      "body": "Evidence-and-disposition only; document findings rather than modifying released code."
    }
  },
  "context": {
    "outcome": {
      "body": "Documented, reproducible G6-style live evidence on both Pi and Claude harnesses (recorded transcripts or receipts running mp in the installed tagged release root on ai) that tagged v10.0.6 behaves as released and is CI-green; the full bootstrap failure table exercised against a clean checkout of tag v10.0.6 in an isolated worktree; and an explicit historical disposition recorded under the operator stated rule (docs-only commits past the tag keep 10.0.6; any shipped-surface defect forces v10.0.7, as realized by successor releases)."
    },
    "done_means": {
      "body": "Live execution evidence gathered from both Pi and Claude on the tagged v10.0.6 release via installed root on ai; the full bootstrap failure table exercised against tag v10.0.6 in an isolated worktree; CI verified green on the tag; and the release disposition recorded under the rule: docs-only commits past the tag keep 10.0.6, any shipped-surface defect is recorded and documented historically."
    }
  },
  "evidence": [
    {
      "section": "Purpose",
      "source": "interview:Q1,Q5,Q7"
    },
    {
      "section": "Top invariant",
      "source": "interview:Q1,Q4,Q8"
    },
    {
      "section": "Non-goals",
      "source": "interview:Q2,Q3,Q6"
    },
    {
      "section": "Direction",
      "source": "interview:Q5,Q7"
    },
    {
      "section": "Posture",
      "source": "interview:Q3,Q4"
    }
  ],
  "reconciliation": [
    {
      "target": "topic",
      "status": "serves"
    }
  ]
}
```

## G1: G6 Live Proof on Pi Harness
signal: artifact
evidence: docs/masterplan/v10-validation/evidence-g6-pi.txt

## G2: G6 Live Proof on Claude Harness
signal: artifact
evidence: docs/masterplan/v10-validation/evidence-g6-claude.txt

## G3: Bootstrap Failure Table Exercised
signal: artifact
evidence: docs/masterplan/v10-validation/bootstrap-failure-table-report.md

## G4: Release Tag CI Verification
signal: artifact
evidence: docs/masterplan/v10-validation/evidence-ci-tag.txt

## G5: Historical Release Disposition Audit
signal: docs
evidence: docs/masterplan/v10-validation/release-disposition.md
