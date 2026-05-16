# Staging — CHANGELOG entry for v5.8.0

Intended insertion point: top of `CHANGELOG.md` (above the existing `## [5.7.3]` entry).

Placeholders below — fill from final commit SHAs and verification output before merging into `CHANGELOG.md`.

---

## [5.8.0] — 2026-05-16 — Codex routing fix: aggressive default, per-member wave review, asymmetric enforcement + 4 failure classes

Minor release. Addresses the T8 misfire (wave-mode code-review running via Claude SDD despite Codex configured) and the broader Codex under-dispatch / subagent context-pollution concerns documented in `docs/masterplan/codex-routing-fix/brainstorm.md` (findings F1–F6).

### Added

- **Plan-writer aggressive Codex annotation default** (`parts/step-b.md`). Replaces conservative "add `**Codex:** ok` when obviously well-suited" with "default `**Codex:** ok` for ALL single-file edits (code OR doc); only mark `**Codex:** no` when multi-file, ambiguous scope, no known verification, or explicit scope-out applies." Addresses F1.
- **Wave-mode Step 4b: N parallel per-member Codex REVIEW dispatches** (`parts/step-c.md`, `commands/masterplan-contracts.md`). At wave-end, orchestrator dispatches N Codex REVIEW calls (one per wave member) batched into a single assistant message, each scoped to that member's `**Files:**` with diff range = `<wave_start_sha>..<wave_end_sha>` filtered to those files. New contract `codex.review_wave_member_v1` registered. Addresses F2.
- **Asymmetric review enforcement at Step 4b (serial + wave-member)** (`parts/step-c.md`). If `dispatched_by == "codex"` for the task being reviewed, skip review with `decision_source: codex-produced` and emit `review→SKIP(codex-produced)` event. Codifies the asymmetric principle from `docs/internals.md:577`.
- **Mandatory `eligibility_cache` event in wave-pin short-circuit + new `wave_routing_summary` event** (`parts/step-c.md`). Wave-pin path now emits the v2.4.0+ MANDATORY `eligibility_cache` event before short-circuiting (closing the F3 contradiction at line 87 vs line 96). New `wave_routing_summary` event at wave-entry with shape `{wave, members_by_route: {codex: N, inline_review: N, inline_no_review: N}}`.
- **`dispatched_by` provenance field on every completion event** (`parts/step-c.md`). Enum: `codex`, `claude`, `wave-claude`, `user`. Precondition for the asymmetric-review enforcement above. Canonical naming table added near the top of step-c.md.
- **Telemetry hook emits `subagent_return_bytes`** (`hooks/masterplan-telemetry.sh`). Per-subagent JSONL records gain an integer field for the return-text byte length. Enables measurement of the context-pollution concern (F4); detector for the new `subagent_return_oversized` failure class.
- **Doctor check #43 `codex_review_coverage`** (`parts/doctor.md`). For each run bundle's `events.jsonl`, every `wave_task_completed` event must have a paired `review→CODEX(...)` or `review→SKIP(<reason>)` event with explicit `decision_source`. Coverage = paired_reviews / wave_task_completed. WARN when coverage < 100% and run was not inside Codex host. Backfill against `concurrency-guards` and `p4-suppression-smoke` is expected to WARN (both predate the visibility-event rule).
- **5 new dispatch-brief contracts** in `commands/masterplan-contracts.md`: `step-c.eligibility_cache_build_v1`, `step-c.wave_implementer_v1`, `step-c.codex_exec_v1`, `step-c.codex_review_serial_v1`, `codex.review_wave_member_v1` (the latter shared with B1). Closes F6 gap.
- **`bin/masterplan-self-host-audit.sh --brief-style` strengthened** to flag freeform briefs at lifecycle dispatch sites (any dispatch in `parts/step-c.md` or `parts/doctor.md` that lacks a `contract_id` reference).
- **4 new failure classes** in `parts/failure-classes.md`:
  - `wave_codex_review_skip` — fires when doctor #43 finds wave-mode review coverage < 100% (detector: A1; addresses F2)
  - `subagent_return_oversized` — fires when `subagent_return_bytes` > 5120 bytes (detector: A2; addresses F4)
  - `eligibility_cache_event_missing` — fires when Step C entry events.jsonl is missing the mandatory `eligibility_cache` event (addresses F3)
  - `dispatch_brief_unregistered` — fires when `--brief-style` audit encounters a lifecycle dispatch site lacking a `contract_id` (addresses F6)

### Fixed

- **F1: Plan-writer defaults to `**Codex:** no` for everything.** Conservative wording at `parts/step-b.md:353` left planner defaulting to `**Codex:** no` even for 1-file doc edits well-suited to Codex EXEC. Reflipped to aggressive default.
- **F2: Wave-mode skips Step 4b Codex review entirely.** Old rule at `parts/step-c.md:613` claimed the diff range was empty for wave members. Mechanically true at the individual-member level but the wave-end SHA range (`<wave_start_sha>..<wave_end_sha>` filtered to each member's `**Files:**`) is reviewable. Replaced with N-per-wave dispatch.
- **F3: Wave-mode bypasses v2.4.0+ mandatory visibility events.** Wave-pin short-circuit at `parts/step-c.md:87` silently dropped the mandatory `eligibility_cache` event documented at `parts/step-c.md:96`. Fixed by emitting before short-circuiting.

### Compatibility

`state.yml` schema unchanged. New event types (`wave_routing_summary`) and new event field (`dispatched_by`) are additive on `events.jsonl`; legacy bundles without these fields are tolerated. New telemetry field `subagent_return_bytes` is additive on per-subagent JSONL records. Doctor check #43 is WARN-only; existing bundles `concurrency-guards` and `p4-suppression-smoke` are expected to WARN as documented backfill.

### Why minor (5.7.3 → 5.8.0)

This bundle adds (a) new policy that flips a default behavior the plan-writer applies (aggressive Codex annotation), (b) new event types + new telemetry fields that downstream observability consumers can rely on, (c) a new doctor check, (d) four new failure classes hooked into the v5.1.0+ framework, and (e) new dispatch-brief contracts. Multiple additive capability boundaries per the project's semver convention (CD-10 family).

### Rollout

Per the patched rollout macro: `claude plugin marketplace update` + `claude plugin update "superpowers-masterplan@rasatpetabit-superpowers-masterplan"` for Claude Code AND `codex plugin marketplace upgrade rasatpetabit-superpowers-masterplan` for Codex CLI, on both ras@epyc2 and grojas@epyc1.

---

## Commit SHA placeholders to fill in before merging

- T1: `<sha>` doctor check #43
- T2: `<sha>` telemetry subagent_return_bytes
- T3: `<sha>` aggressive Codex default
- T4: `<sha>` wave-pin eligibility_cache + wave_routing_summary
- T5: `<sha>` dispatched_by provenance
- T6: `<sha>` wave-mode 4b N-per-member Codex REVIEW + contract registration
- T7: `<sha>` asymmetric review enforcement (codex-produced skip)
- T8: `<sha>` B4 audit + 5 contracts + audit-script hardening
- T9-T12: `<sha>` 4 failure classes (single commit)
- T13: `<sha>` docs/internals.md cross-section updates
- T14: `<sha>` version bump + this CHANGELOG entry
- T15: `<sha>` WORKLOG entry
