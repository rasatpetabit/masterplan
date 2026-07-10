// wave-commit: the §2a wave-completion transaction, absorbed into code (T2.2, git-in-bin seam).
//
// recordWaveResult is the single durable transaction that used to live as prose in
// commands/masterplan.md — §2a Completion steps 0-4, the §2 finalize_run crash-reconcile
// row, and the §2e¶6 split-commit trace. The LLM stops being the transaction engine: it
// hands the L2 workflow result to `mp record-result` and gets back a digest + the next
// decide action. CD-7 strengthens here — `mp` is the sole writer of state AND the sole
// executor of the LOCAL git bracketing it (network ops stay shell-side).
//
// Transaction order (each prefix is crash-safe; finalize_run reconciles any suffix):
//   0. owner heartbeat (lost-to-other → return, ZERO writes)
//   1. mark digests in-memory (markTask throws on unknown id → all-or-nothing), ONE
//      atomic writeState — the LEADING durable action; active_run marker stays intact
//   2. capture `after` in WT (D6 commands), verifyScope against the immutable
//      active_run.scope allow-set off the persisted baseline
//   3. out-of-scope revert, split by trackedness (checkout for tracked, clean for the rest)
//   4. code commit in WT — pathspec-scoped, done-files only unless the whole wave is done
//      (failed tasks' partial edits stay UNCOMMITTED so recover's checkout actually resets)
//   5. all wave tasks done → clearActiveRun + second writeState
//   6. dispatch-provenance events (dispatch_degraded / dispatch_inline_designed, from the
//      digests' optional adsp-v1.1 dispatch field) + wave_recorded event, then state commit
//      in MAIN — pathspec-scoped to the bundle dir
//   7. decideNextAction on the resulting state → `next`
//
// Crash windows (why each ordering is load-bearing):
//   after 1 → marker+baseline intact → finalize_run re-runs the tail idempotently
//   after 4 → WT clean → reconcile's verify/revert/commit all no-op → clear + state commit
//   after 5 → state leads git (CD-7 ordering) → the next state commit sweeps the bundle
//
// Reconcile mode (result: null) IS the §2 finalize_run row: no marks, the verify → revert →
// commit → clear tail still runs (clean WT degrades to pure no-ops + marker clear).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { verifyScope, declaredScope } from './wave.mjs';
import { readState, writeState, appendEvent, markTask, clearActiveRun } from './bundle.mjs';
import { heartbeatOwner } from './owner-fs.mjs';
import { decideNextAction } from './resume.mjs';

