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

test('E12: README Environment section names every readEnv-backed control', () => {
  // The environment is read through ONE seam (readEnv in lib/config.mjs; readEnvAll's proxy in
  // bin/masterplan.mjs hands callees a view whose every property read still goes through readEnv).
  // This test discovers every name read through that seam and asserts the README Environment
  // table documents each one — so a new env read added without a doc row fails the suite.
  const dirs = ['bin', 'lib'];
  const discovered = new Set();
  for (const dir of dirs) {
    const base = path.join(ROOT, dir);
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!/\.[mc]?js$/.test(ent.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        // readEnv('NAME') and readEnv("NAME") — 1- and 2-arg forms
        for (const m of text.matchAll(/readEnv\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
          discovered.add(m[1]);
        }
        // env.NAME / readEnvAll().NAME property reads (the seam's proxy routes these through readEnv)
        for (const m of text.matchAll(/(?:\benv\b|readEnvAll\s*\(\s*\))[ \t]*\.[ \t]*([A-Za-z_][A-Za-z0-9_]*)/g)) {
          if (/^(?:get|has|ownKeys|getOwnPropertyDescriptor)$/.test(m[1])) continue;
          discovered.add(m[1]);
        }
      }
    };
    walk(base);
  }
  const readmeEnv = read('README.md');
  const table = readmeEnv.split('### Environment')[1];
  assert.ok(table, 'README must have a "### Environment" section');
  // Table rows are "| `NAME` |" or "| `NAME` / `OTHER` |". Collect every backticked token on the
  // first column and on the variable column.
  const documented = new Set();
  for (const line of table.split('\n')) {
    const m = line.match(/^\|\s*((?:`[A-Za-z0-9_]+`\s*\/?\s*)+)\|/);
    if (!m) continue;
    for (const name of m[1].matchAll(/`([A-Za-z0-9_]+)`/g)) documented.add(name[1]);
  }
  const missing = [...discovered].filter((n) => !documented.has(n));
  assert.deepEqual(
    missing,
    [],
    `env names read in bin/ + lib/ but not documented in the README Environment table:\n${missing.join('\n') || '(none)'}\n` +
      'Add a row for each — every readEnv/env.X control must be documented.',
  );
  // Sanity: the seam's own listed names are all discovered (guards a broken scanner).
  for (const known of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'PI_CODING_AGENT']) {
    assert.ok(discovered.has(known), `scanner must discover ${known}`);
  }
});

test('E13: every version-bearing surface reports the package version', () => {
  // Version consistency: package.json is the source of truth; the four plugin manifests AND
  // llms.txt must all report the same version. A bump in one surface that misses another fails.
  const pkg = JSON.parse(read('package.json'));
  const expect = pkg.version;
  assert.ok(expect, 'package.json must carry a version');
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json']) {
    const doc = JSON.parse(read(f));
    assert.equal(doc.version, expect, `${f} version must match package.json`);
  }
  const llms = read('llms.txt');
  const m = llms.match(/Current release: v([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.ok(m, 'llms.txt must state "Current release: vX.Y.Z"');
  assert.equal(m[1], expect, `llms.txt Current release must match package.json (${expect})`);
});
