# Spec: Improve masterplan token use efficiency

**Bundle:** `docs/masterplan/masterplan-token-efficiency/`
**Version target:** v6.0.0
**Date:** 2026-05-22
**Verification ceiling:** local-static (bash -n, wc -c/grep discriminators — no build host or runtime required)

---

## Intent Anchor

- **Mode:** implementation-design — concrete improvements to a specific existing system
- **Repo role:** Claude Code plugin providing `/masterplan` slash command; the "source code" is a markdown orchestrator prompt plus bash hooks and bin/ scripts. No compile step.
- **In-scope paths:** `commands/masterplan.md`, `parts/*.md`, `hooks/masterplan-telemetry.sh`, `bin/`, `docs/`, `parts/contracts/`
- **Out-of-scope repos:** none — self-contained plugin repo
- **Evidence:** CLAUDE.md documents orchestrator-stays-lean as primary anti-pattern; existing telemetry infra in `bin/masterplan-codex-usage.sh`; codex-routing-fix bundle shows ~67% Codex utilization; step-c.md is 110KB, step-b.md 48KB, step-0.md 47KB loaded per execute turn

---

## Scope Boundary

**In scope:**
- Reducing orchestrator-context token count per turn (phase file sizes, subagent output accumulation, state/plan file reads)
- Adding baseline measurement instrumentation to the Stop hook and `bin/masterplan-codex-usage.sh`
- Splitting large phase files into on-demand sub-files
- Introducing coordinator-subagent pattern for 5 heavy read operations
- Splitting `docs/internals.md` into per-coordinator focused docs

**Out of scope:**
- Subagent-internal token counts (bill to the subagent, not the orchestrator)
- Changes to state.yml schema or run bundle format
- Changes to existing flags, verbs, or public behavior beyond what the coordinator pattern introduces
- Optimizing Codex routing eligibility criteria (separate concern)

---

## Problem Statement

A typical `/masterplan execute` turn loads ~196KB of markdown into the orchestrator's context window (~49K tokens at 4 chars/token):
- Router: 11KB
- step-0.md: 47KB (runs on every invocation)
- step-c.md: 110KB
- contracts/: ~28KB

On top of this, subagent outputs (brainstorm anchor fan-out, Codex task returns, verification output) accumulate in the orchestrator's context across a multi-task execute run, causing context window pressure on 15+ task plans and inflating cost on every invocation.

**Target:** 30–50% reduction in orchestrator-context tokens per typical execute turn vs. pre-v6.0 baseline.

---

## Success Criteria

1. `bin/masterplan-codex-usage.sh baseline` reports median orchestrator input tokens per verb, measured before and after v6.0 implementation.
2. Before/after comparison shows ≥30% reduction in orchestrator input tokens for `execute` verb.
3. `bash -n hooks/masterplan-telemetry.sh` passes with no syntax errors after all hook changes.
4. `wc -c parts/step-c-resume.md parts/step-c-dispatch.md parts/step-c-verification.md parts/step-c-completion.md` each shows ≤25KB after split; `test ! -f parts/step-c.md` passes (original file removed).
5. `wc -c parts/step-0.md` shows ≤30KB (from 47KB) after prose pruning.
6. Coordinator fallback smoke test: corrupt the brainstorm-anchor coordinator brief, verify the orchestrator falls through to inline classification without error.

---

## Phase 0: Baseline Instrumentation

**Goal:** Establish a measurable token baseline before any pruning or structural changes.

### Stop hook additions (`hooks/masterplan-telemetry.sh`)

Add a new event type emitted at the end of every `/masterplan` turn:

```jsonl
{
  "event": "turn_context_bytes",
  "turn": N,
  "verb": "<brainstorm|execute|doctor|...>",
  "loaded_files": [
    {"path": "parts/step-0.md", "bytes": 46929},
    {"path": "parts/step-c.md", "bytes": 109939}
  ],
  "subagent_output_bytes": 4200,
  "input_tokens": 48312,
  "ts": "2026-05-22T17:22:34Z"
}
```

The `input_tokens` field reads `$CLAUDE_USAGE_INPUT_TOKENS` (env var exposed by Claude Code at turn end). If the env var is absent (older harness), omit the field rather than erroring.

`loaded_files` is populated by the orchestrator emitting a structured marker before each phase-file Read (new breadcrumb type: `<masterplan-trace file-load path=<path> bytes=<N>>`); the Stop hook's JSONL parser extracts these from the turn transcript.

### `bin/masterplan-codex-usage.sh baseline` subcommand

New subcommand that reads `events.jsonl` from all non-archived bundles and outputs:

```
verb          median_input_tokens  p90_input_tokens  sample_n
brainstorm    12400                18900             5
execute       47800                61200             8
doctor        21300                27400             3
```

