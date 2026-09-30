// Shared fail-closed episode eligibility at ingestion and durable recording.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalRepoIdentity } from './recovery-controller.mjs';

export function assertPrimaryBundle(statePath, state) {
  const bundleDir = path.dirname(path.resolve(statePath));
  // Derive the physical destination independently of the possibly redirected
  // bundle path. Resolving `expected` itself would bless a symlink into a stale WT.
  const main = fs.realpathSync(path.dirname(canonicalRepoIdentity(bundleDir).commonDir));
  const slug = state.slug;
  const expected = path.join(main, 'docs', 'masterplan', typeof slug === 'string' ? slug : '');
  const expectedState = path.join(expected, 'state.yml');
  if (typeof slug !== 'string' || !slug || slug === '.' || slug === '..' || path.basename(slug) !== slug ||
      bundleDir !== expected || fs.realpathSync(bundleDir) !== expected ||
      path.resolve(statePath) !== expectedState || fs.lstatSync(statePath).isSymbolicLink() ||
      fs.realpathSync(statePath) !== expectedState) {
    throw new Error('review episode: only the primary bundle owner may read or write dispositions (stale worktree copy refused)');
  }
  return { bundleDir, main };
}

export function episodeSubject(main, bundleDir, wave, taskId, suffix = '') {
  return `${main}::${path.relative(main, bundleDir)}/wave-${wave}/task-${taskId}${suffix}`;
}

export function assertCanonicalRestart(episode, { main, bundleDir, wave }, taskId) {
  const disposition = episode?.disposition;
  if (disposition?.kind !== 'restart') return;
  const subject = episodeSubject(main, bundleDir, wave, taskId, '/restart-1');
  const lineage = disposition.lineage;
  if (disposition.subject !== subject || disposition.subject === episode.subject ||
      !lineage || typeof lineage !== 'object' || Array.isArray(lineage) ||
      Object.keys(lineage).length !== 2 || lineage.wave !== wave || lineage.task_id !== taskId) {
    throw new Error(`review episode task ${taskId}: invalid restart subject or lineage; refusing dispatch`);
  }
}

export function reviewEpisodeIntent(record, taskId, challenge, slot) {
  const episode = record?.review_context?.episodes?.[String(taskId)];
  if (!episode || typeof episode !== 'object' || Array.isArray(episode)) throw new Error(`review episode task ${taskId}: no identifiable entry in active-episode receipt; refusing dispatch`);
  if (episode.disposition?.kind === 'retire') throw new Error(`review episode task ${taskId}: retired as not reviewed; refusing dispatch`);
  if ((episode.hold || !episode.subject) && episode.disposition?.kind !== 'restart')
    throw new Error(`review episode task ${taskId}: subjectless hold; refusing dispatch without an identifiable migration entry`);
  if (episode.disposition && !['restart', 'retire'].includes(episode.disposition.kind))
    throw new Error(`review episode task ${taskId}: unknown disposition; refusing dispatch`);
  assertCanonicalRestart(episode, slot, taskId);
  return { ...challenge, subject: episode.disposition?.subject ?? episode.subject,
    stakes: episode.stakes === 'critical' ? 'critical' : 'consequential',
    ...(episode.raiseTier !== undefined ? { raiseTier: episode.raiseTier } : {}),
    ...(episode.raiseEffort !== undefined ? { raiseEffort: episode.raiseEffort } : {}),
    ...(episode.independentOf !== undefined ? { independentOf: episode.independentOf } : {}),
    ...(episode.noSubstitute ? { noSubstitute: true } : {}),
    blocking: true };
}

/** Only new restart subjects are evidence keys; historical subjects are never imported. */
export function restartedEpisodeSubject(record, taskId) {
  const disposition = record?.review_context?.episodes?.[String(taskId)]?.disposition;
  return disposition?.kind === 'restart' ? disposition.subject : null;
}

export function assertEpisodeReviewBinding(record, taskId, review) {
  const subject = restartedEpisodeSubject(record, taskId);
  if (subject && review?.episode_subject !== subject) {
    throw new Error(`review episode task ${taskId}: episode subject mismatch; fresh restarted-episode review required`);
  }
}

/** Read-only completion count: retirement/HOLD/unlinked work is never reviewed. */
export function taskEpisodeEligibleForCompletion(statePath, state, task) {
  try {
    const recordPath = path.join(path.dirname(path.resolve(statePath)), `wave-${task.wave}.dispatch.json`);
    let record;
    try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return true; throw err; }
    if (!record?.review_context?.enabled) return true; // pre-episode/disabled compatibility
    reviewEpisodeIntent(record, task.id, {}, { ...assertPrimaryBundle(statePath, state), wave: task.wave });
    return true;
  } catch { return false; } // status cannot bless an unreadable or ineligible episode
}
