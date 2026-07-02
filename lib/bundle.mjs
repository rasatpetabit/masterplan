// lib/bundle.mjs — the L0/L1 durable run-bundle reader/writer (build step 1).
//
// CD-7 single-writer: this is the ONLY module that writes state.yml. Wave members
// (L2 agents) never call it; the shell (L1) reads -> transforms -> writes, post-barrier.
//
// Canonical v8 state.yml format (a deliberate, plan-consistent choice — see
// docs/spike-0.5-findings.md context): FLAT, one `key: value` per line. Scalars are
// emitted bare (or quoted when ambiguous); objects/arrays are emitted as inline JSON,
// which is valid YAML flow. This is zero-dependency, line-diffable, type-preserving, and
// trivially round-trippable — it avoids a fragile indentation-sensitive block parser.
// Reading LEGACY v7 block-style bundles is migrate.mjs's job, not this module's.
import fs from 'node:fs';
import path from 'node:path';

// ---- parse / serialize -------------------------------------------------------

export function parseState(text) {
  const obj = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === '---' || trimmed.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) continue; // tolerate lines we don't model (e.g. stray legacy block content)
    obj[m[1]] = coerceValue(m[2]);
  }
  return obj;
}

function coerceValue(raw) {
  const v = raw.trim();
  if (v === '') return null;
  if (v === '""' || v === "''") return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  const c0 = v[0];
  if (c0 === '{' || c0 === '[' || c0 === '"') {
    try {
      return JSON.parse(v);
    } catch {
      return v; // not actually JSON — keep as a string
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function serializeState(obj) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(obj)) {
    lines.push(`${key}: ${emitValue(val)}`);
  }
  return lines.join('\n') + '\n';
}

function emitValue(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (val === '') return '""';
    // Quote strings that are safe-looking but would be MISREAD as number/bool/null,
    // so they round-trip back as strings; otherwise bare if safe, else JSON-quoted.
    const ambiguous = /^-?\d+(\.\d+)?$/.test(val) || ['true', 'false', 'null', '~'].includes(val);
    if (!ambiguous && /^[A-Za-z0-9_./:@+-]+$/.test(val)) return val;
    return JSON.stringify(val);
  }
  return JSON.stringify(val); // arrays / objects -> inline JSON (valid YAML flow)
}

// ---- file IO (atomic; CD-7 single writer) -----------------------------------

export function readState(statePath) {
  return parseState(fs.readFileSync(statePath, 'utf8'));
}

