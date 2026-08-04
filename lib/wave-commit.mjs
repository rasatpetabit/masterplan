// wave-commit: the §2a wave-completion transaction, absorbed into code (T2.2, git-in-bin seam).
//
// recordWaveResult is the single durable transaction that used to live as prose in
// commands/masterplan.md — §2a Completion steps 0-4, the §2 finalize_run crash-reconcile
// row, and the §2e¶6 split-commit trace. The LLM stops being the transaction engine: it
// hands the L2 workflow result to `mp record-result` and gets back a digest + the next
// decide action. CD-7 strengthens here — `mp` is the sole writer of state AND the sole
// executor of the LOCAL git bracketing it (network ops stay shell-side).
//
// Transaction order (each prefix is crash-safe; finalize_run reconciles any suffix):
//   0. owner heartbeat (lost-to-other → return, ZERO writes)
//   1. mark digests in-memory (markTask throws on unknown id → all-or-nothing), ONE
//      atomic writeState — the LEADING durable action; active_run marker stays intact
//   2. capture `after` multi-repo (umbrella WT + sibling loci referenced by scope),
//      verifyScope against the immutable active_run.scope allow-set off the baseline
//   3. out-of-scope revert per locus, split by trackedness (checkout/clean per repo)
//   4. code commit per locus — pathspec-scoped, done-files only unless the whole wave is done
//      (failed tasks' partial edits stay UNCOMMITTED so recover's checkout actually resets;
//      sibling worktrees under MAIN/<sib>/.worktrees/<slug> commit independently)
//   5. all wave tasks done → clearActiveRun + second writeState
//   6. dispatch-provenance events (dispatch_degraded / dispatch_inline_designed, from the
//      digests' optional adsp-v1.1 dispatch field) + wave_recorded event, then state commit
//      in MAIN — pathspec-scoped to the bundle dir
//   7. decideNextAction on the resulting state → `next`
//
// Crash windows (why each ordering is load-bearing):
//   after 1 → marker+baseline intact → finalize_run re-runs the tail idempotently
//   after 4 → WT clean → reconcile's verify/revert/commit all no-op → clear + state commit
//   after 5 → state leads git (CD-7 ordering) → the next state commit sweeps the bundle
//
// Reconcile mode (result: null) IS the §2 finalize_run row: no marks, the verify → revert →
// commit → clear tail still runs (clean WT degrades to pure no-ops + marker clear).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { verifyScope, declaredScope } from './wave.mjs';
import { readState, writeState, appendEvent, markTask, clearActiveRun, parseState } from './bundle.mjs';
import { heartbeatOwner } from './owner-fs.mjs';
import { decideNextAction } from './resume.mjs';
import {
  captureMultiRepoFiles,
  partitionPathsByRepo,
  mapUmbrellaPathsToRepos,
} from './dispatch/multi-repo.mjs';

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

function gitLines(dir, args) {
  const out = runGit(dir, args);
  return out ? out.split('\n').filter(Boolean) : [];
}

// The workspace root baseline: non-hidden entries at the workspace root level.
// Used to detect agent-created loose files (AUDIT-*.md, progress.md, etc.) after a wave.
// `wsRoot` is the workspace root directory (e.g. /srv/dev).
export function captureWorkspaceRoot(wsRoot) {
  try {
    return fs.readdirSync(wsRoot).filter((e) => !e.startsWith('.'));
  } catch {
    return [];
  }
}

