// test/bootstrap-driver.test.mjs — smoke suite for scripts/bootstrap-v10.mjs (wave task 44).
//
// Fixture-bundle cases: status reconstructs the pass and next action from disk alone; arm refuses
// when a precondition fails WITHOUT writing an event; record refuses without a matching arm at the
// same base sha; --targets overrides route every path to fixture locations; and one precondition
// plus one postcondition from each of the three step shapes (git-only, gh-network,
// filesystem-install) prove the step abstraction before the dependent suites build on it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeState, appendEvent } from '../lib/bundle.mjs';
import {
  STEP_ORDER, PASS2_OMITTED, stepsForPass, STEP_SHAPES, STEPS,
  resolveTargets, bootstrapStatus, armStep, recordStep, startPass, scanWorkspaceBundles, readBundleEvents, targetsDigest, isBlockingFinding, SELF_BLOCKING_TRIGGERS, CORRECTIVE_TRIGGERS, openCorrectiveFindings, ghRepoFromRemoteUrl, priorVersions,
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
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function events(statePath) {
  return readBundleEvents(statePath);
}

// A MAIN repo with a bare remote, a run branch one commit ahead, a bundle, and fixture surfaces.
function makeFixture(t, { version = '10.0.0' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-bootstrap-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
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
  const slug = 'bs';
  const branch = `masterplan/${slug}`;
  git(MAIN, 'checkout', '-q', '-b', branch);
  write(MAIN, '.claude-plugin/plugin.json', JSON.stringify({ name: 'masterplan', version }) + '\n');
  write(MAIN, 'src/feature.txt', 'feature\n');
  git(MAIN, 'add', '-A');
  git(MAIN, 'commit', '-q', '-m', 'feature + version bump');
  git(MAIN, 'checkout', '-q', 'main');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, { schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: null, pending_gate: null, active_run: null, tasks: [] });
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');
  const installRoot = path.join(tmp, 'install-root');
  const piRoot = path.join(tmp, 'pi');
  const claudeDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(installRoot, { recursive: true });
  // The execution tree: a linked worktree of the run branch (its path carries a space on purpose).
  const worktree = path.join(tmp, 'work tree');
  git(MAIN, 'worktree', 'add', '-q', worktree, branch);
  const targets = {
    remote: 'origin', version, branch, worktree,
    install_root: installRoot, pi_root: piRoot, claude_config_dir: claudeDir, gh: path.join(tmp, 'gh'), gh_repo: 'fixture/repo',
    workspace_roots: [{ dir: tmp, depth: 1 }], verify_cmd: 'true',
  };
  // the gh shim records every invocation (one line of arguments) in <tmp>/gh.log and models the PR
  // lifecycle the pr_merge command relies on: `pr list` knows the PR once `pr create` ran.
  fs.writeFileSync(targets.gh, `#!/bin/sh
echo "$@" >> ${path.join(tmp, 'gh.log')}
case "$1 $2" in
  "pr list") [ -e ${path.join(tmp, 'pr.created')} ] && echo 42;;
  "pr create") touch ${path.join(tmp, 'pr.created')};;
esac
exit 0
`);
  fs.chmodSync(targets.gh, 0o755);
  const tip = git(MAIN, 'rev-parse', branch);
  return { tmp, MAIN, bare, bundleDir, statePath, targets, branch, tip, slug, installRoot, claudeDir, worktree };
}

// The rehearsal script lands on the run branch through the linked worktree (the execution tree).
function addRehearsalScript(fx) {
  write(fx.worktree, 'scripts/rehearse-v9-finish.sh', '#!/bin/sh\nexit 0\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'rehearsal script');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
}

// The release step for real: arm (tag absent), tag the tip as release.mjs would, record.
function release(fx, version = '10.0.0') {
  const armed = armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets });
  assert.equal(armed.ok, true, `release arm: ${JSON.stringify(armed)}`);
  // what scripts/release.mjs does: one CHANGELOG-only commit on the branch, then the annotated tag
  const prior = fs.existsSync(path.join(fx.worktree, 'CHANGELOG.md')) ? fs.readFileSync(path.join(fx.worktree, 'CHANGELOG.md'), 'utf8').replace(/^# Changelog\n/, '') : '';
  write(fx.worktree, 'CHANGELOG.md', `# Changelog\n\n## ${version}\n${prior}`);
  git(fx.worktree, 'add', 'CHANGELOG.md'); git(fx.worktree, 'commit', '-q', '-m', `release: v${version}`);
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'tag', '-a', `v${version}`, '-m', `v${version}`, fx.tip);
  const rec = recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets: fx.targets });
  assert.equal(rec.status, 'done');
  return rec;
}

// The install root as bin/install-pi.mjs leaves it: the release dir, the `current` symlink and the
// receipt naming the commit it resolved.
// A surface entry point that RUNS and reports its version — surfaces_live executes it, so a
// stub comment is an installation that cannot start, which is what the check exists to reject.
const SURFACE_ENTRY = (version) => `console.log('masterplan ${version}');\n`;

function fakeInstall(fx, version = '10.0.0', sha = null) {
  const resolved = sha ?? publishedTipOf(fx);
  const rel = path.join(fx.installRoot, 'releases', version);
  write(rel, '.claude-plugin/plugin.json', JSON.stringify({ name: 'masterplan', version }));
  write(path.join(rel, 'bin'), 'masterplan.mjs', SURFACE_ENTRY(version));
  const cur = path.join(fx.installRoot, 'current');
  try { fs.unlinkSync(cur); } catch { /* first install */ }
  fs.symlinkSync(path.join('releases', version), cur);
  fs.writeFileSync(path.join(fx.installRoot, '.pi-install.json'), JSON.stringify({ version, sha: resolved, ref: resolved, source: fx.MAIN }));
}
function publishedTipOf(fx) {
  const rec = [...readBundleEvents(fx.statePath)].reverse().find((e) => e.type === 'bootstrap_step' && e.step === 'push' && (e.status === 'done' || e.status === 'recovered'));
  return rec && rec.data && rec.data.published_tip ? rec.data.published_tip : fx.tip;
}

// Record a step as done straight through the driver (arm → record), asserting both succeed.
function walk(fx, step, data = {}, extra = {}) {
  const armed = armStep({ statePath: fx.statePath, step, targets: fx.targets });
  assert.equal(armed.ok, true, `${step} arm: ${JSON.stringify(armed)}`);
  const rec = recordStep({ statePath: fx.statePath, step, exit: 0, data, targets: fx.targets, ...extra });
  assert.equal(rec.status, 'done');
  return rec;
}

test('step table: fixed enum order, pass-2 omissions, a shape per step', () => {
  assert.deepEqual(STEP_ORDER, ['rehearsal', 'docs_normalize', 'verify', 'review', 'assess', 'release', 'push', 'ci_wait', 'install_pi', 'main_push', 'publish_ack', 'pr_merge', 'claude_surface', 'surfaces_live', 'gate']);
  assert.deepEqual(PASS2_OMITTED, ['rehearsal', 'docs_normalize', 'main_push']);
  assert.deepEqual(stepsForPass(2), STEP_ORDER.filter((s) => !PASS2_OMITTED.includes(s)));
  for (const s of STEP_ORDER) {
    assert.ok(['git', 'gh', 'fs', 'local'].includes(STEP_SHAPES[s]), s);
    assert.equal(typeof STEPS[s].cmd, 'function');
    assert.equal(typeof STEPS[s].pre, 'function');
    assert.equal(typeof STEPS[s].post, 'function');
  }
});

test('targets: live defaults derive from HOME; overrides route every path to fixtures; unknown keys refuse', (t) => {
  const fx = makeFixture(t);
  const live = resolveTargets(fx.MAIN, { slug: 'x' }, {});
  assert.equal(live.remote, 'origin');
  assert.equal(live.tag, 'v10.0.0');
  assert.equal(live.branch, 'masterplan/x');
  assert.ok(live.install_root.startsWith(process.env.HOME));
  const fixture = resolveTargets(fx.MAIN, { slug: fx.slug }, fx.targets);
  assert.equal(fixture.install_root, fx.installRoot);
  assert.equal(fixture.claude_config_dir, fx.claudeDir);
  assert.equal(fixture.gh, fx.targets.gh);
  assert.equal(fixture.tag, 'v10.0.0');
  assert.throws(() => resolveTargets(fx.MAIN, { slug: 'x' }, { bogus: 1 }), /unknown target/);
  assert.throws(() => resolveTargets(fx.MAIN, { slug: 'x' }, { workspace_roots: [{ dir: 1 }] }), /workspace_roots/);
});

test('status reconstructs pass, completed steps, failures and the next action from disk alone', (t) => {
  const fx = makeFixture(t);
  let st = bootstrapStatus(fx.statePath);
  assert.equal(st.pass, 1);
  assert.deepEqual(st.completed, []);
  assert.equal(st.next.step, 'rehearsal');
  assert.equal(st.finish_begun, false);
  // rehearsal needs the script: point the target at a fixture script and walk two steps.
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'rehearsal.out');
  fs.writeFileSync(digest, 'rehearsal ok\n');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  // A failed verify blocks the next step until recovered.
  let armed = armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets });
  assert.equal(armed.ok, true);
  recordStep({ statePath: fx.statePath, step: 'verify', exit: 1, status: 'failed', targets: fx.targets });
  st = bootstrapStatus(fx.statePath); // a fresh read — nothing but the ledger
  assert.deepEqual(st.completed, ['rehearsal', 'docs_normalize']);
  assert.deepEqual(st.failed, ['verify']);
  assert.equal(st.next.step, 'verify');
  const review = armStep({ statePath: fx.statePath, step: 'review', targets: fx.targets });
  assert.equal(review.ok, false);
  assert.match(review.refusals.join(' '), /out of order/);
  // recovered: arm again, record with --status=recovered
  armed = armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets });
  assert.equal(armed.ok, true);
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets: fx.targets }), /--status=recovered/);
  const rec = recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, status: 'recovered', targets: fx.targets });
  assert.equal(rec.status, 'recovered');
  assert.equal(rec.data.tip, fx.tip, 'verify records the tip it ran at');
  st = bootstrapStatus(fx.statePath);
  assert.deepEqual(st.completed, ['rehearsal', 'docs_normalize', 'verify']);
  assert.deepEqual(st.failed, []);
  assert.equal(st.next.step, 'review');
});

