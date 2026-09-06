# Design-intent integration — amendment draft

Status: proposed, not reviewed or approved. This extends the existing run; it does not replace its original anchor, completed tasks, or failed release evidence.

## Authority and scope

- Accepted scope: `design-intent-scope-amendment.md` and the user's choice to expand this run.
- Direction: behavior-skills `docs/superpowers/specs/2026-09-05-design-intent-design.md` §5's DECIDED paragraph, source commit `65eea6a`. The old standalone `intent.md` plumbing is superseded; the intended checkpoint coverage is retained and retargeted.
- Code base: `masterplan/intent-to-completion`, currently `1f2741f`; bundle state stays in MAIN.
- Latest operator instruction: full autonomy, no routine continuation questions. This is not an approval receipt for unpresented goal changes.

## 1. Ownership

The skill owns the interview's questions, rewrite test, section schema, and reconciliation of plan intent with repository INTENT.md. Masterplan owns its ledger, native goals.md artifact, hashes, gate integration, and lifecycle. There is one question generator, not a second native interview beside the skill.

The native sequencer supplies a host contract to plan mode: existing anchor and evidence, current draft, ledger status, and permitted native recorder operations. It records actual questions and answers through `mp interview`; the skill does not write state.yml or events.jsonl. Native draft/critic/end remains the replayable lifecycle.

Repo and assess skill modes retain their existing public behavior. Plan mode learns the native host contract rather than refusing the entire goals.md merely because goal blocks exist. The native adapter presents only the intent projection to the shared validator; goal blocks remain owned and validated by masterplan.

## 2. One native artifact with a versioned section representation

Keep `goals.md` and its existing `## Intent` block. Add an explicitly versioned schema-backed representation inside that block, with section bodies, schema identity, source evidence, and reconciliation. Its encoder/decoder is a narrow native adapter; it is not a new lifecycle engine or a second goals resolver.

Keep the four native fields and their meanings:

| Native field | Meaning and proposed relationship |
|---|---|
| `why` | Rationale, projected from Purpose |
| `anti_goals` | Explicit exclusions, projected from Non-goals while preserving item boundaries |
| `outcome` | The owner's intended result; retain explicitly, not an alias for Top invariant |
| `done_means` | Completion meaning; retain explicitly, not an alias for Top invariant |

Outcome and completion meaning can be represented as plan-context extensions alongside the core sections. Top invariant, Direction, and Posture remain separate, losslessly represented sections. Audience, Core bet, and free extensions remain context unless the authoritative schema declares otherwise.

The encoder emits the legacy view deterministically. If the persisted legacy view disagrees with its authoritative section/context representation, validation fails rather than choosing a convenient copy. The codec must distinguish native anti-goal items from bullets inside other sections; the current parser treats any intent-block bullet as an anti-goal (`lib/goals.mjs:136–176`).

The exact encoding is an implementation detail, but it must be readable, unambiguous, versioned, and round-trip all supported section text. A generic extra heading that old parsing silently ignores is not sufficient.

## 3. Schema and hash binding

The skill's schema.json remains the schema authority. Resolve it from the installed skill, validate supported format, and copy the exact bytes to a bundle snapshot when schema-backed capture is approved. Record its digest. Frozen bundles use that snapshot, not a mutable live skill file. A missing, malformed, unsupported, or mismatched schema fails closed.

Legacy documents retain their existing parse results and hashes byte-for-byte. New-format documents add versioned canonical coverage of all sections, plan context, reconciliation, and schema digest. Existing native fields remain covered. The current goals hash covers only four fields (`lib/goals.mjs:699–723`), so merely appending section prose would be an integrity defect.

The same native representation participates in draft identity, critic receipts, goal amendments, and checkpoint identities. Changing a checked section, contextual extension, reconciliation row, or schema snapshot must invalidate the relevant old receipts. Equivalent object key ordering must not. Schema upgrades require an explicit amendment, never silent migration.

## 4. Actual interaction and convergence

Record real questions and answers only. Reused prior evidence retains its original provenance and is not relabelled as a fresh answer. An approval of an entire draft is not expanded into multiple imaginary question/answer events.

Keep unanswered-question handling, current-draft freshness, cap accounting, named terminal states, and failure/unavailability evidence. A clean critic result must cover the current schema-backed draft. The shared rewrite test distinguishes intent from implementation, including Top invariant versus completion mechanics.

### Decision D1: evidenced completeness (user-confirmed)

The original run explicitly sought deeper high-complexity questioning. The native high profile currently requires 8 answers, 6 intent answers, and 4 completed intent rounds (`lib/interview.mjs:18–22,601–647`). The skill instead looks up facts, reuses unchanged evidence, and asks only gaps or contradictions. A fully specified request can therefore be schema-complete before meeting those numerical minimums.

The user selected **Evidence completeness wins**: for schema-backed interviews, require evidenced completeness plus the applicable fresh critic checks, while retaining question caps and honest counters. Preserve legacy interview rules for legacy records. Known evidence may satisfy a section but never increments fresh-answer counts. Greater complexity deepens scrutiny and reconciliation rather than forcing filler questions.

Rejected alternative: retain numerical minimums for schema-backed interviews and require a waiver when genuine questions run out. No additional answer or round minimum is imposed on the new schema-backed path. Coverage and freshness replace that termination criterion; missing evidence, unresolved contradictions, and required unavailable critic checks still prevent convergence.

