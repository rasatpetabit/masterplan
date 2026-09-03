// test/config.test.mjs — resolver tests for lib/config.mjs (wave task 16)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseMasterplanYaml,
  resolveRunConfig,
  validateDoneDefinition,
  resolveDoneAtRevision,
  doneDigest,
  substituteVersion,
  readEnv,
  childEnv,
  CONFIG_SCHEMA,
} from '../lib/config.mjs';
import { migrate, effectiveAutonomy } from '../lib/migrate.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function freshDirs() {
  return { home: tmpdir(), repoRoot: tmpdir() };
}

function runConfig({ cli = {}, repo = '', user = '', home, repoRoot }) {
  if (home) writeFile(home, '.masterplan.yaml', user);
  if (repoRoot) writeFile(repoRoot, '.masterplan.yaml', repo);
  return resolveRunConfig({ cli, repoRoot, home, env: {} });
}

test('precedence: CLI > repo > user > default for complexity and autonomy', () => {
  const { home, repoRoot } = freshDirs();
  const user = 'complexity: low\n';
  const repo = 'complexity: medium\n';
  const cli = { complexity: 'high' };
  const { values, sources } = runConfig({ cli, repo, user, home, repoRoot });
  assert.equal(values.complexity, 'high');
  assert.equal(sources.complexity, 'cli');
  assert.equal(values.autonomy, 'gated');
  assert.equal(sources.autonomy, 'default');

  const { home: h2, repoRoot: r2 } = freshDirs();
  const repo2 = 'autonomy: loose\n';
  const { values: v2, sources: s2 } = runConfig({ cli: {}, repo: repo2, user: '', home: h2, repoRoot: r2 });
  assert.equal(v2.autonomy, 'loose');
  assert.equal(s2.autonomy, 'repo');

  const { home: h3, repoRoot: r3 } = freshDirs();
  const user2 = 'autonomy: loose\n';
  const { values: v3, sources: s3 } = runConfig({ cli: {}, repo: '', user: user2, home: h3, repoRoot: r3 });
  assert.equal(v3.autonomy, 'loose');
  assert.equal(s3.autonomy, 'user');
});

test('malformed YAML throws', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'complexity: [low]\n');
  assert.throws(() => resolveRunConfig({ cli: {}, repoRoot, home, env: {} }), /flow collections are not supported/);

  const { home: h2, repoRoot: r2 } = freshDirs();
  writeFile(r2, '.masterplan.yaml', 'context_watch:\n  threshold: 70\n focus: x\n');
  assert.throws(() => resolveRunConfig({ cli: {}, repoRoot: r2, home: h2, env: {} }));
});

test('autonomy: full resolves to loose with deprecation warning', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'autonomy: full\n');
  const { values, warnings } = resolveRunConfig({ cli: {}, repoRoot, home, env: {} });
  assert.equal(values.autonomy, 'loose');
  assert.ok(warnings.some((w) => w.includes("autonomy 'full' is deprecated; use 'loose'")));
});

test('auto_compact alias resolves to context_watch with warning', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'auto_compact:\n  threshold: 80\n');
  const { values, warnings } = resolveRunConfig({ cli: {}, repoRoot, home, env: {} });
  assert.deepEqual(values.context_watch, { threshold: 80, focus: null });
  assert.ok(warnings.some((w) => w.includes('auto_compact is deprecated')));
});

test('context_watch partial defaults: repo sets threshold, focus stays null', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'context_watch:\n  threshold: 80\n');
  const { values } = resolveRunConfig({ cli: {}, repoRoot, home, env: {} });
  assert.deepEqual(values.context_watch, { threshold: 80, focus: null });
});

test('context_watch threshold out of range throws', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'context_watch:\n  threshold: 100\n');
  assert.throws(() => resolveRunConfig({ cli: {}, repoRoot, home, env: {} }), /threshold must be an integer 1–99/);
});

test('invalid enum throws', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'complexity: extreme\n');
  assert.throws(() => resolveRunConfig({ cli: {}, repoRoot, home, env: {} }), /invalid complexity 'extreme'/);
});

