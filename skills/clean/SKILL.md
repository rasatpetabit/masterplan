---
name: clean
description: Archive completed bundles, retire migrated legacy artifacts, and prune orphan state. Equivalent to `/masterplan clean [--dry-run] [--delete] [--category=<name>] [--worktree=<path>]`.
---

# Masterplan: clean

This skill is the autocomplete-friendly entry point for `/masterplan clean`.

Load the router at `commands/masterplan.md` and dispatch the `clean` verb with `$ARGUMENTS` (optional `--dry-run` / `--delete` / `--category=<name>` / `--worktree=<path>`). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Run the Step CL subroutine inline (no additional phase file loaded).

Equivalent invocation: `/masterplan clean $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
