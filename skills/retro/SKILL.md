---
name: retro
description: Generate or re-run a retrospective for a completed plan. Equivalent to `/masterplan retro [<slug>]`.
---

# Masterplan: retro

This skill is the autocomplete-friendly entry point for `/masterplan retro`.

Load the router at `commands/masterplan.md` and dispatch the `retro` verb with `$ARGUMENTS` (optional plan slug). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Load `parts/step-c.md` and invoke the Step R subroutine.

Equivalent invocation: `/masterplan retro $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
