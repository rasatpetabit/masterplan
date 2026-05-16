# p4-suppression-smoke — Retrospective

**Date:** 2026-05-16
**Status at retro:** complete
**Complexity:** low
**Duration:** 2026-05-13 → 2026-05-15

---

## What this was

A verification smoke bundle designed as the release gate for `docs/masterplan/p4-suppression-fix/` (v4.1.1). Its sole purpose was to confirm that v4.1.1's per-state-write `TaskUpdate` priming actually suppresses the harness `<system-reminder>` injection during Step C wave execution, not just in theory.

Three deliberately trivial no-op tasks. The artifact being measured was not the tasks themselves but the per-turn `smoke_observation` events logged during execution.

## Result: PASS

The single `smoke_observation` event recorded shows:
- `reminder_fired: false`
- `preceding_state_write: true`
- `last_task_update_age_turns: 0`

The grading command (`grep '"preceding_state_write":true' | grep -c '"reminder_fired":true'`) returns 0. The TaskUpdate priming mechanism works as designed.

v4.1.1 shipped on the back of this smoke passing.

## What worked

- Keeping the tasks as pure no-ops removed confounding variables. The only behavior under test was the suppression mechanism, not the work.
- The mandatory observation contract (absence of `smoke_observation` = verification failure) prevented silent pass. Every turn had to affirmatively log.

## What didn't work

- One `step-trace-gap` anomaly was logged during execution (visible in `anomalies.jsonl`). It was recorded by the Stop hook's failure instrumentation framework and queued for upload. It did not affect smoke correctness — the grading criterion passed — but it indicates the step-trace breadcrumb was absent or malformed on at least one turn.
- The `events.jsonl` was wiped pre-v5.1.1 via the telemetry-wipe manifest. The wipe preserved work product but removed historical context that would have been useful for the anomaly investigation.

## Lessons learned

- Smoke bundles need the same stop-hook instrumentation coverage as production plans. The anomaly shows the harness can still fire unexpected behavior even in minimal exercise scenarios.
- `anomalies-pending-upload.jsonl` should be drained before marking a bundle complete. The flush was skipped here; the pending record surfaced in doctor check #38 as a dangling artifact.

## Open items

- The queued anomaly in `anomalies-pending-upload.jsonl` can be flushed via `bin/masterplan-anomaly-flush.sh` when convenient. It's a reporting artifact, not a correctness regression.
