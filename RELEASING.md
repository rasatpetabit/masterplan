# Release Checklist

Run this checklist for every version bump. The publish-hygiene live test validates version-bearing files agree.

**Publish-time gate:** `lib/hygiene.mjs` is the publish-time gate (C10, retain-intentionally). Its three detector families — (1) fixture-identifier leak scan, (2) cross-manifest version sync, (3) namespace collision — are driven ONLY by `test/publish-hygiene.test.mjs`, which runs under `npm test`. No runtime code imports it; the test is its sole consumer and its release-safety bar. If this module ever looks dead, it is not: it is the guard this checklist's step 7 runs.

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
10. **Pi host registration** — Pi has no plugin manager; its equivalent of
    `/plugin update` is the repo's own registration tool, run from the release tree:
    `node bin/register-pi-agents.mjs` (writes the mp-* agents bare-only to
    `~/.pi/agent/agents/`, mapping policy-lane frontmatter to live model refs), then
    verify with `node bin/register-pi-agents.mjs --check` (drift must be 0). If this
    release DELETED an agent, the tool reports the installed copy as UNEXPECTED drift
    but never deletes it — remove that file from `~/.pi/agent/agents/` by hand after
    review.

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
