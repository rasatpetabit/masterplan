// lib/plan-merge.mjs — deterministic plan assembly core (parallel-planning feature).
//
// Design principle (root-cause fix for two anomalies): the LLM NEVER authors the final
// plan.index.json bytes. Parallel subsystem drafters return FRAGMENTS — string-keyed tasks
// with declared deps, MINUS global ids and waves. This module owns:
//   • global 1-based integer id assignment (deterministic: fragment order, then task order)
//   • wave layering from the dependency DAG + file-disjointness (NOT from the LLM, NOT from
//     id order) — packs each wave maximally, so disjoint independent tasks share a wave
//     instead of being scattered into single-task waves (anomaly 2)
//   • codex normalisation to the STRING enum "ok"|"no"|null regardless of input shape —
//     an object/boolean can never leak into routing's silent heuristic fallthrough (anomaly 1)
//
// Pure and zero-dependency: no fs, no clock, no randomness. The bin layer stamps plan_hash /
// generated_at and writes artifacts; this module only computes and validates the structure.
//
// plan.index.json schema (authoritative, byte-synced with agents/mp-planner.md + lib/routing.mjs):
//   { schema_version: "6.0", tasks: [ { id:int, description:str, wave:int>=0, files:[],
//     verify_commands:[], codex:"ok"|"no"|null, sensitive?:bool, conversational?:bool,
//     spec_refs?:[] } ] }
// This module produces the POST-merge index above. The PRE-merge fragment shape the parallel
// drafters return (no id/wave) is documented in agents/mp-subsystem-planner.md.

const SCHEMA_VERSION = '6.0';

// ── codex normalisation (anomaly 1) ──────────────────────────────────────────
// Routing (lib/routing.mjs) honours ONLY the string enum: "no" → ineligible, "ok" → eligible,
// null/absent → heuristic. Any other shape silently falls through to the heuristic — the bug
// this normaliser exists to kill. Drafters may emit a bool or an {eligible} object; collapse
// every advisory shape to the enum, and map anything unrecognised to null (heuristic).
export function normalizeCodex(v) {
  if (v === 'ok' || v === 'no') return v;
  if (v === true) return 'ok';
  if (v === false) return 'no';
  if (v && typeof v === 'object' && !Array.isArray(v) && 'eligible' in v) {
    if (v.eligible === true) return 'ok';
    if (v.eligible === false) return 'no';
  }
  return null;
}

// Non-empty intersection of two file arrays (used for the same-wave disjointness rule).
function shareFile(a, b) {
  if (!a.length || !b.length) return false;
  const set = new Set(a);
  for (const f of b) if (set.has(f)) return true;
  return false;
}

// Deterministic topological order via Kahn's algorithm. Among ready nodes (in-degree 0) we
// always pick the lowest id, so the order is a pure function of the input. Throws on a cycle —
// the merge must fail loud, never hang, when drafters emit A→B→A across fragments.
function topoOrder(nodes, byKey) {
  const indeg = new Map(nodes.map((n) => [n.key, n.deps.length]));
  // dependents[k] = nodes that depend on k (reverse edges).
  const dependents = new Map(nodes.map((n) => [n.key, []]));
  for (const n of nodes) for (const d of n.deps) dependents.get(d).push(n.key);

  const ready = nodes.filter((n) => indeg.get(n.key) === 0).sort((a, b) => a.id - b.id);
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const depKey of dependents.get(n.key)) {
      indeg.set(depKey, indeg.get(depKey) - 1);
      if (indeg.get(depKey) === 0) {
        // Insert keeping `ready` sorted by id (small lists — linear insert is fine).
        const node = byKey.get(depKey);
        let i = 0;
        while (i < ready.length && ready[i].id < node.id) i += 1;
        ready.splice(i, 0, node);
      }
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n)).map((n) => n.key);
    throw new Error(`plan-merge: dependency cycle among tasks [${stuck.join(', ')}] — deps must form a DAG`);
  }
  return order;
}