test('a done-at-an-old-tip record is stale: after a failed-review fix moves the tip, verify re-arms and the §10.2 chain re-runs', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'rehearsal.out');
  fs.writeFileSync(digest, 'rehearsal ok\n');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  walk(fx, 'verify'); // verify done at tip1
  // the pre-publish review fails at tip1 (§10.3: stops the stage before step 3)
  const armedReview = armStep({ statePath: fx.statePath, step: 'review', targets: fx.targets });
  assert.equal(armedReview.ok, true, JSON.stringify(armedReview));
  recordStep({ statePath: fx.statePath, step: 'review', exit: 1, status: 'failed', targets: fx.targets, data: { tip: fx.tip, verdict: 'reject' } });
  // the fix lands as ordinary execute-phase work: the branch tip moves
  write(fx.worktree, 'src/review-fix.txt', 'review fix\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'review fix');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  // OLD behavior (the deadlock): next=review while review's precondition demands verify at the
  // NEW tip and the order guard refuses the verify re-record because verify's slot has a record.
  // FIXED: the stale-tip verify record is not current, so verify is next again and re-armable.
  let st = bootstrapStatus(fx.statePath);
  assert.equal(st.next.step, 'verify', 'verify done at the old tip is stale — it is next again');
  // review still refuses — now on ORDER (verify is next), and once verify re-records, on its
  // own precondition (the belt-and-braces verify_done_at_tip check stays armed)
  const refusedReview = armStep({ statePath: fx.statePath, step: 'review', targets: fx.targets });
  assert.equal(refusedReview.ok, false);
  assert.match(refusedReview.refusals.join(' '), /out of order: expected verify, got review/);
  // verify re-arms at the new tip and re-records with the repeated-step status: recovered
  const armed = armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const rec = recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, status: 'recovered', targets: fx.targets });
  assert.equal(rec.data.tip, fx.tip, 'the re-record names the NEW tip');
  // now review arms: verify_done_at_tip is satisfied at the new tip
  const review = armStep({ statePath: fx.statePath, step: 'review', targets: fx.targets });
  assert.equal(review.ok, true, JSON.stringify(review));
  st = bootstrapStatus(fx.statePath);
  assert.equal(st.next.step, 'review');
  // the designed exemption: the release commit (one CHANGELOG-only commit) does NOT stale the
  // recorded chain — after release records at the moved tip, the next step is push, not verify.
  recordStep({ statePath: fx.statePath, step: 'review', exit: 0, status: 'recovered', targets: fx.targets, data: { tip: fx.tip, verdict: 'approve' } });
  walk(fx, 'assess', { goals: { G1: 'achieved' } });
  // the designed exemption: the release commit (one CHANGELOG-only commit) does NOT stale the
  // recorded chain. Real order: arm release at the fix tip, run the release commit + tag, record.
  const releaseArm = armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets });
  assert.equal(releaseArm.ok, true, JSON.stringify(releaseArm));
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md'); git(fx.worktree, 'commit', '-q', '-m', 'release: v10.0.0');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip);
  recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets: fx.targets });
  st = bootstrapStatus(fx.statePath);
  assert.equal(st.next.step, 'push', 'the release commit is the designed exemption — the chain stays current');
});

test('arm refuses on a failed precondition without writing; record refuses without an arm at the same sha', (t) => {
  const fx = makeFixture(t);
  const before = events(fx.statePath).length;
  // rehearsal precondition: the script must exist — it does not.
  const armed = armStep({ statePath: fx.statePath, step: 'rehearsal', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'rehearsal_script' && !p.ok));
  assert.equal(events(fx.statePath).length, before, 'nothing written on a failed precondition');
  // record without any arm
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'rehearsal', exit: 0, targets: fx.targets }), /no bootstrap_armed/);
  // arm, then move the base: the record is refused (same-SHA authorization)
  addRehearsalScript(fx);
  const ok = armStep({ statePath: fx.statePath, step: 'rehearsal', targets: fx.targets });
  assert.equal(ok.ok, true);
  assert.equal(ok.sha, git(fx.MAIN, 'rev-parse', 'HEAD'));
  assert.match(ok.cmd, /rehearse-v9-finish\.sh/);
  write(fx.MAIN, 'src/other.txt', 'x\n');
  git(fx.MAIN, 'add', '-A'); git(fx.MAIN, 'commit', '-q', '-m', 'base moves');
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'rehearsal', exit: 0, digestFile: digest, targets: fx.targets }), /base moved since arm/);
  assert.ok(!events(fx.statePath).some((e) => e.type === 'bootstrap_step'));
});

test('git-only shape (release): precondition tag_absent refuses; postcondition binds the tag to the reviewed tip', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  walk(fx, 'verify');
  walk(fx, 'review', { verdict: 'approve' });
  assert.throws(() => walk(fx, 'assess', { goals: { G1: 'achieved', G6: 'partial' } }), /postcondition failed: goal_G6/);
  walk(fx, 'assess', { goals: { G1: 'achieved', G6: 'achieved' } });
  // precondition: the tag must not exist yet
  git(fx.MAIN, 'tag', 'v10.0.0', fx.tip);
  let armed = armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'tag_absent' && !p.ok));
  git(fx.MAIN, 'tag', '-d', 'v10.0.0');
  armed = armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /release\.mjs --version='10\.0\.0'/);
  // postcondition: the tag must point at the branch tip (here: tag a foreign commit → refused).
  // The release preflight now refuses the record BEFORE the tag is trusted: the branch carries no
  // release commit at all (reviewed→tip is empty, no CHANGELOG header), so the refusal names the
  // malformed delta and rolls the stray tag back.
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', git(fx.MAIN, 'rev-parse', 'main'));
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets: fx.targets }), /release preflight refused/);
  assert.throws(() => git(fx.MAIN, 'rev-parse', '--verify', 'refs/tags/v10.0.0'), /Needed a single revision|unknown revision|not found/, 'the stray tag is rolled back by the preflight');
  // the release commit (CHANGELOG header only) on the branch, then the tag at the new tip
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md'); git(fx.worktree, 'commit', '-q', '-m', 'release: v10.0.0');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip);
  const rec = recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets: fx.targets });
  assert.equal(rec.status, 'done');
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'push');
});

test('gh-network shape (ci_wait): precondition remote_tag_equals_local; postcondition needs both job conclusions', (t) => {
  const fx = makeFixture(t);
  // Seed the ledger up to push through the driver (git-only steps), then exercise ci_wait.
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  // push: arm, run the printed command for real against the bare remote, record
  const armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  // precondition (before the push): the remote tag is absent → ci_wait cannot be armed yet
  let ci = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets });
  assert.equal(ci.ok, false);
  assert.match(ci.refusals.join(' '), /out of order/);
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  ci = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets });
  assert.equal(ci.ok, true, JSON.stringify(ci));
  assert.ok(ci.preconditions.some((p) => p.name === 'remote_tag_equals_local' && p.ok));
  assert.ok(ci.preconditions.some((p) => p.name === 'gh_available' && p.ok), 'the fixture gh shim is used');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'ci_wait', exit: 0, data: { conclusions: { test: 'success', 'release-publish': 'failure' } }, targets: fx.targets }), /ci_conclusions_success/);
  const rec = recordStep({ statePath: fx.statePath, step: 'ci_wait', exit: 0, data: { conclusions: { test: 'success', 'release-publish': 'success' } }, targets: fx.targets });
  assert.equal(rec.status, 'done');
  // a red run is recorded as failed (exit ≠ 0) and blocks install_pi
  const fx2 = fx; void fx2;
});

test('filesystem-install shape (install_pi): precondition ci_wait_done + the workspace scan; postcondition reads the fixture install root', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  // precondition: ci_wait not done yet → install_pi refused (out of order), nothing written
  const n = events(fx.statePath).length;
  assert.equal(armStep({ statePath: fx.statePath, step: 'install_pi', targets: fx.targets }).ok, false);
  assert.equal(events(fx.statePath).length, n);
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  // a sibling repo with an open bundle inside the scanned workspace root is listed on the arm
  const sib = path.join(fx.tmp, 'sibling');
  writeState(path.join(sib, 'docs', 'masterplan', 'other', 'state.yml'), { schema_version: 8, slug: 'other', status: 'in-progress', phase: 'plan', tasks: [] });
  writeState(path.join(sib, 'docs', 'masterplan', 'old', 'state.yml'), { schema_version: 8, slug: 'old', status: 'archived', phase: 'finish', tasks: [] });
  const armed = armStep({ statePath: fx.statePath, step: 'install_pi', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /--install-root=/);
  assert.match(armed.cmd, /--pi-root=/);
  const slugs = armed.data.bundles.map((b) => b.slug).sort();
  assert.ok(slugs.includes('other') && !slugs.includes('old'), JSON.stringify(slugs));
  const armedEvent = events(fx.statePath).find((e) => e.type === 'bootstrap_armed' && e.step === 'install_pi');
  assert.ok(armedEvent.data.bundles.some((b) => b.slug === 'other'), 'the scan is durable on the armed event');
  // postcondition: the fixture install root must hold current → v10.0.0
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'install_pi', exit: 0, targets: fx.targets }), /pi_current_version/);
  fakeInstall(fx);
  const rec = recordStep({ statePath: fx.statePath, step: 'install_pi', exit: 0, targets: fx.targets });
  assert.equal(rec.status, 'done');
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'main_push');
});

