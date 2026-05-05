# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] — 2026-05-04

### Added
- New `/masterplan stats` verb (Step T) — codex-vs-inline routing distribution,
  inline model breakdown (Sonnet/Haiku/Opus when activity logs carry
  `[subagent: <model>]` tags or `<plan>-subagents.jsonl` is populated), token
  totals by `routing_class`, decision-source breakdown, and per-plan health
  flags (degraded / cache-missing / silent-skip-suspected). Backed by new
  `bin/masterplan-routing-stats.sh` (~280-line bash + python3) supporting
  `--plan=<slug>`, `--format=table|json|md`, `--all-repos`, `--since=<date>`.
- New `unavailable_policy` config key under `codex:`. Default `degrade-loudly`
  preserves Fix 1 behavior (warn + degrade). Opt-in `block` halts before B/C/I
  with status: blocked when codex_routing != off and the codex plugin is
  unavailable. For users who'd rather a stuck plan than silent-codex-skip.
- Two new doctor checks. **#20**: codex_routing configured but eligibility
  cache file missing AND activity log shows ≥1 routing/completion entry —
  catches the cache-FILE footprint of silent codex degradation. **#21**: same
  symptom from the activity-log angle (no `eligibility cache:` evidence
  entries from Step C step 1) — catches the protocol-violation footprint.
  Total checks: 21.
- Pre-dispatch routing visibility. Step C step 3a now emits a `routing→CODEX`
  or `routing→INLINE` activity-log entry BEFORE dispatching, plus a stdout
  banner for real-time observability during /loop runs. Step 4b emits
  `review→CODEX` or `review→SKIP` symmetrically. Eligibility cache extended
  with `dispatched_to`/`dispatched_at`/`decision_source` runtime-audit fields.

### Changed
- Step 0 codex-availability detection no longer silently records degradation
  "on the next status-file write." Degradation now writes immediately on the
  next status update of the run (Step B3 close, Step C step 1's first write,
  or Step I3) AND emits a visible stdout warning + `## Notes` one-liner. If
  no status write would naturally happen this turn, the orchestrator forces a
  `## Notes`-only update so the marker lands. Per-task pre-dispatch banners
  (Fix 5) carry a `(codex degraded — plugin missing)` suffix when degradation
  is in effect.
- Step C step 1 now emits a mandatory `eligibility cache: <verdict>`
  activity-log entry per Step C entry (built / rebuilt / loaded / skipped
  variants + wave-pinned exception). Makes the silent-skip failure mode
  impossible to hide; doctor check #21 surfaces the absence at lint time.
- Step C step 3a now HALTS when codex_routing != off and eligibility_cache is
  missing — no more silent fallthrough to inline. Branches on
  `config.codex.unavailable_policy`: `degrade-loudly` surfaces a 4-option
  AskUserQuestion (Rebuild cache / Run inline with degradation marker / Set
  codex_routing: off / Abort); `block` sets status: blocked with a
  wave-mode-aware single-writer exception.
- Step C step 1 now performs a resume sanity check on every resume entry: scans
  the activity log for `**Codex:** ok`-annotated tasks completed inline without
  a `degraded-no-codex` decision_source. If found, surfaces a `## Notes`
  warning + 4-option AskUserQuestion (Continue / Run doctor / Investigate
  transcript / Suppress). Forensic recovery for plans that experienced silent
  codex-skip in a prior session.
- Stop hook (`hooks/masterplan-telemetry.sh`) now walks linked worktrees:
  fans out across `<root>/.worktrees/*/docs/superpowers/plans/`, matches by
  `worktree:` field equality OR `$PWD` prefix OR branch, picks
  most-recently-modified candidate. Resolves `plans_dir` to the chosen status
  file's parent so sidecar JSONLs land alongside worktree-resident plans
  (previously invisible to the hook).
- Stop hook subagent capture now dedups by `agent_id` (replacing the v2.3.0
  plan-keyed line cursor). Old cursor was invisible to multi-session runs and
  silently dropped dispatches — typical symptom: 0-line subagents.jsonl
  despite many actual dispatches. New mechanism reads existing JSONL into a
  seen-set and skips records already emitted. Each emission now carries a
  `routing_class` field (`"codex"` / `"sdd"` / `"explore"` / `"general"`)
  for greppable codex-routing distribution analytics.

### Fixed
- Codex degradation pattern silently bypassed all routing in optoe-ng
  project-review (root cause pinned to a specific transcript: 7 agents
  dispatched, zero codex-rescue, zero Step 0 warning text emitted, zero
  eligibility cache writes). Fixes 1-5 + P1-P5 prevention layer ensure
  silent recurrence is impossible: the orchestrator either has a populated
  eligibility cache + visible routing tags OR it has loud user-facing
  prompts + persistent markers — never quiet inline-bypass.
