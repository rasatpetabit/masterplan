// test/git-env-isolation.test.mjs — explicit-repo git calls must ignore inherited
// GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
// GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_PREFIX (e.g. under `git bisect` or git hooks).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDoneAtRevision, gitEnv } from '../lib/config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// Clean env without repo-redirecting GIT_* variables for setting up/inspecting fixtures.
function cleanEnv(extra = {}) {
  const out = { ...process.env };
  delete out.NODE_TEST_CONTEXT;
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
  ]) {
    delete out[k];
  }
  return { ...out, ...extra };
}

function gitClean(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: cleanEnv(),
  }).trim();
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function initRepo(dir, files, { userName = 'repo-user', userEmail = 'repo@example.invalid' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  gitClean(dir, 'init', '-q', '--initial-branch=main');
  gitClean(dir, 'config', 'user.name', userName);
  gitClean(dir, 'config', 'user.email', userEmail);
  gitClean(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    writeFile(dir, rel, content);
  }
  gitClean(dir, 'add', '-A');
  gitClean(dir, 'commit', '-q', '-m', 'initial');
  return gitClean(dir, 'rev-parse', 'HEAD');
}

function snapshotRepoA(repoA) {
  return {
    config: fs.readFileSync(path.join(repoA, '.git', 'config')),
    index: fs.readFileSync(path.join(repoA, '.git', 'index')),
    refs: gitClean(repoA, 'show-ref'),
  };
}

function assertRepoAIntact(repoA, before) {
  const afterSnap = snapshotRepoA(repoA);
  assert.deepEqual(afterSnap.config, before.config, 'repoA .git/config must remain byte-identical');
  assert.deepEqual(afterSnap.index, before.index, 'repoA .git/index must remain byte-identical');
  assert.equal(afterSnap.refs, before.refs, 'repoA refs must remain unchanged');
  const cfgText = afterSnap.config.toString('utf8');
  assert.doesNotMatch(cfgText, /bare\s*=\s*true/i, 'repoA core.bare must not be set to true');
}

function makePoisonedEnv(repoA, extra = {}) {
  return cleanEnv({
    GIT_DIR: path.join(repoA, '.git'),
    GIT_WORK_TREE: repoA,
    GIT_COMMON_DIR: path.join(repoA, '.git'),
    GIT_INDEX_FILE: path.join(repoA, '.git', 'index'),
    ...extra,
  });
}

function makeInstallableFiles(version, marker) {
  return {
    'commands/masterplan.md': `# masterplan\n${marker}\n`,
    'bin/masterplan.mjs': '// mp\n',
    'bin/doctor.mjs': '// doctor\n',
    'bin/register-pi-agents.mjs': '// reg\n',
    'lib/bundle.mjs': '// bundle\n',
    'agents/mp-x.md': '---\nname: mp-x\ndescription: x\nmodel: frontier\n---\n\nbody\n',
    'skills/masterplan/SKILL.md': '# skill\n',
    'skills/masterplan-detect/SKILL.md': '# detect\n',
    'package.json': JSON.stringify({ name: 'masterplan', version }, null, 2) + '\n',
  };
}

test('bin/install-pi.mjs installs repoB (not repoA) when GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE point to repoA', () => {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-git-iso-install-'));
  const repoA = path.join(tmp, 'repoA');
  const repoB = path.join(tmp, 'repoB');
  const shaA = initRepo(repoA, makeInstallableFiles('1.0.0', 'MARKER_A'), { userName: 'userA', userEmail: 'a@example.invalid' });
  const shaB = initRepo(repoB, makeInstallableFiles('2.0.0', 'MARKER_B'), { userName: 'userB', userEmail: 'b@example.invalid' });
  assert.notEqual(shaA, shaB);

  const beforeA = snapshotRepoA(repoA);
  const installRoot = path.join(tmp, 'install');
  const piRoot = path.join(tmp, 'pi');

  const res = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'bin', 'install-pi.mjs'),
      `--source=${repoB}`,
      '--ref=HEAD',
      `--install-root=${installRoot}`,
      `--pi-root=${piRoot}`,
    ],
    { encoding: 'utf8', env: makePoisonedEnv(repoA) },
  );
  assert.equal(res.status, 0, `install-pi failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.sha, shaB, `expected repoB sha ${shaB}, got ${out.sha} (repoA was ${shaA})`);
  assert.equal(out.version, '2.0.0');
  assert.match(fs.readFileSync(path.join(installRoot, 'current', 'commands', 'masterplan.md'), 'utf8'), /MARKER_B/);
  assertRepoAIntact(repoA, beforeA);
});

test('production lib/ git helpers target repoB (not repoA) under poisoned GIT_* env', () => {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-git-iso-lib-'));
  const repoA = path.join(tmp, 'repoA');
  const repoB = path.join(tmp, 'repoB');
  initRepo(repoA, {
    '.masterplan.yaml': 'done:\n  release:\n    - run: echo repoA\n',
    'a.txt': 'a\n',
  }, { userName: 'userA', userEmail: 'a@example.invalid' });
  const shaB = initRepo(repoB, {
    '.masterplan.yaml': 'done:\n  release:\n    - run: echo repoB\n',
    '.claude-plugin/plugin.json': JSON.stringify({ version: '9.9.9' }),
    'b.txt': 'b\n',
  }, { userName: 'userB', userEmail: 'b@example.invalid' });

  const beforeA = snapshotRepoA(repoA);
  const poisoned = makePoisonedEnv(repoA);

  // 1. resolveDoneAtRevision(repoB, shaB, { env: poisoned }) must read repoB's .masterplan.yaml
  const resolved = resolveDoneAtRevision(repoB, shaB, { env: poisoned });
  assert.equal(resolved.done.release[0].run, 'echo repoB');

  // 2. dirtyOutsideBundle(repoB, ...) and pluginRegistryDrift in child process with poisoned env
  fs.writeFileSync(path.join(repoB, 'untracked-in-b.txt'), 'dirty\n');

  const home = path.join(tmp, 'home');
  const pluginsDir = path.join(home, '.claude', 'plugins');
  const mktDir = path.join(pluginsDir, 'marketplaces', 'rasatpetabit-masterplan');
  fs.mkdirSync(path.dirname(mktDir), { recursive: true });
  fs.symlinkSync(repoB, mktDir);
  writeFile(pluginsDir, 'installed_plugins.json', JSON.stringify({
    plugins: {
      'masterplan@rasatpetabit-masterplan': [{ version: '9.9.9', gitCommitSha: shaB }],
    },
  }));

  const probeScript = `
    import assert from 'node:assert/strict';
    import { dirtyOutsideBundle } from ${JSON.stringify(path.join(REPO_ROOT, 'lib', 'finish.mjs'))};
    import { check as pluginRegistryDrift } from ${JSON.stringify(path.join(REPO_ROOT, 'lib', 'doctor', 'plugin-registry-drift.mjs'))};
    const dirty = dirtyOutsideBundle(${JSON.stringify(repoB)}, 'docs/masterplan/x');
    assert.deepEqual(dirty, ['untracked-in-b.txt']);
    const findings = pluginRegistryDrift(${JSON.stringify(repoB)}, { homeDir: ${JSON.stringify(home)} });
    assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
  `;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    encoding: 'utf8',
    env: poisoned,
  });
  assert.equal(probe.status, 0, `lib probe failed: ${probe.stderr}`);
  assertRepoAIntact(repoA, beforeA);
});

test('subprocess running test/intent-rejected.test.mjs under poisoned GIT_* env leaves repoA untouched', () => {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-git-iso-ir-'));
  const repoA = path.join(tmp, 'repoA');
  initRepo(repoA, { 'seed.txt': 'seed\n' }, { userName: 'userA', userEmail: 'a@example.invalid' });
  const beforeA = snapshotRepoA(repoA);

  const res = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-name-pattern=a confirmed deployed run archives as complete',
      path.join(REPO_ROOT, 'test', 'intent-rejected.test.mjs'),
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: makePoisonedEnv(repoA),
    },
  );
  assert.equal(res.status, 0, `intent-rejected subprocess failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /# pass 1\b/, `expected 1 passing subtest, got:\n${res.stdout}`);
  assertRepoAIntact(repoA, beforeA);
});

