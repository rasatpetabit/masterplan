// test/doctor.test.mjs — v8 L4 doctor: dispatcher + all 11 check modules.
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
import { createHash } from 'node:crypto';
import { runChecks, discoverChecks } from '../bin/doctor.mjs';
import { check as scalarCap } from '../lib/doctor/scalar-cap.mjs';
import { check as worktreeIntegrity } from '../lib/doctor/worktree-integrity.mjs';
import { check as codexAuth } from '../lib/doctor/codex-auth.mjs';
import { check as stateSchema } from '../lib/doctor/state-schema.mjs';
import { check as legacyBundle } from '../lib/doctor/legacy-bundle.mjs';
import { check as codexPluginPresence } from '../lib/doctor/codex-plugin-presence.mjs';
import { check as indexStaleness } from '../lib/doctor/index-staleness.mjs';
import { check as staleLock } from '../lib/doctor/stale-lock.mjs';
import { check as staleCodexTask } from '../lib/doctor/stale-codex-task.mjs';
import { check as pluginRegistryDrift } from '../lib/doctor/plugin-registry-drift.mjs';
import { check as planIndexSchema } from '../lib/doctor/plan-index-schema.mjs';

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
  assertFindingShape(findings);
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
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
  assert.match(findings[0].summary, /git unavailable/);
});

test('worktree-integrity: SKIP when there are no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wt-'));
  const findings = worktreeIntegrity(tmp, { gitExec: GIT_STUB });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
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

// ---- state-schema (plan-scoped, uses validateCoreState) ----------------------

test('state-schema: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('state-schema')) {
    await t.test(sc, () => {
      const findings = stateSchema(path.join(FX, 'state-schema', sc));
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('state-schema: SKIP when there are no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ss-'));
  const findings = stateSchema(tmp);
  assertFindingShape(findings); // guards the >=1-finding contract: maxSeverity([]) would falsely read 'SKIP'
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('state-schema: legacy bundle (schema_version < 6) is silently skipped (not double-reported)', () => {
  // pass-legacy-schema fixture has schema_version: 3 — state-schema defers to legacy-bundle.mjs
  // so it produces PASS (no ERRORs raised, validateCoreState never fires on this bundle).
  const findings = stateSchema(path.join(FX, 'state-schema', 'pass-legacy-schema'));
  assertFindingShape(findings);
  assert.ok(!findings.some((f) => f.severity === 'ERROR'), 'no ERROR for legacy bundle');
  assert.equal(maxSeverity(findings), 'PASS', 'silent-skip of legacy bundle leaves all-pass result');
});

test('state-schema: WARN (not silent skip) for a slug dir missing state.yml (Codex #4)', () => {
  // A slug dir with no readable state.yml is an orphan/incomplete bundle. Previously skipped
  // silently → an all-orphan docs/masterplan falsely returned PASS. Now it must WARN (exit 0).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ss-orphan-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'masterplan', 'orphan-slug'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'masterplan', 'orphan-slug', 'plan.md'), '# Plan\n');
  const findings = stateSchema(tmp);
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings[0].summary, /state\.yml is missing or unreadable/);
});

// ---- legacy-bundle (#1, WARN) ------------------------------------------------

test('legacy-bundle: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('legacy-bundle')) {
    await t.test(sc, () => {
      const findings = legacyBundle(path.join(FX, 'legacy-bundle', sc));
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('legacy-bundle: SKIP when no bundles and no docs/superpowers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lb-'));
  const findings = legacyBundle(tmp);
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('legacy-bundle: WARN when docs/superpowers contains actual artifacts (no bundle slugs)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lb-sp-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'superpowers', 'plans', 'foo.md'), '# legacy artifact');
  const findings = legacyBundle(tmp);
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN');
});

test('legacy-bundle: no WARN when docs/superpowers is empty container (no bundle slugs)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lb-sp-empty-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'superpowers', 'old'), { recursive: true });
  const findings = legacyBundle(tmp);
  assertFindingShape(findings);
  assert.ok(!findings.some((f) => f.severity === 'WARN' || f.severity === 'ERROR'),
    'empty docs/superpowers container must not produce WARN or ERROR');
});

// ---- codex-plugin-presence (hybrid: plan-scoped + host-path) ----------------

test('codex-plugin-presence: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('codex-plugin-presence')) {
    await t.test(sc, () => {
      const root = path.join(FX, 'codex-plugin-presence', sc);
      const home = path.join(root, 'home');
      const findings = codexPluginPresence(root, { homeDir: home });
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('codex-plugin-presence: SKIP when no bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cpp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cpp-home-'));
  const findings = codexPluginPresence(tmp, { homeDir: home });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

// ---- index-staleness (plan-scoped, node:crypto) ------------------------------

test('index-staleness: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('index-staleness')) {
    await t.test(sc, () => {
      const findings = indexStaleness(path.join(FX, 'index-staleness', sc));
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('index-staleness: SKIP when no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-is-'));
  const findings = indexStaleness(tmp);
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('index-staleness: PASS when plan.md has no recorded hash (not yet indexed)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-is-nohash-'));
  const bundleDir = path.join(tmp, 'docs', 'masterplan', 'p1');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'plan.md'), '# Plan\n', 'utf8');
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), 'schema_version: 6\nslug: p1\nstatus: in-progress\nphase: building\n', 'utf8');
  // No plan_hash in state.yml, no plan.index.json → should PASS (no recorded hash to compare)
  assert.equal(maxSeverity(indexStaleness(tmp)), 'PASS');
});

