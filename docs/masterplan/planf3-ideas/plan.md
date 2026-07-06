# planf3 idea imports — plan graph, amendments, assumptions ledger, visual render, multi-run discovery

Spec: docs/masterplan/planf3-ideas/spec.md

26 task(s) across 8 wave(s).

## Wave 0

### Task 1: Author the NEW lib/refs.mjs pure decision core for (repo,slug)-identified bidirectional refs, and its pure-unit coverage in test/refs.test.mjs. Design and implement: idempotent upsert / remove / list keyed on the (repo,slug) PAIR (absent repo normalizes to the holding bundle's own repo root before compare); reciprocal entry construction (back<->forward) with the reciprocal label defaulting to the SOURCE topic (never the supplied --label); default-target-repo derivation by walking UP from the --state path to its containing repo root (NEVER session MAIN); target-slug charset validation ([a-z0-9][a-z0-9-]*) as a path-traversal guard that rejects '/', '\\', '..', and absolute paths BEFORE any path construction, INCLUDING re-validation of slugs read back from state.refs; and the no-op detector (adding an existing / removing an absent ref => changed:false so the bin appends no event). Decide the pure/impure split: keep realpath canonicalization and fs walking behind small injectable helpers so the core stays unit-testable. Resolve target bundle path as <target-repo-root>/docs/masterplan/<target>/state.yml.
- files: lib/refs.mjs, test/refs.test.mjs
- verify: node --check lib/refs.mjs ; node --test test/refs.test.mjs
- codex: heuristic
- spec_refs: spec.md#L50-L133, spec.md#L342-L361

### Task 2: Add the refs default to the shared lib/migrate.mjs so an absent refs key loads as {back:[],forward:[]} as on-load defaults (the schemaVersion 8-to-9 bump itself is owned by render.state-model, not here) — apply it on BOTH the >=6 flat passthrough and the 5.x mapLegacyToV8 path — and cover it in test/migrate.test.mjs (a bundle with no refs key migrates to the empty-refs default; an existing refs value is preserved untouched). Keep the edit surgical: this file is shared with sibling subsystems adding their own load-time default, so touch only the refs default.
- files: lib/migrate.mjs, test/migrate.test.mjs
- verify: node --check lib/migrate.mjs ; node --test test/migrate.test.mjs
- codex: heuristic
- spec_refs: spec.md#L128-L129

### Task 7: Implement the amend-plan writer module lib/amend.mjs: append an `### <ISO date> — <summary>` entry (plus optional detail body) under a `## Amendments` section in plan.md, creating that section at EOF on first use and keeping it append-only, newest-last. Input hygiene: refuse an empty OR multiline summary and a leading-`#` summary (would corrupt the heading structure); detail may be multiline but escape any detail line beginning with `#` so the `## Amendments`/`###` parse stays unambiguous; refuse when plan.md is absent or the bundle is archived (nothing to amend / run closed). Emit a plan_amended {summary} event. Choose the escaping and section-detection scheme so the render subsystem can parse the block unambiguously. ALSO author test/amend.test.mjs alongside the module (mirroring the refs core+test pattern) with the pure-writer coverage: first-use section creation, append ordering, refusals (empty/multiline/leading-# summary, absent plan.md, archived bundle), detail #-line escaping. Later tasks extend this existing file — verify commands downstream run against a file that exists from wave one.
- files: lib/amend.mjs, test/amend.test.mjs
- verify: node --check lib/amend.mjs ; node --test test/amend.test.mjs
- codex: heuristic
- spec_refs: docs/masterplan/planf3-ideas/spec.md#L135-L163, docs/masterplan/planf3-ideas/spec.md#L362-L366

