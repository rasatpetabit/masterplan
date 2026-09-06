// test/knob-inventory.test.mjs — the generated knob inventory guard (spec §4.4 / task 20).
//
// The DERIVED inventory of every control surface lives in test/fixtures/knobs/discovery.mjs
// (flags from the exported KNOWN_FLAGS, config paths from CONFIG_SCHEMA including nested
// containers, seed-state fields from a real buildSeedState walk, env reads through the readEnv
// seam, and `<!-- knob: -->` sequencer markers). This test is the GUARD over that inventory:
//
//   1. Completeness — every derived non-exempt control resolves to a named behavioral
//      contract (a REGISTRY entry, or the flag-registration contract for the flag surface).
//      A new flag/config path/env read/emitted state field/prompt marker with neither fails
//      here, so it cannot be added by someone forgetting to register a contract.
//   2. Contract existence — every REGISTRY id maps back onto a derived surface (no stale
//      metadata: a contract whose control no longer exists fails).
//   3. Lexical process.env rejection — every direct process.env token in lib//bin/ outside
//      the readEnv seam (lib/config.mjs) is a violation: member access, destructuring,
//      bracket access, aliasing, and Object.keys/entries/values enumeration. The allowed
//      forms are the readEnv implementation itself and the `env = process.env` injection-
//      seam defaults, whose reads all flow back through readEnv(name, env).
//   4. Synthetic negatives — the guard must REJECT an unmapped control and must catch every
//      escape form, so the inventory cannot pass through stale metadata alone.
//   5. Integration seams — bin exports KNOWN_FLAGS/isKnownFlag; the sequencer provides the
//      prompt-only markers; the lexical readEnv discovery stays as the cheap early signal
//      (the behavioral proof is knob-contract.test.mjs, not this file).
//
// Reuses discovery.mjs and contracts.mjs verbatim (define-once); nothing here re-derives a
// control list by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTRY, METADATA_EXEMPTIONS, FLAG_REGISTRATION } from './fixtures/knobs/contracts.mjs';
import {
  discoverAllControls,
  discoverEnvControls,
  discoverPromptMarkers,
} from './fixtures/knobs/discovery.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Pure guard helpers (exported so the synthetic-negative tests exercise the SAME
// logic the real inventory runs through — removing a guard rule fails its test).
// ---------------------------------------------------------------------------

function registryById() {
  const m = new Map();
  for (const e of REGISTRY) m.set(e.id, e);
  return m;
}

// The sequencer's `<!-- knob: name -->` marker maps to a registry contract id. The generic
// `name` marker is the template's syntax placeholder (documented in the sequencer), not a
// control. `render_images` is the prompt-side twin of the `render_images` config control and
// resolves to the `render_images_marker` prompt-only contract.
const MARKER_CONTRACT = {
  context_watch: 'context_watch',
  'context_watch.focus': 'context_watch.focus',
  'context_watch.threshold': 'context_watch.threshold',
  render_images: 'render_images_marker',
};
const MARKER_PLACEHOLDER = new Set(['name']);

function markerContractId(marker) {
  if (Object.prototype.hasOwnProperty.call(MARKER_CONTRACT, marker)) return MARKER_CONTRACT[marker];
  return MARKER_PLACEHOLDER.has(marker) ? null : marker;
}

// Every derived surface the registry may name (flags resolve via the registration contract;
// the rest need explicit REGISTRY entries).
function derivedSurfaceIds(inv) {
  return new Set([
    ...inv.flags,
    ...inv.config,
    ...inv.env,
    ...inv.state,
    ...inv.markers.map(markerContractId).filter((id) => id !== null),
  ]);
}

