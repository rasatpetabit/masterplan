# A7 Compatibility Preflight Scan — fresh-eyes-remediation Wave 0 Task 1

## Methodology

Static analysis of the documented `mp` surface against the current `bin/masterplan.mjs`
implementation, in the worktree at HEAD `c7a7353`.

**Sources scanned:** `commands/masterplan.md` (648 lines), `docs/verbs.md` (245 lines),
`skills/masterplan/SKILL.md`, `skills/masterplan-detect/SKILL.md`,
`.github/workflows/ci.yml`, `hooks/hooks.json`.

**Implementation baseline:** `bin/masterplan.mjs` — 72 `case '<verb>'` blocks (lines 842–3743),
plus `bin/doctor.mjs` (standalone script, not an `mp` verb) and `bin/register-pi-agents.mjs`.

**Method per item:**
1. Extract every `mp <verb>` and every `--flag` from inline code spans and prose in the doc sources.
2. For each verb, locate `case '<verb>'` in `bin/masterplan.mjs`.
3. For each documented flag, check whether that verb's case block **consumes** the flag:
   `need(flags, 'x')`, `flags['x']`, or `flags.x` **inside the case block**. Note `parseArgs`
   (bin/masterplan.mjs:537-550) collects ANY `--flag` silently, so collection ≠ recognition —
   the verb must read it.
4. Classify: `RECOGNIZED` | `FLAG-DROPPED` | `VERB-MISSING` | `AMBIGUOUS`.

**Important negative results (checked and cleared):**
- `--codex-suppressed` / `--no-workflow` are consumed via `shouldSuppressWorkflow(flags, env)`
  (bin/masterplan.mjs:822-830), called at `continue` (3443) and `finish-step` (3528) — **RECOGNIZED**,
  not dropped (my regex missed function-mediated consumption).
- `acquire-owner --force`, `set-review-config --review` / `--routing` are consumed in shared
  case blocks (3615-3640, 2464-2516) — **RECOGNIZED**.
- `finish-step --head` / `--base` are **op-payload fields** (`{head, branch, base, …}` in the
  §2c table), not CLI re-invoke flags — **not flags**, excluded.
- `--assessment-file` (record-goal-check) is documented but the verb instead requires the
  tuple `--head-sha --base --diff-hash --receipt` (or `--waiver`+`--waive`); see FLAG-DROPPED below.
- `mp doctor` (verbs.md:26) has no `case 'doctor'`; `node bin/masterplan.mjs doctor` exits 2
  ("unknown subcommand"). Real entry is `node bin/doctor.mjs` (ci.yml:35). See VERB-MISSING.

## Classification summary

| Class | Count |
|---|---|
| RECOGNIZED | 51+ (verified) |
| FLAG-DROPPED | 6 genuine |
| VERB-MISSING | 1 (mp doctor) |
| AMBIGUOUS | 0 |

## FLAG-DROPPED (verb exists, documented flag never consumed by that verb)

### finish-step — goal-gate answer flags (A1 — the dead goal-gate path)
Documented at commands/masterplan.md:241 and :247 as finish-step re-invoke flags. **None are
consumed** by the finish-step case (bin 3540-3600):

| Flag | Doc site | bin consumption | Severity |
|---|---|---|---|
| `--goals-met` | commands/masterplan.md:241 | 0 matches in bin | HIGH |
| `--goals-unmet` | commands/masterplan.md:241 | 0 matches in bin | HIGH |
| `--manual-verdict` | commands/masterplan.md:241 | 0 matches in bin | HIGH |
| `--goals-waived` | commands/masterplan.md:247 | 0 matches in bin | HIGH |
| `--waiver-reason` | commands/masterplan.md:247 | 0 matches in bin | HIGH |