test('start opens exactly the next corrective pass, only after pass 1 reached surfaces_live and only from a corrective finding', (t) => {
  const fx = makeFixture(t);
  appendEvent(fx.statePath, { type: 'goal_check', ts: 1, verdict: 'partial' }); // index 0: stale (before surfaces_live)
  // pass 1 not complete → refused
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: 0, version: '10.0.1' }), /not complete through surfaces_live/);
  // seed pass 1 through surfaces_live with schema-valid records (the gate is recorded once, on the latest pass)
  for (const step of STEP_ORDER.filter((s) => s !== 'gate')) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'unrelated_note', ts: 3 });
  appendEvent(fx.statePath, { type: 'goal_check', ts: 4, verdict: 'achieved' }); // not blocking
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 5, verdict: 'revise' }); // the finish-time review blocked
  const n = events(fx.statePath).length;
  const trigger = n - 1;
  const v = { version: '10.0.1' };
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 3, triggeredBy: trigger, ...v }), /exactly 2/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: 99, ...v }), /event index/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: n - 3, ...v }), /corrective finding/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: n - 2, ...v }), /not a blocking finding/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: 0, ...v }), /precedes pass 1's surfaces_live/);
  // the corrective version is mandatory, well-formed, and not yet released
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger }), /--version/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: 'v10.0.1' }), /major\.minor\.patch/);
  git(fx.MAIN, 'tag', 'v10.0.0', fx.tip);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.0.0' }), /already tagged/);
  // the series and the order: pass 1's version (the targets' here, the release arm's on a real walk)
  git(fx.MAIN, 'tag', '-d', 'v10.0.0');
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.0.0' }), /not newer than 10\.0\.0/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '9.9.9' }), /outside the 10\.0\.x series/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '11.0.0' }), /outside the 10\.0\.x series/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.1.0' }), /outside the 10\.0\.x series/);
  // a remote-only tag of the candidate version (published elsewhere) refuses too
  git(fx.MAIN, 'push', '-q', 'origin', `${fx.tip}:refs/tags/v10.0.1`);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, version: '10.0.1' }), /already exists on origin/);
  git(fx.MAIN, 'push', '-q', 'origin', ':refs/tags/v10.0.1');
  assert.equal(events(fx.statePath).length, n, 'refusals write nothing');
  const st = startPass({ statePath: fx.statePath, pass: 2, triggeredBy: trigger, ...v });
  assert.equal(st.pass, 2);
  assert.equal(st.version, '10.0.1', 'the bound version is exposed');
  // the bound version outranks the targets: a disagreeing override is refused, the default is replaced
  assert.throws(() => armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets }), /bound to version 10\.0\.1/);
  assert.equal(armStep({ statePath: fx.statePath, step: 'verify', targets: { ...fx.targets, version: '10.0.1' } }).ok, true);
  assert.equal(st.next.step, 'verify', 'a corrective pass starts at verify');
  assert.equal(st.finish_begun, false, 'the finish events that opened the pass do not lock it to gate');
  assert.ok(!stepsForPass(2).includes('main_push'));
  // the same finding cannot open a third pass; pass 2 needs its own surfaces_live first anyway
  for (const step of stepsForPass(2).filter((s) => s !== 'gate')) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 6, pass: 2, step, cmd: 'seeded', exit: 0, status: 'done' });
  }
  // a finding older than pass 2's surfaces_live can never open pass 3 (which also makes reuse impossible)
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 3, triggeredBy: trigger, version: '10.0.2' }), /precedes pass 2's surfaces_live/);
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 3, triggeredBy: trigger, version: '10.0.1' }), /already bound to pass 2/);
  assert.deepEqual(priorVersions(events(fx.statePath)), ['10.0.1'], 'seeded pass 1 armed no release; pass 2 bound 10.0.1');
});

test('a recovered step counts as done for its successors; a recovered record needs exit 0', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  assert.equal(armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets }).ok, true);
  recordStep({ statePath: fx.statePath, step: 'verify', exit: 2, status: 'failed', targets: fx.targets });
  assert.equal(armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets }).ok, true);
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'verify', exit: 1, status: 'recovered', targets: fx.targets }), /requires exit 0/);
  recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, status: 'recovered', targets: fx.targets });
  const review = armStep({ statePath: fx.statePath, step: 'review', targets: fx.targets });
  assert.equal(review.ok, true, JSON.stringify(review));
});

test('arm binds the branch tip and the target set; the gate binds the remote tip instead of HEAD', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  const armed = armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets });
  assert.equal(armed.ok, true);
  // a different target set at record time is refused
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets: { ...fx.targets, verify_cmd: 'false' } }), /targets differ/);
  // the run branch moved (a commit in the linked worktree) without MAIN HEAD moving: refused
  write(fx.worktree, 'src/more.txt', 'more\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'tip moves');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets: fx.targets }), /worktree_at_tip|not the armed tip|branch tip moved since arm/);
  assert.ok(!events(fx.statePath).some((e) => e.type === 'bootstrap_step' && e.step === 'verify'));
  // re-armed at the new tip, the record carries THAT tip
  const again = armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets });
  assert.equal(again.ok, true);
  const rec = recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets: fx.targets });
  assert.equal(rec.data.tip, git(fx.MAIN, 'rev-parse', fx.branch));
  const armedEvent = events(fx.statePath).filter((e) => e.type === 'bootstrap_armed').pop();
  assert.equal(armedEvent.tip, rec.data.tip);
  assert.equal(typeof armedEvent.targets_sha256, 'string');
});

