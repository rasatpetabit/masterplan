# Hoist Run Policy Gate + API Retry Backoff Documentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-wave parallelism AUQs with a single upfront run-policy gate; document the API retry backoff policy for subagent dispatch.

**Architecture:** Two independent changes. Part A adds a new in-memory `run_policy` variable and a one-time AUQ gate in `parts/step-c-dispatch.md` that fires at the first parallel wave assembly. Part B creates `docs/conventions/api-retry-policy.md` and cross-references it from the existing dispatch documentation.

**Tech Stack:** bash, grep — no compiled code; all verification is grep + `bash -n` + exit-code checks.

---

### Task 1: Create `docs/conventions/api-retry-policy.md`

**Files:**
- Create: `docs/conventions/api-retry-policy.md`

**Spec:** spec.md §Part B — API retry policy documentation
**Codex:** false
**Verify:** `bash tests/structural/test-api-retry-policy.sh 2>&1 | tail -3`

- [ ] **Step 1: Write a failing test**

```bash
# tests/structural/test-api-retry-policy.sh
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${1:-$(git rev-parse --show-toplevel)}"
FAIL=0

f="$REPO_ROOT/docs/conventions/api-retry-policy.md"
if [ ! -f "$f" ]; then
  echo "FAIL: docs/conventions/api-retry-policy.md does not exist"
  FAIL=1
fi

if [ -f "$f" ]; then
  grep -qiE "retryable|retry" "$f" || { echo "FAIL: missing retryable classification"; FAIL=1; }
  grep -qiE "5s.*15s|15s.*45s|backoff" "$f" || { echo "FAIL: missing backoff schedule"; FAIL=1; }
  grep -qiE "codex|inline.*dispatch|dispatch.*inline" "$f" || { echo "FAIL: missing scope (codex vs inline)"; FAIL=1; }
  grep -qiE "429|rate.?limit|5xx|timeout" "$f" || { echo "FAIL: missing error class examples"; FAIL=1; }
fi

[ $FAIL -eq 0 ] && echo "PASS: api-retry-policy checks" || exit 1
```

Save to `tests/structural/test-api-retry-policy.sh`, make executable: `chmod +x tests/structural/test-api-retry-policy.sh`

- [ ] **Step 2: Run test to confirm it fails**

