# Release Checklist

Run this checklist for every version bump. The publish-hygiene live test validates version-bearing files agree.

1. **`.claude-plugin/plugin.json`** — bump `version` (canonical source)
2. **`.claude-plugin/marketplace.json`** — bump root `version` AND `plugins[0].version`
3. **`.codex-plugin/plugin.json`** — bump `version`
4. **`package.json`** — bump `version`
5. **`README.md`** — update `Current release: **vX.Y.Z**` line
6. **`CHANGELOG.md`** — add `## [X.Y.Z]` entry with date and summary
7. Run `node --test test/*.test.mjs` — the publish-hygiene live test confirms all version-bearing files agree.
8. **Tag the release** — create an annotated tag on the release commit:
   `git tag -a vX.Y.Z -m "release: vX.Y.Z — <one-line summary>"`
9. **Push the tag** — `git push origin vX.Y.Z` (push the tag explicitly; a plain
   `git push` of the branch does **not** carry tags). CI's `release-publish` job
   (`ci.yml`) only runs when a tag matching `v*` is pushed — **without step 8+9 the
   GitHub Release is never created**, even though the code landed on `main`.

After steps 1–7 pass, commit with message `release: vX.Y.Z — <one-line summary>`, then run steps 8 and 9.

### Tag discipline

- **One annotated tag per release**, named exactly `vX.Y.Z` (matching the README
  `Current release` marker and every manifest version). `release-publish` parses
  `v<X.Y.Z>` from the tag and requires a matching `## [X.Y.Z]` section in
  `CHANGELOG.md` (step 6) **before** the tag is pushed — create the CHANGELOG
  entry first.
- **No retroactive tagging.** Releases that shipped without a tag are left
  untagged; the next release tags only its own commit. This keeps the tag→commit
  mapping truthful: a tag points at exactly the commit that was released, never
  a reconstructed marker bolted onto history.
