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
// Pure and zero-dependency merge/validate core: no clock, no randomness. (The plan.html render
// helpers below accept an injectable fileExists — defaulting to real fs — so presence checks stay
// deterministic and testable offline.) The bin layer stamps plan_hash /
// generated_at and writes artifacts; this module only computes and validates the structure.
//
// plan.index.json schema (authoritative, byte-synced with agents/mp-planner.md + lib/dispatch/routing.mjs):
//   { schema_version: "6.0", tasks: [ { id:int, description:str, wave:int>=0, files:[],
//     verify_commands:[], codex:"ok"|"no"|null, sensitive?:bool, conversational?:bool,
//     spec_refs?:[] } ] }
// This module produces the POST-merge index above. The PRE-merge fragment shape the parallel
// drafters return (no id/wave) is documented in agents/mp-subsystem-planner.md.

import path from 'node:path';
import { existsSync } from 'node:fs';

const SCHEMA_VERSION = '6.0';

// ── codex normalisation (anomaly 1) ──────────────────────────────────────────
// Routing (lib/dispatch/routing.mjs) honours ONLY the string enum: "no" → ineligible, "ok" → eligible,
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
      if (Array.isArray(t.goals)) node.goals = t.goals.slice();
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
        goals: n.goals ?? [],
      };
      if (n.sensitive) out.sensitive = true;
      if (n.conversational) out.conversational = true;
      if (n.spec_refs) out.spec_refs = n.spec_refs;
      return out;
    });

  // Distil the optional narrative meta {purpose, problem, solution} from opts.meta into
  // index.meta so the fragment-merge --meta path carries the distilled strings into
  // plan.index.json. Non-object meta, missing fields, and non-string / empty-string values
  // are soft-ignored (never a throw). Emits nothing when no valid narrative field is present,
  // so old no-meta indexes keep their exact shape (back-compat).
  const narrative = {};
  if (opts.meta && typeof opts.meta === 'object' && !Array.isArray(opts.meta)) {
    for (const k of ['purpose', 'problem', 'solution']) {
      const v = opts.meta[k];
      if (typeof v === 'string' && v.trim() !== '') narrative[k] = v;
    }
  }
  const index = { schema_version, tasks };
  if (Object.keys(narrative).length > 0) index.meta = narrative;
  return index;
}

