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

test("install-pi: --check --expect succeeds when the release's own metadata reports the expected version", () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  // The binary in the release must RUN and print a version (the run-succeeds half of the
  // probe) — a fake entrypoint stands in for the real one here, mirroring what git
  // archive installed. The version JUDGED is the release's own package.json.
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('→ /masterplan v9.10.0 args: (empty) cwd: x');\n");
  const r = run(['--check', '--expect=v9.10.0', ...env.args]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.install_pi, 'check_ok');
  assert.equal(out.version, '9.10.0');
});

test("install-pi: --check --expect fails when the release metadata reports a different version", () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('→ /masterplan v9.10.0 args: (empty) cwd: x');\n");
  const r = run(['--check', '--expect=v9.9.9', ...env.args]);
  assert.equal(r.status, 1);
  const out = r.json();
  assert.equal(out.install_pi, 'check_failed');
  assert.ok(out.problems.some((p) => /expected v9\.9\.9, the installed release's own metadata reports 9\.10\.0/.test(p)), JSON.stringify(out.problems));
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
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('→ /masterplan v9.10.0 args: (empty) cwd: x');\n");
  const r = run(['--check', '--expect=v9.10.0', ...env.args]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.install_pi, 'check_ok');
  assert.equal(out.version, '9.10.0');
});

test("install-pi: --check --expect requires an exact metadata match", () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  // A pre-release --expect against the release metadata (9.10.0) is not an exact match.
  const r = run(['--check', '--expect=v9.10.0-rc.1', ...env.args]);
  assert.equal(r.status, 1);
  const out = r.json();
  assert.equal(out.install_pi, 'check_failed');
  assert.ok(out.problems.some((p) => /expected v9\.10\.0-rc\.1, the installed release's own metadata reports 9\.10\.0/.test(p)), JSON.stringify(out.problems));
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
  // The entrypoint must RUN (the probe's run-succeeds half) — a banner-printing fake stands in.
  fs.mkdirSync(path.join(current, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(current, 'bin', 'masterplan.mjs'), "console.log('→ /masterplan v1.2.3+build.7 args: (empty) cwd: x');\n");
  // The release's own package.json carries build metadata; the probe matches it exactly.
  const pkg = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
  pkg.version = '1.2.3+build.7';
  fs.writeFileSync(path.join(current, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  assert.equal(run(['--check', '--expect=v1.2.3+build.7', ...env.args]).status, 0, 'the exact metadata matches');
  assert.equal(run(['--check', '--expect=v1.2.3', ...env.args]).status, 1, 'a bare version is not the same release metadata');
});

// ---- the pre-publish review fix round (2026-09-08): findings 3 + 4 ----------------------
//
// Finding 3: --expect must verify the EXECUTING RELEASE'S OWN METADATA, never the host's
// ambient Claude discovery — a stale marketplace on a Claude host previously poisoned the
// Pi probe (the binary's `version` banner resolves readPluginVersion's marketplace/cache
// candidates) and deadlocked the Pi-before-Claude bootstrap order.
test('finding 3 regression: a stale Claude marketplace must NOT affect the Pi --check --expect', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  // The installed release's entrypoint RUNS and prints its own banner (the real masterplan
  // reports its version through readPluginVersion — which CLAUDE_PLUGIN_ROOT pins to the
  // executing release, the trusted "actually-loaded plugin" candidate).
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('→ /masterplan v9.10.0 args: (empty) cwd: x');\n");
  // The reviewer's stale-marketplace fixture: a CLAUDE_CONFIG_DIR whose marketplace carries
  // an OLD version. Under the old probe this poisoned the banner ("installed binary reports
  // ... v9.10.1 (the stale marketplace)"); under the corrected probe it is a SEPARATE
  // surface's concern and the Pi check is unaffected.
  const staleClaude = mkdtempTracked(path.join(os.tmpdir(), 'mp-stale-claude-'));
  const marketplaceDir = path.join(staleClaude, 'plugins', 'marketplaces', 'rasatpetabit-masterplan', '.claude-plugin');
  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.writeFileSync(path.join(marketplaceDir, 'plugin.json'), JSON.stringify({ name: 'masterplan', version: '9.10.1' }));
  const r = run(['--check', '--expect=v9.10.0', ...env.args], { CLAUDE_CONFIG_DIR: staleClaude });
  assert.equal(r.status, 0, `a stale marketplace must not fail the Pi probe: ${r.stdout}${r.stderr}`);
  assert.equal(r.json().install_pi, 'check_ok');
  assert.equal(r.json().version, '9.10.0');
});

test('finding 3 regression: --expect verifies the installed release metadata — a missing/disagreeing release fails by name', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  const binDir = path.join(current, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'masterplan.mjs'), "console.log('→ /masterplan v9.10.0 args: (empty) cwd: x');\n");
  // A wrong --expect is judged against the release's OWN metadata and names it.
  const wrong = run(['--check', '--expect=v10.0.0', ...env.args]);
  assert.equal(wrong.status, 1);
  assert.ok(wrong.json().problems.some((p) => /expected v10\.0\.0, the installed release's own metadata reports 9\.10\.0/.test(p)), JSON.stringify(wrong.json().problems));
  // And a release whose own metadata carries no version fails closed, not silently.
  const pkgPath = path.join(current, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ name: 'masterplan' }, null, 2) + '\n');
  const bare = run(['--check', '--expect=v9.10.0', ...env.args]);
  assert.equal(bare.status, 1, 'a release with no own version fails the probe');
  assert.ok(bare.json().problems.some((p) => /no readable package\.json\/\.claude-plugin\/plugin\.json version/.test(p)), JSON.stringify(bare.json().problems));
});

// Finding 4: --check must require each skill link to resolve to the EXACT current release's
// skill directory AND carry a readable SKILL.md — a link anywhere else, even a valid-looking
// directory, is drift.
test('finding 4 regression: a skill link to an empty wrong-skill directory fails the check by name', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  // Positive control first: the untouched install stays check_ok.
  const ok = run(['--check', ...env.args]);
  assert.equal(ok.status, 0, `the untouched install must stay check_ok: ${ok.stdout}${ok.stderr}`);
  assert.equal(ok.json().install_pi, 'check_ok');
  // The reviewer's scenario: replace the masterplan skill link with a symlink to an EMPTY
  // directory under the install root (previously "resolves under the install root" passed
  // even though the skill has no SKILL.md there).
  const emptySkill = path.join(env.installRoot, 'wrong-skill');
  fs.mkdirSync(emptySkill, { recursive: true });
  const link = path.join(env.piRoot, 'agent', 'skills', 'masterplan');
  fs.unlinkSync(link);
  fs.symlinkSync(emptySkill, link);
  const bad = run(['--check', ...env.args]);
  assert.equal(bad.status, 1, 'a link to an empty dir must fail the check');
  const out = bad.json();
  assert.equal(out.install_pi, 'check_failed');
  assert.ok(
    out.problems.some((p) => /not the current release's skill directory/.test(p)),
    `the drift must name the broken link: ${JSON.stringify(out.problems)}`,
  );
  assert.ok(
    out.problems.some((p) => /SKILL\.md is missing or unreadable/.test(p)),
    `the missing entrypoint must be named too: ${JSON.stringify(out.problems)}`,
  );
});

test('finding 4 regression: a skill link into a STALE release directory is drift', () => {
  const { src } = makeSourceRepo();
  const env = layout();
  assert.equal(run([`--source=${src}`, ...env.args]).status, 0);
  const current = fs.realpathSync(path.join(env.installRoot, 'current'));
  // A second, older-looking release dir with the same skill names: a link into IT passes
  // the old "resolves under the install root" check but is not the current release.
  const staleRelease = path.join(env.installRoot, 'releases', 'deadbeef'.repeat(5));
  fs.mkdirSync(path.join(staleRelease, 'skills', 'masterplan'), { recursive: true });
  fs.writeFileSync(path.join(staleRelease, 'skills', 'masterplan', 'SKILL.md'), '# stale\n');
  const link = path.join(env.piRoot, 'agent', 'skills', 'masterplan');
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(staleRelease, 'skills', 'masterplan'), link);
  const bad = run(['--check', ...env.args]);
  assert.equal(bad.status, 1, 'a link into a stale release is drift');
  assert.ok(
    bad.json().problems.some((p) => /not the current release's skill directory/.test(p)),
    JSON.stringify(bad.json().problems),
  );
  // And the OTHER skill link (untouched, still correct) is not the failure.
  assert.ok(!bad.json().problems.some((p) => p.includes('masterplan-detect')), 'only the drifted link is named');
  void current;
});
