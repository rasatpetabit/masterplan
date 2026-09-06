# Proposed spec amendment — the shared design-intent interview

Status: proposed, not approved. This document is the exact artifact for the
`design-intent-amendment-approval` gate, paired with `goals.design-intent.proposed.md`
(G7, G8). It amends `spec.md` in place at the sections named below; it does not
replace the spec, the immutable anchor, the existing goals, or the 48 completed
task records. Nothing here is implemented: `implementation_started` is false.

Design record: `design-intent-integration-draft.md`. Accepted scope:
`design-intent-scope-amendment.md`. Direction source: behavior-skills
`docs/superpowers/specs/2026-09-05-design-intent-design.md` §5 at commit `65eea6a`.

---

## A. Amends §5 — the questioning delegates to the skill

§5's opening sentence is extended: the masterplan-owned questioning phase does not
implement its own question generator. `/design-intent` plan mode owns the questions,
the rewrite test, the section schema, and reconciliation with the repository
`INTENT.md`. Masterplan owns the ledger, the native `goals.md` artifact, the hashes,
the gate integration, and the lifecycle. There is one interview implementation with
two consumers.

§5.1 step 3 (question discipline) and the intent-vs-how classification move to the
skill. The constraints they state — one fork per question, 2–4 options,
recommendation first, no *how* questions, the classification being a judgment the
critic reviews rather than a mechanical rule — are the skill's, and the spec cites
them rather than restating them.

§5.1 steps 1, 2, 4, 5, and 6 are unchanged in effect. The sequencer supplies plan
mode with a host contract: the existing anchor and evidence, the current draft, the
ledger status, and the permitted recorder operations. The skill returns questions,
answers, and a draft; it never writes `state.yml` or `events.jsonl`. `mp interview`
remains the only recorder, and the replayable draft/critic/end lifecycle is unchanged.

The skill's repo and assess modes keep their existing public behavior. Plan mode
learns this host contract instead of refusing a `goals.md` because it carries `## G<n>:`
blocks; the native adapter presents only the intent projection to the shared
validator, and the goal blocks stay owned and validated by masterplan.

## B. Amends §5.3 — actual interaction, and the convergence rule

The ledger records real questions and real answers only. Evidence reused from prior
context keeps its original provenance and is never relabelled as a fresh answer, and
an operator's approval of a whole draft is never expanded into several synthetic
question/answer events.

**Convergence (D1, decided).** For a schema-backed interview, the termination
criterion is evidenced completeness of the checked sections plus the applicable fresh
critic checks — not the native high profile's numerical minimums (8 answers, 6 intent
answers, 4 completed rounds). Question caps and honest counters are retained. Known
evidence may satisfy a section but never increments a fresh-answer count. Higher
complexity deepens scrutiny and reconciliation rather than forcing filler questions.
Legacy records keep the legacy rules. Missing evidence, unresolved contradictions, and
a required critic check that is unavailable all still prevent convergence.

Unanswered-question handling, current-draft freshness, the named terminal states, and
failure/unavailability evidence are unchanged. A clean critic result must cover the
current schema-backed draft.

## C. Amends §6.1 — a versioned section representation inside `## Intent`

`goals.md` and its `## Intent` block are retained. Inside that block, an explicitly
versioned, schema-backed representation carries the section bodies, the schema
identity, the source evidence, and the reconciliation result. Its encoder and decoder
are a narrow adapter, not a second goals resolver or a second lifecycle engine.

The four native fields keep their names and meanings, and the encoder emits that
legacy view deterministically:

| Native field | Relationship |
|---|---|
| `why` | Projected from Purpose |
| `outcome` | The operator's intended result; retained explicitly, not an alias for Top invariant |
| `anti_goals` | Projected from Non-goals, preserving item boundaries |
| `done_means` | Completion meaning; retained explicitly, not an alias for Top invariant |

Top invariant, Direction, and Posture are separate, losslessly represented sections.
Audience, Core bet, and free extensions are context. Outcome and completion meaning
are represented as plan-context extensions beside the core sections.

