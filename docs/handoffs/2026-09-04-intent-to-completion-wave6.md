# Handoff — `intent-to-completion` waves 7–10 (2026-09-04)

Successor to `docs/handoffs/2026-09-04-intent-to-completion-wave5.md`. Waves 5 AND 6 are
RECORDED (41/48 done; w6 code `e938c8a`, state `b213f79`, WORKLOG `9443cde`). This file now
covers wave 7 (IN FLIGHT: task 29, builder async run `b0d58cf5`) and waves 8–10 (tasks 7, 8,
9, 19, 20, 30).

## 1. Objective and authorization

**Standing directive (still in force):** `/goal do next steps until everything is complete` —
drive the run autonomously through its execute waves, halting only at always-halt operator
gates (`push_archive`, `publish_ack`, `branch_finish`).

**Operator rulings that bind review posture:**
- Never grind review rounds. One review round per task per wave; fix concrete findings in
  scope; record the HONEST verdict (`rework` with findings-fixed disclosure); do NOT
  automatically launch another round. Count every invocation, including failures.
- Every reviewer invocation counts. Report the count before asking for more.

## 2. Verified current state (as of the fix-builder launch)

| Fact | Value | How to re-check |
|---|---|---|
| Run status | `in-progress`, phase `execute`, **38/48 done** | `mp status --state=docs/masterplan/intent-to-completion/state.yml` |
| WT HEAD | `7d926cf` (wave 5 code) + uncommitted wave-6 work | `git -C <WT> log --oneline -1` |
| MAIN HEAD | `a7f1178` (WORKLOG + ceiling note) | `git -C /srv/dev/ras/masterplan log --oneline -1` |
| Wave-6 tasks | 6, 28, 48 — all implemented, all still `pending` in state | `mp status` |
| Full suite | **2349 pass / 2352** — only the 3 pre-existing failures (E9 README ×2 = task 8, retired identifiers = task 10) | see §3 env wrapper |
| active_run marker | wave 6, `launching`, scope 8 paths (includes the amended `test/deploy-commit-identity.test.mjs`) | `grep -A2 '^active_run:' state.yml` |
| Review ledger wave 6 | task 6: 1 round (rework, fixed); task 28: 1 round (rework, fix in flight); task 48: 0 rounds | events.jsonl + §5 |

**Paths.** `MAIN=/srv/dev/ras/masterplan`. `WT=$MAIN/.worktrees/intent-to-completion`.
`mp` = `node /home/ras/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/9.10.0/bin/masterplan.mjs`.
Session id for Guard D (pass as `--session` or `CLAUDE_CODE_SESSION_ID`):
`01a06a67-f929-794e-875e-c862aeb3f083` (the Pi session that owns the bundle lock now).

