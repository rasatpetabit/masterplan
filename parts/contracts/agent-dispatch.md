# Agent Dispatch Contract

> **Scope:** This contract governs every `Agent` tool invocation made by the
> `/masterplan` orchestrator (directly or transitively via superpowers skills).
> It is the authoritative source for brief shape, model selection, DISPATCH-SITE
> tagging, Codex routing, and per-turn tracking. Phase files (`parts/step-*.md`,
> `parts/doctor.md`, etc.) reference this file rather than duplicating rules.

---

## Bounded brief shape

Every subagent dispatched from `/masterplan` — directly or via
`superpowers:subagent-driven-development` / `superpowers:executing-plans` —
MUST receive a **bounded brief** with all five sections:

1. **Goal** — one sentence, action-oriented.
   _Example: "Convert `<source>` into a spec at `<path>` following
   writing-plans format."_

2. **Inputs** — explicit list of files / data to consume. No implicit "look
   around the codebase" without a starting point.

3. **Allowed scope** — files/paths the subagent may modify. Or
   `"research only, no writes"` for read-only agents.

4. **Constraints** — relevant CD-rules (at minimum CD-1, CD-2, CD-3, CD-6 for
   implementer subagents), autonomy mode, time/token budget if relevant.

5. **Return shape** — exactly what the orchestrator expects.
   _Example: "Return JSON `{path, summary}` only — do not narrate."_

### What the subagent does NOT receive

- The orchestrator's session history.
- Earlier subagent raw outputs (pass digest, not raw).
- The full plan file when only one task is in scope.
- Conversation breadcrumbs from the user.

### Output digestion rule

When a subagent returns, **digest before storing**:

- Pull only load-bearing fields: pass/fail status, commit SHA, key file paths,
  blocker description, classification result.
- Write the digest into `events.jsonl` / `state.yml` (per CD-7); discard
  verbose output.

---

## Model-tier selection

**STRUCTURAL REQUIREMENT.** Every `Agent` tool call MUST pass an explicit
`model:` parameter. Inheriting the parent model (Opus) on a subagent is a
billing error.

| Tier | When to use | Subagent types | Examples |
|---|---|---|---|
| `haiku` | Read-only, mechanical, bounded | `Explore` | Grep batches, file inventories, YAML parsing, log scrapes, glob scans |
| `sonnet` | General implementation / review | `general-purpose`, most others | Multi-step features, code generation, conversion, PR review, debugging |
| `opus` | Deep reasoning required | `Plan`, `feature-dev:code-architect` | Architecture decisions, ambiguous specs, security analysis |

**Default when uncertain:** `model: "sonnet"`.

**Heuristic:** if the task fits in a 5-bullet bounded brief, Haiku handles it.
If it needs design judgment or trades off competing concerns, escalate to Sonnet.
Reserve Opus for tasks that genuinely require it.

### Phase-by-phase assignments

| Phase | Subagent type | Model | Return shape |
|---|---|---|---|
| Step A (state parse) | parallel Haiku per worktree (or per ~10-file chunk) when worktrees ≥ 2 | `haiku` | `[{path, format, frontmatter, parse_error?}]` JSON |
| Step I1 (discovery) | parallel `Explore` agents, one per source class | `haiku` | structured candidate list (JSON-shaped) |
| Step I3 (source fetch) | parallel per candidate | `haiku` (except branch reverse-engineering → `sonnet`) | raw source content keyed by candidate id |
| Step I3 (conversion) | parallel Sonnet per legacy candidate | `sonnet` | new spec/plan paths + 1-paragraph summary |
| Step C (eligibility cache) | one Haiku at Step C step 1 | `haiku` | `{task_idx → {eligible, reason, annotated}}` |
| Step C (per-task implementation) | `superpowers:subagent-driven-development` | `sonnet` (default) | done/blocked + evidence + `task_start_sha` + `tests_passed` + `commands_run_excerpts` |
| Step C 3a (Codex EXEC) | `codex:codex-rescue` in EXEC mode | Codex (out-of-process) | diff + verification output |
| Step C 4b (Codex REVIEW) | `codex:codex-rescue` in REVIEW mode | Codex (out-of-process) | severity-ordered findings or `"no findings"` |
| Completion-state inference | parallel Haiku per task chunk | `haiku` | classification (done/possibly_done/not_done) + evidence |
| Step D (doctor checks) | parallel Haiku per worktree when N ≥ 2 | `haiku` | findings list grounded in `<file>:<issue>` |
| Step S (situation report) | parallel Haiku per worktree when N ≥ 2 | `haiku` | structured JSON digest per worktree |

