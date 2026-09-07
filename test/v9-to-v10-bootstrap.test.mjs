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
import { writeState, appendEvent, readState, setStatus, loadBundleEvents } from '../lib/bundle.mjs';
import { parseEventArray } from '../lib/finish-step.mjs';
import { doneDigest } from '../lib/config.mjs';
import { check as requiredSuccessorCheck } from '../lib/doctor/required-successor.mjs';
import { check as incompleteArchiveCheck } from '../lib/doctor/incomplete-archive.mjs';
import { check as legacyArchiveCheck } from '../lib/doctor/legacy-archive.mjs';
import {
  STEP_ORDER, PASS2_OMITTED, stepsForPass, FINISH_EVENT_TYPES,
  resolveTargets, bootstrapStatus, armStep, recordStep, startPass, readBundleEvents,
  scanWorkspaceBundles, piSurfaceVersion, claudeSurfacePath,
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

const arm = (fx, step, over = {}) => armStep({ statePath: fx.statePath, step, targets: fx.targets, ...over });
const armOk = (fx, step, over = {}) => {
  const a = arm(fx, step, over);
  assert.equal(a.ok, true, `arm ${step}: ${JSON.stringify(a)}`);
  return a;
};
// Arm then record a successful turn (the mirror of walkRollout's internal recordOk).
const walkOk = (fx, step, data = {}, { digestFile = null } = {}) => {
  armOk(fx, step);
  const r = record(fx, step, { data, ...(digestFile ? { digestFile } : {}) });
  assert.equal(r.status, 'done', `${step}: ${JSON.stringify(r)}`);
  return r;
};
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

// ===========================================================================
// The complete fixture-backed successful rollout (wave task 47)
//
// Every step of the walk, in the driver's own order, against REAL effects: a real release
// commit and annotated tag, real pushes to a bare remote, a real installed Pi surface, a real
// server-side merge by a second clone, a real bundle commit and rebase at the gate. The
// driver's own preconditions and postconditions are the assertions — a step passes only
// because the fixture actually produced what that step requires.
// ===========================================================================

// A rollout fixture: MAIN with a bare remote, a run branch in a linked worktree, a second
// clone standing in for the server-side merge, and the install/Claude/workspace surfaces.
function makeRolloutFixture({ version = '10.0.0', slug = 'ro' } = {}) {
  const fx = makeFixture({ version, slug });
  // The Claude cache and the install root live under the fixture's own tmp.
  const second = path.join(fx.tmp, 'second');
  git(fx.tmp, 'clone', '-q', fx.bare, second);
  git(second, 'config', 'user.email', 'second@example.invalid');
  git(second, 'config', 'user.name', 'second');
  git(second, 'config', 'commit.gpgsign', 'false');
  // MAIN starts AHEAD of the remote by a non-bundle commit (§10.1.5): the real local main is
  // ahead of GitHub by unrelated work, and that commit must be CARRIED, not lost.
  write(fx.MAIN, 'src/unrelated.txt', 'work that predates the bootstrap\n');
  git(fx.MAIN, 'add', 'src/unrelated.txt');
  git(fx.MAIN, 'commit', '-q', '-m', 'a non-bundle commit ahead of the remote');
  const mainPreBootstrap = git(fx.MAIN, 'rev-parse', 'main');
  // Nested workspace roots at two depths, so workspace discovery has something to find.
  for (const rel of ['sibling-a', 'nested/sibling-b']) {
    const dir = path.join(fx.tmp, rel);
    fs.mkdirSync(path.join(dir, 'docs', 'masterplan', 'other'), { recursive: true });
    git(fx.tmp, 'init', '-q', dir);
    fs.writeFileSync(path.join(dir, 'docs', 'masterplan', 'other', 'state.yml'),
      'schema_version: 8\nslug: other\nstatus: in-progress\nphase: execute\ntasks: []\n');
    fs.writeFileSync(path.join(dir, 'docs', 'masterplan', 'other', 'events.jsonl'), '');
  }
  return { ...fx, second, mainPreBootstrap };
}

// Install the Pi surface the way the step's postcondition reads it: `current` resolves to a
// tree whose plugin.json names the version, and the receipt names the commit that was
// published. (bin/install-pi.mjs's own behaviour is test/install-pi.test.mjs's subject; this
// suite is about the DRIVER's checks.)
// A surface's entry point: a real Node program that prints its version, because the step's
// postcondition RUNS it. A stub that only exists would prove nothing about the install.
const ENTRY_SOURCE = (version) => `#!/usr/bin/env node\nconsole.log('masterplan ${version}');\n`;
// ...and one that starts and dies, for the negative cases.
const BROKEN_ENTRY = `#!/usr/bin/env node\nimport 'node:definitely-not-a-real-module';\n`;

function installPiSurface(fx, { version, sha, entrySource = ENTRY_SOURCE(version), omitEntry = false }) {
  const release = path.join(fx.installRoot, 'releases', sha);
  fs.mkdirSync(path.join(release, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(release, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'masterplan', version })}\n`);
  if (!omitEntry) {
    fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(release, 'bin', 'masterplan.mjs'), entrySource);
  }
  const current = path.join(fx.installRoot, 'current');
  fs.rmSync(current, { recursive: true, force: true });
  fs.symlinkSync(release, current);
  fs.writeFileSync(path.join(fx.installRoot, '.pi-install.json'),
    `${JSON.stringify({ version, sha, ref: `v${version}`, installed_at: '2026-01-01T00:00:00Z' })}\n`);
}

// The Claude cache the step's postcondition looks for: the plugin's entry point under the
// released version — again a real program, since the postcondition runs it.
function installClaudeSurface(fx, { version, entrySource = ENTRY_SOURCE(version), omitEntry = false }) {
  const entry = claudeSurfacePath(fx.claudeDir, version);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  if (!omitEntry) fs.writeFileSync(entry, entrySource);
  return entry;
}
// A fixture whose claude_surface step must still RECORD while surfaces_live must not: the
// step's own postcondition wants the file present, so an "absent Claude surface" case removes
// it after that step has passed.
function removeClaudeSurface(fx, version) {
  fs.rmSync(claudeSurfacePath(fx.claudeDir, version), { force: true });
}

// One full pass, step by step, with the real effect each step's contract requires. Returns the
// per-step records so the assertions can read what actually landed.
function walkRollout(fx, { version = '10.0.0', mainPushData = null, surfaces = null } = {}) {
  const records = {};
  const armOk = (step) => {
    const a = arm(fx, step);
    assert.equal(a.ok, true, `arm ${step}: ${JSON.stringify(a)}`);
    return a;
  };
  const recordOk = (step, over = {}) => {
    const r = record(fx, step, over);
    records[step] = r;
    return r;
  };

  // 1. The rehearsal's output digest IS its receipt.
  armOk('rehearsal');
  const digestPath = path.join(fx.tmp, 'rehearsal-digest.txt');
  fs.writeFileSync(digestPath, 'REHEARSAL PASS\n');
  recordOk('rehearsal', { digestFile: digestPath });

  armOk('docs_normalize');
  recordOk('docs_normalize');

  // 2. Pre-publish verify / review / assessment, each bound to the branch tip they judged.
  const tip = fx.tip();
  armOk('verify');
  recordOk('verify', { data: { tip } });
  armOk('review');
  recordOk('review', { data: { tip, verdict: 'approve' } });
  armOk('assess');
  recordOk('assess', { data: { tip, goals: { G1: 'achieved', G2: 'achieved' } } });

  // 3. The release: armed at the reviewed tip, then ONE CHANGELOG commit and an annotated tag.
  armOk('release');
  write(fx.worktree, 'CHANGELOG.md', `# Changelog\n\n## ${version}\n`);
  git(fx.worktree, 'add', 'CHANGELOG.md');
  git(fx.worktree, 'commit', '-q', '-m', `release: ${version}`);
  const releaseTip = git(fx.worktree, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'tag', '-a', `v${version}`, '-m', `release ${version}`, releaseTip);
  recordOk('release');

  // 4. The push: branch and tag really go to the remote, between arm and record.
  armOk('push');
  git(fx.MAIN, 'push', '-q', fx.targets.remote, fx.branch, `refs/tags/v${version}`);
  recordOk('push');

  // 5. Tag CI, both jobs green.
  armOk('ci_wait');
  recordOk('ci_wait', { data: { conclusions: { test: 'success', 'release-publish': 'success' } } });

  // 6. The Pi surface is really installed at the PUBLISHED tip.
  const published = records.push?.data?.published_tip ?? releaseTip;
  armOk('install_pi');
  installPiSurface(fx, { version, sha: published, ...(surfaces?.pi ?? {}) });
  recordOk('install_pi');

  // 7. Local main is pushed, carrying the non-bundle commit it was ahead by.
  const mainArm = armOk('main_push');
  git(fx.MAIN, 'push', '-q', fx.targets.remote, 'main');
  recordOk('main_push', mainPushData ? { data: mainPushData } : {});

  armOk('publish_ack');
  recordOk('publish_ack', { data: { answer: 'proceed' } });

  // 8. The server-side merge, performed by the second clone and pushed.
  armOk('pr_merge');
  git(fx.second, 'fetch', '-q', 'origin');
  git(fx.second, 'checkout', '-q', 'main');
  git(fx.second, 'reset', '-q', '--hard', 'origin/main');
  try { git(fx.second, 'fetch', '-q', 'origin', `${fx.branch}:${fx.branch}`); }
  catch { git(fx.second, 'fetch', '-q', 'origin', fx.branch); }
  git(fx.second, 'merge', '-q', '--no-ff', '--no-edit', fx.branch);
  git(fx.second, 'push', '-q', 'origin', 'main');
  const mergeSha = git(fx.second, 'rev-parse', 'HEAD');
  recordOk('pr_merge', { data: { merge_sha: mergeSha } });

  // 9. Both surfaces live. `surfaces` lets a caller install DIFFERENT surfaces here and stop
  // before surfaces_live, so a negative case reaches that step with every earlier receipt real
  // — seeding the earlier steps instead leaves tip_is_published failing, and the step never
  // arms at all, which is how a negative test passes without testing anything.
  armOk('claude_surface');
  installClaudeSurface(fx, { version, ...(surfaces?.claude ?? {}) });
  recordOk('claude_surface');
  if (surfaces !== null) return { records, tip, releaseTip, published, mergeSha, mainArm, stoppedBeforeSurfacesLive: true };
  armOk('surfaces_live');
  recordOk('surfaces_live');

  return { records, tip, releaseTip, published, mergeSha, mainArm };
}

test('the whole rollout walks every step in order with real effects', () => {
  const fx = makeRolloutFixture();
  const { records, releaseTip, mergeSha } = walkRollout(fx);
  for (const step of EXPECTED_ORDER.filter((s) => s !== 'gate')) {
    assert.equal(records[step]?.status, 'done', `${step}: ${JSON.stringify(records[step])}`);
  }
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.next.step, 'gate', 'only the gate remains');
  assert.equal(s.failed.length, 0);
  // The published tip is the release commit, and the merge carries it.
  assert.equal(records.push.data.published_tip, releaseTip);
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', releaseTip, mergeSha),
    'the merge carries the released tip');
});

