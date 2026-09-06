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

import { createHash } from 'node:crypto';
import { readFileSync as fsReadFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

// ---- canonical deploy-group ordering (the fixed §7.1 group order) ------------
//
// orderDeployGroups returns the run's deploy groups in the normative, fixed order
// release → install → user_only → live_check, regardless of declaration order in the
// file. Accepts the `done:` definition (object), the literal `none` sentinel, or an
// absent definition. A group is included only when it is present (a non-empty array in
// the object form). Pure name work — the shell/§2 handler sequences on the result.
const DEPLOY_GROUP_ORDER = ['release', 'install', 'user_only', 'live_check'];

export function orderDeployGroups(done) {
  if (done === 'none' || done === undefined || done === null) return [];
  if (Array.isArray(done)) {
    return DEPLOY_GROUP_ORDER.filter((g) => done.includes(g));
  }
  if (typeof done === 'object') {
    return DEPLOY_GROUP_ORDER.filter((g) => Array.isArray(done[g]) && done[g].length > 0);
  }
  return [];
}

// ---- exit-status-only run/check classification (the §7.1 check contract) -----
//
// classifyStepOutcome maps a step's run/check exit codes to the three-way outcome the
// §7.2 deploy stage records. The contract is a predicate on EXIT STATUS ONLY — command
// output is never interpreted, so this function takes only the two exit codes and never
// any stdout/stderr. run non-zero → failed (check is not even run, per §7.2); run 0 with
// no check → done; run 0 + check 0 → done; run 0 + check 1 → failed (effect absent);
// run 0 + check any other exit → indeterminate.
export function classifyStepOutcome({ runExit, checkExit } = {}) {
  if (!Number.isInteger(runExit)) return 'indeterminate';
  if (runExit !== 0) return 'failed';
  if (checkExit === undefined || checkExit === null) return 'done';
  if (!Number.isInteger(checkExit)) return 'indeterminate';
  if (checkExit === 0) return 'done';
  if (checkExit === 1) return 'failed';
  return 'indeterminate';
}

// ---- safe validated ${version} substitution (the §7.1 release contract) -------
//
// substituteVersionSafe replaces every ${version} in a step command with the version
// single-quoted into the command, but ONLY when the version matches the release
// contract `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`. A hostile/absent version returns null so
// the caller refuses the step rather than interpolating an unvalidated string into a
// shell command. Pure string work — the shell owns the actual `sh -c` execution.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function substituteVersionSafe(command, version) {
  const v = String(version ?? '');
  if (!VERSION_RE.test(v)) return null;
  return String(command ?? '').replace(/\$\{version\}/g, `'${v}'`);
}

// ---- deploy-chain hashing (the §7.2 final-check binding) ----------------------
//
// deployChainHash digests the deploy chain (the ordered list of deploy_step receipts)
// into the deploy_chain_hash the final receipt binds. Deterministic: the chain is built
// in the fixed group order, so the same chain always hashes the same. Pure — no fs, no
// git; the caller passes the chain array in.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function deployChainHash(chain = []) {
  const canonical = stableStringify(chain ?? []);
  return createHash('sha256').update(canonical).digest('hex');
}

