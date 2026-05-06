# 3-Level Complexity Variable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `complexity: low|medium|high` meta-knob to /masterplan that scales plan-writing artifacts, status persistence, execution rigor, and doctor checks together, with `medium` preserving current behavior (backward compatible).

**Architecture:** Defaults-only meta-knob with explicit-override precedence (CLI flag > status frontmatter > config > complexity-derived default > built-in default `medium`). Resolved once in Step 0 and re-resolved on every Step C entry. complexity affects what the orchestrator emits (sidecar gates, log density, plan-writing brief, doctor check-set, retro requirement), not the brainstorm flow. All edits are markdown surgery to `commands/masterplan.md` plus a CHANGELOG entry; no code, no tests in the conventional sense.

**Tech Stack:** Markdown (orchestrator prompt), YAML (config + frontmatter), bash (telemetry hook syntax check), grep (verification), git (commits per task).

---

## Reference

- **Spec:** `docs/superpowers/specs/2026-05-05-complexity-levels-design.md` (committed at `4b21318`).
- **Behavior matrix:** spec §Design / Behavior matrix is the contract; every task here cites which row(s) it implements.
- **Section labels in `commands/masterplan.md`:** "Step 0", "Step B0/B1/B2/B3", "Step C step N", "Step D", "Step M", "Status file format", "Configuration: .masterplan.yaml", "Operational rules". Tasks reference these by name.

---

### Task 1: Declarations — config schema, flag table, frontmatter field list, status template

Add the four `complexity`-aware declaration spots so subsequent tasks can reference them. All four edits are small (1–4 lines each) and live in different sections of the same file; they're grouped here because they are pure declarations with no behavior change yet.

**Files:**
- Modify: `commands/masterplan.md` — section `## Configuration: .masterplan.yaml` (schema block)
- Modify: `commands/masterplan.md` — section `### Recognized flags` (flag table in Step 0)
- Modify: `commands/masterplan.md` — section `### Step B3 — Status file + approval` (frontmatter required-fields bullet list)
- Modify: `commands/masterplan.md` — section `## Status file format` (frontmatter template block)

**Codex:** ok

- [ ] **Step 1: Add `complexity` to the YAML schema block**

In the `## Configuration: .masterplan.yaml` section's schema block (the `# Default execution autonomy` area), insert immediately after the `autonomy: gated` line:

```yaml
# 3-level complexity meta-knob (low|medium|high). Sets defaults for several
# other knobs; explicit settings (CLI flag, frontmatter, config) win over
# complexity-derived defaults. medium = current behavior (back-compat).
# See Step 0's "Complexity resolution" subsection for precedence and
# Operational rules' "Complexity precedence" entry for the per-knob defaults.
complexity: medium  # low | medium | high
```

- [ ] **Step 2: Add `--complexity=<level>` to the recognized-flags table**

In the `### Recognized flags` table within Step 0, insert a new row after the `--codex-review` row and before `--parallelism`:

```markdown
| `--complexity=low\|medium\|high` | 0/B/C | Override `config.complexity` for this run. Persisted to status frontmatter at Step B3 (kickoff) or written to frontmatter at Step C step 1 (resume override, with a `## Notes` audit entry). |
```

- [ ] **Step 3: Add `complexity` to the Step B3 frontmatter required-fields bullet list**

In `### Step B3 — Status file + approval`, the bullet list of frontmatter fields, insert after the `compact_loop_recommended: false` bullet:

```markdown
- `complexity` — value of `--complexity=` flag, status frontmatter (resume), config tier, or built-in default `medium`. Set once at Step B3; updated on resume only when `--complexity=<new>` is passed (with `## Notes` audit entry).
```

- [ ] **Step 4: Add `complexity:` to the Status file format frontmatter template**

In the `## Status file format` section's example frontmatter block, insert after the `compact_loop_recommended: true | false` line:

```yaml
complexity: low | medium | high
```

- [ ] **Step 5: Verify all four declarations landed**

Run:
```bash
grep -nE "^complexity:|--complexity=|^- \`complexity\`" commands/masterplan.md
```
Expected: 4 matches — one in the YAML schema (`complexity: medium`), one in the flag table (`--complexity=low|medium|high`), one in the Step B3 frontmatter list (the bullet), one in the Status file format example block (`complexity: low | medium | high`).

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: declare config key, flag, frontmatter field"
```

---

### Task 2: Step 0 — complexity resolver + activity log source line

Add a "Complexity resolution" subsection inside Step 0 that resolves the active complexity once per invocation and stashes `resolved_complexity` and `complexity_source` on the orchestrator's per-invocation state. Document the activity log audit line format (written later by Step C step 1's first entry).

**Files:**
- Modify: `commands/masterplan.md` — Step 0, immediately after the existing "Git state cache (per invocation)" subsection

**Codex:** ok

- [ ] **Step 1: Insert the "Complexity resolution" subsection**

In Step 0, after the "Git state cache (per invocation)" subsection ends and before the "Verb routing" subsection begins, insert:

```markdown
### Complexity resolution (per invocation)

After config + flag merge completes, resolve the active `complexity` once and stash it on per-invocation state. Precedence (highest first):

