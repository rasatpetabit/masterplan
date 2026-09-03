import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gitVersion,
  supportsVerbatimPatchId,
  versionAtRevision,
  tagExists,
  mergeIdentity,
  supportsMergeTree,
  mergedTree,
  auditDeployBoundary,
  dirtyOutsideBundle,
} from '../lib/finish.mjs';

// On git < 2.39 the implementation refuses squash identity as 'unsupported' by design (§7.3); the
// squash-acceptance assertions below turn into that expectation there.
const SQUASH_SUPPORTED = supportsVerbatimPatchId(gitVersion(process.cwd()));
function expectSquashOk(res) {
  if (!SQUASH_SUPPORTED) { assert.equal(res.ok, false); assert.equal(res.kind, 'unsupported'); return false; }
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.kind, 'squash');
  return true;
}

function runGit(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
  runGit(dir, ['init', '--initial-branch=main']);
  runGit(dir, ['config', 'user.name', 't']);
  runGit(dir, ['config', 'user.email', 't@example.invalid']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function writeFile(repo, rel, content) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(repo, message) {
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-m', message]);
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('gitVersion parses and supportsVerbatimPatchId thresholds', () => {
  const repo = makeRepo();
  try {
    const v = gitVersion(repo);
    assert.equal(typeof v.major, 'number');
    assert.equal(typeof v.minor, 'number');
    assert.equal(typeof v.patch, 'number');
    assert.ok(v.raw.startsWith('git version '));
    assert.equal(supportsVerbatimPatchId({ major: 2, minor: 38, patch: 5 }), false);
    assert.equal(supportsVerbatimPatchId({ major: 2, minor: 39, patch: 0 }), true);
    assert.equal(supportsVerbatimPatchId({ major: 2, minor: 45, patch: 1 }), true);
  } finally {
    cleanup(repo);
  }
});

test('versionAtRevision reads versions and throws on missing file', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'package.json', JSON.stringify({ version: '1.0.0' }));
    commitAll(repo, 'v1');
    const sha1 = runGit(repo, ['rev-parse', 'HEAD']);
    writeFile(repo, 'package.json', JSON.stringify({ version: '2.0.0' }));
    commitAll(repo, 'v2');
    const sha2 = runGit(repo, ['rev-parse', 'HEAD']);
    assert.equal(versionAtRevision(repo, sha1, 'package.json'), '1.0.0');
    assert.equal(versionAtRevision(repo, sha2, 'package.json'), '2.0.0');
    assert.throws(() => versionAtRevision(repo, sha1, 'missing.json'), /missing\.json/);
  } finally {
    cleanup(repo);
  }
});

test('tagExists local and remote', () => {
  const repo = makeRepo();
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bare-'));
  try {
    runGit(bareDir, ['init', '--bare']);
    runGit(repo, ['remote', 'add', 'origin', bareDir]);
    writeFile(repo, 'a.txt', 'a');
    commitAll(repo, 'c1');
    runGit(repo, ['tag', 'v1.0.0']);
    assert.equal(tagExists(repo, 'v1.0.0'), true);
    assert.equal(tagExists(repo, 'v2.0.0'), false);
    runGit(repo, ['push', 'origin', 'v1.0.0']);
    assert.equal(tagExists(repo, 'v1.0.0', { remote: 'origin' }), true);
    assert.equal(tagExists(repo, 'v2.0.0', { remote: 'origin' }), false);
  } finally {
    cleanup(repo);
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

test('mergeIdentity: merge, squash, squash-diff, rebase', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);

    runGit(repo, ['checkout', '-b', 'feature']);
    writeFile(repo, 'feature.txt', 'feature');
    commitAll(repo, 'feature commit');
    const branchTip = runGit(repo, ['rev-parse', 'HEAD']);

    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);
    const mergeSha = runGit(repo, ['rev-parse', 'HEAD']);
    let res = mergeIdentity(repo, { baseBefore, branchTip, mergeSha });
    assert.equal(res.ok, true);
    assert.equal(res.kind, 'merge');
    assert.equal(res.exact, true);

    runGit(repo, ['reset', '--hard', baseBefore]);
    runGit(repo, ['checkout', '-b', 'squash-branch']);
    writeFile(repo, 'squash.txt', 'squash');
    commitAll(repo, 'squash commit');
    const squashTip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--squash', 'squash-branch']);
    runGit(repo, ['commit', '-m', 'squash merge']);
    const squashSha = runGit(repo, ['rev-parse', 'HEAD']);
    res = mergeIdentity(repo, { baseBefore, branchTip: squashTip, mergeSha: squashSha });
    if (!expectSquashOk(res)) return;

    runGit(repo, ['reset', '--hard', baseBefore]);
    runGit(repo, ['checkout', '-b', 'ws-branch']);
    writeFile(repo, 'ws.txt', 'hello\n');
    commitAll(repo, 'ws commit');
    const wsTip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--squash', 'ws-branch']);
    writeFile(repo, 'ws.txt', 'hello \n');
    commitAll(repo, 'ws squash');
    const wsSha = runGit(repo, ['rev-parse', 'HEAD']);
    res = mergeIdentity(repo, { baseBefore, branchTip: wsTip, mergeSha: wsSha });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'squash');
    assert.match(res.reason, /whitespace/);

    runGit(repo, ['reset', '--hard', baseBefore]);
    runGit(repo, ['checkout', '-b', 'rebase-branch']);
    writeFile(repo, 'r1.txt', 'r1');
    commitAll(repo, 'r1');
    writeFile(repo, 'r2.txt', 'r2');
    commitAll(repo, 'r2');
    const rebaseTip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', 'main']);
    writeFile(repo, 'main.txt', 'main moved'); // a real rebase lands on a base that moved (else it is a fast-forward)
    commitAll(repo, 'main moves');
    const commits = runGit(repo, ['rev-list', '--reverse', `${baseBefore}..${rebaseTip}`]).split('\n');
    for (const c of commits) {
      runGit(repo, ['cherry-pick', c]);
    }
    const rebaseSha = runGit(repo, ['rev-parse', 'HEAD']);
    res = mergeIdentity(repo, { baseBefore, branchTip: rebaseTip, mergeSha: rebaseSha });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'rebase');
  } finally {
    cleanup(repo);
  }
});

test('auditDeployBoundary classifies commits', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'package.json', JSON.stringify({ version: '1.0.0' }));
    commitAll(repo, 'base');
    const base = runGit(repo, ['rev-parse', 'HEAD']);

    writeFile(repo, 'docs/masterplan/run/1.md', 'bundle');
    commitAll(repo, 'bundle commit');
    const bundleSha = runGit(repo, ['rev-parse', 'HEAD']);

    writeFile(repo, 'CHANGELOG.md', 'changelog');
    commitAll(repo, 'stage commit');
    const stageSha = runGit(repo, ['rev-parse', 'HEAD']);

    writeFile(repo, 'src/foo.js', 'foo');
    commitAll(repo, 'foreign commit');
    const foreignSha = runGit(repo, ['rev-parse', 'HEAD']);

    runGit(repo, ['checkout', '-b', 'side']);
    writeFile(repo, 'side.txt', 'side');
    commitAll(repo, 'side commit');
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--no-ff', 'side', '-m', 'merge side']);
    const mergeSha = runGit(repo, ['rev-parse', 'HEAD']);

    const opts = {
      from: base,
      bundlePrefix: 'docs/masterplan',
      commitPaths: ['CHANGELOG.md'],
      versionFrom: 'package.json',
      expectedVersion: '1.0.0',
    };

    // Without a receipt naming it, the CHANGELOG-only commit has no provenance: foreign.
    let res = auditDeployBoundary(repo, { ...opts, to: stageSha });
    assert.equal(res.ok, false);
    assert.equal(res.commits[res.commits.length - 1].kind, 'foreign');
    res = auditDeployBoundary(repo, { ...opts, to: stageSha, stageCommits: [stageSha] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.commits.map((c) => c.kind), ['bundle', 'stage']);

    res = auditDeployBoundary(repo, { ...opts, to: foreignSha, stageCommits: [stageSha] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'base moved');
    assert.equal(res.commits[res.commits.length - 1].kind, 'foreign');

    res = auditDeployBoundary(repo, { ...opts, to: mergeSha, stageCommits: [stageSha] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'base moved');
    assert.equal(res.commits[res.commits.length - 1].kind, 'foreign');
  } finally {
    cleanup(repo);
  }
});

test('dirtyOutsideBundle reports non-bundle dirt', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'docs/masterplan/run/1.md', 'bundle');
    writeFile(repo, 'src/foo.js', 'foo');
    commitAll(repo, 'initial');
    assert.deepEqual(dirtyOutsideBundle(repo, 'docs/masterplan'), []);
    writeFile(repo, 'docs/masterplan/run/1.md', 'changed');
    assert.deepEqual(dirtyOutsideBundle(repo, 'docs/masterplan'), []);
    writeFile(repo, 'src/foo.js', 'changed');
    const dirty = dirtyOutsideBundle(repo, 'docs/masterplan');
    assert.deepEqual(dirty, ['src/foo.js']);
    // nothing outside the bundle is exempt — not even a tracked path under .worktrees/
    runGit(repo, ['checkout', '--', 'src/foo.js']);
    writeFile(repo, '.worktrees/marker', 'm');
    commitAll(repo, 'marker');
    writeFile(repo, '.worktrees/marker', 'changed');
    assert.deepEqual(dirtyOutsideBundle(repo, 'docs/masterplan'), ['.worktrees/marker']);
  } finally {
    cleanup(repo);
  }
});

// ---- finish-step integration: the guards wired into the deploy stage ----
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
  } catch {
    return [];
  }
}

