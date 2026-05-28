// lib/routing.mjs — Codex eligibility as a PURE function (build step 1).
//
// Ports v7's eligibility checklist + precedence (parts/step-c-dispatch.md) into
// deterministic, zero-token, testable code. This is what kills fragility source #2:
// the routing DECISION no longer lives as LLM-interpreted prose re-evaluated every run.
// The v7 eligibility_cache dies — eligibility is computed here over the plan.index.json
// task at dispatch time.
//
//   routeTask(task, config, env) -> { target: 'codex'|'inline'|'ask', eligible, reason }
//
//   task:   { files: [], description, verify_commands: [], codex: 'ok'|'no'|null,
//             sensitive?: bool, conversational?: bool }   (from plan.index.json)
//   config: { routing: 'auto'|'off'|'manual' }            (default 'auto')
//   env:    { codexHostSuppressed?: bool, linkedWorktree?: bool }  (probed by the shell)
//
// Precedence (highest first): host-suppression -> routing-off -> linked-worktree ->
// annotation (no/ok) -> heuristic; then mode (auto -> codex/inline, manual -> ask).

const JUDGMENT_RE = /\b(consider|decide|choose between|design|explore)\b/;
const SENSITIVE_RE =
  /\b(secrets?|oauth|browser auth|production deploy|deploy to prod|destructive|schema migration|migrate schema)\b/;

// The v7 heuristic checklist, minus the annotation (resolved by the caller).
function heuristicEligible(task) {
  const files = task.files ?? [];
  if (files.length > 3) return false;
  const desc = String(task.description ?? task.title ?? '').toLowerCase();
  if (JUDGMENT_RE.test(desc)) return false;
  if ((task.verify_commands ?? []).length === 0) return false;
  if (task.sensitive === true || SENSITIVE_RE.test(desc)) return false;
  if (task.conversational === true) return false;
  return true;
}

export function routeTask(task = {}, config = {}, env = {}) {
  const routing = config.routing ?? 'auto';

  // Environmental hard-blocks — force inline regardless of annotation/heuristic/mode.
  if (env.codexHostSuppressed) return { target: 'inline', eligible: false, reason: 'host-suppressed' };
  if (routing === 'off') return { target: 'inline', eligible: false, reason: 'routing-off' };
  if (env.linkedWorktree) return { target: 'inline', eligible: false, reason: 'linked-worktree' };

  // Resolve eligibility: a `codex` annotation overrides the heuristic.
  let eligible;
  let basis;
  if (task.codex === 'no') {
    eligible = false;
    basis = 'annotation-no';
  } else if (task.codex === 'ok') {
    eligible = true;
    basis = 'annotation-ok';
  } else {
    eligible = heuristicEligible(task);
    basis = eligible ? 'heuristic' : 'heuristic-rejected';
  }

  // Apply the routing mode.
  if (routing === 'manual') return { target: 'ask', eligible, reason: 'manual' };
  return { target: eligible ? 'codex' : 'inline', eligible, reason: basis };
}