If a persisted legacy view disagrees with the authoritative section representation,
validation fails rather than preferring either copy. The codec must distinguish native
anti-goal items from bullets inside other sections; today's parser treats any bullet in
the intent block as an anti-goal (`lib/goals.mjs:136–176`). The encoding is an
implementation detail, but it must be readable, unambiguous, versioned, and able to
round-trip all supported section text. A generic extra heading that the old parser
silently ignores does not satisfy this.

`goalsHash` continues to cover the `## Intent` block. Because today's hash covers only
the four native fields (`lib/goals.mjs:699–723`), a new-format document extends the
canonical coverage to every section, the plan context, the reconciliation, and the
schema digest. Legacy documents keep their existing parse results and hashes
byte-for-byte.

## D. New §5.5 — schema ownership and binding

The skill's `schema.json` is the schema authority. Masterplan resolves it from the
installed skill, validates that the format is supported, and copies the exact bytes
into a bundle snapshot when schema-backed capture is approved, recording the digest. A
frozen bundle reads its snapshot, never a mutable live skill file. A schema that is
missing, malformed, unsupported, or mismatched fails closed. A schema upgrade requires
an explicit amendment; there is no silent migration.

The same representation participates in draft identity, critic receipts, goal
amendments, and checkpoint identities. Changing a checked section, a contextual
extension, a reconciliation row, or the schema snapshot invalidates the bound
receipts; re-ordering equivalent object keys does not.

## E. New §6.3 — reconciliation with the repository INTENT.md

The skill constructs one reconciliation row per repository `INTENT.md` section,
carrying the repository artifact's path and digest or an explicit absent-source state.
Masterplan validates and persists the result. Missing rows, unresolved conflicts, and
repository-intent drift are not neutral outcomes.

The repository artifact resolves from the run's **integration target**, not from the
working tree of whichever branch execution happens on. A branch that lacks an artifact
its target carries is drift against the target; the absent-source state is reserved for
a target that has no `INTENT.md` at all. The resolved ref is recorded beside the path
and digest, so a later checkpoint can distinguish a moved target from a changed file.
(Concretely: this repository carries `INTENT.md` on `main` from `3186a2e`, while
`masterplan/intent-to-completion` at `1f2741f` does not.)

## F. Amends §11 — the four checkpoints carry intent evidence

The existing spec-review, end-of-planning alignment, per-task adversarial, and finish
checkpoints are retargeted onto the native intent projection and the schema snapshot.
No new routine confirmation prompt is added; the existing gate and receipt seams carry
this.

| Checkpoint | Added evidence |
|---|---|
| Spec review | Section verdicts, reconciliation findings, and rewrite-test / mechanism-leak findings for the reviewed spec |
| End-of-planning alignment audit | Plan alignment to the checked sections and to reconciliation, preserving the existing request-anchor comparison |
| Per-task adversarial review | Intent identity beside task and commit identity; stale intent coverage cannot authorize changed work |
| Finish assessment | Finished work against the checked sections and the current repository-intent digest; completion evidence stays separate |

Each checkpoint requires complete, current evidence for the schema-backed contract.
Evidence that is missing, partial, unreadable, or stale, or a reviewer identity that is
unresolved, is **unavailable** — never approval. A substantive `fights` verdict, a
mechanism leak, or source drift is a real decision for the operator. Legacy behavior
stays explicit: the absence of legacy evidence is not a new-format pass.

## G. Boundaries

The anchor, existing goals G1–G6, `spec.md`'s other sections, `plan.index.json`, and
all 48 completed task records are unchanged by this amendment. New tasks are appended
through `mp amend-tasks`, which preserves existing task status
(`bin/masterplan.mjs:2204–2240`); `load-plan` and `seed-tasks` are not used. The
behavior-skills half is a separate repository-local commit with its own verification;
no cross-repo atomicity is assumed and no push is authorized.

This amendment marks no release evidence valid. The rehearsal lifecycle, refusal, and
selector findings, the rejected review attestations, the reviewer admission failure, and
G6 all remain open. `design-intent-amendment-approval` clears only after the approved
amendments and the pending work are durable and the required spec and plan gates are
satisfied.