test('the release refuses before the version is bumped, and its tag identity is exact', () => {
  // Walk to the release with a version the branch tip does NOT name: the version AT THE TIP is
  // what may be released, so a release for anything else is refused before it can tag.
  const fx2 = makeRolloutFixture({ slug: 'ro-bump' });
  const t = fx2.tip();
  const armAnd = (step, over = {}) => { assert.equal(arm(fx2, step).ok, true, step); return record(fx2, step, over); };
  const dp = path.join(fx2.tmp, 'd.txt'); fs.writeFileSync(dp, 'x\n');
  armAnd('rehearsal', { digestFile: dp });
  armAnd('docs_normalize');
  armAnd('verify', { data: { tip: t } });
  armAnd('review', { data: { tip: t, verdict: 'approve' } });
  armAnd('assess', { data: { tip: t, goals: { G1: 'achieved' } } });
  // The tip names 10.0.0; arming a release for 10.5.0 is refused on version_matches.
  const mismatched = armStep({ statePath: fx2.statePath, step: 'release', targets: { ...fx2.targets, version: '10.5.0' } });
  assert.equal(mismatched.ok, false);
  assert.ok(
    (mismatched.preconditions ?? []).some((p) => p.name === 'version_matches' && !p.ok),
    JSON.stringify(mismatched),
  );
});

