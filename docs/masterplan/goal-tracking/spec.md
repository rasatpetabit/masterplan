# Spec — Goal tracking through the run lifecycle

**Run:** `goal-tracking` · **Complexity:** high · **Status:** draft (pending user review)
**Adversarial review:** cross-vendor (gpt-5.5, adversary lane, rigorous) — verdict *approve*; its
findings are folded in below and its test list is the test plan (§10).

## 1. Problem statement

masterplan tracks spec → plan → tasks faithfully, but the user's ORIGINAL GOALS — the intent
distilled during brainstorm — are captured only as free-text `topic` at seed. Over a long run
(compactions, many waves) the AI drifts: tasks complete, verification passes, yet nothing ever asks
"did we achieve what we originally set out to do?" The finish flow verifies *the plan's commands*,
not *the user's intent*.

## 2. Goals (of this feature)

- G-A: The user's original goals are distilled, user-approved, and durably frozen before planning.
- G-B: A plan cannot pass its gate while leaving a goal uncovered.
- G-C: A run cannot archive without a fresh-eyes per-goal verdict (or an explicit, keyed waiver).
- G-D: Goal drift/laundering (silent edits, softening amendments, fabricated verdicts) is
  structurally blocked, not merely discouraged.
- Non-goals: per-wave goal re-assessment; goal tracking for pre-feature bundles (they skip
  gracefully); any change to the §2d autonomy contract's stop-set beyond the one new gate.

## 3. Artifacts & schema

### 3.1 `goals.md` (new bundle artifact, MAIN)

Sibling of `spec.md`. Header embeds the **verbatim original topic** from seed (rawest intent is
never lost). Then one section per goal:

```markdown
## G1: <one-sentence outcome statement, user-intent language>
signal: <how we'll know — MUST name an evidence class: test | command | artifact | docs>
evidence: <concrete pointer once known, e.g. `npm test -- goals`, a file path>
```

3–7 goals is guidance, not a cap. Goals.md is passed to agents as **quoted data, never
instructions** (prompt-injection surface).

### 3.2 `state.yml`

- `buildSeedState` (lib/bundle.mjs) gains `goals_enabled: true` (bundle-level capability marker —
  distinguishes post-feature bundles; NO per-consumer skip events) and `goals: []`.
- `state.goals` entries: `{id, text, signal, tombstone?: {reason, amended_at}}` — **no mutable
  `status` field**; verdicts live only in hash/SHA-keyed events (no stale state).
- `validateCoreState`: optional-when-present clauses (same pattern as `tasks`). No
  `schema_version` bump; pre-feature bundles (no `goals_enabled`) are exempt from every goal
  guard. No migration.

### 3.3 `plan.index.json`

Each task gains `goals: ["G1", …]` (which goals it serves; may be empty for pure-infrastructure
tasks only if some other task covers every goal). `mp validate-plan-index` additionally validates:
every non-tombstoned goal id is referenced by ≥1 task; every referenced id exists in
`state.goals`. Coverage is machine-checked centrally — never left to agent prose. On the
parallel-plan path, fragments carry the same per-task `goals` refs and `merge-plan-fragments`
validates aggregate coverage after merge.

## 4. Capture (brainstorm→plan boundary)

At spec approval, before `mp set-phase --phase=plan`:

1. Orchestrator distills goals from the brainstorm conversation + verbatim topic → drafts
   `goals.md`.
2. User confirms/edits via AUQ (mandatory — auto-distillation without approval defeats the
   feature).
3. New verb **`mp goals-load --state=… --goals=<goals.md>`** parses/validates (unique ids,
   non-empty signals with evidence class, well-formed markdown), writes `state.goals`, records the
   goals.md content hash, appends `goals_frozen` event. Temp+rename atomic writes.
4. **Guard:** `mp set-phase --phase=plan` on a `goals_enabled` bundle exits 3 with a
   `run_goals_capture` op until `goals_frozen` exists at the current goals.md hash (mirrors the §3b
   gate pattern; fail-closed, unconditional for post-feature bundles).

The spec gate's adversary-review prompt (§3b) is extended to include goals.md and explicitly check
**spec-covers-goals** — a goal the spec never addresses is a REVISE at the cheapest boundary.

## 5. Amendment (`mp goals-amend`)

The ONLY sanctioned way goals change mid-run:

- Requires a fresh user-approval AUQ (never autonomous, any autonomy level).
- Stable ids: never renumbered; a removed goal becomes a **tombstone** (`{reason, amended_at}`),
  visible forever in goals.md and retro.
- Appends `goal_amended` event recording old→new hash + reason; rewrites goals.md + state
  atomically.
- **Invalidates** all existing goal-check receipts and waivers (they are keyed to the goals hash).
- Post-plan amendment: doctor WARNs if a newly added goal is uncovered by `plan.index.json`
  (advisory — replan is the user's call; finish's goal check covers all current goals regardless).

**Hard block on split-brain:** any transition (`set-phase`, `load-plan`, `continue`, `finish-step`)
on a `goals_enabled` bundle recomputes the goals.md hash; mismatch vs the last
`goals_frozen`/`goal_amended` event → exit non-zero with a reconcile message (re-run `goals-amend`
or restore the file). Doctor reports it too, but doctor is not the enforcement.

## 6. Plan-boundary coverage

