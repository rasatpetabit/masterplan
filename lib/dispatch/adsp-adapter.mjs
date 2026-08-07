// lib/dispatch/adsp-adapter.mjs — masterplan's SOLE delegation seam (adsp-v1 contract, spec §5.5).
//
// Thin barrel: implementation lives in focused sibling modules. All importers
// continue to use this path; re-exports preserve the public surface.
//
//   ./verify-transport.mjs  — CONTRACT_VERSION, gateway verify packaging, local verify runner
//   ./broker-client.mjs     — createBrokerClient (MCP stdio client for agent-dispatch)
//   ./dispatch-digest.mjs   — work-item prep, digest translation, dispatchTask, cross-review
//
// Seam surface (the only agent-dispatch meeting points for masterplan)
// -------------------------------------------------------------------
//   dispatchTask(task, options)               — sole delegation surface (async → Digest)
//   buildWorkItem(task, options)              — pure work-item constructor (no I/O)
//   buildFrozenDispatchRecord(task, options)  — pure frozen-record constructor (no I/O)
//   escalateCrossReview(...)                  — cross-review escalation bridge (spec §6.8)
//   revertCrossReview(...)                    — cross-review revert bridge (spec §6.8)
//
// Contract version: adsp-v1.1 (pinned; see verify-transport.mjs).

// Re-exports for backward compatibility — all importers continue to use './adsp-adapter.mjs'
export {
  CONTRACT_VERSION,
  DEFAULT_VERIFY_TIMEOUT_S,
  DEFAULT_SKYNET_VERIFY_ALLOWLIST,
  posixSingleQuote,
  wrapVerifyCommandForGateway,
  assertAllowlistAcceptsBashC,
  packageGatewayVerify,
  runLocalVerifyCommands,
} from './verify-transport.mjs';
export { createBrokerClient } from './broker-client.mjs';
export {
  isValidDispatchField,
  extractDigestFromOutput,
  buildWorkItem,
  buildFrozenDispatchRecord,
  brokerErrorDigest,
  translateBrokerResult,
  dispatchTask,
  escalateCrossReview,
  revertCrossReview,
} from './dispatch-digest.mjs';
