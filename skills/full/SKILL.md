---
name: full
description: Run a full masterplan kickoff (brainstorm → plan → execute) for a topic. Equivalent to `/masterplan full <topic>`. Routes through B0→B1→B2→B3→C without intermediate halt.
---

# Masterplan: full

This skill is the autocomplete-friendly entry point for `/masterplan full`.

Load the router at `commands/masterplan.md` and dispatch the `full` verb with `$ARGUMENTS` (the topic, e.g. `Stripe webhook handler`). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md` (config load, git_state cache, codex detection).
2. Load `parts/step-b.md` for brainstorm + plan phases (B0→B1→B2→B3).
3. Load `parts/step-c.md` for execution.

Equivalent invocation: `/masterplan full $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
