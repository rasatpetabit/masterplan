# Centralize wave-task review in agent-dispatch

**Status:** Proposed

## Purpose

Masterplan currently owns a second adversarial review implementation inside `lib/dispatch-wave.mjs`: it captures diffs, segments large payloads, invokes `agent-dispatch review`, maps verdicts into a masterplan-only vocabulary, formats findings, and manages partial-review failure. Agent-dispatch now owns the canonical review module and structured findings contract. Masterplan should become a caller and durable recorder of that module rather than maintain a parallel implementation.

This change preserves masterplan’s per-task review timing and wave-completion behavior. It does not remove review, move it to finish only, or make review automatic inside `dispatch_task`.

## Goals

1. Make agent-dispatch the sole owner of review payload chunking, reviewer retries, verdict reconciliation, findings extraction, and fail-closed review semantics.
2. Preserve config-gated, per-task review after successful implementation and local verification.
3. Preserve review of the full edit-locus working diff, including undeclared writes; D6 scope enforcement remains independent and authoritative.
4. Preserve payload-bound re-entry and durable task review events without reparsing prose.
5. Preserve actionable task attribution through `blocking_reviews[]`.
6. Delete obsolete masterplan review helpers and their duplicated tests.

## Non-goals

- Changing task implementation routing.
- Adding review execution to `dispatch_task`.
- Replacing per-task review with one wave-wide review.
- Removing the whole-branch finish review.
- Changing D6 scope verification or watch-list integrity.
- Adding a new swappable adapter seam. Agent-dispatch is the one canonical review adapter.
- Editing agent-dispatch in this change. Its current review interface is the dependency.

## Current architecture

`dispatchWaveViaFabric` currently contains the complete review implementation:

- full tracked/untracked diff capture;
- byte-bounded segmentation;
- per-segment lane calls;
- worst-wins verdict merging;
- findings formatting and truncation;
- mapping `approve | rework | reject | error` into `clean | advisory | blocking | inconclusive`;
- payload-hash re-entry and durable event writes.

`recordWaveResult` then trusts a second, masterplan-specific review shape and projects blocking verdicts into `blocking_reviews[]`.

This is shallow ownership: agent-dispatch already performs proactive file/hunk/line chunking, adaptive re-splitting, bounded same-size retry, per-region worst-wins reconciliation, structured findings extraction, and empty-payload failure. Keeping parallel behavior in masterplan reduces locality and permits semantic drift.

## Proposed architecture

### Ownership

**Agent-dispatch review module owns:**

- payload validation;
- chunking and adaptive re-splitting;
- backend fallback and bounded retry;
- reviewer execution;
- findings extraction;
- verdict reconciliation;
- harness degradation metadata;
- the canonical structured findings record.

**Masterplan wave module owns:**

- deciding whether task review is enabled;
- deciding when a completed task is ready for review;
- capturing the full edit-locus working diff;
- binding review to `{run, task, payload_sha}`;
- invoking agent-dispatch once per completed task;
- persisting a compact structured task-review projection;
- surfacing blocking/error outcomes in the wave-completion protocol;
- keeping D6 and watch integrity independent of review.

This creates a deep agent-dispatch review module: masterplan learns one interface and receives all review behavior as leverage. Masterplan retains locality only for run lifecycle and durable state.

### Review invocation

For every task whose implementation digest is `done`, when `state.review.adversary` is enabled:

1. Determine the task’s edit locus from its descriptor.
2. Capture the locus’s full working diff, including tracked changes and untracked files.
3. Compute `payload_sha = sha256(exact_diff_bytes)`.
4. Query the existing `run+task+sha` re-entry record.
5. If a completed structured record exists, reuse it without invoking review.
6. Otherwise call the canonical agent-dispatch review interface once with:
   - class `adversary`;
   - standard intensity, preserving current effective effort;
   - the complete diff as a single input;
   - repository set to the task’s edit locus;
   - a job id containing the run, wave, task, and payload hash prefix.
7. Let agent-dispatch perform all chunking, retries, reconciliation, and findings extraction.
8. Persist the structured result before `recordWaveResult`.

The production implementation uses the existing broker client’s `dispatch_review` tool so wave dispatch continues to use one `agent-dispatch serve-mcp` process. The injected test seam returns the same canonical record shape.

`writer_dispatch_id` is optional and is not required for the initial migration. Masterplan’s task result can originate from gateway execution or native Pi execution, and native execution does not currently provide one uniform writer dispatch id. The payload hash remains the authoritative review-content binding.

### Canonical result projection

