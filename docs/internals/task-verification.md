# Task Verification — Internals

> **Source:** `lib/wave.mjs` (scope helpers), `lib/dispatch-wave.mjs` (fabric dispatch orchestrator),
> `commands/masterplan.md §2a` (shell-side revert + commit sequence).

## Two distinct verification concepts

### 1. Per-task verify commands (implementer-run, in-task)

Every task in `plan.index.json` carries a `verify_commands` array — shell commands the
implementer must run to prove the task. Implementation routes through a native spawn descriptor to the
`masterplan-implementation` policy class; that worker runs these commands during
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
re-dispatched by the next `recover_wave` decision, idempotently.

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
is informational and logged only; every task is implemented via a native spawn descriptor to the
`masterplan-implementation` policy class, regardless of its routing result.
`target` records which tasks a future implementer tier *could* offload; it does not cap or gate
anything.

## Centralized review stage (config-gated)

The fabric wave path (`mp dispatch-wave`) implements each task, then — when
`state.review.adversary` is enabled — reviews every `done` digest through the harness-native
adversary review seam.
Masterplan is the **caller and durable recorder only**; it does not implement review
chunking, retries, reconciliation, findings extraction, or verdict semantics.

**Implement:** a native spawn descriptor to the `masterplan-implementation` policy class receives a
prompt naming the task, its declared file scope, and its verify commands. It runs the verify
commands and returns the IMPL_DIGEST (validated at the dispatch boundary):

```json
{ "task_id": 3, "status": "done"|"failed"|"blocked",
  "files_changed": [...], "verify": [...], "summary": "..." }
```

A missing or errored digest synthesises a `failed` record — the task is never silently dropped.

**Review (config-gated):** for each `done` task, masterplan captures the full edit-locus working
diff, binds it with `payload_sha = sha256(diff)`, and either reuses a completed `run+task+sha`
event or runs the native review seam (`run_native_reviews` — adversary-class descriptors the
orchestrator executes harness-natively, ingested via `--reviews-file`). The harness review record
is projected by `lib/task-review.mjs` into the **canonical** shape:

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

Review is gated by config only — not by `target` or routing eligibility. It is on by default; a
run only skips review when `state.review.adversary` is explicitly off.

### D6 independence

Review outcome and D6 scope verification are independent:

- a `done` implementation digest may still be durably recorded even when review blocks the wave;
- D6 still reverts undeclared writes **after** review, regardless of review approval;
- review never substitutes for scope enforcement, and scope never invents review findings.

## Amended scope and controller re-authorization

`lib/scope-authorization.mjs` separates detection from authorization. The current
`state.tasks[].files` of every active-wave task (done tasks included) identifies
work to **preserve**, never work to authorize implicitly. Both sets use
`canonicalizeScopePaths` and `pathWithinDeclaredScope`, including absolute main
paths mapped into run loci and declared directory containment.

Before any recording mutation, `preflightAmendedScope` / `recordWaveResult`
capture the union of frozen and current declared loci and read the watch delta.
Changed files outside frozen scope that match current task declarations or a
matching amendment audit yield `scope-amended-after-launch`. The CLI checks
before native review ingestion can persist receipts or mutate a dispatch
record; the transaction checks again for direct/reconcile callers. Watch
snapshots use `git --no-optional-locks status`, so even the index stat cache is
unchanged on refusal. Unrelated files retain normal checkout/clean behaviour.
Recovery's `preflightRecovery` checks dirty paths, watch violations and the full
frozen-base→recovered-HEAD delta read-only, reporting the same condition as a
preservation violation.

`set-active-run` and `continue` freeze `scope_event_cursor` (the number of
existing event records) at launch; `promote-run` preserves it. Takeover does not
move this boundary. `reauthorize-scope --state=PATH --wave=N --reason=TEXT`
requires matching `task_files` evidence in `plan_amended` / `tasks_amended`
events after that boundary for every task contributing new scope. Matching is
by task id, wave and canonical file list, not summary interpretation. No active
run, no frozen snapshot, no additions, empty reason or insufficient evidence
refuses. Scope only grows: old entries are retained verbatim, new declarations
are canonicalized. All other marker fields, dispatch records/history and the
watch baseline remain untouched.

`amend-plan` synchronizes active-wave existing tasks' indexed files; `amend-tasks`
performs the full status-preserving upsert. Both attest structured `task_files`
and include any `scope_reauthorization` (`old_scope`, `new_scope`,
`added_entries`, `reason`, amendment identity) in their **own** amendment event.
Explicit repair emits `scope_reauthorized`, referencing amendment event lines,
types, timestamps and task ids. These controller writers hold Guard D across
mutation (explicit `owner_lock=off` remains supported for the repair/upsert).
The audit event precedes atomic widened-state replacement: a failed state write
can leave both declarations and scope stale. For preservation only, recording
checks structured amendment files for this wave after the launch cursor. A
marker without a cursor conservatively preserves additions from same-wave
widening audits whose old scope is covered by the frozen scope. Neither supplies
authority when declarations are absent from state. Rerun the approved amend verb
if the state write was interrupted; use it also when explicit re-authorization
has no launch cursor or only prose amendment evidence.
No new `/masterplan` reserved entry verb is introduced.

## Summary of data flow for one wave

```
L1: prepareWave()                 → lean routed task payloads
L1: git capture before            → baseline path set
L1: mp dispatch-wave (fabric)     ──────────────────────────────┐
    implement (native spawn descriptor)                        │
    review (run_native_reviews / --reviews-file ingest)         │
      → project + persist canonical review                      │
    recordWaveResult (mark digests → D6 → commit)               │
L1: act on blocking_reviews[] / failed[] / scope  ◄─────────────┘
L1: re-decide
```
