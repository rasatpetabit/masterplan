# API Retry Backoff Policy

**Applies to:** All subagent dispatch in Step C — Codex (`codex:codex-rescue`) and inline (`Agent()`) calls.  
**Added:** v5.9.0  
**Status:** Documentation-only. Because this orchestrator is a markdown prompt, actual retries happen by re-dispatching the Agent call within the same turn after the backoff delay elapses.

---

## Error Classification

| Error class | Examples | Policy |
|---|---|---|
| **Retryable** | 429 rate-limit, 503/504 server error, TCP timeout, connection reset, empty response (first occurrence) | Retry with exponential backoff (see schedule below) |
| **Fatal (no retry)** | 401/403 auth/permission error, task `BLOCK` (semantic blocker), orchestrator logic error, empty response (second occurrence) | Escalate immediately; do not retry |
| **Unknown** | Non-standard exit code from codex companion, malformed return JSON | Retry once; if still failing, treat as fatal |

The key distinction: **retryable errors are infrastructure failures** (the API or transport failed). **Fatal errors are semantic failures** (the task or auth configuration is wrong). Retrying a semantic failure wastes time and often produces the same result.

---

## Retry Schedule

```
attempt 1 (initial):  dispatch immediately
attempt 2:            wait 5s  then retry
attempt 3:            wait 15s then retry
attempt 4:            wait 45s then retry
→ after attempt 4 fails: treat as fatal (promote to blocker)
```

Max 3 retries per dispatch. Total max wait before promotion: ~65 seconds.

Use a `run-retry-count: N` in-memory counter per task to track attempts within a session.

---

## User-Facing Status

On each retry attempt, emit a one-line stdout notice (plain stdout, not inside a tool call):

```
⟳ Retrying task <name> (attempt K/3, reason: <error-class>) — waiting Xs...
```

Examples:
```
⟳ Retrying task WS-D (attempt 2/3, reason: 429 rate-limit) — waiting 5s...
⟳ Retrying task WS-E (attempt 3/3, reason: 503 server error) — waiting 15s...
```

On promotion to fatal after exhausting retries, emit before opening the blocker re-engagement gate:

```
✗ Task <name> failed after 3 retries (last error: <error-class>) — treating as blocker
```

---

## Scope

This policy applies to:
- **Codex dispatch** — `codex:codex-rescue` subagent calls via the `Agent` tool with `subagent_type: "codex:codex-rescue"`.
- **Inline subagent dispatch** — all other `Agent()` calls in Step C (implementer tasks, coordinator calls, reviewer subagents).

This policy does NOT apply to:
- Background process monitoring (Step B3 adversarial review polling) — that has its own `ScheduleWakeup`-based cadence.
- The Step 0 Codex availability ping — that is detection, not task dispatch; it has its own degradation path.

---

## Interaction with the Blocker Re-Engagement Ladder (CD-4)

API errors that exhaust the retry schedule are promoted to task blockers. The existing blocker re-engagement ladder (CD-4) then handles them identically to semantic blockers: two AUQ rungs, then escalation to the user. The retry schedule runs *before* the CD-4 ladder, not inside it.
