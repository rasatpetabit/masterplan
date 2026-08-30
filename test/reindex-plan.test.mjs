// test/reindex-plan.test.mjs — the plan re-index verb (mp reindex-plan).
//
// Contract under test:
//   - restamps plan.index.json plan_hash from the current plan.md sha256
//   - surgical: only the plan_hash line changes; all other bytes keep their formatting
//   - idempotent when the stamp already matches
//   - appends a plan_reindexed audit event (old -> new hash) when a sibling state.yml exists
//   - fail-closed: missing plan / unreadable-or-invalid index / absent plan_hash field

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializeState } from '../lib/bundle.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(repoRoot, 'bin/masterplan.mjs');

function run(args) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

// A bundle fixture whose index plan_hash is deliberately STALE vs plan.md.
function makeBundle({ plan = '# Plan\n\n- [ ] T1\n', withState = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reindex-'));
  fs.writeFileSync(path.join(dir, 'plan.md'), plan);
  const staleHash = 'sha256:' + randomBytes(32).toString('hex');
  // Non-standard spacing in the tasks array below is deliberate: the restamp must
  // preserve the file's original formatting byte-for-byte outside the hash line.
  const indexText =
    `{\n  "schema_version": "6.0",\n  "plan_hash": "${staleHash}",\n  "generated_at": "2026-08-30T00:00:00Z",\n  "tasks": [\n     {"id": 1, "wave": 1}\n  ]\n}\n`;
  fs.writeFileSync(path.join(dir, 'plan.index.json'), indexText);
  if (withState) {
    fs.writeFileSync(
      path.join(dir, 'state.yml'),
      serializeState({ schema_version: 8, slug: 'reindex-demo', status: 'active', phase: 'execute' })
    );
  }
  return { dir, index: path.join(dir, 'plan.index.json'), events: path.join(dir, 'events.jsonl'), staleHash };
}

function events(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('reindex-plan restamps a stale plan_hash and appends a plan_reindexed event', () => {
  const b = makeBundle();
  const r = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.reindex_plan, 'restamped');
  assert.equal(out.old_plan_hash, b.staleHash);
  const fresh = JSON.parse(fs.readFileSync(b.index, 'utf8'));
  assert.equal(fresh.plan_hash, sha(fs.readFileSync(path.join(b.dir, 'plan.md'))));
  const ev = events(b.events).filter((e) => e.type === 'plan_reindexed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.old_plan_hash, b.staleHash);
  assert.equal(ev[0].data.new_plan_hash, fresh.plan_hash);
});

test('reindex-plan is surgical: only the plan_hash line changes', () => {
  const b = makeBundle();
  const before = fs.readFileSync(b.index, 'utf8');
  const r = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(b.index, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length);
  const changed = beforeLines.flatMap((l, i) => (l === afterLines[i] ? [] : [i]));
  assert.equal(changed.length, 1, `expected exactly one changed line, got ${changed.length}`);
  assert.match(beforeLines[changed[0]], /plan_hash/);
});

test('reindex-plan is idempotent at a matching stamp and appends no second event', () => {
  const b = makeBundle();
  assert.equal(run(['reindex-plan', `--plan-index=${b.index}`]).status, 0);
  const r2 = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).reindex_plan, 'idempotent');
  assert.equal(events(b.events).filter((e) => e.type === 'plan_reindexed').length, 1);
});

test('reindex-plan without a sibling state.yml restamps silently (no event target)', () => {
  const b = makeBundle({ withState: false });
  const r = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).reindex_plan, 'restamped');
  assert.ok(!fs.existsSync(b.events));
});

test('reindex-plan honors an explicit --plan path', () => {
  const b = makeBundle();
  const alt = path.join(b.dir, 'other-plan.md');
  fs.writeFileSync(alt, '# Different plan\n');
  const r = run(['reindex-plan', `--plan-index=${b.index}`, `--plan=${alt}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).new_plan_hash, sha(fs.readFileSync(alt)));
});

test('reindex-plan fail-closed: missing plan.md', () => {
  const b = makeBundle();
  fs.unlinkSync(path.join(b.dir, 'plan.md'));
  const r = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot read plan/);
});

test('reindex-plan fail-closed: invalid index JSON', () => {
  const b = makeBundle();
  fs.writeFileSync(b.index, 'not-json{');
  const r = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not valid JSON/);
});

test('reindex-plan fail-closed: index without a plan_hash field refuses to invent one', () => {
  const b = makeBundle();
  fs.writeFileSync(b.index, '{"schema_version":"6.0","tasks":[]}\n');
  const r = run(['reindex-plan', `--plan-index=${b.index}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no plan_hash field/);
});

test('reindex-plan fail-closed: missing --plan-index', () => {
  const r = run(['reindex-plan']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing required --plan-index/);
});
