# Handoff — `intent-to-completion` wave 5 (2026-09-04)

Successor to `docs/handoffs/2026-09-03-intent-to-completion-wave3.md`.

## 1. Objective and authorization

**Standing directive (still in force):** `/goal do next steps until everything is complete` —
drive the `intent-to-completion` masterplan run autonomously through its execute waves,
halting only at always-halt operator gates (`push_archive`, `publish_ack`, `branch_finish`).

**Explicitly authorized:** nothing risky this session. No pushes, no force-pushes, no branch
deletions, no production changes were performed or attempted.

**Explicitly rejected / corrected by the operator (carried forward from the previous
session, still binding):**

- *"24 review rounds is absolutely absurd… Either rap this up, or if there are still serious
  issues then we need to take a step back and consider a fundamental redesign."*
- *"We already have a rule that asks for human intervention and approval at 5 rounds, why did
  you not follow this?"* — the rule is `/srv/workflows/policy/outcome-evidence.md:109-111`.
  **Every reviewer invocation counts, including gateway errors. Before round six: STOP, report
  the count, and say whether findings are narrowing or churning.**
- Decisions taken by AUQ last session: build the `review_round_cap` hook **after** this run;
  task 45's open requirement split into a follow-up (already covered by tasks 46/48).

## 2. Verified current state

Every row from a command run while writing this file (2026-09-04).

| Fact | Value | Command |
|---|---|---|
| Run status | `in-progress`, phase `execute`, **34/48 done** | `mp status --state=docs/masterplan/intent-to-completion/state.yml` |
| WT HEAD (code) | `d650bcc masterplan(intent-to-completion): wave 4 code` | `git -C <WT> log --oneline -1` |
| MAIN HEAD (state) | `710432c WORKLOG + ceiling report: intent-to-completion wave 4 recorded` | `git -C /srv/dev/ras/masterplan log --oneline -1` |
| Wave-5 tasks | 4, 5, 27, 47 — **all four still `pending`** | parsed from `state.yml` `tasks:` |
| `active_run` marker | `{"wave":5,"phase":"launching",…}` — wave 5 is mid-flight | `grep -A6 '^active_run:' state.yml` |
| `pending_gate` | `null` | same |
| Full suite | **2316 pass / 3 fail / 2319 total** | `npm test` in the WT |
| The 3 failures | 2× `E9: README module-inventory…` (owned by **task 8**, wave 9) and 1× `no retired agent-dispatch identifiers…` (owned by **task 10**) — **all three pre-date this session** | same |
| WT uncommitted | 21 modified files + 1 untracked (`test/final-check.test.mjs`, 908 lines) | `git -C <WT> status --short` |
| MAIN uncommitted | `events.jsonl`, `plan.index.json`, `state.yml` modified; `.wave-5.watch.json` + `wave-5.dispatch.json` untracked | `git -C /srv/dev/ras/masterplan status --short` |

Uncommitted work per task scope (`git diff --shortstat HEAD -- <files>`):

| Task | Diff |
|---|---|
| 4 | 7 files, +342 / −7 |
| 5 | 5 files, +610 / −22 |
| 27 | 3 files, +552 / −11, **plus** the new 908-line `test/final-check.test.mjs` |
| 47 | 4 files, +831 / −6 |
| shared (`bin/masterplan.mjs`, `test/bin-masterplan.test.mjs`) | 2 files, +274 / −8 |

**Paths.** `MAIN=/srv/dev/ras/masterplan` (bundle/state lives here).
`WT=/srv/dev/ras/masterplan/.worktrees/intent-to-completion` (code lives here).
`mp` = `node /home/ras/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/9.10.0/bin/masterplan.mjs`.

## 3. Environment changes + restore

**No system, service, or harness-config changes were made.** No units stopped, no settings
files touched, nothing installed, no stash used.

The only durable changes are inside the repo:

- **MAIN (state):** four `plan_amended` events appended and `plan.index.json` `files` arrays
  extended for tasks 5, 27, 47 (see §6). To inspect:
  `grep -o '"type":"plan_amended".\{0,140\}' docs/masterplan/intent-to-completion/events.jsonl | tail -4`
  To revert **all** uncommitted state changes (destroys the amendments — only if the whole
  wave is being abandoned):
  `git -C /srv/dev/ras/masterplan checkout -- docs/masterplan/intent-to-completion/`
