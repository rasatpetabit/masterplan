// lib/finish.mjs — the L1 finalization-flow compute core (the `finish` verb / end-of-execute path).
//
// Pure, unit-tested helpers behind `mp finish-status`. They turn the SHELL's git facts into the JSON
// the §2 `complete` handler sequences on (verification-before-completion → retro → the durable
// branch_finish gate → archive-LAST). Two boundaries match the rest of L1:
//   - NO git here. git (rev-parse, status, branch, merge, push) stays in the markdown shell; the shell
//     passes git's OUTPUT in (the verify-scope pattern: --before/--after JSON). This keeps the module
//     fixture-free and unit-testable from plain strings.
//   - NO state writing here. The verified-at-SHA marker is persisted by lib/bundle.mjs's setVerifiedSha
//     (CD-7 single writer); this module only COMPUTES (classify/detect/collect/compare).
//
// Why these specific pieces: the finish flow auto-fires non-interactively under --autonomy=full, so
// every decision it makes (is the tree dirty in task scope? what's the base branch? has this exact HEAD
// already been verified? which verify commands prove the work?) must be deterministic and testable, not
// improvised in orchestrator prose. See commands/masterplan.md §2 and docs plan cozy-waddling-ritchie.

// ---- git status --porcelain parsing (task-scope vs user-owned dirt) ----------
//
// classifyDirt splits a `git status --porcelain` snapshot into the paths that belong to the run's
// declared task scope (state.tasks[].files) and everything else (user-owned / unrelated). The §2
// handler COMMITS task-scope dirt (the thin safety net — §2a already commits at each wave boundary, so
// this is rare) and LEAVES unrelated dirt untouched (protect-user-work). A pure set-membership test.
export function classifyDirt(porcelainText = '', taskFiles = []) {
  const scope = new Set(Array.isArray(taskFiles) ? taskFiles : []);
  const taskScopePaths = [];
  const unrelatedPaths = [];
  for (const p of parsePorcelainPaths(porcelainText)) {
    if (scope.has(p)) taskScopePaths.push(p);
    else unrelatedPaths.push(p);
  }
  return {
    taskScopeDirty: taskScopePaths.length > 0,
    unrelatedDirty: unrelatedPaths.length > 0,
    taskScopePaths,
    unrelatedPaths,
  };
}

// porcelain v1 line == "XY PATH" (two status columns + one space, then the path). Rename/copy lines are
// "XY ORIG -> PATH" (the affected path is the NEW one). Paths with special chars are double-quoted +
// C-escaped; unquote the common case via JSON.parse. Blank lines (clean tree) yield nothing.
function parsePorcelainPaths(text) {
  const paths = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    let p = line.length > 3 ? line.slice(3) : line.trim();
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      try { p = JSON.parse(p); } catch { /* not JSON-quoted after all — keep raw */ }
    }
    if (p) paths.push(p);
  }
  return paths;
}

// ---- base-branch detection (the "Merge to <base>" label + the skill hint) ----
//
// detectBase picks the integration base from the repo's branch list: prefer `main`, else `master`,
// else null (let finishing-a-development-branch / the user decide). A pure name-presence heuristic —
// `git merge-base` is a git op and stays in the shell/skill; this only needs to LABEL the branch_finish
// AUQ and feed the skill a hint, so the branch NAMES (one per line, from `git branch --format=...` or
// plain `git branch`, with or without the `* ` current marker) are sufficient.
export function detectBase(branchesText = '') {
  const names = new Set(
    String(branchesText ?? '')
      .split('\n')
      .map((l) => l.replace(/\r$/, '').trim().replace(/^\*\s+/, ''))
      .filter(Boolean)
  );
  if (names.has('main')) return 'main';
  if (names.has('master')) return 'master';
  return null;
}