1. `--complexity=<level>` CLI flag (when present in this turn's args).
2. Status frontmatter `complexity:` field (Step C resume only — empty during kickoff).
3. Repo-local `<repo-root>/.masterplan.yaml`'s `complexity:`.
4. User-global `~/.masterplan.yaml`'s `complexity:`.
5. Built-in default: `medium`.

Stash:
- `resolved_complexity` — one of `low`, `medium`, `high`.
- `complexity_source` — one of `flag`, `frontmatter`, `repo_config`, `user_config`, `default`.

These two values are read by every downstream step that varies behavior on complexity. The activity-log audit line written at Step C step 1's first entry uses both values, e.g.:

```
- 2026-05-05T19:32 complexity=low (source: repo_config); codex_review=on (source: cli_flag, overrides complexity-derived default)
```

This single line is the audit trail for "why did the orchestrator behave this way." Step C step 1 emits it once on kickoff entry and once per cross-session resume.
```

- [ ] **Step 2: Verify the new subsection renders correctly**

```bash
grep -n "Complexity resolution (per invocation)\|resolved_complexity\|complexity_source" commands/masterplan.md
```
Expected: at least 4 matches — the heading, plus references to `resolved_complexity` and `complexity_source` in body text, plus the example activity-log line.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step 0 complexity resolver + audit-line format"
```

---

### Task 3: Operational rules — complexity → defaults table + override precedence

Document the per-knob defaults table that complexity derives in a single canonical place (Operational rules). Subsequent tasks reference this table rather than re-stating the defaults. Also add the explicit override precedence rule.

**Files:**
- Modify: `commands/masterplan.md` — section `## Operational rules`, append a new bullet block

**Codex:** ok

- [ ] **Step 1: Append the Complexity precedence rule to Operational rules**

At the end of the `## Operational rules` section (after the existing CC-2 rule and before the future-design pointer), insert:

```markdown
- **Complexity precedence (per-knob defaults table).** When `resolved_complexity != null`, the following knobs receive complexity-derived defaults. Explicit overrides at any tier above the complexity-derived default win (resolution order per knob: explicit CLI flag > status frontmatter > repo config > user config > **complexity-derived default** > built-in default).

  | Knob | low | medium (default) | high |
  |---|---|---|---|
  | `autonomy` | `loose` | `gated` | `gated` |
  | `codex_routing` | `off` | `auto` | `auto` |
  | `codex_review` | `off` | `on` | `on` (also sets `review_prompt_at: low`) |
  | `parallelism.enabled` | `off` | `on` | `on` |
  | `gated_switch_offer_at_tasks` | `999` (effectively suppressed) | `15` | `25` |
  | `review_max_fix_iterations` | `0` | `2` | `4` |

  When the activity log audit line at Step C step 1's first entry is emitted, every knob whose final value differs from the complexity-derived default cites its source (e.g., `codex_review=on (source: cli_flag, overrides complexity-derived default)`). This is the "why did the orchestrator behave this way" forensic trail. Knobs whose final value matches the complexity-derived default are NOT cited individually — that would bloat the line. Cite only divergences from the table above.
```

- [ ] **Step 2: Verify the rule landed**

```bash
grep -nE "^- \*\*Complexity precedence\b|complexity-derived default" commands/masterplan.md
```
Expected: at least 3 matches — the bullet heading, plus references to "complexity-derived default" in the table caption and the audit-line example.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Operational rules — complexity precedence table"
```

---

### Task 4: Step B3 — kickoff prompt for complexity (when not set via flag/config)

Add the kickoff prompt that fires once between Step B0's worktree decision and Step B1's brainstorm, when `--complexity` is not on the CLI and no config tier sets it. Picked value is persisted into status frontmatter at Step B3.

**Files:**
- Modify: `commands/masterplan.md` — section `### Step B3 — Status file + approval`, near the top before the frontmatter required-fields bullet list

**Codex:** ok

- [ ] **Step 1: Insert the "Complexity kickoff prompt" subsection inside Step B3**

In `### Step B3 — Status file + approval`, insert at the very top of the section (before "Create the sibling status file at..."):

```markdown
**Complexity kickoff prompt.** Fires once at kickoff (`/masterplan full <topic>`, `/masterplan plan <topic>`, `/masterplan brainstorm <topic>`) when:
- `--complexity` is NOT on this turn's CLI args, AND
- `complexity_source == default` (i.e., no config tier set it; built-in `medium` would be silently used).

Surface ONE `AskUserQuestion` after Step B0's worktree decision and BEFORE Step B1's brainstorm:

```
AskUserQuestion(
  question="What complexity for this project? Affects plan size, execution rigor, and doctor checks. Brainstorm runs full regardless.",
  options=[
    "medium — standard /masterplan flow (Recommended; current behavior)",
    "low — small project, light treatment (skip codex review, simpler activity log, ~3-7 tasks, no eligibility cache)",
    "high — high-stakes; codex review on every task, decision-source cited, retro required at completion",
    "use config default — read from .masterplan.yaml; warn if not set, fall through to medium"
  ]
)
```

On the user's pick:
- `medium` / `low` / `high` → flip in-session `resolved_complexity` to the chosen value; set `complexity_source = "flag"` (treated as user-explicit at this turn). Persist to status frontmatter's `complexity:` field.
- `use config default` → no change to `resolved_complexity`; emit one-line warning if it would fall through to built-in default (`medium` — no config set complexity).

If `--complexity` IS on the CLI, OR any config tier sets `complexity:`, this prompt is silenced (no AskUserQuestion fires). The Step B3 close-out gate at the end of B3 still fires as today.
```

- [ ] **Step 2: Verify the prompt landed**

```bash
grep -n "Complexity kickoff prompt\|What complexity for this project" commands/masterplan.md
```
Expected: 2 matches — the subsection heading and the AskUserQuestion question text.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step B3 — kickoff prompt for unset complexity"
```

---

### Task 5: Step C step 1 — resume-time complexity resolution + ## Notes audit on change

Add a "Complexity resolution on resume" subsection inside Step C step 1 that re-resolves complexity from the status frontmatter (with optional CLI override), updates frontmatter on change, and writes a `## Notes` audit entry when the value flips. Also emits the activity-log audit line described in Task 2.

**Files:**
- Modify: `commands/masterplan.md` — Step C step 1, after the existing "Wakeup-ledger `fired:` write" subsection and before "Verify the worktree"

**Codex:** ok

- [ ] **Step 1: Insert the "Complexity resolution on resume" subsection**

In Step C step 1, between the `**Wakeup-ledger \`fired:\` write.**` subsection and the `**Verify the worktree.**` subsection, insert:

```markdown
   - **Complexity resolution on resume.** Re-run the Step 0 complexity-resolution rules using the just-loaded status frontmatter as the new tier-2 input.
     - If the resumed status file lacks a `complexity:` field (pre-feature plan), treat as `medium` and DO NOT write the field unless the user explicitly passes `--complexity=<level>` on this turn.
     - If `--complexity=<new>` is on the CLI AND `<new>` differs from the frontmatter value: update frontmatter `complexity:` to `<new>`, append `## Notes` entry: *"Complexity changed from `<old>` to `<new>` at `<ISO ts>` via CLI override."*. The new value is used for this run AND persisted.
     - On every Step C entry (kickoff first entry OR resume), emit ONE activity-log audit line per the format in Step 0's Complexity resolution subsection. Cite the resolved knob values that diverge from the complexity-derived defaults table (per Operational rules' Complexity precedence).