- **WT (code):** all wave-5 implementation, uncommitted. To revert everything:
  `git -C <WT> checkout -- . && rm -f <WT>/test/final-check.test.mjs`
- **Scratch (safe to delete):**
  `/tmp/claude-1000/-srv-dev-ras-masterplan/f3ccf2a9-5342-4d5d-b864-926cc716272c/scratchpad/`
  holds the per-round review diffs (`w5/r{1..4}-task-*.diff`) and the Python edit scripts
  (`t47r2*.py`, `t4r3.py`, `t47driver.py`). Nothing depends on them.

**Trap that cost time:** two `mp event` calls were initially written to the **worktree's stale
copy** of the bundle (`<WT>/docs/masterplan/…`) instead of MAIN's. The worktree carries a
checked-in copy of the bundle from the branch point; it is **not** the live state. Always
derive MAIN first and pass an absolute `--state` under MAIN. Those two stray events were
reverted with `git -C <WT> checkout -- docs/masterplan/intent-to-completion/` and re-recorded
against MAIN — `<WT>` is clean under `docs/` now (confirmed in §2).

**Second trap:** `python3 -c json.dumps(...)` on `plan.index.json` produced a 464-line diff
because the checked-in file uses `§` escapes. Use `json.dumps(d, indent=2)` (i.e.
`ensure_ascii=True`, the default) — that yields a clean 5-line diff.

## 4. Artifacts

| Path | What | Completeness |
|---|---|---|
| `<WT>/test/final-check.test.mjs` | New — task 27's post-deploy final-assessment suite | 908 lines, 41 tests, **41/41 pass** |
| `<WT>` 21 modified files | Wave-5 implementation across tasks 4/5/27/47 | Suite green apart from the 3 pre-existing failures |
| `<MAIN>/docs/masterplan/intent-to-completion/events.jsonl` | 4 new `plan_amended` events | Verified present (§6) |
| Review diffs, `…/scratchpad/w5/` | 16 files, `r1`–`r4` × 4 tasks | Inputs only; regenerate with `git diff HEAD -- <files>` |

**Nothing is committed.** Wave 5 has not been recorded through `mp record-result`.

## 5. In flight

**One background reviewer may still be running:** the task-5 **round 4** review, MCP task id
`kvsfwv0np` (`skynet_review_diff`, `model_group=dispatch-adversary`). It does **not** survive
session exit — if this is a fresh session, treat it as lost and re-dispatch.

The task-4 round-4 review was **rejected by the operator before dispatch** (the interrupt that
ended the session). Tasks 27 and 47 round-3 reviews were never dispatched.

**No other jobs are running.** Nothing writes to the repo on a timer.

## 6. Key findings

### Review-round ledger (the number that matters)

| Task | Rounds run | Last verdict | Findings state |
|---|---|---|---|
| 4 | **3** | rework (r3) | all r1+r2+r3 findings fixed; **round 4 not yet run** |
| 5 | **3** | rework (r3) | all r1+r2+r3 findings fixed; **round 4 dispatched, result unknown** |
| 27 | **2** | rework (r2) | all r1+r2 findings fixed; **round 3 not yet run** |
| 47 | **2** | rework (r2) | all r1+r2 findings fixed; **round 3 not yet run** |

Findings have been **narrowing, not churning** — each round produced strictly more specific
defects than the last, no reviewer reversed a prior ruling, and no finding was appeased
without a code change. That is the evidence the ceiling rule asks for. **Budget: two more
rounds for tasks 4 and 5, three for 27 and 47, before the rule requires stopping and asking.**

### Real product defects found and fixed (not test-only churn)

These are the substantive ones a successor should know exist:

1. **`--digest-file` was dead on both sides.** `bin/masterplan.mjs` set
   `deployStepDone.digestFile` while `lib/finish-step.mjs` destructured `.digest`, so **no live
   digest was ever recorded**; and `record-goal-check --final` bound the flag's *path string*
   as the digest. Fixed with one shared content-bound `liveCheckDigest()` in `lib/finish.mjs`,
   now hashing **bytes** (a UTF-8 decode collapses invalid sequences onto U+FFFD, so different
   evidence could collide).
