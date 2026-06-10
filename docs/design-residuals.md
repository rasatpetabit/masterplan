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

## Residual 2 — sub-5.0 bundle: post-`migrate-bundle`-refusal behavior is unspecified **(RESOLVED — 2A shipped as Issue H, 2026-05-30)**

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

**OUTCOME (2026-05-30):** user approved the 2A pivot off 2B; **2A shipped as Issue H** — two additive,
schema-agnostic edits (`lib/migrate.mjs:26` `GUIDANCE` now leads with *"Do NOT hand-rewrite state.yml…
(CD-7 violation)"* + names the seed-fresh path; `commands/masterplan.md:55` §2 step-2 adds the refusal
branch). No floor change. See WORKLOG `## 2026-05-30 — Issue H SHIPPED — 2A`. **This residual is closed.**

---

## Residual 3 — Codex wave-execution scope: a **code-assumes-(a) vs product-commits-(b) mismatch** that the cutover surfaces **(RULED 3B 2026-05-30; foreground-sequential path DELIVERED 2026-06-10 — see the closing addendum)**

This is where the v7-audit B2 finding (the `check_taskcreate_gate` red on `commands/masterplan.md:87`)
finally rests — **not** as the declined one-line "Claude Code only" guard, but as the design question
that guard was gesturing at. Resting on in-repo facts only:

**The two host readings the code and the product disagree on.** "Codex host" has two real meanings:
**(a)** a Claude-Code session *aware of* Codex context (the Workflow/Task tools are present), and
**(b)** a session running *genuinely inside* Codex (CC tools must be remapped to Codex-native ones —
`apply_patch`/`shell`/`update_plan`/`request_user_input`). A fresh-eyes Explore of this tree concluded
the **code is written for (a)**; the **product commits to (b)**. That mismatch is the residual.

- **Code assumes (a).** `lib/codex-host.mjs:5-6` (Tier-3 KEEP) records that the bespoke v7
  `codex_host_perf_guard` was *"dropped in favor of the Workflow tool's native `budget`"* — i.e. it
  presumes the Workflow tool exists wherever execution runs. `commands/masterplan.md:115` (§2a, Tier-3
  KEEP) launches `workflows/execute.workflow.js` via the **Workflow tool, unconditionally — no host
  branch**; and `:87` crash-recovery reconciles that same backgrounded Workflow via `TaskList`/`TaskStop`
  (also CC-only primitives). §0 host-detect (`commands/masterplan.md` step 2) wires **only** `suppressRescue`
  + `--codex-suppressed` to `prepare-wave`; it does **not** branch wave dispatch on host.
- **Product commits to (b).** Project `CLAUDE.md` states *"Codex can host the command through
  `/masterplan:masterplan`"*; `skills/masterplan/SKILL.md:3` (Tier-3 KEEP) routes **all** verbs (incl.
  `execute`/`full`) through the one command; its Codex tool-adaptation table (`SKILL.md:135-146`, **a
  surviving keeper**) maps **every** CC tool to a Codex-native substitute (Read→shell, Edit→apply_patch,
  Bash→exec_command, AskUserQuestion→request_user_input, Task/Todo→update_plan) **— except the Workflow
  tool, which has no listed Codex substitute.** The one tool §2a's wave dispatch depends on is the one
  tool the adaptation table omits.

**Why it's a cutover obligation, not a live defect.** On the **current hybrid branch** the gap is hedged:
the v7 hedge pair `codex-host.md` + `taskcreate-projection.md` (attic'd from `parts/` at the v8.2.0
cutover per Tier-4 #13 as `docs/attic/v7-codex-hedge/`; **deleted 2026-06-10 when 3B's code landed** —
text retrievable at tag `v8.1.0-pre-cruft-removal`) frames host-suppressed mode as *"a bounded
interactive mode — not a license to execute the whole workflow inline,"* plus the *"Claude Code only,
no-op under Codex"* projection. That prose is precisely what
makes the surviving `SKILL.md` table's Workflow-tool omission **harmless today** — it scopes naive Codex
hosting away from full-workflow-inline execution. *(v8.2.0 update: the hedge survived the cutover in the
attic, and `SKILL.md`'s adaptation table now carries an explicit Workflow row stating the same scope —
the omission this paragraph describes is closed.)* **Cutover would have deleted that hedge** (both files were Tier-1),
leaving the surviving keepers — `SKILL.md`'s "every tool maps" table (minus the Workflow row) +
`codex-host.mjs`'s "native budget" rationale + §2a's unconditional Workflow dispatch — to imply, unhedged,
that a genuine-(b) Codex host can run waves, with no specified path to do so. The defect **materializes at
the deletion**, which is why it belongs to cutover completeness.

