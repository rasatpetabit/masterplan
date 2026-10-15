// test/plan-entry-validation.test.mjs — L1 (review blocker): plan-entry validation runs on
// EVERY spec→plan attempt, before goals_frozen is appended.
//
// Regression: a failed spec review first appended goals_frozen (capture ran before the gate),
// and a retry then early-returned on the existing freeze — so an interview REOPENED after the
// failed review bypassed the interview-exit gate entirely, and --force made the bypass total.
// Now the spec-review gate runs first (no freeze is written until every plan-entry check
// passes), the capture validation (Intent validity, interview exit, assumption coverage)
// re-runs on every attempt regardless of an existing freeze, the freeze append stays
// idempotent at the same hash, and --force bypasses ONLY the spec-review gate.
//
// Exemptions preserved exactly as validateGoalsLoadGate had them on main: a bundle whose
// interview never ran (a pre-interview legacy bundle) proceeds with a stated skip, and a
// waived exit is honored through its durable interview_waived event.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeState, readState } from '../lib/bundle.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function run(args) {
  const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function appendEvent(bundleDir, rec) {
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify(rec)}\n`);
}
function readEvents(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const frozenCount = (bundleDir) => readEvents(bundleDir).filter((e) => e.type === 'goals_frozen').length;

const GOALS_MD = [
  'topic: |',
  '  plan entry validates every attempt',
  '',
  '## Intent',
  'why: a freeze event must never mask the checks that should precede it',
  'outcome: entering plan always validates Intent, interview exit and assumption coverage',
  'anti_goals: a frozen bundle skipping re-validation',
  'done_means: a green suite',
  '',
].join('\n');

// A goals_enabled brainstorm bundle: valid goals.md + spec.md, no interview ledger yet.
function mkBundle({ slug = 'pev', withInterview = true } = {}) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-planentry-'));
  const bundleDir = path.join(dir, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'brainstorm',
    pending_gate: null, active_run: null, goals_enabled: true,
    concurrency: { owner_lock: 'off' }, tasks: [],
  });
  fs.writeFileSync(path.join(bundleDir, 'goals.md'), GOALS_MD);
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nprove plan-entry validation\n');
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');
  if (withInterview) {
    // A properly ENDED interview (converged): the §5.4 exit gate's satisfied state.
    appendEvent(bundleDir, { type: 'interview_question', ts: '2026-01-01T00:00:01Z', id: 'q1', round: 1, kind: 'clarify', text: 'what is the outcome?' });
    appendEvent(bundleDir, { type: 'interview_answer', ts: '2026-01-01T00:00:02Z', id: 'q1', answer: 'validation on every attempt' });
    appendEvent(bundleDir, { type: 'interview_end', ts: '2026-01-01T00:00:03Z', reason: 'converged', asked: 1, cap: 12, attempts: 1 });
  }
  return { dir, bundleDir, statePath };
}

// Satisfy the spec-review gate at the CURRENT spec+goals hash (the recorded-review path).
function recordSpecReview(bundleDir, statePath) {
  const gh = run(['gate-hash', `--state=${statePath}`, '--gate=spec']);
  assert.equal(gh.status, 0, gh.stderr);
  const { hash, artifacts } = JSON.parse(gh.stdout);
  appendEvent(bundleDir, {
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:05Z',
    data: { hash, artifacts, count: 0, base: 'main' },
  });
}

test('failed spec review leaves NO goals_frozen; a reopened interview refuses the retry (with and without --force); a proper end advances', () => {
  const { bundleDir, statePath } = mkBundle({ slug: 'pev-l1' });

  // 1. First attempt with NO spec review: the gate refuses (exit 3) and NOTHING is frozen —
  //    the spec gate now runs before the freeze append.
  const first = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.notEqual(first.status, 0);
  assert.match(first.stdout, /run_gate_review/);
  assert.equal(frozenCount(bundleDir), 0, 'no goals_frozen before the spec-review gate passes');

  // 2. The spec review is recorded, then the interview is REOPENED after the failed attempt.
  recordSpecReview(bundleDir, statePath);
  appendEvent(bundleDir, { type: 'interview_reopened', ts: '2026-01-01T00:00:06Z', reason: 'the operator reopened the design' });

  // 3. Retry without --force: refused while the interview is open.
  const retry = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.notEqual(retry.status, 0, 'the reopened interview refuses the retry');
  assert.match(retry.stderr, /interview_reopened/);
  assert.equal(frozenCount(bundleDir), 0, 'still nothing frozen');
  assert.equal(readState(statePath).phase, 'brainstorm');

  // 4. Retry WITH --force: the spec-review gate is bypassed, but the interview-exit and
  //    assumption-coverage checks are NOT — still refused.
  const forced = run(['set-phase', `--state=${statePath}`, '--phase=plan', '--force']);
  assert.notEqual(forced.status, 0, '--force must not bypass the interview-exit gate');
  assert.match(forced.stderr, /interview_reopened/);
  assert.equal(frozenCount(bundleDir), 0);
  assert.equal(readState(statePath).phase, 'brainstorm');

  // 5. A proper end: the interview ends again, and the retry advances, freezing once.
  appendEvent(bundleDir, { type: 'interview_end', ts: '2026-01-01T00:00:07Z', reason: 'converged', asked: 2, cap: 12, attempts: 2 });
  const ok = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readState(statePath).phase, 'plan');
  assert.equal(frozenCount(bundleDir), 1, 'the freeze appended exactly once');
});

test('an EXISTING freeze never masks re-validation: a reopened interview refuses a later plan entry too', () => {
  const { bundleDir, statePath } = mkBundle({ slug: 'pev-refreeze' });
  recordSpecReview(bundleDir, statePath);
  const ok = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(frozenCount(bundleDir), 1);

  // The freeze exists; the interview is reopened afterwards. Re-entering plan re-validates
  // (L1: the old code early-returned on the existing freeze and let this through).
  appendEvent(bundleDir, { type: 'interview_reopened', ts: '2026-01-01T00:00:08Z', reason: 'post-freeze reopen' });
  const refused = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.notEqual(refused.status, 0, 'an existing goals_frozen must not bypass the interview-exit gate');
  assert.match(refused.stderr, /interview_reopened/);

  // A proper end re-admits — and the freeze append stays idempotent (no second event).
  appendEvent(bundleDir, { type: 'interview_end', ts: '2026-01-01T00:00:09Z', reason: 'converged', asked: 2, cap: 12, attempts: 2 });
  const again = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(frozenCount(bundleDir), 1, 'idempotent at the same hash — no second goals_frozen');
});

test('the pre-interview exemption is preserved: a bundle with no interview ledger advances with a stated skip', () => {
  const { bundleDir, statePath } = mkBundle({ slug: 'pev-nointerview', withInterview: false });
  recordSpecReview(bundleDir, statePath);
  const r = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no interview ledger/, 'the skip is stated, never silent');
  assert.equal(frozenCount(bundleDir), 1);
});

test('a recorded waiver is honored: interview_waived satisfies the exit gate on every attempt', () => {
  const { bundleDir, statePath } = mkBundle({ slug: 'pev-waived', withInterview: false });
  appendEvent(bundleDir, { type: 'interview_waived', ts: '2026-01-01T00:00:01Z', reason: 'operator waived: v1-style bundle' });
  recordSpecReview(bundleDir, statePath);
  const r = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(frozenCount(bundleDir), 1);
  // And again (idempotent re-entry, validation still runs and still passes).
  const r2 = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(frozenCount(bundleDir), 1);
});
