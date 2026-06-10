// lib/continue.mjs — the §2 resume/dispatch trampoline, absorbed into code (T2.3).
//
// continueRun is the loop the orchestrator prose used to BE: migrate-on-load, Guard D
// acquire/confirm, wave backfill, the alive probe, the decide loop, worktree create-or-reuse,
// crash-scope reset, and dispatch prep — everything between "the user said continue" and
// "launch the L2 workflow" that does not require LLM judgment. The LLM stops being the
// transaction engine: it calls `mp continue` and executes ONE typed op per call.
//
// Op contract (the full enum the prose's op table documents; continueRun emits the subset
// marked •, the others are shell-originated):
//   • { op:'launch_workflow', workflow:'execute'|'plan', cwd, args?, next? }
//   • { op:'run_skill', skill, ... }       — resume-phase (§3 lifecycle) / finish (§2c)
//   • { op:'ask', ask, ... }               — a genuine human gate or an error needing judgment
//   • { op:'probe', kind:'alive'|'reap', task_id, run_id? } — shell TaskGets/TaskStops, re-calls
//   • { op:'stop', reason, ... }           — wait (live run) / publish_needed / coordinate (§7 prose)
//     { op:'record_result' }               — shell-side: result in hand → `mp record-result` FIRST
//     { op:'shell' } / { op:'dispatch_agent' } — shell-side network/agent ops (never emitted here)
//
// Boundary notes (same seam as wave-commit.mjs, the T2.2 precedent):
//   - LOCAL git only (-C-qualified to MAIN/WT loci derived here): worktree add/list, rev-parse,
//     checkout/clean for crash-scope reset. Network ops (push/gh/codex) stay shell-side.
//   - CD-7: every durable write goes through bundle.mjs (writeState/setActiveRun/setWorktree).
//     No state commit at launch — the §2a prose parity: git commits happen in record-result.
//   - The probe protocol keeps the ONE external fact (TaskGet liveness) in the shell: when the
//     marker has a task_id and the caller passed no --alive/--dead, we return a probe op and the
//     shell re-calls with the answer. `staleReconciled` is the same handshake for orphan reaping.
//   - Guard D is default-on; `mp seed --owner-lock=off` (state.concurrency.owner_lock === 'off')
//     is the seeded escape hatch that skips acquire/heartbeat entirely (single-agent bundles).

import fs from 'node:fs';
import path from 'node:path';

import {
  readState, writeState, setActiveRun, setWorktree, applyPlanIndex,
} from './bundle.mjs';
import { migrate, detectSchemaVersion, MigrationError } from './migrate.mjs';
import { decideNextAction } from './resume.mjs';
import { prepareWave } from './wave.mjs';
import { acquireOwner, heartbeatOwner } from './owner-fs.mjs';
import { planWorktreeCreate, parseWorktreeList, worktreePathFor, worktreeBranchFor } from './worktree.mjs';
import { runGit, captureWtFiles, recordWaveResult } from './wave-commit.mjs';

const MAX_DECIDE_STEPS = 6; // finalize_run is the only loop-continuing action; 6 is generous headroom

