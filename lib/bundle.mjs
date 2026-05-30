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
  };
  const problems = validateCoreState(state);
  if (problems.length) throw new Error(`buildSeedState: produced invalid core: ${problems.join('; ')}`);
  return state;
}
