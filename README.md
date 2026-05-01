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

## Design philosophy

Three principles shape every decision in `/superflow`:

### 1. Thin orchestrator over composable skills

`/superflow` doesn't reimplement brainstorming, planning, execution, debugging, or branch-finishing. Those live in the [superpowers](https://github.com/obra/superpowers) skills. The slash command's job is to **sequence** them, persist state across phases, and route decisions.

This keeps the command surface small (one markdown file you can hold in your head) and means improvements to the underlying skills compound automatically. When `superpowers:writing-plans` gets sharper, `/superflow`'s plans get sharper — no changes here.

### 2. Subagent-driven execution with strict context control

This is the most important design goal, and the one that makes long autonomous runs viable.

A multi-task plan run in a single Claude session bloats context fast: failed experiments, big diffs, library docs, verification dumps. By task 10, the orchestrator is reasoning on cluttered, partially-stale state and quality drops. `/superflow` solves this structurally: **every substantive piece of work goes to a fresh subagent, and only digested results come back to the orchestrator**.

The dispatch model:

| Phase | Model | Why |
|---|---|---|
| Discovery scans (Step I1) | Haiku | Mechanical extraction, parallel, bounded |
| Per-task implementation | Sonnet | The default workhorse, via `superpowers:subagent-driven-development` |
| Conversion / rewriting | Sonnet | Generation, not just extraction |
| Architecture, ambiguous specs | Opus | Reserved for tasks that genuinely need deep reasoning |
| Small well-defined coding tasks | Codex | Per the routing toggle, via `codex:codex-rescue` |
| Asymmetric review of inline work | Codex (review mode) | When `codex_review: on`, fresh-eyes review of Sonnet/Claude diffs against the spec |
| Completion inference | Haiku | One per task chunk, parallel, bounded |

Every subagent gets a **bounded brief**: explicit goal, inputs, allowed scope, constraints, return shape. It doesn't inherit session history, and the orchestrator doesn't see its raw output — just a digest.

Activity log entries illustrate the digest pattern:
```
2026-04-22T16:14 task "Implement memory session adapter" complete, commit f4e5d6c [codex] (verify: 24 passed)
```
Enough to reconstruct state. Nothing more.

This is what makes ScheduleWakeup'ing into a fresh session every ~3 tasks lossless. The status file is the bridge; the orchestrator's mid-session context is disposable.

### 3. Status file is the only source of truth

A future agent (or future-you, three weeks later) should resume any plan with exactly two reads: the plan file and its sibling status file. Conversation context is discarded by design.

The status file holds worktree path + branch (resume relocates if needed), current task, next action, append-only activity log with CD-rule citations and routing tags, blockers section with CD-4 ladder evidence, and notes for non-obvious decisions. See [Status file](#status-file-the-source-of-truth) below for the full schema.

If you can answer "where did this work get to and what's next?" by reading the status file alone, the design is working.

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

### Option C — opt into per-turn telemetry (optional)

`/superflow` can capture per-turn context-usage signals to `<plan>-telemetry.jsonl` via a Stop hook. The orchestrator also writes inline snapshots at every Step C entry, so the hook is optional — but the hook gives you per-turn cadence whereas inline snapshots only fire on resume.

```bash
mkdir -p ~/.claude/hooks
cp hooks/superflow-telemetry.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/superflow-telemetry.sh
```

Add this fragment to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/.claude/hooks/superflow-telemetry.sh\"",
            "timeout": 3,
            "async": true
          }
        ]
      }
    ]
  }
}
```

The hook is **defensive** — it bails silently in any session that isn't operating on a `/superflow`-managed plan, so it's safe as a global Stop hook. Per-plan opt-out: add `telemetry: off` to a status file's frontmatter. Global opt-out: set `telemetry.enabled: false` in `.superflow.yaml`. Field shape and `jq` queries: see [`docs/design/telemetry-signals.md`](./docs/design/telemetry-signals.md).

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

### Situation report

```
/superflow status                  # what's in flight, blocked, stale across all worktrees
/superflow status --plan=<slug>    # deep view of one plan
```

Read-only synthesis: status frontmatter + last activity entries + blockers/notes + retro index + telemetry trends + recent commits. Useful as a daily SITREP before deciding what to pick back up.

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
| `/superflow status [--plan=<slug>]` | Read-only situation report across all worktrees: in-flight, blocked, stale, recently completed, telemetry signals, recent design notes. `--plan=<slug>` drills into one plan's blockers/notes/activity/telemetry. |

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--autonomy=gated\|loose\|full` | `gated` | How execution gates on human input |
| `--resume=<status-path>` | — | Resume a specific plan from its sibling status file; skips Step A/B |
| `--no-loop` | unset | Disable cross-session `ScheduleWakeup` self-pacing |
| `--no-subagents` | unset | Use `executing-plans` instead of `subagent-driven-development` |
| `--codex=off\|auto\|manual` | from config | Per-task routing between Claude and Codex |
| `--no-codex` | — | Shorthand for `--codex=off` (also disables review) |
| `--codex-review=on\|off` | from config | When on, Codex reviews diffs from inline-completed tasks before they're marked done |
| `--codex-review` | — | Shorthand for `--codex-review=on` |
| `--archive` | — | (import) Force archive of legacy artifacts after conversion |
| `--keep-legacy` | — | (import) Force leave-in-place of legacy artifacts |
| `--fix` | — | (doctor) Auto-fix safe issues |

