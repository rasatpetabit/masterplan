# Adversarial Review Failure Policy

**Applies to:** the optional adversary **review** path — per-task (`agents/mp-adversarial-reviewer.md`,
dispatched by `workflows/execute.workflow.js` when the run bundle's `state.review.adversary` is enabled)
and whole-branch at finish (`run_adversary_review`, §2c). Both route the review through the
agent-dispatch control plane's adversary lane (`agent-dispatch review --class adversary`) — NO model is
named; agent-dispatch resolves a cross-vendor reviewer.
**Scope:** review-lane failures where the transport succeeds but the reviewer doesn't usefully execute —
the slice NOT covered by `docs/conventions/api-retry-policy.md` (transport-level 429 / 5xx / TCP timeout).

---

## The review is read-only and advisory

The review never implements a task and never commits; implementation is **always inline** (there is no
review-implementer). A review that can't run is simply **`inconclusive`** — it never wedges a run and
never invents findings. Because the review is a synchronous `agent-dispatch review` CLI call (not a
persistent daemon or a detached background launch), there is no process-model failure class to handle:
no control-socket collision, no orphaned background job, no sandbox-commit failure. A wedge surfaces as
a non-zero exit or empty output, handled below.

---

## Live failure handling

### 1. Review unavailable / empty / non-zero → `inconclusive` (never hang, never fabricate)

The review agent runs the adversary lane as a **blocking, foreground** call. On any of: `agent-dispatch`
missing from PATH, empty output, or a non-zero exit, it returns exactly one line:

    NOTE — adversary review inconclusive (<agent-dispatch unavailable | no output | non-zero exit>). verdict: inconclusive

`inconclusive` means **"no blocking findings, proceed with a logged caveat" — NOT a clean pass.** The run
never blocks waiting on a wedged reviewer, and the agent never invents findings to fill the gap. Review is
**failure-isolated per task** (`workflows/execute.workflow.js`): one wedged reviewer degrades one task's
review, never the whole wave's. Review is also config-gated **OFF by default** at the per-task workflow
level, so on the common path this surface is inert.

**Empty-diff / degraded-lane contract (2026-07-16 audit):**
- An empty scoped diff ("No changes were provided to review") is a FAIL → `verdict: inconclusive`
  with reason `empty-diff` — never `approve`.
- When `harness.degraded:true` or the reviewer count is 1 (not a panel), the verdict is
  `inconclusive`/`advisory`, never `clean`/`approve`.
- Findings must land in the structured `findings[]` array. Free-text-only findings with an empty
  structured array are a degraded/error result, not an approve. The harness worst-wins aggregation
  MUST treat empty structured-findings + non-empty free text as `error`.
- A review lane with ≥2 of 3 attempts erroring is a FAIL — do not accept the minority passing run.
- For diffs >500 lines, chunk before the call or set Bash `timeout ≥ 1800000ms` (the review
  harness's internal deadline is 30 min per region; a 10-min Bash timeout structurally causes
  false-fails).
- ALWAYS emit the closing `verdict: inconclusive` (or `advisory`/`blocking`/`clean`) line — never
  end the turn without it. The orchestrator distinguishes "no verdict returned" from "inconclusive".

The whole-branch finish path (`run_adversary_review`, §2c) applies the same contract: any non-success →
`--review-skipped --review-reason=<reason>`, whose durable `adversary_review_skipped` event uses a
hyphenated summary that deliberately does NOT match the `\b(codex|adversary)\s+review\b` audit regex, so a
degraded finish still trips `adversary_review_configured_but_zero_invocations`.

### 2. Adversary lane health → WARN (deterministic, via `doctor`)

The `lib/doctor/adversary-lane-health.mjs` check probes the lane on the host: `agent-dispatch` on PATH,
`agent-dispatch resolve --class adversary` exiting 0 with a route, and backend health. Every finding is
**WARN-only** — review is advisory, so an unusable lane degrades reviews to inconclusive but never breaks
a run or turns the doctor RED.

---

## Scope boundary with `api-retry-policy.md`

| Failure | Covered by |
|---|---|
| 429 rate-limit, 5xx server error, TCP timeout | `api-retry-policy.md` |
| Empty response (transport-level) | `api-retry-policy.md` |
| Review unavailable / non-zero / empty → `inconclusive` | This doc |
| Adversary lane unhealthy (not on PATH / no route / backend down) | This doc (enforced by the `adversary-lane-health` doctor check) |
