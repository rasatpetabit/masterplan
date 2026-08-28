# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [9.9.3] — 2026-08-28

### Fixed — seeded bundles with relative path fields can now reach their gates

`resolveGateArtifacts` joins `spec_path` against the bundle directory, so a bundle
seeded with REPO-RELATIVE path fields double-paths them and dies unreadable at the
first gate transition — its spec gate could never run (measured on
`litellm-improvement-eval`). `mp seed` now absolutizes explicit `--spec-path` /
`--plan-path` / `--plan-index-path` flags against cwd, and `rebasePaths` gains an
optional `--base` that prefixes each RELATIVE path field with an operator-supplied
absolute base (the CD-7-compliant repair seam; absolute fields stay with the
from/to relocation semantics). `dispatch-plan --spec-path` is absolutized for the
same reason. Red-first tests at both layers; suite 1648 pass, 0 fail.


## [9.9.2] — 2026-08-28

### Removed — the retired agent-dispatch transport, gone

The fleet retired the agent-dispatch control plane; masterplan still spoke its
language. This release deletes the transport wholesale: `lib/dispatch/broker-client.mjs`,
`adsp-adapter.mjs`, `adsp-coord.mjs` and their tests are gone; `adsp-idempotency`
renames to `fabric-idempotency` with `fabric-idem-v1` handoff keys; the `--broker-bin`
flag, coord open/close wiring, `runBrokerDispatch`, and the `mcp-pool` launch path are
removed from `bin/masterplan.mjs` and `lib/dispatch-wave.mjs`. Contract version is
`fabric-native-v1`. No live surface names the retired system anymore — enforced, not
merely documented (see the scan below).

### Changed — routing resolves from a checked-in policy; waves are native spawn plans

