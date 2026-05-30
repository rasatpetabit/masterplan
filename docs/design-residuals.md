# Design residuals — for user ruling (dogfood-mining campaign, 2026-05-30)

The forced-missing-writer hand-edit axis (Issues A–G) is **mined out**: two transcripts that
exercised real lifecycle — `commercial-license-lock` (brainstorm→plan→dispatch-wave-0) and the yanos
`phase-37-hardware-bringup-v1` run (execute→recover→complete→archive) — are both **dry**. Every
forced hand-edit maps to a writer A–G added; `events.jsonl` was never hand-edited in a run that
genuinely executed/recovered/completed.

What remains are **two residuals that are NOT the A–G class** (neither is a hand-edit *forced* by a
missing writer in a supported path). Each touches a **deliberate design choice**, so each is the
user's call, not a unilateral fix. This memo is for that ruling.

---

## Residual 1 — events auto-emit: **CLOSED on re-verification (recommend: keep, no action)**

**Prior claim (now corrected):** an earlier WORKLOG entry said "the spec wires **zero** `mp event`
emission." **That was wrong** — the grep missed the giant verb-table row at `commands/masterplan.md`
L143.

**Accurate state at tip:**
- The spec **does** wire events: L143 pairs each phase transition with
  `mp event --state=<path> --type=phase_transition --phase=<new>`, and adds a catch-all *"Log other
  lifecycle milestones with `mp event --type=<event> [--phase=… --note=… --data=JSON]`."*
- `mp event` (→ `appendEvent`, `lib/bundle.mjs:90`) has always existed; `appendFileSync` is atomic,
  so there is **no** read-modify-rewrite hazard.
- **Resume never reads `events.jsonl`.** `decideNextAction` is disk-derived from `state.yml`'s
  structured fields only. The sole consumer of `events.jsonl` is `stats` (L150, a `jq` roll-up). A
  missing event therefore degrades **telemetry/audit**, never resume correctness — it can **not**
  cause data loss or a wrong resume.
- The full-lifecycle yanos run **never raw-appended** an event. No forced raw-append exists at tip.

**The only thing still open** is the Issue-E design choice: mutating writers (`mark-task`,
`open-gate`/`clear-gate`, `set-active-run`/`promote`/`clear`, `set-status`) **do not auto-emit** a
companion event — non-phase events are left to the orchestrator's milestone-catch-all *discretion*.
Issue E chose this deliberately ("no auto-event; the shell pairs `mp event`").

**Options:**
- **(1A) Keep — recommended.** No code. `mp event` exists, the spec routes the orchestrator to it,
  resume is event-independent. Just correct the WORKLOG record (done this turn).
- **(1B) Name the specific non-phase events in the §2/§2a execute protocol** (`gate_opened`/`cleared`,
  `task_done`, `wave_dispatched`) so they aren't left to discretion. *Non-reversing* prose polish;
  optional, not a bug fix.
- **(1C) Auto-emit inside each writer.** **Reverses Issue E.** Couples writer to logging, risks
  double-emit when the shell also calls `mp event`. Not recommended — solves a non-problem.

---

## Residual 2 — sub-5.0 bundle: post-`migrate-bundle`-refusal behavior is unspecified **(OPEN)**

