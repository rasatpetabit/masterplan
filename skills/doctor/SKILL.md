---
name: doctor
description: Run all masterplan doctor checks — state, manifests, plan format, router byte ceiling, codex auth, version drift, etc. Equivalent to `/masterplan doctor [--fix]`.
---

# Masterplan: doctor

This skill is the autocomplete-friendly entry point for `/masterplan doctor`.

Load the router at `commands/masterplan.md` and dispatch the `doctor` verb with `$ARGUMENTS` (optional `--fix` for safe auto-fixes). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Load `parts/doctor.md` and run all checks (Step D).

Equivalent invocation: `/masterplan doctor $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