// A MAIN repo on `main`, a linked worktree on masterplan/<slug> with one committed task file,
// a bundle whose single task is done, and the owner lock held by sess-A.
function makeFixture({ slug = 't24', state: over = {}, ownerLockOff = false, verifyCommands = null, explicitCodex = true, objectFormat = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-finishstep-'));
  FIXTURE_TMPDIRS.push(tmp);
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main', ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n'); // as in the real repo: linked worktrees live under an ignored dir
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', slug);
  // v10 deploy stage: a repo without a done definition is gated; these v9-flow fixtures declare done: none.
  write(MAIN, '.masterplan.yaml', 'done: none\n');
  git(MAIN, 'add', '.masterplan.yaml');
  git(MAIN, 'commit', '-q', '-m', 'done: none');
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  const stateObj = {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    worktree: WT,
    pending_gate: null,
    active_run: null,
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
    ...(ownerLockOff ? { concurrency: { owner_lock: 'off' } } : {}),
    ...over,
  };
  // Default: explicit opt-out (a bundle with NEITHER state.review nor state.codex would now be
  // defensively armed, breaking every existing test). Tests that want to exercise the legacy/defensive
  // path pass explicitCodex: false to omit both blocks entirely.
  if (explicitCodex && stateObj.review === undefined && stateObj.codex === undefined) {
    stateObj.review = { adversary: false };
  }
  writeState(statePath, stateObj);
  if (verifyCommands) {
    fs.writeFileSync(path.join(bundleDir, 'plan.index.json'),
      JSON.stringify({ tasks: [{ id: 1, verify_commands: verifyCommands }] }));
  }
  let self = null;
  if (!ownerLockOff) {
    self = buildOwnerIdentity({ host: 'h1', session: 'sess-A', slug, now: 1000 });
    assert.equal(acquireOwner(bundleDir, self, { now: 1000 }).outcome, 'acquire');
  }
  const step = (extra = {}) => finishStep({ statePath, self, now: 2000, ...extra });
  return { tmp, MAIN, WT, bundleDir, statePath, self, step };
}

// Walk a fixture to the open branch_finish gate: verify pass → retro written → gate.
function walkToGate(fx) {
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  return op;
}

function commitOn(dir, message, ...paths) {
  git(dir, 'add', ...(paths.length ? paths : ['-A']));
  git(dir, 'commit', '-q', '-m', message);
}

test('version_not_bumped opens before merge when the branch version is already tagged; keep archives incomplete', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  git(fx.MAIN, 'tag', 'v1.2.3'); // the version the branch names is already published
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'version_not_bumped');
  assert.equal(op.tag, 'v1.2.3');
  assert.deepEqual(op.where, ['local']);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
  op = fx.step({ choice: 'merge', versionFix: true });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'version_fix');
  op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived');
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(ev.reason, 'version_not_bumped');
  assert.equal(ev.tag, 'v1.2.3');
});

test('a bumped version opens no gate', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.4' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  git(fx.MAIN, 'tag', 'v1.2.3');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

test('deploy authorization is refused while MAIN is dirty outside docs/masterplan', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  write(fx.MAIN, 'src/dirty.txt', 'uncommitted\n');
  assert.throws(() => fx.step({ choice: 'merge' }), /dirty outside docs\/masterplan/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step_authorized'));
  fs.rmSync(path.join(fx.MAIN, 'src', 'dirty.txt'));
  const op = fx.step();
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

test('a foreign commit on MAIN after deploy_base is a base move; a stage commit inside commit_paths is not', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n    - run: /bin/true\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, true);
  op = fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  assert.equal(op.ask, false, 'authorized + started');
  // A commit the STEP produced, touching only CHANGELOG.md (the default commit_paths), is a recorded
  // stage commit: the receipt carries it and the next authorization accepts it.
  write(fx.MAIN, 'CHANGELOG.md', '## 1.0.0\n');
  commitOn(fx.MAIN, 'release: changelog header', 'CHANGELOG.md');
  const stageSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.index, 1);
  assert.equal(op.ask, true, 'index 1 awaits its authorization');
  const receipt = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_step' && e.index === 0);
  assert.deepEqual(receipt.commits, [stageSha], 'the receipt records the step-produced commit');
  // The same CHANGELOG-only commit made by hand while no step runs has no receipt: base moved.
  write(fx.MAIN, 'CHANGELOG.md', '## 1.0.0\n- by hand\n');
  commitOn(fx.MAIN, 'hand-edited changelog', 'CHANGELOG.md');
  assert.throws(() => fx.step({ deployAuthorize: { group: 'release', index: 1 } }), /base moved/);
  // Undo the hand commit without touching the (tracked, uncommitted) bundle ledger: soft reset + restore.
  git(fx.MAIN, 'reset', '-q', '--soft', 'HEAD~1');
  git(fx.MAIN, 'checkout', '-q', 'HEAD', '--', 'CHANGELOG.md');
  op = fx.step({ deployAuthorize: { group: 'release', index: 1 } });
  assert.equal(op.ask, false, 'after the hand commit is gone the authorization proceeds');
  op = fx.step({ deployStepDone: { group: 'release', index: 1, exit: 0 } });
  assert.equal(op.index, 2);
  op = fx.step({ deployAuthorize: { group: 'release', index: 2 } });
  // A commit outside the bundle and commit_paths moved the base: the report is refused, nothing recorded.
  write(fx.MAIN, 'src/foreign.txt', 'x\n');
  commitOn(fx.MAIN, 'foreign change', 'src/foreign.txt');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 2, exit: 0 } }), /base moved/);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step').length, 2, 'index 2 is not recorded');
});

test('a PR that landed as a rebase merge is refused at deploy_base; a squash is accepted', () => {
  const fx = makeFixture({ state: { autonomy: 'loose', worktree_disposition: 'kept_by_user' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  write(fx.WT, 'src/b.txt', 'B\n');
  commitOn(fx.WT, 'task 2');
  const branch = git(fx.WT, 'rev-parse', '--abbrev-ref', 'HEAD');
  const mainBefore = git(fx.MAIN, 'rev-parse', 'HEAD');
  // Rebase-merge emulation: MAIN gains the two branch commits individually.
  const commits = git(fx.MAIN, 'rev-list', '--reverse', `${mainBefore}..${branch}`).split('\n').filter(Boolean);
  for (const c of commits) git(fx.MAIN, 'cherry-pick', c);
  const rebased = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ merged: true, mergeSha: rebased }), /rebase/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'));
  // Squash emulation: one commit carrying the whole branch diff.
  git(fx.MAIN, 'reset', '-q', '--hard', mainBefore);
  git(fx.MAIN, 'merge', '--squash', '-q', branch);
  git(fx.MAIN, 'commit', '-q', '-m', 'squash');
  const squashed = git(fx.MAIN, 'rev-parse', 'HEAD');
  if (!SQUASH_SUPPORTED) { assert.throws(() => fx.step({ merged: true, mergeSha: squashed }), /unsupported/); return; }
  const op = fx.step({ merged: true, mergeSha: squashed });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  const base = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base');
  assert.equal(base.sha, squashed);
  assert.equal(base.branch_tip, git(fx.MAIN, 'rev-parse', branch));
});

test('the final deploy step cannot smuggle a foreign commit past the boundary audit', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  // "the command" commits src/foreign.js and exits 0
  write(fx.MAIN, 'src/foreign.js', 'x\n');
  commitOn(fx.MAIN, 'sneaky', 'src/foreign.js');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'), 'nothing recorded');
  assert.notEqual(readState(fx.statePath).status, 'archived');
});

test('a staged rename out of src into the bundle is dirt outside docs/masterplan', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  git(fx.MAIN, 'mv', 'src/seed.txt', 'docs/masterplan/t24/seed.txt');
  assert.throws(() => fx.step({ deployAuthorize: { group: 'release', index: 0 } }), /dirty outside docs\/masterplan/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step_authorized'));
});

test('a one-commit landing carrying the whole branch diff is the reviewed change, however it was made', () => {
  const fx = makeFixture({ state: { autonomy: 'loose', worktree_disposition: 'kept_by_user' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  const branch = git(fx.WT, 'rev-parse', '--abbrev-ref', 'HEAD');
  const mainBefore = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'cherry-pick', branch); // the single branch commit replayed onto the moved base = its squash
  const rebased = git(fx.MAIN, 'rev-parse', 'HEAD');
  const tip = git(fx.MAIN, 'rev-parse', branch);
  if (!expectSquashOk(mergeIdentity(fx.MAIN, { baseBefore: mainBefore, branchTip: tip, mergeSha: rebased }))) return;
  // and a squash whose message was copied from the branch commit is equally accepted
  git(fx.MAIN, 'reset', '-q', '--hard', mainBefore);
  git(fx.MAIN, 'merge', '--squash', '-q', branch);
  git(fx.MAIN, 'commit', '-q', '-C', branch);
  const copied = git(fx.MAIN, 'rev-parse', 'HEAD');
  expectSquashOk(mergeIdentity(fx.MAIN, { baseBefore: mainBefore, branchTip: git(fx.MAIN, 'rev-parse', branch), mergeSha: copied }));
  git(fx.MAIN, 'reset', '-q', '--hard', mainBefore);
  git(fx.MAIN, 'merge', '--squash', '-q', branch);
  git(fx.MAIN, 'commit', '-q', '-m', 'Merge PR #1 (squash)');
  const op = fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') }); // the one finish call: deploy_base is created once
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

test('an unreachable origin fails the release guard closed', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  git(fx.MAIN, 'remote', 'add', 'origin', path.join(fx.tmp, 'no-such-remote.git'));
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /cannot verify whether v1\.2\.3 already exists on origin/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
});

test('version_not_bumped reports where the tag lives: local only, or local and origin', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  const bare = path.join(fx.tmp, 'origin.git');
  git(fx.tmp, 'init', '-q', '--bare', bare);
  git(fx.MAIN, 'remote', 'add', 'origin', bare);
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  git(fx.MAIN, 'tag', 'v1.2.3');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped');
  assert.deepEqual(op.where, ['local']);
  git(fx.MAIN, 'push', '-q', 'origin', 'v1.2.3');
  op = fx.step({ choice: 'merge' });
  assert.deepEqual(op.where, ['local', 'origin']);
});

test('a rename committed by a running step is a base move (both ends of the rename are audited)', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  git(fx.MAIN, 'mv', 'src/seed.txt', 'docs/masterplan/t24/seed.txt');
  git(fx.MAIN, 'commit', '-q', '-m', 'rename into the bundle');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'));
});

test('a step that rewinds MAIN below the audited head cannot obtain a receipt', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  const base = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base').sha;
  // "the command" rewinds MAIN one commit and adds a bundle-only commit on the rewound history
  const ledger = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8');
  git(fx.MAIN, 'reset', '-q', '--hard', `${base}~1`);
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), ledger); // the ledger survives the fixture's reset
  write(fx.MAIN, 'docs/masterplan/t24/note.md', 'x\n');
  commitOn(fx.MAIN, 'bundle-only on rewound main', 'docs/masterplan/t24/note.md');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'), 'no receipt on rewound history');
});

