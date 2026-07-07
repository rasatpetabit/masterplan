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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';

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

// ---- integration: the `mp amend-plan` bin verb (fs / event / render / Guard-D) --------------------
// The pure writer above owns section shape & refusals; these spawn the real CLI over a temp bundle to
// lock the verb's I/O contract: the plan_amended {summary} event lands LAST, an existing plan.html is
// re-rendered inline, a live foreign owner is refused writing nothing (Guard-D), and a render failure
// leaves the mutation durable while WARNing the stale bundle and exiting non-zero.
const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function mkBundle({ slug = 'amend-int', tasks = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-amend-'));
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState({
    schema_version: '6.0', slug, status: 'in-progress', phase: 'execute',
    pending_gate: null, active_run: null, tasks,
  }));
  return { dir, p };
}
const readEvents = (dir) =>
  fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const PLAN_INDEX = {
  schema_version: '6.0',
  tasks: [{ id: 1, wave: 0, description: 'first', files: ['a.txt'], verify_commands: ['true'], codex: null }],
};
const OWNER = ['--session=sess-me', '--host=h-me'];

test('verb amend-plan: writes plan.md and appends a plan_amended {summary} event LAST', () => {
  const { dir, p } = mkBundle();
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n\n## Wave 0\n');
  const r = run(['amend-plan', `--state=${p}`, '--summary=tightened scope',
    '--date=2026-07-06', '--now=1000', '--ts=2026-07-06T00:00:00Z', ...OWNER]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { amend_plan: 'amended', summary: 'tightened scope' });
  const plan = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8');
  assert.match(plan, /## Amendments/);
  assert.match(plan, /### 2026-07-06 — tightened scope/);
  const events = readEvents(dir);
  const last = events[events.length - 1];
  assert.equal(last.type, 'plan_amended');
  assert.equal(last.summary, 'tightened scope');
  assert.equal(last.ts, '2026-07-06T00:00:00Z');
  // no plan.html existed -> the inline re-render is a clean no-op (nothing materialized)
  assert.ok(!fs.existsSync(path.join(dir, 'plan.html')), 'no plan.html materialized when none existed');
});

test('verb amend-plan: re-renders an EXISTING plan.html inline (fresh HTML, status 0)', () => {
  const { dir, p } = mkBundle({ tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.txt'] }] });
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(dir, 'plan.index.json'), JSON.stringify(PLAN_INDEX));
  fs.writeFileSync(path.join(dir, 'plan.html'), 'OLD-STALE-MARKER');
  const r = run(['amend-plan', `--state=${p}`, '--summary=note', '--date=2026-07-06', '--now=1000', ...OWNER]);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(dir, 'plan.html'), 'utf8');
  assert.ok(!html.includes('OLD-STALE-MARKER'), 'stale plan.html was replaced');
  assert.ok(html.startsWith('<!DOCTYPE html>'), 're-rendered to real HTML');
});

test('verb amend-plan: Guard-D refuses a LIVE foreign owner — nothing written', () => {
  const { dir, p } = mkBundle({ slug: 'amend-guardd' });
  const planText = '# Plan\n';
  fs.writeFileSync(path.join(dir, 'plan.md'), planText);
  const foreign = buildOwnerIdentity({ host: 'h-other', session: 'sess-OTHER', slug: 'amend-guardd', now: 1000 });
  assert.equal(acquireOwner(dir, foreign, { now: 1000 }).outcome, 'acquire');
  const r = run(['amend-plan', `--state=${p}`, '--summary=blocked change',
    '--date=2026-07-06', '--now=1500', '--ttl-ms=1000000', ...OWNER]);
  assert.notEqual(r.status, 0, 'a live foreign owner must block');
  assert.match(r.stderr, /is owned by|nothing written/);
  assert.equal(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), planText, 'plan.md untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'events.jsonl')), 'no plan_amended event on a Guard-D refusal');
});

test('verb amend-plan: a render failure leaves the mutation durable, WARNs the stale bundle, exits non-zero', () => {
  const { dir, p } = mkBundle({ slug: 'amend-renderfail', tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.txt'] }] });
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n');
  // plan.html EXISTS (so the inline re-render is attempted) but plan.index.json is absent -> read throws -> STALE.
  fs.writeFileSync(path.join(dir, 'plan.html'), 'OLD');
  const r = run(['amend-plan', `--state=${p}`, '--summary=stands anyway', '--date=2026-07-06', '--now=1000', ...OWNER]);
  assert.notEqual(r.status, 0, 'a render failure exits non-zero');
  assert.match(r.stderr, /STALE/);
  assert.ok(r.stderr.includes(dir), 'the WARN names the stale bundle dir');
  const plan = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8');
  assert.match(plan, /### 2026-07-06 — stands anyway/, 'the plan.md mutation stands durable');
  const events = readEvents(dir);
  assert.equal(events[events.length - 1].type, 'plan_amended', 'the plan_amended event committed before the render');
  assert.deepEqual(JSON.parse(r.stdout), { amend_plan: 'amended', summary: 'stands anyway' });
});
