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
- **L1 — Thin shell:** `commands/masterplan.md` (~800-line verb sequencer) +
  `bin/masterplan.mjs` (filesystem-only subcommands, invoked as `mp`; git stays
  in the shell) + `lib/resume.mjs` (pure `decideNextAction`). L1 is the
  **only** durable writer of run-bundle state (CD-7).
- **L2 — Fabric dispatch path:** `lib/dispatch-wave.mjs` (`dispatchWaveViaFabric`,
  a thin orchestrator running 6 named stages: gateAndValidate →
  resolveWaveContext → buildDescriptors → acquireAndWatch → buildNativePlan →
  finalizeRecord). Invoked via `mp dispatch-wave --state=<path>`.
  The deleted Workflow engine (`workflows/execute.workflow.js`,
  `workflows/plan.workflow.js`) was replaced by the native spawn-plan path
  (one descriptor per task, executed by the harness's parallel subagent API).
- **L3 — Agents:** eight markdown agent briefs under `agents/` (`mp-explorer`,
  `mp-goal-assessor`, `mp-planner`, `mp-adversarial-reviewer`, `mp-plan-reviewer`,
  `mp-subsystem-planner`, `mp-spec-decomposer`, `mp-alignment-auditor`). Agents receive bounded briefs
  and return structured output; they do not inherit session history.
  Implementation dispatch routes through the routing policy — each task's
  class resolves to a governed lane (`policy/workflow-map.json`) and the
  harness spawns the child.
- **L4 — Doctor:** `bin/doctor.mjs` dispatcher + 19 check modules under
  `lib/doctor/*.mjs`. Auto-discovered alphabetically; each module exports a
  synchronous `check(repoRoot, opts) -> Finding[]`. See `doctor.md` below.

Deterministic planning support: `lib/plan-merge.mjs` merges drafter fragments
into a canonical `plan.index.json` using Kahn topological order for wave
assignment. Dispatch decisions (task routing, qctl backend gating, host
detection, wave-dispatch op shapes) live in the pure `lib/dispatch/`
package. Scope verification (D6) runs in `lib/wave.mjs`.

## Run-bundle State Shape & Task-status Lifecycle

`state.yml` is the CD-7 single source of truth. The resume controller that
reads the fields back is documented in [bundle-resume.md](internals/bundle-resume.md).

**Task-status lifecycle (D1–D5).** Per-task `status`
(`pending | in_progress | done | blocked | waived`) is distinct from the
run-level stop/resume behavior. `blocked`/`waived` are excluded from every
dispatch filter (`lib/resume.mjs`, `lib/wave.mjs`); `blocked` blocks finalize
(the `awaiting_waiver` op precedes `complete` in `decideNextAction`), `waived`
is terminal-but-reversible. `waived` is reachable only via `waive-task`
(`markTask` throws on it), closing the waived-bypass surface. The gate-review
content path (D6/D7) feeds artifact bytes to the cross-vendor reviewer via
the native review's `content` param rather than an empty git diff over untracked
artifacts — see `commands/masterplan.md` §3b.

## Core Mechanisms Map

| Leaf | What it documents | Primary source |
|---|---|---|
| [bundle-resume.md](internals/bundle-resume.md) | Resume controller: how `lib/resume.mjs` reads `state.yml` and decides the next action | `lib/resume.mjs` |
| [plan-parser.md](internals/plan-parser.md) | Deterministic plan compile: fragment merge, wave assignment, `plan.index.json` schema | `lib/plan-merge.mjs` |
| [wave-dispatch.md](internals/wave-dispatch.md) | Routing decisions and one-wave dispatch: how `lib/dispatch/` classifies tasks and `lib/dispatch-wave.mjs` runs a single wave | `lib/dispatch/` + `lib/dispatch-wave.mjs` |
| [task-verification.md](internals/task-verification.md) | D6 scope verify and the review stage: acceptance criteria, trust-skip conditions | `lib/wave.mjs` |
| [doctor.md](internals/doctor.md) | Doctor contract: discovery, crash isolation, Finding shape, all 19 check modules | `bin/doctor.mjs` + `lib/doctor/*.mjs` |

## Cross-cutting References

- **Verb routing + sequencer logic:** `commands/masterplan.md` (the primary source;
  read this first for any orchestrator behaviour question).
- **CD rules (CD-1…CD-10):** canonical bodies live in
  [`docs/conventions/cd-rules.md`](conventions/cd-rules.md). CD-7 (single
  writer) and CD-4 (blocker ladder) are the ones most frequently referenced in
  the leaves above.
- **Build/test/lint + contributor discipline:** [`docs/development.md`](development.md)
  — the test/doctor commands plus the masterplan-specific working rules
  (single-writer state, dispatch discipline, sync'd verb/doctor surfaces,
  cross-vendor review).
- **Plan annotation format:** [`docs/conventions/plan-annotations.md`](conventions/plan-annotations.md).
- **Adversarial review failure policy:** [`docs/conventions/adversarial-review-failure-policy.md`](conventions/adversarial-review-failure-policy.md).
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
