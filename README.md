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

- Every plan writes to a well-defined run bundle under `docs/masterplan/<slug>/`.
  `state.yml` is the single source of truth — current phase, current task,
  next action, artifact paths, pending structured gate, and any background
  dispatch marker. `events.jsonl`
  carries the activity log. `/masterplan` will find existing plans and
  documentation and bring them into conformity with the masterplan format.
- Successful completion now checks live git status before marking the run
  complete, writes the retrospective into the same run bundle, archives the run
  state, and safely archives migrated legacy/orphan state by default. Completed
  work should not leave plan/spec/retro fragments behind.
- Resume any in-flight work from `state.yml` plus bundled artifacts. No
  conversation context required, no compaction loss, no "what was I doing
  again?"
- Bare `/masterplan` and Codex `Use masterplan` invocations are loop-first: they
  re-render pending structured gates, poll recorded background work, recover
  critical errors explicitly, or continue the only unambiguous in-progress plan
  without requiring the operator to track state manually.
- Survives `/compact`, fresh sessions, and handoff between agents — pass a
  plan to Codex or another Claude session and they pick up exactly where the
  last one stopped.
- Each plan runs in its own git worktree on its own branch, so parallel plans
  don't collide.

### Anchored brainstorming

- Before brainstorming writes a spec, `/masterplan` reads cheap repo truth
  (`AGENTS.md`, `CLAUDE.md`, `WORKLOG.md`, recent run bundles, and the obvious
  file layout), classifies the topic as feature ideation, implementation
  design, audit/review, deferred task, execution resume, or unclear, and
  persists that `brainstorm_anchor` in `state.yml`.
- Audit/review prompts, deferred plan tasks, and cross-repo scope get structured
  gates before spec writing. Yocto layer repos carry explicit ownership
  boundaries, so a distro/image policy review does not silently turn into BSP,
  app recipe, builder, or kas-composition work.
- Every spec-creating kickoff runs an adaptive interview before approaches or
  spec writing. Question depth follows resolved complexity, issue seriousness,
  and how much repo evidence already answers.
- Specs include an `Intent Anchor` / `Scope Boundary` section plus the
  verification ceiling, which keeps downstream planning honest about what can
  be proven locally versus on a build host or runtime system.

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
- **Native task-list integration (Claude Code).** Each plan's tasks are projected into the harness TaskCreate ledger for wave-progress visibility. State.yml stays canonical; the projection is rebuilt on session start. v4.1.1 adds per-state-write `TaskUpdate` priming that suppresses the TaskCreate reminder during Step C execution; other phases keep the reminder. Codex hosts are a no-op.

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
tasks lossless. `state.yml` is the bridge; the orchestrator's
mid-session context is disposable.

v2.0.0+ extends this with **wave-mode dispatch**: contiguous read-only
tasks sharing a `**parallel-group:**` annotation fire as one parallel
batch of Sonnet subagents under a single wave-completion barrier, with a
single-writer status update at wave end. Doctor checks (Step D),
situation reports (Step S), and per-worktree frontmatter parsing (Step A)
are also parallelized when N ≥ 2 worktrees. Full per-step model and
parallelism table in [`docs/internals.md`](./docs/internals.md).

## Install

### Codex

Add the repository as a Codex marketplace:

```bash
codex plugin marketplace add rasatpetabit/superpowers-masterplan
```

The marketplace is configured to install `superpowers-masterplan` by default.
New Codex sessions should see a `masterplan` skill in their available-skills
list. That skill is the portable Codex entrypoint: it loads
`commands/masterplan.md` and recognizes run bundles created by Claude Code under
`docs/masterplan/<slug>/`. Before it derives defaults or creates state, it must
load the same config tiers as Claude Code: `~/.masterplan.yaml`, then
`<repo-root>/.masterplan.yaml`, then invocation flags.

After install, invoke masterplan in Codex with a normal chat message. Do not use
Codex shell-command mode for these examples:

