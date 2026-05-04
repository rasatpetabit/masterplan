# superpowers-masterplan

A Claude Code plugin that orchestrates a complete development workflow: **brainstorm → plan → execute**, with worktree management, legacy plan import, configurable autonomy, Codex routing, and self-paced cross-session loops.

It's a thin orchestrator over the [superpowers](https://github.com/obra/superpowers) skills — `/masterplan` doesn't reimplement brainstorming, planning, or execution. It sequences them, persists state in a single status file per plan, and adds the connective tissue that makes long-running development work survive across sessions and worktrees.

> **For LLMs working on this codebase:** start with [`CLAUDE.md`](./CLAUDE.md) (always-loaded project orientation, ~500 words) and [`docs/internals.md`](./docs/internals.md) (deep-dive: architecture, dispatch model, status file format, CD rules, operational rules, wave dispatch, failure modes, doctor checks, common dev recipes, anti-patterns; ~6500 words). The orchestrator's "source code" is `commands/masterplan.md`.

## Why this exists

Long-running development work tends to sprawl: a PLAN.md here, a feature branch there, a half-done docs/superpowers/plans/ from a previous session, a Linear ticket nobody's looked at in a week. After a session ends, the context evaporates and the next agent (or human) has to reconstruct what's done and what's left.

`/masterplan` enforces a single source of truth — a status file alongside each plan — that captures: which worktree the work lives in, which branch, which task is current, what's been tried, what's blocked. Resume from anywhere, scan in-progress work across all your worktrees, and lint when something feels off.

Concretely, `/masterplan` delivers:

