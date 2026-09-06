// lib/config.mjs — dependency-free resolver for the recognized .masterplan.yaml subset.
//
// Implements §4.1–§4.4 and §7.1 of the spec: CLI > repo > user > default precedence,
// whole-object replacement with partial context_watch defaults, complexity-derived
// planning mode, enum validation, `full` and `auto_compact` aliases, unknown-key
// warnings, and repo-only `done` (groups, steps, version_from, ${version}, commit_paths).
// Also exports readEnv(name) — the sole permitted process.env accessor — and
// childEnv(overrides), the single child-process environment passthrough, so no other
// module in lib/ or bin/ touches process.env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// YAML subset parser (mappings, indented nested mappings, sequences of scalars
// and of mappings, quoted/bare scalars, comments). Anything else is refused.
// ---------------------------------------------------------------------------

function stripComment(s) {
  // YAML comment rule: a `#` preceded by whitespace starts a comment, EXCEPT inside a scalar that
  // begins with a quote. Quotes embedded in a BARE scalar are ordinary characters and do not
  // protect a `#` (so `run: echo "a # b"` is `echo "a` in YAML — write a quoted scalar instead).
  const t = s.trimStart();
  let off = s.length - t.length;
  let body = t;
  if (body.startsWith('- ')) { body = body.slice(2); off += 2; }
  else if (body === '-') return s;
  // key separator: the first `: ` (or trailing `:`) in the body — keys are bare words
  let vstart = off;
  if (body[0] !== '"' && body[0] !== "'") {
    for (let k = 0; k < body.length; k++) {
      if (body[k] === ':' && (k === body.length - 1 || /\s/.test(body[k + 1]))) { vstart = off + k + 1; break; }
      if (body[k] === '#' && (k === 0 || /\s/.test(body[k - 1]))) return s.slice(0, off + k); // comment before any key
    }
  }
  while (s[vstart] === ' ' || s[vstart] === '\t') vstart++;
  const q = s[vstart];
  let scan = vstart;
  if (q === '"' || q === "'") {
    // walk to the closing quote of the quoted scalar (\" escapes in double quotes, '' in single)
    let i = vstart + 1;
    for (; i < s.length; i++) {
      if (q === '"' && s[i] === '\\') { i++; continue; }
      if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue; }
        break;
      }
    }
    scan = Math.min(i + 1, s.length);
  }
  for (let k = scan; k < s.length; k++) {
    if (s[k] === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k);
  }
  return s;
}

function findColon(s) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inD && c === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ':' && !inS && !inD && (i === s.length - 1 || /\s/.test(s[i + 1]))) return i; // YAML: key separator needs a following space
  }
  return -1;
}

function preprocess(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    const indent = stripped.match(/^ */)[0].length;
    lines.push({ indent, text: stripped.trim() });
  }
  return lines;
}

function unescapeDoubleQuoted(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') throw new Error(`unterminated quoted scalar: "${s}"`); // a raw quote closes the scalar; anything after it is malformed
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) throw new Error('dangling backslash in quoted scalar');
    if (n === '"' || n === '\\' || n === '/') { out += n; i++; continue; }
    if (n === 'n') { out += '\n'; i++; continue; }
    if (n === 't') { out += '\t'; i++; continue; }
    if (n === 'r') { out += '\r'; i++; continue; }
    if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 3; continue; }
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5; continue; }
    throw new Error(`unsupported escape \\${n} in quoted scalar`);
  }
  return out;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '') return null;
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (s.startsWith('{') || s.startsWith('[')) {
    throw new Error(`flow collections are not supported: ${s}`);
  }
  if (s.startsWith('&') || s.startsWith('*')) {
    throw new Error(`anchors/aliases are not supported: ${s}`);
  }
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"') || (s.endsWith('\\"') && !s.endsWith('\\\\"'))) throw new Error(`unterminated quoted scalar: ${s}`);
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw new Error(`unterminated quoted scalar: ${s}`);
    const inner = s.slice(1, -1);
    // YAML single-quoted scalars: the only escape is '' (one quote); a lone quote inside is malformed.
    if (/(^|[^'])'([^']|$)/.test(inner)) throw new Error(`unterminated quoted scalar: ${s}`);
    return inner.replace(/''/g, "'");
  }
  return s;
}

function parseMapping(lines, i, indent) {
  const obj = {};
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    const colon = findColon(line.text);
    if (colon === -1) {
      throw new Error(`expected 'key: value' but found '${line.text}'`);
    }
    const key = line.text.slice(0, colon).trim();
    if (key === '') throw new Error(`empty key in '${line.text}'`);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`forbidden key '${key}'`);
    }
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`duplicate key '${key}'`);
    }
    const rest = line.text.slice(colon + 1).trim();
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        obj[key] = child.value;
        i = child.nextIndex;
      } else {
        obj[key] = null;
        i++;
      }
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: obj, nextIndex: i };
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

