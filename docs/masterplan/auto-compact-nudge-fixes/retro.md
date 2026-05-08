# Auto-Compact Nudge Fixes (v2.9.1) — Retrospective

**Slug:** auto-compact-nudge-fixes
**Started:** 2026-05-06 (brainstorm session, same morning)
**Completed:** 2026-05-06 (tagged and pushed same day)
**Branch:** main (direct-to-main shipping)
**PR:** (none)

## Outcomes

- **Wording fix** (`commands/masterplan.md:606`, `5d8c3a7`): replaced "in another shell or session" — which routed the user to compact the wrong session — with "in this same session", plus a new disclosure sentence covering the unconditional-firing tradeoff and a tuning hint (`60m` or `90m` intervals).
- **Config validator** (`669e791`): Step 0 now detects `auto_compact.enabled == true` with an empty/null `auto_compact.interval`, sets in-memory `auto_compact_nudge_suppressed`, skips the nudge for that run, and emits a user-visible warning. Guards against the silent degrade-to-dynamic-mode path (`ScheduleWakeup` cannot fire built-in `/compact`).
- **Doctor check #26** `auto_compact_loop_attached` (`7a8efa9`): repo-scoped, Warning severity, no `--fix`. Calls `CronList` to verify a `/compact` cron is attached when one or more plans have `compact_loop_recommended: true`. Surfaces the wrong-shell failure mode the nudge itself cannot detect.

All three changes address spec goals G1–G3 (`docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md`). G4 (single coherent v2.9.1 patch, no behavior change to working configs) was honored — the default 30m cadence is unchanged.

## Timeline

All activity on 2026-05-06:

- `2fb872c` 11:00 — spec committed after brainstorm confirmed mechanism critique was false (fixed-interval `/loop` does fire built-in compaction via `CronCreate` path)
- `142b258` 11:05 — five-task implementation plan committed
- `5d8c3a7` 11:09 — Task 1: wording fix
- `669e791` 11:12 — Task 2: config validator + suppression flag wired at both nudge sites (Step B3 and Step C step 1)
- `7a8efa9` 11:15 — Task 3: doctor check #26 row + parallelization-brief update
- `d8990d6` 11:19 — Task 4: version bumps (plugin.json, marketplace.json), CHANGELOG, WORKLOG
- `5b764da` 11:20 — post-review nit: pin check number in spec (`#26` not "next available"), note repo-scoped semantics
- `897ebc0` 11:25 — post-review nit: replace brittle `line 803` reference in check #26 table row with section-based reference; spec frontmatter → `shipped`

Elapsed wall time: ~25 minutes from spec commit to release commit.

## What went well

- **Brainstorm correctly resolved the mechanism critique before spec was written.** The initial concern was that `CronCreate`-mode interception might not fire built-ins. The brainstorm nailed down the `<<autonomous-loop>>` vs `<<autonomous-loop-dynamic>>` sentinel distinction first, so the spec was scoped to wording + guardrails rather than a mechanism rewrite. Saved a large detour.
- **User-confirmed wording via `AskUserQuestion` preview shipped verbatim** (`5d8c3a7`). The nudge replacement text was presented as a rendered diff in the brainstorm; user approved exact text. No post-ship edits to the wording.
- **Validator + doctor #26 bundled** (`669e791`, `7a8efa9`) rather than staged across releases. The two failure modes (silent degrade, wrong shell) were structurally related; shipping them separately would have left a gap. The WORKLOG captures this reasoning explicitly.
- **Post-review caught two nits cleanly** (`5b764da`, `897ebc0`). A fresh-eyes review pass after the four task commits found the brittle `line 803` reference and the underspecified check number before they landed permanently. Both were small one-line edits; catching them at review is cheaper than retro-patching later.
- **Plan's per-task grep scaffolding paid off.** Each task had pre/post grep expectations with exact counts. No task commit had to be amended; all landed correctly on the first attempt.

## What blocked