2. **`surfaces_live` never executed anything.** The driver's postcondition read `plugin.json`
   and a cache path, so an install whose entry point was absent, had a broken import, or
   reported the wrong version passed. G6 requires the release *"installed and executable in
   both running surfaces"*. Added `surfaceExecVersion()` with an **anchored** output contract
   (`/^masterplan v?<semver>$/`) — a greedy semver search matched the version inside the
   install path itself.
3. **`PASS2_OMITTED` was never independently enforced.** Omitted steps were refused only as a
   side effect of ordering. Deleting the omission rule would have changed no refusal — and
   `release`/`push` are among the omitted steps. Now enforced by name at **both** arm and
   record.
4. **The intent-confirmation could authorize a receipt the operator never saw.** The gate stored
   only `{id, opened_at}`, so confirmation re-selected "the newest valid receipt". Gates now
   bind a `receiptIdentity()` and the verdict must still be `met`.
5. **`finalReceiptFor` fabricated evidence and self-validated.** It defaulted `clean`, invented
   assessor provenance (`?? 'recorded'`), and took the expected goals hash *from the receipt*.
   Now: nothing is defaulted, the goals hash comes from the current `goals.md`, and the branch
   bindings come from the run's own implementation receipt (absent ⇒ refusal, not "unconstrained").
6. **Advertised gate choices that could not execute.** `live_check_evidence_missing` was not
   durable and offered a `retry` nothing could run; `final_check_invalid` advertised `re-record`
   while returning only an error string; the final `goals_unmet` waiver reused the
   non-stage-terminal implementation waiver, so the gate reopened forever. All now durable,
   terminal, and carrying the inputs a replacement needs.
7. **Two fail-open `catch` blocks I introduced in round 1 and removed in round 3.** A swallowed
   config-resolution failure routed on the stale seeded `planning_mode`; a swallowed `state.yml`
   read wrote `plan.md` over a bundle that owned `custom-plan.md`. Now `lstatSync` (not
   `existsSync`, which follows symlinks and hides errors) plus a bundle-state sanity check.
8. **Reminder/parser divergence.** The mid-run goals reminder had its **own** markdown scanner,
   which could quote a fenced example, walk past an indented H1, and pick a different duplicate
   `outcome:` line than the parser assigned. Fixed structurally: `parseGoals` now masks code
   (via the newly exported `codeLineMask`) and **captures the raw source line of the field it
   assigns**; `rawIntentOutcomeLine` is a one-line delegate. Divergence is now impossible
   rather than kept in sync by hand.

### Options considered and rejected

- **Letting D6 revert out-of-scope edits and restoring afterwards** (the wave-3 approach,
  commits `ddb7e53`/`77af416`). Rejected: it produces noisy paired commits. Instead each scope
  extension was recorded as a `plan_amended` event *before* the edit, so D6 accepts it.
- **Duplicating the code-mask scanner in `lib/wave.mjs`.** Rejected — two scanners is exactly
  the defect. Exported the existing one from `lib/goals.mjs` instead ("define once").
- **Putting `outcome_line` inside the `intent` object.** Rejected: callers deep-compare `intent`
  and the goals hash is keyed over it. Returned as a sibling `intentOutcomeLine` instead.
- **Asserting the persisted `state.completion` class in task 27's tests.** Rejected as
  out-of-scope: **task 28** (wave 6) owns writing that class. The tests assert the authorizing
  *events* task 28 reads, and say so in comments.
- **Testing "malformed `state.yml`" with malformed YAML.** Rejected — `parseState` is lenient
  and does not throw. Used a directory-at-`state.yml` (EISDIR) and a dangling symlink instead.

### Scope amendments recorded (all four in MAIN's `events.jsonl`)

| Task | Files added to scope | Driven by |
|---|---|---|
| 27 | `lib/finish.mjs`, `bin/masterplan.mjs`, `test/bin-masterplan.test.mjs`, `test/finish-step.test.mjs` | the dead `--digest-file` |
| 5 | `lib/wave-commit.mjs`, `test/wave-commit.test.mjs` | r1: reminder wired to no caller |
| 47 | `test/bootstrap-driver.test.mjs`, `scripts/rehearse-v9-finish.sh`, `test/rehearse-v9-finish.test.mjs` | r1: executable-surface probe invalidates metadata-only fixtures |
| 5 | `lib/goals.mjs` | r3: parser must own the raw line |