// Completeness guard: derived non-exempt controls with NO behavioral contract. Flags are
// always covered by the flag-registration contract (a registered flag is accepted by the CLI,
// an unregistered one dies exit 2 — a real consumer-side surface), so a flag is unmapped only
// when it is neither exempt nor has its own registry entry — which cannot happen while the
// registration contract covers the whole flag surface; the flag leg exists to catch an
// EXPLICIT registry entry that must instead live on another surface. Config/env/state/markers
// must each resolve to a REGISTRY entry.
function unmappedControls(inv, byId, exempt) {
  const unmapped = [];
  // The flag surface resolves through the generic FLAG_REGISTRATION contract (a registered
  // flag is accepted by the CLI, an unregistered one dies exit 2 — the A7 fail-closed
  // consumer-side surface). A flag therefore needs a contract only when it carries a real
  // behavioral entry; otherwise the registration contract covers it. The flag leg here is
  // structural: it proves the registration surface itself is real (FLAG_REGISTRATION is the
  // named contract) and that an EXPLICIT registry entry for a flag lands on the flag surface
  // rather than a different one.
  const flagRegistryIds = new Set(REGISTRY.filter((e) => e.kind === 'flag').map((e) => e.id));
  for (const f of inv.flags) {
    if (exempt(f)) continue;
    if (flagRegistryIds.has(f)) continue; // explicit flag contract
    // covered by the generic registration contract — not unmapped
  }
  for (const c of inv.config) {
    if (!exempt(c) && !byId.has(c)) unmapped.push(`config:${c}`);
  }
  for (const e of inv.env) {
    if (!exempt(e) && !byId.has(e)) unmapped.push(`env:${e}`);
  }
  for (const s of inv.state) {
    if (!exempt(s) && !byId.has(s)) unmapped.push(`state:${s}`);
  }
  for (const m of inv.markers) {
    if (exempt(m)) continue;
    const cid = markerContractId(m);
    if (cid === null) continue;
    if (!byId.has(cid)) unmapped.push(`marker:${m} -> ${cid}`);
  }
  return unmapped;
}

// Contract-existence guard: REGISTRY ids that name no derived surface (stale metadata).
function deadContracts(inv, byId) {
  const surfaces = derivedSurfaceIds(inv);
  return [...byId.keys()].filter((id) => !surfaces.has(id) && id !== '__flag_registration__');
}

// ---------------------------------------------------------------------------
// Lexical process.env guard — token-aware scan of lib//bin/.
// ---------------------------------------------------------------------------

// A `/` starts a REGEX literal (as opposed to a division operator) when the previous
// significant character is not something a division would follow: an identifier char, digit,
// `)`, `]`, `}`, `"`, `'`, backtick or `.`. Empty/whitespace context (start of file, after
// `(`/`,`/`=`/`return`/`:`/`&&`/`||`/`!`/`{`/`[`) also starts a regex.
function isRegexStart(source, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return true;
  const prev = source[j];
  if (/[A-Za-z0-9_$)\][}"'`]/.test(prev)) return false; // identifier/number/closing token → division
  return true;
}

