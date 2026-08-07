# Task Verification — Internals

> **Source:** `lib/wave.mjs` (scope helpers), `lib/dispatch-wave.mjs` (fabric dispatch orchestrator),
> `commands/masterplan.md §2a` (shell-side revert + commit sequence).

## Two distinct verification concepts

### 1. Per-task verify commands (implementer-run, in-task)

Every task in `plan.index.json` carries a `verify_commands` array — shell commands the
implementer must run to prove the task. Implementation routes through `dispatch_task` to the
`masterplan-implementation` policy class via the broker; that worker runs these commands during
implementation and reports results in its digest:

```json
{
  "task_id": 3,
  "status": "done",
  "files_changed": ["src/auth/tokens.ts"],
  "verify": [
    { "command": "npx tsc --noEmit", "passed": true, "output": "..." }
  ],
  "summary": "..."
}
```

The implementer cites real output; an empty `verify_commands` array means the task cannot be
verified and the implementer reports that fact. A task with no verify commands is routed
inline by the heuristic — it is never silently marked as Codex-eligible.

### 2. D6 scope verification (wave-level, L1-run)

After the wave barrier resolves, L1 runs `mp verify-scope` to assert that the wave's combined
edits stayed within the union of all wave-N tasks' declared file scopes. This is a
**structural** check entirely separate from task correctness — it catches agents writing
outside their declared files, regardless of whether the writes are correct.

## D6 scope verification in detail

### Declared scope (`declaredScope`, `lib/wave.mjs`)

```js
declaredScope(state, wave)  // -> string[]
```

Returns the union of every wave-N task's `files` array — done tasks included. At the
post-barrier moment nothing has been committed yet, so a task that finished earlier in the
same wave still has uncommitted edits in its declared files; those edits are allowed.

### Scope check (`verifyScope`, `lib/wave.mjs`)

```js
verifyScope(declared, before, after)  // -> { ok, touched, outOfScope }
```

- `before`: git-touched path set captured by L1 **before** launching the wave (includes
  pre-existing uncommitted user files — these are baseline-subtracted, not flagged).
- `after`: git-touched path set captured by L1 **after** the wave barrier.
- `touched = after − before`: paths the wave introduced.
- `outOfScope = touched − declared`: paths touched but not in any wave-N task's declared files.
- `ok`: `true` when `outOfScope` is empty.

Git runs in the shell (`bin/masterplan.mjs` is filesystem-only and does not call git). L1
captures both sets and passes them as JSON arrays via `mp verify-scope --state=<p> --wave=N
--before='<JSON>' --after='<JSON>'`.

### Revert and surface (L1 post-barrier sequence, `commands/masterplan.md §2a`)

On `ok: false` L1 reverts the offenders:

```
git checkout -- <outOfScope paths>
git clean -fd -- <outOfScope paths>
```

The `-fd` flag handles out-of-scope new directories. In-scope edits (the correctly-scoped
portion of the wave) are preserved. The scope-reverted tasks are left `pending` and
re-dispatched by the next `recover_and_redispatch` decision, idempotently.

The full L1 post-barrier sequence:

1. **Record digests.** `mp mark-task --status=done` for each `digest.status === 'done'` task.
   Failed/blocked tasks are left `pending` and surfaced.
2. **D6 verify-scope.** Capture `after`, run `mp verify-scope`, revert any `outOfScope` paths.
3. **Commit once.** Commit `state.yml` and all in-scope file edits together (state leads git;
   a crash before the commit re-derives from the already-marked state on resume).
4. **Re-decide.** Re-enter the decide loop; pending tasks drive recovery.

## Wave preparation (`prepareWave`, `lib/wave.mjs`)

Before dispatch, `buildWaveLaunchContext` in `lib/wave.mjs` constructs the launch context (plan
index, config, MAIN, prepared wave). That path calls `prepareWave` to build the routed task
payload the fabric orchestrator consumes:

```js
prepareWave(state, planIndex, wave, config, env)
// -> { wave, tasks: [{ id, description, files, verify_commands, target, eligible, reason }] }
```

