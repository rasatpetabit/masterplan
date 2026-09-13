# masterplan finish-flow gaps found landing pricing-capture (2026-09-12)

Context: the `pricing-capture` bundle was finished by a takeover session after
its original orchestrator was terminated mid-run. The finish flow completed
(archived, `completion: complete`), but four machinery gaps had to be worked
around by hand, two via operator-approved ledger amendments. Commit hashes
cited below are commits in the litellm repo, not in this one, so they cannot be
resolved from a masterplan checkout.

## 1. `commitBundle` silently no-ops for worktree-based bundles

- Symptom: archive stop returned `{op:'stop', reason:'archived'}` but nothing
  was committed — the archived state sat uncommitted in the bundle's worktree
  while main's tracked copy still said `status: in-progress`.
- Root cause: `lib/finish-step.mjs` `commitBundle(MAIN, bundleDir, message)`
  computes `bundleRel = path.relative(MAIN, bundleDir)` and runs
  `git -C MAIN status/add/commit -- <bundleRel>`. For a linked-worktree bundle
  that path is `.worktrees/<name>/docs/masterplan/<slug>` — invisible to main's
  index — so `status --porcelain` is empty and the function returns null. The
  no-op is silent by construction.
- Consequence: the durable archive record never lands on the base branch — the
  silent-loss class masterplan's INTENT top invariant forbids. A
  `removed_after_merge` teardown at that point would have deleted the
  completion record, both goal_check receipts and the live_check evidence.
- Workaround: rsync the archived bundle (excluding `.owner*`) into main's
  tracked `docs/masterplan/pricing-capture/`, commit, push (litellm `d2d046c`).
- Fix direction: if `bundleDir` is not inside `MAIN`'s tree, commit in the
  worktree's checkout and land it on the base explicitly, or fail loudly. A
  silent null at the archive transaction is never acceptable.

## 2. User-attested goal_check receipts can never re-validate

- Symptom: after recording both receipts through the bin, the final assessment
  refused: `user-attested goal check requires a valid approval_receipt:
  approval receipt must be a JSON object`.
- Root cause: writer/reader mismatch — `bin/masterplan.mjs` (~2238) stores
  `data.provenance.approval_receipt`; `lib/finish-step.mjs` reads
  `data.approval_receipt` (~1328, ~1375). The assessor path is consistent;
  only the user path is mismatched.
- Consequence: the manual attestation path the goals_unmet gate explicitly
  offers ("attest verdicts or waive to proceed") produces receipts the final
  gate always rejects.
- Workaround (operator-approved amendment): mirrored `provenance.approval_receipt`
  to `data.approval_receipt` on both goal_check events.
- Fix direction: read `data.provenance?.approval_receipt ?? data.approval_receipt`;
  regression-test by recording through the bin and re-validating through
  `finalReceiptFor`.

## 3. `--deploy-step-done` accepts a live_check report with no evidence

- Symptom: `--deploy-step-done='live_check[0]' --exit=0` was accepted; the run
  then dead-ended at `live_check_evidence_missing` (`cause: digest_missing`),
  whose only choice is abort → archives `incomplete` despite a real green run.
- Root cause: `--digest-file` is optional at report time (`bin/masterplan.mjs`
  ~800) but §7.1 makes it mandatory at the final assessment; the refusal fires
  two stages later where no retry can re-run a step already recorded done.
- Workaround (operator-approved amendment): computed the true sha256 of the
  real evidence file, added `digest` + `digest_path` to the recorded
  deploy_step event, ingested the file into `bundle/evidence/sha256-<hex>.txt`
  exactly as the report-time path would (the flow's stored-artifact
  re-verification then passed).
- Fix direction: require `--digest-file` at report time when group is
  `live_check` — the evidence is knowably mandatory there; refuse early.

## 4. Branch identity is hard-derived from the slug

- Symptom: `no retirement identity for masterplan/pricing-capture (... the
  branch ref is gone)` while the actual branch `masterplan/pricing-closeout`
  existed at the recorded tip.
- Root cause: `lib/worktree.mjs` `worktreeBranchFor(slug)` returns
  `masterplan/${slug}` unconditionally; a bundle branched under any other name
  can never satisfy the strict ref witness.
- Workaround: `git branch -m` to the canonical name (no PR existed).
- Fix direction: record the actual branch name in state at kickoff; fall back
  to the derived name only for legacy bundles.

## Cosmetic: retro "Pushed to origin: no" with a user_only-only contract

No release/install group → no `pushed_base` → the `push_archive` gate never
opens → the retro's `## Completion` block never re-renders after the driver
pushes the archive commit. The ledger is correct; the rendering is stale.

## What completed despite the gaps

Landed `masterplan/pricing-capture` into litellm main (merge `b8b88be` +
follow-ups through the archive + evidence commits): litellm suite 2646 passed,
agent-routing suite 956/956 at the landing revision, capture subsystem
installed (litellm ref v1.100.1 proven byte-identical from the running
gateway), timer enabled+active, first real capture exit 2 with named gaps (the
operator-accepted daily state), bundle archived `completion: complete` with
both goal_check receipts (user-attested) and the live_check evidence ingested.
