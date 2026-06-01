// test/publish-hygiene.test.mjs — release-hygiene + publish-safety guards (build step 6).
//
// Drives the pure detectors in lib/hygiene.mjs. This is the LIVE CI gate for the three concerns
// lib/doctor/README.md:63-66 routes to "CI / pre-commit, since end users don't have the repo":
//   (1) fixture-identifier leak  — the headline CUTOVER guard: keep test/fixtures/ sanitized.
//   (2) cross-manifest version sync — every tracked manifest agrees with README's Current release.
//   (3) namespace collision — no skills/ dir shadows a built-in or is unwired from the verb router.
//
// Each guard carries the FAIL-capable triad (advisor): (a) planted bad input IS flagged, (b) the
// allowed/synthetic set is NOT flagged, (c) the live tree sweeps clean. A guard whose detector regex
// silently broke would pass (a)-less — so (a) is the load-bearing assertion, not (c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  scanForRealIdentifiers,
  readReleaseVersion,
  findVersionDrift,
  parseReservedVerbs,
  findNamespaceCollisions,
} from '../lib/hygiene.mjs';

const repoURL = (rel) => new URL('../' + rel, import.meta.url);
const repoPath = (rel) => fileURLToPath(repoURL(rel));
const readRepo = (rel) => readFileSync(repoURL(rel), 'utf8');

function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

// ============================================================================
// Guard 1 — fixture-identifier leak scan
// ============================================================================

// (a) Planted leaks — one per deny rule. Strings live HERE, never under test/fixtures/, so the live
// sweep (which scopes to test/fixtures/) does not flag this file's own test data.
const LEAKS = [
  { label: 'absolute srv path', text: 'worktree: /srv/dev/masterplan/x', token: 'srv-path' },
  { label: 'real (non-user) home', text: 'path: /home/alice/.codex/auth.json', token: 'home-path' },
  { label: 'owner org', text: 'project: petabit-portal sync', token: 'petabit-org' },
  { label: 'codename', text: 'the coherent rollout phase', token: 'coherent-codename' },
  { label: 'product code FTCD', text: 'ticket FTCD-1009 closed', token: 'ftcd-code' },
  { label: 'product code XCVR', text: 'swap part XCVR-2200 in rack', token: 'xcvr-code' },
  { label: 'codename wbn', text: 'slug: wbn datasheet redesign', token: 'wbn-codename' },
];

for (const leak of LEAKS) {
  test(`fixture-scan FLAGS ${leak.label}`, () => {
    const hits = scanForRealIdentifiers(leak.text);
    assert.ok(
      hits.some((h) => h.token === leak.token),
      `expected token "${leak.token}", got ${JSON.stringify(hits)}`
    );
  });
}

// (b) Allowed / synthetic identifiers must never be flagged.
const ALLOWED = [
  'marketplace: rasatpetabit-masterplan', // \b can't fire inside rasatpetabit -> no petabit-org hit
  'home: /home/user/.codex/auth.json', // the synthetic home convention
  'plugin: masterplan v8 clean-core', // ordinary product name, no deny token
  `plan_hash: ${'d'.repeat(64)}`, // bare 64-hex content digest — never matched (no raw-hex rule)
  `index_sha: sha256:${'0'.repeat(64)}`, // synthetic full-hash convention
  'tasks:\n- id: 1\n  status: done\n  wave: 0\n', // ordinary flat-state yaml
];

test('fixture-scan does NOT flag allowed / synthetic identifiers', () => {
  for (const ok of ALLOWED) {
    assert.deepEqual(scanForRealIdentifiers(ok), [], `unexpected hit for: ${ok}`);
  }
});

// (c) Live sweep — every file under test/fixtures/ must be clean.
test('LIVE: no real-identifier leak in any test/fixtures/ file content', () => {
  const root = repoPath('test/fixtures');
  const files = walkFiles(root);
  assert.ok(files.length > 0, 'expected test/fixtures/ to contain files');
  const leaks = [];
  for (const f of files) {
    const hits = scanForRealIdentifiers(readFileSync(f, 'utf8'));
    if (hits.length) leaks.push({ file: f.replace(`${root}/`, ''), hits });
  }
  assert.deepEqual(leaks, [], `real-identifier leaks in fixtures:\n${JSON.stringify(leaks, null, 2)}`);
});

// ============================================================================
// Guard 2 — cross-manifest version sync (README is the single source of truth)
// ============================================================================

test('version: readReleaseVersion parses the README marker; null when absent', () => {
  assert.equal(readReleaseVersion('Current release: **v7.2.3** · MIT'), '7.2.3');
  assert.equal(readReleaseVersion('no release marker here'), null);
});

