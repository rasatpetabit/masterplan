// Local write-ahead record for wave completion. Never stage it, and never
// substitute caller-supplied results/receipts for an authorized transaction.
import fs from 'node:fs';
import path from 'node:path';
import { appendPreparedEventBytes } from './bundle.mjs';
import { sha256hex } from './canonical.mjs';
import { retryPathFingerprint, retryStatus } from './retry-scope.mjs';
import { runGit, stripControllerTransactionFiles } from './watch-integrity.mjs';

export const RECORDING_FILE = '.wave-recording.json';
const journalPath = (statePath) => path.join(path.dirname(statePath), RECORDING_FILE);
export const hasWaveRecording = (statePath) => fs.existsSync(journalPath(statePath));
export const recordingKey = (value) => sha256hex(JSON.stringify(value));

export function readWaveRecording(statePath) {
  try {
    const recording = JSON.parse(fs.readFileSync(journalPath(statePath), 'utf8'));
    if (recording?.schema !== 1) throw new Error('record-result: unrecognized interrupted recording; inspect the recording journal');
    return recording;
  } catch (err) { if (err.code !== 'ENOENT') throw err; return null; }
}

export function saveWaveRecording(statePath, recording) {
  const file = journalPath(statePath);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(recording), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

export function finishWaveRecording(statePath) {
  fs.unlinkSync(journalPath(statePath));
}

function readEvents(statePath) {
  try { return fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; return Buffer.alloc(0); }
}

export function recordingEventStart(statePath) {
  const bytes = readEvents(statePath);
  if (bytes.length && bytes.at(-1) !== 10) throw new Error('record-result: events.jsonl does not end with a newline');
  return { size: bytes.length, sha: sha256hex(bytes) };
}

// Both the original ledger and the appended prefix must match. In particular,
// the same projected event is never appended again just because state lagged.
export function recordingEventSuffix(statePath, { eventStart, reviewLines, tail }) {
  const bytes = readEvents(statePath);
  const { size, sha } = eventStart;
  const expected = Buffer.from(reviewLines + (tail?.lines ?? ''));
  const current = bytes.subarray(size);
  if (bytes.length < size || sha256hex(bytes.subarray(0, size)) !== sha ||
      !current.equals(expected.subarray(0, current.length))) {
    throw new Error('record-result: events.jsonl changed across the interrupted recording');
  }
  return expected.subarray(current.length);
}

export function appendRecordingSuffix(statePath, bytes) {
  if (bytes.length) appendPreparedEventBytes(statePath, bytes);
}

// Deterministic Git refusals are preflighted before the transaction is durable.
// Commands that depend on later I/O (locks, hooks, disk, etc.) still run normally.
export function preflightRecordingCommit(repo, paths, { literal = false } = {}) {
  for (const [marker, action] of [['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']]) {
    const file = runGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', marker]);
    if (fs.existsSync(file)) throw new Error(`record-result: cannot commit paths during ${action} in ${repo}`);
  }
  if (runGit(repo, ['ls-files', '--unmerged'])) throw new Error(`record-result: cannot commit with unmerged paths in ${repo}`);
  runGit(repo, ['var', 'GIT_AUTHOR_IDENT']);
  runGit(repo, ['var', 'GIT_COMMITTER_IDENT']);
  runGit(repo, ['--no-optional-locks', ...(literal ? ['--literal-pathspecs'] : []), 'add', '--dry-run', '--', ...paths]);
}

const checkoutFingerprint = (repo, entry) => retryPathFingerprint(repo, { ...entry, line: '' });
const stageFingerprint = ({ line }) => {
  const [, , , , mode, , , blob] = line.split(' ', 8);
  return `${mode ?? ''} ${blob ?? ''}`;
};
const dirty = (repo, bundleDir) => retryStatus(repo).filter((e) =>
  stripControllerTransactionFiles([e.path], { bundleDir, worktree: repo }).length);

export function captureRecordingLoci(repos, bundleDir) {
  return [...new Set(repos)].map((repo) => ({ repo, head: runGit(repo, ['rev-parse', 'HEAD']),
    gitDir: runGit(repo, ['rev-parse', '--absolute-git-dir']), dirty: dirty(repo, bundleDir).map((e) => ({ path: e.path, xy: e.xy, index: stageFingerprint(e),
      fingerprint: retryPathFingerprint(repo, e), work: checkoutFingerprint(repo, e) })),
  }));
}

// A commit whose success was not checkpointed may be visible at HEAD. Accept
// only the planned single parent / message / path delta, and require the same
// accepted worktree bytes as well (checked below, even for now-clean paths).
export function recordingCommitAtHead(repo, head, parent, message, allows) {
  return head !== parent && runGit(repo, ['rev-list', '--parents', '-n', '1', head]) === `${head} ${parent}` &&
    runGit(repo, ['show', '-s', '--format=%s', head]) === message &&
    runGit(repo, ['diff', '--name-only', '--no-renames', '-z', parent, head]).split('\0').filter(Boolean).every(allows);
}

export function checkRecordingLoci(recording, bundleDir) {
  const { snapshots, cleanup, stagePlan, codeMessage, MAIN, stateMessage, tail } = recording;
  for (const { repo, head, gitDir, dirty: saved } of snapshots) {
    const fail = (file) => { throw new Error(`record-result: artifact episode evidence mismatch in ${repo}${file ? ` (${file})` : ''}; checkout changed across the interrupted recording`); };
    if (runGit(repo, ['rev-parse', '--absolute-git-dir']) !== gitDir) fail('Git directory');
    const stage = new Set(stagePlan.find(([root]) => root === repo)?.[1] ?? []);
    const cleanupOps = cleanup.filter(({ repo: root }) => root === repo);
    const checkout = new Set(cleanupOps.flatMap((op) => op.checkout));
    const clean = new Set(cleanupOps.flatMap((op) => op.clean));
    const liveHead = runGit(repo, ['rev-parse', 'HEAD']);
    const stateParent = tail?.mainHead;
    const bundleRel = path.relative(MAIN, bundleDir);
    const underBundle = (file) => !bundleRel || file.startsWith(`${bundleRel}/`);
    const stateCommitted = repo === MAIN && stateParent &&
      recordingCommitAtHead(repo, liveHead, stateParent, stateMessage, underBundle);
    const codeHead = stateCommitted ? stateParent : liveHead;
    const committed = codeHead !== head && stage.size && (tail?.commits.code_by_repo[repo] === codeHead ||
      recordingCommitAtHead(repo, codeHead, head, codeMessage, (file) => stage.has(file)));
    if (codeHead !== head && !committed) fail('HEAD');
    const live = new Map(dirty(repo, bundleDir).map((e) => [e.path, e]));
    for (const entry of saved) {
      const file = entry.path;
      const current = live.get(file);
      live.delete(file);
      if (stage.has(file)) {
        if ((committed && current) || checkoutFingerprint(repo, { path: file }) !== entry.work) fail(file);
      } else if (stateCommitted && underBundle(file) && !current &&
          checkoutFingerprint(repo, { path: file }) === entry.work) {
        continue; // MAIN's bundle commit may also stage existing non-controller files.
      } else if ((checkout.has(file) || clean.has(file)) && !current) {
        continue; // Controller cleanup reached this path already.
      } else if (current && checkout.has(file) && current.xy.endsWith('.') &&
          current.xy[0] === entry.xy[0] && stageFingerprint(current) === entry.index) {
        continue; // Checkout from index preserves an earlier staged edit.
      } else if (!current || retryPathFingerprint(repo, current) !== entry.fingerprint) {
        fail(file);
      }
    }
    if (live.size) fail(live.keys().next().value);
  }
}
