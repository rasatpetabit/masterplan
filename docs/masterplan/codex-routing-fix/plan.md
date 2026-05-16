# Implementation plan — codex-routing-fix

Source spec: `brainstorm.md` (approved via ExitPlanMode from `/home/ras/.claude/plans/steady-sparking-nygaard.md`).

**Autonomy:** loose. **Complexity:** medium. **Run bundle:** `docs/masterplan/codex-routing-fix/`.

**Goal:** Close the Codex under-dispatch + subagent context-discipline gaps documented in F1–F6 of the spec. Instrument first (Phase A), then policy-fix (Phase B), then wire failure classes (Phase C). All work lands on branch `codex-routing-fix` in worktree `.worktrees/codex-routing-fix` to isolate self-modification of the orchestrator parts.

**Aggressive Codex annotation default (per B2):** every single-file edit defaults to `**Codex:** ok`. Multi-file edits or ambiguous-scope tasks remain `**Codex:** no`. The doc/changelog/worklog finale is judgment-heavy and stays inline-Claude.

---

## Wave 1 — parallel single-file instrumentation (Codex EXEC × 3)

### Task 1: A1 — doctor check #43 `codex_review_coverage`

**Files:** `parts/doctor.md`

**Codex:** ok

**parallel-group:** wave-1

