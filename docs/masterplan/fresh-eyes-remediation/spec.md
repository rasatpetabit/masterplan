# Spec — fresh-eyes-remediation

Remediate every confirmed legacy/dead/incorrect element found by the 2026-08-29
fresh-eyes audit of `/srv/dev/ras/masterplan`, in one bundle across five waves.

**Input evidence:** `audit-findings.md` in this bundle — 4 parallel audit workflow
runs (84 agents: 42 lenses + 42 independent cross-verifiers) over HEAD `5b2bee0`,
with every HIGH item manually re-verified. Baseline at audit time: `npm test`
1649/1649 green; `mp doctor` 24 findings (1 error, 7 warn), exit 1; CI Doctor red.

## Goal

masterplan's documented surface matches its code. Concretely, at exit:

1. `npm test` fully green, including new regression tests for every repaired
   behavioral defect (A-wave).
2. `mp doctor` exits 0 on a clean checkout.
3. CI is green on the merge commit (Doctor step included).
4. No documented `mp` flag, op, or vocabulary is unimplemented, and no dead flag
   is accepted silently.
5. The release flow works end-to-end: CHANGELOG entry → tag → push → marketplace
   re-sync → `/plugin update` resolves the tagged version.
6. `legacy/` and the empty `tests/` directory are gone from the working tree.
7. Every section-E doc/skill claim matches the code (E-wave sweep).

## Scope: five waves

Item IDs reference `audit-findings.md`. Dispositions: remove | repair | document.

### Wave 1 — Behavioral repairs (section A)

| Item | Action |
|---|---|
| A1 goal-gate flags dead | **Repair.** Wire `bin/masterplan.mjs` to the engine's existing vocabulary: `--goal-check=<failed>` / `--goals-choice=<fix\|waiver\|abort>` (per `lib/finish-step.mjs`, `GOALS_CHOICES`). The wiring explicitly includes threading the parsed flags into the finish-step ctx object — the ctx currently omits `goalCheck`/`goalsChoice` entirely on its way to `finishStep()`, so parseArgs recognition alone would leave the gate silently no-op. Rewrite `commands/masterplan.md` §finish to teach these flags (replacing the unimplemented `--goals-met/--goals-unmet/--manual-verdict/--goals-waived/--waiver-reason`). The stray uncommitted marketplace patch adding these two flags becomes obsolete — the repo is the source of truth. |
| A2 default class unresolvable | **Repair.** Repoint `FABRIC_DEFAULT_CLASS` (`lib/wave.mjs`) from absent `masterplan-implementation` to the existing class `bounded-edit` (agent `builder`, `writes: true`, cap `edit`, intent "one well-specified change with a known verification command" — the implementer semantic; rejected `planned-execution` after gate review: it is a non-writing `judge` planner class). The repoint is behaviorally neutral: `bounded-edit` carries the same agent/model chain as today's effective `unknown` fallback, so no in-flight bundle changes lane. Fix the 5 test files pinning the dead name. Registering a dedicated class in the fleet-owned workflow-map source is a fleet-side follow-up, out of scope. |
| A3 `--fabric=off` seeds unexecutable runs | **Repair.** Remove the flag from `mp seed` and all docs (`commands/masterplan.md`, `docs/verbs.md`, `.okf/index.md`); if passed, fail closed with an explanation (fabric is the only path since L2 deletion). `dispatch-wave`'s flag-off "legacy dispatch_fabric ops apply" branch becomes an error too. |
| A4 dead blackboard recovery | **Remove.** Delete `state.blackboard`/`task.handoff_key` read paths and the `recover_from_blackboard` action (`lib/resume.mjs`, `lib/continue.mjs`). |
| A5 record-result false 'recorded' | **Repair.** Write `recorded` only when `recRes.recorded` is truthy; otherwise a distinct no-op status. |
| A6 register-pi-agents mutates on unknown flags | **Repair.** Fail-closed flag parsing; real `--help` that does not write. |
| A7 unknown flags silently ignored | **Repair.** `parseArgs` fails closed (doctor-style exit 2) on unrecognized `--flags` for all `mp` verbs. Compatibility-scan every documented invocation (`commands/masterplan.md`, `docs/verbs.md`, skills, repo scripts) before landing; dedicated tests. Also add a positive implementation cross-check test: enumerate every flag/op/vocabulary named in `commands/masterplan.md` + `docs/verbs.md` + skills and assert each is recognized by `bin` — fail-closed alone cannot prove documented surfaces exist (closes the G5 cheat-hole). Highest-risk item of the bundle. |
| A8 workspace-root drift inert off-fleet | **Repair.** Derive the workspace root from git (toplevel) at BOTH sites — capture (`lib/continue.mjs:533-536`, today `path.resolve(wt.WT,'../..')` assuming yanos-style `.worktrees` nesting) and consumption (`lib/wave-commit.mjs:298-306`, today `path.dirname(MAIN)`); the two compute different roots even on a fleet host, so both must share the one derivation. |
| A9 `mp status` stack trace | **Repair.** ENOENT → `die()` convention. |

