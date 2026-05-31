# Codex Failure Policy

**Applies to:** the two live v8 Codex surfaces — the optional per-task **review** path (`agents/mp-codex-reviewer.md`, dispatched by `workflows/execute.workflow.js` when the run bundle's `codex.review === "on"`) and the on-demand **rescue** path (`codex:codex-rescue`).
**Rewritten:** v8 (supersedes the v6.2.1 original, which governed a now-removed Codex *implementer* dispatch).
**Scope:** Codex-specific infrastructure failures where the transport succeeds but Codex doesn't usefully execute — the slice NOT covered by `docs/conventions/api-retry-policy.md` (transport-level 429 / 5xx / TCP timeout).

---

## What changed in v8 (read this first)

v8 Codex is **read-only**. It never implements a task and never commits: the review path runs `codex exec -s read-only` and the rescue path is an advisory subagent. Implementation in v8 is **always inline** (there is no codex-implementer). That single fact retires four v7 failure classes this doc used to define:

| v7 failure class | v8 status | why |
|---|---|---|
| **Silent exit** — Codex returned but the declared `Files:` didn't change | **RETIRED** | Codex no longer produces file changes; there is nothing to diff |
| **Daemon broken** — `app-server control socket already in use` / `ECONNREFUSED` / `codex daemon restart` | **RETIRED** | v8 uses one-shot `codex exec`, not a persistent daemon; a wedge surfaces as a `timeout`, handled below |
| **Linked-worktree sandbox** — Codex sandbox can't `git commit` | **RETIRED** | a `-s read-only` Codex never writes the tree |
| **Consecutive-failure streak → inline fallback** | **RETIRED** | there is no codex-implementer to fall back *from*; a failed review is simply `inconclusive` |

The one v7 class that survives in spirit is **auth degraded**, now enforced deterministically by the `codex-auth` doctor check.

---

## Live failure handling

### 1. Review wedge / unavailable → `inconclusive` (never hang, never fabricate)

The review agent (`agents/mp-codex-reviewer.md`) runs Codex as a **blocking, time-capped** `codex exec` (`timeout -k 10 540` — a hard 9-minute cap; `-k 10` sends SIGKILL 10s after SIGTERM). A blocking exec cannot orphan the way a detached launch did — it returns output or `timeout` kills it. On any of: cap hit, empty output, a missing `codex` binary, or unparseable output, the agent returns exactly one line:

    NOTE — Codex review inconclusive (<cap hit | no output | codex unavailable>). verdict: inconclusive

`inconclusive` means **"no blocking findings, proceed with a logged caveat" — NOT a clean pass.** The run never blocks waiting on a wedged Codex, and the agent never invents findings to fill the gap. Review is **failure-isolated per task** (`workflows/execute.workflow.js`): one wedged Codex degrades one task's review, never the whole wave's. Review is also config-gated **OFF by default** (`codex.review`), so on the common path this surface is inert.

### 2. Auth degraded → WARN (deterministic, via `doctor`)

Stale or expired Codex credentials degrade the optional review path. v8 detects this in `lib/doctor/codex-auth.mjs` (user-scoped — reads `~/.codex/auth.json`, ignores the repo):

- **ChatGPT auth** (`auth_mode: chatgpt` + a `refresh_token`) → **PASS**. Codex auto-refreshes the `id_token` on every invocation, so its `exp` is not a health signal for that mode.
- Otherwise the check decodes the `id_token` / `access_token` JWT `exp`: **expired** or **expiring within 24h** → WARN.
- Non-ChatGPT `last_refresh` older than **30 days** → soft WARN.
- `~/.codex/auth.json` absent → **SKIP** (Codex simply isn't installed — not a failure).

This is **WARN-only**: stale Codex auth degrades the optional review path, it never breaks a masterplan run. Remedy in every case: **`codex login`**.

### 3. Rescue path (`codex:codex-rescue`)

The rescue subagent is an Anthropic-provided Agent dispatched on demand (stuck / independent second diagnosis). Its transport and retry behaviour is governed by the platform, not by masterplan; masterplan treats a failed or unavailable rescue as advisory-absent and proceeds on the inline path.

---

## Scope boundary with `api-retry-policy.md`

| Failure | Covered by |
|---|---|
| 429 rate-limit, 5xx server error, TCP timeout | `api-retry-policy.md` |
| Empty response (transport-level) | `api-retry-policy.md` |
| Review wedge / cap-hit / `codex` unavailable → `inconclusive` | This doc |
| Auth degraded — JWT `exp` expired/expiring or `last_refresh` stale | This doc (enforced by the `codex-auth` doctor check) |

The legacy `app-server control socket is already in use` daemon error has no v8 analogue: one-shot `codex exec` has no persistent control socket to collide on.
