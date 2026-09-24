// Host-local lane overrides for bin/register-pi-agents.mjs.
//
// The mechanism exists because a lane can be unusable on one host while remaining
// correct fleet-wide, and the only prior workaround was hand-editing the generated
// files under ~/.pi/agent/agents — which `install-pi.mjs --check` reports as drift
// and the next install erases.
//
// The property that matters most here is the LAST one: every exported seam defaults
// to no overrides, so this suite is deterministic and cannot pass or fail depending
// on the state of whichever machine runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODEL_MAP,
  loadLaneOverrides,
  effectiveModel,
  reportLaneOverrides,
  runRegister,
} from '../bin/register-pi-agents.mjs';

const LANE = Object.keys(MODEL_MAP)[0];
const POLICY_MODEL = MODEL_MAP[LANE];

function tmp() {
  return mkdtempSync(join(tmpdir(), 'lane-overrides-'));
}

function writeOverride(dir, obj) {
  const p = join(dir, 'lane-overrides.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

const VALID = (model = 'litellm/some-healthy-lane') => ({
  overrides: {
    [LANE]: {
      model,
      reason: 'the policy lane is unusable on this host',
      decided_by: 'operator',
      recorded_at: '2026-09-22T00:00:00.000Z',
    },
  },
});

test('a missing override file is not an error and means no overrides', () => {
  const d = tmp();
  assert.deepEqual(loadLaneOverrides(join(d, 'does-not-exist.json')), {});
  rmSync(d, { recursive: true, force: true });
});

test('an empty overrides object is accepted', () => {
  const d = tmp();
  const p = writeOverride(d, { overrides: {} });
  assert.deepEqual(loadLaneOverrides(p), {});
  rmSync(d, { recursive: true, force: true });
});

test('a file with no overrides key is accepted', () => {
  const d = tmp();
  const p = writeOverride(d, {});
  assert.deepEqual(loadLaneOverrides(p), {});
  rmSync(d, { recursive: true, force: true });
});

test('malformed JSON fails loudly and names the path', () => {
  const d = tmp();
  const p = writeOverride(d, '{ this is not json');
  assert.throws(() => loadLaneOverrides(p), (e) => {
    assert.match(e.message, /is not valid JSON/);
    assert.ok(e.message.includes(p), 'the message must name the offending file');
    assert.match(e.message, /refusing rather than ignoring/);
    return true;
  });
  rmSync(d, { recursive: true, force: true });
});

test('an override naming a lane the policy does not declare fails closed', () => {
  const d = tmp();
  const p = writeOverride(d, {
    overrides: { 'no-such-lane': { model: 'litellm/x', reason: 'r', decided_by: 'o' } },
  });
  assert.throws(() => loadLaneOverrides(p), (e) => {
    assert.match(e.message, /which the routing policy does not declare/);
    assert.ok(e.message.includes('no-such-lane'));
    return true;
  });
  rmSync(d, { recursive: true, force: true });
});

test('a missing reason or decided_by fails: an anonymous pin is what this replaces', () => {
  const d = tmp();
  for (const bad of [
    { overrides: { [LANE]: { model: 'litellm/x', decided_by: 'o' } } },
    { overrides: { [LANE]: { model: 'litellm/x', reason: 'r' } } },
    { overrides: { [LANE]: { model: 'litellm/x', reason: '   ', decided_by: 'o' } } },
    { overrides: { [LANE]: { model: '', reason: 'r', decided_by: 'o' } } },
  ]) {
    const p = writeOverride(d, bad);
    assert.throws(() => loadLaneOverrides(p), /missing a non-empty/, JSON.stringify(bad));
  }
  rmSync(d, { recursive: true, force: true });
});

test('overrides must be an object keyed by lane, not an array', () => {
  const d = tmp();
  const p = writeOverride(d, { overrides: [{ lane: LANE }] });
  assert.throws(() => loadLaneOverrides(p), /must be an object keyed by lane name/);
  rmSync(d, { recursive: true, force: true });
});

test('a valid file loads and effectiveModel resolves through it', () => {
  const d = tmp();
  const p = writeOverride(d, VALID('litellm/override-target'));
  const o = loadLaneOverrides(p);
  assert.equal(effectiveModel(LANE, o), 'litellm/override-target');
  // a lane with no override still resolves from the policy
  const other = Object.keys(MODEL_MAP).find((k) => k !== LANE);
  if (other) assert.equal(effectiveModel(other, o), MODEL_MAP[other]);
  rmSync(d, { recursive: true, force: true });
});

test('MODEL_MAP itself is never mutated by an override', () => {
  const d = tmp();
  const p = writeOverride(d, VALID('litellm/override-target'));
  loadLaneOverrides(p);
  effectiveModel(LANE, loadLaneOverrides(p));
  assert.equal(MODEL_MAP[LANE], POLICY_MODEL, 'the policy mirror must stay exact');
  rmSync(d, { recursive: true, force: true });
});

test('reportLaneOverrides reports each override and returns the count', () => {
  const d = tmp();
  const p = writeOverride(d, VALID('litellm/override-target'));
  const o = loadLaneOverrides(p);
  const seen = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { seen.push(String(s)); return true; };
  try {
    assert.equal(reportLaneOverrides(o), 1);
  } finally {
    process.stderr.write = orig;
  }
  const line = seen.join('');
  assert.ok(line.includes(LANE), 'names the lane');
  assert.ok(line.includes(POLICY_MODEL), 'names the model it would otherwise resolve to');
  assert.ok(line.includes('litellm/override-target'), 'names the override target');
  assert.ok(line.includes('operator'), 'names who decided');
  assert.ok(line.includes('unusable on this host'), 'carries the reason');
  // The override no longer changes what is emitted, and a log line that read as if it
  // did is the misreading this mechanism exists to prevent.
  assert.match(line, /no model hint is emitted/, 'must say the override does not change routing');
  rmSync(d, { recursive: true, force: true });
});

// --- registration end to end ----------------------------------------------

function fakeAgents(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'mp-fake.md'),
    `---\nname: mp-fake\nmodel: ${LANE}\n---\n\nbody\n`,
  );
  return dir;
}

