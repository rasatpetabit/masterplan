// test/doctor.test.mjs — v8 L4 doctor: dispatcher + all 12 check modules.
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
import { runChecks, runFixes, parseArgs, discoverChecks } from '../bin/doctor.mjs';
import { check as scalarCap, fix as scalarCapFix } from '../lib/doctor/scalar-cap.mjs';
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
import { check as coordDrift } from '../lib/doctor/coord-drift.mjs';
import { check as ownerSentinel } from '../lib/doctor/owner-sentinel.mjs';
import { check as planDocCruft } from '../lib/doctor/plan-doc-cruft.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { buildOwnerIdentity, ownerLockPath, ownerHeartbeatPath } from '../lib/owner.mjs';

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
  if (args[0] === 'rev-parse') return '.git\n'; // --git-common-dir, resolved against repoRoot by the check
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

test('dispatcher: parseArgs accepts --fix before or after optional repo root', () => {
  const cwd = process.cwd();
  assert.deepEqual(parseArgs(['--fix']), { repoRoot: cwd, fix: true });
  assert.deepEqual(parseArgs(['/repo', '--fix']), { repoRoot: '/repo', fix: true });
  assert.deepEqual(parseArgs(['--fix', '/repo']), { repoRoot: '/repo', fix: true });
  assert.deepEqual(parseArgs(['/repo']), { repoRoot: '/repo', fix: false });
});

test('dispatcher: parseArgs rejects unknown flags and multiple repo roots', () => {
  assert.throws(() => parseArgs(['--wat']), /unknown option/);
  assert.throws(() => parseArgs(['/a', '/b']), /multiple repo roots/);
});

test('dispatcher: runFixes calls optional handlers and crash-isolates thrown fixes', () => {
  const findings = [
    { id: 'safe', severity: 'WARN', summary: 'w', fix: 'f' },
    { id: 'boom', severity: 'WARN', summary: 'w', fix: 'f' },
    { id: 'nofix', severity: 'WARN', summary: 'w', fix: 'f' },
  ];
  const repairs = runFixes([
    { name: 'safe', fix: (_repo, fsIn) => [{ id: 'safe', summary: `saw ${fsIn.length}` }] },
    { name: 'boom', fix: () => { throw new Error('nope'); } },
    { name: 'nofix', fix: null },
  ], '/repo', findings);
  assert.deepEqual(repairs, [
    { id: 'safe', status: 'FIXED', summary: 'saw 1' },
    { id: 'boom', status: 'ERROR', summary: 'fix threw: nope' },
  ]);
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

test('scalar-cap: fix moves overlong flat string scalars to a bundle-local overflow file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-scalar-fix-'));
  const bundleDir = path.join(tmp, 'docs', 'masterplan', 'p1');
  fs.mkdirSync(bundleDir, { recursive: true });
  const longValue = '"' + 'x'.repeat(240) + '"';
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), `slug: p1\ntopic: ${longValue}\nstatus: in-progress\n`, 'utf8');

  assert.equal(maxSeverity(scalarCap(tmp)), 'WARN');
  const repairs = scalarCapFix(tmp);
  assert.equal(repairs.length, 1, JSON.stringify(repairs));
  assert.match(repairs[0].summary, /state-overflow\.md L\d+/);

  const state = fs.readFileSync(path.join(bundleDir, 'state.yml'), 'utf8');
  assert.match(state, /topic: "\*overflow at state-overflow\.md L\d+\*"/);
  const overflow = fs.readFileSync(path.join(bundleDir, 'state-overflow.md'), 'utf8');
  assert.match(overflow, new RegExp(`topic: ${longValue}`));
  assert.equal(maxSeverity(scalarCap(tmp)), 'PASS');
  assert.deepEqual(scalarCapFix(tmp), [], 'second fix run is idempotent');
});

