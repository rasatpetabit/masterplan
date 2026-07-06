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
  `repo` optional — absent means same-repo, else the target repo root as a
  **canonical absolute path** — `/srv/dev` paths are host-stable on this
  fabric. Never MAIN-relative: MAIN is session-relative (a session opened in a
  sub-repo derives the sub-repo as its MAIN), so a relative path read from the
  other side of the ref resolves wrongly).
- **Ref identity is `(repo, slug)`, never slug alone:** two repos can
  legitimately hold same-slug runs, so upsert, removal, reciprocal resolution,
  and duplicate detection all key on the pair (absent `repo` normalizes to the
  holding bundle's own repo root before comparison).
- **Subcommands (sole writers, CD-7):**
  - `mp refs add --state=<path> --direction=back|forward --target=<slug> [--repo=<path>] [--label=…]`
  - `mp refs remove --state=<path> --direction=… --target=<slug> [--repo=<path>]`
  - `mp refs list --state=<path>` (read-only JSON).
- **Bidirectionality (the planf3 update-references workflow, made deterministic):**
  `refs add` resolves the target bundle at
  `<target-repo-root>/docs/masterplan/<target>/state.yml`. The default target
  repo is the SOURCE bundle's repo root — derived by walking up from the
  `--state` path to its containing repo — NEVER the session's MAIN (a parent
  session operating a sub-repo bundle would otherwise resolve "same repo" into
  the parent and write the reciprocal to the wrong bundle); `--repo=<path>`
  overrides for the cross-repo case. A supplied `--repo` is canonicalized
  (realpath — symlink aliases collapse) and must name a real repo root, else
  exit non-zero. The reciprocal entry (back↔forward) is written in the same
  invocation;
  both writes atomic per-file, ordered target-then-source so a crash leaves at
  worst a reciprocal-only entry that a re-run heals (idempotent upsert by
  `(repo, slug)` — duplicates are impossible). Missing target bundle on `add`
  → exit non-zero, nothing written.
- **Ownership (Guard D) on BOTH bundles:** before any write, `refs add/remove`
  preflights the owner sentinel of the SOURCE bundle and (when it resolves) the
  TARGET bundle; a LIVE foreign owner on either → exit non-zero, nothing
  written on either side (the error names the owning host/session). Stale or
  absent owners → proceed. Cross-bundle writes stay inside the single-writer
  discipline instead of racing a live session — and the source check matters
  because `--state` can name a bundle another session currently owns.
- **Removal semantics:** `refs remove` removes both sides when the target
  resolves; an unresolvable target (bundle or repo moved/deleted) removes the
  SOURCE side anyway and WARNs — a dangling ref must always be cleanable
  (only `add` is strict about the target existing).
- **Events:** `refs_added` / `refs_removed` appended to BOTH bundles'
  `events.jsonl`.
- **Seed sugar:** `mp seed --predecessor=<slug>` seeds a back ref to the named
  bundle (and its reciprocal forward ref) after writing the fresh state.
- **Surfacing:** `mp status` prints a refs block; `render-plan` echoes refs
  into the plan.html header metadata block with **path-aware links**: same-repo
  refs link relative `../<slug>/plan.html`; a cross-repo ref links the computed
  relative path to the target's `plan.html` ONLY when that file resolves on
  disk at render time, otherwise it renders as plain `repo:slug` text — never
  a broken link. Archived bundles are valid targets.
- **Migration:** absent `refs` key ≡ `{back: [], forward: []}` — no state
  version bump needed if the migration layer defaults it on load.