export function writeState(statePath, obj) {
  const text = serializeState(obj);
  const tmp = `${statePath}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, statePath); // atomic on POSIX
}

// Append-only activity log, a sibling of state.yml. One JSON object per line (< PIPE_BUF, so a single
// appendFileSync is atomic w.r.t. concurrent appenders — never read-modify-rewrite). `events.jsonl` is
// bundle state: like state.yml it is written ONLY here / via `mp event`, never raw-Write/Edit (CD-7 +
// anti-flood). The `stats` verb rolls these up; absent file == a bundle with no events yet.
export function appendEvent(statePath, record) {
  const eventsPath = path.join(path.dirname(statePath), 'events.jsonl');
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(eventsPath, JSON.stringify(record) + '\n', 'utf8');
  return eventsPath;
}

// ---- pure v8 state transforms (shell reads -> transforms -> writes) ----------

export function openGate(state, gate) {
  return { ...state, pending_gate: gate };
}
export function clearGate(state) {
  return { ...state, pending_gate: null };
}
export function setActiveRun(state, run) {
  return { ...state, active_run: run };
}
export function clearActiveRun(state) {
  return { ...state, active_run: null };
}
// Lifecycle field setters. The bin enum-validates the VALUE (mirror of mark-task); these stay thin
// because phase/status are free-form in validateCoreState (presence-only), so the bin boundary is the
// sole gate. No transition ordering — recovery/restart legitimately moves phase backward and a
// re-opened run goes archived→in-progress.
export function setPhase(state, phase) {
  return { ...state, phase };
}
export function setStatus(state, status) {
  return { ...state, status };
}
// The worktree's recorded PATH (the linked-worktree checkout dir this bundle owns). Thin like the
// disposition setter: the create-or-reuse path records it via `mp worktree record --worktree=<path>`
// after the SHELL runs `git worktree add`. Pairs with worktree_disposition — together they let the
// doctor / `mp worktree reconcile` answer "which dir does this bundle own, and is it still live?". v8
// previously had NO writer for this field (worktree creation was out-of-band prose); this is it.
export function setWorktree(state, worktree) {
  return { ...state, worktree };
}
// The worktree's lifecycle disposition. Thin like the lifecycle setters — the bin enum-validates the
// VALUE; this records the active→removed_after_merge (post-merge) / kept_by_user retirement the doctor's
// worktree-integrity check reads to SKIP a bundle whose worktree intentionally no longer resolves in git.
export function setWorktreeDisposition(state, disposition) {
  return { ...state, worktree_disposition: disposition };
}
// Rebase the bundle's absolute path fields (spec_path / plan_path / plan_index_path / worktree) from
// an old repo root to a new one — the CD-7-compliant writer for a repo relocation (the ONLY writer
// for these fields besides `seed`; never hand-edit state.yml). Pure: returns a new state object. Only
// leading-prefix matches of `fromRoot` are rewritten; any field that doesn't start with `fromRoot`
// is left untouched (so a partial re-rebase is a no-op). The `fromRoot`/`toRoot` MUST be absolute and
// are normalized (trailing slash trimmed) before comparison so `/srv/dev/masterplan` and
// `/srv/dev/masterplan/` both match. Exported for unit tests.
export function rebasePaths(state, fromRoot, toRoot) {
  if (typeof fromRoot !== 'string' || typeof toRoot !== 'string') {
    throw new Error('rebasePaths: fromRoot and toRoot must be strings');
  }
  const from = fromRoot.replace(/\/+$/, '');
  const to = toRoot.replace(/\/+$/, '');
  if (!from || !to || !from.startsWith('/') || !to.startsWith('/')) {
    throw new Error('rebasePaths: fromRoot and toRoot must be absolute paths');
  }
  if (from === to) {
    // no-op on identical roots — still surface _rebased=0 so callers/tests can read the count
    const same = { ...state };
    Object.defineProperty(same, '_rebased', { value: 0, enumerable: false });
    return same;
  }
  const fields = ['spec_path', 'plan_path', 'plan_index_path', 'worktree'];
  const next = { ...state };
  let touched = 0;
  for (const f of fields) {
    const v = next[f];
    if (typeof v === 'string' && v.startsWith(from + '/')) {
      next[f] = to + v.slice(from.length);
      touched += 1;
    }
  }
  // Return the count via a non-enumerable property so serializeState doesn't emit it. Callers that
  // want the count can read it; tests assert on it explicitly.
  Object.defineProperty(next, '_rebased', { value: touched, enumerable: false });
  return next;
}
// The finish-flow verified-at-SHA marker. Thin like the lifecycle setters: records the git SHA whose
// verification suite passed (`mp record-verification --sha=<HEAD>`), so a re-entry of the §2 `complete`
// handler at UNCHANGED HEAD skips re-running it (lib/finish.mjs isVerified); a new commit moves HEAD
// past verified_sha → re-verify. Free-form in validateCoreState (presence-only on the 4 core fields),
// so the bin boundary needs no enum — any sha string round-trips via serializeState (all keys emitted).
export function setVerifiedSha(state, sha) {
  return { ...state, verified_sha: sha };
}
// Per-bundle codex config is a NESTED object: state.codex.{routing,review}. The dispatch path
// (prepare-wave / event, bin) reads state.codex?.routing (default 'auto') and state.codex?.review — so
// the EFFECTIVE off-switch the codex-plugin-presence doctor wants lives HERE, not in the flat
// codex_routing/codex_review keys its old fix text named (those silence wantsCodex but never reach
// dispatch). Merge-update so a partial set (routing only) preserves the other facet; the bin enum-
// validates routing and normalizes review to a boolean. Reversible via the SAME verb (no CD-7 hand-edit).
export function setCodexConfig(state, patch = {}) {
  const codex = { ...(state.codex && typeof state.codex === 'object' ? state.codex : {}) };
  if (patch.routing !== undefined) codex.routing = patch.routing;
  if (patch.review !== undefined) codex.review = patch.review;
  return { ...state, codex };
}

// Per-bundle adversary-review config is a NESTED object: state.review.{adversary}. The finish-step
// gate reads state.review?.adversary (falling back to the legacy state.codex?.review for in-flight
// bundles seeded before the codex→adversary rename). The off-switch lives HERE; reversible via the
// SAME verb (mp set-review-config --review=…). The bin boundary normalizes the arm bit to a boolean.
export function setReviewConfig(state, patch = {}) {
  const review = { ...(state.review && typeof state.review === 'object' ? state.review : {}) };
  if (patch.adversary !== undefined) review.adversary = patch.adversary;
  return { ...state, review };
}
// Per-bundle coordination state (§6 schema — GitHub multi-agent coordination, spec §7.4).
// Present ONLY when a run is GitHub-coordinated (opt-in via `mp publish`); absent for all
// local single-agent runs (A9 invariant: buildSeedState never emits it). Merge-update so a
// partial set preserves existing fields; pass the full object from `mp publish` the first time.
// Serializes as a single nested key (`state.coordination`) via inline JSON (valid YAML flow) —
// the standard flat emitValue path already handles objects without a parser change.
//
// Schema fields (all optional at the setter level; the caller supplies what it knows):
//   mode            — string: "github" (the only v1 mode)
//   contract_ref    — string: immutable git ref "mp-coord/<slug>/<plan_hash>"
//   integration_branch — string: "mp-int/<slug>", the PR merge base
//   local_run_branch — string: lead-only local branch holding the bundle (never pushed)
//   current_wave    — number: the wave currently being coordinated (mirrors state.tasks wave)
//   published_waves — array of numbers: waves whose issues have been published to GitHub
//   base_sha_by_wave — object: { [wave]: sha } integration-branch HEAD per wave at publish time
//   issue_map       — object: { [task_id]: { issue, pr, merge_sha, status } } per-task GitHub state
export function setCoordination(state, patch = {}) {
  const coordination = { ...(state.coordination && typeof state.coordination === 'object' ? state.coordination : {}) };
  if (patch.mode !== undefined) coordination.mode = patch.mode;
  if (patch.contract_ref !== undefined) coordination.contract_ref = patch.contract_ref;
  if (patch.integration_branch !== undefined) coordination.integration_branch = patch.integration_branch;
  if (patch.local_run_branch !== undefined) coordination.local_run_branch = patch.local_run_branch;
  if (patch.current_wave !== undefined) coordination.current_wave = patch.current_wave;
  if (patch.published_waves !== undefined) coordination.published_waves = patch.published_waves;
  if (patch.base_sha_by_wave !== undefined) coordination.base_sha_by_wave = patch.base_sha_by_wave;
  if (patch.issue_map !== undefined) coordination.issue_map = patch.issue_map;
  return { ...state, coordination };
}
// Clears the coordination object entirely (reverts a coordinated run to local-execute).
// Thin, symmetric with setCoordination — the bin enum-validates use cases.
export function clearCoordination(state) {
  const next = { ...state };
  delete next.coordination;
  return next;
}
export function markTask(state, id, status) {
  const tasks = state.tasks ?? [];
  const idx = tasks.findIndex((task) => task.id === id);
  // CD-7 integrity: refuse a phantom write. A silent no-op on an unknown id used to let the shell
  // believe a result was recorded, so crash-recovery would re-dispatch already-done work. Fail loud.
  if (idx === -1) {
    throw new Error(
      `markTask: no task with id ${JSON.stringify(id)} (known ids: ${tasks.map((t) => t.id).join(', ') || 'none'})`
    );
  }
  return { ...state, tasks: tasks.map((task, i) => (i === idx ? { ...task, status } : task)) };
}

// loadPlanTasks: the plan→execute seam. Materialize state.tasks from a freshly-built plan.index.json
// AND advance phase→execute, returning ONE state object so the bin writes them in a single atomic
// writeState (tmp+rename). This atomicity is load-bearing, not stylistic: decideNextAction dispatches
// off the TASK LIST, not the phase label (a phase=execute bundle with tasks:[] decides `complete`).
// So splitting this into set-phase + a separate task write opens a crash window where decide sees
// phase=execute, tasks:[] → archives the just-planned bundle (data loss). Keep them inseparable.
//
// state.tasks carries ONLY the disk-derivable {id, status, wave, files} — the SAME projection as
// applyPlanIndex. The exec/routing fields (description / verify_commands / codex / sensitive) stay in
// plan.index.json, which prepareWave reads by id at dispatch time; duplicating `codex` into state.tasks
// is exactly the drift v8 kills. Refuses a bundle that already has tasks (overwriting would clobber
// in-flight execution state — re-deriving waves on an existing list is backfill-waves' job). Validates
// each wave is an integer up front so the materialized tasks always pass decideNextAction's wave guard.
export function loadPlanTasks(state, planIndex) {
  const existing = state?.tasks ?? [];
  if (existing.length) {
    throw new Error(
      `loadPlanTasks: bundle already has ${existing.length} task(s) — refusing to overwrite execution ` +
        `state. (To re-derive waves on an existing task list, use backfill-waves.)`
    );
  }
  const list = Array.isArray(planIndex) ? planIndex : Array.isArray(planIndex?.tasks) ? planIndex.tasks : [];
  if (!list.length) {
    throw new Error('loadPlanTasks: plan.index.json has no tasks — nothing to materialize.');
  }
  const tasks = list.map((p) => {
    // ids arrive integer-typed: the sole production caller (bin load-plan) runs validatePlanIndex
    // FIRST, which rejects any non-integer id (Number.isInteger(t.id)) before this materializes.
    const id = p.id ?? p.idx;
    const wave = p.wave ?? p.parallel_group;
    if (!Number.isInteger(wave)) {
      throw new Error(
        `loadPlanTasks: plan.index task ${JSON.stringify(id)} has a non-integer wave (${JSON.stringify(wave)}) — ` +
          `the merge step assigns integer waves; rebuild plan.index.json (or run merge-plan-fragments).`
      );
    }
    return { id, status: 'pending', wave, files: Array.isArray(p.files) ? p.files : [] };
  });
  return { ...state, tasks, phase: 'execute' };
}

// ---- minimal v8 core schema --------------------------------------------------
//
// The SINGLE SOURCE OF TRUTH for "what a valid v8 bundle core looks like". Both the bundle
// writer and the doctor's state-schema check consume this — the schema lives HERE, never
// duplicated (duplication is exactly the drift v8 exists to kill). Kept deliberately MINIMAL:
// v8 bundles are well-formed by construction (serializeState), so this guards only the
// migrate / hand-edit boundary, not an aspirational schema. Tighten when the fresh-bundle
// writer (brainstorm/plan integration) freezes the schema. `tasks` is intentionally NOT
// required-present — a pre-plan (brainstorm-phase) bundle legitimately has no tasks yet; it is
// only validated as an array WHEN present. schema_version >= 6 is the v8 floor (legacy < 6 is
// the legacy-bundle check's concern, not a core-schema violation).
export const CORE_REQUIRED_FIELDS = ['schema_version', 'slug', 'status', 'phase'];

// Returns an array of human-readable problems; [] means the core is valid. Pure, never throws.
export function validateCoreState(state) {
  if (state == null || typeof state !== 'object') return ['state is not an object'];
  const problems = [];
  for (const f of CORE_REQUIRED_FIELDS) {
    if (state[f] === null || state[f] === undefined) problems.push(`missing required field: ${f}`);
  }
  const sv = state.schema_version;
  if (sv !== null && sv !== undefined && (typeof sv !== 'number' || Math.floor(sv) < 6)) {
    problems.push(`schema_version must be a number >= 6 (got ${JSON.stringify(sv)})`);
  }
  if (state.tasks !== null && state.tasks !== undefined && !Array.isArray(state.tasks)) {
    problems.push('tasks must be an array when present');
  }
  // state.goals is a DERIVED CACHE of goals.md + events (authority order: goals.md + events > state).
  // Optional-when-present, mirroring tasks: a pre-feature bundle (no goals_enabled, no goals) is exempt
  // from every goal guard here. When present it must be an array of {id, text, signal, tombstone?} with
  // NO mutable status field (verdicts live only in hash/SHA-keyed events, never in stale state).
  if (state.goals !== null && state.goals !== undefined) {
    if (!Array.isArray(state.goals)) {
      problems.push('goals must be an array when present');
    } else {
      state.goals.forEach((g, i) => {
        if (g === null || typeof g !== 'object' || Array.isArray(g)) {
          problems.push(`goals[${i}] must be an object`);
          return;
        }
        if (typeof g.id !== 'string' || g.id === '') problems.push(`goals[${i}] must have a non-empty string id`);
        if (typeof g.text !== 'string' || g.text === '') problems.push(`goals[${i}] must have a non-empty string text`);
        if (typeof g.signal !== 'string' || g.signal === '') problems.push(`goals[${i}] must have a non-empty string signal`);
        if ('status' in g) problems.push(`goals[${i}] must not carry a mutable status field (verdicts live in events, not state)`);
        const t = g.tombstone;
        if (t !== null && t !== undefined) {
          if (typeof t !== 'object' || Array.isArray(t)) {
            problems.push(`goals[${i}].tombstone must be an object when present`);
          } else {
            if (typeof t.reason !== 'string' || t.reason === '') problems.push(`goals[${i}].tombstone.reason must be a non-empty string`);
            if (typeof t.amended_at !== 'string' || t.amended_at === '') problems.push(`goals[${i}].tombstone.amended_at must be a non-empty string`);
          }
        }
      });
    }
  }
  if (state.active_run !== null && state.active_run !== undefined && typeof state.active_run !== 'object') {
    problems.push('active_run must be an object or null');
  }
  // pending_gate is the ONE durable approval marker: null, or an object carrying a string `id`
  // (the v5/v7 string dual-form is gone — migrate.mjs collapses it to {id, opened_at} or null, and
  // both openGate and `mp open-gate` only ever write the object form). The old "string or null" rule
  // contradicted every writer, so `doctor`/`validate` false-positived on every gated bundle.
  const g = state.pending_gate;
  if (g !== null && g !== undefined && (typeof g !== 'object' || Array.isArray(g) || typeof g.id !== 'string')) {
    problems.push('pending_gate must be null or an object with a string id ({id, opened_at})');
  }
  return problems;
}

// ---- fresh-bundle seed (the brainstorm-phase origin of a v8 run) ----
//
// Pure: assembles the core-valid v8 state a new run begins with, then asserts it against
// validateCoreState BEFORE returning — a malformed seed fails loud here, not silently on the next
// `decide`. The `bin seed` subcommand is its sole caller (the shell's "seed the bundle" step); this
// is what lets §3 use `mp seed` instead of a CD-7-violating, screen-flooding raw `Write` of state.yml.
// Timestamps are caller-supplied (createdAt required) so the builder stays deterministic/testable —
// bin defaults it to now(). Path fields default to siblings of the bundle dir, resolved by the caller.
export function buildSeedState(opts = {}) {
  const {
    slug, topic, createdAt,
    phase = 'brainstorm',
    status = 'in-progress',
    schemaVersion = 8,
    complexity, complexitySource, autonomy, planningMode, predecessorTranscript,
    specPath = null, planPath = null, planIndexPath = null,
    ownerLock,
    codexReview = true, // Spec §4.1: default-on at seed (was: never emitted). Arms the finish-time
                        // adversary review via state.review.adversary. Finish-step's defensive arm
                        // (lib/finish-step.mjs) covers legacy bundles missing it.
  } = opts;
  if (!slug) throw new Error('buildSeedState: slug is required');
  if (!topic) throw new Error('buildSeedState: topic is required');
  if (!createdAt) throw new Error('buildSeedState: createdAt is required');
  const state = {
    schema_version: schemaVersion,
    slug,
    status,
    phase,
    topic,
    complexity: complexity ?? null,
    complexity_source: complexitySource ?? null,
    autonomy: autonomy ?? null,
    planning_mode: planningMode ?? 'auto',
    created_at: createdAt,
    predecessor_transcript: predecessorTranscript ?? null,
    spec_path: specPath,
    plan_path: planPath,
    plan_index_path: planIndexPath,
    tasks: [],
    active_run: null,
    pending_gate: null,
    // bundle-level capability marker (distinguishes post-feature bundles) + the derived-cache
    // goals array (authority stays goals.md + events; this is a cache). Every freshly seeded bundle
    // is post-feature, so the marker is always true here.
    goals_enabled: true,
    goals: [],
  };
  // Adversary review config (nested state.review.{adversary}). The finish-step gate reads
  // state.review?.adversary. When codexReview is true, persist the explicit adversary:true so future
  // audit re-entry guards can distinguish "review opted in" from "review never configured" (the
  // defensive-arm event in finish-step.mjs covers the latter). When false (explicit opt-out), the
  // field stays absent — A9 absent-field style: absent and explicit-false both yield
  // codexArmed(undefined) === false at runtime, but the audit trail differs. Note: the vestigial
  // state.codex.routing default ('auto') is NO LONGER written — routing defaults to 'auto' at the
  // dispatch read site anyway, and there is no codex dispatch target to gate.
  if (codexReview === true) state.review = { adversary: true };
  // Guard D escape hatch (T2.3): `mp seed --owner-lock=off` persists the opt-out so every later
  // owner-gated transaction (continue's acquire, record-result's heartbeat) skips the sentinel.
  // Emitted ONLY when off — default-on stays implicit (no key), matching the A9 absent-field style.
  if (ownerLock === 'off') state.concurrency = { owner_lock: 'off' };
  const problems = validateCoreState(state);
  if (problems.length) throw new Error(`buildSeedState: produced invalid core: ${problems.join('; ')}`);
  return state;
}

// ---- event-backed goals capability marker (plan-review finding 4 / residual finding 1) ----
//
// The goals_enabled marker in state.yml is a deletable field, so it CANNOT be the sole authority.
// The capability is EVENT-BACKED: `mp seed` appends a bundle-creation/capability event carrying
// goals_enabled from seed time (so there is no pre-first-event deletion window), and every goal
// guard / the doctor infers post-feature status from the EVENT LOG, not the deletable state.yml
// field alone. A state.yml missing the marker while capability/goal events exist is a HARD ERROR
// (authority order: events > state) — editing state.yml can never relax the guards.
export const CAPABILITY_EVENT_TYPE = 'bundle_created';
export const GOAL_LIFECYCLE_EVENT_TYPES = ['goals_frozen', 'goal_amended', 'goal_check', 'goal_waived'];

// Pure: the capability event `mp seed` appends alongside writing the seed state (the bin layer does the
// actual appendEvent — CD-7 single-writer; this only builds the record). Carries goals_enabled so the
// capability is provable from the event log alone. createdAt is caller-supplied (deterministic/testable).
export function buildCapabilityEvent({ createdAt, goalsEnabled = true } = {}) {
  if (!createdAt) throw new Error('buildCapabilityEvent: createdAt is required');
  return { type: CAPABILITY_EVENT_TYPE, ts: createdAt, data: { goals_enabled: goalsEnabled === true } };
}

// Pure: infer whether a bundle is post-feature (goals-capable) from its EVENT LOG alone. A bundle is
// post-feature if the log carries a capability event with goals_enabled OR any goal lifecycle event.
// Returns { enabled, capabilityEvent, goalEvent }.
export function inferGoalsCapability(events) {
  const list = Array.isArray(events) ? events : [];
  const capabilityEvent = list.some(
    (e) => e && e.type === CAPABILITY_EVENT_TYPE && e.data && e.data.goals_enabled === true
  );
  const goalEvent = list.some((e) => e && GOAL_LIFECYCLE_EVENT_TYPES.includes(e.type));
  return { enabled: capabilityEvent || goalEvent, capabilityEvent, goalEvent };
}

// Pure: the authority-order cross-check the guards / doctor run. Returns an array of human-readable
// problems ([] means consistent). Enforces authority order (events > state): if the event log proves
// the bundle is post-feature but state.yml lacks the goals_enabled marker, that is a hard error, not a
// skip. A genuinely pre-feature bundle (no capability/goal events, no marker) yields no problems.
export function checkGoalsCapabilityAuthority(state, events) {
  const problems = [];
  const inferred = inferGoalsCapability(events);
  const markerPresent = state != null && typeof state === 'object' && state.goals_enabled === true;
  if (inferred.enabled && !markerPresent) {
    problems.push(
      'state.yml is missing the goals_enabled marker but the event log contains capability/goal events ' +
        '(authority order: events > state) — hard error, not a skip'
    );
  }
  return problems;
}

// ---- fresh-plan task seed: plan.index.json -> state.tasks (the plan-phase population) ----
//
// Pure: turns the planner's plan.index.json into the v8 `state.tasks` array a freshly-planned run
// carries into execute. This is the writer the fresh-plan path was MISSING — buildSeedState emits
// `tasks: []` (a brainstorm bundle has none yet) and applyPlanIndex only ANNOTATES tasks already in
// state; nothing populated them from the plan. Without it the shell had to hand-rewrite state.yml (a
// CD-7 violation + a screen-flooding diff), and at phase=execute a `decide` over tasks:[] FINALIZES
// an empty run (resume.mjs's zero-task diversion only covers brainstorm|plan). `mp seed-tasks` is its
// sole caller. This is the ROOT fix of the same empty-tasks hazard the resume-layer guard patches
// DEFENSIVELY — populate the tasks so the guards never have to fire.
//
// Each task is the MINIMAL shell-owned shape `{id, status, wave, files}` — exactly what the live
// hand-seed produced and what decideNextAction / prepareWave / declaredScope consume. The rich
// exec/routing fields (description/verify_commands/codex/sensitive/conversational) are intentionally
// NOT copied: prepareWave reads those from plan.index.json at dispatch time ("state owns {id,wave,
// status,files}; plan.index owns the routing fields", wave.mjs). Duplicating them would be two
// sources of truth for the same data.
//
// id is coerced numeric-string -> Number by the SAME rule bin's coerceId uses, so mark-task's
// `task.id === coerceId(--id)` match holds; a missing/empty id fails loud (a task mark-task could
// never address). wave is passed through RAW (`p.wave ?? p.parallel_group`, mirror of applyPlanIndex)
// — never Number()-coerced, because Number(null) === 0 would silently bucket a wave-less task into
// wave 0; the bin's integer-wave guard (mirror of backfill-waves) catches a non-integer instead.
// ---- backfill-waves: re-derive each task's {wave, files} from plan.index.json (migrate contract:
// a legacy bundle has no v8 plan.index.json, so migrate leaves wave:null and the shell calls this
// once the plan is (re-)parsed; satisfies decideNextAction's non-integer-wave guard). Moved here
// from bin/masterplan.mjs for T2.3 so lib/continue.mjs can backfill without importing the CLI
// (bin re-exports it, keeping its public import surface intact).
export function applyPlanIndex(state, planIndex) {
  const list = Array.isArray(planIndex) ? planIndex : Array.isArray(planIndex?.tasks) ? planIndex.tasks : [];
  // Key by STRING id on both sides: plan.index.json ids are often strings ("1") while migrated
  // state task ids are numbers (1). A raw-keyed Map misses on that type mismatch, leaving wave:null
  // (then decide's non-integer-wave guard throws). Normalize so the lookup is type-insensitive.
  const byId = new Map(list.map((p) => [String(p.id ?? p.idx), p]));
  const tasks = (state.tasks ?? []).map((task) => {
    const p = byId.get(String(task.id));
    if (!p) return task;
    const wave = p.wave ?? p.parallel_group ?? task.wave;
    const files = p.files ?? task.files ?? [];
    return { ...task, wave, files };
  });
  return { ...state, tasks };
}

export function buildTasksFromPlanIndex(planIndex) {
  const list = Array.isArray(planIndex) ? planIndex : Array.isArray(planIndex?.tasks) ? planIndex.tasks : [];
  return list.map((p) => {
    const rawId = p.id ?? p.idx;
    if (rawId === null || rawId === undefined || rawId === '') {
      throw new Error(
        `buildTasksFromPlanIndex: a plan.index task has no id (${JSON.stringify(p)}) — every task needs an addressable id (mark-task matches on it).`
      );
    }
    const id = /^-?\d+$/.test(String(rawId)) ? Number(rawId) : rawId;
    const wave = p.wave ?? p.parallel_group ?? null;
    const files = p.files ?? [];
    return { id, status: 'pending', wave, files };
  });
}
