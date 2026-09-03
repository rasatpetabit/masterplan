// test/install-pi.test.mjs — the copy-based Pi install seam (bin/install-pi.mjs).
//
// Contract under test (isolated via --source/--ref/--install-root/--pi-root):
//   - installs an EXACT committed snapshot (git archive — dirty bytes never leak)
//   - content-addressed releases/<sha>/ + atomic `current` symlink swap
//   - skill links repointed under the install root (never left at /srv/dev)
//   - agents registered from the staged release BEFORE current switches
//   - .pi-install.json metadata {version, sha, ref, source, installed_at}
//   - idempotent at the same sha; --check validates a live install read-only
//   - regular-file skill entries are refused without --force
//   - agent deletion in a new release prunes the installed copy (manifest sweep)

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(repoRoot, 'bin/install-pi.mjs');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A minimal source repo carrying every REQUIRED_PATH the installer validates.
function makeSourceRepo() {
  const src = mkdtempTracked(path.join(os.tmpdir(), 'mp-install-src-'));
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  };
  put('commands/masterplan.md', '# masterplan command\nCOMMITTED-MARKER\n');
  put('bin/masterplan.mjs', '// mp bin\n');
  put('bin/doctor.mjs', '// doctor bin\n');
  put('bin/register-pi-agents.mjs', '// registration bin\n');
  put('lib/bundle.mjs', '// bundle lib\n');
  put('agents/mp-x.md', '---\nname: mp-x\ndescription: x\nmodel: frontier\n---\n\nbody\n');
  put('skills/masterplan/SKILL.md', '# skill\n');
  put('skills/masterplan-detect/SKILL.md', '# detect skill\n');
  put('policy/workflow-map.json', '{}\n');
  put('package.json', JSON.stringify({ name: 'masterplan', version: '9.10.0' }, null, 2) + '\n');
  git(src, 'init', '-q', '--initial-branch=main');
  git(src, 'config', 'user.email', 'test@test');
  git(src, 'config', 'user.name', 'test');
  git(src, 'config', 'commit.gpgsign', 'false');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'fixture release');
  return { src, sha: git(src, 'rev-parse', 'HEAD') };
}

function run(opts, env) {
  const args = [INSTALLER, ...opts];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout.trim().split('\n').pop()) };
}

function layout() {
  const base = mkdtempTracked(path.join(os.tmpdir(), 'mp-install-env-'));
  return {
    installRoot: path.join(base, 'share'),
    piRoot: path.join(base, 'pi'),
    args: [`--install-root=${path.join(base, 'share')}`, `--pi-root=${path.join(base, 'pi')}`],
  };
}

