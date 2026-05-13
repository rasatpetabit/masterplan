# TaskCreate Projection Contract (Claude-only)

## Scope

Projection mirrors the plan's task list into the Claude TaskList ledger.
Codex sessions DO NOT project — Codex uses its own task tracking.

The projection is a one-way **derived projection**. `state.yml` is canonical
per **CD-7**; the projection is rebuilt from `state.yml` + `plan.md` on every
session start. If TaskList ever disagrees with `state.yml`, `state.yml` wins
and the TaskList is corrected.

## Threshold

`tasks.projection_threshold` (default: `15`) — gates BOTH projection AND
per-state-write priming.

```
if len(plan.tasks) > tasks.projection_threshold:
    skip projection           # no TaskList mirroring of plan tasks
    skip per-state-write priming   # no TaskUpdate on every state.yml write
    emit ONE TaskCreate at run start:
        TaskCreate("masterplan: <slug>")

if len(plan.tasks) <= tasks.projection_threshold:
    # current v4.x behavior:
    project all plan.tasks -> TaskList entries
    per-state-write priming TaskUpdate on every state.yml mutation
```

## Projection schema

For each task in `plan.md`, create exactly one TaskCreate task.
Mapping is one-to-one.

| TaskCreate field | Source |
|---|---|
| `subject` | First line of the plan-task heading, truncated to 80 chars. |
| `description` | Plan-task body, truncated to 500 chars. Detail stays in `plan.md`. |
| `prompt` | Empty (orchestrator drives execution; tasks are not user-runnable from the harness). |
| `metadata` | `{"masterplan": {"slug": "<run-slug>", "task_idx": <0-based>, "wave": <wave-id or null>, "parallel_group": "<group-name or null>", "plan_path": "docs/masterplan/<slug>/plan.md", "state_path": "docs/masterplan/<slug>/state.yml"}}` |
| Initial status | `pending` (TaskCreate default). If empirical observation shows the harness reminder fires while only `pending` tasks exist, promote initial status to `in_progress` for the `current_task` only and leave the rest `pending`. |

DAG edges use `TaskUpdate { addBlockedBy }` in a second pass after batch
creation. Tasks in the same wave / parallel_group have no blocking edges
between them — they are siblings.

## Rehydration

Rehydration runs **once per session** at the first of these events:

1. Step M resolves to an in-progress bundle.
2. Step C entry for an in-progress bundle.
3. Step I completes import and the imported bundle is in-progress.

Rehydration procedure (Claude Code only — gated on `codex_host_suppressed == false`):

1. Read canonical `state.yml` + `plan.md`.
2. Call `TaskList`.
3. Branch on TaskList contents:
   - **Empty** → batch-create one task per plan task. Then apply `blockedBy` edges in pass 2.
   - **Non-empty, same `metadata.masterplan.slug`** → drift, see *Drift recovery* below.
   - **Non-empty, unrelated** → leave foreign tasks untouched. Append the projection alongside; tasks remain identifiable by `metadata.masterplan.*`.
4. Set status from `state.yml`:
   - Tasks listed in `tasks_completed` → `TaskUpdate(status: "completed")`.
   - `current_task` → `TaskUpdate(status: "in_progress")`.
   - Others → leave at initial status.
5. Append `taskcreate_projection_rehydrated` event with `{count_created, count_completed_at_rehydrate, count_in_progress}`.

Rehydration is O(plan-task-count); a typical 50-task plan costs ~50 TaskCreate + ~50 TaskUpdate.

## Per-state-write priming (when in projection mode)

*Extracted from monolith L1393–1402.*

**Per-state-write priming (v4.1.1, Claude Code only).** In addition to the
per-transition mirror, every Step C `state.yml` write — including writes that
do NOT change `current_task` or wave state (e.g. `last_activity` bumps,
`pending_gate` writes, `background` marker writes, `next_action` updates) —
MUST be followed by:

```
if codex_host_suppressed == false AND state.current_task != "":
    TaskUpdate(task_id=<state.current_task's TaskList id>, status="in_progress")
```

This is an idempotent re-stamp; the task is already `in_progress` if the
session is healthy. The purpose is to refresh the harness's recent-`Task*`-usage
signal so the per-turn `<system-reminder>` is suppressed during idle-turn gaps
between true transitions. The touch runs AFTER the `state.yml` write and AFTER
the corresponding `events.jsonl` append. Failures append `taskcreate_mirror_failed`
with `{call: "TaskUpdate-priming", task_idx, error}` and do NOT roll back the
state write. Skip silently when `codex_host_suppressed == true` OR
`current_task == ""` (between-task and pre-wave gaps).