### Wave 2 — Live state & CI repairs (section B)

| Item | Action |
|---|---|
| B1 CI Doctor red | **Repair.** Uses `mp record-goal-check` — an already-implemented verb independent of A1's finish-step wiring (proceeds in parallel with wave 1). Record a `goal_check` receipt for the archived `blocked-task-injection` bundle via `mp` (CD-7 — never hand-write state). Doctor exits 0; CI unblocks. |
| B2 goals-hash mismatches | **Repair each.** Re-freeze the 5 drifted bundles (`dispatch-subagent-reconcile`, `fabric-default-dual-reg`, `planf3-ideas`, `simplify-dedup-2`, and `blocked-task-injection` — whose hash-mismatch WARN is independent of B1's ERROR: `record-goal-check` validates against the current `goals.md` hash while the WARN compares it against the frozen hash in events) via `mp goals-load`/amend; address the scalar-cap 245>200 on `simplify-dedup-2`. |
| B3 `docs/superpowers/` re-populated | **Repair.** Relocate the 6 plans to their bundle homes under `docs/masterplan/` (or an archive location), eliminating the persistent false legacy-bundle WARN. |
| B4 release chain broken | **Repair.** Fix RELEASING.md to create tags (ci.yml already gates on them); CHANGELOG discipline: `[Unreleased]` entry per landing. No retroactive tagging of the 6 past releases — one tag at wave 5. |
| B5 plugin/marketplace drift | **Document/verify.** Resolved mechanically by wave 5; wave 2 only confirms the doctor check reports it correctly. |

### Wave 3 — Deletions + config scrub (sections C + D)

| Item | Action |
|---|---|
| C1 `lib/jsonc.mjs` | Remove with `test/jsonc.test.mjs`. |
| C2 dispatch digest helpers | Remove the 10 zero-consumer exports from `lib/dispatch/dispatch-digest.mjs`. |
| C3 verify-transport orphans | Keep `CONTRACT_VERSION` + `DEFAULT_SKYNET_VERIFY_ALLOWLIST`; remove `runLocalVerifyCommands`; fix the misleading header. |
| C4 `finalizeRecord` | Remove; fix `docs/internals/wave-dispatch.md` (names it a live stage). |
| C5 probe machinery | Remove both sides (continueRun + bin); fix the `liveness-check`→`probe` misname in `commands/masterplan.md`. |
| C6 legacy routeTask/resolveTaskBackend | Remove (the deferred post-soak follow-up is now). |
| C7 `agents/mp-explorer.md` | Remove. `mp-adversarial-reviewer.md`: document that review resolves the policy `adversary` class, or remove — decide during wave 3 per its actual registration consumers. |
| C8 `test/owner-stress.sh` | Remove (tracked, executed by no runner). |
| C9 `lib/github-coord.mjs` | Audit whole file first (bin imports some exports); remove only the confirmed-zero-caller functions. |
| C10 `lib/hygiene.mjs` | Retain-intentionally: keep as publish-time gate, state that explicitly in its header + docs. |
| D1 retired-vocab regex gap | Tighten `test/no-agent-dispatch.test.mjs` to catch bare `adsp` and `MCP pool`; fix the 3 live survivors. |
| D2 hooks.json shim text | Update the stale Codex SessionStart per-verb description (also in `docs/install.md`). |
| D3 stale aliases | Purge `fable`/`opus` lane-alias references from AGENTS.md + docs; fix the `fable → litellm/fable-5` claim. |
| D4 CC-only colon name | `commands/masterplan.md` dispatches `masterplan:mp-planner` → use the bare name Pi registers. |

### Wave 4 — Docs & skills corrections (section E)

Correct in place, no restructuring: E1 prompt §2b retired `mp promote-run`;
E2 prompt §3 false goals-block + missing `--approval`; E3 llms.txt version +
routing to deleted-engine docs; E4 `.okf/index.md` + `.okf/wave-dispatch-engine.md`
deleted-surface citations; E5 `docs/internals.md` nonexistent run-level contract;
E6 `recover_and_redispatch`→`recover_wave`; E7 review-default claim flipped;
E8 `docs/verbs.md` deleted-engine ref; E9 doctor README inventory completed
(19/19 modules); E10 both skills' false claims (`masterplan-detect` import
overpromise; `masterplan` host-suppression claim + stale tag); E11 mp-implementer
ghost references (5 docs); E12 doctor goals broad-catch narrowed so no bundle can
silently drop out of the ERROR audit.

