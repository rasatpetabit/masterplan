# Masterplan TaskCreate Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project each masterplan run's task list into Claude Code's native `TaskCreate` ledger so the harness UI shows wave/parallel-group progress and the per-turn "you have N pending tasks" reminder noise is silenced. `state.yml` stays canonical (CD-7 unchanged); the projection is rehydrated on every session start.

**Architecture:** Insert a new "TaskCreate projection layer" section into `commands/masterplan.md` defining the schema, rehydration procedure, drift rules, and Codex no-op gate. Thread three hook points into existing flow: rehydration at Step M (resume) + Step C (execute entry), transition mirroring at every Step C state.yml-write site, and drift reconciliation at rehydration entry. All projection calls are wrapped in a `codex_host_suppressed == false` gate so Codex hosts emit no Task* calls.

**Tech Stack:** Markdown orchestrator prompt (`commands/masterplan.md`); bash audit scripts (`bin/masterplan-self-host-audit.sh`); JSONL event log (`docs/masterplan/<slug>/events.jsonl`). Verification = `grep` discriminators + `bash -n` syntax checks + one manual smoke run.

**Test discipline:** Each code-changing task follows the codebase convention — write a grep that PROVES the feature is not present, run it to confirm failure (red), edit `commands/masterplan.md`, re-run the grep to confirm it passes (green), commit. This is the closest analogue to TDD that a markdown-prompt codebase supports.

**Open precondition:** Task 1 smoke-tests whether harness reminder-suppression keys on `in_progress` tasks or on "any tasks present". If only `in_progress` suppresses, the design's initial-status pattern (`pending` at rehydrate, then `in_progress` on dispatch) does not deliver the reminder-noise savings on idle bundles — re-scope before proceeding to Task 2.

---

## File structure

**Files to modify:**
- `commands/masterplan.md` — the orchestrator prompt. New section "TaskCreate projection layer" inserted after `## Subagent and context-control architecture` (around line 649, before `## Step M`). Hook insertions in Step M, Step C, Step I.
- `docs/internals.md` — design documentation. New subsection "TaskCreate projection layer" in the same architectural neighborhood as "Subagent and context-control architecture".
- `bin/masterplan-self-host-audit.sh` — add discriminator greps for the projection gating pattern.
- `CHANGELOG.md` — `[Unreleased]` entry describing the projection.
- `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` — version bump for release (4.1.0).

**Files to create:**
- None. The projection is a new section inside the existing orchestrator prompt; it does not warrant a separate file.

---

## Task 1: Smoke-test the reminder-suppression precondition

**Why:** Spec §open-question-2. Before any code change, confirm the projection actually buys reminder-noise reduction. If Claude Code's `system-reminder` for "consider TaskCreate/TaskUpdate" fires only when no `in_progress` tasks exist (not when no tasks at all), then a fresh rehydration where all tasks are `pending` would still trip the reminder, and the design needs adjustment.

**Files:**
- None (observational test in a scratch transcript).

- [ ] **Step 1: Create a minimal scratch repo with one TaskCreate task in `pending`**

In any disposable directory, open a fresh Claude Code session and run:

```
TaskCreate { tasks: [{ subject: "smoke pending", description: "placeholder", prompt: "" }] }
```

Then do nothing for the next ~3 turns of trivial conversation ("hi", "what's 2+2", "ls").

- [ ] **Step 2: Observe reminder behavior**

Read the per-turn transcripts. Record YES/NO whether a `<system-reminder>` about "consider TaskCreate to add new tasks and TaskUpdate to update task status" fires in those 3 turns while the only task is `pending`.

Expected outcomes and branching:

- **Reminder does NOT fire while a pending task exists** → projection design is correct as-spec'd. Proceed to Task 2.
- **Reminder DOES fire while only a pending task exists** → STOP. Update spec §1 to make the initial status `in_progress` on rehydration (and adjust §3 transition rules accordingly), then proceed.

