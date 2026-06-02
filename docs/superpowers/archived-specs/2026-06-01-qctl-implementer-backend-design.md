# qctl implementer-backend seam — design (contract-first)

> **Status:** approved design (brainstorming → spec). Written 2026-06-01.
> **Scope:** masterplan plugin (`/srv/dev/masterplan`) + a mirrored contract doc
> in `petabit-sysadmin`. Buildable today; the *live binding* is deferred until the
> Qwen Work Fabric ships `qctl` (its task 11) and `gate.py` (its task 12).
> **Predecessor:** [`docs/github-coordination-qwen-fabric-fit.md`](../../github-coordination-qwen-fabric-fit.md)
> (the fit/gap analysis this design acts on).

## 1. Motivation

The originating request was: *"find the Qwen coding-harness plan in petabit-sysadmin
(coordination through GitHub issue/PR), test our masterplan code against it, adjust
if necessary."* That names two **different** existing artifacts that the fit/gap
analysis already separated:

- The **Qwen Work Fabric** (`petabit-sysadmin/docs/superpowers/specs/2026-05-31-qwen-work-fabric-design.md`)
  — a node-local-SQLite-coordinated coding harness whose worker is a bwrap'd
  `pi --mode json` subprocess producing diffs in `qwen/<class>/<task-id>` worktrees,
  gated by a filesystem-ground-truth **green gate**. It is *deliberately not* GitHub.
- masterplan's own shipped **`github-coordination`** feature — lead `publish`es a
  wave's tasks as Issues, followers `follow` (claim → build → PR against
  `mp-int/<slug>`), lead reconciles + human-gated merge.

The coherent test is: **can a Qwen worker serve as the thing that produces a task's
diff** — i.e. as the **implementer** that an execute wave or a github-coordination
follower dispatches, instead of always dispatching `masterplan:mp-implementer`?

The role mapping lines up cleanly (fit analysis §3): the Qwen `pi` worker maps onto
the **implementer** role, and the fabric's **green gate** is near-identical in
philosophy to masterplan's **D6 `verify-scope`** (both gate on filesystem ground
truth — git diff ⊆ declared scope ∧ verify rc==0 — never on the worker's
self-report). The single concrete code gap is that the implementer is currently
hard-wired: `commands/masterplan.md` §7 step 3 (`follow`) names `mp-implementer`
directly, and there is no first-class pluggable backend.

### 1.1 The feasibility constraint that shapes this design

The fabric's *true* worker is **not operational yet**. Its bundle
(`petabit-sysadmin/docs/masterplan/qwen-work-fabric/`) is mid-execute: W0 library
code (`scripts/qwen-fabric/`: `queue.py`, `worker.py`, `lanes.py`, `preflight.py` +
tests) is done (7/15), but the four pieces masterplan would attach to are **pending
tasks**:

- task 9 — queue dir provisioning (`/var/lib/petabit-qwen-queue/` absent)
- task 10 — `pi` install (not on PATH)
- task 11 — **`qctl` CLI** (the control surface masterplan binds to — doesn't exist)
- task 12 — **`gate.py` green gate** (the integration contract — doesn't exist)

Only the vLLM GPU endpoint is live (`http://192.168.104.213:8200/v1`,
`qwen36-27b-mtp-tp4`) — that is the *model*, not the *worker*.

So binding masterplan to a live worker today is impossible. The design is therefore
**contract-first**: build the real masterplan-side seam now, define the `qctl`
results-contract precisely (so tasks 11/12 build against it), and keep the live
binding feature-flagged **off** until the fabric ships. When it does, binding is a
small replacement, not a rewrite.

## 2. Decisions locked (from brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Seam abstraction | **Kind-discriminated descriptor** | The only shape that can *express* a non-agent qctl worker; a bare `implAgentType` string is agent-only and gives the fabric nothing to build against. |
| Contract home | **Full doc in both repos** | The producer (fabric) has the contract locally; no "look in the other repo" drift. |
| Dispatch mechanism (courier-agent vs L1 `bin` subcommand vs follower-direct shell) | **Deferred to binding time** | It is a binding-time concern; the contract-first round defers binding. The descriptor + contract make every option expressible later. |
| Stub fidelity | **No-op (NotYetBound guard)** | Contract-first; a live-vLLM proof is the path that was explicitly declined. |
| Diff git-context crossing | **Portable patch against a named base** | masterplan never reaches into the epyc1-local worktree (off /srv/dev, foreign git context). |
| Gate authority | **masterplan D6 `verify-scope` authoritative; fabric green-gate advisory** | masterplan must not trust the worker's self-report — same principle the fabric itself enforces. |

## 3. Part A — the masterplan seam (`/srv/dev/masterplan`)

### A1. The descriptor (the contract object)

A tagged union — the single object both consumer paths *and* the fabric agree on.
**No new registry module**; the union *is* the seam. It lives in `lib/routing.mjs`
beside `routeTask`.

```js
// kind:'agent' — today's default; reproduces shipping byte-for-byte.
// Carries ONLY the discriminant. agentType/model resolution stays in the
// existing execute.workflow.js seam (the prod-inert implAgentType/implModel
// hook, commit 561f348), which the workflow already holds — the descriptor
// does NOT restate fields the dispatch site already has.
{ kind: 'agent' }

// kind:'qctl' — shipped, but the resolver emits it ONLY when the flag is on.
{ kind: 'qctl',
  scope,            // declared file scope (== task.files / D6 verify-scope set)
  verify,           // verify_commands (union, as today)
  deliver: 'patch'  // delivery primitive: portable unified diff vs `base`
  // repo, base — NOT resolver-time. They are stamped by the dispatch-locus
  // consumer at binding time (runtime repo root + HEAD sha). The resolver
  // emits only task-intrinsic fields; see §5. §4/B1 is where repo/base appear,
  // populated at the binding-time crossing.
}
```

### A2. The resolver

`resolveImplementerBackend(task, config, env) -> descriptor` in `lib/routing.mjs`,
a **sibling** to `routeTask` (it produces the *dispatch* descriptor; `routeTask`'s
`target` stays log-only and untouched).

- Default → `{ kind:'agent' }` — the workflow's existing seam owns
  agentType/model, so the descriptor reproduces shipping without restating them.
- `config.implementer?.qctl?.enabled === true` (**default false**, strict
  `=== true`; any other value → `kind:'agent'`) → `{ kind:'qctl', scope, verify,
  deliver:'patch' }`. The flag itself is the predicate for now (qctl for every
  task when enabled); a finer per-task predicate is a binding-time concern (YAGNI).

The function is pure (`task, config, env` in → descriptor out) and unit-tested in
isolation, mirroring `routeTask`'s testability.

### A3. Threading — the execute path

`mp prepare-wave` (L1) already resolves routing per task and hands the wave payload
to the L2 workflow. It gains a per-task `backend` descriptor on each wave-task,
computed via `resolveImplementerBackend`. `execute.workflow.js` `implement(t)` gains
a **single guard at the top**, leaving the existing dispatch path untouched:

- `t.backend?.kind === 'qctl'` → return a **NotYetBound** synthesized digest
  (`status:'blocked'`, `blockers:'qctl-not-bound'`, summary citing this spec). A
  blocked digest — *not* a thrown error — is the established workflow pattern: a
  throw inside a pipeline stage nulls the item → silent vanish → re-dispatch loop;
  a blocked digest fails loud via the §2a AUQ. The real dispatch locus is the
  deferred binding-time decision the workflow's no-subprocess/no-fs/no-git
  constraint forces (the workflow *cannot* shell `qctl` or `git apply` itself;
  binding must happen at L1 or in an agentic consumer).
- otherwise (the `agent` kind, **and** the absent-`backend` legacy path) → fall
  through to **today's dispatch, byte-for-byte unchanged**. The existing top-of-
  workflow seam (`implAgentType ?? 'masterplan:mp-implementer'` / `implModel`,
  commit `561f348`) still governs agentType/model; the `agent` descriptor does not
  restate those fields — it merely routes around the qctl guard.

**Production invariant:** with the flag off, `resolveImplementerBackend` returns
`{ kind:'agent' }` for every task, the guard is never taken, and the workflow path
is byte-identical to shipping; the `backend` field is inert ballast threaded but
never branched on. The change is visually auditable — the agent path is literally
the same code, and all new behavior is the one guard block.

### A4. Threading — the follow path

`commands/masterplan.md` §7 step 3 stops hard-coding `mp-implementer`. It resolves
the descriptor (same `resolveImplementerBackend`) and dispatches accordingly. The
follower is a full agentic session — it *can* shell out — so it is the easiest
binding-time consumer (shell `qctl`, `git apply` the returned patch in its checkout,
run `verify_commands`, open the PR against `mp-int/<slug>`). With the flag off, it
resolves to `mp-implementer` — identical to today.

### A5. Feature flag + stub

`config.implementer.qctl.enabled` defaults **false** everywhere (config schema +
defaults). The only "stub" is the A3 NotYetBound guard plus resolver unit coverage —
**no fake worker, no live-vLLM call** (the declined path). masterplan ships
byte-identical until someone flips the flag against a real `qctl`.

### A6. Tests (extend the existing `test/` suite)

- `resolveImplementerBackend` returns `{ kind:'agent' }` (default / flag-off) and
  `{ kind:'qctl', scope, verify, deliver:'patch' }` (flag on, strict `=== true`).
- Byte-identical default: an `agent`-backend task with no `args` override dispatches
  through the untouched seam → `opts.agentType==='masterplan:mp-implementer'`, no
  `model` — proving the agent path is unchanged.
- Dogfood override still wins: an `agent`-backend task plus `args.implAgentType`
  routes to the override (the seam, not the descriptor) — the existing dogfood test
  keeps passing untouched.
- Flag-off proves `kind:'qctl'` is never emitted (the prod-inert invariant).
- The NotYetBound guard returns a `status:'blocked'`, `blockers:'qctl-not-bound'`
  digest (and dispatches NO agent) if a `kind:'qctl'` descriptor reaches the
  workflow without a bound dispatch.

### A7. File touchpoints (masterplan)

| File | Change |
|---|---|
| `lib/routing.mjs` | Add `resolveImplementerBackend()` + the descriptor union. |
| `bin/masterplan.mjs` (`prepare-wave`) | Attach per-task `backend` descriptor to the wave payload. |
| `workflows/execute.workflow.js` | `implement(t)` gains a top guard: `t.backend?.kind==='qctl'` → NotYetBound blocked-digest; otherwise today's dispatch byte-for-byte (seam untouched). |
| `commands/masterplan.md` (§7 step 3, `follow`) | Resolve the descriptor instead of hard-coding `mp-implementer`. |
| config schema + defaults | `implementer.qctl.enabled` (default false). |
| `test/…` | Resolver + invariant + NotYetBound coverage. |

## 4. Part B — the qctl results-contract

The interface the fabric's `qctl` (task 11) + `gate.py` (task 12) build against.
Written into **both** repos (this doc carries it; the petabit-sysadmin mirror is the
producer-local copy).

### B1. Input — masterplan → qctl

```
{ task_id,            // opaque id masterplan uses to correlate the result
  repo,               // target repo path (under /srv/dev)
  base,               // ref the patch must apply against
  scope,              // declared file list (the ONLY paths the patch may touch)
  verify_commands }   // commands that must exit 0 on the applied result
```

This is the `kind:'qctl'` descriptor (`scope`, `verify`) plus the `task_id`,
`repo`, and `base` that the dispatch-locus consumer stamps at binding time
(`deliver` is a masterplan-side delivery hint, not part of the qctl input).

### B2. Output — qctl → masterplan

```
IMPL_DIGEST { task_id,
              status: 'done' | 'failed' | 'blocked',
              files_changed,   // paths the patch touches
              summary }
+ a portable unified patch against `base`
```

**Never** a worktree path. masterplan does not reach into the epyc1-local
`qwen/<class>/<task-id>` worktree — it lives off /srv/dev in a foreign git context.
The patch text is the crossing primitive.

### B3. Delivery — how the diff crosses git contexts

`qctl` emits the patch as text (stdout or a named artifact path returned in the
digest). The masterplan consumer `git apply`s it into its **own** tree against
`base`, then gates. This decouples the two git contexts entirely — the fabric keeps
its SQLite-coordinated, off-/srv/dev worktree model; masterplan keeps its own tree
and its `mp-int/<slug>` / wave-commit model.

### B4. Gate authority

Two filesystem-truth gates; authority is pinned:

- **Fabric green gate** (`gate.py`) = **producer-side fail-fast**, advisory to
  masterplan. `qctl` will not return a patch that fails its own scope/verify/lint —
  but masterplan does not *rely* on that.
- **masterplan D6 `verify-scope`** = **authoritative**. masterplan re-runs
  `git diff ⊆ declared scope ∧ verify rc==0` on the *applied* patch in its own tree.
  If the applied result violates scope or fails verify, masterplan rejects it,
  regardless of the worker's self-reported `status` — same "distrust the worker"
  rule the fabric itself enforces.

## 5. Convergence — what binding looks like when the fabric ships

When fabric tasks 11 (`qctl`) + 12 (`gate.py`) land:

1. Choose the dispatch locus (the deferred decision): follower-direct shell is the
   natural first consumer (the follower is already an agentic session that can shell
   `qctl` and `git apply`); the execute-workflow path needs an L1 hop (a `bin`
   subcommand the L1 shell calls, or a courier agent) because the workflow itself
   cannot shell.
2. Replace the A3 NotYetBound guard with the real dispatch for the chosen locus.
3. Flip `config.implementer.qctl.enabled` for the opted-in run.

No rework of the descriptor or the contract — they are what tasks 11/12 targeted.

## 6. Non-goals / YAGNI

- **No separate `implementer-backends.mjs` registry module.** The two-kind union is
  the seam; a registry for two kinds is over-engineering.
- **No live-vLLM proof / no fake worker.** Contract-first; the no-op NotYetBound
  guard is the only stub.
- **No `codex`-implementer and no new always-on foreground write-process.** A
  write-access implementer dispatched as a foreground process can orphan — the
  existing `execute.workflow.js` comment block is explicit, and the fabric solves
  the same orphan concern with bwrap + the green gate. The qctl path inherits the
  fabric's isolation, not a new masterplan-side foreground writer.
- **No change to the fabric's transport.** The fabric stays node-local-SQLite by
  design; github-coordination stays GitHub. This design wires Qwen into the
  *implementer* slot of *either* path; it does not ask the fabric to adopt GitHub.

## 7. Risks / open questions

- **Dispatch locus is genuinely deferred.** The execute-path binding (workflow can't
  shell) is harder than the follow-path binding (follower can). The contract is
  locus-agnostic, so this is a binding-time choice, but it must be made before the
  execute path can offload to qctl.
- **Patch-apply fidelity.** A portable patch against `base` assumes masterplan's tree
  is at (or fast-forwardable to) `base` at apply time. The contract pins `base`
  explicitly so a stale-tree apply fails loudly rather than silently mis-applying.
- **Never dogfooded live.** github-coordination itself is unit-green (53/53 + 18/18)
  but has never run as a live multi-LLM session; the first real qctl binding should
  pair with that first live dogfood.

## 8. References

- Fit/gap analysis: [`docs/github-coordination-qwen-fabric-fit.md`](../../github-coordination-qwen-fabric-fit.md)
- Qwen Work Fabric design: `petabit-sysadmin/docs/superpowers/specs/2026-05-31-qwen-work-fabric-design.md`
- The prod-inert dogfood hook this promotes: `workflows/execute.workflow.js`
  (`implAgentType`/`implModel`/`reviewAgentType`/`reviewModel`), commit `561f348`.
- `routeTask` (sibling, log-only `target`): `lib/routing.mjs`.
- `follow` hard-coded implementer: `commands/masterplan.md` §7 step 3.
