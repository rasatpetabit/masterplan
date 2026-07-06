# Spec: planf3 idea imports — plan graph, amendments, questionables, visual render

**Run:** `planf3-ideas` · **Complexity:** high · **Source review:** https://github.com/disler/planf3

## Purpose

Import the genuinely novel ideas from planf3 (IndyDevDan's HTML-first planning
meta-skill) into masterplan, adapted to masterplan's architecture: deterministic
decisions in `lib/*.mjs` behind `mp`, single-writer state (CD-7), offline
secret-free rendering, and the shell-owns-network v9 seam.

## Problem

planf3's review surfaced four capabilities masterplan lacks:

1. **Runs are islands.** Bundles have no cross-run references; the only link is
   `--predecessor-transcript` at seed. Multi-run efforts (v8 → v9 → this run)
   are not navigable from the artifacts.
2. **Plan drift is invisible in the artifact.** Post-approval plan changes
   re-arm gates but leave no human-readable change narrative in `plan.md`.
3. **Assumptions are transient.** Brainstorm AUQs resolve decisions, but the
   assumption ledger dies with the conversation — the spec records conclusions,
   not the decisions/rationale behind them.
4. **`plan.html` is a task table.** It lacks the narrative (purpose / problem /
   solution) and visual richness that make a plan absorbable by humans —
   planf3's "agent trifecta" (engineer, team, agents) reading goal.

Explicitly **rejected** planf3 ideas (already covered or worse than what exists):
LLM-authored HTML plans (masterplan renders deterministically from
`plan.index.json`), in-artifact status markers (state.yml is single-writer),
validation loops (verify_commands + finish verify gate), five-workflow routing
(verbs), `AI_DOCS`/`APP_DOCS` (`.okf/` covers it).

## Solution

Four file-disjoint feature areas, one run.

### F1 — Plan-graph refs (cross-run back/forward references)

- **State model:** `state.yml` gains `refs: {back: [], forward: []}`; entry
  shape `{slug, label}` (label optional, defaults to the target's topic).
- **Subcommands (sole writers, CD-7):**
  - `mp refs add --state=<path> --direction=back|forward --target=<slug> [--label=…]`
  - `mp refs remove --state=<path> --direction=… --target=<slug>`
  - `mp refs list --state=<path>` (read-only JSON).
- **Bidirectionality (the planf3 update-references workflow, made deterministic):**
  `refs add` resolves the target bundle at `<MAIN>/docs/masterplan/<target>/state.yml`
  and writes the reciprocal entry (back↔forward) in the same invocation; both
  writes atomic per-file, ordered target-then-source so a crash leaves at worst
  a reciprocal-only entry that a re-run heals (idempotent upsert by slug —
  duplicates are impossible). `refs remove` removes both sides the same way.
  Missing target bundle → exit non-zero, nothing written.
- **Events:** `refs_added` / `refs_removed` appended to BOTH bundles'
  `events.jsonl`.
- **Seed sugar:** `mp seed --predecessor=<slug>` seeds a back ref to the named
  bundle (and its reciprocal forward ref) after writing the fresh state.
- **Surfacing:** `mp status` prints a refs block; `render-plan` echoes refs
  into the plan.html header metadata block as links (relative
  `../<slug>/plan.html`). Archived bundles are valid targets.
- **Migration:** absent `refs` key ≡ `{back: [], forward: []}` — no state
  version bump needed if the migration layer defaults it on load.

### F2 — Amendments (post-approval plan-change history)

- **Subcommand:** `mp amend-plan --state=<path> --summary="…" [--detail="…"]`
  appends to an `## Amendments` section in `plan.md` (creates the section at
  EOF on first use): `### <ISO date> — <summary>` + detail body. Append-only,
  newest last. Refuses an empty summary.
- **Event:** `plan_amended` with `{summary}`.
- **Gate interplay (intended, document it):** amendments edit `plan.md`, so a
  *re-run* of a plan-gated transition re-arms the plan gate at the new hash —
  an amended plan gets a fresh cross-vendor pass. Mid-execution amendments
  don't interrupt anything (the gate only fires at transitions).
- **Surfacing:** `render-plan` renders the Amendments section (parse the
  `## Amendments` block; entries as a timeline).

### F3 — Questionables ledger (always-on spec section)

- **Convention, not code:** the brainstorm flow (`commands/masterplan.md` §3)
  gains a required pre-approval step: persist an **"Assumptions & Open
  Decisions"** section into `spec.md`; one entry per material decision:
  `{question, decision, rationale, source: assumed|user-confirmed}`.
- **Coverage for free:** the section lives in `spec.md`, so the spec-gate hash
  covers it and the cross-vendor adversary reviews it — no new state, no new
  subcommand.
- **Doctor check:** new WARN `spec-assumptions` — a non-archived bundle whose
  `spec.md` exists but lacks an `## Assumptions` heading (match
  `/^##\s+Assumptions/mi`). WARN-only (older bundles keep passing FATAL-free).
- This spec dogfoods the convention (see below).

### F4 — Visual/narrative plan render (deterministic-first + optional images)

- **Narrative meta:** `plan.index.json` `meta` gains optional
  `{purpose, problem, solution}` strings (1–3 sentences each), distilled from
  the spec by `mp-planner` (serial path) and by the fragment merge `--meta`
  (parallel path — L1 passes them, derived from spec.md, into
  `merge-plan-fragments`). `validate-plan-index` accepts-and-ignores absent
  fields (back-compat: old indexes stay valid).
- **Render (stays offline/deterministic/self-contained):** `render-plan` adds,
  in order: header metadata (now incl. refs), narrative sections
  (Purpose / Problem / Solution) when present, the existing wave SVG, the task
  table, goals block, Amendments timeline.
- **Optional images, seam-respecting:** `mp` never touches the network. The
  render embeds any images found at
  `docs/masterplan/<slug>/assets/{hero,wave-<n>}.png` via relative `src`
  (slot-name convention). Generating them is SHELL-side and config-gated:
  `state.render.images: on|off` (default `off`, set via
  `mp seed --render-images=on` or a new `mp set-render-config --images=on|off`
  following the existing `set-review-config` pattern). When `on`, the shell (at
  the plan→execute seam, after plan approval) dispatches image generation
  through the skynet gateway image lane, writes PNGs into `assets/`, re-runs
  `mp render-plan`. No key / lane down / flag off → no images, render complete
  regardless. Missing referenced assets → render omits the `<img>` (never a
  broken link).

## Non-goals

- No LLM-authored HTML (render stays deterministic from index + state).
- No in-artifact task status markers (state.yml remains the tracker; render
  already shows live status).
- No new external dependency in `mp` (image generation is shell-dispatched,
  optional, default-off).
- No refs to bundles outside this repo's `docs/masterplan/` (cross-repo refs
  are out of scope).

