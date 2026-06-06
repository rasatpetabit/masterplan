// lib/worktree.mjs — the L1 worktree-lifecycle compute core (Phase 1 of the worktree-hardening work).
//
// The v8 clean-core rebuild kept the worktree SCAFFOLDING (the disposition enum,
// set-worktree-disposition, the worktree-integrity doctor check, prepare-wave --linked-worktree) but
// dropped the worktree LIFECYCLE: nothing in code CREATES a worktree, teardown fires only on the
// happy-path finish gate, and there is no orphan reconciliation in the git->bundle direction. This
// module is the missing lifecycle, expressed as PURE functions so it is deterministic, zero-LLM-token,
// and unit-tested — never re-improvised in orchestrator prose.
//
// Two boundaries, identical to the rest of L1 (see lib/finish.mjs / lib/wave.mjs headers):
//   - NO git here. `git worktree add|list|repair|remove|prune` all stay in the markdown shell (CD-7:
//     the shell owns git; bin/lib are fs-only). This module RECEIVES git's already-collected output
//     (porcelain text, parsed lists) and EMITS an action plan the shell executes. It never spawns git.
//   - NO fs / NO state writing here. The caller (bin) does the readdir of .worktrees/ and the readState
//     of each bundle, then passes plain arrays in; the durable state write (recording a confirmed
//     disposition) goes through lib/bundle.mjs's single CD-7 writer. This module only COMPUTES.
//
// The lynchpin is classifyWorktrees(): one PURE reconciler that distinguishes
//   active / crash-leak / repo-move / foreign-leftover / foreign-unverified / active-unregistered /
//   duplicate-ownership / legacy-missing,
// emitting a per-worktree ACTION (repair | remove | normalize | prune | manual | none). It is the SINGLE
// classification source shared by `mp worktree reconcile` (acts on `actions`) and the doctor's
// worktree-integrity check (surfaces `findings`) — so the two can never disagree about what a given
// stray directory IS or how to remediate it.

import path from 'node:path';
import { dispositionForChoice } from './finish.mjs';

// The disposition enum is exactly three values (mirrors bin's VALID_WORKTREE_DISPOSITION). A retired
// worktree (one the doctor/reconcile must NOT treat as a live reference) is either of the last two.
export const VALID_DISPOSITIONS = ['active', 'removed_after_merge', 'kept_by_user'];
const RETIRED_DISPOSITIONS = new Set(['removed_after_merge', 'kept_by_user']);

// A bundle record is "retired" (NOT a live reference the reconciler must protect) iff its disposition
// normalizes to a retired value OR the bundle is archived. Single definition so the record-dedup
// preference, Pass A, and Pass C can never disagree about what "live" means.
function isRetiredRecord(rec) {
  if (!rec) return false;
  return RETIRED_DISPOSITIONS.has(normalizeDisposition(rec.worktree_disposition)) || rec.status === 'archived';
}

// When >1 bundle claims one worktree path, collapse to a SINGLE dominant record by a TOTAL, order-
// INDEPENDENT preference — a bare list[0] fallback let record order decide remove-vs-keep (the Codex
// Round-2.6 finding). Precedence:
//   1. a LIVE (non-retired) owner — never reap a path a live run owns;
//   2. else a kept_by_user owner — `kept_by_user` is sacrosanct (the user explicitly retained it), so a
//      kept sibling must dominate a removed_after_merge sibling, or the path could reach `remove` and
//      violate the kept contract;
//   3. else the first remaining (all are removed_after_merge / archived — genuinely retired, reapable).
function pickDominantRecord(list) {
  return (
    list.find((r) => !isRetiredRecord(r)) ??
    list.find((r) => normalizeDisposition(r.worktree_disposition) === 'kept_by_user') ??
    list[0]
  );
}

// ---- deterministic naming ----------------------------------------------------
//
// The single source of truth for WHERE a run's worktree lives and WHAT branch it tracks. Both the
// create-or-reuse path (planWorktreeCreate) and the reconciler (classifyWorktrees, to recognise our
// own .worktrees/<slug> dirs) derive from these, so a rename here can never desync the two.

