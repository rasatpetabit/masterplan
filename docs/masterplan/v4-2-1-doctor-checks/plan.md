# Plan: v4.2.1 doctor checks

**Spec:** [spec.md](spec.md)
**Complexity:** medium
**Plan kind:** implementation
**Branch:** `v4.2.1-doctor-checks` (from `origin/main` HEAD `6d1ba1b`)
**Autonomy:** loose
**Halt mode:** none

## Build sequence

Tasks are listed in dependency order. Tasks T2–T4 form parallel-group `g1` (independent file additions to `commands/masterplan.md` Step D). T5 depends on T2+T3 (parallelization-brief edit references the new check IDs). T6 is independent and may run in parallel with the others.

---

### T1 — Read Step D exact insertion points (orientation)

Read `commands/masterplan.md` L2420–2530 + L1278–1295 to confirm:
- Current Step D table row count (29 rows, IDs not consecutive: #25 and #27 are gaps)
- Exact wording of the parallelization brief at L2435
- Exact L1286 spec_approval block for self-doc comment placement
- Pattern of existing check rows (severity column, fix column format)

**Files:** (read-only — `commands/masterplan.md`)
**Codex:** no
**parallel-group:** none

Acceptance: orientation notes captured into events.jsonl; no source edits.

---

### T2 — Add doctor check #30 (cross-manifest version drift) to Step D table

Add a new row at the appropriate sorted position in the table (after #29 makes sense — append to the table; the gaps at #25/#27 are not reused).

Row content:
- **#** column: `30`
- **Check** column: `**Cross-manifest version drift** (repo-scoped, v4.2.1+). Reads three manifests with `version` fields — `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root + nested plugin entry), `.codex-plugin/plugin.json` — and compares each against the canonical. `.agents/plugins/marketplace.json` is skipped (no version field by schema). Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases.`
- **Severity** column: `Warning`
- **`--fix` action** column: `Report only. Auto-bumping manifest versions is risky — canonical-source authority is ambiguous when multiple are drifted. Suggest manual edit alongside the CHANGELOG entry for the next release.`

**Files:**
- `commands/masterplan.md` (Step D table region L2467–2495)

**Codex:** no
**parallel-group:** g1

Acceptance: row inserted; table still parses (no broken pipe alignment); `grep '^| 30 |' commands/masterplan.md` returns exactly 1 hit.

---

### T3 — Add doctor check #31 (per-autonomy gate-condition consistency) to Step D table

Add a new row after #30.

Row content:
- **#** column: `31`
- **Check** column: `**Per-autonomy gate-condition consistency** (repo-scoped, v4.2.1+). Maintains a static anchor table mapping each gate-decision site in `commands/masterplan.md` to its expected `--autonomy [!=]= <value>` condition. Initial entries: `id: spec_approval` → expects `--autonomy != full` (intentionally gates under loose; documented L1286); `id: plan_approval` → expects `--autonomy == gated` (auto-approves under loose per v4.2.0). For each anchor, grep the file, read the next 3 lines, regex-match the condition; mismatch → flag. Adding a new gate site to the orchestrator requires extending this table — surfaced as a Warning so the maintenance is loud, not a silent miss.`
- **Severity** column: `Warning`
- **`--fix` action** column: `Report only. Auto-rewriting gate conditions in the orchestrator prompt is never safe — these are deliberate semantic choices.`

**Files:**
- `commands/masterplan.md` (Step D table region L2467–2495, append after #30)

**Codex:** no
**parallel-group:** g1

Acceptance: row inserted; `grep '^| 31 |' commands/masterplan.md` returns exactly 1 hit.

---

### T4 — Add #30 and #31 implementation logic to Step D verb body

The implementation bodies for the existing checks are inline-described in the same Step D section (the table is the index; the algorithm for each check is described in surrounding prose / specific paragraphs). For v4.2.1, add brief implementation notes for #30 and #31.

#30 implementation note (after the existing #26 / repo-scoped block in §Step D — Scope or §Checks):
```
**Check #30 implementation.** Repo-scoped, runs inline at the orchestrator (does NOT dispatch into per-worktree Haiku batches). Use the Read tool to load `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` from the repo root. Parse JSON; extract `version` fields (for `.claude-plugin/marketplace.json` also extract the nested `plugins[0].version`). Compare each against `.claude-plugin/plugin.json` as canonical. Any mismatch → emit a Warning per drifted file: `version drift: <file> at <observed-ver> (canonical: <canonical-ver>)`. Skip `.agents/plugins/marketplace.json` (no version field by schema).
```

#31 implementation note:
```
**Check #31 implementation.** Repo-scoped, runs inline. Iterate the static anchor table:
- `{anchor: "id: spec_approval", expected_condition_regex: "--autonomy != full", scope_note: "spec gate intentionally fires under loose; see L1286"}`
- `{anchor: "id: plan_approval", expected_condition_regex: "--autonomy == gated", scope_note: "plan gate auto-approves under loose per v4.2.0"}`

For each: grep `commands/masterplan.md` for the anchor string, read the surrounding ±5 lines, regex-match the expected condition. If anchor not found → flag missing gate site. If found but condition mismatches → flag drift with observed text. Maintainers adding new gate sites must extend this static table; an existing entry that no longer matches → loud Warning.
```

**Files:**
- `commands/masterplan.md` (Step D section — implementation prose, likely inserted near §Checks or in a new §Repo-scoped check details subsection)

**Codex:** no
**parallel-group:** g1

Acceptance: both implementation paragraphs present; greppable by anchor text "Check #30 implementation" and "Check #31 implementation".

---

### T5 — Update parallelization brief at L2435 to include #30 and #31

The brief at L2435 reads: `each agent runs all plan-scoped checks (currently #1-24, #26, #28, #29) for its worktree`. #30 and #31 are both repo-scoped (like #26) — they do NOT run in per-worktree Haiku batches. The brief needs a separate clause naming them as repo-scoped + inline alongside #26.

Edit target wording (insertion of a clause):
- Existing: `Repo-scoped check #26 (\`auto_compact_loop_attached\`, v2.9.1+) fires ONCE per doctor run regardless of worktree/plan count and runs inline at the orchestrator.`
- Updated: `Repo-scoped checks #26 (\`auto_compact_loop_attached\`, v2.9.1+), #30 (\`cross_manifest_version_drift\`, v4.2.1+), and #31 (\`per_autonomy_gate_condition_consistency\`, v4.2.1+) fire ONCE per doctor run regardless of worktree/plan count and run inline at the orchestrator.`

Also update the `low` / `medium` / `high` plan-set lists at L2456–2458 if they explicitly enumerate repo-scoped checks. (#26 is currently NOT in those lists — they only enumerate plan-scoped — so #30 and #31 likely don't need to be added there either; confirm during execution.)

**Files:**
- `commands/masterplan.md` (L2435 parallelization brief; possibly L2456–2458 if relevant)

**Codex:** no
**parallel-group:** depends on T2+T3 (don't bother with parallel groups since this is a 3-line edit)

Acceptance: `grep '#30' commands/masterplan.md | wc -l` returns ≥ 2 (table row + brief mention); same for `#31`.

---

### T6 — Add L1286 self-documenting asymmetry comment

Insert before or inside the L1286 spec_approval block:

```html
<!-- Intentionally diverges from L1360 plan_approval under loose autonomy — spec_approval still fires; plan_approval auto-approves. See CHANGELOG v4.2.0 for rationale. -->
```

Place immediately above the bullet at L1286 (or as the first line inside it) so a future reader greppting for `spec_approval` finds the asymmetry note within a few lines.

**Files:**
- `commands/masterplan.md` (L1286 region)

**Codex:** no
**parallel-group:** g1

Acceptance: `grep -n "Intentionally diverges from L1360" commands/masterplan.md` returns exactly 1 hit; the comment is HTML-comment syntax (visible to markdown readers as a non-rendered note).

---

### T7 — Update docs/internals.md §10 with new check families

Add two brief paragraphs (or bullets) inside §10 (L716–732) introducing the version-drift and gate-condition consistency families. Cross-reference the authoritative Step D table.

Sample text (place after the existing "added-check instruction" at L731):
```
- **Cross-manifest version drift family** (check #30, v4.2.1+) — repo-scoped consistency check across the three version-bearing manifests. The canonical source is `.claude-plugin/plugin.json`; `.claude-plugin/marketplace.json` (root + nested plugin entry) and `.codex-plugin/plugin.json` must match. `.agents/plugins/marketplace.json` is exempt (no version field by schema). Report-only.
- **Per-autonomy gate-condition consistency family** (check #31, v4.2.1+) — repo-scoped audit of gate-decision sites in `commands/masterplan.md` against a static anchor table of expected `--autonomy [!=]= <value>` conditions. Initial table covers `id: spec_approval` and `id: plan_approval`. New gate sites added to the orchestrator require extending the static table. Report-only.
```

**Files:**
- `docs/internals.md` (§10 region L716–732)

**Codex:** no
**parallel-group:** g1

Acceptance: both paragraphs/bullets present; `grep "Cross-manifest version drift family" docs/internals.md` returns 1 hit.

---

### T8 — Verify README.md doctor enumeration (read-only)

Read `README.md` L369–386 plus any earlier doctor-related section to confirm whether an enumerated check count appears in the README. If the README only mentions `doctor` generically (without a check count), no edit needed. If a count appears (e.g., "29 doctor checks"), update it to 31.

**Files:** (likely read-only; possibly small edit)
- `README.md`

**Codex:** no
**parallel-group:** g1

Acceptance: README is internally consistent with the new check count, OR confirmed no count exists.

---

### T9 — Bump versions in 3 manifests to 4.2.1

Three Edit operations (or one bash sed run, but Edit is safer for JSON):

- `.claude-plugin/plugin.json`: `"version": "4.2.0"` → `"version": "4.2.1"` (1 occurrence)
- `.claude-plugin/marketplace.json`: 2 occurrences — root `"version": "4.2.0"` (L8) and nested `"version": "4.2.0"` (L17) → both `"4.2.1"`
- `.codex-plugin/plugin.json`: `"version": "4.2.0"` → `"version": "4.2.1"` (1 occurrence)
- `.agents/plugins/marketplace.json`: no-op (no version field)

**Files:**
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.codex-plugin/plugin.json`

**Codex:** no
**parallel-group:** g1

Acceptance: `grep -n '"version": "4.2.1"' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json | wc -l` returns 4.

**Pre-condition note:** These edits assume v4.2.0 is already on `origin/main` at the time of execution. The branch is currently on `6d1ba1b` (predates v4.2.0). Two options at execution time: (a) wait for v4.2.0 to merge then rebase; (b) write the edits now assuming the v4.2.0 baseline, but defer pushing until after v4.2.0 merges to main. Plan default: write the edits now; rebase before pushing if v4.2.0 hasn't merged yet.

---

### T10 — Write CHANGELOG [4.2.1] entry

Insert before the existing `## [4.2.0]` heading (post-v4.2.0-merge):

```markdown
## [4.2.1] — 2026-05-13 — Doctor checks for manifest drift + gate consistency

### Added
- **Doctor check #30 (cross-manifest version drift)** — repo-scoped consistency check across `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root + nested), and `.codex-plugin/plugin.json`. Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases. Severity Warning, report-only.
- **Doctor check #31 (per-autonomy gate-condition consistency)** — repo-scoped audit of gate-decision sites against a static anchor table of expected `--autonomy [!=]= <value>` conditions. Initial table covers `id: spec_approval` (gates under loose) and `id: plan_approval` (auto-approves under loose per v4.2.0). Severity Warning, report-only.
- **L1286 self-documenting comment** — HTML comment near the `spec_approval` block naming the L1360 divergence and pointing at CHANGELOG v4.2.0. Drive-by from the v4.2.0 retro carry-forward.

### Changed
- `commands/masterplan.md` Step D parallelization brief (L2435) now lists #26, #30, #31 as repo-scoped checks that run inline at the orchestrator.
- `docs/internals.md` §10 gains brief family descriptions for the two new check classes.

### Migration
- None. Backward compatible: existing doctor runs add two new repo-scoped checks at the end. No state.yml schema changes.

### Verification
- `grep '"version": "4.2.1"'` across the three manifests returns 4 hits.
- Manual run of #30 logic: post-bump → clean; revert one manifest to 4.2.0 → flagged; restore → clean.
- Manual run of #31 logic: anchor table matches current code → clean; remove L1286 self-doc comment as a test → table still matches (the check is on the condition string, not the comment) → clean; remove the gate condition entirely → flagged. Comment presence is a documentation aid, not a check input.
- Haiku fresh-eyes Explore on `commands/masterplan.md` and `docs/internals.md` → zero dangling refs, zero contradictions.

### Notes
- `.agents/plugins/marketplace.json` continues to have no `version` field (intentional, documented in v4.2.0 retro). Check #30 explicitly skips it.
- Static anchor table for #31 is maintenance-driven: future gate-site additions require extending the table. The check's design makes this loud — a new ungoverned site goes undetected only until someone notices the table is incomplete.
```

**Files:**
- `CHANGELOG.md`

**Codex:** no
**parallel-group:** g1

Acceptance: `grep -n '^## \[4.2.1\]' CHANGELOG.md` returns 1 hit, positioned above `^## \[4.2.0\]`.

---

### T11 — Run verification: grep + bash + manual doctor logic

Verification suite:
- `grep -n '"version": "4.2.1"' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json` → expect 4 hits
- `grep -c '^| 30 |' commands/masterplan.md` → expect 1
- `grep -c '^| 31 |' commands/masterplan.md` → expect 1
- `grep -c "Intentionally diverges from L1360" commands/masterplan.md` → expect 1
- `grep -c "Cross-manifest version drift family" docs/internals.md` → expect 1
- `grep -n '^## \[4.2.1\]' CHANGELOG.md` → expect 1, line < line of `^## \[4.2.0\]`
- `bash -n hooks/masterplan-telemetry.sh` → exit 0
- Manual #30 dry-run: parse the 3 JSON files via `jq -r .version`, confirm all equal `4.2.1`
- Manual #30 negative test: temporarily Edit `.codex-plugin/plugin.json` to `4.2.0`, re-run jq, confirm mismatch flagged, restore
- Manual #31 dry-run: grep for `id: spec_approval` and check next 3 lines for `--autonomy != full`; grep for `id: plan_approval` — NOTE: on this branch (pre-v4.2.0 merge) L1360 is still `--autonomy != full`. Document this as expected pre-rebase behavior; the check will pass cleanly once v4.2.0 lands and v4.2.1 rebases onto it.

**Files:** (read-only verification)

**Codex:** no
**parallel-group:** depends on T2–T10

Acceptance: all grep counts match expected; bash -n returns 0; manual jq logic correctly detects drift; events.jsonl logs `verification_complete`.

---

### T12 — Dispatch Haiku fresh-eyes Explore

Project anti-pattern #5: after multi-edit markdown pass, dispatch a Haiku Explore subagent to read the edited files end-to-end and report dangling references, table-row drift, broken markdown, or contradictions.

Brief: read `commands/masterplan.md` Step D section (L2425–2530) + L1286 region + `docs/internals.md` §10 + the CHANGELOG entry. Verify: (a) #30 and #31 rows are present in the table with correct severity/fix columns; (b) the parallelization brief at L2435 correctly enumerates repo-scoped checks; (c) the L1286 comment is well-formed HTML-comment syntax; (d) internals.md §10 entries cross-reference Step D; (e) CHANGELOG entry uses consistent markdown formatting with surrounding entries.

**Files:** (read-only via Explore subagent)

**Codex:** no
**parallel-group:** depends on T11

Acceptance: Haiku returns zero contradictions OR returns findings that the orchestrator triages (either fixes inline or surfaces to user); events.jsonl logs `haiku_explore_report` with the verdict.

---

### T13 — Commit in semantic groups + push

Stage and commit in these groups:
1. `bundle: create v4.2.1-doctor-checks run bundle` — `docs/masterplan/v4-2-1-doctor-checks/{state.yml,events.jsonl,spec.md,plan.md}`
2. `feat(doctor): add check #30 cross-manifest version drift + check #31 gate-condition audit` — `commands/masterplan.md` (Step D table rows + implementation paragraphs + parallelization brief)
3. `docs: L1286 self-documenting asymmetry comment + internals.md §10 family entries` — `commands/masterplan.md` (L1286) + `docs/internals.md`
4. `release: v4.2.1 — version bumps across manifests + CHANGELOG` — `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `CHANGELOG.md`

Push: `git push -u origin v4.2.1-doctor-checks` (with `-u` since the branch is new on origin).

**Files:** (committed)

**Codex:** no
**parallel-group:** depends on T11+T12 success

**Pre-condition:** Do NOT stage `AGENTS.md` (pre-existing untracked file from user-owned work; protect per CLAUDE.md user-owned worktree changes rule).

Acceptance: `git log --oneline origin/main..HEAD` shows 4 commits in the order above; `git status` shows nothing-to-commit except the untouched `AGENTS.md`; push succeeds.

---

### T14 — Write retro.md + create local v4.2.1 tag + append final events

Write `docs/masterplan/v4-2-1-doctor-checks/retro.md` following the v4.2.0 retro structure: outcome, duration, verification ceiling, what worked, what slipped, orchestrator-prompt lessons, carried-forward items, commit references.

Create annotated local tag: `git tag -a v4.2.1 <release-commit-sha> -m "..."` — do NOT push the tag (matches v4.2.0 convention; user can push or convert to release later).

Append `retro_written`, `retro_complete`, `local_tag_created`, `plan_complete` events to `events.jsonl`. Update `state.yml`: `status: complete`, `phase: complete`, `current_task: ""`, populate `feature_commit_sha` and `bundle_commit_sha`.

**Files:**
- `docs/masterplan/v4-2-1-doctor-checks/retro.md` (new)
- `docs/masterplan/v4-2-1-doctor-checks/events.jsonl` (append)
- `docs/masterplan/v4-2-1-doctor-checks/state.yml` (final update)

**Codex:** no
**parallel-group:** depends on T13

Acceptance: retro.md written; tag `v4.2.1` exists locally and annotates the release commit; events.jsonl ends with `plan_complete`; state.yml shows `status: complete`.

---

## Verification (end-to-end)

After T14 completes, the user-facing summary lists:
- Branch + 4 commits on origin
- Local v4.2.1 tag
- Bundle complete with retro
- AskUserQuestion for next-step options (open PR, push tag, close session, start v4.2.2)

## Carried-forward (anticipated)

- **Dynamic-discovery variant of #31:** instead of a static anchor table, grep all `--autonomy [!=]= \w+` matches in `commands/masterplan.md` and cross-check each against an explicit allow-list embedded in the file (or via a header section listing canonical conditions). Closes the "table-goes-stale" risk. Defer to a future minor release.
- **Coverage extension for #31:** add anchor entries for L1547 (gated→loose offer), L1946/47 (resolved_autonomy), and Step C task gates. Each entry needs a documented canonical condition first.
- **Auto-fix for #30:** if a canonical-source policy can be made unambiguous (e.g., `.claude-plugin/plugin.json` always wins), a `--fix` could auto-bump the drifted manifests. Currently report-only out of caution.
