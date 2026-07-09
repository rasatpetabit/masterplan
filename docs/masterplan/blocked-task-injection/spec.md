# Spec: blocked task status + status-preserving task injection + explicit waivers

**Run:** `blocked-task-injection` · **Complexity:** moderate · **Adversary review:** ON (`state.review.adversary: true`, armed at seed + re-verified)

## Purpose

Masterplan's wave dispatcher is strictly serial-by-wave: it always dispatches the
lowest-numbered pending wave (`Math.min(...pending.waves)` in `lib/resume.mjs`) and never
skips. This is correct for an acyclic dependency DAG, but it has two failure modes that
together make it impossible to progress a run past a **permanently-blocked wave** and
impossible to **inject follow-on tasks** into an in-flight bundle:

1. **The strict-min trap.** A task that can never run (e.g. hardware-gated HIL on absent
   optic-5c hardware) sits `pending` forever. `Math.min` keeps re-selecting its wave; that
   wave can never clear; every higher wave is starved; the run can never finalize
   (`complete` requires `pending.length === 0`). The bundle is wedged with no escape.
2. **No status-preserving injection primitive.** `load-plan` hard-refuses a populated bundle;
   `backfill-waves` re-derives waves of **existing** tasks only (drops new ids); `seed-tasks`
   `--force` clobbers **all** statuses. There is no way to append new tasks (or refresh an
   existing task's wave/files) while preserving the run's accumulated done/in-progress state.

This run adds three coupled primitives:

- A **`blocked`** task status so dispatch skips a gated wave without lying about completion.
- A **status-preserving `mp amend-tasks`** upsert verb for injecting tasks into in-flight bundles.
- An **`mp waive-task`** gate so a run with remaining blockers finalizes only under explicit
  operator consent (never silently).

## Problem (grounded)

### The strict-min dispatch constraint

`lib/resume.mjs:151` selects the dispatch wave:
```js
const pending = tasks.filter((task) => task.status !== 'done');   // line 151
...
const wave = Math.min(...pending.map((task) => task.wave));         // line 192
```
`bin/masterplan.mjs:690`: `VALID_TASK_STATUS = ['pending', 'in_progress', 'done']` — there is
**no** `blocked`/`deferred` value (those are legacy v7, migration-only). A gated task is
indistinguishable from a runnable one. `complete` (`resume.mjs:153`) fires only at
`pending.length === 0`, so even if dispatch could skip the wave, finalization could not.

**Every site that treats `!== 'done'` as "still needs to run" must learn `blocked`:**

| File:line | Role | Treatment of `blocked` |
|---|---|---|
| `lib/resume.mjs:151` | main dispatch selection (`pending`) | **exclude** (skip the wave) |
| `lib/resume.mjs:132` | in-flight wave recovery (`incomplete`) | **exclude** (don't re-dispatch a blocked task) |
| `lib/wave.mjs:192` | wave pending count | **exclude** (a blocked task isn't pending work) |
| `bin/masterplan.mjs:919,1513` | wave-less stuck-guard (backfill/seed) | unchanged — blocked tasks keep valid waves; guard iterates the excluded `pending` so it won't fire on a blocked task |
| `bin/masterplan.mjs:2369` | gate-review receipt `done`/`skipped` | unrelated (gate review, not task lifecycle) — untouched |

### The injection-primitive gap

`lib/bundle.mjs:525` `applyPlanIndex` (used by `backfill-waves`):
```js
const tasks = (state.tasks ?? []).map((task) => {
  const p = byId.get(String(task.id));
  if (!p) return task;                 // <-- new ids DROPPED, never appended
  return { ...task, wave, files };     // status-preserving for EXISTING ids only
});
```
`load-plan` refuses any populated bundle (`bin:910`); `seed-tasks --force` does a wholesale
`writeState({...state, tasks})` built fresh, clobbering every status (`bin:1530`).

**The seam that's already status-preserving:** `applyPlanIndex` keeps `{...task, wave, files}`
(its status survives). It only fails to **append** new ids. A status-preserving upsert is a
small extension, not a new subsystem.

### The finalize trap

With `blocked` excluded from the dispatch filter, a bundle whose only non-done tasks are
blocked would hit `complete` (`resume.mjs:153`) — **silently finalizing a run with unfinished
work**. That must not happen: blockers block finalize until an operator explicitly waives them.

## Design

### D1 — `blocked` task status (dispatch-skippable, non-terminal)

`VALID_TASK_STATUS` becomes `['pending', 'in_progress', 'done', 'blocked', 'waived']`
(`waived` arrives in D3). The dispatch axis is mechanical:

- **Dispatch selection** (`resume.mjs:151`): `pending = tasks.filter(t => t.status !== 'done' && t.status !== 'blocked' && t.status !== 'waived')`.
- **Wave recovery** (`resume.mjs:132`) and **wave count** (`wave.mjs:192`): same exclusion.
- **Block reason** lives on the task: `mark-task --status=blocked --reason="…"` sets
  `task.block_reason`. `markTask` gains an optional `reason` param that attaches
  `block_reason` (blocked) / clears it (re-activation to pending).

Status transitions (all via `mark-task`):
- `pending → blocked` (gate it), `blocked → pending` (un-gate when hardware arrives),
- `blocked → waived` (via `waive-task`, D3), `waived → pending` (undo a waive).

A `blocked` task keeps its integer `wave` (so we know *which* wave is gated and the
wave-less stuck-guard still passes for genuinely wave-less tasks). It is **non-terminal**:
`complete` does not fire while any `blocked` (non-waived) task remains.

### D2 — `awaiting_waiver` before `complete` in `decideNextAction`

When no dispatchable task remains but blockers are present, `decideNextAction` returns a new
op instead of `complete`. **The blocker check MUST precede the `complete` return**
(`resume.mjs:153`) — this ordering is the load-bearing invariant (cross-vendor finding): a run
with unfinished blocked work must never hit `complete`.

```js
// pending is already the dispatchable set (excludes done/blocked/waived)
if (pending.length === 0) {
  const blockers = tasks.filter(t => t.status === 'blocked');
  if (blockers.length > 0) {
    return { action: 'awaiting_waiver', blockers };   // halt, surface to operator
  }
  // ...existing complete logic (pre-execute diversion, execute-empty throw, complete)
}
```
`blocked` is excluded from dispatch but **still prevents run finalization** (the asymmetry the
whole feature hinges on); `waived` is excluded from dispatch AND allows finalization.

**Consumer side (the part that makes the op real — cross-vendor finding).** Returning the op is
necessary but not sufficient: `lib/continue.mjs`'s decide switch has an explicit default that
returns `{op:'ask', ask:'decide-error', error: "unknown decide action 'awaiting_waiver'"}`. The
feature dead-ends there unless the op has a matching consumer. Three coupled edits close the loop:

- **`lib/continue.mjs`** — add `case 'awaiting_waiver':` to the decide switch (alongside
  `dispatch_wave`/`complete`/etc., ~`:176-289`), returning
  `{op:'ask', ask:'awaiting_waiver', blockers: action.blockers}`. This MUST land in the same wave
  as the `resume.mjs` change, or runtime hits the decide-error default (loud fail, not a silent
  hole — but the feature can't progress).
- **`commands/masterplan.md`** — add the sequencer op row for the new `ask:'awaiting_waiver'`
  ask-kind to the §2 op table: the AUQ "N tasks blocked; waive all (Recommended) / waive selected /
  keep blocked," labelled with the blocker ids + their `block_reason`s. Resolution re-invokes the
  shell with `--choice=waive-all|--waive-id=N|keep`: `waive-all` runs `mp waive-task --all`,
  `waive-id=N` runs `mp waive-task --id=N`, `keep` holds the run as-is (no-op re-decide loops back
  to the same op). A free-text answer chats and holds (the escape hatch, nothing finalizes).
- **Test** — `test/continue.test.mjs` asserts `decideNextAction`→continue maps a blocked-only run
  to the `awaiting_waiver` ask op (not `decide-error`, not `complete`).

This op never auto-finalizes: the only paths forward are explicit operator consent (waive) or an
operator-driven re-activation (`mark-task --status=pending` when the gate clears).

### D3 — `mp waive-task` (explicit consent → terminal `waived`)

`mp waive-task --state=<path> --id=N --reason="…"`:
- Requires a non-empty `--reason` (explicit consent + auditable rationale).
- Operates **only** on a task currently `status: 'blocked'` (refuses pending/done/waived —
  waiving a runnable task is just skipping and is not this verb's job).
- Sets `status: 'waived'`, attaches `task.waive_reason`, emits a `task_waived {id, reason}` event.
  `--all` waives every currently-`blocked` task in one call (the common "the whole tail is
  HIL-gated" case), emitting one event per waived task; `--all` still requires `--reason`
  (the same rationale applies to the batch). Without `--all`, `--id=N` waives one task.
- `waived` is **terminal** (excluded from dispatch, like done) but distinct from done so the
  finish/retro step can flag it as a documented exception rather than completed work.

`waived` tasks do not block finalize; `blocked` tasks do. The difference is operator consent.

### D4 — `mp amend-tasks` (status-preserving upsert)

`mp amend-tasks --state=<path> --plan-index=<path> [--prune]`:

New pure helper `upsertTasks(state, planIndex, { prune })` in `lib/bundle.mjs`:
```js
export function upsertTasks(state, planIndex, { prune = false } = {}) {
  const list = /* from planIndex.tasks */;
  const byId = new Map(list.map(p => [String(p.id), p]));
  const seen = new Set();
  const kept = (state.tasks ?? []).map(task => {
    const p = byId.get(String(task.id));
    if (!p) return prune ? null : task;          // drop (prune) or keep verbatim
    seen.add(String(task.id));
    return { ...task, wave: p.wave ?? p.parallel_group ?? task.wave,
                      files: p.files ?? task.files ?? [] };  // STATUS + reasons PRESERVED
  }).filter(Boolean);
  const appended = list
    .filter(p => !seen.has(String(p.id)))
    .map(p => ({ id: coerceId(p.id), status: 'pending',
                 wave: p.wave ?? p.parallel_group ?? null, files: p.files ?? [] }));
  return { ...state, tasks: [...kept, ...appended] };
}
```
- Existing id present in index → keep `status`/`block_reason`/`waive_reason`, refresh `wave`/`files`.
- New id in index not in state → append `pending`.
- id in state, not in index → dropped iff `--prune`, else kept verbatim (never silently drops).
- **Duplicate-id rejection** (cross-vendor finding): a plan index with two entries mapping to
  the same `String(id)` (e.g. `1` and `"1"`, or a literal duplicate) is rejected before write
  (a silent last-write-wins would drop a task). Mirror `validatePlanIndex`'s id-uniqueness rule.
- **`--prune` safety** (cross-vendor finding): `--prune` refuses to drop a non-`pending` task
  (a task that has accumulated `done`/`blocked`/`waived`/`in_progress` state or a reason field)
  unless an additional `--prune-non-pending` is also passed — pruning load-bearing state is the
  exact hazard `seed-tasks --force` has, so it requires a second explicit flag. Default `--prune`
  only removes tasks that are still bare `pending` with no accumulated state.
- Wave-less stuck-guard (mirror of backfill-waves) fails loud on a non-integer wave before write.
- Re-renders `plan.html` inline when it exists (mirror of `amend-plan`'s render-after-mutation rule).

`amend-tasks` is the status-preserving sibling of `load-plan` (initial-only) and
`backfill-waves` (existing-only). `--prune` is opt-in because silently dropping tasks that
have accumulated state is the same hazard `seed-tasks --force` has.

### D5 — `markTask` reason attachment

`markTask(state, id, status, { reason })` in `lib/bundle.mjs`:
- `status === 'blocked'` + `reason` → attach `task.block_reason = reason`.
- `status !== 'blocked'` → clear `block_reason` (re-activation).
`mark-task` bin handler passes `--reason` through; `reason` is **required** for `blocked`,
**optional** otherwise (keeps the common done/in_progress path unchanged).

**In-flight interaction (cross-vendor finding).** `markTask` is generic, so an operator can mark
a task `blocked` that is *currently in-flight* under a live `state.active_run`. D1's recovery
filter change (`resume.mjs:132` excludes `blocked` from `incomplete`) means a lone in-flight
blocked task drives `incomplete.length === 0 → finalize_run` (`resume.mjs:143`), clearing the
active_run marker while the dispatched process may still report back later (a stale
`record-result` against a cleared run). To avoid this seam, **`mark-task --status=blocked`** (and
`waive-task`) refuses a task covered by a non-terminal `active_run` unless the operator passes
`--force`: the documented contract is that blocking an in-flight task implies the operator has
*already* stopped/reaped the run (or is accepting the stale-report risk). The bin checks
`state.active_run.task_id === String(id)` and the active_run's phase is not a finalized marker;
on `--force` it proceeds and emits a `task_blocked_under_active_run {id}` event for the audit
trail. (`mark-task --status=pending` un-gating is always allowed — it can't desync a dead run.)

`waived` is **terminal for dispatch + finalize** (a waived run closes) but **operator-reversible**
to `pending` (`mark-task --status=pending`) — "undo a waive." This is intentional (the operator
may have waived prematurely), not a contradiction: terminal means "not re-dispatched and does not
block close," not "immutable." `waive_reason` is cleared on reversal (cross-vendor finding: make
the terminal-but-reversible semantics explicit, don't leave it ambiguous).

### D6 — gate-review content acquisition (masterplan side)

**The latent bug surfaced by this run:** the spec/plan gates call `dispatch_review` with
`files`/`staged`, but bundle artifacts (`spec.md`, `plan.md`, `plan.index.json`) are untracked at
gate time → `git diff --staged` / `git diff -- <files>` return **empty** → the stateless
cross-vendor reviewer (gpt-5.5 via the gateway) sees an empty diff and cannot review anything.
The gates are structurally reviewing nothing — the same silent-hole shape as the blocked-task
problem and the planf3-ideas silent-skip.

**Fix:** the shell step that executes a `run_gate_review` op must feed `dispatch_review` the
**actual artifact bytes**, not an empty diff. Concretely: pass the gated artifacts' content as
the review `diff`/payload (a synthetic content block prefixed with the artifact path, or read the
files into the `content` param added by D7). This is a `commands/masterplan.md` sequencer edit
(the gate-execution prose), not a new lib module — the gated artifact paths already come from
`resolveGateArtifacts`, and the content is the same bytes the gate hashes. No `git add` (the
bundle's untracked artifacts should not pollute the index).

### D7 — file-content review path (agent-dispatch side)

**The deeper contract defect:** `defaultGetDiff` (`packages/core/review.mjs:52-63`) is the *only*
content path into a reviewer; a gateway-spawned reviewer (stateless LLM via LiteLLM) never sees
file content, only the `diff` string. `files` is a scope hint, not a content source. So review
over **new/untracked content** (the common case for spec/plan gates, design docs, anything not
yet committed) is impossible without the caller fabricating a synthetic diff.

**Fix (agent-dispatch repo, `/srv/dev/.agent-dispatch`):** add a content-aware review input. A new
`content` (or `readFiles`) path: when `input.content` is provided (string or `{path: text}` map)
or `input.files` is given WITHOUT a diff/staged/base, the harness reads the file bytes from
`input.repo` (falling back to cwd) and includes them in the reviewer payload as a content block —
same shape a diff fills, so the reviewer's prompt is identical whether it received a diff or
file content. Pure seam: `getDiff`/`getContent` injectable, no new network. Back-compat: existing
`diff`/`staged`/`base` calls are byte-identical (the new path only activates on the new input
shape). This is the foundation that makes D6 — and the spec/plan gates — review real bytes.

### Cross-cutting: migrate / doctor / render (cross-vendor findings)

- **migrate** (`lib/migrate.mjs`): `blocked`/`waived` pass through as non-`done` for legacy
  migration (they didn't exist pre-v8, so a legacy bundle can't carry them — *migration
  behavior* is unaffected). But the v8 comment at `migrate.mjs:176` ("cares only done-vs-not
  (lib/resume.mjs filters `status !== 'done'`)") becomes **literally stale** after D1: resume now
  filters `!== 'done' && !== 'blocked' && !== 'waived'`. The comment's stated predicate must be
  updated (or generalized to "cares only dispatchable-vs-not") so it does not mislead the next
  reader — the "stays correct" claim from the first review pass was wrong on the literal
  predicate even though the behavior holds. Also ensure no status whitelist or enum hardcodes
  the old 3-value set.
- **doctor**: add checks — every `blocked` task has a non-empty `block_reason`; every `waived`
  task has a non-empty `waive_reason`; no task carries an unknown status; `blocked`/`waived` are
  not counted as dispatchable by any count the doctor reports.
- **render** (`lib/plan-merge.mjs` render + `plan.html`): the status badges must visibly
  distinguish `blocked` (with reason) and `waived` (with waiver reason) from `pending`/`done`. If
  any render-side count uses `wave.mjs`'s pending filter, it must use the updated filter or it
  misreports blocked work as pending.

## Non-goals

- **Partial-wave blocking.** `blocked` is per-task, but this run does not add UI for "block 3
  of 8 tasks in a wave." Marking any task blocked lets dispatch skip that wave only if the
  *whole* wave is blocked; a partially-blocked wave still waits on its runnable tasks. That's
  the existing wave-barrier semantics, unchanged.
- **Automatic un-block.** No watchman/hardware-probe auto-flips blocked→pending. The operator
  re-activates explicitly (`mark-task --status=pending`). Automation is a future run.
- **Dependency-graph re-derivation.** `amend-tasks` refreshes `wave`/`files` from the index but
  does **not** re-run the planner's DAG/Kahn layer. Wave *values* come from the supplied index.
- **Changing `seed-tasks`/`load-plan` semantics.** Those verbs keep their current roles;
  `amend-tasks` is additive.

## Assumptions & Open Decisions

| # | Question | Decision | Rationale | Source |
|---|---|---|---|---|
| A1 | How to represent a gated wave for skip-without-lying? | New **`blocked`** task status (reuse the single dispatch axis masterplan already keys on) | One concept in one place; `status !== 'done'` is already the dispatch predicate everywhere | user-confirmed |
| A2 | Which primitive owns status-preserving injection? | New **`mp amend-tasks`** upsert verb | Single responsibility; keeps load-plan/backfill-waves/seed-tasks roles intact; `applyPlanIndex` is already status-preserving for existing ids | user-confirmed |
| A3 | What does finalize do when only blockers remain? | **Require explicit `mp waive-task`** — blockers block finalize; operator waives each to a terminal `waived` status | Never silently drops work; explicit consent per blocker; auditable | user-confirmed |
| A4 | Should `blocked` carry a reason? | Yes — `task.block_reason` via `mark-task --reason` (required for blocked) | Diagnose *why* a wave is gated when the operator returns; mirrors `waive_reason` | assumed |
| A5 | Is `waived` a distinct status or a flag on `blocked`? | Distinct terminal status `waived` | Finish/retro can flag exceptions as documented-but-incomplete rather than conflate with done | assumed |
| A6 | Does `amend-tasks` silently drop tasks absent from the index? | No — opt-in `--prune`; default keeps them verbatim | Silently dropping accumulated state is the `seed-tasks --force` hazard we're avoiding | assumed |
| A7 | Does `amend-tasks` re-render plan.html? | Yes, inline when it exists (mirror amend-plan) | The artifact must never go silently stale after a plan mutation | assumed |
| A8 | Wave-less stuck-guard for blocked tasks? | Unchanged — blocked tasks keep valid integer waves; the guard iterates the (now blocked-excluded) pending set | Keeps the existing loud-fail on genuinely wave-less tasks; blocked tasks need a wave to identify their gated wave | assumed |

## Success criteria

1. `VALID_TASK_STATUS` includes `blocked` and `waived`; `mark-task --status=blocked --reason=…`
   and `waive-task --id=N --reason=…` set the right task fields.
2. A bundle with a fully-blocked wave dispatches the **next** wave (`Math.min` skips it); a
   partially-blocked wave still waits on its runnable tasks (existing barrier semantics).
3. A bundle whose only non-done tasks are `blocked` does **not** finalize; the `awaiting_waiver`
   check runs **before** the `complete` return. After `waive-task` on each blocker it finalizes.
   The op is **wired end-to-end**: `lib/continue.mjs` has a `case 'awaiting_waiver':` that returns
   the `ask` op (not the `decide-error` default), and the sequencer surfaces it as an AUQ
   (waive-all / waive-selected / keep) per the §2 op table.
4. `amend-tasks` on an in-flight bundle appends new ids as `pending`, refreshes existing
   ids' `wave`/`files`, and preserves every existing `status`/`block_reason`/`waive_reason`;
   `--prune` drops only bare-pending absent ids (refuses non-pending without `--prune-non-pending`);
   duplicate ids are rejected before write.
5. Adversarial review (`state.review.adversary`) runs per-task during execution (verified armed
   at seed; does not silently skip — the planf3-ideas incident does not recur).
6. **The spec/plan gates review REAL content, not empty diffs.** The gate-review shell step feeds
   `dispatch_review` the gated artifact bytes (D6); agent-dispatch's `dispatch_review` accepts a
   content/file-read input that reaches the stateless reviewer (D7). Verified by a test that runs
   `dispatch_review` over untracked content and asserts the reviewer payload contains the bytes.
7. `npm test` green (masterplan) + agent-dispatch tests green for the content-review path; `mp doctor`
   clean (exit 0, zero FATALs; new WARNs version-scoped so legacy bundles pass byte-identically).
8. New behaviors unit-tested: `blocked` dispatch skip, `awaiting_waiver` halt, `waive-task`
   transitions (+`--all`), `upsertTasks` append/refresh/prune-safety/preserve/duplicate-reject,
   gate-review content acquisition, agent-dispatch content-review payload.
9. doctor checks `blocked` has `block_reason`, `waived` has `waive_reason`, no unknown status;
   render badges distinguish blocked/waived with reasons.
10. `mark-task --status=blocked` (and `waive-task`) on a task covered by a non-terminal
    `active_run` is refused without `--force`; `--force` proceeds and emits the
    `task_blocked_under_active_run` event. Un-gating (`mark-task --status=pending`) is always
    allowed.

## Resolved at spec-approval

**OQ1 (resolved).** `waive-task` supports `--all` to waive every currently-blocked task in one
call (with a single shared `--reason`), in addition to `--id=N` for one-call-per-id. The common
"whole tail is HIL-gated" case is one command, not N; per-id remains available for selective
waivers. (Resolved: add `--all`.)
