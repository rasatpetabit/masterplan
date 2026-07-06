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
- **Target slug validation:** `--target` must be a bare run slug
  (`[a-z0-9][a-z0-9-]*`); anything containing `/`, `\`, `..`, or an absolute
  path exits non-zero BEFORE any path resolution (the bundle path is built by
  interpolation — an unvalidated slug is a traversal primitive). Slugs read
  back from `state.refs` are re-validated before any path construction too: a
  malicious stored slug renders as inert text but never builds a path.
- **Bidirectionality (the planf3 update-references workflow, made deterministic):**
  `refs add` resolves the target bundle at
  `<target-repo-root>/docs/masterplan/<target>/state.yml`. The default target
  repo is the SOURCE bundle's repo root — derived by walking up from the
  `--state` path to its containing repo — NEVER the session's MAIN (a parent
  session operating a sub-repo bundle would otherwise resolve "same repo" into
  the parent and write the reciprocal to the wrong bundle); `--repo=<path>`
  overrides for the cross-repo case. On `add`, a supplied `--repo` is
  canonicalized (realpath — symlink aliases collapse) and must name a real
  repo root, else exit non-zero. On `remove`, `--repo` matches the STORED ref
  identity as text (canonicalized only when the path still exists on disk) —
  strict validation there would make a ref to a moved/deleted repo permanently
  unremovable, contradicting the removal-leniency rule below. The reciprocal
  entry (back↔forward) is written in the same invocation;
  both writes atomic per-file, ordered target-then-source so a crash leaves at
  worst a reciprocal-only entry that a re-run heals (idempotent upsert by
  `(repo, slug)` — duplicates are impossible). Missing target bundle on `add`
  → exit non-zero, nothing written.
- **Ownership (Guard D) on BOTH bundles — acquire, don't preflight:**
  `refs add/remove` ACQUIRES the owner lock on the source bundle and (when it
  resolves) the target bundle — in deterministic order (sorted by canonical
  repo path, then slug, preventing AB/BA deadlock between two concurrent
  invocations) — holds both across the write, and releases on exit. A LIVE
  foreign owner on either → exit non-zero, nothing written on either side
  (the error names the owning host/session); stale or absent → acquire and
  proceed. A check-then-write preflight would be TOCTOU — two concurrent
  `refs` commands could both pass and last-write-wins; HOLDING the locks is
  what makes the cross-bundle write single-writer. The source check matters
  because `--state` can name a bundle another live session owns.
- **Removal semantics:** `refs remove` removes both sides when the target
  resolves; an unresolvable target (bundle or repo moved/deleted) removes the
  SOURCE side anyway and WARNs — a dangling ref must always be cleanable
  (only `add` is strict about the target existing).
- **Events:** `refs_added` / `refs_removed` appended to BOTH bundles'
  `events.jsonl` — source-only when the target didn't resolve (there is no
  target file to append to). An idempotent no-op (adding a ref that already
  exists, removing one that doesn't) appends NO event: no logical change means
  no synthetic activity — events drive `last_activity` (F5), so a no-op must
  not refresh a run's staleness clock.
- **Reciprocal label:** `--label` names the entry being ADDED on the named
  side only; the reciprocal entry's label defaults to the SOURCE bundle's
  topic — a label chosen for one direction is not silently reused for the
  other.
- **Seed sugar:** `mp seed --predecessor=<slug>` seeds a back ref to the named
  bundle (and its reciprocal forward ref) after writing the fresh state.
- **Surfacing:** `mp status` prints a refs block; `render-plan` echoes refs
  into the plan.html header metadata block with **by-presence links,
  uniformly**: EVERY ref — same-repo included — links the computed relative
  path to the target's `plan.html` ONLY when that file resolves on disk at
  render time, otherwise it renders as plain `slug` / `repo:slug` text —
  never a broken link (a valid same-repo target that was simply never
  rendered must not 404 either). A link target must resolve inside the ref's
  STORED canonical repo root — that root, recorded at add time, is the trust
  boundary (it need not be a discovery root; F4's traversal rule defers to
  this for ref links). Archived bundles are valid targets.
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
  newest last. **Input hygiene:** refuses an empty OR multiline summary (one
  line, and a leading `#` is rejected — it would corrupt the heading
  structure); detail may be multiline, but detail lines beginning with `#`
  are escaped on write so the `## Amendments` / `###` entry parse stays
  unambiguous. Refuses when `plan.md` is absent or the bundle is archived
  (there is nothing to amend / the run is closed).
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
  still a stale artifact. **Failure semantics:** mutation durability is never
  hostage to the render — state/plan writes commit first; a render failure
  afterwards WARNs loudly (naming each bundle whose artifact is now stale)
  and exits non-zero so callers notice. The mutation stands; the staleness is
  explicit, never silent.

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
  `/^##\s+Assumptions/mi`). WARN-only, and **version-scoped**: it applies only
  to bundles whose state schema version is ≥ the version this feature ships
  (the migration layer stamps versions) — legacy bundles are grandfathered
  and keep passing doctor byte-identically. "Doctor clean" throughout this
  spec means exit 0 / zero FATALs; expected WARNs (a known dangling legacy
  bundle, a grandfathered spec) are acceptable and enumerated, not failures.
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
  slugs) is HTML-escaped; asset paths must resolve inside the bundle's
  `assets/` directory, and ref-link paths inside the ref's stored canonical
  repo root (the F1 trust boundary) — path traversal rejected in both. Tests
  include `<script>`/quote fixtures rendering inert.

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
- **Error isolation (per-bundle WARN, skip only when uninventoriable):** one
  malformed `state.yml`, unreadable root/bundle, or symlink loop WARNs and
  skips THAT bundle/root — it never aborts the scan. A corrupt/unparsable
  `events.jsonl` is DIFFERENT: the bundle is WARNed but still INCLUDED, with
  `last_activity` derived from the fallback chain (heartbeat mtime, then
  `state.yml` mtime) — a single bad event line must not hide exactly the
  dangling run this feature exists to surface. Only a bundle whose
  `state.yml` cannot be read at all is uninventoriable. Every consumer
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
     parent session is never resumed with the parent's MAIN semantics. Both
     paths are shell-quoted on emission (single-quote escaping) so the
     command is paste-safe for paths containing spaces, quotes, or shell
     metacharacters — an emitted command is an injection surface.
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
| Resume-command shape? | Repo-aware: `cd <repo> && /masterplan execute <path>` when the bundle's repo ≠ current MAIN; paths shell-quoted | Resuming a sub-repo run from a parent session with parent MAIN semantics corrupts the run; unquoted emitted commands are an injection surface (adversary findings) | user-confirmed |
| Target slug validation? | Bare-slug charset only (`[a-z0-9][a-z0-9-]*`); separators/`..`/absolute paths exit non-zero; stored slugs re-validated before path building | The bundle path is built by interpolation — an unvalidated slug is a traversal primitive (adversary finding) | user-confirmed |
| Cross-bundle write concurrency? | Acquire BOTH owner locks (deterministic order: canonical repo path, then slug), hold across the write | Check-then-write preflight is TOCTOU — concurrent `refs` commands could both pass and last-write-wins (adversary finding) | user-confirmed |
| `--repo` on remove? | Textual match against the stored ref identity; strict realpath validation on add only | Strict validation on remove makes refs to moved/deleted repos permanently unremovable (adversary finding) | user-confirmed |
| Ref link policy? | By-presence for ALL refs incl. same-repo; trust boundary = the ref's stored canonical repo root | A never-rendered same-repo target would 404; F1/F4 boundary rules must not conflict (adversary findings) | user-confirmed |
| Corrupt events.jsonl at discovery? | WARN + INCLUDE the bundle with fallback activity derivation; only unreadable state.yml skips | Skipping would hide exactly the dangling run F5 exists to surface (adversary finding) | user-confirmed |
| Amendment input hygiene? | Single-line summary (no leading `#`); detail `#`-lines escaped; refuse absent plan.md / archived bundle | Free text can corrupt the `## Amendments` heading structure the renderer parses (adversary finding) | user-confirmed |
| Render failure after mutation? | Mutation commits first and stands; render failure WARNs per stale bundle + exits non-zero | Durability is never hostage to rendering, but staleness must be loud (adversary finding) | user-confirmed |
| New doctor WARNs vs legacy bundles? | Version-scoped to bundles at/after this feature's schema version; "doctor clean" = exit 0 / no FATALs | Legacy bundles must keep passing doctor byte-identically (adversary finding) | user-confirmed |
| No-op refs events? | Idempotent no-op add/remove appends NO event | Events drive `last_activity`; synthetic activity would mask staleness (adversary finding) | user-confirmed |
| Reciprocal label? | `--label` applies to the named side only; reciprocal defaults to the source bundle's topic | A label chosen for one direction silently reused for the other misdescribes it (adversary finding) | user-confirmed |

