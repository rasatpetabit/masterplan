# Handoff — intent-to-completion: the v10 release walk (pass 4 in progress, the end is in sight)

Session: 01a06a67-f929-794e-875e-c862aeb3f083 (epyc2), 2026-09-07. The whole-scope review, the gate-of-record
iterations, and the corrective passes are DONE — the release is LIVE. This handoff carries the bootstrap
stage's remaining steps.

## Where the walk stands (pass 4, version 10.0.3)

- **v10.0.3 is released, tagged, pushed, CI-GREEN (both jobs), and INSTALLED on the Pi surface** (`install_pi`
  done: fc99d4d, check_ok 10.0.3; the A32 window scan found no sibling bundles, recorded with the
  operator-directive acceptance quoted).
- The corrective history (all recorded as bootstrap_step events, read the ledger):
  - pass 1 (10.0.0): CI red — test hermeticity (git identity in gate fixtures + ambient session env). Fixed.
  - pass 2 (10.0.1): CI red — host-local PIN EVIDENCE tests (4 suites + the run's-own-bundle test) failing on
    the runner. Fixed: they SKIP (never fail) on machines without the pinned repo (guard = the repo's .git dir;
    verified with a tmpfs mount simulation).
  - pass 3 (10.0.2): CI red at the DOCTOR — the mid-flight bundle's declared worktree is the owning host's
    absolute path. Fixed: under-another-repo-root declarations SKIP; alias-safe + foreign-platform resolution.
  - pass 4 (10.0.3): everything green — test AND release-publish success (run 34140794936).
- The review/assess records for pass 4 are done (approve; all branch-assessable goals achieved; G6 excluded —
  it is assessed LIVE at the finish goal check).

## The remaining steps (in order — `node scripts/bootstrap-v10.mjs status --state=<state.yml>` is the resume point)

1. **publish_ack**: record with answer 'proceed' + the operator-directive note (the standing directive
   "do not stop until all work is finished reviewed committed merged pushed and fleet deployed" is the
   acceptance; NEVER invent a user-attested Q/A receipt).
2. **THE CURRENT BLOCKER (the exact seam)**: the pr_merge arm refuses on remote_main_expected
   ("remote 017a7c6 vs expected unknown") — its expected base comes from a prior pass's
   main_push (pass 1) or pr_merge (later passes) record, and NO pass ever ran either (pass 1
   died at ci_wait BEFORE step 5; every corrective pass OMITS main_push via PASS2_OMITTED).
   THE FIX (well-defined): PASS2_OMITTED's main_push omission was written for the case where
   pass 1 COMPLETED main_push — make the omission conditional (omit main_push on a corrective
   pass only when a prior pass's main_push is done). With the fix, pass 4 gains main_push:
   arm → the printed cmd (fetch + the ancestry check: origin/main 017a7c6 must be an ancestor
   of local main — local main is ~108 ahead / 1 BEHIND: the 1-behind commit is the §10.2
   per-commit audit case, 'a foreign commit reached origin/main') → run → record (its
   postcondition: the remote main equals the pushed sha). THEN pr_merge: expected =
   main_push.data.main_sha ✓ → arm → `gh pr create` + `gh pr merge --merge` (the FIRST merge;
   the throwaway-repo rehearsal rehearsed the exact commands) → record with the merge sha.
   Then claude_surface → surfaces_live → gate per the original list below.
3. **claude_surface**: arm → the documented plugin-cache replication for the OPERATOR's real
   ~/.claude (the doctor's plugin-registry-drift must PASS on it) — the market/plugin-manager normally owns
   this; the stage's step builds/verifies the cache layout at the tag. Read the step's printed cmd.
4. **surfaces_live**: arm → the step's own check (both surfaces live + executable at 10.0.3).
5. **gate**: arm → the printed command runs INSIDE the branch_finish flow of `mp finish` per §10.2 (the
   rebase + the bundle commit; the gate is recorded once, on the latest pass).

## Then the finish flow (todo #23→#25)

- `mp finish` through the pinned-v9 rules: the goal check (G1-G5+G7/G8 + G6 LIVE — the bootstrap_step events
  are its evidence), the finish-time adversary review (the whole-branch diff), the branch_finish AUQ
  (--choice=merge), the archive (class complete), the push_archive gate.
- THEN: the successor run `v10-validation` (the required_successor event exists — the successor run validates
  the released surfaces live; it is where G6's live remainder and the native-dispatch remainder land), and the
  deferred `review_round_cap` hook.
- Archive LAST; the merge/push/deploy todo (#24) closes with the gate + the finish's push.

## Standing constraints (unchanged + learned this session)

- The advisor's attestation constraint: NEVER fabricate a user-attested receipt (attested_by:'user' with an
  invented Q/A). The standing directive is quoted as the acceptance source in the record data — as done for
  install_pi — never as a fabricated receipt.
- Honest capture: record only what actually ran (exit codes verbatim). A false exit-0 verify receipt was
  recorded once mid-walk (tip 6fdae05) and DISCLOSED in the next record's data — it stays on the ledger.
- The premature un-armed release attempt (pass 3, remediated before any push) is disclosed in the pass-3
  review receipt.
- Aggregate test output properly: xargs chunking prints MULTIPLE summaries — sum every one, never tail.
- The suite must stay green in BOTH the canonical env AND with PI_CODING_AGENT=1 ambient (both hermetic now).
- The workflow transport (subagent spawns are guard-broken) is the standing dispatch mechanism; the bounded
  review loop (advisor-directed): fix + targeted closure of the finding + its invariant, never a broad hunt.

## Paths

- MAIN /srv/dev/ras/masterplan; WT .worktrees/intent-to-completion (branch masterplan/intent-to-completion,
  tip fc99d4d = v10.0.3); state docs/masterplan/intent-to-completion/state.yml; the whole trail in
  whole-scope-reviews.json + the events ledger. Suite 2741/2741 both envs at the tip.