test('runRegister emits no model hint, still reports the override, and check mode reports no drift', () => {
  const d = tmp();
  const agents = fakeAgents(join(d, 'agents'));
  const target = join(d, 'target');
  const o = loadLaneOverrides(writeOverride(d, VALID('litellm/override-target')));

  const orig = process.stderr.write;
  const seen = [];
  process.stderr.write = (s) => { seen.push(String(s)); return true; };
  let w, c;
  try {
    w = runRegister({ agentsDir: agents, targetDir: target, check: false, laneOverrides: o });
    c = runRegister({ agentsDir: agents, targetDir: target, check: true, laneOverrides: o });
  } finally {
    process.stderr.write = orig;
  }

  const registered = readFileSync(join(target, 'mp-fake.md'), 'utf8');
  // No emitted ref is safe for every preset: Pi validates a frontmatter `model:`
  // against the PRESET's class chain and refuses the spawn when it is outside it,
  // which an override target outside that chain would be. The registered copy
  // therefore carries no hint and the preset's class policy routes the child.
  assert.ok(!/^model:/m.test(registered), `registered agent must carry no model: hint:\n${registered}`);
  assert.equal(w.written, 1);
  // The override still reaches the log, so a host-local pin stays visible in every
  // install rather than becoming a silently ignored file.
  assert.ok(
    seen.join('').includes('litellm/override-target'),
    `the override target must still be reported on stderr: ${seen.join('')}`,
  );
  // The assertion that matters: with the override loaded on BOTH paths, a host
  // that overrides a lane is not permanently reported as drift.
  assert.equal(c.drift, 0, `check mode must agree with what write mode produced: ${c.report.join('; ')}`);
  rmSync(d, { recursive: true, force: true });
});

test('DEFAULTS ARE PURE: with no laneOverrides the registered copy carries no hint, whatever the host has', () => {
  const d = tmp();
  const agents = fakeAgents(join(d, 'agents'));
  const target = join(d, 'target');
  // A host override file exists here, but it is not passed in — the seam must not
  // reach for it implicitly, or this suite would depend on the machine running it.
  writeOverride(d, VALID('litellm/override-target'));

  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    runRegister({ agentsDir: agents, targetDir: target, check: false });
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(!/^model:/m.test(readFileSync(join(target, 'mp-fake.md'), 'utf8')), 'no model hint may be emitted');
  // The policy mirror is still what a lane resolves to for validation/reporting.
  assert.equal(effectiveModel(LANE), POLICY_MODEL);
  assert.equal(reportLaneOverrides(), 0);
  rmSync(d, { recursive: true, force: true });
});
