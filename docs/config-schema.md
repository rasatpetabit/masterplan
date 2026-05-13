# Configuration Schema

## Configuration: .masterplan.yaml

### Precedence (shallow merge, top-level keys only)

1. CLI flags (highest)
2. Repo-local `<repo-root>/.masterplan.yaml`
3. User-global `~/.masterplan.yaml`
4. Built-in defaults (below)

Step 0 loads + merges these into a single `config` object referenced throughout this prompt. Missing files = skip that tier silently. Invalid YAML = abort with file path + parser message.

### Schema (with built-in defaults)

```yaml
# Default execution autonomy
autonomy: gated  # gated | loose | full

# 3-level complexity meta-knob (low|medium|high). Sets defaults for several
# other knobs; explicit settings (CLI flag, frontmatter, config) win over
# complexity-derived defaults. medium = current behavior (back-compat).
# See Step 0's "Complexity resolution" subsection for precedence and
# Operational rules' "Complexity precedence" entry for the per-knob defaults.
complexity: medium  # low | medium | high

# Gated→loose switch offer (v2.1.0+). Under autonomy=gated, surface a one-time
# AskUserQuestion offering to switch to loose for the remainder of the plan when
# the plan's task count is at least this threshold. Set to 0 to disable the
# offer entirely. Per-plan dismissal via `gated_switch_offer_dismissed: true`
# in state.yml. Per-session suppression via `gated_switch_offer_shown:
# true` in state.yml (re-fires across cross-session wakeups by default;
# set the dismissed field to suppress permanently for a plan).
gated_switch_offer_at_tasks: 15

# Cross-session loop scheduling (Step C)
loop_enabled: true
loop_interval_seconds: 1500   # ScheduleWakeup delay between chunks
loop_max_per_day: 24          # cap to prevent runaway scheduling

# Subagent execution mode (Step C)
use_subagents: true           # false → fall back to executing-plans

# Run/state paths (relative to worktree root)
runs_path: docs/masterplan

# Legacy doc paths (relative to worktree root). Step 0 migration reads these
# from pre-v3 invocations; new writes go under runs_path.
specs_path: docs/superpowers/specs
plans_path: docs/superpowers/plans

# Worktree base directory for newly-created worktrees (Step B0)
worktree_base: ../            # sibling-of-repo by default

# Branch names that trigger "create new worktree" recommendation (Step B0)
trunk_branches: [main, master, trunk, dev, develop]

# Cruft handling for /masterplan import (Step I3)
cruft_policy: ask             # ask | leave | archive | delete
archive_path: legacy/.archive # relative to repo root

# /masterplan doctor auto-fix policy (overridden by --fix flag)
doctor_autofix: false

# Codex routing + review for Step C task execution
# (overridden by --codex= / --no-codex / --codex-review= / --no-codex-review flags)
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: on                 # off | on — Codex reviews diffs from inline-completed tasks (v2.0.0+ default: on; auto-degrades to off if codex plugin not installed)
  review_diff_under_full: false  # if true, even autonomy=full pauses to show Codex output
  max_files_for_auto: 3      # eligibility heuristic threshold for `auto` routing
  review_max_fix_iterations: 2  # cap on "fix and re-review" retries before bailing
  confirm_auto_routing: false  # under `gated`, prompt per-task to confirm auto-routing decisions
                               # (default false: honor cache silently; events.jsonl records every decision)
                               # set true to restore the legacy expanded per-task prompt
  review_prompt_at: medium   # under `gated`, severity threshold at which Codex review findings prompt
                             # values: low | medium | high | never
                             # default `medium` (auto-accept clean and low-only; prompt at medium+)
                             # set `low` to prompt on every non-clean review; set `never` to auto-accept all
  unavailable_policy: degrade-loudly  # v2.4.0+: how to behave when codex_routing != off but plugin/cache unavailable
                                      # values: degrade-loudly | block
                                      # `degrade-loudly` (default): emit warning + write degradation marker + AskUserQuestion fallback
                                      # path. Step 0's degradation block (above) and Step C step 3a's precondition halt both honor this.
                                      # `block`: skip user prompts; record a critical_error, set status: blocked, and end the turn.
                                      # For users who'd rather a stuck plan than a silent-codex-skip plan.
  detection_mode: ping                # v2.8.0+: how Step 0 detects codex availability
                                      # values: ping | scan | trust
                                      # `ping` (default): dispatch a 5-token bounded ping to codex:codex-rescue; most accurate
                                      #   (catches plugin-present-but-broken). Cost: ~5 tokens per /masterplan invocation.
                                      # `scan`: legacy heuristic — look for any `codex:` prefix in the system-reminder skills list.
                                      #   Faster but fragile; survives only as long as that prefix convention holds.
                                      # `trust`: assume available; skip detection entirely. For locked-down accounts where the
                                      #   ping itself fails for unrelated reasons (sandbox-blocked subagent dispatch, etc.).

