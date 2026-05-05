---
slug: complexity-levels
date: 2026-05-05
status: draft
---

# 3-level `complexity` variable for /masterplan — design spec

## Background

`/masterplan` is heavyweight by design. Every kickoff produces a brainstorm spec, a writing-plans plan, a status file with 15 required frontmatter fields, an eligibility cache, optional telemetry sidecars, and a wakeup ledger. Execute runs codex-review on every inline task, parallel waves where eligible, and writes 2-3 activity-log entries per task (`routing→`, `review→`, post-completion). At plan complete, doctor lints 21 checks.

This level of rigor is correct for substantive work where the cost of bypass is real (the postmortem-driven prevention layer in v2.4.0 exists for that reason). But not every project needs it. Adding a `complexity` parameter to a YAML config or a one-line bug fix should not require:

- Five clarifying questions during brainstorm.
- A 15-task plan with `**Files:**` blocks per task.
- A 15-field status frontmatter.
- Codex review on every commit.
- Doctor checks for orphan eligibility caches that don't exist.

The user pain (verbatim): *"Not every project needs a massive plan and nitpicking of every detail."* Top observed pain point: per-task rigor — codex review + activity log density + verification overhead on every task.

This spec adds a single `complexity` knob with three levels (`low | medium | high`) that scales planning artifacts, status persistence, execution rigor, and doctor checks together. `medium` preserves all current behavior (backward compatible). `low` relaxes per-task rigor and persistence overhead. `high` adds rigor-forward defaults for high-stakes work.

## Goals

- **G1.** A single 3-level meta-knob (`complexity: low|medium|high`) that scales /masterplan's overhead end-to-end.
- **G2.** `medium` is the default and preserves every current behavior. Existing plans without the new field continue to work unchanged.
- **G3.** `low` measurably reduces per-task rigor: no codex review by default, no eligibility cache, simpler activity log, no telemetry sidecar, no wakeup ledger, no parallelism wave dispatch.
- **G4.** Existing fine-grained knobs (`autonomy`, `codex_routing`, `codex_review`, `parallelism`, etc.) remain. Complexity sets defaults; explicit overrides win.
- **G5.** Settable via three tiers matching the existing pattern for `autonomy` / `codex_routing`: CLI flag, `~/.masterplan.yaml` / `<repo>/.masterplan.yaml`, status frontmatter.
- **G6.** Discoverable: at kickoff (when not set via flag or config), prompt the user once between worktree decision and brainstorm.
- **G7.** Brainstorm is unaffected. Even at `low`, brainstorming runs the full superpowers:brainstorming flow (where bad assumptions get caught).

## Non-goals

- **N1.** Replacing or deprecating `autonomy`, `codex_routing`, `codex_review`, or `parallelism`. They remain as orthogonal fine-grain controls.
- **N2.** Adding per-task `**Complexity:**` annotations. Plan-wide is enough; per-task complexity overlap is a YAGNI direction.
- **N3.** Migrating existing plans. Plans without the field default to `medium` at read time. No migration script.
- **N4.** Changing `/masterplan brainstorm` or `/masterplan plan` flow shape. Complexity affects what the brainstorm spec contains and what the plan looks like, but the verb routing and gate sequencing are unchanged.
- **N5.** Changing the CLI surface for any other verb. `/masterplan status`, `/masterplan doctor`, `/masterplan retro` continue to work as today; their *output* may differ when run against a `complexity != medium` plan, but the invocation contract is unchanged.

## Design

### Variable

| Name | Type | Levels | Default |
|------|------|--------|---------|
| `complexity` | enum | `low \| medium \| high` | `medium` |

### Precedence (resolution at Step 0)

1. CLI flag: `--complexity=<level>` (highest)
2. Status frontmatter: `complexity: <level>` (only on resume / Step C entry)
3. Repo-local `<repo-root>/.masterplan.yaml`: `complexity: <level>`
4. User-global `~/.masterplan.yaml`: `complexity: <level>`
5. Built-in default: `medium` (lowest)

The Step 0 git-state cache is extended to record `resolved_complexity` and `complexity_source` (one of `flag`, `frontmatter`, `repo_config`, `user_config`, `default`) so downstream steps can cite the source in the activity log without re-resolving.

### Interaction with existing knobs (defaults-only)

`complexity` sets *defaults* for several existing knobs. Explicit settings — at any tier above the complexity-derived default — win. Resolution order per knob:

```
explicit_cli_flag > status_frontmatter > config > complexity_derived_default > built_in_default
```