// The D6 capture: tracked changes vs HEAD ∪ untracked (same two commands the prose
// specified for `before`/`after`, quotePath off so non-ASCII paths compare stably).
export function captureWtFiles(wt) {
  const tracked = gitLines(wt, ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD']);
  const untracked = gitLines(wt, ['-c', 'core.quotePath=false', 'ls-files', '-o', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

// The known per-task review verdict vocabulary (L2's extractVerdict / the
// fabric mapAdversaryLaneVerdict). A review object is only trusted for the
// blocking gate when it is VERDICT-SHAPED — an echoed descriptor requirement
// like {adversary:true} riding on item.review must NOT mask a digest-embedded
// blocking verdict (round-2 review P1).
const REVIEW_VERDICTS = new Set(['blocking', 'advisory', 'clean', 'inconclusive']);
const isVerdictShaped = (r) =>
  r != null && typeof r === 'object' && !Array.isArray(r) &&
  typeof r.verdict === 'string' && REVIEW_VERDICTS.has(r.verdict);

const coerceId = (v) => (/^-?\d+$/.test(String(v)) ? Number(v) : v);

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
const MAIN_TRANSACTION_FILES = [
  /^state\.yml$/,
  /^state\.yml\.v\d+\.bak$/,
  /^events\.jsonl$/,
  /^WORKLOG\.md$/,
  /^plan\.index\.json$/,
  /^\.plan-fragments\.json$/,
  /^wave-\d+\.dispatch(\.[\w.-]+)?(\.json)?$/,
  /^\.wave-\d+\.attempt-\d+$/,
  /^\.wave-\d+\.watch\.json$/,
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
const CONTROLLER_STATE_KEYS = new Set([
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
        violations.push({
          repo,
          path: umbrella,
          reason: b
            ? 'file changed during the wave but is outside every task scope (it was dirty at launch, so verifyScope cannot see it)'
            : 'file created during the wave but is outside every task scope',
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export function recordWaveResult({ statePath, result = null, self, now, worktree } = {}) {
  if (!statePath) throw new Error('record-result: statePath is required');
  const state = readState(statePath);
  const run = state.active_run;
  if (!run) throw new Error('record-result: no active_run marker — nothing to record (already finalized?)');
  if (run.kind === 'plan') {
    throw new Error('record-result: active_run is a plan run — plan results merge via merge-plan-fragments, not record-result');
  }
  if (!Number.isInteger(run.wave)) {
    throw new Error(`record-result: active_run.wave is not an integer (${JSON.stringify(run.wave)})`);
  }
  const wave = run.wave;
  if (result && Number.isInteger(result.wave) && result.wave !== wave) {
    throw new Error(`record-result: result is for wave ${result.wave} but active_run is wave ${wave} — refusing foreign result`);
  }

  // Stale-epoch (fencing-token) fence: a result carrying an epoch older than the marker's
  // current per-claim monotonic epoch is a reaped worker resuming late. Reject it BEFORE any
  // state byte is written (before the all-or-nothing markTask pass) so two harness workers can
  // never both mutate the same worktree across a stale reap. Extends the foreign-result guard.
  // Only fires on epoch-fenced markers (run.epoch finite); pre-epoch bundles keep prior behavior.
  if (result && Number.isFinite(run.epoch)) {
    const resultEpoch = Number.isFinite(result.epoch) ? result.epoch : null;
    if (resultEpoch === null || resultEpoch < run.epoch) {
      return {
        outcome: 'stale-epoch',
        wave,
        resultEpoch,
        currentEpoch: run.epoch,
        reason: `result epoch ${resultEpoch === null ? '(missing)' : resultEpoch} is stale (current claim epoch is ${run.epoch})`,
      };
    }
  }

  // 0. Owner heartbeat — STRICT (acquire must precede; §2 step 1.6 always does). Not ours →
  //    abort with zero writes so the rightful owner's transaction is never interleaved.
  //    Skipped only under the seeded escape hatch (`mp seed --owner-lock=off` →
  //    state.concurrency.owner_lock === 'off') — single-agent bundles that opted out of Guard D.
  const bundleDir = path.dirname(path.resolve(statePath));
  if (state.concurrency?.owner_lock !== 'off') {
    const hb = heartbeatOwner(bundleDir, self, { now });
    if (hb.outcome !== 'held-by-self') {
      return { outcome: 'lost-to-other', reason: hb.reason, incumbent: hb.incumbent ?? null };
    }
  }

  // Loci (§2e): MAIN derived from the bundle's repo, WT from state (or the conventional path).
  const MAIN = path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const slug = String(state.slug ?? '').trim();
  const wtCandidate = worktree ?? state.worktree ?? (slug ? path.join(MAIN, '.worktrees', slug) : null);
  if (!wtCandidate) {
    throw new Error('record-result: cannot derive the worktree locus — pass --worktree, or set state.worktree/slug');
  }
  const WT = path.resolve(wtCandidate);
  if (!fs.existsSync(WT)) {
    throw new Error(`record-result: worktree ${WT} does not exist — run reconcile against the surviving locus or re-create it`);
  }

  // 1. Mark digests — ALL in-memory first (markTask throws on unknown id before any byte
  //    hits disk), then ONE atomic writeState. Marker stays intact: a crash here leaves a
  //    finalize_run-recoverable bundle, never a half-marked one.
  const recorded = [];
  const failed = [];
  const qctl = [];
  const blocking_reviews = [];
  const dispatchEvents = [];
  let nextState = state;
  for (const item of result?.tasks ?? []) {
    const digest = item?.digest ?? item;
    const id = coerceId(digest?.task_id ?? item?.task_id);
    const status = digest?.status;
    if (status === 'done') {
      nextState = markTask(nextState, id, 'done');
      recorded.push(id);
    } else if (status === 'qctl') {
      // Synthetic: stays pending for the L1 qctl path; NOT a failure.
      qctl.push({ id, backend: item?.backend ?? null });
    } else {
      // failed / blocked / anything else: leave pending, surface for recover_wave.
      failed.push({ id, status: status ?? 'unknown', summary: digest?.summary ?? '', blockers: digest?.blockers ?? [] });
    }
    // Per-task adversary review verdict, gated on verdict shape (a non-verdict
    // object — e.g. an echoed descriptor requirement — is ignored). BOTH
    // sources are considered and EITHER blocking wins (round-4 P1): an echoed
    // {verdict:'clean'} on item.review must never mask a blocking
    // digest.review, and vice versa — findings union when both block. For
    // non-blocking bookkeeping the digest-embedded verdict (the fabric path's
    // authoritative write) outranks item.review, but only blocking verdicts
    // feed the wave-completion protocol.
    const itemReview = isVerdictShaped(item?.review) ? item.review : null;
    const digestReview = digest && typeof digest === 'object' && !Array.isArray(digest) && isVerdictShaped(digest.review)
      ? digest.review
      : null;
    if (itemReview?.verdict === 'blocking' || digestReview?.verdict === 'blocking') {
      const sources = [itemReview, digestReview].filter((r) => r && r.verdict === 'blocking');
      // The fabric path writes the SAME review to both surfaces — dedupe the
      // identical pair so findings are not doubled.
      const uniq = sources.length === 2 && JSON.stringify(sources[0]) === JSON.stringify(sources[1])
        ? [sources[0]]
        : sources;
      // blocking_reviews[].findings is ARRAY-SHAPED by contract (round-5 P2):
      // [] default, arrays concatenated, a bare string wrapped as [string] —
      // never a naked string leaking out of a mixed-shape union.
      const toArray = (f) => (Array.isArray(f) ? f : f == null ? [] : [f]);
      const findings = uniq.reduce((acc, r) => [...acc, ...toArray(r.findings)], []);
      blocking_reviews.push({ id, findings });
    }
    // adsp-v1.1 dispatch provenance → degradation-visibility events (fail-VISIBLE,
    // never fail-blocked: recording proceeds regardless). Digests without the
    // optional field (v1 / non-fabric paths) emit nothing.
    const disp = digest?.dispatch;
    if (disp != null && typeof disp === 'object' && !Array.isArray(disp)) {
      const degraded = disp.outcome === 'escalate' || disp.outcome === 'broker_error' || disp.degraded_fallback != null;
      const evBody = {
        task_id: id,
        outcome: disp.outcome ?? null,
        reason: disp.reason ?? null,
        decision_id: disp.decision_id ?? null,
        ...(disp.degraded_fallback != null ? { degraded_fallback: disp.degraded_fallback } : {}),
      };
      if (degraded) {
        dispatchEvents.push({ type: 'dispatch_degraded', ...evBody });
      } else if (disp.outcome === 'inline_designed') {
        // Designed Claude-tier inline routing gets its OWN durable tag so it is
        // queryable — and distinguishable from a broker outage — in events.jsonl.
        dispatchEvents.push({ type: 'dispatch_inline_designed', ...evBody });
      }
    }
  }
  if (result) writeState(statePath, nextState);

  // 2. Scope verification off the IMMUTABLE allow-set frozen at launch (active_run.scope);
  //    declaredScope is the state-only fallback for pre-scope markers.
  //    Multi-repo: `after` is umbrella-relative across the run worktree AND every sibling
  //    git checkout referenced by the declared scope (see captureMultiRepoFiles).
  const declared = run.scope ?? declaredScope(nextState, wave);
  const before = result?.baseline ?? run.baseline ?? [];
  const after = captureMultiRepoFiles(declared, {
    worktree: WT,
    mainRoot: MAIN,
    slug,
    captureWtFiles,
  });
  const scope = verifyScope(declared, before, after);

  // 2b. CROSS-LOCUS WATCH-LIST INTEGRITY — the three breaches verifyScope structurally
  //     cannot see (a child that committed, a child that edited an already-dirty file,
  //     a child that wrote into MAIN). Compared against the launch baseline written by
  //     the dispatcher; absent baseline (pre-watch bundles, inline waves) degrades to a
  //     documented no-op rather than a false alarm. Runs BEFORE the revert/commit steps,
  //     which assume no watched HEAD moved.
  const watchBaseline = readWatchBaseline(bundleDir, wave);
  let watch = { ok: true, violations: [], checked: false };
  if (watchBaseline?.snapshots) {
    const afterSnaps = snapshotWatchList(
      Object.values(watchBaseline.snapshots).map((s) => ({ repo: s.repo, prefix: s.prefix, isMain: s.isMain })),
    );
    const delta = verifyWatchListDelta(watchBaseline.snapshots, afterSnaps, declared, {
      bundle: watchBaseline.bundle ?? null,
      bundleRel: (rel) => path.relative(bundleDir, path.join(MAIN, rel)),
    });
    watch = { ...delta, checked: true };
    if (!watch.ok) {
      appendEvent(statePath, {
        type: 'watch_list_breach',
        wave,
        violations: watch.violations,
        at: new Date(now ?? Date.now()).toISOString(),
      });
    }
  }

  // 3. Out-of-scope revert, split by trackedness AND by owning repo (umbrella + siblings).
  //    Plain `checkout --` ERRORS on untracked paths, so tracked offenders revert via
  //    checkout and the remainder via clean — per locus, never a single worktree-rooted
  //    git that rejects external absolute/sibling paths.
  let reverted = [];
  if (!scope.ok && scope.outOfScope.length) {
    const oosLoci = partitionPathsByRepo(scope.outOfScope, {
      worktree: WT, mainRoot: MAIN, slug,
    });
    // Also handle pure-worktree paths that partition might miss if resolution fails.
    const mapped = mapUmbrellaPathsToRepos(
      scope.outOfScope,
      oosLoci.length
        ? oosLoci
        : [{ repo: WT, prefix: null }],
    );
    for (const [repo, rels] of mapped) {
      if (!rels.length) continue;
      const tracked = gitLines(repo, ['ls-files', '--', ...rels]);
      if (tracked.length) runGit(repo, ['checkout', '--', ...tracked]);
      runGit(repo, ['clean', '-fd', '--', ...rels]);
    }
    reverted = scope.outOfScope;
  }

  // 3b. Workspace root drift check: agents must not create loose files in the workspace root.
  //     If the wave was launched with a wsBaseline, compare current workspace root entries
  //     against it and remove any new non-hidden entries (agent artifacts like AUDIT-*.md).
  let wsLoose = [];
  if (run.wsBaseline && Array.isArray(run.wsBaseline) && run.wsBaseline.length > 0) {
    // Derive workspace root: parent of MAIN (e.g. /srv/dev/yanos-project -> /srv/dev).
    // The baseline was captured from this same path at dispatch.
    const wsRoot = path.dirname(MAIN);
    const now = captureWorkspaceRoot(wsRoot);
    const baselineSet = new Set(run.wsBaseline);
    const looseEntries = now.filter((e) => !baselineSet.has(e));
    if (looseEntries.length) {
      for (const entry of looseEntries) {
        const entryPath = path.join(wsRoot, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            // Don't remove directories (could be new repos the user created)
            wsLoose.push(entry + '/');
          } else {
            fs.unlinkSync(entryPath);
            wsLoose.push(entry);
          }
        } catch {
          wsLoose.push(entry + '?');
        }
      }
    }
  }

  // 4. Code commit — pathspec-scoped per edit locus (umbrella WT + sibling worktrees).
  //    Foreign staged content is never swept. Stage only in-scope touched files; when the
  //    wave has failures, narrow further to the done tasks' declared files so failed tasks'
  //    partial edits stay uncommitted and recover's `checkout -- resetPaths` actually resets.
  //    Multi-repo: map umbrella-relative stage paths back to per-repo rels and commit each
  //    locus independently (sibling edits must not be left dirty in yanos-os/.worktrees/*).
  const waveTasks = (nextState.tasks ?? []).filter((t) => t.wave === wave);
  const allDone = waveTasks.length > 0 && waveTasks.every((t) => t.status === 'done');
  const inScope = scope.touched.filter((f) => !scope.outOfScope.includes(f));
  let stage = inScope;
  if (!allDone) {
    const doneFiles = new Set(waveTasks.filter((t) => t.status === 'done').flatMap((t) => t.files ?? []));
    stage = inScope.filter((f) => doneFiles.has(f));
  }
  let codeSha = null;
  if (stage.length) {
    const stageLoci = partitionPathsByRepo(stage, { worktree: WT, mainRoot: MAIN, slug });
    const loci = stageLoci.length ? stageLoci : [{ repo: WT, prefix: null, rels: stage }];
    const byRepo = mapUmbrellaPathsToRepos(stage, loci);
    const shas = [];
    for (const [repo, rels] of byRepo) {
      if (!rels.length) continue;
      if (!runGit(repo, ['status', '--porcelain', '--', ...rels])) continue;
      runGit(repo, ['add', '--', ...rels]);
      runGit(repo, ['commit', '-q', '-m', `masterplan(${nextState.slug}): wave ${wave} code`, '--', ...rels]);
      shas.push(runGit(repo, ['rev-parse', 'HEAD']));
    }
    // Prefer the umbrella WT tip when present; else the last sibling tip (audit field).
    codeSha = shas.length ? (byRepo.has(WT) ? runGit(WT, ['rev-parse', 'HEAD']) : shas[shas.length - 1]) : null;
  }

  // 5. Whole wave done → clear the marker (second atomic write). Failures leave it intact
  //    so the next decide returns recover_wave with the stale task id.
  let cleared = false;
  if (allDone) {
    nextState = clearActiveRun(nextState);
    writeState(statePath, nextState);
    cleared = true;
  }

  // 6. Events (before the state commit so they land IN the state commit), then the MAIN
  //    state commit — pathspec-scoped to the bundle dir, unrelated staged work untouched.
  //    Dispatch-provenance events first (dispatch_degraded / dispatch_inline_designed —
  //    the adsp-v1.1 degradation-visibility surface), then the wave_recorded summary.
  const mode = result ? 'record' : 'reconcile';
  const ts = new Date(now ?? Date.now()).toISOString();
  for (const ev of dispatchEvents) {
    appendEvent(statePath, {
      type: ev.type,
      ts,
      phase: nextState.phase,
      task_id: ev.task_id,
      outcome: ev.outcome,
      reason: ev.reason,
      decision_id: ev.decision_id,
      ...(ev.degraded_fallback != null ? { degraded_fallback: ev.degraded_fallback } : {}),
      note: `task ${ev.task_id} dispatch ${ev.outcome ?? 'unknown'}${ev.reason ? `: ${ev.reason}` : ''}`,
    });
  }
  appendEvent(statePath, {
    type: 'wave_recorded',
    ts,
    phase: nextState.phase,
    note: `wave ${wave} ${mode}: ${recorded.length} done, ${failed.length} failed/blocked, ${qctl.length} qctl` +
      (reverted.length ? `; reverted ${reverted.length} out-of-scope` : '') +
      (wsLoose.length ? `; removed ${wsLoose.length} workspace-root loose file${wsLoose.length > 1 ? 's' : ''} (${wsLoose.join(', ')})` : ''),
  });
  // Guard D sentinels (.owner.lock / .owner.hb.*) live in the bundle dir but are explicitly
  // NOT CD-7 state — committing them would ship a stale lock to every clone. The prose's
  // `add docs/masterplan/<slug>` swept them latently; the code excludes them by pathspec.
  const bundleRel = path.relative(MAIN, bundleDir) || '.';
  const statePathspec = [bundleRel, `:(exclude)${bundleRel}/.owner*`];
  let stateSha = null;
  if (runGit(MAIN, ['status', '--porcelain', '--', ...statePathspec])) {
    runGit(MAIN, ['add', '--', ...statePathspec]);
    runGit(MAIN, ['commit', '-q', '-m', `masterplan(${nextState.slug}): wave ${wave} state (${mode})`, '--', ...statePathspec]);
    stateSha = runGit(MAIN, ['rev-parse', 'HEAD']);
  }

  // 7. The transaction is durable; `next` is advisory. decideNextAction can throw on
  //    malformed state — never throw away the recorded payload over the advisory tail.
  let next;
  try {
    next = decideNextAction(nextState, { alive: false });
  } catch (err) {
    next = { action: 'error', error: err.message };
  }

  return {
    outcome: 'recorded',
    mode,
    wave,
    recorded,
    failed,
    qctl,
    blocking_reviews,
    scope: { ok: scope.ok, touched: scope.touched, outOfScope: scope.outOfScope },
    watch: { ok: watch.ok, checked: watch.checked, violations: watch.violations },
    reverted,
    wsLoose,
    commits: { code: codeSha, state: stateSha },
    cleared,
    next,
  };
}
