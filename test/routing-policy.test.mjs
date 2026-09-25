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

import {
  REPO_POLICY_PATH,
  defaultRoutingPolicyPath,
  deliveredPolicyPath,
  loadRoutingPolicy,
  resolveWorkClass,
  resolveLane,
  resolvePanel,
  laneAliasMap,
  adversaryFallbackReviewers,
} from '../lib/dispatch/routing-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repo-local canonical policy is checked in and structurally complete', () => {
  assert.equal(REPO_POLICY_PATH, path.join(REPO_ROOT, 'policy', 'workflow-map.json'));
  const policy = loadRoutingPolicy({ policyPath: REPO_POLICY_PATH });
  for (const section of ['lanes', 'classes', 'agents', 'panels', 'phases']) {
    assert.ok(policy[section] && typeof policy[section] === 'object', `missing ${section}`);
  }
  // Every class resolves to an existing agent + lane with a model ref.
  for (const [name, c] of Object.entries(policy.classes)) {
    assert.ok(policy.agents[c.agent], `class ${name}: unknown agent ${c.agent}`);
    assert.ok(policy.lanes[c.lane]?.model, `class ${name}: lane ${c.lane} has no model`);
  }
});

test('resolveWorkClass returns the governed record for a known class', () => {
  // One policy load, injected — resolveWorkClass must consume this exact document,
  // not perform a second independent disk read.
  const policy = loadRoutingPolicy({ policyPath: REPO_POLICY_PATH });
  const r = resolveWorkClass('adversary', { policy });
  assert.equal(r.agent, 'breaker');
  assert.equal(r.lane, 'frontier');
  assert.equal(r.cap, 'review');
  // The effort VALUE is validated against the dispatch transport's vocabulary, not
  // against the policy field the resolver just read — a self-referential compare
  // would pass a typo'd effort straight into wave dispatch.
  const DISPATCH_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
  assert.ok(
    DISPATCH_EFFORTS.includes(r.effort),
    `adversary effort '${r.effort}' is outside the dispatch effort vocabulary`,
  );
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
  const r = resolveWorkClass('no-such-class', { policyPath: REPO_POLICY_PATH });
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
  const map = laneAliasMap({ policyPath: REPO_POLICY_PATH });
  const policy = loadRoutingPolicy({ policyPath: REPO_POLICY_PATH });
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

// R5-6: masterplan reads the policy the fleet delivers, so what it derives (fallback
// reviewers above all) is what Pi's spawn guard authorizes. MP_ROUTING_POLICY still
// wins; the checked-in copy is only the fallback for a host with no delivered map.
test('default policy path: MP_ROUTING_POLICY, then the delivered map, then the repo copy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-home-'));
  try {
    const delivered = deliveredPolicyPath(home);
    assert.equal(delivered, path.join(home, '.pi', 'workflows', 'workflow-map.json'));
    assert.equal(defaultRoutingPolicyPath({ env: {}, homeDir: home }), REPO_POLICY_PATH, 'no delivered map: the repo copy');
    fs.mkdirSync(path.dirname(delivered), { recursive: true });
    fs.writeFileSync(delivered, '{}');
    assert.equal(defaultRoutingPolicyPath({ env: {}, homeDir: home }), delivered, 'a delivered map wins over the repo copy');
    assert.equal(
      defaultRoutingPolicyPath({ env: { MP_ROUTING_POLICY: '/x/override.json' }, homeDir: home }),
      '/x/override.json',
      'MP_ROUTING_POLICY wins over both',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('with no override, resolution reads the delivered map under the real home', () => {
  // End to end through the shipped defaults: HOME points at a fake home holding a
  // loadable delivered map, MP_ROUTING_POLICY is unset, and no path is passed.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-home-'));
  const prior = { HOME: process.env.HOME, MP: process.env.MP_ROUTING_POLICY };
  try {
    const delivered = path.join(home, '.pi', 'workflows', 'workflow-map.json');
    fs.mkdirSync(path.dirname(delivered), { recursive: true });
    fs.writeFileSync(delivered, JSON.stringify({
      lanes: { only: { model: 'litellm/from-the-delivered-map' } },
      classes: { work: { agent: 'a', lane: 'only' } },
      agents: { a: { writes: false } },
      workflow: {},
    }));
    process.env.HOME = home;
    delete process.env.MP_ROUTING_POLICY;
    assert.equal(os.homedir(), home, 'precondition: os.homedir() follows HOME');
    assert.equal(resolveWorkClass('work').model, 'litellm/from-the-delivered-map');
  } finally {
    process.env.HOME = prior.HOME;
    if (prior.MP === undefined) delete process.env.MP_ROUTING_POLICY;
    else process.env.MP_ROUTING_POLICY = prior.MP;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a delivered policy without the retired tiers section loads', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-policy-'));
  try {
    const p = path.join(tmp, 'workflow-map.json');
    fs.writeFileSync(p, JSON.stringify({
      lanes: { only: { model: 'litellm/delivered-model' } },
      classes: { work: { agent: 'a', lane: 'only', cap: 'chat', effort: 'low' } },
      agents: { a: { writes: false, tier: 'small' } }, // an agent still naming a tier needs no tiers section
      workflow: {},
    }));
    const r = resolveWorkClass('work', { policyPath: p });
    assert.equal(r.model, 'litellm/delivered-model');
    assert.equal(r.tier, 'small');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

// ---- review-fallback: the finish-gate fallback reviewer list ------------------

// A synthetic policy fixture whose ids are chosen so the ORDER rules are the only way
// to produce the expected list (chain in policy order, primary excluded, duplicates
// collapsed on first occurrence). Panel members are declared by default precisely so a
// test can prove they are NOT consulted.
function fallbackFixturePolicy({ chain = [], panelMembers = [], panelName = 'adversarial', withPanel = true } = {}) {
  return {
    lanes: { frontier: { model: 'litellm/primary', ctx: 1000 } },
    agents: { breaker: { writes: false, tier: 'big' } },
    tiers: { big: {} },
    classes: {
      adversary: {
        agent: 'breaker',
        lane: 'frontier',
        model: 'litellm/primary',
        chain,
        ...(withPanel ? { panel: panelName } : {}),
      },
    },
    ...(withPanel ? { panels: { [panelName]: { members: panelMembers, quorum: 1 } } } : {}),
  };
}

test('adversaryFallbackReviewers: chain order, de-duplication, primary excluded, panel ignored', () => {
  const policy = fallbackFixturePolicy({
    chain: ['litellm/primary', 'litellm/chain-2', 'litellm/chain-3', 'litellm/chain-2'],
    panelMembers: [
      { lane: 'frontier', model: 'litellm/primary' },      // primary again — excluded
      { lane: 'broad', model: 'litellm/panel-1' },
      { lane: 'longform', model: 'litellm/chain-3' },       // already seen in the chain — dropped
    ],
  });
  const r = adversaryFallbackReviewers({ policy });
  assert.deepEqual(r.reviewers, ['litellm/chain-2', 'litellm/chain-3']);
  assert.equal(r.reason, null);
  assert.equal(r.primary, 'litellm/primary');
});

test('adversaryFallbackReviewers: a panel member is NEVER a fallback (outside the class chain)', () => {
  // The fallback reviewer is dispatched under the adversary class, and Pi's spawn
  // guard authorizes a model override only when it sits in that class's chain. A
  // panel member that is not in the chain would be a guaranteed refusal, so the
  // panel is never consulted — however many members it declares.
  const policy = fallbackFixturePolicy({
    chain: ['litellm/primary', 'litellm/chain-2'],
    panelMembers: [
      { lane: 'broad', model: 'litellm/panel-1' },
      { lane: 'longform', model: 'litellm/panel-2' },
      { lane: 'longform', model: 'litellm/panel-3' },
    ],
  });
  const r = adversaryFallbackReviewers({ policy });
  assert.deepEqual(r.reviewers, ['litellm/chain-2']);
  for (const m of ['litellm/panel-1', 'litellm/panel-2', 'litellm/panel-3']) {
    assert.ok(!r.reviewers.includes(m), `${m} is a panel member outside the class chain and must never be dispatched`);
  }
});

test('adversaryFallbackReviewers: no panel declared → the same chain-only fallback list', () => {
  const policy = fallbackFixturePolicy({ chain: ['litellm/primary', 'litellm/chain-2'], withPanel: false });
  const r = adversaryFallbackReviewers({ policy });
  assert.deepEqual(r.reviewers, ['litellm/chain-2']);
});

test('adversaryFallbackReviewers: nothing beyond the primary → empty list + recorded reason', () => {
  const policy = fallbackFixturePolicy({
    chain: ['litellm/primary'],
    panelMembers: [{ lane: 'frontier', model: 'litellm/primary' }],
  });
  const r = adversaryFallbackReviewers({ policy });
  assert.deepEqual(r.reviewers, []);
  assert.match(r.reason, /no fallback reviewers in the routing policy beyond the primary/);
});

test('adversaryFallbackReviewers: a missing/unreadable policy → empty list + the outage recorded, never a throw', () => {
  const missing = adversaryFallbackReviewers({ policyPath: path.join(os.tmpdir(), 'mp-no-such-policy.json') });
  assert.deepEqual(missing.reviewers, []);
  assert.match(missing.reason, /routing policy unavailable: /);
  assert.equal(missing.primary, null);
  // same fail-soft outcome for a policy that loads but has no adversary class at all
  const emptyPolicy = { lanes: {}, classes: {}, agents: {}, tiers: {} };
  const noClass = adversaryFallbackReviewers({ policy: emptyPolicy });
  assert.deepEqual(noClass.reviewers, []);
  assert.match(noClass.reason, /routing policy unavailable: /);
});

test('adversaryFallbackReviewers: MP_ROUTING_POLICY is honored (no separate parser)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-fallback-policy-'));
  try {
    const policyPath = path.join(dir, 'workflow-map.json');
    fs.writeFileSync(policyPath, JSON.stringify(fallbackFixturePolicy({
      chain: ['litellm/primary', 'litellm/env-chain'],
      panelMembers: [{ lane: 'broad', model: 'litellm/env-panel' }],
    })));
    const prior = process.env.MP_ROUTING_POLICY;
    try {
      process.env.MP_ROUTING_POLICY = policyPath;
      const r = adversaryFallbackReviewers();
      assert.deepEqual(r.reviewers, ['litellm/env-chain']);
    } finally {
      if (prior === undefined) delete process.env.MP_ROUTING_POLICY;
      else process.env.MP_ROUTING_POLICY = prior;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('adversaryFallbackReviewers: the real checked-in policy yields a usable fallback list', () => {
  // Derived from the live policy document, never a copied list of model ids: the
  // expectation is computed from the same policy the primary dispatches on.
  const policy = loadRoutingPolicy({ policyPath: REPO_POLICY_PATH });
  const adversary = resolveWorkClass('adversary', { policy });
  const r = adversaryFallbackReviewers({ policy });
  assert.equal(r.primary, adversary.model);
  assert.ok(r.reviewers.length >= 1, 'the checked-in policy should name at least one fallback reviewer');
  assert.ok(!r.reviewers.includes(adversary.model), 'the primary must never be its own fallback');
  // every entry is a model ref the adversary class chain declares — the panel is
  // never consulted, and a panel member outside the chain would be refused by the
  // spawn guard
  const declared = new Set(Array.isArray(adversary.chain) ? adversary.chain : []);
  for (const m of r.reviewers) assert.ok(declared.has(m), `${m} is not declared by the adversary class chain`);
  for (const member of policy.panels?.[adversary.panel]?.members ?? []) {
    if (declared.has(member.model)) continue;
    assert.ok(!r.reviewers.includes(member.model), `${member.model} is a panel-only member and must never be a fallback`);
  }
});
