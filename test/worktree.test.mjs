// test/worktree.test.mjs — the worktree-lifecycle compute core (Phase 1 of the worktree-hardening work).
// Pure functions behind the new `mp worktree plan|record|reconcile` subcommands + the extended
// worktree-integrity doctor check. Every input is a plain string/array (porcelain text, parsed lists,
// bundle records), so the lifecycle decisions — create-or-reuse, disposition normalization, crash-safe
// teardown, and the five-mode reconciler — are testable without a repo fixture. No git, no fs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  worktreePathFor,
  worktreeBranchFor,
  planWorktreeCreate,
  parseWorktreeList,
  normalizeDisposition,
  dispositionAfterTeardown,
  classifyWorktrees,
} from '../lib/worktree.mjs';

// ---- deterministic naming ----------------------------------------------------

test('worktreePathFor: <repoRoot>/.worktrees/<slug>', () => {
  assert.equal(worktreePathFor('/srv/dev/masterplan', 'brave-fox'), '/srv/dev/masterplan/.worktrees/brave-fox');
});

test('worktreePathFor: coerces a non-string slug', () => {
  assert.equal(worktreePathFor('/r', 42), '/r/.worktrees/42');
});

test('worktreeBranchFor: masterplan/<slug>', () => {
  assert.equal(worktreeBranchFor('brave-fox'), 'masterplan/brave-fox');
});

// ---- planWorktreeCreate ------------------------------------------------------

test('planWorktreeCreate: a fresh kickoff emits `git worktree add <path> -b <branch>`', () => {
  const plan = planWorktreeCreate({ slug: 'brave-fox', repoRoot: '/r' });
  assert.equal(plan.action, 'create');
  assert.equal(plan.path, '/r/.worktrees/brave-fox');
  assert.equal(plan.branch, 'masterplan/brave-fox');
  assert.deepEqual(plan.gitArgs, ['worktree', 'add', '/r/.worktrees/brave-fox', '-b', 'masterplan/brave-fox']);
});

test('planWorktreeCreate: an already-recorded canonical worktree is reused (no git)', () => {
  const plan = planWorktreeCreate({
    slug: 'brave-fox',
    repoRoot: '/r',
    existing: { path: '/r/.worktrees/brave-fox' },
  });
  assert.equal(plan.action, 'reuse');
  assert.equal(plan.path, '/r/.worktrees/brave-fox');
  assert.equal(plan.gitArgs, undefined);
});

test('planWorktreeCreate: accepts a bare string `existing` path', () => {
  const plan = planWorktreeCreate({ slug: 'x', repoRoot: '/r', existing: '/r/.worktrees/x' });
  assert.equal(plan.action, 'reuse');
});

test('planWorktreeCreate: an existing worktree at a NON-canonical path forces a create', () => {
  const plan = planWorktreeCreate({ slug: 'x', repoRoot: '/r', existing: { path: '/elsewhere/x' } });
  assert.equal(plan.action, 'create');
});

test('planWorktreeCreate: registered=true reuses even with NO recorded `existing` (crash-window idempotency)', () => {
  // The crash-between-`worktree add`-and-`worktree record` window: state carries no `worktree`, but the
  // canonical path is already a live registered worktree. Without `registered`, this would plan a second
  // `create` whose `git worktree add` fails on the already-present dir (Codex P1).
  const plan = planWorktreeCreate({ slug: 'x', repoRoot: '/r', existing: null, registered: true });
  assert.equal(plan.action, 'reuse');
  assert.equal(plan.path, '/r/.worktrees/x');
  assert.equal(plan.gitArgs, undefined);
});

test('planWorktreeCreate: registered=true reuses even when branchExists (does not fall through to a create)', () => {
  const plan = planWorktreeCreate({ slug: 'x', repoRoot: '/r', branchExists: true, registered: true });
  assert.equal(plan.action, 'reuse');
  assert.equal(plan.gitArgs, undefined);
});