// The live-check digest: the evidence a final intent verdict is bound to. It is derived from
// the CONTENT of the file the operator points at, never from its path — two runs that recorded
// the same live output must produce the same digest, and a path string proves nothing about
// what the check saw. An unreadable or blank file is refused rather than digested: a receipt
// bound to nothing is exactly the unearned completion §7.1 exists to prevent.
export function liveCheckDigest(digestFile, { readFile } = {}) {
  const read = readFile ?? ((p) => fsReadFileSync(p));
  let bytes;
  try {
    bytes = read(digestFile);
  } catch (e) {
    throw new Error(`live check digest: --digest-file unreadable (${digestFile}): ${e.message}`);
  }
  // The BYTES, never a decoded string. Decoding first maps every invalid UTF-8 sequence onto
  // U+FFFD, so two different evidence files can hash identically — which is the one property a
  // content digest must not have. The blank check decodes a COPY for its own purposes only.
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  if (!buf.toString('utf8').trim()) {
    throw new Error(`live check digest: --digest-file is empty (${digestFile}) — record what the live check actually observed`);
  }
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

// ---- completion-class classification (the §7.4 replay guard) ------------------
//
// classifyCompletion maps a bundle's state to its completion class: `complete`,
// `incomplete:<reason>`, `merged` (done: none), or `legacy`. The class is read from
// state.completion exactly as §7.4 writes it at archive; a bundle with NO completion
// field (every pre-v10 archive) is `legacy` — never complete, never a crash. An unknown
// non-empty completion value is also `legacy` (defensive: never mislabel as complete).
export function classifyCompletion(state = {}) {
  const completion = state?.completion;
  if (completion === 'complete') return 'complete';
  if (completion === 'merged') return 'merged';
  if (typeof completion === 'string' && completion.startsWith('incomplete:') && completion.length > 'incomplete:'.length) return completion;
  return 'legacy';
}

// ---- git plumbing helpers (the finish-time git facts) ------------------------
//
// These helpers wrap the git commands the §7.2/§7.3 flow needs, keeping the module
// pure (no state writes) while still being unit-testable against real temp repos.
// They take an optional `{ git }` injection for tests that need to stub a remote
// (the network/remote cases); the default is the real `git` binary via execFileSync.

// A revision that may not exist (a shallow base has no ~N): its sha, else null.
function tryRev(repo, rev) {
  try { return git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]); } catch { return null; }
}

function git(repo, args, { input, raw = false } = {}) {
  // stdin must be a pipe when input is supplied (an 'ignore' stdin silently drops it).
  const opts = { cwd: repo, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] };
  if (input !== undefined) opts.input = input;
  const out = String(execFileSync('git', args, opts));
  // raw: diff text is fed to patch-id verbatim — trimming would erase trailing whitespace on the last line.
  return raw ? out : out.trim();
}

// gitVersion parses `git --version` into {major, minor, patch, raw}. The raw string
// is the trimmed stdout (e.g. "git version 2.45.1"). Used by mergeIdentity to decide
// whether `patch-id --verbatim` is available (git >= 2.39).
export function gitVersion(repo) {
  const raw = git(repo, ['--version']);
  const m = /^git version (\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) throw new Error(`cannot parse git version from: ${raw}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw };
}

// supportsMergeTree is true iff the version is >= 2.38.0 (the release that introduced
// `merge-tree --write-tree`, the real three-way merge without a worktree).
export function supportsMergeTree(v) {
  if (!v || typeof v.major !== 'number') return false;
  if (v.major !== 2) return v.major > 2;
  return v.minor >= 38;
}

// The tree a merge of `branch` onto `base` produces, computed by git's own merge machinery (rename
// detection included) without touching any worktree: {tree} on a clean merge, {conflict: true} when
// git would stop on conflicts, {unsupported} below git 2.38. The tree id is a revision for `show`.
export function mergedTree(repo, base, branch) {
  const ver = gitVersion(repo);
  if (!supportsMergeTree(ver)) return { unsupported: `git ${ver.raw} lacks merge-tree --write-tree (need >= 2.38)` };
  try {
    const out = git(repo, ['merge-tree', '--write-tree', '--no-messages', base, branch]);
    return { tree: out.split(/\s+/)[0] };
  } catch (err) {
    if (err.status === 1) return { conflict: true };
    throw err;
  }
}

// supportsVerbatimPatchId is true iff the version is >= 2.39.0 (the release that
// introduced `patch-id --verbatim`).
export function supportsVerbatimPatchId(v) {
  if (!v || typeof v.major !== 'number') return false;
  if (v.major > 2) return true;
  if (v.major < 2) return false;
  if (v.minor > 39) return true;
  if (v.minor < 39) return false;
  return v.patch >= 0;
}

// versionAtRevision reads the "version" field from a JSON file at a given revision.
// The file is expected to be a package.json/plugin.json shape with a top-level
// "version" string. Throws with a diagnostic naming the file when the file is absent
// or unparsable, or when the version is not a string.
export function versionAtRevision(repo, sha, versionFrom) {
  let raw;
  try {
    raw = git(repo, ['show', `${sha}:${versionFrom}`]);
  } catch (err) {
    throw new Error(`cannot read ${versionFrom} at ${sha}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`cannot parse ${versionFrom} at ${sha} as JSON`);
  }
  const version = parsed?.version;
  if (typeof version !== 'string') {
    throw new Error(`${versionFrom} at ${sha} has no string "version" field`);
  }
  return version;
}

