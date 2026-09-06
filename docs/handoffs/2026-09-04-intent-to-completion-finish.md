# Handoff — `intent-to-completion` FINISH STAGE (2026-09-04)

Successor to `docs/handoffs/2026-09-04-intent-to-completion-wave6.md` (whose §1–§3 rules —
env wrapper, `mp continue` wipe trap, one-subagent-per-turn, amendment procedure — all still
apply and are NOT repeated here).

## 1. Where the run stands

**ALL 48 TASKS DONE. The execute phase is COMPLETE.** `mp continue` now emits
`{"op":"run_skill","skill":"finish"}`. The `required_successor {slug: v10-validation}` event
is RECORDED (the pre-finish obligation from task 7's rows).

| Fact | Value |
|---|---|
| Run status | in-progress, phase execute (48/48 done), next op = finish skill |
| WT HEAD | `5ba9abc` (wave 10 code; tree CLEAN) |
| MAIN HEAD | `e573f71` (WORKLOG: 48/48) |
| Full suite | **2451/2451 — zero failures** (`env -u PI_CODING_AGENT CLAUDE_CODE_SESSION_ID=<id> npm test`) |
| Bootstrap stage | UNTOUCHED: all steps null, next=`rehearsal`, `finish_begun:false` (`node scripts/bootstrap-v10.mjs status --state=<MAIN>/docs/masterplan/intent-to-completion/state.yml`) |
| Session id (Guard D) | pass `--session=01a06a67-f929-794e-875e-c862aeb3f083` or `CLAUDE_CODE_SESSION_ID` |

Paths: `MAIN=/srv/dev/ras/masterplan`, `WT=$MAIN/.worktrees/intent-to-completion`,
`mp` = `node /home/ras/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/9.10.0/bin/masterplan.mjs`
(the PINNED v9 binary — the run must finish under v9 while it RELEASES v10).

## 2. What the finish stage does (per task 7's sequencer contract)

1. **Bootstrap pass 1** (the real v10.0.0 release), driven by
   `node scripts/bootstrap-v10.mjs` (arm/record per step; the driver enforces order,
   single-commit release discipline, pre-tag validation + tag rollback — all landed and
   tested this session):
   `rehearsal → docs_normalize → verify → review → assess → release (tag v10.0.0) → push →
   ci_wait → install_pi → main_push → publish_ack → pr_merge → claude_surface →
   surfaces_live → gate`.
   - `surfaces_live` must report the pass complete through BOTH running surfaces before
     `mp finish` starts (G6: installed AND executable, anchored version contract).
   - The `gate` step arms/records INSIDE branch_finish handling, BEFORE `--choice=merge`.
2. **`mp finish` / finish-step walk**: run_verify → implementation goal check
   (mp-goal-assessor, `implementation` mode) → write_retro → branch_finish → deploy steps →
   live check → final assessment (`record-goal-check --final` with the binding tuple) →
   intent_confirm → archive → push_archive.
3. **ALWAYS-HALT operator gates**: `publish_ack`, `branch_finish`, `push_archive`. The
   standing directive halts there — report and wait.

Version-bearing surfaces are ALREADY bumped to 10.0.0 (E13 test enforces consistency incl.
llms.txt). The release delta from the reviewed SHA must stay one CHANGELOG-only commit
(the driver's `releaseDeltaProblems` preflight enforces it; CHANGELOG needs its 10.0.0 entry
if not already present — check before arming release).

## 3. Corrections drill (if a step fails)

The bootstrap failure table is fully rehearsed in test/v9-to-v10-bootstrap.test.mjs (63
cases): red tag CI → 10.0.x corrective pass re-runs verify/review/assessment before release,
second PR without a second local-main push, G6 assessed at the LATEST version. Non-FF remote
→ fetch/audit/rebase/one-retry/stop (the push machinery from task 29). Follow the driver's
op output; never hand-edit state.

## 4. Session review-posture rules (still binding)

One review round per artifact; fix findings in scope; record honest verdicts. The review
ledger for the finish stage starts at zero; the bootstrap `review` and `assess` steps are the
run's own gates there.

## 5. After the run archives

- Build the operator-approved `review_round_cap` hook rule in `/srv/workflows/hooks/lib/rules/`
  (deferred since wave 5).
- The successor run `v10-validation` is already recorded as the required successor.
- Push MAIN + WT branches to origin (git remotes are the source of truth across hosts).

## 6. Traps recap (from this session, cost-real)

- Never `mp continue` over a WT holding unrecorded work (crash-scope reset wipes the scope).
- Record via `mp record-result` directly; after scope amendments re-freeze via the
  snapshot → amend → continue → reapply loop.
- Untracked fixtures MUST be in the declared scope before record (D6 `git clean` deletes
  them mid-transaction — the wave-9 incident).
- `git add` refuses tracked manifests under directory-level gitignore rules — fixed in
  .gitignore (file-level + re-includes); keep it that way.
- Builders cut off at the 30-min wall finish mid-sentence; their session JSONL holds the
  writes (`toolCall` entries) for byte-exact reconstruction.

---

**Filename:** `docs/handoffs/2026-09-04-intent-to-completion-finish.md`
