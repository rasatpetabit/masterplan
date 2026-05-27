---
name: validate
description: "Check repo config (.masterplan.yaml) and active state.yml against the documented schema."
---

<!-- masterplan verb: validate -->

Invoke the masterplan **`validate`** workflow. Load `commands/masterplan.md` from the plugin root and proceed with `requested_verb = "validate"`. Reports mismatches between live config/state files and the schema in `docs/config-schema.md`.

Find `commands/masterplan.md` using the resolution order documented in `skills/masterplan/SKILL.md`.