**Wave-6 scope (frozen marker scope, 8 files):** `test/cli-surface.test.mjs`,
`bin/masterplan.mjs`, `lib/finish-step.mjs`, `test/intent-rejected.test.mjs`,
`test/finish-replay.test.mjs`, `test/v9-to-v10-bootstrap.test.mjs`,
`scripts/bootstrap-v10.mjs`, `test/deploy-commit-identity.test.mjs` (the last one via a
recorded `plan_amended` + `amend-tasks` — task 24's old ordinary-keep assertion contradicted
task 28's §7.4 semantics).

## 3. Environment traps (READ FIRST — each cost real time)

- **Test wrapper (mandatory on this Pi host):** CLI-spawning tests need
  `env -u PI_CODING_AGENT CLAUDE_CODE_SESSION_ID=<any-id> <cmd>`. Without it: ~5 spurious
  failures (owner-guard exit 1 vs 2; codexSuppressed serial path). With it the suite is
  2349/2352 as above. `test/cli-surface.test.mjs` now passes BARE too (explicit `--session`),
  but the rest of the repo still needs the wrapper.
- **`mp continue` wipes the worktree** when the marker is `phase: launching` (crash-scope
  reset, `lib/continue.mjs:318-336`, `git checkout --` + `git clean -fd` of the declared
  scope). Wave 5 lost its uncommitted work this way (recovered from diffs + transcript).
  **NEVER run `mp continue` while the WT holds unrecorded work.** To refresh scope after an
  amendment: snapshot (`git diff HEAD > snap.diff` + copy untracked), amend, `mp amend-tasks`,
  run `mp continue` (deliberate wipe + re-freeze), re-apply snapshot. This is the
  operator-approved path.
- **Per-task files live in BOTH plan.index.json AND state.tasks[].files** — `prepareWave`
  refuses divergence. After editing plan.index.json run
  `mp amend-tasks --state=… --plan-index=…`.
- **One subagent call per turn** (harness rule). Plan launches accordingly.
- **The builtin `breaker` agent is slice-gated** (one file, ≤40 lines, output cap) — do NOT
  use it for task reviews. Use the repo's registered **`mp-adversarial-reviewer`** agent
  (breaker role, adversary lane, CD-10 digest) with `model: litellm/gpt-5.6-sol`, one task
  per launch, sequential.
- `plan.index.json` edits: `json.dumps(d, indent=2)` with `ensure_ascii=True` (default).

## 4. Wave-6 outcome (recorded; pattern to repeat per wave)

All three tasks recorded with honest `rework` verdicts: ONE review round per task
(`mp-adversarial-reviewer`, model `litellm/gpt-5.6-sol`, one launch per turn, sequential),
then ONE builder fix round per task fixing every finding in scope, then record with the
blocking finding naming the true residual ("fixes never verified by a second round").
No second review round — operator's no-grinding directive.

Wave-6 review results (3 invocations, 3 rework verdicts, all findings fixed): task 6 —
record-goal-check --final dead-forwarding fixed in bin (bindings were written by the
validator but dropped by the writer) + 40-case bare-clean matrix; task 28 — six findings
(discard→deploy-replay leak, split-write rejection, non-idempotent answers, attestation
split window, wrong-base confirmation, empty test) all fixed in lib/finish-step.mjs;
task 48 — driver release preflight + tag rollback, independently-reachable single_commit,
§7.4-shaped doctor fixtures. Full suite at record time: 2357/2360 (3 pre-existing, tasks 8/10).

Two scope amendments followed the advisor-approved snapshot/amend/re-freeze/reapply path
(task 28 += deploy-commit-identity consumer; task 48 += bootstrap-driver consumers).

**Wave 7 (in flight):** task 29 (post-archive push_archive state; lib/finish-step.mjs +
test/finish-replay.test.mjs). Builder briefed to build on the §0.6 patterns. On delivery:
verify (finish-replay + intent-rejected + full suite with the §3 wrapper), then ONE review
round, one fix round if needed, then record per §5 with wave 7 / token
`mp-wave-intent-to-completion-w7-a1` / diffs in a fresh /tmp dir.

## 5. Recording wave 6 (after task 48's review)

1. Verify suite: `env -u PI_CODING_AGENT CLAUDE_CODE_SESSION_ID=mp-w6-verify npm test` →
   expect only the 3 pre-existing failures.
2. Rebuild `/tmp/mp-result-intent-to-completion-w6.json` from live evidence (script shape is
   in this session; wave 5's file
   `/tmp/claude-1000/.../scratchpad/mp-result-intent-to-completion-w5.json` is the schema
   reference: `{wave, wave_token, tasks:[{task_id, digest:{task_id,status,summary,blockers,verify}}]}`;
   `wave_token` = `mp-wave-intent-to-completion-w6-a1`).
3. Phase A: `mp record-result --state=…/state.yml --result-file=…` → emits
   `run_native_reviews` + fresh `diff_sha`s.
4. Build `/tmp/w6-reviews.json` keyed by task id ("6","28","48"): honest records
   (`final_verdict`, `findings`, `blocking_findings[{reviewer,summary,proof}]`, `summary`,
   `harness{degraded:false,…}`). Shape reference: wave-4's
   `/tmp/claude-1000/.../scratchpad/w4-reviews.json` and this session's `/tmp/w5-reviews.json`.
   Task 6 and 28: `rework` with the named residual "post-review fixes never verified by a
   subsequent round" (+ what the rounds found and fixed — see §4). Task 48: its actual
   verdict.
5. Phase B: `mp record-result --state=… --result-file=… --reviews-file=/tmp/w6-reviews.json`.
   Expect `recorded:[6,28,48]`, `reverted:[]`, `scope.ok:true`, split commits
   (code→WT, state→MAIN). **Do NOT run `mp continue` before this (§3).**
6. Append WORKLOG entry (top of the 2026-09-04 section) + commit MAIN (include
   `wave-6.dispatch.json` if dirty).
7. Next: `mp continue` (WT now clean, marker cleared) → wave 7 … wave 10 (remaining tasks:
   7, 8, 9, 19, 20, 29, 30). Same cycle per wave: `mp continue` → `mp dispatch-wave` →
   builders (async, one subagent call per turn, `model: litellm/glm-5.2`, briefs from the
   spawn plan + the env-wrapper note) → verify → ONE reviewer round per task → fix →
   record.

## 6. After the execute waves

- After the bootstrap stage: build the operator-approved `review_round_cap` hook rule in
  `/srv/workflows/hooks/lib/rules/` (deferred from an earlier session).
- Before `mp finish`: `mp event … --type=required_successor` with `{slug: v10-validation}`.
- The 3 pre-existing suite failures (tasks 8/10) should disappear when those tasks land in
  waves 7-10 — do not chase them early.

## 7. User preferences (carried forward)

- No grinding review rounds; honest verdicts beat fabricated approvals.
- Do not reach into another task's scope to satisfy a reviewer — declare it instead
  (the task-24 consumer update was justified as the §7.4 semantic change's own consumer,
  recorded via plan_amended BEFORE the edit).
- Reviews cost real tokens; builders are cheaper than review rounds — prefer one thorough
  builder fix round per review round.

---

**Filename:** `docs/handoffs/2026-09-04-intent-to-completion-wave6.md`
