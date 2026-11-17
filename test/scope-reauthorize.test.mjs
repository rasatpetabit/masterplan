import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState, writeState, appendEvent } from '../lib/bundle.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { captureWatchBaseline, writeWatchBaseline } from '../lib/watch-integrity.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { preflightRecovery } from '../lib/recovery-preflight.mjs';
import { captureWtFiles, captureWorkspaceRoot } from '../lib/wave-commit.mjs';
const cli = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const git = (d, ...args) => execFileSync('git', ['-C', d, ...args], { encoding: 'utf8' }).trim();
const put = (d, f, bytes) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), bytes); };
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reauth-')); dirs.push(tmp);
  const MAIN = path.join(tmp, 'main'); fs.mkdirSync(MAIN);
  git(MAIN, 'init', '-q', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test'); git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  put(MAIN, '.gitignore', '.worktrees/\n');
  for (const f of ['src/a', 'src/b', 'rogue']) put(MAIN, f, 'original\n');
  git(MAIN, 'add', '.'); git(MAIN, 'commit', '-qm', 'initial');
  const WT = path.join(MAIN, '.worktrees', 'scope');
  git(MAIN, 'worktree', 'add', '-qb', 'work', WT);
  const bundle = path.join(MAIN, 'docs/masterplan/scope');
  const statePath = path.join(bundle, 'state.yml');
  writeState(statePath, { schema_version: 8, slug: 'scope', status: 'in-progress', phase: 'execute',
    concurrency: { owner_lock: 'off' }, worktree: WT,
    tasks: [{ id: 1, wave: 1, status: 'pending', files: ['src/a'] }] });
  const mp = (...args) => spawnSync(process.execPath, [cli, ...args, '--state=' + statePath], { encoding: 'utf8' });
  const launch = mp('set-active-run', '--wave=1', '--scope=["src/a"]', '--baseline=[]', '--ws-baseline=[]');
  assert.equal(launch.status, 0, launch.stderr);
  put(bundle, 'plan.md', '# Plan\n');
  const index = path.join(bundle, 'plan.index.json');
  put(bundle, 'plan.index.json', JSON.stringify({ tasks: [{ id: 1, wave: 1, files: ['src/'] }] }));
  writeWatchBaseline(bundle, 1, captureWatchBaseline({ mainRoot: MAIN, bundleDir: bundle, worktree: WT, slug: 'scope', scopePaths: ['src/a'] }));
  return { MAIN, WT, bundle, statePath, mp, index };
}
// Model an older controller's amendment transaction: task files and an audited
// structured amendment change, but the active scope remains frozen. New amend
// verbs must not produce this state; the explicit recovery verb repairs it.
function legacyAmend(fx, { recorded = true, files = ['src/'] } = {}) {
  const state = readState(fx.statePath);
  if (recorded) appendEvent(fx.statePath, { type: 'plan_amended', summary: 'widen task 1',
    task_files: [{ id: 1, wave: 1, files }], ts: new Date().toISOString() });
  state.tasks[0].files = files; writeState(fx.statePath, state);
}
function snapshot(fx) {
  return { state: fs.readFileSync(fx.statePath).toString('hex'),
    head: git(fx.WT, 'rev-parse', 'HEAD'), main: git(fx.MAIN, 'rev-parse', 'HEAD'),
    index: fs.readFileSync(path.join(fx.MAIN, '.git/worktrees/scope/index')).toString('hex'),
    bytes: ['src/a', 'src/b', 'rogue'].map(f => fs.readFileSync(path.join(fx.WT, f), 'utf8')),
    events: fs.existsSync(path.join(fx.bundle, 'events.jsonl')) ? fs.readFileSync(path.join(fx.bundle, 'events.jsonl'), 'utf8') : '' };
}
const events = fx => fs.readFileSync(path.join(fx.bundle, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const record = (fx, extra = {}) => recordWaveResult({ statePath: fx.statePath,
  result: { wave: 1, tasks: [{ task_id: 1, digest: { task_id: 1, status: 'done' } }] }, ...extra });
const reauth = fx => fx.mp('reauthorize-scope', '--wave=1', '--reason=approved amendment');

test('amended scope refusal preserves worktree bytes, HEAD, index and state before any write', () => {
  const fx = fixture(); legacyAmend(fx);
  put(fx.WT, 'src/b', 'valuable amended work\n'); put(fx.WT, 'rogue', 'also unchanged on refusal\n');
  put(fx.WT, 'src/new', 'untracked amended work\n');
  git(fx.WT, 'add', 'src/b');
  const before = snapshot(fx);
  const res = record(fx);
  assert.equal(res.outcome, 'scope-amended-after-launch');
  assert.deepEqual(res.files.sort(), ['src/b', 'src/new']); assert.match(res.reason, /reauthorize-scope/);
  assert.deepEqual(snapshot(fx), before);
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/new'), 'utf8'), 'untracked amended work\n');
});

test('amended scope detection also covers committed paths missing from dirty capture', () => {
  const fx = fixture(); legacyAmend(fx);
  put(fx.WT, 'src/b', 'worker committed\n');
  git(fx.WT, 'add', 'src/b'); git(fx.WT, 'commit', '-qm', 'worker commit');
  const before = snapshot(fx); const res = record(fx);
  assert.equal(res.outcome, 'scope-amended-after-launch');
  assert.deepEqual(res.files, ['src/b']); assert.deepEqual(snapshot(fx), before);
});

test('CLI recording refuses before native Phase B audit or dispatch-record writes', () => {
  const fx = fixture(); legacyAmend(fx);
  put(fx.WT, 'src/b', 'valuable\n');
  const dispatch = JSON.stringify({ status: 'pending', review_context: { enabled: true } });
  put(fx.bundle, 'wave-1.dispatch.json', dispatch);
  put(fx.bundle, 'reviews.json', '{}');
  const before = snapshot(fx);
  const res = fx.mp('record-result', '--result=' + JSON.stringify({ wave: 1, tasks: [{ task_id: 1, digest: { status: 'done' } }] }),
    '--reviews-file=' + path.join(fx.bundle, 'reviews.json'));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).outcome, 'scope-amended-after-launch');
  assert.deepEqual(snapshot(fx), before);
  assert.equal(fs.readFileSync(path.join(fx.bundle, 'wave-1.dispatch.json'), 'utf8'), dispatch);
});

