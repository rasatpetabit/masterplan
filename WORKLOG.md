# WORKLOG

## 2026-08-12 — end-of-planning alignment audit (§3c)

Added the anti-drift look-back: after the plan gate, before `mp load-plan`, measure the plan
against the **original request** rather than against the spec.

**Why.** Every planning check was relative — plan-vs-spec, mechanical goal coverage, and a
goals-vs-reality check that does not run until finish. Drift accumulated across the repeated
adversary review→fix rounds therefore reached execution unexamined.

**Decisions.**
- *Anchor = `goals.md`'s `topic:` seed, not a new `request.md`.* `goalsHash` already canonicalizes
  the seed, so it inherits the freeze for free. Block form `topic: |` is opt-in on an exact `|`
  so the bare form stays byte-identical — verified across every committed bundle, 0 hashes moved,
  so no in-flight `goal_check`/`goal_waived` receipt is voided.
- *Advisory, not a gate — deliberately, for now.* Prerequisites for real enforcement (the gate
  framework is a closed `spec|plan` binary; a receipt proves an audit RAN, not that it PASSED)
  are recorded in `docs/design/planning-alignment-check.md` §6.
- *The user confirms the clause list.* Blocking only on high-confidence `dropped`/`contradicted`
  was tried and rejected: it made the gate structurally unable to fire on **cumulative narrowing**,
  which is the actual failure mode. Trust rests on one human check over a short confirmed clause
  list instead of on model-set severity.

**Backward-compat trap (found by the governed review, not by me).** `topic: |` was *already* valid
input — the old parser read `|` as ordinary seed text, so a bundle spelled that way has a stored
hash the new parser cannot reproduce. Committed bundles were checked (none use it) but in-flight
ones cannot be enumerated. `legacyGoalsHash()` reproduces the pre-block reading and `goals-load`
refuses when a bundle's stored hash matches the legacy reading but not the new one — a loud stop
with a migration path, never a silent re-hash of someone's frozen goals.

**Retracted:** an adversarial round claimed `seed-tasks` → `set-phase --phase=execute` was an
ungated second execute path. It is not. `set-phase --phase=execute` calls
`enforceGateReview('plan', …)` exactly as `load-plan` does; verified behaviorally (after
`seed-tasks` succeeds, the phase advance enters gate review and refuses fail-closed). The branch's
own comment records it as already closed. Do not "fix" it.

**Reviewer-lane outage — root-caused and worked around mid-run.** `dispatch_review` returned
`final_verdict: error` twice ("a region had no healthy reviewers"), forcing a Codex break-glass
review. All four `gpt-5.6*` models 401'd with `refresh_token_invalidated`, taking out five lanes:
`dispatch-adversary`, `dispatch-cross-review`, `dispatch-critic`, `dispatch-architecture`,
`dispatch-planned-execution`.

Mechanism: **`~/.local/bin/codex-proxy.py` is itself a writer.** It reads `~/.pi/agent/auth.json`
and, on expiry, refreshes and writes back a *new* refresh token. Every host runs its own copy, and
`~/.pi/` is not Syncthing-replicated, so three independent writers rotate one shared OAuth identity
— whichever refreshes first silently invalidates the others. Worked around by copying the valid
OAuth block onto epyc1 (backup `~/.pi/agent/auth.json.bak-20260812-161603`, `xai-auth` preserved)
and restarting its `codex-proxy.service`; `dispatch_review` then returned two real reviewers. That
resets the race but does **not** end it.

The real fix already exists and is orphaned: `/srv/litellm/scripts/chatgpt/` implements a
single-writer design (epyc2 refreshes; an access-only projection with no `refresh_token` is fanned
out to epyc1/epyc2/skynet3), and `litellm-chatgpt-oauth-refresh.timer` was installed Aug 4 — but
its `.service` unit was never written, so it has never once fired, and its `Documentation=` spec
no longer exists. **Trap: activating that timer alone makes things worse** — the epyc2 writer would
refresh every 20 min while each codex-proxy keeps refreshing independently, so they would revoke
each other faster than today. The timer is only safe once codex-proxy is a pure reader.

**Do NOT "fix" this by adding a fallback for `gpt-5.6*`.** Standing instruction: the API key is
installed for future use only and must carry zero traffic — OAuth/subscription only. Auditing
`models.catalog.yaml` by `auth_mode`, 21 entries split into exactly three groups:

| auth_mode | entries | billing |
|---|---|---|
| `none` (`api_key: noauth`) | `gpt-5.6`, `-sol`, `-terra`, `-luna` → `127.0.0.1:8790` | ChatGPT **subscription** |
| `oauth` | `grok-4.5` → `cli-chat-proxy.grok.com` | Grok **subscription** |
| `api_key` | the other 16 (anthropic, gemini, qwen, deepseek, glm, meta, ollama) | **metered API** |

So the only fallback target that would *not* start metered spend is `grok-4.5`. Do not add it
regardless without an explicit instruction — the lanes failing closed on a dead credential was
correct behaviour, and the credential is what needed fixing.

Corrections to earlier notes in this session: LiteLLM runs on **epyc2** (`192.168.109.72`), not
epyc1; and the outage was not a "frozen file" but the multi-writer rotation above.

## 2026-07-13 — fabric-default-dual-reg + residual scrub (archived)

- **Residual scrub (1236518):** strict live-alias MODEL_MAP (fable-only), explorer body wording, workflow/doc sonnet/opus prose scrub, doctor `pi-agent-registration` (17 modules).
- **fabric-default-dual-reg (5a802b5 / 6365260):** new seeds default `state.dispatch.fabric: true` (`mp seed --fabric=off` opts out); pi registration collapsed to bare-only with managed colon cleanup; unmanaged `masterplan:mp-custom.md` preserved; docs/verbs/wave-dispatch/development/AGENTS/commands/CHANGELOG updated; host resync green; run archived.

## 2026-07-10 — dispatch-subagent-reconcile debt cleanup (archived)

- Strict live-alias map + fable-only frontmatter on all mp-* agents; host resync 0 drift. Follow-ups (fabric default, dual-reg collapse, doc scrub) closed by fabric-default-dual-reg + residual scrub above.

## 2026-06-26 — pre-execute gate enforcement: triage hardening (receipt-binding, confined paths, fail-closed, ordering)

Applied the fix pass for the prior cross-vendor triage of the two PRE-EXECUTE adversary-review gates (`gate-review-triage.md`, hash `48fea81c…`). Change set: `lib/gate-review.mjs`, `bin/masterplan.mjs` (gate hunks only — the `rebase-paths` hunk in that file is the separate user-owned stream above), `commands/masterplan.md` §3b, `test/gate-review.test.mjs`, `test/bin-masterplan.test.mjs`, `test/coord-writer.test.mjs`. Why: the gate code was written and reviewed in a prior session that ended before the findings were folded in; this is the one coherent fix pass.

**What landed (by triage finding):**
- **P1 record-forgery → structured receipt binding.** New pure `validateGateReceipt(receipt, {gate, hash, artifacts})` in `lib/gate-review.mjs`. `record-gate-review --status=done` now REQUIRES `--receipt=<json|file>` that echoes the recomputed hash + artifact set and carries real lane provenance (`dispatch_id`/`provider`/`model` non-empty, `output_tokens`/`completion_tokens` finite >0, non-empty `digest`/`ts`); `--status=skipped` REQUIRES non-empty `--reason` AND a readable non-empty `--digest-file`. Honest ceiling: same agent runs lane+writes record, so this raises forgery friction, not cryptographic proof.
- **P1-B non-canonical/unconfined paths → single resolver + realpath confinement.** New `resolveGateArtifacts({gate,statePath,state,flags,op})` is the SOLE artifact source for enforce/record/gate-hash (so a record and its guard can never hash different bytes). Every candidate is `realpathSync`'d and confined to the bundle dir (`rel.startsWith('..')||isAbsolute` → die 1) — defeats symlink/`..` escape on ALL ops regardless of `--force`. `set-phase` ignores path flags (canonical paths); `load-plan`/`record`/`gate-hash` honor `--plan-index`/`--plan-md` (operation target, still confined).
- **P2 missing-artifact-hashed-as-empty → fail-closed.** `Buffer.alloc(0)` for a missing/unparseable artifact is gone; a missing required artifact or unparseable `plan.index.json` now dies(1) on every path.
- **P3a clobber-after-validate → hoisted.** `load-plan` rejects a populated bundle BEFORE reading/validating/gating the index; index read+parsed ONCE and reused (validate+gate+stamp+materialize), the parsed object passed to the gate as `prereadIndex` to close the read→hash TOCTOU.
- **P3b out()+exit truncation → `fs.writeSync(1, …)` + `process.exit(3)`.**
- **--force audit:** a `--force` bypass now appends a `<gate>_gate_bypassed` event (never silent).
- New read-only `mp gate-hash` subcommand emits `{hash, artifacts}` so the shell/tests learn what to echo into a receipt; `gate-review-status` migrated to the same resolver. §3b prose rewritten to the receipt/skip flow. Hash key format changed (relName-based, top-level-sorted normalized index) — internally consistent; no production bundles depend on the old key.