- Stop hook telemetry/subagents JSONL siblings now land for worktree-resident
  plans (previously invisible). Doctor check #19 description acknowledges the
  legacy `<slug>-subagents-cursor` files (deprecated v2.4.0) as harmless.
- Doctor table parallelization brief count synced across `commands/masterplan.md`
  and `docs/internals.md` (20 → 21 with the two new checks).

## [2.3.1] — 2026-05-04

### Changed
- Bare `/masterplan` is now resume-first: it auto-continues the current/only
  in-progress plan, opens the resume picker when active work is ambiguous, and
  shows the broad phase/operations menu only when no active plan exists.
- README install docs now include a Claude Desktop Code-tab path, scope guidance,
  and the `/superpowers-masterplan:masterplan` collision fallback.

### Fixed
- Runtime telemetry sidecars are now protected from accidental commits. This
  repo ignores generated `*-telemetry*.jsonl`, `*-subagents*.jsonl`, and
  `*-subagents-cursor` files, and downstream hook/Step C telemetry writers add
  matching patterns to `.git/info/exclude` before writing. If telemetry files
  are tracked or cannot be ignored, telemetry is skipped instead of written.

## [2.3.0] — 2026-05-04

**Model-dispatch contract + per-subagent telemetry layer.** Two threads bundled
into one minor release:

1. **Cost-leak fix.** Subagent dispatches now structurally require the `model:`
   parameter at every site (was prose-only). Without this, subagents inherited
   the orchestrator's Opus 4.7 silently — a real 2-day /masterplan-heavy session
   consumed 94% Opus ($458 of $487) despite the design intent of Haiku for
   mechanical extraction and Sonnet for general implementation.
2. **Per-subagent observability.** Stop hook now captures one record per Agent
   dispatch into `<plan>-subagents.jsonl`, with full token breakdown
   (`input/output/cache_creation/cache_read`), duration, dispatch-site
   attribution, subagent_type, model, and tool_stats. Six jq cookbook recipes
   added so "find the biggest token consumers and optimize them" is tractable
   instead of guessing.

### Added
- **`### Agent dispatch contract` subsection** under `## Subagent and
  context-control architecture` in `commands/masterplan.md`. Normative MUST
  language plus a value-by-use table (`haiku` = mechanical, `sonnet` =
  implementation, `opus` = user-escalated only). Includes a recursive-application
  clause for skill invocations and a Codex exemption.
- **Recursive override clause for SDD invocation** at Step C step 2. Tells
  `superpowers:subagent-driven-development` to pass `model: "sonnet"` on its
  inner Task calls (implementer / spec-reviewer / code-quality-reviewer) —
  required because SDD's prompt-template files are upstream and don't carry
  model parameters by default.
- **`<plan>-subagents.jsonl`** stream — one record per subagent dispatch
  emitted by `hooks/masterplan-telemetry.sh`. Cursor-based incremental parsing
  via `<plan>-subagents-cursor` keeps the hook fast on long sessions.
- **`DISPATCH-SITE:` tag convention** for every Agent brief — a central
  contract table in `commands/masterplan.md` enumerates the 14 dispatch-site
  values so the hook can attribute cost to orchestrator-step granularity
  (Step A vs Step C step 1 vs wave vs SDD vs etc.).
- **Doctor check #19** — orphan `<plan>-subagents.jsonl` /
  `<plan>-subagents-cursor` files (sibling to a missing status file). Suggests
  archive on `--fix`. Doctor check #12 extended to also catch
  `<plan>-subagents.jsonl > 5 MB`; rotates to `-archive.jsonl`.
- **Six jq cookbook recipes** in `docs/design/telemetry-signals.md`:
  top-N dispatches by total tokens, per-subagent_type aggregates,
  per-dispatch-site aggregates, per-model breakdown by site,
  anomaly detection (>2σ above type mean), cost trend over 14 days.
- **First automated runtime smoke test** for the project: hand-crafted JSONL
  fixture with three Agent dispatches verifies the hook's record emission,
  cursor advancement, and idempotence under re-runs.

### Fixed
- **14 inline dispatch sites** in `commands/masterplan.md` now carry explicit
  `model:` instructions: Step A status parse (`haiku`), Step B0 worktree scan
  (`haiku`), Step C step 1 eligibility cache builder (`haiku`), Step C step 2
  wave dispatch (`sonnet`), Step C step 2 SDD invocation (`sonnet`, recursive
  override), Step C step 3 Codex EXEC (exempt note), Step C 4b Codex REVIEW
  (exempt note), Step I1 discovery (`haiku`), Step I3.2 fetch (per-candidate
  `haiku` / `sonnet` / no-Agent), Step I3.4 conversion (`sonnet`), Step S1
  situation gather (`haiku`), Step R2 retro source (`haiku`), Step D doctor
  (`haiku`), Completion-state inference (`haiku`).
