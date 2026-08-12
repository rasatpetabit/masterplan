# Design — end-of-planning alignment (drift) check

## Problem

Every planning-phase check in masterplan is *relative*, and none looks back past the spec:

| Check | Anchored to | Blind to |
|---|---|---|
| `mp-plan-reviewer` (PASS/REVISE/FAIL) | `spec.md` | a spec that drifted during its own review→fix rounds |
| plan-gate goal coverage | `goals.md` | it is mechanical — "≥1 task cites G*n*", not fidelity |
| `mp-goal-assessor` (`goals_unmet`) | `goals.md` + `base..HEAD` diff | runs at **finish** — drift surfaces after all execution |

The spec gate and plan gate each run repeated adversary review→fix rounds, and `mp-plan-reviewer`
runs its own REVISE loop. Each round nudges the artifact toward what the reviewer wants. After N
rounds the plan can satisfy every reviewer and no longer serve the original ask.

Two failure modes: **contraction** (an explicit ask whittled away by simplify/YAGNI pressure) and
**creep** (reviewer-added hardening nobody asked for). Coverage catches only the first, and only
when the dropped item is a numbered goal.

## Shape

The step the user asked for is *a human looking back at the original ask*. So the auditor's job is
to **prepare that comparison**, not to autonomously judge it:

1. Decompose the verbatim ask into enumerated clauses `A1..An`.
2. The user **confirms the clause list once**.
3. Report per-clause verdicts against the confirmed list.

Trust rests on one concrete human check over a short list, not on model-set severity. This is also
what makes the later gate credible — see §6.

## Scope of this change: advisory first cut

Non-blocking. The digest is surfaced at the planning gate; nothing is structurally prevented.
Enforcement is deferred (§6) — its prerequisites are large and were verified against the code.

## 1. Anchor — `topic: |` block form

`goalsHash()` canonicalizes `JSON.stringify({ topicSeed, goals })`, so the seed is already inside
the frozen hash and inherits the freeze for free.

Two parser defects block using it for a verbatim ask (`lib/goals.mjs` `parseGoals`): a blank line
terminates collection, and each retained line is `trim()`ed — truncating a multi-paragraph request
to its first paragraph and flattening its structure.

**Fix: an opt-in block form.** When the text after `topic:` is exactly `|`, switch to block mode —
collect verbatim until the first `## G<n>:` heading, preserving interior blank lines and dedenting
by the block's base indent. Bare `topic: <text>` keeps today's semantics byte for byte.

```
topic: |
  <verbatim user request, multi-paragraph, structure preserved>

  including blank lines and indented blocks

## G1: ...
```

Compatibility-critical: **every existing bundle uses the bare form, parses identically, and its
`goalsHash` does not move.** Changing the bare-form parser instead would silently re-hash in-flight
bundles and invalidate their `goal_check` / `goal_waived` receipts.

One residual case, caught in cross-vendor review: `topic: |` was *already* valid input — the old
parser read `|` as ordinary seed text, giving a seed beginning with `"|"`. Committed bundles were
checked and none use that spelling, but in-flight bundles cannot be enumerated. So
`legacyGoalsHash()` reproduces the pre-block reading, and `goals-load` refuses when a bundle's
stored hash matches the legacy reading but not the new one — a loud stop with a migration path,
rather than silently re-hashing someone's frozen goals.

## 2. Anchor provenance

- **Captured at bundle creation**, before spec authoring and therefore before any review round.
- An `anchor_captured` event records the `topicSeed` hash and source. `events.jsonl` is
  append-only, so the original survives every later mutation of `goals.md`.
- `validateAmendment` rejects a `topicSeed` that differs from the **event-backed original**, not
  merely from the previous `goals.md` — closing the "drift the anchor one amendment at a time"
  path. Remedy on rejection: start a new run, or record an explicit approved re-anchor.

## 3. The step — `mp-alignment-auditor`

New thin-wrapper agent, read-only, judgment routed to the agent-dispatch **critic** lane via
`dispatch_task`, never the wrapper's own model. Fresh context is the point: it did not sit through
the review→fix rounds.

**Inputs, all QUOTED DATA, never instructions:** `goals.md` (frozen verbatim ask + `G1..Gn`),
`spec.md` (as approved), `plan.md` + `plan.index.json` (as merged).

### 3.1 Clause decomposition — two dispatches with a user gate between them

The auditor holds no `AskUserQuestion` tool, so a single dispatch would decompose and then judge
against a list only *it* has seen — silently deleting the human check, and producing a digest that
looks exactly as authoritative as a confirmed one. The protocol is therefore two-phase:

