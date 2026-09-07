// test/finish-step.test.mjs — finishStep: the §2c finalization flow in code (T2.4).
// REAL git in temp repos (the wave-commit.test.mjs pattern): the module's value is the exact
// interleaving of atomic state writes with -C-qualified local git, so tests exercise genuine
// MAIN+worktree pairs. Coverage is the plan-mandated re-entry-at-every-boundary set: each op
// boundary is exercised both fresh and as a resume (a death between any two steps must land
// back on the same op, never re-run a completed transaction).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { finishStep } from '../lib/finish-step.mjs';
import { liveCheckDigest } from '../lib/finish.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';

// Every fixture builds a git repo under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered here, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
after(() => {
  for (const d of FIXTURE_TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
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
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// A MAIN repo on `main`, a linked worktree on masterplan/<slug> with one committed task file,
// a bundle whose single task is done, and the owner lock held by sess-A.
function makeFixture({ slug = 't24', state: over = {}, ownerLockOff = false, verifyCommands = null, explicitCodex = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-finishstep-'));
  FIXTURE_TMPDIRS.push(tmp);
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n'); // as in the real repo: linked worktrees live under an ignored dir
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', slug);
  // v10 deploy stage: a repo without a done definition is gated; these v9-flow fixtures declare done: none.
  write(MAIN, '.masterplan.yaml', 'done: none\n');
  git(MAIN, 'add', '.masterplan.yaml');
  git(MAIN, 'commit', '-q', '-m', 'done: none');
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  const stateObj = {
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
  };
  // Default: explicit opt-out (a bundle with NEITHER state.review nor state.codex would now be
  // defensively armed, breaking every existing test). Tests that want to exercise the legacy/defensive
  // path pass explicitCodex: false to omit both blocks entirely.
  if (explicitCodex && stateObj.review === undefined && stateObj.codex === undefined) {
    stateObj.review = { adversary: false };
  }
  writeState(statePath, stateObj);
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

test('adversary review: armed (new key) → run_adversary_review once; done-event is the durable re-entry guard', () => {
  const fx = makeFixture({ state: { review: { adversary: 'on' } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  let op = fx.step();
  assert.equal(op.op, 'run_adversary_review');
  assert.equal(op.base, 'main');
  // resume before the answer lands → the SAME op (no event yet at this HEAD)
  assert.equal(fx.step().op, 'run_adversary_review');
  // the answer: event written by finish-step (digest via file — shell-safe transport)
  const digestFile = path.join(fx.bundleDir, 'adversary-review-digest.txt');
  fs.writeFileSync(digestFile, 'P2: tighten the thing\n');
  op = fx.step({ review: 'done', reviewCount: 1, reviewBase: 'main', reviewDigestFile: digestFile });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.review.count, 1, 'gate AUQ carries the rehydrated digest');
  assert.equal(op.review.digest, 'P2: tighten the thing\n');
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'adversary_review');
  assert.match(ev.summary, /adversary review complete/);
  assert.equal(ev.data.sha, git(fx.WT, 'rev-parse', 'HEAD'));
  // re-entry after gate cleared: durable event at unchanged HEAD → review NOT re-run
  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: null });
  op = fx.step();
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.review.present, true);
});

test('adversary review: a LEGACY state.codex.review still arms the gate (in-flight bundle fallback)', () => {
  // A bundle seeded before the codex→adversary rename has state.codex.review but no state.review.
  // The finish-step gate reads state.review?.adversary ?? state.codex?.review, so it still arms.
  const fx = makeFixture({ explicitCodex: false, state: { codex: { review: 'on' } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx.step().op, 'run_adversary_review', 'legacy state.codex.review arms the gate');
});

test('adversary review verdict: --review-verdict lands on the event data; absent flag = no verdict field; a bad enum refuses', () => {
  const fx = makeFixture({ state: { review: { adversary: 'on' } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx.step().op, 'run_adversary_review');
  // the answer WITHOUT a verdict: the event carries no verdict field (back-compat)
  fx.step({ review: 'done', reviewCount: 2, reviewBase: 'main' });
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'adversary_review');
  assert.equal(ev.data.sha, git(fx.WT, 'rev-parse', 'HEAD'));
  assert.equal(ev.data.verdict, undefined, 'an absent --review-verdict writes no verdict field');
  assert.equal('verdict' in ev.data, false);

  // a fresh fixture: the verdict lands on the event's data, machine-readable
  const fx2 = makeFixture({ state: { review: { adversary: 'on' } } });
  fx2.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx2.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx2.step().op, 'run_adversary_review');
  fx2.step({ review: 'done', reviewCount: 1, reviewBase: 'main', reviewVerdict: 'revise' });
  const ev2 = readEvents(fx2.bundleDir).find((e) => e.type === 'adversary_review');
  assert.equal(ev2.data.verdict, 'revise', 'the verdict is machine-readable on the event');
  assert.equal(ev2.data.count, 1);

  // the enum is validated: an arbitrary string never lands on the durable record
  const fx3 = makeFixture({ state: { review: { adversary: 'on' } } });
  fx3.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx3.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx3.step().op, 'run_adversary_review');
  assert.throws(() => fx3.step({ review: 'done', reviewVerdict: 'ship-it' }), /--review-verdict must be one of approve\|revise\|rework\|reject/);
  assert.equal(readEvents(fx3.bundleDir).filter((e) => e.type === 'adversary_review').length, 0, 'nothing written for a bad verdict');
});

test('adversary review skip: durable skip event at SHA prevents a re-ask loop; suppression never arms', () => {
  const fx = makeFixture({ state: { review: { adversary: true } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  assert.equal(fx.step().op, 'run_adversary_review');
  const op = fx.step({ review: 'skipped', reviewReason: 'review runner unavailable' });
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.review, null);
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'adversary_review_skipped');
  assert.match(ev.summary, /adversary-review skipped \(degraded\) — review runner unavailable/);
  // re-walk: the sha-keyed skip event suppresses another run_adversary_review
  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: null });
  assert.equal(fx.step().gate, 'branch_finish');
});

// ---- defensive arming (spec §4.2-C) -------------------------------------------

test('defensive arm: state.review AND state.codex missing entirely → armed once + skip event never emitted', () => {
  // Truly-legacy bundle: no state.review and no state.codex block at all. Defensive arm fires
  // (one-time per bundle, presence-scoped) and the gate proceeds to run review because base exists.
  const fx = makeFixture({ explicitCodex: false });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  const op = fx.step();
  assert.equal(op.op, 'run_adversary_review', 'defensive arm makes the gate fire review');
  const events = readEvents(fx.bundleDir);
  const armEvent = events.find((e) => e.type === 'adversary_review_defensively_armed');
  assert.ok(armEvent, 'adversary_review_defensively_armed event emitted');
  assert.match(armEvent.data.sha, /^[0-9a-f]{40}$/, 'data.sha is a real SHA');
  // re-entry: defensive-arm event presence prevents re-emission, but the gate doesn't loop on this alone
  assert.ok(events.filter((e) => e.type === 'adversary_review_defensively_armed').length === 1, 'emitted exactly once');
});

test('defensive arm: state.review present but adversary=undefined → NOT defensively armed', () => {
  // Explicit review block without adversary is NOT a legacy bundle — user is presumed to know.
  // codexArmed(undefined) is false; the gate falls through with a typed skip event.
  const fx = makeFixture({ explicitCodex: false, state: { review: { other: 'x' } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  const op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  const events = readEvents(fx.bundleDir);
  assert.ok(!events.some((e) => e.type === 'adversary_review_defensively_armed'), 'no defensive-arm event for explicit review block');
  const skip = events.find((e) => e.type === 'adversary_review_skipped');
  assert.match(skip.summary, /state.review.adversary not armed/);
});

test('skip events: typed reasons land in events.jsonl with sha + reason fields', () => {
  const fx = makeFixture({ state: { review: { adversary: false } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  fx.step(); // gate
  const skip = readEvents(fx.bundleDir).find((e) => e.type === 'adversary_review_skipped');
  assert.ok(skip, 'adversary_review_skipped emitted');
  assert.equal(skip.data.reason, 'state.review.adversary not armed');
  assert.ok(skip.data.sha, 'sha recorded for the re-entry guard');
});

test('skip events: re-entry at same SHA does NOT re-emit the skip', () => {
  // Open a gate, force a skip event, re-enter: the sha-keyed guard (hasCodexSkipAtSha) prevents
  // a second skip event at the same head — durable event is one-per-SHA.
  const fx = makeFixture({ state: { review: { adversary: false } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  fx.step(); // gate + skip event emitted
  // open the gate for re-entry
  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: null });
  fx.step(); // re-render: skip event NOT re-emitted
  const skips = readEvents(fx.bundleDir).filter((e) => e.type === 'adversary_review_skipped');
  assert.equal(skips.length, 1, 'one skip event per HEAD');
});

test('branch_finish AUQ: notice field surfaces the skip reason (spec §4.2-D)', () => {
  const fx = makeFixture({ state: { review: { adversary: false } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  const op = fx.step();
  assert.equal(op.gate, 'branch_finish');
  assert.match(op.notice, /adversary review skipped — state.review.adversary not armed/);
});

test('Codex host no longer suppresses adversary review (cross-vendor lane, no recursion)', () => {
  // The legacy --codex-suppressed flag is inert at finish-step: whole-branch review now
  // runs harness-native on the cross-vendor adversary class/panel, not Codex, so there is
  // no Codex-calling-Codex recursion to avoid — review runs regardless of host.
  const fx = makeFixture({ state: { review: { adversary: 'on' } } });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  const op = fx.step({ codexSuppressed: true });
  assert.equal(op.op, 'run_adversary_review');
});

test('branch_finish AUQ: notice field surfaces defensive-arm note for legacy bundles', () => {
  const fx = makeFixture({ explicitCodex: false });
  fx.step({ verify: 'pass' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  const op = fx.step({ review: 'skipped', reviewReason: 'review runner unavailable' });
  // After the shell answers with review='skipped', re-enter: branch_finish rehydrates from the
  // defensive-arm event (which IS still in events.jsonl) so the notice shows defensive.
  assert.equal(op.gate, 'branch_finish');
  assert.match(op.notice, /defensively armed/);
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

  // Phase 2: the shell confirms the push → retire, clear the gate; the run waits for the merge
  // (the deploy base is the landing, §7.1 — done: none records deploy_base there and runs no group).
  op = fx.step({ choice: 'pr', pushed: true });
  assert.equal(op.reason, 'await_merge');
  st = readState(fx.statePath);
  assert.equal(st.worktree_disposition, 'kept_by_user');
  assert.notEqual(st.status, 'archived');
  const tipRetired = readEvents(fx.bundleDir).find((e) => e.type === 'branch_finish').branch_tip;
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', tipRetired);
  op = fx.step({ merged: true, mergeSha: git(fx.MAIN, 'rev-parse', 'HEAD') });
  assert.equal(op.reason, 'archived');
  st = readState(fx.statePath);
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

// ---- deploy stage (T2.4 §2c) ------------------------------------------------

test('deploy: done:none → merge archives with a single deploy_base and no deploy_step', () => {
  const fx = makeFixture();
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived');
  const events = readEvents(fx.bundleDir);
  const bases = events.filter((e) => e.type === 'deploy_base');
  assert.equal(bases.length, 1);
  assert.ok(bases[0].done_sha256, 'done_sha256 recorded');
  assert.ok(!events.some((e) => e.type === 'deploy_step'), 'no deploy_step for done:none');
});

test('deploy: no definition → no_definition_of_done gate; abort-incomplete archives', () => {
  const fx = makeFixture();
  walkToGate(fx);
  // remove the done definition from MAIN
  git(fx.MAIN, 'rm', '-q', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'remove done definition');
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'no_definition_of_done');
  assert.deepEqual(op.choices, ['adhoc', 'abort-incomplete']);
  op = fx.step({ deployAbortIncomplete: true });
  assert.equal(op.op, 'stop', JSON.stringify(op));
  assert.equal(op.reason, 'archived');
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(ev.reason, 'no_definition_of_done');
  assert.equal(readState(fx.statePath).status, 'archived');
  // replay: a re-entered finish on the archived bundle never re-asks the gate
  const again = fx.step({});
  assert.notEqual(again.gate, 'no_definition_of_done');
});

test('deploy: gated flow — authorize → start → done → next group', () => {
  const fx = makeFixture({
    state: { autonomy: 'gated' },
  });
  // commit a real done definition (release creates rel.ok, install echoes)
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: touch rel.ok\n      check: test -f rel.ok\n  install:\n    - run: echo inst\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'release');
  assert.equal(op.index, 0);
  assert.equal(op.ask, true);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step_authorized'), 'no authorize yet');
  // authorize
  op = fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'release');
  assert.equal(op.index, 0);
  assert.equal(op.ask, false);
  const events = readEvents(fx.bundleDir);
  assert.ok(events.some((e) => e.type === 'deploy_step_authorized' && e.group === 'release' && e.index === 0), 'authorized recorded');
  assert.ok(events.some((e) => e.type === 'deploy_step_started' && e.group === 'release' && e.index === 0), 'started recorded');
  // the shell ran `touch rel.ok` from MAIN; simulate its effect before reporting the exit
  write(fx.MAIN, 'rel.ok', '');
  // report done
  // The report names an evidence FILE; the event carries the digest of what is in it.
  const evidence = path.join(fx.MAIN, 'release-evidence.txt');
  fs.writeFileSync(evidence, 'released\n');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0, digestFile: evidence } });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.group, 'install');
  assert.equal(op.index, 0);
  const doneEv = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_step' && e.group === 'release' && e.index === 0);
  assert.equal(doneEv.status, 'done');
  assert.equal(doneEv.digest, liveCheckDigest(evidence));
});

test('deploy: loose autonomy — authorize+start recorded before the first run_deploy_step', () => {
  const fx = makeFixture({
    state: { autonomy: 'loose' },
  });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: touch rel.ok\n      check: test -f rel.ok\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, false);
  const events = readEvents(fx.bundleDir);
  assert.ok(events.some((e) => e.type === 'deploy_step_authorized' && e.group === 'release' && e.index === 0), 'authorized auto-recorded');
  assert.ok(events.some((e) => e.type === 'deploy_step_started' && e.group === 'release' && e.index === 0), 'started auto-recorded');
});

test('deploy: failure and indeterminate outcomes', () => {
  // failure: exit 1 → deploy_failed gate
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: touch rel.ok\n      check: test -f rel.ok\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' }); // returns run_deploy_step ask:false
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'deploy_failed');
  assert.ok(op.choices.includes('retry'));
  const failEv = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_failed');
  assert.equal(failEv.exit, 1);

  // indeterminate: run exit 0, check exit 2
  const fx2 = makeFixture({ state: { autonomy: 'loose' } });
  write(fx2.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n      check: exit 2\n');
  git(fx2.MAIN, 'add', '.masterplan.yaml');
  git(fx2.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx2);
  fx2.step({ choice: 'merge' });
  op = fx2.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'deploy_indeterminate');
  const indetEv = readEvents(fx2.bundleDir).find((e) => e.type === 'deploy_indeterminate');
  assert.equal(indetEv.check_exit, 2);
});

test('deploy: a recorded failure halts on re-entry until retried', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' }); // run_deploy_step ask:false
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'deploy_failed');
  // re-entry: the gate re-renders, no new start
  op = fx.step({});
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'deploy_failed');
  const starts = readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step_started' && e.group === 'release' && e.index === 0);
  assert.equal(starts.length, 1, 'exactly one start before retry');
  // retry: fresh authorization + re-run
  op = fx.step({ deployRetry: { group: 'release', index: 0 } });
  assert.equal(op.op, 'run_deploy_step');
  const auths = readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step_authorized' && e.group === 'release' && e.index === 0);
  assert.equal(auths.length, 2, 'retry re-authorizes');
  const startsAfter = readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step_started' && e.group === 'release' && e.index === 0);
  assert.equal(startsAfter.length, 2, 'the retried attempt records its own started transition');
});

test('deploy: skip archives incomplete', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } }); // deploy_failed
  const op = fx.step({ deploySkip: { group: 'release', index: 0 } });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'archived');
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(ev.reason, 'deploy_skip:release[0]');
});

