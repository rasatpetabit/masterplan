// Real repositories BESIDE the bundle's repo: dispatch, record, and crash recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveFileLocus, buildFabricLocus, canonicalizeScopePaths,
  captureMultiRepoFiles, partitionPathsByRepo, mapUmbrellaPathsToRepos,
  rewriteVerifyForSibling,
} from '../lib/dispatch/multi-repo.mjs';
import { worktreePathFor, worktreeBranchFor } from '../lib/worktree.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult, captureWtFiles } from '../lib/wave-commit.mjs';
import { dispatchWaveViaFabric, readWaveDispatchRecord, reviewNativeResult } from '../lib/dispatch-wave.mjs';
import { precheckWatchList, snapshotWatchList, buildWatchList, verifyWatchListDelta } from '../lib/watch-integrity.mjs';
import { fingerprintReviewContext } from '../lib/recovery-controller.mjs';
import { verifyRecoverySelector } from '../lib/recovery-preflight.mjs';

const policy = JSON.parse(fs.readFileSync(new URL('./fixtures/dispatch-map.json', import.meta.url), 'utf8'));
function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(repo, rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}
function init(repo, name) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'test@test');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, '.gitignore', '.worktrees/\n');
  write(repo, 'src/a.rs', `${name} seed\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', `${name} initial`);
}
function mainSnapshot(repo) {
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    branch: git(repo, 'branch', '--show-current'),
    status: execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }),
    content: fs.readFileSync(path.join(repo, 'src/a.rs'), 'utf8'),
  };
}
function fixture(t, { nested = false, review = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-external-loci-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const EXT = path.join(tmp, 'external');
  const MAIN = nested ? path.join(EXT, 'coordinator') : path.join(tmp, 'coordinator');
  init(EXT, 'external');
  if (nested) { write(EXT, '.gitignore', '.worktrees/\ncoordinator/\n'); git(EXT, 'add', '.'); git(EXT, 'commit', '-qm', 'ignore coordinator'); }
  init(MAIN, 'coordinator');
  const slug = 'external-locus';
  const WT = worktreePathFor(MAIN, slug);
  git(MAIN, 'worktree', 'add', '-qb', worktreeBranchFor(slug), WT);
  const extWT = worktreePathFor(EXT, slug);
  const source = path.join(EXT, 'src/a.rs');
  const bundleDir = path.join(MAIN, 'docs/masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  const task = { id: 1, wave: 1, status: 'pending', files: [source] };
  writeState(statePath, { schema_version: 8, slug, status: 'in-progress', phase: 'execute',
    worktree: WT, tasks: [task], active_run: null, dispatch: { fabric: true }, review: { adversary: review } });
  write(bundleDir, 'plan.index.json', JSON.stringify({ tasks: [{ ...task, description: 'external edit', verify_commands: [] }] }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'external-test', slug, now: 1000 });
  return { tmp, EXT, MAIN, WT, extWT, slug, source, bundleDir, statePath, self,
    opts: { worktree: WT, mainRoot: MAIN, slug } };
}
function ensureExternal(fx) {
  git(fx.EXT, 'worktree', 'add', '-qb', worktreeBranchFor(fx.slug), fx.extWT);
}
const result = () => ({ wave: 1, tasks: [{ task_id: 1, digest: { task_id: 1, status: 'done', files_changed: ['src/a.rs'], summary: 'external edit', blockers: [] } }] });

test('external 1: resolver shares the main namespace and rejects a foreign linked worktree', (t) => {
  const fx = fixture(t);
  const provisional = resolveFileLocus(fx.source, fx.opts);
  assert.equal(provisional.siblingName, fx.EXT);
  assert.equal(provisional.external, true);
  assert.equal(provisional.siblingWt, fx.extWT);
  ensureExternal(fx);
  for (const file of [fx.source, path.join(fx.extWT, 'src/a.rs')]) {
    const loc = resolveFileLocus(file, fx.opts);
    assert.equal(loc.repo, fx.extWT);
    assert.equal(loc.rel, 'src/a.rs');
    assert.equal(loc.siblingName, fx.EXT);
    assert.equal(loc.abs, path.join(fx.extWT, 'src/a.rs'));
  }
  const foreign = path.join(fx.EXT, '.worktrees/foreign');
  git(fx.EXT, 'worktree', 'add', '-qb', 'foreign', foreign);
  const file = path.join(foreign, 'new/not-created.rs');
  assert.throws(() => resolveFileLocus(file, fx.opts), (err) => err.message.includes(file));
});

test('external 2: canonicalize/capture/partition/map round trip keeps equal rels distinct', (t) => {
  const fx = fixture(t);
  ensureExternal(fx);
  const paths = canonicalizeScopePaths(['src/a.rs', path.join(fx.extWT, 'src/a.rs')], fx.opts);
  assert.deepEqual(paths, ['src/a.rs', fx.source]);
  write(fx.WT, 'src/a.rs', 'run edit\n');
  write(fx.extWT, 'src/a.rs', 'external edit\n');
  const captured = captureMultiRepoFiles(paths, { ...fx.opts, captureWtFiles });
  assert.deepEqual(captured.sort(), [...paths].sort());
  const loci = partitionPathsByRepo(paths, fx.opts);
  const mapped = mapUmbrellaPathsToRepos(captured, loci);
  assert.deepEqual(mapped.get(fx.WT), ['src/a.rs']);
  assert.deepEqual(mapped.get(fx.extWT), ['src/a.rs']);
  assert.deepEqual(rewriteVerifyForSibling([`test -f ${fx.source}`, `test -f ${fx.extWT}/src/a.rs`], fx.EXT,
    { mainRoot: fx.MAIN, repo: fx.extWT }), [`test -f ${fx.extWT}/src/a.rs`, `test -f ${fx.extWT}/src/a.rs`]);
});

test('external 2 nested: longest absolute namespace wins, including a repo containing MAIN', (t) => {
  const fx = fixture(t, { nested: true });
  ensureExternal(fx);
  const inner = path.join(fx.EXT, 'inner');
  init(inner, 'inner');
  git(inner, 'worktree', 'add', '-qb', worktreeBranchFor(fx.slug), worktreePathFor(inner, fx.slug));
  const paths = [fx.source, path.join(inner, 'src/a.rs'), path.join(fx.MAIN, 'src/a.rs')];
  const canonical = canonicalizeScopePaths(paths, fx.opts);
  assert.deepEqual(canonical, [fx.source, paths[1], 'src/a.rs']);
  const loci = partitionPathsByRepo(canonical, fx.opts);
  // Parent first deliberately: matching cannot depend on input order.
  const mapped = mapUmbrellaPathsToRepos(canonical, loci);
  assert.deepEqual(mapped.get(fx.extWT), ['src/a.rs']);
  assert.deepEqual(mapped.get(worktreePathFor(inner, fx.slug)), ['src/a.rs']);
  assert.deepEqual(mapped.get(fx.WT), ['src/a.rs']);
  const rootMapped = mapUmbrellaPathsToRepos([inner, `${inner}-other/src/a.rs`], loci);
  assert.deepEqual(rootMapped.get(worktreePathFor(inner, fx.slug)), ['']);
  assert.deepEqual(rootMapped.get(fx.extWT), ['inner-other/src/a.rs']);
  const watch = buildWatchList(canonical, fx.opts);
  const before = snapshotWatchList(watch);
  // The same spelled canonical path cannot authorize edits in the parent
  // worktree when the more-specific inner repository owns the namespace.
  write(fx.extWT, 'inner/src/a.rs', 'wrong parent locus\n');
  write(worktreePathFor(inner, fx.slug), 'src/a.rs', 'right inner locus\n');
  const after = snapshotWatchList(watch);
  const pre = precheckWatchList(after, canonical);
  assert.deepEqual(pre.violations.map((v) => v.repo), [worktreePathFor(inner, fx.slug)]);
  const delta = verifyWatchListDelta(before, after, canonical);
  assert.equal(delta.ok, false);
  assert.deepEqual(delta.violations.map((v) => [v.repo, v.rel]), [[fx.extWT, 'inner/src/a.rs']]);
});

test('external 3: buildFabricLocus creates only the run worktree and preserves EXT main', (t) => {
  const fx = fixture(t);
  write(fx.EXT, 'src/a.rs', 'uncommitted user change\n');
  const before = mainSnapshot(fx.EXT);
  const locus = buildFabricLocus([fx.source], fx.opts);
  assert.equal(locus.repo, fx.extWT);
  assert.ok(fs.existsSync(path.join(fx.extWT, '.git')));
  assert.equal(git(fx.extWT, 'branch', '--show-current'), worktreeBranchFor(fx.slug));
  assert.deepEqual(locus.files, ['src/a.rs']);
  assert.deepEqual(mainSnapshot(fx.EXT), before);
});

for (const rogue of [false, true]) {
test(`external 4: real record path commits in-scope work${rogue ? ' and reverts external out-of-scope work' : ''}`, async (t) => {
  const fx = fixture(t);
  write(fx.EXT, 'src/a.rs', 'user work in EXT main\n');
  const before = mainSnapshot(fx.EXT);
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'dispatch_fabric');
  assert.deepEqual(op.baseline, [], 'provisional EXT main dirt is not the run worktree baseline');
  const dispatch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy });
  assert.equal(dispatch.outcome, 'native-spawn-plan');
  assert.equal(dispatch.plan.tasks[0].cwd, fx.extWT);
  write(fx.extWT, 'src/a.rs', 'external edit\n');
  if (rogue) write(fx.extWT, 'rogue.rs', 'not allowed\n');
  const mainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() });
  assert.equal(recorded.outcome, 'recorded');
  assert.equal(recorded.scope.ok, !rogue);
  const outOfScope = rogue ? [path.join(fx.EXT, 'rogue.rs')] : [];
  assert.deepEqual(recorded.scope.outOfScope, outOfScope);
  assert.deepEqual(recorded.reverted, outOfScope);
  assert.equal(fs.existsSync(path.join(fx.extWT, 'rogue.rs')), false);
  assert.equal(git(fx.extWT, 'show', 'HEAD:src/a.rs'), 'external edit');
  assert.equal(git(fx.extWT, 'show', '--format=', '--name-only', 'HEAD'), 'src/a.rs');
  assert.equal(git(fx.extWT, 'status', '--porcelain'), '');
  assert.equal(git(fx.extWT, 'branch', '--show-current'), worktreeBranchFor(fx.slug));
  assert.equal(recorded.commits.code, git(fx.extWT, 'rev-parse', 'HEAD'));
  assert.notEqual(git(fx.MAIN, 'rev-parse', 'HEAD'), mainHead);
  assert.equal(recorded.commits.state, git(fx.MAIN, 'rev-parse', 'HEAD'));
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
  assert.deepEqual(mainSnapshot(fx.EXT), before);
});
}

test('external 5: recover_wave resets the external worktree, never EXT main user content', (t) => {
  const fx = fixture(t);
  ensureExternal(fx);
  write(fx.EXT, 'src/a.rs', 'precious uncommitted user content\n');
  write(fx.extWT, 'src/a.rs', 'interrupted child content\n');
  const before = mainSnapshot(fx.EXT);
  writeState(fx.statePath, { ...readState(fx.statePath), active_run: { wave: 1, phase: 'launching', scope: [fx.source], baseline: [] } });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, alive: false });
  assert.equal(op.op, 'dispatch_fabric');
  assert.deepEqual(mainSnapshot(fx.EXT), before, 'EXT main user content must survive byte-identical');
  assert.equal(fs.readFileSync(path.join(fx.extWT, 'src/a.rs'), 'utf8'), 'external seed\n');
});

test('external recovery without a run worktree skips reset and records why', (t) => {
  const fx = fixture(t);
  write(fx.EXT, 'src/a.rs', 'precious main content\n');
  const before = mainSnapshot(fx.EXT);
  writeState(fx.statePath, { ...readState(fx.statePath), active_run: { wave: 1, phase: 'launching', scope: [fx.source], baseline: [] } });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, alive: false });
  assert.equal(op.op, 'dispatch_fabric');
  assert.deepEqual(mainSnapshot(fx.EXT), before);
  assert.deepEqual(op.reset_skipped, [{ path: fx.source, repo: fx.extWT, reason: 'run worktree does not exist; nothing was dispatched there' }]);
});

test('external 6: review captures the exact diff against the external dispatch HEAD', async (t) => {
  const fx = fixture(t, { review: true });
  continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  const dispatch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy });
  assert.equal(dispatch.outcome, 'native-spawn-plan');
  const ctx = readWaveDispatchRecord(fx.bundleDir, 1).review_context;
  const base = git(fx.extWT, 'rev-parse', 'HEAD');
  assert.equal(ctx.tasks[0].base_sha, base);
  assert.notEqual(base, ctx.base_sha, 'separate repositories have unrelated histories');
  // An intervening commit proves capture uses the frozen base, not live HEAD.
  write(fx.extWT, 'src/a.rs', 'first edit\n');
  git(fx.extWT, 'add', 'src/a.rs');
  git(fx.extWT, 'commit', '-qm', 'intervening commit');
  write(fx.extWT, 'src/a.rs', 'second edit\n');
  const reviewed = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result(), policy });
  const input = reviewed.tasks[0].review_input;
  const expected = execFileSync('git', ['-C', fx.extWT, 'diff', base], { encoding: 'utf8' });
  assert.ok(expected.length > 0);
  assert.equal(input.repo, fx.extWT);
  assert.equal(input.base, base);
  assert.equal(input.diff, expected);
  assert.notEqual(fingerprintReviewContext(ctx), fingerprintReviewContext({ ...ctx, tasks: [{ ...ctx.tasks[0], base_sha: ctx.base_sha }] }));
});

test('external watch precheck assigns absolute scopes to the longest namespace only', (t) => {
  const fx = fixture(t);
  ensureExternal(fx);
  write(fx.extWT, 'src/a.rs', 'pre-existing work\n');
  const snapshots = snapshotWatchList(buildWatchList([fx.source, 'src/a.rs'], fx.opts));
  const pre = precheckWatchList(snapshots, [fx.source, 'src/a.rs']);
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.violations.map((v) => [v.repo, v.path]), [[fx.extWT, 'src/a.rs']]);
});

test('external partial wave: worktree-spelled scope commits only the done external task', async (t) => {
  const fx = fixture(t);
  ensureExternal(fx);
  const extFile = path.join(fx.extWT, 'src/a.rs');
  const tasks = [
    { id: 1, wave: 1, status: 'pending', files: [extFile], description: 'external edit', verify_commands: [] },
    { id: 2, wave: 1, status: 'pending', files: ['src/a.rs'], description: 'run edit', verify_commands: [] },
  ];
  writeState(fx.statePath, { ...readState(fx.statePath), tasks });
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks }));
  continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  const dispatch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy });
  assert.equal(dispatch.outcome, 'native-spawn-plan');
  const ctx = readWaveDispatchRecord(fx.bundleDir, 1).review_context;
  assert.deepEqual(ctx.tasks.map((task) => [task.repo, task.base_sha]),
    [fx.extWT, fx.WT].map((repo) => [repo, git(repo, 'rev-parse', 'HEAD')]));
  write(fx.extWT, 'src/a.rs', 'external done\n');
  write(fx.WT, 'src/a.rs', 'run unfinished\n');
  const res = result();
  res.tasks.push({ task_id: 2, digest: { task_id: 2, status: 'failed', files_changed: ['src/a.rs'], summary: 'failed', blockers: ['unfinished'] } });
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: res });
  assert.equal(recorded.outcome, 'recorded');
  assert.equal(recorded.scope.ok, true);
  assert.equal(git(fx.extWT, 'show', 'HEAD:src/a.rs'), 'external done');
  assert.equal(git(fx.extWT, 'status', '--porcelain'), '');
  assert.equal(git(fx.WT, 'show', 'HEAD:src/a.rs'), 'coordinator seed');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/a.rs'), 'utf8'), 'run unfinished\n');
});

function setTasks(fx, tasks) {
  writeState(fx.statePath, { ...readState(fx.statePath), tasks });
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: tasks.map((task) => ({
    ...task, description: `task ${task.id}`, verify_commands: [],
  })) }));
}
async function launch(fx) {
  assert.equal(continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 }).op, 'dispatch_fabric');
  const out = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy });
  assert.equal(out.outcome, 'native-spawn-plan', JSON.stringify(out));
  return out;
}

for (const directory of [false, true]) {
  test(`blocker R1: record reports protected EXT main ${directory ? 'directory' : 'file'} changes without restoring bytes`, async (t) => {
    const fx = fixture(t);
    if (directory) setTasks(fx, [{ id: 1, wave: 1, status: 'pending', files: [`${fx.EXT}/src/`] }]);
    write(fx.EXT, 'src/a.rs', 'another session before launch\n');
    await launch(fx); // main dirt must not block launch
    write(fx.EXT, 'src/a.rs', 'misdirected worker edit\n');
    const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() });
    assert.equal(recorded.watch.ok, false);
    const violation = recorded.watch.violations.find((v) => v.repo === fx.EXT && v.rel === 'src/a.rs');
    assert.ok(violation, JSON.stringify(recorded.watch));
    assert.equal(violation.restore, null);
    assert.match(violation.reason, /protected.*main/i);
    assert.equal(fs.readFileSync(fx.source, 'utf8'), 'misdirected worker edit\n');
    assert.deepEqual(recorded.watch.reverted, []);
  });
}

test('blocker R1: undeclared EXT main changes, including commits, are ignored', async (t) => {
  const fx = fixture(t);
  await launch(fx);
  write(fx.EXT, 'unrelated.rs', 'other session\n');
  git(fx.EXT, 'add', 'unrelated.rs');
  git(fx.EXT, 'commit', '-qm', 'other session commit');
  write(fx.extWT, 'src/a.rs', 'done\n');
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() });
  assert.equal(recorded.watch.ok, true, JSON.stringify(recorded.watch));
  assert.equal(fs.readFileSync(path.join(fx.EXT, 'unrelated.rs'), 'utf8'), 'other session\n');
});

for (const kind of ['mode', 'index']) {
  test(`blocker R1: a ${kind}-only change to a declared EXT main file is reported`, async (t) => {
    // Same bytes, different file: an executable bit, or a staged copy of existing dirt.
    const fx = fixture(t);
    if (kind === 'index') write(fx.EXT, 'src/a.rs', 'another session dirt\n');
    await launch(fx);
    if (kind === 'mode') fs.chmodSync(fx.source, 0o755);
    else git(fx.EXT, 'add', 'src/a.rs');
    const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() });
    assert.ok(recorded.watch.violations.some((v) => v.repo === fx.EXT && v.rel === 'src/a.rs' && v.restore === null),
      JSON.stringify(recorded.watch));
  });
}

test('blocker R1: a declared clean file committed in EXT main is still detected', async (t) => {
  const fx = fixture(t);
  await launch(fx);
  write(fx.EXT, 'src/a.rs', 'misdirected commit\n');
  git(fx.EXT, 'add', 'src/a.rs');
  git(fx.EXT, 'commit', '-qm', 'misdirected commit');
  const head = git(fx.EXT, 'rev-parse', 'HEAD');
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() });
  assert.ok(recorded.watch.violations.some((v) => v.repo === fx.EXT && v.rel === 'src/a.rs' && v.restore === null));
  assert.equal(git(fx.EXT, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(fx.source, 'utf8'), 'misdirected commit\n');
});

test('blocker R2: external committed recovery passes Phase A and records Phase B in the frozen locus', async (t) => {
  const fx = fixture(t, { review: true });
  await launch(fx);
  const baselinePath = path.join(fx.bundleDir, '.wave-1.watch.json');
  const baseline = fs.readFileSync(baselinePath);
  const extBefore = mainSnapshot(fx.EXT);
  write(fx.extWT, 'src/a.rs', 'recovered external commit\n');
  git(fx.extWT, 'add', 'src/a.rs');
  git(fx.extWT, 'commit', '-qm', 'recovered external work');
  const head = git(fx.extWT, 'rev-parse', 'HEAD');
  const recoverySelector = { repo: fx.extWT, head };
  const args = { statePath: fx.statePath, self: fx.self, result: result(), recoverySelector, policy, now: 3000 };
  const pending = await reviewNativeResult(args);
  assert.equal(pending.review_outcome, 'recovery-review-pending');
  assert.equal(pending.pending_reviews[0].identity.head, head);
  const reviewed = await reviewNativeResult({ ...args, providedReviews: {
    1: { final_verdict: 'approve', identity: pending.pending_reviews[0].identity },
  } });
  const recorded = recordWaveResult({ ...args, result: reviewed, recovery: true,
    deferredEvents: reviewed.deferred_review_events });
  assert.equal(recorded.outcome, 'recorded', JSON.stringify(recorded));
  assert.equal(recorded.commits.code, head);
  assert.equal(recorded.watch.ok, true);
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
  assert.equal(git(fx.extWT, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readFileSync(baselinePath), baseline);
  assert.deepEqual(mainSnapshot(fx.EXT), extBefore);
});

test('blocker R2: selector naming EXT main is refused without state writes', async (t) => {
  const fx = fixture(t, { review: true });
  await launch(fx);
  const state = fs.readFileSync(fx.statePath);
  const selector = { repo: fx.EXT, head: git(fx.EXT, 'rev-parse', 'HEAD') };
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self,
    result: result(), recoverySelector: selector, policy }), /does not match.*frozen/);
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000,
    result: { wave: 1, tasks: [] }, recovery: true, recoverySelector: selector });
  assert.equal(recorded.outcome, 'recovery-preservation-violation');
  assert.match(recorded.violations.join('; '), /selector repo|run locus/);
  assert.deepEqual(fs.readFileSync(fx.statePath), state);
});

test('blocker R3: missing dispatched external worktree refuses done digest with zero writes or commits', async (t) => {
  const fx = fixture(t);
  await launch(fx);
  git(fx.EXT, 'worktree', 'remove', fx.extWT);
  const state = fs.readFileSync(fx.statePath);
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath) : null;
  const mainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  const extHead = git(fx.EXT, 'rev-parse', worktreeBranchFor(fx.slug));
  assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() }),
    (err) => err.message.includes(fx.extWT) && /missing|does not exist/.test(err.message));
  assert.deepEqual(fs.readFileSync(fx.statePath), state);
  assert.deepEqual(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath) : null, events);
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), mainHead);
  assert.equal(git(fx.EXT, 'rev-parse', worktreeBranchFor(fx.slug)), extHead);
});

test('blocker R4: pre-existing dirt under an external directory scope refuses launch', async (t) => {
  const fx = fixture(t);
  ensureExternal(fx);
  const scope = `${fx.EXT}/generated/`;
  setTasks(fx, [{ id: 1, wave: 1, status: 'pending', files: [scope] }]);
  write(fx.extWT, 'generated/a.rs', 'pre-existing work\n');
  const snapshots = snapshotWatchList(buildWatchList([scope], fx.opts));
  for (const baseline of [null, [`${fx.EXT}/generated/a.rs`], [scope]]) {
    const pre = precheckWatchList(snapshots, [scope], { baseline });
    assert.equal(pre.ok, false, `baseline=${JSON.stringify(baseline)}`);
    assert.ok(pre.violations.some((v) => v.repo === fx.extWT && v.path === 'generated/a.rs'));
  }
  assert.equal(precheckWatchList(snapshots, [scope], { baseline: [] }).ok, true, 'retry residue remains permitted');
  assert.equal(continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 }).op, 'dispatch_fabric');
  const dispatch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy });
  assert.equal(dispatch.outcome, 'precheck-failed', JSON.stringify(dispatch));
  assert.equal(fs.readFileSync(path.join(fx.extWT, 'generated/a.rs'), 'utf8'), 'pre-existing work\n');
});

test('blocker R5: partial external wave commits the done directory scope, not the failed file', async (t) => {
  const fx = fixture(t);
  setTasks(fx, [
    { id: 1, wave: 1, status: 'pending', files: [`${fx.EXT}/generated/`] },
    { id: 2, wave: 1, status: 'pending', files: [`${fx.EXT}/other.rs`] },
  ]);
  await launch(fx);
  write(fx.extWT, 'generated/a.rs', 'regenerated\n');
  write(fx.extWT, 'other.rs', 'unfinished\n');
  const res = result();
  res.tasks.push({ task_id: 2, digest: { task_id: 2, status: 'failed', files_changed: ['other.rs'], summary: 'failed', blockers: ['unfinished'] } });
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: res });
  assert.equal(recorded.outcome, 'recorded');
  assert.equal(recorded.scope.ok, true);
  assert.equal(git(fx.extWT, 'show', 'HEAD:generated/a.rs'), 'regenerated');
  assert.equal(git(fx.extWT, 'show', '--format=', '--name-only', 'HEAD'), 'generated/a.rs');
  assert.equal(git(fx.extWT, 'status', '--porcelain'), '?? other.rs');
  assert.equal(fs.readFileSync(path.join(fx.extWT, 'other.rs'), 'utf8'), 'unfinished\n');
});

for (const foreign of [false, true]) {
  test('blocker R2: frozen selector agreement cannot authorize ' + (foreign ? 'a foreign worktree' : 'EXT main'), async (t) => {
    const fx = fixture(t, { review: true });
    await launch(fx);
    const repo = foreign ? path.join(fx.EXT, '.worktrees/foreign') : fx.EXT;
    if (foreign) git(fx.EXT, 'worktree', 'add', '-qb', 'foreign', repo);
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    record.review_context.tasks[0].repo = repo;
    write(fx.bundleDir, 'wave-1.dispatch.json', JSON.stringify(record));
    const verdict = verifyRecoverySelector({ recoverySelector: { repo, head: git(repo, 'rev-parse', 'HEAD') },
      WT: fx.WT, MAIN: fx.MAIN, slug: fx.slug, wave: 1, bundleDir: fx.bundleDir });
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join('; '), /not a run locus/);
  });
}

test('blocker R2: an external recovered commit outside declared scope is refused without writes', async (t) => {
  const fx = fixture(t, { review: true });
  await launch(fx);
  write(fx.extWT, 'src/a.rs', 'recovered work\n');
  write(fx.extWT, 'rogue.rs', 'unscoped committed work\n');
  git(fx.extWT, 'add', 'src/a.rs', 'rogue.rs');
  git(fx.extWT, 'commit', '-qm', 'recovery with scope breach');
  const head = git(fx.extWT, 'rev-parse', 'HEAD');
  const state = fs.readFileSync(fx.statePath);
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000,
    result: { wave: 1, tasks: [] }, recovery: true, recoverySelector: { repo: fx.extWT, head } });
  assert.equal(recorded.outcome, 'recovery-preservation-violation');
  assert.match(recorded.violations.join('; '), /rogue.rs outside the declared scope/);
  assert.deepEqual(fs.readFileSync(fx.statePath), state);
  assert.equal(git(fx.extWT, 'rev-parse', 'HEAD'), head);
});

test('blocker R1: umbrella sibling main is protected just like external main', async (t) => {
  const fx = fixture(t);
  const sibling = path.join(fx.MAIN, 'sibling');
  init(sibling, 'sibling');
  write(fx.MAIN, '.git/info/exclude', '/sibling/\n');
  setTasks(fx, [{ id: 1, wave: 1, status: 'pending', files: ['sibling/src/a.rs'] }]);
  write(sibling, 'src/a.rs', 'pre-existing sibling main dirt\n');
  await launch(fx);
  write(sibling, 'src/a.rs', 'misdirected sibling edit\n');
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: result() });
  assert.ok(recorded.watch.violations.some((v) => v.repo === sibling && v.rel === 'src/a.rs' && v.restore === null));
  assert.equal(fs.readFileSync(path.join(sibling, 'src/a.rs'), 'utf8'), 'misdirected sibling edit\n');
});