- [ ] **Step 3: Record finding in events.jsonl**

Append a one-line summary to `docs/masterplan/v4-lifecycle-redesign/events.jsonl` (the bundle that drove the v5.x decomposition) so the precondition result is durable. Format:

```
{"ts":"<ISO-now>","event":"p4_precondition_smoke","reminder_fires_on_pending":<true|false>,"decision":"proceed-as-spec|adjust-initial-status"}
```

- [ ] **Step 4: Commit the finding**

```bash
git add docs/masterplan/v4-lifecycle-redesign/events.jsonl
git commit -m "p4: record reminder-suppression smoke result"
```

---

## Task 2: Add the "TaskCreate projection layer" section to commands/masterplan.md

**Why:** Spec §1 (schema) and §4 (drift) need a single canonical definition the orchestrator prompt can reference from each hook site. Keeping the spec local to the prompt avoids the cross-file drift described in CLAUDE.md anti-pattern #4.

**Files:**
- Modify: `commands/masterplan.md` — insert new `## TaskCreate projection layer` section between the existing `## Subagent and context-control architecture` section (ends near line 648) and `## Step M — Bare-invocation resume-first router` (starts at line 649).

- [ ] **Step 1: Write the discriminator grep**

Save the discriminator (manual check; do not commit):

```bash
grep -c "^## TaskCreate projection layer" commands/masterplan.md
```

- [ ] **Step 2: Run it to confirm absent**

Run the grep. Expected output: `0`.

- [ ] **Step 3: Insert the section**

Use Edit to insert the following block immediately before the line `## Step M — Bare-invocation resume-first router` (i.e., as a new top-level section after the context-control architecture):