```text
Use masterplan status for this repo
Use masterplan next
Use masterplan full Stripe webhook handler
Use masterplan status
Use masterplan execute docs/masterplan/auth-refactor/state.yml
```

Codex may expose plugin slash commands differently across builds. The reliable
contract is prompt exposure through the `masterplan` skill, so Codex-facing
resume hints use normal chat text such as `Use masterplan ...`. `$masterplan ...`
is not the portable resume instruction for Codex because shell-command mode sends
it to Bash, where `$masterplan` is environment-variable expansion. Slash-style
text such as `/masterplan` or `/superpowers-masterplan:masterplan` is accepted
when the host passes it to the model, but it is not the portable resume
instruction for Codex. If your Codex build registers the marketplace but a fresh
prompt does not list `masterplan`,
enable `superpowers-masterplan@rasatpetabit-superpowers-masterplan` in Codex's
plugin UI or config, or install a user-level bridge at
`~/.codex/skills/masterplan/SKILL.md` from this repo's `skills/masterplan/`
directory. The same `commands/masterplan.md` orchestrator is used for Claude Code
and Codex; Codex follows the compatibility block at the top of that prompt plus
the local `AGENTS.md` tool mapping.

When running inside Codex, masterplan disables the separate Claude Code
`codex:codex-rescue` companion path for that invocation.
This avoids recursive Codex-on-Codex dispatch: execution stays inside the active
Codex session, while persisted `codex.routing` / `codex.review` settings remain
unchanged for future Claude Code runs. Other global defaults such as `autonomy`,
`complexity`, `runs_path`, and `parallelism` still come from `.masterplan.yaml`.
After a plan exists, Codex-hosted masterplan also bridges to Codex's native
goal tools: it inspects the active goal, creates a matching plan pursuit goal
when needed, and marks that native goal complete only after the run bundle's own
completion finalizer succeeds. This is not a Masterplan `goal` verb and not a
shell command; `/goal` remains a Codex host feature.

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

### Claude slash-command install (CLI or Desktop Code tab)

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

### Claude manual install

```bash
mkdir -p ~/.claude/commands ~/.claude/skills
printf '%s\n' '---' 'description: "Delegate to the installed superpowers-masterplan plugin."' '---' '<!-- masterplan-shim: v3 -->' '/superpowers-masterplan:masterplan $ARGUMENTS' > ~/.claude/commands/masterplan.md
cp -r skills/masterplan-detect ~/.claude/skills/
```

### Dependencies

