# Spec: Improve Use of Subagents and Parallelism

**Bundle**: improve-subagents-parallelism  
**Date**: 2026-05-22  
**Verification ceiling**: local-static (grep + bash -n; no runtime smoke required)  
**Autonomy**: gated  

---

## 1. Intent Anchor + Scope Boundary

**Intent**: Audit the masterplan orchestrator prompt and fix places where it violates its own dispatch rules, misses parallel dispatch opportunities, or inlines work that should go to subagents — reducing cumulative context growth across the full session.

**Anchor mode**: implementation-design (the prompt *is* the program; there is no separate runtime).

### In scope

| Artifact | What changes |
|---|---|
| `parts/step-b.md` | Add parallel-group annotations; add return-shape caps to subagent briefs; add return-shape cap to adversarial-review companion output; check path-discovery sequence for CC-2 pattern (v6.1.0 additions) |
| `parts/step-c-resume.md` | Audit inline reads (Haiku delegation misses); add return-shape caps to uncapped briefs |
| `parts/step-c-dispatch.md` | Audit coordinator-plan-parser tasks[] for item-count cap; add cap if missing |
| `parts/step-c-verification.md` | Add parallel-group annotation for pre-exec checks; add return-shape caps |
| `parts/step-c-completion.md` | Audit only; fix if hits found (16KB, low expected hit rate) |
| `parts/step-0.md` | Add return-shape caps to any uncapped briefs |
| `parts/step-a.md` | Audit only; fix if hits found |
| `parts/doctor.md` | Add checks **#46** (CC-2 self-enforcement) and **#47** (return-shape caps) |
| `docs/internals/coordinator-pattern.md` + `docs/internals/wave-dispatch.md` | Clarify CC-2 rule wording to match prompt enforcement (`docs/internals.md` is now a 26-line navigation index; §3/§6 content migrated to these focused docs in v6.0.0) |
| `bin/masterplan-self-host-audit.sh` | Add `--brief-style` flag for structured JSON audit output |

### Out of scope

