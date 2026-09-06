# WORKLOG

## 2026-09-02 (late) — intent-to-completion: cross-vendor panel → spec rev 11 (gate re-armed)

Round 10 of the single-lane gate (gpt-5.6-sol) PASSED rev 10; the operator then asked for the
cross-vendor panel (native `adversarial-review.mjs`: gpt-5.6-sol + glm-5.2 + three in-repo
lenses). Mechanics worth keeping: the workflow reads only `args.diff`, so the 68 KB of spec+goals
was embedded byte-exact by a generated wrapper script (`JSON.stringify` of the file bytes, length
asserted at run time) — never retyped through the model.

**Verdict: REVISE.** 0 blockers survived in-tree verification, 11 should-fix, 6 nits (record:
`gate-spec-panel.json`; digest in `gate-spec-notes.txt`). Dropped after verification: the
"rebase replays unaudited commits" blocker (the push precedes `main_pre_bootstrap`), GitHub
branch protection (main is unprotected), the §7.3 "livelock" (re-entry never commits).

**Why rev 11 looks the way it does.** The panel's real theme: §10 published irreversibly before
any finish gate and named no recovery. Rev 11 adds §10.3 (per-step failure dispositions: a
pre-publish verify before anything leaves the machine, forward-only corrective v10.0.x release,
Pi rollback via `install-pi --ref=v9.10.0`, PR-merge reconcile before any re-merge, a throwaway
GitHub repo rehearsal of the real `gh pr` cycle) and makes the gate rebase survivable (commit the
dirty bundle state first — reproduced: `git rebase` exits 1 on a dirty tracked file; require
`origin/main == recorded merge sha`, the round-10 advisory). §7.3 now treats bundle-only commits
as not-a-move and forces a full `run` re-run on a real move (check-only replay could re-certify
moved code). This run's own v9-written archive gets a `legacy` completion class. Interview:
floor counts answered questions only (withdraw could otherwise reach `exhausted` with zero
answers); `--round` makes "critic after every intent round" enforceable at high. `done:` is
re-resolved at `deploy_base_sha` (this branch adds `.masterplan.yaml` after seed). Knob guard no
longer accepts a seeded state field as an observable (that was the inert-knob class itself).

**G6 amended a second time** (operator-approved receipt): accepts the corrective v10.0.x, requires
the tag's CI run green, and requires the installed binary to execute on both surfaces (goals hash
191978ba…). Gate hash re-armed to 05e44a7a… (rev 11 bytes + amended goals).

**Panel 2 (rev 11): REVISE again** — both lanes revise, 2 blockers, 7 should-fix, 5 nits. The
blockers were holes rev 11 itself opened or left: the sample `release` step commits to the base
and so trips the §7.3 base-move audit it sits under (and an unbumped version dead-ends on the
existing tag); and the interview floor counted design picks, so `converged` was reachable with
zero intent questions. Rev 12 (c5bd17d, gate hash ea71db5a…): release contract (bump is branch
work, `version_not_bumped` gate before `branch_finish`, `release.mjs` never bumps and replays
idempotently), stage-produced commits recorded in the deploy receipt (`commits`, `base_after`)
so the audit base advances, an intent-floor column (1/3/6) with `draft` refusing until an intent
answer exists, audit scope widened to any `docs/masterplan/*/` bundle, step-5 push gets a
fetch/ancestry precondition and the corrective pass never pushes local `main` again, a
pre-publish cross-vendor review + G1–G5 assessment before the tag and a `publish_ack` go/no-go
before the merge (the operator confirmed the publish-before-finish-review ordering: D2/A25 are
now user-confirmed), `user_only` steps carry an executable `check` instead of free-text
evidence, `required_successor` event + doctor FAIL, seed lock + validate-then-create with
`--overlap-review` mandatory, squash merges accepted by patch-id.

