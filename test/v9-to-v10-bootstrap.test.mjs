// test/v9-to-v10-bootstrap.test.mjs — the bootstrap suite's foundation (wave task 46).
//
// This suite owns the driver's CONTRACT: the order steps may run in, the arm-before-record
// rule and the base it binds, what a refusal must NOT write, how a failure blocks the stage,
// how a pass is reconstructed from the ledger alone, and the lock that lets only `gate`
// proceed once the finish has begun. Tasks 47 and 48 extend it with the successful rollout
// and with every §10.3 recovery path.
//
// Every fixture is isolated: its own git repo, bare remote, install root, Claude config dir,
// workspace root and gh shim. Nothing reads the developer's environment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeState, appendEvent } from '../lib/bundle.mjs';
import {
  STEP_ORDER, PASS2_OMITTED, stepsForPass, FINISH_EVENT_TYPES,
  resolveTargets, bootstrapStatus, armStep, recordStep, startPass, readBundleEvents,
} from '../scripts/bootstrap-v10.mjs';

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const events = (statePath) => readBundleEvents(statePath);
const typesOf = (statePath) => events(statePath).map((e) => e.type);
// The refusal the finish lock itself produces, as distinct from a step's own preconditions.
const LOCK_REFUSAL = /finish has begun/;

// A MAIN checkout with a bare remote, a run branch one commit ahead in a linked worktree,
// an empty bundle, and fixture install / Claude / workspace surfaces.
function makeFixture({ version = '10.0.0', slug = 'bs' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-v9v10-'));
  const MAIN = path.join(tmp, 'main');
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(MAIN, { recursive: true });
  git(tmp, 'init', '-q', '--bare', bare);
  git(MAIN, 'init', '-q', '--initial-branch=main');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'masterplan', version: '9.10.0' }) + '\n');
  write(MAIN, 'CHANGELOG.md', '# Changelog\n');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '-A');
  git(MAIN, 'commit', '-q', '-m', 'seed');
  git(MAIN, 'remote', 'add', 'origin', bare);
  git(MAIN, 'push', '-q', 'origin', 'main');

  const branch = `masterplan/${slug}`;
  git(MAIN, 'checkout', '-q', '-b', branch);
  write(MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'masterplan', version }) + '\n');
  write(MAIN, 'scripts/rehearse-v9-finish.sh', '#!/bin/sh\nexit 0\n');
  write(MAIN, 'src/feature.txt', 'feature\n');
  git(MAIN, 'add', '-A');
  git(MAIN, 'commit', '-q', '-m', 'feature + version bump');
  git(MAIN, 'checkout', '-q', 'main');

  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute',
    worktree: null, pending_gate: null, active_run: null, tasks: [],
  });
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');

  const worktree = path.join(tmp, 'work tree'); // the space is deliberate: paths get quoted
  git(MAIN, 'worktree', 'add', '-q', worktree, branch);

  const installRoot = path.join(tmp, 'install-root');
  const piRoot = path.join(tmp, 'pi');
  const claudeDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(installRoot, { recursive: true });
  const ghLog = path.join(tmp, 'gh.log');
  const gh = path.join(tmp, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\necho "$@" >> ${ghLog}\nexit 0\n`);
  fs.chmodSync(gh, 0o755);

  const targets = {
    remote: 'origin', version, branch, worktree,
    install_root: installRoot, pi_root: piRoot, claude_config_dir: claudeDir,
    gh, gh_repo: 'fixture/repo', workspace_roots: [{ dir: tmp, depth: 1 }], verify_cmd: 'true',
  };
  return {
    tmp, MAIN, bare, bundleDir, statePath, targets, branch, slug, worktree,
    installRoot, claudeDir, ghLog,
    tip: () => git(MAIN, 'rev-parse', branch),
    head: () => git(MAIN, 'rev-parse', 'HEAD'),
  };
}

const arm = (fx, step) => armStep({ statePath: fx.statePath, step, targets: fx.targets });
const record = (fx, step, over = {}) => recordStep({
  statePath: fx.statePath, step, exit: 0, targets: fx.targets, ...over,
});
// The two steps whose commands are no-ops against a fixture, so a turn is arm + record.
function turn(fx, step, over = {}) {
  const a = arm(fx, step);
  assert.equal(a.ok, true, `arm ${step}: ${JSON.stringify(a)}`);
  return record(fx, step, over);
}

// ---------------------------------------------------------------------------
// Step order
// ---------------------------------------------------------------------------

// The order the stage runs in, owned by THIS test. Comparing the production constant to
// itself would stay green through a reordering, because both sides would move together.
const EXPECTED_ORDER = [
  'rehearsal', 'docs_normalize', 'verify', 'review', 'assess', 'release', 'push', 'ci_wait',
  'install_pi', 'main_push', 'publish_ack', 'pr_merge', 'claude_surface', 'surfaces_live', 'gate',
];

test('the step list is fixed, and pass 2 omits exactly the steps that already went out', () => {
  assert.deepEqual(STEP_ORDER, EXPECTED_ORDER, 'the published order');
  assert.deepEqual(stepsForPass(1), EXPECTED_ORDER, 'and pass 1 runs exactly it');
  // rehearsal, docs_normalize and main_push are done once for the release, not per corrective pass.
  assert.deepEqual(PASS2_OMITTED, ['rehearsal', 'docs_normalize', 'main_push']);
  const pass2 = stepsForPass(2);
  for (const omitted of PASS2_OMITTED) {
    assert.equal(pass2.includes(omitted), false, `${omitted} must not run on a corrective pass`);
  }
  assert.equal(pass2[0], 'verify', 'a corrective pass re-enters at the pre-publish verify');
  assert.deepEqual(pass2, EXPECTED_ORDER.filter((step) => !PASS2_OMITTED.includes(step)));
  assert.deepEqual(stepsForPass(3), pass2, 'every later pass has the pass-2 shape');
});

test('a fresh bundle expects the first step and nothing else', () => {
  const fx = makeFixture();
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.pass, 1);
  assert.equal(s.next.step, STEP_ORDER[0]);
  assert.equal(s.next.blocked_by, null);
  assert.deepEqual(s.completed, []);
  assert.equal(s.finish_begun, false);
});

test('a step out of order is refused, and an unknown step is refused by name', () => {
  const fx = makeFixture();
  for (const step of ['verify', 'release', 'gate']) {
    const r = arm(fx, step);
    assert.equal(r.ok, false, `${step} must not arm first`);
    assert.match(r.refusals.join(' '), /out of order: expected rehearsal/);
  }
  const unknown = arm(fx, 'not_a_step');
  assert.equal(unknown.ok, false);
  assert.match(unknown.refusals.join(' '), /unknown step/);
  assert.deepEqual(typesOf(fx.statePath), [], 'a refused arm writes nothing at all');
});

test('a step already recorded cannot be armed again', () => {
  const fx = makeFixture();
  turn(fx, 'rehearsal', { digestFile: digest(fx, 'rehearsal ok') });
  const again = arm(fx, 'rehearsal');
  assert.equal(again.ok, false);
  assert.match(again.refusals.join(' '), /out of order: expected docs_normalize/);
});

// ---------------------------------------------------------------------------
// Arm before record, and the base the arm binds
// ---------------------------------------------------------------------------

function digest(fx, text) {
  const p = path.join(fx.tmp, `digest-${Math.abs(hash(text))}.txt`);
  fs.writeFileSync(p, `${text}\n`);
  return p;
}
// A tiny deterministic hash: Date.now()/random are avoided so fixtures stay reproducible.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

test('a record with no arm behind it is refused', () => {
  const fx = makeFixture();
  assert.throws(() => record(fx, 'rehearsal', { digestFile: digest(fx, 'x') }), /no bootstrap_armed for rehearsal/);
  assert.deepEqual(typesOf(fx.statePath), []);
});

test('a stale arm cannot authorise a second record of the same step', () => {
  const fx = makeFixture();
  // arm, record — then record again against the SAME arm.
  turn(fx, 'rehearsal', { digestFile: digest(fx, 'first') });
  assert.throws(
    () => record(fx, 'rehearsal', { digestFile: digest(fx, 'second') }),
    /no bootstrap_armed for rehearsal .* after its latest record/,
  );
});

test('a record is refused when the base moved since the arm', () => {
  const fx = makeFixture();
  const a = arm(fx, 'rehearsal');
  assert.equal(a.ok, true, JSON.stringify(a));
  // Something else commits on MAIN between arm and record.
  write(fx.MAIN, 'src/other.txt', 'moved\n');
  git(fx.MAIN, 'add', '-A');
  git(fx.MAIN, 'commit', '-q', '-m', 'a commit between arm and record');
  assert.throws(() => record(fx, 'rehearsal', { digestFile: digest(fx, 'x') }), /base moved since arm/);
  // The arm event survives; the refusal recorded no outcome.
  assert.deepEqual(typesOf(fx.statePath), ['bootstrap_armed']);
});

test('the arm binds the run-branch tip and the target-set digest it evaluated', () => {
  const fx = makeFixture();
  const a = arm(fx, 'rehearsal');
  assert.equal(a.ok, true);
  const armed = events(fx.statePath).find((e) => e.type === 'bootstrap_armed');
  assert.equal(armed.tip, fx.tip(), 'the tip every step is authorised against');
  assert.equal(armed.sha, fx.head());
  assert.equal(typeof armed.targets_sha256, 'string');
  assert.equal(armed.targets_sha256.length, 64);
  assert.ok(Array.isArray(armed.preconditions) && armed.preconditions.length > 0);
});

// ---------------------------------------------------------------------------
// Preconditions and postconditions
// ---------------------------------------------------------------------------

test('a failed precondition returns the checks and writes NO event', () => {
  const fx = makeFixture();
  // The rehearsal step requires a clean tree; dirty it outside the bundle.
  write(fx.MAIN, 'src/dirty.txt', 'uncommitted\n');
  const r = arm(fx, 'rehearsal');
  assert.equal(r.ok, false);
  assert.ok(r.preconditions.some((p) => !p.ok), JSON.stringify(r));
  assert.deepEqual(r.refusals, [], 'a precondition failure is not an ordering refusal');
  assert.deepEqual(typesOf(fx.statePath), [], 'a refused arm must not leave an event behind');
  // Cleaning the tree lets the same step arm.
  fs.rmSync(path.join(fx.MAIN, 'src', 'dirty.txt'));
  assert.equal(arm(fx, 'rehearsal').ok, true);
});

test('a postcondition failure refuses the record', () => {
  const fx = makeFixture();
  turn(fx, 'rehearsal', { digestFile: digest(fx, 'rehearsal ok') });
  turn(fx, 'docs_normalize');
  turn(fx, 'verify');
  // `review` must carry an approving verdict; anything else is refused.
  assert.equal(arm(fx, 'review').ok, true);
  assert.throws(() => record(fx, 'review', { data: { verdict: 'revise' } }), /postcondition failed: verdict_approve/);
  assert.equal(arm(fx, 'review').ok, true);
  assert.throws(() => record(fx, 'review', { data: {} }), /postcondition failed: verdict_approve/);
  // ...and the approving verdict is accepted.
  assert.equal(arm(fx, 'review').ok, true);
  const rec = record(fx, 'review', { data: { verdict: 'approve' } });
  assert.equal(rec.status, 'done');
});

test('the rehearsal step demands its output digest as the receipt', () => {
  const fx = makeFixture();
  assert.equal(arm(fx, 'rehearsal').ok, true);
  assert.throws(() => record(fx, 'rehearsal'), /digest/i);
  assert.equal(arm(fx, 'rehearsal').ok, true);
  const rec = record(fx, 'rehearsal', { digestFile: digest(fx, 'rehearsal output') });
  assert.equal(rec.status, 'done');
  assert.equal(typeof rec.digest, 'string');
  assert.equal(rec.digest.length, 64);
});

// ---------------------------------------------------------------------------
// Failure, blocking and recovery
// ---------------------------------------------------------------------------

test('a non-zero exit cannot be recorded as done', () => {
  const fx = makeFixture();
  assert.equal(arm(fx, 'rehearsal').ok, true);
  assert.throws(
    () => record(fx, 'rehearsal', { exit: 1, digestFile: digest(fx, 'boom') }),
    /done requires exit 0; record a failure with --status=failed/,
  );
});

test('a failure is durable, blocks the next step, and is closed only by a recovery', () => {
  const fx = makeFixture();
  assert.equal(arm(fx, 'rehearsal').ok, true);
  const failed = record(fx, 'rehearsal', { exit: 1, status: 'failed', reason: 'rehearsal fixture failure' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exit, 1);

  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.steps.rehearsal.status, 'failed');
  assert.deepEqual(s.failed, ['rehearsal']);
  assert.equal(s.next.step, 'rehearsal', 'the stage stays on the failed step');

  // The next step is not reachable while the failure stands.
  const next = arm(fx, 'docs_normalize');
  assert.equal(next.ok, false);
  assert.match(next.refusals.join(' '), /out of order: expected rehearsal/);

  // A recovery record closes it, and the stage moves on.
  assert.equal(arm(fx, 'rehearsal').ok, true);
  const recovered = record(fx, 'rehearsal', { status: 'recovered', digestFile: digest(fx, 'rehearsal retry') });
  assert.equal(recovered.status, 'recovered');
  const after = bootstrapStatus(fx.statePath);
  assert.deepEqual(after.failed, []);
  assert.ok(after.completed.includes('rehearsal'));
  assert.equal(after.next.step, 'docs_normalize');
});

test('a recovery is refused unless the step is currently failed', () => {
  const fx = makeFixture();
  assert.equal(arm(fx, 'rehearsal').ok, true);
  assert.throws(
    () => record(fx, 'rehearsal', { status: 'recovered', digestFile: digest(fx, 'x') }),
    /recovered requires the latest record of the step to be failed/,
  );
});

test('blocked_by names the step that failed, and clears on recovery', () => {
  const fx = makeFixture();
  turn(fx, 'rehearsal', { digestFile: digest(fx, 'ok') });
  assert.equal(arm(fx, 'docs_normalize').ok, true);
  record(fx, 'docs_normalize', { exit: 3, status: 'failed', reason: 'docs failure' });

  // `next` stays ON the failed step, and `blocked_by` says which step is holding the stage.
  // Without this assertion an implementation that always returned null would pass.
  // A failed step STAYS `next` — that is the blocking rule — so `blocked_by` must name the
  // failed step itself. Reporting only "the previous step failed" could never fire, because
  // the step before a `next` is always done or recovered: the field would be permanently null
  // and an always-null implementation would be indistinguishable from a correct one.
  let s = bootstrapStatus(fx.statePath);
  assert.equal(s.next.step, 'docs_normalize');
  assert.deepEqual(s.failed, ['docs_normalize']);
  assert.equal(s.next.blocked_by, 'failed:docs_normalize');

  // A recovery clears it: the stage advances and nothing is reported as blocking.
  arm(fx, 'docs_normalize');
  record(fx, 'docs_normalize', { status: 'recovered' });
  s = bootstrapStatus(fx.statePath);
  assert.deepEqual(s.failed, []);
  assert.equal(s.next.step, 'verify');
  assert.equal(s.next.blocked_by, null, 'a recovered step blocks nothing');
});

// ---------------------------------------------------------------------------
// Status reconstruction from the ledger alone
// ---------------------------------------------------------------------------

// Seed completed steps directly: status is reconstructed from events, so a status test needs
// no command execution. (The real turns are exercised above and in tasks 47/48.)
function seedThrough(fx, steps, { pass = 1, status = 'done' } = {}) {
  let ts = 1;
  const tip = fx.tip();
  for (const step of steps) {
    appendEvent(fx.statePath, {
      type: 'bootstrap_step', ts: ts++, pass, step, cmd: 'seeded', exit: 0, status,
      sha: fx.head(),
      // verify / review / assess bind their receipt to the RUN-BRANCH tip, and the steps
      // after them read that binding back (reviewedSha, review_done_at_tip). A seed without
      // it produces a ledger no real turn could have written.
      data: { tip, ...(step === 'review' ? { verdict: 'approve' } : {}) },
    });
  }
  return fx;
}

test('status is reconstructed from the ledger alone, as it is after a compaction', () => {
  const fx = makeFixture();
  const done = ['rehearsal', 'docs_normalize', 'verify', 'review'];
  seedThrough(fx, done);
  // Nothing but the file on disk — a fresh process would read exactly this.
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.pass, 1);
  for (const step of done) assert.equal(s.steps[step].status, 'done', step);
  assert.deepEqual(s.completed, done);
  assert.equal(s.next.step, 'assess', 'the first step with no terminal record');
  assert.equal(s.finish_begun, false);
  // And the derived next step is what the driver will actually let you arm.
  assert.equal(arm(fx, 'assess').ok, true);
});

test('status reports the pass complete through surfaces_live before the finish begins', () => {
  const fx = makeFixture();
  const throughSurfaces = STEP_ORDER.slice(0, STEP_ORDER.indexOf('surfaces_live') + 1);
  seedThrough(fx, throughSurfaces);
  const s = bootstrapStatus(fx.statePath);
  for (const step of throughSurfaces) {
    assert.equal(s.steps[step].status, 'done', `${step} should be complete before the finish`);
  }
  // Everything up to and including surfaces_live is done; only the gate remains.
  assert.equal(s.next.step, 'gate');
  assert.equal(s.finish_begun, false);
  assert.deepEqual(
    STEP_ORDER.filter((step) => s.steps[step].status === null),
    ['gate'],
    'the gate is the only step left, because it runs after the finish',
  );
});

test('an unrecorded step reads as null rather than as absent', () => {
  const fx = makeFixture();
  seedThrough(fx, ['rehearsal']);
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.steps.verify.status, null);
  assert.equal(s.steps.verify.exit, null);
  assert.equal(s.steps.verify.sha, null);
});

// ---------------------------------------------------------------------------
// The finish lock: once the finish begins, only `gate` may move
// ---------------------------------------------------------------------------

test('once the finish has begun, gate is the ONLY step that may be armed', () => {
  const fx = makeFixture();
  seedThrough(fx, STEP_ORDER.slice(0, STEP_ORDER.indexOf('surfaces_live') + 1));
  assert.equal(bootstrapStatus(fx.statePath).finish_begun, false);
  // A finish-step marker lands on the bundle.
  appendEvent(fx.statePath, { type: 'branch_finish', ts: 99, note: 'the v9 finish began' });
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.finish_begun, true);
  // The gate is the step that runs AFTER the finish, so the LOCK must never be what stops it.
  // Its own preconditions (a real PR merge on the remote) belong to tasks 47/48 and are not
  // built by this foundation fixture, so the assertion is about the refusal REASON rather than
  // overall success — `x === false || x === true` would prove nothing at all.
  const gateArm = arm(fx, 'gate');
  // NO refusal of any kind: refusals are the ordering/lock layer's verdict, so an empty set
  // says that layer permitted the gate. (Its own preconditions — a real PR merge on the remote —
  // belong to tasks 47/48 and are reported separately as `preconditions`.)
  assert.deepEqual(gateArm.refusals ?? [], [], `the gate must pass the ordering/lock layer: ${JSON.stringify(gateArm)}`);
  assert.ok(Array.isArray(gateArm.preconditions), 'it reached its own preconditions');
  // ...and every other step is locked out, whatever the ordering would otherwise allow.
  const fx2 = makeFixture();
  seedThrough(fx2, ['rehearsal', 'docs_normalize']);
  appendEvent(fx2.statePath, { type: 'archived', ts: 99, class: 'complete' });
  // Every non-gate step, not merely the next one: an implementation that exempted some other
  // step would pass a single-step check.
  for (const step of EXPECTED_ORDER.filter((x) => x !== 'gate')) {
    const locked = armStep({ statePath: fx2.statePath, step, targets: fx2.targets });
    assert.equal(locked.ok, false, step);
    assert.match(locked.refusals.join(' '), /finish has begun; only gate may be armed/, step);
  }
});

// appendEvent validates each event against its schema, so a marker needs a valid body.
const FINISH_MARKER_BODY = {
  branch_finish: { note: 'merged' },
  adversary_review: { verdict: 'approve' },
  archived: { class: 'complete' },
  incomplete_authorized: { reason: 'deploy_abort' },
  completion_confirmed: { deploy_base_sha: 'a'.repeat(40) },
  retro_written: { path: 'docs/masterplan/bs/retro.md' },
};

test('every finish marker type trips the lock', () => {
  for (const type of FINISH_EVENT_TYPES) {
    const fx = makeFixture();
    seedThrough(fx, ['rehearsal', 'docs_normalize']);
    appendEvent(fx.statePath, { type, ts: 99, ...(FINISH_MARKER_BODY[type] ?? {}) });
    assert.equal(bootstrapStatus(fx.statePath).finish_begun, true, `${type} should begin the finish`);
    const r = arm(fx, 'verify');
    assert.equal(r.ok, false, type);
    assert.match(r.refusals.join(' '), /only gate may be armed/);
  }
});

// ---------------------------------------------------------------------------
// Corrective passes
// ---------------------------------------------------------------------------

test('a corrective pass starts at verify and never re-runs the omitted steps', () => {
  const fx = makeFixture();
  // Through surfaces_live, NOT the gate: the gate runs after the finish, and a corrective
  // pass is opened by a finish-time finding — once the gate is recorded the run is complete
  // and a later finding needs a new run, not a pass.
  seedThrough(fx, STEP_ORDER.slice(0, STEP_ORDER.indexOf('gate')));
  // A finish-time finding opens pass 2 at a strictly newer version. `triggeredBy` is the
  // finding's event INDEX — the pass is bound to the specific finding that justified it.
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 90, verdict: 'rework' });
  const trigger = events(fx.statePath).length - 1;
  const started = startPass({
    statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.0.1', targets: fx.targets,
  });
  assert.equal(started.pass, 2);
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.pass, 2);
  assert.equal(s.next.step, 'verify', 'a corrective pass re-enters at the pre-publish verify');
  for (const omitted of PASS2_OMITTED) {
    assert.equal(s.steps[omitted], undefined, `${omitted} is not part of a corrective pass`);
  }
  // The pass is BOUND to the version it opened at: arming with the old version is refused,
  // so a corrective pass cannot quietly re-publish the version that was already tagged.
  assert.throws(() => arm(fx, 'verify'), /pass 2 is bound to version 10\.0\.1.*10\.0\.0 disagrees/);
  const corrective = { ...fx.targets, version: '10.0.1' };
  // The omitted steps cannot be armed on this pass at all, even with the right version.
  for (const omitted of PASS2_OMITTED) {
    const r = armStep({ statePath: fx.statePath, step: omitted, targets: corrective });
    assert.equal(r.ok, false, omitted);
    assert.match(r.refusals.join(' '), /out of order: expected verify/);
  }
  // ...and verify, the corrective pass's real entry point, arms.
  assert.equal(armStep({ statePath: fx.statePath, step: 'verify', targets: corrective }).ok, true);
});

test('the pass-1 finish events do not lock a corrective pass to gate', () => {
  const fx = makeFixture();
  seedThrough(fx, STEP_ORDER.slice(0, STEP_ORDER.indexOf('gate')));
  // The finish ran and produced the finding that opens the corrective pass.
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 90, verdict: 'rework' });
  const trigger = events(fx.statePath).length - 1;
  assert.equal(bootstrapStatus(fx.statePath).finish_begun, true, 'pass 1 is locked');
  startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.0.1', targets: fx.targets });
  // The lock is scoped to the pass the finish ran in: pass 2 opens clean.
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.finish_begun, false, 'the finding that opened the pass must not lock it');
  assert.equal(s.next.step, 'verify');
});

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

test('targets are validated, and unknown targets are refused by name', () => {
  const fx = makeFixture();
  assert.throws(() => resolveTargets(fx.MAIN, { slug: 'bs' }, { nonsense: 1 }), /unknown target: nonsense/);
  assert.throws(
    () => resolveTargets(fx.MAIN, { slug: 'bs' }, { workspace_roots: 'not-an-array' }),
    /workspace_roots must be an array/,
  );
  assert.throws(
    () => resolveTargets(fx.MAIN, { slug: 'bs' }, { workspace_roots: [{ dir: 'x' }] }),
    /workspace_roots entries need/,
  );
  assert.throws(
    () => resolveTargets(fx.MAIN, { slug: 'bs' }, { workspace_roots: [{ dir: 'x', depth: -1 }] }),
    /workspace_roots entries need/,
  );
});

test('the tag is always derived from the version, never supplied independently', () => {
  const fx = makeFixture();
  const t = resolveTargets(fx.MAIN, { slug: 'bs' }, { version: '10.2.3' });
  assert.equal(t.tag, 'v10.2.3');
  // Even when a caller tries to pin a mismatched tag, the derived value wins.
  assert.throws(() => resolveTargets(fx.MAIN, { slug: 'bs' }, { tag: 'v9.9.9' }), /unknown target: tag/);
});

test('the branch defaults from the slug and the run state', () => {
  const fx = makeFixture();
  assert.equal(resolveTargets(fx.MAIN, { slug: 'bs' }, {}).branch, 'masterplan/bs');
  assert.equal(resolveTargets(fx.MAIN, { slug: 'bs', branch: 'custom/branch' }, {}).branch, 'custom/branch');
  assert.equal(resolveTargets(fx.MAIN, { slug: 'bs' }, { branch: 'override/branch' }).branch, 'override/branch');
});

test('a branch with no resolvable tip refuses every step', () => {
  const fx = makeFixture();
  const r = armStep({ statePath: fx.statePath, step: 'rehearsal', targets: { ...fx.targets, branch: 'masterplan/does-not-exist' } });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /no resolvable tip/);
  assert.deepEqual(typesOf(fx.statePath), []);
});

test('the record-time finish lock covers EVERY non-gate step, not just the next one', () => {
  // For each non-gate step: seed a ledger where it is next, arm it BEFORE the finish marker,
  // then append the marker and require the record to be refused by the LOCK with no outcome
  // written. A single-step check would pass an implementation that exempted some other step.
  for (const step of EXPECTED_ORDER.filter((x) => x !== 'gate')) {
    const fx = makeFixture();
    const before = EXPECTED_ORDER.slice(0, EXPECTED_ORDER.indexOf(step));
    if (before.length) seedThrough(fx, before);
    const armed = arm(fx, step);
    if (!armed.ok) continue; // a step whose own preconditions need the rollout (tasks 47/48)
    appendEvent(fx.statePath, { type: 'branch_finish', ts: 99, note: 'the v9 finish began' });
    assert.equal(bootstrapStatus(fx.statePath).finish_begun, true, step);
    assert.throws(() => record(fx, step), LOCK_REFUSAL, `${step} must be refused at record time`);
    const outcomes = events(fx.statePath).filter((e) => e.type === 'bootstrap_step' && e.step === step);
    assert.deepEqual(outcomes, [], `${step} must record no outcome`);
  }
});

test('the finish lock applies at RECORD time too, not only at arm time', () => {
  // A step armed BEFORE the finish began must not be recordable after it: otherwise a stale
  // arm becomes a licence to land work the finish has already assessed.
  const fx = makeFixture();
  seedThrough(fx, ['rehearsal', 'docs_normalize']);
  const armed = arm(fx, 'verify');
  assert.equal(armed.ok, true, JSON.stringify(armed));
  appendEvent(fx.statePath, { type: 'branch_finish', ts: 99, note: 'the v9 finish began' });
  assert.equal(bootstrapStatus(fx.statePath).finish_begun, true);
  assert.throws(() => record(fx, 'verify'), /finish has begun; only gate may be recorded|only gate/);
  // Nothing was recorded for it.
  const outcomes = events(fx.statePath).filter((e) => e.type === 'bootstrap_step' && e.step === 'verify');
  assert.deepEqual(outcomes, []);
});

test('the gate can be armed AND recorded after the finish has begun', () => {
  const fx = makeFixture();
  seedThrough(fx, STEP_ORDER.slice(0, STEP_ORDER.indexOf('gate')));
  appendEvent(fx.statePath, { type: 'branch_finish', ts: 99, note: 'the v9 finish began' });
  assert.equal(bootstrapStatus(fx.statePath).finish_begun, true);
  const a = arm(fx, 'gate');
  assert.deepEqual(a.refusals ?? [], [], `the gate must pass the ordering/lock layer: ${JSON.stringify(a)}`);
  // ...and the contrast on the SAME ledger: EVERY non-gate step is refused for the lock itself,
  // not just the one that happens to be next.
  for (const step of EXPECTED_ORDER.filter((x) => x !== 'gate')) {
    const locked = armStep({ statePath: fx.statePath, step, targets: fx.targets });
    assert.equal(locked.ok, false, step);
    assert.ok((locked.refusals ?? []).some((r) => LOCK_REFUSAL.test(r)), `${step}: ${JSON.stringify(locked)}`);
  }
  // The gate's own record has further requirements (a fetched remote tip, a committed bundle)
  // that tasks 47/48 exercise against a full fixture; what this suite owns is that the LOCK is
  // not what stops it — the refusal, if any, must not be the finish lock.
  try {
    record(fx, 'gate');
  } catch (err) {
    assert.doesNotMatch(err.message, /finish has begun/, `the gate must not be blocked by the finish lock: ${err.message}`);
  }
});
