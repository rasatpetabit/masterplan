# Wave Dispatch — Internals

> **Audience:** Maintainers working on dispatch decisions (`lib/dispatch/` — routing, backend
> selection, host detection, op construction), wave preparation (`lib/wave.mjs`), or the
> fabric dispatch orchestrator (`lib/dispatch-wave.mjs`).
> **Source files:** `lib/dispatch/`, `lib/wave.mjs`, `lib/dispatch-wave.mjs`.

---

## One Wave Per Launch

`dispatchWaveViaFabric` in `lib/dispatch-wave.mjs` runs exactly one wave per launch and returns a **native spawn plan** (invoked as `mp dispatch-wave --state=<path>`) — per-task governed descriptors the orchestrating harness executes with its parallel subagent API. L1 (the shell) owns the wave
loop: `decide → dispatch_fabric → mp dispatch-wave → record → decide → next wave`. Limiting one
wave per launch keeps `active_run` unambiguous: a crash can only strand a single wave, and
recovery resets only that wave's declared scope before re-dispatching.

### Pipeline, Not a Barrier

Within a wave, tasks run via native spawn descriptors with `fail_mode:'isolated'` — each
descriptor is independent. The orchestrator dispatches all tasks in a bounded concurrent pool,
then collects results. This is not a two-stage barrier where all implements complete before any
reviews start; review (when enabled) runs after implement + local verify per task, still
failure-isolated. The only wave barrier is the orchestrator's completion of the native spawn pool,
which L1 awaits before acting on digests / blocking reviews and re-deciding.

---

## Per-Task Routing: `routeTask`

L1 pre-resolves routing before launch. `lib/wave.mjs:prepareWave` merges each pending task's
state fields (`id`, `wave`, `status`, `files`) with its `plan.index.json` fields
(`description`, `verify_commands`, `codex`, `sensitive`, `conversational`), runs
`routeTask(merged, config, env)`, and emits a lean routed payload that is consumed by
`dispatchWaveViaFabric` / descriptor construction. Native spawn descriptors carry only the task
class and payload — routing is resolved from the checked-in policy `policy/workflow-map.json`.

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

1. **Same seams, no forked routing** — the wave is re-derived through `prepareWave` (native
   spawn payloads carry only the task `class`; the routing policy `policy/workflow-map.json`
   resolves it to agent/lane/model).
   **Routing-input parity:** the prepare inputs (routing mode, `codexHostSuppressed` — thread
   `--codex-suppressed` on a suppressed host — `linkedWorktree`) mirror `continue`'s own call
   and are frozen into the record as `routing_inputs` at attempt 1; retries reuse the frozen
   inputs (plus the persisted lean `payload` for audit), so descriptors can never drift from
   what the launch marker promised.
2. **One native spawn plan per wave** — `dispatchWaveViaFabric` builds one governed descriptor
   per routed task via `buildDescriptors`/`buildWorkItem`
   (`fail_mode:'isolated'`), never N ad-hoc per-task spawns; the orchestrating harness executes
the returned plan with its parallel subagent API.
   **Multi-repo locus (umbrella workspaces):** plan files may be declared as umbrella-relative
   paths that live in a *sibling* git checkout of MAIN (e.g. `yanos-os/kas/...` under
   `/srv/dev/yanos-project/`, where `yanos-os/` is gitignored by the umbrella). Umbrella
   worktrees do **not** materialize those siblings, so pinning every descriptor to
   `repo = worktree` fails skynet_edit with "file not found". Before fanout,
   `buildFabricLocus` (`lib/dispatch/multi-repo.mjs`) maps each task's files to a single edit
   locus: sibling prefix → `MAIN/<sib>/.worktrees/<slug>` (create-or-reuse via the same
   `planWorktreeCreate` path as the umbrella), strips the sibling prefix from `files`,
   rewrites matching verify path tokens, auto-opts `create_files: true` when any target is
   missing on disk, and stamps `branch: masterplan/<slug>`. Mixed-repo tasks throw loud —
   one task = one locus (gateway dispatch is single-repo per descriptor).
3. **Wave-dispatch idempotency** — a stable key `(run_id, wave, 'dispatch_fabric')` over a
   per-wave record file inside the bundle (`wave-<N>.dispatch.json`), persisted **before** the
   launch with atomic create-or-return-existing (O_EXCL) semantics. A retry after an
   accepted-but-unobserved dispatch finds `status:'pending'` and returns the record instead of
   double-dispatching (`--takeover` supersedes a confirmed-dead attempt); a `'dispatched'`
   record re-drives record-result from the stored digests without re-launching; a
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
6. **Same record transaction** — per-descriptor results map through the digest projection
   (`lib/dispatch/dispatch-digest.mjs` — worker digests carry the optional `dispatch` provenance
   field; `worker` on success) and feed `recordWaveResult`, so degradations surface as
   `dispatch_degraded` events and D6/commit behavior is identical to the other vehicles.
   The post-transaction `'recorded'` finalize of the record file deliberately lands after
   the MAIN state commit (HEAD briefly retains `'dispatched'` until the next bundle commit
   sweeps it) — safe because the idempotency gate re-drives, never re-dispatches; see the
   commit-window note in `lib/dispatch-wave.mjs`.

