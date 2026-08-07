# Plan Annotation Contract

The field contract for masterplan v8 planning. Both planner agents emit task data
against it; the deterministic merge (`lib/plan-merge.mjs`) then owns id assignment,
wave layering, and `codex` normalisation. **The LLM never authors the final
`plan.index.json` bytes** — it proposes task fields; JavaScript computes the rest.
Planner agents now receive `goals.md` alongside `spec.md` and annotate each task's
`goals`. Mechanism detail lives in [`docs/internals/plan-parser.md`](../internals/plan-parser.md);
this file is the field-level convention the planner agents are briefed against.

## Who produces what

- **Serial path — `agents/mp-planner.md` (opus).** Reads the approved spec and writes
  both `plan.md` and `plan.index.json` directly into the run-bundle dir, emitting the
  canonical task fields below with `id`/`wave`/`codex` already set. `mp
  validate-plan-index` re-checks the result before L1 accepts it.
- **Parallel path — `agents/mp-subsystem-planner.md` (opus), one per subsystem.** Each
  returns a **fragment** — a subsystem-scoped task list **without** global `id`s or
  `wave`s. `mp merge-plan-fragments` flattens fragments, assigns ids, and derives waves.
  Drafters never see each other's tasks.

## Canonical task fields

Emit these exact keys — the canonical names `lib/dispatch/routing.mjs`, `applyPlanIndex`
(`bin/masterplan.mjs`), and `buildTasksFromPlanIndex` (`lib/bundle.mjs`) read:

| field | type | meaning |
|---|---|---|
| `description` | string (required) | What the task does. Routing scans **this** field for design-judgment / sensitive verbs — never `name`/`title`. |
| `files` | array of repo-relative paths | Declared write scope. `> 3` files ⇒ Codex-ineligible by heuristic. Same-wave tasks MUST have disjoint `files`. |
| `verify_commands` | array of shell strings | Commands that prove the task. **Empty ⇒ Codex-ineligible** and unverifiable (the implementer reports that fact). |
| `codex` | string `"ok"` \| `"no"` \| `null` | Routing override; `null` defers to the heuristic. **Never a boolean** (trap 1). |
| `sensitive` | bool (optional) | `true` ⇒ Codex-ineligible (also auto-detected from `description`). |
| `conversational` | bool (optional) | `true` ⇒ Codex-ineligible. |
| `spec_refs` | array of strings (optional) | Provenance back into `spec.md`. |
| `goals` | array of strings (optional) | Goal ids (from `goals.md`) this task serves. May be empty **only** for pure-infra tasks whose goal another task covers. `mp validate-plan-index` checks these referentially (each id must exist in `goals.md`), not semantically. |

**Fragment-only fields (parallel path — drive the merge, dropped from the final index):**

| field | type | meaning |
|---|---|---|
| `key` | string, unique | Stable task key (e.g. `"auth.token-store"`). Targets of `deps`. Duplicate keys across fragments throw. |
| `deps` | array of `key`s | Dependency edges; every entry must reference an existing key (dangling ⇒ throw). The merge derives `wave` from this DAG via Kahn order. |

**Computed fields (the merge assigns these on the parallel path — do NOT hand-author
on a fragment; the serial `mp-planner` path emits them directly):**

| field | type | meaning |
|---|---|---|
| `id` | integer, 1-based, unique | Task identity; propagates verbatim into `state.yml`. |
| `wave` | integer ≥ 0 | Tasks sharing a wave run as one `parallel()` batch; a dependency ⇒ a higher wave. |

## Codex routing annotation

- `codex: "ok"` — only for mechanical, well-bounded work: ≤ 3 files, concrete
  `verify_commands`, no design judgment.
- `codex: "no"` — anything needing taste, cross-file reasoning, or touching secrets /
  auth / production / schema migrations.
- `codex: null` (or omit) — defer to `lib/dispatch/routing.mjs`'s heuristic.
- Routing's `target` is **informational** in v8: implementation is inline-only (there
  is no Codex implementer). `codex` records what a future implementer tier *could*
  offload — the adsp-v1 broker adapter (`lib/dispatch/adsp-adapter.mjs`) is the live
  production dispatch seam, imported and actively used by `lib/dispatch-wave.mjs` — but in v8 it gates **no** runtime behaviour — the optional review stage is
  gated solely by the bundle's `state.review.adversary` config, independent of any task's
  `codex`/`target`.

## Three silent-fallthrough traps

These fail by doing the **wrong** thing, not by erroring:

1. **`codex` is a STRING, never a boolean.** `routing.mjs` tests `=== 'no'` / `=== 'ok'`;
   a boolean matches neither and falls through to the heuristic. `normalizeCodex` coerces
   `true`/`false`/`{eligible}` back to the enum as a backstop, but emit `"ok"`/`"no"`/`null`.
2. **`description`, not `name`.** Routing scans `description`; a judgment task carried
   under `name` reads as an empty description and is misrouted to Codex.
3. **`wave`/`id` are integers, not strings.** A string fails the `Number.isInteger`
   guards on write (hard crash) and the strict `===` match in `markTask` (phantom write).

## Wave / parallelism rule

Tasks in the **same wave** MUST have **disjoint `files`** — the L2 engine runs a wave as
a `parallel()` barrier and each implementer asserts its own scope post-run. On the parallel
path the merge enforces this automatically (file-conflict wave bump); on the serial path
the planner hand-assigns waves so same-wave file sets are disjoint. `mp validate-plan-index`
rejects any plan that violates it.


## Yocto / yanos-builder image tasks (verify + goals)

When a plan task produces a kas/yanos-builder image:

### verify[] (required shape)

Use **observables**, not enqueue:

```text
- rg -n "Tasks Summary:.*all succeeded" <bitbake.log>   # or yanos-builder logs <BID>
- test -s <path-to.wic.zst-or-equivalent>
- test -s <path-to.raucb>   # if --with-bundle / bundle target
- # tip: log Syncing/HEAD is now at matches planned SHA
```

If U-Boot RAUC MACHINE:

```text
- python3 scripts/check-uboot-rauc-env.py --root layers/meta-yanos-bsp
- strings <deploy>/uboot.env | rg -q bootmeths
```

If QEMU smoke is in goals:

```text
- yanos-builder qemu smoke <project> --build-id <BID> …  # cite job path + match
```

**Forbidden verify:** `build enqueued`, `commit exists`, catalog status alone.

### Wave ladder (prefer)

0. preflight + lint + pins (no full image)  
1. compile-only for OOT/kernel ports  
2. one full image  
3. smoke + board-card / docs  

### goals.md founding-ask hygiene

If the founding request includes run/boot/correct-on-hardware language, goals must include bootloader/env parity and either QEMU smoke or an explicit “artifacts only; board boot unproven” waiver before execute freeze.

Cross-ref: yanos-os `docs/conventions/image-bringup-agent.md`.