### Task 10: Expand renderPlanHtml in lib/plan-merge.mjs (sole owner) to add, in order: header metadata including refs, narrative Purpose/Problem/Solution sections (optional meta), the existing wave SVG, task table, goals block, and an Amendments timeline parsed from the ## Amendments markdown F2 writes. Refs render with by-presence links UNIFORMLY (same-repo included): link the computed relative path to the target's plan.html ONLY when that file resolves at render time inside the ref's STORED canonical repo root, else plain slug / repo:slug text — never a broken link. Optional images embedded by-presence from assets/{hero,wave-<n>}.png via relative src (never a broken img); the render NEVER consults the render flag — embedding is by-presence. HTML-escape ALL user-controlled strings (narrative meta, ref labels, amendment summary/detail, topics, slugs) and REJECT path traversal in asset paths (must resolve inside the bundle assets/ dir) and ref-link paths (must resolve inside the ref's canonical repo root). This is the HUB: design renderPlanHtml's signature to accept refs state and a render-freshness/asset-dir context so F1 (refs inline re-render) and F2 (amend inline re-render) can call it inline. Add test/plan-merge.test.mjs coverage: narrative/refs/amendments/goals render offline, absent assets produce no <img>, present assets embed by slot name, a same-repo ref whose target has no plan.html renders as plain text, and <script>/quote fixtures in meta+labels+amendments render inert, plus path-traversal rejection for asset and ref-link paths.
- files: lib/plan-merge.mjs, test/plan-merge.test.mjs
- verify: node --test test/plan-merge.test.mjs
- codex: no
- spec_refs: spec.md#L184-L215, spec.md#L118-L127, spec.md#L369-L375

### Task 12: Add the state.render model to lib/bundle.mjs following the setReviewConfig pattern: a setRenderConfig(state, {images}) merge-updater writing nested state.render.images ('on'|'off'), and a render default in buildSeedState (images off unless seeded on). Ensure field-preservation — every existing state-mutating writer must round-trip the new render key untouched (mirror the refs/render preservation contract). Add test/bundle.test.mjs coverage: setRenderConfig round-trip, buildSeedState default, and survival of state.render through an unrelated mutation. NOTE: lib/bundle.mjs is shared with the refs subsystem (F1 adds state.refs); keep edits confined to the render key so the merge can serialize the two bundle tasks cleanly. ALSO own the schema-version bump: raise buildSeedState's schemaVersion default (currently 8) to 9 and export a named CURRENT_SCHEMA_VERSION constant from lib/bundle.mjs — this is the threshold the version-scoped doctor WARNs (spec-assumptions) key on to grandfather legacy bundles. Coordinate: the migrate-default tasks' on-load defaults for refs/render ARE the 8-to-9 migration content; the bump itself lives here, once.
- files: lib/bundle.mjs, test/bundle.test.mjs
- verify: node --test test/bundle.test.mjs
- codex: no
- spec_refs: spec.md#L196-L209, spec.md#L130-L133

### Task 15: Update agents/mp-planner.md (the serial planning path) to distill the optional narrative meta {purpose, problem, solution} (1-3 sentences each) from spec.md and emit it into plan.index.json's meta, matching the same field contract the parallel merge --meta path carries. This is prompt-authoring judgment: the agent must produce meta that is faithful to the spec, safe to render (no assumption of trusted HTML — the render escapes it), and omittable without breaking old bundles.
- files: agents/mp-planner.md
- verify: rg -n "purpose|problem|solution|meta" agents/mp-planner.md
- codex: no
- spec_refs: spec.md#L186-L191, spec.md#L375-L376

### Task 18: Design and implement the NEW lib/runs.mjs shared discovery engine: scan discovery roots (MAIN + nested git repos under MAIN via a depth-capped (default <=3) walk that skips .worktrees/node_modules/.git, PLUS enclosing git repos <=3 levels UP) for docs/masterplan/*/state.yml, de-dupe by (realpath(repo root), slug), and return per-bundle {repo, slug, status, phase, tasks_done/total, last_activity, owner:{present,stale}, refs}. Decide the DERIVED, never-stored, event-dominant last_activity = max(last events.jsonl ts, newest owner-heartbeat mtime), falling back to state.yml mtime only when neither exists. Implement per-bundle/per-root WARN+skip error isolation: an unreadable/malformed state.yml or a symlink loop skips THAT bundle/root without aborting the scan, but a corrupt/unparsable events.jsonl WARNs and STILL INCLUDES the bundle with fallback-derived activity (a single bad event line must not hide the dangling run). CARRYOVER: the nested-repo walk must recognize a .git FILE gitlink (worktree/submodule), not only a .git directory. Also export a single shared dangling-classification helper (threshold + stale-in-progress-owner rule) so the doctor check and the sweep report consume ONE derivation, and the read side of the <MAIN>/docs/masterplan/.discovery.yml roots config plus --roots merge.
- files: lib/runs.mjs
- verify: node --check lib/runs.mjs
- codex: no
- spec_refs: spec.md#L223-L259, spec.md#L282-L284