- **Blocker re-engagement gate option 2** ("Re-dispatch with a stronger model")
  now actually dispatches with `model: "opus"` on the re-dispatch Agent call.
  Previously a UI-only promise — the option label promised behavior the prompt
  didn't structurally deliver.

### Migration notes
- **Hook re-install required.** `hooks/masterplan-telemetry.sh` gained ~120
  lines (subagent-capture pipeline). Users with the hook installed at
  `~/.claude/hooks/masterplan-telemetry.sh` must `cp` the new version per the
  README install instructions. Old hook continues working (still emits
  per-turn records) but doesn't capture per-dispatch data.
- **Existing telemetry files keep working.** `<plan>-telemetry.jsonl` schema
  is unchanged from v2.2.x. New `<plan>-subagents.jsonl` and
  `<plan>-subagents-cursor` files appear once the new hook runs.
- **No config or status schema change.** Status frontmatter unchanged. Doctor
  table now 19 rows (was 18). CD-rule numbering (CD-1…CD-10) unchanged — the
  dispatch contract lives under `## Subagent and context-control architecture`,
  not as a new CD rule.
- **SDD upstream not modified.** The model-passthrough override contains the
  fix to `/masterplan`. If future upstream SDD changes ignore the override
  clause, fallback is to wrap SDD invocation in an outer `Agent(subagent_type:
  "general-purpose", model: "sonnet", ...)`.

### Verification
- 10 grep discriminators (contract section landed once, ≥14 `model:`
  parameters, Codex exemption notes ≥2, opus-on-blocker wire-up,
  `<plan>-subagents.jsonl` referenced in hook, 14 `DISPATCH-SITE` values in
  the contract table, doctor check #19 + Step D brief at "all 19 checks",
  new schema in telemetry-signals.md, version bumps consistent across
  CHANGELOG/README/plugin.json/marketplace.json).
- `claude plugin validate .` — clean.
- `bash -n hooks/masterplan-telemetry.sh` — clean.
- Smoke fixture against the new hook (3 dispatches → 3 records, cursor
  advancement, idempotence on re-run).

## [2.2.3] — 2026-05-04

**Marketplace-readiness patch.** Fixes Claude Code plugin validation blockers
and adds the missing repository marketplace catalog needed by the documented
install path.

### Added
- **`.claude-plugin/marketplace.json`** — publishes this repository as a
  self-contained marketplace named `rasatpetabit-superpowers-masterplan`, with
  the `superpowers-masterplan` plugin sourced from the repository root.
- **Dependency metadata** — declares `superpowers@claude-plugins-official` as
  the required upstream plugin and allowlists the official marketplace for that
  cross-marketplace dependency.
- **`docs/release-submission.md`** — durable submission checklist and form-copy
  draft for the Claude plugin directory / Anthropic Verified review request.

### Fixed
- **`plugin.json` schema drift** — `repository` is now the string form required
  by current Claude Code validation, not an npm-style `{type,url}` object.
- **`commands/masterplan.md` frontmatter** — quoted the description so the
  colon in `Verbs:` parses as YAML instead of dropping metadata at runtime.
- **Manifest description** — shortened to a marketplace-friendly summary rather
  than embedding release-history detail in plugin metadata.

### Verification
- `claude plugin validate .`
- `claude plugin validate .claude-plugin/plugin.json`
- `jq empty .claude-plugin/plugin.json .claude-plugin/marketplace.json .claude/settings.local.json`
- `bash -n hooks/masterplan-telemetry.sh`
- `git diff --check`
- Isolated clean install smoke with a temporary `HOME`, official marketplace
  dependency resolution, local marketplace add, and
  `claude plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan`.

## [2.2.2] — 2026-05-04

**Removed standing "no backward-compat / hard-cut renames" rule.** Documentation-only patch. Going forward, decisions about migration aliases for breaking renames are made case-by-case rather than dictated by a project-level prohibition.

### Removed
- **`CLAUDE.md` "Top anti-patterns" #2** — the "Don't add backward-compatibility shims when renaming things" rule. Surrounding 5 (renumbered) anti-patterns stay.
- **`docs/internals.md` `### Why hard-cut name changes` subsection** plus the corresponding bulleted entry under "Architectural anti-patterns".
- **Project-scoped auto-memory entry** (`feedback_no_backward_compat_aliases.md` + its `MEMORY.md` index line). Project memory is reset on this topic.

### Changed
- **README top-of-file rewritten.** New tagline and `## Key benefits` section with three structured categories (long-term planning consistency, token efficiency, cross-checking via Codex) replace the previous "Overview" + "What it provides" prose. Substance unchanged; framing now leads with concrete user-facing benefits before drilling into install + command surface.
- **`WORKLOG.md` v2.2.0 entry** — two policy-framing references scrubbed (the deleted `Why hard-cut renames` heading rewrite reference; the "Hard-cut, no alias." preface on the verb-rename narrative). Functional record of what changed in v2.2.0 unchanged.