test('reauthorization preserves all marker fields, watch baseline and dispatch history; record commits without reverts', () => {
  const fx = fixture(); legacyAmend(fx, { files: [path.join(fx.MAIN, 'src') + '/'] });
  const state = readState(fx.statePath);
  state.active_run = { ...state.active_run, run_id: 'run', task_id: 'task', epoch: 7 };
  writeState(fx.statePath, state);
  put(fx.bundle, 'wave-1.dispatch.json', '{"history":["unchanged"]}\n');
  const watch = fs.readFileSync(path.join(fx.bundle, '.wave-1.watch.json'), 'utf8');
  put(fx.WT, 'src/b', 'amended\n');
  const result = reauth(fx); assert.equal(result.status, 0, result.stderr);
  const widened = readState(fx.statePath).active_run;
  assert.deepEqual(widened, { ...state.active_run, scope: ['src/a', 'src/'] });
  assert.equal(fs.readFileSync(path.join(fx.bundle, '.wave-1.watch.json'), 'utf8'), watch);
  assert.equal(fs.readFileSync(path.join(fx.bundle, 'wave-1.dispatch.json'), 'utf8'), '{"history":["unchanged"]}\n');
  const ev = events(fx).at(-1);
  assert.equal(ev.type, 'scope_reauthorized'); assert.equal(ev.reason, 'approved amendment');
  assert.deepEqual(ev.old_scope, ['src/a']); assert.deepEqual(ev.new_scope, ['src/a', 'src/']);
  assert.deepEqual(ev.added_entries, ['src/']); assert.equal(ev.amendments[0].type, 'plan_amended');
  // No epoch field in result would be stale. Remove the synthetic fence only for this completion.
  const res = record(fx, { result: { wave: 1, epoch: 7, tasks: [{ task_id: 1, digest: { task_id: 1, status: 'done' } }] } });
  assert.equal(res.outcome, 'recorded'); assert.deepEqual(res.reverted, []); assert.deepEqual(res.watch.reverted, []);
  assert.equal(git(fx.WT, 'show', '--name-only', '--format=', 'HEAD'), 'src/b');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/b'), 'utf8'), 'amended\n');
});

test('a file outside frozen and current scopes is still reverted', () => {
  const fx = fixture(); legacyAmend(fx);
  put(fx.WT, 'rogue', 'rogue edit\n');
  const res = record(fx);
  assert.equal(res.outcome, 'recorded'); assert.ok(res.reverted.includes('rogue'));
  assert.equal(fs.readFileSync(path.join(fx.WT, 'rogue'), 'utf8'), 'original\n');
});