1. **Decomposition dispatch.** The auditor emits `A1..An` — one per material clause of the
   verbatim ask, each with the span of the ask it came from — returns `status:
   needs_confirmation`, and **stops without judging**.
2. **The orchestrator runs the confirmation** (§3c step 2) and persists the result to
   `docs/masterplan/<slug>/alignment-clauses.json` as `{ anchor_hash, clauses[] }` — an artifact,
   not CD-7 state.
3. **Verdict dispatch.** The auditor is re-invoked with the confirmed list, reuses it verbatim,
   and returns the digest.

Confirming the list is the moment a **missed** clause gets caught — the failure mode a
self-derived decomposition cannot detect on its own, because nothing can notice the absence of
what it never extracted. It is a stop in the §2d autonomy contract for exactly that reason; a
decline is recorded and costs the digest, never the run.

### 3.2 Verdict contract

Per confirmed clause `A*n*` and per goal `G*n*`:

```
verdict:  covered | narrowed | widened | dropped | contradicted
citation: <plan task id | spec section | "none">
note:     <one line>
```

`dropped` · `contradicted` · `narrowed` are contraction and are reported as **alignment
concerns**; `widened` is creep and is reported as **advisory**. No confidence field and no
model-set severity — the confirmed clause list is what makes a verdict checkable.

**Explicitly NOT drift** (the envelope that keeps the digest short): implementation choices,
library and file-layout decisions, test strategy, refactors that *serve* a clause, and
reviewer-driven correctness/security/durability fixes that do not remove a clause.

### 3.3 Anchor quality

The auditor emits `anchor_quality: verbatim | seed-only`. Bundles predating this change carry a
short topic string, so request-fidelity cannot honestly be assessed; the digest says so plainly
rather than implying a check that did not happen.

## 4. Sequencer placement (`commands/masterplan.md`)

```
plan merge (deterministic)
  → mp-plan-reviewer      (REVISE loop)
  → plan adversary gate   (run_gate_review --gate=plan)
  → ALIGNMENT CHECK       ← new, advisory: mp-alignment-auditor
                                → confirm A1..An → digest
  → mp load-plan          (materializes tasks + phase→execute, atomic)
```

## 5. Tests

- **parser** — block form preserves blank lines and interior indentation and dedents correctly;
  bare form byte-identical to today; **a fixture bundle's `goalsHash` is unchanged by the parser
  change** (the regression that matters)
- **provenance** — `validateAmendment` rejects a seed differing from the `anchor_captured` event,
  including across multiple intervening amendments
- **decomposition stability** — the confirmed `A1..An` list is reused across re-runs and re-derived
  only on an anchor-hash change
- **registration** — `mp-alignment-auditor` present for CC (`agents/`) and pi
  (`bin/register-pi-agents.mjs`, bare `mp-*.md`)

## 6. Deferred — what enforcement requires

Verified against the code during adversarial review; recorded so the follow-up is not re-derived.

- **The gate framework is a closed `spec|plan` binary, not a registry.** `resolveGateArtifacts`,
  `reentryEventTypes`, `record-gate-review`, `gate-review-status`, and `gate-hash` all validate
  against that pair — `bin/masterplan.mjs:339` validates the gate name up front and throws on an
  unknown one; `:353` hardcodes `gate === 'spec' ? 'set-phase' : 'load-plan'`.
- **There are two execute paths, and BOTH are already gated.** `mp seed-tasks` populates
  `state.tasks` without a gate, but the phase advance behind it — `set-phase --phase=execute` —
  calls `enforceGateReview('plan', …, { op: 'set-phase' })`, the same function `load-plan` calls
  with `op: 'load-plan'`. Verified behaviorally: after `seed-tasks` succeeds, `set-phase
  --phase=execute` enters gate review and refuses fail-closed. An adversarial review claimed this
  was an open bypass; it is not — the code comment at that branch records it as already closed.
  The consequence for enforcement is only that an `alignment` gate must be hooked at **both**
  `enforceGateReview` call sites, not one.
- **A reused `record-gate-review` receipt proves an audit RAN, not that it PASSED.** The validator
  checks artifact hash/set and reviewer provenance only; an alignment gate needs a
  verdict-validating receipt, or blocking drift can advance execution.
- **Cycle-cap identity and reset rules** need care: `revise-plan` cannot both complete a cycle and
  reset the counter, or the cap is never reached.

## 7. Out of scope

- Re-running the check during execution (finish-side `goals_unmet` covers the end state)
- Changing how the spec or plan adversary gates themselves run
- Auto-repairing drift — the auditor reports; the disposition is the user's