### Task 24: Add the required pre-approval step to the brainstorm flow in commands/masterplan.md (§3 / spec-approval gate): before a spec is presented for approval, the flow must persist an '## Assumptions & Open Decisions' section into spec.md with one row per material decision (question / decision / rationale / source: assumed|user-confirmed). This is a convention edit to the orchestrator prompt prose only — decide the exact wording and where in the gate sequence the step lands so it reads as a hard pre-approval requirement (not optional), keeping it inside the spec-gate hash coverage. No new state, no new subcommand. NOTE: commands/masterplan.md is a hot cross-subsystem file (refs/amend/render surfacing also edit it); the merge serializes same-file tasks via file-disjointness, so this task's file set is kept to commands/masterplan.md alone.
- files: commands/masterplan.md
- verify: grep -nF 'Assumptions & Open Decisions' commands/masterplan.md
- codex: no
- spec_refs: spec.md#L165-L173, spec.md#L367-L368, goals.md#L19-L22

## Wave 1

### Task 3: Cross-cutting FIELD-PRESERVATION guard as a NEW test-only file test/refs-preservation.test.mjs. Confirmed by reading lib/bundle.mjs: serializeState emits every Object.entries key and every state transform spreads {...state}, so unknown keys (refs, render) round-trip for FREE — this is test-only, NO writer edit is needed. Assert refs/render survive UNTOUCHED through each writer path (existing ones, plus the NEW set-render-config writer introduced by render.state-model — dep-ordered so it exists): markTask (task update), setReviewConfig / set-render-config, setCodexConfig, setWorktreeDisposition, rebasePaths, and a serialize->parse round-trip standing in for sweep/archive/continue-reconcile. If any assertion unexpectedly fails at execution, that is the signal a specific writer needs a fix — but per the read, none should. EQUIVALENCE NOTE (make it explicit in the test file header comment): the serialize->parse round-trip stands in for sweep/archive/continue-reconcile because every state transform spreads {...state} and serializeState emits all keys — if that architectural invariant ever breaks, the spread-based writers under direct test here break identically, so the stand-in is representative; cite lib/bundle.mjs serializeState in the comment.
- files: test/refs-preservation.test.mjs
- verify: node --test test/refs-preservation.test.mjs
- codex: ok
- spec_refs: spec.md#L130-L133

### Task 4: Register `refs add|remove|list` plus the `mp seed --predecessor=<slug>` sugar as localized new case blocks in the SHARED bin/masterplan.mjs (which also carries the user's uncommitted staged T11 work — scope every edit to a single self-contained case block, import lib/refs.mjs, touch no unrelated case). Wire the cross-bundle write path: ACQUIRE (do not preflight) the Guard-D owner lock on BOTH source and resolved target in deterministic sorted (canonical-repo, slug) order to avoid AB/BA deadlock, hold both across the write, release on exit; a LIVE foreign owner on EITHER side exits non-zero writing nothing (name the owner). On add: canonicalize --repo via realpath and require a real repo root (else non-zero); missing target bundle exits non-zero. On remove: match the STORED --repo identity textually (canonicalize only if the path still exists) and apply removal-leniency — an unresolvable target removes the SOURCE side and WARNs. Write reciprocal target-then-source (atomic per file), append refs_added/refs_removed to BOTH bundles' events.jsonl (source-only when the target did not resolve), and skip the event on an idempotent no-op. After the state/plan writes commit, CALL renderPlanHtml inline to re-render BOTH mutated bundles' existing plan.html (mutation durability is never hostage to render; a render failure WARNs per-bundle and exits non-zero). Note: this CALLS renderPlanHtml (owned by the render subsystem) — it does NOT edit lib/plan-merge.mjs; passing refs into the header is forward-compatible with the render subsystem's signature change.
- files: bin/masterplan.mjs
- verify: node --check bin/masterplan.mjs
- codex: no
- spec_refs: spec.md#L63-L117, spec.md#L153-L163, spec.md#L342-L361

