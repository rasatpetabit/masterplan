// lib/recovery-preflight.mjs — committed-recovery preservation gate (contract item 7).
//
// Recovery recording must preflight the SAME scope/watch/baseline checks the normal
// record-result transaction runs, but WITHOUT mutation: no reset, no clean, no revert, no
// commit. In recovery mode the work is already committed at the pinned HEAD — the wave
// transaction's revert/commit steps are meaningless and dangerous. This module computes the
// verification verdicts (scope, watch-list delta, workspace-root drift) and returns them;
// the caller (recordWaveResult with recovery:true) rejects on any violation BEFORE marking
// tasks or touching the worktree. It never invokes a destructive git operation.
//
// LOCAL git only, -C-qualified (same seam as record-result).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { verifyScope, declaredScope } from './wave.mjs';
import {
  canonicalizeScopePaths,
  captureMultiRepoFiles,
} from './dispatch/multi-repo.mjs';
import {
  readWatchBaseline,
  snapshotWatchList,
  verifyWatchListDelta,
  workspaceRootFor,
  watchBaselinePath,
} from './watch-integrity.mjs';
import { canonicalRepoIdentity, resolveCommitOid, isAncestor } from './recovery-controller.mjs';

/**
 * Canonical repo identity agreement for the committed-recovery selector.
 *
 * `git -C <dir> rev-parse --show-toplevel` returns an ABSOLUTE path for both a main
 * checkout and a linked worktree, so resolved toplevel equality is a stable, CWD-independent
 * discriminator: the selector repo is the run worktree (or another worktree of the same
 * repo, e.g. a sibling edit locus) iff their roots are equal. `--git-common-dir` is NOT
 * used for equality — it is CWD-relative (`.git` vs `<main>/.git`) and would be fragile.
 */
function sameCanonicalRepo(a, b) {
  return a.root === b.root;
}

/**
 * Verify the explicit committed-recovery selector against the persisted launch record and
 * the live worktree. Every failure is a preservation violation (fail closed, zero writes).
 *
 * @returns {{ ok: boolean, violations: string[], repo: string, head: string, base: string }}
 */