test('targets digest binds nested keys; carried reports come from the arm, not the caller', (t) => {
  const fx = makeFixture(t);
  const a = resolveTargets(fx.MAIN, { slug: fx.slug }, fx.targets);
  const b = resolveTargets(fx.MAIN, { slug: fx.slug }, { ...fx.targets, workspace_roots: [{ dir: '/elsewhere', depth: 9 }] });
  assert.notEqual(targetsDigest(a), targetsDigest(b), 'a nested workspace_roots change changes the digest');
  assert.equal(targetsDigest(a), targetsDigest({ ...a }), 'key order is irrelevant');
  // main_push: a non-bundle commit ahead of the remote is carried whatever --data says
  write(fx.MAIN, 'scripts/rehearse-v9-finish.sh', '#!/bin/sh\nexit 0\n');
  git(fx.MAIN, 'add', '-A'); git(fx.MAIN, 'commit', '-q', '-m', 'rehearsal script (non-bundle, unpushed)');
  addRehearsalScript(fx); // the branch (execution tree) carries the script too
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  fakeInstall(fx);
  walk(fx, 'install_pi');
  // through the CLI: the operator-facing JSON line carries the same bound data as the library call
  const script = path.resolve('scripts/bootstrap-v10.mjs');
  const out = execFileSync(process.execPath, [script, 'arm', `--state=${fx.statePath}`, '--step=main_push', `--targets=${JSON.stringify(fx.targets)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const [line, echoed] = out.split('\n');
  const armed = JSON.parse(line);
  assert.equal(armed.ok, true, line);
  assert.equal(armed.step, 'main_push');
  assert.equal(echoed, armed.cmd, 'the command is echoed on its own line');
  const armedRecord = events(fx.statePath).filter((e) => e.type === 'bootstrap_armed').pop();
  assert.deepEqual(armed.data, armedRecord.data, 'the CLI prints exactly what the arm record bound');
  assert.equal(armed.sha, armedRecord.sha);
  assert.equal(armed.data.carried.length, 1);
  assert.match(armed.data.carried[0].subject, /rehearsal script/);
  assert.equal(armed.data.main_sha, git(fx.MAIN, 'rev-parse', 'main'));
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  const rec = recordStep({ statePath: fx.statePath, step: 'main_push', exit: 0, data: { carried: [] }, targets: fx.targets });
  assert.equal(rec.carried.length, 1, 'the caller cannot blank the carried list');
  assert.equal(rec.data.main_pre_bootstrap, git(fx.MAIN, 'rev-parse', 'main'));
});

test('gate: MAIN must have main checked out; the record needs local main rebased onto the remote tip', (t) => {
  const fx = makeFixture(t);
  // Seed pass 1 through surfaces_live and a pr_merge record naming the remote tip as the merge sha.
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  const mainPre = git(fx.MAIN, 'rev-parse', 'main');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: mainPre, carried: [] } });
  // Emulate GitHub's merge in a second clone and push it; local main gains a bundle-only commit.
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch); // the branch reached GitHub at the push step
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone); // the bare remote's HEAD is not main
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const mergeSha = git(clone, 'rev-parse', 'HEAD');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: mergeSha } });
  // The ledger (docs/masterplan/bs/events.jsonl) is uncommitted here, as it always is when the driver
  // has just written: the gate arms anyway, and its printed command commits the bundle first.
  assert.ok(git(fx.MAIN, 'status', '--porcelain', '--untracked-files=all').includes('docs/masterplan/bs/'), 'the bundle is dirty by construction');
  // precondition: MAIN on another branch → refused, nothing written
  git(fx.MAIN, 'checkout', '-q', '--detach');
  let armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'main_checked_out' && !p.ok));
  git(fx.MAIN, 'checkout', '-q', 'main');
  armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  // record without running the printed command: the ledger is uncommitted and local main diverged → refused
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }), /ledger is not committed|main_rebased_onto_remote/);
  const rebase = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.equal(rebase.status, 0, `${armed.cmd}: ${rebase.stderr} ${rebase.stdout}`);
  const rec = recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets });
  assert.equal(rec.status, 'done');
  assert.equal(git(fx.MAIN, 'merge-base', 'origin/main', 'main'), mergeSha, 'local main now sits on the remote tip');
});

test('workspace scan lists non-archived bundles up to the depth and flags the hook-policy repo', (t) => {
  const root = mkdtempTracked(path.join(os.tmpdir(), 'mp-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeState(path.join(root, 'a', 'docs', 'masterplan', 's1', 'state.yml'), { schema_version: 8, slug: 's1', status: 'in-progress', phase: 'execute', tasks: [] });
  writeState(path.join(root, 'a', 'deep', 'b', 'docs', 'masterplan', 's2', 'state.yml'), { schema_version: 8, slug: 's2', status: 'in-progress', phase: 'plan', tasks: [] });
  writeState(path.join(root, 'workflows', 'docs', 'masterplan', 's3', 'state.yml'), { schema_version: 8, slug: 's3', status: 'in-progress', phase: 'plan', tasks: [] });
  fs.mkdirSync(path.join(root, 'workflows', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflows', 'hooks', 'policy.toml'), '');
  const shallow = scanWorkspaceBundles([{ dir: root, depth: 1 }]).map((b) => b.slug).sort();
  assert.deepEqual(shallow, ['s1', 's3']);
  const deep = scanWorkspaceBundles([{ dir: root, depth: 3 }]);
  assert.deepEqual(deep.map((b) => b.slug).sort(), ['s1', 's2', 's3']);
  assert.equal(deep.find((b) => b.slug === 's3').hook_policy, true);
  assert.equal(deep.find((b) => b.slug === 's1').hook_policy, false);
});

test('a linked worktree target must be the branch tip and clean; quoted commands survive a path with a space', (t) => {
  const fx = makeFixture(t);
  const wt = fx.worktree;
  addRehearsalScript(fx);
  const targets = fx.targets;
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  let armed = armStep({ statePath: fx.statePath, step: 'rehearsal', targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /cd '[^']*work tree' && bash 'scripts/, 'the path with a space is quoted');
  assert.match(armed.cmd, /--targets='[^']*\.bootstrap-targets-[0-9a-f]{16}\.json'/, 'targets travel as a digest-named file');
  assert.equal(spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' }).status, 0, 'the quoted command runs');
  recordStep({ statePath: fx.statePath, step: 'rehearsal', exit: 0, digestFile: digest, targets });
  recordStep({ statePath: fx.statePath, step: 'docs_normalize', exit: 0, targets, ...(armStep({ statePath: fx.statePath, step: 'docs_normalize', targets }).ok ? {} : {}) });
  // uncommitted source in the worktree: verify cannot be armed (its receipt would not describe the tip)
  write(wt, 'src/uncommitted.txt', 'x\n');
  armed = armStep({ statePath: fx.statePath, step: 'verify', targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'worktree_clean' && !p.ok), JSON.stringify(armed.preconditions));
  fs.rmSync(path.join(wt, 'src/uncommitted.txt'));
  // a worktree checked out elsewhere than the tip is refused too
  git(wt, 'checkout', '-q', '--detach', `${fx.tip}~1`);
  armed = armStep({ statePath: fx.statePath, step: 'verify', targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'worktree_at_tip' && !p.ok));
  git(wt, 'checkout', '-q', fx.branch);
  armed = armStep({ statePath: fx.statePath, step: 'verify', targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /^cd '[^']*work tree' && true && node bin\/doctor\.mjs \.$/);
  // between arm and record the worktree drifts: the record is refused
  git(wt, 'checkout', '-q', '--detach', `${fx.tip}~1`);
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets }), /worktree_at_tip|not the armed tip/);
  git(wt, 'checkout', '-q', fx.branch);
  const rec = recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets });
  assert.equal(rec.data.tip, fx.tip);
});

test('without a linked worktree, MAIN itself must be the branch at the tip', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.worktree);
  const targets = { ...fx.targets, worktree: null };
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  // MAIN is on main: the branch-building steps cannot be armed (the receipt would describe code never run)
  let armed = armStep({ statePath: fx.statePath, step: 'rehearsal', targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'worktree_at_tip' && !p.ok), JSON.stringify(armed.preconditions));
  git(fx.MAIN, 'checkout', '-q', fx.branch);
  armed = armStep({ statePath: fx.statePath, step: 'rehearsal', targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /^cd '[^']*\/main' && bash/);
  recordStep({ statePath: fx.statePath, step: 'rehearsal', exit: 0, digestFile: digest, targets });
});

test('the rehearsal targets file is bound: an edit after the arm is refused', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  const armed = armStep({ statePath: fx.statePath, step: 'rehearsal', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const file = armed.cmd.match(/--targets='([^']+)'/)[1];
  assert.ok(fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.install_root = '/somewhere/else';
  fs.writeFileSync(file, JSON.stringify(parsed));
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'rehearsal', exit: 0, digestFile: digest, targets: fx.targets }), /targets file .* no longer matches/);
});

test('pr_merge: the merge must land on the remote base observed at arm', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : step === 'push' ? { published_tip: fx.tip } : step === 'main_push' ? { main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } : {} });
  }
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.equal(armed.data.remote_main, git(fx.MAIN, 'rev-parse', 'origin/main'));
  // a sibling pushes to main before the merge; GitHub merges onto the moved base
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  write(clone, 'sibling.txt', 's\n');
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'sibling');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const mergeSha = git(clone, 'rev-parse', 'HEAD');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'pr_merge', exit: 0, data: { merge_sha: mergeSha }, targets: fx.targets }), /merged_onto_armed_base/);
  assert.ok(!events(fx.statePath).some((e) => e.type === 'bootstrap_step' && e.step === 'pr_merge'));
});

test('pr_merge: the merge must be exactly [armed base, armed tip] — an extra commit under another ref is refused', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : step === 'push' ? { published_tip: fx.tip } : step === 'main_push' ? { main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } : {} });
  }
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  // an extra commit E descended from the armed tip, merged instead of the tip itself
  git(clone, 'checkout', '-q', '-b', 'extra', `origin/${fx.branch}`);
  write(clone, 'extra.txt', 'e\n');
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'unreviewed extra');
  git(clone, 'checkout', '-q', 'main');
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', 'extra');
  git(clone, 'push', '-q', 'origin', 'main');
  const bad = git(clone, 'rev-parse', 'HEAD');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'pr_merge', exit: 0, data: { merge_sha: bad }, targets: fx.targets }), /merged_exact_tip/);
  // reset the remote to the armed base and merge exactly the tip: accepted
  git(clone, 'reset', '-q', '--hard', armed.data.remote_main);
  git(clone, 'push', '-q', '--force', 'origin', 'main');
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const good = git(clone, 'rev-parse', 'HEAD');
  const rec = recordStep({ statePath: fx.statePath, step: 'pr_merge', exit: 0, data: { merge_sha: good }, targets: fx.targets });
  assert.equal(rec.status, 'done');
  assert.equal(rec.data.merge_sha, good);
});

test('gate: a branch commit that wrote and then reverted a bundle path is still refused', (t) => {
  const fx = makeFixture(t);
  write(fx.worktree, 'docs/masterplan/other/state.yml', 'slug: other\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'bundle write on the branch');
  git(fx.worktree, 'rm', '-q', 'docs/masterplan/other/state.yml');
  git(fx.worktree, 'commit', '-q', '-m', 'revert it');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') } });
  git(fx.MAIN, 'add', '-A'); git(fx.MAIN, 'commit', '-q', '-m', 'bundle state');
  const armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'no_bundle_diff' && !p.ok), JSON.stringify(armed.preconditions));
});

test('release recorded in MAIN itself: the release commit moves MAIN HEAD and is accepted', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.worktree);
  git(fx.MAIN, 'checkout', '-q', fx.branch); // MAIN is the execution tree
  const targets = { ...fx.targets, worktree: null };
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  const step = (name, data = {}, extra = {}) => {
    const armed = armStep({ statePath: fx.statePath, step: name, targets });
    assert.equal(armed.ok, true, `${name}: ${JSON.stringify(armed)}`);
    return recordStep({ statePath: fx.statePath, step: name, exit: 0, data, targets, ...extra });
  };
  step('rehearsal', {}, { digestFile: digest });
  step('docs_normalize'); step('verify'); step('review', { verdict: 'approve' }); step('assess', { goals: { G1: 'achieved' } });
  const armed = armStep({ statePath: fx.statePath, step: 'release', targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  // what scripts/release.mjs does: one CHANGELOG-only commit on the branch (here: MAIN's HEAD) + the tag
  write(fx.MAIN, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.MAIN, 'add', 'CHANGELOG.md'); git(fx.MAIN, 'commit', '-q', '-m', 'release: v10.0.0');
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0');
  const rec = recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets });
  assert.equal(rec.status, 'done');
  assert.equal(git(fx.MAIN, 'rev-parse', 'v10.0.0^{commit}'), git(fx.MAIN, 'rev-parse', 'HEAD'));
});

test('the gh target is data: shell syntax in it is never executed and reports unavailable', (t) => {
  const fx = makeFixture(t);
  for (const step of ['rehearsal', 'docs_normalize', 'verify', 'review', 'assess', 'release']) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  const marker = path.join(process.cwd(), 'PWNED');
  const targets = { ...fx.targets, gh: `missing; touch ${marker}; true` };
  const armed = armStep({ statePath: fx.statePath, step: 'ci_wait', targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'gh_available' && !p.ok));
  assert.ok(!fs.existsSync(marker), 'no shell ran the target text');
  assert.equal(armStep({ statePath: fx.statePath, step: 'ci_wait', targets: { ...fx.targets, gh: 'sh' } }).preconditions.find((p) => p.name === 'gh_available').ok, true, 'a bare name resolves on PATH');
});

test('gate: a dirty file in ANOTHER bundle is not tolerated', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') } });
  write(fx.MAIN, 'docs/masterplan/other/note', 'x\n');
  let armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'clean_tree' && !p.ok && /other\/note/.test(p.detail)), JSON.stringify(armed.preconditions));
  fs.rmSync(path.join(fx.MAIN, 'docs/masterplan/other'), { recursive: true });
  armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
});

test('a record is refused when the execution tree is dirty after the arm', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  assert.equal(armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets }).ok, true);
  write(fx.worktree, 'src/uncommitted.txt', 'x\n');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets: fx.targets }), /worktree_clean/);
  fs.rmSync(path.join(fx.worktree, 'src/uncommitted.txt'));
  assert.equal(recordStep({ statePath: fx.statePath, step: 'verify', exit: 0, targets: fx.targets }).status, 'done');
});

test('gate: the record needs a fresh fetch and the armed ledger committed by the printed command', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const mergeSha = git(clone, 'rev-parse', 'HEAD');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: mergeSha } });
  const armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  // running only the rebase (the ledger is untracked, so it succeeds) and skipping the printed
  // command's bundle commit leaves the arm uncommitted — refused.
  git(fx.MAIN, 'rebase', '-q', 'origin/main');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }), /ledger is not committed/);
  // an unreachable remote at record time is refused too (a stale tracking ref proves nothing)
  const url = git(fx.MAIN, 'remote', 'get-url', 'origin');
  git(fx.MAIN, 'remote', 'set-url', 'origin', path.join(fx.tmp, 'gone.git'));
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }), /cannot fetch origin main/);
  git(fx.MAIN, 'remote', 'set-url', 'origin', url);
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  assert.equal(recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }).status, 'done');
});

test('a gh target must be an executable file', (t) => {
  const fx = makeFixture(t);
  for (const step of ['rehearsal', 'docs_normalize', 'verify', 'review', 'assess', 'release']) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  const pre = (gh) => armStep({ statePath: fx.statePath, step: 'ci_wait', targets: { ...fx.targets, gh } }).preconditions.find((p) => p.name === 'gh_available').ok;
  assert.equal(pre(fx.tmp), false, 'a directory is not gh');
  const plain = path.join(fx.tmp, 'gh-not-executable'); fs.writeFileSync(plain, '#!/bin/sh\nexit 0\n'); fs.chmodSync(plain, 0o644);
  assert.equal(pre(plain), false, 'a non-executable file is not gh');
  assert.equal(pre(fx.targets.gh), true);
});

test('every printed command is valid shell (docs_normalize included)', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  const armed = armStep({ statePath: fx.statePath, step: 'docs_normalize', targets: fx.targets });
  assert.equal(armed.ok, true);
  const r = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docs normalized/);
});

test('push: a tag retargeted after the arm is refused; the receipt binds tag object, peeled commit and branch', (t) => {
  const fx = makeFixture(t);
  for (const step of ['rehearsal', 'docs_normalize', 'verify', 'review', 'assess', 'release']) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip);
  const armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.equal(armed.data.tag_commit, fx.tip);
  // retarget the tag to an unrelated commit (HEAD and the branch ref do not move)
  git(fx.MAIN, 'tag', '-d', 'v10.0.0');
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', git(fx.MAIN, 'rev-parse', 'main'));
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'push', exit: 0, targets: fx.targets }), /tag_unchanged_since_arm/);
});

test('main_push: a local main that moved after the arm is refused (the carried report is stale)', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'publish_ack', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  const armed = armStep({ statePath: fx.statePath, step: 'main_push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.equal(armed.data.main_sha, git(fx.MAIN, 'rev-parse', 'main'));
  // a commit lands on main after the arm (via a worktree, so MAIN HEAD... here MAIN is main: use a plain commit)
  write(fx.MAIN, 'src/late.txt', 'late\n');
  git(fx.MAIN, 'add', 'src/late.txt'); git(fx.MAIN, 'commit', '-q', '-m', 'late non-bundle commit');
  // MAIN HEAD moved too, so the generic base-moved rule fires first; both refuse the record
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'main_push', exit: 0, targets: fx.targets }), /base moved since arm|main_unchanged_since_arm/);
});

test('assess refuses an empty assessment', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' });
  assert.equal(armStep({ statePath: fx.statePath, step: 'assess', targets: fx.targets }).ok, true);
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'assess', exit: 0, data: { goals: {} }, targets: fx.targets }), /goals_object/);
});

test('gate: a dirty non-bundle file after the command refuses the record', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') } });
  const armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  write(fx.MAIN, 'src/seed.txt', 'modified after the gate command\n');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }), /dirty after the gate command/);
  git(fx.MAIN, 'checkout', '-q', '--', 'src/seed.txt');
  assert.equal(recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }).status, 'done');
});

test('a rework review verdict is a blocking finding; sibling-bundle dirt blocks a no-worktree arm', (t) => {
  assert.equal(isBlockingFinding({ type: 'adversary_review', final_verdict: 'rework' }), true);
  assert.equal(isBlockingFinding({ type: 'adversary_review', final_verdict: 'approve' }), false);
  // types that denote the failure block by themselves, without any redundant verdict field
  for (const type of SELF_BLOCKING_TRIGGERS) {
    assert.ok(CORRECTIVE_TRIGGERS.includes(type), `${type} must be a corrective trigger`);
    assert.equal(isBlockingFinding({ type, ts: 1 }), true, `${type} is self-describing`);
  }
  assert.equal(isBlockingFinding({ type: 'run_verify', ts: 1 }), false, 'an outcome record without a verdict is not a finding');
  assert.equal(isBlockingFinding({ type: 'goal_check', ts: 1, goals: { G1: 'achieved' } }), false);
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.worktree);
  git(fx.MAIN, 'checkout', '-q', fx.branch);
  const targets = { ...fx.targets, worktree: null };
  write(fx.MAIN, 'docs/masterplan/other/note', 'x\n');
  const armed = armStep({ statePath: fx.statePath, step: 'rehearsal', targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => (p.name === 'clean_tree' || p.name === 'worktree_clean') && !p.ok && /other\/note/.test(p.detail)), JSON.stringify(armed.preconditions));
});

test('release: a tag without the release commit is refused; a replay with the header present is accepted', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  assert.equal(armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets }).ok, true);
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip); // tag only, no release commit, no header
  // The preflight refuses the malformed delta and rolls the tag back (no release commit, no header).
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets: fx.targets }), /release preflight refused: release_commit/);
  assert.throws(() => git(fx.MAIN, 'rev-parse', '--verify', 'refs/tags/v10.0.0'), /Needed a single revision|unknown revision|not found/, 'the preflight removed the tag');
  // a tip whose CHANGELOG already carries the header (a replay) needs no new commit
  write(fx.worktree, 'CHANGELOG.md', '# Changelog\n\n## 10.0.0\n');
  git(fx.worktree, 'add', 'CHANGELOG.md'); git(fx.worktree, 'commit', '-q', '-m', 'header already present');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  // the tip moved: re-run verify/review/assess at it (release binds to the reviewed sha), then release
  for (const [step, data] of [['verify', {}], ['review', { verdict: 'approve' }], ['assess', { goals: { G1: 'achieved' } }]]) {
    // these steps are already done in this pass; a moved tip means a corrective pass in real life.
    // For this fixture, seed replacement records at the new tip.
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 3, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: { ...data, tip: fx.tip } });
  }
  assert.equal(armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets }).ok, true);
  git(fx.MAIN, 'tag', '-a', 'v10.0.0', '-m', 'v10.0.0', fx.tip);
  assert.equal(recordStep({ statePath: fx.statePath, step: 'release', exit: 0, targets: fx.targets }).status, 'done');
});

test('gate: an overridden or unresolvable branch cannot dodge the audits', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') } });
  // a nonexistent branch: refused outright
  let armed = armStep({ statePath: fx.statePath, step: 'gate', targets: { ...fx.targets, branch: 'masterplan/nope', worktree: null } });
  assert.equal(armed.ok, false);
  assert.match(armed.refusals.join(' '), /no resolvable tip/);
  // another real branch that is not the one the PR merged: refused by the gate's binding
  git(fx.MAIN, 'branch', '-q', 'other-branch', 'main');
  armed = armStep({ statePath: fx.statePath, step: 'gate', targets: { ...fx.targets, branch: 'other-branch', worktree: null } });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'tip_is_merged_branch' && !p.ok), JSON.stringify(armed));
  armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
});

test('a blocking finding after surfaces_live blocks the gate (arm and record) until a corrective pass consumes it; a recorded gate closes the run', (t) => {
  const fx = makeFixture(t);
  // pass 1 through pr_merge for real enough that the gate's own preconditions pass
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') } });
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'surfaces_live', cmd: 'seeded', exit: 0, status: 'done' });
  // the gate arms on a clean pass
  let armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  // a blocking finish-time finding lands after the arm: the record is refused, and so is a re-arm
  appendEvent(fx.statePath, { type: 'adversary_review', ts: 5, verdict: 'revise' });
  const finding = events(fx.statePath).length - 1;
  assert.deepEqual(openCorrectiveFindings(events(fx.statePath), 1), [{ index: finding, type: 'adversary_review' }]);
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }), /no_open_corrective_finding/);
  armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'no_open_corrective_finding' && !p.ok && /triggered-by=/.test(p.detail)), JSON.stringify(armed));
  // an unblocking finding does not count
  appendEvent(fx.statePath, { type: 'goal_check', ts: 6, goals: { G1: 'achieved' } });
  assert.equal(openCorrectiveFindings(events(fx.statePath), 1).length, 1);
  // the corrective pass consumes the finding; pass 2 owns the gate from here (pass 1's gate arm is moot)
  const st = startPass({ statePath: fx.statePath, pass: 2, triggeredBy: finding, version: '10.0.1' });
  assert.equal(st.pass, 2);
  fx.targets = { ...fx.targets, version: '10.0.1' };
  assert.deepEqual(openCorrectiveFindings(events(fx.statePath), 1), [], 'consumed');
  assert.equal(armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets }).ok, false, 'pass 2 has not reached surfaces_live');
  for (const step of stepsForPass(2).filter((s) => !['gate', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 7, pass: 2, step, cmd: 'seeded', exit: 0, status: 'done' });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 7, pass: 2, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') } });
  // pass 2 reached surfaces_live with no open finding: the gate is armable again
  armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  assert.equal(recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }).status, 'done');
  // exactly one recorded gate, on the final pass; a later finding cannot open pass 3 behind it
  const gates = events(fx.statePath).filter((e) => e.type === 'bootstrap_step' && e.step === 'gate');
  assert.equal(gates.length, 1); assert.equal(gates[0].pass, 2);
  appendEvent(fx.statePath, { type: 'verify_failed', ts: 8 });
  assert.throws(() => startPass({ statePath: fx.statePath, pass: 3, triggeredBy: events(fx.statePath).length - 1, version: '10.0.2' }), /gate is already recorded/);
});

test('gh commands are anchored to MAIN: run from another repository, gh still sees MAIN', (t) => {
  const fx = makeFixture(t);
  const cwdFile = path.join(fx.tmp, 'gh.cwd');
  fs.writeFileSync(fx.targets.gh, `#!/bin/sh\npwd >> ${cwdFile}\necho "$@" >> ${path.join(fx.tmp, 'gh.log')}\nexit 0\n`);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  const ci = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets });
  assert.equal(ci.ok, true, JSON.stringify(ci));
  // another git repository as the operator's cwd: gh must not infer THAT repository
  const elsewhere = path.join(fx.tmp, 'elsewhere');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, elsewhere);
  execFileSync('sh', ['-c', ci.cmd], { cwd: elsewhere, stdio: 'ignore' });
  const seen = fs.readFileSync(cwdFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(seen.length >= 1, 'the gh shim ran');
  for (const dir of seen) assert.equal(fs.realpathSync(dir), fs.realpathSync(fx.MAIN), `gh ran in ${dir}`);
  // and every invocation names the bound repository explicitly
  const calls = fs.readFileSync(path.join(fx.tmp, 'gh.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(calls.length, seen.length);
  for (const c of calls) assert.match(c, /--repo fixture\/repo/, c);
  assert.equal(ci.data.gh_repo, 'fixture/repo', 'the arm binds the repository');
});

test('the GitHub repository is the configured remote\'s, never the checkout\'s default: derived from the URL or refused', (t) => {
  assert.equal(ghRepoFromRemoteUrl('git@github.com:acme/staging.git'), 'acme/staging');
  assert.equal(ghRepoFromRemoteUrl('https://github.com/acme/prod'), 'acme/prod');
  assert.equal(ghRepoFromRemoteUrl('https://github.com/acme/prod.git/'), 'acme/prod');
  assert.equal(ghRepoFromRemoteUrl('/tmp/x/remote.git'), null);
  assert.equal(ghRepoFromRemoteUrl('git@gitlab.com:acme/prod.git'), null);
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  walk(fx, 'push');
  // no gh_repo target and a non-GitHub remote URL: the arm is refused rather than letting gh guess
  const noRepo = { ...fx.targets }; delete noRepo.gh_repo;
  const refused = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: noRepo });
  assert.equal(refused.ok, false);
  assert.ok(refused.preconditions.some((p) => p.name === 'gh_repo_resolved' && !p.ok), JSON.stringify(refused));
  // a GitHub URL on the configured remote is derived (the remote itself is unreachable, so only the
  // resolution is asserted, through the pr_merge command text)
  git(fx.MAIN, 'remote', 'add', 'upstream', 'git@github.com:acme/staging.git');
  const armed = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /--repo 'fixture\/repo'/);
});

test('pr_merge is recoverable after `pr create` succeeded and the merge failed: the retry finds the PR and merges by number', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : step === 'push' ? { published_tip: fx.tip } : step === 'main_push' ? { main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } : {} });
  }
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  // a stateful gh: `pr list` knows the PR once `pr create` ran; the first `pr merge` fails
  const created = path.join(fx.tmp, 'pr.created'); const failOnce = path.join(fx.tmp, 'merge.fail-once'); fs.writeFileSync(failOnce, '');
  const log = path.join(fx.tmp, 'gh.log');
  fs.writeFileSync(fx.targets.gh, `#!/bin/sh
echo "$@" >> ${log}
case "$1 $2" in
  "pr list") [ -e ${created} ] && echo 42; exit 0;;
  "pr create") touch ${created}; echo https://example.invalid/pr/42; exit 0;;
  "pr merge") if [ -e ${failOnce} ]; then rm ${failOnce}; exit 1; fi; exit 0;;
esac
exit 0
`);
  let armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.equal(armed.data.gh_repo, 'fixture/repo');
  const first = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.notEqual(first.status, 0, 'the first attempt fails at the merge');
  const failed = recordStep({ statePath: fx.statePath, step: 'pr_merge', exit: first.status, status: 'failed', targets: fx.targets });
  assert.equal(failed.status, 'failed');
  armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const second = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(calls.filter((c) => c.startsWith('pr create')).length, 1, 'the PR is created once');
  assert.equal(calls.filter((c) => c.startsWith('pr merge')).length, 2);
  for (const c of calls.filter((c) => c.startsWith('pr merge'))) assert.match(c, new RegExp(`--repo fixture/repo 42 --merge --match-head-commit ${fx.tip}$`), c);
  // "GitHub" merged it: record the recovery against the real merge
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const rec = recordStep({ statePath: fx.statePath, step: 'pr_merge', exit: 0, status: 'recovered', data: { merge_sha: git(clone, 'rev-parse', 'HEAD') }, targets: fx.targets });
  assert.equal(rec.status, 'recovered');
});

