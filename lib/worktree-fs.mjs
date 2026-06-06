// lib/worktree-fs.mjs — the fs-collection layer for the worktree reconciler (Phase 1/2).
//
// classifyWorktrees (lib/worktree.mjs) is PURE — it consumes pre-collected facts. This module is the
// fs side: it reads the physical .worktrees/* directories and the docs/masterplan/* bundle records the
// reconciler needs. It is fs-ONLY (readdir / readFile) — NO git (git stays in the shell, CD-7) and NO
// state writing. It is shared by BOTH reconciler consumers — `mp worktree reconcile` (bin) and the
// doctor's worktree-integrity check — so the two collect IDENTICAL inputs and can never disagree about
// what is on disk (the drift the single-source-of-truth rule exists to prevent).
import fs from 'node:fs';
import path from 'node:path';
import { parseState } from './bundle.mjs';
import { resolveRunsDir, bundleArtifacts } from './paths.mjs';

// A linked worktree's `.git` is a FILE: `gitdir: <target>`. Extract that target so classifyWorktrees
// can tell OUR dangling pointer (repo-move → repair) from a FOREIGN repo's leftover (→ remove). A real
// `.git` DIR (a nested clone) or an absent `.git` → null (→ unidentified, untouched).
//
// The `gitdir:` value may be RELATIVE — git writes `gitdir: ../../.git/worktrees/<name>` for a
// relatively-created/repaired worktree, not only an absolute path. A raw relative target would never
// string-match the absolute repoGitDir in classifyWorktrees, so an OUR-repo worktree would mis-read as
// foreign and be REMOVED (data loss — the Codex BLOCKER). Resolve a relative target against the worktree
// dir here so the pure classifier only ever compares ABSOLUTE paths. `path.resolve` is lexical string
// math (NO realpath / NO extra fs), so this stays inside the fs-collector's read-only boundary.
export function readGitdirTarget(dirPath) {
  try {
    const dotgit = path.join(dirPath, '.git');
    if (!fs.statSync(dotgit).isFile()) return null;
    const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const raw = m[1].trim();
    if (!raw) return null;
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(dirPath, raw);
  } catch {
    return null;
  }
}

// Resolve a gitdir target to its CANONICAL (realpath'd) form, or null when it cannot be resolved.
// classifyWorktrees compares a stray worktree's gitdir target against the repo's admin dir to tell OUR
// dangling link (repair) from a FOREIGN leftover (remove). A purely LEXICAL compare mis-reads an OUR-repo
// worktree reached through a symlink / NFS-automount alias (`.git` says `gitdir: /net/alias/repo/.git/...`
// while repoGitDir is `/srv/dev/repo/.git`) as foreign → REMOVE → data loss (the Codex realpath BLOCKER).
// Canonicalizing both sides collapses the alias. realpath is an fs READ (no git, no state write), so it
// stays inside this fs-collector's mandate. Returns null when the target doesn't exist on disk (a
// dangling/foreign pointer we can't resolve) — the classifier then refuses to PROVE it foreign and never
// auto-removes it. `.native` matches git's own canonicalization (resolves case + final symlink).
function canonicalizeTarget(target) {
  if (!target) return null;
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

// The physical .worktrees/* directories present on disk, each tagged with its gitdir target (both the
// resolved-but-lexical absolute path and its canonical realpath). Absent .worktrees/ → [] (a repo that
// never used linked worktrees has nothing to reconcile).
export function collectDiskDirs(repoRoot) {
  const wtRoot = path.join(repoRoot, '.worktrees');
  let dirents;
  try {
    dirents = fs.readdirSync(wtRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dp = path.join(wtRoot, d.name);
      const gitdirTarget = readGitdirTarget(dp);
      return { name: d.name, path: dp, gitdirTarget, gitdirCanonical: canonicalizeTarget(gitdirTarget) };
    });
}

// One record per docs/masterplan/* bundle, carrying the RAW worktree/disposition/status so
// classifyWorktrees still sees a legacy `missing` (and can emit a durable normalize). env defaults to
// {} (no MASTERPLAN_RUNS_DIR override) so the bin subcommand and the doctor resolve the SAME bundle
// set. An unreadable / missing state.yml is skipped.
export function collectBundleRecords(repoRoot, env = {}) {
  const runsDir = resolveRunsDir(repoRoot, env);
  let slugs;
  try {
    slugs = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const records = [];
  for (const slug of slugs) {
    try {
      const st = parseState(fs.readFileSync(bundleArtifacts(repoRoot, slug, env).state, 'utf8'));
      records.push({
        slug,
        worktree: st.worktree ?? null,
        worktree_disposition: st.worktree_disposition ?? null,
        status: st.status ?? null,
      });
    } catch {
      /* unreadable / missing state.yml — skip this bundle */
    }
  }
  return records;
}
