# Intra-plan task parallelism (status notes)

**Status:** Slice α (read-only parallel waves) shipped in v2.0.0. Slice β (serialized-commit waves) and Slice γ (full per-task worktree subsystem) remain deferred with a sharpened, measurable revisit trigger (below).

**Spec for Slice α:** [`docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md`](../superpowers/specs/2026-05-03-intra-plan-parallelism-design.md) — read for the full design, the failure-mode catalog (FM-1 through FM-6), the mitigation depth-pass, and the acceptance criteria.

**Implementation reference:** [`docs/internals.md`](../internals.md) §7 (Wave dispatch + failure-mode catalog) for the always-loaded-after-CLAUDE.md deep-dive.

## What ships in Slice α

Read-only parallel waves only — verification, inference, lint, type-check, doc-generation tasks declared via `parallel-group:` annotations dispatch as concurrent waves in Step C step 2. Implementation tasks (anything that commits) remain serial under the existing per-task Step C loop.

Supporting infrastructure (single-writer status funnel, scope-snapshot eligibility cache pin, files-filter, wave-aware activity log rotation, three new doctor checks #15-17, two new telemetry fields `tasks_completed_this_turn` + `wave_groups`, new `parallelism:` config block, `--no-parallelism` flag) lands in v2.0.0 and is reusable for Slice β/γ when (if) implemented. The expensive piece deferred (per-task git worktree subsystem) becomes a smaller incremental cost on top.

See spec §1 (Architecture overview) and §6 (Migration + integration) for the integration surface.

## What's deferred (Slice β / Slice γ)

- **Slice β (~8-10 days estimated):** Parallel committing-task waves with serialized commits funneled through the orchestrator. Wave members do work concurrently but the commit step is serial. Latency win is partial; matches user expectation of "intra-plan parallelism" but the savings are smaller than the framing suggests.
- **Slice γ (~10-15 days estimated):** Full per-task git worktree subsystem — the original deferred design's ambition. Each parallel implementation task dispatches into its own temp worktree; merge commits back to canonical branch at wave-end (fast-forward when possible, conflict-abort otherwise per CD-2). Real parallel committing-task execution. Cost the prior deferral was honest about.

The choice between Slice β and Slice γ at next revisit is a function of how often the trigger condition fires and whether a serialized-commit funnel is sufficient or whether the latency cost demands true commit parallelism.

## Sharpened revisit trigger

An earlier trigger was *"real plans show parallel-friendly task patterns and the latency cost becomes felt"* — unmeasurable. The v2.0.0 sharpened trigger:

> **Revisit Slice β** when a real `/masterplan` plan shows ≥3 parallel-grouped committing tasks where the wave's serial wall-clock cost exceeds 10 minutes AND the committed work is independent enough for the Slice α `**Files:**` exhaustive-scope rule to apply.
>
> **Revisit Slice γ** when ≥3 such β-eligible waves accumulate within a single plan's lifecycle, indicating a structural pattern that warrants the full per-task worktree subsystem.

Doctor check candidate (deferred to v2.0.x): scan completed-and-recent plans for the trigger condition; surface as a one-line note in `/masterplan status`. The telemetry fields `tasks_completed_this_turn` and `wave_groups` (added in v2.0.0) provide the data — see [`telemetry-signals.md`](./telemetry-signals.md)'s "Average tasks-per-wave-turn" jq example.

## Failure-mode catalog (capsule summary)

The full catalog with worked examples lives in the spec. Brief summary of the six modes Slice α addresses:

- **FM-1: Eligibility-cache invalidation** under in-wave plan edits — addressed by M-2 (cache pin) + CD-2 in-wave scope rule.
- **FM-2: Activity log rotation race** — addressed by M-1 (wave-aware single-writer rotation).
- **FM-3: Status file write contention** — addressed by M-1 (single-writer funnel; orchestrator as canonical writer).
- **FM-4: Codex routing as serializing sync point** — addressed by Slice α eligibility rule 4 (Codex tasks fall out of waves).
- **FM-5: Worktree integrity check ambiguity** — addressed by M-3 (files-filter union under wave).
- **FM-6: SDD is structurally serial** — addressed for read-only work by M-4a (SDD wrapper). Committing work is the deferred concern; per-task worktree subsystem (Slice γ) is the cheapest mitigation.

## Earlier deferred-design notes (superseded)

Prior to v1.0.0, this work was repeatedly deferred. Earlier notes sketched annotation schema, required machinery, why deferred, and when to revisit — all superseded by the v1.0.0-era catalog and the Slice α spec. Their substance is captured in:

- `parallel-group:`, `**Files:**`-as-exhaustive-scope, optional `**non-committing:**` annotations (Slice α spec §2)
- per-task git worktree isolation (deferred to Slice γ; documented as cheapest committing-work mitigation)
- single-writer status file (now M-1, shipped in Slice α)
- per-task verification with rollback policy (now Slice α failure handling, partial scope)
- the original "when to revisit" trigger is sharpened and measurable in this doc (above)

The pre-v1.0.0 deferral chain ended in v2.0.0 with the Slice α release. Future deferrals (Slice β/γ) are tracked via the sharpened trigger above and the v2.0.x doctor check candidate.
