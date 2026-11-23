# Deferred Follow-ups — Internals

> **Audience:** Maintainers triaging recurring review findings.
> Tracked, intentionally-deferred items so they read as *known* rather than
> resurfacing as fresh churn on every cross-vendor (Codex) review pass.

Each entry records the finding, why it is deferred, and the resolution shape so a
future pass can close it deliberately instead of re-litigating it.

## DF-1 — `commands/masterplan-contracts.md` is on the command surface — **RESOLVED (v8.2.0 cutover)**

> Relocated to `docs/contracts/masterplan-contracts.md` with frontmatter dropped;
> `commands/` now ships only `masterplan.md`, so no accidental
> `/masterplan-contracts` command registers. Original finding below for provenance.

**Finding (recurring, P3):** Files under `commands/` are auto-discovered by Claude
Code as slash commands. `commands/masterplan-contracts.md` is an internal contract
reference, not user-invokable, yet shipping it under `commands/` publishes an extra
`/masterplan-contracts` command alongside v8's single `/masterplan` entrypoint.

**Why deferred:** Orthogonal to the brainstorm-anchor / failure-instrumentation
hardening it rode in with; pre-existing placement, not introduced by that change.
The release gate is green with the file in place (it is not a gate failure). Moving
it touches packaging (`.claude-plugin/plugin.json` exclusions or a `docs/` relocation
plus every cross-reference), which is its own bounded change and carries its own
regression surface.

**Resolution shape:** Relocate to `docs/contracts/masterplan-contracts.md` (and
repoint the `parts/` references), **or** add a packaging exclude so the file ships
without registering as a command. Re-verify autocomplete + publish-hygiene after.

## DF-2 — `docs/install.md` shim version marker drift — **RESOLVED (2026-06-10)**

> Not drift: the marker versions the **shim body**, not the plugin. The shim's
> delegation contract (`/masterplan:masterplan $ARGUMENTS`) is unchanged under v8
> packaging — the namespaced command still resolves — so `v3` is current.
> `docs/install.md` now states the marker's semantics explicitly so the plugin
> version can advance without re-raising this.

**Finding (non-blocking, pre-existing):** `docs/install.md` documents the offline
shim with marker `<!-- masterplan-shim: v3 -->`. The plugin is at v8; the shim
version lineage (v3/v4) is stale relative to the current command surface.

**Why deferred:** Outside the staged diff; the shim is a fallback install path, not
a gate-checked surface. No flood / CI impact.

**Resolution shape:** Reconcile the shim marker with the current delegation contract
(confirm whether v3 still resolves correctly under v8 packaging) and bump the marker
if the shim body changed.

## DF-3 — `parts/step-b.md:176` points at the wrong file for the YAML shape — **MOOT (v8.2.0 cutover)**

> `parts/step-b.md` and both `parts/contracts/*` files it cited were deleted at
> the cutover (recoverable at tag `v8.1.0-pre-cruft-removal`). Nothing to repoint.

**Finding (non-blocking, pre-existing):** The merge-rules pointer in `parts/step-b.md`
cites `parts/contracts/plan-annotations.md §brainstorm_anchor YAML Shape`, but the
`brainstorm_anchor` YAML shape actually lives in `parts/contracts/brainstorm-anchor.md`.

**Why deferred:** `parts/step-b.md` is outside the staged brainstorm-anchor diff;
correcting it there would expand the commit into an unrelated file. Documentation
reference drift only — no behavioural impact (the consumer logic in `parts/step-b.md`
reads the live return shape, not the doc).

**Resolution shape:** Repoint the reference to `parts/contracts/brainstorm-anchor.md`
(one-line edit) in the next pass that touches `parts/step-b.md`.

## DF-4 — Re-drive stamps completion without authorization — **RESOLVED**

**Finding (MEDIUM, pre-existing from `0dbed78` onward):**
`redriveRecordTransaction` in `lib/dispatch-wave.mjs` catches the recorder's
“no active_run marker” refusal and writes `status: recorded`, `completed_at`,
and an assertion that the prior transaction completed. The recorder refuses
before its shared authorization gate; marker absence alone is not durable
proof of an authorized finalization. This is an unsupported completion-audit
claim, not an established full finish/archive exploit.

