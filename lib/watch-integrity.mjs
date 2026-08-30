// watch-integrity: cross-locus watch-list integrity substrate.
//
// Owns the pre-launch / post-wave watch list: git porcelain parsing, status
// snapshots, content hashing, baseline management, delta verification, and
// restoration evidence. Separated from the wave-completion transaction in
// wave-commit.mjs so LAUNCH (dispatch-wave) and RECORD (wave-commit) both
// depend on one domain module rather than on each other.
//
// The watch list closes three breaches verifyScope cannot see:
//   1. A child COMMITS (HEAD moves; status goes clean).
//   2. A child edits a file that was ALREADY dirty at launch (CD-2 precheck).
//   3. A child writes into MAIN outside the controller's transaction files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { parseState } from './bundle.mjs';
import { partitionPathsByRepo } from './dispatch/multi-repo.mjs';

// Local git only (-C-qualified to loci derived below). Throws with command context so a
// failed git surfaces as a die() at the bin boundary, never a silent half-transaction.
export function runGit(dir, args, _exec = execFileSync) {
  try {
    return String(_exec('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim();
    throw new Error(`git -C ${dir} ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

// Split runGit output into non-empty lines. Used by capture helpers and reset logic
// across modules — centralized here beside runGit so git line-parsing has one home.
export function gitLines(dir, args, _exec = execFileSync) {
  const out = runGit(dir, args, _exec);
  return out ? out.split('\n').filter(Boolean) : [];
}

// A8: the workspace-root derivation shared by launch-time capture (continue.mjs) and
// completion-time consumption (wave-commit.mjs). The workspace root is the directory that
// CONTAINS the repo root — the umbrella holding sibling checkouts agents may drop loose
// files into (e.g. the fleet workspace root holding every repo). It is derived from the
// repo's canonical root — the git common dir's parent — which is depth-independent (no
// relative hops, so `.worktrees/` nesting depth is irrelevant) and host-independent (no
// hardcoded path gate, so it works off-fleet). Crucially it is also STABLE across loci:
// `rev-parse --show-toplevel` from a linked worktree returns that worktree's own toplevel,
// which would resolve a different (wrong) container — the common dir's parent resolves to
// the same repo root whether called from MAIN or any linked worktree. Both callers pass
// MAIN (the repo root), so capture and consumption always agree on the same root.
export function workspaceRootFor(repoRoot) {
  const repoRootDir = path.dirname(runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const wsRoot = path.dirname(repoRootDir);
  // Never treat the repo root itself (repo at filesystem root) as a workspace root: a
  // repo root has no sibling container, and capturing its own entries would be vacuous.
  return wsRoot === repoRootDir ? null : wsRoot;
}

// ── cross-locus watch-list integrity ────────────────────────────────────────
//
// verifyScope answers "did a child write a path outside its declared scope?" — but only
// for paths, only inside the run worktree and the sibling loci the scope names, and only
// for files that appear in `git status`. Three real breaches slip past it:
//
//   1. A child COMMITS. The file leaves `git status`, so the after-capture is clean and
//      the breach is invisible — while the repo's HEAD has silently moved.
//   2. A child edits a file that was ALREADY dirty at launch. It is in `before`, so it is
//      excluded from `touched`, and the user's in-progress work is silently overwritten
//      (CD-2). The fix has to be a PRECHECK: never dispatch children over user dirt.
//   3. A child writes into MAIN — the bundle repo — which is not a scope locus at all.
//      MAIN is the one repo the controller itself writes, so "unchanged" is the wrong
//      bar; the bar is "changed ONLY in the controller's own transaction files, and only
//      in the ways the transaction is allowed to change them".
//
// The watch list closes all three: MAIN plus every repo a wave task scope names, snapshotted
// by (HEAD sha, per-path status + content hash) before launch and after completion. Anything
// outside the allowed delta — including a HEAD move — fails the wave loud.

/** sha256 of a file's bytes; null when the path is absent or unreadable. */
function hashFile(abs, _readFile = fs.readFileSync) {
  try {
    return crypto.createHash('sha256').update(_readFile(abs)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Extract the repo-relative path from one `git status --porcelain=v2` record.
 * Formats (git-status(1) "Porcelain Format Version 2"):
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>   |   ! <path>
 * Paths may contain spaces, so the trailing field is taken by offset, not by split.
 * Returns null for records this parser does not recognise — callers treat that as a
 * violation rather than silently ignoring an entry.
 */
export function parsePorcelainV2Entry(line) {
  if (!line) return null;
  const kind = line[0];
  const nth = (n) => {
    // Byte offset just past the n-th space-delimited field.
    let idx = 0;
    for (let i = 0; i < n; i += 1) {
      idx = line.indexOf(' ', idx);
      if (idx < 0) return null;
      idx += 1;
    }
    return idx;
  };
  if (kind === '?' || kind === '!') {
    const at = nth(1);
    return at == null ? null : { xy: kind, path: line.slice(at) };
  }
  if (kind === '1' || kind === '2' || kind === 'u') {
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : 10;
    const at = nth(fields);
    if (at == null) return null;
    const rest = line.slice(at);
    // Rename/copy records carry "<path>\t<origPath>"; the current path is what we watch.
    const p = kind === '2' ? rest.split('\t')[0] : rest;
    return { xy: line.slice(2, line.indexOf(' ', 2)), path: p };
  }
  return null;
}

/**
 * Snapshot one watched repo: HEAD plus every dirty/untracked path with its status code
 * and content hash. Content hashing (not just the status line) is what makes an
 * in-place edit of an already-dirty file detectable.
 *
 * @returns {{repo: string, head: string, entries: Record<string, {xy: string, hash: string|null}>, unparsed: string[]}}
 */
export function snapshotRepoState(repo, io = {}) {
  const _runGit = io.runGit ?? runGit;
  const _readFile = io.readFile ?? fs.readFileSync;
  const head = _runGit(repo, ['rev-parse', 'HEAD']);
  const out = _runGit(repo, [
    '-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--untracked-files=all',
  ]);
  const entries = {};
  const unparsed = [];
  for (const line of (out ? out.split('\n') : []).filter(Boolean)) {
    const e = parsePorcelainV2Entry(line);
    if (!e) {
      unparsed.push(line);
      continue;
    }
    entries[e.path] = { xy: e.xy, hash: hashFile(path.join(repo, e.path), _readFile) };
  }
  return { repo, head, entries, unparsed };
}

/**
 * The watch list for a wave: MAIN (the bundle repo) plus every repo a task scope names.
 * `scopePaths` are umbrella-relative; partitionPathsByRepo maps them onto real loci.
 *
 * @returns {Array<{repo: string, prefix: string|null, isMain: boolean}>}
 */
export function buildWatchList(scopePaths, { worktree, mainRoot, slug } = {}) {
  const seen = new Map();
  const add = (repo, prefix, isMain) => {
    const abs = path.resolve(repo);
    if (!seen.has(abs)) seen.set(abs, { repo: abs, prefix: prefix ?? null, isMain });
  };
  add(mainRoot, null, true);
  add(worktree, null, false);
  let loci = [];
  try {
    loci = partitionPathsByRepo(scopePaths ?? [], { worktree, mainRoot, slug }) ?? [];
  } catch {
    loci = []; // unresolvable scope degrades to MAIN + worktree, never to "no watching"
  }
  for (const l of loci) add(l.repo, l.prefix, false);
  return [...seen.values()];
}

export function snapshotWatchList(watchList, io = {}) {
  const out = {};
  for (const w of watchList) {
    try {
      out[w.repo] = { ...snapshotRepoState(w.repo, io), prefix: w.prefix ?? null, isMain: !!w.isMain };
    } catch (err) {
      // A repo we cannot snapshot is a watching FAILURE, recorded as such — never
      // silently dropped, which would read downstream as "nothing changed here".
      out[w.repo] = { repo: w.repo, error: String(err?.message ?? err), prefix: w.prefix ?? null, isMain: !!w.isMain };
    }
  }
  return out;
}

/** Map an umbrella-relative scope path onto its repo-relative form for a watched repo. */
function relForRepo(scopePath, snap) {
  if (!snap.prefix) return scopePath;
  return scopePath.startsWith(`${snap.prefix}/`) ? scopePath.slice(snap.prefix.length + 1) : null;
}

/**
 * LAUNCH PRECHECK (CD-2): refuse to dispatch children over the user's in-progress work.
 * A file a wave task claims that is ALREADY dirty in its watched repo blocks the launch —
 * the child would overwrite work the after-capture cannot attribute to anyone.
 *
 * The discriminator is the run's FROZEN launch baseline (active_run.baseline), not
 * dirtiness alone. A recover_wave retry legitimately starts with task-scoped files dirty:
 * record-result deliberately leaves a failed task's partial edits uncommitted so recover's
 * `checkout -- resetPaths` can reset them. That residue appeared AFTER the baseline was
 * frozen, so it is ours to overwrite. Dirt present in the baseline predates the run
 * entirely — that is the user's, and it blocks.
 *
 * With no baseline supplied the check falls back to blocking on any dirt, which is the
 * conservative direction: a spurious block is recoverable, a silent clobber is not.
 *
 * @param {object}   snapshots  — snapshotWatchList output
 * @param {string[]} scopePaths — umbrella-relative wave task scopes
 * @param {{baseline?: string[]|null}} [opts]
 * @returns {{ok: boolean, violations: Array<{repo: string, path: string, xy: string, reason: string}>}}
 */
export function precheckWatchList(snapshots, scopePaths, { baseline = null } = {}) {
  const violations = [];
  const preexisting = Array.isArray(baseline) ? new Set(baseline) : null;
  for (const snap of Object.values(snapshots)) {
    if (snap.error) {
      violations.push({ repo: snap.repo, path: '(repo)', xy: '', reason: `watched repo could not be snapshotted: ${snap.error}` });
      continue;
    }
    if (snap.unparsed?.length) {
      violations.push({ repo: snap.repo, path: '(repo)', xy: '', reason: `unparseable git status records (${snap.unparsed.length}) — refusing to launch against an unreadable baseline` });
      continue;
    }
    if (snap.isMain) continue; // MAIN's dirt is the controller's own bundle, checked on delta instead
    for (const scoped of scopePaths ?? []) {
      const rel = relForRepo(scoped, snap);
      if (rel == null) continue;
      const entry = snap.entries[rel];
      if (!entry) continue;
      // Dirt that appeared after the baseline was frozen is this run's own prior-attempt
      // residue, which a retry is entitled to overwrite.
      if (preexisting && !preexisting.has(scoped) && !preexisting.has(rel)) continue;
      violations.push({
        repo: snap.repo,
        path: rel,
        xy: entry.xy,
        reason: 'task-scoped file was already dirty when this run started — dispatching would overwrite uncommitted user work (CD-2)',
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

// The controller's own transaction files inside the bundle dir. MAIN may change HERE and
// nowhere else during a wave. Matched against bundle-dir-relative paths.
export const MAIN_TRANSACTION_FILES = [
  /^state\.yml$/,
  /^state\.yml\.v\d+\.bak$/,
  /^events\.jsonl$/,
  /^WORKLOG\.md$/,
  /^plan\.index\.json$/,
  /^\.plan-fragments\.json$/,
  /^wave-\d+\.dispatch(\.[\w.-]+)?(\.json)?$/,
  /^\.wave-\d+\.attempt-\d+$/,
  /^\.wave-\d+\.watch\.json$/,
  // Guard D sentinels (.owner.lock, .owner.hb.<host>.<session>). The controller writes
  // these itself — the heartbeat is refreshed on every §2 entry, so it moves DURING the
  // wave by design. They were excluded from the state-commit pathspec below but not from
  // the watch, so every record reported the controller's own heartbeat as "MAIN changed
  // outside the controller's transaction files" (e2e finding 7). Excluded here, not
  // content-validated: a child forging an owner sentinel is Guard D's problem, and the
  // commit pathspec still refuses to ship one.
  /^\.owner\.lock$/,
  /^\.owner\.hb\./,
];

/** Where the launch-time watch baseline for a wave lives (a controller transaction file). */
export function watchBaselinePath(bundleDir, wave) {
  return path.join(bundleDir, `.wave-${wave}.watch.json`);
}

/**
 * Capture the launch baseline: watch-list snapshots plus the bundle-file facts the MAIN
 * content checks need (events.jsonl length + hash, state.yml text). Written to a sidecar
 * rather than into state.yml — state.yml is itself watched, and embedding its own text
 * would be recursive.
 */
export function captureWatchBaseline({ mainRoot, bundleDir, worktree, slug, scopePaths } = {}, io = {}) {
  const _readText = io.readText ?? ((p) => fs.readFileSync(p, 'utf8'));
  const watchList = buildWatchList(scopePaths, { worktree, mainRoot, slug });
  const snapshots = snapshotWatchList(watchList, io);
  let eventsBuf = Buffer.alloc(0);
  try {
    eventsBuf = Buffer.from(_readText(path.join(bundleDir, 'events.jsonl')), 'utf8');
  } catch { /* a bundle with no events yet */ }
  let stateText = null;
  try {
    stateText = _readText(path.join(bundleDir, 'state.yml'));
  } catch { /* caller validates state separately */ }
  return {
    snapshots,
    bundle: {
      bundleDir,
      eventsBytes: eventsBuf.length,
      eventsSha: crypto.createHash('sha256').update(eventsBuf).digest('hex'),
      stateText,
    },
  };
}

export function writeWatchBaseline(bundleDir, wave, baseline) {
  const p = watchBaselinePath(bundleDir, wave);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

export function readWatchBaseline(bundleDir, wave) {
  try {
    return JSON.parse(fs.readFileSync(watchBaselinePath(bundleDir, wave), 'utf8'));
  } catch {
    return null; // absent → the integrity check degrades to a documented no-op
  }
}

// Top-level state.yml keys the wave transaction is allowed to move. A change to anything
// else (goals, refs, plan_index_path, slug, …) means something other than the controller
// wrote state.yml mid-wave.
export const CONTROLLER_STATE_KEYS = new Set([
  'active_run', 'tasks', 'updated_at', 'worktree', 'owner', 'phase', 'status',
  'dispatch', 'runs', 'last_event', 'verified_sha',
]);

/**
 * Validate that MAIN's delta is a legal controller transaction — by CONTENT, not just path.
 * A path-only allowlist would pass a child that rewrote events.jsonl from scratch or
 * flipped `phase` to `archived`.
 */
function validateMainDelta(rel, beforeSnap, afterSnap, io = {}) {
  const _read = io.readText ?? ((p) => fs.readFileSync(p, 'utf8'));
  const abs = path.join(afterSnap.repo, rel);
  const bundleRel = io.bundleRel ? io.bundleRel(rel) : rel;
  if (!MAIN_TRANSACTION_FILES.some((re) => re.test(bundleRel))) {
    return `MAIN changed outside the controller's transaction files: ${rel}`;
  }
  if (/events\.jsonl$/.test(bundleRel)) {
    let text;
    try {
      text = _read(abs);
    } catch (e) {
      return `events.jsonl unreadable after the wave: ${e.message}`;
    }
    for (const [i, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue;
      try {
        JSON.parse(line);
      } catch {
        return `events.jsonl line ${i + 1} is not parseable JSON — the append-only log was corrupted`;
      }
    }
    // Append-only, checked on BYTES: the launch baseline recorded the file's length and
    // the hash of exactly those bytes, so a rewrite that happens to end up longer is
    // still caught (a length check alone would not catch it).
    const bundle = io.bundle ?? null;
    if (bundle && Number.isInteger(bundle.eventsBytes)) {
      const buf = Buffer.from(text, 'utf8');
      if (buf.length < bundle.eventsBytes) {
        return `events.jsonl shrank (${bundle.eventsBytes} -> ${buf.length} bytes) — the log is append-only`;
      }
      const prefixSha = crypto.createHash('sha256')
        .update(buf.subarray(0, bundle.eventsBytes))
        .digest('hex');
      if (bundle.eventsSha && prefixSha !== bundle.eventsSha) {
        return 'events.jsonl was rewritten, not appended to — the log is append-only';
      }
    }
    return null;
  }
  if (/state\.yml$/.test(bundleRel)) {
    const priorText = io.bundle?.stateText ?? io.priorStateText;
    if (typeof priorText !== 'string') return null; // no baseline text → structural check only
    let before;
    let after;
    try {
      before = parseState(priorText);
      after = parseState(_read(abs));
    } catch (e) {
      return `state.yml no longer parses after the wave: ${e.message}`;
    }
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const illegal = changed.filter((k) => !CONTROLLER_STATE_KEYS.has(k));
    if (illegal.length) {
      return `state.yml changed fields outside the controller transaction: ${illegal.join(', ')}`;
    }
    return null;
  }
  return null;
}

/**
 * Was `rel` a TRACKED file in this repo when the wave launched?
 *
 * The launch snapshot only records dirty/untracked paths — `git status` says nothing about
 * a tracked file that was clean. So "absent from before.entries" means "clean or absent",
 * not "absent", and reading it as absence is what made a child's modification of a clean
 * tracked file report as `file created`. The launch HEAD is the authority: ask it directly.
 *
 * Returns null when the question cannot be answered (no recorded HEAD, git unavailable) —
 * the caller then states the delta without claiming create-vs-modify either way, rather
 * than guessing.
 */
function wasTrackedAtLaunch(repo, rel, before, io = {}) {
  const _runGit = io.runGit ?? runGit;
  if (!before?.head) return null;
  try {
    // ls-tree, not `cat-file -e`: cat-file signals "absent" by a bare non-zero exit with no
    // message, which is indistinguishable from git being broken. ls-tree exits 0 either way
    // and answers by whether it printed a record, so a real failure still throws to null.
    const out = _runGit(repo, ['ls-tree', '--name-only', '-z', before.head, '--', rel]);
    return String(out ?? '').replace(/\0/g, '').trim() !== '';
  } catch {
    return null; // genuinely unanswerable (bad repo/head, git unavailable)
  }
}

/** Human-readable reason for an out-of-scope delta in a watched (non-MAIN) repo. */
function describeOutOfScopeDelta(repo, rel, before, beforeEntry, io = {}) {
  if (beforeEntry) {
    return 'file changed during the wave but is outside every task scope '
      + '(it was dirty at launch, so verifyScope cannot see it)';
  }
  const tracked = wasTrackedAtLaunch(repo, rel, before, io);
  if (tracked === true) {
    return 'tracked file modified during the wave but is outside every task scope '
      + '(it was clean at launch, so it carried no status entry to compare against)';
  }
  if (tracked === false) {
    return 'file created during the wave but is outside every task scope';
  }
  return 'file changed during the wave but is outside every task scope '
    + '(could not determine whether it existed at launch)';
}

/**
 * Compare the launch and completion snapshots against the wave's allowed delta.
 *
 * Allowed, per watched repo: exactly the wave's task-scoped paths (the same allow-set
 * verifyScope uses), plus — for MAIN only — the controller's transaction files, content-
 * validated. A moved HEAD in ANY watched repo is a violation: a child committed, and the
 * wave transaction's revert/commit steps assume it did not.
 *
 * @returns {{ok: boolean, violations: Array<{repo: string, path: string, reason: string}>}}
 */
export function verifyWatchListDelta(beforeSnaps, afterSnaps, scopePaths, io = {}) {
  const violations = [];
  const scoped = new Set(scopePaths ?? []);
  const dirScopes = [...scoped].filter((s) => s.endsWith('/'));

  for (const [repo, after] of Object.entries(afterSnaps ?? {})) {
    const before = beforeSnaps?.[repo];
    if (!before) continue; // repo joined the watch list after launch — nothing to compare
    if (before.error || after.error) {
      violations.push({ repo, path: '(repo)', reason: `watched repo snapshot failed: ${before.error ?? after.error}` });
      continue;
    }
    if (after.unparsed?.length) {
      violations.push({ repo, path: '(repo)', reason: `unparseable git status records (${after.unparsed.length})` });
    }
    if (before.head !== after.head) {
      violations.push({
        repo,
        path: '(HEAD)',
        reason: `watched repo HEAD moved during the wave: ${before.head} -> ${after.head} — a child committed`,
      });
    }
    const paths = new Set([...Object.keys(before.entries ?? {}), ...Object.keys(after.entries ?? {})]);
    for (const rel of paths) {
      const b = before.entries?.[rel] ?? null;
      const a = after.entries?.[rel] ?? null;
      if (b && a && b.xy === a.xy && b.hash === a.hash) continue; // untouched
      if (after.isMain) {
        const reason = validateMainDelta(rel, before, after, io);
        if (reason) violations.push({ repo, path: rel, reason });
        continue;
      }
      const umbrella = after.prefix ? `${after.prefix}/${rel}` : rel;
      const inScope = scoped.has(umbrella) || dirScopes.some((d) => umbrella.startsWith(d));
      if (!inScope) {
        // `restore` is how the transaction undoes this breach (step 3c). Deliberately null
        // when the path was ALREADY dirty at launch: that content is the user's in-progress
        // work (CD-2), so the wave reports the breach and leaves it alone rather than
        // reverting over it. Null also when trackedness is unknown — we do not guess with
        // a destructive operation.
        const trackedAtLaunch = b ? null : wasTrackedAtLaunch(repo, rel, before, io);
        violations.push({
          repo,
          rel,
          path: umbrella,
          reason: describeOutOfScopeDelta(repo, rel, before, b, io),
          ...(b ? {} : { trackedAtLaunch }),
          restore: b ? null : (trackedAtLaunch === true ? 'checkout' : trackedAtLaunch === false ? 'clean' : null),
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
