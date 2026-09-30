// Shared canonical ordinary review artifact capture.
import { execFileSync } from 'node:child_process';

/**
 * Capture a repo's FULL working diff: tracked changes vs HEAD plus every
 * untracked file rendered via `git diff --no-index /dev/null <f>` (exit 1 is
 * the "differs" success case). Deliberately NOT filtered to any declared
 * scope — an out-of-scope write must be IN the review payload; scope
 * enforcement stays with recordWaveResult's D6 verify-scope, never the review.
 * Review execution is harness-native (adversary class descriptors); masterplan
 * captures the payload and records the review through reviewCompletedTasks.
 */
export function captureFullWorkingDiff(repo, _exec = execFileSync, base = 'HEAD') {
  const git = (args, allowExit1 = false) => {
    try {
      return String(_exec('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (err) {
      if (allowExit1 && err.status === 1 && err.stdout != null) return String(err.stdout);
      const stderr = String(err?.stderr ?? '').trim();
      throw new Error(`captureFullWorkingDiff: git -C ${repo} ${args.join(' ')} failed: ${stderr || err.message}`);
    }
  };
  let out = git(['diff', base]);
  // -z + NUL split: newline-split output C-quotes paths carrying quotes/tabs/
  // newlines (even under core.quotePath=false), and a quoted literal handed to
  // `diff --no-index` ENOENTs. NUL termination disables quoting entirely.
  const untracked = git(['ls-files', '-z', '-o', '--exclude-standard']).split('\0').filter(Boolean);
  for (const f of untracked) {
    out += git(['diff', '--no-index', '--', '/dev/null', f], true);
  }
  return out;
}