export function worktreePathFor(repoRoot, slug) {
  return path.join(repoRoot, '.worktrees', String(slug));
}

export function worktreeBranchFor(slug) {
  return `masterplan/${slug}`;
}

// ---- create-or-reuse plan (the ONLY worktree-creation path, now in code) ------
//
// planWorktreeCreate decides whether kickoff must CREATE a fresh linked worktree or can REUSE an
// already-recorded one, and emits the git argv the SHELL runs (`git worktree add …`). Pure: it takes
// the recorded `existing` worktree (state.worktree as an object {path} or a bare path string, or null)
// and returns the plan; the shell executes the git and then records the outcome via `mp`.
//
//   reuse  — the bundle already points at OUR canonical path; nothing to create.
//   create — emit `git worktree add <path> -b <branch>` (fresh branch), or `… <path> <branch>` when
//            branchExists (a reused branch after the worktree dir was reaped — `-b` would fail).
//
// `registered` is the crash-window idempotency signal (Codex P1): if the shell crashes AFTER
// `git worktree add` but BEFORE `mp worktree record`, state carries no `worktree`, yet the canonical
// path is already a live registered worktree. Without this, the next kickoff would plan another
// `create` and the `git worktree add` would fail on the already-present dir. So reuse when the canonical
// path is EITHER recorded (`existing`) OR already registered in `git worktree list` (the shell probes it).
export function planWorktreeCreate({
  slug,
  repoRoot,
  branch,
  existing = null,
  branchExists = false,
  registered = false,
} = {}) {
  if (!slug) throw new Error('planWorktreeCreate: slug is required');
  if (!repoRoot) throw new Error('planWorktreeCreate: repoRoot is required');
  const wtPath = worktreePathFor(repoRoot, slug);
  const wtBranch = branch || worktreeBranchFor(slug);
  const existingPath = typeof existing === 'string' ? existing : existing?.path ?? null;
  if ((existingPath && existingPath === wtPath) || registered) {
    return { action: 'reuse', path: wtPath, branch: wtBranch };
  }
  const gitArgs = branchExists
    ? ['worktree', 'add', wtPath, wtBranch]
    : ['worktree', 'add', wtPath, '-b', wtBranch];
  return { action: 'create', path: wtPath, branch: wtBranch, gitArgs };
}