### Opus exception

`model: "opus"` is permitted ONLY when the user selects "Re-dispatch with a
stronger model" at the blocker re-engagement gate (Step C step 3). All other
Opus dispatches are a cost-contract violation.

---

## DISPATCH-SITE tagging

For the telemetry hook (`hooks/masterplan-telemetry.sh`) to attribute cost at
orchestrator-step granularity, every Agent dispatch MUST include a literal
`DISPATCH-SITE: <site-name>` line as the **FIRST LINE** of the prompt, followed
by a blank line, then the bounded brief body.

### Format

```
DISPATCH-SITE: <site-name>

<Goal / Inputs / Allowed scope / Constraints / Return shape>
```

For v5 phase files, use the form `DISPATCH-SITE: <phase-file>:<site-label>`.
Examples: `DISPATCH-SITE: step-c.md:wave-N1-01`, `DISPATCH-SITE: step-a.md:state-parse`.

### Canonical site table (monolith step names)

| Dispatch site | DISPATCH-SITE value |
|---|---|
| Step A state parse | `Step A state parse` |
| Step B0 related-plan scan | `Step B0 related-plan scan` |
| Step C step 1 eligibility cache builder | `Step C step 1 eligibility cache` |
| Step C step 2 wave dispatch (per wave member) | `Step C step 2 wave dispatch (group: <name>)` |
| Step C step 2 SDD inner calls (implementer / spec-reviewer / code-quality-reviewer) | `Step C step 2 SDD <role> (task <idx>)` |
| Step C step 3a Codex EXEC | `Step C 3a Codex EXEC (task <idx>)` |
| Step C step 4b Codex REVIEW | `Step C 4b Codex REVIEW (task <idx>)` |
| Step I1 discovery (per source class) | `Step I1 discovery (<source-class>)` |
| Step I3.2 fetch wave (per candidate) | `Step I3.2 fetch (<source-class> <slug>)` |
| Step I3.4 conversion wave (per candidate) | `Step I3.4 conversion (<slug>)` |
| Step I3.5 import hydration guard (per candidate) | `Step I3.5 hydration guard (<slug>)` |
| Step S1 situation gather | `Step S1 situation gather` |
| Step R2 retro source gather | `Step R2 retro source gather` |
| Step D doctor checks | `Step D doctor checks` |
| Completion-state inference (per chunk) | `Step I completion-state inference` |

A dispatch missing the tag still records to `<plan>/subagents.jsonl` but with
`dispatch_site: null` — per-step attribution is lost, though
`subagent_type + description` fingerprinting can partially recover it.

New dispatch sites added in future revisions MUST extend this table AND emit the
corresponding tag.

---

## Codex routing

### When to route to Codex (`codex:codex-rescue`)

- **Bounded well-defined coding task**: clear inputs, clear acceptance criteria,
  no session history needed.
- **Stuck**: Claude Code has tried and failed 2+ approaches on the same coding
  task.
- **Second-pass review**: want an independent cross-model review of inline work
  (Step C 4b).

### When to use a standard Agent subagent instead

- Task is exploratory or requires session context.
- Task is primarily research / reading (not writing code).
- Task is open-ended and benefits from conversation continuity.

### Codex call rules

- `codex:codex-rescue` is its own `subagent_type` and routes out-of-process.
  Do **NOT** pass `model:` to Codex calls.
- Codex EXEC brief shape: `Scope / Allowed files / Goal / Acceptance /
  Verification / Return`.
- Codex REVIEW brief includes: task + acceptance + spec excerpt +
  diff range (`<task-start SHA>..HEAD`) + files in scope + verification +
  `Scope=review-only` + `Constraints=CD-10`.
