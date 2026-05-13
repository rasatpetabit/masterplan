# v4.1.1 — P4 Suppression Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship v4.1.1 with verified per-state-write `TaskUpdate` priming that actually silences the harness reminder during Step C execution, plus a Step C create-once-per-session / reconcile-every-entry split. Honestly amend v4.1.0's CHANGELOG entry (local-only commit `bbe5a38`) and rescope the README + internals docs claims.

**Architecture:** Mechanism is **additive** to v4.1.0's per-transition `TaskUpdate` mirror (commands/masterplan.md:1378). v4.1.1 extends the touch from "per-transition" to "per state.yml write" within Step C, gated on `codex_host_suppressed == false` and `current_task != ""`. Step C entry uses a new `state.yml` field `step_c_session_init_sha` (UUID from `bin/masterplan-state.sh`) to branch first-entry rehydration vs subsequent-entry drift-check. Verification is a real-session smoke run against `docs/masterplan/p4-suppression-smoke/` — a synthetic meta-bundle with a per-turn `smoke_observation` event contract.

**Tech Stack:** markdown orchestrator (`commands/masterplan.md`), bash helpers (`bin/masterplan-state.sh`), event logs (`events.jsonl`), grep discriminators + `bash -n` syntax checks (project idiom — no traditional test runner).

**Pre-flight constraints:**
- All git operations LOCAL ONLY until the user explicitly authorizes `git push` and `git push --tags`.
- All `TaskUpdate` mechanism gated on `codex_host_suppressed == false` — Codex hosts skip silently.
- "Tests" in this project = grep + `bash -n` + manual smoke. Do NOT introduce pytest/jest/etc.

---

## Task 1: Smoke bundle scaffold

**Files:**
- Create: `docs/masterplan/p4-suppression-smoke/state.yml`
- Create: `docs/masterplan/p4-suppression-smoke/spec.md`
- Create: `docs/masterplan/p4-suppression-smoke/plan.md`
- Create: `docs/masterplan/p4-suppression-smoke/events.jsonl` (empty file, agent appends at runtime)

**Why first:** the bundle must exist before orchestrator edits land so the user can immediately run the smoke against the new orchestrator in a fresh session (Task 13). The smoke's success criterion is encoded in the bundle's `spec.md` as the agent's contract.

- [ ] **Step 1: Create the smoke bundle state.yml**

```yaml
schema_version: 2
slug: p4-suppression-smoke
status: in_progress
phase: ready_to_execute
pending_retro_attempts: 0
worktree: ""
branch: main
started: 2026-05-13T00:00:00Z
last_activity: 2026-05-13T00:00:00Z
task_start_sha: ""
completion_sha: ""
current_task: ""
next_action: "Enter Step C; execute 3 no-op tasks; observe reminder firings"
autonomy: loose
loop_enabled: false
codex_routing: off
codex_review: off
compact_loop_recommended: false
complexity: low
pending_gate: null
artifacts:
  spec: docs/masterplan/p4-suppression-smoke/spec.md
  plan: docs/masterplan/p4-suppression-smoke/plan.md
  retro: ""
  events: docs/masterplan/p4-suppression-smoke/events.jsonl
  events_archive: ""
  eligibility_cache: ""
  telemetry: ""
  telemetry_archive: ""
  subagents: ""
  subagents_archive: ""
  state_queue: ""
legacy:
  approved_plan: ""
  codex_review_target: ""
halt_mode: none
stop_reason: ""
critical_error: null
step_c_session_init_sha: ""
```

- [ ] **Step 2: Create the smoke spec.md (encodes the observation contract)**

```markdown
# p4-suppression-smoke — Verification smoke bundle

## Purpose

Verify v4.1.1's per-state-write `TaskUpdate` priming actually suppresses the harness `<system-reminder>` during Step C wave execution.

## Mandatory observation contract

The orchestrator MUST append a `smoke_observation` event to `events.jsonl` BEFORE writing any other event on every turn during Step C, containing:

```json
{
  "ts": "<ISO-8601>",
  "event": "smoke_observation",
  "turn_n": <int, 1-indexed within Step C>,
  "tools_called": ["<tool-name>", ...],
  "reminder_fired": <bool: did the harness emit a system-reminder this turn>,
  "preceding_state_write": <bool: did this turn perform a state.yml write before the reminder check>,
  "last_task_update_age_turns": <int: turns since the last TaskUpdate call, -1 if never>
}
```

Absence of `smoke_observation` for any Step C turn is a verification failure — "no event recorded" cannot be inferred as "no reminder".

## Success criterion

For every turn within Step C wave execution: `reminder_fired == false` where `preceding_state_write == true`.

## Failure handling

If any state-write turn has `reminder_fired == true`, halt the run and route to v4.1.1 R1 Option D rescope (per `docs/masterplan/p4-suppression-fix/spec.md`).

## Tasks

3 no-op tasks designed to exercise the wave-dispatch path without doing real work. See `plan.md`.
```

