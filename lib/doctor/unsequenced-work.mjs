// lib/doctor/unsequenced-work.mjs — detect an active pre-execute bundle
// (`phase` in `brainstorm` | `plan`) whose code branch or worktree already has
// non-bundle implementation commits or dirty code edits without a plan ever
// being loaded/executed.
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml + git branches/worktrees.
// Never throws on non-git dirs, unborn HEAD, missing base branch, or missing worktrees.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getBundles } from './_bundles.mjs';
import { gitEnv } from '../config.mjs';

export const ID = 'unsequenced-work';

const PRE_EXECUTE_PHASES = new Set(['brainstorm', 'plan']);
const BASE_REF_CANDIDATES = [
  'refs/heads/main',
  'refs/heads/master',
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
];
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const FIX_GUIDANCE =
  'load a plan via `mp load-plan` and advance to `execute`, or reconcile/archive the bundle if the work already landed';

function git(dir, args, opts = {}) {
  return String(
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: gitEnv({}, undefined, { stripIndex: true }),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
    }),
  );
}

function tryGit(dir, args, opts) {
  try {
    return git(dir, args, opts);
  } catch {
    return null;
  }
}

function tryGitDetailed(dir, args, opts) {
  try {
    return { ok: true, stdout: git(dir, args, opts) };
  } catch (err) {
    const code = err?.code ? `${err.code}: ` : '';
    const msg = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    return { ok: false, error: `${code}${msg || 'git command failed'}` };
  }
}

function tryRev(dir, rev) {
  const out = tryGit(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = out ? out.trim() : '';
  return sha || null;
}

function isGitRepo(dir) {
  return tryGit(dir, ['rev-parse', '--git-dir']) !== null;
}

function repoHasAnyCommit(repoRoot) {
  if (tryRev(repoRoot, 'HEAD')) return true;
  const refs = tryGit(repoRoot, ['for-each-ref', '--count=1', '--format=%(objectname)', 'refs/heads']);
  return !!(refs && refs.trim());
}

function resolveBaseRef(repoRoot) {
  // Prefer local main/master, then origin/HEAD (if configured), then origin/main|master.
  // Never fall back to HEAD: if the repo has no default branch and the bundle's own code
  // branch is checked out as HEAD, comparing against HEAD would mask every commit on it.
  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    const sha = tryRev(repoRoot, ref);
    if (sha) return { ref, sha };
  }
  const sym = tryGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym && sym.trim()) {
    const ref = sym.trim();
    const sha = tryRev(repoRoot, ref);
    if (sha) return { ref, sha };
  }
  for (const ref of BASE_REF_CANDIDATES.slice(2)) {
    const sha = tryRev(repoRoot, ref);
    if (sha) return { ref, sha };
  }
  return null;
}

function canonicalRealpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }
}

function normalizeRelPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function isDistinctGitWorktree(wtDir, repoRootRealpath) {
  let st;
  try {
    st = fs.statSync(wtDir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;

  const wtReal = canonicalRealpath(wtDir);
  if (!wtReal || !repoRootRealpath || wtReal === repoRootRealpath) return false;

  const inside = tryGit(wtDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return false;

  const top = tryGit(wtDir, ['rev-parse', '--show-toplevel']);
  if (!top) return false;
  const topReal = canonicalRealpath(top.trim());
  return !!topReal && topReal === wtReal;
}

function inspectCommitRange(dir, mergeBase, targetSha, bundlePrefix, gitOpts) {
  const res = tryGitDetailed(dir, [
    '-c',
    'core.quotePath=false',
    'log',
    '-m',
    '--first-parent',
    '--no-renames',
    '--name-only',
    '-z',
    '--pretty=format:%x1e%H',
    `${mergeBase}..${targetSha}`,
  ], gitOpts);
  if (!res.ok) return { ok: false, error: res.error, commitCount: 0, fileCount: 0 };
  const raw = res.stdout;
  if (!raw) return { ok: true, commitCount: 0, fileCount: 0 };

  let commitCount = 0;
  const nonBundleFiles = new Set();

  for (const chunk of raw.split('\x1e')) {
    if (!chunk) continue;
    let body = chunk;
    while (body.endsWith('\0')) body = body.slice(0, -1);
    if (!body) continue;

    const nl = body.indexOf('\n');
    if (nl === -1) continue;
    const filePart = body.slice(nl + 1);
    if (!filePart) continue;

    let touchesNonBundle = false;
    for (const rawFile of filePart.split('\0')) {
      if (!rawFile) continue;
      const norm = normalizeRelPath(rawFile);
      if (!norm.startsWith(bundlePrefix)) {
        touchesNonBundle = true;
        nonBundleFiles.add(norm);
      }
    }
    if (touchesNonBundle) commitCount += 1;
  }

  return { ok: true, commitCount, fileCount: nonBundleFiles.size };
}

function inspectDirtyWorktree(wtDir, bundlePrefix, gitOpts) {
  const res = tryGitDetailed(wtDir, [
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain',
    '--untracked-files=all',
    '-z',
  ], gitOpts);
  if (!res.ok) return { ok: false, error: res.error, dirtyCount: 0 };
  const raw = res.stdout;
  if (!raw) return { ok: true, dirtyCount: 0 };

  const records = raw.split('\0');
  const dirtyFiles = new Set();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const p = normalizeRelPath(rec.slice(3));
    if (p && !p.startsWith(bundlePrefix)) dirtyFiles.add(p);
    if (xy.includes('R') || xy.includes('C')) {
      const src = normalizeRelPath(records[++i] ?? '');
      if (src && !src.startsWith(bundlePrefix)) dirtyFiles.add(src);
    }
  }
  return { ok: true, dirtyCount: dirtyFiles.size };
}

function findMergeBase(dir, targetSha, baseSha) {
  const out = tryGit(dir, ['merge-base', targetSha, baseSha]);
  const mb = out ? out.trim() : '';
  return mb || null;
}

function candidateBranches(state, slug) {
  const raw = [
    state.branch,
    state.coordination?.local_run_branch,
    `masterplan/${slug}`,
  ];
  const seen = new Set();
  const out = [];
  for (const b of raw) {
    if (typeof b !== 'string') continue;
    const trimmed = b.trim().replace(/^refs\/heads\//, '');
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function check(repoRoot, opts = {}) {
  const bundles = getBundles(repoRoot, opts);
  if (!bundles.exists) {
    return [{ id: ID, severity: 'SKIP', summary: 'no docs/masterplan directory', fix: null }];
  }

  const qualifying = [];
  for (const b of bundles.list) {
    const { state } = b;
    if (!state) continue;
    if (state.status === 'archived') continue;
    if (!PRE_EXECUTE_PHASES.has(state.phase)) continue;
    qualifying.push(b);
  }

  if (qualifying.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no active pre-execute bundle to check', fix: null }];
  }

  if (!isGitRepo(repoRoot)) {
    return [{
      id: ID,
      severity: 'SKIP',
      summary: 'not a git repository — cannot inspect branches or worktrees for unsequenced work',
      fix: null,
    }];
  }

  const repoRootReal = canonicalRealpath(repoRoot);
  const baseRef = resolveBaseRef(repoRoot);
  const hasCommits = baseRef ? true : repoHasAnyCommit(repoRoot);
  const gitOpts = opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : undefined;
  const findings = [];

  for (const b of qualifying) {
    const { state } = b;
    const slug = state.slug || b.slug;
    const bDirReal = b.dir ? canonicalRealpath(b.dir) : null;
    const relBundleDir = bDirReal && repoRootReal ? normalizeRelPath(path.relative(repoRootReal, bDirReal)) : '';
    const bundlePrefix = (relBundleDir && !relBundleDir.startsWith('..') && !path.isAbsolute(relBundleDir))
      ? `${relBundleDir.replace(/\/+$/, '')}/`
      : `docs/masterplan/${normalizeRelPath(slug)}/`;
    const taskCount = Array.isArray(state.tasks) ? state.tasks.length : 0;

    const rawWt = typeof state.worktree === 'string' ? state.worktree.trim() : '';
    const resolvedWt = rawWt
      ? (path.isAbsolute(rawWt) ? rawWt : path.resolve(repoRoot, rawWt))
      : '';

    if (resolvedWt && isDistinctGitWorktree(resolvedWt, repoRootReal)) {
      let commitCount = 0;
      let fileCount = 0;
      const errors = [];
      if (baseRef) {
        const headSha = tryRev(resolvedWt, 'HEAD');
        if (headSha && headSha !== baseRef.sha) {
          const mb = findMergeBase(resolvedWt, headSha, baseRef.sha);
          if (mb) {
            const cRes = inspectCommitRange(resolvedWt, mb, headSha, bundlePrefix, gitOpts);
            if (!cRes.ok) errors.push(`git log failed (${cRes.error})`);
            else {
              commitCount = cRes.commitCount;
              fileCount = cRes.fileCount;
            }
          }
        }
      }
      const dRes = inspectDirtyWorktree(resolvedWt, bundlePrefix, gitOpts);
      const dirtyCount = dRes.ok ? dRes.dirtyCount : 0;
      if (!dRes.ok) errors.push(`git status failed (${dRes.error})`);

      if (commitCount > 0 || dirtyCount > 0) {
        const details = [];
        if (commitCount > 0) {
          details.push(`${commitCount} commit(s) touching ${fileCount} non-bundle file(s)`);
        }
        if (dirtyCount > 0) {
          details.push(`${dirtyCount} uncommitted non-bundle file(s)`);
        }
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle "${slug}" is in phase "${state.phase}" (${taskCount} tasks) but worktree "${rawWt}" already has ${details.join(' and ')}`,
          fix: FIX_GUIDANCE,
        });
      } else if (errors.length > 0) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle "${slug}" worktree "${rawWt}" could not be inspected for unsequenced work: ${errors.join('; ')}`,
          fix: 'inspect git state in the bundle worktree manually and verify whether unsequenced edits exist',
        });
      }
      continue;
    }

    if (!baseRef) continue;

    // Inspect EVERY distinct candidate branch (never break on a diverged bundle-only branch
    // while a later candidate carries unsequenced non-bundle commits).
    const seenShas = new Set();
    for (const branch of candidateBranches(state, slug)) {
      const branchSha = tryRev(repoRoot, `refs/heads/${branch}`);
      if (!branchSha || branchSha === baseRef.sha || seenShas.has(branchSha)) continue;
      seenShas.add(branchSha);

      const mb = findMergeBase(repoRoot, branchSha, baseRef.sha);
      if (!mb) continue;
      const cRes = inspectCommitRange(repoRoot, mb, branchSha, bundlePrefix, gitOpts);
      if (!cRes.ok) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle "${slug}" branch "${branch}" could not be inspected for unsequenced work: git log failed (${cRes.error})`,
          fix: 'inspect git history on the bundle branch manually and verify whether unsequenced commits exist',
        });
      } else if (cRes.commitCount > 0) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle "${slug}" is in phase "${state.phase}" (${taskCount} tasks) but branch "${branch}" already has ${cRes.commitCount} commit(s) touching ${cRes.fileCount} non-bundle file(s)`,
          fix: FIX_GUIDANCE,
        });
      }
    }
  }

  if (findings.length > 0) return findings;

  if (!baseRef && hasCommits) {
    return [{
      id: ID,
      severity: 'SKIP',
      summary: 'cannot resolve base branch (main/master/origin) to compare pre-execute bundle commits',
      fix: null,
    }];
  }

  return [{
    id: ID,
    severity: 'PASS',
    summary: `all ${qualifying.length} active pre-execute bundle(s) have no unsequenced code work`,
    fix: null,
  }];
}