test('mergeIdentity: a squash onto an advanced base is accepted; whitespace-only and content differences are told apart', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore0 = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-b', 'feature']);
    writeFile(repo, 'feature.txt', 'hello\nworld\n');
    commitAll(repo, 'feature commit');
    const branchTip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', 'main']);
    writeFile(repo, 'base.txt', 'base moved'); // the base advanced in another file
    commitAll(repo, 'main moves');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['merge', '--squash', 'feature']);
    runGit(repo, ['commit', '-m', 'Merge PR (squash)']);
    let res = mergeIdentity(repo, { baseBefore, branchTip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!expectSquashOk(res)) return;
    runGit(repo, ['reset', '--hard', baseBefore]);
    writeFile(repo, 'feature.txt', 'hello \nworld\n');
    commitAll(repo, 'Merge PR (squash, whitespace)');
    res = mergeIdentity(repo, { baseBefore, branchTip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    assert.equal(res.ok, false);
    assert.match(res.reason, /whitespace only/);
    runGit(repo, ['reset', '--hard', baseBefore]);
    writeFile(repo, 'feature.txt', 'hello\nthere\n');
    commitAll(repo, 'Merge PR (squash, content)');
    res = mergeIdentity(repo, { baseBefore, branchTip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    assert.equal(res.ok, false);
    assert.match(res.reason, /content changed/);
    void baseBefore0;
  } finally {
    cleanup(repo);
  }
});

test('a failing step that committed a foreign file is a base move, not a recorded failure', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  write(fx.MAIN, 'src/foreign.js', 'x\n');
  commitOn(fx.MAIN, 'sneaky', 'src/foreign.js');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_failed'), 'no failure recorded for a moved base');
});

test('a failed step\'s legitimate stage commit stays receipted for the retry', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  write(fx.MAIN, 'CHANGELOG.md', '## header\n');
  commitOn(fx.MAIN, 'release: header (then the tag failed)', 'CHANGELOG.md');
  const stageSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  const failed = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_failed');
  assert.deepEqual(failed.commits, [stageSha], 'the failure record carries the produced stage commit');
  op = fx.step({ deployRetry: { group: 'release', index: 0 } }); // the retry's authorization audit accepts the receipted commit
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

test('the local deploy base is proven against the branch tip recorded at retirement', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  const tip = git(fx.WT, 'rev-parse', 'HEAD');
  walkToGate(fx);
  // Make the finish record the retirement but NOT the deploy base: the deploy stage entry throws
  // when MAIN is dirty, so a stray untracked file leaves branch_finish recorded and deploy_base absent.
  write(fx.MAIN, 'src/stray.txt', 'x\n');
  assert.throws(() => fx.step({ choice: 'merge' }), /dirty outside docs\/masterplan/);
  const retire = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  assert.equal(retire.branch_tip, tip);
  assert.equal(retire.merge_sha, git(fx.MAIN, 'rev-list', '-1', '--merges', 'HEAD'), 'the recorded merge is the merge commit (the bundle commit follows it)');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'));
  fs.rmSync(path.join(fx.MAIN, 'src', 'stray.txt'));
  const afterRetire = git(fx.MAIN, 'rev-parse', 'HEAD'); // merge + the bundle commit
  // MAIN moves to an unrelated merge before the deploy base is recorded: refused (not inferred from HEAD)
  git(fx.MAIN, 'checkout', '-q', '-b', 'unrelated');
  write(fx.MAIN, 'src/unrelated.txt', 'u\n');
  commitOn(fx.MAIN, 'unrelated work', 'src/unrelated.txt');
  git(fx.MAIN, 'checkout', '-q', 'main');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', 'unrelated');
  assert.throws(() => fx.step(), /base moved between the merge/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'));
  // back on the recorded merge (plus bundle-only commits) the base is accepted and names the recorded tip
  git(fx.MAIN, 'reset', '-q', '--hard', afterRetire);
  git(fx.MAIN, 'branch', '-q', '-D', 'unrelated');
  const op = fx.step();
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  const base = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base');
  assert.equal(base.branch_tip, tip);
});

test('a PR deploy base is proven against the retirement tip, not the mutable branch ref', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  const tipA = git(fx.WT, 'rev-parse', 'HEAD');
  walkToGate(fx);
  let op = fx.step({ choice: 'pr' });
  assert.equal(op.op, 'shell');
  assert.equal(op.kind, 'push_pr');
  op = fx.step({ choice: 'pr', pushed: true }); // retirement: kept_by_user, branch_tip recorded
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'await_merge', 'a PR with a deploy surface is not archived before the merge');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  const retire = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  assert.equal(retire.branch_tip, tipA);
  assert.equal(readState(fx.statePath).worktree_disposition, 'kept_by_user');
  // the local branch is force-moved to an UNRELATED tip B (not descended from A) after the PR was opened
  const branch = git(fx.WT, 'rev-parse', '--abbrev-ref', 'HEAD');
  const mainBefore = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.WT, 'checkout', '-q', '--detach', mainBefore);
  git(fx.WT, 'branch', '-q', '-f', branch, mainBefore);
  git(fx.WT, 'checkout', '-q', branch);
  write(fx.WT, 'src/b.txt', 'B\n');
  commitOn(fx.WT, 'unreviewed B');
  const tipB = git(fx.WT, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', branch); // "GitHub" merged B
  const mergeB = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ merged: true, mergeSha: mergeB }), /does not carry the retired tip/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'));
  // a merge of the retired tip A is accepted even after the local branch is gone
  git(fx.MAIN, 'reset', '-q', '--hard', mainBefore);
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tipA);
  const mergeA = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT);
  git(fx.MAIN, 'branch', '-q', '-D', branch);
  void tipB;
  op = fx.step({ merged: true, mergeSha: mergeA });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base').branch_tip, tipA);
});

test('a retry is refused before it runs when MAIN was rewound below the last receipt', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  const base = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base').sha;
  write(fx.MAIN, 'CHANGELOG.md', '## header\n');
  commitOn(fx.MAIN, 'release: header', 'CHANGELOG.md');
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  const ledger = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8');
  git(fx.MAIN, 'reset', '-q', '--hard', base); // the receipted stage commit is gone
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), ledger);
  assert.throws(() => fx.step({ deployRetry: { group: 'release', index: 0 } }), /base moved/);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step_authorized').length, 1, 'no fresh authorization on rewound history');
});

test('attestation refuses when MAIN moved while the step was halted (no laundering into receipts)', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' }); // authorized + started (check-less)
  let op = fx.step(); // re-entry: started, never reported → indeterminate gate (no check to probe)
  assert.equal(op.gate, 'deploy_indeterminate');
  write(fx.MAIN, 'CHANGELOG.md', '## laundered\n');
  commitOn(fx.MAIN, 'changelog while halted', 'CHANGELOG.md');
  assert.throws(() => fx.step({ deployAttest: { group: 'release', index: 0 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'), 'nothing attested');
});

test('an unresolvable definition of done on the branch fails closed before PR retirement', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n      bogus: [\n');
  commitOn(fx.WT, 'malformed done block');
  walkToGate(fx);
  const op = fx.step({ choice: 'pr' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /cannot resolve the definition of done/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'no retirement');
  assert.notEqual(readState(fx.statePath).status, 'archived');
});

test('unreadable version metadata fails the release guard closed before the merge', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'done with a version_from that does not exist on the branch');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /cannot read \.claude-plugin\/plugin\.json/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
});

test('mergeIdentity: ancestry is accepted; an inexact merge names the commits beyond the retired tip', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-b', 'feature']);
    writeFile(repo, 'a.txt', 'a');
    commitAll(repo, 'reviewed tip');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    writeFile(repo, 'b.txt', 'b');
    commitAll(repo, 'beyond the tip');
    const beyond = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--no-ff', '-m', 'merge moved ref', 'feature']);
    const res = mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    assert.equal(res.ok, true);
    assert.equal(res.kind, 'merge');
    assert.equal(res.exact, false);
    assert.deepEqual(res.beyond_tip, [beyond]);
  } finally {
    cleanup(repo);
  }
});

test('auditDeployBoundary: file names are taken verbatim, and a version change anywhere is foreign', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'docs/masterplan/run/package.json', JSON.stringify({ version: '1.0.0' }));
    commitAll(repo, 'base');
    const base = runGit(repo, ['rev-parse', 'HEAD']);
    // a root path that only LOOKS like a bundle path once trimmed
    writeFile(repo, ' docs/masterplan/run/evil', 'x');
    commitAll(repo, 'space-prefixed path');
    const evil = runGit(repo, ['rev-parse', 'HEAD']);
    let res = auditDeployBoundary(repo, { from: base, to: evil, bundlePrefix: 'docs/masterplan', commitPaths: ['CHANGELOG.md'], versionFrom: null, expectedVersion: null });
    assert.equal(res.ok, false);
    assert.equal(res.commits[0].kind, 'foreign');
    assert.deepEqual(res.commits[0].files, [' docs/masterplan/run/evil']);
    // a bundle-only commit that bumps a version_from living under the bundle is a version change: foreign
    writeFile(repo, 'docs/masterplan/run/package.json', JSON.stringify({ version: '2.0.0' }));
    commitAll(repo, 'bump inside the bundle');
    const bump = runGit(repo, ['rev-parse', 'HEAD']);
    res = auditDeployBoundary(repo, { from: evil, to: bump, bundlePrefix: 'docs/masterplan', commitPaths: ['CHANGELOG.md'], versionFrom: 'docs/masterplan/run/package.json', expectedVersion: '1.0.0' });
    assert.equal(res.ok, false);
    assert.equal(res.commits[0].kind, 'foreign');
  } finally {
    cleanup(repo);
  }
});

