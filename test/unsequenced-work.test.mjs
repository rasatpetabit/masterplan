// test/unsequenced-work.test.mjs — unit tests for lib/doctor/unsequenced-work.mjs (Issue #25).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ID, check } from '../lib/doctor/unsequenced-work.mjs';
import { buildSeedState, writeState } from '../lib/bundle.mjs';
import { runGit } from './helpers/git-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const TMP_DIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  TMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const d of TMP_DIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

function initGitRepo({ branch = 'main', empty = false } = {}) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-unseq-'));
  runGit(dir, ['init', '-b', branch]);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test User']);
  if (!empty) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    runGit(dir, ['add', 'README.md']);
    runGit(dir, ['commit', '-m', 'chore: initial commit']);
  }
  return dir;
}

function seedBundle(dir, slug, overrides = {}) {
  const bundleDir = path.join(dir, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  const state = {
    ...buildSeedState({
      slug,
      topic: `Test topic for ${slug}`,
      createdAt: '2026-07-01T00:00:00.000Z',
    }),
    ...overrides,
  };
  writeState(path.join(bundleDir, 'state.yml'), state);
  return { bundleDir, statePath: path.join(bundleDir, 'state.yml') };
}

test('unsequenced-work: SKIP when docs/masterplan does not exist', () => {
  const dir = initGitRepo();
  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'SKIP');
  assert.match(findings[0].summary, /no docs\/masterplan/);
});

test('unsequenced-work: SKIP when only archived or phase=execute bundles exist', () => {
  const dir = initGitRepo();
  seedBundle(dir, 'archived-brainstorm', { status: 'archived', phase: 'brainstorm' });
  seedBundle(dir, 'active-execute', {
    status: 'in-progress',
    phase: 'execute',
    tasks: [{ id: 1, status: 'pending', wave: 0, files: ['src/a.js'] }],
  });

  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'SKIP');
  assert.equal(findings[0].summary, 'no active pre-execute bundle to check');
});

test('unsequenced-work: PASS when a brainstorm bundle has no code branch and no worktree', () => {
  const dir = initGitRepo();
  seedBundle(dir, 'clean-brainstorm', { phase: 'brainstorm' });

  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'PASS');
  assert.equal(findings[0].fix, null);
});

test('unsequenced-work: PASS when masterplan/<slug> branch has ONLY bundle-dir commits', () => {
  const dir = initGitRepo();
  const slug = 'bundle-only-branch';
  runGit(dir, ['checkout', '-b', `masterplan/${slug}`]);
  const { bundleDir } = seedBundle(dir, slug, { phase: 'brainstorm' });
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# Spec\n', 'utf8');
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '{"type":"bundle_created"}\n', 'utf8');
  runGit(dir, ['add', `docs/masterplan/${slug}`]);
  runGit(dir, ['commit', '-m', 'docs: add brainstorm spec and events']);
  runGit(dir, ['checkout', 'main']);
  // Bundle state lives on disk in the current working tree while branch commits stay bundle-only
  seedBundle(dir, slug, { phase: 'brainstorm' });

  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('unsequenced-work: PASS when unrelated commits land on main while brainstorm bundle has no code branch', () => {
  const dir = initGitRepo();
  seedBundle(dir, 'no-branch-yet', { phase: 'brainstorm' });

  // Unrelated commits land on main after bundle creation
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'unrelated.js'), 'export const x = 1;\n', 'utf8');
  runGit(dir, ['add', 'src/unrelated.js']);
  runGit(dir, ['commit', '-m', 'feat: unrelated work on main']);

  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('unsequenced-work: WARN when brainstorm or plan bundle has non-bundle commits on masterplan/<slug>', () => {
  for (const phase of ['brainstorm', 'plan']) {
    const dir = initGitRepo();
    const slug = `code-on-branch-${phase}`;
    const branch = `masterplan/${slug}`;
    runGit(dir, ['checkout', '-b', branch]);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'impl.js'), 'export const impl = true;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'src', 'helper.js'), 'export const helper = true;\n', 'utf8');
    runGit(dir, ['add', 'src']);
    runGit(dir, ['commit', '-m', 'feat: implement before plan']);
    runGit(dir, ['checkout', 'main']);

    seedBundle(dir, slug, { phase });

    const findings = check(dir);
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.equal(findings[0].id, ID);
    assert.equal(findings[0].severity, 'WARN');
    assert.match(findings[0].summary, new RegExp(slug));
    assert.match(findings[0].summary, new RegExp(`phase "${phase}"`));
    assert.match(findings[0].summary, /0 tasks/);
    assert.match(findings[0].summary, new RegExp(`branch "${branch}"`));
    assert.match(findings[0].summary, /1 commit\(s\) touching 2 non-bundle file\(s\)/);
    assert.match(findings[0].fix, /mp load-plan/);
  }
});

