// test/verify-output-evidence.test.mjs — finish-bindings-2 (review blocker): verify_output_hash
// is INDEPENDENT evidence. Every pass answer to run_verify — the normal pass AND each reviewed
// override ('proceed anyway (reviewed)' on verification_failed / no_verification_command) —
// REQUIRES --verify-output=<file>; the CLI hashes the file into the binding's
// verify_output_hash, and a pass answer without it is refused (exit 2, message naming the
// flag). For an override the file is the override evidence the shell writes: the failing
// output, or the operator's recorded override answer/reason when there is no command. Every
// new verify_passed therefore carries a CLI-computed verify_output_hash, and the validators
// require the receipt's hash to EQUAL the selected binding's.
//
// Drives the REAL CLI (node bin/masterplan.mjs …) over real git fixtures.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { goalsHash } from '../lib/goals.mjs';
import { writeState } from '../lib/bundle.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const sha256Of = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
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
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function run(args) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const GOALS_MD = [
  'topic: |',
  '  every passing verification carries its output evidence',
  '',
  '## Intent',
  'why: a claimed pass with no evidence behind it is the unearned completion §7.1 exists to stop',
  'outcome: every verify_passed binds a CLI-computed verify_output_hash',
  'done_means: a green suite',
  '',
].join('\n');

