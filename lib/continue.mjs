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
//   • { op:'dispatch_fabric', wave, cwd, tasks, baseline, review, next }
//   • { op:'dispatch_fanout', kind:'plan', cwd, class, read_only, roots, spec_path, next } —
//     the broker planning fan-out (replaced the L2 plan Workflow launch); consumed by
//     `mp dispatch-plan`, whose fragments the shell stages as .plan-fragments.json
//   • { op:'run_skill', skill, ... }       — resume-phase (§3 lifecycle) / finish (§2c)
//   • { op:'ask', ask, ... }               — a genuine human gate or an error needing judgment
//   • { op:'probe', kind:'alive'|'reap', task_id, run_id? } — shell TaskGets/TaskStops, re-calls
//   • { op:'stop', reason, ... }           — wait (live run) / publish_needed / coordinate (§7 prose)
//   • { op:'dispatch_fabric', wave, cwd, tasks, baseline, review, next } — codexSuppressed only:
//     the Residual-3B path; the host runs the routed tasks sequentially in-session, then feeds the
//     standard result shape to `mp record-result` (no background task, no promote, no probe)
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
  readState, writeState, setActiveRun, clearActiveRun, setWorktree, applyPlanIndex,
} from './bundle.mjs';
import { migrate, detectSchemaVersion, MigrationError } from './migrate.mjs';
import { decideNextAction, classifyLegacyMarker } from './resume.mjs';
import { prepareWave } from './wave.mjs';
import { acquireOwner, heartbeatOwner } from './owner-fs.mjs';
import { planWorktreeCreate, parseWorktreeList, worktreePathFor, worktreeBranchFor } from './worktree.mjs';
import { runGit, captureWtFiles, captureWorkspaceRoot, recordWaveResult } from './wave-commit.mjs';
import { captureMultiRepoFiles } from './dispatch/multi-repo.mjs';
import { normalizeReviewMode, buildWaveDispatchOp } from './dispatch/index.mjs';
import { buildPlanFanoutOp, PLAN_FANOUT_CLASS } from './dispatch/ops.mjs';
import { CONTRACT_VERSION, createBrokerClient } from './dispatch/adsp-adapter.mjs';
import { openWaveCoord } from './dispatch/adsp-coord.mjs';
import { goalsHash } from './goals.mjs';

const MAX_DECIDE_STEPS = 6; // finalize_run is the only loop-continuing action; 6 is generous headroom