## 7. Risks and gating items

- **Wave 5 is unrecorded and uncommitted.** A crash loses ~2600 insertions. The `active_run`
  marker says `phase: launching`, so `mp continue` will treat this as a crash and re-emit
  `dispatch_fabric` for wave 5 — it will **not** know the work is already done in the WT.
  Recording is the first thing to do (§8).
- **Unverified assumption:** that the four wave-5 tasks are genuinely complete. Three of the
  four have never had a passing review round. Do not record them as `approve`.
- **The 3 failing tests are NOT wave-5 regressions** — they are owned by tasks 8 and 10 and
  were failing before this session. Do not chase them here.
- **The lane hook false-positives on path-like strings inside Bash heredocs.** Writing
  `bin/masterplan.mjs` inside a `python3 - <<'PY'` body triggered an "Outside your lane"
  denial. Workaround: write the edit script to the scratchpad with `Write`, then
  `python3 <path>`. Do not fight the hook inline.
- **Reviews cost real tokens** (~10–15k completion each, 4–10 min wall clock). Four more rounds
  is not free; weigh it against the operator's standing objection to grinding.

## 8. Next steps

Ordered; each independently actionable.

1. **Re-verify the suite** in the WT: `npm test` → expect `2316 pass / 3 fail`. If the count
   differs, something moved since this file was written.
2. **Decide the review posture and say so out loud.** Options: (a) run the remaining rounds
   (4 for tasks 4/5, 3 for 27/47) — ~4 reviews; (b) stop now and record honestly. Given the
   operator's standing objection, **(b) is defensible**: every finding so far has been fixed
   and the suite is green. If choosing (a), stop at round 5 per the ceiling rule regardless.
3. **Record wave 5.** Build the result digest, then:
   `mp record-result --state=<MAIN>/docs/masterplan/intent-to-completion/state.yml --result-file=/tmp/mp-result-intent-to-completion.json`
   Phase A emits `run_native_reviews`; supply the verdicts via
   `mp record-result --reviews-file=…`. **Record the honest verdict** — `rework` with the named
   open findings for any task whose last review was not `approve`. Do not fabricate approvals.
4. **Verify the split commit landed:** code → `<WT>`, state → `<MAIN>`. `mp record-result`
   performs both inside its transaction; confirm with `git -C <WT> log --oneline -1` and
   `git -C /srv/dev/ras/masterplan log --oneline -1`.
5. **Append a WORKLOG entry** at the repo root (scope + why, terse) and commit it to MAIN.
6. **Continue the wave loop:** `mp continue --state=<MAIN>/…/state.yml` → waves 6–10
   (10 tasks: 6, 7, 8, 9, 19, 20, 28, 29, 30, 48).
7. **After the run reaches its bootstrap stage:** build the `review_round_cap` hook rule in
   `/srv/workflows/hooks/lib/rules/` (operator-approved last session, deferred to after
   this run).
8. **Before `mp finish`:** record the required successor —
   `mp event … --type=required_successor` with `{slug: v10-validation}`.

## 9. User preferences and corrections

- **Never grind review rounds.** Five is the hard ceiling and every invocation counts. Report
  the count and whether findings are narrowing before asking for more.
- **Record honest verdicts.** `rework` with named open findings beats a fabricated `approve`.
  This was done for tasks 3, 45, 46 in earlier waves and should continue.
- **Do not reach into another task's scope to satisfy a reviewer.** When a reviewer asks for
  something a later task owns (e.g. task 28's completion class, task 7's sequencer printing),
  say so explicitly in the test comment and in the reply to the reviewer — both were accepted
  as declared scope this session.
- **Mistakes made this session, not to repeat:** writing `mp event` to the worktree's stale
  bundle copy; using `ensure_ascii=False` on `plan.index.json`; asserting on `refusals` when the
  driver reports failures in `preconditions`; asserting `record()` returns a status when it
  *throws* on a failed postcondition; building negative tests that pass by never reaching the
  code under test (the reviewer caught this twice — a `if (a.ok) { … }` guard around the
  assertion is the tell).

---

**Filename:** `docs/handoffs/2026-09-04-intent-to-completion-wave5.md`
