// lib/doctor/worktree-integrity.mjs — v8 doctor check (ports v7 #3 wrong-worktree-path,
// #4 wrong-branch, #29(a) worktree-missing).
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml + `git worktree list` / `git branch`.
// Plan-scoped: each bundle's `worktree`/`branch` references must still resolve in git, unless the
// bundle is archived or its worktree was intentionally retired (worktree_disposition). Returns one
// ERROR finding per broken reference, a single PASS when clean, or SKIP (no bundles / git absent).
//
// SCOPE NOTE — #29(b)/#48 "orphan untracked worktree" (a git worktree that NO bundle points at)
// is DELIBERATELY NOT ported: it false-positives on every ordinary worktree — including this very
// masterplan-ng dev worktree — which is exactly why v7's bash only implemented the worktree-missing
// half. We flag bundle->git drift (a bundle naming a vanished worktree/branch), never git->bundle.
//
// git is reached through opts.gitExec (args[] -> stdout string), injectable for tests; the default
// shells out with cwd = opts.repoRoot ?? repoRoot. If git is unavailable (not a repo / no binary),
// every bundle SKIPs rather than erroring — the doctor must run anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

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
  let worktrees, branches;
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
  } catch (e) {
    const msg = String(e?.message ?? e).split('\n')[0];
    return [{ id: ID, severity: 'SKIP', summary: `git unavailable (${msg}) — cannot verify worktree/branch`, fix: null }];
  }

  const findings = [];
  for (const slug of slugs) {
    let state;
    try {
      state = parseState(fs.readFileSync(bundleArtifacts(repoRoot, slug, {}).state, 'utf8'));
    } catch {
      continue;
    }
    // parseState coerces '' / 'null' / '~' -> null, so a present-but-empty field is skipped here.
    const skip = SKIP_DISPOSITIONS.has(state.worktree_disposition) || state.status === 'archived';
    if (skip) continue;

    if (state.worktree && !worktrees.has(state.worktree)) {
      findings.push({
        id: ID, severity: 'ERROR',
        summary: `bundle ${slug}: worktree '${state.worktree}' is not a registered git worktree`,
        fix: 'restore the worktree, or set `worktree_disposition: removed_after_merge`/`kept_by_user` in the bundle state.yml',
      });
    }
    if (state.branch && !branches.has(state.branch)) {
      findings.push({
        id: ID, severity: 'ERROR',
        summary: `bundle ${slug}: branch '${state.branch}' does not exist`,
        fix: 'create/rename the branch, or archive the bundle (`status: archived`)',
      });
    }
  }
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'all bundle worktree/branch references resolve in git', fix: null }];
  }
  return findings;
}
