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

## THE ROUTE (updated in-session — read this first)

The walk CANNOT pr_merge at the current state, and the machinery's own rules say so: the branch
tip moved past the published release tip (post-release driver fixes), tip_is_published refuses,
and a refused arm writes NO receipt (a pre-refusal cannot be recorded failed). The chain is
frozen once the tag is cut. The DESIGNED trigger for the corrective pass is the FINISH-TIME
REVIEW (mp finish's whole-branch adversary review): its revise verdict on the real state
(branch tip f155411 != published tip fc99d4d — unreleased commits cannot be merged) is the
honest §10.3 blocking finding that opens pass 5.

### Pass-4 state at hand-off

- v10.0.3 released/tagged/pushed/CI-green/installed; install_pi + publish_ack + main_push DONE
  (main_push pushed local main e16a276 to origin/main — the first origin/main move in the run).
- pr_merge: DEADLOCKED (branch moved past fc99d4d). next = pr_merge.
- Three driver fixes committed on the branch past the tag (all suite-verified, 2743/2743 at f155411):
  1. 8aaa78b — stepsForPass(pass, events): main_push omitted on corrective passes ONLY when an
     earlier pass completed it (pass 1 died pre-step-5 → every corrective pass carries main_push).
  2. 0ad1a33 — the FIRST pr_merge binds its base to the CURRENT pass's main_push.
  3. f155411 — generalized: the expected remote base = the last thing that SUCCESSFULLY moved main
     (latest DONE pr_merge of an earlier pass, else the latest DONE main_push of any pass <= current).
     This is what lets pass 5 arm pr_merge with main_push OMITTED (pass 4's is done, expected e16a276).

### The pass-5 route (mechanical, every rule already in the tree)

1. Run the finish-time review (workflow transport, gpt-6-astra lane): the whole-branch diff vs
   origin/main base e16a276, framed neutrally — 'can this branch merge as the walk's product?'
   Its REVISE on the tip!=published state is the honest trigger. Record the finding per the
   finish flow's own record surface (mp record-result / the finish-step event), then
   `bootstrap-v10.mjs start --pass=5 --triggered-by=<the finding event index>` (version 10.0.4).
2. Pass 5: verify (suite 2743/2743 + doctor) → review (bounded: the driver-fix delta + the pass-5
   shape) → assess (same class as pass 4) → bump six surfaces to 10.0.4 → re-verify → re-record
   review/assess recovered at the bumped tip → release v10.0.4 (armed release.mjs, CHANGELOG-only
   commit + tag) → push (verbatim) → ci_wait (green expected: the suite passed at the tip; the
   driver fixes are test-covered) → install_pi (A32 window again — scan, quote the directive) →
   publish_ack → main_push OMITTED (prior done) → pr_merge: arms now (expected e16a276 = origin/main;
   branch tip = the v10.0.4 release commit = published tip of pass 5) → `gh pr create` +
   `gh pr merge --merge` → record merge_sha → claude_surface → surfaces_live.
3. The gate (inside branch_finish per §10.2): MAIN on main, clean outside the bundle, remote
   main = merge_sha, audit range = the merge's parents. Then mp finish's branch_finish (--choice=merge),
   the G6 LIVE goal check (bootstrap_step events are its evidence), archive, required_successor
   (v10-validation), the operator push AUQ.

### The standing constraints (all unchanged, all binding)

- Honest capture: never record an exit the command did not return; sum EVERY xargs chunk summary;
  no fabricated attested_by:'user' receipts (the standing directive quoted as acceptance source only).
- Public tags never move: v10.0.0/1/2/3 are all frozen (the first three red-CI, superseded; v10.0.3
  is GREEN — the walk's failure to merge is not the tag's failure).
- The bounded review loop (advisor-directed): fix + targeted closure of the finding + its invariant.
- Workflow transport for all reviewer/builder agents (subagent spawns guard-broken fleet-wide).
- The driver runs FROM THE WT COPY (.worktrees/intent-to-completion/scripts/bootstrap-v10.mjs) with
  --state=docs/masterplan/intent-to-completion/state.yml FROM MAIN (record from MAIN, never the WT).

## Paths

- MAIN /srv/dev/ras/masterplan (local main at e16a276 = origin/main ✓); WT
  .worktrees/intent-to-completion (branch masterplan/intent-to-completion at f155411); the bundle
  docs/masterplan/intent-to-completion/ (state.yml + events.jsonl + whole-scope-reviews.json).
- Suite 2743/2743 both envs at f155411; doctor green; pass 4 version 10.0.3; the corrective
  history: pass1 red(test hermeticity) → pass2 red(pin evidence) → pass3 red(doctor host-local) →
  pass4 green-but-unmergeable → pass5 (10.0.4) carries the three driver fixes into the product.
