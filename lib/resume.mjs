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
// real durability hazard, not write-vs-commit. Execute-wave markers carry a wave:
//   phase 1 (pre-launch):  { wave, phase: 'launching' }     written BEFORE launch, no task_id yet
//   phase 2 (post-launch): { wave, run_id, task_id }        promoted AFTER launch returns handles
// Planning-run markers are discriminated and carry NO wave:
//   phase 1 (pre-launch):  { kind:'plan', phase:'launching' }
//   phase 2 (post-launch): { kind:'plan', run_id, task_id }
// A crash between the two leaves a phase-1 marker (no task_id) → we can't probe → treat as
// crashed-in-launch and recover. This is what stops a double-dispatch onto the same files.
//
// Completion is DERIVED FROM DISK, not a probe: "results recorded" == "every task of the run's
// wave is `done` in state.yml" (the task status IS the record). So the ONLY external probe the
// shell passes is `alive`; finalize-vs-recover is otherwise deterministic over state (goals 2/3).
//
// Inputs:
//   state: { pending_gate: null|{id,opened_at},
//            active_run: null|{wave, phase?:'launching', run_id?, task_id?}
//                        |{kind:'plan', phase:'launching'}|{kind:'plan', run_id, task_id},
//            tasks: [{ id, wave, status:'pending'|'done', files:[] }],
//            coordination?: { mode, current_wave, issue_map: { [task_id]: ... }, ... } }
//   liveness: { alive?: bool }   — only meaningful when active_run has a task_id to probe
//
// Returns one of:
//   { action: 'surface_gate', gate }                                  — re-surface an open gate
//   { action: 'wait', run }                                           — in-flight run still live
//   { action: 'finalize_run', run }                                   — wave's tasks all done on disk
//   { action: 'recover_and_redispatch', wave, tasks, resetPaths, staleTaskId } — crash mid/pre-wave
//   { action: 'recover_plan_run', staleTaskId }                       — crash/dead planning run; re-run fan-out
//   { action: 'publish_needed', wave, tasks }                         — coordinated run: current wave has unpublished pending tasks
//   { action: 'coordinate', wave }                                    — coordinated run: fully published, tasks pending; halt local dispatch
//   { action: 'dispatch_wave', wave, tasks }                          — start the lowest pending wave
//   { action: 'resume_phase', phase, planning_mode }                  — pre-execute (brainstorm|plan) bundle, no plan built yet: hand to §3's named-phase lifecycle (NOT finalize)
//   { action: 'complete' }                                            — nothing left to execute
// The recover action's `staleTaskId` (null if it crashed before launch) is the handle the shell
// MUST reconcile (TaskList/TaskStop a possibly-surviving orphan) before resetting scope + re-
// dispatching — a backgrounded Workflow may outlive session death (unverified; step-4 drill).
// Throws if a pending task has a non-integer wave (the shell must backfill waves from
// plan.index.json first — see migrate.mjs's step-2 contract for just-migrated bundles), or if
// phase==='execute' with tasks:[] — an unseeded run whose plan was never loaded into state.tasks
// (the shell must `mp seed-tasks` before `set-phase execute`; §3 ordering). Finalizing it would
// archive a planned-but-unseeded run (data loss), so it fails loud like the non-integer-wave case.

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
    if (activeRun.kind === 'plan') {
      // A planning run has NO wave and NO disk-derivable completion — its fragments are recorded by
      // the L1 plan-completion protocol when the engine's result is in hand, never by decide. So decide
      // only waits on a live promoted run or recovers a dead/launching one. Re-running the fan-out is
      // idempotent (mp-subsystem-planner drafters are read-only — there is no file scope to reset).
      if (activeRun.task_id && alive) {
        return { action: 'wait', run: activeRun };
      }
      return { action: 'recover_plan_run', staleTaskId: activeRun.task_id ?? null };
    }
    const wave = activeRun.wave;
    // A well-formed marker ALWAYS carries an integer wave — phase-1 {wave,phase:'launching'} and
    // phase-2 {wave,run_id,task_id} both do. A wave-less/non-integer active_run is corrupt (most
    // likely a promote-active-run that ran with no phase-1 launching marker; bin guards that path
    // too). Without this, the filter below matches NOTHING, so a dead run would FINALIZE while its
    // wave's tasks are still pending — clearing the marker and opening a double-dispatch/orphan
    // window. Mirror the dispatch-branch guard below and fail loud.
    if (!Number.isInteger(wave)) {
      throw new Error(
        `decideNextAction: active_run has a non-integer wave (${wave}) — a promote-active-run ` +
          `without a phase-1 launching marker, or corrupt state. Refusing to finalize/recover ambiguously.`
      );
    }
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
  if (pending.length === 0) {
    // `complete` is an EXECUTE-phase concept: "every task ran and recorded done". A pre-execute
    // bundle (brainstorm|plan) with tasks:[] has no plan yet — there is nothing to finalize.
    // Returning `complete` here would ARCHIVE a mid-design run (data loss) AND make a bare
    // `/masterplan` resume of an in-progress brainstorm/plan impossible. Hand off to §3's named-
    // phase lifecycle instead. (tasks.length===0 ⟺ no plan built yet; tasks are never removed, so
    // a phase:plan bundle that DID build tasks and ran them all `done` still finalizes below — the
    // `complete` semantics belong to disk, not the phase label. A phaseless/legacy bundle also
    // finalizes, preserving the read-only status/next path on completed & migrated runs.)
    const phase = state?.phase;
    if ((phase === 'brainstorm' || phase === 'plan') && tasks.length === 0) {
      return { action: 'resume_phase', phase, planning_mode: state?.planning_mode ?? 'auto' };
    }
    if (phase === 'execute' && tasks.length === 0) {
      // execute + tasks:[] is IMPOSSIBLE under correct operation (§3 loads tasks via `mp seed-tasks`
      // BEFORE `set-phase execute`). It only arises when that ordering was violated — a hand-edited,
      // migrated, or --force-phased bundle. Unlike brainstorm|plan above (a normal, resumable mid-
      // design state), this is corruption: returning `complete` would silently ARCHIVE a run whose
      // plan.index was never seeded into state.tasks — the plan's work abandoned as "done" (data
      // loss). decide can't read plan.index from here, so it can't tell "unseeded" from "genuinely
      // empty"; both are degenerate and must not auto-finalize. Fail loud, like the wave guard below.
      throw new Error(
        `decideNextAction: phase is 'execute' but state.tasks is empty — the plan was never loaded ` +
          `into state.tasks. Run \`mp seed-tasks\` before \`mp set-phase --phase=execute\` (§3 ordering). ` +
          `Refusing to finalize an unseeded run.`
      );
    }
    return { action: 'complete' };
  }
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
  const waveTasks = pending.filter((task) => task.wave === wave);

  // 4. Coordination gate — only fires when a `coordination` state object is present (§7.4).
  //    Uncoordinated runs skip this block entirely (byte-identical decisions — A9).
  const coordination = state?.coordination ?? null;
  if (coordination != null) {
    const issueMap = coordination.issue_map ?? {};
    // Tasks in the current wave that have no entry in issue_map are "unpublished".
    const unpublished = waveTasks.filter((task) => issueMap[String(task.id)] == null);
    if (unpublished.length > 0) {
      // publish_needed: recover a partial/failed publish rather than stranding the run.
      // Fires BEFORE coordinate — ordering (A7).
      return { action: 'publish_needed', wave, tasks: unpublished };
    }
    // All wave tasks are published (all in issue_map) but still pending locally.
    // Halt local dispatch — never dispatch_wave — and point the operator at /masterplan next.
    return { action: 'coordinate', wave };
  }

  return {
    action: 'dispatch_wave',
    wave,
    tasks: waveTasks,
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