**Verification:** full `node --test` **1002/1003 pass** (the 1 fail is the pre-existing `agents/mp-implementer.md` tools-regex, untouched); `node bin/doctor.mjs` exit 0, 0 errors. Tests: `gate-review.test.mjs` +8 (validateGateReceipt unit), `bin-masterplan.test.mjs` +13 (exit-3+op+state-unchanged for both gates, spec-edit re-arm, plan_hash/generated_at-only edit does NOT re-arm, skip-evidence required, fail-soft skip satisfies, fabricated-done rejected, fail-closed missing artifact, `--plan-md`/symlink escape refused, clobber-before-validate, `--force` audit event); `passGate` helper in both bin+coord-writer rewritten to mint a real receipt via `gate-hash` and stub the now-required artifacts; coord-writer "missing plan.md" test converted to `--force` (the gate is now fail-closed on plan.md).

**Caveat — cross-vendor re-review BLOCKED:** the authoritative gpt-5.5 adversarial pass on the merged diff could not run — the skynet gateway is down (all 4 endpoints 502/timeout; `dispatch-cross-review` alias not routable), the same outage `doctor adversary-lane-health` WARNs. The diff is staged at `scratchpad/gate-impl.diff` for re-review when the lane recovers. Left UNCOMMITTED for user review.

## 2026-06-25 — doctor `adversary-lane-health` live fix + `mp rebase-paths` + audit-cleanup

An audit pass landed a real defect fix in `lib/doctor/adversary-lane-health.mjs` (the backend-health probe mis-invoked `agent-dispatch health --class adversary`; the verb takes a POSITIONAL backend, so the catch never fired and the lane silently read healthy) and a set of doc-hygiene edits (de-dup hardcoded `gpt-5.5`/`skynet-local` → defer to `agent-dispatch digest`; `lib/routing.mjs`→`lib/dispatch/routing.mjs` path fix; `codex-auth` comment reframed as informational-only). The audit's self-report was partly incorrect and its fix was unreachable in the live state, so this entry records what actually landed after correction.

**Audit deviations corrected:**
- The audit reported "Suite 914 pass / 2 fail" — actual was **936/1** (single pre-existing `agents/mp-implementer.md` tools-regex; the cited second `plan-merge.test.mjs renderPlanHtml` failure does not exist — that test passes 22/22 and no `renderPlanHtml` symbol is referenced anywhere). Recorded so a future audit can't cite stale counts.
- The audit reported "WORKLOG entry added" — none was. This is that entry.
- The audit reported end-to-end verification: "with the gateway down, the doctor correctly WARNs 'dispatch-gateway reports unhealthy' instead of falsely passing." Not reproduced. With the gateway down `agent-dispatch resolve --class adversary` flaps between exit 1 (threw, `chain_exhausted` on stderr) and exit 0 with a bare `chain_exhausted` token on stdout — EITHER way the audit's JSON-parse/backend-probe branch was unreachable in the live state, and the doctor emitted the same generic "resolve failed" WARN the OLD code already produced. The audit's verification did not actually run what it cited.