### Task 11: Thread the optional narrative meta {purpose, problem, solution} through the parallel planning path in lib/plan-merge.mjs: mergePlanFragments must accept meta (via opts) and emit it as index.meta so the fragment-merge --meta path carries the distilled strings into plan.index.json. Make validatePlanIndex ACCEPT-AND-IGNORE the meta fields (and their absence) for back-compat — old indexes with no meta stay valid, new indexes with meta stay valid, and a malformed meta value is a soft-ignore not a hard error. Add test/plan-merge.test.mjs cases proving meta round-trips through merge and that validatePlanIndex passes indexes both with and without the fields.
- files: lib/plan-merge.mjs, test/plan-merge.test.mjs
- verify: node --test test/plan-merge.test.mjs
- codex: no
- spec_refs: spec.md#L186-L191, spec.md#L375-L376

### Task 13: Default state.render on load in the shared lib/migrate.mjs so an absent render key reads as {images:'off'} with NO schema version bump (mirror the refs default-on-load approach). Legacy bundles must keep passing doctor byte-identically — the default is applied in-memory on load, not written back gratuitously. Add test/migrate.test.mjs coverage that a bundle without a render key loads with the default and that a bundle carrying render is preserved. NOTE: lib/migrate.mjs is shared with the refs subsystem's default-on-load; scope edits to the render default only.
- files: lib/migrate.mjs, test/migrate.test.mjs
- verify: node --test test/migrate.test.mjs
- codex: no
- spec_refs: spec.md#L128-L129, spec.md#L196-L209

### Task 20: Design the NEW auto-discovered lib/doctor/dangling-run.mjs check (exports a synchronous check(repoRoot, opts) -> Finding[]; NO registry edit — bin/doctor.mjs globs lib/doctor/*.mjs). WARN per non-archived bundle across ALL discovery roots whose last_activity exceeds the threshold (default 7d, --dangling-days=N) OR whose owner lock is stale while status is in-progress; PASS when clean, SKIP when no bundles. Each WARN carries a REPO-AWARE resume command: `cd <repo> && /masterplan execute <state-path>` when the bundle's repo != current MAIN, and the plain `/masterplan execute <state-path>` only when the bundle repo IS the current MAIN. Both paths must be shell single-quote-escaped on emission so a path containing spaces, quotes, or shell metacharacters is paste-safe — decide the quoting carefully because the emitted command is an injection surface. Consume the shared dangling-classification helper from lib/runs.mjs (no duplicated threshold logic).
- files: lib/doctor/dangling-run.mjs
- verify: node --check lib/doctor/dangling-run.mjs ; node -e "import('./lib/doctor/dangling-run.mjs').then(m=>process.exit(typeof m.check==='function'?0:1))"
- codex: no
- spec_refs: spec.md#L260-L272, spec.md#L389-L395

### Task 21: Add the `dangling` array to lib/sweep.mjs's returned report object (same derivation and threshold as the doctor check, sourced from the shared lib/runs.mjs helper — no re-derivation) so the first-entry `mp sweep` output surfaces forgotten runs, including sub-repo ones, report-only: the sweep never auto-resumes (Guard D still owns mutual exclusion). Keep the edit localized to the report assembly. Note lib/sweep.mjs is NOT in the T11 staged set — scope the change tightly and preserve the existing dry-run/apply result shape.
- files: lib/sweep.mjs
- verify: node --check lib/sweep.mjs ; node bin/masterplan.mjs sweep --repo-root="$PWD"
- codex: no
- spec_refs: spec.md#L272-L276