- **Long-term complex planning that survives sessions.** The status-file-as-source-of-truth invariant means any plan resumes with two reads (plan + status). Worktree, branch, current task, what was tried, what's blocked — all persistent. Sessions end, models change, weeks pass; the plan picks up exactly where it left off.
- **Aggressive context discipline.** Every substantive piece of work goes to a fresh subagent (Haiku for mechanical extraction, Sonnet for general implementation, Opus for ambiguous design, Codex for bounded coding). Only digests come back to the orchestrator. Raw verification output, full diffs, and library docs never bloat the orchestrator's context — that's what makes long autonomous runs viable.
- **Dramatic token reduction** through subagent dispatch + per-invocation caches (`git_state`, `eligibility_cache`) + activity log rotation past 100 entries + Codex review using SHA ranges instead of inlining diffs + mtime-gated file re-reads + ScheduleWakeup'd cross-session resumption that reads only the status file on resume. Every load-bearing optimization is documented in [`docs/internals.md`](./docs/internals.md) §3.
- **Parallelism for faster operation** (v2.0.0+) — read-only tasks (verification, inference, lint, type-check, doc-generation) declared with `**parallel-group:**` annotations dispatch as concurrent waves in Step C step 2. Single-writer status funnel, files-filter, and per-task scope assertions keep the wave safe. Implementation tasks remain serial; Slice β/γ deferred per [Roadmap](#roadmap).
- **Cross-session resume.** `/masterplan execute <status-path>` picks up any plan from any worktree. Bare `/masterplan` lists in-flight plans across all worktrees for pick-and-resume.
- **Cross-model review.** With the optional [`codex`](https://github.com/obra/codex) plugin installed (default on in v2.0.0+), Claude/Sonnet inline work gets reviewed by Codex against the spec — asymmetrically (Codex never reviews its own diffs, no signal there). Codex executes small well-defined tasks; Sonnet handles complex ones; Sonnet reviews Codex output via the existing post-Codex gate. Each model plays to its strengths.

## What you get

`/masterplan` is invoked as `/masterplan <verb> [args] [flags]`. The full verb reference lives in [Verb reference](#verb-reference) below; here's the elevator pitch.

**Phase verbs** — address any pipeline phase directly at the call site:

- **`/masterplan full <topic>`** — kick off a full brainstorm → plan → execute flow. (Same as the bare-topic shortcut `/masterplan <topic>`, which still works.)
- **`/masterplan brainstorm <topic>`** — brainstorm only; halt cleanly after the spec is written.
- **`/masterplan plan <topic>`** — brainstorm + plan; halt cleanly after the plan + status file are written.
- **`/masterplan plan --from-spec=<path>`** — plan only against an existing spec; halts after the plan is written.
- **`/masterplan plan`** *(no args)* — pick from specs that don't yet have a plan, then plan against the chosen spec.
- **`/masterplan execute [<status-path>]`** — resume a specific plan, or list+pick if no path given.

**Operation verbs** — one-shot operations that aren't a pipeline phase:

- **`/masterplan`** *(no args)* — list in-progress plans across all worktrees of the current repo; pick one to resume or start fresh.
- **`/masterplan import`** — discover legacy planning artifacts (PLAN.md, GitHub issues, branches, orphan superpowers plans) and convert them to the unified schema with completion-state inference so already-done work isn't redone.
- **`/masterplan doctor`** — lint state across all worktrees of the current repo.
- **`/masterplan status`** — read-only situation report across all worktrees: in-flight, blocked, stale, recently completed.
- **`/masterplan retro [<slug>]`** — generate a retrospective doc for a completed plan (picks one if no slug given).
- **`/masterplan --resume=<path>`** — alias for `/masterplan execute <path>`.

**Companion surfaces:**

- **`/loop /masterplan ...`** — self-paced cross-session execution; wakes itself every ~25 minutes to advance the plan a few tasks at a time.
- **`masterplan-detect` skill** — auto-suggests `/masterplan import` when legacy planning artifacts are present in the repo. Never auto-runs.

## Design philosophy

Three principles shape every decision in `/masterplan`:

### 1. Thin orchestrator over composable skills

`/masterplan` doesn't reimplement brainstorming, planning, execution, debugging, or branch-finishing. Those live in the [superpowers](https://github.com/obra/superpowers) skills. The slash command's job is to **sequence** them, persist state across phases, and route decisions.

This keeps the command surface small (one markdown file you can hold in your head) and means improvements to the underlying skills compound automatically. When `superpowers:writing-plans` gets sharper, `/masterplan`'s plans get sharper — no changes here.

### 2. Subagent-driven execution with strict context control

This is the most important design goal, and the one that makes long autonomous runs viable.

A multi-task plan run in a single Claude session bloats context fast: failed experiments, big diffs, library docs, verification dumps. By task 10, the orchestrator is reasoning on cluttered, partially-stale state and quality drops. `/masterplan` solves this structurally: **every substantive piece of work goes to a fresh subagent, and only digested results come back to the orchestrator**.

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

## Codex integration

`/masterplan` integrates with the optional [`codex`](https://github.com/obra/codex) plugin to make every plan a two-model collaboration. The integration is asymmetric and bounded: small well-defined coding tasks can delegate to Codex; inline (Sonnet/Claude) work can be cross-reviewed by Codex against the spec. Each model plays to its strengths — no overlap, no self-review.

### Why use Codex with /masterplan

Cross-model review catches blind spots that single-model review misses — Sonnet's preferred patterns and Codex's preferred patterns don't perfectly overlap. The asymmetry is deliberate: Codex never reviews its own diffs (no signal there), but it DOES review Sonnet/Claude inline work against the spec, and Sonnet reviews Codex output via the existing post-Codex `AskUserQuestion` gate. Codex is also a fast bounded executor for tasks tagged ≤3 files, unambiguous, with known verification commands and no design judgment — exactly the work that Sonnet finds tedious.

### Defaults in v2.0.0

```yaml
codex:
  routing: auto    # eligible tasks auto-delegate to Codex
  review:  on      # every inline-completed task gets reviewed by Codex against the spec
```

Both default-on. If the codex plugin isn't installed, `/masterplan` detects this at Step 0 and auto-degrades both to `off` for the run with a one-line warning. **Persisted config is unchanged** — re-installing codex restores configured behavior. Doctor check #18 surfaces the persistent misconfiguration as a Warning during lint.

### How it works

1. **Eligibility cache (Step C step 1).** A Haiku scans the plan and computes per-task routing eligibility against a checklist (≤3 files, unambiguous task description, known verification, no scope-out, no `**Codex:** no` annotation). Caches to `<slug>-eligibility-cache.json`.
2. **Per-task routing (Step C 3a).** Under `auto`: eligible tasks dispatch via `codex:codex-rescue` (EXEC mode); ineligible run inline. Under `manual`: ask the user per task. Under `off`: never delegate.
3. **Codex review (Step C 4b).** When `review: on`, after a task completes inline, Codex reviews the diff `<task_start_sha>..HEAD` against the spec excerpt. Severity-bucketed findings (high/medium/low). Auto-accept under `gated` autonomy below severity `medium` (configurable via `codex.review_prompt_at`); higher severity prompts.
4. **Plan annotations override the heuristic.** A planner can mark a task `**Codex:** ok` to force eligible (delegate even if heuristic rejects), or `**Codex:** no` to force ineligible. See [Plan annotations](#plan-annotations).

### Install Codex

In a Claude Code session:

```
/plugin marketplace add obra/codex
/plugin install codex@obra-codex
/reload-plugins
```

Verify: `/plugin` should list `codex` under **Installed**. Re-invoke `/masterplan` — Step 0's availability check now passes; routing + review fire per config.

### Disabling Codex

Per-run override:
- `--no-codex` (or `--codex=off`)
- `--no-codex-review` (or `--codex-review=off`)

Persistent override in `.masterplan.yaml`:
```yaml
codex:
  routing: off
  review:  off
```

### Cross-references

- [Configuration](#configuration) — full `codex:` config block schema with all keys
- [Useful flag combinations](#useful-flag-combinations) — `--codex=` / `--codex-review=` patterns for common workflows
- [Plan annotations](#plan-annotations) — `**Codex:** ok|no` per-task override syntax
- [`docs/internals.md`](./docs/internals.md) §Codex integration — implementation deep-dive (eligibility cache schema, dispatch model, asymmetric-review rationale)

## Install

### Option A — Claude Code plugin marketplace (recommended)

In a Claude Code session:

```
/plugin marketplace add rasatpetabit/superpowers-masterplan
/plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan
/reload-plugins
```

Verify with `/plugin` — `superpowers-masterplan` should appear under **Installed**. If the install command above doesn't match (Claude Code's plugin syntax has been iterating), the safe fallback is to run `/plugin marketplace add rasatpetabit/superpowers-masterplan` and then pick `superpowers-masterplan` from `/plugin`'s interactive Discover tab.

### Option B — manual

Drop the slash command into your user commands directory:

```bash
mkdir -p ~/.claude/commands ~/.claude/skills
cp commands/masterplan.md ~/.claude/commands/
cp -r skills/masterplan-detect ~/.claude/skills/
```

### Option C — opt into per-turn telemetry (optional)

`/masterplan` can capture per-turn context-usage signals to `<plan>-telemetry.jsonl` via a Stop hook. The orchestrator also writes inline snapshots at every Step C entry, so the hook is optional — but the hook gives you per-turn cadence whereas inline snapshots only fire on resume.

```bash
mkdir -p ~/.claude/hooks
cp hooks/masterplan-telemetry.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/masterplan-telemetry.sh
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
            "command": "bash \"$HOME/.claude/hooks/masterplan-telemetry.sh\"",
            "timeout": 3,
            "async": true
          }
        ]
      }
    ]
  }
}
```

The hook is **defensive** — it bails silently in any session that isn't operating on a `/masterplan`-managed plan, so it's safe as a global Stop hook. Per-plan opt-out: add `telemetry: off` to a status file's frontmatter. Global opt-out: set `telemetry.enabled: false` in `.masterplan.yaml`. Field shape and `jq` queries: see [`docs/design/telemetry-signals.md`](./docs/design/telemetry-signals.md).

> Tested on Linux. The hook calls `find`, `stat`, and `date` with portable flags that should also work on macOS BSD utilities, but the macOS path hasn't been smoke-tested. If telemetry doesn't land for you on macOS, please [open an issue](https://github.com/rasatpetabit/superpowers-masterplan/issues).

### Dependencies

- **Required:** [`superpowers`](https://github.com/obra/superpowers) — `/masterplan` delegates to its `brainstorming`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `using-git-worktrees`, `systematic-debugging`, and `finishing-a-development-branch` skills.
- **Optional:** `codex` plugin (only needed if `codex_routing` is `auto` or `manual`) — provides the `codex:codex-rescue` subagent.
- **Optional:** `context7` MCP server — used by the CD-4 ladder for library documentation lookups.
- **Optional:** `gh` CLI — required for `/masterplan import` of GitHub issues and PRs.

## Quick start

### Start a new feature

```
/masterplan full Stripe webhook handler
```

Walks you through brainstorming (interactive), produces a spec at `docs/superpowers/specs/`, generates a plan at `docs/superpowers/plans/`, then executes task-by-task with subagents.

The bare-topic shortcut (`/masterplan Stripe webhook handler`) still works — `full` is the explicit form for the same flow.

### Brainstorm or plan only — without executing

When you want to think a feature through without committing to execution yet:

```
/masterplan brainstorm Stripe webhook handler   # halts after spec is written
/masterplan plan Stripe webhook handler         # halts after plan is written
/masterplan plan --from-spec=docs/superpowers/specs/2026-05-02-webhooks-design.md
/masterplan plan                                # picks from specs that have no plan yet
```

When you're ready to ship the planned work, `/masterplan execute <status-path>` (or the listing form below) picks it back up.

### Long autonomous run

```
/loop /masterplan full refactor auth middleware --autonomy=loose
```

Same flow, but execution runs autonomously with `ScheduleWakeup`-paced resumption. Stops on blockers (which get recorded in the status file's `## Blockers` section).

> Note: `/loop /masterplan brainstorm <topic>` or `/loop /masterplan plan <topic>` will warn you at Step 0 — those verbs halt before execution, so a loop has nothing to advance. `--no-loop` is recommended in that case.

### Resume in-progress work

```
/masterplan                                                          # lists in-progress plans across worktrees
/masterplan execute docs/superpowers/plans/2026-04-15-auth-status.md # explicit verb
/masterplan --resume=docs/superpowers/plans/2026-04-15-auth-status.md # back-compat alias
```

### Migrate legacy plans

```
/masterplan import
```

Scans for PLAN.md, TODO.md, ROADMAP.md, docs/plans/*.md, GitHub issues, draft PRs, open feature branches, and orphan superpowers plans. Pick which to import, get them rewritten in the canonical format with completion inference, and start executing.

### Audit your state

```
/masterplan doctor          # lint across all worktrees
/masterplan doctor --fix    # auto-fix safe issues
```

### Situation report

```
/masterplan status                  # what's in flight, blocked, stale across all worktrees
/masterplan status --plan=<slug>    # deep view of one plan
```

Read-only synthesis: status frontmatter + last activity entries + blockers/notes + retro index + telemetry trends + recent commits. Useful as a daily SITREP before deciding what to pick back up.

### Generate a retrospective

```
/masterplan retro                   # picks a completed plan that doesn't yet have a retro
/masterplan retro auth-refactor     # targets a specific slug
```

Reads the plan + status + spec + git log + PR (if `gh` is available), then writes `docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md` with outcomes, blockers, deviations, follow-ups, and Codex routing observations. Offers to `/schedule` time-bounded follow-ups one at a time.

## Verb reference

### Phase + operation verbs

| Verb | Effect | Halts at |
|---|---|---|
| `full <topic>` | Kickoff: brainstorm + plan + execute | (runs through) |
| `brainstorm <topic>` | Brainstorm only | spec written |
| `plan <topic>` | Brainstorm + plan | plan written |
| `plan --from-spec=<path>` | Plan only against an existing spec | plan written |
| `plan` (no args) | Pick from specs that have no plan yet, then plan against the chosen spec | plan written |
| `execute [<status-path>]` | Resume a specific plan, or list+pick if no path given | (runs through) |
| `import [...]` | Discover legacy planning artifacts and convert them (see Aliases and shortcuts below for the per-source flags) | n/a |
| `doctor [--fix]` | Lint state across all worktrees of the current repo | n/a |
| `status [--plan=<slug>]` | Read-only situation report across all worktrees: in-flight, blocked, stale, recently completed, telemetry signals, recent design notes. `--plan=<slug>` drills into one plan's blockers/notes/activity/telemetry. | n/a |
| `retro [<slug>]` | Generate a retrospective doc for a completed plan (picks one if no slug given) | n/a |

> Topics literally named after a verb (`full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`) need to be prefixed with another word — e.g. `/masterplan add brainstorm session timer` works because `add` isn't a verb.

### Aliases and shortcuts

| Invocation | Equivalent to |
|---|---|
| `/masterplan` *(no args)* | `/masterplan execute` (list + pick across worktrees) |
| `/masterplan <topic>` | `/masterplan full <topic>` (bare-topic shortcut for kickoff) |
| `/masterplan --resume=<status-path>` | `/masterplan execute <status-path>` |
| `/masterplan import --pr=<num>` | Import directly from a single GitHub PR (skips discovery) |
| `/masterplan import --issue=<num>` | Import directly from a single GitHub issue (skips discovery) |
| `/masterplan import --file=<path>` | Import directly from a single local file (skips discovery) |
| `/masterplan import --branch=<name>` | Reverse-engineer a spec/plan from a single branch's history (skips discovery) |

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
| `/masterplan <topic>` | Default: `--autonomy=gated`, codex routing from config (default `auto`), Codex review (default `on` since v2.0.0). Per-task `(continue / skip / stop)` gate; auto-routing decisions execute silently (no per-task Codex confirmation prompt — set `codex.confirm_auto_routing: true` for the legacy chatty behavior). If the codex plugin isn't installed, both `routing` and `review` auto-degrade to `off` for the run with a one-line warning at Step 0. |
| `/loop /masterplan <topic> --autonomy=loose` | Long autonomous run with no per-task gating; ScheduleWakeup paces it across sessions; stops only on blockers. |
| `/loop /masterplan <topic> --autonomy=loose --codex-review=on` | Same long run, but Codex reviews each inline (Claude/Sonnet) task's diff before it counts as done. Under `loose`: low/clean → silent accept; medium → `## Notes`; high → block. (Same behavior under `gated` for non-prompting severities — auto-accepted silently below `codex.review_prompt_at`, default `medium`.) |
| `/masterplan <topic> --codex=auto --codex-review=on` | Codex executes simple well-defined tasks; Codex reviews the inline (complex) ones. Each model plays to its strengths, no overlap (no self-review). |
| `/masterplan <topic> --codex=manual --codex-review=on` | User gets asked per task whether to delegate execution to Codex. Tasks that stay inline are reviewed by Codex afterward. |
| `/masterplan <topic> --codex=off` | Claude does everything; no Codex involvement. Review is automatically disabled too (a routing-off plan never invokes Codex, even for review). |
| `/masterplan <topic> --autonomy=full --codex-review=on` | Maximum autonomy with adversarial review as the safety rail — high-severity findings trigger one auto-fix retry, then block. |
| `/masterplan <topic> --no-parallelism` | *(v2.0.0+)* Force serial execution of all tasks regardless of `**parallel-group:**` annotations. Useful for debugging wave-dispatch issues, or when running on a system where parallel `Agent` dispatch is rate-limited. Persisted to status file as `parallelism: off`. |

CLI flags always override config for the run, and the resolved values land in the status file so resumes are deterministic.

### Auto-compact pairing

Long-running plans benefit from periodic context compaction in a sibling session. `/masterplan` can't auto-start a `/loop` for you (slash commands are user-typed), but it surfaces a one-line passive notice once per plan recommending the canonical pairing:

```
/loop 30m /compact focus on current task + active plan; drop tool output and old reasoning
```

Run that in a separate Claude Code shell or session alongside your `/masterplan` workflow. CronCreate-backed `/loop` and `/masterplan`'s ScheduleWakeup-backed wakeups occupy different slots and don't conflict. Configure interval and focus prompt in `.masterplan.yaml` under `auto_compact:`. Silence the notice with `auto_compact.enabled: false`.

## Configuration

Drop a `.masterplan.yaml` at your repo root (or `~/.masterplan.yaml` for global defaults). Four-tier precedence: CLI flags > repo-local > user-global > built-in defaults.

### Defaults at a glance

Quick reference of every default. Override any of these in `.masterplan.yaml` (per-repo) or `~/.masterplan.yaml` (per-user). Schema with explanations follows below.

```yaml
autonomy: gated                          # gated | loose | full

loop_enabled: true                       # cross-session ScheduleWakeup pacing
loop_interval_seconds: 1500              # 25 min
loop_max_per_day: 24

use_subagents: true                      # subagent-driven-development vs executing-plans

specs_path: docs/superpowers/specs
plans_path: docs/superpowers/plans
worktree_base: ../                       # often customized per team
trunk_branches: [main, master, trunk, dev, develop]

cruft_policy: ask                        # ask | leave | archive | delete (for /masterplan import)
archive_path: legacy/.archive

doctor_autofix: false                    # --fix flag overrides

codex:
  routing: auto                          # off | auto | manual (default on since v2.0.0)
  review: on                             # off | on (default on since v2.0.0; auto-degrade if codex plugin missing)
  review_diff_under_full: false
  max_files_for_auto: 3                  # eligibility heuristic threshold
  review_max_fix_iterations: 2
  confirm_auto_routing: false            # under gated, prompt per-task to confirm auto-routing (default off: silent)
  review_prompt_at: medium               # under gated: low | medium | high | never severity threshold

parallelism:                             # v2.0.0+
  enabled: true                          # global kill switch (--no-parallelism overrides)
  max_wave_size: 5                       # cap on concurrent Agent dispatches per wave
  abort_wave_on_protocol_violation: true # suppress 4d batch on any protocol_violation

gated_switch_offer_at_tasks: 15          # v2.1.0+: under autonomy=gated, offer switch to loose
                                         # when plan task count ≥ this. Set to 0 to disable the offer.

auto_compact:
  enabled: true                          # nudge user to /loop /compact in a sibling session
  interval: 30m
  focus: "focus on current task + active plan; drop tool output and old reasoning"

telemetry:
  enabled: true                          # per-turn JSONL records via Stop hook + inline snapshots
  path_suffix: -telemetry.jsonl

integrations:
  github:
    enabled: true                        # auto-detected via gh auth status if unset
    auto_link_pr_to_plan: true
  linear:
    project: null                        # set to a Linear project id to enable
  slack:
    blocked_channel: null                # post blocker notifications to this channel
```

CLI flags always override config for the run; resolved values land in the status file so resumes are deterministic. See [Useful flag combinations](#useful-flag-combinations) for common patterns.

### Full schema (with explanations)

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

# Cruft handling on /masterplan import
cruft_policy: ask  # ask | leave | archive | delete
archive_path: legacy/.archive

# /masterplan doctor auto-fix policy (overridden by --fix)
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

# Per-turn context telemetry — captured by hooks/masterplan-telemetry.sh
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

Tasks in `/masterplan`-generated plans can carry an optional `**Codex:**` annotation that overrides the eligibility heuristic for Codex routing:

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
| `**parallel-group:** <name>` *(v2.0.0+)* | Tasks sharing the same `<name>` dispatch as one parallel wave in Step C step 2. Read-only verification, inference, lint, type-check, doc-generation only. Mutually exclusive with `**Codex:** ok`. Requires complete `**Files:**` block (becomes exhaustive scope under wave). See [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md) for the failure-mode catalog and Slice β/γ deferral. |
| `**non-committing: true**` *(v2.0.0+)* | Optional override for `**parallel-group:**` eligibility rule 3 — declares a task non-committing even if its `**Files:**` block lists tracked paths. Use when a task writes to a tracked path but doesn't intend to commit (rare). |
| (no annotation) | fall through to the heuristic checklist; `annotated: null`; not parallel-eligible |

Plans authored via `/masterplan`'s Step B2 get this guidance baked into the `writing-plans` brief: the planner adds `**Codex:** ok` for obviously well-bounded tasks (≤ 3 files, unambiguous, known verification), `**Codex:** no` for tasks that require broader context, and `**parallel-group:**` for mutually-independent verification/inference/lint/type-check/doc-generation tasks (v2.0.0+). Plans without annotations behave exactly as before — annotations are an aid, never required.

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
# Optional v2.1.0+: gated_switch_offer_dismissed: true  # permanent per-plan suppression of gated→loose offer
# Optional v2.1.0+: gated_switch_offer_shown: true      # per-session suppression (re-fires on cross-session resume)
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

`/masterplan` references a numbered list of context-discipline rules (CD-1 through CD-10) at high-leverage hook points in the loop:

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

Most teams will want a `.masterplan.yaml` at the repo root that encodes their conventions:

- Typical autonomy mode for client work vs internal work
- Where worktrees should live (often a sibling directory; sometimes a dedicated worktree base)
- Whether Codex is enabled for this codebase
- Custom cruft policy (some teams keep legacy plans, others archive on import)

The plugin ships with sensible defaults; the YAML is for when you outgrow them.

## Releases since v1.0.0

- **v1.0.0 — first stable public release.** Consolidated retrospective generation into the `retro` verb; standardized terminology on "verbs"; pre-release audit fix pass (10 blockers + 13 polish items).
- **v2.0.0 — intra-plan parallelism Slice α + Codex defaults on.** Slice α of intra-plan parallelism ships: read-only parallel waves via `**parallel-group:**` annotation in Step C step 2 (verification, inference, lint, type-check, doc-generation only). Codex defaults flipped: `routing: auto` + `review: on` (auto-degrades when codex plugin not installed; new doctor check #18 surfaces persistent misconfiguration). New `## Codex integration` README section. Internal docs for LLM contributors: `CLAUDE.md` + `docs/internals.md`. Slice β/γ of intra-plan parallelism (parallel committing tasks, full per-task worktree subsystem) deferred with sharpened, measurable revisit trigger in [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md).
- **v2.1.0 — README polish + gated→loose switch offer + Roadmap section.** Benefits paragraph + "Defaults at a glance" YAML block + "Roadmap" section. One-time AskUserQuestion at Step C step 1 offering to switch from `--autonomy=gated` to `--autonomy=loose` when a long plan (≥15 tasks by default) is in progress.

All releases preserve the three design pillars (thin orchestrator, subagent + context-control, status file as only source of truth). See [CHANGELOG.md](./CHANGELOG.md) for the full breakdown.

## Project status

This is a stable public release (current: **v2.1.0**). The orchestration logic has been used in real Petabit Scale workflows and is stable. v2.0.0 shipped Slice α of intra-plan task parallelism (read-only parallel waves), Codex defaults flipped to on with graceful-degrade, the `## Codex integration` README section, and internal docs (`CLAUDE.md` + `docs/internals.md`) for future LLM contributors. v2.1.0 added the gated→loose switch offer for long plans plus README polish + a Roadmap section.

Schema and flag surface continue to evolve under semver — additive changes and bug fixes land in v2.x; breaking changes (schema/flag/CLI) are called out in the changelog with explicit migration notes. Slice β/γ of intra-plan parallelism (parallel committing tasks) remain deferred with a measurable revisit trigger.

Issues and PRs welcome.

## Roadmap

What's deliberately deferred — and the conditions under which we'd revisit. Framed as "what we've decided NOT to ship yet, and why" so users can see the design trade-offs explicitly.

### Slice β — parallel committing-task waves (~8-10d estimated)

Wave members do work concurrently but the commit step is funneled serially through the orchestrator. Latency win is partial — work parallelizes, commits serialize. **Revisit trigger:** when a real `/masterplan` plan shows ≥3 parallel-grouped *committing* tasks where the wave's serial wall-clock cost exceeds 10 minutes AND the committed work is independent enough for the Slice α `**Files:**` exhaustive-scope rule to apply. Telemetry-derived: see [`docs/design/telemetry-signals.md`](./docs/design/telemetry-signals.md) "Average tasks-per-wave-turn" jq query for the data.

### Slice γ — full per-task git worktree subsystem (~10-15d estimated)

Each parallel implementation task dispatches into its own temp worktree; merge commits back to canonical branch at wave-end (fast-forward when possible, conflict-abort otherwise per CD-2). Real parallel committing-task execution. The original deferred design's full ambition. **Revisit trigger:** when ≥3 β-eligible waves accumulate within a single plan's lifecycle, indicating a structural pattern that warrants the full subsystem.

### Doctor check for the Slice β/γ revisit trigger

Telemetry-derived doctor check that scans completed-and-recent plans for the trigger condition above and surfaces a one-line note in `/masterplan status`. Lets the trigger fire automatically rather than relying on the user noticing.

### Codex CLI/API concurrency model verification

FM-4's mitigation (Codex-routed tasks fall out of waves) is conservative because Codex's actual concurrency model is unverified. If `codex:codex-rescue` agents run truly concurrent without resource-pool constraints, FM-4 weakens substantially and a future slice could reconsider. Worth verifying via the `codex:setup` skill before designing a slice that depends on this.

### Canned `$ARGUMENTS` self-test specs for routing-table drift detection

`/masterplan` has no automated test suite — the orchestrator is markdown, behavior emerges from a live agent reading it. Adding canned `$ARGUMENTS` strings (one per verb branch) that exercise every routing path would catch routing-table drift early. Spec lives in `docs/superpowers/specs/`; runs as part of the v2.x release verification.

### macOS hook smoke verification

`hooks/masterplan-telemetry.sh` is portable-by-construction (no GNU-only flags introduced in the v2.0.0 wave_groups extraction; uses portable `head -n1` + `stat -c '%Y' || stat -f '%m'` dual form). Linux smoke-tested only. Worth running the same fixture-based smoke test on macOS to confirm.

### Documented non-features (people often ask for these)

- **Auto-detection of "obvious" parallel patterns without `**parallel-group:**` annotation** — annotations are explicit by design. Inference invites surprise. The planner's job (per Step B2 brief) is to identify and annotate parallel-friendly task patterns.
- **Plan-task reordering to maximize wave size** — plan-order is authoritative. The wave-assembly walk is contiguous-only. If parallel-grouped tasks are interleaved with serial tasks, none parallelize. The planner handles ordering.
- **Cross-worktree wave dispatch** — single-worktree, single-branch only. Cross-worktree parallelism would need a different concurrency model.

## Author

Built by [Richard A Steenbergen](https://github.com/rasatpetabit) (`ras@petabitscale.com`). Inspired by the [superpowers](https://github.com/obra/superpowers) plugin's brainstorm/plan/execute pipeline.

## License

MIT — see [LICENSE](./LICENSE).
