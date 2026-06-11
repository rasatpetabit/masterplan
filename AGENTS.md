# AGENTS.md — `masterplan`


<!-- agentic-dispatch:central-pointer v2 -->
## Central agent policy

Cross-repo AskUserQuestion/ask_user_question (AUQ), RTK, Serena, Hindsight,
context-mode, and subagent/model-dispatch policy is centralized in the
agent-dispatch repo. Read it via `agent-dispatch where` (repo root) or
`agent-dispatch digest` (live routing policy). Do not duplicate or override
that policy here.

## §routing — managed by agent-dispatch (do not hand-edit)

Binding rules (enforced by PreToolUse guard — violations are hard-blocked):
- haiku: FORBIDDEN — no dispatch path exists, no override possible.
- sonnet: OVERRIDE-ONLY — requires a live, unexpired grant (`agent-dispatch override grant sonnet …`).
- model param MUST be explicit — missing model is denied.

For the full routing policy, fallback chains, and backend health:
  agent-dispatch digest          # live, from the canonical policy file
  agent-dispatch resolve <class> # deterministic tier for a task class

Source of truth: `policy/dispatch-policy.jsonc` in the agent-dispatch repo (`agent-dispatch where`)
<!-- agent-dispatch:end -->
<!-- agent-dispatch:begin routing hash=6d8307801e22f016588774ae010198516e8402aa6a7cd0724a433885e67b981b -->
## §routing — managed by agent-dispatch (do not hand-edit)

Binding rules (enforced by PreToolUse guard — violations are hard-blocked):
- haiku: FORBIDDEN — no dispatch path exists, no override possible.
- sonnet: OVERRIDE-ONLY — requires a live, unexpired grant (`agent-dispatch override grant sonnet …`).
- model param MUST be explicit — missing model is denied (exception: harness built-ins Explore/Plan inherit the frontier session model).

For the full routing policy, fallback chains, and backend health:
  agent-dispatch digest          # live, from the canonical policy file
  agent-dispatch resolve <class> # deterministic tier for a task class

Source of truth: policy/dispatch-policy.jsonc in the agent-dispatch repo (run `agent-dispatch where` for its root).
<!-- agent-dispatch:end -->
