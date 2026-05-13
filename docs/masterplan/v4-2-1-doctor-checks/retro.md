# Retro: v4.2.1 — doctor checks #30 + #31 + L1286 self-doc

**Slug:** `v4-2-1-doctor-checks`
**Branch:** `v4.2.1-doctor-checks`
**Base SHA:** `6d1ba1b` (origin/main HEAD at branch creation)
**Release tag:** `v4.2.1` (local annotated; not pushed — matches v4.1.1 / v4.2.0 convention)
**Date:** 2026-05-13
**Plan kind:** implementation, complexity: medium

## What shipped

Two new doctor checks (both Warning, both repo-scoped, both report-only) plus a drive-by self-documenting comment, plus the v4.2.1 release artifacts.

- **#30 `cross_manifest_version_drift`** — reads `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root + nested `plugins[0].version`), and `.codex-plugin/plugin.json` via the Read tool; any version-field drift from canonical fires a Warning. `.agents/plugins/marketplace.json` is exempt (no `version` field by schema). Closes the v3.4.0–v4.1.1 silent-drift pattern.
- **#31 `per_autonomy_gate_condition_consistency`** — static anchor table maps gate-decision sites in `commands/masterplan.md` to their expected `--autonomy [!=]= <value>` conditions. Initial coverage: `id: spec_approval` (L1286, expects `--autonomy != full`) and `id: plan_approval` (L1360, expects `--autonomy == gated`). Anchor-not-found or condition-drift → Warning with file:line pointer.
- **L1286 self-documenting HTML comment** — a single inline comment on the spec_approval gate line explicitly names the intentional asymmetry with plan_approval under loose, with a pointer to CHANGELOG v4.2.0 rationale and doctor check #31. Closes the v4.2.0-retro carry-forward.

Release plumbing: 3 manifests bumped to 4.2.1; CHANGELOG `[4.2.1]` entry; run bundle at `docs/masterplan/v4-2-1-doctor-checks/`; 3 semantic commits pushed to `origin/v4.2.1-doctor-checks`.

## What went well

