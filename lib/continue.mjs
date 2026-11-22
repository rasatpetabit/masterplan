// lib/continue.mjs — the §2 resume/dispatch trampoline, absorbed into code (T2.3).
//
// continueRun is the loop the orchestrator prose used to BE: migrate-on-load, Guard D
// acquire/confirm, wave backfill, the decide loop, worktree create-or-reuse,
// crash-scope reset, and dispatch prep — everything between "the user said continue" and
// "launch the L2 workflow" that does not require LLM judgment. The LLM stops being the
// transaction engine: it calls `mp continue` and executes ONE typed op per call.
//
// Op contract (the full enum the prose's op table documents; continueRun emits the subset
// marked •, the others are shell-originated):
//   • { op:'dispatch_fabric', wave, cwd, tasks, baseline, review, next }
//   • { op:'dispatch_plan', kind:'plan', cwd, class, read_only, roots, spec_path, next } —
//     the native planning fan-out (replaced the L2 plan Workflow launch); consumed by
//     `mp dispatch-plan`, whose fragments the shell stages as .plan-fragments.json
//   • { op:'run_skill', skill, ... }       — resume-phase (§3 lifecycle) / finish (§2c)
//   • { op:'ask', ask, ... }               — a genuine human gate or an error needing judgment
//   • { op:'stop', reason, ... }           — wait (live run) / publish_needed / coordinate (§7 prose)
//   • { op:'dispatch_fabric', wave, cwd, tasks, baseline, review, next } — codexSuppressed only:
//     the Residual-3B path; the host runs the routed tasks sequentially in-session, then feeds the
//     standard result shape to `mp record-result` (no background task, no promote)
//     { op:'record_result' }               — shell-side: result in hand → `mp record-result` FIRST
//     { op:'shell' } / { op:'dispatch_agent' } — shell-side network/agent ops (never emitted here)
//
// Boundary notes (same seam as wave-commit.mjs, the T2.2 precedent):
//   - LOCAL git only (-C-qualified to MAIN/WT loci derived here): worktree add/list, rev-parse,
//     checkout/clean for crash-scope reset. Network ops (push/gh/codex) stay shell-side.
//   - CD-7: every durable write goes through bundle.mjs (writeState/setActiveRun/setWorktree).
//     No state commit at launch — the §2a prose parity: git commits happen in record-result.
//   - Guard D is default-on; `mp seed --owner-lock=off` (state.concurrency.owner_lock === 'off')
//     is the seeded escape hatch that skips acquire/heartbeat entirely (single-agent bundles).

import fs from 'node:fs';
import { readEnv } from './config.mjs';
import path from 'node:path';

