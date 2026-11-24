// test/resume-brief-hook.test.mjs — doctor check resume-brief-hook: the fleet SessionStart hook
// must invoke resume-brief with --repo-root.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../lib/doctor/resume-brief-hook.mjs';
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

function writePolicy(content) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'resume-brief-hook-'));
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
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'resume-brief-hook-'));
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

test('resume-brief-hook: PASS when a [delegate.<name>] session_start table invokes resume-brief with --repo-root', () => {
  const policyPath = writePolicy(`[delegate.resume_brief]
events = ["session_start"]
command = "node /usr/local/bin/mp resume-brief --repo-root=$CWD"
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: PASS when a [delegate.<name>] session_start table uses an argv array command', () => {
  const policyPath = writePolicy(`[delegate.resume_brief]
events = ["session_start"]
command = ["node", "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD"]
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'resume-brief-hook');
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('resume-brief-hook: WARN when a [delegate.<name>] session_start table lacks --repo-root', () => {
  const policyPath = writePolicy(`[delegate.resume_brief]
events = ["session_start"]
command = ["node", "/usr/local/bin/mp", "resume-brief"]
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /without --repo-root/);
});

test('resume-brief-hook: single-quoted command arrays are commands, not malformed JSON', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = ['node', '/usr/local/bin/mp', 'resume-brief', '--repo-root=$CWD']
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('resume-brief-hook: a multiline command array may use double quotes and a trailing comma', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = [
  "session_start",
]
command = [
  "node",
  "/usr/local/bin/mp",
  "resume-brief",
  "--repo-root=$CWD",
]
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('resume-brief-hook: PASS for single-quoted array element containing # (valid TOML literal string)', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = ['node', '/usr/local/bin/mp', 'resume-brief', '--repo-root=$CWD', 'x # literal']
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));

  // In TOML single-quoted literal strings, backslash is literal (not an escape), so 'x\\' closes cleanly before # comment.
  const backslashPolicy = writePolicy(`[rules.resume_brief]
events = ['session_start']
command = ['node', '/usr/local/bin/mp', 'resume-brief', '--repo-root=$CWD', 'x\\\\'] # trailing comment
`);
  assert.equal(check('/tmp/repo', { policyPath: backslashPolicy })[0].severity, 'PASS');
});

test('resume-brief-hook: PASS for trailing # comment after array', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = ['node', '/usr/local/bin/mp', 'resume-brief', '--repo-root=$CWD'] # trailing comment
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('resume-brief-hook: PASS for legal trailing comma in single-line command array', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = ["node", "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD",]
`);
  const findings = check('/tmp/repo', { policyPath });
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('resume-brief-hook: PASS for single-quoted scalar command with and without #', () => {
  const policyPath = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = 'node /usr/local/bin/mp resume-brief --repo-root=$CWD'
`);
  assert.equal(check('/tmp/repo', { policyPath })[0].severity, 'PASS');

  const policyWithHash = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = 'node /usr/local/bin/mp resume-brief --repo-root=$CWD --tag=#lit' # comment
`);
  assert.equal(check('/tmp/repo', { policyPath: policyWithHash })[0].severity, 'PASS');
});

test('resume-brief-hook: WARN for malformed TOML arrays (missing comma, repeated comma, leading comma, trailing junk)', () => {
  const cases = [
    ['missing comma', '["node" "/usr/local/bin/mp" "resume-brief" "--repo-root=$CWD"]'],
    ['repeated comma', '["node",, "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD"]'],
    ['leading comma', '[,"node", "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD"]'],
    ['trailing junk', '["node", "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD"] junk'],
  ];
  for (const [label, arr] of cases) {
    const policyPath = writePolicy(`[rules.resume_brief]\nevents = ["session_start"]\ncommand = ${arr}\n`);
    const findings = check('/tmp/repo', { policyPath });
    assert.equal(findings[0].severity, 'WARN', `${label} must WARN, got ${JSON.stringify(findings)}`);
  }
});

test('resume-brief-hook: reject invalid TOML basic-string escapes and decode valid Unicode escapes', () => {
  // Invalid TOML escape `\_` must NOT be accepted as `_` (would false-PASS a policy TOML rejects).
  const invalidEvent = writePolicy(`[rules.resume_brief]
events = ["session\\_start"]
command = ["node", "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD"]
`);
  assert.equal(check('/tmp/repo', { policyPath: invalidEvent })[0].severity, 'WARN');

  const invalidCmdScalar = writePolicy(`[rules.resume_brief]
events = ["session_start"]
command = "node /usr/local/bin/mp resume-brief --repo\\_root=$CWD"
`);
  assert.equal(check('/tmp/repo', { policyPath: invalidCmdScalar })[0].severity, 'WARN');

  const invalidSurrogate = writePolicy(`[rules.resume_brief]
events = ["session\\uD800start"]
command = ["node", "/usr/local/bin/mp", "resume-brief", "--repo-root=$CWD"]
`);
  assert.equal(check('/tmp/repo', { policyPath: invalidSurrogate })[0].severity, 'WARN');

  // Valid TOML Unicode escapes (\u005F = '_', \U0000002D = '-') must decode cleanly.
  const validUnicode = writePolicy(`[rules.resume_brief]
events = ["session\\u005Fstart"]
command = ["node", "/usr/local/bin/mp", "resume\\U0000002Dbrief", "--repo-root=$CWD"]
`);
  assert.equal(check('/tmp/repo', { policyPath: validUnicode })[0].severity, 'PASS');
});

test('resume-brief-hook: PASS for [delegate.masterplan_resume_brief] with harness and argv array, and WARN fix names delegate array syntax', () => {
  const passPolicy = writePolicy(`[delegate.masterplan_resume_brief]
events = ["session_start"]
harness = ["claude", "pi"]
command = ["/home/ras/.local/bin/mp", "resume-brief", "--repo-root=."]
`);
  const passFindings = check('/tmp/repo', { policyPath: passPolicy });
  assert.equal(passFindings.length, 1);
  assert.equal(passFindings[0].id, 'resume-brief-hook');
  assert.equal(passFindings[0].severity, 'PASS');
  assert.equal(passFindings[0].fix, null);

  const missingRootPolicy = writePolicy(`[delegate.masterplan_resume_brief]
events = ["session_start"]
harness = ["claude", "pi"]
command = ["/home/ras/.local/bin/mp", "resume-brief"]
`);
  const missingRootFindings = check('/tmp/repo', { policyPath: missingRootPolicy });
  assert.equal(missingRootFindings[0].severity, 'WARN');
  assert.match(missingRootFindings[0].fix, /\[delegate\.masterplan_resume_brief\]/);
  assert.match(missingRootFindings[0].fix, /--repo-root=\./);
  assert.match(missingRootFindings[0].fix, /command array/);

  const missingRulePolicy = writePolicy(`[rules.corrections_nudge]
events = ["session_start"]
`);
  const missingRuleFindings = check('/tmp/repo', { policyPath: missingRulePolicy });
  assert.equal(missingRuleFindings[0].severity, 'WARN');
  assert.match(missingRuleFindings[0].fix, /\[delegate\.masterplan_resume_brief\]/);
  assert.match(missingRuleFindings[0].fix, /command = \["\/home\/ras\/\.local\/bin\/mp", "resume-brief", "--repo-root=\."\]/);
});
