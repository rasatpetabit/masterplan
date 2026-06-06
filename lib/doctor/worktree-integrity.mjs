// lib/doctor/worktree-integrity.mjs — v8 doctor check (ports v7 #3 wrong-worktree-path,
// #4 wrong-branch, #29(a) worktree-missing).
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml + `git worktree list` / `git branch`.
// Plan-scoped: each bundle's `worktree`/`branch` references must still resolve in git, unless the
// bundle is archived or its worktree was intentionally retired (worktree_disposition). Returns one
// ERROR finding per broken reference, a single PASS when clean, or SKIP (no bundles / git absent).
//
// SCOPE NOTE — the git->bundle direction. v7 #29(b)/#48 "flag every git worktree that NO bundle
// points at" was DELIBERATELY NOT ported: it false-positives on every ordinary dev worktree
// (including this masterplan-ng one), so a plain unowned-registered worktree STILL stays untouched.
// What we DO now reconcile (Phase 2, via the shared PURE classifyWorktrees so `mp worktree reconcile`
// and the doctor can never disagree) are the unambiguous strays the per-bundle loop structurally
// cannot see: a crash-leak (a retired bundle's worktree still registered + on disk), a repo-move (a
// dangling .worktrees/* admin link), a foreign-repo leftover checkout, and a legacy `missing`
// disposition. Each is a WARN carrying its native remedy; bundle->git drift is still an ERROR.
//
// git is reached through opts.gitExec (args[] -> stdout string), injectable for tests; the default
// shells out with cwd = opts.repoRoot ?? repoRoot. If git is unavailable (not a repo / no binary),
// every bundle SKIPs rather than erroring — the doctor must run anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';
import { classifyWorktrees, normalizeDisposition } from '../worktree.mjs';
import { collectDiskDirs, collectBundleRecords } from '../worktree-fs.mjs';

const ID = 'worktree-integrity';
const SKIP_DISPOSITIONS = new Set(['removed_after_merge', 'kept_by_user']);

