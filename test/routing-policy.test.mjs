// test/routing-policy.test.mjs — repo-local routing policy resolver.
//
// The fleet's retired dispatch control plane no longer resolves routing; masterplan resolves work
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
  adversaryFallbackReviewers,
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
  // One policy load, injected — resolveWorkClass must consume this exact document,
  // not perform a second independent disk read.
  const policy = loadRoutingPolicy();
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

// ---- review-fallback: the finish-gate fallback reviewer list ------------------

// A synthetic policy fixture whose ids are chosen so the ORDER rules are the only way
// to produce the expected list (chain first in policy order, then panel members, primary
// excluded, duplicates collapsed on first occurrence).
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

test('adversaryFallbackReviewers: chain order, panel append, de-duplication, primary excluded', () => {
  const policy = fallbackFixturePolicy({
    chain: ['litellm/primary', 'litellm/chain-2', 'litellm/chain-3', 'litellm/chain-2'],
    panelMembers: [
      { lane: 'frontier', model: 'litellm/primary' },      // primary again — excluded
      { lane: 'broad', model: 'litellm/panel-1' },
      { lane: 'longform', model: 'litellm/chain-3' },       // already seen in the chain — dropped
    ],
  });
  const r = adversaryFallbackReviewers({ policy });
  assert.deepEqual(r.reviewers, ['litellm/chain-2', 'litellm/chain-3', 'litellm/panel-1']);
  assert.equal(r.reason, null);
  assert.equal(r.primary, 'litellm/primary');
});

test('adversaryFallbackReviewers: no panel declared → chain-only fallback list', () => {
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
      assert.deepEqual(r.reviewers, ['litellm/env-chain', 'litellm/env-panel']);
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
  const policy = loadRoutingPolicy();
  const adversary = resolveWorkClass('adversary', { policy });
  const r = adversaryFallbackReviewers({ policy });
  assert.equal(r.primary, adversary.model);
  assert.ok(r.reviewers.length >= 1, 'the checked-in policy should name at least one fallback reviewer');
  assert.ok(!r.reviewers.includes(adversary.model), 'the primary must never be its own fallback');
  // every entry is a model ref the policy itself declares (chain or panel member)
  const declared = new Set([
    ...(Array.isArray(adversary.chain) ? adversary.chain : []),
    ...(policy.panels?.[adversary.panel]?.members ?? []).map((m) => m.model),
  ]);
  for (const m of r.reviewers) assert.ok(declared.has(m), `${m} is not declared by the policy`);
});
