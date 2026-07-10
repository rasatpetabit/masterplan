// test/op-table-parity.test.mjs — producer/consumer parity for the L1 §2 op table.
//
// THE dangling-op class this kills permanently: lib/dispatch/ops.mjs shipped a
// `dispatch_fabric` op (producer) while commands/masterplan.md's §2 op table
// listed only launch_workflow/dispatch_foreground (consumers) — so fabric waves
// silently never dispatched through the broker. These asserts fail the suite the
// moment either side drifts again:
//
//   1. Every op emitted by lib/dispatch/ops.mjs (the wave dispatch-vehicle
//      producer) has a consumer row in the §2 op table.
//   2. Every §2 op-table row names an op some producer actually emits
//      (lib/dispatch/ops.mjs or lib/continue.mjs — the two modules whose ops the
//      §2 loop executes).
//   3. The dispatch_fabric row's "do" is the deterministic `mp dispatch-wave`
//      command (never sequencer prose) — the review-mandated consumer contract.
//
// Extraction is deliberately dumb-but-loud: op literals via /op:\s*'…'/ over the
// producer sources (module-header op enums included — they are kept in lockstep
// with the code by review), table rows via the first backticked token of each
// row between the "4. **The loop.**" and "5. **CD-7" §2 anchors. If an anchor
// disappears, the test fails loudly rather than silently scanning nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** All op-name literals a producer source emits/declares: op:'name' / op: 'name'. */
function producerOps(rel) {
  const ops = new Set();
  for (const m of read(rel).matchAll(/\bop:\s*'([a-z_]+)'/g)) ops.add(m[1]);
  return ops;
}

/** The §2 op-table region of commands/masterplan.md (anchored, fail-loud). */
function opTableRegion() {
  const text = read('commands/masterplan.md');
  const start = text.indexOf('4. **The loop.**');
  const end = text.indexOf('5. **CD-7 commit discipline.**');
  assert.ok(start !== -1, 'commands/masterplan.md §2 anchor "4. **The loop.**" not found — update the parity test anchors');
  assert.ok(end > start, 'commands/masterplan.md §2 anchor "5. **CD-7 commit discipline.**" not found — update the parity test anchors');
  return text.slice(start, end);
}

/** Parse the §2 op-table rows into [{ op, do }] (first backticked token per row). */
function opTableRows() {
  const rows = [];
  for (const line of opTableRegion().split('\n')) {
    const m = line.match(/^\s*\|\s*`([a-z_]+)`(.*)$/);
    if (!m) continue; // header / separator / non-row lines
    const cells = m[2].split('|');
    rows.push({ op: m[1], do: cells.length > 1 ? cells[1] : '' });
  }
  return rows;
}

test('every op emitted by lib/dispatch/ops.mjs has a consumer row in the §2 op table', () => {
  const emitted = producerOps('lib/dispatch/ops.mjs');
  assert.ok(emitted.size >= 3, `expected ops.mjs to emit >=3 ops, extracted ${emitted.size} — extraction regex broken?`);
  const rows = new Set(opTableRows().map((r) => r.op));
  for (const op of emitted) {
    assert.ok(
      rows.has(op),
      `dangling op: lib/dispatch/ops.mjs emits '${op}' but commands/masterplan.md's §2 op table has no consumer row for it — a produced op nothing executes is exactly the class this lint kills`,
    );
  }
});

test('every §2 op-table row names an op a producer actually emits (ops.mjs ∪ continue.mjs)', () => {
  const producers = new Set([
    ...producerOps('lib/dispatch/ops.mjs'),
    ...producerOps('lib/continue.mjs'),
  ]);
  const rows = opTableRows();
  assert.ok(rows.length >= 5, `expected >=5 §2 op-table rows, extracted ${rows.length} — table parsing broken?`);
  for (const { op } of rows) {
    assert.ok(
      producers.has(op),
      `phantom row: the §2 op table documents '${op}' but neither lib/dispatch/ops.mjs nor lib/continue.mjs emits it — remove the row or wire the producer`,
    );
  }
});

test("the dispatch_fabric row's consumer is the deterministic `mp dispatch-wave` command", () => {
  const row = opTableRows().find((r) => r.op === 'dispatch_fabric');
  assert.ok(row, 'no dispatch_fabric row in the §2 op table');
  assert.match(
    row.do,
    /`mp dispatch-wave --state=<path>`/,
    'the dispatch_fabric row must consume the op via the deterministic `mp dispatch-wave --state=<path>` command, not sequencer prose',
  );
});