```

- [ ] **Step 2: Verify the subsection landed**

```bash
grep -n "Complexity resolution on resume\|Complexity changed from" commands/masterplan.md
```
Expected: 2 matches — the subsection heading and the `## Notes` audit-entry template.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step C step 1 — resume-time complexity resolution"
```

---

### Task 6: Step C step 1 — eligibility cache gate at low

Wrap Step C step 1's "Build eligibility cache" decision tree in a complexity gate. At low: skip entirely (the cache file is not built). At medium/high: current behavior.

**Files:**
- Modify: `commands/masterplan.md` — Step C step 1, the `**Build eligibility cache.**` subsection

**Codex:** ok

- [ ] **Step 1: Insert the complexity gate at the top of the Build eligibility cache subsection**

Find the line `**Build eligibility cache.** When \`codex_routing\` is \`auto\` or \`manual\`, the cache lives at \`<slug>-eligibility-cache.json\`...` in Step C step 1. Insert a new paragraph IMMEDIATELY before that line:

```markdown
   **Complexity gate (eligibility cache).** When `resolved_complexity == low`, skip the entire eligibility-cache decision tree below — the cache file is NOT built and is NOT loaded. Step 3a's per-task lookup falls back to: `codex_routing` resolves to its complexity-derived default `off` at low (per Operational rules' Complexity precedence), so no delegation decision is needed per task. Doctor check #14 (orphan eligibility cache) does not flag absence on low plans (handled by Task 12's check-set gate).
```

- [ ] **Step 2: Verify the gate landed**

```bash
grep -n "Complexity gate (eligibility cache)" commands/masterplan.md
```
Expected: 1 match — the subsection heading.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step C step 1 — eligibility cache gate at low"
```

---

### Task 7: Step C step 1 — telemetry sidecar gate at low

Wrap Step C step 1's "Telemetry inline snapshot" subsection in a complexity gate. At low: skip entirely (no JSONL append). At medium/high: current behavior.

**Files:**
- Modify: `commands/masterplan.md` — Step C step 1, the `**Telemetry inline snapshot.**` subsection

**Codex:** ok

- [ ] **Step 1: Insert the complexity gate at the top of the Telemetry inline snapshot subsection**

Find the line `**Telemetry inline snapshot.** If \`config.telemetry.enabled\` and the status file's frontmatter does NOT include \`telemetry: off\`...` in Step C step 1. Replace the leading clause to add a complexity gate as a third skip condition:

OLD:
```markdown
   **Telemetry inline snapshot.** If `config.telemetry.enabled` and the status file's frontmatter does NOT include `telemetry: off`, append one JSONL record (kind=`step_c_entry`) to `<plan-without-suffix>-telemetry.jsonl` (sibling to status file). Fields per the format defined in `docs/design/telemetry-signals.md`. Cheap (one append). Provides cross-session datapoints for installs without the Stop hook.
```

NEW:
```markdown
   **Telemetry inline snapshot.** If `resolved_complexity == low`, skip telemetry entirely (no JSONL append regardless of `config.telemetry.enabled` or frontmatter `telemetry:` setting; doctor #13 (orphan telemetry) does not flag absence on low plans, handled by Task 12's check-set gate). Otherwise: if `config.telemetry.enabled` and the status file's frontmatter does NOT include `telemetry: off`, append one JSONL record (kind=`step_c_entry`) to `<plan-without-suffix>-telemetry.jsonl` (sibling to status file). Fields per the format defined in `docs/design/telemetry-signals.md`. Cheap (one append). Provides cross-session datapoints for installs without the Stop hook.
```

