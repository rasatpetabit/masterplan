# CLAUDE.md — masterplan

Thin Claude Code wrapper for this repository.

Canonical repo instructions live in [`AGENTS.md`](AGENTS.md).
Central AUQ, RTK, Serena, Hindsight, context-mode, and agent policy lives in `/srv/dev/agent-dispatch/AGENTS.md`.

## Claude Code specifics

- Use Claude Code plugins, hooks, plan mode, or slash commands only as documented by repo-local `AGENTS.md` or active Claude plugin settings.
- All user-facing questions still go through `AskUserQuestion` / `ask_user_question`; never ask prose questions in final text.
- Do not duplicate dispatch policy here. Update `/srv/dev/agent-dispatch` instead.
