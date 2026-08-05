// test/wave-integrity.test.mjs — cross-locus watch-list integrity (spec §3, task 9).
//
// These tests exist because verifyScope has three structural blind spots, and a check
// that only *claims* to close them is worthless. So every test here plants a real breach
// in a real git repo and asserts it is caught — plus a negative control per breach, so a
// check that simply returned {ok:false} always would fail the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  parsePorcelainV2Entry,
  snapshotRepoState,
  buildWatchList,
  snapshotWatchList,
  precheckWatchList,
  verifyWatchListDelta,
  captureWatchBaseline,
  writeWatchBaseline,
  readWatchBaseline,
  watchBaselinePath,
} from '../lib/wave-commit.mjs';

const git = (dir, ...args) =>
  String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();

function makeRepo(prefix = 'wave-integrity-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const cleanup = [];
const tmpRepo = (p) => {
  const d = makeRepo(p);
  cleanup.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── porcelain v2 parsing ────────────────────────────────────────────────────

test('parsePorcelainV2Entry handles every record kind, including paths with spaces', () => {
  const cases = [
    ['1 .M N... 100644 100644 100644 abc def lib/a b.mjs', 'lib/a b.mjs'],
    ['2 R. N... 100644 100644 100644 abc def R100 new name.mjs\told name.mjs', 'new name.mjs'],
    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> — four modes, three hashes.
    ['u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted file.txt', 'conflicted file.txt'],
    ['? untracked file.md', 'untracked file.md'],
    ['! ignored.txt', 'ignored.txt'],
  ];
  for (const [line, expected] of cases) {
    assert.equal(parsePorcelainV2Entry(line)?.path, expected, line);
  }
  assert.equal(parsePorcelainV2Entry('x weird record'), null, 'unknown record kinds are reported, not guessed');
  assert.equal(parsePorcelainV2Entry(''), null);
});

test('snapshotRepoState records HEAD plus status and content hash per dirty path', () => {
  const repo = tmpRepo();
  write(repo, 'tracked.txt', 'v1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add tracked');

  const clean = snapshotRepoState(repo);
  assert.equal(clean.head, git(repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(clean.entries, {}, 'a clean repo has no entries');
  assert.deepEqual(clean.unparsed, []);

  write(repo, 'tracked.txt', 'v2\n');
  write(repo, 'new.txt', 'hello\n');
  const dirty = snapshotRepoState(repo);
  assert.ok(dirty.entries['tracked.txt'], 'modified file is captured');
  assert.ok(dirty.entries['new.txt'], 'untracked file is captured');
  assert.equal(
    dirty.entries['new.txt'].hash,
    crypto.createHash('sha256').update('hello\n').digest('hex'),
  );
});

// ── breach 1: a child commits ───────────────────────────────────────────────

test('a watched repo whose HEAD moved is a violation (a child committed)', () => {
  const repo = tmpRepo();
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);

  write(repo, 'lib/x.mjs', 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'child commit');

  const after = snapshotWatchList(wl);
  const r = verifyWatchListDelta(before, after, ['lib/x.mjs']);
  assert.equal(r.ok, false, 'a commit inside the wave must not pass');
  assert.match(r.violations.find((v) => v.path === '(HEAD)').reason, /HEAD moved/);
});

test('negative control: an in-scope edit with no commit passes', () => {
  const repo = tmpRepo();
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);
  write(repo, 'lib/x.mjs', 'export const x = 1;\n');
  const after = snapshotWatchList(wl);
  assert.deepEqual(verifyWatchListDelta(before, after, ['lib/x.mjs']), { ok: true, violations: [] });
});

// ── breach 2: an already-dirty file is edited ───────────────────────────────

test('precheck refuses to launch when a task-scoped file is already dirty (CD-2)', () => {
  const repo = tmpRepo();
  write(repo, 'lib/user-wip.mjs', 'user work in progress\n');
  const snaps = snapshotWatchList([{ repo, prefix: null, isMain: false }]);

  const blocked = precheckWatchList(snaps, ['lib/user-wip.mjs']);
  assert.equal(blocked.ok, false, 'dispatching over uncommitted user work must be refused');
  assert.match(blocked.violations[0].reason, /already dirty when this run started/);

  const allowed = precheckWatchList(snaps, ['lib/untouched.mjs']);
  assert.equal(allowed.ok, true, 'dirt outside every task scope does not block the launch');
});

test('precheck distinguishes user WIP from a prior attempt\'s residue', () => {
  // The discriminator is the run's frozen launch baseline. Without it, the precheck
  // would block every recover_wave retry: record-result deliberately leaves a failed
  // task's partial edits uncommitted so recover can reset them.
  const repo = tmpRepo();
  write(repo, 'lib/user-wip.mjs', 'user work\n');
  write(repo, 'lib/retry-residue.mjs', 'partial edit from attempt 1\n');
  const snaps = snapshotWatchList([{ repo, prefix: null, isMain: false }]);
  const scope = ['lib/user-wip.mjs', 'lib/retry-residue.mjs'];

  // Baseline frozen at launch contained the user's file only.
  const withBaseline = precheckWatchList(snaps, scope, { baseline: ['lib/user-wip.mjs'] });
  assert.equal(withBaseline.ok, false);
  assert.deepEqual(
    withBaseline.violations.map((v) => v.path),
    ['lib/user-wip.mjs'],
    'only the pre-existing dirt blocks; the retry residue does not',
  );

  // A clean baseline means every scoped file was clean when the run started, so all
  // current dirt is ours.
  assert.equal(precheckWatchList(snaps, scope, { baseline: [] }).ok, true);

  // No baseline at all → conservative: block on any dirt.
  assert.equal(precheckWatchList(snaps, scope).ok, false);
  assert.equal(precheckWatchList(snaps, scope).violations.length, 2);
});

test('an already-dirty file edited during the wave is caught by content hash', () => {
  // This is precisely the case verifyScope cannot see: the path is in `before`, so it is
  // excluded from `touched` and never reaches the out-of-scope test.
  const repo = tmpRepo();
  write(repo, 'notes.md', 'user draft\n');
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);

  write(repo, 'notes.md', 'CLOBBERED BY A CHILD\n');
  const after = snapshotWatchList(wl);

  const r = verifyWatchListDelta(before, after, ['lib/in-scope.mjs']);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /outside every task scope/);

  // ...and the same edit passes when the file IS in scope.
  assert.equal(verifyWatchListDelta(before, after, ['notes.md']).ok, true);
});