function parseSequenceItem(lines, i, indent) {
  const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2).trim();
  if (rest === '') {
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseBlock(lines, i + 1, lines[i + 1].indent);
      return { value: child.value, nextIndex: child.nextIndex };
    }
    return { value: null, nextIndex: i + 1 };
  }
  const colon = findColon(rest);
  if (colon !== -1) {
    const key = rest.slice(0, colon).trim();
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`forbidden key '${key}'`);
    }
    const val = rest.slice(colon + 1).trim();
    const obj = {};
    if (val === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        obj[key] = child.value;
        return { value: obj, nextIndex: child.nextIndex };
      }
      obj[key] = null;
      return { value: obj, nextIndex: i + 1 };
    }
    obj[key] = parseScalar(val);
    let j = i + 1;
    if (j < lines.length && lines[j].indent > indent) {
      const child = parseMapping(lines, j, lines[j].indent);
      for (const k of Object.keys(child.value)) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) throw new Error(`duplicate key '${k}'`);
      }
      Object.assign(obj, child.value);
      return { value: obj, nextIndex: child.nextIndex };
    }
    return { value: obj, nextIndex: j };
  }
  return { value: parseScalar(rest), nextIndex: i + 1 };
}

function parseSequence(lines, i, indent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && isSeqItem(lines[i].text)) {
    const item = parseSequenceItem(lines, i, indent);
    arr.push(item.value);
    i = item.nextIndex;
  }
  return { value: arr, nextIndex: i };
}

function parseBlock(lines, i, indent) {
  const line = lines[i];
  if (isSeqItem(line.text)) return parseSequence(lines, i, indent);
  if (findColon(line.text) !== -1) return parseMapping(lines, i, indent);
  return { value: parseScalar(line.text), nextIndex: i + 1 };
}