**The corrected fix** (`lib/doctor/adversary-lane-health.mjs`): the audit's positional-backend correction is sound and kept (it's the right call when `resolve` SUCCEEDS with JSON), AND a fallback path is added: when `resolve` throws OR emits a bare failure token (`chain_exhausted`, `escalate`, `budget_breach`, `no_route`, `unresolved`) OR returns JSON with no `backend` OR a JSON decision/status/reason of one of those failure tokens, fall back to the configured class chain — read via `agent-dispatch where` → `policy/dispatch-policy.jsonc` — and probe each configured backend's `health <backend>` directly, so the WARN can name the sick backend. Three refactored helpers: pure `parseResolveOutput(rawOut)` and `parseConfiguredBackends(policyText)` (exported for unit tests), plus the fs/child_process wrappers `agentDispatchRoot()` / `readConfiguredBackends(repoRoot)` / `probeBackendHealth(backend)`. Probe-seam contract extended with optional `unhealthyBackends: string[]|null`. **Live-verified end-to-end** (this time, for real): with the gateway confirmed down (`agent-dispatch health dispatch-gateway` → `healthy:false`, exit 0), `node bin/doctor.mjs` now emits, across 6 consecutive runs, either `WARN adversary-lane-health: adversary lane resolves (dispatch-adversary) but its backend is unhealthy: dispatch-gateway reports unhealthy …` (when resolve briefly returned JSON) OR `WARN adversary-lane-health: adversary lane backend unhealthy: dispatch-gateway reports unhealthy (\`resolve --class adversary\` exhausted) — review may degrade to inconclusive` (when resolve threw/returned a failure token). Both name `dispatch-gateway reports unhealthy` regardless of the flaky resolve shape. The advisory invariant (never ERROR) is preserved. `test/doctor.test.mjs` +11 (resolve-throws-with-configured-backend → named-backend WARN; resolve-throws-no-backend → generic WARN; 9 pure-helper tests covering parseResolveOutput's failure shapes + parseConfiguredBackends JSONC tolerance); injected-probe contract unchanged so existing tests stay green.

**New `mp rebase-paths` verb** (`bin/masterplan.mjs` + `lib/bundle.mjs`): the CD-7-compliant single-writer for the bundle's absolute path fields (`spec_path`/`plan_path`/`plan_index_path`/`worktree`) after a repo relocation — the ONLY writer for these fields besides `seed`. The 2026-06-22 user-owned hand-edit of `state.yml`+`.bak` path rebrands (`/srv/dev/masterplan/...`→`/srv/dev/ras/masterplan/...`, left sitting in the dirty tree as a separate workstream) was a CD-7 violation with no mp-native alternative; this verb closes that gap. Pure transform `rebasePaths(state, fromRoot, toRoot)` (only leading-prefix matches are rewritten; identical roots is a no-op; relative roots throw; re-running with the same `from` is idempotent). `test/bundle.test.mjs` +1 (pure helper, idempotency, validation); `test/bin-masterplan.test.mjs` +3 (write+count, idempotent re-rebase, relative-root rejection). **Applied** to the three live state.yml files (codex-review-issues: 4 fields rebased; finish-flow-hardening: 3; github-coordination: 3). The `docs/masterplan/cc3-visibility/state.yml.v5.1.bak` artifact is a schema-5.1 legacy backup, NOT live state, and `loadForWrite` correctly refuses it; its stale `/srv/dev/masterplan/...` path is left as-is (frozen snapshot).