test('directory scopes are honoured', () => {
  const repo = tmpRepo();
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);
  write(repo, 'test/fixtures/a.json', '{}\n');
  write(repo, 'test/fixtures/b.json', '{}\n');
  const after = snapshotWatchList(wl);
  assert.equal(verifyWatchListDelta(before, after, ['test/fixtures/']).ok, true);
  assert.equal(verifyWatchListDelta(before, after, ['test/other/']).ok, false);
});

// ── breach 3: a child writes into MAIN ──────────────────────────────────────

function mainWithBundle(slug = 'demo') {
  const main = tmpRepo('wave-integrity-main-');
  const bundleDir = path.join(main, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), 'slug: demo\nphase: execute\nstatus: in-progress\n');
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({ type: 'seed' })}\n`);
  return { main, bundleDir };
}

const mainIo = (main, bundleDir, bundle) => ({
  bundle,
  bundleRel: (rel) => path.relative(bundleDir, path.join(main, rel)),
});

test('MAIN accepts an appended events.jsonl and a controller-shaped state.yml change', () => {
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  const wl = [{ repo: main, prefix: null, isMain: true }];

  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({ type: 'wave_recorded' })}\n`);
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), 'slug: demo\nphase: execute\nstatus: in-progress\nactive_run: null\n');

  const r = verifyWatchListDelta(baseline.snapshots, snapshotWatchList(wl), [], mainIo(main, bundleDir, baseline.bundle));
  assert.deepEqual(r.violations, [], 'the controller\'s own transaction must not trip its own check');
  assert.equal(r.ok, true);
});

