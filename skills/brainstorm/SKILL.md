---
name: brainstorm
description: Brainstorm and write a spec for a topic. Equivalent to `/masterplan brainstorm <topic>`. Halts at the B1 close-out gate (halt_mode=post-brainstorm).
---

# Masterplan: brainstorm

This skill is the autocomplete-friendly entry point for `/masterplan brainstorm`.

Load the router at `commands/masterplan.md` and dispatch the `brainstorm` verb with `$ARGUMENTS` (the topic). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Load `parts/step-b.md` for brainstorm phase logic.
3. Halt at the B1 post-brainstorm close-out gate.

Equivalent invocation: `/masterplan brainstorm $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
