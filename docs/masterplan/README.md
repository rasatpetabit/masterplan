# Masterplan run bundles

Each `/masterplan` run owns one directory:

```text
docs/masterplan/<slug>/
  state.yml
  spec.md
  plan.md
  retro.md
  events.jsonl
  events-archive.jsonl
  eligibility-cache.json
  telemetry.jsonl
  subagents.jsonl
  state.queue.jsonl
```

`state.yml` is the durable source of truth. It is created before brainstorming
starts and carries the current phase, worktree, task pointer, artifact paths,
and any pending structured gate. `events.jsonl` is the append-only activity and
decision log; archive/telemetry/subagent/cache sidecars stay inside the same
run directory so a run has no orphaned artifacts.

On successful completion, `/masterplan` writes `retro.md`, flips `state.yml` to
archived, appends the archive event, and runs an archive-only cleanup of verified
legacy/orphan state. The completed run directory stays intact here; old
`docs/superpowers/...` copies are archived only after their `legacy:` pointers
match this bundle.

Older `/masterplan` versions wrote artifacts under `docs/superpowers/...`.
Use `/masterplan import` to migrate them into this layout. The migration
preserves old paths under `legacy:` and does not delete the original files.
