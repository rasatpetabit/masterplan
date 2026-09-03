import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../lib/doctor/no-definition-of-done.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCheck(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  if (content !== null) {
    fs.writeFileSync(path.join(dir, '.masterplan.yaml'), content);
  }
  const findings = check(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return findings;
}

test('absent file -> PASS', () => {
  const findings = runCheck(null);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].summary, 'no repo-local .masterplan.yaml');
});

test('done: none -> PASS', () => {
  const findings = runCheck('done: none\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].summary, 'done: none declared');
});

test('done object -> PASS', () => {
  const findings = runCheck('done:\n  release:\n    - run: echo hi\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].summary, 'definition of done declared');
});

test('no done key -> WARN', () => {
  const findings = runCheck('complexity: low\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.notEqual(findings[0].severity, 'ERROR');
  assert.match(findings[0].summary, /no definition of done/);
});

test('unparseable -> WARN', () => {
  const findings = runCheck('a: [\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /unparseable/);
});

test('doctor auto-discovers no-definition-of-done and exits 0 on WARN', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.masterplan.yaml'), 'complexity: low\n');
  const res = spawnSync(process.execPath, ['bin/doctor.mjs', dir], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout + res.stderr, /no-definition-of-done/);
});
