import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeState, buildSeedState } from '../lib/bundle.mjs';
import { check } from '../lib/doctor/incomplete-archive.mjs';

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function makeRepo() {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'incomplete-archive-'));
  const base = path.join(dir, 'docs', 'masterplan');
  fs.mkdirSync(base, { recursive: true });
  return { dir, base };
}

function writeBundle(base, slug, mutate) {
  const state = buildSeedState({ createdAt: '2026-01-01T00:00:00.000Z', slug, topic: `topic ${slug}` });
  mutate(state);
  const bundleDir = path.join(base, slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  writeState(path.join(bundleDir, 'state.yml'), state);
}

test('incomplete-archive check reports incomplete and merged archives only', () => {
  const { dir, base } = makeRepo();
  writeBundle(base, 'incomplete-attested', (s) => {
    s.status = 'archived';
    s.completion = 'incomplete:attested';
  });
  writeBundle(base, 'merged-bundle', (s) => {
    s.status = 'archived';
    s.completion = 'merged';
  });
  writeBundle(base, 'complete-bundle', (s) => {
    s.status = 'archived';
    s.completion = 'complete';
  });
  writeBundle(base, 'active-bundle', (s) => {
    s.status = 'in-progress';
    s.completion = 'incomplete:attested';
  });
  writeBundle(base, 'legacy-bundle', (s) => {
    s.status = 'archived';
    delete s.completion;
  });

  const findings = check(dir);
  const passFindings = findings.filter((f) => f.severity === 'PASS');
  assert.equal(passFindings.length, 2);
  const summaries = passFindings.map((f) => f.summary).sort();
  assert.deepEqual(summaries, [
    'incomplete-attested: archived as incomplete:attested',
    'merged-bundle: archived as merged',
  ]);
  assert.equal(findings.filter((f) => f.severity === 'WARN').length, 0);
});

test('incomplete-archive check returns single PASS when no matching archives', () => {
  const { dir, base } = makeRepo();
  writeBundle(base, 'complete-bundle', (s) => {
    s.status = 'archived';
    s.completion = 'complete';
  });
  const findings = check(dir);
  assert.deepEqual(findings, [{ id: 'incomplete-archive', severity: 'PASS', summary: 'no incomplete or merged archives', fix: null }]);
});