## Assumptions & Open Decisions

| Question | Decision | Rationale | Source |
|---|---|---|---|
| Which planf3 clusters to import? | Plan graph + amendments, questionables, visual render; docs-grounding rejected | `.okf/` already covers docs grounding | user-confirmed |
| Image generation default? | Deterministic-first; generated images off-by-default behind `state.render.images`, shell-dispatched | Preserves offline/secret-free render + v9 seam | user-confirmed |
| Where do refs live? | `state.yml` via `mp`, echoed into render | CD-7 single-writer; planf3's artifact-metadata approach breaks gate hashes | user-confirmed |
| Questionables opt-in or always-on? | Always-on spec.md section | Opt-in ledgers never get used; spec gate covers it for free | user-confirmed |
| Amendments home? | `mp amend-plan` → `## Amendments` in plan.md + event | Human-visible in artifact, deterministic writer, gate re-arm semantics preserved | user-confirmed |
| Packaging? | One spec, subsystem fan-out at planning | Areas are file-disjoint; one review/branch/finish cycle | user-confirmed |
| Ref entry shape? | `{slug, label}` only (no kind/type field) | YAGNI — direction is the semantic; labels cover the rest | assumed |
| Reciprocal write ordering? | Target first, then source; upsert-by-slug idempotent | Crash leaves a heal-on-retry state, never a dup | assumed |
| Narrative fields required? | Optional in index; validator accepts absence | Back-compat with every existing bundle | assumed |
| Doctor check severity? | WARN, not FATAL | Old bundles must not start failing doctor | assumed |

## Success criteria

1. `mp refs add/remove/list` maintain bidirectional refs across two bundles;
   unit tests cover add/remove/reciprocal/idempotent-upsert/missing-target;
   `mp status` and `plan.html` surface them.
2. `mp amend-plan` appends to `plan.md` + `events.jsonl`; unit tests cover
   first-use section creation, append ordering, empty-summary refusal;
   amendments render in `plan.html`.
3. `commands/masterplan.md` brainstorm step persists the assumptions section;
   doctor WARNs on a new bundle's spec lacking it (test fixture).
4. `render-plan` renders narrative meta + refs + amendments + goals with NO
   network and no broken links when assets are absent; embeds
   `assets/*.png` when present; unit tests cover both paths.
5. `merge-plan-fragments` / `mp-planner` / `validate-plan-index` carry the
   optional narrative meta; old indexes still validate.
6. Full suite green: `npm test` (all `test/*.test.mjs`), `mp doctor` clean on
   this repo, docs updated (`docs/verbs.md`, `docs/internals/`,
   `CHANGELOG.md`).
