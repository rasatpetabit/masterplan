// lib/dispatch/multi-repo.mjs — fabric fanout multi-repo locus resolution.
//
// Problem (live, yanos-project amd64-first-class): plan.index.json declares files
// as umbrella-relative paths that may live in:
//   - the run worktree (docs/..., AGENTS.md, …)
//   - a sibling git checkout of MAIN (yanos-os/..., yanos-builder/..., …)
// Umbrella worktrees do NOT materialize gitignored siblings, so pinning every
// descriptor to `repo = worktree` makes gateway-edit fail with "file not found"
// for every sibling path. New-file targets also need create_files (existence
// split → write loop); buildFabricLocus sets that, and dispatch-wave always
// stamps create_files:true on descriptors (agent-dispatch S-B default).
//
// This module is the pure (mostly) resolution seam:
//   resolveFileLocus     — one file → { repo, rel, siblingName|null }
//   groupFilesByRepo     — files → Map(repo → { files, siblingName })
//   buildFabricLocus     — task files → single-repo descriptor locus
//                          (loud multi-repo error; create_files auto-opt-in)
//   ensureSiblingWorktree — create-or-reuse MAIN/<sib>/.worktrees/<slug>
//
// Invariants:
//   - Prefer sibling worktree when present (or creatable); never edit sibling MAIN
//     when a worktree path can be used (avoids polluting the sibling's main checkout).
//   - One fabric task = one edit locus. Mixed-repo tasks fail loud so the planner
//     splits them (gateway dispatch is single-repo per descriptor).
//   - create_files is true when ANY resolved target is missing on disk (gateway
//     splitByExistence then routes new files to the write loop).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { planWorktreeCreate, worktreePathFor, worktreeBranchFor, parseWorktreeList } from '../worktree.mjs';

function defaultRunGit(dir, args) {
  return String(execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
}

/**
 * True when `dir` is a git checkout (worktree or main) — `.git` file or directory.
 * @param {string} dir
 * @param {{existsSync?: Function}} [io]
 */
export function isGitCheckout(dir, io = {}) {
  const exists = io.existsSync ?? ((p) => fs.existsSync(p));
  return exists(path.join(dir, '.git'));
}

/**
 * Resolve one plan file path to its edit locus.
 *
 * Relative paths: if the first segment names a sibling git checkout under
 * `mainRoot` (e.g. mainRoot/yanos-os is a git repo), the locus is that sibling
 * (worktree preferred); otherwise the run worktree.
 *
 * Absolute paths: if inside the worktree or umbrella MAIN → worktree; else nearest git toplevel.
 *
 * @param {string} file
 * @param {{ worktree: string, mainRoot: string, slug: string,
 *           existsSync?: Function, runGit?: Function }} opts
 * @returns {{ repo: string, rel: string, siblingName: string|null, abs: string }}
 */
export function resolveFileLocus(file, opts) {
  const {
    worktree,
    mainRoot,
    slug,
    existsSync = (p) => fs.existsSync(p),
    runGit = defaultRunGit,
  } = opts;
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('resolveFileLocus: file must be a non-empty string');
  }
  if (!worktree || !mainRoot) {
    throw new TypeError('resolveFileLocus: worktree and mainRoot are required');
  }

  const wtAbs = path.resolve(worktree);
  const mainAbs = path.resolve(mainRoot);

  // Absolute path: worktree-owned or external git repo.
  if (path.isAbsolute(file)) {
    const abs = path.resolve(file);
    if (abs === wtAbs || abs.startsWith(wtAbs + path.sep)) {
      return { repo: wtAbs, rel: path.relative(wtAbs, abs), siblingName: null, abs };
    }
    let anchor = abs;
    while (anchor && !existsSync(anchor)) anchor = path.dirname(anchor);
    if (anchor && existsSync(anchor) && !fs.statSync(anchor).isDirectory()) {
      anchor = path.dirname(anchor);
    }
    if (!anchor || !existsSync(anchor)) {
      throw new Error(`resolveFileLocus: absolute path ${file} has no existing anchor`);
    }
    const repoRoot = runGit(anchor, ['rev-parse', '--show-toplevel']);
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`resolveFileLocus: ${file} resolves outside repo ${repoRoot}`);
    }
    if (path.resolve(repoRoot) === mainAbs) {
      return {
        repo: wtAbs,
        rel,
        siblingName: null,
        abs: path.join(wtAbs, rel),
      };
    }
    return { repo: repoRoot, rel, siblingName: null, abs };
  }

  // Relative path: sibling-prefix detection against MAIN (not WT — siblings are
  // gitignored and absent from umbrella worktrees).
  const norm = file.replace(/^\.\/+/, '');
  const parts = norm.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`resolveFileLocus: empty relative path ${JSON.stringify(file)}`);
  }
  const first = parts[0];
  const siblingMain = path.join(mainAbs, first);
  if (first !== '..' && isGitCheckout(siblingMain, { existsSync })) {
    const siblingName = first;
    const branch = worktreeBranchFor(slug);
    const siblingWt = worktreePathFor(siblingMain, slug);
    // Prefer an existing sibling worktree; otherwise leave repo at sibling MAIN
    // and let ensureSiblingWorktree promote it before dispatch.
    const repo = existsSync(siblingWt) ? siblingWt : siblingMain;
    const rel = parts.slice(1).join(path.sep);
    if (!rel) {
      throw new Error(
        `resolveFileLocus: file ${JSON.stringify(file)} names sibling repo root only — declare a path inside it`
      );
    }
    const abs = path.join(repo, rel);
    return { repo, rel, siblingName, abs, siblingMain, siblingWt, branch };
  }

  // Default: run worktree (umbrella docs, in-repo paths).
  const abs = path.join(wtAbs, norm);
  return { repo: wtAbs, rel: norm, siblingName: null, abs };
}

