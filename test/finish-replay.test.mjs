// Event-keyed deploy recovery (§7.2). Every case here is a REAL-WRITER replay: each
// `fx.step(...)` is a separate finishStep invocation that reads and appends to the same
// on-disk events.jsonl, so a "crash" is modelled by simply not making the next call —
// exactly the state a killed process leaves behind. Nothing is stubbed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finishStep } from '../lib/finish-step.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';

// Every fixture builds a git repo under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered here, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
after(() => {
  for (const d of FIXTURE_TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

// Spawn the REAL mp binary (finding 2 — the CLI surface must accept the archive flags). The
// finishStep lib is exercised directly everywhere else; this proves the flags are registered in
// KNOWN_FLAGS and forwarded through the adapter.
function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function readEvents(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function writeEvents(bundleDir, evs) {
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function commitOn(dir, message, ...paths) {
  git(dir, 'add', ...(paths.length ? paths : ['-A']));
  git(dir, 'commit', '-q', '-m', message);
}

// A MAIN repo, a linked worktree with one done task, the owner lock held, and a `done:`
// block supplied by the caller so each case picks its own step shapes. With `origin: true` a
// bare remote is created, wired as `origin`, and the initial MAIN state pushed to it — the
// setup an install push (and thus the push_archive gate) needs.
function makeFixture({ slug = 't25', done, autonomy = 'loose', origin = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-replay-'));
  FIXTURE_TMPDIRS.push(tmp);
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  write(MAIN, '.masterplan.yaml', done);
  git(MAIN, 'add', '.masterplan.yaml');
  git(MAIN, 'commit', '-q', '-m', 'done definition');
  let bare = null;
  if (origin) {
    bare = path.join(tmp, 'origin.git');
    git(MAIN, 'init', '--bare', '-q', bare);
    git(MAIN, 'remote', 'add', 'origin', bare);
    git(MAIN, 'push', '-q', 'origin', 'main');
  }
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, autonomy,
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
    review: { adversary: false },
  });
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-A', slug, now: 1000 });
  assert.equal(acquireOwner(bundleDir, self, { now: 1000 }).outcome, 'acquire');
  const step = (extra = {}) => finishStep({ statePath, self, now: 2000, ...extra });
  return { tmp, MAIN, WT, bundleDir, statePath, self, step, slug, bare, origin };
}

// verify → retro → branch_finish gate → merge, landing on the first deploy step.
function walkToDeploy(fx) {
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step();
  assert.equal(op.gate, 'branch_finish');
  return fx.step({ choice: 'merge' });
}

// Like walkToDeploy, but for a bundle whose `done` runs no steps: the merge choice lands on
// whatever the stage does next rather than on a deploy step.
function walkToDeployOrArchive(fx) {
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step();
  assert.equal(op.gate, 'branch_finish');
  return fx.step({ choice: 'merge' });
}

const CHECKED = 'done:\n  release:\n    - run: /bin/true\n      check: /bin/true\n';
const CHECKLESS = 'done:\n  install:\n    - run: /bin/true\n';
// A check that reports the step's work absent — the probe's "exit 1 means absent" path.
const FAILING_CHECK = 'done:\n  release:\n    - run: /bin/true\n      check: /bin/false\n';

const typesFor = (fx, t) => readEvents(fx.bundleDir).filter((e) => e.type === t);
const latest = (fx, t) => [...readEvents(fx.bundleDir)].reverse().find((e) => e.type === t) ?? null;

// ---------------------------------------------------------------------------
// Authorization / start ordering
// ---------------------------------------------------------------------------

test('loose: authorization and start are appended together, in that order, before the command runs', () => {
  const fx = makeFixture({ done: CHECKED });
  const op = walkToDeploy(fx);
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, false, 'loose autonomy does not ask');
  const evs = readEvents(fx.bundleDir).map((e) => e.type);
  const a = evs.indexOf('deploy_step_authorized');
  const s = evs.indexOf('deploy_step_started');
  assert.ok(a >= 0 && s >= 0, JSON.stringify(evs));
  assert.ok(a < s, 'authorization precedes start');
  // and no outcome yet — the caller has not reported
  assert.equal(latest(fx, 'deploy_step'), null);
});

test('gated: the first entry asks, and only the authorized re-entry starts the step', () => {
  const fx = makeFixture({ done: CHECKED, autonomy: 'gated' });
  const op = walkToDeploy(fx);
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, true, 'gated autonomy asks first');
  // Nothing is durable yet: an unanswered ask authorizes nothing.
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 0);
  assert.equal(typesFor(fx, 'deploy_step_started').length, 0);
  // Re-entering without the authorization asks again rather than drifting into a start.
  assert.equal(fx.step().ask, true);
  assert.equal(typesFor(fx, 'deploy_step_started').length, 0);
  const go = fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  assert.equal(go.op, 'run_deploy_step');
  assert.equal(go.ask, false);
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 1);
  assert.equal(typesFor(fx, 'deploy_step_started').length, 1);
});

test('an authorization with no start survives re-entry and is re-audited, not re-authorized', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  // Model the crash between authorize and start: drop only the start.
  writeEvents(fx.bundleDir, readEvents(fx.bundleDir).filter((e) => e.type !== 'deploy_step_started'));
  const op = fx.step();
  assert.equal(op.op, 'run_deploy_step');
  // The surviving authorization is honoured — exactly one, never a second.
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 1, 'the recovered authorization is preserved');
  assert.equal(typesFor(fx, 'deploy_step_started').length, 1);
});

test('a preserved authorization is still re-audited: a foreign commit since blocks the start', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  writeEvents(fx.bundleDir, readEvents(fx.bundleDir).filter((e) => e.type !== 'deploy_step_started'));
  // The base moved while the process was dead. The authorization is not a licence to launch.
  write(fx.MAIN, 'src/foreign.js', 'x\n');
  commitOn(fx.MAIN, 'foreign commit while dead', 'src/foreign.js');
  assert.throws(() => fx.step(), /base moved/);
  assert.equal(typesFor(fx, 'deploy_step_started').length, 0, 'nothing started');
});

test('a start with no authorization is refused as an inconsistent ledger, never probed', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  // A start whose authorization is gone cannot have come from this code path. Probing it would
  // let an unauthorized command's output be recorded as this run's.
  writeEvents(fx.bundleDir, readEvents(fx.bundleDir).filter((e) => e.type !== 'deploy_step_authorized'));
  assert.throws(() => fx.step(), /deploy_step_started with no preceding deploy_step_authorized/);
  assert.equal(latest(fx, 'deploy_step'), null, 'no outcome recorded');
  assert.equal(latest(fx, 'deploy_indeterminate'), null);
});

test('a second start on one authorization is an unauthorized rerun and is refused', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  // authorized, start, start — the second start is a rerun nothing authorized. Probing it would
  // record whatever that rerun did as this run's output.
  const evs = readEvents(fx.bundleDir);
  const start = evs.find((e) => e.type === 'deploy_step_started');
  writeEvents(fx.bundleDir, [...evs, { ...start }]);
  assert.throws(() => fx.step(), /no preceding deploy_step_authorized/);
  assert.equal(latest(fx, 'deploy_step'), null, 'no outcome recorded');
  assert.equal(latest(fx, 'deploy_indeterminate'), null);
});

