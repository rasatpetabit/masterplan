---
name: execute
description: Resume execution of an existing plan from its state.yml. Equivalent to `/masterplan execute <state-path>` or `/masterplan execute` to pick from existing plans.
---

# Masterplan: execute

This skill is the autocomplete-friendly entry point for `/masterplan execute`.

Load the router at `commands/masterplan.md` and dispatch the `execute` verb with `$ARGUMENTS` (a state-path, or empty to invoke the resume picker). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Load `parts/step-c.md` (state-path resumes) or `parts/step-a.md` (no args → picker).
3. Resume the current task from `state.yml`.

Equivalent invocation: `/masterplan execute $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