test('a release definition introduced on the base after the branch diverged still opens version_not_bumped', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } }); // the branch was created while the base said done: none
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'base-side release definition');
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  commitOn(fx.WT, 'version file on the branch');
  git(fx.MAIN, 'tag', 'v1.2.3');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v1.2.3');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
});

test('an ad-hoc definition does not relax the PR merge identity proof', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  git(fx.MAIN, 'rm', '-q', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'no done definition on the base');
  git(fx.WT, 'rm', '-q', '.masterplan.yaml');
  git(fx.WT, 'commit', '-q', '-m', 'no done definition on the branch');
  walkToGate(fx);
  let op = fx.step({ choice: 'pr' });
  assert.equal(op.kind, 'push_pr');
  op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge', 'no definition anywhere: the no_definition gate waits at stage entry, after the merge');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  const retire = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  assert.ok(retire.branch_tip);
  // a single-parent commit on the base that does NOT carry the retired tip
  write(fx.MAIN, 'src/unrelated.txt', 'u\n');
  commitOn(fx.MAIN, 'unrelated base commit', 'src/unrelated.txt');
  const wrong = git(fx.MAIN, 'rev-parse', 'HEAD');
  const adhoc = path.join(fx.tmp, 'adhoc.json');
  fs.writeFileSync(adhoc, JSON.stringify({ release: [{ run: '/bin/true' }] }));
  assert.throws(() => fx.step({ merged: true, mergeSha: wrong, doneAdhocFile: adhoc }), /does not carry the retired tip/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'));
  // the real merge of the retired tip reaches the no_definition gate; the ad-hoc definition then deploys
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', retire.branch_tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  const gate = fx.step({ merged: true, mergeSha });
  assert.equal(gate.gate, 'no_definition_of_done', JSON.stringify(gate));
  const deploy = fx.step({ merged: true, mergeSha, doneAdhocFile: adhoc }); // the merge flags stay until deploy_base exists
  assert.equal(deploy.op, 'run_deploy_step', JSON.stringify(deploy));
});

test('the release guard models the three-way merge: a base-side version change is the effective version', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  // common ancestor carries 1.0.0 (before the branch was created it must exist: rewrite the seed on both sides)
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.0.0' }));
  commitOn(fx.MAIN, 'version 1.0.0 on the base');
  git(fx.WT, 'merge', '-q', '--no-edit', 'main'); // the branch now shares the 1.0.0 ancestor and leaves the file alone
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.1.0' }));
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: pkg.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'base bumps to 1.1.0 and adds the release definition');
  git(fx.MAIN, 'tag', 'v1.1.0');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v1.1.0', 'the merge takes the base\'s 1.1.0 because the branch never touched pkg.json');
});

test('the release guard picks the definition the merge keeps: a base-side change of version_from binds', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  // common ancestor: a definition naming old.json (1.0.0); both sides start from it
  write(fx.MAIN, 'old.json', JSON.stringify({ version: '1.0.0' }));
  write(fx.MAIN, 'new.json', JSON.stringify({ version: '2.0.0' }));
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: old.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'ancestor definition (old.json)');
  git(fx.WT, 'merge', '-q', '--no-edit', 'main');
  // the base moves version_from to new.json; the branch leaves .masterplan.yaml alone
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: new.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'base switches version_from to new.json');
  git(fx.MAIN, 'tag', 'v2.0.0'); // the EFFECTIVE version is already tagged; old.json's 1.0.0 is not
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v2.0.0');
});

test('mergeIdentity: a later unrelated merge whose first parent already contains the tip is not the landing', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-b', 'feature']);
    writeFile(repo, 'a.txt', 'a');
    commitAll(repo, 'reviewed tip');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--no-ff', '-m', 'the real landing', 'feature']);
    const landing = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-b', 'unrelated']);
    writeFile(repo, 'u.txt', 'u');
    commitAll(repo, 'unrelated work');
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--no-ff', '-m', 'unrelated merge', 'unrelated']);
    const unrelated = runGit(repo, ['rev-parse', 'HEAD']);
    assert.deepEqual(mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: landing }), { kind: 'merge', ok: true, exact: true, beyond_tip: [] });
    const res = mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: unrelated });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'merge');
    assert.match(res.reason, /first parent already contains the tip/);
  } finally {
    cleanup(repo);
  }
});

test('--merge-sha must be a full commit id: a moving revision cannot become the deploy base', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  const retire = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', retire.branch_tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  for (const bad of ['HEAD', 'main', mergeSha.slice(0, 12), `${mergeSha}^{commit}`]) {
    assert.throws(() => fx.step({ merged: true, mergeSha: bad }), /full \d+-hex commit id/, bad);
  }
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'nothing was persisted');
  const op = fx.step({ merged: true, mergeSha });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base').sha, mergeSha);
});

test('a PR that deletes an inherited done: none waits for the merge and then meets no_definition_of_done', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } }); // the ancestor carries done: none on both sides
  git(fx.WT, 'rm', '-q', '.masterplan.yaml');
  git(fx.WT, 'commit', '-q', '-m', 'the branch drops the definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'pr' });
  assert.equal(op.kind, 'push_pr');
  op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge', 'the merge keeps the deletion: no effective definition, so the run waits');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  const retire = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', retire.branch_tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ merged: true, mergeSha });
  assert.equal(op.gate, 'no_definition_of_done', JSON.stringify(op));
});

test('a PR always waits for the merge: done: none deploys (deploy_base, no groups) at the landing; a base-side surface waits too', () => {
  // branch untouched, base unchanged, done: none on both sides: the run still waits — the deploy
  // base is the merge commit, and the base may change while the PR is open
  let fx = makeFixture({ state: { autonomy: 'loose' } });
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  let op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge', JSON.stringify(op));
  assert.notEqual(readState(fx.statePath).status, 'archived');
  // the base gains a release surface while the PR waits: the landing carries it and it deploys
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'surface added while the PR was open');
  const retire = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', retire.branch_tip);
  op = fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  // and a landing that stays done: none records deploy_base and archives complete-with-no-groups
  fx = makeFixture({ state: { autonomy: 'loose' } });
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  op = fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'deploy_base is recorded under done: none');
  // the base gained a deploy surface after the branch diverged: the merge keeps the base's copy → wait
  fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'base-side surface');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge', JSON.stringify(op));
});

test('mergeIdentity: a fast-forward is exact whatever the tip\'s own parent count (merge and octopus tips)', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    for (const b of ['b1', 'b2']) { runGit(repo, ['checkout', '-q', '-b', b, 'main']); writeFile(repo, `${b}.txt`, b); commitAll(repo, b); }
    runGit(repo, ['checkout', '-q', '-b', 'feature', 'main']);
    writeFile(repo, 'a.txt', 'a');
    commitAll(repo, 'a');
    runGit(repo, ['merge', '--no-ff', '-m', 'feature merges b1', 'b1']); // a two-parent tip
    const twoParent = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', 'main']);
    runGit(repo, ['merge', '--ff-only', 'feature']);
    assert.deepEqual(mergeIdentity(repo, { baseBefore, branchTip: twoParent, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }), { kind: 'merge', ok: true, exact: true, beyond_tip: [] });
    runGit(repo, ['checkout', '-q', 'feature']);
    runGit(repo, ['checkout', '-q', '-b', 'b3', baseBefore]); writeFile(repo, 'b3.txt', 'b3'); commitAll(repo, 'b3'); // from the ancestor: a real third parent
    runGit(repo, ['checkout', '-q', 'feature']);
    runGit(repo, ['merge', '-m', 'octopus', 'b2', 'b3']); // a three-parent tip
    const octopus = runGit(repo, ['rev-parse', 'HEAD']);
    assert.equal(runGit(repo, ['rev-list', '--parents', '-n1', octopus]).split(/\s+/).length, 4, 'three parents');
    runGit(repo, ['checkout', '-q', 'main']);
    runGit(repo, ['merge', '--ff-only', 'feature']);
    assert.deepEqual(mergeIdentity(repo, { baseBefore, branchTip: octopus, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }), { kind: 'merge', ok: true, exact: true, beyond_tip: [] });
  } finally {
    cleanup(repo);
  }
});

test('mergedTree computes the real merge (renames included) and reports conflicts', () => {
  assert.equal(supportsMergeTree({ major: 2, minor: 38, patch: 0 }), true);
  assert.equal(supportsMergeTree({ major: 2, minor: 37, patch: 9 }), false);
  assert.equal(supportsMergeTree({ major: 3, minor: 0, patch: 0 }), true);
  const repo = makeRepo();
  try {
    if (!supportsMergeTree(gitVersion(repo))) { assert.ok(mergedTree(repo, 'HEAD', 'HEAD').unsupported); return; }
    writeFile(repo, 'pkg.json', JSON.stringify({ version: '1.0.0' }));
    commitAll(repo, 'ancestor');
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'pkg.json', JSON.stringify({ version: '2.0.0' }));
    commitAll(repo, 'branch bumps the version');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', 'main']);
    runGit(repo, ['mv', 'pkg.json', 'new.json']);
    commitAll(repo, 'base renames the version file');
    const base = runGit(repo, ['rev-parse', 'HEAD']);
    const merged = mergedTree(repo, base, tip);
    assert.ok(merged.tree, JSON.stringify(merged));
    assert.equal(versionAtRevision(repo, merged.tree, 'new.json'), '2.0.0', 'the branch change follows the rename');
    assert.throws(() => versionAtRevision(repo, merged.tree, 'pkg.json'), /cannot read/);
    // both sides change the same lines differently: a conflict
    writeFile(repo, 'new.json', JSON.stringify({ version: '3.0.0' }));
    commitAll(repo, 'base bumps too');
    assert.deepEqual(mergedTree(repo, runGit(repo, ['rev-parse', 'HEAD']), tip), { conflict: true });
  } finally {
    cleanup(repo);
  }
});

