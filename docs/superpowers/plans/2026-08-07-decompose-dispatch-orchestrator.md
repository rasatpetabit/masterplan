# Decompose Dispatch Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the 7 numbered phases of `dispatchWaveViaFabric` into named private helpers so the orchestrator becomes a readable ~60-line pipeline, preserving every behavior and outcome.

**Architecture:** Phase-boundary extraction within one module (`lib/dispatch-wave.mjs`). Each stage takes explicit params, returns a grouped bundle, and the orchestrator threads values via destructuring. Early-exit outcomes are returned by stages and short-circuited by the orchestrator. The native fork branches after acquire. No new module, no new cross-module seam.

**Tech Stack:** Node.js ESM, `node:test`, existing git/MCP test fixtures.

## Global Constraints

- Preserve every existing parameter, injected seam (`_brokerClient`, `_openCoord`, `_closeCoord`, `_record`, `_captureFingerprint`, `_callReview`, `_localVerifyExec`), and return shape of `dispatchWaveViaFabric`.
- All 35 existing integration tests in `test/dispatch-wave.test.mjs` must pass without modification after each task.
- No new module. All stages stay private helpers within `lib/dispatch-wave.mjs`.
- No mutable context object — stages take explicit params and return grouped bundles.
- Throws (validation failures, ownership blocks) stay throws inside their stages.
- Do not modify agent-dispatch or any other repository.
- Do not modify or stage the user-owned `AGENTS.md` or `WORKLOG.md` changes.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/dispatch-wave.mjs` | Extract 7 private helpers; rewrite `dispatchWaveViaFabric` as a pipeline. |
| `test/dispatch-wave.test.mjs` | 35 existing integration tests stay; add unit tests for gate/context/descriptors/acquire stages. |

---

### Task 1: Extract the Prepare Stages (gate, context, descriptors)

**Files:**
- Modify: `lib/dispatch-wave.mjs:680–1058` (the first half of `dispatchWaveViaFabric`)
- Modify: `test/dispatch-wave.test.mjs`

**Interfaces:**
- Extract three private helpers from the inline phases:

```js
function gateAndValidate({ statePath, self, now, ttlMs, wave: waveFlag, takeover })
// Returns early-exit outcome OR { absState, bundleDir, state, run, wave, runId, key, existing }

function resolveWaveContext({ absState, state, run, wave, runId, key, existing, codexSuppressed })
// Returns early-exit outcome (no-pending-tasks) OR { prepared, tasks, WT, MAIN, inputs }

function buildDescriptors({ tasks, WT, MAIN, runId, inputs, reviewOn, verifyTimeoutS, effectiveAllowlist })
// Returns { descriptors, localVerifyCommands, wtBranch }
```

- Export them (following the module's existing convention) for targeted unit tests.
- The orchestrator calls them in sequence, checks for early-exit, and destructures the return.

**Behavior preservation:** all 35 integration tests pass unchanged.

- [ ] **Step 1: Write failing unit tests for gateAndValidate**

Add to `test/dispatch-wave.test.mjs`:

```js
test('gateAndValidate: flag-off returns early when fabric is not true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-'));
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, { schema_version: 9, slug: 's', dispatch: { fabric: false } });
  const result = gateAndValidate({ statePath });
  assert.equal(result.outcome, 'flag-off');
});

test('gateAndValidate: returns validated context for a fabric-flagged bundle with a wave marker', () => {
  // Set up a fixture with fabric:true, active_run:{wave:1}, an existing dispatch record.
  // Assert result has { absState, bundleDir, state, run, wave:1, runId, key, existing }.
});

test('gateAndValidate: reused/pending when an existing record has status pending and no takeover', () => {
  // Pre-seed a pending record; assert result.outcome === 'reused' and result.status === 'pending'.
});
```

Fill each test body with concrete fixture setup using the file's existing `makeFixture`, `writeState`, and `writeWaveDispatchRecord` helpers.

- [ ] **Step 2: Run the new tests and verify RED**

```bash
node --test --test-name-pattern="gateAndValidate" test/dispatch-wave.test.mjs
```

Expected: FAIL — `gateAndValidate` is not exported.

- [ ] **Step 3: Extract gateAndValidate, resolveWaveContext, buildDescriptors**

Move the inline code from `dispatchWaveViaFabric` lines 680–1058 into the three private helpers. The orchestrator's first half becomes:

```js
const gate = gateAndValidate({ statePath, self, now, ttlMs, wave: waveFlag, takeover });
if (gate.outcome) return gate;
const { absState, bundleDir, state, run, wave, runId, key, existing } = gate;

const ctx = resolveWaveContext({ absState, state, run, wave, runId, key, existing, codexSuppressed });
if (ctx.outcome) return ctx;
const { prepared, tasks, WT, MAIN, inputs } = ctx;

const { descriptors, localVerifyCommands, wtBranch } = buildDescriptors({
  tasks, WT, MAIN, runId, inputs, reviewOn, verifyTimeoutS, effectiveAllowlist,
});
```

Export the three helpers for testing. Ensure all variables the second half needs (`reviewOn`, `verifyTimeoutS`, `effectiveAllowlist`, `WT`, `MAIN`, `inputs`, `run`, `absState`, `bundleDir`, `state`, `wave`, `runId`, `key`, `existing`) are still in scope — some may need to be returned from the stage bundles.

- [ ] **Step 4: Run the unit tests and verify GREEN**

```bash
node --test --test-name-pattern="gateAndValidate" test/dispatch-wave.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run all integration tests and verify GREEN**

```bash
node --test test/dispatch-wave.test.mjs
```