test('a start recorded before its authorization is refused, not read as an unstarted authorization', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  // start, authorized — pairing is by ORDER, so the orphan start cannot be excused by a
  // later authorization.
  const evs = readEvents(fx.bundleDir);
  const auth = evs.findIndex((e) => e.type === 'deploy_step_authorized');
  const start = evs.findIndex((e) => e.type === 'deploy_step_started');
  const swapped = [...evs];
  [swapped[auth], swapped[start]] = [swapped[start], swapped[auth]];
  writeEvents(fx.bundleDir, swapped);
  assert.throws(() => fx.step(), /no preceding deploy_step_authorized/);
  assert.equal(latest(fx, 'deploy_step'), null);
});

test('a retry pairs its own start: two authorizations and two starts replay cleanly', () => {
  const fx = makeFixture({ done: FAILING_CHECK });
  walkToDeploy(fx);
  assert.equal(fx.step().gate, 'deploy_failed');
  assert.equal(fx.step({ deployRetry: { group: 'release', index: 0 } }).op, 'run_deploy_step');
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 2);
  assert.equal(typesFor(fx, 'deploy_step_started').length, 2);
  // Balanced pairs are a legitimate ledger: re-entry probes the crash window, it does not throw.
  const op = fx.step();
  assert.equal(op.gate, 'deploy_failed', JSON.stringify(op));
});

// ---------------------------------------------------------------------------
// The crash window: a started step is probed, never replayed
// ---------------------------------------------------------------------------

test('a started step whose check passes is recorded done from the probe, not rerun', () => {
  const marker = path.join(os.tmpdir(), `mp-replay-probe-${process.pid}`);
  fs.rmSync(marker, { force: true });
  const fx = makeFixture({
    // `run` appends to the marker; `check` merely tests for it. If recovery replayed the
    // command the marker would gain a second line — the assertion below is what proves it did not.
    done: `done:\n  release:\n    - run: sh -c 'echo ran >> ${marker}'\n      check: test -f ${marker}\n`,
  });
  const op = walkToDeploy(fx);
  assert.equal(op.op, 'run_deploy_step');
  fs.writeFileSync(marker, 'ran\n'); // the command ran, then the process died before reporting
  const next = fx.step();
  const rec = latest(fx, 'deploy_step');
  assert.equal(rec.status, 'done');
  assert.equal(rec.source, 'recovery-probe', 'recorded from the probe');
  assert.equal(rec.check_exit, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran\n', 'the command was NOT replayed');
  assert.notEqual(next.op, 'run_deploy_step');
  fs.rmSync(marker, { force: true });
});

test('check exit 1 on the probe means absent: deploy_failed, and a rerun needs a fresh authorization', () => {
  const fx = makeFixture({ done: FAILING_CHECK });
  walkToDeploy(fx);
  const op = fx.step(); // recovery probe: check exits 1
  assert.equal(op.gate, 'deploy_failed', JSON.stringify(op));
  assert.equal(latest(fx, 'deploy_failed').check_exit, 1);
  assert.deepEqual(op.choices, ['retry', 'skip', 'abort']);
  // Halted: re-entry re-renders the gate rather than restarting the command.
  assert.equal(fx.step().gate, 'deploy_failed');
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 1, 'no silent re-authorization');
  // A retry is a FRESH authorization: a second authorized+started pair.
  const retry = fx.step({ deployRetry: { group: 'release', index: 0 } });
  assert.equal(retry.op, 'run_deploy_step');
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 2);
  assert.equal(typesFor(fx, 'deploy_step_started').length, 2);
});

test('every other nonzero check result is indeterminate, not a failure', () => {
  for (const code of [2, 7, 127]) {
    const fx = makeFixture({ done: `done:\n  release:\n    - run: /bin/true\n      check: sh -c 'exit ${code}'\n` });
    walkToDeploy(fx);
    const op = fx.step();
    assert.equal(op.gate, 'deploy_indeterminate', `check exit ${code}: ${JSON.stringify(op)}`);
    assert.equal(latest(fx, 'deploy_indeterminate').check_exit, code);
    assert.equal(latest(fx, 'deploy_failed'), null, `check exit ${code} is not a failure`);
  }
});

test('a check-less started step is indeterminate — there is nothing to probe', () => {
  const fx = makeFixture({ done: CHECKLESS });
  walkToDeploy(fx);
  const op = fx.step();
  assert.equal(op.gate, 'deploy_indeterminate');
  assert.equal(latest(fx, 'deploy_indeterminate').check_exit, -1, 'no check to probe');
});

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

test('attestation resolves an interrupted check-less step and records status attested', () => {
  const fx = makeFixture({ done: CHECKLESS });
  walkToDeploy(fx);
  assert.equal(fx.step().gate, 'deploy_indeterminate');
  const op = fx.step({ deployAttest: { group: 'install', index: 0 } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const att = latest(fx, 'deploy_step');
  assert.equal(att.status, 'attested');
  assert.deepEqual(att.commits, [], 'an attestation claims no output of its own');
  assert.equal(typeof att.head_after, 'string');
});

test('attestation cannot prove a checked step, and cannot pre-empt a step that is not indeterminate', () => {
  const checked = makeFixture({ done: CHECKED });
  walkToDeploy(checked);
  // A checked step's truth is the check's to state, not the operator's.
  assert.throws(() => checked.step({ deployAttest: { group: 'release', index: 0 } }), /only for check-less steps/);
  const fresh = makeFixture({ done: CHECKLESS });
  walkToDeploy(fresh);
  // Started but never halted: there is no gate for an attestation to answer.
  assert.throws(() => fresh.step({ deployAttest: { group: 'install', index: 0 } }), /is not indeterminate/);
  assert.equal(fresh.step().gate, 'deploy_indeterminate');
  assert.throws(() => fresh.step({ deployAttest: { group: 'install', index: 9 } }), /unknown step/);
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test('deploy abort is resumable: a refused abort leaves the gate open and the run untouched', () => {
  const fx = makeFixture({ done: FAILING_CHECK });
  walkToDeploy(fx);
  // Not halted yet — an abort has no gate to answer, and refusing it must change nothing.
  assert.throws(() => fx.step({ deployAbort: true }), /is not halted/);
  assert.equal(latest(fx, 'incomplete_authorized'), null);
  assert.notEqual(readState(fx.statePath).status, 'archived');
  // Reach the gate, then abort with a foreign commit present: refused, still resumable.
  assert.equal(fx.step().gate, 'deploy_failed');
  write(fx.MAIN, 'src/foreign.js', 'x\n');
  commitOn(fx.MAIN, 'foreign while halted', 'src/foreign.js');
  assert.throws(() => fx.step({ deployAbort: true }), /base moved/);
  assert.equal(latest(fx, 'incomplete_authorized'), null, 'nothing authorized');
  assert.equal(fx.step().gate, 'deploy_failed', 'the gate is still open and answerable');
  // With the base restored the abort lands. A soft reset — a hard one would rewind the
  // committed bundle along with the foreign commit and destroy the very ledger under test.
  git(fx.MAIN, 'reset', '-q', '--soft', 'HEAD~1');
  git(fx.MAIN, 'rm', '-q', '-f', '--cached', 'src/foreign.js');
  fs.rmSync(path.join(fx.MAIN, 'src', 'foreign.js'));
  const op = fx.step({ deployAbort: true });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.equal(latest(fx, 'incomplete_authorized').reason, 'deploy_abort');
});

// ---------------------------------------------------------------------------
// Recovery after each deploy gate
// ---------------------------------------------------------------------------

test('re-entry after each deploy gate re-renders that gate and records nothing new', () => {
  // deploy_failed
  const failed = makeFixture({ done: FAILING_CHECK });
  walkToDeploy(failed);
  assert.equal(failed.step().gate, 'deploy_failed');
  const beforeF = readEvents(failed.bundleDir).length;
  assert.equal(failed.step().gate, 'deploy_failed');
  assert.equal(readEvents(failed.bundleDir).length, beforeF, 'a re-render appends nothing');

  // deploy_indeterminate
  const indet = makeFixture({ done: CHECKLESS });
  walkToDeploy(indet);
  assert.equal(indet.step().gate, 'deploy_indeterminate');
  const beforeI = readEvents(indet.bundleDir).length;
  assert.equal(indet.step().gate, 'deploy_indeterminate');
  assert.equal(readEvents(indet.bundleDir).length, beforeI);
});

test('a reported outcome is never re-reported: the step is recorded once and the stage moves on', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  const done = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(typesFor(fx, 'deploy_step').length, 1);
  assert.notEqual(done.op, 'run_deploy_step');
  // A second report for a step already recorded is refused.
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /already recorded/);
  assert.equal(typesFor(fx, 'deploy_step').length, 1);
});

test('a report with no authorization or start behind it is refused', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  writeEvents(fx.bundleDir, readEvents(fx.bundleDir).filter((e) => e.type !== 'deploy_step_started'));
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /without authorization\/start/);
  writeEvents(fx.bundleDir, readEvents(fx.bundleDir).filter((e) => e.type !== 'deploy_step_authorized'));
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /without authorization\/start/);
  assert.equal(typesFor(fx, 'deploy_step').length, 0);
});

