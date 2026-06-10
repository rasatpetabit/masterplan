# Cutover Removal Manifest — v7 surface → delete on the v7→v8 cutover

**Scope.** When `masterplan-ng` cuts over to `main` as v8, the rebuild has been
**additive** — the entire v7 surface still sits in the tree alongside the new v8
layers. This manifest enumerates what the cutover diff **deletes**, what it
**keeps**, what needs a **deliberate decision first**, and the **non-delete**
cutover actions (version bump, manifest swap, reference scrub, merge).

**This is a reference, not an instruction to delete now.** Physical removal happens
**during the user-gated cutover**, which is itself sequenced **after** the
fresh-session true-parity run ([`parity-runbook.md`](./parity-runbook.md)). Authority
for each verdict is the plan's *Survives / Dies / Transforms* table
(`i-feel-like-we-ve-swift-lampson.md` lines 73–96, cited as "table L<n>").

---

## Tier 1 — CONFIRMED DELETE (table-authoritative or evidence-confirmed)

### Self-instrumentation (`bin/` + `hooks/` + `lib/*.py`)

| Path | Authority |
|---|---|
| `hooks/masterplan-telemetry.sh` | table L87 + Resolved #5; **deletion gate CLOSED** (FULL-DELETE, no shim — see WORKLOG / plan R1). Already de-registered from `hooks.json` (inert on the branch). |
| `bin/masterplan-anomaly-flush.sh`, `bin/masterplan-anomaly-smoke.sh` | anomaly framework — table L88 |
| `bin/masterplan-routing-stats.sh`, `bin/masterplan-codex-usage.sh`, `bin/masterplan-failure-analyze.sh`, `bin/masterplan-findings-to-issues.sh` | stats/analysis scripts — table L92 |
| `bin/masterplan-self-host-audit.sh` | pure self-instrumentation — table L90 |
| `bin/masterplan-session-audit.sh` + `lib/masterplan_session_audit.py` | policy-regression watcher (no prose to police) — table L89 |
| `bin/masterplan-recurring-audit.sh`, `bin/masterplan-audit-schedule.sh` | audit scheduling self-instrumentation — table L83/L92 class |
| `bin/masterplan-wipe-telemetry.sh` + `lib/masterplan_wipe_telemetry.py` | telemetry tooling dies with the hook — table L87 |
| `bin/masterplan-policy-regression-smoke.sh` | policy-regression — table L89 |
| `bin/masterplan-release-gate.sh` | release hygiene → superseded by `lib/hygiene.mjs` + `test/publish-hygiene.test.mjs` — table L131 |
| `bin/masterplan-guard-b-smoke.sh`, `bin/masterplan-guard-c-smoke.sh` | v7 guard smokes → superseded by `node:test` |
| `bin/masterplan-state.sh` | v7 inventory/migration → superseded by `lib/migrate.mjs` + `bin/masterplan.mjs migrate-bundle` — table L96 transforms |
| `lib/__init__.py` | python package marker; v8 is node-only ("Bash survives only in the SessionStart shim", plan L151) |
| `skills/masterplan-detect/` | **RESOLVED 2026-05-29 → DELETE.** No v8 wiring: `hooks/hooks.json` (the surviving SessionStart shim) has zero refs to it; `commands/masterplan.md` / `bin/masterplan.mjs` / `lib/` never invoke it (`lib/hygiene.mjs:107` only lists it in `INFRA_SKILL_NAMES` to *exclude* it from collision checks). Plan L94 preserves the SessionStart **shim**, not this skill. The v7 job (ambient auto-suggest `/masterplan import`) is superseded by the direct `import` verb in the v8 routing table. ⚠️ Soft caveat: this drops ambient legacy-artifact *detection* — confirm you don't want to retain a v8 detect-suggest before deleting. |

### Prose orchestrator (`parts/` — entire tree, 21 files)

The v7 LLM-interpreted markdown orchestrator. **Replaced** by `commands/masterplan.md`
(L1 shell) + `lib/*.mjs` + `workflows/execute.workflow.js` (L2) + `agents/*.md` (L3).
Table L81/L82/L83. Confirmed: `commands/masterplan.md` references **no** `parts/`.

