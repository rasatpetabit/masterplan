// test/routing-policy.test.mjs — repo-local routing policy resolver.
//
// The fleet's agent-dispatch control plane is retired; masterplan resolves work
// classes against policy/workflow-map.json (checked-in canonical copy of the
// fleet workflow routing map). These tests are hermetic: repo copy + injected
// fixtures, never a host path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPO_POLICY_PATH,
  loadRoutingPolicy,
  resolveWorkClass,
  resolveLane,
  resolvePanel,
  laneAliasMap,
} from '../lib/dispatch/routing-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repo-local canonical policy is checked in and structurally complete', () => {
  assert.equal(REPO_POLICY_PATH, path.join(REPO_ROOT, 'policy', 'workflow-map.json'));
  const policy = loadRoutingPolicy();
  for (const section of ['lanes', 'classes', 'agents', 'tiers', 'panels', 'phases']) {
    assert.ok(policy[section] && typeof policy[section] === 'object', `missing ${section}`);
  }
  // Every class resolves to an existing agent + lane with a model ref.
  for (const [name, c] of Object.entries(policy.classes)) {
    assert.ok(policy.agents[c.agent], `class ${name}: unknown agent ${c.agent}`);
    assert.ok(policy.lanes[c.lane]?.model, `class ${name}: lane ${c.lane} has no model`);
  }
});

test('resolveWorkClass returns the governed record for a known class', () => {
  const r = resolveWorkClass('adversary');
  assert.equal(r.agent, 'breaker');
  assert.equal(r.lane, 'frontier');
  assert.equal(r.cap, 'review');
  assert.equal(r.effort, 'xhigh');
  assert.equal(r.panel, 'adversarial');
  assert.equal(r.writes, false);
  assert.match(r.model, /^litellm\//);
  assert.ok(Array.isArray(r.chain) && r.chain.length >= 1);
});

test('resolveWorkClass covers the masterplan work types', () => {
  // The classes masterplan waves actually dispatch, resolved from the repo policy.
  for (const cls of ['bounded-edit', 'agentic-loop', 'planned-execution', 'deep-investigation', 'graph-execution', 'critic']) {
    const r = resolveWorkClass(cls);
    assert.equal(r.class, cls);
    assert.match(r.model, /^litellm\//);
  }
});

test('unknown class falls back to the policy defaultClass, never a guess', () => {
  const r = resolveWorkClass('no-such-class');
  assert.notEqual(r.class, 'no-such-class');
  assert.match(r.model, /^litellm\//);
});

test('resolveLane and resolvePanel expose lane refs and panel quorums', () => {
  const frontier = resolveLane('frontier');
  assert.match(frontier.model, /^litellm\//);
  const panel = resolvePanel('adversarial');
  assert.ok(panel.members.length >= 2);
  assert.ok(Number(panel.quorum) >= 2);
  const families = new Set(panel.members.map((m) => m.model));
  assert.equal(families.size, panel.members.length, 'panel members are distinct models');
});

test('laneAliasMap derives every alias from the policy (no hard-coded ids)', () => {
  const map = laneAliasMap();
  const policy = loadRoutingPolicy();
  assert.deepEqual(Object.keys(map).sort(), Object.keys(policy.lanes).sort());
  for (const model of Object.values(map)) assert.match(model, /^litellm\//);
});

test('fail-closed: unreadable path, invalid JSON, missing sections, unresolvable class', () => {
  assert.throws(() => loadRoutingPolicy({ policyPath: '/nonexistent/policy.json' }), /unreadable/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-policy-'));
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.throws(() => loadRoutingPolicy({ policyPath: bad }), /not valid JSON/);

  const empty = path.join(tmp, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ lanes: {} }));
  assert.throws(() => loadRoutingPolicy({ policyPath: empty }), /missing the classes section/);

  const noDefault = path.join(tmp, 'nodefault.json');
  fs.writeFileSync(noDefault, JSON.stringify({
    lanes: { l: { model: 'litellm/x' } },
    classes: {},
    agents: {},
    tiers: {},
    workflow: {},
  }));
  assert.throws(() => resolveWorkClass('anything', { policyPath: noDefault }), /unknown work class/);
});

test('MP_ROUTING_POLICY override is honored when present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-policy-'));
  const override = path.join(tmp, 'override.json');
  fs.writeFileSync(override, JSON.stringify({
    lanes: { only: { model: 'litellm/override-model' } },
    classes: { work: { agent: 'a', lane: 'only', cap: 'chat', effort: 'low' } },
    agents: { a: { tier: 'small', writes: false } },
    tiers: { small: { lane: 'only' } },
    workflow: {},
  }));
  const prev = process.env.MP_ROUTING_POLICY;
  process.env.MP_ROUTING_POLICY = override;
  try {
    const r = resolveWorkClass('work');
    assert.equal(r.model, 'litellm/override-model');
  } finally {
    if (prev === undefined) delete process.env.MP_ROUTING_POLICY;
    else process.env.MP_ROUTING_POLICY = prev;
  }
});