test('a halted step refuses a plain report — the operator must retry or rerun first', () => {
  const fx = makeFixture({ done: FAILING_CHECK });
  walkToDeploy(fx);
  assert.equal(fx.step().gate, 'deploy_failed');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /is halted/);
  const retry = fx.step({ deployRetry: { group: 'release', index: 0 } });
  assert.equal(retry.op, 'run_deploy_step');
});

// ---------------------------------------------------------------------------
// Group order, mandatory groups and skips (wave task 26)
// ---------------------------------------------------------------------------

// The declaration order in the YAML is deliberately scrambled; the chain must still run
// release -> install -> user_only -> live_check.
const SCRAMBLED = [
  'done:',
  '  live_check:',
  '    - run: /bin/true',
  '  user_only:',
  '    - text: click the button',
  '      check: /bin/true',
  '  install:',
  '    - run: /bin/true',
  '  release:',
  '    - run: /bin/true',
  '',
].join('\n');

test('the deploy chain runs in fixed group order regardless of declaration order', () => {
  const fx = makeFixture({ done: SCRAMBLED });
  let op = walkToDeploy(fx);
  // release first, though it is declared last.
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'release', JSON.stringify(op));
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'install', JSON.stringify(op));
  op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  // user_only is handed back rather than run.
  assert.equal(op.ask, 'handback', JSON.stringify(op));
  assert.equal(op.group, 'user_only');
  op = fx.step({ deployStepDone: { group: 'user_only', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  const order = readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step').map((e) => e.group);
  assert.deepEqual(order, ['release', 'install', 'user_only']);
});

test('a step cannot be reported out of the chain order', () => {
  const fx = makeFixture({ done: SCRAMBLED });
  walkToDeploy(fx);
  // live_check is last; reporting it while release is pending is refused. The authorization
  // check happens to fire first — either way no outcome is recorded for a step the chain has
  // not reached.
  assert.throws(
    () => fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0 } }),
    /without authorization\/start|out of order/,
  );
  assert.equal(typesFor(fx, 'deploy_step').length, 0);
});

test('release and install offer skip; live_check never does', () => {
  const fx = makeFixture({ done: 'done:\n  release:\n    - run: /bin/false\n  install:\n    - run: /bin/false\n  live_check:\n    - run: /bin/false\n' });
  walkToDeploy(fx);
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  assert.deepEqual(op.choices, ['retry', 'skip', 'abort'], 'release is skippable, archiving incomplete');
  // Skip release and reach install, which is skippable on the same terms.
  op = fx.step({ deploySkip: { group: 'release', index: 0 } });
  assert.equal(op.group, 'install', JSON.stringify(op));
  op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  assert.deepEqual(op.choices, ['retry', 'skip', 'abort'], 'install is skippable too');
  op = fx.step({ deploySkip: { group: 'install', index: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  assert.ok(readEvents(fx.bundleDir).some((e) => e.reason === 'deploy_skip:install[0]'), 'the install skip is durable');
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  // The run's own liveness evidence cannot be waived.
  assert.deepEqual(op.choices, ['retry', 'abort'], 'live_check offers no skip');
  assert.throws(() => fx.step({ deploySkip: { group: 'live_check', index: 0 } }), /live_check\[0\] cannot be skipped/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.reason === 'deploy_skip:live_check[0]'));
});

test('a skipped mandatory step archives the run incomplete, never complete', () => {
  const fx = makeFixture({ done: 'done:\n  release:\n    - run: /bin/false\n' });
  walkToDeploy(fx);
  assert.equal(fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } }).gate, 'deploy_failed');
  const op = fx.step({ deploySkip: { group: 'release', index: 0 } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const skip = readEvents(fx.bundleDir).find((e) => e.reason === 'deploy_skip:release[0]');
  assert.equal(skip.type, 'incomplete_authorized');
  assert.equal(typeof skip.head_after, 'string', 'the skip audits and records the boundary');
  assert.notEqual(readState(fx.statePath).status, 'complete');
});

// ---------------------------------------------------------------------------
// user_only handback
// ---------------------------------------------------------------------------

test('a user_only step is handed back and its check result maps to the three outcomes', () => {
  // exit 0 -> done
  const done = makeFixture({ done: 'done:\n  user_only:\n    - text: register the hook\n      check: /bin/true\n' });
  walkToDeploy(done);
  let op = done.step();
  assert.equal(op.ask, 'handback', JSON.stringify(op));
  assert.match(op.text, /register the hook/);
  op = done.step({ deployStepDone: { group: 'user_only', index: 0, exit: 0 } });
  assert.equal(latest(done, 'deploy_step').status, 'done');

  // exit 1 -> the work is absent, so the operator is asked AGAIN rather than sent to a gate;
  // the attempt is durable as deploy_step_check_failed.
  const absent = makeFixture({ done: 'done:\n  user_only:\n    - text: register the hook\n      check: /bin/false\n' });
  walkToDeploy(absent);
  absent.step();
  op = absent.step({ deployStepDone: { group: 'user_only', index: 0, exit: 1 } });
  assert.equal(op.ask, 'handback', JSON.stringify(op));
  assert.equal(latest(absent, 'deploy_step_check_failed').index, 0);
  assert.equal(latest(absent, 'deploy_step'), null, 'an absent handback records no done step');

  // any other exit -> indeterminate
  const indet = makeFixture({ done: "done:\n  user_only:\n    - text: register the hook\n      check: sh -c 'exit 7'\n" });
  walkToDeploy(indet);
  indet.step();
  op = indet.step({ deployStepDone: { group: 'user_only', index: 0, exit: 7 } });
  assert.equal(op.gate, 'deploy_indeterminate', JSON.stringify(op));
  assert.equal(latest(indet, 'deploy_indeterminate').check_exit, 7);
});

test('a user_only step is never authorized — it is handed back', () => {
  const fx = makeFixture({ done: 'done:\n  user_only:\n    - text: do the thing\n      check: /bin/true\n' });
  walkToDeploy(fx);
  assert.throws(() => fx.step({ deployAuthorize: { group: 'user_only', index: 0 } }), /handed back, never authorized/);
});

// ---------------------------------------------------------------------------
// Stage-produced commits: inside commit_paths, and outside
// ---------------------------------------------------------------------------

const RELEASE_WITH_PATHS = [
  'done:',
  '  version_from: .claude-plugin/plugin.json',
  '  commit_paths:',
  '    - CHANGELOG.md',
  '  release:',
  '    - run: /bin/true',
  '',
].join('\n');

test('a stage commit inside commit_paths is a receipt; one outside is a base move', () => {
  const inside = makeFixture({ done: RELEASE_WITH_PATHS });
  write(inside.MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '3.0.0' }));
  commitOn(inside.MAIN, 'version file', '.claude-plugin/plugin.json');
  walkToDeploy(inside);
  // The step's own command commits CHANGELOG.md — declared in commit_paths, version unchanged.
  write(inside.MAIN, 'CHANGELOG.md', '## 3.0.0\n');
  commitOn(inside.MAIN, 'release: changelog', 'CHANGELOG.md');
  const op = inside.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(latest(inside, 'deploy_step').status, 'done', JSON.stringify(op));
  assert.ok(latest(inside, 'deploy_step').commits.length >= 1, 'the receipt names the commit it produced');

  // The same shape, but the commit touches a path nobody declared.
  const outside = makeFixture({ done: RELEASE_WITH_PATHS });
  write(outside.MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '3.0.0' }));
  commitOn(outside.MAIN, 'version file', '.claude-plugin/plugin.json');
  walkToDeploy(outside);
  write(outside.MAIN, 'src/sneaky.js', 'application code\n');
  commitOn(outside.MAIN, 'a commit outside commit_paths', 'src/sneaky.js');
  assert.throws(() => outside.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /base moved/);
  assert.equal(latest(outside, 'deploy_step'), null, 'no outcome is recorded for a moved base');
});

