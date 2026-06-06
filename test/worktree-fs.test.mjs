// test/worktree-fs.test.mjs — the fs-collection layer feeding the PURE classifyWorktrees reconciler.
// classifyWorktrees (lib/worktree.mjs) is pure and tested with plain arrays in test/worktree.test.mjs;
// this file covers the IMPURE collectors (lib/worktree-fs.mjs) that read real .worktrees/* dirs and
// docs/masterplan/* bundles. The headline case is the Codex BLOCKER: readGitdirTarget must resolve a
// RELATIVE `gitdir:` target to absolute, or a valid OUR-repo worktree mis-reads as foreign downstream
// and gets removed (data loss). fs only here — still no git (CD-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGitdirTarget, collectDiskDirs, collectBundleRecords } from '../lib/worktree-fs.mjs';

function mkWorktree(root, name, gitContents) {
  const d = path.join(root, '.worktrees', name);
  fs.mkdirSync(d, { recursive: true });
  if (gitContents !== undefined) fs.writeFileSync(path.join(d, '.git'), gitContents);
  return d;
}

test('readGitdirTarget: a RELATIVE gitdir target resolves to absolute against the worktree dir (the BLOCKER)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wtfs-'));
  // git writes a relative pointer for a relatively-created/repaired worktree.
  const dp = mkWorktree(tmp, 'rel', 'gitdir: ../../.git/worktrees/rel\n');
  const got = readGitdirTarget(dp);
  assert.equal(got, path.resolve(dp, '../../.git/worktrees/rel'));
  assert.ok(path.isAbsolute(got), 'a resolved target is always absolute');
  // And it points where the pure pointsIntoRepo expects: under <repoRoot>/.git/worktrees/.
  assert.equal(got, path.join(tmp, '.git', 'worktrees', 'rel'));
});

test('readGitdirTarget: an ABSOLUTE gitdir target is normalized and returned as-is', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wtfs-'));
  const target = path.join(tmp, '.git', 'worktrees', 'abs');
  const dp = mkWorktree(tmp, 'abs', `gitdir: ${target}\n`);
  assert.equal(readGitdirTarget(dp), target);
});

test('readGitdirTarget: a real `.git` DIRECTORY (nested clone), absent `.git`, and malformed content all → null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wtfs-'));
  const nested = path.join(tmp, '.worktrees', 'clone');
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true }); // .git is a DIR, not the linked-worktree FILE
  assert.equal(readGitdirTarget(nested), null);

  const bare = mkWorktree(tmp, 'bare'); // no .git at all
  assert.equal(readGitdirTarget(bare), null);

  const junk = mkWorktree(tmp, 'junk', 'not a gitdir line\n');
  assert.equal(readGitdirTarget(junk), null);

  const empty = mkWorktree(tmp, 'empty', 'gitdir:   \n'); // present key, blank value
  assert.equal(readGitdirTarget(empty), null);
});

test('collectDiskDirs: tags each .worktrees/* dir with its resolved gitdir target; absent .worktrees → []', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wtfs-'));
  assert.deepEqual(collectDiskDirs(tmp), []); // no .worktrees/ yet

  mkWorktree(tmp, 'rel', 'gitdir: ../../.git/worktrees/rel\n');
  mkWorktree(tmp, 'foreign', 'gitdir: /other/.git/worktrees/foreign\n');
  fs.writeFileSync(path.join(tmp, '.worktrees', 'loose.txt'), 'x'); // a non-dir entry is ignored

  const dirs = collectDiskDirs(tmp).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(dirs.length, 2);
  assert.deepEqual(dirs.map((d) => d.name), ['foreign', 'rel']);
  assert.equal(dirs.find((d) => d.name === 'rel').gitdirTarget, path.join(tmp, '.git', 'worktrees', 'rel'));
  assert.equal(dirs.find((d) => d.name === 'foreign').gitdirTarget, '/other/.git/worktrees/foreign');
});

test('collectDiskDirs: gitdirCanonical collapses a symlink alias to the real admin dir; null when the target is gone', () => {
  // The Codex realpath BLOCKER inputs: an OUR-repo worktree whose .git points through a symlink/NFS
  // alias must still canonicalize to the real admin dir so the classifier recognises it as ours (repair,
  // not remove). An unresolvable target yields null so the classifier refuses to PROVE it foreign.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wtfs-'));
  const realAdmin = path.join(tmp, '.git', 'worktrees', 'sym');
  fs.mkdirSync(realAdmin, { recursive: true });
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(path.join(tmp, '.git'), alias); // alias -> <tmp>/.git
  mkWorktree(tmp, 'sym', `gitdir: ${path.join(alias, 'worktrees', 'sym')}\n`); // points THROUGH the alias
  mkWorktree(tmp, 'gone', 'gitdir: /nope/.git/worktrees/gone\n');               // target does not exist

  const dirs = collectDiskDirs(tmp);
  const sym = dirs.find((d) => d.name === 'sym');
  assert.equal(sym.gitdirTarget, path.join(alias, 'worktrees', 'sym'));         // lexical keeps the alias
  assert.equal(sym.gitdirCanonical, fs.realpathSync.native(realAdmin));          // canonical collapses it
  const gone = dirs.find((d) => d.name === 'gone');
  assert.equal(gone.gitdirCanonical, null);                                      // unresolvable -> null
});

test('collectBundleRecords: one record per readable bundle; missing runs dir / unreadable state.yml tolerated', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wtfs-'));
  assert.deepEqual(collectBundleRecords(tmp), []); // no docs/masterplan/ yet

  const bundle = (slug, body) => {
    const d = path.join(tmp, 'docs', 'masterplan', slug);
    fs.mkdirSync(d, { recursive: true });
    if (body !== undefined) fs.writeFileSync(path.join(d, 'state.yml'), body);
  };
  bundle('one', 'slug: one\nstatus: in-progress\nworktree: /w/one\nworktree_disposition: active\n');
  bundle('two', 'slug: two\nstatus: archived\nworktree_disposition: removed_after_merge\n');
  bundle('nostate'); // a bundle dir with no state.yml → skipped, not thrown

  const recs = collectBundleRecords(tmp).sort((a, b) => a.slug.localeCompare(b.slug));
  assert.deepEqual(recs.map((r) => r.slug), ['one', 'two']);
  const one = recs.find((r) => r.slug === 'one');
  assert.equal(one.worktree, '/w/one');
  assert.equal(one.worktree_disposition, 'active');
  assert.equal(one.status, 'in-progress');
});
