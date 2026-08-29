# Fresh-eyes audit — verified findings inventory (2026-08-29)

Source: 4 parallel deepseek-v4-flash audit workflows (84 agents: 42 lenses + 42 independent
cross-verifiers) over /srv/dev/ras/masterplan @ 5b2bee0, plus manual git-grep/call-site
verification of every high-severity item. Baselines: `npm test` 1649/1649 green; `mp doctor`
24 findings (1 error, 7 warn) exit 1; CI Doctor step therefore red.

Every entry below was **confirmed** by an independent verifier agent AND (for HIGH items)
re-verified manually. `~` marks verifier-weakened items. Dispositions: remove | repair |
document | retain-intentionally.

## A — Dangerous behavioral defects

1. **Goal-gate completion path is dead** (HIGH, repair). `lib/finish-step.mjs` emits the
   `run_goal_check` op (:546) but NONE of the documented continuation flags exist:
   `--goals-met`, `--goals-unmet`, `--manual-verdict`, `--goals-waived`, `--waiver-reason`
   have 0 matches in `bin/masterplan.mjs` / `lib/finish-step.mjs`. commands/masterplan.md:241,247
   instruct them. Compounded by D4 (unknown flags silently ignored) → goals-enabled runs
   degrade silently at finish.
2. **Default task class is unresolvable** (HIGH, repair). `lib/wave.mjs:110`
   `FABRIC_DEFAULT_CLASS = 'masterplan-implementation'` is absent from
   `policy/workflow-map.json` classes → `resolveWorkClass` (lib/dispatch/routing-policy.mjs:58)
   falls back to `workflow.defaultClass: "unknown"`. Every unpinned implementer task routes
   to the catch-all. 5 test files pin the dead name, masking it: test/wave.test.mjs:76,84;
   test/qctl-fabric-seam.test.mjs:54; test/task-review.test.mjs:78;
   test/dispatch-wave.test.mjs:1113; test/bin-masterplan.test.mjs:3024,3031.
   Related: the checked-in map refresh is blocked on this host (generate.mjs exits 1: lane
   `mid` model litellm/qwen3.7-plus not in enabledModels) — policy/workflow-map.json:100-107.
3. **`--fabric=off` seeds unexecutable runs** (HIGH/MED, document+repair). Legacy L2 wave
   path is deleted (`lib/continue.mjs:179` `fabricActive = true; // L2 deleted`), yet
   `mp seed --fabric=off` is documented (bin/masterplan.mjs:899-902, commands/masterplan.md:438,
   docs/verbs.md:245, .okf/index.md:83) and `dispatch-wave` flag-off returns
   "legacy dispatch_fabric ops apply" (lib/dispatch-wave.mjs:612-618) — ops that no longer exist.
4. **Dead blackboard crash recovery** (MED, remove). `state.blackboard` / `task.handoff_key`
   read but never written (lib/resume.mjs:247-249, 281-320); `decideNextAction` can emit
   `recover_from_blackboard` (lib/resume.mjs:315) which `continueRun` has no case for
   (lib/continue.mjs switch; grep = 0 handlers) → lands in a decide-error ask.
5. **record-result finalizes wave-dispatch record to 'recorded' even when the transaction
   recorded nothing** (MED, repair). bin/masterplan.mjs:3385-3400 writes status 'recorded'
   whenever the record was 'pending', regardless of `recRes.recorded`.
6. **register-pi-agents mutates on any unknown flag** (HIGH, repair).
   bin/register-pi-agents.mjs:188-189 parses only `--check`; `--help` (or any typo) runs a
   full write of all 8 agent files under ~/.pi/agent/agents and exits 0.
7. **mp subcommands silently ignore unknown flags** (MED, repair). bin/masterplan.mjs:537-550
   parseArgs collects any `--flag` without recognition — typo'd flags on mutating verbs
   (set-phase, mark-task, record-result, finish-step) are silently dropped. Contrast doctor
   (fail-closed exit 2).
8. **Workspace-root drift detection inert off-fleet** (MED, repair). lib/continue.mjs:533-536
   gates on hardcoded `/^\/srv\/dev$/` + wrong-depth derivation; consumed at
   lib/wave-commit.mjs:298-306. Silently does nothing on any non-fleet host.
9. **mp status stack-traces on missing state file** (LOW, repair). bin/masterplan.mjs:3696-3697
   uncaught ENOENT instead of die() convention.

