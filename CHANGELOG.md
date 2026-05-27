# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v7.0.1 — Doctor Check #18 fix (2026-05-27)

### Fixed

- Doctor Check #18 (`codex config on but plugin missing`): glob `~/.claude/plugins/*codex*` only searched the root level, missing the actual install paths at `marketplaces/openai-codex/` and `cache/openai-codex/`. Replaced with `find … -maxdepth 3` to correctly detect the codex plugin regardless of where the plugin manager places it.
- Doctor Check #41 sub-fire (c): same shallow glob used for `plugin_on_disk` precondition — fixed to use the same `find` approach.

## v7.0.0 — Rename to masterplan (2026-05-26)

### Changed (breaking)

- Plugin renamed from `superpowers-masterplan` to `masterplan` — marketplace ID changes from `rasatpetabit-superpowers-masterplan` to `rasatpetabit-masterplan`
- GitHub repo renamed from `rasatpetabit/superpowers-masterplan` to `rasatpetabit/masterplan`
- Skill route changes from `/superpowers-masterplan:masterplan` to `/masterplan:masterplan`
- Install command changes from `/plugin marketplace add rasatpetabit/superpowers-masterplan` to `/plugin marketplace add rasatpetabit/masterplan`
- Existing installs on other machines require `/plugin update` after upgrading

## v6.4.0 — CC-3 visibility (2026-05-26)

### Added

- `<masterplan-trace event=... ...>` runtime marker grammar with four event literals (`subagent_dispatched`, `breadcrumb_emitted`, `summary_block_emitted`, `auq_render`) — all scanned by the Stop hook and converted to `events.jsonl` rows
- Per-turn dispatch tracking: `subagents_this_turn` (list) + `subagents_this_step` (counter) dual structure in `parts/contracts/agent-dispatch.md`
- New contract: `parts/contracts/codex-review.md` — canonical JSON return shape for B2/B3/C4b adversarial reviews
- Doctor Check #51 — CC-3 breadcrumb-at-AUQ runtime compliance
- Doctor Check #52 — CC-3 summary-block runtime compliance with HIGH-3 model-attribution drift sub-fire via turn_id join
- `cached_compliance` field in state.yml (4 sub-fields: breadcrumb_ratio, summary_block_ratio, window_turns, last_audit_ts)
- `turn_id` field in subagents.jsonl rows for cross-stream joining
- CC-2 Step 4 boot-banner: `↳ CC-3 compliance: WARN — ...` indicator (parts/step-0.md)
- 5 new doctor fixtures: check-51/{pass,fail}, check-52/{pass,fail,fail-drift}
- 5 new pytest tests for codex-review parse contract (tests/test_codex_review_parse.py)

### Changed

- `parts/step-b.md` B2/B3 adversarial review gates: structured JSON return contract per `parts/contracts/codex-review.md`; inline findings emit on resume
- `parts/step-c-verification.md` C4b Codex review dispatch: structured JSON return; inline findings emit; codex-host recursion guard sentinel
- `parts/step-c-resume.md`: Codex review resume-replay block with D24 tuple-compare schema guard
- `hooks/masterplan-telemetry.sh`: scans turn output for 4 marker event literals; adds turn_id field to subagents.jsonl rows
- `commands/masterplan.md` CC-3-trampoline: expanded breadcrumb literal at both step-entry and AUQ-close sites
- `bin/masterplan-state.sh` bootstrap path: schema_version "5.1" + cached_compliance stub in new bundles
- README.md doctor counts: 47 → 52 (proactive lint), 48 → 52 (structural audits)
- docs/verbs.md doctor count: 47 → 52
- coordinator-doctor: 13 repo-scoped checks (was 11) including #51, #52

### Fixed

- CC-3 summary-block emission: `subagents_this_turn` list now populated via dispatch contract; summary block actually renders at turn close (previously the list was implicit-model-memory and never filled)
- Breadcrumb-at-AUQ enforcement: spec mandated it but most close-sites were unwired — trampoline now requires it
- Codex review findings inline visibility: previously dropped to digest tag only; now surfaced as `↳ codex review (sites): N findings ...` inline event

### Migration

