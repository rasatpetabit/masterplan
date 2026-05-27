---
name: execute
description: "Execute or resume an active plan bundle; auto-picks active state.yml or prompts for selection."
---

<!-- masterplan verb: execute -->

Invoke the masterplan **`execute`** workflow. Load `commands/masterplan.md` from the plugin root and proceed with `requested_verb = "execute"`. Any additional text in this invocation is a `state.yml` path, bundle slug, or topic for plan selection.

Find `commands/masterplan.md` using the resolution order documented in `skills/masterplan/SKILL.md`.
