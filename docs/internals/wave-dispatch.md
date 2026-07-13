# Wave Dispatch — Internals

> **Audience:** Maintainers working on dispatch decisions (`lib/dispatch/` — routing, backend
> selection, host detection, op construction), wave preparation (`lib/wave.mjs`), or the
> execution engine (`workflows/execute.workflow.js`).
> **Source files:** `lib/dispatch/`, `lib/wave.mjs`, `workflows/execute.workflow.js`.

---

## One Wave Per Launch

`workflows/execute.workflow.js` runs exactly one wave per Workflow-tool launch. L1 (the shell) owns
the wave loop: `decide → dispatch_wave → launch → record digests → commit → decide → next wave`.
Limiting one wave per launch keeps `active_run` unambiguous: a crash can only strand a single wave,
and recovery resets only that wave's declared scope before re-dispatching.

### Pipeline, Not a Barrier

Within a wave, tasks run via `pipeline(tasks, implement, review)`. This is NOT a two-stage barrier
where all implements complete before any reviews start. `pipeline` starts task A's review the instant
task A's implement finishes — while task B may still be implementing. The only wave barrier is the
workflow's completion notification, which L1 awaits before committing and re-deciding.

The workflow resolves only after every task has cleared both stages.

---

## Per-Task Routing: `routeTask`

L1 pre-resolves routing before launch. `lib/wave.mjs:prepareWave` merges each pending task's
state fields (`id`, `wave`, `status`, `files`) with its `plan.index.json` fields
(`description`, `verify_commands`, `codex`, `sensitive`, `conversational`), runs
`routeTask(merged, config, env)`, and emits a lean routed payload that is passed to the workflow
via `args`. The workflow has no module or filesystem access; it cannot import `lib/dispatch/`
directly.

All dispatch *decision* logic — `routeTask`, the qctl backend gate, host detection, and the
wave-dispatch op shapes — lives in the pure `lib/dispatch/` package (import via
`lib/dispatch/index.mjs`). `lib/wave.mjs` and `lib/continue.mjs` are consumers, not owners.

`routeTask` returns `{ target: 'codex'|'inline'|'ask', eligible, reason }`.

### Routing Precedence (highest to lowest)

1. **Host-suppression** — `env.codexHostSuppressed === true` → force `inline` (`reason: 'host-suppressed'`).
2. **Routing off** — `config.routing === 'off'` → force `inline` (`reason: 'routing-off'`).
3. **Linked worktree** — `env.linkedWorktree === true` → force `inline` (`reason: 'linked-worktree'`).
4. **Task annotation** — `task.codex === 'no'` → ineligible; `task.codex === 'ok'` → eligible. Both
   override the heuristic. The annotation is a string enum (`'ok'`/`'no'`/`null`), never a boolean.
5. **Heuristic** — evaluated when annotation is `null`.
6. **Routing mode** — `config.routing === 'manual'` → return `ask` (regardless of eligibility);
   `config.routing === 'auto'` (default) → eligible tasks go to `codex`, ineligible to `inline`.

### Heuristic Reject-to-Inline Conditions

All five conditions must pass for a task to be heuristically eligible:

| Condition | Rejects if... |
|---|---|
| File count | `task.files.length > 3` |
| Judgment language | Description matches `/\b(consider\|decide\|choose between\|design\|explore)\b/` |
| Verify commands | `task.verify_commands` is empty |
| Sensitive flag/description | `task.sensitive === true` or description matches the sensitive regex |
| Conversational flag | `task.conversational === true` |

---

## The Fabric Path (`dispatch_fabric` → `mp dispatch-wave`)

When the per-run strangler flag `state.dispatch.fabric` is `true` (default for **new** seeds via `mp seed`; opt out with `--fabric=off`), `mp continue` emits a single
`dispatch_fabric` op instead of the launch_workflow/dispatch_foreground fork, and the L1 op table's
consumer for that op is exactly `mp dispatch-wave --state=<path>` (`lib/dispatch-wave.mjs`) —
dispatch AND record complete inside the command:

