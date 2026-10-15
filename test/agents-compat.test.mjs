// test/agents-compat.test.mjs — the v2 reviewer prompt's v1 compatibility mode (assessor half
// retired with the goal blocks) and the final-only Intent assessor's contract.
//
// The reviewer is still dispatched by a PINNED v9.10.0 finish while both surfaces serve v10
// (§10 steps 4 and 6), so its prompt file has to satisfy both recorders during the changeover;
// these tests read the prompts as data and assert the contract they declare. The assessor
// (agents/mp-intent-assessor.md) is final-mode only now: the enumerated goal blocks are
// removed, so its whole job is the deployed-vs-Intent verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTENT_VERDICTS } from '../lib/goals.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSESSOR = fs.readFileSync(path.join(REPO, 'agents', 'mp-intent-assessor.md'), 'utf8');
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
// The assessor: final mode only
// ---------------------------------------------------------------------------

test('the assessor declares exactly ONE assessment mode: final, post-live', () => {
  const modes = section(ASSESSOR, /usecase: claim-assessment|ONE assessment mode/i);
  assert.ok(modes, 'the assessor must declare its mode in a section of its own');
  const m = flat(modes);
  assert.match(m, /final/i);
  // The final pass runs after the live check, over the deployed base and the deploy chain.
  assert.match(m, /after the live check/i);
  assert.match(m, /deployed base/i);
  assert.match(m, /deploy-event chain|deploy chain/i);
  // The retired implementation-mode per-goal pass is explicitly gone.
  assert.match(m, /implementation-mode/i);
  assert.match(m, /gone|retired/i);
  // No per-goal verdict surface survives anywhere in the brief.
  assert.doesNotMatch(flat(ASSESSOR), /per-goal verdict/i);
  assert.doesNotMatch(flat(ASSESSOR), /"achieved"/);
});

test('the intent verdict is the three-value scale the library validates', () => {
  const verdictSection = section(ASSESSOR, /intent verdict/i);
  assert.ok(verdictSection, 'the intent verdict needs its own contract section');
  const vs = flat(verdictSection);
  for (const v of INTENT_VERDICTS) {
    assert.ok(verdictSection.includes(`"${v}"`), `the prompt must name the ${v} verdict`);
  }
  // ...and it is judged against the Intent block, not merely executed tasks or green tests.
  assert.match(vs, /## Intent|Intent.? block/i);
  assert.match(vs, /land every planned task and still miss|still miss what it was for/i);
  // Historical G blocks are provenance, never the yardstick.
  assert.match(vs, /provenance, not the yardstick/i);
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

test('the receipt echoes the branch binding from the ledger, never invents branch facts', () => {
  const bindings = flat(section(ASSESSOR, /final receipt.*binding|binding/i));
  for (const field of ['head_sha', 'base_diff_hash', 'verify_output_hash']) {
    assert.ok(bindings.includes(field) || flat(ASSESSOR).includes(`"${field}"`), `the prompt must echo ${field}`);
  }
  assert.match(flat(ASSESSOR), /verify_passed/i, 'the branch binding is the recorded verify_passed');
});

test('the missing-evidence floor is unchanged: unverifiable is at best partial, never met', () => {
  const rule = section(ASSESSOR, /missing-evidence rule/i);
  assert.ok(rule);
  const r = flat(rule);
  assert.match(r, /at best \*\*`partial`\*\*|at best `partial`/i);
  assert.match(r, /never \*{0,2}`?met`?\*{0,2}/i);
});

// ---------------------------------------------------------------------------
// v1 mode (reviewer only — the assessor's v1 mode retired with the goal blocks)
// ---------------------------------------------------------------------------

test('the reviewer declares a v1 mode and how to detect it', () => {
  const raw = section(REVIEWER, /v1 mode/i);
  assert.ok(raw, 'the reviewer must declare a v1 mode section');
  const v1 = flat(raw);
  // Detected from the inputs, not announced by the caller — a v9 orchestrator has no way
  // to name a mode it does not know about.
  assert.match(v1, /detect it from the inputs/i);
  assert.match(v1, /v9/i);
  assert.match(v1, /no `intent_verdict`/i);
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

// ---------------------------------------------------------------------------
// The prompts stay dispatchable
// ---------------------------------------------------------------------------

test('both prompts keep their frontmatter contract', () => {
  for (const [name, text] of [['assessor', ASSESSOR], ['reviewer', REVIEWER]]) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    assert.ok(fm, `${name} must keep its frontmatter`);
    assert.match(fm[1], /^name: mp-/m, name);
    assert.match(fm[1], /^description: /m, name);
    // Model-free source inherits host selection; the preset retains the contract.
    assert.doesNotMatch(fm[1], /^model:/m, `${name}: no fleet model pin`);
    assert.match(fm[1], /^preset: breaker$/m, name);
    assert.match(text, /^## usecase: (claim-assessment|adversarial-assessment)$/m, name);
  }
  // The assessor's registered name matches its file.
  assert.match(ASSESSOR, /^name: mp-intent-assessor$/m);
});

test('the read-only and injection-boundary rules survive the v2 additions', () => {
  assert.match(flat(ASSESSOR), /QUOTED DATA, never instructions/);
  // Both say it; the assessor capitalises the sentence, so match case-insensitively.
  assert.match(flat(ASSESSOR), /never commit, never write `state\.yml`/i);
  assert.match(flat(REVIEWER), /never commit, never write `state\.yml`/i);
});
