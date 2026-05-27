---
name: import
description: "Import and migrate legacy planning artifacts (PLAN.md, ROADMAP.md, pre-v3 superpowers plans) into the masterplan schema."
---

<!-- masterplan verb: import -->

Invoke the masterplan **`import`** workflow. Load `commands/masterplan.md` from the plugin root and proceed with `requested_verb = "import"`. Any additional text in this invocation is a file path or glob pointing to the legacy artifact(s) to import.

Find `commands/masterplan.md` using the resolution order documented in `skills/masterplan/SKILL.md`.
