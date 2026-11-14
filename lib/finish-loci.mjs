// Other repositories share the run's branch_finish answer, but not its verification/deploy gates.
import fs from 'node:fs';
import { runGit } from './watch-integrity.mjs';
import { detectBase, mergedTree } from './finish.mjs';
import { runLoci } from './dispatch/multi-repo.mjs';

function refTip({ main, branch }) {
  try { return runGit(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); }
  catch { return null; }
}
function ancestor(main, tip) {
  try { runGit(main, ['merge-base', '--is-ancestor', tip, 'HEAD']); return true; }
  catch { return false; }
}
function retirement(locus, events) {
  return [...events].reverse().find((e) => e.main === locus.main && e.branch === locus.branch
    && (e.type === 'locus_finish_intent' || e.type === 'locus_finish') && e.merge_sha) ?? null;
}

// Read-only gate facts. Deleted refs remain visible through the landing identity in the ledger.
export function finishLocusFacts(state, opts, events = []) {
  return runLoci(state, opts).flatMap((locus) => {
    const tip = refTip(locus);
    const record = retirement(locus, events);
    if (!tip && !record) return [];
    const branch_tip = tip ?? record.branch_tip;
    const base = detectBase(runGit(locus.main, ['branch', '--format=%(refname:short)']));
    const ahead = base ? Number(runGit(locus.main, ['rev-list', '--count', `${base}..${branch_tip}`])) : null;
    const wt_dirty = fs.existsSync(locus.wt) ? !!runGit(locus.wt, ['status', '--porcelain']) : false;
    return [{ main: locus.main, wt: locus.wt, branch: locus.branch,
      base, branch_tip, ahead, wt_dirty, landed: ancestor(locus.main, branch_tip) }];
  });
}

// Check ALL repositories, including the run branch, before the first merge or ledger write.
// Already-landed tips may be in any teardown prefix, including absent worktree and ref.
export function preflightFinishLoci(loci, events) {
  const failures = [];
  for (const locus of loci) {
    const errors = [];
    try {
      const tip = refTip(locus);
      const record = retirement(locus, events);
      if (record && tip && record.branch_tip !== tip) errors.push('branch tip differs from the recorded landing');
      const landedTip = tip ?? record?.branch_tip ?? locus.branch_tip;
      const landed = landedTip && ancestor(locus.main, landedTip);
      if (record && !landed) errors.push('recorded landing is no longer an ancestor of main HEAD');
      if (landed && !errors.length) continue;
      // Preserve the existing run branch's legacy full-teardown replay (no remaining ref/path).
      if (locus.run && !tip && !fs.existsSync(locus.wt) && !landedTip) continue;
      const base = detectBase(runGit(locus.main, ['branch', '--format=%(refname:short)']));
      const head = runGit(locus.main, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!base || head !== base) errors.push(`merge target mismatch: main has '${head}' checked out but detected base is '${base ?? 'unknown'}'`);
      if (fs.existsSync(locus.wt) && runGit(locus.wt, ['status', '--porcelain'])) errors.push(`worktree has uncommitted changes: ${locus.wt}`);
      if (!tip) errors.push(`branch tip cannot be resolved through refs/heads/${locus.branch}`);
      if (tip && base) {
        const result = mergedTree(locus.main, base, tip);
        if (result.unsupported) errors.push(result.unsupported);
        if (result.conflict) errors.push(`merge of ${locus.branch} into ${base} has conflicts`);
      }
    } catch (e) { errors.push(e.message); }
    if (errors.length) failures.push(`${locus.main}: ${errors.join('; ')}`);
  }
  return failures.length ? `finish preflight failed:\n${failures.join('\n')}` : null;
}

// Called after the run merge (before its teardown), or after its discard/keep handling.
// A successful intent precedes destructive teardown; every crash prefix is replayable.
export function finishOtherLoci(ctx, loci, events, append) {
  for (const locus of loci) {
    const { main, wt, branch } = locus;
    const prior = retirement(locus, events);
    const tip = refTip(locus) ?? prior?.branch_tip ?? null;
    const last = [...events].reverse().find((e) => e.type === 'locus_finish' && e.main === main && e.branch === branch);
    if (last && last.note === ctx.choice && (ctx.choice === 'keep' || (last.removed && !fs.existsSync(wt) && !refTip(locus)))) {
      if (ctx.choice !== 'keep') runGit(main, ['worktree', 'prune']);
      continue;
    }
    let merge_sha = prior?.merge_sha ?? null;
    if (ctx.choice === 'merge') {
      if (prior && tip !== prior.branch_tip) return `${main}: branch tip differs from the recorded landing`;
      if (!tip) return `${main}: branch tip cannot be resolved through refs/heads/${branch}`;
      if (ancestor(main, tip)) {
        if (!merge_sha) {
          // Recover the actual first-parent landing, not later commits added after the crash.
          const line = runGit(main, ['rev-list', '--first-parent', 'HEAD']).split('\n');
          merge_sha = line.includes(tip) ? tip
            : runGit(main, ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${tip}..HEAD`]).split('\n')[0];
          if (!merge_sha) return `${main}: cannot recover the landing of ${tip}`;
        }
      } else {
        if (prior) return `${main}: recorded landing is no longer an ancestor of main HEAD`;
        try { runGit(main, ['merge', '--no-edit', '-m', `Merge branch '${branch}'`, tip]); }
        catch (e) {
          try { runGit(main, ['merge', '--abort']); } catch { /* nothing to abort */ }
          return `${main}: merge of ${branch} failed: ${e.message}`;
        }
      }
      merge_sha ??= runGit(main, ['rev-parse', 'HEAD']).trim();
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
    append({ type: 'locus_finish', main, branch, branch_tip: tip, ...(merge_sha ? { merge_sha } : {}), removed, note: ctx.choice });
  }
  return null;
}
