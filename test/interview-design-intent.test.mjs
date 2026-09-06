// test/interview-design-intent.test.mjs — task 53: the §5.3/§5.4 schema-backed convergence
// substitution and its terminal matrix.
//
// The MATRIX is the deliverable: a schema-backed interview (one with an approved schema
// capture) is judged by §5.3's two conditions — coverage of every checked section with
// provenance and stated uncertainty, and the probing minimum of genuine open questions
// answered fresh — INSTEAD of the three legacy floors (answer floor, intent floor,
// intent-round minimum). The matrix proves BOTH halves:
//
//   1. the schema-backed path STOPS applying the three legacy floors (a captured bundle
//      converges with every floor deliberately unmet), while
//   2. it STILL enforces everything else unchanged: zero unanswered questions, the
//      latest-draft rule, the high-complexity per-round critic receipts, and goals-load's
//      exhausted assumed-rows handling.
//
// A legacy twin refuses the same floor-unmet ledger — keeping the legacy suite green does
// NOT prove the legacy floors stopped applying; this matrix does.
//
// Also covered: probing_minimum config resolution (fail-closed validation), eligible-set
// rejections at the recorder, eligibility freshness, cap precedence, the forks_exhausted
// exemption, the recorder's mechanical test at low, coverage-record validation, policy
// persistence + forward-only capture, and ledger truthfulness (no synthetic Q/A, prior-context
// coverage never counts as an answer).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeState, buildSeedState, appendEvent, readState } from '../lib/bundle.mjs';
import {
  askQuestion,
  answerQuestion,
  withdrawQuestion,
  recordDraft,
  recordCritic,
  endInterview,
  waiveInterview,
  interviewStatus,
  intentSha,
  captureSchema,
  replaySchemaCapture,
  registerSchemaSnapshotModule,
  readSchemaSnapshot,
  SCHEMA_SNAPSHOT_FILENAME,
} from '../lib/interview.mjs';
import { captureSchemaSnapshot, computeSkillIdentity } from '../lib/schema-snapshot.mjs';
import {
  validateProbingMinimum,
  resolveProbingMinimum,
  resolveRunConfig,
  DEFAULT_PROBING_MINIMUM,
} from '../lib/config.mjs';
import { validateAssumptionsCoverage } from '../lib/goals.mjs';

const TMPDIRS = [];
test.after(() => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ---- fixtures -------------------------------------------------------------------

const SCHEMA = {
  version: 1,
  core: ['Purpose'],
  checked_sections: ['Purpose', 'Top invariant', 'Non-goals', 'Direction', 'Posture'],
  check_verdicts: ['serves', 'neutral', 'fights', 'unavailable'],
};

function mkbundle(complexity = 'medium') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-di-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, buildSeedState({ slug: 'iv', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity }));
  return { dir, statePath };
}

function mkskill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-di-'));
  TMPDIRS.push(dir);
  const skillRoot = path.join(dir, 'skill');
  const manifest = {
    manifest_version: 1,
    skill: 'fixture-intent',
    host_contract_version: 1,
    schema_format_version: 1,
    identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
  };
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(SCHEMA, null, 2)}\n`);
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return skillRoot;
}

// Capture on a fresh bundle: registers the REAL task-52 module and captures the fixture
// skill (which also writes the bundle snapshot the frozen read resolves).
function capture({ statePath, skillRoot }) {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  captureSchema({ statePath, skillRoot });
}

const INTENT = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };

function coverageRows(patch = {}) {
  return SCHEMA.checked_sections.map((section) => ({
    section,
    source: `operator interview, ${section} check`,
    uncertainty: '',
    verdict: 'serves',
    ...(patch[section] || {}),
  }));
}

function writeCoverage(dir, rows) {
  const file = path.join(dir, `coverage-${TMPDIRS.length}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ sections: rows }, null, 2)}\n`);
  return file;
}

function recordReceipt({ statePath, intent, eligible, forks, unknowns = [], n = 1, dir }) {
  const status = interviewStatus(statePath);
  const payloadPath = path.join(dir, `payload-${n}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({
    unknowns,
    contradictions: [],
    misclassified: [],
    ...(eligible !== undefined ? { eligible_question_set: eligible, forks_remaining: forks } : {}),
  }));
  recordCritic({
    statePath,
    receipt: { dispatch_id: `d${n}`, model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(intent) },
    payloadPath,
  });
}

