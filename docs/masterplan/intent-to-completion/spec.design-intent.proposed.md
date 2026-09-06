# Proposed spec amendment — the shared design-intent interview

Status: proposed, not approved. This document is the **rationale** for the
`design-intent-amendment-approval` gate — it explains what changes and why. Per §5.6 the
approval binds resulting bytes, not editing instructions, so the artifacts actually approved
are `spec.design-intent.resulting.md` (the full resulting `spec.md`), `spec.design-intent.patch`
(which applies to the pinned base and reproduces it), and `goals.design-intent.proposed.md`
(G7, G8). The immutable anchor, the existing goals, and the 48 completed task records are
unchanged. Nothing here is implemented: `implementation_started` is false.

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

**Convergence — decided by the operator, 2026-09-05.** Masterplan's high-complexity interview
today may only stop after 8 answers, 6 of them about intent, across 4 completed rounds. The
skill instead looks facts up and asks only about real gaps, so it can be schema-complete having
asked fewer questions. Asked which rule should govern a schema-backed interview, the operator
chose **"Cover everything, and still probe"**: the interview must fill every checked section
*and* ask a set number of genuine open questions before it may stop. Running out of things to
look up is not a finish. This answers the run's own anchor, which asked for more probing at high
complexity, not less.

The rule is therefore two independent conditions, both required:

1. **Coverage.** Every checked section carries real evidence, each with its provenance and its
   unresolved uncertainty stated. A section satisfied from prior context is covered but is not
   an answer.
2. **Probing.** A configured minimum of genuine open questions — a question at a real fork whose
   answer only the operator holds — has been asked and answered fresh in this interview. The
   minimum is resolved from the complexity level through the config hierarchy (§4), not written
   into the code, and it is what "higher complexity deepens scrutiny" means observably.

Neither condition substitutes for the other: a fully covered draft that asked too few genuine
questions has not converged, and a heavily questioned draft with an unevidenced section has not
either. Question caps still bound the total, so a run that cannot satisfy the probing minimum
within its cap reaches a named terminal state and stops for the operator — it never invents
filler questions to reach a number, and a look-up never increments the fresh count.

The applicable critic checks must be fresh against the current schema-backed draft and
independent of the questioner. Negative controls are required: a draft that merely restates the
request, and one resting on an unsupported assumption, must each fail to converge despite
looking complete.

Legacy records keep the legacy rules. Evidence reused from prior context keeps its original
provenance and never increments a fresh-answer count. Missing evidence, unresolved
contradictions, and a required-but-unavailable critic check each still prevent convergence.

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

Both promises hold together only through an explicit format discriminator: the legacy
canonicalizer is retained and selected for a v1 document, and a richer canonicalizer is selected
for an explicitly versioned one. The new canonical coverage includes the source-evidence
provenance introduced above, so a provenance edit — which can change whether completeness was
justified without changing a single section body — invalidates the receipts bound to it.
Duplicate fields, duplicate sections, an unknown version, and a malformed version marker are
rejected rather than parsed leniently, and stripping the new representation from a schema-backed
bundle is a rejected downgrade, not a fall back to legacy handling. Each checkpoint names its
receipt identity tuple, and the amendment states which text normalizations are semantic and
which are cosmetic. The exception for equivalent key ordering is scoped to the canonical
representation only: the schema snapshot is compared by exact bytes, so reordering keys inside
it is a different snapshot.

## D. New §5.5 — schema ownership and binding

The skill's `schema.json` is the schema authority. Masterplan resolves it from the
installed skill, validates that the format is supported, and copies the exact bytes
into a bundle snapshot when schema-backed capture is approved, recording the digest. A
frozen bundle reads its snapshot, never a mutable live skill file. A schema that is
missing, malformed, unsupported, or mismatched fails closed. A schema upgrade requires
an explicit amendment; there is no silent migration.

A snapshot of schema bytes does not establish that the installed skill can operate against it.
Capture therefore records a handshake: the skill's supported host-contract version and its
schema-format version alongside the snapshot digest, hashed from the exact bytes persisted. At
every later operation the installed skill must declare support for that run's snapshot or the
operation stops. A skill that is absent when questioning or reconciliation must resume, a
host-contract version skew, and a skill whose behavior moved without a schema-byte change are
each named failures, per operation. Falling back to native questioning or to a newer live schema
is prohibited. Receipts and results never cross snapshot identities, so two runs holding
different snapshots cannot share evidence.

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

The target is an identity, not a name: repository, remote, target ref, and the resolved commit,
all recorded with the resolution's freshness. A run with no target selected yet, a retarget, a
fork whose local and upstream branches share a name, a detached worktree, and a target ref whose
local cache is stale are **unknown or unavailable** — a named failure, never the absent-source
state, which is reserved for a verified target that carries no `INTENT.md`. A retarget
invalidates the reconciliation bound to the previous target. A target that moves while
`INTENT.md`'s bytes are unchanged is not drift, which is why the resolved commit is recorded
beside the digest.

The known case in this run resolves the same way: the branch's absence of an artifact `main`
carries is drift to be reported at the checkpoint, not a condition to be silently passed, and it
is not resolved by moving the branch base, which the accepted scope fixes at `1f2741f`.

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

## H. Promotion — what approval authorizes, and how it lands

The operator approves these two proposed files by digest. Approval of a proposal is not
approval of an unspecified result, so promotion is defined deterministically: this amendment's
lettered sections replace or extend exactly the named `spec.md` sections and nothing else, and
the resulting `spec.md` and `goals.md` bytes are computed and their hashes recorded **before**
either file is written.

The gate hash spans `spec.md` + `goals.md`, so the pair promotes together. `mp goals-amend`
requires its own exact-artifact user-approval receipt binding both the prior and the resulting
goals hash; the combined gate receipt binds the resulting pair. Order is: compute the resulting
pair, obtain the goal-amend receipt, write, then record. A crash between the two writes leaves
the recorded hashes disagreeing with the files, which is a named failure that refuses to
advance rather than a state to repair silently — the bundle is restored from the recorded
hashes, not reconciled by preference.

Any edit to either artifact after approval and before promotion invalidates the approval and
requires a fresh one. Replay recognizes an already-promoted pair by its recorded hashes and
neither re-asks nor accepts a mixed pair. A second session changing goals, the snapshot, or the
target identity between review and receipt persistence is detected by the expected-revision
check and refuses.

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
