---
name: import
description: Convert legacy planning artifacts (PLAN.md, TODO.md, ROADMAP.md, pre-v3 superpowers plans, GitHub PRs/issues) into bundled docs/masterplan/<slug>/ state. Equivalent to `/masterplan import [--pr=<num>|--issue=<num>|--file=<path>|--branch=<name>]`.
---

# Masterplan: import

This skill is the autocomplete-friendly entry point for `/masterplan import`.

Load the router at `commands/masterplan.md` and dispatch the `import` verb with `$ARGUMENTS` (optional `--pr=<num>` / `--issue=<num>` / `--file=<path>` / `--branch=<name>` / `--archive` / `--keep-legacy`). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Load `parts/import.md` and run the legacy-migration phase (Step I).

Equivalent invocation: `/masterplan import $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
