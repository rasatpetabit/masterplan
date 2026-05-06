# CD-9 Enforcement (v2.10.0) — Retrospective

**Slug:** cd-9-enforcement
**Started:** 2026-05-06 (afternoon, same session as v2.9.1)
**Completed:** 2026-05-06 (tagged + pushed same day)
**Branch:** main (direct-to-main)
**PR:** (none)

---

## Outcomes

- **CD-9 promoted to peer-level architectural goal.** "Three design goals" → "Four design goals" at the top of `commands/masterplan.md` (lines 9-16). First-time readers see the structured-questions rule without scrolling to line 182.
- **Two known CD-9 violations fixed.** Line 660 (branch-mismatch on resume) and line 1900 (import collision + missing call site) both converted from free-text prose to explicit `AskUserQuestion` with three options each. Line 1900 also added new Step I3.1.5 (path-existence pre-pass) that the rule required but had no actual implementation.
- **Doctor check #27 (`orchestrator_free_text_user_question`)** added as a repo-scoped Warning regression guard — greps `commands/masterplan.md` for forbidden free-text patterns, scans ±20 lines for a paired `AskUserQuestion` or `<!-- cd9-exempt: <reason> -->` exemption.
- **Doctor check #25 augmented** (Phase B carryforward) to recognize the `<!-- masterplan-shim: v1 -->` sentinel, skipping md5 comparison for managed shim installs and emitting an info note instead of a spurious drift Warning.

---

## Timeline

All six commits shipped 2026-05-06, immediately after v2.9.1 tagged in the same session.