test('the release guard follows a rename: the base renames version_from, the branch bumps the old file', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  if (!supportsMergeTree(gitVersion(fx.MAIN))) return;
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.0.0' }));
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: pkg.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'ancestor: version_from pkg.json @ 1.0.0');
  git(fx.WT, 'merge', '-q', '--no-edit', 'main');
  // the base renames the file and repoints the definition; the branch bumps the OLD path to 2.0.0
  git(fx.MAIN, 'mv', 'pkg.json', 'new.json');
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: new.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'base renames pkg.json to new.json');
  write(fx.WT, 'pkg.json', JSON.stringify({ version: '2.0.0' }));
  commitOn(fx.WT, 'branch bumps to 2.0.0');
  git(fx.MAIN, 'tag', 'v2.0.0'); // the version the MERGE will carry (new.json @ 2.0.0) is already tagged
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v2.0.0');
});

test('a conflicting merge fails the release guard closed and keeps a PR waiting', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  if (!supportsMergeTree(gitVersion(fx.MAIN))) return;
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.0.0' }));
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  version_from: pkg.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'ancestor');
  git(fx.WT, 'merge', '-q', '--no-edit', 'main');
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.1.0' })); commitOn(fx.MAIN, 'base 1.1.0');
  write(fx.WT, 'pkg.json', JSON.stringify({ version: '1.2.0' })); commitOn(fx.WT, 'branch 1.2.0');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.ask, 'dispatch-error', JSON.stringify(op));
  assert.match(op.error, /conflicts/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
});

test('a check that commits is audited before any outcome is recorded; an allowed check commit is receipted', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  const foreign = path.join(fx.tmp, 'check-foreign.sh');
  fs.writeFileSync(foreign, '#!/bin/sh\n[ -z "$CHECK_FOREIGN" ] || git commit -q --allow-empty -m "check moved the base"\nexit ${CHECK_EXIT:-0}\n');
  const allowed = path.join(fx.tmp, 'check-allowed.sh');
  fs.writeFileSync(allowed, '#!/bin/sh\nprintf "## by check\\n" >> CHANGELOG.md\ngit add CHANGELOG.md\ngit commit -q -m "check wrote the changelog"\nexit 0\n');
  for (const f of [foreign, allowed]) fs.chmodSync(f, 0o755);
  write(fx.MAIN, '.masterplan.yaml', `done:\n  release:\n    - run: /bin/true\n      check: ${foreign}\n    - run: /bin/true\n      check: ${allowed}\n`);
  commitOn(fx.MAIN, 'done definition with checks');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  const outcomes = () => readEvents(fx.bundleDir).filter((e) => ['deploy_step', 'deploy_failed', 'deploy_indeterminate', 'deploy_step_check_failed'].includes(e.type));
  // whatever the run and check exit codes, the foreign commit the CHECK made is a base move first
  for (const [runExit, checkExit] of [[0, '0'], [0, '1'], [0, '7'], [1, '0']]) {
    process.env.CHECK_FOREIGN = '1'; process.env.CHECK_EXIT = checkExit;
    try {
      assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: runExit } }), /base moved/, `run ${runExit} check ${checkExit}`);
    } finally { delete process.env.CHECK_FOREIGN; delete process.env.CHECK_EXIT; }
    assert.equal(outcomes().length, 0, 'no outcome recorded');
    git(fx.MAIN, 'reset', '-q', '--soft', 'HEAD~1'); // drop the empty commit; the (tracked, uncommitted) ledger stays
  }
  // a check that behaves: index 0 records; index 1's check commits CHANGELOG.md (commit_paths) — receipted
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'run_deploy_step'); assert.equal(op.index, 1);
  const before = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ deployStepDone: { group: 'release', index: 1, exit: 0 } });
  assert.notEqual(git(fx.MAIN, 'rev-parse', 'HEAD'), before, 'the check committed');
  const receipt = outcomes().find((e) => e.type === 'deploy_step' && e.index === 1);
  assert.ok(receipt, JSON.stringify(outcomes()));
  assert.equal(receipt.commits.length, 1, 'the check-produced stage commit is on the receipt');
  assert.equal(git(fx.MAIN, 'log', '-1', '--format=%s', receipt.commits[0]), 'check wrote the changelog');
  assert.equal(receipt.head_after, receipt.commits[0], 'the audited head is the check commit (the bundle commit that follows is the stage\'s own)');
});

test('the release contract is re-checked at the real deploy base: a version tagged while the PR waited cannot deploy', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  let op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge');
  git(fx.MAIN, 'tag', 'v1.2.3'); // published by someone else while the PR was open
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ merged: true, mergeSha });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.after_merge, true); assert.deepEqual(op.choices, ['keep']); assert.equal(op.tag, 'v1.2.3');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base recorded');
  op = fx.step({ merged: true, mergeSha, choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const inc = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(inc.reason, 'version_not_bumped'); assert.equal(inc.disposition_sha, mergeSha);
});

test('mergeIdentity: a replayed commit series whose net diff equals its last commit is still a rebase; the squash of it is accepted', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'temp.txt', 'scratch'); commitAll(repo, 'C1 adds temp');
    fs.unlinkSync(path.join(repo, 'temp.txt')); commitAll(repo, 'C2 deletes temp');
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, 'C3 adds real');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    const commits = runGit(repo, ['rev-list', '--reverse', `${baseBefore}..${tip}`]).split(/\s+/);
    // the base gains the three commits one by one (a rebase merge)
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'other.txt', 'main moved on'); commitAll(repo, 'base advanced');
    for (const c of commits) runGit(repo, ['cherry-pick', c]);
    const rebased = runGit(repo, ['rev-parse', 'HEAD']);
    let res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: rebased });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
    assert.match(res.reason, /replay the branch/);
    // the SAME branch squashed for real into ONE commit is the reviewed change and is accepted:
    // only a positively established replay (the shape test) is refused
    runGit(repo, ['reset', '-q', '--hard', baseBefore]);
    runGit(repo, ['merge', '--squash', '-q', 'feature']);
    runGit(repo, ['commit', '-q', '-m', 'squash']);
    expectSquashOk(mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }));
    // and the merge of it is accepted by ancestry
    runGit(repo, ['reset', '-q', '--hard', baseBefore]);
    runGit(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);
    assert.equal(mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }).ok, true);
  } finally {
    cleanup(repo);
  }
});

test('local retirement replays across every teardown crash window with the intent record in hand', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  walkToGate(fx);
  const preState = fs.readFileSync(fx.statePath, 'utf8');
  const tip = git(fx.WT, 'rev-parse', 'HEAD');
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const eventsFile = path.join(fx.bundleDir, 'events.jsonl');
  const done = readEvents(fx.bundleDir);
  const intent = done.find((e) => e.type === 'branch_finish_intent');
  const finish = done.find((e) => e.type === 'branch_finish');
  assert.ok(intent && intent.branch_tip === tip, 'the intent carries the tip');
  assert.ok(done.indexOf(intent) < done.indexOf(finish), 'the intent precedes every destructive action');
  assert.equal(finish.branch_tip, tip);
  const mergeSha = finish.merge_sha; // the landing: the tip itself (fast-forward) or a merge of it
  assert.ok(mergeSha === tip || git(fx.MAIN, 'rev-parse', `${mergeSha}^2`) === tip, 'the recorded landing carries the tip');
  const replay = (label) => {
    fs.writeFileSync(fx.statePath, preState); // the disposition write never happened
    const out = fx.step({ choice: 'merge' });
    assert.equal(out.reason, 'archived', `${label}: ${JSON.stringify(out)}`);
    const evs = readEvents(fx.bundleDir);
    const finishes = evs.filter((e) => e.type === 'branch_finish');
    assert.equal(finishes.length, 1, `${label}: exactly one branch_finish`);
    assert.equal(finishes[0].branch_tip, tip, label);
    assert.equal(finishes[0].merge_sha, mergeSha, `${label}: the landing is recovered`);
    assert.equal(evs.filter((e) => e.type === 'branch_finish_intent').length, 1, `${label}: exactly one intent`);
    assert.equal(readState(fx.statePath).worktree_disposition, 'removed_after_merge', label);
  };
  // (a) died after branch_finish, before the disposition write
  replay('after the record');
  // (b) died after the merge + worktree removal + branch deletion, before branch_finish
  fs.writeFileSync(eventsFile, readEvents(fx.bundleDir).filter((e) => e.type !== 'branch_finish').map((e) => JSON.stringify(e)).join('\n') + '\n');
  replay('before the record');
});

test('a done: none PR still proves the landing carries the retired tip', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } }); // the fixture declares done: none
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  let op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge');
  // an unrelated commit on the base — not the landing of the retired tip
  write(fx.MAIN, 'src/unrelated.txt', 'u\n');
  commitOn(fx.MAIN, 'unrelated base commit', 'src/unrelated.txt');
  const wrong = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ merged: true, mergeSha: wrong }), /does not carry the retired tip/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  op = fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
});

test('an authorization recovered from a prior turn is re-audited before the step starts', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step'); assert.equal(op.ask, true);
  op = fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  assert.equal(op.ask, false, 'authorized and started');
  // simulate the crash: drop the started event, keeping the authorization
  const evs = readEvents(fx.bundleDir).filter((e) => e.type !== 'deploy_step_started');
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // MAIN moved while the process was dead
  write(fx.MAIN, 'src/foreign.txt', 'x\n');
  commitOn(fx.MAIN, 'foreign commit while dead', 'src/foreign.txt');
  assert.throws(() => fx.step({}), /base moved|dirty outside/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step_started'), 'the step never started');
  // undo it: the recovered authorization then starts
  git(fx.MAIN, 'reset', '-q', '--soft', 'HEAD~1');
  git(fx.MAIN, 'rm', '-q', '-f', '--cached', 'src/foreign.txt');
  fs.rmSync(path.join(fx.MAIN, 'src', 'foreign.txt'));
  op = fx.step({});
  assert.equal(op.op, 'run_deploy_step'); assert.equal(op.ask, false);
});