test('the release commit is CHANGELOG-only and exactly one commit past the reviewed sha', () => {
  const fx = makeRolloutFixture({ slug: 'ro-changelog' });
  const { records, tip, releaseTip } = walkRollout(fx);
  assert.equal(records.release.status, 'done');
  // Exactly one commit past the reviewed sha...
  assert.equal(git(fx.MAIN, 'rev-list', '--count', `${tip}..${releaseTip}`), '1');
  // ...and it touches CHANGELOG.md alone.
  const touched = git(fx.MAIN, 'show', '--pretty=format:', '--name-only', releaseTip).split('\n').filter(Boolean);
  assert.deepEqual(touched, ['CHANGELOG.md']);
  // The tag is annotated and peels to that commit.
  const tagType = git(fx.MAIN, 'cat-file', '-t', 'refs/tags/v10.0.0');
  assert.equal(tagType, 'tag', 'an annotated tag, not a lightweight ref');
  assert.equal(git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0^{commit}'), releaseTip);
});

test('a release replay at the same tag is refused rather than re-tagging', () => {
  const fx = makeRolloutFixture({ slug: 'ro-replay' });
  walkRollout(fx);
  // The tag is published; arming release again on this pass is out of order, and even the
  // ordering aside the tag already exists.
  const again = arm(fx, 'release');
  assert.equal(again.ok, false);
  assert.match((again.refusals ?? []).join(' '), /out of order/);
  // The tag still points where it did — a replay never moves a published tag.
  assert.equal(git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0^{commit}'), git(fx.worktree, 'rev-parse', 'HEAD'));
});

test('the push binds the published tip and tag, and later steps bind to THEM', () => {
  const fx = makeRolloutFixture({ slug: 'ro-push' });
  const { records, releaseTip } = walkRollout(fx);
  assert.equal(records.push.data.published_tip, releaseTip);
  assert.equal(typeof records.push.data.published_tag, 'string');
  // The remote really has both refs.
  assert.match(git(fx.MAIN, 'ls-remote', fx.targets.remote, `refs/heads/${fx.branch}`), new RegExp(releaseTip));
  assert.match(git(fx.MAIN, 'ls-remote', '--tags', fx.targets.remote, 'refs/tags/v10.0.0'), /v10\.0\.0/);
  // install_pi's postcondition matched the INSTALLED sha to the published tip — it passed, so
  // the surface really carries the published commit.
  const installed = JSON.parse(fs.readFileSync(path.join(fx.installRoot, '.pi-install.json'), 'utf8'));
  assert.equal(installed.sha, records.push.data.published_tip);
});

test('main_push reports the carried non-bundle commit from git, not from caller data', () => {
  const fx = makeRolloutFixture({ slug: 'ro-carry' });
  // The caller supplies a deliberately FALSE carried list: the report is git-derived, and a
  // record that accepted this would let an unreported commit ride out under a clean report.
  const { records, mainArm } = walkRollout(fx, {
    mainPushData: { carried: [{ sha: '0'.repeat(40), subject: 'a commit that does not exist' }] },
  });
  assert.ok(Array.isArray(mainArm.data.carried), JSON.stringify(mainArm.data));
  assert.deepEqual(records.main_push.data.carried, mainArm.data.carried, 'the arm\'s value wins');
  const serialized = JSON.stringify(records.main_push.data.carried);
  assert.equal(serialized.includes('0'.repeat(40)), false, 'the forged entry is gone');
  // The actual non-bundle commit the fixture started ahead by is named, by sha.
  assert.ok(
    serialized.includes(fx.mainPreBootstrap) || serialized.includes(fx.mainPreBootstrap.slice(0, 12)),
    `the carried report must name ${fx.mainPreBootstrap}: ${serialized}`,
  );
});

test('workspace discovery finds sibling bundles at more than one depth', () => {
  const fx = makeRolloutFixture({ slug: 'ro-ws' });
  // Two sibling repos at DIFFERENT depths: one beside the fixture, one nested a level down.
  // The scan must reach both — an implementation that never descends finds only the shallow one.
  const roots = [{ dir: fx.tmp, depth: 3 }];
  const scanned = scanWorkspaceBundles(roots);
  const paths = scanned.map((b) => String(b.statePath ?? b.repo ?? b.dir ?? ''));
  // The scan returns the repo DIRECTORY, with no trailing separator.
  const shallow = paths.find((pth) => pth.endsWith(`${path.sep}sibling-a`));
  const nested = paths.find((pth) => pth.endsWith(`${path.sep}nested${path.sep}sibling-b`));
  assert.ok(shallow, `the shallow sibling was not discovered: ${JSON.stringify(paths)}`);
  assert.ok(nested, `the NESTED sibling was not discovered: ${JSON.stringify(paths)}`);
  // ...and they really are at different depths, so this is depth traversal and not luck.
  assert.notEqual(shallow.split(path.sep).length, nested.split(path.sep).length);
});

test('the PR merge sha is an ancestor of the remote main and a descendant of the released tip', () => {
  const fx = makeRolloutFixture({ slug: 'ro-merge' });
  const { releaseTip, mergeSha } = walkRollout(fx);
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  // Both relations, asserted in the direction that can actually fail.
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', mergeSha, `${fx.targets.remote}/main`));
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', releaseTip, mergeSha));
  // ...and the remote main IS the merge.
  assert.match(git(fx.MAIN, 'ls-remote', fx.targets.remote, 'refs/heads/main'), new RegExp(mergeSha));
});

test('both surfaces are checked, and surfaces_live passes only when both are live', () => {
  const fx = makeRolloutFixture({ slug: 'ro-surfaces' });
  walkRollout(fx);
  // Both were installed by the walk, and the step recorded done — so both checks passed.
  assert.equal(fs.existsSync(claudeSurfacePath(fx.claudeDir, '10.0.0')), true);
  assert.equal(piSurfaceVersion(fx.installRoot), '10.0.0');
});

// ---------------------------------------------------------------------------
// The gate: a real bundle commit, a real rebase, and a recorded gate. This is also the
// successful gate arm AND record that task 46 could not build on its own fixture.
// ---------------------------------------------------------------------------

// The remote's actual main tip, read with ls-remote rather than taken from the code under test.
function remoteMainTip(fx) {
  const out = git(fx.MAIN, 'ls-remote', fx.targets.remote, 'refs/heads/main');
  return out.split(/\s+/)[0];
}

function completeGate(fx) {
  const liveTip = remoteMainTip(fx);
  const a = arm(fx, 'gate');
  assert.equal(a.ok, true, `gate arm: ${JSON.stringify(a)}`);
  // The arm must bind the LIVE remote tip, established independently — comparing the rebase
  // target to the arm's own output would let a wrong-but-valid ancestor pass unnoticed.
  assert.equal(a.data?.remote_tip, liveTip, 'the gate binds the tip the remote actually has');
  // The gate's own command commits the bundle before the rebase.
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', fx.slug));
  try { git(fx.MAIN, 'commit', '-q', '-m', `masterplan(${fx.slug}): bundle ledger`, '--', path.join('docs', 'masterplan', fx.slug)); } catch { /* nothing to commit */ }
  // ...and rebases local main onto the remote tip the arm bound.
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  git(fx.MAIN, 'rebase', '-q', a.data?.remote_tip ?? `${fx.targets.remote}/main`, 'main');
  const r = record(fx, 'gate');
  return { armed: a, record: r };
}

test('the gate is armed AND recorded after a real rollout WITH THE FINISH LOCK ACTIVE', () => {
  // This is task 46's recorded open finding. Its foundation suite proved the lock does not
  // REFUSE a gate — an empty refusal set — which is not the same claim: a lock that rejected
  // every record after the finish began, gate included, would satisfy it. What was missing is
  // the successful conjunction, and the gate's own preconditions need a full rollout to reach.
  const fx = makeRolloutFixture({ slug: 'ro-gate' });
  walkRollout(fx);

  // The finish begins.
  appendEvent(fx.statePath, { type: 'retro_written', ts: 99 });
  assert.equal(bootstrapStatus(fx.statePath).finish_begun, true);
  // ...and the lock is provably ACTIVE, not merely assumed: a non-gate step is refused for the
  // lock's own reason. Without this the success below could be a lock that never engaged.
  const locked = arm(fx, 'verify');
  assert.equal(locked.ok, false);
  assert.match(locked.refusals.join(' '), /only gate may be armed/);

  const { armed, record: rec } = completeGate(fx);
  assert.equal(armed.ok, true, 'the gate arms THROUGH the active lock');
  assert.deepEqual(armed.refusals ?? [], [], 'and with no refusals at all');
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.finish_begun, true, 'the lock was still on when the gate recorded');
  assert.equal(s.next.step, null, 'every step is complete');
  assert.equal(s.steps.gate.status, 'done');
  assert.ok(s.completed.includes('gate'));
});

test('the gate binds the remote tip: a remote that moves after the arm is refused', () => {
  const fx = makeRolloutFixture({ slug: 'ro-gate-moved' });
  walkRollout(fx);
  const a = arm(fx, 'gate');
  assert.equal(a.ok, true, JSON.stringify(a));
  // A sibling pushes between the arm and the record.
  write(fx.second, 'sibling.txt', 'a sibling pushed after the gate was armed\n');
  git(fx.second, 'add', 'sibling.txt');
  git(fx.second, 'commit', '-q', '-m', 'sibling after the arm');
  git(fx.second, 'push', '-q', 'origin', 'main');
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', fx.slug));
  try { git(fx.MAIN, 'commit', '-q', '-m', 'bundle ledger', '--', path.join('docs', 'masterplan', fx.slug)); } catch { /* nothing */ }
  assert.throws(() => record(fx, 'gate'), /remote main moved since the gate was armed/);
});

test('the gate refuses while the bundle ledger is uncommitted', () => {
  const fx = makeRolloutFixture({ slug: 'ro-gate-dirty' });
  walkRollout(fx);
  const a = arm(fx, 'gate');
  assert.equal(a.ok, true, JSON.stringify(a));
  // The arm's own event is uncommitted; the gate's command commits the bundle FIRST, so a
  // still-dirty ledger means the command did not run as printed.
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  assert.throws(() => record(fx, 'gate'), /bundle ledger is not committed/);
});

test('the rebase is conflict-free and the state-only commits replay onto the merge', () => {
  const fx = makeRolloutFixture({ slug: 'ro-rebase' });
  const { mergeSha } = walkRollout(fx);
  const before = git(fx.MAIN, 'rev-parse', 'main');
  completeGate(fx);
  const after = git(fx.MAIN, 'rev-parse', 'main');
  assert.notEqual(before, after, 'main moved');
  // The merge is now in local main's history, and every commit main gained past it is
  // bundle-only — the state-only commits that replayed on top.
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', mergeSha, 'main'));
  const past = git(fx.MAIN, 'log', '--format=%H', `${mergeSha}..main`).split('\n').filter(Boolean);
  // STATE-ONLY, and only THIS bundle's state: `docs/masterplan/**` would also admit another
  // run's spec or arbitrary documentation, which is not what "state-only" means.
  const allowed = new Set([
    `docs/masterplan/${fx.slug}/state.yml`,
    `docs/masterplan/${fx.slug}/events.jsonl`,
  ]);
  const allowedPrefix = `docs/masterplan/${fx.slug}/.bootstrap-targets-`;
  for (const sha of past) {
    const files = git(fx.MAIN, 'show', '--pretty=format:', '--name-only', sha).split('\n').filter(Boolean);
    for (const f of files) {
      const ok = allowed.has(f) || f.startsWith(allowedPrefix);
      assert.ok(ok, `${sha.slice(0, 8)} touched ${f} — only this bundle's ledger may replay`);
    }
  }
});

test('the v9 merge after the rollout is a NO-OP: the branch is already in main', () => {
  const fx = makeRolloutFixture({ slug: 'ro-noop' });
  walkRollout(fx);
  completeGate(fx);
  const before = git(fx.MAIN, 'rev-parse', 'main');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', fx.branch);
  const changed = git(fx.MAIN, 'diff', '--name-only', `${before}..main`).split('\n').filter(Boolean);
  assert.deepEqual(changed, [], 'the finish merge changes no files — the PR merge already carried the branch');
  // Identity, not just an empty file diff: an EMPTY MERGE COMMIT changes no files while still
  // moving main, and "no-op" has to mean the history did not move either.
  assert.equal(git(fx.MAIN, 'rev-parse', 'main'), before, 'main did not move');
});

test('after the gate the archive push is a fast-forward of the remote', () => {
  const fx = makeRolloutFixture({ slug: 'ro-ffpush' });
  walkRollout(fx);
  completeGate(fx);
  // The archive commit and any gate commits since are the only history past the remote.
  write(fx.MAIN, path.join('docs', 'masterplan', fx.slug, 'retro.md'), '# retro\n');
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', fx.slug));
  git(fx.MAIN, 'commit', '-q', '-m', `masterplan(${fx.slug}): archive run`, '--', path.join('docs', 'masterplan', fx.slug));
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  // A fast-forward: the remote tip is an ancestor of what is being pushed.
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', `${fx.targets.remote}/main`, 'main'));
  assert.doesNotThrow(() => git(fx.MAIN, 'push', fx.targets.remote, 'main'));
});

// ---------------------------------------------------------------------------
// Adversary round 1 — the findings each of these closes is named in its comment.
// ---------------------------------------------------------------------------

test('a release cannot re-tag a published tag EVEN when it is otherwise armable', () => {
  // Finding: the replay test armed release after the whole pass had run, so the ordering guard
  // refused it before the tag rule was ever consulted. The rule was therefore untested. Here
  // the tag exists at a point where release IS the current step, so nothing but the tag rule
  // can refuse it.
  const fx = makeRolloutFixture({ slug: 'ro-retag' });
  // The tag is already published — by an interrupted earlier attempt, or by a sibling. It is
  // created BEFORE the pre-publish steps are seeded so their receipts bind THIS tip: a stale
  // reviewed_at_tip would refuse the arm for an unrelated reason and hide the tag rule again.
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md');
  git(fx.worktree, 'commit', '-q', '-m', 'release: 10.0.0');
  const tagged = git(fx.worktree, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'release 10.0.0', tagged);
  const tagObjectBefore = git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0');
  // PUBLISHED, not merely local: a sibling or an interrupted run pushes the tag, and a clone
  // that has not fetched it would otherwise see `tag_absent` pass and create a conflicting
  // local tag that only fails much later, at the push.
  git(fx.MAIN, 'push', '-q', fx.targets.remote, 'refs/tags/v10.0.0');
  seedThrough(fx, ['rehearsal', 'docs_normalize', 'verify', 'review', 'assess']);

  // release is the current step, so ordering cannot be what refuses this.
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'release');
  const a = arm(fx, 'release');
  assert.equal(a.ok, false, JSON.stringify(a));
  assert.doesNotMatch([...(a.refusals ?? []), ...(a.preconditions ?? []).map((c) => c.detail ?? '')].join(' '), /out of order/,
    'ordering must not be what refuses it');
  // The failing precondition is the TAG one, by name — a refusal for some other reason would
  // leave the re-tag rule as untested as it was before.
  // Both tag guards fire: the tag is present locally AND on the remote. Nothing else may be
  // the reason, or the tag rule is again not what refused it.
  const failed = (a.preconditions ?? []).filter((c) => !c.ok).map((c) => c.name).sort();
  assert.deepEqual(failed, ['remote_tag_absent', 'tag_absent'], JSON.stringify(a.preconditions));

  // Both identities are unchanged: replacing an annotated tag object with a new one at the
  // same commit would leave the peeled sha equal while still rewriting a published tag.
  assert.equal(git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0'), tagObjectBefore, 'the tag OBJECT is untouched');
  assert.equal(git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0^{commit}'), tagged, 'and so is the commit it names');
  // ...on the remote too, which is where "published" actually lives.
  assert.equal(git(fx.MAIN, 'ls-remote', fx.targets.remote, 'refs/tags/v10.0.0').split(/\s+/)[0], tagObjectBefore);
});

test('a tag published on the REMOTE but absent locally still refuses the release', () => {
  // The narrower guard the test above cannot distinguish: a clone that has not fetched the tag
  // sees nothing locally, so a local-only check would let it create a conflicting one.
  const fx = makeRolloutFixture({ slug: 'ro-retag-remote' });
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md');
  git(fx.worktree, 'commit', '-q', '-m', 'release: 10.0.0');
  const tagged = git(fx.worktree, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'release 10.0.0', tagged);
  const published = git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0');
  git(fx.MAIN, 'push', '-q', fx.targets.remote, 'refs/tags/v10.0.0');
  git(fx.MAIN, 'tag', '-d', 'v10.0.0'); // the local clone has not fetched it
  seedThrough(fx, ['rehearsal', 'docs_normalize', 'verify', 'review', 'assess']);

  assert.equal(bootstrapStatus(fx.statePath).next.step, 'release');
  const a = arm(fx, 'release');
  assert.equal(a.ok, false, `a published tag must refuse the release: ${JSON.stringify(a)}`);
  // The REMOTE guard specifically: the local tag is gone, so only a remote-aware check can
  // refuse this, and nothing else may be the reason.
  const failed = (a.preconditions ?? []).filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['remote_tag_absent'], JSON.stringify(a.preconditions));
  assert.equal(git(fx.MAIN, 'ls-remote', fx.targets.remote, 'refs/tags/v10.0.0').split(/\s+/)[0], published,
    'the published tag is untouched');
});

// surfaces_live's record throws when a postcondition fails, naming the conditions that did.
// These negatives assert the failure BY NAME: a bare "it failed" would pass for an unrelated
// precondition and prove nothing about the executable check.
function recordSurfacesLiveExpectingFailure(fx, expectedFail, label) {
  const a = arm(fx, 'surfaces_live');
  assert.equal(a.ok, true, `${label}: surfaces_live must arm so the postcondition is reached: ${JSON.stringify(a)}`);
  let err = null;
  try {
    const r = record(fx, 'surfaces_live');
    assert.fail(`${label}: expected surfaces_live to fail, got ${JSON.stringify(r)}`);
  } catch (e) {
    err = e;
  }
  assert.match(err.message, /postcondition failed/, `${label}: ${err.message}`);
  assert.match(err.message, new RegExp(expectedFail), `${label}: expected ${expectedFail}, got ${err.message}`);
  return err;
}

test('surfaces_live fails when ONLY Pi is live, and when ONLY Claude is', () => {
  // Finding: the test asserted the two-surface success and was titled "only when both", which
  // its assertions did not establish. An AND silently changed to an OR would have passed.
  for (const missing of ['claude', 'pi']) {
    const fx = makeRolloutFixture({ slug: `ro-one-${missing}` });
    // Each surface's OWN step validates its install, so a surface cannot be missing while that
    // step passes. The rollout installs both, and the one under test is removed afterwards —
    // which is also the real failure mode: a surface that was installed and later disappeared.
    walkRollout(fx, { surfaces: {} });
    if (missing === 'pi') fs.rmSync(path.join(fx.installRoot, 'current'), { recursive: true, force: true });
    else removeClaudeSurface(fx, '10.0.0');
    // The step must genuinely ARM and the failure must name the MISSING surface's own
    // condition: a conditional record would let this pass by never reaching the postcondition,
    // which is exactly how a vacuous negative hides a regression from AND to OR.
    const err = recordSurfacesLiveExpectingFailure(fx, missing === 'pi' ? 'pi_' : 'claude_', `only ${missing} missing`);
    // ...and the surface that IS installed does not appear among the failures, so the refusal
    // is the absent one rather than a broken probe.
    const other = missing === 'pi' ? 'claude_executable' : 'pi_executable';
    assert.doesNotMatch(err.message, new RegExp(other), `${other} should have passed`);
  }
});

test('a surface that is INSTALLED but cannot run fails surfaces_live', () => {
  // Finding: the check read plugin.json and the cache path, so an install whose entry point is
  // absent or dies on start satisfied it. G6 requires the release to be executable in both
  // surfaces, which only running it can establish.
  for (const [label, piOpts, claudeOpts, expectedFail] of [
    ['pi entry missing', { omitEntry: true }, {}, 'pi_executable'],
    ['pi entry broken', { entrySource: BROKEN_ENTRY }, {}, 'pi_executable'],
    ['claude entry broken', {}, { entrySource: BROKEN_ENTRY }, 'claude_executable'],
    ['pi reports the WRONG version', { entrySource: ENTRY_SOURCE('9.10.0') }, {}, 'pi_executable'],
  ]) {
    const fx = makeRolloutFixture({ slug: `ro-exec-${label.replace(/\W+/g, '-')}` });
    walkRollout(fx, { surfaces: { pi: piOpts, claude: claudeOpts } });
    // The EXECUTABLE condition is what fails — not the metadata one, which these fixtures
    // deliberately satisfy so that only running the surface can distinguish them.
    recordSurfacesLiveExpectingFailure(fx, expectedFail, label);
  }
});

test('a surface that prints something OTHER than its version does not pass as executable', () => {
  // The probe used to hunt a semver out of arbitrary stdout, so an entry point that ignored its
  // argument and echoed its own install path — which contains the version — passed.
  const fx = makeRolloutFixture({ slug: 'ro-exec-noise' });
  walkRollout(fx, { surfaces: { pi: { entrySource: 'console.log(process.argv[1]);\n' } } });
  recordSurfacesLiveExpectingFailure(fx, 'pi_executable', 'prints its own path');
});

test('an entry point that ignores the version ARGUMENT is not accepted', () => {
  // The command contract, not just "some program started": a stub answering every invocation
  // identically would satisfy a probe that passed the wrong argument.
  const fx = makeRolloutFixture({ slug: 'ro-exec-arg' });
  walkRollout(fx, {
    surfaces: {
      pi: { entrySource: "console.log(process.argv[2] === 'version' ? 'no version verb here' : 'masterplan 10.0.0');\n" },
    },
  });
  recordSurfacesLiveExpectingFailure(fx, 'pi_executable', 'ignores the version argument');
});

test('a corrective pass REFUSES every omitted step through the real arm/record path', () => {
  // Finding: `stepsForPass` was asserted structurally, but the state machine was never asked
  // to arm an omitted step on a live pass-2 fixture. A regression that let `release` or `push`
  // through would not have been caught — and those are the irreversible ones.
  const fx = makeRolloutFixture({ slug: 'ro-pass2' });
  walkRollout(fx);
  // Before the gate: once pass 1's gate is recorded the bootstrap is COMPLETE, and a later
  // finding needs a new run rather than a corrective pass.
  // The trigger is the INDEX of the event that opened the pass — an unreferenced string would
  // leave a corrective pass nobody can trace back to a finding.
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 90, verdict: 'rework' });
  startPass({ statePath: fx.statePath, pass: 2, triggeredBy: events(fx.statePath).length - 1, version: '10.0.1', targets: fx.targets });

  assert.ok(PASS2_OMITTED.length > 0, 'there is something to omit');
  // The corrective pass is bound to its OWN version; the targets must name it.
  const p2 = { ...fx.targets, version: '10.0.1' };
  for (const step of PASS2_OMITTED) {
    const before = readBundleEvents(fx.statePath).length;
    const a = arm(fx, step, { targets: p2 });
    assert.equal(a.ok, false, `${step} must be unreachable on a corrective pass: ${JSON.stringify(a)}`);
    // The refusal must NAME the omission. Every omitted step is also out of order here (the
    // pass sits at `verify`), so accepting an ordering refusal would let the omission rule be
    // deleted outright with this test still green.
    assert.match((a.refusals ?? []).join(' '), /pass 2|omitted/,
      `${step}: the refusal must name corrective-pass omission, not ordering: ${JSON.stringify(a)}`);
    assert.equal(readBundleEvents(fx.statePath).length, before, `${step}: a refused arm writes nothing`);
    // ...and it cannot be recorded past the arm either, for the SAME reason — asserted by name,
    // because "not armed" would otherwise make this pass whatever the omission rule did.
    assert.throws(() => record(fx, step, { targets: p2 }), /pass 2|omitted/,
      `${step} must not be recordable on a corrective pass`);
    assert.equal(readBundleEvents(fx.statePath).length, before, `${step}: a refused record writes nothing`);
  }
  // The pass still sequences its own permitted steps.
  assert.ok(!PASS2_OMITTED.includes(bootstrapStatus(fx.statePath).next.step));
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'verify', 'a corrective pass re-enters at verify');
});

