// Controller-only widening of the launch allow-set. A mutable task list alone
// never authorizes recording; the append-only amendment log supplies the proof.
import fs from 'node:fs';
import path from 'node:path';
import { declaredScope } from './wave.mjs';
import { pathWithinDeclaredScope } from './declared-scope.mjs';
import { canonicalizeScopePaths } from './dispatch/multi-repo.mjs';
import { runGit } from './watch-integrity.mjs';

export function readScopeEvents(statePath) {
  let text;
  try { text = fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  // An incomplete/corrupt log is not authority for a scope mutation.
  return text.split('\n').filter(s => s.trim()).map(JSON.parse);
}

export function scopeContext(statePath, state) {
  const mainRoot = path.dirname(runGit(path.dirname(path.resolve(statePath)),
    ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const slug = String(state.slug ?? '');
  return { mainRoot, slug, worktree: path.resolve(state.worktree ?? path.join(mainRoot, '.worktrees', slug)) };
}

const isTaskFileAmendment = event => ['plan_amended', 'tasks_amended'].includes(event?.type);

// Cache key for canonicalizeScopePaths. Non-arrays all canonicalize to []; string
// elements keep their bytes (a NUL cannot occur in a path, so the separator is safe).
function scopePathMemoKey(files) {
  if (!Array.isArray(files)) return '\u0000';
  return files.map((file) => (typeof file === 'string' ? `\u0002${file}` : `\u0001${typeof file}:${String(file)}`)).join('\u0000');
}

function memoizedScopePaths(cache, files, context) {
  const key = scopePathMemoKey(files);
  if (cache.has(key)) return cache.get(key);
  const canon = canonicalizeScopePaths(files, context);
  cache.set(key, canon);
  return canon;
}

// The audit can land before the atomic state write. Use it only to keep files
// out of the revert path; never derive the recording allow-set from this log.
function auditedScope(statePath, run, frozen, context) {
  const events = readScopeEvents(statePath);
  const cursor = run.scope_event_cursor;
  if (cursor === undefined) {
    // A legacy marker has no event boundary. Ignore incidental task_files for
    // other waves; preserve only additions explicitly audited against a
    // compatible frozen scope in this wave. This is not launch proof.
    return events.filter(isTaskFileAmendment).flatMap(event => {
      const audit = event.scope_reauthorization;
      if (audit?.wave !== run.wave || !Array.isArray(audit.old_scope) || !Array.isArray(audit.added_entries) ||
          !canonicalizeScopePaths(audit.old_scope, context).every(f => pathWithinDeclaredScope(f, frozen))) return [];
      return audit.added_entries;
    });
  }
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > events.length) {
    throw new Error('record-result: invalid scope amendment launch cursor; cannot safely check for an interrupted amendment');
  }
  return events.slice(cursor).filter(isTaskFileAmendment).flatMap(event =>
    Array.isArray(event.task_files) ? event.task_files.flatMap(task =>
      task?.wave === run.wave && Array.isArray(task.files) ? task.files : []) : []);
}

export function amendedScopeFiles(statePath, state, files, context) {
  const run = state.active_run;
  const current = declaredScope(state, run?.wave);
  const frozen = canonicalizeScopePaths(run?.scope ?? current, context);
  const candidates = [...new Set(files)].filter(f => !pathWithinDeclaredScope(f, frozen));
  if (!candidates.length) return [];
  const audited = Array.isArray(run?.scope) ? auditedScope(statePath, run, frozen, context) : [];
  const preserve = canonicalizeScopePaths([...current, ...audited], context);
  return candidates.filter(f => pathWithinDeclaredScope(f, preserve));
}

export function amendedScopeReason(files, wave) {
  return `scope-amended-after-launch: ${files.join(', ')} match task declarations or an audited amendment for wave ${wave}, but are outside the launch scope; no work was changed. Rerun an interrupted controller amendment with amend-plan/amend-tasks. If the task files are already recorded, run mp reauthorize-scope --state=PATH --wave=${wave} --reason=TEXT using the recorded amendment. Then retry record-result.`;
}

export function taskFilesEvidence(state) {
  return (state.tasks ?? []).map(t => ({ id: t.id, wave: t.wave, files: t.files ?? [] }));
}

// Pure widening. Keep the original entries byte-for-byte; add only declarations
// not already covered. Removing a task/file from the plan can never revoke scope.
export function widenActiveScope(state, context, reason) {
  const run = state.active_run;
  if (!run || run.kind === 'plan' || !Number.isInteger(run.wave) || !Array.isArray(run.scope)) return null;
  const old = run.scope;
  const frozen = canonicalizeScopePaths(old, context);
  const added = [...new Set(canonicalizeScopePaths(declaredScope(state, run.wave), context))]
    .filter(f => !pathWithinDeclaredScope(f, frozen));
  if (!added.length) return null;
  const scope = [...old, ...added];
  return { state: { ...state, active_run: { ...run, scope } },
    audit: { wave: run.wave, old_scope: old, new_scope: scope, added_entries: added, reason } };
}

export function reauthorizeScope({ statePath, state, wave, reason, events = readScopeEvents(statePath), context = scopeContext(statePath, state) }) {
  const run = state.active_run;
  if (!Number.isInteger(wave) || !run || run.kind === 'plan' || run.wave !== wave)
    throw new Error('reauthorize-scope: no active run for that wave');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('reauthorize-scope: a non-empty reason is required');
  if (!Array.isArray(run.scope)) throw new Error('reauthorize-scope: active run has no frozen scope');
  const widened = widenActiveScope(state, context, reason.trim());
  if (!widened) throw new Error('reauthorize-scope: nothing would change (scope can only widen)');
  const cursor = run.scope_event_cursor;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > events.length)
    throw new Error('reauthorize-scope: no launch amendment boundary; record the task files with amend-plan or amend-tasks');
  const amendments = [];
  // Frozen launch scope is the same for every task. Proof file lists repeat across
  // the amendment log; canonicalize each distinct list once, not once per task.
  const frozen = canonicalizeScopePaths(run.scope, context);
  const proofPaths = new Map();
  for (const task of (state.tasks ?? []).filter(t => t.wave === wave)) {
    const files = canonicalizeScopePaths(task.files ?? [], context);
    if (files.every(f => pathWithinDeclaredScope(f, frozen))) continue;
    let match = null;
    for (let i = cursor; i < events.length; i++) {
      const e = events[i];
      if (!isTaskFileAmendment(e)) continue;
      const proof = e.task_files?.find(t => String(t.id) === String(task.id) && t.wave === wave);
      if (proof && JSON.stringify(memoizedScopePaths(proofPaths, proof.files, context)) === JSON.stringify(files))
        match = { event_line: i + 1, type: e.type, ts: e.ts ?? null, task_id: task.id };
    }
    if (!match) throw new Error(`reauthorize-scope: task ${task.id} files have no matching recorded amendment since launch; use amend-plan or amend-tasks`);
    amendments.push(match);
  }
  return { ...widened, event: { type: 'scope_reauthorized', ...widened.audit, amendments } };
}
