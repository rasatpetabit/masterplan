# Remove numbered goal blocks; keep the Intent block

Status: decided 2026-10-14 (operator instruction; design settled by the conductor after a
read-only coupling map, an advisor pass, and a cross-vendor design review — rev 2 resolves
review blockers B1 (binding source after gate retirement) and B2 (`verify_passed`
injectable through `mp event`) and advisories A3/A4).
INTENT.md verdict: **serves** — Direction makes intent "the standard the finished work is
judged against"; the top invariant's "nothing is declared done without evidence" is kept by
the retained final Intent assessment.

## Decision

The operator removes the enumerated, separately approved `## G<n>:` goal blocks and every
mechanism that exists only to approve, freeze-with-approval, amend, cover, check, waive or
report them. The `topic:` anchor and the `## Intent` block stay, and remain what the
delivered work is judged against.

## Principle: behavior and public surfaces change; on-disk wire names stay

Archived bundles, receipts and event logs are never rewritten. Names that are persisted on
disk keep their spelling and are re-documented as Intent-identity names:

| Wire name (kept) | Meaning after this change |
|---|---|
| `goals.md` | the run-Intent artifact: `topic:` anchor + `## Intent` (new runs carry no `## G<n>:`) |
| `goals_hash` (receipts, `intent_identity`, checkpoint tuples) | canonical run-Intent identity |
| `goals_enabled` (state.yml) | durable marker: this bundle has a run Intent and its finish requires the final Intent assessment. Never derived from the document. |
| `goals_frozen` / `goal_amended` events | Intent-identity lineage (goal list empty for new runs) |
| `goal_check` event with `final: true` | the final Intent assessment record |

Public, non-persisted surfaces are renamed to say what they do: `record-goal-check --final`
→ `record-intent-check`; `agents/mp-goal-assessor.md` → `agents/mp-intent-assessor.md`
(final mode only); gate `goals_unmet` (final mode) → `intent_unmet`; `--goals-choice` →
`--intent-choice`. Prompt and binary ship together, so no CLI aliases are kept.

## Hash identity — no new contract version

Both canonicalizers in `lib/goals.mjs` `goalsHash` (legacy and `schema_backed`, ~744–781)
stay **byte-identical**. A document with no G blocks canonicalizes with `goals: []`, which
both payloads already accept. Consequences: every archived/in-flight hash is unchanged; no
receipt is voided; no migration command. Historical G parsing (`parseGoals`,
`canonicalGoalsList`, tombstones, `evidence`) is retained **only** as needed to reproduce old
identities; its operational validation is removed. The durable format pin and its
downgrade refusal are unchanged.

## What is removed

- `## G<n>:` authoring at capture time; goal-count / signal / evidence / tombstone validation
  as a requirement on new documents.
- Verbs `goals-load`, `goals-amend`, `goals-status`; the operator approval AUQ and
  approval-receipt check for a goal set.
- Plan-gate goal coverage (every goal cited by ≥1 task) and task `goals:` annotations. Old
  `plan.index.json` files carrying `goals` fields still load; the field is ignored.
- Implementation-mode goal assessment (`run_goal_check`, `--goal-check`, per-goal verdict
  tables, implementation-mode `goals_unmet`, its fix/waiver/manual-verdict flow, per-goal
  waivers and `goal_waived`).
- Per-wave goal reminders, `state.goals` cache production, goal tables in status/retro/runs
  output, goal-specific doctor checks (frozen set, coverage, per-goal receipt presence, hash
  drift of the goal list).
- The additional `approval.goals_amend` receipt requirement on **new** promotion transactions.

## What stays (the Intent guarantees)

- Interview, schema capture, codec, reconciliation, durable format pin, immutable topic anchor.
- Intent capture at the spec→plan boundary — **mechanical, no separate operator approval**.
  Entering `plan` validates `goals.md` (topic + Intent; G blocks neither required nor
  validated), enforces the interview exit and assumption coverage that
  `validateGoalsLoadGate` (`lib/goals.mjs:1330`) enforced, and appends `goals_frozen` with the
  Intent hash and an empty goal list. `goals_enabled` keeps its existing producer (seed time,
  `lib/bundle.mjs` ~502) and the format pin keeps its (`schema_captured`, `lib/interview.mjs`
  ~1207). Intent is approved where the operator already approves it: the spec gate, whose
  hash spans `spec.md` + `goals.md` and whose prompt step presents the Intent for approval
  (`commands/masterplan.md` ~587–589) — that presentation stays.