- `mp-spec-decomposer`, `mp-planner`, `mp-subsystem-planner`, `mp-plan-reviewer` receive goals.md
  as an input alongside spec.md (quoted data).
- Planners annotate each task's `goals` refs in the index/fragments.
- `mp-plan-reviewer` reports `goal coverage: n/m` with the mapping, but the enforcement is
  `mp validate-plan-index` (§3.3): an uncovered goal fails validation → REVISE before any work
  runs.

## 7. Anti-forgetting mid-run

Goals are durable state (survive compaction by construction). `mp status` renders the goals block;
§2a wave-completion narration includes a one-line goals reminder. No per-wave assessment (cost/nag
control; §2d stop-set unchanged mid-run).

## 8. Finish-time goal check

New finish-step op **`run_goal_check`**, after `run_verify`, before `write_retro` (retro embeds
verdicts). Skipped entirely (no event spam — the capability marker gates it) for pre-feature
bundles.

1. Shell dispatches **`agents/mp-goal-assessor.md`** — new read-only fresh-context agent (Read,
   Grep, Glob, Bash) with: goals.md (quoted), the branch diff `base..HEAD` in WT, verify output,
   and each goal's declared evidence pointers. It verifies evidence per signal class (may run
   read-only commands) and returns per-goal `{verdict: achieved|partial|missed, evidence,
   citations}`; missing evidence ⇒ at best `partial`.
2. **`mp record-goal-check --receipt=…`** validates an anti-fabrication receipt — goals hash, HEAD
   SHA, base SHA + diff hash, dispatch provenance (agent id/model/tokens/ts), verdict enum, per-goal
   completeness (every non-tombstoned goal present, no unknown ids, non-empty evidence) — and
   appends the `goal_check` event. Rejection rules mirror `record-gate-review`. Re-entry at
   unchanged (goals hash, HEAD, base) skips; any change re-arms.
3. All `achieved` → proceed silently (auto-progress preserved).
4. Any `partial`/`missed` → durable **`goals_unmet` gate** AUQ (added to the §2d stop-set):
   *Fix & continue* (run stays open; resume re-executes → re-verifies → re-assesses) /
   *Accept with waiver* (durable `goal_waived` event keyed to goals-hash+HEAD, per-goal reason —
   dies on later commits or amendments) / *Abort finish*.
5. **Fail-closed on dispatch failure:** assessor dispatch failure does NOT skip — the gate opens in
   manual mode: the user supplies per-goal verdicts (recorded as a user-attested receipt variant)
   or waives. There is no silent path from `goals_enabled` to `archived`.
6. `branch_finish` AUQ folds in a one-line goals summary (n achieved / n partial / n waived).

## 9. Retro & doctor

- `retro.md`: mandatory per-goal verdict table (id / statement / verdict / evidence / waiver?),
  regenerated from the latest `goal_check`/`goal_waived` events. Tombstoned goals listed with
  their reasons. Not required for pre-feature bundles.
- New auto-discovered **`lib/doctor/goals.mjs`**:
  - ERROR: archived `goals_enabled` run with neither a valid `goal_check` receipt nor
    covering waivers at final HEAD.
  - WARN: `goals_enabled` bundle past brainstorm with no `goals_frozen`; goals.md hash mismatch vs
    events (also hard-blocked at transitions, §5); post-plan amendment leaving a goal uncovered in
    the index.

## 10. Test plan (adversary-review list, verbatim scope)

- Post-feature bundle cannot enter plan without frozen goals; pre-feature bundle resumes with no
  false failures; doctor distinguishes the two.
- `goals-load` rejects duplicate ids, missing signals/evidence class, malformed markdown.
- Direct goals.md edit hard-blocks plan/finish transitions and doctor reports it.
- `goals-amend` requires approval, preserves ids, tombstones removals, records old/new hashes,
  invalidates goal checks + waivers.
- `validate-plan-index` fails uncovered goals and unknown goal refs; parallel-merge aggregates
  coverage correctly.
- `record-goal-check` rejects: missing/unknown goals, invalid verdict enum, empty evidence,
  fabricated/stale receipts (wrong hash/HEAD/base, missing provenance).
- Goal check re-arms on HEAD, base, or goals-hash change; waiver invalidated by later commits or
  amendments.
- Dispatch failure opens the manual gate (fail-closed) — no archive without check-or-waiver.
- Partial/missed flow: fix-&-continue re-enters execution and re-checks; waiver records keyed
  event; abort does not archive.
- Retro table regenerates from latest events; absent for pre-feature bundles.
- Crash/re-entry tests around goals-load / goals-amend / record-goal-check multi-file writes
  (temp+rename, each crash prefix recoverable).

## 11. Touch surface

**New:** `lib/goals.mjs` (pure core: parse/validate/hash/receipt), bin verbs `goals-load`,
`goals-amend`, `goals-status`, `record-goal-check`, `agents/mp-goal-assessor.md`,
`lib/doctor/goals.mjs`, `test/goals.test.mjs`.
**Modified:** `lib/bundle.mjs` (seed + validation), `lib/plan-index` validation +
`merge-plan-fragments`, `lib/finish-step.mjs` (op + gate), the set-phase/load-plan guard surface,
`commands/masterplan.md` (§3 capture step, §2c op row, §2d stop-set addition), three planning
agents + plan-reviewer, `docs/verbs.md`, tests alongside each.