test('planWorktreeCreate: branchExists drops `-b` (attach the existing branch, not create it)', () => {
  const plan = planWorktreeCreate({ slug: 'x', repoRoot: '/r', branchExists: true });
  assert.deepEqual(plan.gitArgs, ['worktree', 'add', '/r/.worktrees/x', 'masterplan/x']);
});

test('planWorktreeCreate: an explicit branch overrides the derived name', () => {
  const plan = planWorktreeCreate({ slug: 'x', repoRoot: '/r', branch: 'feature/y' });
  assert.equal(plan.branch, 'feature/y');
  assert.deepEqual(plan.gitArgs, ['worktree', 'add', '/r/.worktrees/x', '-b', 'feature/y']);
});

test('planWorktreeCreate: missing slug / repoRoot fails loud', () => {
  assert.throws(() => planWorktreeCreate({ repoRoot: '/r' }), /slug is required/);
  assert.throws(() => planWorktreeCreate({ slug: 'x' }), /repoRoot is required/);
});

// ---- parseWorktreeList -------------------------------------------------------

test('parseWorktreeList: parses multiple blocks, stripping refs/heads/ from branch', () => {
  const porcelain = [
    'worktree /srv/dev/masterplan',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /srv/dev/masterplan/.worktrees/brave-fox',
    'HEAD def456',
    'branch refs/heads/masterplan/brave-fox',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktreeList(porcelain), [
    { path: '/srv/dev/masterplan', head: 'abc123', branch: 'main', bare: false, detached: false },
    {
      path: '/srv/dev/masterplan/.worktrees/brave-fox',
      head: 'def456',
      branch: 'masterplan/brave-fox',
      bare: false,
      detached: false,
    },
  ]);
});

test('parseWorktreeList: records a detached HEAD (no branch)', () => {
  const porcelain = ['worktree /r/wt', 'HEAD abc', 'detached', ''].join('\n');
  const [e] = parseWorktreeList(porcelain);
  assert.equal(e.detached, true);
  assert.equal(e.branch, null);
});

test('parseWorktreeList: records a bare repo entry', () => {
  const [e] = parseWorktreeList(['worktree /r/bare', 'bare', ''].join('\n'));
  assert.equal(e.bare, true);
});

test('parseWorktreeList: tolerates a missing trailing blank line and CRLF', () => {
  const porcelain = 'worktree /r/a\r\nHEAD a\r\nbranch refs/heads/x\r\n';
  assert.deepEqual(parseWorktreeList(porcelain), [
    { path: '/r/a', head: 'a', branch: 'x', bare: false, detached: false },
  ]);
});

test('parseWorktreeList: empty input → []', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList(undefined), []);
});

// ---- normalizeDisposition ----------------------------------------------------

test('normalizeDisposition: the phantom `missing` maps to removed_after_merge', () => {
  assert.equal(normalizeDisposition('missing'), 'removed_after_merge');
});

test('normalizeDisposition: the three valid values pass through', () => {
  assert.equal(normalizeDisposition('active'), 'active');
  assert.equal(normalizeDisposition('removed_after_merge'), 'removed_after_merge');
  assert.equal(normalizeDisposition('kept_by_user'), 'kept_by_user');
});

test('normalizeDisposition: absent/empty/unknown → null (no disposition recorded → treat as live)', () => {
  assert.equal(normalizeDisposition(null), null);
  assert.equal(normalizeDisposition(undefined), null);
  assert.equal(normalizeDisposition(''), null);
  assert.equal(normalizeDisposition('bogus'), null);
});

// ---- dispositionAfterTeardown (crash-safe) -----------------------------------

test('dispositionAfterTeardown: merge/discard record removed_after_merge ONLY when removal confirmed', () => {
  assert.equal(dispositionAfterTeardown('merge', true), 'removed_after_merge');
  assert.equal(dispositionAfterTeardown('discard', true), 'removed_after_merge');
});

test('dispositionAfterTeardown: an unconfirmed merge/discard teardown stays active (reaped on next reconcile)', () => {
  assert.equal(dispositionAfterTeardown('merge', false), 'active');
  assert.equal(dispositionAfterTeardown('discard'), 'active'); // default removalConfirmed=false
});