// tagExists reports whether a tag exists locally (via `git rev-parse -q --verify
// refs/tags/<tag>`) and, when `remote` is given, also on that remote (via
// `git ls-remote --exit-code --tags <remote> refs/tags/<tag>`). Local exit 1 → false;
// remote exit 2 → false; any other non-zero → throws 'indeterminate' (the remote
// could not be queried).
export function tagExists(repo, tag, { remote = null } = {}) {
  if (!remote) {
    try {
      git(repo, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
      return true;
    } catch (err) {
      if (err.status === 1) return false;
      throw err;
    }
  }
  if (remote) {
    try {
      git(repo, ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`]);
      return true;
    } catch (err) {
      if (err.status === 2) return false;
      throw new Error('indeterminate');
    }
  }
  return false;
}

// mergeIdentity classifies how a PR's merge sha relates to the branch tip and the
// base. Returns { kind: 'merge' | 'squash', ok: true } when the branch landed in the
// merge sha (ancestry for a merge commit, or a single-parent squash whose patch-id
// matches the branch diff), or { ok: false, kind, reason } otherwise. The squash
// proof requires git >= 2.39 (`patch-id --verbatim`); older git returns
// { kind: 'unsupported', ok: false }.
export function mergeIdentity(repo, { baseBefore, branchTip, mergeSha }) {
  // Merge ancestry (§7.3): the retired tip must be contained in the landing commit. A two-parent merge
  // whose second parent IS the tip is the exact `gh pr merge --merge` shape (exact: true); a merge of a
  // ref that moved past the tip still contains it and is accepted, with the commits beyond the tip
  // named so the caller can surface them.
  const mergeParents = git(repo, ['rev-list', '--parents', '-n1', mergeSha]).trim().split(/\s+/).slice(1);
  const isAncestor = (a, b) => { try { git(repo, ['merge-base', '--is-ancestor', a, b]); return true; } catch (err) { if (err.status !== 1) throw err; return false; } };
  const contains = isAncestor(branchTip, mergeSha);
  // The strongest identity there is: the base IS the retired tip (a fast-forward), whatever the tip's
  // own shape — a branch that merged the base or another branch has a multi-parent tip.
  if (mergeSha === branchTip) return { kind: 'merge', ok: true, exact: true, beyond_tip: [] };
  if (mergeParents.length >= 2) {
    // The landing must MERGE the tip: it is reachable from a non-first parent. A later, unrelated
    // merge whose first parent already contains the tip is not the PR landing — accepting it would
    // put that unrelated merge (and everything it carries) before the audited boundary.
    if (isAncestor(branchTip, mergeParents[0])) {
      return { ok: false, kind: 'merge', reason: `merge commit ${mergeSha.slice(0, 12)} is not the landing of ${branchTip.slice(0, 12)}: its first parent already contains the tip — a later, unrelated merge` };
    }
    const merging = mergeParents.slice(1).filter((p) => isAncestor(branchTip, p));
    if (merging.length === 0) {
      return { ok: false, kind: 'merge', reason: `merge commit ${mergeSha.slice(0, 12)} does not merge the branch tip ${branchTip.slice(0, 12)} (${contains ? 'the tip is not reachable from any parent' : 'no parent contains the tip'})` };
    }
    const exact = mergeParents.length === 2 && mergeParents[1] === branchTip;
    let beyond = [];
    if (!exact) {
      // the merged side(s) past the retired tip: everything reachable from the merging parents but not from the tip
      try { beyond = git(repo, ['rev-list', ...merging, `^${branchTip}`, `^${mergeParents[0]}`]).split(/\s+/).filter(Boolean); } catch { beyond = []; }
    }
    return { kind: 'merge', ok: true, exact, beyond_tip: beyond };
  }

  const ver = gitVersion(repo);
  if (!supportsVerbatimPatchId(ver)) {
    return {
      ok: false,
      kind: 'unsupported',
      reason: `git ${ver.raw} lacks patch-id --verbatim (need >= 2.39)`,
    };
  }

  // A squash lands as ONE single-parent commit whose parent is the base it was squashed onto.
  const parentsLine = git(repo, ['rev-list', '--parents', '-n1', mergeSha]);
  const parents = parentsLine.trim().split(/\s+/).slice(1);
  if (parents.length !== 1) {
    return { ok: false, kind: 'merge', reason: `merge commit ${mergeSha.slice(0, 12)} does not contain the branch tip ${branchTip.slice(0, 12)}` };
  }
  // Identity is decided on CONTENT only (§7.3): commit metadata (author, date, subject) can be set to
  // anything on either side, so it proves nothing. A single landing commit whose verbatim patch-id
  // equals the whole branch diff IS the reviewed change wherever it came from — for a one-commit
  // branch a rebase and a squash are the same commit content, and both are accepted as 'squash'.
  // A "rebase merge" that is refused is the multi-commit replay: no single commit carries the
  // reviewed branch diff, so the landing commit's diff is only the last branch commit's.
  const patchId = (text) => git(repo, ['patch-id', '--verbatim'], { input: text }).split(/\s+/)[0] || '';
  const ownDiff = git(repo, ['diff', `${parents[0]}..${mergeSha}`], { raw: true });
  const mergeBase = git(repo, ['merge-base', parents[0], branchTip]);
  const branchDiff = git(repo, ['diff', `${mergeBase}..${branchTip}`], { raw: true });
  // A rebase-merge: the base gained the branch's commits one by one, so the landing commit's own
  // diff is only the LAST branch commit, never the whole branch.
  let lastCommitDiff = null;
  try { lastCommitDiff = git(repo, ['diff', `${branchTip}~1..${branchTip}`], { raw: true }); } catch { lastCommitDiff = null; }
  if (lastCommitDiff !== null && patchId(lastCommitDiff) !== patchId(branchDiff) && patchId(ownDiff) === patchId(lastCommitDiff)) {
    return { ok: false, kind: 'rebase', reason: 'rebase merge — the base gained the branch commits individually; no single commit carries the reviewed branch diff' };
  }
  // The net diff of a multi-commit branch can EQUAL its last commit's (an add-then-delete of a
  // scratch file before the real change): the heuristic above is blind to that replay, so the
  // commits that precede the landing on the base's first-parent line are matched, patch-id by
  // patch-id, against the branch's earlier commits. A match is the replayed series — a rebase.
  // A replay may preserve or drop the branch's EMPTY commits (they carry no patch id), so the two
  // sequences are compared twice: as recorded (empties as the 'empty' sentinel, matching a replay
  // that kept them) and with the empties dropped (matching a replay that skipped them). Either
  // match is the replayed series — a rebase, not a squash.
  const commitId = (c) => { const id = (() => { try { return patchId(git(repo, ['diff', `${c}~1..${c}`], { raw: true })); } catch { return ''; } })(); return id || 'empty'; };
  const branchIds = git(repo, ['rev-list', '--reverse', `${mergeBase}..${branchTip}`]).split(/\s+/).filter(Boolean).map(commitId);
  if (branchIds.length >= 2) {
    const priorAll = git(repo, ['rev-list', '--first-parent', '-n', String(branchIds.length + 4), parents[0]]).split(/\s+/).filter(Boolean).map(commitId).reverse(); // oldest first
    const matches = (expected) => {
      if (expected.length === 0) return false;
      const prior = priorAll.slice(-expected.length);
      return prior.length === expected.length && expected.every((id, i) => id === prior[i]);
    };
    const asRecorded = branchIds.slice(0, -1);
    const withoutEmpties = asRecorded.filter((id) => id !== 'empty');
    if (matches(asRecorded) || matches(withoutEmpties)) {
      return { ok: false, kind: 'rebase', reason: `rebase merge — the commit(s) before ${mergeSha.slice(0, 12)} on the base replay the branch's commits one by one; no single commit carries the reviewed branch diff` };
    }
  }
  if (baseBefore && parents[0] !== baseBefore) {
    // Callers that KNOW the base the squash was made onto (tests, a recorded base) may pin it; the
    // deploy stage passes the landing commit's own parent, so this check is informational there and
    // the patch-id equality below carries the proof.
    return { ok: false, kind: 'squash', reason: `commit ${mergeSha.slice(0, 12)} is not a single squash onto ${baseBefore.slice(0, 12)} (its parent is ${parents[0].slice(0, 12)})` };
  }
  // The squash commit's own diff must be the whole branch diff. Acceptance is `patch-id --verbatim`
  // equality (git >= 2.39; measured 2026-09-03 on git 2.53: it distinguishes trailing whitespace,
  // while `--stable` does not) — never a byte comparison, whose index lines and hunk offsets vary
  // with the base a squash lands on. A stable-equal / verbatim-different pair is the whitespace case.
  const ownId = patchId(ownDiff);
  const branchId = patchId(branchDiff);
  // A branch whose only non-final commits are EMPTY is the one shape content can never resolve: a
  // rebase that drops them lands exactly the same single commit a squash would, and nothing in the
  // history says which happened. Refused, not guessed — such a branch lands as a merge (ancestry).
  if (branchIds.length >= 2 && branchIds.slice(0, -1).every((id) => id === 'empty')) {
    return { ok: false, kind: 'rebase', reason: `the branch's only commits before its tip are empty, so a dropped-empty rebase and a squash land identically — land it as a merge (ancestry), not a squash` };
  }
  // The mirror image: a branch that ENDS in empty commits. A rebase that drops them replays the last
  // real commit alone, which is byte-identical to the squash of the same branch. Equally unresolvable.
  if (branchIds.length >= 2 && branchIds[branchIds.length - 1] === 'empty') {
    return { ok: false, kind: 'rebase', reason: `the branch ends in empty commit(s), so a rebase that drops them and a squash land identically — land it as a merge (ancestry), not a squash` };
  }
  // A replay can be TRANSFORMED (its earlier commits rewritten, emptied or made to cancel), so a
  // patch-id sequence match cannot see it. What no transformation can hide is the shape: the last N
  // commits on the base carry exactly the branch's diff, N being the branch's commit count. A real
  // squash lands as ONE commit, so its N-commit range also carries whatever the base did before it —
  // a different diff. Ambiguity here is refused, never guessed.
  if (branchIds.length >= 2 && branchId) {
    const back = tryRev(repo, `${parents[0]}~${branchIds.length - 1}`);
    // The suffix is judged whatever its prefix did. A prefix that cancels is exactly the shape a
    // replay leaves behind, and it is indistinguishable from "the base did nothing, then the squash
    // landed": content cannot separate them, so both are refused. Such a branch lands as a merge.
    if (back) {
      let rangeDiff = null;
      try { rangeDiff = git(repo, ['diff', `${back}..${mergeSha}`], { raw: true }); } catch { rangeDiff = null; }
      if (rangeDiff !== null && patchId(rangeDiff) === branchId) {
        return { ok: false, kind: 'rebase', reason: `the last ${branchIds.length} commits on the base carry exactly the branch's diff — that is the branch replayed commit by commit, not a single squash; land it as a merge (ancestry)` };
      }
    }
  }
  // An empty diff yields NO patch-id: two empties are not a proof. A branch whose net change is
  // nothing (add-then-delete) cannot be identified by content — only ancestry can carry it.
  if (!ownId || !branchId) {
    return { ok: false, kind: 'squash', reason: `no patch-id to compare (${!branchId ? 'the branch has an empty net diff' : `the landing ${mergeSha.slice(0, 12)} has an empty diff`}) — identity needs a real merge (ancestry), not a squash` };
  }
  if (ownId === branchId) return { kind: 'squash', ok: true };
  const stableId = (text) => git(repo, ['patch-id', '--stable'], { input: text }).split(/\s+/)[0] || '';
  if (stableId(ownDiff) === stableId(branchDiff)) {
    return { ok: false, kind: 'squash', reason: 'squash differs from the branch by whitespace only — it is not the reviewed change' };
  }
  return { ok: false, kind: 'squash', reason: 'squash patch-id differs from the branch diff (content changed)' };
}

// auditDeployBoundary walks the first-parent history from `from` to `to` and
// classifies each commit as 'bundle' (only files under bundlePrefix/), 'stage'
// (only files in commitPaths, with the version unchanged), or 'foreign' (anything
// else, including merge commits). Returns { ok, commits, reason? } — ok is false
// (with reason 'base moved') as soon as a foreign commit is found.
export function auditDeployBoundary(repo, { from, to, bundlePrefix, commitPaths, versionFrom, expectedVersion, stageCommits = [] }) {
  const commits = [];
  const revList = git(repo, ['rev-list', '--reverse', '--first-parent', `${from}..${to}`]);
  const shas = revList ? revList.split('\n').filter(Boolean) : [];
  for (const sha of shas) {
    // --no-renames: a rename is a delete plus an add, and BOTH paths must pass the boundary rule.
    // -z: NUL-separated names taken verbatim — a leading/trailing space is part of the path, and a
    // trimmed name would let ` docs/masterplan/x` pass as a bundle path.
    const files = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha], { raw: true })
      .split('\0')
      .filter((f) => f.length > 0);
    const parentsLine = git(repo, ['rev-list', '--parents', '-n1', sha]);
    const parents = parentsLine.trim().split(/\s+/).slice(1);
    // ${version} must not change across ANY commit inside the boundary (§7.3), bundle commits included —
    // version_from is a repo-relative path and nothing stops it pointing under the bundle.
    const versionMoved = !!versionFrom && parents.length === 1 && versionAtRevision(repo, sha, versionFrom) !== expectedVersion;
    let kind;
    if (parents.length > 1 || files.length === 0 || versionMoved) {
      kind = 'foreign'; // a merge commit, an empty commit nobody can attribute, or a version change
    } else if (files.every((f) => f.startsWith(`${bundlePrefix}/`))) {
      kind = 'bundle';
    } else if (
      stageCommits.includes(sha) && // provenance: a receipt recorded this commit as the step's output
      files.every((f) => commitPaths.includes(f))
    ) {
      kind = 'stage';
    } else {
      kind = 'foreign';
    }
    commits.push({ sha, kind, files });
    if (kind === 'foreign') {
      return { ok: false, commits, reason: 'base moved' };
    }
  }
  return { ok: true, commits };
}

