# Spec: Hoist Run Policy Gate + API Retry Backoff Documentation

**Bundle**: hoist-run-policy  
**Date**: 2026-05-23  
**Status**: spec_gate

---

## Intent Anchor

**Mode**: implementation-design  
**Scope boundary**: `superpowers-masterplan` repo only. Changes confined to `parts/`, `commands/`, `docs/conventions/`, `docs/internals.md`. No external test framework dependencies.  
**Verification ceiling**: local-static (grep + bash -n + exit-code checks; no runtime Claude invocations)

---

## Problem

### Part A — Wave ordering AUQ fires at every stage

When a user says "go ahead and run all workstreams," the masterplan orchestrator currently stops at every wave boundary to ask how to handle WS ordering and parallelism. For plans with 4-8 workstreams, this produces 4-8 interruptions for decisions the user has already implicitly made. The AUQ friction defeats the purpose of an "execute everything" command.

The correct behavior: ask once (the first time a parallel wave assembles), persist the answer in memory for the session, and never ask again during that run.

### Part B — No documented policy for Claude API errors

When a subagent dispatch fails with a transient API error (429 rate-limit, 5xx server error, transport timeout), the orchestrator has no defined behavior. In practice this often looks like a task blocker, which triggers the full blocker re-engagement ladder — wrong escalation path for a recoverable infrastructure issue. There is no retry policy, no user-visible retry status, and no distinction between retryable and fatal errors.

---

## Design

### Part A: Run Policy Gate

**New in-memory variable:** `run_policy` — set once per session, never written to `state.yml`.

```
run_policy:
  parallelism: serial | parallel   (default: serial)
  on_blocker:  halt | async_hold | ask   (default: ask)
```

**Gate trigger:** Fires at Step C step 2 (wave assembly), when:
- A wave of ≥2 parallel-eligible tasks is about to be dispatched, AND
- `run_policy` is not yet set (first wave of the session)

Serial plans (no parallel groups, or max wave size = 1) never assemble a wave and never see this gate. Zero friction for simple runs.

**Gate shape (one AUQ, two questions):**

```
AskUserQuestion(
  question="About to dispatch a parallel wave of N tasks. Set run policy for this session:",
  options=[
    "Serial: run tasks one at a time (safe, recommended for first runs)",
    "Parallel: dispatch waves as assembled (faster)",
    "Parallel + halt on any blocker (waves run in parallel; one blocked task halts everything)",
    "Parallel + async hold (waves run in parallel; blocked tasks held for next check-in)"
  ]
)
```

Plus a separate embedded question on blocker behavior when "Parallel" is selected:

**Simplified: combine into 4 named options** (each encodes both dimensions):

| Option | parallelism | on_blocker |
|---|---|---|
| Serial, ask on blocker | serial | ask |
| Serial, halt on blocker | serial | halt |
| Parallel, ask on blocker (Recommended) | parallel | ask |
| Parallel, async hold on blocker | parallel | async_hold |

Recommended = "Parallel, ask on blocker" (matches prior behavior with less friction).

**After gate:** Set `run_policy` in memory. All subsequent wave assemblies in this session use `run_policy.parallelism` directly — no gate re-fires.

**Default (gate dismissed or not yet set):** `{parallelism: serial, on_blocker: ask}` — no behavior change from current.

**`on_blocker: async_hold` semantics:** When a wave member returns `status: blocked`, mark it as `held` (not `blocked`) in session state. Continue dispatching remaining tasks / subsequent waves. Accumulate held tasks. On the next `/masterplan` invocation (or at end of plan execution), surface all held tasks in a single AUQ: "N tasks were held during this run. Review and retry / skip / abort each."

**Files changed:**
- `parts/step-c-dispatch.md` — add run-policy gate at wave assembly entry point (Step C step 2, wave assembly section)
- `commands/masterplan.md` — register `run_policy` as a recognized in-memory variable; add to Step 0 recognized flags if a `--run-policy=serial|parallel` CLI override makes sense

---

### Part B: API Retry Backoff Policy Document

**New file:** `docs/conventions/api-retry-policy.md`

**Content spec:**

#### Retryable vs Fatal Errors

| Error class | Examples | Policy |
|---|---|---|
| Retryable | 429 rate-limit, 503/504 server error, TCP timeout, connection reset | Retry with exponential backoff |
| Fatal (no retry) | 401/403 auth/permission error, task `BLOCK` (semantic blocker), orchestrator logic error | Escalate immediately; do not retry |
| Unknown / ambiguous | Non-standard exit code from codex companion, empty response | Retry once; if still failing, treat as fatal |

#### Retry Schedule

```
attempt 1: immediate dispatch
attempt 2: wait 5s then retry
attempt 3: wait 15s then retry
attempt 4: wait 45s then retry
→ after attempt 4 fails: treat as fatal (promote to blocker)
```

Max 3 retries per dispatch. Total max wait before escalation: ~65 seconds.

#### User-Facing Status

On each retry attempt, emit a one-line stdout notice:

```
⟳ Retrying task N (attempt K/3, reason: <error-class>) — waiting Xs...
```

On promotion to fatal after exhausting retries:

```
✗ Task N failed after 3 retries (reason: <last-error>) — promoting to blocker
```

#### Scope

This policy applies to both dispatch paths:
- **Codex dispatch** (`codex:codex-rescue` subagent calls via Agent tool)
- **Inline subagent dispatch** (all other `Agent()` calls in Step C)

It does NOT apply to background process monitoring (Step B3 adversarial review polling), which has its own wakeup/retry cadence.

**Implementation note:** Because this orchestrator is a markdown prompt (no executable dispatch code), this policy is documentation-only. The actual retry behavior is implemented by acknowledging the error in the orchestrator's response and re-dispatching the Agent call from within the same turn. The policy document makes this behavior explicit and auditable.

**Reference from existing docs:**
- `parts/step-c-dispatch.md` — add `See docs/conventions/api-retry-policy.md for retry behavior on API errors` to the Codex dispatch and inline dispatch sections
- `docs/internals.md` — add a `§API error handling` reference in the subagent dispatch section

---

## Success Criteria

1. **No per-wave AUQ** for plans whose `run_policy` is already set in the current session.
2. **First-wave gate fires exactly once** per session when a wave assembles, capturing both parallelism and on-blocker choice.
3. **Serial plans** (no parallel groups) never see the gate.
4. **`api-retry-policy.md` exists** with retryable/fatal classification, 3x retry schedule, user-facing status format, and scope (Codex + inline).
5. **Cross-references** in `step-c-dispatch.md` and `docs/internals.md` point to the policy doc.
6. **Tests pass**: `tests/run-tests.sh --fast` exits 0 after all changes.

---

## Out of Scope

- Persisting `run_policy` to `state.yml` (session-only by design)
- CLI flag `--run-policy=` override (deferred; can be added later as a thin flag-to-memory mapping)
- Actually implementing retry logic in bash/Python tooling (policy-doc only; actual retries happen in the orchestrator prompt's turn-by-turn responses)
- Changes to the blocker re-engagement CD-4 ladder (unchanged)