**Verification:** `bash -n hooks/masterplan-telemetry.sh` passes; `bin/masterplan-codex-usage.sh baseline` outputs a summary table without error.

---

## Phase 1: Prose Pruning

### 1-sentence rationale rule (universal)

Every multi-sentence "**Why:**" block, "**Rationale:**" paragraph, or historical-context explanation in any phase file is compressed to ≤ 1 sentence:

```
**Why:** <one clause explaining the constraint or historical context.>
```

If the rationale genuinely requires more than one sentence, it moves to the corresponding coordinator doc at `docs/internals/<coordinator>.md` and the phase file gets a `> See docs/internals/<coordinator>.md §<section>.` link.

### Target reductions

| File | Current | Target | Primary cuts |
|---|---|---|---|
| `parts/step-0.md` | 47KB | ≤30KB | Compaction-notice (trim to 2-signal detection, drop JSONL path); codex-degradation self-doubt narrative; worktree --resume multi-match edge cases moved to contracts/ |
| `parts/step-b.md` | 48KB | ≤28KB | Haiku A/B/C brief bodies (move full JSON shapes to `docs/internals/brainstorm-anchor.md`); scope-overlap algorithm moved to contracts/; merge-rules narrative compressed |
| `parts/step-c.md` | 110KB | Split in Phase 2 (P1 pruning applied to sub-files) | — |
| `parts/doctor.md` | 73KB | Coordinator-dispatched in Phase 2 (P1 per-check rationale pruning applied first) | Per-check "Why this check" paragraphs → 1 sentence each |
| `commands/masterplan.md` | 11KB | ≤9KB | CC-3 trampoline narrative; flag-interaction rule prose |

### Deferred-contract extraction (completing contracts/ pattern)

Audit all inline reference material that already has a `parts/contracts/` home and ensure every `> See §...` reference is wired:

- `parts/contracts/cd-rules.md` — move CD-1..CD-10 rule bodies from inline prose; phase files keep rule number + 1-line summary only.
- `parts/contracts/run-bundle.md` — complete the state.yml schema detail extraction; phase files reference `> See parts/contracts/run-bundle.md §<field>.`
- `parts/contracts/agent-dispatch.md` — audit all DISPATCH-SITE references for completeness.

### Compaction-notice trim

Reduce the 3-signal detection logic to 2 cheap signals only:
1. System-reminder substring match (`"session was compacted"`)
2. Preceding-message `/compact` token match

Remove the third signal (JSONL session-file read with PID/mtime checks) — too expensive and rarely fires.

**Verification for Phase 1:** `wc -c parts/step-0.md` ≤ 30720; `wc -c parts/step-b.md` ≤ 28672; `grep -c "Why:" parts/step-0.md` decreases by ≥50% vs. baseline.

---

## Phase 2: Sub-file Splitting

### step-c.md split (110KB → 4 sub-files)

| Sub-file | Content | Loads when | Target size |
|---|---|---|---|
| `parts/step-c-resume.md` | Step C1 (resume controller), state read, first-turn audit log | Every execute turn | ~25KB |
| `parts/step-c-dispatch.md` | Step C2 wave dispatch, eligibility cache build, Codex routing | Before first task dispatch | ~25KB |
| `parts/step-c-verification.md` | Step C3 verification logic (PASS patterns, trust-skip, G.1 mitigation) | After each task completes | ~20KB |
| `parts/step-c-completion.md` | Step C4–C6 (retro trigger, loop scheduling, cleanup, failure recovery) | On plan completion or failure | ~20KB |

The router `commands/masterplan.md` gains lazy-load directives for each sub-file. A typical mid-plan turn loads `step-c-resume.md` + `step-c-dispatch.md` (~50KB) instead of the full 110KB.

**Sub-file loader contract:** Each sub-file begins with a `<!-- Loaded by: execute path, condition: ... -->` comment so future maintainers know when it fires. The router comment format mirrors the existing `> **Loads on demand:**` pattern.

### doctor.md: coordinator dispatch

`/masterplan doctor` verb route changes from inline load to coordinator dispatch (see Phase 3 for the coordinator contract). `parts/doctor.md` is retained as-is for the coordinator to read; it is no longer loaded into the orchestrator's direct context. The orchestrator receives a compact findings JSON (see Phase 3 `doctor` coordinator spec).

**Verification for Phase 2:** `wc -c parts/step-c-resume.md` ≤ 25600; `wc -c parts/step-c-dispatch.md` ≤ 25600; `wc -c parts/step-c-verification.md` ≤ 20480; `wc -c parts/step-c-completion.md` ≤ 20480; `grep "Loads on demand" commands/masterplan.md` matches 4 new step-c sub-file entries.

---

## Phase 3: Coordinator-Subagent Pattern