```markdown
## TaskCreate projection layer

**Purpose:** mirror the plan's task list into the harness `TaskCreate` ledger so the user sees wave / parallel-group progress in the native UI, and the per-turn "you have N pending tasks" reminder is silenced. This is a one-way derived projection. `state.yml` is canonical per CD-7; the projection is rebuilt from `state.yml` + `plan.md` on every session start. If TaskList ever disagrees with state.yml, state.yml wins.

### Projection schema

For each task in `plan.md`, create exactly one TaskCreate task. Mapping is one-to-one (granularity B).

| TaskCreate field | Source |
|---|---|
| `subject` | First line of the plan-task heading, truncated to 80 chars. |
| `description` | Plan-task body, truncated to 500 chars. Detail stays in `plan.md`. |
| `prompt` | Empty (orchestrator drives execution; tasks are not user-runnable from the harness). |
| `metadata` | `{"masterplan": {"slug": "<run-slug>", "task_idx": <0-based>, "wave": <wave-id or null>, "parallel_group": "<group-name or null>", "plan_path": "docs/masterplan/<slug>/plan.md", "state_path": "docs/masterplan/<slug>/state.yml"}}` |
| Initial status | `pending` (TaskCreate default), unless Task 1's precondition smoke determined `in_progress` is required to suppress reminders. |

DAG edges use `TaskUpdate { addBlockedBy }` in a second pass after batch creation. Tasks in the same wave / parallel_group have no blocking edges.

### Rehydration trigger

Rehydration runs **once per session** at the first of these events:

1. Step M resolves to an in-progress bundle.
2. Step C entry for an in-progress bundle.
3. Step I completes import and the imported bundle is in-progress.

Rehydration procedure:

1. Read canonical `state.yml` + `plan.md`.
2. Call `TaskList`.
3. Branch on TaskList contents:
   - **Empty** → batch-create one task per plan task. Then apply blockedBy edges in pass 2.
   - **Non-empty, same `metadata.masterplan.slug`** → drift, see §Drift recovery.
   - **Non-empty, unrelated** → leave foreign tasks untouched; append projection alongside. The projection's tasks remain identifiable by `metadata.masterplan.*`.
4. Set status from `state.yml`:
   - `tasks_completed` entries → `TaskUpdate(status: "completed")`.
   - `current_task` → `TaskUpdate(status: "in_progress")`.
   - Others → leave at initial status.
5. Append `taskcreate_projection_rehydrated` event with `{count_created, count_completed_at_rehydrate, count_in_progress}`.

Rehydration is O(plan-task-count); typical 50-task plan costs ~50 TaskCreate + ~50 TaskUpdate.

### Lifecycle mirror hooks

Every site where the orchestrator writes `state.yml` for a task transition must also mirror to TaskList, in this order:

1. Compute mutation.
2. Write `state.yml`; append `events.jsonl`.
3. Call `TaskUpdate` to mirror.

If step 3 fails, do **not** roll back state.yml. Append `taskcreate_mirror_failed` with the error and continue; the next rehydration reconciles.

Transition table:

| state.yml change | TaskList mirror |
|---|---|
| `current_task` advances N → N+1 | TaskUpdate N → `completed`; TaskUpdate N+1 → `in_progress`. |
| Wave dispatch begins (W₁..Wₖ) | Batched TaskUpdate W₁..Wₖ → `in_progress`. |
| Wave member completes (digest received) | TaskUpdate that member → `completed`. |
| Status → `pending_retro` | TaskUpdate current → `completed`; no new `in_progress`. |
| Status → `complete` | All tasks already completed; no-op. |
| Status → `blocked` | Leave current at `in_progress`; emit blocker via the existing CD-4 AskUserQuestion path. |

Tasks discovered mid-flight (rare; `plan.md` grew) are batch-created immediately after the plan write; rehydration on the next session would otherwise pick them up.

### Drift recovery

State.yml is canonical. Detected at rehydration and on every Step C re-entry. Rules:

| Observation | Action | Event |
|---|---|---|
| TaskList shows `completed`; state.yml `tasks_completed` doesn't list it | Revert TaskList to match state.yml | `taskcreate_drift_corrected` `{direction: "tasklist_wrong"}` |
| state.yml `tasks_completed` lists task; TaskList shows `pending` | Fast-forward TaskList | `taskcreate_drift_corrected` `{direction: "tasklist_wrong"}` |
| state.yml `current_task` ≠ TaskList `in_progress` | Sync TaskList | `taskcreate_drift_corrected` `{direction: "tasklist_wrong"}` |
| `plan.md` grew; TaskList missing | Create new tasks | (rehydration §2 step 3 covers) |
| TaskList has `masterplan.*` task with `task_idx` out of range | TaskUpdate → `cancelled` | `taskcreate_orphan_cancelled` |

There is no inverse-direction reconciliation. TaskList never feeds back into state.yml.

### Codex no-op gate

The projection is Claude Code-only. On Codex hosts, every TaskCreate / TaskUpdate / TaskList call is **skipped** and no projection events are emitted. The gate is the same `codex_host_suppressed` boolean set in Step 0:

```
if codex_host_suppressed == false:
    # projection call here
    pass
```

This means the reminder-noise saving is Claude Code-only by design (see brainstorming session 2026-05-12, "Accept Codex degradation").

```

- [ ] **Step 4: Re-run the discriminator to confirm present**

Run the grep again. Expected output: `1`.

- [ ] **Step 5: Commit**

```bash
git add commands/masterplan.md
git commit -m "masterplan: add TaskCreate projection layer section"
```

---

## Task 3: Wire rehydration into Step M and Step C entry

**Why:** Spec §2. Rehydration must fire at every entry point that resolves an in-progress bundle. Step M is bare-invocation resume; Step C is execute. Step I (import) completes by handing off to Step C, so Step C's gate covers the import case.

**Files:**
- Modify: `commands/masterplan.md` — Step M (line ~649) and Step C entry (line ~1270).

- [ ] **Step 1: Write discriminator**

