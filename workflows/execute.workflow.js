// workflows/execute.workflow.js — the L2 within-session execution engine (build step 4).
//
// A Workflow-tool script: it runs under the Workflow runtime, NOT plain node, and
// uses the agent()/parallel()/pipeline()/phase()/log()/budget globals. It does ALL
// dispatching itself — agents never spawn agents (one-level nesting cap).
//
// Responsibilities (the largest prose->JS conversion; source: v7 parts/step-c-dispatch.md):
//   - consume lib/routing.mjs to pick codex vs inline per task
//   - assemble waves -> parallel(thunks) -> barrier -> return digests UP
//   - linked-worktree guard; codex silent-exit fallback (declared edits, empty diff)
//   - 2-stage review (spec + quality) as explicit agent() calls, not a nested skill
//
// INVARIANT: returns digests only. NEVER writes state.yml, NEVER commits — L1 (the
// shell) is the single durable writer, post-barrier. This is what keeps crash
// re-dispatch idempotent.
export const meta = {
  name: 'masterplan-execute',
  description: 'masterplan wave/parallel execution engine (stub — build step 4)',
  phases: [
    { title: 'Dispatch', detail: 'route + run each wave via parallel()' },
    { title: 'Review', detail: 'spec + quality review per task' },
  ],
};

// TODO(step 4): implement against lib/routing.mjs; verify the Workflow per-agent
// telemetry fields here (Resolved #5) before deleting the v7 telemetry hook.
log('masterplan-execute: stub — not yet implemented (build step 4)');
