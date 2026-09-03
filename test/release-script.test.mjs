import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release.mjs');

function dirname(p) {
  return p.slice(0, p.lastIndexOf('/'));
}

function makeRepo(version) {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.invalid']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  mkdirSync(join(dir, '.claude-plugin'));
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', version }));
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [9.0.0] — 2026-01-01\n\n- initial\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']);
  return dir;
}

function run(dir, version) {
  return spawnSync(process.execPath, [SCRIPT, `--version=${version}`, `--repo=${dir}`], { encoding: 'utf8' });
}

test('invalid versions exit with status 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
  for (const v of ['v1.2', '1.2', '1.2.3; rm']) {
    const res = run(dir, v);
    assert.equal(res.status, 2);
  }
});

test('version files not bumped', () => {
  const dir = makeRepo('9.0.0');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /version files not bumped/);
});

test('successful release', () => {
  const dir = makeRepo('9.1.0');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.tag, 'v9.1.0');
  const show = execFileSync('git', ['-C', dir, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(show, 'CHANGELOG.md');
  const tagType = execFileSync('git', ['-C', dir, 'cat-file', '-t', 'refs/tags/v9.1.0'], { encoding: 'utf8' }).trim();
  assert.equal(tagType, 'tag');
  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[9\.1\.0\]/);
});

test('replay is idempotent', () => {
  const dir = makeRepo('9.1.0');
  run(dir, '9.1.0');
  const before = execFileSync('git', ['-C', dir, 'rev-parse', 'refs/tags/v9.1.0^{commit}'], { encoding: 'utf8' }).trim();
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 0);
  assert.match(res.stderr, /already released/);
  const after = execFileSync('git', ['-C', dir, 'rev-parse', 'refs/tags/v9.1.0^{commit}'], { encoding: 'utf8' }).trim();
  assert.equal(after, before);
});

test('foreign tag fails', () => {
  const dir = makeRepo('9.1.0');
  execFileSync('git', ['-C', dir, 'tag', '-a', 'v9.1.0', '-m', 'v9.1.0']);
  writeFileSync(join(dir, 'extra.txt'), 'x');
  execFileSync('git', ['-C', dir, 'add', 'extra.txt']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'extra']);
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /foreign tag/);
});

test('lightweight tag at HEAD is foreign', () => {
  const dir = makeRepo('9.1.0');
  execFileSync('git', ['-C', dir, 'tag', 'v9.1.0']);
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /foreign tag/);
});

test('prerelease header does not satisfy release', () => {
  const dir = makeRepo('9.1.0');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [9.1.0-beta.1] — 2026-01-01\n\n- beta\n');
  execFileSync('git', ['-C', dir, 'add', 'CHANGELOG.md']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'beta']);
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 0);
  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[9\.1\.0\]/);
});

test('README version mismatch fails', () => {
  const dir = makeRepo('9.1.0');
  writeFileSync(join(dir, 'README.md'), 'Current release: **v9.0.0**\n');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /version files not bumped/);
});

test('dirty paths fail', () => {
  const dir = makeRepo('9.1.0');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [9.1.0] — 2026-01-01\n\n- dirty\n');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /dirty paths/);
});

test('malformed package.json fails', () => {
  const dir = makeRepo('9.1.0');
  writeFileSync(join(dir, 'package.json'), '{');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /version files not bumped/);
});

test('package.json without version fails', () => {
  const dir = makeRepo('9.1.0');
  writeFileSync(join(dir, 'package.json'), '{}');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /version files not bumped/);
});

test('README without marker fails', () => {
  const dir = makeRepo('9.1.0');
  writeFileSync(join(dir, 'README.md'), 'No marker here\n');
  const res = run(dir, '9.1.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /version files not bumped/);
});

test('invalid semver versions exit with status 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
  for (const v of ['01.2.3', '1.2.3-alpha..1']) {
    const res = run(dir, v);
    assert.equal(res.status, 2);
  }
});