/**
 * Canonicalize declared task scopes to the umbrella-relative vocabulary used by
 * git status capture and verifyScope. Persisted bundles may contain absolute
 * MAIN paths; those are semantically the same files in the run worktree.
 *
 * @param {string[]} paths
 * @param {{worktree: string, mainRoot: string, slug: string}} opts
 * @returns {string[]}
 */
export function canonicalizeScopePaths(paths, opts) {
  return (Array.isArray(paths) ? paths : []).map((file) => {
    if (typeof file !== 'string' || file.length === 0) return file;
    const directoryScope = /[\\/]$/.test(file);
    try {
      const loc = resolveFileLocus(file, opts);
      let canonical;
      if (loc.siblingName) {
        canonical = `${loc.siblingName}/${loc.rel}`;
      } else if (path.resolve(loc.repo) === path.resolve(opts.worktree)) {
        canonical = loc.rel;
      } else {
        return file;
      }
      canonical = canonical.split(path.sep).join('/');
      return directoryScope && !canonical.endsWith('/') ? `${canonical}/` : canonical;
    } catch {
      return file;
    }
  });
}

/**
 * Group plan files by resolved edit repo.
 * @returns {Map<string, { files: string[], siblingName: string|null, siblingMain?: string, siblingWt?: string, branch?: string }>}
 */
export function groupFilesByRepo(files, opts) {
  const list = Array.isArray(files) ? files : [];
  const groups = new Map();
  for (const f of list) {
    const loc = resolveFileLocus(f, opts);
    if (!groups.has(loc.repo)) {
      groups.set(loc.repo, {
        files: [],
        siblingName: loc.siblingName,
        siblingMain: loc.siblingMain,
        siblingWt: loc.siblingWt,
        branch: loc.branch,
      });
    }
    const g = groups.get(loc.repo);
    g.files.push(loc.rel);
    // If any file in the group carries sibling metadata, keep it.
    if (loc.siblingName && !g.siblingName) {
      g.siblingName = loc.siblingName;
      g.siblingMain = loc.siblingMain;
      g.siblingWt = loc.siblingWt;
      g.branch = loc.branch;
    }
  }
  return groups;
}