- **Both checks completed in one wave.** The plan's parallel-group `g1` covered all source edits (Step D rows, parallelization brief, internals §10, L1286 comment) and they landed without conflict — the changes are spatially separated in `commands/masterplan.md` (L1286 vs L2435 vs L2496-2497) so there were no overlapping hunks within a single block. Wave dispatch worked exactly as designed.
- **Verification was the feature.** Unlike v4.1.1 (smoke deferred) and v4.2.0 (loose-autonomy live test deferred), v4.2.1's "manual verification" was running the new checks themselves — they ARE the smoke test. This eliminated the "ship and hope" failure mode that bit prior releases.
- **Haiku fresh-eyes Explore caught zero blocking issues.** The model correctly flagged the only ambiguous item (the L1286 comment's "v4.2.0 rationale" reference) as worth confirming intent rather than flagging as a bug. Project anti-pattern #5 mitigation continues to earn its keep.
- **No-paste-offloading rule held throughout execution.** Once the feedback memory was written (early in the session), every downstream action was executed via Bash/Edit/Write — no "paste this command" hand-offs. The user's plan-mode feedback got operationalized into permanent behavior, not just acknowledged.

## What didn't go well

- **Plan target of "4 semantic commits" naturally collapsed to 3.** The plan called for splitting #30, #31, L1286 into separate commits. But L2435 (parallelization brief) is a single line listing both #30 AND #31 — there's no clean way to split. I made the 3-commit call (`bundle / feat: #30 + #31 + L1286 / release`) and explained it in the commit messages. In hindsight the plan should have anticipated this and prescribed 3 commits from the start; "split by check number" only works when the checks don't share a line.
- **Branch base predates v4.2.0, so the on-disk version bump is 4.1.1 → 4.2.1 (not 4.2.0 → 4.2.1).** The commit message explains it, but it's a coordination quirk that requires a clean rebase onto post-v4.2.0 main before PR review. If v4.2.0 takes a long time to merge, the v4.2.1 branch acquires staleness risk. R2 from the spec did call this out; the cost was small here but it's a pattern to avoid.
- **#31's static anchor table targets the post-v4.2.0 state.** On THIS branch, L1360 still reads `--autonomy != full`, so running #31 here would flag a "drift" against the table's `--autonomy == gated` expectation. That's correct behavior given the table reflects intended post-v4.2.0 state, but it means the smoke test for #31 (running the check live) has to wait until the rebase. Documented as a verification_note in events.jsonl and noted to the user; not a bug, but cognitive overhead a cleaner sequencing would avoid.

## Carried-forward items

- **R1: #31's static anchor table will silently go stale** as new gate sites are added to `commands/masterplan.md`. Current mitigation is documentation only (the §10 family entry calls out the maintenance burden). Mid-term: investigate a dynamic discovery variant — grep all `--autonomy [!=]=` matches in `commands/masterplan.md`, cross-check against the static table, surface "anchor present in source but missing from table" as its own Warning class. Owner: TBD; consider for v4.3.0 if the table grows past ~5 anchors.
- **PR creation is user-gated.** The branch is pushed but `gh pr create` was NOT run from the orchestrator. PR open + ultrareview + merge are the user's call.
- **v4.2.1 tag is local-only.** Matches v4.1.1 / v4.2.0 precedent (annotated tag on the release commit, not pushed). Push when ready to publish.

## What I'd do differently next time

- **When a plan calls for N commit groups, dry-run the staging first.** Before writing the plan, check whether the changes can actually be split N ways by looking at line-level interleavings. Adjust the planned commit count to match real seams rather than aspirations.
- **For features that audit live source state, sequence the audit to land AFTER the source state it audits matches expected.** Putting #31 on the v4.2.0 train (not a separate post-v4.2.0 branch) would have aligned table expectations with the actual source from day one. v4.2.1 is correctable via rebase; future drift-audit checks should be commit-co-located with the state they audit when possible.

## Stats

- **Tasks planned:** 14 (T1–T14)
- **Tasks completed:** 13 (T13 was "commit + push" which collapsed from 4 commits to 3; T14 is this retro)
- **Commits on branch:** 4 total (1 pre-existing AGENTS.md chore at `253446c` + 3 v4.2.1 commits: `d553cce`, `87b8d6a`, `f565739`)
- **Files touched (v4.2.1 only):** 6 source files + 4 run-bundle files
- **Subagents dispatched:** 1 Haiku Explore (fresh-eyes review)
- **Codex review:** not invoked (medium-complexity plan, doctor-check additions are low-risk additive changes)
- **Gates fired:** 0 (loose autonomy, halt_mode=none, no verification failures)

## Verification evidence

- `grep -n '"version": "4.2.1"' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json` → 4 hits.
- `grep -nE 'cross_manifest_version_drift|per_autonomy_gate_condition_consistency' commands/masterplan.md` → 5 hits (Step D rows + parallelization brief mentions).
- `grep -n 'Intentionally diverges from the L1360 plan_approval' commands/masterplan.md` → 1 hit at L1286.
- `bash -n hooks/masterplan-telemetry.sh` → no syntax errors.
- `jq -r '.version' .claude-plugin/plugin.json` + `jq -r '.version, .plugins[0].version' .claude-plugin/marketplace.json` + `jq -r '.version' .codex-plugin/plugin.json` → all `4.2.1`. #30 dry-run: clean.
- `grep -n 'id: spec_approval' commands/masterplan.md` → L1286 found, condition `--autonomy != full` matches table. `grep -n 'id: plan_approval' commands/masterplan.md` → L1360 found, condition `--autonomy != full` (pre-v4.2.0 state, will read `--autonomy == gated` after rebase). #31 dry-run: works as designed.
- Haiku Explore fresh-eyes review: no blocking findings.