- **Field preservation (all writers):** every EXISTING state-mutating
  subcommand must round-trip the new keys (`refs`, `render`) untouched — a
  task update, sweep, review-config write, or archive must never drop them;
  tests assert survival through unrelated mutations.

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
- **Render freshness:** state-mutating commands whose output is rendered
  (`amend-plan`, `refs add/remove`) re-run the deterministic render inline
  when `plan.html` already exists, so the artifact never goes silently stale
  (cheap — the render is local and offline). `refs` mutates TWO bundles, so
  BOTH the source and (when it resolved) the target bundle's existing
  `plan.html` are re-rendered — a fresh source with a stale reciprocal is
  still a stale artifact.

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
  broken link). **The flag gates GENERATION only; embedding is by-presence**
  — assets already on disk keep rendering after the flag is turned off (delete
  `assets/` to un-embed); the render itself never consults the flag.
- **Escaping & path safety:** every user-controlled string that reaches the
  render (narrative meta, ref labels, amendment summaries/details, topics,
  slugs) is HTML-escaped; asset and ref-link paths must resolve inside the
  bundle or a discovery root (path traversal rejected). Tests include
  `<script>`/quote fixtures rendering inert.

### F5 — Multi-run discovery + dangling-run resilience (incl. sub-repos)

The visibility layer the user asked for: multiple masterplans must be able to
FIND each other, and an interrupted run must not silently dangle — especially
when it lives in a sub-repo the current session didn't open.

- **`mp runs list` (read-only inventory, the shared engine):** scans a set of
  discovery roots for `docs/masterplan/*/state.yml` and returns, per bundle:
  `{repo, slug, status, phase, tasks_done/total, last_activity, owner:{present,
  stale}, refs}`. `last_activity` is DERIVED, never stored — and
  **event-dominant**: max(last `events.jsonl` timestamp, newest
  owner-heartbeat mtime), falling back to `state.yml` mtime only when neither
  exists. File mtimes alone are unreliable — a `git checkout`, copy, or sync
  refreshes them and would mask a genuinely stale run; recorded events are the
  authoritative activity signal.
- **Discovery roots (deterministic, zero-config default):** MAIN + every
  nested git repo under MAIN (depth-limited walk, default ≤3, skipping
  `.worktrees/`, `node_modules/`, `.git/`) + every ENCLOSING git repo above
  MAIN (upward walk, ≤3 parent levels) — BOTH directions of the sub-repo case
  work out of the box: a parent session sees sub-repo runs, and a session
  opened inside the sub-repo sees the parent's runs. Extra roots (sibling
  repos) via `--roots=<a,b>` or a persistent
  `discovery.roots` list in `state`-adjacent repo config
  (`<MAIN>/docs/masterplan/.discovery.yml`, mp-written via
  `mp set-discovery --add-root/--remove-root`; an ARTIFACT-class config file,
  not run state).
- **De-dupe by `(realpath(repo root), slug)`:** the roots overlap by
  construction (a sub-repo session scans the sub-repo directly AND rediscovers
  it as a nested repo of the enclosing parent; `--roots`/`.discovery.yml`
  entries and symlink aliases multiply this) — the scan canonicalizes every
  discovered repo root via realpath and emits exactly ONE entry per
  `(repo root, slug)` pair.
- **Error isolation (per-bundle WARN/skip):** one malformed `state.yml`,
  corrupt `events.jsonl`, unreadable root/bundle, or symlink loop WARNs and
  skips THAT bundle/root — it never aborts the scan. Every consumer
  (`runs list`, doctor, sweep report, `status`) inherits this: discovery of
  other people's possibly-broken bundles must not take down the current
  session's own tooling.