test('the state-only replay audit REJECTS a non-state commit, not just accepts a clean one', () => {
  // Finding: the audit walked a history it had itself produced and asserted nothing about a
  // violating one, and never checked the loop was non-vacuous. A gate that stopped auditing
  // would have passed.
  const fx = makeRolloutFixture({ slug: 'ro-stateonly-neg' });
  walkRollout(fx);
  // A SOURCE commit lands on local main before the gate — exactly what must not be replayed
  // over the merge unaudited.
  write(fx.MAIN, 'src/sneaky.js', 'not bundle state\n');
  git(fx.MAIN, 'add', 'src/sneaky.js');
  git(fx.MAIN, 'commit', '-q', '-m', 'a source commit that is not bundle state');
  const sneaky = git(fx.MAIN, 'rev-parse', 'HEAD');

  // The gate REFUSES to arm, naming the offending commit — the audit is a precondition, not a
  // post-hoc inspection, so nothing is rebased or pushed at all.
  const a = arm(fx, 'gate');
  assert.equal(a.ok, false, JSON.stringify(a));
  const bundleOnly = (a.preconditions ?? []).find((c) => c.name === 'bundle_only');
  assert.ok(bundleOnly && !bundleOnly.ok, JSON.stringify(a.preconditions));
  assert.match(bundleOnly.detail, new RegExp(sneaky.slice(0, 12)), 'it names the commit that violated it');
});