Concrete example: with `complexity: low` set in repo config and `--codex-review=on` on the CLI, `codex_review` resolves to `on` (CLI flag wins over `low`'s default of `off`). The activity log records:
```
- 2026-05-05T... complexity=low (source: repo_config); codex_review=on (source: cli_flag, overrides complexity-derived default)
```

This single line, written once at first Step C entry, is the audit trail for "why did the orchestrator behave this way."

### Behavior matrix (canonical)

The matrix below is the contract. Implementation must match this exactly.

#### Plan-writing (Step B2)

| Concern | low | medium | high |
|---------|-----|--------|------|
| Per-task `**Files:**` block | optional | encouraged | required |
| Per-task `**Codex:**` annotation | skipped (writing-plans does not emit) | optional | required (`ok` or `no` per task) |
| Per-task `**parallel-group:**` annotation | skipped | optional | encouraged |
| Eligibility cache JSON | not built (file does not exist) | built at first Step C entry | built + validated against `plan.mtime` on every Step C entry |

The writing-plans brief is parameterized on complexity. At `low`, the brief explicitly tells writing-plans to skip the annotation prelude, produce a flat task list, and target ~3-7 tasks for typical scope. At `high`, the brief includes the full annotation requirements and asks for `**Files:**` exhaustively.

#### Status file (Step B3 + Step C 4d)

| Concern | low | medium | high |
|---------|-----|--------|------|
| Frontmatter fields | 15 + `complexity: low` (16 total — same as medium plus complexity) | 15 + `complexity: medium` (16 total) | 15 + `complexity: high` (16 total) |
| Activity log entry density | one line per task: `<ts> <task-name> <pass\|fail>` | full tags: `[routing→...] [review→...] [verification...]` (current) | full + `decision_source: ...` cite |
| Activity log rotation threshold | 50 entries | 100 entries (current) | 100 entries |
| `## Wakeup ledger` section | not written | written by Step C 5 + 1 (current) | written |
| Telemetry sidecar (`<plan>-telemetry.jsonl`) | not written | written (current) | written + per-subagent records (current behavior) |
| Status archive (`<slug>-status-archive.md`) | created on rotation (50 → 25 retained) | created on rotation (100 → 50 retained, current) | created on rotation (100 → 50 retained) |

**Frontmatter shape is identical across all three levels.** The 15 current required fields plus a new `complexity:` field. complexity-derived defaults (`autonomy`, `codex_routing`, `codex_review`, `loop_enabled`, `compact_loop_recommended`) are written as their *resolved* values at Step B3 — not omitted. This keeps doctor #9 (schema check) simple: same required set at every level. The leverage of `low` is in *skipped sidecars* (eligibility cache, telemetry, wakeup ledger), *log density* (one-line activity entries), and *behavior defaults* (no codex review, no parallelism), not in shrinking the frontmatter.

#### Execute defaults (Step 0 derived; CLI/config/frontmatter override)

| Knob | low | medium | high |
|------|-----|--------|------|
| `autonomy` | `loose` | `gated` (current) | `gated` |
| `codex_routing` | `off` | `auto` (current) | `auto` |
| `codex_review` | `off` | `on` (current) | `on` with `review_prompt_at: low` |
| `parallelism.enabled` | `off` | `on` (current) | `on` |
| `gated_switch_offer_at_tasks` | effectively `999` (offer suppressed) | `15` (current) | `25` |
| `review_max_fix_iterations` | `0` | `2` (current) | `4` |

#### Doctor (Step D)

| Concern | low | medium | high |
|---------|-----|--------|------|
| Active check set | #1 (orphan plan), #2 (orphan status), #3-#5 (worktree/branch/staleness), #6 (stale blocked), #8 (missing spec), #9 (schema, against the standard 15-field set), #10 (unparseable), #18 (codex misconfig) | all 21 (current) | all 21 + new #22 |
| New check **#22** (high-only) | n/a | n/a | **High-complexity plan missing rigor evidence** — fires when `complexity: high` AND the plan's status file lacks any of: a `## Notes` retro reference, an inline `Codex review:` pass, or `[reviewed: ...]` tags in ≥ 50% of activity log entries. Severity: Warning. No auto-fix. |

Skipped checks under low (#11, #12, #13, #14, #15, #16, #17, #19, #20) target sidecars, annotations, and ledger entries that low doesn't produce — running them would generate spurious warnings.

#### Verification (Step C 4a)

| Concern | low | medium | high |
|---------|-----|--------|------|
| Trust implementer's `tests_passed` | yes (current) | yes (current) | re-run all verification commands regardless |
| Codex review threshold (under `gated`) | n/a (codex_review off) | `medium` (current) | `low` (auto-prompt on every non-clean review) |

#### Brainstorm + Retro

| Phase | low | medium | high |
|-------|-----|--------|------|
| Brainstorm (Step B1) | unchanged (full superpowers:brainstorming) | unchanged | unchanged |
| Retro at completion (Step C 6) | optional | optional (current) | required — Step C 6 surfaces `AskUserQuestion` with a "Generate retro now (Recommended)" first option |

### Kickoff UX

When a kickoff (`/masterplan full <topic>`, `/masterplan plan <topic>`, `/masterplan brainstorm <topic>`) starts AND `--complexity` is not on the CLI AND no config tier sets `complexity`, surface ONE `AskUserQuestion` after the Step B0 worktree decision and before Step B1's brainstorm:

```
AskUserQuestion(
  question="What complexity for this project? Affects plan size, execution rigor, and doctor checks. Brainstorm runs full regardless.",
  options=[
    "medium — standard /masterplan flow (Recommended; current behavior)",
    "low — small project, light treatment (skip codex review, simpler activity log, ~3-7 tasks, no eligibility cache)",
    "high — high-stakes; codex review on every task, decision-source cited, retro required at completion",
    "use config default — read from .masterplan.yaml; warn if not set, fall through to medium"
  ]
)
```

If `complexity` is set in any config tier, the prompt is silenced (config wins, no question). If `--complexity=<level>` is on the CLI, the prompt is silenced (flag wins).

The user's pick is persisted into the status frontmatter at Step B3.

### Resume UX

On resume (`/masterplan execute <status-path>` or `/masterplan --resume=<status-path>`), the status frontmatter's `complexity:` field wins. If the user passes `--complexity=<level>` on the resume CLI:

- The new value is used for this run.
- The status frontmatter is updated to the new value at Step C step 1's first status-file write.
- A `## Notes` entry is appended: *"Complexity changed from `<old>` to `<new>` at `<ISO ts>` via CLI override."*

This is the same pattern as autonomy mid-run flips (`--autonomy=loose` overrides frontmatter `autonomy: gated`).

If the resumed status file has NO `complexity:` field (pre-feature plan), it is treated as `medium` and the field is *not* written into frontmatter unless the user explicitly passes `--complexity=<level>` on the resume.

### Step M (bare invocation picker)

**No change to Step M for v1.** The two-tier picker (`/masterplan` with no args) does not gain a complexity question. Rationale: Step M's user just landed on the bare invocation; adding a third decision tier would slow them down. They get medium silently; if they want to opt in to low/high, they re-invoke as `/masterplan full <topic> --complexity=low`. We can revisit if usage data shows users want it surfaced earlier.

## Migration / back-compat

- **Existing plans without `complexity:` in frontmatter** → treated as `medium` at every Step C entry. No migration. Behavior unchanged from today.
- **Existing config files without `complexity:`** → falls through to built-in default (`medium`). No migration.
- **Existing CLI invocations without `--complexity=`** → at kickoff, prompt fires (one new `AskUserQuestion`); at resume, status frontmatter (or default `medium`) wins.
- **Doctor #9 schema check** → unchanged at any complexity level: validates the standard 15-field required set. If `complexity` is in the frontmatter, it's also validated against the enum (`low|medium|high`); absence is tolerated (defaults to `medium`).
- **Doctor #22** → only fires when `complexity: high`. Plans without `complexity:` or with `medium`/`low` are not affected by this check.
- **Telemetry sidecars** → existing low-complexity plans (none yet, since the field doesn't exist) won't have `<plan>-telemetry.jsonl`. No cleanup needed; doctor #13 (orphan telemetry) doesn't fire on absence.
- **Eligibility cache** → existing plans with `<plan>-eligibility-cache.json` continue to use it. New `complexity: low` plans don't generate the file; doctor #14 (orphan eligibility cache) does not flag absence.

No breaking changes. Plans transitioning between complexity levels mid-run (via resume + `--complexity=<new>` CLI override) get a `## Notes` audit entry.

## Alternatives considered

### A1 — Two orthogonal knobs (`plan_complexity` + `execution_rigor`)

Split into two enums. `plan_complexity` controls plan size and brainstorm depth; `execution_rigor` controls per-task verification + codex review.

**Rejected.** Doubles the cognitive load. The user explicitly asked for a single knob. The 3x3 matrix is harder to remember than 1x3. And the user's framing ("not every project needs a massive plan and nitpicking of every detail") connects the two — they're symptoms of the same root concern.

### A2 — Meta-knob hard-overrides existing knobs

`complexity: low` *forces* `codex_review=off`. User cannot override.

**Rejected.** Loses fine-grained control. Some users want "small project, but I still want codex review" — the matrix says no in this approach. Defaults-with-overrides is strictly more flexible at zero ergonomic cost.

### A3 — Numeric levels (`complexity: 1|2|3`)

Use integers instead of `low/medium/high`.

**Rejected.** Less readable in status frontmatter and activity logs. Doesn't compose well with future levels (would be tempted to add `1.5`). The named-enum pattern matches `autonomy: gated|loose|full`.

### A4 — Per-task `**Complexity:**` annotation

Allow tasks to override the plan's complexity. Light task in a heavy plan, or vice versa.

**Rejected for v1.** Per-task overlap is a different problem (some users have argued for per-task `**Codex:**` overrides; that already exists). For now the plan-wide setting is enough. Revisit if users ask.

### A5 — Replace `autonomy` with `complexity`

Deprecate `autonomy: gated|loose|full`. Use `complexity` to derive the gating behavior.

**Rejected.** Breaking change. autonomy is a behavior axis (does the user want to review per task?); complexity is a depth axis (how rigorous is the work?). They're related but distinct. The defaults table connects them where useful.

## Test plan

### Unit-level (markdown-prompt manipulation)

- **T1** — `bash -n hooks/masterplan-telemetry.sh` syntax check.
- **T2** — `grep` discriminators per edited section: every place `complexity` is referenced in `commands/masterplan.md` must match the behavior matrix exactly. Spec includes a test plan to enumerate these grep targets.

### Integration-level (hand-crafted runs)

- **T3** — Kickoff with no `--complexity`, no config: AskUserQuestion fires; pick `low`; verify status frontmatter has `complexity: low`, no eligibility cache built, plan task count ≤ 7, activity log entry uses one-line format.
- **T4** — Kickoff with `--complexity=high`: skip the AskUserQuestion (flag set); verify status frontmatter has `complexity: high`, eligibility cache built and validated, plan tasks have `**Files:**` blocks, activity log includes `decision_source` cites.
- **T5** — Resume with `--complexity=high` against a `complexity: low` status file: verify the `## Notes` audit entry, frontmatter updated, behavior switches to high for this run.
- **T6** — Doctor on a `complexity: low` plan: verify only the 9-check subset fires (no false-positive on missing eligibility cache, no false-positive on missing wakeup ledger).
- **T7** — Doctor on a `complexity: high` plan with no retro reference and no review tags: verify check #22 fires as Warning.
- **T8** — Mid-flow upgrade: `complexity: medium` plan resumed with `--complexity=high`; verify the codex_review threshold drops to `low` for this run, retro becomes required at completion.

### Acceptance criteria

- All 8 test cases pass on the hand-crafted runs.
- `bash -n` clean on the hook.
- Doctor reports clean on a fresh `complexity: medium` kickoff (regression check: existing behavior).
- Doctor reports clean on a fresh `complexity: low` kickoff with no follow-up activity.
- The behavior matrix in this spec matches the runtime behavior of the orchestrator end-to-end (verified by reading the activity log of a hand-crafted run).

## Open questions

- **OQ1.** `--quick` as alias for `--complexity=low`? Defer to plan; lean toward yes for ergonomics, but it's optional.
- **OQ2.** Should `complexity: low` also disable the auto-compact nudge at Step B3 / Step C step 1? Lean yes (`compact_loop_already_running` check is enough; the nudge is friction for small projects).
- **OQ3.** Does the resolution of `complexity_source` get its own `## Notes` line on first Step C entry, or only the activity log? Lean activity log only — `## Notes` is for human-relevant decisions.
- **OQ4.** Doctor #22's exact predicate: "lacks ALL three rigor signals" or "lacks ANY one"? Lean ALL — fires only when high-complexity plans are completely missing rigor evidence; less noisy.
- **OQ5.** Should `/masterplan stats` (Step T) report complexity distribution across plans? Lean yes; trivial extension; small enhancement to the existing `health_flags` rendering.

## Implementation footprint estimate

- **commands/masterplan.md edits**: ~10-15 sections touched (Step 0 flag/config parse + complexity resolver, Step 0 kickoff prompt, Step B2 brief parameterization, Step B3 frontmatter requirement table, Step C step 1 default derivation, Step C step 4 verification gates, Step C step 5 wakeup-ledger gate, Step D check-set gate + new check #22, Step M unchanged, Status file format section, Configuration schema section, Operational rules — `complexity` precedence rule).
- **CHANGELOG.md**: new `[Unreleased]` entry under "Added".
- **No code changes** to `hooks/masterplan-telemetry.sh` (telemetry sidecar is gated by `config.telemetry.enabled` AND complexity-derived default — both must be on).
- **No new files** in the plugin package itself; spec + plan + status file are normal `/masterplan` outputs.

Estimated +200 / -10 lines in `commands/masterplan.md`, plus ~30 lines in CHANGELOG. Single PR, single commit per task per /masterplan execute conventions.
