# qctl Implementer-Backend Seam (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pluggable implementer-backend seam to the masterplan plugin so an execute wave (and, by prose, a github-coordination follower) can resolve a per-task dispatch backend — defaulting to today's agent, optionally a qctl (Qwen Work Fabric) worker behind a default-off flag.

**Architecture:** A kind-discriminated descriptor (a tagged union, NO new registry) produced by a new pure resolver `resolveImplementerBackend(task, config, env)` in `lib/routing.mjs`, a sibling of `routeTask`. `mp prepare-wave` (L1) stamps the descriptor onto each lean wave-payload task; `execute.workflow.js` `implement(t)` gains a single top guard that handles a `qctl` descriptor as **NotYetBound** (a `blocked` digest — the live qctl binding is deferred until the fabric ships `qctl`+`gate.py`) and otherwise runs **today's dispatch path byte-for-byte unchanged**. The flag (`config.implementer.qctl.enabled`, strict `=== true`) is the sole predicate; it is sourced from `state.implementer`, which `buildSeedState` never emits.

**Tech Stack:** Node.js ESM (named exports, `??` nullish, default params), `node --test` runner, `node:assert/strict`. Zero new dependencies. Durable state via the existing flat-YAML `lib/bundle.mjs` (de)serializer (schema-agnostic top-level keys — `state.implementer` round-trips cleanly).

---

## Hard Invariant (the crown jewel — re-check it at every task)

**With the flag off, masterplan ships byte-for-byte identical to today.**

- `buildSeedState` never writes `implementer`, so every existing/new bundle has `state.implementer === undefined` → `state.implementer ?? {}` is `{}` → `resolveImplementerBackend` returns `{ kind: 'agent' }` → the `execute.workflow.js` guard is never taken → the dispatch path is unchanged.
- The descriptor's `agent` kind carries **only** `{ kind: 'agent' }`. It deliberately does NOT restate `agentType`/`model` — those stay in the existing prod-inert `implAgentType`/`implModel` seam (`execute.workflow.js` lines 66-69, commit `561f348`), which this plan **leaves untouched**. The dogfood override test must still pass unchanged.

## Branch + constraints

- **Branch:** `qctl-implementer-backend` in `/srv/dev/ras/masterplan` (already checked out; the design spec is committed at `12f6d11`). All work stays on this branch.
- **A Codex defect pass runs before declaring done** (Task 7). **Nothing is pushed without explicit user approval.**
- This is a Petabit-owned repo, NOT a `yanos-*` repo — the umbrella YANOS codex-review *policy* does not apply, but the user's "masterplan source changes get a Codex defect pass" constraint does.

## File Structure

| File | Disposition | Responsibility (this change) |
|---|---|---|
| `lib/routing.mjs` | Modify (append export) | Add `resolveImplementerBackend(task, config, env)` — the dispatch-descriptor producer, sibling to `routeTask`. |
| `lib/wave.mjs` | Modify | Import the resolver; `leanPayload` gains a `backend` param+key; `prepareWave` calls the resolver per task. |
| `bin/masterplan.mjs` | Modify (1 line + comment) | `prepare-wave` case: thread `implementer: state.implementer ?? {}` into the `config` passed to `prepareWave`. |
| `workflows/execute.workflow.js` | Modify (guard block) | `implement(t)` gains a single top guard: `qctl` kind → NotYetBound blocked digest; else byte-identical dispatch. |
| `commands/masterplan.md` | Modify (prose) | `follow` verb step 3: resolve the descriptor instead of hard-coding `mp-implementer`. |
| `docs/config-schema.md` | Modify (insert block) | Document the default-off `implementer.qctl.enabled` flag. |
| `test/routing.test.mjs` | Modify (add tests) | Resolver truth table. |
| `test/wave.test.mjs` | Modify (add tests) | Backend attachment + key-set. |
| `test/bin-masterplan.test.mjs` | Modify (add tests) | `state.implementer` → backend threading through the real CLI. |
| `test/execute-workflow.test.mjs` | Modify (add tests) | NotYetBound + byte-identical-default + dogfood-override-wins. |

---

### Task 1: `resolveImplementerBackend` resolver (`lib/routing.mjs`)

