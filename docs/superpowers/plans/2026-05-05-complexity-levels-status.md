---
slug: complexity-levels
status: in-progress
spec: docs/superpowers/specs/2026-05-05-complexity-levels-design.md
plan: docs/superpowers/plans/2026-05-05-complexity-levels.md
worktree: /home/grojas/dev/superpowers-masterplan/.worktrees/complexity-levels
branch: complexity-levels
started: 2026-05-05
last_activity: 2026-05-05T19:00:00Z
current_task: "Task 1: Declarations — config schema, flag table, frontmatter field list, status template"
next_action: "Add `complexity` to the YAML schema block (Step 1 of Task 1) — insert after `autonomy: gated` line in the .masterplan.yaml schema"
autonomy: gated
loop_enabled: true
codex_routing: auto
codex_review: on
compact_loop_recommended: false
---

# 3-Level Complexity Variable — Status

## Activity log
- 2026-05-05T17:00 brainstorm complete, spec at docs/superpowers/specs/2026-05-05-complexity-levels-design.md (commit 4b21318)
- 2026-05-05T18:55 plan written, 16 tasks, plan at docs/superpowers/plans/2026-05-05-complexity-levels.md (commit 94bab21)
- 2026-05-05T19:00 entering Step C under autonomy=gated, codex_routing=auto, codex_review=on

## Blockers
(none)

## Notes
- This plan implements the `complexity` feature itself — current execution runs under the *pre-feature* orchestrator (medium-equivalent semantics throughout). The new behavior only takes effect at the next /masterplan invocation after Task 16 (release v2.5.0).
- Plan is on the `complexity-levels` branch in `.worktrees/complexity-levels/`. Spec at `docs/superpowers/specs/2026-05-05-complexity-levels-design.md` (committed `4b21318`).
- All tasks except Task 16 are marked `**Codex:** ok` (bounded markdown surgery + grep verification). Task 16 is `**Codex:** no` (release/push requires user authorization gate).
- Tasks 14 (verification sweep) is `parallel-group: verification` (read-only).

## Wakeup ledger
(empty — populated by Step C step 5 if /loop is active)
