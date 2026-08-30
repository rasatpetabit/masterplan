# Concentrate Wave Launch Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated plan-index/config/env/prepareWave/MAIN derivation into one `buildWaveLaunchContext` function in `lib/wave.mjs`, consumed by both `continue.mjs` (PREPARE) and `dispatch-wave.mjs` (EXECUTE).

**Architecture:** Mechanics-only extraction — the shared function takes routing inputs as an injected parameter; each phase provides its own source (current opts vs persisted record). Routing/prepare only; review mode, baselines, fingerprint stay caller-specific.

**Tech Stack:** Node.js ESM, `node:test`, existing git test fixtures.

## Global Constraints

- Behavior-preserving: all existing integration tests pass without modification.
- The shared function lives in `lib/wave.mjs` — no new module.
- Retry-frozen-inputs guarantee preserved: EXECUTE constructs routingInputs from persisted record on retry.
- `reposAllowlist` is an optional injected parameter (PREPARE passes it; EXECUTE omits it).
- Do not modify agent-dispatch or any other repository.
- Do not modify or stage the user-owned `AGENTS.md` or `WORKLOG.md` changes.

---

### Task 1: Add `buildWaveLaunchContext` to `lib/wave.mjs` and migrate EXECUTE

**Files:**
- Modify: `lib/wave.mjs` (add `buildWaveLaunchContext`)
- Modify: `lib/dispatch-wave.mjs` (`resolveWaveContext` calls the shared function)
- Modify: `test/dispatch-wave.test.mjs` (add unit tests for the shared function)

**Interfaces:**
- Produces: `buildWaveLaunchContext({ state, planIndexPath, wave, routingInputs, reposAllowlist, _exec })`
- Returns: `{ prepared, planIndex, MAIN }`
- `routingInputs` shape: `{ routing: string, codex_host_suppressed: boolean, linked_worktree: boolean }`

- [ ] **Step 1: Write failing unit tests for buildWaveLaunchContext**

Add to `test/dispatch-wave.test.mjs` (or a new `test/wave-context.test.mjs`):

```js
import { buildWaveLaunchContext } from '../lib/wave.mjs';

test('buildWaveLaunchContext: throws on missing plan.index.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wctx-'));
  assert.throws(
    () => buildWaveLaunchContext({ state: { slug: 's' }, planIndexPath: path.join(dir, 'nope.json'), wave: 1, routingInputs: { routing: 'auto', codex_host_suppressed: false, linked_worktree: true } }),
    /plan.index.json not found/,
  );
});

test('buildWaveLaunchContext: returns prepared tasks + MAIN from injected routing inputs', () => {
  // Set up a fixture with plan.index.json, a git repo, and state.
  // Assert result has { prepared, planIndex, MAIN } and that config/env
  // were derived from the injected routingInputs (not from state.codex).
});

test('buildWaveLaunchContext: reposAllowlist is optional (omitted on fabric path)', () => {
  // Call without reposAllowlist; assert prepareWave still runs and returns tasks.
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test --test-name-pattern="buildWaveLaunchContext" test/dispatch-wave.test.mjs
```

Expected: FAIL — `buildWaveLaunchContext` is not exported.

- [ ] **Step 3: Implement buildWaveLaunchContext in lib/wave.mjs**

```js
export function buildWaveLaunchContext({
  state = {}, planIndexPath, wave, routingInputs = {}, reposAllowlist, _exec = execFileSync,
} = {}) {
  if (!planIndexPath) throw new Error('buildWaveLaunchContext: planIndexPath is required');
  const bundleDir = path.dirname(planIndexPath);
  let planIndex;
  try {
    planIndex = JSON.parse(fs.readFileSync(planIndexPath, 'utf8'));
  } catch (e) {
    if (!fs.existsSync(planIndexPath)) throw new Error(`plan.index.json not found at ${planIndexPath}`);
    throw new Error(`plan.index.json unreadable: ${e.message}`);
  }
  const config = {
    routing: routingInputs.routing ?? 'auto',
    implementer: state.implementer ?? {},
  };
  const env = {
    codexHostSuppressed: !!routingInputs.codex_host_suppressed,
    linkedWorktree: routingInputs.linked_worktree !== false,
  };
  const prepared = prepareWave(state, planIndex, wave, config, env, reposAllowlist);
  let MAIN;
  try {
    MAIN = path.dirname(String(_exec('git', ['-C', bundleDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })).trim());
  } catch {
    MAIN = path.resolve(state.worktree ?? bundleDir, '..', '..');
  }
  return { prepared, planIndex, MAIN };
}
```