## B — Live state & release drift (blocks CI / releases)

1. **CI Doctor step red on committed state** (HIGH, repair). .github/workflows/ci.yml:34-35
   runs `node bin/doctor.mjs`; doctor exits 1 on ERROR: bundle `blocked-task-injection`
   archived with goals_enabled but no goal_check receipt or waiver
   (docs/masterplan/blocked-task-injection/state.yml:4,19 + events.jsonl). Release-publish
   dead-locked downstream.
2. **Goals-hash mismatches** (MED, repair each). Bundles dispatch-subagent-reconcile,
   fabric-default-dual-reg, planf3-ideas, simplify-dedup-2 (doctor WARN; scalar-cap 245>200
   on the last one).
3. **docs/superpowers/ re-populated with 6 recent plans** (MED, repair) → persistent false
   legacy-bundle WARN whose fix text (`mp import`) cannot ingest them
   (lib/doctor/legacy-bundle.mjs:42-56,80-84).
4. **Release chain broken** (MED, repair). Six releases v9.7.3→v9.9.3 untagged;
   ci.yml release-publish depends on tags; RELEASING.md never creates one; HEAD 5b2bee0
   unrecorded in CHANGELOG ([Unreleased] empty).
5. **Plugin/marketplace drift** (MED, document). Host cache v9.9.1 vs marketplace v9.9.3
   (lib/doctor/plugin-registry-drift.mjs:92-98); marketplace lags HEAD by unpushed 5b2bee0 —
   a /plugin update would ship agents with frontmatter documented to break under Pi.

## C — Dead removable material

1. **lib/jsonc.mjs** — zero runtime consumers; only test/jsonc.test.mjs imports it
   (test header cites a deleted module). Remove both (or fold stripping into the inlined
   consumers). (R1 + R4 confirmed.)
2. **lib/dispatch/dispatch-digest.mjs** — 10 exported digest helpers with 0 consumers
   (isValidDispatchField:49, extractDigestFromOutput:86, buildFrozenDispatchRecord:277,
   buildDispatchField/stampDigest/blockedDigest/failedDigest/DIGEST_REQUIRED_FIELDS/
   VALID_STATUSES/VALID_DISPATCH_OUTCOMES:379-387). Broker-era surface. Remove/strip.
3. **lib/dispatch/verify-transport.mjs runLocalVerifyCommands (:35-83)** — orphaned by the
   transport removal; header claims a verify duty nothing performs. Keep only CONTRACT_VERSION
   + DEFAULT_SKYNET_VERIFY_ALLOWLIST (imported by continue.mjs:52, dispatch-wave.mjs:54,
   dispatch-digest.mjs:19) or relocate them.
4. **finalizeRecord (lib/dispatch-wave.mjs:1035-1132)** — never called since ab2c8ed; sole
   writer of status 'dispatched'. Docs still name it the live 6th pipeline stage
   (docs/internals/wave-dispatch.md:137,202). Remove + fix docs.
5. **probe (alive/reap) machinery in continueRun** — unreachable
   (lib/continue.mjs:269,315-316,340-341,210,256; bin/masterplan.mjs:2157). Also:
   commands/masterplan.md:86,300 names the nonexistent op 'liveness-check' (real name 'probe').
   Remove both sides together.
6. **Legacy routeTask/resolveTaskBackend routing brain** — dead code with a broken rollback
   story (lib/wave.mjs:51,106-111,244-246; lib/dispatch/ops.mjs:23-30); its deletion was
   "DEFERRED to a post-soak follow-up" per wave.mjs comment — this is that follow-up.
7. **agents/mp-explorer.md** — registered + drift-checked, dispatched by nothing. Remove.
   ~agents/mp-adversarial-reviewer.md — never named by prompt/code; review resolves the
   policy 'adversary' class (breaker role). Document or remove.
8. **test/owner-stress.sh** — tracked Guard-D acceptance gate, executed by no runner. Wire or
   remove.
9. **~lib/github-coord.mjs** — 5 exported pure functions with zero production callers
   (dedupKey:134, findDuplicates:151, canTransition:186, nextWaveToPublish:356,
   mergeBatchPlan:478); verifier notes bin imports others — audit whole file before deleting.
10. **lib/hygiene.mjs** — test-only consumer (test/publish-hygiene.test.mjs). Keep as a
    publish-time gate (retain-intentionally) or state that explicitly.