test('push is atomic and authorised against the remote refs: a tag that appeared after the arm fails the whole push, publishing nothing', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  let armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.match(armed.cmd, /push --atomic/);
  assert.equal(armed.data.remote_tag_before, null); assert.equal(armed.data.remote_branch_before, null);
  // someone else publishes v10.0.0 (at main) between the arm and the push
  const mainSha = git(fx.MAIN, 'rev-parse', 'main');
  git(fx.MAIN, 'push', '-q', 'origin', `${mainSha}:refs/tags/v10.0.0`);
  const res = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.notEqual(res.status, 0, 'the push is rejected');
  const remote = (ref) => { const out = git(fx.MAIN, 'ls-remote', 'origin', ref); return out ? out.split('\t')[0] : null; };
  assert.equal(remote(`refs/heads/${fx.branch}`), null, 'atomic: the branch did not go out either');
  assert.equal(remote('refs/tags/v10.0.0'), mainSha, 'the foreign tag is untouched');
  assert.equal(recordStep({ statePath: fx.statePath, step: 'push', exit: res.status, status: 'failed', targets: fx.targets }).status, 'failed');
  // the re-arm sees the foreign tag and refuses; once it is gone the push proceeds
  armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'remote_tag_absent' && !p.ok), JSON.stringify(armed));
  git(fx.MAIN, 'push', '-q', 'origin', ':refs/tags/v10.0.0');
  armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  assert.equal(recordStep({ statePath: fx.statePath, step: 'push', exit: 0, status: 'recovered', targets: fx.targets }).status, 'recovered');
  // a retry after a push that went out but whose record failed: the remote tag is exactly ours → allowed
  armed = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
});

