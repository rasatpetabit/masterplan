# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on the v2.0.0 rename:** This project was renamed from `claude-superflow` to `superpowers-masterplan` in v2.0.0; the `/superflow` slash command became `/masterplan`; `.superflow.yaml` became `.masterplan.yaml`. **Hard-cut, no backward-compat aliases.** Historical CHANGELOG entries (v0.x and v1.0.0) below are preserved verbatim; the names they reference are the names in use at the time of those releases. See `[2.0.0]` migration notes for the user-side rename steps.

## [Unreleased]

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

**Project rename + intra-plan parallelism Slice α + Codex defaults on.** Single coherent v2.0.0 release bundling the rebrand (claude-superflow → superpowers-masterplan; /superflow → /masterplan; hard-cut, no backward-compat aliases per user instruction), Slice α of intra-plan task parallelism (read-only parallel waves only — verification, inference, lint, type-check, doc-generation; implementation tasks remain serial), Codex defaults flipped to on with graceful-degrade when codex plugin isn't installed, a new `## Codex integration` README section, internal documentation for LLM contributors (`CLAUDE.md` + `docs/internals.md`), and pruning of pre-v1.1.0 spec/plan/WORKLOG history (institutional knowledge migrated to `docs/internals.md`).

### Renamed
- **Project:** `claude-superflow` → `superpowers-masterplan`. Plugin manifest's `name`, `homepage`, and `repository.url` updated. **User-side step:** rename your local install path / GitHub remote.
- **Slash command:** `/superflow` → `/masterplan`. **User-side step:** old `/superflow` command no longer exists. Install v2.0.0 to gain `/masterplan`.
- **Config file:** `.superflow.yaml` → `.masterplan.yaml` (and `~/.superflow.yaml` → `~/.masterplan.yaml`). **User-side step:** rename your config files. v2.0.0 ONLY reads `.masterplan.yaml` — `.superflow.yaml` is silently ignored. (No dual-load fallback; hard-cut per user instruction.)
- **File paths:** `commands/superflow.md` → `commands/masterplan.md`; `skills/superflow-detect/` → `skills/masterplan-detect/`; `hooks/superflow-telemetry.sh` → `hooks/masterplan-telemetry.sh`. Status files in user repos still reference the old paths if they were created pre-v2.0.0; they keep working but the new install path is masterplan-named.

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
- **Step C step 1 eligibility cache schema extended** with `parallel_group`, `files`, `parallel_eligible`, `parallel_eligibility_reason` (all optional; backward-compatible with pre-v2.0.0 cache files which load with `parallel_eligible: false`).
- **Step D parallelization brief: `each agent runs all 14 checks` → `each agent runs all 18 checks`.**
- **`docs/design/intra-plan-parallelism.md` rewritten** — replaces v0.1 brief notes with v2.0.0 status doc (what ships in Slice α, what's deferred, sharpened revisit trigger, failure-mode catalog summary, original v0.1 notes preserved as historical context).
- **`docs/design/telemetry-signals.md`** — documents the two new fields with first-turn caveat; adds "Average tasks-per-wave-turn" jq example.
- **README** — Plan annotations table adds `parallel-group:` + `non-committing:` rows; Useful flag combinations adds `--no-parallelism` row; "Path to v1.0.0" → "Path to v2.0.0" with new entry; Project status bumped; Useful flag combinations row for default invocation updated to mention `codex.review: on` v2.0.0 default + graceful-degrade.

### Removed
- **5 pre-v1.1.0 spec/plan files** pruned: `docs/superpowers/specs/2026-05-01-superflow-small-fixes-design.md`, `docs/superpowers/specs/2026-05-02-superflow-subcommands-design.md`, `docs/superpowers/plans/2026-05-01-superflow-small-fixes.md`, `docs/superpowers/plans/2026-05-01-superflow-small-fixes-status.md`, `docs/superpowers/plans/2026-05-02-superflow-subcommands.md`. Knowledge migrated to `docs/internals.md` §12 (Design decisions).
- **Pre-v2.0.0 WORKLOG entries** trimmed (v0.2.0, v0.3.0, v0.4.0, v1.0.0 audit-pass). Only the v2.0.0 entry remains. CHANGELOG retains the full release history.
- **Backward-compat aliases for the rename** — explicitly NOT shipped. No `/superflow` alias to `/masterplan`. No `.superflow.yaml` dual-load fallback. Hard-cut per user instruction.

### Migration notes

**Required user steps for v1.0.0 → v2.0.0 upgrade:**

1. **Uninstall the old plugin** if you installed `claude-superflow` via Option A (plugin marketplace): `/plugin uninstall claude-superflow`.
2. **Install v2.0.0:** `/plugin marketplace add rasatpetabit/superpowers-masterplan` then `/plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan`. Or per Option B (manual): `git clone` the new repo and copy `commands/masterplan.md`, `skills/masterplan-detect/`, `hooks/masterplan-telemetry.sh` into your `~/.claude/`.
3. **Rename your config file.** `mv .superflow.yaml .masterplan.yaml` (and similarly for `~/.superflow.yaml` if you had one). v2.0.0 only reads `.masterplan.yaml` — your old `.superflow.yaml` will be silently ignored.
4. **Re-install the Stop hook** (if you opted into telemetry): `cp hooks/masterplan-telemetry.sh ~/.claude/hooks/`. Update your `~/.claude/settings.json` Stop hook command to point at the renamed path.
5. **Existing in-flight plans keep working** — status file paths inside `docs/superpowers/plans/` are unchanged; the orchestrator just lives at a different install path. Resume with `/masterplan execute <status-path>`.
6. **Eligibility cache files** (`<slug>-eligibility-cache.json`) created pre-v2.0.0 are valid — load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.
7. **`codex.review` is now on by default.** If you don't have the codex plugin installed, this auto-degrades silently with a one-line warning at Step 0. If you have codex installed but DON'T want auto-review, set `codex.review: off` in `.masterplan.yaml`.
8. **`/superflow` slash command no longer works.** Use `/masterplan`. No backward-compat alias.

**No status-file schema changes** beyond the optional new eligibility cache fields. Existing status files load unchanged.

---

## [1.0.0] — 2026-05-03

**First stable public release.** Consolidates retrospective generation into the `/superflow retro` verb (replacing the previously-auto-firing `superflow-retro` skill), standardizes terminology on "verbs" instead of mixing "subcommands" and "invocation forms," and applies a pre-release audit fix pass that closed 10 blockers and 13 polish items found by three parallel fresh-eyes Explore agents auditing the orchestrator, telemetry hook, remaining skill, and human-facing docs.

### Added
- **`/superflow retro [<slug>]` verb.** Generates a retrospective doc for a completed plan and writes it to `docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md` with outcomes, blockers, deviations, follow-ups, and Codex routing observations. With no slug, picks from completed plans that don't yet have a retro; with one candidate, runs without a picker. New `Step R` section in `commands/superflow.md` (R0 resolve target → R1 pre-write guard → R2 gather → R3 synthesize + write → R4 offer follow-ups). Pre-write guard globs `*-<slug>-retro.md` so re-runs surface `Open / Generate v2 / Abort` instead of silently duplicating.
- **`new` (no topic) verb routing row.** `/superflow new` with no topic now prompts for a topic via `AskUserQuestion` before falling through to Step B, mirroring the established `brainstorm` (no topic) handling. Previously bare `new` silently passed empty args to brainstorming.

### Removed
- **`superflow-retro` skill removed.** Functionality consolidated into the `/superflow retro` verb. The skill's auto-fire-on-plan-completion behavior is gone — retro generation is now explicit. Users who relied on the auto-suggestion can run `/superflow retro` after a plan completes (it picks the most recent completed plan without a retro). The skill deletion drops one auto-trigger surface from the install footprint; `superflow-detect` (parallel-shape skill that suggests `/superflow import`) is retained.

### Changed
- **README terminology standardized on "verbs."** `## Subcommand reference` → `## Verb reference`. "Other subcommands" header in "What you get" → "Operation verbs" (paired with the existing "Phase verbs"). `### Invocation forms (back-compat detail)` → `### Aliases and shortcuts` (back-compat framing dropped — the bare-topic shortcut and `--resume=<path>` are documented aliases, not legacy forms). Slash command's `### Subcommand routing` → `### Verb routing`. CHANGELOG continues to use whatever term was historically there for prior entries.
- **Verb reference table now uses "Effect" column instead of "Phases."** The previous "Phases" column was inaccurate for operation verbs (import/doctor/status/retro aren't pipeline phases). Each row now has a one-line effect description rather than `(unchanged)` placeholders.
- **Reserved-verb list expanded.** Step 0's "Verb tokens are reserved" warning previously listed only the four phase verbs; now lists all eight (new, brainstorm, plan, execute, retro, import, doctor, status) — matches what the routing table actually consumes.
- **README install (Option A) rewritten.** Previous text was gated on a future condition (`# Once Claude Code's plugin install supports github.com URLs:`). Replaced with the current `/plugin marketplace add rasatpetabit/claude-superflow` + `/plugin install` flow, with the interactive `/plugin` Discover tab documented as a syntax-drift fallback.
- **CHANGELOG `[0.3.0]` had a non-standard `### Unchanged` subsection.** Renamed to `### Notes` (Keep-a-Changelog defines Added/Changed/Deprecated/Removed/Fixed/Security as the canonical six).

### Fixed
- **Doctor section was missing its `## Step D` header.** The section started directly with `### Scope` after Step S4. Restored the `## Step D — Doctor` heading.
- **Doctor parallelization brief told each Haiku worker to run "all 10 checks"** but the doctor checks table has 14 entries (checks 11–14 added in v0.2.0). Workers were silently skipping orphan archive, telemetry growth, orphan telemetry, and orphan eligibility cache. Corrected to "all 14 checks."
- **Step I3.4's status-file conversion brief omitted `compact_loop_recommended`** from its required frontmatter enumeration. Doctor check #9 requires the field; every imported plan would have failed schema validation immediately. Field added to the brief.
- **Step 4b's zero-commit handling contradicted itself.** Step 1 said "skip 4b for zero-commit tasks"; step 2's rationale paragraph said "inline the diff via the existing fallback in step 1" (no such fallback existed). The stale fallback claim was removed.
- **Step C dispatch guard misstated B1's "Continue to plan now" path.** The guard described a non-existent composite option `"Continue to plan now → Start execution now"` blending B1 (which flips `halt_mode` to `post-plan`) with B3 (which flips it to `none`). Rewrote to clarify the actual flow: B1's flip falls through B2 to B3, where the user explicitly picks "Start execution now" to enter Step C. B3's `post-plan` close-out gate description and B2's dispatch guard prose were updated to match.
- **Blocker re-engagement gate had 5 options, violating CD-9's 2–4 cap.** Dropped option 3 ("Break this task into smaller pieces — pause so I can edit the plan to decompose, then continue") since it overlapped semantically with option 1 ("Provide context and re-dispatch"). Option 5 (the legacy `status: blocked` end-turn path) is preserved — resume-from-blocker depends on it being the only path to the legacy blocked state.
- **Dispatch model table cell referenced a nonexistent "Task 2."** Stale draft pointer; removed.
- **Codex annotation syntax was inconsistent across the orchestrator.** Eligibility checklist (lines ~455, 460) and the operational-rule mention (line ~1062) used lowercase `codex: ok|no`; the canonical syntax block (lines ~473–484) and the eligibility-cache builder used `**Codex:** ok|no` (bold, capital). Plan authors had no way to know which form the parser expected. Standardized on `**Codex:** ok|no` everywhere.
- **README verb-table cell** pointed readers to "see invocation forms below" — that section was renamed to `### Aliases and shortcuts` in v0.4.0. Dangling anchor; updated.
- **`docs/design/telemetry-signals.md`'s "Tokens-per-turn estimate"** `jq foreach` query was broken: the UPDATE expression `$r` overwrote the accumulator each iteration, so `growth = $r.transcript_bytes - $r.transcript_bytes = 0` for every record. Rewrote using `range`-based indexed access; verified against a 3-record fixture that growth values are now real (non-zero where expected).
- **`hooks/superflow-telemetry.sh` used GNU-only `find -quit` and `find -printf`** — both silently break on macOS BSD `find`. The most-used transcript-resolution fallback returned no output on macOS. Rewrote with portable `head -n1` and a `stat -c '%Y' || stat -f '%m'` dual form. Verified end-to-end on Linux; the macOS path is portable-by-construction but not smoke-tested (call for issues added to the README).
- **`hooks/superflow-telemetry.sh` had no `jq` presence check** despite declaring jq as Required in the header. Without jq, the hook silently wrote nothing forever. Added explicit `command -v jq` guard at startup that bails silently if jq is absent.
- **`hooks/superflow-telemetry.sh` wakeup-count cutoff** could become empty in stripped or musl-libc environments where neither GNU `date -d` nor BSD `date -v` works. Awk's `ts > ""` is true for every non-empty timestamp, so `wakeup_count_24h` would over-count every wakeup ever recorded. Added a sentinel cutoff (`9999-12-31T23:59:59Z`) that produces zero matches when both date forms fail — safe degraded behavior beats silent over-counting.

### Polish
- **Step P note** said "(Step B0a, below in Step B)"; B0a is *above* Step P. Direction corrected.
- **Completion-state inference header** claimed it was "(and optionally Step C on resume to validate the plan against current reality)"; no Step C site actually invokes it. Forward intention that was never wired up; claim removed.
- **B1 "Continue to plan now" option** didn't note that B0a's worktree check is skipped (already settled by the earlier B0 run). Parenthetical added.
- **Step I0 direct-import** ("skip discovery and jump to Step I3") didn't note that Step I2 (rank+pick) is also skipped — the candidate is already determined. Added.
- **Activity log archive description** overstated `/superflow doctor`'s involvement — doctor only flags orphan archives via check #11, doesn't read content. Removed the misleading "and by `/superflow doctor`" clause.
- **Telemetry hook had a dead `out_file` assignment** (line 80 was overwritten by line 82) with a comment that described line 82's behavior, not line 80's. Removed the dead line and the orphan comment.
- **`superflow-detect` skill body** described two detection execution paths (Claude Code `Glob` tool vs shell `fd` snippets) as a single mechanism. Reframed as two layers: Glob is the always-available skill-tool path; the `fd` snippets in **Detection commands** give richer matching where `fd` is installed.
- **Historical status-file example** at `docs/superpowers/plans/2026-05-01-superflow-small-fixes-status.md` had a real `/home/ras/...` worktree path. Anonymized to `/home/you/...` to match the README's status-file example convention.
- **README hook section** softened to make the Linux-only smoke-test gap explicit: portable code paths are documented, but the macOS path hasn't been verified — readers are pointed at GitHub issues if telemetry doesn't land.

### Migration notes
- If you installed via Option B (manual copy) and copied `skills/superflow-retro/` into `~/.claude/skills/`, you can safely `rm -rf ~/.claude/skills/superflow-retro/`. The skill is no longer shipped or referenced.
- If you installed as a plugin (Option A), pulling v1.0.0 removes the skill automatically.
- No status-file or config schema changes. Existing plans, status files, and `.superflow.yaml` files work unchanged from v0.4.0.

## [0.3.0] — 2026-05-02

### Added
- Explicit phase verbs: `/superflow new <topic>`, `/superflow brainstorm <topic>`, `/superflow plan <topic>`, `/superflow plan --from-spec=<path>`, `/superflow execute [<status-path>]`. The verbs make the pipeline phases addressable at the call site instead of the previous all-or-nothing kickoff.
- `halt_mode` orchestrator state (`none | post-brainstorm | post-plan`). Drives B1 and B3 close-out gates so `brainstorm` halts cleanly after the spec is written and `plan` halts cleanly after the plan + status file are written.
- Step P — plan-only no-args picker. `/superflow plan` with no topic and no `--from-spec=` lists existing specs that don't yet have a plan and lets the user pick one.
- `### Verbs` subsection at the top of `## Subcommand reference` in the README.

### Notes
- Bare-topic shortcut (`/superflow refactor auth middleware`) keeps working unchanged — same behavior as `/superflow new refactor auth middleware`. No deprecation notice.
- `--resume=<status-path>` keeps working as an alias for `/superflow execute <status-path>`.
- Existing verbs `import`, `doctor`, `status` and their flags are unchanged.

## [0.2.2] — 2026-05-01

### Fixed
- **Four more silent-stop gates closed.** v0.2.1 fixed brainstorming and writing-plans pauses; this pass closes the remaining ones surfaced by a systematic search of upstream-skill prompts:
  - **Gate 1 — Step C step 6 (`finishing-a-development-branch`).** The skill's free-text `1. Merge / 2. Push+PR / 3. Keep / 4. Discard — Which option?` prompt could stall on plan completion. Now /superflow surfaces `AskUserQuestion` FIRST and briefs the skill with the chosen option pre-decided.
  - **Gate 2 — Step B0 step 4 (`using-git-worktrees`, "Create new" path).** The skill's free-text `1. .worktrees/ / 2. ~/.config/superpowers/worktrees/<project>/ — Which would you prefer?` prompt could stall on first-time worktree creation. Now /superflow detects existing dirs/CLAUDE.md preferences first; if neither, surfaces `AskUserQuestion` and pre-decides for the skill.
  - **Gate 3 — Step C SDD `BLOCKED`/`NEEDS_CONTEXT` escalation.** When an implementer subagent escalates, the orchestrator previously had no explicit re-engagement path before defaulting to the autonomy policy's blocker handling. Now folded into Gate 4's blocker re-engagement gate.
  - **Gate 4 — Step C step 3 autonomy=loose/full blocker before end-of-turn.** Previously: CD-4 ladder fails → set `status: blocked` → end turn silently. Now: surfaces a "blocker re-engagement gate" `AskUserQuestion(Provide context and re-dispatch / Re-dispatch with stronger model / Break task into smaller pieces / Skip and continue / End turn)` BEFORE setting `status: blocked`. Four of five options keep the plan moving (`status: in-progress`); only the last matches the legacy end-turn behavior. Under `--autonomy=full` the gate may auto-default to end-turn after a brief override window.
- **Operational rule generalized.** "Don't stop silently mid-kickoff" (v0.2.1, scoped to Step B) → "Don't stop silently anywhere — always close with AskUserQuestion if input might be needed." The rule now enumerates every upstream skill with a free-text prompt that /superflow must pre-empt, plus the canonical pattern (present `AskUserQuestion` first, brief skill with chosen option) for handling each.

## [0.2.1] — 2026-05-01

### Fixed
- **`/superflow` could stop silently mid-kickoff with outstanding tasks.** When `superpowers:brainstorming` reached its "User reviews written spec" gate, the brainstorming skill ended its turn with the open-ended prose "Wait for the user's response." If the session compacted between turns (Claude Code recap), the brainstorming skill body fell out of active context — the user came back to a recap showing open tasks but the orchestrator had no breadcrumb telling it what to do, and just sat there. Fix: Step B1 and Step B2 now own re-engagement explicitly. After brainstorming returns, the orchestrator checks for the spec file and surfaces an `AskUserQuestion(Approve and run writing-plans / Open spec to review / Request changes / Abort)` instead of relying on brainstorming's pause-for-user prose. Same pattern at Step B2 after writing-plans (also briefs writing-plans to skip its own "Which approach?" prompt — /superflow already decided execution mode via the `--no-subagents` flag). New operational rule "Don't stop silently mid-kickoff" formalizes the principle: Step B never ends a turn with a free-text question; always with concrete continuation options or explicit handoff to the next Step.

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