test('index-staleness: WARN via plan.index.json fallback when hash stale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-is-idx-'));
  const bundleDir = path.join(tmp, 'docs', 'masterplan', 'p1');
  fs.mkdirSync(bundleDir, { recursive: true });
  const planContent = '# Plan\nSome content\n';
  fs.writeFileSync(path.join(bundleDir, 'plan.md'), planContent, 'utf8');
  // state.yml with no plan_hash → falls through to plan.index.json
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), 'schema_version: 6\nslug: p1\nstatus: in-progress\nphase: building\n', 'utf8');
  // plan.index.json with a stale (wrong) hash
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ plan_hash: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), 'utf8');
  assert.equal(maxSeverity(indexStaleness(tmp)), 'WARN');
});

test('index-staleness: PASS via plan.index.json fallback when hash matches', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-is-idxok-'));
  const bundleDir = path.join(tmp, 'docs', 'masterplan', 'p1');
  fs.mkdirSync(bundleDir, { recursive: true });
  const planContent = '# Plan\nSome content\n';
  const planPath = path.join(bundleDir, 'plan.md');
  fs.writeFileSync(planPath, planContent, 'utf8');
  // Compute actual hash of the file
  const actualHash = createHash('sha256').update(fs.readFileSync(planPath)).digest('hex');
  // state.yml with no plan_hash → falls through to plan.index.json
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), 'schema_version: 6\nslug: p1\nstatus: in-progress\nphase: building\n', 'utf8');
  // plan.index.json with matching hash
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ plan_hash: actualHash }), 'utf8');
  assert.equal(maxSeverity(indexStaleness(tmp)), 'PASS');
});

// ---- stale-lock (mtime-based, injected clock) --------------------------------