Work-class routing no longer shells out to a fleet CLI. It resolves against
`policy/workflow-map.json`, the repo-local canonical copy of the fleet workflow routing
map (lanes sweep/bulk/code/agentic/reason/longform/frontier/broad/mid/local with
litellm/* model refs; classes bounded-edit/agentic-loop/planned-execution/adversary/
critic/deep-investigation/...) via `lib/dispatch/routing-policy.mjs` — fail-closed on
unreadable policy or unresolvable class. A host override (`MP_ROUTING_POLICY`) is
optional; host drift is a doctor WARN, never a test failure, so fleet edits cannot
break the suite. `mp dispatch-wave` returns a native spawn plan — governed descriptors
for the harness's parallel subagent API — with the wave record persisted `pending`
BEFORE launch (wave-token two-phase marker + `probeWaveToken` recovery), and
`mp record-result` finalizes it to `recorded`. Adversarial review is a two-phase native
seam: phase A emits `run_native_reviews` descriptors and records nothing; phase B
ingests orchestrator-provided records via `--reviews-file`, failing closed (verdict
`error`) when an owed review is absent. The doctor check `adversary-lane-health`
becomes `routing-policy-health`.

### Added — a standing fail-closed scan for retired identifiers

`test/no-agent-dispatch.test.mjs` fails the build on any live-surface reference to the
retired system (agent-dispatch, dispatch_task/dispatch_review/dispatch_fanout MCP
tools, serve-mcp broker, adsp-* modules, dispatch-<class> lanes) with word-boundary
precision; history surfaces (docs/contracts, docs/superpowers, docs/masterplan, legacy
fixtures, CHANGELOG/WORKLOG) stay exempt as record. The suite is green: 1645 pass,
0 fail.


### Added — end-of-planning alignment audit (the anti-drift look-back)

Every planning-phase check was *relative*, and none looked back past the spec:
`mp-plan-reviewer` measures the plan against `spec.md`, the plan gate measures goal
coverage mechanically ("≥1 task cites G*n*"), and `mp-goal-assessor` does not run
until **finish**. So drift accumulated across the repeated adversary review→fix
rounds — each concession small and reasonable-looking — reached execution
unexamined, and surfaced only after all the work was done.

New `agents/mp-alignment-auditor` (§3c of the sequencer) runs at the end of planning,
after the plan gate and before `mp load-plan`, as **two dispatches with a user gate
between them**: it decomposes the run's anchor into stable clauses `A1..An` and stops,
the orchestrator has the user **confirm** them (persisted to `alignment-clauses.json`,
a stop in the §2d autonomy contract), then it judges the plan against the confirmed
list on the agent-dispatch critic lane. The auditor holds no `AskUserQuestion` tool, so
a single dispatch would have judged against a decomposition only it had seen —
producing a digest indistinguishable from a confirmed one.

Confirmation is what makes a verdict arguable, and it is the only thing that catches a
clause the auditor itself missed. `narrowed`/`dropped`/`contradicted` are contraction;
`widened` is creep. Advisory in this cut: it reports, it does not block.

### Added — `topic: |` block form anchors a run to the verbatim request

`goalsHash` already canonicalizes the topic seed, so the seed inherits the goals
freeze — but `parseGoals` terminated `topic:` collection at the first blank line and
`trim()`ed every retained line, silently truncating a multi-paragraph request to its
first paragraph and flattening its structure. `topic: |` now collects verbatim to the
first goal heading, preserving interior blank lines and relative indentation.

Opt-in on an exact `|`, so the bare form keeps byte-identical semantics: verified
across every committed bundle, **no existing `goalsHash` moves** and no in-flight
`goal_check`/`goal_waived` receipt is voided.

### Added — the anchor is immutable across amendments

`validateAmendment` ignored `topicSeed` entirely, so an amendment could restate the
ask — letting the review→fix loop edit the very thing it is judged against. It now
rejects a changed seed, checked in `goals-amend` against the currently-frozen
`goals.md`, and accepts an `anchorSeed` for pinning to an event-backed original.

Enforcement (making §3c fail-closed) is deferred and specified in
`docs/design/planning-alignment-check.md` §6: the gate framework is a closed
`spec|plan` binary rather than a registry, so an `alignment` gate needs it
generalized and hooked at both `enforceGateReview` call sites — `load-plan` and
`set-phase --phase=execute`, which are the two plan→execute paths and are both
already gated today.

## [9.9.1] — 2026-08-08

### Fixed — tombstoned goals could never satisfy plan coverage

`validatePlanIndex` tested `g.tombstone !== true`, but `parseGoals` sets `tombstone`
to an **object** (`{reason, amended_at}`) and `bundle.mjs` rejects any non-object
value. Every real tombstone therefore satisfied `!== true`, so each tombstoned goal
was reported `not covered by any task` — meaning **no bundle whose goals had been
amended with tombstones could load its plan**. Every other consumer (`goals.mjs`,
`finish-step.mjs`, `retro-goals.mjs`) already tested truthiness; `plan-merge.mjs` was
the lone outlier.

The existing coverage test passed only because it hand-wrote `{tombstone: true}`, a
shape the parser never emits. It now builds its fixture through `parseGoals` and
asserts the tombstone is an object, so the two sides cannot diverge again silently.

### Fixed — lineup derivation pointed at a path that no longer exists

`register-pi-agents` derived the subagent lineup from
`agent-dispatch/policy/routing.yaml`; the hand-written source is
`policy/src/routing.yaml`, with `policy/` holding compiler output only. Both tests
had been failing ENOENT. The suite was built to fail loud rather than fall back
silently, so it behaved as designed — the path had simply drifted.

## [9.9.0] — 2026-08-07

### Changed — wave-dispatch architecture deepened (rounds 6–8) + comprehensive documentation refactor

Continuation of the 9.8.0 architecture-deepening program. All code changes are
behavior-preserving (no user-facing API changes).

- **Decomposed the adsp-adapter into focused modules.** `lib/dispatch/adsp-adapter.mjs`
  went from a 1222-line monolith to a 42-line barrel re-exporting from three sibling
  modules: `verify-transport.mjs`, `broker-client.mjs`, and `dispatch-digest.mjs`.
  All importers continue to use the `./adsp-adapter.mjs` path; the public surface
  is unchanged.

- **Decomposed finishStep into named state-machine phases.** `lib/finish-step.mjs`
  `finishStep` went from a 484-line monolith to a 66-line orchestrator calling two
  private helpers: `applyShellAnswers` (Phase A+B) and `evaluateFinishMachine`
  (Phase C). The op contract is unchanged.

- **Comprehensive documentation refactor.** Corrected pervasive drift across all
  documentation after the v8 cutover and 8 refactoring rounds: removed all references
  to the deleted L2 Workflow engine (`workflows/*.js`) and `mp-implementer` agent
  throughout internals docs; updated the layer model (L2 is now the fabric dispatch
  path); fixed doctor module count (17→19); updated agent roster; corrected version
  sync across all manifests; marked 6 design docs as Implemented; fixed stale code
  comments in wave.mjs, verify-transport.mjs, and finish-step.mjs.

### Fixed

- **MAIN is now sourced from `buildWaveLaunchContext`** instead of being recomputed
  via a redundant `git rev-parse` IIFE in `continue.mjs`.

### Added

- **Focused unit tests for `lib/runs.mjs`** — 33 tests covering pure functions.
- **Focused unit tests for `lib/watch-integrity.mjs`** — 29 tests covering utility
  functions, complementing the 23 existing integration tests.

## [9.8.0] — 2026-08-07

### Changed — wave-dispatch architecture deepened (5 rounds)

Five rounds of architecture review and deepening on the wave-dispatch hot spot.
All changes are behavior-preserving (1673/1675 tests pass; 2 pre-existing baseline
frontmatter failures only). No user-facing API changes.

- **Centralized wave review in agent-dispatch.** Deleted the ~300-line parallel review
  engine from `lib/dispatch-wave.mjs`; masterplan now calls `dispatch_review` via the
  agent-dispatch broker client. Per-task review records are projected through
  `lib/task-review.mjs` and persisted as structured events. Review is fail-closed:
  `rework`/`reject`/`error`/degraded-harness block via `blocking_reviews[]`.

- **Decomposed the orchestrator into pipeline stages.** `dispatchWaveViaFabric` went
  from 611 → 73 lines. Seven named stage helpers now compose the pipeline:
  `gateAndValidate`, `resolveWaveContext`, `buildDescriptors`, `acquireAndWatch`,
  `buildNativePlan`, `runBrokerDispatch`, `finalizeRecord`.

- **Concentrated wave launch context.** Plan-index reading, config/env construction,
  `prepareWave` invocation, and MAIN resolution are now a single
  `buildWaveLaunchContext` in `lib/wave.mjs`, consumed by both PREPARE
  (`continue.mjs`) and EXECUTE (`dispatch-wave.mjs`). Routing-input parity is now a
  construction guarantee, not a comment-only contract. The retry-frozen-inputs
  guarantee is preserved.

- **Separated watch-integrity into its own module.** The 448-line watch substrate
  (git porcelain parsing, status snapshots, content hashing, baseline management,
  delta verification, restoration evidence) moved from `lib/wave-commit.mjs` into
  `lib/watch-integrity.mjs`. Both LAUNCH and COMPLETION now import from it, fixing a
  cross-module dependency smell where `dispatch-wave.mjs` imported watch functions
  from the commit module.

- **Consolidated git helpers.** `runGit` and `gitLines` are now concentrated in
  `lib/watch-integrity.mjs`. The `runGit` re-export chain through `wave-commit.mjs`
  is removed; `continue`, `sweep`, and `finish-step` import directly from
  `watch-integrity`.

### Internal module sizes

| Module | Before | After |
|---|---|---|
| `lib/dispatch-wave.mjs` `dispatchWaveViaFabric` | 611 lines | 73 lines |
| `lib/wave-commit.mjs` | 941 lines | 488 lines |
| `lib/watch-integrity.mjs` | — | 480 lines (new) |
| `lib/wave.mjs` | 308 lines | 359 lines |

## [9.7.3] — 2026-08-05

### Fixed
- **Agent frontmatter no longer names the retired `fable` model.** The 2026-08-04 lineup cut
  removed fable/sonnet/haiku from the subagent lineup, but the frontmatter compiler only rewrote
  `model:` when the overlay carried an explicit per-agent pin — deleting the pins left the
  previously-stamped `model: fable` as unmanaged residue in all 7 agents, so every by-name
  dispatch was denied by the PreToolUse guard ("unsupported model fable"). agent-dispatch's
  compiler now stamps the lineup default (`opus`) when no pin exists, and this release carries
  the regenerated frontmatter.

## [9.7.2] — 2026-08-05

### Fixed
- **Watch-list breaches in sibling repos are now classified correctly and reverted.** `git status`
  lists only dirty paths, so a tracked file that was clean at launch carried no snapshot entry —
  and the delta check read that absence as "did not exist", reporting a child's MODIFICATION of a
  clean tracked file as `file created`. Trackedness is now answered from the launch HEAD. Separately,
  step 3 only reverted worktree-relative paths, so a breach in a watched SIBLING repo was detected
  and then left dirty for a human to clean up; new step 3c reverts it on the same evidence that
  found it — tracked modifications via checkout, created files via clean. It never touches a path
  that was already dirty at launch (that content is the user's, CD-2) nor one whose launch state is
  unknown, and never "reverts" a moved HEAD. Those are reported as `unrestored`.
- **JSONC block comments are space-filled rather than spliced out**, so malformed input like
  `{"n":1/*x*/2}` is rejected instead of silently becoming the valid `{"n":12}`.
- **String-aware policy parsing** in the two production JSONC readers.
- **Native spawn descriptors carry their worktree as `cwd`.** `buildWorkItem` names the run's
  existing worktree `repo`, but the native plan read only `cwd`, so every descriptor came out
  `cwd:null` and the worktree path had to be supplied out of band at the harness spawn boundary —
  a child spawned without it runs in the wrong locus.

### Added
- `dispatch_fanout` frozen in the V5 orphan gate, with the stale references scrubbed.

## [9.7.1] — 2026-08-05

### Fixed
- **`evidence` is inside goal identity.** `goalsHash` canonicalized only `{id, text, signal, tombstone}`, and `parseGoals` dropped `evidence` outright, so the line that says what actually PROVES a goal met could not enter the hash. Because that hash keys every `goal_check` receipt, every waiver, and the spec-gate re-arm, an acceptance criterion could be rewritten or weakened while every receipt issued against the old, stricter bar stayed valid — no `goal_amended` event, no re-arm. Found by a cross-vendor adversarial review and reproduced live: amending a goal from "true" to "NOT MET" returned `idempotent` with an unchanged hash.
- Two test assertions had pinned the hole in place (`assert.equal(goals[0].evidence, undefined)`, and a hash-stability case whose input read `evidence: ignored`). Both now assert the opposite, with a note so they are not "restored".

### Breaking
- The frozen goals hash advances for every existing bundle. `goal_check` receipts and waivers issued under the old hash no longer validate — intended, since they certified criteria that could have moved without trace. Re-earn them.
- Doctor fixture `pass-consistent` re-frozen. `warn-hash-mismatch`, `error-tamper-goals-emptied` and `error-archived-no-check` keep their deliberately-stale hashes; they exercise failure paths.

## [9.7.0] — 2026-08-04

### Fixed
- **Native spawn is reachable on Pi.** `selectLaunchPath` treated `codexSuppressed` ("no Claude Code Workflow handle") as "no native spawn API"; Pi sets that flag, so the native branch was unreachable on the only host that can run it. Split via `hostHasNativeSpawnApi`.
- **Wave children no longer commit.** The spawn brief said "Commit locally", contradicting the split-commit transaction and tripping the cross-locus watch. Children now leave work uncommitted; the wave commits.
- **Guard-D heartbeat is not a watch breach.** `.owner.lock` / `.owner.hb.*` added to `MAIN_TRANSACTION_FILES` (excluded, not content-validated; the commit pathspec still refuses to ship one).
- Adversary-reviewer overlay config asserts the absence of a per-agent model pin (models come from the routing.yaml lineup).

## [9.6.0] — 2026-07-17

### Changed
- **L2 surface deleted** — fabric is the only execute-wave path (`dispatch_fabric` / `mp dispatch-wave`).
- Planning fan-out is `dispatch_plan` with concurrent `dispatch_task` (MCP fanout retired).
- `commands/masterplan.md` op table rewritten fabric-only; V5 orphan-grep enforces no live L2 refs.

## [9.5.0] — 2026-07-09 — blocked/waived task statuses + waive-task / amend-tasks verbs

### Added

- **Blocked & waived task statuses (D1/D3).** The task-status enum grows from `pending | in_progress | done` to `pending | in_progress | done | blocked | waived`. A `blocked` task is dispatch-skippable and non-terminal (it gates its wave and blocks finalize); a `waived` task is terminal for dispatch + finalize but operator-reversible. Every "still needs to run" filter (`lib/resume.mjs` dispatch + in-flight recovery, `lib/wave.mjs` wave count) now excludes `done` AND `blocked` AND `waived`. The waived-bypass surface is closed end-to-end: `markTask` throws on `status==='waived'`, so `waived` is reachable ONLY via `waive-task`.
  - **`awaiting_waiver` decide op (D2).** When no dispatchable task remains but blockers are present, `decideNextAction` returns `awaiting_waiver` (with blocker ids + reasons) INSTEAD of `complete` — the blocker check precedes the `complete` return (the load-bearing invariant). A run with unfinished blocked work can never silently finalize.
  - **`mark-task --reason` (D5).** `block_reason` attaches on `blocked` (required), clears on any non-blocked transition; `waive_reason` clears when leaving `waived`. `--status=blocked` under a live `active_run` needs `--force` (blocking an in-flight task implies the run is already reaped; emits a `task_blocked_under_active_run` audit event).

- **`mp waive-task` (D3) — the sole writer of `status:'waived'`.** Explicit operator consent to close a run with remaining blockers: operates ONLY on `blocked` tasks, `--reason` required, sets `waive_reason` (deletes `block_reason`), emits a `task_waived` event. `--id=N` or `--all`; `active_run` needs `--force`. Reversible via `mark-task --status=pending` (clears `waive_reason`). (G3)

- **`mp amend-tasks` (D4) — status-preserving task upsert.** The sibling of `load-plan` (initial-only) and `backfill-waves` (existing-only): appends NEW ids as `pending`, refreshes `{wave,files}` for EXISTING ids while PRESERVING `status`/`block_reason`/`waive_reason`, and (`--prune`) drops ids absent from the index. Pure helper `upsertTasks` in `lib/bundle.mjs`; the bin handler owns the wave-less stuck-guard (mirror of `backfill-waves`) + the `plan.html` re-render. `--prune` drops only BARE `pending`; accumulated state needs `--prune-non-pending` (the `seed-tasks --force` hazard, gated). Duplicate index ids are rejected (mirror of `validatePlanIndex`). (G4)

- **Doctor: blocked/waived integrity checks (G6).** `lib/doctor/state-schema.mjs` now flags an unknown task status (ERROR), a `blocked` task with no `block_reason` (WARN — can't diagnose why the wave is gated), and a `waived` task with no `waive_reason` (WARN — operator-consent rationale missing). `blocked`/`waived` are never counted dispatchable.

- **Render: waived badges + reason tooltips (G6).** `lib/plan-merge.mjs` `renderPlanHtml` gains a distinct `waived` badge (purple; badge + SVG node) so a waived task is visibly distinct from pending/done, and surfaces `block_reason`/`waive_reason` as a badge tooltip (threaded via `meta.taskReason` from `rerenderRefsHtml` and `render-plan`). `in_progress` stays gray by design (in-flight).

- **D7 file-content review path (agent-dispatch, cross-repo).** `packages/core/review.mjs` `defaultGetContent` + a `content`/`filesOnly` acquisition path so a reviewer can review new/untracked artifact bytes (spec.md/plan.md) that have no git diff yet — closing the latent hole where the spec/plan gates passed `files`/`staged` over untracked artifacts and reviewed an empty diff. Pure seam (`getContent` injectable); `diff`/`staged`/`base` calls byte-identical.

### Changed

- **All mp-* agents are gateway-routed wrappers — the last opus frontmatter pins are gone.** `mp-plan-reviewer`, `mp-planner`, `mp-subsystem-planner`, `mp-spec-decomposer`, and `mp-goal-assessor` (previously hand-pinned `model: opus` since v8.0.0, outside the agent-dispatch compiled_frontmatter set) are now `model: fable` thin wrappers that delegate their semantic core to the dispatch-gateway with a REQUIRED fail-closed `model_group`: review/verdict work → `dispatch-critic` (xhigh), planning/decomposition work → `dispatch-planned-execution` (xhigh). Each carries an explicit never-native fail rule: a lane outage surfaces loudly (FAIL / empty-fragment / partial verdicts), never a silent same-vendor fallback. `mp-implementer` lands its previously cache-only hotfix (minimax-m3 prose → the governed `dispatch-agentic-loop` lane with required `model_group`) and drops its opus pin to fable (its edits were already gateway-routed). Stale "(opus)" comments in `workflows/plan.workflow.js` / `execute.workflow.js` updated to match.
- **§3b gate execution feeds bytes, not a diff (D6).** `commands/masterplan.md` §3b `run_gate_review` step 1 now specifies feeding the reviewer the actual artifact bytes via the D7 `content` param (or the diff-param bridge) — NEVER `git add` (the index-pollution hazard the content path replaces).
- **`lib/migrate.mjs:176` comment generalized** to "dispatchable-vs-not (excludes done/blocked/waived)" so the stale `!== 'done'` predicate no longer misleads.

## [9.4.0] — 2026-07-08 — planf3-ideas import (F1-F5) + host-safe adversarial review

### Added

- **Host-safe adversarial review (Layer 3 + 4).** A multi-host fleet can route a subagent's Bash to a divergent/stale peer whose `/srv/dev` differs from the orchestrator's (observed live 2026-07-08, proven by an unfakeable SHA-256 divergence — the reviewer silently reviewed the wrong bytes). Two defenses, both opt-in via provenance the orchestrator threads through the L2 launch:
  - **Layer 3 (host-independent inline diff).** `mp-adversarial-reviewer` prefers a diff the orchestrator captured as TEXT on its live repo and runs NO `git` at all — immune to any reviewer↔orchestrator view divergence. `workflows/execute.workflow.js` `reviewerPrompt` emits the inline path when `task.inlineDiff` is present.
  - **Layer 4 (host-identity guard).** When no inline diff is given, the reviewer must first prove a shared filesystem (`/etc/machine-id` + `git rev-parse HEAD` vs the orchestrator's `orchestratorHost`/`orchestratorHead`) and fail loud as `inconclusive` on any mismatch, never reviewing possibly-stale bytes. The orchestrator probes its own fingerprint in `lib/continue.mjs` (the single dispatch point) and threads it through `lib/dispatch/ops.mjs` `buildWaveDispatchOp` into the L2 launch args; omitted provenance runs the legacy unguarded path (never worse than before).

- **planf3-ideas import: cross-run plan-graph refs, plan amendments, an always-on assumptions ledger, a narrative/visual plan render, and multi-run discovery (F1-F5).** A five-feature import distilled from a review of `disler/planf3`, landed green (full suite passing, doctor exit 0 / zero FATALs) and deterministic-first — every new capability lives in a pure `lib/*.mjs` core behind a fs-only `mp` subcommand, with new WARNs version-scoped so legacy bundles pass doctor byte-identically.
  - **F1 — Plan-graph refs (`mp refs add|remove|list`, new `lib/refs.mjs`).** Bidirectional back/forward references between runs, stored in `state.refs.{back,forward}` as `{slug, label?, repo?}`. Ref identity is the `(repo, slug)` PAIR, never slug alone — two repos can legitimately hold same-slug runs, so upsert/removal/reciprocal-resolution/dedup all key on the pair. `repo` is recorded as a canonical ABSOLUTE path, never MAIN-relative, because MAIN is session-relative (a session opened in a sub-repo derives that sub-repo as its MAIN) so a relative path would resolve wrongly from the other side. `refs add` writes the entry and its reciprocal in one invocation and ACQUIRES the Guard-D owner lock on BOTH bundles (canonical-sorted order, deadlock- and TOCTOU-free) rather than preflighting — holding the locks is what makes the cross-bundle write single-writer. `--target` is a bare-slug-validated traversal guard (rejected before any path is built; stored slugs re-validated on read). Surfaced by-presence in `mp status` and the `plan.html` header (a link only when the target `plan.html` resolves on disk, else inert text — never a 404). `mp seed --predecessor=<slug>` is seed sugar for a back ref + reciprocal.
  - **F2 — Plan amendments (`mp amend-plan`, new `lib/amend.mjs`).** The sanctioned mid-run plan mutation: appends a `### <ISO date> — <summary>` entry under an append-only `## Amendments` section in `plan.md` (created at EOF on first use) plus a `plan_amended` event. Home is `plan.md`, not state — human-visible in the artifact, deterministic writer, and it deliberately preserves gate re-arm semantics: because amendments edit `plan.md`, a later re-run of a plan-gated transition re-arms the plan gate at the amended hash, earning a fresh cross-vendor pass. Render-freshness is inline (an existing `plan.html` is re-rendered after the commit) so the artifact never goes silently stale; mutation durability is never hostage to the render — the write commits first, a render failure only WARNs and exits non-zero.
  - **F3 — Always-on assumptions ledger (convention + `lib/doctor/spec-assumptions.mjs`).** The brainstorm flow now persists an `## Assumptions & Open Decisions` section into every new `spec.md` (one entry per material decision: question / decision / rationale / source). Chosen as a convention, not new state or a subcommand, so the section rides for free on the spec-gate hash and is reviewed by the cross-vendor adversary. Enforced by a new WARN-only, VERSION-SCOPED `spec-assumptions` doctor check: it applies only to bundles at or above the schema version this ships, so legacy bundles are grandfathered and keep passing doctor byte-identically.
  - **F4 — Narrative/visual plan render (`mp set-render-config`, extended `renderPlanHtml`).** `plan.index.json` `meta` gains optional `{purpose, problem, solution}` narrative strings (distilled by `mp-planner` on the serial path and threaded through `merge-plan-fragments --meta` on the parallel path; `validate-plan-index` accepts-and-ignores them for back-compat). `render-plan` grows header refs, narrative sections, the wave SVG, task table, goals block, and an Amendments timeline — staying offline, deterministic, and self-contained. Images are OPTIONAL and seam-respecting: `mp` never touches the network; `mp set-render-config --images=on|off` (or `mp seed --render-images=on`) gates only SHELL-side generation, while embedding is by-presence from `assets/{hero,wave-<n>}.png`. LLM-authored HTML and gateway-bypassing network/secret calls in `mp` were explicitly rejected to keep the render deterministic, dependency-free, and headless-safe. Every user-controlled string is HTML-escaped and asset/ref-link paths are trust-bounded (inside the bundle `assets/` dir and the ref's stored canonical repo root; traversal rejected).
  - **F5 — Multi-run discovery + dangling-run resilience (`mp runs list`, `mp set-discovery`, new `lib/runs.mjs` + `lib/doctor/dangling-run.mjs`).** A shared read-only discovery engine inventories `docs/masterplan/*/state.yml` across MAIN plus every nested and enclosing git repo (depth-capped walk skipping `.worktrees/`/`node_modules/`/`.git/`) plus any persistent `<MAIN>/docs/masterplan/.discovery.yml` roots (written via `mp set-discovery --add-root/--remove-root`, an ARTIFACT-class config, not run state). Both directions of the sub-repo case work zero-config. `last_activity` is DERIVED, never stored, and event-dominant (max of last event ts / owner-heartbeat mtime, falling back to `state.yml` mtime) — bare file mtimes are unreliable because a checkout/copy/sync refreshes them and would mask a genuinely stale run. The scan de-dupes by `(realpath(repo root), slug)` and isolates failures per bundle/root: one malformed `state.yml`, unreadable root, or symlink loop WARNs and skips only that item, while a corrupt `events.jsonl` still INCLUDES the bundle with fallback-derived activity — skipping it would hide exactly the dangling run this feature exists to surface. The same engine feeds an `other runs` block in `mp status`, the `dangling-run` doctor check (repo-aware, shell-quoted resume commands), and the session `mp sweep` report; visibility only, never auto-resume (Guard-D mutual exclusion unchanged). New `test/refs-preservation.test.mjs` asserts the new `refs`/`render` keys round-trip untouched through every existing state writer.

### Changed

- **Doctor grows to 16 check modules** — the F5 `dangling-run` and F3 `spec-assumptions` modules join the auto-discovered `lib/doctor/*.mjs` set; the internals index count is updated to match.

## [9.3.0] — 2026-07-02 — goal tracking, adsp-adapter delegation seam, pi host parity

### Added

- **Goal tracking: distill and verify the plan's original *goals* end-to-end.** masterplan now captures the run's goals (distinct from the spec/plan that implements them) and verifies at finish that they were actually achieved — closing the drift/forgetting gap where a plan could fully complete its tasks yet miss its goals. New pure `lib/goals.mjs` (canonical goals hash, `validateGoalCheckReceipt`, waiver-invalidation tuple), `lib/retro-goals.mjs`, and `lib/doctor/goals.mjs`; new `goals-load`/`goals-amend`/`goals-status`/`record-goal-check` verbs in `bin/masterplan.mjs`; a fail-closed `run_goals_capture` guard at the brainstorm→plan boundary (set-phase on a goals-enabled bundle exits 3 until `goals_frozen` matches the current `goals.md` hash) and a `run_goal_check` finish op + durable `goals_unmet` gate in `lib/finish-step.mjs`; and a new read-only `agents/mp-goal-assessor.md` agent (tools: Read/Grep/Glob/Bash only — read-only enforced structurally via a disposable detached worktree) that returns per-goal `{verdict, evidence, citations}`. The goal-check receipt binds goals-hash + HEAD + base-diff-hash + verify-output-hash + clean-worktree status, structurally blocking goal drift/laundering; waivers invalidate on any later commit or amendment. The spec-gate hash now covers `spec.md` + `goals.md`; `mp status` renders a goals block. Suite 893 → 1227 across `test/goals.test.mjs`, `test/goals-record-check.test.mjs`, `test/finish-step-goals.test.mjs`, `test/retro-goals.test.mjs`, `test/doctor.test.mjs`, and the `bin-masterplan`/`prompt-structure`/`plan-merge`/`bundle`/`continue` suites.

- **`lib/dispatch/adsp-adapter.mjs` wired as the sole L1→fabric delegation seam (adsp-v1, spec §5.5).** Rewritten from a staged/not-wired stub into the formal seam between masterplan's L1 `record-result` transaction and the agent-dispatch fabric: `dispatchTask` builds a fabric work item carrying the bundle's stable `task_id`, the composed handoff-idempotency key, declared file scope, verify commands, the run's existing worktree cwd (never a second worktree), and `contract_version`; translates returned digests back into the exact mp-implementer digest shape so L1's record-result/reconcile stays untouched; and consumes the blackboard result store as the keyed result substrate. New pure `lib/adsp-idempotency.mjs` (canonical JSON, task-spec hash, input fingerprint, the full four-part handoff key, `decideReuse`) — the at-least-once-with-idempotent-recording core; `lib/resume.mjs`, `lib/wave.mjs`, `lib/continue.mjs`, `lib/bundle.mjs` wired to the seam. This WIP was folded into the release per explicit user direction; the combined tree passes the full suite (1227 tests, 0 fail).

- **pi host parity: mp-* agents now resolve AND execute on pi, via `bin/register-pi-agents.mjs` (bare + colon alias).** The seven agent definitions (`agents/mp-*.md`) were registered only for Claude Code (discovered via the plugin's `agents/` dir as the `masterplan:mp-*` colon namespace, fresh-session dev-plugin install per `docs/masterplan/2026-05-29-v8-dogfood/parity-runbook.md`). They were invisible to pi's discovery paths (`~/.pi/agent/agents/`, `.pi/agents/`, `.agents/`), so `subagent({ agent: 'mp-…' })` resolved to nothing and a prior session silently inlined the decomposer role under an unverified "dispatch-gateway degraded" excuse. Three compounding CC-isms made a naive copy insufficient: (1) pi's default `agentScope:"user"` ignores project `.pi/agents/` unless a call passes `agentScope:"both"` (the L1/L2 code does not); (2) the CC-style bare `model:` aliases (`opus`/`fable`) resolve to `amazon-bedrock` on pi (no key), not to the configured `litellm/opus-4.8` / `litellm/fable-5`; (3) `agentOverrides` could not rescue this — it applies to builtins only, not custom agents (verified in `pi-subagents-fork/src/agents/agents.ts`). Fix: new [`bin/register-pi-agents.mjs`](./bin/register-pi-agents.mjs) writes `~/.pi/agent/agents/` from the CC canonical — TWO files per agent: a **bare** copy (`mp-spec-decomposer`, the primary pi name) and a **colon alias** copy (`masterplan:mp-spec-decomposer`) so existing `masterplan:mp-*` references in CC-authored L1/L2 text resolve on pi too. Both swap only the `model:` line per a fixed map (opus→`litellm/opus-4.8`, fable→`litellm/fable-5`; both policy-`allow` under pi-subagent); the colon copy also prefixes `name:`. **`mp-implementer` is deliberately skipped** — its entire contract is routing edits to the local **skynet MCP** (it has no Edit/Write tool by design), pi hosts no skynet MCP server (edits on pi go through `dispatch_task` → bounded-edit → dispatch-gateway → skynet), and its only caller is the CC L2 wave engine (`workflows/execute.workflow.js`, CC-only); a pi copy would be a broken agent. So six of the seven agents register for pi (12 files: 6 bare + 6 colon alias); pi uses `dispatch_task` for the equivalent implementer path. The prompt bodies are copied verbatim — CC's `agents/` stays the single source of truth; `--check` detects any drift, so the surfaces cannot silently diverge. Idempotent, user-scope. Verified end-to-end against `subagent-executor.ts` (unknown names hard-error, no silent fallback): both `mp-spec-decomposer` and `masterplan:mp-spec-decomposer`, and `mp-explorer`/`masterplan:mp-explorer`, execute via a bare `subagent({ agent })` call with no model override. Diagnostic caveat: colon-named agents do NOT appear in `subagent({ action: 'list' })` output (a display gap, not a functional one) — bare `mp-*` are what list shows. Also fixed a pre-existing test failure: the `tools:` frontmatter regex in `test/agents.test.mjs` rejected legitimate MCP-namespaced tool names (`mcp__skynet__skynet_edit_file`, added to mp-implementer in commit 87c4afe); widened to accept word characters (`\w`). This is a **host-local** registration (state lives in `~/.pi/agent/agents/`, outside the repo) made **reproducible** by the shipped script — run it once per pi host.

### Changed

- **New discipline rule: never silently inline a delegated role (CD-11).** A named agent that fails to resolve MUST (1) retry once, (2) probe real state via `subagent({ action: 'list' })` / `dispatch_health_status` / `agent-dispatch digest`, (3) escalate via AUQ or `contact_supervisor` — never silently run the role inline and "record the decision" as cover. "Recording" a bypass is not a fix (global Hindsight rule). Added to [`docs/development.md`](./docs/development.md) and indexed in [`AGENTS.md`](./AGENTS.md). This closes the behavioural escape hatch that allowed the unverified "dispatch-gateway degraded → inline it" bypass in the first place.

## [9.2.0] — 2026-06-25 — rendered plan view, consolidated dispatch, doctor `--fix` for stale worktree pointers

### Added

- **Rendered `plan.html` artifact + the `render` verb** (planf3-inspired UX). A new pure, deterministic `renderPlanHtml(index, meta)` in `lib/plan-merge.mjs` (mirroring `renderPlanMd`) emits a self-contained HTML view of the plan — inline CSS, status badges, and a wave-banded inline `<svg>` (explicitly **not** a dependency graph: the merged index carries no deps). It is **additive** — `plan.md` stays the canonical projection. Every interpolated field is neutralized (no executable/remote markup) — string fields HTML-escaped, numeric `id`/`wave` `Number()`-coerced; output is byte-identical for identical input (no clock/randomness). Two fs-only entry points: `mp load-plan` **best-effort auto-emits** a static `plan.html` (swallowed on failure, never perturbs the atomic state write), and the new **`render` verb** → `mp render-plan` re-renders it with **live** per-task status from `state.tasks` (**read-only** w.r.t. `state.yml`). `bundleArtifacts()` gains `planHtml`. AI-image diagrams (planf3 uses `gpt-image-2`) were considered and dropped to stay deterministic, dependency-free, headless-safe, and in-policy (no gateway-bypassing network/secret call). Verb wired across all sync surfaces (`commands/masterplan.md`, README, `docs/verbs.md`, `SKILL.md`, `RESERVED_VERBS`). New tests in `test/plan-merge.test.mjs` (escaping/injection, determinism, badge whitelist) and `test/bin-masterplan.test.mjs` (auto-emit, write-failure-swallowed, read-only render + byte-unchanged state). Plan hardened by a cross-vendor adversarial review (gpt-5.5).

- **`doctor --fix` now clears stale worktree pointers** (issue #7). The `worktree-integrity` module gains a conservative `fix()` handler: for a bundle whose `worktree` is set, unregistered in git, **and gone from disk**, it records `worktree_disposition=removed_after_merge` — the same durable disposition `mp finish` / the sweep reconciler write — which the check's skip then honors, clearing the bundle→git ERROR (and the branch ERROR) without nulling either field (the path is preserved as a reversible memento). This stops the ever-growing doctor noise floor from bundles merged externally or whose worktree was reclaimed without running `mp finish`. **Design note:** the discriminator is **disk existence, not run status** — `complete` is not a valid bundle status (`VALID_STATUS = ['in-progress', 'archived']`), so gating on status would be vacuous (the only non-archived status is `in-progress`). gone-from-disk is the BLOCKER-respecting line: the protected `manual`/active-unregistered case requires the worktree dir to exist (so its `.git` can be inspected), so a vanished path can never be that live reference; an on-disk-but-unregistered worktree is left for the operator, and archived/already-retired bundles are skipped — making the fix set a strict subset of the ERROR set. Idempotent. New tests in `test/doctor.test.mjs` (retire+idempotent, on-disk-stray-untouched, archived-skipped). Cross-vendor adversarial pass pending (skynet gateway down at author time); reviewed same-vendor (advisor) as the sanctioned fallback.

### Changed
- **`codex.review` now defaults to on at seed time** (the hindsight-historian fix). Fresh bundles get `state.codex.review: true` automatically via `mp seed`; pass `--codex-review=off` to opt out. Legacy bundles missing `state.codex` are defensively armed at the finish gate (one-time `codex_review_defensively_armed` audit event). Every review-skip path now emits a typed `codex_review_skipped` event with a reason (`state.codex.review not armed`, `codex_host_suppressed`, `no_base_branch`, `companion_unresolved`, `companion_timeout`); the `branch_finish` AUQ carries a `notice` field surfacing the skip reason so the user sees WHY review didn't run. Base detection expanded from local-only to local → `origin/main|master` → any remote main/master → empty-tree SHA (`4b825dc6…`) as universal-diff last resort. (`buildSeedState` adds `codexReview` opt; `bin masterplan.mjs seed` adds `--codex-review=on|off`; `lib/finish.mjs` adds `detectBaseAuto` + `EMPTY_TREE_SHA`; `lib/finish-step.mjs` gate restructured into 7a/7b/7c/7d. Suite 951/952; the 1 pre-existing `agents/mp-implementer.md` tools-regex failure is unrelated.)

- **Agent-dispatch decision logic consolidated into `lib/dispatch/`** — preparation for a unified cross-tool agent-dispatch system. `lib/routing.mjs` → `lib/dispatch/routing.mjs` and `lib/codex-host.mjs` → `lib/dispatch/host.mjs` (git-mv, contents unchanged); the qctl eligibility gate + backend resolution lifted out of `lib/wave.mjs` into `lib/dispatch/backend.mjs` (`resolveBackend` is now the public `resolveTaskBackend`); the dispatch-vehicle fork (Residual-3B `dispatch_foreground` vs `launch_workflow`) lifted out of `lib/continue.mjs` into `lib/dispatch/ops.mjs` (`buildWaveDispatchOp`, `normalizeReviewMode`). One import surface: `lib/dispatch/index.mjs`. Boundary rule documented in the index header: decision logic in (pure — no fs/clock/subprocess/git), state machine out (`lib/wave.mjs`, `lib/continue.mjs`, the L2 engine stay consumers). Behavior byte-identical; new `test/dispatch.test.mjs` pins the facade surface and the op-shape wire contract. Suite 893 → 903.

## [9.1.1] — 2026-06-10 — doctor checks stop fighting the writer

### Fixed

- **`scalar-cap` no longer warns on the writer's own output.** The 200-char cap is a prose-scalar discipline; values that parse to structured data — the inline-JSON `tasks` line `lib/bundle.mjs` itself emits — are now exempt from the WARN, matching the `--fix` handler's existing refusal to move them (an overflow pointer in `tasks` would corrupt resume, which is exactly what the old WARN's fix text told operators to do by hand).
- **`legacy-bundle` honors its documented README exemption.** The check's contract says a `docs/superpowers/` holding only README pointer files must not warn, but `hasLegacyArtifacts` flagged any `.md` including READMEs. Code now matches the contract.

### Removed

- Dev-repo cruft prune (the `clean` verb's designed path; all bundles archived, history in git): 8 legacy schema<6 run bundles, the empty `docs/superpowers/` container, and the fully-discharged `docs/design-residuals.md` decision memo. Dev-repo doctor: 15 WARN → 0.

## [9.1.0] — 2026-06-10 — finish-time docs normalization + doctor autofix

### Added

- **`doctor --fix` autofix pass.** Check modules may export an optional `fix(repoRoot, findings, opts) -> Repair[]` handler; the dispatcher calls handlers only under an explicit `--fix`, crash-isolates throwing fixes, and reports `FIXED`/`ERROR` repairs. First autofix shipped: `scalar-cap` moves overlong flat `state.yml` scalars to a bundle-local overflow file and replaces them with the `*overflow at <file> L<n>*` pointer.
- **Finish-time docs-normalization offer (`docs_normalize` gate).** `mp finish-step` step 4.5: after the dirty-commit, before verification, the machine diffs the run branch for `*.md` it created/modified (three-dot vs base, run bundle excluded) and — when candidates exist — opens a durable, compaction-safe gate offering to fold them into the repo's category-organized docs and strip plan provenance (slugs, wave/task numbers, "implemented by plan X" phrasing). Two-phase like `push_pr`: nothing durable changes until `--docs-normalized`/`--docs-skipped` arrives, so a crash mid-edit re-renders the offer. Once per run via presence-keyed `docs_normalize`/`docs_normalize_skipped` events; zero candidates → fully silent; `state.docs.normalize: off` or `--docs-suppressed` suppresses. The normalization commit moves HEAD *before* `verified_sha` is recorded, so verification and the codex review cover the final tree.
- **`plan-doc-cruft` doctor check** (module #14) — the repo-wide backstop: anchored to archived bundles, warns on markdown outside the runs dir still carrying plan provenance (slug-named files, `docs/masterplan/<slug>` references, hyphenated slugs in headings). Always WARN, never ERROR; SKIP with no archived bundles.

### Fixed

- `commands/masterplan.md` no longer names the absorbed `dispatch_wave` op in the §2d forbidden-asks prose (the prompt-structure guard bans resurrected references).

## [9.0.0] — 2026-06-10 — prose → code: the LLM stops being the transaction engine

Delivers the full Thrust-2 architecture program (`~/.claude/plans/bubbly-doodling-sparkle.md`, increments 1–5): every multi-step git/state transaction the v8 prompt executed as prose now runs as tested deterministic code behind `mp` subcommands. CD-7 strengthens — `mp` is the sole writer of durable state **and** the sole executor of the *local* git bracketing it; network ops (`git push`, `gh`, codex-companion) stay shell-side as typed `shell` ops. The sequencer shrinks 818 → 509 lines; each increment deleted exactly the prose its code replaced. Suite 864/864, doctor exit 0; seven consecutive cross-vendor Codex review rounds (r1–r7), final verdict PASS with zero findings.

### Added

- **`mp record-result`** (`lib/wave-commit.mjs`) — the wave-completion transaction as code: owner-heartbeat re-check → per-digest mark-task → `after` capture → verify-scope → out-of-scope revert → split commit (code in WT, state in MAIN). Absorbs §2a completion + the `finalize_run` crash-reconcile prose.
- **`mp continue`** (`lib/continue.mjs`) — the trampoline: Guard D acquire/heartbeat, migrate-on-load, sweep, worktree create-or-reuse, dispatch prep, and the decide loop, returning one typed op per call (`launch_workflow | dispatch_agent | dispatch_foreground | run_skill | record_result | ask | probe | shell | stop`). The prompt's §2 dispatch prose is now a ~60-line loop contract + op table.
- **`mp finish-step`** (`lib/finish-step.mjs`) — the finish state machine: re-entry shortcuts, snapshot, dirty-commit, verified-at-SHA check (verification itself stays an LLM `run_verify` op), retro write-if-absent, durable gate open, disposition (local merge + worktree removal in code; push/PR as `shell` op), archive-LAST, release-owner. Crash-replay safe at every boundary, including full-teardown merge replay (Codex r6).
- **`mp sweep`** (`lib/sweep.mjs`) — worktree reconciliation, **dry-run by default**; destructive actions only under `--apply`. Sweep never deletes branches (Codex r7-verified); the sole automated branch deletion is finish-step's post-merge `branch -d`.
- **Codex full-lifecycle hosting (Residual 3B, delivered).** Under host suppression `mp continue` returns `dispatch_foreground` ops (tasks run sequentially in-session) and forces serial planning; `docs/attic/v7-codex-hedge/` deleted — cutover-manifest Tier-4 #13 fully discharged.

### Changed

- §6.5 qctl prose → `docs/design/qctl-multi-repo-apply.md` (SPEC-ONLY banner); publish/follow mega-rows → `docs/coordination-playbook.md` (IMPLEMENTED-UNVERIFIED banner). Verbs unchanged; `lib/github-coord.mjs` + tests untouched.

### Notes

- Empirical gates still open (tracked in WORKLOG): toy-task dogfood of the `mp continue` loop, one full dogfooded finish, and a Codex-hosted parity run. The op-shape and transaction logic are unit-proven (864 tests); the hosted end-to-end claims stay "unverified" until dogfooded.

## [8.2.0] — 2026-06-10 — v7 cruft cutover & CI realignment

Executes the long-deferred removal manifest (`docs/masterplan/2026-05-29-v8-dogfood/cutover-removal-manifest.md`): the dormant v7 surface is deleted (~2.2 MB tracked, ~17.5k lines) and `main`'s CI now runs the real test suite. Every deleted byte is recoverable at tag `v8.1.0-pre-cruft-removal`. Suite 806/806, doctor exit 0.

### Changed

- **CI rewritten.** `ci.yml` now runs `node --test test/*.test.mjs` + `node bin/doctor.mjs` + a plugin-symlink assert, replacing the v7 `bin/masterplan-release-gate.sh` battery. `ng-ci.yml` deleted — it was bound to the `masterplan-ng` branch (removed 2026-06-06), so the real suite had **no** CI on `main` until this release. The `release-publish` job is unchanged; the 8.x CHANGELOG headers are normalized to the bracketed `## [x.y.z]` form its notes-extraction awk expects.
- **Codex hedge attic'd, not deleted** (manifest Tier-4 #13): `parts/codex-host.md` + `parts/contracts/taskcreate-projection.md` → `docs/attic/v7-codex-hedge/`, and the previously-missing **Workflow row** is added to `skills/masterplan/SKILL.md`'s Codex tool-adaptation table (host-suppressed mode stays bounded-interactive; full-lifecycle Codex is design-residuals Residual 3B, still unimplemented). The attic is deleted when 3B ships.
- **Contracts registry relocated** `commands/masterplan-contracts.md` → `docs/contracts/masterplan-contracts.md` (resolves deferred-followup DF-1 — it auto-registered as an accidental `/masterplan-contracts` slash command); its v7-era contracts are marked Historical. DF-3 is moot (subject deleted).
- **Docs realigned to shipped reality:** sequencer line-count claims fixed (~800, not "~251") in CLAUDE.md / README / SKILL.md / internals; doctor module count 11 → **13** with `coord-drift` + `owner-sentinel` rows added to `docs/internals/doctor.md`; CLAUDE.md's verb-sync list now names `parseReservedVerbs()` (the `RESERVED_VERBS` constant never existed) and drops a phantom internals routing table; `publish`/`follow` added to SKILL.md's verb lists; CD-1…CD-9 → CD-1…CD-10; README's `stats` row corrected (it reads the bundle's `events.jsonl` — the deleted telemetry hook never fed it in v8).
- `bin/masterplan.mjs` now imports `VALID_DISPOSITIONS` from `lib/worktree.mjs` instead of carrying a duplicate enum, and the four implemented-but-undocumented qctl helper subcommands (`enqueue-key`, `artifact-verify`, `status-map`, `base-drift`) are named in §6.5's shell-vs-bin ownership table.

### Removed

- All 16 `bin/masterplan-*.sh` v7 scripts (incl. `masterplan-release-gate.sh`, superseded by the node suite + `test/publish-hygiene.test.mjs`), `bin/run-tests{,-fast}.sh`, `hooks/masterplan-telemetry.sh` (+ its install docs in README/install.md), the `lib/*.py` audit tooling, the entire `parts/` prose orchestrator, and the legacy `tests/` tree (302 files). Makefile trimmed to `help` + `test` → `npm test`.
- Orphaned/zero-reference archival docs (~160 KB): `docs/config-schema.md`, `docs/internals/{failure-instrumentation,brainstorm-anchor}.md`, `docs/audit-2026-05-05-subagent-execution.md`, the archived qctl plan+spec pair, `docs/design/{telemetry-signals,intra-plan-parallelism}.md`, `docs/github-coordination-qwen-fabric-fit.md`, `docs/release-submission.md`, empty `docs/failure-analysis/`.

## [8.1.0] — 2026-06-06 — worktree lifecycle & cross-session concurrency hardening

Closes the worktree-lifecycle and concurrency gaps the v8 clean-core rebuild left behind (it kept the worktree *scaffolding* but dropped the *lifecycle*). All deterministic logic is new pure `lib/*.mjs` behind fs-only `mp` subcommands; git stays in the shell (CD-7). Suite 791/791, doctor exit 0.

### Added

- **Worktree lifecycle as code.** New pure `lib/worktree.mjs` + `lib/worktree-fs.mjs` — deterministic naming, a create/reuse planner, and a single `classifyWorktrees` reconciler distinguishing active / repo-move / crash-leak / foreign-leftover / legacy-`missing`, each carrying a per-mode action (`repair` / `prune` / `remove` / `normalize` / `none`). Shared by the new fs-only `mp worktree plan|record|reconcile` subcommands **and** the doctor check (one classification source). Orphans are reaped by a global reconcile that the next masterplan kickoff/resume runs across all bundles (a dead session can't tear itself down).
- **Doctor git→bundle direction.** `lib/doctor/worktree-integrity.mjs` now closes its long-standing blind spot by calling the same `classifyWorktrees`, emitting per-mode WARN+fix findings.
- **Dispatch-time disjointness recheck.** New pure `checkWaveDisjoint` in `lib/wave.mjs`, composed into `prepareWave`: fails when a task's plan-side and state-side file sets diverge, runs disjointness on the *resolved* payload, and unifies `verifyScope` on that same set so dispatch and the post-barrier F-SCOPE check can't disagree.
- **Guard D — NFS-safe cross-session owner sentinel.** New `lib/owner.mjs` + `lib/owner-fs.mjs` + `lib/doctor/owner-sentinel.mjs` + `mp acquire-owner|heartbeat-owner|release-owner [--force]`. Identity is the LLM **session** (`{host, CLAUDE_CODE_SESSION_ID}`), not the ephemeral `mp` process; liveness is heartbeat-age TTL (30m default). Immutable `.owner.lock` via atomic `link()`+`stat().nlink===2` plus a per-owner heartbeat file. Guarantee: perfect mutual exclusion for live contention (unit of protection = the turn); one documented benign residual (a >TTL-abandoned owner resurrecting at the instant of reclaim). A release-path freshness gate (added after cross-vendor Codex review) only path-unlinks a lock proven within-TTL, returning `stale-not-released` otherwise so a mid-takeover successor is never clobbered.

### Changed

- `missing` worktree disposition is normalized to `removed_after_merge` on the **read path** for all schemas (the enum stays 3-value); failed teardown stays `active`, never the phantom `missing`.

## [8.0.0] — 2026-05-31 — clean-core rebuild

The full clean-core rebuild lands on `main`. masterplan is now a **five-layer Node-primary architecture** — durable run bundle (`docs/masterplan/<slug>/state.yml`, the CD-7 single source of truth) · thin resumable shell (`commands/masterplan.md` sequencer + `bin/masterplan.mjs` + `lib/*.mjs` as the sole durable state writer) · Workflow-tool execution engine · plugin-root agents · `doctor` health checks — replacing the v7 markdown monolith with an ~80% line reduction and unit-tested deterministic logic. The per-verb `/masterplan:<verb>` skill namespace is removed; every verb now routes through the bare `/masterplan` command via `bin`.

### Added

- **PR-awareness in the report verbs + finish gate.** `status` / `next` / `clean` surface an open GitHub PR for the run's branch (report-only, never auto-merge; `gh` is best-effort and degrades silently when absent), and the `branch_finish` gate relabels when a PR already exists. New pure helper `summarizePr` (`lib/finish.mjs`) + `mp pr-summary` subcommand.
- **Explicit autonomy contract** (`commands/masterplan.md` §2d). Under loose/full autonomy the orchestrator auto-progresses through successful steps and stops only at genuine gates, emitting an `<mp-autoprogress>` marker so the end-of-turn guard stands down instead of forcing ceremonial confirmations between waves.

### Notes

- This is an **additive** release. The v7 markdown / self-instrumentation surface (`parts/`, the legacy `tests/` battery, `hooks/masterplan-telemetry.sh`) is retained dormant and will be removed in a follow-up once the remaining Codex full-lifecycle execution path lands and the affected docs are rewritten.

---

## Historical — pre-v8 (v1.0.0 … v7.2.3, 2026-05-03 → 2026-05-27)

The detailed entries for the ~40 pre-v8 releases were deep-compacted on 2026-06-10. The full original text is preserved in this file's git history (`git log -p -- CHANGELOG.md`) and at tag `v8.1.0-pre-cruft-removal`.

- **v7.x (2026-05-26 → 27)** — package rename `superpowers-masterplan` → `masterplan` (marketplace `rasatpetabit/masterplan`) with doctor/install fixes (7.0.x); 12 per-verb `/masterplan:<verb>` skill stubs (7.1.x — removed again in v8 after `plan`/`status`/`doctor` shadowed Claude Code built-ins); ops-audit hardening pass (7.2.0); Check #53 telemetry wiring (7.2.1); `/plan` hijack fix via deleting `skills/plan/` (7.2.2); Codex review-dispatch guard + commit-level plugin-registry drift detection (7.2.3).
- **v6.x (2026-05-22 → 26)** — token-efficiency overhaul: the 110 KB step-c prompt split into 4 lazy-loaded sub-files, 5 coordinator prompts, deep prose pruning, sandbox-worktree compatibility, AUQ breadcrumbs (6.0.x); adversarial review at the B2/B3 spec/plan gates + `aggressive-loose` autonomy (6.1.0); hoisted run-policy gate, API-retry + Codex-failure policies, doctor tier-classification fixes (6.2.x); registry-drift Check #50, stale-task Check #49, telemetry fixes, regression-detection improvements (6.3.x); CC-3 visibility — trace markers + Checks #51/#52 (6.4.0).
- **v5.x (2026-05-13 → 20)** — lazy-loaded phase prompts; failure-mode instrumentation; the 3-layer regression suite; Guards B/C; Codex routing default flipped to aggressive; path-portability sweep (no hardcoded plugin paths).
- **v4.x (2026-05-12 → 13)** — lifecycle hardening against failure modes FM-A/B/C/D/G; TaskCreate projection contract; loose-autonomy plan-gate auto-approve.
- **v3.x (2026-05-08 → 12)** — durable run bundles (`docs/masterplan/<slug>/`) + migration from legacy `docs/superpowers/` layouts; Codex host compatibility (`/masterplan:masterplan`, host-suppression); anchored brainstorming; native goal pursuit.
- **v1.0.0 – v2.x (2026-05-03 → 08)** — first stable release after a 3-agent pre-release audit; CC rules + CD-9 gate discipline; intra-plan parallelism Slice α with Codex defaults on; `new`→`full` verb rename; two-tier no-args picker; plugin shim; doctor growth from 14 to 18 checks; `CLAUDE.md` + `docs/internals.md` contributor orientation.
