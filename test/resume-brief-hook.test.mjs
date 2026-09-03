// test/resume-brief-hook.test.mjs — doctor check resume-brief-hook: the fleet SessionStart hook
// must invoke resume-brief with --repo-root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../lib/doctor/resume-brief-hook.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function writePolicy(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-brief-hook-'));
  const policyPath = path.join(dir, 'policy.toml');
  fs.writeFileSync(policyPath, content);
  return policyPath;
}

test('resume-brief-hook: PASS when a session_start rule invokes resume-brief with --repo-root', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
order = 40
command = "node /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: WARN when no session_start rule invokes resume-brief', () => {
  const policyPath = writePolicy(`[rules.corrections_nudge]
events = ["session_start"]
order = 20
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /no SessionStart hook rule/);
  assert.ok(findings[0].fix);
});

test('resume-brief-hook: WARN when the resume-brief command lacks --repo-root', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "node /usr/local/bin/mp resume-brief"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /without --repo-root/);
  assert.ok(findings[0].fix);
});

test('resume-brief-hook: SKIP without a warning when the policy file is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-brief-hook-'));
  const policyPath = path.join(dir, 'missing.toml');
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'SKIP');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: WARN when resume-brief is only in a user_prompt_submit rule', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["user_prompt_submit"]
command = "node /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /no SessionStart hook rule/);
  assert.ok(findings[0].fix);
});

test('resume-brief-hook: PASS when a matching rule exists alongside unrelated rules', () => {
  const policyPath = writePolicy(`# comment
[rules.hook_integrity_check]
events = ["session_start"]
harness = ["claude"]
[rules.resume_brief]
events = ["session_start"]
command = "node /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: PASS with multi-line events array', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = [
  "session_start",
]
command = "node /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: PASS with escaped quotes before a comment marker', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "printf \\"x # y\\"; node /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: WARN when command only mentions resume-brief as a substring', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "echo not-resume-brief --repo-rootless"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /no SessionStart hook rule/);
  assert.ok(findings[0].fix);
});

test('resume-brief-hook: auto-discovered by the doctor runner', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync('node', ['bin/doctor.mjs'], { cwd: repoRoot, encoding: 'utf8' });
  assert.ok(result.stdout + result.stderr, 'doctor runner produced no output');
  assert.match(result.stdout + result.stderr, /resume-brief-hook/);
});

test('resume-brief-hook: WARN (not SKIP) when the policy file exists but cannot be read', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  const policyPath = writePolicy('[rules.resume_brief]\nevents = ["session_start"]\n');
  fs.chmodSync(policyPath, 0o000);
  try {
    const findings = check('/tmp/repo', { policyPath });
    assert.equal(findings[0].severity, 'WARN');
    assert.match(findings[0].summary, /unreadable/);
  } finally {
    fs.chmodSync(policyPath, 0o644);
  }
});

test('resume-brief-hook: WARN when resume-brief is only an argument of another program', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "echo resume-brief --repo-root=/tmp"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /no SessionStart hook rule/);
});

test('resume-brief-hook: WARN when the invocation sits inside a shell comment', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "echo hi # /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /no SessionStart hook rule/);
});

test('resume-brief-hook: WARN when the invocation is commented out right after a control operator', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "echo ready;# /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'WARN');
});