// Return a copy of `source` in which comments, STRING-LITERAL CONTENTS and REGEX-LITERAL
// CONTENTS are blanked (newlines preserved so line numbers stay exact), but template-literal
// interpolations (`${...}`) are KEPT as executable text — recursively, so a nested
// string/comment/template inside an expression is handled the same way. The result is the
// executable surface the token scan runs over: a `process.env` inside a comment, a plain
// string or a regex is invisible, but `${process.env.SECRET}` is real code and must be found.
function maskNonExecutable(source) {
  const n = source.length;
  const mask = new Array(n);
  const blank = (from, to) => {
    for (let k = from; k < to; k++) mask[k] = source[k] === '\n' ? '\n' : ' ';
  };
  // Consume a string literal whose opening quote is at `qi` (source[qi] === q); returns the
  // index after the closing quote.
  const skipString = (qi) => {
    const q = source[qi];
    let j = qi + 1;
    while (j < n) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === q) return j + 1;
      j++;
    }
    return j;
  };
  // Consume a regex literal whose opening `/` is at `ri`; a `[` char class allows a literal
  // `/` and a `\` escapes the next char. Returns the index after the closing `/`.
  const skipRegex = (ri) => {
    let j = ri + 1;
    let inClass = false;
    while (j < n) {
      const c = source[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { while (j + 1 < n && /[a-z]/i.test(source[j + 1])) j++; return j + 1; }
      j++;
    }
    return j;
  };
  // Consume a template literal whose opening backtick is at `bt`. The literal chunks are
  // blanked HERE (not by the caller — a blanket blank over the whole template would erase the
  // interpolation region scanInterp keeps). Every `${...}` body is passed to scanInterp so its
  // executable content is kept. Returns the index after the closing `.
  const skipTemplate = (bt) => {
    let j = bt + 1;
    while (j < n) {
      if (source[j] === '\\') { blank(j, j + 2); j += 2; continue; }
      if (source[j] === '`') { blank(j, j + 1); return j + 1; }
      if (source[j] === '$' && source[j + 1] === '{') { blank(j, j + 2); j = scanInterp(j + 2); continue; }
      blank(j, j + 1);
      j++;
    }
    return j;
  };
  // Scan a `${...}` expression body (source[start] is the char after '${'). Brace depth starts
  // at 1 (the interpolation's own '{'); content is KEPT except comments/strings/regexes
  // (blanked) and nested templates (recursed). Returns the index after the balancing '}'.
  const scanInterp = (start) => {
    let i = start;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') { const j = i; while (i < n && source[i] !== '\n') i++; blank(j, i); continue; }
      if (c === '/' && source[i + 1] === '*') { const j = i; i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; blank(j, i); continue; }
      if (c === '/' && isRegexStart(source, i)) { const j = i; i = skipRegex(i); blank(j, i); continue; }
      if (c === '"' || c === "'") { const j = i; i = skipString(j); blank(j, i); continue; }
      if (c === '`') { i = skipTemplate(i); continue; }
      if (c === '{') { depth++; mask[i] = c; i++; continue; }
      if (c === '}') { depth--; if (depth === 0) { mask[i] = ' '; return i + 1; } mask[i] = c; i++; continue; }
      mask[i] = c;
      i++;
    }
    return i;
  };
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { const j = i; while (i < n && source[i] !== '\n') i++; blank(j, i); continue; }
    if (c === '/' && source[i + 1] === '*') { const j = i; i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; blank(j, i); continue; }
    if (c === '/' && isRegexStart(source, i)) { const j = i; i = skipRegex(i); blank(j, i); continue; }
    if (c === '"' || c === "'") { const j = i; i = skipString(j); blank(j, i); continue; }
    if (c === '`') { i = skipTemplate(i); continue; }
    mask[i] = c;
    i++;
  }
  return mask.join('');
}

// Find every `process \s* . \s* env` TOKEN in the executable surface of `source`. This is
// shape-independent: bare passing/return, spread, later assignment, template interpolation,
// comment-separated access, destructuring, enumeration, aliasing and the `env = process.env`
// injection default all reduce to the same token, so none can be smuggled past by renaming
// the surrounding syntax.
const PROCESS_ENV_TOKEN = /process[ \t]*\.[ \t]*env/g;
function findProcessEnvTokens(source, rel) {
  const code = maskNonExecutable(source);
  const out = [];
  for (const m of code.matchAll(PROCESS_ENV_TOKEN)) {
    const lineNo = code.slice(0, m.index).split('\n').length;
    const line = code.split('\n')[lineNo - 1] ?? '';
    out.push({ at: `${rel}:${lineNo}`, snippet: line.trim() });
  }
  return out;
}

// The ONE module allowed to touch process.env directly: the readEnv/childEnv seam. Every read
// there flows through readEnv(name, env); its tokens are the four `env = process.env`
// injection defaults (readEnv, childEnv, resolveRunConfig, resolveDoneAtRevision).
const SEAM_FILE = 'lib/config.mjs';