export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, {});
  let slugs;
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }
  if (slugs.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }

  const gitExec = opts.gitExec
    ?? ((args) => execFileSync('git', args, { cwd: opts.repoRoot ?? repoRoot, encoding: 'utf8' }));
  let worktrees, branches, commonGitDir;
  try {
    worktrees = new Set(
      String(gitExec(['worktree', 'list', '--porcelain']))
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim())
    );
    branches = new Set(
      String(gitExec(['branch', '--format=%(refname:short)']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
    // The reconciler's repo-vs-foreign test compares each worktree's gitdir target against
    // <repoGitDir>/worktrees. When the doctor itself runs INSIDE a linked worktree, repoRoot/.git is a
    // FILE pointing elsewhere, so the real admin dir is the COMMON git dir — read it read-only here
    // (rev-parse may print a path relative to cwd; absolutize against the same cwd gitExec used).
    commonGitDir = String(gitExec(['rev-parse', '--git-common-dir'])).trim();
  } catch (e) {
    const msg = String(e?.message ?? e).split('\n')[0];
    return [{ id: ID, severity: 'SKIP', summary: `git unavailable (${msg}) — cannot verify worktree/branch`, fix: null }];
  }

  // git->bundle direction: the SAME pure classifier `mp worktree reconcile` runs, fed the git list we
  // already collected + the on-disk .worktrees/* dirs + the bundle records. It surfaces the strays the
  // per-bundle loop below structurally cannot (crash-leak / repo-move / foreign-leftover / legacy
  // `missing`) as WARNs with their native remedy. `handledPaths` are ONLY the `repair` (repo-move) paths:
  // a repo-move is a recoverable `git worktree repair`, not a vanished worktree, so the bundle->git ERROR
  // below stands down for it (reporting both would contradict the remedy). It must NOT include `manual` —
  // an active bundle whose worktree git lost AND whose .git can't be proven ours (reason
  // `active-unregistered`) gets a `manual` WARN here AND still earns the bundle->git ERROR (restore or
  // record the retirement); suppressing it would hide a real broken live reference (the Codex BLOCKER).
  // ONE managed-worktrees root for all three classifier inputs (the Codex two-roots fix). The
  // reconciler's repo-vs-foreign test (pointsIntoRepo) and its managed-root test (underManagedWorktrees)
  // are BOTH anchored on the MAIN repo's git dir; if the disk-dir / bundle scan used a DIFFERENT root
  // (cwd) the two would disagree. When the doctor runs inside a linked worktree, cwd/.git is a FILE, so
  // the real admin dir is the COMMON git dir and the managed-worktrees root is its parent. Collect disk
  // dirs + bundle records from that same mainRepoRoot — else a retired worktree under <main>/.worktrees
  // reads as gone-from-disk and mis-emits `prune` instead of `crash-leak`/`kept`. repoGitDirCanonical
  // (realpath) lets classifyWorktrees recognise an OUR-repo worktree reached through an NFS/symlink
  // alias as ours, not foreign (the Codex realpath BLOCKER). It MUST stay NULL when the admin dir can't
  // be canonicalized — NOT a lexical fallback — so a foreign-vs-ours canonical mismatch can never trigger
  // a `remove` we couldn't fully prove (the Codex Round-2 BLOCKER); classifyWorktrees downgrades such a
  // stray to `manual`. Normal case (doctor from the main checkout): mainRepoRoot === repoRoot and realpath
  // resolves, so the canonical equals the lexical and behaviour is unchanged.
  const repoGitDir = path.resolve(opts.repoRoot ?? repoRoot, commonGitDir);
  const mainRepoRoot = path.dirname(repoGitDir);
  let repoGitDirCanonical = null;
  try {
    repoGitDirCanonical = fs.realpathSync.native(repoGitDir);
  } catch {
    /* repoGitDir unresolvable (rare) — leave NULL so remove can never fire on a canonical mismatch */
  }
  const { actions, findings: reconcileFindings } = classifyWorktrees({
    repoGitDir,
    repoGitDirCanonical,
    gitList: [...worktrees].map((p) => ({ path: p })),
    diskDirs: collectDiskDirs(mainRepoRoot),
    bundleRecords: collectBundleRecords(mainRepoRoot, {}),
  });
  const handledPaths = new Set(
    actions.filter((a) => a.action === 'repair' && a.path).map((a) => a.path)
  );

  const findings = [];
  for (const slug of slugs) {
    let state;
    try {
      state = parseState(fs.readFileSync(bundleArtifacts(repoRoot, slug, {}).state, 'utf8'));
    } catch {
      continue;
    }
    // parseState coerces '' / 'null' / '~' -> null, so a present-but-empty field is skipped here.
    // normalizeDisposition folds the legacy phantom `missing` into removed_after_merge, so a
    // gone-but-mislabeled worktree reads as retired here (and gets a normalize WARN from the
    // reconciler above) instead of being re-reported as a live bundle->git ERROR.
    const skip = SKIP_DISPOSITIONS.has(normalizeDisposition(state.worktree_disposition)) || state.status === 'archived';
    if (skip) continue;

    if (state.worktree && !worktrees.has(state.worktree) && !handledPaths.has(state.worktree)) {
      findings.push({
        id: ID, severity: 'ERROR',
        summary: `bundle ${slug}: worktree '${state.worktree}' is not a registered git worktree`,
        fix: `restore the worktree, or record the retirement with \`mp set-worktree-disposition --state=${bundleArtifacts(repoRoot, slug, {}).state} --disposition=removed_after_merge\` (or \`--disposition=kept_by_user\`)`,
      });
    }
    if (state.branch && !branches.has(state.branch)) {
      findings.push({
        id: ID, severity: 'ERROR',
        summary: `bundle ${slug}: branch '${state.branch}' does not exist`,
        fix: `create/rename the branch, or archive the bundle with \`mp set-status --state=${bundleArtifacts(repoRoot, slug, {}).state} --status=archived\``,
      });
    }
  }
  findings.push(...reconcileFindings);
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'all bundle worktree/branch references resolve in git', fix: null }];
  }
  return findings;
}