test('deploy: attest only for a check-less indeterminate step', () => {
  // with a check → throws /has a check/
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n      check: exit 2\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }); // indeterminate
  assert.throws(() => fx.step({ deployAttest: { group: 'release', index: 0 } }), /has a check/);

  // without a check, but not indeterminate → throws /not indeterminate/
  const fx2 = makeFixture({ state: { autonomy: 'loose' } });
  write(fx2.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  git(fx2.MAIN, 'add', '.masterplan.yaml');
  git(fx2.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx2);
  fx2.step({ choice: 'merge' });
  fx2.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }); // done
  assert.throws(() => fx2.step({ deployAttest: { group: 'release', index: 0 } }), /not indeterminate/);
});

test('deploy: abort archives incomplete', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } }); // deploy_failed
  const op = fx.step({ deployAbort: true });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'archived');
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(ev.reason, 'deploy_abort');
});

test('deploy: deployStepDone requires authorization and start', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, true);
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /without authorization\/start/);
});

test('deploy: mergeSha must be a commit', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  assert.throws(() => fx.step({ choice: 'merge', mergeSha: 'deadbeef' }), /full 40-hex commit id/);
  assert.throws(() => fx.step({ choice: 'merge', mergeSha: 'deadbeef'.repeat(5) }), /not a commit/);
});

