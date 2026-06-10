// test/finish-step.test.mjs — finishStep: the §2c finalization flow in code (T2.4).
// REAL git in temp repos (the wave-commit.test.mjs pattern): the module's value is the exact
// interleaving of atomic state writes with -C-qualified local git, so tests exercise genuine
// MAIN+worktree pairs. Coverage is the plan-mandated re-entry-at-every-boundary set: each op
// boundary is exercised both fresh and as a resume (a death between any two steps must land
// back on the same op, never re-run a completed transaction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { finishStep } from '../lib/finish-step.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';

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
function makeFixture({ slug = 't24', state: over = {}, ownerLockOff = false, verifyCommands = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-finishstep-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
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
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
    ...(ownerLockOff ? { concurrency: { owner_lock: 'off' } } : {}),
    ...over,
  });
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

test('happy path: run_verify → write_retro → branch_finish gate → merge → archived', () => {
  const fx = makeFixture({ verifyCommands: ['node --test x'] });

  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  assert.deepEqual(op.commands, ['node --test x']);
  assert.equal(op.head, git(fx.WT, 'rev-parse', 'HEAD'));

  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  assert.equal(readState(fx.statePath).verified_sha, git(fx.WT, 'rev-parse', 'HEAD'));
  fs.writeFileSync(op.path, '# retro\n');

  op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.base, 'main');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'branch_finish');
  assert.equal(op.dispositions.merge, 'removed_after_merge');

  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'archived');
  const st = readState(fx.statePath);
  assert.equal(st.status, 'archived');
  assert.equal(st.worktree_disposition, 'removed_after_merge');
  assert.equal(st.pending_gate, null);
  // the merge really landed in MAIN, the worktree is gone, the branch retired
  assert.equal(fs.readFileSync(path.join(fx.MAIN, 'src/a.txt'), 'utf8'), 'A\n');
  assert.equal(fs.existsSync(fx.WT), false);
  assert.ok(!git(fx.MAIN, 'branch', '--format=%(refname:short)').includes('masterplan/'));
  // archive committed the bundle; owner lock released
  assert.match(git(fx.MAIN, 'log', '-1', '--format=%s'), /archive run/);
  assert.equal(fs.existsSync(path.join(fx.bundleDir, '.owner.lock')), false);
  // events: branch_finish recorded with the choice
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish' && e.note === 'merge'));
});

test('re-entry at every boundary: each op is stable until its answer arrives', () => {
  const fx = makeFixture();
  // boundary 1: verification pending — repeat call returns the same op (no state change)
  assert.equal(fx.step().op, 'run_verify');
  assert.equal(fx.step().op, 'run_verify');
  // boundary 2: verified, retro pending — repeated write_retro until the file exists
  let op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  assert.equal(fx.step().op, 'write_retro', 'retro absence re-checked from fs, no flag needed');
  fs.writeFileSync(op.path, '# retro\n');
  // boundary 3: gate open — re-entry re-renders the SAME gate (idempotent open)
  assert.equal(fx.step().gate, 'branch_finish');
  assert.equal(fx.step().gate, 'branch_finish');
  // boundary 4: verified-at-SHA survives — clearing the gate and re-walking skips verify+retro
  const cleared = { ...readState(fx.statePath), pending_gate: null };
  writeState(fx.statePath, cleared);
  op = fx.step();
  assert.equal(op.gate, 'branch_finish', 'verify and retro both skipped on re-walk');
});

test('verify fail opens the durable verification_failed gate; pass override resolves it', () => {
  const fx = makeFixture();
  assert.equal(fx.step().op, 'run_verify');
  let op = fx.step({ verify: 'fail' });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'verification_failed');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'verification_failed');
  // re-entry with no answer re-renders the gate, not run_verify (the durable marker outranks)
  op = fx.step();
  assert.equal(op.gate, 'verification_failed');
  // "Proceed anyway (reviewed)" = --verify-passed: records the SHA AND clears the gate
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  assert.equal(readState(fx.statePath).pending_gate, null);
  assert.equal(readState(fx.statePath).verified_sha, git(fx.WT, 'rev-parse', 'HEAD'));
});