// dirtyOutsideBundle returns the porcelain paths (from `git status --porcelain
// --untracked-files=all`) that are NOT under bundlePrefix/. An empty array means the
// tree is clean in the task scope (bundle-only dirt is allowed).
export function dirtyOutsideBundle(repo, bundlePrefix, { ignorePrefixes = [] } = {}) {
  // NUL-delimited (`-z`): porcelain v1 C-quotes any path with a space, a quote or a newline, and a
  // quoted path would fail every prefix test below. With -z each record is `XY path\0`, and a
  // rename/copy adds its source as the NEXT record — both ends are dirt (the source was deleted).
  // Not through git(): the leading status column is significant, so stdout must not be trimmed.
  const out = String(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const records = out.split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    paths.push(rec.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      const src = records[++i];
      if (src) paths.push(src);
    }
  }
  return paths.filter((p) => !p.startsWith(`${bundlePrefix}/`) && !ignorePrefixes.some((ig) => p.startsWith(ig)));
}

// ---- the finish checkpoint's evidence binding (§5.5 finish tuple, task 56) ------
//
// The finish assessment is the fourth checkpoint: the final goal-check receipt binds
// the finish tuple — {deploy_base_sha, deploy_chain_hash, live_check_digest} named
// OUTRIGHT (§5.5: "the tuple is the whole authorization") — beside the intent identity
// every checkpoint binds and §6.3's repository-intent authorization
// {repo_intent_digest, target_identity}. Two members of the tuple are this module's own
// products: deployChainHash digests the deploy-event chain and liveCheckDigest digests
// the live check's evidence bytes. finishCheckpointEvidence composes the CURRENT tuple
// from those outputs plus the bundle's identity, and verifyFinishReceipt checks a
// recorded receipt against it — fail-closed, in the shared rejection vocabulary
// (missing / partial / unreadable / stale / mismatched / reviewer_unavailable), never
// approval. A LEGACY bundle reports its absence EXPLICITLY (family 'legacy'), never as
// a schema-backed pass.
//
// Both identities appear and stay distinct: the finish tuple's members are digests of
// exact evidence (the chain's recorded events, the live check's bytes — the artifact
// family), while intent_identity's goals_hash and reconciliation_digest are canonical
// (the evidence family). A receipt offering one family's value in the other's position
// is refused as mismatched.

