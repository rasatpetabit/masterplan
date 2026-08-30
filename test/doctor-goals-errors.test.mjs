// test/doctor-goals-errors.test.mjs — E12 regression guard: a goals-enabled bundle with
// malformed state / events / plan-index / goals.md must be EXPLICITLY DIAGNOSED, never
// silently dropped behind a broad catch. Before E12 (lib/doctor/goals.mjs), a corrupt
// state.yml vanished the bundle from the ERROR-severity audit (parse failure -> continue;
// broad per-bundle catch -> skip) and could even leave a false green PASS.
//
// The four fixtures under test/fixtures/doctor/goals/warn-malformed-* carry one malformed
// surface each and must each surface the matching diagnosis at WARN (fail-closed, not ERROR:
// the bundle IS still surfaced, so the worst-case audit outcome is a diagnosis the operator
// can act on — a silent drop would be the defect). The dir-prefix contract (expected worst
// severity) is the same as the other doctor checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check as goals } from '../lib/doctor/goals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures', 'doctor', 'goals');

const RANK = { SKIP: 0, PASS: 1, WARN: 2, ERROR: 3 };
const PREFIX = { skip: 'SKIP', pass: 'PASS', warn: 'WARN', error: 'ERROR' };
const maxSeverity = (findings) =>
  findings.reduce((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'SKIP');

const MALFORMED_FIXTURES = [
  {
    scenario: 'warn-malformed-state',
    expectSummary: /state\.yml is malformed or unreadable \(missing slug\)/,
  },
  {
    scenario: 'warn-malformed-events',
    expectSummary: /events\.jsonl contains 1 unparseable line/,
  },
  {
    scenario: 'warn-malformed-plan-index',
    expectSummary: /plan\.index\.json is unparseable — post-plan amendment/,
  },
  {
    scenario: 'warn-malformed-goals',
    expectSummary: /goals\.md hash does not match the frozen goals hash/,
  },
];

test('E12: malformed-state fixture is explicitly diagnosed (never silently dropped)', () => {
  const findings = goals(path.join(FX, 'warn-malformed-state'));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.ok(
    findings.some((f) => /malformed-state/.test(f.summary) && /missing slug/.test(f.summary)),
    'bundle is named and the missing-slug diagnosis is present',
  );
  assert.ok(!findings.some((f) => f.severity === 'ERROR'), 'state malformation is WARN, not a false ERROR');
});

test('E12: malformed-events fixture is explicitly diagnosed (dropped lines surfaced)', () => {
  const findings = goals(path.join(FX, 'warn-malformed-events'));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.ok(
    findings.some((f) => /events\.jsonl contains 1 unparseable line/.test(f.summary)),
    'unparseable event lines are counted and surfaced',
  );
});

test('E12: malformed-plan-index fixture is explicitly diagnosed (post-amendment)', () => {
  const findings = goals(path.join(FX, 'warn-malformed-plan-index'));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.ok(
    findings.some((f) => /plan\.index\.json is unparseable/.test(f.summary)),
    'the post-amendment uncovered-goal check cannot silently skip on a malformed index',
  );
});

test('E12: malformed-goals fixture is explicitly diagnosed (hash-mismatch path)', () => {
  const findings = goals(path.join(FX, 'warn-malformed-goals'));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.ok(
    findings.some((f) => /goals\.md hash does not match the frozen goals hash/.test(f.summary)),
    'an unparseable goals.md still produces the hash-mismatch diagnosis',
  );
});

test('E12: all malformed fixtures match their dir-prefix severity (driver contract)', async (t) => {
  for (const { scenario } of MALFORMED_FIXTURES) {
    await t.test(scenario, () => {
      const findings = goals(path.join(FX, scenario));
      assert.ok(Array.isArray(findings) && findings.length >= 1, 'returns >= 1 finding');
      for (const f of findings) {
        assert.ok(['PASS', 'WARN', 'ERROR', 'SKIP'].includes(f.severity));
        assert.equal(typeof f.summary, 'string');
        assert.ok('id' in f && 'fix' in f, 'finding has id + fix');
      }
      assert.equal(maxSeverity(findings), PREFIX[scenario.split('-')[0]], JSON.stringify(findings));
    });
  }
});