**Reproduction:** In a disposable bundle, leave a pending task's dispatch record
`dispatched` with a stored done result, retire the unreviewed episode, remove the
active marker, then call `dispatchWaveViaFabric` for that wave. The re-drive
returns `outcome: reused`, record `status: recorded` and
`record_result.outcome: already-finalized` while the task remains pending and
its disposition remains `retire`, `reviewed: false`.

**Evidence:** Plan 07 `reviews/impl/07-x22-judge-6.md`, finding 4 (`J6 REDRIVE`),
and `reviews/impl/07-x22-judge6-provenance.md`, finding 4 (`J6-4`), under
`/srv/workflows/docs/superpowers/plans/2026-09-27-model-routing/`.
The self-contained reproduction is `/tmp/p07-prov/probe.mjs`, selector `4`;
its provenance runs reproduced at `3876029`, `fd4c3ca`, `d9ad7cc` and
`0dbed78`. Temporary probe/log availability is not guaranteed; the durable
review documents record the reproduction and observed outputs.

**Why deferred:** Amendment X22a classifies this as an unrelated existing
shortcut on no X22 disposition-consumption path, outside Task 5's recorder
repair scope. X22a tracked this finding without changing the shortcut.

**Resolution:** `recordWaveResult` writes a structured `wave_recorded` event.
Without an active marker, the dispatch wrapper requires the latest structured
summary for the wave to show recorded tasks or review rework, and checks that
all recorded tasks are no longer pending or in progress. Otherwise it leaves
the dispatch record unchanged. Legacy note-only events are not proof, and
historical review receipts are not re-evaluated. The wrapper also leaves
failure-only results unrecorded and preserves review rework and blocking reviews
when finalizing. See the DF-4 regressions in `test/dispatch-wave.test.mjs` and
`test/dispatch-wave.native.test.mjs`.

## DF-5 — Joint tests (`W=/srv/workflows`) target unmerged `routing R1` modules — **OPEN (external contract absent on `/srv/workflows` `master`)**

**Finding (pre-existing on `origin/main`, verified 2026-11-23 against `/srv/workflows` `f32782b1`):**
Running `W=/srv/workflows npm run test:joint` fails 6 of 249 tests (243 pass / 6 fail):
- `test/dispatch-wave.native.test.mjs:214` (via `test/fixtures/task5-panel-integration.mjs:13`) imports `pi-subagents/engine/standalone/resolve-dispatch.mjs` (`resolveDispatch`, `executePanel`).
- `test/register-pi-agents.test.mjs:466,521` imports `pi-subagents/engine/agent-prompt.ts` (`prepareGovernedAgentForDispatch`, `MissingUsecaseSectionError`), `pi-subagents/engine/runtime-model-resolver.ts` (`createDispatchCoreModelResolver`), `pi-subagents/subagents/src/agents/agents.ts` (`readGovernedBreakerTools`), and reads `pi-subagents/subagents/test/support/agent-usecase-fixture.json`.
- `test/routing-consumer-integration.test.mjs:94,182,220` requires `pi-subagents/engine/standalone/resolve-dispatch.mjs`, `pi-subagents/engine/runs/shared/review-admission.ts`, and `pi-subagents/engine/runs/shared/dispatch-receipt.ts`.

**Root cause:** None of those five paths or ten symbols exist in `/srv/workflows` `master` source (`f32782b1`). They were never merged to `master` and survive only on archived dev-clone refs (`refs/archive/2026-10-07/dev/fix/task11-supervision-restoration` `128de3e0d`, `refs/archive/2026-10-07/prod/model-routing/r1`) and as strings in an older compiled bundle. Current `/srv/workflows` `master` does not implement usecase-section prompt preparation, governed breaker tool allowlist stripping, or a generic dispatch-map `executePanel` coordinator (its separate modules — `engine/standalone/runtime-routing.mjs`, `engine/runs/shared/subagent-prompt-runtime.ts`, `pi-dynamic-workflows/src/review-admission.ts`, and `engine/shared/dispatch-receipt.ts` — expose a different contract).

**Why deferred:** Resolving the gap requires a cross-repo decision on whether `/srv/workflows` `master` will land the C2/C4 `routing R1` interface or whether `masterplan`'s joint tests should be re-targeted to `master`'s actual dispatch/review-admission/receipt exports.

**Resolution shape:** Once the target `/srv/workflows` contract is settled, either run `test:joint` against the checkout implementing C2/C4 or migrate the 6 joint tests (and `test/fixtures/task5-panel-integration.mjs`) to the supported `master` modules without weakening behavioral assertions.