test('dispositionAfterTeardown: pr/keep retain the worktree regardless of removalConfirmed', () => {
  assert.equal(dispositionAfterTeardown('pr', false), 'kept_by_user');
  assert.equal(dispositionAfterTeardown('keep', false), 'kept_by_user');
});

test('dispositionAfterTeardown: an unknown choice → null (caller leaves disposition untouched)', () => {
  assert.equal(dispositionAfterTeardown('bogus', true), null);
  assert.equal(dispositionAfterTeardown(undefined, true), null);
});

test('dispositionAfterTeardown: never emits the phantom `missing`', () => {
  for (const choice of ['merge', 'discard', 'pr', 'keep', 'bogus']) {
    for (const confirmed of [true, false]) {
      assert.notEqual(dispositionAfterTeardown(choice, confirmed), 'missing');
    }
  }
});

// ---- classifyWorktrees: the five-mode reconciler -----------------------------

const REPO_GIT = '/srv/dev/masterplan/.git';

test('classifyWorktrees: a live, owned, registered worktree → action none', () => {
  const dp = '/srv/dev/masterplan/.worktrees/brave-fox';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }],
    diskDirs: [{ name: 'brave-fox', path: dp, gitdirTarget: `${REPO_GIT}/worktrees/brave-fox` }],
    bundleRecords: [{ slug: 'brave-fox', worktree: dp, worktree_disposition: 'active', status: 'in-progress' }],
  });
  assert.equal(actions[0].action, 'none');
  assert.equal(actions[0].reason, 'active');
  assert.deepEqual(findings, []);
});

test('classifyWorktrees: a registered worktree whose bundle recorded it removed → crash-leak remove', () => {
  const dp = '/srv/dev/masterplan/.worktrees/done-run';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }],
    diskDirs: [{ name: 'done-run', path: dp, gitdirTarget: `${REPO_GIT}/worktrees/done-run` }],
    bundleRecords: [
      { slug: 'done-run', worktree: dp, worktree_disposition: 'removed_after_merge', status: 'archived' },
    ],
  });
  assert.equal(actions[0].action, 'remove');
  assert.equal(actions[0].reason, 'crash-leak');
  assert.equal(actions[0].registered, true);
  assert.equal(actions[0].slug, 'done-run');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
});

test('classifyWorktrees: a kept_by_user worktree is NEVER reaped even though retired', () => {
  const dp = '/srv/dev/masterplan/.worktrees/kept';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }],
    diskDirs: [{ name: 'kept', path: dp, gitdirTarget: `${REPO_GIT}/worktrees/kept` }],
    bundleRecords: [{ slug: 'kept', worktree: dp, worktree_disposition: 'kept_by_user', status: 'archived' }],
  });
  assert.equal(actions[0].action, 'none');
  assert.equal(actions[0].reason, 'kept-by-user');
});

test('classifyWorktrees: an unregistered dir whose .git points INTO this repo → repair (repo-move)', () => {
  const dp = '/srv/dev/masterplan/.worktrees/moved';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [],
    diskDirs: [{ name: 'moved', path: dp, gitdirTarget: `${REPO_GIT}/worktrees/moved` }],
    bundleRecords: [{ slug: 'moved', worktree: dp, worktree_disposition: 'active', status: 'in-progress' }],
  });
  assert.equal(actions[0].action, 'repair');
  assert.equal(actions[0].reason, 'repo-move');
});

