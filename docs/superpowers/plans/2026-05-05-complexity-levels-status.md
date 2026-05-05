---
slug: complexity-levels
status: in-progress
spec: docs/superpowers/specs/2026-05-05-complexity-levels-design.md
plan: docs/superpowers/plans/2026-05-05-complexity-levels.md
worktree: /home/grojas/dev/superpowers-masterplan/.worktrees/complexity-levels
branch: complexity-levels
started: 2026-05-05
last_activity: 2026-05-05T22:23:00Z
current_task: "Task 13: Step D — new doctor check #22 (high-only rigor evidence)"
next_action: "Append row #22 to checks table after row #21; update any '21 checks' citations to '22 checks'"
autonomy: loose
loop_enabled: true
codex_routing: auto
codex_review: on
compact_loop_recommended: true
---

# 3-Level Complexity Variable — Status

## Activity log
- 2026-05-05T17:00 brainstorm complete, spec at docs/superpowers/specs/2026-05-05-complexity-levels-design.md (commit 4b21318)
- 2026-05-05T18:55 plan written, 16 tasks, plan at docs/superpowers/plans/2026-05-05-complexity-levels.md (commit 94bab21)
- 2026-05-05T19:00 entering Step C under autonomy=gated, codex_routing=auto, codex_review=on
- 2026-05-05T21:44 eligibility cache: built (16 tasks; 15 codex-eligible) — first build for this plan
- 2026-05-05T21:46 gated→loose offer: switch to loose
- 2026-05-05T21:47 routing→CODEX (Task 1: Declarations — config schema, flag table, frontmatter field list, status template) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T21:50 Task 1 complete, commit c113c1a [codex] (verify: trusted implementer; 4 grep matches as expected)
- 2026-05-05T21:50 routing→CODEX (Task 2: Step 0 — complexity resolver + activity log source line) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T21:53 Task 2 complete, commit be24bda [codex] (verify: trusted; 4 grep matches)
- 2026-05-05T21:53 routing→CODEX (Task 3: Operational rules — complexity → defaults table + override precedence) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T21:56 Task 3 complete, commit 3551628 [codex] (verify: trusted; 4 grep matches; bullet placed before Future-design notes)
- 2026-05-05T21:56 Notes: anchor "End-of-turn timer disclosure" cited in T3 brief is in system-prompt orchestrator only, not in v2.4.1 worktree file. Codex placed bullet correctly anyway (last bullet of Operational rules). Same-class mismatch may affect T5 (wakeup-ledger fired/armed) and T7 (telemetry block has Git-excludes prelude) — adapt briefs per task.
- 2026-05-05T21:56 routing→CODEX (Task 4: Step B3 — kickoff prompt for complexity) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T21:59 Task 4 complete, commit 1af327c [codex] (verify: trusted; 2 grep matches)
- 2026-05-05T21:59 routing→CODEX (Task 5: Step C step 1 — resume-time complexity resolution; anchor retargeted to "before Verify the worktree") [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:02 Task 5 complete, commit fd16b34 [codex] (verify: trusted; 2 grep matches)
- 2026-05-05T22:02 routing→CODEX (Task 6: Step C step 1 — eligibility cache gate at low) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:05 Task 6 complete, commit 5388a99 [codex] (verify: trusted; 1 grep match; codex sandbox couldn't commit — orchestrator committed)
- 2026-05-05T22:05 routing→CODEX (Task 7: Step C step 1 — telemetry sidecar gate at low; brief adapted for worktree's elaborate paragraph) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:08 Task 7 complete, commit 4a45b17 [codex] (verify: trusted; 1 grep match; codex didn't commit per brief; orchestrator committed)
- 2026-05-05T22:08 routing→CODEX (Task 8: Step C step 4d — log density + rotation by complexity) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:11 Task 8 complete, commit 6ace2af [codex] (verify: trusted; 2 grep matches)
- 2026-05-05T22:11 routing→CODEX (Task 9: Step C step 5 — wakeup-ledger gate at low) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:14 Task 9 complete, commit f5eb035 [codex] (verify: trusted; 1 grep match)
- 2026-05-05T22:14 routing→CODEX (Task 10: Step B2 — writing-plans brief parameterization) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:17 Task 10 complete, commit 20f762e [codex] (verify: trusted; 2 grep matches)
- 2026-05-05T22:17 routing→CODEX (Task 11: Step C step 6 — retro requirement at high) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:20 Task 11 complete, commit 5320205 [codex] (verify: trusted; 2 grep matches)
- 2026-05-05T22:20 routing→CODEX (Task 12: Step D — complexity-aware check-set gate) [codex_routing=auto, decision_source=annotation]
- 2026-05-05T22:23 Task 12 complete, commit 9b14130 [codex] (verify: trusted; 2 grep matches)
- 2026-05-05T22:23 routing→CODEX (Task 13: Step D — new doctor check #22) [codex_routing=auto, decision_source=annotation]

## Blockers
(none)

## Notes
- 2026-05-05T21:46 Switched from gated to loose (plan has 16 tasks; user accepted gated→loose offer at Step C step 1).
- This plan implements the `complexity` feature itself — current execution runs under the *pre-feature* orchestrator (medium-equivalent semantics throughout). The new behavior only takes effect at the next /masterplan invocation after Task 16 (release v2.5.0).
- Plan is on the `complexity-levels` branch in `.worktrees/complexity-levels/`. Spec at `docs/superpowers/specs/2026-05-05-complexity-levels-design.md` (committed `4b21318`).
- All tasks except Task 16 are marked `**Codex:** ok` (bounded markdown surgery + grep verification). Task 16 is `**Codex:** no` (release/push requires user authorization gate).
- Tasks 14 (verification sweep) is `parallel-group: verification` (read-only).

## Wakeup ledger
(empty — populated by Step C step 5 if /loop is active)
