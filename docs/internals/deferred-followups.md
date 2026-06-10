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

## DF-2 — `docs/install.md` shim version marker drift

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