import {
  parseState, readState, writeState, setActiveRun, clearActiveRun, setWorktree, applyPlanIndex,
} from './bundle.mjs';
import { migrate, detectSchemaVersion, MigrationError } from './migrate.mjs';
import { snapshotBeforeMigration } from './migration-snapshot.mjs';
import { decideNextAction, classifyLegacyMarker } from './resume.mjs';
import { buildWaveLaunchContext } from './wave.mjs';
import { acquireOwner, heartbeatOwner } from './owner-fs.mjs';
import { planWorktreeCreate, parseWorktreeList, worktreePathFor, worktreeBranchFor } from './worktree.mjs';
import { runGit, gitLines, readWatchBaseline, workspaceRootFor } from './watch-integrity.mjs';
import { captureWtFiles, captureWorkspaceRoot, recordWaveResult, reviewReworkFiles, COMMITTED_REVIEW_REWORK } from './wave-commit.mjs';
import { hasWaveRecording } from './wave-recording.mjs';
import { canonicalizeScopePaths, captureMultiRepoFiles, groupFilesByRepo, resolveFileLocus } from './dispatch/multi-repo.mjs';
import { declarationsOverlap, pathWithinDeclaredScope } from './declared-scope.mjs';
import { normalizeReviewMode, buildWaveDispatchOp } from './dispatch/index.mjs';
import { buildPlanFanoutOp } from './dispatch/ops.mjs';
import { CONTRACT_VERSION } from './dispatch/verify-transport.mjs';
import { discoverDispatchMap, resolvePhase } from './dispatch/routing-policy.mjs';
import { pinnedGoalsEvidenceHash } from './promote.mjs';
import { taskEpisodeEligibleForCompletion } from './review-episode.mjs';
import { readScopeEvents } from './scope-authorization.mjs';
import { composeWaveDispatchKey, readWaveDispatchRecord } from './dispatch-wave.mjs';
import { completedRetryFiles, isNativeRetry, retryStatus } from './retry-scope.mjs';

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
  force = false,
  codexSuppressed = false,
  routing,
  review,
  reposAllowlist,
  skillRoot,
  // The planning mode the CONFIG HIERARCHY resolved (CLI > repo > user > default), injected by
  // the caller exactly as `routing` and `review` are — this module reads state and git, not the
  // config chain. Null means the caller resolved nothing, and the value persisted at seed
  // stands. An unknown value fails closed inside decideNextAction rather than substituting.
  planningMode = null,
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
    const backup = snapshotBeforeMigration(absState, version);
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
  //     the spec→plan capture seam — not this guard — owns).
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

  // An interrupted recording takes precedence over both finalize_run and crash
  // reset. Neither a pending task nor a cleared marker proves there is no tail.
  if (hasWaveRecording(absState)) {
    const res = recordWaveResult({ statePath: absState, self, now, skillRoot });
    if (res.outcome === 'lost-to-other') return { op: 'ask', ask: 'owner-lost', reason: res.reason, incumbent: res.incumbent };
    if (res.blocking_reviews?.length) return { op: 'ask', ask: 'blocking-reviews', blocking_reviews: res.blocking_reviews };
    state = readState(absState);
    alive = false;
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
  let reconciledLegacy = null;
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
    if (legacy?.legacy === 'bootstrap') {
      // Surfaced, never auto-converted: the bootstrap stage owns this bundle until its own
      // driver records the gate, and no plan or execute dispatch may run underneath it.
      return unreconcilable(
        'active_run carries a BOOTSTRAP-stage marker — the bootstrap stage is driven by scripts/bootstrap-v10.mjs (arm/record) and no plan or execute wave may dispatch while it is in flight'
      );
    }
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
          const res = recordWaveResult({ statePath: absState, result: null, self, now, skillRoot, worktree: wt.WT });
          if (res.outcome === 'lost-to-other') {
            return { op: 'ask', ask: 'owner-lost', reason: res.reason, incumbent: res.incumbent ?? null };
          }
          if (res.blocking_reviews?.length) return { op: 'ask', ask: 'blocking-reviews', blocking_reviews: res.blocking_reviews };
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
        reconciledLegacy = { legacy: legacy.legacy, marker, conversion: 'redispatch' };
      }
    }
    // 'plan-launching' needs no conversion: recover_plan_run already emits the
    // planning fan-out op (dispatch_plan) for phase-1 plan markers.
  }

  // 4. The decide loop. decideNextAction is pure; this executes the deterministic arms inline
  //    (finalize → reconcile → re-decide) and returns the first op that needs the shell.
  let aliveEff = !!alive;
  // A reconciled legacy conversion is visible on the op it produced (never silent).
  const annotate = (op) => (reconciledLegacy && op && typeof op === 'object' ? { ...op, reconciled: reconciledLegacy } : op);
  for (let step = 0; step < MAX_DECIDE_STEPS; step++) {
    let action;
    try {
      action = decideNextAction(state, { alive: aliveEff, ...(planningMode == null ? {} : { planning_mode: planningMode }) });
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
          skillRoot,
          self,
          now,
          worktree: state.worktree ?? undefined,
        });
        if (res.outcome === 'lost-to-other') {
          return { op: 'ask', ask: 'owner-lost', reason: res.reason, incumbent: res.incumbent ?? null };
        }
        if (res.blocking_reviews?.length) return { op: 'ask', ask: 'blocking-reviews', blocking_reviews: res.blocking_reviews };
        state = readState(absState);
        aliveEff = false; // the reconciled run is gone; nothing left to be alive
        continue;
      }

      case 'recover_plan_run': {
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
        // The native planning fan-out replaced the L2 plan Workflow launch: ONE op, consumed by
        // the deterministic `mp dispatch-plan` — READ-ONLY capability class, explicitly enumerated
        // roots (repo + spec). The shell stages the returned fragments as .plan-fragments.json
        // exactly as before; the merge/validate/review gate sequence is unchanged.
        return annotate(buildPlanFanoutOp({ cwd: MAIN, specPath: resolveSpecPath(state, bundleDir) }));
      }

      case 'recover_wave': {
        if (state.active_run.review_recovery) {
          return { op: 'ask', ask: 'blocking-reviews', reason: COMMITTED_REVIEW_REWORK,
            tasks: state.active_run.review_rework };
        }
        let wt, retry, publishedRetry, retryProtected = [];
        try {
          const existing = readWaveDispatchRecord(bundleDir, action.wave);
          retry = isNativeRetry(existing);
          const published = existing != null && existing.status !== 'recorded';
          if (published && !retry && existing.history?.some((attempt) => attempt.status === 'recorded'))
            throw new Error('continue: missing published retry launch proof');
          publishedRetry = retry && published;
          if (retry) {
            const loci = retryRecoveryLoci(absState, state, action.wave, existing, publishedRetry);
            retryProtected = [...completedRetryFiles(state, action.wave, existing, loci), ...state.active_run.baseline];
            if (publishedRetry) {
              retryProtected.push(...existing.retry_launch.preserved.map((entry) => entry.file));
              // The native dispatcher will reuse the pending record without a precheck.
              // Refuse ambiguous dirty paths before any checkout/clean or marker rewrite.
              const pending = [...action.tasks, ...existing.payload].flatMap((task) => task.files ?? []);
              assertUnambiguousRetryPaths(pending, retryProtected, loci);
            }
          }
          wt = ensureWorktree(state, absState, bundleDir);
        } catch (e) {
          return { op: 'ask', ask: 'dispatch-error', error: e.message };
        }
        state = wt.state;
        // Reset only disposable incomplete-task work, within the original scope.
        const loci = { worktree: wt.WT, mainRoot: wt.MAIN, slug: state.slug };
        const frozen = retry ? canonicalizeScopePaths(state.active_run.scope, loci) : null;
        const protectedFiles = [...canonicalizeScopePaths(reviewReworkFiles(state), loci), ...retryProtected];
        const overlapsReset = retry ? resetPathCovers : declarationsOverlap;
        const resetPaths = (action.resetPaths ?? []).filter((raw) => canonicalizeScopePaths([raw], loci).every((file) =>
          (!frozen || pathWithinDeclaredScope(file, frozen)) &&
          !protectedFiles.some((decl) => overlapsReset(file, decl))));
        const resetSkipped = [];
        if (resetPaths.length) {
          // Partition by owning git repo so a wave whose declared scope MIXES the run's
          // worktree with EXTERNAL repos (absolute paths under another checkout) resets each
          // repo with its own `git -C` — a single worktree-rooted `git ls-files` rejects
          // external absolute paths as "outside the repository". Scoped per repo: checkout
          // tracked + clean untracked, bounded to the declared paths; never broad reset/clean.
          const groups = new Map();
          for (const raw of resetPaths) {
            const loc = resolveFileLocus(raw, loci);
            if (loc.siblingWt && !fs.existsSync(loc.siblingWt)) {
              resetSkipped.push({ path: raw, repo: loc.siblingWt,
                reason: 'run worktree does not exist; nothing was dispatched there' });
              continue;
            }
            const { repo: repoRoot, rel } = loc;
            if (!groups.has(repoRoot)) groups.set(repoRoot, []);
            groups.get(repoRoot).push(rel);
          }
          for (const [repoRoot, rels] of groups) {
            const tracked = gitLines(repoRoot, ['--literal-pathspecs', 'ls-files', '--', ...rels]);
            if (tracked.length) runGit(repoRoot, ['--literal-pathspecs', 'checkout', '--', ...tracked]);
            runGit(repoRoot, ['--literal-pathspecs', 'clean', '-fd', '--', ...rels]);
          }
        }
        return annotate({ ...dispatchWave(state, absState, planIndexPath, action.wave, wt, {
          codexSuppressed, routing, review, reposAllowlist, fabricDispatch, retry, publishedRetry,
        }), ...(resetSkipped.length ? { reset_skipped: resetSkipped } : {}) });
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

      case 'complete': {
        const ineligible = (state.tasks ?? []).filter((t) => t.status === 'done' && !taskEpisodeEligibleForCompletion(absState, state, t));
        if (ineligible.length) return { op: 'ask', ask: 'review-episode-ineligible', tasks: ineligible.map((t) => t.id) };
        // The shell enters the §2c finish loop: `mp finish-step` (lib/finish-step.mjs, T2.4)
        // — itself a trampoline returning one op per call.
        return annotate({ op: 'run_skill', skill: 'finish' });
      }

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

// MAIN = the primary checkout, derived from the bundle's repo (same derivation as wave-commit).
function mainRepoRoot(bundleDir) {
  return path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

// Git's literal pathspec can also descend into a directory without a trailing slash.
function resetPathCovers(declaration, file) {
  return declarationsOverlap(declaration, file) ||
    pathWithinDeclaredScope(file, [`${declaration.replace(/\/$/, '')}/`]);
}

function retryRecoveryLoci(statePath, state, wave, record, published) {
  const bundleDir = path.dirname(statePath);
  const mainRoot = mainRepoRoot(bundleDir);
  const worktree = worktreePathFor(mainRoot, state.slug);
  const run = state.active_run;
  const paths = (list) => Array.isArray(list) && list.every((file) => typeof file === 'string' && file.length);
  const events = readScopeEvents(statePath);
  const cursor = run.scope_event_cursor;
  if (!paths(run.scope) || !paths(run.baseline) || !Number.isInteger(cursor) || cursor < 0 || cursor > events.length ||
      record.wave !== wave || record.key !== composeWaveDispatchKey(state.slug, wave))
    throw new Error('continue: missing or inconsistent original retry launch scope, baseline, or cursor');
  if (published) {
    const { preserved, scope_event_cursor: retryCursor } = record.retry_launch;
    const saved = parseState(readWatchBaseline(bundleDir, wave)?.bundle?.stateText ?? '');
    const original = saved.active_run;
    if (!Array.isArray(record.payload) || !record.payload.every((task) => paths(task?.files)) ||
        !Array.isArray(preserved) || !preserved.every((entry) => entry && paths([entry.file, entry.repo, entry.rel]) &&
          (entry.fingerprint === null || /^[0-9a-f]{64}$/.test(entry.fingerprint))) ||
        !Number.isInteger(retryCursor) || retryCursor < cursor || retryCursor > events.length ||
        saved.worktree !== worktree || state.worktree !== worktree || !fs.existsSync(worktree) ||
        original?.wave !== wave || !paths(original.scope) || original.scope_event_cursor !== cursor ||
        JSON.stringify(original.baseline) !== JSON.stringify(run.baseline) ||
        JSON.stringify(original.wsBaseline) !== JSON.stringify(run.wsBaseline))
      throw new Error('continue: missing or inconsistent published retry launch proof');
    // A controller amendment may extend, but never replace, the frozen scope.
    const current = JSON.stringify(run.scope);
    let scope = JSON.stringify(original.scope);
    for (const event of events.slice(retryCursor)) {
      if (scope === current) break;
      const audit = event.type === 'scope_reauthorized' ? event
        : ['tasks_amended', 'plan_amended'].includes(event.type) ? event.scope_reauthorization : null;
      if (audit?.wave === wave && paths(audit.new_scope) && JSON.stringify(audit.old_scope) === scope &&
          audit.old_scope.every((file, i) => file === audit.new_scope[i]))
        scope = JSON.stringify(audit.new_scope);
    }
    if (scope !== current) throw new Error('continue: current scope does not match the published retry launch or its amendments');
  }
  return { worktree, mainRoot, slug: state.slug };
}

function assertUnambiguousRetryPaths(pending, protectedFiles, loci) {
  const shared = canonicalizeScopePaths(pending, loci)
    .filter((file) => protectedFiles.some((decl) => resetPathCovers(file, decl)));
  for (const [repo, group] of groupFilesByRepo(shared, loci)) {
    if (group.siblingWt && repo !== group.siblingWt) continue; // no dispatched worktree to reset
    for (const { path: rel } of retryStatus(repo)) {
      const file = group.siblingName ? `${group.siblingName}/${rel}` : rel;
      if (group.files.some((decl) => resetPathCovers(decl, rel)) &&
          protectedFiles.some((decl) => declarationsOverlap(file, decl)))
        throw new Error(`continue: dirty retry path ${file} overlaps a completed task or launch baseline; ownership cannot be established`);
    }
  }
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

// Dispatch prep (the §2a-launch prose, now code): buildWaveLaunchContext owns plan-index
// read / config+env / prepareWave / MAIN; the D6 baseline is captured pre-launch, and the
// phase-1 launching marker is written BEFORE the launch op is returned (the two-phase
// marker's whole point). NO state commit here — git commits happen in record-result (§2a parity).
function dispatchWave(state, absState, planIndexPath, wave, wt, opts) {
  // PREPARE routing-input source: current invocation flags (with state.codex.routing
  // preferred). Differs intentionally from EXECUTE, which freezes routing_inputs from the
  // persisted attempt-1 record on retry. reposAllowlist is also PREPARE-only.
  const routingInputs = {
    routing: state.codex?.routing ?? opts.routing ?? 'auto',
    codex_host_suppressed: !!opts.codexSuppressed,
    linked_worktree: true,
  };
  let prepared, MAIN;
  try {
    const ctx = buildWaveLaunchContext({
      state, planIndexPath, wave, routingInputs, reposAllowlist: opts.reposAllowlist,
    });
    prepared = ctx.prepared;
    MAIN = ctx.MAIN;
  } catch (e) {
    return { op: 'ask', ask: 'dispatch-error', error: e.message };
  }
  const reviewMode = normalizeReviewMode(state.review?.adversary ?? state.codex?.review ?? opts.review);
  // Multi-repo baseline: umbrella-relative paths covering the run worktree AND any
  // sibling git checkouts referenced by the wave's declared scope (yanos-os/..., …).
  // Plain captureWtFiles(WT) misses sibling dirt and makes post-wave F-SCOPE blind.
  // MAIN (from buildWaveLaunchContext) is the git common dir's parent — identical to
  // resolving from wt.WT since both live inside the same repo.
  const rework = state.active_run?.review_rework;
  const preserveLaunch = opts.retry || rework?.length;
  const scope = preserveLaunch ? state.active_run.scope ?? prepared.scope : prepared.scope;
  const loci = { worktree: wt.WT, mainRoot: MAIN, slug: String(state.slug ?? '') };
  // Both native entry points capture new, non-task dirt in the dispatch record.
  // Keep the original baseline here so retained edits are still committable.
  const baseline = preserveLaunch ? state.active_run.baseline
    : captureMultiRepoFiles(scope, { ...loci, captureWtFiles, allowMissingLoci: true });
  if (!opts.publishedRetry) {
    // Capture workspace root entries for post-wave drift detection. A published
    // retry already has its marker: don't replace it or re-baseline anything.
    const wsRoot = workspaceRootFor(MAIN);
    const wsBaseline = wsRoot ? captureWorkspaceRoot(wsRoot) : null;
    const next = setActiveRun(state, {
      wave, phase: 'launching', scope, baseline,
      ...(rework?.length ? { review_rework: rework } : {}),
      scope_event_cursor: preserveLaunch ? state.active_run.scope_event_cursor : readScopeEvents(absState).length,
      ...(wsBaseline ? { wsBaseline } : {}),
    });
    writeState(absState, next);
  }
  return buildWaveDispatchOp({
    wave,
    cwd: wt.WT,
    tasks: prepared.tasks,
    baseline,
    review: reviewMode,
  });
}

// ---- goals split-brain guard ---------------------------------------------------
// Spec §5: any transition on a goals_enabled bundle recomputes the goals.md hash and throws when it
// diverges from the LAST goals_frozen/goal_amended event. Exempt: pre-feature bundles (no
// goals_enabled). No-op: a goals_enabled bundle with no goal-lifecycle event yet (pre-capture window).
function assertGoalsNotSplitBrain(state, bundleDir) {
  if (state?.goals_enabled !== true) return; // pre-feature bundle — exempt
  const frozen = lastFrozenGoalsHash(bundleDir);
  if (frozen === null) return; // no goals_frozen/goal_amended yet — the spec→plan capture seam owns this window
  let goalsMd = null;
  try {
    goalsMd = fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8');
  } catch {
    goalsMd = null;
  }
  const current = goalsMd === null ? null : pinnedGoalsEvidenceHash(path.join(bundleDir, 'state.yml'), goalsMd);
  if (current !== frozen) {
    throw new Error(
      `goals split-brain: goals.md hash ${current ?? '(goals.md missing)'} != last frozen/amended `
      + `event hash ${frozen} — record the change through an approved promotion transaction `
      + `(the sanctioned amendment route) or restore goals.md, then continue.`
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

// ---- the native planning fan-out (`mp dispatch-plan`) ----
//
// Parallel-planning vehicle: one READ-ONLY subsystem-planner spawn descriptor
// per subsystem. The orchestrating harness executes them with its native
// parallel subagent API — the class resolves from the routing policy to a
// writes:false role, so the harness write gate keeps drafters read-only.
// Fragments come back as STRUCTURED PAYLOADS for the shell to stage as
// .plan-fragments.json (the merge/validate/review gate sequence is unchanged,
// and L1 stays the single durable writer — this executor writes NO state and
// NO artifacts).
//
// Read-only enforcement is layered:
//   1. CAPABILITY (policy-level): every descriptor declares the plan-fanout
//      class, which resolves to a writes:false role — the harness write gate
//      denies edit tools on that role.
//   2. DEFENSE IN DEPTH: `git status --porcelain` is snapshotted over the
//      enumerated roots BEFORE the fan-out and returned with the plan
//      (porcelain_pre); the orchestrator re-snapshots AFTER the fan-out
//      (diffRootsPorcelain) and refuses to stage fragments on any drift —
//      the breach is surfaced INSTEAD of fragments being staged.
//
// Crash semantics mirror the plan run's existing contract: the phase-1 plan marker is
// written BEFORE dispatch (by `mp continue` / set-active-run --kind=plan), re-entry is
// idempotent (drafters are read-only; re-running the fan-out re-derives everything), and
// a missing fragment is surfaced by the shell's coverage reconcile — never silently
// dropped, never faked.
export function dispatchPlanFanout({
  statePath,
  subsystems,
  specPath = null,
  planMd = null,
  policy = null,
  host = 'pi',
} = {}) {
  if (!statePath) throw new Error('dispatch-plan: statePath is required');
  const absState = path.resolve(statePath);
  const bundleDir = path.dirname(absState);
  const state = readState(absState);

  // 1. The phase-1 plan marker gate — written BEFORE dispatch so a crash in the gap
  //    resumes as recovery (`mp continue` re-emits the planning op), never a blind re-dispatch.
  if (state.active_run?.kind === 'bootstrap') {
    throw new Error('dispatch-plan: active_run carries a BOOTSTRAP-stage marker — plan drafters must never dispatch while the irreversible stage is in flight');
  }
  if (state.active_run?.kind !== 'plan') {
    throw new Error('dispatch-plan: active_run is not a plan marker — run `mp continue` first (it writes the plan launching marker this command consumes)');
  }

  // 2. The decomposition is caller-resolved judgment: this executor only fans out
  //    one drafter descriptor per already-decided subsystem.
  if (!Array.isArray(subsystems) || subsystems.length === 0) {
    throw new Error('dispatch-plan: a non-empty subsystems decomposition is required (re-dispatch mp-spec-decomposer first)');
  }
  for (const sub of subsystems) {
    if (!sub || typeof sub.key !== 'string' || !sub.key) {
      throw new Error('dispatch-plan: every subsystem needs a non-empty string key');
    }
  }

  // 3. Explicitly enumerated accessible roots: the repo (MAIN) + the spec path.
  const MAIN = mainRepoRoot(bundleDir);
  const spec = path.resolve(specPath ?? resolveSpecPath(state, bundleDir));
  // An EXPLICIT plan path always wins; otherwise the bundle's own state.plan_path is used, and
  // only then the conventional sibling. A work item built without it would send drafters at a
  // plan the run does not own.
  const plan = resolvePlanMdPath({ explicit: planMd ?? null, state, bundleDir });
  const roots = [...new Set([MAIN, spec])];

  // 4. Pre-fan-out porcelain snapshot (defense-in-depth layer 2).
  const pre = snapshotRootsPorcelain(roots);

  // 5. One READ-ONLY spawn descriptor per subsystem — no write-scope fields, ever.
  const descriptors = subsystems.map((sub) => buildPlanWorkItem(sub, { roots, specPath: spec, planPath: plan, repoRoot: MAIN, policy, host }));

  const concurrency = Math.max(1, Math.min(
    Number(readEnv('MP_DISPATCH_WAVE_CONCURRENCY')) || 8,
    descriptors.length || 1,
  ));

  return {
    outcome: 'native-spawn-plan',
    kind: 'plan',
    awaiting_launch: true,
    plan: { descriptors, concurrency },
    roots,
    porcelain_pre: pre,
    specPath: spec,
    repoRoot: MAIN,
    requested: subsystems.map((sub) => sub.key),
    reason: 'native-spawn host: run these descriptors with the harness parallel subagent API, re-snapshot the roots (diffRootsPorcelain) and refuse staging on drift, then stage the returned fragments as .plan-fragments.json',
  };
}

function resolveSpecPath(state, bundleDir) {
  return state.spec_path ? path.resolve(bundleDir, state.spec_path) : path.join(bundleDir, 'spec.md');
}

// The plan markdown this bundle owns: its recorded plan_path, else the conventional sibling.
function resolvePlanPath(state, bundleDir) {
  return state.plan_path ? path.resolve(bundleDir, state.plan_path) : path.join(bundleDir, 'plan.md');
}

/**
 * THE plan-markdown selection rule, shared by every consumer that has to decide which file a
 * run's plan lives in. There is one rule because two of them silently diverge: a fan-out that
 * advertises `custom-plan.md` while the merge writes `plan.md` leaves the run's real plan
 * permanently stale.
 *
 * Precedence:
 *   1. An explicit path (a `--plan-md` flag), resolved against the process cwd the way every
 *      other CLI path flag is.
 *   2. `state.plan_path`, resolved against the BUNDLE directory — the bundle records it
 *      relative to itself, and cwd is routinely a linked worktree rather than the checkout.
 *   3. The conventional `plan.md` beside the bundle.
 *
 * A blank explicit path is REFUSED rather than defaulted. `path.resolve('')` yields the
 * current working directory — neither a plan file nor a safe fallback — so a wrapper passing
 * an empty flag would otherwise advertise a directory as the run's plan.
 *
 * @param {{explicit?: string|null, state: object, bundleDir: string}} input
 * @returns {string} an absolute path
 */
export function resolvePlanMdPath({ explicit = null, state = {}, bundleDir }) {
  if (explicit !== null && explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.trim() === '') {
      throw new Error('plan-md: an explicit plan path must be a non-empty string — omit the flag to use the bundle\'s own plan_path');
    }
    return path.resolve(explicit);
  }
  return resolvePlanPath(state, bundleDir);
}

/**
 * Build the READ-ONLY spawn descriptor for one subsystem drafter.
 * `repo` is a locus/identity field, NOT a write grant — write scope stays
 * denied by read_only + the routing policy's writes:false role. Mirrors the
 * drafterPrompt contract so fragments merge identically.
 */
export function buildPlanWorkItem(s, { roots, specPath, planPath = null, repoRoot, policy = null, host = 'pi' }) {
  const discovery = policy ? { status: 'configured', path: null, schema: policy.schema, policy } : discoverDispatchMap({ host });
  const intent = discovery.status === 'configured'
    ? resolvePhase('plan', { policy: discovery.policy })
    : { phase: 'plan', agent: 'judge' };
  const brief = [
    `Draft the plan FRAGMENT for the "${s.key}" subsystem of this build.`,
    `READ-ONLY: your accessible roots are ${roots.join(', ')} (the repo ${repoRoot} + the spec ${specPath}).`,
    `Read for context; do NOT write, edit, run mutating commands, or commit — the dispatch class denies writes.`,
    ``,
    `Subsystem: ${s.title ?? s.key}`,
    `Scope / responsibility: ${s.description ?? '(see the spec)'}`,
    s.spec_refs?.length ? `Relevant spec sections: ${s.spec_refs.join(', ')}` : `Spec: ${specPath}`,
    s.files_hint?.length ? `Likely files in this subsystem: ${s.files_hint.join(', ')}` : ``,
    planPath ? `The plan this run owns: ${planPath}` : ``,
    ``,
    `Return ONLY a JSON fragment: { "key": "${s.key}", "tasks": [ { key, description, files, verify_commands, deps?, codex?, spec_refs? } ] }.`,
    `Task keys must be UNIQUE across the whole plan — prefix them with the subsystem (e.g. "${s.key}.<short-name>").`,
    `Use deps for ordering; do NOT assign global ids or waves — those are computed deterministically after merge.`,
    `Same-wave parallelism is derived from file-disjointness, so keep each task's file set tight and declare deps wherever two tasks must touch the same file.`,
  ].filter(Boolean).join('\n');
  return {
    ...intent,
    routing_map: { status: discovery.status, path: discovery.path, schema: discovery.schema },
    model_source: host === 'pi' ? 'pi-governed' : 'host-native',
    read_only: true,
    repo: repoRoot, // descriptor locus; NOT a write grant
    roots,
    subsystem: s.key,
    ...(planPath ? { plan_path: planPath } : {}),
    brief,
    task: brief, // brief alias kept for descriptor consumers
    contract_version: CONTRACT_VERSION,
  };
}

// Porcelain snapshot over the enumerated roots, grouped by owning git repo. Fail-closed:
// a root outside any git repo cannot be asserted read-only, so it throws rather than
// silently narrowing the defense-in-depth check.
export function snapshotRootsPorcelain(roots) {
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
export function diffRootsPorcelain(pre, post) {
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
