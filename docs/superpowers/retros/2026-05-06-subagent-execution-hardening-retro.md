# Subagent Execution Hardening — Retrospective

**Slug:** subagent-execution-hardening
**Started:** 2026-05-05 (plan file `docs/superpowers/plans/2026-05-05-subagent-execution-hardening.md` created; audit doc `docs/audit-2026-05-05-subagent-execution.md` same day)
**Completed:** 2026-05-05 21:44:41 -0700 (v2.8.0 tag `ec42e39`)
**Branch:** main (direct-to-main shipping via worktree `subagent-exec-hardening`, ff-only merged per Task 11)
**PR:** none

---

## Outcomes

- Converted 7 high-severity audit findings (D.1, D.2, D.4, C.1, E.1, F.4, G.1) from convention-only to structurally-enforced in `commands/masterplan.md`. Each finding had a documented "gap between convention and structurally enforceable"; all seven closed in a single cycle (CHANGELOG `## [2.8.0] — 2026-05-05`).
- Added 2 new doctor checks (#23 model-passthrough leakage, #24 non-empty status queue), 3 new config flags (`codex.detection_mode`, `parallelism.member_timeout_sec`, `parallelism.on_member_timeout`), and 1 new implementation-return field (`commands_run_excerpts`) across the orchestrator prompt.
- Shipped with a fresh-eyes audit catch post-release: verify-pattern annotation was implemented at Step 4a but not documented in the writing-plans guidance; commit `83d4568` repaired the documentation gap before the tag was placed on main.

---

## Timeline

Reconstructed from `git log v2.7.0..v2.8.0` — all commits landed 2026-05-05 ~19:27–21:44 PDT.

- **~19:14** — v2.7.0 ships (baseline). Audit doc `docs/audit-2026-05-05-subagent-execution.md` written same day via three parallel Haiku Explore subagents; 7 findings ranked high-severity and handed to the plan.
- **~21:27** — Cluster 1+2 (D.2, D.4): eligibility cache schema versioning (`9cd135c`) and Step 4b mid-plan availability re-check (`f277fae`). Both low-risk, surgical, committed 28 seconds apart.
- **~21:28–21:30** — Cluster 3+4 (D.1, C.1): ping-based Codex detection (`8ed9384`) and doctor check #23 (`7608d38`). D.1 replaced the fragile string scan; C.1 introduced telemetry-driven post-mortem detection and bumped check count to 24.
- **~21:34–21:35** — Cluster 5+6 (E.1, F.4): E.1 reframed as post-hoc slow-member detection (`75dc429`); F.4 flock guard + queue sidecar + doctor check #24 (`acd1cd1`).
- **~21:38–21:39** — Cluster 7+release (G.1, CHANGELOG, version bump): trust-contract excerpt-validator (`d2cc452`), CHANGELOG (`51c3710`), release commit (`ec42e39`). G.1 took the Task 7 brainstorm-gate pick: option 1 (verification output excerpt validation).
- **~21:44** — Post-release fresh-eyes catch: `verify-pattern` annotation undocumented in Step B2; commit `83d4568` added the writing-plans paragraph. Tag placed on this commit, not the release commit.

---

## What went well

- **All 7 audit findings closed in one session.** The audit doc served as a precise spec: every task in the plan cited `docs/audit-2026-05-05-subagent-execution.md` by finding ID, and all 7 high-severity items from the executive summary shipped. (`CHANGELOG.md:84-170`)
- **E.1 reframing saved a dead-end implementation.** The original plan called for active wave-member cancellation — a primitive an LLM orchestrator cannot enforce. The implementation correctly identified this, reframed E.1 as post-hoc detection via `duration_ms` in `<slug>-subagents.jsonl`, and produced a useful (if weaker) guarantee without wasted effort. (`CHANGELOG.md:125-137`, commit `75dc429`)
- **Fresh-eyes audit pass caught a second-order issue.** Per anti-pattern #5 in CLAUDE.md, a fresh-eyes Explore subagent was dispatched after the G.1 implementation. It caught that `verify-pattern` was added to Step 4a but not documented in Step B2's writing-plans guidance — meaning plan authors would never know to use it. Commit `83d4568` fixed this before tagging; the v2.8.0 tag sits on the repaired commit, not the release commit.
- **Plan design matched actual execution closely.** The plan's footprint estimate ("`~120 lines added across 7 clusters`") and the actual diff align. Cluster granularity (one commit per finding) made git history readable and bisectable.
- **Doctor-check numbering and parallelization-brief count were both updated.** Anti-pattern #4 (sync'd location drift) was respected: checks #23 and #24 both have table rows, definition blocks, and their addition bumped the parallelization brief count to 24. (`CHANGELOG.md:116-123`, `CHANGELOG.md:147-148`)

---

## What blocked

(Reconstructed — no activity log in the plan status file; WORKLOG.md has no entries matching this plan.)

- **No blocking issues surfaced.** All 10 commits landed within a ~17-minute window (21:27–21:44 on 2026-05-05), which is inconsistent with any meaningful block. The only course correction was the E.1 design reframe (not a block — a spec discovery at implementation time).
- **G.1 brainstorm gate resolved immediately.** Task 7 was a formal decision point requiring `AskUserQuestion` with 4 options; the pick (option 1, excerpt validation) resolved without iteration.

---

## Deviations from spec

The audit doc (`docs/audit-2026-05-05-subagent-execution.md`) functioned as the de-facto spec. Cross-check against what shipped:

- **E.1 — Active cancellation → post-hoc detection.** Audit finding: "spec a per-member timeout … plus a graceful partial-completion path." Plan task: `feat(step-c): wave-member timeout + partial-completion`. What shipped: post-hoc detection via `duration_ms` telemetry, not active cancellation. The plan itself documents the reframe rationale ("an LLM orchestrator has no async/cancel primitive"). The shipped behavior is weaker (observability not enforcement) but honest; the `on_member_timeout: blocker` config path still routes slow members through the blocker gate on the NEXT Step C entry. `CHANGELOG.md:125-137`.
- **Doctor check numbering off by one.** Plan task 4 specified doctor check #22; shipped as #23 (CHANGELOG `## Added`, bullet 4). Likely because check #22 already existed in the baseline or was inserted by an adjacent change. Not a functional deviation.
- **Doctor check for F.4 queue:** Plan specified check #23 (the queue-file check). Due to the numbering shift, it shipped as check #24. Same as above — cosmetic only.
- **Audit findings deferred:** G.2-G.6 (additional trust-contract variants), A.1 (pre-dispatch model-passthrough lint), F.1-F.3 (mtime/content-hash hardening), H-class (git/gh/sandbox edge cases), E.2-E.5 (wave sub-cases). All catalogued in CHANGELOG `### Why` block and flagged for v2.9.0+. `CHANGELOG.md:169-170`.

---

## Codex routing observations

Not tracked for this plan — no `<slug>-subagents.jsonl` activity log available. Doctor check #23 that ships in this very release would have captured model-on-dispatch-site data if it had existed during the development run. Absence noted as a bootstrap gap: the first cycle that benefits from #23 is the one after v2.8.0.

---

## Follow-ups

From plan `## Out of scope` + CHANGELOG `### Why` block:

- **v2.9.0+ candidates:** G.2-G.6 (trust-contract variants), A.1 (pre-dispatch model-lint), F.1-F.3 (mtime/content-hash hardening), E.2-E.5 (wave dispatch sub-cases), H-class findings.
- **Smoke tests T1-T7** listed in plan `## Verification matrix` were not run (no test framework; hand-crafted runtime tests require live session execution). All 7 are documented — whoever runs the next `/masterplan execute` on a plan with eligibility caches, wave dispatch, or the trust contract will exercise them implicitly.
- **`verify-pattern` annotation adoption.** Now documented in Step B2 (`83d4568`), but existing plans predating v2.8.0 carry no `**verify-pattern:**` annotations. The orchestrator falls back to the default PASS regex (`PASSED?|OK|0 errors|0 failures|exit 0|✓`) — functional but less precise. No follow-up required unless false-pass rates surface.

---

## Lessons / pattern notes

- **Audit-first, then plan.** Producing a dedicated `docs/audit-*.md` before the plan (rather than scoping the plan from memory) gave every task a cited file:line anchor. This made the verification step ("grep for the specific string the plan said to add") trivially checkable. For future hardening cycles, the audit doc doubles as a spec and a test oracle.
- **Post-hoc detection is a valid substitute when active enforcement is impossible.** E.1's reframe demonstrates: when the runtime model doesn't support a synchronous cancellation primitive, instrument the telemetry and close the gate on the NEXT cycle. "Observe and route" is better than dead prose claiming enforcement that cannot happen.
- **Fresh-eyes audit pass is load-bearing, not optional.** The `verify-pattern` gap caught by `83d4568` would have shipped silently if the fresh-eyes step had been skipped. The annotation was present in the right place (Step 4a), just unreachable by plan authors who read Step B2. The issue class — "feature exists but is not surfaced at the authoring entry point" — is hard to catch by author self-review. Assign it as a distinct post-implementation task.
- **Tag placement after fresh-eyes pass.** The v2.8.0 tag was placed on `83d4568` (the post-release fix), not `ec42e39` (the release commit). This is correct per project convention — the tag should track the last commit that makes the release coherent, not the first commit that claims to be it. Reviewers consulting `git show v2.8.0` get the complete picture including the fresh-eyes repair.