| SHA | Time (PDT) | Description |
|---|---|---|
| `d558b82` | 12:30 | fix: line 660 branch-mismatch → `AskUserQuestion` (CD-9 violation #1) |
| `647097f` | 12:34 | fix: line 1900 import collision + new Step I3.1.5 → `AskUserQuestion` (CD-9 violation #2) |
| `458107a` | 12:36 | docs: promote CD-9 to Four design goals |
| `665cba1` | 12:39 | feat: doctor check #27 `orchestrator_free_text_user_question` |
| `30c4964` | 12:42 | feat: doctor check #25 recognizes plugin shim sentinel |
| `2a1fc35` | 12:45 | release: v2.10.0 tag + CHANGELOG |

Total elapsed from first commit to release: ~15 minutes. This release ran back-to-back with v2.9.1 (auto-compact nudge fixes) in the same Opus-driven session.

**Primary sources:** CHANGELOG.md `## [2.10.0]` entry; WORKLOG.md `## 2026-05-06 — v2.10.0` section. The plan file `~/.claude/plans/curious-coalescing-rose.md` was subsequently overwritten by a later `/plan` invocation and is no longer available as a source.

---

## What went well

- **Investigation-first corrected the user's mental model.** The user framed the ask as "bake CD-9 in" — implying the rule was missing. Investigation found CD-9 was already present at `commands/masterplan.md:182` and `commands/masterplan.md:1903`, and was referenced in `CLAUDE.md` anti-pattern #2. The actual work was enforcement (find + fix violations) plus visibility (Goal #4 promotion), not addition. Getting this right before any edits avoided writing redundant rule text.

- **Bundling Phase B closed a deferred debt item cleanly.** The shim-sentinel augmentation to check #25 was carried forward from the v2.9.1 planning session. It touched the same area of code (doctor check table) as v2.10.0's other changes, so bundling was low-friction and eliminated the risk of the freshly-installed shim being re-flagged as drift on the very next `/masterplan doctor` run.

- **Regression guard (check #27) ships with the fixes.** Adding the doctor check in the same release as the two violation fixes means the CD-9 enforcement story is complete at tag time — the violations are patched, the rule is visible, and any future regression surfaces immediately.

- **Line 1900 fix also added a missing call site.** The rule at line 1900 said "ask the user" but there was no actual `AskUserQuestion` invocation in the I3.x code path. The fix added Step I3.1.5 (path-existence pre-pass) between I3.1 and I3.2, which is a semantic improvement: aborted candidates now skip the entire I3 pipeline rather than proceeding to the fetch stage.

- **Subagent-driven-development handled five sequential edits cleanly.** Five task commits, each bounded and independently verifiable, with no context bleed between tasks.

---

## What blocked

**False-positive grep during Task 5 (check #27) verification.** The verification grep for forbidden patterns flagged line 546 of `commands/masterplan.md` as a hit. Static grep cannot distinguish a match inside a rule definition (which check #27 explicitly skips) from a genuine violation. Check #27's actual ±20-line algorithm correctly handles this: it scans context lines for the CD-9 rule header and skips those matches. The divergence between static-grep verification semantics and the runtime-check's context-aware semantics is a known limitation of grep-based verification on this orchestrator — the grep proves the pattern exists, not that it's a violation at runtime.

No time was lost; the distinction was recognized immediately. But it's a pattern worth noting: grep verification of check #27 itself requires knowing which matches are inside exemption zones.

---

## Deviations from spec

There was no formal spec artifact for v2.10.0. The user explicitly chose to skip `docs/superpowers/specs/` for this release. The "spec" was scope confirmed interactively (via `AskUserQuestion`) at brainstorm time:

- **Full+ scope confirmed:** fix both violations + promote to Four design goals + add doctor check #27 regression guard + bundle Phase B (shim sentinel).
- **No skip-violations / doctor-only option taken:** full enforcement was the right call given the violations were concrete and locatable.

Cross-checking brainstorm decisions against shipped state: all four scope items from the confirmed plan appear in CHANGELOG `## [2.10.0]` — Fixed (2 items), Added (3 items including Goal #4 and checks #25 augment and #27). No scope was dropped or expanded post-confirmation.

The absence of a spec artifact means the primary sources for this retro are the CHANGELOG entry and the six commit bodies. The plan file (`~/.claude/plans/curious-coalescing-rose.md`) was overwritten by a subsequent session and cannot be cited.

---

## Codex routing observations

Not tracked — v2.10.0 was an Opus-driven session throughout. No `[codex]` delegation occurred.

---

## Follow-ups

- [ ] **Manual smoke: doctor check #27 positive/negative/exemption cases** — verify the ±20-line scan correctly skips the CD-9 rule definition zone (line 182) and the line 546 false-positive zone, and correctly fires on a fresh violation. Deferred from the v2.10.0 plan verification section.
- [ ] **Manual smoke: doctor check #25 shim sentinel recognition** — install a file containing `<!-- masterplan-shim: v1 -->` at `~/.claude/commands/masterplan.md` and confirm check #25 emits an info note rather than a Warning drift alert. Deferred from same verification section.

Both were noted in the plan (`~/.claude/plans/curious-coalescing-rose.md`) before it was overwritten. No `/schedule` candidate — these are one-time manual verifications.

---

## Lessons / pattern notes

- **Investigate before implementing, even when the user's framing implies addition.** The user said "bake CD-9 in" — a natural reading is "the rule is missing, write it." A quick scan of the file found the rule at line 182 and 1903. The session became enforcement work, not authorship. This distinction matters: enforcement has a verifiable end state (zero violations, check fires on regression); authorship does not. The investigation step was load-bearing.

- **CD-9 needed two surfaces to be durable: top-of-file visibility AND a regression guard.** The rule at line 182 was invisible to first-time readers. Promoting it to Goal #4 (lines 9-16) makes the constraint architectural, not a footnote. Doctor check #27 closes the enforcement loop so future orchestrator edits can't silently reintroduce violations.

- **The `<!-- masterplan-shim: v1 -->` sentinel pattern is reusable.** Shim recognition in check #25 is now keyed on a versioned sentinel. Future shim versions (`v2`, `v3`) can carry their own sentinel and check #25 can be extended to recognize them without changing the md5-comparison logic for non-shim files. The versioning is already in the sentinel name.

- **Back-to-back same-day releases in one session require explicit retro separation.** v2.9.1 (auto-compact nudge) and v2.10.0 (CD-9 enforcement) are distinct releases with distinct scopes. Their retros are written as separate artifacts. The risk of conflating them is real because they share a session date, a session context, and the WORKLOG page — keep the slug anchor (`cd-9-enforcement` vs `auto-compact-nudge`) as the primary disambiguation key.