### Core contract (`parts/contracts/coordinator.md`)

A **coordinator subagent** is a read-only Sonnet or Haiku subagent that:

1. Loads one or more large phase/data files internally (the coordinator pays the context cost, not the orchestrator)
2. Optionally dispatches further Haiku subagents via the `Agent` tool (nested dispatch for parallelizable sub-tasks)
3. Returns a **compact JSON result ≤ 1000 tokens** to the orchestrator
4. **Never writes `state.yml`, `events.jsonl`, or any run artifact** (CD-7 compliance — orchestrator is the canonical writer)
5. Uses `DISPATCH-SITE: coordinator-<name>` as the first line of its brief

**Failure contract:** If a coordinator returns malformed JSON or errors, the orchestrator falls through to the existing inline path (current behavior). Every coordinator site has an inline fallback — the pattern is safe to ship incrementally. The fallback is logged as `{"event":"coordinator_fallback","site":"<name>","reason":"<error>"}` in `events.jsonl`.

### Coordinator 1: Brainstorm anchor (`coordinator-brainstorm-anchor`)

**Replaces:** 3 parallel Haiku agents dispatched directly from the orchestrator (Step B1)

**How it works:**
- Orchestrator dispatches 1 Sonnet coordinator with topic + repo context
- Coordinator internally calls 3 Haiku subagents (project-docs, run-state, repo-sketch) in parallel
- Coordinator merges returns and performs anchor classification
- Returns single compact JSON anchor to orchestrator

**Return shape:**
```json
{
  "mode": "implementation-design",
  "repo_role": "Claude Code plugin...",
  "verification_ceiling": "local-static",
  "in_scope_paths": ["commands/", "parts/"],
  "out_of_scope_repos": [],
  "evidence": ["CLAUDE.md: ...", "WORKLOG.md: ..."],
  "interview_depth": {"complexity": "high", "target_question_count": "8-12"},
  "coordinator_version": "1"
}
```

**Tier:** Sonnet (needs judgment for anchor classification and merge logic)
**Docs:** `docs/internals/brainstorm-anchor.md`

### Coordinator 2: Doctor checks (`coordinator-doctor`)

**Replaces:** Loading `parts/doctor.md` (73KB) into orchestrator context

**How it works:**
- Orchestrator dispatches 1 Sonnet coordinator for `/masterplan doctor [--fix]`
- Coordinator loads `parts/doctor.md` internally, runs all 36+ checks
- When `--fix` is set, coordinator applies safe fixes and returns patch results
- Returns compact findings JSON

**Return shape:**
```json
{
  "pass": 30,
  "warn": 4,
  "error": 2,
  "findings": [
    {"id": "#18", "severity": "error", "summary": "codex_routing=auto but no detection event in last 5 runs", "fix_available": true},
    {"id": "#35", "severity": "warn", "summary": "task 3 missing **Files:** block", "fix_available": false}
  ],
  "fix_applied": ["#18"],
  "coordinator_version": "1"
}
```

**Tier:** Sonnet (needs to understand check logic and apply context for --fix)
**Docs:** `docs/internals/doctor.md`

### Coordinator 3: Task verification (`coordinator-task-verify`)

**Replaces:** Orchestrator collecting and evaluating verify command output inline (Step C3)

**How it works:**
- Orchestrator dispatches 1 Haiku coordinator with the task's verify commands and expected PASS pattern
- Coordinator runs commands, evaluates output against pattern
- Returns pass/fail + 3-line excerpt

**Return shape:**
```json
{
  "status": "pass",
  "exit_code": 0,
  "excerpt": "✓ syntax OK\n✓ 0 errors found\n",
  "commands_run": ["bash -n hooks/masterplan-telemetry.sh"],
  "pattern_matched": "PASSED?|OK|0 errors",
  "coordinator_version": "1"
}
```

**Tier:** Haiku (mechanical pass/fail evaluation, no judgment needed)
**Docs:** `docs/internals/task-verification.md`

### Coordinator 4: Bundle resume read (`coordinator-bundle-resume`)

**Replaces:** Orchestrator reading `state.yml` + `events.jsonl` + `plan.md` directly on resume (Step 0 / Step C1)

**How it works:**
- Orchestrator dispatches 1 Haiku coordinator with the bundle path on bare `/masterplan` or `--resume`
- Coordinator reads the 3 files, extracts situation-report fields
- Returns compact situation report

**Return shape:**
```json
{
  "phase": "executing",
  "current_task": "Task 5: Update step-c-dispatch.md",
  "next_action": "dispatch Codex for T5",
  "pending_gate": null,
  "autonomy": "loose",
  "last_5_events": ["wave_2_complete", "T4_committed", "T5_started"],
  "task_summary": [
    {"idx": 1, "status": "complete"},
    {"idx": 2, "status": "complete"},
    {"idx": 5, "status": "in-progress"}
  ],
  "coordinator_version": "1"
}
```

