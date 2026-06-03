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
//   qctlEligible(task, reposAllowlist) -> bool
//     PURE eligibility predicate for the {kind:'qctl'} backend. Receives an ALREADY-PARSED
//     allowlist object (keyed by repo name; values have {scope:[...globs]}). Does NOT read
//     or author any YAML — the caller owns loading. A task is eligible only when ALL of:
//       - verify_commands is non-empty
//       - task is not sensitive
//       - no file touches infra paths (systemd/router/serving/CI/secrets/mp internals)
//       - all files fall within the scope globs of at least one allowlist entry
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

// Infra path segments whose presence makes a task NEVER eligible for qctl, regardless of
// allowlist. Mirrors repos.yml header: "systemd units, router/serving profiles, CI/CD config,
// secrets, mp/masterplan internals." Checked against the lowercased file path.
const INFRA_RE =
  /\b(systemd|\.service|\.timer|router|serving|\.github|ci\.yml|cd\.yml|ci\/|\.secrets?|secrets?\/|masterplan|\/mp\/)\b/;

// Minimal glob matcher for repos.yml scope entries. Supports:
//   "path/to/dir"     — exact match OR match as ancestor prefix ("path/to/dir/sub.js")
//   "path/to/dir/**"  — match anything under path/to/dir/
function globMatches(glob, file) {
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3); // strip "/**"
    return file === prefix || file.startsWith(prefix + '/');
  }
  // Plain path: exact OR the file is under it as a directory prefix
  return file === glob || file.startsWith(glob + '/');
}

// Returns true iff all `files` are covered by at least one allowlist entry's scope globs.
function filesInAllowlist(files, reposAllowlist) {
  const entries = Object.values(reposAllowlist ?? {});
  return files.every((file) =>
    entries.some((entry) =>
      (entry.scope ?? []).some((glob) => globMatches(glob, file))
    )
  );
}

// qctlEligible: the §6.3 eligibility predicate. Pure — no I/O.
// reposAllowlist: parsed repos.yml object (keyed by repo name) or undefined/null.
export function qctlEligible(task = {}, reposAllowlist) {
  const files = task.files ?? [];

  // Must have verify commands (a task with no verification cannot be safely offloaded).
  if ((task.verify_commands ?? []).length === 0) return false;

  // Sensitive tasks stay with Claude/Codex.
  if (task.sensitive === true) return false;

  // Infra paths are NEVER eligible — hard override even if scope glob would cover them.
  if (files.some((f) => INFRA_RE.test(String(f).toLowerCase()))) return false;

  // All files must fall within at least one allowlist entry's scope globs.
  if (!filesInAllowlist(files, reposAllowlist)) return false;

  return true;
}

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

// Wraps resolveImplementerBackend with the qctlEligible gate.
// Short-circuits on flag-off BEFORE touching reposAllowlist (flag-off first build: no allowlist).
function resolveBackend(task, config, env, reposAllowlist) {
  const backend = resolveImplementerBackend(task, config, env);
  // Short-circuit: if the flag is not strictly true, the allowlist is never consulted.
  if (config.implementer?.qctl?.enabled !== true) return backend;
  // Flag is on but eligibility predicate rejects this task → downgrade to {kind:'agent'}.
  if (backend.kind === 'qctl' && !qctlEligible(task, reposAllowlist)) {
    return { kind: 'agent' };
  }
  return backend;
}

export function prepareWave(state = {}, planIndex = {}, wave, config = {}, env = {}, reposAllowlist) {
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
    return leanPayload(st, p, routeTask(merged, config, env), resolveBackend(merged, config, env, reposAllowlist));
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