export function verifyRecoverySelector({
  recoverySelector, WT, MAIN, slug, state, wave, bundleDir, watchBaseline = null,
} = {}) {
  const violations = [];
  const sel = recoverySelector;
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
    return { ok: false, violations: ['recovery preflight: recoverySelector is required in committed-recovery mode'], repo: null, head: null, base: null };
  }
  const { repo: selRepo, head: selHead } = sel;
  if (typeof selRepo !== 'string' || selRepo.trim() === '') {
    violations.push('recovery preflight: selector.repo must be a non-empty path');
  }
  if (typeof selHead !== 'string' || !/^[0-9a-f]{40}$/.test(selHead)) {
    violations.push('recovery preflight: selector.head must be a full 40-hex commit OID (never derive or accept short OIDs)');
  }

  // Frozen base from the PERSISTED wave-dispatch record — the same record the phase-A
  // recovery controller read. Direct JSON parse (validated shape) avoids a module cycle:
  // the bundle record reader lives in lib/dispatch-wave.mjs, which imports wave-commit.mjs,
  // which imports this module. Reads are read-only and strictly validated.
  let record = null;
  let recordPath = null;
  if (Number.isInteger(wave)) {
    recordPath = path.join(bundleDir, `wave-${wave}.dispatch.json`);
    try {
      const text = fs.readFileSync(recordPath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed;
      else violations.push(`recovery preflight: wave-dispatch record ${recordPath} is not an object`);
    } catch (err) {
      violations.push(`recovery preflight: wave-dispatch record ${recordPath} is unreadable or corrupt (${String(err?.message ?? err).trim()}) — committed recovery requires the persisted launch record`);
    }
  }
  const ctx = record?.review_context;
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) {
    violations.push('recovery preflight: frozen review_context is absent from the persisted wave-dispatch record — committed recovery requires it');
  } else if (ctx.enabled !== true) {
    // Absent/disabled context fails, never a silent pass (HOLD constraint 3 / contract item 1).
    violations.push('recovery preflight: frozen review_context is disabled — committed recovery requires an enabled frozen review context');
  }
  const ctxBase = typeof ctx?.base_sha === 'string' ? ctx.base_sha : null;
  if (ctxBase == null) {
    violations.push('recovery preflight: frozen review_context.base_sha is missing from the persisted wave-dispatch record');
  }
  const ctxTasks = Array.isArray(ctx?.tasks) ? ctx.tasks : [];
  const frozenRepos = [...new Set(ctxTasks.map((t) => (typeof t?.repo === 'string' ? t.repo : null)).filter(Boolean))];
  if (frozenRepos.length !== 1) {
    violations.push(`recovery preflight: frozen review_context names ${frozenRepos.length} repositories — committed recovery supports exactly one edit locus`);
  }
  const frozenRepo = frozenRepos.length === 1 ? frozenRepos[0] : null;

  // ---- Local git (read-only) checks on the live worktree ----
  let head = null;
  let base = null;
  if (violations.length === 0) {
    const repo = path.resolve(String(selRepo));
    const wtIdentity = canonicalRepoIdentity(WT);
    // 1. Canonical identity agreement: the selector repo and the run worktree must be the
    //    same canonical repo (resolved toplevel equality), so a selector naming a sibling
    //    MAIN or an unrelated checkout is rejected even if the path string happens to
    //    resolve.
    const selIdentity = canonicalRepoIdentity(repo);
    if (!sameCanonicalRepo(wtIdentity, selIdentity)) {
      violations.push(`recovery preflight: selector repo ${repo} is not the run worktree's canonical repo (${wtIdentity.root}) — refused`);
    }
    // 1b. The FROZEN review_context repo must also canonical-match the WT — the persisted
    //     record is authoritative, so a record that pins a different locus than the live
    //     worktree is refused (the selector must agree with both).
    if (frozenRepo) {
      try {
        const frozenIdentity = canonicalRepoIdentity(path.resolve(frozenRepo));
        if (!sameCanonicalRepo(wtIdentity, frozenIdentity)) {
          violations.push(`recovery preflight: frozen review_context repo ${frozenRepo} is not the run worktree's canonical repo (${wtIdentity.root}) — refused`);
        }
      } catch (err) {
        violations.push(`recovery preflight: cannot resolve canonical identity of frozen review_context repo ${frozenRepo}: ${String(err?.message ?? err).trim()}`);
      }
    }
    // 2. Exact LIVE HEAD equality with the selector: the commit currently checked out in
    //    the worktree must BE the pinned reviewed commit (resolveCommitOid throws on
    //    non-commit / unknown objects).
    try {
      const pinned = resolveCommitOid(WT, selHead);
      if (pinned !== selHead) violations.push(`recovery preflight: selector.head ${selHead} resolves to ${pinned} — exact HEAD equality required`);
      else head = pinned;
    } catch (err) {
      violations.push(`recovery preflight: ${String(err?.message ?? err).trim()}`);
    }
    if (head) {
      let live;
      try {
        live = resolveCommitOid(WT, 'HEAD');
      } catch (err) {
        violations.push(`recovery preflight: cannot resolve live HEAD in ${WT}: ${String(err?.message ?? err).trim()}`);
      }
      if (live && live !== head) {
        violations.push(`recovery preflight: live HEAD ${live} does not match the pinned head ${head} — refusing to review a different commit`);
      }
    }
    // 3. Frozen base must resolve in the same repo and be an ANCESTOR of the pinned head
    //    (the committed delta is base..head on the main line, never a divergent branch).
    try {
      const frozen = resolveCommitOid(WT, ctxBase);
      base = frozen;
    } catch (err) {
      violations.push(`recovery preflight: frozen base ${ctxBase} does not resolve in the run worktree — ${String(err?.message ?? err).trim()}`);
    }
    if (head && base) {
      if (base === head) {
        violations.push('recovery preflight: frozen base equals pinned head — the committed delta is empty; nothing to review');
      } else if (!isAncestor(WT, base, head)) {
        violations.push(`recovery preflight: frozen base ${base} is not an ancestor of pinned head ${head} — unrelated ancestry rejected`);
      }
    }

    // 4. Baseline edit-locus HEAD must equal the frozen base: the launch watch baseline
    //    was captured BEFORE the wave committed its work, so the edit locus sat at the
    //    frozen base_sha. A baseline whose edit-locus HEAD is anything else means the
    //    launch snapshot does not correspond to the frozen context — refusing protects the
    //    base..head delta's integrity (the commit being reviewed is provably built on the
    //    exact commit the wave launched from).
    if (base && watchBaseline?.snapshots) {
      const wtAbs = path.resolve(WT);
      let baselineEditHead = null;
      for (const s of Object.values(watchBaseline.snapshots)) {
        if (s && typeof s === 'object' && s.isMain === false && path.resolve(String(s.repo ?? '')) === wtAbs) {
          baselineEditHead = typeof s.head === 'string' ? s.head : null;
          break;
        }
      }
      if (baselineEditHead == null) {
        violations.push('recovery preflight: launch watch baseline has no edit-locus HEAD for the run worktree — cannot prove the recovered commit builds on the frozen base');
      } else if (baselineEditHead !== base) {
        violations.push(`recovery preflight: launch watch baseline edit-locus HEAD ${baselineEditHead} does not equal the frozen base ${base} — the recovered commit may not build on the frozen base; refusing`);
      }
    }
  }

  return { ok: violations.length === 0, violations, repo: selRepo ?? null, head, base };
}

