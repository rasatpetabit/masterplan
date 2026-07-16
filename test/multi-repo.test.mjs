// test/multi-repo.test.mjs — fabric multi-repo locus resolution.
//
// Covers the amd64-first-class failure modes:
//   1. Umbrella-relative docs path → worktree locus
//   2. Sibling prefix (yanos-os/...) → sibling worktree locus + stripped files
//   3. create_files auto-opt-in when target missing
//   4. Multi-repo task files → loud error
//   5. ensureSiblingWorktree create-or-reuse against a real temp sibling git repo

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  isGitCheckout,
  resolveFileLocus,
  groupFilesByRepo,
  buildFabricLocus,
  ensureSiblingWorktree,
  rewriteVerifyForSibling,
  captureMultiRepoFiles,
  mapUmbrellaPathsToRepos,
} from '../lib/dispatch/multi-repo.mjs';
import { worktreePathFor, worktreeBranchFor } from '../lib/worktree.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content = 'x\n') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Umbrella MAIN + worktree + one sibling git repo (yanos-os), matching yanos-project layout. */
function makeUmbrellaFixture({ withSiblingWt = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-mrepo-'));
  const MAIN = path.join(tmp, 'yanos-project');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 't@t');
  git(MAIN, 'config', 'user.name', 't');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'docs/seed.md', 'seed\n');
  write(MAIN, '.gitignore', 'yanos-os/\nyanos-builder/\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');

  const slug = 'amd64-first-class';
  const branch = worktreeBranchFor(slug);
  git(MAIN, 'worktree', 'add', worktreePathFor(MAIN, slug), '-b', branch);
  const WT = worktreePathFor(MAIN, slug);

  // Sibling git repo under MAIN (gitignored by umbrella).
  const SIB = path.join(MAIN, 'yanos-os');
  fs.mkdirSync(SIB, { recursive: true });
  git(SIB, 'init', '--initial-branch=main');
  git(SIB, 'config', 'user.email', 't@t');
  git(SIB, 'config', 'user.name', 't');
  git(SIB, 'config', 'commit.gpgsign', 'false');
  write(SIB, 'kas/yanos-z9264f.yaml', 'machine: z9264f\n');
  git(SIB, 'add', '.');
  git(SIB, 'commit', '-q', '-m', 'os seed');

  if (withSiblingWt) {
    git(SIB, 'worktree', 'add', worktreePathFor(SIB, slug), '-b', branch);
  }

  return { tmp, MAIN, WT, SIB, slug, branch };
}

test('isGitCheckout: detects .git dir', () => {
  const { MAIN, WT } = makeUmbrellaFixture();
  assert.equal(isGitCheckout(MAIN), true);
  assert.equal(isGitCheckout(WT), true);
  assert.equal(isGitCheckout(path.join(MAIN, 'docs')), false);
});

test('resolveFileLocus: umbrella docs path stays on worktree', () => {
  const { MAIN, WT, slug } = makeUmbrellaFixture();
  const loc = resolveFileLocus('docs/masterplan/x/gaps-report.md', {
    worktree: WT, mainRoot: MAIN, slug,
  });
  assert.equal(loc.repo, WT);
  assert.equal(loc.rel, 'docs/masterplan/x/gaps-report.md');
  assert.equal(loc.siblingName, null);
});

test('resolveFileLocus: yanos-os/ prefix → sibling (worktree when present)', () => {
  const { MAIN, WT, SIB, slug, branch } = makeUmbrellaFixture({ withSiblingWt: true });
  const loc = resolveFileLocus('yanos-os/kas/yanos-z9264f.yaml', {
    worktree: WT, mainRoot: MAIN, slug,
  });
  assert.equal(loc.repo, worktreePathFor(SIB, slug));
  assert.equal(loc.rel, 'kas/yanos-z9264f.yaml');
  assert.equal(loc.siblingName, 'yanos-os');
  assert.equal(loc.branch, branch);
});

test('resolveFileLocus: yanos-os/ prefix without wt → sibling MAIN (provisional)', () => {
  const { MAIN, WT, SIB, slug } = makeUmbrellaFixture({ withSiblingWt: false });
  const loc = resolveFileLocus('yanos-os/kas/yanos-z9264f.yaml', {
    worktree: WT, mainRoot: MAIN, slug,
  });
  assert.equal(loc.repo, SIB);
  assert.equal(loc.rel, 'kas/yanos-z9264f.yaml');
});

test('buildFabricLocus: creates sibling worktree + strips prefix + create_files for missing', () => {
  const { MAIN, WT, SIB, slug, branch } = makeUmbrellaFixture({ withSiblingWt: false });
  // Existing file
  const existing = buildFabricLocus(['yanos-os/kas/yanos-z9264f.yaml'], {
    worktree: WT, mainRoot: MAIN, slug, ensureSiblings: true,
  });
  assert.equal(existing.repo, worktreePathFor(SIB, slug));
  assert.deepEqual(existing.files, ['kas/yanos-z9264f.yaml']);
  assert.equal(existing.create_files, false); // exists in sibling wt (copied from branch)
  assert.equal(existing.branch, branch);
  assert.equal(existing.siblingName, 'yanos-os');
  assert.ok(fs.existsSync(worktreePathFor(SIB, slug)));

  // New file under sibling
  const created = buildFabricLocus(['yanos-os/layers/meta-yanos-bsp/conf/machine/new.conf'], {
    worktree: WT, mainRoot: MAIN, slug, ensureSiblings: true,
  });
  assert.equal(created.create_files, true);
  assert.deepEqual(created.files, ['layers/meta-yanos-bsp/conf/machine/new.conf']);
});