test('dirty task-scope paths commit in WT before verification; unrelated dirt untouched', () => {
  const fx = makeFixture();
  write(fx.WT, 'src/a.txt', 'A2\n'); // task scope
  write(fx.WT, 'notes.txt', 'user-owned\n'); // unrelated
  const before = git(fx.WT, 'rev-parse', 'HEAD');
  const op = fx.step();
  assert.equal(op.op, 'run_verify');
  assert.notEqual(op.head, before, 'dirty-commit moved HEAD; run_verify sees the new commit');
  const porcelain = git(fx.WT, 'status', '--porcelain');
  assert.ok(!porcelain.includes('src/a.txt'), 'task scope committed');
  assert.ok(porcelain.includes('notes.txt'), 'unrelated dirt left alone (protect-user-work)');
  // verified_sha from BEFORE the dirty-commit must not skip verification of the new commit
  writeState(fx.statePath, { ...readState(fx.statePath), verified_sha: before });
  assert.equal(fx.step().op, 'run_verify', 'stale verified SHA does not skip the fresh commit');
});

test('codex review: armed → run_codex_review once; done-event is the durable re-entry guard', () => {
  const fx = makeFixture({ state: { codex: { review: 'on' } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  let op = fx.step();
  assert.equal(op.op, 'run_codex_review');
  assert.equal(op.base, 'main');
  // resume before the answer lands → the SAME op (no event yet at this HEAD)
  assert.equal(fx.step().op, 'run_codex_review');
  // the answer: event written by finish-step (digest via file — shell-safe transport)
  const digestFile = path.join(fx.bundleDir, 'codex-review-digest.txt');
  fs.writeFileSync(digestFile, 'P2: tighten the thing\n');
  op = fx.step({ codex: 'done', codexCount: 1, codexBase: 'main', codexDigestFile: digestFile });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.codex.count, 1, 'gate AUQ carries the rehydrated digest');
  assert.equal(op.codex.digest, 'P2: tighten the thing\n');
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'codex_review');
  assert.match(ev.summary, /codex review complete/);
  assert.equal(ev.data.sha, git(fx.WT, 'rev-parse', 'HEAD'));
  // re-entry after gate cleared: durable event at unchanged HEAD → review NOT re-run
  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: null });
  op = fx.step();
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.codex.present, true);
});

test('codex review skip: durable skip event at SHA prevents a re-ask loop; suppression never arms', () => {
  const fx = makeFixture({ state: { codex: { review: true } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx.step().op, 'run_codex_review');
  const op = fx.step({ codex: 'skipped', codexReason: 'companion unresolved' });
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.codex, null);
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'codex_review_skipped');
  assert.match(ev.summary, /codex-companion review skipped \(degraded\) — companion unresolved/);
  // re-walk: the sha-keyed skip event suppresses another run_codex_review
  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: null });
  assert.equal(fx.step().gate, 'branch_finish');

  // suppression (Codex hosting): never returns run_codex_review at all
  const fx2 = makeFixture({ slug: 't24s', state: { codex: { review: 'on' } } });
  fx2.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx2.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx2.step({ codexSuppressed: true }).gate, 'branch_finish');
});

test('discard: forced teardown, branch -D, kept dirt discarded, archived', () => {
  const fx = makeFixture();
  write(fx.WT, 'notes.txt', 'unsaved\n'); // dirty WT — discard must still remove (--force)
  walkToGate(fx);
  const op = fx.step({ choice: 'discard' });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'archived');
  assert.equal(fs.existsSync(fx.WT), false);
  assert.equal(fs.existsSync(path.join(fx.MAIN, 'src/a.txt')), false, 'nothing merged');
  assert.equal(readState(fx.statePath).worktree_disposition, 'removed_after_merge');
});

test('pr: records kept_by_user, returns the push_pr shell op; next call archives', () => {
  const fx = makeFixture();
  walkToGate(fx);
  let op = fx.step({ choice: 'pr' });
  assert.equal(op.op, 'shell');
  assert.equal(op.kind, 'push_pr');
  assert.equal(op.branch, 'masterplan/t24');
  assert.equal(op.base, 'main');
  const st = readState(fx.statePath);
  assert.equal(st.worktree_disposition, 'kept_by_user');
  assert.equal(st.pending_gate, null);
  assert.ok(fs.existsSync(fx.WT), 'pr keeps the worktree');
  // the shell pushed (network, out of scope) → re-call archives via the retirement shortcut
  op = fx.step();
  assert.equal(op.reason, 'archived');
  assert.equal(readState(fx.statePath).status, 'archived');
});