export function parseMasterplanYaml(text) {
  const lines = preprocess(text);
  if (lines.length === 0) return {};
  const result = parseBlock(lines, 0, lines[0].indent);
  if (result.nextIndex < lines.length) {
    throw new Error('unexpected content after top-level mapping');
  }
  if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    throw new Error('top-level YAML must be a mapping');
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Schema metadata (consumed by the knob-inventory guard, §4.4).
// ---------------------------------------------------------------------------

// The planning modes, defined ONCE: the config schema below derives its enum from this, and
// lib/resume.mjs validates a caller-resolved mode against the same list. Two hand-maintained
// copies would drift, and the one in resume.mjs would drift silently — it fails closed.
export const PLANNING_MODES = ['serial', 'parallel', 'auto'];

export const CONFIG_SCHEMA = {
  complexity: { type: 'enum', values: ['low', 'medium', 'high'], default: 'medium' },
  autonomy: { type: 'enum', values: ['gated', 'loose'], default: 'gated', aliases: { full: 'loose' } },
  planning_mode: { type: 'enum', values: PLANNING_MODES, default: null },
  adversary_review: { type: 'enum', values: ['on', 'off'], default: 'on' },
  render_images: { type: 'enum', values: ['on', 'off'], default: 'off' },
  fabric: { type: 'enum', values: ['on', 'off'], default: 'on' },
  'context_watch.threshold': { type: 'int', min: 1, max: 99, default: 70 },
  'context_watch.focus': { type: 'string|null', default: null },
  context_watch: { type: 'object', default: { threshold: 70, focus: null } },
  // §5.3 convergence: the schema-backed probing minimum per complexity. Whole-object
  // replacement at each hierarchy layer, per-key defaults below (validateProbingMinimum
  // enforces the invariants fail-closed at resolution). Defaults are CONFIGURATION, not
  // invariants (spec §5.3 names low 1 / medium 2 / high 4 as the shipped defaults).
  'interview.probing_minimum': { type: 'object', default: { low: 1, medium: 2, high: 4 } },
  interview: { type: 'object', default: { probing_minimum: { low: 1, medium: 2, high: 4 } } },
  'done.version_from': { type: 'string' },
  'done.release': { type: 'step-list' },
  'done.install': { type: 'step-list' },
  'done.user_only': { type: 'user-step-list' },
  'done.live_check': { type: 'step-list' },
  'done.commit_paths': { type: 'path-list' },
  done: { type: 'object|none', repoOnly: true },
};

// ---------------------------------------------------------------------------
// Environment access (the only module allowed to touch process.env).
// ---------------------------------------------------------------------------

export function readEnv(name, env = process.env) {
  return env[name];
}

export function childEnv(overrides = {}, env = process.env) {
  return { ...env, ...overrides };
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function validateEnum(key, value, warnings) {
  const schema = CONFIG_SCHEMA[key];
  if (schema.aliases && Object.prototype.hasOwnProperty.call(schema.aliases, value)) {
    warnings.push(`${key} '${value}' is deprecated; use '${schema.aliases[value]}'`);
    value = schema.aliases[value];
  }
  if (!schema.values.includes(value)) {
    throw new Error(`invalid ${key} '${value}'; allowed: ${schema.values.join('|')}`);
  }
  return value;
}

function complexityPlanningDefault(complexity) {
  return complexity === 'low' ? 'serial' : 'auto';
}

function normalizeContextWatch(obj, defaults, warnings, alias = false) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('context_watch must be an object');
  }
  const known = new Set(['threshold', 'focus']);
  const dropped = Object.keys(obj).filter((k) => !known.has(k));
  if (dropped.length > 0) {
    if (alias) {
      warnings.push(`auto_compact is deprecated; use context_watch — keys ${dropped.join(', ')} are not supported and were ignored`);
    } else {
      warnings.push(`context_watch unknown nested key(s): ${dropped.join(', ')} — ignored`);
    }
  } else if (alias) {
    warnings.push('auto_compact is deprecated; use context_watch');
  }
  const threshold = obj.threshold !== undefined ? obj.threshold : defaults.threshold;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > 99) {
    throw new Error('context_watch.threshold must be an integer 1–99');
  }
  const focus = obj.focus !== undefined ? obj.focus : defaults.focus;
  if (focus !== null && typeof focus !== 'string') {
    throw new Error('context_watch.focus must be a string or null');
  }
  return { threshold, focus };
}

const DONE_GROUPS = ['release', 'install', 'user_only', 'live_check'];