/**
 * Compare the launch watch baseline against the LIVE worktree, permitting ONLY the checked
 * edit-locus HEAD movement (the recovered base→head commit that the pinned selector pins).
 *
 * The launch baseline was captured BEFORE the wave committed its work: the edit locus then
 * sat at the frozen base. In committed-recovery the work has ALREADY been committed, so the
 * edit locus's live HEAD legitimately moved base→head. Any OTHER watched repo (MAIN, sibling
 * checkouts) may NOT move at all, and no working-tree delta outside the committed scope may
 * appear anywhere. The comparison therefore runs verifyWatchListDelta against a LOCAL VIEW
 * of the baseline whose edit-locus entry has been re-based to the pinned head — the
 * original baseline file on disk is left byte-for-byte unchanged.
 *
 * The ORIGINAL baseline edit-locus HEAD is still constrained: verifyRecoverySelector
 * requires it equal the frozen base (the launch snapshot) BEFORE this substitution
 * runs. Substitution therefore permits only the authorized base→head move of the
 * recovered commit, not an arbitrary pre-launch HEAD drift.
 *
 * @returns {{ ok: boolean, violations: string[], checked: boolean, reverted?: string[], unrestored?: string[] }}
 */
export function compareWatchWithRecoveryHead({
  watchBaseline, head, WT, MAIN, slug, declared, bundleDir,
} = {}) {
  const out = { ok: true, violations: [], checked: false };
  const wtAbs = path.resolve(WT);
  if (!watchBaseline?.snapshots || typeof watchBaseline.snapshots !== 'object' || Array.isArray(watchBaseline.snapshots)) {
    return { ...out, checked: false };
  }
  // Local comparison view: shallow-clone the parsed baseline, rebasing ONLY the edit locus
  // entry's HEAD to the pinned recovered head. The on-disk baseline is never rewritten.
  const view = { ...watchBaseline, snapshots: { ...watchBaseline.snapshots } };
  let editLocusKey = null;
  for (const [key, s] of Object.entries(watchBaseline.snapshots)) {
    if (s && typeof s === 'object' && s.isMain === false && path.resolve(String(s.repo ?? '')) === wtAbs) {
      editLocusKey = key;
      break;
    }
  }
  if (editLocusKey == null) {
    return { ...out, checked: false, violations: ['recovery preflight: launch watch baseline has no edit-locus entry for the run worktree'] };
  }
  const editSnap = { ...view.snapshots[editLocusKey], head };
  view.snapshots[editLocusKey] = editSnap;
  // snapshotWatchList re-snapshots the LIVE tree; verifyWatchListDelta then compares against
  // the re-based view. A still-dirty live tree (any path that changed since the baseline,
  // including outside the committed delta) is reported by the delta, never silently cleared.
  let afterSnaps;
  try {
    afterSnaps = snapshotWatchList(
      Object.values(view.snapshots).map((s) => ({ repo: s.repo, prefix: s.prefix, isMain: s.isMain })),
    );
  } catch (err) {
    return { ...out, checked: false, violations: [`recovery preflight: could not re-snapshot the watch list: ${String(err?.message ?? err).trim()}`] };
  }
  const delta = verifyWatchListDelta(view.snapshots, afterSnaps, declared, {
    bundle: view.bundle ?? null,
    bundleRel: (rel) => path.relative(bundleDir, path.join(MAIN, rel)),
  });
  return { ...out, ok: delta.ok, violations: delta.violations, checked: true };
}

