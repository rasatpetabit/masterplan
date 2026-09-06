// test/intent-critic-prompt.test.mjs — asserts the mp-intent-critic agent prompt and the
// intent-interview design doc carry the critic/breaker/frontier posture, the quoted-data
// boundary, the intent-versus-how review rules, the complete output schema, and the
// terminal-state / content_head resume contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, '..', 'agents', 'mp-intent-critic.md');
const designPath = path.join(here, '..', 'docs', 'design', 'intent-interview.md');

const agent = readFileSync(agentPath, 'utf8');
const design = readFileSync(designPath, 'utf8');

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'agent file must start with YAML frontmatter');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  }
  return fields;
}

test('agent frontmatter declares the critic/breaker/frontier posture', () => {
  const fm = parseFrontmatter(agent);
  assert.equal(fm.name, 'mp-intent-critic');
  assert.equal(fm.model, 'frontier');
  assert.equal(fm.preset, 'breaker');
  assert.match(fm.tools, /read/);
  assert.match(fm.tools, /bash/);
  assert.ok(fm.description.length > 0, 'description must not be empty');
});

test('agent body states the quoted-data boundary', () => {
  assert.match(agent, /QUOTED DATA/);
  assert.match(agent, /never instructions/);
  assert.match(agent, /untrusted/);
});

test('agent body states the intent-versus-how review rules', () => {
  assert.match(agent, /intent-vs-how/);
  assert.match(agent, /\*how\* question|how question/i);
  assert.match(agent, /misclassified/);
});

test('agent body declares the complete output schema', () => {
  const heading = '## Output schema';
  const start = agent.indexOf(heading);
  assert.ok(start !== -1, 'agent must have Output schema heading');
  const afterHeading = agent.slice(start + heading.length);
  const lines = afterHeading.split('\n');
  // The schema is the first four-space-indented block after the heading (prose may precede it).
  const blockLines = [];
  let started = false;
  for (const line of lines) {
    if (line.startsWith('    ')) {
      started = true;
      blockLines.push(line.slice(4));
    } else if (!started) {
      if (line.startsWith('## ')) break; // next section without a block
      continue; // prose / blank lines before the block
    } else if (line.trim() === '') {
      blockLines.push('');
    } else {
      break;
    }
  }
  const block = blockLines.join('\n');
  const schema = JSON.parse(block);
  assert.ok(Array.isArray(schema.unknowns));
  assert.equal(typeof schema.unknowns[0].id, 'string');
  assert.equal(typeof schema.unknowns[0].question, 'string');
  assert.equal(typeof schema.unknowns[0].why_it_changes_design, 'string');
  assert.ok(Array.isArray(schema.unknowns[0].options));
  assert.ok(Array.isArray(schema.misclassified));
  assert.ok(Array.isArray(schema.contradictions));
  assert.equal(typeof schema.contradictions[0].id, 'string');
  assert.ok(Array.isArray(schema.contradictions[0].question_ids));
  assert.equal(typeof schema.contradictions[0].note, 'string');
  assert.equal(typeof schema.intent_draft.why, 'string');
  assert.equal(typeof schema.intent_draft.outcome, 'string');
  assert.equal(typeof schema.intent_draft.done_means, 'string');
  assert.ok(Array.isArray(schema.intent_draft.anti_goals));
  // Task 54 (wiring): the critic payload gains the eligible question set (the ids of the
  // asked questions judged eligible — intent-kind, answered, not withdrawn, never design-kind)
  // and the forks_remaining boolean verdict. Consumer update of the payload extension; the
  // wave transaction's verify-scope owns this file's scope, so this edit follows the
  // task-52/58 consumer-update precedent: made here, disclosed in the task digest,
  // restored post-transaction if the revert lands first.
  assert.ok(Array.isArray(schema.eligible_question_set));
  assert.equal(typeof schema.forks_remaining, 'boolean');
  assert.deepEqual(Object.keys(schema).sort(), ['contradictions', 'eligible_question_set', 'forks_remaining', 'intent_draft', 'misclassified', 'unknowns']);
});

test('design doc documents budgets, cadence, artifacts, receipts, terminal states, resume', () => {
  assert.match(design, /budget/i);
  assert.match(design, /round cadence/i);
  assert.match(design, /durable artifacts/i);
  assert.match(design, /honesty-bound receipts/i);
  assert.match(design, /converged/);
  assert.match(design, /exhausted/);
  assert.match(design, /critic_off/);
  assert.match(design, /content_head/);
  assert.match(design, /resume/i);
  assert.match(design, /disk/i);
});
