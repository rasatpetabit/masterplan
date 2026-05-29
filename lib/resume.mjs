// lib/resume.mjs — the L1 control-loop decision core (build step 1).
//
// decideNextAction(state, liveness) -> { action, ... } is a PURE function: no I/O,
// no Date.now()/Math.random(), no LLM in the loop. It is what moves the
// resume/crash/gate logic OUT of orchestrator prose (design goals 2 & 3) and makes
// the control loop unit-testable. The shell (L1) gathers `state` (from state.yml) and
// `liveness` (by probing the active run + checking disk), calls this, and executes the
// returned action — it never re-derives the decision in prose.
//
// Empirical grounding: docs/spike-0.5-findings.md.
//   - D1: active_run = { run_id, task_id, wave } — both handles + the wave it runs.
//   - D2/F3: a dead run is merely ABSENT from the task registry; absence is ambiguous,
//     so `liveness.resultsRecorded` (a disk check) is the done-vs-dead tiebreaker.
//   - F2/Resolved #2: a crashed wave leaves only uncommitted edits (agents never commit),
//     so recovery = reset the incomplete tasks' declared scope, then re-dispatch.
//
// Inputs:
//   state: { pending_gate: null|{id,opened_at}, active_run: null|{run_id,task_id,wave},
//            tasks: [{ id, wave, status:'pending'|'done', files:[] }] }
//   liveness (only consulted when active_run is set): { alive: bool, resultsRecorded: bool }
//
// Returns one of:
//   { action: 'surface_gate', gate }                         — re-surface an open approval gate
//   { action: 'wait', run }                                  — in-flight run still live
//   { action: 'finalize_run', run }                          — run done, results on disk, clear marker
//   { action: 'recover_and_redispatch', wave, tasks, resetPaths } — crash mid-wave
//   { action: 'dispatch_wave', wave, tasks }                 — start the lowest pending wave
//   { action: 'complete' }                                   — nothing left to execute
// Throws if a pending task has a non-integer wave (the shell must backfill waves from
// plan.index.json first — see migrate.mjs's step-2 contract for just-migrated bundles).

export function decideNextAction(state = {}, liveness = {}) {
  const pendingGate = state?.pending_gate ?? null;
  const activeRun = state?.active_run ?? null;
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const alive = !!liveness?.alive;
  const resultsRecorded = !!liveness?.resultsRecorded;

  // 1. An open approval gate is a hard stop — regardless of autonomy mode or run state
  //    (Resolved #1: a native AUQ can't survive compaction; the durable marker must win).
  if (pendingGate) {
    return { action: 'surface_gate', gate: pendingGate };
  }

  // 2. A wave was dispatched (active_run set). Decide from liveness + the disk tiebreaker.
  if (activeRun) {
    if (alive) return { action: 'wait', run: activeRun };
    if (resultsRecorded) return { action: 'finalize_run', run: activeRun };
    // Dead, no results recorded => crash mid-wave. Reset the incomplete tasks' declared
    // file scope, then re-dispatch them (idempotent because agents never commit — F2).
    const wave = activeRun.wave;
    const incomplete = tasks.filter((task) => task.wave === wave && task.status !== 'done');
    return {
      action: 'recover_and_redispatch',
      wave,
      tasks: incomplete,
      resetPaths: incomplete.flatMap((task) => task.files ?? []),
    };
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
