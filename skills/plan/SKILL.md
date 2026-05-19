---
name: plan
description: Brainstorm and write a run bundle plan, or plan against an existing spec. Equivalent to `/masterplan plan <topic>` or `/masterplan plan --from-spec=<path>`. Halts at the B3 close-out gate (halt_mode=post-plan).
---

# Masterplan: plan

This skill is the autocomplete-friendly entry point for `/masterplan plan`.

Load the router at `commands/masterplan.md` and dispatch the `plan` verb with `$ARGUMENTS` (a topic, `--from-spec=<path>`, or empty for spec-pick). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Load `parts/step-a.md` (for spec-pick) or `parts/step-b.md` (for new brainstorm).
3. Halt at the B3 post-plan close-out gate.

Equivalent invocation: `/masterplan plan $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
