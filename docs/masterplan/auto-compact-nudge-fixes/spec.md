---
slug: auto-compact-nudge-fixes
date: 2026-05-06
status: shipped
target-version: v2.9.1
---

# Auto-compact nudge wording fix + validator + cron-attachment doctor check

## Background

The orchestrator's auto-compact nudge (Step B3 + Step C step 1, line ~606 of `commands/masterplan.md`) currently reads:

> *(Recommended: pair this run with `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` in another shell or session for automatic context compaction. Set `auto_compact.enabled: false` in `.masterplan.yaml` to silence this notice.)*

Three problems surfaced in a 2026-05-06 brainstorm (see `docs/superpowers/plans/curious-coalescing-rose.md` Phase C):

1. **"in another shell or session" is backward.** `CronCreate` jobs (which is what fixed-interval `/loop` uses internally — confirmed by the harness's documented `<<autonomous-loop>>` vs `<<autonomous-loop-dynamic>>` sentinels) are session-scoped. The cron fires into the session that *created* it. If the user runs `/loop 30m /compact …` in shell B, it compacts shell B (which has no `/masterplan` context), not the `/masterplan` session A. The nudge advises the opposite of what works.

2. **Silent degrade-to-dynamic-mode.** If `config.auto_compact.interval` is empty/null/missing while `auto_compact.enabled == true`, the substituted command becomes `/loop /compact …` (no interval) — which routes through `ScheduleWakeup`, the dynamic-mode path. `ScheduleWakeup` re-enters as model-side text rather than harness-intercepted input, and built-in slash commands (including `/compact`) cannot be invoked by the model via the Skill tool (which excludes built-ins). Result: the loop fires every wakeup but compacts nothing. The default interval is `30m` so this is unlikely in practice, but undetectable when it happens.

3. **Unconditional firing wastes cycles on low-context sessions.** The cron fires `/compact` every 30 minutes regardless of current context size. There is *no* clean way to make the firing conditional from outside the session — the harness has no `/compact-if-context-above-X%` form, and the model can't gate built-ins (Skill tool excludes them). Users on shorter plans pay for compactions they don't need. Brainstorm landed on **disclose the tradeoff in the nudge text** rather than restructure the mechanism — same cadence, more honest wording.

Mechanism critique that turned out NOT to be a problem: fixed-interval `/loop 30m /compact` does correctly fire built-in compaction. The harness intercepts cron-delivered slash commands at message-receive time. The mechanism is fine; only the *wording* and *guardrails* need work.

## Goals

- **G1.** Replace the misleading "in another shell or session" wording with text that (a) tells the user to run the loop in the same session as `/masterplan`, and (b) discloses the unconditional-firing tradeoff so users can self-select shorter intervals or opt out for short plans.
- **G2.** Add a config validator that catches the silent degrade-to-dynamic-mode case at Step 0 config-load time, before the nudge is ever rendered.
- **G3.** Add a doctor check (`auto_compact_loop_attached`, next number after #25) that verifies a `/compact` cron is actually attached to the current session when the user has been nudged and `auto_compact.enabled` is on.
- **G4.** Ship as a single coherent v2.9.1 patch. No behavior change unless user opts out (default cadence stays 30m).

## Non-goals

- **N1.** Changing the `/loop … /compact` mechanism itself. Switching to direct `CronCreate`, `/schedule`, or a custom skill was considered and rejected (no benefit; same scope).
- **N2.** Adding a "skip if context low" gate. The constraint analysis (Background problem 3) shows there is no external gating path. Any "smart" loop is structurally impossible.
- **N3.** Changing CC-1 (line 1910). The symptom-triggered nudge already works correctly; this spec leaves it alone.
- **N4.** Lengthening the default interval (Option A in the brainstorm). User explicitly chose to keep 30m and disclose the tradeoff in text instead.
- **N5.** Dropping the nudge entirely (Option B in the brainstorm). User chose to keep it; gentler proactive smoothing is valued for longer plans.

## Change 1 — Wording (Step B3 + Step C step 1, line ~606)

**Replace:**

```
*(Recommended: pair this run with `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` in another shell or session for automatic context compaction. Set `auto_compact.enabled: false` in `.masterplan.yaml` to silence this notice.)*
```

**With:**

```
*(Recommended: pair this run with `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` in this same session. Note: this fires `/compact` every {config.auto_compact.interval} regardless of current context size, which may run unnecessary compactions on shorter plans. Set `auto_compact.enabled: false` in `.masterplan.yaml` to silence; consider `60m` or `90m` via `auto_compact.interval` for reduced waste.)*
```

Changes:
- `"in another shell or session"` → `"in this same session"` (correctness)
- New disclosure sentence: "this fires `/compact` every {interval} regardless of current context size, which may run unnecessary compactions on shorter plans"
- Silence guidance retained; new tuning hint added: "consider 60m or 90m via auto_compact.interval for reduced waste"

The interval value is interpolated twice now (once in the command snippet, once in the disclosure sentence). Both come from the same `config.auto_compact.interval` so they stay in sync.

## Change 2 — Config validator (Step 0, after merge, ~line 1853)

The flag-conflict warnings section already has one rule for `codex_routing` × `codex_review`. Add a second rule:

> - `auto_compact.enabled == true` AND `auto_compact.interval` is empty/null/missing — the substituted command would degrade to dynamic-mode `/loop` which cannot fire built-in `/compact`. Skip the kickoff/resume nudge for this run and warn:
>
>   `⚠️ auto_compact.enabled is true but auto_compact.interval is empty — auto-compact nudge skipped. Set a non-empty interval (e.g. "30m") to re-enable.`

Implementation: 1 added bullet to the existing warnings block. Does NOT abort. Sets an in-memory flag (`auto_compact_nudge_suppressed`, naming follows the existing `competing_scheduler_keep` precedent at line ~803) that the kickoff/resume nudge logic reads to skip rendering. The flag is per-session, not persisted to status frontmatter.

## Change 3 — Doctor check `auto_compact_loop_attached`

Add to the doctor section as **check #26**, **repo-scoped** (same pattern as #25 — runs ONCE per doctor invocation regardless of worktree/plan count, since `CronList` returns session-level state, not per-plan state). Update the parallelization brief at line 1460 to reference both repo-scoped checks (#25 and #26) rather than #25 alone. The plan-scoped count (currently 24) is unchanged.

**When it runs:** every `/masterplan doctor` invocation. Skips silently if not in a project with plans.

**Trigger:** any plan in `docs/superpowers/plans/*-status.md` has `compact_loop_recommended: true` in its status frontmatter AND `config.auto_compact.enabled == true` (after Step 0 merge). If neither condition holds, skip — there's nothing to verify.

**Implementation:**

1. `ToolSearch(query="select:CronList")` to load the deferred tool's schema. If unavailable, emit a single-line note (`auto_compact_loop_attached check skipped — CronList tool unavailable in this session`) and return. Mirrors the competing-scheduler check pattern in Step C step 1.
2. Call `CronList()` and read the returned entries.
3. Filter for entries whose `prompt` field contains `/compact` (case-sensitive substring match, like the existing competing-scheduler basename match at Step C step 5).
4. **If zero matches:** emit warning finding:
   ```
   ⚠️ auto_compact_loop_attached — plan(s) <slugs> were nudged to enable /loop /compact, but no matching /compact cron is attached to this session. Did you run the /loop command in a different shell? Run it in THIS session to enable, or set `auto_compact.enabled: false` to silence the nudge.
   ```
   `<slugs>` is a comma-separated list of plan slugs whose status files have `compact_loop_recommended: true`.
5. **If ≥1 match:** emit info finding (or skip silently — doctor convention is silent on success):
   ```
   ✓ auto_compact_loop_attached — /compact cron attached to this session.
   ```

**Severity:** Warning (not error). User may have intentionally skipped the loop after seeing the nudge. The check just disambiguates "did you mean to and forget?" from "you intentionally opted out".

## Files to modify

| File | Lines | Change |
|---|---|---|
| `commands/masterplan.md` | line ~606 | Wording change (Change 1) |
| `commands/masterplan.md` | line ~1853 | Add validator bullet (Change 2) |
| `commands/masterplan.md` | doctor section (where #25 lives) | Add check #26 (Change 3) |
| `commands/masterplan.md` | doctor parallelization brief | Update check count to N+1 |
| `CHANGELOG.md` | top | New v2.9.1 entry |
| `WORKLOG.md` | bottom | Append dated entry per convention |
| `.claude-plugin/plugin.json` | version field | `2.9.0` → `2.9.1` |
| `.claude-plugin/marketplace.json` | version field | `2.9.0` → `2.9.1` |

Per CLAUDE.md (top anti-pattern #4), all three sync'd locations and the doctor parallelization-brief count must be updated together.

## Verification

After implementation:

1. **Wording smoke test.** `grep -n "another shell or session" commands/masterplan.md` → 0 matches. `grep -n "this same session" commands/masterplan.md` → 1+ matches.
2. **Validator behavior.** Run `/masterplan brainstorm test` with `~/.masterplan.yaml` containing `auto_compact: { enabled: true, interval: "" }`. Expect: warning emitted, kickoff nudge NOT rendered.
3. **Doctor check positive case.** In a session running `/masterplan execute <slug>` after kickoff, type `/loop 30m /compact focus on …`. Wait for cron registration. Run `/masterplan doctor`. Expect: no `auto_compact_loop_attached` finding (or info finding only).
4. **Doctor check negative case.** In a session that saw the nudge but didn't run the loop, run `/masterplan doctor`. Expect: warning finding listing the plan slug.
5. **Doctor check graceful degrade.** In a session where `CronList` schema isn't available (no equivalent tool surfaced), run `/masterplan doctor`. Expect: single-line note, no error.
6. **Backward compat.** Existing plans without `compact_loop_recommended` field in status: doctor check skips silently. Existing plans with `compact_loop_recommended: false`: doctor check skips silently.
7. **Plugin manifest sync.** `grep '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json` → both show `"2.9.1"`.

## Open questions

None. Wording confirmed verbatim by user via AskUserQuestion preview. Validator and doctor scope settled in the same brainstorm.

## Backward compatibility

- Existing `.masterplan.yaml` files: no schema change. Empty/null `auto_compact.interval` was previously silent failure; now warns and skips.
- Existing plans: status frontmatter unchanged. The new doctor check reads existing `compact_loop_recommended` field which has been present since the auto-compact nudge was introduced.
- No migration. Pure additive change to the orchestrator prompt.