import {
  buildIntentIdentity,
  buildFinishTuple,
  verifyCheckpointEvidence,
  artifactDigest,
} from './checkpoint-evidence.mjs';
import { readRecordedReconciliation } from './reconcile-intent.mjs';

/**
 * The finish checkpoint's CURRENT evidence for a deployment: the finish tuple (named
 * outright, refused when partial — the caller passes the same chain liveCheckDigest /
 * deployChainHash outputs the deploy stage recorded) plus the bundle's intent identity
 * and the recorded §6.3 authorization. This is what a final assessment receipt must
 * echo; `mp record-goal-check --final` validates the deploy members against the
 * recorder's own values, and this binding is the tuple-level check that keeps a receipt
 * from crossing an identity boundary (an amended goals.md, a drifted reconciliation, a
 * replaced skill identity all invalidate a final receipt bound before them).
 *
 *   deployBaseSha  — the base the deploy stage ran on (the deploy_base event's sha)
 *   chain          — the ordered deploy_step receipts (deployChainHash digests them)
 *   liveDigest     — the live check's digest (liveCheckDigest of its evidence bytes)
 *
 * Returns {ok: true, checkpoint: 'finish', finish_tuple, intent_identity, family,
 *   repo_intent_digest?, target_identity?, goals_artifact_digest} or
 *   {ok: false, status, reason} with status in REJECTION_STATUSES.
 */
