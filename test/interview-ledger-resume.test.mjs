// test/interview-ledger-resume.test.mjs — focused suite for the replayable interview ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeState, buildSeedState } from '../lib/bundle.mjs';
import {
  BUDGETS,
  intentSha,
  replayInterview,
  interviewStatus,
  askQuestion,
  answerQuestion,
  withdrawQuestion,
  recordDraft,
  recordCritic,
  recordCriticUnavailable,
  acknowledgeCriticUnavailable,
  endInterview,
  waiveInterview,
  reopenInterview,
  replayLedger,
} from '../lib/interview.mjs';

function makeBundle(complexity = 'medium', phase = 'brainstorm', extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-'));
  const statePath = path.join(dir, 'state.yml');
  const state = { ...buildSeedState({ slug: 'iv', topic: 't', createdAt: '2026-01-01T00:00:00.000Z' }), complexity, phase, ...extra };
  writeState(statePath, state);
  return { dir, statePath };
}

test('cap refusal at low', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 1; i <= BUDGETS.low.cap; i++) {
    askQuestion({ statePath, id: `Q${i}`, round: 1, kind: 'intent', text: `q${i}` });
  }
  assert.throws(
    () => askQuestion({ statePath, id: `Q${BUDGETS.low.cap + 1}`, round: 1, kind: 'intent', text: 'overflow' }),
    /cap reached/
  );
});

test('floor not met for converged', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'q2' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  assert.throws(() => endInterview({ statePath, reason: 'converged' }), /floor/);
});

test('sequencing guards', (t) => {
  // Q2 before Q1
  {
    const { dir, statePath } = makeBundle('low');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.throws(
      () => askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'q2' }),
      /out of sequence/
    );
  }
  // sealed round
  {
    const { dir, statePath } = makeBundle('low');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
    answerQuestion({ statePath, id: 'Q1', text: 'a1' });
    assert.throws(
      () => askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'q2' }),
      /sealed/
    );
  }
  // unanswered earlier round
  {
    const { dir, statePath } = makeBundle('low');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
    assert.throws(
      () => askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' }),
      /unanswered/
    );
  }
});

test('withdrawals count against cap but not floor', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 1; i <= BUDGETS.low.cap; i++) {
    askQuestion({ statePath, id: `Q${i}`, round: 1, kind: 'intent', text: `q${i}` });
  }
  withdrawQuestion({ statePath, id: 'Q1' });
  for (let i = 2; i <= BUDGETS.low.cap; i++) answerQuestion({ statePath, id: `Q${i}`, text: `a${i}` });
  assert.throws(
    () => askQuestion({ statePath, id: `Q${BUDGETS.low.cap + 1}`, round: 2, kind: 'intent', text: 'overflow' }),
    /cap reached/
  );
  const status = interviewStatus(statePath);
  assert.equal(status.asked, BUDGETS.low.cap);
  assert.equal(status.answered, BUDGETS.low.cap - 1);
});

test('converged terminal', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Round 1: Q1 intent, Q2 design
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'design', text: 'q2' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  // Round 2: Q3 intent, Q4 design
  askQuestion({ statePath, id: 'Q3', round: 2, kind: 'intent', text: 'q3' });
  askQuestion({ statePath, id: 'Q4', round: 2, kind: 'design', text: 'q4' });
  answerQuestion({ statePath, id: 'Q3', text: 'a3' });
  answerQuestion({ statePath, id: 'Q4', text: 'a4' });
  // Round 3: Q5 intent
  askQuestion({ statePath, id: 'Q5', round: 3, kind: 'intent', text: 'q5' });
  answerQuestion({ statePath, id: 'Q5', text: 'a5' });
  // Draft
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  // Critic
  const status = interviewStatus(statePath);
  const payload = { unknowns: [], contradictions: [], misclassified: [], intent_draft: intent };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1',
      model: 'm',
      output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(intent),
    },
    payloadPath,
  });
  // End converged
  endInterview({ statePath, reason: 'converged' });
  // Further ask throws
  assert.throws(
    () => askQuestion({ statePath, id: 'Q6', round: 4, kind: 'intent', text: 'q6' }),
    /converged/
  );
});