test('deploy: a merged PR (kept_by_user + --merged --merge-sha) enters the deploy stage at the merge sha', () => {
  const fx = makeFixture({ state: { autonomy: 'loose', worktree_disposition: 'kept_by_user' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  // The PR disposition is already retired (branch kept, PR open); verify/retro ran before it.
  // Emulate the remote merge: MAIN gains a real merge commit of the branch (identity is checked, §7.3).
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', 'masterplan/t24');
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => fx.step({ merged: true }), /requires --merge-sha/);
  const op = fx.step({ merged: true, mergeSha });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  const base = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base');
  assert.equal(base.sha, mergeSha);
});

test('deploy: skip is only accepted for a halted failed step', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.throws(() => fx.step({ deploySkip: { group: 'release', index: 0 } }), /not a failed step/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized'));
});

test('deploy: a plain authorization cannot clear a halted failure', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  const gate = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(gate.gate, 'deploy_failed');
  assert.throws(() => fx.step({ deployAuthorize: { group: 'release', index: 0 } }), /is halted/);
  const again = fx.step({});
  assert.equal(again.gate, 'deploy_failed');
});

test('deploy: an interrupted started step is probed on re-entry, never rerun blindly', () => {
  // check passes on probe → recovered as done
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  // The step's evidence file lives in the bundle: untracked output outside docs/masterplan is dirt (§7.3).
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: touch docs/masterplan/t24/rel.ok\n      check: test -f docs/masterplan/t24/rel.ok\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' }); // authorized + started, run_deploy_step
  write(fx.MAIN, 'docs/masterplan/t24/rel.ok', ''); // the command ran, then the driver crashed before reporting
  const op = fx.step({});
  assert.equal(op.op, 'stop', JSON.stringify(op));
  const rec = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_step' && e.group === 'release');
  assert.equal(rec.source, 'recovery-probe');

  // check-less step → indeterminate gate, no rerun
  const fx2 = makeFixture({ state: { autonomy: 'loose' } });
  write(fx2.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n');
  git(fx2.MAIN, 'add', '.masterplan.yaml');
  git(fx2.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx2);
  fx2.step({ choice: 'merge' });
  const op2 = fx2.step({});
  assert.equal(op2.op, 'ask');
  assert.equal(op2.gate, 'deploy_indeterminate');
  assert.equal(readEvents(fx2.bundleDir).filter((e) => e.type === 'deploy_step_started').length, 1);
  // attest is allowed here (check-less, indeterminate)
  const op3 = fx2.step({ deployAttest: { group: 'release', index: 0 } });
  assert.equal(op3.reason, 'archived');
  assert.equal(readEvents(fx2.bundleDir).find((e) => e.type === 'deploy_step').status, 'attested');
});

test('deploy: a completion report cannot overwrite a halted failure without a retry', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  const gate = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(gate.gate, 'deploy_failed');
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /is halted/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'));
  fx.step({ deployRetry: { group: 'release', index: 0 } });
  const op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.reason, 'archived');
});