- Substantive Intent/spec amendment through the existing promotion transaction
  (`lib/promote.mjs`), whose outer approval binds both artifacts' base/result hashes and the
  diff. Prepared (pre-upgrade) transactions recover under their **original** contract,
  including their `goal_amend` receipt.
- Checkpoint freshness (`lib/checkpoint-evidence.mjs` intent identity tuple) at spec, plan,
  task-review and finish; the split-brain / committed-hash guards over `goals_frozen` /
  `goal_amended` lineage.
- Final Intent assessment after deploy + live check (`evaluateFinalAssessment`,
  `run_final_check`): `met` → `intent_confirm` gate; `partial|missed` → `intent_unmet` gate
  with `waiver` (→ `incomplete_authorized: intent_waived`), `abort`, or `--intent-rejected`
  (successor obligation). Incomplete authorization never becomes `complete`. Fail-closed on
  assessor unavailability (manual-verdict mode at the gate).

## Final-receipt branch bindings (replaces the implementation receipt dependency)

`finalReceiptFor` (`lib/finish-step.mjs:1411–1441`) refuses unless an **independently
recorded** implementation `goal_check` supplies `head_sha` / diff hash / `verify_output_hash`,
so a final receipt cannot validate its own branch bindings. With the implementation
assessment gone, that independent source becomes a new mechanical `verify_passed` event that
`finish-step` appends when the shell answers `run_verify` with pass: `{head_sha, base,
diff_hash, verify_output_hash}`.

- **Git facts are computed, never accepted.** `head_sha`, `base` and `diff_hash` are derived
  by the CLI from the worktree (`WT`, still present at verify time) — the same derivation the
  current recorder validates caller flags against.
- **Verification output transport.** The shell passes `--verify=pass --verify-output=<file>`;
  the CLI hashes the file into `verify_output_hash`. That commands ran and passed remains the
  shell's assertion — the same trust level as today's `--verify-output-hash` — and the design
  does not claim more.
- **Single producer.** `verify_passed` and `goal_check` are reserved event types: the generic
  `mp event` writer (`bin/masterplan.mjs` ~1683–1718) refuses them (exit 2). Their only
  producers are `finish-step` (verify) and `record-intent-check` / legacy recorder paths that
  validate against git and the current Intent hash.
- **Binding source** = latest `verify_passed` whose `head_sha` is the finish HEAD, else (in-
  flight legacy bundles) latest non-final `goal_check`; neither → the existing refusal. A
  legacy implementation `goal_check` proves branch bindings only; it is never read as evidence
  of an Intent review.
- **Always establishable before teardown.** The `run_verify` skip (`verified_sha` equals HEAD,
  `lib/finish-step.mjs` ~2197–2205) additionally requires a binding source for that HEAD on a
  `goals_enabled` bundle. An upgraded run that verified under the old flow but has no
  `verify_passed` (e.g. paused at a manual implementation gate) re-runs verification once,
  before merge or worktree removal, so the final assessment can always bind.

## In-flight bundles (no migration command)

- Frozen G blocks become inert: no coverage, no implementation check, no per-goal doctor.
- A pending `goals_unmet` with `mode: 'final'` is honored as `intent_unmet` (same failure,
  same unresolved disposition). A pending implementation-mode `goals_unmet` is obsolete: the
  next `finish-step` entry appends a `gate_retired` event (`{gate, mode, reason}`), clears it,
  and continues the finish flow — which, per the binding rule above, re-runs verification when
  no binding source exists for HEAD. A final failure is never silently cleared.
- Promotion transactions gain `approval_contract: 2` in the prepared document. New
  transactions write it and need only the outer approval; a prepared document without the
  field is legacy and recovers under the original validation, including its `goal_amend`
  receipt (`lib/promote.mjs` ~352–364, ~481–494).
- Archived bundles stay terminal and byte-identical; `mp doctor` reports no new findings on
  them (historical G content is provenance, not a defect).

## Required regression cases

