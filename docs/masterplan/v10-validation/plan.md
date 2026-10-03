# Validate the released v10.0.6 surfaces: G6 live evidence, goal-assessment replay, and the bootstrap failure table exercised against the tagged release (required successor of intent-to-completion).

Spec: docs/masterplan/v10-validation/spec.md

7 task(s) across 3 wave(s).

## Wave 0

### Task 1: Initialize isolated git worktree at .worktrees/v10-validation-tag checked out to tag v10.0.6
Ensure idempotent pre-flight cleanup (`rm -rf .worktrees/v10-validation-tag && git worktree prune`) and create dedicated detached worktree at `.worktrees/v10-validation-tag` on tag `v10.0.6` (`1e90cdae695dd8c3431efd35951815138bfdc25e`) without modifying active development branches.
- files:
- verify: test -d .worktrees/v10-validation-tag && [ "$(git -C .worktrees/v10-validation-tag rev-parse HEAD)" = "80e3337b8bb8ce50105b218b605b66273ddf8185" ]
- codex: no
- goals: G3
- spec_refs: spec.md §4.2

## Wave 1

### Task 2: Capture G6 live execution proof for Pi harness against installed v10.0.6 on host ai
Execute mp commands in the installed tagged release root under the Pi runtime environment on host ai, capturing live stdout/stderr receipts, exit codes, and environment metadata into evidence-g6-pi.txt.
- files: docs/masterplan/v10-validation/evidence-g6-pi.txt
- verify: test -s docs/masterplan/v10-validation/evidence-g6-pi.txt && grep -q "10.0.6" docs/masterplan/v10-validation/evidence-g6-pi.txt
- codex: no
- goals: G1
- spec_refs: spec.md §4.1

### Task 3: Capture G6 live execution proof for Claude harness against installed v10.0.6 plugin on host ai
Execute mp through the Claude plugin / extension cache binary on host ai, capturing execution receipts, version verification, and command exit behavior into evidence-g6-claude.txt.
- files: docs/masterplan/v10-validation/evidence-g6-claude.txt
- verify: test -s docs/masterplan/v10-validation/evidence-g6-claude.txt && grep -q "10.0.6" docs/masterplan/v10-validation/evidence-g6-claude.txt
- codex: no
- goals: G2
- spec_refs: spec.md §4.1

### Task 4: Execute bootstrap failure table and driver recovery test suite in tag v10.0.6 worktree and record failure-mode receipts
Run the normative bootstrap recovery test suite (`node --test test/v9-to-v10-bootstrap.test.mjs`) and exercise CLI fail-closed state invariants against the clean v10.0.6 checkout in .worktrees/v10-validation-tag. Record results and failure matrix into bootstrap-failure-table-report.md.
- files: docs/masterplan/v10-validation/bootstrap-failure-table-report.md
- verify: test -s docs/masterplan/v10-validation/bootstrap-failure-table-report.md && grep -q -i "pass" docs/masterplan/v10-validation/bootstrap-failure-table-report.md && grep -q "ENOENT" docs/masterplan/v10-validation/bootstrap-failure-table-report.md
- codex: no
- goals: G3
- spec_refs: spec.md §4.2

### Task 5: Verify green CI workflow run status for git tag v10.0.6 commit and record CI verification receipt
Query GitHub Actions CI check runs for the commit pointed to by tag v10.0.6 (1e90cdae695dd8c3431efd35951815138bfdc25e), verifying green status across test, lint, and build matrices. Record receipt to evidence-ci-tag.txt.
- files: docs/masterplan/v10-validation/evidence-ci-tag.txt
- verify: test -s docs/masterplan/v10-validation/evidence-ci-tag.txt && grep -q "1e90cdae" docs/masterplan/v10-validation/evidence-ci-tag.txt && grep -q -iE "success|completed" docs/masterplan/v10-validation/evidence-ci-tag.txt
- codex: no
- goals: G4
- spec_refs: spec.md §4.4

### Task 6: Audit post-tag commits between v10.0.6 and successor releases and synthesize historical release disposition report
Audit the git commit history and changelog past tag v10.0.6 through successor releases (v10.0.7–v10.0.14). Classify commits under the operator rule (docs-only vs functional defect) and settle the historical release disposition in release-disposition.md.
- files: docs/masterplan/v10-validation/release-disposition.md
- verify: test -s docs/masterplan/v10-validation/release-disposition.md && grep -q -i "disposition" docs/masterplan/v10-validation/release-disposition.md
- codex: no
- goals: G5
- spec_refs: spec.md §4.3

## Wave 2

### Task 7: Cleanly remove worktree .worktrees/v10-validation-tag and compile final validation summary
Safely remove the temporary git worktree at .worktrees/v10-validation-tag (`git worktree remove --force .worktrees/v10-validation-tag && git worktree prune`), verify cleanup, and assemble the comprehensive validation summary consolidating findings across all five goals in validation-summary.md.
- files: docs/masterplan/v10-validation/validation-summary.md
- verify: test -s docs/masterplan/v10-validation/validation-summary.md && ! git worktree list | grep -q v10-validation-tag
- codex: no
- goals: G1, G2, G3, G4, G5
- spec_refs: spec.md §4.2, spec.md §5
