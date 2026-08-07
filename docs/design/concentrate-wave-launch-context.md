# Concentrate wave launch context

**Status:** Implemented

**Implemented:** 2026-08-07 (see commits and corresponding `docs/superpowers/plans/` plan doc)

## Purpose

`continue.mjs` (PREPARE phase) and `dispatch-wave.mjs` (EXECUTE phase) independently derive the same wave launch facts: read `plan.index.json`, construct `config`/`env` from routing inputs, call `prepareWave`, and resolve MAIN via `git rev-parse --git-common-dir`. A comment ("mirror continue.mjs's dispatchWave inputs byte-for-byte") is the only parity contract. This change concentrates the shared mechanics into one function in `lib/wave.mjs` so both phases consume it by injection, making parity a construction guarantee rather than a documented invariant.

## Goals

1. Eliminate duplicated plan-index reading, config/env construction, prepareWave invocation, and MAIN resolution.
2. Make routing-input parity a construction guarantee (both phases call one function).
3. Preserve the retry-frozen-inputs guarantee: EXECUTE uses persisted `routing_inputs`; PREPARE uses current opts.
4. Preserve every existing behavior — all tests pass without modification.

## Non-goals

- Sharing review-mode normalization, baseline capture, fingerprint, or marker writes — these have different sources per phase.
- Creating a new module — the function lives in `lib/wave.mjs` (already imported by both callers).
- Changing `prepareWave`'s interface or the `reposAllowlist` parameter.
- Editing agent-dispatch or any other repository.

## Resolved design decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Shared scope | Mechanics only (plan index, config/env, prepareWave, MAIN); source injected | Retry-frozen-inputs guarantee requires each phase to control its routing-input source |
| Module home | `lib/wave.mjs` | Already owns prepareWave; both callers already import from it |
| Boundary | Routing/prepare only | Review mode, baselines, fingerprint have different sources per phase |
| Error handling | Shared function throws; callers catch if they need a different shape | PREPARE catches to convert to `{op:'ask'}`; EXECUTE lets it propagate |
| `reposAllowlist` | Optional injected parameter | PREPARE passes it; EXECUTE omits it (fabric path defers routing to broker) |

## Current architecture

**PREPARE** (`continue.mjs:dispatchWave`, lines 506–565):
- Reads `plan.index.json`.
- Builds `config = { routing: state.codex?.routing ?? opts.routing ?? 'auto', implementer }`.
- Builds `env = { codexHostSuppressed: !!opts.codexSuppressed, linkedWorktree: true }`.
- Calls `prepareWave(state, planIndex, wave, config, env, opts.reposAllowlist)`.
- Resolves MAIN via `runGit(wt.WT, ['rev-parse', '--git-common-dir'])`.
- Then does phase-specific work: capture baseline, workspace-root baseline, write marker, return op.

**EXECUTE** (`dispatch-wave.mjs:resolveWaveContext`, lines 746–831):
- Reads `plan.index.json`.
- Builds `routingInputs` from persisted record (retry) or current flags (fresh).
- Builds `config = { routing: routingInputs.routing, implementer }`.
- Builds `env = { codexHostSuppressed, linkedWorktree }`.
- Calls `prepareWave(state, planIndex, wave, config, env)` — no `reposAllowlist`.
- Resolves MAIN via `execFileSync('git', ['-C', bundleDir, 'rev-parse', '--git-common-dir'])`.
- Returns context for descriptor construction.

Both phases independently implement the same five steps with a comment-only parity contract.

## Proposed architecture

Add one exported function to `lib/wave.mjs`:

```js
export function buildWaveLaunchContext({
  state, planIndexPath, wave, routingInputs, reposAllowlist,
  _exec = execFileSync,
} = {}) {
  // 1. Read plan.index.json (throw on missing/unreadable)
  // 2. Build config from routingInputs: { routing, implementer: state.implementer ?? {} }
  // 3. Build env from routingInputs: { codexHostSuppressed, linkedWorktree }
  // 4. Call prepareWave(state, planIndex, wave, config, env, reposAllowlist)
  // 5. Resolve MAIN via _exec('git', ['-C', bundleDir, 'rev-parse', ...]) or fallback
  // 6. Return { prepared, planIndex, MAIN }
}
```

`routingInputs` is a normalized object both callers construct:
```js
{ routing: string, codex_host_suppressed: boolean, linked_worktree: boolean }
```

**PREPARE** constructs routingInputs from current opts and calls `buildWaveLaunchContext` inside a try/catch (converting throws to `{op:'ask'}`). It continues with its phase-specific work (baseline, marker, op).

**EXECUTE** constructs routingInputs from persisted record (retry) or current flags (fresh), calls `buildWaveLaunchContext`, and lets throws propagate. It continues with its phase-specific work (fingerprint, descriptors, acquire).

### What stays caller-specific

| Concern | PREPARE owner | EXECUTE owner |
|---|---|---|
| Review mode | `continue.mjs` (with `opts.review` fallback) | `dispatch-wave.mjs` orchestrator (no `opts.review`) |
| MAIN source path | `wt.WT` | `bundleDir` |
| Baselines | `continue.mjs` (multi-repo + workspace root) | N/A (watch precheck in `acquireAndWatch`) |
| Fingerprint | N/A | `dispatch-wave.mjs` (`captureInputFingerprint`) |
| Marker/op | `continue.mjs` (write marker, return op) | N/A |

The MAIN source path is resolved by the shared function from the path it receives — PREPARE passes `wt.WT`, EXECUTE passes `bundleDir`. Both resolve to the same git-common-dir.

## Error handling

The shared function throws on missing/unreadable `plan.index.json` and on `prepareWave` failures (drift, collision). PREPARE wraps the call in try/catch to convert throws to `{ op: 'ask', ask: 'dispatch-error', error: e.message }`. EXECUTE lets throws propagate to the orchestrator's caller.

## Code changes

### `lib/wave.mjs`

- Add `buildWaveLaunchContext({ state, planIndexPath, wave, routingInputs, reposAllowlist, _exec })`.
- The function reads plan index, builds config/env, calls `prepareWave`, resolves MAIN, returns the context.

### `lib/continue.mjs`

- `dispatchWave` constructs routingInputs from opts and calls `buildWaveLaunchContext` inside a try/catch.
- Removes the inline plan-index read, config/env construction, prepareWave call, and MAIN resolution.
- Continues with its phase-specific work (baseline, marker, op).

### `lib/dispatch-wave.mjs`

- `resolveWaveContext` constructs routingInputs (persisted priority) and calls `buildWaveLaunchContext`.
- Removes the inline plan-index read, config/env construction, prepareWave call, and MAIN resolution.
- Continues with its phase-specific work (fingerprint, return context).

### Tests

- All existing integration tests pass without modification (behavior-preserving refactor).
- Add focused unit tests for `buildWaveLaunchContext` (missing plan index throws, config/env from injected routing inputs, MAIN resolution, prepareWave delegation).

## Acceptance criteria

- `buildWaveLaunchContext` is the single implementation of plan-index reading, config/env construction, prepareWave invocation, and MAIN resolution.
- `continue.mjs` and `dispatch-wave.mjs` no longer duplicate these five steps.
- The retry-frozen-inputs guarantee is preserved (EXECUTE constructs routingInputs from persisted record on retry).
- All existing integration tests pass without modification.
- New unit tests cover `buildWaveLaunchContext`.
- No new module — the function lives in `lib/wave.mjs`.
- Agent-dispatch repository unchanged.
- User-owned `AGENTS.md` and `WORKLOG.md` remain untouched.
- `npm test` shows no new failures beyond the 2 pre-existing baseline.