- [ ] **Step 2: Verify the gate landed**

```bash
grep -n "skip telemetry entirely (no JSONL append" commands/masterplan.md
```
Expected: 1 match — the new gate clause.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step C step 1 — telemetry sidecar gate at low"
```

---

### Task 8: Step C step 4d — activity log density + rotation threshold by complexity

Modify Step C step 4d's "Status file update" subsection so the activity log entry density and rotation threshold depend on `resolved_complexity`.

**Files:**
- Modify: `commands/masterplan.md` — Step C step 4d, both the `**Status file update.**` and the `**Activity log rotation.**` paragraphs

**Codex:** ok

- [ ] **Step 1: Insert a complexity-aware density rule before the Status file update paragraph**

In Step C step 4d, immediately before the `**4d — Status file update.**` paragraph, insert:

```markdown
   **Complexity gate (activity log density + rotation).**
   - At `resolved_complexity == low`: each task-completion activity-log entry is ONE line: `<ISO-ts> <task-name> <pass|fail>`. No `[routing→...]`, `[review→...]`, or `[verification: ...]` tags. No `decision_source:` cite. The pre-dispatch `routing→` and `review→` entries from Step 3a/4b are SKIPPED entirely at low (codex is off; nothing to log).
   - At `resolved_complexity == medium`: current entry shape (full tags as already documented below).
   - At `resolved_complexity == high`: current entry shape PLUS an explicit `decision_source: <annotation|heuristic|cache>` cite when the task was Codex-eligible.

   **Rotation threshold:**
   - low: rotate when `## Activity log` exceeds 50 entries; archive all but the most recent 25.
   - medium / high: rotate when log exceeds 100 entries; archive all but the most recent 50 (current behavior, unchanged).
```

- [ ] **Step 2: Verify the density rule landed**

```bash
grep -nE "Complexity gate \(activity log density|low: rotate when" commands/masterplan.md
```
Expected: 2 matches — the gate heading and the low rotation rule.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step C step 4d — log density + rotation by complexity"
```

---

### Task 9: Step C step 5 — wakeup-ledger gate at low

Modify Step C step 5 to skip the `## Wakeup ledger` `armed:` line write when `resolved_complexity == low`. At low, `loop_enabled` defaults to `false` (no wakeup is scheduled in the first place); but if a user explicitly enabled the loop at low (via `--loop` or frontmatter override), the wakeup IS scheduled but the ledger entry is NOT written.

**Files:**
- Modify: `commands/masterplan.md` — Step C step 5, the `Otherwise, after every 3 completed tasks (...)` block where `armed:` is currently appended

**Codex:** ok

- [ ] **Step 1: Insert the complexity gate at the top of Step C step 5**

In Step C step 5 (`5. **Cross-session loop scheduling**...`), insert as the very FIRST bullet under the parent line (before "**Competing-scheduler suppression.**"):

```markdown
   - **Complexity gate.** If `resolved_complexity == low`, the `## Wakeup ledger` section is NOT maintained (per Operational rules' Complexity precedence: `loop_enabled` defaults to `false` at low, so no `ScheduleWakeup` is even called; however, if the user explicitly enabled the loop via override, `ScheduleWakeup` runs but the `armed:` line write below is SKIPPED). Doctor checks #19 + #20 do not fire on low plans (handled by Task 12's check-set gate).
```

- [ ] **Step 2: Verify the gate landed**

```bash
grep -n "Complexity gate.*Wakeup ledger\|## Wakeup ledger\` section is NOT maintained" commands/masterplan.md
```
Expected: 1 match — the new gate bullet.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step C step 5 — wakeup-ledger gate at low"
```

---

### Task 10: Step B2 — writing-plans brief parameterization by complexity

Modify Step B2's writing-plans brief so the annotation requirements (`**Files:**`, `**Codex:**`, `**parallel-group:**`) and the target task count vary by `resolved_complexity`.

**Files:**
- Modify: `commands/masterplan.md` — Step B2, the existing "Brief plan-writing with **CD-1 + CD-6**, plus:" block

**Codex:** ok

- [ ] **Step 1: Insert a complexity-aware briefing clause into Step B2**

In `### Step B2 — Plan`, find the paragraph that starts with "Brief plan-writing with **CD-1 + CD-6**, plus:". Insert IMMEDIATELY AFTER that paragraph's existing bullet list (after the "Skip your Execution Handoff prompt" bullet), this new clause:

```markdown
> **Complexity-aware brief.** The orchestrator passes `resolved_complexity` (one of `low`, `medium`, `high`) into the writing-plans brief. Adjust the brief shape accordingly:
>
> - `complexity == low` — brief writing-plans to: produce a flat task list of ~3–7 tasks; SKIP the `**Codex:**` annotation prelude; SKIP the `**parallel-group:**` annotation guidance; mark `**Files:**` blocks as OPTIONAL (best-effort, not required). Plan output is leaner.
> - `complexity == medium` — current brief (above bullets are the canonical defaults; `**Files:**` encouraged, `**Codex:**` annotation optional, `**parallel-group:**` optional). No change.
> - `complexity == high` — brief writing-plans to: REQUIRE `**Files:**` block per task (exhaustive); REQUIRE `**Codex:**` annotation per task (`ok` or `no`); ENCOURAGE `**parallel-group:**` for verification/lint/inference clusters. Eligibility cache will be validated against `**Files:**` declarations at Step C step 1 (per spec §Behavior matrix / Plan-writing / `eligibility cache` row at high).
```

