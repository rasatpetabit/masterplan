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
- `parts/contracts/` → dies with `parts/`, **but port-check first** — see the Tier-2 row (TRANSFORM-INCOMPLETE: confirm v8 represents the still-live contract content before deleting).

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

## Tier 2 — DECISION REQUIRED before delete

> **2026-05-29 — four of the original six Tier-2 items RESOLVED** by a read-only
> tree investigation (subagent, evidence-cited). The corrected verdicts: the
> per-verb `skills/` dirs (incl. `stats`, `import`) are **KEEP** — they are
> *entry-point delegators*, not v7 prose (moved to Tier 3); `skills/masterplan-detect`
> and `parts/import.md` are **DELETE** (moved to Tier 1). The earlier "the v8 shell
> references none of them → v7 surface" reasoning was **wrong** (confirmation bias,
> anti-pattern #5): the skills *call into* the shell, so the shell referencing them
> back was never expected. **Only the two rows below remain genuinely unresolved.**

| Path / subsystem | Verdict | Open question + evidence |
|---|---|---|
| `parts/contracts/` (prose-contract dir) | **DELETE-with-`parts/`, but PORT-CHECK first** (TRANSFORM-INCOMPLETE) | This is *operational-prose contracts* — a **different artifact** from the v8 `commands/masterplan-contracts.md` (which is a YAML return-shape *registry*), so "it migrated to commands/" is false. Confirmed-dead members: `taskcreate-projection.md` (plan L86 DIES), `run-bundle.md` (→ `lib/bundle.mjs`), `cd-rules.md` (→ `lib/`). The whole dir dies with the v7 prose orchestrator — **but before `git rm`, verify v8 represents the still-live content of:** `plan-annotations.md` (plan-annotation syntax), `agent-dispatch.md` (dispatch model → check `agents/*.md` + `workflows/execute.workflow.js`), `codex-review.md` (dispatch/parse → check `lib/codex-host.mjs` + `agents/mp-codex-reviewer.md` + `extractVerdict`), `brainstorm-anchor.md`, `coordinator.md`. If any is unported, that's a **v8 gap to fill first**, not just a deletion. (Note `codex-review.md` is referenced by `parts/step-b.md` — but that's a *within-v7* ref; both die together.) |
| `Makefile` | **TRIM** (not full delete, not full keep) | All 5 targets (`help`, `test`, `test-static`, `test-doctor-fixtures`, `test-python`) wire to the v7 `tests/` tree; **none** invoke the v8 `node:test` suite (that's `npm test` via `package.json`). v7-only targets (`test-python`, `test-doctor-fixtures`, structural) die with `tests/`. The `test-static` format-level checks (manifest-drift, yaml-frontmatter) may still apply. Decision: trim to the surviving subset + add a `test-node` target, **or** delete the Makefile and make `npm test` / `node --test test/` the sole entry point. |

---

## Tier 3 — KEEP (v8 core + explicit survivors)

- **L1/L2/L3 core:** `commands/masterplan.md`, `commands/masterplan-contracts.md`, `workflows/execute.workflow.js`, `agents/mp-{explorer,implementer,planner,codex-reviewer}.md`
- **Per-verb `skills/` entry-point shims (RESOLVED 2026-05-29 → KEEP):** `skills/{brainstorm,clean,doctor,execute,full,import,next,retro,status,validate,verbs,stats,masterplan}/SKILL.md`. Each is a thin delegator that loads `commands/masterplan.md` with `requested_verb=<verb>` — it is the published surface that makes `/masterplan:<verb>` resolve into the v8 shell. **Not v7 prose; deleting these breaks the verb commands.** (`skills/stats` survives too: the `stats` *verb* maps to a `jq` roll-up over `events.jsonl` per `commands/masterplan.md:140` — only the v7 routing-stats *scripts* in `bin/` die.) The namespace-collision guard (`lib/hygiene.mjs`) polices this dir, e.g. the seeded `shadows-builtin`=`plan` regression — another reason it's live v8 surface. **Excludes `skills/masterplan-detect`** → Tier 1 DELETE.
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