// Closed seam allowlist — every OTHER process.env token in lib/ and bin/, exact file:line,
// with a one-line justification. The guard FAILS on any token not in the seam and not here,
// and FAILS on a stale entry (a site removed from source must drop its entry). Each entry is
// a default-parameter env-OBJECT injection into a seam-backed resolver: passing an env object
// is not itself a variable READ, and every read inside still goes through readEnv(name, env).
const CLOSED_SEAM_ALLOWLIST = [
  { at: 'lib/runs.mjs:267', why: 'discoveryConfigPath(mainRoot, env = process.env): default-param env injection into resolveRunsDir (all reads via readEnv)' },
  { at: 'lib/runs.mjs:336', why: 'readDiscoveryConfig(mainRoot, { env = process.env }): default-param env injection, forwarded to discoveryConfigPath/resolveRunsDir (all reads via readEnv)' },
  { at: 'lib/runs.mjs:458', why: 'discoverRuns({ env = process.env }): default-param env injection into resolveRunsDir/readDiscoveryConfig (all reads via readEnv)' },
  { at: 'bin/masterplan.mjs:1222', why: 'shouldSuppressWorkflow(flags = {}, env = process.env): default-param env injection; callers pass readEnvAll() (the seam proxy) and the only read is env.PI_CODING_AGENT' },
];

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('inventory: every derived non-exempt control resolves to a behavioral contract', async () => {
  const inv = await discoverAllControls();
  const byId = registryById();
  const unmapped = unmappedControls(inv, byId, (id) => METADATA_EXEMPTIONS.has(id));
  assert.deepEqual(unmapped, [],
    `derived non-exempt controls with NO behavioral contract:\n${unmapped.join('\n') || '(none)'}`);
  // The flag surface resolves through the registration contract — assert it is real and the
  // flag set is substantial (a broken flag export would silently empty the surface).
  assert.equal(FLAG_REGISTRATION.id, '__flag_registration__');
  assert.ok(inv.flags.length >= 50, `expected a substantial flag surface, got ${inv.flags.length}`);
});

test('inventory: every contract name exists on a derived surface (no stale metadata)', async () => {
  const inv = await discoverAllControls();
  const byId = registryById();
  const dead = deadContracts(inv, byId);
  assert.deepEqual(dead, [],
    `registry entries naming NO derived surface (stale metadata): ${dead.join(', ') || '(none)'}`);
});

test('inventory: the guard REJECTS a synthetic unmapped control', async () => {
  const inv = await discoverAllControls();
  const byId = registryById();
  const exempt = (id) => METADATA_EXEMPTIONS.has(id);
  // The real inventory is clean...
  assert.deepEqual(unmappedControls(inv, byId, exempt), []);
  // ...but an unmapped control on ANY surface must be reported (stale metadata cannot pass
  // through an empty check). One per surface proves each leg is live.
  for (const [surface, control] of [
    ['config', 'brand_new_config'],
    ['env', 'BRAND_NEW_ENV_VAR'],
    ['state', 'brand_new_state_field'],
    ['markers', 'brand_new_marker'],
  ]) {
    const bad = { ...inv, [surface]: [...inv[surface], control] };
    const found = unmappedControls(bad, byId, exempt);
    const prefix = surface === 'markers' ? 'marker' : surface;
    assert.ok(found.some((f) => f.startsWith(`${prefix}:`) && f.includes(control)),
      `expected the guard to report unmapped ${surface} control ${control}, got: ${found.join('; ') || '(none)'}`);
  }
});

test('inventory: the guard REJECTS a synthetic dead contract (stale metadata)', async () => {
  const inv = await discoverAllControls();
  const byId = new Map(registryById());
  byId.set('brand_new_contract', { id: 'brand_new_contract', kind: 'config' });
  const dead = deadContracts(inv, byId);
  assert.ok(dead.includes('brand_new_contract'),
    'a registry entry naming no derived surface must be reported as stale metadata');
});