**Panel 3 (rev 12): REVISE** — 1 blocker, 11 should-fix, 4 nits (record `gate-spec-panel-3.json`;
panel 2's record is now in `gate-spec-panel-2.json`). The blocker was a CI interaction nobody had
traced: `required-successor` FAILed while the successor was absent or in progress, and
`ci.yml` runs the doctor on every push and every tag — so the archive push would have turned
`main` red and the successor's own tag CI red, making `complete` unreachable. Rev 13: the
check's severity follows the successor's state (absent → WARN, in progress → PASS, archived
not-complete → ERROR), and the v10 finish gains a `push_archive` op so GitHub's doctor can ever
see a completion. The other structural fixes: the bootstrap procedure is now a **stage** (not a
"wave") driven by `lib/bootstrap.mjs` — `mp bootstrap arm` evaluates preconditions in code and
prints the command, the shell runs it, `record` checks postconditions — with `--targets` so the
rehearsal script exercises the live executor; a corrective pass (`pass: 2`) re-runs the
pre-publish verify/review/assess at the new tip before tagging, and the `release` postcondition
binds the tag to the reviewed sha; `done: none` gets real semantics (no groups, archive class
`merged`, never `complete`); stage-produced commits are restricted to a `commit_paths`
allowlist; interview rounds seal on their first answer and each level has an intent-round
minimum (1/2/4) so batching cannot collapse the `high` critic cadence; a failed critic dispatch
needs a retry and an operator ack before `exhausted`; `context_watch.focus` became a live knob
via `mp context-status`'s `recommendation`; env reads go through `readEnv`.

**Panel 4 (rev 13): REVISE** — 2 blockers, 6 should-fix, 5 nits, 7 dropped (record
`gate-spec-panel-4.json`). Both blockers were rev-13 fixes that overshot: `push_archive` had
become an ungated default push for every repo (under `loose`, no AUQ; on repos with no `done:`
it would have published every local-only `main` commit), and the per-round critic rule was an
event-position predicate that one trailing receipt satisfied — with the §11 test worded to
certify the bypass. Rev 14: `push_archive` fires only when an `install` receipt pushed the base
and always halts; the per-round cadence is refused at the *ask* (no new intent round at `high`
without a receipt for the previous one) and `converged` needs one distinct receipt per round;
`deploy_indeterminate` attestation yields `incomplete:attested`, never `complete`; squash proof
uses `patch-id --verbatim` (`--stable` is whitespace-blind, reproduced on this host); the
bootstrap driver moved from a permanent `mp bootstrap` verb to a one-off
`scripts/bootstrap-v10.mjs`; the cross-repo scan takes `workspace_roots` from `--targets`;
`main_push` names the non-bundle commits it carries; `required-successor` binds to the
`--predecessor` link and is declared soft (A35). Four panels so far (~3.6M tokens), each
finding what the previous fold introduced. **The operator chose to record the gate without
another review**: `spec_adversary_review_skipped` at hash 3a4ff341… (rev 14, 6032efa) — the
recorder's `--status=skipped` with reason + digest, because a `done` record must bind a review
that saw the current bytes and panel 4 saw rev 13. Residual risk in the rev 14 deltas is carried
to the plan gate. Phase is `plan`; the plan lifecycle (§3a) is the next step.

## 2026-09-02 — intent-to-completion: brainstorm + spec (run seeded, not yet planned)

Bundle `docs/masterplan/intent-to-completion/`. Scope grew mid-interview from three asks
(interview depth, intent-level goals, deploy-to-done) to seven: the operator asked for a full
parameter audit, a seed-time overlap check, and context-window watching at gates.

**Audit finding that drives the design.** `--complexity`, `--autonomy`, `--complexity-source`,
`--predecessor-transcript` are accepted, stored, documented, and read by no code (autonomy is
prompt-only and seeded `null`, so the operator's `~/.masterplan.yaml` `loose` never engaged;
v8 dropped the yaml loader entirely). `--et`/`--new` sit in the flag whitelist unread. Three
`MP_*`/`SKYNET_*` env vars are read but undocumented. A dead-symbol audit cannot see this class
(every symbol is referenced); the spec adds `test/knob-liveness.test.mjs` so it cannot recur.
Scratch script: the knob audit lived in the session scratchpad, not the repo.

**Decisions (operator's).** Prompt-first, minimal code — overrode the recommended config-plane
shape with the inert-prose risk shown. Replace the G-list with an Intent block + 3–5 outcome
goals. Deploy driven by masterplan, gated by autonomy, definition of done as a `done:` block in
`.masterplan.yaml`. Interview budget bounded 12–20 at high with a cross-vendor critic per round.
v10.0.0. Two code seams accepted beyond prompt-first: durable `deploy`/`intent_confirm` finish
gates (archive stays last; replay guard via a `finish_confirmed` event) and the interview budget
as `interview_question` events.

**Interview lesson, recorded as memory.** A restatement essay + "is this right?" was rejected
outright: it moves parsing onto the operator. Understanding is shown through small pick-one
questions and concrete proposals. This is now a non-goal in the spec.

**Harness facts verified (Claude Code docs).** No tool or hook can trigger compaction; PreCompact
cannot set the focus; auto-compaction fires at `autoCompactWindow`; `SessionStart(source:
compact)` output is injected post-compaction — hence `mp context-status` (exact usage from the
transcript's last usage record) + `mp resume-brief`, not an "auto /compact".

**Spec gate: 10 adversary rounds to PASS (rev 10).** Rounds 1–9 all FAILed on real defects, each
tabulated in spec.md §13 — the recurring theme was the installed v9.10.0 finish flow constraining
how this run can prove its own rollout. Final mechanism (§10): bootstrap wave BEFORE `mp finish`
— release commit + tag on the branch tip, push, install-pi, push local `main` (state-only commits
only, per-commit audited), PR merge on GitHub (local `main` NOT pulled, so the v9 goal check and
review still see the real `main..tip` diff), operator's `/plugin marketplace update` +
`/plugin update`; then finish under a pinned v9 binary; at the `branch_finish` gate, rebase
local `main`'s state-only commits onto `origin/main` and let finish's merge be a no-op. A
rehearsal script on fixtures must pass before the real steps. Operator decisions at approval:
D1 interview ledger verbs; D2 both surfaces before archive; G6 amended (approved) to match.
`full` autonomy retired to a warned alias of `loose`.

**Pre-existing red test on clean main:** `test/cli-surface.test.mjs:138` (A1 finish-step
goal-gate flags; exit 2 "recognized flag rejected as unknown"). Not touched; must be a plan task.

**Phase now: plan.** Next: §3a planning (parallel by subsystem per `planning_mode: auto`), plan
gate, alignment audit, load-plan, execute.

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

## 2026-08-30 — post-release follow-ups (v9.10.0 era)

- register-pi-agents: SKIP_FOR_PI emptied (mp-implementer gone since C7); skip mechanism
  kept via an injectable runRegister skipSet seam, tests inject a sentinel; set pinned
  empty until a CC-only agent returns (31/31).
- `mp reindex-plan` added: first-class surgical restamp of plan.index.json plan_hash from
  the current plan.md (the gap behind the fresh-eyes bundle's index-staleness WARN);
  idempotent, fail-closed, plan_reindexed audit event; doctor fix-text names it (9 tests).
- Flake diagnosis closed: the intermittent single-suite failures were the no-agent-dispatch
  scan scope bug (fixed in the post-merge repairs), NOT the refs/amend-plan tests — their
  tmpdir ENOENT log line is the EXPECTED graceful-degradation output of a deliberate
  fixture (plan.html present, plan.index.json absent -> STALE marker). 5 consecutive full
  suite runs green on main (1647/1647).

## 2026-08-30 — Pi support residuals closed (all three)

- SKILL.md restructured host-generic: host model (Pi primary / Codex compatible /
  CC uses the plugin), new Pi adaptation section (native tools + ask_user_question,
  PI_CODING_AGENT serial planning, dispatch_fabric waves via parallel subagent
  fan-out), Codex adaptation retains ALL prior behavior; 'Recognizing existing
  runs' is now host-neutral. test/cli-surface docSources scans the canonical repo
  skills/, never the installed copies (they are consumer artifacts now).
- register-pi-agents owns .masterplan-managed.json: write mode removes
  previously-managed files whose source agent is gone (bare or colon), --check
  previews without mutating, files never in a manifest are never touched
  (user-authored agents safe), corrupt manifest degrades to adoption. 6 tests.
- bin/install-pi.mjs: copy-based Pi install. git archive of an exact committed ref
  (dirty bytes never enter), validates the required surface, registers agents from
  the staged release BEFORE switching anything live, atomic current-swap onto
  ~/.local/share/masterplan/releases/<sha>/, repoints both skill links into the
  install root, .pi-install.json metadata, --check/--force/--source/--ref/
  --install-root/--pi-root. RELEASING step 10 runs the installer (--ref=vX.Y.Z
  then --check). 6 tests.
- LIVE MIGRATION: installed 5e39574 (v9.10.0); both skill links resolve under the
  install root (no /srv/dev anywhere); the old ~/.agents/skills/masterplan{,-detect}
  dev-tree symlinks removed; install-pi --check = check_ok; register-pi-agents
  --check = 7 in sync; suite 1659/1659; doctor 0/0.

### 2026-09-03 — intent-to-completion: planning (§2b/§3a) on spec rev 14

- Seven `mp-subsystem-planner` fragments drafted on the governed planning lane (`skynet_chat`, `dispatch-planned-execution`, spec+goals via server-side `paths`); the integration drafter needed one retry after an HTTP 502 upstream timeout. Merged deterministically (`mp merge-plan-fragments`, narrative meta) → 48 tasks / 11 waves; `mp validate-plan-index` valid.
- `mp-plan-reviewer` on `dispatch-critic`: round 1 FAIL (15), round 2 FAIL (9), round 3 REVISE (4, coverage 15/15, goals 6/6). Every finding was folded as a deterministic fragment edit (`apply-review-r{1,2,3}.mjs` in the session scratchpad) except two held dispositions, recorded with the digests in `docs/masterplan/intent-to-completion/plan-review-notes.txt`: (a) the live v9→v10 bootstrap stage is NOT a plan task (spec §10.1, A33) — it is stated in `plan.index.json` `meta.solution`; (b) cross-owned verify paths are covered by declared deps that the merged index does not carry (candidate v10 improvement: carry deps into the index).
- **Post-wave rule for this run (handoff):** after wave 10 completes and BEFORE `mp finish`, run the live bootstrap stage from the branch (`node scripts/bootstrap-v10.mjs status|arm|record`, per spec §10) through both surfaces, then record `required_successor {slug: v10-validation}` via the pinned v9 `mp event`. `mp finish` is invoked only after `bootstrap-v10.mjs status` reports the pass complete; the v9 goal check assesses G6 live and a skipped stage lands at `goals_unmet`.
- Plan gate (§3b): cross-vendor adversarial review over the artifact bytes (spec.md + plan.md + plan.index.json) via the `adversarial-review` workflow wrapper; record via `mp record-gate-review --gate=plan`. Then §3c alignment audit (clauses A1–A12 from the auditor's Mode A, anchor_quality verbatim), `mp load-plan`, phase → execute.
- 2026-09-03 (cont.): plan gate recorded `done` at hash 5fd620be after three adversarial panels (standard: 1 blocker + 8 should-fix + 3 nits, folded; light: 2 should-fix + 4 nits, folded; light: 1 should-fix → applied post-load as a task amendment via `mp amend-tasks` + `mp amend-plan`, plan_hash restamped) — records in `gate-plan-panel-{1,2}.json`, `gate-plan-review.json`, `gate-plan-notes.txt`; §3c alignment audit 18/18 covered (`alignment-audit.txt`). `mp load-plan` seeded 48 tasks / 11 waves; phase → execute. The pre-finish stage rule is the v2 `pre_finish_stage_required` event: bootstrap through `surfaces_live` before `mp finish` (+ `required_successor {slug: v10-validation}` recorded), the `gate` step inside `branch_finish` before `--choice=merge`.
- 2026-09-03 wave 0 (11 tasks) recorded — code 96cc8e4 (WT), state 2e1e086. Execution mechanism on the Claude harness: the native spawn plan's builder descriptors (lane glm / class bounded-edit) cannot be spawned as Anthropic-only `Agent` subagents and `dispatch_task` is hook-denied, so the orchestrator drove each task through the governed gateway edit tools (`skynet_edit_files` on `dispatch-agentic-loop` = the fleet's masterplan-implementation class; `dispatch-bounded-edit` as fallback) with the task prompt + a read-only context file (spec excerpts, module exports) passed as extra paths, stub files for new targets, and verify commands run in the worktree by `build-wave-result.mjs`. Lesson: the gateway lanes exhaust `max_tokens` on hidden reasoning for large one-shot edits — use `reasoning_effort: low`, split per function, and keep instructions surgical; small precisely-specified fixes were applied deterministically (python patches with regression tests). Adversary seam: 11 per-task `skynet_review_diff` reviews on `dispatch-adversary` over the full wave diff (round 1: 1 approve / 10 rework; every finding folded with tests; config parser needed 8 rounds, seed lock 9). Records: `w0-reviews.json` (scratchpad) → `mp record-result --reviews-file`. The `.owner.lock` vanished mid-wave (a one-shot `mp amend-plan` releases the lock it acquires) — reclaimed with `mp acquire-owner`; the watch-list integrity WARN ("HEAD moved during the wave") was the orchestrator's own plan-amendment commits on MAIN, not a child.

## 2026-09-03 — intent-to-completion: wave 1 recorded (10/10)

Scope: interview ledger (lib/interview.mjs), migrate autonomy, finish-step deploy stage, sweep seed-lock,
runs/context-status enrichment, four doctor checks, install-pi --expect. Adversary lane (gpt-5.6-sol) ran
up to 13 rounds on the interview ledger and 10 on the deploy stage; every finding was folded via
deterministic python patches with a regression test each. Decisions worth keeping:
- Critic receipts are evidence only while their digest-bound artifact is present, intact and well-formed
  (`receipt.valid`); invalid receipts satisfy no gate and change no availability state.
- Critic unavailability is head-bound and needs a dispatchable draft; its acknowledgement is durable in
  the ledger so `exhausted` is replay-derived (crash between ack and end resumes).
- Every interview verb validates its payload before append (no undefined text / absent intent / round 0).
- Deploy stage: `deploy_base.done_sha256` is re-checked on every replay (ad-hoc edits refuse);
  the stage is active whenever `deploy_base` exists (no repeating --merged/--merge-sha);
  reports/authorizations bind to the ordered chain's current step; retry answers failed only,
  rerun answers indeterminate only; attest is offered only for check-less steps; abort only from a gate.
Gateway note: review calls now routinely exceed the 120s MCP foreground window and one 502'd
("shim upstream error: timed out") — retry is the fix, TaskOutput(block) collects the rest.

## 2026-09-03 — intent-to-completion wave 2 (deploy identity, config, env seams, runs-list)

Recorded tasks 12, 18, 21, 24, 35, 44. Code `bbdca1a`, state `6bf9d55`,
scope correction `ddb7e53`. Suite 2050/2053 (three failures owned by later
tasks: two README doctor-inventory rows, one retired-identifier sentence).

Decisions worth carrying:

- **Commit identity is content-only and fails closed on ambiguity.** A branch
  tip is proven in a deploy base by merge ancestry, or by a single squash whose
  verbatim patch-id equals the whole branch diff. Where content cannot separate
  a multi-commit replay from a squash — notably a replay whose prefix cancels,
  and a squash landing after a no-op base prefix — both are refused and the
  operator is told to land as a merge. This supersedes an earlier reviewer
  position that the squash case should be accepted.
- **Receipt provenance on every gate transition.** Authorizations, retries,
  attestations, skips and aborts all audit the same boundary and carry
  `head_after`; a bundle commit made while a gate is open is legal history, an
  unreceipted `commit_paths` commit or any foreign commit is a base move.
- **Gates are durable once opened.** A deleted tag or an unreachable origin is
  not a version bump; a recorded `version_gate` stands until `keep` answers it.
- **PR retirement returns `await_merge`**, resolved only by stage-terminal
  reasons — a merged PR never silently skips the deploy stage.
- **Bootstrap binds to the published tip and tag**, not to whatever the branch
  points at now; corrective passes require a strictly newer untagged version.

Process note, deliberately recorded: **task 24 ran 34 adversarial review
rounds and that was a mistake.** The lane reversed its own round-20 ruling on
squash identity at round 34, which is the point at which it had stopped
locating defects and started expressing preferences. The series was terminated
by operator decision; the wave-2 review record for task 24 is `error`, not
`approve`, because the final revision carries no lane verdict. Later waves
should cap a task's review series and escalate a non-converging reviewer to a
scope question instead of another round.

## 2026-09-03 — intent-to-completion wave 3 (goals contracts, deploy replay, v9 rehearsal)

Recorded tasks 14, 25, 45. Code `a2cf31f`, state `b99d104`, plus corrective `77af416`.
Suite 2117/2120 (the same three failures owned by later tasks).

Decisions worth carrying:

- **The goals-load gate refuses on absence, not just on contradiction.** A waived exit
  needs a readable ledger carrying `interview_waived` — a missing or malformed event list
  is not evidence of a waiver. A reopened interview is refused whatever terminal it also
  claims. The terminal event comes from the ledger; there is no caller-supplied override,
  because a stale one could mask the very ids the coverage gate exists to enforce.
- **Assumptions coverage requires a real Markdown table.** A pipe-prefixed line in prose, a
  second table in the section, and a fenced or indented code example all contribute
  nothing. This spec quotes markdown in several places, so the code mask is load-bearing.
- **Authorizations and starts are paired in ledger order.** Asking whether an authorization
  exists somewhere accepts `authorized, start, start` — the second start is an unauthorized
  rerun, and the recovery probe would record whatever it did as this run's output.
- **The rehearsal drives the driver, it does not imitate it.** Every step is armed and
  recorded in the driver's own order, so a row passes only when the fixture really produced
  what that step's preconditions and postconditions require.

Two process notes, both recorded because they cost real time:

- **The D6 scope guard reverted 23 lines again** — in wave 2 it took `test/finish-step.test.mjs`
  with task 24. The rule learned: when a task changes behaviour that an existing test
  asserts, that test file must be in the task's declared scope, or the fix lands as a
  separate corrective commit outside the wave transaction.
- **The test fixtures were leaking git repos into /tmp** and filled a shared 64G filesystem
  twice, blocking the harness with ENOSPC. Fixed for the four suites this run owns
  (`77af416` and inside wave 3); the rest of the repo's suites leak the same way — ~1900
  stale directories remain from `mp-bin-*`, `mp-continue-*`, `mp-wavecommit-*` and others.
  Worth a repo-wide sweep.

**Task 45 hit the five-round review ceiling** (`review_ceiling` event). Findings narrowed
every round and none was a repeat, but one requirement stayed open: the mismatched-tag,
partial-push and PR-reconciliation dispositions are asserted by the script rather than
driven as arm/record turns, because the driver enforces step order and those steps cannot
be re-entered in a failing state once recorded. Closing it needs fixture bundles poised at
`push` and at `pr_merge` — a second harness. Recorded as a blocking review, not waved
through. The task is plan-scale work in one wave slot.

Handoff for this state: [`docs/handoffs/2026-09-03-intent-to-completion-wave3.md`](docs/handoffs/2026-09-03-intent-to-completion-wave3.md) — verified state, restore paths, and the two operator-approved next steps (repo-wide /tmp fixture-leak sweep; fold task 45's open requirement into task 46).

## 2026-09-04 — intent-to-completion wave 10 recorded — ALL 48 TASKS DONE

Task 20 (the generated knob-inventory guard, the run's last task) recorded with an honest
`rework` verdict after one review round and one fix round: token-aware process.env detection
(template ${...} bodies preserved; only the readEnv seam exempt plus a closed 4-entry
justified allowlist that fails on any addition), exact-set seam assertions, bidirectional
prompt-marker validation. Full suite 2451/2451 — zero failures.

The run's execute phase is COMPLETE (next: complete). Every one of the 48 tasks carries a
review record; across the session's waves 5-10 the single-round-per-task posture (operator's
no-grinding directive) recorded honest rework verdicts with named residuals — every finding
from every round is fixed in the recorded tree, with the fix-unverified disclosure.

## 2026-09-04 — intent-to-completion wave 9 recorded (47/48)

Tasks 8 (public contract), 9 (overlap suite), 19 (knob contracts) recorded with honest
verdicts after one review round each (task 19's round-1 verdict was REJECT; every finding
closed across a builder round plus an orchestrator-finished tail). The full suite reached
2438/2438 — ZERO failures for the first time in the run: the two E9 README failures cleared
with task 8's inventory parity, and the retired-identifiers failure closed with the critic
prompt reword (negated mentions count) plus task 10's earlier work.

Reviews again found real defects: the Environment section missed readEnvAll-proxied controls
(PI_CODING_AGENT); the documented config hierarchy overclaimed seed consumption; llms.txt
still said v9.10.0; the overlap suite was missing resume/abort/gated-vs-loose rows and three
fixture-theater cases; and the knob registry was a fraction of the discovered inventory with
seeded-state observables and self-fulfilling prompt markers — now derived from the exported
inventories behind one shared validator.

RECORDING INCIDENT (resolved): the wave-9 Phase B transaction crashed twice — first D6's
out-of-scope clean deleted test/fixtures/knobs/discovery.mjs (never in the frozen scope),
then the split commit's `git add` refused the tracked plugin manifests because directory-level
gitignore rules covered them. Fixed the .gitignore (file-level rules with re-includes),
reconstructed discovery.mjs byte-exactly from the builder's session transcript (write + two
edits replayed, verified by the 10/10 suite), recorded the scope amendments, and completed
the transaction deliberately per the run's own crash guidance (commit stranded work, then
`mp clear-active-run`): code 736a438, state 3140612. Only task 20 (wave 10) remains.

## 2026-09-04 — intent-to-completion wave 8 recorded (44/48)

Tasks 7 (sequencer contract) and 30 (retro completion rendering) recorded with honest `rework`
verdicts after one review round and one fix round each. The reviews caught: a temporally
impossible critic contract (quoting goals.md before it exists — the critic now quotes the seed
topic); an implementation-mode assessor contract missing from the row that dispatches it; a
documented flag the binary rejected (--done-adhoc-file, now wired); deploy_indeterminate
choices contradicting the engine; whole-document substring tests pinning nothing (now
section-scoped ordered assertions); a dead-exported retro renderer with a timing problem (now
wired into the archive and push-answer transactions); a duplicated classifier (now a thin
re-export); and a first-terminal-answer rule the renderer ignored. Full suite 2410/2413
(3 pre-existing, tasks 8/10 — task 8 lands in wave 9). Two recorded scope amendments
(task 7 += bin flag registration; task 30 += lib/finish-step.mjs seams).

## 2026-09-04 — intent-to-completion wave 7 recorded (42/48)

Task 29 (post-archive push_archive) recorded with an honest `rework` verdict after ONE review
round (mp-adversarial-reviewer) and ONE fix round. The review caught four blocking defects:
a transient fetch failure at the last install step permanently mislabeled a pushed run
`pushed:no`; the --archive-pushed/--archive-push-skipped flags were never wired through the
CLI (the lib answered flags the binary rejected); conflicting terminal answers were accepted
as idempotent replay; and the non-FF recovery was simulated in fixtures, not implemented. All
fixed: durable push_probe states (confirmed_pushed/confirmed_not_pushed/indeterminate with
re-probe + halt), CLI wiring, first-answer-authoritative replay with conflict refusal, a real
fetch/audit/rebase/retry transaction with per-commit provenance checks, remote-bound
archive_pushed (the remote must actually carry the sha), and a merge-base --is-ancestor gate
guard. Full suite 2383/2386 (3 pre-existing, tasks 8/10). Two recorded scope amendments
(bin wiring; push_probe schema fixture consumers).

## 2026-09-04 — intent-to-completion wave 6 recorded (Pi session)

Tasks 6, 28, 48 recorded with honest `rework` verdicts: ONE review round per task
(mp-adversarial-reviewer, adversary lane), every finding fixed in one builder round each,
fixes disclosed as unverified-by-second-round. Full suite 2357/2360 (3 pre-existing, tasks 8/10).

- Reviews found real defects again: `record-goal-check --final` dropped the final-assessment
  bindings the validator demanded (dead forwarding in bin); discard could still enter deploy
  replay; intent rejection was split-write crash-unsafe (a crash between appends archived
  without the required_successor obligation, unrecoverable); final-gate answers were not
  replay-idempotent; attestation had an unrecoverable split window; completion confirmations
  were not bound to the latest deploy base; one empty test concealed an archive gap; and the
  bootstrap driver had NO pre-tag validation — an invalid two-commit release left the v10.0.0
  tag on unreviewed code, and the "no tag" test asserted the opposite of its name.
- Two recorded scope amendments (task 28 += deploy-commit-identity consumer test; task 48 +=
  bootstrap-driver consumer tests) — both consumer updates mandated by semantic/driver
  changes, both applied via the snapshot/amend/re-freeze/reapply path after the wave's work
  existed (the advisor-approved procedure; no work lost this time).
- Waves remaining: 7 (task 29), then 8-10 (7, 8, 9, 19, 20, 30).

## 2026-09-04 — intent-to-completion wave 5 recorded (Pi resume session)

Resumed from `docs/handoffs/2026-09-04-intent-to-completion-wave5.md`. Suite re-verified
(2319/2322; the other 5 failures seen first were Pi-environment artifacts: no
`CLAUDE_CODE_SESSION_ID`, `PI_CODING_AGENT=true`), review posture decided as stop-and-record
per the operator's wrap-up directive — all four tasks recorded with honest `rework` verdicts
naming the unverified post-review fixes, plus a `review_ceiling` note.

- Task 4 scope amended to `lib/config.mjs` (PLANNING_MODES define-once, consumed by
  `lib/resume.mjs`); `state.tasks[].files` refreshed from the amended plan index via
  `amend-tasks` — the plan-index amendments alone had left state/tasks divergent, which
  `prepareWave` refuses at dispatch.
- **Incident:** `mp continue` over the stale `launching` marker ran the crash-scope reset and
  wiped the unrecorded WT work. Recovery: r4 diff snapshots + assert-guarded edit scripts +
  transcript heredocs (incl. one import fixup dropped by a naive heredoc split), verified by
  suite parity. **Rule: never `mp continue` over a WT holding unrecorded wave work — record
  directly.** Why it happened: the handoff's "re-emit dispatch_fabric" was read as op-only,
  missing that crash-reconcile also resets the declared scope in the WT.
- Wave 5 recorded: code `7d926cf` (WT), state `2e93456` (MAIN), 38/48 done.

## 2026-09-04 — intent-to-completion wave 4 (CLI wiring, agent prompts, replay, bootstrap suite)

Recorded tasks 3, 15, 26, 46. Code `d650bcc`, state `5d3c5d4`. Suite 2203/2206 (the same
three failures owned by later tasks). No scope reverts — the wave-2 lesson held twice.

Decisions worth carrying:

- **`mp seed` is a transaction, not a write.** It requires an overlap review, holds the
  repo seed lock across validate-then-create, refuses `overlap_review_stale` when the
  review's inventory digest no longer matches, and leaves nothing on disk when refused. The
  ledger begins `[bundle_created, overlap_review]`; warnings land after, so the review keeps
  second place; a `--force` reseed replaces the ledger too, or the review would drift past
  second.
- **`live_check` offers no skip** (§7.2), enforced in both the rendered gate choices and the
  `--deploy-skip` verb — a run cannot waive the evidence that its own deployment works.
- **The assessor has two modes.** The implementation pass returns no `intent_verdict`
  because nothing is deployed yet; only the final pass, bound to the deployed base, answers
  "does this do what you meant?". Both prompts carry a v1 mode detected from their inputs,
  because this run's v10 prompts are dispatched by a pinned v9.10.0 finish.
- **`legacy` means the field is absent.** Inferring a completion class from ledger events
  would report a class the run never decided.

Two bugs worth remembering, both caught by review rather than by the suite:

- **`blocked_by` could never fire.** A failed step stays `next`, so the "previous step
  failed" branch was unreachable and the field was permanently null — an always-null
  implementation was indistinguishable from the real one *because it was* the real one.
- **`die()` inside a lock leaks the lock.** `process.exit()` never reaches `finally`, so
  every refusal inside the seed lock left it held and the next seed failed. Locked regions
  now throw and release before exiting.

**Tasks 3 and 46 hit the five-round ceiling** (`review_ceiling` event) with one open
requirement each: per-flag accepted finish-stage invocations (the task text assigns the
exhaustive matrix to orchestration-integration), and a successful gate arm+record (needs the
rollout fixture task 47 is declared to build). Both recorded as blocking reviews, not waved
through. Findings narrowed every round and none repeated.

One reviewer finding was disputed with evidence and not accepted: keying the goals-load gate
on the bundle's capability marker breaks a stated contract in this repo ("the seed-time
capability event does NOT block the first goals-load"), so the gate stays keyed on the
interview ledger.

## 2026-09-04 — intent-to-completion wave 5 (implemented + reviewed, NOT yet recorded)

Wave 5 (tasks 4, 5, 27, 47) implemented in the worktree; suite 2316/2319 (the 3 failures are
tasks 8 and 10's, pre-existing). **Nothing is committed and the wave is not recorded** — the
`active_run` marker still says `phase: launching`, so `mp continue` will read this as a crash.
Handoff with verified state and restore paths:
[`docs/handoffs/2026-09-04-intent-to-completion-wave5.md`](docs/handoffs/2026-09-04-intent-to-completion-wave5.md).

Review rounds so far: tasks 4 and 5 at three, tasks 27 and 47 at two — all `rework`, every
finding fixed, none repeated or reversed. Under the five-round ceiling the budget is two more
rounds for 4/5 and three for 27/47; the successor decides whether to spend them or record now.

Four `plan_amended` events extend task scope (27 → `lib/finish.mjs` + `bin/masterplan.mjs`;
5 → `lib/wave-commit.mjs`, then `lib/goals.mjs`; 47 → the driver + rehearsal fixtures). Each
was recorded *before* the edit so D6 accepts it, rather than letting D6 revert and restoring
afterwards as wave 3 did.

The reviews found real product defects, not test churn: `--digest-file` was inert on both
sides (no live digest was ever recorded, and the recorder bound the flag's path string);
`surfaces_live` never executed either surface, so a broken install passed a goal that requires
it to be *executable*; `PASS2_OMITTED` was enforced only as a side effect of ordering, leaving
`release` and `push` reachable if that coincidence changed; the intent confirmation could
authorize a receipt the operator was never shown; and the mid-run goals reminder had its own
markdown scanner that could quote a fenced example the verdict was never judged against — the
parser now captures the raw source line of the field it assigns, so the two cannot diverge.

## 2026-09-05 — Astra consumer routing follow-up

The authorized Sol→Astra migration was already applied in fleet source and MAIN's
routing map by another session, but the intent-to-completion worktree still selected
Sol. Refreshed its routing map through the authoritative generator (also carries
already-authored Gemini fallback/effort changes), corrected current documentation
examples in both trees, and made the WT resolver test check policy-defined effort
rather than a stale xhigh literal. Focused WT routing/registration tests: 53/53.

Fresh gateway probes returned HTTP 200 for bare gpt-6-astra and chatgpt/gpt-6-astra
on both gateways; earlier unavailable-model conclusions are superseded. Catalogue
cost/modality declarations alone do not prove billing or runtime capability loss.
Registered mp-* agents use Astra, but loaded builtin breaker/judge still name
legacy dispatch aliases. No legacy release was modified or activated and unrelated
/srv/workflows WIP remains untouched. Full WT suite: 2451/2451, exit 0 (log /tmp/astra-full-tests-wflmxkzu.log).
Native reviewer run 79d70761 returned clean for the effort assertion and made
successful Bash/Read calls; resolver smoke returned Astra/high. The harness still
marked the job failed: completion_guard incorrectly required edits for this
explicitly read-only review. This is a reporting defect, not repaired here, and the
review proves neither serving-model identity nor whole-release approval.

### Live dispatch evidence supersedes the presumed serving gap

Read `/srv/dev/petabit/litellm/AGENTS.md`: gateway alias ownership moved to
LiteLLM `config/dispatch-policy.jsonc`; the legacy agent-dispatch release is not
the gateway authority. Both authored/install policy and local blue/green config
already map adversary, architecture, critic, cross-review, planned-execution to
Astra. Fresh /model/info on 192.168.109.71:4000 and 192.168.109.72:4000 reports
chatgpt/gpt-6-astra for every one of these five dispatch aliases. All ten alias
chat-completion probes returned HTTP 200 and report_probe({"value":"ok"}).
Responses expose the alias in `model`, so backend attribution comes from the
live model/info mapping, not that response field. Initial probes omitted strict
and returned 400 (`tools[0].strict must be a boolean`); rerun used strict:true.
No production deployment was needed or performed. Legacy CLI provider=Sol is
stale reporting, not evidence of an unmigrated serving route. Reporting defect
and the separate read-only completion_guard defect remain open.

MAIN verification: 1657/1659 full-suite tests pass. Both failures (A1 finish-step
CLI flags, historical handoff references in no-agent-dispatch) reproduce on an
unmodified git-archive of MAIN HEAD: targeted baseline 6/8. They are pre-existing
and remain open; MAIN is not claimed green. Applied the same policy-effort
assertion correction to MAIN as to WT. WT full suite remains 2451/2451.
Fresh generator output byte-matches both repo routing maps. Installed workflow
small tier has unrelated drift (deepseek-v4-flash:max vs canonical without :max);
left untouched. Seven installed mp registrations check in sync with Astra.

## 2026-09-05 — bootstrap live rehearsal failed, release stopped

Routing commits: MAIN aa5f29f, WT 5cf8749. Bootstrap rehearsal armed via driver at
MAIN aa5f29f and executed its exact command with pinned 9.10.0. Exit 1: 58 rows,
30 failed. Failure recorded via bootstrap-v10.mjs record --status=failed, digest
8f60a63013acb966e395716206b28485bc7dc46d347aa31d5a8cf57227e82c11.
Output: /tmp/bootstrap-rehearsal-output.log. Minimal local repro:
resolveTargets('.', {slug:'fixture'}, resolveTargets('.', {slug:'fixture'}))
throws `unknown target: tag`; many failed walk rows cascade from this.
GitHub PR creation/merge/reconcile also failed and need separate diagnosis.

Private scratch repository rasatpetabit/masterplan-rehearsal-164145 remains
(createdAt 2026-09-05T05:29:00Z, verified with gh repo view). Its deletion was
explicitly denied by security policy Bash(gh repo delete *). No alternate deletion
route attempted. Operator cleanup/authorization is required before a live retry.
Advisor directs offline regression/fix first, preserve unknown-key/tag invariants,
then sanctioned failed-step re-arm; no release stage advances on this failure.
No real release tag or production install occurred.

## 2026-09-05 — offline bootstrap rehearsal repair

Recovered partial work from timed-out builder 0fb9803f (both attempts failed; no
accepted builder result). Scoped files: scripts/rehearse-v9-finish.sh and the
actual integration harness test/rehearse-v9-finish.test.mjs. Parent completed
fixture-only fixes and tests: strip derived tag at fixture-override boundary
without changing the armed receipt; resolve canonical repository metadata for PR
commands; retain created-resource identity across metadata failure; never delete
after failed creation; emit cleanup error and identity instead of swallowing it.
Tests consume an actual armStep-produced targets file and preserve its bytes.
New regressions on the original script: 4 failures, 1 already-safe case passed.
Focused suite before review: 33/33; full suite before review: 2455/2455.

Single review 5f3b1872 returned BLOCKING: nameWithOwner drops an explicit host,
risking PR operations/deletion on the default server. Parent reproduced this
with distinct explicit/default fixture hosts, then retained HOST when building
the canonical selector. Host regression red then green; final full WT suite
2456/2456 (exit 0), git diff --check passes. Logs: /tmp/bootstrap-host-red.log,
/tmp/bootstrap-host-green.log, /tmp/bootstrap-full-green.log. All GitHub test
operations used the local shim. One permitted fix round; NO second review.
Review remains blocking-as-returned, host correction fixes-not-re-reviewed; no
release approval or live outcome inferred from offline tests.

Live bootstrap rehearsal remains recorded FAILED. Scratch repository
rasatpetabit/masterplan-rehearsal-164145 still requires operator cleanup. The
explicit gh repo delete policy denial was not bypassed, and no live retry ran.
Future cleanup capability must be authorized/resolved before another live cycle.

## 2026-09-06 — authorized cleanup completed; fixture CI identity repaired

User explicitly authorized agent-owned cleanup and temporary removal/restoration
of only Bash(gh repo delete *) in /home/ras/.claude/settings.json. GitHub OAuth
consent completed, verified delete_repo scope. Verified old scratch identity and
deleted rasatpetabit/masterplan-rehearsal-164145 (exit 0, authenticated 404).
Live rehearsal retry successfully created/merged PR #1 and deleted its own
rasatpetabit/masterplan-rehearsal-3675009 (also authenticated 404). Settings were
restored byte-for-byte to the saved preimage immediately after the run.

Retry remained FAILED (58 rows, 14 failures), recorded by driver with digest
74d966745992a960240e48177d3b47e6204317c8f2e06ca352cb69fe1346c373. Offline
walk-only reproduction exposed first cause: gh_repo_resolved=false because the
live gh_repo is null and the fixture origin is a local bare path. Parent added
a synthetic scratch-derived gh_repo fallback ONLY to fixture target projection;
real gh_cycle targets and production CI checks remain unchanged. New integration
regression reproduces null live gh_repo, asserts fixture CI recovery and surfaces,
and asserts zero gh invocations. Red before fix, green after; full WT 2457/2457.
One separate inline review of this new issue returned clean. Prior host-fix review
remains blocking-as-returned/fixes-unreviewed, not rewritten. Live rerun pending.

## 2026-09-06 — live rehearsal recovered and cleanup verified

After fixture-CI repair 4c99cec, the live rehearsal passed 69/69 rows, exit 0.
Real throwaway GitHub PR #1 merged and its repo was deleted by the script.
Authenticated lookups confirm 404 for the original orphan 164145, first retry
3675009, and final scratch 3783258 (all rasatpetabit/masterplan-rehearsal-*).
The driver recorded rehearsal status=recovered, event index 122, digest
6f5d227dab902959b97d847318435ecad017c118f6b2a4a8646bd9f39e494482.
Exact output is durable at docs/masterplan/intent-to-completion/rehearsal-recovered.log.
The approved temporary settings exception was restored in finally and verified
byte-identical to its preimage. GitHub delete_repo OAuth scope was user-approved
and remains on the CLI credential. Bootstrap next step: docs_normalize. No real
v10 release, production installation, or release-gate approval is implied.

Bootstrap docs_normalize marker and verify are now recorded done. Fresh verify
ran npm test && node bin/doctor.mjs . at WT 4c99cec: 2457/2457 tests, doctor exit 0
with 0 errors and 6 warnings. Bounded evidence and all warning messages are in
docs/masterplan/intent-to-completion/bootstrap-verify-summary.txt; complete local
output /tmp/bootstrap-verify.log (digest in driver event). Next step is review,
then assess. No release approval, publication, or production install yet.

## 2026-09-06 — release review finding fixed once, approval remains open

Native parallel run 4af02f77-d83b-4bdf-847d-a772e8b2d1b9 assessed frozen 4c99cec.
Security slice returned rework: unvalidated metadata could overwrite the successfully
created cleanup identity. Parent verified the cited lines and frozen clean detached
snapshot. Bootstrap review was recorded FAILED: emitted diff-stat exited 0, while
the separately executed structured verdict gate exited 1. Original report is retained
at docs/masterplan/intent-to-completion/release-security-cleanup-review.md. Only the
reported security ranges were reviewed; the remaining release regions are unreviewed.

One parent fix round binds both cleanup paths permanently to the creation selector,
resolves bare selectors through authenticated identity before creation, and validates
metadata owner/name and HTTPS URL scheme/host/path before pushes or PR operations.
Failure status is checked before trusting auth or repository metadata. Test transport
mapping is PROCESS-SCOPED, all actual network protocols disabled; no global Git or
harness setting changes. Seven new regressions failed against the original script,
then passed; focused rehearsal suite 42/42. No post-fix reviewer invocation.

G1–G5 assessor returned achieved/partial/achieved/partial/achieved. G6 explicitly remains
pending, outside pre-publish scope per approved spec:829–838. Parent added two missing
behavioral assertions: intent-only amendment re-arms the spec gate with goals unchanged;
repo-over-user and CLI-over-repo nested config use whole-object replacement. Both pass
without production behavior changes. Original partial verdicts remain unchanged; these
are additional parent-confirmed evidence, not a fabricated assessor approval.

Final npm test && node bin/doctor.mjs . && git diff --check: exit0, 2466/2466 tests,
doctor0 errors6 warnings. Latest fix has NOT been live-rehearsed. Prior live 69/69 receipt
belongs to 4c99cec. Release review remains failed; verification at the new SHA must be
recorded through the driver before advancing. Stop for explicit user decision on review
cap/remaining coverage; no release/tag/push/install or silent review override.

## 2026-09-06 — authorized additional review STOPPED on new blocker

Run fb6ffd18-a8a3-4279-86f6-b608c7e0e27a: all three cross-review tasks denied by
spawn guard (unknown agent preset: release-cross-review), zero verdicts. Project
agent discovery and model-catalog availability did not establish admission; the
new project-local registration remains incomplete. Do not retry under renamed
agents, raw model overrides, or weakened guard. Canonical preset repair required.

General reviewer returned rework after inspecting rehearsal script/test; harness
acceptance rejected its command attestation. Parent verified its three source
findings directly: missing driven pinned finish lifecycle, an extra-commit refusal
row that merely counts commits, and unchecked --only selectors yielding PASS.
Original report retained at pass2-rehearsal-general.md; exact failure status and
corrected parent citations at release-pass-2-outcome.json. No gate approval.

CORRECTION: prior live69/69 is a successful script run, NOT proof that the pinned
v9 full finish lifecycle ran after the surfaces changed. Fixture tests and script
pass rows missed that acceptance criterion. G2/G4 reassessments did not spawn;
their prior partial verdicts and parent-passing added tests remain distinct.

Stopped per explicit user agreement: no further automatic review or fix loop.
WT1f2741f remains unchanged (2466 tests previously passed). No new live rehearsal,
release/tag/push/install. Detached review snapshot removed only after clean check.
Required next decision: authorize targeted rehearsal and canonical preset repairs,
or leave the release paused. Remaining release regions are not approved.

## 2026-09-06 — expand intent-to-completion for design-intent integration

Cross-session handoff reconciled against behavior-skills65eea6a (clean,7 commits
ahead of recorded origin/main; no push) and its spec§5:237–246 DECIDED paragraph.
The later decision wins over the stale blocked header/old standalone-intent.md
design record: one skill-owned interview/schema, native goals.md Intent+ledger,
skill-owned repo reconciliation, critic bound to shared schema.

User AUQ explicitly chose Expand the existing run, not a separate integration run.
Accepted scope/provenance captured in design-intent-scope-amendment.md. Native WT
CLI ran amend-plan against MAIN state, then set-phase brainstorm. All48 task records
remain exactly unchanged/done; goals/spec/index bytes and refs unchanged. This is
scope reopening, not approval of new goals, mapping design or task definitions.

Safety discovery: phase-only reopening still makes mp decide return complete
because all48 tasks are done. After advisory review, acquired native owner lock,
opened design-intent-amendment-approval with mp open-gate, verified mp decide now
returns surface_gate for that exact id, then released ownership. Do NOT clear this
gate or run mp continue before approved goal/spec/task amendments and pending tasks
are durable and required spec/plan gates satisfied. No dummy task or state hand-edit.
Receipt: design-intent-reopen-receipt.json (retains initial complete response too).

Both recon agents returned evidence but harness rejected attestations; primary-source
checks support the decisions above, not a fabricated clean delegation result. Earlier
release-review failures, rehearsal findings, registration admission gap and G6 remain
open. No behavior-skills push, home policy/relay changes, automatic release review
or repair loop. Next: develop exact mapping/ledger/reconciliation/critic amendment,
propose new goals/tasks without replacing the original anchor or completed work.

## 2026-09-06 — autonomous integration draft; one substantive policy fork

User: /masterplan next, run in full autonomy, do not gate unless you have a real
question. Followed current §2d: auto-progress between genuine decisions, no
ceremonial continuation questions; no fabricated goal-amend approval.

Drafted design-intent-integration-draft.md: shared skill/native host boundary,
versioned section representation inside native Intent, meaningful legacy field
projections (Top invariant is NOT done_means), legacy-stable/new-complete hash
binding, actual-interaction ledger, snapshot/reconciliation, and four existing
checkpoints. Proposed six work packages, including separately committed owning-
repo skill changes, plus regression matrix. No implementation has begun.

Draft goals G7/G8 in goals.design-intent.proposed.md pass native validateAmendment;
original anchor and G1–G6 parsed records remain unchanged. Native goals.md, spec,
index,48done task records and safety gate remain untouched. Hashes/validation in
design-intent-amendment-proposal.json. These are unreviewed, unapproved drafts.

Real policy fork D1: native high interview requires8answers/6intent/4rounds, while
the new skill reuses known evidence and asks only real gaps. A complete evidence
set may not meet those minimums. Proposed completeness+fresh critic for new-format
interviews, retaining caps/counters and legacy rules; alternative retains floors
and may require explicit waiver. Original ask demanded more high-complexity
probing, so do not silently change this behavior based only on this session's
full-autonomy instruction. This is the next owner question, not 'continue?'.

## 2026-09-06 — routing-cache patch held for governed review

User reported installed masterplan bounded-edit routing to retired glm-5.2 with fixes committed but unreleased at same version. Confirmed installed cache resolution and that official marketplace/plugin updates return unchanged 9.10.0; source fixes not on published origin/main. Prepared isolated routing-only candidate 4ec1eed (9.10.1) on fix/routing-cache-release from published main: refreshed routing snapshot, synchronized manifests, and corrected one conflating CLI fixture (exit 2 vs ENOENT). 1659/1659 tests, doctor 0 errors 1 stale-cache warning; candidate resolver and real strict-tool probe pass. Native breaker review could not execute; all seven built-in governed roles unresolved against the missing retired policy plane, and policy-authority still references it — no verdict exists and nothing was published or installed. Real wave-3 owner (agent-policy Claude session) already progressed to Pi dispatch; its state untouched. User explicitly chose WAIT FOR GOVERNED REVIEW: no waiver, no publication; documented MP_ROUTING_POLICY override remains the per-invocation unblock. Handoff and decision recorded in docs/handoffs/2026-09-06-routing-cache-release.md. Root TODO.md appeared and remains untouched; paused D1 integration edit preserved.

## 2026-09-05 — repo INTENT.md authored; design-intent skill corrected twice

Ran /design-intent in repo mode; the repo had no INTENT.md. Interviewed the
owner into all three core sections and all four standard extensions, written as
prose. Two owner corrections drove skill changes in the owning repo
(/srv/dev/ai/behavior-skills, edit made, commit blocked by the lane guard and
pending an approved detour): list-type sections must be multi-select with all
four AUQ option slots spent on positions, and free-text answers are a brief to
interrogate, never text to paste into the artifact.

Substantive intent captured beyond the earlier bundle material: off-track means
drift from the owner's intent or from decisions already made — the spec and plan
may change under review and approval, but work must not be left unfinished,
unmerged, undeployed, or stranded in a forgotten worktree. Concurrent masterplan
runs in one repo should become aware of each other rather than conflict or
duplicate. Where the spec is silent the model decides from intent; where
something contradicts its understanding of intent it asks. Understanding intent
up front is bet as equal in value to the spec and plan.

This gives §5 of design-intent-integration-draft.md a live reconciliation source
for the first time — its absent-source branch no longer describes this repo.
Nothing in the intent-to-completion bundle was touched; the paused D1 edit and
root TODO.md remain untouched.

## 2026-09-06 — v9.10.1 routing patch reviewed, fixed once, published

User ordered the review run after my incorrect wait: native code-review workflow
(diff-exact, 13 agents) returned 5 verify-confirmed findings; 2 actionable fixed
(effort-value vocabulary validation replacing a tautological self-compare; single
injected policy load) plus llms.txt/.okf version-surface sync. Correctness-lane
timeouts compensated deterministically: 1659/1659, doctor 0 errors, full map
referential+served-ness integrity PASS, retired refs absent. Final release commit
723e8d6 (reviewed 4ec1eed + fix round, amended), published fast-forward to
origin/main, tag v9.10.1 pushed; CI green on both runs, release-publish created
the GitHub Release. Claude plugin cache installed 9.10.1 and verified from the
consumed path: bounded-edit -> glm-5.3 served, default env. Pi install check_ok.
Spawn-guard subagent lanes remain broken fleet-wide pending the sibling
agent-policy run's migration completion; the workflow review route is the
standing alternative. Wave-3 execution belongs to the sibling session; running
Claude sessions need restart to activate 9.10.1. Receipt:
docs/handoffs/2026-09-06-routing-cache-release-review.md.

## 2026-09-05 — design-intent amendment draft: D1 landed, reconciliation ref bound

Committed the paused D1 edit as made (evidenced completeness wins over the native
numeric interview floors) and cleared D1 from the proposal's unresolved list, so
the artifact heading for the exact-artifact approval is self-consistent.

Bound §5's reconciliation to the run's integration target rather than the
executing branch's worktree. This repo's INTENT.md landed on main while the
implementation branch at 1f2741f does not carry it; without the binding, G8's
repository-intent-drift tests would run on the branch, find no artifact, and
report a clean absent-source state instead of a discrepancy. Absent-source now
means the target has no INTENT.md at all; the resolved ref is recorded beside
path and digest so a moved target is distinguishable from a changed file.

Assessed the draft against the new INTENT.md. §3 fail-closed binding, §7's
"tests are requirements, not evidence", and §8's open gate all serve the stated
posture and invariant. Concurrent-run awareness is NOT a draft gap — G1 already
owns it (overlap_review first event, runs-list with planned_paths/worktree,
test/overlap-sequencer.test.mjs), on the branch. No goals, spec, or plan.index
bytes were touched; design-intent-amendment-approval stays open. Root TODO.md
still untouched. Another session published v9.10.1 (0ffe456) into this repo
mid-turn; no overlap with these files.