Root cause (verified): `bin/masterplan.mjs:3572` calls `finishStep({...})` with
`verify/review/docs/choice/pushed/removalForce/retroOnly` but **omits `goalCheck` and
`goalsChoice`** from the ctx. The engine (`lib/finish-step.mjs:681-682,719`) declares
`goalCheck = null | 'failed'` and `goalsChoice = 'fix'|'waiver'|'abort'` (GOALS_CHOICES at
:101, gate logic at :290-299,:536) but the CLI never threads them. The docs' `--goals-met/
--goals-unmet/--goals-waived/--waiver-reason/--manual-verdict` vocabulary does not exist in
bin at all (0 matches for the 5 flags). `finish-step` has no `--goal-check`/`--goals-choice`
flags either. **Owning task: Task 2 (A1 goal-gate flag parsing + finishStep ctx threading).**

### record-goal-check — `--assessment-file` (documented, not consumed)
| Flag | Doc site | bin consumption | Severity |
|---|---|---|---|
| `--assessment-file` | commands/masterplan.md:241 | 0 matches in bin | HIGH |

The doc teaches `mp record-goal-check --state=<...> --assessment-file=<scratch>`. The actual
verb (bin 1293-1492) requires `--head-sha --base --diff-hash --receipt` (check mode) or
`--waiver --waive` (waiver mode); `--assessment-file` is never read. An operator following the
doc gets `die('record-goal-check: missing required --receipt')`. **Owning task: Task 2 (A1 —
the run_goal_check doc in commands/masterplan.md:241 will be rewritten when A1 lands) + the
record-goal-check doc in that same §2c row. Task 8 (B1) uses the real tuple-bound receipt, so
this is a doc-vs-bin contract fix, not a code addition.**

## VERB-MISSING (documented verb with no case)

### `mp doctor`
- Doc site: docs/verbs.md:26 — "`mp doctor` check `rejected-idea-kb` validates file shape".
- Implementation: `node bin/masterplan.mjs doctor` → exit 2 "unknown subcommand: doctor".
  The doctor is `bin/doctor.mjs`, invoked as `node bin/doctor.mjs` (ci.yml:35). No `case
  'doctor'` exists and no alias routes `mp doctor` → `bin/doctor.mjs`.
- Severity: MED (a documented `mp` verb that silently errors; under strict A7 parsing this
  would surface as exit 2, which is "fail-closed" but the *doc* names a non-existent verb).
- **Owning task: Task 24 (E1/E2/E8 CLI contract surfaces) — replace `mp doctor` with
  `node bin/doctor.mjs` in verbs.md:26, OR add a `doctor` alias in bin if the fleet wants
  `mp doctor` to work. No existing task names this explicitly — it becomes part of Task 24's
  "keep every documented invocation valid under A7 strict parsing".**

## RECOGNIZED (verified consumed — representative set)

All of the following documented verb→flag pairs are consumed by their case blocks:

- `seed`: `--state --slug --topic --complexity --autonomy --planning-mode --adversary-review
  --codex-review --fabric --predecessor --predecessor-transcript --render-images --force
  --owner-lock --phase --status`
- `set-phase`: `--state --phase --force`
- `load-plan`: `--state --plan-index --plan-md --plan-html`
- `record-gate-review`: `--state --gate --status --review-json --digest-file --receipt
  --count --reason --summary --ts --base`
- `goals-load`: `--state --goals --approval --ts` (note: `--approval` is **required** by
  `need(flags,'approval')` at bin:1049, but commands/masterplan.md:438 documents
  `mp goals-load --state --goals` **without** `--approval` — **E2 doc gap**; see below)
- `goals-amend`: `--state --goals --reason --approval`
- `record-goal-check`: `--state --head-sha --base --diff-hash --receipt --waiver --waive
  --verify-output-hash --dirty --ts`
- `record-result`: `--state --result-file --result --reviews-file --reconcile --worktree --now`
- `continue`: `--state --codex-suppressed --no-workflow --review --routing --repos-allowlist
  --alive --dead --stale-reconciled --ttl-ms --force --now`
- `finish-step`: `--state --verify-passed --verify-failed --choice --removal-force --pushed
  --review-skipped --review-reason --review-done --review-count --review-base
  --review-digest-file --docs-normalized --docs-count --docs-skipped --docs-reason
  --docs-suppressed --retro-only --ttl-ms --force --now` (all EXCEPT the 5 goal-gate flags)
- `event`: `--state --type --phase --note --note-file --summary --data --ts`
- `waive-task`: `--state --all --id --reason --force`
- `open-gate` / `clear-gate`: `--state --id --opened-at` / `--state`
- `set-active-run` / `promote-run` / `clear-active-run`: `--state --kind --wave --baseline
  --scope --ws-baseline` / `--state --run-id --task-id` / `--state`
- `worktree`: subcommands `plan|record|reconcile` consume `--state --repo-root --choice
  --disposition --branch --slug --worktree --existing --removal-confirmed` (nested cases)
- `refs`: `--state --direction --target --repo`
- `set-coord`: `--state --bootstrap --mark-published --mode --wave --base-sha --contract-ref
  --integration-branch --local-run-branch`
- `coord-status`: `--state --fail-if-unpublishable --fail-if-unconfigured`
- `pr-summary`: `--gh-json`
- `validate-plan-index`: `--plan-index`
- `render-plan`: `--state --plan-index --plan-html`
- `merge-plan-fragments`: `--fragments --out --plan-md --meta --generated-at`
- `set-review-config` / `set-codex-config` (alias): `--state --review --routing`
- `set-render-config`: `--state --images`
- `set-status`: `--state --status`
- `mark-task`: `--state --id --status --reason --force`
- `amend-tasks`: `--state --plan-index --prune --prune-non-pending`
- `set-discovery`: `--state --repo-root --add-root --remove-root`
- `runs`: `--repo-root --roots`
- `migrate-bundle`: `--state`
- `sweep`: `--state --repo-root --apply`
- `decide`: `--state --alive`
- `status`: `--state`
- `set-active-run` etc. (above)

## E2 — `goals-load --approval` documentation gap (verified)

`goals-load` **hard-requires** `--approval` (bin:1049 `need(flags,'approval')`; also
goals-amend at :1245). The primary doc at commands/masterplan.md:438 documents
`mp goals-load --state=<path> --goals=<...>` with **no** `--approval`. An operator following
that invocation gets `die('goals-load: missing required --approval')`. This is a
**documentation gap** (missing required flag in the documented invocation), distinct from
FLAG-DROPPED (the flag IS consumed; the doc omits it). **Owning task: Task 24 (E2).**

## A3 — `--fabric=off` (verified doc-vs-impl)

`--fabric` IS consumed by `seed` (bin:892-895). The A3 finding is that the **documented
semantics** are stale: docs/verbs.md:245 and .okf/index.md:83 teach `--fabric=off` to "keep
the legacy wave path", but the legacy L2 path is deleted (lib/continue.mjs:179
`fabricActive = true; // L2 deleted`), so `--fabric=off` seeds an unexecutable run. This is a
**documented-vocabulary correctness issue** (flag exists and is parsed, but its documented
effect is a dead path), not a parse-drop. **Owning task: Task 2 (seed/bin) + Task 7
(dispatch-wave + docs/verbs.md + .okf).**

