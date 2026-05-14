---
name: masterplan
description: Use when the user invokes masterplan as a normal Codex chat request, $masterplan, /masterplan, /superpowers-masterplan:masterplan, asks to brainstorm, plan, execute, resume, import, doctor, status, next, retro, or clean masterplan work, or asks about existing docs/masterplan run bundles created by Claude.
---

# Codex entrypoint for Superpowers Masterplan

This skill is the Codex-visible entrypoint for Superpowers Masterplan. Its job is
to load the canonical command prompt and adapt it to the current Codex runtime.

## Source of truth (v5.0 lazy-load layout)

As of v5.0, `commands/masterplan.md` is a thin router (≤20 KB; enforced by
doctor check #36). Per-phase behavior lives in `parts/step-{0,a,b,c}.md`,
doctor lives in `parts/doctor.md`, import lives in `parts/import.md`, and
cross-cutting contracts live under `parts/contracts/`. Codex-hosted runs
should load the router first, then load only the phase file the router
dispatches to. Do not pre-read all phase files.

Resolve the router and phase files in this order:

1. `../../commands/masterplan.md` and `../../parts/` relative to this `SKILL.md` file.
2. `$PWD/commands/masterplan.md` and `$PWD/parts/` when running inside the plugin repo.
3. `/home/ras/dev/superpowers-masterplan/commands/masterplan.md` (+ sibling `parts/`).
4. `$HOME/.codex/.tmp/marketplaces/rasatpetabit-superpowers-masterplan/commands/masterplan.md` (+ sibling `parts/`).
5. `$HOME/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/commands/masterplan.md` (+ sibling `parts/`).
6. `$HOME/.claude/commands/masterplan.md`.

If none exists, say the local masterplan command file is missing and stop before
inventing behavior.

For ordinary runtime invocations, load the router (`commands/masterplan.md`)
and dispatch by verb to the right phase file:

- Bare `/masterplan` and `status` / `next`: router only — Step M / Step N /
  Step S live inline in `parts/step-0.md`.
- `brainstorm` / `plan` / `full`: load `parts/step-0.md` then `parts/step-b.md`
  (and `parts/step-a.md` for spec-pick).
- `execute` / `--resume=<path>`: load `parts/step-0.md` then `parts/step-c.md`
  plus the current run's `state.yml` and the specific current task block from
  `plan.md`.
- `doctor`: load `parts/doctor.md` (36 checks — v5.0 added #32–#36 covering
  200-char scalar cap (#32), projection mode (#33), plan.index staleness
  (#34), plan-format conformance (#35), router byte ceiling (#36)).
- `import`: load `parts/import.md`.
- `retro`: load `parts/step-c.md` (Step R subroutine).

In Codex, prefer summary-first inventory (`rg --files docs/masterplan` plus
targeted `state.yml` reads) before opening plan/spec artifacts. Avoid
exploratory full-file dumps of large prompt, plan, transcript, or event-log
files.

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

- `Use masterplan <args>` as a normal Codex chat message
- `masterplan <args>` when it appears as natural-language chat, not shell input
- `$masterplan`
- `$masterplan <args>` when it appears as normal chat; do not recommend this
  form because Codex TUI shell-command mode sends it to Bash
- `/masterplan`
- `/masterplan <args>`
- `/superpowers-masterplan:masterplan`
- `/superpowers-masterplan:masterplan <args>`
- natural-language requests to use, resume, check, import, or continue
  masterplan work.

The arguments are the text after the command name. If there are no arguments,
follow the command's bare invocation flow: resume active `state.yml` first,
re-render pending gates, poll background continuations, and treat `status:
blocked` as critical-error recovery rather than an ordinary pause. When Codex
renders a manual resume hint or close-out instruction, use an explicit normal
chat instruction, e.g.
`send a normal Codex chat message: Use masterplan execute docs/masterplan/<slug>/state.yml`;
do not surface Claude-only `/masterplan ...` or shell-looking `$masterplan ...`
as the primary Codex resume command.

## Codex native goal bridge

Codex native goal support is a pursuit wrapper for Masterplan plans, not a
Masterplan verb. After a plan exists, follow the command prompt's Codex native
goal pursuit contract: use `get_goal` to inspect the active thread goal, create
one with `create_goal` when an in-progress `state.yml` has no matching goal, and
call `update_goal(status="complete")` only after Masterplan's own completion
finalizer proves the plan is complete. Do not run `/goal`, `$goal`, or `goal` in
shell-command mode; those are host UI inputs, not executables. `state.yml`
remains authoritative for task position and recovery.

## Existing Claude-created projects

Codex must recognize plans created by Claude Code. Before starting a new plan,
inspect the current repo/worktree for:

- `docs/masterplan/*/state.yml`
- `docs/masterplan/*/{spec.md,plan.md,retro.md,events.jsonl}`
- legacy `docs/superpowers/plans/*-status.md`
- legacy `docs/superpowers/{plans,specs,retros,archived-plans,archived-specs}/*.md`

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

`Use masterplan ...` is the primary Codex chat/skill trigger for user-facing
resume hints. `$masterplan ...` can work only when the host records it as normal
chat; Codex TUI shell-command mode sends it to Bash. Never pass
`$masterplan ...`, `masterplan ...`, or `/masterplan ...` to `exec_command`;
Bash will either expand `$masterplan` as an environment variable or look for a
nonexistent executable.

Codex host suppression is only about recursive dispatch and review. When a
Codex `request_user_input` gate returns an answer label, treat that as explicit
interactive selection evidence even when it is the first/recommended option and
no free-form note is present. Follow the command prompt's
`codex_host_gate_continuation` rule for continuation answers and keep moving for
`full` / `execute` flows until a true halt gate, sensitive live-auth blocker, or
actual Codex host budget stop fires.
