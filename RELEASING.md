# Release Checklist

Run this checklist for every version bump. Doctor check #30 validates files 1–4 agree.

1. **`.claude-plugin/plugin.json`** — bump `version` (canonical source)
2. **`.claude-plugin/marketplace.json`** — bump root `version` AND `plugins[0].version`
3. **`.codex-plugin/plugin.json`** — bump `version`
4. **`README.md`** — update `Current release: **vX.Y.Z**` line
5. **`CHANGELOG.md`** — add `## [X.Y.Z]` entry with date and summary
6. Run `/masterplan doctor` — check #30 confirms all four version-bearing files agree

After all six steps pass, commit with message `release: vX.Y.Z — <one-line summary>`.