/**
 * Ensure a sibling worktree exists at MAIN/<sib>/.worktrees/<slug> on the
 * masterplan branch. Pure plan + injected git (testable). Returns the worktree path.
 *
 * @param {{ siblingMain: string, slug: string, branch?: string,
 *           runGit?: Function, existsSync?: Function, listWorktrees?: Function }} opts
 * @returns {{ path: string, action: 'reuse'|'create', branch: string }}
 */
export function ensureSiblingWorktree(opts) {
  const {
    siblingMain,
    slug,
    branch: branchOpt,
    runGit = defaultRunGit,
    existsSync = (p) => fs.existsSync(p),
    listWorktrees,
  } = opts;
  if (!siblingMain || !slug) {
    throw new TypeError('ensureSiblingWorktree: siblingMain and slug are required');
  }
  const branch = branchOpt || worktreeBranchFor(slug);
  const wtPath = worktreePathFor(siblingMain, slug);

  let branchExists = false;
  try {
    runGit(siblingMain, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  let registered = false;
  try {
    const porcelain = listWorktrees
      ? listWorktrees(siblingMain)
      : runGit(siblingMain, ['worktree', 'list', '--porcelain']);
    registered = parseWorktreeList(porcelain)
      .some((w) => path.resolve(w.path) === path.resolve(wtPath));
  } catch {
    registered = false;
  }

  const plan = planWorktreeCreate({
    slug,
    repoRoot: siblingMain,
    branch,
    existing: existsSync(wtPath) ? wtPath : null,
    branchExists,
    registered,
  });

  if (plan.action === 'create') {
    // Parent .worktrees/ dir is created by git worktree add.
    runGit(siblingMain, plan.gitArgs);
  }
  return { path: plan.path, action: plan.action, branch: plan.branch || branch };
}

/**
 * Build the single-repo fabric locus for one task.
 *
 * @param {string[]} files
 * @param {{ worktree: string, mainRoot: string, slug: string,
 *           ensureSiblings?: boolean,
 *           existsSync?: Function, runGit?: Function, listWorktrees?: Function }} opts
 * @returns {{
 *   repo: string,
 *   files: string[],
 *   create_files: true|false,
 *   branch: string|null,
 *   siblingName: string|null,
 *   multi: false
 * }}
 * @throws when files span multiple repos
 */
export function buildFabricLocus(files, opts) {
  const {
    worktree,
    mainRoot,
    slug,
    ensureSiblings = true,
    existsSync = (p) => fs.existsSync(p),
    runGit = defaultRunGit,
    listWorktrees,
  } = opts;

  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    // No file scope — fall back to the run worktree (investigation / read-only classes).
    return {
      repo: path.resolve(worktree),
      files: [],
      create_files: false,
      branch: null,
      siblingName: null,
      multi: false,
    };
  }

  // First pass: resolve without ensuring, so we can detect multi-repo and know
  // which siblings need a worktree.
  const provisional = [];
  for (const f of list) {
    provisional.push(resolveFileLocus(f, {
      worktree, mainRoot, slug, existsSync, runGit,
    }));
  }

  // Promote sibling MAIN → sibling worktree when ensureSiblings is on.
  const siblingMains = new Map(); // siblingMain → { siblingName, branch }
  for (const loc of provisional) {
    if (loc.siblingMain && loc.siblingWt && loc.repo === loc.siblingMain) {
      siblingMains.set(loc.siblingMain, {
        siblingName: loc.siblingName,
        branch: loc.branch,
      });
    }
  }
  const promoted = new Map(); // siblingMain → wtPath
  if (ensureSiblings) {
    for (const [siblingMain, meta] of siblingMains) {
      const ensured = ensureSiblingWorktree({
        siblingMain,
        slug,
        branch: meta.branch,
        runGit,
        existsSync,
        listWorktrees,
      });
      promoted.set(siblingMain, ensured.path);
    }
  }

  // Re-resolve with worktrees present (or use promoted map).
  const groups = new Map();
  for (const f of list) {
    let loc = resolveFileLocus(f, { worktree, mainRoot, slug, existsSync, runGit });
    if (loc.siblingMain && promoted.has(loc.siblingMain)) {
      const wt = promoted.get(loc.siblingMain);
      loc = {
        ...loc,
        repo: wt,
        abs: path.join(wt, loc.rel),
      };
    }
    if (!groups.has(loc.repo)) {
      groups.set(loc.repo, {
        files: [],
        siblingName: loc.siblingName,
        branch: loc.branch ?? null,
      });
    }
    groups.get(loc.repo).files.push(loc.rel);
  }

  if (groups.size > 1) {
    const detail = [...groups.entries()]
      .map(([repo, g]) => `${repo} ← ${g.files.join(', ')}`)
      .join('; ');
    throw new Error(
      `buildFabricLocus: task files span ${groups.size} repos — split the plan task so each task edits one locus. ${detail}`
    );
  }

  const [repo, g] = [...groups.entries()][0];
  // create_files: true when any target is missing (gateway splits by existence).
  let anyMissing = false;
  for (const rel of g.files) {
    if (!existsSync(path.join(repo, rel))) {
      anyMissing = true;
      break;
    }
  }

  return {
    repo,
    files: g.files,
    create_files: anyMissing,
    branch: g.branch,
    siblingName: g.siblingName,
    multi: false,
  };
}

/**
 * Rewrite verify commands that still use umbrella-relative sibling prefixes
 * once the edit locus is the sibling repo. Best-effort string rewrite — free-form
 * shell cannot be fully normalized; cross-repo verifies remain planner hygiene.
 *
 * @param {string[]} verifyCommands
 * @param {string|null} siblingName
 * @param {{mainRoot?: string, repo?: string}} [locus]
 * @returns {string[]}
 */
export function rewriteVerifyForSibling(verifyCommands, siblingName, locus = {}) {
  if (!Array.isArray(verifyCommands)) return verifyCommands ?? [];
  const sourceRoot = locus.mainRoot && locus.repo
    ? path.resolve(locus.mainRoot, siblingName ?? '')
    : null;
  const targetRoot = locus.repo ? path.resolve(locus.repo) : null;
  const prefix = siblingName ? `${siblingName}/` : null;
  return verifyCommands.map((cmd) => {
    if (typeof cmd !== 'string') return cmd;
    let rewritten = cmd;
    if (sourceRoot && targetRoot) {
      let cursor = 0;
      let result = '';
      while (cursor < rewritten.length) {
        const index = rewritten.indexOf(sourceRoot, cursor);
        if (index < 0) {
          result += rewritten.slice(cursor);
          break;
        }
        result += rewritten.slice(cursor, index);
        if (rewritten.startsWith(targetRoot, index)) {
          result += targetRoot;
          cursor = index + targetRoot.length;
          continue;
        }
        const before = index > 0 ? rewritten[index - 1] : '';
        const after = rewritten[index + sourceRoot.length] ?? '';
        const beforeBoundary = before === '' || /[\s"'=(:;|&<>]/.test(before);
        const afterBoundary = after === '' || /[\\/\s"'=):;|&<>]/.test(after);
        result += beforeBoundary && afterBoundary ? targetRoot : sourceRoot;
        cursor = index + sourceRoot.length;
      }
      rewritten = result;
    }
    // Replace only token-leading umbrella-relative sibling paths. A global
    // replacement would corrupt absolute worktree paths containing siblingName/.
    if (prefix) {
      let cursor = 0;
      let result = '';
      while (cursor < rewritten.length) {
        const index = rewritten.indexOf(prefix, cursor);
        if (index < 0) {
          result += rewritten.slice(cursor);
          break;
        }
        result += rewritten.slice(cursor, index);
        const before = index > 0 ? rewritten[index - 1] : '';
        const plainBoundary = before === '' || /[\s"'=(:;|&<>]/.test(before);
        const dotRelativeBoundary = (before === '/' || before === '\\')
          && rewritten[index - 2] === '.'
          && (index === 2 || /[\s"'=(:;|&<>]/.test(rewritten[index - 3]));
        if (!plainBoundary && !dotRelativeBoundary) result += prefix;
        cursor = index + prefix.length;
      }
      rewritten = result;
    }
    return rewritten;
  });
}

/**
 * Partition umbrella-relative paths into per-repo relative groups for capture/commit.
 * Does NOT ensure sibling worktrees (callers that need create already ran buildFabricLocus).
 *
 * @returns {Array<{ repo: string, prefix: string|null, rels: string[] }>}
 */
export function partitionPathsByRepo(paths, opts) {
  const list = Array.isArray(paths) ? paths : [];
  const groups = new Map(); // repo → { prefix, rels:Set }
  for (const p of list) {
    const loc = resolveFileLocus(p, { ...opts, ensureSiblings: false });
    // Prefer existing sibling worktree if resolve pointed at sibling MAIN but wt exists.
    let repo = loc.repo;
    if (loc.siblingWt && opts.existsSync?.(loc.siblingWt)) {
      repo = loc.siblingWt;
    } else if (loc.siblingWt && fs.existsSync(loc.siblingWt)) {
      repo = loc.siblingWt;
    }
    if (!groups.has(repo)) {
      groups.set(repo, { prefix: loc.siblingName, rels: new Set() });
    }
    groups.get(repo).rels.add(loc.rel);
  }
  return [...groups.entries()].map(([repo, g]) => ({
    repo,
    prefix: g.prefix,
    rels: [...g.rels],
  }));
}

/**
 * Capture dirty+untracked files across every locus referenced by `paths`, returned
 * as umbrella-relative paths (siblingName/rel or bare rel for the run worktree).
 *
 * @param {string[]} paths — umbrella-relative declared scope (or empty → worktree only)
 * @param {{ worktree, mainRoot, slug, captureWtFiles: (repo:string)=>string[] }} opts
 * @returns {string[]}
 */
export function captureMultiRepoFiles(paths, opts) {
  const { worktree, captureWtFiles } = opts;
  if (typeof captureWtFiles !== 'function') {
    throw new TypeError('captureMultiRepoFiles: captureWtFiles is required');
  }
  const list = Array.isArray(paths) ? paths : [];
  // Always include the run worktree; plus every sibling referenced by paths.
  const repos = new Map(); // repo → prefix|null
  repos.set(path.resolve(worktree), null);
  for (const p of list) {
    try {
      const loc = resolveFileLocus(p, opts);
      let repo = loc.repo;
      if (loc.siblingWt && fs.existsSync(loc.siblingWt)) repo = loc.siblingWt;
      if (!repos.has(repo)) repos.set(repo, loc.siblingName);
    } catch {
      // Unresolvable path — still leave it to verifyScope as-is via worktree capture.
    }
  }
  const out = new Set();
  for (const [repo, prefix] of repos) {
    let files = [];
    try {
      files = captureWtFiles(repo) ?? [];
    } catch {
      files = [];
    }
    for (const rel of files) {
      out.add(prefix ? `${prefix}/${rel}` : rel);
    }
  }
  return [...out];
}

/**
 * Map umbrella-relative paths back to per-repo relative paths for git add/commit.
 * Paths that don't resolve to a known repo group are dropped (caller decides).
 *
 * @param {string[]} umbrellaPaths
 * @param {Array<{ repo: string, prefix: string|null }>} loci
 * @returns {Map<string, string[]>} repo → rels
 */
export function mapUmbrellaPathsToRepos(umbrellaPaths, loci) {
  const byRepo = new Map();
  for (const loc of loci) byRepo.set(loc.repo, []);
  // Index by prefix for O(1) sibling lookup; null prefix = worktree (no prefix match first).
  const byPrefix = new Map();
  let wtRepo = null;
  for (const loc of loci) {
    if (loc.prefix) byPrefix.set(loc.prefix, loc.repo);
    else wtRepo = loc.repo;
  }
  for (const p of umbrellaPaths ?? []) {
    if (typeof p !== 'string') continue;
    const parts = p.split(/[/\\]/).filter(Boolean);
    if (parts.length >= 2 && byPrefix.has(parts[0])) {
      const repo = byPrefix.get(parts[0]);
      byRepo.get(repo).push(parts.slice(1).join('/'));
      continue;
    }
    if (wtRepo) byRepo.get(wtRepo).push(p);
  }
  return byRepo;
}
