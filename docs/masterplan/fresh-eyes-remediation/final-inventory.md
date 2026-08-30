# Fresh-eyes remediation — final A–F inventory

Run slug: `fresh-eyes-remediation` — release v9.10.0 (commit fc2662b). Disposition legend:
**fixed** = repaired in code/docs; **removed** = deleted dead material; **documented** =
explicitly retained/clarified; **verified** = confirmed clean. Every row carries a
path:line citation to the live fix/proof.

## Section A — behavioral defects (nine findings)

| id | disposition | citation |
|---|---|---|
| A1 goal-gate flags dead | fixed — `--goal-check`/`--goals-choice` threaded into the finish-step ctx | bin/masterplan.mjs:3641, bin/masterplan.mjs:3665, lib/finish-step.mjs:101 |
| A2 default class unresolvable | fixed — `FABRIC_DEFAULT_CLASS` now resolves to the existing `bounded-edit` class | lib/wave.mjs:107 |
| A3 `--fabric=off` seeds unexecutable runs | fixed — flag removed; legacy opt-out no longer accepted | commands/masterplan.md:437 |
| A4 dead blackboard recovery | removed — `recover_from_blackboard` no longer emitted; resume resolves only executable recovery actions | test/resume.test.mjs:65 |
| A5 record-result false 'recorded' | fixed — finalizes only when `recRes.recorded` is non-empty | bin/masterplan.mjs:3442 |
| A6 register-pi-agents mutates on unknown flags | fixed — fail-closed CLI; `--help` read-only | bin/register-pi-agents.mjs:16, bin/register-pi-agents.mjs:212 |
| A7 unknown flags silently ignored | fixed — `rejectUnknownFlags` exits 2 on unrecognized flags; positive cross-check test added | bin/masterplan.mjs:582, bin/masterplan.mjs:888, test/cli-surface.test.mjs:1 |
| A8 workspace-root drift inert off-fleet | fixed — one git-toplevel derivation shared by capture and consumption | lib/watch-integrity.mjs:51, lib/wave-commit.mjs:307, lib/continue.mjs:501 |
| A9 `mp status` stack-traces on missing state | fixed — ENOENT handled via die() convention | bin/masterplan.mjs:3767 |

## Section B — live state & release drift (five findings)

| id | disposition | citation |
|---|---|---|
| B1 CI Doctor red (blocked-task-injection) | fixed — user-attested covering waiver recorded | docs/masterplan/blocked-task-injection/events.jsonl:1 |
| B2 goals-hash mismatches (five bundles) | fixed — re-frozen to current content via `mp goals-amend` | docs/masterplan/dispatch-subagent-reconcile/events.jsonl:1, docs/masterplan/simplify-dedup-2/state-overflow.md:1 |
| B3 `docs/superpowers/` re-populated | fixed — six plans archived; source dir emptied | docs/masterplan/.implemented-plan-archive/centralized-wave-review.md:1 |
| B4 release chain broken | fixed — RELEASING.md documents the tag+push step | RELEASING.md:14 |
| B5 plugin/marketplace drift | documented — detection-only; cleared by wave-5 marketplace re-sync + `/plugin update` (orchestrator step) | lib/doctor/plugin-registry-drift.mjs:92 |

## Section C — dead removable material (ten findings)

| id | disposition | citation |
|---|---|---|
| C1 lib/jsonc.mjs | removed — module + sole test deleted | test/jsonc.test.mjs:1 (deleted with module) |
| C2 dispatch digest exports | removed — zero-consumer exports pruned | lib/dispatch/dispatch-digest.mjs:168 |
| C3 runLocalVerifyCommands | removed — orphaned by transport removal; constants retained | lib/dispatch/verify-transport.mjs:1 |
| C4 finalizeRecord | removed — dead since ab2c8ed; docs corrected | test/dispatch-wave.test.mjs:18 |
| C5 probe (alive/reap) machinery | removed — unreachable on fabric path | test/continue.test.mjs:167 |
| C6 legacy routeTask/resolveTaskBackend | removed — the deferred post-soak follow-up | test/wave.test.mjs:43 |
| C7 agents/mp-explorer.md | removed — dispatched by nothing | test/register-pi-agents.test.mjs:1 |
| C8 test/owner-stress.sh | removed — tracked gate executed by no runner | test/owner-stress.sh:1 (deleted) |
| C9 github-coord zero-caller exports | removed — 5 exports pruned after caller audit | lib/github-coord.mjs:366 |
| C10 lib/hygiene.mjs | documented — retained as the explicit publish-time gate | lib/hygiene.mjs:78, RELEASING.md:5 |

## Section D — stale compat/config (four findings)

| id | disposition | citation |
|---|---|---|
| D1 retired-vocab regex gap | fixed — catches bare `adsp` and `MCP pool` | test/no-agent-dispatch.test.mjs:38, test/no-agent-dispatch.test.mjs:39 |
| D2 hooks.json shim text | fixed — canonical SessionStart description | hooks/hooks.json:3 |
| D3 stale lane aliases | fixed — retired `fable`/`opus` alias claims purged | AGENTS.md:117 |
| D4 CC-only colon name | fixed — bare `mp-planner` dispatch; probe vocabulary removed | commands/masterplan.md:99, commands/masterplan.md:483 |

## Section E — misleading documentation (twelve findings)

| id | disposition | citation |
|---|---|---|
| E1 prompt §2b retired `mp promote-run` | fixed — removed; execute path documented as dispatch-wave | commands/masterplan.md:93 |
| E2 prompt §3 goals/`--approval` | fixed — goals-status surface + required `--approval` | commands/masterplan.md:437, commands/masterplan.md:443 |
| E3 llms.txt version + routing | fixed — release baseline + live references | llms.txt:5 |
| E4 .okf/index.md deleted surface | fixed — live agents/engine; version baseline | .okf/index.md:15 |
| E5 internals run-level contract | fixed — nonexistent contract deleted | docs/internals.md:1 |
| E6 recover_and_redispatch → recover_wave | fixed — renamed across internals docs | docs/internals/bundle-resume.md:32 |
| E7 review-default claim | fixed — documents seeded default-on | docs/internals/task-verification.md:166 |
| E8 verbs.md deleted-engine ref | fixed — execute → `mp dispatch-wave` | docs/verbs.md:38 |
| E9 doctor README inventory | fixed — 19/19 modules inventoried | lib/doctor/README.md:21 |
| E10 skills false claims | fixed — import claims narrowed; suppression claim corrected | skills/masterplan/SKILL.md:76 |
| E11 mp-implementer ghosts | fixed — removed from all five docs | docs/development.md:1 |
| E12 doctor goals broad catch | fixed — narrowed; malformed fixtures diagnose every bundle | lib/doctor/goals.mjs:85, test/doctor-goals-errors.test.mjs:1 |

## Section F — local clutter (three findings)

| id | disposition | citation |
|---|---|---|
| F1 empty tests/ dir | removed — deleted from working tree | tests/ (deleted) — see git status at release commit fc2662b:1 |
| F2 legacy/ gitignored archive | removed — deleted (recoverable from history ≤549b5e1) | legacy/ (deleted) — see git status at release commit fc2662b:1 |
| F3 plugin registry v9.9.1 cache | documented — resolves via `/plugin update` after marketplace re-sync (orchestrator step, wave 5) | lib/doctor/plugin-registry-drift.mjs:92 |