**Scope:** Add a new doctor check (#43) named `codex_review_coverage`. Iterate every run bundle's `events.jsonl`. For each `wave_task_completed` event, expect a paired `review→CODEX(...)` or `review→SKIP(<reason>)` event with explicit `decision_source`. Severity: WARN when coverage < 100% and the run was NOT inside a Codex host. Backfill against `docs/masterplan/concurrency-guards/events.jsonl` and `docs/masterplan/p4-suppression-smoke/events.jsonl` is expected to WARN — both predate the visibility-event rule.

**Spec refs:** `brainstorm.md` Phase A row A1.

**Verification:**
- `grep -q "^### Check 43" parts/doctor.md`
- `grep -q "codex_review_coverage" parts/doctor.md`
- The check description must reference `wave_task_completed`, `review→`, `decision_source`, and `codex.host` skip-gate.

### Task 2: A2 — telemetry emits `subagent_return_bytes`

**Files:** `hooks/masterplan-telemetry.sh`

**Codex:** ok

**parallel-group:** wave-1

**Scope:** Augment per-subagent JSONL record emission to include `subagent_return_bytes` (integer byte length of the returned text). Keep the existing schema; add the field. Field placement should sit alongside existing dispatch metadata (subagent_type, parent_turn, etc.). Cheap to compute — the return string is already in scope.

**Spec refs:** `brainstorm.md` Phase A row A2.

**Verification:**
- `bash -n hooks/masterplan-telemetry.sh`
- `grep -q subagent_return_bytes hooks/masterplan-telemetry.sh`
- New field must appear in the same record shape as existing per-subagent metadata.

### Task 3: B2 — aggressive Codex annotation default

**Files:** `parts/step-b.md`

**Codex:** ok

**parallel-group:** wave-1

**Scope:** Flip the plan-writer Codex-annotation guidance from conservative ("add `**Codex:** ok` when obviously well-suited") to aggressive: default `**Codex:** ok` for ALL single-file edits (code OR doc). Mark `**Codex:** no` only when multi-file, ambiguous scope, no known verification, or explicit scope-out applies. Update both the primary guidance at line 353 and the complexity-tier annotation rules at lines 363–365. Keep the per-task `**Codex:** no` escape hatch.

**Spec refs:** `brainstorm.md` Phase B row B2.

**Verification:**
- `grep -q "default.*Codex.*ok" parts/step-b.md`
- `grep -q "single-file" parts/step-b.md`
- The escape-hatch language (`**Codex:** no` when multi-file / ambiguous scope) must remain documented.

---

## Wave 2 — serial step-c.md mutations (Codex EXEC, sequential to avoid merge conflicts)

### Task 4: A3 — wave-pin emits mandatory `eligibility_cache` event + `wave_routing_summary`

**Files:** `parts/step-c.md`

**Codex:** ok

**Scope:** At `parts/step-c.md:87` the wave-pin short-circuit (`cache_pinned_for_wave == true → skip the rest of this decision tree`) silently drops the v2.4.0+ MANDATORY `eligibility_cache` event documented at `parts/step-c.md:96`. Make the wave-pin path emit the `eligibility_cache` event before short-circuiting. Additionally, at wave-entry, emit a new `wave_routing_summary` event with shape `{wave, members_by_route: {codex: N, inline_review: N, inline_no_review: N}}`. Both events restore the audit trail without altering the wave-pin behavior.

**Spec refs:** `brainstorm.md` Phase A row A3; F3 evidence.

**Verification:**
- `grep -q "wave_routing_summary" parts/step-c.md`
- The wave-pin section must reference `eligibility_cache` emission BEFORE the short-circuit return.
- Comment or rationale must cite that the emission satisfies the v2.4.0+ MANDATORY rule at line 96.

### Task 5: A4 — `dispatched_by` provenance on every completion event

**Files:** `parts/step-c.md`

**Codex:** ok

**Scope:** Every completion event written by Step C (`task_complete`, `wave_task_completed`, etc.) must carry a `dispatched_by` field with one of: `codex`, `claude`, `wave-claude`, `user`. This provenance is the precondition for Task 7 (B3 asymmetric review). Touch every event-emit site in step-c.md; cite a canonical naming table near the top of the file so future edits stay consistent.

**Spec refs:** `brainstorm.md` Phase A row A4.

**Verification:**
- `grep -c "dispatched_by" parts/step-c.md` returns ≥ 4 (one per completion-event site).
- A canonical enum table appears near the top of step-c.md listing the four values.

### Task 6: B1 — wave-mode 4b becomes N parallel per-member Codex REVIEW dispatches

**Files:** `parts/step-c.md`, `commands/masterplan-contracts.md`

**Codex:** no

**Scope:** Replace the wave-mode Step 4b skip rule at `parts/step-c.md:613` ("Skipped entirely for wave members") with a new block: at wave-end, dispatch N parallel Codex REVIEW calls (one per wave member), each scoped to that member's `**Files:**` with diff range = `<wave_start_sha>..<wave_end_sha>` filtered to those files. All N reviewers must batch into a single assistant message per the reviewer-batching rule. Orchestrator applies the existing per-task decision matrix per autonomy. Register a new contract `codex.review_wave_member_v1` in `commands/masterplan-contracts.md` capturing the per-member review brief shape.

**Spec refs:** `brainstorm.md` Phase B row B1; F2 evidence.

**Verification:**
- `grep -q "wave-member" parts/step-c.md` (the new dispatch label).
- `grep -q "codex.review_wave_member_v1" commands/masterplan-contracts.md`
- The replaced section must NOT contain "Skipped entirely for wave members" anymore.
- A note about reviewer-batching (single assistant message, N tool_use blocks) must appear in the new block.

### Task 7: B3 — asymmetric review enforcement at Step 4b (serial AND per-member wave)

**Files:** `parts/step-c.md`

**Codex:** ok

**Scope:** At Step 4b (both serial site at `parts/step-c.md:492` and the new wave-member block from Task 6), check `dispatched_by` (added in Task 5). If `dispatched_by == "codex"`, skip review with reason `codex-produced (asymmetric rule)` and emit `review→SKIP(codex-produced)` event with `decision_source: codex-produced`. Codifies the user's policy: Codex reviews all code-review work UNLESS the code under review came from Codex itself.

**Spec refs:** `brainstorm.md` Phase B row B3; `docs/internals.md:577` asymmetric principle.

**Verification:**
- `grep -q "codex-produced" parts/step-c.md`
- `grep -q "asymmetric" parts/step-c.md`
- Both the serial 4b site and the wave-member 4b site must implement the check.

---

## Wave 3 — F6 audit + contract registrations (mixed)

### Task 8: B4 — F6 inline-reads audit + freeform-site contracts + audit-script hardening

**Files:** `commands/masterplan-contracts.md`, `bin/masterplan-self-host-audit.sh`, `parts/step-c.md`, `parts/doctor.md`

**Codex:** no

**Scope:** Run an inline-reads / dispatch-brief audit of `parts/step-c.md` and `parts/doctor.md`. Use a properly-scoped Explore subagent with chunked reads (max 500 lines/call, max 3 chunks per file). Emit findings keyed to `file:line`: every dispatch site that lacks a `contract_id` or that inlines >500 bytes of file content into a brief. Register the top 5 freeform dispatch sites as new contracts in `commands/masterplan-contracts.md`: `step-c.eligibility_cache_build_v1`, `step-c.wave_implementer_v1`, `step-c.codex_exec_v1`, `step-c.codex_review_serial_v1`, `step-c.codex_review_wave_member_v1` (the last one may collapse into B1's `codex.review_wave_member_v1`). Strengthen `bin/masterplan-self-host-audit.sh --brief-style` to flag freeform briefs at lifecycle sites (any dispatch in step-c.md or doctor.md that lacks a `contract_id` reference).

**Spec refs:** `brainstorm.md` Phase B row B4; F6 evidence.

**Verification:**
- Audit findings written to `docs/masterplan/codex-routing-fix/b4-audit-findings.md`.
- ≥ 5 new contracts registered in `commands/masterplan-contracts.md`.
- `bash -n bin/masterplan-self-host-audit.sh`
- `bin/masterplan-self-host-audit.sh --brief-style` must produce output that includes a `contract_id`-missing warning section.

---

## Wave 4 — failure classes (parallel single-file appends)

### Task 9: C1 — `wave_codex_review_skip` failure class

**Files:** `parts/failure-classes.md`

**Codex:** ok

**parallel-group:** wave-4

**Scope:** Add failure class `wave_codex_review_skip`. Fires when A1's doctor check #43 finds coverage < 100% on a wave-mode bundle. Class metadata: severity, detector reference (check #43), suggested remediation pointer (re-run wave-end review or accept-and-document).

**Verification:** `grep -q "wave_codex_review_skip" parts/failure-classes.md`

### Task 10: C2 — `subagent_return_oversized` failure class

**Files:** `parts/failure-classes.md`

**Codex:** ok

**parallel-group:** wave-4

**Scope:** Add failure class `subagent_return_oversized`. Fires when A2's `subagent_return_bytes` telemetry sees a return > 5K bytes (the v3.3.0 WORKLOG-regression threshold). Class metadata: severity, threshold (5120 bytes), suggested remediation (tighten return-shape contract).

**Verification:** `grep -q "subagent_return_oversized" parts/failure-classes.md` and `grep -q "5120" parts/failure-classes.md`

### Task 11: C3 — `eligibility_cache_event_missing` failure class

**Files:** `parts/failure-classes.md`

**Codex:** ok

**parallel-group:** wave-4

**Scope:** Add failure class `eligibility_cache_event_missing`. Fires when A3's wave-entry audit sees a Step C entry without the mandatory `eligibility_cache` event. Class metadata: severity, detector reference (check #43 sibling or new event-presence check), suggested remediation (re-emit mandatory event).

**Verification:** `grep -q "eligibility_cache_event_missing" parts/failure-classes.md`

### Task 12: C4 — `dispatch_brief_unregistered` failure class

**Files:** `parts/failure-classes.md`

**Codex:** ok

**parallel-group:** wave-4

**Scope:** Add failure class `dispatch_brief_unregistered`. Fires when B4's `--brief-style` audit (or future runs) hit a lifecycle dispatch site without a `contract_id`. Class metadata: severity, detector reference (audit script), suggested remediation (register contract in `commands/masterplan-contracts.md`).

**Verification:** `grep -q "dispatch_brief_unregistered" parts/failure-classes.md`

---

## Wave 5 — finale (judgment-heavy, inline-Claude)

### Task 13: docs/internals.md updates

**Files:** `docs/internals.md`

**Codex:** no

**Scope:** Update §3 (subagent dispatch) with the new `subagent_return_bytes` field and the contract-registry expectation. Update §8 (Codex integration) with the per-member wave-review path and asymmetric-review enforcement. Update §9 (telemetry schema) with the new field and the four failure classes. Update §10 (failure framework) with the four new classes and their detectors. Cross-link each section to the implementing change.

**Verification:**
- `grep -q "subagent_return_bytes" docs/internals.md`
- `grep -q "wave-member" docs/internals.md`
- `grep -q "asymmetric" docs/internals.md`

### Task 14: CHANGELOG + version bump

**Files:** `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `CHANGELOG.md`

**Codex:** no

**Scope:** Bump version to v5.8.0 in all four manifest files (plugin.json × 2, marketplace.json × 2). Add CHANGELOG entry for v5.8.0 summarizing: aggressive Codex annotation default (B2), N-per-wave Codex review (B1), asymmetric-review enforcement (B3), wave-mode visibility-event compliance (A3), `dispatched_by` provenance (A4), `subagent_return_bytes` telemetry (A2), doctor check #43 (A1), B4 audit + new contracts, four failure classes (C).

**Verification:**
- `grep -q "5.8.0" .claude-plugin/plugin.json`
- `grep -q "5.8.0" .codex-plugin/plugin.json`
- `grep -q "v5.8.0" CHANGELOG.md`

### Task 15: WORKLOG entry

**Files:** `WORKLOG.md`

**Codex:** no

**Scope:** Append a terse dated WORKLOG entry summarizing why this work landed (T8 misfire + subagent context-pollution concerns), the high-level shape (instrument → policy-fix → failure-classes), and any non-obvious decisions (aggressive B2 default, N-per-wave granularity, asymmetric review). Keep entries terse — the diff shows what.

**Verification:** `grep -q "v5.8.0" WORKLOG.md` and `grep -q "codex-routing" WORKLOG.md`

---

## Execution sequencing

| Wave | Tasks | Dispatch | Rationale |
|---|---|---|---|
| 1 | T1, T2, T3 | parallel Codex EXEC × 3 | All single-file, different files (`parts/doctor.md`, `hooks/masterplan-telemetry.sh`, `parts/step-b.md`). No merge conflict risk. |
| 2 | T4 → T5 → T6 → T7 | serial Codex EXEC | All touch `parts/step-c.md`. Must be serial. T6 also touches `commands/masterplan-contracts.md`. T7 depends on T5 (`dispatched_by` field). T6 depends on A1+A3 (T1+T4) for the new visibility events. |
| 3 | T8 | inline Claude (multi-file + audit subagent) | B4 audit needs Explore subagent + 5 contract registrations. After T6 lands so its contract is visible to the audit. |
| 4 | T9, T10, T11, T12 | parallel Codex EXEC × 4 (all append same file) | Same file (`parts/failure-classes.md`). Need to serialize OR use one batched Codex EXEC with all four specs to avoid append-conflict. Pick whichever the implementer can guarantee atomic. |
| 5 | T13, T14, T15 | inline Claude, serial | Doc + CHANGELOG + WORKLOG. Judgment-heavy. |

**Critical-path note on Wave 4:** appending four classes to the same file in parallel risks merge clobber. Either (a) dispatch ONE Codex EXEC with all four task specs and "produce 4 sequential edits to parts/failure-classes.md" instruction (implementer-batching trigger applies) OR (b) serialize the four Codex calls. The implementer-batching pattern is cheaper and the right call here.
