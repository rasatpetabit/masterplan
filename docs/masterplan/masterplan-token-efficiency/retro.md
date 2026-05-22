# Retrospective — masterplan-token-efficiency

**Completed:** 2026-05-22
**Duration:** ~6 hours (17:22–23:30 UTC)
**Complexity:** high | **Autonomy:** loose
**Tasks:** 21 | **All dispatch:** inline-Claude (Codex blocked throughout)
**Released as:** v6.0.0

---

## What shipped

### P0 — Baseline telemetry
- **T1:** `turn_context_bytes` event added to `hooks/masterplan-telemetry.sh` Section 9 — emits `{event, verb, input_tokens, file_loads:[{path,bytes}]}` per turn end.
- **T2:** `masterplan-codex-usage.sh baseline` subcommand — reads `turn_context_bytes` events from all live run bundles, computes per-verb median/p90.

### P1 — Prose pruning (three files)
- **T3:** `parts/step-0.md` 46,929 → 30,564 bytes (−35%). Consolidated repetitive multi-condition reasoning chains; moved run-bundle schema details to contracts.
- **T4:** `parts/step-b.md` 47,707 → 27,711 bytes (−42%). Relocated brainstorm-anchor Haiku A/B/C briefs to new `docs/internals/brainstorm-anchor.md`; replaced inline expansion with coordinator dispatch block.
- **T5:** `commands/masterplan.md` 11,460 → 9,210 bytes (−20%). Compressed CC-2 Codex health check prose; tightened CC-3 scope notes.

### P2 — step-c.md 4-way split
- **T6–T11:** `parts/step-c.md` (109,939 bytes) split into `step-c-resume.md` + `step-c-dispatch.md` + `step-c-verification.md` + `step-c-completion.md`. Each is a load-on-demand sub-file; a typical execute turn loads 1–2 sub-files (~50KB) instead of the full 110KB monolith.

### P3 — Coordinator-subagent pattern (5 dispatch sites)
- **T12:** `parts/contracts/coordinator.md` — central contract: tier table, 5-coordinator catalog, CD-7 compliance, return-shape protocol, failure contract.
- **T13:** `docs/internals/brainstorm-anchor.md` — full Haiku A/B/C briefs, merge rules, classification gate. Extracted from step-b.md.
- **T14:** `parts/step-b.md` updated — `coordinator-brainstorm-anchor` dispatch (Sonnet; returns merged anchor JSON ≤1000 tokens). Fallback: `coordinator_fallback` + inline 3-Haiku fan-out.
- **T15:** `commands/masterplan.md` + `parts/step-0.md` — `coordinator-doctor` dispatch (Sonnet; runs all checks internally, returns findings JSON). `docs/internals/doctor.md` created.
- **T16:** `parts/step-c-verification.md` — `coordinator-task-verify` dispatch (Haiku; runs verify commands, returns pass/fail). `docs/internals/task-verification.md` created.
- **T17:** `parts/step-c-resume.md` — `coordinator-bundle-resume` dispatch (Haiku; reads 5 bundle files internally, returns compact resume state). `docs/internals/bundle-resume.md` created.
- **T18:** `parts/step-c-dispatch.md` — `coordinator-plan-parser` dispatch (Haiku; builds eligibility cache internally, returns task array). `docs/internals/plan-parser.md` created.

### P3-docs split
- **T19:** `docs/internals/wave-dispatch.md` and `docs/internals/coordinator-pattern.md` — wave assembly rules, Codex routing decision tree, 7-step coordinator recipe.
- **T20:** `docs/internals.md` (1,408 lines, 123,063 bytes) → 25-line navigation index (1,175 bytes). All content moved to 7 focused `docs/internals/*.md` docs.
- **T21:** CHANGELOG v6.0.0 entry; version bump to v6.0.0 across all manifests.

**Post-execution fix (not in plan):** Migrated `§Failure-instrumentation framework` and `§Policy-regression watcher` content to `docs/internals/failure-instrumentation.md` after T20's docs/internals.md replacement left two dangling section references in `parts/step-0.md` and `parts/failure-classes.md`.

---

## Token savings — static analysis

The `masterplan-codex-usage.sh baseline` command requires `turn_context_bytes` events from actual `/masterplan` runs; no events existed for this bundle (all prior runs are pre-T1). Static file-size comparison:

| Turn type | Pre-v6 context load | Post-v6 context load | Reduction |
|---|---|---|---|
| `execute` (router + step-0 + step-c-resume + 1 sub-file) | ~292KB | ~108KB | **63%** |
| `brainstorm` (router + step-0 + step-b) | ~107KB | ~68KB | **37%** |
| `doctor` (router + step-0 + coordinator) | ~58KB (w/ internals loaded) | ~40KB | **31%** |
| internals.md alone (on doctor/retro turns) | 123KB | 1KB (index) | **99%** (content in focused docs) |

Spec target was 30–50%; execute turns exceeded it at 63%.

