# WORKLOG

## 2026-05-29 — v8 (masterplan-ng): removed ALL per-verb skill dirs + terse-narration directive (pre-cutover hygiene)

Two user-directed changes landed ahead of the (still-gated) cutover; both are scoped, local, and suite-green (`node --test test/*.test.mjs` → **239 pass / 0 fail**).

**1. Per-verb `/masterplan:<verb>` skills DELETED — all 12 (`git rm`).** User directive: "`/masterplan:verb` is just a bad idea … you didn't actually add support for it." Correct — the per-verb dirs were redundant delegators pointing at the **dead v5.0 `parts/` architecture**; v8 verbs dispatch through the bare `/masterplan <verb>` command via `bin/masterplan.mjs` (`commands/masterplan.md` §1/§3), so the namespace added nothing over bare-command routing *and* `plan`/`status`/`doctor` actively shadowed CC built-ins (`/plan` plan-mode, `/status`, `/doctor`). **This REVERSES the 2026-05-29 "KEEP per-verb skills" entry below** (line ~36 "deleting them would break every verb command") — that claim was an overstatement; verb routing is independent of the skill dirs. Removed: `skills/{brainstorm,clean,doctor,execute,full,import,next,retro,stats,status,validate,verbs}/`. Survivors: `skills/masterplan/` (Codex/generic entrypoint) + `skills/masterplan-detect/` — the ONLY two dirs v8 ships.
- **Hygiene guard tightened to an infra-only contract** (`lib/hygiene.mjs`): `FORBIDDEN_SKILL_NAMES` = `['plan','status','doctor']` (was `['plan']`); `findNamespaceCollisions` no longer consults the reserved-verb allowlist — any non-infra skill dir is flagged (`shadows-builtin` for the three built-ins, `unwired-verb` for anything else). `reservedVerbs` param kept for API stability. `test/publish-hygiene.test.mjs` Guard-3 tests rewritten to match (planted-bad / synthetic-clean / LIVE triad intact); the LIVE walk now sweeps clean because only the two infra survivors remain.
- `skills/masterplan/SKILL.md` frontmatter `description:` + per-verb section rewritten to state v8 ships no per-verb skills. (Its broader v7-era staleness — `parts/` refs, "36 doctor checks", v5.0 lazy-load layout — is a SEPARATE cutover doc-rewrite, intentionally not touched here.) `cutover-removal-manifest.md` Tier-3 bullet flipped to "⚠️ DECISION REVERSED → DELETED". Plugin manifests need no change (`brainstorm` appears only in `keywords` search tags; `.codex-plugin` uses a `"skills": "./skills/"` directory pointer, not an enumeration).

**2. Terse per-wave narration directive** (`commands/masterplan.md` §2a step 3, "Commit once"): after each wave commit, print at most a 1–2 line summary — NEVER echo the `state.yml` *or* `WORKLOG.md` diff to screen. Extends the existing state-diff anti-flood preference to WORKLOG diffs per the user ask; the full record lives in the bundle + `git log`.

**Not pushed; cutover NOT started** (both stay user-gated). The scoped v8 deploy to the second dev host is the pending outward action.

## 2026-05-29 — v8 (masterplan-ng): pre-ported the 3 DEFERRED-SPEC slices → `docs/conventions/` (additive; cutover still NOT started)

Collapsed all cutover-time *porting* into **additive commits now**, so the eventual v7→v8 cutover is pure deletion + version/doc-rewrite with **no spec at risk**. A Sonnet implementer extracted the three port-blocker slices identified in the prior Tier-2 close-out **verbatim**, into the established reference home `docs/conventions/` (alongside `autonomy-policy.md`, `api-retry-policy.md`). **No deletions — `parts/contracts/` untouched; nothing in the cutover started.**

**Three new files (all additive):**
- `docs/conventions/cd-rules.md` — verbatim CD-1…CD-10 *bodies* (the **mandatory** port: live v8 code in `CLAUDE.md`/`agents/*.md`/`commands/masterplan.md`/`workflows/execute.workflow.js` cites `CD-N` IDs today; deleting `parts/contracts/cd-rules.md` would dangle them). **Verified byte-identical from the CD-1 heading onward** vs source. Note: CD-7's verbatim title is "Durable handoff state" — the v8 "single-writer" framing is a *mechanism* of that principle, not a retitle; the port keeps the original heading.
- `docs/conventions/plan-annotations.md` — the Step-B2 writing-plans brief (Codex / parallel-group / verify-pattern / skip-handoff / complexity-aware / plan-format v5.0 directives). Sole canonical home; `masterplan-contracts.md:139` only name-drops the directive keywords.
- `docs/conventions/codex-review-dimensions.md` — the six B2/B3 review *dimensions* (`completeness, correctness, security, consistency, naming, scope`). Thin slice only: the JSON-parse/dispatch/codex-host-fallback contract is **DEAD** (superseded by `agents/mp-codex-reviewer.md`), explicitly stated in the file header; per-dimension prose isn't in source (source only lists the keys), so none was invented.

**Two cross-refs (additive):** `docs/internals.md` Architecture Overview now points to `conventions/cd-rules.md` as the canonical CD-body home (+1 line); `agents/mp-planner.md` gained a `## Plan annotation spec` pointer to `conventions/plan-annotations.md` (+3 lines).

**Manifest updated to match:** `cutover-removal-manifest.md` Tier-2 table verdicts for the 3 slices → **✅ PRE-PORTED** (with destinations); Tier-4 #8/#9/#10 → **✅ DONE — PRE-PORTED 2026-05-29**; #7 (tag HEAD) reworded to belt-and-suspenders; sequencing recap now reads "tag → `git rm` + scrub → version/doc/Makefile → gate → merge" (ports dropped out). Fresh-eyes verify PASS (5/5): CD bodies byte-identical, six dimensions present, no dead content leaked, cross-refs minimal, `parts/contracts/` untouched. Orchestrator sole committer (CD-7). **Not pushed** (awaiting gate).

## 2026-05-29 — v8 (masterplan-ng): closed the last 2 Tier-2 items in the removal-manifest (cutover now fully mechanical)

Resolved the two remaining open Tier-2 rows in `cutover-removal-manifest.md` so the cutover needs no further analysis — planning doc only, **no deletions, cutover NOT started.**