/**
 * Full list of paths changed between two commits, as repo-relative paths.
 *
 * NUL-delimited output parsed in Node (never shell substitution); --no-renames forces both
 * sides to name the same path (a rename would otherwise report only the source side and
 * silently skip the destination). --name-only -z returns raw bytes; splitting on NUL is
 * byte-safe for any path including those with embedded newlines or non-ASCII bytes.
 *
 * @param {string} repo
 * @param {string} baseSha
 * @param {string} headSha
 * @returns {string[]}
 */
function splitNulBuffers(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  const parts = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) {
      if (i > start) parts.push(raw.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < raw.length) parts.push(raw.subarray(start));
  return parts;
}

/** Decode a git `-z` path only when the bytes round-trip as UTF-8. */
function utf8PathOrThrow(buf) {
  const decoded = buf.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buf)) {
    throw new Error('recovery: committed path is not valid UTF-8 (not round-trippable) — refusing to match it against declared scope');
  }
  return decoded;
}

export function committedDeltaPaths(repo, baseSha, headSha, _exec = execFileSync) {
  const args = [
    '-C', repo,
    '-c', 'core.quotePath=false',
    'diff', '--no-renames', '--name-only', '-z',
    `${baseSha}..${headSha}`,
  ];
  let buf;
  try {
    buf = _exec('git', args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err && (err.status === 1 || err.code === 1) && err.stdout != null) {
      buf = err.stdout;
    } else {
      const stderr = String(err?.stderr ?? '').trim();
      throw new Error(`recovery: git ${args.join(' ')} failed: ${stderr || err.message}`);
    }
  }
  return splitNulBuffers(buf).map(utf8PathOrThrow);
}

/**
 * Which committed-delta paths fall OUTSIDE the wave's original DECLARED canonical scope.
 * `declared` is the already-canonicalized allow-set (worktree-relative for the run locus,
 * or sibling-prefixed for sibling checkouts). Directory entries (trailing '/') are prefix
 * scopes. Empty string and './' prefixes are stripped so committed paths (always
 * repo-relative, never './'-prefixed) compare cleanly.
 *
 * @returns {string[]} the out-of-scope committed paths (empty = fully in scope)
 */
export function outOfScopeCommittedPaths(declared, repo, baseSha, headSha) {
  const deltaPaths = committedDeltaPaths(repo, baseSha, headSha);
  const norm = (d) => String(d).replace(/\/+$/, '');
  const allow = new Set((Array.isArray(declared) ? declared : []).map(norm).filter((d) => d !== ''));
  const dirScopes = (Array.isArray(declared) ? declared : []).filter((d) => d.endsWith('/')).map(norm);
  const out = [];
  for (const p of deltaPaths) {
    const inScope = allow.has(p) || dirScopes.some((d) => p.startsWith(`${d}/`));
    if (!inScope) out.push(p);
  }
  return out;
}