test('keep: kept_by_user, worktree + branch survive, archived in the same call', () => {
  const fx = makeFixture();
  walkToGate(fx);
  const op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived');
  assert.ok(fs.existsSync(fx.WT));
  assert.equal(readState(fx.statePath).worktree_disposition, 'kept_by_user');
});

test('retirement shortcut: disposition already retired archives with NO WT git (WT gone)', () => {
  const fx = makeFixture();
  // simulate the prior-turn teardown: WT removed + disposition recorded, death before archive
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT);
  writeState(fx.statePath, { ...readState(fx.statePath), worktree_disposition: 'removed_after_merge' });
  const op = fx.step();
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'archived');
  assert.equal(readState(fx.statePath).status, 'archived');
  // archive is idempotent — a replayed call stays terminal
  assert.equal(fx.step().reason, 'archived');
});

test('merge conflict: aborts cleanly, surfaces dispatch-error, gate stays open', () => {
  const fx = makeFixture();
  walkToGate(fx);
  // make MAIN conflict with the branch
  write(fx.MAIN, 'src/a.txt', 'CONFLICT\n');
  git(fx.MAIN, 'add', '.');
  git(fx.MAIN, 'commit', '-q', '-m', 'conflicting main work');
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /merge of masterplan\/t24/);
  assert.equal(git(fx.MAIN, 'status', '--porcelain'), '', 'merge aborted, MAIN clean');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'branch_finish', 'gate survives the failure');
  assert.equal(readState(fx.statePath).status, 'in-progress', 'nothing archived');
});

test('choice re-entry guard: retired disposition means the action is NOT re-run', () => {
  const fx = makeFixture();
  walkToGate(fx);
  // prior turn: teardown ran + disposition recorded, death before clear-gate
  git(fx.MAIN, 'merge', '--no-edit', '-q', 'masterplan/t24');
  git(fx.MAIN, 'worktree', 'remove', fx.WT);
  writeState(fx.statePath, { ...readState(fx.statePath), worktree_disposition: 'removed_after_merge' });
  const mainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived');
  // no second merge commit beyond the bundle commits (subject lines prove it)
  const subjects = git(fx.MAIN, 'log', '--format=%s', `${mainHead}..HEAD`);
  assert.ok(!/Merge branch/.test(subjects), 'merge not re-run on re-entry');
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'branch_finish'),
    'no duplicate branch_finish event from the replayed act');
});

test('missing WT without a retired disposition is a loud invariant, not a silent archive', () => {
  const fx = makeFixture();
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT); // crash-leak: WT gone, disposition active
  const op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /worktree .* missing/);
  assert.equal(readState(fx.statePath).status, 'in-progress');
});

test('retro-only: write_retro if absent, then terminal retro_done — nothing else runs', () => {
  const fx = makeFixture();
  let op = fx.step({ retroOnly: true });
  assert.equal(op.op, 'write_retro');
  assert.equal(op.retro_only, true);
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step({ retroOnly: true });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'retro_done');
  assert.equal(readState(fx.statePath).status, 'in-progress', 'retro-only never archives');
  assert.equal(readState(fx.statePath).pending_gate, null, 'retro-only never gates');
});

test('Guard D: a live concurrent owner blocks finish; owner_lock=off needs no identity', () => {
  const fx = makeFixture();
  const other = buildOwnerIdentity({ host: 'h2', session: 'sess-B', slug: 't24', now: 1500 });
  const op = finishStep({ statePath: fx.statePath, self: other, now: 1500 });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'owner-blocked');

  const fx2 = makeFixture({ slug: 't24off', ownerLockOff: true });
  assert.equal(fx2.step().op, 'run_verify', 'lock-off bundle runs with self=null');
});

test('gate-resolution and archive each commit the bundle in MAIN (split-commit discipline)', () => {
  const fx = makeFixture();
  walkToGate(fx);
  fx.step({ choice: 'keep' });
  const subjects = git(fx.MAIN, 'log', '--format=%s');
  assert.match(subjects, /branch_finish resolved \(keep\)/);
  assert.match(subjects, /archive run \(finish complete\)/);
  // the bundle commits exclude Guard D sentinels
  const shown = git(fx.MAIN, 'show', '--stat', '--format=', 'HEAD');
  assert.ok(!shown.includes('.owner'), 'owner sentinels never committed');
});
