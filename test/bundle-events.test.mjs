import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENT_SCHEMAS,
  BOOTSTRAP_STEPS,
  validateEvent,
  validateBootstrapEvent,
  completionClass,
  validateCoreState,
  writeState,
  appendEvent,
  buildSeedState,
} from '../lib/bundle.mjs';

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

const validFixtures = {
  interview_question: { type: 'interview_question', id: 'q1', round: 1, kind: 'intent', text: 'Why?' },
  interview_answer: { type: 'interview_answer', id: 'a1', text: 'Because' },
  interview_withdraw: { type: 'interview_withdraw', id: 'q1' },
  interview_draft: { type: 'interview_draft', intent: { why: 'x', outcome: 'y', done_means: 'z', anti_goals: ['a'] } },
  interview_critic: { type: 'interview_critic', n: 1, dispatch_id: 'd', model: 'm', output_tokens: 100, payload_sha256: 'abc', content_head: 0, intent_sha256: 'def', unknown_count: 0 },
  critic_unavailable: { type: 'critic_unavailable', error: 'err' },
  critic_unavailable_ack: { type: 'critic_unavailable_ack', answer: 'ok' },
  interview_end: { type: 'interview_end', reason: 'converged' },
  interview_waived: { type: 'interview_waived', reason: 'r' },
  interview_reopened: { type: 'interview_reopened', reason: 'r' },
  overlap_review: { type: 'overlap_review', inventory_sha256: 'abc', outcome: 'ok' },
  config_warning: { type: 'config_warning', warnings: ['w1'] },
  deploy_base: { type: 'deploy_base', sha: 's', branch_tip: 'b', done_sha256: 'd' },
  deploy_step_authorized: { type: 'deploy_step_authorized', group: 'g', index: 0, sha: 's' },
  deploy_step_started: { type: 'deploy_step_started', group: 'g', index: 0, sha: 's' },
  deploy_step: { type: 'deploy_step', group: 'g', index: 0, exit: 0, status: 'done' },
  deploy_failed: { type: 'deploy_failed', group: 'g', index: 0, exit: 1 },
  deploy_indeterminate: { type: 'deploy_indeterminate', group: 'g', index: 0, exit: 0, check_exit: 2 },
  deploy_step_check_failed: { type: 'deploy_step_check_failed', group: 'g', index: 0 },
  done_adhoc: { type: 'done_adhoc', digest: 'd' },
  completion_confirmed: { type: 'completion_confirmed', deploy_base_sha: 's' },
  incomplete_authorized: { type: 'incomplete_authorized', reason: 'r' },
  required_successor: { type: 'required_successor', slug: 's', reason: 'r' },
  archive_pushed: { type: 'archive_pushed', sha: 's' },
  archive_push_skipped: { type: 'archive_push_skipped', reason: 'r' },
  bootstrap_armed: { type: 'bootstrap_armed', pass: 1, step: 'rehearsal', cmd: 'c', sha: 's' },
  bootstrap_step: { type: 'bootstrap_step', pass: 1, step: 'rehearsal', cmd: 'c', exit: 0, status: 'done' },
  goal_check: { type: 'goal_check', final: true, deploy_base_sha: 's', deploy_chain_hash: 'h', live_check_digest: null, intent_verdict: 'met' },
};

const invalidField = {
  interview_question: 'id',
  interview_answer: 'id',
  interview_withdraw: 'id',
  interview_draft: 'intent',
  interview_critic: 'n',
  critic_unavailable: 'error',
  critic_unavailable_ack: 'answer',
  interview_end: 'reason',
  interview_waived: 'reason',
  interview_reopened: 'reason',
  overlap_review: 'inventory_sha256',
  config_warning: 'warnings',
  deploy_base: 'sha',
  deploy_step_authorized: 'group',
  deploy_step_started: 'group',
  deploy_step: 'group',
  deploy_failed: 'group',
  deploy_indeterminate: 'group',
  deploy_step_check_failed: 'group',
  done_adhoc: 'digest',
  completion_confirmed: 'deploy_base_sha',
  incomplete_authorized: 'reason',
  required_successor: 'slug',
  archive_pushed: 'sha',
  archive_push_skipped: 'reason',
  bootstrap_armed: 'pass',
  bootstrap_step: 'pass',
  goal_check: 'deploy_base_sha',
};