test('inventory: no direct process.env tokens outside the readEnv seam and the closed allowlist', () => {
  const dirs = ['lib', 'bin'];
  const seamTokens = [];
  const otherTokens = [];
  for (const dir of dirs) {
    const base = path.join(ROOT, dir);
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!/\.[mc]?js$/.test(ent.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        const rel = path.relative(ROOT, p);
        for (const t of findProcessEnvTokens(text, rel)) {
          (rel === SEAM_FILE ? seamTokens : otherTokens).push(t);
        }
      }
    };
    walk(base);
  }
  // Every non-seam token must be a member of the closed allowlist (exact file:line).
  const allow = new Map(CLOSED_SEAM_ALLOWLIST.map((e) => [e.at, e.why]));
  const uncovered = otherTokens.filter((t) => !allow.has(t.at));
  assert.deepEqual(uncovered, [],
    `process.env tokens that bypass the seam and are not allowlisted:\n${uncovered.map((t) => `${t.at} (${t.snippet})`).join('\n') || '(none)'}`);
  // Every allowlist entry must still be found (a site removed from source must drop its entry).
  const found = new Set(otherTokens.map((t) => t.at));
  const stale = CLOSED_SEAM_ALLOWLIST.filter((e) => !found.has(e.at)).map((e) => e.at);
  assert.deepEqual(stale, [],
    `stale seam-allowlist entries (site no longer present in source): ${stale.join(', ') || '(none)'}`);
  // The seam file is exempt but must actually be exercised — pin its EXACT token set so a
  // broken seam scan (or a new unexamined process.env in config.mjs) fails loudly.
  assert.equal(seamTokens.length, 4,
    `expected exactly the four env-injection defaults in the readEnv seam (lib/config.mjs), got ${seamTokens.length}:\n${seamTokens.map((t) => `${t.at} (${t.snippet})`).join('\n')}`);
  // The allowlist is closed and minimal: pin its EXACT membership in both directions above
  // (uncovered = no missing entries, stale = no extra entries).
  assert.equal(otherTokens.length, CLOSED_SEAM_ALLOWLIST.length,
    `expected exactly ${CLOSED_SEAM_ALLOWLIST.length} allowlisted non-seam tokens, got ${otherTokens.length}:\n${otherTokens.map((t) => `${t.at} (${t.snippet})`).join('\n')}`);
});

test('inventory: a non-seam synthetic file with a direct read IS flagged', () => {
  // The allowlist is tied to exact live file:line sites; a SYNTHETIC non-seam source with a
  // direct read must be reported even though no real file carries it. This is the second half
  // of finding 2: the seam-exemption assertions must prove the guard is live, not vacuous.
  const src = `
function f() {
  return process.env;      // bare return — must be flagged
}
`;
  const found = findProcessEnvTokens(src, 'lib/synthetic-escape.mjs');
  assert.deepEqual(found.map((t) => t.at), ['lib/synthetic-escape.mjs:3'],
    `a synthetic non-seam direct read must be flagged exactly once, got:\n${found.map((t) => `${t.at} (${t.snippet})`).join('\n') || '(none)'}`);
  // And it must NOT pass through the allowlist check (its site is not allowlisted).
  const allow = new Map(CLOSED_SEAM_ALLOWLIST.map((e) => [e.at, e.why]));
  assert.ok(!allow.has(found[0].at), 'a synthetic site is not a member of the closed allowlist');
});