```bash
bash tests/structural/test-api-retry-policy.sh
```
Expected: FAIL (file doesn't exist yet)

- [ ] **Step 3: Create the policy document**

Create `docs/conventions/api-retry-policy.md`:

```markdown
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
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bash tests/structural/test-api-retry-policy.sh
```
Expected: `PASS: api-retry-policy checks`

- [ ] **Step 5: Verify fast tier still passes**

```bash
bash tests/run-tests.sh --fast
```
Expected: PASS (all fast tests, including new structural test)

- [ ] **Step 6: Commit**

```bash
git add docs/conventions/api-retry-policy.md tests/structural/test-api-retry-policy.sh
git commit -m "docs(conventions): add API retry backoff policy (v5.9.0)"
```

---

### Task 2: Add run-policy gate to `parts/step-c-dispatch.md`

**Files:**
- Modify: `parts/step-c-dispatch.md:38-40`

**Spec:** spec.md §Part A — run-policy gate design
**Codex:** false
**Verify:** `bash tests/structural/test-coordinator-dispatch.sh 2>&1 | tail -3`

- [ ] **Step 1: Write a failing test**

Add to `tests/structural/test-coordinator-dispatch.sh` (A5 check at end of the existing A1-A4 block):

```bash
# A5: run-policy gate present in wave assembly
if ! grep -qF "run_policy" "$REPO_ROOT/parts/step-c-dispatch.md"; then
  echo "FAIL A5: run_policy gate not found in parts/step-c-dispatch.md"
  FAIL=1
else
  echo "PASS A5: run_policy gate present"
fi

# A6: run-policy gate fires before wave dispatch (order check)
awk '/run_policy/,/When a wave assembles/' "$REPO_ROOT/parts/step-c-dispatch.md" | grep -q "When a wave assembles" \
  || { echo "FAIL A6: run_policy gate must appear before 'When a wave assembles'"; FAIL=1; }
[ "${FAIL:-0}" -eq 0 ] && echo "PASS A6: run_policy gate order correct"
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bash tests/structural/test-coordinator-dispatch.sh
```
Expected: FAIL on A5 (run_policy not yet present)

- [ ] **Step 3: Add the run-policy gate to step-c-dispatch.md**

Insert after line 38 (the `config.parallelism.enabled == false` kill-switch) and before the `**When a wave assembles**` line 40. The new section:

```markdown
**Run-policy gate (v5.9.0+, first wave only).** When a wave of ≥ 2 tasks assembles and `run_policy` is not yet set for this session, fire the upfront gate before dispatching:

<masterplan-trace gate=fire id=run_policy auq-options=4>

```
AskUserQuestion(
  question="About to dispatch a parallel wave of <N> tasks (group: <name>). Set run policy for this session:",
  options=[
    "Parallel + ask on each blocker (Recommended) — fastest; pauses at each block to ask",
    "Parallel + async hold on blocker — fastest; holds blocked tasks and surfaces them at next check-in",
    "Serial + ask on each blocker — safest; one task at a time",
    "Serial + halt on any blocker — serial execution; stops everything on first block"
  ]
)
```

Set `run_policy` from selection:
- Option 1: `{parallelism: parallel, on_blocker: ask}`
- Option 2: `{parallelism: parallel, on_blocker: async_hold}`
- Option 3: `{parallelism: serial, on_blocker: ask}`
- Option 4: `{parallelism: serial, on_blocker: halt}`

**Default (gate dismissed / `run_policy` not yet set):** `{parallelism: serial, on_blocker: ask}` — no behavior change from current.

After gate: if `run_policy.parallelism == serial`, fall through to standard per-task serial dispatch (skip wave assembly). If `parallel`, proceed to wave dispatch below.

On subsequent wave assemblies this session: `run_policy` is already set — read it directly without re-firing the gate.

**`on_blocker: async_hold` semantics.** When a wave member returns `status: blocked` and `run_policy.on_blocker == async_hold`: mark the task as `held` (not `blocked`) in session memory. Continue dispatching remaining tasks and subsequent waves. Accumulate all held tasks. At plan completion (or at the next `/masterplan` invocation), surface held tasks in a single AUQ: `"<N> tasks were held during this run."` with options `[Review and retry each / Skip all held tasks / Abort run]`.
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bash tests/structural/test-coordinator-dispatch.sh
```
Expected: A1-A6 all PASS

- [ ] **Step 5: Verify fast tier still passes**

```bash
bash tests/run-tests.sh --fast
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add parts/step-c-dispatch.md tests/structural/test-coordinator-dispatch.sh
git commit -m "feat(dispatch): add run-policy gate at first wave assembly (v5.9.0)"
```

---

### Task 3: Add cross-references + update wave-dispatch internals doc

**Files:**
- Modify: `parts/step-c-dispatch.md` (Codex dispatch section, ~line 219)
- Modify: `docs/internals/wave-dispatch.md` (add §API Error Handling section)

**Spec:** spec.md §Part B — cross-references from dispatch + wave-dispatch docs
**Codex:** false
**Verify:** `bash tests/structural/test-api-retry-policy.sh 2>&1 | tail -3`

- [ ] **Step 1: Write a failing test**

Add to `tests/structural/test-api-retry-policy.sh`:

```bash
# Cross-ref checks
grep -q "api-retry-policy" "$REPO_ROOT/parts/step-c-dispatch.md" \
  || { echo "FAIL: step-c-dispatch.md missing api-retry-policy cross-ref"; FAIL=1; }
grep -q "api-retry-policy" "$REPO_ROOT/docs/internals/wave-dispatch.md" \
  || { echo "FAIL: wave-dispatch.md missing api-retry-policy cross-ref"; FAIL=1; }
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bash tests/structural/test-api-retry-policy.sh
```
Expected: FAIL on cross-ref checks

- [ ] **Step 3: Add cross-ref to parts/step-c-dispatch.md Codex dispatch section**

In the `**Delegating:**` paragraph (around line 219), append after the closing backtick block:

```markdown
**API error handling.** If the `codex:codex-rescue` dispatch fails with a transport or rate-limit error, apply the retry schedule in `docs/conventions/api-retry-policy.md` before promoting to a blocker. The same policy applies to inline `Agent()` dispatch.
```

- [ ] **Step 4: Add §API Error Handling to docs/internals/wave-dispatch.md**

Append a new section at the end of `docs/internals/wave-dispatch.md`:

```markdown
## API Error Handling

Transient API errors (429 rate-limit, 5xx, transport timeout) are distinct from task blockers. The retry policy, backoff schedule, user-facing notices, and scope (Codex vs inline dispatch) are documented in `docs/conventions/api-retry-policy.md`.

The key invariant: API retries happen *before* the blocker re-engagement ladder (CD-4). Only after 3 retries are exhausted does the task promote to a blocker and enter CD-4.
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
bash tests/structural/test-api-retry-policy.sh
```
Expected: PASS (all checks including cross-refs)

- [ ] **Step 6: Verify all fast tests pass**

```bash
bash tests/run-tests.sh --fast
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add parts/step-c-dispatch.md docs/internals/wave-dispatch.md tests/structural/test-api-retry-policy.sh
git commit -m "docs: cross-reference api-retry-policy from dispatch + wave-dispatch internals"
```

---

### Task 4: Final verification + CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

**Spec:** spec.md §All — final verification pass
**Codex:** false
**Verify:** `bash tests/run-tests.sh --full 2>&1 | tail -3`

- [ ] **Step 1: Run full test suite**

```bash
bash tests/run-tests.sh --full
```
Expected: 10/10 PASS (6 fast + doctor-fixtures + hook-unit + python-unit-tests)

- [ ] **Step 2: Run doctor checks that cover the changed files**

```bash
cd <worktree-root> && violations=0
for f in parts/step-c-dispatch.md docs/conventions/api-retry-policy.md docs/internals/wave-dispatch.md; do
  while IFS=: read -r lineno rest; do
    case "$rest" in *'grep '*) continue ;; esac
    context="$(awk -v s="$lineno" -v e="$((lineno+3))" 'NR>=s && NR<=e' "$f" 2>/dev/null)"
    if ! echo "$context" | grep -qiE "≤|max|limit|[0-9]+ items?|[0-9]+ chars?"; then
      echo "WARN $f:$lineno: Return shape block lacks item/char cap"
      violations=$((violations + 1))
    fi
  done < <(grep -n "Return shape:\|return shape:" "$f" 2>/dev/null)
done
echo "return-shape violations: $violations"
```
Expected: 0 violations

- [ ] **Step 3: Add CHANGELOG entry**

In `CHANGELOG.md`, under the `## [Unreleased]` section (or create one if absent), add:

```markdown
### v5.9.0 — 2026-05-23

#### Added
- **Run-policy gate** (`parts/step-c-dispatch.md`): Single upfront AUQ fires at first parallel wave assembly to capture both parallelism choice (`serial|parallel`) and on-blocker policy (`ask|async_hold|halt`). Session-only; not persisted to `state.yml`. Default: `{parallelism: serial, on_blocker: ask}` (no behavior change when gate not answered). Serial plans never see the gate. Resolves the per-wave ordering AUQ friction reported on multi-workstream runs.
- **`on_blocker: async_hold`**: New on-blocker policy — holds blocked tasks, continues other tasks and subsequent waves, surfaces all held tasks at next check-in rather than interrupting the run.
- **API retry backoff policy** (`docs/conventions/api-retry-policy.md`): New conventions doc documenting the retryable/fatal error classification, 3x retry schedule (5s/15s/45s), user-facing retry notices, and scope (Codex + inline dispatch). Cross-referenced from `parts/step-c-dispatch.md` and `docs/internals/wave-dispatch.md`.
```

- [ ] **Step 4: Run fast tests one final time**

```bash
bash tests/run-tests.sh --fast
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore(changelog): add v5.9.0 entry for run-policy gate + api-retry-policy"
```
