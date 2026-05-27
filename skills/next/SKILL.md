---
name: next
description: "What's-next router: inspect active bundle state and suggest the correct follow-up verb."
---

<!-- masterplan verb: next -->

Invoke the masterplan **`next`** workflow. Load `commands/masterplan.md` from the plugin root and proceed with `requested_verb = "next"`. Reads active `state.yml`, resolves any pending gates, and emits a specific recommended next action.

Find `commands/masterplan.md` using the resolution order documented in `skills/masterplan/SKILL.md`.
