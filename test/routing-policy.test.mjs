// test/routing-policy.test.mjs — repo-local routing policy resolver.
//
// The fleet's retired dispatch control plane no longer resolves routing; masterplan resolves work
// classes against policy/workflow-map.json (checked-in canonical copy of the
// fleet workflow routing map) when no delivered map is present. These tests are
// hermetic: the repo copy is named explicitly, fixtures are injected, and the default
// path is resolved against a fake home — never this host's delivered map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverDispatchMap, resolveUsecase, resolvePhase } from '../lib/dispatch/routing-policy.mjs';
import * as routing from '../lib/dispatch/routing-policy.mjs';

const dispatchFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/dispatch-map.json', import.meta.url), 'utf8'));
const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const mapOptions = { env: {}, homeDir: '/fixture', readFile: absent };

test('C1 discovery distinguishes host defaults, explicit missing and broken maps', () => {
  assert.deepEqual(discoverDispatchMap({ ...mapOptions, host: 'claude-code' }),
    { status: 'unconfigured', path: null, schema: null, policy: null });
  assert.deepEqual(discoverDispatchMap({ ...mapOptions, host: 'codex' }),
    { status: 'unconfigured', path: null, schema: null, policy: null });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'pi' }), { code: 'PI_MAP_MISSING', path: '/fixture/.pi/workflows/dispatch-map.json' });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'codex', env: { MP_DISPATCH_MAP: '/explicit' } }),
    { code: 'EXPLICIT_MAP_MISSING', path: '/explicit' });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'pi', env: { MP_DISPATCH_MAP: '' } }), { code: 'MAP_PATH' });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'codex', env: { MP_DISPATCH_MAP: 42 } }), { code: 'MAP_PATH' });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'codex', readFile: () => '{' }), { code: 'MAP_JSON' });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'codex', readFile: () => '{"schema":2}' }), { code: 'MAP_SCHEMA' });
  assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'pi', readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), { code: 'MAP_UNREADABLE' });
});

test('C1 reads every host without inspecting models and resolves own-property intent only', () => {
  const fixture = { ...dispatchFixture, get lists() { throw new Error('inspected models'); } };
  for (const host of ['pi', 'claude-code', 'codex']) {
    const result = discoverDispatchMap({ ...mapOptions, host, readFile: () => JSON.stringify(dispatchFixture) });
    assert.equal(result.status, 'configured');
    assert.equal(result.path, '/fixture/.pi/workflows/dispatch-map.json');
    assert.equal(result.schema, 1);
    assert.equal(Object.hasOwn(result.policy, 'lists'), false);
    assert.deepEqual(resolveUsecase(undefined, result), {
      usecase: 'iterate', agent: 'builder', requestedEffort: 'low',
      vocabulary: { class: 'iterate', role: 'builder', lane: 'pro' },
    });
    assert.equal(resolvePhase('implement', result).usecase, 'bounded-edit');
  }
  const parsed = discoverDispatchMap({ ...mapOptions, host: 'pi', readFile: () => fixture });
  assert.equal(parsed.policy.defaultUsecase, 'iterate');
  assert.equal(Object.hasOwn(parsed.policy, 'lists'), false);
  for (const name of ['unknown', 'toString', '__proto__']) {
    assert.throws(() => resolveUsecase(name, parsed), /unknown use case/);
    assert.throws(() => resolvePhase(name, parsed), /unknown phase/);
  }
  // An ordinary JSON-parsed policy has a normal prototype, so an inherited name
  // like `toString` must still refuse (discovery's null-prototype tables hide this).
  const plainPolicy = JSON.parse(JSON.stringify(dispatchFixture));
  for (const name of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.throws(() => resolveUsecase(name, { policy: plainPolicy }), /unknown use case/);
    assert.throws(() => resolvePhase(name, { policy: plainPolicy }), /unknown phase/);
  }
  for (const broken of [
    { ...dispatchFixture, defaultUsecase: 'missing' },
    { ...dispatchFixture, usecases: { ...dispatchFixture.usecases, 'bounded-edit': { ...dispatchFixture.usecases['bounded-edit'], agent: 'judge' } } },
    { ...dispatchFixture, phases: { ...dispatchFixture.phases, implement: 'missing' } },
    { ...dispatchFixture, phases: { ...dispatchFixture.phases, implement: 'toString' } },
    { ...dispatchFixture, agents: { ...dispatchFixture.agents, builder: { defaultUsecase: 'toString' } } },
    { ...dispatchFixture, agents: { ...dispatchFixture.agents, builder: { defaultUsecase: 'missing' } } },
  ]) assert.throws(() => discoverDispatchMap({ ...mapOptions, host: 'pi', readFile: () => JSON.stringify(broken) }), { code: 'MAP_INVALID' });
});

test('C1 same-path replacement reads fresh bytes even with unchanged timestamps', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dispatch-'));
  try {
    const file = path.join(home, '.pi', 'workflows', 'dispatch-map.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = JSON.stringify(dispatchFixture);
    fs.writeFileSync(file, first);
    const opts = { host: 'pi', env: {}, homeDir: home };
    assert.equal(resolvePhase('implement', discoverDispatchMap(opts)).agent, 'builder');
    const stamped = fs.statSync(file);
    const next = { ...dispatchFixture, phases: { ...dispatchFixture.phases, implement: 'plan' } };
    fs.writeFileSync(`${file}.new`, JSON.stringify(next));
    fs.utimesSync(`${file}.new`, stamped.atime, stamped.mtime);
    fs.renameSync(`${file}.new`, file);
    assert.equal(resolvePhase('implement', discoverDispatchMap(opts)).agent, 'judge');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('legacy routing export surface and package authority are retired atomically', () => {
  for (const name of ['REPO_POLICY_PATH', 'resolvePanel', 'resolveLane', 'laneAliasMap', 'adversaryFallbackReviewers', 'loadRoutingPolicy', 'resolveWorkClass', 'defaultRoutingPolicyPath', 'deliveredPolicyPath'])
    assert.equal(Object.hasOwn(routing, name), false, name);
  assert.equal(fs.existsSync(new URL('../policy/workflow-map.json', import.meta.url)), false);
});
test('MP_ROUTING_POLICY refuses with migration diagnostic, never aliases C1', () => {
  for (const value of ['', '/synthetic/private-path']) assert.throws(() => discoverDispatchMap({ ...mapOptions,
    env: { MP_ROUTING_POLICY: value, MP_DISPATCH_MAP: '/c1' }, readFile: () => dispatchFixture }), error =>
      error.code === 'RETIRED_ROUTING_POLICY' && /unset it.*MP_DISPATCH_MAP/.test(error.message) && !error.message.includes(value || 'synthetic-private-value'));
});