const REQUIRED_EVENT_TYPES = [
  'interview_question',
  'interview_answer',
  'interview_withdraw',
  'interview_draft',
  'interview_critic',
  'critic_unavailable',
  'critic_unavailable_ack',
  'interview_end',
  'interview_waived',
  'interview_reopened',
  'overlap_review',
  'config_warning',
  'deploy_base',
  'deploy_step_authorized',
  'deploy_step_started',
  'deploy_step',
  'deploy_failed',
  'deploy_indeterminate',
  'deploy_step_check_failed',
  'done_adhoc',
  'completion_confirmed',
  'incomplete_authorized',
  'required_successor',
  'archive_pushed',
  'archive_push_skipped',
  'bootstrap_armed',
  'bootstrap_step',
  'goal_check',
];

test('every expected event type has a schema and a valid fixture', () => {
  assert.deepEqual(Object.keys(EVENT_SCHEMAS).sort(), REQUIRED_EVENT_TYPES.slice().sort());
  for (const type of REQUIRED_EVENT_TYPES) {
    assert.ok(validFixtures[type], `missing valid fixture for ${type}`);
  }
});

test('validateEvent accepts valid records and rejects invalid ones for every schema', () => {
  for (const type of Object.keys(EVENT_SCHEMAS)) {
    const valid = validFixtures[type];
    assert.deepEqual(validateEvent(valid), [], `${type} valid record should pass`);
    const invalid = { ...valid };
    delete invalid[invalidField[type]];
    const problems = validateEvent(invalid);
    assert.ok(problems.length > 0, `${type} invalid record (missing ${invalidField[type]}) should fail`);
  }
});

test('validateEvent tolerates generic/unknown types', () => {
  assert.deepEqual(validateEvent({ type: 'pre_finish_stage_required' }), []);
  assert.deepEqual(validateEvent({ type: 'phase_transition' }), []);
});

test('validateEvent rejects non-object and typeless records', () => {
  assert.ok(validateEvent(null).length > 0);
  assert.ok(validateEvent({}).length > 0);
  assert.ok(validateEvent({ type: '' }).length > 0);
});

test('deploy invariants', () => {
  assert.ok(validateEvent({ type: 'deploy_step', group: 'g', index: 0, exit: 1, status: 'done' }).length > 0);
  assert.ok(validateEvent({ type: 'deploy_failed', group: 'g', index: 0, exit: 0 }).length > 0);
  assert.ok(validateEvent({ type: 'deploy_indeterminate', group: 'g', index: 0, exit: 0, check_exit: 1 }).length > 0);
  assert.deepEqual(validateEvent({ type: 'deploy_failed', group: 'g', index: 0, exit: 0, check_exit: 1 }), []);
  assert.ok(validateEvent({ type: 'deploy_failed', group: 'g', index: 0, exit: 2, check_exit: 0 }).length > 0);
});

test('bootstrap_step binds status to exit', () => {
  assert.ok(validateBootstrapEvent({ type: 'bootstrap_step', pass: 1, step: 'rehearsal', cmd: 'false', exit: 1, status: 'done' }).length > 0);
  assert.ok(validateBootstrapEvent({ type: 'bootstrap_step', pass: 1, step: 'rehearsal', cmd: 'true', exit: 0, status: 'failed' }).length > 0);
  assert.deepEqual(validateBootstrapEvent({ type: 'bootstrap_step', pass: 1, step: 'rehearsal', cmd: 'x', exit: 1, status: 'failed' }), []);
  assert.deepEqual(validateBootstrapEvent({ type: 'bootstrap_step', pass: 1, step: 'rehearsal', cmd: 'x', exit: 0, status: 'recovered' }), []);
});

