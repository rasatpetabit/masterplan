// Other repositories share the run's branch_finish answer, but not its verification/deploy gates.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGit } from './watch-integrity.mjs';
import { detectBase, mergedTree } from './finish.mjs';
import { runLoci } from './dispatch/multi-repo.mjs';

function refTip({ main, branch }) {
  try { return runGit(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); }
  catch { return null; }
}
function ancestor(main, tip, target) {
  if (!tip || !target) return false;
  try { runGit(main, ['merge-base', '--is-ancestor', tip, target]); return true; }
  catch { return false; }
}
function retirement(locus, events) {
  return [...events].reverse().find((e) => e.main === locus.main && e.branch === locus.branch
    && (e.type === 'locus_finish_intent' || e.type === 'locus_finish') && e.merge_sha) ?? null;
}
function detectedBase(main) {
  return detectBase(runGit(main, ['branch', '--format=%(refname:short)']));
}
function unavailable(locus) {
  return { unavailable: true, reason: `branch tip cannot be resolved through refs/heads/${locus.branch} and no landing is recorded` };
}
function gitDir(main) {
  return runGit(main, ['rev-parse', '--absolute-git-dir']);
}

// NUL-delimited names preserve spaces/newlines. Include index AND worktree dirt, and
// both sides of renames: every path the merge could replace must be protected.
// A merge in progress belongs to this call only when MERGE_HEAD names the tip this call merged: an operator merge
// that starts between the preflight and our `git merge` (which then refuses) must never be aborted by us.
export function ownsMergeInProgress(main, tip) {
  try {
    const heads = fs.readFileSync(path.join(gitDir(main), 'MERGE_HEAD'), 'utf8').split('\n').filter(Boolean);
    return heads.length === 1 && heads[0] === tip;
  } catch { return false; }
}

function mainCheckoutErrors(main, base, tip) {
  const dir = gitDir(main);
  const errors = [];
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
    if (fs.existsSync(path.join(dir, marker))) errors.push(`main checkout has an operation in progress: ${marker}`);
  }
  if (base && tip) {
    // runGit trims leading whitespace, which can be part of the first filename.
    const names = (args) => String(execFileSync('git', ['-C', main, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).split('\0').filter(Boolean);
    const changed = names(['diff', '--name-only', '--no-renames', '-z', `refs/heads/${base}`, tip]);
    const dirty = new Set([
      ...names(['diff', '--name-only', '--no-renames', '-z']),
      ...names(['diff', '--cached', '--name-only', '--no-renames', '-z']),
      ...names(['ls-files', '--others', '--exclude-standard', '-z']),
      // git merge treats ignored files as expendable and overwrites them; look only at the merge's own paths.
      ...(changed.length ? names(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...changed]) : []),
    ]);
    const overlaps = [...dirty].filter((p) => changed.some((c) => p === c || p.startsWith(`${c}/`) || c.startsWith(`${p}/`)));
    if (overlaps.length) errors.push(`main checkout has uncommitted changes at merge paths: ${overlaps.join(', ')}`);
  }
  return errors;
}

// Read-only gate facts. Even absent, unrecorded refs remain visible and fail closed.
export function finishLocusFacts(state, opts, events = []) {
  return runLoci(state, opts).map((locus) => {
    const tip = refTip(locus);
    const record = retirement(locus, events);
    const branch_tip = tip ?? record?.branch_tip ?? null;
    const base = detectedBase(locus.main);
    const ahead = base && branch_tip ? Number(runGit(locus.main, ['rev-list', '--count', `refs/heads/${base}..${branch_tip}`])) : null;
    const wt_dirty = fs.existsSync(locus.wt) ? !!runGit(locus.wt, ['status', '--porcelain']) : false;
    return { main: locus.main, wt: locus.wt, branch: locus.branch,
      base, branch_tip, ahead, wt_dirty, landed: ancestor(locus.main, branch_tip, base && `refs/heads/${base}`),
      ...(!tip && !record ? unavailable(locus) : {}) };
  });
}