**Observed in wild (yanos phase-37):** the bundle was schema-3. `mp migrate-bundle` **deliberately
refuses pre-5.0 loudly** (`lib/migrate.mjs` L198–207 throws; header L10 *"pre-5.0 is REFUSED loudly
(R3)"*; the original is preserved). The operator then **raw-`Write`-rebuilt** `state.yml` to schema-6
— a CD-7 violation.

**Why it's NOT the A–G class:** the campaign class is a hand-edit *forced by a missing writer in a
SUPPORTED path*. Spec §2 step-2 wires `migrate-bundle` for the **`migrated:true`** path **only** and
says **nothing** about the refusal case (`commands/masterplan.md` L52–67). So on a sub-5.0 bundle the
*designed* behavior is **refuse + preserve + human decides**; the raw rebuild was an **off-spec
CHOICE in a deliberately-unsupported path**, not a missing-writer-forced edit.

**The real (small) gap:** spec §2 step-2 is **silent** on what to do *after* a refusal. That vacuum is
what the raw rebuild filled.

**Options:**
- **(2A) Keep the floor + wire post-refusal guidance — recommended.** Add to §2 step-2: *"If
  `migrate-bundle` refuses (pre-5.0), do NOT raw-rebuild `state.yml`. Either treat the legacy bundle
  as read-only reference and `mp seed` a FRESH schema-6 bundle for continued work, or stop and ask
  the user."* Optionally a `doctor`/`mp` nudge that detects a sub-5.0 bundle and prints this. Closes
  the CD-7-violation vacuum **without reversing the floor**. Cost: prose + maybe a tiny guard; **no**
  schema-migration code, **no** floor change.
- **(2B) Lower the floor — reversing, heavy.** Implement a 3.x→6 transform in `migrate.mjs`. Reverses
  the deliberate R3 decision; must write+test the transform; risky precisely because pre-5.0 schemas
  diverge (the reason the floor exists). Only worth it if sub-5.0 bundles are common **and** their
  history must be preserved.
- **(2C) Status quo.** Rely on the CD-7 prohibition (L10) to deter raw rebuilds; leave the
  post-refusal path to operator discretion. Leaves the vacuum; a future operator may raw-rebuild
  again (as phase-37 did, and even committed it).

**Recommendation: 2A** — honors the deliberate floor, closes the observed CD-7-violation vacuum with a
non-reversing prose-wire (+ optional doctor nudge), zero schema-migration risk. Shippable as a real
(small) Issue H if you approve; would be honestly labeled **observed-in-wild (off-spec-choice
vacuum), same-class-preventive fix**.

---

### CENSUS UPDATE (2026-05-30) — corrects the record; reconciles the user's 2B ruling against evidence

The user ruled **2B** (lower the floor) on the AUQ framing of "a clean 3.x→6 transform." A full census
across **every** masterplan tree under `/srv/dev` + `/home/ras` (4 grep sweeps) changes the calculus —
in both directions — and the net swings back to **2A**:

**Population (the part that justifies acting at all):**
- **~85 sub-5.0 bundles total** (schema **2 and 3**) — a large real population, NOT a one-off.
- **8 are IN-PROGRESS** — the data-loss-sensitive ones, where an operator hitting `migrate-bundle`'s
  refusal will raw-rebuild (the phase-37 CD-7 violation). The harm is **live and recurring**:
  - `yanos-os/{2026-04-29-update-storage-architecture(s2,blocked), mgmt-kernel-pkg-prereqs(s3,executing),
    os-config-layer-with-mgmt(s2,executing), z9264f-rauc-ab-update(s3,brainstorming)}`
  - `petabit-portals/{m11-approvals, m12-hierarchy, m15-cutover}` — all s2, `planning`
  - `agents/taxes-agent/sales-tax-agent` (s2, `executing`)

**Why 2B cannot deliver its promised value for ANY live bundle:**
1. **Zero of the 8 in-progress bundles carry `plan.index.json`.** Tasks live nowhere machine-readable.
   So 2B salvages only the header scalars and then hits Issue G's loud throw (`phase:execute` +
   `tasks:[]`) — tasks must be reconstructed by hand from `plan.md` regardless. **2B degrades to 2A's
   exact outcome** for every real case (the phase-37 case proved this; the census generalizes it).
2. **The phase field is inconsistent free-text** — `blocked / executing / brainstorming / planning /
   execution / complete` — none matching the v8 enum `{brainstorm,plan,execute}`, and inconsistent
   even within a schema version. A faithful map is a fragile per-value guessing game; `blocked` has no
   clean v8 equivalent. This is the precise "pre-5.0 schemas diverge" failure the R3 floor refuses.
3. **schema spans 2 AND 3.** "Lower to 3" covers only 2 of the 8 in-progress; covering all 8 means
   lowering to schema-2 — doubling the divergent-schema surface for a transform that still can't resume.

**Why 2A is the stronger close given the census:**
- It is **schema-agnostic** — one prose-wire (+ optional doctor nudge) protects ALL ~85 bundles and ALL
  8 in-progress ones, regardless of schema 2 vs 3 or the phase-vocabulary zoo.
- It closes the CD-7-violation **vacuum** that actually caused the phase-37 harm, **without reversing**
  the deliberate floor and **without** writing a fragile divergent-schema migrator.
- The net of 2B is: high cost + high risk, partial coverage (2 of 8), and a resume outcome identical
  to 2A's. The census makes 2B's cost/benefit strictly worse, not better.

**Net recommendation after census: 2A** (was already 2A pre-census; the evidence now reconciles the 2B
ruling against the data). Re-surfacing to the user for a final go/no-go rather than silently switching.
