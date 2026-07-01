---
type: reference
title: masterplan — bundle/state resume engine
timestamp: 2026-07-01T00:00:00Z
privacy: private
tags: [masterplan, resume, state, bundle]
---

# Bundle/state resume engine

The L0 run bundle lives on disk at `docs/masterplan/<slug>/` (`state.yml`,
`spec.md`, `plan.md`, `plan.index.json`, `events.jsonl`, `retro.md`,
`handoff.md`) and is the single source of truth for an in-progress
`/masterplan` run. `lib/resume.mjs` exposes a pure function,
`decideNextAction`, that reads `state.yml` and returns the next step to take.
This is what lets a crashed, compacted, or cleared Claude Code session
re-read the bundle and pick up exactly where it left off, instead of relying
on chat context.

`bin/masterplan.mjs` (the `mp` CLI) is the **sole durable state writer** —
git commit/checkout for the run bundle happens only in this L1 layer, never
in the L2 workflow engine or L3 subagents. This single-writer discipline
(CD-7 in `docs/conventions/cd-rules.md`) is what keeps `state.yml` and
`events.jsonl` reliable as the persistence surface across sessions.

See [`docs/internals/bundle-resume.md`](../docs/internals/bundle-resume.md)
for the full design and failure modes.
</content>
