// lib/wave.mjs — wave preparation + post-barrier scope verification (build step 4).
//
// Two pure helpers (+ one tiny derivation) that BRACKET the L2 Workflow engine, so the
// engine stays a dumb dispatch pipe and ALL decidable logic lives here in tested L1 code
// (design goals 2/3: deterministic, zero-LLM-token, unit-tested — never re-interpreted prose):
//
//   prepareWave(state, planIndex, wave, config, env) -> { wave, tasks: [routed payload] }
//     Merges each wave-N PENDING task's state fields {id,wave,status,files} with its
//     plan.index.json fields {description,verify_commands,codex,sensitive,conversational},
//     runs routeTask (lib/dispatch/routing.mjs) over the merge, and emits a LEAN per-task payload
//     the shell passes to the workflow via `args`. A Workflow script has no module/fs access, so
//     "L2 consumes the dispatch module" can ONLY mean L1 pre-resolves routing HERE — this is that.
//     The pending filter mirrors decideNextAction's dispatch_wave/recover task set exactly.
//     Each task's dispatch files are RESOLVED once (plan.index wins when it declares any, else
//     state's) and reused for routing, the payload, AND verifyScope (via declaredScope) so dispatch
//     and the F-SCOPE allow-set can never disagree. Two dispatch-time gates fail loud BEFORE launch:
//     a plan-vs-state file-set divergence (drift), and checkWaveDisjoint over the resolved sets.
//
//   checkWaveDisjoint(resolvedTasks) -> { ok, conflicts: [{ a, b, shared }] }
//     PURE pairwise overlap check over the RESOLVED per-task file sets. validatePlanIndex already
//     lints plan.index.json overlaps, but prepareWave dispatches the plan/state-MERGED files — an
//     overlap that only emerges after the merge (plan-side omitted, state-side collides) is invisible
//     to that lint. prepareWave composes this and throws on any conflict, gating BEFORE dispatch.
//
//   declaredScope(state, wave, planIndex?) -> [files]
//     The union of EVERY wave-N task's RESOLVED files — done included. At the post-barrier moment
//     nothing is committed yet (agents never commit), so a task that finished earlier in this same
//     wave still has uncommitted edits in its declared files; they are allowed. Passed the optional
//     planIndex it resolves each task's files the SAME way prepareWave dispatched them (plan-wins-
//     when-present); omit it and it falls back to state.tasks[].files — byte-identical to the old
//     2-arg call, so existing callers are unaffected while the F-SCOPE allow-set tracks dispatch.
//
//   verifyScope(declared, before, after) -> { ok, touched, outOfScope }
//     The D6/F-SCOPE post-barrier check. The spike found agents may write OUTSIDE their cwd-
//     relative scope; the shell captures the git-touched path set before launch and after the
//     barrier, and this computes (after - before) and flags anything not `declared`. Git runs
//     in the shell (bin is fs-only); the set math is tested here.

// Routing/backend/eligibility decisions live in lib/dispatch/ (the consolidated agent-dispatch
// module); this module is their wave-shaped consumer. qctlEligible is re-exported for the
// callers that historically imported it from here.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { routeTask, resolveTaskBackend, qctlEligible } from './dispatch/index.mjs';
// The pure handoff-idempotency module (spec §5.5): environmental facts are captured shell-side
// HERE (captureInputFingerprint) and passed in as plain data — the module never shells out.
import { computeTaskSpecHash, computeInputFingerprint, composeHandoffKey } from './adsp-idempotency.mjs';

export { qctlEligible };

