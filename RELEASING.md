# Release Checklist

Run this checklist for every version bump. The publish-hygiene live test validates version-bearing files agree.

1. **`.claude-plugin/plugin.json`** — bump `version` (canonical source)
2. **`.claude-plugin/marketplace.json`** — bump root `version` AND `plugins[0].version`
3. **`.codex-plugin/plugin.json`** — bump `version`
4. **`package.json`** — bump `version`
5. **`README.md`** — update `Current release: **vX.Y.Z**` line
6. **`CHANGELOG.md`** — add `## [X.Y.Z]` entry with date and summary
7. Run `node --test test/*.test.mjs` — the publish-hygiene live test confirms all version-bearing files agree.

After all seven steps pass, commit with message `release: vX.Y.Z — <one-line summary>`.
