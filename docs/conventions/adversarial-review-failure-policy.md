# Adversarial Review Failure Policy

**Applies to:** adversary review paths masterplan owns — per-task execution review (the native
review seam from `mp dispatch-wave` / `reviewNativeResult` when `state.review.adversary` is
enabled) and whole-branch finish review (`run_adversary_review`, §2c). Review EXECUTION is the
harness-native adversary class (breaker role, frontier lane; adversarial panel for cross-vendor
coverage), resolved from the checked-in routing policy `policy/workflow-map.json`. No model is
named in masterplan; the routing policy resolves the adversary lane.
**Scope:** review-lane outcomes after masterplan has handed the exact review payload to the
harness-native reviewer. Transport-level 429 / 5xx / TCP timeout retries remain in
`docs/conventions/api-retry-policy.md`.

---

## Ownership split

| Concern | Owner |
|---|---|
| Chunk sizes, retries, reconciliation, findings extraction, verdict semantics, harness metadata | harness-native adversary class/panel — see `/srv/workflows/policy/dispatch.md` and the routing policy `policy/workflow-map.json` |
| Capture full edit-locus diff, hash it, run the native review, project + persist, populate `blocking_reviews[]`, re-entry guard | **masterplan** (`lib/task-review.mjs`, `lib/dispatch-wave.mjs`, `lib/wave-commit.mjs`) |
| D6 undeclared-write revert | **masterplan** — independent of review outcome |

Do **not** restate the harness's review-engine rules here. Masterplan is the caller and durable
recorder; the harness executes the review.

---

## Canonical execution-review contract (masterplan side)

Per-task execution review is **mandatory when armed** (`state.review.adversary` / review on). For
every `done` task:

1. Capture the full edit-locus working diff (tracked + untracked; never scope-filtered).
2. Bind identity as `run + task + sha256(exact payload)`.
3. Run the harness-native adversary review once — the `run_native_reviews` seam (or reuse a
   completed structured event for the same key).
4. Project the harness review record into the compact canonical shape:
   `verdict ∈ { approve, rework, reject, error }` plus findings and harness metadata.
5. Persist before `recordWaveResult`.

Wave-completion mapping (`recordWaveResult`):

- `approve` with healthy, complete harness coverage → no `blocking_reviews[]` entry.
- `rework` / `reject` → task + structured findings in `blocking_reviews[]`.
- `error` → task + failure reason in `blocking_reviews[]`.
- Incomplete harness coverage (degraded, timed out, stalled, deadline exceeded, unreviewed
  regions, extraction degradation) → block even if a contradictory `approve` appears.

**A mandatory execution-review failure blocks the wave gate.** The orchestrator already routes a
non-empty `blocking_reviews[]` through `AskUserQuestion` and must not silently continue. Failed
reviews never satisfy re-entry; the next attempt re-invokes the native review.

Review remains read-only: it never implements a task and never commits. Implementation stays
inline. D6 still reverts undeclared writes after review, independent of review approval.

Every ingestion path shares the same orchestration helper so projections and
blockers match.

---

## Native two-phase review seam

The `mp record-result` seam is two-phase, harness-native:

- **Phase A** — `mp record-result --result-file=...` without reviews runs `reviewNativeResult`,
  which freezes each done task's `review_input` (edit-locus diff + sha), and returns
  `{op:'run_native_reviews', pending_reviews:[...]}` — one adversary-class descriptor per
  unreviewed task (breaker role, frontier lane; adversarial panel for cross-vendor coverage). At
  this point **nothing is recorded yet**.
- **Phase B** — the orchestrator runs those descriptors with its harness-native subagent API and
  re-calls `mp record-result --result-file=... --reviews-file=<task_id → review record JSON>`.
  The provided review records ingest through the same centralized projection
  (`reviewCompletedTasks`), producing identical `verdict`/`blocking_reviews[]` behavior.

Re-entry: a `run + task + sha` review event reuses the completed record. **Skipped events never
satisfy re-entry.** An owed-but-absent provided review fails closed as verdict `error` — never a
silent approve.

---

## Finish-path review (whole-branch)

The whole-branch finish path (`run_adversary_review`, §2c) is separate from per-task execution
review. It runs the harness-native adversary class/panel over the branch diff. Any non-success
there — a non-zero review exit, the review unavailable/empty, a failed harness spawn — maps to
`--review-skipped --review-reason=<reason>`, whose durable `adversary_review_skipped` event uses
a hyphenated summary that deliberately does NOT match the `\b(codex|adversary)\s+review\b` audit
regex, so a degraded finish still trips `adversary_review_configured_but_zero_invocations`.

---

## Adversary lane health → WARN (deterministic, via `doctor`)

The `lib/doctor/routing-policy-health.mjs` check probes the routing policy: the repo copy is
readable, every required review class resolves (adversary → breaker on the frontier lane, the
adversarial panel cross-vendor), and host-artifact drift from the live generated
`~/.pi/workflows/workflow-map.json` is a WARN. Findings are **WARN-level** diagnostics for
operators. They do not weaken the wave gate: when execution review is armed and the review fails
or returns incomplete coverage, masterplan still records a canonical `error` / incomplete
projection and populates `blocking_reviews[]`.

---

## Scope boundary with `api-retry-policy.md`

| Failure | Covered by |
|---|---|
| 429 rate-limit, 5xx server error, TCP timeout | `api-retry-policy.md` |
| Empty response (transport-level) | `api-retry-policy.md` |
| Execution-review RPC / process failure / empty or incomplete structured result | This doc → block via `blocking_reviews[]` |
| Adversary lane unhealthy (policy unresolvable / no route / host-artifact drift) | Doctor WARN + fail-closed wave gate when review is armed |
| Engine-internal chunking, retries, findings schema | harness-native policy (do not duplicate) |
