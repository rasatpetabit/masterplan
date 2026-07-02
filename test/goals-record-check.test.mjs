// test/goals-record-check.test.mjs — the `record-goal-check` bin verb (anti-fabrication goal-completeness
// receipt + waiver recorder). Spawns the real CLI over temp bundles. bin is fs-only: git facts (HEAD,
// base, base..HEAD diff hash, dirty status, run_verify output hash) are PASSED IN as flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const GOALS_MD = '## G1: Cover it\nsignal: test\n\n## G2: Flag it\nsignal: command\n';
const G_HASH = goalsHash(GOALS_MD);
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = 'sha256:diff-1';
const VOUT = 'sha256:verify-1';

// Build a frozen-goals bundle on disk and return its paths.
function makeBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gcheck-'));
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(
    statePath,
    serializeState({ schema_version: 8, slug: 'demo', status: 'active', phase: 'execute', goals_enabled: true, goals_md_hash: G_HASH })
  );
  fs.writeFileSync(path.join(dir, 'goals.md'), GOALS_MD);
  return { dir, statePath, eventsPath: path.join(dir, 'events.jsonl') };
}

function countEvents(eventsPath, type) {
  if (!fs.existsSync(eventsPath)) return 0;
  return fs
    .readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === type).length;
}

// A valid assessor receipt bound to the given tuple, covering both active goals.
function assessorReceipt({ head = HEAD, vout = VOUT } = {}) {
  return {
    goals_hash: G_HASH,
    head_sha: head,
    base_diff_hash: DIFF,
    verify_output_hash: vout,
    clean: true,
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'npm test passed' },
      G2: { verdict: 'partial', evidence: 'flag wired, docs pending' },
    },
    dispatch_id: 'disp-1',
    model: 'gpt-5.5',
    output_tokens: 128,
    ts: '2026-07-01T00:00:00Z',
  };
}

function userApproval(purpose) {
  return {
    attested_by: 'user',
    purpose,
    goals_hash: G_HASH,
    question: 'Accept manual verdict?',
    answer: 'yes',
    ts: '2026-07-01T00:00:00Z',
  };
}

const baseFlags = (statePath) => [
  `--state=${statePath}`,
  `--head-sha=${HEAD}`,
  `--base=${BASE}`,
  `--diff-hash=${DIFF}`,
  `--verify-output-hash=${VOUT}`,
];

test('assessor receipt records a goal_check event; re-entry at unchanged tuple is idempotent', () => {
  const b = makeBundle();
  const r = run([
    'record-goal-check',
    ...baseFlags(b.statePath),
    `--receipt=${JSON.stringify(assessorReceipt())}`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.recorded, 'goal_check');
  assert.equal(parsed.provenance_kind, 'assessor');
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 1);

  // Re-entry at the SAME tuple: idempotent skip, no double-append.
  const r2 = run([
    'record-goal-check',
    ...baseFlags(b.statePath),
    `--receipt=${JSON.stringify(assessorReceipt())}`,
  ]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).record_goal_check, 'idempotent');
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 1);
});

test('a later commit (HEAD change) re-arms: the old receipt is rejected', () => {
  const b = makeBundle();
  run(['record-goal-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(assessorReceipt())}`]);
  const NEWHEAD = 'c'.repeat(40);
  // New HEAD, but a receipt still pinned to the OLD head → rejected.
  const stale = run([
    'record-goal-check',
    `--state=${b.statePath}`,
    `--head-sha=${NEWHEAD}`,
    `--base=${BASE}`,
    `--diff-hash=${DIFF}`,
    `--verify-output-hash=${VOUT}`,
    `--receipt=${JSON.stringify(assessorReceipt())}`,
  ]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /head_sha/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 1);
});

test('REFUSES on a dirty worktree (exit non-zero, no event)', () => {
  const b = makeBundle();
  const r = run([
    'record-goal-check',
    ...baseFlags(b.statePath),
    '--dirty=true',
    `--receipt=${JSON.stringify(assessorReceipt())}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty/i);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});

test('stale verify output reused under an unchanged HEAD/base tuple is rejected', () => {
  const b = makeBundle();
  // Recorder recomputes VOUT (via --verify-output-hash) but the receipt pins a DIFFERENT verify hash.
  const r = run([
    'record-goal-check',
    ...baseFlags(b.statePath),
    `--receipt=${JSON.stringify(assessorReceipt({ vout: 'sha256:STALE' }))}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /verify_output_hash/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});

test('user-attested (manual) receipt records with provenance_kind=user', () => {
  const b = makeBundle();
  const receipt = {
    ...assessorReceipt(),
    attested_by: 'user',
    approval_receipt: userApproval('goal_check'),
  };
  delete receipt.dispatch_id;
  delete receipt.model;
  delete receipt.output_tokens;
  const r = run(['record-goal-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(receipt)}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).provenance_kind, 'user');
  const line = fs
    .readFileSync(b.eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .find((e) => e.type === 'goal_check');
  assert.equal(line.data.provenance_kind, 'user');
  assert.equal(line.data.provenance.attested_by, 'user');
});

test('manual path cannot masquerade as an assessor receipt (no attested_by, no assessor provenance)', () => {
  const b = makeBundle();
  const receipt = assessorReceipt();
  delete receipt.dispatch_id;
  delete receipt.model;
  delete receipt.output_tokens;
  // Neither attested_by:'user' nor assessor provenance → rejected, no event.
  const r = run(['record-goal-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(receipt)}`]);
  assert.notEqual(r.status, 0);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});

test('dispatch failure cannot archive silently: an invalid receipt records no event', () => {
  const b = makeBundle();
  const receipt = assessorReceipt();
  receipt.verdicts = { G1: { verdict: 'achieved', evidence: 'ok' } }; // missing G2
  const r = run(['record-goal-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(receipt)}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /G2/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});

test('waiver persists a goal_waived event; re-entry at unchanged tuple is idempotent', () => {
  const b = makeBundle();
  const waiver = {
    goals_hash: G_HASH,
    head_sha: HEAD,
    base: BASE,
    diff_hash: DIFF,
    reasons: { G2: 'deferred to a follow-up run' },
    approval: userApproval('goal_waive'),
  };
  const r = run(['record-goal-check', '--waive', ...baseFlags(b.statePath), `--waiver=${JSON.stringify(waiver)}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).recorded, 'goal_waived');
  assert.equal(countEvents(b.eventsPath, 'goal_waived'), 1);

  const r2 = run(['record-goal-check', '--waive', ...baseFlags(b.statePath), `--waiver=${JSON.stringify(waiver)}`]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).record_goal_check, 'idempotent');
  assert.equal(countEvents(b.eventsPath, 'goal_waived'), 1);
});

test('a waiver invalidates on tuple change (HEAD change → rejected)', () => {
  const b = makeBundle();
  const NEWHEAD = 'c'.repeat(40);
  const waiver = {
    goals_hash: G_HASH,
    head_sha: HEAD,
    base: BASE,
    diff_hash: DIFF,
    reasons: { G2: 'deferred' },
    approval: userApproval('goal_waive'),
  };
  const r = run([
    'record-goal-check',
    '--waive',
    `--state=${b.statePath}`,
    `--head-sha=${NEWHEAD}`,
    `--base=${BASE}`,
    `--diff-hash=${DIFF}`,
    `--waiver=${JSON.stringify(waiver)}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /head_sha/);
  assert.equal(countEvents(b.eventsPath, 'goal_waived'), 0);
});
