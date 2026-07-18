# Retro — simplify-dedup-2 (Run B / masterplan)

## What this run accomplished

Run B delivered the masterplan-repo half of simplify-dedup-2: fabric is the sole execute-wave path, L2 Workflow surface is deleted, planning uses `dispatch_plan` + concurrent `dispatch_task`, verify-transport packaging is fixed, and the plugin is bumped to **9.6.0**.

### Delivered (12/12 tasks)

| Wave | Work |
|------|------|
| 0–1 | Prior landings (reentry guard, adapters, v5 tooling, detect-host) |
| 2 | Qctl fabric seam + legacy marker reconcile |
| 3 | V1 dogfood (adversary digests / blocking_reviews) + verify-transport D1–D3 |
| 4 | C4 codex-suppressed fabric smoke; **dispatch_fanout → dispatch_task pool** |
| 5 | **L2 deletion** — workflows, mp-implementer, launch_workflow/dispatch_foreground; commands/masterplan.md fabric-only; V5 clean |
| 6 | Plugin version **9.6.0** (all version sources + package.json + CHANGELOG) |

### Verification (finish)

- `npm test`: **1567/1567 pass**
- `node bin/doctor.mjs`: **0 errors** (4 warns: dangling runs / plugin cache stale / pi registration drift)
- Doc greps: no `launch_workflow|dispatch_foreground|promote-active-run|probe|reap` in `commands/masterplan.md`
- `scripts/v5-orphan-grep.sh`: **OK**
- Goals G1–G6: user-attested **achieved**

## What went well

- Split Run A/B kept masterplan edits single-repo and unblocked agent-dispatch rollout.
- Retiring MCP `dispatch_fanout` mid-run forced the durable fix (bounded `dispatch_task` pool) instead of papering over.
- V5 orphan-grep + survivor allowlist made L2 deletion mechanically checkable.

## What was hard

- L2 deletion touched ops, continue, tests, op-table, docs, and v5 in one wave; partial attempts needed full-suite green before commit.
- Goal-check finish path required a full anti-fabrication receipt tuple (hash/HEAD/diff/verify/clean).
- Spec gate re-armed on goals amend at finish — expected, but easy to miss mid-flow.

## Follow-ups (orchestrator / Run A)

1. **Merge** `masterplan/simplify-dedup-2` → `main` and **install plugin 9.6.0** into the cache (split-spec 8b/8c).
2. **Run A** (agent-dispatch simplify-dedup-2): re-run task 10 V4 greps after plugin install; C1 still user-gated for mcp.mjs.
3. Reopen **cleanup-organize-cc-mcp** brainstorm after simplify lands.
4. Doctor WARNs: stale plugin cache, pi agent registration drift, dangling blocked-task-injection owner.

## Decisions worth remembering

- Fabric is default and exclusive for execute waves; no L2 rollback path remains in ops.
- Planning op name is `dispatch_plan` (not MCP fanout); transport is concurrent `dispatch_task`.
- Release evidence is four version files + package.json + CHANGELOG, not deleted doctor check #30.