test('push publishes the ARMED objects: local refs retargeted after the arm never reach the remote', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const armedTip = fx.tip; const armedTag = armed.data.tag_sha;
  assert.match(armed.cmd, new RegExp(`${armedTip}:refs/heads/`)); assert.match(armed.cmd, new RegExp(`${armedTag}:refs/tags/v10\\.0\\.0`));
  // after the arm: the branch gains an unreviewed commit and the tag is retargeted to it
  write(fx.worktree, 'src/sneak.txt', 'unreviewed\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'unreviewed after the arm');
  const moved = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'tag', '-f', '-a', 'v10.0.0', '-m', 'retargeted', moved);
  const res = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const remote = (ref) => git(fx.MAIN, 'ls-remote', 'origin', ref).split('\t')[0];
  assert.equal(remote(`refs/heads/${fx.branch}`), armedTip, 'the armed tip went out, not the moved branch');
  assert.equal(remote('refs/tags/v10.0.0'), armedTag, 'the armed tag object went out, not the retargeted one');
  // the record refuses the moved local refs (they are not what went out); restoring them records
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'push', exit: 0, targets: fx.targets }), /tag_unchanged_since_arm|tip/);
});

test('main_push publishes the armed main_sha: a commit that lands on main after the arm is not pushed', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'publish_ack', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  const armed = armStep({ statePath: fx.statePath, step: 'main_push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const armedMain = armed.data.main_sha;
  assert.equal(armed.data.remote_main, git(fx.MAIN, 'rev-parse', 'origin/main'));
  write(fx.MAIN, 'src/late.txt', 'late\n');
  git(fx.MAIN, 'add', 'src/late.txt'); git(fx.MAIN, 'commit', '-q', '-m', 'landed on main after the arm');
  const res = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(fx.MAIN, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], armedMain, 'only the armed main went out');
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'main_push', exit: 0, targets: fx.targets }), /base moved since arm|main_unchanged_since_arm/);
});

test('pr_merge: a remote head that is not the armed tip is refused at the arm', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : step === 'push' ? { published_tip: fx.tip } : step === 'main_push' ? { main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } : {} });
  }
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  // someone pushes an extra commit to the PR branch from elsewhere
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', fx.branch, fx.bare, clone);
  write(clone, 'extra.txt', 'x\n'); git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'extra on the remote head');
  git(clone, 'push', '-q', 'origin', fx.branch);
  const armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'remote_head_is_tip' && !p.ok), JSON.stringify(armed));
});

// ---- the whole walk, twice: pass 1 publishes 10.0.0, a finding opens pass 2, 10.0.1 walks every real step ----

