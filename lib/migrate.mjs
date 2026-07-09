// lib/migrate.mjs — version-keyed read-compat for legacy run bundles (build step 1; Resolved #7).
//
// v8 owns a FLAT state.yml (lib/bundle.mjs). Pre-v8 bundles are PyYAML block-style: deeply
// nested (brainstorm_anchor.evidence[] folded scalars, \u/\x escapes), alphabetized keys. We do
// NOT parse the nested blobs — v8 carries forward only a small flat field set, so a TARGETED
// line-extractor suffices. This is the deliberate zero-dep choice: no python-shell (sheds v7's
// coupling), no hand-rolled general YAML parser (the fragility this rebuild exists to kill).
//
// Dial (Resolved #7): the live population is single-version (5.x), so the multi-rung ladder
// collapses to a one-shot 5.x -> schema 8 migrate; >=6 passes through; pre-5.0 is REFUSED loudly (R3:
// a silently-broken upgrade re-opens a defect the owner already paid for). Evidence: a real
// in-flight 5.0 bundle with a mixed-status task list existed in the live population (frozen
// here, sanitized, as the 5.0-inflight-sample fixture), so the task-list extractor is real
// code, not a dead path.
//
// SAFETY (advisor refinement): when a task/gate structure can't be confidently parsed, THROW —
// never emit a half-migrated state. The caller backs up the original *before* calling migrate(),
// so a refusal is recoverable (re-import / finish under v7), never silent corruption.
//
// STEP-2 CONTRACT (non-blocking): migrated tasks carry {id, status, wave: null, files: []}. A
// legacy bundle has no v8 plan.index.json, so on first resume the L1 shell must re-derive each
// task's wave + file-scope from a plan.md re-parse. That belongs in step 2, not here.

import { parseState } from './bundle.mjs';

const GUIDANCE =
  'Do NOT hand-rewrite state.yml to schema 6 (CD-7 violation). The original is preserved as ' +
  'read-only reference. To continue: `mp seed` a FRESH schema-6 bundle and re-run ' +
  'brainstorm→plan→seed-tasks (§3), finish this run under masterplan v7, or stop and ask the user.';

// Thrown for an unsupported version or an unparseable legacy structure. A distinct class so the
// L1 shell can catch a migration refusal specifically and surface it (vs. an unexpected crash).
export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

// Tolerant across quote styles ('5.1' | "5.0" | 5.0) and a leading `---` doc marker. The decimal
// is OPTIONAL: v8's serializeState emits whole versions as bare integers (`schema_version: 6` —
// JS `String(6.0) === "6"`, so the decimal is lost on the first write cycle). A decimal-required
// regex would therefore reject every v8 bundle the moment the shell writes it back, wedging the
// loop after one state mutation. Detection must accept the canonical bare-integer form too.
const VERSION_RE = /^\s*schema_version:\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/m;

export function detectSchemaVersion(text = '') {
  const m = String(text).match(VERSION_RE);
  return m ? m[1] : null;
}

