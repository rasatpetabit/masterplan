# Spec — Masterplan v10.0.6 Released Surface Validation

**Run:** `v10-validation` · **Predecessor:** `intent-to-completion` (required successor) · **Target release:** `v10.0.6`  
**Complexity:** `high` · **Autonomy:** `gated` · **Planning Mode:** `auto` · **Adversary Review:** `on`

---

## 1. Problem

The `intent-to-completion` run bundle shipped the foundational v10 architecture of `masterplan`, establishing schema-backed intent interviewing, fail-closed knob contracts, gated finish flows, and deployment verification. Under Outcome 7 and Task 10 of `intent-to-completion`, the v10.0 release was cut and tagged as `v10.0.6`. However, closing that predecessor bundle left a hard requirement: `v10-validation` must execute as a successor run to validate the real released surfaces against live environments, rather than synthetic fixtures or rehearsal mocks.

Specifically:
1. **G6 Live Surface Verification**: The dual runtime harnesses (Pi install root and Claude extension/plugin environment) require verifiable, reproducible execution receipts from the installed tagged release root on host `ai`.
2. **Bootstrap Failure Table**: The failure matrix documented during the v10 bootstrap architecture must be exercised against the actual tagged `v10.0.6` release in an isolated clean worktree to verify fail-closed invariants under corruption, crash, or permission faults.
3. **Release Disposition & Historical Audit**: Post-tag commits exist on `main`. Under the operator's decision rule, docs-only commits past the tag preserve `v10.0.6` as a valid completed release, whereas any shipped-surface defect requires a successor release. Because successor releases (`v10.0.7` through `v10.0.14`) have already shipped in repository history, this validation must establish the historical record: verifying whether `v10.0.6` was sound and whether the defect boundary was properly respected.

---

## 2. Outcome & Success Criteria

1. **G6 Live Proof on Dual Harnesses**:
   - Recorded execution receipts and transcripts demonstrating `masterplan` running from the installed tagged release root on host `ai` under both the Pi harness and the Claude harness.
   - Confirmation that CLI invocation, version reporting (`mp version`), and core commands execute cleanly against the installed release without runtime crash or environment drift.
2. **Bootstrap Failure Table Exercised**:
   - Clean checkout of git tag `v10.0.6` created in an isolated worktree (`.worktrees/v10-validation-tag`).
   - The complete bootstrap failure table executed systematically against that tag checkout, validating expected exits and error messages for corrupted state, missing dependencies, unhandled flags, and invalid transitions.
3. **CI Status on Release Tag**:
   - Verifiable CI status check demonstrating green test and lint runs on tag `v10.0.6`.
4. **Historical Release Disposition Report**:
   - Mechanical commit diff analysis comparing tag `v10.0.6` with subsequent commits.
   - Documented assessment classifying each intervening commit (docs-only vs functional/surface defect) to produce an authoritative historical disposition report.

---

## 3. Non-Goals & Boundaries

- **No Goal-Assessment Replay**: Goal-assessment replay is explicitly excluded from this run's scope per user decisions Q1, Q2, and Q6.
- **No In-Band Defect Fixes**: If any defect in `v10.0.6` is discovered during validation, it is recorded in the disposition report rather than patched in this run (Q3).
- **No Rehearsal Fixtures or Synthetic Mocks**: All bootstrap failure tests must run against the genuine code checkout of `v10.0.6`, not synthetic test mocks (Q1, Q8).
- **No Mutation of Successor Releases**: Git tags `v10.0.7` through `v10.0.14` are established history and will not be rewritten, deleted, or re-tagged (Q5).

---

## 4. Architecture & Validation Surfaces

### 4.1 Surface 1: G6 Live Proof on Dual Harnesses (Pi & Claude)
- Validation target: Installed release `v10.0.6` on host `ai`.
- Execution isolation: Target the versioned installation directory (e.g. `~/.local/share/masterplan/releases/v10.0.6` or harness cache) directly to avoid collision with or mutation of active production symlinks for successor releases (`v10.0.7`–`v10.0.14`).
- Harness 1 (Pi): Execute `mp` commands inside the Pi harness runtime environment against the versioned `v10.0.6` root, capturing stdout/stderr and return code receipts.
- Harness 2 (Claude): Verify the Claude plugin / extension cache binary and command execution for `v10.0.6`, capturing execution receipts.
- Artifacts: Saved to `docs/masterplan/v10-validation/evidence-g6-pi.txt` and `docs/masterplan/v10-validation/evidence-g6-claude.txt`.

### 4.2 Surface 2: Bootstrap Failure Table (Isolated Worktree)
- Setup: Create worktree at `.worktrees/v10-validation-tag` checking out tag `v10.0.6`. Ensure dependencies are cleanly linked or tests invoked via node test runner.
- Execution:
  1. Driver Contract & Recovery Matrix: Execute `node --test test/v9-to-v10-bootstrap.test.mjs` on tag `v10.0.6`, verifying all normative bootstrap failure and recovery paths (§10.3) in the tagged release codebase.
  2. CLI Fail-Closed & State Machine Invariants: Systematically exercise CLI error paths:
     - Missing state file (`ENOENT` fail-closed)
     - Corrupted `state.yml` (YAML parse error, exit 1)
     - Unknown CLI flag (exit 2 fail-closed doctor check)
     - Missing required flags (`need()` check, exit 1)
     - Phase transition violation (invalid state progression, exit 3)
     - Terminal state absorption (mutations refused after terminal status)
- Teardown: Cleanly remove worktree (`git worktree remove --force .worktrees/v10-validation-tag`) and prune metadata.
- Artifacts: Recorded in `docs/masterplan/v10-validation/bootstrap-failure-table-report.md`.