// ---- `git worktree list --porcelain` parsing ---------------------------------
//
// Porcelain blocks are blank-line-separated; each block is a set of `key value` lines plus bare
// keywords (`bare`, `detached`). The first line is always `worktree <abs-path>`. `branch` is emitted
// as a full ref (`refs/heads/<name>`) which we strip to the short name to match `git branch` output.
export function parseWorktreeList(porcelain = '') {
  const entries = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) entries.push(cur);
    cur = null;
  };
  for (const rawLine of String(porcelain ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? '' : line.slice(sp + 1).trim();
    if (key === 'worktree') {
      flush();
      cur = { path: val, head: null, branch: null, bare: false, detached: false };
    } else if (!cur) {
      continue; // a stray pre-block line — ignore
    } else if (key === 'HEAD') {
      cur.head = val;
    } else if (key === 'branch') {
      cur.branch = val.replace(/^refs\/heads\//, '');
    } else if (key === 'bare') {
      cur.bare = true;
    } else if (key === 'detached') {
      cur.detached = true;
    }
  }
  flush();
  return entries;
}

// ---- disposition normalization (the phantom `missing` 4th value) -------------
//
// Legacy data / failed-teardown prose can carry a 4th disposition `missing` the 3-value enum rejects.
// It MEANS "the worktree is gone", i.e. the same doctor-skip semantics as removed_after_merge. We
// normalize it on the READ path (here, called by every disposition consumer) rather than in
// migrate.mjs — migrate passes schema >= 6 through unchanged, so a migrate-only fix would miss a flat
// v8-era bundle that somehow carries `missing`. Returns the canonical disposition, or null when the
// value is absent/empty/unknown (→ "no disposition recorded" → treat as a live/active reference).
export function normalizeDisposition(value) {
  if (value === 'missing') return 'removed_after_merge';
  if (VALID_DISPOSITIONS.includes(value)) return value;
  return null;
}

// ---- teardown disposition (crash-safe) ---------------------------------------
//
// dispositionAfterTeardown layers crash-safety over finish.mjs's dispositionForChoice. The disposition
// flips OFF `active` only when the worktree removal/keep was actually CONFIRMED by the shell; an
// attempted-but-unconfirmed teardown (the git removal threw, the session died mid-teardown) must leave
// the disposition `active` so the next global reconcile still sees a live worktree to reap — it must
// NEVER record a premature "gone" (and never the phantom `missing`).
//   - merge/discard, removalConfirmed  → removed_after_merge
//   - pr/keep (always "confirmed" — keep is a no-op removal) → kept_by_user
//   - merge/discard, NOT confirmed     → active  (teardown to retry on the next reconcile)
//   - unknown choice                   → null    (caller leaves the disposition untouched)
export function dispositionAfterTeardown(choice, removalConfirmed = false) {
  const target = dispositionForChoice(choice);
  if (target === null) return null;
  if (target === 'kept_by_user') return 'kept_by_user';
  // target === 'removed_after_merge' (merge/discard): only record it once removal is confirmed.
  return removalConfirmed ? 'removed_after_merge' : 'active';
}

// ---- the shared reconciler (git<->bundle<->disk, all five modes) -------------
//
// classifyWorktrees is the PURE heart of the lifecycle: given git's registered-worktree list, the
// physical .worktrees/* directories on disk, and the bundle records, it classifies every stray and
// emits both a machine-consumable action plan (`actions`, consumed by `mp worktree reconcile`) and the
// doctor-shaped WARN subset (`findings`). All inputs are PRE-COLLECTED by the caller (the fs readdir
// and git list happen in bin/the shell); this function performs no I/O.
//
// Inputs:
//   repoGitDir   — absolute path to the MAIN repo's git dir (…/.git). Used to tell OUR dangling admin
//                  pointers (repo-move → repair) from a FOREIGN repo's leftover checkout (→ remove).
//   repoGitDirCanonical — the realpath'd repoGitDir, or NULL when it can't be resolved (caller computes
//                  it; fs lives outside this pure fn — and the caller MUST pass null on failure, NOT a
//                  lexical fallback). The canonical leg of the repo-vs-foreign test recognises an OUR-repo
//                  worktree reached through a symlink / NFS alias as ours (the Codex realpath BLOCKER). A
//                  `remove` (provably foreign) requires BOTH this AND the target's canonical to resolve, so
//                  if our own admin dir can't be canonicalized we can NEVER auto-remove a stray on a
//                  canonical mismatch — it falls to `manual` (the Codex Round-2 BLOCKER). The lexical
//                  repo-move test still uses repoGitDir, so an aliased target is never wrongly removed.
//   gitList      — parseWorktreeList() output: the worktrees git currently KNOWS about (registered).
//   diskDirs     — [{ name, path, gitdirTarget, gitdirCanonical }] physically present under
//                  <repoRoot>/.worktrees/. gitdirTarget is the absolute path after `gitdir: ` in
//                  <dir>/.git (a worktree's .git is a FILE), or null when .git is a real dir / absent;
//                  gitdirCanonical is its realpath, or null when the target doesn't resolve on disk.
//   bundleRecords— [{ slug, worktree, worktree_disposition, status }] one per docs/masterplan/* bundle.
//                  worktree_disposition is the RAW on-disk value (so legacy `missing` is still visible
//                  here and we can emit a durable normalize for it).
//
// Output: { actions, findings }
//   actions  — [{ path, action, reason, registered, slug? }] action ∈ repair|remove|normalize|prune|manual|none.
//              `registered` lets the shell pick `git worktree remove --force` (ours) vs `rm -rf`+prune
//              (foreign). normalize/prune carry a slug (the bundle to rewrite) instead of a registered.
//              `manual` is surfaced for human review but the shell takes NO automated git/rm action on it.
//   findings — the WARN subset (every action ≠ none), in the doctor finding shape {id, severity, …}.
export function classifyWorktrees({ repoGitDir, repoGitDirCanonical = null, gitList = [], diskDirs = [], bundleRecords = [] } = {}) {
  const ID = 'worktree-integrity';
  const registeredPaths = new Set((gitList ?? []).map((w) => w.path));
  // Group bundle records by worktree path. A path SHOULD have exactly one claimant; more than one is
  // an anomaly (an archived run's worktree dir later reused by a fresh run, or a stray manual
  // `mp worktree record` — paths aren't validated against the canonical slug dir). We BOTH resolve it
  // safely AND surface it. Resolution: a LIVE (non-retired) claimant MUST dominate — a naive last-wins
  // Map would let a trailing ARCHIVED record mask the live owner, flipping `recRetired` true and
  // dropping an unregistered foreign-looking stray through to `remove` (silent mid-run data loss,
  // reopening the live-owner false-remove class — the Codex Round-2.5 BLOCKER). Preferring the live
  // record keeps "never auto-remove a path a live run owns" even under duplicates, and likewise stops
  // Pass C pruning a live link. Surfacing: each duplicated path also earns a `manual` finding below.
  const recsByPath = new Map();
  for (const r of bundleRecords ?? []) {
    if (!r || !r.worktree) continue;
    const list = recsByPath.get(r.worktree);
    if (list) list.push(r);
    else recsByPath.set(r.worktree, [r]);
  }
  const recByPath = new Map();
  const duplicateClaims = []; // [{ path, slugs }] — paths claimed by >1 bundle (surfaced as manual)
  for (const [wt, list] of recsByPath) {
    recByPath.set(wt, pickDominantRecord(list));
    if (list.length > 1) duplicateClaims.push({ path: wt, slugs: list.map((r) => r.slug).filter(Boolean) });
  }
  const actions = [];

  // ---- Pass A: disk-centric — every physical .worktrees/* directory --------
  for (const d of diskDirs ?? []) {
    const dp = d?.path;
    if (!dp) continue;
    const registered = registeredPaths.has(dp);
    const rec = recByPath.get(dp);
    const recDisp = rec ? normalizeDisposition(rec.worktree_disposition) : null;
    const recRetired = rec && isRetiredRecord(rec);

    // kept_by_user is sacrosanct in BOTH branches — the user explicitly retained this worktree, so it
    // is NEVER reaped or repair-rewritten, regardless of git registration or where its .git points. The
    // unregistered ladder below has no kept guard of its own, so a kept_by_user owner that lost its git
    // registration AND resolves foreign would otherwise fall through to `remove` (the Codex Round-2.6
    // finding). Hoisting the guard here covers registered AND unregistered uniformly.
    if (recDisp === 'kept_by_user') {
      actions.push({ path: dp, action: 'none', reason: 'kept-by-user', registered, slug: rec?.slug });
      continue;
    }

    if (registered) {
      // Git knows this worktree.
      if (rec && !recRetired) {
        // Live, owned, in-use — the healthy case.
        actions.push({ path: dp, action: 'none', reason: 'active', registered });
      } else if (rec && recRetired) {
        // The owning bundle recorded the worktree as gone (removed_after_merge / archived) yet it is
        // still registered AND on disk → teardown recorded the disposition but never actually removed
        // it (a crash between the state write and the git removal). Reap it.
        actions.push({ path: dp, action: 'remove', reason: 'crash-leak', registered, slug: rec.slug });
      } else {
        // Registered but no owning bundle. This is the user's own dev worktree (e.g. masterplan-ng),
        // NOT ours to reap — the exact false-positive v7 deliberately never implemented. Leave it.
        actions.push({ path: dp, action: 'none', reason: 'unowned-registered', registered });
      }
    } else {
      // Git does NOT know this directory — a stray. The repo-vs-foreign test is the one place a wrong
      // answer DESTROYS data (foreign-leftover → remove), so the ladder is deliberately asymmetric and
      // PROOF-GATED:
      //   - `repair` (non-destructive re-link) on ANY evidence it's ours: the target points into our admin
      //     dir either lexically OR canonically (the realpath leg recognises an OUR-repo worktree reached
      //     through a symlink / NFS alias the raw compare misses — the Codex realpath BLOCKER). The
      //     canonical leg requires BOTH the target's and our own admin dir's realpath to resolve.
      //   - `remove` ONLY when we can PROVE foreign: the target resolves on disk AND our own admin dir
      //     resolves AND neither lexical nor canonical points into it. If EITHER side can't be
      //     canonicalized we cannot prove foreign (Codex Round-2 BLOCKER) → fall through to `manual`,
      //     never auto-remove on a canonical mismatch we couldn't fully resolve.
      //   - `manual` (surface, never auto-rm) when a pointer is present but proves neither ours nor
      //     foreign; `none` when there's no pointer at all.
      const targetRaw = d.gitdirTarget;
      const targetCanon = d.gitdirCanonical;
      const lexicalOurs = !!(targetRaw && pointsIntoRepo(targetRaw, repoGitDir));
      const canonicalOurs = !!(targetCanon && repoGitDirCanonical && pointsIntoRepo(targetCanon, repoGitDirCanonical));
      const intoRepo = lexicalOurs || canonicalOurs;
      const provablyForeign = !!(targetCanon && repoGitDirCanonical && !intoRepo);

      if (rec && !recRetired) {
        // A LIVE (non-retired) bundle still claims this path, but git lost the registration. NEVER
        // auto-remove a worktree a live run owns (the Codex BLOCKER): repair it if it's provably ours,
        // else surface `manual` — and we do NOT add it to the doctor's handled set, so the bundle->git
        // ERROR still fires (restore or record the retirement). Reaping a live run's checkout on a
        // foreign-looking .git would be silent data loss mid-run.
        if (intoRepo) {
          actions.push({ path: dp, action: 'repair', reason: 'repo-move', registered, slug: rec.slug });
        } else {
          actions.push({ path: dp, action: 'manual', reason: 'active-unregistered', registered, slug: rec.slug });
        }
      } else if (intoRepo) {
        // Its .git points into OUR admin dir (directly or via an alias), but git lost the registration →
        // repo-move / lost link. Native remedy re-links it without destroying work.
        actions.push({ path: dp, action: 'repair', reason: 'repo-move', registered });
      } else if (provablyForeign) {
        // Both the target AND our admin dir resolved on disk, and the target is NOT under ours (lexical or
        // canonical) → a PROVABLY foreign repo's leftover checkout (the cc3-visibility case). Safe to
        // remove + prune.
        actions.push({ path: dp, action: 'remove', reason: 'foreign-leftover', registered });
      } else if (targetRaw) {
        // A `gitdir:` target is present but we could NOT prove it foreign — either it doesn't resolve on
        // disk, or our own admin dir didn't canonicalize — and it isn't lexically ours. We must NOT
        // auto-remove it (an unprovable pointer might be ours). It IS a real stray worth a human's eyes
        // (e.g. the cc3-visibility orphan after its foreign repo was deleted), so surface it as a `manual`
        // WARN — visible, but the shell takes no automated git/rm action on it.
        actions.push({ path: dp, action: 'manual', reason: 'foreign-unverified', registered });
      } else {
        // No gitdir pointer at all (real .git dir / no .git) — we cannot positively identify this as
        // a leaked worktree, so we DO NOT touch it (conservative: never rm a dir we can't classify).
        actions.push({ path: dp, action: 'none', reason: 'unidentified', registered });
      }
    }
  }

  // ---- Pass B: bundle-centric — legacy `missing` durable normalize ---------
  // The doctor module keeps its own bundle->git worktree/branch ERROR checks; here we only add the
  // state-value fix it can't express: a bundle whose RAW disposition is the phantom `missing` should
  // be durably rewritten to removed_after_merge (no git involved — a pure state write the shell does
  // via `mp worktree record`).
  for (const r of bundleRecords ?? []) {
    if (!r) continue;
    if (r.worktree_disposition === 'missing') {
      actions.push({
        path: r.worktree ?? null,
        action: 'normalize',
        reason: 'legacy-missing',
        slug: r.slug,
      });
    }
  }

  // ---- Pass C: git-centric — a registered MANAGED worktree GONE from disk --
  // Pass A is disk-centric, so a worktree git STILL LISTS but whose directory was removed is invisible
  // to it — without this pass `prune` is an unreachable enum value (the Codex MAJOR). When the owning
  // bundle RETIRED it (removed_after_merge / kept_by_user / archived), the registration is a dangling
  // admin entry → `git worktree prune`. Iterating gitList (not diskDirs) is exactly the complementary
  // direction Pass A can't see. THREE guards keep this from misfiring:
  //   - underManagedWorktrees: only OUR linked worktrees (worktreePathFor → <repoRoot>/.worktrees/<slug>)
  //     are reapable. The PRIMARY worktree (the repo root) and any out-of-tree worktree are listed by git
  //     but live OUTSIDE .worktrees/, so they are NEVER in diskDirs and would always look "gone from
  //     disk" — without this guard a retired bundle that ran on the main checkout (worktree == repo root)
  //     makes us emit a bogus `prune` against the repo root itself (observed live: adversarial-review-
  //     integration / concurrency-guards / codex-routing-fix all archived with worktree: <repoRoot>).
  //   - rec required: an unowned managed path has no bundle to attribute the retirement to → leave it.
  //   - recRetired required: an ACTIVE bundle's vanished worktree is LEFT to the doctor's bundle->git
  //     ERROR path (pruning a live run's link would orphan it).
  const diskPaths = new Set((diskDirs ?? []).map((d) => d?.path).filter(Boolean));
  for (const w of gitList ?? []) {
    const wp = w?.path;
    if (!wp || diskPaths.has(wp)) continue; // on disk → Pass A already classified it
    if (!underManagedWorktrees(wp, repoGitDir)) continue; // primary / out-of-tree worktree — not ours to prune
    const rec = recByPath.get(wp);
    if (!rec) continue; // unowned managed path — nothing to attribute the retirement to
    const recRetired =
      RETIRED_DISPOSITIONS.has(normalizeDisposition(rec.worktree_disposition)) || rec.status === 'archived';
    if (recRetired) {
      actions.push({ path: wp, action: 'prune', reason: 'prune', registered: true, slug: rec.slug });
    }
  }

  // ---- Pass D: duplicate ownership — >1 bundle claims one worktree path ----
  // A single path claimed by two bundles is an anomaly the safe-resolution above HID (the live record
  // silently won). Surface it as a `manual` finding (NO automated git/rm) so the operator resolves the
  // stale claim — the live owner is already protected from `remove`, but the duplicate itself wants a
  // human's eyes (the Codex Round-2.5 follow-on to the dedup BLOCKER).
  for (const dup of duplicateClaims) {
    actions.push({ path: dup.path, action: 'manual', reason: 'duplicate-ownership', slugs: dup.slugs });
  }

  const findings = actions
    .filter((a) => a.action !== 'none')
    .map((a) => ({ id: ID, severity: 'WARN', summary: summaryFor(a), fix: fixFor(a) }));

  return { actions, findings };
}

// gitdirTarget points "into the repo" iff it lives under <repoGitDir>/worktrees/. Both sides are
// path.resolve-normalized first (lexical) so `..`/`.` segments, trailing slashes, and a resolved-relative
// target compare correctly. This fn itself does NO realpath (it stays pure) — the CALLER feeds it the
// canonical (realpath'd) pair as a SECOND call so an NFS/symlink-aliased OUR-repo target still matches
// (the Codex realpath BLOCKER; a raw relative target was the earlier Codex BLOCKER). The `+ path.sep`
// guards a sibling-prefix collision (`<gitdir>/worktreesX` must NOT count as inside `<gitdir>/worktrees/`).
function pointsIntoRepo(gitdirTarget, repoGitDir) {
  if (!gitdirTarget || !repoGitDir) return false;
  const base = path.resolve(repoGitDir, 'worktrees');
  const target = path.resolve(gitdirTarget);
  return target === base || target.startsWith(base + path.sep);
}

// A worktree PATH (a checkout dir, not a gitdir target) is ours to reconcile iff it lives under
// <repoRoot>/.worktrees/ — exactly where worktreePathFor puts every managed linked worktree. repoRoot
// is the parent of repoGitDir (<repoRoot>/.git, or the common-git-dir when run inside a worktree, which
// still resolves to the MAIN repo's .git). The repo root itself and any out-of-tree worktree fall
// OUTSIDE this dir, so Pass C never prunes the primary worktree. The `+ path.sep` boundary keeps the
// `.worktrees` dir itself (and a sibling like `.worktrees-bak`) from counting as inside.
function underManagedWorktrees(worktreePath, repoGitDir) {
  if (!worktreePath || !repoGitDir) return false;
  const wtRoot = path.resolve(path.dirname(repoGitDir), '.worktrees');
  return path.resolve(worktreePath).startsWith(wtRoot + path.sep);
}

function summaryFor(a) {
  switch (a.reason) {
    case 'crash-leak':
      return `worktree '${a.path}' is registered + on disk but its bundle${a.slug ? ` (${a.slug})` : ''} recorded it removed — teardown left it behind (crash-leak)`;
    case 'repo-move':
      return `worktree '${a.path}' has a dangling git admin link (repo-move) — present on disk, not registered`;
    case 'foreign-leftover':
      return `'${a.path}' is a foreign-repo leftover checkout (its .git points at another repository), not a worktree of this repo`;
    case 'legacy-missing':
      return `bundle ${a.slug}: worktree_disposition 'missing' is a legacy phantom value (the enum is 3-valued)`;
    case 'foreign-unverified':
      return `'${a.path}' looks like a foreign-repo leftover (its .git points outside this repo) but the target can't be resolved to PROVE it — left for manual review, never auto-removed`;
    case 'active-unregistered':
      return `worktree '${a.path}' is claimed by a LIVE bundle${a.slug ? ` (${a.slug})` : ''} but git has no registration for it and its .git can't be proven to belong here — restore/repair by hand; never auto-removed`;
    case 'duplicate-ownership':
      return `worktree '${a.path}' is claimed by more than one bundle${a.slugs?.length ? ` (${a.slugs.join(', ')})` : ''} — a path should have a single owner; the live claimant wins classification but the duplicate needs manual resolution`;
    case 'prune':
      return `git still lists worktree '${a.path}' but it is gone on disk and its bundle retired it — a dangling admin entry`;
    default:
      return `worktree '${a.path}' needs reconciliation (${a.reason})`;
  }
}

function fixFor(a) {
  switch (a.action) {
    case 'repair':
      return `re-link with \`git worktree repair '${a.path}'\` (or \`mp worktree reconcile\`)`;
    case 'remove':
      return a.registered
        ? `reap with \`git worktree remove --force '${a.path}'\` (preserve any local work first), or \`mp worktree reconcile\``
        : `archive + diff against the bundle, then \`rm -rf '${a.path}' && git worktree prune\` (or \`mp worktree reconcile\`)`;
    case 'prune':
      return `\`git worktree prune\` to drop the dangling admin entry (or \`mp worktree reconcile\`)`;
    case 'manual':
      // Three distinct manual remedies — never collapse them: a live-owned stray is RESTORED, a
      // duplicate-claim is DISAMBIGUATED (never rm'd — a live owner holds it), a foreign-unverified
      // stray is confirmed-then-removed by a human.
      if (a.reason === 'active-unregistered') {
        return `a LIVE bundle still claims this worktree — re-register it with \`git worktree repair '${a.path}'\`, or if the run is truly done record the retirement via \`mp set-worktree-disposition --disposition=removed_after_merge\`; the reconciler never auto-removes it`;
      }
      if (a.reason === 'duplicate-ownership') {
        return `more than one bundle records this worktree path — retire the stale claimant(s) via \`mp set-worktree-disposition --disposition=removed_after_merge\` (or repoint the wrong bundle) so a single owner remains; the reconciler never auto-removes a duplicated path`;
      }
      return `investigate by hand — confirm it holds no unique work, then \`rm -rf '${a.path}' && git worktree prune\`; the reconciler will NOT auto-remove a stray it cannot prove foreign`;
    case 'normalize':
      return `durably record the canonical disposition with \`mp worktree record --disposition=removed_after_merge\` (or \`mp worktree reconcile\`)`;
    default:
      return null;
  }
}
