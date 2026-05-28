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
export function markTask(state, id, status) {
  const tasks = (state.tasks ?? []).map((task) => (task.id === id ? { ...task, status } : task));
  return { ...state, tasks };
}
