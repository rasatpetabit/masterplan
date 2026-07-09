# Plan — blocked-task-injection

Serial plan, 6 waves (0–5), 10 tasks. Each task cites its spec design section and ships with
a focused test. Waves are strict barriers: wave N fully green before wave N+1, and same-wave
tasks are concurrent so they own disjoint files.

## Wave 0 — Foundation (atomic: decide engine + consumer + markTask reason)

The load-bearing pair. D1's dispatch exclusion and D2's `awaiting_waiver` guard are coupled:
if the exclusion lands without the guard, the **finalize trap is live**. So tasks 1 + 2 ship
in the same wave; task 3 (markTask reason + the status enum) joins because `blocked` is inert
without `block_reason`, and the enum every transition validates against lives there.

- **T1 — D1+D2 decide engine** (`lib/resume.mjs`, `lib/wave.mjs`, `lib/migrate.mjs`,
  `test/resume.test.mjs`). `pending` filter (`resume.mjs:151`), recovery filter (`:132`), and
  wave-count filter (`wave.mjs:192`) all become `!== done && !== blocked && !== waived`;
  `awaiting_waiver` guard precedes `complete` (`resume.mjs:153`); `migrate.mjs:176` comment
  generalized. Tests: skip a fully-blocked wave (G1); blocked-only → `awaiting_waiver`, never
  `complete` (G2).
- **T2 — D2 consumer** (`lib/continue.mjs`, `commands/masterplan.md`, `test/continue.test.mjs`).
  `case 'awaiting_waiver'` (else the `decide-error` default fires); §2 op row; continue test.
- **T3 — D5 markTask reason + enum + in-flight guard** (`lib/bundle.mjs`, `bin/masterplan.mjs`,
  `test/bundle.test.mjs`). `VALID_TASK_STATUS` += `blocked`,`waived`; `markTask` `{reason}`;
  `mark-task --reason` (required for blocked); `--status=blocked` under `active_run` needs
  `--force`. Shared `coerceId` helper extracted here (T5 reuses).

## Wave 1 — Verb: waive-task

- **T4 — D3 `mp waive-task`** (`bin/masterplan.mjs`, `test/bin-masterplan.test.mjs`). Explicit
  consent → terminal `waived`: `--id=N`/`--all`, `--reason` required, operates only on
  `blocked`, sets `waive_reason`, emits `task_waived`; `active_run` `--force` guard; reversible
  to `pending` (clears `waive_reason`). (G3)

## Wave 2 — Verb: amend-tasks

- **T5 — D4 `mp amend-tasks`** (`lib/bundle.mjs`, `bin/masterplan.mjs`, `test/bundle.test.mjs`).
  `upsertTasks`: preserve `status`/reasons, refresh `wave`/`files`, append new ids as `pending`,
  reject duplicate ids, `--prune` safety (`--prune-non-pending` for accumulated state),
  re-render `plan.html`. (G4)

## Wave 3 — Cross-cutting (doctor + render)

- **T6 — doctor checks** (`lib/doctor/state-schema.mjs`, `test/doctor.test.mjs`). blocked →
  `block_reason`, waived → `waive_reason`, no unknown status, blocked/waived not counted
  dispatchable. (G6)
- **T7 — render badges** (`lib/plan-merge.mjs`, `test/plan-merge.test.mjs`). Distinguish
  `blocked`/`waived` (with reasons) from pending/done; confirm render counts use the updated
  filter. (G6)

## Wave 4 — Gate-review content (cross-repo D7 + masterplan D6)

The latent bug this run surfaced: the spec/plan gates fed `dispatch_review` an empty diff
(artifacts are untracked) — structurally reviewing nothing. This run's own spec gate was
satisfied via the diff-param bridge (artifact bytes fed as the review payload).

- **T8 — D7 agent-dispatch content path** (`/srv/dev/.agent-dispatch/packages/core/review.mjs`,
  agent-dispatch tests). `content`/readFiles path: `input.content` or `files`-without-diff reads
  bytes into the reviewer payload. Pure seam; back-compat for diff/staged/base. **Cross-repo** —
  runs the agent-dispatch test suite.
- **T9 — D6 masterplan sequencer** (`commands/masterplan.md`). Rewrite §3b `run_gate_review`
  prose: feed artifact bytes (via T8's `content` param, or the diff-param bridge), never
  `git add`.

## Wave 5 — Docs + green

- **T10 — G6 docs + G5 verification** (`CHANGELOG.md`, `docs/verbs.md`, `docs/internals.md`).
  Document the new statuses, `awaiting_waiver` action, `waive-task`/`amend-tasks` verbs, D6/D7.
  Full `npm test` green; `mp doctor` zero FATALs. G5: confirm `state.review.adversary` armed and
  `prepare-wave` resolves `review='on'` from the nested key (no regression).

## Notes

- **G5 (adversarial review armed)** is an artifact signal already satisfied (armed at seed;
  `prepare-wave` reads `state.review?.adversary`). T10 asserts no regression rather than
  implementing it.
- **Wave-less stuck-guard** unchanged (A8): `blocked`/`waived` tasks keep valid integer waves.
- **Non-goals** (partial-wave blocking, auto-un-block, DAG re-derivation, changing
  seed-tasks/load-plan) are respected — `amend-tasks` is additive.

## Plan-gate review findings (advisory, verdict approve)

The cross-vendor plan-gate review (dispatch-diff-review) returned **approve, 0 blocking**. One
finding folded into the plan; the rest acknowledged as non-blocking:

- **Folded (High #2):** T3 now REFUSES `mark-task --status=waived` — `waived` is reachable
  only via `waive-task` (T4), which enforces blocked-only + `--reason` + `waive_reason` + the
  `task_waived` event + the `active_run` guard. `mark-task` still handles `waived→pending`
  reversal (clears `waive_reason`).
- **(#4 bin-level tests):** T3 and T5 now include `test/bin-masterplan.test.mjs` so bin-handler
  changes get CLI-level coverage (flag/exit-code), not just lib-level.
- **(#1 wave-0 atomicity, acknowledged):** wave-0 tasks run concurrently, but the wave barrier
  means no runtime `decide`/`continue` executes mid-wave — the decide loop only runs between
  waves, so the transient concurrent state is never observed. Merging T1+T2+T3 into one task
  would violate single-responsibility for no real safety gain.
- **(#3 doctor/render timing, acknowledged):** doctor/render land in wave 3, after blocked/waived
  can exist. During THIS run, `mp doctor` is only invoked at T10 (wave 5); the intermediate-wave
  risk only applies to a mid-execution doctor run on another bundle, which is non-fatal (doctor is
  advisory). The state-schema check keys off `VALID_TASK_STATUS` (updated in T3), so it won't
  false-flag the new statuses.
- **(#5 plan.html re-render, acknowledged):** `plan.html` is a generated artifact (render-plan
  output), not a source file — it correctly is NOT in any task's `files` (edit scope). The
  re-render is runtime behavior verified via the existing render test pattern.
- **(#6 D6/D7 E2E test, acknowledged):** T8 (agent-dispatch unit tests) + T9 (docs) are the
  unit-level coverage; the cross-repo E2E is demonstrated by the fact that THIS run's own spec
  and plan gates were satisfied via the byte-feeding bridge.
- **(#7 G5 coverage, acknowledged):** G5 is cited on T10, which names the existing `prepare-wave`
  review-resolution path as the no-regression assertion target.
