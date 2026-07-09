# Retro — planf3-ideas

**Topic:** Import planf3's novel ideas into masterplan — bidirectional plan-graph refs (incl. cross-repo), post-approval plan amendments, an always-on assumptions ledger, a narrative-rich deterministic plan render, multi-run discovery, and dangling-run visibility.

**Outcome:** 26 tasks / 8 waves, all green (1373/1373 tests, doctor 0 error / 0 warn). 9/9 goals met. Branch `masterplan/planf3-ideas` ready to merge.

## What went well

- **Five new pure-decision modules landed clean and well-factored:** `lib/refs.mjs` (idempotent (repo,slug)-keyed upsert/remove + reciprocal construction + path-traversal guard), `lib/amend.mjs` (append-only `## Amendments` writer with heading-escape scheme), `lib/runs.mjs` (event-dominant multi-run discovery with realpath de-dupe + per-bundle error isolation), `lib/doctor/dangling-run.mjs` (shell-safe resume commands), `lib/doctor/spec-assumptions.mjs` (version-scoped assumptions check). All injectable-fs for unit testability; no disk in the cores.
- **Bidirectional refs work end-to-end:** `mp refs add` writes both bundles in one invocation; `mp status` surfaces the refs block; cross-repo discovery is live (`other_runs` lists bundles from multiple repos).
- **The plan render is offline + narrative-rich:** purpose/problem/solution meta, refs, amendments, and goals render with zero network; absent assets produce no broken `<img>`.
- **Goals held:** the frozen 9-goal set mapped cleanly to test/command signals, making the goal check objective rather than subjective.

## What failed / was surprising

- **Per-wave adversarial review silently skipped for all 8 waves.** `dispatchWave` read the legacy flat `state.codex.review` instead of the canonical nested `state.review.adversary`, so this bundle (armed `review:{adversary:true}`) launched every wave review-off. Fixed in `2c8af3f`, but the run had already completed unreviewed. The skip was invisible at execution time.
- **Retroactive review exposed a deeper fleet-integrity defect (the big one).** Re-running the 8 wave reviews post-hoc, the `mp-adversarial-reviewer` subagent produced findings that didn't match the real code — fabricated-looking symbols, wrong line numbers, nonexistent commits. Investigation with **unfakeable SHA-256 probes** proved the cause: the subagent's Bash executed on a **divergent, off-mesh host** (different `machine-id`, older kernel, inactive syncthing, a git HEAD `0dcd6864` that isn't a valid object on the orchestrator's repo at all). The reviewer faithfully reviewed that stale host's wrong bytes — it was not confabulating. `agent-dispatch` routing was deterministic and correct throughout; the recorded spec/plan *gate* reviews (run in-process) were clean. The defect is **subagent Bash landing on a stale peer**, which silently corrupts any repo-reading subagent task (reviews, investigations, diffs).
- **Layer 3+4 hardening landed as a result:** the orchestrator now captures a task's diff inline (host-independent) and the reviewer guards its host identity (machine-id + HEAD) before any local git, failing loud as `inconclusive` on mismatch. Proven e2e both ways.

## Verification coverage

- `npm test`: **1373/1373 pass** (refs, amend, plan-merge, runs-list, doctor, refs-preservation, migrate, bundle, execute-workflow incl. 3 new Layer 3+4 cases).
- `mp doctor`: **16 findings, 0 error, 0 warn** (adversary-lane-health PASS, dangling-run PASS over 20 bundles, worktree-integrity PASS, plan-index-schema PASS).
- All `node --check` syntax gates green; all doc-keyword presence checks found; functional commands (`runs list`, `sweep`, `render-plan`, `status`) exit 0.
- Goal check: 9/9 achieved (user-attested manual verdict — the subagent assessor was cross-host-unsafe for this run).

## Lessons

1. **A subagent's Bash is not guaranteed to share the orchestrator's filesystem on a multi-host fleet.** Any review/investigation/diff task that trusts the subagent's local repo state can silently see stale bytes. Inline-diff (Layer 3) or host-identity guards (Layer 4) are mandatory; bare `git diff` in a subagent is unsafe until the fleet routing is fixed.
2. **Review-config key drift (flat vs nested) was invisible because the skip was silent.** A doctor check for "armed-but-zero-invocations" (already present at finish time) is the right backstop; consider a per-wave "review expected but ran off" warning.
3. **Anti-fabrication receipts (goal check, gate review) are worth their complexity** — they pin the exact tuple (goals hash + HEAD + diff hash) so a stale verdict can't silently pass.
