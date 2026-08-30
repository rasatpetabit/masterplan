# Decompose finishStep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `applyShellAnswers` and `evaluateFinishMachine` from the 484-line `finishStep` using a mutable context object. Behavior-preserving — all 36 tests pass unchanged.

**Architecture:** State-machine decomposition. `finishStep` becomes ~50 lines (preamble + ctx + two calls). Two private helpers own the two evaluation phases.

## Global Constraints

- Behavior-preserving: all existing tests pass without modification.
- The context object is mutable — helpers mutate `ctx.state`, `ctx.head`, etc. directly.
- Helpers are private (not exported) — `finishStep` is the only export.
- Do not modify agent-dispatch or any other repository.
- Do not modify or stage the user-owned `AGENTS.md` or `WORKLOG.md` changes.

---

### Task 1: Extract `applyShellAnswers` and `evaluateFinishMachine`

**Files:**
- Modify: `lib/finish-step.mjs`

This is a single-task refactor — the two helpers are tightly coupled (they share the same context object) and must be extracted together.

- [ ] **Step 1: Define the context object**

After the preamble (params parsing, Guard D, derive MAIN/WT/branch/ts), construct the context object from all shared variables and shell-answer flags. This replaces the individual `const` declarations that the body currently uses directly.

```js
const ctx = {
  statePath, absState, bundleDir, state, slug,
  MAIN, branch, WT, ts, retroPath, digestPath,
  self, now, ownerLockOff,
  verify, review, reviewCount, reviewBase, reviewDigestFile, reviewReason,
  docsSuppressed, docs, docsCount, docsReason,
  choice, pushed, removalForce, retroOnly,
  goalCheck, goalsChoice, force,
  // Derived helpers that close over fixed values
  wtHead: () => runGit(ctx.WT, ['rev-parse', 'HEAD']),
};
```

**Note:** `wtHead()` currently closes over `WT`. In the context object it must reference `ctx.WT` or be a method that reads the current WT. Since WT doesn't change after the preamble, a simple closure is fine — but define it after `ctx` is created so it can reference `ctx.WT`.

- [ ] **Step 2: Extract `applyShellAnswers(ctx)`**

Move Phase A+B into a private function that receives `ctx`, mutates `ctx.state` as needed, and returns an op or `null`:

```js
function applyShellAnswers(ctx) {
  // Phase A: verify pass/fail
  // Phase A: review done/skipped
  // Phase A: docs normalized/skipped
  // Phase A: goalsChoice fix/waiver/abort
  // Phase B: branch_finish choice resolution (merge/pr/keep/discard + worktree teardown)
  return null; // no answer triggered a return
}
```

**Critical:** Every `return { op: ... }` in Phase A+B becomes `return { op: ... }` in the helper. Every `writeState(absState, state)` becomes `writeState(ctx.absState, ctx.state)`. The `commitBundle` calls use `ctx.MAIN, ctx.bundleDir`. The `appendEvent` calls use `ctx.absState`.

- [ ] **Step 3: Extract `evaluateFinishMachine(ctx)`**

Move Phase C (steps 1-8) into a private function that receives `ctx`, mutates `ctx.state`/`ctx.head`/`ctx.events` as needed, and returns the first op that fires:

```js
function evaluateFinishMachine(ctx) {
  // 1. Archive LAST (retired disposition)
  // 2. Open gate re-render (branch_finish/docs_normalize/goals_unmet)
  // 3. Snapshot from WT
  // 4. Dirty-commit
  // 4.5. Docs-normalization offer
  // 5. Verification gate
  // 5.4/5.5. Spec-gate re-arm + goals gate
  // 6. Retro
  // 7. Adversary review
  // 8. Branch_finish gate open + return
}
```

**Critical:** Replace all bare variable references (`state`, `head`, `events`, `MAIN`, `WT`, `branch`, `slug`, `ts`, `absState`, `bundleDir`, `retroPath`, `digestPath`, `ownerLockOff`, `self`, `now`) with `ctx.` prefixed versions. The `readEvents(absState)` calls become `readEvents(ctx.absState)`. The `runGit(WT, ...)` calls become `runGit(ctx.WT, ...)`.

- [ ] **Step 4: Slim `finishStep` to the orchestrator**

`finishStep` becomes:
1. Preamble (params parsing + Guard D + derive MAIN/WT/branch/ts) — ~40 lines, stays inline
2. Construct `ctx` from the preamble's derived values + the raw params
3. `const answer = applyShellAnswers(ctx); if (answer) return answer;`
4. `return evaluateFinishMachine(ctx);`

- [ ] **Step 5: Run finish-step tests**

```bash
node --test test/finish-step.test.mjs
```

Expected: 36/36 pass (behavior preserved).

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: no new failures beyond the 3 pre-existing baseline.

- [ ] **Step 7: Verify AGENTS.md and WORKLOG.md untouched**

```bash
git status --short AGENTS.md WORKLOG.md
```

- [ ] **Step 8: Commit**

```bash
git add lib/finish-step.mjs
git commit -m "refactor(finish): extract state-machine phases from finishStep

Extract applyShellAnswers (Phase A+B) and evaluateFinishMachine
(Phase C) from the 484-line finishStep using a mutable context
object. finishStep becomes a ~50-line orchestrator: preamble →
apply answers → evaluate machine.

Behavior-preserving — all 36 finish-step tests pass unchanged."
```

---

## Final Acceptance Check

- [ ] `finishStep` is ~50 lines (preamble + ctx construction + two calls).
- [ ] `applyShellAnswers` owns Phase A+B (~165 lines).
- [ ] `evaluateFinishMachine` owns Phase C (~250 lines).
- [ ] All 36 finish-step tests pass without modification.
- [ ] No external interface change.
- [ ] Agent-dispatch repository unchanged.
- [ ] User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- [ ] `npm test` shows no new failures beyond the 3 pre-existing baseline.
