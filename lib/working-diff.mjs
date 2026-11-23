// Shared canonical ordinary review artifact capture.
import { execFileSync } from 'node:child_process';
import { sha256hex } from './canonical.mjs';
import { gitEnv } from './config.mjs';

// Share base selection, artifact bytes and hashing across both review phases
// and the recorder. A cache is local to a single capture pass, never re-used at
// final authorization: the reviews must still match the live working bytes.
export function captureWorkingReview(task, context, cache) {
  const base = task.base_sha ?? context.base_sha;
  const key = JSON.stringify([task.repo, base]);
  if (!cache.has(key)) {
    const diff = captureFullWorkingDiff(task.repo, undefined, base ?? 'HEAD');
    cache.set(key, { base, diff, sha: sha256hex(diff) });
  }
  return cache.get(key);
}

/**
 * Capture a repo's FULL working diff: tracked changes vs base plus every
 * untracked file rendered via `git diff --no-index /dev/null <f>` (exit 1 is
 * the "differs" success case). Deliberately NOT filtered to any declared
 * scope — an out-of-scope write must be IN the review payload; scope
 * enforcement stays with recordWaveResult's D6 verify-scope, never the review.
 * Review execution is harness-native (adversary class descriptors); masterplan
 * captures the payload and records the review through reviewCompletedTasks.
 */
export function captureFullWorkingDiff(repo, _exec = execFileSync, base = 'HEAD') {
  const git = artifactGit(repo, _exec);
  const tracked = git(['diff', base]);
  // -z + NUL split: newline-split output C-quotes paths carrying quotes/tabs/
  // newlines (even under core.quotePath=false), and a quoted literal handed to
  // `diff --no-index` ENOENTs. NUL termination disables quoting entirely.
  const untracked = git(['ls-files', '-z', '-o', '--exclude-standard']).split('\0').filter(Boolean);
  return assembleArtifact(tracked, untracked, (f) => git(['diff', '--no-index', '--', '/dev/null', f], true));
}

// Both capture and object-only reconstruction use the same invocation, byte
// handling and layout: one tracked section, then one diff per untracked path.
function artifactGit(repo, _exec) {
  return (args, allowExit1 = false) => {
    try {
      return String(_exec('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
        encoding: 'utf8', env: gitEnv({}, undefined, { stripIndex: true }), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (err) {
      if (allowExit1 && err.status === 1 && err.stdout != null) return String(err.stdout);
      const stderr = String(err?.stderr ?? '').trim();
      throw new Error(`captureFullWorkingDiff: git -C ${repo} ${args.join(' ')} failed: ${stderr || err.message}`);
    }
  };
}

function assembleArtifact(tracked, additions, render) {
  return tracked + additions.map(render).join('');
}

/** Rebuild an ordinary review artifact from commits only; never touches the index/WT. */
export function rebuildFullWorkingDiff(repo, base, head, _exec = execFileSync) {
  const git = artifactGit(repo, _exec);
  // Classify tree additions WITHOUT rename detection: an untracked file was
  // never eligible to pair with a tracked deletion in captureFullWorkingDiff.
  const paths = (filter) => git(['diff', '--no-renames', '--name-only', '-z',
    `--diff-filter=${filter}`, base, head]).split('\0').filter(Boolean);
  const tracked = paths('a');
  const additions = paths('A').sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  // Literal pathspecs preserve spaces, tabs, newlines and pathspec metacharacters.
  // Keep Git's default rename/quoting behaviour WITHIN the tracked section.
  const diff = (files) => git(['--literal-pathspecs', 'diff', base, head, '--', ...files]);
  return assembleArtifact(tracked.length ? diff(tracked) : '', additions, (f) => diff([f]));
}