```bash
grep -c "taskcreate_projection_rehydrated" commands/masterplan.md
```

- [ ] **Step 2: Confirm absent**

Run. Expected: `0`.

- [ ] **Step 3: Insert the rehydration call at Step M and Step C**

Find the Step M section heading (`## Step M — Bare-invocation resume-first router`). Locate the branch where it resolves to an in-progress bundle and prepares to hand off — typically the last step before transferring to Step C or rendering a resume-status. Insert this paragraph:

```markdown
**Rehydrate TaskCreate projection (Claude Code only).** Before transferring to Step C or rendering status, if `codex_host_suppressed == false`, run the rehydration procedure from §TaskCreate projection layer — Rehydration trigger. Append `taskcreate_projection_rehydrated` to `events.jsonl` with the counts. If TaskCreate dispatch errors, append `taskcreate_mirror_failed` with the error string and proceed; state.yml is canonical.
```

Locate Step C entry (`## Step C — Execute`). Insert the same paragraph as a new sub-step at the very start of the section, before any task-loop logic, so that direct `/masterplan execute` and continued-from-Step-M both pass through it. Wording adjust: replace "Before transferring to Step C or rendering status" with "Before entering the task loop".

- [ ] **Step 4: Confirm present**

Run the grep again. Expected: `2` (one ref in Step M, one ref in Step C). If `1`, the second insertion was missed — re-do it.

- [ ] **Step 5: Commit**

```bash
git add commands/masterplan.md
git commit -m "masterplan: rehydrate TaskCreate projection at Step M and Step C entry"
```

---

## Task 4: Add transition mirror hooks at Step C state.yml-write sites

**Why:** Spec §3. The orchestrator already writes state.yml at well-defined transition points; the projection must mirror those writes to TaskList in the same step.

**Files:**
- Modify: `commands/masterplan.md` Step C section (between lines ~1270 and ~1951).

- [ ] **Step 1: Identify the write sites**

Locate Step C's transition write sites. The current sites (verify by reading the section):

1. Task advance: where `current_task` is bumped to the next plan task.
2. Wave dispatch start: where the orchestrator records that wave members are in flight.
3. Wave member completion: where each digest gets recorded.
4. `pending_retro` flip (FM-A path).
5. `complete` flip (after retro generated).
6. `blocked` flip.

Confirm by:

```bash
grep -nE "current_task|wave_dispatched|pending_retro|status:.*complete|status:.*blocked" commands/masterplan.md | head -30
```

- [ ] **Step 2: Write discriminator**

```bash
grep -c "TaskUpdate.*mirror\|taskcreate_mirror_failed" commands/masterplan.md
```

- [ ] **Step 3: Confirm absent (or counted)**

Run. Record the baseline count. After insertion the count should grow by at least 6 (one mention per transition site, or one paragraph + 6 inline references).

- [ ] **Step 4: Insert mirror callouts**

At each of the six transition write sites, insert a callout immediately after the state.yml-write description. Use this template, substituting `<TRANSITION>` and `<TASK-IDX>` per site:

```markdown
**Mirror to TaskList (if `codex_host_suppressed == false`).** Per §TaskCreate projection layer — Lifecycle mirror hooks, transition `<TRANSITION>`: call TaskUpdate with the per-row directive from the transition table. On failure, append `taskcreate_mirror_failed` to `events.jsonl` with the error string and continue. Do not roll back the state.yml write.
```

Concrete substitutions for each of the six sites are listed in §3 of the spec (and in the section inserted in Task 2). The engineer should read that table when authoring each callout, not duplicate it here.

- [ ] **Step 5: Confirm present**