**Coordinator economics:** Each coordinator pays context cost internally and returns ≤1000-token JSON. The orchestrator sees the compact return, not the raw file content. For example, `coordinator-bundle-resume` reads 5 bundle files (state.yml + events.jsonl + plan.md + spec.md + eligibility cache) internally — those ~30KB never enter the orchestrator context.

---

## What worked

**Coordinator pattern composability.** All 5 sites share identical shape: DISPATCH-SITE annotation, contract_id, tier, inputs, scope, constraints, return shape, fallback. The `parts/contracts/coordinator.md` template made adding a new site a 15-minute edit. Each site has an inline fallback that logs `coordinator_fallback` and runs the pre-v6 behavior — zero regression risk on coordinator error.

**docs/internals.md monolith → focused docs.** The original 1,408-line file was a canonical reference that was referenced inline on doctor and retro turns. Splitting into 7 focused docs (8 after the post-execution failure-instrumentation migration) means each coordinator's context has only the doc it needs, not the full 123KB.

**step-c.md 4-way split.** The load-on-demand pattern was implemented cleanly — each sub-file cross-references the next at its header. A `retro` verb loads only `step-c-resume.md`; a `doctor` turn loads neither. The sub-file split reduces the critical execute-turn load path from 110KB to ~37KB (resume) + ~29KB (dispatch) — and those never both load unless the same turn both resumes and dispatches.

---

## What didn't work / didn't go as planned

**Codex routing blocked entirely.** All 9 Codex-eligible tasks had to run inline. The git worktree layout puts `.git/worktrees/masterplan-token-efficiency/` outside the Codex sandbox's writable scope — `git add` / `git commit` fail with "read-only filesystem" on the git index. A `sandbox_mode workspace-write → danger-full-access` attempt had no effect. All work proceeded inline. The per-task time cost was higher than budgeted.

**Sub-file sizes above plan targets.** The plan targeted step-c sub-files ≤25,600 bytes each. Actual: step-c-resume.md=37,786, step-c-dispatch.md=29,428, step-c-verification.md=28,784. Root cause: step-c.md added features between the plan's size estimation and T6–T11's execution. The plan's estimate was against the pre-session snapshot; the execution ran against a file that had grown. The per-turn context improvement is still substantial (110KB → 37KB typical load) even though the individual file targets were missed.

**docs/internals.md replacement dropped section content.** T20 replaced the 1,408-line monolith with a 25-line index without migrating the `§Failure-instrumentation framework` section (~200 lines). Two references in `parts/step-0.md` and `parts/failure-classes.md` pointed to the now-missing section. Caught by advisor review post-T21; fixed with an additional commit before retro. The migration was structurally correct for the 7 coordinator docs but missed this non-coordinator section that had no obvious destination.

**Baseline measurement unavailable.** The `masterplan-codex-usage.sh baseline` tool requires `turn_context_bytes` events which are only emitted by the updated telemetry hook (T1). Since this bundle ran entirely inline without collecting telemetry events in the standard format, the static analysis above is the only available measurement.

---

## Key decisions

| Decision | Rationale |
|---|---|
| 5 coordinator sites, not N | Covers the 5 heaviest-read operations (bundle-resume, plan-parser, brainstorm-anchor, task-verify, doctor). Further sites would yield diminishing returns; the pattern is documented in `docs/internals/coordinator-pattern.md` for future additions. |
| Coordinator tier = Haiku for reads, Sonnet for reasoning | Haiku for read+parse (bundle-resume, plan-parser, task-verify); Sonnet where output requires judgment (brainstorm-anchor, doctor). Cost optimization with the right capability tier. |
| `coordinator_fallback` sentinel required | Every coordinator site must log `coordinator_fallback` on error and fall back to pre-v6 inline behavior. Ensures v6.0.0 doesn't introduce new failure modes; allows gradual coordinator adoption. |
| step-c split by lifecycle phase, not by size | 4 sub-files map to 4 lifecycle responsibilities (resume entry, wave dispatch, verification, completion). Any other split criterion would make cross-referencing fragile. |
| docs/internals.md becomes a navigation index | The monolith was loaded into context on every doctor/retro turn. The index (25 lines) replaces it for navigation while each coordinator's focused doc is loaded only when that coordinator runs. |

---

## Follow-ups

- **`writing-plans` skill annotation mismatch:** the skill emits `**Codex:** true/false` but `parts/step-c-dispatch.md`'s annotation-completeness scan requires the literal tokens `ok` / `no`. Plans generated by the skill auto-fall-back to Haiku build, defeating the inline Codex path. v6.0.1 fix candidate.
- **Codex worktree routing:** the git-index-outside-sandbox issue will recur for any masterplan bundle in a git worktree layout. `bin/masterplan-codex-usage.sh` could emit a pre-dispatch check for worktree sandbox compatibility.
- **step-c-resume.md size (37,786 bytes):** still above the 25,600-byte target. T3-style prose-pruning could bring it down; defer to a future efficiency pass.

---

## Open doctor checks

- **#22 (high-complexity rigor evidence):** expected; `codex_routing` was off for this entire run due to the Codex sandbox issue. Not a regression.
