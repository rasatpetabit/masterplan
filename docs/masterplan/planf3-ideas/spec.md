# Spec: planf3 idea imports — plan graph, amendments, questionables, visual render

**Run:** `planf3-ideas` · **Complexity:** high · **Source review:** https://github.com/disler/planf3

## Purpose

Import the genuinely novel ideas from planf3 (IndyDevDan's HTML-first planning
meta-skill) into masterplan — and, prompted by that review, close the adjacent
gaps in how multiple runs find/reference each other and how interrupted runs
stay visible (especially across sub-repos). All adapted to masterplan's
architecture: deterministic
decisions in `lib/*.mjs` behind `mp`, single-writer state (CD-7), offline
secret-free rendering, and the shell-owns-network v9 seam.

## Problem

planf3's review — plus a hard look at how runs coexist — surfaced five
capability gaps:

1. **Runs are islands.** Bundles have no cross-run references; the only link is
   `--predecessor-transcript` at seed. Multi-run efforts (v8 → v9 → this run)
   are not navigable from the artifacts.
1b. **Runs can't find each other, and interrupted runs dangle.** Discovery is a
   glob over the CURRENT repo's `docs/masterplan/*/state.yml` — a run seeded in
   a sub-repo (a nested git repo under MAIN) is invisible to sessions opened at
   the parent, and vice versa. Nothing surfaces a non-archived bundle that
   nobody has resumed in weeks (this repo's own `finish-flow-hardening` bundle,
   mid-brainstorm since seed, is a live example). Interruption *recovery* is
   solid (Guard D TTL, `mp sweep`, `mp continue` reconcile) but interruption
   *visibility* is not: a plan you can't see is a plan you never resume.
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

Five file-disjoint feature areas, one run.

### F1 — Plan-graph refs (cross-run back/forward references)

- **State model:** `state.yml` gains `refs: {back: [], forward: []}`; entry
  shape `{slug, label, repo?}` (label optional, defaults to the target's topic;
  `repo` optional — absent means same-repo, else a path to the target repo
  root, stored relative to MAIN when the target is inside it, absolute
  otherwise — `/srv/dev` paths are host-stable on this fabric).
- **Subcommands (sole writers, CD-7):**
  - `mp refs add --state=<path> --direction=back|forward --target=<slug> [--label=…]`
  - `mp refs remove --state=<path> --direction=… --target=<slug>`
  - `mp refs list --state=<path>` (read-only JSON).
- **Bidirectionality (the planf3 update-references workflow, made deterministic):**
  `refs add` resolves the target bundle at
  `<target-repo-root>/docs/masterplan/<target>/state.yml` (target repo = MAIN
  unless `--repo=<path>` names another repo root — the cross-repo/sub-repo
  case) and writes the reciprocal entry (back↔forward) in the same invocation; both
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

### F5 — Multi-run discovery + dangling-run resilience (incl. sub-repos)

The visibility layer the user asked for: multiple masterplans must be able to
FIND each other, and an interrupted run must not silently dangle — especially
when it lives in a sub-repo the current session didn't open.

- **`mp runs list` (read-only inventory, the shared engine):** scans a set of
  discovery roots for `docs/masterplan/*/state.yml` and returns, per bundle:
  `{repo, slug, status, phase, tasks_done/total, last_activity, owner:{present,
  stale}, refs}`. `last_activity` is DERIVED, never stored: max(state.yml
  mtime, last `events.jsonl` timestamp, newest owner-heartbeat mtime).
- **Discovery roots (deterministic, zero-config default):** MAIN + every
  nested git repo under MAIN (depth-limited walk, default ≤3, skipping
  `.worktrees/`, `node_modules/`, `.git/`) — the sub-repo case works out of
  the box. Extra roots (sibling repos) via `--roots=<a,b>` or a persistent
  `discovery.roots` list in `state`-adjacent repo config
  (`<MAIN>/docs/masterplan/.discovery.yml`, mp-written via
  `mp set-discovery --add-root/--remove-root`; an ARTIFACT-class config file,
  not run state).
- **Dangling-run surfacing (two consumers of the same engine):**
  1. **Doctor check `dangling-run` (new `lib/doctor/dangling-run.mjs`):** WARN
     per non-archived bundle across ALL discovery roots whose `last_activity`
     exceeds a threshold (default 7d, `--dangling-days=N`), or whose owner
     lock is stale while status is in-progress. Each WARN carries the exact
     resume command (`/masterplan execute <state-path>`).
  2. **Session sweep report:** the first-§2-entry `mp sweep` output gains a
     `dangling` array (same derivation, same threshold) so every session that
     touches masterplan surfaces forgotten runs — including sub-repo ones —
     without the user asking. Report-only in the sweep (the sweep never
     auto-resumes; Guard D still owns mutual exclusion).
- **Interaction, not just visibility:** `mp status` gains an `other runs`
  block (non-archived bundles from discovery, one line each) so any session
  sees the full picture; the §2-step-1 multi-bundle picker keeps operating on
  MAIN-repo bundles only (operating a sub-repo bundle means opening a session
  there — surfaced, not auto-taken-over).
- **Explicitly derived, never stored:** no `last_activity` field, no registry
  cache — a scan is cheap at this scale and a cache is a staleness bug farm.

## Non-goals

- No LLM-authored HTML (render stays deterministic from index + state).
- No in-artifact task status markers (state.yml remains the tracker; render
  already shows live status).
- No new external dependency in `mp` (image generation is shell-dispatched,
  optional, default-off).
- No auto-resume/auto-takeover of discovered dangling runs (visibility only;
  Guard D semantics unchanged).
- No registry/cache of discovered runs (always derived by scan).
- No multi-repo *execution* (a run's worktree still targets one repo; the
  qctl multi-repo apply spec stays flag-off and untouched).

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
| Doctor check severity? | WARN, not FATAL (both spec-assumptions and dangling-run) | Old bundles must not start failing doctor | assumed |
| Cross-repo ref target resolution? | `--repo=<path>` flag + `repo` field on the entry; relative-to-MAIN when nested, absolute otherwise | Sub-repo refs work; /srv/dev absolute paths are host-stable | user-confirmed |
| Discovery mechanism? | Zero-config nested-repo walk (depth ≤3) + optional `.discovery.yml` extra roots; always scanned, never cached | Sub-repo runs visible out of the box; cache = staleness bugs | user-confirmed |
| Dangling threshold? | 7 days default, flag-overridable | Long enough to skip weekend pauses, short enough to catch abandonment | assumed |
| Dangling surfacing? | Doctor WARN + session-sweep report line, both with exact resume command; never auto-resume | Visibility fixes the failure mode; auto-action would fight Guard D | user-confirmed |

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
6. `mp runs list` finds bundles in MAIN and in a nested sub-repo fixture;
   `last_activity` derives correctly; unit tests cover the walk (depth cap,
   `.worktrees`/`node_modules` exclusion), extra roots, and the
   `.discovery.yml` round-trip.
7. The doctor `dangling-run` check WARNs on a stale-activity fixture bundle
   (and NOT on a fresh one), with the resume command in the message; the
   session sweep report carries the same `dangling` entries; cross-repo refs
   resolve (and a dangling unresolvable ref target WARNs, not crashes).
8. Full suite green: `npm test` (all `test/*.test.mjs`), `mp doctor` clean on
   this repo, docs updated (`docs/verbs.md`, `docs/internals/`,
   `CHANGELOG.md`).