Re-run the discriminator from Step 2. Expected: at least 6 above baseline.

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "masterplan: mirror state.yml transitions to TaskList at Step C write sites"
```

---

## Task 5: Add drift-recovery at rehydration entry

**Why:** Spec §4. When TaskList already contains tasks tagged with the current bundle's slug at rehydration time, the orchestrator must reconcile. Rules in the projection section (Task 2). This task wires the trigger.

**Files:**
- Modify: `commands/masterplan.md` — the rehydration paragraph(s) added in Task 3 need an explicit drift call-out.

- [ ] **Step 1: Discriminator**

```bash
grep -c "taskcreate_drift_corrected" commands/masterplan.md
```

- [ ] **Step 2: Confirm absent**

Expected: `0`.

- [ ] **Step 3: Insert drift handling**

In both Step M and Step C entry paragraphs added in Task 3, append a sentence:

```markdown
If TaskList already contains tasks with `metadata.masterplan.slug == <current-slug>`, run drift recovery per §TaskCreate projection layer — Drift recovery before proceeding. Append `taskcreate_drift_corrected` or `taskcreate_orphan_cancelled` events as the rules emit.
```

- [ ] **Step 4: Confirm present**

```bash
grep -c "taskcreate_drift_corrected" commands/masterplan.md
```

Expected: at least `1` (the projection-section reference counts; the new entry-paragraph references add to it).

- [ ] **Step 5: Commit**

```bash
git add commands/masterplan.md
git commit -m "masterplan: drift recovery at TaskCreate rehydration entry"
```

---

## Task 6: Confirm Codex no-op gating across every projection call

**Why:** Spec §5. The projection must be a strict no-op when `codex_host_suppressed == true`. Every Task* mention in the prompt should sit inside that gate.

**Files:**
- Modify: `commands/masterplan.md` — sweep all TaskCreate / TaskUpdate / TaskList mentions; ensure each is preceded by the gate phrase.

- [ ] **Step 1: Enumerate all Task* call sites added by Tasks 2–5**

```bash
grep -nE "TaskCreate|TaskUpdate|TaskList" commands/masterplan.md
```

Read each hit. Determine whether it sits inside a `codex_host_suppressed == false` gate (either inline or implied by an enclosing paragraph that begins with the gate phrase).

- [ ] **Step 2: Discriminator**

For every line numbered by Step 1 that is a call instruction (not a header or description in the projection-spec section), confirm the enclosing paragraph contains the literal string `codex_host_suppressed == false` OR the literal `Claude Code only`.

```bash
grep -nE "TaskCreate|TaskUpdate|TaskList" commands/masterplan.md | while read -r line; do
  ln=$(echo "$line" | cut -d: -f1)
  start=$((ln > 3 ? ln - 3 : 1))
  end=$((ln + 1))
  context=$(sed -n "${start},${end}p" commands/masterplan.md)
  if echo "$context" | grep -qE "codex_host_suppressed == false|Claude Code only"; then
    echo "OK  $line"
  else
    echo "GAP $line"
  fi
done
```

- [ ] **Step 3: Patch any GAPs**

For each `GAP` line, edit the surrounding paragraph to add the gate. Most should already be gated by Tasks 2–5; this step is the final sweep.

- [ ] **Step 4: Re-run the discriminator**

Expected: every line prefixed `OK`, none `GAP`.

- [ ] **Step 5: Commit (if changes)**

```bash
git add commands/masterplan.md
git commit -m "masterplan: confirm Codex no-op gate on every projection call"
```

---

## Task 7: Document new events in Run bundle state format section

**Why:** `events.jsonl` schema is documented in `## Run bundle state format` (around line 2563). New event types `taskcreate_projection_rehydrated`, `taskcreate_mirror_failed`, `taskcreate_drift_corrected`, `taskcreate_orphan_cancelled` must be listed there so doctor checks and external consumers know about them.

**Files:**
- Modify: `commands/masterplan.md` — `## Run bundle state format` section.

- [ ] **Step 1: Read the existing event-types subsection**

```bash
awk '/^## Run bundle state format/,/^## /' commands/masterplan.md | head -120
```