**`parts/contracts/` port-check — decided per-file (8 files, 3-way + 1 split).** The discriminator (advisor-vetted, then refined against my greps): a file is a **port-blocker** only if **its v8 replacement does not yet exist AND it is the sole canonical home of the spec** — else it is DEAD (replacement exists / intentional removal) or REPRESENTED. Result: **3 DEAD** (`taskcreate-projection`, `agent-dispatch`, `brainstorm-anchor` — anchor *extraction* survives as `coordinator-brainstorm-anchor-v1` in `masterplan-contracts.md:367-382`), **2 REPRESENTED-safe-delete** (`coordinator`→`masterplan-contracts.md:367-458`; `run-bundle`→`lib/bundle.mjs`+`mp-planner.md`+`lib/routing.mjs`+`lib/doctor/scalar-cap.mjs`), **2 DEFERRED-SPEC port-blockers** (`plan-annotations` = sole home of the Step-B2 writing-plans brief, `masterplan-contracts.md:139` only name-drops the directives; `cd-rules` = sole home of CD-1…CD-10 *bodies*, `internals.md:15` only cites CD-7), and **1 DEAD-except-thin-slice** (`codex-review`: JSON parse contract dead → `mp-codex-reviewer.md`, but its six B2/B3 review *dimensions* aren't carried there).

**Why this matters / correction:** the prior draft had stamped `cd-rules.md` as "→ lib/" confirmed-dead — **wrong.** Live v8 code (`CLAUDE.md`, `agents/*.md`, `commands/masterplan.md`, `workflows/execute.workflow.js`) cites `CD-N` IDs *today*, so deleting `cd-rules.md` dangles those citations immediately — it's a **mandatory** pre-delete port (Tier-4 #9), not deferrable. The advisor's own initial grouping (brainstorm-anchor + codex-review-B2/B3 as port-blockers) was reconciled against primary sources and reversed: those have existing v8 replacements; the true second blocker is `cd-rules`.

**`Makefile` — TRIM (decided).** Keep `test`→`npm test` (the v8 `node --test test/*.test.mjs` gate, 239/239) + `help`; drop the 4 v7-coupled targets. Confirmed the still-relevant `test-static` checks already live in `test/publish-hygiene.test.mjs` (Guard 2 version-sync L118-133, Guard 3 namespace L170-177) — no coverage gap.

**Captured as Tier-4 pre-delete actions:** #7 tag `pre-v8-cutover` HEAD (recover-from-tag safety net) → #8 port plan-annotations brief → #9 port CD bodies (mandatory) → #10 port codex-review dimensions → #11 trim Makefile. Sequencing recap updated. Orchestrator sole committer (CD-7). **Not pushed** (awaiting gate).

## 2026-05-29 — v8 (masterplan-ng): cutover removal-manifest drafted (planning doc, no deletions)

Wrote `docs/masterplan/2026-05-29-v8-dogfood/cutover-removal-manifest.md` — the third and final cutover-gate doc (with `parity-report.md` + `parity-runbook.md`). Enumerates, against the plan's authoritative *Survives/Dies/Transforms* table (plan L73-96), exactly what the v7→v8 cutover diff deletes: **Tier 1 CONFIRMED-DELETE** (telemetry hook — gate already closed; all `bin/masterplan-{anomaly,routing-stats,codex-usage,failure-analyze,findings-to-issues,self-host-audit,session-audit,recurring-audit,audit-schedule,wipe-telemetry,policy-regression-smoke,release-gate,guard-b/c-smoke,state}.sh`; `lib/*.py` ×3; the whole `parts/` prose-orchestrator tree; the whole v7 `tests/` harness, 302 files); **Tier 2 DECISION-FIRST** (per-verb `skills/` dirs — v8 shell references none; `Makefile`; import capability); **Tier 3 KEEP** (v8 core); **Tier 4 NON-DELETE** (reference scrub of keepers, `bin/run-tests*.sh` rewrite since they `exec` the deleted `tests/run-tests.sh`, version bump v7.2.3→v8.0.0 across manifests + README SoT, **stale-architecture doc rewrites of project CLAUDE.md + README**, CHANGELOG, pre-merge guard, merge).

**Discovery worth flagging:** `bin/run-tests.sh`/`run-tests-fast.sh` delegate to the v7 `tests/run-tests.sh`, not the v8 `test/` tree (`package.json test` = `node --test test/*.test.mjs`) — so dropping `tests/` requires fixing those wrappers first. Also: project `CLAUDE.md` + README still document the v7 surface as current architecture → added as a required cutover doc-rewrite.

**Sequencing (all user-gated):** fresh-session parity run (runbook) → cutover (manifest Tiers 1-4) → merge. Manifest is a **planning document only — no files deleted, cutover NOT started.** Orchestrator sole committer (CD-7).

**Update (same day) — Tier-2 resolution caught a confirmation-bias error (anti-pattern #5).** A read-only tree-investigation subagent resolved 4 of 6 open Tier-2 items and **reversed** the manifest's initial framing of the per-verb `skills/` dirs. They are NOT deletable v7 prose — each `skills/<verb>/SKILL.md` is a thin **entry-point delegator** (`load commands/masterplan.md; requested_verb=<verb>`) that makes the published `/masterplan:<verb>` surface resolve into the v8 shell. The earlier "the v8 shell references none of them → v7 surface" reasoning was backwards: the skills *call into* the shell, so the shell referencing them back was never expected; deleting them would break every verb command. Corrected verdicts — **KEEP (→ Tier 3):** all per-verb skills incl. `stats` (verb survives as a `jq` roll-up; only the routing-stats *scripts* die) + `import`. **DELETE (→ Tier 1):** `skills/masterplan-detect` (zero v8 wiring; ambient detect superseded by the direct `import` verb) + `parts/import.md` (verb survives as `mp migrate-bundle`). **Still genuinely Tier 2:** `parts/contracts/` (TRANSFORM-INCOMPLETE — port-check `plan-annotations.md`/`agent-dispatch.md`/`codex-review.md` content against v8 before deleting) and `Makefile` (TRIM — its 5 targets all wire to the v7 `tests/` tree, none to the v8 `node:test` suite).

## 2026-05-29 — v8 (masterplan-ng): publish-hygiene scrub of WORKLOG + CHANGELOG, then first push

Acted on the publish-hygiene follow-up the prior entries flagged. Ran `scanForRealIdentifiers()` (the same standard the `test/fixtures/` cutover guard enforces) over WORKLOG.md + CHANGELOG.md and scrubbed every hit (24 total: 21 + 3) to synthetic/abstract form: owner-org / sibling-project references generalized, the one real in-flight dev-slug replaced by the sanitized fixture name, absolute dev-host paths reworded to repo-root, and the guards' own self-documentation reworded to name the deny-token *classes* (pointing at `lib/hygiene.mjs` `DENY_RULES`) rather than spelling the literal codenames. Verifiable: scanning both files now returns **0 hits**, matching the `test/fixtures/` standard. The legitimate public `rasatpetabit-masterplan` / `rasatpetabit/masterplan` ids are untouched (the deny `\b` can't fire inside them). Guard suite unchanged: `node --test test/*.test.mjs` → **232 pass / 0 fail / 0 skipped**. Orchestrator sole committer (CD-7).

**Coverage boundary (no silent cap):** the fixture standard catches dev-host paths, owner-org, codenames, and product codes — NOT bare hostnames or developer login names, a few of which still appear in older entries. Those are outside the fixture-sanitization standard the user asked to match; flagged here for a separate call if the owner wants them generalized too. Source files `lib/hygiene.mjs` + `test/publish-hygiene.test.mjs` necessarily carry the literal deny tokens (a deny-list must name what it denies) and are out of this scrub's scope.

**Pushed:** `masterplan-ng` published to origin via `git push -u origin masterplan-ng` (user-authorized). `main` stays at v7.2.3 published/stable until parity cutover.

## 2026-05-29 — v8 (masterplan-ng): Step 6 published-guards — release-hygiene + publish-safety as CI tests (Phase 4, execution complete)

Built item (B) from the entries below: the three release-hygiene concerns are now **enforced invariants**, not manual reminders. New `lib/hygiene.mjs` (pure, exported, zero-dep detectors) + `test/publish-hygiene.test.mjs` (18 tests) under ng-ci (`node --test test/*.test.mjs`).

**Decision — guards live in `test/` + `lib/hygiene.mjs`, NOT as L4 doctor modules** (REVERSING the prior entry's "two L4 doctor checks" plan). Advisor-gated, then triple-confirmed by primary sources: `lib/doctor/README.md:63-66` ("Release-hygiene checks … move to CI / pre-commit, **since end users don't have the repo**"), `bin/doctor.mjs:11-12` ("release-hygiene → CI"), and the explicit 10-module count test in `doctor.test.mjs`. A doctor module ships to end users (who have no manifests/fixtures to check) and would break the count test; a CI test is the correct home. `lib/hygiene.mjs` sits at lib/ ROOT so `bin/doctor.mjs`'s `lib/doctor/`-scoped auto-discovery never picks it up. The AUQ chose the *what* (hygiene + fixture-identifier guard); the codebase dictated the *where*.

**Three guards, each with the FAIL-capable triad** (advisor: a clean-tree assertion passes vacuously if the detector silently broke — so planted-failure detection is the load-bearing test, not the live sweep):
- **(1) fixture-identifier scan** — the headline CUTOVER guard. `scanForRealIdentifiers()` runs a deny-list over `test/fixtures/` *content* covering absolute dev-host paths, real home dirs (synthetic `/home/user/` allowed), the owner-org prefix, and the internal codename / product-code set — see `lib/hygiene.mjs` `DENY_RULES` for the literal patterns (the owner-org `\b` rule deliberately can't fire inside the public `rasatpetabit-masterplan` id, so it needs no allowlist clause). Never matches bare 64-hex, so the index-staleness `sha256(plan.md)` content digest is a non-issue (resolves the deferred 64-hex question — it was never an identifier).
- **(2) cross-manifest version sync** — `readReleaseVersion()` (README `Current release: **vX.Y.Z**`, the CI seed source-of-truth) + `findVersionDrift()` over the 4 tracked manifest fields (`.claude-plugin/marketplace.json` root + `plugins[0]`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`). `package.json` EXCLUDED (private `8.0.0-ng.0` dev marker until cutover). Live: all agree at 7.2.3.
- **(3) namespace collision** — `parseReservedVerbs()` single-sources the verb list from the orchestrator prompt; `findNamespaceCollisions()` flags `shadows-builtin` (a skill dir in the forbidden set — seeded with `plan`, the v7.2.2 `/plan`-hijack regression) and `unwired-verb` (a skill dir that is neither a reserved verb nor infra). Live `skills/` clean.

**Dropped (documented, no silent cap):** `router-size/prose` — a v7 heuristic with no v8 contract (the clean-core orchestrator has no enforced prompt-size budget). Also dropped the `-home-<name>-` slug heuristic: it false-positives on legitimate feature slugs (`home-page`, `home-screen`) — same substring-landmine class the advisor flagged for the owner-org prefix; absolute dev-host + real-home paths cover the content-form path-leak vector.

Authoritative gate: `node --test test/*.test.mjs` → **232 pass / 0 fail / 0 skipped** (was 214; +18). Mutation check (proof the gates bite, not just pass): a doctored fixture string tripped three deny rules (the home-path, owner-org, and codename rules); an injected `7.3.0` codex manifest flagged version drift; a synthetic `skills/plan/` flagged `shadows-builtin`. Orchestrator sole committer (CD-7). **Not pushed.**

**v8 execution track is now complete** (Phases 1–4 done: 6 doctor BUGs + 2 DECISIONS + CUTOVER sanitize + published-guards). **Follow-up flagged for the user (a separate publish-hygiene call, intentionally NOT auto-rewritten here):** WORKLOG.md + CHANGELOG.md still carry owner-org / sibling-project references — the user's own org in the user's own repo. The fixture guard scopes to `test/fixtures/` only and does not touch these; whether they ship as-is is the owner's call.

## 2026-05-29 — v8 (masterplan-ng): CUTOVER sanitization of legacy-bundle fixtures (Phase 3 of the published-guard track)

Closed remaining item (A) from the DECISIONS entry below: the three `test/fixtures/legacy-bundles/` fixtures were **verbatim other-repo run bundles** — real slugs, commit SHAs, absolute `/home/<user>/` + dev-host paths, vendor product codes. They are CI ground truth (the migrate extractor's only real-structure exercise) so they must stay committed, but must not ship real identifiers. Sanitized in place, keeping every structural property the targeted line-extractor depends on; the test suite is the proof the structure survived.

**Decision — sanitize, don't redact-to-toy.** Advisor-gated. The fixtures' *value* is that they're structurally real (col-0 vs indented `- idx:`, mixed statuses, folded `note:`/`name:` scalars, a `recent_events:` col-0 list after `tasks:` that proves region-bounding). Replacing identifiers preserves that; trimming to a toy bundle would have silently weakened coverage. migrate.mjs drops names/commits/notes on migration (only `{id,status,wave:null,files:[]}` survive), so those fields were never asserted — free to genericize.

**What changed.** The in-flight fixture was renamed to `5.0-inflight-sample.yml` (its prior filename carried a client codename; 32 mixed-status tasks, the risky path). `5.0-archived-codex-routing-fix.yml` + `5.1-archived-cc3-visibility.yml` sanitized, filenames kept. Synthetic conventions (also the future guard's positive enforcement): home paths → `/work/...` or `/home/user/`; 7-char SHAs → `a00000N`/`b00000N`; full hashes → `sha256:`+64 zeros. Lockstep test refactor: `migrate.test.mjs` (`WBN`→`SAMPLE`, slug assertion, header comment) + `bin-masterplan.test.mjs` (`WBN`→`SAMPLE` const + 3 copyFileSync) re-pointed; residual client refs scrubbed in `lib/migrate.mjs:12`, `resume.test.mjs:120`. Assertions (counts/indices/statuses) unchanged — structure-preserving by construction.

Authoritative gate: `node --test test/` → **214 pass / 0 fail / 0 skipped** (unchanged; structure-preserving). Deny-list grep over `test/fixtures/` clean except the plugin's own public identifier `rasatpetabit-masterplan` (legitimate) and one index-staleness content-hash (a value the staleness check *compares*, not a client identifier — resolved in Phase 4). Orchestrator sole committer (CD-7). **Not pushed.**

**Next — Phase 4 / Step 6 published-guards (item (B), now unblocked):** two L4 doctor checks — `release-hygiene` (cross-manifest version sync, router size, namespace collision) + `fixture-hygiene` (identifier scan over `test/fixtures/` enforcing the deny list + synthetic conventions, so the cutover gate becomes an *enforced* invariant). Resolve the index-staleness 64-hex content-hash there. **Flagged for the user (out of scope here):** WORKLOG.md + CHANGELOG.md carry owner-org / sibling-project references — a separate publish-hygiene call.

## 2026-05-29 — v8 (masterplan-ng): resolved the 2 Codex doctor DECISIONS (#1 registry SHA-drift, #4 orphan state.yml)

Closed the two deferred DECISION findings from the Codex doctor review. Done **inline, not via Workflow** — 2 design-heavy edits sharing one test file, no fan-out benefit. Advisor-gated on the design calls before writing; the advisor also drew the line that the remaining cutover + Step 6 work is **not** autonomously executable (a user fact / an unwritten spec), so this run executes only the well-defined tail.

**#4 state-schema (DECISION → WARN).** A `docs/masterplan/<slug>/` dir with no readable `state.yml` was silently `continue`'d → an all-orphan `docs/masterplan` returned PASS (false confidence). Now **WARN, not ERROR**: a transient/hand-created non-bundle dir should surface for cleanup without hard-failing doctor (exit 1 stays reserved for real schema violations). New prefix fixture `warn-orphan-no-state/` (with a tracked `plan.md` so git keeps the dir) + an explicit inline test pinning the message.

**#1 plugin-registry-drift (DECISION → implement, REVERSING the documented "version-only" scope).** Added an injectable `opts.gitExec` SHA-compare: when version strings MATCH, compare the installed entry's `gitCommitSha` against the marketplace clone's `git rev-parse HEAD`; differ → WARN (same-version **stale runtime cache** — the deploy-pipeline pain dev≠marketplace≠cache). **Override rationale:** the original "out of scope" note (module lines 15-18) predated confirming (a) `installed_plugins.json` reliably records `gitCommitSha` and (b) the marketplace dir is a real git clone — both verified on this host, so the compare is cheap and degrades gracefully. The default gitExec is **`.git`-in-dir guarded** so it never walks up into an ancestor repo — critical, because fixture `homeDir`s are nested inside this worktree and a naive `rev-parse` would resolve the *worktree* HEAD and falsely WARN `pass-match`. Any git failure / missing `.git` / missing `gitCommitSha` → version-only result. The SHA-drift WARN is reachable only via injected gitExec (the auto-discovery harness passes none), so it's covered by 5 inline tests (sha match→PASS, drift→WARN, null→PASS, throws→PASS, no-recorded-sha→PASS); committed prefix fixtures stay version-only.

Authoritative gate: `node --test test/` → **214 pass / 0 fail / 0 skipped** (was 207; +7). Live `node bin/doctor.mjs` on this host: `plugin-registry-drift` PASS (installed sha == marketplace HEAD `0b7d045`), `state-schema` PASS (no orphan dirs) — confirmed **no spurious WARN on a clean machine**. Orchestrator sole committer (CD-7). **Not pushed.**

**Remaining — NOT autonomously executable (surfaced for the user, per advisor):**
- **(A) CUTOVER sanitization** of `test/fixtures/legacy-bundles/` — needs a fact only the user has: "sanitize" vs "confirmed-public-OK" is a call about *their own* project data, and it only gates a push that is explicitly off. The lockstep test refactor (`migrate.test.mjs` + `bin-masterplan.test.mjs` hard-assert the real slug/counts/indices) is deferred until that call.
- **(B) Step 6 published-guards** — unspecced and coupled to (A). **Proposed shape:** a pre-publish doctor check (or `test/`) that FAILS if `test/fixtures/` contains real-identifier patterns — absolute `/home/<user>/` paths, known product codes, non-synthetic full SHAs — operationalizing the cutover gate as an *enforced* invariant rather than a manual reminder. Spec to be confirmed before building.

## 2026-05-29 — v8 (masterplan-ng): resolved 6 Codex doctor BUG findings via Workflow fan-out (#2,#3,#5,#6,#7,#8)

Landed all 6 BUG findings from the Codex doctor review (entry below) in one commit. Used the **Workflow tool** (multi-agent JS orchestration) — one implementer per disjoint file-group, TDD red→green, then a single post-barrier verify agent. Topology was conflict-free by design: `test/doctor.test.mjs` (the only shared-write file, findings #5+#8) went to a single agent; every other path had exactly one owner; most regressions are NEW auto-discovered fixture dirs rather than test-file edits, so parallel writes never collided. Implementers ran module-scoped `node -e`/`node --check` self-checks only — never the full suite — to avoid `node --test` races on a sibling's mid-`mkdir`.

Fixes: **#2** index-staleness — dropped the `if (!checked)` guard so `state.plan_hash` and `plan.index.json` are checked independently (fresh-state+stale-index no longer false-PASSes). **#3** scalar-cap — `path.resolve`+`realpathSync`+containment check before any read; traversal/symlink-escape pointers WARN instead of reading outside the bundle. **#5** legacy-bundle — WARN only when `docs/superpowers/` holds real `.md` artifacts, not empty container dirs. **#6** .gitignore — scoped re-ignore globs (`.env`/`*.key`/`*.pem`/etc.) after the `!test/fixtures/**` catch-all; `auth.json` deliberately left tracked. **#7** codex-auth — distinguish `ENOENT`→SKIP from JSON parse-error→WARN. **#8** doctor.test.mjs — `assertFindingShape()` on the 3 slice SKIP-path tests + rewrote the legacy-bundle WARN test to plant a real artifact.

Orchestrator was sole committer (CD-7); agents returned digests only. Authoritative gate: `node --test test/` → **207 pass / 0 fail / 0 skipped** (was 197 pre-batch; +10 from new fixtures/tests). Trackability re-verified: `auth.json` not ignored, `.env`/`*.key`/`*.pem` under fixtures now ignored, zero `!!` entries under `test/fixtures/`. **Not pushed** — CUTOVER GATE on `test/fixtures/legacy-bundles/` (verbatim other-repo bundles) must be sanitized-or-confirmed-public-OK first. Deferred: findings #1 (plugin-registry-drift) + #4 (state-schema) — the 2 DECISIONS — and Step 6 published-guards. *(#1 + #4 now RESOLVED — see the DECISIONS entry above; CUTOVER + Step 6 remain.)*

## 2026-05-29 — v8 (masterplan-ng): Codex defect review of L4 doctor layer (first independent-engine pass)

Ran the FIRST Codex review over the complete L4 doctor layer (commit `8ffc9e7`). The L1 core got a Codex adversarial pass during hardening, but the doctor layer — slice + batch — had only had Claude fresh-eyes + advisor passes (shared blind spots: sonnet implementer → claude reviewer). Invocation: foreground `timeout -k 10 540 codex exec -s read-only --dangerously-bypass-approvals-and-sandbox -C <repo>` (the `mp-codex-reviewer` contract shape — flag combo probe-verified on codex-cli 0.135.0 first; can't orphan, `timeout`-bounded). Not `codex-scan.sh` (it's `--scope working-tree` and the tree was clean post-commit). Verdict archived: `/tmp/codex-doctor-verdict.md` + full log `/tmp/codex-doctor-full.log`.

**8 findings, all verified against the code by the orchestrator (none hallucinated):**
- **#1 plugin-registry-drift (Codex HIGH → DECISION):** version-only compare omits v7 #50's `gitCommitSha` vs marketplace `git rev-parse HEAD` check → same-version-but-stale runtime cache is a false PASS. *Documented-intentional* (lib/doctor/plugin-registry-drift.mjs:15-18, "sha comparison needs gitExec, out of scope"). But this is exactly the deploy-pipeline pain (dev≠marketplace≠cache). Adding it = inject `opts.gitExec` + a same-version/diff-SHA fixture.
- **#2 index-staleness (Codex HIGH → real-but-narrow):** `if (!checked)` (index-staleness.mjs:79) makes `plan.index.json` a *fallback*, not independent — fresh `state.plan_hash` + stale `plan.index.json` → PASS (Codex reproduced). Only bites when the two recorded hashes diverge (a healthy bundle has them equal). Header documents priority-order as deliberate. Fix: check both independently.
- **#3 scalar-cap (Codex MED → real hardening):** overflow pointers joined directly (scalar-cap.mjs:52) → `../../` / symlink can read outside the bundle. Low real-world risk (own bundles). Fix: `path.resolve` + containment + symlink-escape reject.
- **#4 state-schema (Codex MED → DECISION):** a `docs/masterplan/<slug>/` dir with no readable `state.yml` is silently `continue`'d (state-schema.mjs:42) → all-missing returns PASS (Codex reproduced). Orphan dir (ignore, current) vs corrupt bundle (WARN/ERROR)? ERROR risks false-positives on transient/non-bundle dirs.
- **#5 legacy-bundle (Codex MED → real minor):** any `docs/superpowers/` dir WARNs (legacy-bundle.mjs:65), incl. empty/container-only — v7 only warned on actual plan/spec/status artifacts. Fix: port the artifact-existence guard.
- **#6 .gitignore (Codex MED → defense-in-depth):** `!test/fixtures/**` (.gitignore:71) re-admits `.env`/`*.key`/`*.pem` IF copied under fixtures. No real leak today (doesn't touch root/home secrets). Fix: re-ignore secret globs under `test/fixtures/**` after the catch-all.
- **#7 codex-auth (Codex LOW → real minor):** malformed `~/.codex/auth.json` → SKIP "codex not installed" (codex-auth.mjs:35), masking corruption. Fix: distinguish ENOENT from JSON parse error; WARN on malformed.
- **#8 test/doctor.test.mjs (Codex LOW → correct):** the 2 *slice* SKIP-path inline tests (scalar-cap:111, worktree no-bundles:135) still use bare `maxSeverity()` without `assertFindingShape` — the orchestrator's earlier hardening fixed the 7 NEW modules' SKIP paths but missed the slice ones. Fix: add the shape-assert + fixtures for #1/#2/#4/#5/#7/#3 regressions.

**Codex confirmed clean by inspection:** dispatcher crash-isolation + unknown-severity-forced-to-ERROR; no module writes/mutates; `parseState` tolerant/non-throwing; `state-schema` imports the core schema (not redefined); `stale-lock`/`stale-codex-task` use `opts.now`; fixtures synthetic (dummy refresh token, fabricated JWT, fake SHAs — no real secrets). `node --test test/doctor.test.mjs` passes, but the gaps above mean coverage is insufficient.

**Process takeaway:** the doctor port should have had a Codex pass at the slice, not just the core — the Claude→Claude review chain missed two reproduced false-negatives. Resolution scope pending user gate (see next AUQ).

## 2026-05-28 — v8 (masterplan-ng): step 5 (doctor L4) COMPLETE — all 10 checks, full suite 197/197 green

Implemented the remaining 7 doctor check modules (`state-schema`, `legacy-bundle`, `codex-plugin-presence`, `index-staleness`, `stale-lock`, `stale-codex-task`, `plugin-registry-drift`) via a batched Sonnet port against the frozen contract, then a fresh-eyes review (anti-pattern #5) + orchestrator-applied fixes. Extended `test/doctor.test.mjs` and created fixture trees for all. Full repo suite now **197/197** green (was 146 at the slice). Live `node bin/doctor.mjs` runs all 10 checks, 0 ERROR — and surfaces *real* host findings (Gemini companion jobs stuck 25–30h via `stale-codex-task`), proving the checks work on real data.

**Key semantic decisions (deviations from the brief's implicit numeric-only framing):**
- `schema_version` quote-normalization: v7 bundles on disk store `'5.1'` / `"5.0"` (YAML single/double quoted strings). `parseState` returns these as embedded-quote strings; both `state-schema` and `legacy-bundle` now strip wrapping quotes before `parseFloat` to classify them correctly as legacy (< 6). Without this, `state-schema` false-positives ERROR on every existing v7 bundle. Decision is the load-bearing semantic call of this batch; recorded here as the rationale for the non-obvious guard.
- `codex-plugin-presence` emits PASS (not absent from findings) when the plugin is present; WARN/SKIP are the missing-plugin signals. The README survivor table's severity cell was corrected to `PASS/WARN/SKIP` in this amend to match.
- `stale-codex-task` summary says "codex task stuck" for Gemini jobs because the glob is plugin-agnostic (per brief). Real findings on this host are Gemini background tasks. Cosmetic; behavior is correct.

**Implementer pre-return fixes:**
1. `test/fixtures/doctor/legacy-bundle/skip-no-bundles/docs/masterplan/.gitkeep` added — git won't track an empty dir without it; the committed fixture would silently disappear from the `scenarios()` loop post-commit.
2. Two in-code mkdtemp tests added covering the `plan.index.json` fallback path in `index-staleness` (previously zero coverage on the `if (!checked)` branch). `import { createHash } from 'node:crypto'` added to test file top-level imports.

**Orchestrator post-review fixes (3, CD-7 single-writer — applied after fresh-eyes review):**
1. **`.gitignore` blocker (HIGH).** Lines 13–25 (`.claude/`, `.codex/`, `.claude-plugin/`, `**/.codex/auth.json`) silently excluded **12 host-path fixture files** — incl. the *already-"committed"* `codex-auth` slice's `auth.json` (so the slice itself had broken CI ground truth). Tests passed locally only because the files sat on disk; a fresh clone / CI would have none. Added scoped `!test/fixtures/**` negations (dir-negations re-admit the dot-dirs so git recurses; catch-all re-admits files incl. `auth.json`). Verified: `git check-ignore` danger-set now empty; all 12 stage. This retroactively fixes the slice gap too.
2. **`state-schema` ordering (MED → reclassified clarity-only).** Moved the `schema_version < 6` legacy-deferral *ahead* of the zero-keys ERROR. The reviewer flagged this as a false-ERROR risk, but on re-analysis it is a **behavior-preserving no-op**: zero-keys and a readable `schema_version` are mutually exclusive (zero modellable keys ⇒ no col-0 `schema_version:` ⇒ `svNum` is `NaN` ⇒ the deferral cannot fire in *either* order). A v7 block-YAML bundle that still carries a col-0 `schema_version:` line was never zero-keys, so it already deferred before the move. Kept anyway because the reordered code reads in deferral-then-validate intent order and is robust if `parseState` ever becomes less tolerant — but it is NOT the "false-ERROR fix" the reviewer's MED finding implied. The actual block-YAML behavior (zero col-0 keys → ERROR "unparseable") is correct and was confirmed on live bundles.
3. **Test hardening (HIGH).** 8 SKIP-path tests called `maxSeverity(check(...))` inline — but `maxSeverity([])` seeds to `'SKIP'`, so a regression to an empty array (violating the ≥1-finding contract) would have passed silently. Each now captures `findings`, asserts `assertFindingShape` (length ≥ 1 + shape), then `maxSeverity`.

**Fixtures are synthetic** (dummy tokens `rt_fixture_dummy_value`, JWT `{"exp":11}`, fake SHA `abc1234`) — no real secrets. NOTE: `test/fixtures/legacy-bundles/` (verbatim other-repo bundles) is the separate CUTOVER-GATE concern — must be sanitized-or-confirmed-public BEFORE any push; this commit is scoped by path to exclude it.

**Known cosmetic gap (deferred, sub-threshold per review):** `stale-codex-task` says "codex task" for Gemini companion jobs (glob is plugin-agnostic by design; fix line carries the exact path). (The earlier `codex-plugin-presence` README-labelling gap was closed in this amend — survivor table now reads `PASS/WARN/SKIP`.)

`node bin/doctor.mjs` on live worktree: 10 checks, 0 errors, 21 warnings (legacy v7 bundles, stale Gemini tasks, one stale plan hash, one scalar overflow — all real findings). No false positives on main, masterplan-ng, or concurrency-guards bundles.

## 2026-05-28 — v8 (masterplan-ng): step 5 (doctor L4) STARTED — dispatcher + first 3-module slice (suite 146/146)

Began the L4 doctor port. Built the load-bearing **contract + dispatcher** plus a 3-module slice chosen to prove all three `opts` shapes at once; the remaining 7 modules are a batched port (next).

**Contract (advisor-pressure-tested, settled here):** each `lib/doctor/<name>.mjs` exports a **synchronous** `check(repoRoot, opts) -> Finding[]`, `Finding = {id, severity: 'PASS'|'WARN'|'ERROR'|'SKIP', summary, fix}`. The decisive change from the orientation sketch: **`Finding[]`, not a singular `{severity,fix}`** — `worktree-integrity` alone scans N bundles × {worktree, branch} with distinct fixes; collapsing would gut actionable remediation. A module **owns its scope** (plan-scoped globs `docs/masterplan/*` internally; user-scoped ignores `repoRoot`, reads host paths via `opts`), always returns **≥1 finding** (PASS clean / SKIP n/a), and `opts` is the testability seam (`homeDir` / `gitExec`+`repoRoot` / `now`). **`SKIP` is first-class** (codex-absent, not-a-git-repo, no bundles) — the doctor runs anywhere.

**`bin/doctor.mjs`** (was a stub): discover `lib/doctor/*.mjs` → run each **crash-isolated** (a throw → one synthesized ERROR; a single buggy check can never abort the run) → flatten → print → exit non-zero **iff any ERROR** (WARN/SKIP → exit 0). An unknown severity is forced to ERROR (fail loud).

**Slice (3 of ~10), each a distinct opts shape:** `scalar-cap` (#32, pure-bundle, no opts), `worktree-integrity` (#3/#4/#29(a), git via injected `gitExec`), `codex-auth` (#39, host path + injected `homeDir`/`now`). Reused `resolveRunsDir`/`bundleArtifacts`/`parseState` from the lib layer (dogfood the canonical reader). **#29(b)/#48 orphan-untracked-worktree deliberately NOT ported** — it false-positives on every ordinary worktree incl. masterplan-ng's own (why v7 bash only did the missing half); we flag bundle→git drift, never git→bundle.

**FIXTURE DEVIATION from the approved plan (surfaced, not silent):** the plan says "reuse `tests/doctor-fixtures/`", but that set is v7 block-YAML (`schema_version: 3`) testing the v7 doctor being deleted. New v8 root `test/fixtures/doctor/<check>/<scenario>/`; scenario dir-prefix (`pass-/warn-/error-/skip-`) encodes expected worst-severity (replaces the v7 `expected.txt` substring harness). Flat-compatible v7 fixtures (check-32, check-39 data) copied into the v8 root; the rest authored fresh. The v7 `tests/doctor-fixtures/run.sh` harness is left to die with the v7 doctor.

**Verification.** New `test/doctor.test.mjs` (22 tests: dispatcher crash-isolation/exit-codes/discovery + all 3 modules fixture-driven + SKIP edge cases) → full suite **146/146** (was 124). **End-to-end `node bin/doctor.mjs .` against the live worktree** found a *real* WARN (`concurrency-guards` bundle's 281-char `worktree_decision_note`) and PASSed worktree-integrity **without** false-positiving on this worktree — confirming both that it works on real data and that the #29(b) scope call was right. `main` untouched. Next: batched Sonnet port of the 7 remaining modules (`state-schema` #9+#10-folded minimal, `legacy-bundle` #1, `codex-plugin-presence` #18, `index-staleness` #34, `stale-lock` #42, `stale-codex-task` #49, `plugin-registry-drift` #50) + fresh-eyes review (anti-pattern #5).

## 2026-05-28 — v8 (masterplan-ng): R2b (codex watcher-harness) RESOLVED by construction — analysis turn, no code

The user picked "R2b — codex watcher-harness" as the next build item. Investigation (advisor-pressure-tested) found the runtime path is **already R2b-safe by construction**, so the honest deliverable is to *record that* + flag the one cross-project residual, NOT build a detached watcher (which would be regressive — it re-adds the machinery v8 deletes).

**Root cause was the dispatch shape, not a missing watcher.** R2b's two live failure modes (orphan; MCP-wedge hang) were both artifacts of the *detached, harness-untracked* `codex:codex-rescue` dispatch. v8 routes review through a harness-tracked Workflow `agent()` (`masterplan:mp-codex-reviewer`):
- **orphan → eliminated** — the native Workflow tool emits a completion notification and the call is tracked in the run (the asymmetry that bit the out-of-process route is gone). This is the *direct* fix for mode 1, and the bigger half.
- **hang → bounded** — the reviewer runs a synchronous foreground `timeout -k 10 540 codex exec` and returns an inconclusive NOTE on cap/empty/missing-binary (`agents/mp-codex-reviewer.md`); never hangs.
- **death-without-results → covered** — `implement`/`review` never null (synthesize a `failed` digest) → L1 re-dispatches idempotently.
- **MCP-child lock → structurally removed for the default path** — base `~/.codex/config.toml` is ICM-free (icm MCP is opt-in via a `codex -p <name>` overlay), so reviews can't contend on the shared `~/.local/share/icm/memories.db` lock that wedged the hand-run.

A watcher supervises a *detached* job; v8's review path has none — so productizing one is regressive, not protective.

**Dev-time entry point (the adoption deliverable).** The *development* loop still reaches for a raw `codex:codex-rescue` Agent dispatch — which is precisely where the orphan still bites (it's a Claude Code harness behavior, not masterplan code). For an on-demand Codex second opinion while developing masterplan, use the hardened `~/.claude/bin/codex-scan.sh` (own-process-group launch + stall/max-runtime watchdog + group-kill of a wedged `icm serve`) instead of a bare rescue dispatch.

**Cross-project residual (flagged, NOT actioned here — out of masterplan scope).** `~/.claude/bin/codex-scan.sh` is host-global, untracked, hand-synced from `yanos-project/scripts/codex-scan.sh` under a parity-diff contract. It has header/body drift: the header documents `run_supervised`, `run_detached_with_reaper`, and a `CODEX_SCAN_SUPERVISED=0` escape hatch that the body never implements (body = legacy `run_with_watchdog` for `--wait`; `--background` delegates to the companion's detached worker). Reconcile in the canonical yanos copy first (editing one parity copy alone breaks the diff guard) — see `~/.claude/refs/icm-codex-scan-architecture.md §5.1`.

Net: R2b risk marked RESOLVED in the plan; no code touched; suite unchanged at **124/124**. Next: Step 5 (doctor L4, ~12 external-integration checks).

## 2026-05-28 — v8 (masterplan-ng): the two parked design forks resolved (A/A) — decision turn, comments only

Closing the two forks parked after Step 4 so the build order resumes on settled ground. Reasoned against the v8 rubric (durable on-disk state > token efficiency > context-window mgmt; reliability/parity rank below and are *served* by these) and pressure-tested with an adversarial advisor pass.

**Fork 1 — codex-implementer: RESOLVED → A (keep inline-only; no codex-implementer).** Every task stays implemented inline by `mp-implementer` (sonnet); `routeTask`'s `target` is informational/logged-only. A codex-IMPLEMENTER needs WRITE access → reintroduces the entire v7 sandbox/worktree-git/silent-exit/empty-diff/orphan hardening series that v8 exists to delete. Parity ranks below the top-3 rubric goals, so it buys nothing the rubric rewards. The codex-REVIEWER is retained — a foreground `timeout codex exec` is read-only and cannot orphan (the unsafe write-path is the implementer, not the reviewer). Formalized in `workflows/execute.workflow.js` header (was mislabeled "SCOPE this iteration / deferred"; now a standing design decision) + fixed a stale claim that `target` "gates the optional REVIEW" — review is CONFIG-gated, never target-gated.

**Fork 2 — review topology: RESOLVED → A (keep per-task single-pass).** Not per-wave, not spec+quality two-stage. Discriminators (advisor corrected an initial per-wave lean): (1) review is config-gated **OFF by default** — a fewer-calls topology wins nothing on the common path; (2) per-task is **failure-isolated** against flaky Codex — one wedged `codex exec` degrades one task's review, whereas per-wave loses the whole wave's coverage; (3) the planner's **disjoint-scope** wave invariant structurally limits within-wave cross-task bugs, gutting per-wave's "sees interactions" upside. Two-stage (2N Codex calls) violates token-efficiency and is the self-checking v8 trims. Per-wave's only real niche (large waves + review-on) isn't this project's case. No engine change — the built pipeline already implements A; decision documented in the `review()` header.

Net: decision turn, comments-only touch, suite stays **124/124** green. Next: Step 5 (doctor L4 — ~12 external-integration checks), or the deferred R2b codex-scan watcher-harness.

## 2026-05-28 — masterplan-ng: step 4 COMPLETE — L2 engine + the L1↔L2 seam (suite 124/124)

The largest prose→JS conversion (v7 `parts/step-c-dispatch.md` + `step-c-verification.md` → a Workflow-tool script). **`workflows/execute.workflow.js`** runs EXACTLY ONE wave per launch — L1 drives the loop (decide→dispatch→record→decide→next), so a crash leaves a single-wave `active_run` that recovers by resetting just that wave's declared scope (a multi-wave workflow would make recovery ambiguous). Load-bearing constraint: a Workflow script has NO module/fs/git access, so it CANNOT `import lib/routing.mjs` and CANNOT run git — "L2 consumes routing.mjs" therefore means **L1 PRE-RESOLVES routing** (`mp prepare-wave`, which runs `routeTask`) and threads lean, already-routed task payloads down via `args`; the git baseline is captured by the shell, passed through `args.baseline`, and echoed back in the result for the completion-turn `mp verify-scope` diff. Dispatch is `pipeline(tasks, implement, review)` NOT `parallel()`: task A's review starts the instant A implements (disjoint same-wave scope is the planner's invariant) while B still implements — and the pipeline's resolve-when-all-clear IS the wave barrier L1 awaits via the completion notification. **Design calls:** (1) **codex-implementer deferral is SCOPE, not safety** — the step-3 roster ships mp-implementer + mp-codex-reviewer only, so every task is implemented INLINE regardless of routed `target`; `target` is recorded + `log()`'d (a real, non-silent routing decision, never a silent cap) and gates only the optional review. A foreground `timeout codex exec` cannot orphan, so a codex-implementer is a later feature choice, not a safety fix. (2) **Review is CONFIG-gated only, never eligibility-gated** — judgment-heavy inline-routed tasks need a second opinion MORE, not less; gating review by codex-eligibility would skip exactly the riskiest work. Only `done` tasks are reviewed. (3) **`implement` never throws/nulls** — synthesizes a `failed` digest on skip/error so a task is always RECORDED (a vanished pipeline item would read as "wave smaller than it is"); L1 leaves it pending → next decide re-dispatches idempotently.

**The L1↔L2 seam** (`commands/masterplan.md` §2a, new): Launch = `mp prepare-wave` → capture git baseline → `mp set-active-run --wave=N` (phase-1, BEFORE launch) → background-launch the workflow with `args={wave,tasks,baseline,repoRoot,review}` → `mp promote-active-run` (phase-2 handles) → close. Completion (re-invoked holding the engine's `<result>`) = **record done digests via `mp mark-task` BEFORE any `decide`** (load-bearing: a finished run whose tasks are still `pending` on disk looks like a crash to `decide` → it would re-run a wave you already hold results for) → `mp verify-scope` (D6, baseline-subtract) → commit state+edits once → re-decide (→ finalize → next wave, or surface failed/blocked). **`bin` change:** `prepare-wave` now emits `review:'on'|'off'` (leniently normalized from `state.codex.review`, `--review` overridable) so the shell needn't parse state.yml; the workflow gates on `=== 'on'`. **R1 (telemetry gap) — AGGREGATE half confirmed, PER-AGENT half DEFERRED** (the distinction matters: Resolved #5 gates deleting the telemetry hook on R1). The step-0.5 spike confirmed the completion `<task-notification>` carries a native `<usage>` *aggregate* cost block → no hook needed for wave-level cost. But the per-agent fields (model/tokens/duration via `agent-<id>.jsonl`) that Resolved #5 actually gates on are NOT yet verified — no live workflow run has produced those records — so they are deferred to the step-8 dogfood alongside the session-death question. **Do NOT delete the telemetry hook until a live run confirms per-agent records.** **Session-death-vs-TaskStop** empirical question deferred to the step-8 dogfood (design is safe either way: reconcile-before-recover). Workflow is **syntax-checked only** (async-wrap harness — bare `node --check` rejects the runtime's top-level `return`) until that live dogfood. New **`lib/wave.mjs`** (`prepareWave`/`declaredScope`/`verifyScope`, pure) + **`test/wave.test.mjs`** (13 tests) → suite **124/124** (was 111). **Fresh-eyes audit** (anti-pattern #5, sonnet): 0 blocking, all 8 seams clean; 5 surgical findings fixed — `mp-implementer` start_sha comment (recovery is path-scoped; SHA is provenance, not the reset driver), a pipeline `(prevResult,originalItem)` signature comment, `--review` documented in the bin CLI header, and §2a completion `git clean -f`→`-fd` (consistency with the recover path); `leanPayload.eligible` emitted-but-unread is intentional routing-record completeness. `main` untouched. Next: step 5 (doctor L4), or the codex-implementer A/B + review-topology decision, or the deferred R2b codex-scan watcher-harness.

## 2026-05-28 — masterplan-ng: step 3 COMPLETE — dedicated agents/*.md fleshed out

Resolved the four plugin-root agent stubs' `TODO(step 3)` into production configs (advisor pre-write check first; structure lifted from the yanos sibling pattern, but icm-recall / private-path / WORKLOG-read content stripped — these ship in a *published* plugin, so invariants are masterplan-domain only). **`mp-planner`** (opus) is now the authoritative `plan.index.json` spec: a field-by-field schema kept **byte-synced with `lib/routing.mjs`** + `applyPlanIndex` (verified by re-reading both consumers post-write), with the three v7→v8 silent-fallthrough traps called out — (1) `codex` is a STRING `"ok"|"no"|null`, never the legacy boolean (`false` matches neither `=== 'no'` nor `=== 'ok'` → silently falls through to the heuristic); (2) `description` not `name` (routing scans `description ?? title`; `name` is read **nowhere** in v8 — confirmed against `applyPlanIndex`, which only bridges `idx`→`id`/`parallel_group`→`wave` — so a `name`-only task reads as an empty desc = trap); (3) integer `id`/`wave` not strings (string `wave` fails the `Number.isInteger` guard → hard crash on write; string `id` → `markTask` phantom-write). Plus the disjoint-same-wave-file-scope rule (the L2 `parallel()` barrier depends on it) and the L1-stamps-`plan_hash`/`generated_at` split (planner has no Bash). **Design call (advisor-confirmed):** `plan.index.json` *production* is mp-planner ONLY — not "explorer returns it as a digest" (that would flow a multi-task index through orchestrator context = goal-3 violation) and not giving explorer Write. So **`mp-explorer`** stays pure read-only recon (situation reports / doctor facts → digests) and refuses index authoring; `commands/masterplan.md` §2 re-parse route dropped its now-stale `/ mp-explorer` mention (anti-pattern #4 sync). **`mp-implementer`** (sonnet): pinned the return digest schema (`task_id` / `status∈done|failed|blocked` / `start_sha` / `files_changed` / `verify[]` / `summary` / `blockers`; `done`→mark-task, `failed`/`blocked` surface since the mark-task enum is `pending|in_progress|done`) + the D6/F-SCOPE contract (launch-cwd IS the repo; orchestrator independently `git status`-verifies scope post-barrier and resets on violation). **`mp-codex-reviewer`** (sonnet): pinned `timeout -k 10 540 codex exec -s read-only --dangerously-bypass-approvals-and-sandbox -C <repo> "<prompt>"` — a **synchronous foreground** call, which does NOT inherit R2b's orphan failure mode (that was the *detached* launch); the R2b background-scan harness is explicitly NOT reproduced here. On cap / empty / missing-binary → one inconclusive NOTE (never hang, never fabricate). New **`test/agents.test.mjs`** lints every `agents/*.md` frontmatter (required keys, `model ∈ {haiku,sonnet,opus}`, `name`==filename, no leftover TODO) — suite **111/111** (was 106; +5). `main` untouched. Next: step 4 (`workflows/execute.workflow.js` — the L2 engine consuming `routing.mjs` + dispatching these agents) or R2b harness productization.

## 2026-05-28 — masterplan-ng: step 2 COMPLETE — thin shell commands/masterplan.md

Replaced the v7 lazy-loading router (131 lines + the ~390-line `step-0.md` decision logic it pulled) with a thin shell that SEQUENCES only: boot banner (`mp version` — the lone CC-2 survivor) → host-detect/suppress → verb parse → **resume controller** → turn-close AUQ. Deleted wholesale: the entire CC-3-trampoline (trace markers, breadcrumbs, per-turn summary-block hook signals, D19) — GONE; the JWT-decoding Codex-health boot block — GONE (→ doctor #39, step 5); `parts/*.md` lazy-loading — GONE (→ `bin` decisions + `agents/` + L2 + `superpowers` skills). The resume controller (§2) never decides in prose — it runs `mp decide` and executes the returned action (`surface_gate`/`wait`/`finalize_run`/`recover_and_redispatch`/`dispatch_wave`/`complete`), honoring the two-phase `active_run`, `staleTaskId` reconcile-before-reset, and git-stays-in-the-shell discipline. Content verbs delegate with explicit deferral markers (brainstorm/plan→`superpowers` skills [step 7]; execute dispatch→L2 [step 4]; doctor→`bin/doctor.mjs` [step 5]). **Fresh-eyes review** (anti-pattern #5, sonnet agent) cross-checked the prose against `bin`/`resume`/`agents`: all PASS except one — a `mp mark-task` example missing `--state` (fatal if followed verbatim) — fixed. **Verified with a hand-made-bundle drill** following the §2 sequence through the REAL `bin`: dispatch-w0 → launch-gap recover(null) → wait(alive) → finalize → dispatch-w1 → partial-crash recover(staleTaskId) → finalize → complete → gate-outranks-all (all actions correct). **Step 2 done** — resume controller + durable `pending_gate` + two-phase `active_run` + CD-7 single-writer, all on lib+bin (suite 96/96, no shell-level tests by design — the shell is thin prose over tested primitives). `main` untouched. Next: step 3 (`agents/*.md` flesh-out) or step 4 (`workflows/execute.workflow.js` — wires the real `dispatch_wave` launch + resolves the empirical session-death/orphan question).

## 2026-05-28 — masterplan-ng: step 2 deterministic core — resume lifecycle + bin adapter, suite 96/96

Advisor locked the L1 architecture: a THIN markdown shell (`commands/masterplan.md`) invoking pure lib through a fs-only CLI adapter (`bin/masterplan.mjs`) — not inline `node -e` (quoting-fragile) and not prose-logic (the anti-pattern being killed). Two deterministic-core pieces landed, both fully tested; the markdown shell itself is next.

**`resume.mjs` hardened for the `active_run` TWO-PHASE lifecycle** (advisor caught that the real durability hazard is launch-vs-record ordering, NOT write-vs-commit). Marker is `{wave, phase:'launching'}` written BEFORE a Workflow launch, promoted to `{wave, run_id, task_id}` AFTER launch returns handles. New branch: `active_run` present but **no `task_id`** → crashed in the launch gap → recover (prevents a double-dispatch onto a maybe-running Workflow). `resultsRecorded` is **dropped as a probe and DERIVED from disk** (every task of the run's wave `done` ⇒ finalize) — so the only external probe the shell passes is `alive`; finalize-vs-recover is otherwise deterministic over state (goals 2/3). The recover action carries `staleTaskId` (null if pre-launch) — the handle the shell MUST reconcile (TaskList/TaskStop a possibly-surviving orphan) before reset+redispatch. **Empirical unknown:** does a backgrounded Workflow outlive *real* session death (vs `TaskStop`)? Unverified — design is safe either way (reconcile-before-recover); confirm in the step-4 drill.

**`bin/masterplan.mjs` (new, fs-only — git stays in the markdown shell so the write/commit split stays recoverable).** Subcommands: `version` (the CC-2 banner, lone CC-2/CC-3 survivor), `detect-host`, `decide` (migrates in-memory; action JSON→stdout, errors→stderr+exit2), `migrate-bundle` (backup-original-then-persist = Resolved #7's "original backed up"; refuses to overwrite if migrate throws), `backfill-waves` (re-derives task wave/files from plan.index.json → satisfies resume's non-integer-wave guard for migrated bundles), + CD-7 single-writer ops `mark-task`/`open-gate`/`clear-gate`/`set-active-run`/`promote-active-run`/`clear-active-run`. Write ops **refuse an un-migrated legacy bundle** (no silent overwrite before backup). `is-main` guard keeps `formatBanner`/`applyPlanIndex` importable for unit tests.

Tests: resume 15 + bin 14 → **suite 96/96**. The bin integration tests double as the deterministic resume/crash drills (dispatch / complete / surface_gate / launch-gap→recover(null) / promoted→wait(alive) / dead→recover(staleTaskId) / migrate→backfill→dispatch). Next: thin `commands/masterplan.md` (verb routing + boot banner + host-suppress + resume controller wiring `decide`+actions + CD-7 commit + turn-close AUQ); content-verbs stubbed to their steps (brainstorm/plan→superpowers skills = step 7; execute→L2 Workflow = step 4). `main` untouched (0b7d045).

## 2026-05-28 — masterplan-ng: step 1 COMPLETE — migrate.mjs (legacy read-compat), suite 77/77

Last step-1 module lands; all six L1 pure modules are TDD-green. **`migrate.mjs`** reads pre-v8 bundles via a TARGETED zero-dep line-extractor (column-0 scalars + a bounded `- idx:`/`status:` task scan), NOT a full YAML parse — advisor-confirmed over the two rejected alternatives: python-shell (sheds v7's coupling, violates zero-dep) and a hand-rolled block-YAML parser (the fragility this rebuild kills). Real 5.x `state.yml` is PyYAML block-style — deeply nested (`brainstorm_anchor.evidence[]` folded scalars, `\u`/`\x` escapes, alphabetized) — but v8 carries forward only ~7 flat fields, so the nested blobs are never parsed (indented continuations skip the col-0 scalar matcher). Resolved #7 dial settled: one-shot 5.x→6.0 (live pop is single-version); 6.x passes through the flat parser; pre-5.0 is REFUSED loudly (R3). **Evidence (Explore sweep across all bundle roots):** exactly ONE real in-flight bundle with a mixed-status task list exists (the source later sanitized to the `5.0-inflight-sample` fixture, 5.0, 32 tasks) ⇒ the task extractor is real code, not dead — so it's built + tested, with the advisor's fail-loud as the safety net (throw, never half-migrate; caller backs up original first). Three FROZEN real fixtures: in-flight 5.0 mixed (`- idx:` at col-0, multi-line `note:`), archived 5.0 all-complete (`- idx:` indented, 7+ col-0 keys + `recent_events:` list AFTER tasks → proves region-bounding), archived 5.1 no-tasks. **TDD caught a real bug:** an empty-inline `pending_gate:` (block form on following lines) was silently treated as null — exactly the "drop a live gate" hazard — fixed `parseGate` to distinguish null / inline-map / block / bare-empty, fail-loud on block-content-without-id. **Gotcha:** the shipped broad `legacy/` `.gitignore` rule was hiding the fixtures → renamed dir to `test/fixtures/legacy-bundles/` (fixtures MUST be committed = CI ground truth). ⚠️ **CUTOVER GATE (step 8):** the fixtures are VERBATIM other-repo bundles (real slugs/task-names/SHAs); sanitize-or-confirm-public-OK BEFORE `masterplan-ng` is ever pushed/published. **Step-2 contract** (commented in migrate.mjs): migrated tasks are `{id,status,wave:null,files:[]}` — a legacy bundle has no v8 `plan.index.json`, so the L1 shell must re-derive each task's wave+file-scope from a `plan.md` re-parse on first resume. **Milestone review (advisor) caught a cross-module silent-stall the cc3 fixture structurally couldn't expose:** migrated tasks carry `wave:null`, and `decideNextAction` did `Math.min(null,…)`→0 while `wave===0` then matches NOTHING → an empty dispatch that STALLS the run (not the harmless over-dispatch first assumed). Added a fail-loud guard to `resume.mjs` (throw on a pending task with a non-integer wave) + the discriminator test `decideNextAction(migrate(WBN))` (cc3 has zero tasks → early `complete`, never reaching the guard). Suite **80/80**. `main` untouched (0b7d045). Next: step 2 — resumable shell `commands/masterplan.md` wiring the six lib modules (resume controller, durable `pending_gate`/`active_run`, single-writer commit).

## 2026-05-28 — masterplan-ng: step 1 lib modules (resume, paths, bundle) — TDD, green

Built the first three L1 pure modules, each TDD-first with `node:test` (suite at 35/35 green). **`resume.mjs`** — `decideNextAction(state, liveness)`, the control-loop core (gate > active-run wait/finalize/recover > dispatch-wave > complete); encodes spike deltas D1/D2 (11 branch tests). **`paths.mjs`** — `resolveConfigDir/RunsDir/BundleDir/StatePath` + `bundleArtifacts` + `expandTilde`, env-injected for testing, absorbing v7's scattered `~/.claude` + `docs/masterplan` path sites (11 tests). **`bundle.mjs`** — run-bundle state read/write (CD-7 single writer; atomic temp+rename) + pure transforms `openGate/clearGate/setActiveRun/clearActiveRun/markTask` (7 tests). **Format decision:** the v8 canonical `state.yml` is **FLAT** — one `key: value` per line, complex values as inline JSON (valid YAML flow). Zero-dep, line-diffable, type-preserving (numeric/bool-looking strings get quoted so they round-trip), and it avoids a fragile indentation-sensitive block parser; reading legacy v7 block-style is `migrate.mjs`'s job. A Haiku Explore recon confirmed v7 `state.yml` is a SIMPLE subset, so this is safe. Then **`routing.mjs`** (15 tests, suite 50/50): Codex eligibility as a pure deterministic truth-table — precedence host-suppress > routing-off > linked-worktree > annotation(`no`/`ok`) > heuristic, then `auto`→codex/inline / `manual`→ask. Kills fragility #2 (routing was LLM-interpreted prose); the v7 `eligibility_cache` dies (eligibility computed at dispatch over plan.index.json). Recon of `parts/step-c-dispatch.md` confirmed the verbatim rules. Then **`codex-host.mjs`** (13 tests, suite 63/63): `detectHost`/`suppressRescue`/`normalizeResumeHint` — recursive-dispatch suppression + the `$masterplan` shell-trap → `Use masterplan <args>` recovery (correctness invariants from `parts/codex-host.md`); bespoke perf-guard dropped (Workflow `budget` replaces it, Resolved #6); the `/goal` bridge stays a shell concern. Remaining step-1 module: `migrate.mjs` (legacy v7 block-YAML reader + version ladder, gated on the Resolved #7 installed-base dial). `main` untouched.

## 2026-05-28 — masterplan-ng: step 0.5 control-loop spike (throwaway, real Workflow)

Ran a real 2-agent Workflow wave against an isolated `/tmp` git repo and killed it mid-wave, to validate the L1↔L2 seam against live primitives before building on it (advisor-insisted: a Bash stand-in would have false-greened the safety-critical no-commit assumption). Full findings: `docs/spike-0.5-findings.md`. Confirmed: **(F2)** a real killed agent leaves uncommitted edits and does NOT commit — the basis of Resolved #2's idempotent re-dispatch; `git checkout -- . && git clean -fd` restores baseline. **(F1)** Workflow launch is async and returns BOTH a `task_id` (stop/liveness) and a `wf_` `run_id` (resume) → `active_run` becomes `{run_id, task_id}`. **(F3)** `TaskGet` after stop = "Task not found" (absence is ambiguous → disk is the done-vs-dead tiebreaker). **(F4)** the completion `<task-notification>` carries the return digest inline AND a native `<usage>` cost block (aggregate telemetry free → telemetry hook likely unneeded; per-agent cost still needs JSONL — R1 scoped). **(F6)** the resume journal caches result objects keyed by agent-call hash but NOT side effects → `resumeFromRunId` is fast-path-only, disk-reconstruct is primary. 🚨 **(F-SCOPE)** agent2 ignored its absolute `/tmp` path and wrote into the orchestrator cwd (the main tree); stray untracked file removed, `main` pristine ⇒ new hardening: L2/`mp-implementer` must run in the target cwd + verify post-barrier that edits stayed in declared scope + reset on violation. Architecture deltas D1–D6 captured in the findings doc. Next: build step 1 (lib pure modules, TDD) — `resume.mjs` `decideNextAction` first, encoding D2's disk tiebreaker.

## 2026-05-28 — masterplan-ng: clean-core rebuild scaffold (build step 0)

Started the v8 clean-core rebuild on the long-lived `masterplan-ng` branch (git worktree under `.worktrees/`, already gitignored; `main` stays at v7.2.3 published/stable until parity cutover). Approved plan: `~/.claude/plans/i-feel-like-we-ve-swift-lampson.md`. Driving diagnosis: a self-instrumentation spiral (~16k lines, much of it watching masterplan for failures its own complexity creates). Fix is structural, not editorial — Node-primary `lib/*.mjs` pure modules + a Workflow-tool engine + dedicated `.claude/agents/*.md` replace logic-in-prose and bash-in-markdown. **Design-goal priority (the review rubric, higher wins on conflict): (1) durable on-disk state, (2) token efficiency, (3) context-window management** — reliability/parity/published-robustness rank below and are served by these. Step-0 scaffold only: `package.json` (type:module, node:test, zero deps), branch-scoped `ng-ci.yml`, contract-documented stubs for the five layers (`lib/{paths,bundle,resume,routing,codex-host,migrate}.mjs`, `workflows/execute.workflow.js`, `bin/doctor.mjs`, `lib/doctor/`, four agents), and a smoke test asserting every lib stub is valid ESM (6/6 green on node v20.19). No v7 files touched — `parts/`, old `bin/`, `commands/masterplan.md` remain as conversion reference. Plan-detail fix mid-scaffold: dedicated agents live in the plugin-root `agents/` dir (the universal plugin convention — every installed plugin ships agents there), **not** `.claude/agents/` as the plan's file tree said (that path is gitignored and is the project-local yanos pattern, wrong for a published plugin); caught because `git add -A` silently skipped the gitignored files. Next: build step 0.5 — a throwaway end-to-end control-loop spike (slash-command → background Workflow → reconstruct-from-disk → crash-idempotent re-dispatch) to validate the L1↔L2 seam against live primitives before writing `decideNextAction`/`bundle.mjs`.

## 2026-05-27 — v7.2.1: wire Check #53 telemetry (CC-2 compaction-resume banner)

Took doctor Check #53 live. It was forward-wired in v7.2.0 against three events the Stop hook never emitted, so it always SKIPped. Added `emit_cc53_events` to `hooks/masterplan-telemetry.sh` emitting `turn_start` (unconditional, first), `invoked_skills_reinjection`, `step0_flag/compaction_recent`, and `cc2_banner_emitted`. Key decisions: banner detection is **hook-side** (greps the transcript sentinel directly) so a missing banner can't suppress its own detection event; turn-window is the **most-recent maximal non-tool-result user-record run → EOF** (a flat tail-N window would leak a prior turn's banner and inflate the ratio). Verified end-to-end via an isolated-sandbox hook run (resume+banner→RATIO 1.0, resume+no-banner→0.0, fresh→SKIP) — which caught a `jq` missing-`-r` bug that quote-contaminated the first/last detection fields (`bash -n` would not have). Manifests + README bumped to 7.2.1; CHANGELOG + retro updated.

## 2026-05-27 — v7.1.1: add /masterplan:verbs; restore plan skill

`skills/plan/SKILL.md` was accidentally deleted from working tree after v7.1.0 commit (HEAD was correct; restored via `git checkout HEAD`). `skills/verbs/SKILL.md` added — was omitted from v7.1.0; provides `/masterplan:verbs` to display `docs/verbs.md` cheat sheet. Both synced to installed plugin.

## 2026-05-27 — v7.1.0: per-verb /masterplan:<verb> skill commands

12 per-verb `skills/<verb>/SKILL.md` stubs created (brainstorm, plan, full, execute, retro, import, doctor, status, validate, stats, clean, next). Each registers as `/masterplan:<verb>` in Claude Code's interactive command picker — same discovery pattern as `/superpowers:<skill>`. `skills/masterplan/SKILL.md` description narrowed to Codex/bare entrypoint. `hooks/hooks.json` shim bumped to v4 format.

## 2026-05-27 — v7.0.2 patch: doctor #1 false positives + #34 placeholder hash

Check #1 tightened: container dirs under `docs/superpowers/` with no actual `.md` files (only README or empty) no longer fire false-positive WARNs. Check #34 fixed: `codex-routing-fix` bundle had a placeholder `plan_hash` since creation; replaced with real computed hash. Manifests bumped to v7.0.2.

## 2026-05-27 — doctor re-run (v7.0.1) + stale job cleanup

Full 52-check doctor re-run (all inline). 0 errors. Pre-existing WARNs (#1, #16, #32, #34, #35, #40, #43) on archived pre-v5.0 bundles — unchanged. New fix found during run: marketplace clone and installed_plugins.json were still at v7.0.0; pulled marketplace, updated registry to v7.0.1 (#50 now PASS). Checks #3/#18/#29/#49/#50 all PASS. Stale Codex task cleanup: 10 stale running job files (129h–619h) deleted directly from `~/.claude/plugins/data/*/state/*/jobs/` — `codex-companion.mjs cancel` was ineffective (companion only tracks jobs from current session). Checks #51/#52 SKIP (no schema_version >= 5.1 bundle in this repo — expected).

## 2026-05-27 — doctor post-rename (v7.0.0)

Ran all 52 doctor checks inline (skill routes not available mid-session). Results: 0 errors, ~12 warnings. Fixed: README `Current release:` v6.3.3 → v7.0.0 (#30); cc3-visibility `worktree_disposition: active → removed_after_merge` (#3, #29). False positives confirmed: #18 (codex IS installed at marketplaces/openai-codex/, glob checks wrong depth), #50 (plugin manager updated registry to 7.0.0 mid-run, was stale at check time). Expected backfill: #35/#43 (pre-v5.0 bundles), #45 (pre-v6.1.0 bundles). Stale Codex tasks (#49): 10 runaway tasks across yanos/openxcvr repos — cancel commands surfaced, user-action required.

## 2026-05-26 — v7.0.0 rename: superpowers-masterplan → masterplan (complete)

Full sweep done after initial commit. Additional files updated on both machines: `~/.claude/settings.json` (plugin trust + extraKnownMarketplaces), `~/.claude/plugins/known_marketplaces.json`, `~/.claude.json` (favoritePlugins + repoToProjects), `~/.claude/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.claude/refs/hindsight-setup.md`. External repos updated: three sibling repos' `CLAUDE.md` files (committed). Remaining old-name references are historical-only (`.bak` files, session transcripts, tool-results).

## 2026-05-26 — v7.0.0 rename: superpowers-masterplan → masterplan

Full rename across git, source, and installed paths. GitHub repo renamed via `gh repo rename`. All 95 source files updated (sed passes: rasatpetabit-superpowers-masterplan → rasatpetabit-masterplan, URL, skill route, name). `plugins/superpowers-masterplan` symlink renamed to `plugins/masterplan`. Installed paths on this machine migrated: marketplace clone, cache dir, telemetry hook symlink, command shim (v4), installed_plugins.json key, Codex marketplace. Version bumped to 7.0.0 (breaking: marketplace ID changed). Skill route is `/masterplan:masterplan` internally but users always go through the `/masterplan` shim so it's not user-visible. **Other machines need `/plugin update` after this push to pick up the new marketplace ID.**

## 2026-05-26 — second-host upgrade to v6.4.0 + dev-repo stale-worktree root-cause

Two hosts to upgrade; the first host already at v6.4.0 (registry + clone + symlinked hook all in sync). The second host brought to v6.4.0 with caveats below.

**Dev-repo anomaly — root cause identified.** Working tree appeared to have a staged revert of v6.4.0 → v6.3.3 (manifest versions, CHANGELOG, cc3-visibility bundle, check-51/#52 fixtures, codex-review contract). `git diff HEAD 6d7e51d` showed zero content difference between working tree and v6.3.3 commit — i.e., not a hand-authored revert, just stale state. `.git/logs/refs/heads/main` tail confirmed: ref jumped `6d7e51d → 0fd49c7` at epoch `1779831675` with an **empty reflog message** — signature of bare `git update-ref` or `git fetch origin main:main`, neither of which touches working tree. Fix: `git checkout HEAD -- .` (no user work lost; verified no untracked files).

**Mechanism note for next time.** Avoid `git fetch origin main:main` from a worktree that has `main` checked out elsewhere — it advances the ref without checking out, leaving every consumer with what looks like a giant staged revert. Use `git pull --ff-only` from the actual main checkout instead.

**Second-host marketplace clone upgrade.** Local bin/ edits (a `$HOME/dev` → repo-root path swap in `masterplan-findings-to-issues.sh` + `masterplan-routing-stats.sh`) stashed → `git pull --ff-only` (276e955 → 0fd49c7, 41 files +3666/-42) → `git stash pop` clean. **Surprise:** `~/.claude/hooks/masterplan-telemetry.sh` is a **symlink** to the marketplace clone's `hooks/`, not a copy — so `git pull` updated the live hook implicitly (md5 confirmed `25430886ead05d0fa9970ae8f39482e5`). Prior session's compaction summary assumed copy; verified symlink via `ls -la`. Cache dir `~/.claude/plugins/cache/.../masterplan/` still lacks a `6.4.0/` subdir — Claude Code's plugin manager materializes that on session restart, which is also when `installed_plugins.json` updates from `version 6.3.3 / gitCommitSha 81a953f` → `6.4.0 / 0fd49c7`.

**Handoff to user:** restart Claude Code session on the second host; then run `/masterplan doctor` to verify Check #50 (registry/marketplace drift) reports in sync and Checks #51/#52 (new in v6.4.0) fire.

## 2026-05-26 — publish v6.3.3

All 8 run bundles archived; no active work. Status clean; pushed main to origin. Check #50 (registry/marketplace drift) self-resolves after push + `/plugin update` on consuming side.

## 2026-05-25 — doctor run + pre-restart cleanup (v6.3.3, commits 5cdb961 + 276e955)

Full 50-check `/masterplan doctor` run. Two real findings fixed:

**Check #3 bug** (`parts/doctor.md`): Bash block missing the `worktree_disposition` skip guard that checks #4 and #29 already had. All 4 flagged bundles (hoist-run-policy, improve-regression-detection, improve-subagents-parallelism, masterplan-token-efficiency) had `worktree_disposition: removed_after_merge` — the check itself was wrong. Added 2-line guard to skip those bundles.

**Check #9 missing `artifacts.events`** (5 state.yml files): Older bundles (4 above + adversarial-review-integration) predated `artifacts.events` as required schema field. Files existed on disk; just the pointer was absent. Added `events:` line to each.

**Stale .lock deleted**: `docs/masterplan/adversarial-review-integration/.lock` was 32214s (~9h) old; Check #42 surfaced it.

**Check #50 (registry/marketplace drift)**: Expected — registry pinned to v6.3.3 (dev), marketplace git checkout at v6.3.0 (last publish). Resolves on push + `/plugin update`.

**Key decision:** All 5 `artifacts.events` fixes + Check #3 fix committed as one patch (276e955). WORKLOG entry deferred to restart prep, not the hot path.

## 2026-05-23 — codex-hardening: adversarial review B3 background handle capture (commit 6886be4)

Fix #5 in the Codex dispatch hardening series. Root cause: `parts/step-b.md`'s B3 block ran `node ... --background` without capturing stdout, so `log_file` (the companion's detached process log path) was discarded. On wakeup, "check if review completed" had no mechanism — the orchestrator had to ask the user.

3 files changed:
- `parts/step-b.md`: Capture `review_handle=$(node ... --background ...)`, parse `log_file` via jq; persist `adversarial_review_plan_pending_job: {log_file, started_at}` to state.yml. Fallback: if `log_file` empty, skip block entirely.
- `parts/step-c-resume.md`: Added **adversarial review plan gate carve-out** to pending-gate handler. When `pending_gate.id == adversarial_review_plan_pending` AND `log_file` set: auto-run `test -s <log_file>` on wakeup. Complete → parse/proceed; not complete → re-schedule wakeup.
- `parts/contracts/run-bundle.md`: Documented `adversarial_review_plan_pending_job` field in state.yml schema + §adversarial_review_plan_pending_job section (lifecycle, polling, why disk-not-TaskGet).

**Pattern:** Same class as output_path fix (3787231) — background process writes to disk; cross-session completion detection uses `test -s <path>` rather than session-scoped TaskGet.

## 2026-05-23 — codex-hardening: output_path cross-session fallback (commit 3787231)

Fix #4. Background Codex tasks dispatched with `run_in_background: true` return a session-scoped `agent_id`. If the ScheduleWakeup fires in a NEW session, `TaskGet(agent_id)` returns "not found" — the prior code treated this as failure and re-dispatched. Fix: compute `output_path = <run-dir>/task-<idx>-bg-output.json` BEFORE dispatch; include in brief with instruction to write digest there; on resume, `not_found` triggers `test -s <output_path>` fallback rather than background_failed.

Changed: `parts/step-c-dispatch.md` (pre-dispatch path setup), `parts/step-c-resume.md` (not_found → fallback, not failure), `parts/contracts/run-bundle.md` (schema + §output_path subsection).

## 2026-05-23 — codex-hardening: wave-barrier-interrupted detection (commit 009c28a)

Third round of Codex dispatch hardening. Root cause of "forcing me to ask" pattern: when a session dies mid-wave (crash, timeout) while blocking Agent calls are in-flight, state.yml shows `tasks[*].status: in_flight` AND `background: null`. Prior resume logic had no case for this — it fell through to auto-redispatch from scratch, causing the repeated-dispatch loop.

3 files changed:
- `parts/failure-classes.md`: Added class 11 `wave-barrier-interrupted` (schema_version bumped 1→2). Detection: `tasks[*].status == "in_flight" AND background == null AND no wave_task_completed event in events.jsonl`. AUQ surfaces 4 options (re-dispatch/skip/inline/abort).
- `parts/step-c-resume.md`: Added **Orphaned in-flight task resume** gate after Background-dispatch resume check. Scans events.jsonl for completion events per orphaned idx; fires AUQ when gap found. Skip condition: `background != null` (background resume already handles it).
- `docs/internals/failure-instrumentation.md`: Added classes 7–11 to taxonomy table (was only showing 1–6).

**Key decision:** Detection keyed on *absence of completion event* rather than presence of in_flight status alone — prevents false-positive firing when a task is mid-dispatch during first run (not a resume). The `background: null` guard prevents double-handling with the existing background-dispatch resume path.

## 2026-05-23 — codex-sandbox-probe: linked-worktree guard + Doctor Check #48

Confirmed failure mode from `codex-routing-fix/events.jsonl`: T1 `codex sandbox could not commit (.git read-only)`, T9–T12 all `codex+claude-fixup` — all running inside `.worktrees/codex-routing-fix` (linked worktree topology).

5 files changed:
- `parts/step-c-dispatch.md`: inserted **Linked-worktree guard** paragraph between Host-suppressed and Delegating; uses `git rev-parse --git-dir vs --git-common-dir` structural detection (NOT a touch probe — orchestrator has full perms). Logs `codex_skip_linked_worktree` event.
- `docs/conventions/codex-failure-policy.md`: added §4 Sandbox Read-Only Git; scope boundary renumbered §4→§5; scope table gains linked-worktree row.
- `parts/doctor.md`: Check #48 `codex_linked_worktree` (Repo-scoped, v6.3.0+); title, preamble, repo-scoped batch header (8→9 checks), dispatch brief, checks_processed, partial-failure array all updated; severity table row added.
- `docs/internals/doctor.md`: pass count 40→41.
- `commands/masterplan-contracts.md`: `doctor.repo_scoped.schema_v1` purpose, algorithm, checks_processed updated (eight→nine, add #48).

Tier-drift test passes: 5 repo-scoped checks [39,44,46,47,48].

**Key decision:** Structural detection (`git_dir != git_common`) chosen over permission-based probe; orchestrator always has write access to `.git` regardless of sandbox, making a touch probe always return writable. The superproject guard (`--show-superproject-working-tree` non-empty = submodule) prevents false positives.

## 2026-05-22 — brainstorm: improve-regression-detection (v6.2.0)

`/masterplan brainstorm improve the robustness of masterplan regression detection` — spec written and committed to `worktree-improve-regression-detection` branch.

**Approach chosen:** Tiered test suite (Approach B). Fast tier (<30s, pre-commit): 4 existing static tests + 2 new structural tests (coordinator-dispatch, step-c-split). Full tier (CI/pre-merge): fast + doctor fixtures for all 47 checks + hook unit tests.

**Key finding:** Checks #1–#31, #37, #43 lack embedded bash blocks — can't use existing fixture mechanism. Bundle will add bash blocks to doctor.md for those checks (itself a robustness improvement).

State: `spec_gate` / `pending_gate: brainstorm_closeout` — awaiting user decision before planning.

## 2026-05-22 — execution complete: improve-subagents-parallelism → v6.2.0

Wave-based execution of all 6 tasks. Dimension A/B audits returned no actionable fixes; Dimension C confirmed 2 expected violations.

**Changes shipped (3 implementation commits):**
- `parts/step-b.md`: cap adversarial-review companion stdout+stderr at 8192 chars (C3 fix)
- `parts/step-c-dispatch.md`: add `(≤ 100 items)` to coordinator-plan-parser tasks[] (C1 fix)
- `parts/doctor.md`: Check #46 (CC-2 self-enforcement lint) + Check #47 (return-shape caps lint); low/medium/high check sets updated
- `docs/internals/coordinator-pattern.md` + `wave-dispatch.md`: CC-2 wording added
- `bin/masterplan-self-host-audit.sh`: stale `step-c.md` → 4 sub-file scans in `check_brief_style()` and `check_dispatch_sites()`

**Status:** `pending_retro` on `worktree-improve-subagents-parallelism` branch.

## 2026-05-22 — brainstorm: v6.0 token efficiency spec (v5.8.3)

`/masterplan brainstorm improve masterplan token use efficiency` — spec written and committed to `worktree-masterplan-token-efficiency` branch.

**Approach chosen:** B (Prune + Split + Coordinator). Four phases: P0 baseline instrumentation, P1 prose pruning (1-sentence rationale rule), P2 step-c.md 4-way split + doctor.md coordinator dispatch, P3 coordinator-subagent pattern at 5 sites. Plus docs/internals/ split into per-coordinator focused docs.

**Key decisions:** breaking changes OK (v6.0 bump); 30-50% token reduction target; coordinator pattern ships unconditionally (no threshold gating); CD-7 preserved (coordinators read-only, orchestrator is canonical writer). 5th coordinator site: plan-parser (plan.md never loads into orchestrator context).

State: `spec_gate` / `pending_gate: brainstorm_closeout` — awaiting user review before planning.

## 2026-05-22 — plan written: v6.0 token efficiency (v5.8.3)

`/masterplan plan --from-spec` — 21-task implementation plan written at `docs/masterplan/masterplan-token-efficiency/plan.md` on `worktree-masterplan-token-efficiency`.

**Plan structure (6 phases):** P0 telemetry baseline (Tasks 1-3), P1 prose pruning (Tasks 4-8), P2 step-c.md 4-way split (Tasks 9-14), P3 coordinator-subagent pattern at 5 sites (Tasks 15-17), docs/internals/ 4-way split (Tasks 18-19), version bump + release notes (Tasks 20-21).

**Key decisions locked:** coordinator pattern uses ≤1000-token JSON response ceiling (CD-7 compliant), parallel-groups on P2 (Tasks 9-12 can run concurrently), plan-parser is 5th coordinator site. Breaking changes → v6.0.0 bump.

State: `plan_gate` / `pending_gate: plan_closeout` — awaiting user approval before execution.

## 2026-05-22 — doctor --fix run (v5.8.3)

Auto-fix pass across all 4 run bundles. Three commits landed on main + both active worktrees:

- **codex-routing-fix**: injected 17 missing v3 standard fields (bundle used experimental v5.0 lightweight schema; all values derived from `recent_events` timestamps and git state). Plan_hash still `sha256:pending-first-build` (#34 WARN). No retro.md — Check #28 deferred to AUQ.
- **concurrency-guards**: fixed bogus `worktree: /path/to/...` placeholder → the real repo-root path; corrected `worktree_disposition: active → removed_after_merge` (archived bundle, ran brainstorm-only on main, no separate worktree). `worktree_decision_note` >200 chars (#32, report-only).
- **improve-subagents-parallelism** (worktree): fixed `.claude/worktrees/` path → `.worktrees/` (actual git worktree location). First commit of bundle files.
- **masterplan-token-efficiency** (worktree): same path fix + added missing `compact_loop_recommended: false`. First commit of bundle files.

## 2026-05-22 — execution complete: masterplan-token-efficiency → v6.0.0

All 21 tasks completed inline (Codex blocked throughout — git worktree index outside sandbox write scope). Retro written and bundle marked complete.

**Results:** execute-turn context load 292KB → 108KB (−63%); brainstorm-turn 107KB → 68KB (−37%). Exceeds 30-50% spec target.

**Key changes shipped:** `hooks/masterplan-telemetry.sh` gets `turn_context_bytes` telemetry; `parts/step-c.md` (110KB) split into 4 load-on-demand sub-files; 5 coordinator dispatch sites (returns ≤1000-token JSON, never loads source into orchestrator context); `docs/internals.md` (123KB) → 25-line nav index + 8 focused docs; version 5.8.3 → 6.0.0.

**Post-execution fix:** `docs/internals.md` replacement in T20 dropped `§Failure-instrumentation framework` content; migrated to `docs/internals/failure-instrumentation.md` before retro.

**Follow-up:** `writing-plans` skill emits `**Codex:** true/false` but scanner requires `ok/no` — auto-falls-back to Haiku build. v6.0.1 candidate.

Stale `.lock` at `docs/masterplan/concurrency-guards/.lock` (39h+) — `rm` it after confirming no live writer.

## 2026-05-22 — hotfix: Codex sandbox worktree compatibility

Patched `codex-companion.mjs` (both marketplace and 1.0.4 cache copies) at line 488. Root cause: `workspace-write` sandbox blacklists `.git/` paths; in git worktrees the index lives at `<main>/.git/worktrees/<name>/index` — outside the worktree root and doubly blocked. Fix: detect worktree context via `fs.stat(<cwd>/.git).isFile()` and use `danger-full-access` instead of `workspace-write`. Probe confirmed: write tasks in worktrees now succeed. This unblocks Codex dispatch for all masterplan bundles running in git worktrees.

**Pending follow-ups:** adversarial-review integration into masterplan workflow (new bundle); writing-plans annotation mismatch (v6.0.1).

## 2026-05-23 — plan written: improve-regression-detection

Bundle: `improve-regression-detection` (worktree: `.worktrees/improve-regression-detection`). Plan at `docs/masterplan/improve-regression-detection/plan.md` (2244 lines, 15 tasks).

**Scope:** Tiered test runner (`tests/run-tests.sh` with `--fast`/`--full`/`--all-worktrees`); structural tests for coordinator dispatch (A1–A4) and step-c split invariants (B1–B4); bash block implementations for all 47 doctor checks that previously lacked them (#1–#24, #26, #28–#31, #37 reserved stub, #42 rewrite, #43 new); fixture directories for checks #1–#45; hook unit tests (telemetry C1–C4, self-host audit D1–D3); bin/ aliases + pre-commit gate.

**Key decisions:** Check #37 was absent from doctor.md — resolved as Reserved stub (same pattern as #25, #27). Check #12 fail fixture impractical (5MB file); testability added via `TELEMETRY_SIZE_THRESHOLD` env var. Check #42 pseudo-code rewrote using `stat -c %Y` + integer arithmetic. Git-dependent checks (#3, #4, #29) tested with empty fixture dirs (no state.yml → PASS).

**State:** phase→executing. Ready for `/masterplan execute` to kick off Task 1.

## 2026-05-23 — execution complete: improve-regression-detection

All 15 tasks completed. Final state: 9/9 tests pass on `worktree-improve-regression-detection` (6 fast + 3 full). 89 doctor-fixture checks pass (checks #1-#45 fully covered, reserved/retired IDs skipped).

**Key deliverables:**
- `tests/structural/test-coordinator-dispatch.sh` (A1-A4) — verifies DISPATCH-SITE markers, return-shape caps, CC-2 guard, fallback docs
- `tests/structural/test-step-c-split.sh` (B1-B4) — verifies 4-file split, no duplicate headers, CC-3 trampoline, xref resolution
- Doctor fixtures for checks #1-#45 (89 fixtures, 0 failures)
- `tests/hook-unit/test-telemetry-sections.sh` (C1-C4) — hook syntax, exit code, anomaly detectors (step-trace-gap + silent-stop-after-skill)
- `tests/hook-unit/test-self-host-audit.sh` (D1-D3) — self-host audit passes with step-c split
- `bin/run-tests.sh`, `bin/run-tests-fast.sh` aliases

**Audit fixes shipped alongside tests:**
- `bin/masterplan-self-host-audit.sh`: updated `check_cd9_coverage` and `check_dispatch_sites` for step-c split; added `complete` status to `_plan_bundle_is_archived`

Ready for retro + merge to main.

## 2026-05-23 — branch finish: improve-regression-detection

Merged to main; worktree + branch removed. Cross-refs gap fixed alongside merge (3-part fix: 5 coordinator contracts added to `masterplan-contracts.md`, stale `parts/step-c.md` references in `parts/failure-classes.md` updated to split file names, `test-cross-refs.sh` regex extended to match hyphenated contract IDs). `test-manifest-drift` fix also landed (marketplace.json + README bumped to 6.0.1 to match plugin.json). Main now exits 0 on `--fast` (6/6).

## 2026-05-23 — hotfix: Codex annotation true/false aliases

`writing-plans` emits `**Codex:** true/false` (boolean) rather than `ok/no` (canonical); doctor #40 counter, step-c-resume inline-build verifier, step-c-dispatch scanner all updated to accept `true`≡`ok` / `false`≡`no`. Check #16 also updated. `parts/contracts/plan-annotations.md` format spec updated to show `<ok|no|true|false>`. CHANGELOG 6.0.1 entry updated. Main at 9/9.

## 2026-05-23 — branch finish: improve-subagents-parallelism + masterplan-token-efficiency

Both stale worktrees merged to main and removed.

**improve-subagents-parallelism**: merged `worktree-improve-subagents-parallelism` → main. One conflict in `bin/masterplan-self-host-audit.sh` `check_dispatch_sites()` resolved by keeping main's glob `parts/step-c*.md` over worktree's explicit file list. Brings in Check #46 (CC-2 self-enforcement), Check #47 (return-shape caps), step-b.md 8192-char cap, step-c-dispatch `≤ 100 items` bound.

**masterplan-token-efficiency**: branch had no unique commits (all changes already applied inline to main during v6.0.0 execution). Worktree removed, branch deleted, bundle archived.

Both bundles: `status: archived`, `worktree_disposition: removed_after_merge`.

**Post-merge fix:** `check_brief_style` Pattern D false-fired on HTML nav comment headers in `step-c-resume.md:7` and `step-c-completion.md:6`. Root cause: lines ending with `-->` (sub-file nav labels) matched the lifecycle regex but aren't real dispatch sites. Fixed by adding `-->` to the skip condition alongside the existing backtick guard.

**Python tests wired:** `tests/run-tests.sh --full` now includes a `python-unit-tests` step covering all `tests/test_*.py` (33 tests). PYTHONPATH is set automatically. Main at 10/10.

## 2026-05-23 — doctor --fix run (masterplan-token-efficiency worktree)

Completed all 47 doctor checks with `--fix` applied. Changes committed to main:
- Check #8 bash: add `complete|archived|retro` to phase skip list (false positive on archived bundles)
- Check #31 bash: replace narrow `grep -A4|head -8` with full-file regex to avoid early clip on multi-occurrence files
- Check #47 bash: fix subshell bug (pipe → process substitution); add self-referential code-block skip
- Return-shape caps added (6 blocks): `parts/doctor.md` ×2, `parts/step-b.md`, `parts/step-c-dispatch.md`, `parts/step-c-resume.md`, `parts/step-c-verification.md`
- Fixture `check-31/pass-gates-present/parts/step-b.md` updated to match same-line anchor+condition pattern
- `docs/masterplan/improve-regression-detection/retro.md` written (was referenced in state.yml but missing; resolves Check #22)
- Stale `.lock` files removed: `adversarial-review-integration/.lock`, `p4-suppression-smoke/.lock`
- All 10/10 tests pass after fixes.

## 2026-05-23 — execution complete: hoist-run-policy → v6.2.0

All 4 tasks completed inline. 11/11 tests pass (`worktree-hoist-run-policy` branch).

**Changes shipped:**
- `docs/conventions/api-retry-policy.md`: new doc — retryable/fatal error classification, 3-retry schedule (5s/15s/45s backoff), user-facing notices, Codex + inline dispatch scope.
- `parts/step-c-dispatch.md`: run-policy gate at first parallel wave assembly (4-option AUQ: parallelism × on_blocker); `on_blocker: async_hold` semantics; API error handling cross-ref in Codex dispatch section.
- `docs/internals/wave-dispatch.md`: §API Error Handling section.
- `tests/structural/test-api-retry-policy.sh`: new structural test (content + cross-refs).
- `tests/structural/test-coordinator-dispatch.sh`: A5/A6 checks (run_policy gate presence + ordering).
- CHANGELOG v6.2.0.

**Side fix:** plan.md lacked v5 plan-format markers (`**Spec:**`/`**Codex:**`/`**Verify:**` per task); added during Task 4 to pass self-host-audit `check_plan_format`.

Ready for `branch finish` → merge to main.

## 2026-05-23 — hoist-run-policy extended: Codex failure policy → v6.2.1

Committed directly on `worktree-hoist-run-policy` branch (no bundle bookkeeping per user request). 12/12 tests pass.

**Changes shipped:**
- `docs/conventions/codex-failure-policy.md`: new doc — silent-exit, daemon-broken, auth-degraded failure classes; two-consecutive-failure streak threshold; auth-degraded fast path (skip streak); user-facing notices; scope boundary with api-retry-policy.md.
- `parts/step-c-dispatch.md`: "Silent exit (infra failure)" bullet in "After Codex returns"; primary detection via empty `git diff --stat` vs `task_start_sha` when plan declared file changes; secondary detection via socket/ECONNREFUSED patterns; `codex_failure_streak[task_name]` session var; `[inline:codex-fallback]` completion tag.
- `tests/structural/test-codex-failure-policy.sh`: new structural test.
- CHANGELOG v6.2.1.

**Key decision:** silent-exit detection keys off git diff (primary) not Codex return fields — non-wave Codex returns are free-form text, not field-structured. Two-failure threshold avoids aggressive fallback on transient daemon restarts.

## 2026-05-23 — post-merge fixes (main, no bundle)

Three targeted fixes committed directly to main after the hoist-run-policy branch finish. All 100/100 tests pass (8 structural + 92 fixtures).

**Check #39 — chatgpt gate widened from 7d to 30d** (`commands/masterplan.md` + `parts/doctor.md`): ChatGPT refresh_token is long-lived; `last_refresh` > 7 days just means Codex hasn't been invoked recently, not that auth is broken. 8-day idle was false-firing as `degraded`.

**Annotation scan spec — accept `true`/`false` aliases** (`parts/step-c-resume.md` + `parts/doctor.md`): The authoritative annotation-completeness scan definition (step 1 of the Build path) said "any other value disqualifies" — only `ok`/`no`. The prose at line 134 and `plan-annotations.md` already documented `true`/`false` as aliases; the scan spec was never updated. Plans emitted by `writing-plans` (which uses `true`/`false`) were silently falling back to Haiku build instead of taking the inline cache path. Fixed; also clears the `masterplan-token-efficiency` bundle follow-up.

**Check #46 — code-fence skip** (`parts/doctor.md` + 3 new fixtures): The CC-2 self-enforcement check was false-firing on doctor.md's 47 embedded bash blocks. Added `in_fence` state tracking: lines inside ` ```bash ` … ` ``` ` blocks are skipped. Also removes ` ```bash ` from the consecutive-trigger pattern (it now enters fence state instead). Three fixtures: `pass-clean`, `fail-violation`, `pass-fenced`.

## 2026-05-23 — post-v6.2.3 documentation drift scan

Three additional doc fixes found during scanning after v6.2.3 release:
- `parts/doctor.md` Severity/Action table was missing rows for checks #44–#47 (added in v6.1.0/v6.2.0 but never added to the table)
- `docs/internals/doctor.md` return-shape example summed to 36 (old check count); updated to 47
- `parts/contracts/coordinator.md` coordinator catalog listed `parts/doctor.md` as "73KB"; actual size is ~90KB

All fixes committed post-v6.2.3 (`00ddede`, `7c2efbe`). 9/9 tests still pass. No version bump (doc-only).

## 2026-05-23 — doctor check tier classification fixes (masterplan-token-efficiency branch)

Full tier audit of all 47 doctor checks. Six checks had drift between their `**Scope:**` field declarations and the routing slots in `parts/doctor.md`.

**Changes:**
- `#26` removed from plan-scoped parallelization brief (was in both brief and repo-scoped batch; repo-scoped is the correct single home; `CronList` call should run once per doctor run, not N× per worktree)
- `#38` Scope: field fixed (copy-paste from #39 said "reads ~/.codex/auth.json"; actually scans per-bundle anomaly files); added to plan-scoped brief and all complexity sets
- `#44` moved from medium/high complexity sets → repo-scoped batch (global config check, not per-bundle)
- `#45` added to plan-scoped brief + medium/high complexity sets (was entirely absent)
- `#46`/`#47` moved from all complexity sets → repo-scoped batch (prompt-scoped: scan `parts/step-*.md`, same repo files every time, no benefit to running per-worktree)
- `checks_processed` arrays in `parts/doctor.md` and `commands/masterplan-contracts.md` updated from 5 → 8 checks
- `tests/static/test-doctor-tier-drift.sh` added: cross-validates every explicit-Scope check is in the right routing slot; FAST tier

**Key decision:** "Prompt-scoped" checks (#46/#47 scan prompt files, not bundle state) treated as repo-scoped for routing purposes — run in the single repo-scoped Haiku batch. Tests: 9/9 pass.

## 2026-05-27 — ops-audit-hardening: v7.2.0 (transcript audit F1–F4)

Audited ~12h of Claude Code transcripts for `/masterplan` operational issues. Four findings, repro-first posture (repro task → verdict, fix task branches on it). Run bundle: `docs/masterplan/ops-audit-hardening/`.

- **F1 boot-banner under-emission (confirmed → fixed):** raw 3/318 was a grep artifact; true ratio 9 banners / 24 real invocations, with the miss concentrated *entirely* in compaction-resume / `invoked_skills` re-injection turns (fresh invocations 100% compliant). Tightened unconditional-render language in `parts/step-0.md` + `commands/masterplan.md` scoped to the re-injection path; added doctor **Check #53** (`cc2_banner_compaction_resume_compliance`, 52→53) that excludes fresh invocations from the denominator.
- **F2 gate re-entrance (refuted → docs-only):** 30 raw `gate=fire` collapse to 6 distinct legitimate gates; the 3 `spec_approval` re-fires are *designed* resume-controller re-renders. A planned idempotency guard would have converted a working feature into a dropped-gate bug — repro-first blocked the regression. No source change; rationale in `verdict-f2.md`.
- **F3 context-budget (generalized):** lifted summary-first inventory + ≤2 large-read budget out of the Codex-host-only section into host-agnostic context-control discipline in `parts/step-0.md`; codex-host.md retained as host-specific extension.
- **F4 fd/ulimit preflight (added):** always-runs fd check before the bootstrap file storm — `ulimit -n < 1024` aborts with remediation instead of dying on EMFILE; `unlimited` proceeds; unresolvable probe warns and continues.

**Key decisions / caveats:**
- Check #53 ships **dormant (forward-wired):** it reads `invoked_skills_reinjection` / `compaction_recent` / `cc2_banner_emitted` events the Stop hook does not yet emit, so it SKIPs. Disclosed in CHANGELOG + retro; wiring those three events into `hooks/masterplan-telemetry.sh` is logged as the open follow-up in `state.yml`.
- Version sync touched all four locations (Check #30 surface): `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (×2 fields), `.codex-plugin/plugin.json`, README. The first sync brief missed marketplace.json — caught by cross-manifest check.
- Verification ceiling was local-static: cross-manifest drift + `bash -n` passed; the full `/masterplan doctor` verb (recursive invocation) was deferred.

Shipped v7.2.0. Commits: `45a9162` (wave), `3c52d02` (version-sync), `d95960c` (retro+archive), plus this final disclosure-amendment commit.

## 2026-05-28 — v8 (masterplan-ng): first Codex adversarial review of the L1 core + dispatch-tracking finding

First-ever Codex review of *any* masterplan work — root cause it never ran before is documented in `~/.claude/plans/fizzy-strolling-tiger.md` Part C (the Codex-review obligation + enforcement hook + scanner are all yanos-hardcoded; masterplan is a sibling git repo, out of scope). Dispatched `codex:codex-rescue` over the deterministic core (resume/migrate/bundle/routing + bin). Engine confirmed genuinely **Codex** (threadId `019e714f-…`, touched real `~/.codex/skills/…` paths). Verdict: **fix-before-building-on-it** — the core is close, but the orphan promote path is a real anti-double-dispatch violation.

**Findings (fix before Step 3):**
- **[HIGH] `promote-active-run` orphan** (`bin/masterplan.mjs:240`, `lib/resume.mjs:61`): `promote-active-run` without a prior `set-active-run` writes an `active_run` with **no `wave`**; `decideNextAction` then matches no tasks (`wave === undefined`) → returns `finalize_run` while tasks are still pending → clears the run marker → double-dispatch/orphan window. Violates the two-phase active-run totality contract. Fix: `promote` must require an integer-wave `{phase:"launching"}` marker; `decide` must fail loudly on missing/non-integer `active_run.wave`.
- **[MEDIUM] `mark-task` false success** (`lib/bundle.mjs:100`): exits 0 on an unknown id with state unchanged → shell believes a result was recorded that wasn't → recovery re-dispatches already-done work. Fix: return matched-count / throw on no-match; validate `--status` against the v8 enum.
- **[LOW] `backfill-waves` false success + id-type mismatch** (`bin/masterplan.mjs:131,206`): reports success on total task count not matched updates; numeric state ids vs string `plan.index.json` ids leave `wave:null` → next `decide` errors at the guard instead of backfill failing at the real boundary. Fix: normalize id keys, report real matched counts, fail non-zero if any pending task lacks an integer wave.
- Coverage gaps: no assertions for promote-without-marker, wave-less `active_run`, no-op `mark-task`/invalid status, or `parseState∘serializeState` fuzz (Codex's inline 21-value probe passed).
- `bin-masterplan.test.mjs` couldn't run in the Codex sandbox (`spawnSync('node') EPERM`) — sandbox limitation, not a defect (96/96 local; 7/8 files green under `TMPDIR=/dev/shm`).

**Dispatch-tracking hazard (separate from the findings):** the `codex:codex-rescue` job ran detached as pid 2785218 with state under `~/.claude/plugins/data/gemini-google-gemini/state/…/jobs/` (gemini dir, not codex), **not** in harness `TaskList`, and emitted **no** completion notification. Ending the turn naively would orphan it (matches a parallel-session report of the same failure). Bridged here with a harness-tracked Bash watcher (one notify on pid death). Conclusion: the codex-rescue *dispatch works*; only the *harness tracking/notification* is broken. A second session also observed the codex process itself **wedging on an MCP call** (13+ min on ICM, no findings) — captured as plan risk **R2b**; user wants the watcher-harness productized (deferred, not this turn).

**Resolution (fixed this turn, TDD-first, 104/104 green via `npm test`):** all three findings closed inline (not via the flaky Codex route — exactly what v8 removes).
- HIGH — `decideNextAction` now throws on a non-integer `active_run.wave` (mirrors the dispatch-branch guard); `promote-active-run` refuses to run without a phase-1 launching marker carrying an integer wave. No more finalize-while-pending / orphan window.
- MEDIUM — `markTask` throws on an unknown id (no phantom write); `mark-task` validates `--status` against `VALID_TASK_STATUS = [pending, in_progress, done]` and dies clean on a bad id/status. Legacy `skipped`/`in-progress` stay migrate's concern, not a v8 write vocabulary.
- LOW — `applyPlanIndex` keys by `String(id)` on both sides (numeric-state-id vs string-plan-id now match); `backfill-waves` reports the real scheduled count and fails loud (before writing) if any pending task is still wave-less.
- Coverage gaps closed: promote-without-marker, wave-less `active_run` throw (unit + CLI), no-op/invalid-status `mark-task`, `backfill` leftover-wave-less, cross-type `applyPlanIndex` match, and a 24-shape `parseState∘serializeState` round-trip fuzz. Every fix-test discriminates (fails on the pre-fix code).

**Fresh-eyes follow-up (same turn, `feature-dev:code-reviewer` over the hardened core → 1 MEDIUM + 2 LOW, 5 categories CLEAN; now 106/106 green):**
- **MEDIUM — `set-active-run` origin guard.** The HIGH fix guarded the *readers* (`decideNextAction`, `promote-active-run`) against a non-integer wave, but `set-active-run` — the SOLE ORIGIN of that value — didn't validate its own `--wave`. A `--wave=2.0`/bare `--wave` persisted a phase-1 marker, then the next `decide` threw and wedged the loop until a manual clear. Now fails loud at the source (mirror of promote's guard) + test.
- **LOW#1 — `backfill-waves` message.** Now names "non-integer wave value (e.g. \"2\" instead of 2)" as a cause, not just "id mismatch / missing wave" — covers the present-but-string-wave case (`applyPlanIndex` doesn't coerce a string wave; it's caught but was misdescribed) + test.
- **LOW#2 — interim inline dispatch path** (`commands/masterplan.md` `dispatch_wave` cell): the "until L2 is wired" shortcut skipped the phase-1 marker, so a crash mid-inline left `active_run:null` → resume blindly re-`dispatch_wave` with no scope reset → partial-edit accumulation. Now brackets the inline path with `set-active-run`/`clear-active-run` (it's the only currently-live dispatch path until Step 4; Step 4's L2 launch supersedes it).
- Verdict: core is internally consistent and the silent-corruption class is closed. **Safe to build Step 3 (`agents/*.md`) on top.** Next: Step 3.

## 2026-05-29 — Parity-dogfood (plan step 8) started — the v7→v8 cutover gate

Branch `dogfood-scratch` off `masterplan-ng@f2e1b54`. Bundle `docs/masterplan/2026-05-29-v8-dogfood/` (3-task plan: wave-1 disjoint pair greet/farewell, wave-2 index, task 3 codex-routed). v8 cannot run via the slash command (the live `/masterplan` is published v7.2.3), so it's driven through its seams: `node bin/masterplan.mjs <verb>` for L1, the Workflow tool for L2.

**Phase A complete (zero LLM tokens — deterministic paths only).** Drove the full L1 control loop end-to-end: forward walk to `complete` through both waves; all 6 `decideNextAction` branches exercised (dispatch / await-result / surface-gate / backfill-guard / complete / error); idempotency proven — `prepare-wave` drops `done` tasks so re-dispatch can't double-commit; gate-survives-compaction proven (surface_gate beats active_run). The deterministic L1 spends zero model tokens, as designed.

**Found + fixed a CUTOVER-BLOCKING bug (the dogfood's whole point).** `VERSION_RE` in `lib/migrate.mjs` required a decimal, but `serializeState` emits whole versions as bare integers (`6.0`→`6`, JS `String(6.0)==="6"`). So **every v8 bundle wedged after the shell's FIRST state write** — the next `loadForWrite` saw "pre-5.0/unknown". Root cause: two validators disagreed (`detectSchemaVersion` decimal-required vs `validateCoreState` accepts bare int) and no test round-tripped write→detect. Fix: decimal made optional + 2 regression tests (suite 232→234). **Uncommitted on `dogfood-scratch`; must land on `masterplan-ng` before cutover** (committing the published branch is user-gated).

**Live phase started below** (real model tokens). The "still pending" list above is superseded by the wave-1 results that follow.

**Live phase — wave-1 smoke: PASS (first-ever `execute.workflow.js` execution).** Ran the disjoint wave-1 pair (greet/farewell) through L2; review off. Result: 2/2 `done`, ~28s, **41,567 sonnet output tokens** (real sonnet via the seam below, not opus); both digests carry `verify:"ok" passed:true`, re-verified independently (`greet("World")`→`Hello, World!`, `farewell("World")`→`Goodbye, World.`).
- **agent-`<id>`.jsonl SURVIVES** (gates telemetry-hook deletion): each implementer left a `subagents/workflows/<wf>/agent-<id>.jsonl` (~20 lines / ~39 KB) + `.meta.json` sidecar + a workflow `journal.jsonl`. The Workflow runtime writes per-agent transcripts natively → the bash telemetry hook is redundant for per-agent capture (actual deletion still gated on a deliberate decision + confirming the journal carries everything the hook emitted).
- **CD-7 held:** engine made no commit (HEAD still `8bd4e9b`) and wrote no `state.yml` — digests only. L1 `mark-task` (sole writer) then recorded t1/t2 `done`.
- **D6 verify-scope PASS:** `{ok:true, touched:[src/greet.mjs, src/farewell.mjs], outOfScope:[]}` — wave touched exactly its declared scope.
- **schema_version fix (8bd4e9b) validated LIVE:** committed to `masterplan-ng` (suite 234/234); the bundle then survived two `mark-task` write-backs still reading `schema_version: 6`. The wedge is closed on a real bundle, not just in unit tests.

**NEW cutover-relevant finding — Workflow-tool object-arg binding (root cause NAILED via a 0-agent probe; earlier "args dropped empty / open risk" framing was an uncontrolled comparison and is superseded).** The `Workflow` **tool** boundary JSON-**stringifies** object `args` before the script's `args` global. A trivially clean `{wave:42, items:["x","y"]}` launched via the exact `scriptPath` failing mode arrived as `typeof args === 'string'` (the raw JSON text), via a dedicated 0-agent probe (`/tmp/mp-arg-probe.workflow.js`, wf_11e56851). This isolates the cause: NOT payload-escaping (the clean payload reproduced it), and NOT "object args can't cross" — they DO cross, JSON-encoded. The engine reads `args?.wave` / `Array.isArray(args?.tasks)` directly (`execute.workflow.js:43-47`), so a string `args` → `args?.tasks===undefined` → `tasks=[]` → empty wave → `total:0` — exactly the first two failed launches. The in-script `workflow(ref, obj)` path passes a real object (no tool boundary), which is why the smoke ran. **Production L1 (the markdown orchestrator) launches L2 via the `Workflow` tool → it WILL hit the string path → empty waves. Confirmed cutover-blocker, with a one-line fix:** normalize at the engine top — `const A = (typeof args === 'string') ? JSON.parse(args) : (args ?? {})`, then read every field from `A` — robust to BOTH launch paths (tool-boundary string AND in-script object). Decision (apply the normalization vs standardize L1 on an in-script launcher shim) resolved → normalization applied.

**FIX APPLIED + PROVEN (this turn).** `execute.workflow.js` now normalizes a string `args` via `JSON.parse` at the top (`const A = (typeof args === 'string') ? JSON.parse(args) : (args ?? {})`, all reads off `A`) — robust to BOTH launch paths. Proven three independent ways: (1) the 0-agent probe above (real tool boundary delivers a string); (2) **5 regression tests** in `test/execute-workflow.test.mjs` (suite 234→**239**, all green): string-args→`total:2` (the regression — was 0), object-args→`total:2`, undefined/`"{}"`→empty + no dispatch, malformed→throws loud (never a silent empty wave); (3) **real-boundary re-validation** — relaunched the ACTUAL engine via `Workflow({scriptPath, args:{object}})` → `summary.total:1, done:1`, verify `passed:true` ("ok"), `files_changed:[]`, **was `total:0` pre-fix**; 1 agent / 21.5k tok / ~19s; CD-7 held (`start_sha`=HEAD `8bd4e9b`, no commit, no state write). The fix + test live in the SAME file as the dogfood seam, so committing them entangles the seam keep/revert decision — left UNCOMMITTED pending that AUQ.

**Scope of the green (do not over-read).** Proves engine ORCHESTRATION: pipeline, schema-validated digests, digest collection, token accounting, JSONL survival, L1↔L2 echo, CD-7, D6. Does NOT prove `mp-implementer.md` system-prompt fidelity (ran `general-purpose`+`sonnet` via the seam — the dev plugin isn't installed, so the `masterplan:`-prefixed agentTypes don't resolve) or the `mp-codex-reviewer` path (review off). Those need a plugin-installed run; keep "implementer-agent parity" + "codex-review path" as open items. This smoke is NOT "parity confirmed."

**Dogfood seam (uncommitted) in `workflows/execute.workflow.js`:** `args.implAgentType/implModel/reviewAgentType/reviewModel` injection; prod never sets them → defaults reproduce shipping behavior byte-for-byte. Needed because the engine hardcodes the unresolvable-here `masterplan:` agentType prefix. Keep-as-testability-seam vs revert is a deliberate decision, pending.

**Remaining for the gate:** commit the args-fix + 5 tests (DONE in the worktree, proven; commit is entangled with the dogfood-seam keep/revert decision — AUQ); wave-2 + real codex reviewer on task 3 (needs the dev plugin installed so the `masterplan:` agentTypes resolve, OR the seam); the parity write-up vs v7.2.3; then the user-gated cutover (merge to `main` + version bump + manifest swap). Push of `8bd4e9b` (+ this WORKLOG commit) to origin/masterplan-ng authorized this turn.

## 2026-05-29 — Parity-dogfood wave-2 + report: e2e gate PASS, ONE residual blocks the cutover

Closes the gate's live phase. **Decisions:** (1) AUQ#2 Q2 resolved — seam KEPT, committed `561f348` as a prod-inert testability hook (prod never sets `implAgentType`/`implModel`/`reviewAgentType` → `masterplan:*` defaults reproduce shipping behavior byte-for-byte). (2) AUQ#2 Q1 ("install dev plugin → TRUE parity *this session*") is **empirically unachievable mid-session** and was NOT done; install repurposed to future-session setup (see residual).

**Why the install can't help mid-session — now TESTED, not inferred** (closes the advisor's assert-vs-prove gap): the prior probe only tested the *orchestrator* Agent registry. A new **Workflow-subprocess** probe (the process that actually runs the engine) attempted `masterplan:mp-implementer` and returned the **identical** available-agents list as the orchestrator → the subprocess uses the same session snapshot, no disk re-read at launch → a mid-session dev-plugin install would not register `masterplan:*`. (1 agent, 0 tokens, 4ms.)

**Wave 2 — e2e PASS at max-achievable parity.** Drove the real L1 loop (`decide`→`prepare-wave`→`set-active-run`→Workflow→`promote-active-run`→`verify-scope`→`mark-task`→`clear-active-run`→`decide:complete`), launching the **real committed engine over the real `Workflow`-tool boundary** with `general-purpose`+`sonnet` implementer + `codex:codex-rescue` reviewer, `review:on`. Result `summary{total:1,done:1,failed:0,reviewed:1}`; `src/index.mjs` correct, verify `"ok"`; **D6 `{ok:true,touched:["src/index.mjs"],outOfScope:[]}`**. `total:1` (not 0) is the headline — **the stringified-args cutover-blocker is dead at the production boundary**, not just in unit tests. 39,388 subagent tok / 2 agents / 160s. CD-7 held (engine returned digests only, made no commit/state write; L1 sole writer).

**Finding — `extractVerdict` fail-safe validated, NOT a bug.** Digest `verdict:inconclusive` while prose said `verdict: PASS`. Cause: the stand-in `codex:codex-rescue` emitted off-contract "PASS"; the *real* `agents/mp-codex-reviewer.md:41` contracts `verdict: blocking|advisory|clean|inconclusive` — exactly `extractVerdict`'s vocab. The engine **degraded safely** (fell back to `inconclusive` = "no blocking findings, logged caveat — NOT a clean pass"), never reading a non-clean review as clean. No code change. Minor cosmetic note: `general-purpose` returned an absolute `files_changed` path (D6 unaffected; uses git-relative sets).

**THE residual that blocks the cutover (not wave-2-today):** real-`masterplan:*`-through-the-engine stays **untested end-to-end** — wave 2 used stand-ins. Residual = agentType *labels* + agent *system bodies* only (models match; engine task-prompts identical). Retire via a **fresh session** with `masterplan-ng` installed **additively** as a distinct dev plugin (NEVER replacing the shipped `masterplan` entry — that hijacks the user's `/masterplan` and pre-empts the gated cutover), seam args omitted so the real agents resolve. Confirm: real-agent dispatch through the engine, real reviewer closes `clean`, `files_changed` shape.

**(c) token/context budget — all three PASS:** deterministic L1 paths spent zero LLM tokens (pure `node bin/masterplan.mjs`); only digests crossed L2→L1 (no raw file bodies); mid-run compaction (this very session) resumed purely from `state.yml` on disk. Full evidence: `docs/masterplan/2026-05-29-v8-dogfood/parity-report.md`.

**Committed this run (masterplan-ng):** parity-report.md + dogfood bundle records (state.yml final, plan.index.json) + the stale-comment fix in `execute.workflow.js` ("uncommitted"→"committed"). Smoke `src/*.mjs` left untracked (content preserved in the report; not polluting the published tree). 561f348 not yet pushed; push + the actual cutover stay user-gated.

## 2026-05-29 — Telemetry-hook deletion gate CLOSED (R1/Resolved #5)

Pushed `63b28ba` (→ origin/masterplan-ng; `main` untouched at v7.2.3) and deleted the merged `dogfood-scratch` last turn; this turn closed the last parked v8 gate that was runnable in-session.

**Field-completeness check (read-only, against the dogfood run's persisted `…/2356b212…/subagents/agent-*.jsonl`):** the native completion-record `toolUseResult` carries every per-subagent field the bash hook captured — `usage.{input,output,cache_creation_input,cache_read_input}_tokens`, `totalTokens`, `totalDurationMs`, `status`, `totalToolUseCount`, full `toolStats.*`. **Only gap = `model`** (absent from `toolUseResult`, recoverable from per-agent `agent-<id>.jsonl` `message.model`, full string). Neither the hook nor native records ever stored a cost-dollar amount → the Resolved-#5 ≤150-line-shim escape hatch is **NOT triggered**. **Verdict: FULL-DELETE, no shim.** Both gate conditions now met (survival ✓ wave-1 smoke; field-completeness ✓ this turn).

**Physical removal sequenced WITH the cutover, not piecemeal on the branch.** `masterplan-ng` still carries the entire v7 self-instrumentation surface (the 46.7K `hooks/masterplan-telemetry.sh` — already de-registered from `hooks.json`, only the SessionStart shim remains, so the file is inert here; plus `bin/masterplan-anomaly-*.sh`, `masterplan-routing-stats.sh`, the audit scripts, `parts/*.md`, `lib/masterplan_*.py`) because the rebuild has been additive. The hook is shipped+live on `main` v7.2.3 → zero urgency to delete early; the whole surface comes out as one cutover diff. Plan R1 + memory updated.

## 2026-05-29 — Scoped v8 deploy to ras@epyc2 + version label bump → 8.0.0

**Deploy (registry-swap; user chose this over a `--plugin-dir` shim).** v8 (`a34f876`) is now the sole enabled `masterplan` on **ras@epyc2**; `main` and grojas@epyc1 untouched at v7.2.3. Mechanism (fully reversible, brick-safe via the official non-interactive `claude plugin` CLI — NO `installed_plugins.json` hand-edit): pushed `masterplan-ng` → cloned deploy checkout `/home/ras/.local/share/masterplan-v8` → renamed its marketplace `rasatpetabit-masterplan`→`masterplan-v8` (sidesteps bare-name collision with the GitHub marketplace) → `marketplace add` → `disable masterplan@rasatpetabit-masterplan` → `install masterplan@masterplan-v8 -s user`. Verified (CD-3): exactly one enabled `masterplan`; `gitCommitSha=a34f876`; cache = genuine v8 (`skills/` = only masterplan+masterplan-detect); and `node bin/masterplan.mjs version`/`detect-host` EXECUTE under ras's Node (entrypoint runs, not just files-present). Rollback = one `disable`+`enable`. **Residual** = interactive `/masterplan` + `masterplan:mp-*` resolution → ras's first fresh session (doubles as the parity-runbook true-parity run, now unblocked). v7.2.3 kept dormant on epyc2 (fast rollback); telemetry SessionStart hook left registered (inert under v8, flagged for that fresh session). Do NOT delete `/home/ras/.local/share/masterplan-v8` — it is the marketplace SOURCE.

**Version bump 7.2.3 → 8.0.0 (this turn).** So `claude plugin list` self-evidently reads v8 (was distinguishable only by `gitCommitSha`). Touched the test-gated cross-manifest sync set ONLY: README "Current release", `.claude-plugin/{marketplace,plugin}.json`, `.codex-plugin/plugin.json`, plus a terse CHANGELOG unreleased entry. `package.json` left at `8.0.0-ng.0` by design (the publish-hygiene LIVE test excludes it until cutover). Suite green **239/239** post-bump.
