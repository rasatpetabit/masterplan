// lib/recovery-preflight.mjs — committed-recovery preservation gate (contract item 7).
//
// Recovery recording must preflight the SAME scope/watch/baseline checks the normal
// record-result transaction runs, but WITHOUT mutation: no reset, no clean, no revert, no
// commit. In recovery mode the work is already committed at the pinned HEAD — the wave
// transaction's revert/commit steps are meaningless and dangerous. This module computes the
// verification verdicts (scope, watch-list delta, workspace-root drift) and returns them;
// the caller (recordWaveResult with recovery:true) rejects on any violation BEFORE marking
// tasks or touching the worktree. It never invokes a destructive git operation.
//
// LOCAL git only, -C-qualified (same seam as record-result).

import path from 'node:path';

import { verifyScope, declaredScope } from './wave.mjs';
import {
  canonicalizeScopePaths,
  captureMultiRepoFiles,
} from './dispatch/multi-repo.mjs';
import {
  readWatchBaseline,
  snapshotWatchList,
  verifyWatchListDelta,
  workspaceRootFor,
} from './watch-integrity.mjs';

/**
 * Read-only recovery preflight. Runs the SAME checks the normal transaction would, but
 * returns verdicts instead of mutating anything. A non-ok result must REJECT the recovery
 * before any task mark / state write / git mutation.
 *
 * The capture helpers (captureWtFiles / captureWorkspaceRoot) are injected by the caller
 * (wave-commit.mjs owns them) to avoid a module cycle; they must be the SAME functions the
 * normal transaction uses so the verdicts match exactly.
 *
 * @returns {{ ok: boolean, violations: string[], scope?: object, watch?: object,
 *             wsLoose?: string[] }}
 */
export function preflightRecovery({
  statePath, state, run, wave, WT, MAIN, slug, baseline,
  captureWtFiles, captureWorkspaceRoot,
} = {}) {
  const violations = [];
  if (typeof captureWtFiles !== 'function' || typeof captureWorkspaceRoot !== 'function') {
    throw new Error('recovery-preflight: captureWtFiles and captureWorkspaceRoot must be injected by the caller');
  }
  const declared = canonicalizeScopePaths(
    run.scope ?? declaredScope(state, wave),
    { worktree: WT, mainRoot: MAIN, slug },
  );
  const before = baseline ?? run.baseline ?? [];
  const after = captureMultiRepoFiles(declared, {
    worktree: WT,
    mainRoot: MAIN,
    slug,
    captureWtFiles,
  });
  const scope = verifyScope(declared, before, after);
  if (!scope.ok) {
    violations.push(`recovery preflight: out-of-scope files present (${scope.outOfScope.join(', ')}) — committed recovery must not revert; resolve or exclude them`);
  }

  // Watch-list delta (the same 2b check): a moved HEAD or a non-controller delta in a watched
  // repo is a preservation violation. NO revert is performed — the recovery fails closed.
  let watch = { ok: true, violations: [], checked: false };
  const watchBaseline = readWatchBaseline(path.dirname(path.resolve(statePath)), wave);
  if (watchBaseline?.snapshots) {
    const afterSnaps = snapshotWatchList(
      Object.values(watchBaseline.snapshots).map((s) => ({ repo: s.repo, prefix: s.prefix, isMain: s.isMain })),
    );
    const delta = verifyWatchListDelta(watchBaseline.snapshots, afterSnaps, declared, {
      bundle: watchBaseline.bundle ?? null,
      bundleRel: (rel) => path.relative(path.dirname(path.resolve(statePath)), path.join(MAIN, rel)),
    });
    watch = { ...delta, checked: true };
    if (!watch.ok) {
      for (const v of delta.violations) {
        violations.push(`recovery preflight: watch-list violation ${v.repo} ${v.path}: ${v.reason}`);
      }
    }
  }

  // Workspace-root drift (the same 3b check) — read-only, no unlink. Mirrors the normal
  // transaction's guard: only fires when a wsBaseline was actually captured at launch.
  let wsLoose = [];
  const wsRoot = workspaceRootFor(MAIN);
  if (wsRoot && Array.isArray(run.wsBaseline) && run.wsBaseline.length > 0) {
    const nowEntries = captureWorkspaceRoot(wsRoot);
    const baselineSet = new Set(run.wsBaseline);
    wsLoose = nowEntries.filter((e) => !baselineSet.has(e));
    if (wsLoose.length) {
      violations.push(`recovery preflight: workspace-root drift (${wsLoose.join(', ')}) — committed recovery must not delete; resolve manually`);
    }
  }

  return { ok: violations.length === 0, violations, scope, watch, wsLoose };
}