### Wave 5 — Release & ops

1. Delete empty `tests/` (untracked) and `legacy/` (gitignored; tracked until
   `549b5e1`, so git history preserves it) from the working tree.
2. CHANGELOG `[Unreleased]` → release version; tag per the fixed RELEASING flow;
   push.
3. Marketplace re-sync past the new tag; `/plugin update`; verify the installed
   plugin resolves the tagged version and its agents carry the Pi-portable
   frontmatter (the `5b2bee0` fix that motivated the audit).
4. Final gate: `mp doctor` exit 0, `npm test` green, CI green on the merge.

## Cross-wave rules

- **CD-7:** state mutation only via `mp` subcommands; bundle commits follow.
- **Per wave:** full `npm test` green before landing; new regression test per
  repaired behavioral defect; per-wave adversarial review (`review.adversary: true`).
- **Compatibility scan before A7:** every documented `mp` invocation must remain
  valid under fail-closed flag parsing (or be updated in the same wave).
- **Mechanical-change discipline:** narrowest deterministic edits; no unrelated
  churn; parser-aware tools for structured files.

## Out of scope

- pi-dynamic-workflows panel work (separate repo, completed 2026-08-29).
- Fleet-side `workflow-map.json` source changes (A2 follow-up if the class
  identity is wanted fleet-wide).
- Retroactive tagging of the 6 past untagged releases.
- New features of any kind.

## Assumptions & Open Decisions

| question | decision | rationale | source |
|---|---|---|---|
| Bundle scope | One bundle, five waves (4 content + release) | Interactions stay consistent (code removal + doc fixes in one story); findings are pre-verified and bounded | user-confirmed |
| `legacy/` directory | Delete locally | Tracked until `549b5e1` → fully recoverable from git history; 1.3M/81 files, zero tracked references | user-confirmed |
| Release wave | Included in this bundle | Unblocks the dead-locked release-publish in the same story | user-confirmed |
| Empty `tests/` directory | Delete | Untracked, empty, zero consumers (test glob is `test/*.test.mjs`) | assumed |
| A1 goal-gate vocabulary | Wire bin to engine vocabulary (`--goal-check`/`--goals-choice`) incl. ctx threading; rewrite prompt to match | Engine vocab already exists in state/ops; minimal diff; supersedes the stray marketplace patch; ctx omission named explicitly so the gate cannot no-op | user-confirmed (gate-review revision) |
| A2 default class | Repoint to existing `bounded-edit` (builder/writes:true/cap:edit); fix 5 test files | `planned-execution` is a non-writing judge class (gate-review catch); `bounded-edit` matches the implementer semantic and is behaviorally neutral vs today's effective `unknown` fallback — no in-flight lane migration; fleet registration is a separate follow-up | user-confirmed (gate-review revision) |
| A3 `--fabric=off` | Remove flag; fail closed if passed | L2 path is deleted; silent acceptance seeds unexecutable runs | assumed |
| A7 unknown flags | Fail-closed exit 2 on all verbs, compat scan first | Mirrors doctor's convention; prevents silent typo'd mutations | assumed |
| C7 `mp-adversarial-reviewer.md` | Decide remove-vs-document during wave 3 from its registration consumers | Audit left it verifier-weakened (~) pending consumer evidence | assumed |
| C8 `owner-stress.sh` | Remove rather than wire into CI | Wiring expands scope; the gate ran under no runner since tracking | assumed |
| C9 `github-coord.mjs` | Partial removal after whole-file caller audit | Verifier flagged bin imports on some exports | assumed |
| C10 `hygiene.mjs` | Retain as documented publish-time gate | Audit disposition retain-intentionally | assumed |
| B4/B5 tagging | No retroactive tags; one tag at wave 5 | Retro-tagging past releases is not cleanly recoverable | assumed |
| B1/B2 decoupling | B1 receipts via `mp record-goal-check` (already implemented, independent of A1); B2 covers 5 bundles incl. blocked-task-injection's hash WARN | Gate review falsified the A1→B1 dependency and found the 5th drifted bundle; both proceed in parallel with wave 1 | user-confirmed (gate-review revision) |
| A8 dual-site fix | One git-toplevel derivation shared by capture (continue.mjs) and consumption (wave-commit.mjs) | The two sites compute different roots today even on fleet hosts | user-confirmed (gate-review revision) |
| Adversarial design review | Masterplan's spec gate (cross-vendor pass over spec.md + goals.md at `set-phase plan`) is the governing review | Sequencer §3b owns the review route; first panel run: 56 agents, 18 findings, 9 survived, all dispositioned by this revision | user-confirmed |
| Flag-strictness compatibility | Scan commands/masterplan.md + docs/verbs.md + skills + repo scripts before A7 lands | A7 is the only repair that can break documented callers | assumed |