test('a retirement replay keeps the landing its intent recorded, not a HEAD that moved after the merge', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  walkToGate(fx);
  const preState = fs.readFileSync(fx.statePath, 'utf8');
  const tip = git(fx.WT, 'rev-parse', 'HEAD');
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived');
  const landing = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').merge_sha;
  const eventsFile = path.join(fx.bundleDir, 'events.jsonl');
  // the crash: branch_finish never landed, and MAIN gained a foreign commit before the replay
  fs.writeFileSync(eventsFile, readEvents(fx.bundleDir).filter((e) => e.type !== 'branch_finish').map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(fx.statePath, preState);
  write(fx.MAIN, 'src/after.txt', 'landed after the merge\n');
  commitOn(fx.MAIN, 'foreign commit after the merge', 'src/after.txt');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const finish = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  assert.equal(finish.merge_sha, landing, 'the recorded landing stands');
  assert.equal(finish.branch_tip, tip);
});

test('mergeIdentity: an empty commit in the replayed series does not defeat the rebase detector', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'temp.txt', 'scratch'); commitAll(repo, 'C1 adds temp');
    runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'C2 empty']);
    fs.unlinkSync(path.join(repo, 'temp.txt')); commitAll(repo, 'C3 deletes temp');
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, 'C4 adds real');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    const commits = runGit(repo, ['rev-list', '--reverse', `${baseBefore}..${tip}`]).split(/\s+/);
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'other.txt', 'main moved on'); commitAll(repo, 'base advanced');
    // the replay DROPS the empty commit (the common case: cherry-pick skips it)
    for (const c of commits) { try { runGit(repo, ['cherry-pick', c]); } catch { runGit(repo, ['cherry-pick', '--skip']); } }
    const res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
  } finally {
    cleanup(repo);
  }
});

test('an ad-hoc definition is bound by the release contract: an already-tagged version cannot deploy', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  git(fx.MAIN, 'rm', '-q', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'no definition on the base');
  git(fx.WT, 'rm', '-q', '.masterplan.yaml');
  write(fx.WT, 'pkg.json', JSON.stringify({ version: '3.0.0' }));
  commitOn(fx.WT, 'no definition on the branch; version 3.0.0');
  git(fx.MAIN, 'tag', 'v3.0.0'); // already published
  const adhoc = path.join(fx.tmp, 'adhoc.json');
  fs.writeFileSync(adhoc, JSON.stringify({ version_from: 'pkg.json', release: [{ run: '/bin/true' }] }));
  walkToGate(fx);
  // before the merge: the ad-hoc definition the caller supplies binds the guard
  let op = fx.step({ choice: 'merge', doneAdhocFile: adhoc });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v3.0.0');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
  // the gate is durable: a later call without the ad-hoc file re-renders it rather than merging
  op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  // a fresh run of the same repository, merged outside the guard, is re-checked at the deploy base
  const fx2 = makeFixture({ state: { autonomy: 'loose' }, slug: 't24b' });
  git(fx2.MAIN, 'rm', '-q', '.masterplan.yaml');
  git(fx2.MAIN, 'commit', '-q', '-m', 'no definition on the base');
  git(fx2.WT, 'rm', '-q', '.masterplan.yaml');
  write(fx2.WT, 'pkg.json', JSON.stringify({ version: '3.0.0' }));
  commitOn(fx2.WT, 'no definition on the branch; version 3.0.0');
  git(fx2.MAIN, 'tag', 'v3.0.0');
  walkToGate(fx2);
  op = fx2.step({ choice: 'merge' }); // no ad-hoc file: no repository definition, nothing to guard
  assert.equal(op.gate, 'no_definition_of_done', JSON.stringify(op));
  op = fx2.step({ doneAdhocFile: adhoc });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.after_merge, true);
  assert.ok(!readEvents(fx2.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base recorded');
});

test('mergeIdentity: an empty commit PRESERVED by the replay is still a rebase', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'C1 empty']);
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, 'C2 adds real');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    const commits = runGit(repo, ['rev-list', '--reverse', `${baseBefore}..${tip}`]).split(/\s+/);
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'other.txt', 'main moved on'); commitAll(repo, 'base advanced');
    for (const c of commits) runGit(repo, ['cherry-pick', '--allow-empty', '--keep-redundant-commits', c]);
    const res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
  } finally {
    cleanup(repo);
  }
});

test('mergeIdentity: an empty net diff is no identity — an unrelated empty commit is not that branch', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'temp.txt', 'scratch'); commitAll(repo, 'adds temp');
    fs.unlinkSync(path.join(repo, 'temp.txt')); commitAll(repo, 'deletes temp'); // net: nothing
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', 'main']);
    runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'an unrelated empty commit on the base']);
    const res = mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.reason, /no patch-id to compare/);
    // the real merge of that branch is still accepted (ancestry, not content)
    runGit(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);
    assert.equal(mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }).ok, true);
  } finally {
    cleanup(repo);
  }
});

test('an ad-hoc release surface is guarded even when the hypothetical merge conflicts', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  git(fx.MAIN, 'rm', '-q', '.masterplan.yaml');
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.0.0' }));
  commitOn(fx.MAIN, 'no definition; version 1.0.0');
  git(fx.WT, 'merge', '-q', '--no-edit', 'main');
  // both sides change pkg.json differently: the hypothetical merge conflicts
  write(fx.MAIN, 'pkg.json', JSON.stringify({ version: '1.1.0' })); commitOn(fx.MAIN, 'base 1.1.0');
  write(fx.WT, 'pkg.json', JSON.stringify({ version: '1.2.0' })); commitOn(fx.WT, 'branch 1.2.0');
  const adhoc = path.join(fx.tmp, 'adhoc.json');
  fs.writeFileSync(adhoc, JSON.stringify({ version_from: 'pkg.json', release: [{ run: '/bin/true' }] }));
  walkToGate(fx);
  const op = fx.step({ choice: 'pr', doneAdhocFile: adhoc });
  assert.equal(op.ask, 'dispatch-error', JSON.stringify(op));
  assert.match(op.error, /conflicts/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'the PR was not retired');
});

test('a replay after the merge but before the intent record keeps the real landing', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  // the base has its own history so the merge is a real merge commit, not a fast-forward
  write(fx.MAIN, 'src/base-side.txt', 'base\n');
  commitOn(fx.MAIN, 'base-side commit', 'src/base-side.txt');
  walkToGate(fx);
  const preState = fs.readFileSync(fx.statePath, 'utf8');
  const preEvents = readEvents(fx.bundleDir);
  const tip = git(fx.WT, 'rev-parse', 'HEAD');
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived');
  const landing = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').merge_sha;
  assert.equal(git(fx.MAIN, 'rev-parse', `${landing}^2`), tip, 'the landing merged the tip');
  // the crash: neither the intent nor the record landed (the merge itself did), the branch survives,
  // and MAIN gains a foreign commit before the replay
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), preEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(fx.statePath, preState);
  git(fx.MAIN, 'branch', '-f', 'masterplan/t24', tip); // the branch survived the crash (deletion comes after)
  const cleanHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  write(fx.MAIN, 'src/after.txt', 'landed after the merge\n');
  commitOn(fx.MAIN, 'foreign commit after the merge', 'src/after.txt');
  // the replay recovers the real landing and then REFUSES the commit that landed after it — the
  // foreign commit is a base move, never laundered into the deploy base by taking HEAD as the merge
  assert.throws(() => fx.step({ choice: 'merge' }), new RegExp(`base moved between the merge ${landing.slice(0, 12)}`));
  // with that commit gone the replay completes, still on the original landing (the bundle files it
  // committed while refusing stay in the tree, uncommitted — the archive commits them)
  git(fx.MAIN, 'reset', '-q', '--soft', cleanHead);
  git(fx.MAIN, 'rm', '-q', '-f', '--cached', 'src/after.txt');
  fs.rmSync(path.join(fx.MAIN, 'src', 'after.txt'));
  op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const finish = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish');
  assert.equal(finish.merge_sha, landing, 'the real landing, not the advanced HEAD');
  assert.equal(finish.branch_tip, tip);
});

test('mergeIdentity: a replay whose prefix cancels is refused — content cannot separate it from a squash', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'temp.txt', 'x'); commitAll(repo, 'C1 adds temp x');
    fs.unlinkSync(path.join(repo, 'temp.txt')); commitAll(repo, 'C2 deletes temp');
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, 'C3 adds real');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    // the base gains a replay whose cancelling prefix has DIFFERENT content (y, not x) and whose
    // last commit is byte-identical to C3 — the patch-id sequence cannot match
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'temp.txt', 'y'); commitAll(repo, "C1' adds temp y");
    fs.unlinkSync(path.join(repo, 'temp.txt')); commitAll(repo, "C2' deletes temp");
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, "C3' adds real");
    // The prefix commits cancel (add y, delete y): that is exactly what a replay leaves behind, and
    // no content test can tell it from a squash landing after net-zero base history. Refused.
    const res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
  } finally {
    cleanup(repo);
  }
});

test('mergeIdentity: a transformed replay whose prefix is emptied and whose last commit carries the whole branch is refused', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'a.txt', 'a'); commitAll(repo, 'C1 adds a');
    writeFile(repo, 'b.txt', 'b'); commitAll(repo, 'C2 adds b');
    const tip = runGit(repo, ['rev-parse', 'HEAD']); // the branch's net diff is a+b, its last commit only b
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'a.txt', 'transformed'); commitAll(repo, "E1: the replayed C1, transformed");
    writeFile(repo, 'a.txt', 'a'); writeFile(repo, 'b.txt', 'b');
    commitAll(repo, 'E2: the replayed C2, carrying the whole branch');
    const res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
    // the honest squash of the same branch, landing on a base that did its own work, is still accepted
    runGit(repo, ['reset', '-q', '--hard', baseBefore]);
    writeFile(repo, 'unrelated.txt', 'base work'); commitAll(repo, 'the base did its own work');
    const onto = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['merge', '--squash', '-q', 'feature']);
    runGit(repo, ['commit', '-q', '-m', 'squash']);
    expectSquashOk(mergeIdentity(repo, { baseBefore: onto, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }));
  } finally {
    cleanup(repo);
  }
});

