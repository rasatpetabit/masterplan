# Orchestrator Internals — Index

> Navigation index for detailed internals documentation. Each leaf covers one
> subsystem grounded in the v8 source.

## Architecture Overview

masterplan v8 is a 5-layer system. Each layer is thin and delegates downward:

- **L0 — Run bundle (disk):** `docs/masterplan/<slug>/` holds `state.yml`
  (CD-7 single writer, atomic tmp+rename), `spec.md`, `plan.md`,
  `plan.index.json`, `retro.md`, `events.jsonl` (append-only), and
  `handoff.md`. The `phase` field in `state.yml` is the only authoritative
  progress enum (`brainstorm | plan | execute`).
- **L1 — Thin shell:** `commands/masterplan.md` (~251-line verb sequencer) +
  `bin/masterplan.mjs` (filesystem-only subcommands, invoked as `mp`; git stays
  in the shell) + `lib/resume.mjs` (pure `decideNextAction`). L1 is the
  **only** durable writer of run-bundle state (CD-7).
- **L2 — Workflow engine:** `workflows/execute.workflow.js` (one wave per
  launch via `pipeline(tasks, implement, review)`) and
  `workflows/plan.workflow.js` (subsystem fan-out via `parallel()`). Workflows
  return digests and fragments only — never write to disk directly.
- **L3 — Agents:** seven markdown agent briefs under `agents/` (`mp-explorer`,
  `mp-implementer`, `mp-planner`, `mp-codex-reviewer`, `mp-plan-reviewer`,
  `mp-subsystem-planner`, `mp-spec-decomposer`). Agents receive bounded briefs
  and return structured output; they do not inherit session history.
- **L4 — Doctor:** `bin/doctor.mjs` dispatcher + 11 check modules under
  `lib/doctor/*.mjs`. Auto-discovered alphabetically; each module exports a
  synchronous `check(repoRoot, opts) -> Finding[]`. See `doctor.md` below.

Deterministic planning support: `lib/plan-merge.mjs` merges drafter fragments
into a canonical `plan.index.json` using Kahn topological order for wave
assignment. Task routing decisions live in `lib/routing.mjs`. Scope
verification (D6) runs in `lib/wave.mjs`.

## Run-bundle State Shape & Stop Contract

`state.yml` is the CD-7 single source of truth. Beyond `phase`, the loop-first
stop/resume contract turns on two fields:

```yaml
stop_reason: null | question | critical_error | complete | scheduled_yield
critical_error: null
```

**Blocked means critical error only.** Routine blockers, quota exhaustion, weak
gate evidence, host-budget yields, and background polling all stay
`status: in-progress` with `stop_reason: question` or `scheduled_yield`. Set
`status: blocked` only together with `stop_reason: critical_error` and a
populated `critical_error` object. The `stop_kind` classifier in
`lib/masterplan_session_audit.py` enforces this mapping; the resume controller
that reads it back is documented in
[bundle-resume.md](internals/bundle-resume.md).

## Core Mechanisms Map

| Leaf | What it documents | Primary source |
|---|---|---|
| [bundle-resume.md](internals/bundle-resume.md) | Resume controller: how `lib/resume.mjs` reads `state.yml` and decides the next action | `lib/resume.mjs` |
| [plan-parser.md](internals/plan-parser.md) | Deterministic plan compile: fragment merge, wave assignment, `plan.index.json` schema | `lib/plan-merge.mjs` |
| [wave-dispatch.md](internals/wave-dispatch.md) | Routing decisions and one-wave dispatch: how `lib/routing.mjs` classifies tasks and `workflows/execute.workflow.js` runs a single wave | `lib/routing.mjs` + `workflows/execute.workflow.js` |
| [task-verification.md](internals/task-verification.md) | D6 scope verify and the review stage: acceptance criteria, trust-skip conditions | `lib/wave.mjs` |
| [doctor.md](internals/doctor.md) | Doctor contract: discovery, crash isolation, Finding shape, all 11 check modules | `bin/doctor.mjs` + `lib/doctor/*.mjs` |

## Cross-cutting References

- **Verb routing + sequencer logic:** `commands/masterplan.md` (the primary source;
  read this first for any orchestrator behaviour question).
- **CD rules (CD-1…CD-10):** canonical bodies live in
  [`docs/conventions/cd-rules.md`](conventions/cd-rules.md). CD-7 (single
  writer) and CD-4 (blocker ladder) are the ones most frequently referenced in
  the leaves above.
- **Plan annotation format:** [`docs/conventions/plan-annotations.md`](conventions/plan-annotations.md).
- **Codex failure policy:** [`docs/conventions/codex-failure-policy.md`](conventions/codex-failure-policy.md).
- **Deferred follow-ups:** [deferred-followups.md](internals/deferred-followups.md) — tracked, intentionally-deferred review findings (so they read as known, not as fresh churn).
- **Codex entrypoint skill:** [`skills/masterplan/SKILL.md`](../skills/masterplan/SKILL.md)
  is the Codex-visible entrypoint — it loads `commands/masterplan.md` as the
  behaviour source of truth, points Codex at existing `docs/masterplan/*/state.yml`
  run bundles, and adapts tool names for the Codex host.
- **Codex host suppression:** when masterplan runs *inside* Codex
  (`/masterplan:masterplan`), §0 host-detect sets `codex_host_suppressed=true`:
  it skips the Codex availability ping/scan/trust checks and treats effective
  `codex_routing` / `codex_review` as off for that invocation **without**
  rewriting persisted config, preventing recursive Codex-on-Codex dispatch.
  Persisted defaults such as `autonomy`, `complexity`, and `parallelism` are
  unaffected, and the suppressed run still scans existing run bundles. Routing
  precedence detail: [wave-dispatch.md](internals/wave-dispatch.md).
