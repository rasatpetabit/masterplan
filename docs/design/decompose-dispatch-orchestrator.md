# Decompose the wave-dispatch orchestrator into pipeline stages

**Status:** Implemented

**Implemented:** 2026-08-07 (see commits and corresponding `docs/superpowers/plans/` plan doc)

## Purpose

`dispatchWaveViaFabric` in `lib/dispatch-wave.mjs` is a 611-line monolith (lines 680–1290) holding ten numbered phases inline: flag gate, idempotency, routing, descriptors, ownership, watch precheck, broker dispatch, local verify, review, and record finalize. The centralized-review refactor just added wiring inside it, deepening the entanglement. This change extracts the phases into named private helpers within the same module so the orchestrator becomes a readable ~60-line pipeline.

## Goals

1. Make each phase legible and independently testable through internal seams.
2. Reduce the orchestrator to a readable sequence of named, guarded stage calls.
3. Keep all stages private helpers within `lib/dispatch-wave.mjs` — no new cross-module adapter.
4. Preserve every existing behavior and outcome shape — all 35 integration tests pass unchanged.
5. Add targeted unit tests for stages with complex logic that is hard to isolate through the orchestrator.

## Non-goals

- Changing any outcome shape, return value, or external interface of `dispatchWaveViaFabric`.
- Creating a new module or cross-module seam.
- Introducing a mutable context object that stages mutate in place.
- Changing the broker lifecycle, review wiring, or record transaction.
- Editing agent-dispatch or any other repository.

## Resolved design decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Seam shape | By phase boundary (~6 private helpers) | Early returns cluster at phase boundaries naturally |
| Control flow | Each stage that can early-exit returns an outcome object; orchestrator checks and short-circuits | Early returns already live at phase boundaries |
| Value flow | Explicit params in, grouped return bundles out; orchestrator destructures and threads | Dependencies explicit; no mutable shared object |
| Native fork | Orchestrator branches on `selectLaunchPath` after acquire | Native returns a different outcome shape (spawn plan vs digests) |
| Testing | 35 integration tests stay; targeted unit tests for gate/context/descriptors/acquire | Complex logic gets isolation; integration verifies control flow |

## Current architecture

`dispatchWaveViaFabric` is one async function with 16 parameters and 6 early-return paths. Its body interleaves:

1. Flag gate + marker/key validation
2. Idempotency record consultation (pending/dispatched/recorded)
3. Routing-input parity + `prepareWave`
4. Worktree + MAIN + input fingerprint
5. Per-task descriptor construction
6. Guard D ownership + watch-list precheck + record persistence
7. Native spawn branch (returns spawn plan) OR broker pool + local verify + review
8. Dispatched result persistence + `recordWaveResult` + record finalize

Understanding any single phase requires holding the entire 611-line body in mind.

## Proposed architecture

Extract the numbered phases into private helpers within the same module. Each helper takes explicit params and returns a grouped bundle. The orchestrator becomes:

```
gate → context → descriptors → acquire → [native: buildPlan | mcp: brokerDispatch → finalize]
```

### Stage interfaces

Each stage returns either an early-exit outcome object (carrying `outcome` + `dispatched:false`/`reused:true`) or its normal grouped return. The orchestrator checks each result and short-circuits on early exit.

- **`gateAndValidate({ statePath, self, now, ttlMs, wave, takeover, codexSuppressed })`**
  - Owns: flag gate, marker validation, idempotency record (pending/dispatched/recorded).
  - Early exits: `flag-off`, `reused/pending`, `reused/dispatched` (re-drives record).
  - Returns: `{ absState, bundleDir, state, run, wave, runId, key, existing }`.

- **`resolveWaveContext({ absState, state, run, wave, runId, key, existing, codexSuppressed })`**
  - Owns: plan-index read, routing-input parity, `prepareWave`, no-pending check, worktree/MAIN resolution, input fingerprint.
  - Early exits: `no-pending-tasks`.
  - Returns: `{ prepared, tasks, WT, MAIN, inputs }`.

- **`buildDescriptors({ tasks, WT, MAIN, runId, inputs, reviewOn, verifyTimeoutS, effectiveAllowlist })`**
  - Owns: per-task locus resolution, `buildWorkItem`, branch/create_files stamping.
  - No early exit.
  - Returns: `{ descriptors, localVerifyCommands, wtBranch }`.

- **`acquireAndWatch({ absState, bundleDir, state, run, self, now, ttlMs, wave, runId, key, existing, tasks, WT, MAIN, waveToken })`**
  - Owns: Guard D ownership, attempt, watch baseline capture, precheck, record persistence.
  - Early exits: `precheck-failed`.
  - Returns: `{ attempt, waveToken, record, watchBaseline }`.

- **`buildNativePlan({ tasks, descriptors, waveToken, wave, runId, bin })`**
  - Owns: per-task routing resolution, native spawn plan construction.
  - Early exits: `routing-unresolved`, `native-spawn-plan`.
  - Returns: the spawn-plan outcome object.

- **`runBrokerDispatch({ tasks, descriptors, digests, WT, localVerifyCommands, verifyTimeoutS, reviewOn, absState, runId, wave, inputs, brokerBin, effectiveAllowlist, _brokerClient, _openCoord, _closeCoord, _callReview, _localVerifyExec, now })`**
  - Owns: coord open/close, broker pool, local verify, per-task review.
  - No early exit (always returns digests).
  - Returns: `{ digests }`.

- **`finalizeRecord({ absState, bundleDir, wave, key, attempt, record, digests, run, self, now, WT, _record })`**
  - Owns: result persistence, `recordWaveResult`, record-status finalize.
  - No early exit.
  - Returns: the final dispatched outcome object.

The orchestrator threads values between stages via destructuring. The native fork branches after `acquireAndWatch` based on `selectLaunchPath`.

## Error handling

All existing throws (validation failures, ownership blocks, locus resolution failures) remain throws inside their respective stages. Only the 6 named early-exit outcomes become stage return values the orchestrator short-circuits on.

## Code changes

### `lib/dispatch-wave.mjs`

- Extract the 7 private helpers listed above from the inline phases.
- Rewrite `dispatchWaveViaFabric` as a ~60-line pipeline that calls the stages in sequence, checks for early-exit outcomes, and branches at the native fork.
- Preserve every existing parameter, injected seam (`_brokerClient`, `_openCoord`, `_closeCoord`, `_record`, `_captureFingerprint`, `_callReview`, `_localVerifyExec`), and return shape.
- Export the stages that get dedicated unit tests (following the module's existing convention of exporting helpers like `captureFullWorkingDiff`, `composeWaveToken`, etc.).

### `test/dispatch-wave.test.mjs`

- All 35 existing integration tests pass unchanged (they verify behavior preservation).
- Add focused unit tests for: `gateAndValidate` (flag-off, pending, dispatched-redrove), `resolveWaveContext` (no-pending-tasks, routing-input parity), `buildDescriptors` (locus resolution, create_files), `acquireAndWatch` (precheck-failed).

## Acceptance criteria

- `dispatchWaveViaFabric` is under 100 lines and reads as a sequence of named, guarded stage calls.
- All 35 existing integration tests pass without modification.
- New unit tests cover the gate, context, descriptor, and acquire stages.
- No new module, no new cross-module adapter seam.
- No change to any external interface, outcome shape, or parameter list.
- Agent-dispatch repository unchanged.
- User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- `npm test` shows no new failures beyond the 2 pre-existing baseline.
