<!-- agentic-dispatch:claude-shim v2 -->
# CLAUDE.md — masterplan

Thin Claude Code shim. Canonical repo instructions are imported below; do not
add vendor-neutral policy here — put it in AGENTS.md.

@AGENTS.md

Central cross-repo policy (AUQ, RTK, Serena, Hindsight, context-mode, model
routing) lives in the agent-dispatch repo: run `agent-dispatch digest` for the
live routing policy, `agent-dispatch where` for the repo root. Never copy that
policy here.

## Claude Code specifics

- All user-facing questions go through `AskUserQuestion`; never end a turn with prose questions.
- Use Claude Code plugins, hooks, plan mode, and slash commands only as documented by repo-local `AGENTS.md` or active plugin settings.

<!-- agentic-dispatch:claude-notes — repo-specific Claude notes below this line survive re-migration -->
- This repo IS the Claude Code plugin: `/masterplan` routes through `commands/masterplan.md`; manifests live in `.claude-plugin/`. Project context (layers, anti-patterns, build/test) is canonical in AGENTS.md — imported above.