test('planning_mode derives from complexity when unset', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'complexity: low\n');
  const { values } = resolveRunConfig({ cli: {}, repoRoot, home, env: {} });
  assert.equal(values.planning_mode, 'serial');

  const { home: h2, repoRoot: r2 } = freshDirs();
  writeFile(r2, '.masterplan.yaml', 'complexity: high\n');
  const { values: v2 } = resolveRunConfig({ cli: {}, repoRoot: r2, home: h2, env: {} });
  assert.equal(v2.planning_mode, 'auto');
});

test('unknown top-level key warns and is ignored', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'bogus: 1\ncomplexity: low\n');
  const { values, warnings } = resolveRunConfig({ cli: {}, repoRoot, home, env: {} });
  assert.equal(values.complexity, 'low');
  assert.ok(warnings.some((w) => w.includes("unsupported key 'bogus'")));
});

test('done only honored from repo; user/CLI done ignored with warning', () => {
  const { home, repoRoot } = freshDirs();
  const userDone = 'done:\n  release:\n    - run: echo hi\n';
  const cliDone = { done: { release: [{ run: 'echo hi' }] } };
  writeFile(home, '.masterplan.yaml', userDone);
  const { values, warnings } = resolveRunConfig({ cli: cliDone, repoRoot, home, env: {} });
  assert.equal(values.done, undefined);
  assert.ok(warnings.some((w) => w.includes('done is only honored from the repo-local')));

  const { home: h2, repoRoot: r2 } = freshDirs();
  writeFile(r2, '.masterplan.yaml', 'done:\n  release:\n    - run: echo hi\n');
  const { values: v2 } = resolveRunConfig({ cli: {}, repoRoot: r2, home: h2, env: {} });
  assert.ok(v2.done);
  assert.equal(v2.done.release[0].run, 'echo hi');
});

test('validateDoneDefinition: none accepted', () => {
  assert.equal(validateDoneDefinition('none'), 'none');
});

test('validateDoneDefinition: user_only step with text/evidence rejected', () => {
  assert.throws(() => validateDoneDefinition({ user_only: [{ text: 'x', evidence: 'y' }] }), /unknown step field 'evidence'|user_only step must be \{text, check\}/);
});

test('validateDoneDefinition: ${version} without version_from rejected', () => {
  assert.throws(() => validateDoneDefinition({ release: [{ run: 'echo ${version}' }] }), /no version_from/);
});

test('validateDoneDefinition: commit_paths outside version_from/changelog warns', () => {
  const warnings = [];
  const done = validateDoneDefinition({ version_from: 'VERSION', commit_paths: ['VERSION', 'CHANGELOG.md', 'other.txt'] }, warnings);
  assert.ok(warnings.some((w) => w.includes("commit_paths entry 'other.txt' is not the version_from file or a changelog")));
});

test('substituteVersion quotes a valid version', () => {
  assert.equal(substituteVersion('echo ${version}', '1.2.3'), "echo '1.2.3'");
});

test('substituteVersion throws on hostile input', () => {
  assert.throws(() => substituteVersion('echo ${version}', '1.2.3; rm -rf /'), /hostile or invalid version/);
});

test('resolveDoneAtRevision reads done at a SHA and computes digest', () => {
  const repoRoot = tmpdir();
  execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
  const yaml = 'done:\n  release:\n    - run: echo hi\n';
  writeFile(repoRoot, '.masterplan.yaml', yaml);
  execFileSync('git', ['-C', repoRoot, 'add', '.masterplan.yaml'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'init'], { stdio: 'ignore' });
  const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { done, digest } = resolveDoneAtRevision(repoRoot, sha, { env: {} });
  assert.ok(done);
  assert.equal(digest, doneDigest(done));

  assert.throws(() => resolveDoneAtRevision(repoRoot, 'deadbeef', { env: {} }), /resolveDoneAtRevision/);
});

test('readEnv reads from injected env object', () => {
  const env = { FOO: 'bar' };
  assert.equal(readEnv('FOO', env), 'bar');
  assert.equal(readEnv('MISSING', env), undefined);
});

test('childEnv merges overrides', () => {
  const env = { A: '1', B: '2' };
  const child = childEnv({ B: '3', C: '4' }, env);
  assert.deepEqual(child, { A: '1', B: '3', C: '4' });
});

test('parseMasterplanYaml rejects __proto__ key', () => {
  assert.throws(() => parseMasterplanYaml('done:\n  release:\n    - __proto__:\n        run: echo injected\n'), /forbidden key/);
});