- [ ] **Step 3: Create the smoke plan.md (3 no-op tasks)**

```markdown
# Smoke plan — 3 no-op tasks

## Task 1: No-op A
**Files:** none
**Steps:**
- [ ] **Step 1:** Append `smoke_task_1_done` to `docs/masterplan/p4-suppression-smoke/events.jsonl`. Return digest `{status: done, note: noop}`.

## Task 2: No-op B
**Files:** none
**Steps:**
- [ ] **Step 1:** Append `smoke_task_2_done` to `docs/masterplan/p4-suppression-smoke/events.jsonl`. Return digest `{status: done, note: noop}`.

## Task 3: No-op C
**Files:** none
**Steps:**
- [ ] **Step 1:** Append `smoke_task_3_done` to `docs/masterplan/p4-suppression-smoke/events.jsonl`. Return digest `{status: done, note: noop}`.
```

- [ ] **Step 4: Create empty events.jsonl**

Run: `touch docs/masterplan/p4-suppression-smoke/events.jsonl`

- [ ] **Step 5: Verify**

```bash
ls docs/masterplan/p4-suppression-smoke/
# expect: events.jsonl  plan.md  spec.md  state.yml
grep -c "smoke_observation" docs/masterplan/p4-suppression-smoke/spec.md
# expect: >= 2 (definition + reference)
```

- [ ] **Step 6: Commit**

```bash
git add docs/masterplan/p4-suppression-smoke/
git commit -m "Add p4-suppression-smoke meta-bundle for v4.1.1 verification"
```

---

## Task 2: Amend v4.1.0 commit (bbe5a38) — honest CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (the v4.1.0 section already present in `bbe5a38`)

**Why:** `bbe5a38` is local-only (not tagged, not pushed). The codex review flagged its CHANGELOG claim as inaccurate. Amending now keeps git history honest before tagging v4.1.0.

**Safety check first:**

- [ ] **Step 1: Confirm `bbe5a38` is local-only**

Run:
```bash
git log --oneline -1 bbe5a38
git tag --list 'v4.1.0'
git branch --contains bbe5a38 -r
```
Expected: commit exists locally; `v4.1.0` tag does NOT exist; no remote branches contain it. If a remote branch contains it, STOP and surface to the user — amending shared history is destructive.

- [ ] **Step 2: Re-read current CHANGELOG.md to find the v4.1.0 entry**

Use the Read tool on `CHANGELOG.md`. Identify the v4.1.0 section.

- [ ] **Step 3: Rewrite the v4.1.0 entry**

Replace the existing v4.1.0 block with:

```markdown
## v4.1.0 — TaskCreate projection (partial)

- Add `TaskCreate` projection layer (`commands/masterplan.md` § TaskCreate projection layer): mirrors plan tasks into the harness `TaskCreate` ledger as a derived one-way projection. `state.yml` remains canonical per CD-7.
- Per-transition `TaskUpdate` mirror at every Step C `state.yml` task transition (advance, wave dispatch, wave-member digest, `pending_retro`, `complete`, `blocked`).
- Drift recovery on rehydration entry (corrects TaskList toward `state.yml`).
- Codex hosts skip the projection entirely (gated on `codex_host_suppressed`).
- **Per-turn reminder suppression is partial:** transitions fire `TaskUpdate` only at transition points; idle turns between transitions can still emit the harness reminder. v4.1.1 closes this gap via per-state-write priming.
```

- [ ] **Step 4: Amend `bbe5a38`**

```bash
git add CHANGELOG.md
git commit --amend --no-edit
```

Verify:
```bash
git log --oneline -1
# expect: a new SHA (not bbe5a38) at HEAD, same commit subject as bbe5a38
git show --stat HEAD | head -20
# expect: CHANGELOG.md listed
git show HEAD -- CHANGELOG.md | grep -c "Per-turn reminder suppression is partial"
# expect: 1
```