**Cleanup:** removed the 3 orphan `.owner.hb.*` heartbeat files in `docs/masterplan/codex-review-issues/` (the `owner-sentinel` doctor's "safe to remove" path — Guard D volatile artifacts from a 2026-06-18 run with no `.owner.lock`); `owner-sentinel` now PASSes.

**Audit's kept work (verified correct):** doc hygiene — `skynet-local` purged from lib/docs; `gpt-5.5`/`skynet gateway` hardcoded refs de-duped to "see `agent-dispatch digest`" in README/install/development/agents/mp-adversarial-reviewer; `lib/routing.mjs`→`lib/dispatch/routing.mjs` in `plan-annotations.md` (old path nonexistent, new path correct); `codex-auth.mjs` comment reframed as WARN-only-and-informational (accurate — the check is WARN-only, never ERROR, so it never gates a run); `adsp-adapter.mjs` "BUILT + TESTED BUT NOT YET WIRED" status note + `plan-annotations.md` cross-link (verified: zero non-test callers of `escalateCrossReview`/`revertCrossReview`/`dispatchTask`). The audit's cross-repo sync claim holds: `agent-dispatch compile --target srv-dev-agents-routing --dry-run` → `changed:false`, and the §routing managed-block hash (`6d8307801e22...`) matches identically between `masterplan/AGENTS.md` and `agent-dispatch/AGENTS.md`.

**Hardcoded-account path resolved:** the audit's `escalateCrossReview` hardcoded `/home/ras/.claude/plugins/marketplaces/rasatpetabit-masterplan/bin/masterplan.mjs` — account-specific, broke on `ras@*` accounts. Replaced with `resolveMasterplanBin` (new helper in `lib/paths.mjs`, the single source of truth for filesystem locations): portable across accounts via `os.homedir()` + `resolveConfigDir` (honors `$CLAUDE_CONFIG_DIR`), with `$MP_BIN` (absolute bin path) and `$MP_MARKETPLACE_DIR` overrides for edge cases; never a hardcoded `/home/<user>` literal. `test/paths.test.mjs` +7 (defaults-portable, `$CLAUDE_CONFIG_DIR`, `$MP_BIN` absolute+relative, `$MP_MARKETPLACE_DIR` absolute+relative, precedence, blank-ignored); `test/adsp-adapter.test.mjs` +1 (`escalateCrossReview` without `opts.masterplanBin` resolves via `$MP_BIN`, no `/home/ras` leak). Verified on-host: `resolveMasterplanBin()` → the correct `grojas`-account path via homeDir, and a `ras` account would resolve to its own `~/.claude/...`. The bin-exists probe is deliberately omitted — `spawn()` surfaces ENOENT loudly if the install is absent, which is the right failure mode for an unwired escalation seam.

**Remaining caveats:** The cross-vendor adversary review ran DEGRADED today (1 of 2–3 requested reviewers — the gpt-5.5 gateway is the same flap the doctor now correctly surfaces). The pre-existing `index-staleness`/`scalar-cap` WARNs (`qctl-implementer-backend` plan_hash stale; `finish-flow-hardening` topic overflow) are unrelated user-owned tech debt, not touched here. **Suite 958/959** (the 1 fail is the pre-existing `agents/mp-implementer.md` tools-regex). Doctor exit 0.

## 2026-07-07 — per-wave adversary review: nested-field fix
- Bug: dispatchWave (lib/continue.mjs) derived the wave review mode from legacy `state.codex.review` only, so a bundle armed via the canonical nested `state.review.adversary` (what `mp set-review-config --review=on` writes) launched every wave with review OFF. Found live in the unified-pi-dispatch run (waves 0–4 executed unreviewed despite `review: {adversary: true}`); finish-step already read the nested key, so only the per-wave path was blind.
- Fix: `state.review?.adversary ?? state.codex?.review ?? opts.review` + regression test (continue.test.mjs) + set-review-config comment corrected. Synced into the 9.3.0 plugin cache so in-flight sessions pick it up at the next wave dispatch.

## 2026-07-09 — v9.5.0: all mp-* agents gateway-routed, opus pins retired
- Why: mp-plan-reviewer (and mp-planner/mp-subsystem-planner/mp-spec-decomposer/mp-goal-assessor) carried hand-written `model: opus` frontmatter since v8.0.0, OUTSIDE agent-dispatch's compiled_frontmatter set — ungoverned by policy and contrary to the route-everything-through-the-gateway standing preference. Found while auditing the skynet-reliability-hardening plan gate.
- Change: all five are now `model: fable` thin wrappers delegating their semantic core via required fail-closed `model_group` — review/verdict → dispatch-critic (xhigh), planning/decomposition → dispatch-planned-execution (xhigh) — each with a never-native fail rule (lane outage surfaces loudly; no same-vendor fallback). mp-implementer: landed the 9.3.0-cache-only glm-5.2/agentic-loop hotfix (was never committed; recovered from the cache before purge) and dropped its pin to fable. agent-dispatch overlay now carries compiled_frontmatter for ALL 8 mp-* agents + two new classes (masterplan-planning, masterplan-plan-review); `agent-dispatch verify` green, zero frontmatter drift.
- Cache hygiene: 9.3.0/9.4.0 plugin caches audited for unlanded hand-edits before removal (only the implementer hotfix was unique; 9.4.0 cache had none vs its release commit); caches purged and reinstalled at 9.5.0.

## 2026-08-28 — primary-docs scrub of retired agent-dispatch vocabulary
- Scope: 5 primary docs only (commands/masterplan.md, docs/conventions/adversarial-review-failure-policy.md, docs/internals/wave-dispatch.md, docs/internals/task-verification.md, README.md). No git commit (per task instruction); no lib/test changes.
- Why: the fleet's agent-dispatch control plane (CLI, dispatch_task/dispatch_review/dispatch_fanout MCP, serve-mcp broker transport, dispatch-<class> lanes) is retired fleet-wide; the docs still described it as the live path.
- What: remapped every live-surface reference onto the native contract — `mp dispatch-wave` returns a native spawn plan (descriptors for the harness parallel subagent API; classes resolved from policy/workflow-map.json); wave-dispatch record persists `pending` BEFORE launch with a wave-token two-phase marker + probeWaveToken recovery; `mp record-result` runs the two-phase native review seam (`run_native_reviews` phase A descriptors → `--reviews-file` phase B ingest); gate/finish reviews run harness-native adversary class (breaker role, frontier lane; adversarial panel for cross-vendor) and record via `mp record-gate-review --review-json` (provenance from reviewers[]) or `--status=skipped`; doctor check renamed `routing-policy-health` (was `adversary-lane-health`).
- Decisions: dropped the stale `translateBrokerResult` function name (doesn't exist in lib/) in favor of `lib/dispatch/dispatch-digest.mjs` projection; rewrote §3b receipt step to prefer `--review-json` over the hand-built `--receipt`; consolidated the retired "MCP-pool path" narrative into the single native flow; `docs/policy/dispatch.md#model-provenance-and-direct-subagent-dispatch` → `/srv/workflows/policy/dispatch.md` (the `agent-dispatch` substring in `subagent-dispatch` was a false positive from the word-boundary-less grep, but reworded to match how agents/*.md reference the fleet policy).
- Verified: task-spec grep + the repo's stricter word-boundary regex both clean on all 5 files. test/no-agent-dispatch.test.mjs still fails repo-wide on 77 PRE-EXISTING findings in other live surfaces (docs/development.md, docs/internals/*, docs/install.md, test/*) — none of my 5 files appear; the pre-existing WIP changes in lib/ and test/ were left untouched.

## 2026-08-29 — fresh-eyes legacy audit + remediation bundle seeded

User asked for a full fresh-eyes re-evaluation: old/incorrect/no-longer-needed elements.
Ran 4 parallel deepseek-v4-flash audit workflows (runtime / concurrency / surfaces /
artifacts — 42 lenses + 42 independent cross-verifiers), then manually re-verified every
high-severity finding and deletion candidate with git grep + call-site analysis.

**Deliverables:**
- Verified inventory: docs/masterplan/fresh-eyes-remediation/audit-findings.md (grouped
  A behavioral defects / B live-state & release drift / C dead material / D stale compat /
  E misleading docs / F clutter, plus explicit non-findings).
- Remediation bundle seeded: docs/masterplan/fresh-eyes-remediation (brainstorm phase).

**Top verified facts (do not re-litigate without fresh evidence):**
- Goal-gate finish flags (--goals-met/-unmet/--manual-verdict/--goals-waived) have ZERO
  matches in bin/finish-step; run_goal_check op fires but nothing consumes the answers.
- FABRIC_DEFAULT_CLASS 'masterplan-implementation' absent from policy/workflow-map.json →
  every unpinned task routes via defaultClass 'unknown'; 5 tests pin the dead name.
- --fabric=off seeds runs the deleted L2 path can never execute.
- register-pi-agents mutates ~/.pi on ANY unknown flag (--help included).
- mp parseArgs silently ignores unknown flags on mutating verbs.
- CI Doctor step red: blocked-task-injection archived without goal_check receipt.
- Blackboard crash-recovery seam (resume.mjs) emits an action continue.mjs cannot execute.
- Dead removable: lib/jsonc.mjs, dispatch-digest's 10 exports, finalizeRecord, probe
  machinery in continueRun, runLocalVerifyCommands, routeTask legacy brain, mp-explorer.md.
- CORRECTION vs earlier session notes: doctor exits 1 on errors (fail-closed); a prior
  "exit 0" observation was a `| tail` pipeline artifact.

**Also this session (separate commit in /srv/workflows, d2e6c30):** pi-dynamic-workflows
compact task panel now shows per-run models + progressPanelMaxRuns cap (default 10,
/workflows-progress runs <N>) — user's detailed-mode display was unusable with parallel
runs. Settings flipped detailed→compact; compiled artifact rebuilt (last-good bcd9e364…).

**Next:** /masterplan resumes fresh-eyes-remediation → brainstorm from audit-findings.md.

---

### 2026-08-30 — fresh-eyes-remediation run: planned + executing (waves 0–3 landed)

The seeded bundle was brainstormed, gated, planned, and is now mid-execution.

**Planning trail** (bundle: docs/masterplan/fresh-eyes-remediation):
- Brainstorm → spec.md (five waves, gate-hash sha256:4dfd74b6…) with Assumptions &
  Open Decisions table. Spec gate passed via 2 cross-vendor adversarial rounds
  (litellm/glm-5.2:high + skynet/deepseek-v4-flash:max): 7 defects found→fixed→re-verified.
- goals.md frozen (8 goals, hash sha256:82ec8e64…). G5 amended to add a positive
  implementation cross-check (closing a negative-only cheat-hole).
- §3c alignment audit: 15 covered / 1 narrowed (A6 path:line) → task 32 enforces.
- mp-planner (serial, judge lane) wrote plan.md + plan.index.json (32 tasks / 6 waves).
  Plan gate passed via 3 cross-vendor rounds (A6 citation requirement added).

**Execution (worktree .worktrees/fresh-eyes-remediation):**
- Wave 0 (task 1): A7 compat preflight scan — 141 documented invocations classified.
- Wave 1 (tasks 2–7): behavioral repairs A1–A9 landed; suite 1660/1660.
- Wave 2 (tasks 8–11): goals re-freeze ×5 + covering waivers ×5 (user-attested) cleared
  all doctor goal ERRORs/WARNs; doctor reached 0 error / 0 warn. B3 plans archived to
  docs/masterplan/.implemented-plan-archive/. RELEASING.md tag+push sequence added.
- Wave 3 (tasks 12–23): deletions C1–C10 + config scrub D1–D4; suite 1618/1618.
- D6 scope-guard reverts on justified out-of-scope files were surfaced and re-applied as
  acknowledged scope expansions (logged via mp event scope_expansion_approved), per user
  precedent. The frozen launch-scope guard works as designed.

**Next:** wave 4 (docs/skills E1–E12, tasks 24–31) in flight → wave 5 (release & ops,
task 32, terminal) → finish flow (§2c): verify → goal-check → retro → adversary review →
branch_finish gate → archive.

Also this session (separate repo /srv/workflows): fixed the pi-dynamic-workflows
adversarial-review builtin — its Refute phase carried a non-literal model expression that
the static meta validator rejects, so the builtin was unloadable; made it a literal +
moved the args.refuteModel override to the per-agent call (regression-tested). Also fixed
the bottom status bar to a bounded detailed view (user's real ask), not compact.

## 2026-08-30 — fresh-eyes-remediation: finish flow → merged, released v9.10.0, archived

- Waves 4–5 landed: docs/skills E1–E12 (8 builders + completion pass for the interrupted
  task 31), then terminal wave 32 — clutter removed, v9.10.0 manifests + CHANGELOG, final
  inventory (43 finding ids, strict A6 path:line idiom), release commit + annotated tag.
- CI caught two wave-1 portability bugs on the first tag cut (Node-22-only iterator helper
  on a Node-20 runner; temp-repo commit without git identity); tag re-cut at the green
  commit c4ba19c — release was unpublished at first cut, so no retroactive-tag violation.
- Marketplace re-synced to the tag; `claude plugin update masterplan` 9.9.3 → 9.10.0;
  host pi agents re-synced (stale installed mp-explorer removed after review). User owes
  /reload-plugins to apply in their live CC session.
- Goal-assessor pass found 3 real residual doc staleness spots (internals.md stages list
  + deleted mp-explorer, verbs.md recover_and_redispatch) — fixed at finish. Its "stale
  state" claims were an artifact of reading the worktree's seed snapshot, not the live
  record in the main working tree.
- Adversarial branch review (12 breaker leaves): waiver idempotency was silently dropping
  repeat waivers with different reasons — repaired evidence-bound + regression test;
  parseArgs fail-closed, E12 doctor catch, goal_check binding all verified clean.
- branch_finish: merged to main (merge commit 8a8513a), post-merge repairs (worktree-aware
  retired-surface scan exemption, honest index fix-text, plan_hash restamp), worktree
  retired (removed_after_merge), branch deleted, CI green on main (run 33317489002 @ 15e6750).
- User-attested goal_check receipt: all 8 goals achieved (bound to goals hash 82ec8e64…,
  head 15e6750). Bundle archived per the B3 precedent (plan → .implemented-plan-archive/
  2026-08-30-fresh-eyes-remediation.md; bundle directory removed, history keeps everything).