### Task 25: Design and implement the new auto-discovered WARN check lib/doctor/spec-assumptions.mjs plus its fixtures and scenarios in the shared test/doctor.test.mjs. The check emits WARN on a non-archived bundle whose spec.md exists but lacks an '## Assumptions' heading (match /^##\s+Assumptions/mi); PASS when present, SKIP when spec.md absent. It is version-scoped: decide the schema-version threshold by reading the migrate schema-version stamp (state.schema_version) so bundles at/after this feature's schema version are checked while legacy/pre-feature bundles pass doctor byte-identically. IMPORTANT coordination: the threshold must equal the schema version the render/refs migrate edits stamp — source it from the shared bundle/migrate schema-version constant (single source of truth), do NOT hard-code a divergent literal; coordinate the stamp semantics with the render/refs subsystem's migrate edits. Follow the existing lib/doctor module contract (sync check(repoRoot, opts) -> Finding[], >=1 finding, crash-isolated by bin/doctor.mjs). Add fixtures under test/fixtures/doctor/spec-assumptions/ using the scenario-prefix convention (warn-* post-feature-missing, pass-* post-feature-present, and a grandfathered legacy fixture that stays WARN-free) and wire the import + scenario loop into test/doctor.test.mjs. NOTE: test/doctor.test.mjs is shared (a sibling schema-version bump may also touch buildSeedState's schemaVersion default); the merge serializes same-file tasks by file-disjointness. VERSION-SCOPING mechanism (resolves the round-4 carryover): import CURRENT_SCHEMA_VERSION from lib/bundle.mjs (introduced by render.state-model) and WARN only for bundles whose state schemaVersion >= 9; the test fixture set includes a v8 legacy bundle without the section that stays WARN-free (grandfathered byte-identically).
- files: lib/doctor/spec-assumptions.mjs, test/doctor.test.mjs, test/fixtures/doctor/spec-assumptions/
- verify: node --test test/doctor.test.mjs ; node bin/masterplan.mjs doctor
- codex: no
- spec_refs: spec.md#L174-L182, spec.md#L338, spec.md#L405-L409, goals.md#L19-L22

## Wave 2

### Task 6: CREATE the base `mp status` verb in the SHARED bin/masterplan.mjs — no `case 'status'` exists today (only set-/finish-/coord-/goals-status). The new case prints a one-bundle state summary (slug, status, phase, tasks done/total) PLUS the refs block: a bundle with refs prints its back/forward refs (slug / repo:slug; links are a render concern, not status). This is the base surface the discovery subsystem later EXTENDS with the other-runs block — keep the case block self-contained and extension-friendly. Shares bin/masterplan.mjs with refs.cli, so it is serialized after it; scope the edit to the single new case block (the file also carries the user's uncommitted staged T11 work).
- files: bin/masterplan.mjs
- verify: node --check bin/masterplan.mjs
- codex: heuristic
- spec_refs: spec.md#L118-L127, goals.md#L11-L13

### Task 23: Add dangling-run fixtures and cases to test/doctor.test.mjs: the `dangling-run` check WARNs on a stale-activity bundle and does NOT warn on a fresh one; a bundle whose repo != the scanning MAIN emits the repo-aware `cd <repo> && …` resume form while a MAIN-repo bundle emits the plain form; a fixture path containing a space and a quote emits a paste-safe shell-quoted command (assert the exact escaped string); and a stale in-progress owner lock triggers the WARN independent of the day threshold.
- files: test/doctor.test.mjs
- verify: node --test test/doctor.test.mjs
- codex: heuristic
- spec_refs: spec.md#L389-L395, goals.md#L35-L37

## Wave 3

### Task 5: Extend test/refs.test.mjs with the full CLI-driven success-criteria matrix by spawning `mp refs add|remove|list`: add/remove/reciprocal-write/idempotent-upsert/missing-target; (repo,slug) identity (same slug in two repos resolves correctly, incl. a same-slug parent/sub-repo fixture); live-foreign-owner refusal on BOTH target and source; source-side removal of an unresolvable (deleted-repo) target via textual --repo match; default-target-repo derivation from the --state path (sub-repo bundle driven from a parent cwd links within the sub-repo, not MAIN); --repo realpath canonicalization (symlink alias normalizes; non-repo path exits non-zero on add); target-slug validation (--target=../x, a/b, absolute all exit non-zero; a malicious stored slug renders inert and never builds a path); concurrent add/remove against the same pair serializing via the held locks; no-op add/remove appending NO event; reciprocal label defaulting to the source topic; refs_added/refs_removed in BOTH events.jsonl (source-only on unresolved target); cross-repo `--repo=` writing reciprocals across repos. Shares test/refs.test.mjs with refs.core, so it must land after it. ADDITIONALLY assert: (1) `mp status` on a refs-carrying bundle PRINTS the refs block (spawn the verb, assert back/forward entries appear — G2 is only proven by output, node --check proves nothing); (2) `refs add` and a resolved `refs remove` re-render BOTH bundles' existing plan.html (mtime/content change on each side); (3) a forced render failure after a refs mutation leaves the mutation durable, WARNs naming each stale bundle, and exits non-zero.
- files: test/refs.test.mjs
- verify: node --test test/refs.test.mjs
- codex: heuristic
- spec_refs: spec.md#L342-L361

