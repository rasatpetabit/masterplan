// test/dispatch.test.mjs — the consolidated agent-dispatch module (lib/dispatch/).
// routing/host/backend behavior keeps its full truth tables in routing.test.mjs,
// codex-host.test.mjs, and wave.test.mjs (qctlEligible); THIS file pins what is new at the
// consolidation: the index facade's export surface, the resolveTaskBackend gate composition,
// and the ops.mjs dispatch-vehicle fork extracted from lib/continue.mjs — the op shapes are
// a wire contract with the shell (§2 op table) and must never drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dispatch from '../lib/dispatch/index.mjs';
import { resolveTaskBackend, normalizeReviewMode, buildWaveDispatchOp } from '../lib/dispatch/index.mjs';

test('index facade: the unified dispatch surface is complete', () => {
  for (const name of [
    'routeTask', 'resolveImplementerBackend',         // routing.mjs
    'qctlEligible', 'resolveTaskBackend',             // backend.mjs
    'detectHost', 'normalizeResumeHint',              // host.mjs
    'normalizeReviewMode', 'buildWaveDispatchOp',     // ops.mjs
  ]) {
    assert.equal(typeof dispatch[name], 'function', `missing export: ${name}`);
  }
  assert.equal(typeof dispatch.CODEX_ENTRYPOINT, 'string');
});

// ---- resolveTaskBackend: the eligibility-gated descriptor (previously wave.mjs-private) ----

const qctlTask = {
  files: ['src/app.js'],
  verify_commands: ['npm test'],
};
const allowlist = { app: { scope: ['src/**'] } };
const qctlOn = { implementer: { qctl: { enabled: true } } };

test('resolveTaskBackend: flag off/absent -> {kind:agent}, allowlist never consulted', () => {
  assert.deepEqual(resolveTaskBackend(qctlTask, {}, {}), { kind: 'agent' });
  assert.deepEqual(resolveTaskBackend(qctlTask, { implementer: { qctl: { enabled: 'true' } } }, {}, allowlist),
    { kind: 'agent' }); // strictly true only — a truthy string does not arm the backend
});

test('resolveTaskBackend: flag on + eligible -> qctl descriptor with task-intrinsic fields', () => {
  assert.deepEqual(resolveTaskBackend(qctlTask, qctlOn, {}, allowlist), {
    kind: 'qctl', scope: ['src/app.js'], verify: ['npm test'], deliver: 'patch',
  });
});

test('resolveTaskBackend: flag on + ineligible -> downgrades to {kind:agent} (fail-closed)', () => {
  // No allowlist at all → qctlEligible fail-closes.
  assert.deepEqual(resolveTaskBackend(qctlTask, qctlOn, {}), { kind: 'agent' });
  // Sensitive task → ineligible even when in scope.
  assert.deepEqual(resolveTaskBackend({ ...qctlTask, sensitive: true }, qctlOn, {}, allowlist), { kind: 'agent' });
});

// ---- ops.mjs: the dispatch-vehicle fork (wire contract with the shell's op table) ----

test('normalizeReviewMode: true/"on"/"true" -> on; everything else -> off', () => {
  assert.equal(normalizeReviewMode(true), 'on');
  assert.equal(normalizeReviewMode('on'), 'on');
  assert.equal(normalizeReviewMode('true'), 'on');
  for (const raw of [false, 'off', 'false', undefined, null, 1, 'yes']) {
    assert.equal(normalizeReviewMode(raw), 'off', `expected off for ${JSON.stringify(raw)}`);
  }
});

const waveArgs = {
  wave: 2,
  cwd: '/repo/.worktrees/slug',
  tasks: [{ id: 1, target: 'inline' }],
  baseline: ['a.js'],
  review: 'on',
};

test('buildWaveDispatchOp: default path -> launch_workflow execute with promote-active-run', () => {
  assert.deepEqual(buildWaveDispatchOp(waveArgs), {
    op: 'launch_workflow',
    workflow: 'execute',
    cwd: '/repo/.worktrees/slug',
    args: { wave: 2, tasks: waveArgs.tasks, baseline: ['a.js'], repoRoot: '/repo/.worktrees/slug', review: 'on' },
    next: 'promote-active-run',
  });
});

test('buildWaveDispatchOp: codexSuppressed -> dispatch_foreground with record-result', () => {
  assert.deepEqual(buildWaveDispatchOp({ ...waveArgs, codexSuppressed: true }), {
    op: 'dispatch_foreground',
    wave: 2,
    cwd: '/repo/.worktrees/slug',
    tasks: waveArgs.tasks,
    baseline: ['a.js'],
    review: 'on',
    next: 'record-result',
  });
});

test('buildWaveDispatchOp: fabric flag -> single dispatch_fabric op (supersedes the launch_workflow/foreground fork)', () => {
  assert.deepEqual(buildWaveDispatchOp({ ...waveArgs, fabric: true }), {
    op: 'dispatch_fabric',
    wave: 2,
    cwd: '/repo/.worktrees/slug',
    tasks: waveArgs.tasks,
    baseline: ['a.js'],
    review: 'on',
    next: 'record-result',
  });
});

test('buildWaveDispatchOp: fabric flag wins even under codexSuppressed (the fork collapses to one op)', () => {
  assert.deepEqual(buildWaveDispatchOp({ ...waveArgs, fabric: true, codexSuppressed: true }), {
    op: 'dispatch_fabric',
    wave: 2,
    cwd: '/repo/.worktrees/slug',
    tasks: waveArgs.tasks,
    baseline: ['a.js'],
    review: 'on',
    next: 'record-result',
  });
});