test('classifyWorktrees: the cc3-visibility foreign-leftover → remove (unregistered, foreign .git)', () => {
  // The canonical live case: a full checkout under .worktrees/ whose .git points at a DIFFERENT repo
  // and which does NOT appear in this repo's `git worktree list`.
  const dp = '/srv/dev/masterplan/.worktrees/cc3-visibility';
  const foreign = '/srv/dev/superpowers-masterplan/.git/worktrees/cc3-visibility';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT, // our admin dir resolves → the "both canonical sides" gate for `remove`
    gitList: [],
    diskDirs: [
      {
        name: 'cc3-visibility',
        path: dp,
        gitdirTarget: foreign,
        gitdirCanonical: foreign, // resolves on disk + lands OUTSIDE our admin dir → PROVABLY foreign
      },
    ],
    bundleRecords: [],
  });
  assert.equal(actions[0].action, 'remove');
  assert.equal(actions[0].reason, 'foreign-leftover');
  assert.equal(actions[0].registered, false);
  assert.equal(findings.length, 1);
  assert.match(findings[0].fix, /rm -rf/);
  assert.match(findings[0].fix, /git worktree prune/);
});

// ---- Codex BLOCKER regression: pointsIntoRepo must be a normalized-path containment test, not a raw
// string prefix. Two failure shapes the old `startsWith` got wrong: a sibling-prefix admin dir, and a
// target carrying `..` segments that resolves INTO the repo.
test('classifyWorktrees: a foreign target that is a SIBLING-PREFIX of the admin dir stays foreign (path.sep boundary)', () => {
  // `.git/worktrees-decoy/x` string-prefixes `.git/worktrees` — a naive startsWith(base) would mis-read
  // a DIFFERENT repo's checkout as OUR repo-move and `git worktree repair` it (or skip the remove),
  // corrupting a foreign tree. The `base + path.sep` boundary keeps it foreign → remove.
  const dp = '/srv/dev/masterplan/.worktrees/decoy';
  const decoyTarget = `${REPO_GIT}/worktrees-decoy/decoy`;
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT, // both canonical sides resolve → the sibling-prefix decoy is PROVABLY foreign
    gitList: [],
    diskDirs: [{ name: 'decoy', path: dp, gitdirTarget: decoyTarget, gitdirCanonical: decoyTarget }],
    bundleRecords: [],
  });
  assert.equal(actions[0].action, 'remove');
  assert.equal(actions[0].reason, 'foreign-leftover');
});

// ---- Codex Round-2 realpath BLOCKER: an OUR-repo worktree reached through a symlink / NFS-automount
// ALIAS has a gitdir target that is NOT lexically under repoGitDir but CANONICALLY resolves into it. The
// containment test runs against BOTH the lexical and the canonical pair, so the canonical leg recognises
// it as ours → repair. A lexical-only test mis-read it as foreign and emitted `remove` (data loss).
test('classifyWorktrees: an NFS/symlink-aliased OUR-repo target (canonical resolves into the repo) → repair, never removed', () => {
  const dp = '/srv/dev/masterplan/.worktrees/aliased';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT,
    gitList: [],
    diskDirs: [{
      name: 'aliased',
      path: dp,
      gitdirTarget: '/net/automount/masterplan/.git/worktrees/aliased', // alias — NOT lexically ours
      gitdirCanonical: `${REPO_GIT}/worktrees/aliased`,                  // realpath collapses to ours
    }],
    bundleRecords: [{ slug: 'aliased', worktree: dp, worktree_disposition: 'active', status: 'in-progress' }],
  });
  assert.equal(actions[0].action, 'repair');
  assert.equal(actions[0].reason, 'repo-move');
});

// The conservative side of the same BLOCKER: a stray whose gitdir target is NOT lexically ours AND whose
// canonical cannot be resolved (the target dir is gone) — we CANNOT prove it foreign, so we must NOT
// auto-remove it. It classifies as foreign-unverified with action `manual`: surfaced as a WARN (the
// cc3-visibility-after-its-repo-was-deleted case is worth a human's eyes) but never auto-rm'd by the
// shell. Only a target that RESOLVES outside the repo earns `remove`.
test('classifyWorktrees: a stray with an unresolvable + not-lexically-ours gitdir target → manual WARN, NEVER removed', () => {
  const dp = '/srv/dev/masterplan/.worktrees/ghost';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [],
    diskDirs: [{ name: 'ghost', path: dp, gitdirTarget: '/vanished/other-repo/.git/worktrees/ghost', gitdirCanonical: null }],
    bundleRecords: [],
  });
  assert.equal(actions[0].action, 'manual');         // surfaced, but NOT remove/repair/prune
  assert.equal(actions[0].reason, 'foreign-unverified');
  assert.equal(findings.length, 1);                  // manual ≠ none → it DOES surface as a WARN
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /can't be resolved to PROVE it/);
  assert.match(findings[0].fix, /investigate by hand/);
  assert.match(findings[0].fix, /will NOT auto-remove/);
});