### Task 8: Register the `amend-plan` verb as ONE self-contained case block in the SHARED bin/masterplan.mjs (scope to the single case; the file carries the user's uncommitted staged T11 work). One coherent unit with two adversary-carryover sub-requirements folded in rather than split across waves: (a) BASE: parse --summary/--detail, call lib/amend.mjs, append the plan_amended {summary} event; (b) GUARD-D OWNERSHIP (carryover): ACQUIRE the bundle's owner lock before the mutation and release on exit — a LIVE foreign owner exits non-zero writing nothing (amend-plan mutates a bundle another live session may own); (c) RENDER-FAILURE SEMANTICS (carryover): after the plan.md/event writes commit, re-run renderPlanHtml inline when plan.html exists; mutation durability is never hostage to the render — a render failure WARNs naming the stale bundle and exits non-zero while the mutation stands. Verify against the already-existing test/amend.test.mjs.
- files: bin/masterplan.mjs
- verify: node --check bin/masterplan.mjs ; node --test test/amend.test.mjs
- codex: no
- spec_refs: docs/masterplan/planf3-ideas/spec.md#L137-L145, docs/masterplan/planf3-ideas/spec.md#L153-L163, docs/masterplan/planf3-ideas/spec.md#L326-L327, docs/masterplan/planf3-ideas/spec.md#L91-L94

## Wave 4

### Task 9: EXTEND the EXISTING test/amend.test.mjs (created by amend.writer) — never overwrite its pure-writer coverage covering the full amend surface: first-use section creation, append-only newest-last ordering, refusals (empty summary, multiline summary, leading-`#` summary, absent plan.md, archived bundle), detail `#`-line escaping keeping the Amendments parse unambiguous, plan_amended {summary} event emission, inline plan.html re-render when plan.html exists, Guard-D refusal on a live foreign owner (nothing written), and the render-failure path (mutation stands, WARN names the stale bundle, exit non-zero).
- files: test/amend.test.mjs
- verify: node --test test/amend.test.mjs
- codex: heuristic
- spec_refs: docs/masterplan/planf3-ideas/spec.md#L362-L366, docs/masterplan/planf3-ideas/goals.md#L15-L18