- [ ] **Step 5: Record the new SHA**

Note the new HEAD SHA for Task 3.

---

## Task 3: Tag v4.1.0 locally (no push)

**Files:** none (git operation only)

- [ ] **Step 1: Tag the amended HEAD**

```bash
git tag -a v4.1.0 -m "v4.1.0 — TaskCreate projection (partial reminder suppression; v4.1.1 finishes the job)"
```

- [ ] **Step 2: Verify**

```bash
git tag --list 'v4.1.0'
# expect: v4.1.0
git show v4.1.0 --stat | head -5
# expect: tag annotation visible
```

- [ ] **Step 3: Do NOT push**

The tag stays local until the user explicitly authorizes `git push --tags`. Per project rule.

---

## Task 4: bin/masterplan-state.sh — add session-UUID helper

**Files:**
- Modify: `bin/masterplan-state.sh`

**Why:** `CLAUDE_SESSION_ID` is empirically unset in the runtime; need a UUID generated by the helper on first Step C entry. The orchestrator calls the helper; the helper is the single source of truth.

- [ ] **Step 1: Read current `bin/masterplan-state.sh` to find a sensible subcommand location**

Use Read. Locate the subcommand dispatch block (likely a `case "$1" in ... esac` near the top).

- [ ] **Step 2: Add `session-sig` subcommand**

Insert after the existing subcommand dispatch, before the final `*) usage` arm:

```bash
session-sig)
    # Print a session signature. Prefer CLAUDE_SESSION_ID if set; else
    # generate a v4 UUID. Used by the orchestrator to seed
    # state.yml.step_c_session_init_sha on first Step C entry.
    if [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
        printf '%s\n' "${CLAUDE_SESSION_ID}"
    elif command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr 'A-Z' 'a-z'
    elif [[ -r /proc/sys/kernel/random/uuid ]]; then
        cat /proc/sys/kernel/random/uuid
    else
        echo "session-sig: no uuid source available (need uuidgen or /proc/sys/kernel/random/uuid)" >&2
        exit 2
    fi
    ;;
```

- [ ] **Step 3: Update the usage block to mention `session-sig`**

Locate the usage/help text in `bin/masterplan-state.sh` (likely near the top, before the case dispatch). Add a one-liner:

```
  session-sig          Print a session signature (CLAUDE_SESSION_ID if set, else fresh UUID)
```

- [ ] **Step 4: Verify**

