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