test('the state-only audit is NON-VACUOUS: a clean rollout really does replay state commits', () => {
  // The positive half of the pair above. Without it, a gate that audited nothing at all would
  // satisfy the refusal test's counterpart by simply having no history to walk.
  const fx = makeRolloutFixture({ slug: 'ro-stateonly-pos' });
  const { mergeSha } = walkRollout(fx);
  completeGate(fx);
  const past = git(fx.MAIN, 'log', '--format=%H', `${mergeSha}..main`).split('\n').filter(Boolean);
  assert.ok(past.length > 0, 'there IS replayed history, so the audit loop is not vacuous');
  for (const sha of past) {
    const files = git(fx.MAIN, 'show', '--pretty=format:', '--name-only', sha).split('\n').filter(Boolean);
    assert.ok(files.length > 0, `${sha.slice(0, 8)} is an empty commit`);
    for (const f of files) {
      assert.ok(f.startsWith(`docs/masterplan/${fx.slug}/`), `${sha.slice(0, 8)} touched ${f}`);
    }
  }
});

test('the archive push is REFUSED when the remote has diverged', () => {
  // Finding: only a naturally fast-forwarding push was covered, so a workflow that force-pushed
  // over a sibling's commit was never challenged. This is the security-relevant half.
  const fx = makeRolloutFixture({ slug: 'ro-ffpush-neg' });
  walkRollout(fx);
  completeGate(fx);
  write(fx.MAIN, path.join('docs', 'masterplan', fx.slug, 'retro.md'), '# retro\n');
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', fx.slug));
  git(fx.MAIN, 'commit', '-q', '-m', `masterplan(${fx.slug}): archive run`, '--', path.join('docs', 'masterplan', fx.slug));

  // A sibling lands on the remote after the local archive commit was made.
  write(fx.second, 'sibling-late.txt', 'landed after the archive commit\n');
  git(fx.second, 'add', 'sibling-late.txt');
  git(fx.second, 'commit', '-q', '-m', 'sibling after the archive commit');
  git(fx.second, 'push', '-q', 'origin', 'main');
  const siblingTip = remoteMainTip(fx);

  // It is no longer a fast-forward, and the push is refused.
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  assert.throws(() => git(fx.MAIN, 'merge-base', '--is-ancestor', 'main', `${fx.targets.remote}/main`));
  assert.throws(() => git(fx.MAIN, 'push', fx.targets.remote, 'main'), /rejected|non-fast-forward|fetch first/i);
  assert.equal(remoteMainTip(fx), siblingTip, "the sibling's commit is still the remote tip");
});

test('a successful archive push leaves remote main EQUAL to local main', () => {
  // Ancestry alone would hold even if the push landed something other than what was built.
  const fx = makeRolloutFixture({ slug: 'ro-ffpush-eq' });
  walkRollout(fx);
  completeGate(fx);
  write(fx.MAIN, path.join('docs', 'masterplan', fx.slug, 'retro.md'), '# retro\n');
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', fx.slug));
  git(fx.MAIN, 'commit', '-q', '-m', `masterplan(${fx.slug}): archive run`, '--', path.join('docs', 'masterplan', fx.slug));
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  git(fx.MAIN, 'push', '-q', fx.targets.remote, 'main');
  assert.equal(remoteMainTip(fx), git(fx.MAIN, 'rev-parse', 'main'));
});

test('the run branch is RETIRED after the rollout: gone locally and on the remote', () => {
  // Finding: branch retirement is a named acceptance criterion with no coverage at all. A
  // finish that stopped deleting the branch, or deleted only the local one, would pass.
  const fx = makeRolloutFixture({ slug: 'ro-retire' });
  walkRollout(fx);
  completeGate(fx);
  // Retirement is safe precisely because the PR merge already carried the branch into main.
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', fx.branch, 'main'),
    'the branch is fully contained in main before it is deleted');

  // The run's worktree still holds the branch; a finish retires the worktree before the branch.
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.worktree);
  git(fx.MAIN, 'push', '-q', fx.targets.remote, '--delete', fx.branch);
  git(fx.MAIN, 'branch', '-D', fx.branch);

  assert.equal(git(fx.MAIN, 'ls-remote', fx.targets.remote, `refs/heads/${fx.branch}`), '', 'gone on the remote');
  assert.throws(() => git(fx.MAIN, 'rev-parse', '--verify', `refs/heads/${fx.branch}`), 'gone locally');
  // The released tag is NOT retired with it — the history has to stay reachable.
  assert.doesNotThrow(() => git(fx.MAIN, 'rev-parse', 'refs/tags/v10.0.0'));
  assert.doesNotThrow(() => git(fx.MAIN, 'merge-base', '--is-ancestor', 'refs/tags/v10.0.0^{commit}', 'main'));
});