- **Required:** [`superpowers`](https://github.com/obra/superpowers).
- **Optional:** `codex` plugin for `codex:codex-rescue` execution/review.
- **Optional:** `context7` MCP for library-doc lookups during CD-4 recovery.
- **Optional:** `gh` CLI for GitHub issue/PR import and retro PR lookup.

### Optional telemetry hook

`/masterplan` can append per-turn telemetry to `docs/masterplan/<slug>/telemetry.jsonl` and
per-subagent cost records to `docs/masterplan/<slug>/subagents.jsonl`. These runtime sidecars
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
add `telemetry: off` to `state.yml`. Field details and `jq`
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
/masterplan plan --from-spec=docs/masterplan/webhooks/spec.md
/masterplan plan
```

Run longer autonomous work with wakeups:

```text
/loop /masterplan full refactor auth middleware --autonomy=loose
```

Resume work:

```text
/masterplan
/masterplan execute docs/masterplan/auth-refactor/state.yml
/masterplan --resume=docs/masterplan/auth-refactor/state.yml
```

With no args, `/masterplan` or Codex `Use masterplan` tries to resume interrupted work
first: it re-renders pending gates, handles recorded critical errors, polls
background continuations, auto-continues the current or only in-progress plan,
opens the resume picker when active work is ambiguous, and shows the broader
phase/operations menu only when no active plan exists.

Every run lives in one directory:

```text
docs/masterplan/<slug>/
  state.yml
  spec.md
  plan.md
  retro.md
  events.jsonl
  events-archive.jsonl
  eligibility-cache.json
  telemetry.jsonl
  subagents.jsonl
  state.queue.jsonl
```

`state.yml` is created before brainstorming starts, so compaction or a stopped
session can resume from a durable phase pointer. It records `stop_reason` and
`critical_error` separately: ordinary pauses stay `in-progress` with a question
or scheduled continuation, while `blocked` is reserved for safety-critical
recovery. Older `docs/superpowers/...` layouts are migrated into this bundle
layout by `/masterplan import` (copy-only; preserves source paths under
`legacy:`).

When the last task completes, `/masterplan` checks live git status before
marking the run complete. If task-scope work is still dirty, it keeps the run in
`finish_gate` with a concrete commit/finish `next_action`; otherwise it
generates `retro.md`, archives the run state in `state.yml`, and runs an
archive-only completion cleanup for verified legacy/orphan state. Use
`--no-retro` or `--no-cleanup` for a one-off opt-out, or config defaults to
disable either behavior.

Inspect and maintain state:

```text
/masterplan import
/masterplan doctor
/masterplan doctor --fix
/masterplan status
/masterplan status --plan=<slug>
/masterplan retro
/masterplan retro auth-refactor
/masterplan clean --dry-run
```

## Command Reference

| Invocation | Effect | Halts |
|---|---|---|
| `/masterplan` | Resume-first: auto-continue current/only in-progress plan; detects scope overlap with existing plans (offers Resume / Derive variant / Force new); list+pick if ambiguous, menu if none | no |
| `/masterplan full <topic>` | Brainstorm, plan, then execute | no |
| `/masterplan <topic>` | Bare-topic shortcut for `full <topic>` | no |
| `/masterplan brainstorm <topic>` | Brainstorm and write a spec | after spec |
| `/masterplan plan <topic>` | Brainstorm and write a run bundle | after plan |
| `/masterplan plan --from-spec=<path>` | Plan against an existing spec | after plan |
| `/masterplan plan` | Pick a spec without a plan, then plan it | after plan |
| `/masterplan execute [<state-path>]` | Resume a plan, or list+pick if no path | no |
| `/masterplan --resume=<state-path>` | Alias for `execute <state-path>` | no |
| `/masterplan import [...]` | Convert legacy planning artifacts into bundled spec/plan/state | n/a |
| `/masterplan doctor [--fix]` | Lint masterplan state across worktrees | n/a |
| `/masterplan status [--plan=<slug>]` | Read-only situation report or one-plan drilldown | n/a |
| `/masterplan retro [<slug>]` | Generate or re-run a retrospective for a completed plan | n/a |
| `/masterplan stats [--plan=<slug>] [--format=table\|json\|md] [--all-repos] [--since=<date>]` | Codex-vs-inline routing distribution + inline model breakdown + token totals across plans | n/a |
| `/masterplan clean [--dry-run] [--delete] [--category=<name>] [--worktree=<path>]` | Archive completed bundles, retire migrated legacy artifacts, and prune orphan state; `--delete` forces deletion instead of archive; `--category` and `--worktree` scope the operation | n/a |
| `/masterplan validate [--plan=<slug>]` | Read-only config + state schema validation; checks `.masterplan.yaml` against built-in defaults and (with `--plan`) validates that plan's `state.yml` | n/a |
| `/masterplan next` | "What's next?" router — scans active plans and completed-plan follow-ups, then offers resume/follow-up/new-plan/status options via AUQ; never starts a brainstorm about the topic "next" | n/a |

Topics literally named after a verb (`full`, `brainstorm`, `plan`, `execute`,
`retro`, `import`, `doctor`, `status`, `stats`, `clean`, `validate`, `next`) need a leading word, for example:
`/masterplan add brainstorm session timer`.

### Routing stats

`/masterplan stats` (or directly: `bash <plugin-root>/bin/masterplan-routing-stats.sh`)
reports codex-vs-inline routing distribution, inline model breakdown
(Sonnet/Haiku/Opus), token totals by routing class (when `docs/masterplan/<slug>/subagents.jsonl`
is populated), eligibility-cache decision-source breakdown, and per-plan health
flags. By default it scans the current repo's main worktree + every linked
worktree under `.worktrees/`; use `--all-repos` to aggregate across known repos
(configurable via `MASTERPLAN_REPO_ROOTS` env var, default `~/dev`). Three
output formats: `table` (default, terminal), `json` (jq-pipeable), `md`
(GitHub-flavored, paste into PR descriptions).

### Session audit

`bash <plugin-root>/bin/masterplan-session-audit.sh` is the read-only incident
audit for recent Claude, Codex, and `/masterplan` telemetry logs. It scans a
configurable time window, prints repo-level totals and top offending sessions,
prints a primary-session "Started goals at risk" table, and warns on runaway
Codex tool calls, meta-resume loops with no outcome progress, completed
audit/doctor plans that found confirmed gaps but did not create structured
implementation follow-ups, shell invocations such as `$masterplan next`,
unclassified active Masterplan stops, repeated shell-tool loops, Claude
AskUserQuestion/Agent fanout, SessionStart payload bloat, oversized transcript
telemetry, and missing telemetry for sessions with explicit `/masterplan`
invocation/runtime markers. Codex guardian approval sub-sessions are classified
as auxiliary so they do not pollute started-goal or missing-telemetry reports.
The output
is content-redacted: it reports counters, repo labels, session IDs, tool names,
and telemetry sizes, not user prompts, shell commands, credentials, or tool
results. JSON output includes stable warning `code`, `session_role`,
`goal_outcome`, and `goal_failure_reasons` fields for downstream automation,
and the self-host audit runs fixture-backed regressions for the classifier and
warning contract.

```bash
bin/masterplan-session-audit.sh --hours=24
bin/masterplan-session-audit.sh --since=2026-05-10T15:51:23Z --format=json
bin/masterplan-recurring-audit.sh
bin/masterplan-audit-schedule.sh install
```

The recurring wrapper stores `latest.json`, `latest.txt`, `history.jsonl`, and
`findings.jsonl` under
`${MASTERPLAN_AUDIT_STATE_DIR:-$XDG_STATE_HOME/superpowers-masterplan/audits}`
or `$HOME/.local/state/superpowers-masterplan/audits`. The scheduler installs a
managed cron block only; unrelated crontab entries are preserved.

### Codex usage analysis

`bash <plugin-root>/bin/masterplan-codex-usage.sh` surveys codex invocations
across three sources in one report: codex's own session rollouts under
`~/.codex/sessions/`, Claude transcripts under `~/.claude/projects/` (for
`codex:*` Agent dispatches and `codex` CLI calls in Bash tool_use), and per-plan
`codex_routing` / `codex_review` config from the current repo's
`docs/masterplan/*/state.yml`. Useful for answering "how much am I actually
using codex right now, and through which path." Default window is 14 days;
override via `--days=N` or `--since=YYYY-MM-DD`. Supports `--json` for
machine-readable output.

```bash
bin/masterplan-codex-usage.sh
bin/masterplan-codex-usage.sh --days=30
bin/masterplan-codex-usage.sh --json | jq '.totals'
```

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
| `--resume=<state-path>` | Resume a specific plan |
| `--no-loop` | Disable ScheduleWakeup self-pacing |
| `--no-subagents` | Use `executing-plans` instead of `subagent-driven-development` |
| `--no-retro` | Skip the default completion retro for this run |
| `--no-cleanup` | Skip the default completion cleanup for this run |
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
| `--no-archive` | Retro: write `retro.md` without archiving the run state |
| `--keep-worktree` | Completion: skip auto-remove of the run bundle's worktree on success |

Under `--autonomy=loose`, the `plan_approval` gate auto-approves silently; `spec_approval` still halts (intentional — cheap to correct direction early).

Common combinations:

- `/loop /masterplan <topic> --autonomy=loose` for long autonomous work.
- `/masterplan <topic> --codex=manual --codex-review=on` to decide routing per task.
- `/masterplan <topic> --codex=off` for Claude-only execution/review.
- `/masterplan <topic> --no-parallelism` to debug wave-dispatch issues.

CLI flags override config for the run. State-schema values such as `autonomy`,
`loop_enabled`, `codex_routing`, and `codex_review` land in `state.yml`;
durable defaults such as `parallelism.enabled` belong in `.masterplan.yaml`.

## Configuration

Drop `.masterplan.yaml` at the repo root, or `~/.masterplan.yaml` for global
defaults. Precedence is CLI flags > repo-local > user-global > built-in defaults.

```yaml
autonomy: gated
complexity: medium
gated_switch_offer_at_tasks: 15

loop_enabled: true
loop_interval_seconds: 1500
loop_max_per_day: 24

use_subagents: true

runs_path: docs/masterplan
specs_path: docs/superpowers/specs   # legacy migration input
plans_path: docs/superpowers/plans   # legacy migration input
worktree_base: ../
trunk_branches: [main, master, trunk, dev, develop]

cruft_policy: ask
archive_path: legacy/.archive
doctor_autofix: false

worktree:
  default_disposition: removed_after_merge  # or kept_by_user

codex:
  routing: auto
  review: on
  review_diff_under_full: false
  max_files_for_auto: 3
  review_max_fix_iterations: 2
  confirm_auto_routing: false
  review_prompt_at: medium
  unavailable_policy: degrade-loudly
  detection_mode: ping

parallelism:
  enabled: true
  max_wave_size: 5
  abort_wave_on_protocol_violation: true
  member_timeout_sec: 600
  on_member_timeout: warn

auto_compact:
  enabled: true
  interval: 30m
  focus: "focus on current task + active plan; drop tool output and old reasoning"

completion:
  auto_retro: true
  cleanup_old_state: true

retro:
  auto_archive_after_retro: true

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
    blocked_channel: null  # critical_error/status: blocked notifications
```

The canonical behavior and schema details live in
[`commands/masterplan.md`](./commands/masterplan.md).

## Advanced Features

### Codex delegation from Claude

By default, `codex.routing: auto` delegates eligible small tasks to Codex, and
`codex.review: on` reviews inline Claude/Sonnet diffs. If the Codex plugin is
missing, both settings auto-degrade to `off` for that run and persisted config is
unchanged.

This section applies to Claude Code hosting `/masterplan`. When the same
orchestrator is hosted by Codex through `/superpowers-masterplan:masterplan`,
`codex:codex-rescue` routing/review is suppressed automatically to avoid
recursive Codex dispatch.

Install the Codex companion plugin in Claude Code:

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

### Run State

Each plan has a run bundle at `docs/masterplan/<slug>/`. `state.yml` records
the worktree, branch, phase, current task, next action, autonomy, Codex settings,
artifact paths, any pending structured gate, any background dispatch marker,
worktree disposition (`active` / `kept_by_user` / `removed_after_merge` / `missing`), retro
policy, and scope fingerprint (for overlap detection).
`events.jsonl` records recent
activity, with cache/telemetry/subagent/queue sidecars kept inside the same run
directory. This bundle is the durable resume surface; conversation history is not.

The full schema and operational rules are documented in
[`docs/internals.md`](./docs/internals.md).

## Troubleshooting

If `/masterplan` produces no output (zero assistant response) after `/reload-plugins`,
the harness has likely de-registered the slash command. Confirm by checking whether
the first line of the turn was `→ /masterplan v… args: …` (the v2.16.0+ invocation
sentinel) — if absent, re-install via `/plugin` (uninstall + install
`superpowers-masterplan`) and re-invoke. See [`CHANGELOG.md`](./CHANGELOG.md) v2.16.0
for details and the upstream issue link.

## Project Status

Current release: **v5.4.0**. See [CHANGELOG.md](./CHANGELOG.md) for full release history.

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
