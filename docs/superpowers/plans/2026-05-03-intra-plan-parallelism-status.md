---
slug: intra-plan-parallelism
status: in-progress
spec: docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md
plan: docs/superpowers/plans/2026-05-03-intra-plan-parallelism.md
worktree: /home/ras/dev/claude-superflow
branch: main
started: 2026-05-03
last_activity: 2026-05-04T02:08:37Z
current_task: "Task 1: Step C step 1 — extend eligibility cache for parallel-group support"
next_action: "Define grep discriminators (run BEFORE editing) per Task 1 Step 1"
autonomy: gated
loop_enabled: true
codex_routing: auto
codex_review: on
compact_loop_recommended: true
---

# Intra-plan task parallelism (Slice α — read-only parallel waves) — Status

## Activity log
- 2026-05-04T02:08 brainstorm complete, spec at `docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md` (committed 360cbcc); 6 design sections + 16 acceptance criteria + 5 open questions
- 2026-05-04T02:08 plan written at `docs/superpowers/plans/2026-05-03-intra-plan-parallelism.md` (14 tasks); halt_mode=post-plan; awaiting close-out gate decision

## Blockers
(none)

## Notes
- **`--codex-review=on` was set on the /superflow invocation that produced this plan.** Persisted to status frontmatter (`codex_review: on`). When `/superflow execute` runs this plan, every inline-completed task gets reviewed by `codex:codex-rescue` in REVIEW mode against the spec. Findings auto-accept under `gated` autonomy below severity `medium` (default `codex.review_prompt_at: medium`); higher-severity prompts. Per-task `**Codex:** no` annotations on tasks touching `commands/superflow.md` (cross-section invariant awareness needed); `**Codex:** ok` on tasks 9, 10, 13 (bounded single-file edits).
- **Status file `worktree:` is `main`.** SDD (`superpowers:subagent-driven-development`) will refuse to start execution on `main`. When ready to execute, either:
  - (a) **Relocate the plan into a feature worktree first.** Use `git worktree add ../intra-plan-parallelism feat/intra-plan-parallelism` (or per superpowers:using-git-worktrees), then `git mv` the spec, plan, and status files into the new worktree's `docs/superpowers/{specs,plans}/`, commit the move, and `cd` into the new worktree before `/superflow execute`.
  - (b) **Manually handle SDD's refusal at Step C step 1** (less recommended — SDD will surface the refusal as a blocker; you'll have to handle it interactively). The post-plan close-out gate's "Open plan to review" option exits cleanly so you can do this at your own pace.
- **Auto-compact nudge fired once for this plan** (compact_loop_recommended flipped to true). When you `/superflow execute` later, consider pairing with `/loop 30m /compact focus on current task + active plan; drop tool output and old reasoning` in a sibling session for context compaction. The 14-task plan with per-task verification + Codex review is moderately context-heavy under autonomous execution.
- **Spec's Open Q5 (gated-mode wave gate UX)** is a clarification needed at execute time, not a planning blocker. The current default is: under `gated`, the per-task `AskUserQuestion(continue / skip / stop)` gate fires once at wave-start with the wave's task list shown. Spec calls this out for confirmation when the smoke test (Task 14) actually exercises a wave.
- **Meta-recursive note for Task 6 + the writing-plans brief.** This v1.1.0 plan itself does NOT use `parallel-group:` annotations because /superflow v1.0.0 (the version this plan executes under) doesn't recognize them. Plans authored AFTER v1.1.0 ships gain access to the annotation naturally via the writing-plans brief that Task 6 adds.
- **Smoke verification (Task 14) writes 3 temporary fixture files** in `docs/superpowers/{specs,plans}/2026-05-03-test-parallel-wave-*`. Task 14 Step 6 deletes them before commit so no smoke artifacts ship. If Task 14 is interrupted mid-execution, manually clean up these files before considering v1.1.0 complete.
- **Push policy:** Per the v1.0.0 release pattern, the user prefers "in one push" — commit all 14 tasks locally, run smoke verification, tag v1.1.0, then push to origin/main + tags as one batch. Task 14 Step 9 covers this; gated on user approval per CLAUDE.md's risky-actions policy.