- **Dangling-run surfacing (two consumers of the same engine):**
  1. **Doctor check `dangling-run` (new `lib/doctor/dangling-run.mjs`):** WARN
     per non-archived bundle across ALL discovery roots whose `last_activity`
     exceeds a threshold (default 7d, `--dangling-days=N`), or whose owner
     lock is stale while status is in-progress. Each WARN carries a
     REPO-AWARE resume command — `cd <repo> && /masterplan execute
     <state-path>` (plain `/masterplan execute <state-path>` only when the
     bundle's repo IS the current MAIN) — so a sub-repo run discovered from a
     parent session is never resumed with the parent's MAIN semantics.
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
| Ref entry shape? | `{slug, label, repo?}`; identity is `(repo, slug)` | Two repos can hold same-slug runs — slug-only upsert/remove could hit the wrong ref (adversary finding) | user-confirmed |
| Reciprocal write ordering? | Target first, then source; upsert-by-`(repo, slug)` idempotent | Crash leaves a heal-on-retry state, never a dup | assumed |
| Reciprocal write vs live sessions? | Live foreign owner on target → refuse, nothing written; stale/absent → proceed | Cross-bundle writes must respect Guard D single-writer discipline (adversary finding) | user-confirmed |
| Narrative fields required? | Optional in index; validator accepts absence | Back-compat with every existing bundle | assumed |
| Doctor check severity? | WARN, not FATAL (both spec-assumptions and dangling-run) | Old bundles must not start failing doctor | assumed |
| Cross-repo ref target resolution? | `--repo=<path>` on add AND remove; `repo` field always canonical-absolute | MAIN is session-relative, so MAIN-relative paths break when read from the other side; /srv/dev absolute paths are host-stable (adversary finding) | user-confirmed |
| Cross-repo links in plan.html? | Link only when the target plan.html resolves on disk at render time; else plain text | `../<slug>/` is only valid same-repo; never emit a broken link (adversary finding) | user-confirmed |
| Dangling ref cleanup? | `refs remove` cleans the source side even when the target is gone (WARN) | Stale refs must never be permanent; only `add` is strict (adversary finding) | user-confirmed |
| Discovery mechanism? | Zero-config nested-repo walk (depth ≤3) + upward walk (≤3 enclosing repos) + optional `.discovery.yml` extra roots; always scanned, never cached | Both directions of the sub-repo case visible out of the box (adversary finding: downward-only missed parent runs); cache = staleness bugs | user-confirmed |
| `last_activity` derivation? | Event-dominant: events/heartbeat first, state mtime only as fallback | git checkout/copy/sync refresh mtimes and mask genuinely stale runs (adversary finding) | user-confirmed |
| Dangling threshold? | 7 days default, flag-overridable | Long enough to skip weekend pauses, short enough to catch abandonment | assumed |
| Dangling surfacing? | Doctor WARN + session-sweep report line, both with exact resume command; never auto-resume | Visibility fixes the failure mode; auto-action would fight Guard D | user-confirmed |
| Render input trust? | HTML-escape all user-controlled strings; reject path traversal in asset/ref paths | Meta, labels, and amendment text are attacker-influenceable free text (adversary finding) | user-confirmed |
| Images flag semantics? | `render.images` gates generation only; embedding is by-presence | Deterministic render never consults config; delete assets to un-embed (adversary finding) | user-confirmed |
| Stale plan.html after mutations? | `amend-plan`/`refs` re-render inline when plan.html exists | The artifact must never go silently stale; render is offline-cheap (adversary finding) | user-confirmed |
| New-field durability? | All existing state writers round-trip `refs`/`render` unknown keys | A task update or sweep must never drop another feature's state (adversary finding) | user-confirmed |
| Default target repo for `refs`? | Derived from the `--state` path's repo root, never session MAIN; `--repo` overrides | A parent session operating a sub-repo bundle would otherwise write reciprocals into the wrong repo (adversary finding) | user-confirmed |
| `--repo` validation? | realpath-canonicalized; must name a real repo root, else exit non-zero | Symlink aliases must collapse to one identity; a non-repo path is always an error (adversary finding) | user-confirmed |
| Source-bundle ownership on `refs`? | Guard D preflight on BOTH source and target; live foreign owner on either → refuse, nothing written | `--state` can name a bundle another live session owns (adversary finding) | user-confirmed |
| Reciprocal render freshness? | `refs` re-renders BOTH mutated bundles' existing plan.html | A fresh source with a stale target reciprocal is still a stale artifact (adversary finding) | user-confirmed |
| Overlapping discovery roots? | De-dupe by `(realpath(repo root), slug)` — one entry per bundle | Sub-repo sessions rediscover their own repo via the parent's nested walk; symlinked/duplicate roots multiply (adversary finding) | user-confirmed |
| Scan failure isolation? | Per-bundle/root WARN + skip; never abort the scan | One corrupt foreign bundle must not take down runs list/doctor/sweep/status (adversary finding) | user-confirmed |
| Resume-command shape? | Repo-aware: `cd <repo> && /masterplan execute <path>` when the bundle's repo ≠ current MAIN | Resuming a sub-repo run from a parent session with parent MAIN semantics corrupts the run (adversary finding) | user-confirmed |

## Success criteria

1. `mp refs add/remove/list` maintain bidirectional refs across two bundles;
   unit tests cover add/remove/reciprocal/idempotent-upsert/missing-target,
   PLUS `(repo, slug)` identity (same slug in two repos resolves correctly),
   live-foreign-owner refusal on the target AND on the source, source-side
   removal of an unresolvable target, default-target-repo derivation from the
   `--state` path (a sub-repo bundle driven from a parent-session cwd links
   within the sub-repo, incl. a same-slug parent/sub-repo fixture), `--repo`
   canonicalization (symlink alias normalizes; non-repo path exits non-zero),
   and `refs_added`/`refs_removed` appended to BOTH bundles' `events.jsonl`;
   `mp status` and `plan.html` surface them (cross-repo links only
   when the target resolves on disk).
2. `mp amend-plan` appends to `plan.md` + `events.jsonl`; unit tests cover
   first-use section creation, append ordering, empty-summary refusal;
   amendments render in `plan.html`.
3. `commands/masterplan.md` brainstorm step persists the assumptions section;
   doctor WARNs on a new bundle's spec lacking it (test fixture).
4. `render-plan` renders narrative meta + refs + amendments + goals with NO
   network and no broken links when assets are absent; embeds
   `assets/*.png` when present; unit tests cover both paths, plus escaping
   fixtures (`<script>`/quotes in meta, labels, amendments render inert) and
   path-traversal rejection for asset/ref paths.
5. `merge-plan-fragments` / `mp-planner` / `validate-plan-index` carry the
   optional narrative meta; old indexes still validate.
6. `mp runs list` finds bundles in MAIN and in a nested sub-repo fixture, AND
   in the reverse direction (run from inside the sub-repo, parent-repo bundles
   appear via the upward walk); overlapping roots yield ONE entry per bundle
   (sub-repo scanned directly + via the parent's nested walk; a symlinked
   duplicate root de-dupes); a corrupt `state.yml`, corrupt `events.jsonl`
   timestamp, and an unreadable bundle each WARN + skip without aborting the
   scan; `last_activity` derives event-dominant (an old
   event stream with a freshly-touched state.yml still reads stale); unit
   tests cover the walk (depth cap, `.worktrees`/`node_modules` exclusion),
   extra roots, and the `.discovery.yml` round-trip.
7. The doctor `dangling-run` check WARNs on a stale-activity fixture bundle
   (and NOT on a fresh one), with the resume command in the message — and for
   a bundle whose repo ≠ the scanning MAIN the command is the repo-aware
   `cd <repo> && …` form; the
   session sweep report carries the same `dangling` entries; cross-repo refs
   resolve (and a dangling unresolvable ref target WARNs, not crashes).
8. New state fields survive unrelated mutations: tests drive a task update,
   sweep, and review-config write over a bundle carrying `refs` + `render`
   and assert both round-trip untouched; a pre-existing state WITHOUT the new
   keys loads with the documented defaults (`refs: {back:[], forward:[]}`,
   images off); `amend-plan` re-renders an existing `plan.html` inline, and
   `refs add`/resolved `refs remove` re-render BOTH bundles' existing
   `plan.html`.
9. Full suite green: `npm test` (all `test/*.test.mjs`), `mp doctor` clean on
   this repo, docs updated (`docs/verbs.md`, `docs/internals/`,
   `CHANGELOG.md`).
