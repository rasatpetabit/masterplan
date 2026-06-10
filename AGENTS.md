# AGENTS.md — `masterplan`


## Central agent policy

Cross-repo AskUserQuestion/ask_user_question (AUQ), RTK, Serena, Hindsight, context-mode, and central agent policy is centralized in `/srv/dev/agent-dispatch/AGENTS.md`. Do not duplicate or override that policy here.

All project context — codebase layout, anti-patterns, operating principles,
canonical reading order — lives in [`CLAUDE.md`](./CLAUDE.md). Read that file
first. AGENTS.md exists for tooling that conventionally looks for `AGENTS.md`
(Codex CLI, Cursor, etc.); the content is the same.

@CLAUDE.md

<!-- agent-dispatch:begin routing hash=cf68de826a5dea456cfc79dff4ef234e0139de8751500e8521c8d048a3f5c43f -->
## §routing — managed by agent-dispatch (do not hand-edit)

Binding rules (enforced by PreToolUse guard — violations are hard-blocked):
- haiku: FORBIDDEN — no dispatch path exists, no override possible.
- sonnet: OVERRIDE-ONLY — requires a live, unexpired grant (`agent-dispatch override grant sonnet …`).
- model param MUST be explicit — missing model is denied.

For the full routing policy, fallback chains, and backend health:
  agent-dispatch digest          # live, from the canonical policy file
  agent-dispatch resolve <class> # deterministic tier for a task class

Source of truth: /srv/dev/agent-dispatch/policy/dispatch-policy.jsonc
<!-- agent-dispatch:end -->