1. **Same seams, no forked routing** — the wave is re-derived through `prepareWave` (fabric
   payloads carry only the dispatch `class`; the broker's resolve/guard is the routing brain).
   **Routing-input parity:** the prepare inputs (routing mode, `codexHostSuppressed` — thread
   `--codex-suppressed` on a suppressed host — `linkedWorktree`) mirror `continue`'s own call
   and are frozen into the record as `routing_inputs` at attempt 1; retries reuse the frozen
   inputs (plus the persisted lean `payload` for audit), so descriptors can never drift from
   what the launch marker promised.
2. **One broker process per wave** — a single `createBrokerClient` (`agent-dispatch serve-mcp`)
   call to the `dispatch_fanout` MCP tool with one `buildWorkItem` descriptor per routed task
   (`fail_mode:'isolated'`), never N per-task spawns.
3. **Wave-dispatch idempotency** — a stable key `(run_id, wave, 'dispatch_fabric')` over a
   per-wave record file inside the bundle (`wave-<N>.dispatch.json`), persisted **before** the
   broker call with atomic create-or-return-existing (O_EXCL) semantics. A retry after an
   accepted-but-unobserved dispatch finds `status:'pending'` and returns the record instead of
   double-dispatching (`--takeover` supersedes a confirmed-dead attempt); a `'dispatched'`
   record re-drives record-result from the stored digests without touching the broker; a
   `'recorded'` record with pending tasks remaining permits attempt N+1 (an observed retry).
   Attempt-N+1/takeover transitions are additionally serialized by an O_EXCL **attempt marker**
   (`wave-<N>.dispatch.attempt-<K>`): exactly one concurrent retry claims the attempt, the
   loser re-reads the record and returns without dispatching.
4. **Guard D before any dispatching transition** — run ownership is acquired and
   heartbeat-confirmed (same `owner-fs` helpers as `continue`/`record-result`; `owner_lock=off`
   honored) before the fresh create, an attempt-N+1 retry, a takeover, or a re-drive. A
   blocked/lost lock throws — nothing is written or dispatched under a foreign owner.
5. **Coord paired** — `openWaveCoord` attaches per-descriptor coord context and the job is
   closed in a `finally`, even on dispatch failure (on the fabric path `continue` does NOT
   open coord — `dispatch-wave` owns the whole lifecycle, fixing the leaked-open-jobs bug).
6. **Same record transaction** — per-descriptor results map through the adapter's
   `translateBrokerResult` (digests carry the adsp-v1.1 `dispatch` provenance field;
   `worker` on success) and feed `recordWaveResult`, so degradations surface as
   `dispatch_degraded` events and D6/commit behavior is identical to the other vehicles.
   The post-transaction `'recorded'` finalize of the record file deliberately lands after
   the MAIN state commit (HEAD briefly retains `'dispatched'` until the next bundle commit
   sweeps it) — safe because the idempotency gate re-drives, never re-dispatches; see the
   commit-window note in `lib/dispatch-wave.mjs`.

`test/op-table-parity.test.mjs` enforces producer/consumer parity: every op
`lib/dispatch/ops.mjs` emits must have a §2 op-table row (and every row a producer) — the
dangling-op class that let `dispatch_fabric` ship consumer-less cannot recur.

---

## `target` Is Informational — Implementation Is Always Inline

Every task is implemented by `mp-implementer` (sonnet) regardless of its routed `target`. There is
no codex-implementer in v8 by design. The `target` field is logged and recorded in digests so a
future implementer could offload eligible tasks; it never gates which agent runs the implementation.

Review is gated by **config only** (`review: 'on'|'off'`, default `'off'`), not by `target` or
eligibility. Judgment-heavy tasks (which route `inline`) need a second opinion as much as
annotation-approved tasks; gating review by eligibility would skip exactly the riskiest work.

When review is on, `mp-adversarial-reviewer` runs per-task — not per-wave — immediately after
that task's implement finishes, failure-isolated from other tasks.

---

## Digests Only — L1 Is the Sole Writer (CD-7)

The workflow never writes `state.yml`, never commits, and never writes any file except through the
implementer agents' edits to declared scope. It returns a digests payload:

```
{ wave, baseline, tasks: [{ task_id, target, digest, review }], summary }
```

L1 consumes this: `mp mark-task` records each `done` task, `mp verify-scope` runs the D6 scope
check (comparing the git-touched set before launch — `baseline` — against the set after), the shell
commits, then `decide` is re-called. This is the single-writer guarantee that makes crash
re-dispatch idempotent.

---

## Scope Verification (D6)

The post-barrier scope check lives in `lib/wave.mjs:verifyScope`. The workflow echoes back the
`baseline` (git-touched paths captured by L1 before launch); L1 captures a fresh `after` set, and
`verifyScope` computes `(after − before) ⊆ declared`. Out-of-scope paths are reverted by the shell
before the wave commit.

---

## API Error Handling

Transient API errors (429 rate-limit, 5xx, transport timeout) are distinct from task blockers. The
retry policy, backoff schedule, user-facing notices, and scope (Codex vs inline dispatch) are
documented in `docs/conventions/api-retry-policy.md`.

The key invariant: API retries happen *before* the blocker re-engagement ladder (CD-4). Only after
the retries are exhausted does the task promote to a blocker and enter CD-4.

---

## Blocker Re-Engagement (CD-4)

A task that returns `status: 'failed'` or `status: 'blocked'` is surfaced to the user. CD-4 governs
the re-engagement ladder: the shell works two rungs (narrowed scope / simpler approach) before
escalating to an `AskUserQuestion`. API-transient errors are retried (with exponential backoff)
before a task ever enters CD-4; only after retries are exhausted does a dispatch failure promote to a
blocker. Full CD-4 rule body: `docs/conventions/cd-rules.md §CD-4`.