1. Golden vectors: `goalsHash` of every committed `docs/masterplan/*/goals.md` (both pins
   where applicable) equals the pre-change value.
2. Zero-G lifecycle: a new bundle with topic + Intent only passes capture → spec gate → plan
   → execute → finish → final assessment → `intent_confirm` → archive `complete`.
3. Missing Intent at spec→plan is refused; a stripped schema-backed representation is refused.
4. Pending `goals_unmet` final mode → handled as `intent_unmet`. Implementation mode (incl.
   manual mode after assessor dispatch failure, `verified_sha` == HEAD, no `goal_check`) →
   retired with a `gate_retired` event, verification re-runs, and the run reaches a **valid
   final assessment** after deploy — not `final_check_invalid`.
5. Prepared legacy promotion (no `approval_contract`) with `goal_amend` receipt recovers under
   the legacy contract and is refused without it; a new promotion (`approval_contract: 2`)
   needs only the outer approval.
6. Final receipt: stale (goals.md changed), tampered bindings, self-supplied bindings, and no
   `verify_passed`/legacy binding source are all refused.
7. `verify_passed` bindings come from git: a run whose WT HEAD differs from the claimed head
   cannot produce a matching event; `mp event --type=verify_passed` and
   `mp event --type=goal_check` exit 2.
9. Upgraded run with `verified_sha` == HEAD and no binding source re-runs `run_verify`; with a
   `verify_passed` for HEAD it skips as today.
8. Archived bundles: byte-identical; `mp doctor` findings on this repo unchanged from `main`
   apart from removed goal checks.

## rev 3 — review fixes

A post-implementation review (adjudicated: five CONFIRMED blockers, three advisories) refined
this design's mechanics; the decision above is unchanged. Fixes landed on this branch:

1. **finish-bindings-1 — binding selection uses the finish HEAD everywhere.** A new
   `resolveFinishHead` (the `branch_tip` on the latest `branch_finish`, else
   `branch_finish_intent`, else the current worktree HEAD) now scopes every binding-source
   consumer — the run_verify skip, the run_final_check briefing, record-intent-check and
   finalReceiptFor. No consumer selects "latest event regardless of HEAD": a run that verified
   at A, moved to B and returned to A retires at A and binds to A's event; a receipt carrying
   B's facts is refused.
2. **finish-bindings-2 — verify_output_hash is independent evidence.** Every pass answer
   (the normal pass AND each reviewed override) requires `--verify-output=<file>` (exit 2
   without it); the CLI hashes the file into the binding, so every new `verify_passed` carries
   a CLI-computed `verify_output_hash` and there is no "incomplete binding" state. For an
   override the file is the override evidence (the failing output, or the operator's recorded
   override answer when there is no command). The validators require the receipt's hash to
   EQUAL the selected binding's; legacy `goal_check` bindings keep the hash they recorded.
3. **L1 — plan-entry validation runs on every spec→plan attempt.** Validation (Intent
   validity, interview exit, assumption coverage) re-runs regardless of an existing freeze;
   the order is validate → split-brain → spec-review gate → freeze append (idempotent at the
   same hash). `--force` bypasses the spec-review gate only. A legacy bundle frozen
   pre-upgrade without an Intent block is refused at plan re-entry until the Intent block is
   added through a promotion transaction. The main-side exemptions (pre-interview bundles,
   durable waivers) are preserved.
4. **L2 — a new promotion must not delete an existing Intent block.** `beginPromotion`
   refuses, before any transaction document, ref pin, artifact write or lineage event, when
   the base goals.md carries an Intent block and the result does not. V1 documents that never
   had one keep working; prepared legacy transactions recover under their original contract.
5. **B1 — assessor outage at the first final assessment is reachable.** After one retry the
   sequencer AUQs the operator for the verdict (met|partial|missed) with evidence and records
   it with the existing user-attested provenance; a bare re-entry opens intent_confirm
   (met) or intent_unmet (partial|missed). No fabricated assessor receipt opens either gate
   (and finalReceiptFor now replays the recorder's `provenance.approval_receipt` spelling).

Advisories: the CHANGELOG carries the `mp runs list`/inventory-digest compatibility note; the
prompt and docs/verbs.md describe both binding sources; the spec-gate artifact matrix names
`goals.md` on goals-enabled bundles.
