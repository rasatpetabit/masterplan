# Staging — WORKLOG entry for v5.8.0 (codex-routing-fix bundle)

Intended insertion point: top of `WORKLOG.md`, above the existing `## 2026-05-16 — concurrency-guards implemented` entry.

Placeholders to fill from the final run: commit SHA range, retro decisions, any new findings from Codex review.

---

## 2026-05-16 — codex-routing-fix shipped (v5.8.0, branch codex-routing-fix)

**Scope:** Closes the T8 wave-mode-review-via-Claude misfire and the broader Codex under-dispatch chain (F1→F6 in `docs/masterplan/codex-routing-fix/brainstorm.md`). Bundle delivered as Phase A (instrument) + Phase B (policy fix) + Phase C (failure-class hooks) per the approved plan at `/home/ras/.claude/plans/steady-sparking-nygaard.md`. 15 tasks across 5 waves: Wave 1 parallel Codex EXEC × 3 (T1/T2/T3), Wave 2 serial Codex on `parts/step-c.md` (T4→T5→T6→T7), Wave 3 inline-Claude multi-file audit (T8), Wave 4 batched Codex EXEC (T9-T12 to `parts/failure-classes.md`), Wave 5 inline-Claude finale (T13 internals docs, T14 version+CHANGELOG, T15 this entry). All green.

**Worktree isolation:** `.worktrees/codex-routing-fix` on branch `codex-routing-fix`. Necessary because the work modifies `parts/step-c.md` and `parts/step-b.md` while the orchestrator reads them to drive itself — self-modification hazard. PR → main pending user merge approval.

**Three locked decisions baked into the plan (vs my conservative recommendations):**
1. **B1 granularity:** N Codex reviews per wave (one per member, diff scoped to member's `**Files:**`) — user picked "maximum precision per task" over my "single wave-level review". Required new contract `codex.review_wave_member_v1`.
2. **B2 default:** Aggressive — `**Codex:** ok` default for ALL single-file edits including doc edits. User picked "maximum offload" over my "code-only" recommendation. Risk-bounded by per-task `**Codex:** no` escape hatch.
3. **F6 scope (B4):** Bundled into this work — inline-reads/dispatch-brief audit of `parts/step-c.md` + `parts/doctor.md` runs in the same plan. User picked "fix while we're in here" over my "defer to follow-up bundle".

**Why instrument first (Phase A before Phase B):** Per `feedback_failures_drive_instrumentation_not_fixes` memory — never design /masterplan fixes on the spot; framework auto-files issues, analysis drives prioritization. Phase A adds the detectors (doctor #43, `subagent_return_bytes` telemetry field, mandatory event compliance) so Phase B's policy changes have measurable signal AND so future regressions auto-file as failure classes (Phase C).

**Asymmetric review rule:** Codex gets ALL code-review work unless the code under review came from Codex itself (`dispatched_by == "codex"`). Codified at both serial 4b site (`parts/step-c.md:492`) and the new wave-member 4b block. The principle existed in `docs/internals.md:577` but wasn't enforced in the wave-dispatch path before this bundle.

**Doctor check #43 backfill:** Running #43 against existing bundles `concurrency-guards` and `p4-suppression-smoke` WARNs both — neither emits `review→` events because both predate this bundle. Backfill warnings are documented as expected; no remediation work added.

**Subagent return-bytes telemetry:** The `subagent_return_bytes` field on per-subagent JSONL records is the long-missing piece for measuring the user's original context-pollution concern. Detector for new `subagent_return_oversized` class (threshold 5120 bytes = v3.3.0 WORKLOG-regression threshold).

**Commit range:** `<first-sha>..<last-sha>` (fill on merge).

---

## Notes for future maintainers (post-v5.8.0)

- The new aggressive Codex annotation default in `parts/step-b.md` may surface new categories of Codex EXEC failures (e.g., doc edits where Codex's interpretation differs from intent). Watch the `subagent_return_oversized` class for the first few v5.8.0 runs.
- The wave-member Codex REVIEW dispatch path is new and untested at scale. Doctor #43 will warn on coverage gaps; the `wave_codex_review_skip` failure class auto-files.
- The 5 new dispatch-brief contracts in `commands/masterplan-contracts.md` raise the per-dispatch overhead slightly (registry lookup) but pay back by making lifecycle dispatch sites lintable via `bin/masterplan-self-host-audit.sh --brief-style`.