test('a stage commit inside commit_paths that CHANGES the version is still a base move', () => {
  const fx = makeFixture({ done: RELEASE_WITH_PATHS });
  write(fx.MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '3.0.0' }));
  commitOn(fx.MAIN, 'version file', '.claude-plugin/plugin.json');
  walkToDeploy(fx);
  // version_from is not in commit_paths, and moving it under cover of the stage would let the
  // released version differ from the reviewed one.
  write(fx.MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '4.0.0' }));
  commitOn(fx.MAIN, 'quietly bump the version', '.claude-plugin/plugin.json');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /base moved/);
});

// ---------------------------------------------------------------------------
// Bundle commits: this run's, a sibling's, and a foreign commit
// ---------------------------------------------------------------------------

test('this run\'s bundle commit and a sibling bundle\'s commit are both legal history', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  write(fx.MAIN, `docs/masterplan/${fx.slug}/notes.md`, 'this run wrote its ledger\n');
  commitOn(fx.MAIN, 'own bundle commit', `docs/masterplan/${fx.slug}/notes.md`);
  write(fx.MAIN, 'docs/masterplan/other-run/state.yml', 'a sibling run\n');
  commitOn(fx.MAIN, 'sibling bundle commit', 'docs/masterplan/other-run/state.yml');
  const op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(latest(fx, 'deploy_step').status, 'done', JSON.stringify(op));
});

test('a foreign commit made during a step invalidates the step, not just the run', () => {
  const fx = makeFixture({ done: CHECKED });
  walkToDeploy(fx);
  write(fx.MAIN, 'src/foreign.js', 'someone else\n');
  commitOn(fx.MAIN, 'foreign commit', 'src/foreign.js');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /base moved/);
  // The refusal REPEATS on replay — a moved base does not become acceptable by asking twice —
  // and it names the receipts at that deploy base as invalid rather than silently keeping them.
  assert.throws(
    () => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }),
    /receipts (recorded )?at deploy_base/,
  );
  assert.equal(latest(fx, 'deploy_step'), null, 'no outcome is recorded on either attempt');
});

// ---------------------------------------------------------------------------
// Dirty tree
// ---------------------------------------------------------------------------

