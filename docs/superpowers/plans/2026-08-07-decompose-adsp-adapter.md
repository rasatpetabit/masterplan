# Decompose adsp-adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `lib/dispatch/adsp-adapter.mjs` (1222 lines) into 3 focused modules + a backward-compat barrel. Mechanical extraction — no behavior changes, no importer changes.

**Architecture:** verify-transport.mjs (self-contained) → broker-client.mjs (depends on verify-transport) → dispatch-digest.mjs (the dispatch surface). adsp-adapter.mjs becomes a barrel re-exporting from all three.

## Global Constraints

- Behavior-preserving: all existing tests pass without modification.
- No function interface, injected-seam, or error-behavior changes.
- No importer changes — the barrel preserves all existing export names.
- Do not modify agent-dispatch or any other repository.
- Do not modify or stage the user-owned `AGENTS.md` or `WORKLOG.md` changes.

---

### Task 1: Extract verify-transport.mjs and broker-client.mjs

**Files:**
- Create: `lib/dispatch/verify-transport.mjs`
- Create: `lib/dispatch/broker-client.mjs`
- Modify: `lib/dispatch/adsp-adapter.mjs` (remove extracted code, import from new modules)

- [ ] **Step 1: Create `lib/dispatch/verify-transport.mjs`**

Move from adsp-adapter.mjs:
- Constants: `DEFAULT_VERIFY_TIMEOUT_S`, `DEFAULT_SKYNET_VERIFY_ALLOWLIST`, `CONTRACT_VERSION`
- Functions: `posixSingleQuote`, `wrapVerifyCommandForGateway`, `assertAllowlistAcceptsBashC`, `packageGatewayVerify`, `runLocalVerifyCommands`

Imports: `node:child_process` (execFileSync for runLocalVerifyCommands).

- [ ] **Step 2: Create `lib/dispatch/broker-client.mjs`**

Move from adsp-adapter.mjs:
- Function: `createBrokerClient` (112 lines)

Imports: `node:child_process`, `./verify-transport.mjs` (assertAllowlistAcceptsBashC, CONTRACT_VERSION, DEFAULT_SKYNET_VERIFY_ALLOWLIST).

- [ ] **Step 3: Update adsp-adapter.mjs**

Remove the extracted functions/constants. Import them from the new modules. Keep everything else (dispatch surface) in place for now — Task 2 moves the rest.

At this point adsp-adapter.mjs should:
- Import verify-transport functions/constants and re-export them (or the remaining dispatch code imports from verify-transport directly).
- Import createBrokerClient from broker-client and re-export it (or the remaining dispatch code imports from broker-client directly).
- Still contain all dispatch-digest functions.

**Simplest approach:** The remaining dispatch functions in adsp-adapter.mjs import what they need from verify-transport and broker-client directly. adsp-adapter.mjs re-exports everything (from its own definitions + from the new modules) for backward compat until Task 2 converts it to a pure barrel.

- [ ] **Step 4: Run focused tests**

```bash
node --test test/adsp-adapter.test.mjs test/verify-transport.test.mjs test/dispatch-wave.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch/verify-transport.mjs lib/dispatch/broker-client.mjs lib/dispatch/adsp-adapter.mjs
git commit -m "refactor(adsp): extract verify-transport and broker-client modules"
```

---

### Task 2: Extract dispatch-digest.mjs and convert adsp-adapter.mjs to barrel

**Files:**
- Create: `lib/dispatch/dispatch-digest.mjs`
- Modify: `lib/dispatch/adsp-adapter.mjs` (becomes pure barrel)

- [ ] **Step 1: Create `lib/dispatch/dispatch-digest.mjs`**

Move ALL remaining functions from adsp-adapter.mjs:
- Validation: `isValidDispatchField`, `isValidDigest`, `extractDigestFromOutput`
- Work items: `normalizeInputs`, `prepareDispatch`, `buildWorkItem`, `buildFrozenDispatchRecord`, `frozenRecordFromPrep`
- Digests: `buildDispatchField`, `stampDigest`, `blockedDigest`, `failedDigest`, `brokerErrorDigest`
- Translation: `translateBrokerResult`, `persistBlockedResult`
- Entry points: `dispatchTask`, `escalateCrossReview`, `revertCrossReview`

Imports: `node:crypto`, `node:fs`, `./verify-transport.mjs` (packageGatewayVerify, CONTRACT_VERSION), `./broker-client.mjs` (createBrokerClient).

- [ ] **Step 2: Convert adsp-adapter.mjs to a barrel**

Replace all remaining code with re-exports:
```js
export { CONTRACT_VERSION, DEFAULT_VERIFY_TIMEOUT_S, DEFAULT_SKYNET_VERIFY_ALLOWLIST,
  posixSingleQuote, wrapVerifyCommandForGateway, assertAllowlistAcceptsBashC,
  packageGatewayVerify, runLocalVerifyCommands } from './verify-transport.mjs';
export { createBrokerClient } from './broker-client.mjs';
export { isValidDispatchField, extractDigestFromOutput, buildWorkItem, buildFrozenDispatchRecord,
  brokerErrorDigest, translateBrokerResult, dispatchTask, escalateCrossReview,
  revertCrossReview } from './dispatch-digest.mjs';
```

- [ ] **Step 3: Run focused tests**

```bash
node --test test/adsp-adapter.test.mjs test/verify-transport.test.mjs test/dispatch-wave.test.mjs test/fabric-codex-suppressed.test.mjs test/qctl-fabric-seam.test.mjs
```

- [ ] **Step 4: Run full suite**

```bash
npm test
```

Expected: no new failures beyond the 2 pre-existing baseline.

- [ ] **Step 5: Verify AGENTS.md and WORKLOG.md untouched**

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch/dispatch-digest.mjs lib/dispatch/adsp-adapter.mjs
git commit -m "refactor(adsp): extract dispatch-digest and convert adsp-adapter to barrel"
```

---

## Final Acceptance Check

- [ ] `lib/dispatch/verify-transport.mjs`, `lib/dispatch/broker-client.mjs`, `lib/dispatch/dispatch-digest.mjs` created.
- [ ] `lib/dispatch/adsp-adapter.mjs` is a thin barrel (~20 lines).
- [ ] No importer changes — all existing imports from adsp-adapter.mjs work unchanged.
- [ ] All existing tests pass without modification.
- [ ] Agent-dispatch repository unchanged.
- [ ] User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- [ ] `npm test` shows no new failures beyond the 2 pre-existing baseline.
