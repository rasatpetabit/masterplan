# Retro — github-coordination

**Feature:** Add the ability to use GitHub for coordination rather than only local files, so a masterplan dev effort can scale across many more LLMs/agents.

**Outcome:** Shipped. 7 tasks across 4 waves, all `done` and committed on `masterplan-ng`. Full suite **461/461**, `publish-hygiene` **18/18**, `doctor` **0 errors**.

## What landed

A GitHub-backed coordination substrate layered onto the existing local-file (CD-7) run bundle, opt-in per bundle and byte-identical to single-agent behavior when absent (A9).

| Wave | Task | Files | Commit |
|---|---|---|---|
| 0 | #1 — pure coordination core | `lib/github-coord.mjs` + test (53/53) | `faad2e9` |
| 1 | #2 — ephemeral bundle path | `lib/paths.mjs` (`resolveEphemeralBundleDir`) | `68ebd62` |
| 1 | #3 — coordination state object | `lib/bundle.mjs` (`setCoordination`/`clearCoordination`, §6 schema, round-trips) | `68ebd62` |
| 1 | #4 — resume branches | `lib/resume.mjs` (`publish_needed` + `coordinate`, gated on coordination state) | `68ebd62` |
| 1 | #5 — doctor coord-drift | `lib/doctor/coord-drift.mjs` (SKIP uncoordinated; WARN orphan claims / done-but-open / map drift) | `68ebd62` |
| 2 | #6 — fs-only mp subcommands | `bin/masterplan.mjs`: `gh-issue-body`, `parse-issue`, `validate-claim`, `select-claimable`, `reconcile-integration`, `coord-status` | `b379605` |
| 3 | #7 — shell wiring + verb-sync | `commands/masterplan.md` §7 publish/follow flow; `publish`/`follow` verbs synced across frontmatter, §1 (16 verbs), §3, `README.md`, `docs/verbs.md`, `test/publish-hygiene.test.mjs` | `cf6d6f5` |

## Architecture decisions (held)

- **Option B — dedicated `mp-coord` contract ref + `mp-int` integration branch** (Q2 at the design gate). The lead publishes a per-task issue board and provisions the contract ref + integration branch on first publish; followers claim disjoint units, work in an ephemeral out-of-tree bundle, and deliver PRs.
- **Wave-batched merge kept in v1** (Q3), deferrable. The integration-merge loop re-checks, guards diff-scope, and aborts on conflict (operator-surfaced).
- **Layer discipline preserved.** All pure logic lives in `lib/github-coord.mjs` (no fs, no network); `bin` stays strictly fs-only (the shell supplies `gh` JSON, mirroring `mp pr-summary`); all `git`/`gh` side effects live in the L1 shell (`commands/masterplan.md`). CD-7 single-writer intact.
- **State gating.** `publish_needed`/`coordinate` resume branches and the coord-drift doctor check are all gated behind the coordination object, so uncoordinated (single-agent) runs are unchanged.

## What went well

- The pure-core-first wave ordering (Wave 0 = `lib/github-coord.mjs`) let every downstream task import a tested foundation; nothing else could start until it landed, which the plan encoded explicitly.
- Verb-sync (anti-pattern #4) held: a fresh-eyes Explore audit confirmed all sync points consistent. Notably `lib/hygiene.mjs` parses reserved verbs *dynamically* from `commands/masterplan.md` (no hardcoded constant), and `docs/internals.md` is a nav index — so both are correctly N/A, not stale.

## What was bumpy

- **Fabricated Workflow handles** recurred early: promoting `active_run` with hallucinated run/task IDs in the same batch as the launch, before reading the real result. Corrected each time by re-reading the launch output. Lesson, applied from Wave 3 onward: **launch → read verified handles → promote in a separate call**, never batched, never invented.
- A stale/fabricated wave-2 task brief (wrong subcommand names) was caught and aborted (`TaskStop`) before it could corrupt the wave-3 shell wiring; relaunched with the canonical `prepare-wave` brief.
- The `src/` worktree dirt (user-owned, untracked) was the D6 baseline every wave; never staged.

## Follow-ups / not in v1

- Wave-batched → per-PR streaming merge (deferred by Q3).
- The feature is implemented + unit-verified in the repo; it has **not** been dogfXooded as a live multi-LLM run, nor deployed to the installed plugin caches (the standing v8 deploy/push gate is unaffected by this branch work).
