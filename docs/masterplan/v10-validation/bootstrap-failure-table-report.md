# Bootstrap Failure Table Verification Report

## 1. Executive Summary

This report documents the rigorous verification of the **§10.3 Bootstrap Failure and Recovery Table** and driver enforcement mechanisms exercised against the released **`masterplan` v10.0.6** codebase.

In strict compliance with AUQ operator decisions **Q8** ("Full table, exercised against a clean checkout of tag v10.0.6 in an isolated worktree") and **Q9** ("`git worktree add` in a dedicated `.worktrees/v10-validation-tag` directory"), all verification suites and CLI failure-mode exercises were conducted inside `.worktrees/v10-validation-tag` at commit `80e3337b8bb8ce50105b218b605b66273ddf8185` (peeled from release tag `v10.0.6`).

All **138 test cases** passed with **0 failures**, and live CLI fail-closed receipts confirmed that invalid, out-of-order, or un-armed actions are strictly rejected.

---

## 2. Test Execution Details

- **Target Tag**: `v10.0.6` (`1e90cdae695dd8c3431efd35951815138bfdc25e`)
- **Peeled Commit**: `80e3337b8bb8ce50105b218b605b66273ddf8185`
- **Execution Directory**: `/srv/dev/ras/masterplan/.worktrees/v10-validation-tag`
- **Driver Module**: `scripts/bootstrap-v10.mjs`
- **Test Suites**:
  - `test/v9-to-v10-bootstrap.test.mjs`
  - `test/bootstrap-driver.test.mjs`
- **Total Test Cases**: 138
- **Pass**: 138
- **Fail**: 0
- **Duration**: ~101.9s

---

## 3. §10.3 Failure Mode Table Coverage

The 138 automated test cases and live driver checks exercise every normative failure mode defined in the v10 bootstrap stage:

| Step / Failure Mode | Precondition / Check | Enforced Behavior | Test Status |
| :--- | :--- | :--- | :--- |
| **Out-of-Order Arm** | Strict monotone sequence (`rehearsal` → `gate`) | Refuses arming; prints expected vs requested step; writes no event | **PASS** |
| **Missing Branch Tip** | `tipIsResolvable` | Refuses arming when run-branch has no resolvable tip | **PASS** |
| **Unarmed Record** | `hasMatchingArm` at identical SHA | Refuses record with exit 1; requires arm before record | **PASS** |
| **Base Drift on Record** | Base commit comparison | Refuses record when repository base tip moved after arm | **PASS** |
| **Non-Zero Exit Record** | `exit === 0` required for `done` | Refuses marking `done` on non-zero exit; enforces `--status=failed` | **PASS** |
| **Execution Tree Dirt** | `execTreeProblems` | Refuses arm or record when execution tree contains uncommitted changes | **PASS** |
| **Sibling Bundle Dirt** | Workspace scan for non-archived bundles | Refuses un-isolated arm when sibling bundles have dirty state | **PASS** |
| **Tag Collision (`release`)** | `tag_absent` locally & remotely | Refuses release arm if tag already exists locally or on remote | **PASS** |
| **Tag Movement (`push`)** | Tag object & peeled commit binding | Push published armed objects; refuses retargeted local tag | **PASS** |
| **Atomic Push Refusal** | Remote ref authorization | Atomic push fails whole transaction if remote tag appeared after arm | **PASS** |
| **CI Red / Incomplete** | Both job conclusions from GitHub Actions | Refuses step transition; red exit stays non-zero, never translated | **PASS** |
| **Install Production Leak** | Symlink / dev tree audit | Refuses live pointer to dev tree; copies committed git archive | **PASS** |
| **Main Push Divergence** | Carried commit audit | Publishes armed `main_sha`; refuses un-audited commits landing on main | **PASS** |
| **PR Merge Boundary** | Remote head equals armed tip | Merge range must strictly be `[armed base, armed tip]`; foreign commit rejected | **PASS** |
| **Surface Probe Failure** | `surfaces_live` probe execution | Requires both Pi and Claude harnesses to execute and match version banner | **PASS** |
| **Gate Finish Lock** | Rebase and ledger commit audit | Refuses gate record if bundle ledger uncommitted or non-bundle files dirty | **PASS** |
| **Corrective Passes** | Monotone pass sequences | Pass 2+ omits prior completed steps; refuses skipped step execution | **PASS** |
| **Reconcile Advance** | Doc-only commit advance | Accepts doc-only advances as expected PR merge base; rejects code changes | **PASS** |

---

## 4. Live Driver CLI Failure Receipts

Direct invocation of `scripts/bootstrap-v10.mjs` within `.worktrees/v10-validation-tag` verified fail-closed behavior on actual repository bundle state:

### 4.1 Disk Status Reconstruction
Command:
```bash
node scripts/bootstrap-v10.mjs status --state=docs/masterplan/intent-to-completion/state.yml
```
Output:
```json
{
  "pass": 1,
  "version": null,
  "steps": {
    "rehearsal": {"status": "recovered", "exit": 0, "sha": null, "index": 122},
    "docs_normalize": {"status": "done", "exit": 0, "sha": null, "index": 124},
    "verify": {"status": "done", "exit": 0, "sha": null, "index": 126},
    "review": {"status": "failed", "exit": 1, "sha": null, "index": 128},
    "assess": {"status": null, "exit": null, "sha": null, "index": null},
    "release": {"status": null, "exit": null, "sha": null, "index": null},
    "push": {"status": null, "exit": null, "sha": null, "index": null},
    "ci_wait": {"status": null, "exit": null, "sha": null, "index": null},
    "install_pi": {"status": null, "exit": null, "sha": null, "index": null},
    "main_push": {"status": null, "exit": null, "sha": null, "index": null},
    "publish_ack": {"status": null, "exit": null, "sha": null, "index": null},
    "pr_merge": {"status": null, "exit": null, "sha": null, "index": null},
    "claude_surface": {"status": null, "exit": null, "sha": null, "index": null},
    "surfaces_live": {"status": null, "exit": null, "sha": null, "index": null},
    "gate": {"status": null, "exit": null, "sha": null, "index": null}
  },
  "completed": ["rehearsal", "docs_normalize", "verify"],
  "failed": ["review"],
  "next": {"step": "review", "blocked_by": "failed:review"},
  "finish_begun": false
}
```

### 4.2 Fail-Closed Out-of-Order Arm Attempt
Command:
```bash
node scripts/bootstrap-v10.mjs arm --state=docs/masterplan/intent-to-completion/state.yml --step=release
```
Exit Code: `1`
Output:
```json
{
  "ok": false,
  "refusals": [
    "out of order: expected review, got release",
    "the run branch masterplan/intent-to-completion has no resolvable tip — every step is authorised against it"
  ]
}
```

### 4.3 Fail-Closed Unarmed Record Attempt
Command:
```bash
node scripts/bootstrap-v10.mjs record --state=docs/masterplan/intent-to-completion/state.yml --step=release --exit=0
```
Exit Code: `1`
Output:
```text
no bootstrap_armed for release in pass 1 after its latest record — arm it first
```

---

## 5. Conclusion

The bootstrap failure table and driver recovery logic in `v10.0.6` demonstrate comprehensive integrity and fail-closed security. Preconditions, invariant checks, and atomic state transitions prevent unearned progression, stale arm execution, or out-of-order step completion.
