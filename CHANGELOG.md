# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-05-01

### Added
- **Plan annotation schema documented.** `**Codex:** ok|no` lines in per-task `**Files:**` blocks override the eligibility heuristic for Codex routing. Documented in `commands/superflow.md` Step C 3a (with concrete syntax example), threaded through Step C step 1's cache-builder brief, and surfaced in Step B2's brief to `superpowers:writing-plans` so new plans gain annotations when the planner judges tasks obviously suited or unsuited. New "Plan annotations" subsection in README.md. Pre-existing plans without annotations behave exactly as before (heuristic-only). The eligibility cache's `annotated` branch is no longer dead code.
- **Eligibility cache persists across wakeups.** Previously rebuilt every Step C entry via Haiku dispatch (~10 redundant calls per long run). Now written to `<slug>-eligibility-cache.json` (sibling to status), loaded on subsequent entries when `cache.mtime > plan.mtime`. Plan edits via Step 4d `touch` the plan to invalidate. New doctor check #14 catches orphan cache files. Operational rule updated; "never persisted to disk" claim retired.
- **`/superflow status` subcommand** — pure read-only situation report. Synthesizes status frontmatter + recent activity entries + blockers + notes + retros + telemetry trends + recent commits across all worktrees of the current repo into a salience-ordered report (in-flight, blocked, recently completed, stale, telemetry signals, worktree state, recent design notes). `--plan=<slug>` drills into one plan with full blockers/notes/last 20 activity entries/recent telemetry/latest retro/last 10 commits. Parallelizes per worktree via Haiku when N≥2. New Step S section in the orchestrator; new dispatch-table row.
- **CC-1 — Compact-suggest on observable symptoms.** End-of-turn check (before next wakeup scheduling) for `file_cache` ≥3 hits same path / ≥3 consecutive tool failures same target / activity log rotated this session / subagent returned ≥5K characters. On trigger, surfaces a non-blocking one-line notice recommending `/compact <focus>`. Per-plan dismissal via `compact_suggest: off` in status `## Notes`.
- **CC-2 — Subagent-delegate triggers (concrete thresholds).** Makes "Subagents do the work" enforceable: > 100 lines of expected Bash output → dispatch a Haiku; > 300 lines of substantive file reading → dispatch a Haiku; known-noisy verification commands (`build`, `test --verbose`, `cargo build`, `npm run build`, full-tree `find`) at Step C step 1 self-check → route through a subagent that returns pass/fail + ≤3 evidence lines.
- **Auto-compact loop nudge** — Step B3 + Step C step 1 surface a passive one-line notice once per plan recommending `/loop {interval} /compact {focus}` in a sibling session. Verified that CronCreate-backed `/loop` and `/superflow`'s ScheduleWakeup-backed wakeups occupy different slots and don't conflict. New status field `compact_loop_recommended` (status frontmatter; doctor schema-check widened). New config block `auto_compact: {enabled, interval, focus}` defaulting on at 30m.
- **Per-turn context-usage telemetry.** New `hooks/superflow-telemetry.sh` Stop-hook script (defensive — bails silently in non-superflow sessions) writes one JSONL record per turn to `<plan>-telemetry.jsonl` with transcript bytes/lines, status bytes, activity-log entry count, 24h wakeup count, branch, cwd. Plus inline snapshot in Step C step 1 for hook-less installs. Per-plan opt-out: `telemetry: off` in status frontmatter. Global toggle: `config.telemetry.enabled`. Field shape and `jq` queries documented in `docs/design/telemetry-signals.md`.
- **Doctor checks #12 + #13** — telemetry file growth (>5MB → rotate to `<slug>-telemetry-archive.jsonl`); orphan telemetry file (telemetry exists with no sibling status).
- **Parallelism + caching pass** for orchestrator latency. New parallel dispatch sites: Step A status-frontmatter parsing (one Haiku per worktree when N≥2), Step B0 git survey (single parallel Bash batch + per-worktree name-match scan when ≥2 non-current worktrees), Step C step 1 re-read (status + spec + plan + `pwd` + branch as one tool batch), Step C 4a verification (lint/typecheck/unit tests in one Bash batch with shared-artifact exclusion list), Step I3 source-fetch wave + conversion wave (per-candidate parallel; cruft + commit remain sequential per-candidate to keep a single git writer). Subagent dispatch model table updated with new rows.
- **Step 0 `git_state` cache** — caches `git worktree list --porcelain` and `git branch --list` once per invocation. Steps A, B0, D consult the cache. `git status --porcelain` is **explicitly never cached** (CD-2: stale dirty state risks overwriting user-owned changes).
- **Step C step 1 eligibility cache** — Codex eligibility for every plan task is computed once at plan-load by a single Haiku dispatch and cached as `eligibility_cache` for the run. Per-task routing decisions in Step C 3a become O(1) lookups instead of per-task LLM-shaped reasoning. Invalidated on plan-file mtime change. Never persisted to disk.
- **Step I3 slug-collision pre-pass** — when multiple imported candidates resolve to the same slug, auto-suffix `-2`, `-3`, etc. Confirms via `AskUserQuestion` when ≥ 2 collision groups detected.
- **Step I1 within-agent batching guidance** — each Explore agent's brief now requires issuing all globs/finds/`gh` calls as one parallel tool batch (within its turn).
- **"Future: intra-plan task parallelism" design notes** in operational rules — annotation schema (`parallel-group`, `depends-on`, `files`), required safety machinery (per-task git worktree isolation, single-writer status file, rollback policy), and why this is deferred (git index races on concurrent commits to same branch warrant their own dedicated plan).
- **Subagent and context-control architecture** as a first-class design pillar in `/superflow` — explicit dispatch model per phase, model-selection guide (Haiku/Sonnet/Opus/Codex), bounded-brief contract (Goal/Inputs/Scope/Constraints/Return shape), output-digestion rules, and context-budget triggers.
- "Three design goals" header in the slash command prompt: thin orchestrator over superpowers, subagent-driven execution with context control, status file as only source of truth.
- New operational rules: "Subagents do the work; orchestrator preserves context" and "Bounded briefs, not implicit context."
- README: "Design philosophy" section that frames the three pillars for adopters, with the subagent dispatch model surfaced as the core differentiator.
- **Codex review of inline work** (Step C 3b): orthogonal to routing. When `codex_review: on`, after a task completes inline (Sonnet/Claude), Codex reviews the diff + verification output as a fresh-eyes pair against the spec. Severity-bucketed findings (high/medium/low). Decision matrix per autonomy: `gated` asks accept/fix-and-rereview/skip; `loose` blocks on high-severity; `full` attempts one auto-fix retry before blocking. Skips self-review on Codex-delegated tasks.
- New flags `--codex-review=on|off` and `--codex-review` shorthand. Status file gains `codex_review` field. Config gains `codex.review` and `codex.review_max_fix_iterations`.
- New operational rule: "Codex review is asymmetric — never self-review."