test('scalar-cap: fix leaves overlong structured fields untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-scalar-structured-'));
  const bundleDir = path.join(tmp, 'docs', 'masterplan', 'p1');
  fs.mkdirSync(bundleDir, { recursive: true });
  const tasks = JSON.stringify([{ id: 1, status: 'done', files: ['x'.repeat(240)] }]);
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), `slug: p1\ntasks: ${tasks}\nstatus: in-progress\n`, 'utf8');

  assert.equal(maxSeverity(scalarCap(tmp)), 'WARN');
  assert.deepEqual(scalarCapFix(tmp), []);
  assert.equal(fs.existsSync(path.join(bundleDir, 'state-overflow.md')), false);
  assert.match(fs.readFileSync(path.join(bundleDir, 'state.yml'), 'utf8'), /^tasks: \[/m);
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

test('worktree-integrity: ERROR fix messages prescribe the `mp` verb, not a CD-7 hand-edit', () => {
  // Regression for the fix-message defect (C3): the worktree-missing / branch-missing remediation used to
  // tell the operator to hand-edit state.yml (`worktree_disposition: …` / `status: archived`) — a CD-7
  // violation with (for disposition) no writer at all. The fix now names the verb that performs the write.
  const wt = worktreeIntegrity(path.join(FX, 'worktree-integrity', 'error-missing-worktree'), { gitExec: GIT_STUB });
  const wtErr = wt.find((f) => f.severity === 'ERROR' && /worktree/.test(f.summary));
  assert.ok(wtErr, JSON.stringify(wt));
  assert.match(wtErr.fix, /mp set-worktree-disposition .*--disposition=removed_after_merge/);
  assert.doesNotMatch(wtErr.fix, /in the bundle state\.yml/); // no hand-edit prescription survives

  const br = worktreeIntegrity(path.join(FX, 'worktree-integrity', 'error-missing-branch'), { gitExec: GIT_STUB });
  const brErr = br.find((f) => f.severity === 'ERROR' && /branch/.test(f.summary));
  assert.ok(brErr, JSON.stringify(br));
  assert.match(brErr.fix, /mp set-status .*--status=archived/);
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

test('worktree-integrity: git->bundle reconcile surfaces strays as WARN (foreign-leftover / repo-move dedup / crash-leak / legacy-missing)', () => {
  // Phase 2: the doctor runs the SAME pure classifyWorktrees `mp worktree reconcile` does, so on-disk
  // strays the per-bundle loop structurally cannot see become WARNs — and a recoverable repo-move or a
  // legacy `missing` disposition is reported ONCE (as the WARN remedy), never also as a bundle->git ERROR.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wt-recon-'));
  const wt = (name, gitdir) => {
    const d = path.join(tmp, '.worktrees', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.git'), `gitdir: ${gitdir}\n`); // a linked worktree's .git is a FILE
    return d;
  };
  const movedPath = wt('moved', path.join(tmp, '.git', 'worktrees', 'moved')); // into repo, unregistered -> repo-move
  const crashedPath = wt('crashed', path.join(tmp, '.git', 'worktrees', 'crashed')); // into repo, registered+retired -> crash-leak
  // The foreign target must EXIST on disk so canonicalization can PROVE it foreign — an unresolvable
  // target is left untouched as foreign-unverified, never auto-removed (the Codex realpath BLOCKER).
  const foreignAdmin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-foreign-')), '.git', 'worktrees', 'cc3');
  fs.mkdirSync(foreignAdmin, { recursive: true });
  wt('cc3', foreignAdmin); // foreign target that resolves outside the repo -> foreign-leftover
  const bundle = (slug, body) => {
    const d = path.join(tmp, 'docs', 'masterplan', slug);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.yml'), body);
  };
  bundle('movedbundle', `slug: movedbundle\nstatus: in-progress\nworktree: ${movedPath}\n`);
  bundle('crashedbundle', `slug: crashedbundle\nstatus: in-progress\nworktree: ${crashedPath}\nworktree_disposition: removed_after_merge\n`);
  bundle('legacy', `slug: legacy\nstatus: in-progress\nworktree: /repo/.worktrees/legacy\nworktree_disposition: missing\n`);

  // git knows only the main checkout + the crash-leak worktree (moved/cc3 are unregistered strays).
  const gitExec = (args) => {
    if (args[0] === 'worktree') return `worktree ${tmp}\nworktree ${crashedPath}\n`;
    if (args[0] === 'branch') return 'main\n';
    if (args[0] === 'rev-parse') return '.git\n'; // --git-common-dir -> resolves to tmp/.git (the admin root)
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
  const findings = worktreeIntegrity(tmp, { gitExec });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.ok(!findings.some((f) => f.severity === 'ERROR'),
    `no bundle->git ERROR survives: legacy normalizes + moved is a handled repo-move — ${JSON.stringify(findings)}`);
  const sums = findings.filter((f) => f.severity === 'WARN').map((f) => f.summary).join('\n');
  assert.match(sums, /foreign-repo leftover/, 'cc3 foreign-leftover WARN');
  assert.match(sums, /repo-move/, 'moved repo-move WARN');
  assert.match(sums, /crash-leak/, 'crashed crash-leak WARN');
  assert.match(sums, /legacy phantom value/, 'legacy `missing` normalize WARN');
});

test('worktree-integrity: a linked-cwd run classifies an on-disk retired worktree as crash-leak, NOT prune (the two-roots fix)', () => {
  // Codex Round-2 MAJOR: when the doctor runs INSIDE a linked worktree, repoGitDir resolves to the
  // COMMON (main) .git, but the disk + bundle scan must use that SAME main root. Scanning the linked
  // checkout's (empty) .worktrees instead made a retired worktree still ON DISK under main/.worktrees
  // look gone -> mis-emit `prune` instead of `crash-leak`. mainRepoRoot = dirname(commonGitDir) unifies
  // the three classifier inputs.
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-main-'));
  const wt = (root, name, gitdir) => {
    const d = path.join(root, '.worktrees', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.git'), `gitdir: ${gitdir}\n`);
    return d;
  };
  const oldPath = wt(main, 'old', path.join(main, '.git', 'worktrees', 'old')); // on disk, registered, retired
  const devPath = wt(main, 'dev', path.join(main, '.git', 'worktrees', 'dev')); // the linked checkout we run FROM
  // The retired bundle that owns `old`, visible from BOTH checkouts (a committed bundle).
  for (const repo of [main, devPath]) {
    const d = path.join(repo, 'docs', 'masterplan', 'old');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.yml'),
      `slug: old\nstatus: archived\nworktree: ${oldPath}\nworktree_disposition: removed_after_merge\n`);
  }
  // Run FROM the linked checkout: --git-common-dir reports the ABSOLUTE main .git (not cwd's .git FILE).
  const gitExec = (args) => {
    if (args[0] === 'worktree') return `worktree ${main}\nworktree ${oldPath}\nworktree ${devPath}\n`;
    if (args[0] === 'branch') return 'main\n';
    if (args[0] === 'rev-parse') return `${main}/.git\n`; // common git dir = MAIN's .git (absolute)
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
  const findings = worktreeIntegrity(devPath, { gitExec });
  assertFindingShape(findings);
  const sums = findings.map((f) => f.summary).join('\n');
  assert.match(sums, /crash-leak/, `on-disk retired worktree must be crash-leak — ${JSON.stringify(findings)}`);
  assert.ok(!/dangling admin entry/.test(sums), `must NOT mis-emit prune from a linked cwd — ${JSON.stringify(findings)}`);
});

test('worktree-integrity: a LIVE bundle\'s unregistered, foreign-resolving worktree surfaces a manual WARN AND still earns the bundle->git ERROR (Codex Round-2 BLOCKER)', () => {
  // Codex Round-2 BLOCKER: a live (non-retired) run whose worktree git lost the registration AND whose
  // .git resolves PROVABLY foreign must NOT be auto-removed — it gets classifyWorktrees `manual`
  // (active-unregistered), which is NOT in handledPaths (only `repair` repo-moves suppress the ERROR), so
  // the per-bundle bundle->git ERROR "is not a registered git worktree" STILL fires. Suppressing it would
  // hide a real broken live reference; auto-removing it would be silent mid-run data loss.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wt-live-'));
  // The repo's own admin dir EXISTS so repoGitDirCanonical resolves — making the foreign .git below
  // PROVABLY foreign. The live-bundle claim must override the `remove` ladder even then.
  fs.mkdirSync(path.join(tmp, '.git', 'worktrees'), { recursive: true });
  const liveDir = path.join(tmp, '.worktrees', 'livewt');
  fs.mkdirSync(liveDir, { recursive: true });
  // .git points at a foreign admin dir that EXISTS on disk → canonicalization PROVES it foreign. Even so,
  // the live bundle claim must override the `remove` ladder and force `manual`.
  const foreignAdmin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-foreign-live-')), '.git', 'worktrees', 'livewt');
  fs.mkdirSync(foreignAdmin, { recursive: true });
  fs.writeFileSync(path.join(liveDir, '.git'), `gitdir: ${foreignAdmin}\n`);
  const bdir = path.join(tmp, 'docs', 'masterplan', 'livebundle');
  fs.mkdirSync(bdir, { recursive: true });
  // in-progress, NO retired disposition → a genuinely live reference (rec && !recRetired).
  fs.writeFileSync(path.join(bdir, 'state.yml'), `slug: livebundle\nstatus: in-progress\nworktree: ${liveDir}\n`);

  // git knows ONLY the main checkout — livewt is an unregistered stray AND absent from `worktree list`.
  const gitExec = (args) => {
    if (args[0] === 'worktree') return `worktree ${tmp}\n`;
    if (args[0] === 'branch') return 'main\n';
    if (args[0] === 'rev-parse') return '.git\n';
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
  const findings = worktreeIntegrity(tmp, { gitExec });
  assertFindingShape(findings);
  // The manual WARN surfaces the live-bundle stray for human restore — never auto-removed.
  const manualWarn = findings.find((f) => f.severity === 'WARN' && /claimed by a LIVE bundle/.test(f.summary));
  assert.ok(manualWarn, `active-unregistered manual WARN must surface — ${JSON.stringify(findings)}`);
  assert.match(manualWarn.fix, /git worktree repair/, 'manual fix restores, never removes');
  assert.doesNotMatch(manualWarn.summary, /foreign-repo leftover/, 'must NOT be classified as a removable foreign-leftover');
  // The bundle->git ERROR is NOT suppressed (active-unregistered is not in handledPaths).
  const liveErr = findings.find((f) => f.severity === 'ERROR' && /livebundle/.test(f.summary) && /not a registered git worktree/.test(f.summary));
  assert.ok(liveErr, `bundle->git ERROR must still fire for the live unregistered worktree — ${JSON.stringify(findings)}`);
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

test('codex-plugin-presence: WARN fix cites `mp set-codex-config` (CD-7-honest; no flat-key hand-edit)', () => {
  // The fix the doctor emits when a bundle wants codex but the plugin is absent must name the `mp` writer
  // and the NESTED codex.{routing,review} the dispatch path reads — not the old `set codex_routing: off ...`
  // flat hand-edit (CD-7-violating AND ineffective: flat keys never reach the dispatch layer).
  const root = path.join(FX, 'codex-plugin-presence', 'warn-wants-no-plugin');
  const findings = codexPluginPresence(root, { homeDir: path.join(root, 'home') });
  const warn = findings.find((f) => f.severity === 'WARN');
  assert.ok(warn, JSON.stringify(findings));
  assert.match(warn.fix, /mp set-codex-config .*--routing=off --review=false/); // the verb, nested-aware
  assert.doesNotMatch(warn.fix, /set codex_routing: off and codex_review: false/); // old CD-7-violating advice
});

test('codex-plugin-presence: flat codex_routing:off (no nested) is NOT trusted as off — mirrors dispatch (Residual 4)', () => {
  // The keystone divergence-closer. A bundle with a FLAT `codex_routing: off` and NO nested codex
  // object used to SKIP (the old wantsCodex honored the flat key) — but dispatch (bin:381) reads the
  // nested object ONLY and falls through to routing='auto', so codex STILL routes. wantsCodex now
  // mirrors dispatch: the flat key is dead input, routing defaults to 'auto' → the bundle "wants" codex
  // → WARN when the plugin is absent, NOT a silent SKIP. This case PASSED (as SKIP) under the old code;
  // asserting WARN here is what closes Residual 4. (The `warn-flat-off-ignored` fixture also drives the
  // dir-prefix scenario loop above — this named test pins the intent + the not-SKIP invariant.)
  const root = path.join(FX, 'codex-plugin-presence', 'warn-flat-off-ignored');
  const findings = codexPluginPresence(root, { homeDir: path.join(root, 'home') });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.ok(!findings.some((f) => f.severity === 'SKIP'),
    'flat-only codex_routing:off must NOT produce a SKIP (that was the Residual 4 false-negative)');
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

test('index-staleness: stale state.plan_hash fix-text names `mp migrate-bundle`, not a phantom plan-index command (fix-text defect)', () => {
  // Regression for a verified non-completing fix-text defect. The old :71 fix prescribed "re-index
  // with the plan-index command to refresh plan_hash in state.yml", but NO command writes
  // state.plan_hash (build-index writes plan.index.json only), so following it never cleared the
  // WARN. The remedy that actually clears a stale legacy state.plan_hash is `mp migrate-bundle` —
  // migrate whitelist-rebuilds state.yml and DROPS plan_hash (proven empirically). WL:84's
  // dormant-gap finding stands; this branch is legacy-only and this guards the fix-text accuracy.
  const findings = indexStaleness(path.join(FX, 'index-staleness', 'warn-stale-state-hash'));
  assertFindingShape(findings);
  const warns = findings.filter((f) => f.severity === 'WARN');
  assert.equal(warns.length, 1, `expected exactly one state.plan_hash WARN, got ${JSON.stringify(findings)}`);
  assert.match(warns[0].fix, /migrate-bundle/, 'fix must name the actionable `mp migrate-bundle` remedy');
  assert.ok(!/plan-index command/.test(warns[0].fix),
    'fix must NOT name the phantom "plan-index command" that writes the wrong file (the original defect)');
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

// ---- coord-drift (plan-scoped, coordination state drift) --------------------

test('coord-drift: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('coord-drift')) {
    await t.test(sc, () => {
      const findings = coordDrift(path.join(FX, 'coord-drift', sc));
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('coord-drift: SKIP when no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cd-'));
  const findings = coordDrift(tmp);
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('coord-drift: SKIP when bundles exist but none are coordinated', () => {
  const findings = coordDrift(path.join(FX, 'coord-drift', 'skip-no-coord'));
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
  assert.match(findings[0].summary, /no coordinated run bundles/);
});

test('coord-drift: WARN for orphan claim (claimed with no PR)', () => {
  const findings = coordDrift(path.join(FX, 'coord-drift', 'warn-orphan-claim'));
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  const warn = findings.find((f) => f.severity === 'WARN');
  assert.ok(warn, 'expected a WARN finding');
  assert.match(warn.summary, /orphan claim/);
});

test('coord-drift: WARN for done-but-not-merged task', () => {
  const findings = coordDrift(path.join(FX, 'coord-drift', 'warn-done-but-open'));
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  const warn = findings.find((f) => f.severity === 'WARN');
  assert.ok(warn, 'expected a WARN finding');
  assert.match(warn.summary, /locally done but issue_map status/);
});

test('coord-drift: PASS for a clean coordinated bundle', () => {
  const findings = coordDrift(path.join(FX, 'coord-drift', 'pass-clean'));
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

// ---- owner-sentinel (Guard D: stale/corrupt owner locks; recorded-ts based, injected clock) ----

// Build a bundle dir under a tmp repoRoot with an owner lock acquired at `acquiredAt`.
function ownerBundle(slug, self, acquiredAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-own-'));
  const bundleDir = path.join(root, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  acquireOwner(bundleDir, self, { now: acquiredAt });
  return { root, bundleDir };
}
const OWNER = (now) => buildOwnerIdentity({ host: 'epyc1', session: 'sess-A', slug: 'p', now });

test('owner-sentinel: SKIP when no run bundles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-own-skip-'));
  const findings = ownerSentinel(tmp, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('owner-sentinel: PASS for a fresh (within-TTL) lock', () => {
  const { root } = ownerBundle('p', OWNER(NOW), NOW);
  const findings = ownerSentinel(root, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('owner-sentinel: WARN for a stale (past-TTL) lock; fix recommends release-owner --force', () => {
  const { root } = ownerBundle('p', OWNER(NOW - 5_000_000), NOW - 5_000_000);
  const findings = ownerSentinel(root, { now: NOW, ttlMs: 1_000 });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings.find((f) => f.severity === 'WARN').fix, /release-owner .*--force/);
});

test('owner-sentinel: WARN for a corrupt lock', () => {
  const { root, bundleDir } = ownerBundle('p', OWNER(NOW), NOW);
  fs.writeFileSync(ownerLockPath(bundleDir), '{not json');
  const findings = ownerSentinel(root, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings.find((f) => f.severity === 'WARN').summary, /corrupt/);
});

test('owner-sentinel: WARN for an orphan heartbeat file with no lock', () => {
  const { root, bundleDir } = ownerBundle('p', OWNER(NOW), NOW);
  fs.unlinkSync(ownerLockPath(bundleDir)); // remove the lock, leave the hb behind
  assert.ok(fs.existsSync(ownerHeartbeatPath(bundleDir, OWNER(NOW))));
  const findings = ownerSentinel(root, { now: NOW });
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'WARN', JSON.stringify(findings));
  assert.match(findings.find((f) => f.severity === 'WARN').summary, /orphan/);
});

// ---- dispatcher: all 14 modules auto-discovered ----------------------------

test('dispatcher: discovers all 14 check modules', async () => {
  const checks = await discoverChecks(path.join(here, '..', 'lib', 'doctor'));
  const names = checks.map((c) => c.name);
  const expected = [
    'codex-auth', 'codex-plugin-presence', 'coord-drift', 'index-staleness', 'legacy-bundle',
    'owner-sentinel', 'plan-doc-cruft', 'plan-index-schema', 'plugin-registry-drift', 'scalar-cap',
    'stale-codex-task', 'stale-lock', 'state-schema', 'worktree-integrity',
  ];
  for (const n of expected) {
    assert.ok(names.includes(n), `discovered ${n}`);
  }
  assert.equal(names.length, expected.length, `expected ${expected.length} checks, found ${names.length}: ${names.join(', ')}`);
});

// ---- plan-doc-cruft (#14, WARN) ------------------------------------------------

test('plan-doc-cruft: fixtures match dir-prefix severity', async (t) => {
  for (const sc of scenarios('plan-doc-cruft')) {
    await t.test(sc, () => {
      const findings = planDocCruft(path.join(FX, 'plan-doc-cruft', sc));
      assertFindingShape(findings);
      assert.equal(maxSeverity(findings), expectedSeverity(sc), JSON.stringify(findings));
    });
  }
});

test('plan-doc-cruft: SKIP when no runs dir at all', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pdc-'));
  const findings = planDocCruft(tmp);
  assertFindingShape(findings);
  assert.equal(maxSeverity(findings), 'SKIP');
});

test('plan-doc-cruft: WARN names the offending file, slug, and signal; fix points at the finish gate', () => {
  const bySignal = {
    'warn-slug-in-filename': /t9-cleanup \(filename\)/,
    'warn-plan-path-reference': /t9-cleanup \(bundle-path reference\)/,
    'warn-slug-in-heading': /t9-cleanup \(heading\)/,
  };
  for (const [sc, re] of Object.entries(bySignal)) {
    const findings = planDocCruft(path.join(FX, 'plan-doc-cruft', sc));
    const warns = findings.filter((f) => f.severity === 'WARN');
    assert.equal(warns.length, 1, `${sc}: exactly one offending file — ${JSON.stringify(findings)}`);
    assert.match(warns[0].summary, re, sc);
    assert.match(warns[0].fix, /docs_normalize/, `${sc}: fix routes future runs at the finish gate`);
  }
});

test('plan-doc-cruft: slug matches whole tokens only (no substring false positives)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pdc-tok-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'masterplan', 't9'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'masterplan', 't9', 'state.yml'),
    'schema_version: 6\nslug: t9\nstatus: archived\nphase: building\n');
  // "t9x" and "at9" embed the slug but are not whole tokens; "t9-design.md" IS (hyphen boundary).
  fs.writeFileSync(path.join(tmp, 'docs', 'at9x-notes.md'), '# notes\n\nmentions t9x and at9 only.\n');
  const clean = planDocCruft(tmp);
  assert.equal(maxSeverity(clean), 'PASS', JSON.stringify(clean));
  fs.writeFileSync(path.join(tmp, 'docs', 't9-design.md'), '# design\n');
  const hit = planDocCruft(tmp);
  assert.equal(maxSeverity(hit), 'WARN', JSON.stringify(hit));
  const warns = hit.filter((f) => f.severity === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(warns[0].summary, /t9-design\.md/);
});

test('plan-doc-cruft: single-word slugs never match headings (hyphenated-only signal)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pdc-head-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'masterplan', 'cleanup'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'masterplan', 'cleanup', 'state.yml'),
    'schema_version: 6\nslug: cleanup\nstatus: archived\nphase: building\n');
  fs.writeFileSync(path.join(tmp, 'docs', 'guide.md'), '# Repo cleanup guide\n\nProse about cleanup.\n');
  const findings = planDocCruft(tmp);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});

test('plan-doc-cruft: dot-directories and node_modules are never scanned', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pdc-dot-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'masterplan', 't9-cleanup'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'masterplan', 't9-cleanup', 'state.yml'),
    'schema_version: 6\nslug: t9-cleanup\nstatus: archived\nphase: building\n');
  for (const dir of ['.claude/plans', '.worktrees/x/docs', 'node_modules/pkg']) {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, dir, 't9-cleanup-design.md'), '# t9-cleanup\n');
  }
  const findings = planDocCruft(tmp);
  assert.equal(maxSeverity(findings), 'PASS', JSON.stringify(findings));
});
