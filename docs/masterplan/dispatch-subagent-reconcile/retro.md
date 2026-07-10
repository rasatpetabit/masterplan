# Retro — dispatch-subagent-reconcile

## What we shipped

Debt cleanup completing the incomplete migration of masterplan mp-* agent profiles to the agent-dispatch thin-wrapper model:

1. **Strict live-alias `MODEL_MAP`** — `{ fable: 'litellm/fable-5' }` only; dead `opus` entry pruned.
2. **Registration tests** — bidirectional map↔agent equality, all-canonical `model: fable` (incl. SKIP_FOR_PI), fail-closed unknown alias, retained colon-alias / SKIP_FOR_PI exclusion / drift coverage (22/22 green).
3. **`mp-explorer` prose** — no longer claims haiku; describes the fable wrapper default.
4. **Host resync** — `register-pi-agents --check` 0 drift; installed pi agents all `litellm/fable-5`.

## What went well

- Scope stayed debt-cleanup-only (no fabric/doctor/policy redesign).
- Spec- and plan-gate adversary reviews returned approve; advisory P2s were folded into T1/T2 verify before execute.
- Focused test suite made verification cheap and CD-3-citable.

## Friction

- Plan index initially used `schema_version: 1` / boolean `codex` — rejected by load-plan; fixed to `6.0` / `"no"`.
- Finish path needed a late-created worktree (`mp worktree record`) because execute ran on MAIN without the usual continue→worktree kickoff.
- Adversary CLI/MCP harness often omits `output_tokens` / `dispatch_id` on review records; gate receipts had to use job_id + lower-bound tokens.

## Follow-ups (not this run)

- Workflow/doc scrub of leftover opus comments (explicit non-goal).
- Fabric default path / dual-registration collapse (deferred by design).
- Harder T2 body wording assertion beyond `/fable/i` (residual plan-gate P2).