test('deploy: a merged PR keeps progressing on re-entry without repeating --merged/--merge-sha', () => {
  const fx = makeFixture({ state: { autonomy: 'loose', worktree_disposition: 'kept_by_user' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n  install:\n    - run: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  git(fx.MAIN, 'merge', '-q', '--no-ff', '--no-edit', 'masterplan/t24');
  const mergeSha = git(fx.MAIN, 'rev-parse', 'HEAD');
  let op = fx.step({ merged: true, mergeSha });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.group, 'release');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'install');
  op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  assert.notEqual(op.op, 'run_deploy_step');
  const steps = readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step').map((e) => e.group);
  assert.deepEqual(steps, ['release', 'install']);
});

test('deploy: an ad-hoc definition edited after deploy_base is refused on replay', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  git(fx.MAIN, 'rm', '-q', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'no done definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.gate, 'no_definition_of_done');
  const adhoc = path.join(fx.tmp, 'adhoc.json');
  fs.writeFileSync(adhoc, JSON.stringify({ release: [{ run: '/bin/true' }] }));
  op = fx.step({ doneAdhocFile: adhoc });
  assert.equal(op.op, 'run_deploy_step');
  fs.writeFileSync(path.join(fx.bundleDir, 'done-adhoc.json'), JSON.stringify({ release: [{ run: '/bin/false' }] }));
  assert.throws(() => fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } }), /done_sha256/);
  assert.throws(() => fx.step(), /done_sha256/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'));
});