test('a dirty tree outside the bundle refuses the stage; a dirty bundle does not', () => {
  // The dirt check guards every AUTHORIZATION, so the tree must be dirty before the stage is
  // entered — once a step is authorized and started, a re-entry probes it instead.
  const fx = makeFixture({ done: CHECKED });
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  fs.writeFileSync(op.path, '# retro\n');
  assert.equal(fx.step().gate, 'branch_finish');
  write(fx.MAIN, 'src/uncommitted.js', 'work in progress\n');
  assert.throws(() => fx.step({ choice: 'merge' }), /dirty outside docs\/masterplan/);
  assert.equal(typesFor(fx, 'deploy_step_authorized').length, 0, 'nothing was authorized');
  fs.rmSync(path.join(fx.MAIN, 'src', 'uncommitted.js'));
  // An uncommitted BUNDLE file is this run's own ledger and never blocks the stage.
  write(fx.MAIN, `docs/masterplan/${fx.slug}/scratch.md`, 'ledger in progress\n');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

// ---------------------------------------------------------------------------
// done: none
// ---------------------------------------------------------------------------

test('done: none runs no groups and produces an empty deploy chain', () => {
  const fx = makeFixture({ done: 'done: none\n' });
  const op = walkToDeployOrArchive(fx);
  // Nothing to run: the stage has no steps at all.
  assert.notEqual(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.deepEqual(readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step'), []);
  assert.deepEqual(readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step_authorized'), []);
});

// ---------------------------------------------------------------------------
// Full-run replay
// ---------------------------------------------------------------------------

test('a full run replays from the ledger: every re-entry lands on the same next step', () => {
  const fx = makeFixture({ done: 'done:\n  release:\n    - run: /bin/true\n  install:\n    - run: /bin/true\n' });
  const first = walkToDeploy(fx);
  assert.equal(first.group, 'release', JSON.stringify(first));
  // A check-less step that was started but never reported is indeterminate on re-entry —
  // the ledger, not the process, decides where the stage stands.
  const again = fx.step();
  assert.equal(again.gate, 'deploy_indeterminate', JSON.stringify(again));
  const before = readEvents(fx.bundleDir).length;
  assert.equal(fx.step().gate, 'deploy_indeterminate');
  assert.equal(readEvents(fx.bundleDir).length, before, 'a re-rendered gate appends nothing');
  // Attesting the interrupted check-less step closes it and the chain moves to install.
  const afterAttest = fx.step({ deployAttest: { group: 'release', index: 0 } });
  assert.equal(afterAttest.op, 'run_deploy_step', JSON.stringify(afterAttest));
  assert.equal(afterAttest.group, 'install', 'the attestation advances the chain to the next step');
  assert.equal(typesFor(fx, 'deploy_step').length, 1);

  // Complete the last step: the stage ends and the run archives.
  const terminal = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  assert.equal(terminal.reason, 'archived', JSON.stringify(terminal));
  assert.equal(typesFor(fx, 'deploy_step').length, 2, 'both steps are recorded exactly once');
  // The archive is a STATE transition plus a bundle commit, not an event append.
  assert.equal(readState(fx.statePath).status, 'archived');

  // ...and the TERMINAL state replays too: re-entering an archived bundle reconstructs the same
  // answer from disk and appends nothing.
  const beforeReplay = readEvents(fx.bundleDir).length;
  const replayed = fx.step();
  assert.equal(replayed.reason, 'archived', JSON.stringify(replayed));
  assert.equal(readEvents(fx.bundleDir).length, beforeReplay, 're-entry after completion appends nothing');
  assert.equal(typesFor(fx, 'deploy_step').length, 2);
});

test('a release re-entry still fails while the moved code names an already-tagged version', () => {
  const fx = makeFixture({
    done: 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n',
  });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  commitOn(fx.WT, 'the branch names 1.2.3');
  git(fx.MAIN, 'tag', 'v1.2.3'); // ...which is already published
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  fs.writeFileSync(op.path, '# retro\n');
  assert.equal(fx.step().gate, 'branch_finish');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v1.2.3');

  // The operator goes to fix it...
  assert.equal(fx.step({ choice: 'merge', versionFix: true }).reason, 'version_fix');
  // ...and commits a change that moves code WITHOUT bumping the version.
  write(fx.WT, 'src/fix.txt', 'a real fix, but no bump\n');
  commitOn(fx.WT, 'fix without a bump');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', 'moved code that still names the tagged version is refused again');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'the stage was never entered');

  // A real bump clears it and the stage opens.
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.4' }));
  commitOn(fx.WT, 'bump to 1.2.4');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

// ---------------------------------------------------------------------------
// §7.2 push_archive — the post-archive push gate (wave task 29)
// ---------------------------------------------------------------------------
//
// The push gate is emitted ONLY when an install-group receipt PROVED it pushed the base
// (the producer stamped `pushed_base` on the receipt = the sha the install push carried).
// It always halts (operator approval) under gated and loose alike, lists exactly
// `pushed_base..HEAD`, and accepts `archive_pushed {sha}` as the sole post-archive event.
// An install chain that never moved the remote (or a repo with no origin) records no
// pushed_base and stops with a plain archived stop, never a push gate.

const INSTALL_ONLY = 'done:\n  install:\n    - run: /bin/true\n';

// Walk to the deploy stage and run a single install step whose run "pushes" origin/main to
// the post-merge HEAD (what a real install step's `git push origin <base>` does). Returns
// the op that follows the deploy_step_done report.
function walkInstallPush(fx, { push = true } = {}) {
  let op = walkToDeploy(fx);
  assert.equal(op.group, 'install', JSON.stringify(op));
  if (push) git(fx.MAIN, 'push', '-q', 'origin', 'main'); // the install step moves origin/main
  return fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
}

test('an install step that pushed the base records pushed_base and the archive opens the push_archive gate', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  const op = walkInstallPush(fx);
  // The run archives and the gate opens in the SAME call — the gate replaces the plain stop.
  assert.equal(op.gate, 'push_archive', JSON.stringify(op));
  assert.equal(op.remote, 'origin');
  assert.equal(op.branch, 'main');
  const install = latest(fx, 'deploy_step');
  assert.equal(install.group, 'install');
  assert.ok(install.pushed_base, 'the install receipt carries pushed_base');
  // The offered range is exactly pushed_base..HEAD: the archive commit and the gate-state
  // commit (the gate is opened and its state committed at archive — §7.2's "the archive commit
  // and any gate commits since"). Nothing else: the install push carried the merge/release line
  // already on origin.
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.equal(op.sha, head, 'the gate offers the archive HEAD');
  assert.equal(op.commits.length, 2, 'pushed_base..HEAD = archive commit + gate-state commit');
  assert.equal(op.commits[op.commits.length - 1], head, 'the last listed commit is the archive HEAD');
  // The run is archived (status) while the gate is open — a durable, re-entrant state.
  assert.equal(readState(fx.statePath).status, 'archived');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'push_archive');
});

test('re-entry on an archived bundle without archive_pushed re-emits the push_archive gate', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const before = readEvents(fx.bundleDir).length;
  const again = fx.step();
  assert.equal(again.gate, 'push_archive', JSON.stringify(again));
  assert.equal(readEvents(fx.bundleDir).length, before, 're-emitting the gate appends nothing');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'push_archive');
});

test('--archive-pushed --sha records archive_pushed and resolves the gate', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  // The operator pushes origin/main to the archive HEAD, then reports it.
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  const op = fx.step({ archivePushed: { sha: head } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed' && e.sha === head));
  assert.equal(readState(fx.statePath).pending_gate, null, 'the gate is cleared');
  // The bundle is archived and the push event is durable — re-entry stays a plain archived stop.
  assert.equal(fx.step().reason, 'archived');
});

test('--archive-pushed with a sha that is not the archive HEAD is refused', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const notHead = git(fx.MAIN, 'rev-parse', 'HEAD~1');
  assert.throws(() => fx.step({ archivePushed: { sha: notHead } }), /does not match the archive HEAD/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'nothing recorded');
});

test('declining the push_archive gate records archive_push_skipped and the archive stays pushed: no', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const op = fx.step({ archivePushSkipped: { reason: 'the operator declined to publish' } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const skip = readEvents(fx.bundleDir).find((e) => e.type === 'archive_push_skipped');
  assert.ok(skip, 'the decline is durable');
  assert.equal(skip.reason, 'the operator declined to publish');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'no push claimed');
  // Re-entry on a declined archive is a plain archived stop (the decision is final).
  assert.equal(fx.step().reason, 'archived');
});

test('an install chain that never moved the remote records no pushed_base and stops without a push gate', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  // No `git push` in the shell: origin/main never advances past its initial state.
  const op = walkInstallPush(fx, { push: false });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.equal(readState(fx.statePath).pending_gate, null, 'no push gate');
  const install = latest(fx, 'deploy_step');
  assert.equal(install.pushed_base, undefined, 'no pushed_base without a remote move');
});

test('a repo with no origin remote never reaches the push gate, whatever the install group', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: false });
  const op = walkInstallPush(fx, { push: false });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.equal(readState(fx.statePath).pending_gate, null, 'no push gate without an origin');
});

test('done: none archives as merged and never reaches the push gate', () => {
  const fx = makeFixture({ done: 'done: none\n', origin: true });
  let op = walkToDeployOrArchive(fx);
  if (op.op === 'run_verify') { op = fx.step({ verify: 'pass' }); }
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.status, 'archived');
  assert.equal(st.completion, 'merged');
  assert.equal(st.pending_gate, null, 'done: none has no push gate');
});

test('release steps never record pushed_base and never open the push gate, even with an origin', () => {
  const fx = makeFixture({ done: 'done:\n  release:\n    - run: /bin/true\n', origin: true });
  let op = walkToDeploy(fx);
  assert.equal(op.group, 'release', JSON.stringify(op));
  git(fx.MAIN, 'push', '-q', 'origin', 'main'); // a release step pushing does not gate
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const release = latest(fx, 'deploy_step');
  assert.equal(release.pushed_base, undefined, 'release never carries pushed_base');
  assert.equal(readState(fx.statePath).pending_gate, null, 'no push gate after release-only deploy');
});

test('push succeeded, crash before --deploy-step-done, recovery records pushed_base', () => {
  // The install step ran, PUSHED origin/main to the post-step HEAD, then the process died
  // before the report. Re-entry finds a started-but-unreported install step; the check probe
  // (exit 0) records it done from the probe — and the producer records pushed_base on the
  // recovery record, exactly as on a live report.
  const fx = makeFixture({ done: 'done:\n  install:\n    - run: /bin/true\n      check: /bin/true\n', origin: true });
  let op = walkToDeploy(fx);
  assert.equal(op.group, 'install', JSON.stringify(op));
  // The shell ran the step AND pushed origin/main (the step's real effect), then died before
  // the --deploy-step-done report.
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  op = fx.step(); // recovery probe: check exits 0 → recorded done from the probe, with pushed_base
  assert.equal(op.gate, 'push_archive', JSON.stringify(op)); // the push gate follows the recovery record
  const install = latest(fx, 'deploy_step');
  assert.equal(install.status, 'done');
  assert.equal(install.source, 'recovery-probe');
  assert.ok(install.pushed_base, 'the recovery record carries pushed_base too');
});

