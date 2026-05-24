# Codex Failure Policy

**Applies to:** All `codex:codex-rescue` subagent dispatch in Step C.
**Added:** v6.2.1
**Scope:** Covers failure modes NOT handled by `docs/conventions/api-retry-policy.md`. That doc covers transport-level errors (429, 5xx, TCP timeout). This doc covers Codex-specific infrastructure failures where the transport succeeds but the worker does not execute the task.

---

## Failure Classes

### 1. Silent Exit

The Codex worker spawns and receives the task brief, but no file changes occur. The subagent returns normally (no exception, no explicit error) but the expected work didn't happen.

**Primary detection:** After Codex returns, compare the task's declared `**Files:**` section against actual git state:
- **Serial dispatch:** `git diff --stat <task_start_sha>..HEAD` — empty diff when `Create:` or `Modify:` paths were declared.
- **Wave members:** `staged_changes_digest` is empty or null when `files_changed: []` and task declared file changes.

If the diff is empty and the plan expected changes, this is a silent exit regardless of what Codex reported.

**Common causes:** daemon restart between dispatch and execution; stale socket file; worker process timeout before task begins.

### 2. Daemon Broken

A sub-type of silent exit. The Codex return text contains explicit infrastructure error patterns:
- `app-server control socket is already in use`
- `ECONNREFUSED`
- `socket already in use`
- `daemon` in an error context

**Additional action:** After routing inline, emit `Consider running: codex daemon restart` in the user-facing notice.

### 3. Auth Degraded

Expired or stale credentials cause silent exits. The Step 0 CC-2 health indicator (`↳ Codex: degraded`) surfaces this at session start, but auth can degrade mid-session.

**Detection:** `~/.codex/auth.json` `last_refresh` > 7 days (and `auth_mode != "chatgpt"`). For `auth_mode == "chatgpt"`, check whether `tokens.refresh_token` is absent or `id_token.exp` is expired by more than a day.

**Action:** Route inline immediately — do NOT use the two-failure streak counter. Retrying against degraded auth is guaranteed to fail.

### 4. Sandbox Read-Only Git (Linked Worktree)

When masterplan runs inside a linked git worktree (`.git` index lives outside the workspace path), the Codex sandbox restricts writes to the workspace. `git add` and `git commit` fail silently — Codex appears to complete the task but no commits appear.

**Structural detection** (run in `parts/step-c-dispatch.md` before any Codex dispatch):
```bash
git_dir="$(git rev-parse --git-dir 2>/dev/null)"
git_common="$(git rev-parse --git-common-dir 2>/dev/null)"
superproject="$(git rev-parse --show-superproject-working-tree 2>/dev/null)"
```
Linked worktree detected when `git_dir != git_common` AND `superproject` is empty. The superproject guard prevents submodule false-positives.

**Do NOT use a `touch` probe** — the orchestrator has full user permissions and can always write to `.git`, making the probe return `writable` regardless of sandbox topology.

**Action:** Skip Codex dispatch. Route inline. Record `decision_source: linked-worktree`. Log `{"event":"codex_skip_linked_worktree","task":"<task>"}` to `events.jsonl`. This is a preemptive block (topology-detected before dispatch), not a post-failure recovery.

---

### 5. Scope boundary with api-retry-policy.md

| Failure | Covered by |
|---|---|
| 429 rate-limit, 5xx server error, TCP timeout | `api-retry-policy.md` |
| Empty response (first/second occurrence) | `api-retry-policy.md` |
| Task semantic `BLOCK` or permission error | `api-retry-policy.md` (fatal class) |
| Silent exit — no file changes after return | This doc |
| Daemon broken — socket/ECONNREFUSED in return text | This doc |
| Auth degraded — `last_refresh` stale or tokens expired | This doc |
| Linked-worktree topology — Codex sandbox cannot commit | This doc |

The `app-server control socket is already in use` error is an infrastructure failure (this doc), not a transport failure — the transport succeeded but the daemon couldn't process the request.

---

## Consecutive-Failure Threshold

Track `codex_failure_streak[task_name]` (session-only, not persisted to `state.yml`). Increment on each silent-exit or daemon-broken failure. Reset to 0 on a successful Codex return for that task.

- **Streak 1 (first failure):** Redispatch via `codex:codex-rescue` once with the same brief. This handles transient daemon restarts.
- **Streak ≥ 2 (second consecutive failure):** Route inline. No further Codex retries for this task this session.

Auth-degraded failures skip the streak counter and go directly to inline fallback.

---

## User-Facing Notices

**Silent exit, first failure (retry):**
```
⚠ Codex silent exit on <task> (attempt 1/2) — retrying dispatch
```

**Silent exit, second consecutive failure (inline fallback):**
```
⚠ Codex infrastructure failure on <task> (2 consecutive silent exits) — routing inline
```

**Daemon-broken sub-type (inline fallback):**
```
⚠ Codex daemon broken on <task> (socket error) — routing inline. Consider running: codex daemon restart
```

**Auth-degraded (inline fallback, skip streak):**
```
⚠ Codex auth degraded — routing <task> inline. Run: codex login
```

---

## Inline Fallback Procedure

When the streak threshold is reached or auth is degraded:
1. Emit the appropriate user-facing notice above.
2. Route the task inline using the same implementation brief, excluding Codex-specific clauses (`Allowed files:`, `Do not touch:`).
3. Append `[inline:codex-fallback]` to the completion event (instead of the normal `[codex]` tag) so the routing distribution is accurate.
4. Continue plan execution — the fallback is transparent to subsequent tasks.