// ---- input-fingerprint capture (spec §5.5 frozen dispatch record) ----------------------------
//
// Captured ONCE at work-item launch time, alongside the immutable F-SCOPE scope snapshot, so the
// handoff key binds each dispatched task to the exact repo + policy/worker state it launched
// against. Shell-side by design (adsp-idempotency is pure); git is -C-qualified and injectable
// (`_exec`) following the runGit idiom in wave-commit.mjs. Deterministic for an unchanged tree:
// the dirty digest is a stable sha256 over `git status --porcelain` + the diff of tracked
// changes — the payload carries fingerprint fields, never raw diffs.
export function captureInputFingerprint(worktreeDir, { policyVersion = '', workerVersion = '' } = {}, _exec = execFileSync) {
  const git = (args) => {
    try {
      return String(_exec('git', ['-C', worktreeDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    } catch (err) {
      const stderr = String(err?.stderr ?? '').trim();
      throw new Error(`captureInputFingerprint: git -C ${worktreeDir} ${args.join(' ')} failed: ${stderr || err.message}`);
    }
  };
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  // Tracked-change content: an unchanged tree yields identical bytes → identical digest.
  const diff = status ? git(['diff', 'HEAD']) : '';
  const dirtyDigest = status
    ? createHash('sha256').update(`${status}\n${diff}`, 'utf8').digest('hex')
    : '';
  return { head, dirtyDigest, policyVersion: String(policyVersion), workerVersion: String(workerVersion) };
}

// What the workflow actually needs per task + the routing decision. NEVER spec excerpts or
// file contents — this payload transits the orchestrator context (goal 3).
function leanPayload(stateTask, planTask, route, backend, files) {
  return {
    id: stateTask.id,
    description: planTask.description ?? '',
    files,
    verify_commands: planTask.verify_commands ?? [],
    target: route.target,
    eligible: route.eligible,
    reason: route.reason,
    backend,
  };
}

// ---- fabric-mode routing (strangler phase flag: state.dispatch.fabric / config.fabric) --------
//
// Under the fabric phase flag, model selection no longer runs through masterplan's DUPLICATED
// routing brain (routeTask/resolveTaskBackend in lib/dispatch/). Instead each task carries only its
// dispatch `class`; the adsp seam adapter (lib/dispatch/adsp-adapter.mjs dispatchTask) hands that
// class to the broker, whose core resolve/guard picks the concrete model — one routing brain, not
// two. This is the SAME strangler phase flag that gates the wave dispatch op (buildWaveDispatchOp's
// `fabric` branch, sourced from state.dispatch.fabric); rollback is flipping the flag off, which
// restores the legacy routeTask/resolveTaskBackend payload below byte-for-byte. Deletion of the
// duplicated routing modules is DEFERRED to a post-soak follow-up run (spec §7 flag-then-soak-then-delete).
const FABRIC_DEFAULT_CLASS = 'bounded-edit';

// Resolve the dispatch CLASS the seam hands to core resolve/guard. plan.index may pin a task `class`;
// otherwise the masterplan-worker default (a bounded, file-scoped edit). NO codex/inline/backend
// decision is made here — that is exactly the routing that moves to core under the seam.
function resolveTaskClass(planTask) {
  const c = planTask?.class;
  return typeof c === 'string' && c.length ? c : FABRIC_DEFAULT_CLASS;
}

// The lean fabric payload: only what the seam adapter consumes. NO target/eligible/reason/backend —
// those are resolved downstream by core resolve/guard, not pre-baked here.
function fabricPayload(stateTask, planTask, taskClass, files) {
  return {
    id: stateTask.id,
    description: planTask.description ?? '',
    files,
    verify_commands: planTask.verify_commands ?? [],
    class: taskClass,
  };
}

// ---- dispatch file-set resolution + disjointness (the dispatch-time concurrency guards) ------
//
// Each task's files appear in BOTH plan.index.json (the planner's current intent) and
// state.tasks[].files (seeded from the plan; the fallback). prepareWave RESOLVES them to ONE set and
// reuses it for routing, the dispatched payload, AND the launch-time F-SCOPE scope snapshot — so the
// scope an agent is dispatched with and the scope F-SCOPE later polices are provably the same set.
const fileList = (x) => (Array.isArray(x) ? x : []);
const sameFileSet = (a, b) => {
  const sa = new Set(fileList(a));
  const sb = new Set(fileList(b));
  return sa.size === sb.size && [...sa].every((f) => sb.has(f));
};

// Dispatch-time resolver: plan-side wins when present, else state-side, but FAIL LOUD when BOTH sides
// declare files that DISAGREE. That is plan/state drift — dispatching one scope while verifyScope
// polices another — so it mirrors the no-plan-entry throw rather than silently trusting one side.
function resolveDispatchFiles(planFiles, stateFiles, id, wave) {
  const pf = fileList(planFiles);
  const sf = fileList(stateFiles);
  if (pf.length && sf.length && !sameFileSet(pf, sf)) {
    throw new Error(
      `prepareWave: task ${JSON.stringify(id)} (wave ${wave}) has divergent file sets — ` +
        `plan.index.json [${pf.join(', ')}] vs state.yml [${sf.join(', ')}]. Re-run the planner or ` +
        `reconcile state.tasks[].files so dispatch and F-SCOPE agree.`
    );
  }
  return pf.length ? pf : sf;
}

// checkWaveDisjoint: PURE pairwise overlap over the RESOLVED file sets. Returns every colliding pair
// so the shell can surface a precise pre-dispatch gate. prepareWave composes this and throws on !ok.
export function checkWaveDisjoint(resolvedTasks = []) {
  const list = Array.isArray(resolvedTasks) ? resolvedTasks : [];
  const conflicts = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const setB = new Set(fileList(list[j].files));
      const shared = fileList(list[i].files).filter((f) => setB.has(f));
      if (shared.length) conflicts.push({ a: list[i].id, b: list[j].id, shared });
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

// `dispatchInputs` (optional, 7th arg): the launch-time capture from captureInputFingerprint plus
// the run id — { runId, head, dirtyDigest, policyVersion, workerVersion }. When present, each
// task payload gains a LEAN `idempotency` block (task_spec_hash, input_fingerprint, handoff_key —
// hashes only, never raw diffs) computed via the pure adsp-idempotency module, and the wave result
// carries `input_fingerprint` for the frozen dispatch record (spec §5.5). Omitted → payload and
// return shape are byte-identical to the pre-fingerprint contract.
export function prepareWave(state = {}, planIndex = {}, wave, config = {}, env = {}, reposAllowlist, dispatchInputs) {
  // Mirror the integer-wave invariant the rest of the pipeline enforces (set-active-run,
  // decideNextAction): a string/float wave matches NOTHING in the filter below, which would
  // silently emit an empty wave. Fail loud at the source instead.
  if (!Number.isInteger(wave)) {
    throw new Error(`prepareWave: wave must be an integer (got ${JSON.stringify(wave)}).`);
  }
  // Strangler phase flag — SAME source as the wave dispatch op (buildWaveDispatchOp's `fabric`
  // branch reads state.dispatch?.fabric). When set, routing is DEFERRED to core resolve/guard via
  // the adsp seam adapter; when unset, the legacy routeTask/resolveTaskBackend path runs unchanged.
  const fabric = config?.fabric === true || state?.dispatch?.fabric === true;
  const list = Array.isArray(planIndex) ? planIndex : Array.isArray(planIndex?.tasks) ? planIndex.tasks : [];
  // Key by STRING id (plan.index ids are often "1"; state ids are 1) — same normalization as
  // applyPlanIndex, so the lookup is type-insensitive.
  const byId = new Map(list.map((p) => [String(p.id ?? p.idx), p]));
  // SAME set decideNextAction dispatches: this wave's not-yet-done tasks.
  const pending = (state.tasks ?? []).filter(
    (t) => t.wave === wave && t.status !== 'done' && t.status !== 'blocked' && t.status !== 'waived'
  );
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
    // Resolve the dispatch file set ONCE (plan-wins-when-present; throws on plan/state divergence) and
    // reuse it for routing, the payload, AND declaredScope — so dispatch scope === the F-SCOPE allow-set.
    const files = resolveDispatchFiles(p.files, st.files, st.id, wave);
    // Merge for routing: state owns {id,wave,status,files}; plan.index owns the exec/routing
    // fields routeTask reads (files/description/verify_commands/codex/sensitive/conversational).
    const merged = {
      files,
      description: p.description,
      verify_commands: p.verify_commands ?? [],
      codex: p.codex ?? null,
      sensitive: p.sensitive,
      conversational: p.conversational,
    };
    // Fabric phase: defer routing to core resolve/guard via the seam — carry only the class.
    if (fabric) {
      return fabricPayload(st, p, resolveTaskClass(p), files);
    }
    // Legacy phase (flag off): masterplan pre-resolves target + backend via its own routing brain.
    return leanPayload(st, p, routeTask(merged, config, env), resolveTaskBackend(merged, config, env, reposAllowlist), files);
  });
  // Dispatch-time disjointness over the RESOLVED sets (NOT plan.index alone — validatePlanIndex lints
  // that). Fail loud BEFORE launch so two concurrent implementers can never collide on a shared file.
  const disjoint = checkWaveDisjoint(tasks.map((t) => ({ id: t.id, files: t.files })));
  if (!disjoint.ok) {
    throw new Error(
      `prepareWave: wave ${wave} tasks collide on shared file(s) at dispatch — ` +
        disjoint.conflicts.map((c) => `tasks ${c.a}+${c.b} share [${c.shared.join(', ')}]`).join('; ') +
        `. Re-wave the plan so same-wave tasks are file-disjoint before dispatch.`
    );
  }
  // The IMMUTABLE F-SCOPE allow-set snapshot: the union of every task's RESOLVED dispatch file set,
  // captured HERE at launch (before any agent runs). The shell persists it into active_run.scope so the
  // post-barrier verify-scope polices the SAME set it dispatched — it must NOT re-derive scope from
  // plan.index.json/state.yml after the wave, since a rogue agent could edit those mid-wave to widen its
  // own allow-set (the Codex tamper MAJOR). Computed off the resolved `tasks[].files`, so it is provably
  // identical to what each implementer was dispatched with.
  const scope = [...new Set(tasks.flatMap((t) => fileList(t.files)))];
  // Handoff-idempotency wiring (spec §5.5): only when the caller supplies the launch-time
  // dispatchInputs capture. Fingerprint is computed ONCE per wave (same repo/policy/worker state
  // for every task); the per-task spec hash covers exactly the lean body the worker receives plus
  // its dispatch-time routing context, so a replanned body OR a rerouted dispatch re-keys.
  if (dispatchInputs != null) {
    const { runId, head, dirtyDigest, policyVersion, workerVersion } = dispatchInputs;
    const inputFingerprint = computeInputFingerprint({ head, dirtyDigest, policyVersion, workerVersion });
    for (const t of tasks) {
      const taskSpecHash = computeTaskSpecHash({
        body: { id: t.id, description: t.description, files: t.files, verify_commands: t.verify_commands },
        context: fabric ? { class: t.class } : { target: t.target, backend: t.backend },
      });
      // LEAN block — hashes only, never raw diffs (goal 3: payload transits orchestrator context).
      t.idempotency = {
        task_spec_hash: taskSpecHash,
        input_fingerprint: inputFingerprint,
        handoff_key: composeHandoffKey(runId, t.id, taskSpecHash, inputFingerprint),
      };
    }
    return { wave, tasks, scope, input_fingerprint: inputFingerprint };
  }
  // dispatchInputs omitted → byte-identical legacy shape (no idempotency key, no fingerprint).
  return { wave, tasks, scope };
}

// State-only fallback allow-set, used by verify-scope ONLY when a launch-time active_run.scope snapshot
// is absent (a run that predates the snapshot field). The primary path passes the immutable snapshot
// instead — see prepareWave's `scope`. Deliberately does NOT read plan.index.json: re-reading a mutable
// artifact post-barrier is exactly the tamper hole the snapshot closes; for a legacy run with no
// snapshot, the seeded state.tasks[].files is the best available frozen-at-seed approximation.
export function declaredScope(state = {}, wave) {
  return (state.tasks ?? [])
    .filter((t) => t.wave === wave)
    .flatMap((t) => fileList(t.files));
}

export function verifyScope(declared = [], before = [], after = []) {
  const baseline = new Set(before);
  const allow = new Set(declared);
  // (after - before): paths the wave INTRODUCED. The pre-launch baseline (user-owned dirty
  // files + masterplan's own bundle writes) is pre-existing and not a wave scope violation.
  const touched = after.filter((p) => !baseline.has(p));
  // A declared entry ending in '/' is a DIRECTORY scope: every path under it is in scope
  // (plan tasks may own a whole new dir, e.g. test/classifier.fixtures/).
  const dirScopes = declared.filter((d) => d.endsWith('/'));
  const inScope = (p) => allow.has(p) || dirScopes.some((d) => p.startsWith(d));
  // Anything touched-but-not-declared is the F-SCOPE breach: an agent wrote outside its scope.
  const outOfScope = touched.filter((p) => !inScope(p));
  return { ok: outOfScope.length === 0, touched, outOfScope };
}