test('the push gate lists exactly pushed_base..HEAD when a gate commit lands between push and archive', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  let op = walkToDeploy(fx);
  assert.equal(op.group, 'install', JSON.stringify(op));
  git(fx.MAIN, 'push', '-q', 'origin', 'main'); // install pushes the base
  op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  assert.equal(op.gate, 'push_archive', JSON.stringify(op));
  const install = latest(fx, 'deploy_step');
  assert.ok(install.pushed_base);
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  // The offered range is the archive commit plus the gate-state commit (the fixed history the
  // push will fast-forward — exactly "the archive commit and any gate commits since", §7.2).
  assert.equal(op.commits.length, 2, 'pushed_base..HEAD = archive commit + gate-state commit');
  assert.equal(op.commits[op.commits.length - 1], head);
  assert.equal(op.pushed_base, install.pushed_base);
  // The range is fast-forwardable: pushed_base is an ancestor of HEAD.
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', install.pushed_base, head));
});

test('non-fast-forward: another host moves origin/main, the operator rebases, and the push is recorded against the rebased HEAD', () => {
  // The gate opened offering pushed_base..HEAD. Before the operator pushes, ANOTHER host moves
  // origin/main (a foreign commit). The shell-side disposition (§10.3 sibling push) is: fetch,
  // per-commit audit, rebase local <base> onto it, retry once. The operator does exactly that,
  // pushes the rebased archive, and answers --archive-pushed with the NEW HEAD — the recorded
  // push is the one that actually landed.
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const pushedBase = latest(fx, 'deploy_step').pushed_base;
  const offeredHead = git(fx.MAIN, 'rev-parse', 'HEAD');

  // Another host advances origin/main: clone the bare, commit, push.
  const foreign = path.join(fx.tmp, 'foreign');
  fs.mkdirSync(foreign, { recursive: true });
  git(foreign, 'clone', '-q', '-b', 'main', fx.bare, 'work');
  const foreignWork = path.join(foreign, 'work');
  git(foreignWork, 'config', 'user.email', 'f@f');
  git(foreignWork, 'config', 'user.name', 'f');
  git(foreignWork, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(foreignWork, 'foreign.txt'), 'another host moved main\n');
  git(foreignWork, 'add', '.');
  git(foreignWork, 'commit', '-q', '-m', 'foreign advance');
  git(foreignWork, 'push', '-q', 'origin', 'main');

  // The operator: the tree is already clean (the gate state was committed at open), so fetch,
  // rebase local main onto the foreign tip, retry push.
  git(fx.MAIN, 'fetch', '-q', 'origin', 'main');
  git(fx.MAIN, 'rebase', '-q', 'origin/main');
  const rebasedHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  assert.notEqual(rebasedHead, offeredHead, 'the rebase moved the archive head past the foreign advance');

  const op = fx.step({ archivePushed: { sha: rebasedHead } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const pushed = readEvents(fx.bundleDir).find((e) => e.type === 'archive_pushed');
  assert.ok(pushed, 'the push is recorded');
  assert.equal(pushed.sha, rebasedHead, 'the recorded sha is the rebased archive head');
  // The fast-forward premise holds through the rebase: pushed_base is an ancestor of the new head.
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', pushedBase, rebasedHead));
});

test('--archive-pushed without an open push_archive gate is refused (the gate is the offer)', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: false });
  // No origin → no pushed_base → no gate ever opens; the run archives plainly.
  const op = walkInstallPush(fx, { push: false });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ archivePushed: { sha: head } }), /no open push_archive gate/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'nothing recorded');
});

// ---------------------------------------------------------------------------
// Adversary round-1 fix tests (wave task 29 review round)
// ---------------------------------------------------------------------------
//
// Findings covered:
//   1. Indeterminate push probe (a transient fetch failure at the install step) must not
//      silently archive as `pushed: no` — the archive re-probes and halts while unresolved.
//   3. The first terminal push_archive answer is authoritative: identical replay is a no-op,
//      an opposite answer type or a mismatched sha/reason is refused.
//   4. The lib performs the REAL non-fast-forward recovery (audit + rebase + push once with
//      one retry) instead of the fixture hand-rolling it; a foreign fetched commit refuses.
//   5. --archive-pushed is bound to the REMOTE: a remote that does not carry the sha refuses.
//   6. A divergent/forged pushed_base surfaces the invariant error, not a gate listing.

test('finding-1: a transient fetch failure at the install step records an indeterminate probe and the archive halts for a re-probe', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  // Walk to the install step and push origin/main (the install's real effect).
  let op = walkToDeploy(fx);
  assert.equal(op.group, 'install', JSON.stringify(op));
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  // Make the remote probe fail: hide the bare repo so the producer's fetch fails. The step
  // still records done (a completed step is never refused by a network blip), but the probe is
  // INDETERMINATE — and the archive must NOT stop as `pushed: no`.
  const hidden = path.join(fx.tmp, 'origin.hidden');
  fs.renameSync(fx.bare, hidden);
  let recorded;
  try {
    recorded = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  } finally {
    fs.renameSync(hidden, fx.bare);
  }
  const install = latest(fx, 'deploy_step');
  assert.equal(install.status, 'done');
  assert.equal(install.pushed_base, undefined, 'the indeterminate probe stamps no pushed_base');
  const probe = latest(fx, 'push_probe');
  assert.ok(probe, 'an indeterminate push_probe is durable');
  assert.equal(probe.status, 'indeterminate');
  // The step+archive call itself surfaced the indeterminate ask (the re-probe in the SAME call
  // ran while the remote was still hidden) — NOT a plain `pushed: no` stop.
  assert.equal(recorded.ask, 'push-probe-indeterminate', JSON.stringify(recorded));
  // With the remote restored, re-entry re-probes, confirms the push, adopts the install head as
  // pushed_base and opens the push gate.
  op = fx.step();
  assert.equal(op.gate, 'push_archive', JSON.stringify(op));
  assert.equal(op.pushed_base, install.head_after, 'the re-probe adopted the install head as pushed_base');
});

test('finding-1: an unresolved indeterminate probe (remote still unreachable) halts with a push-probe-indeterminate ask, never a plain stop', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  let op = walkToDeploy(fx);
  assert.equal(op.group, 'install', JSON.stringify(op));
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  // Hide the bare for BOTH the step report AND the archive's re-probe: the whole finish-step
  // call cannot confirm the push, so it must surface the indeterminate ask, not stop plainly.
  const hidden = path.join(fx.tmp, 'origin.hidden2');
  fs.renameSync(fx.bare, hidden);
  try {
    op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  } finally {
    fs.renameSync(hidden, fx.bare);
  }
  const install = latest(fx, 'deploy_step');
  assert.equal(install.status, 'done');
  assert.equal(op.ask, 'push-probe-indeterminate', JSON.stringify(op));
  assert.notEqual(op.reason, 'archived', 'the archive did NOT stop as pushed: no');
  assert.equal(readState(fx.statePath).pending_gate, null, 'no plain archive gate while the probe is indeterminate');
  // Restoring the remote and re-entering confirms the push and opens the gate.
  const again = fx.step();
  assert.equal(again.gate, 'push_archive', JSON.stringify(again));
});

test('finding-3: the first terminal push_archive answer is authoritative — identical replay is a no-op, opposite types refuse', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  const op = fx.step({ archivePushed: { sha: head } });
  assert.equal(op.reason, 'archived');
  assert.equal(latest(fx, 'archive_pushed').sha, head);
  const countAfterFirst = readEvents(fx.bundleDir).filter((e) => e.type === 'archive_pushed').length;

  // Identical replay (crash after the append, before the gate clear): a no-op, still archived.
  const replay = fx.step({ archivePushed: { sha: head } });
  assert.equal(replay.reason, 'archived', JSON.stringify(replay));
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'archive_pushed').length, countAfterFirst, 'identical replay appends nothing');

  // A conflicting decline after a recorded push refuses.
  assert.throws(() => fx.step({ archivePushSkipped: { reason: 'changed my mind' } }), /already RECORDED/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_push_skipped'), 'no skip event written');
});