Masterplan stores a compact projection rather than copying or translating the full agent-dispatch record:

```json
{
  "verdict": "approve | rework | reject | error",
  "findings": [
    {
      "file": "path-or-null",
      "line": 42,
      "summary": "actionable finding",
      "severity": "info | minor | major | blocking"
    }
  ],
  "blocking_findings": [
    {
      "summary": "blocking finding",
      "proof": "optional evidence"
    }
  ],
  "summary": "bounded review summary",
  "harness": {
    "degraded": false,
    "timed_out": false,
    "stalled": false,
    "deadline_exceeded": false,
    "regions_unreviewed": 0,
    "extraction_degraded": false
  }
}
```

The durable event keeps the existing event types and key fields for compatibility:

- `task_adversary_review` for a usable complete record;
- `task_adversary_review_skipped` only for explicitly disabled or legacy compatibility paths, not for a mandatory review failure;
- `data.{run,task,sha,base,count}` unchanged;
- `data.review` added as the structured projection.

Legacy events without `data.review` retain the existing conservative fallback reader during migration. New events are never interpreted from prose.

### Wave-completion mapping

`recordWaveResult` stops accepting masterplan’s `clean | advisory | blocking | inconclusive` vocabulary. It consumes the canonical projection.

- `approve` with a healthy, non-degraded harness: no blocking entry.
- `rework` or `reject`: append the task and structured findings to `blocking_reviews[]`.
- `error`: append the task to `blocking_reviews[]` with the review failure reason.
- Any harness state indicating incomplete coverage—degraded, timed out, stalled, deadline exceeded, unreviewed regions, or extraction degradation—is treated as `error` for wave completion even if a contradictory clean verdict appears.

This tightens the existing behavior. A mandatory task review that does not complete usefully is a visible block, not an advisory skip. The orchestrator already routes a non-empty `blocking_reviews[]` through its structured user gate.

Task implementation and D6 remain separate:

- a `done` implementation digest may still be durably recorded;
- D6 still reverts undeclared writes regardless of review outcome;
- the wave result exposes review blockers so orchestration cannot silently continue past them.

### Full edit-locus payload and task attribution

Each task receives a full edit-locus diff, matching current safety behavior. In a multi-task wave sharing one locus, tasks may review the same payload. This is intentional:

- undeclared writes remain visible to every affected task review;
- the payload hash gives deterministic reuse;
- the task id keeps durable attribution distinct;
- D6 remains the authority for path ownership.

No attempt is made to infer which concurrent task authored each line. Such inference would be unreliable without isolated per-task worktrees.

### Native spawn path

Native Pi execution currently returns before masterplan has child results; the host later supplies those results to `record-result`. The centralized review migration must preserve this split:

- MCP-pool execution performs per-task review in `dispatchWaveViaFabric` after implementation and local verify.
- Native execution performs the same centralized per-task review in the result-ingestion path, after child results are available and before `recordWaveResult` commits the wave.
- Both paths call one shared masterplan orchestration helper that only handles lifecycle, payload binding, invocation, and persistence. It does not implement review semantics.

A test must prove both execution paths produce the same structured task-review projection and blocking behavior.

## Error handling

1. Empty full diff: agent-dispatch rejects it as an empty payload. Masterplan records canonical `error` review state and blocks wave continuation. A `done` task with no changed bytes is therefore review-incomplete rather than clean.
2. Review RPC or process failure: record a structured `error` projection with the exact failure reason; do not fabricate findings or write a completed review event.
3. Agent-dispatch `final_verdict: error`: block the task review.
4. Degraded/incomplete harness metadata: block even if `final_verdict` is `approve`.
5. `rework` or `reject`: preserve structured findings and block via `blocking_reviews[]`.
6. Review event already completed for the same payload: reuse it.
7. Code changes at the same HEAD: the changed payload hash re-arms review.
8. A failed review never satisfies re-entry; the next attempt invokes the centralized review again.

## Code changes

### `lib/dispatch-wave.mjs`

- Delete local review constants and helpers:
  - `REVIEW_VERDICTS`;
  - `REVIEW_DIFF_MAX_BYTES`;
  - `segmentDiffPayload` and its splitting helper;
  - `mergeReviewVerdicts`;
  - findings serialization/capping helpers;
  - `mapAdversaryLaneVerdict`;
  - local CLI parsing/invocation;
  - legacy prose verdict extraction after the compatibility window.
