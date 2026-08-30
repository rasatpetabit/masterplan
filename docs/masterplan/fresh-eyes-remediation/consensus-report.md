# Consensus review report — fresh-eyes-remediation spec

**Phase:** consensus (final adversarial review of the spec revision package)
**Subject:** `spec.md` revisions r1–r7 + the cross-cutting review lenses
**Panel:** cross-vendor adversarial review (3 voters per finding)
**Baseline under review:** goals hash `sha256:82ec8e64…3232bdde` (post-amend),
spec.md @ 2026-08-29T16:24, events.jsonl through the `goal_amended` event.

## Outcome

- **Survived:** 13 findings
- **Discarded:** 0

All 13 findings that reached the panel survived (11 unanimously at 3/3, 2 at
majority 2/3). No finding was discarded. Two findings carry forward non-blocking
nits (a precision gap on the "behaviorally neutral" wording and a traceability
gap on F-item IDs) — both are one-line spec edits, neither is a correctness
defect, and neither blocks wave 1.

## Surviving findings

### r1 — B2 covers 5 drifted bundles incl. blocked-task-injection (3/3)
VERIFIED. spec.md:46 lists all five bundles explicitly and correctly names
blocked-task-injection's hash WARN as independent of B1's ERROR. Cross-checked
against live `node bin/doctor.mjs` output and the two distinct code paths
(`lib/doctor/goals.mjs:118-127` WARN vs `:161-234` ERROR). Justification for
survival: the independence claim is the load-bearing premise that lets B1 and B2
proceed in parallel with wave 1 — it is accurate against both code and live
doctor output, so the parallelization is sound.

### r2 — A2 repoints to bounded-edit, builder/writes:true (3/3)
VERIFIED PRESENT. spec.md:33 repoints `FABRIC_DEFAULT_CLASS` to the existing
`bounded-edit` class (`policy/workflow-map.json:282-292`), matching the
implementer semantic. The rejected-`planned-execution` rationale is correct (it
is a non-writing judge class), and exactly 5 test files pin the dead name (the
6th hit is a report, not a test). Justification for survival: the repoint is to
a real, writing-capable class and the test-fix list is exhaustive and verified.
**Non-blocking nit carried forward:** `bounded-edit.cap='edit'` vs
`unknown.cap='chat'` — the `cap` flows into the spawn record's `capability` field
(`lib/dispatch-wave.mjs:123,170`) and WILL change value for unpinned tasks, but
no gating consumer reads `capability` (recorded only), so runtime routing is
genuinely neutral. The spec's blanket "behaviorally neutral" wording should read
"behaviorally neutral for routing (no gating consumer reads cap); the spawn
record's capability field changes chat→edit, recorded only."

### r3 — B1 decoupled from A1 via `mp record-goal-check` (2/3)
VERIFIED. spec.md:48-49 and the assumptions table (spec.md:129-130) both state
B1 uses `mp record-goal-check`, a fully separate code path
(`bin/masterplan.mjs:1293`) from the finish-step case (`:3540`); grep of the
case body for `finishStep`/`lib/finish-step` returns 0 matches. A1's finish-step
gate is a different path that currently omits `goalCheck`/`goalsChoice` from the
ctx. Justification for survival: the decoupling is real in code, so B1 can
genuinely proceed in parallel with wave 1 without waiting on A1's wiring.

### r4 — A1 names ctx-threading explicitly (3/3)
VERIFIED. spec.md:31 states the ctx currently omits `goalCheck`/`goalsChoice` on
its way to `finishStep()`, so parseArgs recognition alone would leave the gate
silently no-op. Matches code exactly: `bin/masterplan.mjs:3572-3601` constructs
the call without those fields; `lib/finish-step.mjs:681-682,719` declares them
null and `:290-299,:536` reads them. The named-vocabulary targets
(`--goal-check=<failed>` / `--goals-choice=<fix|waiver|abort>`, `GOALS_CHOICES`)
are accurate (`lib/finish-step.mjs:101`), and the dead-flag list
(`--goals-met/--goals-unmet/--manual-verdict/--goals-waived/--waiver-reason`) is
confirmed unimplemented in bin (0 matches). Justification for survival: naming
the ctx-threading step prevents the gate from silently no-op'ing after the flag
wiring — the most dangerous silent-failure mode in the bundle.

### r5 — A7 adds positive implementation cross-check test + G5 amendment (3/3)
VERIFIED. spec.md:40 (A7) adds the positive cross-check test; goals.md:31 (G5
evidence) is amended to require BOTH fail-closed tests AND known-flag
recognition. The amendment rationale (events.jsonl `goal_amended` event) calls
this "strengthening, not weakening." G5 is now falsifiable in both directions.
The goals hash chain is fully consistent: canonical hash
`sha256:82ec8e64…3232bdde` matches events.jsonl's `goals_hash`, state.yml's
`goals_md_hash`, and approval-goal-amend.json. Justification for survival: this
closes the G5 cheat-hole where "every flag is implemented" was only negatively
checkable — the single most important falsifiability fix in the revision
package.

### r6 — A8 names both derivation sites (3/3)
VERIFIED. spec.md:37 names both sites with line refs — capture
(`lib/continue.mjs:533-536`, today `path.resolve(wt.WT,'../..')`) and consumption
(`lib/wave-commit.mjs:298-306`, today `path.dirname(MAIN)`) — and states the two
compute different roots even on a fleet host, so both must share the one
derivation. Cross-checked: the two derivations are genuinely different. The
assumptions table (spec.md:135-136) restates the same fix consistently.
Justification for survival: naming both sites prevents a half-fix where only
one site is corrected and the two roots continue to diverge off-fleet.