function mkFixture({ slug = 'voe' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-voe-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    worktree: WT,
    pending_gate: null,
    active_run: null,
    goals_enabled: true,
    autonomy: 'loose',
    review: { adversary: false },
    concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  write(bundleDir, 'goals.md', GOALS_MD);
  write(bundleDir, 'spec.md', '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  const step = (args) => run(['finish-step', `--state=${statePath}`, ...args]);
  const verifyPassed = () => [...readEvents(bundleDir)].reverse().find((e) => e.type === 'verify_passed')?.data ?? null;
  return { tmp, MAIN, WT, bundleDir, statePath, step, verifyPassed };
}

test('a successful command pass records verify_output_hash = sha256 of the --verify-output file', () => {
  const fx = mkFixture({ slug: 'voe-pass' });
  let op = JSON.parse(fx.step([]).stdout);
  assert.equal(op.op, 'run_verify');
  const vout = path.join(fx.tmp, 'verify-output.txt');
  fs.writeFileSync(vout, '$ node --test test/\n# tests 12\n# pass 12\n# fail 0\n');
  const r = fx.step(['--verify-passed', `--verify-output=${vout}`]);
  assert.equal(r.status, 0, r.stderr);
  const rec = fx.verifyPassed();
  assert.ok(rec, 'the pass appended verify_passed');
  assert.equal(rec.verify_output_hash, sha256Of(fs.readFileSync(vout, 'utf8')), 'the CLI hashed the evidence file');
});

test('a pass answer without --verify-output is refused with exit 2 naming the flag', () => {
  const fx = mkFixture({ slug: 'voe-missing' });
  const op = JSON.parse(fx.step([]).stdout);
  assert.equal(op.op, 'run_verify');
  const r = fx.step(['--verify-passed']);
  assert.equal(r.status, 2, `exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /--verify-output=<file>/, 'the refusal names the flag');
  assert.equal(fx.verifyPassed(), null, 'no verify_passed was appended');
  const st = fs.readFileSync(path.join(fx.bundleDir, 'state.yml'), 'utf8');
  assert.ok(!/verified_sha/.test(st), 'nothing was recorded — refused before any state write');
});

test('a reviewed failure override carries the override evidence: failing output hashed into the binding', () => {
  const fx = mkFixture({ slug: 'voe-fail-override' });
  let op = JSON.parse(fx.step([]).stdout);
  assert.equal(op.op, 'run_verify');
  op = JSON.parse(fx.step(['--verify-failed']).stdout);
  assert.equal(op.gate, 'verification_failed', JSON.stringify(op));
  // 'Proceed anyway (reviewed)': the shell writes the FAILING output as the override evidence
  // and answers with --verify-passed --verify-output=<that file>.
  const failing = path.join(fx.tmp, 'verify-failed-output.txt');
  fs.writeFileSync(failing, 'not ok 1 - the widget test\n# fail 1\n');
  const r = fx.step(['--verify-passed', `--verify-output=${failing}`]);
  assert.equal(r.status, 0, r.stderr);
  op = JSON.parse(r.stdout);
  // The durable verification_failed gate is CLEARED (a re-entry does not re-render it); the
  // op moves past verification (retro / branch_finish), never back to verification_failed.
  assert.notEqual(op.gate, 'verification_failed', 'the verification_failed gate is cleared');
  assert.notEqual(op.op, 'run_verify', 'verification is not re-run');
  const rec = fx.verifyPassed();
  assert.ok(rec, 'the reviewed override recorded verify_passed');
  assert.equal(rec.verify_output_hash, sha256Of(fs.readFileSync(failing, 'utf8')), 'the OVERRIDE evidence is what was hashed');
  // ...and the override without its evidence file is refused exactly like a normal pass.
  const fx2 = mkFixture({ slug: 'voe-fail-override-missing' });
  fx2.step([]);
  fx2.step(['--verify-failed']);
  const r2 = fx2.step(['--verify-passed']);
  assert.equal(r2.status, 2, JSON.stringify(r2));
  assert.match(r2.stderr, /--verify-output=<file>/);
});

test('the no_verification_command override carries the operator recorded answer as evidence', () => {
  const fx = mkFixture({ slug: 'voe-nocmd' });
  let op = JSON.parse(fx.step([]).stdout);
  assert.equal(op.op, 'run_verify');
  // The shell-opened gate (no verify commands found under --autonomy=full).
  const og = run(['open-gate', `--state=${fx.statePath}`, '--id=no_verification_command']);
  assert.equal(og.status, 0, og.stderr);
  op = JSON.parse(fx.step([]).stdout);
  assert.equal(op.gate, 'no_verification_command', JSON.stringify(op));
  // 'Proceed without' = the reviewed 'no verification available' override: the operator's
  // recorded answer/reason is the evidence file.
  const answer = path.join(fx.tmp, 'override-answer.txt');
  fs.writeFileSync(answer, 'operator: proceed without verification — the change is docs-only (AUQ 2026-01-01, reviewed)\n');
  const r = fx.step(['--verify-passed', `--verify-output=${answer}`]);
  assert.equal(r.status, 0, r.stderr);
  const rec = fx.verifyPassed();
  assert.ok(rec, 'the no-command override recorded verify_passed');
  assert.equal(rec.verify_output_hash, sha256Of(fs.readFileSync(answer, 'utf8')), "the operator's recorded override answer is what was hashed");
});

test('an invented verify_output_hash is refused; the binding\'s hash is accepted (equality, never non-empty)', () => {
  // The recorder side of finish-bindings-2, over a CLI-walked binding: the receipt's
  // verify_output_hash must EQUAL the selected binding's CLI-computed value.
  const fx = mkFixture({ slug: 'voe-equality' });
  fx.step([]);
  const vout = path.join(fx.tmp, 'verify-output.txt');
  fs.writeFileSync(vout, 'suite green\n');
  fx.step(['--verify-passed', `--verify-output=${vout}`]);
  const binding = fx.verifyPassed();
  assert.ok(binding?.verify_output_hash, 'the binding carries the CLI-computed hash');
  const finFlags = [
    'record-intent-check', `--state=${fx.statePath}`,
    '--base-sha=' + 'd'.repeat(40), '--deploy-chain-hash=sha256:chain',
  ];
  const digestFile = path.join(fx.tmp, 'live-digest.txt');
  fs.writeFileSync(digestFile, 'the live check observed the deployed surface\n');
  const live = sha256Of(fs.readFileSync(digestFile, 'utf8'));
  const expectedGoalsHash = goalsHash(GOALS_MD); // the canonical run-Intent identity (legacy pin family here)
  const receipt = (voutHash) => JSON.stringify({
    goals_hash: expectedGoalsHash,
    head_sha: binding.head_sha,
    base_diff_hash: binding.base_diff_hash ?? binding.diff_hash,
    verify_output_hash: voutHash,
    clean: true,
    deploy_base_sha: 'd'.repeat(40),
    deploy_chain_hash: 'sha256:chain',
    live_check_digest: live,
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256,
    ts: '2026-01-01T00:00:10Z',
  });
  // A receipt that invents a different (well-formed) hash is refused.
  const invented = run([...finFlags, `--digest-file=${digestFile}`, `--receipt=${receipt('sha256:' + 'e'.repeat(64))}`]);
  assert.notEqual(invented.status, 0, 'an invented verify_output_hash must be refused');
  assert.match(invented.stderr, /verify_output_hash/);
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'goal_check' && e.data?.final === true), false);
  // The binding's own hash is accepted.
  const echoed = run([...finFlags, `--digest-file=${digestFile}`, `--receipt=${receipt(binding.verify_output_hash)}`]);
  assert.equal(echoed.status, 0, echoed.stderr);
});
