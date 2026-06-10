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

test('pr: two-phase handshake — push_pr leaves the gate open; --pushed retires and archives', () => {
  const fx = makeFixture();
  walkToGate(fx);
  // Phase 1: the shell op, with NOTHING durable changed — a death before the push must
  // re-render the gate, never silently archive with no PR (Codex r5 P1).
  let op = fx.step({ choice: 'pr' });
  assert.equal(op.op, 'shell');
  assert.equal(op.kind, 'push_pr');
  assert.equal(op.branch, 'masterplan/t24');
  assert.equal(op.base, 'main');
  let st = readState(fx.statePath);
  assert.notEqual(st.worktree_disposition, 'kept_by_user', 'not retired before the push is confirmed');
  assert.equal(st.pending_gate?.id, 'branch_finish', 'gate stays open across the network half');
  assert.ok(fs.existsSync(fx.WT), 'pr keeps the worktree');

  // Crash before the push: a bare re-call re-renders the gate — nothing archived.
  op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.notEqual(readState(fx.statePath).status, 'archived');

  // Re-issuing the choice re-emits the shell op (the push is idempotent shell-side).
  op = fx.step({ choice: 'pr' });
  assert.equal(op.kind, 'push_pr');

  // Phase 2: the shell confirms the push → retire, clear the gate, archive.
  op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'archived');
  st = readState(fx.statePath);
  assert.equal(st.worktree_disposition, 'kept_by_user');
  assert.equal(st.pending_gate, null);
  assert.equal(st.status, 'archived');
});

test('merge target guard: MAIN checked out on a non-base branch → dispatch-error, nothing merged', () => {
  const fx = makeFixture();
  walkToGate(fx);
  git(fx.MAIN, 'checkout', '-q', '-b', 'unrelated-feature');
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /merge target mismatch/);
  assert.match(op.error, /unrelated-feature/);
  assert.equal(readState(fx.statePath).pending_gate?.id, 'branch_finish', 'gate intact');
  // back on the base, the same choice completes the transaction
  git(fx.MAIN, 'checkout', '-q', 'main');
  assert.equal(fx.step({ choice: 'merge' }).reason, 'archived');
  assert.ok(git(fx.MAIN, 'log', '--oneline').includes('task 1'), 'merge landed on main');
});

test('teardown crash window: WT removed but disposition not recorded — gate re-renders MAIN-side, choice replay retires by absence', () => {
  const fx = makeFixture();
  walkToGate(fx);
  // simulate a death between `worktree remove` and the disposition write
  git(fx.MAIN, 'merge', '--no-edit', '-q', 'masterplan/t24');
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT);
  // bare re-call: the open gate re-renders from MAIN-side refs instead of dying on WT git
  let op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.wt_missing, true);
  assert.ok(op.head, 'head hydrated from the surviving branch ref');
  assert.equal(op.base, 'main');
  // replaying the same choice treats the missing path as removal-confirmed and retires
  op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived');
  assert.equal(readState(fx.statePath).worktree_disposition, 'removed_after_merge');
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

// Commit a markdown doc on the WT branch so the docs_normalize offer has a candidate.
function addDoc(fx, rel = 'docs/plans/t24-design.md', content = '# plan t24\n') {
  write(fx.WT, rel, content);
  git(fx.WT, 'add', '.');
  git(fx.WT, 'commit', '-q', '-m', 'docs');
}

test('docs_normalize: offer fires on branch-touched markdown; bare re-entry re-renders with recomputed candidates', () => {
  const fx = makeFixture();
  addDoc(fx);
  let op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'docs_normalize');
  assert.deepEqual(op.candidates, ['docs/plans/t24-design.md']);
  assert.equal(op.base, 'main');
  assert.equal(op.head, git(fx.WT, 'rev-parse', 'HEAD'));
  assert.equal(readState(fx.statePath).pending_gate?.id, 'docs_normalize');
  // bare re-entry: the durable gate re-renders; candidates recomputed, never persisted
  op = fx.step();
  assert.equal(op.gate, 'docs_normalize');
  assert.deepEqual(op.candidates, ['docs/plans/t24-design.md']);
  assert.equal(readState(fx.statePath).pending_gate.candidates, undefined,
    'gate payload stays minimal — the list is recomputed, not stored (scalar-cap discipline)');
});

test('docs_normalize: --docs-normalized writes the durable event, clears the gate, verification covers the FINAL tree', () => {
  const fx = makeFixture();
  addDoc(fx);
  assert.equal(fx.step().gate, 'docs_normalize');
  // the shell's LLM half: fold the plan doc into a category doc in WT and commit
  fs.rmSync(path.join(fx.WT, 'docs/plans/t24-design.md'));
  write(fx.WT, 'docs/design.md', '# design\n');
  git(fx.WT, 'add', '-A');
  git(fx.WT, 'commit', '-q', '-m', 'normalize docs');
  const newHead = git(fx.WT, 'rev-parse', 'HEAD');
  const op = fx.step({ docs: 'normalized', docsCount: 1 });
  assert.equal(op.op, 'run_verify');
  assert.equal(op.head, newHead, 'the normalization commit lands BEFORE verified_sha is recorded');
  assert.equal(readState(fx.statePath).pending_gate, null);
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'docs_normalize');
  assert.match(ev.summary, /1 file\(s\) folded/);
  assert.equal(ev.data.sha, newHead);
  assert.equal(ev.data.count, 1);
  // the presence-keyed event guard: a re-walk never re-offers (HEAD moved, diff is NOT self-clearing)
  assert.equal(fx.step().op, 'run_verify');
});

