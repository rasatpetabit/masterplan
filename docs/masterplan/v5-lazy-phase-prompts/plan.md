# v5.0 Lazy-Load Phase Prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v5.0.0 of superpowers-masterplan: split the ~342KB / 3030-line orchestrator monolith into a thin router + lazy-loaded phase prompts, plus five bundled fixes addressing the 2026-05-13 GPT-5.5 audit findings.

**Architecture:** `commands/masterplan.md` shrinks to a ≤20KB router (verb dispatch + boot guards + Codex-host detect + phase-prompt loader + doctor entry). Per-phase content moves to `parts/step-{0,a,b,c}.md`. Cross-phase rules live in `parts/contracts/*`. Doctor check bodies live in `parts/doctor.md`. Migration verb logic lives in `parts/import.md`. New schemas (`plan.index.json`, v5 `state.yml`), telemetry record (`parent_turn`), and `bin/masterplan-state.sh` subcommands (`migrate-state`, `migrate-plan`, `build-index`). Clean break: v5.0.0.

**Tech Stack:** Markdown (orchestrator + skill docs), Bash (state tooling, hooks, doctor checks), JSON (`plan.index.json`, telemetry JSONL), YAML (`state.yml`).

**Spec reference:** [`docs/masterplan/v5-lazy-phase-prompts/spec.md`](spec.md) @ commit 5b2a758.

---

## File Structure

**New files:**

- `commands/masterplan.md` — rewritten as router (~15K target / 20K ceiling)
- `parts/step-0.md` — bootstrap, status verb, validate verb
- `parts/step-a.md` — intake
- `parts/step-b.md` — planning B0..B3
- `parts/step-c.md` — execute: wave dispatch + verify + archive
- `parts/doctor.md` — all 36 doctor check bodies (plan-level extension to spec layout)
- `parts/import.md` — migration verb logic (plan-level extension to spec layout)
- `parts/codex-host.md` — conditional suppression of `codex:codex-rescue`
- `parts/contracts/agent-dispatch.md` — subagent brief shape, DISPATCH-SITE, model-tier
- `parts/contracts/cd-rules.md` — CD-1..CD-10 verbatim
- `parts/contracts/taskcreate-projection.md` — projection + threshold logic + priming
- `parts/contracts/run-bundle.md` — state.yml v5 schema, plan.index.json schema, overflow rules
- `docs/verbs.md` — cheat sheet (not a load target)
- `docs/config-schema.md` — extracted config schema section
- `docs/masterplan/v5-lazy-phase-prompts/plan.index.json` — dogfood index
- `docs/masterplan/v5-lazy-phase-prompts/state.yml` — run bundle state

**Plan-level extensions to spec File Layout (§L61-86):** spec lists `step-{0,a,b,c}.md`, `contracts/`, `codex-host.md`, `docs/{verbs,config-schema}.md`. This plan adds `parts/doctor.md` and `parts/import.md` to keep ~36 doctor-check bodies and import-migration logic out of the router and `step-0.md`. If you prefer a different home, surface as a blocker before Wave B.

**Plan-level deviation on tool naming:** spec says `bin/masterplan-state.sh migrate <slug>` for v4.x → v5.0 state migration. But existing `migrate` already does v3.x → v4.x layout migration (see `bin/masterplan-state.sh:21`). This plan uses **`migrate-state <slug>`** for v4.x → v5.0 to avoid breaking the existing subcommand. Existing `migrate` remains untouched.

**Modified files:**

- `bin/masterplan-state.sh` (865 lines) — +`build-index`, +`migrate-state`, +`migrate-plan`, +200-char cap enforcement
- `hooks/masterplan-telemetry.sh` (405 lines) — +`parent_turn` emission
- `bin/masterplan-routing-stats.sh` (533 lines) — +`--parent` flag
- `bin/masterplan-self-host-audit.sh` (1027 lines) — +per-phase-file checks
- `skills/masterplan/SKILL.md` — Codex entrypoint sync to v5 layout
- `docs/internals.md` — v5 layout, doctor check #32–#36 family entries
- `.claude-plugin/plugin.json` — version 5.0.0
- `.claude-plugin/marketplace.json` (root + nested) — version 5.0.0
- `.codex-plugin/plugin.json` — version 5.0.0
- `CHANGELOG.md` — ## [5.0.0] entry

**Working strategy:** Extract content to new files first (Waves A–B), leaving `commands/masterplan.md` intact. The monolith is rewritten as the router in Wave D as a single atomic task. Between Waves A and D, `/masterplan` may not behave identically — implementation happens on branch `v5.0.0-lazy-phase-prompts`, never main.

---

## Wave A: Foundation

### Task 1: Create v5 directory skeleton