For each `pending` wave-N task it merges `state.tasks[i]` (id, wave, status, files) with the
corresponding `plan.index.json` entry (description, verify_commands, codex, sensitive,
conversational) and calls `routeTask` (`lib/dispatch/routing.mjs`). The result is a lean payload — no
spec excerpts, no raw file contents — because it transits the orchestrator context.

`routeTask` returns `{ target: 'codex'|'inline'|'ask', eligible, reason }`. In v8 `target`
is informational and logged only; every task is implemented via `dispatch_task` to the
`masterplan-implementation` policy class via the broker, regardless of its routing result.
`target` records which tasks a future implementer tier *could* offload; it does not cap or gate
anything.

## Centralized review stage (config-gated)

The fabric wave path (`mp dispatch-wave`) implements each task, then — when
`state.review.adversary` is enabled — reviews every `done` digest through agent-dispatch.
Masterplan is the **caller and durable recorder only**; it does not implement review
chunking, retries, reconciliation, findings extraction, or verdict semantics.

**Implement:** broker `dispatch_task` to the `masterplan-implementation` policy class receives a
prompt naming the task, its declared file scope, and its verify commands. It runs the verify
commands and returns the IMPL_DIGEST (validated at the dispatch boundary):

```json
{ "task_id": 3, "status": "done"|"failed"|"blocked",
  "files_changed": [...], "verify": [...], "summary": "..." }
```

A missing or errored digest synthesises a `failed` record — the task is never silently dropped.

**Review (config-gated):** for each `done` task, masterplan captures the full edit-locus working
diff, binds it with `payload_sha = sha256(diff)`, and either reuses a completed `run+task+sha`
event or calls `dispatch_review` once (`class: adversary`). Agent-dispatch returns a structured
record; `lib/task-review.mjs` projects it into the **canonical** shape:

```json
{
  "verdict": "approve | rework | reject | error",
  "findings": [ { "file", "line", "summary", "severity" } ],
  "blocking_findings": [ { "summary", "proof?" } ],
  "summary": "...",
  "harness": {
    "degraded": false, "timed_out": false, "stalled": false,
    "deadline_exceeded": false, "regions_unreviewed": 0,
    "extraction_degraded": false
  }
}
```

`recordWaveResult` consumes that projection only (never prose). Wave-gate mapping:

| Projection | `blocking_reviews[]` |
|---|---|
| `approve` with healthy harness | no entry |
| `rework` / `reject` | task + structured findings |
| `error` | task + failure reason |
| incomplete harness coverage (degraded, timed out, stalled, deadline exceeded, unreviewed regions, extraction degraded) | treated as blocking even if a contradictory `approve` appears |

A non-empty `blocking_reviews[]` is the same-turn fail-closed wave gate: the orchestrator surfaces
it via `AskUserQuestion` and does not silently continue. A mandatory review failure never
satisfies re-entry.

Legacy events without `data.review` still re-drive conservatively (pre-centralization verdict
prose is mapped only at the reader seam). New events are never interpreted from prose.

Review is gated by config only — not by `target` or routing eligibility. It is off by default; a
zero-review run proceeds from implement straight to D6 scope verify.

### D6 independence

Review outcome and D6 scope verification are independent:

- a `done` implementation digest may still be durably recorded even when review blocks the wave;
- D6 still reverts undeclared writes **after** review, regardless of review approval;
- review never substitutes for scope enforcement, and scope never invents review findings.

## Summary of data flow for one wave

```
L1: prepareWave()                 → lean routed task payloads
L1: git capture before            → baseline path set
L1: mp dispatch-wave (fabric)     ──────────────────────────────┐
    implement (dispatch_task → masterplan-implementation)       │
    review (dispatch_review via shared broker / native ingest)  │
      → project + persist canonical review                      │
    recordWaveResult (mark digests → D6 → commit)               │
L1: act on blocking_reviews[] / failed[] / scope  ◄─────────────┘
L1: re-decide
```
