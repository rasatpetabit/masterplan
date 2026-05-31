# Task Verification — Internals

> **Source:** `lib/wave.mjs` (scope helpers), `workflows/execute.workflow.js` (L2 engine),
> `commands/masterplan.md §2a` (shell-side revert + commit sequence).

## Two distinct verification concepts

### 1. Per-task verify commands (implementer-run, in-task)

Every task in `plan.index.json` carries a `verify_commands` array — shell commands the
implementer must run to prove the task. `mp-implementer` (the L2 agent that implements each
task) runs these commands during the implementation and reports results in its digest:

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

Before L1 launches `execute.workflow.js`, it calls `prepareWave` to build the routed task
payload the workflow receives via `args`:

```js
prepareWave(state, planIndex, wave, config, env)
// -> { wave, tasks: [{ id, description, files, verify_commands, target, eligible, reason }] }
```

For each `pending` wave-N task it merges `state.tasks[i]` (id, wave, status, files) with the
corresponding `plan.index.json` entry (description, verify_commands, codex, sensitive,
conversational) and calls `routeTask` (`lib/routing.mjs`). The result is a lean payload — no
spec excerpts, no raw file contents — because it transits the orchestrator context.

`routeTask` returns `{ target: 'codex'|'inline'|'ask', eligible, reason }`. In v8 `target`
is informational and logged only; every task is implemented inline by `mp-implementer`
regardless of its routing result (there is no Codex implementer). `target` records which
tasks a future implementer tier *could* offload; it does not cap or gate anything.

The Workflow tool JSON-stringifies object args at the L1↔L2 seam. Both `execute.workflow.js`
and `plan.workflow.js` normalise with `JSON.parse` at the top of the script to handle both
the tool path (string) and the in-script test path (object).

## Review stage (`execute.workflow.js`)

`execute.workflow.js` runs each wave via:

```
pipeline(tasks, implement, review)
```

`pipeline` is not a barrier between stages: task A's `review` starts the moment A's
`implement` completes, while task B may still be implementing. The workflow resolves only
when all tasks clear both stages — that resolution is the wave barrier L1 awaits.

**Implement:** `mp-implementer` (sonnet) receives a prompt naming the task, its declared file
scope, and its verify commands. It runs the verify commands and returns the IMPL_DIGEST
(validated at the tool boundary):

```json
{ "task_id": 3, "status": "done"|"failed"|"blocked",
  "files_changed": [...], "verify": [...], "summary": "..." }
```

A missing or errored digest synthesises a `failed` record — the task is never silently dropped.

**Review (config-gated):** if the run bundle's `codex.review` is `"on"`, `mp-codex-reviewer`
(sonnet) runs a synchronous adversarial second-opinion pass on each `done` task immediately
after its implementer finishes. Review is gated by config only — not by `target` or routing
eligibility. Judgment-heavy, inline-routed tasks need the second opinion most; gating by
eligibility would skip them.

The reviewer returns prose closing with `verdict: blocking|advisory|clean|inconclusive`.
`extractVerdict` parses that line and defaults to `"inconclusive"` on parse failure (a
malformed review never reads as clean). A `blocking` verdict is collected and surfaced to the
user via `AskUserQuestion` even when the task's `status` is `done`.

Review is off by default; a zero-review run executes `implement` only and proceeds directly
to D6 scope verify.

## Summary of data flow for one wave

```
L1: prepareWave()            → lean routed task payloads
L1: git capture before       → baseline path set
L1: launch execute.workflow  ──────────────────────────────────┐
L2: parallel pipeline()                                         │
    implement (mp-implementer) ─► review (mp-codex-reviewer)   │
    (per-task: implement done → review starts immediately)      │
L2: return { wave, baseline, tasks:[digests], summary }  ◄──────┘
L1: mark done tasks (mp mark-task)
L1: git capture after        → after path set
L1: mp verify-scope          → { ok, touched, outOfScope }
L1: if !ok → git revert outOfScope → leave pending for recovery
L1: commit state.yml + in-scope edits
L1: re-decide
```