// detectBaseAuto expands the local-only heuristic when the run's repo lacks a local main/master —
// the hindsight-historian case (no main/master on the run branch's repo). Priority order, in pure
// form so it's unit-testable from fixture text:
//
//   1. Local `main` / `master` (matches detectBase — keep parity so the happy path is unchanged).
//   2. `refs/remotes/origin/main` / `origin/master` (the most common PR-base for a fresh clone).
//   3. `refs/remotes/<any>/main` / `<any>/master` (any remote — last-ditch before a wrong-base risk).
//   4. Empty-tree SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (universal diff baseline — reviewing
//      the whole branch as a diff. Reviewers can flag that as overly broad; better than nothing).
//
// Returns null ONLY when both inputs are empty AND no remote branch matches — i.e. the caller sees
// `null` and emits `no_base_branch` in the same way detectBase would. The empty-tree fallback is
// intentionally not auto-applied here; the SHELL emits it after also failing the first three (via
// detectBaseAutoWithEmptyTree), so a missing-everything repo still produces a typed skip event rather
// than silently reviewing the whole tree.
export function detectBaseAuto(branchesText = '', remoteBranchesText = '') {
  const local = detectBase(branchesText);
  if (local) return { base: local, source: 'local' };
  const remotes = String(remoteBranchesText ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim().replace(/^\*\s+/, ''))
    .filter(Boolean);
  if (remotes.includes('origin/main')) return { base: 'main', source: 'origin' };
  if (remotes.includes('origin/master')) return { base: 'master', source: 'origin' };
  const anyMain = remotes.find((r) => /\/main$/.test(r));
  if (anyMain) return { base: 'main', source: 'remote', ref: anyMain };
  const anyMaster = remotes.find((r) => /\/master$/.test(r));
  if (anyMaster) return { base: 'master', source: 'remote', ref: anyMaster };
  return null;
}

// The empty-tree SHA — universal diff baseline. Used by finish-step as the LAST-resort base when
// detectBaseAuto returned null (no local, no remote, nothing to find). Reviewing against this
// diffs the entire branch against an empty tree — noisy but never silently wrong.
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---- verify-command collection (the finish-time verification source) ---------
//
// collectVerifyCommands returns the order-preserving, de-duplicated union of every plan task's
// verify_commands. This lives in plan.index.json — bundle.mjs intentionally DROPS the exec/routing
// projection (description / verify_commands / codex / sensitive / conversational) from state.tasks, so
// the finish flow reads the index, not state. canonical shape is array-of-strings (plan-merge.mjs
// validates `verify_commands must be an array`); a stray bare string is tolerated defensively. Empty
// union → the shell falls back to verification-before-completion's own IDENTIFY step.
export function collectVerifyCommands(planIndex) {
  const list = Array.isArray(planIndex)
    ? planIndex
    : Array.isArray(planIndex?.tasks)
      ? planIndex.tasks
      : [];
  const seen = new Set();
  const out = [];
  for (const task of list) {
    const vc = task?.verify_commands;
    const cmds = Array.isArray(vc) ? vc : typeof vc === 'string' ? [vc] : [];
    for (const c of cmds) {
      const cmd = typeof c === 'string' ? c.trim() : '';
      if (cmd && !seen.has(cmd)) {
        seen.add(cmd);
        out.push(cmd);
      }
    }
  }
  return out;
}