**Files:**
- Modify: `lib/routing.mjs` (append a new export after `routeTask`, which ends at line 60)
- Test: `test/routing.test.mjs` (add `resolveImplementerBackend` to the import on line 7; append tests)

- [ ] **Step 1: Write the failing tests**

In `test/routing.test.mjs`, change the import on line 7 from:

```js
import { routeTask } from '../lib/routing.mjs';
```

to:

```js
import { routeTask, resolveImplementerBackend } from '../lib/routing.mjs';
```

Then append these tests to the end of the file:

```js
// --- resolveImplementerBackend: the dispatch-backend descriptor (sibling of routeTask) ---
// A tagged union: {kind:'agent'} reproduces shipping (agentType/model live in the
// execute.workflow.js seam, NOT here); {kind:'qctl'} only when the flag is strictly true.
test('resolveImplementerBackend: default (no implementer config) -> {kind:agent}', () => {
  assert.deepEqual(resolveImplementerBackend(clean(), {}, {}), { kind: 'agent' });
});

test('resolveImplementerBackend: qctl flag false -> {kind:agent}', () => {
  assert.deepEqual(
    resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: false } } }, {}),
    { kind: 'agent' },
  );
});

test('resolveImplementerBackend: any non-true enabled value -> {kind:agent} (strict === true)', () => {
  for (const v of [undefined, null, 'true', 'on', 1, {}, 'enabled']) {
    assert.deepEqual(
      resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: v } } }, {}),
      { kind: 'agent' },
      `enabled=${JSON.stringify(v)} must NOT activate qctl`,
    );
  }
});

test('resolveImplementerBackend: qctl flag === true -> {kind:qctl} with scope/verify/deliver', () => {
  const d = resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: true } } }, {});
  assert.equal(d.kind, 'qctl');
  assert.deepEqual(d.scope, ['a.js']);          // == task.files
  assert.deepEqual(d.verify, ['node --test']);  // == task.verify_commands
  assert.equal(d.deliver, 'patch');
});

test('resolveImplementerBackend: qctl descriptor carries NO repo/base (binding-time fields, spec §4/B1)', () => {
  const d = resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: true } } }, {});
  assert.equal('repo' in d, false, 'repo is stamped at binding time, not by the resolver');
  assert.equal('base' in d, false, 'base is stamped at binding time, not by the resolver');
});

test('resolveImplementerBackend: empty task -> scope/verify default to []', () => {
  const d = resolveImplementerBackend({}, { implementer: { qctl: { enabled: true } } }, {});
  assert.deepEqual(d.scope, []);
  assert.deepEqual(d.verify, []);
  assert.equal(d.deliver, 'patch');
});

test('resolveImplementerBackend: does not mutate inputs', () => {
  const task = clean();
  const config = { implementer: { qctl: { enabled: true } } };
  const ft = JSON.stringify(task);
  const fc = JSON.stringify(config);
  resolveImplementerBackend(task, config, {});
  assert.equal(JSON.stringify(task), ft);
  assert.equal(JSON.stringify(config), fc);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/routing.test.mjs`
Expected: FAIL — `resolveImplementerBackend` is not exported (`SyntaxError: ... does not provide an export named 'resolveImplementerBackend'`, or the new tests error on calling `undefined`).

- [ ] **Step 3: Write the minimal implementation**

In `lib/routing.mjs`, append after `routeTask` (after the closing `}` on line 60):

```js

// resolveImplementerBackend — the dispatch-descriptor sibling of routeTask. Where routeTask's
// `target` is log-only, THIS picks the implementer backend a wave actually dispatches to. A tagged
// union, NOT a registry: {kind:'agent'} reproduces shipping byte-for-byte (agentType/model stay in
// the execute.workflow.js seam, commit 561f348 — the descriptor never restates fields the dispatch
// site already holds); {kind:'qctl'} is emitted ONLY when the flag is strictly true, and carries
// only task-intrinsic fields (repo/base are binding-time, stamped by the consumer — see spec §4/B1).
// Default OFF ⇒ only {kind:'agent'} is ever emitted ⇒ production is unchanged. The `env` param is
// kept for routeTask symmetry + the deferred binding-time crossing; it is intentionally unused today.
export function resolveImplementerBackend(task = {}, config = {}, env = {}) {
  if (config.implementer?.qctl?.enabled === true) {
    return { kind: 'qctl', scope: task.files ?? [], verify: task.verify_commands ?? [], deliver: 'patch' };
  }
  return { kind: 'agent' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/routing.test.mjs`