Locate the table or bullet list enumerating event types.

- [ ] **Step 2: Discriminator**

```bash
grep -cE "taskcreate_projection_rehydrated|taskcreate_mirror_failed|taskcreate_drift_corrected|taskcreate_orphan_cancelled" commands/masterplan.md
```

Record baseline (the Task-2 section reference adds some; document additions should push the count higher).

- [ ] **Step 3: Insert the four event entries**

Append the four entries to the event-types listing, one per row/bullet, matching the surrounding style:

```markdown
- `taskcreate_projection_rehydrated` — emitted once per session when the orchestrator (Claude Code host only) rebuilds the harness TaskList from `state.yml` + `plan.md`. Payload: `{count_created, count_completed_at_rehydrate, count_in_progress}`.
- `taskcreate_mirror_failed` — emitted when a TaskUpdate or TaskCreate call returns an error during a transition mirror or rehydration. Payload: `{call: "TaskCreate|TaskUpdate", task_idx: <int or null>, error: "<message>"}`. state.yml is NOT rolled back; reconciliation happens at next rehydration.
- `taskcreate_drift_corrected` — emitted when rehydration / re-entry detects TaskList disagreeing with state.yml and corrects TaskList. Payload: `{direction: "tasklist_wrong", task_idx: <int>, from: "<status>", to: "<status>"}`.
- `taskcreate_orphan_cancelled` — emitted when a TaskList task with `metadata.masterplan.*` has a `task_idx` outside the current `plan.md` range. Payload: `{task_idx: <int>}`.
```

- [ ] **Step 4: Confirm count grew**

Re-run the Step 2 discriminator. Expected: baseline + 4 or more.

- [ ] **Step 5: Commit**

```bash
git add commands/masterplan.md
git commit -m "masterplan: document TaskCreate projection events in state-format section"
```

---

## Task 8: Validate wave fan-out tool-budget cost (open question #1)

**Why:** Spec §open-question-1. A 10-member wave issues 10 TaskUpdate calls in one batched dispatch. Confirm this fits within typical orchestrator tool budgets before declaring the implementation done. This is an integration-smoke step — no code change required if the cost is acceptable.

**Files:**
- None (observational; may modify `state.yml` of a scratch bundle).

- [ ] **Step 1: Identify or create a scratch bundle with a wide wave**

Find an in-progress bundle with a wave of 8+ parallel tasks, or hand-author one. The `v4-lifecycle-redesign` bundle's wave 4–6 should qualify if any are still in-progress; otherwise create a synthetic plan.

- [ ] **Step 2: Run /masterplan execute on it**

In a fresh Claude Code session, invoke `/masterplan execute <slug>` and let the orchestrator dispatch the wide wave.

- [ ] **Step 3: Observe tool-call accounting**

Read the per-turn telemetry (or eyeball the turn output). Count the TaskUpdate calls in the wave-dispatch turn. Confirm the orchestrator did not hit a per-turn tool budget (no "tool budget reached" close-out).

- [ ] **Step 4: Record finding**

Append to `events.jsonl` of the `v4-lifecycle-redesign` bundle:

```
{"ts":"<ISO-now>","event":"p4_wave_fanout_smoke","wave_size":<n>,"taskupdate_calls":<n>,"budget_tripped":<true|false>}
```

If `budget_tripped: true`, file a follow-up issue to introduce batching (single TaskUpdate call with array of `{taskId, status}` pairs if the harness API supports it; otherwise scope-limit wave width).

- [ ] **Step 5: Commit**

```bash
git add docs/masterplan/v4-lifecycle-redesign/events.jsonl
git commit -m "p4: validate TaskCreate fan-out under wide-wave dispatch"
```

---

## Task 9: Add audit-script discriminators

