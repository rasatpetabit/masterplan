---
name: status
description: Read-only situation report across active plans, or one-plan drilldown. Equivalent to `/masterplan status [--plan=<slug>]`.
---

# Masterplan: status

This skill is the autocomplete-friendly entry point for `/masterplan status`.

Load the router at `commands/masterplan.md` and dispatch the `status` verb with `$ARGUMENTS` (optional `--plan=<slug>`). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Run the Step S subroutine inline (no additional phase file loaded).

Equivalent invocation: `/masterplan status $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