// A column-0 `key: value` scalar (block-YAML top level). Nested/indented lines and folded-scalar
// continuations never start at column 0, so they're skipped — which is exactly why we can ignore
// brainstorm_anchor.evidence[] and multi-line note:/next_action: values without parsing them.
const SCALAR_RE = /^([A-Za-z_][\w]*):[ \t]*(.*)$/;
const TASK_ITEM_RE = /^[ \t]*-[ \t]+idx:[ \t]*(\d+)/; // `- idx: N` at any indent (wbn col-0, codex indented)
const STATUS_RE = /^[ \t]+status:[ \t]*['"]?([A-Za-z_-]+)/;

function unquote(v) {
  const s = String(v).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

// Extract ONLY the resume-relevant fields from a v5.x block-YAML bundle. Tolerant: any field may
// be absent (5.0 bundles vary — some carry `status`, some only `current_phase`). Fail-loud on a
// task item that has an idx but no status, or a non-null pending_gate with no extractable id.
export function extractLegacyFields(text = '') {
  const lines = String(text).split('\n');
  const scalars = {};
  let tasksAt = -1;
  let gateAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SCALAR_RE);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (key === 'tasks' && tasksAt === -1) tasksAt = i;
    if (key === 'pending_gate' && gateAt === -1) gateAt = i;
    if (!(key in scalars)) scalars[key] = rawVal; // first occurrence wins (top-level keys are unique)
  }

  // ---- tasks: bounded region scan. Stop at the next column-0 key so sibling keys/lists after the
  // task block (e.g. `recent_events:` with its own `- "..."` items) are never mis-read as tasks. ----
  const tasks = [];
  if (tasksAt !== -1) {
    let cur = null;
    for (let i = tasksAt + 1; i < lines.length; i++) {
      const line = lines[i];
      if (SCALAR_RE.test(line)) break; // next column-0 key => end of the tasks block
      const item = line.match(TASK_ITEM_RE);
      if (item) {
        if (cur) finalizeTask(cur, tasks);
        cur = { idx: Number(item[1]), status: null };
        continue;
      }
      if (cur && cur.status === null) {
        const st = line.match(STATUS_RE);
        if (st) cur.status = st[1];
      }
    }
    if (cur) finalizeTask(cur, tasks);
  }

  // ---- pending_gate: null/absent => null; inline/block with an id => {id, opened_at}; block
  // content but no id => fail-loud (advisor refinement: never silently drop a live gate) ----
  let pending_gate = null;
  if (gateAt !== -1) {
    pending_gate = parseGate(lines, gateAt, unquote(scalars.pending_gate ?? 'null'));
  }

  return {
    schema_version: detectSchemaVersion(text),
    slug: scalars.slug != null ? unquote(scalars.slug) : null,
    status: scalars.status != null ? unquote(scalars.status) : null,
    phase:
      scalars.current_phase != null
        ? unquote(scalars.current_phase)
        : scalars.phase != null
          ? unquote(scalars.phase)
          : null,
    current_wave: /^\d+$/.test(unquote(scalars.current_wave ?? ''))
      ? Number(unquote(scalars.current_wave))
      : null,
    pending_gate,
    tasks,
  };
}

function finalizeTask(cur, tasks) {
  if (cur.status === null) {
    throw new MigrationError(
      `Legacy task idx ${cur.idx} has no status — cannot confidently migrate this bundle. ${GUIDANCE}`
    );
  }
  tasks.push(cur);
}

