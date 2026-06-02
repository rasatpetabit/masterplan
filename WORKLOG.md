# WORKLOG

## 2026-06-01 — Codex review de-bloat: disable gstack `review` skill globally + harden mp-codex-reviewer

Symptom: every Codex defect/diff review (ad-hoc `codex exec` / `/codex:review` on any repo) ballooned to ~3240 lines because the model **auto-elected the third-party gstack `review` skill** and `cat`'d its **1628-line `SKILL.md`** into the trace, burying the verdict. **Root cause is NOT masterplan:** `mp-codex-reviewer` already returns a digest (the dump never reached the orchestrator) — the visible bloat came from **direct cross-repo reviews** (openxcvr-kmod / xcvr-tools / /tmp). gstack/review is **model-elected** (trace: "Using the `review` skill…"), not hook-injected, and Codex has **no skills-off flag** (`codex features list` confirms — only `skill_mcp_dependency_install`).

**Fix, two surfaces.** (1) **Global, reversible (NOT in repo, edited in `~/.codex/skills/`):** renamed `SKILL.md`→`SKILL.md.mp-disabled` in BOTH gstack review copies (`gstack/review/` + `gstack/.agents/skills/gstack-review/`) so codex can't enumerate the skill — a *dir* rename would NOT work (codex keys identity off SKILL.md presence + frontmatter `name:`). Restore script: `~/.codex/skills/.mp-review-disabled-RESTORE.sh`. `gstack/review/SKILL.md` had uncommitted user edits — **preserved** in the `.mp-disabled` copy. A `gstack upgrade` may restore it → re-run the disable. (2) **In-repo:** `agents/mp-codex-reviewer.md` invocation now tells Codex "do NOT activate/read/echo any skill" (belt-and-suspenders + saves Codex wall-time even though this agent digests).

Verified: a fresh codex rollout's injected catalog has **0** review-skill entries (**71 other gstack skills intact** — surgical); suite **503/0**; doctor exit 0.

## 2026-05-31 — PR-awareness in report verbs + finish gate; autonomy auto-progress contract (`db1b84d`)

Two asks: (1) surface an open GitHub PR for the run's branch in the "what do I do next" routines; (2) **stop the over-asking under `--autonomy=loose`/`full`**. The load-bearing finding for (2): the asking was **not** masterplan's own gates — `decideNextAction` (`lib/resume.mjs`) already stops only at real gates, `routeTask`'s `target:'ask'` is dead code, and `autonomy` is stored-but-never-read by `decide`. The real driver was the **global `~/.claude/hooks/auq-guard.sh` Stop hook** blanket-blocking every substantive turn lacking an AUQ, plus the global `~/.claude/CLAUDE.md` "AUQ mandatory" prose that *contradicted* the loose-autonomy contract in the same file. **Decision: fix the prompt contract + the hook, NOT `mp decide`** — autonomy stays out of `decide` (it isn't the thing asking; advisor-steered, accepted). PR-awareness is **report-only** (never auto-merge) and kept **out of the per-turn `decideNextAction` loop** (a per-resume "merge your PR" would be a *new* nag) — it lives only in human-invoked `status`/`next`/`clean` + the `branch_finish` gate.

Repo (`db1b84d`, masterplan-ng only — never main): `lib/finish.mjs:summarizePr` + `mp pr-summary` (pure, gh-output-in, never throws on absent/malformed gh) + `commands/masterplan.md` §3 weave-in / §2c gate relabel + §2d autonomy stop-set & `<mp-autoprogress>` emission + §4 turn-close; +7 unit tests. **Global config (NOT in repo, edited in `~/.claude/`, live immediately):** `auq-guard.sh` — Modes A (ends `?`) & B (offloading phrases) still **block**; Mode C (flat-ending) downgraded **block→warn-only**; new `<mp-autoprogress>` escape hatch (assistant-side mirror of `<no-auq>`, emitted only on authorized loose/full non-gate turns). `CLAUDE.md` "End-of-turn handoff" realigned to "AUQ at genuine decision points", resolving the internal contradiction.

Verification: suite **358/358**; `bash -n` hook OK + **5/5** synthetic-transcript tests (marker→bail, flat→warn-only bail, Mode A→block, Mode B→block, AUQ-present→bail); `mp pr-summary` smoke green (empty / one-PR / gh-absent). Fresh-eyes Explore caught + fixed a false "complete stop-set" claim and a marker-action-list omission. **Standing (USER-gated):** `db1b84d` is NOT deployed (hosts at `5040f75`) and NOT pushed (origin `cf488b4`); the dogfood→push gate now finalizes `db1b84d` — see the gitignored `docs/notes/v8-dogfood-push-runbook.md` (refreshed this turn).

## 2026-05-30 — applied review fixes (finish-flow re-entrancy + Codex-gating doc accuracy)

Resolved the five findings from the review entry below. **§2c finish flow** (`commands/masterplan.md`): (1) step 2 now re-runs the `mp finish-status` snapshot after committing task-scope dirt, so a stale `verified=true` can't skip verification on the new commit; (2) the `branch_finish` gate-resolution act gained a re-entry guard — skip the action when `worktree_disposition` is already a retirement value — and now records the disposition immediately on success, closing the compaction-after-action / before-`clear-gate` window; (3) added the `no_verification_command` resume act to the gate-resolution list (specify-a-command / proceed-without, mirroring `verification_failed`'s reviewed-override; `open-gate` overwrites the single `pending_gate` slot, so no separate clear is needed on the FAIL→`verification_failed` hand-off). **Doc accuracy:** corrected `codex.review` wording in README + `task-verification.md` + `plan-annotations.md` — the bundle field is a boolean; only `mp prepare-wave`'s payload normalizes it to the `"on"` string the L2 workflow gates on. Suite stays green (351/351); all edits prose/doc-only. Fresh-eyes Explore confirmed no contradictions/dangling refs.

## 2026-05-30 — read-only review of `9c465ff..4f62803` finish/docs reconciliation

Reviewed only the requested diff scope (finish finalization flow + docs/Codex reconciliation). Key concerns are finish-flow durability, not the broad doc sweep: the new §2c snapshot can reuse a stale `verified` decision after committing task-scope dirt, branch-finish resolution is not idempotent if compaction lands after disposition write but before `clear-gate`, and the `no_verification_command` gate lacks a defined resume act. Retro→finish sync and deleted-doc live-link cleanup looked broadly consistent; remaining doc issues are accuracy nits around Codex review gating/storage wording.

## 2026-05-30 — v8 (masterplan-ng): `finish` finalization flow + v8 docs/Codex deep-clean (Thrust A + B)

