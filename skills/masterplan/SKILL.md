---
name: masterplan
description: Use when the user invokes /masterplan, /superpowers-masterplan:masterplan, asks to brainstorm, plan, execute, resume, import, doctor, status, next, retro, or clean masterplan work, or asks about existing docs/masterplan run bundles created by Claude.
---

# Codex entrypoint for Superpowers Masterplan

This skill is the Codex-visible entrypoint for Superpowers Masterplan. Its job is
to load the canonical command prompt and adapt it to the current Codex runtime.

## Source of truth

Before acting, read `commands/masterplan.md` from the Superpowers Masterplan
plugin/repo and follow it as the behavior source of truth.

Resolve the command file in this order:

1. `../../commands/masterplan.md` relative to this `SKILL.md` file.
2. `$PWD/commands/masterplan.md` when running inside the plugin repo.
3. `/home/ras/dev/superpowers-masterplan/commands/masterplan.md`.
4. `$HOME/.codex/.tmp/marketplaces/rasatpetabit-superpowers-masterplan/commands/masterplan.md`.
5. `$HOME/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/commands/masterplan.md`.
6. `$HOME/.claude/commands/masterplan.md`.

If none exists, say the local masterplan command file is missing and stop before
inventing behavior.

## Config bootstrap

Before deriving defaults, selecting a route, creating state, or asking any
workflow question, load the same config tiers as Step 0 in
`commands/masterplan.md`:

1. Read `$HOME/.masterplan.yaml` (`~/.masterplan.yaml`) if it exists.
2. Resolve the current repo root with `git rev-parse --show-toplevel`, then read
   `<repo-root>/.masterplan.yaml` if it exists.
3. Shallow-merge in this order:
   built-in defaults < user-global < repo-local < invocation flags.

Use the merged config for Codex-hosted runs too. Codex host suppression only
forces the effective `codex.routing` / `codex.review` behavior off for the
current invocation to avoid recursive dispatch; it does not bypass or rewrite
user-global defaults such as `autonomy`, `complexity`, `runs_path`, or
`parallelism`.

## Invocation mapping

Treat these user inputs as this skill:

- `/masterplan`
- `/masterplan <args>`
- `/superpowers-masterplan:masterplan`
- `/superpowers-masterplan:masterplan <args>`
- natural-language requests to use, resume, check, import, or continue
  masterplan work.

The arguments are the text after the command name. If there are no arguments,
follow the command's bare invocation flow.

## Existing Claude-created projects

Codex must recognize plans created by Claude Code. Before starting a new plan,
inspect the current repo/worktree for:

- `docs/masterplan/*/state.yml`
- `docs/masterplan/*/{spec.md,plan.md,retro.md,events.jsonl}`
- legacy `docs/superpowers/plans/*-status.md`
- legacy `docs/superpowers/{plans,specs,retros,archived-plans,archived-specs}/*.md`

If `bin/masterplan-state.sh` is present, prefer:

```bash
bin/masterplan-state.sh inventory
```

Do not assume there is no active work because Codex did not create the run
bundle. `state.yml` is the durable source of truth.

## Codex tool adaptation

When the command prompt names Claude Code tools, use the local Codex equivalents:

- Read/LS/Grep/Glob: shell reads with `sed`, `ls`, `rg`, or `rg --files`.
- Edit/MultiEdit: `apply_patch`.
- Bash: `exec_command`.
- AskUserQuestion/Question: `request_user_input` when available; otherwise ask
  one concise prose question and wait.
- Task/Todo task tracking: `update_plan`.
- Skill: open the referenced `SKILL.md` and follow it.
- Agent/Subagent/Parallel: only spawn agents when the user explicitly asked for
  subagents or parallel agent work; otherwise run sequentially in this Codex
  session and use `multi_tool_use.parallel` only for independent tool calls.

Follow the command prompt's Codex-host suppression rules: do not recursively
dispatch to Codex from inside a Codex-hosted masterplan run.