### Migration notes
- **No code or behavior change.** Orchestrator, status schema, command surface, and config schema all unchanged. Past breaking renames (`new → full`, `claude-superflow → superpowers-masterplan`, etc.) stay shipped — only the rule that drove those decisions is being removed.
- **No replacement rule added.** Future renames are now case-by-case. If you want a heuristic: prefer hard-cuts for tiny user surfaces (e.g., a single command verb) and consider migration aliases when renaming high-traffic config keys or frequently-typed paths.

## [2.2.1] — 2026-05-04

**Inline status preamble on bare `/masterplan`.** Patch release adding orientation + doctor-tripwire signal to the bare-invocation flow; cleanup pass also removes stray feature branches + worktrees from origin in preparation for wider public visibility.

### Added
- **Step M0 — Inline status orientation on bare `/masterplan`.** Before the Tier-1 picker fires, the orchestrator emits a structured plain-text preamble: headline (`<N> in-flight, <M> blocked across <W> worktrees`), up to 3 in-flight/blocked plan bullets with `current_task` + age, optional `… and N more` tail, and an optional `· <K> issue(s) detected — consider /masterplan doctor` tripwire flag. The tripwire runs 7 cheap inline checks (subset of the 18 doctor checks: #2 orphan status, #3 wrong worktree, #4 wrong branch, #5/#6 stale, #9 schema violation, #10 unparseable) — all derivable from frontmatter + the `git_state` cache already in memory; no Haiku dispatch. The empty-state line is `No active plans.` Step A consumes a `step_m_plans_cache` short-circuit when invoked from "Resume in-flight" so the worktree scan doesn't run twice.

### Changed
- **"Stay on script" guardrail** at Step M's Notes updated (not replaced) to acknowledge M0's structured preamble while reaffirming the no-tangents rule and explicitly forbidding per-check enumeration in the preamble — that remains `/masterplan doctor`'s job. Doctor table size stays at 18; M0 reuses checks by name + semantics, no new check #19.

### Fixed
- Documentation now consistently describes the v2.2.0 surface: bare `/masterplan` opens the two-tier picker, README release/status text names v2.2.0 as current, README's full config schema matches the v2.x defaults, and `docs/internals.md` mirrors the Step M empty-argument route.
- README simplified into a tighter user guide, and command prompt docs now match the advertised public surface: `--no-codex-review` is listed as the `--codex-review=off` shorthand, `--parallelism` is documented as a run/config override rather than a status-frontmatter field, and stale future-only wording for Slice α parallelism is removed.

### Migration notes
- **Purely additive on bare `/masterplan`.** Direct verb invocations (`/masterplan full ...`, `/masterplan execute`, etc.) are unchanged — M0 only fires for empty `$ARGUMENTS`. Existing plans, status files, and `.masterplan.yaml` configs work unchanged.
- **No new doctor check.** M0's tripwire reuses existing checks #2/#3/#4/#5/#6/#9/#10 evaluated inline. The full `/masterplan doctor` lint surface is unchanged at 18 checks.

## [2.2.0] — 2026-05-04

**Doc revisionism + verb rename + no-args picker.** Three threads bundled. The bare `/masterplan` invocation now opens a two-tier picker menu (category → specific verb) so first-touch users don't have to memorize the verb table. The kickoff verb `new` is renamed to `full` (breaking — no alias). Doc revisionism cleanup removes pre-v1.0.0 release-history references throughout the repo.

### Added
- **Two-tier no-args picker (Step M).** `/masterplan` (no args) now surfaces an `AskUserQuestion` menu. Tier 1: Phase work / Operations / Resume in-flight / Cancel. Tier 2a (Phase work): brainstorm / plan / execute / full + topic prompt. Tier 2b (Operations): import / status / doctor / retro. "Resume in-flight" delegates to Step A's existing list+pick. "Cancel" exits cleanly.

### Changed
- **`new` verb renamed to `full`.** All sync'd locations updated: frontmatter description, Step 0 routing table rows, reserved-verbs warning, argument-parse precedence list, README verb table + quick-start examples + reserved-verb prose + Aliases-and-shortcuts table, `docs/internals.md` Step 0 mirror.
- **Doc revisionism pass.** Removed all pre-v1.0.0 (v0.x) release-history references from CHANGELOG (older blocks deleted entirely + remaining v0.x mentions in v1.0.0/v2.0.0 entries scrubbed), README ("Path to v2.0.0" → "Releases since v1.0.0", v0.x bullets removed), `docs/internals.md` (v0.x parentheticals dropped from "Why" section headings + audit-pass bullet wording), `docs/design/intra-plan-parallelism.md` + the v1.1.0 spec ("v0.1 → v0.2 → v0.3 → v0.4 → v1.0.0" deferral-chain framing rewritten as "deferred prior to v1.0.0"). WORKLOG v2.0.0 entry's rename narrative trimmed; functional deliverables (parallelism Slice α, Codex defaults, internal docs) preserved.

### Migration notes
- **Breaking:** `/masterplan new <topic>` is now `/masterplan full <topic>`. No alias. Memorize the new verb. (The bare-topic shortcut `/masterplan <topic>` continues to work and routes to the same flow as `full`.)
- **No-args picker is additive** for users who previously used bare `/masterplan` to reach the worktree picker — they now select "Resume in-flight" (one extra click) to land in the same Step A logic. Direct verb invocations (`/masterplan full ...`, `/masterplan execute`, etc.) bypass the picker entirely.
- **Doc revisionism is non-breaking** — only documentation surface changes; orchestrator behavior is unchanged for these edits.
- **No status-file or config schema changes.** Existing plans and `.masterplan.yaml` files work unchanged.

## [2.1.0] — 2026-05-04

**README polish + gated→loose switch offer + Roadmap section.** Additive release on the v2.x track; no breaking changes. Adds a benefits paragraph + a "Defaults at a glance" YAML block + a "Roadmap" section to README. Adds a one-time AskUserQuestion at Step C step 1 offering to switch from `--autonomy=gated` to `--autonomy=loose` when a long plan (≥15 tasks by default) is in progress — reduces friction for users who don't want to click through every per-task gate on a trusted plan.

### Added
- **README `## Why this exists` rewritten + reordered** to precede `## What you get`. New 6-bullet benefits paragraph: long-term complex planning, aggressive context discipline, dramatic token reduction, parallelism for faster operation, cross-session resume, cross-model review.
- **README `### Defaults at a glance`** sub-section under `## Configuration`. Compact YAML block (~50 lines) showing every default in one scannable view, with one-line comments for the most-overridden fields. Full schema with explanations follows below.
- **README `## Roadmap`** top-level section between `## Project status` and `## Author`. Surfaces 6 deferred items + 4 documented non-features. Each deferred item has a measurable revisit trigger.
- **Gated→loose switch offer (v2.1.0+).** New AskUserQuestion at Step C step 1 (after telemetry inline snapshot, before the per-task autonomy loop): when `autonomy == gated` AND `config.gated_switch_offer_at_tasks > 0` AND plan task count ≥ threshold AND not already dismissed/shown, offer 4-option switch:
  - Switch to `--autonomy=loose` (Recommended for trusted plans)
  - Stay on gated
  - Switch + don't ask again on any plan (recommends user edit `.masterplan.yaml`; orchestrator does NOT modify user's config per CD-2)
  - Stay + don't ask again on this plan (sets `gated_switch_offer_dismissed: true` in status frontmatter)
