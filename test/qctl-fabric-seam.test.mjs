// test/qctl-fabric-seam.test.mjs — the qctl dormant seam, entered through the FABRIC path.
//
// simplify-dedup-2 task 4: with the legacy routing brain slated for post-soak deletion, the
// §6.3 qctl eligibility gate (resolveTaskBackend/qctlEligible, lib/dispatch/backend.mjs) must
// stay reachable from the fabric dispatch path. prepareWave's fabric branch arms the seam ONLY
// when config.implementer.qctl.enabled === true; an eligible task's payload gains the
// `backend` work-item discriminator, which buildWorkItem carries onto the adsp descriptor
// (descriptor-only — like `review`, EXCLUDED from the task-spec hash). The shipped flag-off
// default NEVER selects qctl: no field, no allowlist consultation, byte-identical payloads,
// descriptors, and handoff keys by construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWave } from '../lib/wave.mjs';
import { buildWorkItem } from '../lib/dispatch/adsp-adapter.mjs';

// --- fixtures (fabric flag on via state.dispatch.fabric — the strangler phase flag) --------

const state = () => ({
  dispatch: { fabric: true },
  tasks: [
    { id: 1, wave: 0, status: 'pending', files: ['src/app.js'] },
  ],
});
const planIndex = () => ({
  schema_version: '6.0',
  tasks: [
    { id: 1, description: 'Tighten the parser bounds', files: ['src/app.js'], verify_commands: ['node --test'], codex: null },
  ],
});
const allowlist = { app: { scope: ['src/**'] } };
const qctlOn = { implementer: { qctl: { enabled: true } } };
const QCTL_BACKEND = { kind: 'qctl', scope: ['src/app.js'], verify: ['node --test'], deliver: 'patch' };
const dispatchInputs = { runId: 'run-x', head: 'abc', dirtyDigest: '', policyVersion: 'p1', workerVersion: 'w1' };

// The fabric payload → work-item bridge (what the dispatch-wave consumer hands buildWorkItem).
const workTaskFor = (t) => ({
  task_id: t.id,
  description: t.description,
  files: t.files,
  verify_commands: t.verify_commands,
  cwd: '/repo/.worktrees/run',
  class: t.class,
  run_id: 'run-x',
  inputs: { head: 'abc', dirtyDigest: '', policyVersion: 'p1', workerVersion: 'w1' },
  backend: t.backend,
});

// --- flag ON: eligibility exercised from the fabric entrance -------------------------------

test('fabric + qctl flag-on + eligible → payload carries the {kind:qctl} backend discriminator', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, qctlOn, {}, allowlist);
  assert.deepEqual(tasks[0].backend, QCTL_BACKEND);
  // Class-only fabric routing is otherwise unchanged — the broker still picks the model.
  assert.equal(tasks[0].class, 'masterplan-implementation');
});

test('fabric + flag-on + sensitive task → qctlEligible rejects: downgrade to agent, field OMITTED', () => {
  const pidx = planIndex();
  pidx.tasks[0].sensitive = true;
  const { tasks } = prepareWave(state(), pidx, 0, qctlOn, {}, allowlist);
  assert.equal('backend' in tasks[0], false, 'ineligible → no backend key at all');
});

test('fabric + flag-on + no allowlist → fail-closed downgrade (field OMITTED)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, qctlOn, {});
  assert.equal('backend' in tasks[0], false);
});

test('fabric + flag-on + file outside allowlist scope → downgrade (field OMITTED)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, qctlOn, {}, { app: { scope: ['other/**'] } });
  assert.equal('backend' in tasks[0], false);
});

test('fabric + flag-on + infra path → hard override even when the allowlist covers it', () => {
  const st = state();
  st.tasks[0].files = ['ops/systemd/foo.conf'];
  const pidx = planIndex();
  pidx.tasks[0].files = ['ops/systemd/foo.conf'];
  const { tasks } = prepareWave(st, pidx, 0, qctlOn, {}, { ops: { scope: ['ops/**'] } });
  assert.equal('backend' in tasks[0], false, 'infra paths are NEVER qctl-eligible');
});

// --- flag OFF (the shipped default): qctl is never selected --------------------------------

test('NEGATIVE — shipped flag-off default never selects qctl: byte-identical lean fabric payload', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {}, allowlist);
  assert.equal('backend' in tasks[0], false);
  // The exact pre-seam lean payload keys — nothing new leaks in when the flag is off.
  assert.deepEqual(
    Object.keys(tasks[0]).sort(),
    ['class', 'description', 'files', 'id', 'verify_commands'],
  );
});

test('NEGATIVE — a truthy STRING flag does not arm the seam (strictly-true gate)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { implementer: { qctl: { enabled: 'true' } } }, {}, allowlist);
  assert.equal('backend' in tasks[0], false);
});

// --- hash stability by construction (the adsp-idempotency contract) ------------------------

test('arming qctl does NOT change handoff keys (backend is never hashed)', () => {
  const off = prepareWave(state(), planIndex(), 0, {}, {}, allowlist, dispatchInputs);
  const on = prepareWave(state(), planIndex(), 0, qctlOn, {}, allowlist, dispatchInputs);
  assert.deepEqual(on.tasks[0].backend, QCTL_BACKEND, 'seam armed on the flag-on side');
  assert.equal('backend' in off.tasks[0], false, 'seam dormant on the flag-off side');
  assert.equal(on.tasks[0].idempotency.task_spec_hash, off.tasks[0].idempotency.task_spec_hash);
  assert.equal(on.tasks[0].idempotency.handoff_key, off.tasks[0].idempotency.handoff_key);
});

// --- the work-item discriminator (fabric payload → adsp descriptor) ------------------------

test('buildWorkItem: the fabric payload backend rides the adsp descriptor', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, qctlOn, {}, allowlist);
  const descriptor = buildWorkItem(workTaskFor(tasks[0]));
  assert.deepEqual(descriptor.backend, QCTL_BACKEND);
});

test('buildWorkItem: backend is descriptor-only — toggling it never changes the handoff key', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, qctlOn, {}, allowlist);
  const withBackend = buildWorkItem(workTaskFor(tasks[0]));
  const plain = buildWorkItem({ ...workTaskFor(tasks[0]), backend: undefined });
  assert.equal('backend' in plain, false, 'absent → no descriptor field');
  assert.equal(withBackend.handoff_key, plain.handoff_key, 'backend is excluded from the task-spec hash (like review/task/branch)');
});

test('buildWorkItem: {kind:agent} (the default) is OMITTED — never sent on the wire', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, qctlOn, {}, allowlist);
  const withAgent = buildWorkItem({ ...workTaskFor(tasks[0]), backend: { kind: 'agent' } });
  assert.equal('backend' in withAgent, false);
  // Byte-identical to the no-backend descriptor — stability by construction.
  assert.deepEqual(withAgent, buildWorkItem({ ...workTaskFor(tasks[0]), backend: undefined }));
});