// Recovery guidance for a legacy marker the fabric lane cannot auto-convert (surfaced on
// the explicit `legacy-marker-unreconcilable` ask — never a crash, never silent).
const LEGACY_MARKER_GUIDANCE =
  'This bundle carries a pre-fabric active_run marker that cannot be auto-converted. Recover manually: '
  + '(1) inspect the marker and the worktree (`git -C <worktree> status`) for stranded work — commit or reset it deliberately; '
  + "(2) if the wave's results were already recorded, clear the stale marker with `mp clear-active-run --state=<state.yml>` and re-run `mp continue`; "
  + '(3) if tasks/waves are missing, rebuild them (`mp seed-tasks`, `mp backfill-waves` from plan.index.json) before continuing. '
  + 'Never hand-edit the marker into a promoted shape.';

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
  fabricDispatch = false, // strangler phase flag: gates the single L1->fabric dispatch op (rollback is a flag flip)
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

  // 1b. Split-brain goals guard (spec §5 "Hard block on split-brain"). On a goals_enabled bundle,
  //     any transition recomputes the goals.md hash and HARD-ERRORS when it diverges from the last
  //     goals_frozen/goal_amended event — a thrown Error is surfaced by the `continue` verb as a
  //     non-zero exit with the reconcile message. Pre-feature bundles (no goals_enabled) are exempt;
  //     a goals_enabled bundle with NO goal-lifecycle event yet is a NO-OP (the pre-capture window
  //     the run_goals_capture gate — not this guard — owns).
  assertGoalsNotSplitBrain(state, bundleDir);

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

  // 3b. Legacy active_run marker reconciliation (fabric lane only). Pre-fabric bundles
  //     persisted L2 marker shapes — the launch_workflow execute/plan kinds: phase-1
  //     {phase:'launching'} markers and PROMOTED probe/reap-expected {run_id, task_id}
  //     markers whose handles reference the retired L2 Workflow registry. The fabric path
  //     has no probe machinery, so reconcile here: auto-convert to the equivalent fabric op
  //     where state.tasks + the (already backfilled) plan wave data re-derive the wave, else
  //     surface an explicit `legacy-marker-unreconcilable` ask with recovery guidance —
  //     never a crash, never silent. Gated on the fabric lane so the legacy L2 path stays
  //     byte-identical; an explicit --alive=true defers (a run the caller asserts is live is
  //     never yanked); an open gate wins (decide's rule 1) — the marker is left for later.
  //     Successful conversions annotate the returned op with `reconciled`.
  const fabricActive = true; // L2 deleted: fabric is the only wave path
  let staleReconciledEff = staleReconciled;
  let reconciledLegacy = null;
  // An OPEN GATE wins on the fabric lane too (adversary review P1): the reconcile below
  // already defers to it, but the unconditional promoted-marker probe (step 4) would
  // otherwise still fire for a stale L2 handle before the gate re-renders. When a gate is
  // pending and the marker classifies as a legacy shape, skip that probe and let decide
  // re-render the gate (its rule 1) — the marker is left untouched for a later continue.
  const legacyGateSkip = fabricActive && !!state.pending_gate
    && classifyLegacyMarker(state.active_run) !== null;
  if (fabricActive && state.active_run && alive !== true && !state.pending_gate) {
    const marker = state.active_run;
    const legacy = classifyLegacyMarker(marker);
    const unreconcilable = (reason) => ({
      op: 'ask',
      ask: 'legacy-marker-unreconcilable',
      marker,
      error: reason,
      guidance: LEGACY_MARKER_GUIDANCE,
    });
    if (legacy?.legacy === 'unrecognized') {
      return unreconcilable(
        `active_run has an unrecognized legacy shape (${JSON.stringify(marker)}) — neither a plan marker nor an integer-wave execute marker`
      );
    }
    if (legacy?.legacy === 'plan-promoted') {
      // A promoted pre-fabric plan run converts IMMEDIATELY — no reap handshake, unlike the
      // execute-promoted branch below. Rationale: plan drafters are READ-ONLY and idempotent,
      // so a zombie plan Workflow that outlived its session cannot dirty any file scope, and
      // its eventual completion lands in a dead session harmlessly. Treat the run as dead &
      // already reconciled — decide recovers straight to the fan-out op.
      staleReconciledEff = true;
      reconciledLegacy = { legacy: legacy.legacy, marker, conversion: 'plan-fanout' };
    } else if (legacy?.legacy === 'execute-promoted' || legacy?.legacy === 'execute-launching') {
      if (!Number.isInteger(marker.wave)) {
        return unreconcilable(
          `active_run.wave is not an integer (${JSON.stringify(marker.wave)}) — the wave cannot be re-derived`
        );
      }
      const waveTasks = (state.tasks ?? []).filter((t) => t.wave === marker.wave);
      if (waveTasks.length === 0) {
        return unreconcilable(
          `active_run.wave ${marker.wave} matches no task in state.tasks — the wave cannot be re-derived from state.tasks + plan.index.json`
        );
      }
      const incomplete = waveTasks.filter(
        (t) => t.status !== 'done' && t.status !== 'blocked' && t.status !== 'waived'
      );
      // Fabric path has NO probe/reap machinery (L2 Workflow registry is gone). A promoted
      // execute marker with unknown liveness is treated as dead & already reaped: convert
      // straight to redispatch/finalize. Explicit --alive=true is gated above (this whole
      // block only runs when alive !== true) so a caller-asserted live run still waits.
      if (incomplete.length === 0) {
        // The marker's wave already completed on disk — a stale marker stranded between
        // record and clear. Reconcile inline (the finalize_run row: verify → revert →
        // commit → clear, idempotent), then fall through to a fresh decide.
        try {
          const wt = ensureWorktree(state, absState, bundleDir);
          state = wt.state;
          const res = recordWaveResult({ statePath: absState, result: null, self, now, worktree: wt.WT });
          if (res.outcome === 'lost-to-other') {
            return { op: 'ask', ask: 'owner-lost', reason: res.reason, incumbent: res.incumbent ?? null };
          }
        } catch (e) {
          return unreconcilable(`inline finalize of the stale legacy marker failed: ${e.message}`);
        }
        state = readState(absState);
        if (state.active_run) {
          return unreconcilable(
            `the stale legacy marker for wave ${marker.wave} did not clear after finalize — its wave has blocked/waived tasks needing a waiver decision, or the reconcile could not complete`
          );
        }
        reconciledLegacy = { legacy: legacy.legacy, marker, conversion: 'finalize' };
      } else {
        // Dead legacy run with outstanding work: no L2 probe/reap exists on the fabric path,
        // so the handles are treated as dead & already reaped — decide recovers (scope reset
        // + re-dispatch) straight to the fabric wave op.
        staleReconciledEff = true;
        reconciledLegacy = { legacy: legacy.legacy, marker, conversion: 'redispatch' };
      }
    }
    // 'plan-launching' needs no conversion: recover_plan_run already emits the fabric
    // planning fan-out op (dispatch_fanout) for phase-1 plan markers.
  }

  // 4. Alive-probe gating: a promoted marker (task_id present) needs the ONE external fact only
  //    the shell can fetch (TaskGet). Unknown → hand back a probe op; the shell re-calls with
  //    --alive/--dead. (Result-in-hand is the OTHER protocol: `mp record-result` BEFORE continue.)
  if (state.active_run?.task_id && alive === null && !reconciledLegacy && !legacyGateSkip) {
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
  // A reconciled legacy conversion is visible on the op it produced (never silent).
  const annotate = (op) => (reconciledLegacy && op && typeof op === 'object' ? { ...op, reconciled: reconciledLegacy } : op);
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
        if (action.staleTaskId && !staleReconciledEff) {
          return { op: 'probe', kind: 'reap', task_id: action.staleTaskId };
        }
        if (codexSuppressed) {
          // A suppressed host has no Workflow tool, so the parallel fan-out can't relaunch
          // (this marker exists here only via cross-host resume of a CC-launched plan run).
          // Planning is fully re-derivable — the drafters are read-only and wrote no
          // artifacts — so drop the marker and route §3a's SERIAL path instead (Codex r6 P2).
          state = clearActiveRun(state);
          writeState(absState, state);
          return annotate({ op: 'run_skill', skill: 'resume-phase', phase: 'plan', planning_mode: 'serial', migrated });
        }
        // Re-running the plan fan-out is idempotent (drafters are read-only). Fresh phase-1 marker,
        // written BEFORE the dispatch op is returned (crash in the gap resumes as recovery).
        state = setActiveRun(state, { kind: 'plan', phase: 'launching' });
        writeState(absState, state);
        const MAIN = mainRepoRoot(bundleDir);
        // The broker planning fan-out replaced the L2 plan Workflow launch: ONE op, consumed by
        // the deterministic `mp dispatch-plan` — READ-ONLY capability class, explicitly enumerated
        // roots (repo + spec). The shell stages the returned fragments as .plan-fragments.json
        // exactly as before; the merge/validate/review gate sequence is unchanged.
        return annotate(buildPlanFanoutOp({ cwd: MAIN, specPath: resolveSpecPath(state, bundleDir) }));
      }

      case 'recover_wave': {
        if (action.staleTaskId && !staleReconciledEff) {
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
          // Partition by owning git repo so a wave whose declared scope MIXES the run's
          // worktree with EXTERNAL repos (absolute paths under another checkout) resets each
          // repo with its own `git -C` — a single worktree-rooted `git ls-files` rejects
          // external absolute paths as "outside the repository". Scoped per repo: checkout
          // tracked + clean untracked, bounded to the declared paths; never broad reset/clean.
          const groups = new Map();
          for (const raw of resetPaths) {
            const { repoRoot, rel } = repoGroupForResetPath(raw, wt.WT);
            if (!groups.has(repoRoot)) groups.set(repoRoot, []);
            groups.get(repoRoot).push(rel);
          }
          for (const [repoRoot, rels] of groups) {
            const tracked = gitLines(repoRoot, ['ls-files', '--', ...rels]);
            if (tracked.length) runGit(repoRoot, ['checkout', '--', ...tracked]);
            runGit(repoRoot, ['clean', '-fd', '--', ...rels]);
          }
        }
        return annotate(dispatchWave(state, absState, planIndexPath, action.wave, wt, {
          codexSuppressed, routing, review, reposAllowlist, fabricDispatch,
        }));
      }

      case 'dispatch_wave': {
        let wt;
        try {
          wt = ensureWorktree(state, absState, bundleDir);
        } catch (e) {
          return { op: 'ask', ask: 'dispatch-error', error: e.message };
        }
        state = wt.state;
        return annotate(dispatchWave(state, absState, planIndexPath, action.wave, wt, {
          codexSuppressed, routing, review, reposAllowlist, fabricDispatch,
        }));
      }

      // §7 coordination stays prose (IMPLEMENTED-UNVERIFIED) — halt with the decide facts.
      case 'publish_needed':
        return { op: 'stop', reason: 'publish_needed', wave: action.wave, tasks: action.tasks };
      case 'coordinate':
        return { op: 'stop', reason: 'coordinate', wave: action.wave };

      case 'resume_phase': {
        // A suppressed host can't run the plan fan-out (no Workflow tool) — force the §3a
        // serial path so `auto`/`parallel` seeds never dead-end under Codex (Codex r6 P2).
        const planningMode = (codexSuppressed && action.phase === 'plan')
          ? 'serial' : action.planning_mode;
        return { op: 'run_skill', skill: 'resume-phase', phase: action.phase, planning_mode: planningMode, migrated };
      }

      case 'complete':
        // The shell enters the §2c finish loop: `mp finish-step` (lib/finish-step.mjs, T2.4)
        // — itself a trampoline returning one op per call.
        return annotate({ op: 'run_skill', skill: 'finish' });

      case 'awaiting_waiver':
        // The only remaining work is blocked tasks (decideNextAction's awaiting_waiver arm — task 1).
        // Surface the blockers as a human gate: waive-all / waive-one / keep — never auto-waive.
        return { op: 'ask', ask: 'awaiting_waiver', blockers: action.blockers };

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

