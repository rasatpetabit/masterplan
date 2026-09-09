// test/docs-contract.test.mjs — E5/E6/E7/E11 structural guard (fresh-eyes remediation).
// The shared internals docs must match the code:
//   E5 — no run-level stop_reason/critical_error/scheduled_yield contract (absent from lib/).
//   E6 — the recovery action is `recover_wave` (lib/continue.mjs case 'recover_wave'), never
//        the renamed `recover_and_redispatch`.
//   E7 — review is seeded ON by default (lib/bundle.mjs buildSeedState codexReview = true),
//        so docs must not claim "off by default".
//   E11 — the mp-implementer agent was deleted (c5bba82); internals docs must not name it.
//   §2d — fleet turn-end lives in /srv/workflows/policy/turn-end.md; the prompt points
//        there and lists only masterplan-specific durable gates plus the autoprogress hatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'docs/internals.md',
  'docs/internals/bundle-resume.md',
  'docs/internals/task-verification.md',
  'docs/internals/wave-dispatch.md',
];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('E5: no nonexistent run-level stop contract in internals docs', () => {
  const re = /stop_reason|critical_error|scheduled_yield/;
  for (const f of FILES) {
    assert.ok(!re.test(read(f)), `${f} must not document the deleted stop_reason/critical_error/scheduled_yield contract`);
  }
});

test('E6: recovery action is recover_wave, never recover_and_redispatch', () => {
  for (const f of ['docs/internals/bundle-resume.md', 'docs/internals/task-verification.md']) {
    assert.ok(!/recover_and_redispatch/.test(read(f)), `${f} must not name the renamed recover_and_redispatch`);
  }
  assert.ok(/recover_wave/.test(read('docs/internals/bundle-resume.md')), 'bundle-resume.md should name recover_wave');
});

test('E7: review is documented as seeded default-ON, not off', () => {
  assert.ok(/on by default/.test(read('docs/internals/task-verification.md')), 'task-verification.md should say review is on by default');
  assert.ok(!/off by default|default ['\u2018\u2019']off['\u2019]/.test(read('docs/internals/wave-dispatch.md')), 'wave-dispatch.md must not claim review defaults off');
  assert.ok(!/default ['\u2018\u2019]off['\u2019]/.test(read('docs/internals/task-verification.md')), 'task-verification.md must not claim review defaults off');
});

test('E11: mp-implementer ghost removed from internals.md', () => {
  assert.ok(!/mp-implementer/.test(read('docs/internals.md')), 'docs/internals.md must not name the deleted mp-implementer agent');
});

function section2d(prompt) {
  const start = prompt.indexOf('## 2d ');
  assert.ok(start !== -1, 'commands/masterplan.md must contain §2d');
  const next = prompt.indexOf('\n## ', start + 1);
  assert.ok(next !== -1, 'commands/masterplan.md §2d must be followed by another heading');
  return prompt.slice(start, next);
}

test('§2d points at the fleet turn-end contract and lists only masterplan-specific durable gates', () => {
  const twoD = section2d(read('commands/masterplan.md'));
  assert2dContract(twoD);
});

// The §2d contract, extracted so mutation tests can prove the negative assertions
// actually reject a reintroduced fleet rule and a removed hatch restriction — the
// adversarial-review repair (wave 0): literal-phrase rejection alone would let a
// paraphrased restatement ("**Fleet ending rules**", a reworded risky-action gate)
// pass silently.
function assert2dContract(twoD) {
  assert.ok(
    twoD.includes('/srv/workflows/policy/turn-end.md'),
    '§2d must point at /srv/workflows/policy/turn-end.md and restate none of it',
  );
  assert.ok(
    twoD.includes('<mp-autoprogress>'),
    '§2d must preserve the eligible <mp-autoprogress> hatch',
  );
  // The hatch must keep its ELIGIBILITY restrictions, not just its token: an
  // unrestricted hatch would license silent stops — the exact failure the fleet
  // contract exists to prevent.
  assert.ok(
    /auto-progress turn/.test(twoD) && /non-gate op/.test(twoD),
    '§2d must retain the <mp-autoprogress> hatch eligibility restrictions (auto-progress turn, non-gate op)',
  );
  for (const gate of [
    'branch_finish',
    'verification_failed',
    'no_verification_command',
    'docs_normalize',
    'goals_unmet',
  ]) {
    assert.ok(twoD.includes(gate), `§2d must still name the durable gate ${gate}`);
  }
  // Fleet-rule restatement markers — masterplan's §2d names its own durable gates
  // and the hatch, never the fleet contract's endings, precedence, boundary, or
  // risky-action content. Each marker names content whose only home is turn-end.md.
  const fleetRuleMarkers = [
    /\*\*The COMPLETE stop-set\*\*/,
    /\*\*Fleet ending rules\*\*/i,
    /seven (?:legitimate |turn )?endings?/i,
    /exemption precedence/i,
    /continue rule/i,
    /boundary rule/i,
    /An explicit \*\*risky-action\*\* confirmation: push \/ merge \/ discard \/ force \/ external message \/ secrets/,
    /\brisky-action\b.*\bpush\b/i,
    /validated exemption|permitted claim|handoff_paths|checkpoint_context_tokens/,
  ];
  for (const marker of fleetRuleMarkers) {
    assert.ok(
      !marker.test(twoD),
      `§2d must not restate fleet turn-end contract content (${marker}); that lives in turn-end.md`,
    );
  }
}

test('§2d mutation cases: a reintroduced fleet rule or a stripped hatch restriction fails the contract', () => {
  const real = section2d(read('commands/masterplan.md'));
  // Mutation 1: a fleet stop-set sneaks back under a different heading.
  const withFleetRule = real + '\n**Fleet ending rules**: complete, gate, blocked, awaiting, handoff, checkpoint, opted-out — with the continue rule.\n';
  assert.throws(() => assert2dContract(withFleetRule), /must not restate fleet turn-end contract content/);
  // Mutation 2: the hatch loses its eligibility restrictions (bare token retained).
  const strippedHatch = real.replace(/auto-progress turn/g, 'turn').replace(/non-gate op/g, 'op');
  assert.throws(() => assert2dContract(strippedHatch), /eligibility restrictions/);
  // Mutation 3: the pointer itself disappears.
  const noPointer = real.replace(/\/srv\/workflows\/policy\/turn-end\.md/g, '/srv/workflows/policy/other.md');
  assert.throws(() => assert2dContract(noPointer), /must point at/);
  // Control: the unmutated §2d passes (guards against an over-tight marker).
  assert2dContract(real);
});