function validateStep(group, step) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error('done step must be an object');
  }
  const allowed = group === 'user_only' ? ['text', 'check'] : ['run', 'check'];
  for (const key of Object.keys(step)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown step field '${key}' in ${group} step`);
    }
  }
  if (group === 'user_only') {
    if (typeof step.text !== 'string' || typeof step.check !== 'string') {
      throw new Error('user_only step must be {text, check}');
    }
    if (step.run !== undefined) {
      throw new Error('user_only step must be {text, check}, not {run, ...}');
    }
  } else {
    if (typeof step.run !== 'string') {
      throw new Error(`${group} step must have a 'run' command`);
    }
    if (step.check !== undefined && typeof step.check !== 'string') {
      throw new Error(`${group} step 'check' must be a string`);
    }
    if (step.text !== undefined) {
      throw new Error(`${group} step must be {run, check?}, not {text, ...}`);
    }
  }
}

export function validateDoneDefinition(done, warnings = []) {
  if (done === 'none') return 'none';
  if (done === null || typeof done !== 'object' || Array.isArray(done)) {
    throw new Error(`done must be an object or the literal 'none'`);
  }
  const known = new Set([...DONE_GROUPS, 'version_from', 'commit_paths']);
  for (const key of Object.keys(done)) {
    if (!known.has(key)) {
      throw new Error(`unknown done group '${key}'`);
    }
  }
  const versionFrom = done.version_from;
  if (versionFrom !== undefined && typeof versionFrom !== 'string') {
    throw new Error('done.version_from must be a file path string');
  }
  if (versionFrom !== undefined) {
    if (versionFrom === '' || versionFrom.startsWith('/') || versionFrom.split('/').includes('..')) {
      throw new Error('done.version_from must be a repo-relative path');
    }
  }
  if (versionFrom === undefined && JSON.stringify(done).includes('${version}')) {
    throw new Error('done uses ${version} but has no version_from');
  }
  for (const group of DONE_GROUPS) {
    if (done[group] === undefined) continue;
    if (!Array.isArray(done[group])) {
      throw new Error(`done.${group} must be a list of steps`);
    }
    for (const step of done[group]) validateStep(group, step);
  }
  let commitPaths;
  if (done.commit_paths === undefined) {
    commitPaths = [versionFrom, 'CHANGELOG.md'].filter((p) => p !== undefined);
  } else {
    if (!Array.isArray(done.commit_paths) || done.commit_paths.some((p) => typeof p !== 'string')) {
      throw new Error('done.commit_paths must be a list of file paths');
    }
    commitPaths = [];
    for (const p of done.commit_paths) {
      if (p === versionFrom || /changelog/i.test(p)) {
        commitPaths.push(p);
      } else {
        warnings.push(`commit_paths entry '${p}' is not the version_from file or a changelog; ignored`);
      }
    }
  }
  const result = { ...done, commit_paths: commitPaths };
  return result;
}

export function substituteVersion(command, version) {
  if (version === undefined || version === null) {
    throw new Error('cannot substitute ${version}: no version resolved');
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`hostile or invalid version '${version}'`);
  }
  return command.replace(/\$\{version\}/g, `'${version}'`);
}

export function doneDigest(done) {
  return createHash('sha256').update(JSON.stringify(done)).digest('hex');
}

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

function pick(cli, repo, user, key) {
  if (cli[key] !== undefined) return { value: cli[key], source: 'cli' };
  if (repo[key] !== undefined) return { value: repo[key], source: 'repo' };
  if (user[key] !== undefined) return { value: user[key], source: 'user' };
  return { value: undefined, source: 'default' };
}

// ---- §5.3 probing minimum (schema-backed convergence config) -------------------

/** The shipped defaults (spec §5.3: low 1, medium 2, high 4) — configuration, not invariants. */
export const DEFAULT_PROBING_MINIMUM = Object.freeze({ low: 1, medium: 2, high: 4 });

/**
 * Validate a probing-minimum map FAIL-CLOSED (spec §5.3): every level an integer >= 1,
 * values non-decreasing as complexity rises, and high STRICTLY greater than low. A
 * configuration violating any constraint throws at resolution — never a silent fixup.
 * Per-key defaults apply first (partial maps merge over DEFAULT_PROBING_MINIMUM), so the
 * invariants are checked on the EFFECTIVE values the interview will use.
 */
export function validateProbingMinimum(value) {
  const fail = (why) => {
    throw new Error(`interview.probing_minimum is invalid (${why}) — the probing minimum resolves fail-closed: an integer >= 1 per level, non-decreasing with complexity, high strictly greater than low (spec §5.3)`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('must be a mapping of complexity levels to integers');
  const effective = { ...DEFAULT_PROBING_MINIMUM };
  for (const k of Object.keys(value)) {
    if (!(k in DEFAULT_PROBING_MINIMUM)) fail(`unknown complexity level ${JSON.stringify(k)} (expected low, medium, high)`);
    if (!Number.isInteger(value[k]) || value[k] < 1) fail(`${k} must be an integer >= 1 (got ${JSON.stringify(value[k])})`);
    effective[k] = value[k];
  }
  if (!(effective.low <= effective.medium && effective.medium <= effective.high)) {
    fail(`values must be non-decreasing with complexity (low ${effective.low} <= medium ${effective.medium} <= high ${effective.high})`);
  }
  if (!(effective.high > effective.low)) {
    fail(`high (${effective.high}) must be strictly greater than low (${effective.low})`);
  }
  return Object.freeze(effective);
}

/** Resolve the effective probing minimum for a complexity from a resolved config (or the defaults). */
export function resolveProbingMinimum(resolvedConfig, complexity) {
  const raw = resolvedConfig?.values?.interview?.probing_minimum ?? resolvedConfig?.interview?.probing_minimum;
  const effective = validateProbingMinimum(raw ?? DEFAULT_PROBING_MINIMUM);
  return effective[complexity] ?? effective.medium;
}

function resolveInterview(cli, repoData, userData, warnings) {
  if (cli.interview !== undefined) {
    warnings.push('interview is only honored from the repo-local or user .masterplan.yaml; CLI value ignored');
  }
  if (repoData.interview !== undefined) {
    return { value: { probing_minimum: validateProbingMinimum(repoData.interview.probing_minimum ?? DEFAULT_PROBING_MINIMUM) }, source: 'repo' };
  }
  if (userData.interview !== undefined) {
    return { value: { probing_minimum: validateProbingMinimum(userData.interview.probing_minimum ?? DEFAULT_PROBING_MINIMUM) }, source: 'user' };
  }
  return { value: { probing_minimum: Object.freeze({ ...DEFAULT_PROBING_MINIMUM }) }, source: 'default' };
}

function resolveContextWatch(cli, repoData, userData, warnings) {
  const defaults = { threshold: 70, focus: null };
  for (const [label, data] of [['repo', repoData], ['user', userData]]) {
    if (data.context_watch !== undefined && data.auto_compact !== undefined) {
      throw new Error(`duplicate alias: both context_watch and auto_compact present in ${label} file`);
    }
  }
  if (cli.context_watch !== undefined) {
    return { value: normalizeContextWatch(cli.context_watch, defaults, warnings), source: 'cli' };
  }
  if (cli.auto_compact !== undefined) {
    return { value: normalizeContextWatch(cli.auto_compact, defaults, warnings, true), source: 'cli' };
  }
  if (repoData.context_watch !== undefined) {
    return { value: normalizeContextWatch(repoData.context_watch, defaults, warnings), source: 'repo' };
  }
  if (repoData.auto_compact !== undefined) {
    return { value: normalizeContextWatch(repoData.auto_compact, defaults, warnings, true), source: 'repo' };
  }
  if (userData.context_watch !== undefined) {
    return { value: normalizeContextWatch(userData.context_watch, defaults, warnings), source: 'user' };
  }
  if (userData.auto_compact !== undefined) {
    return { value: normalizeContextWatch(userData.auto_compact, defaults, warnings, true), source: 'user' };
  }
  return { value: { ...defaults }, source: 'default' };
}

function resolveDone(cli, repoData, userData, warnings) {
  if (cli.done !== undefined) {
    warnings.push('done is only honored from the repo-local .masterplan.yaml; CLI value ignored');
  }
  if (userData.done !== undefined) {
    warnings.push('done is only honored from the repo-local .masterplan.yaml; user-global value ignored');
  }
  if (repoData.done !== undefined) {
    return { value: validateDoneDefinition(repoData.done, warnings), source: 'repo' };
  }
  return { value: undefined, source: 'default' };
}

export function resolveRunConfig({ cli = {}, repoRoot, home = os.homedir(), env = process.env } = {}) {
  const warnings = [];
  const sources = {};
  const values = {};

  const userFile = path.join(home, '.masterplan.yaml');
  const repoFile = path.join(repoRoot, '.masterplan.yaml');

  let userData = {};
  if (fs.existsSync(userFile)) {
    userData = parseMasterplanYaml(fs.readFileSync(userFile, 'utf8'));
  }
  let repoData = {};
  if (fs.existsSync(repoFile)) {
    repoData = parseMasterplanYaml(fs.readFileSync(repoFile, 'utf8'));
  }

  for (const [label, data] of [['repo', repoData], ['user', userData]]) {
    for (const key of Object.keys(data)) {
      if (!Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, key) && key !== 'auto_compact') {
        warnings.push(`unsupported key '${key}' (v7) — ignored`);
      }
    }
  }

  const complexityPick = pick(cli, repoData, userData, 'complexity');
  values.complexity = validateEnum('complexity', complexityPick.value ?? 'medium', warnings);
  sources.complexity = complexityPick.value !== undefined ? complexityPick.source : 'default';

  const autonomyPick = pick(cli, repoData, userData, 'autonomy');
  values.autonomy = validateEnum('autonomy', autonomyPick.value ?? 'gated', warnings);
  sources.autonomy = autonomyPick.value !== undefined ? autonomyPick.source : 'default';

  const planningPick = pick(cli, repoData, userData, 'planning_mode');
  if (planningPick.value !== undefined) {
    values.planning_mode = validateEnum('planning_mode', planningPick.value, warnings);
    sources.planning_mode = planningPick.source;
  } else {
    values.planning_mode = complexityPlanningDefault(values.complexity);
    sources.planning_mode = 'default';
  }

  for (const key of ['adversary_review', 'render_images', 'fabric']) {
    const p = pick(cli, repoData, userData, key);
    values[key] = validateEnum(key, p.value ?? CONFIG_SCHEMA[key].default, warnings);
    sources[key] = p.value !== undefined ? p.source : 'default';
  }

  const cw = resolveContextWatch(cli, repoData, userData, warnings);
  values.context_watch = cw.value;
  sources.context_watch = cw.source;

  const iv = resolveInterview(cli, repoData, userData, warnings);
  values.interview = iv.value;
  sources.interview = iv.source;

  const done = resolveDone(cli, repoData, userData, warnings);
  values.done = done.value;
  sources.done = done.source;

  return { values, sources, warnings };
}

// ---------------------------------------------------------------------------
// Revision re-resolution (§7.1): read done from <MAIN>/.masterplan.yaml at a
// git SHA and compute its digest.
// ---------------------------------------------------------------------------

export function resolveDoneAtRevision(repoRoot, sha, { env = process.env } = {}) {
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'show', `${sha}:.masterplan.yaml`], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    // Only an ABSENT PATH at a valid revision is "no definition"; an invalid revision, a
    // non-repository, or any other git failure must surface, never masquerade as absent.
    if (/does not exist in '|exists on disk, but not in|path '[^']*' does not exist/.test(stderr)) {
      return { done: undefined, digest: null };
    }
    throw new Error(`resolveDoneAtRevision: ${stderr.trim() || e.message}`);
  }
  const data = parseMasterplanYaml(out);
  if (data.done === undefined) return { done: undefined, digest: null };
  const done = validateDoneDefinition(data.done);
  return { done, digest: doneDigest(done) };
}