test('exhausted at cap', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 1; i <= BUDGETS.low.cap; i++) {
    askQuestion({ statePath, id: `Q${i}`, round: 1, kind: 'intent', text: `q${i}` });
  }
  for (let i = 1; i <= BUDGETS.low.cap; i++) {
    answerQuestion({ statePath, id: `Q${i}`, text: `a${i}` });
  }
  endInterview({ statePath, reason: 'exhausted' });
});

test('critic_off at low', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  endInterview({ statePath, reason: 'critic_off' });
});

test('critic stale content_head', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payload = { unknowns: [], contradictions: [], misclassified: [] };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  assert.throws(
    () => recordCritic({
      statePath,
      receipt: {
        dispatch_id: 'd1',
        model: 'm',
        output_tokens: 10,
        content_head: status.content_head - 1,
        intent_sha256: intentSha(intent),
      },
      payloadPath,
    }),
    /stale receipt/
  );
});

test('critic requires output_tokens', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payload = { unknowns: [], contradictions: [], misclassified: [] };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  assert.throws(
    () => recordCritic({
      statePath,
      receipt: {
        dispatch_id: 'd1',
        model: 'm',
        output_tokens: 0,
        content_head: status.content_head,
        intent_sha256: intentSha(intent),
      },
      payloadPath,
    }),
    /output_tokens/
  );
});

test('critic payload copied and digest recorded', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payload = { unknowns: [], contradictions: [], misclassified: [] };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1',
      model: 'm',
      output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(intent),
    },
    payloadPath,
  });
  const copied = path.join(dir, 'interview-critic-1.json');
  assert.ok(fs.existsSync(copied));
  assert.deepEqual(JSON.parse(fs.readFileSync(copied, 'utf8')), payload);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const criticEvent = events.find((e) => e.type === 'interview_critic');
  assert.ok(criticEvent);
  const expectedSha = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  assert.equal(criticEvent.payload_sha256, expectedSha);
});

test('high complexity requires critic before next intent round', (t) => {
  const { dir, statePath } = makeBundle('high');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  assert.throws(
    () => askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' }),
    /critic receipt/
  );
});

test('resume from disk', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'design', text: 'q2' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  const status1 = interviewStatus(statePath);
  const replay1 = replayInterview(statePath);
  const status2 = interviewStatus(statePath);
  const replay2 = replayInterview(statePath);
  assert.deepEqual(status2, status1);
  assert.equal(replay2.asked, replay1.asked);
  assert.equal(replay2.answered, replay1.answered);
  assert.equal(replay2.contentHead, replay1.contentHead);
  assert.equal(replay2.terminal, replay1.terminal);
});

test('waived absorbing and reopen constraints', (t) => {
  const { dir, statePath } = makeBundle('medium', 'brainstorm', { goals_frozen: false });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  waiveInterview({ statePath, reason: 'user' });
  assert.throws(
    () => askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' }),
    /waived/
  );
  reopenInterview({ statePath, reason: 'continue' });
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  waiveInterview({ statePath, reason: 'user' });
  const state = { ...buildSeedState({ slug: 'iv', topic: 't', createdAt: '2026-01-01T00:00:00.000Z' }), complexity: 'medium', phase: 'brainstorm', goals_frozen: true };
  writeState(statePath, state);
  assert.throws(() => reopenInterview({ statePath, reason: 'continue' }), /goals are frozen/);
});

test('replayLedger verbatim order', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'design', text: 'q2' });
  withdrawQuestion({ statePath, id: 'Q2', reason: 'skip' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payload = { unknowns: [], contradictions: [], misclassified: [] };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1',
      model: 'm',
      output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(intent),
    },
    payloadPath,
  });
  const ledger = replayLedger(statePath);
  assert.deepEqual(ledger.map((e) => e.type), ['question', 'answer', 'question', 'withdraw', 'draft', 'critic']);
  assert.equal(ledger[0].id, 'Q1');
  assert.equal(ledger[1].text, 'a1');
  assert.equal(ledger[3].id, 'Q2');
  assert.equal(ledger[4].intent_sha256, intentSha(intent));
  assert.equal(ledger[5].n, 1);
});

