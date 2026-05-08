# v2.3.0 cost-leak — second documented recurrence (petabit-os-mgmt, 2026-05-05)

## Status

Pending. Informational retrospective from a downstream installation. No
upstream action required unless the maintainer wants to adopt the README
install-version note suggested at the end.

## Context

v2.3.0's CHANGELOG documents the original recurrence as *"a real 2-day
/masterplan-heavy session consumed 94% Opus ($458 of $487)."* This file
records a second concrete case observed in a downstream installation that
was running pre-v2.3.0 dispatch logic, to confirm the fix's diagnosis was
correct and surfaces in the wild.

## Observed failure

- **Repo:** petabit-os-mgmt (private; greenfield commercial NOS work, JUNOS-class CLI engine)
- **Plan:** Phase 4 — CLI engine MVP (28 tasks, 8 complete at observation)
- **Session:** `7ab0c990-b4e5-4df1-82f4-c4d37dd11fb2` — `~5h` runtime under `/loop /masterplan ... --autonomy=loose`
- **Installed masterplan version:** ~v2.2.x (1332 lines vs upstream v2.4.1 1601)

Token usage tally extracted from `~/.claude/projects/<project-id>/<session>.jsonl`:

| Model | Messages | Output tokens | Cache-read input | Cache-create input |
|---|---|---|---|---|
| `claude-opus-4-7` | 756 | 885,345 | 95,253,634 | 4,655,517 |
| (no other models) | 0 | 0 | 0 | 0 |

Agent dispatches: 6 total, all to `codex:codex-rescue` (out-of-process —
not Anthropic-billed). Zero Haiku/Sonnet implementer subagents fired.
Both per-task `AskUserQuestion`s (T7, T8) presented a binary
`Inline / Codex` framing — Sonnet leg never on the menu.

## How v2.3.0 + v2.4.0 + v2.4.1 fix this

- **Agent dispatch contract** (`commands/masterplan.md:203` upstream):
  would have structurally required `model:` on every implementer
  dispatch site, including the ones the pre-v2.3.0 code had as
  prose-only suggestions.
- **Recursive override at Step C step 2** (`commands/masterplan.md:768`):
  SDD's inner Task calls would have carried `model: "sonnet"` regardless
  of the orchestrator's parent context (Opus).
- **Per-subagent telemetry** (`<plan>-subagents.jsonl` from
  `hooks/masterplan-telemetry.sh`): the cost-distribution health metric
  (`opus_share = sum(opus_tokens) / sum(all_tokens)`; healthy `< 0.1`,
  regression `> 0.3`) would have read `1.0` for this session, surfacing
  the regression at end-of-turn rather than after a manual diagnostic
  pass.
- **/masterplan stats** (Step T, v2.4.0): would have produced a routing
  distribution table with one tap, instead of requiring a 50-line Python
  one-liner against the raw transcript JSONL to surface the same data.

## Recommendation for upstream

Two small, optional README adjustments:

1. **Install instructions could mention the post-v2.2.x version
   requirement explicitly.** Older installations exhibit the cost-leak
   invisibly until a `/masterplan stats` invocation surfaces the
   distribution. A one-line "install ≥ v2.3.0; older versions silently
   route everything to the orchestrator's parent model" near the top of
   the README install section would have caught this faster.
2. **A minimal post-install sanity check** could run
   `/masterplan stats --plan=<any>` after first kickoff and warn if
   `opus_share > 0.5`. Catches the failure mode for users who forget
   to update.

Neither suggestion is load-bearing. The v2.3.0 fix is correct and
sufficient as shipped; this note is just dogfooding evidence.

## Generalizable lesson

The dispatch failure is invisible to the user during the run. The
orchestrator continues to "work" — tasks complete, commits land,
status file updates — while costing 5–10× the design intent in
tokens. The only signal is the bill or a deliberate diagnostic. v2.3.0
+ v2.4.0 close that visibility gap structurally; before then, the
failure mode could persist for arbitrarily long sessions across many
plans without triggering any obvious symptom. Worth keeping the lesson
documented (as the changelog already does) — and arguably worth a
section in the public README, not just in the changelog, since
changelogs are typically read at upgrade time and not at first-install.
