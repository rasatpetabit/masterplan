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
- Codex inline review moved from a standalone "Step C 3b" section into Step 4 as substep "4b", placed between CD-3 verification (4a) and the status update (4d), to fix an ordering bug where 3b documented "fires after Step 4's CD-3" but appeared before Step 4 in the document. New sub-step layout: 4a (verify) → 4b (codex review) → 4c (worktree integrity) → 4d (status update + commit).
- Step 3 gated checkpoint now expands the Codex option only under `codex_routing == auto`. Under `manual`, Step 3a's existing `AskUserQuestion` already handles routing, so combining was double-prompting.
- Step 4b's diff base is now the implementer's task-start commit SHA (returned in its digest), not `HEAD~1` — fixes wrong-diff bugs on multi-commit and zero-commit tasks.
- Step 4b retry caps now reference `config.codex.review_max_fix_iterations` instead of being hardcoded.
- Subagent dispatch table in the architecture section now includes Step C 4b (codex review) as its own row alongside Step C 3a (codex execution).
- Step B3 and Step I3 now include explicit field-population lists covering all required status frontmatter (slug, status, spec, plan, worktree, branch, started, last_activity, current_task, next_action, autonomy, loop_enabled, codex_routing, codex_review). Doctor check 9 widened to enforce the same set, and a new check 10 catches unparseable status files.

### Fixed
- `plugin.json` had an invented `dependencies` schema not used by Claude Code's plugin loader; removed (dependency documentation lives in the README).
- `superflow-retro` skill's "already exists" guard checked `<slug>-retro.md` while writes go to `YYYY-MM-DD-<slug>-retro.md`, so re-runs would silently create duplicate retros. Guard now globs `*-<slug>-retro.md`.
- README claimed "three-tier" precedence while listing four tiers. Fixed to "four-tier."
- README Flags table was missing `--resume`; added.
- README status file example was missing the new `codex_review` field; added.
- Step 0 now emits a flag-conflict warning when `--codex=off --codex-review=on` is passed (review is silently disabled when routing is off — the warning makes it visible).
- Step A handles malformed status files by skipping with a one-line note instead of failing the whole listing, and short-circuits to current+recent worktrees only when there are more than 20 worktrees.
- Step C 1 now has a parse guard that surfaces corrupted status files via `AskUserQuestion` instead of silently corrupting the run.
- Step C 5 (cross-session loop scheduling) now enforces `config.loop_max_per_day` via a wakeup ledger in the status file, blocking instead of scheduling once the daily quota is hit.

### Added
- README: "Useful flag combinations" section showing how autonomy and codex flags compose for common workflows.

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