test('tampered critic payload fails converged', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Round 1: Q1 intent, Q2 design
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'design', text: 'q2' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  // Round 2: Q3 intent, Q4 design
  askQuestion({ statePath, id: 'Q3', round: 2, kind: 'intent', text: 'q3' });
  askQuestion({ statePath, id: 'Q4', round: 2, kind: 'design', text: 'q4' });
  answerQuestion({ statePath, id: 'Q3', text: 'a3' });
  answerQuestion({ statePath, id: 'Q4', text: 'a4' });
  // Round 3: Q5 intent
  askQuestion({ statePath, id: 'Q5', round: 3, kind: 'intent', text: 'q5' });
  answerQuestion({ statePath, id: 'Q5', text: 'a5' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payload = { unknowns: [], contradictions: [], misclassified: [], intent_draft: intent };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1',
      model: 'm',
      output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(intent),
    },
    payloadPath,
  });
  // Overwrite the copied artifact with a different payload (tampered).
  const copied = path.join(dir, 'interview-critic-1.json');
  fs.writeFileSync(copied, JSON.stringify({ unknowns: [], contradictions: [], misclassified: [], extra: 'tampered' }));
  assert.throws(() => endInterview({ statePath, reason: 'converged' }), /clean/);
});

test('critic_off at low requires intent floor', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'design', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  assert.throws(() => endInterview({ statePath, reason: 'critic_off' }), /intent/);
});

test('replayLedger preserves supersedes/resolves and withdrawal reason', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1', supersedes: 'Q0', resolves: 'R1' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'design', text: 'q2' });
  withdrawQuestion({ statePath, id: 'Q2', reason: 'skip', resolves: 'R2' });
  const ledger = replayLedger(statePath);
  const answer = ledger.find((e) => e.type === 'answer');
  const withdraw = ledger.find((e) => e.type === 'withdraw');
  assert.equal(answer.supersedes, 'Q0');
  assert.equal(answer.resolves, 'R1');
  assert.equal(withdraw.reason, 'skip');
  assert.equal(withdraw.resolves, 'R2');
});

test('recordCritic derives unknown_count from the payload and rejects a contradicting receipt', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ unknowns: [{ id: 'U1', question: 'missing requirement' }], contradictions: [], misclassified: [] }));
  const base = { dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(intent) };
  assert.throws(() => recordCritic({ statePath, receipt: { ...base, unknown_count: 0 }, payloadPath }), /contradicts the payload/);
  recordCritic({ statePath, receipt: base, payloadPath });
  assert.equal(interviewStatus(statePath).critic.latest_unknowns, 1);
});

test('a successful critic receipt restores availability after two failures', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  recordCriticUnavailable({ statePath, error: 'e1' });
  recordCriticUnavailable({ statePath, error: 'e2' });
  assert.equal(interviewStatus(statePath).critic.mode, 'unavailable');
  const status = interviewStatus(statePath);
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ unknowns: [], contradictions: [], misclassified: [] }));
  recordCritic({ statePath, receipt: { dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(intent) }, payloadPath });
  assert.equal(interviewStatus(statePath).critic.mode, 'on');
  assert.throws(() => endInterview({ statePath, reason: 'exhausted', criticUnavailableAck: 'continue' }), /exhausted requires/);
});

test('high complexity: a design question opening the next round does not bypass the critic cadence', (t) => {
  const { dir, statePath } = makeBundle('high');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'design', text: 'q2' });
  assert.throws(() => askQuestion({ statePath, id: 'Q3', round: 2, kind: 'intent', text: 'q3' }), /critic receipt/);
});

test('a critic receipt is refused when intent content changed after the latest draft', (t) => {
  const { dir, statePath } = makeBundle('high');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ unknowns: [], contradictions: [], misclassified: [] }));
  const s1 = interviewStatus(statePath);
  recordCritic({ statePath, receipt: { dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: s1.content_head, intent_sha256: intentSha(intent) }, payloadPath });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  const s2 = interviewStatus(statePath);
  assert.throws(() => recordCritic({ statePath, receipt: { dispatch_id: 'd2', model: 'm', output_tokens: 10, content_head: s2.content_head, intent_sha256: intentSha(intent) }, payloadPath }), /latest draft is not the current/);
  assert.throws(() => askQuestion({ statePath, id: 'Q3', round: 3, kind: 'intent', text: 'q3' }), /critic receipt/);
});

