// lib/dispatch/routing.mjs — implementer-backend resolution as a PURE function (build step 1).
//
// The pre-resolved codex/inline/ask eligibility brain was DELETED (C6, fresh-eyes
// remediation 2026-08-30): routing/eligibility decisions now live in the governed
// routing-policy resolver (lib/dispatch/routing-policy.mjs, mapped from the repo-local
// policy/workflow-map.json) and no longer pre-bake a `target`/`eligible`/`reason` in
// masterplan's duplicated brain. prepareWave carries each task's dispatch `class` and the
// dispatch-wave consumer resolves the policy lane.
//
//   resolveImplementerBackend(task, config, env) -> {kind:'agent'} | {kind:'qctl',...}
//
//   task:   { files: [], verify_commands: [] }        (from plan.index.json)
//   config: { implementer: { qctl: { enabled: bool } } }
//
// The implementer backend is the qctl-dormant-seam sibling: a tagged union, NOT a registry.
// {kind:'agent'} reproduces shipping byte-for-byte (agentType/model stay in the dispatch-wave
// seam, commit 561f348 — the descriptor never restates fields the dispatch site already holds);
// {kind:'qctl'} is emitted ONLY when the flag is strictly true, and carries only task-intrinsic
// fields (repo/base are binding-time, stamped by the consumer — see spec §4/B1). Default OFF ⇒
// only {kind:'agent'} is ever emitted ⇒ production is unchanged. The `env` param is kept for
// the deferred binding-time crossing; it is intentionally unused today.
export function resolveImplementerBackend(task = {}, config = {}, env = {}) {
  if (config.implementer?.qctl?.enabled === true) {
    return { kind: 'qctl', scope: task.files ?? [], verify: task.verify_commands ?? [], deliver: 'patch' };
  }
  return { kind: 'agent' };
}