**Tier:** Haiku (structured read + summarize, no judgment)
**Docs:** `docs/internals/bundle-resume.md`

### Coordinator 5: Plan parser (`coordinator-plan-parser`)

**Replaces:** Orchestrator reading `plan.md` directly to build the eligibility cache (Step C1)

**How it works:**
- Orchestrator dispatches 1 Haiku coordinator with the plan.md path
- Coordinator reads plan.md, parses task annotations, builds structured task list
- Returns structured task list JSON; orchestrator works from this JSON, never needing the raw plan.md in its context

**Return shape:**
```json
{
  "total_tasks": 15,
  "schema_version": "5.0",
  "tasks": [
    {
      "idx": 1,
      "name": "Add turn_context_bytes event to telemetry hook",
      "files": ["hooks/masterplan-telemetry.sh"],
      "codex_eligible": true,
      "parallel_group": "wave-1",
      "verify_commands": ["bash -n hooks/masterplan-telemetry.sh"],
      "status": "pending"
    }
  ],
  "eligibility_cache_hash": "sha256:abc123",
  "coordinator_version": "1"
}
```

**Tier:** Haiku (structured parse, no judgment)
**Docs:** `docs/internals/plan-parser.md`

---

## Internal Documentation Split

**Current state:** `docs/internals.md` is a single large document (~300+ lines) covering the entire orchestrator design, dispatch model, context architecture, and failure modes.

**Target state:** `docs/internals.md` becomes a lightweight index (~50 lines, links only). Each coordinator and major subsystem gets its own focused doc:

| New doc | Content | Audience |
|---|---|---|
| `docs/internals/brainstorm-anchor.md` | Anchor classification logic, 3-Haiku brief bodies, merge rules, audit-mode gate | Maintainers changing B1 |
| `docs/internals/doctor.md` | All 36+ check descriptions, fix procedures, severity rationale | Maintainers adding/fixing checks |
| `docs/internals/task-verification.md` | PASS pattern matching, trust-skip logic, G.1 mitigation, verify-pattern override | Maintainers changing C3 |
| `docs/internals/bundle-resume.md` | Resume controller logic, state.yml field semantics, legacy migration path | Maintainers changing resume flow |
| `docs/internals/plan-parser.md` | Plan format spec, annotation syntax, eligibility cache build algorithm | Maintainers changing plan format |
| `docs/internals/wave-dispatch.md` | Wave batch assembly, parallel-group rules, Codex routing decision tree | Maintainers changing C2 |
| `docs/internals/coordinator-pattern.md` | Coordinator contract, failure handling, CD-7 compliance, tier selection | Maintainers adding new coordinators |

**Migration rule:** Content currently in `docs/internals.md` is moved (not duplicated) into these focused docs. Each phase file that previously linked to `docs/internals.md §<section>` is updated to link to the specific coordinator doc.

**Verification:** `wc -l docs/internals.md` ≤ 60 after migration; each `docs/internals/*.md` file exists and is non-empty; `grep -r "docs/internals.md" parts/` shows 0 results (all references updated to specific coordinator docs).

---

## Implementation Order

1. **Phase 0** — Instrumentation (Stop hook + baseline subcommand). Enables measurement.
2. **Baseline capture** — Run 3 representative runs; record pre-v6.0 token counts.
3. **Phase 1** — Prose pruning across all phase files. No behavior change; verify with `wc -c`.
4. **Phase 2** — Sub-file split for step-c.md; doctor coordinator dispatch stub.
5. **Phase 3** — Implement all 5 coordinator contracts; update dispatch sites.
6. **Docs split** — Migrate `docs/internals.md` to `docs/internals/*.md`; update all cross-references.
7. **Post-implementation baseline** — Run same 3 test runs; compare token counts.
8. **Version bump** — Update `.claude-plugin/plugin.json` to `6.0.0`; update CHANGELOG.md.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Coordinator returns malformed JSON | Medium | Low | Inline fallback at every coordinator site (logged to events.jsonl) |
| Sub-file split breaks a rarely-exercised code path | Medium | Medium | Each sub-file independently grep-verified; doctor check #36 (router size) updated |
| Prose pruning removes a constraint that was load-bearing | Low | High | Per-file diff review; grep discriminators for key constraint phrases before/after |
| `$CLAUDE_USAGE_INPUT_TOKENS` env var not available in current harness | Medium | Low | Field is optional; omitted if absent; `wc -c` proxy metric still works |
| internals.md migration breaks existing external links | Low | Low | Old anchors → redirects or "moved to X" stubs in internals.md index |