# Intra-plan task parallelism (v2.0.0+) — Slice α (read-only parallel waves)
# When enabled, contiguous tasks sharing the same `**parallel-group:**` annotation
# in a plan dispatch as one parallel wave (verification, inference, lint,
# type-check, doc-generation only — no committing work). Implementation tasks
# remain serial under the existing per-task Step C loop.
# See docs/design/intra-plan-parallelism.md for the failure-mode catalog
# and the deferred Slice β/γ trigger.
parallelism:
  enabled: true                              # off | on — global kill switch for wave dispatch
                                             # (overridden by --parallelism= / --no-parallelism flags)
  max_wave_size: 5                           # cap on concurrent Agent dispatches per wave
                                             # (tasks beyond cap roll into the next wave)
  abort_wave_on_protocol_violation: true     # if true, suppress entire 4d batch when any wave
                                             # member is reclassified as protocol_violation
                                             # (false: standard partial-failure path applies)
  member_timeout_sec: 600                    # v2.8.0+: soft threshold for post-hoc slow-member detection
                                             # The orchestrator cannot actively cancel a hung Agent call
                                             # (no LLM-runtime cancel primitive); instead, after the
                                             # wave-completion barrier returns, the orchestrator reads
                                             # each member's duration_ms from subagents.jsonl
                                             # (recorded by hooks/masterplan-telemetry.sh) and classifies
                                             # any whose duration_ms > member_timeout_sec * 1000 as
                                             # slow_member per on_member_timeout below. Detection is
                                             # observability, not active cancellation — the harness's
                                             # own timeout still bounds true hangs.
  on_member_timeout: warn                    # v2.8.0+: how to react to a post-hoc slow_member detection
                                             # values: warn | blocker
                                             # `warn` (default): emit one slow_member event;
                                             #   member's digest is otherwise honored normally.
                                             # `blocker`: re-classify the slow member as blocked at the
                                             #   next Step C entry and route through the blocker
                                             #   re-engagement gate. Use for plans where slow waves
                                             #   need explicit operator review before further progress.

# Auto-compact loop nudge — Step B3 + Step C step 1 surface a passive notice
# once per plan recommending /loop /compact in a sibling session for
# automatic context compaction. Once-per-plan suppression via
# compact_loop_recommended state field. /masterplan itself never starts the loop.
auto_compact:
  enabled: true              # nudge user to start compact loop
  interval: 30m              # passed verbatim into the suggested command
  focus: "focus on current task + active plan; drop tool output and old reasoning"

# Completion finalizer (v3.0.0+) — when Step C marks all tasks done,
# /masterplan writes completion state, generates a retro, archives the run
# state, and archives safely-migrated legacy/orphan state by default.
# Per-invocation overrides: --no-retro and --no-cleanup.
completion:
  auto_retro: true           # false → leave status: complete until manual /masterplan retro
  cleanup_old_state: true    # false → leave legacy/orphan state for manual /masterplan clean

# Retro archive (v3.0.0+) — after Step R3 writes retro.md into the run bundle,
# Step R3.5 sets status: archived and phase: archived in state.yml. Legacy
# docs/superpowers plan/spec moves happen during explicit migration/clean or
# Step C's completion-safe cleanup subset.
# Set `false` to keep completed plans active after retro (manual archive).
# Per-invocation override: pass `--no-archive` to /masterplan retro.
retro:
  auto_archive_after_retro: true

# Worktree lifecycle policy (v4.0.0+) — controls what happens to feature
# worktrees when a plan completes. `active` (default): auto-remove the worktree
# via `git worktree remove` at Step C completion (non-interactive). Use
# `kept_by_user` for repos where worktrees are intentionally preserved past
# completion (e.g. always-open dev environments). Override per-run with
# --keep-worktree flag at kickoff.
worktree:
  default_disposition: active  # active | kept_by_user; default active
  # Repos that always keep worktrees past completion set this to kept_by_user

# Per-turn context telemetry — captured by hooks/masterplan-telemetry.sh
# (Stop hook, manually installed) and by Step C step 1 inline snapshots.
# JSONL appended to docs/masterplan/<slug>/telemetry.jsonl.
# Per-plan opt-out: add `telemetry: off` to state.yml.
telemetry:
  enabled: true              # on by default
  path_suffix: -telemetry.jsonl  # legacy fallback only; v3 bundles use telemetry.jsonl

# External integration refs (NEVER secrets — secrets live in env or MCP config)
integrations:
  github:
    enabled: true             # auto-detected via gh auth status if unset
    auto_link_pr_to_plan: true
  linear:
    project: null             # e.g. INGEST; requires Linear MCP
  slack:
    blocked_channel: null     # post here when critical_error/status: blocked, requires Slack MCP
```

### Adding new keys

Treat the schema as additive — new keys land in built-in defaults first, then become configurable. Unknown keys in user files are tolerated (forward-compat) but logged once at load time.

---

