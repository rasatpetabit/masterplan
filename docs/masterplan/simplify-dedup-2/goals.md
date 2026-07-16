topic: Masterplan-repo half of simplify-dedup-2 (Run B) — deliver the 13 masterplan tasks split out of the agent-dispatch run (split-spec.md v2), on branch masterplan/simplify-dedup-2, atop the 5 already-landed task commits (1/3/40/46/48).

## G1: Fabric is the single dispatch path — legacy L2 surface deleted, legacy markers reconcile
signal: command
evidence: `mp dispatch-wave` (fabric/broker) is the only wave-execution path and the only planning fan-out path in masterplan. workflows/execute.workflow.js, workflows/plan.workflow.js, the launch_workflow/dispatch_foreground op branches, promote/probe(alive|reap)/recover_and_redispatch machinery, and mp-implementer's skynet edit lane are deleted. Persisted legacy active_run markers reconcile cleanly (auto-convert or explicit ask — never a crash), proven against sanitized legacy-state FIXTURES in CI. Repo grep shows no live references (V5 with its frozen exclusion allowlist); commands/masterplan.md documents only the fabric path. (Tasks: l2-deletion, planning-fanout, marker-reconcile, cmd-docs, dogfood-v1, codex-suppressed-smoke.)

## G2: Fabric per-task adversary review reaches parity with L2 semantics
signal: test
evidence: The fabric path runs per-task adversary review over each task's FULL working diff: verdicts in task digests, blocking verdicts surfaced via the wave-completion protocol, gated by state.review.adversary. A masterplan suite test drives a blocking verdict through dispatch-wave and asserts the wave surfaces it. (Task: per-task-review.)

## G3: qctl scaffolding retained dormant with an executable fabric seam
signal: test
evidence: resolveTaskBackend/qctlEligible and docs/design/qctl-multi-repo-apply.md survive, reachable from a documented seam in the fabric path (not from deleted L2 code). An EXECUTABLE test enters through the fabric path and exercises qctl eligibility (flag-on fixture), plus a negative test proving the shipped flag-off default never selects qctl. (Task: qctl-seam.)

## G4: Skynet dependency inverted on masterplan surfaces
signal: test
evidence: No mcp__skynet__/skynet_ tool reference on the masterplan repo's LIVE surfaces (agents/, lib/, bin/, commands/, skills/, workflows/, hooks/, package manifests — excluding run bundles, spec/goals artifacts, changelogs/historical docs, and the lint's own denylist fixture); the five wrapper agents (mp-planner, mp-subsystem-planner, mp-spec-decomposer, mp-plan-reviewer, mp-goal-assessor) route through agent-dispatch lanes; the portability gate passes over the masterplan tree. (Tasks: wrapper-rewire (MP half), verify-transport-seam.)

## G5: One keyed review re-entry guard replaces three
signal: test
evidence: A single keyed guard module replaces gate-review.mjs/review-companion.mjs/per-task re-entry logic with three distinct key kinds — (gate, kind, key), kind in {artifact-hash, head-sha, run+task+sha} — reading and writing the EXISTING durable event vocabulary (no events.jsonl migration). The re-entry-guard module itself already landed (task 1, commit cc13f70); this run rewires bin/masterplan.mjs, finish-step.mjs, gate-review.mjs, and review-companion.mjs onto it. masterplan suite green over the unified module. (Task: reentry-guard-rewire.)

## G6: Plugin release version bump is consistent and the suite is green at that version
signal: command
evidence: The masterplan plugin version is bumped ABOVE 9.5.0 and the four version-bearing sources agree — .claude-plugin/plugin.json, .codex-plugin/plugin.json, .claude-plugin/marketplace.json, and the README `Current release:` line (asserted by a post-bump jq equality; this REPLACES the deleted doctor check #30 cross_manifest_version_drift the original task cited). `node bin/doctor.mjs` and `npm test` pass at the bumped version. Merge-to-main and plugin-cache install are the run's finish / orchestrator steps (split-spec §3), not part of this goal's evidence. (Task: plugin-version-bump.)
