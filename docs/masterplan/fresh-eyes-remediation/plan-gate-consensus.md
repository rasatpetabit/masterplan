# Consensus plan-gate review report — fresh-eyes-remediation (round 3, final delta)

**Phase:** consensus (final adversarial review of the round-3 plan delta)
**Subject:** bundle `/srv/dev/ras/masterplan/docs/masterplan/fresh-eyes-remediation` —
the A6 alignment-audit amendment to task 32 (description + one added verify
command), reviewed against the round-2 digest baseline.
**Panel:** cross-vendor adversarial review (3 voters per finding)
**Baseline under review:** `plan.md` / `plan.index.json` post-A6 amendment;
`goals.md` hash `sha256:82ec8e64…3232bdde` unchanged.

## Outcome

- **Survived:** 11 findings
- **Discarded:** 0

All 11 findings that reached the panel survived. 8 were unanimous (3/3):
the gate-pass verdict, the verify-command count/content identity, the empty-
inventory edge case (blocked by the prior ID-presence gate), the IDs-vs-hex edge
case, the authoring-constraint implementation note, the no-regression
validate-plan-index result, the G1–G8 goal-coverage mapping, and the
no-other-task-changed delta check. 3 survived at majority (2/3): the amendment
present-and-consistent byte-equality, the idiom-logic rigorous verification, and
the final verdict line. No finding was discarded.

## Verdict

**GATE PASSES.** The A6 alignment-audit contraction from round 2 is fully
remediated. Task 32's description now enforces a validated path:line citation for
every inventory entry; the new verify idiom is present and byte-identical in both
`plan.md` and `plan.index.json`; the idiom's logic is sound across every required
edge case; and no regression was introduced in task count, wave structure, goal
coverage, file disjointness, or prose↔index consistency. The only item carried
forward is an **authoring constraint, not a gate defect**: the wave-5 executor
authoring `final-inventory.md` must not emit bare finding-IDs in section headers,
table-of-contents, or summary prose without an accompanying path:line, or the
strict A6 idiom will (correctly) fail.

## Surviving findings

### Gate-pass verdict (3/3)
VERIFIED. Round-3 adversarial plan-gate review (final delta check) passes. The
single A6 amendment to task 32 is present, correct, and consistent; the new
verify idiom is logically sound (empirically tested in `/tmp`); no regression in
structure, counts, goal mapping, or wave disjointness; all 32 task descriptions
match exactly between `plan.md` and `plan.index.json`.
*Justification for survival:* the top-level pass verdict is the load-bearing
decision; it is corroborated by every other surviving finding below rather than
asserted standalone.

### (A) Amendment present & consistent (2/3)
VERIFIED. Task 32 description in `plan.md:357` and `plan.index.json` (id 32,
~line 810) are **byte-equal**, both containing the A6 alignment clause
("every inventory entry must carry a validated path:line citation (A6
alignment)"). The clause is present on both surfaces.
*Justification for survival:* byte-equality across the two plan surfaces is the
contract the amendment was supposed to restore — confirmed present on both.

### (A) verify_commands count & content (3/3)
VERIFIED. Both surfaces carry exactly 12 `verify_commands` for task 32
(`plan.md:363-374` lists 12 backtick-wrapped entries; the JSON array has 12).
The set of 12 is sorted-equal between surfaces. The new idiom
`! grep -E '[A-F][0-9]+' docs/masterplan/fresh-eyes-remediation/final-inventory.md | grep -Ev '[A-Za-z0-9_./-]+:[0-9]+'`
is present verbatim in both (`plan.md:373` and `plan.index.json:835`).
*Justification for survival:* the count and the exact idiom text both match — the
remediation is real in content, not just in description.

### (B) Idiom logic (2/3)
VERIFIED RIGOROUSLY in `/tmp/a6test` under GNU grep (the execution environment).
The idiom negates the pipeline exit status: it PASSES (exit 0) iff every line
containing an `[A-F][0-9]+` token also contains a `path:line` token. Confirmed:
clean inventory → exit 0; one ID line lacking citation → exit 1 (FAIL, line
prints); mix of clean+dirty → exit 1 (FAIL, dirty line printed). The `!` binds to
the whole pipeline (POSIX), not just the first grep.
*Justification for survival:* the core mechanism the amendment introduces is
sound and does what the brief requires.

### (B) Edge case — empty inventory (3/3)
VERIFIED. Alone, the idiom returns exit 0 (vacuous pass) because grep1 finds no
match → pipeline exit 1 → `!` → 0. This is **not** a cheat-hole: task 32's prior
verify command (`for prefix_max in 'A 9' 'B 5' 'C 10' 'D 4' 'E 12' 'F 3'; do …
grep -q "$1$n" … || exit 1; done`) runs first and aborts at A1 on an empty file
(empirically confirmed, TEST 9/21). The combined gate cannot vacuously pass on
empty input — the A6 idiom is a strict superset check on top of the ID-presence
gate, exactly as the brief's "must not vacuously pass given task 32's prior
ID-presence verify" requires.
*Justification for survival:* the most dangerous potential hole (vacuous pass)
is provably closed by composition with the prior gate.