- Retain full working-diff capture unless it is moved to an existing git utility with no new seam.
- Replace the review loop with a small orchestration helper calling `dispatch_review`.
- Reuse the wave’s broker client; do not spawn one process per review.
- Stop advertising a `review` requirement in writer descriptors if agent-dispatch does not consume that field during `dispatch_task`.

### `lib/wave-commit.mjs`

- Remove duplicated local verdict vocabulary.
- Validate canonical review projections structurally.
- Build `blocking_reviews[]` from `rework | reject | error` and incomplete harness metadata.
- Keep array-shaped structured findings.

### `lib/reentry-guard.mjs`

- Preserve event names and key identity.
- Extend task-review events with structured review data.
- Keep legacy read compatibility for existing bundles.

### Tests

Move review-engine behavior assertions out of masterplan. Masterplan must not retest agent-dispatch chunking, verdict reconciliation, findings extraction, or reviewer retry behavior.

Retain or add tests for masterplan-owned behavior:

1. Review disabled: no review call or review fields.
2. One centralized review call per completed task.
3. Full edit-locus diff includes undeclared and untracked writes.
4. Canonical `approve` records without blockers.
5. `rework`, `reject`, and `error` surface through `blocking_reviews[]`.
6. Degraded/incomplete harness metadata blocks fail-closed.
7. Structured findings survive without prose parsing.
8. Same `{run, task, payload_sha}` reuses the durable event.
9. Changed payload at the same HEAD re-arms review.
10. Failed review never satisfies re-entry.
11. D6 reverts out-of-scope writes despite review approval.
12. Multi-task waves preserve task attribution.
13. MCP-pool and native-result paths have parity.
14. Broker client lifecycle remains one process per wave.

Delete masterplan tests that assert local segment sizes, byte splitting, worst-wins merge logic, finding text caps, or agent-dispatch record mapping. Those belong to agent-dispatch’s review tests.

## Documentation changes

Update:

- `docs/internals/wave-dispatch.md` to describe masterplan as a review caller and recorder;
- `docs/internals/task-verification.md` to use canonical verdicts and fail-closed review failure;
- `docs/conventions/adversarial-review-failure-policy.md` to remove stale fail-soft and reviewer-count rules and point to agent-dispatch’s canonical policy;
- `commands/masterplan.md` only where the wave completion protocol or failure gate is described;
- `CHANGELOG.md` with the ownership migration.

Do not duplicate agent-dispatch chunk sizes, retry rules, reviewer rosters, routing matrices, or verdict reconciliation logic in masterplan documentation.

## Migration sequence

1. Add failing tests for the centralized review call and canonical projection.
2. Add failing tests for fail-closed `error`/degraded review behavior.
3. Add structured task-review event support with legacy reads.
4. Replace MCP-pool local review implementation with the centralized call.
5. Add native-result path parity.
6. Update `recordWaveResult` to consume canonical projections.
7. Delete obsolete review implementation and tests.
8. Update documentation.
9. Run focused review/wave/commit tests, then the full repository suite.

## Acceptance criteria

- Agent-dispatch is the only module implementing review chunking, retries, reconciliation, findings extraction, and verdict semantics.
- Masterplan makes one explicit centralized review call per completed task when review is enabled.
- The exact full edit-locus diff is bound to the durable task review by SHA-256.
- Canonical structured findings and harness metadata persist without prose parsing.
- `rework`, `reject`, `error`, and incomplete harness coverage surface in `blocking_reviews[]`.
- A failed mandatory review cannot satisfy re-entry or silently advance the wave.
- D6 behavior is unchanged and independently tested.
- MCP-pool and native execution paths have review parity.
- Existing dirty `AGENTS.md` and `WORKLOG.md` remain untouched.
- No agent-dispatch files are modified by this implementation.

## Assumptions and resolved decisions

| Question | Decision | Rationale | Source |
|---|---|---|---|
| Where should review behavior live? | Agent-dispatch only | It already owns the canonical review module and structured record. | user-confirmed |
| Is review implicit in `dispatch_task`? | No; masterplan calls review explicitly. | Code inspection found no automatic post-writer review call. | investigated |
| Review granularity | One review per completed task. | Preserves durable task attribution and the existing completion protocol. | user-confirmed |
| Review payload | Full edit-locus working diff. | Preserves visibility of undeclared writes and D6 independence. | user-confirmed |
| Design review after brainstorming | Omitted. | User explicitly directed immediate spec writing. | user-confirmed |
| Failure posture | Fail closed for mandatory execution review. | Central policy states execution review timeout/error is a failure, not a skip. | investigated |
| Agent-dispatch edits | None. | The existing centralized interface is sufficient for the migration. | assumed |