// Partition a crash-scope reset path to its owning git repo, returning { repoRoot, rel }.
// Relative paths resolve against the run's worktree root; an absolute path OUTSIDE the
// worktree (an external-repo task, e.g. /srv/dev/ras/masterplan/lib/resume.mjs) is rooted
// via its nearest existing ancestor + `git rev-parse --show-toplevel` so a not-yet-created
// file still resolves to its repo. Throws on any path not inside a git repo — never
// silently skips — so a mis-scope surfaces as a loud invariant instead of a partial reset.
function repoGroupForResetPath(raw, wtAbs) {
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(wtAbs, raw);
  if (abs === wtAbs || abs.startsWith(wtAbs + path.sep)) {
    return { repoRoot: wtAbs, rel: path.relative(wtAbs, abs) };
  }
  let anchor = abs;
  while (anchor && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
  if (anchor && !fs.statSync(anchor).isDirectory()) anchor = path.dirname(anchor);
  if (!anchor || !fs.existsSync(anchor) || !fs.statSync(anchor).isDirectory()) {
    throw new Error(`recover_wave: reset path ${raw} has no existing directory to anchor git`);
  }
  let repoRoot;
  try {
    repoRoot = runGit(anchor, ['rev-parse', '--show-toplevel']);
  } catch (e) {
    throw new Error(`recover_wave: reset path ${raw} is not inside a git repo (${e.message})`);
  }
  if (!repoRoot || !path.isAbsolute(repoRoot)) {
    throw new Error(`recover_wave: reset path ${raw} did not resolve to a git repo (got ${repoRoot})`);
  }
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`recover_wave: reset path ${raw} resolves outside repo ${repoRoot} (rel ${rel})`);
  }
  return { repoRoot, rel };
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
  const reviewMode = normalizeReviewMode(state.review?.adversary ?? state.codex?.review ?? opts.review);
  // Multi-repo baseline: umbrella-relative paths covering the run worktree AND any
  // sibling git checkouts referenced by the wave's declared scope (yanos-os/..., …).
  // Plain captureWtFiles(WT) misses sibling dirt and makes post-wave F-SCOPE blind.
  const mainRoot = (() => {
    try {
      return path.dirname(runGit(wt.WT, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    } catch {
      return path.resolve(wt.WT, '..', '..');
    }
  })();
  const baseline = captureMultiRepoFiles(prepared.scope, {
    worktree: wt.WT,
    mainRoot,
    slug: String(state.slug ?? ''),
    captureWtFiles,
  });
  // Capture workspace root entries for post-wave drift detection.
  // Only active when the worktree is under /srv/dev (the known workspace root).
  const wsRoot = path.resolve(wt.WT, '../..'); // /srv/dev/yanos-project/.worktrees/slug -> /srv/dev
  const wsBaseline = /^\/srv\/dev$/.test(wsRoot) ? captureWorkspaceRoot(wsRoot) : null;
  // The strangler phase flag (state.dispatch.fabric / --fabric-dispatch) — resolved ONCE here:
  // it gates BOTH the coord ownership below and the dispatch_fabric op emitted at the tail.
  const fabric = true; // L2 deleted: always emit dispatch_fabric
  // T11: open a coord job for multi-task waves (fail-open); attach per-task coord context
  // (root/jobId/agentId) so wave workers can exchange messages via dispatch_coord_* (arg-based
  // — no L1 env-threading needed; the context rides on the task payload into the worker brief).
  // The job is closed best-effort in `mp record-result` (reads active_run.coordJobId).
  // FABRIC waves skip this open: `mp dispatch-wave` OWNS the coord lifecycle there (open →
  // attach → close in a finally, paired even on dispatch failure — the leaked-open-jobs fix);
  // opening here too would double-open the job and leak it whenever record-result never runs.
  let coordJobId = null;
  let tasks = prepared.tasks;
  if (!fabric) {
    try {
      const coordHandle = openWaveCoord({ wave, tasks, goal: `wave ${wave}` });
      if (coordHandle.enabled) {
        tasks = tasks.map((t, i) => coordHandle.attachToTask(t, i));
        coordJobId = coordHandle.jobId;
      }
    } catch { /* fail-open: coord never blocks wave dispatch */ }
  }
  const next = setActiveRun(state, {
    wave, phase: 'launching', scope: prepared.scope, baseline,
    ...(coordJobId ? { coordJobId } : {}),
    ...(wsBaseline ? { wsBaseline } : {}),
  });
  writeState(absState, next);
  // Layer-4 host-identity provenance (execute.workflow.js reviewerPrompt + agents/
  // mp-adversarial-reviewer.md): probe THIS (orchestrator) host's machine-id and the WT's repo
  // HEAD here — the single dispatch point, on the orchestrator host — and hand them to the L2
  // launch so a reviewer that lands on a divergent/stale peer (observed live 2026-07-08: a
  // subagent executed on an off-mesh host whose /srv/dev differed, silently reviewing the WRONG
  // bytes) must PROVE it shares our filesystem before any local git. Fail-open: a failed probe
  // passes null → the reviewer runs the legacy unguarded path (status quo, never worse).
  let orchestratorHost = null;
  try { orchestratorHost = fs.readFileSync('/etc/machine-id', 'utf8').trim() || null; } catch { /* fail-open */ }
  let orchestratorHead = null;
  try { orchestratorHead = runGit(wt.WT, ['rev-parse', 'HEAD']) || null; } catch { /* fail-open */ }
  // The dispatch-vehicle fork (background L2 workflow vs the Residual-3B foreground-sequential
  // path on a suppressed host) lives in lib/dispatch/ops.mjs — see buildWaveDispatchOp's header.
  return buildWaveDispatchOp({
    wave,
    cwd: wt.WT,
    tasks,
    baseline,
    review: reviewMode,
    codexSuppressed: !!opts.codexSuppressed,
    fabric,
    orchestratorHost,
    orchestratorHead,
  });
}

// ---- goals split-brain guard ---------------------------------------------------
// Spec §5: any transition on a goals_enabled bundle recomputes the goals.md hash and throws when it
// diverges from the LAST goals_frozen/goal_amended event. Exempt: pre-feature bundles (no
// goals_enabled). No-op: a goals_enabled bundle with no goal-lifecycle event yet (pre-capture window).
function assertGoalsNotSplitBrain(state, bundleDir) {
  if (state?.goals_enabled !== true) return; // pre-feature bundle — exempt
  const frozen = lastFrozenGoalsHash(bundleDir);
  if (frozen === null) return; // no goals_frozen/goal_amended yet — run_goals_capture owns this window
  let goalsMd = null;
  try {
    goalsMd = fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8');
  } catch {
    goalsMd = null;
  }
  const current = goalsMd === null ? null : goalsHash(goalsMd);
  if (current !== frozen) {
    throw new Error(
      `goals split-brain: goals.md hash ${current ?? '(goals.md missing)'} != last frozen/amended `
      + `event hash ${frozen} — re-run \`mp goals-amend\` to record the change (with user approval) `
      + `or restore goals.md, then continue.`
    );
  }
}

// Scan events.jsonl for the LAST goals_frozen / goal_amended event and return its recorded goals
// hash. goal_amended records old->new, so the NEW hash is authoritative. Returns null when no such
// event exists (or events.jsonl is absent). Tolerates both flat and data-nested event shapes.
function lastFrozenGoalsHash(bundleDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8');
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    const type = rec?.type;
    if (type !== 'goals_frozen' && type !== 'goal_amended') continue;
    const d = rec.data && typeof rec.data === 'object' ? rec.data : rec;
    const hash = type === 'goal_amended'
      ? (d.new_hash ?? d.new_goals_hash ?? d.goals_hash ?? d.hash)
      : (d.goals_hash ?? d.hash);
    if (typeof hash === 'string' && hash) last = hash;
  }
  return last;
}