### (B) Edge case — IDs vs hex/version tokens (3/3)
VERIFIED. `[A-F][0-9]+` requires an uppercase A–F letter immediately followed by
a digit. `DEADBEEF` (D followed by E) does NOT match; `8.5.2` and lowercase hex
shas (`a1b2c3d4`) do NOT match (lowercase excluded). `ABC123`, `C3PO`, and
finding-IDs F1/F3 match as intended. A `path:line` with a pure-number path like
`42:5` matches `[A-Za-z0-9_./-]+:[0-9]+` and passes (acceptable, since the prior
ID-presence gate ensures those lines also carry finding-IDs). A bare `:42` (no
preceding path char) correctly fails the path:line regex and is flagged.
*Justification for survival:* the false-positive surface is bounded and matches
the intended semantics; no version/hex token is misclassified as a finding-ID.

### (B) Implementation constraint — strict A6 authoring rule (3/3)
VERIFIED. The idiom flags **any** line bearing an `[A-F][0-9]+` token that lacks
a `path:line`, including prose headers like `## A1–F3 Summary` or `Findings A1
through F3` (TEST 16/17 fail). This is the **intended** strict A6 behavior (every
finding-bearing line needs a citation), but it means the executing agent
authoring `final-inventory.md` must not put bare finding-IDs in section headers,
table-of-contents, or summary prose without an accompanying `path:line`.
*Justification for survival:* this is a real authoring constraint to surface to
the wave-5 executor, not a plan-gate defect — explicitly carried forward.

### (C) No regression — validate-plan-index (3/3)
VERIFIED. `node bin/masterplan.mjs validate-plan-index --plan-index=…plan.index.json`
returns `{"valid":true,"tasks":32}` exit 0. 32 tasks present (ids 1–32
contiguous). 6 waves present with counts: wave 0→1 (1), wave 1→6 (2–7), wave 2→4
(8–11), wave 3→12 (12–23), wave 4→8 (24–31), wave 5→1 (32). Total 32. Matches the
round-2 digest baseline.
*Justification for survival:* structural integrity is intact and the amendment
touched nothing outside task 32.

### (C) Goals G1–G8 mapping intact (3/3)
VERIFIED. `goals.md:13-41` defines G1–G8; every goal is covered by at least one
task (G1→all 32, G2→21 tasks, G3→{8,9,10,31,32}, G4→{8,9,32},
G5→{1,2,5,7,15,23,24,29,32}, G6→{11,32}, G7→{32}, G8→18 tasks). Task 32 covers all
eight goals G1–G8. No goal orphaned, no task missing goals.
*Justification for survival:* goal coverage is unchanged by the amendment and
task 32's all-eight-goal span is preserved.

### (C) No other task changed since round 2 (3/3)
VERIFIED. All 32 task descriptions match byte-for-byte between `plan.md` and
`plan.index.json` (0 mismatches). `verify_commands` sets match for all 32 tasks
(0 set mismatches, 0 count mismatches); the only order differences are tasks 24
and 32 — the same two the round-2 digest already flagged for the
heuristic-rendering ordering quirk; no new ordering drift introduced. Wave-4
file disjointness holds (8 tasks, 0 file collisions). Task 24 retains the round-1
E11 `mp-implementer` fix; task 32 retains the round-1 clean-tree fix
(`[ -z "$(git status --porcelain=v1)" ]`) alongside the new A6 idiom. The
amendment is scoped exclusively to task 32 (description + one added verify
command), as briefed.
*Justification for survival:* the delta is minimal and exactly scoped — no
silent collateral edits leaked into other tasks or waves.

### Verdict line — gate passes (2/3)
VERIFIED. The A6 alignment-audit contraction from round 2 is fully remediated:
task 32's description enforces `path:line` citations for every inventory entry;
the new verify idiom is present and identical in both surfaces; its logic is
sound across the required edge cases (empty inventory blocked by the prior
ID-presence gate; missing-citation lines caught; hex/version false-positives
avoided); no regression in task count, wave structure, goal coverage, file
disjointness, or prose↔index consistency. The only carry-forward is the
authoring constraint (not a gate defect): the wave-5 executor must not emit bare
finding-IDs in `final-inventory.md` headers/summaries without an accompanying
`path:line`, or the strict A6 idiom will (correctly) fail.
*Justification for survival:* the consolidated verdict reconciles every
surviving sub-finding into one pass/deny decision — PASS, with one explicit
non-blocking carry-forward.