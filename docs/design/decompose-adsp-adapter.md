# Decompose adsp-adapter into focused modules

**Status:** Implemented

**Implemented:** 2026-08-07 (see commits and corresponding [plan doc](docs/masterplan/.implemented-plan-archive/2026-08-07-decompose-adsp-adapter.md))

## Purpose

`lib/dispatch/adsp-adapter.mjs` is 1222 lines — the largest module in the repo — with 8 responsibility clusters. The header says it's the "SOLE delegation seam" co-locating everything that crosses the agent-dispatch boundary, but three of its clusters are self-contained or near-self-contained and can be extracted without disrupting the dispatch surface's internal coupling. This change splits the module into 3 focused modules + a backward-compat barrel.

## Goals

1. Extract verify packaging (~130 lines) and broker client (~115 lines) into their own modules.
2. Keep the tightly-coupled dispatch surface together (~660 lines) — `dispatchTask` is the hub that depends on work-item construction, digest normalization, and result translation internally.
3. Make `adsp-adapter.mjs` a thin barrel re-exporting from all three, so no importer changes.

## Non-goals

- Changing any function's interface, behavior, or injected-seam pattern.
- Splitting the dispatch surface further (dispatchTask → result → work-item chain is tightly coupled).
- Changing any import statement in any importer (barrel preserves all export names).

## Resolved design decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Decompose goal | Split by responsibility | 8 clusters in one module; 3 are separable |
| Module layout | 4 modules + barrel | Verify and broker are clean extractions; dispatch surface stays coupled |
| Backward compat | Barrel re-exports | No importer changes needed |

## Coupling analysis

```
verify-transport (self-contained — no internal deps)
    ↑
broker-client (depends on verify-transport: assertAllowlistAcceptsBashC)

dispatch-digest (depends on verify-transport: prepareDispatch → packageGatewayVerify)
  └─ dispatchTask is the hub: depends on createBrokerClient, prepareDispatch,
     stampDigest, brokerErrorDigest, translateBrokerResult, persistBlockedResult
  └─ translateBrokerResult depends on: extractDigestFromOutput, buildDispatchField,
     stampDigest, blockedDigest, failedDigest
  └─ escalateCrossReview, revertCrossReview (self-contained)
```

## Proposed architecture

### New: `lib/dispatch/verify-transport.mjs` (~130 lines)

Verify command packaging for the gateway seam:
- `posixSingleQuote`, `wrapVerifyCommandForGateway`, `assertAllowlistAcceptsBashC`
- `packageGatewayVerify`, `runLocalVerifyCommands`
- `DEFAULT_VERIFY_TIMEOUT_S`, `DEFAULT_SKYNET_VERIFY_ALLOWLIST`

Imports: `node:child_process` (execFileSync), no internal deps.

### New: `lib/dispatch/broker-client.mjs` (~115 lines)

MCP broker client factory:
- `createBrokerClient`

Imports: `node:child_process`, `./verify-transport.mjs` (assertAllowlistAcceptsBashC), CONTRACT_VERSION from dispatch-digest (or shared constants).

**Note on CONTRACT_VERSION:** This is a contract version string (`adsp-v1.1`) used by multiple modules. It should live in the dispatch-digest module (the dispatch surface owns the contract) and broker-client imports it from there. Alternatively, it could be a shared constant in a tiny `contract.mjs`. Since only dispatch-digest and broker-client use it, and broker-client already depends on verify-transport (not dispatch-digest), we have a choice: put CONTRACT_VERSION in verify-transport (the bottom of the dependency chain) or create a tiny shared constants module. Decision: put it in verify-transport since it's a simple constant and verify-transport is at the bottom of the chain.

### Remaining: `lib/dispatch/dispatch-digest.mjs` (~660 lines)

The dispatch surface — work items, digests, translation, dispatchTask, cross-review:
- Validation: `isValidDispatchField`, `isValidDigest`, `extractDigestFromOutput`
- Work items: `normalizeInputs`, `prepareDispatch`, `buildWorkItem`, `buildFrozenDispatchRecord`, `frozenRecordFromPrep`
- Digests: `buildDispatchField`, `stampDigest`, `blockedDigest`, `failedDigest`, `brokerErrorDigest`
- Translation: `translateBrokerResult`, `persistBlockedResult`
- Entry points: `dispatchTask`, `escalateCrossReview`, `revertCrossReview`

Imports: `node:crypto`, `node:fs`, `./verify-transport.mjs` (packageGatewayVerify), `./broker-client.mjs` (createBrokerClient).

### Barrel: `lib/dispatch/adsp-adapter.mjs` (~20 lines)

Re-exports everything from the three modules:
```js
export { CONTRACT_VERSION, DEFAULT_VERIFY_TIMEOUT_S, DEFAULT_SKYNET_VERIFY_ALLOWLIST } from './verify-transport.mjs';
export { createBrokerClient } from './broker-client.mjs';
export {
  isValidDispatchField, extractDigestFromOutput, buildWorkItem, buildFrozenDispatchRecord,
  brokerErrorDigest, translateBrokerResult, dispatchTask, escalateCrossReview, revertCrossReview,
} from './dispatch-digest.mjs';
export {
  posixSingleQuote, wrapVerifyCommandForGateway, assertAllowlistAcceptsBashC,
  packageGatewayVerify, runLocalVerifyCommands,
} from './verify-transport.mjs';
```

### Importers (unchanged)

All existing imports from `'./dispatch/adsp-adapter.mjs'` continue to work via the barrel.

## Acceptance criteria

- `lib/dispatch/verify-transport.mjs`, `lib/dispatch/broker-client.mjs`, `lib/dispatch/dispatch-digest.mjs` created.
- `lib/dispatch/adsp-adapter.mjs` is a thin barrel (~20 lines).
- No importer changes — all existing imports from adsp-adapter.mjs work unchanged.
- All existing tests pass without modification.
- Agent-dispatch repository unchanged.
- User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- `npm test` shows no new failures beyond the 2 pre-existing baseline.