// ---- the broker planning fan-out (`mp dispatch-plan`, the dispatch_fanout(plan) consumer) ----
//
// Replaces workflows/plan.workflow.js as the parallel-planning vehicle: one READ-ONLY
// subsystem-planner work item per subsystem, ONE broker process for the whole fan-out
// (dispatch_fanout, fail_mode:'isolated'), fragments returned as STRUCTURED PAYLOADS for
// the shell to stage as .plan-fragments.json exactly as the L2 engine's result was staged
// (the merge/validate/review gate sequence is unchanged, and L1 stays the single durable
// writer — this executor writes NO state and NO artifacts).
//
// Read-only enforcement is layered:
//   1. CAPABILITY (broker-level, where supported): every work item declares the
//      PLAN_FANOUT_CLASS read-only class, read_only:true, and the explicitly enumerated
//      accessible roots (repo + spec path) — and carries NO write-scope fields
//      (files/repo/worktree), which the broker's descriptor validator rejects on
//      read-only lanes. A drafter that attempts a write is denied broker-side; the
//      denial is SURFACED per subsystem (never faked into a fragment).
//   2. DEFENSE IN DEPTH (here): `git status --porcelain` is snapshotted over the
//      enumerated roots BEFORE the fan-out and re-asserted AFTER it; any drift is a
//      loud throw — the breach surfaces INSTEAD of fragments being returned for staging.
//
// Crash semantics mirror the plan run's existing contract: the phase-1 plan marker is
// written BEFORE dispatch (by `mp continue` / set-active-run --kind=plan), re-entry is
// idempotent (drafters are read-only; re-running the fan-out re-derives everything), and
// a missing fragment is surfaced in `missing` for the shell's coverage reconcile — never
// silently dropped, never faked.
export async function dispatchPlanFanout({
  statePath,
  subsystems,
  specPath = null,
  brokerBin,
  _brokerClient = null, // injectable MCP client (tests; initialize/close are NOT called on it)
} = {}) {
  if (!statePath) throw new Error('dispatch-plan: statePath is required');
  const absState = path.resolve(statePath);
  const bundleDir = path.dirname(absState);
  const state = readState(absState);

  // 1. The phase-1 plan marker gate — written BEFORE dispatch so a crash in the gap
  //    resumes as recovery (`mp continue` re-emits the planning op), never a blind re-dispatch.
  if (state.active_run?.kind !== 'plan') {
    throw new Error('dispatch-plan: active_run is not a plan marker — run `mp continue` first (it writes the plan launching marker this command consumes)');
  }

  // 2. The decomposition is caller-resolved judgment (the same L1<->engine seam the L2
  //    workflow had): this executor only fans out one drafter per already-decided subsystem.
  if (!Array.isArray(subsystems) || subsystems.length === 0) {
    throw new Error('dispatch-plan: a non-empty subsystems decomposition is required (re-dispatch mp-spec-decomposer first)');
  }
  for (const s of subsystems) {
    if (!s || typeof s.key !== 'string' || !s.key) {
      throw new Error('dispatch-plan: every subsystem needs a non-empty string key');
    }
  }

  // 3. Explicitly enumerated accessible roots: the repo (MAIN) + the spec path.
  const MAIN = mainRepoRoot(bundleDir);
  const spec = path.resolve(specPath ?? resolveSpecPath(state, bundleDir));
  const roots = [...new Set([MAIN, spec])];

  // 4. Pre-fan-out porcelain snapshot (defense-in-depth layer 2).
  const pre = snapshotRootsPorcelain(roots);

  // 5. One READ-ONLY work item per subsystem — no write-scope fields, ever.
  const descriptors = subsystems.map((s) => buildPlanWorkItem(s, { roots, specPath: spec, repoRoot: MAIN }));

  // 6. ONE broker process for the whole fan-out (the dispatch-wave precedent).
  const usingInjected = _brokerClient != null;
  const client = usingInjected ? _brokerClient : createBrokerClient({ bin: brokerBin });
  let results;
  try {
    if (!usingInjected) await client.initialize();
    // MCP dispatch_fanout retired (2026-07-17): bounded concurrent dispatch_task pool.
    const concurrency = Math.max(1, Math.min(
      Number(process.env.MP_DISPATCH_WAVE_CONCURRENCY) || 8,
      descriptors.length || 1,
    ));
    results = new Array(descriptors.length);
    let nextIdx = 0;
    async function worker() {
      for (;;) {
        const i = nextIdx++;
        if (i >= descriptors.length) return;
        try {
          results[i] = await client.callTool('dispatch_task', { descriptor: descriptors[i] });
        } catch (err) {
          results[i] = { error: err?.message ?? String(err) };
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, Math.max(descriptors.length, 1)) },
      () => worker(),
    ));
  } finally {
    if (!usingInjected) {
      try { client.close(); } catch { /* teardown is best-effort */ }
    }
  }

  // 7. POST-fan-out porcelain assertion BEFORE any fragment is surfaced: a dirtied
  //    enumerated root means a drafter wrote — surface the breach INSTEAD of fragments.
  const breaches = diffRootsPorcelain(pre, snapshotRootsPorcelain(roots));
  if (breaches.length) {
    throw new Error(
      'dispatch-plan: READ-ONLY BREACH — the planning fan-out dirtied enumerated root(s) (drafters must never write):\n'
      + breaches.join('\n')
      + '\nfragments NOT staged; inspect and reset the roots before re-running',
    );
  }

  // 8. Per-item results -> fragments / denied / missing (surfaced, never faked).
  const fragments = [];
  const denied = [];
  const missing = [];
  subsystems.forEach((s, i) => {
    const c = classifyPlanResult(results[i] ?? null);
    if (c.kind === 'fragment') {
      if (c.fragment.key === s.key) fragments.push(c.fragment);
      else missing.push({ key: s.key, reason: `drafter returned fragment key '${c.fragment.key}' for subsystem '${s.key}'` });
    } else if (c.kind === 'denied') {
      denied.push({ key: s.key, reason: c.reason });
    } else {
      missing.push({ key: s.key, reason: c.reason });
    }
  });

  // The SAME result shape the L2 plan engine returned ({subsystems, specPath, repoRoot})
  // plus the explicit denial/coverage surfacing — the shell stages `subsystems` as
  // .plan-fragments.json exactly as today and reconciles `requested` vs returned keys.
  return {
    outcome: denied.length || missing.length ? 'incomplete' : 'complete',
    kind: 'plan',
    subsystems: fragments,
    specPath: spec,
    repoRoot: MAIN,
    requested: subsystems.map((s) => s.key),
    roots,
    denied,
    missing,
  };
}