// ---- Codex Round-2 BLOCKER 1: an ACTIVE (non-retired) bundle's worktree is on disk but git lost its
// registration AND its .git resolves foreign. The stray ladder must NOT auto-`remove` a path a live run
// owns — that would be silent data loss mid-run. It classifies as `manual` (reason active-unregistered);
// the doctor's bundle->git ERROR is intentionally NOT suppressed for it (see test/doctor.test.mjs).
test('classifyWorktrees: a LIVE bundle\'s unregistered worktree with a foreign-resolving .git → manual (active-unregistered), NEVER removed', () => {
  const dp = '/srv/dev/masterplan/.worktrees/live-run';
  const foreign = '/srv/dev/superpowers-other/.git/worktrees/live-run';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT,            // admin dir resolves — a NO-rec stray here would be `remove`
    gitList: [],                              // git lost the registration
    diskDirs: [{ name: 'live-run', path: dp, gitdirTarget: foreign, gitdirCanonical: foreign }],
    bundleRecords: [{ slug: 'live-run', worktree: dp, worktree_disposition: 'active', status: 'in-progress' }],
  });
  assert.equal(actions[0].action, 'manual');               // NOT remove — a live run owns it
  assert.equal(actions[0].reason, 'active-unregistered');
  assert.equal(actions[0].slug, 'live-run');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /claimed by a LIVE bundle/);
  assert.match(findings[0].fix, /git worktree repair/);    // restore, never rm
});

// ---- Codex Round-2.5 BLOCKER: a retired record must NEVER mask a live owner of the SAME path. Two
// bundles claiming one worktree path (a reused dir / a stray `mp worktree record`) collapsed last-wins,
// so a trailing ARCHIVED record flipped recRetired true and dropped the live-owned stray to `remove`.
// The live claimant must dominate (→ active-unregistered, never remove), AND the duplicate is surfaced.
test('classifyWorktrees: a RETIRED record listed AFTER a live one for the same path must NOT reach remove (dedup prefers live)', () => {
  const dp = '/srv/dev/masterplan/.worktrees/shared';
  const foreign = '/srv/dev/superpowers-other/.git/worktrees/shared';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT,            // admin dir resolves — a NO-rec stray here WOULD be `remove`
    gitList: [],                              // git lost the registration
    diskDirs: [{ name: 'shared', path: dp, gitdirTarget: foreign, gitdirCanonical: foreign }],
    bundleRecords: [
      { slug: 'live', worktree: dp, worktree_disposition: 'active', status: 'in-progress' },
      { slug: 'old', worktree: dp, worktree_disposition: 'removed_after_merge', status: 'archived' }, // listed LAST
    ],
  });
  // The live claimant dominates: the path is classified as active-unregistered (manual), NEVER remove.
  const dpActions = actions.filter((a) => a.path === dp);
  assert.ok(!dpActions.some((a) => a.action === 'remove'),
    `a path a LIVE bundle claims must never reach remove — ${JSON.stringify(dpActions)}`);
  const live = dpActions.find((a) => a.reason === 'active-unregistered');
  assert.ok(live, `live owner classified active-unregistered — ${JSON.stringify(dpActions)}`);
  assert.equal(live.action, 'manual');
  assert.equal(live.slug, 'live');
  // The duplicate ownership itself is surfaced as a separate manual finding (Codex follow-on).
  const dup = dpActions.find((a) => a.reason === 'duplicate-ownership');
  assert.ok(dup, `duplicate ownership surfaced as manual — ${JSON.stringify(dpActions)}`);
  assert.equal(dup.action, 'manual');
  assert.deepEqual([...dup.slugs].sort(), ['live', 'old']);
  const dupFinding = findings.find((f) => /more than one bundle/.test(f.summary));
  assert.ok(dupFinding, `duplicate-ownership WARN finding — ${JSON.stringify(findings)}`);
  assert.match(dupFinding.fix, /retire the stale claimant/);
  assert.doesNotMatch(dupFinding.fix, /rm -rf/);            // never rm a duplicated (live-owned) path
});

