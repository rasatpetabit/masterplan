// test/required-successor.test.mjs — doctor check for required-successor obligations.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../lib/doctor/required-successor.mjs';
import { buildSeedState, writeState } from '../lib/bundle.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeRepo(t) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-required-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBundle(repoRoot, slug, { status, predecessor, completion, events = [] } = {}) {
  const dir = path.join(repoRoot, 'docs', 'masterplan', slug);
  fs.mkdirSync(dir, { recursive: true });
  const state = buildSeedState({ createdAt: '2026-01-01T00:00:00.000Z', slug, topic: `topic for ${slug}` });
  if (status) state.status = status;
  if (predecessor) state.predecessor = predecessor;
  if (completion) state.completion = completion;
  writeState(path.join(dir, 'state.yml'), state);
  if (events.length) {
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

function reqEvent(slug, reason) {
  return { type: 'required_successor', slug, reason };
}

function createdEvent(slug, predecessor) {
  return { type: 'bundle_created', slug, predecessor };
}

test('absent successor -> WARN with seed command', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'WARN');
  assert.equal(f.fix, 'node bin/masterplan.mjs seed --slug=target --predecessor=source');
});

test('linked in-progress -> PASS', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  writeBundle(repo, 'target', { status: 'in-progress', predecessor: 'source' });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'PASS');
  assert.equal(f.summary, 'target: required successor of source in progress');
});

test('linked archived complete -> PASS', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  writeBundle(repo, 'target', { status: 'archived', predecessor: 'source', completion: 'complete' });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'PASS');
});

test('linked archived incomplete:attested -> ERROR', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  writeBundle(repo, 'target', { status: 'archived', predecessor: 'source', completion: 'incomplete:attested' });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'ERROR');
  assert.equal(f.summary, 'target: required successor of source archived as incomplete:attested without completing');
});

test('linked archived legacy -> ERROR', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  writeBundle(repo, 'target', { status: 'archived', predecessor: 'source' });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'ERROR');
  assert.equal(f.summary, 'target: required successor of source archived as legacy without completing');
});

test('same slug without predecessor link -> WARN', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  writeBundle(repo, 'target', { status: 'in-progress' });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'WARN');
  assert.equal(f.fix, 'node bin/masterplan.mjs seed --slug=target --predecessor=source');
});

test('no obligations -> PASS', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [] });
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'PASS');
  assert.equal(f.summary, 'no required-successor obligations');
});

test('doctor auto-discovers required-successor', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  const res = spawnSync(process.execPath, ['bin/doctor.mjs', repo], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(res.stdout + res.stderr, /required-successor/);
});

test('linked successor with unreadable state -> WARN', (t) => {
  const repo = makeRepo(t);
  writeBundle(repo, 'source', { events: [reqEvent('target', 'needed')] });
  const targetDir = path.join(repo, 'docs', 'masterplan', 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'state.yml')); // a directory: readState throws
  fs.writeFileSync(path.join(targetDir, 'events.jsonl'), JSON.stringify(createdEvent('target', 'source')) + '\n');
  const findings = check(repo);
  const f = findings.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'WARN');
  assert.equal(f.summary, 'target: required successor of source has an unreadable state.yml');
});

test('doctor exit code follows the obligation lifecycle (WARN → 0, ERROR → 1)', (t) => {
  const warnRepo = makeRepo(t);
  writeBundle(warnRepo, 'source', { events: [reqEvent('target', 'needed')] });
  const warn = spawnSync(process.execPath, ['bin/doctor.mjs', warnRepo], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(warn.stdout + warn.stderr, /required-successor/);
  assert.equal(warn.status, 0, warn.stdout + warn.stderr);
  const errRepo = makeRepo(t);
  writeBundle(errRepo, 'source', { events: [reqEvent('target', 'needed')] });
  writeBundle(errRepo, 'target', { status: 'archived', predecessor: 'source', completion: 'incomplete:attested' });
  const err = spawnSync(process.execPath, ['bin/doctor.mjs', errRepo], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(err.status, 1, err.stdout + err.stderr);
});
