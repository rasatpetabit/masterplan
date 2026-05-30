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
// The worktree's lifecycle disposition. Thin like the lifecycle setters — the bin enum-validates the
// VALUE; this records the active→removed_after_merge (post-merge) / kept_by_user retirement the doctor's
// worktree-integrity check reads to SKIP a bundle whose worktree intentionally no longer resolves in git.
export function setWorktreeDisposition(state, disposition) {
  return { ...state, worktree_disposition: disposition };
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
    complexity, complexitySource, autonomy, predecessorTranscript,
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