// Merge an array of subsystem fragments into a canonical plan.index.json object.
// Accepts either a bare array of fragments or `{ subsystems: [...] }` (the plan workflow's
// return shape). Each fragment: { key, tasks: [ { key, description, files, verify_commands,
// codex?, deps?, sensitive?, conversational?, spec_refs? } ] }. Task keys must be globally
// unique; deps reference task keys (local or cross-fragment).
export function mergePlanFragments(fragments, opts = {}) {
  const schema_version = opts.schemaVersion ?? SCHEMA_VERSION;
  const frags = Array.isArray(fragments)
    ? fragments
    : (Array.isArray(fragments?.subsystems) ? fragments.subsystems : []);

  // 1. Flatten → assign ids (fragment order, then task order). Reject duplicate keys loud.
  const nodes = [];
  const byKey = new Map();
  let id = 0;
  for (const frag of frags) {
    const ftasks = Array.isArray(frag?.tasks) ? frag.tasks : [];
    for (const t of ftasks) {
      const key = t?.key;
      if (key == null || key === '') {
        throw new Error(`plan-merge: a task in fragment "${frag?.key ?? '?'}" is missing its key`);
      }
      if (byKey.has(key)) {
        throw new Error(`plan-merge: duplicate task key "${key}" — task keys must be globally unique across fragments`);
      }
      id += 1;
      const node = {
        id,
        key,
        description: String(t.description ?? ''),
        files: Array.isArray(t.files) ? t.files.slice() : [],
        verify_commands: Array.isArray(t.verify_commands) ? t.verify_commands.slice() : [],
        codex: normalizeCodex(t.codex),
        deps: Array.isArray(t.deps) ? t.deps.slice() : [],
      };
      if (t.sensitive === true) node.sensitive = true;
      if (t.conversational === true) node.conversational = true;
      if (Array.isArray(t.spec_refs)) node.spec_refs = t.spec_refs.slice();
      nodes.push(node);
      byKey.set(key, node);
    }
  }

  // 2. Validate deps reference existing keys (dangling → fail loud).
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!byKey.has(d)) {
        throw new Error(`plan-merge: task "${n.key}" depends on unknown key "${d}"`);
      }
    }
  }

  // 3. Wave layering over the dependency DAG (topological order — NOT id order; a dependent
  //    may carry a lower id than its dependency when fragments are drafted out of order).
  //    Each task's wave is the max over its deps' waves + 1 (0 if no deps), then bumped while
  //    any already-placed task in that wave shares a file (same-wave ⇒ disjoint files).
  const order = topoOrder(nodes, byKey);
  const placed = [];
  for (const n of order) {
    let wave = 0;
    for (const d of n.deps) wave = Math.max(wave, byKey.get(d).wave + 1);
    let bumped = true;
    while (bumped) {
      bumped = false;
      for (const s of placed) {
        if (s.wave === wave && shareFile(s.files, n.files)) { wave += 1; bumped = true; break; }
      }
    }
    n.wave = wave;
    placed.push(n);
  }

  // 4. Emit canonical schema fields (drop merge-internal key/deps), sorted by id.
  const tasks = nodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((n) => {
      const out = {
        id: n.id,
        description: n.description,
        wave: n.wave,
        files: n.files,
        verify_commands: n.verify_commands,
        codex: n.codex,
      };
      if (n.sensitive) out.sensitive = true;
      if (n.conversational) out.conversational = true;
      if (n.spec_refs) out.spec_refs = n.spec_refs;
      return out;
    });

  return { schema_version, tasks };
}

// Strict structural validator. Returns an array of human-readable error strings (empty ⇒ valid).
// Guards both merge output (belt-and-suspenders) AND hand-authored / serial-path indexes: the
// codex check is the explicit gate against the silent-routing-fallthrough trap.
export function validatePlanIndex(index) {
  const errors = [];
  const tasks = Array.isArray(index?.tasks) ? index.tasks : null;
  if (!tasks) {
    errors.push('index.tasks must be an array');
    return errors;
  }

  const seen = new Set();
  for (const t of tasks) {
    const label = `task ${t?.id ?? '?'}`;
    if (!Number.isInteger(t?.id)) {
      errors.push(`${label}: id must be an integer`);
    } else if (seen.has(t.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      seen.add(t.id);
    }
    if (typeof t?.description !== 'string' || t.description.trim() === '') {
      errors.push(`${label}: description must be a non-empty string`);
    }
    if (!Number.isInteger(t?.wave) || t.wave < 0) {
      errors.push(`${label}: wave must be an integer ≥ 0`);
    }
    const codexOk = t?.codex === 'ok' || t?.codex === 'no' || t?.codex === null || t?.codex === undefined;
    if (!codexOk) {
      errors.push(`${label}: codex must be "ok", "no", or null (got ${JSON.stringify(t?.codex)}) — an object or boolean silently falls through to the routing heuristic`);
    }
    if (t?.files !== undefined && !Array.isArray(t.files)) {
      errors.push(`${label}: files must be an array`);
    }
    if (t?.verify_commands !== undefined && !Array.isArray(t.verify_commands)) {
      errors.push(`${label}: verify_commands must be an array`);
    }
  }

  // Same-wave file overlap: tasks scheduled in the same wave run concurrently and must touch
  // disjoint files. A violation means the wave layering (or a hand edit) is unsafe.
  const byWave = new Map();
  for (const t of tasks) {
    if (!Number.isInteger(t?.wave)) continue;
    const files = Array.isArray(t.files) ? t.files : [];
    const arr = byWave.get(t.wave) ?? [];
    for (const s of arr) {
      const overlap = files.filter((f) => (Array.isArray(s.files) ? s.files : []).includes(f));
      if (overlap.length) {
        errors.push(`wave ${t.wave}: tasks ${s.id} and ${t.id} share file(s) ${overlap.join(', ')} — same-wave tasks must have disjoint files`);
      }
    }
    arr.push(t);
    byWave.set(t.wave, arr);
  }

  return errors;
}

// Render plan.md as a deterministic projection of the index. plan.md is NEVER authored
// independently of the index — this keeps the human-readable plan and the machine index from
// drifting apart. Pure function of (index, meta).
export function renderPlanMd(index, meta = {}) {
  const tasks = Array.isArray(index?.tasks) ? index.tasks.slice().sort((a, b) => a.id - b.id) : [];
  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  const lines = [];
  lines.push(`# ${meta.title ?? 'Plan'}`);
  lines.push('');
  if (meta.spec) {
    lines.push(`Spec: ${meta.spec}`);
    lines.push('');
  }
  lines.push(`${tasks.length} task(s) across ${waves.length} wave(s).`);
  lines.push('');
  for (const w of waves) {
    lines.push(`## Wave ${w}`);
    lines.push('');
    for (const t of tasks.filter((x) => x.wave === w)) {
      lines.push(`### Task ${t.id}: ${t.description}`);
      const files = (t.files ?? []).length ? t.files.join(', ') : '(none declared)';
      lines.push(`- files: ${files}`);
      const vc = t.verify_commands ?? [];
      lines.push(`- verify: ${vc.length ? vc.join(' ; ') : '(none)'}`);
      lines.push(`- codex: ${t.codex == null ? 'heuristic' : t.codex}`);
      if (Array.isArray(t.spec_refs) && t.spec_refs.length) {
        lines.push(`- spec_refs: ${t.spec_refs.join(', ')}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
