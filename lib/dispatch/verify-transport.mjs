// lib/dispatch/verify-transport.mjs — handoff contract + verify allowlist record.
//
// Carries the pinned handoff contract version and the default recorded verify
// allowlist surfaced in each wave's dispatch record for audit continuity. Local
// verification of wave children is performed by the harness (they report their
// worker digest; `mp record-result` ingests it) — there is no orchestrator-side
// shell runner here.

// ---------------------------------------------------------------------------
// Contract version (pinned; both sides must agree)
// ---------------------------------------------------------------------------

/** Pinned handoff contract version for the native fabric seam. */
export const CONTRACT_VERSION = 'fabric-native-v1';

/**
 * Default recorded verify allowlist for audit continuity. Historical name kept
 * because fleet runbooks set SKYNET_VERIFY_ALLOWLIST; local verification does
 * not gate on it — the value is surfaced in the wave record for audit only.
 */
export const DEFAULT_SKYNET_VERIFY_ALLOWLIST = 'bash -c';
