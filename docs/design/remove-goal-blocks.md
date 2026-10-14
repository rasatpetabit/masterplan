# Remove numbered goal blocks; keep the Intent block

Status: decided 2026-10-14 (operator instruction; design settled by the conductor after a
read-only coupling map, an advisor pass, and a cross-vendor design review).
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
  `validateGoalsLoadGate` (`lib/goals.mjs:1330`) enforced, sets `goals_enabled`, and appends
  `goals_frozen` with the Intent hash and an empty goal list. Intent is approved where the
  operator already approves it: the spec gate, whose hash spans `spec.md` + `goals.md`.
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
assessment gone, that independent source becomes a new mechanical `verify_passed` event the
CLI appends when the shell answers `run_verify` with pass: `{head_sha, base, diff_hash,
verify_output_hash}`, with head and diff hash computed by the CLI from git, never accepted
from the caller. Binding source = latest `verify_passed`, else (in-flight legacy bundles)
latest non-final `goal_check`; neither → the existing refusal. A legacy implementation
`goal_check` proves branch bindings only; it is never read as evidence of an Intent review.

## In-flight bundles (no migration command)

- Frozen G blocks become inert: no coverage, no implementation check, no per-goal doctor.
- A pending `goals_unmet` with `mode: 'final'` is honored as `intent_unmet` (same failure,
  same unresolved disposition). A pending implementation-mode `goals_unmet` is obsolete: the
  next `finish-step` entry appends a `gate_retired` event (`{gate, mode, reason}`), clears it,
  and continues the finish flow. A final failure is never silently cleared.
- Archived bundles stay terminal and byte-identical; `mp doctor` reports no new findings on
  them (historical G content is provenance, not a defect).

## Required regression cases

1. Golden vectors: `goalsHash` of every committed `docs/masterplan/*/goals.md` (both pins
   where applicable) equals the pre-change value.
2. Zero-G lifecycle: a new bundle with topic + Intent only passes capture → spec gate → plan
   → execute → finish → final assessment → `intent_confirm` → archive `complete`.
3. Missing Intent at spec→plan is refused; a stripped schema-backed representation is refused.
4. Pending `goals_unmet` final mode → handled as `intent_unmet`; implementation mode → retired
   with a `gate_retired` event, finish continues.
5. Prepared legacy promotion with `goal_amend` receipt recovers; a new promotion needs only
   the outer approval.
6. Final receipt: stale (goals.md changed), tampered bindings, self-supplied bindings, and no
   `verify_passed`/legacy binding source are all refused.
7. `verify_passed` refuses caller-supplied head/diff that disagree with git.
8. Archived bundles: byte-identical; `mp doctor` findings on this repo unchanged from `main`
   apart from removed goal checks.