test('an ordinary keep is not a release override: it neither consults origin nor archives incomplete', () => {
  // a release definition, an already-tagged version, and an UNREACHABLE origin: `keep` retires
  // nothing, so the release contract does not apply to it
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '4.5.6' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  git(fx.MAIN, 'tag', 'v4.5.6');
  git(fx.MAIN, 'remote', 'add', 'origin', path.join(fx.tmp, 'no-such-remote.git'));
  walkToGate(fx);
  const op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized'), 'no incomplete disposition');
  assert.equal(readState(fx.statePath).worktree_disposition, 'kept_by_user');
});

test('keep answers the version gate only after that gate opened, and the answer is durable', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '7.7.7' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  git(fx.MAIN, 'tag', 'v7.7.7');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  const gate = readEvents(fx.bundleDir).find((e) => e.type === 'version_gate');
  assert.equal(gate.phase, 'pre_landing'); assert.equal(gate.tag, 'v7.7.7');
  // a second rendering does not duplicate the record
  fx.step({ choice: 'merge' });
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'version_gate').length, 1);
  op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const inc = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(inc.reason, 'version_not_bumped');
  assert.equal(inc.tag, 'v7.7.7');
});

test('strict identity fails closed when no retirement record carries a tip', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  // a legacy-shaped ledger: the retirement records exist but carry no branch_tip, and the branch is gone
  const evs = readEvents(fx.bundleDir).map((e) => (e.type === 'branch_finish' || e.type === 'branch_finish_intent') ? { ...e, branch_tip: undefined } : e);
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const branch = 'masterplan/t24';
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT);
  git(fx.MAIN, 'branch', '-q', '-D', branch);
  // an unrelated single-parent commit cannot stand in for the branch it never carried
  write(fx.MAIN, 'src/unrelated.txt', 'u\n');
  commitOn(fx.MAIN, 'unrelated', 'src/unrelated.txt');
  assert.throws(() => fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') }), /no retirement identity|needs a recorded retirement tip/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base recorded');
});

test('mergeIdentity: a squash landing after a net-zero base prefix is refused as ambiguous', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'a.txt', 'a'); commitAll(repo, 'C1 adds a');
    writeFile(repo, 'b.txt', 'b'); commitAll(repo, 'C2 adds b');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', 'main']);
    runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'the base did nothing']);
    const onto = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['merge', '--squash', '-q', 'feature']);
    runGit(repo, ['commit', '-q', '-m', 'squash']);
    // Its last two commits (the empty base commit and the squash) carry exactly the branch diff —
    // the same shape a replay leaves — so it is refused; the merge of that branch is the way to land it.
    const res = mergeIdentity(repo, { baseBefore: onto, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
    runGit(repo, ['reset', '-q', '--hard', onto]);
    runGit(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);
    assert.equal(mergeIdentity(repo, { baseBefore: onto, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }).ok, true);
  } finally {
    cleanup(repo);
  }
});

test('a still-present branch ref is not identity: strict PR proof needs the recorded tip', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  // the retirement records lose their branch_tip (a legacy-shaped ledger), but the branch survives
  const evs = readEvents(fx.bundleDir).map((e) => (e.type === 'branch_finish' || e.type === 'branch_finish_intent') ? { ...e, branch_tip: undefined } : e);
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // the branch is force-moved to an unreviewed tip B and "GitHub" merges B
  const branch = 'masterplan/t24';
  write(fx.WT, 'src/unreviewed.txt', 'B\n');
  commitOn(fx.WT, 'unreviewed B', 'src/unreviewed.txt');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', branch);
  assert.throws(() => fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') }), /no retirement identity/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base recorded');
});

test('abort audits the boundary: a foreign commit made while the gate was open is refused', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed', JSON.stringify(op));
  // something else commits into MAIN while the gate is open
  write(fx.MAIN, 'src/foreign.js', 'x\n');
  commitOn(fx.MAIN, 'foreign while halted', 'src/foreign.js');
  assert.throws(() => fx.step({ deployAbort: true }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized'), 'nothing authorized');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  // with the foreign commit gone the abort archives incomplete
  git(fx.MAIN, 'reset', '-q', '--soft', 'HEAD~1');
  git(fx.MAIN, 'rm', '-q', '-f', '--cached', 'src/foreign.js');
  fs.rmSync(path.join(fx.MAIN, 'src', 'foreign.js'));
  op = fx.step({ deployAbort: true });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const inc = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(inc.reason, 'deploy_abort');
});

test('attestation accepts an intervening bundle commit and still refuses foreign history', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  install:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition with a check-less step');
  walkToGate(fx);
  fx.step({ choice: 'merge' }); // authorized + started (check-less)
  let op = fx.step(); // re-entry: started, never reported → the indeterminate gate (no check to probe)
  assert.equal(op.gate, 'deploy_indeterminate', JSON.stringify(op));
  // a bundle-only commit while the gate is open is legal history
  write(fx.MAIN, 'docs/masterplan/other/note.md', 'a sibling bundle wrote its ledger\n');
  commitOn(fx.MAIN, 'bundle commit while halted', 'docs/masterplan/other/note.md');
  const headAfterBundle = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ deployAttest: { group: 'install', index: 0 } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const att = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_step' && e.status === 'attested');
  assert.deepEqual(att.commits, []);
  assert.equal(att.head_after, headAfterBundle, 'the attested head is the audited one');
});

test('attestation refuses an unreceipted commit_paths commit made while the gate was open', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  install:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition with a check-less step');
  walkToGate(fx);
  fx.step({ choice: 'merge' }); // authorized + started (check-less)
  let op = fx.step(); // re-entry: started, never reported → the indeterminate gate
  assert.equal(op.gate, 'deploy_indeterminate', JSON.stringify(op));
  write(fx.MAIN, 'CHANGELOG.md', '## by hand while halted\n');
  commitOn(fx.MAIN, 'hand-edited changelog', 'CHANGELOG.md');
  assert.throws(() => fx.step({ deployAttest: { group: 'install', index: 0 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.status === 'attested'), 'nothing attested');
});

test('a deleted tag does not clear an opened version gate, before or after the merge', () => {
  // pre-landing: the gate opens, the tag is deleted, and the gate still stands until `keep` answers
  let fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '5.5.5' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  git(fx.MAIN, 'tag', 'v5.5.5');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped');
  git(fx.MAIN, 'tag', '-d', 'v5.5.5'); // the tag is deleted — not a version bump
  op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v5.5.5');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
  op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived');
  assert.equal(readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized').tag, 'v5.5.5');
  // after the merge: the deploy-base gate is equally durable
  fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '6.6.6' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  git(fx.MAIN, 'tag', 'v6.6.6'); // published while the PR waited
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ merged: true, mergeSha });
  assert.equal(op.gate, 'version_not_bumped');
  git(fx.MAIN, 'tag', '-d', 'v6.6.6');
  op = fx.step({ merged: true, mergeSha });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base');
  op = fx.step({ merged: true, mergeSha, choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.equal(readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized').tag, 'v6.6.6');
});

test('a done: none PR with a legacy tip-less record still cannot take an unrelated commit as its base', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } }); // the fixture declares done: none
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  // the retirement records lose their tip; the branch survives at the reviewed tip
  const evs = readEvents(fx.bundleDir).map((e) => (e.type === 'branch_finish' || e.type === 'branch_finish_intent') ? { ...e, branch_tip: undefined } : e);
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  write(fx.MAIN, 'src/unrelated.txt', 'u\n');
  commitOn(fx.MAIN, 'unrelated base commit', 'src/unrelated.txt');
  assert.throws(() => fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') }), /does not carry the retired tip|no retirement identity/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base');
  assert.notEqual(readState(fx.statePath).status, 'archived');
});

test('an origin-only tag gate survives an origin outage and keep still answers it', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '8.8.8' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  // v8.8.8 exists ONLY on origin (a bare repo), not locally
  const bare = path.join(fx.tmp, 'origin.git');
  git(fx.tmp, 'init', '-q', '--bare', bare);
  git(fx.MAIN, 'remote', 'add', 'origin', bare);
  git(fx.MAIN, 'push', '-q', 'origin', `${git(fx.MAIN, 'rev-parse', 'HEAD')}:refs/tags/v8.8.8`);
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  let op = fx.step({ merged: true, mergeSha });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.deepEqual(op.where, ['origin']);
  // origin disappears: the recorded gate still renders, and keep still answers it
  fs.renameSync(bare, `${bare}.gone`);
  op = fx.step({ merged: true, mergeSha });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.recorded, true);
  assert.deepEqual(op.where, ['origin']);
  op = fx.step({ merged: true, mergeSha, choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const inc = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(inc.reason, 'version_not_bumped');
  assert.equal(inc.tag, 'v8.8.8');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base');
});

test('a local deploy base with no retirement identity at all cannot prove itself', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  const op0 = fx.step({ choice: 'merge' });
  assert.equal(op0.op, 'run_deploy_step', JSON.stringify(op0));
  // rewind to a resumable retired bundle with NO retirement events and no branch ref, on a
  // single-parent HEAD that has nothing to do with the run
  const evs = readEvents(fx.bundleDir).filter((e) => !['branch_finish', 'branch_finish_intent', 'deploy_base', 'deploy_step_authorized', 'deploy_step_started'].includes(e.type));
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const branch = 'masterplan/t24';
  try { git(fx.MAIN, 'branch', '-q', '-D', branch); } catch { /* already gone */ }
  git(fx.MAIN, 'checkout', '-q', '--orphan', 'unrelated');
  write(fx.MAIN, 'src/only.txt', 'unrelated history\n');
  git(fx.MAIN, 'add', 'src/only.txt'); git(fx.MAIN, 'commit', '-q', '-m', 'an unrelated single-parent history');
  git(fx.MAIN, 'branch', '-q', '-f', 'main', 'HEAD'); git(fx.MAIN, 'checkout', '-q', 'main');
  assert.throws(() => fx.step({}), /no retirement identity/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base recorded');
});

