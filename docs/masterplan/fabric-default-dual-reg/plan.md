# Plan — fabric-default-dual-reg

## Overview

Three sequential waves (each wave is one self-contained implement+verify task so same-wave parallel cannot race tests against old code).

Advisory from plan-gate (folded in):

1. Managed-only colon cleanup (aligned with spec).
2. Mandatory CLI seed tests for `--fabric`.
3. `commands/masterplan.md` in docs task.
4. Mandatory unmanaged-alias preservation fixture.
5. SKIP_FOR_PI colon cleanup/check covered for `mp-implementer`.

---

### Task 1: Fabric seed default (impl + tests)

Wire `fabricDispatch` (default `true`) into `buildSeedState` → emit `dispatch: { fabric: true }`. Opt-out `false` omits `state.dispatch`. CLI `mp seed --fabric=on|off` (undefined → on). Bundle tests + **mandatory** bin tests for default / off / on / invalid.

**Files:** `lib/bundle.mjs`, `bin/masterplan.mjs`, `test/bundle.test.mjs`, `test/bin-masterplan.test.mjs`  
**Verify:** `node --test test/bundle.test.mjs test/bin-masterplan.test.mjs`  
**Wave:** 0

### Task 2: Bare-only pi registration (impl + tests)

`outputsFor` bare only. Managed colon cleanup/check: names = `masterplan:` + basename for every `agents/mp-*.md` including SKIP_FOR_PI. Unmanaged `masterplan:mp-custom.md` (basename absent from agents/) survives write and does **not** fail `--check`. Preseeded `masterplan:mp-implementer.md` is removed on write and is drift if left. MODEL_MAP / SKIP_FOR_PI / explorer body tests stay green.

**Files:** `bin/register-pi-agents.mjs`, `test/register-pi-agents.test.mjs`  
**Verify:** `node --test test/register-pi-agents.test.mjs`  
**Wave:** 1

### Task 3: Docs + host resync

Update verbs, wave-dispatch internals, development, AGENTS, commands/masterplan.md seed flags, CHANGELOG. Host: write-mode register then `--check` green (no managed colon files).

**Files:** `docs/verbs.md`, `docs/internals/wave-dispatch.md`, `docs/development.md`, `AGENTS.md`, `commands/masterplan.md`, `CHANGELOG.md`  
**Verify:** `node bin/register-pi-agents.mjs && node bin/register-pi-agents.mjs --check`  
**Wave:** 2
