# Retro — fresh-eyes-remediation

**Bundle:** `fresh-eyes-remediation` · **Branch:** `masterplan/fresh-eyes-remediation` · **Release:** v9.10.0 @ `c4ba19c` (tag re-cut) · **Recorded waves:** 0–5, all 32 tasks.

## What we did

Seeded from a 42-lens fresh-eyes audit (4 parallel sweep workflows + cross-verifiers), remediated
every confirmed finding A1–A9, B1–B5, C1–C10, D1–D4, E1–E12, F1–F3 across 6 waves: behavioral
repairs, goals-system re-freeze + waivers, dead-code deletion, config scrub, docs/skills
realignment, and a terminal release wave. Suite 1649 → 1637 (deletions + new regression tests),
doctor 1 error / 7 warn → 0 / 0, CI red → green, plugin registry drift → resolved at v9.10.0.

## What surprised us

1. **The D6 scope guard worked as designed — and needed its escape hatch three times.** Waves 1–3
   each carried justified out-of-scope changes (a prompt-contract test, the design-doc policy
   itself, tests for a deleted function). Revert-at-record + user-approved re-apply + logged
   `scope_expansion_approved` events handled all three without corrupting the record.
2. **Five archived pre-enforcement bundles could not be goal-checked retroactively.** Resolved by
   user-attested waivers (goals_waive with reason/user/receipt) instead of fake verdicts — the
   waiver machinery got its first real production use.
3. **CI caught two portability bugs the local suite couldn't see** (Node-22 iterator helpers on a
   Node-20 runner; missing git identity in temp repos). The release tag was re-cut at the green
   commit — safe because release-publish had skipped on red. Lesson: local green is necessary, not
   sufficient; the merge-commit CI gate (G4) exists for exactly this.
4. **The goal-assessor read the worktree's stale copy of bundle state** and reported "32 tasks
   pending, no wave_recorded events" — an artifact of bundle state living in the main repo working
   tree while the branch carries the seed-time snapshot. Its three doc-staleness findings,
   however, were all real and were fixed at finish time. Lesson: archive the FINAL bundle state
   into the branch at finish, not the seed snapshot.
5. **Wave 4's parallel run was interrupted mid-flight** with one task half-delivered (code landed,
   fixtures/tests missing). A focused completion builder recovered it cleanly — the builder-digest
   + worktree-as-truth pattern makes interrupted waves resumable.

## What we'd do differently

- **Wave-4-style doc bundles should be smaller per-builder** — 8 builders with up to 4 files each
  still left 3 stale spots the goal-assessor had to catch. A post-wave doc-grep pass (deleted-symbol
  scan over live docs) before recording would have caught them cheaper.
- **Wave-5 builder split (local half / network half)** worked well and should be the template for
  any release wave: builders never push; the orchestrator owns network steps and the user owns
  harness-session steps (`/reload-plugins`).
- **Inventory formatting rules should be in the task body, not just verify commands** — the strict
  A6 idiom (no bare finding-ids on any line) cost review cycles twice because it lived only in
  verify commands.

## Adversarial branch review (finish flow)

Twelve breaker leaves over the branch's highest-risk seams. Outcomes:

- **Clean:** fail-closed `parseArgs` (`die()` exits unconditionally; `rejectUnknownFlags` runs
  immediately before dispatch); E12 narrowed doctor catch (no silent bundle exclusion);
  `goal_check` append binding + provenance split (user vs assessor receipts).
- **Fixed at finish:** waiver idempotency was keyed only on goals/head/base/diff — a repeat
  waiver with DIFFERENT reasons was silently dropped; now evidence-bound (commit `2182e28`).
- **Adjudicated residuals (accepted, not blockers):** `validateUserApprovalReceipt` is lenient
  when `expected` is empty, but all four live call sites bind purpose + goals-hash, and the
  design is single-operator attestation, not cryptographic auth; `goal_check` tuple-only
  idempotency is documented design; the CLI trusts caller-supplied evidence tuples by contract.
- **Environment flake:** one suite failure in ~6 runs traced to a tmpdir collision in the
  refs amend-plan test under load (3 consecutive green runs after); worth a tmpdir-hardening
  pass in a future run.

## Durable lessons

- Fail-closed parsing (A7) turns "silently ignored flag" incidents into immediate errors — worth
  the one-time migration cost everywhere a CLI grows flag families.
- Goal-gate flags only mean something when they're threaded into ctx — a parsed-but-unused flag is
  indistinguishable from a missing one until someone greps the record call.
- `mp doctor` at 0/0 is a livable daily state once bundle-state and registration checks are both
  wired; keep it that way.