Expected: PASS — all routing tests green (the pre-existing `routeTask` tests + the 7 new resolver tests).

- [ ] **Step 5: Commit**

```bash
git add lib/routing.mjs test/routing.test.mjs
git commit -m "feat(routing): resolveImplementerBackend descriptor (default agent; qctl behind flag)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Attach the backend descriptor in `prepareWave` (`lib/wave.mjs`)

**Files:**
- Modify: `lib/wave.mjs` (import line 26; `leanPayload` lines 30-40; `prepareWave` line 75)
- Test: `test/wave.test.mjs` (key-set test lines 55-61; append attachment tests)

- [ ] **Step 1: Write the failing tests**

In `test/wave.test.mjs`, update the key-set assertion (currently lines 57-60) to include `'backend'`:

```js
test('prepareWave emits ONLY the lean payload keys (goal 3 — nothing heavy transits context)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  assert.deepEqual(
    Object.keys(tasks[0]).sort(),
    ['backend', 'description', 'eligible', 'files', 'id', 'reason', 'target', 'verify_commands'],
  );
});
```

Then append these two tests to the end of the file:

```js
// --- prepareWave: the implementer-backend descriptor (resolveImplementerBackend) ---
test('prepareWave attaches a {kind:agent} backend to every task by default (flag off)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  assert.ok(tasks.length >= 1);
  for (const t of tasks) assert.deepEqual(t.backend, { kind: 'agent' });
});

