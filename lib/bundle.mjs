// lib/bundle.mjs — the L0/L1 durable run-bundle reader/writer (build step 1-2).
//
// CD-7 single-writer: this is the ONLY module that writes state.yml. Wave members
// (L2 agents) never call it. Owns the pending_gate marker and the active_run_id
// field. Pure parse/serialize + atomic write; no orchestration logic lives here.
// TODO(step 1-2): readState(dir), writeState(dir, state), openGate(), clearGate().
export {};