**Why:** `bin/masterplan-self-host-audit.sh` is the canonical regression-prevention lint for this codebase. Adding a discriminator that confirms every `TaskCreate` / `TaskUpdate` / `TaskList` mention in `commands/masterplan.md` sits inside a `codex_host_suppressed == false` gate makes the Codex-no-op invariant unbreakable by future edits.

**Files:**
- Modify: `bin/masterplan-self-host-audit.sh` — add a new check.

- [ ] **Step 1: Read the existing audit checks**

```bash
grep -nE "^check_|^audit_|--cd9|case " bin/masterplan-self-host-audit.sh | head -40
```

Identify the check-dispatch pattern and the `case "$mode"` block.

- [ ] **Step 2: Discriminator**

```bash
grep -c "taskcreate-gate\|TaskCreate.*gate" bin/masterplan-self-host-audit.sh
```

Expected: `0`.

- [ ] **Step 3: Add the check**

Add a new check function (placement: alongside `--cd9`, in alphabetical or insertion order — match local convention). Sample function:

```bash
check_taskcreate_gate() {
  local fail=0
  while IFS=: read -r ln _; do
    [[ -z "$ln" ]] && continue
    local start=$((ln > 3 ? ln - 3 : 1))
    local end=$((ln + 1))
    local ctx
    ctx=$(sed -n "${start},${end}p" commands/masterplan.md)
    if ! echo "$ctx" | grep -qE "codex_host_suppressed == false|Claude Code only"; then
      echo "GAP commands/masterplan.md:$ln — TaskCreate/Update/List without Codex gate"
      fail=1
    fi
  done < <(grep -nE "TaskCreate|TaskUpdate|TaskList" commands/masterplan.md)
  return "$fail"
}
```

Wire it into the dispatcher so `bin/masterplan-self-host-audit.sh --taskcreate-gate` runs it, and into the all-checks default path.

- [ ] **Step 4: bash syntax check**

```bash
bash -n bin/masterplan-self-host-audit.sh
```

Expected: no output (clean parse).

- [ ] **Step 5: Run the check**

```bash
bash bin/masterplan-self-host-audit.sh --taskcreate-gate
```

Expected: exit 0 (no GAP lines).

- [ ] **Step 6: Commit**

```bash
git add bin/masterplan-self-host-audit.sh
git commit -m "audit: add --taskcreate-gate check for Codex no-op invariant"
```

---

## Task 10: Update docs/internals.md, README.md, CHANGELOG, version bump

**Why:** Match the cross-file sync discipline in CLAUDE.md anti-pattern #4. `docs/internals.md` documents the architecture; `README.md` mentions any user-visible behavior; `CHANGELOG.md` records the release; plugin manifests get the version bump.

**Files:**
- Modify: `docs/internals.md`, `README.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`.

- [ ] **Step 1: Append internals section**

Insert a new subsection in `docs/internals.md` after the "Subagent and context-control architecture" section. Sample content (substitute current date):

```markdown
### TaskCreate projection layer (v4.1.0)

The orchestrator projects each run's plan-task list into the harness `TaskCreate` ledger as a derived, one-way mirror. `state.yml` remains canonical per CD-7; the projection is rebuilt on every session start and reconciled on every Step C re-entry. Provenance lives in `task.metadata.masterplan.{slug,task_idx,wave,parallel_group,plan_path,state_path}`. Codex hosts skip the projection entirely (no TaskCreate calls, no projection events).

**Why:** the harness emits a `<system-reminder>` per turn nudging the orchestrator toward TaskCreate; left unaddressed it steals ~200 tokens/turn from Opus context. The projection makes that reminder a no-op and gives the user wave-progress visibility in the native task UI. See `commands/masterplan.md § TaskCreate projection layer` for schema, rehydration, drift, and event-type details.

**Event types emitted:** `taskcreate_projection_rehydrated`, `taskcreate_mirror_failed`, `taskcreate_drift_corrected`, `taskcreate_orphan_cancelled`. All four are scoped to the projection layer and never block state.yml writes.
```