test('gitEnv strips repo-redirecting vars, preserves GIT_INDEX_FILE by default, and strips it only when stripIndex is true', () => {
  const inputEnv = {
    PATH: '/usr/bin',
    GIT_DIR: '/bad/.git',
    GIT_WORK_TREE: '/bad',
    GIT_COMMON_DIR: '/bad/.git',
    GIT_OBJECT_DIRECTORY: '/bad/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/other/objects',
    GIT_PREFIX: 'sub/',
    GIT_INDEX_FILE: '/tmp/custom.idx',
  };
  const kept = gitEnv({ CUSTOM: '1' }, inputEnv);
  assert.equal(kept.PATH, '/usr/bin');
  assert.equal(kept.CUSTOM, '1');
  assert.equal(kept.GIT_INDEX_FILE, '/tmp/custom.idx');
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) {
    assert.equal(k in kept, false, `${k} must be deleted`);
  }

  const stripped = gitEnv({}, inputEnv, { stripIndex: true });
  assert.equal('GIT_INDEX_FILE' in stripped, false, 'GIT_INDEX_FILE must be deleted when stripIndex: true');

  const overridden = gitEnv({ GIT_INDEX_FILE: '/tmp/override.idx' }, inputEnv, { stripIndex: true });
  assert.equal(overridden.GIT_INDEX_FILE, '/tmp/override.idx', 'explicit overrides must win after stripping');
});