This decision changes the new interview's convergence policy, not the original run's completed interview history or the requirement for exact goal amendments.

## 5. Reconciliation and checkpoints

The skill constructs one reconciliation row per repository INTENT.md section, with the repository artifact's path and digest, or an explicit absent-source state. Masterplan validates and persists that result. Missing rows, unresolved conflicts, or repository-intent drift are not neutral outcomes.

The repository artifact resolves from the run's integration target, not from the working tree of whatever branch execution happens on. This repository now carries `INTENT.md` on `main` (added in `3186a2e`) while `masterplan/intent-to-completion` at `1f2741f` does not. A branch that lacks an artifact its target carries is drift against the target, not an absent source; the absent-source state is reserved for a target with no INTENT.md at all. Reconciliation records the resolved ref beside the path and digest, so a later checkpoint can distinguish a moved target from a changed file.

Retarget the original checkpoint requirements onto the native intent projection and snapshot:

| Existing checkpoint | Required added evidence |
|---|---|
| Spec review | Section verdicts, reconciliation findings, and rewrite-test/mechanism-leak findings for the reviewed spec |
| End-of-planning alignment audit | Plan alignment to checked sections and reconciliation; preserve the original request-anchor comparison |
| Per-task adversarial review | Intent identity alongside task and commit identity; stale intent coverage cannot authorize changed work |
| Finish assessment | Finished work against checked sections and current repository-intent digest; completion evidence remains separate |

Each checkpoint requires complete, current evidence for the schema-backed contract. Missing, partial, unreadable, stale, or unresolved reviewer identity is unavailable, never approval. A substantive `fights`, mechanism leak, or source drift is a real decision for the owner. Use existing gate/receipt seams where possible, not additional routine confirmation prompts. Keep legacy behavior explicit; legacy absence is not a new-format pass.

## 6. Proposed work packages (not executable tasks yet)

1. **Shared skill host contract:** adapt behavior-skills plan mode, validator input contract, and parity tests; preserve repo/assess behavior. Separate owning-repo commit and verification, no unrequested push.
2. **Native section codec and compatibility:** add the narrow adapter, legacy projections, versioned parse/hash support, round-trip and legacy-hash regression tests.
3. **Ledger and schema snapshot binding:** integrate actual-interaction provenance, draft/critic identities, chosen D1 convergence semantics, and schema-upgrade/refusal tests.
4. **Sequencer and critic integration:** delegate questions to the skill; pass the same schema-backed draft to the critic; remove the duplicate questioning implementation only after its responsibilities have moved.
5. **Checkpoint integration:** reuse spec, alignment, task review, and finish seams; implement fresh intent identity and reconciliation evidence with stale/missing/partial refusal tests.
6. **Contract verification and documentation:** update knob-contract coverage for changed controls, exercise alternate schema content, and verify installed-skill capability without changing global routing or relay settings.

Actual task IDs and waves will be derived from the current index. Use native `amend-tasks` without pruning: it appends new pending IDs while preserving existing task status (`bin/masterplan.mjs:2204–2240`). Do not use initial-only load-plan or seed-tasks to replace the 48 completed records. Cross-repository skill work requires a separate repository-local writer and commit; no cross-repo atomicity or unsupported wave path is assumed.

## 7. Required verification matrix

- Legacy parse/hash fixtures remain unchanged; current original anchor and goal IDs remain unchanged.
- New representation round-trips multiline prose, bullets, extensions, and reconciliation without polluting anti_goals.
- Every section/context/schema/reconciliation mutation invalidates old bound evidence; canonical key reordering does not.
- Missing skill, unsupported schema, digest mismatch, incomplete sections, and unresolved conflicts refuse cleanly.
- Known prior evidence is not counted as newly asked/answered; D1 tests cover a fully specified request and one with actual gaps.
- Unanswered questions, caps, corrected answers, draft freshness, critic unavailability, and disk replay retain truthful behavior.
- All four checkpoints reject omitted, partial, stale, or mismatched evidence and retain legacy compatibility explicitly.
- Repository INTENT.md changes between planning and finish are detected rather than silently accepted.
- Reconciliation resolves the repository INTENT.md from the integration target: a branch missing an artifact the target carries reports drift, only a target without the artifact yields the absent-source state, and the recorded ref distinguishes the two.
- Alternate configured schema/checked-section content proves no copied list of today's headings or models controls behavior.
- Task amendment preserves all existing task records/statuses and appends new work pending; no auto-completion while the amendment is incomplete.

Tests in this matrix are requirements, not passing evidence. The existing 2466-test result predates this implementation, which has not begun.

## 8. Approval and release boundaries

The original goals/spec/index are unchanged. Proposed goal additions live in `goals.design-intent.proposed.md`; no goal-amend receipt has been fabricated. Incorporate the settled design as a scoped spec amendment, obtain the required exact-artifact approval, and build/review the additional task plan before applying task mutations.

Keep `design-intent-amendment-approval` open until approved amendments and pending work are durable and required spec/plan gates are satisfied. A phase label alone does not prevent `mp decide` from returning complete for 48 done tasks.

Previous rehearsal lifecycle/refusal/selector findings, rejected review attestations, reviewer admission failure, and G6 remain open. This amendment does not mark any release evidence valid. No behavior-skills push, home-policy change, Sonnet relay change, or automatic extra release-review loop is included.