## Useful flag combinations

The autonomy and codex flags are designed to compose. Common pairs:

| Combination | Behavior |
|---|---|
| `/superflow <topic>` | Default: `--autonomy=gated`, codex routing from config (default `auto`), no review. Per-task `(continue / skip / stop)` gate; auto-routing decisions execute silently (no per-task Codex confirmation prompt — set `codex.confirm_auto_routing: true` for the legacy chatty behavior). |
| `/loop /superflow <topic> --autonomy=loose` | Long autonomous run with no per-task gating; ScheduleWakeup paces it across sessions; stops only on blockers. |
| `/loop /superflow <topic> --autonomy=loose --codex-review=on` | Same long run, but Codex reviews each inline (Claude/Sonnet) task's diff before it counts as done. Under `loose`: low/clean → silent accept; medium → `## Notes`; high → block. (Same behavior under `gated` for non-prompting severities — auto-accepted silently below `codex.review_prompt_at`, default `medium`.) |
| `/superflow <topic> --codex=auto --codex-review=on` | Codex executes simple well-defined tasks; Codex reviews the inline (complex) ones. Each model plays to its strengths, no overlap (no self-review). |
| `/superflow <topic> --codex=manual --codex-review=on` | User gets asked per task whether to delegate execution to Codex. Tasks that stay inline are reviewed by Codex afterward. |
| `/superflow <topic> --codex=off` | Claude does everything; no Codex involvement. Review is automatically disabled too (a routing-off plan never invokes Codex, even for review). |
| `/superflow <topic> --autonomy=full --codex-review=on` | Maximum autonomy with adversarial review as the safety rail — high-severity findings trigger one auto-fix retry, then block. |

CLI flags always override config for the run, and the resolved values land in the status file so resumes are deterministic.

### Auto-compact pairing

Long-running plans benefit from periodic context compaction in a sibling session. `/superflow` can't auto-start a `/loop` for you (slash commands are user-typed), but it surfaces a one-line passive notice once per plan recommending the canonical pairing:

```
/loop 30m /compact focus on current task + active plan; drop tool output and old reasoning
```

Run that in a separate Claude Code shell or session alongside your `/superflow` workflow. CronCreate-backed `/loop` and `/superflow`'s ScheduleWakeup-backed wakeups occupy different slots and don't conflict. Configure interval and focus prompt in `.superflow.yaml` under `auto_compact:`. Silence the notice with `auto_compact.enabled: false`.

## Configuration

Drop a `.superflow.yaml` at your repo root (or `~/.superflow.yaml` for global defaults). Four-tier precedence: CLI flags > repo-local > user-global > built-in defaults.

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