export function continueRun({
  statePath,
  self = null,
  now,
  ttlMs,
  alive = null, // null = unknown (caller passed neither --alive nor --dead)
  staleReconciled = false,
  force = false,
  codexSuppressed = false,
  routing,
  review,
  reposAllowlist,
} = {}) {
  if (!statePath) throw new Error('continue: statePath is required');
  const absState = path.resolve(statePath);
  const bundleDir = path.dirname(absState);

  // 1. Migrate-on-load. A legacy (<6) bundle is backed up FIRST, then transformed and written
  //    through the CD-7 writer — the prose's "run migrate-bundle before anything" step. A bundle
  //    migrate refuses (pre-5.0/unparseable) is a human problem, not a loop problem.
  const text = fs.readFileSync(absState, 'utf8');
  const version = detectSchemaVersion(text);
  const major = version ? Number(version.split('.')[0]) : 0;
  let state;
  let migrated = false;
  if (major < 6) {
    const backup = `${absState}.v${version ?? 'unknown'}.bak`;
    fs.copyFileSync(absState, backup);
    try {
      state = migrate(text);
    } catch (e) {
      if (e instanceof MigrationError) {
        return { op: 'ask', ask: 'legacy-refused', error: e.message, backup };
      }
      throw e;
    }
    writeState(absState, state);
    migrated = true;
  } else {
    state = readState(absState);
  }

  // 2. Guard D — acquire then confirm (the §2 step-1.6 pair), default-on. Skipped only under the
  //    seeded escape hatch. `blocked` is a REAL concurrent owner → human gate, never auto-steal
  //    (--force is the explicit user-approved steal, threaded from the verb).
  const ownerLockOff = state.concurrency?.owner_lock === 'off';
  if (!ownerLockOff) {
    if (!self) throw new Error('continue: owner identity required (Guard D is on) — pass self, or seed with --owner-lock=off');
    const acq = acquireOwner(bundleDir, self, { now, force, ttlMs });
    if (acq.outcome === 'blocked') {
      return { op: 'ask', ask: 'owner-blocked', reason: acq.reason, incumbent: acq.incumbent ?? null };
    }
    const hb = heartbeatOwner(bundleDir, self, { now });
    if (hb.outcome !== 'held-by-self') {
      return { op: 'ask', ask: 'owner-lost', reason: hb.reason, incumbent: hb.incumbent ?? null };
    }
  }

  // 3. Wave backfill (migrate.mjs step-2 contract): a just-migrated bundle carries wave:null until
  //    waves are re-derived from plan.index.json. Without this, decideNextAction throws on the
  //    first pending task. Backfill durably; if the plan index can't supply integer waves, the
  //    plan must be rebuilt — a judgment call, so ask.
  const planIndexPath = state.plan_index_path ?? path.join(bundleDir, 'plan.index.json');
  const needsBackfill = (state.tasks ?? []).some(
    (t) => t.status !== 'done' && !Number.isInteger(t.wave)
  );
  if (needsBackfill) {
    let backfilled = null;
    if (fs.existsSync(planIndexPath)) {
      try {
        backfilled = applyPlanIndex(state, JSON.parse(fs.readFileSync(planIndexPath, 'utf8')));
      } catch (e) {
        return { op: 'ask', ask: 'waves-unbackfillable', error: e.message, plan_index: planIndexPath };
      }
    }
    const still = (backfilled?.tasks ?? state.tasks ?? []).some(
      (t) => t.status !== 'done' && !Number.isInteger(t.wave)
    );
    if (!backfilled || still) {
      return {
        op: 'ask',
        ask: 'waves-unbackfillable',
        plan_index: planIndexPath,
        error: backfilled
          ? 'plan.index.json did not supply integer waves for every pending task — rebuild the plan index (merge-plan-fragments)'
          : `plan.index.json not found at ${planIndexPath}`,
      };
    }
    state = backfilled;
    writeState(absState, state);
  }

  // 4. Alive-probe gating: a promoted marker (task_id present) needs the ONE external fact only
  //    the shell can fetch (TaskGet). Unknown → hand back a probe op; the shell re-calls with
  //    --alive/--dead. (Result-in-hand is the OTHER protocol: `mp record-result` BEFORE continue.)
  if (state.active_run?.task_id && alive === null) {
    return {
      op: 'probe',
      kind: 'alive',
      task_id: state.active_run.task_id,
      run_id: state.active_run.run_id ?? null,
    };
  }

  // 5. The decide loop. decideNextAction is pure; this executes the deterministic arms inline
  //    (finalize → reconcile → re-decide) and returns the first op that needs the shell.
  let aliveEff = !!alive;
  for (let step = 0; step < MAX_DECIDE_STEPS; step++) {
    let action;
    try {
      action = decideNextAction(state, { alive: aliveEff });
    } catch (e) {
      return { op: 'ask', ask: 'decide-error', error: e.message };
    }

    switch (action.action) {
      case 'surface_gate':
        return { op: 'ask', ask: 'gate', gate: action.gate, migrated };

      case 'wait':
        return { op: 'stop', reason: 'wait', run: action.run };

      case 'finalize_run': {
        // The crash-reconcile row — recordWaveResult in reconcile mode (result:null) runs the
        // verify → revert → commit → clear tail idempotently, then we re-decide on fresh state.
        const res = recordWaveResult({
          statePath: absState,
          result: null,
          self,
          now,
          worktree: state.worktree ?? undefined,
        });
        if (res.outcome === 'lost-to-other') {
          return { op: 'ask', ask: 'owner-lost', reason: res.reason, incumbent: res.incumbent ?? null };
        }
        state = readState(absState);
        aliveEff = false; // the reconciled run is gone; nothing left to be alive
        continue;
      }

      case 'recover_plan_run': {
        if (action.staleTaskId && !staleReconciled) {
          return { op: 'probe', kind: 'reap', task_id: action.staleTaskId };
        }
        // Re-running the plan fan-out is idempotent (drafters are read-only). Fresh phase-1 marker.
        state = setActiveRun(state, { kind: 'plan', phase: 'launching' });
        writeState(absState, state);
        const MAIN = mainRepoRoot(bundleDir);
        return { op: 'launch_workflow', workflow: 'plan', cwd: MAIN, next: 'promote-active-run' };
      }

      case 'recover_and_redispatch': {
        if (action.staleTaskId && !staleReconciled) {
          return { op: 'probe', kind: 'reap', task_id: action.staleTaskId };
        }
        let wt;
        try {
          wt = ensureWorktree(state, absState, bundleDir);
        } catch (e) {
          return { op: 'ask', ask: 'dispatch-error', error: e.message };
        }
        state = wt.state;
        // F2/Resolved #2: agents never commit, so recovery = reset the incomplete tasks' declared
        // scope in the WT, split by trackedness (checkout errors on untracked paths; clean covers
        // the rest), then re-dispatch — idempotent.
        const resetPaths = action.resetPaths ?? [];
        if (resetPaths.length) {
          const tracked = gitLines(wt.WT, ['ls-files', '--', ...resetPaths]);
          if (tracked.length) runGit(wt.WT, ['checkout', '--', ...tracked]);
          runGit(wt.WT, ['clean', '-fd', '--', ...resetPaths]);
        }
        return dispatchWave(state, absState, planIndexPath, action.wave, wt, {
          codexSuppressed, routing, review, reposAllowlist,
        });
      }

      case 'dispatch_wave': {
        let wt;
        try {
          wt = ensureWorktree(state, absState, bundleDir);
        } catch (e) {
          return { op: 'ask', ask: 'dispatch-error', error: e.message };
        }
        state = wt.state;
        return dispatchWave(state, absState, planIndexPath, action.wave, wt, {
          codexSuppressed, routing, review, reposAllowlist,
        });
      }

      // §7 coordination stays prose (IMPLEMENTED-UNVERIFIED) — halt with the decide facts.
      case 'publish_needed':
        return { op: 'stop', reason: 'publish_needed', wave: action.wave, tasks: action.tasks };
      case 'coordinate':
        return { op: 'stop', reason: 'coordinate', wave: action.wave };

      case 'resume_phase':
        return { op: 'run_skill', skill: 'resume-phase', phase: action.phase, planning_mode: action.planning_mode, migrated };

      case 'complete':
        // §2c finish flow stays prose until T2.4 (`mp finish-step`).
        return { op: 'run_skill', skill: 'finish' };

      default:
        return { op: 'ask', ask: 'decide-error', error: `unknown decide action '${action.action}'` };
    }
  }
  return { op: 'ask', ask: 'decide-error', error: `decide loop exceeded ${MAX_DECIDE_STEPS} steps without producing an op — state may be cycling` };
}