test('goal_check non-final passes and final missing intent_verdict fails', () => {
  assert.deepEqual(validateEvent({ type: 'goal_check', verdicts: [] }), []);
  assert.ok(validateEvent({ type: 'goal_check', final: true, deploy_base_sha: 's', deploy_chain_hash: 'h', live_check_digest: null }).length > 0);
});

test('BOOTSTRAP_STEPS is a non-empty array of unique strings ending with gate', () => {
  assert.ok(Array.isArray(BOOTSTRAP_STEPS));
  assert.ok(BOOTSTRAP_STEPS.length > 0);
  assert.ok(BOOTSTRAP_STEPS.every((s) => typeof s === 'string' && s.length > 0));
  assert.equal(new Set(BOOTSTRAP_STEPS).size, BOOTSTRAP_STEPS.length);
  assert.equal(BOOTSTRAP_STEPS[BOOTSTRAP_STEPS.length - 1], 'gate');
});

test('validateBootstrapEvent throws for non-bootstrap types and validates bootstrap types', () => {
  assert.throws(() => validateBootstrapEvent({ type: 'other' }), /expected bootstrap_armed or bootstrap_step/);
  assert.deepEqual(validateBootstrapEvent(validFixtures.bootstrap_armed), []);
  assert.deepEqual(validateBootstrapEvent(validFixtures.bootstrap_step), []);
});

test('appendEvent appends valid typed events, rejects invalid ones, tolerates generic, and enforces post-archive restriction', () => {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'bundle-events-'));
  const statePath = path.join(dir, 'state.yml');
  const eventsPath = path.join(dir, 'events.jsonl');
  const state = buildSeedState({ slug: 'test', topic: 't', createdAt: '2024-01-01' });
  writeState(statePath, state);

  // valid typed event
  const validEvent = validFixtures.interview_question;
  const returnedPath = appendEvent(statePath, validEvent);
  assert.equal(returnedPath, eventsPath);
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), validEvent);

  // invalid typed event throws and appends nothing
  const invalidEvent = { ...validEvent };
  delete invalidEvent.id;
  assert.throws(() => appendEvent(statePath, invalidEvent), /appendEvent: invalid interview_question event/);
  const afterInvalid = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
  assert.equal(afterInvalid.length, 1);

  // generic event is appended
  const genericEvent = { type: 'pre_finish_stage_required' };
  appendEvent(statePath, genericEvent);
  const afterGeneric = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
  assert.equal(afterGeneric.length, 2);
  assert.deepEqual(JSON.parse(afterGeneric[1]), genericEvent);

  // archive the bundle
  const archivedState = { ...state, status: 'archived' };
  writeState(statePath, archivedState);

  // non-archive_pushed event is rejected after archived
  assert.throws(() => appendEvent(statePath, validEvent), /bundle is archived/);
  // archive_pushed is accepted
  const pushEvent = { type: 'archive_pushed', sha: 'abc' };
  appendEvent(statePath, pushEvent);
  const afterPush = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
  assert.equal(afterPush.length, 3);
  assert.deepEqual(JSON.parse(afterPush[2]), pushEvent);
});

test('completionClass preserves complete/merged/incomplete and defaults to legacy', () => {
  assert.equal(completionClass({ completion: 'complete' }), 'complete');
  assert.equal(completionClass({ completion: 'merged' }), 'merged');
  assert.equal(completionClass({ completion: 'incomplete:attested' }), 'incomplete:attested');
  assert.equal(completionClass({}), 'legacy');
  assert.equal(completionClass({ completion: '' }), 'legacy');
  assert.equal(completionClass({ completion: 'unknown' }), 'legacy');
  assert.equal(completionClass({ completion: 'incomplete:' }), 'legacy');
});

test('validateCoreState tolerates legacy fields and autonomy full', () => {
  const state = {
    schema_version: 9,
    slug: 's',
    status: 'in-progress',
    phase: 'brainstorm',
    complexity_source: 'x',
    predecessor_transcript: 'y',
    autonomy: 'full',
    completion: 'complete',
    autonomy_source: 'z',
  };
  assert.deepEqual(validateCoreState(state), []);
});
