// test/bundle.test.mjs — v8 run-bundle state read/write + pure transforms.
// Canonical v8 state.yml is flat: one `key: value` per line, complex values as inline
// JSON (valid YAML flow). Legacy v7 block-style is migrate.mjs's concern, not this module's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseState,
  serializeState,
  readState,
  writeState,
  openGate,
  clearGate,
  setActiveRun,
  clearActiveRun,
  markTask,
} from '../lib/bundle.mjs';

test('round-trips scalars with correct types', () => {
  const s = { schema_version: '6.0', slug: 'my-run', current_wave: 2, autonomy: 'loose', done: true, pending_gate: null };
  const out = parseState(serializeState(s));
  assert.deepEqual(out, s);
  assert.equal(typeof out.schema_version, 'string'); // "6.0" stays a string, not 6
  assert.equal(typeof out.current_wave, 'number');
});

test('round-trips nested objects and arrays via inline JSON', () => {
  const s = {
    active_run: { run_id: 'wf_x', task_id: 'k1', wave: 2 },
    tasks: [
      { id: 1, wave: 1, status: 'done', files: ['a.txt'] },
      { id: 2, wave: 2, status: 'pending', files: ['b.txt', 'c.txt'] },
    ],
    blockers: [],
  };
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('preserves strings that look like numbers / bools / null by quoting them', () => {
  const s = { a: '6.0', b: 'true', c: 'null', d: '123', e: 'sha256:abc-DEF.0' };
  const out = parseState(serializeState(s));
  assert.deepEqual(out, s);
  assert.equal(typeof out.a, 'string');
  assert.equal(typeof out.d, 'string');
});

test('handles empty string and values needing quotes (spaces, colons, unicode)', () => {
  const s = { empty: '', spaced: 'has space', special: 'a: b # c', uni: 'em—dash', ts: '2026-05-16T16:00:00Z' };
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('parse skips ---, comments, and blank lines', () => {
  assert.deepEqual(parseState('---\n# a comment\n\nslug: x\ncurrent_wave: 3\n'), { slug: 'x', current_wave: 3 });
});

test('writeState/readState round-trip atomically on disk (auto-creates dirs, cleans tmp)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bundle-'));
  try {
    const sp = path.join(dir, 'sub', 'state.yml');
    const state = { schema_version: '6.0', slug: 'r', tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }], active_run: null };
    writeState(sp, state);
    assert.ok(fs.existsSync(sp));
    assert.ok(!fs.existsSync(sp + '.tmp'));
    assert.deepEqual(readState(sp), state);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('state transforms are pure and correct', () => {
  const base = {
    slug: 'r', pending_gate: null, active_run: null,
    tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }, { id: 2, wave: 1, status: 'pending', files: [] }],
  };
  const frozen = JSON.stringify(base);

  const gate = { id: 'plan_approval', opened_at: '2026-01-01T00:00:00Z' };
  assert.deepEqual(openGate(base, gate).pending_gate, gate);
  assert.equal(clearGate(openGate(base, gate)).pending_gate, null);

  const run = { run_id: 'wf_1', task_id: 'k', wave: 1 };
  assert.deepEqual(setActiveRun(base, run).active_run, run);
  assert.equal(clearActiveRun(setActiveRun(base, run)).active_run, null);

  assert.equal(markTask(base, 2, 'done').tasks.find((t) => t.id === 2).status, 'done');
  assert.equal(markTask(base, 2, 'done').tasks.find((t) => t.id === 1).status, 'pending');

  assert.equal(JSON.stringify(base), frozen); // never mutated
});