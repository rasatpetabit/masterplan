// lib/refs.mjs - pure decision core for (repo,slug)-identified bidirectional plan-graph refs (F1).
//
// Owns the DETERMINISTIC logic for cross-run back/forward references: idempotent upsert/remove/
// list keyed on the (repo, slug) PAIR, reciprocal (back<->forward) entry construction, target-slug
// charset validation as a path-traversal guard, and the no-op detector that lets the bin skip
// appending an event on a logical no-op. All I/O (realpath canonicalization and walking the
// filesystem up to a repo root) is isolated behind small injectable helpers (default impls use
// node:fs) so the core stays unit-testable with no disk.
//
// Consumed by bin/masterplan.mjs `refs add|remove|list` (F1 wiring, a later task). The bin owns
// locking (Guard D on both bundles), event append, and inline re-render; this module owns the
// pure state transform plus path/slug decisions only. It NEVER touches state.yml on disk.

import fs from 'node:fs';
import path from 'node:path';

export const DIRECTIONS = ['back', 'forward'];

// Bare-slug charset: a run slug used to interpolate a bundle path. Must start alnum, then alnum
// or hyphen. Anchored both ends so a separator / '..' / absolute path can never match.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Typed error so the bin can map a failure class to an exit code / message.
export class RefsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefsError';
    this.code = code;
  }
}

// --- slug validation (path-traversal guard) -------------------------------------------------

export function isValidTargetSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

export function validateTargetSlug(slug) {
  if (typeof slug !== 'string' || slug === '') {
    throw new RefsError('bad_slug', `target slug must be a non-empty string (got ${JSON.stringify(slug)})`);
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || path.isAbsolute(slug)) {
    throw new RefsError('bad_slug', `target slug ${JSON.stringify(slug)} contains a path separator, dotdot, or is absolute`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new RefsError('bad_slug', `target slug ${JSON.stringify(slug)} is not a bare run slug`);
  }
  return slug;
}

export function assertDirection(direction) {
  if (!DIRECTIONS.includes(direction)) {
    throw new RefsError('bad_direction', 'direction must be back or forward');
  }
  return direction;
}

export function reciprocalDirection(direction) {
  return assertDirection(direction) === 'back' ? 'forward' : 'back';
}

export function normalizeRepo(repo, ownRepoRoot) {
  return (repo === undefined || repo === null || repo === '') ? ownRepoRoot : repo;
}

export function refKey(entry, ownRepoRoot) {
  return normalizeRepo(entry.repo, ownRepoRoot) + '\u0000' + entry.slug;
}

// --- refs container -------------------------------------------------------------------------

export function ensureRefs(state) {
  const refs = state && state.refs ? state.refs : {};
  return {
    back: Array.isArray(refs.back) ? refs.back : [],
    forward: Array.isArray(refs.forward) ? refs.forward : [],
  };
}

function withRefs(state, direction, list) {
  const refs = ensureRefs(state);
  return { ...state, refs: { ...refs, [direction]: list } };
}

export function upsertRef(state, direction, entry, ownRepoRoot) {
  assertDirection(direction);
  validateTargetSlug(entry.slug);
  const refs = ensureRefs(state);
  const list = refs[direction];
  const key = refKey(entry, ownRepoRoot);
  if (list.some((e) => refKey(e, ownRepoRoot) === key)) {
    return { state, changed: false };
  }
  return { state: withRefs(state, direction, [...list, entry]), changed: true };
}

export function removeRef(state, direction, target, ownRepoRoot) {
  assertDirection(direction);
  const refs = ensureRefs(state);
  const list = refs[direction];
  const key = refKey(target, ownRepoRoot);
  const next = list.filter((e) => refKey(e, ownRepoRoot) !== key);
  if (next.length === list.length) return { state, changed: false };
  return { state: withRefs(state, direction, next), changed: true };
}

export function listRefs(state) {
  const refs = ensureRefs(state);
  return { back: [...refs.back], forward: [...refs.forward] };
}

// --- entry / reciprocal construction --------------------------------------------------------

export function buildEntry({ slug, label = null, entryRepoRoot, holdingRepoRoot }) {
  validateTargetSlug(slug);
  const entry = { slug };
  if (label != null && label !== '') entry.label = label;
  if (entryRepoRoot !== holdingRepoRoot) entry.repo = entryRepoRoot;
  return entry;
}

export function planRefsAdd({
  direction, sourceRepoRoot, sourceSlug, sourceTopic = null,
  targetRepoRoot, targetSlug, label = null,
}) {
  const dir = assertDirection(direction);
  validateTargetSlug(targetSlug);
  validateTargetSlug(sourceSlug);
  const recip = reciprocalDirection(dir);
  const sourceEntry = buildEntry({ slug: targetSlug, label, entryRepoRoot: targetRepoRoot, holdingRepoRoot: sourceRepoRoot });
  const targetEntry = buildEntry({ slug: sourceSlug, label: sourceTopic, entryRepoRoot: sourceRepoRoot, holdingRepoRoot: targetRepoRoot });
  return {
    source: { direction: dir, entry: sourceEntry, ownRepoRoot: sourceRepoRoot },
    target: { direction: recip, entry: targetEntry, ownRepoRoot: targetRepoRoot },
  };
}

export function applyRefsAdd(sourceState, targetState, plan) {
  const t = upsertRef(targetState, plan.target.direction, plan.target.entry, plan.target.ownRepoRoot);
  const s = upsertRef(sourceState, plan.source.direction, plan.source.entry, plan.source.ownRepoRoot);
  return {
    sourceState: s.state, targetState: t.state,
    sourceChanged: s.changed, targetChanged: t.changed,
  };
}

// --- path resolution ------------------------------------------------------------------------

export function resolveTargetBundlePath(targetRepoRoot, targetSlug) {
  validateTargetSlug(targetSlug);
  return path.join(targetRepoRoot, 'docs', 'masterplan', targetSlug, 'state.yml');
}

// --- injectable fs helpers (impure; defaults touch disk, tests inject fakes) ----------------

function defaultExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
function defaultRealpath(p) {
  return fs.realpathSync(p);
}

// Walk UP from fromPath to the nearest ancestor dir containing a .git entry (dir OR gitlink file).
// Returns the repo root or null. `exists` is injectable so tests need no real filesystem.
export function findRepoRoot(fromPath, { exists = defaultExists } = {}) {
  let dir = path.dirname(path.resolve(fromPath));
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Default target repo for `refs add`: the SOURCE bundle's own repo root, derived by walking up
// from the --state path. NEVER the session's MAIN (a parent session operating a sub-repo bundle
// would otherwise resolve same-repo into the parent and mis-target the reciprocal).
export function deriveDefaultTargetRepo(statePath, deps = {}) {
  const root = findRepoRoot(statePath, deps);
  if (!root) {
    throw new RefsError('no_repo_root', `--state path ${statePath} is not inside a git repo`);
  }
  return root;
}

// Canonicalize a supplied --repo (realpath collapses symlink aliases) and require it to be a real
// repo root (contains .git). Used on add only; remove matches the stored identity as text so a
// ref to a moved/deleted repo stays removable.
export function canonicalizeRepoRoot(repoPath, { realpath = defaultRealpath, exists = defaultExists } = {}) {
  let canon;
  try {
    canon = realpath(repoPath);
  } catch {
    throw new RefsError('bad_repo', `--repo ${JSON.stringify(repoPath)} does not exist`);
  }
  if (!exists(path.join(canon, '.git'))) {
    throw new RefsError('bad_repo', `--repo ${JSON.stringify(repoPath)} is not a git repo root`);
  }
  return canon;
}