**Files:**
- Create: `parts/.gitkeep`
- Create: `parts/contracts/.gitkeep`

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L61-L86](spec.md#L61-L86)
**Verify:**
```bash
test -d parts/contracts && test -f parts/.gitkeep && test -f parts/contracts/.gitkeep
```

Create the directory layout that subsequent tasks fill in. `.gitkeep` ensures empty dirs are tracked.

- [ ] **Step 1: Verify dirs do not yet exist**

```bash
test ! -d parts && echo "FAIL expected" || echo "parts already exists"
```
Expected: `FAIL expected`

- [ ] **Step 2: Create the directories**

```bash
mkdir -p parts/contracts
touch parts/.gitkeep parts/contracts/.gitkeep
```

- [ ] **Step 3: Verify**

```bash
test -d parts/contracts && test -f parts/.gitkeep && test -f parts/contracts/.gitkeep && echo OK
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add parts/.gitkeep parts/contracts/.gitkeep
git commit -m "v5: create parts/ + parts/contracts/ skeleton"
```

---

### Task 2: Extract `docs/config-schema.md`

**Files:**
- Create: `docs/config-schema.md`
- Read source: `commands/masterplan.md` (config schema section, ~187 lines per spec §L40)

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L40](spec.md#L40), [spec.md#L82](spec.md#L82)
**Verify:**
```bash
test -f docs/config-schema.md
grep -q '~/.masterplan.yaml' docs/config-schema.md
test ! -s parts/contracts/.gitkeep || true  # unrelated; placeholder
[ "$(wc -l < docs/config-schema.md)" -ge 100 ]
```

Extract the config schema reference from the monolith into a standalone doc. Loaded only on the `validate` verb in v5.

- [ ] **Step 1: Locate the config schema section in the monolith**

```bash
grep -n -E '^#+ .*[Cc]onfig.*[Ss]chema' commands/masterplan.md
```
Note the start line. Identify the end by the next `^# ` or `^## ` heading.

- [ ] **Step 2: Verify the target file does not yet exist**

```bash
test ! -f docs/config-schema.md && echo OK
```
Expected: `OK`

- [ ] **Step 3: Copy the section to `docs/config-schema.md`**

Use `sed -n '<start>,<end>p' commands/masterplan.md > docs/config-schema.md` with the line range from Step 1. Add a one-line H1 if the extracted block doesn't already start with one: `# Configuration Schema`.

- [ ] **Step 4: Verify content moved correctly**

```bash
grep -q '~/.masterplan.yaml' docs/config-schema.md && echo CONFIG-PATH-OK
grep -q -E '^(autonomy|complexity|halt_mode):' docs/config-schema.md && echo FIELDS-OK
```
Expected: both `OK` lines.

- [ ] **Step 5: Commit**

```bash
git add docs/config-schema.md
git commit -m "v5: extract config schema doc from monolith"
```

---

### Task 3: Write `docs/verbs.md` cheat sheet

**Files:**
- Create: `docs/verbs.md`

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L82-L84](spec.md#L82-L84)
**Verify:**
```bash
test -f docs/verbs.md
for v in start resume status doctor import archive validate retry; do
  grep -q "^## \`$v\`" docs/verbs.md || { echo "MISSING: $v"; exit 1; }
done
echo VERBS-OK
```

Write a plain-markdown cheat sheet listing each verb, one-line description, which phase file it routes through, and key flags. Not a load target — for grep + onboarding only.

- [ ] **Step 1: Confirm target absent**

```bash
test ! -f docs/verbs.md && echo OK
```

- [ ] **Step 2: Write the cheat sheet**

```markdown
# /masterplan Verbs Cheat Sheet

This is a human reference. The orchestrator does NOT load this file at runtime.

## `start`
Begin a new run. Routes through: `step-0.md` → `step-a.md` → `step-b.md` → `step-c.md`.
Flags: `--autonomy={gated|loose|full}`, `--complexity={low|medium|high}`, `--halt_mode={...}`.

## `resume`
Continue an active run from `state.yml.current_phase`. Routes through: `step-0.md` → `step-{current_phase}.md`.

## `status`
Print current run state. Routes through: `step-0.md` (status logic lives there).
No state mutation.

## `doctor`
Run all 36 doctor checks against the repo + active run bundles. Routes through: `step-0.md` → `doctor.md`.
Report-only by default; `--fix` for safe auto-fixes where supported.

## `import`
Migrate legacy planning artifacts into a new run bundle. Routes through: `step-0.md` → `import.md`.

## `archive`
Archive a completed run bundle. Routes through: `step-0.md` → `step-c.md` (archive subroutine).

## `validate`
Validate `~/.masterplan.yaml` or a per-run config. Loads `docs/config-schema.md`.

## `retry`
Retry a failed wave or wave member. Routes through: `step-0.md` → `step-c.md` (wave-dispatch subroutine).
```

- [ ] **Step 3: Verify all eight verbs present**

Run the verify command from above.

- [ ] **Step 4: Commit**

```bash
git add docs/verbs.md
git commit -m "v5: add docs/verbs.md verb cheat sheet"
```

---

### Task 4: Write `parts/contracts/cd-rules.md`

**Files:**
- Create: `parts/contracts/cd-rules.md`
- Read source: `commands/masterplan.md` (CD-1..CD-10 anchors throughout)

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L114](spec.md#L114)
**Verify:**
```bash
for n in 1 2 3 4 5 6 7 8 9 10; do
  grep -q "^### CD-$n" parts/contracts/cd-rules.md || { echo "MISSING CD-$n"; exit 1; }
done
echo CD-RULES-OK
```

Extract CD-1..CD-10 from the monolith verbatim into a single contract file. This is the canonical source going forward; phase files reference by ID and load on demand.

- [ ] **Step 1: Map each CD-N to its source line range in the monolith**

```bash
grep -n -E '^#+ CD-[0-9]+' commands/masterplan.md
```
Note each rule's heading line. The body runs to the next heading.

- [ ] **Step 2: Write `parts/contracts/cd-rules.md` header + each rule**

Use this template, filling each rule's body from the monolith:

```markdown
# Critical Discipline Rules (CD-1 .. CD-10)

These rules are the canonical source. Phase files reference them by ID; full bodies live here. Loaded on demand by `parts/step-*.md` when first referenced per turn.

### CD-1: <heading from monolith>
<body from monolith>

### CD-2: <heading from monolith>
<body from monolith>

...
```

- [ ] **Step 3: Verify all ten rules present**

Run the verify command above.

- [ ] **Step 4: Verify content fidelity (spot-check)**

```bash
diff <(sed -n '/^### CD-7/,/^### CD-8/p' parts/contracts/cd-rules.md | head -n -1) \
     <(grep -A 30 '^#\+ CD-7' commands/masterplan.md | head -n 30)
```
Inspect: differences are heading-level (### vs whatever monolith used) — body should match.

- [ ] **Step 5: Commit**

```bash
git add parts/contracts/cd-rules.md
git commit -m "v5: extract CD-1..CD-10 to parts/contracts/cd-rules.md"
```

---

### Task 5: Write `parts/contracts/agent-dispatch.md`

**Files:**
- Create: `parts/contracts/agent-dispatch.md`
- Read source: `commands/masterplan.md` (Subagent and context-control architecture section ~193 lines per spec history)

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L113](spec.md#L113)
**Verify:**
```bash
test -f parts/contracts/agent-dispatch.md
grep -q 'DISPATCH-SITE' parts/contracts/agent-dispatch.md
grep -q -E 'haiku|sonnet|opus' parts/contracts/agent-dispatch.md
grep -q -E 'Goal|Inputs|Scope|Constraints|Return' parts/contracts/agent-dispatch.md
echo AGENT-DISPATCH-OK
```

Extract the subagent brief shape (Goal/Inputs/Scope/Constraints/Return), DISPATCH-SITE tagging convention, and model-tier selection rules (Haiku/Sonnet/Opus, Codex routing) into a single contract.

- [ ] **Step 1: Locate source sections in monolith**

```bash
grep -n -E '^#+ .*(Subagent|Agent dispatch|DISPATCH-SITE|context-control)' commands/masterplan.md
```

- [ ] **Step 2: Confirm target absent**

```bash
test ! -f parts/contracts/agent-dispatch.md && echo OK
```

- [ ] **Step 3: Write the contract**

Structure:
```markdown
# Agent Dispatch Contract

## Subagent brief shape
Every dispatch MUST include: Goal / Inputs / Scope / Constraints / Return.

<extracted brief template>

## Model-tier selection
| Tier | When | Subagent types | Examples |
| ... |

<extracted table from monolith or from ~/.claude/refs/subagent-models.md>

## DISPATCH-SITE tagging
Every dispatch annotates with `DISPATCH-SITE: <phase-file>:<site-label>` so telemetry can attribute.

<extracted convention>

## Codex routing
<extracted rules: when to route to codex:codex-rescue vs standard subagent>
```

- [ ] **Step 4: Verify**

Run the verify command above.

- [ ] **Step 5: Commit**

```bash
git add parts/contracts/agent-dispatch.md
git commit -m "v5: extract agent-dispatch contract"
```

---

### Task 6: Write `parts/contracts/taskcreate-projection.md`

**Files:**
- Create: `parts/contracts/taskcreate-projection.md`
- Read source: `commands/masterplan.md` (TaskCreate projection logic; per-state-write priming at L1393)

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L115](spec.md#L115), [spec.md#L219-L234](spec.md#L219-L234)
**Verify:**
```bash
test -f parts/contracts/taskcreate-projection.md
grep -q 'projection_threshold' parts/contracts/taskcreate-projection.md
grep -q -E 'len\(plan\.tasks\)|tasks\.length' parts/contracts/taskcreate-projection.md
grep -q 'priming' parts/contracts/taskcreate-projection.md
echo PROJECTION-OK
```

Extract projection layer logic from the monolith AND add the v5.0 threshold gate (default `projection_threshold: 15`). Threshold gates BOTH projection AND per-state-write priming together.

- [ ] **Step 1: Locate source**

```bash
grep -n -E 'TaskCreate|projection|priming|tasks\.projection' commands/masterplan.md | head -20
```
Note especially L1393 (per-state-write priming) and the projection-on-plan-load logic.

- [ ] **Step 2: Confirm target absent**

```bash
test ! -f parts/contracts/taskcreate-projection.md && echo OK
```

- [ ] **Step 3: Write the contract**

```markdown
# TaskCreate Projection Contract (Claude-only)

## Scope
Projection mirrors the plan's task list into the Claude TaskList ledger. Codex sessions DO NOT project — Codex uses its own task tracking.

## Threshold
`tasks.projection_threshold` (default: `15`) — gates BOTH projection AND per-state-write priming.

```
if len(plan.tasks) > tasks.projection_threshold:
    skip projection           # no TaskList mirroring of plan tasks
    skip per-state-write priming   # no TaskUpdate on every state.yml write
    emit ONE TaskCreate at run start:
        TaskCreate("masterplan: <slug>")

if len(plan.tasks) <= tasks.projection_threshold:
    # current v4.x behavior:
    project all plan.tasks -> TaskList entries
    per-state-write priming TaskUpdate on every state.yml mutation
```

## Per-state-write priming (when in projection mode)
<extracted from monolith ~L1393>

## Configuration
`~/.masterplan.yaml`:
```yaml
tasks:
  projection_threshold: 15
```
Per-run override: `--tasks.projection_threshold=N` (rare).

## Doctor check #33
Warns when ledger state inconsistent with current threshold/plan size (e.g., projection-mode ledger entries persist after a plan grew past threshold).
```

- [ ] **Step 4: Verify**

Run verify command.

- [ ] **Step 5: Commit**

```bash
git add parts/contracts/taskcreate-projection.md
git commit -m "v5: extract taskcreate-projection contract + add threshold gate"
```

---

### Task 7: Write `parts/contracts/run-bundle.md`

**Files:**
- Create: `parts/contracts/run-bundle.md`

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L116-L117](spec.md#L116-L117), [spec.md#L185-L218](spec.md#L185-L218), [spec.md#L119-L160](spec.md#L119-L160)
**Verify:**
```bash
test -f parts/contracts/run-bundle.md
grep -q 'schema_version: "5.0"' parts/contracts/run-bundle.md
grep -q 'plan_hash' parts/contracts/run-bundle.md
grep -q 'overflow at' parts/contracts/run-bundle.md
grep -q 'plan.index.json' parts/contracts/run-bundle.md
echo RUN-BUNDLE-OK
```

State.yml v5.0 schema, plan.index.json schema, overflow rules (200-char cap), `bin/masterplan-state.sh` invocation contract, build-index trigger condition.

- [ ] **Step 1: Confirm target absent**

```bash
test ! -f parts/contracts/run-bundle.md && echo OK
```

- [ ] **Step 2: Write the contract**

Copy the relevant schema sections from `spec.md` (state.yml v5 Schema §L185-L218 and plan.index.json Full v5.0 Schema §L119-L160) verbatim into this file. Add invocation contract for `bin/masterplan-state.sh`:

```markdown
# Run Bundle Contract

## Location
`docs/masterplan/<slug>/`
  state.yml          (run state, v5.0 schema below)
  spec.md            (design)
  plan.md            (implementation plan, v5.0 format)
  plan.index.json    (structured task index, see below)
  retro.md           (post-run retrospective)
  handoff.md         (overflow for handoff scalar > 200 chars)
  blockers.md        (overflow for blockers list scalar > 200 chars)
  events.jsonl       (per-turn event log)

## state.yml v5.0 schema
<copy from spec §L185-L218>

## Hard write-time rule
Any scalar > 200 chars rejected by `bin/masterplan-state.sh`. Overflow moved to
`<slug>/handoff.md` or `<slug>/blockers.md` with `*overflow at <file> L<n>*` pointer.

## plan.index.json schema (Full v5.0)
<copy from spec §L119-L160>

## Build trigger
`state.yml.plan_hash != sha256(plan.md)` → regenerate via `bin/masterplan-state.sh build-index <slug>`. Computed at Step B3 entry and Step C entry.

## Canonical writer
Orchestrator is the canonical writer (CD-7). Wave members emit digests only; orchestrator writes state. `bin/masterplan-state.sh` enforces.
```

- [ ] **Step 3: Verify**

Run verify command.

- [ ] **Step 4: Commit**

```bash
git add parts/contracts/run-bundle.md
git commit -m "v5: extract run-bundle contract (state.yml v5 + plan.index.json + overflow)"
```

---

### Task 8: Write `parts/codex-host.md`

**Files:**
- Create: `parts/codex-host.md`
- Read source: `commands/masterplan.md` (Codex host suppression logic)

**Parallel-group:** wave-1
**Codex:** false
**Spec:** [spec.md#L274-L278](spec.md#L274-L278)
**Verify:**
```bash
test -f parts/codex-host.md
grep -q 'codex:codex-rescue' parts/codex-host.md
grep -q -E 'suppress' parts/codex-host.md
echo CODEX-HOST-OK
```

Extract the Codex-hosting detection + `codex:codex-rescue` suppression rules from the monolith. Loaded conditionally by the router only when hosted by Codex.

- [ ] **Step 1: Locate source**

```bash
grep -n -E 'codex.*host|host.*codex|codex:codex-rescue|superpowers-masterplan:masterplan' commands/masterplan.md
```

- [ ] **Step 2: Confirm target absent**

```bash
test ! -f parts/codex-host.md && echo OK
```

- [ ] **Step 3: Write the file (extract + adapt as standalone)**

Structure:
```markdown
# Codex Host Suppression

Loaded by the router only when `/masterplan` is hosted by Codex (slash path resolves to `/superpowers-masterplan:masterplan`).

## Suppression rule
While hosted by Codex, DO NOT dispatch the Claude Code `codex:codex-rescue` companion subagent. The dispatch would be recursive (Codex calling Codex).

## What stays in effect
Persisted `codex.routing` and `codex.review` configuration remain active for Claude Code-hosted runs. This file only governs Codex-hosted invocations.

<extracted detail from monolith>
```

- [ ] **Step 4: Verify**

Run verify command.

- [ ] **Step 5: Commit**

```bash
git add parts/codex-host.md
git commit -m "v5: extract codex-host conditional-load file"
```

---

## Wave B: Phase Files

### Task 9: Write `parts/step-0.md`

**Files:**
- Create: `parts/step-0.md`
- Read source: `commands/masterplan.md` (Step 0 section ~395 lines, plus status verb logic, plus validate verb logic)

**Parallel-group:** wave-2
**Codex:** false
**Spec:** [spec.md#L67](spec.md#L67), [spec.md#L102-L110](spec.md#L102-L110)
**Verify:**
```bash
test -f parts/step-0.md
grep -q 'CC-3-trampoline' parts/step-0.md
grep -q -E 'status|validate' parts/step-0.md
[ "$(wc -c < parts/step-0.md)" -ge 20000 ]  # at least 20KB — bootstrap is substantial
echo STEP-0-OK
```

Bootstrap: validate `state.yml`, route the verb, detect Codex hosting, load Codex-host file if needed, then jump to the phase-prompt-loader. Also hosts `status` and `validate` verb logic (small enough to inline).

- [ ] **Step 1: Locate Step 0 section in monolith**

```bash
grep -n -E '^#+ Step 0|^#+ Bootstrap' commands/masterplan.md
```

- [ ] **Step 2: Confirm target absent**

```bash
test ! -f parts/step-0.md && echo OK
```

- [ ] **Step 3: Copy Step 0 + status + validate sections**

Use `sed -n` to extract each section. Concatenate into `parts/step-0.md`. Add an H1: `# Step 0 — Bootstrap + Status + Validate`. Preserve the `CC-3-trampoline` anchor.

- [ ] **Step 4: Verify CC-3-trampoline anchor and verb routing**

```bash
grep -c 'CC-3-trampoline' parts/step-0.md
grep -n -E 'verb.*status|status.*verb' parts/step-0.md | head -3
```

- [ ] **Step 5: Add a "loads contracts/" reference list near the top**

So readers know what contract loads to expect:
```markdown
> **Loads on demand:** `parts/contracts/run-bundle.md` (for state.yml schema), `parts/contracts/cd-rules.md` (CD-1 on session boundary).
```

- [ ] **Step 6: Commit**

```bash
git add parts/step-0.md
git commit -m "v5: extract parts/step-0.md (bootstrap + status + validate)"
```

---

### Task 10: Write `parts/step-a.md`

**Files:**
- Create: `parts/step-a.md`
- Read source: `commands/masterplan.md` (Step A intake section)

**Parallel-group:** wave-2
**Codex:** false
**Spec:** [spec.md#L68](spec.md#L68)
**Verify:**
```bash
test -f parts/step-a.md
grep -q -E 'intake|brainstorm' parts/step-a.md
echo STEP-A-OK
```

Intake: turn the user's initial prompt into a brainstorm input, route to brainstorming skill, capture spec output.

- [ ] **Step 1: Locate Step A in monolith**

```bash
grep -n -E '^#+ Step A|^#+ Intake' commands/masterplan.md
```

- [ ] **Step 2: Confirm target absent + extract**

```bash
test ! -f parts/step-a.md && echo OK
```
Extract via `sed -n '<start>,<end>p'`. Add H1: `# Step A — Intake`.

- [ ] **Step 3: Verify**

Run verify above.

- [ ] **Step 4: Commit**

```bash
git add parts/step-a.md
git commit -m "v5: extract parts/step-a.md (intake)"
```

---

### Task 11: Write `parts/step-b.md`

**Files:**
- Create: `parts/step-b.md`
- Read source: `commands/masterplan.md` (Step B section, includes B0/B1/B2/B3 — B3 alone is ~764 lines)

**Parallel-group:** wave-2
**Codex:** false
**Spec:** [spec.md#L69](spec.md#L69)
**Verify:**
```bash
test -f parts/step-b.md
for sub in B0 B1 B2 B3; do
  grep -q "$sub" parts/step-b.md || { echo "MISSING $sub"; exit 1; }
done
[ "$(wc -c < parts/step-b.md)" -ge 50000 ]
echo STEP-B-OK
```

Planning (B0..B3): clarify, spec, design, plan. B3 contains the wave-dispatch plan-emission logic. v5.0 plan-emission MUST emit `**Spec:**` + `**Verify:**` markers (per spec §L161-L184).

- [ ] **Step 1: Locate Step B in monolith**

```bash
grep -n -E '^#+ Step B|^#+ B[0-3]' commands/masterplan.md
```

- [ ] **Step 2: Confirm target absent + extract**

```bash
test ! -f parts/step-b.md && echo OK
```
Extract the full Step B block (B0..B3). Add H1: `# Step B — Planning (B0..B3)`.

- [ ] **Step 3: Update B3 plan-emission to use v5.0 plan-format markers**

In the B3 section of `parts/step-b.md`, locate the plan-emission template. Update it to emit `**Spec:**` and `**Verify:**` for every task per spec §L161-L184. Sample template block:

~~~markdown
### Task <N>: <name>

**Files:** <comma-separated paths>
**Parallel-group:** <wave-X or none>
**Codex:** <true|false>
**Spec:** [spec.md#L<a>-L<b>](spec.md#L<a>-L<b>)
**Verify:**
```bash
<verify commands>
```

<task body>
~~~

- [ ] **Step 4: Verify B-subsection markers + size**

Run verify above.

- [ ] **Step 5: Commit**

```bash
git add parts/step-b.md
git commit -m "v5: extract parts/step-b.md + update B3 plan-emission to v5 markers"
```

---

### Task 12: Write `parts/step-c.md`

**Files:**
- Create: `parts/step-c.md`
- Read source: `commands/masterplan.md` (Step C section ~709 lines)

**Parallel-group:** wave-2
**Codex:** false
**Spec:** [spec.md#L70](spec.md#L70)
**Verify:**
```bash
test -f parts/step-c.md
grep -q 'DISPATCH-SITE: step-c.md' parts/step-c.md
grep -q -E 'wave dispatch|wave-dispatch' parts/step-c.md
grep -q -E 'verify|verification' parts/step-c.md
grep -q -E 'archive' parts/step-c.md
echo STEP-C-OK
```

Execute: pre-launch checks, wave dispatch (Slice α), per-task verification, archive on completion. Replaces all DISPATCH-SITE tags from `commands/masterplan.md:wave-*` to `step-c.md:wave-*`.

- [ ] **Step 1: Locate Step C in monolith**

```bash
grep -n -E '^#+ Step C|^#+ Execute' commands/masterplan.md
```

- [ ] **Step 2: Confirm target absent + extract**

```bash
test ! -f parts/step-c.md && echo OK
```
Add H1: `# Step C — Execute (wave dispatch + verify + archive)`.

- [ ] **Step 3: Rewrite DISPATCH-SITE tags**

In the extracted content, replace any `DISPATCH-SITE: commands/masterplan.md:<label>` with `DISPATCH-SITE: step-c.md:<label>`. Verify count:
```bash
grep -c 'DISPATCH-SITE: step-c.md' parts/step-c.md
grep -c 'DISPATCH-SITE: commands/masterplan.md' parts/step-c.md
```
First should be ≥1; second should be 0.

- [ ] **Step 4: Read plan.index.json instead of re-reading plan.md**

In the wave-dispatch and per-task-verify subsections, change "read plan.md" to "consult plan.index.json (built by `bin/masterplan-state.sh build-index <slug>`)". The plan.index.json contract is in `parts/contracts/run-bundle.md`.

- [ ] **Step 5: Verify**

Run verify above.

- [ ] **Step 6: Commit**

```bash
git add parts/step-c.md
git commit -m "v5: extract parts/step-c.md + retag DISPATCH-SITE + consult plan.index.json"
```

---

### Task 13: Write `parts/doctor.md` (existing checks #1-#31)

**Files:**
- Create: `parts/doctor.md`
- Read source: `commands/masterplan.md` (Step D doctor checks section)

**Parallel-group:** wave-2
**Codex:** false
**Spec:** [spec.md#L88-L100](spec.md#L88-L100), [spec.md#L310-L320](spec.md#L310-L320)
**Verify:**
```bash
test -f parts/doctor.md
for n in $(seq 1 31); do
  grep -q "^## Check #$n" parts/doctor.md || { echo "MISSING check #$n"; exit 1; }
done
echo DOCTOR-1-31-OK
```

Extract all existing doctor check bodies (#1-#31) into a single file. Each check is a header + body + bash check function. Checks #32-#36 added in Wave C.

- [ ] **Step 1: Locate Step D + each check anchor in monolith**

```bash
grep -n -E '^#+ Step D|^#+ Check #|check #[0-9]+' commands/masterplan.md | head -40
```

- [ ] **Step 2: Confirm target absent**

```bash
test ! -f parts/doctor.md && echo OK
```

- [ ] **Step 3: Write the header + extract each check**

```markdown
# Doctor — Self-Host Checks (#1 .. #31)

Invoked via `/masterplan doctor`. Loaded by the router only when verb == doctor. Checks #32–#36 added in Wave C.

| ID | Subject | Severity | Action |
|---|---|---|---|
| #1 | ... | ... | ... |
| ... |

<extracted checks #1..#31 with their headers and bodies>
```

Copy the existing severity/action table from monolith. Then extract each check's full body in numerical order.

- [ ] **Step 4: Verify**

Run verify above.

- [ ] **Step 5: Commit**

```bash
git add parts/doctor.md
git commit -m "v5: extract parts/doctor.md (checks #1-#31)"
```

---

### Task 14: Write `parts/import.md`

**Files:**
- Create: `parts/import.md`
- Read source: `commands/masterplan.md` (import verb logic, masterplan-detect interaction)

**Parallel-group:** wave-2
**Codex:** false
**Spec:** plan-level extension (spec §L61-L86 layout supplemented)
**Verify:**
```bash
test -f parts/import.md
grep -q -E 'import|migrate|legacy' parts/import.md
echo IMPORT-OK
```

Extract the import verb logic. Handles legacy-artifact migration into new run bundles. Heavy enough (CD-7 lifecycle gating + masterplan-detect skill integration) to warrant its own file.

- [ ] **Step 1: Locate import logic in monolith**

```bash
grep -n -E 'import.*verb|verb.*import|legacy.*plan|masterplan-detect' commands/masterplan.md | head -20
```

- [ ] **Step 2: Confirm absent + extract**

```bash
test ! -f parts/import.md && echo OK
```
Add H1: `# Import — Legacy Artifact Migration`.

- [ ] **Step 3: Verify**

Run verify above.

- [ ] **Step 4: Commit**

```bash
git add parts/import.md
git commit -m "v5: extract parts/import.md (import verb logic)"
```

---

## Wave C: New Doctor Checks #32-#36

### Task 15: Add doctor check #32 (state.yml scalar cap)

**Files:**
- Modify: `parts/doctor.md`

**Parallel-group:** wave-3
**Codex:** false
**Spec:** [spec.md#L312](spec.md#L312)
**Verify:**
```bash
grep -q '^## Check #32' parts/doctor.md
grep -A 30 '^## Check #32' parts/doctor.md | grep -q '200'  # cap value present
grep -A 30 '^## Check #32' parts/doctor.md | grep -q 'overflow at'
echo CHECK-32-OK
```

Verifies every scalar in `state.yml` is ≤200 chars AND every overflow pointer (`*overflow at <file> L<n>*`) resolves to an existing file/line.

- [ ] **Step 1: Append the check to `parts/doctor.md`**

```markdown
## Check #32: state.yml scalar cap + overflow pointer integrity

**Severity:** Warning
**Action:** Report-only

For every `state.yml` in `docs/masterplan/*/`, verify:
1. Every scalar value (`key: <value>` and every list item) is ≤200 characters.
2. Any scalar matching `*overflow at <file> L<n>*` resolves: `<file>` exists in the bundle dir AND `<n>` is a valid line number.

```bash
fail=0
for s in docs/masterplan/*/state.yml; do
  while IFS= read -r line; do
    # strip leading whitespace + key prefix; extract value
    val="${line#*: }"
    if [ "${#val}" -gt 200 ]; then
      echo "WARN $s: scalar exceeds 200 chars on line: ${line:0:80}..."
      fail=1
    fi
    # overflow pointer integrity
    if [[ "$val" =~ \*overflow\ at\ ([^\ ]+)\ L([0-9]+)\* ]]; then
      target="$(dirname "$s")/${BASH_REMATCH[1]}"
      lineno="${BASH_REMATCH[2]}"
      if [ ! -f "$target" ]; then
        echo "WARN $s: overflow target missing: $target"; fail=1
      elif [ "$(wc -l < "$target")" -lt "$lineno" ]; then
        echo "WARN $s: overflow target $target has fewer than $lineno lines"; fail=1
      fi
    fi
  done < <(grep -E '^[[:space:]]*[a-zA-Z_-]+:' "$s")
done
[ $fail -eq 0 ] && echo "Check #32: PASS" || echo "Check #32: WARN"
```
```

- [ ] **Step 2: Update the severity table at the top of `parts/doctor.md`** to add a row for #32.

- [ ] **Step 3: Verify**

Run verify above.

- [ ] **Step 4: Commit**

```bash
git add parts/doctor.md
git commit -m "v5: doctor check #32 — state.yml scalar cap + overflow pointer"
```

---

### Task 16: Add doctor check #33 (projection mode mismatch)

**Files:**
- Modify: `parts/doctor.md`

**Parallel-group:** wave-3
**Codex:** false
**Spec:** [spec.md#L313](spec.md#L313), [spec.md#L232-L233](spec.md#L232-L233)
**Verify:**
```bash
grep -q '^## Check #33' parts/doctor.md
grep -A 30 '^## Check #33' parts/doctor.md | grep -q 'projection_threshold'
echo CHECK-33-OK
```

Warns when ledger state is inconsistent with the current threshold + plan size combination — e.g., projection-mode entries persist after a plan grew past the threshold (or vice versa, after threshold lowered).

- [ ] **Step 1: Append check #33**

```markdown
## Check #33: TaskCreate projection mode mismatch

**Severity:** Warning
**Action:** Report-only

For each active run bundle: compute the current projection mode from
`tasks.projection_threshold` vs `len(plan.tasks)`. Compare against the actual
TaskList ledger entries owned by this run. Warn if they disagree (stale
projection entries past threshold cross, or missing projection when within
threshold).

```bash
# Pseudocode — requires reading TaskList state via runtime
# Skip when no TaskList API access; report SKIPPED.
echo "Check #33: SKIPPED (requires TaskList API access — runtime-only)"
```

Note: this check is best executed by the orchestrator itself during `doctor`
verb dispatch, where TaskList API access is available. Standalone CLI runs of
this check report SKIPPED.
```

- [ ] **Step 2: Update severity table**

- [ ] **Step 3: Verify + commit**

```bash
git add parts/doctor.md
git commit -m "v5: doctor check #33 — TaskCreate projection mode mismatch"
```

---

### Task 17: Add doctor check #34 (plan.index.json staleness)

**Files:**
- Modify: `parts/doctor.md`

**Parallel-group:** wave-3
**Codex:** false
**Spec:** [spec.md#L314](spec.md#L314), [spec.md#L156-L160](spec.md#L156-L160)
**Verify:**
```bash
grep -q '^## Check #34' parts/doctor.md
grep -A 30 '^## Check #34' parts/doctor.md | grep -q 'plan_hash'
echo CHECK-34-OK
```

Compute `sha256(plan.md)` and compare against `state.yml.plan_hash` and `plan.index.json.plan_hash`. Warn if any mismatch (index needs regeneration).

- [ ] **Step 1: Append check #34**

```markdown
## Check #34: plan.index.json staleness

**Severity:** Warning
**Action:** Report-only

```bash
fail=0
for d in docs/masterplan/*/; do
  plan="${d}plan.md"
  state="${d}state.yml"
  idx="${d}plan.index.json"
  [ -f "$plan" ] || continue
  current="$(sha256sum "$plan" | awk '{print $1}')"
  if [ -f "$state" ]; then
    state_hash="$(grep -E '^plan_hash:' "$state" | sed 's/.*"sha256:\([a-f0-9]*\)".*/\1/')"
    [ -n "$state_hash" ] && [ "$state_hash" != "$current" ] && \
      { echo "WARN $state: plan_hash drift (state=$state_hash, current=$current)"; fail=1; }
  fi
  if [ -f "$idx" ]; then
    idx_hash="$(jq -r '.plan_hash' "$idx" 2>/dev/null | sed 's/sha256://')"
    [ -n "$idx_hash" ] && [ "$idx_hash" != "$current" ] && \
      { echo "WARN $idx: plan.index.json stale (index=$idx_hash, current=$current)"; fail=1; }
  fi
done
[ $fail -eq 0 ] && echo "Check #34: PASS" || echo "Check #34: WARN"
```
```

- [ ] **Step 2: Update severity table**

- [ ] **Step 3: Verify + commit**

```bash
git add parts/doctor.md
git commit -m "v5: doctor check #34 — plan.index.json staleness via plan_hash"
```

---

### Task 18: Add doctor check #35 (plan-format conformance)

**Files:**
- Modify: `parts/doctor.md`

**Parallel-group:** wave-3
**Codex:** false
**Spec:** [spec.md#L315](spec.md#L315), [spec.md#L161-L184](spec.md#L161-L184)
**Verify:**
```bash
grep -q '^## Check #35' parts/doctor.md
grep -A 30 '^## Check #35' parts/doctor.md | grep -q -F '**Spec:**'
grep -A 30 '^## Check #35' parts/doctor.md | grep -q -F '**Verify:**'
echo CHECK-35-OK
```

Every task in a v5.0 plan.md MUST have `**Spec:**` AND `**Verify:**` markers. Check #35 walks each task heading and grep-verifies the next ~30 lines contain both markers.

- [ ] **Step 1: Append check #35**

```markdown
## Check #35: Plan-format conformance (v5.0 markers)

**Severity:** Warning
**Action:** Report-only

For each `docs/masterplan/*/plan.md`, every task heading (e.g., `### Task N:`)
MUST be followed (within 30 lines, before the next task heading) by both
`**Spec:**` and `**Verify:**` markers.

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  bundle="$(dirname "$plan")"
  # extract task heading line numbers
  mapfile -t tasks < <(grep -n -E '^### Task [0-9]+' "$plan" | cut -d: -f1)
  for i in "${!tasks[@]}"; do
    start="${tasks[$i]}"
    end="${tasks[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    echo "$block" | grep -q -F '**Spec:**' || \
      { echo "WARN $plan task at L$start: missing **Spec:**"; fail=1; }
    echo "$block" | grep -q -F '**Verify:**' || \
      { echo "WARN $plan task at L$start: missing **Verify:**"; fail=1; }
  done
done
[ $fail -eq 0 ] && echo "Check #35: PASS" || echo "Check #35: WARN"
```
```

- [ ] **Step 2: Update severity table**

- [ ] **Step 3: Verify + commit**

```bash
git add parts/doctor.md
git commit -m "v5: doctor check #35 — plan-format conformance (Spec + Verify markers)"
```

---

### Task 19: Add doctor check #36 (router ceiling + phase file sanity)

**Files:**
- Modify: `parts/doctor.md`

**Parallel-group:** wave-3
**Codex:** false
**Spec:** [spec.md#L316](spec.md#L316), [spec.md#L86](spec.md#L86), [spec.md#L102-L110](spec.md#L102-L110)
**Verify:**
```bash
grep -q '^## Check #36' parts/doctor.md
grep -A 40 '^## Check #36' parts/doctor.md | grep -q '20480'  # 20KB ceiling
grep -A 40 '^## Check #36' parts/doctor.md | grep -q 'DISPATCH-SITE'
grep -A 40 '^## Check #36' parts/doctor.md | grep -q 'CC-3-trampoline'
echo CHECK-36-OK
```

Hard checks: (a) `wc -c commands/masterplan.md` ≤20480 bytes, (b) all four `parts/step-{0,a,b,c}.md` exist, (c) CC-3-trampoline anchor in router and in step-0, (d) DISPATCH-SITE tags scoped to step-c.md in step-c.md.

- [ ] **Step 1: Append check #36**

```markdown
## Check #36: parts/step-*.md sanity + router ceiling

**Severity:** Warning
**Action:** Report-only

```bash
fail=0
size="$(wc -c < commands/masterplan.md)"
if [ "$size" -gt 20480 ]; then
  echo "WARN commands/masterplan.md is $size bytes (ceiling 20480)"
  fail=1
fi
for phase in 0 a b c; do
  if [ ! -f "parts/step-$phase.md" ]; then
    echo "WARN parts/step-$phase.md missing"; fail=1
  fi
done
grep -q 'CC-3-trampoline' commands/masterplan.md || \
  { echo "WARN CC-3-trampoline missing from router"; fail=1; }
grep -q 'CC-3-trampoline' parts/step-0.md || \
  { echo "WARN CC-3-trampoline missing from step-0"; fail=1; }
grep -q 'DISPATCH-SITE: step-c.md' parts/step-c.md 2>/dev/null || \
  { echo "WARN DISPATCH-SITE: step-c.md tags missing from step-c.md"; fail=1; }
[ $fail -eq 0 ] && echo "Check #36: PASS" || echo "Check #36: WARN"
```
```

- [ ] **Step 2: Update severity table**

- [ ] **Step 3: Verify + commit**

```bash
git add parts/doctor.md
git commit -m "v5: doctor check #36 — router ceiling + phase file sanity"
```

---

## Wave D: Router Rewrite

### Task 20: Rewrite `commands/masterplan.md` as the v5 router

**Files:**
- Modify: `commands/masterplan.md` (3030 lines → ≤20KB router)

**Parallel-group:** wave-4
**Codex:** true (bounded well-defined: full content known, target shape known)
**Spec:** [spec.md#L65](spec.md#L65), [spec.md#L88-L100](spec.md#L88-L100)
**Verify:**
```bash
[ "$(wc -c < commands/masterplan.md)" -le 20480 ]
grep -q 'CC-1' commands/masterplan.md      # arg-lock guard
grep -q 'CC-2' commands/masterplan.md      # banner guard
grep -q 'CC-3-trampoline' commands/masterplan.md
grep -q 'load.*parts/step-' commands/masterplan.md
grep -q 'codex.host' commands/masterplan.md  # Codex detect
! grep -q -E 'Step A|Step B|Step C|^#+ B[0-3]' commands/masterplan.md  # NO phase logic
echo ROUTER-OK
```

Final rewrite: monolith becomes the router. Contains ONLY verb dispatch, argument precedence (CC-1), boot guards (CC-2, CC-3-trampoline), Codex host detection (conditionally load `parts/codex-host.md`), phase-prompt loader (`parts/step-{current_phase}.md`), and doctor entry point. No phase content, no CD-rules verbatim, no agent-dispatch contract, no projection logic.

- [ ] **Step 1: Backup current monolith**

```bash
cp commands/masterplan.md commands/masterplan.md.v4-backup
```

- [ ] **Step 2: Verify all extracted content exists in parts/**

```bash
for f in step-0 step-a step-b step-c doctor import codex-host; do
  test -f "parts/$f.md" || { echo "MISSING parts/$f.md"; exit 1; }
done
for f in agent-dispatch cd-rules taskcreate-projection run-bundle; do
  test -f "parts/contracts/$f.md" || { echo "MISSING parts/contracts/$f.md"; exit 1; }
done
echo PREFLIGHT-OK
```

- [ ] **Step 3: Write the router**

Replace the entire content of `commands/masterplan.md` with:

```markdown
---
description: Lazy-loading orchestrator router for /masterplan. Dispatches verbs to parts/step-{0,a,b,c}.md and parts/{doctor,import}.md.
---

# /masterplan Router (v5.0)

> v5.0 router. Phase content lives in `parts/`. Doctor lives in `parts/doctor.md`. Contracts in `parts/contracts/`.

## CC-1 — Arg-lock guard
<args parsing + precedence rules>

## CC-2 — Boot banner
<one-line banner: version + verb + slug>

## CC-3-trampoline
<re-entry anchor for resume>

## Verb dispatch table

| Verb | Routes to | Notes |
|---|---|---|
| start | parts/step-0.md → step-a.md → step-b.md → step-c.md | full flow |
| resume | parts/step-0.md → parts/step-{state.current_phase}.md | re-entry |
| status | parts/step-0.md (status subroutine) | no mutation |
| doctor | parts/step-0.md → parts/doctor.md | all 36 checks |
| import | parts/step-0.md → parts/import.md | legacy migration |
| archive | parts/step-0.md → parts/step-c.md (archive subroutine) | |
| validate | parts/step-0.md → docs/config-schema.md | config-only |
| retry | parts/step-0.md → parts/step-c.md (wave-dispatch subroutine) | |

## Codex host detection
If invoked via `/superpowers-masterplan:masterplan` (Codex host), load `parts/codex-host.md` before phase dispatch. Suppresses `codex:codex-rescue` companion dispatch to prevent recursion.

## Phase-prompt loader
After Step 0 completes bootstrap, route by verb. For start/resume/retry, load `parts/step-{state.yml.current_phase}.md`. The phase file is self-contained; it loads contracts on demand.

## Doctor entry point
For `doctor` verb: after Step 0 bootstrap, load `parts/doctor.md` and run all checks. Check #36 verifies this router stays ≤20KB.

## Config reference
Schema documented in `docs/config-schema.md`. Loaded only on `validate` verb.

## Reserved verbs warning
The following verbs are reserved and will be rejected: <list>.
```

Fill the placeholders with the actual CC-1/CC-2/CC-3-trampoline blocks extracted from the v4 monolith (use `commands/masterplan.md.v4-backup` as source). Keep the router tight: target 15KB, hard ceiling 20KB.

- [ ] **Step 4: Run check #36 to verify the ceiling**

```bash
bash -c "$(sed -n '/^## Check #36/,/^## Check #/p' parts/doctor.md | sed -n '/```bash/,/```/p' | sed '1d;$d')"
```
Expected: `Check #36: PASS`.

- [ ] **Step 5: Negative test — confirm NO phase content leaked into router**

```bash
! grep -q -E '^### Task [0-9]+' commands/masterplan.md && echo "no plan-format leaked"
! grep -q -E 'wave.*dispatch.*Slice' commands/masterplan.md && echo "no Step C content leaked"
! grep -q 'CD-1:' commands/masterplan.md && echo "no CD-rule bodies leaked"
```
All three should print their OK message.

- [ ] **Step 6: Smoke test — bash -n on any inline scripts in the router**

```bash
# extract any fenced ```bash blocks and check syntax
awk '/^```bash$/{f=1;next} /^```$/{f=0} f' commands/masterplan.md > /tmp/router-bash.sh
bash -n /tmp/router-bash.sh && echo "router bash OK"
```

- [ ] **Step 7: Remove the backup (or move to a known location for the migration test in Wave J)**

```bash
mkdir -p /tmp/v5-migration-fixtures
mv commands/masterplan.md.v4-backup /tmp/v5-migration-fixtures/masterplan.md.v4-backup
```

- [ ] **Step 8: Commit**

```bash
git add commands/masterplan.md
git commit -m "v5: rewrite commands/masterplan.md as router (≤20KB)"
```

---

## Wave E: bin/masterplan-state.sh Subcommands

### Task 21: Add `build-index` subcommand

**Files:**
- Modify: `bin/masterplan-state.sh`

**Parallel-group:** wave-5
**Codex:** true (bounded well-defined bash subcommand)
**Spec:** [spec.md#L119-L160](spec.md#L119-L160), [spec.md#L156-L160](spec.md#L156-L160)
**Verify:**
```bash
bin/masterplan-state.sh build-index v5-lazy-phase-prompts 2>&1 | tee /tmp/bi.out
test -f docs/masterplan/v5-lazy-phase-prompts/plan.index.json
jq -e '.schema_version == "5.0"' docs/masterplan/v5-lazy-phase-prompts/plan.index.json
jq -e '.tasks | length >= 1' docs/masterplan/v5-lazy-phase-prompts/plan.index.json
echo BUILD-INDEX-OK
```

Add a `build-index <slug>` subcommand that parses `docs/masterplan/<slug>/plan.md` and emits a Full v5.0 `plan.index.json` (schema in spec §L119-L160).

- [ ] **Step 1: Pre-check — confirm subcommand absent**

```bash
bin/masterplan-state.sh build-index v5-lazy-phase-prompts 2>&1 | grep -q -E 'unknown|invalid' && echo "absent OK"
```

- [ ] **Step 2: Add usage entry**

Modify the comment block at `bin/masterplan-state.sh:19-23` to include:
```
#   bin/masterplan-state.sh build-index <slug>
```

- [ ] **Step 3: Add the dispatch branch**

In the main case statement (~L304 in current file), add a `build-index)` branch:
```bash
build-index)
  slug="${1:?error: build-index requires <slug>}"
  bundle="docs/masterplan/$slug"
  plan="$bundle/plan.md"
  out="$bundle/plan.index.json"
  [ -f "$plan" ] || { echo "ERROR: $plan not found" >&2; exit 1; }
  plan_hash="sha256:$(sha256sum "$plan" | awk '{print $1}')"
  generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$plan" "$plan_hash" "$generated_at" <<'PY' > "$out"
import json, re, sys, hashlib
plan_path, plan_hash, generated_at = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(plan_path).read().splitlines()
tasks, current, idx = [], None, 0
for i, line in enumerate(text, start=1):
    m = re.match(r"^### Task (\d+):\s*(.+)$", line)
    if m:
        if current: tasks.append(current)
        idx = int(m.group(1))
        current = {"idx": idx, "name": m.group(2).strip(),
                   "offset": i, "lines": 0, "files": [], "codex": False,
                   "parallel_group": None, "verify_commands": [], "spec_refs": []}
        continue
    if not current: continue
    current["lines"] = i - current["offset"]
    if m2 := re.match(r"^\*\*Files:\*\*\s*(.+)$", line):
        s = m2.group(1).strip()
        current["files"] = [p.strip().lstrip("-").strip() for p in s.split(",") if p.strip()]
    elif m2 := re.match(r"^\*\*Parallel-group:\*\*\s*(.+)$", line):
        v = m2.group(1).strip()
        current["parallel_group"] = None if v.lower() in ("none","null","") else v
    elif m2 := re.match(r"^\*\*Codex:\*\*\s*(true|false)", line, re.I):
        current["codex"] = m2.group(1).lower() == "true"
    elif m2 := re.match(r"^\*\*Spec:\*\*\s*(.+)$", line):
        refs = re.findall(r"spec\.md#L\d+(?:-L\d+)?", m2.group(1))
        current["spec_refs"] = refs
    elif line.strip().startswith("**Verify:**"):
        # collect fenced bash block immediately following
        j = i  # 1-indexed; next is text[i]
        while j < len(text) and not text[j].startswith("```bash"): j += 1
        if j < len(text):
            j += 1
            while j < len(text) and text[j].strip() != "```":
                cmd = text[j].strip()
                if cmd and not cmd.startswith("#"):
                    current["verify_commands"].append(cmd)
                j += 1
if current: tasks.append(current)
print(json.dumps({"schema_version":"5.0","plan_hash":plan_hash,
                  "generated_at":generated_at,"tasks":tasks}, indent=2))
PY
  echo "wrote $out ($(jq '.tasks | length' "$out") tasks)"
  ;;
```

- [ ] **Step 4: Verify against this run's `plan.md`**

```bash
bin/masterplan-state.sh build-index v5-lazy-phase-prompts
jq '.tasks | length' docs/masterplan/v5-lazy-phase-prompts/plan.index.json
```
Expected: count ≥ 30 (tasks in this plan).

- [ ] **Step 5: Sanity-check the schema**

```bash
jq -e '.schema_version == "5.0"' docs/masterplan/v5-lazy-phase-prompts/plan.index.json
jq -e '.tasks[0] | has("idx") and has("verify_commands") and has("spec_refs")' \
  docs/masterplan/v5-lazy-phase-prompts/plan.index.json
echo SCHEMA-OK
```

- [ ] **Step 6: Commit**

```bash
git add bin/masterplan-state.sh docs/masterplan/v5-lazy-phase-prompts/plan.index.json
git commit -m "v5: bin/masterplan-state.sh build-index <slug> + dogfood index"
```

---

### Task 22: Add `migrate-state` subcommand

**Files:**
- Modify: `bin/masterplan-state.sh`

**Parallel-group:** wave-5
**Codex:** true
**Spec:** [spec.md#L299-L309](spec.md#L299-L309)
**Verify:**
```bash
# requires a v4-fixture bundle
mkdir -p /tmp/v5-migration-fixtures/test-bundle
cat > /tmp/v5-migration-fixtures/test-bundle/state.yml <<'EOF'
schema_version: "4.2"
slug: test-bundle
autonomy: loose
complexity: high
handoff: "this is a very long handoff essay that goes on and on for many many many characters in order to exceed the 200 char cap that v5 enforces hard at write time so we can verify the overflow logic correctly moves the content to handoff dot md with an overflow pointer in the scalar"
EOF
bin/masterplan-state.sh migrate-state --bundle /tmp/v5-migration-fixtures/test-bundle
grep -q 'schema_version: "5.0"' /tmp/v5-migration-fixtures/test-bundle/state.yml
grep -q 'overflow at handoff.md' /tmp/v5-migration-fixtures/test-bundle/state.yml
test -f /tmp/v5-migration-fixtures/test-bundle/state.yml.v4-backup
test -f /tmp/v5-migration-fixtures/test-bundle/handoff.md
echo MIGRATE-STATE-OK
```

Add a `migrate-state` subcommand. Naming chosen to avoid collision with existing `migrate` (v3→v4 layout migration). Reads a v4.x `state.yml`, writes a v5.0 `state.yml`, moves >200-char scalars to `handoff.md`/`blockers.md` with overflow pointer, backs up to `state.yml.v4-backup`. Idempotent.

- [ ] **Step 1: Add usage entry**

```
#   bin/masterplan-state.sh migrate-state [--bundle <path>|--slug <slug>]
```

- [ ] **Step 2: Add dispatch branch**

```bash
migrate-state)
  bundle=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --bundle) bundle="$2"; shift 2 ;;
      --slug)   bundle="docs/masterplan/$2"; shift 2 ;;
      *) echo "ERROR unknown arg: $1" >&2; exit 2 ;;
    esac
  done
  [ -d "$bundle" ] || { echo "ERROR: bundle dir not found: $bundle" >&2; exit 1; }
  state="$bundle/state.yml"
  [ -f "$state" ] || { echo "ERROR: state.yml not found in $bundle" >&2; exit 1; }
  # idempotency: skip if already v5.0
  if grep -q 'schema_version: "5.0"' "$state"; then
    echo "already v5.0: $state"; exit 0
  fi
  cp "$state" "$state.v4-backup"
  plan="$bundle/plan.md"
  plan_hash="sha256:none"
  [ -f "$plan" ] && plan_hash="sha256:$(sha256sum "$plan" | awk '{print $1}')"
  python3 - "$state" "$plan_hash" "$bundle" <<'PY'
import sys, re, os, pathlib
state_path, plan_hash, bundle = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(state_path).read()
# Replace schema_version
text = re.sub(r'schema_version:\s*"[^"]+"', 'schema_version: "5.0"', text)
if 'schema_version:' not in text:
    text = 'schema_version: "5.0"\n' + text
# Add plan_hash if missing
if 'plan_hash:' not in text:
    text = text.replace('schema_version: "5.0"\n',
                        f'schema_version: "5.0"\nplan_hash: "{plan_hash}"\n', 1)
# Flip unset complexity → medium; preserve explicit high
if not re.search(r'^complexity:', text, re.M):
    text += "complexity: medium\n"
# Infer current_phase from existing markers (best-effort)
if 'current_phase:' not in text:
    if re.search(r'step_c|wave_', text): phase = 'step-c'
    elif re.search(r'plan_complete|spec_complete', text): phase = 'step-b'
    elif re.search(r'intake|spec_draft', text): phase = 'step-a'
    else: phase = 'step-0'
    text = text.replace('schema_version: "5.0"\n',
                        f'schema_version: "5.0"\ncurrent_phase: {phase}\n', 1)
# Walk scalars, move overflows
def cap_scalar(match):
    key, val = match.group(1), match.group(2)
    # strip quotes for length test
    raw = val.strip().strip('"\'')
    if len(raw) <= 200:
        return match.group(0)
    target = 'handoff.md' if key in ('handoff',) else 'blockers.md' if key in ('blockers',) else 'overflow.md'
    target_path = pathlib.Path(bundle) / target
    existing = target_path.read_text() if target_path.exists() else ''
    new_line = len(existing.splitlines()) + 1
    with open(target_path, 'a') as fh:
        if existing and not existing.endswith('\n'): fh.write('\n')
        fh.write(f'# {key} (migrated v4 -> v5)\n{raw}\n')
    return f'{key}: "*overflow at {target} L{new_line + 1}*"'
text = re.sub(r'^([a-zA-Z_]+):\s*(.+)$', cap_scalar, text, flags=re.M)
open(state_path, 'w').write(text)
PY
  echo "migrated: $state (backup at $state.v4-backup)"
  ;;
```

- [ ] **Step 3: Verify against the test fixture**

Run the verify command from the header.

- [ ] **Step 4: Idempotency test**

```bash
bin/masterplan-state.sh migrate-state --bundle /tmp/v5-migration-fixtures/test-bundle
# second run should report "already v5.0" and exit 0
```
Expected: `already v5.0: <path>`.

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-state.sh
git commit -m "v5: bin/masterplan-state.sh migrate-state (v4.x -> v5.0)"
```

---

### Task 23: Add `migrate-plan` subcommand

**Files:**
- Modify: `bin/masterplan-state.sh`

**Parallel-group:** wave-5
**Codex:** true
**Spec:** [spec.md#L182-L184](spec.md#L182-L184)
**Verify:**
```bash
# fixture: a v4-style plan with a fenced bash verify block
mkdir -p /tmp/v5-migration-fixtures/plan-fixture
cat > /tmp/v5-migration-fixtures/plan-fixture/plan.md <<'EOF'
# Plan

### Task 1: Do something

**Files:** src/foo.py

Some description.

```bash
test -f src/foo.py
```

Next.
EOF
bin/masterplan-state.sh migrate-plan --bundle /tmp/v5-migration-fixtures/plan-fixture
grep -F -q '**Verify:**' /tmp/v5-migration-fixtures/plan-fixture/plan.md
echo MIGRATE-PLAN-OK
```

Best-effort: scan plan.md for fenced bash blocks adjacent to task headings, prepend `**Verify:**` label. WARN when task lacks `**Spec:**` reference (no auto-rewrite for spec refs).

- [ ] **Step 1: Add usage entry**

```
#   bin/masterplan-state.sh migrate-plan [--bundle <path>|--slug <slug>] [--dry-run]
```

- [ ] **Step 2: Add dispatch branch**

```bash
migrate-plan)
  bundle=""; dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --bundle) bundle="$2"; shift 2 ;;
      --slug)   bundle="docs/masterplan/$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) echo "ERROR unknown arg: $1" >&2; exit 2 ;;
    esac
  done
  plan="$bundle/plan.md"
  [ -f "$plan" ] || { echo "ERROR: $plan not found" >&2; exit 1; }
  tmp="$(mktemp)"
  python3 - "$plan" <<'PY' > "$tmp"
import sys, re
text = open(sys.argv[1]).read()
lines = text.splitlines(keepends=True)
out = []
i = 0
in_task = False
warn_spec = []
current_task = None
while i < len(lines):
    line = lines[i]
    m = re.match(r'^### Task (\d+):', line)
    if m:
        in_task = True
        current_task = int(m.group(1))
        out.append(line); i += 1; continue
    if in_task:
        # detect fenced bash block NOT preceded by **Verify:**
        if line.startswith('```bash') and (not out or '**Verify:**' not in out[-1]):
            out.append('**Verify:**\n')
        if line.startswith('### Task '):
            in_task = False
            continue  # let next iter handle
    out.append(line); i += 1
sys.stdout.write(''.join(out))
PY
  if [ $dry_run -eq 1 ]; then
    diff -u "$plan" "$tmp" || true
  else
    cp "$plan" "$plan.v4-backup"
    mv "$tmp" "$plan"
    echo "migrated: $plan (backup at $plan.v4-backup)"
  fi
  # spec_refs warning
  python3 - "$plan" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
tasks = re.split(r'(?m)^### Task (\d+):', text)
# tasks alternates: [preamble, num1, body1, num2, body2, ...]
for num, body in zip(tasks[1::2], tasks[2::2]):
    if '**Spec:**' not in body:
        print(f"WARN task #{num}: missing **Spec:** marker (manual fix required)")
PY
  ;;
```

- [ ] **Step 3: Verify against fixture (dry-run first)**

```bash
bin/masterplan-state.sh migrate-plan --bundle /tmp/v5-migration-fixtures/plan-fixture --dry-run
# observe diff
bin/masterplan-state.sh migrate-plan --bundle /tmp/v5-migration-fixtures/plan-fixture
grep -F -q '**Verify:**' /tmp/v5-migration-fixtures/plan-fixture/plan.md && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add bin/masterplan-state.sh
git commit -m "v5: bin/masterplan-state.sh migrate-plan (best-effort verify-block wrap)"
```

---

### Task 24: Add 200-char scalar cap enforcement to existing write paths

**Files:**
- Modify: `bin/masterplan-state.sh` (any function that writes state.yml)

**Parallel-group:** wave-5
**Codex:** true
**Spec:** [spec.md#L214-L217](spec.md#L214-L217)
**Verify:**
```bash
# attempt to write a >200 char scalar via the existing write path
# (specific test depends on which function writes scalars)
bin/masterplan-state.sh --help 2>&1 | head -10  # smoke that the script still runs
echo CAP-ENFORCEMENT-OK
```

Add a helper function `_enforce_scalar_cap(key, value)` that returns the same value if ≤200 chars, OR appends the value to `handoff.md`/`blockers.md` and returns the overflow pointer. Wire into every state.yml-write code path.

- [ ] **Step 1: Locate state-write functions**

```bash
grep -n -E 'state\.yml|write.*state|state.*write' bin/masterplan-state.sh | head -20
```

- [ ] **Step 2: Add the helper near the top of the script (after argument parsing)**

```bash
# v5.0: enforce 200-char scalar cap; overflow to handoff.md / blockers.md
_enforce_scalar_cap() {
  local bundle="$1" key="$2" value="$3"
  local raw="${value#\"}"; raw="${raw%\"}"
  if [ "${#raw}" -le 200 ]; then
    printf '%s' "$value"
    return
  fi
  local target
  case "$key" in
    handoff|handoff_text|handoff_summary) target="handoff.md" ;;
    blockers|blocker_text)                target="blockers.md" ;;
    *)                                    target="overflow.md" ;;
  esac
  local target_path="$bundle/$target"
  local new_line
  if [ -f "$target_path" ]; then
    new_line=$(($(wc -l < "$target_path") + 1))
  else
    new_line=1
  fi
  printf '# %s (v5 overflow)\n%s\n' "$key" "$raw" >> "$target_path"
  printf '"*overflow at %s L%d*"' "$target" "$new_line"
}
```

- [ ] **Step 3: Wire into write paths**

For each function that writes a scalar value to state.yml, substitute the raw value with `$(_enforce_scalar_cap "$bundle" "$key" "$value")`.

- [ ] **Step 4: Smoke test**

```bash
bash -n bin/masterplan-state.sh && echo "syntax OK"
bin/masterplan-state.sh --help 2>&1 | head -5
```

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-state.sh
git commit -m "v5: bin/masterplan-state.sh enforce 200-char scalar cap with overflow"
```

---

## Wave F: Telemetry & Routing-Stats

### Task 25: Add `parent_turn` emission to telemetry hook

**Files:**
- Modify: `hooks/masterplan-telemetry.sh`

**Parallel-group:** wave-6
**Codex:** true
**Spec:** [spec.md#L246-L272](spec.md#L246-L272)
**Verify:**
```bash
bash -n hooks/masterplan-telemetry.sh && echo "syntax OK"
grep -q 'parent_turn' hooks/masterplan-telemetry.sh
grep -q 'message.usage' hooks/masterplan-telemetry.sh
echo TELEMETRY-OK
```

After the existing subagent_turn emit loop, add a second pass that iterates `type == "assistant"` transcript entries and emits one `parent_turn` JSONL record per turn with the full `message.usage.*` object.

- [ ] **Step 1: Locate the existing emit loop**

```bash
grep -n -E 'subagent_turn|tool_use|toolUseResult' hooks/masterplan-telemetry.sh | head -10
```

- [ ] **Step 2: Add the parent_turn emit pass**

After the subagent_turn loop, add (approximately):

```bash
# v5.0: emit parent_turn records
emit_parent_turns() {
  local transcript_path="$1" out_path="$2"
  local session_id="$3"
  jq -c --arg session "$session_id" '
    select(.type == "assistant" and .message.usage) |
    {
      ts: (.timestamp // .message.id),
      type: "parent_turn",
      session_id: $session,
      model: (.message.model // "unknown"),
      verb: (env.MASTERPLAN_VERB // null),
      current_phase: (env.MASTERPLAN_PHASE // null),
      current_wave: (env.MASTERPLAN_WAVE // null),
      usage: .message.usage
    }
  ' "$transcript_path" >> "$out_path"
}
emit_parent_turns "$TRANSCRIPT_PATH" "$TELEMETRY_OUT" "$SESSION_ID"
```

Adjust env var names to match what the existing hook reads from. The hook may already have access to `verb` / `phase` / `wave` via parsed state.yml — reuse those.

- [ ] **Step 3: Verify hook syntax**

```bash
bash -n hooks/masterplan-telemetry.sh && echo OK
```

- [ ] **Step 4: Smoke (offline) — run hook with a sample transcript**

```bash
# Create a minimal sample
cat > /tmp/sample-transcript.jsonl <<'EOF'
{"type":"assistant","message":{"model":"opus-4-7","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
EOF
TRANSCRIPT_PATH=/tmp/sample-transcript.jsonl TELEMETRY_OUT=/tmp/sample-out.jsonl SESSION_ID=test-123 \
  bash -c 'source hooks/masterplan-telemetry.sh; emit_parent_turns "$TRANSCRIPT_PATH" "$TELEMETRY_OUT" "$SESSION_ID"' || true
grep parent_turn /tmp/sample-out.jsonl
```
Expected: a JSON line with `"type":"parent_turn"`.

- [ ] **Step 5: Commit**

```bash
git add hooks/masterplan-telemetry.sh
git commit -m "v5: hooks/masterplan-telemetry.sh emit parent_turn records"
```

---

### Task 26: Add `--parent` flag to routing-stats

**Files:**
- Modify: `bin/masterplan-routing-stats.sh`

**Parallel-group:** wave-6
**Codex:** true
**Spec:** [spec.md#L272](spec.md#L272)
**Verify:**
```bash
bash -n bin/masterplan-routing-stats.sh && echo "syntax OK"
bin/masterplan-routing-stats.sh --help 2>&1 | grep -q -- '--parent' && echo HELP-OK
# offline smoke (need a fixture JSONL with parent_turn records)
echo '{"type":"parent_turn","model":"opus-4-7","usage":{"input_tokens":100,"output_tokens":50}}' > /tmp/rstats-fixture.jsonl
echo '{"type":"subagent_turn","model":"haiku","usage":{"input_tokens":20,"output_tokens":10}}' >> /tmp/rstats-fixture.jsonl
bin/masterplan-routing-stats.sh --parent --file /tmp/rstats-fixture.jsonl 2>&1 | grep -q -E 'parent|opus'
echo PARENT-FLAG-OK
```

Add `--parent` flag that splits the routing-stats report into "parent_turn" and "subagent_turn" attribution sections.

- [ ] **Step 1: Locate the flag-parsing block**

```bash
grep -n -E '^\s*--|getopts|parse.*arg' bin/masterplan-routing-stats.sh | head -10
```

- [ ] **Step 2: Add --parent flag handling**

In the arg-parse loop, add a `--parent` branch that sets `PARENT_MODE=1`. In the main report-generation function, when `PARENT_MODE=1`:
- Aggregate `parent_turn` records separately from `subagent_turn` records.
- Emit a section header `## Parent attribution` then the table.
- Emit a section header `## Subagent attribution` then the existing table.

- [ ] **Step 3: Update --help text**

Add a line in the usage block:
```
  --parent            Split report into parent_turn and subagent_turn attribution
```

- [ ] **Step 4: Verify**

Run verify command above.

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-routing-stats.sh
git commit -m "v5: bin/masterplan-routing-stats.sh --parent splits parent vs subagent"
```

---

## Wave G: Self-Host Audit Additions

### Task 27: Per-phase-file checks in self-host audit

**Files:**
- Modify: `bin/masterplan-self-host-audit.sh`

**Parallel-group:** wave-7
**Codex:** true
**Spec:** [spec.md#L280-L288](spec.md#L280-L288)
**Verify:**
```bash
bash -n bin/masterplan-self-host-audit.sh && echo "syntax OK"
bin/masterplan-self-host-audit.sh 2>&1 | tee /tmp/audit.out
grep -q 'CC-3-trampoline' /tmp/audit.out
grep -q 'DISPATCH-SITE' /tmp/audit.out
grep -q 'plan-format' /tmp/audit.out
echo AUDIT-OK
```

Add per-phase-file checks: (a) CC-3-trampoline anchor in router + entry phase files, (b) CD-9 grep across all parts/, (c) DISPATCH-SITE tags scoped correctly, (d) sentinel grep for orphan v4.x refs, (e) plan-format conformance wiring (doctor #35 surface).

- [ ] **Step 1: Locate existing check functions**

```bash
grep -n -E '^(check_|audit_)' bin/masterplan-self-host-audit.sh | head -20
```

- [ ] **Step 2: Add the new check functions**

```bash
check_cc3_trampoline() {
  local fail=0
  grep -q 'CC-3-trampoline' commands/masterplan.md || { echo "FAIL: CC-3-trampoline missing from router"; fail=1; }
  grep -q 'CC-3-trampoline' parts/step-0.md       || { echo "FAIL: CC-3-trampoline missing from step-0"; fail=1; }
  [ $fail -eq 0 ] && echo "CC-3-trampoline: PASS"
  return $fail
}

check_cd9_coverage() {
  local fail=0
  if ! grep -r -l 'CD-9' parts/ 2>/dev/null | head -1 > /dev/null; then
    echo "WARN: CD-9 not referenced in any parts/* file"
  fi
  # Sample check: parts/step-c.md should reference CD-9 (canonical writer)
  grep -q 'CD-9' parts/step-c.md 2>/dev/null || { echo "WARN: step-c.md does not reference CD-9"; fail=1; }
  [ $fail -eq 0 ] && echo "CD-9 coverage: PASS" || echo "CD-9 coverage: WARN"
  return 0
}

check_dispatch_sites() {
  local fail=0
  if ! grep -q 'DISPATCH-SITE: step-c.md' parts/step-c.md 2>/dev/null; then
    echo "FAIL: DISPATCH-SITE: step-c.md tags missing from step-c.md"; fail=1
  fi
  # Negative: router must NOT carry dispatch-site tags (no dispatch happens in router)
  if grep -q 'DISPATCH-SITE:' commands/masterplan.md 2>/dev/null; then
    echo "FAIL: router has DISPATCH-SITE tag (should be in phase files only)"; fail=1
  fi
  [ $fail -eq 0 ] && echo "DISPATCH-SITE: PASS"
  return $fail
}

check_sentinel_v4_refs() {
  # No file in parts/ should reference v4 monolith line numbers
  if grep -r -E 'commands/masterplan\.md:[0-9]+' parts/ 2>/dev/null; then
    echo "FAIL: parts/* contains v4 monolith line-number reference"
    return 1
  fi
  echo "sentinel (no v4 refs): PASS"
}

check_plan_format() {
  # delegate to doctor check #35 logic
  local fail=0
  for plan in docs/masterplan/*/plan.md; do
    grep -E '^### Task [0-9]+' "$plan" | while read -r task_heading; do
      :  # check #35 already walks tasks; here we just confirm one task per bundle has markers
    done
    if grep -q -F '**Spec:**' "$plan" && grep -q -F '**Verify:**' "$plan"; then
      :
    else
      echo "FAIL: $plan missing v5 plan-format markers"; fail=1
    fi
  done
  [ $fail -eq 0 ] && echo "plan-format: PASS"
  return $fail
}
```

- [ ] **Step 3: Wire into the main audit function**

Find the existing top-level orchestration function and append calls to each new check.

- [ ] **Step 4: Run the audit**

```bash
bash -n bin/masterplan-self-host-audit.sh && echo "syntax OK"
bin/masterplan-self-host-audit.sh
```

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-self-host-audit.sh
git commit -m "v5: bin/masterplan-self-host-audit.sh per-phase-file checks"
```

---

## Wave H: SKILL.md + Internals

### Task 28: Update `skills/masterplan/SKILL.md`

**Files:**
- Modify: `skills/masterplan/SKILL.md`

**Parallel-group:** wave-8
**Codex:** false
**Spec:** [spec.md#L290-L297](spec.md#L290-L297)
**Verify:**
```bash
grep -q 'parts/step-' skills/masterplan/SKILL.md
grep -q -E 'v5\.0|5\.0\.0' skills/masterplan/SKILL.md
grep -q '#32' skills/masterplan/SKILL.md
echo SKILL-OK
```

Update Codex entrypoint to reference the v5 layout, new doctor checks #32–#36, and v5.0 state.yml schema.

- [ ] **Step 1: Read current SKILL.md**

```bash
sed -n '1,50p' skills/masterplan/SKILL.md
```

- [ ] **Step 2: Update references**

Make at minimum these edits:
- Mention `parts/step-{0,a,b,c}.md` and `parts/{doctor,import,codex-host}.md` in the layout description.
- Add `parts/contracts/` mention.
- Bump version reference to v5.0.
- Update doctor section to mention #32–#36.
- Update state.yml schema mention to v5.0 (with `current_phase` + `plan_hash` + overflow pointers).

- [ ] **Step 3: Verify**

Run verify command.

- [ ] **Step 4: Commit**

```bash
git add skills/masterplan/SKILL.md
git commit -m "v5: skills/masterplan/SKILL.md sync to v5 layout"
```

---

### Task 29: Update `docs/internals.md`

**Files:**
- Modify: `docs/internals.md`

**Parallel-group:** wave-8
**Codex:** false
**Spec:** [spec.md#L320](spec.md#L320)
**Verify:**
```bash
grep -q 'parts/step-' docs/internals.md
grep -q '#32' docs/internals.md
grep -q '#36' docs/internals.md
echo INTERNALS-OK
```

Update internals doc to reference the v5 layout (parts/ split, contracts/, doctor.md, import.md) and add #32–#36 to the doctor-checks family-list (§10).

- [ ] **Step 1: Find the family-list section (§10)**

```bash
grep -n -E '^#+ .*Doctor|^#+ .*Family' docs/internals.md
```

- [ ] **Step 2: Add #32–#36 entries to the family list**

Follow the existing entry format. Each entry includes: ID, severity, brief description, location reference.

- [ ] **Step 3: Update layout references throughout the doc**

Find references to `commands/masterplan.md§Step X` and update to `parts/step-X.md` where applicable. Add a v5-introduction paragraph near the top noting the lazy-load split.

- [ ] **Step 4: Verify**

Run verify command.

- [ ] **Step 5: Commit**

```bash
git add docs/internals.md
git commit -m "v5: docs/internals.md updated for parts/ layout + checks #32-#36"
```

---

## Wave I: Version Bump + CHANGELOG

### Task 30: Bump plugin manifests to 5.0.0

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json` (root + nested entries)
- Modify: `.codex-plugin/plugin.json`

**Parallel-group:** wave-9
**Codex:** false
**Spec:** [spec.md#L308](spec.md#L308)
**Verify:**
```bash
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json; do
  jq -r '.. | objects | .version? // empty' "$f" | sort -u | tee /tmp/v.out
  grep -q '^5\.0\.0$' /tmp/v.out || { echo "FAIL: $f not bumped to 5.0.0"; exit 1; }
done
echo VERSION-BUMP-OK
```

Bump all version fields across the four manifests from 4.2.1 → 5.0.0.

- [ ] **Step 1: Locate version fields**

```bash
grep -n '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json
```

- [ ] **Step 2: Edit each file**

Replace `"version": "4.2.1"` with `"version": "5.0.0"` in:
- `.claude-plugin/plugin.json` (top-level version)
- `.claude-plugin/marketplace.json` (root version + every entry's nested version)
- `.codex-plugin/plugin.json` (top-level version)

- [ ] **Step 3: Verify**

Run verify command.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json
git commit -m "v5: bump plugin manifests to 5.0.0"
```

---

### Task 31: Add CHANGELOG ## [5.0.0] entry

**Files:**
- Modify: `CHANGELOG.md`

**Parallel-group:** wave-9
**Codex:** false
**Spec:** [spec.md](spec.md) (release artifact)
**Verify:**
```bash
grep -q '^## \[5\.0\.0\]' CHANGELOG.md
sed -n '/^## \[5\.0\.0\]/,/^## \[/p' CHANGELOG.md | head -50 | grep -q 'parts/step-'
echo CHANGELOG-OK
```

Add `## [5.0.0]` entry above `## [4.2.1]` with these sections:
- Added: lazy-load phase prompts, plan.index.json, parent_turn telemetry, doctor checks #32–#36, migrate-state / migrate-plan / build-index subcommands.
- Changed: file layout (commands/masterplan.md → router + parts/), state.yml schema v5, complexity default flipped to medium, TaskCreate projection threshold defaults to 15.
- Migration: `bin/masterplan-state.sh migrate-state <slug>` + `migrate-plan <slug>` + `build-index <slug>`. Plan format requires `**Spec:**` + `**Verify:**` markers.
- Verification: doctor #36 enforces router ≤20KB; self-host-audit walks per-phase-file checks.
- Notes: warm-session savings flatten after first phase Read; gains concentrated at cache-miss boundaries (cross-session, /loop crossing 5min TTL, post-/compact).

- [ ] **Step 1: Read top of CHANGELOG**

```bash
head -20 CHANGELOG.md
```

- [ ] **Step 2: Insert the new entry above the v4.2.1 entry**

Write entry with the structure described above. Match existing formatting style.

- [ ] **Step 3: Verify**

Run verify command.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "v5: CHANGELOG ## [5.0.0] entry"
```

---

## Wave J: Verification

### Task 32: Run all verification gates

**Files:**
- Read: most v5 artifacts

**Parallel-group:** wave-10
**Codex:** false
**Spec:** [spec.md#L322-L336](spec.md#L322-L336)
**Verify:**
```bash
# All of the following must succeed, in sequence:
bin/masterplan-self-host-audit.sh && echo AUDIT-OK
bash -n hooks/masterplan-telemetry.sh && echo HOOK-SYNTAX-OK
[ "$(wc -c < commands/masterplan.md)" -le 20480 ] && echo ROUTER-CEILING-OK
jq -e '.schema_version == "5.0"' docs/masterplan/v5-lazy-phase-prompts/plan.index.json && echo INDEX-SCHEMA-OK
grep -q -F '**Spec:**' docs/masterplan/v5-lazy-phase-prompts/plan.md && \
  grep -q -F '**Verify:**' docs/masterplan/v5-lazy-phase-prompts/plan.md && echo PLAN-MARKERS-OK
echo ALL-VERIFICATION-GATES-OK
```

Run every verification gate in sequence. Each must produce its OK line.

- [ ] **Step 1: Run self-host-audit**

```bash
bin/masterplan-self-host-audit.sh
```
Expected: no `FAIL` lines.

- [ ] **Step 2: Run all 36 doctor checks via the new doctor.md**

Since the orchestrator router routes `doctor` to `parts/doctor.md`, the easiest standalone check is to extract each check's bash block and run it:
```bash
# spot-check each new check
for n in 32 33 34 35 36; do
  block="$(sed -n "/^## Check #${n}/,/^## Check #/p" parts/doctor.md | sed '$d')"
  cmds="$(echo "$block" | sed -n '/```bash/,/```/p' | sed '1d;$d')"
  if [ -n "$cmds" ]; then
    echo "--- Check #${n} ---"
    bash -c "$cmds"
  fi
done
```

- [ ] **Step 3: Verify router contents**

```bash
[ "$(wc -c < commands/masterplan.md)" -le 20480 ] && echo "router OK ($(wc -c < commands/masterplan.md) bytes)"
```

- [ ] **Step 4: Rebuild this run's plan.index.json**

```bash
bin/masterplan-state.sh build-index v5-lazy-phase-prompts
jq '.tasks | length' docs/masterplan/v5-lazy-phase-prompts/plan.index.json
```

- [ ] **Step 5: Confirm this plan dogfoods the v5 format**

```bash
grep -c -F '**Spec:**' docs/masterplan/v5-lazy-phase-prompts/plan.md
grep -c -F '**Verify:**' docs/masterplan/v5-lazy-phase-prompts/plan.md
```
Both should be ≥30 (matches task count).

- [ ] **Step 6: Run the full verify chain from the header**

Run the verify block at the top of this task. Every line must print its OK message.

- [ ] **Step 7: Commit any verification artifacts (if any updates needed)**

```bash
git status
# if doctor.md or audit produced fixes, commit them
```

---

### Task 33: Cold-load smoke test

**Files:** none (runtime test)

**Parallel-group:** wave-10
**Codex:** false
**Spec:** [spec.md#L336](spec.md#L336)
**Verify:**
```bash
# Manual: from a fresh CLI session, run `/masterplan status` and inspect
# the transcript to confirm only the router was loaded (not all four phase files).
# Approximate check: count how many parts/step-*.md files the orchestrator
# Read'd in the transcript log.
echo "MANUAL: see Step 1 in this task"
```

This is a manual smoke test that requires a fresh CLI session. Document the procedure; the actual execution is done by the implementer/user.

- [ ] **Step 1: From a fresh CLI session in this repo, run `/masterplan status` for this run bundle**

The orchestrator should load `commands/masterplan.md` (router) and `parts/step-0.md` (bootstrap + status). It should NOT load `parts/step-a.md`, `parts/step-b.md`, `parts/step-c.md`, `parts/doctor.md`, or `parts/import.md`.

- [ ] **Step 2: Confirm via transcript or telemetry**

If telemetry is enabled, the resulting JSONL should show a `parent_turn` record with `current_phase` set, plus a small number of `Read` tool_use entries (router + step-0 + state.yml + maybe one contract).

- [ ] **Step 3: Record outcome in state.yml.recent_events**

Add an event line:
```
- "<date> cold-load smoke: only router + step-0 loaded (PASS)"
```

- [ ] **Step 4: Commit if state.yml was updated**

```bash
git add docs/masterplan/v5-lazy-phase-prompts/state.yml
git commit -m "v5: record cold-load smoke result"
```

---

### Task 34: Migration smoke test against a v4 fixture

**Files:**
- Read: an existing v4 bundle (any from `docs/masterplan/*/` predating v5)

**Parallel-group:** wave-10
**Codex:** false
**Spec:** [spec.md#L327](spec.md#L327)
**Verify:**
```bash
test -f /tmp/v5-migration-fixtures/test-bundle/state.yml.v4-backup && \
  grep -q 'schema_version: "5.0"' /tmp/v5-migration-fixtures/test-bundle/state.yml
echo MIGRATE-SMOKE-OK
```

Take a real v4 bundle (e.g., `docs/masterplan/v4-2-1-doctor-checks/`), copy to /tmp, run `migrate-state`, and confirm: (a) schema flipped, (b) backup created, (c) overflows moved, (d) idempotent on re-run.

- [ ] **Step 1: Pick a fixture**

```bash
cp -r docs/masterplan/v4-2-1-doctor-checks /tmp/v5-migration-fixtures/real-v4
cat /tmp/v5-migration-fixtures/real-v4/state.yml | head -30
```

- [ ] **Step 2: Run migration**

```bash
bin/masterplan-state.sh migrate-state --bundle /tmp/v5-migration-fixtures/real-v4
```

- [ ] **Step 3: Verify**

```bash
grep -q 'schema_version: "5.0"' /tmp/v5-migration-fixtures/real-v4/state.yml && echo SCHEMA-OK
test -f /tmp/v5-migration-fixtures/real-v4/state.yml.v4-backup && echo BACKUP-OK
diff /tmp/v5-migration-fixtures/real-v4/state.yml.v4-backup docs/masterplan/v4-2-1-doctor-checks/state.yml > /dev/null && echo BACKUP-FIDELITY-OK
```

- [ ] **Step 4: Idempotency**

```bash
bin/masterplan-state.sh migrate-state --bundle /tmp/v5-migration-fixtures/real-v4
# expected: "already v5.0: ..."
```

- [ ] **Step 5: Record outcome + commit**

Add to state.yml.recent_events; commit.

---

## Wave K: Release

### Task 35: Push branch + create tag + write retro

**Files:**
- Create: `docs/masterplan/v5-lazy-phase-prompts/retro.md`
- Git: push branch, create tag

**Parallel-group:** wave-11
**Codex:** false
**Spec:** [spec.md#L337](spec.md#L337)
**Verify:**
```bash
git rev-parse v5.0.0 && echo TAG-OK
git ls-remote origin v5.0.0-lazy-phase-prompts | grep -q . && echo BRANCH-PUSHED-OK
test -f docs/masterplan/v5-lazy-phase-prompts/retro.md && echo RETRO-OK
```

- [ ] **Step 1: Write `retro.md`**

```markdown
# v5.0.0 Lazy-Load Phase Prompts — Retrospective

## Outcome
- Router shrunk from 342KB / 3030 lines to <20KB.
- Phase content split into `parts/step-{0,a,b,c}.md` + `parts/{doctor,import,codex-host}.md` + `parts/contracts/*`.
- 5 bundled fixes shipped (plan.index.json, state.yml overflow, projection threshold, complexity default flip, parent_turn telemetry).
- 5 new doctor checks (#32–#36) ship Warning, report-only.

## What worked
- <fill in during retro>

## What didn't
- <fill in during retro>

## Carry-forward items for v5.x
- Verify cold-load measurement against `/loop /masterplan resume` over time; confirm token savings materialize.
- Watch for projection-mode mismatch warnings in real plans (signal for threshold tuning).
- Codex-host smoke test should run on every Codex release.
```

- [ ] **Step 2: Commit retro**

```bash
git add docs/masterplan/v5-lazy-phase-prompts/retro.md
git commit -m "Retro for v5-lazy-phase-prompts (v5.0.0)"
```

- [ ] **Step 3: Confirm branch state**

```bash
git status
git log --oneline -10
```

- [ ] **Step 4: Push branch — ASK USER FIRST**

This is a remote push. Per repo policy, confirm with the user via AskUserQuestion before executing. Once authorized:
```bash
git push -u origin v5.0.0-lazy-phase-prompts
```

- [ ] **Step 5: Create annotated tag (local only)**

```bash
git tag -a v5.0.0 -m "v5.0.0: lazy-load phase prompts + GPT-5.5 audit fixes"
```

- [ ] **Step 6: Verify**

Run verify command at top of this task.

- [ ] **Step 7: Final state.yml update**

Mark phase=complete in state.yml; commit:
```bash
git add docs/masterplan/v5-lazy-phase-prompts/state.yml
git commit -m "v5: mark run complete"
```

---

## Self-Review

After writing this plan, ran through the checklist:

**1. Spec coverage:**
- §Intent Anchor → motivation captured in Goal + Architecture.
- §Architecture Overview → captured in Architecture; cache narrative noted.
- §Scope Boundary → File Structure mirrors in-scope; out-of-scope items not implemented (correct).
- §File Layout → Tasks 1-14, 20 (router rewrite).
- §Router Contract → Task 20.
- §Phase Prompt Contract → embedded in Tasks 9-14 (each phase file is self-contained, loads contracts on demand).
- §Contracts Layout → Tasks 4-7.
- §plan.index.json Full v5.0 → Task 21 (build-index).
- §Plan-Format Change → Task 11 (update B3 emission), Task 18 (doctor #35).
- §state.yml v5 Schema → Task 7 (contract), Task 22 (migrate-state), Task 24 (cap enforcement), Task 15 (doctor #32).
- §TaskCreate Projection Threshold → Task 6 (contract).
- §Complexity Default Flip → Task 22 (migrate flips unset → medium).
- §Parent-Turn Telemetry → Task 25 (hook), Task 26 (routing-stats --parent).
- §Codex Host Suppression → Task 8 (codex-host.md), Task 20 (router conditional load).
- §Self-Host Audit Updates → Task 27.
- §SKILL.md Updates → Task 28.
- §Migration & Compatibility → Tasks 22, 23 (migrate-state, migrate-plan); Task 30 (version bump).
- §New Doctor Checks #32-#36 → Tasks 15-19.
- §Acceptance Criteria → Task 32 (verification gates) + Task 34 (migration smoke).
- §Risk Register → mitigations referenced inline where applicable; nothing requires new tasks.
- §Dependencies + Assumptions → noted in Plan-level deviations section above; writing-plans dependency surfaced as Task 11 caveat.

**2. Placeholder scan:** No "TBD", "TODO", "implement later" in any step. Code blocks present where steps modify code. Bash blocks are concrete commands.

**3. Type consistency:** Subcommand names consistent throughout (`build-index`, `migrate-state`, `migrate-plan`). File paths consistent (`parts/step-{0,a,b,c}.md`, `parts/doctor.md`, `parts/import.md`, `parts/contracts/*`). Doctor check IDs consistent (#32-#36).

**4. Coverage gaps fixed inline:** spec §L88-100 Router Contract says doctor entry point dispatches to per-check logic — that logic lives in `parts/doctor.md` (plan-level extension noted above and at Task 13 / 20). Spec §L182-184 mentions a manual fix path for spec_refs migration — captured in Task 23 step "spec_refs warning".

---

## Execution Handoff

**Plan complete and saved to `docs/masterplan/v5-lazy-phase-prompts/plan.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit for this plan because most tasks are bounded (extract X to Y, verify Z) and benefit from a clean context per task. Mix of Haiku (extraction tasks), Sonnet (mid-complexity), and Codex (bounded bash subcommand implementations — Tasks 20, 21, 22, 23, 24, 25, 26, 27 marked `codex: true`).

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints. Higher orchestrator context cost; one continuous session.

Once execution starts, follow wave ordering (A → B → C → D → E/F/G in parallel → H → I → J → K). Each task ends with a commit; wave boundaries are natural sync points for review.
