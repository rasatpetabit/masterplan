---
name: masterplan-detect
description: Suggest `/masterplan import` only when legacy masterplan bundle state files (`docs/masterplan/<slug>/state.yml` at schema 5.x) exist without a matching v8 run. Generic planning artifacts (PLAN.md, TODO.md, ROADMAP.md, design docs, PR task lists) are NOT importable — no `/masterplan import` can ingest them; mention them only as context that a fresh `/masterplan brainstorm` would be the path to bring ideas under the schema. Surfaces a one-line suggestion only — never auto-runs.
---

## Central agent policy

AUQ, Serena, Hindsight, context-mode, and agent policy is centralized in `AGENTS.md` (routing resolves from `policy/workflow-map.json`; fleet policy at `/srv/workflows/policy/dispatch.md`). This skill must not duplicate or override dispatch rules. User-facing choices must use `ask_user_question` / `AskUserQuestion`, never prose questions.


# Detecting legacy masterplan bundles for /masterplan import

This skill **suggests**, it does not act. The user must explicitly run `/masterplan import` (or, for non-importable artifacts, a fresh `full`/`brainstorm`) to act.

`/masterplan import` is **not** a generic legacy-document importer. It maps to `mp migrate-bundle`, which ingests
only a **legacy masterplan bundle's `state.yml`** (schema_version 5.x) and re-freezes it into a v8 run. It cannot
convert arbitrary planning markdown (`PLAN.md`, `TODO.md`, `ROADMAP.md`, design/RFC docs, PR task lists). Those have
no import path — the honest suggestion for them is a fresh `/masterplan brainstorm` seeded from the repo context,
never a claim that import will ingest them.

## When to fire

The user is in a git repo and at least one of these is true:

- A legacy masterplan bundle exists at `docs/masterplan/<slug>/state.yml` whose `schema_version` is **5.x** (or
  predates 5.0, which import will refuse) and there is no matching already-migrated v8 run for the same `<slug>`.

That is the entire importable surface. The following are **not** importable, so they do not by themselves warrant
an import suggestion:

- A planning-shaped file lives at the repo root or in a common docs directory:
  - `PLAN.md`, `TODO.md`, `ROADMAP.md`, `WORKLOG.md`, `NOTES.md`
  - `docs/plans/*.md`, `docs/design/*.md`, `docs/rfcs/*.md`, `architecture/*.md`, `specs/*.md`
- A pre-v3 masterplan artifact exists under `docs/superpowers/{plans,specs,retros,archived-plans,archived-specs}` and there is no matching `docs/masterplan/<slug>/state.yml`.
- An open feature branch (not yet merged into the trunk) has descriptive name + commit history that suggests a tracked feature, but no masterplan status file exists for it.
- A draft PR's body contains a task list (`- [ ]` / `- [x]` / numbered steps).

For any of these, the actionable masterplan step is a fresh `full`/`brainstorm` run seeded from the repo context —
not `/masterplan import`.

Fire at **natural break points**: a fresh conversation in this repo, a user asking "what should I work on?", a user about to start a new feature. Don't interrupt unrelated work.

## What to surface

A short message — no prose, no editorialization. Format:

> I see <N> legacy masterplan bundle(s) in this repo not yet migrated to a v8 run:
> - `<path to state.yml>` — schema_version <v>
> - `<path to state.yml>` — schema_version <v>
>
> Run `/masterplan import` to migrate the 5.x bundle(s) to a v8 run (backs up the original).
> Bundles below 5.0 are refused — treat those as read-only and seed a fresh run instead.
> This is a suggestion only — no action taken.

Don't list more than 5 bundles. If more exist, say "(plus N more — check each
`docs/masterplan/<slug>/state.yml` for `schema_version: 5.x`)".

If the user instead has generic planning markdown (PLAN/TODO/ROADMAP/design docs, PR task lists),
say plainly that `/masterplan import` cannot ingest those and suggest a fresh `full`/`brainstorm` run
seeded from the repo context.

## What NOT to do

- **Do not** invoke `/masterplan` yourself. Only the user can.
- **Do not** read or modify the legacy bundle files. Use `Glob` (always-available Claude Code tool) for their existence and grep for the `schema_version` line. The shell snippets in **Detection commands** below give richer matching where `fd`/`rg` are installed; fall back to `Glob`/`grep` when they aren't. The actual migration happens during `/masterplan import` (`mp migrate-bundle`).
- **Do not** fire on every conversation in the repo — once per session is enough. If the user has already declined or run import this session, stay silent.
- **Do not** fire if the user is mid-task on something unrelated. Wait for a natural break.

## Detection commands

```bash
# Legacy masterplan bundles not yet migrated to a v8 run (the ONLY importable surface).
# A bundle is importable when docs/masterplan/<slug>/state.yml exists with schema_version 5.x.
for state in docs/masterplan/*/state.yml; do
  [[ -f "$state" ]] || continue
  v="$(grep -m1 '^schema_version:' "$state" | sed 's/^schema_version:[[:space:]]*//')"
  major="${v%%.*}"
  if [[ "$major" == "5" ]]; then
    echo "$state (schema $v)"
  elif [[ -n "$v" && "$major" -lt 5 ]]; then
    echo "$state (schema $v — BELOW 5.0, import will refuse; seed a fresh run)"
  fi
done
```

Use whichever commands are available; degrade gracefully if `fd`, `rg`, or `gh` aren't installed.

Generic planning markdown (PLAN/TODO/ROADMAP/NOTES/design docs, PR task lists) is **not** part of the
import surface — do not run import-specific detection over it.