// ---- Codex Round-2.6 finding: among MULTIPLE retired records (no live owner), `kept_by_user` is
// sacrosanct and must dominate `removed_after_merge` REGARDLESS of order — else an order-dependent
// list[0] pick could drop a deliberately-kept worktree to `remove`. And because the unregistered ladder
// has NO kept guard of its own, the guard is hoisted to cover registered AND unregistered uniformly.
test('classifyWorktrees: removed_after_merge listed BEFORE kept_by_user (unregistered, foreign) → none (kept), NEVER remove', () => {
  const dp = '/srv/dev/masterplan/.worktrees/kept-dup';
  const foreign = '/srv/dev/superpowers-other/.git/worktrees/kept-dup';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT,            // admin dir resolves — a removed-only owner here WOULD remove
    gitList: [],                              // UNREGISTERED — the branch with no kept guard of its own
    diskDirs: [{ name: 'kept-dup', path: dp, gitdirTarget: foreign, gitdirCanonical: foreign }],
    bundleRecords: [
      { slug: 'gone', worktree: dp, worktree_disposition: 'removed_after_merge', status: 'archived' }, // FIRST
      { slug: 'kept', worktree: dp, worktree_disposition: 'kept_by_user', status: 'in-progress' },      // SECOND
    ],
  });
  const dpActions = actions.filter((a) => a.path === dp);
  assert.ok(!dpActions.some((a) => a.action === 'remove'),
    `a kept_by_user claimant must protect the path from remove regardless of record order — ${JSON.stringify(dpActions)}`);
  const kept = dpActions.find((a) => a.reason === 'kept-by-user');
  assert.ok(kept, `kept_by_user dominates → none/kept-by-user — ${JSON.stringify(dpActions)}`);
  assert.equal(kept.action, 'none');
});

// The same kept-by-user sacrosanctity for a SINGLE record on an unregistered, foreign-resolving dir —
// the hoisted guard means even a lone kept_by_user worktree git forgot is never reaped (no duplicates).
test('classifyWorktrees: a lone kept_by_user worktree that is unregistered + foreign-resolving is NEVER removed', () => {
  const dp = '/srv/dev/masterplan/.worktrees/lone-kept';
  const foreign = '/srv/dev/superpowers-other/.git/worktrees/lone-kept';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT,
    gitList: [],
    diskDirs: [{ name: 'lone-kept', path: dp, gitdirTarget: foreign, gitdirCanonical: foreign }],
    bundleRecords: [{ slug: 'lone-kept', worktree: dp, worktree_disposition: 'kept_by_user', status: 'in-progress' }],
  });
  assert.equal(actions[0].action, 'none');
  assert.equal(actions[0].reason, 'kept-by-user');
});

// ---- Codex Round-2 BLOCKER 2: when OUR OWN admin dir can't be canonicalized (repoGitDirCanonical null),
// a `remove` must NOT fire on a canonical mismatch — we can't PROVE foreign without both canonical sides.
// The same disk dir that would be `remove` with a resolvable admin dir downgrades to `manual` here.
test('classifyWorktrees: an unresolvable admin dir (repoGitDirCanonical null) downgrades a foreign-resolving stray to manual, NEVER remove', () => {
  const dp = '/alias/repo/.worktrees/w';
  const { actions } = classifyWorktrees({
    repoGitDir: '/alias/repo/.git',
    repoGitDirCanonical: null,                              // our admin dir didn't realpath → can't prove foreign
    gitList: [],
    diskDirs: [{ name: 'w', path: dp, gitdirTarget: '/other-alias/repo/.git/worktrees/w', gitdirCanonical: '/real/repo/.git/worktrees/w' }],
    bundleRecords: [],
  });
  assert.equal(actions[0].action, 'manual');               // NOT remove — both canonical sides required
  assert.equal(actions[0].reason, 'foreign-unverified');
});

