# superpowers-masterplan

**Masterplan** — a Claude Code plugin (built on
[`obra/superpowers`](https://github.com/obra/superpowers)) for long-term
brainstorm → plan → execute workflows that survive session boundaries and stay
on track for multi-week projects.

> **For LLMs working on this repo:** start with [`CLAUDE.md`](./CLAUDE.md),
> then use [`docs/internals.md`](./docs/internals.md) for architecture,
> dispatch model, status schema, CD rules, doctor checks, recipes, and
> contributor pitfalls. The orchestrator source is
> [`commands/masterplan.md`](./commands/masterplan.md).

## Key benefits

### Long-term planning consistency

- Every plan writes to a well-defined status file that's the single source of
  truth — current task, next action, full activity log — in YAML frontmatter +
  markdown. `/masterplan` will find existing plans and documentation and bring
  them into conformity with the masterplan format.
- Resume any in-flight work with two file reads (plan + status). No
  conversation context required, no compaction loss, no "what was I doing
  again?"
- Survives `/compact`, fresh sessions, and handoff between agents — pass a
  plan to Codex or another Claude session and they pick up exactly where the
  last one stopped.
- Each plan runs in its own git worktree on its own branch, so parallel plans
  don't collide.

### Token efficiency

- The orchestrator never does substantive work itself — it dispatches to
  bounded subagents whose context never bleeds back into the orchestrator's
  window.
- Explicit model routing per task type: Haiku for mechanical extraction
  (status parsing, log scraping, file enumeration), Sonnet for general
  implementation, Opus reserved for genuine deep reasoning.
- Wave dispatch runs independent tasks in parallel subagents, each with
  isolated context, returning only digested results.
- Orchestrator context stays clean for sequencing decisions — no raw file
  contents, no verification dumps, no transcript noise.

### Cross-checking via Codex

- Optional cross-model review on every commit — catches what same-family
  review misses. Claude reviewing Claude has blind spots that GPT-5 doesn't
  share, and vice versa.
- Codex routing for bounded, well-defined tasks hands subtasks to the model
  best suited to them, not just whichever one is loaded.
- Graceful degrade: if the Codex plugin isn't installed, runs Claude-only
  with a one-line warning. Never fails a run on a missing optional dependency.

Deep design rationale lives in [`docs/internals.md`](./docs/internals.md).

## Subagent dispatch model

The most important design decision: **every substantive piece of work goes
to a fresh subagent, and only digested results come back to the
orchestrator**. A multi-task plan run in a single Claude session bloats
context fast — failed experiments, big diffs, library docs, verification
dumps. By task 10, the orchestrator is reasoning on cluttered, partially-
stale state and quality drops. `/masterplan` solves this structurally.

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

Every subagent gets a **bounded brief**: explicit goal, inputs, allowed
scope, constraints, return shape. It doesn't inherit session history, and
the orchestrator doesn't see its raw output — just a digest.

Activity log entries illustrate the digest pattern:

```text
2026-04-22T16:14 task "Implement memory session adapter" complete, commit f4e5d6c [codex] (verify: 24 passed)
```

Enough to reconstruct state. Nothing more.

This is what makes `ScheduleWakeup`'ing into a fresh session every ~3
tasks lossless. The status file is the bridge; the orchestrator's
mid-session context is disposable.

v2.0.0+ extends this with **wave-mode dispatch**: contiguous read-only
tasks sharing a `**parallel-group:**` annotation fire as one parallel
batch of Sonnet subagents under a single wave-completion barrier, with a
single-writer status update at wave end. Doctor checks (Step D),
situation reports (Step S), and per-worktree frontmatter parsing (Step A)
are also parallelized when N ≥ 2 worktrees. Full per-step model and
parallelism table in [`docs/internals.md`](./docs/internals.md).

## Install

### Claude Desktop app (Code tab)

This is a **Claude Code** plugin, so in the desktop app use the **Code** tab,
not a regular Chat conversation. Start a Local or SSH coding session for the
repository you want `/masterplan` to manage.

Desktop-first install:

1. Click the **+** button beside the prompt box.
2. Choose **Plugins** → **Add plugin**.
3. If `rasatpetabit-superpowers-masterplan` is not already listed, add this
   repository as a marketplace from the plugin manager's **Marketplaces** tab,
   or paste the marketplace command from the next section into the prompt.
4. Install `superpowers-masterplan`. Use **User scope** for all projects,
   **Project scope** to share through this repository's `.claude/settings.json`,
   or **Local scope** for only the current repository.
5. Run `/reload-plugins` or restart the session.
6. Verify by typing `/` or opening **+** → **Slash commands**. Look for
   `/masterplan`; if another command with the same name exists, use the
   namespaced form `/superpowers-masterplan:masterplan`.

Claude's desktop plugin browser only shows plugins from configured
marketplaces. The slash-command flow below works inside the Desktop Code tab
too, and is often the fastest way to add this marketplace the first time.

### Slash-command install (CLI or Desktop Code tab)

```text
/plugin marketplace add rasatpetabit/superpowers-masterplan
/plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan
/reload-plugins
```

Verify with `/plugin`; `superpowers-masterplan` should appear under
**Installed**. If Claude Code's plugin install syntax has drifted, add the
marketplace and pick `superpowers-masterplan` from `/plugin`'s Discover tab.
The marketplace entry declares the official `superpowers` plugin as a
dependency, so Claude Code can resolve it automatically when the official
marketplace is available. If dependency resolution says
`superpowers@claude-plugins-official` is missing, refresh the official
marketplace with `/plugin marketplace update claude-plugins-official`, or add it
with `/plugin marketplace add anthropics/claude-plugins-official`, then retry
the install.

### Manual install

```bash
mkdir -p ~/.claude/commands ~/.claude/skills
cp commands/masterplan.md ~/.claude/commands/
cp -r skills/masterplan-detect ~/.claude/skills/
```

### Dependencies

- **Required:** [`superpowers`](https://github.com/obra/superpowers).
- **Optional:** `codex` plugin for `codex:codex-rescue` execution/review.
- **Optional:** `context7` MCP for library-doc lookups during CD-4 recovery.
- **Optional:** `gh` CLI for GitHub issue/PR import and retro PR lookup.

### Optional telemetry hook

`/masterplan` can append per-turn telemetry to `<plan>-telemetry.jsonl` and
per-subagent cost records to `<plan>-subagents.jsonl`. These runtime sidecars
are local-only: the hook and command add ignore patterns to `.git/info/exclude`
before writing, and this repository's `.gitignore` ignores its own generated
telemetry. To install the Stop hook:

```bash
mkdir -p ~/.claude/hooks
cp hooks/masterplan-telemetry.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/masterplan-telemetry.sh
```

Add this hook command to `~/.claude/settings.json`:

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

The hook bails silently outside `/masterplan`-managed plans. Per-plan opt-out:
add `telemetry: off` to the status file frontmatter. Field details and `jq`
queries are in [`docs/design/telemetry-signals.md`](./docs/design/telemetry-signals.md).

## Quick Start

Start a complete brainstorm -> plan -> execute flow:

```text
/masterplan full Stripe webhook handler
```

Stop after earlier phases when you want review time:

```text
/masterplan brainstorm Stripe webhook handler
/masterplan plan Stripe webhook handler
/masterplan plan --from-spec=docs/superpowers/specs/2026-05-02-webhooks-design.md
/masterplan plan
```

Run longer autonomous work with wakeups:

```text
/loop /masterplan full refactor auth middleware --autonomy=loose
```

Resume work:

```text
/masterplan
/masterplan execute docs/superpowers/plans/2026-04-15-auth-status.md
/masterplan --resume=docs/superpowers/plans/2026-04-15-auth-status.md
```

With no args, `/masterplan` tries to resume interrupted work first: it
auto-continues the current or only in-progress plan, opens the resume picker
when active work is ambiguous, and shows the broader phase/operations menu only
when no active plan exists.

Inspect and maintain state:

```text
/masterplan import
/masterplan doctor
/masterplan doctor --fix
/masterplan status
/masterplan status --plan=<slug>
/masterplan retro
/masterplan retro auth-refactor
```

## Command Reference

| Invocation | Effect | Halts |
|---|---|---|
| `/masterplan` | Resume-first: auto-continue current/only in-progress plan, list+pick if ambiguous, menu if none | no |
| `/masterplan full <topic>` | Brainstorm, plan, then execute | no |
| `/masterplan <topic>` | Bare-topic shortcut for `full <topic>` | no |
| `/masterplan brainstorm <topic>` | Brainstorm and write a spec | after spec |
| `/masterplan plan <topic>` | Brainstorm and write a plan/status file | after plan |
| `/masterplan plan --from-spec=<path>` | Plan against an existing spec | after plan |
| `/masterplan plan` | Pick a spec without a plan, then plan it | after plan |
| `/masterplan execute [<status-path>]` | Resume a plan, or list+pick if no path | no |
| `/masterplan --resume=<status-path>` | Alias for `execute <status-path>` | no |
| `/masterplan import [...]` | Convert legacy planning artifacts into spec/plan/status | n/a |
| `/masterplan doctor [--fix]` | Lint masterplan state across worktrees | n/a |
| `/masterplan status [--plan=<slug>]` | Read-only situation report or one-plan drilldown | n/a |
| `/masterplan retro [<slug>]` | Generate a retrospective for a completed plan | n/a |
| `/masterplan stats [--plan=<slug>] [--format=table\|json\|md] [--all-repos] [--since=<date>]` | Codex-vs-inline routing distribution + inline model breakdown + token totals across plans | n/a |

Topics literally named after a verb (`full`, `brainstorm`, `plan`, `execute`,
`retro`, `import`, `doctor`, `status`, `stats`) need a leading word, for example:
`/masterplan add brainstorm session timer`.

### Routing stats

`/masterplan stats` (or directly: `bash <plugin-root>/bin/masterplan-routing-stats.sh`)
reports codex-vs-inline routing distribution, inline model breakdown
(Sonnet/Haiku/Opus), token totals by routing class (when `<plan>-subagents.jsonl`
is populated), eligibility-cache decision-source breakdown, and per-plan health
flags. By default it scans the current repo's main worktree + every linked
worktree under `.worktrees/`; use `--all-repos` to aggregate across known repos
(configurable via `MASTERPLAN_REPO_ROOTS` env var, default `~/dev`). Three
output formats: `table` (default, terminal), `json` (jq-pipeable), `md`
(GitHub-flavored, paste into PR descriptions).

### Import Shortcuts

| Invocation | Effect |
|---|---|
| `/masterplan import --pr=<num>` | Import one GitHub PR |
| `/masterplan import --issue=<num>` | Import one GitHub issue |
| `/masterplan import --file=<path>` | Import one local file |
| `/masterplan import --branch=<name>` | Reverse-engineer from one branch |

## Flags

| Flag | Effect |
|---|---|
| `--autonomy=gated\|loose\|full` | Control execution gating |
| `--resume=<status-path>` | Resume a specific plan |
| `--no-loop` | Disable ScheduleWakeup self-pacing |
| `--no-subagents` | Use `executing-plans` instead of `subagent-driven-development` |
| `--codex=off\|auto\|manual` | Control per-task Codex execution routing |
| `--no-codex` | Shorthand for `--codex=off`; also disables review |
| `--codex-review=on\|off` | Control Codex review of inline-completed tasks |
| `--codex-review` | Shorthand for `--codex-review=on` |
| `--no-codex-review` | Shorthand for `--codex-review=off` |
| `--parallelism=on\|off` | Enable/disable read-only parallel waves for this run |
| `--no-parallelism` | Shorthand for `--parallelism=off` |
| `--archive` | Import: archive legacy artifacts after conversion |
| `--keep-legacy` | Import: leave legacy artifacts in place |
| `--fix` | Doctor: apply safe auto-fixes |

Common combinations:

- `/loop /masterplan <topic> --autonomy=loose` for long autonomous work.
- `/masterplan <topic> --codex=manual --codex-review=on` to decide routing per task.
- `/masterplan <topic> --codex=off` for Claude-only execution/review.
- `/masterplan <topic> --no-parallelism` to debug wave-dispatch issues.

CLI flags override config for the run. Status-schema values such as `autonomy`,
`loop_enabled`, `codex_routing`, and `codex_review` land in the status file;
durable defaults such as `parallelism.enabled` belong in `.masterplan.yaml`.

## Configuration

Drop `.masterplan.yaml` at the repo root, or `~/.masterplan.yaml` for global
defaults. Precedence is CLI flags > repo-local > user-global > built-in defaults.

```yaml
autonomy: gated
gated_switch_offer_at_tasks: 15

loop_enabled: true
loop_interval_seconds: 1500
loop_max_per_day: 24

use_subagents: true

specs_path: docs/superpowers/specs
plans_path: docs/superpowers/plans
worktree_base: ../
trunk_branches: [main, master, trunk, dev, develop]

cruft_policy: ask
archive_path: legacy/.archive
doctor_autofix: false

codex:
  routing: auto
  review: on
  review_diff_under_full: false
  max_files_for_auto: 3
  review_max_fix_iterations: 2
  confirm_auto_routing: false
  review_prompt_at: medium

parallelism:
  enabled: true
  max_wave_size: 5
  abort_wave_on_protocol_violation: true

auto_compact:
  enabled: true
  interval: 30m
  focus: "focus on current task + active plan; drop tool output and old reasoning"

telemetry:
  enabled: true
  path_suffix: -telemetry.jsonl

integrations:
  github:
    enabled: true
    auto_link_pr_to_plan: true
  linear:
    project: null
  slack:
    blocked_channel: null
```

The canonical behavior and schema details live in
[`commands/masterplan.md`](./commands/masterplan.md).

## Advanced Features

### Codex

By default, `codex.routing: auto` delegates eligible small tasks to Codex, and
`codex.review: on` reviews inline Claude/Sonnet diffs. If the Codex plugin is
missing, both settings auto-degrade to `off` for that run and persisted config is
unchanged.

Install Codex in Claude Code:

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
```

Disable per run with `--no-codex` or `--no-codex-review`, or persistently:

```yaml
codex:
  routing: off
  review: off
```

### Plan Annotations

Plan tasks can include annotations that influence routing and parallelism:

| Annotation | Effect |
|---|---|
| `**Codex:** ok` | Force Codex eligibility |
| `**Codex:** no` | Never delegate this task to Codex |
| `**parallel-group:** <name>` | Group read-only tasks into one parallel wave |
| `**non-committing: true**` | Mark a parallel-grouped task as non-committing |

`parallel-group` tasks require a complete `**Files:**` block and are intended for
verification, inference, lint, type-check, and doc-generation tasks. Slice beta
and gamma for committing-task parallelism are deferred; see
[`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md).

### Status Files

Each plan has a sibling status file at
`docs/superpowers/plans/<slug>-status.md`. It records the worktree, branch,
current task, next action, autonomy, Codex settings, blockers, notes, and recent
activity. This file is the durable resume surface; conversation history is not.

The full schema and operational rules are documented in
[`docs/internals.md`](./docs/internals.md).

## Project Status

Current release: **v2.3.1**.

- Release history: [`CHANGELOG.md`](./CHANGELOG.md)
- Contributor internals: [`docs/internals.md`](./docs/internals.md)
- Parallelism roadmap: [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md)
- Telemetry schema: [`docs/design/telemetry-signals.md`](./docs/design/telemetry-signals.md)

The public command and config surface continues to evolve under semver. Breaking
changes are called out in the changelog with migration notes.

## Author

Built by [Richard A Steenbergen](https://github.com/rasatpetabit)
(`ras@petabitscale.com`). Inspired by the
[superpowers](https://github.com/obra/superpowers) plugin's
brainstorm/plan/execute pipeline.

## License

MIT - see [LICENSE](./LICENSE).