test('reauthorize refuses no active run, wrong wave, no change and unaudited task files without writes', () => {
  for (const mode of ['absent', 'wrong-wave', 'unchanged', 'unaudited', 'mismatch', 'old-amendment', 'no-boundary', 'prose-only']) {
    const fx = fixture();
    if (mode !== 'unchanged') legacyAmend(fx, { recorded: mode !== 'unaudited' });
    const state = readState(fx.statePath);
    if (mode === 'absent') state.active_run = null;
    if (mode === 'wrong-wave') state.active_run.wave = 2;
    if (mode === 'mismatch') state.tasks[0].files = ['rogue'];
    if (mode === 'old-amendment') state.active_run.scope_event_cursor = events(fx).length;
    if (mode === 'no-boundary') delete state.active_run.scope_event_cursor;
    if (mode === 'prose-only') {
      // Historical prose cannot prove which task files were approved.
      fs.writeFileSync(path.join(fx.bundle, 'events.jsonl'), JSON.stringify({ type: 'plan_amended', summary: 'widen task 1' }) + '\n');
    }
    writeState(fx.statePath, state);
    const before = snapshot(fx); const res = reauth(fx);
    assert.notEqual(res.status, 0, mode); assert.match(res.stderr, /reauthorize-scope/, mode);
    assert.deepEqual(snapshot(fx), before, mode);
  }
});

test('reauthorize only widens even when current declarations dropped old entries', () => {
  const fx = fixture(); legacyAmend(fx, { files: ['rogue'] });
  assert.equal(reauth(fx).status, 0);
  assert.deepEqual(readState(fx.statePath).active_run.scope, ['src/a', 'rogue']);
  const before = snapshot(fx); assert.notEqual(reauth(fx).status, 0); assert.deepEqual(snapshot(fx), before);
});

for (const verb of ['amend-plan', 'amend-tasks']) test(verb + ' reauthorizes active-wave files in its own amendment event', () => {
  const fx = fixture();
  const before = readState(fx.statePath).active_run;
  const args = verb === 'amend-plan' ? ['--summary=widen task 1', '--session=test', '--host=test'] : ['--plan-index=' + fx.index];
  const res = fx.mp(verb, ...args); assert.equal(res.status, 0, res.stderr);
  const state = readState(fx.statePath);
  assert.deepEqual(state.tasks[0].files, ['src/']);
  assert.deepEqual(state.active_run, { ...before, scope: ['src/a', 'src/'] });
  const ev = events(fx).at(-1);
  assert.equal(ev.type, verb === 'amend-plan' ? 'plan_amended' : 'tasks_amended');
  assert.deepEqual(ev.task_files, [{ id: 1, wave: 1, files: ['src/'] }]);
  assert.deepEqual(ev.scope_reauthorization.added_entries, ['src/']);
  assert.equal(ev.scope_reauthorization.amendment.type, ev.type);
  put(fx.WT, 'src/b', 'safe\n'); assert.deepEqual(record(fx).reverted, []);
});

test('scope writers honor a live foreign owner lock and leave state/events/work untouched', () => {
  const fx = fixture(); legacyAmend(fx);
  const state = readState(fx.statePath); delete state.concurrency; writeState(fx.statePath, state);
  const self = buildOwnerIdentity({ host: 'owner', session: 'owner', slug: 'scope', now: Date.now() });
  assert.equal(acquireOwner(fx.bundle, self, { now: Date.now() }).outcome, 'acquire');
  for (const args of [['reauthorize-scope', '--wave=1', '--reason=test'], ['amend-tasks', '--plan-index=' + fx.index], ['amend-plan', '--summary=test']]) {
    const before = snapshot(fx); const res = fx.mp(...args, '--session=foreign', '--host=foreign');
    assert.notEqual(res.status, 0); assert.match(res.stderr, /owned/); assert.deepEqual(snapshot(fx), before);
  }
});

test('committed recovery reports amended scope as a violation without writes', () => {
  const fx = fixture(); legacyAmend(fx);
  const base = git(fx.WT, 'rev-parse', 'HEAD');
  put(fx.WT, 'src/b', 'recovered work\n'); git(fx.WT, 'add', 'src/b'); git(fx.WT, 'commit', '-qm', 'recovered');
  const head = git(fx.WT, 'rev-parse', 'HEAD');
  // The selector reads the same persisted frozen review context as production.
  put(fx.bundle, 'wave-1.dispatch.json', JSON.stringify({ wave: 1, review_context: { enabled: true, base_sha: base, tasks: [{ task_id: 1, repo: fx.WT }] } }));
  const before = snapshot(fx); const state = readState(fx.statePath);
  const res = preflightRecovery({ statePath: fx.statePath, state, run: state.active_run, wave: 1,
    WT: fx.WT, MAIN: fx.MAIN, slug: 'scope', captureWtFiles, captureWorkspaceRoot,
    recoverySelector: { repo: fx.WT, head } });
  assert.equal(res.ok, false); assert.match(res.violations.join('\n'), /scope-amended-after-launch.*src\/b/);
  const recorded = recordWaveResult({ statePath: fx.statePath, result: null, recovery: true,
    recoverySelector: { repo: fx.WT, head } });
  assert.equal(recorded.outcome, 'recovery-preservation-violation');
  assert.match(recorded.violations.join('\n'), /scope-amended-after-launch.*src\/b/);
  assert.deepEqual(snapshot(fx), before);
});
