---
name: validate
description: Read-only config + state schema validation; checks `.masterplan.yaml` against built-in defaults and (with `--plan`) validates that plan's `state.yml`. Equivalent to `/masterplan validate [--plan=<slug>]`.
---

# Masterplan: validate

This skill is the autocomplete-friendly entry point for `/masterplan validate`.

Load the router at `commands/masterplan.md` and dispatch the `validate` verb with `$ARGUMENTS` (optional `--plan=<slug>`). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Read `docs/config-schema.md` inline and run config/state schema validation.

Equivalent invocation: `/masterplan validate $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