// The bundle's spec path (absolute in v8 state; tolerate relative by resolving against
// the bundle dir), defaulting to the conventional spec.md beside state.yml.
function resolveSpecPath(state, bundleDir) {
  return state.spec_path ? path.resolve(bundleDir, state.spec_path) : path.join(bundleDir, 'spec.md');
}

// ONE read-only planning work item (dispatch_fanout descriptor). Deliberately carries NO
// write-scope fields (files/repo/worktree): the broker's descriptor validator rejects
// write scope on read-only lanes, so their absence IS the capability declaration; the
// enumerated roots ride on the descriptor for broker/OS-level read confinement where
// supported. Mirrors plan.workflow.js's drafterPrompt contract so fragments merge identically.
function buildPlanWorkItem(s, { roots, specPath, repoRoot }) {
  const brief = [
    `Draft the plan FRAGMENT for the "${s.key}" subsystem of this build.`,
    `READ-ONLY: your accessible roots are ${roots.join(', ')} (the repo ${repoRoot} + the spec ${specPath}).`,
    `Read for context; do NOT write, edit, run mutating commands, or commit — the dispatch class denies writes.`,
    ``,
    `Subsystem: ${s.title ?? s.key}`,
    `Scope / responsibility: ${s.description ?? '(see the spec)'}`,
    s.spec_refs?.length ? `Relevant spec sections: ${s.spec_refs.join(', ')}` : `Spec: ${specPath}`,
    s.files_hint?.length ? `Likely files in this subsystem: ${s.files_hint.join(', ')}` : ``,
    ``,
    `Return ONLY a JSON fragment: { "key": "${s.key}", "tasks": [ { key, description, files, verify_commands, deps?, codex?, spec_refs? } ] }.`,
    `Task keys must be UNIQUE across the whole plan — prefix them with the subsystem (e.g. "${s.key}.<short-name>").`,
    `Use deps for ordering; do NOT assign global ids or waves — those are computed deterministically after merge.`,
    `Same-wave parallelism is derived from file-disjointness, so keep each task's file set tight and declare deps wherever two tasks must touch the same file.`,
  ].filter(Boolean).join('\n');
  return {
    class: PLAN_FANOUT_CLASS,
    read_only: true,
    roots,
    subsystem: s.key,
    brief,
    task: brief, // broker-required brief alias (validateDispatchDescriptor)
    contract_version: CONTRACT_VERSION,
  };
}

