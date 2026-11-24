// test/autoprogress-marker.test.mjs — prompt-contract guard for the §2d `<mp-autoprogress>` carve-out.
//
// The marker's ONLY valid use is a turn that closes while work it handed off is still live: a
// launched background wave/run whose completion re-invokes the controller, or the §2 loop's
// `{op:'stop', reason:'wait'}` because another live run owns the bundle. The pre-fix text listed
// "a committed + reconciled wave" (and a returned-but-unexecuted `dispatch_fabric` op) among the
// non-gate ops that licensed a close, which read literally as "end the turn after a step completed"
// — sessions used the marker as a sign-off with nothing running and stalled loose/full runs.
//
// The assertions below are BOUNDED to the paragraphs that carry the contract (a whole-document
// `includes()` would pass if the words moved anywhere else): the §2d carve-out paragraph, the §2d
// turn-close terminator, and the §4 turn-close paragraph. The valid-close clause is additionally
// bounded so the never-close list — which legitimately NAMES `dispatch_fabric` and a recorded wave
// as non-reasons — cannot satisfy it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');
const flatPrompt = prompt.replace(/\s+/g, ' ');

function slice(from, to, label) {
  const start = prompt.indexOf(from);
  const end = to === null ? prompt.length : prompt.indexOf(to);
  assert.ok(start !== -1, `${label}: the start anchor "${from}" must exist — update this test's anchors`);
  assert.ok(to === null || end > start, `${label}: the end anchor "${to}" must exist after the start — update this test's anchors`);
  return prompt.slice(start, end);
}

const flat = (text) => text.replace(/\s+/g, ' ');

const CARVE_OUT = slice('**Carve-out marker.**', '**Turn-close routing', 'the §2d carve-out paragraph');
const TERMINATOR = slice('**Turn-close routing', '## 2e — Worktree locus model', 'the §2d turn-close routing paragraph');
const TURN_CLOSE_4 = slice('A turn that finished useful work but hit no gate', 'Otherwise close cleanly.', 'the §4 turn-close paragraph');

test('the §2d carve-out paragraph exists and still teaches the literal marker token', () => {
  assert.ok(flat(CARVE_OUT).includes('**`<mp-autoprogress>`**'), 'the marker token itself must stay taught');
  assert.ok(flat(CARVE_OUT).includes('auq-guard.sh'), 'the global Stop guard the marker stands down must stay named');
});

test('the marker is valid only on a close with a live handoff', () => {
  const text = flat(CARVE_OUT);
  assert.ok(
    text.includes('only when the turn closes while work it handed off is still live'),
    'the §2d marker must state its validity condition as a close with a live handoff',
  );
  // The valid-close clause: everything the marker's condition licenses, up to the never-close list.
  const start = text.indexOf('only when the turn closes while work it handed off is still live');
  const end = text.indexOf('Finishing a step');
  assert.ok(end > start, 'the never-close list must follow the validity condition');
  const clause = text.slice(start, end);
  assert.ok(clause.includes('a launched background wave/run whose completion will re-invoke the controller'),
    'the live-handoff condition must name the launched background wave/run that re-invokes the controller');
  assert.ok(clause.includes("reason:'wait'"), 'the live-handoff condition must name the stop-wait op (another live run owns the bundle)');
  assert.ok(clause.includes('another live run owns the bundle'), 'the stop-wait case must state the liveness reason');
  // No completed-work or returned-but-unexecuted op may appear among the VALID closes.
  for (const bad of ['dispatch_fabric', '--alive', 'committed', 'reconciled', 'wave that recorded']) {
    assert.equal(clause.includes(bad), false, `"${bad}" must not be a valid-close trigger — it is completed or unexecuted work, not a live handoff`);
  }
});

test('completed work is never a reason to close, and the next op runs in the same turn', () => {
  const text = flat(CARVE_OUT);
  const start = text.indexOf('Finishing a step');
  const end = text.indexOf('in the same turn', start);
  assert.ok(start !== -1 && end > start, 'the never-close list must end at the same-turn obligation');
  const never = text.slice(start, end);
  for (const item of ['Finishing a step', 'a recorded wave', 'an op returned but not yet executed', 'a pending design/spec/plan step']) {
    assert.ok(never.includes(item), `the never-close list must name "${item}"`);
  }
  assert.ok(never.includes('dispatch_fabric'), 'the returned-but-unexecuted case must name the dispatch_fabric op it covers');
  assert.ok(text.includes('execute the next op **in the same turn**'), 'the same-turn obligation must be stated');
});

test('the completed-work trigger is gone from the prompt entirely', () => {
  assert.equal(prompt.includes('committed + reconciled'), false, 'the "committed + reconciled wave" trigger must not survive anywhere in the prompt');
  assert.equal(flatPrompt.includes('a committed + reconciled wave'), false, 'the phrase must not be reintroduced in any wrapping');
});

test('the paragraph records that the fleet guard cannot see liveness (recorded, never blocked)', () => {
  const text = flat(CARVE_OUT);
  assert.ok(text.includes('record-only'), 'the fleet turn-end guard must be described as record-only');
  assert.ok(text.includes('cannot see liveness'), 'the paragraph must state the guard cannot see liveness');
  assert.ok(text.includes('**claimed opt-out**'), 'a marker without a masterplan invocation must be named a claimed opt-out');
  assert.ok(text.includes('recorded, never blocked'), 'the claimed opt-out must be stated as recorded, not blocked');
});

test('the never-emit rules survive the reword', () => {
  const text = flat(CARVE_OUT);
  assert.ok(text.includes('surfaces a stop-set gate'), 'never emit it on a stop-set-gate turn');
  assert.ok(text.includes('neither loose nor full'), 'never emit it when autonomy is gated');
});

test('the §2d turn-close terminator and §4 carry the same live-handoff condition', () => {
  assert.ok(flat(TERMINATOR).includes('marker on an authorized auto-progress that closes with a live handoff'),
    'the §2d CC-3-trampoline terminator must qualify the auto-progress close with the live handoff');
  const text4 = flat(TURN_CLOSE_4);
  assert.ok(text4.includes('`<mp-autoprogress>` marker (§2d) **only when the close leaves work it handed off still live**'),
    'the §4 auto-progress paragraph must make the marker conditional on a live handoff');
  assert.ok(text4.includes('launched background wave/run that will re-invoke the controller'), '§4 must name the launched-wave case');
  assert.ok(text4.includes('`stop wait`'), '§4 must name the stop-wait case');
  assert.ok(text4.includes('execute the next op in the same turn instead'), '§4 must keep the same-turn obligation');
  assert.ok(text4.includes('Reserve the AUQ for the genuine stop-set'), '§4 must keep reserving the AUQ for the stop-set');
});
