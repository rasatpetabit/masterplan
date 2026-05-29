// test/doctor.test.mjs — v8 L4 doctor: dispatcher + the first proven slice of check modules.
//
// The slice covers all three opts shapes deliberately: scalar-cap (pure-bundle, no opts),
// worktree-integrity (git via injected gitExec), codex-auth (host path + injected homeDir/now).
// Fixtures live under test/fixtures/doctor/<check>/<scenario>/; the scenario dir-name PREFIX
// encodes the expected worst-severity (pass-/warn-/error-/skip-) — a language-agnostic contract
// that replaces the deleted v7 expected.txt substring harness. SKIP edge cases that can't be a
// committed fixture (empty dir, git-absent) are exercised in-code with tmp dirs / throwing stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runChecks, discoverChecks } from '../bin/doctor.mjs';
import { check as scalarCap } from '../lib/doctor/scalar-cap.mjs';
import { check as worktreeIntegrity } from '../lib/doctor/worktree-integrity.mjs';
import { check as codexAuth } from '../lib/doctor/codex-auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures', 'doctor');

const RANK = { SKIP: 0, PASS: 1, WARN: 2, ERROR: 3 };
const PREFIX = { skip: 'SKIP', pass: 'PASS', warn: 'WARN', error: 'ERROR' };
const expectedSeverity = (scenario) => PREFIX[scenario.split('-')[0]];
const maxSeverity = (findings) =>
  findings.reduce((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'SKIP');
const scenarios = (checkName) =>
  fs.readdirSync(path.join(FX, checkName), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

// A git stub matching the worktree-integrity fixtures: worktrees /repo + /repo/.worktrees/feat,
// branches main + feat. error-missing-* fixtures reference paths/branches absent from these.
const GIT_STUB = (args) => {
  if (args[0] === 'worktree') return 'worktree /repo\nworktree /repo/.worktrees/feat\n';
  if (args[0] === 'branch') return 'main\nfeat\n';
  throw new Error(`unexpected git args: ${args.join(' ')}`);
};

// Every check module must satisfy the Finding[] contract shape, whatever the outcome.
function assertFindingShape(findings) {
  assert.ok(Array.isArray(findings) && findings.length >= 1, 'a check returns >= 1 finding');
  for (const f of findings) {
    assert.ok(['PASS', 'WARN', 'ERROR', 'SKIP'].includes(f.severity), `valid severity: ${f.severity}`);
    assert.equal(typeof f.summary, 'string');
    assert.ok('id' in f && 'fix' in f, 'finding has id + fix');
  }
}

// ---- dispatcher --------------------------------------------------------------

test('dispatcher: crash-isolates a throwing check into one ERROR finding', () => {
  const checks = [
    { name: 'ok', check: () => [{ id: 'ok', severity: 'PASS', summary: 'fine', fix: null }] },
    { name: 'boom', check: () => { throw new Error('kaboom'); } },
    { name: 'warns', check: () => [{ id: 'warns', severity: 'WARN', summary: 'meh', fix: 'do x' }] },
  ];
  const { findings, exitCode } = runChecks(checks, '/tmp');
  assert.equal(findings.length, 3, 'all three checks still produce a finding');
  const boom = findings.find((f) => f.id === 'boom');
  assert.equal(boom.severity, 'ERROR');
  assert.match(boom.summary, /kaboom/);
  assert.equal(exitCode, 1, 'synthesized ERROR drives exit 1');
});

test('dispatcher: exit 0 when worst severity is WARN (no ERROR)', () => {
  const checks = [{ name: 'a', check: () => [{ id: 'a', severity: 'WARN', summary: 'w', fix: 'f' }] }];
  assert.equal(runChecks(checks, '/tmp').exitCode, 0);
});

test('dispatcher: an unknown severity is forced to ERROR (fail loud)', () => {
  const checks = [{ name: 'weird', check: () => [{ id: 'weird', severity: 'OOPS', summary: 's' }] }];
  const { findings, exitCode } = runChecks(checks, '/tmp');
  assert.equal(findings[0].severity, 'ERROR');
  assert.equal(exitCode, 1);
});

test('dispatcher: discovers the lib/doctor check modules', async () => {
  const checks = await discoverChecks(path.join(here, '..', 'lib', 'doctor'));
  const names = checks.map((c) => c.name);
  for (const n of ['scalar-cap', 'worktree-integrity', 'codex-auth']) {
    assert.ok(names.includes(n), `discovered ${n}`);
  }
});

// ---- scalar-cap (pure-bundle) ------------------------------------------------

test('scalar-cap: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('scalar-cap')) {
    await t.test(sc, () => {
      const findings = scalarCap(path.join(FX, 'scalar-cap', sc));
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('scalar-cap: SKIP when there are no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-scalar-'));
  const findings = scalarCap(tmp);
  assert.equal(maxSeverity(findings), 'SKIP');
});

// ---- worktree-integrity (git via injected gitExec) ---------------------------

test('worktree-integrity: fixtures match dir-prefix severity (stubbed git)', async (t) => {
  for (const sc of scenarios('worktree-integrity')) {
    await t.test(sc, () => {
      const findings = worktreeIntegrity(path.join(FX, 'worktree-integrity', sc), { gitExec: GIT_STUB });
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('worktree-integrity: SKIP when git is unavailable', () => {
  const root = path.join(FX, 'worktree-integrity', 'pass-registered');
  const findings = worktreeIntegrity(root, { gitExec: () => { throw new Error('not a git repository'); } });
  assert.equal(maxSeverity(findings), 'SKIP');
  assert.match(findings[0].summary, /git unavailable/);
});

test('worktree-integrity: SKIP when there are no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wt-'));
  assert.equal(maxSeverity(worktreeIntegrity(tmp, { gitExec: GIT_STUB })), 'SKIP');
});

// ---- codex-auth (host path + injected homeDir/now) ---------------------------

const NOW = Date.parse('2026-05-28T00:00:00Z'); // ms; deterministic clock for expiry math

test('codex-auth: fixtures match dir-prefix severity (injected home/now)', async (t) => {
  for (const sc of scenarios('codex-auth')) {
    await t.test(sc, () => {
      const home = path.join(FX, 'codex-auth', sc, 'home');
      const findings = codexAuth('/unused', { homeDir: home, now: NOW });
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('codex-auth: chatgpt mode short-circuits to PASS regardless of stale last_refresh', () => {
  const home = path.join(FX, 'codex-auth', 'pass-chatgpt', 'home');
  const findings = codexAuth('/unused', { homeDir: home, now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'PASS');
});