test('deploy: retry answers only a failure, rerun only an indeterminate result; checked steps never offer attest', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, 'chk2.sh', '#!/bin/sh\nexit 2\n');
  fs.chmodSync(path.join(fx.MAIN, 'chk2.sh'), 0o755);
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n    - run: /bin/true\n      check: ./chk2.sh\n');
  git(fx.MAIN, 'add', '.masterplan.yaml', 'chk2.sh');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  fx.step({ choice: 'merge' });
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  assert.throws(() => fx.step({ deployRerun: { group: 'release', index: 0 } }), /answered by --deploy-retry, not --deploy-rerun/);
  op = fx.step({ deployRetry: { group: 'release', index: 0 } });
  assert.equal(op.op, 'run_deploy_step');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.index, 1);
  op = fx.step({ deployStepDone: { group: 'release', index: 1, exit: 0 } });
  assert.equal(op.gate, 'deploy_indeterminate');
  assert.deepEqual(op.choices, ['rerun', 'abort']);
  assert.throws(() => fx.step({ deployRetry: { group: 'release', index: 1 } }), /answered by --deploy-rerun, not --deploy-retry/);
  assert.throws(() => fx.step({ deployAttest: { group: 'release', index: 1 } }), /has a check/);
  op = fx.step({ deployRerun: { group: 'release', index: 1 } });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.index, 1);
});

