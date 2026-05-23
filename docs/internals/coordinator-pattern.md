# Coordinator Pattern — Internals

> **Audience:** Maintainers adding new coordinators.
> **Contract:** `parts/contracts/coordinator.md`.

## When to Add a Coordinator

Add a coordinator when:
1. The orchestrator would load a file ≥20KB for a task.
2. The task is structurally read-only (builds a cache, classifies, runs verification).
3. A ≤1000-token JSON return captures everything the orchestrator needs to act.
4. The orchestrator would otherwise run 3+ consecutive Bash-type directives (inline reads, shell
   commands, external process invocations) feeding one decision without a Haiku gate — CC-2
   mandates a gate, and a coordinator is the preferred gate form when the read target is a
   structured artifact.

## Adding a New Coordinator

1. Choose a name: `coordinator-<descriptive-noun>`.
2. Choose tier: Haiku for mechanical tasks; Sonnet for judgment tasks.
3. Define return shape in `docs/internals/<name>.md §Return shape`.
4. Add to the Coordinator Catalog in `parts/contracts/coordinator.md`.
5. Add `DISPATCH-SITE: coordinator-<name>` as the first line of the brief at the call site.
6. Implement inline fallback at the call site.
7. Log fallback events as `{"event":"coordinator_fallback","site":"coordinator-<name>","reason":"<error>"}`.

## CD-7 Compliance

Coordinators MUST NOT write any run artifact. Return data only; the orchestrator performs all state mutations.

## Versioning

Bump `coordinator_version` in the return shape when adding required fields. The orchestrator uses this for cache invalidation.