// pending_gate dual-form is gone in v8 (Resolved #1: one durable marker). We only need its `id`.
// Four shapes: `null`/`{}`/absent => null; inline `{id: x, ...}`; block form on following indented
// lines; bare `pending_gate:` with no block => null. Block content present but no id => fail-loud.
function parseGate(lines, gateAt, inline) {
  if (inline === 'null' || inline === '~') return null;
  if (inline !== '') {
    // inline form, e.g. `{id: plan_approval, opened_at: t}` or `{}`
    const id = inline.match(/id:\s*['"]?([A-Za-z0-9_-]+)/);
    if (id) {
      const oa = inline.match(/opened_at:\s*['"]?([^'",}]+)/);
      return { id: id[1], opened_at: oa ? oa[1].trim() : null };
    }
    if (/^\{\s*\}$/.test(inline)) return null; // `{}` empty map => null
    throw new MigrationError(`pending_gate is non-null but has no extractable id. ${GUIDANCE}`);
  }
  // empty inline => block form on following indented lines
  let foundId = null;
  let opened_at = null;
  let sawBlock = false;
  for (let i = gateAt + 1; i < lines.length; i++) {
    if (SCALAR_RE.test(lines[i])) break; // dedent to the next top-level key => end of gate block
    if (!/^[ \t]+\S/.test(lines[i])) continue; // blank / non-content line
    sawBlock = true;
    const id = lines[i].match(/^[ \t]+id:[ \t]*['"]?([A-Za-z0-9_-]+)/);
    if (id && foundId === null) foundId = id[1];
    const oa = lines[i].match(/^[ \t]+opened_at:[ \t]*['"]?([^'"\n]+)/);
    if (oa) opened_at = oa[1].trim();
  }
  if (!sawBlock) return null; // bare `pending_gate:` with nothing following => null
  if (foundId === null) {
    throw new MigrationError(`pending_gate is non-null but has no extractable id. ${GUIDANCE}`);
  }
  return { id: foundId, opened_at };
}

// v8 cares about dispatchable-vs-not (lib/resume.mjs filters out done/blocked/waived). An in_progress task from
// a dead session is NOT done — it re-dispatches, so it normalizes to 'pending'.
function normStatus(s) {
  return /^(complete|completed|done)$/i.test(String(s)) ? 'done' : 'pending';
}

function mapLegacyToV8(legacy) {
  return {
    // The canonical v8 schema is the NUMBER 8 (buildSeedState's `schemaVersion: 8`), not a string.
    // The doctor's state-schema check runs validateCoreState on every >=6 bundle, and its
    // `typeof === 'number'` rule false-ERRORs a string — so the prior '6.0' (both wrong-typed AND a
    // stale schema-6-era value) flagged every freshly-migrated bundle. `migrated_from` (below)
    // preserves the legacy provenance; the >=6 passthrough floor is unchanged (forward-compat).
    schema_version: 8,
    migrated_from: legacy.schema_version,
    slug: legacy.slug,
    status: legacy.status ?? legacy.phase,
    phase: legacy.phase,
    current_wave: legacy.current_wave,
    pending_gate: legacy.pending_gate,
    active_run: null, // a dead session leaves no live workflow; resume re-derives from tasks
    tasks: legacy.tasks.map((t) => ({ id: t.idx, status: normStatus(t.status), wave: null, files: [] })),
    refs: legacy.refs != null ? legacy.refs : { back: [], forward: [] },
    render: legacy.render != null ? legacy.render : { images: 'off' },
  };
}

// Entry point: detect version, route, return a v8 state object (or throw). Applied on load.
//   >= 6.x  -> already flat v8-era; pass through the flat parser unchanged.
//   5.x     -> targeted extract + one-shot field map to schema 8.
//   < 5.0   -> refuse loudly (caller has preserved the original).
export function migrate(text = '') {
  const v = detectSchemaVersion(text);
  if (v === null) {
    throw new MigrationError(`No schema_version found — bundle predates schema 5.0. ${GUIDANCE}`);
  }
  const major = Number(v.split('.')[0]);
  if (major >= 6) {
    const state = parseState(text);
    if (state.refs == null) state.refs = { back: [], forward: [] };
    if (state.render == null) state.render = { images: 'off' };
    return state;
  }
  if (major === 5) {
    const migrated = mapLegacyToV8(extractLegacyFields(text));
    // Fail loud (same R3 contract as the task/gate refusals above) when a legacy bundle is missing a
    // core identity field. A null slug/status/phase would otherwise persist as structurally-invalid v8
    // state that `decide` and the doctor flag but no `mp` verb can repair — forcing a CD-7 hand-edit or
    // a destructive re-seed. Presence-only on the carried-over trio: schema_version/tasks are set by
    // mapLegacyToV8 itself, and full validateCoreState is deliberately NOT used — it rejects migrate's
    // string `schema_version` (a separate, orthogonal defect), which would regress every migration.
    for (const f of ['slug', 'status', 'phase']) {
      if (migrated[f] == null) {
        throw new MigrationError(`legacy bundle is missing required core field '${f}' — cannot migrate to v8. ${GUIDANCE}`);
      }
    }
    return migrated;
  }
  throw new MigrationError(`schema_version ${v} predates the supported floor (5.0). ${GUIDANCE}`);
}