- **Config key `gated_switch_offer_at_tasks: 15`** (top-level; default 15). Set to 0 to disable the offer entirely.
- **Status file frontmatter optional fields:**
  - `gated_switch_offer_dismissed: true` — permanent per-plan suppression of the offer.
  - `gated_switch_offer_shown: true` — per-session suppression (re-fires on cross-session resume by design — gives the user another chance after a break).

### Changed
- README section ordering: `## Why this exists` now precedes `## What you get` (value pitch before surface area). Existing content of both sections preserved verbatim except for the new benefits paragraph appended to "Why this exists."
- Plugin.json description mentions the gated→loose offer.

### Migration notes
- **No breaking changes.** Additive release. Existing `.masterplan.yaml` files without `gated_switch_offer_at_tasks` get the default 15.
- Users who never want the gated→loose offer set `gated_switch_offer_at_tasks: 0` in `.masterplan.yaml`.
- Users who want the offer on but with a different threshold (e.g., 25 tasks) override per-repo or globally in `~/.masterplan.yaml`.
- Status frontmatter fields `gated_switch_offer_dismissed` and `gated_switch_offer_shown` are both optional. Doctor check #9 (schema-required-fields) is unchanged — these fields aren't required.

## [2.0.0] — 2026-05-04

**Intra-plan parallelism Slice α + Codex defaults on.** Single coherent v2.0.0 release bundling Slice α of intra-plan task parallelism (read-only parallel waves only — verification, inference, lint, type-check, doc-generation; implementation tasks remain serial), Codex defaults flipped to on with graceful-degrade when codex plugin isn't installed, a new `## Codex integration` README section, internal documentation for LLM contributors (`CLAUDE.md` + `docs/internals.md`), and pruning of older spec/plan/WORKLOG history (institutional knowledge migrated to `docs/internals.md`).