test('with no recorded identity, an unrelated merge cannot certify itself — the branch ref is the only witness', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  const branch = 'masterplan/t24';
  const realTip = git(fx.MAIN, 'rev-parse', branch);
  // every retirement record loses its identity (a legacy-shaped ledger)
  const strip = () => {
    const evs = readEvents(fx.bundleDir).filter((e) => !['branch_finish', 'branch_finish_intent'].includes(e.type));
    fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  strip();
  // an unrelated branch B is merged into the base: its own second parent must not stand in for the run
  git(fx.MAIN, 'checkout', '-q', '-b', 'unrelated-b');
  write(fx.MAIN, 'src/b.txt', 'unrelated\n');
  commitOn(fx.MAIN, 'unrelated work', 'src/b.txt');
  git(fx.MAIN, 'checkout', '-q', 'main');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', 'unrelated-b');
  const mergeOfB = git(fx.MAIN, 'rev-parse', 'HEAD');
  // (1) the real branch ref survives: the merge of B is refused against it
  assert.throws(() => fx.step({ merged: true, mergeSha: mergeOfB }), /does not carry the retired tip/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'no deploy base');
  // (2) the branch ref is gone too: nothing can prove the base, whatever its parent count
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT);
  git(fx.MAIN, 'branch', '-q', '-D', branch);
  strip();
  assert.throws(() => fx.step({ merged: true, mergeSha: mergeOfB }), /no retirement identity|needs a recorded retirement tip/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_base'), 'still no deploy base');
  void realTip;
});

test('a sha256 repository is not rejected by the merge-sha validator', () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sha256-'));
  try {
    const r = execFileSync('git', ['init', '-q', '--object-format=sha256', '--initial-branch=main', probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    void r;
  } catch {
    return; // this git has no sha256 support
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  const fx = makeFixture({ state: { autonomy: 'loose' }, objectFormat: 'sha256' });
  if (git(fx.MAIN, 'rev-parse', '--show-object-format') !== 'sha256') return; // the fixture ignores the option
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'pr' });
  fx.step({ choice: 'pr', pushed: true });
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  assert.equal(tip.length, 64, 'sha256 object ids');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ merged: true, mergeSha: mergeSha.slice(0, 40) }), /full 64-hex commit id/);
  const op = fx.step({ merged: true, mergeSha });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
});

test('a version bump followed by a teardown crash does not resurrect the old gate', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config at 1.0.0');
  git(fx.MAIN, 'tag', 'v1.0.0'); // already published
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped');
  assert.equal(op.tag, 'v1.0.0');
  // the operator bumps to an untagged 2.0.0 and the merge succeeds
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '2.0.0' }));
  commitOn(fx.WT, 'bump to 2.0.0');
  const preState = fs.readFileSync(fx.statePath, 'utf8');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  // the crash: the disposition write never landed, and the branch is already gone
  fs.writeFileSync(fx.statePath, preState);
  op = fx.step({ choice: 'merge' });
  assert.notEqual(op.gate, 'version_not_bumped', JSON.stringify(op));
  // the replay is inside the deploy stage (the step it started is awaiting its report), never back
  // at a release gate the bump already answered
  assert.ok(op.op === 'run_deploy_step' || String(op.gate ?? '').startsWith('deploy_'), JSON.stringify(op));
});

test('a landed merge is never re-gated as pre-landing, even when its version becomes tagged after the crash', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '9.9.9' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config at an untagged 9.9.9');
  walkToGate(fx);
  const preState = fs.readFileSync(fx.statePath, 'utf8');
  const op0 = fx.step({ choice: 'merge' }); // the merge lands and the stage starts
  assert.equal(op0.op, 'run_deploy_step', JSON.stringify(op0));
  const landing = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').merge_sha;
  // the crash: the disposition write is lost, the branch survives, and v9.9.9 appears meanwhile
  fs.writeFileSync(fx.statePath, preState);
  git(fx.MAIN, 'tag', 'v9.9.9');
  const op = fx.step({ choice: 'merge' });
  assert.notEqual(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.ok(!(op.choices || []).includes('fix'), 'no pre-landing fix is offered after the landing');
  // exactly one landing, and it is the recorded one
  const finishes = readEvents(fx.bundleDir).filter((e) => e.type === 'branch_finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].merge_sha, landing);
});

test('skip audits the boundary: a foreign commit made while the failure gate was open is refused', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition with two steps');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step'); assert.equal(op.ask, true);
  op = fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  assert.equal(op.ask, false);
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed', JSON.stringify(op));
  write(fx.MAIN, 'src/foreign.js', 'x\n');
  commitOn(fx.MAIN, 'foreign while the gate was open', 'src/foreign.js');
  assert.throws(() => fx.step({ deploySkip: { group: 'release', index: 0 } }), /base moved/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized'), 'nothing skipped');
  // with that commit gone the skip advances the chain and records the audited head
  git(fx.MAIN, 'reset', '-q', '--soft', 'HEAD~1');
  git(fx.MAIN, 'rm', '-q', '-f', '--cached', 'src/foreign.js');
  fs.rmSync(path.join(fx.MAIN, 'src', 'foreign.js'));
  op = fx.step({ deploySkip: { group: 'release', index: 0 } });
  const skip = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.match(skip.reason, /^deploy_skip:release\[0\]$/);
  assert.equal(skip.head_after, git(fx.MAIN, 'rev-parse', 'HEAD'));
  assert.equal(op.index, 1, JSON.stringify(op));
});

test('an unrelated incomplete authorization does not resolve the PR merge wait', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  commitOn(fx.MAIN, 'done definition');
  walkToGate(fx);
  // an incomplete authorization from an earlier, unrelated override
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify({ type: 'incomplete_authorized', ts: 1, reason: 'verification_waived' }) + '\n');
  fx.step({ choice: 'pr' });
  const op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge', JSON.stringify(op));
  assert.notEqual(readState(fx.statePath).status, 'archived');
  const tip = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tip);
  const after = fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') });
  assert.equal(after.op, 'run_deploy_step', JSON.stringify(after));
});

test('mergeIdentity: a branch whose only prefix commits are empty cannot be landed as a squash', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'C1 empty']);
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, 'C2 adds real');
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    // the base advances on its own, then a rebase merge drops the empty commit and replays only C2
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'other.txt', 'base work'); commitAll(repo, 'independent base work');
    runGit(repo, ['cherry-pick', tip]);
    const res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
    assert.match(res.reason, /only commits before its tip are empty/);
    // the merge of that same branch is accepted by ancestry
    runGit(repo, ['reset', '-q', '--hard', 'HEAD~1']);
    runGit(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);
    assert.equal(mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }).ok, true);
  } finally {
    cleanup(repo);
  }
});

test('mergeIdentity: a branch that ends in an empty commit cannot be landed as a squash either', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'base.txt', 'base');
    commitAll(repo, 'base');
    const baseBefore = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'real.txt', 'real'); commitAll(repo, 'C1 adds real');
    const c1 = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'C2 empty tip']);
    const tip = runGit(repo, ['rev-parse', 'HEAD']);
    // the base advances on its own; the rebase drops the empty tip and replays only C1
    runGit(repo, ['checkout', '-q', 'main']);
    writeFile(repo, 'other.txt', 'base work'); commitAll(repo, 'independent base work');
    runGit(repo, ['cherry-pick', c1]);
    const res = mergeIdentity(repo, { baseBefore: runGit(repo, ['rev-parse', 'HEAD~1']), branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) });
    if (!SQUASH_SUPPORTED) { assert.equal(res.kind, 'unsupported'); return; }
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.kind, 'rebase');
    assert.match(res.reason, /ends in empty commit/);
    // the merge of that same tip is accepted by ancestry
    runGit(repo, ['reset', '-q', '--hard', 'HEAD~1']);
    runGit(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);
    assert.equal(mergeIdentity(repo, { baseBefore, branchTip: tip, mergeSha: runGit(repo, ['rev-parse', 'HEAD']) }).ok, true);
  } finally {
    cleanup(repo);
  }
});

test('a second tagged version opens its own gate, and deleting that tag does not answer it', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
  write(fx.WT, '.masterplan.yaml', 'done:\n  version_from: .claude-plugin/plugin.json\n  release:\n    - run: /bin/true\n');
  commitOn(fx.WT, 'release config at 1.0.0');
  git(fx.MAIN, 'tag', 'v1.0.0');
  git(fx.MAIN, 'tag', 'v2.0.0'); // both versions are already published
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.tag, 'v1.0.0');
  // the operator bumps to 2.0.0 — which is ALSO tagged: a new gate, for the new version
  write(fx.WT, '.claude-plugin/plugin.json', JSON.stringify({ name: 'x', version: '2.0.0' }));
  commitOn(fx.WT, 'bump to 2.0.0');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v2.0.0');
  const gates = readEvents(fx.bundleDir).filter((e) => e.type === 'version_gate');
  assert.deepEqual(gates.map((g) => g.version), ['1.0.0', '2.0.0'], 'each version records its own gate');
  // deleting v2.0.0's tag does not answer the standing gate
  git(fx.MAIN, 'tag', '-d', 'v2.0.0');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'version_not_bumped', JSON.stringify(op));
  assert.equal(op.tag, 'v2.0.0');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'), 'nothing merged');
  op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived');
  assert.equal(readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized').tag, 'v2.0.0');
});

test('bundle-only dirt with quoted paths is not read as dirt outside the bundle', () => {
  const repo = makeRepo();
  try {
    writeFile(repo, 'src/seed.txt', 'seed');
    commitAll(repo, 'seed');
    writeFile(repo, 'docs/masterplan/run/a file with spaces.md', 'x');
    writeFile(repo, 'docs/masterplan/run/quote".md', 'y');
    assert.deepEqual(dirtyOutsideBundle(repo, 'docs/masterplan'), [], 'quoted bundle paths are inside the bundle');
    writeFile(repo, 'src/another file.txt', 'z');
    assert.deepEqual(dirtyOutsideBundle(repo, 'docs/masterplan'), ['src/another file.txt']);
  } finally {
    cleanup(repo);
  }
});
