# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Subagent and context-control architecture** as a first-class design pillar in `/superflow` — explicit dispatch model per phase, model-selection guide (Haiku/Sonnet/Opus/Codex), bounded-brief contract (Goal/Inputs/Scope/Constraints/Return shape), output-digestion rules, and context-budget triggers.
- "Three design goals" header in the slash command prompt: thin orchestrator over superpowers, subagent-driven execution with context control, status file as only source of truth.
- New operational rules: "Subagents do the work; orchestrator preserves context" and "Bounded briefs, not implicit context."
- README: "Design philosophy" section that frames the three pillars for adopters, with the subagent dispatch model surfaced as the core differentiator.
- **Codex review of inline work** (Step C 3b): orthogonal to routing. When `codex_review: on`, after a task completes inline (Sonnet/Claude), Codex reviews the diff + verification output as a fresh-eyes pair against the spec. Severity-bucketed findings (high/medium/low). Decision matrix per autonomy: `gated` asks accept/fix-and-rereview/skip; `loose` blocks on high-severity; `full` attempts one auto-fix retry before blocking. Skips self-review on Codex-delegated tasks.
- New flags `--codex-review=on|off` and `--codex-review` shorthand. Status file gains `codex_review` field. Config gains `codex.review` and `codex.review_max_fix_iterations`.
- New operational rule: "Codex review is asymmetric — never self-review."

### Changed
- Plugin description reflects the subagent + context-control design goal.

## [0.1.0] — 2026-05-01

Initial release.

### Added
- `/superflow` slash command — orchestrates brainstorm → plan → execute via the superpowers skills.
- Subcommands: `import` (legacy artifact discovery + conversion), `doctor` (lint state across worktrees), `--resume=<path>` (resume a specific plan).
- Worktree-aware kickoff (Step B0): detects current state, recommends stay/use-existing/create-new with reasoned heuristics.
- Cross-worktree plan listing (Step A): scans every worktree of the current repo for in-progress plans.
- Configurable autonomy (`gated` / `loose` / `full`) per invocation, persisted in the status file.
- Self-paced cross-session loop scheduling via `ScheduleWakeup` when invoked under `/loop`.
- Codex routing toggle (`off` / `auto` / `manual`) with per-task eligibility heuristic and plan annotation overrides (`codex: ok` / `codex: no`).
- Completion-state inference for imported plans — multi-signal classifier (git log, filesystem, tests, checkboxes) with conservative classification.
- Status file format with worktree path, branch, autonomy, codex routing, and append-only activity log.
- `.superflow.yaml` configuration with three-tier precedence (CLI flags > repo-local > user-global > built-in).
- Context discipline rules (CD-1 through CD-10) mirroring the user's global execution style, threaded into the loop at high-leverage hook points.
- `superflow-detect` skill — surfaces a one-line suggestion to run `/superflow import` when legacy planning artifacts are detected. Never auto-runs the workflow.
- `superflow-retro` skill — generates a structured retrospective doc when a plan completes, with follow-up scheduling offers.
