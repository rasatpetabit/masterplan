// lib/wave.mjs — wave preparation + post-barrier scope verification (build step 4).
//
// Two pure helpers (+ one tiny derivation) that BRACKET the L2 Workflow engine, so the
// engine stays a dumb dispatch pipe and ALL decidable logic lives here in tested L1 code
// (design goals 2/3: deterministic, zero-LLM-token, unit-tested — never re-interpreted prose):
//
//   prepareWave(state, planIndex, wave, config, env) -> { wave, tasks: [routed payload] }
//     Merges each wave-N PENDING task's state fields {id,wave,status,files} with its
//     plan.index.json fields {description,verify_commands,codex,sensitive,conversational},
//     runs routeTask (lib/routing.mjs) over the merge, and emits a LEAN per-task payload the
//     shell passes to the workflow via `args`. A Workflow script has no module/fs access, so
//     "L2 consumes routing.mjs" can ONLY mean L1 pre-resolves routing HERE — this is that.
//     The pending filter mirrors decideNextAction's dispatch_wave/recover task set exactly.
//
//   declaredScope(state, wave) -> [files]
//     The union of EVERY wave-N task's declared files — done included. At the post-barrier
//     moment nothing is committed yet (agents never commit), so a task that finished earlier
//     in this same wave still has uncommitted edits in its declared files; they are allowed.
//
//   verifyScope(declared, before, after) -> { ok, touched, outOfScope }
//     The D6/F-SCOPE post-barrier check. The spike found agents may write OUTSIDE their cwd-
//     relative scope; the shell captures the git-touched path set before launch and after the
//     barrier, and this computes (after - before) and flags anything not `declared`. Git runs
//     in the shell (bin is fs-only); the set math is tested here.

import { routeTask, resolveImplementerBackend } from './routing.mjs';

// What the workflow actually needs per task + the routing decision. NEVER spec excerpts or
// file contents — this payload transits the orchestrator context (goal 3).
function leanPayload(stateTask, planTask, route, backend) {
  return {
    id: stateTask.id,
    description: planTask.description ?? '',
    files: planTask.files ?? stateTask.files ?? [],
    verify_commands: planTask.verify_commands ?? [],
    target: route.target,
    eligible: route.eligible,
    reason: route.reason,
    backend,
  };
}

export function prepareWave(state = {}, planIndex = {}, wave, config = {}, env = {}) {
  // Mirror the integer-wave invariant the rest of the pipeline enforces (set-active-run,
  // decideNextAction): a string/float wave matches NOTHING in the filter below, which would
  // silently emit an empty wave. Fail loud at the source instead.
  if (!Number.isInteger(wave)) {
    throw new Error(`prepareWave: wave must be an integer (got ${JSON.stringify(wave)}).`);
  }
  const list = Array.isArray(planIndex) ? planIndex : Array.isArray(planIndex?.tasks) ? planIndex.tasks : [];
  // Key by STRING id (plan.index ids are often "1"; state ids are 1) — same normalization as
  // applyPlanIndex, so the lookup is type-insensitive.
  const byId = new Map(list.map((p) => [String(p.id ?? p.idx), p]));
  // SAME set decideNextAction dispatches: this wave's not-yet-done tasks.
  const pending = (state.tasks ?? []).filter((t) => t.wave === wave && t.status !== 'done');
  const tasks = pending.map((st) => {
    const p = byId.get(String(st.id));
    // A wave task with no plan.index entry can't be routed or described — that's plan/state
    // drift. Fail loud (mirror backfill-waves) rather than dispatch a description-less no-op.
    if (!p) {
      throw new Error(
        `prepareWave: task ${JSON.stringify(st.id)} (wave ${wave}) has no plan.index.json entry — ` +
          `cannot resolve its description/verify_commands/routing. Re-run the planner or rebuild plan.index.json.`
      );
    }
    // Merge for routing: state owns {id,wave,status,files}; plan.index owns the exec/routing
    // fields routeTask reads (files/description/verify_commands/codex/sensitive/conversational).
    const merged = {
      files: p.files ?? st.files ?? [],
      description: p.description,
      verify_commands: p.verify_commands ?? [],
      codex: p.codex ?? null,
      sensitive: p.sensitive,
      conversational: p.conversational,
    };
    return leanPayload(st, p, routeTask(merged, config, env), resolveImplementerBackend(merged, config, env));
  });
  return { wave, tasks };
}

export function declaredScope(state = {}, wave) {
  return (state.tasks ?? [])
    .filter((t) => t.wave === wave)
    .flatMap((t) => t.files ?? []);
}

export function verifyScope(declared = [], before = [], after = []) {
  const baseline = new Set(before);
  const allow = new Set(declared);
  // (after - before): paths the wave INTRODUCED. The pre-launch baseline (user-owned dirty
  // files + masterplan's own bundle writes) is pre-existing and not a wave scope violation.
  const touched = after.filter((p) => !baseline.has(p));
  // Anything touched-but-not-declared is the F-SCOPE breach: an agent wrote outside its scope.
  const outOfScope = touched.filter((p) => !allow.has(p));
  return { ok: outOfScope.length === 0, touched, outOfScope };
}