test('classifyWorktrees: an into-repo target with .. segments normalizes to repo-move (not foreign)', () => {
  // A target that RESOLVES inside the admin dir but carries `..` (git writes these for relatively-repaired
  // worktrees) must normalize before the containment test, or an OUR-repo worktree reads as foreign and
  // gets REMOVED (the data-loss BLOCKER). pointsIntoRepo path.resolves both sides.
  const dp = '/srv/dev/masterplan/.worktrees/moved';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [],
    diskDirs: [{ name: 'moved', path: dp, gitdirTarget: '/srv/dev/masterplan/.worktrees/../.git/worktrees/moved' }],
    bundleRecords: [{ slug: 'moved', worktree: dp, worktree_disposition: 'active', status: 'in-progress' }],
  });
  assert.equal(actions[0].action, 'repair');
  assert.equal(actions[0].reason, 'repo-move');
});

// ---- Codex MAJOR regression: Pass C (git-centric) makes the `prune` action reachable — a registered
// worktree GONE from disk whose bundle is retired. Pass A (disk-centric) structurally cannot see it.
test('classifyWorktrees: a registered worktree gone from disk + bundle retired → prune (Pass C)', () => {
  const dp = '/srv/dev/masterplan/.worktrees/pruneme';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }], // git still has the admin entry
    diskDirs: [], // ...but the directory is gone
    bundleRecords: [{ slug: 'pruneme', worktree: dp, worktree_disposition: 'removed_after_merge', status: 'archived' }],
  });
  const prune = actions.find((a) => a.action === 'prune');
  assert.ok(prune, `expected a prune action — ${JSON.stringify(actions)}`);
  assert.equal(prune.reason, 'prune');
  assert.equal(prune.slug, 'pruneme');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].fix, /git worktree prune/);
});

test('classifyWorktrees: an ACTIVE bundle whose registered worktree is gone from disk is NOT pruned', () => {
  // Pass C only reaps RETIRED-owned stale pointers. An active run mid-flight (worktree absent from THIS
  // reconcile's disk scan) is left for the bundle->git ERROR path, never pruned out from under a live run.
  const dp = '/srv/dev/masterplan/.worktrees/live';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }],
    diskDirs: [],
    bundleRecords: [{ slug: 'live', worktree: dp, worktree_disposition: 'active', status: 'in-progress' }],
  });
  assert.ok(!actions.some((a) => a.action === 'prune'), `active run must not be pruned — ${JSON.stringify(actions)}`);
});

test('classifyWorktrees: an unowned registered worktree gone from disk is NEVER pruned (no bundle = main/dev)', () => {
  // The main/dev worktree has no owning bundle record. Pass C requires a retired OWNING record, so a
  // record-less registered path is skipped — we never prune a worktree we do not own.
  const dp = '/srv/dev/masterplan/.worktrees/masterplan-ng';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }],
    diskDirs: [],
    bundleRecords: [],
  });
  assert.ok(!actions.some((a) => a.action === 'prune'), `unowned worktree must not be pruned — ${JSON.stringify(actions)}`);
});

test('classifyWorktrees: a retired bundle whose worktree IS the repo root (ran on main) is NOT pruned (primary-worktree guard)', () => {
  // Live regression caught by `node bin/doctor.mjs`: adversarial-review-integration / concurrency-guards /
  // codex-routing-fix all archived with worktree == <repoRoot> (they operated on the main checkout, no
  // linked worktree). The repo root is listed by `git worktree list` but lives OUTSIDE .worktrees/, so it
  // is never in diskDirs and looks "gone from disk" to Pass C — the underManagedWorktrees guard must skip
  // it. Pruning the primary worktree is never correct.
  const repoRoot = '/srv/dev/masterplan';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: repoRoot }, { path: `${repoRoot}/.worktrees/masterplan-ng` }],
    diskDirs: [],
    bundleRecords: [{ slug: 'ran-on-main', worktree: repoRoot, worktree_disposition: 'removed_after_merge', status: 'archived' }],
  });
  assert.ok(!actions.some((a) => a.action === 'prune'), `primary worktree must never be pruned — ${JSON.stringify(actions)}`);
});