/**
 * Read-only recovery preflight. Runs the SAME checks the normal transaction would, but
 * returns verdicts instead of mutating anything. A non-ok result must REJECT the recovery
 * before any task mark / state write / git mutation.
 *
 * The capture helpers (captureWtFiles / captureWorkspaceRoot) are injected by the caller
 * (wave-commit.mjs owns them) to avoid a module cycle; they must be the SAME functions the
 * normal transaction uses so the verdicts match exactly.
 *
 * @returns {{ ok: boolean, violations: string[], scope?: object, watch?: object,
 *             wsLoose?: string[] }}
 */
export function preflightRecovery({
  statePath, state, run, wave, WT, MAIN, slug, baseline,
  captureWtFiles, captureWorkspaceRoot, recoverySelector = null,
} = {}) {
  const violations = [];
  if (typeof captureWtFiles !== 'function' || typeof captureWorkspaceRoot !== 'function') {
    throw new Error('recovery-preflight: captureWtFiles and captureWorkspaceRoot must be injected by the caller');
  }
  const bundleDir = path.dirname(path.resolve(statePath));
  // The launch watch baseline is read ONCE, up front: the selector gate needs its edit-locus
  // HEAD (must equal the frozen base) and the watch comparison needs the same bytes.
  const watchBaseline = readWatchBaseline(bundleDir, wave);

  // COMMITTED-RECOVERY SELECTOR GATE (contract item 7): when the caller supplies the explicit
  // pinned selector (the real CLI flow — record-result --recovery-repo/--recovery-head →
  // recovery:true + recoverySelector), validate it against the WT canonical identity + live
  // HEAD, the frozen base from the persisted wave-dispatch record, and base ancestry BEFORE
  // any scope/watch comparison. Fail closed on ANY mismatch with zero writes. Runs first — a
  // bogus selector must not even reach the watch comparison.
  //
  // Legacy recovery calls (recovery:true WITHOUT a selector — the preservation-gate unit
  // tests) keep the pre-selector behavior: scope + watch-baseline checks with NO selector
  // validation. The real CLI never reaches here without a selector (bin/masterplan.mjs sets
  // recovery:true only when recoverySelector is non-null), so this is a test-only legacy
  // surface, never a silent production fallback.
  const sel = recoverySelector != null
    ? verifyRecoverySelector({
        recoverySelector, WT, MAIN, slug, state, wave, bundleDir,
        watchBaseline,
      })
    : { ok: true, violations: [], repo: null, head: null, base: null };
  if (!sel.ok) {
    return { ok: false, violations: [...violations, ...sel.violations], scope: null, watch: { ok: false, violations: [], checked: false }, wsLoose: [] };
  }
  const committedRecovery = recoverySelector != null;
  const { head: selHead, base: selBase } = sel;

  const declared = canonicalizeScopePaths(
    run.scope ?? declaredScope(state, wave),
    { worktree: WT, mainRoot: MAIN, slug },
  );
  const before = baseline ?? run.baseline ?? [];
  const after = captureMultiRepoFiles(declared, {
    worktree: WT,
    mainRoot: MAIN,
    slug,
    captureWtFiles,
  });
  const scope = verifyScope(declared, before, after);
  if (!scope.ok) {
    violations.push(`recovery preflight: out-of-scope files present (${scope.outOfScope.join(', ')}) — committed recovery must not revert; resolve or exclude them`);
  }

  // Watch-list delta (the same 2b check): a moved HEAD or a non-controller delta in a watched
  // repo is a preservation violation. NO revert is performed — the recovery fails closed.
  //
  // AUTHORITATIVE BASELINE REQUIRED (review finding): the normal record path degrades to a
  // documented no-op when the launch baseline is absent (pre-watch bundles, inline waves) —
  // but COMMITTED recovery is an explicit, opt-in protocol that re-checks the same integrity
  // the wave relied on at launch. The real protocol ALWAYS writes `.wave-<N>.watch.json`
  // before the wave-dispatch record that recovery reads (dispatch-wave acquireAndWatch). A
  // recovery that cannot see that baseline has NO authoritative basis to conclude "no drift",
  // so it must fail closed rather than silently default to success. Absent (missing or
  // unparseable file) and malformed (no/empty snapshots) both reject with zero writes.
  let watch = { ok: true, violations: [], checked: false };
  if (watchBaseline == null) {
    violations.push(`recovery preflight: wave watch baseline is missing or unparseable (${watchBaselinePath(bundleDir, wave)}) — committed recovery requires the launch-time baseline; cannot prove no drift, refusing`);
  } else if (
    !watchBaseline.snapshots ||
    typeof watchBaseline.snapshots !== 'object' ||
    Array.isArray(watchBaseline.snapshots) ||
    Object.keys(watchBaseline.snapshots).length === 0
  ) {
    violations.push(`recovery preflight: wave watch baseline is malformed (no snapshots) at ${watchBaselinePath(bundleDir, wave)} — committed recovery requires the launch-time baseline; cannot prove no drift, refusing`);
  } else {
    // PER-ENTRY STRUCTURAL VALIDATION before snapshotWatchList: a malformed baseline
    // snapshot entry (null / array / missing repo / non-object, or an entry whose
    // repo/prefix/isMain/head/entries do not match what the watch helpers actually emit)
    // must fail closed as a preservation violation — it must NEVER throw out of preflight
    // (a throw would let a corrupt baseline escape the read-only gate). Shape derived from
    // snapshotWatchList/snapshotRepoState in watch-integrity.mjs: success entries are
    // { repo, head, entries, unparsed, prefix, isMain }; a repo that failed to snapshot at
    // launch is recorded as { repo, error, prefix, isMain } and stays valid (the delta
    // check flags it downstream as a watched-repo failure).
    let snapshotsUsable = true;
    for (const [repo, s] of Object.entries(watchBaseline.snapshots)) {
      const problem = validateWatchSnapshotEntry(repo, s);
      if (problem) {
        snapshotsUsable = false;
        violations.push(`recovery preflight: watch baseline snapshot entry ${repo} is malformed (${problem}) — committed recovery requires a structurally valid launch baseline; refusing`);
      }
    }
    if (snapshotsUsable) {
      if (committedRecovery && selHead && selBase) {
        // COMMITTED-RECOVERY COMPARISON: the live edit locus legitimately moved base→head
        // (the recovered commit), so compare against a LOCAL VIEW whose edit-locus entry is
        // re-based to the pinned recovered head. The original baseline file is unchanged;
        // every OTHER watched repo must still be byte-identical to launch.
        const comparison = compareWatchWithRecoveryHead({
          watchBaseline, head: selHead, WT, MAIN, slug, declared, bundleDir,
        });
        if (!comparison.checked) {
          violations.push(...comparison.violations);
        } else {
          watch = { ok: comparison.ok, violations: comparison.violations, checked: true };
          if (!watch.ok) {
            for (const v of comparison.violations) {
              violations.push(`recovery preflight: watch-list violation ${v.repo} ${v.path}: ${v.reason}`);
            }
          }
        }
      } else {
        // Legacy no-selector recovery keeps the ORIGINAL baseline comparison: the edit
        // locus HEAD must NOT have moved (the pre-selector preservation-gate contract).
        const afterSnaps = snapshotWatchList(
          Object.values(watchBaseline.snapshots).map((s) => ({ repo: s.repo, prefix: s.prefix, isMain: s.isMain })),
        );
        const delta = verifyWatchListDelta(watchBaseline.snapshots, afterSnaps, declared, {
          bundle: watchBaseline.bundle ?? null,
          bundleRel: (rel) => path.relative(bundleDir, path.join(MAIN, rel)),
        });
        watch = { ...delta, checked: true };
        if (!watch.ok) {
          for (const v of delta.violations) {
            violations.push(`recovery preflight: watch-list violation ${v.repo} ${v.path}: ${v.reason}`);
          }
        }
      }
    }
  }

  // Committed-delta scope gate: the FULL base→head delta of the recovered commit must be
  // within the wave's original DECLARED scope. The watch comparison above already rejects
  // any working-tree drift, but a recovered commit that TOUCHED a file the wave never
  // scoped to own is clean and committed — it would slip past verifyScope (which only sees
  // the worktree's dirty set). List every committed path and check it against the declared
  // canonical scope.
  if (committedRecovery && selHead && selBase && watchBaseline != null) {
    const oos = outOfScopeCommittedPaths(declared, WT, selBase, selHead);
    for (const p of oos) {
      violations.push(`recovery preflight: recovered commit ${selHead} touched ${p} outside the declared scope (${declared.join(', ') || '(none)'}) — committed recovery must not widen scope`);
    }
  }

  // Workspace-root drift (the same 3b check) — read-only, no unlink. Mirrors the normal
  // transaction's guard: only fires when a wsBaseline was actually captured at launch.
  let wsLoose = [];
  const wsRoot = workspaceRootFor(MAIN);
  if (wsRoot && Array.isArray(run.wsBaseline) && run.wsBaseline.length > 0) {
    const nowEntries = captureWorkspaceRoot(wsRoot);
    const baselineSet = new Set(run.wsBaseline);
    wsLoose = nowEntries.filter((e) => !baselineSet.has(e));
    if (wsLoose.length) {
      violations.push(`recovery preflight: workspace-root drift (${wsLoose.join(', ')}) — committed recovery must not delete; resolve manually`);
    }
  }

  return { ok: violations.length === 0, violations, scope, watch, wsLoose };
}