test('critic unavailability does not carry over to newer intent content', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  recordCriticUnavailable({ statePath, error: 'e1' });
  recordCriticUnavailable({ statePath, error: 'e2' });
  assert.equal(interviewStatus(statePath).critic.mode, 'unavailable');
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  recordDraft({ statePath, intent: { why: 'w2', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  assert.equal(interviewStatus(statePath).critic.mode, 'on');
  assert.throws(() => endInterview({ statePath, reason: 'exhausted', criticUnavailableAck: 'continue' }), /exhausted requires/);
});

test('one critic failure at a new head does not restore stale unavailability', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  recordCriticUnavailable({ statePath, error: 'e1' });
  recordCriticUnavailable({ statePath, error: 'e2' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  recordDraft({ statePath, intent: { why: 'w2', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  recordCriticUnavailable({ statePath, error: 'e3' });
  assert.equal(interviewStatus(statePath).critic.mode, 'on');
  recordCriticUnavailable({ statePath, error: 'e4' });
  assert.equal(interviewStatus(statePath).critic.mode, 'unavailable');
});

test('a structurally incomplete critic payload is refused, never counted as clean', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const receipt = { dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(intent) };
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, '{}');
  assert.throws(() => recordCritic({ statePath, receipt, payloadPath }), /missing the unknowns array/);
  fs.writeFileSync(payloadPath, '[]');
  assert.throws(() => recordCritic({ statePath, receipt, payloadPath }), /must be a JSON object/);
  assert.equal(interviewStatus(statePath).critic.receipts, 0);
  assert.throws(() => endInterview({ statePath, reason: 'converged' })); // nothing recorded → convergence is not authorized
});

test('reopen is refused while the interview is neither ended nor waived', (t) => {
  const { dir, statePath } = makeBundle('medium', 'brainstorm', { goals_frozen: false });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => reopenInterview({ statePath, reason: 'continue' }), /not ended or waived/);
  waiveInterview({ statePath, reason: 'user' });
  reopenInterview({ statePath, reason: 'continue' });
  assert.throws(() => reopenInterview({ statePath, reason: 'again' }), /not ended or waived/);
});

test('a durable critic-unavailable acknowledgement authorizes exhausted on replay alone', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  assert.throws(() => acknowledgeCriticUnavailable({ statePath, answer: 'continue' }), /nothing to acknowledge/);
  recordCriticUnavailable({ statePath, error: 'e1' });
  recordCriticUnavailable({ statePath, error: 'e2' });
  acknowledgeCriticUnavailable({ statePath, answer: 'continue' });
  // A fresh process (no transient ack) ends the interview from the ledger alone, without a second ack event.
  endInterview({ statePath, reason: 'exhausted' });
  const acks = replayLedger(statePath).filter((e) => e.type === 'critic_unavailable_ack');
  assert.equal(acks.length, 1);
  assert.equal(interviewStatus(statePath).state, 'exhausted');
});

test('an acknowledgement is void once the content head moves', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  recordCriticUnavailable({ statePath, error: 'e1' });
  recordCriticUnavailable({ statePath, error: 'e2' });
  acknowledgeCriticUnavailable({ statePath, answer: 'continue' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  assert.throws(() => endInterview({ statePath, reason: 'exhausted' }), /exhausted requires/);
});

test('critic unavailability cannot be fabricated without a draft at the current head', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => recordCriticUnavailable({ statePath, error: 'e1' }), /no draft at the current content head/);
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  recordCriticUnavailable({ statePath, error: 'e1' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  assert.throws(() => recordCriticUnavailable({ statePath, error: 'e2' }), /no draft at the current content head/);
  assert.throws(() => recordCriticUnavailable({ statePath, error: '' }), /non-empty text/);
  assert.throws(() => endInterview({ statePath, reason: 'exhausted' }), /exhausted requires/);
});

test('malformed answers, questions and drafts are refused before they reach the ledger', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: '' }), /question requires non-empty text/);
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  assert.throws(() => answerQuestion({ statePath, id: 'Q1' }), /answer requires non-empty text/);
  assert.throws(() => answerQuestion({ statePath, id: 'Q1', text: null }), /answer requires non-empty text/);
  assert.equal(interviewStatus(statePath).answered, 0);
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  assert.throws(() => recordDraft({ statePath }), /requires an intent object/);
  assert.throws(() => recordDraft({ statePath, intent: { why: 'w' } }), /intent\.outcome/);
  assert.throws(() => recordDraft({ statePath, intent: { why: 'w', outcome: 'o', done_means: 'd', anti_goals: 'x' } }), /anti_goals must be an array/);
  assert.ok(!replayLedger(statePath).some((e) => e.type === 'draft'));
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: [], done_means: 'd' } });
  assert.equal(replayLedger(statePath).filter((e) => e.type === 'draft').length, 1);
});