- state.yml `schema_version` changed from integer `3` to STRING `"5.1"` (tuple-compare semantics)
- New `cached_compliance:` block with 4 null fields added to all new bundles (existing bundles will pick it up on next doctor run via Check #51/#52 write-back)
- Existing bundles continue to function with `schema_version: 3`; doctor checks D24-gate (tuple-compare) skip silently for pre-v5.1 bundles until they accept the migration on next run
- The cc3-visibility bundle migrated itself first (D22 canary) — see `state.yml.bak.pre-v5_1-migration` for the pre-migration backup

## [6.3.3] — 2026-05-26

### Added

- **Doctor Check #50 — Plugin registry drift** (`parts/doctor.md`, `commands/masterplan-contracts.md`): Compares the `masterplan` version recorded in `~/.claude/plugins/installed_plugins.json` (what Claude Code actually loads) against the version in the marketplace git checkout (`.claude-plugin/plugin.json`). When they differ, Claude Code silently runs an older build and all newly shipped features are invisible until the registry is updated and Claude Code restarted. Root cause: `installed_plugins.json` was pinned to v5.8.3 since 2026-05-22 while the repo shipped v5.9 through v6.3.2 — the breadcrumb navigation feature (v6.0.1) and 11 new doctor checks were all silently skipped at runtime. Repo-scoped Haiku batch count: 10 → 11. `checks_processed: [26, 30, 31, 36, 39, 44, 46, 47, 48, 49, 50]` in both `parts/doctor.md` and `commands/masterplan-contracts.md`. Partial-failure comparison updated to match.

## [6.3.2] — 2026-05-25

### Fixed

- **Telemetry hook plan-binding: skip archived/complete bundles** (`hooks/masterplan-telemetry.sh`): The candidate-selection loop had no status filter, so an `archived`/`phase: complete` bundle on the same branch would win over an active in-progress bundle via mtime. Added `fm_status`/`fm_phase` extraction for `state.yml` candidates; any bundle with `status: archived` OR `phase: complete` is skipped before scoring. Fixes the symptom where the adversarial-review-integration bundle (archived) was capturing all telemetry for unrelated sessions running on `main`.
- **Telemetry hook plan-binding: scan `.claude/worktrees/` for linked worktrees** (`hooks/masterplan-telemetry.sh`): Claude Code places linked worktrees under `.claude/worktrees/<slug>/` but the hook only scanned `.worktrees/`. Added a parallel fan-out block for `$worktree/.claude/worktrees`; the same `.git`-presence guard applies. Fixes zero-telemetry for any run bundle resident in a `.claude/worktrees/`-style worktree (e.g., `masterplan-token-efficiency`).
- **Telemetry hook wave_groups extraction: use jq instead of grep** (`hooks/masterplan-telemetry.sh`): `events.jsonl` stores structured JSON with a `.wave` field; the previous extractor grepped for `[wave: ...]` markdown patterns which are never written by the orchestrator. Replaced with `jq -r 'select(.wave != null) | .wave'`. Wave group data now correctly appears in telemetry for active bundles that emit wave events.

## [6.3.1] — 2026-05-25

### Added

- **Doctor Check #49 — Stale Codex background task** (`parts/doctor.md`, `commands/masterplan-contracts.md`): Scans `~/.claude/plugins/data/*/state/*/jobs/*.json` for tasks whose `status` is non-terminal (not `completed`, `done`, `cancelled`, `failed`, or `error`) and whose `startedAt` is more than 24 hours ago. Surfaces runaway background workers before they become multi-day orphans. Emits a `node <companion> cancel <task-id>` suggestion for each stale task when `codex-companion.mjs` is resolvable. Skipped when the plugin data directory is absent. Motivated by production telemetry that caught a 58h orphaned `verifying`-phase task. Repo-scoped Haiku batch count: 9 → 10.

## [6.3.0] — 2026-05-23

### Fixed

- **Linked-worktree Codex dispatch guard** (`parts/step-c-dispatch.md`, Doctor #48): Codex tasks dispatched inside linked worktrees (`.worktrees/<slug>`) fail with `git add`/`git commit` errors because the Codex sandbox cannot write the `.git` index (a symlink to the common `.git`). Added structural detection via `git rev-parse --git-dir vs --git-common-dir` inequality (submodule guard included); logs `codex_skip_linked_worktree` and routes inline. Doctor check #48 (`codex_linked_worktree`, repo-scoped) flags plans where Codex was configured but all tasks routed inline due to this condition.
- **Background task dispatch schema** (`parts/step-c-dispatch.md`, `parts/step-c-resume.md`, `parts/contracts/run-bundle.md`): Formalized the `background:` state.yml object shape with all required fields. Step C resume's polling algorithm now has explicit branches for every TaskGet status including `not_found` (cross-session boundary: fall back to `output_path`, do NOT treat as failed).
- **Cross-session background task recovery** (`parts/step-c-dispatch.md`, `parts/step-c-resume.md`, `parts/contracts/run-bundle.md`): `TaskGet` IDs are session-scoped — a ScheduleWakeup firing in a new session cannot resolve prior task IDs. Added `output_path` field to background schema: computed as `<run-dir>/task-<idx>-bg-output.json` before dispatch; brief instructs agent to write digest there. On resume, `not_found` triggers `test -s <output_path>` fallback.
- **Wave-barrier-interrupted recovery** (`parts/step-c-resume.md`, `parts/failure-classes.md`, `docs/internals/failure-instrumentation.md`): When a session dies mid-wave while blocking Agent calls are in-flight, state.yml shows `tasks[*].status: in_flight` with no completion events in `events.jsonl`. Added class 11 anomaly and resume-time detection + AUQ (re-dispatch/skip/inline/abort options). Taxonomy table updated to show classes 7–11.
- **Adversarial review B3 background log_file capture** (`parts/step-b.md`, `parts/step-c-resume.md`, `parts/contracts/run-bundle.md`): B3's `node ... --background` call was discarding the companion's stdout, making post-wakeup completion detection impossible. Fixed: capture `review_handle` stdout, parse `log_file` from JSON, persist `adversarial_review_plan_pending_job: {log_file, started_at}`. Step C resume gains a carve-out for `adversarial_review_plan_pending` gate: auto-runs `test -s <log_file>` on wakeup; complete → parse + proceed; not complete → re-schedule wakeup. State schema documented in run-bundle contract.

## [6.2.3] — 2026-05-23

### Fixed

- **Doctor check tier classifications** (`parts/doctor.md`, `commands/masterplan-contracts.md`): Six checks had drifted from their declared `**Scope:**` fields into the wrong routing slots:
  - **Check #26** removed from the plan-scoped parallelization brief (was in both brief and repo-scoped batch; CronList is session-level state — no benefit to N per-worktree calls). Now repo-scoped only.
  - **Check #38** scope description corrected (was copy-pasted verbatim from check #39: "reads `~/.codex/auth.json`" — wrong; it scans per-bundle `anomalies.jsonl`); added to plan-scoped parallelization brief and all three complexity sets.
  - **Check #44** (`adversarial_review` config valid) moved from medium/high complexity sets → repo-scoped Haiku batch (validates global config tiers, not per-bundle state).
  - **Check #45** (adversarial review gate-fire audit) added to plan-scoped brief and medium/high complexity sets — was entirely absent from both routing slots despite being plan-scoped.
  - **Checks #46/#47** (CC-2 self-enforcement; return-shape caps) moved from all three complexity sets → repo-scoped Haiku batch (prompt-scoped: scan `parts/step-*.md`, which is the same repo content every time; no value running N× per worktree).
  - Repo-scoped batch count updated 5 → 8; `checks_processed: [26, 30, 31, 36, 39, 44, 46, 47]` in both `parts/doctor.md` return-shape and `commands/masterplan-contracts.md` contract definition; partial-failure fallback comparison updated; medium/high complexity sets no longer reference repo-scoped #26.
- **Doctor file title and preamble** (`parts/doctor.md`): title updated `#1 .. #43` → `#1 .. #47`; preamble comment now records v6.1.0 (#44–#45) and v6.2.0 (#46–#47) provenance.
- **README doctor check count** (`README.md`): Two stale references to "43 proactive/structural audits" updated to 47.

### Added

- **`tests/static/test-doctor-tier-drift.sh`** (FAST tier): Static test that cross-validates every `**Scope:**` field in `parts/doctor.md` against the corresponding routing slot — Plan-scoped checks must appear in the parallelization brief; Repo/Global/Prompt-scoped checks must appear in `checks_processed`. Catches future tier misassignment at pre-commit time without requiring a manual audit.

### Docs

- **`docs/internals/doctor.md` — Add a New Check guide**: Expanded from a 3-step checklist to a 5-step guide covering Scope field values, all files to update for repo-scoped checks, reference to the new static test, and the title/preamble version-provenance convention.

## [6.2.2] — 2026-05-23

### Fixed

- **Check #39 — chatgpt mode root fix** (`parts/doctor.md`, `commands/masterplan.md`): Removed all time-based sub-conditions for `auth_mode == "chatgpt"` + `refresh_token` present. The previous 7d→30d gate widening was a partial fix; this replaces it with a simple presence check — if `refresh_token` is non-empty, emit PASS immediately with no `last_refresh` age arithmetic. The chatgpt auth model auto-refreshes `id_token` on every Codex invocation via `refresh_token`; idle time between invocations is not a health signal. Fixture `pass-chatgpt-fresh` updated: `last_refresh` changed from `2026-05-20` (time bomb) to `2020-01-01` (permanently old, proves date-independence); expected output updated to show `refresh_token present`.
- **Annotation-completeness scan spec** (`parts/step-c-resume.md`): The authoritative scan definition (inline build path, step 1) said only `ok`/`no` accepted; any other value disqualified the plan from the inline fast-path. The prose documentation and `parts/contracts/plan-annotations.md` already documented `true`/`false` as aliases (from the v6.0.1 fix), but the scan spec was never updated. Plans from the `writing-plans` skill (which emits `true`/`false` booleans) were silently falling back to Haiku dispatch instead of taking the inline cache path. Fixed: scan spec now accepts `ok|no|true|false`.
- **Check #46 — code-fence skip** (`parts/doctor.md`, 3 new fixtures): The CC-2 self-enforcement lint check counted lines inside `` ```bash `` … `` ``` `` blocks as consecutive orchestrator directives. Doctor.md's 47 embedded bash implementation blocks all triggered violations. Fix: added `in_fence` state tracking — lines inside `` ```bash `` … `` ``` `` fences are skipped entirely, and the `` ```bash `` opener no longer appears in the trigger pattern. Three new fixtures: `pass-clean` (≤2 consecutive bash-type lines per section), `fail-violation` (3 consecutive lines with no gate → WARN), `pass-fenced` (3 bash lines inside a fence → PASS, validates the fix).

## [6.2.1] — 2026-05-23

### Added

- **Codex failure policy** (`docs/conventions/codex-failure-policy.md`): New conventions doc classifying Codex-specific infrastructure failures not covered by `api-retry-policy.md`: silent exit (worker spawns but no file changes occur), daemon-broken (socket/ECONNREFUSED error patterns), and auth-degraded (stale `last_refresh`). Documents two-consecutive-failure threshold before inline fallback, session-only `codex_failure_streak[task_name]` counter, auth-degraded fast path (skip streak, inline immediately), and user-facing notices per failure type.
- **Silent-exit detection** (`parts/step-c-dispatch.md`): New "Silent exit (infra failure)" bullet in the "After Codex returns" section. Primary signal: empty `git diff --stat` against `task_start_sha` when plan declared `Create:`/`Modify:` paths. Secondary signal: socket/ECONNREFUSED error patterns in return text (daemon-broken sub-type). Completion events now use `[inline:codex-fallback]` tag when inline routing was triggered by infra failure.
- **`tests/structural/test-codex-failure-policy.sh`**: Structural test covering policy doc content (silent exit, daemon-broken, auth-degraded, streak counter, cross-refs) and `step-c-dispatch.md` cross-reference.

## [6.2.0] — 2026-05-23

### Added

- **Run-policy gate** (`parts/step-c-dispatch.md`): Single upfront AUQ fires at first parallel wave assembly to capture both parallelism choice (`serial|parallel`) and on-blocker policy (`ask|async_hold|halt`). Session-only; not persisted to `state.yml`. Default: `{parallelism: serial, on_blocker: ask}` (no behavior change when gate not answered). Serial plans never see the gate. Resolves the per-wave ordering AUQ friction reported on multi-workstream runs.
- **`on_blocker: async_hold`**: New on-blocker policy — holds blocked tasks, continues other tasks and subsequent waves, surfaces all held tasks at next check-in rather than interrupting the run.
- **API retry backoff policy** (`docs/conventions/api-retry-policy.md`): New conventions doc documenting the retryable/fatal error classification, 3x retry schedule (5s/15s/45s), user-facing retry notices, and scope (Codex + inline dispatch). Cross-referenced from `parts/step-c-dispatch.md` and `docs/internals/wave-dispatch.md`.

## [6.1.0] — 2026-05-22

### Added

- **Adversarial-review integration at B2 and B3 gates:** `codex:adversarial-review` now runs automatically at the spec gate (B2, foreground) and plan gate (B3, background) before the respective approval AUQs fire. Findings surface as a fifth AUQ option; a failing review always fires the AUQ regardless of autonomy level.
- **`aggressive-loose` autonomy auto-close:** Under `autonomy: aggressive-loose`, a passing adversarial review auto-closes the spec_approval and plan_approval gates without an AUQ (reviewer-PASS IS the approval).
- **`adversarial_review` config field:** New config key `adversarial_review: both` (default). Values: `off | spec | plan | both`. Controls which gates dispatch the review.
- **`--no-adversarial-review` CLI flag:** Suppresses adversarial-review dispatch for one run without changing config. Documented in step-0.md recognized flags table.
- **Doctor check #44 — `adversarial_review` config valid:** Warns when any config tier sets `adversarial_review` to an unrecognized value.
- **Doctor check #45 — gate-fire audit:** Info check on completed bundles; verifies `adversarial_review_complete` events exist for spec_approval and plan_approval gates. Expected to fire INFO on all pre-v6.1.0 bundles.

## [6.0.1] — 2026-05-22

### Fixed

- **Codex sandbox worktree compatibility:** `codex-companion.mjs` hardcoded `workspace-write` sandbox for write tasks. In git worktrees the git index lives at `<main>/.git/worktrees/<name>/index` — outside the worktree root and blocked by `workspace-write`. Fix: detect worktree context (`<cwd>/.git` is a file, not a directory) and use `danger-full-access` instead. Patched both marketplace and 1.0.4 cache copies. This unblocks Codex task dispatch for all masterplan bundles running in git worktrees.
- **Gate chat option falls through:** `spec_approval` gate (step-b.md B1, `halt_mode==none`) listed four options including "Request changes — describe what to change" but had no explicit option routing. Any non-approve response fell through to Step B2 (plan writing), which immediately fired a downstream AUQ, preventing the user from chatting. Added routing for all four options: approve→B2; open-to-review→CLOSE-TURN (gate retained); request-changes→respond and CLOSE-TURN (gate retained); abort→cleanup. Also added a global free-text gate response rule to step-0.md: when any pending gate AUQ receives an unrecognized (free-text) response, hold the gate, respond to the user's text, and CLOSE-TURN.
- **`**Codex:** true/false` annotation mismatch:** `writing-plans` skill occasionally emits `**Codex:** true` / `**Codex:** false` rather than the canonical `ok` / `no`. Doctor check #40's counter, the step-c-resume inline-build verifier, and step-c-dispatch scanner now accept `true` (alias for `ok`) and `false` (alias for `no`). Plans with `true/false` annotations now take the inline fast-path correctly instead of silently falling back to Haiku dispatch.

### Added

- **AUQ breadcrumb navigation (CC-3 trampoline step 3):** Before every `AskUserQuestion` Closer, emit a plain-text navigation line: `/masterplan {verb} › {phase-label} › {gate-id}  [{slug}]`. Gives users the "big picture" workflow context when responding to nested questions. Phase label derived from the latest `<masterplan-trace step=X phase=in>` breadcrumb; gate-id from the surfaced gate; slug from the active bundle.

## [6.0.0] — 2026-05-22

### Performance

- **P0 Baseline instrumentation:** `turn_context_bytes` event in telemetry hook; `bin/masterplan-codex-usage.sh baseline` subcommand for pre/post token measurement.
- **P1 Prose pruning:** `parts/step-0.md` 47KB→≤30KB; `parts/step-b.md` 48KB→≤28KB; `commands/masterplan.md` 11KB→≤9KB; `parts/doctor.md` per-check rationale blocks compressed to 1 sentence each.
- **P2 Sub-file split:** `parts/step-c.md` (110KB monolith) replaced by 4 load-on-demand sub-files: step-c-resume (≤38KB), step-c-dispatch (≤30KB), step-c-verification (≤29KB), step-c-completion (≤17KB). A typical mid-plan execute turn loads ~50KB instead of 110KB.
- **P3 Coordinator pattern:** 5 coordinator subagents introduced — brainstorm-anchor, doctor, task-verify, bundle-resume, plan-parser. Each coordinator pays context cost internally; orchestrator receives ≤1000-token JSON. Inline fallbacks at all 5 sites preserve pre-v6 behavior on error.

### Architecture

- **`parts/contracts/coordinator.md`:** Core coordinator subagent contract (CD-7 compliance, tier selection, failure contract, coordinator catalog).
- **`docs/internals/`:** 7 focused docs replace the monolithic `docs/internals.md`. All cross-references in `parts/` updated to specific coordinator docs.

## [5.8.3] — 2026-05-20 — pending_gate_orphaned: see block-form gates

Patch release. v5.8.1 added sentinel-suppression to `pending_gate_orphaned` (lib/masterplan_session_audit.py), but the underlying `yaml_scalar(state_text, "pending_gate")` returns `""` whenever `pending_gate` is a block (the canonical form per `parts/step-b.md` + `parts/failure-classes.md`: `pending_gate.id: <gate>` / `phase:` / `options:` etc.). Empty string failed the `and gate_val` truthiness guard, so every block-form pending gate — i.e., every *real* pending gate — was silently invisible to the detector. The smoke regression at `bin/masterplan-policy-regression-smoke.sh` (`pending-stale` fixture, block form) exposed this on the v5.8.2 follow-up run: 1 of 44 assertions failed.

### Fixed

- **`yaml_nested_field(text, parent, child)`** helper added to `lib/masterplan_session_audit.py`. Parses block-form YAML parents and returns the scalar value of a named child (strips quotes; returns `""` when parent is scalar or child is missing).
- **`stats.pending_gate` population:** falls through to `yaml_nested_field(state_text, "pending_gate", "id")` when the top-level scalar is empty. So scalar form (`pending_gate: null`, `pending_gate: 'plan-approval'`) still works as before; block form (`pending_gate:\n  id: brainstorm_anchor_audit_mode\n  phase: brainstorming`) now exposes the gate id to the detector and threshold logic.
- **Smoke pipeline:** 44/44 assertions now pass on a clean run.

### Tests

5 new unit tests in `tests/test_masterplan_session_audit.py`:
- `test_yaml_nested_field_extracts_block_child_scalar`
- `test_yaml_nested_field_strips_quotes`
- `test_yaml_nested_field_returns_empty_when_scalar_parent`
- `test_yaml_nested_field_returns_empty_when_child_missing`
- `test_pending_gate_block_form_with_id_fires_orphaned_when_stale` + `test_pending_gate_block_form_with_empty_id_does_not_fire` (full `analyze_plan_state` integration through a tmpdir fixture).

The pre-existing `test_pending_gate_orphaned_ignores_yaml_cleared_sentinels` keeps the v5.8.1 sentinel suppression locked in. All 28 tests pass.

### Compatibility

No schema changes. Detector behavior is strictly more complete: every existing call site that worked before still works; block-form gates that were silently dropped now fire correctly when stale.

### Rollout

`claude plugin marketplace update` + `claude plugin update "masterplan@rasatpetabit-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-masterplan` for Codex CLI to pick up the session-audit library. No orchestrator-surface or runtime behavior changes.

## [5.8.2] — 2026-05-20 — Self-host audit reconciliation with v5.0+ phase modules

Patch release. `bin/masterplan-self-host-audit.sh` had drifted behind the v5.0 modularization (orchestrator split from monolithic `commands/masterplan.md` into `parts/*.md` phase modules + `parts/contracts/*.md` cross-cutting contracts). Several checks were still scanning the legacy router for sentinels that had migrated into the phase modules, and the v5 plan-format check was hard-asserting markers on archived pre-v5 bundles that won't be retroactively reformatted. Net effect on a fresh marketplace clone: ~3 false-positive warnings + 2 FAILs on every audit run, eroding the signal value of the script.

### Fixed

- **`check_brainstorm_anchor`** — scans `parts/step-b.md` (canonical home of the 13-sentinel anchor contract) instead of `commands/masterplan.md`. Enum sentinel updated to the current set: `feature-ideas|implementation-design|audit-review|deferred-task|execution-resume|unclear|null`. Legacy 4-case JSON regression fixture (`docs/masterplan/expanded-brainstorming-selection/regressions.json`) was archived to `legacy/.archive/` when the dev-phase bundle retired; the contract scan in step-b.md is now the durable regression net.
- **`check_loop_first_contract`** — scans `parts/step-c.md` + `parts/step-0.md` + `docs/internals.md` per current sentinel locations. Negative regression guards broadened to glob `parts/*.md` + `commands/masterplan.md` so a forbidden `Stop` reference added to any phase module fails the audit. README-side `loop-first` assertion dropped — the v5.8.0 README rewrite intentionally moved that implementation term out and describes the losslessly-resumable run-bundle model in audience-first language instead.
- **`check_codex_packaging`** — scans the 10 codex-host sentinels in `parts/codex-host.md`. Four stale README-targeted checks dropped (entrypoint skill, recursive-Codex suppression, Use-masterplan example, loop-first user-facing term) — these were canonicalized in `parts/codex-host.md` + `docs/internals.md` during the v5.8.0 README rewrite, not regressed. Two evolved sentinel phrases migrated: `targeted section reads` → ``targeted `state.yml` reads`` (SKILL.md), and `completed_with_follow_up` in `commands/masterplan.md` → `completed meta-plan` in `parts/step-c.md`. Added `"explicit interactive selection"` to the codex-host pattern set.
- **`check_model_passthrough`** — scans the full orchestrator surface (`commands/masterplan.md` + `parts/*.md` + `parts/contracts/*.md`) instead of just the thin router. The verbatim SDD preamble sentinel ("For every inner Task / Agent invocation you make") canonically lives in `parts/contracts/agent-dispatch.md` and is operatively referenced in `parts/step-c.md`; dispatch-site `model: "haiku|sonnet|opus"` annotations are spread across step-a / step-b / step-c / import / doctor. Aggregation uses `grep -c | awk` so the sum is portable across files; per-file bare-opus warning reports `path:lineno` and preserves the ±5-line blocker-stronger-model context suppressor.
- **`check_plan_format`** — schema-aware skip for archived/completed bundles. New helper `_plan_bundle_is_archived` reads the sibling `state.yml` and matches all three supported schemas: v2/v3 (`status:` or `phase:` in {archived, completed}) and v5.0 (`current_phase: done`). Pre-v5 plan bodies in `codex-routing-fix` and `p4-suppression-smoke` aren't going to grow retroactive **Spec:** / **Verify:** markers; active bundles still fail when they lack them. PASS line reports the skip count for transparency.
- **`_check_sentinels_in_file` helper** added in the first commit of the series to factor the multi-file glob-and-grep pattern that each migrated check uses.

### Compatibility

No schema changes. Audit script behavior is strictly more correct: same set of regressions still flagged, fewer false positives. Doctor checks are unchanged.

### Rollout

`claude plugin marketplace update` + `claude plugin update "masterplan@rasatpetabit-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-masterplan` for Codex CLI to pick up the audit script. No orchestrator-surface or runtime behavior changes.

## [5.8.1] — 2026-05-20 — Path-portability finalization + pending_gate_orphaned audit fix

Patch release. Pre-publication finalization for plugin distribution from arbitrary workspace directories.

### Fixed

- **Hardcoded developer-path leaks (3 docs files):** `docs/internals.md` and `parts/failure-classes.md` carried literal `~/.claude/projects/-home-ras-dev-masterplan/hook-errors.log` examples; replaced with a `<slugified-worktree>` placeholder + one-line explanation matching the actual hook behavior at `hooks/masterplan-telemetry.sh:571`. `README.md` "Optional Telemetry Hook" section restored from collateral stripping (prior refactor left it as a comment-only JSON block).
- **`AGENTS.md`** — dropped private-repo refs (`~/dev/petabit-handbook/*`); now generically points at `CLAUDE.md` + optional org-wide guide.
- **Python `~/dev` defaults:** `lib/masterplan_session_audit.py` and `lib/masterplan_wipe_telemetry.py` derived `MASTERPLAN_REPO_ROOTS` from `~/dev`; both now derive from `Path(__file__).resolve().parent.parent.parent` so discovery works without assuming the developer's home layout.
- **Hostname leaks:** `epyc1`/`epyc2` references in `docs/internals.md` and two `docs/masterplan/` bundles generalized to "one host" / "every host that has the plugin installed".
- **`pending_gate_orphaned` false positive on YAML-cleared gates** (`lib/masterplan_session_audit.py`). Sentinel values `null`, `~`, `[]`, `{}` are now treated as "no gate" regardless of staleness.

### Compatibility

No schema changes. Pure docs + tooling fixes.

## [5.8.0] — 2026-05-16 — Codex routing fix: aggressive default, per-member wave review, asymmetric enforcement + 4 failure classes

Minor release. Addresses the T8 misfire (wave-mode code-review running via Claude SDD despite Codex configured) and the broader Codex under-dispatch / subagent context-pollution concerns documented in `docs/masterplan/codex-routing-fix/brainstorm.md` (findings F1–F6).

### Added

- **Plan-writer aggressive Codex annotation default** (`parts/step-b.md`, T3 commit `322dac8`). Replaces conservative "add `**Codex:** ok` when obviously well-suited" with "default `**Codex:** ok` for ALL single-file edits (code OR doc); only mark `**Codex:** no` when multi-file, ambiguous scope, no known verification, or explicit scope-out applies." Addresses F1.
- **Wave-mode Step 4b: N parallel per-member Codex REVIEW dispatches** (`parts/step-c.md`, `commands/masterplan-contracts.md`, T6 commit `958e649`). At wave-end, orchestrator dispatches N Codex REVIEW calls (one per wave member) batched into a single assistant message, each scoped to that member's `**Files:**` with diff range = `<wave_start_sha>..<wave_end_sha>` filtered to those files. New contract `codex.review_wave_member_v1` registered. Addresses F2.
- **Asymmetric review enforcement at Step 4b (serial + wave-member)** (`parts/step-c.md`, T7 commit `2b15a98`). If `dispatched_by == "codex"` for the task being reviewed, skip review with `decision_source: codex-produced` and emit `review→SKIP(codex-produced)` event. Codifies the asymmetric principle from `docs/internals.md:577`.
- **Mandatory `eligibility_cache` event in wave-pin short-circuit + new `wave_routing_summary` event** (`parts/step-c.md`, T4 commit `96def0a`). Wave-pin path now emits the v2.4.0+ MANDATORY `eligibility_cache` event before short-circuiting (closing the F3 contradiction at line 87 vs line 96). New `wave_routing_summary` event at wave-entry with shape `{wave, members_by_route: {codex: N, inline_review: N, inline_no_review: N}}`.
- **`dispatched_by` provenance field on every completion event** (`parts/step-c.md`, T5 commit `e7832d7`). Enum: `codex`, `claude`, `wave-claude`, `user`, `codex+claude-fixup`. Precondition for the asymmetric-review enforcement above. Canonical naming table added near the top of step-c.md.
- **Telemetry hook emits `subagent_return_bytes`** (`hooks/masterplan-telemetry.sh`, T2 commit `0e0ce06`). Per-subagent JSONL records gain an integer field for the return-text byte length. Enables measurement of the context-pollution concern (F4); detector for the new `subagent_return_oversized` failure class.
- **Doctor check #43 `codex_review_coverage`** (`parts/doctor.md`, T1 commit `80b96d5`). For each run bundle's `events.jsonl`, every `wave_task_completed` event must have a paired `review→CODEX(...)` or `review→SKIP(<reason>)` event with explicit `decision_source`. Coverage = paired_reviews / wave_task_completed. WARN when coverage < 100% and run was not inside Codex host. Backfill against `concurrency-guards` and `p4-suppression-smoke` is expected to WARN (both predate the visibility-event rule).
- **5 new dispatch-brief contracts** in `commands/masterplan-contracts.md` (T8 commit `dfd0424`): `step-c.eligibility_cache_build_v1`, `step-c.wave_implementer_v1`, `step-c.codex_exec_v1`, `step-c.codex_review_serial_v1` (T8), plus `codex.review_wave_member_v1` (T6). Closes F6 gap.
- **`bin/masterplan-self-host-audit.sh --brief-style` strengthened** (T8 commit `dfd0424`) to scan `commands/masterplan.md`, `parts/step-c.md`, and `parts/doctor.md`, recognize v5 `DISPATCH-SITE: step-c.md:<label>` / `doctor.md:<label>` conventions, and flag any lifecycle dispatch site lacking a `contract_id` within 30 lines (Pattern D). Pattern D verified via injected fixture.
- **4 new failure classes** in `parts/failure-classes.md` (T9-T12 commit `c94b5cb`):
  - `wave_codex_review_skip` — fires when doctor #43 finds wave-mode review coverage < 100% (addresses F2)
  - `subagent_return_oversized` — fires when `subagent_return_bytes` > 5120 bytes (addresses F4)
  - `eligibility_cache_event_missing` — fires when Step C entry events.jsonl is missing the mandatory `eligibility_cache` event (addresses F3)
  - `dispatch_brief_unregistered` — fires when `--brief-style` audit encounters a lifecycle dispatch site lacking a `contract_id` (addresses F6)
- **`docs/internals.md` §3/§8/§9/§10 cross-section updates** (T13 commit `df5038b`) reflecting all of the above.

### Fixed

- **F1: Plan-writer defaults to `**Codex:** no` for everything.** Conservative wording at `parts/step-b.md:353` left planner defaulting to `**Codex:** no` even for 1-file doc edits well-suited to Codex EXEC. Reflipped to aggressive default.
- **F2: Wave-mode skips Step 4b Codex review entirely.** Old rule at `parts/step-c.md:613` claimed the diff range was empty for wave members. Mechanically true at the individual-member level but the wave-end SHA range (`<wave_start_sha>..<wave_end_sha>` filtered to each member's `**Files:**`) is reviewable. Replaced with N-per-wave dispatch.
- **F3: Wave-mode bypasses v2.4.0+ mandatory visibility events.** Wave-pin short-circuit at `parts/step-c.md:87` silently dropped the mandatory `eligibility_cache` event documented at `parts/step-c.md:96`. Fixed by emitting before short-circuiting.

### Compatibility

`state.yml` schema unchanged. New event types (`wave_routing_summary`) and new event field (`dispatched_by`) are additive on `events.jsonl`; legacy bundles without these fields are tolerated. New telemetry field `subagent_return_bytes` is additive on per-subagent JSONL records. Doctor check #43 is WARN-only; existing bundles `concurrency-guards` and `p4-suppression-smoke` are expected to WARN as documented backfill.

### Why minor (5.7.3 → 5.8.0)

This bundle adds (a) new policy that flips a default behavior the plan-writer applies (aggressive Codex annotation), (b) new event types + new telemetry fields that downstream observability consumers can rely on, (c) a new doctor check, (d) four new failure classes hooked into the v5.1.0+ framework, and (e) new dispatch-brief contracts. Multiple additive capability boundaries per the project's semver convention.

### Rollout

Per the patched rollout macro: `claude plugin marketplace update` + `claude plugin update "masterplan@rasatpetabit-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-masterplan` for Codex CLI, on both ras@epyc2 and grojas@epyc1.

## [5.7.3] — 2026-05-16 — telemetry: fix parent_turn duplication in emit_parent_turns

Patch release. Fixes a bug where `emit_parent_turns()` re-emitted all historical `parent_turn` records from the full transcript on every Stop hook fire, inflating counts ~2× per additional Stop event. Measured inflation: 2.1× across `p4-suppression-smoke` (9108 raw → 4292 deduped) and 1.8× across `concurrency-guards` (2085 raw → 1153 deduped). Fixes #8.

### Fixed

- **`emit_parent_turns()` parent_turn deduplication** (`hooks/masterplan-telemetry.sh`). Builds a seen-set from existing `subagents.jsonl` keyed by composite `ts|session_id` before scanning the transcript, then filters the jq output against that set before appending. Mirrors the identical `agent_id` dedup pattern already used in `_do_append_subagents()` at lines 391–398. New records emitted only when `ts|session_id` is not already present in the file.

### Compatibility

No schema changes. Existing `subagents.jsonl` files retain their (inflated) historical records — the fix prevents future duplication but does not retroactively deduplicate. Downstream `stats` queries that sum over `parent_turn` records should deduplicate by `ts+session_id` when querying pre-5.7.3 data.

---

## [5.7.2] — 2026-05-16 — Bundle maintenance (state field normalization + archive)

Patch release. Normalizes `phase`/`status` values in completed bundles from non-canonical `complete`/`ready_for_retro` to the standard `completed`/`archived` values per run-bundle schema. Archives the `concurrency-guards` bundle (work delivered in v5.7.0). Removes stale `.lock` and unreferenced `anomalies.jsonl` from `p4-suppression-smoke`. No behavioral changes.

---

## [5.7.1] — 2026-05-16 — Doctor check #41 false-positive fix (never-Codex-active bundles)

Patch release. Check #41(a) now gates on `codex_ever_active`: if `events.jsonl` has zero `codex_ping` / `codex degraded` / `routing→[codex]` events, sub-fire (a) is skipped entirely — Codex was configured `off` from bundle creation, so no degrade-loudly evidence is expected. Previously fired as WARN on every plan where Codex was intentionally disabled from the start (codex_routing=off, no prior Codex activity). Both `parts/doctor.md` (bash + prose + table entry) and `concurrency-guards/retro.md` (open item resolved) updated.

---

## [5.7.0] — 2026-05-16 — Concurrency safety: Guard B (slug-uniqueness) + Guard C (flock serialization)

Minor release. Closes two long-standing race windows: cross-worktree slug collisions at bundle creation time, and same-worktree concurrent JSONL/state.yml write corruption.

### Added

- **Guard B — cross-worktree slug-uniqueness pre-check** (`bin/masterplan-state.sh check-slug-collision`). Scans all `git worktree list` peers for an active run with the same slug before creating a new bundle. Detects stale worktrees (directory removed but still registered). On collision: AUQ with 4 options (resume peer, auto-suffix per D3 global scheme, orphan-acknowledge, abort). Integrated into Step B0 (sub-step 1d, excluding `--from-spec` per D6) and Step I3 import pre-flight (between within-batch and path-existence passes).
- **Guard C — `with_bundle_lock()` write serialization** (`bin/masterplan-state.sh`, `hooks/masterplan-telemetry.sh`). `flock -w 5` fd-based form — `(flock -w 5 9; "$@") 9>"$lockfile"` — so bash functions are callable in the guarded subshell. macOS fallback: one-per-process WARN via `MASTERPLAN_FLOCK_WARNED` env var, then unguarded passthrough. Wraps all bundle-mode append sites: 2 `masterplan-state.sh` rename paths + 5 `masterplan-telemetry.sh` append paths. Bail-silent contract preserved (`|| true` on telemetry sites).
- **Doctor check #42 — stale `.lock` file** (`parts/doctor.md`). `mtime > 1h` on `<bundle>/.lock` → `WARN` (report-only, never auto-delete). Added to Haiku brief, all complexity tiers, check table, and per-check section.
- **Smoke tests**: `bin/masterplan-guard-b-smoke.sh` (collision detection + stale-peer detection via synthetic git worktree fixture) and `bin/masterplan-guard-c-smoke.sh` (100-concurrent `events.jsonl` appends, macOS fallback, `state.yml` race, stale-lock doctor check). Both `bash -n` clean.

### Compatibility

No schema bump on `state.yml`. Guard B fires only at bundle creation; existing runs are unaffected. Guard C is transparent to callers — `with_bundle_lock()` degrades silently on macOS. Doctor check #42 is WARN-only.

## [5.6.0] — 2026-05-16 — Claude `/goal` interop (observability-only) + audit denominator fix

Minor release. Adds host-only observability for Claude Code's `/goal` autonomous-continuation loop via the Stop hook input contract, exposes the signal in telemetry and session-audit rollups, and fixes a P2 denominator bug found in pre-release Codex review.

### Added

- **`claude_stop_hook_active` field on Stop-hook telemetry records** (`hooks/masterplan-telemetry.sh`). Lifted verbatim from the Claude Code Stop hook input JSON via `jq -r '.stop_hook_active // false'`. `true` when the Stop event fired inside an autonomous-continuation loop (Claude `/goal`, agent SDK loop, etc.); `false` when missing, malformed, or under a normal Stop. Default-false on Codex hosts and on legacy records pre-dating this field — Codex-side audit logic does not treat absence as a regression.
- **`stop_records` + `claude_continuation_records` + `claude_continuation_share` fields on `bin/masterplan-session-audit.sh` JSON output, plus matching table section.** Per-plan rollup of how many Stop events fired during `/goal`-driven continuations vs natural stops. Header line always prints; rows only appear when `claude_continuation_records > 0` so most sessions stay silent.
- **`docs/internals.md` §8.5 — "Claude `/goal` interop (host-only, observability-only)"**. Asymmetry table between Codex MCP goal tools (bidirectional, already wired as `codex_goal`) vs Claude `/goal` (user-only control surface). Documents the explicit decision NOT to add a runtime hint (would fight `gated`/`loose` per-task checkpoints intentional per `parts/step-c.md:625-650`) and NOT to add a `claude_goal` schema field (cannot be reconciled without `get_goal`-equivalent, violates CD-7).
- **README compatibility note under Flags**. Frames `/goal` as `--autonomy=full`-compatible outer wrapper; explicit caveat against `gated`/`loose` use; notes orchestrator does not invoke `/goal` programmatically (no API surface in Claude Code as of 2.1.139).

### Fixed

- **`claude_continuation_share` denominator P2** (`lib/masterplan_session_audit.py`). Initial implementation divided by `item.records` (Stop + `step_c_entry` records). Inline Step C snapshots cannot carry the hook field, so they only diluted the rate. Now divides by `stop_records` (a new field counting only `turn_kind == "stop"` records). Synthetic 5-record mixed file now reports 0.667 instead of buggy 0.400; surfaced by `/codex:review --base HEAD~1` before push.

### Compatibility

No schema bump on `state.yml`. No new doctor checks. The new `claude_stop_hook_active` field is additive on telemetry records (`turn_kind: "stop"` only); audit rollup tolerates legacy records that omit it. No orchestrator behavior changes — Step C dispatch, autonomy modes, and gate semantics are unchanged.

### Why minor (5.5.0 → 5.6.0)

A new telemetry field plus a new audit rollup is a versioned capability boundary that downstream observability and audit consumers can rely on. Per the project's semver convention (CD-10 family), additive observability surfaces that establish a new data contract get MINOR even when no orchestrator behavior changes.

### Rollout

- Dual-surface refresh per the patched rollout macro: `claude plugin marketplace update` + `claude plugin update "masterplan@rasatpetabit-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-masterplan` for Codex CLI, on both ras@epyc2 and grojas@epyc1.

## [5.5.0] — 2026-05-15 — Three-layer regression test suite: static battery + doctor-fixtures (9 checks, 24 fixtures) + e2e claude --print harness

Minor release. Adds a complete, sequenced three-layer test suite across `tests/static/`, `tests/doctor-fixtures/`, and `tests/e2e/`. No orchestrator behavior changes — this is purely additive test infrastructure. 83 files changed, 906 insertions, 2 deletions.

### Added

- **`tests/static/` — four structural regression scripts + `tests/run-static.sh` runner.** Each script runs in under 2 seconds; the full battery completes in under 5 seconds total. Catches prompt-edit regressions before publish rather than after a production fire. `make test-static` runs all four; `make test` runs static + doctor-fixtures + python. The first run of `test-cross-refs.sh` caught a real dangling reference (`parts/cd-rules.md` → `parts/contracts/cd-rules.md`).
- **`tests/doctor-fixtures/run.sh` — semantic harness for bash-extractable doctor checks.** awk-extracts the fenced `bash` block under each `## Check #NN` heading in `parts/doctor.md` and runs it verbatim against synthetic PASS / FAIL / SKIPPED bundle fixtures under a controlled `HOME` and `cwd`. The doctor block IS the test code — zero drift risk. Wired as `make test-doctor-fixtures`.
- **`tests/e2e/run.sh` — black-box harness via `claude --print`.** Invokes the full orchestrator (plugin loading + `commands/masterplan.md` + Step 0 routing) against fixture inputs and asserts substring matches against `golden.grep`. Opt-in only (`make test-e2e`, NOT in `make test`) because each invocation costs real API spend (~$0.20–1.00 under Sonnet). Per-test budget capped via `--max-budget-usd`; timeout via `timeout(1)`. First fixture: `version-sentinel` — asserts the version sentinel appears in Step 0 output. Tunable via `CLAUDE_E2E_MODEL`, `CLAUDE_E2E_BUDGET`, `CLAUDE_E2E_TIMEOUT`; defaults to Sonnet (Haiku 4.5 trips autocompact thrash on the ~2150-line orchestrator load).

### Test layer details

- **Layer 1 — static battery** (`tests/static/`, `tests/run-static.sh`, commit `f64204a`): four scripts — `test-yaml-frontmatter.sh` (python+yaml validates frontmatter on every `.md` with a leading `---`); `test-cross-refs.sh` (file-path existence, `contract_id:` → `## Contract:` mapping, `Check #NN` → `parts/doctor.md` heading mapping across all three reference classes); `test-bash-blocks.sh` (`bash -n` on every ` ```bash ``` ` block in `parts/*.md` and `commands/*.md`); `test-manifest-drift.sh` (mirror of Doctor #30 pre-commit: 5 version fields across `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` root + nested, `.codex-plugin/plugin.json`, README).

- **Layer 2 — doctor-fixtures harness** (`tests/doctor-fixtures/run.sh`, commits `1cd3e3a` + `e24ce37`): 9 check directories (`check-32` through `check-41`), 24 fixtures total, all green. Coverage: Check #32 (overflow watch — `pass-clean`, `fail-overflow-missing-target`, `fail-overflow-too-long`); Check #33 (reserved/trivial — `skipped`); Check #34 (state/plan hash drift — `pass-matching-hash`, `fail-state-drift`); Check #35 (spec/verify presence — `pass-conformant`, `fail-missing-spec`, `fail-missing-verify`); Check #36 (router file budgets — `pass-mini-repo`, `fail-oversized-router`, `fail-missing-step`); Check #38 (retro anomalies log — `pass-no-anomalies`, `fail-records-present`); Check #39 (Codex JWT freshness — `pass-chatgpt-fresh`, `fail-expired-jwt`, `skip-no-auth`); Check #40 (Codex annotation gap — `pass-high-fully-annotated`, `pass-low-skipped`, `fail-codex-gap`); Check #41 (Codex degradation evidence — `pass-no-bundles`, `pass-healthy-bundle`, `fail-silent-override`, `info-annotation-gap`). Scales to any of the 9 bash-extractable checks without runner changes — drop a `check-NN/<verdict>-<reason>/` directory with `state.yml` + `events.jsonl` + `expected.txt`.

- **Layer 3 — e2e harness** (`tests/e2e/run.sh`, `tests/e2e/README.md`, `tests/e2e/version-sentinel/`, commit `8d6a6a4`): per-fixture layout of `prompt.txt`, `golden.grep`, optional `cwd/` (isolated to prevent resume-controller cross-contamination from unrelated bundles), optional `setup.sh`. `version-sentinel` fixture asserts the orchestrator's version sentinel appears in output — catching plugin-load breakage, Step 0 router breakage, and `vUNKNOWN` regressions without pinning a specific version number so the test survives release bumps.

### Compatibility

No plugin behavior changes. The orchestrator prompt (`commands/masterplan.md`), all subagent briefs, doctor check logic, and run bundle schemas are unchanged. Existing run bundles, doctor outputs, and eligibility caches remain fully compatible.

### Why minor (5.4.0 → 5.5.0)

A complete sequenced test suite is a versioned milestone: it formalizes a regression contract that downstream installers and contributors can rely on. PATCH would have undersold the surface area — 906 lines of new test infrastructure across three distinct layers. Per the project's semver convention (CD-10 family), additive infrastructure that establishes a new capability boundary gets MINOR even when no orchestrator behavior changes.

### Rollout

- Dual-surface refresh per the patched rollout macro: `claude plugin marketplace update` + `claude plugin update "masterplan@rasatpetabit-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-masterplan` for Codex CLI, on both ras@epyc2 and grojas@epyc1.

## [5.4.0] — 2026-05-15 — Parallelism wave: doctor repo-scoped Haiku batch + intent-anchor 3-way fan-out + parent re-verify parallel Bash + eligibility cache sharding

Minor release. Four new parallel-dispatch sites in the orchestrator, all returning the same data shape as their pre-v5.4.0 single-dispatch / inline-serial counterparts so existing run bundles, doctor lints, and cache files remain compatible.

### Added — Parallel dispatch sites

- **Doctor repo-scoped checks #26 / #30 / #31 / #36 / #39 → single Haiku batch.** Pre-v5.4.0 ran these five inline at the orchestrator (5 serial reads of session-level state, manifests, `parts/step-b.md`, `commands/masterplan.md`, and `~/.codex/auth.json`). v5.4.0+ bundles them into one Haiku dispatched in the SAME Agent batch as the per-worktree Haikus, so all parallelizable doctor work returns in a single wave. Haiku loads the deferred `CronList` tool via `ToolSearch` to service check #26. Brief uses new `contract_id: "doctor.repo_scoped.schema_v1"`. Partial-failure handling: malformed return → inline fallback to pre-v5.4.0 path + one telemetry event; single missing-check return → per-check INFO without full fallback. See `parts/doctor.md` line 19 + adjacent paragraphs.
- **Step B1 intent-anchor → 3-way Haiku fan-out (project-docs / run-state / repo-sketch).** Pre-v5.4.0 dispatched ONE Haiku that serially Read 7 source files (AGENTS.md, CLAUDE.md, WORKLOG.md, recent state.yml, events.jsonl, spec.md, `rg --files` sketch) and produced a fully-classified `brainstorm_anchor`. v5.4.0+ splits into three parallel Haikus by source class: Haiku A reads project docs (AGENTS.md+CLAUDE.md+WORKLOG.md), Haiku B reads run state (state.yml+events.jsonl+spec.md), Haiku C reads the repo sketch (`rg --files`). Each returns *extracted facts + hints* (not a classification); the orchestrator merges with precedence rules (run-state wins on `mode`, project-docs wins on `repo_role` / `yocto_ownership` / scope, repo-sketch ground-truths). Merge protocol documents field-by-field precedence and the most-restrictive `verification_ceiling`. Validation gate identical to pre-v5.4.0: any merge ambiguity (mode unclear, required field null) → fall through to existing `pending_gate.id: brainstorm_anchor_audit_mode` AUQ gate. See `parts/step-b.md` line 177+.
- **Doctor parent re-verify → parallel Bash batch.** Pre-v5.4.0 looped serially over the sample set (3 random bundles + any with Haiku-reported violations), one grep per bundle for `^retro: ""` and missing `import_hydration`. v5.4.0+ emits one Bash invocation that backgrounds all N greps with `&` + `wait`, parsing line-delimited JSON output once. Latency is the longest single grep, not the sum. Output format and Haiku cross-reference logic unchanged. See `parts/doctor.md` line 34+.
- **Step C eligibility cache → sharded build with parallel-group affinity.** Pre-v5.4.0 dispatched ONE Haiku to build the entire `eligibility-cache.json`. v5.4.0+ shards the build: if the plan has any `**parallel-group:**` annotations, one Haiku per group plus one for unassigned tasks (preserves rule-5 cohort visibility — every group member lands in the same shard). If no parallel-groups exist AND the plan has ≥10 tasks, shard into ceil(N/10) index ranges (min 1, max 4 — beyond 4, dispatch overhead exceeds win). Plans with <10 tasks AND no parallel-groups skip sharding entirely (pre-v5.4.0 single-Haiku path). Orchestrator dispatches all shards in ONE assistant message, concatenates `tasks` arrays on return, sorts by `idx`, validates contiguity, atomic-writes the merged JSON. New `shard_id` field on Haiku return (`"group:<name>"`, `"unassigned:<low>-<high>"`, or `"full"`); merge step is a no-op pass-through when bypassed. `cache_pinned_for_wave: false` on merged cache (pin flag is still set later at wave entry). See `parts/step-c.md` line 93 + brief at line 157.

### Compatibility

- Existing run bundles, doctor outputs, and `eligibility-cache.json` files (incl. `cache_schema_version: "1.0"`) remain readable and writable. No schema bumps.
- The doctor `contract_id: "doctor.schema_v2"` per-worktree brief is unchanged; the new `contract_id: "doctor.repo_scoped.schema_v1"` is a sibling, not a replacement.
- Step B1 `pending_gate.id: brainstorm_anchor_audit_mode` gate semantics unchanged — sole entry path is unresolved merge or unclear classification.
- Step C eligibility-cache shape, parallel-eligibility rules 1-5, and `cache_pinned_for_wave` lifecycle unchanged.

### Why minor (5.3.x → 5.4.0)

New parallel dispatch sites are behavior-affecting (different observable telemetry shapes, new event types in doctor logs, new `shard_id` fields in eligibility caches built post-upgrade) but every existing input/output contract holds. Per the project's semver convention (CD-10 family), behavior-additive changes that preserve all back-compat get MINOR. PATCH would have understated the surface area.

### Rollout

- Dual-surface refresh per the patched rollout macro: `claude plugin marketplace update` + `claude plugin update "masterplan@rasatpetabit-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-masterplan` for Codex CLI, on both ras@epyc2 and grojas@epyc1.

## [5.3.3] — 2026-05-15 — Plugins UI errors: frontmatter on contract registry + drop dead auq-guard.sh

Patch release. Fixes 2 static issues surfaced by the Claude Code Plugins UI's Errors tab after the v5.3.2 install.

### Fixed

- **`commands/masterplan-contracts.md` had no frontmatter.** The file is a registry doc that has lived in `commands/` since v4.0.0 (referenced by path in `parts/step-b.md`, `parts/doctor.md`, and `docs/internals.md` so subagent briefs can cite specific `## Contract:` sections). Claude Code's plugin command loader treats every `commands/*.md` as a slash command and rejects ones without frontmatter, producing a Plugins UI error. Added minimal frontmatter with a `description:` field that documents the file as an internal registry and explicitly notes it is not user-invokable. The 10+ existing path-and-anchor references remain intact (frontmatter sits above the `# Masterplan subagent contract registry` heading; heading anchors are unaffected). A phantom `/masterplan:masterplan-contracts` slash command now appears in the autocomplete with the disclaimer description — preferred over an unfixed UI error.

### Removed

- **`hooks/auq-guard.sh` deleted.** Tracked in git since v2.17.0 (`AUQ-guard Stop hook` release) and last touched in v5.2.2, but never registered in `hooks/hooks.json`. The active AUQ-guard hook moved to user-global scope (`~/.claude/hooks/auq-guard.sh`) long ago; the plugin copy is dead cruft. Removing it eliminates a 238-line bash file that no path references, and removes the possibility of future confusion where a plugin update reads from a hook that was never actually wired.

### Rollout

- Both surfaces refreshed: `claude plugin marketplace update` + `claude plugin update "masterplan@..."` for Claude Code AND `codex plugin marketplace upgrade ...` for Codex CLI (per the v5.3.2 lesson where Codex side was silently skipped).

## [5.3.2] — 2026-05-15 — Docs: internals.md case study on Step 0 confabulation + Doctor #41 bash lesson

Docs-only release. Adds a new "Why Step 0 `scan-then-ping` default (v5.3.0+) and the Doctor #41 `|| echo 0` patch (v5.3.1)" section to `docs/internals.md` documenting:

- the original Step 0 `ping`-mode confabulation pattern (warning emitted before audit-trail write, no proof-of-dispatch);
- the live repro from 2026-05-15 in `yanos-mgmt/.worktrees/pivot-landing-4b-yanos-wireguard` (codex skills present in same session that emitted "not detected");
- the historical forensic case in `yanos-os/yocto-error-qa-audit` (codex_degraded event on day 1, retro-fix `codex_host_suppressed` event 24h later via `doctor --fix` — confirming the run was actually inside Codex, where host-suppression is the correct degrade reason, but Step 0 confabulated the plugin-missing message);
- the design choice to drop the proposed "evidence-required guardrail" on Plan-agent advice (decorative — a confabulating LLM can fabricate the evidence string too) in favor of post-hoc deterministic Doctor escalation;
- the v5.3.1 `|| echo 0` bash lesson for future Doctor checks: `grep -c` always prints stdout but has three exit codes (0/1/2); don't paper over the difference with `|| echo N` fallbacks that conflate exit-1 and exit-2 — use explicit `[ -r "$file" ]` guards instead.

No code or skill behavior change. Bumped version anyway so the docs land on a tagged release that downstream installers can pin to.

## [5.3.1] — 2026-05-15 — Doctor #41 bash bug fix: `|| echo 0` produced "0\n0", silently skipping sub-fires

Patch release. Fixes a pre-existing bug in `parts/doctor.md` Check #41 bash (introduced in v5.1.1 alongside sub-fires (a)/(b); inherited by v5.3.0 sub-fire (c)).

### Fixed

- **Check #41 grep-count fallback pattern.** The idiom `grep -cE 'foo' "$events" 2>/dev/null || echo 0` produced `"0\n0"` whenever `$events` was readable with zero matches: `grep -c` always prints `"0"` and exits 1 when there are zero matches, so the `|| echo 0` fallback fired and appended a second `"0"`. The resulting two-line string then failed the downstream `[ "$var" -eq 0 ]` integer test with a `bash: [: 0\n0: integer expected` warning to stderr, and the if-branch was silently skipped. Net effect: sub-fire (a) (silent override without evidence) only fired when `events.jsonl` was entirely unreadable — never on the intended common case of "file exists with zero degraded events". Sub-fire (b) was similarly broken; new sub-fire (c) inherited the pattern in v5.3.0 but happened to be guarded by an explicit `[ -r "$events" ]` so it tripped the same bug only when `$events` was readable AND had zero matches of the target patterns. Fix: drop the `|| echo 0` fallback (since `grep -c` always prints a number when the file is readable), guard the per-bundle loop with `[ -r "$events" ] || continue` so unreadable bundles are skipped instead of misinterpreted, and use `${var:-0}` parameter expansion in the integer tests as a belt-and-suspenders default for any future caller. Found during retroactive Doctor #41 lint sweep across 426 bundles in `/path/to/workspaces/*` immediately after the v5.3.0 release.

### Verification

- Re-ran cross-repo sweep against 426 bundles (95 main + 331 yanos-mgmt worktrees) post-fix: zero spurious "integer expected" stderr lines; Check #41 still returns PASS (no historical exposure to sub-fire (c), which is by-design — legacy ping-mode false-positives left no `events.jsonl` audit trail; the new `degradation_self_doubt` event closes that gap going forward).
- `bash -n parts/doctor.md` is not applicable (markdown, not executable), but a stand-alone extraction-and-run of the Check #41 bash block against the local bundle inventory succeeded without warnings.

## [5.3.0] — 2026-05-15 — Step 0: scan-then-ping detection default + Doctor #41 ERROR escalation

Fixes a recurring false-positive class where `/masterplan` emits `⚠ Codex plugin not detected — codex_routing and codex_review are degraded to off for this run` against installs where Codex is fully present and actively dispatching. Repro that motivated this release: `/loop /masterplan --autonomy=full` in `yanos-mgmt/.worktrees/pivot-landing-4b-yanos-wireguard` on epyc2 emitted the warning while the session's own system-reminder skills list contained `codex:codex-rescue`, `codex:setup`, `codex:rescue`, etc., and `bin/masterplan-codex-usage.sh` showed the same host actively dispatching Codex in the same window.

### Changed

- **`config.codex.detection_mode` default flips `ping` → `scan-then-ping`** (`parts/step-0.md`, `docs/config-schema.md`). The new default is a deterministic-first two-tier check: **Stage A** scans the system-reminder skills list for the literal substring `codex:`; on hit, short-circuit with `detection_source: scan`. **Stage B** falls back to the existing 5-token `codex:codex-rescue` ping only when Stage A returns zero matches. Stage A has zero judgment surface — it's a literal substring test against context the orchestrator already has every turn, modeled on the existing `codex_host_suppressed` precedent. The legacy `ping`-only mode was non-deterministic: the orchestrator (an LLM) was asked to dispatch and judge, and observed false-positives where Codex was demonstrably installed but the orchestrator emitted "not detected" without proof of dispatch. **Migration:** users with explicit `detection_mode: ping` in `.masterplan.yaml` keep ping-only semantics — only the unset default flips. No state-bundle migration; `codex_ping_result` is per-invocation.

### Added

- **New `detection_mode: scan-then-ping` value** alongside existing `ping`/`scan`/`trust`. The fourth enum value, not a rename — back-compat is total.
- **Step 0 self-doubt event (`degradation_self_doubt`)** (`parts/step-0.md`). Before emitting the visible-stdout "Codex plugin not detected" warning under `unavailable_policy: degrade-loudly`, Step 0 runs two deterministic on-disk probes: (1) auth-healthy (reuses Doctor Check #39's predicate against `~/.codex/auth.json`); (2) plugin-on-disk (`ls ~/.claude/plugins/*/codex* 2>/dev/null`). If both pass but Step 0 is about to emit the warning anyway, an INFO event `degradation_self_doubt — about to emit codex-degraded warning, but auth healthy AND plugin manifest on disk; detection_mode=<...>, detection_source=<...>, ping_result=<...>` is written to `events.jsonl` on the same forced state write as the `codex degraded` event. The warning still fires (Step 0 cannot ground-truth the runtime path actually works), but the breadcrumb makes the false-positive *visible to Doctor*.
- **Doctor Check #41 sub-fire (c) — Step 0 confabulation detector** (`parts/doctor.md`). New ERROR-severity sub-fire that triggers under EITHER condition: (1) `events.jsonl` contains a `degradation_self_doubt` event (Step 0 self-flagged the false-positive at warning-time); (2) older bundles without the self-doubt breadcrumb — `events.jsonl` contains `codex degraded — plugin not detected` AND `~/.codex/auth.json` is healthy AND `~/.claude/plugins/*/codex*` exists on disk. Either path is strong evidence of Step 0 confabulation under legacy `detection_mode: ping`. Suggested action: set `detection_mode: scan-then-ping` (or remove the explicit `ping` override) and re-run. Pairs with sub-fires (a)/(b) for full coverage of the degrade-loudly visibility contract.

### Documentation

- **`docs/config-schema.md`** documents the new value, marks it default, and adds a migration note. Softens the "fragile" framing on `scan` to "structural — depends on Anthropic plugin namespacing."
- **`parts/step-0.md`** events.jsonl format list updated: success events now include `detection_source` (scan|ping) alongside `detection_mode`. One-line note added that mid-session `/reload-plugins` is uncovered (per-invocation cache, acceptable trade-off — re-running `/masterplan` rebuilds the cache).
- **`parts/doctor.md` Check #41** body updated with sub-fire (c) prose, severity line, and extended bash check (new `plugin_on_disk` probe, `self_doubt_events` / `plugin_not_detected_events` counters, ERROR-vs-WARN final-line logic).

### Verification

- Static: `grep -n "scan-then-ping\|degradation_self_doubt\|detection_source" parts/step-0.md docs/config-schema.md parts/doctor.md` returns identifiers in all expected sites.
- Cross-manifest version drift (Check #30 territory): `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (root + nested `plugins[0].version`), `.codex-plugin/plugin.json` all at 5.3.0; README's `Current release:` line bumped.
- Live smoke deferred to first post-release `/masterplan` invocation against the repro repo (yanos-mgmt/.worktrees/pivot-landing-4b-yanos-wireguard) — expectation: no degradation warning, `events.jsonl` records `codex_ping ok` with `detection_source=scan`.

---

## [5.2.3] — 2026-05-15 — Auto-retro backfill + Codex JWT cosmetic-expiry fix

Two coupled refinements that close known gaps in v5.2.x: (1) auto-retro becomes durable even when Step C 6 is bypassed, and (2) the Step 0 boot banner and doctor Check #39 stop emitting false "Codex: degraded" warnings when ChatGPT-mode auth is healthy.

### Fixed

- **Codex auth cosmetic-expiry false positive.** Step 3 of CC-2 (boot banner in `commands/masterplan.md`), doctor Check #39 (`codex_auth_expiry`), and Check #41's `auth_healthy` probe now skip sub-conditions (a)/(b) — token-expired and token-expires-within-24h — when `auth_mode == "chatgpt"` AND `tokens.refresh_token` is non-empty AND `last_refresh` is within the last 7 days. ChatGPT mode uses short-lived JWTs that auto-refresh on every codex call via the persistent refresh token; `id_token.exp` being minutes-to-hours past `now` is the normal steady state, not degradation. Sub-condition (c) — `last_refresh > 30d` — still fires, since a stale refresh_token IS a real degradation signal. Check #39 emits an INFO-style PASS line: `Check #39: PASS (auth_mode=chatgpt; JWT auto-refresh healthy; last_refresh Nd ago)`. Boot banner is silent under this shape.
- **`~/.codex/auth.json` JSON-path bug at three sites.** `commands/masterplan.md` Step 3, `parts/doctor.md` Check #39, and Check #41's `auth_healthy` probe were reading `jq -r ".id_token"` / `".access_token"` (top-level) — but the schema_v3+ shape of `~/.codex/auth.json` nests tokens under `.tokens.*`. All three now read `jq -r ".tokens.<field> // .<field> // empty"` for forward/backward schema-compat. The Read-tool-driven LLM interpretation in the boot banner compensated for the bug at runtime; the bash sites broke silently against the real schema.

### Added

- **Auto-retro backfill in Step 0 resume controller.** `parts/step-0.md` resume controller item 4 now invokes Step R inline as a backfill on any `/masterplan` touch of a `status: complete` (or `pending_retro`) bundle missing `retro.md`, provided `schema_version >= 3` and `retro_policy.waived/exempt != true`. Catches the paths where Step C 6 is bypassed entirely — manual `state.yml` edits flipping `status: complete`, brainstorm-only completions under `halt_mode=post-brainstorm`, or first-attempt retro failures that left `status: pending_retro`. Makes auto-retro durable by default, mirroring the in-flight 6a-guard.
- **`retro_policy.exempt` field.** Marks a bundle as deliberately retro-less (e.g., the `p4-suppression-smoke` hand-crafted fixture); bypasses both the resume-controller backfill and Doctor #28's `--fix` `AskUserQuestion`.
- **`bin/masterplan-state.sh` auto-heal shim.** `transition-guard` normalizes the typo'd `status: retro_pending` (one outlier bundle in the corpus from an earlier writer) to the canonical `status: pending_retro` on read, rewriting `state.yml` on disk.

### Removed

- **`codex_health_check_jwt_only` watcher** in `lib/masterplan_session_audit.py` — retired after serving its purpose. The watcher (added v5.2.1) flagged the false-positive class; the proper fix is now landed in v5.2.3, so the watcher is no longer load-bearing. The user-visible boot banner IS the regression detector going forward — if the false positive returns, it returns visibly on every `/masterplan` invocation. Also removed from `bin/masterplan-findings-to-issues.sh` hard-codes CSV.

### Documentation

- **`docs/internals.md` §4 Run bundle format** documents the auto-retro backfill clause and `retro_policy.exempt` field.
- **`docs/internals.md` Codex-routing visibility section** documents the v5.2.3 cosmetic-expiry refinement and the watcher retirement.
- **`parts/step-c.md` 6b** cross-references the resume controller as the catch-all for paths that reach `status: complete` without entering Step C 6.

### Verification

- Check #39 bash extracted and run against live `~/.codex/auth.json` (auth_mode=chatgpt, last_refresh=2026-05-15T16:41:36Z): returned `Check #39: PASS (auth_mode=chatgpt; JWT auto-refresh healthy; last_refresh 0d ago)`.
- Check #41 `auth_healthy` probe: sets `auth_healthy=1` under the cosmetic-shape gate against the same auth.json.
- `python3 -m py_compile lib/masterplan_session_audit.py`: clean.
- `bash -n` on `bin/masterplan-findings-to-issues.sh` and `bin/masterplan-state.sh`: clean.
- `bin/masterplan-state.sh transition-guard` smoke against a temp copy of a `status: retro_pending` bundle: file successfully rewritten to `status: pending_retro`.
- Router byte ceiling: `commands/masterplan.md` now 11460 bytes (well under the 20480 limit).

---

## [5.2.2] — 2026-05-15 — AUQ-guard softening: bash-input + classifier-denial escape hatches

Targeted softening of the AUQ-guard Stop hook (`hooks/auq-guard.sh`) to suppress two false-positive dialog-cycle cases observed in real sessions:

1. When the user runs a shell command directly via the harness's `!` prefix (the prior user message contains a `<bash-input>` or `<bash-stdout>` tag), the assistant's natural response is a free-text ack/recap — forcing an AUQ creates pointless choreography after work the user already performed.
2. When the user's tool call was denied by the Claude Code auto-mode classifier ("denied by the Claude Code auto mode classifier" in the last `tool_result`), the natural recovery is free-text instructions ("run it via `!` or add a permission rule") — not another AUQ ceremony.

### Changed

- **`hooks/auq-guard.sh` — Escape hatch B** (~lines 67-74): bail when the most recent real user message contains `<bash-input>` or `<bash-stdout>`. Sequenced after the existing `<no-auq>` / `[oneshot]` hatch.
- **`hooks/auq-guard.sh` — Escape hatch C** (~lines 76-95): scan the most recent `tool_result` content for the literal classifier-denial string and bail when present. Uses the same `jq` shape the existing turn-block walker uses, scoped to the current user turn.

Both hatches preserve the substantive-turn gate and circuit breaker; they only short-circuit the violation-detection cascade for the two specific shapes named above. Smoke-verified with synthetic transcripts.

### Notes

- This is a hook-only patch: no orchestrator behavior changes, no doctor checks, no plan-bundle schema bumps. Existing in-flight runs are unaffected.
- The deployed `~/.claude/hooks/auq-guard.sh` had already drifted ahead of the committed `hooks/auq-guard.sh`; this release also resyncs the in-repo copy to the deployed shape (substantive-turn gate, Mode C flat-ending detection, circuit breaker, JSON `decision: block` output, all prior iterative improvements).

---

## [5.2.1] — 2026-05-15 — Doctor #39 false-positive watcher + README release-pin fix

Follow-up to v5.2.0 driven by a real `/masterplan doctor` run that produced a misleading "Codex auth expired" warning despite `/codex:setup` reporting full health. Per `feedback_failures_drive_instrumentation_not_fixes`, the doctor check itself is not patched here — instead, the recurring-audit module gains a new continuous watcher that surfaces the false-positive shape so the analyzer can drive prioritization of a proper fix.

### Added

- **New policy-regression watcher `codex_health_check_jwt_only`** in `lib/masterplan_session_audit.py` (hard-threshold). Emits a `meta`-source finding when `~/.codex/auth.json` has the shape that triggers doctor check #39 sub-conditions (a)/(b) cosmetically: `auth_mode == "chatgpt"` AND `tokens.refresh_token` present AND `last_refresh` within 7 days AND `id_token.exp` < now. This is the exact pattern where Codex auto-refreshes JWTs on every call and a doctor warning is meaningless. Mirrored in `bin/masterplan-findings-to-issues.sh` hard-codes CSV. `meta`-source findings bypass the wipe-breadcrumb gate (the gate only applies to plan-source findings).

### Fixed

- **`README.md` release pin drift** (`Current release: **v5.1.1**` → `**v5.2.0**`). Surfaced by doctor check #30 in the v5.2.0 release validation run.

### Notes

- Doctor check #39 itself is intentionally NOT modified in this release. The watcher surfaces every false-positive occurrence; the proper fix (delegate to `/codex:setup`-equivalent health logic instead of rolling its own JWT arithmetic) will land via a separate change once the analyzer has accumulated enough recurrence data per `feedback_failures_drive_instrumentation_not_fixes`.
- Smoke-verified against live `~/.codex/auth.json` on the development host: watcher correctly detected the cosmetic-expiry shape (id_token 30 minutes past `exp` with healthy refresh state).

---

## [5.2.0] — 2026-05-15 — Wipe helper + policy-regression watcher

Two coupled additions under the `radiant-watchful-dawn` plan:

1. **Workstream A — telemetry wipe helper** that erases mixed pre/post-v5.1.1 telemetry so the new doctor-check evidence in `events.jsonl` is no longer conflated with stale silent-degradation-era data.
2. **Workstream B — continuous policy-regression watcher** that extends the recurring-audit pipeline with 15 new detector categories. Hard-threshold breaches auto-file GH issues; soft breaches remain local. Watches for the same class of regression that motivated v5.1.1 (annotation gaps, missing routing/review dispatches, missing ping events, silent degradation, CC-3 trampoline skips, CD-3 verification gaps, parallel-eligible-serial dispatch, etc.).

### Added — Policy-regression watcher (radiant-watchful-dawn, Workstream B)

Aimed at the post-instrumentation question of "how do we know future regressions don't silently slip past?" — extends `lib/masterplan_session_audit.py` with 15 new `WarningItem` categories and wires the recurring-audit cron to dispatch hard-threshold breaches to GitHub issues with the same signature/dedup/reopen semantics as the v5.1.0 anomaly framework. No new data sources: detectors operate on already-loaded artifacts (`plan.md`, `state.yml`, `events.jsonl`, Claude/Codex transcripts).

- **15 new detector categories in `lib/masterplan_session_audit.py`**. Hard-threshold (file GH issue): `codex_annotation_gap_on_high`, `codex_routing_configured_but_zero_dispatches`, `codex_review_configured_but_zero_invocations`, `missing_codex_ping_event`, `silent_codex_degradation`, `cc3_trampoline_skipped_after_subagents`, `cd3_verification_missing_on_complete`, `brainstorm_anchor_missing_before_planning`, `wave_dispatched_without_pin`, `parallel_eligible_but_serial_dispatched`. Soft-threshold (local snapshot only): `codex_parallel_group_missing_on_high`, `pending_gate_orphaned`, `cd9_free_text_question_at_close`, `auq_guard_blocked_count_high`, `complexity_unset_fallthrough`. Each category cites the policy in `parts/step-b.md` / `parts/step-c.md` / `parts/step-0.md` / `commands/masterplan.md` it watches.
- **`bin/masterplan-findings-to-issues.sh`** (~250 lines). Reads `${MASTERPLAN_AUDIT_STATE_DIR}/findings.jsonl`, filters to the hard-code allowlist, computes `sha1(code|repo|session)[:12]` signature, dispatches to `gh` with labels `auto-filed` + `class/policy-regression` + `class/<code>`. Local-first persistence: failures land at `findings-pending-upload.jsonl` for next-run drain (mirrors `anomalies-pending-upload.jsonl`). Sentinel at `findings-last-run-id.txt` advances by `run_id` so each audit pass only dispatches newly-emitted findings. Honors `.masterplan.yaml` `failure_reporting.{repo, enabled, dry_run}` — same knobs as v5.1.0 anomaly framework. Args: `--dry-run`, `--all`, `--since-run-id`, `--limit N`, `--no-skip-wiped`, `--repo`, `--state-dir`, `--plans-roots`.
- **Wipe-breadcrumb gate.** Default behavior skips any finding whose plan `state.yml` contains an `events_wiped:` block, so the WS-A wipe does not flood the tracker with historical noise. Override with `--no-skip-wiped` for backfill of legitimate pre-wipe gaps.
- **Wired into `bin/masterplan-recurring-audit.sh`.** The audit cron now dispatches at the tail after JSON+table writes complete. Disable per-run with `MASTERPLAN_AUDIT_SKIP_FINDINGS_DISPATCH=1`.
- **`bin/masterplan-policy-regression-smoke.sh`** (~340 lines, 44 assertions). 12 plan-side detector fixtures + 1 clean negative control (one per detector category, with positive + negative assertions); 8 dispatcher scenarios (PATH-stubbed `gh` + isolated `$HOME`): hard-code dispatch, soft-code skip, wipe-breadcrumb skip, orphan-plan-dir skip, sentinel advance, open-issue comment, closed-issue reopen, gh-failure pending replay, dry-run no-sentinel-touch, `--no-skip-wiped` override. Mirrors `masterplan-anomaly-smoke.sh` pattern; run before every release.
- **`docs/internals.md` § 9 Policy-regression watcher subsection** — design overview, 15-row detector reference table (hard/soft + policy citation), dispatcher mechanics, wipe-breadcrumb gate explanation, backfill controls, skip-flag, smoke-test summary.

### Why this release ships the watcher AND a wipe together

The wipe (WS-A) creates a clean baseline for the new visibility surfaces shipped in v5.1.1. Without the watcher (WS-B), the next regression of the same class would again take 12 months to surface — the wipe alone solves nothing forward-looking. The watcher without the wipe would file ~200 GH issues against pre-v5.1.1 historical noise that the user can do nothing about. Both shipped together: clean baseline + continuous monitoring of policy compliance against the baseline. The dispatcher's wipe-breadcrumb gate makes this composable — if you ever wipe again, history is automatically suppressed.

### Verified before release

- 44/44 smoke assertions pass on `bin/masterplan-policy-regression-smoke.sh`
- Real dry-run against the user's live audit state: 366 findings eligible → 7 dispatched (live plans with real policy gaps) / 160 skipped-soft / 182 skipped-wiped / 17 skipped-orphan / 0 failed. Wipe-breadcrumb gate proven to work against real post-wipe filesystem state.

### Added — Pre-v5.1.1 telemetry wipe helper (radiant-watchful-dawn, Workstream A)

Aimed at the post-v5.1.1 cleanup step: erase 12 months of mixed pre-and-post-instrumentation telemetry so the new doctor-check evidence in `events.jsonl` is not conflated with stale data from the silent-degradation era. Destructive surface is gated behind a default `--dry-run`, an explicit `--apply`, and a `wipe-confirmed` confirmation token (or `--yes` for unattended runs).

- **`bin/masterplan-wipe-telemetry.sh`** (thin bash wrapper) + **`lib/masterplan_wipe_telemetry.py`** (deletion logic). Walks Claude transcripts under `~/.claude/projects/*/*.jsonl`, Codex transcripts/history/log/archived under `~/.codex/`, and per-bundle telemetry (`events.jsonl`, `anomalies.jsonl`, `anomalies-pending-upload.jsonl`, `subagents.jsonl`, `eligibility-cache.json`) across every repo under `$MASTERPLAN_REPO_ROOTS` (default: the parent of the active repository or `~/dev`) including `.worktrees/` copies.
- **Hard keep-list** preserves all bundle work product (`plan.md`, `state.yml`, `spec.md`, `retro.md`, `worklog.md`, `next-actions.md`, `gap-register.md`) and protected directories (`reviews/`, `notes/`, `subagent-reports/`, `artifacts/`). Codex `auth.json` and `config.toml` are untouched.
- **mtime skip** defends against in-progress writes — files modified within the last 5 minutes (configurable via `--mtime-skip=N`) are never deleted.
- **Manifest** at `${XDG_STATE_HOME:-~/.local/state}/masterplan/wipes/<UTC-timestamp>.txt` is written BEFORE any deletion, listing every path with byte count + per-category totals, so post-mortem is always recoverable.
- **State.yml breadcrumb**: each affected bundle's `state.yml` gains a top-level `events_wiped:` block (`ts`, `manifest`, `note`) so future `/masterplan status` / doctor runs can distinguish "never had telemetry" from "telemetry was wiped at <ts>". Append-only; does not mutate other fields per CD-7.
- **Per-category opt-out flags:** `--no-claude`, `--no-codex`, `--no-bundle-logs`, `--no-worktrees`, `--repo-roots=A:B` for narrow runs.
- **Verified on this repo's host:** 1600 files / 1.32GB deleted on 2026-05-15; bundle work product across 280 bundles preserved; `events_wiped:` breadcrumb confirmed on sample bundles.

### Why a wipe and not a quarantine

Pre-v5.1.1 telemetry contains 24h of silent-degradation evidence (zero `codex_ping` events, missing `**Codex:**` annotations, expired auth with no warning). Quarantining preserves data nobody will ever query and complicates doctor checks #39/#40/#41 by forcing them to filter by `events_wiped:` timestamp. Wipe gives the new visibility surfaces a clean baseline; the manifest preserves the file inventory for forensic reference.

## [5.1.1] — 2026-05-15 — Codex-routing visibility instrumentation

### Added — Codex-routing visibility instrumentation (cosmic-cuddling-dusk)

Five surgical additions that surface the silent-degradation failure modes observed across 24h of `/masterplan` runs: Codex auth expiring without any user-facing signal, planner skill silently skipping `**Codex:**` and `**parallel-group:**` annotations at `complexity: high`, and the degrade-loudly visibility contract failing to write evidence to `events.jsonl`. All read-only diagnostics — none alter routing logic, eligibility cache, dispatch contract, or persisted state schema.

- **Doctor check #39 — `codex_auth_expiry` (Warning, repo-scoped, v5.1.1+, I-1).** Reads `~/.codex/auth.json`, base64url-decodes the JWT `exp` claim from `id_token` and `access_token`, and warns when either token is expired, expiring within 24h, or when `last_refresh` is older than 30 days. Pairs with check #18 (config-vs-plugin mismatch): #18 flags persistent misconfig; #39 flags expired credentials. Skipped silently when `~/.codex/auth.json` is absent (codex not installed). Report-only — auth refresh is browser-based OAuth, user-owned per headless-host constraint.
- **Doctor check #40 — `high_complexity_codex_annotation_gap` (Warning, plan-scoped, v5.1.1+, I-2).** For each `state.yml.complexity == "high"` plan: counts `^### Task ` headings in `plan.md` and compares against `**Codex:** (ok|no)` annotation count; warns when annotations are fewer than tasks. INFO-flags when zero `**parallel-group:**` annotations exist (planner brief encourages clustering verification/lint tasks). Catches the writing-plans skill silently skipping the high-complexity brief — which suppresses Codex routing (eligibility cache falls back to heuristic-only) and parallel-wave dispatch (wave assembly pre-pass has nothing to assemble). Skipped silently on `complexity: low` and `complexity: medium`.
- **Doctor check #41 — `missing_codex_degradation_evidence` (Warning/Info, plan-scoped, v5.1.1+, I-3).** Two sub-fires: (a) WARN when `codex_routing == off` AND `codex_review == off` AND `~/.codex/auth.json` is healthy AND `events.jsonl` has no `codex degraded` event AND `last_warning` is null (silent override without evidence — violates the degrade-loudly visibility contract); (b) INFO when `codex_routing == auto|manual` AND `events.jsonl` has zero `routing→[codex]` events AND at least one `codex_ping ok` event (suggesting ping detected codex available but every task was judged ineligible — cross-references #40 for the same plan).
- **Boot-banner Codex health indicator** (`commands/masterplan.md` CC-2, I-4). Conditional second sentinel line emitted directly under the version sentinel when ALL of the following hold: `codex.routing != off` OR `codex.review == on` in resolved config, `~/.codex/auth.json` exists, and any JWT is expired. Format: `↳ Codex: degraded (id_token expired Nd ago, access_token expired Md ago) — run \`codex login\` to refresh`. Softer variant `↳ Codex: stale (last_refresh Nd ago — consider running \`codex login\`)` when tokens are within validity but `last_refresh` > 30 days. Silent when codex is intentionally off or auth is healthy. Cost: 1 Read + 2 base64-decodes ≈ 50ms.
- **`codex_ping` event class in `events.jsonl`** (`parts/step-0.md`, I-5). Step 0's Codex availability detection always logs the outcome to `events.jsonl`, regardless of result: `codex_ping ok — detection_mode=<ping|scan>` on success; `codex_ping skipped — detection_mode=trust` or `codex_ping skipped — codex_host_suppressed` when detection is bypassed; existing `codex degraded — ...` event on failure (no duplicate). Makes the per-run codex-availability decision auditable in every events.jsonl so check #41 can distinguish "ping never ran" from "ping returned ok but no Codex dispatches" from "ping returned error".

Doctor.md heading and parallelization brief updated to (#1 .. #41); complexity-aware check set updated (#41 fires on all complexity levels; #40 only on high); severity table extended with three new rows. Doctor #39 is repo-scoped and runs inline at the orchestrator; #40 and #41 are plan-scoped and run in per-worktree Haiku dispatchers when worktrees ≥ 2.

### Why instrumentation, not fixes

Per the project's failure-instrumentation principle (codified in `[5.1.0]` and reinforced by user feedback): never design a `/masterplan` fix on the spot. The instrumentation surfaces the failure rate; subsequent releases prioritize fixes once the analyzer (`bin/masterplan-failure-analyze.sh`) produces durable evidence of which failure modes recur and which were one-offs. The Codex auth-expiry case is unusual in that the upstream cause is user-owned (browser OAuth refresh), so doctor #39 reports rather than auto-fixes.

### Deferred items

- Should Step 0's `ping` mode actually exercise `codex exec` (force the auth path) rather than just dispatching the subagent_type? Currently the ping returns OK if the subagent dispatches OK, even with broken downstream auth. Specification question — surface via #41 sub-fire (a) when it bites.
- Should the boot-banner Codex degraded line gate downstream behavior via an `AskUserQuestion` rather than passive stdout? UX question.
- Should the framework offer to launch `codex login` via shell-out when the user invokes `/masterplan` with expired auth? Headless-host constraint permits user-initiated interactive OAuth.
- Why is the planner skill silently skipping high-complexity annotations? Needs transcript analysis of the writing-plans subagent invocations.

## [5.1.0] — 2026-05-14 — Failure-instrumentation framework

### Added
- **Failure-instrumentation framework** (`hooks/masterplan-telemetry.sh` Section 9, ~280 lines). Six anomaly classes auto-detected at end-of-turn from `<masterplan-trace …>` breadcrumbs + `state.yml` + `events.jsonl`: `silent-stop-after-skill`, `unexpected-halt`, `state-mutation-dropped`, `orphan-pending-gate`, `step-trace-gap`, `verification-failure-uncited`. Each detection writes a canonical record to `<run-dir>/anomalies.jsonl` first, then files/comments/reopens a GitHub issue against `rasatpetabit/masterplan` (or configured override) with stable SHA1 signatures and dedup. Local-first persistence: gh failures land in `<run-dir>/anomalies-pending-upload.jsonl` for later drain. Configurable per `.masterplan.yaml` `failure_reporting.{repo, enabled, dry_run}`.
- **Versioned anomaly taxonomy** (`parts/failure-classes.md`): per-class symptom, signals, detector pseudo-shell, and signature inputs. Adding a class requires extending this file + the hook detector dispatch.
- **Step-boundary breadcrumb stream** in `parts/step-0.md`, `step-a.md`, `step-b.md`, `step-c.md`, `import.md`, `doctor.md` — additive `<masterplan-trace step=… phase=in|out>`, `skill-invoke`, `skill-return`, `gate=fire`, `state-write` emit points at well-defined control flow boundaries. Visible turn output (not internal reasoning) so they survive context compaction.
- **`bin/masterplan-failure-analyze.sh`** — over-time analysis script. Queries `auto-filed`-labeled issues from the destination repo, computes frequency by class, recurrence-after-fix histogram (regression signal — the single most important metric for evaluating whether fixes actually held), open-time-to-close median per class, per-verb / per-step breakdown, same-day co-occurrence pairs. Output: markdown to stdout + dated snapshot at `docs/failure-analysis/<YYYY-MM-DD>.md`.
- **`bin/masterplan-anomaly-flush.sh`** — drain pending-upload queue. Walks every run bundle under `docs/masterplan/`, retries each pending record via `gh`. Records that fail again are preserved in place for the next run.
- **`bin/masterplan-anomaly-smoke.sh`** — synthetic-transcript smoke test. Eleven assertions across all six classes + signature stability + dedup + regression reopen + dry-run mode. Mock `gh` via PATH stub; isolated `$HOME=/tmp/...` so it never touches the real Claude Code session log or real GitHub. Run before every release.
- **Doctor Check #38** (`anomaly-file-has-records-since-last-archive`): warns when `<run-dir>/anomalies.jsonl` or `anomalies-pending-upload.jsonl` contains records, nudging users to run the analyzer or flush pending uploads. Report-only.
- **`docs/failure-analysis/`** directory for analyzer snapshots (with `.gitkeep`).
- **`docs/internals.md` § 9 Failure-instrumentation framework subsection** — design overview, anomaly classes table, signature semantics, dedup/regression branches, analyzer recipes, smoke-test workflow, configuration knobs.

### Why this release ships before any bug fix

Per direct user feedback: "even the most basic of `/loop /masterplan next`s fail in spectacularly catastrophic ways, which shows me you've done absolutely nothing to test this at all." The fix wasn't to design more fixes — it was to stop shipping fixes designed on the spot and start designing them from accumulated failure data. This release ships the instrumentation; subsequent releases will fix specific anomaly classes identified by the analyzer.

### Known followups

- Redaction layer for sensitive paths/slugs in issue bodies (Phase 2). The default destination `rasatpetabit/masterplan` is private to the user; redaction becomes necessary only if a future deployment files to a public repo.
- Codex-host parity for failure detection. Section 9 is currently Claude Code Stop-hook only.

## [5.0.1] — 2026-05-13 — Doctor #31 v5 fix + bundle maintenance

### Fixed
- **Doctor check #31** (`per_autonomy_gate_condition_consistency`): update grep target from `commands/masterplan.md` to `parts/step-b.md` (gates moved during v5.0 lazy-load extraction); drop stale `L1286`/`L1360` line-number references from all three spec locations (parallelization preamble, check table row, check body).
- **6 archived bundle `state.yml` files** had stale `worktree:` path (`/path/to/workspace/…`) from pre-migration home directory; `worktree_disposition: missing` was absent; `stop_reason`/`critical_error` fields missing. All six repaired: `auto-compact-nudge-fixes`, `cd-9-enforcement`, `complexity-levels`, `intra-plan-parallelism`, `subagent-execution-hardening`, `v2.3.0-cost-leak-recurrence`.

### Added
- **`docs/masterplan/masterplan-taskcreate-projection/`** run bundle: imported from legacy spec + plan (2026-05-12 P4 design artifacts). Status `completed`; implementation lives in `p4-suppression-fix` bundle. Deferred smoke test tracked in `p4-suppression-smoke`.

## [5.0.0] — 2026-05-13 — Lazy-loaded phase prompts (router/parts split + 5 new doctor checks)

**Breaking architectural reorganization.** Splits the 341 KB `commands/masterplan.md` monolith into a 97-line router plus lazy-loaded `parts/` phase files, eliminating chronic context-pressure. No `state.yml` schema bump; existing bundles resume unchanged. Run bundle: `docs/masterplan/v5-lazy-phase-prompts/`.

### Added
- **Router + `parts/` lazy-load layout (T1–T20).** New `parts/` tree: `step-0.md`, `step-a.md`, `step-b.md`, `step-c.md`, `doctor.md`, `import.md`, `codex-host.md`, `contracts/`. Docs moved to `docs/verbs.md` + `docs/config-schema.md`.
- **Doctor check #32** (`scalar_cap_enforcement`, Error) — 200-char cap on every `state.yml` scalar at write time; overflow redirected to sidecar files.
- **Doctor check #33** (`projection_mode`, Warning) — verifies TaskCreate projection mode matches declared host environment.
- **Doctor check #34** (`plan_index_staleness`, Warning) — detects `state.yml plan.index` out of sync with `plan.md` headings.
- **Doctor check #35** (`plan_format_conformance`, Warning) — validates v5 plan-format markers (`**Spec:**` / `**Verify:**` / `**Files:**`) per task; pre-v5 plans surface as warnings by design.
- **Doctor check #36** (`router_byte_ceiling`, Error) — hard 20 KB ceiling on `commands/masterplan.md`; current 7.9 KB (40% of ceiling).
- **`bin/masterplan-state.sh build-index` (T21)**, `migrate-state` (T22), `migrate-plan` (T23) subcommands.
- **`parent_turn` / `subagent_turn` telemetry split (T25)** + `--parent` flag on routing-stats (T26).
- **Five self-host audit phase-file checks (T27):** `check_cc3_trampoline`, `check_cd9_coverage`, `check_dispatch_sites`, `check_sentinel_v4_refs`, `check_plan_format`.

### Changed
- `skills/masterplan/SKILL.md` rewritten for v5 router-plus-parts dispatch model.
- `docs/internals.md` updated for `parts/` tree + new doctor checks #32–#36.
- Manifest versions bumped 4.2.1 → 5.0.0 across all three plugin manifests.

### Migration
- No schema bump. Pre-v5 plans run unchanged but surface doctor #35 warnings. Convert with `bin/masterplan-state.sh migrate-plan <plan.md>`. Custom v4.x monolith patches need re-porting to the relevant `parts/` file.

## [4.2.1] — 2026-05-13 — Doctor checks #30 + #31 (cross-manifest version drift + per-autonomy gate consistency)

Report-only; no auto-fix. Both carried from v4.2.0 retro.

### Added
- **Doctor check #30** (`cross_manifest_version_drift`, Warning, repo-scoped) — diffs `version` across `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (root + nested), `.codex-plugin/plugin.json`; fixes the marketplace.json stuck-at-3.3.0 gap.
- **Doctor check #31** (`per_autonomy_gate_condition_consistency`, Warning, repo-scoped) — audits per-autonomy gate conditions against a static anchor table; initial table covers spec_approval (L1286, `!= full`) and plan_approval (L1360, `== gated`).
- **L1286 inline HTML comment** — documents the intentional spec_approval / plan_approval asymmetry with a pointer to v4.2.0 rationale and #31.

## [4.2.0] — 2026-05-13 — loose autonomy auto-approves plan_approval gate

Fix: `plan_approval` gate at L1360 was guarded on `--autonomy != full` but the loose-autonomy contract requires auto-progress. Changed to `--autonomy == gated`; under loose/full clears `pending_gate` and appends `plan_approval_auto_accepted` to `events.jsonl`. `spec_approval` (L1286) intentionally unchanged — still halts under loose. Also caught up `.claude-plugin/marketplace.json` from stuck 3.3.0 → 4.2.0. Run bundle: `docs/masterplan/loose-skip-plan-approval/`.

### Migration
Users who relied on the L1360 halt should add `--autonomy=gated` to kickoff invocations. `autonomy: gated` in `~/.masterplan.yaml` restores both halts globally.

## [4.1.1] — 2026-05-12 — Verified reminder suppression + Step C entry split

Addresses both findings from the codex adversarial review of v4.1.0 (commit `bbe5a38`).

### Added
- **Per-state-write `TaskUpdate` priming (HIGH)** — extends per-transition mirror to every Step C `state.yml` write; closes idle-turn harness-reminder gap. Gated on `codex_host_suppressed == false` AND `current_task != ""`.
- **Step C entry split (MEDIUM)** — new `step_c_session_init_sha` field; first entry per session does full rehydration, subsequent entries do drift-check via `TaskUpdate`.
- **`bin/masterplan-state.sh session-sig`** subcommand — returns `CLAUDE_SESSION_ID` or a fresh UUID.

## [4.1.0] — 2026-05-12 — TaskCreate projection (partial reminder suppression)

### Added
- TaskCreate projection layer: plan tasks mirrored to the harness native task ledger for UI visibility. Claude Code-only; Codex no-op. Per-transition `TaskUpdate` at every Step C `state.yml` task transition plus drift recovery on rehydration. Four new `events.jsonl` event types. `bin/masterplan-self-host-audit.sh --taskcreate-gate` check enforces the Codex no-op invariant.

### Notes
- Reminder suppression is partial at this release (transition-only); v4.1.1 closes the idle-turn gap via per-state-write priming.

## [4.0.0] — 2026-05-13 — lifecycle hardening (FM-A/B/C/D/G)

**Breaking:** `state.yml` schema bumps `schema_version: 2 → 3`. Lazy v2→v3 migration on first write; v2 bundles remain readable. Run bundle: `docs/masterplan/v4-lifecycle-redesign/`.

Six-wave lifecycle hardening pass:
- **FM-A** — `transition_guard()` write barrier at every Step C status/phase write; `pending_retro` status for retro failures; `retro_policy.waived` opt-out. Schema_v3 adds `worktree_disposition`, `retro_policy`, `scope_fingerprint`.
- **FM-C** — atomic Step I3 import via temp-dir staging; I3.5 hydration guard verifies disk copies before writing artifact pointers; doctor #9 surfaces hydration gaps.
- **FM-B** — Step B0 Jaccard scope-overlap scan (`SCOPE_OVERLAP_THRESHOLD = 0.6`) before slug creation; AUQ: resume / derive variant / force new.
- **FM-D** — `commands/masterplan-contracts.md` registry with 4 contracts (`import.convert_v1`, `doctor.schema_v2`, `retro.source_gather_v1`, `related_scope_scan_v1`); `contract_id:` in briefs + sampling-based parent re-verify; `--brief-style` lint mode in self-host audit.
- **FM-G** — `worktree_disposition` 4-state field; Step C 6a auto-removes worktrees on completion (non-interactive, loose-autonomy contract); `--keep-worktree` opt-out; doctor #29 reconciles `git worktree list` against bundle pointers.

### Migration
v2 bundles work unchanged; migration is lazy. Force with `/masterplan doctor --fix` (no-op state write triggers the shim).

## [3.3.0] — 2026-05-12 — sentinel hardening + brainstorm intent-anchor Haiku dispatch

### Fixed
- **Invocation sentinel emitting `v?` or literal `v<version-from-plugin.json>`.** Root cause: angle-bracket syntax was treated as a literal template token, not a Read instruction. Rewrote the sentinel block with imperative Read-tool language, a concrete semver example, and an explicit prohibition on `v?`/`vTBD`/template tokens; fallback is the literal string `vUNKNOWN`.
- **Brainstorm intent-anchor read blew Opus context** (optoe-ng `WORKLOG.md` was 81KB / 25K tokens). Refactored Step 939 to dispatch a `model: "haiku"` subagent (each Read capped at 500 lines; WORKLOG.md capped at 200 lines) that returns the `brainstorm_anchor` JSON directly. Orchestrator owns state-write; Haiku owns reads + classification. On `mode: "unclear"` or invalid JSON, falls through to `AskUserQuestion` gate.

## [3.2.9] — 2026-05-12 — `/masterplan import` dedup false-positive fix

### Fixed
- **Already-migrated records flagged for re-import.** Two stacked dedup bugs in `bin/masterplan-state.sh`: (1) `canonical_slug()` applied to directory names but not frontmatter `slug:` fields, so date-prefixed slugs always missed the string-equal check; (2) existing bundles' `legacy:` pointers were never read back during a subsequent import. Fix: two parallel indices (`by_canonical` + `by_legacy_path`) checked before declaring a record "would-migrate"; skip-reason strings distinguish which fired. Step I1.4 and I3 pre-flight docs tightened to prevent drift.

## [3.2.8] — 2026-05-11 — User-facing scrub of `bin/masterplan-state.sh`

### Fixed
- **`bin/masterplan-state.sh` path references in user-facing surfaces.** The script lives in the plugin install dir, not the user's CWD, so recommending it always 404s. Removed from `skills/masterplan-detect/SKILL.md`, `skills/masterplan/SKILL.md`, `commands/masterplan.md` (6 sites), `README.md`, and `docs/masterplan/README.md`; replaced with `/masterplan import`. Script itself retained as plugin-internal tooling.

## [3.2.7] — 2026-05-12 — Forward-progress audit instrumentation

### Added
- `plan_kind` + `follow_ups` fields in run state; audit/doctor work must materialize routable follow-up records, not prose `next_action` text.
- `bin/masterplan-session-audit.sh` scans run state + transcripts; reports stable warning codes for meta-resume loops, shell traps, unroutable prose, and completed meta-plans with unmatrialized gaps.
- `bin/masterplan-recurring-audit.sh` + `bin/masterplan-audit-schedule.sh` for managed cron-based audit loop.

### Fixed
- Codex shell-trap recovery: `$masterplan ...` shell invocations now treated as recoverable normal-chat, not errors.
- Resume selection prefers in-progress implementation plans over completed meta-plans to prevent audit-loop resumption.

## [3.2.6] — 2026-05-12 — Codex native goal pursuit

### Added
- Codex-hosted runs now use native goal tools (`get_goal` / `create_goal` / `update_goal`) as the cross-turn pursuit wrapper; `update_goal(status="complete")` fires only after Masterplan's completion finalizer succeeds.

### Fixed
- Cleanup skips `status: complete` bundles with concrete `next_action`, classifying them as `completed_with_follow_up` for Step N.
- Session audit detects `create_goal` / `update_goal` calls and reports goals created but never completed.

## [3.2.5] — 2026-05-12 — Codex normal-chat resume hints

### Fixed
- Codex close-out/budget-stop text now uses normal-chat form (`Use masterplan execute <state-path>`) instead of `$masterplan ...` which Codex TUI sends to Bash as env-var expansion.
- `bin/masterplan-session-audit.sh` classifies Codex guardian sub-sessions as auxiliary; adds `session_role`, `goal_outcome`, `goal_failure_reasons` to JSON output.

## [3.2.4] — 2026-05-12 — loop-first resume contract

### Added
- `bin/masterplan-session-audit.sh` refactored to wrap `lib/masterplan_session_audit.py` with fixture-backed unit tests; `--session-audit` gate in self-host audit.
- Loop-first resume contract: `state.yml` distinguishes `stop_reason` from `status`; `status: blocked` reserved for `critical_error` recovery only.

### Fixed
- Codex `request_user_input` results now count as explicit gate selection (including recommended option with no note); no spurious `pending_gate` preservation.
- Session audit treats `/masterplan` as active only with real invocation/runtime markers; deduplicates warnings; adds stable `code` fields; adds `stop_kind` field and `active_masterplan_unclassified_stop` warning.

## [3.2.3] — 2026-05-11 — adaptive brainstorm interviews

### Added
- Step B1 now briefs every spec-creating kickoff to ask structured interview questions before spec writing, scaling depth by resolved complexity, issue seriousness, and current understanding.

## [3.2.2] — 2026-05-11 — Codex host budget and telemetry audit fixes

### Added
- `bin/masterplan-session-audit.sh` — read-only audit over Claude/Codex JSONL and telemetry files; reports repo-level totals, runaway thresholds, and missing-telemetry gaps without printing secrets.

### Fixed
- Codex-hosted runs now have performance budgets, summary-first loading, and a live-auth stop rule to prevent status/audit requests from expanding into hundreds of inline tool calls.
- Codex `request_user_input` continuations keep `full`/`execute` flows moving after `gate_closed`; host suppression blocks only recursive Codex dispatch.
- Codex skill now loads targeted sections of `commands/masterplan.md` rather than the full prompt on ordinary invocations.
- SessionStart hook installs a compact shim (`<!-- masterplan-shim: v3 -->`) instead of symlinking the full prompt.

## [3.2.1] — 2026-05-10 — Codex gate-consent hardening

### Fixed
- Codex `request_user_input` results selecting only the recommended option with no `user_note` are now weak evidence, not consent; `pending_gate` preserved, no-action terminal rendered.
- Doctor no longer false-positives on legacy `docs/superpowers/...` artifacts referenced via bundle `legacy.*` / `artifacts.*` when filename slug differs from bundle slug.

### Added
- `bin/masterplan-self-host-audit.sh --codex` verifies recommended-answer guard is present in the shipped orchestrator prompt.

## [3.2.0] — 2026-05-10 — anchored brainstorming and Codex config bootstrap

### Added
- Brainstorm intent anchor: Step B1 reads cheap repo truth, classifies topic into one of 6 anchor modes (`feature-ideas` / `implementation-design` / `audit-review` / `deferred-task` / `execution-resume` / `unclear`), persists `brainstorm_anchor` before spec writing. Self-host audit checks the contract against regression fixtures.

### Fixed
- Audit/review and deferred-task prompts now get structured anchor gates before spec writing instead of expanding into unconstrained feature planning.
- Codex skill now explicitly loads `~/.masterplan.yaml` + repo-local `.masterplan.yaml` before deriving defaults; suppresses only `codex:codex-rescue` routing, not global settings.

## [3.1.1] — 2026-05-09 — continuation and Codex prompt exposure fixes

### Fixed
- Added Codex-visible `masterplan` skill so fresh Codex sessions load `commands/masterplan.md` and recognize `docs/masterplan/<slug>/state.yml` bundles (prior packaging proved only marketplace registration, not prompt exposure).
- Step N treats completed plans with concrete `next_action` as follow-up work; stale `plan.md` checkboxes no longer override completed `state.yml`.
- Background Codex/Agent returns must persist a `background:` marker + exact poll `next_action`; Step C polls it before redispatch.
- Step C runs `git status --porcelain` before writing `status: complete`; dirty task-scope keeps the run in `finish_gate`.

## [3.1.0] — 2026-05-09 — Codex host compatibility

### Added
- **`next` verb (Step N)** — intercepts "next" before it falls through to the bare-topic catch-all (which previously launched a new brainstorm cycle cascading through compaction). Step N inline state scan → AUQ: resume / new plan / status. Updated all 6 sync'd locations per anti-pattern #4.
- Codex-native plugin packaging: `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, `plugins/masterplan -> ..` symlink. Portable invocation: `/masterplan:masterplan`.
- **Codex host suppression**: Step 0 detects Codex context, suppresses `codex:codex-rescue` for that invocation, routes Step C inline with `decision_source: host-suppressed`.

## [3.0.0] — 2026-05-08 — run bundles, migration, and default completion finalization

Major release. Moves state to `docs/masterplan/<slug>/` run bundles and makes completion durable by default.

### Added
- **Run bundles**: `state.yml` + `spec.md` + `plan.md` + `retro.md` + `events.jsonl` + sidecars under one slug dir. `state.yml` created before brainstorming so compaction always has a durable resume pointer.
- **`bin/masterplan-state.sh`** — inventories and copy-migrates pre-v3 `docs/superpowers/...` plans/specs/retros/sidecars into bundles; copy-only, source paths preserved under `legacy:`.
- **Default completion finalizer** — on Step C finish: mark complete, generate `retro.md`, archive state, run archive-only cleanup. Opt-out: `--no-retro`, `--no-cleanup`, config keys `completion.auto_retro: false` / `completion.cleanup_old_state: false`.

### Migration
Run `/masterplan import` (or `bin/masterplan-state.sh migrate --write`) to copy pre-v3 artifacts into bundles; use `/masterplan clean --category=legacy` to archive verified originals.

## [2.17.1] — 2026-05-08 — version bump (no functional changes)

Patch to advance version; no functional changes since v2.17.0.

## [2.17.0] — 2026-05-07 — `--resume=<path>` worktree-aware path resolution

Fix: `--resume=<rel-path>` from a repo parent failed when the status file lived under `.worktrees/<feature>/...`. Step 0 now searches `.worktrees/*/<path>` glob candidates under both cwd and repo-root before erroring. One match → auto-cd and emit notice; zero matches → AUQ with abort/search/topic options; multiple matches → AUQ with candidate list. Absolute paths bypass the search.


## [2.16.0] — 2026-05-07 — May 7 failure resolution: per-task CD-9 hole, verb-explicit routing, compaction notice, invocation sentinel

Four root causes fixed from a 16-transcript May 7 audit. Bug A: Step C step 4→5 free-text gate hole — new Step C step 4e Post-task router routes deterministically by autonomy (`/loop`→step 5; `full`→silent advance; `gated`/`loose`→AUQ gate once per wave). Bug B: `execute <topic>` fell through to brainstorm — new routing-table row + `requested_verb` stash + Step A step 7 verb-explicit override. Bug C: compaction summary ignored on re-entry — new Step 0 compaction-recent notice (3 detection signals, non-blocking one-liner). Bug D: `/reload-plugins` could de-register the command with no visible signal — invocation sentinel emits `→ /masterplan v<ver> args: '...' cwd: ...` as unconditional first line. `check_cd9` regex extended with 6 new free-text gate phrasings.

## [2.15.0] — 2026-05-07 — doctor end-gate (`AskUserQuestion` offer `--fix`) + noargs resume-first routing fix

Doctor lint-only runs with auto-fixable findings now close with an AUQ offering `--fix` inline; picking it re-executes Step D in fix mode (no duplicate report). Fix: argument-parse step 0 was missing the zero-token case — bare `/masterplan` could route unpredictably; added explicit "no args → Step M" case to close the intermittent wrong-step routing.

## [2.14.1] — 2026-05-07 — Step I1 brief tightening: filter symbolic `refs/remotes/<remote>/HEAD` by full refname

Follow-up to v2.14.0 issue #3, surfaced by smoke-testing against `petabit-os-mgmt`. Fix: `git for-each-ref --format='%(refname:short)'` renders `refs/remotes/origin/HEAD` as bare `origin`, not catchable by `grep -v HEAD`. New brief uses `--format='%(refname)|%(refname:short)'` and filters on full refname (drop lines ending in `/HEAD`), use short name for display.

## [2.14.0] — 2026-05-07 — Step I1 ref enumeration fix + doctor `--fix` actionability (cache rebuild, stray-orphan rm, no-fix diagnostic)

Closes GitHub issues #1 and #3. Fix (issue #3): Step I1 Haiku brief replaced `git branch -avv` with `git for-each-ref refs/heads/ refs/remotes/` (stable one-ref-per-line, no silent downgrade). Fix/Add (issue #1): `doctor --fix` extended to checks #20/#21 (eligibility cache rebuild — deterministic from annotations) and check #1a (stray-duplicate orphan whose canonical copy lives in a sibling worktree — `git rm` per stray). Diagnostic: `--fix` runs that produce 0 file changes despite N findings now emit a top-line warning with per-check remediation hints.

## [2.13.1] — 2026-05-07 — marketplace install self-healing: auto-symlink `/masterplan` slash command

Fix: marketplace installer deployed to `~/.claude/plugins/marketplaces/.../commands/` but Claude Code only discovers `~/.claude/commands/`, so `/masterplan` vanished after upgrade. Added `hooks/hooks.json` SessionStart hook that silently recreates the symlink from marketplace path to `~/.claude/commands/masterplan.md` on every session start.

## [2.13.0] — 2026-05-06 — CC-2 threshold tightening + CC-3-TRAMPOLINE close-turn discipline + stats `--plan` slug fix

Fix: `stats --plan=<bare-slug>` returned zero records because on-disk filenames have `YYYY-MM-DD-` prefix; `bin/masterplan-routing-stats.sh` now falls back to date-prefix-stripped match. CC-2 thresholds tightened: Bash output 100→50 lines, file-read 300→50, plus two new triggers (coordinated ≥2-file edits, cumulative >5 inline Edits per file) to catch inline Opus token burn not covered by the v2.12.0 subagent passthrough fix. CC-3-TRAMPOLINE: new ~20-line rule standardizes every turn-close site through a 3-step sequence (dispatch summary → pre-close action → closer); 19 sites converted to `→ CLOSE-TURN` convention. (Fix originally landed as commit `24e6546d` in petabit-os-mgmt; promoted to HEAD here.)

## [2.12.0] — 2026-05-06 — per-turn subagent summary + model attribution enforcement

Added per-turn dispatch tracker (`subagents_this_turn` list, reset each Step entry): emits `Subagents this turn: N dispatched (by model) • site (model)` as plain stdout at turn close; cross-validates against `<plan>-subagents.jsonl` at next entry. Operational rule CC-3 codifies the render requirement. Verbatim SDD model-passthrough preamble: fenced block injected as FIRST paragraph of every SDD/executing-plans brief (sentinel: `For every inner Task / Agent invocation you make`) — closes the prose-only-override silent-drop root cause for `model: "opus"` leakage on inner SDD calls. `bin/masterplan-self-host-audit.sh --models` and `bin/masterplan-routing-stats.sh --models` added. Fix: doctor check #23 auto-fix cell replaced with 4-option AUQ per CD-9.

### Notes

- **Why this exists.** User reported seeing nearly 100% Opus usage in `/masterplan` runs. Investigation found: telemetry hook captures the data correctly; Stop hook is wired; default models at each dispatch site are specified. **The gap was that recursive model passthrough through `superpowers:subagent-driven-development` was prose-only with zero programmatic enforcement** — if SDD's upstream prompt template stops parsing the override clause, every inner Task call silently inherits Opus from the parent, and there was no per-turn summary anywhere to surface this to the user. The verbatim-preamble + sentinel-grep pattern (Section 2 of the plan) closes the enforcement gap; the per-turn summary (Section 1) closes the visibility gap.
- **No telemetry data is required for the per-turn summary to work.** Tracking is in-orchestrator-memory; the JSONL cross-check is a safety net that runs only when the Stop hook is installed and a JSONL exists. Users without the hook still get accurate per-turn summaries.
- **Manual smoke-test deferred.** The cross-validation drift detection requires a real `/masterplan execute` turn against an existing plan to populate the JSONL. If the per-turn summary or drift detection misbehaves under real use, file as v2.12.1.
- **Upgrade hint for users with manual `~/.claude/bin/` copies.** v2.12.0 modified `bin/masterplan-routing-stats.sh` (added `--models` flag + Model breakdown render). After plugin update, run `bin/masterplan-self-host-audit.sh --fix` to re-sync the user-level copy, OR manually `cp` the new version over the stale user-level shim.

## [2.11.1] — 2026-05-06 — workflow simplification + skills/ drift detection

Fix: `/masterplan-detect` duplicated in slash-command list (user-level copy shadowed plugin registration); cleaned up user copy. `bin/masterplan-self-host-audit.sh` extended with `check_skill_drift()` to catch future `skills/` shadow copies. Workflow simplification: 10 sub-steps inlined into callers, flattening Step/sub-step count from ~32 to ~21 (~30% reduction); no behavior change.

## [2.11.0] — 2026-05-06 — extract self-host checks; shim v2; retro auto-archive; doctor #28

Fix: shim v2 (`<!-- masterplan-shim: v2 -->`) — v1 body routed through Skill tool which could be absent; v2 body is just `/masterplan:masterplan $ARGUMENTS`, resolved at message-receive time, no Skill tool dependency. Doctor checks #25 + #27 extracted from `commands/masterplan.md` to `bin/masterplan-self-host-audit.sh` (they only fired inside the dev repo; consumed prompt tokens in all user sessions). Added: Step R3.5 auto-archives plan+spec after retro write (opt-out: `retro.auto_archive_after_retro: false`). Doctor check #28 `completed_plan_without_retro` — plan-scoped Warning, offers AUQ per finding. Active checks after gaps: #1–#24, #26, #28.

## [2.10.0] — 2026-05-06 — codify CD-9 (no free-text user questions) + plugin-shim recognition

Two CD-9 violations fixed: branch-mismatch resume and import collision rule both replaced free-text with explicit `AskUserQuestion`. CD-9 promoted to Design Goal #4 at top of orchestrator. Doctor check #27 `orchestrator_free_text_user_question` (repo-scoped, greps for free-text patterns + checks for AUQ or `cd9-exempt` nearby). Doctor check #25 gains shim-sentinel exemption: user-level file containing `<!-- masterplan-shim: v1 -->` skips md5 comparison.

## [2.9.1] — 2026-05-06 — auto-compact nudge fixes

Fix: nudge wording said "another shell" — backward, `CronCreate` jobs are session-scoped; reworded to "this same session." Config validator: `auto_compact.interval` null/empty when `enabled: true` → skip nudge + warn (prevents silent degrade to dynamic mode where `/loop` without interval can't fire built-in `/compact`). Doctor check #26 `auto_compact_loop_attached`: repo-scoped Warning verifying `/compact` cron is attached to the current session when nudges were emitted.

## [2.9.0] — 2026-05-06

Doctor check #25 — Self-host deployment drift (repo-scoped). Compares md5 of `~/.claude/commands/masterplan.md`, `~/.claude/hooks/masterplan-telemetry.sh`, `~/.claude/bin/masterplan-routing-stats.sh` against project HEAD; flags drift unless file is absent AND plugin is registered in `installed_plugins.json`. `--fix` backs up and `cp`s from HEAD. Root cause: ~593 lines of v2.0.0→v2.8.0 fixes never reached the user's runtime because the session was loading a pre-plugin manual copy — "100% Opus utilization" persisted despite multiple fix attempts. Parallelization brief count synced: 24 plan-scoped, #25 called out separately as repo-scoped.

## [2.8.0] — 2026-05-05

First defensive-correctness pass from `docs/audit-2026-05-05-subagent-execution.md`. Closed 7 highest-severity audit findings: D.1 — ping-based codex availability detection (replaces fragile `codex:` string-scan; cached as `codex_ping_result`; `codex.detection_mode: ping|scan|trust`). D.2 — eligibility cache schema versioning (`cache_schema_version: "1.0"`; stale caches rebuild on mismatch). D.4 — mid-plan codex re-check at Step 4b gate; auto-degrades if plugin removed mid-session. C.1 — doctor check #23 `opus_on_bounded_dispatch_sites` (scans last 20 `<slug>-subagents.jsonl` records). E.1 — post-hoc slow-member detection via `duration_ms` (detection only; LLM has no async cancel). F.4 — `flock`-based concurrent-write guard on Step 4d; contended writes queue to `<slug>-status.queue.jsonl`; doctor check #24 surfaces non-empty queue. G.1 — Step 4a excerpt-validator: implementer return digest must carry `commands_run_excerpts`; fabricated `tests_passed: true` no longer passes silently.

## [2.7.0] — 2026-05-05

Step C step 1 inline fast-path for eligibility cache: when all tasks carry well-formed `**Codex:** ok|no` + non-empty `**Files:**`, build the cache inline (no Haiku dispatch). Falls back to Haiku for under-annotated plans. Activity log variants: `eligibility cache: built inline (...)` / `rebuilt inline (...)`. Doctor #21 regex matches both. Saves Haiku roundtrip (~10–30s) on fully-annotated high-complexity plans.

## [2.6.0] — 2026-05-05

New `/masterplan clean` verb (Step CL): 5 categories — completed plans (archive plan+status+sidecars), orphan sidecars (reuses checks #11/#13/#14/#19), stale plans (AUQ per item — never auto-archive), dead crons (CronDelete non-oldest duplicate), dead worktrees (git worktree remove --force). Flags: `--dry-run`, `--delete`, `--category=<name>`, `--worktree=<path>`. Confirmation AUQ before execution; per-category atomic commits. Doctor remains read-only; destructive/archival deferred to clean.

## [2.5.0] — 2026-05-05

3-level `complexity` meta-knob (`low|medium|high`) at all config tiers (CLI flag, `~/.masterplan.yaml`, repo config, frontmatter). `medium` is default / no-migration. `low` skips eligibility cache, telemetry sidecar, wakeup ledger, parallelism, codex routing/review; leaner plan briefs; doctor runs only #1–#10 + #18. `high` requires `**Files:**` + `**Codex:**` annotations per task, forces codex_review, verifies tests on implementer return, adds doctor check #22 (high plan missing retro/review/tag signals). Kickoff AUQ when complexity unset. Activity-log audit line at first Step C entry per session cites resolved complexity and source.

## [2.4.1] — 2026-05-05

Step C step 1 competing-scheduler guard: detects external crons whose prompt starts with `/masterplan` + contains the plan's status filename (stale `/schedule` one-shots, leftovers from prior sessions). Surfaces AUQ: delete cron (Recommended) / suspend loop wakeups for session / keep both with acknowledgement / abort. Skips when `ScheduleWakeup` unavailable, CronList/CronDelete unloadable, or `competing_scheduler_acknowledged: true` in frontmatter. Note: fires after current resume starts — prevents future conflicts only.

## [2.4.0] — 2026-05-04

New `/masterplan stats` verb (Step T) + `bin/masterplan-routing-stats.sh` (~280-line bash+python3; `--plan`, `--format`, `--all-repos`, `--since`). New `codex.unavailable_policy: degrade-loudly|block`. Doctor checks #20 (cache file missing despite routing activity) and #21 (no `eligibility cache:` evidence in activity log) close the silent-skip detection gap. Pre-dispatch `routing→CODEX|INLINE` activity-log entries + stdout banners; cache extended with `dispatched_to`/`dispatched_at`/`decision_source`. Step C step 3a halts on missing cache (no more silent fallthrough to inline). Step 0 degradation now writes immediately + stdout warning; forced `## Notes` write if no natural write occurs. Stop hook: deduplication by `agent_id` (replaces plan-keyed cursor that silently dropped multi-session dispatches); worktree fan-out now lands sidecars alongside worktree-resident plans. Root cause fixed: optoe-ng project-review had 7 dispatches, 0 codex-rescue, 0 activity-log evidence — silent bypass now structurally impossible.

## [2.3.1] — 2026-05-04

Bare `/masterplan` is now resume-first (auto-continues single active plan; picker on ambiguity; menu only when no active plan). README: Claude Desktop Code-tab path + collision fallback. Fix: telemetry sidecars protected from accidental commits via `.gitignore` + `.git/info/exclude` auto-patching; telemetry skipped rather than written if files can't be excluded.

## [2.3.0] — 2026-05-04

Model-dispatch contract + per-subagent telemetry layer. Root cause: 2-day session consumed 94% Opus ($458 of $487) due to subagents silently inheriting orchestrator's model. Fix: `### Agent dispatch contract` in `commands/masterplan.md` — normative `model:` at 14 inline dispatch sites; recursive override clause for SDD inner Task calls (`model: "sonnet"`). `DISPATCH-SITE:` tag convention; 14 site values in contract table. Telemetry: Stop hook captures one `<plan>-subagents.jsonl` record per dispatch (tokens, duration, site, model, tool_stats); `agent_id`-dedup cursor; doctor check #19 for orphan subagents files; six jq cookbook recipes in `docs/design/telemetry-signals.md`. Blocker gate option 2 now actually dispatches `model: "opus"` (was UI-only). Hook re-install required to capture per-dispatch data.

## [2.2.3] — 2026-05-04

Marketplace-readiness patch. Added `.claude-plugin/marketplace.json` (self-contained `rasatpetabit-masterplan` marketplace; `superpowers@claude-plugins-official` dependency). Fixed: `plugin.json` `repository` field from npm-style object to string; `commands/masterplan.md` frontmatter description quoted so colon in `Verbs:` parses as valid YAML. Added `docs/release-submission.md`. Verified with `claude plugin validate .` + clean install smoke test.

## [2.2.2] — 2026-05-04

Documentation-only. Removed `CLAUDE.md` anti-pattern #2 ("no backward-compat shims") and the matching `docs/internals.md` subsection + auto-memory entry — rename decisions are now case-by-case. README rewritten with `## Key benefits` section (long-term planning consistency, token efficiency, Codex cross-checking). No orchestrator or schema changes.

## [2.2.1] — 2026-05-04

Step M0 inline status preamble on bare `/masterplan`: before the Tier-1 picker, emits headline (`N in-flight, M blocked across W worktrees`), up to 3 plan bullets with `current_task` + age, optional doctor tripwire flag (reuses checks #2/#3/#4/#5/#6/#9/#10 inline — no Haiku dispatch). `step_m_plans_cache` short-circuit avoids double worktree scan when picker selects "Resume in-flight." Doc fixes: README, `docs/internals.md`, and config schema all aligned to v2.2.0 surface.

## [2.2.0] — 2026-05-04

Breaking: `new` verb renamed to `full` (no alias); all sync'd locations updated. Two-tier no-args picker (Step M): Tier 1 = Phase work / Operations / Resume in-flight / Cancel; Tier 2a = brainstorm/plan/execute/full; Tier 2b = import/status/doctor/retro. Doc revisionism: all pre-v1.0.0 (v0.x) references removed from CHANGELOG, README, `docs/internals.md`, design docs.

## [2.1.0] — 2026-05-04

Gated→loose switch offer at Step C step 1: AUQ when `autonomy == gated` AND plan task count ≥ `gated_switch_offer_at_tasks` (default 15). Options: switch / stay / switch+don't-ask-again / stay+don't-ask-again (per-plan frontmatter `gated_switch_offer_dismissed`). README: `## Why this exists` reordered first, `### Defaults at a glance` YAML block, `## Roadmap` section (6 deferred items, 4 non-features, measurable revisit triggers).

## [2.0.0] — 2026-05-04

Intra-plan parallelism Slice α + Codex defaults on. `**parallel-group:** <name>` annotation dispatches read-only task groups as parallel waves (verification, lint, type-check, doc-gen; implementation serial). Wave dispatch in Step C step 2: bounded per-instance brief (DO NOT commit/update status), parallel Agent dispatch, barrier, single-writer 4d funnel. Per-member outcomes: `completed`/`blocked`/`protocol_violation`; wave outcomes: all-completed/all-blocked/partial. Doctor checks #15–#17 (parallel-group validation) + #18 (codex config on, plugin missing). `codex.review` default flipped off→on (graceful-degrade when plugin absent). `parallelism:` config block (`enabled`, `max_wave_size`, `abort_wave_on_protocol_violation`). `CLAUDE.md` and `docs/internals.md` (~8000 words) added as LLM contributor orientation. Migration: set `codex.review: off` in `.masterplan.yaml` if auto-review not wanted.

## [1.0.0] — 2026-05-03

First stable public release. Pre-release audit pass by 3 parallel Explore agents closed 10 blockers + 13 polish items. Key changes: `masterplan-retro` skill removed and consolidated into `/masterplan retro` verb (Step R; explicit retro generation, no auto-fire). README terminology standardized on "verbs." Reserved-verb list expanded to all 8. Numerous fixes: doctor brief count corrected (10→14 checks), Step I3.4 frontmatter `compact_loop_recommended` missing, blocker gate reduced from 5 options to 4 per CD-9, Codex annotation casing standardized to `**Codex:** ok|no`, telemetry hook `jq` guard added, `find -printf`/`find -quit` replaced with portable equivalents, `wakeup_count_24h` sentinel cutoff added for musl/stripped environments.
