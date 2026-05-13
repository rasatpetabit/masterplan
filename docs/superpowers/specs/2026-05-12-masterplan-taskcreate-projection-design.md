# Masterplan TaskCreate projection — design spec

**Date:** 2026-05-12
**Sub-project:** P4 of the v5.x decomposition (see brainstorming session
2026-05-12)
**Status:** Draft for user review

## Purpose

Project the masterplan run state into Claude Code's native `TaskCreate`
ledger so that (a) the harness UI surfaces wave / parallel-group
progress instead of being blind to it, and (b) the harness stops
emitting "you have N pending tasks, consider TaskUpdate" reminders that
currently steal a few hundred tokens per turn from the orchestrator's
context.

**This is a derived projection, not a re-platforming.**
`docs/masterplan/<slug>/state.yml` remains the canonical ledger per CD-7.
TaskCreate output is a one-way reflection rebuilt on every session
start; if the projection and state.yml disagree, state.yml wins and the
TaskList is regenerated. The orchestrator never reads TaskList back as
a source of truth.

## Out of scope

- Replacing state.yml's ledger role. CD-7 is unchanged.
- Cross-session task persistence inside the harness. TaskCreate is
  session-scoped by design ("structured task list for your current
  coding session") — the projection is rebuilt every session.
- Wave dispatch logic itself. Wave members continue returning digests;
  the orchestrator still writes state.yml. The projection just mirrors
  what state.yml records.
- Codex parity. Codex has no TaskCreate equivalent surfaced through the
  current tool contract; the projection is a no-op there (see §5).

## 1 — Projection schema

Each plan task in `plan.md` maps to exactly one TaskCreate task in the
session's TaskList. Mapping granularity is **one task per plan task**
(granularity B from brainstorming).

**TaskCreate field convention:**

| TaskCreate field | Source / format |
|---|---|
| `subject` | First sentence of the plan task's title or first line, truncated to ~80 chars. |
| `description` | Plan task body (the bullet list / paragraphs under the heading), truncated to ~500 chars. Long-form detail stays in `plan.md`; the description is a pointer, not a copy. |
| `prompt` | Empty / no-op. The orchestrator drives execution; tasks are not user-runnable from the harness. |
| `metadata` | JSON object with provenance: `{"masterplan": {"slug": "<run-slug>", "task_idx": <0-based>, "wave": <wave-id or null>, "parallel_group": "<group-name or null>", "plan_path": "docs/masterplan/<slug>/plan.md", "state_path": "docs/masterplan/<slug>/state.yml"}}` |
| Initial status | `pending` (TaskCreate's default). |

**Why metadata as provenance:** when a future session rehydrates,
metadata is the join key between the harness TaskList and `state.yml`.
`slug + task_idx` uniquely identifies a plan task; `wave` and
`parallel_group` let the harness UI cluster sibling tasks visually.

**Dependency edges:** TaskCreate schema requires flat siblings; DAG
edges go through `TaskUpdate { addBlocks, addBlockedBy }`. After
batch-creating all tasks pending, the orchestrator issues a second pass
that adds `blockedBy` edges for sequential dependencies derived from
`plan.md` wave structure. Tasks in the same wave / parallel_group have
no blocking edges between them — they're siblings.

## 2 — Rehydration on session start

The projection is **rebuilt on every `/masterplan` invocation** that
resolves to an in-progress run bundle (Step B resume, Step C execute,
Step I import after migration). Rebuild procedure, run once per
session:

1. Orchestrator reads canonical `state.yml` + `plan.md`.
2. Calls `TaskList` to enumerate any existing harness tasks. Two
   sub-cases:
   - **Empty TaskList:** fresh session. Batch-create one task per plan
     task with the schema in §1. Then apply blocking edges in pass 2.
   - **Non-empty TaskList with matching `metadata.masterplan.slug`:**
     leftover projection from the same session that didn't get cleared
     (rare). Treat as drift — see §4.
   - **Non-empty TaskList with different slug or no masterplan
     metadata:** unrelated user tasks. Do not touch them. Append the
     projection alongside; the projection's tasks are identifiable by
     `metadata.masterplan.*` for future cleanup.
3. Set each projected task's status from state.yml:
   - state.yml `tasks_completed: [...]` → TaskUpdate to `completed`
   - state.yml `current_task` → TaskUpdate to `in_progress`
   - everything else → leave `pending`
4. Append `taskcreate_projection_rehydrated` event to `events.jsonl`
   with `{count_created, count_completed_at_rehydrate, count_in_progress}`.

**Cost ceiling:** rehydration is O(plan-task-count). For a typical
50-task plan, that's ~50 TaskCreate + ~50 TaskUpdate calls in two
batched passes. Acceptable for once-per-session.

## 3 — Lifecycle hooks (orchestrator → TaskList)

The orchestrator drives transitions in state.yml and **mirrors each
transition to TaskList in the same step**, in this order:

1. Compute the state.yml mutation.
2. Write state.yml + append `events.jsonl`.
3. Call `TaskUpdate` to mirror the same status change on the projected
   task(s).

If step 3 fails (harness error, tool budget hit), do NOT roll back
state.yml. The projection is best-effort; state.yml is canonical.
Append `taskcreate_mirror_failed` to `events.jsonl` with the error;
next session's rehydration (§2) will reconcile.

**Transitions to mirror:**

| State.yml change | TaskList mirror |
|---|---|
| `current_task` advances from task N to task N+1 | TaskUpdate N → `completed`; TaskUpdate N+1 → `in_progress` |
| Wave dispatch starts (parallel tasks W₁..Wₖ) | TaskUpdate W₁..Wₖ → `in_progress` in one batch |
| Wave member completes (digest received) | TaskUpdate that member's task → `completed` |
| Status flips to `pending_retro` (FM-A path) | TaskUpdate current → `completed`; no new in_progress |
| Status flips to `complete` (retro written) | All tasks already `completed`; no-op |
| Status flips to `blocked` | TaskUpdate current → leave `in_progress`; emit user-visible blocker via AskUserQuestion (existing CD-4 path). TaskList status doesn't expand to cover "blocked"; the in_progress marker is sufficient. |

**What about new tasks discovered mid-flight?** If `plan.md` grows
(rare — plans are append-only after Step P), the next rehydration on
the next session picks them up. Within a session, the orchestrator can
batch-create the new tasks immediately after appending them to
`plan.md`.

## 4 — Drift recovery

State.yml is canonical. Drift is detected at rehydration (§2) and at
every Step C re-entry. Recovery rules:

- **TaskList has a `completed` task that state.yml's
  `tasks_completed` doesn't list:** TaskList is wrong (probably a stale
  mirror from a prior crashed session). Revert that task's TaskList
  status to match state.yml. Log `taskcreate_drift_corrected` with
  `{direction: "tasklist_wrong", task_idx}`.
- **State.yml has a `tasks_completed` entry that TaskList shows as
  `pending`:** TaskList is wrong (mirror failure path). Fast-forward
  TaskList. Log same event with `{direction: "tasklist_wrong"}`.
- **State.yml `current_task` and TaskList `in_progress` disagree:**
  TaskList is wrong. Sync to state.yml.
- **TaskList missing a task that exists in plan.md:** create it
  (rehydration §2 step 2 covers this; this rule covers mid-session
  drift if plan.md grew).
- **TaskList has a `masterplan.*`-metadata task whose `task_idx` is
  out of range for the current plan.md:** plan was edited externally
  to shrink. Mark the orphan task `cancelled` via TaskUpdate. Log
  `taskcreate_orphan_cancelled`.

The orchestrator NEVER trusts TaskList over state.yml. There is no
inverse-direction reconciliation.

## 5 — Codex no-op stub

TaskCreate is a Claude Code-native tool with no current Codex
equivalent exposed through the cross-host tool map. Behavior on Codex:

- `codex_host_suppressed == true` (set in Step 0) implies the
  projection is a no-op for the invocation.
- Wherever the orchestrator would call `TaskCreate` / `TaskUpdate` /
  `TaskList`, gate on `codex_host_suppressed == false`. If suppressed,
  skip the call and skip the `taskcreate_projection_*` event emission.
- State.yml writes continue exactly as today. No information is lost on
  Codex; only the harness-UI surface and the reminder-suppression
  benefit are skipped.
- If Codex eventually exposes a structured-task tool with a compatible
  shape, the projection layer can target it by adding an adapter; the
  rest of this spec doesn't change.

This means the per-turn reminder-noise saving (the headline benefit) is
Claude Code-only. That's an acceptable degradation per the
brainstorming session's "Accept Codex degradation" decision.

## Verification

- **§1:** After implementation, `TaskList` output in a fresh session
  after `/masterplan execute <slug>` shows N tasks with
  `metadata.masterplan.slug == <slug>` and `task_idx` 0..N-1.
- **§2:** Closing the session and re-running `/masterplan next` in a
  new session produces the same TaskList shape with statuses derived
  from state.yml.
- **§3:** Mid-wave: state.yml shows current_task advanced and
  TaskList shows the corresponding `in_progress → completed → next
  in_progress` transitions in `events.jsonl`-timestamp order.
- **§4:** Deliberately mutate TaskList out-of-band (TaskUpdate a
  completed task back to pending), re-enter Step C, confirm
  reconciliation event fires and TaskList ends matching state.yml.
- **§5:** Same `/masterplan execute <slug>` flow under Codex
  (`codex_host_suppressed == true`) produces no TaskCreate calls, no
  `taskcreate_projection_*` events, and identical state.yml outcomes
  to the Claude Code run.

## Migration story

No schema bump. No state.yml shape change. No backward-compat
concerns: the projection layer is additive and skipped when the
harness doesn't support it. Existing in-progress bundles get a
TaskList projection the next time they're resumed; no retroactive
backfill is needed.

## Open questions

- Whether `TaskUpdate` cost (one call per transition) is small enough
  at wave-dispatch fan-out to not trip the orchestrator's tool budget.
  Worst case is a 10-member wave: 10 TaskUpdate calls in one batch.
  Cost should be checked against typical session budgets in the
  implementation plan.
- Whether the harness reminder-suppression actually fires when tasks
  exist in `pending` state vs. requires `in_progress` to silence. If
  the reminder is keyed off "no tasks at all" rather than "no
  in_progress tasks", the projection might paradoxically increase
  reminders during long pending stretches. Worth a one-day smoke test
  before committing to the implementation plan.
