// test/finish-changed-tip-retry.test.mjs — finish-binding-changed-tip-retry (cross-vendor
// re-review blocker): a recorded retirement's crash-replay exemption must prove it replays
// the RECORDED tip, not merely that a record exists.
//
// Reproduction being pinned: verify at A, reach branch_finish, answer merge with an
// untracked file in the worktree → A lands, the removal fails (the supported failure path),
// branch_finish_intent/branch_finish for A are recorded, disposition stays active. Commit in
// the surviving worktree (branch now at B). A retry must NOT land and tear down B: without
// the guard, B was merged, the worktree removed, and only the later deploy-boundary check
// threw — AFTER the unverified landing and teardown.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { finishStep } from '../lib/finish-step.mjs';
import { writeState, readState } from '../lib/bundle.mjs';

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

function specGateHash(bundleDir) {
  const h = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

const GOALS_MD = [
  'topic: |',
  '  never re-land a changed tip under a recorded retirement',
  '',
  '## Intent',
  'why: a retirement record replayed against a different tip re-binds its identity to unverified facts',
  'outcome: the recorded retirement replays at its recorded tip or the run refuses',
  'done_means: release and a live check',
  '',
].join('\n');

const DONE_WITH_LIVE = [
  'done:',
  '  release:',
  '    - run: /bin/true',
  '  live_check:',
  '    - run: /bin/true',
  '      check: /bin/true',
  '',
].join('\n');

function mkFixture({ slug = 'fctr' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-changedtip-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n');
  write(MAIN, '.masterplan.yaml', DONE_WITH_LIVE);
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
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true, autonomy: 'loose',
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  write(bundleDir, 'goals.md', GOALS_MD);
  write(bundleDir, 'spec.md', '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: specGateHash(bundleDir), count: 0, base: 'main' },
  })}\n`);
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  const verifyOut = path.join(tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, 'suite green\n');
  return { tmp, MAIN, WT, bundleDir, statePath, step, verifyOut };
}

/** The reviewer's exact setup: verify at A, reach branch_finish, then answer merge with an
 * untracked file in the worktree — A lands, the removal fails, the retirement records for A
 * stand and the disposition stays active (the supported failure path). */
function driveToFailedRemoval(fx, slug) {
  const { WT, bundleDir, step, verifyOut } = fx;
  const headA = git(WT, 'rev-parse', 'HEAD');

  let op = step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = step({ verify: 'pass', verifyOutputFile: verifyOut });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));

  write(WT, 'scratch/untracked.txt', 'operator file\n'); // not task scope → blocks the removal
  op = step({ choice: 'merge' });
  assert.equal(op.ask, 'dispatch-error', JSON.stringify(op));
  assert.match(op.error, /worktree removal failed/);

  const retire = readEvents(bundleDir).filter((e) => e.type === 'branch_finish').pop();
  assert.ok(retire, 'branch_finish recorded for the landed attempt');
  assert.equal(retire.note, 'merge');
  assert.equal(retire.branch_tip, headA, 'the recorded retirement tip is A');
  assert.equal(readState(fx.statePath).worktree_disposition, 'active');
  return { headA };
}

test('changed-tip retry after a partial retirement is refused before any write (finish-binding-changed-tip-retry)', () => {
  const fx = mkFixture({ slug: 'fctr-refused' });
  const { MAIN, WT, bundleDir, statePath, step } = fx;
  const { headA } = driveToFailedRemoval(fx, 'fctr-refused');
  const eventsPath = path.join(bundleDir, 'events.jsonl');
  const stateBefore = fs.readFileSync(statePath, 'utf8');
  const eventsBefore = fs.readFileSync(eventsPath, 'utf8');

  // The changed tip: the operator commits in the surviving worktree (branch now at B).
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'commit B in the surviving worktree');
  const headB = git(WT, 'rev-parse', 'HEAD');
  assert.notEqual(headB, headA);

  // Retry merge: REFUSED before any git or ledger write, naming both tips and the recovery.
  assert.throws(
    () => step({ choice: 'merge' }),
    (e) => {
      assert.match(e.message, /--choice=merge refused/);
      assert.match(e.message, new RegExp(`recorded for tip ${headA.slice(0, 12)} but the worktree HEAD is ${headB.slice(0, 12)}`));
      assert.match(e.message, /reset the worktree to the recorded tip/);
      assert.match(e.message, /--choice=keep/);
      return true;
    },
  );

  // Worktree intact, branch still at B, B never merged, ledger and state byte-identical.
  assert.equal(fs.existsSync(WT), true, 'the worktree is intact — nothing was torn down');
  assert.equal(git(WT, 'rev-parse', 'HEAD'), headB, 'the worktree still sits at B');
  let bOnBase = true;
  try { git(MAIN, 'merge-base', '--is-ancestor', headB, 'main'); } catch { bOnBase = false; }
  assert.equal(bOnBase, false, 'B was never merged into the base');
  assert.equal(fs.readFileSync(eventsPath, 'utf8'), eventsBefore, 'the ledger is unchanged — no new retirement was written');
  assert.equal(fs.readFileSync(statePath, 'utf8'), stateBefore, 'the state is unchanged');
  assert.equal(readState(statePath).worktree_disposition, 'active');

  // The other teardown routes are refused identically (pr: the publication retirement;
  // discard: the forced removal) — keep stays the explicit incomplete way out.
  for (const choice of ['pr', 'discard']) {
    assert.throws(() => step({ choice }), /refused — a retirement is already recorded for tip/, `--choice=${choice} must be refused`);
  }
  assert.equal(fs.readFileSync(eventsPath, 'utf8'), eventsBefore, 'still no ledger write');
});

test('same-tip retry after the failed removal completes the recorded retirement as today', () => {
  const fx = mkFixture({ slug: 'fctr-same-tip' });
  const { WT, bundleDir, statePath, step } = fx;
  const { headA } = driveToFailedRemoval(fx, 'fctr-same-tip');

  // The operator clears the blocker (HEAD still A) and retries: genuine crash replay of the
  // recorded retirement — unblocked, no second record, the teardown completes.
  fs.rmSync(path.join(WT, 'scratch', 'untracked.txt'));
  assert.equal(git(WT, 'rev-parse', 'HEAD'), headA, 'the worktree HEAD never moved');
  const op = step({ choice: 'merge' });
  assert.notEqual(op.ask, 'dispatch-error', JSON.stringify(op));
  assert.doesNotMatch(JSON.stringify(op), /recorded for tip/, 'no changed-tip refusal on a faithful replay');
  assert.equal(fs.existsSync(WT), false, 'the worktree removal completed');
  assert.equal(readState(statePath).worktree_disposition, 'removed_after_merge');
  const finishes = readEvents(bundleDir).filter((e) => e.type === 'branch_finish');
  assert.equal(finishes.length, 1, 'no second branch_finish — the recorded retirement replayed');
  assert.equal(finishes[0].branch_tip, headA);
});

test('crash replay with the worktree already removed stays unblocked (no worktree HEAD to compare)', () => {
  const fx = mkFixture({ slug: 'fctr-wt-gone' });
  const { MAIN, WT, bundleDir, statePath, step } = fx;
  const { headA } = driveToFailedRemoval(fx, 'fctr-wt-gone');

  // The crash completed the teardown but died before the disposition write: worktree and
  // branch gone, disposition still active, the retirement records for A standing.
  git(MAIN, 'worktree', 'remove', '--force', WT);
  git(MAIN, 'branch', '-d', 'masterplan/fctr-wt-gone');

  const op = step({ choice: 'merge' });
  assert.doesNotMatch(JSON.stringify(op), /recorded for tip/, `the teardown replay must stay unblocked: ${JSON.stringify(op)}`);
  assert.equal(readState(statePath).worktree_disposition, 'removed_after_merge', 'the recorded retirement completed');
  const finishes = readEvents(bundleDir).filter((e) => e.type === 'branch_finish');
  assert.equal(finishes.length, 1, 'no second branch_finish — the recorded retirement replayed');
  assert.equal(finishes[0].branch_tip, headA);
});

test('an open branch_finish gate over a changed tip surfaces the refusal visibly, and keep ends the run', () => {
  const fx = mkFixture({ slug: 'fctr-open-gate' });
  const { WT, bundleDir, statePath, step } = fx;
  const { headA } = driveToFailedRemoval(fx, 'fctr-open-gate');

  // The blocker cleared at A: bare re-entry resumes the flow and re-opens the branch_finish gate.
  fs.rmSync(path.join(WT, 'scratch', 'untracked.txt'));
  let op = step();
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  assert.equal(op.head, headA);

  // The tip moves UNDER the open gate; bare re-entry re-renders the gate WITH the refusal —
  // never a silent proceed and never a repair run_verify at the unverified tip.
  write(WT, 'src/b.txt', 'B\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'commit B under the open gate');
  const headB = git(WT, 'rev-parse', 'HEAD');
  op = step();
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  assert.ok(op.changed_tip_refusal, 'the gate carries the refusal');
  assert.equal(op.changed_tip_refusal.recorded_tip, headA);
  assert.equal(op.changed_tip_refusal.head, headB);
  assert.match(op.changed_tip_refusal.reason, /reset the worktree to the recorded tip/);
  assert.equal(readState(statePath).pending_gate?.id, 'branch_finish', 'the gate stays pending — no loop, no silent proceed');

  // The landing choice is still refused against the rendered gate; the explicit incomplete
  // route (keep) ends the run with nothing landed and nothing torn down.
  assert.throws(() => step({ choice: 'merge' }), /a retirement is already recorded for tip/);
  op = step({ choice: 'keep' });
  for (let i = 0; i < 4 && readState(statePath).status !== 'archived'; i++) op = step();
  const state = readState(statePath);
  assert.equal(state.status, 'archived');
  assert.equal(state.completion, 'incomplete:kept', 'keep archived the run incomplete — the sanctioned exit');
  assert.equal(fs.existsSync(WT), true, 'keep tore nothing down');
  assert.equal(git(WT, 'rev-parse', 'HEAD'), headB, 'the changed tip is preserved in the kept worktree');
});

// Re-review follow-up: an absent or unreadable WORKTREE HEAD is not proof that the surviving
// BRANCH is unchanged. Every surviving ref the landing or teardown would consume must still
// be the recorded tip.
for (const variant of ['detached worktree at B', 'worktree removed, branch B survives']) {
  test(`changed-tip retry is refused when the ${variant} (finish-binding-changed-tip-retry)`, () => {
    const slug = variant.startsWith('detached') ? 'fctr-detached' : 'fctr-wt-gone';
    const fx = mkFixture({ slug });
    const { MAIN, WT, bundleDir, statePath, step } = fx;
    const { headA } = driveToFailedRemoval(fx, slug);
    git(WT, 'add', '.');
    git(WT, 'commit', '-q', '-m', 'commit B in the surviving worktree');
    const headB = git(WT, 'rev-parse', 'HEAD');
    if (variant.startsWith('detached')) {
      git(WT, 'checkout', '-q', '--detach', headB);
    } else {
      git(MAIN, 'worktree', 'remove', '--force', WT);
      assert.equal(fs.existsSync(WT), false);
    }
    const eventsPath = path.join(bundleDir, 'events.jsonl');
    const eventsBefore = fs.readFileSync(eventsPath, 'utf8');
    const stateBefore = fs.readFileSync(statePath, 'utf8');

    assert.throws(() => step({ choice: 'merge' }), new RegExp(`recorded for tip ${headA.slice(0, 12)} but the`));
    let bOnBase = true;
    try { git(MAIN, 'merge-base', '--is-ancestor', headB, 'main'); } catch { bOnBase = false; }
    assert.equal(bOnBase, false, 'B was never merged into the base');
    assert.equal(fs.readFileSync(eventsPath, 'utf8'), eventsBefore, 'no retirement written for B');
    assert.equal(fs.readFileSync(statePath, 'utf8'), stateBefore, 'state unchanged');
    if (variant.startsWith('detached')) assert.equal(fs.existsSync(WT), true, 'the detached worktree is intact');
  });
}
