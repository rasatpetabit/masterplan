---
name: next
description: Scan active plans and completed-plan follow-ups, then offer resume/follow-up/new-plan/status options via AskUserQuestion ("what's next?" router). Equivalent to `/masterplan next`.
---

# Masterplan: next

This skill is the autocomplete-friendly entry point for `/masterplan next`.

Load the router at `commands/masterplan.md` and dispatch the `next` verb (no args). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Run the Step N subroutine inline (no additional phase file loaded).

Never starts a brainstorm about the topic "next" — the verb is reserved (see CC-1 in `commands/masterplan.md`).

Equivalent invocation: `/masterplan next`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
