// lib/sweep.mjs — the worktree sweep transaction (T2.3, git-in-bin seam).
//
// `mp sweep` absorbs the §2e orphan-sweep prose: the LLM used to run `worktree list`,
// feed it to `mp worktree reconcile`, then hand-execute each action — including the
// destructive `git worktree remove --force` / `rm -rf` lines — from prose. Now the
// classification AND the execution live here, with one safety inversion the user ruled
// on: **dry-run is the default**. Without `apply`, the sweep only reports what it
// WOULD do; `mp sweep --apply` executes. `manual` actions are NEVER executed in either
// mode — they exist precisely because the classifier could not prove them safe.
//
// Same realpath discipline as `mp worktree reconcile` (the Codex Round-2 BLOCKER):
// repoGitDirCanonical stays NULL when it cannot resolve — never a lexical fallback —
// so a canonical mismatch we couldn't prove can never fire a foreign `remove`.

import fs from 'node:fs';
import path from 'node:path';

import { parseWorktreeList, classifyWorktrees } from './worktree.mjs';
import { collectDiskDirs, collectBundleRecords } from './worktree-fs.mjs';
import { readState, writeState, setWorktreeDisposition } from './bundle.mjs';
import { bundleArtifacts } from './paths.mjs';
import { runGit } from './watch-integrity.mjs';
import { findDanglingRuns } from './runs.mjs';
import { SEED_LOCK_RELPATH, inspectSeedLock } from './seed-lock.mjs';
import { childEnv } from './config.mjs';

export function sweepWorktrees({ repoRoot, apply = false, env = childEnv() } = {}) {
  if (!repoRoot) throw new Error('sweep: repoRoot is required');
  // MAIN = the primary checkout, even when invoked from inside a linked worktree.
  const repoGitDir = runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const MAIN = path.dirname(repoGitDir);
  let repoGitDirCanonical = null;
  try {
    repoGitDirCanonical = fs.realpathSync.native(repoGitDir);
  } catch {
    /* unresolvable — leave NULL so remove can never fire on a canonical mismatch */
  }

  const classified = classifyWorktrees({
    repoGitDir,
    repoGitDirCanonical,
    gitList: parseWorktreeList(runGit(MAIN, ['worktree', 'list', '--porcelain'])),
    diskDirs: collectDiskDirs(MAIN),
    bundleRecords: collectBundleRecords(MAIN, env),
  });

  const actions = classified.actions.filter((a) => a.action !== 'none');
  // Seed-lock classification: a lock whose recorded owner is dead (or malformed) is
  // sweepable; a live owner is reported as skipped and never touched.
  const lockPath = path.join(MAIN, SEED_LOCK_RELPATH);
  const lock = inspectSeedLock(MAIN);
  const seedLockFindings = [];
  const seedLockSkipped = [];
  let seedLockAction = null;
  if (lock.present) {
    if (lock.malformed || !lock.alive) {
      const reason = lock.malformed ? 'malformed lock' : `dead owner pid ${lock.owner?.pid ?? 'unknown'}`;
      seedLockFindings.push({ kind: 'seed-lock', path: lockPath, action: 'remove', reason });
      seedLockAction = { path: lockPath, action: 'remove', reason };
    } else {
      seedLockFindings.push({ kind: 'seed-lock', path: lockPath, action: 'skip', reason: 'live owner' });
      seedLockSkipped.push({ path: lockPath, action: 'skip', reason: 'live owner', result: 'live-owner' });
    }
  }
  // Report-only: surface forgotten runs (including sub-repo ones) via the shared runs.mjs
  // engine — same derivation and 7-day threshold as the doctor dangling check, no re-derivation.
  // The sweep NEVER auto-resumes; Guard D still owns mutual exclusion. Never let a discovery
  // failure break the sweep report.
  let dangling = [];
  try {
    ({ dangling } = findDanglingRuns({ repoRoot, env }));
  } catch {
    dangling = [];
  }
  if (!apply) {
    return { mode: 'dry-run', actions, executed: [], skipped: seedLockSkipped, findings: [...classified.findings, ...seedLockFindings], dangling };
  }

  const executed = [];
  const skipped = [];
  let pruned = false;
  for (const a of actions) {
    try {
      switch (a.action) {
        case 'repair':
          runGit(MAIN, ['worktree', 'repair', a.path]);
          executed.push({ ...a, result: 'repaired' });
          break;
        case 'remove':
          if (a.registered) {
            runGit(MAIN, ['worktree', 'remove', '--force', a.path]);
          } else {
            // Unregistered leftover: not git's to remove — rm the dir, then prune any
            // dangling admin entries (once per sweep; prune is repo-global).
            fs.rmSync(a.path, { recursive: true, force: true });
            if (!pruned) {
              runGit(MAIN, ['worktree', 'prune']);
              pruned = true;
            }
          }
          executed.push({ ...a, result: 'removed' });
          break;
        case 'prune':
          if (!pruned) {
            runGit(MAIN, ['worktree', 'prune']);
            pruned = true;
          }
          executed.push({ ...a, result: 'pruned' });
          break;
        case 'normalize': {
          // Durable disposition rewrite — the one CD-7 state write in the sweep, routed
          // through the same parse/write pair every other mutation uses.
          const slugs = a.slugs ?? (a.slug ? [a.slug] : []);
          for (const slug of slugs) {
            const statePath = bundleArtifacts(MAIN, slug, env).state;
            writeState(statePath, setWorktreeDisposition(readState(statePath), 'removed_after_merge'));
          }
          executed.push({ ...a, result: 'normalized', slugs });
          break;
        }
        case 'manual':
        default:
          // manual: the classifier refused to prove this safe — a human (or the shell,
          // with the user's say-so) handles it. Never automated, even under --apply.
          skipped.push({ ...a, result: 'manual-never-automated' });
          break;
      }
    } catch (err) {
      skipped.push({ ...a, result: 'error', error: err.message });
    }
  }
  if (seedLockAction) {
    const result = breakSeedLock(MAIN);
    if (result.removed) {
      executed.push({ ...seedLockAction, result: 'removed' });
    } else {
      skipped.push({ ...seedLockAction, result: 'skipped', reason: result.reason });
    }
  }
  skipped.push(...seedLockSkipped);
  return { mode: 'apply', actions, executed, skipped, findings: [...classified.findings, ...seedLockFindings], dangling };
}

export function breakSeedLock(mainRoot) {
  const p = path.join(mainRoot, SEED_LOCK_RELPATH);
  const lock = inspectSeedLock(mainRoot);
  if (!lock.present) return { removed: false, reason: 'not-present' };
  if (lock.malformed || !lock.alive) {
    try {
      fs.unlinkSync(p);
      return { removed: true, reason: lock.malformed ? 'malformed' : 'dead-owner' };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return { removed: false, reason: 'already-gone' };
    }
  }
  return { removed: false, reason: 'live owner' };
}