/**
 * Structural validation for ONE launch watch-baseline snapshot entry, matching the exact
 * shape snapshotWatchList/snapshotRepoState produce (see the in-place comment above).
 *
 * Success entries: `{ repo, head, entries, unparsed, prefix, isMain }` where `head` is a
 * non-empty string and `entries`/`unparsed` are objects/arrays. A launch-snapshot failure
 * is recorded as `{ repo, error, prefix, isMain }` and is still VALID here — it is the
 * delta check's job to turn a real launch failure into a watched-repo violation.
 *
 * @returns {string|null} a human-readable problem description, or null when the entry is
 *                        structurally valid.
 */
function validateWatchSnapshotEntry(repo, s) {
  if (s == null || typeof s !== 'object' || Array.isArray(s)) {
    return `expected an object, got ${s === null ? 'null' : Array.isArray(s) ? 'an array' : typeof s}`;
  }
  if (typeof s.repo !== 'string' || s.repo.length === 0) {
    return 'missing or non-string repo';
  }
  if (s.error !== undefined && typeof s.error !== 'string') {
    return 'error must be a string when present';
  }
  if (s.prefix !== undefined && s.prefix !== null && typeof s.prefix !== 'string') {
    return 'prefix must be a string or null';
  }
  if (typeof s.isMain !== 'boolean') {
    return 'isMain must be a boolean';
  }
  if (s.error === undefined) {
    if (typeof s.head !== 'string' || s.head.length === 0) {
      return 'missing or non-string head';
    }
    if (s.entries == null || typeof s.entries !== 'object' || Array.isArray(s.entries)) {
      return 'entries must be an object';
    }
    if (s.unparsed === undefined) {
      return 'missing unparsed array';
    }
    if (!Array.isArray(s.unparsed)) {
      return 'unparsed must be an array';
    }
    // Per-path entries mirror snapshotRepoState: { xy: <status code>, hash: <hex|null> }.
    for (const [p, e] of Object.entries(s.entries)) {
      if (e == null || typeof e !== 'object' || Array.isArray(e)) {
        return `entry ${p} must be an object, got ${e === null ? 'null' : 'non-object'}`;
      }
      if (typeof e.xy !== 'string' || e.xy.length === 0) {
        return `entry ${p} has a missing or non-string xy`;
      }
      if (e.hash !== undefined && e.hash !== null && typeof e.hash !== 'string') {
        return `entry ${p} hash must be a string or null`;
      }
    }
  }
  return null;
}