topic: Import planf3's novel ideas into masterplan — bidirectional plan-graph
refs (incl. cross-repo), post-approval plan amendments, an always-on
assumptions ledger, a narrative-rich deterministic plan render with optional
shell-side images — plus multi-run discovery and dangling-run visibility so
interrupted runs (especially in sub-repos) never silently stall.

## G1: Bidirectional cross-run refs exist and cannot drift
signal: test
evidence: test/refs.test.mjs covers add/remove/reciprocal-write/idempotent-upsert/missing-target; `mp refs add` writes both bundles in one invocation.

## G2: Refs are surfaced to humans
signal: command
evidence: `mp status` on a bundle with refs prints a refs block; `mp render-plan` embeds ref links in plan.html header.

## G3: Post-approval plan changes leave an auditable in-artifact trail
signal: test
evidence: test coverage for `mp amend-plan` — first-use section creation, append-only ordering, empty-summary refusal, plan_amended event; amendments render in plan.html.

## G4: Assumptions persist in every new spec
signal: docs
evidence: commands/masterplan.md brainstorm flow requires the "Assumptions & Open Decisions" section pre-approval; doctor WARNs (spec-assumptions) on a non-archived bundle spec lacking it, with a test fixture.

## G5: The plan render is narrative-rich yet still offline and self-contained
signal: test
evidence: render tests prove purpose/problem/solution meta, refs, amendments, and goals render with zero network; absent assets produce no broken <img>; present assets/*.png embed by slot name.

## G6: Narrative meta flows through both planning paths without breaking old bundles
signal: test
evidence: mp-planner (serial) and merge-plan-fragments --meta (parallel) carry {purpose, problem, solution}; validate-plan-index accepts indexes with and without the fields.

## G7: Runs can find each other across repo boundaries
signal: test
evidence: test/runs-list.test.mjs — `mp runs list` inventories bundles in MAIN and a nested sub-repo fixture (depth cap, .worktrees/node_modules exclusion), honors extra roots + .discovery.yml, and derives last_activity; cross-repo `mp refs add --repo=…` writes reciprocals across repos.

## G8: Interrupted runs surface instead of dangling
signal: test
evidence: doctor `dangling-run` check WARNs on a stale fixture (not a fresh one) with the exact resume command; session `mp sweep` report carries the same dangling entries; `mp status` shows the other-runs block.

## G9: The whole import lands green and documented
signal: command
evidence: npm test passes; `mp doctor` clean on this repo; docs/verbs.md, docs/internals/, CHANGELOG.md updated.
