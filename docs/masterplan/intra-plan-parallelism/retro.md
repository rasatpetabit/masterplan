# Retrospective: intra-plan-parallelism

**Date:** 2026-05-13
**Status:** archived
**Outcome:** Spec-only design completed for Slice α read-only parallel waves; never executed as a standalone plan — implemented directly in v2.0+ wave dispatch.

## What happened

This was a design spec for the first shippable slice of intra-plan task parallelism in the superpowers-masterplan plugin. The spec defined read-only parallel waves gated by a `**parallel-group:**` annotation, an eligibility-cache snapshot (M-2), a single-writer funnel (M-1), a Codex fall-out rule (M-4), and a failure-mode catalog (FM-1 through FM-6). The plan was migrated from a legacy artifact (`docs/superpowers/archived-specs/2026-05-03-intra-plan-parallelism-design.md`) on 2026-05-08 and immediately archived because execution had already been superseded by the v2.0.0 wave dispatch implementation.

## What went well

- The FM-1–FM-6 failure-mode catalog was thorough enough to survive into v2.0+ as the authoritative failure taxonomy.
- Single-writer funnel (M-1) and eligibility-cache snapshot (M-2) translated directly into the orchestrator's wave commit logic with minimal adaptation.
- Spec-first approach kept implementation risk low: the design was validated against real orchestrator constraints before any code (prompt) was changed.
- Migration tooling (`bin/masterplan-state.sh`) made the legacy-to-bundle import clean and auditable.

## What could improve

- The spec was written outside the bundle system (legacy `docs/superpowers/` path) and had to be migrated retroactively — future specs should live in a proper run bundle from day one.
- No execution phase was planned, so the spec lacked acceptance criteria that could be mechanically verified; downstream v2.0 work had to re-derive them.
- Started date was not captured in `state.yml` (field is empty); retro is being written retroactively rather than at natural completion.

## Follow-up items

- None — wave dispatch (v2.0+) is the live descendant of this design and is tracked under its own run history.
