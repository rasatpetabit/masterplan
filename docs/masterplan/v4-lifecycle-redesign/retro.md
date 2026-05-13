# Retro — v4-lifecycle-redesign

**Started:** 2026-05-13T01:58:40Z  **Completed:** 2026-05-13
**Branch:** main  **Completion SHA:** 5629df3
**Wave count:** 7  **Failure modes addressed:** FM-A, FM-B, FM-C, FM-D, FM-G

---

## Goal recap

V4.0 set out to close lifecycle gaps that a cross-repo audit of `petabit-os-mgmt` and `optoe-ng` found in 11 of 47 complete bundles (~24%): hollow completions with no `retro.md`, imported bundles with stub `state.yml` and empty `artifacts.*`, duplicate bundles created for overlapping scopes, doctor checks that missed invariants because briefs described outcomes not algorithms, and worktrees that outlived their bundles with no automated cleanup.

The redesign's central premise — move enforcement from detection at doctor time to write-time prevention — drove all five fixes: a parent-owned `transition_guard` write barrier, an atomic import transaction via temp-dir staging, a Jaccard-based scope-overlap fingerprint gate at Step B0, a `contract_id` + return-shape registry for lifecycle subagent briefs, and a 4-state `worktree_disposition` field with non-interactive auto-remove at Step C completion. Schema_v3 adds all new fields additively; v2 bundles lazy-migrate on first write.

---

## What worked

- **Parallel codex review during brainstorming.** Phase 2 codex review ran as a background subagent while brainstorm batches 1–3 were answered (events 3 and 5). The review delivered concrete line citations into `commands/masterplan.md` — notably the `transition_guard` pattern and the `contract_id` return-shape — that materially strengthened the spec before plan-write.

- **Brainstorm batch decomposition.** Three `AskUserQuestion` rounds (events 4, 6, 7) resolved 12 distinct architectural decisions in focused batches rather than one mega-gate, allowing incremental spec construction without losing context.

- **Advisor consultation before plan-write caught two blocking issues.** Event 10 (`advisor_consulted`) surfaced `wave_count_inconsistency` (spec text said "7 waves" but numbering implied 8) and `worktree_gate_unauthorized` (FM-G draft had an interactive completion gate that violated the loose-autonomy contract). Both were resolved in event 11 (`spec_correction_batch_answered`) before the planning subagent was dispatched — catching them in spec corrections rather than mid-plan rewrites.

- **Contract-id verification per wave.** Every wave subagent returned a `contract_id` with `violations: []` and a `coverage.expected == coverage.processed` match (events 21–35). Zero contract violations across 7 waves means parent verification never had to fall back to local re-check.

- **Brief-style lint (`--brief-style` flag).** Wave 5 acceptance (event 31) confirmed `bin/masterplan-self-host-audit.sh --brief-style` exits 0 with all four contracts registered. A lint tool that gates before commit is more durable than the doctor-time pattern it replaces.

- **Transition_guard as cross-cutting cornerstone.** Codex review's identification of the "write-time vs. doctor-time" tension as the shared root across all failure modes (codex-review.md FM-A structural change, step 1) gave the spec a single organizing principle that simplified wave decomposition. Every FM fix is a specialization of the same guard shape.

- **4-state worktree FSM without a completion gate.** The FM-G design avoided an interactive `AskUserQuestion` at completion by introducing pre-flagging (`--keep-worktree` / `worktree.default_disposition`) and non-interactive auto-remove. Wave 6 acceptance (event 33) confirmed "no AUQ in auto-remove block" — the loose-autonomy contract held.

- **Lazy schema migration.** Schema_v3 bumps `schema_version` only on first write; read-only access to v2 bundles applies defaults in-memory. This let Wave 1 wire the new fields without requiring a migration pass over existing repos.

- **7-wave decomposition with explicit parallelism.** Waves 2 and 3 ran independently (FM-A is completion-side; FM-C is import-side); Waves 4, 5, and 6 also ran independently after Wave 1. Under loose autonomy, auto-progress between successful wave boundaries held end-to-end.

---

## What didn't work / friction

- **Wave count inconsistency in spec required pre-plan advisor call.** Event 10 shows `wave_count_inconsistency` was caught by advisor before the planning subagent ran. The spec had been updated to say "7 waves" in one place but the wave numbering and parallelism diagram implied 8. The cost was one spec-correction round (events 11–12) before planning could start.

- **FM-G completion handling required a brainstorm correction round.** The initial FM-G draft included an interactive completion gate. Event 10 flagged `worktree_gate_unauthorized` as a blocking issue (violates the loose-autonomy contract). Correction was quick (event 11: `auto_remove_unless_pre_flagged_kept_by_user`) but required a second spec write cycle.

- **Post-plan halt-mode handling.** After planning completed (event 18, `halt_gate_post_plan`), a `halt_mode_next: none` gate fired expecting explicit approval before wave execution. This was the specified B2 gate for loose autonomy; it resolved immediately (event 19), but adds a predictable pause between plan-write and Wave 1 dispatch.