## D — Stale compat/config

1. **Retired-vocab enforcement gap** (MED, repair). test/no-agent-dispatch.test.mjs:38
   `/\badsp[-_]/g` misses bare `adsp`; live bare-word survivors: lib/dispatch/backend.mjs:26
   ('adsp descriptor'), lib/wave.mjs:193 ('adsp seam adapter'), lib/dispatch-wave.mjs:472
   ('MCP pool' — no pattern at all).
2. **hooks/hooks.json:8** — Codex SessionStart shim carries stale per-verb description text
   (also inlined in docs/install.md:26).
3. **Stale aliases**: AGENTS.md:40 ('fable → litellm/fable-5' claim); docs reference retired
   `fable`/`opus` lane aliases absent from workflow-map.json since 2026-08-28
   (docs/development.md:110-115, docs/conventions/plan-annotations.md:13,17,
   docs/internals/plan-parser.md:21,30, .okf/index.md:80-81).
4. **commands/masterplan.md:99,484 dispatches CC-only colon name `masterplan:mp-planner`**
   which bare-only pi registration deletes as drift.

## E — Misleading documentation (agents following these make wrong calls)

1. **commands/masterplan.md §2b step 3 (:170-173)** teaches the retired L2 transport
   (`mp promote-run`) (HIGH).
2. **commands/masterplan.md §3** — `status` claims a goals block `mp status` never renders
   (:444); `goals-load` invocation omits required `--approval` (:438).
3. **llms.txt** — reports v9.2.0 (actual v9.9.3, :5) and routes models to .okf docs
   describing the deleted Workflow engine (:7-12).
4. **.okf/index.md** — L2 row + Key components cite deleted workflows/ surface (:37,46);
   L3 agent list names deleted mp-implementer, omits mp-goal-assessor + mp-alignment-auditor
   (:38); release version v9.5.0 (:15); routing notes claim fable/model_group wrappers (:80-81).
   .okf/wave-dispatch-engine.md:11 describes deleted execute.workflow.js.
5. **docs/internals.md:49-68** — documents a run-level stop_reason/critical_error/
   scheduled_yield contract that does not exist in code.
6. **docs/internals/bundle-resume.md:32,79,86 (+task-verification.md:78)** — action
   `recover_and_redispatch` renamed `recover_wave`.
7. **docs/internals/task-verification.md:166 + wave-dispatch.md:168** — claim review "off by
   default"; seed defaults review ON.
8. **docs/verbs.md:38** — execute references deleted execute.workflow.js.
9. **lib/doctor/README.md:35-63** — inventory documents 9 of 19 check modules.
10. **skills/masterplan-detect** overpromises `/masterplan import` for artifacts import
    cannot ingest (SKILL.md:L18-23,37). **skills/masterplan** — false "mp continue never
    returns dispatch_fabric under host suppression" claim + stale "Residual 3B" tag
    (SKILL.md:L151-160).
11. **mp-implementer referenced post-deletion** in docs/coordination-playbook.md:21,
    docs/development.md:119, docs/contracts/masterplan-contracts.md:240,
    docs/verbs.md:110-112, docs/internals.md:33 (agent deleted in c5bba82).
12. **doctor goals check swallows per-bundle errors** via broad catch (lib/doctor/goals.mjs:240)
    — a bundle can silently drop out of the ERROR-severity audit.

## F — Harmless local clutter (report only)

1. `tests/` — empty untracked directory, zero consumers (test glob is `test/*.test.mjs`).
   Remove locally.
2. `legacy/` — gitignored, 1.3M/81 files, zero tracked references; keep locally or delete
   (git history preserves the content). Owner decision.
3. Plugin registry v9.9.1 host cache — resolves via `/plugin update` once marketplace is
   re-synced past 5b2bee0 (see B5).

## Explicit non-findings (checked and cleared)

- `plugins/masterplan` symlink → intentional marketplace layout.
- `lib/doctor/legacy-bundle.mjs` module itself — live, wired, correct (its WARN input is B3).
- doctor exit code — exits 1 on errors (fail-closed); an earlier "exit 0" observation was a
  `| tail` pipeline artifact.
- Test suite green (1649/1649); no skipped tests; glob `test/*.test.mjs` covers every test file.
- Verifier rejection rate across all 4 runs: ~0 overreach (1 weakened-in-part, no rejects).