// Strict structural validator. Returns an array of human-readable error strings (empty ⇒ valid).
// Guards both merge output (belt-and-suspenders) AND hand-authored / serial-path indexes: the
// codex check is the explicit gate against the silent-routing-fallthrough trap.
// Optional `goals` parameter (array of { id, tombstone? }) enables machine-checked goal
// coverage: every non-tombstoned goal must be cited by ≥1 task, and every task-cited goal
// must exist in the supplied list. When `goals` is empty (default), this check is a no-op.
export function validatePlanIndex(index, goals = []) {
  const errors = [];
  // Narrative meta (index.meta = {purpose, problem, solution}) is intentionally ACCEPT-AND-IGNORE
  // for back-compat: old indexes carry no meta and stay valid; new indexes with meta stay valid;
  // a malformed meta value is a soft-ignore here, never a hard error. The validator inspects only
  // index.tasks below, so any index.meta shape passes untouched.
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
    if (t?.goals !== undefined && !Array.isArray(t.goals)) {
      errors.push(`${label}: goals must be an array`);
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

  // Goal coverage: every non-tombstoned goal must be cited by ≥1 task; every cited goal
  // must exist in the supplied list. Tombstoned goals still count as "known".
  if (Array.isArray(goals) && goals.length > 0) {
    const knownGoalIds = new Set(goals.map((g) => g.id));
    const citedGoalIds = new Set();
    for (const t of tasks) {
      if (Array.isArray(t?.goals)) {
        for (const gid of t.goals) citedGoalIds.add(gid);
      }
    }
    for (const g of goals) {
      if (g.tombstone !== true && !citedGoalIds.has(g.id)) {
        errors.push(`goal "${g.id}" is not covered by any task`);
      }
    }
    for (const gid of citedGoalIds) {
      if (!knownGoalIds.has(gid)) {
        errors.push(`task cites unknown goal "${gid}"`);
      }
    }
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

// ── plan.html — a rendered, self-contained projection of the index ───────────
// Like renderPlanMd, plan.html is NEVER authored independently of the index. It is an
// ADDITIVE artifact (plan.md stays canonical); the bin layer writes it with plain fs.
//
// HTML-escape for both text nodes and double-quoted attribute values. Plan fields
// (descriptions, files, commands, spec_refs, title) are arbitrary strings — untrusted
// markup must never become executable (<script>) or a remote fetch (src=/href=), so
// EVERYTHING interpolated routes through here.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The ONLY status values that may reach a CSS class. Anything else (or missing) renders
// as 'pending'. This whitelist is what stops a hostile status string injecting a class.
// 'waived' added in D7/G6 so waived (terminal operator-removed) is visually distinct from
// pending/in_progress (in-flight -> both gray). 'failed' kept for qctl-derived producer statuses.
const PLAN_HTML_STATUSES = ['pending', 'done', 'failed', 'blocked', 'waived'];

const PLAN_HTML_CSS = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; line-height: 1.45; }
h1 { margin-bottom: .25rem; }
.summary { color: #666; margin-top: 0; }
.stamp { color: #999; font-size: .85rem; margin-top: 0; }
.diagram { margin: 1.25rem 0; overflow-x: auto; }
section.wave { margin: 1.5rem 0; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { border: 1px solid #ddd; padding: .4rem .55rem; text-align: left; vertical-align: top; }
th { background: #f5f5f5; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .8rem; font-weight: 600; color: #fff; }
.status-pending { background: #9e9e9e; }
.status-done    { background: #2e7d32; }
.status-failed  { background: #c62828; }
.status-blocked { background: #ef6c00; }
.status-waived   { background: #6a1b9a; }
.svg-wavelabel { font: 600 13px system-ui, sans-serif; fill: #555; }
.svg-id { font: 600 13px ui-monospace, monospace; fill: #fff; }
.svg-node.status-pending rect { fill: #9e9e9e; }
.svg-node.status-done    rect { fill: #2e7d32; }
.svg-node.status-failed  rect { fill: #c62828; }
.svg-node.status-blocked rect { fill: #ef6c00; }
.svg-node.status-waived rect { fill: #6a1b9a; }
section.meta { margin: 1rem 0; }
.refs ul { list-style: none; padding-left: 0; margin: .3rem 0; }
.refs li { margin: .2rem 0; }
.narrative h2 { margin-top: 1.25rem; }
img.hero, img.wave-img { max-width: 100%; height: auto; display: block; margin: .75rem 0; }
.amendments ol.timeline { padding-left: 1.1rem; }
.amendments time { font-weight: 600; color: #555; }
.amendments .detail { color: #666; margin: .15rem 0 .4rem; }
.goals ul { columns: 2; }`;

// Inline SVG: a wave-banded NODE layout, NOT a dependency graph. The post-merge index
// carries no deps (merge drops key/deps above), so there are no edges to draw. Each wave
// is a horizontal band; tasks (id-sorted) are nodes within it. Geometry is a pure
// function of counts — no measured text, no random/generated ids, no clock.
function renderWaveSvg(waves, tasks, statusOf) {
  const PAD = 16, LABEL_W = 90, NODE_W = 54, NODE_H = 30, GAP = 12, BAND_H = NODE_H + GAP * 2;
  const inWave = (w) => tasks.filter((t) => t.wave === w);
  const maxCount = waves.reduce((m, w) => Math.max(m, inWave(w).length), 0);
  const width = PAD * 2 + LABEL_W + Math.max(1, maxCount) * (NODE_W + GAP);
  const height = PAD * 2 + Math.max(1, waves.length) * BAND_H;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Plan waves">`,
  ];
  waves.forEach((w, wi) => {
    const y = PAD + wi * BAND_H;
    parts.push(`<text x="${PAD}" y="${y + NODE_H / 2 + 5}" class="svg-wavelabel">Wave ${w}</text>`);
    inWave(w).forEach((t, ti) => {
      const x = PAD + LABEL_W + ti * (NODE_W + GAP);
      const st = statusOf(t.id);
      parts.push(`<g class="svg-node status-${st}">`);
      parts.push(`<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="5"/>`);
      parts.push(`<text x="${x + NODE_W / 2}" y="${y + NODE_H / 2 + 5}" text-anchor="middle" class="svg-id">#${t.id}</text>`);
      parts.push('</g>');
    });
  });
  parts.push('</svg>');
  return parts.join('');
}

// ── render-context path safety (F1/F4 HUB) ──────────────────────────────
// PURE path math (node:path only, no fs). resolveAssetSrc keeps an embedded <img> inside the
// bundle's assets/ dir; resolveRefTarget keeps a ref <a href> inside the ref's STORED canonical
// repo root (the F1 trust boundary). A null return means "never emit a tag" — the render falls
// back to no-img / plain-text. Stored slugs are re-validated here before any path is built, so a
// hostile state.refs slug renders as inert text, never a traversal primitive.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function resolveAssetSrc(bundleDir, slot) {
  if (!bundleDir || slot == null) return null;
  const assetsDir = path.resolve(bundleDir, 'assets');
  const abs = path.resolve(assetsDir, `${slot}.png`);
  if (abs !== assetsDir && !abs.startsWith(assetsDir + path.sep)) return null; // escaped assets/
  const rel = path.relative(bundleDir, abs).split(path.sep).join('/');
  return { abs, rel };
}

export function resolveRefTarget(bundleDir, ref) {
  if (!bundleDir || !ref) return null;
  const slug = ref.slug;
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null; // re-validate the stored slug
  const repoRoot = ref.repo
    ? path.resolve(String(ref.repo))
    : path.resolve(bundleDir, '..', '..', '..'); // <root>/docs/masterplan/<slug> → <root>
  const abs = path.resolve(repoRoot, 'docs', 'masterplan', slug, 'plan.html');
  if (!abs.startsWith(repoRoot + path.sep)) return null; // must resolve inside the stored repo root
  const rel = path.relative(bundleDir, abs).split(path.sep).join('/');
  return { abs, rel, repoRoot };
}

// Parse the ## Amendments section F2 appends to plan.md into ordered timeline entries. Accepts the
// full plan.md OR just the section. Entry heading: "### <date> — <summary>" (em-dash separated);
// following non-### lines are the detail body. Pure string parse — no fs, no clock.
export function parseAmendments(md) {
  if (typeof md !== 'string' || !md) return [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+Amendments\s*$/.test(lines[i])) i += 1;
  if (i >= lines.length) return [];
  i += 1;
  const entries = [];
  let cur = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // next H2 ends the Amendments section
    const m = /^###\s+(.*)$/.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      const head = m[1];
      const dm = /^(.*?)\s+—\s+(.*)$/.exec(head);
      cur = dm
        ? { date: dm[1].trim(), summary: dm[2].trim(), detail: [] }
        : { date: '', summary: head.trim(), detail: [] };
    } else if (cur) {
      cur.detail.push(line);
    }
  }
  if (cur) entries.push(cur);
  return entries.map((e) => ({ date: e.date, summary: e.summary, detail: e.detail.join('\n').trim() }));
}

function defaultFileExists(p) {
  try { return existsSync(p); } catch { return false; }
}

// Render plan.html. Optional meta.taskStatus ({id → status}) drives per-task badges for
// the live `render` verb; absent → all 'pending'. Pure function of (index, meta): no fs,
// no clock, no randomness, no measured text — identical input ⇒ byte-identical output
// (including the SVG). Any timestamp shown comes from meta/index.generated_at, never new Date().
export function renderPlanHtml(index, meta = {}) {
  // Coerce id/wave to numbers up front: render-plan does not run validatePlanIndex, so a
  // hand-edited index could carry a string id/wave. These two fields are interpolated raw
  // (not via escapeHtml), so numeric coercion is what keeps them from becoming markup —
  // Number('<x>') → NaN renders as "NaN", never an open tag.
  const tasks = Array.isArray(index?.tasks)
    ? index.tasks.map((t) => ({ ...t, id: Number(t.id), wave: Number(t.wave) })).sort((a, b) => a.id - b.id)
    : [];
  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  const statusMap = meta.taskStatus ?? {};
  const statusOf = (id) => {
    const s = statusMap[id];
    return PLAN_HTML_STATUSES.includes(s) ? s : 'pending';
  };
  // D7 (G6): surface the reason for blocked/waived as a badge tooltip so the plan visibly
  // distinguishes *why* a task is gated/waived, not just that it is. {id -> reason}, built by
  // the render verbs from task.block_reason / task.waive_reason. Absent -> no tooltip.
  const reasonMap = meta.taskReason ?? {};
  const reasonOf = (id) => (typeof reasonMap[id] === 'string' && reasonMap[id].trim() ? reasonMap[id] : '');
  const title = escapeHtml(meta.title ?? 'Plan');

  // Render-context (HUB): F1 (refs re-render) and F2 (amend re-render) call this inline.
  // `bundleDir` roots asset/ref-link path resolution; `fileExists` is injectable so the trust
  // boundary is testable offline (defaults to real fs). PRESENCE — not any render flag — decides
  // whether an image or a ref link is emitted (never a broken img/href).
  const bundleDir = meta.bundleDir ?? null;
  const fileExists = typeof meta.fileExists === 'function' ? meta.fileExists : defaultFileExists;
  const narrative = meta.narrative ?? (index && index.meta) ?? {};
  const refs = meta.refs ?? { back: [], forward: [] };
  const amendments = Array.isArray(meta.amendments)
    ? meta.amendments
    : parseAmendments(meta.amendmentsMd ?? meta.planMd ?? '');

  // Optional image, embedded strictly by-presence. Path-safe slot → never a broken/escaping img.
  const imgTag = (slot, cls, alt) => {
    if (!bundleDir) return '';
    const a = resolveAssetSrc(bundleDir, slot);
    if (!a || !fileExists(a.abs)) return '';
    return `<img class="${cls}" src="${escapeHtml(a.rel)}" alt="${escapeHtml(alt)}">`;
  };
  const hero = imgTag('hero', 'hero', 'Plan hero image');

  // Refs (header metadata) with by-presence links, UNIFORMLY (same-repo included).
  const refItem = (ref) => {
    const label = (typeof ref?.label === 'string' && ref.label)
      ? ref.label
      : (ref?.repo ? `${path.basename(String(ref.repo))}:${ref?.slug ?? ''}` : String(ref?.slug ?? ''));
    const tgt = bundleDir ? resolveRefTarget(bundleDir, ref) : null;
    if (tgt && fileExists(tgt.abs)) {
      return `<a href="${escapeHtml(tgt.rel)}">${escapeHtml(label)}</a>`;
    }
    return escapeHtml(label);
  };
  const refsBlock = (() => {
    const back = Array.isArray(refs?.back) ? refs.back : [];
    const forward = Array.isArray(refs?.forward) ? refs.forward : [];
    if (!back.length && !forward.length) return '';
    const rows = [];
    if (back.length) rows.push(`<li><strong>back:</strong> ${back.map(refItem).join(', ')}</li>`);
    if (forward.length) rows.push(`<li><strong>forward:</strong> ${forward.map(refItem).join(', ')}</li>`);
    return `<section class="meta"><div class="refs"><h2>References</h2><ul>${rows.join('')}</ul></div></section>`;
  })();

  // Narrative Purpose / Problem / Solution (optional meta).
  const narrativeBlock = (() => {
    const parts = [];
    for (const [key, heading] of [['purpose', 'Purpose'], ['problem', 'Problem'], ['solution', 'Solution']]) {
      const v = narrative?.[key];
      if (typeof v === 'string' && v.trim()) parts.push(`<h2>${heading}</h2><p>${escapeHtml(v)}</p>`);
    }
    return parts.length ? `<section class="narrative">${parts.join('')}</section>` : '';
  })();

  const sections = [];
  for (const w of waves) {
    const waveImg = imgTag(`wave-${w}`, 'wave-img', `Wave ${w} illustration`);
    sections.push(`<section class="wave"><h2>Wave ${w}</h2>${waveImg}`);
    sections.push(
      '<table><thead><tr><th>#</th><th>Status</th><th>Task</th><th>Files</th>' +
        '<th>Verify</th><th>Codex</th><th>Spec refs</th></tr></thead><tbody>'
    );
    for (const t of tasks.filter((x) => x.wave === w)) {
      const st = statusOf(t.id);
      const reasonTitle = reasonOf(t.id) ? ` title="${escapeHtml(reasonOf(t.id))}"` : '';
      const files = (t.files ?? []).map(escapeHtml).join('<br>') || '<em>(none)</em>';
      const vc = (t.verify_commands ?? []).map(escapeHtml).join('<br>') || '<em>(none)</em>';
      const codex = t.codex == null ? 'heuristic' : t.codex;
      const rf =
        Array.isArray(t.spec_refs) && t.spec_refs.length ? t.spec_refs.map(escapeHtml).join(', ') : '<em>—</em>';
      sections.push(
        '<tr>' +
          `<td>${t.id}</td>` +
          `<td><span class="badge status-${st}"${reasonTitle}>${st}</span></td>` +
          `<td>${escapeHtml(t.description)}</td>` +
          `<td class="mono">${files}</td>` +
          `<td class="mono">${vc}</td>` +
          `<td>${escapeHtml(codex)}</td>` +
          `<td>${rf}</td>` +
          '</tr>'
      );
    }
    sections.push('</tbody></table></section>');
  }

  // Goals block: distinct goals cited across tasks, sorted for determinism.
  const goalsBlock = (() => {
    const seen = new Set();
    const goals = [];
    for (const t of tasks) for (const g of (Array.isArray(t.goals) ? t.goals : [])) {
      const gs = String(g);
      if (!seen.has(gs)) { seen.add(gs); goals.push(gs); }
    }
    goals.sort();
    if (!goals.length) return '';
    return `<section class="goals"><h2>Goals</h2><ul>${goals.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul></section>`;
  })();

  // Amendments timeline, parsed from the ## Amendments markdown F2 writes.
  const amendmentsBlock = (() => {
    if (!Array.isArray(amendments) || !amendments.length) return '';
    const items = amendments.map((a) => {
      const date = a?.date ? `<time>${escapeHtml(a.date)}</time> — ` : '';
      const summary = `<span class="summary">${escapeHtml(a?.summary ?? '')}</span>`;
      const detail = a?.detail ? `<div class="detail">${escapeHtml(a.detail)}</div>` : '';
      return `<li>${date}${summary}${detail}</li>`;
    });
    return `<section class="amendments"><h2>Amendments</h2><ol class="timeline">${items.join('')}</ol></section>`;
  })();

  const summary = `${tasks.length} task(s) across ${waves.length} wave(s).`;
  const generated = meta.generated_at ?? index?.generated_at;
  const stamp = generated ? `<p class="stamp">Generated: ${escapeHtml(generated)}</p>` : '';
  const svg = renderWaveSvg(waves, tasks, statusOf);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PLAN_HTML_CSS}
</style>
</head>
<body>
<h1>${title}</h1>
<p class="summary">${summary}</p>
${stamp}
${hero}
${refsBlock}
${narrativeBlock}
<figure class="diagram">${svg}</figure>
${sections.join('\n')}
${goalsBlock}
${amendmentsBlock}
</body>
</html>
`;
}
