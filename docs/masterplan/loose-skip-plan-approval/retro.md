# Retro — loose-skip-plan-approval (v4.2.0)

**Outcome:** `db67909` (feature) + `65f74ab` (bundle) pushed to `origin/loose-skip-plan-approval` on 2026-05-13. CHANGELOG honestly records that manual smoke verification was deferred. PR open URL surfaced by `git push` for follow-up.

**Duration:** ~11 minutes wall-clock from `bundle_created` (09:51:07Z) to `push_landed` (10:02:02Z). A session compaction landed mid-run between T1 and T3; the bundle (`state.yml` + `events.jsonl` + `plan.md`) was sufficient context for clean re-entry — no work lost, no re-planning needed.

**Verification ceiling:** repo-local — grep discriminators + `bash -n` hook sanity + Haiku fresh-eyes Explore on `commands/masterplan.md`. CD-3 was waived (with user authorization via AUQ) for the manual smoke gate; the substance of the change (single Edit at L1360 flipping a gate condition) ships unverified empirically but is internally consistent and corroborated by the Haiku review.

---

## What worked

- **Diagnostic-first conversation surfaced the root cause cleanly.** The "9 of 10 recent `state.yml` files persist `autonomy: loose`" survey gave confidence that config-load was working; the bug was downstream in gate-condition logic. That re-framing turned a "config not honored" hypothesis into a precise "L1360 condition is wrong" target, which is a much smaller intervention.
- **Conservative middle-ground scope.** User explicitly chose to fix L1360 (`plan_approval`) and leave L1286 (`spec_approval`) intact. The asymmetry is deliberate, documented in CHANGELOG, and trivially reversible if future feedback says "fix L1286 too." Avoided over-correcting on a single conversation.
- **High-complexity plan annotations bore weight.** T6/T7 in the plan said "verify schema before editing" — which let the orchestrator handle the pre-existing manifest drift (T6: catch-up `3.3.0` → `4.2.0` across both top-level + plugin-entry version fields; T7: no-op for missing `version` field in `.agents/plugins/marketplace.json`) inline without halting for AUQ. Plan-level acknowledgement of schema uncertainty was load-bearing.
- **AUQ for the smoke-deferral decision was concrete and bounded.** Four labeled options with explicit tradeoffs ("defer + commit on Haiku-clean + T11 grep" vs "you run smoke" vs "skip Haiku too" vs "stop here"). User picked deferral (precedent: v4.1.1); CHANGELOG "Status at tag time" line is durable in the released artifact, not buried only in the retro.
- **Haiku fresh-eyes Explore corroborated the edit.** Zero dangling refs, zero contradictions; cited L1631, L1792, L1966, and L3019 as unrelated authority lines that remain consistent with the new L1360. Anti-pattern #5 from project CLAUDE.md ("don't trust your own confirmation bias on large markdown edits") respected.
- **Loose-autonomy contract held end-to-end.** Between waves the orchestrator did not surface unnecessary AUQs; gates fired only at (a) the post-Haiku/pre-commit decision point and (b) the push gate. User-CLAUDE-md's stated contract was honored across the run.

---

## What slipped

- **Plan T6/T7 assumed manifest version-field state that wasn't real.** The plan implicitly assumed all four manifests had a `"version": "4.1.1"` field. Reality: `.claude-plugin/marketplace.json` was stuck at `3.3.0` (pre-existing drift) and `.agents/plugins/marketplace.json` has no `version` field at all. Resolved inline by orchestrator judgment, but a plan-time `grep -n '"version"' .claude-plugin/marketplace.json .codex-plugin/plugin.json .agents/plugins/marketplace.json` would have caught both before the plan was locked. **Lesson:** for any task that asserts file state ("bump version from X to Y in N files"), the plan should include a one-line `grep` evidence check during planning, not at execution. The plan-grep-gate authoring recipe added to internals.md §13 in `6d1ba1b` covers this for execution-time gates; the same hygiene should extend backward to plan-time assertions.
- **`.claude-plugin/marketplace.json` had been drifting since at least v3.3.0.** v3.4.0, v4.0.0, v4.1.0, and v4.1.1 all shipped without bumping it. v4.2.0 caught it up, but nothing prevents the drift from reopening on the next release. **Lesson:** add a doctor check that compares the canonical `.claude-plugin/plugin.json` version against all marketplace.json version fields, and warn on mismatch. Worth ~10 lines of `jq` and would have surfaced this months ago.

---

## Orchestrator-prompt lessons worth folding back

1. **Per-autonomy gate behavior across B1/B2/B3 deserves a single source of truth.** This is the second autonomy/gate bug fix in two recent releases. There's no consolidated reference table in `docs/internals.md` showing "for each (halt_mode, autonomy) pair, which gates fire." The state machine is implicit across L1286 + L1360 + verification gates + Step C task gates. **Candidate doctor check:** grep all gate-condition expressions (`id: <gate_name>` adjacent to `--autonomy`) and compare against a docstring-table in internals.md. If the docstring is missing, surface that as a plan-readiness concern.
2. **The L1286/L1360 asymmetry should appear somewhere queryable, not just in the L1360 inline comment.** Currently a future reader who only `grep`s `id: spec_approval` won't immediately know it intentionally diverges from `id: plan_approval` behavior under loose. Worth a one-line note at L1286 like `# Intentionally fires under loose; see L1360 + CHANGELOG v4.2.0 for asymmetry rationale.` Captured in `Carried-forward items`.
3. **Cross-manifest version drift detector.** Cheap, useful, would have caught the `.claude-plugin/marketplace.json` drift before v4.2.0. Should land alongside the per-autonomy gate audit doctor check.

---

## Carried-forward items

- **Deferred:** manual smoke verification of v4.2.0's loose-autonomy behavior. To execute: `/masterplan full <small-topic>` in a throwaway repo under `~/.masterplan.yaml: autonomy: loose`. Expected events: exactly one `gate_opened` for `spec_approval`, zero `gate_opened` for `plan_approval`, no `halt_gate_post_plan`. If those expectations fail, ship v4.2.1 corrective patch — the L1360 edit is a single line and trivially revertible.
- **Possible v4.2.1 trigger:** if deferred smoke reveals `plan_approval` still firing under loose, the hypothesis "L1360 is the sole firing site" (validated only by Haiku static analysis, not runtime) is wrong. Corrective change would likely be a wider audit of the autonomy state-machine in Step B3 + Step C task-completion gates.
- **Possible follow-up plan: L1286 symmetry.** Some users may want both spec_approval and plan_approval to auto-approve under loose. The asymmetry is deliberate per spec, but a follow-up could add an opt-in `~/.masterplan.yaml: spec_approval_under_loose: skip` if community feedback wants it. Not in scope for v4.2.x.
- **Doctor check candidate:** cross-manifest version drift detector (`jq` over all `.claude-plugin/*.json` + `.codex-plugin/*.json` + `.agents/plugins/marketplace.json`).
- **Doctor check candidate:** per-autonomy gate-condition consistency check across L1286 / L1360 / Step C task gates / verification gates.
- **Doc tidy-up:** add `<!-- intentionally diverges from L1360 plan_approval — see CHANGELOG v4.2.0 -->` comment at L1286 to make the asymmetry self-documenting. Not blocking; future drive-by.

---

## Commit references

- Feature commit: `db67909` (release: v4.2.0)
- Bundle commit: `65f74ab` (run bundle scaffolding through T12 start)
- Remote: `origin/loose-skip-plan-approval` (PR URL: https://github.com/rasatpetabit/superpowers-masterplan/pull/new/loose-skip-plan-approval)
- No annotated tag created this run (user chose plain push only).
