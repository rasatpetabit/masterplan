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

## DF-4 — Re-drive stamps completion without authorization — **OPEN (X22a, 2026-09-30)**

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
repair scope. Tracking is not remediation; the shortcut remains unchanged.

**Resolution shape:** Require durable evidence of a previously authorized
finalization before the no-marker shortcut; otherwise refuse. Extend structural
coverage to dispatch-wrapper completion writes, not only `recordWaveResult`.
Resolve as a separately authorized change without historical identity recovery
or receipt migration.