### r7 — in-flight migration note added to A2 (3/3)
VERIFIED. spec.md:33 ("so no in-flight bundle changes lane") and assumptions
(spec.md:125-127) state no in-flight lane migration. Cross-checked against all
bundle state files: every execute-phase bundle has all tasks `status='done'` —
no pending/in-progress task remains that would route through
`FABRIC_DEFAULT_CLASS`. Justification for survival: the neutrality claim holds
in practice against the live bundle inventory, so the repoint cannot disturb a
running wave. (Carries forward the same `cap` precision nit as r2.)

### COVERAGE LENS — every audit-findings.md A-F item dispositioned (3/3)
VERIFIED with ONE traceability nit. A1-A9 in Wave 1, B1-B5 in Wave 2, C1-C10 +
D1-D4 in Wave 3, E1-E12 in Wave 4 prose, all by ID. F1/F2/F3 are NOT referenced
by their F-IDs anywhere in spec.md (grep for `F[0-9]+` returns empty), but ARE
dispositioned in prose: F1/F2 in wave 5 step 1, F3 via B5. The audit itself
labels section F "Harmless local clutter (report only)" so the prose
disposition is faithful. Justification for survival: no audit item is dropped or
double-booked — the sweep is complete. **Non-blocking nit carried forward:** add
a one-line ID reference ("F1/F2: deleted in step 1; F3: via B5") to match the
ID discipline applied to A-E.

### ACCURACY LENS — spec claims vs actual code (3/3)
VERIFIED across all 10 spot-checked claims: bounded-edit class definition
matches word-for-word; `mp record-goal-check` exists and is independent; A1 dead
flags unimplemented in bin; A7 parseArgs silently accepts any `--flag`; A4
`recover_from_blackboard` has no matching case; A5 record-result writes
"recorded" on `status==='pending'` regardless of `recRes.recorded`; A6
register-pi-agents triggers full write on any non-`--check` flag; A9 `mp status`
unguarded `readState`; C4 `finalizeRecord` defined but never called yet documented
as a live stage; E5 run-level contract absent from lib code but documented.
Justification for survival: every spec disposition matches the verified code
state, so the remediation plan targets real defects at the right sites.

### GOAL ENFORCEABILITY LENS — G1-G8 falsifiable, G5 cheat-hole closed (3/3)
VERIFIED. All 8 goals are individually checkable with named evidence signals:
G1 (sweep table + git log + retro deviations), G2 (`npm test` + per-defect
regression tests), G3 (`mp doctor` exit 0), G4 (CI green, Doctor step in
`.github/workflows/ci.yml:35`), G5 (amended — fail-closed tests AND positive
cross-check, falsifiable both directions), G6 (tag→push→marketplace→installed
version/sha), G7 (`ls` of repo root), G8 (E1-E12 corrected + wave-4 sweep
table). Justification for survival: every goal has a concrete, runnable
falsification signal — none is aspirational or unfalsifiable.

### CONSISTENCY LENS — assumptions vs wave tables vs cross-wave rules (3/3)
VERIFIED consistent, no contradictions. (a) A2 wave table and assumptions agree
on bounded-edit, 5 test files, neutral-vs-`unknown`, planned-execution
rejection. (b) B1/B2 agree on record-goal-check independence, 5-bundle coverage
incl. blocked-task-injection's hash WARN, parallel-with-wave-1. (c) A7 agrees on
fail-closed exit 2 + compat scan. (d) A8 agrees on dual-site derivation. (e) A1
agrees on bin-to-engine-vocab wiring incl. ctx threading + prompt rewrite. (f)
B4/B5 agree on no-retroactive-tags, one tag at wave 5. Justification for
survival: the three tables (wave, assumptions, cross-wave rules) do not
contradict, so no wave will execute against a stale or conflicting premise.

### EXECUTABILITY LENS — every wave item plannable into a bounded task (2/3)
VERIFIED. Wave 1 items A1-A9 each name a concrete code site (file:line) and a
concrete action with a known verification command (`npm test` + per-defect
regression test). Wave 2 B1/B2 are `mp` subcommand invocations (no code change),
B3 is a file relocation, B4 is a docs edit + one tag, B5 is a verify. Wave 3
C1-C10/D1-D4 each name a file and remove/retain/tighten action. Wave 4 E1-E12 are
in-place doc corrections. Wave 5 is a 4-step release sequence. The one
"decide during wave 3" item (C7 mp-adversarial-reviewer.md remove-vs-document)
is a bounded decision with a stated discriminator. Justification for survival:
every item is plannable as a bounded edit or bounded decision — no item is
open-ended or under-specified.

### NEW DEFECTS introduced by the revisions (3/3)
VERIFIED: NONE BLOCKING. Two minor non-blocking nits (the r2/r7 `cap` precision
gap and the COVERAGE-lens F-ID traceability gap), both closable with a one-line
spec edit each. No regression in coverage, accuracy, goal-enforceability,
consistency, or executability was introduced by the round-1 revisions.
Justification for survival: the revision package is a net improvement with no
new correctness defect — the only carry-forwards are precision/traceability
gaps, not behavioral regressions.

## Carry-forward nits (non-blocking, one-line spec edits)

1. **Precision (r2, r7):** Replace "behaviorally neutral" with "behaviorally
   neutral for routing (no gating consumer reads `cap`); the spawn record's
   `capability` field changes chat→edit, recorded only."
2. **Traceability (COVERAGE):** Add "F1/F2: deleted in step 1; F3: via B5" so
   the F items are findable by ID, matching the A-E discipline.

## Recommendation

The spec revision package is approved for execution. Both carry-forward nits
should be closed in the wave-1 landing (they are spec edits, not code), but
neither blocks wave 1 dispatch.