test('prepareWave attaches a {kind:qctl} backend when implementer.qctl.enabled (scope == task.files)', () => {
  const { tasks } = prepareWave(
    state(), planIndex(), 0,
    { routing: 'auto', implementer: { qctl: { enabled: true } } }, {},
  );
  const t1 = tasks.find((t) => t.id === 1);
  assert.equal(t1.backend.kind, 'qctl');
  assert.deepEqual(t1.backend.scope, ['a.js']);          // task 1's plan.index files
  assert.deepEqual(t1.backend.verify, ['node --test']);  // task 1's verify_commands
  assert.equal(t1.backend.deliver, 'patch');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/wave.test.mjs`
Expected: FAIL — the key-set test fails (`backend` missing from actual keys) and the two new tests fail (`t.backend` is `undefined`).

- [ ] **Step 3: Write the minimal implementation**

In `lib/wave.mjs`, update the import on line 26 from:

```js
import { routeTask } from './routing.mjs';
```

to:

```js
import { routeTask, resolveImplementerBackend } from './routing.mjs';
```

Update `leanPayload` (lines 30-40) to take a 4th `backend` param and emit it:

```js
function leanPayload(stateTask, planTask, route, backend) {
  return {
    id: stateTask.id,
    description: planTask.description ?? '',
    files: planTask.files ?? stateTask.files ?? [],
    verify_commands: planTask.verify_commands ?? [],
    target: route.target,
    eligible: route.eligible,
    reason: route.reason,
    backend,
  };
}
```

Update the `prepareWave` return on line 75 from:

```js
    return leanPayload(st, p, routeTask(merged, config, env));
```

to:

```js
    return leanPayload(st, p, routeTask(merged, config, env), resolveImplementerBackend(merged, config, env));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/wave.test.mjs`
Expected: PASS — all wave tests green (the pre-existing `prepareWave`/`declaredScope`/`verifyScope` tests + the updated key-set test + the 2 new attachment tests).

- [ ] **Step 5: Commit**

```bash
git add lib/wave.mjs test/wave.test.mjs
git commit -m "feat(wave): stamp per-task implementer backend on the wave payload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Thread `state.implementer` into the prepare-wave config (`bin/masterplan.mjs`)

**Files:**
- Modify: `bin/masterplan.mjs` (`prepare-wave` case, the `config` object on line 502)
- Test: `test/bin-masterplan.test.mjs` (append two CLI-level tests)

This is the ONLY coverage of the `state.implementer ?? {}` wire end-to-end through the real CLI (the `wave.test` cases pass `config` directly, bypassing the bin). `parseState`/`serializeState`/`loadForWrite` are schema-agnostic, so `state.implementer` round-trips.

- [ ] **Step 1: Write the failing tests**

In `test/bin-masterplan.test.mjs`, append these two tests to the end of the file. They reuse the existing `tmpDir`, `run`, `serializeState`, `v8`, and `planIndexFixture` helpers already defined in the file.

```js
// --- prepare-wave: state.implementer threads to a per-task backend descriptor (the bin wire) ---
// wave.test passes config directly; THIS proves the state.implementer -> config -> backend wire
// through the real CLI. buildSeedState never emits `implementer`, so the default is byte-identical.
test('prepare-wave: default (no implementer in state) -> every payload task carries backend {kind:agent}', () => {
  const dir = tmpDir('mp-backend-default-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8()));                 // v8(): task 1 wave 0, task 2 wave 1
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const pw = JSON.parse(run(['prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0']).stdout);
  assert.ok(pw.tasks.length >= 1);
  for (const t of pw.tasks) assert.deepEqual(t.backend, { kind: 'agent' });
});

test('prepare-wave: state.implementer.qctl.enabled=true -> backend {kind:qctl} (scope==task.files, deliver=patch)', () => {
  const dir = tmpDir('mp-backend-qctl-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ implementer: { qctl: { enabled: true } } })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const pw = JSON.parse(run(['prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0']).stdout);
  const t1 = pw.tasks.find((t) => t.id === 1);
  assert.equal(t1.backend.kind, 'qctl');
  assert.deepEqual(t1.backend.scope, ['src/greet.mjs']);   // task 1's plan.index files
  assert.deepEqual(t1.backend.verify, ['true']);           // task 1's verify_commands
  assert.equal(t1.backend.deliver, 'patch');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/bin-masterplan.test.mjs`
Expected: FAIL — the qctl test fails (`t1.backend.kind` is `'agent'`, not `'qctl'`, because `config.implementer` is not yet threaded). The default test will already pass once Task 2 is in (backend is attached), which is fine — the qctl test is the one that drives this task.

- [ ] **Step 3: Write the minimal implementation**

In `bin/masterplan.mjs`, in the `prepare-wave` case, replace the `config` declaration on line 502:

```js
      const config = { routing: state.codex?.routing ?? flags.routing ?? 'auto' };
```

with:

```js
      const config = {
        routing: state.codex?.routing ?? flags.routing ?? 'auto',
        // Pluggable implementer backend (contract-first; default OFF). Always {} today since
        // buildSeedState never emits `implementer` -> resolveImplementerBackend returns
        // {kind:'agent'} -> byte-identical to shipping. Flipping the live qctl binding is a
        // binding-time concern (design spec §5).
        implementer: state.implementer ?? {},
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/bin-masterplan.test.mjs`
Expected: PASS — all bin tests green, including both new prepare-wave backend tests.

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan.mjs test/bin-masterplan.test.mjs
git commit -m "feat(bin): thread state.implementer into prepare-wave config (default {})

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: NotYetBound guard in `implement(t)` (`workflows/execute.workflow.js`)

**Files:**
- Modify: `workflows/execute.workflow.js` (`implement(t)`, the function starting at line 160 — add a guard before `let digest = null;` on line 161)
- Test: `test/execute-workflow.test.mjs` (append three tests)

The guard is the ONLY change to the dispatch path. For an `agent` kind (and the absent-`backend` legacy path) the function is byte-identical to today; the `implAgentType`/`implModel` seam (lines 66-69) is left untouched. A `qctl` kind returns a **blocked digest** (not a throw — a throw nulls the pipeline item, causing a silent vanish → re-dispatch loop).

- [ ] **Step 1: Write the failing tests**

In `test/execute-workflow.test.mjs`, append these fixtures and tests to the end of the file:

```js
// --- IMPLEMENTER BACKEND (contract-first seam) ---
// A wave task now carries a `backend` descriptor (stamped by prepareWave). implement(t) switches on
// backend.kind: 'qctl' -> NotYetBound blocked digest, NO agent; 'agent' (and the absent-backend
// legacy path) -> today's dispatch, byte-for-byte unchanged (the implAgentType/implModel seam still
// governs agentType/model).
const QCTL_TASK = {
  id: 1, description: 'greet', files: ['src/greet.mjs'], verify_commands: [],
  target: 'inline', reason: 'judgment',
  backend: { kind: 'qctl', scope: ['src/greet.mjs'], verify: [], deliver: 'patch' },
};
const AGENT_TASK = {
  id: 1, description: 'greet', files: ['src/greet.mjs'], verify_commands: [],
  target: 'inline', reason: 'judgment',
  backend: { kind: 'agent' },
};

test('qctl backend -> NotYetBound: recorded blocked, NO agent dispatched (contract-first guard)', async () => {
  const args = { wave: 1, tasks: [QCTL_TASK], baseline: [], repoRoot: '/tmp/x', review: 'off' };
  const { result, calls } = await runEngine(args);
  assert.equal(calls.agent, 0, 'a qctl backend dispatches NO implementer agent (not yet bound)');
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.done, 0);
  assert.equal(result.summary.failed, 1, 'a blocked task counts toward not-done');
  assert.equal(result.tasks[0].digest.status, 'blocked');
  assert.equal(result.tasks[0].digest.blockers, 'qctl-not-bound');
});

test('agent backend (flag off) -> today’s dispatch byte-identical: mp-implementer, no model override', async () => {
  const args = { wave: 1, tasks: [AGENT_TASK], baseline: [], repoRoot: '/tmp/x', review: 'off' };
  const { result, calls } = await runEngine(args);
  assert.equal(calls.agent, 1, 'agent backend dispatches the implementer exactly as today');
  assert.equal(result.summary.done, 1);
  assert.equal(calls.agentPrompts[0].opts.agentType, 'masterplan:mp-implementer');
  assert.equal('model' in calls.agentPrompts[0].opts, false, 'no model override in prod (frontmatter governs)');
});

test('agent backend + dogfood implAgentType/implModel args -> the seam still wins (backend never restates them)', async () => {
  const args = JSON.stringify({
    wave: 1, tasks: [AGENT_TASK], baseline: [], repoRoot: '/tmp/x', review: 'off',
    implAgentType: 'general-purpose', implModel: 'sonnet',
  });
  const { calls } = await runEngine(args);
  assert.equal(calls.agent, 1);
  assert.equal(calls.agentPrompts[0].opts.agentType, 'general-purpose', 'dogfood seam overrides — {kind:agent} carries no agentType');
  assert.equal(calls.agentPrompts[0].opts.model, 'sonnet');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/execute-workflow.test.mjs`
Expected: FAIL — the `qctl backend -> NotYetBound` test fails: without the guard, the engine dispatches the implementer (`calls.agent` is 1, not 0) and records `done`/`failed` per the mock digest, never producing a `blocked`/`qctl-not-bound` digest. (The two `agent`-kind tests will already pass — the guard does not change the agent path — and serve as byte-identical regression guards.)

- [ ] **Step 3: Write the minimal implementation**

In `workflows/execute.workflow.js`, in `implement(t)` (starts line 160), insert the guard as the **first statement of the function body**, immediately before `let digest = null;` (line 161):

```js
async function implement(t) {
  // CONTRACT-FIRST SEAM (design spec §A3/§5): a qctl-backed task has no live binding yet — the Qwen
  // Work Fabric must ship `qctl` (task 11) + `gate.py` (task 12) first, and the workflow itself cannot
  // shell `qctl`/`git apply`. Record a NotYetBound *blocked* digest (NOT a throw: a throw nulls the
  // pipeline item -> silent vanish -> re-dispatch loop; a blocked digest fails loud via L1's surface).
  // Flag off -> prepareWave only ever stamps {kind:'agent'}, so this guard is never taken in prod.
  if (t.backend?.kind === 'qctl') {
    log(`  task ${t.id}: qctl backend NOT YET BOUND (contract-first) -> recorded blocked`);
    return {
      task_id: t.id,
      target: t.target,
      digest: {
        task_id: t.id,
        status: 'blocked',
        files_changed: [],
        summary: 'qctl implementer backend not yet bound (contract-first stub — see design spec §A3/§5)',
        blockers: 'qctl-not-bound',
      },
      review: null,
    };
  }
  let digest = null;
  const opts = { label: `impl:task-${t.id}`, phase: 'Dispatch', agentType: implAgentType, schema: IMPL_DIGEST };
  if (implModel) opts.model = implModel; // omitted in prod → frontmatter model governs (see seam note)
  try {
    digest = await agent(implementerPrompt(t), opts);
  } catch (e) {
    log(`  task ${t.id}: implementer dispatch errored (${String(e?.message ?? e)})`);
  }
  if (!digest) {
    // Skipped (user) or errored: synthesize a failed digest so the task is RECORDED + surfaced.
    // L1 leaves it pending → the next decide recovers + re-dispatches it idempotently.
    log(`  task ${t.id}: no digest (skipped/errored) → recorded failed`);
    return {
      task_id: t.id,
      target: t.target,
      digest: { task_id: t.id, status: 'failed', files_changed: [], summary: 'no digest (agent skipped or errored)', blockers: 'no-digest' },
      review: null,
    };
  }
  return { task_id: t.id, target: t.target, digest, review: null };
}
```

> **Edit note:** the lines from `let digest = null;` onward are the *existing* body, reproduced here unchanged so the engineer sees the full function after the edit. The only addition is the leading `if (t.backend?.kind === 'qctl') { … }` block. Do not duplicate the existing body — insert only the guard.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/execute-workflow.test.mjs`
Expected: PASS — all execute-workflow tests green, including the 3 new backend tests and every pre-existing test (string-args, object-args, empty-wave, scoped-diff hardening).

- [ ] **Step 5: Commit**

```bash
git add workflows/execute.workflow.js test/execute-workflow.test.mjs
git commit -m "feat(execute): NotYetBound guard for qctl backend (agent path byte-identical)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Resolve the descriptor in the `follow` prose (`commands/masterplan.md`)

**Files:**
- Modify: `commands/masterplan.md` (the `follow` verb table row, line 354 — step 3)

This is command prose, not executable code, so verification is a `grep` rather than a unit test. The follower is a full agentic session (it *can* shell), making it the natural binding-time consumer; the prose must stop hard-coding `mp-implementer` and resolve the descriptor, surfacing a `qctl` task as blocked with **no** silent fallback.

- [ ] **Step 1: Make the edit**

In `commands/masterplan.md`, in the `follow` row, find this exact substring within step 3 (on line 354):

```
dispatch the existing `mp-implementer` agent + D6 `verify-scope` + `verify_commands`.
```

Replace it with:

```
resolve the implementer backend via `resolveImplementerBackend(task, config, env)` (config = `{ implementer: state.implementer ?? {} }`): `{kind:'agent'}` (the default — flag off, **identical to today**) → dispatch the existing `mp-implementer` agent; `{kind:'qctl'}` → **NotYetBound** (the qctl worker is not yet bound — design spec §A4/§5): comment the blocker on the issue, release the claim (`gh label remove mp:claimed`; `gh label add mp:open`), and surface the task as blocked — **never** silently fall back to `mp-implementer`. Then D6 `verify-scope` + `verify_commands`.
```

- [ ] **Step 2: Verify the edit landed and the old phrasing is gone**

Run:
```bash
grep -n 'resolveImplementerBackend' commands/masterplan.md
grep -n 'dispatch the existing `mp-implementer` agent + D6' commands/masterplan.md || echo 'OLD PHRASING GONE (good)'
```
Expected: the first `grep` prints the line 354 match; the second prints `OLD PHRASING GONE (good)`.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "docs(follow): resolve implementer backend instead of hard-coding mp-implementer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Document the flag (`docs/config-schema.md`)

**Files:**
- Modify: `docs/config-schema.md` (insert a top-level `implementer:` block after the `codex:` block, which ends at line 119, before the `# Intra-plan task parallelism` comment at line 121)

- [ ] **Step 1: Make the edit**

In `docs/config-schema.md`, the `codex:` block ends at line 119 and a blank line 120 separates it from the `# Intra-plan task parallelism (v2.0.0+)` comment on line 121. Insert the following block on the blank line 120 (so it sits between the `codex:` block and the `# Intra-plan` comment, each separated by a blank line):

```yaml
# Pluggable implementer backend (contract-first; default OFF) — design spec:
# docs/superpowers/specs/2026-06-01-qctl-implementer-backend-design.md
# When qctl.enabled is true, `mp prepare-wave` stamps a {kind:'qctl'} backend descriptor on each
# wave task instead of the default {kind:'agent'}. The LIVE qctl binding is DEFERRED until the Qwen
# Work Fabric ships `qctl` + `gate.py`; until then a qctl-kind task is recorded blocked (NotYetBound).
# buildSeedState never emits this key, so an absent block == default-off == byte-identical to today.
implementer:
  qctl:
    enabled: false           # off | true (strict === true) — true offloads task implementation to
                             # the Qwen pi/qctl worker. Any non-true value behaves as false.
```

- [ ] **Step 2: Verify the edit landed**

Run:
```bash
grep -n 'implementer:' docs/config-schema.md
grep -n 'qctl:' docs/config-schema.md
grep -n 'enabled: false' docs/config-schema.md
```
Expected: each `grep` prints the inserted line(s) — `implementer:`, `qctl:`, and `enabled: false` all present.

- [ ] **Step 3: Commit**

```bash
git add docs/config-schema.md
git commit -m "docs(config): document implementer.qctl.enabled flag (default off)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Full-suite green + byte-identical audit + Codex defect pass

**Files:** none modified (verification + review only).

- [ ] **Step 1: Run the full test suite**

Run: `node --test`
Expected: PASS — the entire masterplan suite green (the prior baseline plus the new resolver/wave/bin/execute tests). Zero failures. If any test fails, fix it before proceeding — do not declare done on a red suite.

- [ ] **Step 2: Byte-identical audit (the hard invariant)**

Confirm that with the flag off nothing in the dispatch path changed beyond additive seams. Inspect the diff:

Run: `git diff main...qctl-implementer-backend -- lib/routing.mjs lib/wave.mjs bin/masterplan.mjs workflows/execute.workflow.js`

Manually verify, against the diff:
- `lib/routing.mjs`: `routeTask` is untouched; only `resolveImplementerBackend` is **added**.
- `lib/wave.mjs`: the only behavioral change is the added `backend` payload key; existing keys/routing unchanged.
- `bin/masterplan.mjs`: the `config` object only **gains** `implementer: state.implementer ?? {}` — `routing` is unchanged.
- `workflows/execute.workflow.js`: the dogfood seam (lines 66-69) is **unchanged**; `implement(t)` only gains the leading `if (t.backend?.kind === 'qctl')` guard; the rest of the function is byte-for-byte the same.

Then confirm `buildSeedState` still never emits `implementer` (so existing bundles are unchanged):

Run: `grep -n 'implementer' lib/bundle.mjs bin/masterplan.mjs`
Expected: matches appear ONLY in the `prepare-wave` config thread (Task 3) and any comments — **never** inside `buildSeedState`/`seed`. If `buildSeedState` emits `implementer`, the invariant is broken — stop and fix.

- [ ] **Step 3: Codex defect pass (mandatory before declaring done)**

The masterplan source diff is committed to the branch, so review with **branch scope** against `main` (avoids dragging in unrelated dirty files):

Run the Codex companion in the background (resolve `${CLAUDE_PLUGIN_ROOT}` to the codex plugin cache path; `scripts/codex-scan.sh` in sibling repos already does this resolution):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --scope branch --base main --wait
```

Triage the findings: fix real defects (new commit on the branch), record any false positives with a one-line rationale. Do NOT push.

- [ ] **Step 4: Final report**

Summarize: suite result (cite the pass count + exit 0), the byte-identical audit outcome, and the Codex verdict. State plainly that nothing is pushed and the branch awaits the user's disposition decision (`finishing-a-development-branch`).

---

## Notes for the executor

- **Order matters:** Task 1 → 2 → 3 → 4 are dependency-ordered (wave imports the resolver; bin threads config the resolver reads; the execute guard reads the stamped backend). Tasks 5 and 6 are prose/docs and independent — they may run any time after Task 1. Task 7 is last.
- **Do not touch the dogfood seam** (`execute.workflow.js` lines 66-69). The `agent` descriptor deliberately carries no `agentType`/`model`; that seam is their sole owner.
- **`blocked` is not a writable `mark-task` status** in production L1 — but that is irrelevant here: the qctl path is flag-off in prod, and the blocked digest is surfaced (not recorded as a task status) when reached. The tests exercise it via the in-process engine harness, not the CLI.
- **Nothing is pushed without explicit user approval.** Task 7 ends at a clean local branch.
