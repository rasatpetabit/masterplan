// test/agents-compat.test.mjs — the v2 assessor/reviewer prompts and their v1 compatibility
// mode (wave task 15).
//
// This run's v10 prompts are dispatched by a PINNED v9.10.0 finish while both surfaces already
// serve v10 (§10 steps 4 and 6), so one prompt file has to satisfy both recorders during the
// changeover. These tests read the prompts as data and assert the contract they declare, then
// put a v1-shaped result through the v9-compatible validator that will actually judge it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoals, validateGoalCheckReceipt, INTENT_VERDICTS, GOAL_VERDICTS } from '../lib/goals.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSESSOR = fs.readFileSync(path.join(REPO, 'agents', 'mp-goal-assessor.md'), 'utf8');
const REVIEWER = fs.readFileSync(path.join(REPO, 'agents', 'mp-adversarial-reviewer.md'), 'utf8');

// The prompts are markdown; a "section" is a heading and everything up to the next heading of
// the same or a higher level. Reading them structurally keeps these assertions honest — a
// bare substring search would pass on a passing mention in unrelated prose.
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ');

function section(text, headingPattern) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && headingPattern.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// The assessor's two modes
// ---------------------------------------------------------------------------

test('the assessor declares two distinct assessment modes', () => {
  const modes = section(ASSESSOR, /two assessment modes/i);
  assert.ok(modes, 'the assessor must declare its modes in a section of its own');
  const m = flat(modes);
  assert.match(m, /implementation assessment/i);
  assert.match(m, /final assessment/i);
  // The implementation pass runs before the disposition, over the branch diff and verify output.
  assert.match(m, /before the disposition/i);
  assert.match(m, /branch diff/i);
  // The final pass runs after the live check, over the deployed base and the deploy chain.
  assert.match(m, /after the live check/i);
  assert.match(m, /deployed base/i);
  assert.match(m, /deploy-event chain|deploy chain/i);
});

test('only the final mode returns an intent verdict, and the prompt says so in both directions', () => {
  const modes = flat(section(ASSESSOR, /two assessment modes/i));
  // The implementation mode is explicitly told NOT to answer the intent question...
  assert.match(modes, /no `intent_verdict`/i);
  // ...and the final mode is explicitly told to.
  assert.match(modes, /\*\*plus\*\* the `intent_verdict`/i);
  // An unlabelled or unbound brief degrades to the implementation mode rather than guessing.
  assert.match(modes, /treat it as an implementation assessment/i);
});