test('a tampered critic artifact no longer satisfies the per-round critic requirement', (t) => {
  const { dir, statePath } = makeBundle('high');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  const status = interviewStatus(statePath);
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ unknowns: [], contradictions: [], misclassified: [] }));
  recordCritic({ statePath, receipt: { dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(intent) }, payloadPath });
  const bundleDir = path.dirname(statePath);
  const artifact = fs.readdirSync(bundleDir).find((f) => f.startsWith('interview-critic-') && f.endsWith('.json'));
  assert.ok(artifact, 'critic artifact copied into the bundle');
  fs.writeFileSync(path.join(bundleDir, artifact), '{"unknowns":[],"contradictions":[],"misclassified":[],"edited":true}');
  assert.throws(() => askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' }), /critic/);
  fs.rmSync(path.join(bundleDir, artifact));
  assert.throws(() => askQuestion({ statePath, id: 'Q2', round: 2, kind: 'intent', text: 'q2' }), /critic/);
});

test('design-pick supersession is independent of answer order', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'design', text: 'pick A?' });
  askQuestion({ statePath, id: 'Q3', round: 1, kind: 'design', text: 'pick B instead?' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  answerQuestion({ statePath, id: 'Q3', text: 'B', supersedes: 'Q2', corrected: true });
  answerQuestion({ statePath, id: 'Q2', text: 'A' });
  assert.equal(interviewStatus(statePath).active_design_picks, 0, 'Q2 stays superseded; Q3 is corrected');
});

test('an invalid critic receipt does not clear the unavailable state or its acknowledgement', (t) => {
  const { dir, statePath } = makeBundle('medium');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const intent = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent });
  recordCriticUnavailable({ statePath, error: 'e1' });
  recordCriticUnavailable({ statePath, error: 'e2' });
  acknowledgeCriticUnavailable({ statePath, answer: 'continue' });
  const status = interviewStatus(statePath);
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ unknowns: [], contradictions: [], misclassified: [] }));
  recordCritic({ statePath, receipt: { dispatch_id: 'd1', model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: intentSha(intent) }, payloadPath });
  assert.equal(interviewStatus(statePath).critic.mode, 'on');
  const bundleDir = path.dirname(statePath);
  const artifact = fs.readdirSync(bundleDir).find((f) => f.startsWith('interview-critic-') && f.endsWith('.json'));
  fs.rmSync(path.join(bundleDir, artifact));
  assert.equal(interviewStatus(statePath).critic.mode, 'unavailable', 'the invalid receipt is not evidence');
  endInterview({ statePath, reason: 'exhausted' }); // the durable acknowledgement survived
});

test('critic failures are refused while the critic is off (low complexity)', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  assert.throws(() => recordCriticUnavailable({ statePath, error: 'e1' }), /critic is off/);
  assert.equal(interviewStatus(statePath).critic.mode, 'off');
});

test('the first question must open round 1', (t) => {
  const { dir, statePath } = makeBundle('low');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => askQuestion({ statePath, id: 'Q1', round: 0, kind: 'intent', text: 'q1' }), /positive integer/);
  assert.throws(() => askQuestion({ statePath, id: 'Q1', round: 2, kind: 'intent', text: 'q1' }), /round must be current/);
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
});