test('parseMasterplanYaml preserves # in run and quoted string', () => {
  const doc1 = parseMasterplanYaml('done:\n  release:\n    - run: echo foo#bar\n');
  assert.equal(doc1.done.release[0].run, 'echo foo#bar');
  const doc2 = parseMasterplanYaml('a: "x \\"# y\\""\n');
  assert.equal(doc2.a, 'x "# y"');
});

test('context_watch threshold does not produce unsupported key warning', () => {
  const { home, repoRoot } = freshDirs();
  writeFile(repoRoot, '.masterplan.yaml', 'context_watch:\n  threshold: 60\n');
  const { warnings } = resolveRunConfig({ cli: {}, repoRoot, home, env: {} });
  assert.ok(!warnings.some((w) => w.includes('unsupported key')));
});

test('validateDoneDefinition rejects unknown step fields', () => {
  assert.throws(() => validateDoneDefinition({ release: [{ run: 'publish', chek: 'verify' }] }), /unknown step field 'chek'/);
  assert.throws(() => validateDoneDefinition({ user_only: [{ text: 'x', check: 'c', evidence: 'e' }] }), /unknown step field 'evidence'/);
});

test('validateDoneDefinition default commit_paths and filtering', () => {
  const done1 = validateDoneDefinition({ version_from: 'package.json', release: [{ run: 'echo ${version}' }] });
  assert.deepEqual(done1.commit_paths, ['package.json', 'CHANGELOG.md']);
  const warnings = [];
  const done2 = validateDoneDefinition({ version_from: 'package.json', commit_paths: ['package.json', 'secret.txt'], release: [{ run: 'echo ${version}' }] }, warnings);
  assert.deepEqual(done2.commit_paths, ['package.json']);
  assert.ok(warnings.some((w) => w.includes('secret.txt')));
});

test('validateDoneDefinition rejects non-repo-relative version_from', () => {
  assert.throws(() => validateDoneDefinition({ version_from: '../../etc/passwd', release: [{ run: 'echo ${version}' }] }), /repo-relative/);
  assert.throws(() => validateDoneDefinition({ version_from: '/abs/path', release: [{ run: 'echo ${version}' }] }), /repo-relative/);
});

test('resolveDoneAtRevision errors on non-repo and returns undefined for missing file', () => {
  assert.throws(() => resolveDoneAtRevision('/nonexistent/not-a-repo', 'deadbeef', { env: {} }), /resolveDoneAtRevision/);
  const repoRoot = tmpdir();
  execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
  writeFile(repoRoot, 'README.md', 'hello');
  execFileSync('git', ['-C', repoRoot, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'init'], { stdio: 'ignore' });
  const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = resolveDoneAtRevision(repoRoot, sha, { env: {} });
  assert.deepEqual(result, { done: undefined, digest: null });
});

test('parseMasterplanYaml rejects unterminated quotes and decodes YAML escapes', () => {
  assert.throws(() => parseMasterplanYaml('done:\n  release:\n    - run: "echo hi\n'), /unterminated quoted scalar/);
  assert.equal(parseMasterplanYaml('complexity: "lo\\x77"\n').complexity, 'low');
  assert.equal(parseMasterplanYaml('a: "x\\ty"\n').a, 'x\ty');
});

test('parseMasterplanYaml rejects a duplicate key split across an inline and continuation mapping', () => {
  assert.throws(() => parseMasterplanYaml('done:\n  release:\n    - run: echo safe\n      run: echo unsafe\n'), /duplicate key 'run'/);
});

test('parseMasterplanYaml keeps a colon without a following space inside a bare scalar', () => {
  const doc = parseMasterplanYaml('done:\n  version_from: releases/current:version\n  commit_paths:\n    - releases/current:version\n  release:\n    - run: echo ${version}\n');
  assert.equal(doc.done.version_from, 'releases/current:version');
  assert.deepEqual(doc.done.commit_paths, ['releases/current:version']);
  assert.deepEqual(validateDoneDefinition(doc.done).commit_paths, ['releases/current:version']);
});

test('parseMasterplanYaml decodes doubled single quotes and refuses a stray one', () => {
  assert.equal(parseMasterplanYaml("context_watch:\n  focus: 'operator''s goal'\n").context_watch.focus, "operator's goal");
  assert.throws(() => parseMasterplanYaml("a: 'it's'\n"), /unterminated quoted scalar/);
});