The touch is **NOT** applied outside Step C (brainstorm, plan, halt-gate,
doctor, import, audit, etc.) — those phases legitimately benefit from the
harness reminder.

## Lifecycle mirror hooks

Every site where the orchestrator writes `state.yml` for a task transition must
mirror to TaskList **in this order** (Claude Code only):

1. Compute mutation.
2. Write `state.yml`; append `events.jsonl`.
3. Call `TaskUpdate` to mirror.

If step 3 fails, do **NOT** roll back `state.yml`. Append `taskcreate_mirror_failed`
and continue. The next rehydration reconciles.

Transition table:

| state.yml change | TaskList mirror |
|---|---|
| `current_task` advances N → N+1 | `TaskUpdate` N → `completed`; `TaskUpdate` N+1 → `in_progress`. |
| Wave dispatch begins (W₁..Wₖ) | Batched `TaskUpdate` W₁..Wₖ → `in_progress`. |
| Wave member completes (digest received) | `TaskUpdate` that member → `completed`. |
| Status → `pending_retro` (FM-A path) | `TaskUpdate` current → `completed`; no new `in_progress`. |
| Status → `complete` (retro written) | All projection tasks already `completed`; no-op. |
| Status → `blocked` | Leave current at `in_progress`; emit blocker via CD-4 `AskUserQuestion` path. |

## Drift recovery

`state.yml` is canonical. Drift is detected at rehydration and at every
Step C re-entry (all gated on `codex_host_suppressed == false`):

| Observation | Action | Event |
|---|---|---|
| TaskList shows `completed`; `state.yml.tasks_completed` doesn't list it | Revert TaskList to match `state.yml` | `taskcreate_drift_corrected` `{direction: "tasklist_wrong"}` |
| `state.yml.tasks_completed` lists task; TaskList shows `pending` | Fast-forward TaskList | `taskcreate_drift_corrected` `{direction: "tasklist_wrong"}` |
| `state.yml.current_task` ≠ TaskList `in_progress` | Sync TaskList to `state.yml` | `taskcreate_drift_corrected` `{direction: "tasklist_wrong"}` |
| `plan.md` grew; TaskList missing tasks | Create new tasks | (rehydration §3 covers) |
| TaskList has a `masterplan.*`-metadata task whose `task_idx` is out of range | `TaskUpdate` → `cancelled` | `taskcreate_orphan_cancelled` `{task_idx}` |

There is **NO inverse-direction reconciliation**. TaskList never feeds back
into `state.yml`.

## Codex no-op gate

The projection is **Claude Code only**. On Codex hosts, every `TaskCreate` /
`TaskUpdate` / `TaskList` call is **skipped** and no `taskcreate_*` projection
events are emitted. The gate is the same `codex_host_suppressed` boolean set
in Step 0:

```
if codex_host_suppressed == false:
    # projection call here (TaskCreate, TaskUpdate, TaskList)
    pass
```

## Events emitted by this layer

- `taskcreate_projection_rehydrated` — once per session at rehydration entry.
  Payload: `{count_created, count_completed_at_rehydrate, count_in_progress}`.
- `taskcreate_mirror_failed` — when a `TaskCreate` / `TaskUpdate` call errors
  during a transition mirror or rehydration. Payload:
  `{call: "TaskCreate|TaskUpdate", task_idx: <int or null>, error: "<message>"}`.
  `state.yml` is NOT rolled back; reconciliation happens at next rehydration.
- `taskcreate_drift_corrected` — when rehydration or re-entry detects TaskList
  disagreeing with `state.yml`. Payload:
  `{direction: "tasklist_wrong", task_idx: <int>, from: "<status>", to: "<status>"}`.
- `taskcreate_orphan_cancelled` — when a TaskList task with `metadata.masterplan.*`
  has a `task_idx` outside the current `plan.md` range. Payload: `{task_idx}`.

## Configuration

`~/.masterplan.yaml`:

```yaml
tasks:
  projection_threshold: 15
```

Per-run override: `--tasks.projection_threshold=N` (rare).

## Doctor check #33

Warns when ledger state is inconsistent with the current threshold/plan size.
Examples:

- Projection-mode ledger entries (multiple `masterplan.*` TaskList tasks) persist
  after a plan grew past `projection_threshold`.
- A plan with `len(plan.tasks) <= projection_threshold` has only the single
  sentinel `TaskCreate("masterplan: <slug>")` instead of full per-task projection.

Doctor check #33 is implemented in T16 (`parts/doctor.md`).