- Upstream superpowers skills (not this repo's source)
- Slice β/γ (parallel committing tasks) — deferred per `docs/design/intra-plan-parallelism.md`
- Guard D owner sentinel — deferred per `docs/masterplan/concurrency-guards/spec.md`
- Doctor check parallelism (sequential by design; interleaving breaks human-readable report)
- Structural rewrites of phase prompts beyond targeted annotation/cap additions

---

## 2. Problem Definition + Root Causes

Three failure modes drive cumulative context growth:

### Failure Mode 1 — Inline reads that belong behind Haiku

The orchestrator reads files directly in its own context during routine operations (spec inspection, state.yml validation, plan verification). Each file loaded inline is tokens the orchestrator never gets back.

CC-2 (documented in CLAUDE.md and `docs/internals/coordinator-pattern.md`) says: dispatch Haiku before reading files >300 lines, or before Bash commands expected to print >100 lines. The orchestrator has no self-enforcement of CC-2 — it is a model-memory rule that degrades after every context compaction.

**v6.0.0 coordinator coverage:** The coordinator pattern (5 dispatch sites) deployed in v6.0.0 addressed the heaviest CC-2 violators: coordinator-bundle-resume reads state.yml + events.jsonl + plan.md internally; coordinator-plan-parser reads plan.md for eligibility cache. These are the biggest inline-read sites. What remains: non-coordinator inline reads in step-c sub-files and any new patterns introduced after v6.0.0.

**v6.1.0 new instance:** The adversarial-review B2 foreground call dispatches `node ... adversarial-review --scope working-tree --wait ...` and the orchestrator parses its output inline (pass/fail heuristic). This is a direct CC-2 violation — an external process output of unbounded length parsed inline without a Haiku gate.

### Failure Mode 2 — Sequential independent dispatch where parallel is legal

Wave dispatch (Slice α) permits read-only agents to run in parallel via `parallel-group:` annotations. Several independent read-only subagent sequences currently run serially: Step C pre-execution checks (config validation, state integrity, repo health) have no data dependencies on each other but run one-after-another. Serial execution adds wall-clock wait with no correctness benefit.

### Failure Mode 3 — Unbounded returns + missing dispatch gates (merged)

Two manifestations of the same root cause: the orchestrator cannot enforce shape contracts on its own or its subagents' outputs.

**Sub-C1 (unbounded returns)**: Some subagent briefs have no word/token/item count in their return-shape spec. An uncapped Sonnet implementer asked to "verify all wave members completed" may return the full task list prose rather than a structured digest, landing verbatim in the orchestrator's context.

The contract system (`contract_id` + coverage validation) exists to enforce return-shape bounds, but several lifecycle dispatches in the step-c sub-files lack contract annotations, so coverage validation passes silently without checking the shape.

**v6.0.0 coordinator gap:** The 5 coordinator briefs introduced in v6.0.0 are themselves subagent dispatch blocks with return shapes. `coordinator-plan-parser` returns `tasks: [{idx, name, files, codex_eligible, ...}]` — the tasks array has no explicit item-count cap in the brief. A 50-task plan returns a 50-element array verbatim into orchestrator context. Coordinator-to-orchestrator return shapes are Sub-C1 violations if uncapped.

**v6.1.0 adversarial-review new instance:** The adversarial-review B2 companion output is raw Codex review text parsed inline by the orchestrator (pass/fail heuristic grep). No return-shape cap, no token bound. This is a new Sub-C1 instance at the planning phase.

**Sub-C2 (missing CC-2 dispatch gates)**: CC-2 is not enforced by any doctor check. The rule degrades silently as the prompt evolves. Three or more consecutive Bash-type directives feeding one decision, with no upstream Haiku dispatch gate, is the canonical violation pattern.

**v6.1.0 adversarial-review Sub-C2 candidate:** B2 path-discovery + companion invocation + inline parse is a 3-step sequential Bash-type sequence feeding the AUQ decision gate. No upstream Haiku gate is present.

### Concurrency — already addressed, not a primary fix target

The archived concurrency-guards bundle implemented Guard B (slug-uniqueness at creation) and Guard C (`flock` around state.yml/events.jsonl writes in `bin/masterplan-state.sh` and `hooks/masterplan-telemetry.sh`). The `.lock` file at `docs/masterplan/concurrency-guards/.lock` is Guard C's flock artifact. Guard D (owner sentinel) is explicitly deferred. No new locking mechanism is in scope here.

---

## 3. Audit Methodology

Three audit dimensions, each scoped to a targeted Haiku Explore agent. All three dispatch in parallel (read-only, no shared state).

### Dimension A — Inline reads (Haiku delegation misses)

**Grep target**: Any `Read` directive or inline file-load in `parts/step-*.md` where the result is used in the orchestrator's reasoning context without a `dispatch Haiku` gate upstream.

**Positive hit signal**: `Read` + file path + result parsed inline, no CC-2 gate above it.

**Brief shape**:
```
Goal: Find every inline-read site in parts/step-*.md that violates CC-2.
Inputs: parts/step-0.md, step-a.md, step-b.md, step-c-resume.md, step-c-dispatch.md,
        step-c-verification.md, step-c-completion.md, doctor.md
        Also: parts/step-b.md adversarial-review B2/B3 blocks (v6.1.0 additions).
Return: JSON array of {file, line, excerpt, violation_type}. ≤30 items. No prose.
```

### Dimension B — Sequential dispatch where parallel-group is eligible

**Grep target**: Consecutive subagent dispatch blocks within a single phase block where the briefs share no output dependencies and no `parallel-group:` annotation is present.

**Positive hit signal**: Two or more `dispatch … subagent` blocks in sequence, no data dependency between them, no `parallel-group` tag.

**Brief shape**:
```
Goal: Find sequential subagent dispatch pairs in parts/step-*.md eligible for
      parallel-group annotation (no mutual data dependency, both read-only).
Inputs: Same file set as Dimension A. Also include step-b.md adversarial-review B2/B3 blocks.
Return: JSON array of {file, lines, agent_a, agent_b, dependency_check}. ≤20 items.
```

### Dimension C — Unbounded returns + missing CC-2 gates

**Positive hit signals**:
- C1: `Brief:` block (or coordinator dispatch block identified by `DISPATCH-SITE:` + `contract_id:`) whose `Return shape:` / `return:` section lacks `max`, `limit`, `≤`, or an item-count constraint. **Extends to coordinator-to-orchestrator return shapes (v6.0.0 coordinator briefs).**
- C2: 3+ Bash-type calls in sequence feeding one decision, with no upstream Haiku dispatch gate
- C3: External process output (e.g., adversarial-review companion stdout) parsed inline without a token/char bound

**Brief shape**:
```
Goal: Find (a) uncapped return-shape specs including coordinator briefs, (b) missing CC-2
      dispatch gates, and (c) unbounded external-process outputs parsed inline.
Inputs: Same file set as Dimension A. Scan coordinator dispatch blocks (DISPATCH-SITE: prefix).
Return: JSON array of {file, line, sub_type: "C1"|"C2"|"C3", excerpt}. ≤40 items. No prose.
```

---

## 4. Fix Priority Matrix

Audit findings route to one of three tracks. Assignment rules are deterministic.

### Track 1 — Prompt fix (ships in this implementation)

**Criteria**: Violation runs on every `/masterplan` invocation; fix is a bounded text edit (add annotation, cap, or gate directive); fix is grep-verifiable.

Expected fixes (confirmed at audit time, not hardcoded):

| Location | Change | Dimension |
|---|---|---|
| `parts/step-b.md` — Haiku fan-out briefs | Add `≤ N items` return caps where missing | C1 |
| `parts/step-b.md` — adversarial-review B2 block | Add return-shape cap (char limit) to companion output parse; add CC-2 gate upstream of path-discovery + invoke sequence | A + C2 + C3 |
| `parts/step-c-verification.md` — pre-exec checks | Add `parallel-group: pre-exec-checks` annotation | B |
| `parts/step-c-resume.md` — inline reads | Add CC-2 dispatch gate before any remaining inline file reads | A + C2 |
| `parts/step-c-dispatch.md` — coordinator-plan-parser | Add item-count cap (e.g., `tasks: ≤ N items`) to return shape | C1 |
| `parts/step-c-dispatch.md` + other sub-files — lifecycle briefs | Add `contract_id` + return-shape cap to uncapped briefs | C1 |
| `parts/step-0.md` — bootstrap briefs | Add return-shape caps where missing | C1 |

Each fix is one or two lines added to an existing block. No structural rewrites.

### Track 2 — Doctor check (enforcement going forward)

**Criteria**: Rule already exists but has no automated verification.

| Check | Location | Pattern |
|---|---|---|
| **#46 — CC-2 self-enforcement** | `parts/doctor.md` — "Prompt integrity" section | Grep for 3+ consecutive Bash-type directives in step-*.md without an upstream Haiku dispatch gate |
| **#47 — Return-shape caps** | `parts/doctor.md` — "Prompt integrity" section | Grep for `Return shape:` / coordinator `return:` blocks in step-*.md lacking `max`, `≤`, `limit`, or item-count; extend scan to coordinator dispatch blocks (DISPATCH-SITE: prefix) |

Both checks are grep-based, ≤10-line bash each, non-destructive. They integrate with the existing doctor parallelization brief (update count to include #46 and #47). **Current highest check is #45** — checks #44 (adversarial_review config valid) and #45 (gate-fire audit) were added by adversarial-review-integration (v6.1.0, 2026-05-22T23:10:00Z) after this spec was originally drafted with #44/#45 as the planned numbers. Confirmed by reading `parts/doctor.md` before plan-writing.

### Track 3 — Deferred + documented

| Item | Reason | Revisit trigger |
|---|---|---|
| Slice β/γ (parallel committing tasks) | Structural redesign required | ≥3 parallel-grouped committing tasks + >10min serial wall-clock cost |
| Guard D owner sentinel | Out of scope per concurrency-guards spec | Explicit re-engagement |
| Doctor check parallelism | Sequential by design (output interleaving breaks report) | N/A |

---

## 5. Implementation Sequence

Three phases, executed as waves:

**Wave 1 — Audit** (parallel Haiku Explore agents, Dimensions A/B/C)  
Output: three JSON hit lists → merged findings table

**Wave 2 — Fix pass** (single Sonnet implementer, all Track 1 hits)  
Constraint: one commit per dimension. No structural rewrites.  
Verification: grep for added annotations/caps after each commit.

**Wave 3 — Doctor checks** (single Sonnet implementer, checks #46 + #47)  
Constraint: update the parallelization brief count in the doctor.md header (currently lists max check #45). One commit.  
Verification: `grep -c "Check #4[67]" parts/doctor.md` → 2

**Inline (orchestrator turn)** — `docs/internals/coordinator-pattern.md` + `docs/internals/wave-dispatch.md` CC-2 wording clarification; `bin/masterplan-self-host-audit.sh --brief-style` flag.

---

## 6. Verification Plan

All verification is local-static per `verification_ceiling`.

| Check | Command | Pass criterion |
|---|---|---|
| Return-shape caps added | `grep -rn "≤\|max\|limit" parts/step-c-*.md` | ≥N hits (N from audit) |
| Adversarial-review companion cap | `grep -n "≤\|char\|limit" parts/step-b.md` | ≥1 hit in adversarial-review block |
| coordinator-plan-parser tasks cap | `grep -n "tasks.*≤\|≤.*tasks\|tasks.*limit" parts/step-c-dispatch.md` | ≥1 hit |
| Parallel-group annotations | `grep -rn "parallel-group" parts/step-c-*.md` | ≥1 hit |
| CC-2 gate in step-c sub-files | `grep -rn "dispatch Haiku\|CC-2" parts/step-c-*.md` | ≥1 hit |
| Doctor checks #46 + #47 exist | `grep -c "Check #4[67]" parts/doctor.md` | 2 |
| Doctor check count accurate | `grep "checks:" parts/doctor.md` | matches actual count |
| Hook syntax clean | `bash -n hooks/masterplan-telemetry.sh` | exit 0 |

---

## 7. Known State + Deferred Decisions

- **Concurrency**: Guards B+C shipped in archived concurrency-guards bundle. Guard D (owner sentinel with schema bump) deferred. No data corruption observed. No action in this spec.
- **Slice β/γ**: Parallel committing tasks deferred per `docs/design/intra-plan-parallelism.md`. Revisit trigger: ≥3 parallel-grouped committing tasks with >10min serial wall-clock cost in a real run.
- **Doctor check numbers**: Originally planned as #44 + #45; adversarial-review-integration (v6.1.0) added those numbers on 2026-05-22T23:10:00Z after this spec was drafted. Corrected to **#46** (CC-2 self-enforcement) and **#47** (return-shape caps). Verify with `grep "^## Check #4[567]" parts/doctor.md` before plan-writing.
- **step-c.md split**: The monolith was split into 4 sub-files in v6.0.0 (masterplan-token-efficiency). `parts/step-c.md` no longer exists. All references in this spec updated to the 4 sub-files.
- **docs/internals.md**: Now a 26-line navigation index (v6.0.0). CC-2 wording target updated to `docs/internals/coordinator-pattern.md` + `docs/internals/wave-dispatch.md`.
- **v6.0.0 coordinator coverage**: The 5 coordinator sites (bundle-resume, plan-parser, task-verify, brainstorm-anchor, doctor) addressed the heaviest CC-2 inline-read violations. Remaining violations are likely in non-coordinator paths and the coordinator return shapes themselves.
- **Audit hit count**: Wave 1 finds the exact hit count. Track 1 table above is a forecast. Actual edits are bounded by audit output.
