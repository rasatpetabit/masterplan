# Spec — fabric-default-dual-reg

## Summary

Finish two deferred follow-ups from `dispatch-subagent-reconcile`:

1. **Fabric default path** — new `mp seed` bundles arm `state.dispatch.fabric: true` so execute waves take the agent-dispatch fabric (`dispatch_fabric` → `mp dispatch-wave`) unless the operator opts out.
2. **Dual-registration collapse** — pi host registration writes **bare `mp-*.md` only**; stop emitting `masterplan:mp-*.md` colon alias copies; delete leftovers on write.

Done bar: **code + unit tests + docs** (no live fabric dogfood drill, no agent-dispatch policy ownership, no doctor redesign beyond the existing `pi-agent-registration` check).

## Context

- Fabric is a per-run strangler flag (`state.dispatch.fabric` / `continue --fabric-dispatch`). Today it is **opt-in**; most new runs still take `launch_workflow` / `dispatch_foreground`.
- Pi registration (`bin/register-pi-agents.mjs`) writes **two files per agent** (bare + `masterplan:` colon alias) so CC-authored `masterplan:mp-*` names resolve on pi. Colon aliases are operational noise: bare names are the primary pi surface; CC keeps discovering `agents/` via its plugin loader independently.
- Residual scrub (strict `MODEL_MAP`, explorer body, doctor check) already shipped on `main` (`1236518`); this run is the deferred redesign pair only.

## Goals

| ID | Goal | Signal |
|---|---|---|
| G1 | New seeds default to fabric on | Fresh `buildSeedState` / `mp seed` emits `dispatch.fabric: true`; `--fabric=off` omits/disables; existing mid-run bundles without the key stay on the legacy wave path |
| G2 | Pi registration is bare-only | `register-pi-agents` write mode emits only bare `mp-*.md`; **managed** colon leftovers (names derived from `agents/mp-*.md` + SKIP_FOR_PI) are deleted; `--check` flags those leftovers as drift; unmanaged `masterplan:mp-*.md` outside the managed set are left alone; SKIP_FOR_PI unchanged |
| G3 | Docs and tests match | verbs/internals/development/AGENTS/CHANGELOG describe seed fabric default + bare-only pi registration; unit tests cover seed default/opt-out and bare-only write/check/cleanup |

## Non-goals

- Making fabric implicit-on for **old** bundles that never set `dispatch.fabric` (always-on-unless-false).
- Host/env global fabric default (`MASTERPLAN_FABRIC=1`).
- Collapsing or renaming the **CC** plugin namespace `masterplan:mp-*` (agents/ + Claude Code loader stay as-is).
- agent-dispatch policy ownership of agent→class maps.
- Live multi-host fabric dogfood drill as a finish gate.
- Doctor redesign beyond what `pi-agent-registration` already does (it will keep calling `register-pi-agents --check`).

## Design

### G1 — Fabric default at seed

**Writer:** `lib/bundle.mjs` `buildSeedState` gains `fabricDispatch` (default `true`).

- When `true` (default): emit `state.dispatch = { fabric: true }` (explicit, auditable — same spirit as `state.review.adversary: true`).
- When `false` (opt-out): **omit** `state.dispatch` entirely (A9 absent-field style; runtime treats absent as legacy path).

**CLI:** `mp seed --fabric=on|off`

- Undefined → default on (buildSeedState default).
- `--fabric=off` → `fabricDispatch: false`.
- Invalid values die at the bin boundary (mirror `--owner-lock` / `--adversary-review`).

**Runtime (unchanged gate):**

```text
fabric = opts.fabricDispatch === true || state.dispatch?.fabric === true
```

`continue` / `prepareWave` / `dispatch-wave` keep requiring explicit `true`. No change to the flag-off → no-op contract for old bundles.

**Docs:** `docs/verbs.md` (seed flags), `docs/internals/wave-dispatch.md` (default-on for new seeds), `CHANGELOG` Unreleased, `commands/masterplan.md` seed row if it lists flags.

