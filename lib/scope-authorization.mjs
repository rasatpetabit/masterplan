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

export function amendedScopeFiles(state, files, context) {
  const frozen = canonicalizeScopePaths(state.active_run?.scope ?? declaredScope(state, state.active_run?.wave), context);
  const current = canonicalizeScopePaths(declaredScope(state, state.active_run?.wave), context);
  return [...new Set(files)].filter(f => !pathWithinDeclaredScope(f, frozen) && pathWithinDeclaredScope(f, current));
}

export function amendedScopeReason(files, wave) {
  return `scope-amended-after-launch: ${files.join(', ')} are declared by the current wave ${wave} plan but not authorized by the launch scope; no work was changed. Run mp reauthorize-scope --state=PATH --wave=${wave} --reason=TEXT using a recorded task-file amendment, then retry record-result (or record the amendment with amend-plan/amend-tasks first).`;
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
  for (const task of (state.tasks ?? []).filter(t => t.wave === wave)) {
    const files = canonicalizeScopePaths(task.files ?? [], context);
    const frozen = canonicalizeScopePaths(run.scope, context);
    if (files.every(f => pathWithinDeclaredScope(f, frozen))) continue;
    let match = null;
    for (let i = cursor; i < events.length; i++) {
      const e = events[i];
      if (!['plan_amended', 'tasks_amended'].includes(e.type)) continue;
      const proof = e.task_files?.find(t => String(t.id) === String(task.id) && t.wave === wave);
      if (proof && JSON.stringify(canonicalizeScopePaths(proof.files, context)) === JSON.stringify(files))
        match = { event_line: i + 1, type: e.type, ts: e.ts ?? null, task_id: task.id };
    }
    if (!match) throw new Error(`reauthorize-scope: task ${task.id} files have no matching recorded amendment since launch; use amend-plan or amend-tasks`);
    amendments.push(match);
  }
  return { ...widened, event: { type: 'scope_reauthorized', ...widened.audit, amendments } };
}