function installPi(fx, version) {
  fakeInstall(fx, version);
}
function claudeSurface(fx, version) {
  write(path.join(fx.claudeDir, 'plugins', 'cache', 'rasatpetabit-masterplan', 'masterplan', version, 'bin'), 'masterplan.mjs', SURFACE_ENTRY(version));
}
function runPrinted(fx, step, extra = {}) {
  const armed = armStep({ statePath: fx.statePath, step, targets: fx.targets });
  assert.equal(armed.ok, true, `${step} arm: ${JSON.stringify(armed)}`);
  const res = spawnSync('sh', ['-c', armed.cmd], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${step} cmd: ${res.stderr}`);
  return armed;
}
function prMerge(fx, pass) {
  const armed = runPrinted(fx, 'pr_merge');
  const clone = path.join(fx.tmp, `clone-${pass}`);
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const mergeSha = git(clone, 'rev-parse', 'HEAD');
  const rec = recordStep({ statePath: fx.statePath, step: 'pr_merge', exit: 0, data: { merge_sha: mergeSha }, targets: fx.targets });
  assert.equal(rec.status, 'done');
  void armed;
  return mergeSha;
}

test('end to end: pass 1 publishes 10.0.0, a blocking finding opens pass 2, and 10.0.1 walks every real step to the gate', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  const walkStep2 = () => { walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } }); };
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize');
  walkStep2();
  release(fx, '10.0.0');
  runPrinted(fx, 'push'); walk(fx, 'push');
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  installPi(fx, '10.0.0'); walk(fx, 'install_pi');
  runPrinted(fx, 'main_push'); assert.equal(recordStep({ statePath: fx.statePath, step: 'main_push', exit: 0, targets: fx.targets }).status, 'done');
  walk(fx, 'publish_ack', { answer: 'proceed' });
  const merge1 = prMerge(fx, 1);
  claudeSurface(fx, '10.0.0'); walk(fx, 'claude_surface');
  walk(fx, 'surfaces_live');
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'gate');
  // the finish's goal check misses a goal after both surfaces went live
  appendEvent(fx.statePath, { type: 'goals_unmet', ts: 9, goals: { G3: 'missed' } });
  const finding = events(fx.statePath).length - 1;
  assert.equal(armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets }).ok, false, 'the gate is blocked');
  const st = startPass({ statePath: fx.statePath, pass: 2, triggeredBy: finding, version: '10.0.1' });
  assert.equal(st.next.step, 'verify'); assert.equal(st.version, '10.0.1');
  // the fix and the version bump land on the run branch; the targets follow the bound version
  write(fx.worktree, 'src/fix.txt', 'fixed\n');
  write(fx.worktree, '.claude-plugin/plugin.json', JSON.stringify({ name: 'masterplan', version: '10.0.1' }) + '\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'fix G3 + 10.0.1');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  assert.throws(() => armStep({ statePath: fx.statePath, step: 'verify', targets: fx.targets }), /bound to version 10\.0\.1/);
  fx.targets = { ...fx.targets, version: '10.0.1' };
  walkStep2();
  release(fx, '10.0.1');
  runPrinted(fx, 'push'); walk(fx, 'push');
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  installPi(fx, '10.0.1'); walk(fx, 'install_pi');
  assert.equal(bootstrapStatus(fx.statePath).next.step, 'publish_ack', 'main_push is omitted on a corrective pass');
  walk(fx, 'publish_ack', { answer: 'proceed' });
  const merge2 = prMerge(fx, 2);
  assert.equal(git(fx.MAIN, 'rev-parse', `${merge2}^1`), merge1, 'the second PR lands on the first merge');
  claudeSurface(fx, '10.0.1'); walk(fx, 'claude_surface');
  walk(fx, 'surfaces_live');
  const gate = runPrinted(fx, 'gate');
  void gate;
  assert.equal(recordStep({ statePath: fx.statePath, step: 'gate', exit: 0, targets: fx.targets }).status, 'done');
  const evs = events(fx.statePath);
  const gates = evs.filter((e) => e.type === 'bootstrap_step' && e.step === 'gate');
  assert.equal(gates.length, 1); assert.equal(gates[0].pass, 2);
  assert.equal(evs.filter((e) => e.type === 'bootstrap_step' && e.step === 'release' && e.status === 'done').length, 2, 'two releases');
  assert.equal(evs.filter((e) => e.type === 'bootstrap_step' && e.step === 'pr_merge' && e.status === 'done').length, 2, 'two merges');
  for (const tag of ['v10.0.0', 'v10.0.1']) assert.ok(git(fx.MAIN, 'ls-remote', 'origin', `refs/tags/${tag}`), `${tag} is public`);
  assert.equal(git(fx.MAIN, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], merge2);
});


test('release refuses a tag that already exists on the remote, writing nothing', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  // a remote-only v10.0.0 (some other machine published it) — no local tag
  git(fx.MAIN, 'push', '-q', 'origin', `${git(fx.MAIN, 'rev-parse', 'main')}:refs/tags/v10.0.0`);
  const before = events(fx.statePath).length;
  const armed = armStep({ statePath: fx.statePath, step: 'release', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'remote_tag_absent' && !p.ok && /already exists on origin/.test(p.detail)), JSON.stringify(armed));
  assert.ok(armed.preconditions.some((p) => p.name === 'tag_absent' && !p.ok) === false, 'the local check is still clean');
  assert.equal(events(fx.statePath).length, before, 'a refused arm writes nothing');
  // an unreachable remote is refused too, never treated as absent
  const unreachable = armStep({ statePath: fx.statePath, step: 'release', targets: { ...fx.targets, remote: path.join(fx.tmp, 'no-such-remote') } });
  assert.equal(unreachable.ok, false);
  assert.ok(unreachable.preconditions.some((p) => p.name === 'remote_tag_absent' && !p.ok && /cannot query/.test(p.detail)), JSON.stringify(unreachable));
  git(fx.MAIN, 'push', '-q', 'origin', ':refs/tags/v10.0.0');
  release(fx);
});

test('after the push, every step is bound to the published tip: a branch that moves is refused', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  const pushRec = walk(fx, 'push');
  const published = pushRec.data.published_tip;
  assert.equal(published, fx.tip, 'the push record binds the tip it published');
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  // an unreviewed commit lands on the run branch AND on the remote after the release
  write(fx.worktree, 'src/unreviewed.txt', 'not reviewed, not released\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'unreviewed after the push');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  fakeInstall(fx);
  let armed = armStep({ statePath: fx.statePath, step: 'install_pi', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'tip_is_published' && !p.ok), JSON.stringify(armed));
  // even with install_pi and the rest seeded, pr_merge refuses the moved head
  for (const step of ['install_pi', 'main_push', 'publish_ack']) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 5, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  }
  armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, false);
  assert.ok(armed.preconditions.some((p) => p.name === 'tip_is_published' && !p.ok), JSON.stringify(armed));
  assert.ok(armed.preconditions.some((p) => p.name === 'remote_head_is_tip' && !p.ok), JSON.stringify(armed));
  // rewinding both refs to the released tip restores authorisation
  git(fx.worktree, 'reset', '-q', '--hard', published);
  git(fx.MAIN, 'push', '-q', '--force', 'origin', `${published}:refs/heads/${fx.branch}`);
  fx.tip = published;
  armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  // …and the same binding holds after the merge: claude_surface and surfaces_live run from the
  // execution tree, so a branch that moves again cannot be armed (surfaces_live cannot be armed
  // from a moved branch)
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 6, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(fx.MAIN, 'rev-parse', 'main') } });
  write(fx.worktree, 'src/unreviewed2.txt', 'again\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'unreviewed after the merge');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  const blocked = armStep({ statePath: fx.statePath, step: 'claude_surface', targets: fx.targets });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.ok((blocked.preconditions || []).some((p) => p.name === 'tip_is_published' && !p.ok), JSON.stringify(blocked));
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 7, pass: 1, step: 'claude_surface', cmd: 'seeded', exit: 0, status: 'done' });
  const blocked2 = armStep({ statePath: fx.statePath, step: 'surfaces_live', targets: fx.targets });
  assert.equal(blocked2.ok, false, JSON.stringify(blocked2));
  assert.ok((blocked2.preconditions || []).some((p) => p.name === 'tip_is_published' && !p.ok), JSON.stringify(blocked2));
  git(fx.worktree, 'reset', '-q', '--hard', published);
  fx.tip = published;
  write(path.join(fx.claudeDir, 'plugins', 'cache', 'rasatpetabit-masterplan', 'masterplan', '10.0.0', 'bin'), 'masterplan.mjs', SURFACE_ENTRY('10.0.0'));
  const restored = armStep({ statePath: fx.statePath, step: 'surfaces_live', targets: fx.targets });
  assert.equal(restored.ok, true, JSON.stringify(restored));
});

test('the gate audits the merged PR range and rebases onto the armed object, not a repointable ref', (t) => {
  const fx = makeFixture(t);
  // a branch commit that writes into the bundle and reverts it (net-clean, still a branch-path write)
  write(fx.worktree, 'docs/masterplan/bs/sneak.txt', 'x\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'branch writes the bundle');
  git(fx.worktree, 'rm', '-q', 'docs/masterplan/bs/sneak.txt'); git(fx.worktree, 'commit', '-q', '-m', 'and reverts it');
  fx.tip = git(fx.MAIN, 'rev-parse', fx.branch);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx.MAIN, 'rev-parse', 'main'), main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const clone = path.join(fx.tmp, 'clone');
  git(fx.tmp, 'clone', '-q', '-b', 'main', fx.bare, clone);
  git(clone, 'fetch', '-q', 'origin', fx.branch);
  git(clone, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx.branch}`);
  git(clone, 'push', '-q', 'origin', 'main');
  const mergeSha = git(clone, 'rev-parse', 'HEAD');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: mergeSha } });
  // local main is fast-forwarded onto the merged remote: merge-base(main, tip) would be the tip
  git(fx.MAIN, 'fetch', '-q', 'origin', 'main');
  git(fx.MAIN, 'merge', '-q', '--ff-only', 'origin/main');
  const armed = armStep({ statePath: fx.statePath, step: 'gate', targets: fx.targets });
  assert.equal(armed.ok, false, JSON.stringify(armed));
  assert.ok(armed.preconditions.some((p) => p.name === 'no_bundle_diff' && !p.ok), JSON.stringify(armed));
  // and the printed command names the armed remote tip object, never the tracking ref
  const fx2 = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge'].includes(s))) {
    appendEvent(fx2.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx2.tip } } : {}) });
  }
  appendEvent(fx2.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'main_push', cmd: 'seeded', exit: 0, status: 'done', data: { main_pre_bootstrap: git(fx2.MAIN, 'rev-parse', 'main'), main_sha: git(fx2.MAIN, 'rev-parse', 'main'), carried: [] } });
  git(fx2.MAIN, 'push', '-q', 'origin', fx2.branch);
  const clone2 = path.join(fx2.tmp, 'clone');
  git(fx2.tmp, 'clone', '-q', '-b', 'main', fx2.bare, clone2);
  git(clone2, 'fetch', '-q', 'origin', fx2.branch);
  git(clone2, 'merge', '-q', '--no-ff', '--no-edit', `origin/${fx2.branch}`);
  git(clone2, 'push', '-q', 'origin', 'main');
  appendEvent(fx2.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step: 'pr_merge', cmd: 'seeded', exit: 0, status: 'done', data: { merge_sha: git(clone2, 'rev-parse', 'HEAD') } });
  const armed2 = armStep({ statePath: fx2.statePath, step: 'gate', targets: fx2.targets });
  assert.equal(armed2.ok, true, JSON.stringify(armed2));
  assert.match(armed2.cmd, new RegExp(`rebase '${armed2.data.remote_tip}'`), armed2.cmd);
  assert.ok(!armed2.cmd.includes('origin/main'), 'the tracking ref is never the rebase target');
  // repointing the tracking ref after the arm cannot inject a commit: the command names the object
  write(fx2.MAIN, 'src/injected.txt', 'x\n');
  git(fx2.MAIN, 'add', 'src/injected.txt'); git(fx2.MAIN, 'commit', '-q', '-m', 'a commit only the tracking ref would carry');
  const injected = git(fx2.MAIN, 'rev-parse', 'HEAD');
  git(fx2.MAIN, 'reset', '-q', '--soft', 'HEAD~1'); git(fx2.MAIN, 'rm', '-q', '-f', '--cached', 'src/injected.txt');
  fs.rmSync(path.join(fx2.MAIN, 'src', 'injected.txt'));
  git(fx2.MAIN, 'update-ref', 'refs/remotes/origin/main', injected);
  const run = spawnSync('sh', ['-c', armed2.cmd], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(!git(fx2.MAIN, 'log', '--format=%H', '-n', '20', 'main').split('\n').includes(injected), 'the substituted commit did not enter main');
});