test('docs_normalize: --docs-skipped records the durable skip event and never re-offers', () => {
  const fx = makeFixture();
  addDoc(fx);
  assert.equal(fx.step().gate, 'docs_normalize');
  const op = fx.step({ docs: 'skipped', docsReason: 'keep plan layout' });
  assert.equal(op.op, 'run_verify');
  assert.equal(readState(fx.statePath).pending_gate, null);
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'docs_normalize_skipped');
  assert.match(ev.summary, /skipped — keep plan layout/);
  assert.equal(fx.step().op, 'run_verify', 'skip is durable — no re-offer on re-walk');
});

test('docs_normalize: silent (no gate, NO event) for zero candidates, non-md changes, bundle-dir-only docs', () => {
  // base fixture: the branch's only change is src/a.txt (non-md) → straight to verification
  const fx = makeFixture();
  assert.equal(fx.step().op, 'run_verify');
  assert.equal(readState(fx.statePath).pending_gate, null);
  assert.equal(readEvents(fx.bundleDir).filter((e) => String(e.type).startsWith('docs_normalize')).length, 0,
    'a non-offer is recomputed deterministically — nothing to make durable');
  // bundle-dir markdown is the archived audit record — filtered out, still no offer
  const fx2 = makeFixture({ slug: 't24b' });
  addDoc(fx2, 'docs/masterplan/t24b/notes.md', 'bundle-internal\n');
  assert.equal(fx2.step().op, 'run_verify');
  assert.equal(readState(fx2.statePath).pending_gate, null);
});

test('docs_normalize: state.docs.normalize off suppresses; --docs-suppressed is per-invocation only', () => {
  const fx = makeFixture({ state: { docs: { normalize: 'off' } } });
  addDoc(fx);
  assert.equal(fx.step().op, 'run_verify');
  const fx2 = makeFixture({ slug: 't24sup' });
  addDoc(fx2);
  assert.equal(fx2.step({ docsSuppressed: true }).op, 'run_verify');
  // one-invocation suppression: an unsuppressed re-entry still offers (no event was written)
  assert.equal(fx2.step().gate, 'docs_normalize');
});

test('docs_normalize: undetectable base → silent skip (fail-soft, mirrors the codex row)', () => {
  const fx = makeFixture();
  addDoc(fx);
  git(fx.MAIN, 'branch', '-m', 'main', 'trunk');
  assert.equal(fx.step().op, 'run_verify');
  assert.equal(readState(fx.statePath).pending_gate, null);
});

test('docs_normalize: replayed answer after a crash between event append and clear-gate is idempotent', () => {
  const fx = makeFixture();
  addDoc(fx);
  assert.equal(fx.step().gate, 'docs_normalize');
  assert.equal(fx.step({ docs: 'skipped' }).op, 'run_verify');
  // simulate the crash window: the event landed but clearGate never ran → gate re-opened
  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: { id: 'docs_normalize', opened_at: 2000 } });
  assert.equal(fx.step({ docs: 'skipped' }).op, 'run_verify');
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'docs_normalize_skipped').length, 1,
    'the presence guard blocks a duplicate event');
  assert.equal(readState(fx.statePath).pending_gate, null, 'the replay still clears the gate');
});

test('docs_normalize: a dirty task-scope .md is dirty-committed FIRST and appears in the candidates', () => {
  const fx = makeFixture({
    state: { tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt', 'docs/notes.md'] }] },
  });
  addDoc(fx, 'docs/notes.md', 'v1\n'); // committed on the branch…
  write(fx.WT, 'docs/notes.md', 'v2 — dirty edit\n'); // …then modified, uncommitted at finish
  const op = fx.step();
  assert.equal(op.gate, 'docs_normalize');
  assert.ok(op.candidates.includes('docs/notes.md'), 'step 4 dirty-commit precedes candidate detection');
  assert.equal(op.head, git(fx.WT, 'rev-parse', 'HEAD'));
  assert.equal(git(fx.WT, 'status', '--porcelain'), '', 'the .md was committed, not left dirty');
});

test('docs_normalize: full flow — normalize then verify → retro → branch_finish → archived', () => {
  const fx = makeFixture();
  addDoc(fx);
  assert.equal(fx.step().gate, 'docs_normalize');
  let op = fx.step({ docs: 'normalized', docsCount: 1 });
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro');
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step();
  assert.equal(op.gate, 'branch_finish');
  assert.equal(fx.step({ choice: 'merge' }).reason, 'archived');
  assert.equal(readState(fx.statePath).status, 'archived');
});

test('full-teardown crash replay (Codex r6 P2): branch already deleted — merge is skipped, replay retires', () => {
  const fx = makeFixture();
  walkToGate(fx);
  // Simulate a death AFTER the whole teardown (merge → worktree remove → branch -d) but
  // BEFORE the disposition write: the branch ref is gone, so a naive replay's re-merge
  // would fail and strand the run on dispatch-error.
  git(fx.MAIN, 'merge', '--no-edit', '-q', 'masterplan/t24');
  git(fx.MAIN, 'worktree', 'remove', '--force', fx.WT);
  git(fx.MAIN, 'branch', '-d', 'masterplan/t24');
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived');
  const st = readState(fx.statePath);
  assert.equal(st.worktree_disposition, 'removed_after_merge');
  assert.equal(st.status, 'archived');
  assert.ok(git(fx.MAIN, 'log', '--oneline').includes('task 1'), 'the prior merge is intact');
});
