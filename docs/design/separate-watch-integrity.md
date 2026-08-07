# Separate watch integrity from the commit transaction

**Status:** Implemented

**Implemented:** 2026-08-07 (see commits and corresponding `docs/superpowers/plans/` plan doc)

## Purpose

The watch-integrity substrate (448 lines, 15 functions) lives inside `lib/wave-commit.mjs`, but it is neither a launch concern nor a commit concern — it is its own domain: capturing git-status snapshots, detecting cross-locus breaches (child commits, dirty-file overwrites, MAIN writes), and producing restoration evidence. The LAUNCH phase (`dispatch-wave.mjs`) imports `captureWatchBaseline`, `writeWatchBaseline`, `precheckWatchList` FROM `wave-commit.mjs` — a cross-module dependency smell where the commit module appears to own a concern that is not its own. This change moves the substrate into `lib/watch-integrity.mjs` so each module has one responsibility.

## Goals

1. Fix the cross-module dependency: both `dispatch-wave.mjs` and `wave-commit.mjs` import from `lib/watch-integrity.mjs` (not from each other for watch functions).
2. Give `wave-commit.mjs` one clear responsibility: the wave-completion transaction (`recordWaveResult`).
3. Preserve every behavior — all tests pass without modification.

## Non-goals

- Changing any function's interface, behavior, or injected-seam pattern.
- Creating a new adapter or swappable seam.
- Changing `recordWaveResult`'s transaction logic.
- Editing agent-dispatch or any other repository.

## Resolved design decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Friction | Cross-module dependency smell | dispatch-wave imports watch FROM wave-commit |
| Coupling | Minimal — only `runGit` | All other deps are external |
| runGit | Moves to watch-integrity | Git helper, not a commit concept; wave-commit imports it from there |
| Boundary | Full substrate + runGit | All 15 watch functions + constants; wave-commit keeps its transaction |
| Module name | `lib/watch-integrity.mjs` | Matches test/event vocabulary |

## Current architecture

`lib/wave-commit.mjs` (941 lines) contains:
- **Watch substrate** (lines 53–567): `runGit`, `gitLines`, `hashFile`, `parsePorcelainV2Entry`, `snapshotRepoState`, `buildWatchList`, `snapshotWatchList`, `relForRepo`, `precheckWatchList`, `watchBaselinePath`, `captureWatchBaseline`, `writeWatchBaseline`, `readWatchBaseline`, `MAIN_TRANSACTION_FILES`, `CONTROLLER_STATE_KEYS`, `validateMainDelta`, `wasTrackedAtLaunch`, `describeOutOfScopeDelta`, `verifyWatchListDelta`
- **Transaction** (lines 568–941): `recordWaveResult` (374 lines)
- **Review compat** (lines 90–139): `normalizeStoredReview`
- **Capture helpers** (lines 68–89): `captureWorkspaceRoot`, `captureWtFiles`

**Callers:**
- `dispatch-wave.mjs` imports: `captureWatchBaseline`, `writeWatchBaseline`, `precheckWatchList` from `wave-commit.mjs`
- `wave-commit.mjs` internally uses: `runGit`, `gitLines`, `readWatchBaseline`, `snapshotWatchList`, `verifyWatchListDelta`
- `test/wave-integrity.test.mjs` imports watch functions from `wave-commit.mjs` (23 tests, good locality)

## Proposed architecture

### New module: `lib/watch-integrity.mjs`

Contains the entire watch substrate + `runGit`:
- `runGit(dir, args, _exec)` — exported (wave-commit imports it)
- `gitLines(dir, args)` — private
- `hashFile(abs, _readFile)` — private
- `parsePorcelainV2Entry(line)` — exported
- `snapshotRepoState(repo, io)` — exported
- `buildWatchList(scopePaths, opts)` — exported
- `snapshotWatchList(watchList, io)` — exported
- `relForRepo(scopePath, snap)` — private
- `precheckWatchList(snapshots, scopePaths, opts)` — exported
- `watchBaselinePath(bundleDir, wave)` — exported
- `captureWatchBaseline(opts, io)` — exported
- `writeWatchBaseline(bundleDir, wave, baseline)` — exported
- `readWatchBaseline(bundleDir, wave)` — exported
- `MAIN_TRANSACTION_FILES` — exported (used by validateMainDelta)
- `CONTROLLER_STATE_KEYS` — exported (used by validateMainDelta)
- `validateMainDelta(rel, beforeSnap, afterSnap, io)` — private
- `wasTrackedAtLaunch(repo, rel, before, io)` — private
- `describeOutOfScopeDelta(repo, rel, before, beforeEntry, io)` — private
- `verifyWatchListDelta(beforeSnaps, afterSnaps, scopePaths, io)` — exported

Imports: `node:fs`, `node:path`, `node:crypto`, `./bundle.mjs` (parseState), `./dispatch/multi-repo.mjs` (partitionPathsByRepo)

### Modified: `lib/wave-commit.mjs`

- Import `runGit`, `captureWatchBaseline`, `writeWatchBaseline`, `precheckWatchList`, `readWatchBaseline`, `snapshotWatchList`, `verifyWatchListDelta` from `./watch-integrity.mjs` (replacing the inline definitions).
- Remove the ~448 lines of watch substrate code.
- Keep: `gitLines` (if used by remaining code), `captureWorkspaceRoot`, `captureWtFiles`, `normalizeStoredReview`, `recordWaveResult`.
- `recordWaveResult` calls watch functions exactly as before — only the import source changes.

### Modified: `lib/dispatch-wave.mjs`

- Change imports of `captureWatchBaseline`, `writeWatchBaseline`, `precheckWatchList` from `./wave-commit.mjs` to `./watch-integrity.mjs`.

### Modified: `test/wave-integrity.test.mjs`

- Change imports from `../lib/wave-commit.mjs` to `../lib/watch-integrity.mjs`.

## Error handling

No change — all functions keep their existing interfaces, injected seams, and error behavior.

## Acceptance criteria

- `lib/watch-integrity.mjs` owns the entire watch substrate + `runGit`.
- `dispatch-wave.mjs` and `wave-commit.mjs` both import watch functions from `lib/watch-integrity.mjs` (not from each other).
- `lib/wave-commit.mjs` is reduced by ~448 lines and focuses on the transaction + capture helpers.
- All existing tests pass without modification (only import paths change).
- Agent-dispatch repository unchanged.
- User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- `npm test` shows no new failures beyond the 2 pre-existing baseline.