test('finding-3: a mismatched sha on a replayed --archive-pushed refuses; a decline followed by a push refuses', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  fx.step({ archivePushed: { sha: head } });

  // A replay naming a DIFFERENT sha refuses (the recorded sha is authoritative; a stale or
  // wrong sha must not be accepted as an idempotent replay).
  const other = '0'.repeat(40);
  assert.notEqual(other, head, 'the forged sha differs from the recorded one');
  assert.throws(() => fx.step({ archivePushed: { sha: other } }), /replayed push must name the same sha/);

  // A decline first, then a push: the decline is authoritative.
  const fx2 = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx2).gate, 'push_archive');
  fx2.step({ archivePushSkipped: { reason: 'never mind' } });
  const head2 = git(fx2.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx2.step({ archivePushed: { sha: head2 } }), /already DECLINED/);
  assert.ok(!readEvents(fx2.bundleDir).some((e) => e.type === 'archive_pushed'), 'no pushed event after the decline');
});

test('finding-5: --archive-pushed is bound to the remote — a remote that does not carry the sha refuses and writes nothing', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  // The operator did NOT push origin/main past the archive head — the remote tip is the install
  // head (behind the archive). The claim must refuse: the archive is not on the remote.
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ archivePushed: { sha: head } }), /does not carry the archive head/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'nothing recorded');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'push_archive', 'the gate stays open');
});

test('finding-4: the lib performs the real non-fast-forward recovery when the remote moved with a KNOWN receipt sha', () => {
  // The gate opened offering pushed_base..HEAD. ANOTHER host advances origin/main with a commit
  // whose sha the run's own ledger KNOWS (a push receipt the run previously observed) — the
  // "known receipt sha" branch of the audit. The operator answers --archive-pushed WITHOUT
  // hand-rolling fetch/rebase/push; the lib fetches, audits the fetched commit as known, rebases
  // local main onto the remote tip, pushes once, and records the rebased head.
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const offeredHead = git(fx.MAIN, 'rev-parse', 'HEAD');

  // Another host advances origin/main with a commit. Its sha is then recorded in the run's own
  // ledger as a push_receipt head_after (a prior probe observed the remote carrying it) — so the
  // recovery audit knows it, exactly the finding's "known receipt sha" permitted case.
  const foreign = path.join(fx.tmp, 'foreign-ok');
  fs.mkdirSync(foreign, { recursive: true });
  git(foreign, 'clone', '-q', '-b', 'main', fx.bare, 'work');
  const foreignWork = path.join(foreign, 'work');
  git(foreignWork, 'config', 'user.email', 'f@f');
  git(foreignWork, 'config', 'user.name', 'f');
  git(foreignWork, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(foreignWork, 'src/seed.txt'), 'seed\nplus\n');
  git(foreignWork, 'add', '.');
  git(foreignWork, 'commit', '-q', '-m', 'operator commit on another machine');
  git(foreignWork, 'push', '-q', 'origin', 'main');
  git(fx.MAIN, 'fetch', '-q', 'origin', 'main'); // MAIN now sees the foreign tip
  const knownSha = git(fx.MAIN, 'rev-parse', 'refs/remotes/origin/main'); // after the foreign push
  // Seed the run's ledger with a prior probe that observed this exact sha on the remote — a
  // legitimate "known receipt sha" the recovery audit may accept.
  const install = latest(fx, 'deploy_step');
  const evs = readEvents(fx.bundleDir);
  evs.push({ type: 'push_probe', ts: '2026-01-01T00:00:00.000Z', group: 'install', index: install.index, sha: install.sha, head_after: knownSha, base: 'main', status: 'confirmed_not_pushed' });
  writeEvents(fx.bundleDir, evs);

  // The operator answers with the ORIGINAL offered head (they have NOT pushed or rebased). The
  // lib detects the divergence, audits the fetched commit (known receipt sha → permitted),
  // rebases, pushes once, and records the rebased head.
  const op = fx.step({ archivePushed: { sha: offeredHead } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const pushed = readEvents(fx.bundleDir).find((e) => e.type === 'archive_pushed');
  assert.ok(pushed, 'the recovery records the push');
  // The recorded sha is the rebased archive head — the commit that was actually pushed. It is an
  // ancestor of HEAD (the `archive push recorded` commit lands on top of it).
  assert.notEqual(pushed.sha, offeredHead, 'the rebase moved the archive head past the foreign advance');
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', pushed.sha, git(fx.MAIN, 'rev-parse', 'HEAD')), 'the recorded sha is part of the archive history');
  // The remote carries exactly the rebased head that was pushed.
  const remoteTip = git(fx.MAIN, 'rev-parse', 'refs/remotes/origin/main');
  assert.equal(remoteTip, pushed.sha, 'the remote tip equals the recorded sha');
});

test('finding-4: a FOREIGN fetched commit (not in this run\'s history) refuses the non-fast-forward recovery', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const offeredHead = git(fx.MAIN, 'rev-parse', 'HEAD');

  // Another host advances origin/main with a FOREIGN change (foreign.txt) the run cannot attest.
  const foreign = path.join(fx.tmp, 'foreign-bad');
  fs.mkdirSync(foreign, { recursive: true });
  git(foreign, 'clone', '-q', '-b', 'main', fx.bare, 'work');
  const foreignWork = path.join(foreign, 'work');
  git(foreignWork, 'config', 'user.email', 'f@f');
  git(foreignWork, 'config', 'user.name', 'f');
  git(foreignWork, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(foreignWork, 'foreign.txt'), 'unattested change\n');
  git(foreignWork, 'add', '.');
  git(foreignWork, 'commit', '-q', '-m', 'foreign advance');
  git(foreignWork, 'push', '-q', 'origin', 'main');

  // The operator answers --archive-pushed; the lib's recovery audits the fetched commit, finds
  // it foreign, and REFUSES — nothing recorded, gate stays open.
  assert.throws(() => fx.step({ archivePushed: { sha: offeredHead } }), /is foreign/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'nothing recorded');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'push_archive', 'the gate stays open for manual reconciliation');
});

test('finding-6: a divergent pushed_base surfaces the invariant error, not a gate listing', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const install = latest(fx, 'deploy_step');
  // Build a genuinely DIVERGENT sha: a commit on a throwaway branch that shares no line with
  // HEAD (so `merge-base --is-ancestor forged HEAD` fails). Forge the install receipt to carry
  // it as pushed_base, then re-enter. The gate must refuse with the invariant error rather than
  // listing a bogus range.
  const divergeBranch = 'divergent-base';
  git(fx.MAIN, 'checkout', '-q', '-b', divergeBranch, git(fx.MAIN, 'rev-parse', 'HEAD~1'));
  fs.writeFileSync(path.join(fx.MAIN, 'diverged.txt'), 'a divergent line\n');
  git(fx.MAIN, 'add', '.');
  git(fx.MAIN, 'commit', '-q', '-m', 'divergent base');
  const forgedBase = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'checkout', '-q', 'main');
  git(fx.MAIN, 'branch', '-q', '-D', divergeBranch);
  let isAnc = false;
  try { git(fx.MAIN, 'merge-base', '--is-ancestor', forgedBase, git(fx.MAIN, 'rev-parse', 'HEAD')); isAnc = true; } catch { isAnc = false; }
  assert.equal(isAnc, false, 'the forged base really diverges from HEAD');

  const evs = readEvents(fx.bundleDir);
  const forged = evs.map((e) => (e.type === 'deploy_step' && e.index === install.index
    ? { ...e, pushed_base: forgedBase }
    : e));
  writeEvents(fx.bundleDir, forged);
  const op = fx.step();
  assert.equal(op.ask, 'dispatch-error', JSON.stringify(op));
  assert.match(op.error, /NOT an ancestor/);
  assert.equal(readState(fx.statePath).pending_gate?.id, 'push_archive', 'the durable gate stays open');
});