**Near-blocker: `~/.claude/commands/masterplan.md` shim discovered mid-session.** When v2.9.0 shipped the drift-detection doctor check (#25), it retroactively identified that the user's runtime was loading a stale manual-copy shim at `~/.claude/commands/masterplan.md` rather than the plugin-installed version. This shim had been invisible across all prior v2.9.0 work. The v2.9.1 implementation had to be confirmed against the correct runtime file (HEAD in the repo), not the shim. The root cause was that the shim predated plugin install and check #25 hadn't run yet. Resolution: check #25 `--fix` updated the shim before v2.9.1 tasks began; work proceeded unblocked. The shim sentinel recognition gap (check #25 re-flagging a deliberately installed shim) is tracked as v2.10.0 work in `WORKLOG.md:701`.

## Deviations from spec

Spec was tight; implementation matched closely. Minor divergences:

- **Spec Change 2 location** (`docs/superpowers/specs/…:62-70`) cited `~line 1853` for the validator bullet. The plan (`docs/superpowers/plans/…:108-109`) targeted `commands/masterplan.md:30-31`. Both referred to the same flag-conflict warnings block under Step 0; the plan's specific line numbers are the source of truth for what actually shipped. No functional deviation.
- **Spec `5b764da` inline refinement.** The spec was updated mid-implementation (before Task 3) to pin the check number as `#26` and call out its repo-scoped semantics explicitly. This was a spec correction, not a deviation — the plan already had the right implementation. Captured in the commit body.
- **Post-review nit `897ebc0`**: replaced `line 803` reference in the doctor check #26 table row with `"competing-scheduler check pattern in Step C step 1"`. The spec used the section-name form; the initial implementation used a line number. Corrected to match spec intent. Noted in commit body as "caught by final whole-set review."

All spec non-goals (N1–N5) were honored: no mechanism change, no conditional-fire logic, no interval lengthening, no nudge removal.

## Codex routing observations

Not tracked — this was an Opus-driven session. No per-task Codex routing. All four implementation commits were executed inline by the orchestrator's subagent-driven-development flow. The tasks were small (single-block edits with grep verification) and sequential with tight dependencies; Codex delegation would not have added value here.

## Follow-ups

- [ ] **Manual smoke: validator with empty interval** — run `/masterplan brainstorm test` with `auto_compact: { enabled: true, interval: "" }` in `~/.masterplan.yaml`, verify warning emits and nudge is suppressed — `/schedule` candidate? No — manual one-shot when convenient.
- [ ] **Manual smoke: doctor check #26 positive case** — session with `/loop 30m /compact …` running, then `/masterplan doctor` → expect no warning finding — `/schedule` candidate? No.
- [ ] **Manual smoke: doctor check #26 negative case** — session that saw the nudge but no loop → `/masterplan doctor` → expect warning + copy-pasteable command — `/schedule` candidate? No.
- [ ] **v2.10.0: shim sentinel recognition for check #25** — prevent check #25 from re-flagging a deliberately installed plugin shim. Tracked at `WORKLOG.md:701`, plan at `~/.claude/plans/curious-coalescing-rose.md`.

## Lessons / pattern notes

- **Mechanism investigation before spec commit is load-bearing.** The brainstorm spent time confirming that `CronCreate`-mode `/loop` does fire built-in `/compact` before the spec was written. If that had been assumed wrong, the spec would have targeted a mechanism rewrite (weeks of work) instead of a wording patch + two guardrails. The day-of speed (25 minutes spec-to-release) depended on that correct baseline.
- **"Disclose rather than fix" as a design choice when external gating is impossible.** There is no harness-level "skip `/compact` if context < X%" form, and the model cannot gate built-ins via the Skill tool. When a clean fix is structurally impossible, the right call is honest user-facing disclosure — not a half-measure workaround. Non-goal N2 is the documented rationale.
- **Validator + doctor pairing pattern.** The silent-degrade failure (bad config) and wrong-shell failure (correct config, wrong session) are dual failure modes for the same feature. Shipping only the validator would have left the wrong-shell case undetected. Bundling both in one patch provides full coverage without a gap release. Pattern worth repeating for future features with similar dual-mode failure structure.
- **Fresh-eyes review after task commits.** Both post-review nits (`5b764da`, `897ebc0`) were caught by a deliberate re-read of the full change set after task commits landed. Neither was visible in the per-task verification greps (which checked for presence/absence of specific strings, not reference rot). The CLAUDE.md anti-pattern #5 ("don't trust your own confirmation bias on large markdown edits") is validated here.
- **`AskUserQuestion` preview for user-visible text.** Presenting the exact replacement wording in a structured preview and waiting for explicit confirmation before writing it to the plan prevented the need for any post-ship wording edits. For any UI-visible string in a prompt orchestrator, preview-confirm before plan is the right default.