### Changed
- **Step B0 surfaces SDD's trunk-branch refusal at decision time.** When the user is on a branch in `config.trunk_branches` (default `[main, master, trunk, dev, develop]`), the "Stay in current worktree" option's description now warns that `superpowers:subagent-driven-development` will refuse to start there. Previously the user found out at Step C (after the worktree decision was supposedly settled). Non-trunk branches are unchanged — no warning shown.
- **Gated mode no longer prompts on pre-configured Codex automation.** Under `--autonomy=gated`: (a) auto-routing decisions from the eligibility cache execute silently — the per-task question is no longer expanded with a Codex-override option when `codex_routing == auto`. (b) Codex review findings auto-accept silently when severity is below `config.codex.review_prompt_at` (default `"medium"`); only medium+ findings prompt. Activity log still tags every decision so the user sees what happened post-hoc, just doesn't gate on it. **Behavior change** — users who want the legacy chatty behavior set `codex.confirm_auto_routing: true` and `codex.review_prompt_at: "low"`. README config + Useful flag combinations table updated to document the new defaults.
- **Step 4a no longer re-runs implementer's tests.** SDD's implementer subagent runs project tests as part of TDD; previously Step 4a ran them again, duplicating token cost and CI time. Implementer return digest now includes `tests_passed: bool` and `commands_run: [str]` (required fields per the dispatch model table); Step 4a skips commands the implementer already ran cleanly and only runs *complementary* checks (lint, typecheck) the implementer didn't. New operational rule documents the trust contract and the protocol-violation handling for false-positive `tests_passed: true`.
- **Token-use optimization pass.** `commands/superflow.md` trimmed from 9038 → 8508 words (-530, ~-690 tokens / `/loop` wakeup) net of Phase 2 additions. Skill descriptions trimmed (-72 words combined, ~-94 tokens / Claude Code session). Plus variable savings on long-running plans (activity log rotation), Codex reviews (diff-by-SHA), and same-session resume (mtime gating). Specifics:
  - **CD-rule restatements compressed** at ~10 inline spots throughout the prompt — bare ID cites instead of paraphrased re-explanation. CD definitions block (lines 80–93) is the canonical reference and is unchanged.
  - **Operational rules section trimmed** of bullets that duplicate inline Step content (Re-read on resume, Atomic checkpoints, One plan per branch, Worktree is recorded, Cross-worktree visibility, Stop conditions, Config is loaded once). Cross-cutting policy bullets retained.
  - **"Why context control is load-bearing" prose compressed** — three paragraphs of justification → bulleted hold/discard list.
  - **Flag-conflict warning justification prose dropped** — the warning behavior remains; the rationale lives in CHANGELOG.
  - **"Future: intra-plan task parallelism" design notes moved out of the prompt** to `docs/design/intra-plan-parallelism.md`. They're docs, not orchestration logic.
  - **Step 4b Codex review brief now passes diff range (`<task-start SHA>..HEAD`) + file list** instead of inlining the full `git diff` output. Codex agent runs `git diff` itself (it's in the worktree). Saves 0 to 10K+ tokens per review depending on diff size. Falls back to inline diff via existing fallback if SHA isn't captured.
  - **Step C 4d activity log rotation.** When a status file's `## Activity log` exceeds 100 entries, archive all but the most recent 50 to `<slug>-status-archive.md` (oldest-first). Insert a one-line marker in the active log. Resume behavior is unchanged — the archive is consulted on demand by `superflow-retro` and by `/superflow doctor`. Saves 1K–5K tokens / wakeup on long-running plans (compounding).
  - **Step C step 1 in-session mtime gating** for spec/plan re-reads. In-memory `file_cache: {path → (mtime, content)}` skips re-reads when mtime is unchanged within the same session. Cross-session wakeups always re-read. Status file is never mtime-gated.
  - **Doctor check #11** — orphan archive files (`<slug>-status-archive.md` without sibling `<slug>-status.md`).
  - **superflow-detect/SKILL.md description**: 88 → 32 words. Trigger semantics unchanged; full body still loads on activation.
  - **superflow-retro/SKILL.md description**: 70 → 41 words. Same.
- **Step D doctor parallelization threshold lowered from N>3 to N≥2.** Haiku dispatch is cheap; the N=2,3 case (main + one feature worktree) is the common case and previously paid full sequential cost.
- **Step I3 conversions are now parallel waves** (fetch, then conversion) instead of fully sequential. Cruft handling and `git commit` remain sequential per-candidate (avoids git index races; user-interactive `AskUserQuestion`s would scramble UX in parallel).
- **Parallelism guidance section** in the architecture overview rewritten to enumerate every parallel dispatch site and to explicitly call out where sequentiality is intentional (per-candidate cruft + commit, per-task implementation in Step C, gated checkpoints).
- Plugin description reflects the subagent + context-control design goal.
- Codex inline review moved from a standalone "Step C 3b" section into Step 4 as substep "4b", placed between CD-3 verification (4a) and the status update (4d), to fix an ordering bug where 3b documented "fires after Step 4's CD-3" but appeared before Step 4 in the document. New sub-step layout: 4a (verify) → 4b (codex review) → 4c (worktree integrity) → 4d (status update + commit).
- Step 3 gated checkpoint now expands the Codex option only under `codex_routing == auto`. Under `manual`, Step 3a's existing `AskUserQuestion` already handles routing, so combining was double-prompting.
- Step 4b's diff base is now the implementer's task-start commit SHA (returned in its digest), not `HEAD~1` — fixes wrong-diff bugs on multi-commit and zero-commit tasks.
- Step 4b retry caps now reference `config.codex.review_max_fix_iterations` instead of being hardcoded.
- Subagent dispatch table in the architecture section now includes Step C 4b (codex review) as its own row alongside Step C 3a (codex execution).
- Step B3 and Step I3 now include explicit field-population lists covering all required status frontmatter (slug, status, spec, plan, worktree, branch, started, last_activity, current_task, next_action, autonomy, loop_enabled, codex_routing, codex_review). Doctor check 9 widened to enforce the same set, and a new check 10 catches unparseable status files.

### Fixed
- **Step 4b SHA fallback was a no-op.** When the implementer didn't return `task_start_sha`, Step 4b fell back to `git merge-base HEAD <branch-of-status>`. Since Step C step 1 enforces `current branch == status.branch`, that's `git merge-base HEAD HEAD` = HEAD, giving Codex review an empty diff range. `task_start_sha` is now required in the implementer's return digest; Step 4b blocks with a recoverable AskUserQuestion if it's missing. New operational rule documents the implementer-return contract; subagent dispatch model row in the architecture section calls out `task_start_sha` as required.
- **Unfounded "Step I3 conversions are sequential" premise** in the parallelism guidance section. The original wording ("one might inform the next via cruft-policy decisions") implied an inter-candidate dependency that doesn't exist — cruft policy comes from `config.cruft_policy` or flags, set once per import run. Conversions now parallelize.
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
