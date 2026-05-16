# Investigation: Codex under-dispatch for code review + subagent context discipline

## Context

Two intertwined concerns raised against `/masterplan`:

1. **Original**: Subagents are supposed to keep the orchestrator's context clean of content that could be summarized. The actual dispatch behavior may deviate from the documented intent (`docs/internals.md` §3: bounded brief, algorithmic return shape, digest-only consumption).
2. **Urgent**: A recent T8 code-review task ran via Claude SDD despite Codex being configured. The user wants **Codex to handle ALL code-review work unless the code under review came from Codex itself** (asymmetric review — the principle is in `docs/internals.md:577` but isn't actually enforced in the wave-dispatch path).

Cross-cutting motivation: routing more review work to Codex *also* reduces Claude orchestrator context drag (Codex is out-of-process; returns are bounded digests, not raw diff/explanation).

## Investigation findings (evidence)

### F1 — Plan-writer defaults to `**Codex:** no` for everything

Evidence: `docs/masterplan/concurrency-guards/plan.md` — every task (10/10) carries `**Codex:** no` (lines 28, 87, 141, 179, 245, 296, 355, 400, 458, 529). These are 1-file edits eminently suitable for Codex EXEC (Bash helpers, parts/*.md doc edits) — the kind of work the eligibility heuristic was designed for. Step B2's plan-writer brief at `parts/step-b.md:353` says *"obviously well-suited... add `**Codex:** ok`"* — conservative wording leaves the planner defaulting to "no" when in doubt. **Result: zero tasks dispatched to Codex EXEC despite `codex.routing: auto` being on.**

### F2 — Wave-mode skips Step 4b Codex review entirely, by design

Evidence: `parts/step-c.md:613` states verbatim: *"4b under wave. **Skipped entirely for wave members** — they don't commit, so the diff range `<task_start_sha>..HEAD` is empty"*. The rationale (wave members don't commit; orchestrator batches commits at wave-end) is mechanically true but doesn't justify skipping review — the diff against the wave-start SHA across all members' Files is reviewable. **Result: every wave-mode task escapes Codex review categorically, even with `codex.review: on`.**

### F3 — Wave-mode bypasses v2.4.0+ mandatory visibility events

Evidence: `docs/masterplan/concurrency-guards/events.jsonl` and `docs/masterplan/p4-suppression-smoke/events.jsonl` contain **zero** `eligibility_cache`, `routing→CODEX|INLINE`, or `review→CODEX|SKIP` events. Per `parts/step-c.md:96` (P1 v2.4.0+, MANDATORY): *"Step C step 1 MUST append exactly one `eligibility_cache` event ... including the trivial `codex_routing == off` skip."* Per `parts/step-c.md:507` and `:518` (v2.4.0+): pre-dispatch routing/review visibility events are mandatory at non-low complexity. The `concurrency-guards` run is `complexity: high`. **Result: the wave-pin short-circuit at `parts/step-c.md:87` ("`cache_pinned_for_wave == true` → skip the rest of this decision tree") contradicts the visibility-event requirement. No audit trail exists for routing decisions in wave-mode runs.**

### F4 — No instrumentation for subagent context impact

`hooks/masterplan-telemetry.sh` records dispatch counts and types but does NOT record per-subagent return-byte/return-token size, nor parent-side ingestion volume. The v5.1.0+ failure-instrumentation framework (`docs/internals.md:775`) and v5.2.0+ policy-regression watcher (`docs/internals.md:874`) don't track Codex under-dispatch as a regression class. **Result: we can't measure "how much raw content did the orchestrator hold this turn" from telemetry alone — we're flying blind on the original context-pollution concern.**

### F5 — Doctor checks don't audit Codex-review coverage

`parts/doctor.md` has 42 checks (#42 stale-lock added in concurrency-guards bundle). None audits: for every `wave_task_completed` event, expect a paired `review→` event with explicit `decision_source`. The v2.4.0+ `silent_codex_skip_warning` detector exists for Step 3a EXEC but not for Step 4b REVIEW. **Result: the wave-mode 4b skip pattern is invisible at lint time.**

### F6 — Subagent dispatch discipline in step-c.md / doctor.md: partial audit

The inline-reads / dispatch-brief audit for `parts/step-c.md` (largest file, ~71KB) and `parts/doctor.md` is incomplete — the subagent dispatched for that audit hit token limits on full reads and bailed mid-task. Earlier full-coverage of Steps 0/A/B/I found the major regression (Step B1 brainstorm 81KB WORKLOG inline-Read) was already fixed in v5.4.0. The contract registry at `commands/masterplan-contracts.md` lists only 4 algorithmic contracts (`import.convert_v1`, `doctor.schema_v2`, `doctor.repo_scoped.schema_v1`, `retro.source_gather_v1`); many step-c.md dispatch sites (eligibility-cache build, wave implementer, codex EXEC, codex REVIEW, slow-member scan) operate on freeform briefs without a `contract_id` — those are unaudited by `bin/masterplan-self-host-audit.sh --brief-style`.

### The full chain that caused T8 to run via Claude

1. Step B2 plan-writer applied conservative annotation heuristic → all tasks tagged `**Codex:** no` (F1)
2. Step C step 1 eligibility cache built → 0 Codex-eligible tasks (consequence of F1)
3. Wave assembly grouped tasks T1–T5 / T6–T10 → wave-mode entered with `cache_pinned_for_wave: true`
4. Wave-pin short-circuit (`parts/step-c.md:87`) → eligibility-cache event suppressed (contradicts F3 mandatory rule)
5. Wave members dispatched as SDD-Sonnet → no per-task Step 3a routing decision (no `routing→` events)
6. Wave-completion barrier → Step 4b explicit skip per `parts/step-c.md:613` (no `review→` events)
7. Wave-end batched commit → zero Codex touch on the entire run

## Recommended approach

Full bundle: instrument (A) + policy fix (B) + failure-class hooks (C). User decisions on the open forks:

- **Wave-mode review granularity (B1):** N Codex reviews per wave — one per member, diff range scoped to each member's `**Files:**`. Mirrors serial 4b semantics; precise findings attribution per task.
- **Plan-writer default flip (B2):** Aggressive — default `**Codex:** ok` for ALL single-file edits, including doc edits. `**Codex:** no` only when explicitly unsuitable (multi-file, ambiguous scope, no known verification).
- **F6 scope (B4):** Bundled into this work — inline-reads / dispatch-brief audit of `parts/step-c.md` and `parts/doctor.md` runs in the same plan.

### Phase A — Instrument (4 small, independent changes)

| # | Change | File | Why |
|---|---|---|---|
| A1 | New doctor check #43 `codex_review_coverage` — for every `wave_task_completed` event in a bundle's `events.jsonl`, expect a paired `review→CODEX\|SKIP(<reason>)` event with explicit `decision_source`. Severity: WARN if coverage < 100% and run was not inside Codex host. | `parts/doctor.md` | Surfaces F2/F3 silently-skipped reviews as a lint-time finding. Backfill against existing bundles flags `concurrency-guards` and `p4-suppression-smoke` immediately. |
| A2 | Telemetry hook emits `subagent_return_bytes` per dispatch in `subagents.jsonl`. | `hooks/masterplan-telemetry.sh` | Enables measurement of context-pollution claim (F4). Cheap to compute (already have the return string). |
| A3 | Wave-pin short-circuit (`parts/step-c.md:87`) explicitly emits the `eligibility_cache` mandatory event before short-circuiting; wave-entry emits a `wave_routing_summary` event (`{wave, members_by_route: {codex: N, inline_review: N, inline_no_review: N}}`). | `parts/step-c.md` | Closes the F3 contradiction (mandatory event vs wave-pin skip). One-line code, big audit-trail win. |
| A4 | Per-task `dispatched_by` provenance field on every completion event (`codex \| claude \| wave-claude \| user`). | `parts/step-c.md` (4d batch update) | Enables Phase B3 asymmetric-review rule. Needed before B can land. |

### Phase B — Policy fixes

| # | Change | File | Why |
|---|---|---|---|
| B1 | **Flip wave-mode Step 4b**: at wave-end, dispatch **N parallel Codex REVIEW calls — one per wave member**, each scoped to that member's `**Files:**` with diff range = `<wave_start_sha>..<wave_end_sha>` filtered to those files. Reviewers batched in a single assistant message per the reviewer-batching rule. Orchestrator applies existing per-task decision matrix per autonomy. | `parts/step-c.md:613` (replace), `commands/masterplan-contracts.md` (add `codex.review_wave_member_v1` contract) | Directly addresses user's "Codex for all code review" policy. The "diff range empty" rationale is mechanically wrong — wave-end SHA range is computable, just filter the diff to the member's files. Per-member granularity preserves findings attribution. |
| B2 | **Aggressive flip** of Step B2 plan-writer default: replace conservative *"add `**Codex:** ok` when obviously well-suited"* with *"default to `**Codex:** ok` for ALL single-file edits (code OR doc); only mark `**Codex:** no` when multi-file, ambiguous scope, no known verification, or explicit scope-out applies."* Updates the complexity-tier annotation rules at `parts/step-b.md:363–365` to reflect the new default. | `parts/step-b.md:353`, `parts/step-b.md:363–365`, writing-plans skill brief | Shifts F1 default. Aggressive variant covers doc edits because Codex is competent at markdown and the user wants maximum offload. Risk-bounded by the per-task `**Codex:** no` escape hatch. |
| B3 | Add asymmetric-review enforcement at Step 4b (serial AND per-member wave): if `dispatched_by == "codex"` for the task being reviewed, skip review with reason `codex-produced (asymmetric rule)` and emit `review→SKIP(codex-produced)` event. | `parts/step-c.md:492`, `parts/step-c.md:613` (new wave 4b block from B1) | Codifies the user's "unless reviewing Codex-produced code" caveat. Depends on A4 (`dispatched_by` field). |
| B4 | **F6 inline-reads / dispatch-brief audit** of `parts/step-c.md` (~71KB) and `parts/doctor.md`. Use a properly-scoped Explore subagent with chunked reads (max 500 lines/call, max 3 chunks per file). Emit findings keyed to file:line: every dispatch site that lacks a `contract_id` or that inlines >500 bytes of file content into a brief. Register new contracts for the top 5 freeform dispatch sites (eligibility-cache build, wave implementer, codex EXEC, codex REVIEW serial, codex REVIEW wave-member). Strengthen `bin/masterplan-self-host-audit.sh --brief-style` to flag freeform briefs at lifecycle sites. | `parts/step-c.md`, `parts/doctor.md`, `commands/masterplan-contracts.md`, `bin/masterplan-self-host-audit.sh` | Closes the F6 audit gap in the same bundle. Bundling makes sense because contract registrations from B1 and B4 share the same registry file. |

### Phase C — Hook into the failure-instrumentation framework

Add failure classes to the v5.1.0+ framework (`docs/internals.md:775`):
- `wave_codex_review_skip` — fires when A1's check finds coverage < 100% on a wave-mode bundle.
- `subagent_return_oversized` — fires when A2 sees a return > 5K bytes (the v3.3.0 WORKLOG-regression threshold).
- `eligibility_cache_event_missing` — fires when A3's audit sees a Step C entry without the mandatory event.
- `dispatch_brief_unregistered` — fires when B4's audit (or future runs) hit a lifecycle dispatch site without a `contract_id`.

This lets the framework file issues automatically; the user prioritizes which to fix, rather than the orchestrator designing fixes on the spot. Aligns with `feedback_failures_drive_instrumentation_not_fixes`.

## Critical files

- `parts/step-c.md:87` (wave-pin short-circuit), `:96` (mandatory `eligibility_cache` event), `:492–565` (Step 4b serial Codex review block), `:613` (wave-mode 4b skip rule to replace) — A3, A4, B1, B3, B4
- `parts/step-b.md:353` (plan-writer Codex annotation guidance), `:363–365` (complexity-tier rules) — B2
- `parts/doctor.md` (add check #43, audit for inline-reads) — A1, B4
- `hooks/masterplan-telemetry.sh` (add `subagent_return_bytes`) — A2
- `docs/internals.md` §3 (subagent dispatch), §8 (Codex integration), §9 (telemetry schema), §10 (failure framework) — doc updates after each phase
- `commands/masterplan-contracts.md` (register `codex.review_wave_member_v1` for B1; register 5 freeform-site contracts for B4) — B1, B4
- `bin/masterplan-self-host-audit.sh` (strengthen `--brief-style` to flag missing `contract_id` at lifecycle sites) — B4

## Verification

- **A1 backfill**: run `/masterplan doctor` against existing bundles (`concurrency-guards`, `p4-suppression-smoke`); check #43 should WARN both, citing zero `review→` events vs N `wave_task_completed` events.
- **A2 smoke**: run any new wave-dispatch run with telemetry enabled; verify `subagents.jsonl` contains `subagent_return_bytes` field per record. Cross-check distribution: P99 should be < 5K bytes; if not, that's a context-pollution finding.
- **A3 smoke**: trigger a wave-mode run; verify `events.jsonl` contains a `wave_routing_summary` event at wave-start and an `eligibility_cache` event at Step C entry.
- **B1 end-to-end**: trigger a 3-member wave with `codex.review: on`; verify N=3 Codex REVIEW dispatches at wave-end in a single batched assistant message, each scoped to one member's files, `review→CODEX(wave-member; <task_id>)` events written per member, findings applied per autonomy matrix.
- **B2 plan-write smoke**: invoke `/masterplan plan` against a sample spec with mixed single-file code, single-file doc, and multi-file tasks; verify single-file tasks (code AND doc) default to `**Codex:** ok`; multi-file tasks default to `**Codex:** no`.
- **B3 asymmetric**: trigger a Codex-EXEC'd task with `codex.review: on`; verify Step 4b skips with `decision_source: codex-produced` and `review→SKIP(codex-produced)` event. Repeat for a wave member that was Codex-routed.
- **B4 audit**: run the F6 audit; verify findings report enumerates every dispatch site without `contract_id` in `parts/step-c.md` and `parts/doctor.md`; verify 5 new contracts registered; verify `bin/masterplan-self-host-audit.sh --brief-style` flags new freeform sites.
- **C smoke**: trigger A1/A2/A3/B4 failure scenarios; verify the failure-instrumentation framework auto-files issues with the new classes (`wave_codex_review_skip`, `subagent_return_oversized`, `eligibility_cache_event_missing`, `dispatch_brief_unregistered`).

## Execution sequencing

A1–A4 land first (independent, low-risk, instrument-only). B3 depends on A4 (`dispatched_by` field must exist before asymmetric rule fires). B1 should land after A1+A3 so the new wave-mode review path emits the visibility events the doctor check expects. B2 is independent of all other changes and can land in parallel. B4 audit runs after B1 lands (so new B1 contract registrations are visible to the audit). C hooks land last, once A1/A2/A3/B4 detectors are in place.
