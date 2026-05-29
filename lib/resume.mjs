// lib/resume.mjs — the L1 control-loop decision core (build step 1; lifecycle hardened in step 2).
//
// decideNextAction(state, liveness) -> { action, ... } is a PURE function: no I/O,
// no Date.now()/Math.random(), no LLM in the loop. It is what moves the
// resume/crash/gate logic OUT of orchestrator prose (design goals 2 & 3) and makes
// the control loop unit-testable. The shell (L1) gathers `state` (from state.yml) and
// the single external probe `alive` (TaskGet on the run), calls this, and executes the
// returned action — it never re-derives the decision in prose.
//
// Empirical grounding: docs/spike-0.5-findings.md.
//   - D1/F1: a Workflow launch returns BOTH a run_id and a task_id (together, after launch).
//   - D2/F3: a dead run is merely ABSENT from the task registry; absence is ambiguous.
//   - F2/Resolved #2: a crashed wave leaves only uncommitted edits (agents never commit),
//     so recovery = reset the incomplete tasks' declared scope, then re-dispatch (idempotent).
//
// active_run is a TWO-PHASE marker (step-2 contract, advisor-hardened) — the launch-gap is the
// real durability hazard, not write-vs-commit:
//   phase 1 (pre-launch):  { wave, phase: 'launching' }     written BEFORE launch, no task_id yet
//   phase 2 (post-launch): { wave, run_id, task_id }        promoted AFTER launch returns handles
// A crash between the two leaves a phase-1 marker (no task_id) → we can't probe → treat as
// crashed-in-launch and recover. This is what stops a double-dispatch onto the same files.
//
// Completion is DERIVED FROM DISK, not a probe: "results recorded" == "every task of the run's
// wave is `done` in state.yml" (the task status IS the record). So the ONLY external probe the
// shell passes is `alive`; finalize-vs-recover is otherwise deterministic over state (goals 2/3).
//
// Inputs:
//   state: { pending_gate: null|{id,opened_at},
//            active_run: null|{wave, phase?:'launching', run_id?, task_id?},
//            tasks: [{ id, wave, status:'pending'|'done', files:[] }] }
//   liveness: { alive?: bool }   — only meaningful when active_run has a task_id to probe
//
// Returns one of:
//   { action: 'surface_gate', gate }                                  — re-surface an open gate
//   { action: 'wait', run }                                           — in-flight run still live
//   { action: 'finalize_run', run }                                   — wave's tasks all done on disk
//   { action: 'recover_and_redispatch', wave, tasks, resetPaths, staleTaskId } — crash mid/pre-wave
//   { action: 'dispatch_wave', wave, tasks }                          — start the lowest pending wave
//   { action: 'complete' }                                            — nothing left to execute
// The recover action's `staleTaskId` (null if it crashed before launch) is the handle the shell
// MUST reconcile (TaskList/TaskStop a possibly-surviving orphan) before resetting scope + re-
// dispatching — a backgrounded Workflow may outlive session death (unverified; step-4 drill).
// Throws if a pending task has a non-integer wave (the shell must backfill waves from
// plan.index.json first — see migrate.mjs's step-2 contract for just-migrated bundles).

export function decideNextAction(state = {}, liveness = {}) {
  const pendingGate = state?.pending_gate ?? null;
  const activeRun = state?.active_run ?? null;
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const alive = !!liveness?.alive;

  // 1. An open approval gate is a hard stop — regardless of autonomy mode or run state
  //    (Resolved #1: a native AUQ can't survive compaction; the durable marker must win).
  if (pendingGate) {
    return { action: 'surface_gate', gate: pendingGate };
  }

  // 2. A wave is (or was) in flight. Resolve via the two-phase marker + the single `alive` probe,
  //    with completion derived from disk.
  if (activeRun) {
    const wave = activeRun.wave;
    const incomplete = tasks.filter((task) => task.wave === wave && task.status !== 'done');

    // Phase-1 marker (no task_id): crashed before/at launch — nothing to probe or reconcile.
    if (!activeRun.task_id) {
      return recover(wave, incomplete, null);
    }
    // Promoted run: a live run is left alone (it will notify on completion).
    if (alive) {
      return { action: 'wait', run: activeRun };
    }
    // Dead. Completion is on disk: all of the wave's tasks done => finalize (clear the marker).
    if (incomplete.length === 0) {
      return { action: 'finalize_run', run: activeRun };
    }
    // Dead with work outstanding => reset scope + re-dispatch, after reconciling staleTaskId.
    return recover(wave, incomplete, activeRun.task_id);
  }

  // 3. No gate, no in-flight run: dispatch the lowest-numbered wave that still has pending work.
  const pending = tasks.filter((task) => task.status !== 'done');
  if (pending.length === 0) return { action: 'complete' };
  // A pending task with a non-integer wave means waves haven't been backfilled — e.g. a just-
  // migrated legacy bundle carries wave:null until the shell re-derives waves from plan.index.json
  // (migrate.mjs step-2 contract). Math.min(null,…) coerces to 0, but `wave === 0` then matches
  // NOTHING, so the dispatch would be a SILENT empty wave and the run would stall. Fail loud.
  const unscheduled = pending.find((task) => !Number.isInteger(task.wave));
  if (unscheduled) {
    throw new Error(
      `decideNextAction: pending task ${unscheduled.id} has a non-integer wave ` +
        `(${unscheduled.wave}) — backfill waves from plan.index.json before resume.`
    );
  }
  const wave = Math.min(...pending.map((task) => task.wave));
  return {
    action: 'dispatch_wave',
    wave,
    tasks: pending.filter((task) => task.wave === wave),
  };
}

function recover(wave, incomplete, staleTaskId) {
  return {
    action: 'recover_and_redispatch',
    wave,
    tasks: incomplete,
    resetPaths: incomplete.flatMap((task) => task.files ?? []),
    staleTaskId,
  };
}