Expected: 35+ pass (35 original + new unit tests), 0 fail.

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch-wave.mjs test/dispatch-wave.test.mjs
git commit -m "refactor(dispatch): extract prepare stages (gate, context, descriptors)"
```

---

### Task 2: Extract the Execute Stages (acquire, native fork, broker dispatch, finalize)

**Files:**
- Modify: `lib/dispatch-wave.mjs:1058–1290` (the second half of `dispatchWaveViaFabric`)
- Modify: `test/dispatch-wave.test.mjs`

**Interfaces:**
- Extract four private helpers:

```js
function acquireAndWatch({ absState, bundleDir, state, run, self, now, ttlMs, wave, runId, key, existing, tasks, descriptors, WT, MAIN, inputs, reviewOn })
// Returns early-exit outcome (precheck-failed) OR { attempt, waveToken, record, watchBaseline }

function buildNativePlan({ tasks, descriptors, waveToken, wave, runId, bin })
// Returns early-exit outcome (routing-unresolved, native-spawn-plan)

async function runBrokerDispatch({ tasks, descriptors, WT, localVerifyCommands, verifyTimeoutS, reviewOn, absState, runId, wave, inputs, now, brokerBin, effectiveAllowlist, _brokerClient, _openCoord, _closeCoord, _callReview, _localVerifyExec })
// Returns { digests }

function finalizeRecord({ absState, bundleDir, wave, key, attempt, record, digests, run, self, now, WT, _record })
// Returns the final dispatched outcome object
```

- The orchestrator's second half becomes:

```js
const acq = acquireAndWatch({ /* ... */ });
if (acq.outcome) return acq;
const { attempt, waveToken, record } = acq;

// NATIVE FORK
const launchPath = selectLaunchPath({ codexSuppressed, nativeSpawn });
if (launchPath === 'native-spawn') {
  return buildNativePlan({ tasks, descriptors, waveToken, wave, runId, bin: brokerBin });
}

// MCP POOL
const { digests } = await runBrokerDispatch({ /* ... */ });
return finalizeRecord({ /* ... */ });
```

- Export the helpers for targeted unit tests.

**Behavior preservation:** all 35 integration tests pass unchanged.

- [ ] **Step 1: Write failing unit tests for acquireAndWatch**

```js
test('acquireAndWatch: precheck-failed when a task-scoped file is already dirty', () => {
  // Set up a fixture with a dirty task file; assert result.outcome === 'precheck-failed'.
});

test('acquireAndWatch: returns attempt and waveToken when precheck passes', () => {
  // Assert result has { attempt, waveToken, record, watchBaseline }.
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test --test-name-pattern="acquireAndWatch" test/dispatch-wave.test.mjs
```

Expected: FAIL — `acquireAndWatch` not exported.

- [ ] **Step 3: Extract the four helpers**

Move the inline code from `dispatchWaveViaFabric` lines 1058–1290 into the four helpers. The orchestrator's second half becomes the branch + calls shown above.

**Critical:** the native fork must branch AFTER acquire (ownership + watch precheck) but BEFORE broker dispatch. The `selectLaunchPath` call moves to the orchestrator.

**Critical:** the `review_context` persistence (added in the centralized-review work) must land inside `acquireAndWatch` alongside the record persistence — it's part of the pre-dispatch record freeze.

- [ ] **Step 4: Run unit tests and verify GREEN**

```bash
node --test --test-name-pattern="acquireAndWatch" test/dispatch-wave.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run all integration tests and verify GREEN**

```bash
node --test test/dispatch-wave.test.mjs
```

Expected: all pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch-wave.mjs test/dispatch-wave.test.mjs
git commit -m "refactor(dispatch): extract execute stages (acquire, dispatch, finalize)"
```

---

### Task 3: Orchestrator Cleanup, Docs, and Full Verification

**Files:**
- Modify: `lib/dispatch-wave.mjs` (orchestrator body, module header comments)
- Verify: `test/dispatch-wave.test.mjs`, full suite

- [ ] **Step 1: Verify the orchestrator is under 100 lines**

```bash
node -e "
const s = require('fs').readFileSync('lib/dispatch-wave.mjs','utf8');
const m = s.match(/export async function dispatchWaveViaFabric[\s\S]*?^}/m);
const lines = m ? m[0].split('\n').length : 'NOT FOUND';
console.log('orchestrator lines:', lines);
"
```

Expected: under 100 lines. If over, identify which inline logic was missed and move it into the appropriate stage.

- [ ] **Step 2: Run the full dispatch-wave + native suite**

```bash
node --test test/dispatch-wave.test.mjs test/dispatch-wave.native.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Run the full repository suite**

```bash
npm test
```

Expected: no new failures beyond the 2 pre-existing baseline frontmatter failures.

- [ ] **Step 4: Verify AGENTS.md and WORKLOG.md are untouched**

```bash
git status --short AGENTS.md WORKLOG.md
```

Expected: still dirty (user-owned), not staged by this work.

- [ ] **Step 5: Commit any final cleanup**

```bash
git add lib/dispatch-wave.mjs
git commit -m "refactor(dispatch): finalize orchestrator pipeline decomposition"
```

---

## Final Acceptance Check

- [ ] `dispatchWaveViaFabric` is under 100 lines and reads as a sequence of named, guarded stage calls.
- [ ] All 35 existing integration tests pass without modification.
- [ ] New unit tests cover `gateAndValidate`, `resolveWaveContext`, `buildDescriptors`, `acquireAndWatch`.
- [ ] No new module — all stages are private helpers within `lib/dispatch-wave.mjs`.
- [ ] No change to any external interface, outcome shape, or parameter list.
- [ ] `npm test` shows no new failures beyond the 2 pre-existing baseline.
- [ ] Agent-dispatch repository unchanged.
- [ ] User-owned `AGENTS.md` and `WORKLOG.md` remain untouched and unstaged.