## Incompatible-caller list (documented surface that would break under strict parsing, or is already wrong)

| # | Doc site | Item | Class | Owning task |
|---|---|---|---|---|
| 1 | commands/masterplan.md:241 | finish-step `--goals-met` | FLAG-DROPPED (A1) | Task 2 |
| 2 | commands/masterplan.md:241 | finish-step `--goals-unmet` | FLAG-DROPPED (A1) | Task 2 |
| 3 | commands/masterplan.md:241 | finish-step `--manual-verdict` | FLAG-DROPPED (A1) | Task 2 |
| 4 | commands/masterplan.md:247 | finish-step `--goals-waived` | FLAG-DROPPED (A1) | Task 2 |
| 5 | commands/masterplan.md:247 | finish-step `--waiver-reason` | FLAG-DROPPED (A1) | Task 2 |
| 6 | commands/masterplan.md:241 | record-goal-check `--assessment-file` | FLAG-DROPPED | Task 2 (doc) / Task 8 (uses real tuple) |
| 7 | docs/verbs.md:26 | `mp doctor` | VERB-MISSING | Task 24 (E1/E2/E8) |
| 8 | commands/masterplan.md:438 | goals-load missing `--approval` | E2 doc gap | Task 24 |
| 9 | docs/verbs.md:245, .okf/index.md:83 | seed `--fabric=off` semantics | A3 stale doc | Task 2 + Task 7 |

**Items with NO existing owning task:** none of the above is orphaned — #7 (`mp doctor`) is the
closest (Task 24 must choose alias-vs-doc-fix), and #6's code path is Task 8's tuple receipt
while its doc lives in the §2c row Task 2 rewrites. No new task is required by this scan.

## Residual risk / AMBIGUOUS

- **0 AMBIGUOUS items.** The only heuristic calls were (a) `--codex-suppressed`/`--no-workflow`
  consumed via `shouldSuppressWorkflow()` — verified by reading the call sites; (b) shared
  case blocks (`set-review-config`/`set-codex-config`, `acquire-owner`/`heartbeat-owner`/
  `release-owner`) — verified by reading the block bodies.
- **`mp doctor` resolution is a fleet decision** (alias vs doc-fix); the scan records the fact,
  Task 24 owns it.
- The 5 goal-gate flags being FLAG-DROPPED is the highest-risk item — it is the A1 defect and
  is the one thing that silently degrades goals-enabled runs at finish.