## Success criteria

1. `mp refs add/remove/list` maintain bidirectional refs across two bundles;
   unit tests cover add/remove/reciprocal/idempotent-upsert/missing-target,
   PLUS `(repo, slug)` identity (same slug in two repos resolves correctly),
   live-foreign-owner refusal on the target AND on the source, source-side
   removal of an unresolvable target, default-target-repo derivation from the
   `--state` path (a sub-repo bundle driven from a parent-session cwd links
   within the sub-repo, incl. a same-slug parent/sub-repo fixture), `--repo`
   canonicalization (symlink alias normalizes; non-repo path exits non-zero
   on add; textual stored-identity match lets a ref to a DELETED repo be
   removed), target-slug validation (`--target=../x`, `a/b`, absolute path
   all exit non-zero; a malicious stored slug never builds a path),
   concurrent add/remove against the same bundle pair serializing via the
   held owner locks, no-op add/remove appending NO event, the reciprocal
   label defaulting to the source topic (not the supplied `--label`),
   and `refs_added`/`refs_removed` appended to BOTH bundles' `events.jsonl`
   (source-only on unresolved target);
   `mp status` and `plan.html` surface them (links by-presence only, for
   same-repo refs too).
2. `mp amend-plan` appends to `plan.md` + `events.jsonl`; unit tests cover
   first-use section creation, append ordering, refusals (empty summary,
   multiline summary, absent `plan.md`, archived bundle), and detail
   `#`-line escaping keeping the Amendments parse unambiguous;
   amendments render in `plan.html`.