**Tests:**

- `buildSeedState` default includes `dispatch.fabric === true`.
- `fabricDispatch: false` omits `dispatch`.
- CLI seed with/without `--fabric=off` (bin or bundle tests as existing patterns allow).

### G2 — Bare-only pi registration

**`bin/register-pi-agents.mjs`:**

- `outputsFor` returns **one** output: bare `mp-*.md` with model line swapped only (no name prefix).
- Drop colon-alias generation path (or leave dead code removed cleanly).
- Write mode: after writing bare files, **delete only managed** colon paths: for each `agents/mp-*.md` basename (including SKIP_FOR_PI names), remove `masterplan:<basename>` if present. Same cleanup class as SKIP_FOR_PI removal of implementer copies — **not** a free-for-all delete of every `masterplan:mp-*.md` under the target dir.
- `--check`: leftover **managed** colon files count as drift (unexpected/managed-stale). Unmanaged colon-named files outside that set are ignored.
- `SKIP_FOR_PI` (`mp-implementer`) unchanged.
- `MODEL_MAP` stays `{ fable: 'litellm/fable-5' }`.

**Call sites / docs:**

- CC L1/L2 may still say `masterplan:mp-*` — that is the **Claude Code plugin** name, not the pi install layout.
- Pi-facing docs and probes document **bare** `mp-*` only.
- Update `AGENTS.md`, `docs/development.md`, register script header comments, `CHANGELOG`.

**Tests (`test/register-pi-agents.test.mjs`):**

- `outputsFor` length 1; bare rel path only.
- Write mode never creates colon files; deletes pre-existing colon files.
- `--check` fails when a colon file remains.
- Existing MODEL_MAP / SKIP_FOR_PI / explorer body tests stay green.

## Failure modes

| Risk | Mitigation |
|---|---|
| Operator assumes old mid-run bundle is fabric | Docs + absent flag = legacy; only new seeds arm fabric |
| Pi caller still uses `masterplan:mp-*` after collapse | Docs + delete-on-write; `--check` drift; call sites that must work on pi use bare names |
| Accidental delete of non-managed colon-named files | Only delete/check the managed set derived from `agents/mp-*.md` (+ SKIP_FOR_PI), never a free-for-all regex on all colon files |
| Seed default breaks a dogfood that wanted legacy workflow | `--fabric=off` at seed |

## Assumptions & Open Decisions

| question | decision | rationale | source |
|---|---|---|---|
| When does a run take fabric? | New seeds on; mid-run/old bundles unchanged | Strangler stays reversible; no surprise for in-flight runs | user-confirmed |
| Fabric opt-out shape | `mp seed --fabric=off` omits `dispatch` | Matches A9 absent-field style used for owner_lock/review opt-outs | user-confirmed |
| Dual-reg collapse shape | Bare primary only | Bare is the primary pi name; CC plugin namespace is independent | user-confirmed |
| Leftover colon files | Delete **managed** colon aliases on write; drift on --check for those only | Same cleanup class as SKIP_FOR_PI; prevent zombie aliases without deleting operator-owned files | user-confirmed (refined at plan-gate) |
| Done bar | Code + unit tests + docs | No live fabric drill; no policy ownership | user-confirmed |
| Always-on for old bundles / env default | Out of scope | Higher blast radius; deferred | user-confirmed |
| CC `masterplan:mp-*` plugin names | Unchanged | CC discovery is not pi registration | user-confirmed |

## Success criteria

1. `node --test test/bundle.test.mjs test/register-pi-agents.test.mjs` (and any new seed CLI coverage) green.
2. `node bin/register-pi-agents.mjs --check` green on a resynced host (bare only; no colon files).
3. Fresh seed without flags has `dispatch.fabric: true` in state.yml; with `--fabric=off` has no fabric true.
4. Docs no longer claim dual bare+colon registration or fabric-as-opt-in-only for new runs.