Closes the v8 "never wraps up" regression (v8 collapsed completion into a *silent* archive; v7's branch-finish gate was lost). **Thrust A — finish flow:** renamed the `retro` verb → **`finish`** (`retro` kept as a deprecated alias → `finish --retro-only`; the artifact stays `retro.md` — the doc IS a retrospective, renaming it would cascade through `lib/paths.mjs` + doctor #28 + every existing bundle for zero gain). Completion is now an umbrella flow (`commands/masterplan.md` §2c): verify+**cite** (`superpowers:verification-before-completion`, verified-at-SHA skip) → write `retro.md` if absent → open a **durable** `branch_finish` gate (merge/push+PR/keep/discard via `superpowers:finishing-a-development-branch`) → **archive LAST**. Mechanism is a durable gate — no new phase, no `resume.mjs` change: `surface_gate` outranks `complete` in `decideNextAction`, so verify+retro run **re-entrantly** and the user decision survives compaction — the exact capability v8 dropped. New pure logic in `lib/finish.mjs` (classifyDirt / detectBase / verified-SHA compare / disposition map) behind two fs-only bin verbs (`finish-status`, `record-verification`); `test/finish.test.mjs` covers the functions.

**Thrust B — docs/Codex reconciliation:** swept `README` / root `CLAUDE.md` / `docs/internals*` / `docs/verbs.md` / `docs/install.md` / `skills/masterplan/SKILL.md` to v8 reality (Node 5-layer core, `mp` subcommands, `node --test`, phase enum `brainstorm|plan|execute`, Kahn-order waves, seed-flags-persisted-to-`state.yml` config) and **deleted** 4 pure-legacy v7 docs (`commands/masterplan-contracts.md`, `docs/internals/{brainstorm-anchor,coordinator-pattern,failure-instrumentation}.md`).

**Corrections folded in this turn (verified against the code, not the prior-window prep):** §3a serial-path was the lone stale **Model-A** outlier → fixed to **Model B** (`mp-planner` is sole producer, writes *both* `plan.md`+`plan.index.json` directly — confirmed `mp-planner.md:88-89` + `plan-annotations.md`). `mp-codex-reviewer` frontmatter was *factually wrong* ("when a task is Codex-eligible") → review actually runs **per done task when `codex.review === "on"`, NOT gated by codex-eligibility** (`execute.workflow.js:158-165`: gating by eligibility would skip the riskiest inline-routed work); dropped a dangling "R2" cross-ref.

**Verification (CD-3):** suite **351/351**; `node bin/doctor.mjs` exit **0** (0 error). **Finish-flow integration smoke 12/12** (drove the real `mp` bin end-to-end: `decide→complete` → `branch_finish` gate → re-`decide` survives a simulated compaction as `surface_gate` *without archiving* → resolve → **archive LAST** with disposition+`verified_sha` preserved; plus the `verification_failed` hard-stop path) — this proves the actual regression fix the pure-function suite can't. **Review-tooling note:** the cross-vendor Codex `review` crashed **twice** at the identical spot (codex-runtime crash on the 24-file/~2888-line working-tree diff — a tooling failure, not a finding; companion has no path-scope flag to shrink the diff) → per the CLAUDE.md fallback carve-out, used a fresh-eyes Explore as the doc-half substitute (surfaced `docs/config-schema.md` + `docs/conventions/codex-failure-policy.md` v7 residue → handled in the follow-up commit). **Codex review *of* commit 2** (`--base HEAD~1 --scope branch`, the small 2-file diff) wedged a **third** time at the identical spot (it re-read `bin/masterplan.mjs` + probed the rescue path to fact-check the claims, hitting the same runtime crash) — but got far enough to validate the `.masterplan.yaml`/config claim against the code with **zero findings** before dying; its fresh-eyes-fallback completion caught **1 real ERROR** (the v8 banner cited nonexistent `--codex`/`--codex-review` *seed* flags — the real mechanism is the post-seed `mp set-codex-config --routing= --review=` verb) + **1 NOTE** (`codex.review` is a stored **boolean**, not the string `"on"`; the `=== 'on'` compare runs against the prepare-wave-normalized descriptor, not `state.yml`) → both fixed in **`acb5725`** (suite 351/351, doctor 0-err). **B3 (`parts/` physical deletion) DEFERRED** — honors the RULED-3B gate; `parts/` stays until the user-gated cutover. Push/PR/merge remain gated; `main` untouched at v7.2.3.

## 2026-05-30 — v8 (masterplan-ng): FORK ENDED — merge `9c465ff` (local base + epyc2 graft) deployed to BOTH hosts

Reconciled the two divergent v8 lines per user decision **"merge, local as base"**: `git merge --no-ff` with local HEAD `8f8be21` as first-parent (base) + GitHub/epyc2 `cf488b4` as second-parent → merge **`9c465ff`**. Both seams kept coherently: `load-plan` = canonical ATOMIC forward seam (materialize `state.tasks` + advance `phase→execute` in one write); `seed-tasks` = populate-only recovery (loads tasks, does NOT touch phase). `decideNextAction` auto-merged into complementary branches (`brainstorm|plan`+tasks:[]→`resume_phase`; `execute`+tasks:[]→throw *"Refusing to finalize an unseeded run"*); merged `set-phase` guard names BOTH recovery verbs and honors `--force` as the documented escape. schema_version harmonized at number `8` (buildSeedState == migrate; plan.index.json artifact floor stays `"6.0"`, distinct/correct). Suite `node --test test/*.test.mjs` **326/326**; fresh-eyes audit + both-edited risk-set sweep (`comm -12` intersection) + the lone epyc2-only runtime doc (`agents/mp-planner.md`, seam-agnostic schema contract) all found **no merge-introduced defect**.

**Deployed + verified BOTH hosts** (per-host directory-source marketplace `masterplan-v8`, identical path `/home/ras/.local/share/masterplan-v8`): epyc1 (local-origin git ff) + epyc2 (git-bundle-over-SSH — **no GitHub push**) both at source-clone `9c465ff` (suite 326/326); caches file-mirrored to `9c465ff` content (**322/326** — the 4 deltas are the `git check-ignore` tests that can't run in a no-`.git` cache copy, NOT a regression). `marketplace.json` `"masterplan-v8"` name override preserved via stash-ff-pop on both. **gitCommitSha labels lag** post-file-mirror (content IS current; label advances only on user `/plugin marketplace update masterplan-v8` + `/reload-plugins`). Merged code is **live next session / fresh `/reload-plugins`** — sessions already running still hold the pre-merge plugin in memory. Do NOT hand-edit `installed_plugins.json` (brick risk).

**PENDING (both gated, in order):** (1) **Fresh-session dogfood acceptance** — the SOLE behavioral verification of the orchestrator-prompt §3 seam merge (no automated test covers markdown). (2) **GitHub reconciliation push** — `origin/masterplan-ng` is still `cf488b4`; `git push origin masterplan-ng` is a clean fast-forward (`cf488b4` is an ancestor of `9c465ff`), **branch only, NEVER main** (autoUpdate-leak constraint); gated behind (1) per the standing "never push never-dogfooded code" prohibition. Until pushed, a future epyc2 `git pull` from GitHub would see local-ahead divergence. Full fork analysis + resolution in gitignored `docs/notes/v8-fork-local-vs-github.md`.

## 2026-05-30 — v8 (masterplan-ng): second-opinion review of `load-plan` materialization

Read-only review of the plan→execute materialization fix found the main seam sound: `load-plan` validates the index, writes `state.tasks` and `phase=execute` together, `decide` dispatches afterward, and re-running `load-plan` refuses to clobber an already-loaded bundle. Noted one low-risk adjacent hardening gap: `prepareWave` currently prefers `plan.index.json`'s `files` while D6 `declaredScope` uses `state.tasks[].files`, so a post-load index drift can dispatch a different scope than verification permits; fix by asserting equality or making state files authoritative in `prepareWave`. Full `node --test test/` remains sandbox-limited by nested `spawnSync` EPERM in `bin-masterplan`/`gitignore`; pure tests and direct CLI probes were used.

## 2026-05-30 — v8 (masterplan-ng): discriminated planning active_run + planning_mode seed

Added the planning-run discriminant to the resume spine so L2 parallel-planning background runs are not interpreted as execute waves: `{kind:'plan',phase:'launching'}` now recovers without requiring a wave, promoted `{kind:'plan',run_id,task_id}` waits only while live, and dead/launching planning runs return `recover_plan_run` because plan fragments are completed by the L1 plan protocol rather than disk-derived wave finalization. Seed state now carries flat `planning_mode` (`auto` default; CLI-validates `serial|parallel|auto`) so `resume_phase` can echo the mode for pre-execute plan resumption. Direct CLI smoke passed for planning seed/mode validation and plan marker promotion; full `node --test test/` remains blocked in this sandbox by existing nested `child_process` EPERM in `bin-masterplan`/`gitignore` harnesses, while pure resume/bundle tests pass.

## 2026-05-30 — v8 (masterplan-ng): index-staleness `:71` fix-text defect FIXED + reachable dogfood seam declared MINED-OUT (campaign wrap)

Last candidate of the dogfood-hardening sweep. `index-staleness.mjs:71` (the `state.plan_hash`-stale WARN) prescribed *"re-index the plan with the **plan-index command** to refresh plan_hash in **state.yml**"* — a **non-completing fix-text** (same class as the already-landed `set-worktree-disposition`/`set-codex-config` fixes): no command writes `state.plan_hash`. **Confirmed at tip, not assumed:** the `.mjs` CLI has no `plan-index`/`build-index` verb; the only thing resembling it — the legacy shell `bin/masterplan-state.sh build-index` (`:544`) — writes `plan.index.json` ONLY (`out="$bundle/plan.index.json"`, `mv tmp $out`), never `state.yml`; and nothing in v8 writes `state.plan_hash` at all (no `.mjs` writer; `migrate.mjs` drops it). So running the prescribed action could never clear the WARN.

**WL:84's dormant-gap dismissal STANDS — this is a genuinely distinct defect, not a re-litigation.** WL:84 ruled the *forced-hand-edit* framing out: "no writer sets `state.plan_hash` … an absent hash is a PASS … no transcript hand-edits it — a dormant-check gap." Correct. The new angle is orthogonal: the **fix-text** names a remedy that writes the wrong file. The `:71` branch is a LEGACY-COMPAT read (born-v8 bundles never carry `state.plan_hash`, so it's dormant on them — WL:84 still holds); a stale `state.plan_hash` can only surface on a migrated-in-place 5.x bundle.

**Fix = one-line fix-text correction (advisor-gated: verified the *fix*, not just the bug).** The remedy that actually clears it is `mp migrate-bundle` — migrate whitelist-rebuilds `state.yml` via `mapLegacyToV8` (which never carries `plan_hash`) and **DROPS** the stale key. **Proven empirically** (advisor's BLOCKING pre-condition — "watch the remedy clear the condition"): seeded a 5.0 bundle with `plan_hash: sha256:DEADBEEFstale`, ran `mp migrate-bundle` → migrated `state.yml` has **no `plan_hash` line** → WARN condition cleared. Corrected `fix:` now reads `run 'mp migrate-bundle --state=<bundle>/state.yml' to drop the stale legacy plan_hash from state.yml (v8 stamps plan_hash in plan.index.json only)` — honest that it's **dropped, not refreshed**. **(rejected) a `mp set-plan-hash` writer** — contradicts v8's deliberate design (plan_hash lives in `plan.index.json`; the sibling `:89` branch is the live check with a working `build-index` remedy, left untouched). **Honest severity:** dormant on born-v8, legacy-only — a one-line accuracy nit, **not a peer** of the reachable worktree/codex fixes.

**Own-test discipline:** added a named regression test on the existing `warn-stale-state-hash` fixture pinning the `:71` `fix:` to name `migrate-bundle` and **not** the phantom "plan-index command". **273/273** node:test (272 baseline +1); live fix-text confirmed via direct `check()`. **Files:** `lib/doctor/index-staleness.mjs` (`:71` fix-text + legacy-compat comment documenting the mechanism), `test/doctor.test.mjs` (+named test). **NOT yet committed** — commit/push to PR #12 gated to the closing AUQ; local-only `.claude-plugin/marketplace.json` override stays unstaged.

**CAMPAIGN WRAP — reachable dogfood seam MINED-OUT.** The *doctor/migrate detects a state → no `mp` writer / fix-text prescribes a non-completing action* class is exhausted: C3 (`set-worktree-disposition`), C2 (migrate core-field gate) + the schema_version=8 follow-up, `set-codex-config` (20th verb), Residual 4 (`wantsCodex` mirrors dispatch), and now this `:71` fix-text nit — all closed. R1–R4 design-residuals all resolved/ruled/fixed. Remaining candidates are sub-threshold (e.g. `state-schema.mjs:88` slug/schema_version identity-field notes — validated at creation/migration). Further mining yields diminishing returns; next substantive work is the **B1 user-interactive parity run** (HARD GATE, see 2026-05-30 cutover-scoping entry), not more bug-hunting.

**INDEPENDENTLY CONFIRMED** (fresh-eyes read-only sweep, 2026-05-30): all 10 `lib/doctor/*.mjs` checks audited against their authoritative dispatch/writer/migrate consumers → **0 divergences**. 8 AGREE, 1 DORMANT (`index-staleness` `state.plan_hash` — no v8 writer, expected), `codex-plugin-presence` AGREE post-Residual-4. Notably `scalar-cap`'s key regex is character-identical to `parseState`'s, and `state-schema` imports `validateCoreState` as SSOT (no duplication → no drift possible); the four user-scoped filesystem checks (`codex-auth`, `plugin-registry-drift`, `stale-codex-task`, `stale-lock`) read no state fields. The mined-out claim is **verified, not just asserted** — a future session need not re-run this audit.

## 2026-05-30 — v8 (masterplan-ng): Residual 4 MINED + FIXED — `wantsCodex` now mirrors dispatch (a-full); detection-layer silent-false-negative closed

Picked up the candidate-next-bug the `set-codex-config` verb fix recorded (`design-residuals.md` Residual 4): the `codex-plugin-presence` doctor's `wantsCodex` (`lib/doctor/codex-plugin-presence.mjs`) read codex config **flat-OR-nested** (`state.codex?.routing ?? state.codex_routing`), while dispatch (`bin/masterplan.mjs:381/394`) reads the **NESTED `state.codex.{routing,review}` ONLY**, defaulting routing to `'auto'`. So a bundle with a **flat** `codex_routing: off` and **no** nested block → `wantsCodex` honored the flat `off` → doctor **SKIP**, while dispatch ignored the flat key, fell through to `'auto'`, and **still routed codex** — a silent false-negative one layer up from the verb fix. **Confirmed at tip, not assumed:** verified `parseState` reads the v8-canonical nested codex as **inline-JSON flow** (`codex: {"routing":"off",…}` — `coerceValue` JSON-parses a `{`-leading value; my first block-YAML probe returned `null` because v8 doesn't write block style), that `setCodexConfig`+`serializeState` emit exactly that and round-trip, that dispatch loads via `loadForWrite`→`readState`→`parseState`, and that `migrate.mjs` does **not** translate flat→nested — so flat keys are a shape **v8 never writes** (hand-edit / legacy-read only).

**Fix = (a-full), advisor-confirmed.** Residual option (a) *as worded* ("drop the flat fallback") is **insufficient**: dropping the flat read but keeping `routing !== undefined` still SKIPs a flat-only/no-nested bundle while dispatch routes. The true "matches dispatch exactly" fix **also defaults routing to `'auto'`**: `routing = state.codex?.routing ?? 'auto'`, `review = state.codex?.review` (on = true/'on'/'true'), nested-only, flat dropped as dead input. The doctor's "wants" predicate now **is** dispatch's "would-route" predicate — closed in both directions (flat-`off` false-negative + flat-`review:on` false-positive). **(b) rejected** (flat-only → misconfig WARN): leaves the no-config case still divergent (the false-negative direction) and keeps reading a dead shape. **Over-warn footprint (named):** more bundles WARN in a plugin-**absent** env (a flat `off` no longer buys a SKIP) — *accurate* (they DO route codex); in a codex-equipped repo they PASS. Lone residue: archived bundles with no nested-off WARN though they never dispatch — an extension of the existing archived+auto false-positive class, `status`-filter mitigation deferred (out of residual scope).

**Own-test discipline:** 3 `codex-plugin-presence` fixtures migrated flat → inline-JSON nested (`skip-routing-off` → nested `off` so its SKIP is dispatch-honest, no longer the baked-in bug); added the keystone **`warn-flat-off-ignored`** fixture (flat `codex_routing: off`, no nested, no plugin) + a named regression test pinning it **WARN, never SKIP** — the exact case SKIP-under-old-code. **272/272** node:test (270 baseline +2); per-fixture severity live-confirmed via direct `check()` (skip/pass/warn/warn as intended). **Files:** `lib/doctor/codex-plugin-presence.mjs` (`wantsCodex` + header comment), `test/fixtures/doctor/codex-plugin-presence/{skip-routing-off,pass-wants-has-plugin,warn-wants-no-plugin}/…/state.yml` (→ nested) + new `warn-flat-off-ignored/`, `test/doctor.test.mjs` (+named test), `docs/design-residuals.md` (Residual 4 → FIXED + OUTCOME). **NOT yet committed** — commit/push to PR #12 gated to the closing AUQ. Local-only `.claude-plugin/marketplace.json` override stays unstaged.

## 2026-05-30 — v8 (masterplan-ng): NEXT dogfood bug MINED + FIXED — `mp set-codex-config` (20th verb) closes the codex-plugin-presence doctor's CD-7-violating *and* wrong-field fix message (user chose fix-now, inline)

Same bug class as C3 (*doctor detects a turn-codex-off-able state → no `mp` writer → remediation forces a CD-7 hand-edit*) — but **doubly** broken this time. The `codex-plugin-presence` WARN `fix:` told operators to "set codex_routing: off and codex_review: false in affected bundles": (a) **CD-7-violating** — no `mp` verb wrote codex config, so that's a raw `state.yml` hand-edit; (b) **WRONG FIELD NAMES** — the persisted shape the dispatch path reads is the NESTED `state.codex.{routing,review}` (bin:371 `state.codex?.routing ?? … 'auto'`, bin:384 `state.codex?.review`), NOT the flat `codex_routing`/`codex_review` the message named. The flat keys only silence the doctor's *own* `wantsCodex` (defensive flat-OR-nested, codex-plugin-presence.mjs:25-33) — they NEVER reach dispatch, so following the old advice leaves codex still routing while the doctor goes quiet (silent false-fix). **Fix mirrors C3, additive:** new `setCodexConfig` (bundle.mjs, merge-update so a partial `--routing`-only set preserves `review` and vice-versa) + `case 'set-codex-config'` in bin (enum-guards `routing ∈ auto|on|off` *before* the state read; normalizes `--review=true|on|false|off`/bare-`--review` to the BOOLEAN `wantsCodex`+dispatch compare against; dies on empty patch) + `VALID_CODEX_ROUTING` enum + usage-header entry; rewrote the WARN `fix:` to prescribe `mp set-codex-config --state=<bundle>/state.yml --routing=off --review=false` with the nested-shape + CD-7 pin. **`wantsCodex` left flat-OR-nested intact** — doctor fixtures rely on the flat fallback; the writer is additive, not a detection change (no doctor-count drift — "discovers all 10 check modules" unchanged; a VERB was added, not a check). **But that fallback is itself a sibling silent-false-negative** (a flat-only `codex_routing: off` makes the doctor SKIP while dispatch's nested-only read falls through to `'auto'` → codex still routes) — **RECORDED as `docs/design-residuals.md` Residual 4 (found-not-fixed, candidate next bug), NOT blessed.** **Honest label:** same-class-preventive + in-repo precedent (C3) + *observed-in-code* (the doctor's own message prescribed both the CD-7 violation AND the ineffective flat field) — **not** observed-in-wild. **270/270** node:test (268 baseline + 2: a bin CLI test pinning the on-disk nested object + merge-preserve + enum/empty-patch guards, and a doctor test asserting the WARN fix now cites the verb and no longer the flat hand-edit). **Live smoke (CD-3):** `mp seed` → `mp set-codex-config --routing=off --review=false` wrote `codex: {"routing":"off","review":false}` on disk; `mp set-codex-config --routing=auto` merge-preserved → `codex: {"routing":"auto","review":false}`.

**Files:** `lib/bundle.mjs` (+setCodexConfig), `bin/masterplan.mjs` (+case +VALID_CODEX_ROUTING enum +import +usage-header), `lib/doctor/codex-plugin-presence.mjs` (WARN fix msg); tests `test/bin-masterplan.test.mjs`, `test/doctor.test.mjs`. **NOT yet committed** — fix authorized inline; commit/push to PR #12 gated to the closing AUQ. The local-only `.claude-plugin/marketplace.json` override stays unstaged.

## 2026-05-30 — v8 (masterplan-ng): dogfood sweep C3+C2 SHIPPED + the FOUND schema_version bug FIXED (user chose fix-now) — three CD-7/data-integrity closures, committed + pushed to PR #12

One pass, two additive closures of the same class (*doctor/migrate detects bad state → no `mp` repair verb → remediation forces a CD-7 hand-edit*), each confirm-at-tip + honest-label + own node:test. **267/267** (264 baseline + 3 new), live-smoked.

**C3 — `mp set-worktree-disposition` (19th verb) + fixed the keeper's own CD-7-violating fix message.** The `worktree-integrity` doctor SKIPs a bundle whose worktree intentionally no longer resolves *iff* `worktree_disposition ∈ {removed_after_merge, kept_by_user}` — but there was **no writer** for that field, and the check's ERROR `fix:` text told the operator to set it *"in the bundle state.yml"* (i.e. hand-edit — the exact CD-7 violation the doctor exists to prevent). Added `setWorktreeDisposition` (bundle.mjs, thin like the lifecycle setters) + the `set-worktree-disposition` case with an enum guard (`active|removed_after_merge|kept_by_user`, validated *before* the state read) in bin; rewrote **both** ERROR fix messages to prescribe the verb (`mp set-worktree-disposition …` / `mp set-status …--status=archived`). **LIVE, not dying-target** (advisor BLOCKING pre-check): the keeper `lib/doctor/worktree-integrity.mjs` reads the field at :24/:70/:77 — survives the v7→v8 cutover. **Honest label:** same-class-preventive + in-repo precedent + *observed-in-code* (the keeper's own message prescribed the violation) — **not** observed-in-wild (the prior `worktree_disposition` touches were my doctor-remediation cleanup, not an end-user incident).

**C2 — narrow core-field presence gate in `migrate()` (fail-loud), NOT a full `validateCoreState` call.** A malformed 5.x bundle missing slug/status/phase used to migrate into structurally-invalid v8 state (null core fields) that `decide`/doctor flag but no `mp` verb can repair — a CD-7 hand-edit or destructive re-seed. Fix: after `mapLegacyToV8`, throw `MigrationError` (same R3/CD-7-honoring message family) if any of `slug`/`status`/`phase` is null. **Advisor walked back his own earlier "drop `validateCoreState` in and throw" suggestion** — empirically that regresses *every* migration, because `mapLegacyToV8` deliberately emits `schema_version: '6.0'` (a **string**, to preserve the decimal) and `validateCoreState` requires a number. So the gate is presence-only on the carried-over trio; the validator is deliberately not reused here. One under-specified fixture repaired (`migrate.test.mjs` `withId` gained `current_phase` so it clears the new gate; its pending_gate-id assertion is unchanged). `noId` unaffected (throws earlier, inside `extractLegacyFields`, on the missing gate id).

**FOUND (bigger than C2, surfaced not patched): `mp migrate-bundle` → `mp doctor` false-ERRORs on EVERY migrated bundle.** `migrate` emits `schema_version: "6.0"` (string); `validateCoreState` (SSOT, `bundle.test.mjs:138` deliberately pins "non-number is flagged") requires a number; `state-schema.mjs:83` runs `validateCoreState` on any bundle with `parseFloat(sv) ≥ 6` — which includes every migrated bundle. No test ever exercised migrate→doctor, so it survived. **Advisor reframed my "three contradicting invariants / B2 residual" framing as over-cooked**: it's **one bug with a code-determinable answer** (canonical type is *number* — `buildSeedState` emits `8` as a number; `state-schema`'s string-tolerance is explicitly scoped to *legacy <6 input*; `migrate`'s string `'6.0'` is the lone outlier). Fix direction is known (emit a number; verify value **6-vs-8** against `buildSeedState`; **read the `migrate.test.mjs:46-49` "wedged the dogfood" Chesterton's fence first** — the decimal-string was a past incident), but it flips a type + ~4 test assertions and warrants its own pass — **orthogonal to C2-narrow, does not block it.** Presented to the user as a **fix-now vs. queue** choice, not recorded as a residual. **OUTCOME — user chose fix-now (separate commit, kept out of the C3+C2 sweep unit per advisor).** `mapLegacyToV8` now emits `schema_version: 8` — the canonical NUMBER, matching `buildSeedState`'s `schemaVersion: 8`; the prior `'6.0'` was *doubly* wrong (string type **and** a stale schema-6-era value). Read the `migrate.test.mjs:46-49` "wedged the dogfood" fence FIRST as instructed — confirmed **orthogonal**: it guards the *detector* admitting bare integers ≥6 (the decimal-drop on write), not the migrate *target*, so untouched. The ≥6 passthrough **floor** is unchanged (forward-compat). Changes: 3 migrate-output assertions flipped `'6.0'`→`8`, a new `validateCoreState`-clean regression test (the exact `state-schema.mjs:83` dispatch), the `mp migrate-bundle` CLI assertion strengthened to pin the **on-disk NUMBER**, and the target-describing comments de-staled. **268/268.** Live smoke (CD-3): `mp migrate-bundle` writes `schema_version: 8` (bare) → the `state-schema` doctor `check()` returns `[PASS] all bundle state cores are schema-valid`, **0** schema_version ERRORs (before the fix that path wrote `"6.0"` and the check returned `ERROR: schema_version must be a number >= 6 (got "6.0")`).

**Files:** `lib/bundle.mjs` (+setWorktreeDisposition), `bin/masterplan.mjs` (+case +enum +usage), `lib/doctor/worktree-integrity.mjs` (both fix msgs), `lib/migrate.mjs` (C2 gate + schema_version→8), `docs/design-residuals.md`, `docs/masterplan/2026-05-29-v8-dogfood/cutover-removal-manifest.md`; tests `test/bin-masterplan.test.mjs`, `test/doctor.test.mjs`, `test/migrate.test.mjs`. **Committed as TWO commits per the advisor (sweep clean of the schema fix): `162f3da` (C3+C2 sweep + the 3 doc edits) + the schema_version follow-up; pushed to PR #12 (masterplan-ng → main). The local-only `.claude-plugin/marketplace.json` override was deliberately left unstaged.**

## 2026-05-30 — v8 (masterplan-ng): Residual 3 RULED — user chose 3B (full-lifecycle Codex) over the 3A recommendation; implementation gated on B1 parity + DEFERRED

Presented the Residual-3 scope ruling (3A plan-only / 3B full-lifecycle / 3C defer-to-parity) with 3A as the lean recommendation on implementation cost. **User ruled 3B** — v8 commits to Codex hosting the full lifecycle incl. `execute`. Picking 3B *over* 3C means the **product goal is decided, not deferred**; what stays parity-dependent is the **mechanism, not the commitment**: if the B1 parity run shows Codex cannot host the Workflow tool → build the foreground-sequential dispatch path (`mp prepare-wave` → sequential `mp-implementer` → `update_plan`) + an `if host.isCodex` branch at §2a + correct the `codex-host.mjs:5-6` "native budget" comment; if Codex *can* host it → §2a already works and the comment stands. **Implementation DEFERRED** (user's same-turn choice: mine the next dogfood bug next), not abandoned. Recorded: `design-residuals.md` §Residual 3 **OUTCOME** + status header (RULED 3B); **manifest Tier-4 #13** flipped from *"rule 3A or 3B"* to *"land 3B's code before `git rm` of the v7 Codex hedge"* + sequencing recap. Also corrected stale drift: `design-residuals.md` §Residual 2 was still headed **(OPEN)** despite 2A having shipped as Issue H — now marked **RESOLVED** with an OUTCOME line. Advisor done-check on the prior recording fixed a real contradiction (3A reworded from a false *"no Codex substitute"* capability claim to a *support-scope* statement, safe in both parity worlds). No code change this turn — ruling + recording only; node:test **264/264** unchanged (doc-only).

## 2026-05-30 — v8 (masterplan-ng): cutover SCOPED — release-gate red ≠ stale tooling; it's flagging an INCOMPLETE cutover (both audit failures are dying-target class — B2 reconciled to a v7-audit artifact)

PR #12 (masterplan-ng → main) can't merge clean: `ci.yml`'s release-gate (runs on `main`) is **red**. I'd mislabeled this as "v7 gate vs v8 branch mismatch" (stale tooling). **Advisor + scoping corrected it:** the gate is a *pre-tag verification gate* and it's correctly reporting that the **v8 cutover is INCOMPLETE** — the branch is hybrid-by-design (v7 surface still ships alongside v8), and `bin/masterplan-self-host-audit.sh` audits the v7 self-host contract the v8 restructure broke. Retiring the gate would *hide* the half-migrated state, not resolve it. So the real decision was never "port the CI green" — it's "should a half-completed cutover merge to main." Surfaced to the user; user chose **scope the cutover first**. No merge, no CI edit.

**Scoping outcome — the cutover is already fully planned.** `docs/masterplan/2026-05-29-v8-dogfood/cutover-removal-manifest.md` (4 tiers + sequencing) + `parity-runbook.md` cover it. It is **pure deletion + version/doc-rewrite** — all 3 spec-port-blockers (`plan-annotations`, `cd-rules`, `codex-review` dims) were **pre-ported 2026-05-29** to `docs/conventions/`, so "no analysis remains, no spec at risk." Size: **~340 files / ~16.7K lines** (21 `parts/` + 302 `tests/` + 3 `lib/*.py` + the telemetry hook + ~14 `bin/*.sh` gates + `skills/masterplan-detect/`), ~1 bulk-delete commit + reference-scrub + doc rewrites + CI cutover + merge. Coverage check: node:test (264/264) supersedes release-gates 1–8 + the dying-target audit checks; the deliberate drop is the 3 prose-discipline checks (`check_cd9`, `check_model_passthrough`, `check_taskcreate_gate`) the manifest already decided **not** to port (audit = pure self-instrumentation, Tier-1 L90).

**HARD GATE (B1): the cutover is sequenced AFTER a USER-INTERACTIVE fresh-session parity run I cannot perform.** `parity-runbook.md` Step 1 needs a fresh `claude --plugin-dir /srv/dev/masterplan/.worktrees/masterplan-ng` launch (real `masterplan:*` agents only register in the engine subprocess on a fresh session after a dev-plugin install — proven: a mid-session install does NOT register them). Until the 3 parity confirmations close, the cutover stays user-gated regardless of deletion progress.

**B2 RECONCILED — NOT a real survivor finding; it's a v7-audit artifact (dying-target class).** The release-gate fails on **two** things, not one (my earlier "single `FAIL:` line" was a grep artifact — the `GAP` line lacks the literal string `FAIL`): `CC-3-trampoline` absent, **and** `check_taskcreate_gate` `EXIT=1` (`self-host-audit.sh:1073`) on `commands/masterplan.md:87` (`recover_and_redispatch` — `TaskList`→`TaskStop`, no `codex_host_suppressed`/"Claude Code only" sentinel). I first framed B2 as a real host-portability gap that **survives the audit's deletion**. The advisor pre-check (campaign method) **overturned that** with a discriminator I can verify from the file itself: **§2a `dispatch_wave` (`:115`) launches the background Workflow with NO Codex-host guard** — and the `:87` reconcile operates on *that same* backgrounded Workflow. So `:87` is **not** specially broken; it's consistent with the whole dispatch model's host assumption. A lone "Claude Code only" annotation at `:87` would be the *only* host guard in a file whose central mechanism (the Workflow dispatch) is un-annotated — incoherent as a real fix, and pure grep-bait for `check_taskcreate_gate`, which enforces a **retired v7 invariant** (the `## TaskCreate projection layer` section it expects does not exist in v8; `lib/codex-host.mjs` scopes "Codex host" to `suppressRescue` *only*, having dropped the bespoke v7 guards). So **both** gate failures are dying-target class (same as CC-3-trampoline); the audit is Tier-1 DELETE; the incidental gate-pass buys nothing (not merging pre-cutover). The localized guard would be cargo-cult appeasement — **declined**. The one *real* residual it gestures at — "should v8 document that the L1↔L2 background-Workflow seam is a Claude-Code-execution dependency?" — is a **whole-file host-execution-model doc decision** that first needs the Codex-execution-semantics question resolved; bigger than a guard, deferred, NOT today's quick win. **No code change — finding reconciled to artifact; B2 closed as not-a-fix.**

## 2026-05-30 — v8 (masterplan-ng): B2's "real residual" RECORDED — Residual 3 (Codex wave-execution scope), the code-vs-product mismatch, NOT a code fix

The B2 entry above deferred "the one *real* residual it gestures at" — should v8 document the L1↔L2 background-Workflow seam as a Claude-Code-execution dependency — as "bigger than a guard." Tackled it. **Outcome: it cannot be *resolved* from the codebase — and that inability IS the finding.** An Explore of the v8 Codex-host model + an advisor pre-check land it as a **design residual for the user's scope ruling**, not an edit.

**The finding (in-repo facts only — no Codex-runtime claim).** Two readings of "Codex host": **(a)** a CC session *aware of* Codex (Workflow/Task tools present); **(b)** running *inside* Codex (tools remapped to apply_patch/shell/update_plan/request_user_input). The **code is written for (a)** — `lib/codex-host.mjs:5-6` dropped the v7 perf-guard *"in favor of the Workflow tool's native budget"* (presumes the Workflow tool), `commands/masterplan.md:115` §2a launches the Workflow **unconditionally, no host branch**, §0 host-detect wires only `suppressRescue`. The **product commits to (b)** — `CLAUDE.md` *"Codex can host the command,"* `skills/masterplan/SKILL.md:3` routes ALL verbs incl. `execute`, and its Codex tool-adaptation table (`:135-146`) maps every CC tool to a Codex substitute **except the Workflow tool**, the one §2a depends on. The **mismatch between (a)-code and (b)-product is the residual.** I did NOT assert whether Codex literally has a Workflow-equivalent — that's not in-repo; the **fresh-session parity run settles it empirically**.

**Why a cutover-completeness obligation, not a live defect.** Three of the four loci are Tier-3 **keepers** (`SKILL.md` table, `codex-host.mjs` comment, §2a dispatch); the gap is currently **hedged** by `parts/codex-host.md:77` (*"bounded interactive mode — not a license to execute the whole workflow inline"*) + the `parts/contracts/taskcreate-projection.md` "Claude Code only" projection — **both Tier-1 DELETE.** Cutover removes the hedge, leaving the keepers to imply unhedged that a (b)-host can run waves with no specified path. The defect **materializes at the deletion** — so it's a cutover gate, not a branch bug.

**Honest provenance (no silent switch).** My Explore verdict on the *code* was (a); the push to (b) is the *product* surface — both true, the mismatch is the point. Same B2 finding in its **third and final location**: declined-guard → dying-target → this scope residual. Recorded in `docs/design-residuals.md` **§Residual 3** (options **3A** scope Codex to **plan-only** [doc-only, *safe in both parity worlds* worded as support-scope, lean rec on implementation cost — but a genuine product-scope narrowing the user owns, NOT a cleanup] / **3B** specify Codex foreground-sequential dispatch + fix the comment [real code, gated on the parity-run fact] / **3C** defer-to-parity) + **manifest Tier-4 #13** gates the `git rm` of the hedge on the 3A/3B ruling (threaded into the sequencing recap). The parity fact does **not** pick 3A-vs-3B — it reveals *which world the decision lives in* (Codex can't host the Workflow tool → 3A-accept-plan-only vs 3B-build-the-path; Codex can → §2a already works, 3A becomes a deliberate not-forced narrowing). The `codex-host.mjs:5-6` comment-fix is a **follow-up gated on the ruling** (3A→stands, 3B→correct it), deliberately NOT made now. **No code change — doc residual + cutover gate only; node:test 264/264 unchanged (doc-only).**

## 2026-05-30 — v8 (masterplan-ng): Issue H SHIPPED — 2A: close the sub-5.0 post-`migrate-bundle`-refusal vacuum (no floor change)

Shipped **2A** (user approved the pivot off 2B — see census entry below). The phase-37 CD-7 violation root cause was a **documented vacuum**: `mp migrate-bundle` refuses pre-5.0 loudly, but (a) the refusal `GUIDANCE` never said "don't raw-rewrite," and (b) spec §2 step-2 handled only the `migrated:true` branch and was **silent on refusal** — so the operator improvised a raw `state.yml` rebuild. Two additive edits close it, schema-agnostically for all ~85 sub-5.0 bundles:
- **`lib/migrate.mjs:26` `GUIDANCE`** — now leads with *"Do NOT hand-rewrite state.yml to schema 6 (CD-7 violation)"* + names the seed-fresh path (`mp seed` a FRESH bundle → re-run brainstorm→plan→seed-tasks). Fires at the point of friction (the refusal itself).
- **`commands/masterplan.md:55` §2 step-2** — added the **refusal branch**: on refuse, do NOT raw-rewrite (CD-7); treat legacy as read-only, `mp seed` fresh or finish under v7 or stop+ask.

**Honest label: observed-in-wild VACUUM — an off-spec CHOICE in a deliberately-unsupported path, NOT an A–G-class missing-writer-*forced* hand-edit (the phase-37 raw-rebuild is the wild evidence *of the vacuum*); + same-class-preventive** (the 8 in-progress sub-5.0 bundles are the at-risk population this guidance now protects).

**Verified — including the OPERATOR surface, not just the lib (advisor done-check catch):** the operator never calls `migrate()` directly; they hit `mp migrate-bundle`, whose throw→`die(e.message)` wrapper (bin :320-322) must carry the guidance intact. (1) **CLI live smoke** — `node bin/masterplan.mjs migrate-bundle` on a `/tmp` copy of the real phase-37 `state.yml.v3.bak` (schema-3) exits **2** and prints the full *"Do NOT hand-rewrite…CD-7…mp seed a FRESH…"* guidance to stderr; the copy stayed **byte-identical** (refused before the :325-327 backup/write). (2) **lib live smoke** — synthetic schema-3 + the v3.bak both throw `MigrationError` with the new message, all 3 content assertions true. (3) **Locked both surfaces in tests:** `migrate.test.mjs` #139 pins the lib message; **new `bin-masterplan.test.mjs` "ISSUE H"** pins the *wire* contract (status 2 + the 3 guidance fragments on stderr + original untouched) so a future bin change can't silently swallow the CD-7 prohibition. **Full suite now 264/264 pass.** **Anti-pattern #4 sync:** refusal guidance now lives in **2 spec locations** (§2 step-2 canonical + the `import` verb row, which cross-references §2 step-2 rather than duplicating) **+ 1 lib location** (`GUIDANCE`), all consistent. **No floor change, no test inversion, no fixture surgery, no `decide`-layer change.** (Awareness, non-blocking: `GUIDANCE` is also appended to the 3 *within-floor* 5.x fail-loud throws — `migrate.mjs` :134/:154/:171 — so a malformed-5.x operator also gets "seed a fresh schema-6 bundle"; heavier than strictly needed for a mid-migrate 5.x failure but still safe + correct advice, additive only.)

## 2026-05-30 — v8 (masterplan-ng): Residual 2 (sub-5.0 floor) — full census reconciles the user's 2B ruling back to 2A

User ruled **2B** (lower the migrate floor) on the AUQ's "clean 3.x→6 transform" framing. Before implementing, ran a full sub-5.0 census across every masterplan tree (`/srv/dev` + `/home/ras`, 4 grep sweeps) — and it reverses the case **for** 2B into a case **against** it. Recorded in `docs/design-residuals.md` §CENSUS UPDATE. Key facts:
- **~85 sub-5.0 bundles** (schema **2 AND 3**); **8 in-progress** (4× `yanos-os`, 3× `petabit-portals`, 1× `taxes-agent`) — so the phase-37 raw-rebuild/CD-7-violation harm is **live and recurring**, not a one-off. That justifies *acting*, but not *2B specifically*.
- **None of the 8 in-progress carry `plan.index.json`.** So 2B can never make any of them resumable — it salvages a header, then Issue G throws, then tasks are reconstructed by hand from `plan.md` anyway. **2B degrades to 2A's exact outcome** for every live case.
- **phase is a free-text zoo** (`blocked/executing/brainstorming/planning/execution/complete`), inconsistent even within a schema version — a faithful map is a fragile per-value guess; this *is* the divergence the R3 floor exists to refuse. And schema-2 (5 of 8 in-progress) isn't even covered by a "lower-to-3" floor.

**Net: 2A** (schema-agnostic prose-wire + optional doctor nudge protects all ~85 bundles & all 8 in-progress immediately, no floor reversal, no fragile migrator). I retrieved data that reconciles against the 2B ruling, so per the no-silent-switch rule I'm **re-surfacing the go/no-go** rather than building a migrator that can't deliver. **No code change this turn — census + decision memo only.**

## 2026-05-30 — v8 (masterplan-ng): dogfood mining — the yanos FULL-LIFECYCLE run is DRY too; supported-path hand-edit axis is mined out (Issues A–G complete)

Followed up the dry `commercial-license-lock` well (which only reached dispatch-wave-0) by mining the one transcript in the population that actually ran **execute → recovery → completion → archival**: the yanos `phase-37-hardware-bringup-v1` run (`…/-srv-dev-yanos-project/1774c598-….jsonl`, 4.8M; a multi-task session also carrying yanos-docs-llm-refactor + RAUC-signing work). A Sonnet pass over **every** raw `state.yml`/`events.jsonl` mutation, cross-checked by three of my own bounded greps (Write/Edit tool-calls, Bash mutation verbs, `mp`-verb tally). **Result: the supported lifecycle is DRY.** Every execute/recover/finalize/archive transition went through an `mp` writer; the only Bash touching state files was a read-loop, a `cp` backup, and a `git add` — **zero** `sed -i`/`printf >>`/`tee` mutations, and **`events.jsonl` was never hand-edited once** in a run that genuinely executed, recovered, and completed. (The "mutation-verb + state-file" grep hits were all inside the transcript's own embedded compaction-summary prose, not tool calls.)

**The only observed raw `state.yml` edits are sub-5.0 MIGRATION-path, and they are NOT the Issue A–G class.** The phase-37 bundle was schema-3; `mp migrate-bundle` deliberately **refuses pre-5.0 loudly** (`migrate.mjs` L198–207 throws; header L10 "pre-5.0 is REFUSED loudly (R3)"; "caller has preserved the original"). The operator then raw-`Write`-rebuilt `state.yml` (L264/274) to schema-6. **Discriminator (advisor-confirmed) — the "forced" test:** the campaign class is a hand-rewrite *forced by a missing writer in a SUPPORTED path*. Spec §2 step-2 wires `migrate-bundle` for the **`migrated:true`** path **only** and says **nothing** about the refusal case (read `commands/masterplan.md` L52–67). So on a sub-5.0 bundle the designed behavior is *refuse + preserve + human decides*; the raw rebuild was an **off-spec CHOICE in a deliberately-unsupported path**, not a missing-writer-forced hand-edit. The pending_gate raw Edit (~L293) reduces to a thin prose gap — `mp open-gate` exists and writes the correct OBJECT form at tip (Issue B fixed the validator). **No code change this turn — finding only.**

**Axis conclusion (two dry wells = a SUCCESS signal, not a failure to find Issue H).** Across both transcripts that exercised real lifecycle, Issues A–G demonstrably closed every forced-hand-edit gap in the **supported** path. Two residuals remain, neither the A–G class — written up for user ruling in **`docs/design-residuals.md`**: (1) **events auto-emit — CLOSED on re-verification.** The prior entry below claiming "the spec wires zero `mp event` emission" was **wrong** (the grep missed the L143 verb-row): at tip the spec pairs `set-phase` with `mp event --type=phase_transition` AND has a catch-all "log other lifecycle milestones with `mp event`"; `mp event` always existed; resume never reads `events.jsonl` (only `stats` does) so a missing event is audit-only, never data-loss; the full-lifecycle run never raw-appended. The only sliver is Issue E's deliberate auto-emit-vs-discretionary choice for non-phase writers — recommend KEEP. (2) **sub-5.0 post-`migrate-bundle`-refusal vacuum — OPEN.** Spec §2 step-2 handles `migrated:true` only and is silent on the refusal case, so the phase-37 schema-3 run raw-`Write`-rebuilt `state.yml` (off-spec choice, not a missing-writer-forced edit; the 5.0 floor is deliberate R3). Recommend **2A**: keep the floor + wire post-refusal guidance ("don't raw-rebuild; `mp seed` a fresh bundle or stop") — non-reversing, shippable as a small real Issue H if approved. A third transcript can't move this: the awk population table shows 1774c598 is the *only* full-lifecycle run (the 12–13M yanos-builder files are masterplan-*development* transcripts, mark/wave/recov=0; the rest are plan-stage). The forced-missing-writer seam is mined out.

## 2026-05-30 — v8 (masterplan-ng): dogfood mining — the `commercial-license-lock` hand-edit well is DRY (Issues A–G complete); events.jsonl wiring observed but deferred

Mined the live openxcvr `commercial-license-lock` run (`…/13bb875d-….jsonl`, 2.2M) for the next CD-7 forced-hand-edit, the way Issues A/E/F were found. **Result: dry.** A Sonnet pass over **every** raw `state.yml`/`events.jsonl` mutation found 8 hand-edits and **all 8 now map to a writer added by Issues A–G**: bundle seed→`seed` (A); 42-task `state.tasks` seed→`seed-tasks` (F); `phase` brainstorm→plan→`set-phase` (E); 4 lifecycle events (`spec_written`/`phase_transition`/`plan_written`+`gate_opened`/`gate_cleared`)→`event` (A). No uncovered **missing-writer** gap remains in this transcript.

**`plan_hash` ruled out (not in the campaign class):** no writer sets `state.plan_hash` and `index-staleness.mjs` reads it — but the spec never asks to record it, an absent hash is a **PASS** (not a failure), and **no transcript hand-edits it**. That's a dormant-check gap, not a CD-7 forced hand-edit.

**Events-wiring observation (real, but NOT shipped as Issue H — advisor-gated):** [**CORRECTED 2026-05-30 — see the top entry + `docs/design-residuals.md`: the "wires zero events" claim below is WRONG; the grep missed the L143 verb-row, which DOES pair `set-phase` with `mp event --type=phase_transition` + a milestone catch-all. Residual 1 is effectively closed.**] the spec wires **zero** `mp event` emission (grep of `commands/masterplan.md`: only the CD-7 prohibition L10 + the `stats` note L150); `open/clear-gate`/`set-phase`/`set-status`/`mark-task`/`set-active-run` don't emit a companion event (Issue E's deliberate "no auto-event; the shell pairs `mp event`"). The **old-cached-v8** run therefore raw-`printf >>`'d events.jsonl 4× (L253/341/892/925). **Why deferred, not a unilateral fix:** (1) not a missing writer — `mp event` exists & always has; (2) audit/`stats`-integrity, **not** data-loss (v8 resume is disk-derived from `state.yml`, never event-replay — a dropped event can't cause a wrong resume); (3) the obvious atomic fix **reverses** Issue E's no-auto-event decision → a user call; (4) at tip it's an *inference* (CD-7 L10 + `mp event`'s existence already imply the right behavior), not an observation, and a prose-only spec-wire has no live-smoke template. Flagged for the user.

**Why the well is dry — scope, not completeness:** the run only went brainstorm→plan→**dispatch-wave-0** (last event L925 = `gate_cleared` → dispatch wave 0). It never executed a wave / recovered from a crash / completed-archived, so `mark-task`-during-execute, `set-active-run`/`promote`/`clear`, `verify-scope`, `set-status archived` were **never exercised in the wild here** — their writers exist but are unproven-in-wild in this transcript. A genuine **new** observed-in-wild hand-edit would live in a transcript that ran full execute→completion (yanos: 14+ masterplan-referencing transcripts; the richest is the yanos-builder worktree set). **No code change this turn** — finding only.

## 2026-05-29 — v8 (masterplan-ng): dogfood bug-fix — Issue G: `phase:execute` + `tasks:[]` silently finalized (the execute-phase backstop Issue C skipped)

Sixth bug from the same openxcvr `commercial-license-lock` campaign — the **defensive completion of the Issue C / Issue F empty-tasks family**. Issue C diverts `phase∈{brainstorm,plan} && tasks==[]` to `resume_phase`; Issue F added the `seed-tasks` writer so the fresh-plan path populates `state.tasks` at the source. **Neither closed the gap for `phase==execute && tasks==[]`:** `decideNextAction`'s `pending.length===0` branch fell through to `{action:'complete'}` — silently **archiving a run whose plan was never seeded into the bundle** (the plan's work abandoned as "done"). `decide` can't read `plan.index.json` from the resume layer, so it can't tell "unseeded" from "genuinely empty"; both are degenerate and must not auto-finalize.

**Fix — defense in depth, two guards (advisor-recommended), both purely additive:** (1) **write-side prevention** in `bin` `case 'set-phase'`: entering `execute` with 0 tasks is **refused** (`die`, rc 1) pointing at `mp seed-tasks`, `--force` to advance the pointer anyway (mirror of the `seed-tasks` clobber guard) — stops the bad state at the violation point. (2) **read-side backstop** in `decideNextAction`: `phase==='execute' && tasks.length===0` **throws** (mirror of the function's existing non-integer-wave throws; the `decide` caller already wraps → clean `die`, not a stack trace) — the universal catch for bundles already in execute+empty by hand-edit / migration / `--force`. Crucially `--force` on guard 1 does **NOT** suppress guard 2: forcing the phase pointer is allowed; silently finalizing an unseeded run is never allowed.

**Why throw, not a soft `resume_phase` like the brainstorm/plan sibling:** that sibling is a *normal, resumable* mid-design state; execute+empty is **impossible under correct operation** (§3 runs `seed-tasks` BEFORE `set-phase execute`) — i.e. corruption, which gets the same treatment as the other impossible states this function already throws on. The soft *diversion* still covers only brainstorm/plan; execute gets the throw.

**Honest label: same-class preventive (NOT observed-in-wild).** The openxcvr operator hand-populated `state.tasks` *before* `set-phase execute`, so the wild run never reached this path; the harm was reproduced **synthetically** (live smoke below). This is the backstop that makes the §3 ordering invariant *guard-enforced* (fails loud) instead of silently corrupting if ever violated. (Follow-up, not built now: a genuinely-empty plan is a planner failure — `seed-tasks`/`mp-planner` should refuse a 0-task plan upstream; tracked as a future bug, out of scope here.)

Synced (anti-pattern #4, internal `mp` surface — NOT a verb): `lib/resume.mjs` (the throw + the "Throws if…" header doc) · `bin/masterplan.mjs` (`set-phase` guard + usage-header `--force`/0-task note) · `commands/masterplan.md` (§2 step-4 "decide exits non-zero" note now also covers the execute+empty throw · §3 ordering parenthetical rewritten: load-bearing **and now guard-enforced**). Suite: `node --test test/*.test.mjs` → **263 pass / 0 fail** (was 261; +1 `resume.test.mjs` throw case, +1 `bin-masterplan.test.mjs` full-loop integration). Live smoke (real CLI): seed→`set-phase plan`; `set-phase execute` → **refused rc 1**, phase stays `plan`; `set-phase execute --force` → rc 0, phase `execute`; `decide` → **throws rc 2** ("phase is 'execute' but state.tasks is empty"), NOT `complete`; `seed-tasks` → same bundle now `decide` → `dispatch_wave` wave 0.

**Live-run caveat (unchanged):** epyc2's OLD cached v8 lacks this; don't bare-resume the openxcvr bundle pre-propagation.

## 2026-05-29 — v8 (masterplan-ng): dogfood bug-fix — Issue F: no `mp` writer loads `state.tasks` from `plan.index.json` (fresh-plan path)

Fifth bug from the same openxcvr `commercial-license-lock` transcript scan — same CD-7 hand-edit class as Issues A/E. **The fresh-plan path had no writer to move the plan into the bundle.** `buildSeedState` emits `tasks: []` (a brainstorm bundle has none yet); `applyPlanIndex`/`backfill-waves` only **annotate** tasks already in `state.tasks` (the migrate contract — map over `state.tasks`, skip plan tasks absent from it); `seed`/`mark-task`/`set-phase` never create tasks. So after the planner wrote `plan.index.json`, **nothing populated `state.tasks`** — and CD-7 (bin is sole writer) forced the orchestrator to hand-rewrite `state.yml`. Observed-in-wild: the live transcript hand-seeds `state.tasks` with a Python `json.load(plan.index)` 42-task build (L397/L570/L809) across 5 raw `state.yml` writes — a CD-7 violation **and** a diff-flood.

**This is the ROOT of the same empty-tasks hazard Issue C patched DEFENSIVELY at the decide layer.** Issue C diverts `phase∈{brainstorm,plan} && tasks==[]` to `resume_phase`; it does **not** cover `phase==execute && tasks==[]` — there `decide` finalizes an *empty* run. Harm reproduced live: `mp set-phase --phase=execute` on a seeded-but-unpopulated bundle, then `decide` → `{"action":"complete"}` (silent archive of a run that never ran). `seed-tasks` populates the tasks so the guards never fire **and** closes that execute+empty silent-completion window — at the source, not defensively.

**Fix (purely additive — matches the Issue A/E pattern: add the missing writer):** new `mp seed-tasks --state=PATH --plan-index=PATH [--force]` backed by a pure `buildTasksFromPlanIndex(planIndex)` in `lib/bundle.mjs`. Each task is the **minimal shell-owned shape** `{id, status:'pending', wave, files}` — exactly what the live hand-seed produced and what `decideNextAction`/`prepareWave`/`declaredScope` consume; the rich routing fields (`description`/`verify_commands`/`codex`/`sensitive`/`conversational`) are **not** copied — `prepareWave` reads those from `plan.index.json` at dispatch (`wave.mjs`: "state owns {id,wave,status,files}; plan.index owns the routing fields"), so duplicating them would be two sources of truth. Three correctness landmines (advisor-flagged, all verified against source): **id** is coerced numeric-string→Number by the SAME rule as bin's `coerceId` so `mark-task`'s `task.id === coerceId(--id)` match holds, and a missing/empty id **fails loud** (an unaddressable task); **wave** is passed through RAW (`p.wave ?? p.parallel_group`, mirror of `applyPlanIndex`) — **never `Number()`-coerced**, because `Number(null) === 0` would silently bucket a wave-less task into wave 0; reuses `backfill-waves`' integer-wave **stuck-guard** (fail loud before writing) and refuses to clobber a non-empty task list without `--force` (mid-run safety, mirror of `seed`). **Ordering invariant** wired into §3: `seed-tasks` MUST precede `set-phase --phase=execute` (else a `decide` in the gap finalizes empty).

**Honest label: observed-in-wild.** The hand-seed is in the transcript (L397/L570/L809). Distinct from Issue A — A's `mp seed` writes an *empty* `tasks` array; nothing populated it post-plan until now.

Synced (anti-pattern #4, internal `mp` surface — NOT a verb, so no verb-table/README/doctor-brief change): `bin/masterplan.mjs` usage header + import + 1 case · `lib/bundle.mjs` `buildTasksFromPlanIndex` · `commands/masterplan.md` §3 spine (the `seed-tasks` step + the load-bearing ordering note) · `agents/mp-planner.md` (added `buildTasksFromPlanIndex` to the plan.index-consumer list + `seed-tasks` to trap #3's integer-wave-guard sites). Suite: `node --test test/*.test.mjs` → **261 pass / 0 fail** (was 254; +3 pure `buildTasksFromPlanIndex` cases incl. the real 42-task shape, +4 integration cases). Live smoke: seed→`set-phase plan`→write a 3-task `plan.index.json`→`mp seed-tasks` → `{"seeded_tasks":3,"waves":[0,1]}`, `state.tasks` minimal 4-field (no routing-field leak), `set-phase execute`→`decide` → `dispatch_wave` wave 0 (vs `complete` pre-fix).

**Live-run caveat (unchanged):** epyc2's OLD cached v8 lacks this; real acceptance is a fresh dogfood that calls `mp seed-tasks` after the plan instead of hand-rewriting `state.yml`. Don't bare-resume the openxcvr bundle pre-propagation.

## 2026-05-29 — v8 (masterplan-ng): dogfood bug-fix — Issue E: no `mp` writer for the `phase`/`status` fields

Added `mp set-phase` and `mp set-status` to stop hand-editing `state.yml` for lifecycle transitions in masterplan-ng: phase/status now have enum-validated writers at the bin boundary, wired through `bin/masterplan.mjs`, `lib/bundle.mjs`, `commands/masterplan.md`, and tests. The decision was to cover both the observed v8 hand-edit for `phase` and the inferred archival gap for `status`, because `validateCoreState` only presence-checks those fields and bad values would break discover/resume behavior.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): dogfood bug-fix — Issue C: `decide` archived mid-design (pre-execute) runs

Fixed `decideNextAction` in `lib/resume.mjs` so zero-pending bundles no longer auto-archive mid-design runs: `brainstorm`/`plan` with `tasks:[]` now return `{action:'resume_phase', phase}` instead of `complete`, while true finished work still completes. Synced the action table/docs and tests (`test/resume.test.mjs`, `test/bin-masterplan.test.mjs`), with `node --test test/` passing 253/0 and live `mp decide` on the openxcvr `plan` bundle confirming the new behavior.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): dogfood bug-fix — `mp seed`/`mp event` (anti-flood) + `pending_gate` validator

Fixed two v8 `masterplan-ng` dogfood bugs from the live openxcvr `commercial-license-lock` run: added `mp seed`/`mp event` so bundle state writes no longer raw-`Write` `state.yml`/`events.jsonl`, and relaxed `validateCoreState` so `pending_gate` accepts the v8 object form `{id, opened_at}` instead of falsely rejecting gated bundles. Suite is green (`node --test test/` 249/0), but commit and epyc2 re-propagation were left gated.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): removed ALL per-verb skill dirs + terse-narration directive (pre-cutover hygiene)

v8 masterplan-ng removed all 12 per-verb `/masterplan:<verb>` skill dirs because bare `/masterplan <verb>` dispatch already covers them and the dirs only duplicated dead v5 `parts/` routing while shadowing built-ins like `/plan`, `/status`, and `/doctor`; hygiene was tightened so only `skills/masterplan/` and `skills/masterplan-detect/` remain, with tests still green (`239/0`). It also added a terse narration rule in `commands/masterplan.md` to cap post-wave commit output at 1-2 lines and avoid echoing `state.yml` or `WORKLOG.md` diffs, with cutover still gated and not pushed.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): pre-ported the 3 DEFERRED-SPEC slices → `docs/conventions/` (additive; cutover still NOT started)

