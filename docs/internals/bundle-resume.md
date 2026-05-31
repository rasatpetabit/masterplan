# Bundle Resume — Internals

> **Audience:** Maintainers working on the resume controller (`lib/resume.mjs`) or the shell loop
> that drives it (`commands/masterplan.md §2`).
> **Source files:** `lib/resume.mjs`, `commands/masterplan.md §2`.

---

## The Resume-Controller Pattern

The shell (L1) never decides in prose what to do next. On every execute-turn entry it:

1. Reads `state.yml` from disk.
2. Calls `mp decide` — the CLI wrapper for `decideNextAction(state, liveness)` — and receives a
   single action token back.
3. Executes that action. The decision code never runs I/O, never calls an LLM, and has no
   side-effects; the shell is the sole executor and the sole durable writer (CD-7).

`decideNextAction` is a pure function (`lib/resume.mjs`). Its only external input beyond `state` is
`liveness.alive` — a single `TaskGet` probe on the in-flight run's task ID, passed in by the shell.
No other external state enters the function.

---

## The Eight Resume Actions

| Action | When returned |
|---|---|
| `surface_gate` | A `pending_gate` entry exists in `state.yml`. |
| `wait` | An in-flight run is confirmed live (`alive === true`). |
| `finalize_run` | The active run's wave is fully `done` on disk, run is dead. |
| `recover_and_redispatch` | An execute-wave run is dead (or crashed before launch) with tasks still pending. |
| `recover_plan_run` | A planning run is dead or crashed; re-run the planner fan-out. |
| `dispatch_wave` | No active run, no gate; dispatches the lowest-numbered pending wave. |
| `resume_phase` | Bundle is in `brainstorm` or `plan` phase with no tasks seeded yet (mid-design state). |
| `complete` | All tasks are `done`; drives the finalization flow (see §2c below). |

### Gate Precedence: `surface_gate` Is First

`surface_gate` is checked before every other branch. A `pending_gate` in `state.yml` is a hard
stop — it outranks an in-flight run, a completed wave, and `complete`. This implements the
compaction-safety invariant: a native `AskUserQuestion` cannot survive context compaction; the
durable marker in state must.

### `complete` and the Finalization Flow

`complete` signals that every execute task has status `done` on disk. The finalization sequencing —
verify-before-completion, write `retro.md`, surface the durable `branch_finish` gate, archive LAST —
lives in `commands/masterplan.md §2c`. That section is the canonical reference; it is not reproduced
here.

---

## Crash-Safe Launch: The Two-Phase `active_run` Handshake

The durability hazard is not write-vs-commit; it is the window between the shell writing its launch
intent and the Workflow runtime returning run handles. `active_run` uses a two-phase marker to close
that window.

**Execute-wave markers** carry a `wave` field in both phases:

| Phase | Shape | Meaning |
|---|---|---|
| Phase 1 (pre-launch) | `{ wave, phase: 'launching' }` | Written to `state.yml` *before* the workflow is launched; no `task_id` yet. |
| Phase 2 (post-launch) | `{ wave, run_id, task_id }` | Promoted *after* the Workflow runtime returns run handles. |

**Planning-run markers** carry a `kind: 'plan'` field instead of `wave`:

| Phase | Shape |
|---|---|
| Phase 1 | `{ kind: 'plan', phase: 'launching' }` |
| Phase 2 | `{ kind: 'plan', run_id, task_id }` |

### Recovery Logic

On resume, `decideNextAction` inspects `active_run`:

- **Phase-1 marker (no `task_id`)** — the process crashed between writing the marker and receiving
  run handles. There is nothing to probe. For an execute wave → `recover_and_redispatch`; for a
  planning run → `recover_plan_run`. `staleTaskId` is `null` in both cases (nothing to reconcile).

- **Phase-2 marker, `alive === true`** → `wait` (the run is still live; do not interfere).

- **Phase-2 marker, `alive === false`** (dead run):
  - All tasks in the wave are `done` on disk → `finalize_run` (clear the marker, advance).
  - Any task still pending → `recover_and_redispatch` (reset declared scope, re-dispatch; the
    `staleTaskId` is threaded out so the shell can reconcile a possibly-surviving orphan process
    before re-launching).

Recovery for execute waves is idempotent because agents never commit — a crash leaves only
uncommitted edits in the declared files; resetting scope and re-dispatching is safe to repeat.

Recovery for planning runs is idempotent because `mp-subsystem-planner` drafters are read-only.

---

## State Field Semantics (load-bearing subset)

The full field set lives in `docs/masterplan/<slug>/state.yml`. Fields referenced by
`decideNextAction`:

| Field | Type | Notes |
|---|---|---|
| `phase` | `brainstorm \| plan \| execute` | Flat enum. `resume_phase` is returned for `brainstorm` or `plan` with `tasks:[]`; `execute` with `tasks:[]` is a hard error (unseeded run). |
| `pending_gate` | `null \| { id, opened_at }` | Non-null triggers `surface_gate` before all other branches. |
| `active_run` | `null \| <marker>` | Two-phase shape described above. |
| `tasks` | `[{ id, wave, status, files }]` | `wave` must be an integer; a non-integer pending task throws (backfill from `plan.index.json` required). Tasks are never removed, only promoted to `done`. |

**Two fail-loud invariants** (both throw rather than silently misroute):

1. A pending task with a non-integer `wave` — waves were not backfilled from `plan.index.json`
   before resume. The shell must call `mp backfill-waves` first.
2. `phase === 'execute'` with `tasks: []` — the plan was never seeded via `mp seed-tasks`. Auto-
   finalizing an unseeded execute bundle would archive work that was never done.

---

## State.yml Write Discipline (CD-7)

`lib/resume.mjs` performs zero writes. `decideNextAction` is a pure decision function; the shell
executes every write implied by an action (via `bin/masterplan.mjs` subcommands: `mp clear-active-run`,
`mp mark-task`, `mp set-status`, etc.) using atomic tmp+rename. This is the single-writer guarantee
that makes crash re-dispatch idempotent.