- Record model as `codex` in `subagents_this_turn` tracker (not `haiku` /
  `sonnet` / `opus`).

### Availability checks and degradation

Before Step C, the orchestrator verifies Codex is available (default: `ping`
mode — dispatches a 5-token health-check). If unavailable:

- Treat `codex_routing` and `codex_review` as `off` for the run (persisted
  config unchanged).
- Append a degradation event to `events.jsonl`.
- Step C routes inline, suffixing `(codex degraded — plugin missing)` to each
  affected task banner.

**Running inside Codex host:** `codex_routing` and `codex_review` are forced
`off` in-memory to prevent recursive dispatch. Configured values are preserved.

---

## Recursive application — verbatim SDD preamble

When invoking `superpowers:subagent-driven-development`,
`superpowers:executing-plans`, or any skill that itself dispatches inner
Agent/Task calls, the orchestrator's brief MUST include the following preamble
**VERBATIM** as its first paragraph (before the bounded-brief sections):

```text
For every inner Task / Agent invocation you make (implementer, spec-reviewer,
code-quality-reviewer, or any other inner subagent), set model: "sonnet". The
ONLY exception is when this orchestrator turn carried --blocker-stronger-model=opus
on the parent dispatch — in that case use model: "opus" for the implementer only.
Do not omit the model parameter; omitting it causes the inner Task to inherit
Opus from the parent session, which violates this orchestrator's cost contract.
```

The sentinel string `For every inner Task / Agent invocation you make` is
grepped by `bin/masterplan-self-host-audit.sh --models` to confirm the preamble
is present. Do **not** paraphrase — paraphrase risks dropping the constraint
when the upstream skill template parses keywords.

---

## Per-turn dispatch tracking

The orchestrator MUST maintain a session-local `subagents_this_turn` list.
Reset at the start of every top-level Step entry (A, B, C, I, S, R, D, CL).

**Per-dispatch record** (push immediately on every Agent invocation):
- `ts` — ISO 8601 timestamp
- `dispatch_site` — matches the literal `DISPATCH-SITE:` value sent
- `model` — literal value passed to `model:`, or `sdd:sonnet` / `sdd:opus`
  for SDD invocations, or `codex` for `codex:codex-rescue`

**End-of-turn summary** (emit before any turn-closing action when
`subagents_this_turn` is non-empty):

```
Subagents this turn: <N> dispatched (<count by model summary>)
  • <dispatch_site> ×<count if >1> (<model>)
```

Example:
```
Subagents this turn: 6 dispatched (2 haiku, 3 sonnet, 1 codex)
  • Step C step 1 eligibility cache (haiku)
  • Step C step 2 SDD wave member ×3 (sdd:sonnet)
  • Step C 3a Codex EXEC (codex)
  • Step A status parsing (haiku)
```

Zero-dispatch turns emit nothing.

**Cross-validation at Step C entry:** compare `subagents_this_turn` model
values against the most-recent records in `<run-dir>/subagents.jsonl` (written
by the Stop hook). On divergence, append a `model_attribution_drift` event and
surface an `AskUserQuestion` offering to run
`bin/masterplan-self-host-audit.sh --models`.

---

## Telemetry record (reference)

The Stop hook captures one record per Agent dispatch into
`<plan>/subagents.jsonl`:

| Field | Value |
|---|---|
| `subagent_type` | agent type string |
| `routing_class` | `"codex"` / `"sdd"` / `"explore"` / `"general"` |
| `model` | literal model parameter (or `"codex"`) |
| `dispatch_site` | value from `DISPATCH-SITE:` tag, or `null` |
| `duration_ms` | wall-clock time |
| `input_tokens` / `output_tokens` / `cache_creation_tokens` / `cache_read_tokens` | token breakdown |
| `prompt_first_line` | first non-blank line of the prompt |
| `tool_stats` | per-tool call counts |

Cost-distribution health metric: `opus_share = sum(opus_tokens) / sum(all_tokens)`.
Healthy: `< 0.1`. Regression threshold: `> 0.3`.
See `docs/design/telemetry-signals.md` for the full schema and jq cookbook.
