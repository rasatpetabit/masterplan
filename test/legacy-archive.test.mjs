// test/legacy-archive.test.mjs — tests for the legacy-archive doctor check.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../lib/doctor/legacy-archive.mjs';
import { writeState, buildSeedState } from '../lib/bundle.mjs';

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
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'legacy-archive-'));
  const base = path.join(tmp, 'docs', 'masterplan');
  fs.mkdirSync(base, { recursive: true });
  return { tmp, base };
}

function addBundle(base, slug, mutate) {
  const state = buildSeedState({ createdAt: '2026-01-01T00:00:00.000Z', slug, topic: `topic ${slug}` });
  if (mutate) mutate(state);
  const dir = path.join(base, slug);
  fs.mkdirSync(dir, { recursive: true });
  writeState(path.join(dir, 'state.yml'), state);
}

test('reports archived bundles without a completion class', () => {
  const { tmp, base } = makeRepo();

  addBundle(base, 'legacy-no-completion', (s) => {
    s.status = 'archived';
    delete s.completion;
  });

  addBundle(base, 'v9-finished', (s) => {
    s.status = 'archived';
    s.phase = 'execute';
    delete s.completion;
  });

  addBundle(base, 'archived-complete', (s) => {
    s.status = 'archived';
    s.completion = 'complete';
  });

  addBundle(base, 'archived-merged', (s) => {
    s.status = 'archived';
    s.completion = 'merged';
  });

  addBundle(base, 'archived-incomplete', (s) => {
    s.status = 'archived';
    s.completion = 'incomplete:attested';
  });

  addBundle(base, 'in-progress', (s) => {
    s.status = 'in-progress';
    s.completion = 'complete';
  });

  const findings = check(tmp);
  const legacy = findings.filter((f) => f.severity === 'PASS' && f.summary.includes('legacy archive'));

  assert.equal(legacy.length, 2);
  assert.ok(legacy.some((f) => f.summary.startsWith('legacy-no-completion:')));
  assert.ok(legacy.some((f) => f.summary.startsWith('v9-finished:')));

  // The non-legacy bundles must not be reported.
  assert.ok(!findings.some((f) => f.summary.includes('archived-complete')));
  assert.ok(!findings.some((f) => f.summary.includes('archived-merged')));
  assert.ok(!findings.some((f) => f.summary.includes('archived-incomplete')));
  assert.ok(!findings.some((f) => f.summary.includes('in-progress')));

  // No warnings expected for these well-formed bundles.
  assert.ok(!findings.some((f) => f.severity === 'WARN'));
});

test('returns a single PASS when there are no legacy archives', () => {
  const { tmp, base } = makeRepo();

  addBundle(base, 'archived-complete', (s) => {
    s.status = 'archived';
    s.completion = 'complete';
  });

  addBundle(base, 'in-progress', (s) => {
    s.status = 'in-progress';
    s.completion = 'complete';
  });

  const findings = check(tmp);
  assert.deepEqual(findings, [{
    id: 'legacy-archive',
    severity: 'PASS',
    summary: 'no legacy archives',
    fix: null,
  }]);
});

test('warns on an unreadable state file', () => {
  const { tmp, base } = makeRepo();
  const slug = 'broken';
  const dir = path.join(base, slug);
  fs.mkdirSync(dir, { recursive: true });
  // Make state.yml a directory so readState throws.
  fs.mkdirSync(path.join(dir, 'state.yml'));

  const findings = check(tmp);
  assert.ok(findings.some((f) => f.severity === 'WARN' && f.summary.includes('unreadable state file')));
});