test('version: findVersionDrift flags a disagreeing manifest entry', () => {
  const drift = findVersionDrift('7.2.3', [
    { file: 'a', field: 'version', version: '7.2.3' },
    { file: 'b', field: 'version', version: '0.9.0' },
  ]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].file, 'b');
});

test('version: findVersionDrift returns [] when all entries agree', () => {
  assert.deepEqual(
    findVersionDrift('7.2.3', [{ file: 'a', field: 'version', version: '7.2.3' }]),
    []
  );
});

test('LIVE: every tracked manifest version field agrees with README Current release', () => {
  const release = readReleaseVersion(readRepo('README.md'));
  assert.ok(/^\d+\.\d+\.\d+$/.test(release ?? ''), `README release version parsed: ${release}`);
  const mkt = JSON.parse(readRepo('.claude-plugin/marketplace.json'));
  const claudePlugin = JSON.parse(readRepo('.claude-plugin/plugin.json'));
  const codexPlugin = JSON.parse(readRepo('.codex-plugin/plugin.json'));
  // package.json is now INCLUDED — the v8.0.0 release retires the dev marker, so it must agree too.
  const pkg = JSON.parse(readRepo('package.json'));
  const entries = [
    { file: 'package.json', field: 'version', version: pkg.version },
    { file: '.claude-plugin/marketplace.json', field: 'version', version: mkt.version },
    { file: '.claude-plugin/marketplace.json', field: 'plugins[0].version', version: mkt.plugins?.[0]?.version },
    { file: '.claude-plugin/plugin.json', field: 'version', version: claudePlugin.version },
    { file: '.codex-plugin/plugin.json', field: 'version', version: codexPlugin.version },
  ];
  const drift = findVersionDrift(release, entries);
  assert.deepEqual(drift, [], `manifest version drift vs README ${release}:\n${JSON.stringify(drift, null, 2)}`);
});

// ============================================================================
// Guard 3 — namespace collision (skill dirs vs reserved verbs + built-ins)
// ============================================================================

const RESERVED_VERBS = parseReservedVerbs(readRepo('commands/masterplan.md'));

// Positive anchor: a silently-broken parser would return [] and make every namespace check pass
// vacuously (or, for the live check, over-flag) — assert the exact canonical list it must extract.
test('namespace: parseReservedVerbs extracts the canonical verb list from the orchestrator prompt', () => {
  assert.deepEqual(RESERVED_VERBS, [
    'full', 'brainstorm', 'plan', 'execute', 'finish', 'retro', 'import',
    'doctor', 'status', 'validate', 'stats', 'clean', 'next', 'verbs',
    'publish', 'follow',
  ]);
});

test('namespace FLAGS plan/status/doctor skill dirs as built-in shadows (v7.2.2 plan regression + v8 status/doctor cleanup)', () => {
  // Each is a reserved VERB yet must never be a top-level skill dir — they shadow CC's
  // `/plan` (plan mode), `/status`, and `/doctor`. The verbs stay reachable via `/masterplan <verb>`.
  assert.deepEqual(findNamespaceCollisions(['plan', 'status', 'doctor'], RESERVED_VERBS), [
    { name: 'plan', kind: 'shadows-builtin' },
    { name: 'status', kind: 'shadows-builtin' },
    { name: 'doctor', kind: 'shadows-builtin' },
  ]);
});

test('namespace FLAGS an unwired (non-infra) skill dir', () => {
  assert.deepEqual(findNamespaceCollisions(['foobar'], RESERVED_VERBS), [
    { name: 'foobar', kind: 'unwired-verb' },
  ]);
});

test('namespace: v8 allows ONLY infra dirs — any verb-named skill dir is flagged (verbs route through bin, not skills)', () => {
  // infra dirs sweep clean...
  assert.deepEqual(findNamespaceCollisions(['masterplan', 'masterplan-detect'], RESERVED_VERBS), []);
  // ...but a verb-named delegator is no longer legitimate (the v8 per-verb-skill removal) — flagged
  // so the `/masterplan:<verb>` namespace can't creep back in.
  assert.deepEqual(findNamespaceCollisions(['brainstorm', 'clean', 'verbs'], RESERVED_VERBS), [
    { name: 'brainstorm', kind: 'unwired-verb' },
    { name: 'clean', kind: 'unwired-verb' },
    { name: 'verbs', kind: 'unwired-verb' },
  ]);
});

test('LIVE: no skills/ dir shadows a built-in or is unwired from the verb router', () => {
  const dirs = readdirSync(repoPath('skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(dirs.length > 0, 'expected skills/ to contain dirs');
  const problems = findNamespaceCollisions(dirs, RESERVED_VERBS);
  assert.deepEqual(problems, [], `namespace problems in skills/:\n${JSON.stringify(problems, null, 2)}`);
});