- [ ] **Step 2: Verify the clause landed**

```bash
grep -nE "Complexity-aware brief\.|complexity == low — brief writing-plans" commands/masterplan.md
```
Expected: 2 matches — the heading and the low-level brief clause.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step B2 — writing-plans brief parameterization"
```

---

### Task 11: Step C step 6 — retro requirement at high

Modify Step C step 6's `AskUserQuestion` (the post-completion finishing-branch options) so that under `resolved_complexity == high`, a "Generate retro now" option is prepended as the first/recommended choice. After the finishing-a-development-branch flow completes, the orchestrator routes to Step R0 with the just-completed slug.

**Files:**
- Modify: `commands/masterplan.md` — Step C step 6, the `AskUserQuestion(question="Plan complete..."` block

**Codex:** ok

- [ ] **Step 1: Insert the complexity-aware option list above the existing AskUserQuestion**

In Step C step 6, immediately BEFORE the existing `AskUserQuestion(question="Plan complete. How should I finish the branch?"...` block, insert:

```markdown
   **Complexity gate (retro at high).** When `resolved_complexity == high`, the AskUserQuestion below has a fifth option PREPENDED as the first/recommended choice:
   - `"Generate retro now (Recommended) — invoke Step R0 with this slug, then finish the branch per the next picked option"`

   Picking that option routes through Step R0 → R1 → R2 → R3 → R4 (the standard retro flow) FIRST, then re-surfaces the original 4-option AskUserQuestion (Merge / Push+PR / Keep / Discard) so the user can still pick a finish path. The retro file path is added to the activity log entry.

   Under `resolved_complexity != high`, the retro option is NOT prepended; the existing 4-option AskUserQuestion fires as today (option count remains 4 per CD-9).
```

- [ ] **Step 2: Verify the gate landed**

```bash
grep -nE "Complexity gate \(retro at high\)|Generate retro now \(Recommended\) — invoke Step R0" commands/masterplan.md
```
Expected: 2 matches — the heading and the prepended option.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step C step 6 — retro requirement at high"
```

---

### Task 12: Step D — complexity-aware doctor check-set gate

Modify Step D's "Scope" subsection so the active check set depends on `resolved_complexity` at lint time (read from each plan's status frontmatter).

**Files:**
- Modify: `commands/masterplan.md` — Step D, the `### Scope` subsection (top of Step D)

**Codex:** ok

- [ ] **Step 1: Insert the complexity-aware check-set rule into Step D's Scope**

In `## Step D — Doctor` → `### Scope`, immediately after the existing scope paragraph and before the `### Checks` subsection, insert:

```markdown
**Complexity-aware check set.** For each scanned plan, read `complexity` from its status frontmatter (default `medium` if absent — pre-feature plans). The active check set varies:

- `low` plans: run only checks #1 (orphan plan), #2 (orphan status), #3 (wrong worktree), #4 (wrong branch), #5 (stale in-progress), #6 (stale blocked), #8 (missing spec), #9 (schema, against the standard 15-field set), #10 (unparseable), #18 (codex misconfig). SKIP #11 (orphan archive), #12 (telemetry growth), #13 (orphan telemetry), #14 (orphan eligibility cache), #15–#17 (parallel-group annotations), #19 (duplicate crons), #20 (wakeup-ledger inconsistency), #22 (high-only — see below). These all target sidecars / annotations / ledger entries that low does not produce.
- `medium` plans: run all 21 current checks (no change from today).
- `high` plans: run all 21 current checks PLUS new check #22 (added by Task 13).
- Plans without a `complexity:` frontmatter field: treat as `medium`.

The check-set gate is per-plan: a single `/masterplan doctor` run against worktrees containing a mix of low/medium/high plans honors each plan's complexity individually. Findings are reported with the same severity as today.
```

- [ ] **Step 2: Verify the rule landed**

```bash
grep -nE "Complexity-aware check set\.|low.*plans:.*run only checks #1" commands/masterplan.md
```
Expected: 2 matches — the heading and the low check-set list.

- [ ] **Step 3: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step D — complexity-aware check-set gate"
```

---

### Task 13: Step D — new doctor check #22 (high-only rigor evidence)

Append a new row #22 to Step D's checks table that fires only on `complexity: high` plans missing rigor evidence.

**Files:**
- Modify: `commands/masterplan.md` — Step D, the `### Checks` table

**Codex:** ok

- [ ] **Step 1: Append row #22 to the doctor checks table**

In `### Checks` under Step D, find the existing row `| 21 | **Wakeup-ledger inconsistency.** ...`. Immediately AFTER that row (still inside the table — no blank line), add:

```markdown
| 22 | **High-complexity plan missing rigor evidence.** Fires when status frontmatter has `complexity: high` AND the plan's status file lacks ALL THREE of: (a) a `## Notes` entry referencing a retro file, (b) at least one `Codex review:` reference in the activity log indicating a review pass, (c) `[reviewed: ...]` tags in ≥ 50% of activity-log task-completion entries. Severity: Warning. Rationale: high complexity is opt-in to rigor; if the rigor signals are completely absent on a completed/in-progress high plan, either the plan should be re-classified as medium or the missing rigor steps should be added (the plan executes today but the auditor should know). Skipped on `complexity: low` and `complexity: medium` plans by Task 12's check-set gate. | Warning | No auto-fix. Suggest re-running the most recent task with `--complexity=medium` if the user has decided high is overkill, OR running `/masterplan retro` to generate the retro reference. |
```

- [ ] **Step 2: Verify check #22 landed in the table**

```bash
grep -nE "^\| 22 \| \*\*High-complexity plan missing rigor evidence" commands/masterplan.md
```
Expected: 1 match — the new row.

- [ ] **Step 3: Update the doctor-check count anywhere the orchestrator cites "21 checks"**

```bash
grep -n "21 checks\|all 21\|Total checks: 21" commands/masterplan.md
```
For each match (expect 2–3), update to `22 checks` / `all 22` / `Total checks: 22` as appropriate. Then re-grep:

```bash
grep -nE "21 checks|all 21|Total checks: 21" commands/masterplan.md && echo "STALE — fix above" || echo "no stale 21-count references"
```
Expected: "no stale 21-count references" after the updates.

- [ ] **Step 4: Commit**

```bash
git add commands/masterplan.md
git commit -m "complexity-levels: Step D — new check #22 (high-only rigor evidence)"
```

---

### Task 14: Verification pass — grep discriminators across all touched sections

Single read-only sweep that confirms every prior task's edit landed and is referenced where it should be. No edits in this task; if any grep fails, the corresponding earlier task is incomplete and needs to be re-opened.

**Files:** none (read-only)

**Codex:** ok

- [ ] **Step 1: Confirm all complexity declarations + cross-references**

Run as ONE parallel Bash batch:

```bash
# Declarations (Task 1)
grep -cE "^complexity:" commands/masterplan.md  # expected: 1 (config schema)
grep -cE "\\-\\-complexity=" commands/masterplan.md  # expected: ≥ 2 (flag table + body refs)
grep -cE "^- \`complexity\`" commands/masterplan.md  # expected: 1 (Step B3 frontmatter bullet)
grep -cE "complexity: low \\| medium \\| high" commands/masterplan.md  # expected: ≥ 1 (status template)

# Resolver (Task 2)
grep -c "Complexity resolution (per invocation)" commands/masterplan.md  # expected: 1
grep -c "resolved_complexity" commands/masterplan.md  # expected: ≥ 8 (referenced in many tasks)
grep -c "complexity_source" commands/masterplan.md  # expected: ≥ 2

# Precedence (Task 3)
grep -c "Complexity precedence" commands/masterplan.md  # expected: ≥ 1 (Operational rules entry)

# Kickoff prompt (Task 4)
grep -c "Complexity kickoff prompt" commands/masterplan.md  # expected: 1
grep -c "What complexity for this project" commands/masterplan.md  # expected: 1

# Resume resolution (Task 5)
grep -c "Complexity resolution on resume" commands/masterplan.md  # expected: 1
grep -c "Complexity changed from" commands/masterplan.md  # expected: 1

# Sidecar gates (Tasks 6, 7)
grep -c "Complexity gate (eligibility cache)" commands/masterplan.md  # expected: 1
grep -c "skip telemetry entirely" commands/masterplan.md  # expected: 1

# Step 4d density + Step 5 ledger (Tasks 8, 9)
grep -c "Complexity gate (activity log density" commands/masterplan.md  # expected: 1
grep -c "## Wakeup ledger\` section is NOT maintained" commands/masterplan.md  # expected: 1

# Brief + retro (Tasks 10, 11)
grep -c "Complexity-aware brief" commands/masterplan.md  # expected: 1
grep -c "Complexity gate (retro at high)" commands/masterplan.md  # expected: 1

# Doctor (Tasks 12, 13)
grep -c "Complexity-aware check set" commands/masterplan.md  # expected: 1
grep -cE "^\\| 22 \\|" commands/masterplan.md  # expected: 1
grep -cE "21 checks|all 21|Total checks: 21" commands/masterplan.md  # expected: 0 (all updated to 22)
```

Each grep should match its expected count. If any mismatch, identify the failing task and re-open it.

- [ ] **Step 2: Hook syntax check**

```bash
bash -n hooks/masterplan-telemetry.sh
echo "exit code: $?"
```
Expected: exit code 0 (no syntax errors). The hook is unchanged by this plan; re-running confirms no incidental damage.

- [ ] **Step 3: Markdown smoke — orchestrator file size sanity**

```bash
wc -l commands/masterplan.md
```
Expected: ~1801–1850 lines (started at 1601; spec estimated ~+200). If line count is < 1700 or > 2000, re-check Tasks 1–13 for missed or duplicated edits.

- [ ] **Step 4: No commit (read-only task)**

This task is verification only. Nothing to commit. If any grep failed, re-open the corresponding earlier task; do not proceed to Tasks 15–16 until all greps match.

---

### Task 15: Docs — CHANGELOG entry + Status file format section + WORKLOG handoff

Add the user-facing release entry (CHANGELOG `[Unreleased]` → "Added"), update the Status file format section's optional-fields comments to mention the new `complexity:` field placement, and append a WORKLOG handoff entry.

**Files:**
- Modify: `CHANGELOG.md` — `## [Unreleased]` section
- Modify: `commands/masterplan.md` — `## Status file format` section's frontmatter optional-fields comment block (append a hint about `complexity:`)
- Modify: `WORKLOG.md` — append dated handoff entry (gitignored — not committed)

**Codex:** ok

- [ ] **Step 1: Add CHANGELOG entry under [Unreleased]**

In `CHANGELOG.md`, under `## [Unreleased]` (and before any other heading), insert:

```markdown
### Added

- **3-level `complexity` variable** (`low | medium | high`) at every config tier
  (CLI flag `--complexity=<level>`, `~/.masterplan.yaml`, repo `.masterplan.yaml`,
  status frontmatter). Sets defaults for `autonomy`, `codex_routing`,
  `codex_review`, `parallelism.enabled`, `gated_switch_offer_at_tasks`, and
  `review_max_fix_iterations` per the precedence table in Operational rules.
  Explicit overrides (CLI flag, frontmatter, config) win over complexity-derived
  defaults. `medium` is the default and preserves all current behavior; existing
  plans without the field are read as `medium` (no migration needed).
- **`low` skips:** eligibility cache build, telemetry sidecar, wakeup ledger,
  parallelism waves, codex routing + codex review. Activity log uses one-line
  entries; rotation threshold drops to 50 (archives most recent 25). Plan-writing
  brief produces leaner plans (~3–7 tasks, optional `**Files:**`, no annotations).
  Doctor at low runs only checks #1–#10 + #18 (skips sidecar/annotation/ledger
  checks that don't apply).
- **`high` adds:** `codex_review` always on with `review_prompt_at: low`;
  required `**Files:**` + `**Codex:**` annotations per task; eligibility cache
  validated against the plan's `**Files:**` blocks; verification re-runs
  implementer's tests; retro becomes a recommended option at plan completion;
  new doctor check #22 (high-only) fires when a high plan lacks all three
  rigor signals (retro reference, codex review pass, `[reviewed: …]` tags).
- **Kickoff prompt:** when `--complexity` is not on the CLI and no config tier
  sets it, /masterplan surfaces one `AskUserQuestion` between worktree decision
  and brainstorm (kickoff verbs only). Setting any value in any config tier
  silences the prompt.
- **Activity-log audit line** at first Step C entry per session: cites the
  resolved complexity, its source (`flag` / `frontmatter` / `repo_config` /
  `user_config` / `default`), and any knobs whose final value differs from the
  complexity-derived default.
```

- [ ] **Step 2: Update Status file format optional-fields comments**

In `commands/masterplan.md`, find the `## Status file format` section's frontmatter example block. Locate the `# Optional v2.1.0+: gated_switch_offer_shown` comment block. Update the `complexity:` line that Task 1 added so the comment makes sense in context:

OLD (placed by Task 1):
```yaml
complexity: low | medium | high
```

NEW (replace the line with):
```yaml
complexity: low | medium | high  # Required at execution; set by Step B3 kickoff prompt or --complexity flag. Pre-feature plans without this field are read as medium.
```

- [ ] **Step 3: Append WORKLOG handoff entry**

Append to `WORKLOG.md` (gitignored — not staged):

```markdown
---

## 2026-05-05 — Unreleased — 3-level complexity meta-knob

**Scope:** Added `complexity: low|medium|high` variable to /masterplan that
scales plan-writing artifacts, status persistence, execution rigor, and doctor
checks together. Defaults-only meta-knob: explicit settings (CLI flag,
frontmatter, config) win over complexity-derived defaults. medium = current
behavior (back-compat); low relaxes per-task rigor and persistence overhead;
high adds rigor-forward defaults + new doctor check #22.

**Why this shape:**
- User pain (verbatim): "Not every project needs a massive plan and nitpicking
  every detail." Top observed pain: per-task rigor (codex review + activity log
  density + verification on every task). Meta-knob with defaults-only resolution
  was the agreed approach during brainstorming.
- Brainstorm runs full at every level (where bad assumptions get caught — the
  user explicitly opted out of scaling brainstorm depth).
- Existing fine-grained knobs (`autonomy`, `codex_routing`, etc.) remain. The
  spec's §Alternatives considered captures the rejected paths (two orthogonal
  knobs, hard-overrides, numeric levels, per-task complexity, replacing autonomy).

**Known followups (post-this-change):**
- OQ1: `--quick` alias for `--complexity=low`. Defer; ergonomic only.
- OQ2: Auto-compact nudge suppression at low. Lean yes; small follow-up.
- OQ5: `/masterplan stats` complexity distribution rendering. Trivial; nice-to-have.

**Branch state:** Implementation lives on `complexity-levels` branch in
`.worktrees/complexity-levels/`. Spec at
`docs/superpowers/specs/2026-05-05-complexity-levels-design.md`. Plan at
`docs/superpowers/plans/2026-05-05-complexity-levels.md`. Status file at
`docs/superpowers/plans/2026-05-05-complexity-levels-status.md` (created by
Step B3).
```

- [ ] **Step 4: Verify CHANGELOG + Status file format updates**

```bash
grep -nE "^### Added$|3-level \`complexity\` variable" CHANGELOG.md
# Expected: 2 matches — the heading and the bullet.

grep -nE "complexity:.*Required at execution" commands/masterplan.md
# Expected: 1 match — the updated status template comment.
```

- [ ] **Step 5: Commit (CHANGELOG + Status file format only — WORKLOG is gitignored)**

```bash
git add CHANGELOG.md commands/masterplan.md
git commit -m "complexity-levels: CHANGELOG entry + Status file format hint"
```

---

### Task 16: Release — version bump + commit + tag + push

Bump plugin.json, marketplace.json (both top-level + nested), cut [Unreleased] in CHANGELOG to a new versioned section, commit with release-style message, create annotated tag, push commit + tag. Authorization required from user before pushing per /masterplan's CD-5 boundary on remote-visible actions.

**Files:**
- Modify: `.claude-plugin/plugin.json` — `"version"` field
- Modify: `.claude-plugin/marketplace.json` — both `"version"` fields (top-level + nested in plugins[0])
- Modify: `CHANGELOG.md` — replace `## [Unreleased]` with `## [2.5.0] — 2026-05-05` and add a new empty `## [Unreleased]` heading above

**Codex:** no  *(remote-visible operations: tag, push to origin/main. Requires user authorization at the gate; not safe for unattended Codex execution.)*

- [ ] **Step 1: Pause for user authorization (CD-5 gate)**

Surface `AskUserQuestion("All implementation tasks done. Ready to release v2.5.0 (minor bump — new feature, back-compat preserved)?", options=["Tag and push v2.5.0 (Recommended)", "Bump version + commit locally; I'll push later", "Skip release; merge later via PR", "Pause — I want to review one more thing"])`. Honor the answer; do NOT proceed to step 2 without explicit Yes-tag-and-push or Yes-local.

- [ ] **Step 2: Bump versions and cut CHANGELOG**

If user picked Yes:

In `.claude-plugin/plugin.json`, change:
```json
"version": "2.4.1"
```
to:
```json
"version": "2.5.0"
```

In `.claude-plugin/marketplace.json`, change BOTH occurrences of:
```json
"version": "2.4.1"
```
to:
```json
"version": "2.5.0"
```

In `CHANGELOG.md`, change:
```markdown
## [Unreleased]

### Added
- ...
```
to:
```markdown
## [Unreleased]

## [2.5.0] — 2026-05-05

### Added
- ...
```

- [ ] **Step 3: Commit + tag + push**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
release: v2.5.0 — 3-level complexity meta-knob

Adds `complexity: low|medium|high` to /masterplan. Defaults-only meta-knob:
explicit overrides (CLI flag, frontmatter, config) win over complexity-derived
defaults. medium = current behavior (back-compat); low skips eligibility cache,
telemetry, wakeup ledger, parallelism, codex routing/review, with one-line
activity log; high adds rigor-forward defaults + new doctor check #22.

Brainstorm runs full at every level.

See CHANGELOG.md [2.5.0] for the full details.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
git tag -a v2.5.0 -m "release: v2.5.0 — 3-level complexity meta-knob"
git push origin main
git push origin v2.5.0
```

- [ ] **Step 4: Verify the release on GitHub**

```bash
gh api repos/rasatpetabit/superpowers-masterplan/tags --jq '.[0:2] | .[] | {name, commit: .commit.sha[0:7]}'
gh api repos/rasatpetabit/superpowers-masterplan/commits/main --jq '{sha: .sha[0:7], message: .commit.message | split("\n")[0], author: .commit.author.email}'
gh api repos/rasatpetabit/superpowers-masterplan/contents/.claude-plugin/plugin.json?ref=v2.5.0 --jq '.content' | base64 -d | grep version
```
Expected:
- Tag `v2.5.0` → matches local commit SHA.
- `main` HEAD = same SHA, author = `ras@petabitscale.com`.
- `plugin.json` at `v2.5.0` shows `"version": "2.5.0"`.

- [ ] **Step 5: Final summary message to user**

Output a short closing message: tag URL, commits since v2.4.1, link to CHANGELOG. End the turn cleanly.

---

## Self-review notes

- **Spec coverage:** every spec section is addressed:
  - Variable + precedence → Tasks 1, 2, 3, 5
  - Behavior matrix / Plan-writing → Tasks 1, 10
  - Behavior matrix / Status file → Tasks 1, 8, 9
  - Behavior matrix / Execute defaults → Task 3 (precedence table; consumed by Step C)
  - Behavior matrix / Doctor → Tasks 12, 13
  - Behavior matrix / Verification → Task 8 (covered by complexity-aware activity log; the "trust implementer tests" row at high is in the spec but does not require a separate task — implementer's `tests_passed` is already trusted at medium; the high override is a brief-time decision documented in the precedence table at Task 3)
  - Kickoff UX → Task 4
  - Resume UX → Task 5
  - Step M → no change (called out in spec; no task needed)
  - Migration → Tasks 5, 12 (frontmatter absence handling)
  - Test plan T1–T8 → Task 14 (grep discriminators) + manual smoke runs after release
- **Placeholder scan:** no TBDs, TODOs, or "implement later" markers. Each Codex annotation is justified.
- **Type consistency:** the term `resolved_complexity` is used uniformly across Tasks 2, 3, 5, 6, 7, 8, 9, 10, 11; `complexity_source` is used in Tasks 2, 3, 4, 5. Knob names match exactly between Operational rules' precedence table (Task 3) and downstream task references.

---

> **Note for executor:** /masterplan's Step B3 close-out gate handles the execution-mode prompt (Subagent-Driven vs Inline). Do NOT print a separate "Plan complete and saved" / "Which approach?" prompt at the end of this plan — the orchestrator will surface its own AskUserQuestion next.
