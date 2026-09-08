// test/schema-snapshot-identity.test.mjs — task 52: the §5.5 snapshot/identity MECHANICS.
//
// The real module behind the task-58 seam (lib/schema-snapshot.mjs): the skill identity as
// a digest over the CLOSED manifest-declared file set (byte-identical to the reference
// algorithm in test/design-intent-host-contract.test.mjs and to the pinned skill's own
// recomputation), the five named guard failures each raising with the name prefix, the
// format-version validation, the §5.5 snapshot copy on approved capture (the exact bytes
// land beside state.yml and hash to the recorded schema_sha256), the frozen-bundle read
// (the snapshot is preferred over — and used INSTEAD OF — the live skill file), and the
// identity-equality guard at every later operation.
//
// Fixture skill trees land under os.tmpdir() (the mkbundle style of
// test/interview-cli-surface.test.mjs) and are removed once at teardown.

import { test as rawTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  buildSeedState,
  writeState,
  readState,
  appendEvent,
} from '../lib/bundle.mjs';
import {
  captureSchema,
  amendSkillIdentity,
  assertSkillIdentity,
  readSchemaSnapshot,
  replaySchemaCapture,
  registerSchemaSnapshotModule,
  SCHEMA_SNAPSHOT_FILENAME,
} from '../lib/interview.mjs';
import {
  captureSchemaSnapshot,
  computeSkillIdentity,
} from '../lib/schema-snapshot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin/masterplan.mjs');
const PIN_PATH = path.join(ROOT, 'policy', 'design-intent-skill.json');
const pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
// HOST-LOCAL PIN EVIDENCE: the pin's repo is an absolute host path. On a machine without it
// (the CI runner), the pinned bytes cannot be read — this whole suite is pinned-skill
// identity evidence, so it SKIPS (never fails): CI is the product-surface contract, not the
// pin-provenance witness. The pin verification runs on the dev host and in the rehearsal.
const PINNED_REPO_AVAILABLE = fs.existsSync(path.join(pin.repo, '.git')); // a bare existing dir is not a repo (the CI path is absent; an empty mount is not a checkout)
const test = PINNED_REPO_AVAILABLE ? rawTest : Object.assign(
  // The skip alias keeps the harness surface: every registration becomes a skipped test,
  // and the lifecycle hooks no-op (nothing was registered, nothing to clean up).
  (name, opts, fn) => rawTest.skip(name, typeof opts === 'function' ? opts : fn),
  { after: () => {}, before: () => {}, beforeEach: () => {}, afterEach: () => {} },
);