test('deploy: a user_only report is refused until the ordered chain exposes that step', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n  user_only:\n    - text: flip the switch\n      check: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.throws(() => fx.step({ deployStepDone: { group: 'user_only', index: 0, exit: 0 } }), /out of order/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'));
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.ask, 'handback');
  op = fx.step({ deployStepDone: { group: 'user_only', index: 0, exit: 0 } });
  const steps = readEvents(fx.bundleDir).filter((e) => e.type === 'deploy_step').map((e) => e.group);
  assert.deepEqual(steps, ['release', 'user_only']);
});

test('deploy: gated authorization binds to the exposed step — no pre-authorizing a later one', () => {
  const fx = makeFixture({ state: { autonomy: 'gated' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/true\n  install:\n    - run: /bin/true\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  assert.throws(() => fx.step({ choice: 'merge', deployAuthorize: { group: 'release', index: 0 } }), /before deploy_base/);
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, true);
  assert.throws(() => fx.step({ deployAuthorize: { group: 'install', index: 0 } }), /out of order/);
  assert.throws(() => fx.step({ deployAuthorize: { group: 'release', index: 5 } }), /unknown step/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step_authorized'));
  op = fx.step({ deployAuthorize: { group: 'release', index: 0 } });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.ask, false);
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'run_deploy_step');
  assert.equal(op.group, 'install');
  assert.equal(op.ask, true, 'the next gated step still asks');
});

test('deploy: abort is refused unless the current step is halted in an abort-capable gate', () => {
  const fx = makeFixture({ state: { autonomy: 'loose' } });
  write(fx.MAIN, '.masterplan.yaml', 'done:\n  release:\n    - run: /bin/false\n');
  git(fx.MAIN, 'add', '.masterplan.yaml');
  git(fx.MAIN, 'commit', '-q', '-m', 'done definition');
  walkToGate(fx);
  assert.throws(() => fx.step({ choice: 'merge', deployAbort: true }), /before deploy_base/);
  assert.ok(!readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized'));
  let op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  assert.throws(() => fx.step({ deployAbort: true }), /is not halted/);
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed');
  op = fx.step({ deployAbort: true });
  assert.equal(op.reason, 'archived');
});