test('unsequenced-work: WARN when brainstorm bundle has linked state.worktree with non-bundle commits beyond base', () => {
  const dir = initGitRepo();
  const slug = 'wt-commits';
  const wtDir = path.join(dir, '.worktrees', slug);
  runGit(dir, ['worktree', 'add', wtDir, '-b', `masterplan/${slug}`]);

  fs.mkdirSync(path.join(wtDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(wtDir, 'lib', 'feature.mjs'), 'export function f() {}\n', 'utf8');
  runGit(wtDir, ['add', 'lib/feature.mjs']);
  runGit(wtDir, ['commit', '-m', 'feat: code inside worktree']);

  seedBundle(dir, slug, { phase: 'brainstorm', worktree: wtDir, branch: `masterplan/${slug}` });

  const findings = check(dir);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, new RegExp(slug));
  assert.match(findings[0].summary, /phase "brainstorm"/);
  assert.match(findings[0].summary, /1 commit\(s\) touching 1 non-bundle file\(s\)/);
  assert.match(findings[0].fix, /mp load-plan/);
});

test('unsequenced-work: WARN when brainstorm bundle has linked state.worktree with uncommitted non-bundle edits', () => {
  const dir = initGitRepo();
  const slug = 'wt-dirty';
  const wtDir = path.join(dir, '.worktrees', slug);
  runGit(dir, ['worktree', 'add', wtDir, '-b', `masterplan/${slug}`]);

  // Untracked/modified code file inside the linked worktree
  fs.mkdirSync(path.join(wtDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wtDir, 'src', 'draft.mjs'), 'export const wip = 1;\n', 'utf8');
  // Also an untracked bundle file inside the worktree — must NOT mask or confuse bundle-only vs code
  const wtBundleDir = path.join(wtDir, 'docs', 'masterplan', slug);
  fs.mkdirSync(wtBundleDir, { recursive: true });
  fs.writeFileSync(path.join(wtBundleDir, 'spec.md'), '# Spec\n', 'utf8');

  seedBundle(dir, slug, { phase: 'brainstorm', worktree: wtDir, branch: `masterplan/${slug}` });

  const findings = check(dir);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].id, ID);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, new RegExp(slug));
  assert.match(findings[0].summary, /1 uncommitted non-bundle file\(s\)/);
  assert.match(findings[0].fix, /mp load-plan/);
});

test('unsequenced-work: PASS when linked state.worktree has only untracked/committed bundle-dir files', () => {
  const dir = initGitRepo();
  const slug = 'wt-bundle-only';
  const wtDir = path.join(dir, '.worktrees', slug);
  runGit(dir, ['worktree', 'add', wtDir, '-b', `masterplan/${slug}`]);

  const wtBundleDir = path.join(wtDir, 'docs', 'masterplan', slug);
  fs.mkdirSync(wtBundleDir, { recursive: true });
  fs.writeFileSync(path.join(wtBundleDir, 'spec.md'), '# Spec\n', 'utf8');
  runGit(wtDir, ['add', `docs/masterplan/${slug}/spec.md`]);
  runGit(wtDir, ['commit', '-m', 'docs: spec in worktree']);
  // Also an untracked bundle file in an untracked directory under docs/masterplan/<slug>/
  fs.writeFileSync(path.join(wtBundleDir, 'notes.md'), '# Notes\n', 'utf8');

  seedBundle(dir, slug, { phase: 'plan', worktree: wtDir, branch: `masterplan/${slug}` });

  const findings = check(dir);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('unsequenced-work: checks state.branch and coordination.local_run_branch candidates', () => {
  const dir = initGitRepo();
  const slug = 'custom-branch';
  runGit(dir, ['checkout', '-b', 'feat/custom']);
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n', 'utf8');
  runGit(dir, ['add', 'app.js']);
  runGit(dir, ['commit', '-m', 'feat: unsequenced custom branch']);
  runGit(dir, ['checkout', 'main']);

  seedBundle(dir, slug, { phase: 'plan', branch: 'feat/custom' });

  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /branch "feat\/custom"/);
});

test('unsequenced-work: guards cleanly against non-git dirs, unborn HEAD, and missing worktree paths', () => {
  // Non-git temp dir with active brainstorm bundle -> clean SKIP (no crash)
  const nonGit = mkdtempTracked(path.join(os.tmpdir(), 'mp-unseq-nongit-'));
  seedBundle(nonGit, 'nongit-slug', { phase: 'brainstorm' });
  const nonGitFindings = check(nonGit);
  assert.equal(nonGitFindings.length, 1);
  assert.equal(nonGitFindings[0].severity, 'SKIP');

  // Git repo with unborn HEAD and missing worktree path -> clean PASS (no crash)
  const unborn = initGitRepo({ empty: true });
  seedBundle(unborn, 'unborn-slug', {
    phase: 'brainstorm',
    worktree: path.join(unborn, '.worktrees', 'missing'),
  });
  const unbornFindings = check(unborn);
  assert.equal(unbornFindings.length, 1);
  assert.equal(unbornFindings[0].severity, 'PASS', JSON.stringify(unbornFindings));
});

test('unsequenced-work: does not treat repoRoot itself as a separate dirty worktree', () => {
  const dir = initGitRepo();
  const slug = 'same-root-wt';
  // Unrelated dirty file in repoRoot when state.worktree points at repoRoot itself
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'user wip\n', 'utf8');
  seedBundle(dir, slug, { phase: 'brainstorm', worktree: dir });

  const findings = check(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'PASS', JSON.stringify(findings));
});

