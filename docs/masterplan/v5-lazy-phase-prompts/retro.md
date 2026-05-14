# Retro: v5.0.0 — lazy-loaded phase prompts (router/parts split + 5 new doctor checks)

**Slug:** `v5-lazy-phase-prompts`
**Branch:** `v5.0.0-lazy-phase-prompts`
**Base SHA:** `4eedcfb` (origin/main HEAD at branch creation — "Plan complete: v4.2.1 pushed to origin + local tag")
**Release tag:** `v5.0.0` (annotated; pushed alongside the branch — divergence from v4.1.1 / v4.2.0 / v4.2.1 local-only-tag convention, by explicit user instruction at the close-out gate)
**Date:** 2026-05-13
**Plan kind:** implementation, complexity: large

## What shipped

A breaking architectural reorganization plus five new doctor checks, packaged as a major version bump.

- **Router + `parts/` lazy-load layout (T1–T20).** `commands/masterplan.md` went from a ~341 KB monolith loaded in full on every invocation to a 97-line / 7,975-byte router that dispatches by verb to phase files under `parts/`. New phase files: `parts/step-0.md` (M/N/S inline + bootstrap), `parts/step-a.md` (spec-pick), `parts/step-b.md` (brainstorm/plan), `parts/step-c.md` (execute), `parts/doctor.md` (all 36 checks), `parts/import.md` (import verb), `parts/codex-host.md` (host suppression), and `parts/contracts/{agent-dispatch,cd-rules,run-bundle,taskcreate-projection}.md`. Documentation extracted to `docs/verbs.md` and `docs/config-schema.md`.
- **Five new doctor checks (T15–T19).** #32 `scalar_cap_enforcement` (Error, write-time); #33 `projection_mode` (Warning, repo-scoped); #34 `plan_index_staleness` (Warning, run-scoped); #35 `plan_format_conformance` (Warning, run-scoped); #36 `router_byte_ceiling` (Error, repo-scoped, 20,480-byte hard ceiling). #36 is the regression guard that keeps the router thin.
- **Three new `bin/masterplan-state.sh` subcommands (T21–T23).** `build-index` generates the `plan.index.json` projection; `migrate-state` migrates `state.yml` between schema versions (currently a v3→v3 no-op since v5.0.0 didn't bump schema, but the surface is in place); `migrate-plan` injects v5 plan-format markers into pre-v5 `plan.md` files (best-effort, requires `### Task N` heading style).
- **200-character scalar cap enforcement at `write_state()` (T24).** The Step C state-writer rejects any scalar over 200 chars; overflow content must redirect to `handoff.md` / `blockers.md` / `overflow.md` with a pointer stored in `state.yml`. Surface for doctor #32 to audit.
- **`parent_turn` / `subagent_turn` telemetry split (T25) + `routing-stats --parent` attribution (T26).** Stop hook emits separate records for orchestrator decisions vs dispatched subagents, both tagged with `type:`. `routing-stats --parent` splits the rollup into per-section attribution with model labels bucketed (e.g., `claude-opus-4-7` → `opus`).
- **Self-host audit phase-file checks (T27).** Five new audit gates in `bin/masterplan-self-host-audit.sh`: `check_cc3_trampoline`, `check_cd9_coverage`, `check_dispatch_sites`, `check_sentinel_v4_refs`, `check_plan_format`.
- **Documentation refresh (T28–T29).** `skills/masterplan/SKILL.md` and `docs/internals.md` updated for the v5.0 layout; verb→phase-file mapping documented; checks #32–#36 enumerated in internals §10.
- **Manifest bumps (T30).** Four JSON manifests at 5.0.0; `.agents/plugins/marketplace.json` exempt (schema-no-version, per doctor #30).
- **CHANGELOG ## [5.0.0] (T31).** Full release entry under Keep-A-Changelog format with Added / Changed / Migration / Verification / Notes sections; verification section honestly notes T33's deferral.

Release plumbing: 37 commits on branch, 29 files touched, run bundle at `docs/masterplan/v5-lazy-phase-prompts/`.

## What went well

- **Lazy-load architecture landed end-to-end without intermediate breakage.** Wave A→B→C→D handled the directory skeleton, contract extraction, and phase-file authoring before the router rewrite (T20) flipped the dispatch model. The router rewrite cut over cleanly because all phase files already existed at known paths — no transitional state where the orchestrator could load a missing file. Doctor #36's byte ceiling caught no regressions because the router was designed for 7,975 bytes from the start (40% of the 20 KB hard limit).
- **Two-stage review (spec then quality) under SDD caught a real bug in T26.** The reviewer flagged 4 issues including two criticals: `emit_parent_turns` writing to `telemetry.jsonl` instead of `subagents.jsonl` (the file `analyze_plan` actually reads), and subagent records missing the `type:` field that `rollup_records('subagent_turn')` filters on. Both were silent failure modes — the wrong-target write would have lost parent_turn records and `routing-stats --parent` would have shown empty subagent sections. Fixed inline before commit; no escape to main.
- **Implementer-batching for the 5 doctor-check authoring tasks reduced wave overhead substantially.** T15–T19 shared context (same target file `parts/doctor.md`, same check authoring template) and were dispatched as a single Sonnet implementer producing 5 sequential commits instead of 5 separate dispatches. Saved 4 dispatch-dialogue rounds; the parent-context drag of 5 separate briefings would have compounded across the wave.
- **Codex routing handled T22–T27 cleanly despite the `.git` read-only sandbox limitation.** Pattern from prior releases (T25/T26): Codex implements the change, the host commits from working-tree diff. Worked five times in this run without incident. The single host-commit pattern is now stable enough to bake into the workflow for any sandbox-restricted Codex dispatch.
- **WORKLOG.md handoff kept the long execution coherent through context compaction.** This run survived one mid-execution summarization without losing thread; the WORKLOG entry written at session start + per-wave appends provided the resume signal that bridged the compaction boundary.
- **Loose-autonomy contract held throughout.** Zero between-wave gate prompts; the only AUQ fired was at T35's true risky-action boundary (push + tag). Matches the contract's intended shape exactly.

## What didn't go well

- **The v5 run bundle never got a `state.yml`.** SDD execution does not write to a bundle `state.yml` the way `/masterplan execute` does — the SDD flow tracks task progress via `TaskCreate`/`TaskUpdate` in the harness's native task ledger plus checkbox state in `plan.md`. The run bundle ended up with `plan.md`, `spec.md`, `plan.index.json` but no `state.yml`. **Practical impact:** this run is not resumable through the canonical `/masterplan execute --resume=…/state.yml` path. Recovery from mid-execution would have to lean on plan checkbox state + git log + WORKLOG. R3 below.
- **T34 plan verify text drifted from v5.0.0's actual schema decision.** The plan (`plan.md` §L2367) prescribes `grep -q 'schema_version: "5.0"'` as the migrate-state smoke verification, but v5.0.0 explicitly does NOT bump the schema (CHANGELOG: "No `state.yml` schema bump"). The plan was authored assuming a schema bump and never updated when that decision was reversed. The fixture smoke ran cleanly anyway (migrate-state is a safe v3→v3 no-op), but the plan's literal verify text would have failed if run mechanically. R-plan-drift.
- **`migrate-plan` is a no-op for plans that don't use `### Task N` headings.** The v4.2.1 fixture's plan uses a different heading convention; the injector found no task boundaries and produced a backup with byte-identical content. Plan-format conversion for most legacy bundles will still require manual marker injection. Doctor #35 will continue flagging those bundles as warnings until a more flexible matcher lands or the bundles are converted by hand. R4.
- **`migrate-state` and `migrate-plan` always print "migrated" and always overwrite the backup on re-run.** No distinction between "applied changes" and "no-op (already v5 / incompatible structure)". Cosmetic — not a v5.0.0 blocker — but it makes idempotency testing harder than it should be. R1.
- **T33 cold-load smoke is deferred again.** Same precedent as v4.1.1 and v4.2.0 (smoke requires fresh CLI session). Across three consecutive releases the manual-smoke deferral has become normalized; without a non-interactive harness this pattern will keep recurring. R2.
- **No `events.jsonl` for this run.** Related to the missing `state.yml` — SDD execution doesn't append to a bundle event log. The canonical activity-log surface from the project anti-pattern list (#3: "wave member returns digest, orchestrator is canonical writer") is not exercised under SDD. The orchestrator activity is in this WORKLOG, the harness task ledger, and the git log; events.jsonl as a unified per-run timeline is absent.

## Carried-forward items

- **R1 (v5.0.1 polish): differentiate `migrate-state` / `migrate-plan` no-op vs applied output.** Distinguish "migrated (changes applied)" from "no-op (already v5)" and "no-op (no actionable structure detected — manual conversion required)". Only overwrite the backup on actual applied changes; emit a one-line "already v5" or "nothing to do" otherwise. Low complexity; bundle with any v5.0.x bugfix release.
- **R2 (v5.0.x or v5.1.0): non-interactive cold-load smoke harness.** A standalone script that simulates a single `/masterplan status` invocation by replaying the orchestrator dispatch logic, reads only the files the router would have read, and emits a JSONL trace. The current pattern (real fresh-CLI session) is correct but consistently deferred, which is itself a regression risk. Owner: TBD.
- **R3 (v5.0.x): SDD execution should write to bundle `state.yml`.** Currently SDD-launched runs are fire-and-forget relative to bundle state — task progress lives only in the harness ledger + plan checkboxes, both of which are session-local. To make SDD-launched plans resumable across sessions (the canonical promise of `state.yml`), SDD needs a hook to mirror task advances into the bundle's `state.yml`. The taskcreate-projection contract (`parts/contracts/taskcreate-projection.md`) is the inverse direction; this is the reverse projection. Bigger lift than R1/R4 — may slip to v5.1.0.
- **R4 (v5.0.x or v5.1.0): broader heading support in `migrate-plan`.** Current matcher requires `### Task N`. Extend to support `## Task N`, `#### N. Title`, plain `## N` headings, and other conventions actually used in `docs/masterplan/*/plan.md`. Surface tasks where the injector cannot determine boundaries reliably and leave those for manual edit (current behavior is to silently skip).
- **R-plan-drift: lock plan verify text to actual implementation decisions.** Adopt a convention where post-implementation review reads each task's `**Verify:**` block against the actual file state and updates literal verify-command text if implementation changed direction (as happened with schema_version). Could be enforced as a doctor check or a Wave-J gate. Bundle with R2's non-interactive harness work.

## What I'd do differently next time

- **For SDD-executed plans, write a `state.yml` skeleton in Wave A and an event in each wave's close-out.** Even minimal — `status: in_progress`, `current_task`, `recent_events: [...]` — would make SDD runs resumable through the canonical path. The orchestrator-as-canonical-writer pattern (project anti-pattern #3) currently assumes `/masterplan execute` is the orchestrator; SDD plays the same role but doesn't write the same artifact. Aligning these is the cleanest fix.
- **Author plan verify text last, after implementation decisions are firm.** This run had at least one verify drift (T34's `schema_version: "5.0"` vs the actual no-bump). Plan authoring before implementation is the right order for *task decomposition* but the *literal verify commands* should be locked in after the implementation tasks settle their schema/format choices. The plan-format markers (`**Verify:**` blocks) become source-of-truth that doctor #35 audits — they need to be true.
- **Build the non-interactive cold-load smoke now, not in v5.0.1.** Three consecutive releases of deferred manual smoke is the kind of pattern that compounds into a real regression. R2 should move to v5.0.x not "TBD".

## Stats

- **Tasks planned:** 35 (T1–T35 across 11 waves A–K)
- **Tasks completed:** 34 (T33 cold-load smoke explicitly deferred per plan §L2330; not a skip)
- **Commits on branch:** 37 (vs `origin/main` at base SHA `4eedcfb`)
- **Files touched:** 29 (including 9 new files under `parts/` + `parts/contracts/`)
- **Pre-v5 monolith size:** ~341 KB / ~2150 lines (`commands/masterplan.md`)
- **Post-v5 router size:** 7,975 bytes / 97 lines (40% of doctor #36's 20,480-byte ceiling)
- **Subagents dispatched:** many — implementer (Sonnet), spec-reviewer (Sonnet), code-quality-reviewer (Sonnet), Codex (T22–T27), plus orchestrator (Opus)
- **Codex review:** routed for T22, T23, T25, T26, T27 (well-defined coding tasks with clear acceptance criteria); host-committed from working-tree diff for all
- **Gates fired:** 1 (T35 push + tag — true risky-action boundary, AUQ surfaced 4 options; user chose "Retro + push + tag")
- **AUQ violations / Stop-hook blocks:** 0
- **Compactions survived:** 1 (mid-execution; WORKLOG.md carried the state across)

## Verification evidence

- `bash -n bin/masterplan-{state,routing-stats,self-host-audit}.sh hooks/masterplan-telemetry.sh` → all pass.
- `stat -c '%s' commands/masterplan.md` → 7,975 (< 20,480 doctor #36 ceiling).
- `wc -l commands/masterplan.md` → 97 lines (was ~2,150 pre-v5).
- `grep -hE '"version":' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json` → 4 hits, all `5.0.0`.
- `bash bin/masterplan-self-host-audit.sh` → 4 new T27 checks all PASS (CC-3-trampoline, CD-9 coverage, DISPATCH-SITE, sentinel-no-v4-refs). plan-format check FAILs on 10 pre-v5 legacy plans — that's the check working as designed.
- T34 migration smoke (`/tmp/v5-migration-fixtures/real-v4-*`): `migrate-state --bundle` RC=0, backup created, idempotent (always RC=0 on re-run). `migrate-plan --bundle` RC=0, backup created, content unchanged for v4.2.1 fixture (no `### Task N` headings to inject markers into — on-design no-op).
- T33 cold-load smoke deferred to post-release fresh-CLI session per plan §L2330. Same precedent as v4.1.1 / v4.2.0.
- WORKLOG.md entry under `## 2026-05-13 - v5.0.0 lazy-loaded phase prompts` records the smoke outcomes + the run-bundle quirk + the T35 close-out gate.