test('ensureSiblingWorktree (lib/dispatch/multi-repo.mjs) strips inherited GIT_INDEX_FILE and leaves repoA untouched', () => {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-git-iso-sibling-'));
  const repoA = path.join(tmp, 'repoA');
  const repoB = path.join(tmp, 'repoB');
  initRepo(repoA, { 'a.txt': 'from A\n' }, { userName: 'userA', userEmail: 'a@example.invalid' });
  initRepo(repoB, { 'b.txt': 'from B\n' }, { userName: 'userB', userEmail: 'b@example.invalid' });
  const beforeA = snapshotRepoA(repoA);
  const poisoned = makePoisonedEnv(repoA);

  const probeScript = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { ensureSiblingWorktree } from ${JSON.stringify(path.join(REPO_ROOT, 'lib/dispatch/multi-repo.mjs'))};
    const res = ensureSiblingWorktree({ siblingMain: ${JSON.stringify(repoB)}, slug: 'iso-wt' });
    assert.equal(res.action, 'create', JSON.stringify(res));
    assert.equal(fs.readFileSync(path.join(res.path, 'b.txt'), 'utf8'), 'from B\\n');
    assert.equal(fs.existsSync(path.join(res.path, 'a.txt')), false);
  `;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    encoding: 'utf8',
    env: poisoned,
  });
  assert.equal(probe.status, 0, `ensureSiblingWorktree probe failed:\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`);
  assertRepoAIntact(repoA, beforeA);
});

test('test/helpers/git-env.mjs runGit and spawnGit still strip poisoned GIT_* vars when opts.env is passed', async () => {
  const { runGit, spawnGit } = await import('./helpers/git-env.mjs');
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-git-iso-helper-'));
  const repoA = path.join(tmp, 'repoA');
  const repoB = path.join(tmp, 'repoB');
  initRepo(repoA, { 'a.txt': 'A\n' });
  initRepo(repoB, { 'b.txt': 'B\n' });
  const shaB = execFileSync('git', ['-C', repoB, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv({}, process.env, { stripIndex: true }) }).trim();
  const poisoned = makePoisonedEnv(repoA);
  assert.equal(runGit(repoB, ['rev-parse', 'HEAD'], { env: poisoned }), shaB);
  const sp = spawnGit(repoB, ['rev-parse', 'HEAD'], { env: poisoned });
  assert.equal(sp.status, 0);
  assert.equal(sp.stdout.trim(), shaB);
});