// Porcelain snapshot over the enumerated roots, grouped by owning git repo. Fail-closed:
// a root outside any git repo cannot be asserted read-only, so it throws rather than
// silently narrowing the defense-in-depth check.
function snapshotRootsPorcelain(roots) {
  const snap = new Map();
  for (const raw of roots) {
    const abs = path.resolve(raw);
    let anchor = abs;
    while (anchor && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
    if (fs.existsSync(anchor) && !fs.statSync(anchor).isDirectory()) anchor = path.dirname(anchor);
    let repoRoot;
    try {
      repoRoot = runGit(anchor, ['rev-parse', '--show-toplevel']);
    } catch (e) {
      throw new Error(`dispatch-plan: enumerated root ${raw} is not inside a git repo (${e.message}) — the read-only porcelain assertion needs a git locus`);
    }
    if (!snap.has(repoRoot)) snap.set(repoRoot, runGit(repoRoot, ['status', '--porcelain']));
  }
  return snap;
}

// Diff two porcelain snapshots; returns human-readable breach lines (empty = clean).
function diffRootsPorcelain(pre, post) {
  const breaches = [];
  for (const [repoRoot, before] of pre) {
    const after = post.get(repoRoot) ?? '';
    if (after === before) continue;
    const beforeSet = new Set(before.split('\n').filter(Boolean));
    const afterSet = new Set(after.split('\n').filter(Boolean));
    const added = [...afterSet].filter((l) => !beforeSet.has(l)).map((l) => `+ ${l}`);
    const removed = [...beforeSet].filter((l) => !afterSet.has(l)).map((l) => `- ${l}`);
    breaches.push(`  ${repoRoot}: ${[...added, ...removed].join(', ') || 'status drift'}`);
  }
  return breaches;
}

// Classify ONE per-descriptor fan-out result. 'denied' = a broker-level capability
// refusal (an explicit denied flag, or a non-route decision such as guard_deny);
// 'missing' = errored/empty/unparseable — both are surfaced, never faked into fragments.
function classifyPlanResult(r) {
  if (r == null) return { kind: 'missing', reason: 'drafter returned no result' };
  if (r.denied === true) {
    return { kind: 'denied', reason: String(r.reason ?? r.error ?? 'write denied by the read-only capability class') };
  }
  if (r.decision && r.decision.decision !== 'route') {
    return { kind: 'denied', reason: String(r.decision.reason ?? r.reason ?? r.error ?? 'broker refused the work item') };
  }
  if (typeof r.error === 'string' && r.error) return { kind: 'missing', reason: r.error };
  const frag = extractPlanFragment(r);
  if (frag) return { kind: 'fragment', fragment: frag };
  return { kind: 'missing', reason: 'no parseable fragment in the drafter result' };
}

// Extract a {key, tasks[]} fragment from a fan-out result: a structured `fragment`
// payload first, then the result itself, then the first JSON object in the worker's
// text output (stdout/final_message — progress lines may precede the JSON).
function extractPlanFragment(r) {
  const candidates = [];
  if (r.fragment && typeof r.fragment === 'object') candidates.push(r.fragment);
  candidates.push(r);
  const text = r.stdout ?? r.final_message ?? null;
  if (typeof text === 'string' && text.length) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const i = text.indexOf('{');
      if (i >= 0) {
        try { parsed = JSON.parse(text.slice(i)); } catch { /* no trailing JSON */ }
      }
    }
    if (parsed && typeof parsed === 'object') {
      if (parsed.fragment && typeof parsed.fragment === 'object') candidates.push(parsed.fragment);
      candidates.push(parsed);
    }
  }
  for (const c of candidates) {
    if (c && typeof c.key === 'string' && c.key && Array.isArray(c.tasks)) return c;
  }
  return null;
}
