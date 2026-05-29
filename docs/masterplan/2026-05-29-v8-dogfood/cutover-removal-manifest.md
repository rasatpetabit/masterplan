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

### Prose orchestrator (`parts/` — entire tree, 21 files)

The v7 LLM-interpreted markdown orchestrator. **Replaced** by `commands/masterplan.md`
(L1 shell) + `lib/*.mjs` + `workflows/execute.workflow.js` (L2) + `agents/*.md` (L3).
Table L81/L82/L83. Confirmed: `commands/masterplan.md` references **no** `parts/`.

- `parts/codex-host.md` → `lib/codex-host.mjs` (table L82)
- `parts/doctor.md` → `lib/doctor/*.mjs` (table L83)
- `parts/failure-classes.md` → anomaly framework dies (table L88)
- `parts/step-0.md`, `step-a.md`, `step-b.md`, `step-c-{dispatch,resume,verification,completion}.md` → L1/L2 (table L81)
- `parts/import.md`, `parts/contracts/`, `parts/.gitkeep` → delete with the tree (see Tier-2 note on the *import capability* + contracts)

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

## Tier 2 — DECISION REQUIRED before delete (strong v7 evidence; confirm v8 design intent)

| Path / subsystem | Question | Evidence |
|---|---|---|
| `skills/` per-verb dirs: `brainstorm clean doctor execute full import next retro status validate verbs masterplan` | Does v8 ship a per-verb skill surface, or pure thin-shell verb routing? | `commands/masterplan.md` references **none** of them. The v8 design is a ~100-line thin shell. Strong signal these are v7 surface. |
| `skills/stats` | Delete outright. | `/masterplan stats` → "trivial `jq` over `events.jsonl` if wanted at all" (table L92); routing-stats source is gone. |
| `skills/masterplan-detect` | Keep import-detection in v8? | v7 CLAUDE.md lists it as current (auto-suggest `/masterplan import`). Tie to the *import capability* decision below. |
| `parts/import.md` + import capability | Is `import` a v8 verb? | If yes, it lives in the shell/an agent, not `parts/`; if no, drop both `parts/import.md` and `skills/import`. |
| `parts/contracts/` vs `commands/masterplan-contracts.md` | Did contracts fully migrate to `commands/`? | `commands/masterplan-contracts.md` exists (v8); confirm `parts/contracts/` is fully superseded before deleting. |
| `Makefile` | Trim or delete. | v7 had a doctor-fixtures target; v8 uses `npm test` / `bin/run-tests` rewrite. |

---

## Tier 3 — KEEP (v8 core + explicit survivors)

- **L1/L2/L3 core:** `commands/masterplan.md`, `commands/masterplan-contracts.md`, `workflows/execute.workflow.js`, `agents/mp-{explorer,implementer,planner,codex-reviewer}.md`
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
7. **The merge itself** (`masterplan-ng` → `main`) — the user-gated cutover. After it, the shipped `/masterplan` becomes v8; the v7 surface is gone from `main`.

---

## Sequencing recap

`fresh-session true-parity run` ([`parity-runbook.md`](./parity-runbook.md)) **→** then this
cutover (Tiers 1–4) **→** merge to `main`. All of it **user-gated**; do not start
the cutover unprompted. The telemetry-hook deletion (Tier 1, row 1) is already
**decided** (gate closed) but executes here, with the rest of the surface, as one diff.