**What I deliberately did NOT assert.** Whether Codex's runtime literally provides a Workflow-equivalent /
any background-task primitive is **not** an in-repo fact and I have not verified it — so this residual does
not claim it. That question is settled **empirically by the fresh-session parity run**
([`docs/masterplan/2026-05-29-v8-dogfood/parity-runbook.md`](./masterplan/2026-05-29-v8-dogfood/parity-runbook.md)),
not pre-judged here. The residual rests only on the four in-repo facts above (assume-(a) code, commit-(b)
product, omitted Workflow row, deleted hedge).

**Honest provenance.** The Explore verdict on *this code* was reading (a) ("Workflow tool present"); the
push toward (b) comes from the **product** surface (CLAUDE.md / SKILL.md). I am not silently overriding my
own evidence — both are true, and the *mismatch between them* is the finding. This is the same B2 finding in
its third and final location: v7-audit artifact (declined guard) → reconciled-to-dying-target → **this
code-vs-product scope residual**. It survives scrutiny only as the mismatch, never as a Codex-runtime claim.

**Options (the scope decision is the user's; the parity-run fact reveals whether 3B is *forced* or execution already works under Codex):**
- **(3A) Scope Codex-host to non-execution → Codex becomes plan-only. Lean rec on *implementation cost*, but a real product-scope narrowing.** Document that §2a's background-Workflow dispatch is **supported only under a
  Claude Code host**: add a Workflow-tool row to the `SKILL.md` Codex adaptation table reading *"execution
  (`§2a` wave dispatch) is supported only under a Claude Code host — Codex hosts brainstorm/plan/import/status/doctor"*
  (a deliberate **support-scope** statement, **not** a *"no Codex substitute exists"* capability claim — that
  claim could be **false** in the World-2 parity branch below), plus a one-line host-scope note near
  `commands/masterplan.md:115`. This **narrows** the full-lifecycle Codex reach `SKILL.md:3` currently implies
  (all verbs incl. `execute`/`full`) down to **plan-only**. Under this scope the `codex-host.mjs` "native
  budget" comment stands (execution only ever runs under CC). Additive doc-only and **safe in both parity
  worlds** (worded as support-scope, it never makes a false claim and never crashes) — but it is a *scope
  decision*, not a cleanup. Honestly labeled **audit-surfaced (cutover-completeness), additive-doc**.
- **(3B) Scope Codex-host to INCLUDE execution — real code, gated on the parity-run fact.** Specify a Codex
  foreground-sequential wave-dispatch path (no Workflow tool: `mp prepare-wave` then dispatch `mp-implementer`
  agents sequentially, `update_plan` to track — the bound the v7 `codex_host_perf_guard` once provided), and
  add an explicit `if host.isCodex` execution branch at §2a. Then the `codex-host.mjs:5-6` "native budget"
  comment is **wrong** and must be corrected. Only viable **if** the parity run shows Codex genuinely cannot
  run the Workflow tool **and** full-lifecycle Codex execution is wanted; it is new, unverified execution-model
  code, so it is the heavier, riskier path.
- **(3C) Status quo / defer to the parity run.** Record the residual; let the parity run reveal empirically
  whether the Workflow tool exists under a (b)-host, and settle 3A vs 3B on that result. Leaves the hedge-loss
  unaddressed if cutover lands before the parity run does — so if 3C, **gate cutover on resolving this first**
  (Tier-4 #13).

**Follow-up (do NOT do now — gated on the scope ruling):** correcting the `codex-host.mjs:5-6` "native
budget" comment is a real edit, but its *direction* depends on the ruling (3A → comment is fine, no edit;
3B → comment is wrong, correct it). Making it now would bake in an unmade decision. Noted, deferred.

**Recommendation: 3A on *implementation cost* — but it is a genuine product-scope ruling, not a cleanup, and
the user owns it.** 3A is additive/doc-only and *safe in both parity worlds* (worded as support-scope it never
makes a false capability claim and never crashes), **but** it **narrows** Codex from the full-lifecycle reach
`SKILL.md:3` implies (all verbs incl. `execute`/`full`) down to **plan-only**. The honest decision is *"narrow
Codex to plan-only (3A) vs. honor full-lifecycle Codex with real foreground-dispatch code (3B)"* — low
*implementation* cost ≠ low *stakes*. The parity-run fact does not pick 3A-vs-3B for you; it reveals **which
world the decision lives in**: if Codex *cannot* host the Workflow tool, status-quo (3C-as-ship) is broken and
the live choice is 3A (accept plan-only) vs 3B (build the foreground path); if Codex *can*, §2a already works
under Codex and 3A becomes a *deliberate* narrowing (still legitimate, just no longer forced) while 3B is
unnecessary. Surfacing to the user for the scope ruling rather than authoring it.

**OUTCOME (2026-05-30): user ruled 3B over the 3A recommendation — v8 commits to full-lifecycle Codex
(execute included).** This resolves the *"AND full-lifecycle Codex execution is wanted"* half of 3B's gate:
the product goal is now decided, not deferred (the user picked 3B *over* 3C-defer-to-parity). What remains
parity-dependent is the **mechanism, not the commitment**:
- **If the B1 parity run shows Codex *cannot* host the Workflow tool** → build 3B's foreground-sequential
  path (`mp prepare-wave` → dispatch `mp-implementer` sequentially, `update_plan` to track), add the
  `if host.isCodex` execution branch at §2a, and **correct** the `codex-host.mjs:5-6` "native budget" comment
  (it is wrong under a (b)-host that lacks the Workflow tool).
- **If parity shows Codex *can* host it** → §2a already works under Codex as-is; "3B" reduces to *documenting*
  that Codex-execute is supported via the Workflow-tool path, and the `codex-host.mjs` comment **stands**.
- The most robust design — under Codex always dispatch foreground-sequential and never depend on the Workflow
  tool — is parity-independent, but is real execution-model code best informed by the parity fact (does Codex
  expose the sub-agent dispatch `mp-implementer` needs?).

**Implementation is DEFERRED** per the user's same-turn choice to mine the next dogfood bug next; it is **not**
abandoned. The cutover gate (manifest **Tier-4 #13**) is updated from *"rule 3A or 3B"* to *"3B's code must
land before the v7 Codex hedge is `git rm`'d"*. The `codex-host.mjs:5-6` comment-fix stays gated on the parity
branch above (correct it only in the cannot-host-Workflow world).

**CLOSED (2026-06-10): 3B's foreground-sequential path DELIVERED — the parity-independent "most robust
design" option above.** Under host suppression (`codexHostSuppressed`), `mp continue`'s `dispatchWave`
(`lib/continue.mjs`) returns `{op:'dispatch_foreground', wave, cwd, tasks, baseline, review,
next:'record-result'}` instead of `launch_workflow` — same scope, baseline, and launching marker, so a
crash resumes through the ordinary `recover_and_redispatch` path by re-emitting the same op. The host
(Codex inline + `update_plan`; CC fallback sequential `mp-implementer` agents) runs the routed tasks one
at a time and feeds the standard digest array to `mp record-result` — the identical lifecycle from there.
Taught in the §2 op table (`commands/masterplan.md`) and `skills/masterplan/SKILL.md`'s Workflow row;
op-shape + two-wave lifecycle covered in `test/continue.test.mjs`. The v7 hedge attic is deleted
(Tier-4 #13 fully discharged) and the `codex-host.mjs:5-6` comment repointed at the tag. Per plan, the
**empirical gate stays open**: the path is unit-verified only; honesty requires a Codex-hosted parity
run before claiming dogfooded support (tracked in WORKLOG).

---

## Residual 4 — `wantsCodex` flat-key fallback can disagree with dispatch (detection-layer silent-false-negative) — FIXED (a-full: mirror dispatch, drop flat fallback; 2026-05-30)

Surfaced *while* fixing the `codex-plugin-presence` doctor's fix message (the `mp set-codex-config` verb, 2026-05-30; see WORKLOG). It is **not** the A–G missing-writer class — it is a new sub-class: **the doctor's "wants codex" DETECTION can disagree with what the DISPATCH path actually does.**

`wantsCodex` (`lib/doctor/codex-plugin-presence.mjs:25-33`) is defensively flat-OR-nested:
`routing = state.codex?.routing ?? state.codex_routing`. Dispatch (`bin/masterplan.mjs:371/384`) is
nested-ONLY: `state.codex?.routing ?? flags.routing ?? 'auto'`. So a bundle carrying a **flat** `codex_routing: off`
with **no nested `codex` block** → `wantsCodex` reads the flat `off` → returns false → doctor SKIPs ("codex off,
nothing to warn") — while dispatch ignores the flat key entirely and falls through to **`'auto'` → codex still
routes.** That is the *exact* silent-false-fix the verb work eliminated at the *advice* layer, still latent one
layer up at *detection*. (The inverse — flat `codex_review: on`, no nested block — makes the doctor WARN for a
bundle dispatch treats as review-off; same root divergence, lower stakes.)

**Why not folded into the verb fix:** the verb work was a clean *additive* writer + message rewrite with no
detection-behavior change. Making `wantsCodex` authoritative on the nested shape (or treating a flat-only value
as "misconfigured → warn", not "off") is a *semantic* change to detection that churns the doctor fixtures which
deliberately exercise the flat fallback (`test/doctor.test.mjs` + the `codex-plugin-presence` fixtures). Correct
to keep that out of the additive fix; **wrong to call it benign.** This records it.

**Fix direction (when picked up):** reconcile detection with dispatch's nested-only read. Either (a) drop the
flat fallback from `wantsCodex` and migrate the fixtures to the nested shape (matches dispatch exactly; the flat
keys become dead input the doctor no longer honors), or (b) keep reading flat keys but classify a flat-only codex
config as a distinct **misconfig WARN** ("flat `codex_routing`/`codex_review` present but dispatch reads only
nested `codex.{…}` — run `mp set-codex-config` to migrate") rather than silently trusting it. (a) is simpler and
removes a shape the rest of v8 never writes; (b) preserves a louder diagnostic for legacy hand-edited bundles.
Needs the same confirm-at-tip + honest-label + own-test discipline as the verb fix. **Does not block** the
shipped verb fix — that fix is correct for its scope.

**OUTCOME (2026-05-30) — chose (a) "drop the flat fallback", implemented as (a-FULL).** Option (a) as
*literally worded* ("drop the flat fallback") is **insufficient on its own**: with the flat read gone but the
old `routing !== undefined` test kept, a flat-only `codex_routing: off` / no-nested bundle leaves
`routing === undefined → routingOn false → still SKIP`, while dispatch reads `undefined ?? 'auto' → routes` —
the divergence survives. The TRUE "matches dispatch exactly" fix (advisor-confirmed) **also defaults routing
to `'auto'`** in `wantsCodex`, mirroring `bin/masterplan.mjs:381` (`state.codex?.routing ?? … 'auto'`) and
`:394` (`state.codex?.review`; on = `true` / `'on'` / `'true'`) verbatim: NESTED-only, flat keys dropped as
dead input, routing-absent ⇒ `'auto'` ⇒ wants. The doctor's "wants" predicate now **IS** dispatch's effective
"would-route" predicate — the matrix is closed in BOTH directions (the flat-`off` false-negative AND the
flat-`review:on` false-positive both gone).

**(b) rejected** (keep flat reads + classify a flat-only config as a misconfig WARN): it leaves the *no-config*
case still divergent (doctor SKIP vs dispatch `'auto'`) — the false-negative direction, **not** benign — and
preserves a read of a shape v8 never writes. (a-full) is simpler and removes that dead shape entirely.

**Over-warn footprint (named, not buried):** under (a-full) every bundle whose nested routing is not `'off'`
"wants" codex, so in a plugin-**ABSENT** env more bundles WARN than before (a flat `codex_routing: off` no
longer buys a SKIP). This is *accurate* — those bundles DO route codex — and in a codex-equipped repo (plugin
present) they PASS. The lone inaccurate residue is archived/done bundles with no nested-`off` in a plugin-absent
env (they WARN "dispatch will fail" though they'll never dispatch) — an **extension** of the pre-existing
archived+auto false-positive class, not a new one. A `status` filter on the slug loop would remove it but is
beyond this residual's scope (document-and-defer).

**Test discipline (own-test, confirm-at-tip):** the 3 `codex-plugin-presence` fixtures migrated flat →
v8-canonical inline-JSON nested (`codex: {"routing": …, "review": …}` — the shape `setCodexConfig` writes;
`skip-routing-off` → nested `off`, so its SKIP is now dispatch-honest rather than the baked-in bug). Added the
keystone `warn-flat-off-ignored` fixture (flat `codex_routing: off`, **no** nested, plugin absent) + a named
regression test asserting it resolves **WARN, never SKIP** — the exact case that PASSED (as SKIP) under the old
code and is now locked closed. **272/272** node:test (270 baseline + the new dir-prefix scenario subtest + the
named test); each fixture's resolved severity was live-confirmed via a direct `check()` call (skip / pass / warn
/ warn, as intended). Files: `lib/doctor/codex-plugin-presence.mjs` (`wantsCodex` + header), the 4 fixtures,
`test/doctor.test.mjs`.