### 4.3 Surface 3: Release Disposition & Tag Audit
- Audit diff: `git log v10.0.6..v10.0.7` and subsequent commit logs.
- Classification: Categorize commits as `docs-only`, `chore`, or `shipped-surface defect/feature`.
- Disposition Rule: If commits past `v10.0.6` were docs-only, `v10.0.6` stood as complete; if functional defects were fixed, `v10.0.7` was required.
- Historical context: Cross-reference with published release notes for `v10.0.7`–`v10.0.14`.
- Artifacts: Recorded in `docs/masterplan/v10-validation/release-disposition.md`.

### 4.4 Surface 4: Release Tag CI Verification
- Verification method: Query GitHub Actions CI check runs on the commit pointed to by tag `v10.0.6` (`gh run list --commit $(git rev-parse v10.0.6)` or CI job run logs).
- Requirement: All CI runs for lint, unit tests, and cross-platform checks on tag `v10.0.6` must be recorded as green/successful.
- Artifacts: Recorded in `docs/masterplan/v10-validation/evidence-ci-tag.txt`.

---

## 5. Verification & Test Plan

1. **Tag Cleanliness**: Verify `git rev-parse v10.0.6` resolves to commit `1e90cdae695dd8c3431efd35951815138bfdc25e`.
2. **CI Status**: Verify CI workflow run logs for commit `1e90cdae695dd8c3431efd35951815138bfdc25e` pass green.
3. **Bootstrap Suite**: Run `node --test test/v9-to-v10-bootstrap.test.mjs` in `.worktrees/v10-validation-tag` and confirm all test suites pass.
4. **Harness Verification**: Confirm non-zero and zero exit codes match expected behaviors for Pi and Claude invocation receipts.
5. **Artifact Completeness**: Confirm all 6 planned documentation artifacts (`evidence-g6-pi.txt`, `evidence-g6-claude.txt`, `bootstrap-failure-table-report.md`, `evidence-ci-tag.txt`, `release-disposition.md`, `validation-summary.md`) exist, are non-empty, and contain verifiable evidence.

---

## 6. Assumptions & Open Decisions

| Question | Decision | Rationale | Source |
|---|---|---|---|
| Target version scope | Validate `v10.0.6` directly as tagged, recording historical context of `v10.0.7`–`v10.0.14`. | User Q5 settled that successor versions already shipped; validation of `v10.0.6` is historical. | user-confirmed |
| Goal-assessment replay | Exclude goal-assessment replay from run scope. | User Q2 and Q6 settled that replay is out of scope; topic seed remains as historical anchor. | user-confirmed |
| Defect handling posture | Record defects and carry them into release disposition without in-band patching. | User Q3 settled evidence-and-disposition only posture. | user-confirmed |
| Worktree directory | Use `.worktrees/v10-validation-tag` for checkout of tag `v10.0.6`. | User Q9 design pick selected isolated subfolder to avoid repo pollution. | user-confirmed |
| Bootstrap Failure Matrix | Test both driver recovery suite (`test/v9-to-v10-bootstrap.test.mjs`) and CLI fail-closed state invariants. | Addresses adversarial review finding 2 ensuring normative §10.3 driver contract is validated. | assumed |
| Host `ai` Version Isolation | Target versioned `releases/v10.0.6` path directly without mutating active production symlinks. | Addresses adversarial review finding 3 preventing destabilization of active successor releases. | assumed |
| CI Verification Query | Query GitHub CI check runs on tag commit SHA rather than unsupported `git tag --verify`. | Addresses adversarial review finding 1 reconciling lightweight git tag with CI evidence requirement. | assumed |
| Q1: What is the primary purpose of this validation run? | Prove v10.0.6 is live across Pi and Claude, exercise bootstrap failure table against tagged release, and settle release disposition. | Fulfills required successor commitment from `intent-to-completion`. | user-confirmed |
| Q2: Should goal-assessment replay be included in scope? | Exclude goal-assessment replay from this run. | User declined goal-assessment replay in Q1; confirmed exclusion in Q2. | user-confirmed |
| Q3: Are in-scope defect fixes allowed if issues are discovered? | Evidence and disposition only; record defects and carry fixes forward. | Keeps validation focused on verifying released state rather than scope creep. | user-confirmed |
| Q4: What rule governs the release disposition for v10.0.6? | Docs-only commits past the tag keep 10.0.6; any shipped-surface defect forces a successor release. | Explicit, unambiguous objective rule for release completion. | user-confirmed |
| Q5: Which release is the validation target given v10.0.7–v10.0.14 exist? | Target v10.0.6 as tagged per anchor; record disposition historically. | Honors anchor topic while acknowledging repository reality. | user-confirmed |
| Q6: How should the anchor topic divergence regarding replay be handled? | Carry exclusion in anti-goals and spec decisions; state.yml topic stands as seed. | Preserves immutability of historical seed while making intent unambiguous. | user-confirmed |
| Q7: What artifact format counts as G6 live evidence? | Recorded transcripts or receipts from running mp in installed tagged release root on ai. | Matches G6 verification standard for host runtime environments. | user-confirmed |
| Q8: How should the bootstrap failure table be exercised? | Full table exercised against clean checkout of tag v10.0.6 in isolated worktree. | Prevents contamination of working tree and tests real release bytes. | user-confirmed |
| Q9: What worktree harness is used for tag checkout? | `git worktree add` in `.worktrees/v10-validation-tag`. | Standard masterplan worktree location; safe isolation. | user-confirmed |