- [ ] **Step 4: Run unit tests and verify GREEN**

```bash
node --test --test-name-pattern="buildWaveLaunchContext" test/dispatch-wave.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Migrate resolveWaveContext to call buildWaveLaunchContext**

In `lib/dispatch-wave.mjs`, replace the inline plan-index/config/env/prepareWave/MAIN code in `resolveWaveContext` with:

```js
const routingInputs = existing?.routing_inputs ?? {
  routing: state.codex?.routing ?? 'auto',
  codex_host_suppressed: !!codexSuppressed,
  linked_worktree: true,
};
const { prepared, MAIN } = buildWaveLaunchContext({
  state, planIndexPath, wave, routingInputs,
});
const tasks = prepared.tasks;
const WT = path.resolve(String(state.worktree ?? ''));
// ... existing validation ...
const inputs = _captureFingerprint(WT);
return { prepared, tasks, WT, MAIN, inputs, routingInputs };
```

Remove the now-dead inline code (plan-index read, config/env construction, prepareWave call, MAIN resolution).

- [ ] **Step 6: Run dispatch-wave tests and verify GREEN**

```bash
node --test test/dispatch-wave.test.mjs
```

Expected: 40+ pass (behavior preserved).

- [ ] **Step 7: Commit**

```bash
git add lib/wave.mjs lib/dispatch-wave.mjs test/dispatch-wave.test.mjs
git commit -m "refactor(wave): share launch context in EXECUTE phase"
```

---

### Task 2: Migrate PREPARE and verify full suite

**Files:**
- Modify: `lib/continue.mjs` (`dispatchWave` calls the shared function)
- Verify: `test/dispatch-wave.test.mjs`, full suite

- [ ] **Step 1: Migrate continue.mjs dispatchWave**

Replace the inline plan-index/config/env/prepareWave/MAIN code in `dispatchWave` with:

```js
const routingInputs = {
  routing: state.codex?.routing ?? opts.routing ?? 'auto',
  codex_host_suppressed: !!opts.codexSuppressed,
  linked_worktree: true,
};
let prepared, MAIN;
try {
  const ctx = buildWaveLaunchContext({
    state, planIndexPath, wave, routingInputs, reposAllowlist: opts.reposAllowlist,
  });
  prepared = ctx.prepared;
  MAIN = ctx.MAIN;
} catch (e) {
  return { op: 'ask', ask: 'dispatch-error', error: e.message };
}
```

Remove the now-dead inline code. Continue with phase-specific work (baseline, marker, op).

**Critical:** PREPARE passes `opts.routing` as a fallback in routingInputs (EXECUTE does not). This difference is intentional — preserve it.

- [ ] **Step 2: Run dispatch-wave + continue tests**

```bash
node --test test/dispatch-wave.test.mjs test/dispatch-wave.native.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: no new failures beyond the 2 pre-existing baseline.

- [ ] **Step 4: Verify AGENTS.md and WORKLOG.md untouched**

```bash
git status --short AGENTS.md WORKLOG.md
```

Expected: still dirty (user-owned), not staged.

- [ ] **Step 5: Commit**

```bash
git add lib/continue.mjs
git commit -m "refactor(wave): share launch context in PREPARE phase"
```

---

## Final Acceptance Check

- [ ] `buildWaveLaunchContext` is the single implementation of plan-index reading, config/env construction, prepareWave invocation, and MAIN resolution.
- [ ] `continue.mjs` and `dispatch-wave.mjs` no longer duplicate these five steps.
- [ ] The retry-frozen-inputs guarantee is preserved (EXECUTE constructs routingInputs from persisted record on retry).
- [ ] All existing integration tests pass without modification.
- [ ] New unit tests cover `buildWaveLaunchContext`.
- [ ] No new module — the function lives in `lib/wave.mjs`.
- [ ] Agent-dispatch repository unchanged.
- [ ] User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- [ ] `npm test` shows no new failures beyond the 2 pre-existing baseline.