test('the archived bundle survives the rollout in main, and a LEGACY bundle is left alone', () => {
  // Finding: the "archive push" test only committed a retro and pushed, which is not evidence
  // that the run's ledger is what landed — nor that a pre-v10 bundle beside it is untouched.
  const fx = makeRolloutFixture({ slug: 'ro-archive' });
  // A pre-v10 bundle with no completion field: the rollout must not rewrite or remove it.
  const legacyDir = path.join(fx.MAIN, 'docs', 'masterplan', 'legacy-run');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'state.yml'), 'schema_version: 8\nslug: legacy-run\nstatus: archived\n');
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', 'legacy-run'));
  git(fx.MAIN, 'commit', '-q', '-m', 'a pre-v10 archived bundle');
  const legacyBefore = git(fx.MAIN, 'rev-parse', 'HEAD:docs/masterplan/legacy-run/state.yml');

  walkRollout(fx);
  completeGate(fx);
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', fx.slug));
  try { git(fx.MAIN, 'commit', '-q', '-m', `masterplan(${fx.slug}): archive run`, '--', path.join('docs', 'masterplan', fx.slug)); } catch { /* already committed */ }
  git(fx.MAIN, 'fetch', '-q', fx.targets.remote);
  git(fx.MAIN, 'push', '-q', fx.targets.remote, 'main');

  // The ledger that landed on the remote is THIS run's, with its whole rollout in it.
  const clone = path.join(fx.tmp, 'verify-clone');
  // `-b main` explicitly: the bare remote's HEAD is not main, so a default clone checks out
  // nothing and the assertions below would read an empty tree.
  execFileSync('git', ['clone', '-q', '-b', 'main', fx.bare, clone]);
  const landed = fs.readFileSync(path.join(clone, 'docs', 'masterplan', fx.slug, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const steps = new Set(landed.filter((e) => e.type === 'bootstrap_step' && e.status === 'done').map((e) => e.step));
  for (const step of EXPECTED_ORDER) {
    assert.ok(steps.has(step), `${step} is missing from the archived ledger on the remote`);
  }
  // ...and the legacy bundle is byte-identical, in the clone as well as locally.
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD:docs/masterplan/legacy-run/state.yml'), legacyBefore);
  assert.ok(fs.existsSync(path.join(clone, 'docs', 'masterplan', 'legacy-run', 'state.yml')));
});

// ---------------------------------------------------------------------------
// Wave task 48 — driver-level release/review refusals and the doctor checks
// against REAL fixture output.
// ---------------------------------------------------------------------------

test('a release whose tree moved more than the release commit past the armed tip is refused and leaves NO tag', () => {
  // §10.3 / §10.1.3: the tagged commit must differ from the reviewed sha by AT MOST the
  // release commit. The rehearsal proves this at the git level (release_extra_commit_refused);
  // here is the DRIVER-level path. The single_commit contract is enforced TWICE: the record-time
  // release PREFLIGHT (which runs before the tag is trusted and ROLLS a stray tag back) and the
  // postcondition (the after-the-fact invariant). A two-commit move is refused by the preflight
  // with nothing recorded AND no tag left behind — the guard chain that keeps a too-far release
  // out, proven from the refusal to the on-disk state.
  const fx = makeRolloutFixture({ slug: 'ro-single-commit' });
  const t = fx.tip();
  walkOk(fx, 'rehearsal', {}, { digestFile: digest(fx, 'ok') });
  walkOk(fx, 'docs_normalize');
  walkOk(fx, 'verify', { tip: t });
  walkOk(fx, 'review', { tip: t, verdict: 'approve' });
  walkOk(fx, 'assess', { tip: t, goals: { G1: 'achieved' } });
  // Arm release, then TWO commits land after the armed tip before the record: an unrelated
  // commit and the CHANGELOG one. A tag is created at the far tip the way release.mjs would.
  armOk(fx, 'release');
  write(fx.worktree, 'src/extra.txt', 'a second unreviewed commit\n');
  git(fx.worktree, 'add', 'src/extra.txt');
  git(fx.worktree, 'commit', '-q', '-m', 'an unreviewed second commit');
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md');
  git(fx.worktree, 'commit', '-q', '-m', 'release: 10.0.0');
  const farTip = git(fx.worktree, 'rev-parse', 'HEAD');
  assert.notEqual(farTip, t, 'the tip really is more than one commit past the reviewed sha');
  assert.equal(git(fx.MAIN, 'rev-list', '--count', `${t}..${farTip}`), '2');
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'release 10.0.0', farTip);
  // The record is refused by the release preflight, which names the two-commit move.
  assert.throws(
    () => record(fx, 'release'),
    /release preflight refused: single_commit/,
  );
  // Nothing is recorded: the refusal left no bootstrap_step for release.
  const steps = readBundleEvents(fx.statePath).filter((e) => e.type === 'bootstrap_step' && e.step === 'release');
  assert.deepEqual(steps, [], 'the refused release records no outcome');
  // The tag the release command created on the unverified tip is ROLLED BACK: a refused release
  // must not leave unreviewed code tagged. This is the property the reviewer's finding 1 demanded.
  assert.throws(
    () => git(fx.MAIN, 'rev-parse', '--verify', 'refs/tags/v10.0.0'),
    /Needed a single revision|unknown revision|not found/, 'no tag exists after the refused release',
  );
  // The stage stays REFUSED, never waved through — and the two-commit move STALES the recorded
  // §10.2 chain (recordIsStale: the move is not the one designed release commit, and release has
  // no record), so the honest next step is verify: the unreviewed extra commit must re-run the
  // pre-publish chain at the new tip before any release is re-armed (§10.2's principle —
  // publishing never precedes every whole-branch review — now enforced end to end).
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'verify',
    'the stage stales the chain at the moved tip, never waves the release through');
});

test('the single_commit guard is independently reachable: a malformed delta is refused even when the execution-tree check would pass', () => {
  // Finding 2 (adversary round 1): the ORIGINAL test reached the two-commit case only through
  // the earlier execution-tree guard, so deleting STEPS.release.post's single_commit check would
  // not have failed it. The preflight now runs BEFORE the tree-position check and enforces the
  // same single_commit contract, so the guard is reached on its own terms. Prove it by deleting
  // nothing: walk a full rollout, then malform the reviewed→release delta in a way the tree
  // guard would NOT have caught on its own (an extra commit on the branch), and assert the
  // refusal names single_commit specifically — the tree guard never had the first say.
  const fx = makeRolloutFixture({ slug: 'ro-single-commit-reach' });
  const t = fx.tip();
  walkOk(fx, 'rehearsal', {}, { digestFile: digest(fx, 'ok') });
  walkOk(fx, 'docs_normalize');
  walkOk(fx, 'verify', { tip: t });
  walkOk(fx, 'review', { tip: t, verdict: 'approve' });
  walkOk(fx, 'assess', { tip: t, goals: { G1: 'achieved' } });
  armOk(fx, 'release');
  // ONE unrelated commit lands (not CHANGELOG-only), then a tag at the tip — the tree guard
  // sees HEAD at the tip and would pass its position check, but the delta is two commits.
  write(fx.worktree, 'src/extra.txt', 'an unrelated unreviewed change\n');
  git(fx.worktree, 'add', 'src/extra.txt');
  git(fx.worktree, 'commit', '-q', '-m', 'an unrelated unreviewed commit');
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md');
  git(fx.worktree, 'commit', '-q', '-m', 'release: 10.0.0');
  const farTip = git(fx.worktree, 'rev-parse', 'HEAD');
  assert.equal(git(fx.MAIN, 'rev-list', '--count', `${t}..${farTip}`), '2', 'two commits past the reviewed sha');
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'release 10.0.0', farTip);
  assert.throws(
    () => record(fx, 'release'),
    /release preflight refused: single_commit/,
    'the single_commit contract refuses independently of the tree-position guard',
  );
  assert.throws(
    () => git(fx.MAIN, 'rev-parse', '--verify', 'refs/tags/v10.0.0'),
    /Needed a single revision|unknown revision|not found/, 'no tag remains',
  );
});

test('a review rejection stops the stage BEFORE the release is armable — nothing is tagged', () => {
  // §10.3: a revise/reject review verdict stops the stage before step 3, while the worktree
  // still exists to fix it. The review postcondition refuses a non-approve verdict; the
  // chained consequence — release cannot even arm — is what this asserts. Without the chain,
  // a driver that refused the review record but let release proceed would pass the review
  // test while still tagging unreviewed code.
  const fx = makeRolloutFixture({ slug: 'ro-review-reject' });
  const t = fx.tip();
  walkOk(fx, 'rehearsal', {}, { digestFile: digest(fx, 'ok') });
  walkOk(fx, 'docs_normalize');
  walkOk(fx, 'verify', { tip: t });
  // A revise verdict is refused by the review postcondition...
  armOk(fx, 'review');
  assert.throws(
    () => record(fx, 'review', { data: { tip: t, verdict: 'revise' } }),
    /postcondition failed: verdict_approve/,
  );
  // ...and the stage stays ON review: release is out of order, and the ordering guard is the
  // ONLY thing between this refusal and a tag. Assert the refusal names the ordering so a
  // driver that jumped straight to release (via a deleted postcondition) cannot pass.
  const afterReject = bootstrapStatus(fx.statePath);
  assert.equal(afterReject.next.step, 'review', 'the stage stays on review after the refusal');
  const releaseArm = arm(fx, 'release');
  assert.equal(releaseArm.ok, false, 'release must not be armable after a rejected review');
  assert.match((releaseArm.refusals ?? []).join(' '), /out of order: expected review/);
  // The tag was never created.
  assert.throws(
    () => git(fx.MAIN, 'rev-parse', '--verify', 'refs/tags/v10.0.0'),
    /unknown revision|fatal/, 'no tag exists after a rejected review',
  );
});