test('classifyWorktrees: an unowned REGISTERED worktree (the dev worktree) is left alone', () => {
  // masterplan-ng: a real, registered worktree that simply has no masterplan bundle. v7 deliberately
  // never flagged this — reaping it is the exact false-positive to avoid.
  const dp = '/srv/dev/masterplan/.worktrees/masterplan-ng';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [{ path: dp }],
    diskDirs: [{ name: 'masterplan-ng', path: dp, gitdirTarget: `${REPO_GIT}/worktrees/masterplan-ng` }],
    bundleRecords: [],
  });
  assert.equal(actions[0].action, 'none');
  assert.equal(actions[0].reason, 'unowned-registered');
  assert.deepEqual(findings, []);
});

test('classifyWorktrees: an unidentified dir (no gitdir pointer) is never touched', () => {
  const dp = '/srv/dev/masterplan/.worktrees/scratch';
  const { actions } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [],
    diskDirs: [{ name: 'scratch', path: dp, gitdirTarget: null }],
    bundleRecords: [],
  });
  assert.equal(actions[0].action, 'none');
  assert.equal(actions[0].reason, 'unidentified');
});

test('classifyWorktrees: a bundle carrying the phantom `missing` → durable normalize', () => {
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    gitList: [],
    diskDirs: [],
    bundleRecords: [{ slug: 'legacy', worktree: '/r/.worktrees/legacy', worktree_disposition: 'missing', status: 'archived' }],
  });
  const norm = actions.find((a) => a.action === 'normalize');
  assert.ok(norm, 'expected a normalize action');
  assert.equal(norm.reason, 'legacy-missing');
  assert.equal(norm.slug, 'legacy');
  assert.equal(findings.length, 1);
  assert.match(findings[0].fix, /mp worktree record/);
});

test('classifyWorktrees: empty inputs → no actions, no findings', () => {
  assert.deepEqual(classifyWorktrees({ repoGitDir: REPO_GIT }), { actions: [], findings: [] });
  assert.deepEqual(classifyWorktrees({}), { actions: [], findings: [] });
});

test('classifyWorktrees: findings are exactly the non-none actions, in doctor shape', () => {
  const base = '/srv/dev/masterplan/.worktrees';
  const { actions, findings } = classifyWorktrees({
    repoGitDir: REPO_GIT,
    repoGitDirCanonical: REPO_GIT, // admin dir resolves → the foreign disk dir is PROVABLY foreign → remove
    gitList: [{ path: `${base}/leak` }, { path: `${base}/live` }], // both registered
    diskDirs: [
      { name: 'leak', path: `${base}/leak`, gitdirTarget: `${REPO_GIT}/worktrees/leak` }, // crash-leak → remove
      { name: 'foreign', path: `${base}/foreign`, gitdirTarget: '/other/.git/worktrees/foreign', gitdirCanonical: '/other/.git/worktrees/foreign' }, // resolves outside → remove
      { name: 'live', path: `${base}/live`, gitdirTarget: `${REPO_GIT}/worktrees/live` }, // registered+active → none
    ],
    bundleRecords: [
      { slug: 'leak', worktree: `${base}/leak`, worktree_disposition: 'removed_after_merge', status: 'archived' },
      { slug: 'live', worktree: `${base}/live`, worktree_disposition: 'active', status: 'in-progress' },
    ],
  });
  const nonNone = actions.filter((a) => a.action !== 'none');
  assert.equal(findings.length, nonNone.length);
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.id, 'worktree-integrity');
    assert.equal(f.severity, 'WARN');
    assert.equal(typeof f.summary, 'string');
    assert.equal(typeof f.fix, 'string');
  }
});
