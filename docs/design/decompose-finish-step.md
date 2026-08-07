# Deepen finishStep — extract state-machine phases

**Status:** Proposed

## Purpose

`finishStep` in `lib/finish-step.mjs` is a 484-line single-export function — a re-entrant state machine that applies the shell's answers (Phase A+B) then evaluates the machine top-down (Phase C, steps 1-8). All phases share mutable state (`state`, `head`, `events`). The numbered comments already provide structure, but the function body is one monolithic block with no visible seams. This change extracts two helpers so the orchestrator reads as a three-phase state machine, mirroring the dispatch-wave decomposition pattern.

## Goals

1. `finishStep` reads as a short orchestrator: preamble → apply answers → evaluate machine.
2. `applyShellAnswers` owns Phase A+B (verify/review/docs/goals/choice answer application).
3. `evaluateFinishMachine` owns Phase C (steps 1-8 top-down evaluation).
4. Preserve every behavior — all 36 finish-step tests pass without modification.

## Non-goals

- Splitting the machine evaluation into per-step helpers (steps 1-8 share too much state).
- Changing the context-object pattern once chosen (no re-litigation).
- Changing any function's external interface.
- Editing agent-dispatch or any other repository.

## Resolved design decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Decompose shape | Phase boundary (2 helpers) | State machine; phases are already numbered |
| State threading | Mutable context object | `state` is read/written by every phase; natural for state machines |
| Preamble | Stays inline (~40 lines) | Param parsing + Guard D + deriving MAIN/WT/branch; too coupled to extract cleanly |

## Current architecture

`finishStep` (lines 224-708, 484 lines) is one function with three implicit phases:

**Preamble (~40 lines):** Parse params, Guard D (owner lock), derive MAIN/WT/branch/ts.

**Phase A+B — Apply shell answers (~165 lines):** Each shell answer (verify, review, docs, goals, choice) is a durable transaction: append events, mutate state, possibly return an op. Early returns when an answer resolves a gate or triggers a terminal action.

**Phase C — Evaluate machine top-down (~250 lines):** Steps 1-8 evaluated in order, each can early-return an op:
1. Archive LAST (re-entry shortcut for retired disposition)
2. Open gate re-render (branch_finish/docs_normalize/goals_unmet)
3. Snapshot from WT
4. Dirty-commit (task-scope paths)
4.5. Docs-normalization offer
5. Verification gate
5.4/5.5. Spec-gate re-arm refusal + goal-completeness gate
6. Retro (write-if-absent)
7. Whole-branch adversary review
8. Branch_finish gate open + return

## Proposed architecture

### Context object

```js
const ctx = {
  statePath, absState, bundleDir, state, slug,
  MAIN, branch, WT, ts, retroPath, digestPath,
  self, now, ownerLockOff,
  // Shell answer flags (from params):
  verify, review, reviewCount, reviewBase, reviewDigestFile, reviewReason,
  docsSuppressed, docs, docsCount, docsReason,
  choice, pushed, removalForce, retroOnly,
  goalCheck, goalsChoice, force,
};
```

### Extracted helper: `applyShellAnswers(ctx)`

Owns Phase A+B. Mutates `ctx.state` as needed (writeState, openGate, clearGate). Returns an op object if the answer triggers a return, or `null` to continue to the machine.

Order of application:
1. verify (pass/fail)
2. review (done/skipped)
3. docs (normalized/skipped)
4. goalsChoice (fix/waiver/abort)
5. choice (merge/pr/keep/discard) — includes worktree teardown

### Extracted helper: `evaluateFinishMachine(ctx)`

Owns Phase C. Walks steps 1-8 in order. Mutates `ctx.state` and `ctx.head` as needed. Returns the first op that fires.

### Orchestrator: `finishStep` (~50 lines)

```js
export function finishStep({ ...params }) {
  // Preamble: parse, Guard D, derive MAIN/WT/branch/ts
  // ... (~40 lines, stays inline)
  
  const ctx = { state, absState, bundleDir, slug, MAIN, branch, WT, ts, ...params };
  
  const answer = applyShellAnswers(ctx);
  if (answer) return answer;
  
  return evaluateFinishMachine(ctx);
}
```

## What stays private

The 14 existing private helpers (`gitPorcelain`, `selectReviewAtHead`, `codexArmed`, `docsNormalizeArmed`, `readEvents`, `parseEventArray`, `goalsEnabledFor`, `computeSpecGateHash`, `evaluateGoalCompletion`, `hasCodexSkipAtSha`, `hasEventType`, `listDocCandidates`, `commitBundle`, `readEvents`) stay private at module scope. The two new helpers are also private (not exported).

## Error handling

No change — all helpers use the same early-return op pattern. Throws propagate to `finishStep`'s caller.

## Acceptance criteria

- `finishStep` is ~50 lines (preamble + ctx construction + two calls).
- `applyShellAnswers` owns Phase A+B (~165 lines).
- `evaluateFinishMachine` owns Phase C (~250 lines).
- All 36 finish-step tests pass without modification.
- No external interface change.
- Agent-dispatch repository unchanged.
- User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- `npm test` shows no new failures beyond the 3 pre-existing baseline.