// Check ALL repositories, including the run branch, before the first merge or ledger write.
// Success returns the verified ref/tip/base per main; failure retains the dispatch-error string.
// Already-landed tips may be in any teardown prefix, including absent worktree and ref.
export function preflightFinishLoci(loci, events) {
  const failures = [];
  const verified = new Map();
  for (const locus of loci) {
    const errors = [];
    try {
      const tip = refTip(locus);
      const record = retirement(locus, events);
      if (record && tip && record.branch_tip !== tip) errors.push('branch tip differs from the recorded landing');
      const landedTip = tip ?? record?.branch_tip ?? locus.branch_tip;
      const base = detectedBase(locus.main);
      verified.set(locus.main, { tip: landedTip ?? null, ref_tip: tip, base });
      errors.push(...mainCheckoutErrors(locus.main, base, landedTip));
      const landed = ancestor(locus.main, landedTip, locus.run ? 'HEAD' : base && `refs/heads/${base}`);
      if (record && !landed) errors.push('recorded landing is no longer an ancestor of the detected base');
      if (landed && !errors.length) continue;
      // Preserve the existing run branch's legacy full-teardown replay (no remaining ref/path).
      if (locus.run && !tip && !fs.existsSync(locus.wt) && !landedTip && !errors.length) continue;
      const head = runGit(locus.main, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!base || head !== base) errors.push(`merge target mismatch: main has '${head}' checked out but detected base is '${base ?? 'unknown'}'`);
      if (!locus.run && fs.existsSync(locus.wt) && runGit(locus.wt, ['status', '--porcelain'])) errors.push(`worktree has uncommitted changes: ${locus.wt}`);
      if (!tip) errors.push(`branch tip cannot be resolved through refs/heads/${locus.branch}`);
      if (tip && base) {
        const result = mergedTree(locus.main, `refs/heads/${base}`, tip);
        if (result.unsupported) errors.push(result.unsupported);
        if (result.conflict) errors.push(`merge of ${locus.branch} into ${base} has conflicts`);
      }
    } catch (e) { errors.push(e.message); }
    if (errors.length) failures.push(`${locus.main}: ${errors.join('; ')}`);
  }
  return failures.length ? `finish preflight failed:\n${failures.join('\n')}` : verified;
}

// Called after the run merge (before its teardown), or after its discard/keep handling.
// A successful intent precedes destructive teardown; every crash prefix is replayable.
export function finishOtherLoci(ctx, loci, events, append, verified = new Map()) {
  for (const locus of loci) {
    const { main, wt, branch } = locus;
    const prior = retirement(locus, events);
    const currentTip = refTip(locus);
    const checked = verified.get(main);
    const tip = ctx.choice === 'merge' ? checked?.tip : currentTip ?? prior?.branch_tip ?? null;
    if (ctx.choice === 'merge' && (!checked || currentTip !== checked.ref_tip)) return `${main}: branch tip moved since preflight; re-enter to preflight again`;
    const last = [...events].reverse().find((e) => e.type === 'locus_finish' && e.main === main && e.branch === branch);
    if (last && last.note === ctx.choice && (ctx.choice === 'keep' || (last.removed && !fs.existsSync(wt) && !currentTip))) {
      if (ctx.choice !== 'keep') runGit(main, ['worktree', 'prune']);
      continue;
    }
    let merge_sha = prior?.merge_sha ?? null;
    if (ctx.choice === 'merge') {
      if (prior && tip !== prior.branch_tip) return `${main}: branch tip differs from the recorded landing`;
      if (!tip) return `${main}: branch tip cannot be resolved through refs/heads/${branch}`;
      const baseRef = checked.base && `refs/heads/${checked.base}`;
      if (ancestor(main, tip, baseRef)) {
        if (!merge_sha) {
          // Recover the actual first-parent landing ON THE BASE, never another checkout's HEAD.
          const line = runGit(main, ['rev-list', '--first-parent', baseRef]).split('\n');
          merge_sha = line.includes(tip) ? tip
            : runGit(main, ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${tip}..${baseRef}`]).split('\n')[0];
          if (!merge_sha) return `${main}: cannot recover the landing of ${tip}`;
        }
      } else {
        if (prior) return `${main}: recorded landing is no longer an ancestor of the detected base`;
        const head = runGit(main, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (!checked.base || head !== checked.base) return `${main}: merge target mismatch: main has '${head}' checked out but detected base is '${checked.base ?? 'unknown'}'`;
        const mergingBefore = fs.existsSync(path.join(gitDir(main), 'MERGE_HEAD'));
        try { runGit(main, ['merge', '--no-edit', '-m', `Merge branch '${branch}'`, tip]); }
        catch (e) {
          if (!mergingBefore && ownsMergeInProgress(main, tip)) {
            try { runGit(main, ['merge', '--abort']); } catch { /* preserve the merge failure */ }
          }
          return `${main}: merge of ${branch} failed: ${e.message}`;
        }
      }
      merge_sha ??= runGit(main, ['rev-parse', baseRef]).trim();
      if (!prior) append({ type: 'locus_finish_intent', main, branch, branch_tip: tip, merge_sha });
    }
    let removed = false;
    if (ctx.choice === 'merge' || ctx.choice === 'discard') {
      try {
        if (fs.existsSync(wt)) {
          runGit(main, ['worktree', 'remove', ...(ctx.choice === 'discard' || ctx.removalForce ? ['--force'] : []), wt]);
        } else runGit(main, ['worktree', 'prune']);
        if (refTip(locus)) runGit(main, ['branch', ctx.choice === 'discard' ? '-D' : '-d', branch]);
        removed = true;
      } catch (e) { return `${main}: teardown of ${wt} failed: ${e.message}`; }
    }
    append({ type: 'locus_finish', main, branch, branch_tip: tip, ...(merge_sha ? { merge_sha } : {}),
      ...(!currentTip && !prior ? unavailable(locus) : {}), removed, note: ctx.choice });
  }
  return null;
}