- `parts/codex-host.md` → `lib/codex-host.mjs` (table L82)
- `parts/doctor.md` → `lib/doctor/*.mjs` (table L83)
- `parts/failure-classes.md` → anomaly framework dies (table L88)
- `parts/step-0.md`, `step-a.md`, `step-b.md`, `step-c-{dispatch,resume,verification,completion}.md` → L1/L2 (table L81)
- `parts/import.md` → **RESOLVED → DELETE.** The `import` *verb itself survives* (v8 routing table `commands/masterplan.md:136` → `mp migrate-bundle`, implemented `bin/masterplan.mjs:193` + `lib/migrate.mjs`); only the 17.7 KB v7 prose step-file dies. The `skills/import` entry-point shim is KEEP (Tier 3).
- `parts/.gitkeep` → delete with the tree
- `parts/contracts/` → dies with `parts/`, **but 3 of its 8 files carry pre-delete port-actions** (2 DEFERRED-SPEC port-blockers + 1 thin-slice). Port-check **RESOLVED 2026-05-29** — see the Tier-2 table for the per-file disposition and Tier-4 items 8–11 for the ports that must precede `git rm parts/`.

### v7 test harness (`tests/` — entire tree, 302 files)

The v8 suite is `test/` (`package.json` `test` = `node --test test/*.test.mjs`).
The v7 `tests/` tree tests the deleted surface. `lib/doctor/README.md:30` records the
deliberate deviation: v8 doctor fixtures are NEW under `test/fixtures/doctor/`; the
v7 `tests/doctor-fixtures/` block-YAML "tests the deleted doctor".

| Path | Note |
|---|---|
| `tests/doctor-fixtures/` (253 files) | v7 block-YAML for the deleted 53-check doctor |
| `tests/test_masterplan_session_audit.py`, `tests/test_masterplan_audit_schedule.py`, `tests/test_masterplan_state.py`, `tests/test_codex_review_parse.py` | python tests for dying modules |
| `tests/e2e/`, `tests/static/`, `tests/structural/`, `tests/hook-unit/`, `tests/fixtures/`, `tests/run-tests.sh`, `tests/run-static.sh` | v7 prose/static harness |
| `bin/run-tests.sh`, `bin/run-tests-fast.sh` | **delegate to `tests/run-tests.sh`** (`exec "$REPO_ROOT/tests/run-tests.sh"`) → die with `tests/`, OR rewrite to `node --test test/*.test.mjs` (decide in cutover) |

> ⚠️ Confirm before `git rm tests/`: Step-5 notes say flat-compatible v7 data (check-32/39) was **copied INTO** `test/fixtures/` — the originals in `tests/` are dependents, not sources, so dropping them is safe. Verify no `test/**` file reads a `tests/` path (grep showed only the `lib/doctor/README.md` prose mention).

---

## Tier 2 — RESOLVED (decisions made; ports moved to Tier 4)

> **2026-05-29 — all six original Tier-2 items RESOLVED.** First four (prior pass):
> per-verb `skills/` dirs (incl. `stats`, `import`) are **KEEP** entry-point delegators
> (→ Tier 3); `skills/masterplan-detect` + `parts/import.md` are **DELETE** (→ Tier 1).
> The earlier "the v8 shell references none of them → v7 surface" reasoning was **wrong**
> (confirmation bias, anti-pattern #5): the skills *call into* the shell. **Last two
> (this pass), evidence-cited below:** the `parts/contracts/` port-check is decided
> per-file, and `Makefile` is decided to TRIM. **No open Tier-2 items remain** — the
> three surviving port-actions live in Tier 4 (items 8–11), so the cutover is fully
> mechanical once those run.

**`parts/contracts/` — per-file disposition (port-check complete).** This is
*operational-prose contracts* — a **different artifact** from the v8
`commands/masterplan-contracts.md` (a YAML return-shape *registry*), so "it migrated
to commands/" was always false. The 8 files split three ways. The discriminator (advisor-
vetted): a file is a **port-blocker** only if **its v8 replacement does not yet exist AND
it is the sole canonical home of the spec** — otherwise it is DEAD (replacement exists /
intentional removal) or REPRESENTED (content lives in a surviving artifact).