test('parseMasterplanYaml refuses a raw quote inside a double-quoted scalar', () => {
  assert.throws(() => parseMasterplanYaml('context_watch:\n  focus: "safe" trailing"\n'), /unterminated quoted scalar/);
  assert.equal(parseMasterplanYaml('context_watch:\n  focus: "a \\"b\\" c"\n').context_watch.focus, 'a "b" c');
});

test('parseMasterplanYaml applies the YAML comment rule to bare and quoted scalars alike', () => {
  assert.equal(parseMasterplanYaml('done:\n  release:\n    - run: echo "hello # world"\n').done.release[0].run, 'echo "hello');
  assert.equal(parseMasterplanYaml('done:\n  release:\n    - run: "echo # x"\n').done.release[0].run, 'echo # x');
  assert.deepEqual(parseMasterplanYaml("list:\n  - 'a # b'\n  - c # comment\n").list, ['a # b', 'c']);
  assert.equal(parseMasterplanYaml('a: "x" # trailing\n').a, 'x');
});

test('migrate passes through schema-9 state preserving legacy fields', () => {
  const yaml = `schema_version: 9
complexity_source: null
predecessor_transcript: null
autonomy: full
complexity: high
planning_mode: null
slug: s
status: in-progress
phase: brainstorm
tasks: []
`;
  const state = migrate(yaml);
  assert.equal(state.schema_version, 9);
  assert.equal(state.complexity_source, null);
  assert.equal(state.predecessor_transcript, null);
  assert.equal(state.autonomy, 'full');
  assert.equal(state.complexity, 'high');
  assert.equal(state.planning_mode, null);
  assert.equal(state.slug, 's');
  assert.equal(state.status, 'in-progress');
  assert.equal(state.phase, 'brainstorm');
  assert.deepEqual(state.tasks, []);
});

test('effectiveAutonomy maps autonomy values', () => {
  assert.equal(effectiveAutonomy({ autonomy: 'full' }), 'loose');
  assert.equal(effectiveAutonomy({ autonomy: 'loose' }), 'loose');
  assert.equal(effectiveAutonomy({ autonomy: 'gated' }), 'gated');
  assert.equal(effectiveAutonomy({ autonomy: null }), 'gated');
  assert.equal(effectiveAutonomy({}), 'gated');
});

test('checked-in .masterplan.yaml loads and validates', () => {
  const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.masterplan.yaml');
  const yaml = fs.readFileSync(configPath, 'utf8');
  const doc = parseMasterplanYaml(yaml);
  assert.equal(doc.done.version_from, '.claude-plugin/plugin.json');
  assert.equal(doc.done.release.length, 1);
  assert.equal(doc.done.install.length, 3);
  assert.equal(doc.done.user_only.length, 2);
  assert.equal(doc.done.live_check.length, 2);
  assert.equal(doc.done.install[0].check, "git ls-remote --exit-code --tags origin refs/tags/v${version} >/dev/null || exit 1");
  const validated = validateDoneDefinition(doc.done);
  assert.ok(validated);
});

test('default commit_paths is metadata-only', () => {
  const done = validateDoneDefinition({ version_from: '.claude-plugin/plugin.json', release: [{ run: 'echo ${version}' }] });
  assert.deepEqual(done.commit_paths, ['.claude-plugin/plugin.json', 'CHANGELOG.md']);
});

test('a user_only step with {text, evidence} is rejected', () => {
  assert.throws(() => validateDoneDefinition({ version_from: '.claude-plugin/plugin.json', user_only: [{ text: 'do it', evidence: 'trust me' }] }), /user_only/);
});

test('the literal ls-remote predicate reports absence as exit 1 against a tagless bare remote', () => {
  const parent = tmpdir();
  const bare = path.join(parent, 'remote.git');
  const repo = path.join(parent, 'repo');
  try {
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo, stdio: 'ignore' });
    const r1 = spawnSync('sh', ['-c', "git ls-remote --exit-code --tags origin refs/tags/v9.9.9 >/dev/null || exit 1"], { cwd: repo });
    assert.equal(r1.status, 1);
    const r2 = spawnSync('sh', ['-c', 'git ls-remote --exit-code --tags origin refs/tags/v9.9.9'], { cwd: repo });
    assert.equal(r2.status, 2);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
