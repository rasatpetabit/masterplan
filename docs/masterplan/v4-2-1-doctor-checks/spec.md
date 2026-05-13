# Spec: v4.2.1 doctor checks (cross-manifest version drift + per-autonomy gate audit)

## Intent Anchor

Ship two new doctor checks that surface failure modes the v4.2.0 retro identified as systemic — both already happened in real code, both are cheap to detect, neither is currently linted:

1. **Cross-manifest version drift** — `.claude-plugin/marketplace.json` was stuck at 3.3.0 from v3.4.0 through v4.1.1 with no automated detection. v4.2.0 caught it up manually, but the same drift can re-open. A `jq`-based check reading the three version-bearing manifests and comparing them against the canonical `.claude-plugin/plugin.json` closes the gap.

2. **Per-autonomy gate-condition consistency** — `commands/masterplan.md` has gate conditions at L1286 (spec_approval, `--autonomy != full`) and L1360 (plan_approval, `--autonomy == gated` post-v4.2.0). The asymmetry is intentional but has no queryable source of truth; a future maintainer who only greps for `plan_approval` won't know L1286 deliberately diverges. A static-anchor-table check validates each gate-site's condition against a documented expected value and surfaces drift as a warning.

A drive-by: add the self-documenting comment near L1286 that the v4.2.0 retro called out — makes the asymmetry self-explanatory before #31 even runs.

## Scope Boundary

**In scope:**
- Two new doctor checks (#30 version drift, #31 gate-condition audit) added to `commands/masterplan.md` Step D
- Parallelization brief update (L2435) to include the new check IDs as repo-scoped (alongside #26)
- `docs/internals.md` §10 family-list update
- L1286 self-documenting comment (v4.2.0 retro drive-by)
- Version bump across 3 manifests (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` root + nested, `.codex-plugin/plugin.json`) from 4.2.0 → 4.2.1
- `CHANGELOG.md` `## [4.2.1]` entry
- Run bundle artifacts: state.yml, events.jsonl, spec.md, plan.md, retro.md
- Manual verification: grep discriminators, doctor-check manual runs (positive + negative), Haiku fresh-eyes Explore review
- Branch + commit + push to `origin/v4.2.1-doctor-checks`; local annotated tag `v4.2.1`

**Out of scope:**
- Auto-fix logic for either check (manifest version auto-bump is risky; gate-condition auto-rewrite is unacceptable). Both ship as Warning severity, report-only.
- Generalizing #31 beyond the static anchor table — extending coverage to `halt_mode` conditions, Step C task gates, verification gates, or the L1547/L1946/L1947 autonomy sites. v4.2.1 ships with the two canonical entries (L1286, L1360); follow-ups can expand the table.
- A new doc page for doctor checks under `docs/`. The existing `docs/internals.md` §10 + `commands/masterplan.md` Step D table are the authoritative surfaces.
- PR creation. The release artifact (branch + tag + retro) is the v4.2.1 deliverable; opening the PR is a user-authorized follow-up.

## Dependencies + assumptions

- **Branch base:** `v4.2.1-doctor-checks` is on `6d1ba1b` (origin/main HEAD), which predates v4.2.0. The version-bump plan tasks assume v4.2.0 lands on main first; v4.2.1 rebases before merge. If v4.2.0 hasn't merged when v4.2.1 is otherwise ready, surface a blocker AUQ rather than skipping the rebase.
- **L1286 / L1360 current state on this branch:** both still say `--autonomy != full` (v4.2.0 changes aren't here yet). #31's static anchor table must be written assuming the post-v4.2.0 canonical conditions (since v4.2.1 ships after v4.2.0). Manual verification will run after the rebase or against a temporary merge to validate live.
- **`.agents/plugins/marketplace.json`** has no `version` field. v4.2.0 documented this as an intentional no-op; #30 also skips this file.

## Acceptance criteria

1. `grep -n '"version": "4.2.1"' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json` returns 4 hits.
2. Doctor table in `commands/masterplan.md` has rows numbered #30 and #31 with severity Warning and report-only fix actions.
3. Parallelization brief (L2435) includes #30 and #31 in the repo-scoped set (alongside #26).
4. `docs/internals.md` §10 mentions both new families.
5. L1286 has a single-line HTML comment naming the L1360 divergence and pointing at CHANGELOG v4.2.0.
6. `CHANGELOG.md` has a `## [4.2.1]` entry above `## [4.2.0]` with Added/Verification/Migration sections.
7. Manual run of #30 logic against the post-bump repo state passes; manual revert of one manifest to 4.2.0 and re-run flags the drift; restore returns to clean.
8. Manual run of #31 logic against the post-edit `commands/masterplan.md` reports the L1286/L1360 asymmetry as recognized (because the self-doc comment is present); removing the comment and re-running flags it; restore returns to clean.
9. Haiku fresh-eyes Explore on the edited files returns zero dangling refs and zero contradictions.
10. All artifacts pushed to `origin/v4.2.1-doctor-checks`; retro.md written; local `v4.2.1` tag created.

## Risk register

- **R1: #31's static anchor table goes stale silently** — if a future change adds a new gate site without updating the table, the check passes but doesn't audit the new site. Mitigation: §10 family description explicitly names "static anchor table requires maintenance per gate-site addition." Carried-forward item: investigate a dynamic discovery variant (grep all `--autonomy [!=]=` matches and cross-check against the table).
- **R2: v4.2.0 PR conflicts with v4.2.1 PR on touching L2467-2495 doctor table** — unlikely (v4.2.0 doesn't touch Step D). Mitigation: rebase v4.2.1 onto post-v4.2.0 main; if conflict, resolve manually (low complexity).
- **R3: Manual verification slips again, like v4.1.1 / v4.2.0** — both prior releases deferred smoke. v4.2.1's verification IS the manual doctor-check run, which is the feature itself. This makes verification self-validating — running the new check IS the smoke test. Lower risk of slipping than runtime-loose-autonomy validation.