// The canonical MEDIUM captured bundle whose three legacy floors are ALL deliberately
// unmet: 2 answered questions (floor wants 4), 2 intent-kind (intent floor wants 3),
// 1 completed intent round (minimum wants 2) — and everything else converged-able.
function convergingSchemaBackedMedium() {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
  askQuestion({ statePath, id: 'Q3', round: 1, kind: 'design', text: 'pick A or B?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'ships' });
  answerQuestion({ statePath, id: 'Q3', text: 'A' });
  recordDraft({ statePath, intent: INTENT });
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1', 'Q2'], forks: true, dir });
  const coverageFile = writeCoverage(dir, coverageRows());
  return { dir, statePath, skillRoot, coverageFile };
}

function lastEvent(statePath, type) {
  const lines = fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const ev = JSON.parse(lines[i]);
    if (ev.type === type) return ev;
  }
  return null;
}

// ---- THE MATRIX: the schema-backed path stops applying the three legacy floors ------

test('matrix row 1: a schema-backed interview converges with ALL THREE legacy floors deliberately unmet', async () => {
  const { statePath, coverageFile } = convergingSchemaBackedMedium();
  const before = interviewStatus(statePath);
  // The three floors, measured on this ledger before the end: 3 answered total (medium's
  // answer floor wants 4), only 2 of them intent-kind (the intent floor wants 3), and one
  // completed intent round (the minimum wants 2) — ALL THREE deliberately unmet.
  assert.ok(before.answered < before.floor, `answer floor unmet (${before.answered}/${before.floor})`);
  const r = (await import('../lib/interview.mjs')).replayInterview(statePath);
  assert.ok(r.answeredIntent < r.budget.intent_floor, `intent floor unmet (${r.answeredIntent}/${r.budget.intent_floor})`);
  assert.ok(r.completedIntentRounds < r.budget.intent_rounds_min, `intent-round minimum unmet (${r.completedIntentRounds}/${r.budget.intent_rounds_min})`);
  endInterview({ statePath, reason: 'converged', coverageFile, probingMinimum: 2 });
  const ev = lastEvent(statePath, 'interview_end');
  assert.equal(ev.reason, 'converged');
  assert.equal(ev.policy, 'schema_backed');
  assert.equal(ev.probing_minimum, 2);
  assert.match(ev.coverage_sha256, /^[0-9a-f]{64}$/);
  assert.equal(ev.basis, undefined);
  // The coverage artifact landed beside state.yml with the exact bytes:
  const artifact = path.join(path.dirname(statePath), 'interview-section-coverage.json');
  const raw = fs.readFileSync(artifact, 'utf8');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), ev.coverage_sha256);
});

