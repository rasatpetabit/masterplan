---
name: superflow-detect
description: Suggest `/superflow import` when legacy planning artifacts (PLAN.md, TODO.md, ROADMAP.md, orphan superpowers plans, branches without merged PRs, draft PRs with task lists) exist in the repo. Surfaces a one-line suggestion only — never auto-runs.
---

# Suggesting /superflow import for legacy planning artifacts

This skill **suggests**, it does not act. The user must explicitly run `/superflow import` to convert anything.

## When to fire

The user is in a git repo and at least one of these is true:

- A planning-shaped file lives at the repo root or in a common docs directory:
  - `PLAN.md`, `TODO.md`, `ROADMAP.md`, `WORKLOG.md`, `NOTES.md`
  - `docs/plans/*.md`, `docs/design/*.md`, `docs/rfcs/*.md`, `architecture/*.md`, `specs/*.md`
- A plan exists at `docs/superpowers/plans/*.md` with **no** sibling `*-status.md` (orphan from pre-superflow runs).
- An open feature branch (not yet merged into the trunk) has descriptive name + commit history that suggests a tracked feature, but no superflow status file exists for it.
- A draft PR's body contains a task list (`- [ ]` / `- [x]` / numbered steps).

Fire at **natural break points**: a fresh conversation in this repo, a user asking "what should I work on?", a user about to start a new feature. Don't interrupt unrelated work.

## What to surface

A short message — no prose, no editorialization. Format:

> I see <N> existing planning artifact(s) in this repo:
> - `<path>` — last modified <date>
> - `<path>` — last modified <date>
>
> If you'd like to bring them under the `/superflow` schema (spec + plan + status with completion-state inference, so already-done tasks aren't redone), run `/superflow import`. This is a suggestion only — no action taken.

Don't list more than 5 artifacts. If more exist, say "(plus N more — `/superflow import` will discover them all)".

## What NOT to do

- **Do not** invoke `/superflow` yourself. Only the user can.
- **Do not** read or modify the legacy artifacts. Use `Glob` (always-available Claude Code tool) for their existence and stat for last-modified. The shell snippets in **Detection commands** below give richer matching (depth/exclude/ignore-dir semantics) where `fd` is installed; fall back to `Glob` when it isn't. The actual content reading happens during `/superflow import`.
- **Do not** fire on every conversation in the repo — once per session is enough. If the user has already declined or run import this session, stay silent.
- **Do not** fire if the user is mid-task on something unrelated. Wait for a natural break.

## Detection commands

```bash
# Local plan files (excluding archives and superpowers state)
fd -t f -E 'node_modules' -E 'vendor' -E '.git' -E 'legacy' \
  '^(PLAN|TODO|ROADMAP|WORKLOG|NOTES)\.md$' .
fd -t f -E 'node_modules' '\.md$' docs/plans docs/design docs/rfcs architecture specs 2>/dev/null

# Orphan superpowers plans
for plan in docs/superpowers/plans/*.md; do
  [[ "$plan" == *-status.md ]] && continue
  base="${plan%.md}"
  [[ ! -f "${base}-status.md" ]] && echo "$plan"
done

# Open branches with no merged PR (requires gh)
gh pr list --state=all --limit=200 --json=headRefName,state | \
  jq -r '.[] | select(.state != "MERGED") | .headRefName'
```

Use whichever commands are available; degrade gracefully if `fd` or `gh` aren't installed.
