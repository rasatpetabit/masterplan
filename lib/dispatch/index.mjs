// lib/dispatch/index.mjs — the agent-dispatch module: every "where/how does this work run"
// decision behind ONE import surface.
//
// Consolidated 2026-06-10 in preparation for a unified agent dispatch system that spans
// more than masterplan (the agentic-dispatch policy repo — `agent-dispatch where` — is the policy side; this
// package is the mechanism side). The boundary rule: DECISION LOGIC IN, STATE MACHINE OUT.
// Everything here is pure (no fs, no clock, no subprocess, no git) so it can lift into a
// shared package verbatim; masterplan-specific machinery stays with its consumers:
//   - prepareWave / verifyScope (lib/wave.mjs)         — wave/state/plan merging + F-SCOPE
//   - the continue trampoline (lib/continue.mjs)       — markers, worktrees, Guard D
//   - the L2 engine (workflows/execute.workflow.js)    — a Workflow script; CANNOT import
//     modules at all, so it consumes these decisions pre-resolved via `args`
//   - the qctl job contract (lib/qctl-*.mjs)           — job identity/integrity/status,
//     not dispatch decisions
//
// Submodules:
//   routing.mjs — routeTask (codex/inline/ask eligibility + precedence) and
//                 resolveImplementerBackend (the {kind:'agent'|'qctl'} tagged union)
//   backend.mjs — qctlEligible (the §6.3 allowlist/infra gate) and resolveTaskBackend
//                 (resolveImplementerBackend composed with that gate)
//   host.mjs    — detectHost / normalizeResumeHint (Codex-host dual-targeting:
//                 capability detect + `$masterplan` shell-trap recovery)
//   ops.mjs     — normalizeReviewMode and buildWaveDispatchOp (the dispatch-vehicle fork:
//                 background L2 workflow vs foreground-sequential in-session)

export { routeTask, resolveImplementerBackend } from './routing.mjs';
export { qctlEligible, resolveTaskBackend } from './backend.mjs';
export { detectHost, normalizeResumeHint, CODEX_ENTRYPOINT } from './host.mjs';
export { normalizeReviewMode, buildWaveDispatchOp } from './ops.mjs';