# Codex routing + review
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: off                # off | on — Codex reviews diffs from inline-completed tasks
  review_diff_under_full: false
  max_files_for_auto: 3
  review_max_fix_iterations: 2
  confirm_auto_routing: false  # under `gated`, prompt per-task to confirm auto-routing
                               # default false: honor eligibility cache silently
                               # set true to restore legacy expanded prompt
  review_prompt_at: medium   # under `gated`, severity threshold at which review findings prompt
                             # low | medium | high | never (default medium)

# Auto-compact loop nudge — once-per-plan passive notice recommending
# /loop /compact in a sibling session for context compaction
auto_compact:
  enabled: true
  interval: 30m
  focus: "focus on current task + active plan; drop tool output and old reasoning"

# Per-turn context telemetry — captured by hooks/superflow-telemetry.sh
# (Stop hook, manually installed) and Step C inline snapshots.
# Per-plan opt-out: add `telemetry: off` to status frontmatter.
telemetry:
  enabled: true
  path_suffix: -telemetry.jsonl

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

## Plan annotations

Tasks in `/superflow`-generated plans can carry an optional `**Codex:**` annotation that overrides the eligibility heuristic for Codex routing:

```markdown
### Task 3: Add memory adapter

**Files:**
- Create: `src/memory/adapter.py`
- Test: `tests/memory/test_adapter.py`

**Codex:** ok    # eligible for Codex auto-delegation under codex_routing=auto
```

| Annotation | Effect on eligibility cache |
|---|---|
| `**Codex:** ok` | `eligible: true`, `annotated: "ok"` — delegate even if the heuristic would reject |
| `**Codex:** no` | `eligible: false`, `annotated: "no"` — never delegate |
| (no annotation) | fall through to the heuristic checklist; `annotated: null` |

Plans authored via `/superflow`'s Step B2 get this guidance baked into the `writing-plans` brief: the planner adds `**Codex:** ok` for obviously well-bounded tasks (≤ 3 files, unambiguous, known verification) and `**Codex:** no` for tasks that require broader context. Plans without annotations behave exactly as before — annotations are an aid, never required.

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
codex_review: on
compact_loop_recommended: true
# Optional: telemetry: off  # silences per-plan telemetry capture
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

## Recent improvements (post-v0.1)

Two follow-up passes have landed since the initial release, both focused on making long autonomous runs cheaper to operate:

- **Speed — increased parallelism.** Step A frontmatter parsing, Step B0 git surveys, Step C step 1 re-reads, Step C 4a verification commands, Step I3 import (source-fetch wave + conversion wave), and Step D doctor checks now dispatch in parallel wherever the work is genuinely independent. New per-invocation caches (`git_state` for worktrees/branches, `eligibility_cache` for Codex routing) avoid redundant subagent dispatches and subprocess calls within a run.
- **Context use — tighter prompt + smarter re-reads.** Orchestrator prompt trimmed of duplication (CD-rule restatements collapsed, operational rules de-duplicated against inline Step content, design notes relocated to `docs/design/`). Codex review brief now passes a `<task-start SHA>..HEAD` range instead of inlining full diffs (saves thousands of tokens per review on multi-file tasks). Activity logs in long-running plans rotate to a sibling archive when they exceed 100 entries (keeps last 50 inline). In-session mtime gating skips re-reads of unchanged spec/plan files within the same session.

Both passes preserve the three design pillars (thin orchestrator, subagent + context-control, status file as only source of truth) and don't add user-facing flags. See [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]` for the full breakdown.

## Project status

This is a v0.2 release. The orchestration logic is stable and used in real Petabit Scale workflows. v0.2 lands the first behavior-changing pass since v0.1: gated mode no longer prompts on pre-configured Codex automation by default (see CHANGELOG `[0.2.0]`). Expect the schema and flag surface to keep evolving; breaking changes are called out in the changelog and gated behind a `--legacy` flag where reasonable.

Issues and PRs welcome.

## Author

Built by [Richard A Steenbergen](https://github.com/rasatpetabit) (`ras@petabitscale.com`). Inspired by the [superpowers](https://github.com/obra/superpowers) plugin's brainstorm/plan/execute pipeline.

## License

MIT — see [LICENSE](./LICENSE).
