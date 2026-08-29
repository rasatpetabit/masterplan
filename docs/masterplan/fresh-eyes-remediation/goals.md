topic: |
  Thorough fresh-eyes re-evaluation of /srv/dev/ras/masterplan to find
  legacy/dead/incorrect elements after extensive modifications. Seed a
  remediation bundle for the confirmed findings.

  Constraint: use parallel deepseek-v4-flash workflows for bulk investigation
  (runs on own hardware, no token cost). Findings require path:line + direct
  evidence; no name-based reasoning.

  (Anchor reconstructed verbatim from the compacted originating request;
  the brainstorm continued in-session with "Continue brainstorm".)

## G1: Every audited finding lands its stated disposition
signal: artifact
evidence: audit-findings.md sweep — each item in A–F repaired, removed, or documented; final inventory sweep table committed in the bundle + git log of wave commits; deviations recorded explicitly in the run's retro

## G2: Full test suite green including new regression tests
signal: test
evidence: npm test passes at the final commit — the 1649 baseline plus one or more new regression tests per repaired behavioral defect (A-wave); output captured at the final commit

## G3: mp doctor exits 0 on a clean checkout
signal: command
evidence: node bin/doctor.mjs exits 0 with no ERROR findings; doctor run output at the final commit

## G4: CI green on the merge commit
signal: command
evidence: the GitHub Actions workflow passes on the merge commit, Doctor step included; CI run status for the merge commit

## G5: No documented-but-unimplemented surface remains
signal: test
evidence: every mp flag, op, and vocabulary named in commands/masterplan.md, docs/verbs.md, and skills is implemented; unknown flags fail closed (exit 2) instead of being silently dropped; flag/vocabulary sweep table + fail-closed tests in test/ + a positive implementation cross-check test asserting every documented flag/op/vocabulary is recognized by bin (not merely that unknown ones are rejected)

## G6: Release flow works end-to-end
signal: command
evidence: CHANGELOG entry -> tag -> push -> marketplace re-sync -> /plugin update resolves the tagged version with Pi-portable agent frontmatter; git tag, marketplace HEAD, and installed_plugins.json version/sha after /plugin update

## G7: Local clutter removed
signal: command
evidence: legacy/ and the empty tests/ directory are gone from the working tree; ls of the repo root at the final commit

## G8: Docs and skills match the code
signal: docs
evidence: every section-E claim (E1–E12) corrected in place and re-checked against the code it describes; wave-4 sweep table in the bundle's retro/findings record