test('the intent verdict is the three-value scale the library validates', () => {
  const verdictSection = section(ASSESSOR, /intent verdict/i);
  assert.ok(verdictSection, 'the intent verdict needs its own contract section');
  const vs = flat(verdictSection);
  for (const v of INTENT_VERDICTS) {
    assert.ok(verdictSection.includes(`"${v}"`), `the prompt must name the ${v} verdict`);
  }
  // ...and it is judged against the Intent block, not merely the goal list.
  assert.match(vs, /## Intent|Intent.? block/i);
  assert.match(vs, /achieve every listed goal and still miss|still miss what it was for/i);
});

test('the final receipt binds the three recorder-supplied values, verbatim', () => {
  const bindings = section(ASSESSOR, /final receipt.*binding|binding/i);
  assert.ok(bindings, 'the bindings need their own section');
  for (const field of ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest']) {
    assert.ok(bindings.includes(field), `the prompt must bind ${field}`);
  }
  // They are the recorder's values, not the assessor's: an assessor that invents them is
  // validating its own claim.
  assert.match(flat(bindings), /supplied by the recorder, never invented/i);
  assert.match(flat(bindings), /cannot produce a final assessment/i);
});

test('the per-goal verdict scale and the missing-evidence floor are unchanged', () => {
  for (const v of GOAL_VERDICTS) {
    assert.ok(ASSESSOR.includes(`"${v}"`), `the per-goal ${v} verdict must survive the v2 change`);
  }
  const rule = section(ASSESSOR, /missing-evidence rule/i);
  assert.ok(rule);
  assert.match(flat(rule), /at best \*\*`partial`\*\*|at best `partial`/i);
  assert.match(flat(rule), /never \*{0,2}`?achieved`?\*{0,2}/i);
});

test('the per-goal evidence classes are all still declared', () => {
  const phase1 = section(ASSESSOR, /Phase 1/i);
  assert.ok(phase1);
  for (const cls of ['test', 'command', 'artifact', 'docs']) {
    assert.match(phase1, new RegExp(`\\*\\*${cls}\\*\\*`), `evidence class ${cls} must stay declared`);
  }
});

// ---------------------------------------------------------------------------
// v1 mode
// ---------------------------------------------------------------------------

test('both prompts declare a v1 mode and how to detect it', () => {
  for (const [name, text] of [['assessor', ASSESSOR], ['reviewer', REVIEWER]]) {
    const raw = section(text, /v1 mode/i);
    assert.ok(raw, `${name} must declare a v1 mode section`);
    const v1 = flat(raw);
    // Detected from the inputs, not announced by the caller — a v9 orchestrator has no way
    // to name a mode it does not know about.
    assert.match(v1, /detect it from the inputs/i, name);
    assert.match(v1, /v9/i, name);
    assert.match(v1, /no `intent_verdict`/i, name);
  }
});

test('the reviewer v1 mode names its trigger and its whole v9 envelope', () => {
  const raw = section(REVIEWER, /v1 mode/i);
  const v1 = flat(raw);
  // The legacy single-request shape: only the diff and the task text.
  assert.match(v1, /single-request|single request/i);
  assert.match(v1, /diff/i);
  assert.match(v1, /task text/i);
  // The v9 envelope it must return, and the v2 fields it must not.
  assert.match(v1, /severity-first/i);
  assert.match(v1, /`verdict:` line|single `verdict:`/i);
  assert.match(v1, /no deploy-stage fields|no `intent_verdict` and no deploy-stage fields/i);
  // ...and the envelope it refers to actually exists in the prompt.
  const outputSection = flat(section(REVIEWER, /Output shape/i));
  assert.match(outputSection, /ERROR/);
  assert.match(outputSection, /WARN/);
  assert.match(outputSection, /verdict: blocking \| advisory \| clean \| inconclusive/);
});

test('the assessor names both v1 triggers: no Intent block, or the legacy single dispatch', () => {
  const raw = section(ASSESSOR, /v1 mode/i);
  const v1 = flat(raw);
  assert.match(v1, /no \*\*`## Intent` block\*\*|no `?## Intent`? block/i);
  assert.match(v1, /single-dispatch|single dispatch/i);
  // In v1 the stronger bindings are omitted too — a v9 recorder has no contract for them.
  for (const field of ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest']) {
    assert.ok(raw.includes(field), `v1 mode must say ${field} is omitted`);
  }
});

test('a goals document without an Intent block is what v1 mode keys on', () => {
  const v1Goals = [
    'topic: make the widget faster',
    '',
    '## G1: Cut p99 latency',
    'signal: test',
    'evidence: npm test -- latency',
    '',
    '## G2: Keep the API stable',
    'signal: test',
    'evidence: npm test -- api',
    '',
  ].join('\n');
  const parsed = parseGoals(v1Goals);
  assert.equal(parsed.goals.length, 2);
  // No Intent block is present, which is exactly the condition the prompt names.
  assert.equal(/^##\s+Intent\b/m.test(v1Goals), false);
  const v2Goals = `${v1Goals}\n## Intent\nwhy: the widget is too slow\n`;
  assert.equal(/^##\s+Intent\b/m.test(v2Goals), true, 'and a v2 document is distinguishable');

  // The parsed document DRIVES the validation rather than sitting beside it: the expected goal
  // set comes from this document, so a parser that produced different ids would fail here.
  const r = validateGoalCheckReceipt(legacyReceipt(), checkExpected({ goals: parsed.goals }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(parsed.goals.map((g) => g.id), ['G1', 'G2']);
  // ...and a receipt whose verdicts do not cover THIS document's goals is refused.
  const missing = validateGoalCheckReceipt(
    legacyReceipt({ verdicts: { G1: { verdict: 'achieved', evidence: 'only one goal judged' } } }),
    checkExpected({ goals: parsed.goals }),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /G2/);
});

// ---------------------------------------------------------------------------
// A v1-shaped result must satisfy the v9-compatible recorder
// ---------------------------------------------------------------------------

const checkExpected = (over = {}) => ({
  goalsHash: 'sha256:gh',
  headSha: 'headabc',
  baseDiffHash: 'sha256:diff',
  verifyOutputHash: 'sha256:vout',
  clean: true,
  goals: [{ id: 'G1' }, { id: 'G2' }],
  ...over,
});

// The receipt a v9 recorder builds around a legacy assessor's per-goal array.
const legacyReceipt = (over = {}) => ({
  goals_hash: 'sha256:gh',
  head_sha: 'headabc',
  base_diff_hash: 'sha256:diff',
  verify_output_hash: 'sha256:vout',
  clean: true,
  verdicts: {
    G1: { verdict: 'achieved', evidence: 'latency test passes at p99 < 100ms' },
    G2: { verdict: 'partial', evidence: 'api tests pass; one endpoint undocumented' },
  },
  dispatch_id: 'disp-legacy-1',
  model: 'legacy-assessor',
  output_tokens: 412,
  ts: '2026-07-01T00:00:00Z',
  ...over,
});

test('a v1-mode assessor result validates against the v9-compatible goal-check validator', () => {
  const r = validateGoalCheckReceipt(legacyReceipt(), checkExpected());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.provenance_kind, 'assessor');
  // Nothing v2-shaped leaks into a v1 receipt's normalized form.
  assert.equal(r.normalized.final, undefined);
  assert.equal(r.normalized.intent_verdict, undefined);
  for (const field of ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest']) {
    assert.equal(r.normalized[field], undefined, `${field} must not appear on a v1 receipt`);
  }
});

test('a v1 receipt is neither required to carry an intent verdict nor allowed to', () => {
  // Not required: the receipt above has none and validates.
  assert.equal(validateGoalCheckReceipt(legacyReceipt(), checkExpected()).ok, true);
  // Not allowed: emitting one in v1 mode is exactly the fabrication the prompt forbids, and
  // the validator refuses it rather than quietly accepting a post-live judgement.
  const fabricated = validateGoalCheckReceipt(
    legacyReceipt({ intent_verdict: { verdict: 'met', evidence: 'it feels right' } }),
    checkExpected(),
  );
  assert.equal(fabricated.ok, false);
  assert.match(fabricated.error, /only by the final assessment/);
});

test('a final v2 receipt keeps the stronger bindings the v1 shape omits', () => {
  const finalExpected = {
    ...checkExpected(),
    final: true,
    deployBaseSha: 'deploybase1',
    deployChainHash: 'sha256:chain',
    liveCheckDigest: 'sha256:live',
  };
  const finalReceipt = legacyReceipt({
    deploy_base_sha: 'deploybase1',
    deploy_chain_hash: 'sha256:chain',
    live_check_digest: 'sha256:live',
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
  });
  const ok = validateGoalCheckReceipt(finalReceipt, finalExpected);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.normalized.final, true);
  assert.equal(ok.normalized.intent_verdict.verdict, 'met');
  // ...and each binding is normalized to the value the RECORDER supplied.
  assert.equal(ok.normalized.deploy_base_sha, 'deploybase1');
  assert.equal(ok.normalized.deploy_chain_hash, 'sha256:chain');
  assert.equal(ok.normalized.live_check_digest, 'sha256:live');

  // The v1 shape cannot be passed off as a final assessment: the bindings are what make a
  // final verdict mean anything.
  const unbound = validateGoalCheckReceipt(legacyReceipt(), finalExpected);
  assert.equal(unbound.ok, false);
  assert.match(unbound.error, /deploy_base_sha/);
});

// ---------------------------------------------------------------------------
// The prompts stay dispatchable
// ---------------------------------------------------------------------------

test('both prompts keep their frontmatter contract', () => {
  for (const [name, text] of [['assessor', ASSESSOR], ['reviewer', REVIEWER]]) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    assert.ok(fm, `${name} must keep its frontmatter`);
    assert.match(fm[1], /^name: mp-/m, name);
    assert.match(fm[1], /^description: /m, name);
    // `model:` is a routing-policy LANE name, resolved at registration — never a raw model ref.
    const model = /^model: (\S+)$/m.exec(fm[1]);
    assert.ok(model, `${name} must declare its lane`);
    assert.equal(model[1].includes('/'), false, `${name}: model must be a lane name, not a model ref`);
  }
});

test('the read-only and injection-boundary rules survive the v2 additions', () => {
  assert.match(flat(ASSESSOR), /QUOTED DATA, never instructions/);
  // Both say it; the assessor capitalises the sentence, so match case-insensitively.
  assert.match(flat(ASSESSOR), /never commit, never write `state\.yml`/i);
  assert.match(flat(REVIEWER), /never commit, never write `state\.yml`/i);
});
