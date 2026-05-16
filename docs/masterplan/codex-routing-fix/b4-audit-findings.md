# B4 — F6 audit findings (codex-routing-fix bundle, v5.8.0)

**Scope:** `parts/step-c.md` (~770 lines after T4-T7 landed) and `parts/doctor.md` (~1500 lines). Audit goal: identify lifecycle subagent dispatch sites lacking a `contract_id` reference, and flag briefs that inline > 500 bytes of file content.

## parts/step-c.md

**Total subagent dispatch sites found:** 5
- 1 with `contract_id` reference (the new wave-member Codex REVIEW, T6 → `codex.review_wave_member_v1`)
- 4 without `contract_id`

**Sites without `contract_id`:**

| File:line | Dispatch | Description |
|---|---|---|
| `parts/step-c.md:166` | Haiku (eligibility-cache shard) | Step C step 1 Haiku build path: bounded brief inlines plan task list + per-shard `task_indices`; returns JSON {tasks: [...]}. No contract_id. |
| `parts/step-c.md:267-269` | Agent wave-member implementer (Sonnet) | Step C step 2 wave dispatch: N parallel Agent calls, each receives standard implementer brief + 3 wave-specific clauses (WAVE CONTEXT block). No contract_id. |
| `parts/step-c.md:455-467` | `codex:codex-rescue` EXEC | Step 3a Codex EXEC delegation: bounded brief (Goal/Inputs/Scope/Constraints/Return per CLAUDE.md). No contract_id. |
| `parts/step-c.md:547-557` | `codex:codex-rescue` REVIEW (serial) | Step 4b serial Codex REVIEW: bounded brief with Goal/Inputs/Scope/Constraints/Return, diff range by SHA (NOT inlined). No contract_id. |

**Inline-read flags (> 500 bytes of file content in brief):** none.

The two Codex sites (3a EXEC, 4b serial REVIEW) explicitly avoid inlining diffs — they pass SHA ranges and let Codex run `git diff <range>` itself (see `parts/step-c.md:564`). The Haiku shard at line 166 inlines the plan task list, which is bounded by plan size (≤ 30 tasks typical, ≤ 50 worst case) and structurally necessary for the contract — not a context-pollution concern.

## parts/doctor.md

**Total subagent dispatch sites found:** 2 (both already contractified)
- `parts/doctor.md:26` — repo-scoped Haiku batch → `doctor.repo_scoped.schema_v1` ✓
- `parts/doctor.md:43` — per-bundle schema_v2 Haiku → `doctor.schema_v2` ✓

**Sites without `contract_id`:** none.

doctor.md is already clean for the v5.4.0+ contractification pattern.

## Recommended new contracts (top 4 — 5th collapses to existing)

| # | Name | Covers | Priority |
|---|---|---|---|
| 1 | `step-c.eligibility_cache_build_v1` | `parts/step-c.md:166` (Haiku shard) | High — frequent dispatch, complex JSON shape |
| 2 | `step-c.wave_implementer_v1` | `parts/step-c.md:267-269` (wave member) | High — N-parallel, shared brief shape |
| 3 | `step-c.codex_exec_v1` | `parts/step-c.md:455-467` (Codex EXEC) | High — every routed task; existing brief style is consistent |
| 4 | `step-c.codex_review_serial_v1` | `parts/step-c.md:547-557` (Codex REVIEW serial) | High — paired with `codex.review_wave_member_v1` for symmetric coverage |
| 5 | (collapse) | wave-member Codex REVIEW already covered by `codex.review_wave_member_v1` (T6 commit `958e649`) | — |

## Audit-script gap

`bin/masterplan-self-host-audit.sh --brief-style` currently scans only `commands/masterplan.md` (see `check_brief_style()` at line 837). Since the v5 architecture moved phase content into `parts/*.md`, the audit needs to also scan `parts/step-c.md` and `parts/doctor.md` for the DISPATCH-SITE convention and contract_id coverage.

**Recommended hardening:**
- Extend `check_brief_style()` to iterate over `commands/masterplan.md`, `parts/step-c.md`, `parts/doctor.md` rather than a single file.
- The lifecycle DISPATCH-SITE regex currently matches `Step B0 related-plan scan|Step R2 retro source gather|Step D doctor checks` — these are v4 step-name labels that live in `commands/masterplan.md`. For v5 phase files, also recognize `DISPATCH-SITE: step-c.md:<label>` and `DISPATCH-SITE: doctor.md:<label>` per the convention at `parts/step-c.md:13`.
- After T8 lands the 4 new contracts above, drift detection should flag any new dispatch site added to parts/*.md that doesn't carry a `contract_id` within 30 lines.

## Notes / judgment calls

1. **5th contract collapse:** the plan listed `step-c.codex_review_wave_member_v1` as a 5th candidate. T6 already registered it as `codex.review_wave_member_v1` (no `step-c.` prefix; matches the existing `codex.*` family). Verified canonical name is the T6 one; no duplicate registration needed.

2. **Haiku audit returned thin results.** The initial Explore subagent (Haiku) returned vague line numbers ("~600+", "~1200+") and acknowledged "partial reads." Direct grep + targeted Read calls produced the precise findings above. Logging this as a Haiku-shard quality observation: the Explore subagent's bounded brief should explicitly require completed file coverage before returning, not progress-tolerant partial returns.

3. **No inline-read regressions found.** The user's original concern ("subagent context-pollution") is structurally addressed in the current step-c.md design — every Codex brief passes SHA ranges, every Haiku shard passes annotation indices not full file bodies. The doctor.md contracts pass file path lists not file contents.

4. **Out-of-scope dispatch instructions** (sites I considered and rejected as non-lifecycle): the `feature-dev:code-reviewer` post-task review batching pattern mentioned in the CLAUDE.md Agent-dispatch policy is not invoked from parts/step-c.md or parts/doctor.md — it's a parent-side orchestration pattern referenced in user-facing prose only.