| File (size) | Verdict | Evidence |
|---|---|---|
| `taskcreate-projection.md` (8.4K) | **DEAD** | v8 has no TaskCreate projection layer (plan L86 DIES). |
| `agent-dispatch.md` (13.2K) | **DEAD** | DISPATCH-SITE / telemetry / per-turn machinery intentionally removed in v8 (CC-3 trampoline gone, `commands/masterplan.md:150`). Model tiers survive in `agents/*.md` frontmatter. |
| `brainstorm-anchor.md` (5.7K) | **DEAD** | v7 three-Haiku fan-out superseded by `superpowers:brainstorming` delegation (`commands/masterplan.md:133`); the anchor *extraction* behavior survives as `coordinator-brainstorm-anchor-v1` (`masterplan-contracts.md:367-382`, full anchor schema). |
| `coordinator.md` (2.2K) | **REPRESENTED → safe-delete** | the 5 coordinator contracts live in `commands/masterplan-contracts.md:367-458`. |
| `run-bundle.md` (10.8K) | **REPRESENTED → safe-delete** | schema → `lib/bundle.mjs`; `plan.index.json` → `agents/mp-planner.md` + `lib/routing.mjs` + `bin/masterplan.mjs`; scalar-cap → `lib/doctor/scalar-cap.mjs`. |
| `plan-annotations.md` (2.9K) | **✅ PRE-PORTED** (was PORT-BLOCKER) | **sole** home of the Step-B2 *writing-plans brief* (Codex/parallel-group/verify-pattern/skip directives, complexity-aware brief, `### Task <N>:` + `**Codex:**` plan-format markers). `masterplan-contracts.md:139` only **name-drops** the directives; `mp-planner.md` has the `plan.index.json` *output* schema, not this *input* brief. Needed by the step-7 `plan` verb (`commands/masterplan.md:133` "[lifecycle wiring = step 7]", not yet built). **Ported verbatim 2026-05-29 → `docs/conventions/plan-annotations.md`** (`mp-planner.md` now references it). At cutover: `git rm` is safe; just repoint any references (Tier-4 #8 DONE). |
| `cd-rules.md` (2.9K) | **✅ PRE-PORTED** (was PORT-BLOCKER, mandatory) | **sole** canonical home of the CD-1…CD-10 *body* definitions. `docs/internals.md:15` only **cited** "CD-7" in a table row — it did not define them. `CD-N` is cited across **live v8 code** (CLAUDE.md, `agents/*.md`, `commands/masterplan.md`, `workflows/execute.workflow.js`), so deleting this would have dangled every citation **immediately**. **Ported verbatim 2026-05-29 → `docs/conventions/cd-rules.md`** (all 10 IDs, byte-identical bodies; `docs/internals.md` now points to it). At cutover: `git rm` is safe (Tier-4 #9 DONE). |
| `codex-review.md` (10.6K) | **DEAD; thin slice ✅ PRE-PORTED** | the JSON `{verdict,findings[]}` parse contract + dispatch mechanism are superseded by `agents/mp-codex-reviewer.md` (CD-10 severity-first text shape, `verdict: blocking\|advisory\|clean\|inconclusive`). The six B2/B3 review *dimensions* (`completeness/correctness/security/consistency/naming/scope`, `codex-review.md:64`) were the only unrepresented slice. **Ported 2026-05-29 → `docs/conventions/codex-review-dimensions.md`** (the dead parse/dispatch content deliberately NOT ported). At cutover: `git rm` is safe (Tier-4 #10 DONE). |

**`Makefile` — TRIM (resolved).** Keep `make test` → `npm test` (the v8 `node --test
test/*.test.mjs` gate, 239/239 green) and `make help`; **delete** the four v7-coupled
targets (`test-static`, `test-doctor-fixtures`, `test-python`, `test-e2e`), all of which
wire to the dying `tests/` tree. The still-relevant `test-static` checks are **already
covered by `npm test`**: `test/publish-hygiene.test.mjs` Guard 2 (lines 118-133) is the
LIVE cross-manifest **version-sync** gate and Guard 3 (170-177) the **namespace/verb-router**
gate. (v7 `test-static` also did a frontmatter-`description:` table sync against the v7
prose verb table; that table is gone in the thin v8 shell — no v8 gap, but the namespace
guard already polices the surviving verb router.) → **Tier-4 #11.**

---

## Tier 3 — KEEP (v8 core + explicit survivors)

- **L1/L2/L3 core:** `commands/masterplan.md`, `commands/masterplan-contracts.md`, `workflows/execute.workflow.js`, `agents/mp-{explorer,implementer,planner,codex-reviewer}.md`
- **Per-verb `skills/` entry-point shims — ⚠️ DECISION REVERSED 2026-05-29 (user directive) → DELETED.** The 12 per-verb delegators (`skills/{brainstorm,clean,doctor,execute,full,import,next,retro,status,validate,verbs,stats}/`) were **`git rm`'d**. The prior "deleting these breaks the verb commands" claim was an **overstatement**: every verb routes through the bare `/masterplan <verb>` command via `bin/masterplan.mjs` (`commands/masterplan.md` §1/§3) — deleting the delegators only removes the redundant **`/masterplan:<verb>` namespaced alias**, which the user judged "a bad idea" (it added nothing over bare-command routing, polluted the `/` palette, and the reserved words `plan`/`status`/`doctor` shadowed CC built-ins `/plan`,`/status`,`/doctor`). Only `skills/masterplan/` + `skills/masterplan-detect/` survive. The namespace-collision guard (`lib/hygiene.mjs` → `findNamespaceCollisions`) was tightened to an **infra-only** contract (FORBIDDEN += `status`,`doctor`; only `INFRA_SKILL_NAMES` allowed under `skills/`) so the per-verb namespace cannot creep back — `test/publish-hygiene.test.mjs` green (239/239).
- **`lib/` (node):** `bundle.mjs`, `codex-host.mjs`, `hygiene.mjs`, `migrate.mjs`, `paths.mjs`, `resume.mjs`, `routing.mjs`, `wave.mjs`, `lib/doctor/*`
- **`bin/`:** `masterplan.mjs` (L1 adapter), `doctor.mjs` (L4)
- **`hooks/hooks.json`** — SessionStart shim only; **survives verbatim** (table L94)
- **`test/`** — v8 `node:test` suite
- **Manifests (survive, table L95):** `.claude-plugin/`, `.codex-plugin/`, `.agents/`, `plugins/` — **+ fix the `plugins/masterplan` symlink** (Resolved #8) and add the CI resolve-assert
- **Project files:** `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `AGENTS.md`, `RELEASING.md`, `LICENSE`, `package.json`, `.gitignore`, `.github/`
- **`docs/`** — v8 docs (`internals.md`, this dogfood bundle, `spike-0.5-findings.md`). v7 legacy docs (old `docs/superpowers/...`, archived bundles) are a *separate, optional* doc-hygiene pass, not v7-code-surface.

---

## Tier 4 — NON-DELETE cutover actions (do alongside the removals)

1. **Reference scrub (REQUIRED — deletion isn't just `git rm`).** After Tier-1/2 removals, grep the keepers for dangling references. Known hits (from `git grep telemetry|anomaly|routing-stats`): `commands/masterplan.md`, `README.md`, `lib/doctor/plugin-registry-drift.mjs`, `lib/doctor/state-schema.mjs`, `lib/doctor/README.md` (the `tests/doctor-fixtures` mention). Repoint or remove each so nothing references a deleted path. Re-run `node --test test/` after.
2. **Rewrite or drop `bin/run-tests{,-fast}.sh`** (they `exec` the deleted `tests/run-tests.sh`).
3. **Major version bump** v7.2.3 → **v8.0.0** across all manifest copies: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and the README `Current release:` line (SoT for the `lib/hygiene.mjs` cross-manifest version-sync guard). Update the frontmatter `description:` if the verb surface changed.
4. **`CHANGELOG.md`** v8.0.0 entry (the clean-core rebuild — link the plan + this bundle).
5. **Doc rewrites (stale-architecture — REQUIRED).** Both the project `CLAUDE.md` and `README.md` currently document the **v7 surface as current**: `CLAUDE.md`'s "What this codebase IS" lists `hooks/masterplan-telemetry.sh`, `bin/masterplan-state.sh`, `skills/masterplan-detect/SKILL.md`, and "a single ~2150-line markdown orchestrator at `commands/masterplan.md`" with "no code in the conventional sense / tests are grep + bash -n" — all false post-cutover (v8 is Node-primary `lib/*.mjs` + `node:test`, the orchestrator is a thin shell, telemetry/state.sh are deleted). Rewrite "What this codebase IS", "Where to read first", "Build/test/lint" (→ `npm test` / `node --test test/`), and the anti-patterns to the 5-layer v8 architecture. README's install/usage/architecture prose likewise. (`docs/internals.md` is the v8 source-of-truth to pull from.)
6. **Pre-merge gate:** `node --test test/` fully green **and** the publish-hygiene guard (`test/publish-hygiene.test.mjs`: fixture-identifier scan, cross-manifest version sync, namespace collision) green.
7. **Tag the pre-cutover HEAD** as `v7.2.3-final` (or `pre-v8-cutover`) **before any `git rm`**, so every deleted v7 artifact stays recoverable. (Belt-and-suspenders now that the three DEFERRED-SPEC slices below are already ported — but still cheap insurance for the rest of the v7 surface.)
8. ✅ **DONE — `plan-annotations.md` (Step-B2 writing-plans brief) PRE-PORTED** verbatim → `docs/conventions/plan-annotations.md` (2026-05-29); `agents/mp-planner.md` references it. At cutover, `git rm parts/contracts/` is safe; the item-1 reference scrub just repoints any plan-annotation references at the new home.
9. ✅ **DONE — `cd-rules.md` (CD-1…CD-10 bodies) PRE-PORTED** verbatim → `docs/conventions/cd-rules.md` (2026-05-29, all 10 IDs, byte-identical); `docs/internals.md` points to it. This was the **mandatory** one (live code cites `CD-N` today); now safe to `git rm` at cutover. Re-run the item-1 reference scrub to confirm no `CD-N` citation dangles.
10. ✅ **DONE — `codex-review.md` six review dimensions PRE-PORTED** → `docs/conventions/codex-review-dimensions.md` (2026-05-29); the dead JSON-parse/dispatch content was deliberately NOT ported. Safe to `git rm` at cutover.
11. **Trim the `Makefile`** — keep `test` → `npm test` + `help`; delete `test-static`, `test-doctor-fixtures`, `test-python`, `test-e2e` (their still-relevant checks — version-sync, namespace — are already in `test/publish-hygiene.test.mjs`). *(Mechanical; do at cutover.)*
12. **The merge itself** (`masterplan-ng` → `main`) — the user-gated cutover. After it, the shipped `/masterplan` becomes v8; the v7 surface is gone from `main`.
13. **RULED 3B (2026-05-30) — land 3B's code BEFORE `git rm` of the v7 Codex hedge** (`parts/codex-host.md`,
    `parts/contracts/taskcreate-projection.md` — both Tier-1). Deleting them removes the *"bounded interactive
    mode — not a license to execute the whole workflow inline"* hedge that currently makes the **surviving**
    `skills/masterplan/SKILL.md:135-146` Codex tool-adaptation table's **omitted Workflow-tool row** harmless.
    The user **ruled 3B** — full-lifecycle Codex (execute included) — over the 3A doc-only recommendation
    (see [`../../design-residuals.md` §Residual 3 OUTCOME](../../design-residuals.md)). So the gate is no longer
    *"rule 3A or 3B"* — the goal is decided; what remains is **shipping 3B's implementation**: a Codex
    foreground-sequential wave-dispatch path (`mp prepare-wave` → sequential `mp-implementer` → `update_plan`),
    an `if host.isCodex` execution branch at §2a, and — in the parity branch where Codex cannot host the
    Workflow tool — correcting the `codex-host.mjs:5-6` "native budget" comment. The **mechanism** (and whether
    the comment-fix is needed) is gated on the B1 parity run; the **commitment** is not. Do not delete the hedge
    until 3B's code has landed, or full-lifecycle Codex ships unimplemented and the gap reaches `main`.

---

## Sequencing recap

`fresh-session true-parity run` ([`parity-runbook.md`](./parity-runbook.md)) **→** then this
cutover: **tag HEAD (Tier-4 #7) → land 3B's Codex full-lifecycle execution code (#13, RULED — BEFORE deleting
the Codex hedge; mechanism gated on the parity run) → `git rm` Tier-1/2 + reference scrub (#1) →
version/doc/Makefile (#3–#5, #11) → pre-merge gate (#6) → merge (#12)**. All of it
**user-gated**; do not start the cutover unprompted. The telemetry-hook deletion (Tier 1,
row 1) is already **decided** (gate closed) but executes here, with the rest of the surface,
as one diff. The three DEFERRED-SPEC slices (`plan-annotations`, `cd-rules`,
`codex-review` dimensions) are **already pre-ported to `docs/conventions/`** (Tier-4 #8–#10
DONE 2026-05-29), so **no analysis remains and no spec is at risk — the cutover is now pure
deletion + version/doc-rewrite.**

---

## Errata / execution addendum (2026-06-10, v8.2.0 cutover)

The cutover **executed** on branch `feat/v8.2.0-cruft-cutover` (suite 806/806 green at every phase,
doctor exit 0; pre-deletion content tagged `v8.1.0-pre-cruft-removal`). Two rulings changed against
the Tier-1 text above, in line with the later entries of this same manifest:

1. **`skills/masterplan-detect/` — KEPT** (Tier-1 row said DELETE). The Tier-3 skills-reversal in this
   manifest ("Only `skills/masterplan/` + `skills/masterplan-detect/` survive"), the implemented
   `INFRA_SKILL_NAMES = ['masterplan', 'masterplan-detect']` guard in `lib/hygiene.mjs`, and
   `skills/masterplan/SKILL.md`'s "exactly two skill dirs" prose all agree the skill is live v8
   surface. The Tier-1 row's soft caveat (ambient legacy-artifact detection is worth retaining) won.
2. **Tier-4 #13 — discharged via attic, not 3B-first.** `parts/codex-host.md` +
   `parts/contracts/taskcreate-projection.md` moved to `docs/attic/v7-codex-hedge/` (not `git rm`'d),
   and the hedge's substance was ported into the surviving surface: `skills/masterplan/SKILL.md`'s
   Codex tool-adaptation table now carries an explicit **Workflow row** (bounded-interactive only;
   full-lifecycle Codex = Residual 3B, still unimplemented). The attic is deleted when 3B's
   foreground-sequential execute path ships. This unblocked the cutover without abandoning the 3B
   commitment.
   **ADDENDUM (2026-06-10) — #13 FULLY DISCHARGED.** 3B's foreground-sequential path shipped
   (`mp continue` returns `dispatch_foreground` under host suppression; see design-residuals
   Residual 3 closing addendum), the attic `docs/attic/v7-codex-hedge/` is `git rm`'d (text at tag
   `v8.1.0-pre-cruft-removal`), and the SKILL.md Workflow row now teaches the delivered op instead
   of the hedge. Empirical Codex-hosted parity dogfood remains outstanding (unit-verified only).

Also: `commands/masterplan-contracts.md` was **relocated** to `docs/contracts/` (DF-1) rather than
kept-in-place as the Tier-3 table assumed — its only live consumer (`tests/static/test-cross-refs.sh`)
died in this same cutover.
