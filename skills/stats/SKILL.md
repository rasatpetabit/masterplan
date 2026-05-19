---
name: stats
description: Codex-vs-inline routing distribution, inline model breakdown, and token totals across plans. Equivalent to `/masterplan stats [--plan=<slug>] [--format=table|json|md] [--all-repos] [--since=<date>]`.
---

# Masterplan: stats

This skill is the autocomplete-friendly entry point for `/masterplan stats`.

Load the router at `commands/masterplan.md` and dispatch the `stats` verb with `$ARGUMENTS` (optional `--plan=<slug>` / `--format=...` / `--all-repos` / `--since=<date>`). The router will:

1. Run Step 0 bootstrap from `parts/step-0.md`.
2. Run the Step T subroutine inline (no additional phase file loaded).

Equivalent invocation: `/masterplan stats $ARGUMENTS`.

See the verb dispatch table in `commands/masterplan.md` for routing details.
