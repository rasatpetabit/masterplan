# Complexity Levels — Retrospective

**Slug:** complexity-levels
**Started:** 2026-05-05T14:58 (commit `c113c1a`)
**Completed:** 2026-05-05T15:40 (release tag `v2.5.0`, commit `d0b3ba4`)
**Branch:** `complexity-levels` (worktree at `.worktrees/complexity-levels/`; merged to main at release)
**PR:** (none — direct-to-main shipping per project convention)

---

## Outcomes

- Shipped a 3-level `complexity: low|medium|high` meta-knob at every config tier (CLI flag `--complexity=<level>`, `~/.masterplan.yaml`, repo `.masterplan.yaml`, status frontmatter). Achieves G1, G5.
- `medium` is the default; all current behavior is preserved verbatim. Pre-feature plans without the field are read as `medium` at every Step C entry with no migration. Achieves G2, and N3.
- `low` measurably sheds overhead: eligibility cache, telemetry sidecar, wakeup ledger, parallelism, codex routing/review all skipped by default; activity log drops to one-line entries with a 50-entry rotation threshold; writing-plans brief targets ~3–7 tasks. Achieves G3.
- `high` adds rigor-forward defaults: `codex_review` on with `review_prompt_at: low`, required `**Files:**`/`**Codex:**` annotations, eligibility cache validated against plan annotations, retro surfaced as recommended at completion, new doctor check #22 (high-only rigor-evidence guard). Partially achieves G1 (high tier).
- Kickoff prompt (`AskUserQuestion`) fires once between worktree decision and brainstorm when `--complexity` is unset and no config tier sets it. Achieves G6.
- Brainstorm unchanged at all levels. Achieves G7.

---

## Timeline

*(Reconstructed from git log — no activity log from a status file. All timestamps are 2026-05-05.)*

- **14:58** `c113c1a` — Task 1: Declarations (config schema, flag table, frontmatter field, status template). 10 insertions.
- **15:02** `be24bda` — Task 2: Step 0 complexity resolver + audit-line format.
- **15:05** `3551628` — Task 3: Operational rules — complexity-precedence table (6 knobs × 3 levels).
- **15:11** `1af327c` — Task 4: Step B3 kickoff prompt. Status commit `ed8a030` notes anchor had to be retargeted (see Deviations).
- **15:14** `fd16b34` — Task 5: Resume-time complexity resolution + `## Notes` audit on change.
- **15:17** `5388a99` — Task 6: Eligibility cache gate at low. Status commit `e5e0816` notes telemetry paragraph in the worktree was more elaborate than the plan's OLD pattern; brief adapted.
- **15:19** `4a45b17` — Task 7: Telemetry sidecar gate at low.
- **15:21** `6ace2af` — Task 8: Activity log density + rotation threshold by complexity.
- **15:23** `f5eb035` — Task 9: Wakeup-ledger gate at low.
- **15:25** `20f762e` — Task 10: Step B2 writing-plans brief parameterization.
- **15:27** `5320205` — Task 11: Step C step 6 retro requirement at high.
- **15:29** `9b14130` — Task 12: Doctor check-set gate (per-plan, per-complexity).
- **15:31** `de5a1e1` — Task 13: Doctor check #22 (high-only rigor evidence). Count updated from 21 → 22.
- **15:33** `5b221b3` — Task 15: CHANGELOG entry + Status file format hint. (Task 14 was read-only verification; no commit.)
- **15:40** `d0b3ba4` — Release: `v2.5.0` — version bumps in `plugin.json` + `marketplace.json`, CHANGELOG `[Unreleased]` cut to `[2.5.0] — 2026-05-05`.

Total elapsed: ~42 minutes. 13 implementation commits + 1 release commit; status commits interleaved.

---

## What went well

- **Spec-to-plan fidelity was near-perfect.** The plan's 16-task structure (Tasks 1–16) mapped 1:1 to the spec's behavior matrix sections (Plan-writing, Status file, Execute defaults, Doctor, Kickoff UX, Resume UX). No tasks were added mid-run.
- **Defaults-only design kept the implementation surface minimal.** Because complexity sets defaults that explicit overrides win, every gating edit was an additive insert (not a rewrite of an existing decision path). The estimated +200 / -10 line delta landed accurately — `5b221b3` + `d0b3ba4` together show ~41 net lines in `commands/masterplan.md` across all tasks. (CHANGELOG.md: `5b221b3`, +31 lines; CHANGELOG line 256.)
- **Subagent-driven execution kept orchestrator context lean.** Each task dispatched as a bounded Codex-eligible brief; status commits (`d68ca29`, `ed8a030`, etc.) confirm the status file was the canonical handoff surface throughout.
- **`medium` backward-compat held.** Doctor check #9 (schema) was unmodified at any level — the same 15-field required set applies everywhere, with `complexity:` treated as optional (absent = `medium`). No migration burden.
- **Doctor check #22 predicate resolved conservatively.** Open question OQ4 in the spec (spec line 247) asked "lacks ALL three OR ANY one?" — implementation chose ALL three, reducing noise on high plans that have partial rigor evidence.

---

## What blocked

