// Event-keyed deploy recovery (§7.2). Every case here is a REAL-WRITER replay: each
// `fx.step(...)` is a separate finishStep invocation that reads and appends to the same
// on-disk events.jsonl, so a "crash" is modelled by simply not making the next call —
// exactly the state a killed process leaves behind. Nothing is stubbed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
// block supplied by the caller so each case picks its own step shapes.
function makeFixture({ slug = 't25', done, autonomy = 'loose' } = {}) {
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
  return { tmp, MAIN, WT, bundleDir, statePath, self, step, slug };
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