Pre-ported the three DEFERRED-SPEC slices into additive canonical homes under `docs/conventions/` (`cd-rules.md`, `plan-annotations.md`, `codex-review-dimensions.md`) and added minimal cross-refs in `docs/internals.md` and `agents/mp-planner.md`, so the later v7→v8 cutover can be pure deletion/version rewrite with `parts/contracts/` untouched. Verified the port was byte-identical where required and that the manifest now marks the slices PRE-PORTED; not pushed yet.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): closed the last 2 Tier-2 items in the removal-manifest (cutover now fully mechanical)

Closed the last two Tier-2 rows in `cutover-removal-manifest.md`, making the v8 cutover fully mechanical with no deletions started yet. Key decision: `parts/contracts/` split into DEAD/REPRESENTED/DEFERRED-SPEC, and the prior “`cd-rules.md` is dead” call was corrected because live v8 code still cites `CD-N` IDs, so `cd-rules.md` becomes a mandatory pre-delete port before `Makefile` trim and the remaining Tier-4 actions.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): cutover removal-manifest drafted (planning doc, no deletions)

Drafted `docs/masterplan/2026-05-29-v8-dogfood/cutover-removal-manifest.md` as the third cutover-gate doc, mapping v7→v8 deletions/keeps against the plan’s Survives/Dies/Transforms table and noting the cutover is still blocked on user-gated parity run plus doc rewrites. A read-only subagent corrected the earlier Tier-2 mistake: per-verb `skills/<verb>/SKILL.md` are v8 entry-point delegates and must stay, while `skills/masterplan-detect` and `parts/import.md` are the real deletions; `parts/contracts/` and `Makefile` still need transform work because they target the old `tests/` tree.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): publish-hygiene scrub of WORKLOG + CHANGELOG, then first push