// ---- helpers -------------------------------------------------------------------

function gitLines(dir, args) {
  const out = runGit(dir, args);
  return out ? out.split('\n').filter(Boolean) : [];
}

// MAIN = the primary checkout, derived from the bundle's repo (same derivation as wave-commit).
function mainRepoRoot(bundleDir) {
  return path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

// Create-or-reuse (the §2e¶1-5 prose, now code): planWorktreeCreate decides, we run the emitted
// git, and the outcome is recorded durably via setWorktree. A recorded-but-reaped dir re-plans
// with existing:null so the branch-preserving `worktree add <path> <branch>` form fires.
function ensureWorktree(state, absState, bundleDir) {
  const MAIN = mainRepoRoot(bundleDir);
  const slug = String(state.slug ?? '').trim();
  if (!slug) throw new Error('continue: state has no slug — cannot derive the worktree locus');
  const branch = worktreeBranchFor(slug);
  const canonical = worktreePathFor(MAIN, slug);
  let branchExists = true;
  try {
    runGit(MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    branchExists = false;
  }
  const registered = parseWorktreeList(runGit(MAIN, ['worktree', 'list', '--porcelain']))
    .some((w) => path.resolve(w.path) === canonical);
  let plan = planWorktreeCreate({
    slug, repoRoot: MAIN, branch, existing: state.worktree ?? null, branchExists, registered,
  });
  if (plan.action === 'reuse' && !fs.existsSync(plan.path)) {
    // Recorded (or registered) but gone from disk: a reaped dir. Prune the dangling admin entry
    // and re-plan as a fresh create on the surviving branch.
    runGit(MAIN, ['worktree', 'prune']);
    plan = planWorktreeCreate({ slug, repoRoot: MAIN, branch, existing: null, branchExists, registered: false });
  }
  if (plan.action === 'create') {
    runGit(MAIN, plan.gitArgs);
  }
  let nextState = state;
  if (state.worktree !== plan.path) {
    nextState = setWorktree(state, plan.path);
    writeState(absState, nextState);
  }
  return { MAIN, WT: plan.path, state: nextState };
}

// Dispatch prep (the §2a-launch prose, now code): prepareWave resolves routing + the immutable
// F-SCOPE allow-set, the D6 baseline is captured pre-launch, and the phase-1 launching marker is
// written BEFORE the launch op is returned (the two-phase marker's whole point). NO state commit
// here — git commits happen in record-result (§2a parity).
function dispatchWave(state, absState, planIndexPath, wave, wt, opts) {
  if (!fs.existsSync(planIndexPath)) {
    return { op: 'ask', ask: 'dispatch-error', error: `plan.index.json not found at ${planIndexPath} — cannot resolve routing/descriptions` };
  }
  let planIndex;
  try {
    planIndex = JSON.parse(fs.readFileSync(planIndexPath, 'utf8'));
  } catch (e) {
    return { op: 'ask', ask: 'dispatch-error', error: `plan.index.json unreadable: ${e.message}` };
  }
  const config = {
    routing: state.codex?.routing ?? opts.routing ?? 'auto',
    implementer: state.implementer ?? {},
  };
  const env = { codexHostSuppressed: !!opts.codexSuppressed, linkedWorktree: true };
  let prepared;
  try {
    prepared = prepareWave(state, planIndex, wave, config, env, opts.reposAllowlist);
  } catch (e) {
    return { op: 'ask', ask: 'dispatch-error', error: e.message };
  }
  const rawReview = state.codex?.review ?? opts.review;
  const reviewMode = rawReview === true || rawReview === 'on' || rawReview === 'true' ? 'on' : 'off';
  const baseline = captureWtFiles(wt.WT);
  const next = setActiveRun(state, { wave, phase: 'launching', scope: prepared.scope, baseline });
  writeState(absState, next);
  return {
    op: 'launch_workflow',
    workflow: 'execute',
    cwd: wt.WT,
    args: { wave, tasks: prepared.tasks, baseline, repoRoot: wt.WT, review: reviewMode },
    next: 'promote-active-run',
  };
}