- [ ] **Step 2: Update README**

Append one row to whatever feature table or bullet list summarizes runtime behavior. Sample bullet:

```markdown
- **Native task-list integration (Claude Code).** Each plan's tasks are projected into the harness TaskCreate ledger for wave-progress visibility. State.yml stays canonical; the projection is rebuilt on session start. Codex hosts are a no-op.
```

- [ ] **Step 3: CHANGELOG entry**

Add under `## [Unreleased]` (or, if cutting a release, under a new `## [4.1.0] — <date>` header):

```markdown
### Added
- TaskCreate projection layer: plan tasks are mirrored to the harness's native task ledger so wave progress is visible in the UI and the per-turn TaskCreate reminder is silenced. Claude Code-only; Codex no-op.
- Four new `events.jsonl` event types: `taskcreate_projection_rehydrated`, `taskcreate_mirror_failed`, `taskcreate_drift_corrected`, `taskcreate_orphan_cancelled`.
- `bin/masterplan-self-host-audit.sh --taskcreate-gate` check enforcing the Codex no-op invariant.

### Notes
- Pure addition. No schema bump. `state.yml` shape is unchanged. Existing bundles get a projection the next time they're resumed; no backfill needed.
```

- [ ] **Step 4: Version bump**

```bash
# both manifests
sed -i 's/"version": "4.0.0"/"version": "4.1.0"/' .claude-plugin/plugin.json
sed -i 's/"version": "4.0.0"/"version": "4.1.0"/' .codex-plugin/plugin.json
grep '"version"' .claude-plugin/plugin.json .codex-plugin/plugin.json
```

Expected: both show `"version": "4.1.0"`.

- [ ] **Step 5: Final discriminators**

```bash
grep -c "TaskCreate projection layer" docs/internals.md
grep -c "Native task-list integration" README.md
grep -c "TaskCreate projection layer" CHANGELOG.md
```

Expected: all `>= 1`.

- [ ] **Step 6: bash syntax check on any modified scripts**

```bash
bash -n hooks/masterplan-telemetry.sh
bash -n bin/masterplan-self-host-audit.sh
bash -n bin/masterplan-state.sh
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add docs/internals.md README.md CHANGELOG.md .claude-plugin/plugin.json .codex-plugin/plugin.json
git commit -m "release: v4.1.0 TaskCreate projection layer"
```

---

## Self-review (run after the plan is drafted, before handing off)

This is a checklist for the plan author, not an execution step.

**1. Spec coverage:**
- §1 schema → Task 2 (definition) + Tasks 3,4,5 (call sites).
- §2 rehydration → Task 3.
- §3 lifecycle hooks → Task 4.
- §4 drift recovery → Task 5 + drift rules embedded in Task 2.
- §5 Codex no-op → Tasks 2,3,4,5 (per-site phrasing) + Task 6 (sweep) + Task 9 (lint).
- §open-question-1 → Task 8.
- §open-question-2 → Task 1 (precondition).
- §verification (events fire as expected) → Tasks 7 (schema doc) + manual smoke at Task 8.

No spec section is uncovered.

**2. Placeholder scan:** No "TBD" or "implement later" entries. Step 4 of Task 4 references "the per-row directive from the transition table" — the table is defined in Task 2's inserted content; the engineer reads it from there rather than the plan duplicating it. This is a deliberate single-source-of-truth choice, not a placeholder.

**3. Type consistency:** Event names are spelled identically everywhere (`taskcreate_projection_rehydrated`, `taskcreate_mirror_failed`, `taskcreate_drift_corrected`, `taskcreate_orphan_cancelled`). Metadata field path is consistent: `task.metadata.masterplan.{slug,task_idx,wave,parallel_group,plan_path,state_path}`. Gate phrase is the literal string `codex_host_suppressed == false` (matching the Step 0 variable from the existing prompt).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-masterplan-taskcreate-projection.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