- **P4 precondition smoke deferred inside session.** Events 36–38 record that the P4 TaskCreate projection smoke tests were partially run from within the active orchestrator session. Event 38 explicitly notes that `wave_fanout_smoke` had to be deferred because the observational test requires a fresh `/masterplan execute` session. Precondition smoke tests that require an isolated invocation context cannot be fully validated inside the same session that executes the work.

---

## Lessons that should bend future sessions

**Advisor consultation before plan-write is reliably worth the turn cost.** The v2.0.0 audit pass and this V4 work both caught second-order spec issues this way. In V4 specifically, both issues caught (wave-count inconsistency, FM-G gate violation) would have wasted Wave 1 or Wave 6 dispatch: either the planning subagent would have produced a plan with an off-by-one wave numbering that propagated into all wave briefs, or Wave 6 would have landed an interactive AUQ that a downstream user (or the smoke test) would have flagged as a loose-autonomy violation. The cost was one advisor call; the counterfactual cost was 1–2 wasted waves.

**Brainstorm batching before spec-write makes spec corrections cheap.** All 12 architectural decisions in V4 were settled in three AskUserQuestion rounds (events 4, 6, 7) before spec.md was written. When the advisor then found two issues (event 10), correcting the spec was one targeted edit pass (event 12). Compare to a hypothetical where spec was written after batch 1: corrections would have touched three spec sections across three edit passes. Front-loading decisions reduces the surface area for post-write corrections.

**Parallel codex review during brainstorming is the right shape for design phases.** The codex review ran as a background subagent from event 3 (start of brainstorm batch 1) through event 5 (review complete, 4 minutes 30 seconds later). Its findings fed directly into the spec without blocking or extending the brainstorm. The cost of dispatching it early — before the spec existed — was that it reviewed the *current* `commands/masterplan.md` rather than the proposed changes. That's the right input: the review identifies structural patterns in the existing code that the redesign should exploit or invert. Dispatching after spec-write would duplicate analysis the review already does.

**Pre-flagging over interactive gates is the correct UX for non-blocking auto-resolve.** The FM-G design lesson: when a default action (auto-remove worktree at completion) is safe for the majority case but occasionally wrong (user wants the worktree kept), the right shape is a pre-flag that sets intent at kickoff, not an interactive gate that blocks completion. The gate-at-completion shape was rejected not because it's wrong in principle but because it violates the loose-autonomy contract's "halt only at user-question gates" rule. The pre-flag shape is reusable: any future Step C auto-action that the user might occasionally want to override should follow this pattern.

---

## Open follow-ups

- **P4 TaskCreate projection (v4.1.0).** The `next_action` out of V4 completion linked to `docs/superpowers/plans/2026-05-12-masterplan-taskcreate-projection.md`. That work executed and was tagged `v4.1.0` immediately after V4 landed. It has its own retro path.

- **Codex adversarial review of the combined branch returned needs-attention.** The review (run 2026-05-13, separate from the Phase 2 codex review in this bundle) targeted the combined v4.0.0 + v4.1.0 branch diff and returned two findings: reminder-suppression premise and same-session drift recovery. Both are P4-scoped (TaskCreate projection behavior), not V4-scoped. They triage into the P4 retro/release flow.

- **`/masterplan doctor --upgrade-schema` deferred.** Optional eager schema migration verb was listed as a v4.1 follow-up in spec.md open item #4. Not a V4 deliverable.

- **Parent re-verify sampling for large doctor scans.** Spec.md open item #3 deferred the "sampling vs. full-scan" decision for `doctor.schema_v2` parent re-verification to Wave 5 planning. Wave 5 accepted with sampling-based re-verify (3 random bundles + any with violations) per the event 31 acceptance check. No further follow-up needed; the decision is recorded in `commands/masterplan-contracts.md`.

---

## Verification at completion

All 7 waves have `acceptance_verified` events in `events.jsonl` with no contract violations:

| Wave | Event | `checks_passed` | Key smoke |
|------|-------|-----------------|-----------|
| 1 | event 22 | 8 | transition-guard gate=retro_missing fires on v2 bundle |
| 2 | event 24 | 8 | 6a-guard + pending_retro + CL-archive-gate present; bash -n hook clean |
| 3 | event 26 | 7 | I3.5+I3.6 split; doctor #9 cross-check; I3.4 brief returns content; temp-dir path matches Wave 1 sweep |
| 4 | event 28 | 6 | step 1b/1c at L929-987; threshold constant; stopwords; no python; earlier waves intact |
| 5 | event 31 | 8 | 4 contracts registered; --brief-style exits 0; contract_id in 3 dispatch sites; sampling re-verify in Step D |
| 6 | event 33 | 7 | keep-worktree + config + 6a-refresh + auto-remove; no AUQ in auto-remove block; brief-style clean |
| 7 | event 35 | 12 | transition-guard smoke; brief-style lint clean; both plugin.json files at 4.0.0; bash -n all scripts OK; cross-repo bundle counts 24 + 23 = 47 |

Additional cross-cutting checks confirmed at Wave 7 acceptance: both `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` at `4.0.0` at SHA `5629df3`; `bash -n` clean on `hooks/masterplan-telemetry.sh`, `bin/masterplan-state.sh`, and `bin/masterplan-self-host-audit.sh`; cross-repo bundle count (47 total) confirmed against petabit-os-mgmt (24) and optoe-ng (23) test corpora.
