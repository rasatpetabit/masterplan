# claude-superflow

A Claude Code plugin that orchestrates a complete development workflow: **brainstorm → plan → execute**, with worktree management, legacy plan import, configurable autonomy, Codex routing, and self-paced cross-session loops.

It's a thin orchestrator over the [superpowers](https://github.com/obra/superpowers) skills — `/superflow` doesn't reimplement brainstorming, planning, or execution. It sequences them, persists state in a single status file per plan, and adds the connective tissue that makes long-running development work survive across sessions and worktrees.

## What you get

- **`/superflow <topic>`** — kick off a full brainstorm → plan → execute flow.
- **`/superflow import`** — discover legacy planning artifacts (PLAN.md, GitHub issues, branches, orphan superpowers plans) and convert them to the unified schema with completion-state inference so already-done work isn't redone.
- **`/superflow doctor`** — lint state across all worktrees of the current repo.
- **`/superflow --resume=<path>`** — pick up a specific plan exactly where it left off.
- **`/loop /superflow ...`** — self-paced cross-session execution; wakes itself every ~25 minutes to advance the plan a few tasks at a time.
- **`superflow-detect` skill** — auto-suggests `/superflow import` when legacy planning artifacts are present in the repo. Never auto-runs.
- **`superflow-retro` skill** — generates a structured retrospective doc when a plan completes.

## Why this exists

Long-running development work tends to sprawl: a PLAN.md here, a feature branch there, a half-done docs/superpowers/plans/ from a previous session, a Linear ticket nobody's looked at in a week. After a session ends, the context evaporates and the next agent (or human) has to reconstruct what's done and what's left.

`/superflow` enforces a single source of truth — a status file alongside each plan — that captures: which worktree the work lives in, which branch, which task is current, what's been tried, what's blocked. Resume from anywhere, scan in-progress work across all your worktrees, and lint when something feels off.

## Install

### Option A — Claude Code plugin (recommended)

```bash
# Once Claude Code's plugin install supports github.com URLs:
claude plugin install rasatpetabit/claude-superflow

# Or clone into your plugins directory manually:
git clone https://github.com/rasatpetabit/claude-superflow.git \
  ~/.claude/plugins/claude-superflow
```

### Option B — manual

Drop the slash command into your user commands directory:

```bash
mkdir -p ~/.claude/commands ~/.claude/skills
cp commands/superflow.md ~/.claude/commands/
cp -r skills/superflow-detect ~/.claude/skills/
cp -r skills/superflow-retro ~/.claude/skills/
```

### Dependencies