test('buildFabricLocus: umbrella new file sets create_files', () => {
  const { MAIN, WT, slug } = makeUmbrellaFixture();
  const locus = buildFabricLocus(['docs/masterplan/amd64-first-class/gaps-report.md'], {
    worktree: WT, mainRoot: MAIN, slug, ensureSiblings: false,
  });
  assert.equal(locus.repo, WT);
  assert.equal(locus.create_files, true);
  assert.deepEqual(locus.files, ['docs/masterplan/amd64-first-class/gaps-report.md']);
});

test('buildFabricLocus: mixed umbrella + sibling throws loud', () => {
  const { MAIN, WT, slug } = makeUmbrellaFixture({ withSiblingWt: true });
  assert.throws(
    () => buildFabricLocus(
      ['docs/a.md', 'yanos-os/kas/x.yaml'],
      { worktree: WT, mainRoot: MAIN, slug, ensureSiblings: true },
    ),
    /span 2 repos/,
  );
});

test('ensureSiblingWorktree: reuse when already registered', () => {
  const { SIB, slug, branch } = makeUmbrellaFixture({ withSiblingWt: true });
  const r = ensureSiblingWorktree({ siblingMain: SIB, slug, branch });
  assert.equal(r.action, 'reuse');
  assert.equal(r.path, worktreePathFor(SIB, slug));
});

test('rewriteVerifyForSibling: strips sibling prefix tokens', () => {
  const cmds = [
    'rg -n LAYERDEPENDS yanos-os/kas/yanos-z9264f.yaml yanos-os/layers/meta-yanos/conf/layer.conf',
    'test -f docs/masterplan/x/gaps-report.md',
  ];
  const out = rewriteVerifyForSibling(cmds, 'yanos-os');
  assert.equal(
    out[0],
    'rg -n LAYERDEPENDS kas/yanos-z9264f.yaml layers/meta-yanos/conf/layer.conf',
  );
  // Non-sibling paths untouched
  assert.equal(out[1], 'test -f docs/masterplan/x/gaps-report.md');
});

test('groupFilesByRepo: partitions correctly', () => {
  const { MAIN, WT, slug } = makeUmbrellaFixture({ withSiblingWt: true });
  const g = groupFilesByRepo(
    ['docs/a.md', 'yanos-os/kas/x.yaml', 'docs/b.md'],
    { worktree: WT, mainRoot: MAIN, slug },
  );
  assert.equal(g.size, 2);
  const wtGroup = g.get(WT);
  assert.deepEqual(wtGroup.files.sort(), ['docs/a.md', 'docs/b.md']);
});

test('captureMultiRepoFiles: umbrella + sibling dirt returned as umbrella-relative paths', () => {
  const { MAIN, WT, SIB, slug } = makeUmbrellaFixture({ withSiblingWt: true });
  // Dirty umbrella
  write(WT, 'docs/dirty.md', 'd\n');
  // Dirty sibling worktree
  const sibWt = worktreePathFor(SIB, slug);
  write(sibWt, 'kas/extra.yaml', 'e\n');

  const files = captureMultiRepoFiles(
    ['docs/dirty.md', 'yanos-os/kas/extra.yaml'],
    {
      worktree: WT,
      mainRoot: MAIN,
      slug,
      captureWtFiles: (repo) => {
        // Minimal stand-in: list untracked under repo
        const out = [];
        const walk = (dir, prefix = '') => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name === '.git' || ent.name === '.worktrees') continue;
            const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full, rel);
            else out.push(rel);
          }
        };
        walk(repo);
        return out;
      },
    },
  );
  assert.ok(files.includes('docs/dirty.md') || files.some((f) => f.endsWith('dirty.md')));
  assert.ok(files.some((f) => f === 'yanos-os/kas/extra.yaml' || f.endsWith('kas/extra.yaml')));
});

test('mapUmbrellaPathsToRepos: strips sibling prefix per locus', () => {
  const loci = [
    { repo: '/wt', prefix: null },
    { repo: '/sib-wt', prefix: 'yanos-os' },
  ];
  const m = mapUmbrellaPathsToRepos(
    ['docs/a.md', 'yanos-os/kas/x.yaml', 'yanos-os/layers/y.conf'],
    loci,
  );
  assert.deepEqual(m.get('/wt'), ['docs/a.md']);
  assert.deepEqual(m.get('/sib-wt'), ['kas/x.yaml', 'layers/y.conf']);
});