test('MAIN rejects a rewritten events.jsonl even when the file grew', () => {
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  // Longer than the baseline, so a length-only check would pass this.
  fs.writeFileSync(
    path.join(bundleDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'forged' })}\n${JSON.stringify({ type: 'forged2' })}\n`,
  );
  const r = verifyWatchListDelta(
    baseline.snapshots,
    snapshotWatchList([{ repo: main, prefix: null, isMain: true }]),
    [],
    mainIo(main, bundleDir, baseline.bundle),
  );
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /rewritten, not appended/);
});

test('MAIN rejects a corrupted (non-JSON) events line', () => {
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), 'this is not json\n');
  const r = verifyWatchListDelta(
    baseline.snapshots,
    snapshotWatchList([{ repo: main, prefix: null, isMain: true }]),
    [],
    mainIo(main, bundleDir, baseline.bundle),
  );
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /not parseable JSON/);
});

test('MAIN rejects a state.yml change outside the controller transaction fields', () => {
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  // `slug` is identity, not a transaction field — a child rewriting it is a breach.
  fs.writeFileSync(path.join(bundleDir, 'state.yml'), 'slug: hijacked\nphase: execute\nstatus: in-progress\n');
  const r = verifyWatchListDelta(
    baseline.snapshots,
    snapshotWatchList([{ repo: main, prefix: null, isMain: true }]),
    [],
    mainIo(main, bundleDir, baseline.bundle),
  );
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /outside the controller transaction: slug/);
});

test('MAIN rejects a write outside the bundle transaction files entirely', () => {
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  write(main, 'src/sneaky.mjs', 'export const oops = true;\n');
  const r = verifyWatchListDelta(
    baseline.snapshots,
    snapshotWatchList([{ repo: main, prefix: null, isMain: true }]),
    [],
    mainIo(main, bundleDir, baseline.bundle),
  );
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /outside the controller's transaction files/);
});

// ── watch list construction + baseline persistence ──────────────────────────

test('buildWatchList always includes MAIN and the run worktree', () => {
  const main = tmpRepo();
  const wl = buildWatchList([], { worktree: main, mainRoot: main, slug: 'demo' });
  assert.ok(wl.length >= 1);
  assert.ok(wl.some((w) => w.isMain), 'MAIN is always watched');
});

test('an unsnapshottable watched repo is a recorded failure, not a silent skip', () => {
  const missing = path.join(os.tmpdir(), 'wave-integrity-does-not-exist');
  const snaps = snapshotWatchList([{ repo: missing, prefix: null, isMain: false }]);
  assert.ok(snaps[missing].error, 'the failure is captured on the snapshot');
  const pre = precheckWatchList(snaps, ['anything']);
  assert.equal(pre.ok, false, 'a repo we cannot read must block the launch');
  const post = verifyWatchListDelta(snaps, snaps, []);
  assert.equal(post.ok, false, '...and must not read as "nothing changed"');
});

test('the launch baseline round-trips through its sidecar file', () => {
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  const written = writeWatchBaseline(bundleDir, 3, baseline);
  assert.equal(written, watchBaselinePath(bundleDir, 3));
  const read = readWatchBaseline(bundleDir, 3);
  assert.equal(read.bundle.eventsBytes, baseline.bundle.eventsBytes);
  assert.equal(read.bundle.eventsSha, baseline.bundle.eventsSha);
  assert.deepEqual(Object.keys(read.snapshots), Object.keys(baseline.snapshots));
  assert.equal(readWatchBaseline(bundleDir, 99), null, 'absent baseline degrades to null, not a throw');
});

test('the baseline sidecar itself is an allowed MAIN transaction file', () => {
  // It is written into the bundle dir AFTER the snapshot, so it shows up as a new
  // untracked path in the after-capture and must not trip the check it enables.
  const { main, bundleDir } = mainWithBundle();
  const baseline = captureWatchBaseline({
    mainRoot: main, bundleDir, worktree: main, slug: 'demo', scopePaths: [],
  });
  writeWatchBaseline(bundleDir, 1, baseline);
  const r = verifyWatchListDelta(
    baseline.snapshots,
    snapshotWatchList([{ repo: main, prefix: null, isMain: true }]),
    [],
    mainIo(main, bundleDir, baseline.bundle),
  );
  assert.deepEqual(r.violations, []);
});

// ── vector 5 regression: clean tracked file in a watched sibling ─────────────
// The 2026-08-04 e2e planted a child write into a watched sibling repo. It was DETECTED,
// but for the wrong reason ("file created") and the sibling was left dirty — the breach
// had to be cleaned up by hand. Both halves are the goal's "failing for the planted
// reason" clause, so both are pinned here.

test('a clean tracked file modified in a watched sibling reports MODIFICATION, not creation', () => {
  const repo = tmpRepo();
  write(repo, 'other.txt', 'committed content\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add other.txt');
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);
  // Precondition that makes this the real vector: the file is TRACKED and CLEAN, so it
  // carries no porcelain entry at launch. Reading that absence as "did not exist" is the bug.
  assert.equal(before[repo].entries['other.txt'], undefined);

  write(repo, 'other.txt', 'SIBLING-BREACH\n');
  const after = snapshotWatchList(wl);

  const r = verifyWatchListDelta(before, after, ['allowed.txt']);
  assert.equal(r.ok, false);
  const v = r.violations.find((x) => x.rel === 'other.txt');
  assert.ok(v, 'expected a violation for the modified sibling file');
  assert.match(v.reason, /tracked file modified/);
  assert.doesNotMatch(v.reason, /created/);
  assert.equal(v.trackedAtLaunch, true);
  assert.equal(v.restore, 'checkout', 'a tracked modification is restorable by checkout');
});

test('a genuinely NEW file in a watched sibling still reports creation', () => {
  // The negative control for the test above: if the fix simply relabelled everything as a
  // modification it would pass that test and fail this one.
  const repo = tmpRepo();
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);
  write(repo, 'brand-new.txt', 'created by a child\n');
  const after = snapshotWatchList(wl);

  const v = verifyWatchListDelta(before, after, ['allowed.txt']).violations
    .find((x) => x.rel === 'brand-new.txt');
  assert.ok(v);
  assert.match(v.reason, /file created/);
  assert.equal(v.trackedAtLaunch, false);
  assert.equal(v.restore, 'clean', 'a created file is restorable by clean');
});

test('a file already dirty at launch is reported but NOT marked restorable (CD-2)', () => {
  // Reverting here would destroy the user's in-progress work, so the breach is surfaced
  // with restore:null and the transaction leaves the content alone.
  const repo = tmpRepo();
  write(repo, 'wip.txt', 'user draft\n');
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);
  write(repo, 'wip.txt', 'CLOBBERED BY A CHILD\n');
  const after = snapshotWatchList(wl);

  const v = verifyWatchListDelta(before, after, ['allowed.txt']).violations
    .find((x) => x.rel === 'wip.txt');
  assert.ok(v);
  assert.equal(v.restore, null, 'pre-existing dirt is the user\'s — never auto-reverted');
  assert.match(v.reason, /dirty at launch/);
});

test('trackedness is answered from the LAUNCH head, not the current one', () => {
  // A file added and committed DURING the wave did not exist at launch, so it must not be
  // mistaken for a pre-existing tracked file just because HEAD now knows it.
  const repo = tmpRepo();
  const wl = [{ repo, prefix: null, isMain: false }];
  const before = snapshotWatchList(wl);
  write(repo, 'late.txt', 'added mid-wave\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'child committed');
  const after = snapshotWatchList(wl);

  const r = verifyWatchListDelta(before, after, ['allowed.txt']);
  assert.equal(r.ok, false);
  // The moved HEAD is its own violation and is never "restored".
  const headV = r.violations.find((x) => x.path === '(HEAD)');
  assert.ok(headV, 'a child commit in a watched repo is a violation');
  assert.equal(headV.restore, undefined);
});
