---
type: index
resource: /srv/dev/okf-workspace/repos/ras/masterplan.md
title: masterplan — OKF knowledge catalog
timestamp: 2026-07-13T00:00:00Z
privacy: private
tags: [masterplan, claude-code, codex, plugin, orchestration, agents]
---

# masterplan

`masterplan` is a Claude Code and Codex CLI plugin implementing the
`/masterplan` command: a resumable **brainstorm → plan → execute → finish**
workflow for durable multi-hour engineering work, built on top of the
`obra/superpowers` skills suite. Current release: v9.5.0 (MIT license).

The core design principle is that **state lives on disk, not in the chat
session** — a run bundle at `docs/masterplan/<slug>/` (`state.yml`, `spec.md`,
`plan.md`, `plan.index.json`, `events.jsonl`, `retro.md`, `handoff.md`) is the
single source of truth, so a crashed/compacted/cleared session can re-read the
bundle and resume exactly where it left off.

## Tech stack

- Node.js (>=20, ESM), plain `.mjs` — no framework
- Claude Code plugin/skill/agent markdown (`.claude-plugin/`, `commands/`, `agents/`, `skills/`)
- Codex CLI plugin hosting
- `node --test` for unit tests
- git for state/branch management

## Architecture (five layers)

| Layer | Component | Role |
|---|---|---|
| L0 | `docs/masterplan/<slug>/` run bundle | Durable disk state: `state.yml`, `spec.md`, `plan.md`, `plan.index.json`, `events.jsonl`, `retro.md`, `handoff.md` |
| L1 | `commands/masterplan.md` (~800-line sequencer), `bin/masterplan.mjs` (`mp` CLI), `lib/resume.mjs` (`decideNextAction`) | Thin shell; **sole durable state writer**; owns git commit/checkout |
| L2 | `workflows/execute.workflow.js`, `workflows/plan.workflow.js`, `lib/plan-merge.mjs`, `lib/dispatch/`, `lib/wave.mjs` | Workflow engine; one wave per launch; returns digests/fragments only, never writes disk/git |
| L3 | `agents/mp-*.md` (explorer, implementer, planner, adversarial-reviewer, plan-reviewer, spec-decomposer, subsystem-planner) | Stateless subagents dispatched per task |
| L4 | `bin/doctor.mjs`, `lib/doctor/*.mjs` | Structural lint across 17 auto-discovered check modules (incl. `pi-agent-registration`); validates run-bundle integrity |

## Key components

- `commands/masterplan.md` — L1 orchestrator/sequencer prompt
- `bin/masterplan.mjs` (`mp`) — filesystem-only deterministic CLI, unit-tested
- `lib/*.mjs` — deterministic decision logic (`resume.mjs`, `bundle.mjs`, `wave.mjs`, `plan-merge.mjs`, `dispatch/`, `doctor/`, `worktree.mjs`, `github-coord.mjs`, ...)
- `workflows/execute.workflow.js`, `workflows/plan.workflow.js` — L2 workflow engine
- `agents/mp-*.md` — L3 stateless subagents
- `bin/doctor.mjs` + `lib/doctor/*.mjs` — L4 structural lint
- `skills/masterplan`, `skills/masterplan-detect` — Claude Code skill definitions

## Lifecycle

```
brainstorm → plan → execute → finish
```

`state.yml`'s `phase` field holds `brainstorm|plan|execute`; **finish** is a
terminal finalization flow (verification → `retro.md` → branch-finish gate →
archive) that fires automatically when the last execute wave completes — it
is not itself a `phase` value.

## Pointers to existing docs

- [`README.md`](../README.md) — public overview, architecture diagram, install/usage
- [`docs/internals.md`](../docs/internals.md) — index into layer-by-layer internals
- [`docs/internals/bundle-resume.md`](../docs/internals/bundle-resume.md) — L0/L1 resume engine
- [`docs/internals/wave-dispatch.md`](../docs/internals/wave-dispatch.md) — L2 wave-dispatch engine
- [`docs/internals/doctor.md`](../docs/internals/doctor.md) — L4 doctor subsystem
- [`docs/internals/plan-parser.md`](../docs/internals/plan-parser.md), [`docs/internals/task-verification.md`](../docs/internals/task-verification.md), [`docs/internals/deferred-followups.md`](../docs/internals/deferred-followups.md) — other internals
- [`docs/conventions/cd-rules.md`](../docs/conventions/cd-rules.md) — cross-cutting CD-1..CD-10 rules
- [`docs/conventions/plan-annotations.md`](../docs/conventions/plan-annotations.md) — plan-field contract
- [`docs/development.md`](../docs/development.md) — build/test/lint, contributor discipline
- [`docs/coordination-playbook.md`](../docs/coordination-playbook.md) — multi-agent GitHub-issue coordination (`mp:run-<slug>` publish/follow)
- [`CHANGELOG.md`](../CHANGELOG.md) — release history and decision rationale
- `AGENTS.md` / `CLAUDE.md` — defer cross-repo agent policy (AUQ, Serena, Hindsight, model routing) to `policy/workflow-map.json` and the fleet dispatch policy at `/srv/workflows/policy/dispatch.md`


## Recent routing / registration notes

- **All `mp-*` agents** declare a routing-policy **lane name** as `model:` (e.g.
  `frontier`) and are resolved to the lane's model ref from
  `policy/workflow-map.json` (`frontier` → `litellm/gpt-5.6-sol`).
- **New seeds default fabric on:** `mp seed` writes `state.dispatch.fabric: true`; fabric is the only wave path since the L2 legacy `launch_workflow` / `dispatch_foreground` path was deleted (A3) — the flag's `off` value is gone.
- **Pi registration is bare-only:** `bin/register-pi-agents.mjs` writes `mp-*.md`
  under `~/.pi/agent/agents/`; managed `masterplan:mp-*` leftovers are removed;
  doctor check `pi-agent-registration` surfaces host drift.
- Archived runs of note: `dispatch-subagent-reconcile`, `fabric-default-dual-reg`.

## Subsystem references in this catalog

- [`bundle-resume-engine.md`](./bundle-resume-engine.md)
- [`wave-dispatch-engine.md`](./wave-dispatch-engine.md)
- [`doctor-structural-lint.md`](./doctor-structural-lint.md)
</content>
