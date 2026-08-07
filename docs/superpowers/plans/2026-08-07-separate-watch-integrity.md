# Separate Watch Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the entire watch-integrity substrate (448 lines, 15 functions + `runGit`) from `lib/wave-commit.mjs` into `lib/watch-integrity.mjs`, fixing the cross-module dependency smell where `dispatch-wave.mjs` imports watch functions from the commit module.

**Architecture:** Mechanical extraction — no behavior changes, no interface changes. The new module owns watch capture, precheck, delta verification, and restoration evidence. Both `dispatch-wave.mjs` and `wave-commit.mjs` import from it.

**Tech Stack:** Node.js ESM, `node:test`, existing git test fixtures.

## Global Constraints

- Behavior-preserving: all existing tests pass without modification (only import paths change).
- No function interface, injected-seam, or error-behavior changes.
- Do not modify agent-dispatch or any other repository.
- Do not modify or stage the user-owned `AGENTS.md` or `WORKLOG.md` changes.

---

### Task 1: Extract watch-integrity module and rewire imports

**Files:**
- Create: `lib/watch-integrity.mjs`
- Modify: `lib/wave-commit.mjs` (remove watch substrate, import from new module)
- Modify: `lib/dispatch-wave.mjs` (change import source)
- Modify: `test/wave-integrity.test.mjs` (change import source)

- [ ] **Step 1: Create `lib/watch-integrity.mjs`**

Move the following from `lib/wave-commit.mjs` into the new module:
- `runGit` (exported)
- `gitLines` (private, if used by watch functions — check)
- `hashFile` (private)
- `parsePorcelainV2Entry` (exported)
- `snapshotRepoState` (exported)
- `buildWatchList` (exported)
- `snapshotWatchList` (exported)
- `relForRepo` (private)
- `precheckWatchList` (exported)
- `watchBaselinePath` (exported)
- `captureWatchBaseline` (exported)
- `writeWatchBaseline` (exported)
- `readWatchBaseline` (exported)
- `MAIN_TRANSACTION_FILES` (exported)
- `CONTROLLER_STATE_KEYS` (exported)
- `validateMainDelta` (private)
- `wasTrackedAtLaunch` (private)
- `describeOutOfScopeDelta` (private)
- `verifyWatchListDelta` (exported)

Imports for the new module: `node:fs`, `node:path`, `node:crypto`, `node:child_process` (for execFileSync in runGit), `./bundle.mjs` (parseState), `./dispatch/multi-repo.mjs` (partitionPathsByRepo).

- [ ] **Step 2: Rewire `lib/wave-commit.mjs`**

- Remove the moved functions/constants.
- Add import from `./watch-integrity.mjs`:
```js
import { runGit, captureWatchBaseline, writeWatchBaseline, precheckWatchList, readWatchBaseline, snapshotWatchList, verifyWatchListDelta } from './watch-integrity.mjs';
```
- Keep `gitLines` if `recordWaveResult` or remaining code uses it (it's a 3-line wrapper around `runGit` — may stay or be inlined).
- Keep `captureWorkspaceRoot`, `captureWtFiles`, `normalizeStoredReview`, `recordWaveResult`.
- `recordWaveResult` calls watch functions exactly as before — only the import source changes.

- [ ] **Step 3: Rewire `lib/dispatch-wave.mjs`**

Change the import of `captureWatchBaseline`, `writeWatchBaseline`, `precheckWatchList` from `./wave-commit.mjs` to `./watch-integrity.mjs`.

- [ ] **Step 4: Rewire `test/wave-integrity.test.mjs`**

Change import source from `../lib/wave-commit.mjs` to `../lib/watch-integrity.mjs`.

- [ ] **Step 5: Run focused tests**

```bash
node --test test/wave-integrity.test.mjs test/wave-commit.test.mjs test/dispatch-wave.test.mjs
```

Expected: all pass (behavior preserved).

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: no new failures beyond the 2 pre-existing baseline.

- [ ] **Step 7: Verify AGENTS.md and WORKLOG.md untouched**

```bash
git status --short AGENTS.md WORKLOG.md
```

- [ ] **Step 8: Commit**

```bash
git add lib/watch-integrity.mjs lib/wave-commit.mjs lib/dispatch-wave.mjs test/wave-integrity.test.mjs
git commit -m "refactor(watch): extract watch-integrity into its own module"
```

---

## Final Acceptance Check

- [ ] `lib/watch-integrity.mjs` owns the entire watch substrate + `runGit`.
- [ ] `dispatch-wave.mjs` and `wave-commit.mjs` both import from `lib/watch-integrity.mjs`.
- [ ] `lib/wave-commit.mjs` is reduced by ~448 lines.
- [ ] All existing tests pass without modification (only import paths change).
- [ ] Agent-dispatch repository unchanged.
- [ ] User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- [ ] `npm test` shows no new failures beyond the 2 pre-existing baseline.