// The finish-archive writer (lib/finish-step.mjs, task 28) is not in this task's scope, so
// these tests emulate its durable archive output on top of a REAL rollout bundle (one the
// driver actually walked) and confirm the doctor checks consume it. The point is that the
// doctor checks work against REAL writer-shaped state/events, not only the hand-built
// fixtures the doctor tests use.
//
// Round-1 finding 3 (adversary): archiveLikeFinish used to write `completion` into state with
// NO matching ledger authorization — a `complete` without a completion_confirmed bound to a
// deploy_base, an incomplete:keep without an incomplete_authorized {reason:'kept'}. The real
// finish writer (task 28) REFUSES exactly those states (lib/finish-step.mjs archive guard), so
// the fixtures silently drifted from what the writer produces. This version emits the FULL
// ledger contract the writer requires, then ASSERTS the contract holds by re-deriving the
// completion class from the ledger the way lib/finish-step.mjs's deriveCompletionClass does,
// before any doctor check runs. If the fixture drifts again, the assertion fails here — not
// silently in the doctor's output.
function archiveLikeFinish(fx, { completion, successorSlug = null, successorReason = null, predecessor = null } = {}) {
  // The finish emits the required_successor obligation BEFORE it archives (appendEvent refuses
  // new events after archived except archive_pushed), so the event lands first, then the archive
  // state write — the same order the real writer uses.
  if (successorSlug && successorReason) {
    appendEvent(fx.statePath, { type: 'required_successor', ts: 1, slug: successorSlug, reason: successorReason });
  }
  if (predecessor) {
    const succDir = path.join(fx.MAIN, 'docs', 'masterplan', successorSlug);
    fs.mkdirSync(succDir, { recursive: true });
    writeState(path.join(succDir, 'state.yml'), {
      schema_version: 8, slug: successorSlug, status: 'in-progress', phase: 'brainstorm',
      predecessor, tasks: [], active_run: null, pending_gate: null,
    });
    fs.writeFileSync(path.join(succDir, 'events.jsonl'), JSON.stringify({
      type: 'bundle_created', ts: 1, slug: successorSlug, predecessor,
      data: { goals_enabled: true },
    }) + '\n');
  }

  // §7.4 ledger contract, emitted BEFORE the state write (appendEvent is the commit point):
  // the archive class the state claims must have a matching authorization on the ledger, or the
  // real writer (lib/finish-step.mjs archive guard) would refuse it.
  const deployBaseSha = fx.head(); // post-gate HEAD: the merged, released tip the deployment landed on
  if (completion === 'complete') {
    appendEvent(fx.statePath, {
      type: 'deploy_base', ts: 1, sha: deployBaseSha,
      branch_tip: fx.tip(),
      done_sha256: doneDigest({ run: 'node scripts/release.mjs' }),
    });
    appendEvent(fx.statePath, {
      type: 'completion_confirmed', ts: 2, deploy_base_sha: deployBaseSha,
    });
  } else if (completion && completion.startsWith('incomplete:')) {
    const reason = completion.slice('incomplete:'.length);
    // The real writer's terminal reasons: kept, discarded, deploy_skip:<g>[<i>], deploy_abort:<gate>,
    // attested, intent_waived, intent_rejected:<class>, version_not_bumped, no_definition_of_done.
    appendEvent(fx.statePath, {
      type: 'incomplete_authorized', ts: 1, reason,
      ...(reason.startsWith('intent_rejected:')
        ? { class: reason.split(':')[1] ?? null, successor: successorSlug ?? null, deploy_base_sha: deployBaseSha }
        : {}),
    });
  }

  const state = readState(fx.statePath);
  const archived = setStatus({ ...state, ...(completion ? { completion } : {}) }, 'archived');
  writeState(fx.statePath, archived);

  // ASSERT the writer contract holds BEFORE any doctor check consumes the bundle: re-derive the
  // completion class from the ledger exactly as lib/finish-step.mjs's deriveCompletionClass does.
  const events = readBundleEvents(fx.statePath);
  const terminalReasons = ['kept', 'discarded', 'attested', 'version_not_bumped', 'no_definition_of_done',
    'deploy_abort', 'intent_waived'];
  const terminal = events.filter((e) => e.type === 'incomplete_authorized'
    && (terminalReasons.includes(String(e.reason))
      || String(e.reason ?? '').startsWith('deploy_skip:')
      || String(e.reason ?? '').startsWith('deploy_abort:')
      || String(e.reason ?? '').startsWith('intent_rejected:')));
  const bases = events.filter((e) => e.type === 'deploy_base');
  const latestBase = bases.length ? bases[bases.length - 1] : null;
  const confirmations = events.filter((e) => e.type === 'completion_confirmed');
  let derived;
  if (terminal.length) {
    derived = `incomplete:${terminal[terminal.length - 1].reason}`;
  } else if (latestBase && latestBase.done_sha256 === doneDigest('none')) {
    derived = 'merged';
  } else if (confirmations.some((c) => c.deploy_base_sha === (latestBase ? latestBase.sha : null))) {
    derived = 'complete';
  } else {
    derived = null; // legacy
  }
  const expect = completion === 'complete' || completion === null || completion === undefined ? (completion ?? null) : completion;
  assert.equal(derived, expect,
    `the ledger must derive the requested archive class: state asked for ${JSON.stringify(completion)} `
    + `but the ledger derives ${JSON.stringify(derived)} — the fixture drifted from the real finish writer's contract`);
}

test('the doctor checks consume a real rollout bundle archived complete', () => {
  const fx = makeRolloutFixture({ slug: 'ro-doctor-complete' });
  walkRollout(fx);
  completeGate(fx);
  archiveLikeFinish(fx, { completion: 'complete' });
  // A real, fully-walked bundle archived as complete: legacy-archive and incomplete-archive
  // must both stay silent (it is neither), and required-successor sees no obligation.
  const legacy = legacyArchiveCheck(fx.MAIN);
  assert.equal(legacy.some((f) => f.summary.includes('ro-doctor-complete')), false, JSON.stringify(legacy));
  assert.ok(legacy.some((f) => f.severity === 'PASS'), JSON.stringify(legacy));
  const incomplete = incompleteArchiveCheck(fx.MAIN);
  assert.equal(incomplete.some((f) => f.summary.includes('ro-doctor-complete')), false, JSON.stringify(incomplete));
  assert.equal(requiredSuccessorCheck(fx.MAIN).find((f) => f.id === 'required-successor').summary, 'no required-successor obligations');
});

test('the doctor checks consume a real rollout bundle archived incomplete with a required successor', () => {
  const fx = makeRolloutFixture({ slug: 'ro-doctor-incomplete' });
  walkRollout(fx);
  completeGate(fx);
  // The corrective-release decline (operator keeps the branch) archives incomplete:kept — the
  // REAL §7.4 class (incomplete_authorized {reason:'kept'}), not the pre-fix drift 'incomplete:keep'
  // which the real finish writer would refuse. A keep with a successor obligation is what §7.4's
  // incomplete-archive PASS + required-successor PASS model.
  archiveLikeFinish(fx, {
    completion: 'incomplete:kept', successorSlug: 'ro-doctor-succ', successorReason: 'corrective release declined', predecessor: 'ro-doctor-incomplete',
  });
  // The SOURCE is incomplete:* — incomplete-archive reports it; legacy-archive does not.
  const incomplete = incompleteArchiveCheck(fx.MAIN);
  assert.ok(
    incomplete.some((f) => f.summary.includes('ro-doctor-incomplete') && f.summary.includes('incomplete:kept')),
    JSON.stringify(incomplete),
  );
  const legacy = legacyArchiveCheck(fx.MAIN);
  assert.equal(legacy.some((f) => f.summary.includes('ro-doctor-incomplete')), false, JSON.stringify(legacy));
  // The successor is linked and in-progress: required-successor PASSes (not ERROR).
  const req = requiredSuccessorCheck(fx.MAIN);
  const f = req.find((x) => x.id === 'required-successor');
  assert.ok(f);
  assert.equal(f.severity, 'PASS', JSON.stringify(req));
  assert.equal(f.summary, 'ro-doctor-succ: required successor of ro-doctor-incomplete in progress');
});

test('the legacy-archive check sees a real pre-v10 archived bundle the rollout left alone', () => {
  const fx = makeRolloutFixture({ slug: 'ro-doctor-legacy' });
  // A pre-v10 bundle with no completion field, committed so the rollout's clean-tree check
  // tolerates it (mirrors the rollout-archive test, which commits it before the walk).
  const legacyDir = path.join(fx.MAIN, 'docs', 'masterplan', 'legacy-run');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'state.yml'), 'schema_version: 8\nslug: legacy-run\nstatus: archived\n');
  git(fx.MAIN, 'add', '--', path.join('docs', 'masterplan', 'legacy-run'));
  git(fx.MAIN, 'commit', '-q', '-m', 'a pre-v10 archived bundle');
  walkRollout(fx);
  completeGate(fx);
  archiveLikeFinish(fx, { completion: 'complete' });
  const legacy = legacyArchiveCheck(fx.MAIN);
  const lf = legacy.find((f) => f.summary.startsWith('legacy-run:'));
  assert.ok(lf, JSON.stringify(legacy));
  assert.equal(lf.severity, 'PASS', JSON.stringify(legacy));
});

