// An observed native retry inherits the wave's launch authority, but only its
// dispatched tasks can use it. The wave scope remains the D6/amendment boundary.
import fs from 'node:fs';
import path from 'node:path';
import { sha256hex } from './canonical.mjs';
import { pathWithinDeclaredScope } from './declared-scope.mjs';
import { canonicalizeScopePaths } from './dispatch/multi-repo.mjs';
import { readScopeEvents } from './scope-authorization.mjs';
import { parsePorcelainV2Entry, runGit } from './watch-integrity.mjs';

export function retryStatus(repo) {
  const status = runGit(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--no-renames', '--untracked-files=all']);
  return status.split('\0').filter(Boolean).map((line) => {
    const entry = parsePorcelainV2Entry(line);
    if (!entry) throw new Error(`cannot establish retry path ownership in ${repo}`);
    return { ...entry, line };
  });
}

// The raw porcelain entry includes the staged blob and mode; hashing only WT
// bytes would miss an index-only change hidden by a different working copy.
export function retryPathFingerprint(repo, { path: rel, line }) {
  const abs = path.join(repo, rel);
  try {
    const stat = fs.lstatSync(abs);
    const bytes = stat.isSymbolicLink() ? fs.readlinkSync(abs, { encoding: 'buffer' })
      : stat.isFile() ? fs.readFileSync(abs) : null;
    return bytes == null ? null : sha256hex(JSON.stringify([line, stat.mode, sha256hex(bytes)]));
  } catch (err) {
    return err.code === 'ENOENT' ? sha256hex(JSON.stringify([line, null])) : null;
  }
}

export function completedRetryFiles(state, wave, existing, loci) {
  const done = (state.tasks ?? []).filter((t) => t.wave === wave && t.status === 'done');
  const ids = new Set(done.map((t) => String(t.id)));
  return canonicalizeScopePaths([
    ...done.flatMap((t) => t.files ?? []),
    ...[existing, ...(existing?.history ?? [])].flatMap((attempt) =>
      (attempt?.payload ?? []).filter((t) => ids.has(String(t.id))).flatMap((t) => t.files ?? [])),
  ], loci);
}

export function retryTaskScopes(statePath, state, record, loci) {
  if (!record?.retry_launch) return null;
  const { scope_event_cursor: cursor } = record.retry_launch;
  const events = readScopeEvents(statePath);
  if (!Array.isArray(record.payload) || !Number.isInteger(cursor) || cursor < 0 || cursor > events.length)
    throw new Error('record-result: missing retry declarations or amendment boundary');
  const amendments = events.slice(cursor).filter((e) => ['plan_amended', 'tasks_amended'].includes(e.type));
  return new Map(record.payload.map((launched) => {
    const id = String(launched.id);
    const current = state.tasks?.find((t) => String(t.id) === id && t.wave === record.wave);
    const files = canonicalizeScopePaths(launched.files, loci);
    const declared = canonicalizeScopePaths(current?.files, loci);
    if (declared.some((file) => !pathWithinDeclaredScope(file, files)) && amendments.some((e) =>
      e.task_files?.some((t) => String(t.id) === id && t.wave === record.wave &&
        JSON.stringify(canonicalizeScopePaths(t.files, loci)) === JSON.stringify(declared)))) {
      files.push(...declared);
    }
    return [id, files];
  }));
}
