// test/docs-contract.test.mjs — E5/E6/E7/E11 structural guard (fresh-eyes remediation).
// The shared internals docs must match the code:
//   E5 — no run-level stop_reason/critical_error/scheduled_yield contract (absent from lib/).
//   E6 — the recovery action is `recover_wave` (lib/continue.mjs case 'recover_wave'), never
//        the renamed `recover_and_redispatch`.
//   E7 — review is seeded ON by default (lib/bundle.mjs buildSeedState codexReview = true),
//        so docs must not claim "off by default".
//   E11 — the mp-implementer agent was deleted (c5bba82); internals docs must not name it.
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