// ---------------------------------------------------------------------------
// The pre-publish review fix round (2026-09-08): findings 5 + 6 — the bootstrap_pass
// permanent schema, replay-time validation, and the zero-exit failure-with-reason.
// ---------------------------------------------------------------------------

test('finding 5: a hand-appended bootstrap_pass without its schema is refused at appendEvent AND at replay', () => {
  const fx = makeFixture();
  // The reviewer's exact reproduction: appendEvent({type:'bootstrap_pass', pass:999})
  // previously SUCCEEDED (bootstrap_pass had no permanent schema and fell through as an
  // unknown event), then bootstrapStatus reported pass 999 with version:null and next verify —
  // abandoning the prior pass with no version and no corrective trigger. Both halves must now
  // refuse: the append is refused by the schema, and a hand-appended copy (written straight
  // into events.jsonl, bypassing the append gate) is refused by the REPLAY gate.
  assert.throws(
    () => appendEvent(fx.statePath, { type: 'bootstrap_pass', pass: 999 }),
    /appendEvent: invalid bootstrap_pass event: .*must be a non-empty string|appendEvent: invalid bootstrap_pass event:/,
    'the permanent schema refuses the schema-less pass at append time',
  );
  // The hand-append path: the same record written straight into the ledger.
  const raw = { type: 'bootstrap_pass', pass: 999, ts: 123 };
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), `${JSON.stringify(raw)}\n`);
  assert.throws(
    () => bootstrapStatus(fx.statePath),
    /invalid.*bootstrap_pass|bootstrap_pass.*invalid/,
    'the replay-time validation refuses the hand-appended schema-less pass',
  );
});

test('the legacy data-wrapped required_successor is lifted on read — validating, projecting, never rewriting the file', () => {
  // This run's OWN ledger carries one required_successor recorded 2026-09-04 through v9's
  // mp event with the payload under `data` (before any validator existed) — the F5 replay
  // validation surfaced it and refused the whole stage. The canonical writer emits top-level
  // {slug, reason}; the lift normalizes on read at every validating/projecting seam, and the
  // FILE's bytes stay untouched (the durable record is never rewritten). An event with
  // NEITHER shape is not lifted — the refusal stands (a nameless handoff is never honored).
  const fx = makeFixture();
  const ledger = path.join(fx.bundleDir, 'events.jsonl');
  fs.appendFileSync(ledger, `${JSON.stringify({ type: 'required_successor', ts: 't1', data: { slug: 'v10-validation', reason: 'the validation run' } })}\n`);
  const bytesBefore = fs.readFileSync(ledger, 'utf8');
  // All three reading seams lift: the driver's validator (no refusal, pass derivable), the
  // shared lib reader, and the finish-step projection (r.slug readable).
  const st = bootstrapStatus(fx.statePath);
  assert.equal(st.pass, 1, 'the legacy event validates — the stage derives from the ledger');
  const lifted = loadBundleEvents(fx.statePath).find((e) => e.type === 'required_successor');
  assert.equal(lifted.slug, 'v10-validation');
  assert.equal(lifted.reason, 'the validation run');
  assert.equal(
    parseEventArray(fs.readFileSync(ledger, 'utf8')).some((e) => e.type === 'required_successor' && e.slug === 'v10-validation'),
    true, 'the finish-step parser lifts too (the archive guard reads r.slug)',
  );
  assert.equal(fs.readFileSync(ledger, 'utf8'), bytesBefore, 'the file is never rewritten');
  // A nameless handoff is NOT lifted — the validator's refusal stands.
  fs.appendFileSync(ledger, `${JSON.stringify({ type: 'required_successor', ts: 't2', data: { note: 'no slug' } })}\n`);
  assert.throws(() => bootstrapStatus(fx.statePath), /required_successor.*invalid|invalid.*required_successor/,
    'an event with neither shape is refused, never silently honored');
});

test('finding 5: replay refuses an out-of-sequence pass (not exactly highest_pass+1) and a pass with no corrective trigger', () => {
  // A legitimate pass-1 walk through surfaces_live, then the drift probes.
  const fx = makeFixture();
  seedThrough(fx, STEP_ORDER.slice(0, STEP_ORDER.indexOf('gate')));
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 90, verdict: 'rework' });
  const trigger = events(fx.statePath).length - 1;

  // (a) A pass that skips a number (3 when the ledger is at 1) is drift at replay.
  const skipDir = path.dirname(fx.statePath);
  fs.appendFileSync(path.join(skipDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'bootstrap_pass', pass: 3, triggered_by: trigger, version: '10.0.1', ts: 100 })}\n`);
  assert.throws(
    () => bootstrapStatus(fx.statePath),
    /declares pass 3 but the ledger is at pass 1.*next pass must be exactly 2/,
    'an out-of-sequence pass is the named refusal during replay',
  );

  // (b) A pass whose trigger is not a corrective finding is drift at replay.
  const fx2 = makeFixture();
  seedThrough(fx2, STEP_ORDER.slice(0, STEP_ORDER.indexOf('gate')));
  appendEvent(fx2.statePath, { type: 'adversary_review', ts: 90, verdict: 'approve' }); // NOT a blocking finding
  const benign = events(fx2.statePath).length - 1;
  fs.appendFileSync(path.join(fx2.bundleDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'bootstrap_pass', pass: 2, triggered_by: benign, version: '10.0.1', ts: 100 })}\n`);
  assert.throws(
    () => bootstrapStatus(fx2.statePath),
    /not a blocking finding/,
    'a pass opened on a benign event is the named refusal during replay',
  );

  // (c) Pass 1 re-declared: the run starts there implicitly; a re-declaration is drift.
  const fx3 = makeFixture();
  seedThrough(fx3, ['rehearsal', 'docs_normalize']);
  fs.appendFileSync(path.join(fx3.bundleDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'bootstrap_pass', pass: 1, triggered_by: 0, version: '10.0.1', ts: 100 })}\n`);
  assert.throws(
    () => bootstrapStatus(fx3.statePath),
    /pass 1.*cannot be re-declared|declares pass 1 but the ledger is at pass 1/,
    'a re-declared pass 1 is the named refusal during replay',
  );
});

test('finding 5 positive control: a legitimate startPass still writes cleanly and reports the pass', () => {
  const fx = makeFixture();
  seedThrough(fx, STEP_ORDER.slice(0, STEP_ORDER.indexOf('gate')));
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 90, verdict: 'rework' });
  const trigger = events(fx.statePath).length - 1;
  const started = startPass({
    statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.0.1', targets: fx.targets,
  });
  assert.equal(started.pass, 2, 'the legitimate corrective pass writes cleanly through the same schema');
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.pass, 2);
  assert.equal(s.version, '10.0.1', 'the version is bound at open and reported');
  assert.equal(s.next.step, 'verify', 'the corrective pass re-enters at the pre-publish verify');
});

test('finding 6: a zero-exit failed WITH a reason records through the driver and lands on the ledger', () => {
  const fx = makeFixture();
  seedThrough(fx, ['rehearsal', 'docs_normalize']);
  armOk(fx, 'verify');
  // The reviewer's exact reproduction: recordStep({exit:0,status:'failed',reason:'...'})
  // previously passed the driver's own reason check but threw at the permanent schema
  // ('status failed requires a non-zero exit') — no failure receipt landed. Both validators
  // now accept it consistently: the receipt lands as a bootstrap_step with the reason.
  const r = record(fx, 'verify', { exit: 0, status: 'failed', reason: 'the suite printed 2 failures in the summary' });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'the suite printed 2 failures in the summary');
  const evs = events(fx.statePath).filter((e) => e.type === 'bootstrap_step' && e.step === 'verify');
  assert.equal(evs.length, 1, 'the failure receipt landed');
  assert.equal(evs[0].status, 'failed');
  assert.equal(evs[0].exit, 0);
  assert.equal(evs[0].reason, 'the suite printed 2 failures in the summary');
  // And the step now BLOCKS the stage (a failed step stays `next`).
  const s = bootstrapStatus(fx.statePath);
  assert.equal(s.next.step, 'verify');
  assert.equal(s.next.blocked_by, 'failed:verify');
  // ...while a zero-exit failed WITHOUT a reason still refuses in the driver.
  armOk(fx, 'verify'); // re-arm: the failed step is armable again at the same tip
  assert.throws(
    () => record(fx, 'verify', { exit: 0, status: 'failed' }),
    /failed requires a non-zero exit or a reason/,
    'a reasonless zero-exit failure is still the driver\'s refusal',
  );
});
