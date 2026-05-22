# Orchestrator Internals — Index

> Detailed documentation has moved to focused docs below. This file is a navigation index.

## Coordinator Docs (v6.0.0+)

| Doc | Content | Phase file |
|---|---|---|
| [brainstorm-anchor.md](internals/brainstorm-anchor.md) | Anchor classification, Haiku A/B/C briefs, merge rules | `parts/step-b.md` |
| [doctor.md](internals/doctor.md) | All checks, fix procedures, extended rationale | `parts/doctor.md` |
| [task-verification.md](internals/task-verification.md) | PASS patterns, trust-skip, G.1 mitigation | `parts/step-c-verification.md` |
| [bundle-resume.md](internals/bundle-resume.md) | Resume controller, state.yml field semantics | `parts/step-c-resume.md` |
| [plan-parser.md](internals/plan-parser.md) | Plan annotation format, eligibility cache build | `parts/step-c-dispatch.md` |
| [wave-dispatch.md](internals/wave-dispatch.md) | Wave batch assembly, Codex routing decision tree | `parts/step-c-dispatch.md` |
| [coordinator-pattern.md](internals/coordinator-pattern.md) | Adding coordinators, CD-7 compliance, versioning | `parts/contracts/coordinator.md` |
| [failure-instrumentation.md](internals/failure-instrumentation.md) | Anomaly detection, auto-filing, policy-regression watcher | `hooks/masterplan-telemetry.sh` §9 |

## Architecture Overview

- **Router + verbs:** `commands/masterplan.md`
- **Bootstrap + Codex detection:** `parts/step-0.md`
- **CD rules, run-bundle schema, agent-dispatch, coordinator contract:** `parts/contracts/`

## Migration Note

Previous links `docs/internals.md §<section>` → update to the specific coordinator doc containing that section (sections use the same names).