test('install-pi: fresh install builds releases/<sha>, current, skill links, metadata, registration', () => {
  const { src, sha } = makeSourceRepo();
  const env = layout();
  const r = run([`--source=${src}`, '--ref=HEAD', ...env.args]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.install_pi, 'installed');
  assert.equal(out.sha, sha);
  assert.equal(out.version, '9.10.0');
  assert.ok(fs.existsSync(path.join(env.installRoot, 'releases', sha, 'commands/masterplan.md')));
  assert.equal(fs.realpathSync(path.join(env.installRoot, 'current')), fs.realpathSync(path.join(env.installRoot, 'releases', sha)));
  for (const name of ['masterplan', 'masterplan-detect']) {
    const link = path.join(env.piRoot, 'agent', 'skills', name);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${name} skill link missing`);
    assert.ok(fs.realpathSync(link).startsWith(fs.realpathSync(env.installRoot)), `${name} must resolve under the install root`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(env.installRoot, '.pi-install.json'), 'utf8'));
  assert.equal(meta.sha, sha);
  assert.equal(meta.version, '9.10.0');
  assert.ok(meta.installed_at);
  // Agents registered from the staged release + manifest adopted.
  assert.ok(fs.existsSync(path.join(env.piRoot, 'agent', 'agents', 'mp-x.md')));
  const manifest = JSON.parse(fs.readFileSync(path.join(env.piRoot, 'agent', 'agents', '.masterplan-managed.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['mp-x.md']);
});

test('install-pi: re-run at the same sha is idempotent', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const r2 = run([`--source=${src}`, ...env.args]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.json().install_pi, 'idempotent');
});

test('install-pi: dirty working-tree bytes never leak into the snapshot', () => {
  const { src, sha } = makeSourceRepo();
  fs.appendFileSync(path.join(src, 'commands/masterplan.md'), 'DIRTY-UNCOMMITTED-EDIT\n');
  const env = layout();
  const r = run([`--source=${src}`, '--ref=HEAD', ...env.args]);
  assert.equal(r.status, 0, r.stderr);
  const installed = fs.readFileSync(path.join(env.installRoot, 'releases', sha, 'commands/masterplan.md'), 'utf8');
  assert.ok(installed.includes('COMMITTED-MARKER'));
  assert.ok(!installed.includes('DIRTY-UNCOMMITTED-EDIT'), 'git archive must snapshot committed bytes only');
});

test('install-pi: --check passes on a healthy install and fails a broken skill link', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const ok = run(['--check', ...env.args]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json().install_pi, 'check_ok');
  // Break a skill link (point it outside the install root).
  const link = path.join(env.piRoot, 'agent', 'skills', 'masterplan');
  fs.unlinkSync(link);
  fs.symlinkSync('/tmp', link);
  const bad = run(['--check', ...env.args]);
  assert.equal(bad.status, 1);
  assert.equal(bad.json().install_pi, 'check_failed');
});

test('install-pi: regular-file skill entry refused without --force, replaced with it', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  fs.mkdirSync(path.join(env.piRoot, 'agent', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(env.piRoot, 'agent', 'skills', 'masterplan'), 'hand-made file');
  const refused = run([`--source=${src}`, ...env.args]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to replace without --force/);
  assert.equal(fs.readFileSync(path.join(env.piRoot, 'agent', 'skills', 'masterplan'), 'utf8'), 'hand-made file');
  const forced = run([`--source=${src}`, '--force', ...env.args]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(fs.lstatSync(path.join(env.piRoot, 'agent', 'skills', 'masterplan')).isSymbolicLink());
});

test('install-pi: a renamed agent in a new release prunes the stale installed copy via the manifest', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  assert.ok(fs.existsSync(path.join(env.piRoot, 'agent', 'agents', 'mp-x.md')));
  // Second release renames the agent (mp-x -> mp-y): the old installed copy
  // must be pruned via the manifest, the new one registered.
  fs.rmSync(path.join(src, 'agents/mp-x.md'));
  fs.writeFileSync(path.join(src, 'agents/mp-y.md'), '---\nname: mp-y\ndescription: y\nmodel: frontier\n---\n\nbody\n');
  fs.writeFileSync(path.join(src, 'commands/masterplan.md'), '# v2\n');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'rename mp-x to mp-y');
  const r2 = run([`--source=${src}`, ...env.args]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.json().install_pi, 'installed');
  assert.ok(!fs.existsSync(path.join(env.piRoot, 'agent', 'agents', 'mp-x.md')), 'stale agent must be pruned');
  assert.ok(fs.existsSync(path.join(env.piRoot, 'agent', 'agents', 'mp-y.md')), 'new agent must be registered');
  const manifest = JSON.parse(fs.readFileSync(path.join(env.piRoot, 'agent', 'agents', '.masterplan-managed.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['mp-y.md']);
});

test('install-pi: --check --expect succeeds when the installed binary reports the expected version', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  // Write a fake version binary into the current release.
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('v9.9.9');\n");
  const r = run(['--check', '--expect=v9.9.9', ...env.args]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.install_pi, 'check_ok');
  assert.equal(out.version, '9.9.9');
});

test('install-pi: --check --expect fails when the installed binary reports a different version', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('v1.0.0');\n");
  const r = run(['--check', '--expect=v9.9.9', ...env.args]);
  assert.equal(r.status, 1);
  const out = r.json();
  assert.equal(out.install_pi, 'check_failed');
  assert.ok(out.problems.some((p) => /expected v9\.9\.9, installed binary reports v1\.0\.0/.test(p)));
});

test('install-pi: --check --expect fails when the installed binary cannot run', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  // Break the installed binary under current (the snapshot check requires the file to exist,
  // so 'missing' is modelled as present-but-unexecutable).
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binPath = path.join(current, 'bin', 'masterplan.mjs');
  fs.writeFileSync(binPath, 'this is not javascript (');
  const r = run(['--check', '--expect=v9.9.9', ...env.args]);
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(r.stdout.trim(), `no stdout; stderr=${r.stderr}`);
  const out = r.json();
  assert.equal(out.install_pi, 'check_failed');
  assert.ok(out.problems.some((p) => /installed binary not executable|current release missing/.test(p)));
});

test('install-pi: --check --expect composes with the fixture install root and pi root', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('v9.9.9');\n");
  const r = run(['--check', '--expect=v9.9.9', ...env.args]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.install_pi, 'check_ok');
  assert.equal(out.version, '9.9.9');
});

test('install-pi: --check --expect requires an exact version match', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('v9.9.9-rc.1');\n");
  const r = run(['--check', '--expect=v9.9.9', ...env.args]);
  assert.equal(r.status, 1);
  const out = r.json();
  assert.equal(out.install_pi, 'check_failed');
  assert.ok(out.problems.some((p) => /expected v9\.9\.9, installed binary reports v9\.9\.9-rc\.1/.test(p)));
});

test('install-pi: --check without roots resolves the install root from HOME', () => {
  const home = mkdtempTracked(path.join(os.tmpdir(), 'mp-install-home-'));
  const r = run(['--check'], { HOME: home });
  assert.equal(r.status, 1);
  const out = r.json();
  assert.ok(out.problems.some((p) => /install root missing/.test(p)));
});

test('install-pi: --check --expect accepts SemVer build metadata exactly', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  fs.mkdirSync(path.join(current, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(current, 'bin', 'masterplan.mjs'), "console.log('v1.2.3+build.7');\n");
  assert.equal(run(['--check', '--expect=v1.2.3+build.7', ...env.args]).status, 0);
  assert.equal(run(['--check', '--expect=v1.2.3', ...env.args]).status, 1);
});