// Local git only (-C-qualified to loci derived below). Throws with command context so a
// failed git surfaces as a die() at the bin boundary, never a silent half-transaction.
export function runGit(dir, args, _exec = execFileSync) {
  try {
    return String(_exec('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim();
    throw new Error(`git -C ${dir} ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

function gitLines(dir, args) {
  const out = runGit(dir, args);
  return out ? out.split('\n').filter(Boolean) : [];
}

// The workspace root baseline: non-hidden entries at the workspace root level.
// Used to detect agent-created loose files (AUDIT-*.md, progress.md, etc.) after a wave.
// `wsRoot` is the workspace root directory (e.g. /srv/dev).
export function captureWorkspaceRoot(wsRoot) {
  try {
    return fs.readdirSync(wsRoot).filter((e) => !e.startsWith('.'));
  } catch {
    return [];
  }
}

// The D6 capture: tracked changes vs HEAD ∪ untracked (same two commands the prose
// specified for `before`/`after`, quotePath off so non-ASCII paths compare stably).
export function captureWtFiles(wt) {
  const tracked = gitLines(wt, ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD']);
  const untracked = gitLines(wt, ['-c', 'core.quotePath=false', 'ls-files', '-o', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

const coerceId = (v) => (/^-?\d+$/.test(String(v)) ? Number(v) : v);

export function recordWaveResult({ statePath, result = null, self, now, worktree } = {}) {
  if (!statePath) throw new Error('record-result: statePath is required');
  const state = readState(statePath);
  const run = state.active_run;
  if (!run) throw new Error('record-result: no active_run marker — nothing to record (already finalized?)');
  if (run.kind === 'plan') {
    throw new Error('record-result: active_run is a plan run — plan results merge via merge-plan-fragments, not record-result');
  }
  if (!Number.isInteger(run.wave)) {
    throw new Error(`record-result: active_run.wave is not an integer (${JSON.stringify(run.wave)})`);
  }
  const wave = run.wave;
  if (result && Number.isInteger(result.wave) && result.wave !== wave) {
    throw new Error(`record-result: result is for wave ${result.wave} but active_run is wave ${wave} — refusing foreign result`);
  }

  // Stale-epoch (fencing-token) fence: a result carrying an epoch older than the marker's
  // current per-claim monotonic epoch is a reaped worker resuming late. Reject it BEFORE any
  // state byte is written (before the all-or-nothing markTask pass) so two harness workers can
  // never both mutate the same worktree across a stale reap. Extends the foreign-result guard.
  // Only fires on epoch-fenced markers (run.epoch finite); pre-epoch bundles keep prior behavior.
  if (result && Number.isFinite(run.epoch)) {
    const resultEpoch = Number.isFinite(result.epoch) ? result.epoch : null;
    if (resultEpoch === null || resultEpoch < run.epoch) {
      return {
        outcome: 'stale-epoch',
        wave,
        resultEpoch,
        currentEpoch: run.epoch,
        reason: `result epoch ${resultEpoch === null ? '(missing)' : resultEpoch} is stale (current claim epoch is ${run.epoch})`,
      };
    }
  }

  // 0. Owner heartbeat — STRICT (acquire must precede; §2 step 1.6 always does). Not ours →
  //    abort with zero writes so the rightful owner's transaction is never interleaved.
  //    Skipped only under the seeded escape hatch (`mp seed --owner-lock=off` →
  //    state.concurrency.owner_lock === 'off') — single-agent bundles that opted out of Guard D.
  const bundleDir = path.dirname(path.resolve(statePath));
  if (state.concurrency?.owner_lock !== 'off') {
    const hb = heartbeatOwner(bundleDir, self, { now });
    if (hb.outcome !== 'held-by-self') {
      return { outcome: 'lost-to-other', reason: hb.reason, incumbent: hb.incumbent ?? null };
    }
  }

  // Loci (§2e): MAIN derived from the bundle's repo, WT from state (or the conventional path).
  const MAIN = path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const slug = String(state.slug ?? '').trim();
  const wtCandidate = worktree ?? state.worktree ?? (slug ? path.join(MAIN, '.worktrees', slug) : null);
  if (!wtCandidate) {
    throw new Error('record-result: cannot derive the worktree locus — pass --worktree, or set state.worktree/slug');
  }
  const WT = path.resolve(wtCandidate);
  if (!fs.existsSync(WT)) {
    throw new Error(`record-result: worktree ${WT} does not exist — run reconcile against the surviving locus or re-create it`);
  }

  // 1. Mark digests — ALL in-memory first (markTask throws on unknown id before any byte
  //    hits disk), then ONE atomic writeState. Marker stays intact: a crash here leaves a
  //    finalize_run-recoverable bundle, never a half-marked one.
  const recorded = [];
  const failed = [];
  const qctl = [];
  const blocking_reviews = [];
  const dispatchEvents = [];
  let nextState = state;
  for (const item of result?.tasks ?? []) {
    const digest = item?.digest ?? item;
    const id = coerceId(digest?.task_id ?? item?.task_id);
    const status = digest?.status;
    if (status === 'done') {
      nextState = markTask(nextState, id, 'done');
      recorded.push(id);
    } else if (status === 'qctl') {
      // Synthetic: stays pending for the L1 qctl path; NOT a failure.
      qctl.push({ id, backend: item?.backend ?? null });
    } else {
      // failed / blocked / anything else: leave pending, surface for recover_and_redispatch.
      failed.push({ id, status: status ?? 'unknown', summary: digest?.summary ?? '', blockers: digest?.blockers ?? [] });
    }
    if (item?.review && item.review.verdict === 'blocking') {
      blocking_reviews.push({ id, findings: item.review.findings ?? [] });
    }
    // adsp-v1.1 dispatch provenance → degradation-visibility events (fail-VISIBLE,
    // never fail-blocked: recording proceeds regardless). Digests without the
    // optional field (v1 / non-fabric paths) emit nothing.
    const disp = digest?.dispatch;
    if (disp != null && typeof disp === 'object' && !Array.isArray(disp)) {
      const degraded = disp.outcome === 'escalate' || disp.outcome === 'broker_error' || disp.degraded_fallback != null;
      const evBody = {
        task_id: id,
        outcome: disp.outcome ?? null,
        reason: disp.reason ?? null,
        decision_id: disp.decision_id ?? null,
        ...(disp.degraded_fallback != null ? { degraded_fallback: disp.degraded_fallback } : {}),
      };
      if (degraded) {
        dispatchEvents.push({ type: 'dispatch_degraded', ...evBody });
      } else if (disp.outcome === 'inline_designed') {
        // Designed Claude-tier inline routing gets its OWN durable tag so it is
        // queryable — and distinguishable from a broker outage — in events.jsonl.
        dispatchEvents.push({ type: 'dispatch_inline_designed', ...evBody });
      }
    }
  }
  if (result) writeState(statePath, nextState);

  // 2. Scope verification off the IMMUTABLE allow-set frozen at launch (active_run.scope);
  //    declaredScope is the state-only fallback for pre-scope markers.
  const declared = run.scope ?? declaredScope(nextState, wave);
  const before = result?.baseline ?? run.baseline ?? [];
  const after = captureWtFiles(WT);
  const scope = verifyScope(declared, before, after);

  // 3. Out-of-scope revert, split by trackedness: plain `checkout --` ERRORS on untracked
  //    paths, so tracked offenders revert via checkout and the remainder via clean.
  let reverted = [];
  if (!scope.ok && scope.outOfScope.length) {
    const tracked = gitLines(WT, ['ls-files', '--', ...scope.outOfScope]);
    if (tracked.length) runGit(WT, ['checkout', '--', ...tracked]);
    runGit(WT, ['clean', '-fd', '--', ...scope.outOfScope]);
    reverted = scope.outOfScope;
  }

  // 3b. Workspace root drift check: agents must not create loose files in the workspace root.
  //     If the wave was launched with a wsBaseline, compare current workspace root entries
  //     against it and remove any new non-hidden entries (agent artifacts like AUDIT-*.md).
  let wsLoose = [];
  if (run.wsBaseline && Array.isArray(run.wsBaseline) && run.wsBaseline.length > 0) {
    // Derive workspace root: parent of MAIN (e.g. /srv/dev/yanos-project -> /srv/dev).
    // The baseline was captured from this same path at dispatch.
    const wsRoot = path.dirname(MAIN);
    const now = captureWorkspaceRoot(wsRoot);
    const baselineSet = new Set(run.wsBaseline);
    const looseEntries = now.filter((e) => !baselineSet.has(e));
    if (looseEntries.length) {
      for (const entry of looseEntries) {
        const entryPath = path.join(wsRoot, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            // Don't remove directories (could be new repos the user created)
            wsLoose.push(entry + '/');
          } else {
            fs.unlinkSync(entryPath);
            wsLoose.push(entry);
          }
        } catch {
          wsLoose.push(entry + '?');
        }
      }
    }
  }

  // 4. Code commit (WT, pathspec-scoped — foreign staged content is never swept). Stage
  //    only in-scope touched files; when the wave has failures, narrow further to the
  //    done tasks' declared files so failed tasks' partial edits stay uncommitted and
  //    recover's `checkout -- resetPaths` actually resets them.
  const waveTasks = (nextState.tasks ?? []).filter((t) => t.wave === wave);
  const allDone = waveTasks.length > 0 && waveTasks.every((t) => t.status === 'done');
  const inScope = scope.touched.filter((f) => !scope.outOfScope.includes(f));
  let stage = inScope;
  if (!allDone) {
    const doneFiles = new Set(waveTasks.filter((t) => t.status === 'done').flatMap((t) => t.files ?? []));
    stage = inScope.filter((f) => doneFiles.has(f));
  }
  let codeSha = null;
  if (stage.length && runGit(WT, ['status', '--porcelain', '--', ...stage])) {
    runGit(WT, ['add', '--', ...stage]);
    runGit(WT, ['commit', '-q', '-m', `masterplan(${nextState.slug}): wave ${wave} code`, '--', ...stage]);
    codeSha = runGit(WT, ['rev-parse', 'HEAD']);
  }

  // 5. Whole wave done → clear the marker (second atomic write). Failures leave it intact
  //    so the next decide returns recover_and_redispatch with the stale task id.
  let cleared = false;
  if (allDone) {
    nextState = clearActiveRun(nextState);
    writeState(statePath, nextState);
    cleared = true;
  }

  // 6. Events (before the state commit so they land IN the state commit), then the MAIN
  //    state commit — pathspec-scoped to the bundle dir, unrelated staged work untouched.
  //    Dispatch-provenance events first (dispatch_degraded / dispatch_inline_designed —
  //    the adsp-v1.1 degradation-visibility surface), then the wave_recorded summary.
  const mode = result ? 'record' : 'reconcile';
  const ts = new Date(now ?? Date.now()).toISOString();
  for (const ev of dispatchEvents) {
    appendEvent(statePath, {
      type: ev.type,
      ts,
      phase: nextState.phase,
      task_id: ev.task_id,
      outcome: ev.outcome,
      reason: ev.reason,
      decision_id: ev.decision_id,
      ...(ev.degraded_fallback != null ? { degraded_fallback: ev.degraded_fallback } : {}),
      note: `task ${ev.task_id} dispatch ${ev.outcome ?? 'unknown'}${ev.reason ? `: ${ev.reason}` : ''}`,
    });
  }
  appendEvent(statePath, {
    type: 'wave_recorded',
    ts,
    phase: nextState.phase,
    note: `wave ${wave} ${mode}: ${recorded.length} done, ${failed.length} failed/blocked, ${qctl.length} qctl` +
      (reverted.length ? `; reverted ${reverted.length} out-of-scope` : '') +
      (wsLoose.length ? `; removed ${wsLoose.length} workspace-root loose file${wsLoose.length > 1 ? 's' : ''} (${wsLoose.join(', ')})` : ''),
  });
  // Guard D sentinels (.owner.lock / .owner.hb.*) live in the bundle dir but are explicitly
  // NOT CD-7 state — committing them would ship a stale lock to every clone. The prose's
  // `add docs/masterplan/<slug>` swept them latently; the code excludes them by pathspec.
  const bundleRel = path.relative(MAIN, bundleDir) || '.';
  const statePathspec = [bundleRel, `:(exclude)${bundleRel}/.owner*`];
  let stateSha = null;
  if (runGit(MAIN, ['status', '--porcelain', '--', ...statePathspec])) {
    runGit(MAIN, ['add', '--', ...statePathspec]);
    runGit(MAIN, ['commit', '-q', '-m', `masterplan(${nextState.slug}): wave ${wave} state (${mode})`, '--', ...statePathspec]);
    stateSha = runGit(MAIN, ['rev-parse', 'HEAD']);
  }

  // 7. The transaction is durable; `next` is advisory. decideNextAction can throw on
  //    malformed state — never throw away the recorded payload over the advisory tail.
  let next;
  try {
    next = decideNextAction(nextState, { alive: false });
  } catch (err) {
    next = { action: 'error', error: err.message };
  }

  return {
    outcome: 'recorded',
    mode,
    wave,
    recorded,
    failed,
    qctl,
    blocking_reviews,
    scope: { ok: scope.ok, touched: scope.touched, outOfScope: scope.outOfScope },
    reverted,
    wsLoose,
    commits: { code: codeSha, state: stateSha },
    cleared,
    next,
  };
}