// ---- docs-normalization candidate filter (the §2c docs_normalize offer) ------
//
// filterDocCandidates turns the SHELL's `git diff --name-only <base>...HEAD -- '*.md'` output into
// the candidate list the finish-time docs-normalization gate offers on: every markdown file the run's
// branch created/modified, MINUS the run bundle itself (docs/masterplan/<slug>/ is the archived
// audit/resume record — never a normalization target). Pure string work, like the rest of this
// module: git stays in finish-step/the shell, which passes the diff names in.
export function filterDocCandidates(diffNamesText = '', bundleRelPath = '') {
  const bundle = String(bundleRelPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const out = [];
  for (const raw of String(diffNamesText ?? '').split('\n')) {
    const p = raw.replace(/\r$/, '').trim();
    if (!p) continue;
    const norm = p.replace(/\\/g, '/');
    if (bundle && (norm === bundle || norm.startsWith(`${bundle}/`))) continue;
    out.push(p);
  }
  return out;
}

// ---- the verified-at-SHA skip ------------------------------------------------
//
// isVerified is true only when a prior finish recorded verified_sha AND it equals the current HEAD — so
// a re-entry of the §2 complete handler after a compaction at UNCHANGED HEAD skips re-running the suite
// (the work is already proven at this commit), while any new commit (HEAD moved) forces a re-verify.
// Either side null/empty → not verified (a fresh bundle has no verified_sha; a detached/empty repo has
// no HEAD), so the flow runs verification rather than trusting a stale or absent marker.
export function isVerified(verifiedSha, headSha) {
  return !!verifiedSha && !!headSha && verifiedSha === headSha;
}

// ---- branch-finish choice → worktree disposition ----------------------------
//
// dispositionForChoice maps a RESOLVED branch_finish gate choice to the worktree disposition the
// doctor's worktree-integrity check reads to SKIP a retired bundle. The disposition enum is only
// {active, removed_after_merge, kept_by_user}; there is no dedicated 'discarded', so a discard (which
// also removes the worktree) reuses removed_after_merge as the "worktree intentionally gone" signal:
//   merge   → removed_after_merge   (merged to base locally, worktree cleaned up)
//   discard → removed_after_merge   (branch + worktree deleted — "gone", same doctor-skip semantics)
//   pr      → kept_by_user          (branch pushed; worktree retained until the PR lands)
//   keep    → kept_by_user          (left as-is by explicit user choice)
// Unknown choice → null: the caller leaves the disposition untouched rather than mis-recording one.
// finish-status echoes the full {merge,pr,keep,discard} map so the shell reads the value data-driven
// (this function is the single source of truth) instead of hardcoding the enum in prose.
export function dispositionForChoice(choice) {
  switch (choice) {
    case 'merge':
    case 'discard':
      return 'removed_after_merge';
    case 'pr':
    case 'keep':
      return 'kept_by_user';
    default:
      return null;
  }
}

// ---- open-PR awareness (the "what do I do next" / status / clean / gate hint) -
//
// summarizePr turns the SHELL's `gh pr list --head <branch> --state open --json number,title,mergeable,url`
// output into the compact shape the report verbs (status / next / clean) and the branch_finish gate label
// read. Like the rest of this module it is git/network-FREE: the shell owns the `gh` call (best-effort,
// `2>/dev/null`) and passes its JSON string in, so an absent/unauthed `gh`, no remote, or a non-GitHub
// origin simply yields '' → { hasPr:false } and never breaks a report. It is REPORT-ONLY — masterplan
// never auto-merges; merge happens via the branch_finish gate's merge path or the user on GitHub.
// GitHub computes `mergeable` asynchronously, so a freshly-opened PR reports UNKNOWN until the check
// settles → map MERGEABLE→'yes', CONFLICTING→'no', UNKNOWN/absent→'unknown' (a tri-state, not a bool).
// `gh pr list --head` can return >1 open PR; the first (most-recent) is the one to surface.
export function summarizePr(ghJson = '') {
  let list;
  try {
    list = typeof ghJson === 'string' ? JSON.parse(ghJson.trim() || '[]') : ghJson;
  } catch {
    return { hasPr: false };
  }
  const pr = Array.isArray(list) ? list[0] : null;
  if (!pr || typeof pr !== 'object') return { hasPr: false };
  const number = Number(pr.number);
  if (!Number.isInteger(number)) return { hasPr: false };
  return {
    hasPr: true,
    number,
    title: typeof pr.title === 'string' ? pr.title : '',
    url: typeof pr.url === 'string' ? pr.url : '',
    mergeable: normalizeMergeable(pr.mergeable),
  };
}

function normalizeMergeable(v) {
  switch (String(v ?? '').toUpperCase()) {
    case 'MERGEABLE':
      return 'yes';
    case 'CONFLICTING':
      return 'no';
    default:
      return 'unknown';
  }
}