export function finishCheckpointEvidence({ statePath, deployBaseSha, chain, liveDigest } = {}) {
  if (!statePath) throw new Error('finishCheckpointEvidence: statePath is required');
  const identity = buildIntentIdentity({ statePath });
  if (!identity.ok) return identity;
  const finish = buildFinishTuple({
    deployBaseSha,
    deployChainHash: deployChainHash(chain ?? []),
    liveCheckDigest: liveDigest,
  });
  if (!finish.ok) return finish;

  // The authorization half (§6.3): repo_intent_digest + target_identity are carried on
  // the schema-backed family's tuple; a legacy bundle reports its absence explicitly.
  let repo_intent_digest;
  let target_identity;
  if (identity.family === 'schema_backed') {
    let rec;
    try {
      rec = readRecordedReconciliation(statePath);
    } catch (e) {
      // buildIntentIdentity already proved it readable once; a second read failing is
      // a torn state — fail closed, never silently drop the authorization.
      return { ok: false, status: 'unreadable', reason: `the recorded reconciliation became unreadable (${e.message})` };
    }
    repo_intent_digest = rec.artifact_digest;
    target_identity = {
      repository: rec.identity.repository,
      remote: rec.identity.remote,
      ref: rec.identity.ref,
    };
  }

  // The ARTIFACT digest of goals.md, carried beside the tuple so a receipt that offers
  // the exact-bytes digest where the canonical goals_hash belongs is detectable as the
  // identity confusion it is (§5.5: two identities, never confused).
  let goals_artifact_digest = null;
  try {
    goals_artifact_digest = artifactDigest(fsReadFileSync(
      path.join(path.dirname(path.resolve(statePath)), 'goals.md'),
    ));
  } catch { /* absent goals.md on a legacy bundle: no artifact to confuse, nothing carried */ }

  return {
    ok: true,
    checkpoint: 'finish',
    family: identity.family,
    ...(identity.family === 'legacy' ? { legacy: true, note: identity.note } : {}),
    finish_tuple: finish.tuple,
    intent_identity: identity.identity,
    ...(repo_intent_digest !== undefined ? { repo_intent_digest, target_identity } : {}),
    goals_artifact_digest,
  };
}

/**
 * Verify a recorded final-assessment receipt against the CURRENT finish checkpoint
 * evidence. Fail-closed through the shared verifier: every failure is UNAVAILABLE —
 * never approval — and reports a status from the rejection vocabulary. A receipt bound
 * to a different deployment (stale), a partial tuple (partial), a receipt from a
 * different family (mismatched), or one whose reviewer identity cannot be resolved
 * (reviewer_unavailable) all refuse.
 */
export function verifyFinishReceipt(receipt, current) {
  if (!current || current.ok !== true) {
    return {
      ok: false,
      status: current?.status ?? 'missing',
      reason: current?.reason ?? 'the current finish checkpoint evidence could not be established',
    };
  }
  const v = verifyCheckpointEvidence({
    checkpoint: 'finish',
    receipt,
    current: { ok: true, family: current.family, identity: current.intent_identity },
    finishTuple: { ok: true, tuple: current.finish_tuple },
    goalsArtifactDigest: current.goals_artifact_digest,
  });
  if (!v.ok) return v;
  return {
    ok: true,
    ...(v.legacy ? { legacy: true, note: v.note } : {}),
    normalized: v.normalized,
  };
}