```bash
bash -n bin/masterplan-state.sh
# expect: clean (no syntax errors)
bin/masterplan-state.sh session-sig | wc -c
# expect: 37 (36 chars + newline) for a v4 UUID, OR the length of CLAUDE_SESSION_ID + 1
bin/masterplan-state.sh session-sig | grep -E '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^.+$' >/dev/null
# expect: exit 0 (matches v4 UUID format OR any non-empty string)
```

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-state.sh
git commit -m "Add masterplan-state.sh session-sig subcommand for v4.1.1 Step C entry"
```

---

## Task 5: bin/masterplan-state.sh — tolerate optional step_c_session_init_sha field

**Files:**
- Modify: `bin/masterplan-state.sh`

**Why:** the new optional field must not cause `doctor`, `transition-guard`, or other validators to fail when present (or when absent on legacy bundles).

- [ ] **Step 1: Read current validator logic**

Use Read on `bin/masterplan-state.sh`. Identify the schema validation block (look for `schema_version`, `current_task`, `phase` field checks).

- [ ] **Step 2: Add explicit allow-list entry for `step_c_session_init_sha`**

If the validator has a "known fields" allow-list (positive list), append `step_c_session_init_sha` to it. If it has a "required fields" check (positive list of required fields), do NOT add to that — the field is optional. Search for patterns like `known_fields=(` or `required_fields=(` to locate.

If the validator uses a deny-by-default scheme (rare), add `step_c_session_init_sha` to the allow list. If the validator uses an allow-by-default scheme (more likely — typical YAML readers just access keys), no change may be needed; verify by reading and adding a comment instead:

```bash
# step_c_session_init_sha (v4.1.1+): optional session-stable UUID used by
# the orchestrator's Step C entry hook. Absence is legal (legacy/first-entry).
```

- [ ] **Step 3: If a `doctor` check enumerates fields, ensure `step_c_session_init_sha` is in the optional list**

Search: `grep -n 'doctor\|check_\|validate_' bin/masterplan-state.sh`. If any check explicitly enumerates fields, ensure the new field is recognized.

- [ ] **Step 4: Verify**

```bash
bash -n bin/masterplan-state.sh
# expect: clean
# Smoke against an active bundle:
bin/masterplan-state.sh doctor docs/masterplan/v4-lifecycle-redesign 2>&1 | tail -20
# expect: no errors specifically about step_c_session_init_sha
# (the bundle is missing the field — that must be OK)
```

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-state.sh
git commit -m "Tolerate optional step_c_session_init_sha in masterplan-state.sh validators"
```

---

## Task 6: commands/masterplan.md — Step C entry hook split (create-once-per-session)

**Files:**
- Modify: `commands/masterplan.md` (around line 1376)

**Why:** addresses codex MEDIUM finding. Current line 1376 runs rehydration "once per session" — but only by skipping silently on the second entry, NOT by running drift-check. Spec calls for full rehydration on first entry + drift-check on subsequent entries within the same session.

- [ ] **Step 1: Read commands/masterplan.md offset 1370 limit 30**

Confirm current content matches the spec reference.

- [ ] **Step 2: Replace the "once per session" block**

Locate the paragraph that begins `**Rehydrate TaskCreate projection (Claude Code only — runs once per session).**` Replace the entire paragraph with:

```markdown
**Rehydrate or reconcile TaskCreate projection (Claude Code only — split by session signature).** Before entering the task loop, if `codex_host_suppressed == false`, branch on the new `state.step_c_session_init_sha` field:

1. **Compute current session signature** by shelling out: `current_sig=$(bin/masterplan-state.sh session-sig)`. This returns `${CLAUDE_SESSION_ID}` when set or a fresh v4 UUID otherwise. Do NOT read `CLAUDE_SESSION_ID` directly — the helper is the single source of truth.
2. **First entry of this session** (`state.step_c_session_init_sha == ""` OR `state.step_c_session_init_sha != current_sig`):
   - Run the full rehydration procedure from *TaskCreate projection layer — Rehydration trigger*.
   - Write `state.step_c_session_init_sha = current_sig` atomically with the rehydration write.
   - Append `step_c_init_complete` to `events.jsonl` with payload `{session_sig: <current_sig>, rehydrated: true}`.
   - Issue the per-state-write `TaskUpdate(current_task, status=in_progress)` touch per *Per-state-write priming* below.
3. **Subsequent entry in same session** (`state.step_c_session_init_sha == current_sig`):
   - Run *Drift recovery* per *TaskCreate projection layer — Drift recovery*, scoped to `current_task` alignment + status counts (`in_progress count == 1` mid-wave; `pending count > 0` if waves remain).
   - Append `step_c_drift_check_complete` to `events.jsonl` with payload `{session_sig: <current_sig>, drift_corrected: <bool>}`.
   - Issue the per-state-write `TaskUpdate(current_task, status=in_progress)` touch.

If `TaskCreate` / `TaskUpdate` dispatch errors at any point, append `taskcreate_mirror_failed` with the error string and proceed — `state.yml` is canonical and the next rehydration reconciles. Skip the entire block silently when `codex_host_suppressed == true`.
```

- [ ] **Step 3: Verify with grep discriminators**

```bash
# Positive: new branch logic present
grep -c "step_c_session_init_sha" commands/masterplan.md
# expect: >= 4 (3 in the new block + 1+ in per-state-write section once Task 7 lands)

grep -c "step_c_init_complete" commands/masterplan.md
# expect: >= 1

grep -c "step_c_drift_check_complete" commands/masterplan.md
# expect: >= 1

# Negative: old "once per session" wording removed
grep -c "rehydration procedure from \*TaskCreate projection layer \*\* Rehydration trigger\*\*\." commands/masterplan.md || true
# expect: 0 (the standalone "once per session" sentence)

grep -c "first Step C entry of the current session for this \`slug\`" commands/masterplan.md
# expect: 0 (old conditional gone)
```

- [ ] **Step 4: Commit**

```bash
git add commands/masterplan.md
git commit -m "Step C entry: split rehydration (first-entry) from drift-check (re-entry) by session signature"
```

---

## Task 7: commands/masterplan.md — per-state-write TaskUpdate touch (the new priming)

**Files:**
- Modify: `commands/masterplan.md` (around line 1378 and downstream state-write sites)

**Why:** this is the v4.1.1 mechanism — the touch that closes idle-turn gaps. Mechanism is additive to the existing per-transition mirror.

- [ ] **Step 1: Read commands/masterplan.md offset 1376 limit 25**

Confirm the line-1378 paragraph ("Mirror every state.yml task-transition to TaskList") still exists after Task 6's edit.

- [ ] **Step 2: Insert the per-state-write priming subsection AFTER the line-1378 paragraph**

Insert a new paragraph:

```markdown
**Per-state-write priming (v4.1.1, Claude Code only).** In addition to the per-transition mirror above, every Step C `state.yml` write — including writes that do NOT change `current_task` or wave state (e.g. `last_activity` bumps, `pending_gate` writes, `background` marker writes, `next_action` updates) — MUST be followed by:

```
if codex_host_suppressed == false AND state.current_task != "":
    TaskUpdate(task_id=<state.current_task's TaskList id>, status="in_progress")
```

This is an idempotent re-stamp; the task is already `in_progress` if the session is healthy. The purpose is to refresh the harness's recent-`Task*`-usage signal so the per-turn `<system-reminder>` is suppressed during idle-turn gaps between true transitions. The touch runs AFTER the `state.yml` write and AFTER the corresponding `events.jsonl` append. Failures append `taskcreate_mirror_failed` with `{call: "TaskUpdate-priming", task_idx, error}` and do NOT roll back the state write. Skip silently when `codex_host_suppressed == true` OR `current_task == ""` (between-task and pre-wave gaps).

The touch is **NOT** applied outside Step C (brainstorm, plan, halt-gate, doctor, import, audit, etc.) — those phases legitimately benefit from the harness reminder.
```

- [ ] **Step 3: Verify with grep discriminators**

```bash
# Positive: priming block present
grep -c "Per-state-write priming" commands/masterplan.md
# expect: 1

grep -c "TaskUpdate-priming" commands/masterplan.md
# expect: 1

grep -c "idempotent re-stamp" commands/masterplan.md
# expect: 1

# Positive: scope correctly limited to Step C
grep -c "NOT.* applied outside Step C" commands/masterplan.md
# expect: 1

# Negative: should not appear at brainstorm/plan/halt sections (sanity)
# (no negative grep here — scope is enforced by section placement)
```

- [ ] **Step 4: Commit**

```bash
git add commands/masterplan.md
git commit -m "Add per-state-write TaskUpdate priming for v4.1.1 reminder suppression"
```

---

## Task 8: docs/internals.md L291 — honest rewrite of projection section

**Files:**
- Modify: `docs/internals.md` (around line 287-294, the §3 v4.1.0 projection block)

**Why:** codex review specifically cited this paragraph's "makes that reminder a no-op" claim as inaccurate for v4.1.0.

- [ ] **Step 1: Read docs/internals.md offset 285 limit 15**

Confirm the current "Why" paragraph at L291.

- [ ] **Step 2: Rewrite the "Why" paragraph (L291 region)**

Replace:

```markdown
**Why:** the harness emits a `<system-reminder>` per turn nudging the orchestrator toward TaskCreate; left unaddressed it steals ~200 tokens/turn from Opus context. The projection makes that reminder a no-op and gives the user wave-progress visibility in the native task UI. See `commands/masterplan.md § TaskCreate projection layer` for schema, rehydration, drift, and event-type details.
```

with:

```markdown
**Why:** the harness emits a `<system-reminder>` per turn nudging the orchestrator toward TaskCreate; left unaddressed it steals ~200 tokens/turn from Opus context. The projection gives the user wave-progress visibility in the native task UI. v4.1.0 alone mirrors state-changes at task transitions, which suppresses the reminder on transition turns only; v4.1.1 extends the mechanism to per-state-write priming and a Step C create-once-per-session / reconcile-every-entry split that together suppress the reminder across idle-turn gaps within Step C. See `commands/masterplan.md § TaskCreate projection layer` for schema, rehydration, drift, and event-type details, and §12 v4.1.1 design rationale below for the priming-and-split mechanism.
```

- [ ] **Step 3: Verify**

```bash
grep -c "makes that reminder a no-op" docs/internals.md
# expect: 0 (inaccurate claim gone)

grep -c "v4.1.0 alone mirrors state-changes at task transitions" docs/internals.md
# expect: 1

grep -c "v4.1.1 extends the mechanism" docs/internals.md
# expect: 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/internals.md
git commit -m "internals: rewrite L291 projection 'why' honestly per codex review"
```

---

## Task 9: docs/internals.md §12 — add v4.1.1 design rationale subsection

**Files:**
- Modify: `docs/internals.md` (append to §12 or insert as a new §12 subsection)

**Why:** consolidate the v4.1.1 design rationale in one place that L291 can link forward to.

- [ ] **Step 1: Read docs/internals.md to locate §12**

Use Read on `docs/internals.md`. Find the heading for §12 (search for `## 12.` or `## Design decisions` or similar — current v4.0 block exists per the v4-lifecycle-redesign retro).

- [ ] **Step 2: Append the v4.1.1 subsection at the end of §12**

```markdown
### v4.1.1 — Verified reminder suppression + Step C entry split

**Mechanism (additive to v4.1.0).** v4.1.0 mirrors `state.yml` task-transitions to `TaskUpdate`. v4.1.1 adds two pieces:

1. **Per-state-write priming.** Every `state.yml` write within Step C (transition or not — `last_activity` bumps, `pending_gate` writes, `background` markers, `next_action` updates) is followed by an idempotent `TaskUpdate(current_task, status=in_progress)` re-stamp. This refreshes the harness's recent-`Task*`-usage signal across idle-turn gaps. Gated on `codex_host_suppressed == false` AND `current_task != ""`.
2. **Step C entry split.** New optional `state.yml` field `step_c_session_init_sha` (UUID from `bin/masterplan-state.sh session-sig`). First entry of a session: full rehydration + write the SHA. Subsequent entries in same session: drift-check only. Closes the codex MEDIUM finding that v4.1.0's "once per session" gate skipped drift recovery instead of running it.

**Empirical basis.** v4.1.0 was scoped to per-transition only because pre-ship smoke against `v4-lifecycle-redesign` showed the reminder fires on idle turns regardless of task existence — confirming the harness keys on recent `Task*` tool usage, not on task count or state. The v4.1.1 brainstorm session itself reproduced this twice in real-time (see `docs/masterplan/p4-suppression-fix/events.jsonl` — `empirical_observation_in_session` events).

**Verification gate.** v4.1.1 release is gated on a real-session smoke run against `docs/masterplan/p4-suppression-smoke/`. The bundle's `spec.md` encodes a per-turn `smoke_observation` event contract. Success: `reminder_fired == false` on every state-write turn within Step C. Failure routes to Option D rescope (idle-turn heartbeat) or to dropping the suppression claim.

**Scope discipline.** The priming touch is Step-C-only. Brainstorm, plan, halt-gate, doctor, import, and audit phases keep the harness reminder — it is appropriate context noise there. Codex hosts skip the entire projection (no `TaskCreate` / `TaskUpdate` calls).
```

- [ ] **Step 3: Verify**

```bash
grep -c "v4.1.1 — Verified reminder suppression" docs/internals.md
# expect: 1

grep -c "step_c_session_init_sha" docs/internals.md
# expect: >= 2

grep -c "Per-state-write priming" docs/internals.md
# expect: >= 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/internals.md
git commit -m "internals §12: add v4.1.1 design rationale subsection"
```

---

## Task 10: README.md — amend projection scope

**Files:**
- Modify: `README.md`

**Why:** README currently states the projection "silences the per-turn reminder" without scoping. Codex review flagged this. Should read "during Step C execution".

- [ ] **Step 1: Read README.md to find the projection description**

Use Read on `README.md`. Locate the v4.1.0 mention or the `TaskCreate projection` description.

- [ ] **Step 2: Amend the scope phrase**

Find phrases matching the patterns `silences the .*reminder` or `suppresses the .*reminder` or `makes .*reminder a no-op`. Replace each with: `suppresses the TaskCreate reminder during Step C execution`.

If the README has no such phrase yet (because the v4.1.0 README update was minimal), add one short line under the v4.1.0 / v4.1.1 mention summarizing the verified scope.

- [ ] **Step 3: Verify**

```bash
grep -c "during Step C execution" README.md
# expect: >= 1

grep -c "silences the .*reminder\|makes that reminder a no-op" README.md
# expect: 0 (unscoped claim gone)
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: scope TaskCreate reminder suppression to Step C execution"
```

---

## Task 11: Version bumps to 4.1.1

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.codex-plugin/plugin.json`

- [ ] **Step 1: Read both plugin.json files**

Use Read on `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.

- [ ] **Step 2: Bump version field from `4.1.0` to `4.1.1` in both**

Use Edit on each file, replacing the version string.

- [ ] **Step 3: Verify**

```bash
grep -c '"version": "4.1.1"' .claude-plugin/plugin.json .codex-plugin/plugin.json
# expect: each file reports 1
grep -c '"version": "4.1.0"' .claude-plugin/plugin.json .codex-plugin/plugin.json
# expect: each file reports 0
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .codex-plugin/plugin.json
git commit -m "Bump version to 4.1.1"
```

---

## Task 12: CHANGELOG.md — add v4.1.1 entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read CHANGELOG.md**

Use Read on `CHANGELOG.md`. Locate the top of the changelog (above v4.1.0).

- [ ] **Step 2: Insert v4.1.1 entry above v4.1.0**

```markdown
## v4.1.1 — Verified reminder suppression + Step C entry split

Addresses both findings from the codex adversarial review of v4.1.0 (commit `bbe5a38`).

- **Per-state-write `TaskUpdate` priming (HIGH).** Extends v4.1.0's per-transition mirror to every Step C `state.yml` write. Closes the idle-turn gap that left the harness reminder firing between task transitions. Mechanism is additive — v4.1.0's transition hooks remain unchanged. Gated on `codex_host_suppressed == false` AND `current_task != ""`.
- **Step C entry split (MEDIUM).** New optional `state.yml` field `step_c_session_init_sha` (UUID from `bin/masterplan-state.sh session-sig`). First entry per session: full rehydration. Subsequent entries in same session: drift-check (verify `current_task` alignment + status counts; correct via `TaskUpdate`). Closes the codex finding that v4.1.0 skipped drift recovery on re-entry.
- **`bin/masterplan-state.sh session-sig`** subcommand: returns `${CLAUDE_SESSION_ID}` if set, else a fresh v4 UUID. The orchestrator never reads the envvar directly.
- **Honest doc scope.** README amended: "suppresses the TaskCreate reminder during Step C execution". `docs/internals.md` L291 rewritten; §12 gains a v4.1.1 design-rationale subsection.
- **Verification.** Release gated on a real-session smoke run against `docs/masterplan/p4-suppression-smoke/`. The bundle's spec encodes a per-turn `smoke_observation` event contract; success criterion is `reminder_fired == false` on every state-write turn within Step C.

Codex hosts are unaffected — the entire projection layer (including the new priming touch) skips silently per the existing `codex_host_suppressed` gate.
```

- [ ] **Step 3: Verify**

```bash
grep -c "^## v4.1.1" CHANGELOG.md
# expect: 1

grep -c "smoke_observation" CHANGELOG.md
# expect: 1

# Ensure v4.1.1 appears ABOVE v4.1.0
awk '/^## v4\.1\.1/{a=NR} /^## v4\.1\.0/{b=NR} END{print (a<b && a>0)?"ok":"bad"}' CHANGELOG.md
# expect: ok
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "CHANGELOG: add v4.1.1 entry"
```

---

## Task 13: Manual smoke run (release-gating verification)

**Files:** none directly — this task is the manual gate that produces evidence in `docs/masterplan/p4-suppression-smoke/events.jsonl`.

**Why:** the spec's `smoke_observation` contract is the success criterion for the suppression claim. This task CANNOT run in the same orchestrator session that wrote the code — the smoke needs a fresh Claude Code session for the session-signature path to exercise.

**This task is performed by the user, with concrete instructions:**

- [ ] **Step 1: Verify all prior tasks are committed**

```bash
git status --short
# expect: empty (clean tree)
git log --oneline -12 | head -12
# expect: 12 commits matching the task order
```

- [ ] **Step 2: Push or stash nothing; instruct user to open a fresh Claude Code session**

User-facing instructions (the orchestrator MUST surface these via `AskUserQuestion`, not as a bare code block):

```
Open a fresh Claude Code session in this repo. Once it loads, send the message:

  Use masterplan execute docs/masterplan/p4-suppression-smoke/state.yml

That session will run Step C against the 3 no-op tasks. For every Step C turn it MUST append a `smoke_observation` event to docs/masterplan/p4-suppression-smoke/events.jsonl BEFORE any other event for that turn. The agent contract is encoded in docs/masterplan/p4-suppression-smoke/spec.md.

When the smoke run is done, return to THIS session and select "Smoke complete — paste results" so we can grade.
```

- [ ] **Step 3: Grade the smoke evidence**

After the user returns:

```bash
# Count Step C turns observed
grep -c '"event":"smoke_observation"' docs/masterplan/p4-suppression-smoke/events.jsonl
# expect: >= 3 (at minimum one per task; more if turns split)

# Count state-write turns where reminder fired (FAILURES)
grep '"event":"smoke_observation"' docs/masterplan/p4-suppression-smoke/events.jsonl \
  | grep '"preceding_state_write":true' \
  | grep -c '"reminder_fired":true'
# expect: 0 (the success criterion)
```

- [ ] **Step 4: Branch on outcome**

- **Failures == 0 (success):** proceed to Task 14 (release gate).
- **Failures >= 1:** STOP. Append `smoke_failed` to `docs/masterplan/p4-suppression-fix/events.jsonl` with the failing turn details. Activate the R1 Option D rescope branch:
  - Edit `commands/masterplan.md` to add an idle-turn `TaskUpdate` heartbeat at the top of each Step C turn-loop iteration that has NOT yet performed a state write.
  - Re-run Task 13 against a fresh `p4-suppression-smoke` (clear its `events.jsonl` first; bundle is reusable).
  - If Option D also fails: edit Task 12's CHANGELOG entry to drop the suppression claim entirely; restate v4.1.1 as "Step C entry split + honest docs only".

---

## Task 14: Release gate — tag v4.1.1 locally

**Files:** none (git operation only)

**Why:** locks v4.1.1 in git history. Push waits on explicit user authorization.

- [ ] **Step 1: Confirm Task 13 success**

Re-run the grade:

```bash
grep '"event":"smoke_observation"' docs/masterplan/p4-suppression-smoke/events.jsonl \
  | grep '"preceding_state_write":true' \
  | grep -c '"reminder_fired":true'
# expect: 0
```

If non-zero: STOP. Do not tag.

- [ ] **Step 2: Verify clean tree**

```bash
git status --short
# expect: empty
```

- [ ] **Step 3: Tag v4.1.1**

```bash
git tag -a v4.1.1 -m "v4.1.1 — Verified reminder suppression + Step C entry split (codex review of v4.1.0 addressed)"
git tag --list 'v4.1.0' 'v4.1.1'
# expect: both tags present, locally
```

- [ ] **Step 4: Do NOT push**

Tags stay local. The user must explicitly authorize `git push --tags` (and `git push` for the amended `bbe5a38`-equivalent + new commits) as a separate request. Per project rule.

- [ ] **Step 5: Surface to user via AskUserQuestion**

Options: (a) push v4.1.0 + v4.1.1 tags + main branch to origin, (b) hold local pending review, (c) revert v4.1.1 tag for further iteration.

---

## Self-review notes (post-write)

- **Spec coverage:** all 4 design decisions + 5 advisor refinements have at least one task. Touch mechanism = Task 7. Step C split = Tasks 4+5+6. Smoke = Tasks 1+13. Release-vehicle Option A amend = Task 2. R4 UUID fallback = Task 4. R1 Option D rescope = Task 13 Step 4 branch.
- **Project idiom:** all "tests" are grep / `bash -n` / manual smoke. No pytest/jest.
- **Order constraint:** smoke bundle scaffold (Task 1) precedes orchestrator edits (Tasks 6+7) so the user can run smoke immediately after edits land.
- **Git safety:** all operations local. `--amend` only on local commit `bbe5a38` (Task 2 has explicit safety check). No `--no-verify`. No force-push. No push at all without explicit user authorization (Tasks 3, 14).
- **Codex host:** every new mechanism gated on existing `codex_host_suppressed == false`. No new Codex code paths.

## Open questions surfaced during plan writing

None blocking. One soft note: the smoke bundle's 3 no-op tasks may not actually produce enough state-write turns to exercise the priming touch fully if each task completes in one transition. Mitigation: the smoke agent's contract requires `smoke_observation` on EVERY turn, so even single-turn tasks produce evidence. If empirical smoke output is too thin, the user can extend the smoke plan to 5+ tasks before re-running — no orchestrator change needed.