test('unsequenced-work: auto-discovered by bin/doctor.mjs', () => {
  const dir = initGitRepo();
  const slug = 'cli-discovered';
  runGit(dir, ['checkout', '-b', `masterplan/${slug}`]);
  fs.writeFileSync(path.join(dir, 'code.js'), 'export const a = 1;\n', 'utf8');
  runGit(dir, ['add', 'code.js']);
  runGit(dir, ['commit', '-m', 'feat: unsequenced']);
  runGit(dir, ['checkout', 'main']);
  seedBundle(dir, slug, { phase: 'brainstorm' });

  const res = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'doctor.mjs'), '--only=unsequenced-work', dir], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /WARN\s+unsequenced-work:/);
  assert.match(res.stdout, new RegExp(slug));
});

test('unsequenced-work: inspects later candidate branches when an earlier candidate only has bundle-only commits', () => {
  const dir = initGitRepo();
  const slug = 'multi-cand';

  // state.branch diverges with ONLY a bundle-dir commit (clean on its own)
  runGit(dir, ['checkout', '-b', 'feat/bundle-only']);
  const bDir = path.join(dir, 'docs', 'masterplan', slug);
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, 'spec.md'), '# spec\n', 'utf8');
  runGit(dir, ['add', `docs/masterplan/${slug}/spec.md`]);
  runGit(dir, ['commit', '-m', 'docs: spec only']);

  // coordination.local_run_branch carries real non-bundle implementation code
  runGit(dir, ['checkout', 'main']);
  runGit(dir, ['checkout', '-b', 'feat/real-code']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'impl.js'), 'export const x = 1;\n', 'utf8');
  runGit(dir, ['add', 'src/impl.js']);
  runGit(dir, ['commit', '-m', 'feat: unsequenced code on second candidate']);
  runGit(dir, ['checkout', 'main']);

  seedBundle(dir, slug, {
    phase: 'brainstorm',
    branch: 'feat/bundle-only',
    coordination: { local_run_branch: 'feat/real-code' },
  });

  const findings = check(dir);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].summary, /branch "feat\/real-code"/);
});

test('unsequenced-work: does not falsely PASS when repo lacks main/master and HEAD is on the code branch', () => {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-unseq-nomain-'));
  runGit(dir, ['init', '-b', 'trunk']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  runGit(dir, ['add', 'README.md']);
  runGit(dir, ['commit', '-m', 'init']);

  const slug = 'checked-out-code';
  runGit(dir, ['checkout', '-b', `masterplan/${slug}`]);
  fs.writeFileSync(path.join(dir, 'impl.js'), 'export const y = 2;\n', 'utf8');
  runGit(dir, ['add', 'impl.js']);
  runGit(dir, ['commit', '-m', 'feat: unsequenced on checked-out branch']);

  seedBundle(dir, slug, { phase: 'brainstorm' });

  const findings = check(dir);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].severity, 'SKIP', 'must not falsely certify PASS when no base ref resolves');
});

test('unsequenced-work: reports WARN instead of false PASS when git output exceeds maxBuffer', () => {
  const dir = initGitRepo();
  const slug = 'overflow-case';
  runGit(dir, ['checkout', '-b', `masterplan/${slug}`]);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a-very-long-filename-for-buffer-overflow-check.js'), 'export const z = 3;\n', 'utf8');
  runGit(dir, ['add', 'src/a-very-long-filename-for-buffer-overflow-check.js']);
  runGit(dir, ['commit', '-m', 'feat: trigger tiny maxBuffer']);
  runGit(dir, ['checkout', 'main']);

  seedBundle(dir, slug, { phase: 'brainstorm' });

  const findings = check(dir, { maxBuffer: 16 });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].severity, 'WARN', JSON.stringify(findings));
  assert.match(findings[0].summary, /could not be inspected/);
});