- **Required:** [`superpowers`](https://github.com/obra/superpowers) — `/superflow` delegates to its `brainstorming`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `using-git-worktrees`, `systematic-debugging`, and `finishing-a-development-branch` skills.
- **Optional:** `codex` plugin (only needed if `codex_routing` is `auto` or `manual`) — provides the `codex:codex-rescue` subagent.
- **Optional:** `context7` MCP server — used by the CD-4 ladder for library documentation lookups.
- **Optional:** `gh` CLI — required for `/superflow import` of GitHub issues and PRs.

## Quick start

### Start a new feature

```
/superflow add Stripe webhook handler
```

Walks you through brainstorming (interactive), produces a spec at `docs/superpowers/specs/`, generates a plan at `docs/superpowers/plans/`, then executes task-by-task with subagents.

### Long autonomous run

```
/loop /superflow refactor auth middleware --autonomy=loose
```

Same flow, but execution runs autonomously with `ScheduleWakeup`-paced resumption. Stops on blockers (which get recorded in the status file's `## Blockers` section).

### Resume in-progress work

```
/superflow                              # lists in-progress plans across worktrees
/superflow --resume=docs/superpowers/plans/2026-04-15-auth-status.md
```

### Migrate legacy plans

```
/superflow import
```

Scans for PLAN.md, TODO.md, ROADMAP.md, docs/plans/*.md, GitHub issues, draft PRs, open feature branches, and orphan superpowers plans. Pick which to import, get them rewritten in the canonical format with completion inference, and start executing.

### Audit your state

```
/superflow doctor          # lint across all worktrees
/superflow doctor --fix    # auto-fix safe issues
```

## Subcommand reference

| Invocation | Effect |
|---|---|
| `/superflow` | List in-progress plans across all worktrees of the current repo; pick one to resume or start fresh |
| `/superflow <topic>` | Kickoff: brainstorm → plan → execute |
| `/superflow --resume=<status-path>` | Resume a specific plan from its status file |
| `/superflow import` | Discover legacy planning artifacts and convert them |
| `/superflow import --pr=<num>` | Import directly from a single GitHub PR |
| `/superflow import --issue=<num>` | Import directly from a single GitHub issue |
| `/superflow import --file=<path>` | Import directly from a single local file |
| `/superflow import --branch=<name>` | Reverse-engineer a spec/plan from a single branch's history |
| `/superflow doctor [--fix]` | Lint state across all worktrees |

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--autonomy=gated\|loose\|full` | `gated` | How execution gates on human input |
| `--no-loop` | unset | Disable cross-session `ScheduleWakeup` self-pacing |
| `--no-subagents` | unset | Use `executing-plans` instead of `subagent-driven-development` |
| `--codex=off\|auto\|manual` | from config | Per-task routing between Claude and Codex |
| `--no-codex` | — | Shorthand for `--codex=off` |
| `--archive` | — | (import) Force archive of legacy artifacts after conversion |
| `--keep-legacy` | — | (import) Force leave-in-place of legacy artifacts |
| `--fix` | — | (doctor) Auto-fix safe issues |

## Configuration

Drop a `.superflow.yaml` at your repo root (or `~/.superflow.yaml` for global defaults). Three-tier precedence: CLI flags > repo-local > user-global > built-in defaults.

```yaml
# Default execution autonomy
autonomy: gated  # gated | loose | full

# Cross-session loop scheduling
loop_enabled: true
loop_interval_seconds: 1500
loop_max_per_day: 24

# Subagent execution mode
use_subagents: true

# Doc paths (relative to worktree root)
specs_path: docs/superpowers/specs
plans_path: docs/superpowers/plans

# Worktree base directory for newly-created worktrees
worktree_base: ../

# Branch names that trigger "create new worktree" recommendation
trunk_branches: [main, master, trunk, dev, develop]

# Cruft handling on /superflow import
cruft_policy: ask  # ask | leave | archive | delete
archive_path: legacy/.archive

# /superflow doctor auto-fix policy (overridden by --fix)
doctor_autofix: false

# Codex routing
codex:
  routing: auto              # off | auto | manual
  review_diff_under_full: false
  max_files_for_auto: 3

# External integration refs (NEVER secrets — secrets live in env or MCP config)
integrations:
  github:
    enabled: true
    auto_link_pr_to_plan: true
  linear:
    project: null
  slack:
    blocked_channel: null
```

## Status file (the source of truth)

Every plan has a sibling status file at `docs/superpowers/plans/<slug>-status.md`. It's the **only** thing a future agent needs to resume work — never assume conversational context carries over.

```yaml
---
slug: auth-refactor
status: in-progress      # in-progress | blocked | complete
spec: docs/superpowers/specs/2026-04-15-auth-refactor-design.md
plan: docs/superpowers/plans/2026-04-15-auth-refactor.md
worktree: /home/you/dev/auth-refactor-wt
branch: feat/auth-refactor
started: 2026-04-15
last_activity: 2026-04-22T16:14:00Z
current_task: "Migrate session storage to Redis"
next_action: "Write failing test for Redis session adapter"
autonomy: loose
loop_enabled: true
codex_routing: auto
---

# Auth Refactor — Status

## Activity log
- 2026-04-15T09:00 brainstorm complete, spec at docs/superpowers/specs/2026-04-15-auth-refactor-design.md
- 2026-04-15T09:30 plan written, beginning execution
- 2026-04-15T10:14 task "Add session interface" complete, commit a1b2c3d [inline]
- 2026-04-22T16:14 task "Implement memory session adapter" complete, commit f4e5d6c [codex] (verify: 24 passed)

## Blockers
(empty unless status: blocked)

## Notes
- Decided to keep the legacy session API as a deprecation shim until 2026-06 — see commit a1b2c3d. Followup: schedule removal PR.
```

## Context discipline

`/superflow` references a numbered list of context-discipline rules (CD-1 through CD-10) at high-leverage hook points in the loop:

| ID | Rule |
|---|---|
| CD-1 | Project-local tooling first (Makefile / scripts / CI > ad-hoc commands) |
| CD-2 | User-owned worktree (don't touch unrelated dirty files) |
| CD-3 | Verification before completion (cite real command output) |
| CD-4 | Persistence — work the ladder before escalating |
| CD-5 | Self-service default (execute, don't hand off non-blocking work) |
| CD-6 | Tooling preference order (MCP > skill > project > generic) |
| CD-7 | Durable handoff state (status file is the persistence surface) |
| CD-8 | Command output reporting (relay relevant lines, don't assume the user can see) |
| CD-9 | Concrete-options questions (`AskUserQuestion` with 2–4 options) |
| CD-10 | Severity-first review shape (findings ordered by severity, grounded in path:line) |

Activity log entries cite which CD rule drove a decision (e.g., "applied CD-4 ladder before blocking: tried alt tool, narrowed scope, grep'd prior art"). After long autonomous runs, this gives an auditable paper trail rather than vibes.

## Customizing for your team

Most teams will want a `.superflow.yaml` at the repo root that encodes their conventions:

- Typical autonomy mode for client work vs internal work
- Where worktrees should live (often a sibling directory; sometimes a dedicated worktree base)
- Whether Codex is enabled for this codebase
- Custom cruft policy (some teams keep legacy plans, others archive on import)

The plugin ships with sensible defaults; the YAML is for when you outgrow them.

## Project status

This is a v0.1 release. The orchestration logic is stable and used in real Petabit Scale workflows, but expect the schema and flag surface to evolve as edge cases surface. Breaking changes will be called out in the changelog and gated behind a `--legacy` flag where reasonable.

Issues and PRs welcome.

## Author

Built by [Richard A Steenbergen](https://github.com/rasatpetabit) (`ras@petabitscale.com`). Inspired by the [superpowers](https://github.com/obra/superpowers) plugin's brainstorm/plan/execute pipeline.

## License

MIT — see [LICENSE](./LICENSE).