### Added
- **`**parallel-group:** <name>` plan annotation.** Tasks sharing the same `<name>` value dispatch as one parallel wave in Step C step 2. Read-only only (verification, inference, lint, type-check, doc-generation). Mutually exclusive with `**Codex:** ok`. Requires complete `**Files:**` block (becomes exhaustive scope under wave). See [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md) for the failure-mode catalog and Slice β/γ deferral.
- **Wave dispatch in Step C step 2** — contiguous-plan-order wave assembly; per-instance bounded brief (DO NOT commit, DO NOT update status); parallel `Agent` dispatch; wave-completion barrier.
- **Single-writer status funnel in Step C 4d** — orchestrator aggregates wave digests, computes `current_task` as lowest-indexed not-yet-complete, appends N entries to `## Activity log` in plan-order with `[wave: <group>]` tag, runs wave-aware activity log rotation (fires once per wave per FM-2), commits status file once per wave with subject `masterplan: wave complete (group: <name>, N tasks)`.
- **Files-filter in Step C 4c under wave** — single porcelain check filters against union of all wave-task `**Files:**` declarations (post-glob-expansion) plus implicit-paths whitelist.
- **Eligibility cache pin (M-2 mitigation)** — `cache_pinned_for_wave` flag suppresses mtime invariant during wave; new CD-2 in-wave scope rule forbids wave members from modifying plan/status/cache.
- **Per-member outcome reconciliation** — three outcomes (`completed` / `blocked` / `protocol_violation`); `protocol_violation` detected by orchestrator post-barrier (commits despite "DO NOT commit", out-of-scope writes, status file modification).
- **Wave-level outcomes** — all-completed / all-blocked / partial. Partial preserves K completed digests UNLESS `parallelism.abort_wave_on_protocol_violation: true` (default), in which case the entire 4d batch is suppressed.
- **Blocker re-engagement gate integration** — fires once at wave-end with the union of N-K blocked members; option semantics extend naturally.
- **Step C 5 wave-count threshold** — wave-end counts as ONE completion regardless of N (a wave of 5 doesn't trigger 5 wakeup-threshold increments).
- **3 new doctor checks (#15-17, total 14 → 18 with #18):** parallel-group without Files: block; parallel-group + Codex: ok mutual conflict; file-path overlap within parallel-group.
- **Doctor check #18: Codex config on but plugin missing.** Flags persistent misconfiguration when `codex.routing != off` OR `codex.review == on` AND no `codex:` skill in scope at lint time. Step 0's auto-degrade handles per-run; doctor surfaces persistent state.
- **Step 0 codex-availability detection (graceful degrade).** When config has codex on but plugin not installed, emit one-line warning and treat both routing + review as `off` for the run. Persisted config is unchanged.
- **`hooks/masterplan-telemetry.sh` gains `tasks_completed_this_turn` (int) + `wave_groups` (array of strings) fields** — FM-3 mitigation. Linux smoke-tested; macOS portable-by-construction (not smoke-tested).
- **New `parallelism:` config block** — `enabled` (kill switch, default true), `max_wave_size` (default 5), `abort_wave_on_protocol_violation` (default true).
- **New `--parallelism=on|off` and `--no-parallelism` CLI flags.**
- **Step B2 writing-plans brief paragraph** — guidance for the planner on emitting `parallel-group:` annotations.
- **README `## Codex integration` section** (~490 words). Covers why/how/defaults/install/disable/cross-references.
- **`CLAUDE.md` at repo root** (~620 words) — always-loaded project orientation for Claude Code sessions in this repo. Top anti-patterns, operating principles, doc index.
- **`docs/internals.md`** (~8000 words, 15 sections) — comprehensive deep-dive for future LLM contributors: architecture, dispatch model, status format, CD rules, operational rules, wave dispatch + failure-mode catalog FM-1 to FM-6, Codex integration, telemetry, doctor checks, verb routing, design history, common dev recipes, anti-patterns, cross-references.

### Changed
- **`codex.review` default flipped: `off` → `on`.** Behavior change. Users who don't want Codex to review every inline-completed task should set `codex.review: off` in `.masterplan.yaml` or pass `--no-codex-review`. (Auto-degrades to `off` when codex plugin not installed — no impact on users without Codex.)
- **Step C step 1 eligibility cache schema extended** with `parallel_group`, `files`, `parallel_eligible`, `parallel_eligibility_reason` (all optional; backward-compatible with prior cache files which load with `parallel_eligible: false`).
- **Step D parallelization brief: `each agent runs all 14 checks` → `each agent runs all 18 checks`.**
- **`docs/design/intra-plan-parallelism.md` rewritten** — replaces brief design notes with v2.0.0 status doc (what ships in Slice α, what's deferred, sharpened revisit trigger, failure-mode catalog summary).
- **`docs/design/telemetry-signals.md`** — documents the two new fields with first-turn caveat; adds "Average tasks-per-wave-turn" jq example.
- **README** — Plan annotations table adds `parallel-group:` + `non-committing:` rows; Useful flag combinations adds `--no-parallelism` row; "Path to v2.0.0" entry added; Project status bumped; Useful flag combinations row for default invocation updated to mention `codex.review: on` v2.0.0 default + graceful-degrade.

### Removed
- **5 older spec/plan files pruned.** Knowledge migrated to `docs/internals.md` §12 (Design decisions).
- **Older WORKLOG entries trimmed.** Only the v2.0.0 entry remains. CHANGELOG retains the full release history.

### Migration notes

**Required user steps for v1.0.0 → v2.0.0 upgrade:**

1. **`codex.review` is now on by default.** If you don't have the codex plugin installed, this auto-degrades silently with a one-line warning at Step 0. If you have codex installed but DON'T want auto-review, set `codex.review: off` in `.masterplan.yaml`.
2. **Existing in-flight plans keep working** — status file paths inside `docs/superpowers/plans/` are unchanged. Resume with `/masterplan execute <status-path>`.
3. **Eligibility cache files** (`<slug>-eligibility-cache.json`) created prior to v2.0.0 are valid — load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.

**No status-file schema changes** beyond the optional new eligibility cache fields. Existing status files load unchanged.

---

## [1.0.0] — 2026-05-03

**First stable public release.** Consolidates retrospective generation into the `/masterplan retro` verb (replacing the previously-auto-firing `masterplan-retro` skill), standardizes terminology on "verbs" instead of mixing "subcommands" and "invocation forms," and applies a pre-release audit fix pass that closed 10 blockers and 13 polish items found by three parallel fresh-eyes Explore agents auditing the orchestrator, telemetry hook, remaining skill, and human-facing docs.

### Added
- **`/masterplan retro [<slug>]` verb.** Generates a retrospective doc for a completed plan and writes it to `docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md` with outcomes, blockers, deviations, follow-ups, and Codex routing observations. With no slug, picks from completed plans that don't yet have a retro; with one candidate, runs without a picker. New `Step R` section in `commands/masterplan.md` (R0 resolve target → R1 pre-write guard → R2 gather → R3 synthesize + write → R4 offer follow-ups). Pre-write guard globs `*-<slug>-retro.md` so re-runs surface `Open / Generate v2 / Abort` instead of silently duplicating.
- **`new` (no topic) verb routing row.** `/masterplan new` with no topic now prompts for a topic via `AskUserQuestion` before falling through to Step B, mirroring the established `brainstorm` (no topic) handling. Previously bare `new` silently passed empty args to brainstorming.

### Removed
- **`masterplan-retro` skill removed.** Functionality consolidated into the `/masterplan retro` verb. The skill's auto-fire-on-plan-completion behavior is gone — retro generation is now explicit. Users who relied on the auto-suggestion can run `/masterplan retro` after a plan completes (it picks the most recent completed plan without a retro). The skill deletion drops one auto-trigger surface from the install footprint; `masterplan-detect` (parallel-shape skill that suggests `/masterplan import`) is retained.

### Changed
- **README terminology standardized on "verbs."** `## Subcommand reference` → `## Verb reference`. "Other subcommands" header in "What you get" → "Operation verbs" (paired with the existing "Phase verbs"). `### Invocation forms (back-compat detail)` → `### Aliases and shortcuts` (back-compat framing dropped — the bare-topic shortcut and `--resume=<path>` are documented aliases, not legacy forms). Slash command's `### Subcommand routing` → `### Verb routing`.
- **Verb reference table now uses "Effect" column instead of "Phases."** The previous "Phases" column was inaccurate for operation verbs (import/doctor/status/retro aren't pipeline phases). Each row now has a one-line effect description rather than `(unchanged)` placeholders.
- **Reserved-verb list expanded.** Step 0's "Verb tokens are reserved" warning previously listed only the four phase verbs; now lists all eight (new, brainstorm, plan, execute, retro, import, doctor, status) — matches what the routing table actually consumes.
- **README install (Option A) rewritten.** Previous text was gated on a future condition. Replaced with the current `/plugin marketplace add rasatpetabit/superpowers-masterplan` + `/plugin install` flow, with the interactive `/plugin` Discover tab documented as a syntax-drift fallback.

### Fixed
- **Doctor section was missing its `## Step D` header.** The section started directly with `### Scope` after Step S4. Restored the `## Step D — Doctor` heading.
- **Doctor parallelization brief told each Haiku worker to run "all 10 checks"** but the doctor checks table has 14 entries. Workers were silently skipping orphan archive, telemetry growth, orphan telemetry, and orphan eligibility cache. Corrected to "all 14 checks."
- **Step I3.4's status-file conversion brief omitted `compact_loop_recommended`** from its required frontmatter enumeration. Doctor check #9 requires the field; every imported plan would have failed schema validation immediately. Field added to the brief.
- **Step 4b's zero-commit handling contradicted itself.** Step 1 said "skip 4b for zero-commit tasks"; step 2's rationale paragraph said "inline the diff via the existing fallback in step 1" (no such fallback existed). The stale fallback claim was removed.
- **Step C dispatch guard misstated B1's "Continue to plan now" path.** The guard described a non-existent composite option `"Continue to plan now → Start execution now"` blending B1 (which flips `halt_mode` to `post-plan`) with B3 (which flips it to `none`). Rewrote to clarify the actual flow: B1's flip falls through B2 to B3, where the user explicitly picks "Start execution now" to enter Step C. B3's `post-plan` close-out gate description and B2's dispatch guard prose were updated to match.
- **Blocker re-engagement gate had 5 options, violating CD-9's 2–4 cap.** Dropped option 3 ("Break this task into smaller pieces — pause so I can edit the plan to decompose, then continue") since it overlapped semantically with option 1 ("Provide context and re-dispatch"). Option 5 (the legacy `status: blocked` end-turn path) is preserved — resume-from-blocker depends on it being the only path to the legacy blocked state.
- **Dispatch model table cell referenced a nonexistent "Task 2."** Stale draft pointer; removed.
- **Codex annotation syntax was inconsistent across the orchestrator.** Eligibility checklist and the operational-rule mention used lowercase `codex: ok|no`; the canonical syntax block and the eligibility-cache builder used `**Codex:** ok|no` (bold, capital). Plan authors had no way to know which form the parser expected. Standardized on `**Codex:** ok|no` everywhere.
- **README verb-table cell** pointed readers to "see invocation forms below" — that section is now called `### Aliases and shortcuts`. Dangling anchor; updated.
- **`docs/design/telemetry-signals.md`'s "Tokens-per-turn estimate"** `jq foreach` query was broken: the UPDATE expression `$r` overwrote the accumulator each iteration, so `growth = $r.transcript_bytes - $r.transcript_bytes = 0` for every record. Rewrote using `range`-based indexed access; verified against a 3-record fixture that growth values are now real (non-zero where expected).
- **`hooks/masterplan-telemetry.sh` used GNU-only `find -quit` and `find -printf`** — both silently break on macOS BSD `find`. The most-used transcript-resolution fallback returned no output on macOS. Rewrote with portable `head -n1` and a `stat -c '%Y' || stat -f '%m'` dual form. Verified end-to-end on Linux; the macOS path is portable-by-construction but not smoke-tested (call for issues added to the README).
- **`hooks/masterplan-telemetry.sh` had no `jq` presence check** despite declaring jq as Required in the header. Without jq, the hook silently wrote nothing forever. Added explicit `command -v jq` guard at startup that bails silently if jq is absent.
- **`hooks/masterplan-telemetry.sh` wakeup-count cutoff** could become empty in stripped or musl-libc environments where neither GNU `date -d` nor BSD `date -v` works. Awk's `ts > ""` is true for every non-empty timestamp, so `wakeup_count_24h` would over-count every wakeup ever recorded. Added a sentinel cutoff (`9999-12-31T23:59:59Z`) that produces zero matches when both date forms fail — safe degraded behavior beats silent over-counting.

### Polish
- **Step P note** said "(Step B0a, below in Step B)"; B0a is *above* Step P. Direction corrected.
- **Completion-state inference header** claimed it was "(and optionally Step C on resume to validate the plan against current reality)"; no Step C site actually invokes it. Forward intention that was never wired up; claim removed.
- **B1 "Continue to plan now" option** didn't note that B0a's worktree check is skipped (already settled by the earlier B0 run). Parenthetical added.
- **Step I0 direct-import** ("skip discovery and jump to Step I3") didn't note that Step I2 (rank+pick) is also skipped — the candidate is already determined. Added.
- **Activity log archive description** overstated `/masterplan doctor`'s involvement — doctor only flags orphan archives via check #11, doesn't read content. Removed the misleading "and by `/masterplan doctor`" clause.
- **Telemetry hook had a dead `out_file` assignment** (line 80 was overwritten by line 82) with a comment that described line 82's behavior, not line 80's. Removed the dead line and the orphan comment.
- **`masterplan-detect` skill body** described two detection execution paths (Claude Code `Glob` tool vs shell `fd` snippets) as a single mechanism. Reframed as two layers: Glob is the always-available skill-tool path; the `fd` snippets in **Detection commands** give richer matching where `fd` is installed.
- **Historical status-file example** had a real `/home/ras/...` worktree path. Anonymized to `/home/you/...` to match the README's status-file example convention.
- **README hook section** softened to make the Linux-only smoke-test gap explicit: portable code paths are documented, but the macOS path hasn't been verified — readers are pointed at GitHub issues if telemetry doesn't land.

### Migration notes
- If you installed via Option B (manual copy) and copied `skills/masterplan-retro/` into `~/.claude/skills/`, you can safely `rm -rf ~/.claude/skills/masterplan-retro/`. The skill is no longer shipped or referenced.
- If you installed as a plugin (Option A), pulling v1.0.0 removes the skill automatically.
- No status-file or config schema changes. Existing plans, status files, and `.masterplan.yaml` files work unchanged.
