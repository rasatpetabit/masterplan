# Retrospective — hoist-run-policy

**Bundle:** hoist-run-policy  
**Completed:** 2026-05-23  
**Status:** All 4 tasks complete; 11/11 tests pass.

---

## What shipped

- `docs/conventions/api-retry-policy.md` — new conventions doc: retryable/fatal classification, 3-retry schedule (5s/15s/45s), user-facing notices, scope (Codex + inline).
- `parts/step-c-dispatch.md` — run-policy gate inserted at first parallel wave assembly; `on_blocker: async_hold` semantics documented.
- `docs/internals/wave-dispatch.md` — §API Error Handling section added with cross-reference.
- `tests/structural/test-api-retry-policy.sh` — new structural test covering file existence, content, and cross-refs.
- `tests/structural/test-coordinator-dispatch.sh` — A5/A6 checks added (run_policy gate presence and ordering).
- `CHANGELOG.md` — v6.2.0 entry.

## What went well

- Clean TDD rhythm: each task wrote the test first, confirmed failure, implemented, confirmed pass.
- The plan's two-phase cross-ref approach (test in Task 1, cross-refs added in Task 3) required adjustment: cross-ref checks were front-loaded into the Task 1 test script, then stripped back to match the phased structure. This is a minor planning artifact — the plan's split was correct; implementation just collapsed it.
- The v5 plan-format marker requirement (self-host audit check) caught a gap in the plan.md that was fixed immediately without test regression.

## What to improve

- The `writing-plans` skill should emit `**Spec:**` / `**Codex:**` / `**Verify:**` markers by default — they're required by the self-host audit's `check_plan_format()` but the skill's template doesn't include them.
- The CHANGELOG version number (v5.9.0 in the spec → v6.2.0 in practice) should be resolved during planning, not during Task 4 execution.

## Follow-up candidates

- Update `writing-plans` skill template to include v5 plan-format markers (`**Spec:**`, `**Codex:**`, `**Verify:**`) in every task header.
- The `on_blocker: async_hold` hold-surface AUQ at plan completion is specified but not yet wired to the Step C completion path — a future bundle could implement the runtime behavior.