3. `commands/masterplan.md` brainstorm step persists the assumptions section;
   doctor WARNs on a new bundle's spec lacking it (test fixture).
4. `render-plan` renders narrative meta + refs + amendments + goals with NO
   network and no broken links when assets are absent; embeds
   `assets/*.png` when present; unit tests cover both paths, plus escaping
   fixtures (`<script>`/quotes in meta, labels, amendments render inert),
   path-traversal rejection for asset/ref paths, and a same-repo ref whose
   target has no `plan.html` rendering as plain text (no broken link).
5. `merge-plan-fragments` / `mp-planner` / `validate-plan-index` carry the
   optional narrative meta; old indexes still validate.
6. `mp runs list` finds bundles in MAIN and in a nested sub-repo fixture, AND
   in the reverse direction (run from inside the sub-repo, parent-repo bundles
   appear via the upward walk); overlapping roots yield ONE entry per bundle
   (sub-repo scanned directly + via the parent's nested walk; a symlinked
   duplicate root de-dupes); a corrupt `state.yml` and an unreadable bundle
   each WARN + skip without aborting the scan, while a corrupt
   `events.jsonl` WARNs but still lists the bundle with fallback-derived
   activity; non-repo/unreadable `--roots` and `.discovery.yml` entries WARN
   + skip; `last_activity` derives event-dominant (an old
   event stream with a freshly-touched state.yml still reads stale); unit
   tests cover the walk (depth cap, `.worktrees`/`node_modules` exclusion),
   extra roots, and the `.discovery.yml` round-trip.
7. The doctor `dangling-run` check WARNs on a stale-activity fixture bundle
   (and NOT on a fresh one), with the resume command in the message — and for
   a bundle whose repo ≠ the scanning MAIN the command is the repo-aware
   `cd <repo> && …` form with shell-quoted paths (a fixture path containing
   a space/quote emits a paste-safe command); the
   session sweep report carries the same `dangling` entries; cross-repo refs
   resolve (and a dangling unresolvable ref target WARNs, not crashes).
8. New state fields survive unrelated mutations: tests drive a task update,
   sweep, review-config write, `set-render-config`, archive, and a
   continue-reconcile over a bundle carrying `refs` + `render` and assert
   both round-trip untouched; a pre-existing state WITHOUT the new
   keys loads with the documented defaults (`refs: {back:[], forward:[]}`,
   images off); `amend-plan` re-renders an existing `plan.html` inline,
   `refs add`/resolved `refs remove` re-render BOTH bundles' existing
   `plan.html`, and a forced render failure after mutation leaves the
   mutation durable, WARNs naming the stale bundle(s), and exits non-zero.
9. Full suite green: `npm test` (all `test/*.test.mjs`); `mp doctor` clean on
   this repo in the defined sense — exit 0, zero FATALs, new WARNs
   version-scoped so legacy bundles pass byte-identically (a fixture legacy
   bundle without the assumptions section stays WARN-free); docs updated
   (`docs/verbs.md`, `docs/internals/`, `CHANGELOG.md`).