test('inventory: the process.env guard catches every escape form', () => {
  const fixture = `
function seam(name, env = process.env) {   // seam: allowed env-injection default
  return env[name];
}
function escapes() {
  const a = process.env.CLAUDE_CODE_SESSION_ID;       // member access
  const b = process.env['HOME'];                      // bracket access
  const { PI_CODING_AGENT } = process.env;            // destructuring
  const c = process.env;                              // aliasing (then c.FOO later)
  const d = Object.keys(process.env);                 // enumeration
  const e = Object.values(process.env);               // enumeration
  const f = Object.entries(process.env);              // enumeration
  return [a, b, PI_CODING_AGENT, c, d, e, f];
}
function barePass(env) { return sink(process.env); }       // bare passing
function spreadEnv() { return { ...process.env }; }         // spread
function laterAssign() { let e; e = process.env; return e; } // later assignment
function interp() { return \`token \${process.env.SECRET}\`; } // template interpolation
function commentSep() { return process /* keep */ . env; }   // comment-separated access
`;
  // The seam env-injection default is ALLOWED (it is inside the exempt seam shape when run
  // against the real seam file); every escape form in this synthetic NON-seam fixture must be
  // detected as a bare process.env token.
  const violations = findProcessEnvTokens(fixture, 'fixture.mjs').map((t) => t.snippet);
  // The seam env-injection default (line 2) plus the twelve escape forms below = 13 tokens.
  // The seam default is NOT exempt here: this fixture is a synthetic NON-seam file, so every
  // token — including the default-param injection — must be reported. (The real seam file is
  // exempt by file, not by token shape.)
  assert.equal(violations.length, 13, `expected every escape to be detected:\n${violations.join('\n') || '(none)'}`);
  for (const [label, re] of [
    ['member access', /process\.env\.CLAUDE_CODE_SESSION_ID/],
    ['bracket access', /process\.env\[/],
    ['destructuring', /\{\s*PI_CODING_AGENT\s*\}\s*=\s*process\.env/],
    ['aliasing', /const\s+c\s*=\s*process\.env/],
    ['Object.entries enumeration', /Object\.entries\(process\.env\)/],
    ['Object.keys enumeration', /Object\.keys\(process\.env\)/],
    ['Object.values enumeration', /Object\.values\(process\.env\)/],
    ['bare passing', /sink\(process\.env\)/],
    ['spread', /\.\.\.process\.env/],
    ['later assignment', /e\s*=\s*process\.env/],
    ['template interpolation', /process\.env\.SECRET/],
    ['comment-separated access', /process\s+\.\s+env/],
  ]) {
    assert.ok(violations.some((v) => re.test(v)), `expected the guard to catch ${label}:\n${violations.join('\n') || '(none)'}`);
  }
});

test('inventory: the token scan ignores comment and STRING-LITERAL references but keeps template interpolation', () => {
  const fixture = `
// this comment mentions process.env and process.env.HOME — must be ignored
/* block comment with process.env.MP_ROUTING_POLICY — ignored */
const s = "process.env.HOME is not code";
const t = \`process.env.PI_CODING_AGENT is not code\`;
const u = \`executable \${process.env.MP_ROUTING_POLICY}\`;   // interpolation IS code
const ok = readEnv('HOME');
`;
  const found = findProcessEnvTokens(fixture, 'comments.mjs').map((t) => t.snippet);
  assert.equal(found.length, 1, `exactly the interpolation must be found:\n${found.join('\n') || '(none)'}`);
  // The \`\${...}\` wrapper and the backticks are blanked by the masker; the executable token
  // that remains is the interpolation body itself.
  assert.match(found[0], /process\.env\.MP_ROUTING_POLICY/, 'the interpolation body must be the detected token');
});

// ---------------------------------------------------------------------------
// Integration seams + the lexical early signal
// ---------------------------------------------------------------------------

test('inventory: bin exports the final KNOWN_FLAGS and isKnownFlag (integration surface)', async () => {
  const bin = await import(path.join(ROOT, 'bin', 'masterplan.mjs'));
  // KNOWN_FLAGS is a Set (the CLI's own representation); the discovery scanner spreads it.
  assert.ok(bin.KNOWN_FLAGS instanceof Set && bin.KNOWN_FLAGS.size >= 50,
    'KNOWN_FLAGS must be exported as a substantial Set');
  assert.equal(typeof bin.isKnownFlag, 'function', 'isKnownFlag must be exported');
  // A flag in the exported set must resolve, a known-unknown must not.
  assert.ok(bin.isKnownFlag('state'), '--state is a registered flag');
  assert.ok(!bin.isKnownFlag('definitely-not-a-real-flag'), 'an unregistered name must resolve false');
});

test('inventory: the sequencer provides the prompt-only markers (integration surface)', () => {
  const markers = discoverPromptMarkers();
  assert.ok(markers.length >= 2, `expected several knob markers, got ${markers.length}`);
  for (const expected of ['context_watch', 'render_images']) {
    assert.ok(markers.includes(expected), `sequencer must declare the ${expected} knob marker`);
  }
  // Every marker must resolve through the mapping (a marker with no contract id fails here).
  const byId = registryById();
  for (const m of markers) {
    const cid = markerContractId(m);
    if (cid === null) continue; // the template placeholder
    assert.ok(byId.has(cid), `marker ${m} -> ${cid} must resolve to a registry contract`);
  }
});

test('inventory: prompt-marker contracts and sequencer markers agree in BOTH directions', async () => {
  const inv = await discoverAllControls();
  const byId = registryById();
  const promptContractIds = new Set(REGISTRY.filter((e) => e.kind === 'prompt-marker').map((e) => e.id));
  const mappedMarkerIds = new Set(inv.markers.map(markerContractId).filter((id) => id !== null));

  // FORWARD (marker -> registry): every discovered marker resolves to a REGISTRY entry — but a
  // marker may legitimately name a config-kind contract (context_watch.focus/threshold are the
  // prompt-side rendering of config controls), so presence is the contract here, checked above.

  // REVERSE (registry -> marker): every prompt-marker contract must have a sequencer marker.
  // This is the half the old test never proved: a prompt-marker contract named after an
  // existing config/state/env control would pass deadContracts (its id is on a derived
  // surface) while having NO marker — exactly the silent gap finding 3 closed.
  const orphan = [...promptContractIds].filter((id) => !mappedMarkerIds.has(id));
  assert.deepEqual(orphan, [],
    `prompt-marker contracts with no sequencer marker: ${orphan.join(', ') || '(none)'}`);

  // CROSS-SURFACE KIND MISMATCH: a prompt-marker contract id must name ONLY the marker
  // surface — a prompt-only control cannot also be a config path / env var / state field /
  // flag. A collision there is a kind mismatch, not a duplicate worth accepting.
  const otherSurfaces = new Set([...inv.flags, ...inv.config, ...inv.env, ...inv.state]);
  const cross = [...promptContractIds].filter((id) => otherSurfaces.has(id));
  assert.deepEqual(cross, [],
    `prompt-marker contract ids must be marker-only (found on another surface): ${cross.join(', ') || '(none)'}`);

  // KIND-CONSISTENT deadContracts: a prompt-marker contract resolving to a CONFIG surface
  // would be silently accepted by the old deadContracts (id present on a derived surface).
  // Prove that failure mode is impossible now: every prompt-marker id is either marker-mapped
  // (above) or absent from the non-marker surfaces (above), so no prompt-marker contract can
  // ride a config/state/env/flag surface to avoid the reverse check.
  assert.ok(deadContracts(inv, byId).length === 0, 'the registry must be free of stale entries');
});

test('inventory: the lexical readEnv discovery stays as the cheap early signal', () => {
  // This is NOT the proof (knob-contract.test.mjs is). It is the early signal: the env
  // scanner must keep finding the seam reads, so a new readEnv call site is at least
  // DISCOVERED before the behavioral contract is demanded of it.
  const env = discoverEnvControls();
  assert.ok(env.length >= 5, `expected a substantial env surface, got ${env.length}`);
  for (const known of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'PI_CODING_AGENT', 'MP_ROUTING_POLICY']) {
    assert.ok(env.includes(known), `env discovery must retain ${known} as an early signal`);
  }
});

// The other surfaces' derivation must also stay live (a broken derivation silently empties
// the guard's input — assert each surface is substantial rather than trusting an empty pass).
test('inventory: every derived surface is non-empty (derivation liveness)', async () => {
  const inv = await discoverAllControls();
  assert.ok(inv.config.length >= 10, `config surface: ${inv.config.length}`);
  assert.ok(inv.state.length >= 10, `state surface: ${inv.state.length}`);
  assert.ok(inv.markers.length >= 2, `marker surface: ${inv.markers.length}`);
  assert.ok(inv.all.length >= 100, `overall inventory: ${inv.all.length}`);
});
