# Adversarial Review Failure Policy

**Applies to:** adversary review paths that masterplan invokes through the agent-dispatch control
plane — per-task execution review (`dispatch_review` from `mp dispatch-wave` / `reviewNativeResult`
when `state.review.adversary` is enabled) and whole-branch finish review (`run_adversary_review`,
§2c). No model is named; agent-dispatch resolves the adversary lane.
**Scope:** review-lane outcomes after masterplan has handed the exact review payload to
agent-dispatch. Transport-level 429 / 5xx / TCP timeout retries remain in
`docs/conventions/api-retry-policy.md`.

---

## Ownership split

| Concern | Owner |
|---|---|
| Chunk sizes, retries, reconciliation, findings extraction, verdict semantics, harness metadata | **agent-dispatch** — see `/srv/workflows/policy/dispatch.md` and `references/review-findings.schema.json` |
| Capture full edit-locus diff, hash it, call `dispatch_review` once, project + persist, populate `blocking_reviews[]` | **masterplan** (`lib/task-review.mjs`, `lib/dispatch-wave.mjs`, `lib/wave-commit.mjs`) |
| D6 undeclared-write revert | **masterplan** — independent of review outcome |

Do **not** restate agent-dispatch engine rules here. Masterplan is a caller and durable recorder.

---

## Canonical execution-review contract (masterplan side)

Per-task execution review is **mandatory when armed** (`state.review.adversary` / review on). For
every `done` task:

1. Capture the full edit-locus working diff (tracked + untracked; never scope-filtered).
2. Bind identity as `run + task + sha256(exact payload)`.
3. Call `dispatch_review` once (or reuse a completed structured event for the same key).
4. Project agent-dispatch's structured record into the compact canonical shape:
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
reviews never satisfy re-entry; the next attempt re-invokes centralized review.

Review remains read-only: it never implements a task and never commits. Implementation stays
inline. D6 still reverts undeclared writes after review, independent of review approval.

MCP-pool and native ingestion paths share the same orchestration helper so projections and
blockers match.

---

## Finish-path review (whole-branch)

The whole-branch finish path (`run_adversary_review`, §2c) is separate from per-task execution
review. Any non-success there still maps to `--review-skipped --review-reason=<reason>`, whose
durable `adversary_review_skipped` event uses a hyphenated summary that deliberately does NOT
match the `\b(codex|adversary)\s+review\b` audit regex, so a degraded finish still trips
`adversary_review_configured_but_zero_invocations`.

---

## Adversary lane health → WARN (deterministic, via `doctor`)

The `lib/doctor/adversary-lane-health.mjs` check probes the lane on the host: `agent-dispatch` on
PATH, `agent-dispatch resolve --class adversary` exiting 0 with a route, and backend health.
Findings are **WARN-level** diagnostics for operators. They do not weaken the wave gate: when
execution review is armed and the call fails or returns incomplete coverage, masterplan still
records a canonical `error` / incomplete projection and populates `blocking_reviews[]`.

---

## Scope boundary with `api-retry-policy.md`

| Failure | Covered by |
|---|---|
| 429 rate-limit, 5xx server error, TCP timeout | `api-retry-policy.md` |
| Empty response (transport-level) | `api-retry-policy.md` |
| Execution-review RPC / process failure / empty or incomplete structured result | This doc → block via `blocking_reviews[]` |
| Adversary lane unhealthy (not on PATH / no route / backend down) | Doctor WARN + fail-closed wave gate when review is armed |
| Engine-internal chunking, retries, findings schema | agent-dispatch policy (do not duplicate) |
