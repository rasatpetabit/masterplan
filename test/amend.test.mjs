// test/amend.test.mjs — pure-writer coverage for lib/amend.mjs (F2 amendments, planf3-ideas).
// Mirrors the refs core+test pattern: exercises the PURE writer with NO fs/clock. The bin verb
// (`mp amend-plan`) owns the fs / event / render integration and is covered by its own test later;
// this file locks the writer contract from wave one so downstream verify commands run against a
// file that already exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amendPlan,
  escapeDetailLine,
  unescapeDetailLine,
  AMENDMENTS_HEADING,
  AMENDMENT_ENTRY_RE,
} from '../lib/amend.mjs';

const DATE = '2026-07-06';
const PLAN = '# My Plan\n\n## Wave 0\n\n### Task 1: do a thing\n';

test('first use: creates a ## Amendments section at EOF with a ### entry', () => {
  const r = amendPlan({ planText: PLAN, summary: 'tightened scope', date: DATE });
  assert.equal(r.ok, true);
  assert.match(r.planText, /## Amendments/);
  assert.match(r.planText, /### 2026-07-06 — tightened scope/);
  // original content preserved, section lands at EOF (after the task heading)
  assert.ok(r.planText.startsWith('# My Plan'));
  assert.ok(r.planText.indexOf('## Amendments') > r.planText.indexOf('### Task 1'));
  // exactly ONE Amendments section heading
  assert.equal((r.planText.match(/^## Amendments$/gm) || []).length, 1);
  // event carries {summary}
  assert.deepEqual(r.event, { type: 'plan_amended', summary: 'tightened scope' });
  assert.equal(AMENDMENTS_HEADING, '## Amendments');
});

test('append ordering: newest entry lands last, still one Amendments section', () => {
  const first = amendPlan({ planText: PLAN, summary: 'first change', date: '2026-07-01' });
  assert.equal(first.ok, true);
  const second = amendPlan({ planText: first.planText, summary: 'second change', date: '2026-07-02' });
  assert.equal(second.ok, true);
  assert.equal((second.planText.match(/^## Amendments$/gm) || []).length, 1);
  const iFirst = second.planText.indexOf('first change');
  const iSecond = second.planText.indexOf('second change');
  assert.ok(iFirst !== -1 && iSecond !== -1);
  assert.ok(iSecond > iFirst, 'newest entry must be appended last');
});

test('refusal: empty / whitespace-only summary', () => {
  assert.equal(amendPlan({ planText: PLAN, summary: '', date: DATE }).ok, false);
  assert.equal(amendPlan({ planText: PLAN, summary: '   ', date: DATE }).ok, false);
});

test('refusal: multiline summary', () => {
  const r = amendPlan({ planText: PLAN, summary: 'line one\nline two', date: DATE });
  assert.equal(r.ok, false);
  assert.match(r.error, /single line/);
});

test('refusal: leading-# summary (would corrupt the heading structure)', () => {
  const r = amendPlan({ planText: PLAN, summary: '# not a heading', date: DATE });
  assert.equal(r.ok, false);
  assert.match(r.error, /#/);
});

test('refusal: absent plan.md', () => {
  assert.equal(amendPlan({ planText: null, summary: 'x', date: DATE }).ok, false);
  assert.equal(amendPlan({ planText: undefined, summary: 'x', date: DATE }).ok, false);
});

test('refusal: archived bundle', () => {
  const r = amendPlan({ planText: PLAN, summary: 'x', date: DATE, archived: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /archived/);
});

test('detail #-line escaping keeps the section parse unambiguous', () => {
  const detail = 'plain line\n# looks like a heading\n## also\n### and this';
  const r = amendPlan({ planText: '# P\n', summary: 'with detail', detail, date: DATE });
  assert.equal(r.ok, true);
  // exactly ONE entry heading and ONE section heading — no detail line parses as a heading
  assert.equal((r.planText.match(/^### /gm) || []).length, 1);
  assert.equal((r.planText.match(/^## Amendments$/gm) || []).length, 1);
  // escaped forms present, plain line untouched
  assert.match(r.planText, /^\\# looks like a heading$/m);
  assert.match(r.planText, /^\\## also$/m);
  assert.match(r.planText, /^\\### and this$/m);
  assert.match(r.planText, /^plain line$/m);
});

test('escape/unescape helpers round-trip', () => {
  for (const line of ['# h', '## h', '### h', 'plain', '  # indented stays', '#nospace']) {
    assert.equal(unescapeDetailLine(escapeDetailLine(line)), line);
  }
  assert.equal(escapeDetailLine('plain'), 'plain');
  assert.equal(escapeDetailLine('# x'), '\\# x');
  assert.equal(unescapeDetailLine('\\# x'), '# x');
});

test('entry heading matches the exported render regex', () => {
  const r = amendPlan({ planText: PLAN, summary: 'renderable', date: DATE });
  const entryLine = r.planText.split('\n').find((l) => l.startsWith('### 2026'));
  const m = entryLine.match(AMENDMENT_ENTRY_RE);
  assert.ok(m, 'entry line should match AMENDMENT_ENTRY_RE');
  assert.equal(m[1], DATE);
  assert.equal(m[2], 'renderable');
});

test('appends into an existing Amendments section, before a following heading', () => {
  const planWithAfter = '# Plan\n\n## Amendments\n\n### 2026-01-01 — old\n\n## Footer\n\ntail\n';
  const r = amendPlan({ planText: planWithAfter, summary: 'new one', date: DATE });
  assert.equal(r.ok, true);
  const iOld = r.planText.indexOf('old');
  const iNew = r.planText.indexOf('new one');
  const iFooter = r.planText.indexOf('## Footer');
  assert.ok(iOld < iNew && iNew < iFooter, 'new entry lands inside the Amendments section, before Footer');
});
