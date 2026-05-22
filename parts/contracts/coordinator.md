# Coordinator Subagent Contract

<!-- Loaded on demand by any phase file using coordinator dispatch.
     All coordinator call sites reference: parts/contracts/coordinator.md -->

## Core Contract

A **coordinator subagent** pays context cost internally and returns a compact JSON result (≤1000 tokens) to the orchestrator.

**Invariants:**
1. Loads large source files internally — orchestrator never sees them directly.
2. May dispatch further Haiku subagents via `Agent` tool (nested dispatch for parallelizable sub-tasks).
3. Returns **compact JSON ≤1000 tokens** to the orchestrator.
4. **Never writes `state.yml`, `events.jsonl`, or any run artifact.** CD-7: orchestrator is the canonical writer.
5. First line of every coordinator brief: `DISPATCH-SITE: coordinator-<name>`.

## Tier Selection

| Tier | When |
|---|---|
| Haiku | Mechanical structured read + summarize; no judgment needed |
| Sonnet | Classification, merge logic, or contextual fix application |

## Failure Contract

When a coordinator returns malformed JSON or errors, the orchestrator falls through to the existing inline path. Log: `{"event":"coordinator_fallback","site":"coordinator-<name>","reason":"<error>"}` in `events.jsonl`. Every coordinator dispatch site MUST have an inline fallback.

## Coordinator Catalog

| Name | Tier | Replaces | Doc |
|---|---|---|---|
| `coordinator-brainstorm-anchor` | Sonnet | 3 direct Haiku dispatches (Step B1) | `docs/internals/brainstorm-anchor.md` |
| `coordinator-doctor` | Sonnet | Loading `parts/doctor.md` (73KB) into orchestrator context | `docs/internals/doctor.md` |
| `coordinator-task-verify` | Haiku | Inline verify execution (Step C3) | `docs/internals/task-verification.md` |
| `coordinator-bundle-resume` | Haiku | Direct state.yml/events.jsonl/plan.md reads on resume | `docs/internals/bundle-resume.md` |
| `coordinator-plan-parser` | Haiku | Direct plan.md reads for eligibility cache build (Step C2) | `docs/internals/plan-parser.md` |

## Return Shape Protocol

Every coordinator return JSON MUST include `coordinator_version: "1"`. Schema per coordinator: see the corresponding `docs/internals/<name>.md §Return shape`.

## Versioning

Bump `coordinator_version` when adding required fields to a return shape (enables cache invalidation).
