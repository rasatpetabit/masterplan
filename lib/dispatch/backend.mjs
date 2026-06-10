// lib/dispatch/backend.mjs — implementer-backend eligibility + resolution (the §6.3 gate).
//
// Lifted out of lib/wave.mjs at the dispatch-module consolidation (2026-06-10) so every
// "where does this task run" decision lives under lib/dispatch/. Pure — no fs, no clock,
// no subprocess; the caller owns loading repos.yml (qctlEligible receives an ALREADY-PARSED
// allowlist object).
//
//   qctlEligible(task, reposAllowlist) -> bool
//     PURE eligibility predicate for the {kind:'qctl'} backend. A task is eligible only
//     when ALL of:
//       - verify_commands is non-empty
//       - task is not sensitive
//       - no file touches infra paths (systemd/router/serving/CI/secrets/mp internals)
//       - all files fall within the scope globs of at least one allowlist entry
//
//   resolveTaskBackend(task, config, env, reposAllowlist) -> {kind:'agent'} | {kind:'qctl',...}
//     resolveImplementerBackend (routing.mjs) composed with the qctlEligible gate.
//     Short-circuits on flag-off BEFORE touching reposAllowlist (flag-off first build: no
//     allowlist); an ineligible task downgrades to {kind:'agent'} rather than failing.

import { resolveImplementerBackend } from './routing.mjs';

// Infra path segments whose presence makes a task NEVER eligible for qctl, regardless of
// allowlist. Mirrors repos.yml header: "systemd units, router/serving profiles, CI/CD config,
// secrets, mp/masterplan internals." Checked against the lowercased file path.
const INFRA_RE =
  /\b(systemd|\.service|\.timer|router|serving|\.github|ci\.yml|cd\.yml|ci\/|\.secrets?|secrets?\/|masterplan|\/mp\/)\b/;

// Minimal glob matcher for repos.yml scope entries. Supports:
//   "path/to/dir"     — exact match OR match as ancestor prefix ("path/to/dir/sub.js")
//   "path/to/dir/**"  — match anything under path/to/dir/
function globMatches(glob, file) {
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3); // strip "/**"
    return file === prefix || file.startsWith(prefix + '/');
  }
  // Plain path: exact OR the file is under it as a directory prefix
  return file === glob || file.startsWith(glob + '/');
}

// Returns true iff all `files` are covered by at least one allowlist entry's scope globs.
function filesInAllowlist(files, reposAllowlist) {
  const entries = Object.values(reposAllowlist ?? {});
  return files.every((file) =>
    entries.some((entry) =>
      (entry.scope ?? []).some((glob) => globMatches(glob, file))
    )
  );
}

// qctlEligible: the §6.3 eligibility predicate. Pure — no I/O.
// reposAllowlist: parsed repos.yml object (keyed by repo name) or undefined/null.
export function qctlEligible(task = {}, reposAllowlist) {
  const files = task.files ?? [];

  // Must have verify commands (a task with no verification cannot be safely offloaded).
  if ((task.verify_commands ?? []).length === 0) return false;

  // Sensitive tasks stay with Claude/Codex.
  if (task.sensitive === true) return false;

  // Infra paths are NEVER eligible — hard override even if scope glob would cover them.
  if (files.some((f) => INFRA_RE.test(String(f).toLowerCase()))) return false;

  // All files must fall within at least one allowlist entry's scope globs.
  if (!filesInAllowlist(files, reposAllowlist)) return false;

  return true;
}

// Wraps resolveImplementerBackend with the qctlEligible gate.
// Short-circuits on flag-off BEFORE touching reposAllowlist (flag-off first build: no allowlist).
export function resolveTaskBackend(task, config, env, reposAllowlist) {
  const backend = resolveImplementerBackend(task, config, env);
  // Short-circuit: if the flag is not strictly true, the allowlist is never consulted.
  if (config.implementer?.qctl?.enabled !== true) return backend;
  // Flag is on but eligibility predicate rejects this task → downgrade to {kind:'agent'}.
  if (backend.kind === 'qctl' && !qctlEligible(task, reposAllowlist)) {
    return { kind: 'agent' };
  }
  return backend;
}
