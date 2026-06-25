# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Rendered `plan.html` artifact + the `render` verb** (planf3-inspired UX). A new pure, deterministic `renderPlanHtml(index, meta)` in `lib/plan-merge.mjs` (mirroring `renderPlanMd`) emits a self-contained HTML view of the plan — inline CSS, status badges, and a wave-banded inline `<svg>` (explicitly **not** a dependency graph: the merged index carries no deps). It is **additive** — `plan.md` stays the canonical projection. Every interpolated field is neutralized (no executable/remote markup) — string fields HTML-escaped, numeric `id`/`wave` `Number()`-coerced; output is byte-identical for identical input (no clock/randomness). Two fs-only entry points: `mp load-plan` **best-effort auto-emits** a static `plan.html` (swallowed on failure, never perturbs the atomic state write), and the new **`render` verb** → `mp render-plan` re-renders it with **live** per-task status from `state.tasks` (**read-only** w.r.t. `state.yml`). `bundleArtifacts()` gains `planHtml`. AI-image diagrams (planf3 uses `gpt-image-2`) were considered and dropped to stay deterministic, dependency-free, headless-safe, and in-policy (no gateway-bypassing network/secret call). Verb wired across all sync surfaces (`commands/masterplan.md`, README, `docs/verbs.md`, `SKILL.md`, `RESERVED_VERBS`). New tests in `test/plan-merge.test.mjs` (escaping/injection, determinism, badge whitelist) and `test/bin-masterplan.test.mjs` (auto-emit, write-failure-swallowed, read-only render + byte-unchanged state). Plan hardened by a cross-vendor adversarial review (gpt-5.5).

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