No blockers tracked — this plan was never executed via `/masterplan execute`, so no `## Blocked` sections were written. The reconstruction from git log shows no pause longer than ~3 minutes between any two consecutive commits, consistent with an unblocked run. If any friction occurred, it is not recoverable from primary sources.

---

## Deviations from spec

- **Task 4 anchor retargeted** (status commit `ed8a030`, 15:11). The plan's Task 4 Step 1 instruction said to insert the kickoff-prompt subsection "before the existing 'Create the sibling status file at...' line" in Step B3. In the v2.4.1 worktree the target anchor text did not exist verbatim; the executor retargeted to the functional equivalent. Spec G6 (discoverable, fires once between worktree decision and brainstorm) was not affected.

- **Task 7 telemetry paragraph adapted** (status commit `e5e0816`, 15:17). The plan's Task 7 Step 1 included an exact OLD/NEW paragraph swap for the "Telemetry inline snapshot" subsection. The paragraph in the v2.4.1 worktree was more elaborate than the plan's OLD pattern; the brief was adapted to preserve the worktree's phrasing while prepending the complexity gate. The gating semantics (spec §Status file / Telemetry sidecar row, spec line 99) were preserved.

- **Task 14 T14 parallel-group annotation dropped post-merge** (commit `7e6e4de`, post-v2.5.0). After release, doctor checks #15 (parallel-group without Files: block) and #16 (parallel-group + Codex: ok mutual conflict) fired against the plan file itself (T14 had both annotations in conflict). The plan's `**parallel-group:** verification` line was dropped and the status file + eligibility cache were archived to `legacy/.archive/2026-05-05/`. This was a post-release cleanup, not a mid-run deviation; the plan file stayed in `plans_path` as an orphan.

- **Doctor parallelization-brief count stale post-v2.8.0** (CHANGELOG lines 78–82). After v2.8.0 added checks #23 and #24, the orchestrator's parallelization brief still read "all 22 current checks PLUS new check #22 (added by Task 13)" — a leftover from this plan. Fixed in v2.9.0 (commit `fcc2358`). Spec G1 was not violated; the runtime was correct; only the inline doc count was stale.

- **Spec goals fully honored:** G1–G7 all shipped. Non-goals N1–N5 not violated — `autonomy`, `codex_routing`, `codex_review`, `parallelism` all retained as orthogonal fine-grain controls (N1); no per-task `**Complexity:**` annotation added (N2); no migration script (N3); verb routing and gate sequencing for brainstorm/plan unchanged (N4); Step M (bare invocation) unchanged (N5, spec line 172).

- **Open questions disposition** (spec §Open questions, lines 244–248): OQ1 (`--quick` alias), OQ2 (auto-compact nudge suppression at low), OQ3 (resolution source in `## Notes` vs activity log only), OQ5 (`/masterplan stats` complexity distribution) — all deferred. OQ4 (predicate for check #22) resolved to "lacks ALL three" (implemented).

---

## Codex routing observations

Not tracked for this plan — no per-task telemetry sidecar exists (the plan predates `/masterplan execute` dispatch; the feature was authored and executed in a single session without a formal Step C telemetry path). No `<slug>-telemetry.jsonl` was produced.

---

## Follow-ups

- [ ] **`--quick` alias for `--complexity=low`** — ergonomic only; spec OQ1. `/schedule` candidate? No (low priority, no user demand cited yet).
- [ ] **Auto-compact nudge suppression at `complexity: low`** — spec OQ2; lean yes. `/schedule` candidate? No.
- [ ] **`/masterplan stats` complexity distribution rendering** — spec OQ5; trivial extension to Step T's `health_flags` output. `/schedule` candidate? No.
- [ ] **Doctor parallelization-brief count** — already fixed in v2.9.0 (`fcc2358`). No action needed.

---

## Lessons / pattern notes

- **Status commits are high-value forensics.** The interleaved `status: T<n> complete → T<n+1> dispatched` commits (`d68ca29` through `c909617`) preserved anchor-retarget and brief-adaptation notes that would otherwise be lost between sessions. Promoting this pattern — write a status commit after every task, not just after verification — to `docs/internals.md§Status file format` would capture mid-run adaptation evidence.

- **The defaults-only model eliminates most override conflicts.** By making complexity set defaults (not hard overrides), the implementation required zero guard logic against "what if the user has `--codex-review=on` and `complexity: low`?" — the existing per-knob precedence chain handled it automatically. Future meta-knobs should adopt this shape.

- **Plan file annotations as a trust contract** (G1 high-tier eligibility cache). The high-tier eligibility cache build validated against `**Files:**` blocks worked without any new infrastructure because the annotation-completeness rule was already present in the plan file format. The spec's design decision to *require* `**Files:**` at high (spec §Behavior matrix / Plan-writing, line 86) rather than merely encourage it made the validation predicate tractable.

- **Stale inline doc counts are a low-severity but recurring debt class.** The v2.9.0 fix (`fcc2358`) patching the parallelization-brief count is the second time a count-reference inside the orchestrator prompt went stale post-release (the first was the check-count reference in v2.5.0 itself, caught by Task 13 Step 3). Adding a grep-based CI assertion ("no references to `all 2N checks` where `2N` is not the current check count") would catch this at commit time rather than at the next feature's code review.
