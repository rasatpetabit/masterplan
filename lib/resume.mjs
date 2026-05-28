// lib/resume.mjs — the L1 control-loop decision core (build step 1, TDD-first).
//
// decideNextAction(state, liveness) -> { action, ... } is a PURE function: no I/O,
// no Date.now()/Math.random(), no LLM in the loop. This is what moves the
// resume/crash/gate logic OUT of orchestrator prose (design goals 2 & 3) and
// makes the control loop unit-testable.
//
//   pending_gate non-null              -> { action: 'surface_auq', gate }
//   active_run_id set & live           -> { action: 'wait' }
//   active_run_id set & dead/no-result -> { action: 'reset_and_redispatch', tasks }
//   incomplete tasks, no active run    -> { action: 'dispatch_wave', wave }
//   all tasks complete                 -> { action: 'finish' }
// TODO(step 1): implement + exhaustive node:test branch coverage.
export {};