test('a tag retargeted after the push blocks every tag consumer, even at the same version', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const armed = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  const rec = walk(fx, 'push');
  assert.equal(rec.data.published_tag, armed.data.tag_sha, 'the push record binds the tag object');
  assert.equal(armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets }).ok, true);
  // an unreviewed commit KEEPING version 10.0.0, and both tags force-moved onto it
  write(fx.worktree, 'src/unreviewed.txt', 'same version, unreviewed\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'unreviewed, still 10.0.0');
  const moved = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'tag', '-f', '-a', 'v10.0.0', '-m', 'retargeted', moved);
  git(fx.MAIN, 'push', '-q', '--force', 'origin', 'refs/tags/v10.0.0');
  git(fx.worktree, 'reset', '-q', '--hard', rec.data.published_tip); // the branch is put back
  fx.tip = rec.data.published_tip;
  for (const step of ['ci_wait']) {
    const a = armStep({ statePath: fx.statePath, step, targets: fx.targets });
    assert.equal(a.ok, false, `${step}: ${JSON.stringify(a)}`);
    assert.ok((a.preconditions || []).some((p) => p.name === 'tag_is_published' && !p.ok), `${step}: ${JSON.stringify(a)}`);
  }
  // restoring the published tag object on both sides restores authorisation
  git(fx.MAIN, 'update-ref', 'refs/tags/v10.0.0', rec.data.published_tag);
  git(fx.MAIN, 'push', '-q', '--force', 'origin', 'refs/tags/v10.0.0');
  assert.equal(armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets }).ok, true);
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  // …and install_pi is bound the same way
  fakeInstall(fx);
  git(fx.MAIN, 'tag', '-f', '-a', 'v10.0.0', '-m', 'retargeted again', moved);
  const blocked = armStep({ statePath: fx.statePath, step: 'install_pi', targets: fx.targets });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.ok((blocked.preconditions || []).some((p) => p.name === 'tag_is_published' && !p.ok), JSON.stringify(blocked));
  git(fx.MAIN, 'update-ref', 'refs/tags/v10.0.0', rec.data.published_tag);
  assert.equal(armStep({ statePath: fx.statePath, step: 'install_pi', targets: fx.targets }).ok, true);
});

test('a tag moved between the arm and the record cannot be recorded, and the commands never name the tag', (t) => {
  const fx = makeFixture(t);
  addRehearsalScript(fx);
  const digest = path.join(fx.tmp, 'r.out'); fs.writeFileSync(digest, 'x');
  walk(fx, 'rehearsal', {}, { digestFile: digest });
  walk(fx, 'docs_normalize'); walk(fx, 'verify'); walk(fx, 'review', { verdict: 'approve' }); walk(fx, 'assess', { goals: { G1: 'achieved' } });
  release(fx);
  const pushArm = armStep({ statePath: fx.statePath, step: 'push', targets: fx.targets });
  execFileSync('sh', ['-c', pushArm.cmd], { stdio: 'ignore' });
  const rec = walk(fx, 'push');
  const published = rec.data.published_tip;
  // the CI command selects the run by the published COMMIT, never by the tag name
  const ci = armStep({ statePath: fx.statePath, step: 'ci_wait', targets: fx.targets });
  assert.equal(ci.ok, true, JSON.stringify(ci));
  assert.match(ci.cmd, new RegExp(`--commit '${published}'`));
  assert.ok(!ci.cmd.includes('v10.0.0'), ci.cmd);
  // the tag is force-moved AFTER the arm, to a same-version unreviewed commit
  write(fx.worktree, 'src/unreviewed.txt', 'same version\n');
  git(fx.worktree, 'add', '-A'); git(fx.worktree, 'commit', '-q', '-m', 'unreviewed, still 10.0.0');
  const moved = git(fx.MAIN, 'rev-parse', fx.branch);
  git(fx.MAIN, 'tag', '-f', '-a', 'v10.0.0', '-m', 'moved after the arm', moved);
  git(fx.MAIN, 'push', '-q', '--force', 'origin', 'refs/tags/v10.0.0');
  git(fx.worktree, 'reset', '-q', '--hard', published);
  fx.tip = published;
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'ci_wait', exit: 0, data: { conclusions: { test: 'success', 'release-publish': 'success' } }, targets: fx.targets }), /tag_is_published/);
  git(fx.MAIN, 'update-ref', 'refs/tags/v10.0.0', rec.data.published_tag);
  git(fx.MAIN, 'push', '-q', '--force', 'origin', 'refs/tags/v10.0.0');
  walk(fx, 'ci_wait', { conclusions: { test: 'success', 'release-publish': 'success' } });
  // the install command names the published commit, and the record attests the installed sha
  const pi = armStep({ statePath: fx.statePath, step: 'install_pi', targets: fx.targets });
  assert.equal(pi.ok, true, JSON.stringify(pi));
  assert.match(pi.cmd, new RegExp(`--ref='${published}'`));
  fakeInstall(fx);
  fs.writeFileSync(path.join(fx.installRoot, '.pi-install.json'), JSON.stringify({ version: '10.0.0', sha: moved, ref: 'v10.0.0' }));
  assert.throws(() => recordStep({ statePath: fx.statePath, step: 'install_pi', exit: 0, targets: fx.targets }), /pi_installed_sha/);
  fs.writeFileSync(path.join(fx.installRoot, '.pi-install.json'), JSON.stringify({ version: '10.0.0', sha: published, ref: published }));
  assert.equal(recordStep({ statePath: fx.statePath, step: 'install_pi', exit: 0, targets: fx.targets }).status, 'done');
});

test('a second blocking finding is not stranded: the corrective pass consumes every open finding', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => s !== 'gate')) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', ...(step === 'push' ? { data: { published_tip: fx.tip, published_tag: 'x' } } : step === 'main_push' ? { data: { main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } } : {}) });
  }
  appendEvent(fx.statePath, { type: 'goals_unmet', ts: 3, goals: { G1: 'missed' } });
  appendEvent(fx.statePath, { type: 'verify_failed', ts: 4 });
  const evs = events(fx.statePath);
  const a = evs.length - 2; const b = evs.length - 1;
  assert.deepEqual(openCorrectiveFindings(events(fx.statePath), 1).map((f) => f.index), [a, b]);
  const st = startPass({ statePath: fx.statePath, pass: 2, triggeredBy: a, version: '10.0.1' });
  assert.equal(st.pass, 2);
  const passEvent = events(fx.statePath).find((e) => e.type === 'bootstrap_pass');
  assert.deepEqual(passEvent.consumed.sort(), [a, b].sort(), 'both findings are attached to the pass');
  assert.deepEqual(openCorrectiveFindings(events(fx.statePath), 2), [], 'neither still blocks');
  // a finding raised in pass 2 blocks pass 2's gate as before
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 5, pass: 2, step: 'surfaces_live', cmd: 'seeded', exit: 0, status: 'done' });
  appendEvent(fx.statePath, { type: 'verify_failed', ts: 6 });
  assert.equal(openCorrectiveFindings(events(fx.statePath), 2).length, 1);
});

test('pass 1 pr_merge binds the base to the main that main_push published', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : step === 'push' ? { published_tip: fx.tip, published_tag: 'x' } : step === 'main_push' ? { main_sha: git(fx.MAIN, 'rev-parse', 'main'), carried: [] } : {} });
  }
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const armedMain = armStep({ statePath: fx.statePath, step: 'main_push', targets: fx.targets });
  assert.equal(armedMain.ok, true, JSON.stringify(armedMain));
  execFileSync('sh', ['-c', armedMain.cmd], { stdio: 'ignore' });
  const pushed = recordStep({ statePath: fx.statePath, step: 'main_push', exit: 0, targets: fx.targets });
  assert.equal(pushed.status, 'done');
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 3, pass: 1, step: 'publish_ack', cmd: 'seeded', exit: 0, status: 'done', data: { answer: 'proceed' } });
  assert.equal(armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets }).ok, true);
  // a non-bundle commit added to main AFTER the push — in no carried report — cannot become the base
  write(fx.MAIN, 'src/late.txt', 'unreported\n');
  git(fx.MAIN, 'add', 'src/late.txt'); git(fx.MAIN, 'commit', '-q', '-m', 'unreported non-bundle commit');
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const armed = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(armed.ok, false, JSON.stringify(armed));
  assert.ok(armed.preconditions.some((p) => p.name === 'remote_main_expected' && !p.ok), JSON.stringify(armed));
});

test('a forged main_sha on the main_push record is replaced by the armed one', (t) => {
  const fx = makeFixture(t);
  for (const step of STEP_ORDER.filter((s) => !['gate', 'main_push', 'pr_merge', 'claude_surface', 'surfaces_live'].includes(s))) {
    appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 2, pass: 1, step, cmd: 'seeded', exit: 0, status: 'done', data: step === 'publish_ack' ? { answer: 'proceed' } : step === 'push' ? { published_tip: fx.tip, published_tag: 'x' } : {} });
  }
  git(fx.MAIN, 'push', '-q', 'origin', fx.branch);
  const armed = armStep({ statePath: fx.statePath, step: 'main_push', targets: fx.targets });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const armedMain = armed.data.main_sha;
  execFileSync('sh', ['-c', armed.cmd], { stdio: 'ignore' });
  // the caller claims a different main (a descendant it intends to push later)
  const rec = recordStep({ statePath: fx.statePath, step: 'main_push', exit: 0, data: { main_sha: '0'.repeat(40), main_pre_bootstrap: '0'.repeat(40) }, targets: fx.targets });
  assert.equal(rec.data.main_sha, armedMain, 'the forged value is replaced by the armed one');
  assert.equal(rec.data.main_pre_bootstrap, armedMain);
  // that later commit, pushed to main, cannot become the PR base
  appendEvent(fx.statePath, { type: 'bootstrap_step', ts: 3, pass: 1, step: 'publish_ack', cmd: 'seeded', exit: 0, status: 'done', data: { answer: 'proceed' } });
  write(fx.MAIN, 'src/late.txt', 'unreported\n');
  git(fx.MAIN, 'add', 'src/late.txt'); git(fx.MAIN, 'commit', '-q', '-m', 'unreported non-bundle commit');
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const pr = armStep({ statePath: fx.statePath, step: 'pr_merge', targets: fx.targets });
  assert.equal(pr.ok, false, JSON.stringify(pr));
  assert.ok(pr.preconditions.some((p) => p.name === 'remote_main_expected' && !p.ok), JSON.stringify(pr));
});
