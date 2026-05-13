# Retro — p4-suppression-fix (v4.1.1)

**Outcome:** v4.1.0 (`301d789`) + v4.1.1 (`f6adb11`) tagged and pushed to origin on 2026-05-13. CHANGELOG honestly records that the v4.1.1 smoke verification was deferred. The smoke bundle (`docs/masterplan/p4-suppression-smoke/`) remains executable in a fresh session whenever someone wants to close the empirical gate.

**Duration:** ~95 minutes from `bundle_created` (05:00:45Z) to `plan_complete` (06:35:00Z).

**Verification ceiling:** repo-local — `bash -n` + grep discriminators + a manual smoke run (skipped). CD-3 was explicitly waived by user authorization for the smoke gate; the substance of the fix (additive per-state-write priming + Step C entry split) ships unverified empirically but is internally consistent and reviewed via Codex.

---

## What worked

- **Reading target files BEFORE writing the spec — once forced by advisor.** The advisor consult at event #10 flagged "spec written without reading target files" as blocking. Refusing to skip that step uncovered: `CLAUDE_SESSION_ID` is not reliably exported (so R4 needed a `uuidgen` fallback), and `bbe5a38` was actually `HEAD~2`, not `HEAD` (so the planned amend wasn't safe under the project's no-rebase-i rule). Both would have produced bad code or a forbidden git operation.
- **In-session empirical observations as design evidence.** The reminder fired twice during the brainstorm itself (events #5, #9) under zero `Task*` usage. That's a no-cost baseline measurement that directly validated the codex finding and informed the "per-state-write vs heartbeat" risk register (R1).
- **Additive framing over replacement.** v4.1.1 was scoped as "v4.1.0 covers transitions; v4.1.1 covers idle-turn gaps and first-entry-before-any-transition." Made the spec defendable without retracting v4.1.0's mechanism.
- **Smoke contract pre-registered.** The smoke bundle was Task 1 — scaffolded before any orchestrator-prompt edits. Even though the smoke wasn't run, the contract (mandatory `smoke_observation` event per turn + grep gate) is documented and runnable. Future sessions don't need to reverse-engineer what counts as verification.
- **Honesty preserved at the deviation.** When the user skipped the smoke gate, the CHANGELOG got a "Status at tag time" line saying so, and the retro/event log records the deviation rather than papering over it. CD-3 was waived knowingly, not silently.

---

## What slipped

- **Two plan grep gates were specified against the wrong format** (events #24, #27): Task 9 expected `grep -c "step_c_session_init_sha" >= 2` in line-count terms but the natural phrasing produced 1 line with 2 occurrences; Task 12 expected `^## v4.1.1` but the CHANGELOG convention uses `^## \[4\.1\.1\] —`. Both were resolved as substance-over-form deviations. **Lesson:** when authoring plan grep gates against a target file that already has formatting conventions, sample that file's existing style before locking the regex. A 30-second `head` of CHANGELOG.md would have caught Task 12 in planning.
- **Task 2 plan assumption invalid** (event #18): the planned `git commit --amend on bbe5a38` was unsafe because `bbe5a38` was already `HEAD~2`. Required a mid-run AUQ to pick a recovery path (chose Option B: new fix commit at HEAD). **Lesson:** plan steps that mutate git history must verify the target ref's position relative to HEAD at plan time, not assume HEAD-coincidence.
- **Smoke verification deferred.** The CD-3 spirit of the plan was that v4.1.1's empirical claim is unverified until smoke evidence exists. User chose to ship anyway. **Lesson (org-level, not plan-level):** if smoke is the verification ceiling, the release-gate AUQ should surface the verification debt prominently — done here by adding a "Status at tag time" line to CHANGELOG — so the deferral is durable in the released artifact, not just in the retro.

---

## Orchestrator-prompt lessons worth folding back

1. **Plan grep gates against natural-language doc files are brittle.** Three of fourteen tasks (Tasks 9, 12, and arguably 7) had grep gates that didn't match how the content naturally wanted to be phrased. Future plan-authoring guidance: prefer **anchor-string presence** (`grep -q "step_c_session_init_sha"`) over **line-count thresholds** (`grep -c >= 2`) for any check on a markdown file. Line counts are an editing artifact; presence is the substance.
2. **The first session-entry helper (`bin/masterplan-state.sh session-sig`) is a small, reusable primitive.** Other v5.x work that needs to distinguish "this session" from "earlier sessions" can call the same subcommand. Worth a one-liner mention in `docs/internals.md` next time §3 is revisited.
3. **Per-state-write priming is the right cadence pulse for the harness reminder problem, but only the smoke run will tell us whether the pulse rate is sufficient.** If R1 fires in the deferred smoke, the pre-registered rescope is Option D (heartbeat at the orchestrator's tool-call boundary, not just at state writes). The spec has this risk register intact, so a future v4.1.2 doesn't have to redo the analysis.

---

## Carried-forward items

- **Deferred:** Smoke verification of v4.1.1's per-state-write priming. Bundle: `docs/masterplan/p4-suppression-smoke/`. To resume: open a fresh Claude Code session and run `Use masterplan execute docs/masterplan/p4-suppression-smoke/state.yml`. Grade with grep gate from spec.md.
- **Possible v4.1.2 trigger:** if the smoke run shows reminder still firing under per-state-write priming, escalate to the pre-registered Option D (per-tool-call heartbeat). Risk register in spec.md captures the design.
- **Possible doc tidy-up:** `docs/internals.md` §3 could pick up a one-line mention of the `session-sig` subcommand alongside the existing helper inventory. Not blocking.

---

## Tag references

- v4.1.0 commit: `bbe5a38` (smoke-flagged release)
- v4.1.0 annotated tag SHA: `301d789`
- v4.1.1 commit: `79f2404` (post-CHANGELOG-honesty)
- v4.1.1 annotated tag SHA: `f6adb11`
- Final state-close commit: `7127438`
