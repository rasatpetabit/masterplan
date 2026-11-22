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
Before that payload is returned, `checkWaveDisjoint` refuses the wave when two tasks' resolved
declarations overlap as paths: a directory declaration (ending in `/` or `\`, or a bare `.`) covers
that directory and everything under it, `\` is a separator, and spellings that normalize to the
same path overlap. The current directory covers relative paths that do not climb out of it;
absolute and relative declarations do not cover each other. The conflict lists the declarations
as written.

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
   Absolute files in repositories beside MAIN are **external loci**: their namespace is the
   absolute main-checkout root, their run worktree is `<repo>/.worktrees/<slug>` on
   `masterplan/<slug>`, and capture/scope/commit/reset round-trip through that namespace.
   Inputs inside that run worktree resolve to the same namespace; other linked worktrees
   are refused. Recovery skips missing run worktrees instead of resetting main checkouts.
   Review freezes each task's own edit-locus HEAD (`task.base_sha ?? review_context.base_sha`
   for old records). Finish-time integration of external loci is pending brief B.
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
| `lib/dispatch-wave.mjs` | Orchestrator pipeline | `gateAndValidate`, `resolveWaveContext`, `buildDescriptors`, `acquireAndWatch`, `buildNativePlan` |
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
`masterplan-implementation` policy class, regardless of its routed `target`. The `target` field is logged and recorded in digests so a future
path could offload eligible tasks; it never gates which implementation lane runs.

---

## Harness-Native Per-Task Review (caller + recorder only)

Review is seeded **on** at `mp seed` (`state.review.adversary`, legacy `state.codex.review`
fallback). Before the first `mp dispatch-wave`, the orchestrator sizes each task from the
consequences and restoration path already stated in the plan/task, following
`/srv/workflows/policy/review.md` § "How much", then records its choice through
`mp dispatch-wave --state=<path> --reviews-file=<task-sizing.json>`:

```json
{
  "1": { "stakes": "routine", "reason": "Task 1 fixes a sample typo only; git revert restores it; no runtime/data/security effect." },
  "2": { "stakes": "consequential", "reason": "Task 2 changes service execution; revert the commit to restore it." },
  "3": { "stakes": "critical", "reason": "Task 3 rewrites customer data; recovery requires the pre-migration backup." }
}
```

The keys are this wave's task ids; values contain only the native C2 `stakes` vocabulary
(`routine | consequential | critical`) and a nonempty `reason` citing the task's consequences
and restoration path. This is orchestrator judgment, not a prose classifier, numeric score,
file-count heuristic or implementation-class inference. Changes to what runs, deletion/rewriting
of data, or security/credentials retain at least `consequential` (the native frontier-strength
default); use `critical` when a panel is warranted under the policy. `routine` is a quick
independent check, **not** a review bypass. Pass these stakes/constraints unchanged to the
harness, and check its served strength under the policy before accepting its receipt.

Sizing is frozen in the existing `review_context.episodes[task_id]` before launch. Omitted
choices preserve the run-wide defaults (unspecified stakes → `consequential`); run-wide
`routine` without a task rationale retains today's conservative `consequential` behavior.
The existing escalation/independence constraints remain floors. Retries and in-flight episodes
retain their frozen choices, not new file or config values. Explicit sizing arms review even
when the legacy bundle toggle is off; an omitted/empty map keeps that toggle's existing behavior.
The finish-time whole-branch review is unchanged. No plan schema or state-task field is added.

A task belongs to the newest dispatch attempt that included it: current record first, then
`history` newest-first, using `tasks[].task_id` (or `payload[].id` only when `tasks` is absent),
not episode presence. Recording and completion share this resolver and refuse a missing,
held, retired or invalid restarted episode in that owner; they never fall back past it.
Submitted/deferred tasks still require current-attempt evidence. Only state-done tasks owned
by an earlier `recorded` attempt whose `record_outcome.recorded` includes them and whose
durable, eligible, nonblocking task-review event matches the frozen base and episode are
exempt from the new recording transaction, provided their declared files match the owning
attempt's stored `record_outcome.commits.code_by_repo` baseline (absolute repository keys)
at every locus (a missing legacy baseline is admitted only in the owning review repository
when exactly one ancestor of HEAD is a direct child of the owning frozen base and its
object-only rebuild, tracked diff then sorted per-addition diffs, hashes to that task's durable
base-and-episode-bound review artifact; otherwise it refuses). A concrete path, including a
child of a directory declaration, is covered only by a current task undergoing artifact
authorization that declares it and whose frozen review repository is that same locus.
Covered paths must be unchanged from the recorded baseline to **each** covering review's
frozen base; only subsequent changes belong to those artifacts. Uncovered paths must match
the baseline through HEAD, index and working tree, except for unchanged dirt captured outside
the retry tasks at the new attempt's launch. The retry records those paths and fingerprints so
both ordinary `continue` and direct `dispatch-wave` leave them out of staging and cleanup;
changes to their staged bytes still count as drift. A dirty path shared with a completed task
at retry launch is refused rather than attributed to the retry. Retry staging intersects the
original (or controller-amended) wave allow-set with the completed tasks of the new attempt,
using their launched declarations and any subsequent audited task-file amendments. New
uncommitted in-scope changes outside all wave-task declarations still refuse recording with a
fresh-episode-review requirement. Scope-only changes committed before the current frozen base
remain part of that trusted boundary, not exempt-task bytes. Old receipts never authorize new
episodes. Normal recording stores the accepted code commit for every done-task declaration's
repository locus, including clean loci (HEAD captured only after authorization and successful
staging/commits); a crash re-drive revalidates its own transaction and never repairs historical
outcomes from today's HEAD. Committed recovery remains pinned and fail-closed, without this
clean-locus baseline backfill.

`--reviews-file` is command-local: at **dispatch-wave** it carries sizing intent, while at
**record-result** it still carries reviewer receipts keyed by task id. Keep those files separate.

Masterplan does **not** own the review engine. When review is on, for every `done` task it:

1. Captures the **full edit-locus working diff** (tracked vs the frozen task base, plus untracked;
   never scope-filtered). A descendant HEAD (including a bundle-only fast-forward) is reviewed
   against the same frozen base. An alternate history with a different tree is refused before
   requesting a review, naming both commits and how to preserve the work and recover.
2. Hashes the exact payload (`sha256(diff bytes)`). Both phases and recording authorization use
   the same capture; authorization rechecks the live bytes, not a prior snapshot.
3. The **native review seam** returns `{op:'run_native_reviews', pending_reviews:[...]}` in
   `mp record-result` phase A. Use each descriptor's `repo`, `base` and `diff_sha` to bind the
   artifact sent to the native reviewer; never substitute a diff against moving `HEAD`.
   Phase B re-calls `mp record-result` with `--reviews-file=<task_id → review record JSON>`.
   Carry the `diff_sha` of the artifact actually reviewed into each record. Hosts that omit it
   remain compatible with the first hash issued for that task in the attempt; a later Phase A
   cannot silently rebind their receipts to new bytes. An eligible durable review can be reused
   for the same task, episode and artifact.
4. Projects the harness review record into a compact canonical shape
   (`approve | rework | reject | error` + findings + harness metadata). `recordWaveResult`
   authorizes the entire batch and appends ordinary review evidence before marking tasks done,
   but only after the owner/epoch/scope and evidence checks pass.
5. Records a successful digest as `done` only when the authoritative review does not
   block. A blocking review settles the dispatch attempt, not the task. The active
   marker retains the task for rework; `continue` redispatches it without resetting its
   files or treating its retained edits as pre-existing dirt. The code commit excludes
   those paths, while disjoint approved siblings keep their commits and review evidence.

All chunking, retries, reconciliation, findings extraction, and verdict semantics live in the
harness-native review engine (`/srv/workflows/policy/dispatch.md`; the routing policy
`policy/workflow-map.json`). Masterplan
only orchestrates lifecycle, payload binding, invocation, and durable recording
(`lib/task-review.mjs`).

**Committed-recovery mode** (`lib/recovery-controller.mjs`, `lib/recovery-preflight.mjs`). A wave
whose work was committed to a recovered HEAD (clean tree, frozen `review_context.base_sha`) is
reviewed via an explicit selector (`record-result --recovery-repo --recovery-head`). The controller
validates the selector against the frozen context (single edit locus, exact HEAD, base ancestry,
clean tree, nonempty delta), captures the deterministic two-endpoint base→HEAD diff (format
`mp-recovery-diff-v1`, external diff/textconv disabled, HEAD+cleanliness read before and after),
and binds every Phase B receipt to the full recomputed identity. Review events are DEFERRED until
`recordWaveResult` appends them after the owner/epoch/scope guards pass; legacy SHA-only events and
caller-supplied `item.review` never satisfy recovery coverage. Recording runs the
scope/watch/baseline checks read-only and NEVER resets/cleans/reverts/commits the edit locus.
A blocking review leaves the task pending and keeps the frozen review base: ordinary
redispatch would rebase the review onto unapproved code. The explicit recovery path still
requires a bound receipt and the original preservation checks; in particular, a MAIN HEAD
change (including a recorder state commit) can prevent a follow-up from passing the watch check.

**Native path.** The wave's review requirement rides on the descriptors (`review: {adversary: true}`)
and `review_context` is frozen into the wave-dispatch record before
spawn. When host results arrive, `reviewNativeResult` uses `reviewCompletedTasks` to project the
batch without appending events; the CLI passes those in-process events to `recordWaveResult`.
Neither a refusal nor a caller-supplied `deferred_review_events` field can append to the log.

---

## Digests Only — L1 Is the Sole Writer (CD-7)

`dispatchWaveViaFabric` persists the wave-dispatch record via `writeWaveDispatchRecord`
(created in `acquireAndWatch` before launch; finalized to `'recorded'` after the
`recordWaveResult` transaction completes, with the `'dispatched'` state re-driven by
`redriveRecordTransaction` on recovery — see the module header status lifecycle). The wave dispatch path
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