test('stale-lock: WARN for stale .lock (mtime set 2h ago via utimesSync)', () => {
  const root = path.join(FX, 'stale-lock', 'warn-stale');
  const lockPath = path.join(root, 'docs', 'masterplan', 'p1', '.lock');
  // Force mtime to 2 hours before NOW (stale)
  const staleDate = new Date(NOW - 2 * 3_600_000);
  fs.utimesSync(lockPath, staleDate, staleDate);
  const findings = staleLock(root, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
});

test('stale-lock: PASS when .lock is fresh (mtime set 10m ago)', () => {
  const root = path.join(FX, 'stale-lock', 'warn-stale');
  const lockPath = path.join(root, 'docs', 'masterplan', 'p1', '.lock');
  // Reset mtime to 10 minutes ago (fresh)
  const freshDate = new Date(NOW - 10 * 60_000);
  fs.utimesSync(lockPath, freshDate, freshDate);
  const findings = staleLock(root, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('stale-lock: PASS when no .lock file exists', () => {
  const root = path.join(FX, 'stale-lock', 'pass-nolock');
  const findings = staleLock(root, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS');
});

test('stale-lock: SKIP when no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sl-'));
  const findings = staleLock(tmp, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

// ---- stale-codex-task (user-scoped, injected homeDir/now) -------------------

test('stale-codex-task: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('stale-codex-task')) {
    await t.test(sc, () => {
      const home = path.join(FX, 'stale-codex-task', sc, 'home');
      const findings = staleCodexTask('/unused', { homeDir: home, now: NOW });
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('stale-codex-task: SKIP when data dir absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sct-'));
  const findings = staleCodexTask('/unused', { homeDir: tmp, now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('stale-codex-task: PASS for non-terminal job started <24h ago', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sct-fresh-'));
  const jobsDir = path.join(tmp, '.claude', 'plugins', 'data', 'myplugin', 'state', 'run1', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  // startedAt = 12 hours ago (within 24h threshold)
  const freshStart = new Date(NOW - 12 * 3_600_000).toISOString();
  fs.writeFileSync(path.join(jobsDir, 'j1.json'), JSON.stringify({ id: 'j1', status: 'verifying', startedAt: freshStart }));
  const findings = staleCodexTask('/unused', { homeDir: tmp, now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS');
});

// ---- plugin-registry-drift (user-scoped, injected homeDir) ------------------

test('plugin-registry-drift: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('plugin-registry-drift')) {
    await t.test(sc, () => {
      const home = path.join(FX, 'plugin-registry-drift', sc, 'home');
      const findings = pluginRegistryDrift('/unused', { homeDir: home });
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('plugin-registry-drift: SKIP when installed_plugins.json absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-prd-'));
  const findings = pluginRegistryDrift('/unused', { homeDir: tmp });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('plugin-registry-drift: SKIP when masterplan entry absent from registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-prd-noentry-'));
  const pluginsDir = path.join(tmp, '.claude', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
  const findings = pluginRegistryDrift('/unused', { homeDir: tmp });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

// ---- plugin-registry-drift: same-version stale cache (Codex #1, injected gitExec) -----------
// The pass-match fixture has installed.version === marketplace.version === 7.2.3 and records
// gitCommitSha 'def5678'. With versions equal, the gitCommitSha-vs-HEAD compare decides. The
// auto-discovery harness above passes no gitExec, so these paths are only reachable inline.

const PRD_MATCH_HOME = path.join(FX, 'plugin-registry-drift', 'pass-match', 'home');

test('plugin-registry-drift: PASS when versions match and installed sha == marketplace HEAD', () => {
  const findings = pluginRegistryDrift('/unused', { homeDir: PRD_MATCH_HOME, gitExec: () => 'def5678' });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('plugin-registry-drift: WARN when versions match but installed sha != marketplace HEAD (stale cache)', () => {
  const findings = pluginRegistryDrift('/unused', {
    homeDir: PRD_MATCH_HOME,
    gitExec: () => 'fed8765aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings[0].summary, /stale/);
});

test('plugin-registry-drift: PASS (graceful) when git HEAD is unavailable', () => {
  // gitExec returns null (no .git / git absent) → fall through to version-only match.
  const findings = pluginRegistryDrift('/unused', { homeDir: PRD_MATCH_HOME, gitExec: () => null });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('plugin-registry-drift: PASS (graceful) when gitExec throws', () => {
  const findings = pluginRegistryDrift('/unused', {
    homeDir: PRD_MATCH_HOME,
    gitExec: () => { throw new Error('not a git repository'); },
  });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('plugin-registry-drift: PASS when entry has no gitCommitSha (nothing to compare)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-prd-nosha-'));
  const pluginsDir = path.join(tmp, '.claude', 'plugins');
  const mktDir = path.join(pluginsDir, 'marketplaces', 'rasatpetabit-masterplan', '.claude-plugin');
  fs.mkdirSync(mktDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'masterplan@rasatpetabit-masterplan': [{ version: '7.2.3' }] } }));
  fs.writeFileSync(path.join(mktDir, 'plugin.json'), JSON.stringify({ name: 'masterplan', version: '7.2.3' }));
  // gitExec returns a sha, but the recorded sha is absent → no compare → PASS.
  const findings = pluginRegistryDrift('/unused', { homeDir: tmp, gitExec: () => 'anysha123' });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

// ---- plan-index-schema: the parallel-planning anomaly guard ----------------
// Built in-code with tmp bundles (not committed fixtures): the canonical-vs-legacy schema gate
// and the object-codex / same-wave-overlap WARNs are the load-bearing paths, and a tmp repo
// exercises resolveRunsDir(repoRoot) end-to-end the way a real `doctor` run does.

function pisRepo(bundles = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pis-'));
  for (const [slug, index] of Object.entries(bundles)) {
    const dir = path.join(tmp, 'docs', 'masterplan', slug);
    fs.mkdirSync(dir, { recursive: true });
    const body = typeof index === 'string' ? index : JSON.stringify(index, null, 2);
    fs.writeFileSync(path.join(dir, 'plan.index.json'), body);
  }
  return tmp;
}
const PIS_TASK = (over = {}) => ({ id: 1, description: 'do a thing', wave: 0, files: ['a.js'], verify_commands: ['t a'], codex: null, ...over });

test('plan-index-schema: SKIP when no run bundles exist', () => {
  const findings = planIndexSchema(pisRepo());
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP', JSON.stringify(findings));
});

test('plan-index-schema: PASS for a clean canonical index', () => {
  const findings = planIndexSchema(pisRepo({ ok: { schema_version: '6.0', tasks: [PIS_TASK()] } }));
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('plan-index-schema: WARN on object codex (anomaly 1 — silent routing fallthrough)', () => {
  const findings = planIndexSchema(pisRepo({
    bad: { schema_version: '6.0', tasks: [PIS_TASK({ codex: { eligible: true } })] },
  }));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings.find((f) => f.severity === 'WARN').summary, /codex/);
});

test('plan-index-schema: WARN on same-wave file overlap (anomaly 2 — re-waved index)', () => {
  const findings = planIndexSchema(pisRepo({
    bad: { schema_version: '6.0', tasks: [
      PIS_TASK({ id: 1, files: ['shared.js'] }),
      PIS_TASK({ id: 2, files: ['shared.js'] }),
    ] },
  }));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
});

test('plan-index-schema: WARN on malformed JSON, even with no canonical index present', () => {
  const findings = planIndexSchema(pisRepo({ broke: '{ not json' }));
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings[0].summary, /not valid JSON/);
});

test('plan-index-schema: SKIP for a legacy pre-6 index (migrate\'s concern, not a schema violation)', () => {
  // schema 5.0 legacy shape (idx/parallel_group/boolean codex) the validator must NOT flag.
  const findings = planIndexSchema(pisRepo({
    legacy: { schema_version: '5.0', tasks: [{ idx: 1, name: 'x', parallel_group: 0, codex: false }] },
  }));
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP', JSON.stringify(findings));
});

// ---- dispatcher: all 11 modules auto-discovered ----------------------------

test('dispatcher: discovers all 11 check modules', async () => {
  const checks = await discoverChecks(path.join(here, '..', 'lib', 'doctor'));
  const names = checks.map((c) => c.name);
  const expected = [
    'codex-auth', 'codex-plugin-presence', 'index-staleness', 'legacy-bundle',
    'plan-index-schema', 'plugin-registry-drift', 'scalar-cap', 'stale-codex-task',
    'stale-lock', 'state-schema', 'worktree-integrity',
  ];
  for (const n of expected) {
    assert.ok(names.includes(n), `discovered ${n}`);
  }
  assert.equal(names.length, expected.length, `expected ${expected.length} checks, found ${names.length}: ${names.join(', ')}`);
});