`test/op-table-parity.test.mjs` enforces producer/consumer parity: every op
`lib/dispatch/ops.mjs` emits must have a §2 op-table row (and every row a producer) — the
dangling-op class that let `dispatch_fabric` ship consumer-less cannot recur.

---

## Module Structure (post-9.8.0 deepening)

The wave-dispatch hot spot was deepened across five architecture rounds. The current
module layout:

| Module | Role | Key exports |
|---|---|---|
| `lib/dispatch-wave.mjs` | Orchestrator pipeline | `gateAndValidate`, `resolveWaveContext`, `buildDescriptors`, `acquireAndWatch`, `buildNativePlan`, `finalizeRecord` |
| `lib/wave.mjs` | Launch context + scope | `prepareWave`, `buildWaveLaunchContext`, `verifyScope`, `declaredScope` |
| `lib/watch-integrity.mjs` | Watch substrate + git helpers | `runGit`, `gitLines`, `captureWatchBaseline`, `verifyWatchListDelta`, `precheckWatchList` |
| `lib/wave-commit.mjs` | Wave-completion transaction | `recordWaveResult`, `captureWtFiles`, `captureWorkspaceRoot` |
| `lib/task-review.mjs` | Review projection | `projectReviewRecord`, `taskReviewBlocksWave`, `reviewCompletedTasks` |

`dispatchWaveViaFabric` is a 73-line pipeline that calls the stage helpers in order.
Each stage returns an outcome object; the orchestrator short-circuits on early exits.

`buildWaveLaunchContext` is the single implementation of plan-index reading,
config/env construction, `prepareWave` invocation, and MAIN resolution — consumed by
both PREPARE (`continue.mjs`) and EXECUTE (`dispatch-wave.mjs`) with routing inputs
injected per-phase (retry-frozen on the EXECUTE side).

Review is a thin caller of the harness-native adversary review (adversary class — breaker role,
frontier lane; adversarial panel for cross-vendor coverage); masterplan no longer maintains a
parallel implementation.

---

## `target` Is Informational — Implementation Routes Through the Routing Policy

Every task is implemented via a native spawn descriptor whose task `class` routes to the
`masterplan-implementation` policy class, regardless of its routed `target`. There is no separate implementer agent in the roster
(`mp-implementer` was deleted). The `target` field is logged and recorded in digests so a future
path could offload eligible tasks; it never gates which implementation lane runs.

---

## Harness-Native Per-Task Review (caller + recorder only)

Review is gated by **config only** (`state.review.adversary` / `review: 'on'|'off'`, default `'off'`),
not by `target` or eligibility. Judgment-heavy tasks (which route `inline`) need a second opinion as
much as annotation-approved tasks; gating review by eligibility would skip exactly the riskiest work.

Masterplan does **not** own the review engine. When review is on, for every `done` task it:

1. Captures the **full edit-locus working diff** (tracked + untracked; never scope-filtered).
2. Hashes the exact payload (`payload_sha = sha256(diff bytes)`).
3. Reuses a completed `run+task+sha` review event when one exists; otherwise runs the **native
   review seam** — `mp record-result` phase A returns `{op:'run_native_reviews', pending_reviews:[...]}`
   (adversary-class descriptors, breaker role on the frontier lane), the orchestrator runs them
   with its harness-native subagent API, and phase B re-calls `mp record-result` with
   `--reviews-file=<task_id → review record JSON>`.
4. Projects the harness review record into a compact canonical shape
   (`approve | rework | reject | error` + findings + harness metadata) and persists it before
   `recordWaveResult`.

All chunking, retries, reconciliation, findings extraction, and verdict semantics live in the
harness-native review engine (`/srv/workflows/policy/dispatch.md`; the routing policy
`policy/workflow-map.json`). Masterplan
only orchestrates lifecycle, payload binding, invocation, and durable recording
(`lib/task-review.mjs`).

**Native path.** The wave's review requirement rides on the descriptors (`review: {adversary: true}`)
and `review_context` is frozen into the wave-dispatch record before
spawn. When host results arrive, `reviewNativeResult` runs the **same** `reviewCompletedTasks`
helper (same projection + event persistence) before
`recordWaveResult`. Every path produces identical review projections and `blocking_reviews[]`
behavior.

---

## Digests Only — L1 Is the Sole Writer (CD-7)

`dispatchWaveViaFabric` calls `finalizeRecord` to persist the wave result. The wave dispatch path
is idempotent on the record `(run_id, wave, 'dispatch_fabric')`. Implementation workers edit only
declared scope; durable run-bundle state is written through the wave-commit / mark-task path, not
ad-hoc agent writes to `state.yml`.

The orchestrator returns a digests payload shaped like:

```
{ wave, baseline, tasks: [{ task_id, target, digest, review }], summary }
```

L1 / `recordWaveResult` consumes this: done tasks are marked, D6 scope checks run (comparing the
git-touched set before launch — `baseline` — against the set after), the shell commits, then
`decide` is re-called. This is the single-writer guarantee that makes crash re-dispatch idempotent.

---

## Scope Verification (D6)

The post-barrier scope check lives in `lib/wave.mjs:verifyScope`. The watch baseline is captured by
`captureWatchBaseline` in `lib/watch-integrity.mjs` before launch, and verified by
`verifyWatchListDelta` after completion. `verifyScope` computes `(after − before) ⊆ declared`.
Out-of-scope paths are reverted by the shell before the wave commit.

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