test('finding-4: the non-fast-forward recovery pushes ONCE with one retry — a rejected first push succeeds on the single retry', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const offeredHead = git(fx.MAIN, 'rev-parse', 'HEAD');

  // Another host advances origin/main with a KNOWN receipt sha (the recovery's audit accepts it).
  const foreign = path.join(fx.tmp, 'foreign-retry');
  fs.mkdirSync(foreign, { recursive: true });
  git(foreign, 'clone', '-q', '-b', 'main', fx.bare, 'work');
  const foreignWork = path.join(foreign, 'work');
  git(foreignWork, 'config', 'user.email', 'f@f');
  git(foreignWork, 'config', 'user.name', 'f');
  git(foreignWork, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(foreignWork, 'src/seed.txt'), 'seed\nplus\n');
  git(foreignWork, 'add', '.');
  git(foreignWork, 'commit', '-q', '-m', 'operator commit on another machine');
  git(foreignWork, 'push', '-q', 'origin', 'main');
  git(fx.MAIN, 'fetch', '-q', 'origin', 'main');
  const knownSha = git(fx.MAIN, 'rev-parse', 'refs/remotes/origin/main');
  const install = latest(fx, 'deploy_step');
  const evs = readEvents(fx.bundleDir);
  evs.push({ type: 'push_probe', ts: '2026-01-01T00:00:00.000Z', group: 'install', index: install.index, sha: install.sha, head_after: knownSha, base: 'main', status: 'confirmed_not_pushed' });
  writeEvents(fx.bundleDir, evs);

  // A pre-receive hook on the bare repo rejects the FIRST push observed and accepts the retry —
  // proving the recovery pushes exactly once plus the single retry.
  const attemptsLog = path.join(fx.tmp, 'push-attempts.log');
  fs.writeFileSync(attemptsLog, '0');
  const hookDir = path.join(fx.bare, 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookBody = '#!/bin/sh\n' +
    'n=$(cat "' + attemptsLog + '")\n' +
    'echo $((n + 1)) > "' + attemptsLog + '"\n' +
    'if [ "$n" -eq 0 ]; then echo "reject first push" >&2; exit 1; fi\n' +
    'exit 0\n';
  fs.writeFileSync(path.join(hookDir, 'pre-receive'), hookBody);
  fs.chmodSync(path.join(hookDir, 'pre-receive'), 0o755);

  const op = fx.step({ archivePushed: { sha: offeredHead } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const attempts = Number(fs.readFileSync(attemptsLog, 'utf8'));
  assert.equal(attempts, 2, 'the recovery pushed exactly once + one retry');
  const pushed = readEvents(fx.bundleDir).find((e) => e.type === 'archive_pushed');
  assert.ok(pushed, 'the push is recorded');
  assert.equal(git(fx.MAIN, 'rev-parse', 'refs/remotes/origin/main'), pushed.sha, 'the remote carries the recorded sha');
});

test('finding-4: a rebase conflict during the recovery stops with the surfaced reason and records nothing', () => {
  // Another host advances origin/main with a commit whose TREE collides with the local archive
  // commit (same path), so the recovery's rebase conflicts and stops with the surfaced reason —
  // the "terminal failure state with reason" requirement. The commit is seeded as a known
  // receipt sha so the audit passes and the failure is genuinely the rebase.
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const offeredHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  const foreign = path.join(fx.tmp, 'foreign-conflict');
  fs.mkdirSync(foreign, { recursive: true });
  git(foreign, 'clone', '-q', '-b', 'main', fx.bare, 'work');
  const foreignWork = path.join(foreign, 'work');
  git(foreignWork, 'config', 'user.email', 'f@f');
  git(foreignWork, 'config', 'user.name', 'f');
  git(foreignWork, 'config', 'commit.gpgsign', 'false');
  // Collide on the EXACT path the archive/gate commits change (the bundle state file), with
  // different content, so the rebase genuinely conflicts.
  write(foreignWork, 'docs/masterplan/t25/state.yml', 'foreign: changed\n');
  git(foreignWork, 'add', '.');
  git(foreignWork, 'commit', '-q', '-m', 'foreign change colliding with archive');
  git(foreignWork, 'push', '-q', 'origin', 'main');
  git(fx.MAIN, 'fetch', '-q', 'origin', 'main');
  const knownSha = git(fx.MAIN, 'rev-parse', 'refs/remotes/origin/main');
  const install = latest(fx, 'deploy_step');
  const evs = readEvents(fx.bundleDir);
  evs.push({ type: 'push_probe', ts: '2026-01-01T00:00:00.000Z', group: 'install', index: install.index, sha: install.sha, head_after: knownSha, base: 'main', status: 'confirmed_not_pushed' });
  writeEvents(fx.bundleDir, evs);

  assert.throws(() => fx.step({ archivePushed: { sha: offeredHead } }), /rebase failed/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'nothing recorded on a terminal recovery failure');
  // The run is still archived with the gate decision outstanding (the recovery threw before any
  // gate-clear or archive_pushed append).
  assert.equal(readState(fx.statePath).status, 'archived');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'push_archive', 'the push was not recorded and the gate stays open for re-entry');
});

test('finding-2: the real mp CLI accepts --archive-pushed --sha and records archive_pushed (wired through bin)', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  // Invoke the REAL binary; the lib-level owner lock is held by the fixture's self, so pass the
  // same session id and let the CLI's Guard-D heartbeat re-confirm it.
  const r = run(['finish-step', `--state=${fx.statePath}`, '--archive-pushed', `--sha=${head}`, '--session=sess-A', '--host=h1']);
  assert.equal(r.status, 0, `CLI --archive-pushed should succeed: ${r.stderr}`);
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed' && e.sha === head), 'the CLI path recorded archive_pushed');
});

test('finding-2: the real mp CLI accepts --archive-push-skipped with --reason (wired through bin)', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const r = run(['finish-step', `--state=${fx.statePath}`, '--archive-push-skipped', '--reason=no publish', '--session=sess-A', '--host=h1']);
  assert.equal(r.status, 0, `CLI --archive-push-skipped should succeed: ${r.stderr}`);
  const skip = readEvents(fx.bundleDir).find((e) => e.type === 'archive_push_skipped');
  assert.ok(skip && skip.reason === 'no publish', 'the CLI path recorded the decline with its reason');
});

test('finding-2: --archive-pushed without --sha exits 2 (parse-time refusal, never silently dropped)', () => {
  const fx = makeFixture({ done: INSTALL_ONLY, origin: true });
  assert.equal(walkInstallPush(fx).gate, 'push_archive');
  const r = run(['finish-step', `--state=${fx.statePath}`, '--archive-pushed', '--session=sess-A', '--host=h1']);
  assert.equal(r.status, 2, `missing --sha must exit 2, got ${r.status}`);
  assert.match(r.stderr, /--archive-pushed requires --sha/, r.stderr);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'archive_pushed'), 'nothing recorded');
});