test('matrix row 1 (legacy twin): the SAME floor-unmet ledger refuses every non-waived exit without a capture', () => {
  // Same questions, answers, draft, receipt and coverage — but NO schema capture: the
  // legacy floors apply AS WRITTEN, and converged is refused. Keeping the legacy suite
  // green is not the proof; this twin is.
  const { dir, statePath } = mkbundle('medium');
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
  askQuestion({ statePath, id: 'Q3', round: 1, kind: 'design', text: 'pick A or B?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'ships' });
  answerQuestion({ statePath, id: 'Q3', text: 'A' });
  recordDraft({ statePath, intent: INTENT });
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1', 'Q2'], forks: true, dir });
  const coverageFile = writeCoverage(dir, coverageRows());
  for (const reason of ['converged', 'exhausted', 'critic_off']) {
    assert.throws(
      () => endInterview({ statePath, reason, coverageFile, probingMinimum: 2 }),
      (e) => /requires the (answer floor|intent floor|intent-round minimum) met/.test(e.message),
      `${reason} must refuse under the legacy floors`,
    );
  }
});

test('matrix row 1 (legacy floors, each individually): each unmet floor names itself on a legacy ledger', () => {
  // 4 answered but only 2 intent-kind: the INTENT floor is the first named refusal.
  const a = mkbundle('medium');
  askQuestion({ statePath: a.statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q' });
  askQuestion({ statePath: a.statePath, id: 'Q2', round: 1, kind: 'intent', text: 'q' });
  askQuestion({ statePath: a.statePath, id: 'Q3', round: 1, kind: 'design', text: 'q' });
  answerQuestion({ statePath: a.statePath, id: 'Q1', text: 'a' });
  answerQuestion({ statePath: a.statePath, id: 'Q2', text: 'a' });
  answerQuestion({ statePath: a.statePath, id: 'Q3', text: 'a' });
  askQuestion({ statePath: a.statePath, id: 'Q4', round: 2, kind: 'design', text: 'q' });
  answerQuestion({ statePath: a.statePath, id: 'Q4', text: 'a' });
  recordDraft({ statePath: a.statePath, intent: INTENT });
  assert.throws(() => endInterview({ statePath: a.statePath, reason: 'converged' }), /requires the intent floor met \(2\/3\)/);
  // 4 answered, 3 intent-kind, 1 completed round: the ROUNDS minimum is named.
  const b = mkbundle('medium');
  askQuestion({ statePath: b.statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q' });
  askQuestion({ statePath: b.statePath, id: 'Q2', round: 1, kind: 'intent', text: 'q' });
  askQuestion({ statePath: b.statePath, id: 'Q3', round: 1, kind: 'intent', text: 'q' });
  askQuestion({ statePath: b.statePath, id: 'Q4', round: 1, kind: 'design', text: 'q' });
  answerQuestion({ statePath: b.statePath, id: 'Q1', text: 'a' });
  answerQuestion({ statePath: b.statePath, id: 'Q2', text: 'a' });
  answerQuestion({ statePath: b.statePath, id: 'Q3', text: 'a' });
  answerQuestion({ statePath: b.statePath, id: 'Q4', text: 'a' });
  recordDraft({ statePath: b.statePath, intent: INTENT });
  assert.throws(() => endInterview({ statePath: b.statePath, reason: 'converged' }), /requires the intent-round minimum met \(1\/2\)/);
});

// ---- the matrix's STILL-ENFORCED rows (schema-backed) -----------------------------

test('matrix row 2: zero unanswered questions still gates a schema-backed end', () => {
  const { dir, statePath, skillRoot } = convergingSchemaBackedMedium();
  // Re-open a fresh variant with an unanswered question: build it directly.
  const { dir: d2, statePath: sp2 } = mkbundle('medium');
  capture({ statePath: sp2, skillRoot });
  askQuestion({ statePath: sp2, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath: sp2, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' }); // never answered
  answerQuestion({ statePath: sp2, id: 'Q1', text: 'because' });
  recordDraft({ statePath: sp2, intent: INTENT });
  recordReceipt({ statePath: sp2, intent: INTENT, eligible: ['Q1'], forks: true, dir: d2 });
  const coverageFile = writeCoverage(d2, coverageRows());
  assert.throws(
    () => endInterview({ statePath: sp2, reason: 'converged', coverageFile, probingMinimum: 1 }),
    /there are unanswered questions/,
  );
  assert.equal(lastEvent(sp2, 'interview_end'), null, 'a refusal appends nothing');
});

test('matrix row 3: the latest-draft rule still gates a schema-backed end', () => {
  const { statePath, coverageFile } = convergingSchemaBackedMedium();
  // An intent answer AFTER the latest draft moves the head — every exit is blocked.
  askQuestion({ statePath, id: 'Q4', round: 2, kind: 'intent', text: 'a later fork?' });
  answerQuestion({ statePath, id: 'Q4', text: 'resolved' });
  assert.throws(
    () => endInterview({ statePath, reason: 'converged', coverageFile, probingMinimum: 2 }),
    /requires an interview_draft as the latest intent-content event/,
  );
});

test('matrix row 4: high-complexity per-round critic receipts still gate a schema-backed converged', () => {
  // The high cadence at the ASK forces a receipt after each earlier intent round (a receipt
  // needs a draft), so the per-round count is organically satisfied — the one honest
  // violation vector (mirroring the legacy suite's own technique) is a receipt that LATER
  // stops being valid: the current/clean checks pass, and the per-round DISTINCT-head count
  // of VALID receipts refuses converged.
  const { dir, statePath } = mkbundle('high');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  recordDraft({ statePath, intent: INTENT });
  // The cadence receipt round 2's intent asks require at high, at the draft head:
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1'], forks: true, dir, n: 1 });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'r2 fork?' });
  askQuestion({ statePath, id: 'Q3', round: 2, kind: 'design', text: 'pick?' });
  answerQuestion({ statePath, id: 'Q2', text: 'a' });
  answerQuestion({ statePath, id: 'Q3', text: 'A' });
  recordDraft({ statePath, intent: INTENT });
  // The current receipt on the second draft head — valid, clean, eligible (probing met):
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1', 'Q2'], forks: true, dir, n: 2 });
  // TAMPER the round-1 cadence receipt's artifact: it stops being a VALID receipt, and the
  // distinct valid receipt-head count (1) falls below the completed intent rounds (2).
  fs.rmSync(path.join(dir, 'interview-critic-1.json'));
  const coverageFile = writeCoverage(dir, coverageRows());
  assert.throws(
    () => endInterview({ statePath, reason: 'converged', coverageFile, probingMinimum: 2 }),
    /converged at high complexity requires one critic receipt per intent round/,
  );
});

test('matrix row 5: goals-load exhausted assumed-rows handling still works on a schema-backed forks_exhausted event', () => {
  // forks_exhausted: coverage complete, the critic says no forks remain, the minimum is
  // unmet, and the cap is NOT reached — the single probing exemption.
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'ships' });
  recordDraft({ statePath, intent: INTENT });
  // Eligible: [Q1] only — the minimum (2) is unmet; the critic says no forks remain; the
  // payload carries an unknown the spec must carry as an Assumptions row.
  recordReceipt({
    statePath, intent: INTENT, eligible: ['Q1'], forks: false, dir,
    unknowns: [{ id: 'U1', why_it_changes_design: 'the storage choice' }],
  });
  const coverageFile = writeCoverage(dir, coverageRows());
  endInterview({ statePath, reason: 'exhausted', coverageFile, probingMinimum: 2 });
  const ev = lastEvent(statePath, 'interview_end');
  assert.equal(ev.reason, 'exhausted');
  assert.equal(ev.basis, 'forks_exhausted');
  assert.equal(ev.policy, 'schema_backed');
  assert.equal(ev.probing_minimum, 2);
  assert.deepEqual(ev.unknowns, [{ id: 'U1', why_it_changes_design: 'the storage choice' }]);
  // The REAL goals-load assumptions check on the REAL event: a missing row refuses.
  const noRows = validateAssumptionsCoverage({ endEvent: ev, specText: '# spec\n\n## Assumptions\n\n| ID | Assumption |\n|---|---|\n| U2 | other |\n' });
  assert.equal(noRows.ok, false);
  assert.equal(noRows.code, 'assumed_row_missing');
  assert.deepEqual(noRows.missing, ['U1']);
  const withRow = validateAssumptionsCoverage({ endEvent: ev, specText: '# spec\n\n## Assumptions\n\n| ID | Assumption |\n|---|---|\n| U1 | storage is an assumption |\n' });
  assert.equal(withRow.ok, true);
  assert.deepEqual(withRow.required, ['U1']);
});

// ---- probing_minimum config resolution (fail-closed) -------------------------------

test('probing_minimum: shipped defaults, partial merge, and the fail-closed validation vocabulary', () => {
  assert.deepEqual({ ...DEFAULT_PROBING_MINIMUM }, { low: 1, medium: 2, high: 4 });
  // Partial maps merge over the defaults; the invariants hold on the EFFECTIVE values.
  assert.deepEqual({ ...validateProbingMinimum({ medium: 3 }) }, { low: 1, medium: 3, high: 4 });
  // Fail-closed vocabulary: non-integer, below 1, unknown level, decreasing, high==low.
  for (const bad of [0, -1, 'x', { low: 0 }, { low: 'x' }, { ultra: 2 }, { low: 1, medium: 2, high: 1 }, { low: 2, medium: 2, high: 2 }, { low: 4, medium: 3, high: 5 }]) {
    assert.throws(() => validateProbingMinimum(bad), /probing_minimum is invalid/, `must reject ${JSON.stringify(bad)}`);
  }
  // high strictly greater than low is legal when the whole map says so:
  assert.deepEqual({ ...validateProbingMinimum({ low: 2, medium: 3, high: 5 }) }, { low: 2, medium: 3, high: 5 });
});

test('probing_minimum resolves through the §4 config hierarchy and fails closed at resolution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-cfg-'));
  TMPDIRS.push(dir);
  fs.writeFileSync(path.join(dir, '.masterplan.yaml'), 'interview:\n  probing_minimum:\n    medium: 3\n');
  const cfg = resolveRunConfig({ cli: {}, repoRoot: dir, env: {} });
  assert.equal(resolveProbingMinimum(cfg, 'medium'), 3, 'the repo config overrides the default');
  assert.equal(resolveProbingMinimum(cfg, 'low'), DEFAULT_PROBING_MINIMUM.low, 'per-key defaults apply');
  // An invalid repo config fails the WHOLE resolution (fail-closed, never a silent default):
  fs.writeFileSync(path.join(dir, '.masterplan.yaml'), 'interview:\n  probing_minimum:\n    medium: 0\n');
  assert.throws(
    () => resolveRunConfig({ cli: {}, repoRoot: dir, env: {} }),
    /probing_minimum is invalid \(medium must be an integer >= 1/,
  );
});

// ---- eligible-set rejections at the recorder (never the questioner's judgment) ------

test('recordCritic rejects an eligible set naming unknown, duplicate, withdrawn, unanswered, or design-kind ids', () => {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'design', text: 'pick?' });
  askQuestion({ statePath, id: 'Q3', round: 1, kind: 'intent', text: 'withdrawn without an answer' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'A' });
  withdrawQuestion({ statePath, id: 'Q3', reason: 'superseded by Q1' });
  recordDraft({ statePath, intent: INTENT });
  const status = interviewStatus(statePath);
  const payload = (extra) => {
    const file = path.join(dir, `p-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      unknowns: [], contradictions: [], misclassified: [], ...extra,
    }));
    return file;
  };
  const receipt = () => ({ dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(INTENT) });
  assert.throws(() => recordCritic({ statePath, receipt: receipt(), payloadPath: payload({ eligible_question_set: ['Q99'], forks_remaining: true }) }), /unknown question Q99/);
  assert.throws(() => recordCritic({ statePath, receipt: receipt(), payloadPath: payload({ eligible_question_set: ['Q1', 'Q1'], forks_remaining: true }) }), /names Q1 more than once/);
  assert.throws(() => recordCritic({ statePath, receipt: receipt(), payloadPath: payload({ eligible_question_set: ['Q2'], forks_remaining: true }) }), /design-kind question Q2/);
  assert.throws(() => recordCritic({ statePath, receipt: receipt(), payloadPath: payload({ eligible_question_set: ['Q3'], forks_remaining: true }) }), /withdrawn question Q3/);
  // A valid set lands and its event carries both verdict fields:
  recordCritic({ statePath, receipt: receipt(), payloadPath: payload({ eligible_question_set: ['Q1'], forks_remaining: true }) });
  const ev = lastEvent(statePath, 'interview_critic');
  assert.deepEqual(ev.eligible_question_set, ['Q1']);
  assert.equal(ev.forks_remaining, true);
});

test('eligible_question_set and forks_remaining arrive together or neither', () => {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  recordDraft({ statePath, intent: INTENT });
  const status = interviewStatus(statePath);
  const file = path.join(dir, 'solo.json');
  fs.writeFileSync(file, JSON.stringify({ unknowns: [], contradictions: [], misclassified: [], eligible_question_set: ['Q1'] }));
  assert.throws(
    () => recordCritic({ statePath, receipt: { dispatch_id: 'd', model: 'm', output_tokens: 1, content_head: status.content_head, intent_sha256: intentSha(INTENT) }, payloadPath: file }),
    /arrive together/,
  );
});

// ---- freshness, cap precedence, and the waiver cause ------------------------------

test('a stale eligible set counts for nothing: the probing minimum cannot be satisfied without a CURRENT receipt', () => {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
  askQuestion({ statePath, id: 'Q3', round: 1, kind: 'design', text: 'pick?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'ships' });
  answerQuestion({ statePath, id: 'Q3', text: 'A' });
  recordDraft({ statePath, intent: INTENT });
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1', 'Q2'], forks: true, dir });
  // New content AFTER the receipt: a new draft moves the head — the receipt is now stale.
  askQuestion({ statePath, id: 'Q4', round: 2, kind: 'intent', text: 'a later fork?' });
  answerQuestion({ statePath, id: 'Q4', text: 'resolved' });
  recordDraft({ statePath, intent: INTENT });
  // A CURRENT receipt at the new draft — but one that carries NO eligible set (a
  // pre-adjudication receipt): converged's own checks pass, and the probing evaluation
  // names the missing adjudication. The STALE first receipt counts for nothing.
  recordReceipt({ statePath, intent: INTENT, eligible: undefined, forks: undefined, dir, n: 2 });
  const coverageFile = writeCoverage(dir, coverageRows());
  assert.throws(
    () => endInterview({ statePath, reason: 'converged', coverageFile, probingMinimum: 2 }),
    /probing minimum met \(0\/2 .*no eligible set/,
  );
});

test('the CAP takes precedence: at cap with the minimum unmet, exhausted is refused — even when the critic said no forks remain', () => {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  recordDraft({ statePath, intent: INTENT });
  // Current receipt, forks_remaining FALSE, eligible [Q1] — minimum 2 unmet.
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1'], forks: false, dir });
  // Reach the cap (10): design asks only — they are not content events, so the receipt
  // stays current and the draft stays latest. Design withdraws keep zero-unanswered true.
  for (let i = 2; i <= 10; i += 1) {
    askQuestion({ statePath, id: `Q${i}`, round: i, kind: 'design', text: `filler ${i}?` });
    withdrawQuestion({ statePath, id: `Q${i}`, reason: 'cap filler' });
  }
  const coverageFile = writeCoverage(dir, coverageRows());
  assert.throws(
    () => endInterview({ statePath, reason: 'exhausted', coverageFile, probingMinimum: 2 }),
    /cap is reached with the probing minimum unmet \(1\/2\)/,
  );
  // The waiver is the ONLY exit, carrying the routed cause:
  waiveInterview({ statePath, reason: 'operator closed it', probingMinimum: 2 });
  const ev = lastEvent(statePath, 'interview_waived');
  assert.equal(ev.cause, 'probing_minimum_unmet_at_cap');
  assert.equal(ev.policy, 'schema_backed');
});

test('at low complexity the mechanical test decides: critic_off end under capture, and its refusal above the minimum', () => {
  const { dir, statePath } = mkbundle('low');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  recordDraft({ statePath, intent: INTENT });
  const coverageFile = writeCoverage(dir, coverageRows());
  // Minimum 1 (the shipped low default): the mechanical count is 1 — the end is permitted.
  endInterview({ statePath, reason: 'critic_off', coverageFile, probingMinimum: 1 });
  const ev = lastEvent(statePath, 'interview_end');
  assert.equal(ev.reason, 'critic_off');
  assert.equal(ev.policy, 'schema_backed');
  assert.equal(ev.probing_minimum, 1);
  // Above the mechanical count, the same end refuses:
  const second = mkbundle('low');
  capture({ statePath: second.statePath, skillRoot });
  askQuestion({ statePath: second.statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  answerQuestion({ statePath: second.statePath, id: 'Q1', text: 'because' });
  recordDraft({ statePath: second.statePath, intent: INTENT });
  assert.throws(
    () => endInterview({ statePath: second.statePath, reason: 'critic_off', coverageFile: writeCoverage(second.dir, coverageRows()), probingMinimum: 2 }),
    /mechanical test \(1\/2\)/,
  );
});

// ---- coverage-record validation (the §5.3 coverage condition) -----------------------

test('coverage: the record is validated EXACTLY against the frozen snapshot, fail-closed on every shape of incompleteness', () => {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'ships' });
  recordDraft({ statePath, intent: INTENT });
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1', 'Q2'], forks: true, dir });
  // No record at all:
  assert.throws(
    () => endInterview({ statePath, reason: 'converged', coverageFile: undefined, probingMinimum: 2 }),
    /requires its section-coverage record/,
  );
  // Missing a section; an unknown section; a duplicate; fights; unavailable; empty source;
  // a row that omits its uncertainty entirely:
  const cases = [
    [coverageRows().filter((r) => r.section !== 'Purpose'), /coverage is incomplete: checked section Purpose has no row/],
    [[...coverageRows(), { section: 'Audience', source: 'x', uncertainty: '' }], /which the schema snapshot does not declare as checked/],
    [[...coverageRows(), coverageRows()[0]], /duplicate coverage row/],
    [coverageRows({ Purpose: { verdict: 'fights' } }), /FIGHTS verdict/],
    [coverageRows({ Purpose: { verdict: 'unavailable' } }), /UNAVAILABLE/],
    [coverageRows({ Purpose: { source: '' } }), /carries no provenance/],
    [coverageRows({ Purpose: { uncertainty: undefined } }), /must state its unresolved uncertainty/],
  ];
  for (const [rows, re] of cases) {
    assert.throws(
      () => endInterview({ statePath, reason: 'converged', coverageFile: writeCoverage(dir, rows), probingMinimum: 2 }),
      (e) => re.test(e.message),
      `must refuse ${JSON.stringify(rows).slice(0, 60)}`,
    );
  }
  assert.equal(lastEvent(statePath, 'interview_end'), null, 'every refusal above appended nothing');
});

test('prior-context coverage COVERS but is never an answer: the probing minimum still decides', () => {
  const { dir, statePath } = mkbundle('medium');
  const skillRoot = mkskill();
  capture({ statePath, skillRoot });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'design', text: 'pick?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  answerQuestion({ statePath, id: 'Q2', text: 'A' });
  recordDraft({ statePath, intent: INTENT });
  // Every section's evidence is reused prior context — covered, but the probing minimum
  // (2) counts only ledger questions, and the eligible set is empty:
  recordReceipt({ statePath, intent: INTENT, eligible: [], forks: false, dir });
  const priorRows = SCHEMA.checked_sections.map((section) => ({
    section,
    source: `prior context: goals.md ${section}`,
    uncertainty: '',
    verdict: 'serves',
  }));
  assert.throws(
    () => endInterview({ statePath, reason: 'converged', coverageFile: writeCoverage(dir, priorRows), probingMinimum: 2 }),
    /converged requires the probing minimum met \(0\/2\)/,
  );
});

// ---- policy identity: persisted, forward-only, never revalidated -------------------

test('the policy is persisted on every terminal event; a legacy end carries legacy', () => {
  // A legacy converged (all floors met) records policy 'legacy':
  const { dir, statePath } = mkbundle('medium');
  for (let i = 1; i <= 3; i += 1) {
    askQuestion({ statePath, id: `Q${i}`, round: 1, kind: 'intent', text: `q${i}` });
  }
  answerQuestion({ statePath, id: 'Q1', text: 'a' });
  answerQuestion({ statePath, id: 'Q2', text: 'a' });
  answerQuestion({ statePath, id: 'Q3', text: 'a' });
  askQuestion({ statePath, id: 'Q4', round: 2, kind: 'intent', text: 'q4' });
  askQuestion({ statePath, id: 'Q5', round: 2, kind: 'design', text: 'pick?' });
  answerQuestion({ statePath, id: 'Q4', text: 'a' });
  answerQuestion({ statePath, id: 'Q5', text: 'A' });
  recordDraft({ statePath, intent: INTENT });
  recordReceipt({ statePath, intent: INTENT, eligible: ['Q1', 'Q2', 'Q3', 'Q4'], forks: true, dir });
  endInterview({ statePath, reason: 'converged' });
  const ev = lastEvent(statePath, 'interview_end');
  assert.equal(ev.policy, 'legacy');
  assert.equal(ev.probing_minimum, undefined);
  assert.equal(ev.coverage_sha256, undefined);
});

test('capture is forward-only: refused on a terminal interview (the operator starts a new one)', () => {
  const { statePath, skillRoot, coverageFile } = convergingSchemaBackedMedium();
  endInterview({ statePath, reason: 'converged', coverageFile, probingMinimum: 2 });
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  assert.throws(() => captureSchema({ statePath, skillRoot }), /interview is converged/);
});

test('a whole-draft waiver is never expanded into synthetic question/answer events', () => {
  const { dir, statePath } = mkbundle('medium');
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  answerQuestion({ statePath, id: 'Q1', text: 'because' });
  const lines = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const before = lines().filter((e) => e.type === 'interview_question' || e.type === 'interview_answer').length;
  waiveInterview({ statePath, reason: 'approved the whole draft' });
  const after = lines().filter((e) => e.type === 'interview_question' || e.type === 'interview_answer').length;
  assert.equal(after, before, 'the waiver appended exactly one waived event and no synthetic Q/A');
  const ev = lastEvent(statePath, 'interview_waived');
  assert.equal(ev.policy, 'legacy');
});

// ---- the schema-backed frozen read is part of the terminal evaluation --------------

test('the coverage evaluation reads the FROZEN SNAPSHOT, never the live skill file', () => {
  const { dir, statePath, skillRoot } = convergingSchemaBackedMedium();
  // Mutate the LIVE skill schema after capture: the terminal evaluation must not see it.
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify({ ...SCHEMA, checked_sections: ['Purpose'] }, null, 2)}\n`);
  // The coverage record for all five snapshot sections still validates against the
  // SNAPSHOT (the live file now declares one), and the end succeeds:
  endInterview({ statePath, reason: 'converged', coverageFile: writeCoverage(dir, coverageRows()), probingMinimum: 2 });
  const snap = readSchemaSnapshot({ statePath });
  assert.deepEqual(snap.schema.checked_sections, SCHEMA.checked_sections);
});
