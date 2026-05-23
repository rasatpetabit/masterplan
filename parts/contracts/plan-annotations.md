# Plan Annotations Contract

## Writing-plans Brief (Step B2)

Brief `superpowers:writing-plans` with these annotation directives in addition to CD-1 + CD-6:

### Codex annotation

Default every single-file task to `**Codex:** ok` — code edits AND doc edits. Mark `**Codex:** no` only when ANY of: (a) multi-file edit, (b) ambiguous scope, (c) no known verification command, (d) explicit scope-out from the user. The orchestrator's eligibility cache parses these as overrides on the heuristic checklist.

### Parallel-group annotation (v2.0.0+)

When you identify mutually-independent verification, inference, lint, type-check, or doc-generation tasks, group them with `**parallel-group:** <thematic-name>` (e.g., `verification`, `lint-pass`, `inference-batch`). Each parallel-grouped task MUST have a complete `**Files:**` block declaring its exhaustive scope. Codex-eligible tasks should NOT be parallel-grouped — they fall out of waves at dispatch time per FM-4. Use `**parallel-group:**` for read-only or gitignored-paths-only tasks. Place parallel-grouped tasks contiguously in plan-order.

### Verify-pattern annotation (v2.8.0+, optional)

When a task's verification command output does NOT match the default PASS pattern (`PASSED?|OK|0 errors|0 failures|exit 0|✓`), add `**verify-pattern:** <regex>` in the per-task `**Files:**` block. The implementer's `commands_run_excerpts` (1–3 trailing output lines per command) is regex-matched at trust-skip time per G.1 mitigation. Codex-routed tasks ignore this annotation (Codex review at 4b is the verifier).

### Skip handoff

**Skip your Execution Handoff prompt** ("Plan complete… Which approach?"). /masterplan has already decided execution mode — do not ask the user. Write the plan and return control.

### Complexity-aware brief

The orchestrator passes `resolved_complexity` (`low`, `medium`, `high`). Adjust accordingly:

- `low` — flat task list ~3–7 tasks; single-file `**Codex:** ok` default; SKIP `**parallel-group:**` guidance; `**Files:**` blocks OPTIONAL.
- `medium` — current defaults apply; `**Files:**` encouraged; `**parallel-group:**` optional.
- `high` — REQUIRE `**Files:**` block per task (exhaustive); REQUIRE `**Codex:**` annotation per task; ENCOURAGE `**parallel-group:**` for verification/lint/inference clusters. Because every task carries a well-formed annotation pair, Step C step 1's Build path always takes the inline fast-path at `high`.

### Plan-format markers (v5.0)

Every task MUST include these structured markers in order before the task body (parsed by `bin/masterplan-state.sh build-index`):

~~~markdown
### Task <N>: <name>

**Files:** <comma-separated paths>
**Parallel-group:** <wave-X or none>
**Codex:** <ok|no|true|false>
**Spec:** [spec.md#L<a>-L<b>](spec.md#L<a>-L<b>)
**Verify:**
```bash
<verify commands>
```

<task body>
~~~

Doctor check #35 enforces this on v5.0 plans. Plans without annotations fall back to heuristic-only.