const TMPDIRS = [];
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A complete, closed fixture skill: manifest + the core files + a declared asset, all
// present in the tree. `patch.manifest` / `patch.files` / `patch.omit` shape the fixture
// for each failure path.
function mkskill(patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-snap-'));
  TMPDIRS.push(dir);
  const skillRoot = path.join(dir, 'skill');
  const manifest = {
    manifest_version: 1,
    skill: 'fixture-intent',
    host_contract_version: 1,
    schema_format_version: 1,
    identity: {
      algorithm: 'sha256',
      closed_file_set: ['SKILL.md', 'manifest.json', 'reference.md', 'schema.json'],
    },
    assets: { 'reference.md': 'Worked example the skill was written against' },
    ...(patch.manifest || {}),
  };
  const files = {
    'SKILL.md': '# fixture design-intent\n',
    'schema.json': `{"version": 1, "core": ["Purpose"]}\n`,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'reference.md': 'worked example\n',
    ...(patch.files || {}),
  };
  for (const [rel, content] of Object.entries(files)) {
    if ((patch.omit || []).includes(rel)) continue;
    const dest = path.join(skillRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return { dir, skillRoot, manifest };
}

function mkbundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-snap-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  writeState(
    statePath,
    buildSeedState({ slug: 'iv', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' })
  );
  return { dir, statePath };
}

// The REFERENCE identity algorithm, verbatim from test/design-intent-host-contract.test.mjs
// (computeSkillIdentity there): the pinned normative recomputation this module must be
// byte-identical to. Entries sorted in ascending byte order of the manifest-relative POSIX
// path; each entry contributes path + \n + lowercase-hex sha256 of exact bytes + \n.
function referenceSkillIdentity(manifest, readBytes) {
  const set = manifest.identity.closed_file_set;
  assert.ok(Array.isArray(set) && set.length > 0, 'closed_file_set must be a non-empty array');
  const seen = new Set();
  const h = crypto.createHash('sha256');
  for (const rel of [...set].sort()) {
    assert.ok(!seen.has(rel), `duplicate closed_file_set entry: ${rel}`);
    seen.add(rel);
    assert.ok(!path.isAbsolute(rel) && !rel.split('/').includes('..'), `path escapes the skill root: ${rel}`);
    const bytes = readBytes(rel);
    h.update(rel, 'utf8');
    h.update('\n', 'utf8');
    h.update(crypto.createHash('sha256').update(bytes).digest('hex'), 'utf8');
    h.update('\n', 'utf8');
  }
  return h.digest('hex');
}

const fail = (e, name) => {
  assert.ok(
    e instanceof Error && e.message.startsWith(`${name}:`),
    `${name} must raise with the name as the message prefix (got: ${e && e.message})`
  );
};

// Extract the pinned commit's closed file set into a temp tree (the technique the
// host-contract suite uses for the validator): the REAL skill's REAL bytes, so the module
// proves byte-identity against the pin, not against a fixture.
function extractPinnedSkill() {
  const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args]);
  const tracked = git(pin.repo, 'ls-tree', '-r', '--name-only', pin.commit, '--', pin.skill_path)
    .toString().trim().split('\n').filter(Boolean);
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-pin-'));
  TMPDIRS.push(tree);
  for (const f of tracked) {
    const rel = f.slice(pin.skill_path.length + 1);
    const dest = path.join(tree, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, git(pin.repo, 'show', `${pin.commit}:${f}`));
  }
  return tree;
}

test.after(() => {
  registerSchemaSnapshotModule(null); // never leak the real module into another suite's seam
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ---- the identity algorithm is byte-identical to the reference ------------------

test('computeSkillIdentity is byte-identical to the reference algorithm over a fixture', () => {
  const { skillRoot, manifest } = mkskill();
  const mine = computeSkillIdentity({ skillRoot });
  const ref = referenceSkillIdentity(manifest, (rel) => fs.readFileSync(path.join(skillRoot, rel)));
  assert.equal(mine, ref);
  assert.match(mine, /^[0-9a-f]{64}$/);
});

test('computeSkillIdentity is byte-identical to the PINNED skill: matches the recorded pin digest', () => {
  // Prove the module recomputes the pin's manifest_digest over the real skill's real bytes.
  const tree = extractPinnedSkill();
  assert.equal(computeSkillIdentity({ skillRoot: tree }), pin.manifest_digest);
});

test('filesystem enumeration order cannot change the identity (sorted by manifest-relative path)', () => {
  // Two trees with identical content written in DIFFERENT creation orders produce the same
  // identity — the sort is over the declared set, not the directory listing.
  const a = mkskill();
  const b = mkskill();
  fs.rmSync(b.skillRoot, { recursive: true, force: true });
  const files = {
    'SKILL.md': '# fixture design-intent\n',
    'schema.json': '{"version": 1, "core": ["Purpose"]}\n',
    'manifest.json': `${JSON.stringify(a.manifest, null, 2)}\n`,
    'reference.md': 'worked example\n',
  };
  for (const rel of Object.keys(files).reverse()) {
    fs.mkdirSync(path.join(b.skillRoot, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(b.skillRoot, rel), files[rel]);
  }
  assert.equal(computeSkillIdentity({ skillRoot: a.skillRoot }), computeSkillIdentity({ skillRoot: b.skillRoot }));
});

test('an ordinary edit that changes no version still changes the identity (the digest IS the identity)', () => {
  const { skillRoot } = mkskill();
  const before = computeSkillIdentity({ skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n'); // no version bump
  const after = computeSkillIdentity({ skillRoot });
  assert.notEqual(before, after);
});

test('key reordering inside manifest.json changes the identity (exact bytes, not cosmetic equivalence)', () => {
  const { skillRoot, manifest } = mkskill();
  const before = computeSkillIdentity({ skillRoot });
  const reordered = {};
  for (const k of Object.keys(manifest).reverse()) reordered[k] = manifest[k];
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(reordered, null, 2)}\n`);
  assert.notEqual(computeSkillIdentity({ skillRoot }), before);
});

// ---- the closed set: completeness, escapes, missing files -----------------------

test('a declared file missing from the tree fails closed (undeclared_dependency)', () => {
  const { skillRoot } = mkskill({ omit: ['reference.md'] });
  assert.throws(() => computeSkillIdentity({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
  assert.throws(() => captureSchemaSnapshot({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
});

test('a missing schema.json fails closed as a closed-set file (undeclared_dependency)', () => {
  const { skillRoot } = mkskill({ omit: ['schema.json'] });
  assert.throws(() => captureSchemaSnapshot({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
});

test('path escapes refuse: traversal, absolute and Windows-style entries (undeclared_dependency)', () => {
  for (const bad of ['../outside.txt', '/etc/passwd', 'C:\\windows\\system32', 'a/../../escape']) {
    const { skillRoot } = mkskill({ manifest: { identity: { closed_file_set: ['SKILL.md', 'schema.json', 'manifest.json', bad] } } });
    assert.throws(
      () => computeSkillIdentity({ skillRoot }),
      (e) => { fail(e, 'undeclared_dependency'); return true; },
      `entry ${bad} must be refused`
    );
  }
});

test('duplicate closed_file_set entries refuse (undeclared_dependency)', () => {
  const { skillRoot } = mkskill({ manifest: { identity: { closed_file_set: ['SKILL.md', 'SKILL.md', 'manifest.json', 'schema.json'] } } });
  assert.throws(() => computeSkillIdentity({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
});

test('a closed set omitting a file the skill always loads refuses (undeclared_dependency)', () => {
  for (const required of ['SKILL.md', 'schema.json', 'manifest.json']) {
    const set = ['SKILL.md', 'manifest.json', 'schema.json'].filter((x) => x !== required);
    const { skillRoot } = mkskill({ manifest: { identity: { closed_file_set: set } } });
    assert.throws(
      () => computeSkillIdentity({ skillRoot }),
      (e) => { fail(e, 'undeclared_dependency'); return true; },
      `a closed set without ${required} is not closed`
    );
  }
});

test('a manifest asset missing from the closed set refuses (undeclared_dependency)', () => {
  // The manifest declares reference.md as an asset but the closed set omits it: the digest
  // would cover a chosen subset, not the implementation.
  const { skillRoot } = mkskill({ manifest: { identity: { closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] } } });
  assert.throws(() => computeSkillIdentity({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
});

test('a symlink closed-set entry refuses: a link escaping the root is a path escape (undeclared_dependency)', () => {
  const { dir, skillRoot } = mkskill();
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'bytes from outside the skill root\n');
  fs.rmSync(path.join(skillRoot, 'reference.md'));
  fs.symlinkSync(outside, path.join(skillRoot, 'reference.md'));
  assert.throws(() => computeSkillIdentity({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
});

test('a manifest with no closed_file_set cannot close the set (undeclared_dependency)', () => {
  const { skillRoot } = mkskill({ manifest: { identity: { algorithm: 'sha256' } } });
  assert.throws(() => computeSkillIdentity({ skillRoot }), (e) => { fail(e, 'undeclared_dependency'); return true; });
});

// ---- the five named failures, each raising with the name prefix ----------------

test('skill_absent: missing root, missing manifest, unreadable manifest, missing SKILL.md', () => {
  const { skillRoot } = mkskill();
  assert.throws(() => computeSkillIdentity({ skillRoot: '/nonexistent-skill-root' }), (e) => { fail(e, 'skill_absent'); return true; });
  const { skillRoot: noManifest } = mkskill({ omit: ['manifest.json'] });
  assert.throws(() => computeSkillIdentity({ skillRoot: noManifest }), (e) => { fail(e, 'skill_absent'); return true; });
  const { skillRoot: badManifest } = mkskill({ files: { 'manifest.json': '{not json' } });
  assert.throws(() => captureSchemaSnapshot({ skillRoot: badManifest }), (e) => { fail(e, 'skill_absent'); return true; });
  const { skillRoot: noSkillMd } = mkskill({ omit: ['SKILL.md'] });
  assert.throws(() => computeSkillIdentity({ skillRoot: noSkillMd }), (e) => { fail(e, 'skill_absent'); return true; });
});

test('host_contract_unsupported: a version this host does not support refuses, no silent downgrade', () => {
  for (const bad of [99, '1', null, 0]) {
    const { skillRoot } = mkskill({ manifest: { host_contract_version: bad } });
    assert.throws(
      () => captureSchemaSnapshot({ skillRoot }),
      (e) => { fail(e, 'host_contract_unsupported'); return true; },
      `host_contract_version ${JSON.stringify(bad)} must refuse`
    );
  }
  // The supported set is behavioral: the pinned real skill (version 1) is accepted.
  const pinned = extractPinnedSkill();
  assert.doesNotThrow(() => captureSchemaSnapshot({ skillRoot: pinned }));
});

test('schema_unsupported: an unsupported manifest-declared format version refuses', () => {
  const { skillRoot } = mkskill({
    manifest: { schema_format_version: 99 },
    files: { 'schema.json': '{"version": 99}\n' },
  });
  assert.throws(() => captureSchemaSnapshot({ skillRoot }), (e) => { fail(e, 'schema_unsupported'); return true; });
});

test('schema_unsupported: a schema version mismatched against the manifest declaration refuses', () => {
  // The manifest declares 1; the schema's own version says 2 — a mismatched schema fails
  // closed, never leniently read.
  const { skillRoot } = mkskill({ files: { 'schema.json': '{"version": 2}\n' } });
  assert.throws(() => captureSchemaSnapshot({ skillRoot }), (e) => { fail(e, 'schema_unsupported'); return true; });
});

test('schema_unsupported: a malformed schema refuses', () => {
  const { skillRoot } = mkskill({ files: { 'schema.json': '{not json' } });
  assert.throws(() => captureSchemaSnapshot({ skillRoot }), (e) => { fail(e, 'schema_unsupported'); return true; });
});

test('undeclared_dependency: the named failure for closed-set violations (covered above) is on SKILL_GUARD_FAILURES', async () => {
  const { SKILL_GUARD_FAILURES } = await import('../lib/interview.mjs');
  assert.deepEqual(SKILL_GUARD_FAILURES, [
    'skill_absent',
    'skill_identity_changed',
    'host_contract_unsupported',
    'schema_unsupported',
    'undeclared_dependency',
  ]);
});

test('skill_identity_changed: the later-operation guard raises it when the skill changed', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  // The guard passes on the unchanged skill (identity equality at a later operation)...
  const ok = assertSkillIdentity({ statePath, skillRoot });
  assert.equal(ok.ok, true);
  assert.equal(ok.skill_identity, replaySchemaCapture(statePath).recorded_skill_identity);
  // ...and stops with the named failure after a routine update that changes no version.
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  assert.throws(() => assertSkillIdentity({ statePath, skillRoot }), (e) => { fail(e, 'skill_identity_changed'); return true; });
});

test('the guard propagates the module’s other named failures verbatim', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  // A changed skill that ALSO declares an unsupported host contract reports the module's
  // named failure, not skill_identity_changed.
  const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, 'manifest.json'), 'utf8'));
  manifest.host_contract_version = 99;
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => assertSkillIdentity({ statePath, skillRoot }), (e) => { fail(e, 'host_contract_unsupported'); return true; });
  // And a deleted skill root reports skill_absent.
  fs.rmSync(skillRoot, { recursive: true, force: true });
  assert.throws(() => assertSkillIdentity({ statePath, skillRoot }), (e) => { fail(e, 'skill_absent'); return true; });
});

test('the guard requires the module and the skill root, and refuses a bundle with no capture', () => {
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  assert.throws(() => assertSkillIdentity({ statePath, skillRoot }), /no schema_captured event/);
  const captured = mkbundle();
  captureSchema({ statePath: captured.statePath, skillRoot });
  assert.throws(() => assertSkillIdentity({ statePath: captured.statePath }), /skillRoot is required/);
});

// ---- captureSchemaSnapshot: shape and validation --------------------------------

test('captureSchemaSnapshot returns the pinned four fields over a valid skill', () => {
  const { skillRoot } = mkskill();
  const snap = captureSchemaSnapshot({ skillRoot });
  assert.deepEqual(Object.keys(snap).sort(), ['host_contract_version', 'schema_format_version', 'schema_sha256', 'skill_identity']);
  assert.equal(snap.schema_sha256, sha256Hex(fs.readFileSync(path.join(skillRoot, 'schema.json'))));
  assert.equal(snap.skill_identity, computeSkillIdentity({ skillRoot }));
  assert.equal(snap.host_contract_version, 1);
  assert.equal(snap.schema_format_version, 1);
});

test('the module exports EXACTLY the two ops the seam pins (SCHEMA_SNAPSHOT_MODULE_OPS)', async () => {
  const { SCHEMA_SNAPSHOT_MODULE_OPS } = await import('../lib/interview.mjs');
  const mod = await import('../lib/schema-snapshot.mjs');
  assert.deepEqual(Object.keys(mod).sort(), [...SCHEMA_SNAPSHOT_MODULE_OPS].sort());
});

// ---- snapshot copy on approved capture (verb level, REAL module) -----------------

test('captureSchema copies the exact schema bytes into the bundle and records their digest', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  const ev = captureSchema({ statePath, skillRoot });
  const snapshotPath = path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME);
  const copied = fs.readFileSync(snapshotPath);
  const live = fs.readFileSync(path.join(skillRoot, 'schema.json'));
  assert.deepEqual(copied, live, 'the snapshot must be the EXACT bytes');
  assert.equal(sha256Hex(copied), ev.schema_sha256, 'the copied bytes hash to the recorded digest');
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.captured.schema_sha256, ev.schema_sha256);
  assert.equal(ledger.recorded_skill_identity, ev.skill_identity);
});

test('a snapshot whose bytes do not hash to the module’s digest fails closed: no event, no file', () => {
  // A stub module reporting a WRONG digest exercises the copy’s fail-closed verification.
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  registerSchemaSnapshotModule({
    captureSchemaSnapshot: ({ skillRoot: sr }) => ({
      ...captureSchemaSnapshot({ skillRoot: sr }),
      schema_sha256: sha256Hex(Buffer.from('not the real schema bytes')),
    }),
    computeSkillIdentity,
  });
  assert.throws(() => captureSchema({ statePath, skillRoot }), /schema_snapshot_mismatch/);
  assert.equal(replaySchemaCapture(statePath).captured, null, 'a refusal is not a partial write');
  assert.equal(fs.existsSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME)), false);
});

test('capture refuses on a terminal interview before any snapshot write', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  appendEvent(statePath, { type: 'interview_waived', reason: 'waived for test' });
  assert.throws(() => captureSchema({ statePath, skillRoot }), /interview is waived/);
  assert.equal(fs.existsSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME)), false);
});

// ---- the frozen-bundle read: the snapshot, never the live file -------------------

test('readSchemaSnapshot resolves the bundle snapshot, never the live skill file', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  // The live skill file changes (and even DISAPPEARS): the read still resolves the
  // snapshot bytes — there is no fallback to a live schema (§5.5).
  fs.rmSync(path.join(skillRoot, 'schema.json'));
  const snap = readSchemaSnapshot({ statePath });
  assert.deepEqual(snap.bytes, fs.readFileSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME)));
  assert.equal(snap.schema_sha256, replaySchemaCapture(statePath).captured.schema_sha256);
  assert.equal(snap.format_pin, 'schema_backed');
  assert.deepEqual(snap.schema.version, 1);
  assert.equal(snap.skill_identity, replaySchemaCapture(statePath).recorded_skill_identity);
});

test('a FROZEN bundle (archived) reads its snapshot', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  // Freeze: archived state, the whole live skill gone.
  writeState(statePath, { ...readState(statePath), status: 'archived' });
  fs.rmSync(skillRoot, { recursive: true, force: true });
  const snap = readSchemaSnapshot({ statePath });
  assert.equal(snap.schema_sha256, replaySchemaCapture(statePath).captured.schema_sha256);
  assert.equal(snap.schema.version, 1);
});

test('a missing snapshot file fails closed, never falls back to the live file', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.rmSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME));
  // The live file still exists and is a tempting fallback: it must not be used.
  assert.throws(() => readSchemaSnapshot({ statePath }), /schema_snapshot_missing/);
});

test('a tampered snapshot fails closed on the digest mismatch', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.writeFileSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME), '{"version": 1, "tampered": true}\n');
  assert.throws(() => readSchemaSnapshot({ statePath }), /schema_snapshot_mismatch/);
});

test('a bundle with no capture has no snapshot to read', () => {
  const { statePath } = mkbundle();
  assert.throws(() => readSchemaSnapshot({ statePath }), /no schema_captured event/);
});

// ---- amend-skill-identity: the real recompute -------------------------------------

test('the declaration recomputes from the changed skill through the REAL module', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  const captured = captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = computeSkillIdentity({ skillRoot });
  assert.notEqual(changedIdentity, captured.skill_identity);
  // An asserted identity that does not recompute is refused (identity is computed, never
  // asserted) — with the REAL module behind the seam.
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: 'an-asserted-identity', skillRoot }),
    /does not equal the recomputed identity/
  );
  // The real flow: declare (recompute) -> pending, then approve -> committed. The approval
  // binds the recomputed identity; the old identity's receipts are invalidated.
  const approval = {
    attested_by: 'user',
    purpose: 'skill_identity_amend',
    skill_identity: changedIdentity,
    question: 'approve the replacement skill identity?',
    answer: 'approved',
    ts: '2026-01-02T00:00:00.000Z',
  };
  assert.throws(() => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot }), /amendment_pending/);
  const ev = amendSkillIdentity({ statePath, approval });
  assert.equal(ev.type, 'skill_identity_amended');
  assert.equal(ev.old_skill_identity, captured.skill_identity);
  assert.equal(ev.new_skill_identity, changedIdentity);
  assert.equal(replaySchemaCapture(statePath).recorded_skill_identity, changedIdentity);
  // After the amendment the guard passes again: the exemption was used exactly once.
  assert.equal(assertSkillIdentity({ statePath, skillRoot }).ok, true);
});

test('the changed skill’s guard failure surfaces through the amendment declare path', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  // A changed skill that ALSO breaks the closed set: the declare path recomputes through
  // the real module and reports the module's named failure, never adopts a broken identity.
  fs.rmSync(path.join(skillRoot, 'reference.md'));
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: 'x'.repeat(64), skillRoot }),
    (e) => { fail(e, 'undeclared_dependency'); return true; }
  );
  assert.equal(replaySchemaCapture(statePath).pending_amendment, null, 'nothing was declared');
});

// ---- CLI acceptance through the REAL module (the wiring task 52 owns) -------------

test('black-box CLI: capture-schema through the real module writes the snapshot end to end', () => {
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  const r = runCli(['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(r.status, 0, `capture failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.event_type, 'schema_captured');
  assert.equal(out.format_pin, 'schema_backed');
  assert.equal(out.schema_sha256, sha256Hex(fs.readFileSync(path.join(skillRoot, 'schema.json'))));
  assert.equal(out.skill_identity, computeSkillIdentity({ skillRoot }));
  // The snapshot landed beside state.yml with the exact bytes.
  const copied = fs.readFileSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME));
  assert.deepEqual(copied, fs.readFileSync(path.join(skillRoot, 'schema.json')));
  // And the §5.5 later-operation guard passes through the CLI-free lib path.
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  assert.equal(assertSkillIdentity({ statePath, skillRoot }).ok, true);
});

test('black-box CLI: capture-schema on a broken skill exits 1 with the named failure', () => {
  const { skillRoot } = mkskill({ omit: ['manifest.json'] });
  const { statePath } = mkbundle();
  const r = runCli(['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skill_absent:/);
  assert.equal(replaySchemaCapture(statePath).captured, null);
});

test('black-box CLI: amend-skill-identity recomputes the changed skill end to end', () => {
  // The operator's real path with the REAL module: capture -> routine skill update ->
  // declare (recompute; interrupted) -> approval-bound commit. The identity is computed
  // from the changed skill by the module the CLI registers itself, never asserted.
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  const capture = runCli(['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(capture.status, 0, capture.stderr);
  const captured = JSON.parse(capture.stdout.trim().split('\n').pop());

  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = computeSkillIdentity({ skillRoot });
  assert.notEqual(changedIdentity, captured.skill_identity);

  const identityFile = path.join(path.dirname(statePath), 'identity.json');
  fs.writeFileSync(identityFile, JSON.stringify({ skill_identity: changedIdentity }));
  const declare = runCli([
    'interview', 'amend-skill-identity', `--state=${statePath}`,
    `--skill-root=${skillRoot}`, `--identity-file=${identityFile}`,
  ]);
  assert.equal(declare.status, 1, 'without the approval the amendment stays pending (exit 1)');
  assert.match(declare.stderr, /amendment_pending/);
  const mid = replaySchemaCapture(statePath);
  assert.equal(mid.recorded_skill_identity, mid.captured.skill_identity, 'no adoption before approval');
  assert.equal(mid.pending_amendment.new_skill_identity, changedIdentity);

  const approvalFile = path.join(path.dirname(statePath), 'approval.json');
  fs.writeFileSync(approvalFile, JSON.stringify({
    attested_by: 'user', purpose: 'skill_identity_amend', skill_identity: changedIdentity,
    question: 'approve the replacement skill identity?', answer: 'approved', ts: '2026-01-02T00:00:00.000Z',
  }));
  const resume = runCli(['interview', 'amend-skill-identity', `--state=${statePath}`, `--approval=${approvalFile}`]);
  assert.equal(resume.status, 0, resume.stderr);
  const amended = JSON.parse(resume.stdout.trim().split('\n').pop());
  assert.equal(amended.event_type, 'skill_identity_amended');
  assert.equal(amended.new_skill_identity, changedIdentity);
  const done = replaySchemaCapture(statePath);
  assert.equal(done.recorded_skill_identity, changedIdentity);
  assert.equal(done.pending_amendment, null);
  // And the exemption was used exactly once: the guard passes on the amended identity.
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  assert.equal(assertSkillIdentity({ statePath, skillRoot }).ok, true);
});

// ---- wave-12 review fix-round regressions (adversary findings, 2026-09-06) -------

test('an ancestor symlink inside the closed set fails closed as undeclared_dependency', () => {
  // Review finding: a textually-in-range path whose ANCESTOR is a symlink to outside the
  // root used to pass the leaf lstat and digest OUTSIDE bytes into the identity. The
  // confined read re-verifies every ancestor as a real directory at read time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-esc-'));
  TMPDIRS.push(dir);
  const skillRoot = path.join(dir, 'skill');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'ref.md'), 'content outside the skill root\n');
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), '{"version": 1, "core": ["Purpose"]}\n');
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify({
    manifest_version: 1,
    skill: 'fixture-intent',
    host_contract_version: 1,
    schema_format_version: 1,
    identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json', 'assets/ref.md'] },
  }, null, 2)}\n`);
  // Swap the real assets dir for a symlink to outside — the leaf lstat passes (it stats the
  // outside regular file); the digest-time ancestor walk must refuse.
  fs.rmSync(path.join(skillRoot, 'assets'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(skillRoot, 'assets'));
  for (const op of [computeSkillIdentity, captureSchemaSnapshot]) {
    assert.throws(
      () => op({ skillRoot }),
      (e) => /undeclared_dependency: .*ancestor assets is not a real directory/.test(e.message),
      `the ancestor symlink must fail ${op.name} closed`,
    );
  }
});

test('a leaf swapped for a symlink fails its no-follow open and never digests outside bytes', () => {
  // The confinement's leaf half: O_NOFOLLOW means a post-inspection swap of a closed-set
  // member for an outside symlink can never reappear through the read — the open fails
  // (ELOOP) instead of digesting outside content. The deterministic proof of the open's
  // behavior, plus the validation-level refusal through the module ops.
  const { skillRoot } = mkskill();
  const outside = path.join(path.dirname(skillRoot), 'outside-leaf');
  fs.writeFileSync(outside, 'outside leaf content\n');
  const real = path.join(skillRoot, 'reference.md');
  fs.rmSync(real);
  fs.symlinkSync(outside, real);
  assert.throws(
    () => { fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); },
    (e) => e.code === 'ELOOP',
    'O_NOFOLLOW must refuse a symlinked leaf (the digest-time read fails closed, not outside)',
  );
  assert.throws(() => computeSkillIdentity({ skillRoot }), (e) => /^undeclared_dependency:/.test(e.message));
  assert.throws(() => captureSchemaSnapshot({ skillRoot }), (e) => /^undeclared_dependency:/.test(e.message));
});

test('a snapshot replaced by a symlink to the live file is refused, never followed', () => {
  // Review finding: readSchemaSnapshot used to follow symlinks, so a frozen bundle could
  // read the LIVE skill file through a snapshot symlink (digest equality did not establish
  // snapshot independence). The no-follow read must name the tamper and fail closed.
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  captureSchema({ statePath, skillRoot });
  const snapshotPath = path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME);
  const live = fs.readFileSync(path.join(skillRoot, 'schema.json'));
  fs.rmSync(snapshotPath);
  fs.symlinkSync(path.join(skillRoot, 'schema.json'), snapshotPath);
  assert.throws(
    () => readSchemaSnapshot({ statePath }),
    (e) => /schema_snapshot_not_regular: .*symlink/.test(e.message),
    'a symlink snapshot must fail closed as not-regular, never read the live file through it',
  );
  // And once the symlink is replaced by the real bytes again, the read works — the refusal
  // is about the entry's shape, not a poisoned state:
  fs.rmSync(snapshotPath);
  fs.writeFileSync(snapshotPath, live);
  const snap = readSchemaSnapshot({ statePath });
  assert.deepEqual(snap.bytes, live);
});

test('a capture whose destination is a pre-existing symlink is refused, not followed', () => {
  // The copy half of the same finding: writeFileSync would FOLLOW a destination symlink and
  // clobber its target (possibly the live schema.json). The copy refuses a non-regular
  // destination outright and publishes via temp + atomic rename.
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { statePath } = mkbundle();
  const snapshotPath = path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME);
  const target = path.join(path.dirname(statePath), 'clobber-target.json');
  fs.writeFileSync(target, '{"version": 1, "core": ["Purpose"]}\n');
  fs.symlinkSync(target, snapshotPath);
  assert.throws(() => captureSchema({ statePath, skillRoot }), /schema_snapshot_not_regular/);
  assert.equal(replaySchemaCapture(statePath).captured, null, 'a refusal is not a partial write');
  // The symlink's TARGET was not clobbered (its bytes are still its own):
  assert.equal(fs.readFileSync(target, 'utf8'), '{"version": 1, "core": ["Purpose"]}\n');
  // A clean capture after removing the symlink still works and publishes a regular file:
  fs.rmSync(snapshotPath);
  const ev = captureSchema({ statePath, skillRoot });
  assert.ok(fs.lstatSync(snapshotPath).isFile(), 'the published snapshot is a regular file');
  assert.equal(sha256Hex(fs.readFileSync(snapshotPath)), ev.schema_sha256);
});

function runCli(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      stderr: '',
    };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
// ---- the pre-publish review fix round (2026-09-08): finding 1 — the capture-root seam ----
//
// The reviewer's reproduction: capture a copied skill with --skill-root=<copy A>; append
// instructions to copy A's SKILL.md; ask Q1. WITHOUT the flag the runtime default previously
// resolved the developer checkout (the pin.repo fallback — a production-boundary violation
// reading the dev tree at runtime) instead of the root the capture used, so the changed
// installed instructions ESCAPED DETECTION (exit 0 ok). The default must resolve the root
// THE CAPTURE USED: the schema_captured event's skill_root field.

test('finding 1: the runtime guard default resolves the CAPTURE root — a mutated installed copy is detected without the flag', () => {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot: copyA, dir } = mkskill();
  // A second PRISTINE copy of the same bytes: --skill-root=B must still override the default.
  const copyB = path.join(dir, 'skill-b');
  fs.mkdirSync(copyB, { recursive: true });
  for (const rel of ['SKILL.md', 'schema.json', 'manifest.json', 'reference.md']) {
    fs.writeFileSync(path.join(copyB, rel), fs.readFileSync(path.join(copyA, rel)));
  }
  const { statePath } = mkbundle();

  // Capture names copy A — the event records the root THE CAPTURE RESOLVED.
  const capture = runCli(['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${copyA}`]);
  assert.equal(capture.status, 0, capture.stderr);
  const captured = JSON.parse(capture.stdout.trim().split('\n').pop());
  assert.equal(captured.event_type, 'schema_captured');
  const ev = replaySchemaCapture(statePath).captured;
  assert.equal(ev.skill_root, copyA, 'the capture records the skill root it resolved');

  // The reviewer's mutation: append instructions to copy A's SKILL.md.
  fs.appendFileSync(path.join(copyA, 'SKILL.md'), 'HOSTILE NEW INSTRUCTIONS\n');

  // (1) The reproduction's broken half: ask WITHOUT the flag. The default now resolves the
  // capture's recorded root (copy A), so the changed installed skill is DETECTED — the §5.5
  // named failure, never a pass, and never a read of the developer checkout.
  const noFlag = runCli(['interview', 'ask', `--state=${statePath}`, '--id=Q1', '--round=1', '--kind=intent', '--text=What is the outcome?']);
  assert.notEqual(noFlag.status, 0, 'a mutated installed skill must not pass the default guard');
  assert.match(`${noFlag.stderr}`, /skill_identity_changed/, `the named failure: ${noFlag.stderr}`);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8').includes('"interview_question"'),
    false,
    'the refused ask never reached the ledger',
  );

  // (2) The flag still overrides: asking at copy B (pristine, same identity) passes.
  const withFlag = runCli(['interview', 'ask', `--state=${statePath}`, `--skill-root=${copyB}`, '--id=Q1', '--round=1', '--kind=intent', '--text=What is the outcome?']);
  assert.equal(withFlag.status, 0, `the explicit root still overrides: ${withFlag.stderr}`);
  assert.equal(assertSkillIdentity({ statePath, skillRoot: copyB }).ok, true);

  // (3) A capture WITHOUT a resolvable root fails closed at every guarded verb: a bundle
  // whose schema_captured event predates the field carries no skill_root, so the default
  // resolves null and the guard refuses with skill_absent — never a fallback to the
  // developer checkout (the pin.repo path the reviewer flagged).
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-snap-noroot-'));
  TMPDIRS.push(legacyDir);
  const legacyState = path.join(legacyDir, 'state.yml');
  writeState(legacyState, buildSeedState({ slug: 'nr', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' }));
  appendEvent(legacyState, {
    type: 'schema_captured',
    schema_sha256: 'a'.repeat(64),
    skill_identity: 'b'.repeat(64),
    host_contract_version: '1',
    schema_format_version: '1',
    format_pin: 'schema_backed',
  });
  const noRoot = runCli(['interview', 'ask', `--state=${legacyState}`, '--id=Q1', '--round=1', '--kind=intent', '--text=What is the outcome?']);
  assert.notEqual(noRoot.status, 0, 'a capture with no recorded root fails closed');
  assert.match(noRoot.stderr, /skill_absent/, `the named refusal: ${noRoot.stderr}`);
});