Scrubbed WORKLOG.md and CHANGELOG.md with `scanForRealIdentifiers()` to match the `test/fixtures/` hygiene standard, replacing 24 real identifiers with synthetic forms so both files now scan at 0 hits; kept `rasatpetabit-masterplan` and `rasatpetabit/masterplan` intact because the deny regex is word-boundary limited. Verified `node --test test/*.test.mjs` passed 232/0/0 and pushed `masterplan-ng` to origin with `git push -u origin masterplan-ng`, leaving `main` at v7.2.3.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): Step 6 published-guards — release-hygiene + publish-safety as CI tests (Phase 4, execution complete)

Built `lib/hygiene.mjs` plus `test/publish-hygiene.test.mjs` to turn release-hygiene, version-sync, and namespace-collision checks into CI invariants under `node --test test/*.test.mjs`; the key decision was to keep them in `test/` and `lib/hygiene.mjs` instead of L4 doctor modules because release hygiene belongs in CI/pre-commit and doctor auto-discovery/counting would be broken.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): CUTOVER sanitization of legacy-bundle fixtures (Phase 3 of the published-guard track)

Sanitized the three committed `test/fixtures/legacy-bundles/` run-bundle fixtures in place, preserving their structural realism for `migrate.mjs` coverage while replacing real slugs, SHAs, and `/home/<user>/` paths with synthetic values; updated `migrate.test.mjs`, `bin-masterplan.test.mjs`, `lib/migrate.mjs:12`, and `resume.test.mjs:120` accordingly. Kept assertions unchanged, verified `node --test test/` still passes 214/0/0, and left Phase 4 published-guards (`release-hygiene`, `fixture-hygiene`) plus the index-staleness hash check for next.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): resolved the 2 Codex doctor DECISIONS (#1 registry SHA-drift, #4 orphan state.yml)

Closed two Codex doctor DECISIONs in `masterplan-ng`: downgraded orphan `docs/masterplan/<slug>/` without `state.yml` from ERROR to WARN with a `warn-orphan-no-state/` fixture, and added injectable `opts.gitExec` SHA-drift detection against marketplace clone `HEAD` when versions match. Chose inline edits over Workflow because both were design-heavy but bounded, and verified clean results with `node --test test/` at 214 pass / 0 fail plus live `bin/doctor.mjs` PASS on this host.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): resolved 6 Codex doctor BUG findings via Workflow fan-out (#2,#3,#5,#6,#7,#8)

Resolved 6 Codex doctor BUG findings in `masterplan-ng` via Workflow fan-out: one owner per disjoint file group, with `test/doctor.test.mjs` handled singly for the shared-write cases, then a single post-barrier verify. Key fixes were stale index/state checks, path containment before reads, legacy-bundle WARN gating, scoped `.gitignore` re-ignores, `ENOENT` vs parse-error handling for `codex-auth`, and stronger `doctor.test.mjs` assertions; `node --test test/` passed 207/0/0, but the commit was not pushed due to the `test/fixtures/legacy-bundles/` cutover gate.

<!-- wc:condensed -->

## 2026-05-29 — v8 (masterplan-ng): Codex defect review of L4 doctor layer (first independent-engine pass)

Codex’s first independent review of the full L4 doctor layer at `8ffc9e7` found 8 verified issues, including two reproduced false-negatives in `plugin-registry-drift` and `index-staleness`, plus narrower hardening gaps in `scalar-cap`, `state-schema`, `legacy-bundle`, `.gitignore`, `codex-auth`, and `test/doctor.test.mjs`. The key decision was to treat several as intentional or low-risk but real gaps, because the Claude→Claude review chain had missed them and slice coverage needed a Codex pass at the doctor layer, not just the core.

<!-- wc:condensed -->

## 2026-05-28 — v8 (masterplan-ng): step 5 (doctor L4) COMPLETE — all 10 checks, full suite 197/197 green

Completed the remaining 7 `doctor` checks in `masterplan-ng` and hardened `test/doctor.test.mjs` plus fixtures, then fixed a critical `.gitignore` hole that was hiding 12 host-path fixture files and added assertions to prevent empty-finding regressions. The load-bearing decision was quote-normalizing `schema_version` in `state-schema`/`legacy-bundle` so existing v7 bundles are classified as legacy correctly, keeping `node bin/doctor.mjs` at 10 checks, 0 errors, with only real warnings.

<!-- wc:condensed -->

## 2026-05-28 — v8 (masterplan-ng): step 5 (doctor L4) STARTED — dispatcher + first 3-module slice (suite 146/146)

Ported the L4 doctor dispatcher in `bin/doctor.mjs` and a 3-module slice (`scalar-cap`, `worktree-integrity`, `codex-auth`) to a synchronous `check(repoRoot, opts) -> Finding[]` contract with crash-isolated discovery, first-class `SKIP`, and nonzero exit only on `ERROR` because the singular-severity model was too lossy. Split fixtures into a new v8 `test/fixtures/doctor/<check>/<scenario>/` layout, left the v7 YAML harness to die, and verified 146/146 plus a real-worktree run that exposed a genuine `concurrency-guards` WARN without false-positives.

<!-- wc:condensed -->

## 2026-05-28 — v8 (masterplan-ng): R2b (codex watcher-harness) RESOLVED by construction — analysis turn, no code

R2b “codex watcher-harness” was resolved by construction: v8’s harness-tracked `masterplan:mp-codex-reviewer` path already eliminates orphaning, bounds hangs with `timeout -k 10 540 codex exec`, and avoids the shared `~/.local/share/icm/memories.db` lock, so adding a detached watcher would be regressive. The only residual is a cross-project drift in `~/.claude/bin/codex-scan.sh` versus `yanos-project/scripts/codex-scan.sh`, but it was flagged out of scope; no code changed and the suite stayed 124/124.

<!-- wc:condensed -->

## 2026-05-28 — v8 (masterplan-ng): the two parked design forks resolved (A/A) — decision turn, comments only

Resolved both parked design forks in `masterplan-ng`: keep `mp-implementer` inline-only with no `codex-implementer`, and keep review topology single-pass per task, not per-wave or two-stage. This preserves the v8 priorities of durable on-disk state and token efficiency while avoiding the write-path/sandbox hardening regressions and extra Codex calls; suite remains 124/124 green.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 4 COMPLETE — L2 engine + the L1↔L2 seam (suite 124/124)

masterplan-ng step 4 completed: `workflows/execute.workflow.js` was converted to a one-wave L1-driven Workflow script with L1 pre-resolving routing via `mp prepare-wave`, using `pipeline(tasks, implement, review)` and the new L1↔L2 seam in `commands/masterplan.md` §2a; this keeps crash recovery unambiguous and preserves task/state replayability. Added pure `lib/wave.mjs`, `test/wave.test.mjs` (13 tests, suite 124/124), and a `prepare-wave` `review:'on'|'off'` flag, while deferring per-agent telemetry validation and dogfood-only live workflow verification.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 3 COMPLETE — dedicated agents/*.md fleshed out

Step 3 completed by turning the four plugin-root `agents/*.md` stubs into production configs, with `mp-planner` as the sole authoritative `plan.index.json` spec kept byte-synced to `lib/routing.mjs` and `applyPlanIndex`, while `mp-explorer` stayed read-only and `mp-implementer`/`mp-codex-reviewer` got fixed return/timeout contracts to avoid silent routing and harness failures. Added `test/agents.test.mjs` to lint agent frontmatter and remove leftover TODOs, bringing the suite to 111/111 without touching `main`.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 2 COMPLETE — thin shell commands/masterplan.md

Step 2 in `masterplan-ng` is complete: `commands/masterplan.md` was reduced to a thin shell that only sequences boot banner, host-detect/suppress, verb parse, resume controller, and turn-close AUQ, while deleting the CC-3 trampoline, JWT boot block, and `parts/*.md` lazy-loading in favor of `bin`, `agents/`, `L2`, and `superpowers` skills. The key decision was to keep prose out of control flow and let `mp decide` return `surface_gate`/`wait`/`finalize_run`/`recover_and_redispatch`/`dispatch_wave`/`complete`, validated by a fresh-eyes review and a hand-made-bundle drill; `main` stayed untouched.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 2 deterministic core — resume lifecycle + bin adapter, suite 96/96

Step 2 of `masterplan-ng` landed with a thin markdown shell architecture locked in: `commands/masterplan.md` will route to pure lib via the fs-only `bin/masterplan.mjs` adapter, not inline `node -e` or embedded prose logic. `resume.mjs` was hardened for the two-phase `active_run` lifecycle and the new adapter adds fs-only subcommands plus migration/backfill guards; tests now pass 96/96 and `main` remains untouched (`0b7d045`).

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 1 COMPLETE — migrate.mjs (legacy read-compat), suite 77/77

Step 1 of masterplan-ng is complete: `migrate.mjs` now uses a targeted zero-dep legacy-bundle reader for pre-v8 bundles, with fail-loud handling for pre-5.0 and `pending_gate` block-form ambiguity fixed in `parseGate`; the key decision was to avoid full YAML parsing because only ~7 flat fields are needed and the nested 5.x blobs are intentionally skipped. Suite is 80/80, fixtures were moved to `test/fixtures/legacy-bundles/`, and next is step 2 wiring `commands/masterplan.md` plus the resumable shell/controller modules.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 1 lib modules (resume, paths, bundle) — TDD, green

Built the first four masterplan-ng L1 pure modules with TDD and full node:test green: `resume.mjs`, `paths.mjs`, `bundle.mjs`, `routing.mjs`, and `codex-host.mjs`, while leaving `main` untouched. Key decision was to make v8 `state.yml` FLAT and deterministic, replacing fragile v7 path/routing prose and eligibility cache behavior because the new pure modules and atomic bundle ops are safer, diffable, and testable; `migrate.mjs` remains the last step-1 gap for legacy block-YAML support.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: step 0.5 control-loop spike (throwaway, real Workflow)

Validated the real 2-agent Workflow control-loop seam in an isolated `/tmp` git repo by killing a live run mid-wave, because a Bash stand-in would have falsely greened the safety-critical no-commit assumption. Key result: real killed agents leave uncommitted edits, launch returns both `task_id` and `wf_` `run_id`, `TaskGet` after stop is ambiguous, and the next hardening step is to implement `resume.mjs` `decideNextAction` with disk as the done-vs-dead tiebreaker plus strict cwd/scope checks after the barrier.

<!-- wc:condensed -->

## 2026-05-28 — masterplan-ng: clean-core rebuild scaffold (build step 0)

Started the `masterplan-ng` v8 clean-core rebuild on the long-lived branch, keeping `main` at v7.2.3 until parity cutover, and chose a structural rewrite: pure Node `lib/*.mjs` modules plus a Workflow-tool engine and plugin-root `agents/` instead of logic-in-prose/bash-in-markdown. The key correction was that `.claude/agents/` was wrong because it is gitignored and project-local; the plan’s agent files must live under the published plugin `agents/` dir, validated by a step-0 scaffold with `package.json`, `ng-ci.yml`, stubs, and a 6/6 ESM smoke test.

<!-- wc:condensed -->

## 2026-05-27 — v7.2.1: wire Check #53 telemetry (CC-2 compaction-resume banner)

v7.2.1 took doctor Check #53 live by adding `emit_cc53_events` to `hooks/masterplan-telemetry.sh` for `turn_start`, `invoked_skills_reinjection`, `step0_flag/compaction_recent`, and `cc2_banner_emitted`, with banner detection done hook-side and the turn window defined as the most-recent maximal non-tool-result user-record run → EOF to avoid ratio inflation. Verified in isolated sandbox runs, which also exposed a `jq` missing `-r` bug; manifests, README, CHANGELOG, and retro were bumped to 7.2.1.

<!-- wc:condensed -->

## 2026-05-27 — v7.1.1: add /masterplan:verbs; restore plan skill

Restored accidentally deleted `skills/plan/SKILL.md` from `HEAD` and added missing `skills/verbs/SKILL.md` so `/masterplan:verbs` now shows `docs/verbs.md`; both were synced to the installed plugin because v7.1.0 had dropped one file and omitted the other.

<!-- wc:condensed -->

## 2026-05-27 — v7.1.0: per-verb /masterplan:<verb> skill commands

Created 12 per-verb `skills/<verb>/SKILL.md` stubs so `/masterplan:<verb>` appears in Claude Code’s command picker like `/superpowers:<skill>`, while narrowing `skills/masterplan/SKILL.md` to the Codex/bare entrypoint. Also bumped `hooks/hooks.json` to v4 to keep the hook shim aligned.

<!-- wc:condensed -->

## 2026-05-27 — v7.0.2 patch: doctor #1 false positives + #34 placeholder hash

v7.0.2 patched `doctor` false positives and the `codex-routing-fix` bundle manifest: check #1 now ignores `docs/superpowers/` container dirs without real `.md` files, and check #34 replaces the bundle’s placeholder `plan_hash` with the computed hash. Manifests were bumped to v7.0.2 because the previous WARNs were spurious and the hash metadata had been invalid since creation.

<!-- wc:condensed -->

## 2026-05-27 — doctor re-run (v7.0.1) + stale job cleanup

Ran a full 52-check doctor re-run with 0 errors, leaving only the same archived pre-v5.0 WARNs unchanged; the only fix was bringing the marketplace clone and `installed_plugins.json` up to v7.0.1 so #50 passed, while #3/#18/#29/#49 also passed. Also cleaned 10 stale Codex job files from `~/.claude/plugins/data/*/state/*/jobs/` after `codex-companion.mjs cancel` proved ineffective for non-current-session jobs; #51/#52 stayed SKIP because no `schema_version >= 5.1` bundle exists here.

<!-- wc:condensed -->

## 2026-05-27 — doctor post-rename (v7.0.0)

Ran all 52 doctor checks for the v7.0.0 post-rename pass inline, with 0 errors and ~12 warnings; fixed the README `Current release` bump and cc3-visibility `worktree_disposition`, then accepted #18/#50 as false positives and left expected bundle backfills plus stale Codex task cleanup (#49, 10 runaway tasks across yanos/openxcvr) for user action.

<!-- wc:condensed -->

## 2026-05-26 — v7.0.0 rename: superpowers-masterplan → masterplan (complete)

Completed the v7.0.0 rename from `superpowers-masterplan` to `masterplan` across local config and docs, including `~/.claude/settings.json`, `~/.claude/plugins/known_marketplaces.json`, `~/.claude.json`, `~/.claude/AGENTS.md`, `~/.claude/CLAUDE.md`, and `~/.claude/refs/hindsight-setup.md`, plus three sibling repos' `CLAUDE.md` files. Decision: stop after the full sweep because only historical-only references remain in `.bak` files, session transcripts, and tool-results.

<!-- wc:condensed -->

## 2026-05-26 — v7.0.0 rename: superpowers-masterplan → masterplan

Renamed `superpowers-masterplan` to `masterplan` end-to-end: GitHub repo via `gh repo rename`, 95 source files, `plugins/superpowers-masterplan` symlink, and local installed paths (`marketplace`, cache, telemetry hook, shim v4, `installed_plugins.json`, Codex marketplace). Bumped to `7.0.0` because the marketplace ID changed; users still enter through the `/masterplan` shim, but other machines need `/plugin update` to pick up the new ID.

<!-- wc:condensed -->

## 2026-05-26 — second-host upgrade to v6.4.0 + dev-repo stale-worktree root-cause

Upgraded the second host to v6.4.0 and traced the apparent dev-repo “revert” to stale worktree state caused by a ref-only update (`git fetch origin main:main` / bare `git update-ref`), not real file edits, so `git checkout HEAD -- .` was safe. Also confirmed `~/.claude/hooks/masterplan-telemetry.sh` is a symlink into the marketplace clone, so `git pull --ff-only` there implicitly updated the live hook; next step is restart Claude Code so the plugin cache/`installed_plugins.json` refreshes to 6.4.0 and `/masterplan doctor` can verify Checks #50/#51/#52.

<!-- wc:condensed -->

## 2026-05-26 — publish v6.3.3

Archived all 8 run bundles, left no active work, and pushed `main` to `origin` with a clean status. Noted that check #50 for registry/marketplace drift self-resolves after the push plus `/plugin update` on the consuming side.

<!-- wc:condensed -->

## 2026-05-25 — doctor run + pre-restart cleanup (v6.3.3, commits 5cdb961 + 276e955)

Ran a full 50-check `/masterplan doctor` on v6.3.3 and fixed two real issues: `parts/doctor.md` now skips `worktree_disposition: removed_after_merge` bundles in Check #3, and 5 older `state.yml` files now include missing `artifacts.events` pointers; also deleted stale `docs/masterplan/adversarial-review-integration/.lock`. The fixes were committed together in `276e955`, while registry/marketplace drift in Check #50 was expected (`v6.3.3` dev vs `v6.3.0` publish) and left for push/plugin update.

<!-- wc:condensed -->

## 2026-05-27 — ops-audit-hardening: v7.2.0 (transcript audit F1–F4)

Audited ~12h of `/masterplan` transcripts and shipped v7.2.0 after fixing F1 boot-banner under-emission, generalizing F3 budget discipline, and adding F4 fd/ulimit preflight; F2 gate re-entrance was refuted as intended resume behavior and left docs-only. Check #53 was forward-wired but dormant because `invoked_skills_reinjection`/`compaction_recent`/`cc2_banner_emitted` events are not yet emitted, so full `/masterplan doctor` was deferred.

<!-- wc:condensed -->

## 2026-05-28 — v8 (masterplan-ng): first Codex adversarial review of the L1 core + dispatch-tracking finding

Codex’s first adversarial review of `masterplan-ng` found and then closed the silent-corruption class in the L1 core: `promote-active-run`, `decideNextAction`, `mark-task`, `backfill-waves`, and `set-active-run` now fail loud on missing/non-integer waves, unknown ids, bad statuses, and bad backfill state, with new tests proving the fixes. The key decision was “safe to build Step 3 (`agents/*.md`) on top” because the orphan/double-dispatch window and dispatch-tracking hazards were narrowed to harness tracking, not core logic.

<!-- wc:condensed -->

## 2026-05-29 — Parity-dogfood (plan step 8) started — the v7→v8 cutover gate

Dogfood plan step 8 on `dogfood-scratch` validated the v7→v8 cutover gate in `masterplan-ng@f2e1b54`, proving the L1/L2 control loop and finding two blockers: `VERSION_RE` wrongly rejected whole-number schema versions, and `Workflow` tool args arrived JSON-stringified so `execute.workflow.js` saw empty waves. Both were fixed and regression-tested, but the args fix plus 5 tests remain uncommitted pending the seam keep/revert decision and the user-gated merge to `main`.

<!-- wc:condensed -->

## 2026-05-29 — Parity-dogfood wave-2 + report: e2e gate PASS, ONE residual blocks the cutover

Wave-2 dogfood/e2e passed at max-achievable parity with `summary{total:1,done:1,failed:0,reviewed:1}`, proving the production-boundary stringified-args blocker is gone; `561f348` was kept as a prod-inert testability seam, while mid-session `masterplan:mp-implementer` install was proven ineffective because the workflow subprocess shares the same session snapshot.

<!-- wc:condensed -->

## 2026-05-29 — Telemetry-hook deletion gate CLOSED (R1/Resolved #5)

Closed the last parked v8 gate and decided on FULL-DELETE, no shim: the persisted dogfood completion records had all per-subagent fields from the bash hook except `model`, and that gap is recoverable from `agent-<id>.jsonl`, so the Resolved-#5 ≤150-line-shim escape hatch did not apply. The v7 self-instrumentation surface in `masterplan-ng` stays until the additive cutover, since `hooks/masterplan-telemetry.sh` is already inert on `main` v7.2.3 and the full removal is sequenced with the branch cutover.

<!-- wc:condensed -->

## 2026-05-29 — Scoped v8 deploy to ras@epyc2 + version label bump → 8.0.0

Scoped v8 deploy to ras@epyc2 by swapping in the registry-backed `masterplan-v8` marketplace (not a `--plugin-dir` shim), leaving `main` and grojas@epyc1 on v7.2.3 and preserving the `/home/ras/.local/share/masterplan-v8` source for rollback. Also bumped the synced release manifests from 7.2.3 to 8.0.0, intentionally left `package.json` at `8.0.0-ng.0`, and kept the suite green at 239/239 because the publish-hygiene live test excludes that file until cutover.

<!-- wc:condensed -->

## Earlier (compacted)

- 2026-05-23 — codex-hardening: adversarial review B3 background handle capture (commit 6886be4)
- 2026-05-23 — codex-hardening: output_path cross-session fallback (commit 3787231)
- 2026-05-23 — codex-hardening: wave-barrier-interrupted detection (commit 009c28a)
- 2026-05-23 — codex-sandbox-probe: linked-worktree guard + Doctor Check #48
- 2026-05-23 — plan written: improve-regression-detection
- 2026-05-23 — execution complete: improve-regression-detection
- 2026-05-23 — branch finish: improve-regression-detection
- 2026-05-23 — hotfix: Codex annotation true/false aliases
- 2026-05-23 — branch finish: improve-subagents-parallelism + masterplan-token-efficiency
- 2026-05-23 — doctor --fix run (masterplan-token-efficiency worktree)
- 2026-05-23 — execution complete: hoist-run-policy → v6.2.0
- 2026-05-23 — hoist-run-policy extended: Codex failure policy → v6.2.1
- 2026-05-23 — post-merge fixes (main, no bundle)
- 2026-05-23 — post-v6.2.3 documentation drift scan
- 2026-05-23 — doctor check tier classification fixes (masterplan-token-efficiency branch)
- 2026-05-22 — brainstorm: improve-regression-detection (v6.2.0)
- 2026-05-22 — execution complete: improve-subagents-parallelism → v6.2.0
- 2026-05-22 — brainstorm: v6.0 token efficiency spec (v5.8.3)
- 2026-05-22 — plan written: v6.0 token efficiency (v5.8.3)
- 2026-05-22 — doctor --fix run (v5.8.3)
- 2026-05-22 — execution complete: masterplan-token-efficiency → v6.0.0
- 2026-05-22 — hotfix: Codex sandbox worktree compatibility