### Task 14: Wire the render-owned case blocks in the SHARED bin/masterplan.mjs — keep each edit a single localized case block and DO NOT touch the user's staged T11 regions. (1) render-plan case: pass refs (from state), narrative meta (from index.meta), the bundle assets dir, and render-freshness context into renderPlanHtml. (2) merge-plan-fragments case: forward narrative meta {purpose,problem,solution} into mergePlanFragments so index.meta is populated on the parallel path. (3) New set-render-config --images=on|off case mirroring set-review-config (calls setRenderConfig, enum-validates on|off), plus a seed --render-images=on flag threading into the render default. (4) CARRYOVER: keep render-plan idempotently re-runnable so F1/F2 callers can retry the render after a post-commit render failure (mutation stands, staleness explicit). validate-plan-index case needs no change (accept-and-ignore lives in the lib). Verify via the full unit suite since bin cases are exercised there. CAUTION: the seed case block is also edited by refs.cli (--predecessor sugar) in an earlier wave — preserve that addition when adding --render-images; never rewrite the whole case.
- files: bin/masterplan.mjs
- verify: node --test test/*.test.mjs
- codex: no
- spec_refs: spec.md#L192-L209, spec.md#L153-L163, spec.md#L369-L376

## Wave 5

### Task 16: Document the render subsystem in docs/internals/plan-parser.md: the expanded renderPlanHtml section order (header+refs, narrative meta, wave SVG, task table, goals, Amendments timeline), the ## Amendments markdown parse, by-presence image embedding from assets/{hero,wave-<n>}.png, the escaping + path-traversal trust boundaries (asset dir and ref canonical repo root), the state.render model with mp set-render-config / seed --render-images, and the narrative-meta threading through merge-plan-fragments --meta / mp-planner / validate-plan-index back-compat.
- files: docs/internals/plan-parser.md
- verify: rg -n "Amendments|narrative|render|set-render-config" docs/internals/plan-parser.md
- codex: heuristic
- spec_refs: spec.md#L184-L215

### Task 17: Wire the OPTIONAL shell-side image generation into the orchestrator prompt at the plan-to-execute seam (commands/masterplan.md, the same place the plan gate resolves): when the bundle's state.render.images is 'on', the SHELL (never mp) dispatches image generation through the skynet gateway image lane for the slot-name convention assets/{hero,wave-<n>}.png, writes the PNGs into the bundle's assets/ dir, and re-runs `mp render-plan`; no key, lane down, or flag off means SKIP silently — the render is complete regardless (embedding is by-presence; the render never consults the flag). This makes the flag real: without this step the set-render-config/seed --render-images setters are inert. Keep the edit a single new step block in the prompt; do not restructure adjacent sections. Note commands/masterplan.md is also edited by assumptions.brainstorm-step in an earlier wave — preserve its addition.
- files: commands/masterplan.md
- verify: grep -n 'render.images' commands/masterplan.md ; grep -n 'assets/' commands/masterplan.md
- codex: heuristic
- spec_refs: spec.md#L204-L215

### Task 19: Add the NEW `mp runs` (list) and `mp set-discovery --add-root/--remove-root` case blocks to the shared bin/masterplan.mjs, each scoped to a single localized case block, wiring them to lib/runs.mjs — including the <MAIN>/docs/masterplan/.discovery.yml artifact-config round-trip WRITE side (add/remove a persistent discovery.roots entry). Also inject the `other runs` block (non-archived discovered bundles, one line each) into the `mp status` surface that the refs subsystem introduces in this same file; this edit must land AFTER refs creates the `mp status` case (shared file → merge serializes) and the multi-bundle picker keeps operating on MAIN-repo bundles only. Choose a JSON/porcelain shape for `mp runs list` consistent with the engine's per-bundle record.
- files: bin/masterplan.mjs
- verify: node --check bin/masterplan.mjs ; node bin/masterplan.mjs runs list --repo-root="$PWD"
- codex: no
- spec_refs: spec.md#L232-L242, spec.md#L277-L281

## Wave 6

### Task 22: Author the NEW test/runs-list.test.mjs proving the engine + CLI: `mp runs list` inventories bundles in MAIN and in a nested sub-repo fixture (depth cap, .worktrees/node_modules exclusion) AND the reverse direction (invoked from inside the sub-repo, parent-repo bundles appear via the upward walk); overlapping roots yield exactly ONE entry per bundle (sub-repo scanned directly + rediscovered via the parent's nested walk; a symlinked duplicate root de-dupes); a corrupt state.yml and an unreadable bundle each WARN+skip without aborting, while a corrupt events.jsonl WARNs but STILL lists the bundle with fallback-derived activity; non-repo/unreadable --roots and .discovery.yml entries WARN+skip; last_activity derives event-dominant (an old event stream with a freshly-touched state.yml still reads stale); the .discovery.yml --add-root/--remove-root round-trip; and a .git FILE gitlink is recognized as a repo. ADDITIONALLY assert `mp status` prints the other-runs block: spawn the verb from a fixture with a second non-archived bundle in a discovery root and assert its line appears (output-level proof, not node --check).
- files: test/runs-list.test.mjs
- verify: node --test test/runs-list.test.mjs
- codex: heuristic
- spec_refs: spec.md#L377-L388, goals.md#L31-L33

## Wave 7

### Task 26: Land G9: the whole import green and documented. Update docs/verbs.md (refs add|remove|list, amend-plan, runs list, set-discovery, set-render-config verbs), CHANGELOG.md (one release entry covering F1-F5 with decision rationale), and the docs/internals.md index if new internals docs were added. Then run the FULL verification: npm test (all test/*.test.mjs) and mp doctor on this repo — doctor clean in the spec's defined sense (exit 0, zero FATALs; new WARNs version-scoped so legacy bundles pass byte-identically). Cite the concrete output per CD-3. This task depends on every subsystem's terminal task and must be the final wave.
- files: docs/verbs.md, CHANGELOG.md, docs/internals.md
- verify: npm test ; node bin/masterplan.mjs doctor
- codex: heuristic
- spec_refs: spec.md#L396-L401
