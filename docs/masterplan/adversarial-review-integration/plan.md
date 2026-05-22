# Adversarial-Review Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `codex:adversarial-review` into masterplan's B2 (spec_approval) and B3 (plan_approval) gates so that specs and plans are automatically challenged before execution begins.

**Architecture:** Pure markdown edits across five files — no runtime code. Each gate gets an adversarial-review dispatch block inserted before the existing AUQ close-site. B2 runs foreground (blocking), B3 runs background (close-turn → wakeup → resume). Two new doctor checks validate config and gate-fire evidence post-hoc.

**Tech Stack:** Markdown, bash (grep discriminators), `bash -n` syntax check.

---

> **Note on check numbers:** Doctor checks #42 (Stale .lock file) and #43 (codex_review_coverage) already exist in `parts/doctor.md`. The spec incorrectly numbered the new checks #42 and #43. This plan uses **#44** (adversarial_review config valid) and **#45** (gate-fire audit) instead. Acceptance criteria in the spec that reference #42/#43 for adversarial-review should be read as #44/#45.

---

## File Map

| File | Change |
|---|---|
| `parts/step-0.md` | Add `--no-adversarial-review` to recognized flags table (line ~275, after `--no-archive`) |
| `docs/config-schema.md` | Add `adversarial_review: both` field before "Adding new keys" section |
| `parts/step-b.md` | (a) Insert B2 adversarial-review dispatch block before spec_approval AUQ; (b) Insert B3 background dispatch + resume block before plan_approval close-out gate |
| `parts/doctor.md` | Append Check #44 (config validity) and Check #45 (gate-fire audit) |
| `CHANGELOG.md` | Add v6.1.0 entry |

---

### Task 1: Fix spec check numbers and add --no-adversarial-review flag to step-0.md

**Codex:** ok
**parallel-group:** wave-1
**Files:**
- Modify: `docs/masterplan/adversarial-review-integration/spec.md`
- Modify: `parts/step-0.md`

- [ ] **Step 1: Verify current state — spec has wrong check numbers, step-0.md lacks the flag**

```bash
# Confirm spec references wrong check numbers
grep "Check #42\|Check #43" docs/masterplan/adversarial-review-integration/spec.md | head -5
# Expected: lines referencing adversarial-review for #42 and #43

# Confirm flag not yet in step-0.md
grep "no-adversarial-review" parts/step-0.md
# Expected: no output
```

- [ ] **Step 2: Fix spec.md check numbers from #42→#44 and #43→#45**

In `docs/masterplan/adversarial-review-integration/spec.md`, find the Doctor checks section and the Acceptance Criteria section. Replace every occurrence of `#42` (the adversarial-review config validity check) with `#44` and every occurrence of `#43` (the gate-fire audit check) with `#45`.

The section to update is under `### Doctor checks`:
```
**Check #42 — adversarial_review config valid:**
```
→ change to:
```
**Check #44 — adversarial_review config valid:**
```

And:
```
**Check #43 — adversarial review gate-fire audit:**
```
→ change to:
```
**Check #45 — adversarial review gate-fire audit:**
```

Also update the Acceptance Criteria items:
```
9. `/masterplan doctor` check #42 catches invalid `adversarial_review: sideways` config value (warns).
```
→ change to:
```
9. `/masterplan doctor` check #44 catches invalid `adversarial_review: sideways` config value (warns).
```

And in the Verification section:
```
# Doctor checks are present
grep -n "#42\|#43" parts/doctor.md
```
→ change to:
```
# Doctor checks are present
grep -n "#44\|#45" parts/doctor.md
```

- [ ] **Step 3: Add `--no-adversarial-review` flag to recognized flags table in parts/step-0.md**

Find the `--no-archive` row in the recognized flags table (line ~275):
```
| `--no-archive` | R | For manual `/masterplan retro`, write `retro.md` but skip Step R3.5's archive-state update |
```

Insert the new row immediately after that line:
```
| `--no-archive` | R | For manual `/masterplan retro`, write `retro.md` but skip Step R3.5's archive-state update |
| `--no-adversarial-review` | B | Disable adversarial-review dispatch at B2 and B3 for this run regardless of `config.adversarial_review`. Does not persist to `state.yml`. |
```

- [ ] **Step 4: Verify changes**

```bash
grep "no-adversarial-review" parts/step-0.md
# Expected: | `--no-adversarial-review` | B | Disable adversarial-review...

grep "Check #44" docs/masterplan/adversarial-review-integration/spec.md
# Expected: **Check #44 — adversarial_review config valid:**

grep "Check #42.*adversarial" docs/masterplan/adversarial-review-integration/spec.md
# Expected: no output (old reference replaced)
```

- [ ] **Step 5: Commit**

```bash
git add parts/step-0.md docs/masterplan/adversarial-review-integration/spec.md
git commit -m "feat(adversarial-review): add --no-adversarial-review flag to recognized flags; fix spec check numbers to #44/#45"
```

---

### Task 2: Add adversarial_review field to config-schema.md

**Codex:** ok
**parallel-group:** wave-1
**Files:**
- Modify: `docs/config-schema.md`

- [ ] **Step 1: Verify the field is not yet present**

```bash
grep "adversarial_review" docs/config-schema.md
# Expected: no output
```

- [ ] **Step 2: Locate insertion point**

The field should go before the `### Adding new keys` section at the end of the schema YAML block. Find the line:
```
### Adding new keys
```

Insert a new section immediately before that heading (after the `integrations:` block closing the YAML fence).

- [ ] **Step 3: Insert the adversarial_review field**

Find the closing ` ``` ` fence that ends the YAML schema block (the one right before `### Adding new keys`). Insert before that fence closing:

```yaml
# Adversarial-review integration (v6.1.0+)
# Run codex:adversarial-review at spec gate (B2) and/or plan gate (B3).
# `both` (default): run at B2 and B3.
# `spec`: run at B2 only.
# `plan`: run at B3 only.
# `off`: suppress all adversarial-review dispatch.
# Per-run override: --no-adversarial-review CLI flag.
adversarial_review: both   # off | spec | plan | both
```

The exact edit: locate the line `    slack:` ... `blocked_channel: null     # post here when critical_error...` block, then find the closing ` ``` ` that ends the YAML block. Insert the new block just before that closing fence.

- [ ] **Step 4: Verify**

```bash
grep "adversarial_review" docs/config-schema.md
# Expected: adversarial_review: both   # off | spec | plan | both

grep "off | spec | plan | both" docs/config-schema.md
# Expected: match on the adversarial_review line
```

- [ ] **Step 5: Commit**

```bash
git add docs/config-schema.md
git commit -m "feat(adversarial-review): add adversarial_review config field to schema (off|spec|plan|both, default both)"
```

---

### Task 3: Add B2 adversarial-review dispatch block to parts/step-b.md

**Codex:** ok
**parallel-group:** wave-1
**Files:**
- Modify: `parts/step-b.md`

- [ ] **Step 1: Verify B2 dispatch block not yet present**

```bash
grep "adversarial.review" parts/step-b.md
# Expected: no output
```

- [ ] **Step 2: Find the exact insertion anchor**

The insertion point is in the B1 re-engagement gate, in the `**Spec exists:**` case (item 4), right before the `halt_mode == none` spec_approval AUQ. Find this anchor text in step-b.md:

```
   - **`halt_mode == none`** (existing kickoff path, unchanged): <!-- Intentionally diverges from the L1360 plan_approval condition under loose autonomy: spec_approval still fires under `--autonomy=loose`, while plan_approval auto-approves. See CHANGELOG v4.2.0 for the rationale and doctor check #31 for the consistency audit. --> under `--autonomy != full`, persist `pending_gate` with `id: spec_approval`,
```

- [ ] **Step 3: Insert B2 adversarial-review dispatch block**

Insert the following block immediately before the `halt_mode == none` line (i.e., between the `append 'spec_written'` state-update text and the `halt_mode == none` bullet). The new text becomes a numbered sub-step 4b inserted between the `spec_written` append and the halt_mode routing:

After the line ending in `append \`spec_written\`; consult \`halt_mode\`.` (line ~199), add a new block:

```markdown
   **Adversarial review — spec gate (B2).** Before routing by `halt_mode`, run this block:
   1. **Enable check:** Resolve `config.adversarial_review` from merged config tiers (global `~/.masterplan.yaml` then repo `.masterplan.yaml`, last-writer wins). If `adversarial_review ∉ {both, spec}` OR `--no-adversarial-review` is set on this run → skip this block entirely (proceed to halt_mode routing below unchanged).
   2. **Locate companion.** In order:
      - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs`
      - `~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` (glob; pick highest semver if multiple)
      If neither path exists: append `{"event":"adversarial_review_skipped","gate":"spec_approval","reason":"companion_not_found","ts":"<now>"}` → skip to halt_mode routing unchanged. Never block the workflow over missing review infrastructure.
   3. **Run foreground review.** Append `{"event":"adversarial_review_started","gate":"spec_approval","ts":"<now>","artifact":"<slug>/spec.md"}`. Then run:
      ```bash
      node "<companion-path>" adversarial-review --scope working-tree --wait "focus on docs/masterplan/<slug>/spec.md"
      ```
      Capture full stdout+stderr as `review_output`.
   4. **Parse pass/fail.** If `review_output` matches `/\b(critical|fatal|serious|blocking|fundamental|wrong assumption)\b/i` → `review_result: fail`, `findings: review_output`. Otherwise → `review_result: pass`.
   5. **Append event.** `{"event":"adversarial_review_complete","gate":"spec_approval","result":"<pass|fail>","findings_chars":<N>,"ts":"<now>"}`.
   6. **Gate routing override (aggressive-loose + pass only).** If `autonomy == aggressive-loose` AND `review_result == pass`: skip the spec_approval AUQ, append `{"event":"spec_approval_auto_accepted","reason":"adversarial_review_passed","ts":"<now>"}`, clear `pending_gate`, → proceed directly to Step B2. Do NOT fire the AUQ. This is the only path that suppresses the gate; every other combination proceeds to halt_mode routing below.
   — (end adversarial review block; fall through to halt_mode routing for all non-auto-close cases)
```

Then, in the `halt_mode == none` branch where the spec_approval AUQ is surfaced, add a fifth option when `review_result == fail`. Find the existing AUQ options line:

```
surface `AskUserQuestion("Spec written at <path>. Ready for writing-plans?", options=[Approve and run writing-plans (Recommended) / Open spec to review first then ping me / Request changes — describe what to change / Abort kickoff])`.
```

Change to:

```
surface `AskUserQuestion("Spec written at <path>. Ready for writing-plans?", options=[Approve and run writing-plans (Recommended) / Open spec to review first then ping me / Request changes — describe what to change / Abort kickoff / (only when review_result==fail) View adversarial-review findings and decide — shows findings in option context; does not auto-approve])`.
```

- [ ] **Step 4: Verify B2 block present**

```bash
grep -c "adversarial_review_complete\|companion-path.*adversarial" parts/step-b.md
# Expected: 2 (one for each pattern)

grep "adversarial_review_started.*spec_approval" parts/step-b.md
# Expected: a match
```

- [ ] **Step 5: Commit**

```bash
git add parts/step-b.md
git commit -m "feat(adversarial-review): add B2 spec gate adversarial-review dispatch block (foreground, aggressive-loose auto-close)"
```

---

### Task 4: Add B3 adversarial-review background dispatch block to parts/step-b.md

**Codex:** ok
**parallel-group:** wave-2
**Files:**
- Modify: `parts/step-b.md`

> Depends on Task 3 (same file). Run after Task 3's commit.

- [ ] **Step 1: Verify Task 3 landed and B3 block not yet present**

```bash
grep "adversarial_review_started.*spec_approval" parts/step-b.md
# Expected: a match (Task 3 landed)

grep "adversarial_review_started.*plan_approval" parts/step-b.md
# Expected: no output (B3 block not yet there)
```

- [ ] **Step 2: Find the B3 insertion anchor**

In step-b.md, find the Step B2 re-engagement gate's success case where `plan_written` is appended:

```
3. **If plan exists** (the normal case): update `state.yml`: `phase: plan_gate`, `artifacts.plan: <config.runs_path>/<slug>/plan.md`, `current_task` = first task from the plan, `next_action` = first step of that task; append `plan_written`; proceed to Step B3 silently.
```

The B3 adversarial-review block goes between `append \`plan_written\`` and Step B3's close-out gate decision.

- [ ] **Step 3: Insert B3 adversarial-review background dispatch block**

After the `append \`plan_written\`; proceed to Step B3 silently.` line, and before the Step B3 `**Close-out gate.** Consult \`halt_mode\`:` section, insert:

```markdown
**Adversarial review — plan gate (B3).** After appending `plan_written` and before the B3 close-out gate:

1. **Enable check:** If `adversarial_review ∉ {both, plan}` OR `--no-adversarial-review` set → skip this block; proceed to B3 close-out gate unchanged.
2. **Locate companion.** Same two-path discovery as B2 spec gate above. If neither exists: append `{"event":"adversarial_review_skipped","gate":"plan_approval","reason":"companion_not_found","ts":"<now>"}` → proceed to B3 close-out gate unchanged.
3. **Launch background review.** Append `{"event":"adversarial_review_started","gate":"plan_approval","ts":"<now>","artifact":"<slug>/plan.md"}`. Persist `pending_gate: {id: adversarial_review_plan_pending}` to `state.yml`. Run:
   ```bash
   node "<companion-path>" adversarial-review --scope working-tree --background "focus on docs/masterplan/<slug>/plan.md"
   ```
4. **Close-turn with wakeup.** If `ScheduleWakeup` available: call `ScheduleWakeup(delaySeconds=120, prompt="/masterplan --resume=<state-path>", reason="Checking adversarial review result for <slug> plan gate")`. Set `stop_reason: scheduled_yield`, append `wakeup_scheduled` → CLOSE-TURN.
   If `ScheduleWakeup` unavailable: emit `<masterplan-trace gate=fire id=adversarial_review_plan_pending auq-options=2>` and surface `AskUserQuestion("Adversarial review running in background for <slug> plan gate.", options=["Poll now — check if review completed", "Resume later — run /masterplan when the review finishes"])`.
5. **On resume (wakeup or manual).** Check if background review process completed. If NOT complete: re-schedule wakeup (same parameters) → CLOSE-TURN. If complete: parse output with same pass/fail heuristic as B2. Append `{"event":"adversarial_review_complete","gate":"plan_approval","result":"<pass|fail>","findings_chars":<N>,"ts":"<now>"}`. Clear `pending_gate`. Proceed to B3 close-out gate.
6. **B3 close-out gate override (aggressive-loose + pass only).** If `autonomy == aggressive-loose` AND `review_result == pass`: append `{"event":"plan_approval_auto_accepted","reason":"adversarial_review_passed","ts":"<now>"}`, proceed directly to Step C. This adds to the existing loose-autonomy auto-approve path; the difference is that under `aggressive-loose`, the adversarial-review result gates auto-approval instead of auto-approving unconditionally.
   When `review_result == fail` (any autonomy level): surface `AskUserQuestion` with findings context before allowing execution to proceed. Prepend findings summary to the `halt_mode == none` question text.
```

- [ ] **Step 4: Verify B3 block present**

```bash
grep -c "adversarial_review_started.*plan_approval\|adversarial_review_plan_pending" parts/step-b.md
# Expected: 2

grep "adversarial-review --scope working-tree --background" parts/step-b.md
# Expected: a match

grep "adversarial-review --scope working-tree --wait" parts/step-b.md
# Expected: a match (B2 foreground from Task 3)
```

- [ ] **Step 5: Commit**

```bash
git add parts/step-b.md
git commit -m "feat(adversarial-review): add B3 plan gate adversarial-review background dispatch + resume logic"
```

---

### Task 5: Add doctor checks #44 and #45 to parts/doctor.md

**Codex:** ok
**parallel-group:** wave-1
**Files:**
- Modify: `parts/doctor.md`

- [ ] **Step 1: Verify checks not yet present**

```bash
grep "Check #44\|Check #45" parts/doctor.md
# Expected: no output
```

- [ ] **Step 2: Find the end of doctor.md**

The last check (#43, codex_review_coverage) ends without a trailing `---`. Append after the last line of doctor.md.

- [ ] **Step 3: Append check #44 (adversarial_review config valid)**

Append to the end of `parts/doctor.md`:

```markdown

---

## Check #44 — `adversarial_review` config valid

**Severity:** Warning
**Action:** Report-only; no auto-fix. Invalid values must be corrected by the user.
**Scope:** Global (config tiers only — not per-plan).
**Added:** v6.1.0 (adversarial-review-integration).

If the `adversarial_review` key is present in any config tier (`~/.masterplan.yaml` or `.masterplan.yaml`), its value must be one of `off`, `spec`, `plan`, or `both`. Any other value is flagged.

```bash
fail=0
for cfg in "$HOME/.masterplan.yaml" ".masterplan.yaml"; do
  [ -r "$cfg" ] || continue
  val="$(grep -E '^adversarial_review:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' | tr -d "'")"
  [ -z "$val" ] && continue
  case "$val" in
    off|spec|plan|both) ;;
    *)
      echo "WARN $cfg: adversarial_review: \"$val\" — must be off|spec|plan|both"
      fail=1
      ;;
  esac
done
[ $fail -eq 0 ] && echo "Check #44: PASS" || echo "Check #44: WARN"
```

Report-only.

---

## Check #45 — Adversarial review gate-fire audit

**Severity:** Info (skipped for bundles with fewer than 2 events or status != complete)
**Action:** Report-only; informational only. Historical bundles predating v6.1.0 will always show INFO.
**Scope:** Plan-scoped (per-plan; applies to completed bundles only).
**Added:** v6.1.0 (adversarial-review-integration).

For each completed bundle where `config.adversarial_review != off` (resolved from merged config tiers at check time — not from state.yml), verify that `events.jsonl` contains at least one `adversarial_review_complete` event with `gate: spec_approval` and one with `gate: plan_approval`. If missing, emit INFO. Bundles predating v6.1.0 will always fire INFO — this is expected and not a regression.

```bash
for state_yml in docs/masterplan/*/state.yml; do
  run_dir="$(dirname "$state_yml")"
  slug="$(basename "$run_dir")"
  events="$run_dir/events.jsonl"
  status="$(grep -E '^status:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$status" = "complete" ] || continue
  [ -r "$events" ] || continue
  event_count="$(wc -l < "$events" 2>/dev/null)"
  [ "${event_count:-0}" -lt 2 ] && continue

  # Resolve adversarial_review from config (global then repo, last-writer wins)
  ar_val="both"  # built-in default
  for cfg in "$HOME/.masterplan.yaml" ".masterplan.yaml"; do
    [ -r "$cfg" ] || continue
    v="$(grep -E '^adversarial_review:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' | tr -d "'")"
    [ -n "$v" ] && ar_val="$v"
  done
  [ "$ar_val" = "off" ] && continue

  spec_fire="$(grep -c '"adversarial_review_complete"' "$events" 2>/dev/null | tr -d ' ')"
  spec_gate_fire="$(grep '"gate".*"spec_approval"' "$events" 2>/dev/null | grep -c 'adversarial_review_complete' 2>/dev/null || echo 0)"
  plan_gate_fire="$(grep '"gate".*"plan_approval"' "$events" 2>/dev/null | grep -c 'adversarial_review_complete' 2>/dev/null || echo 0)"

  if [ "${spec_gate_fire:-0}" -eq 0 ] || [ "${plan_gate_fire:-0}" -eq 0 ]; then
    echo "INFO $slug: adversarial_review=$ar_val, status=complete — adversarial_review_complete event(s) missing for: $([ "${spec_gate_fire:-0}" -eq 0 ] && echo 'spec_approval ') $([ "${plan_gate_fire:-0}" -eq 0 ] && echo 'plan_approval'). Bundle predates v6.1.0 or review was skipped."
  fi
done
echo "Check #45: INFO (historical audit — see per-bundle lines above for details)"
```

Report-only. Expected to fire on all bundles created before v6.1.0.
```

- [ ] **Step 4: Verify checks appended correctly**

```bash
grep "Check #44\|Check #45" parts/doctor.md
# Expected: two lines — Check #44 header and Check #45 header

grep "adversarial_review_complete.*gate.*spec_approval\|gate.*plan_approval.*adversarial" parts/doctor.md
# Expected: match (in the check #45 bash script)

grep "off|spec|plan|both" parts/doctor.md
# Expected: match (in check #44 case statement)
```

- [ ] **Step 5: Syntax check (telemetry hook unchanged but verify)**

```bash
bash -n hooks/masterplan-telemetry.sh
# Expected: silent (exit 0)
```

- [ ] **Step 6: Commit**

```bash
git add parts/doctor.md
git commit -m "feat(adversarial-review): add doctor checks #44 (config valid) and #45 (gate-fire audit)"
```

---

### Task 6: Add v6.1.0 CHANGELOG entry

**Codex:** ok
**parallel-group:** wave-2
**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Verify v6.1.0 entry not present**

```bash
grep "6.1.0" CHANGELOG.md
# Expected: no output
```

- [ ] **Step 2: Insert v6.1.0 entry before existing [6.0.1] entry**

Find the `## [6.0.1] — 2026-05-22` line near the top of CHANGELOG.md. Insert the new v6.1.0 entry immediately before it:

```markdown
## [6.1.0] — 2026-05-22

### Added

- **Adversarial-review integration at B2 and B3 gates:** `codex:adversarial-review` now runs automatically at the spec gate (B2, foreground) and plan gate (B3, background) before the respective approval AUQs fire. Findings surface as a fifth AUQ option; a failing review always fires the AUQ regardless of autonomy level.
- **`aggressive-loose` autonomy auto-close:** Under `autonomy: aggressive-loose`, a passing adversarial review auto-closes the spec_approval and plan_approval gates without an AUQ (reviewer-PASS IS the approval).
- **`adversarial_review` config field:** New config key `adversarial_review: both` (default). Values: `off | spec | plan | both`. Controls which gates dispatch the review.
- **`--no-adversarial-review` CLI flag:** Suppresses adversarial-review dispatch for one run without changing config. Documented in step-0.md recognized flags table.
- **Doctor check #44 — `adversarial_review` config valid:** Warns when any config tier sets `adversarial_review` to an unrecognized value.
- **Doctor check #45 — gate-fire audit:** Info check on completed bundles; verifies `adversarial_review_complete` events exist for spec_approval and plan_approval gates. Expected to fire INFO on all pre-v6.1.0 bundles.

```

- [ ] **Step 3: Verify**

```bash
grep "6.1.0" CHANGELOG.md
# Expected: ## [6.1.0] — 2026-05-22

grep "adversarial.review" CHANGELOG.md
# Expected: multiple matches (new entry lines)
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore(changelog): add v6.1.0 entry for adversarial-review integration"
```

---

### Task 7: Final verification pass

**Codex:** no
**parallel-group:** wave-3
**Files:** (read-only verification)

- [ ] **Step 1: Run all spec verification discriminators**

```bash
# Positive discriminator — step-b.md has adversarial-review dispatch (both B2 foreground and B3 background)
echo "=== B2 dispatch ==="
grep -n "adversarial-review --scope working-tree --wait" parts/step-b.md
# Expected: 1 match

echo "=== B3 dispatch ==="
grep -n "adversarial-review --scope working-tree --background" parts/step-b.md
# Expected: 1 match

echo "=== CLI flag registered ==="
grep -n "no-adversarial-review" parts/step-0.md
# Expected: 1 match

echo "=== Config schema documents the field ==="
grep "adversarial_review" docs/config-schema.md
# Expected: adversarial_review: both   # off | spec | plan | both

echo "=== Doctor checks are present ==="
grep -n "Check #44\|Check #45" parts/doctor.md
# Expected: 2 matches

echo "=== CHANGELOG updated ==="
grep "adversarial.review" CHANGELOG.md
# Expected: multiple matches

echo "=== Syntax check ==="
bash -n hooks/masterplan-telemetry.sh
# Expected: silent exit 0

echo "=== Events have companion path in B2 and B3 ==="
grep -c "codex-companion.mjs" parts/step-b.md
# Expected: 2 (one per gate)
```

- [ ] **Step 2: Check for leftover spec references to old check numbers**

```bash
grep "Check #42.*adversarial\|Check #43.*adversarial\|adversarial.*#42\|adversarial.*#43" docs/masterplan/adversarial-review-integration/spec.md
# Expected: no output (all replaced with #44/#45)
```

- [ ] **Step 3: Confirm B3 background flow has resume logic**

```bash
grep "adversarial_review_plan_pending\|On resume.*wakeup or manual" parts/step-b.md
# Expected: 2 matches
```

- [ ] **Step 4: Commit state update**

```bash
# Update bundle state to reflect plan complete
# (orchestrator writes this; if executing inline, update manually)
git add docs/masterplan/adversarial-review-integration/
git commit -m "masterplan: plan written for adversarial-review-integration"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| B2 foreground adversarial-review before spec_approval AUQ | Task 3 |
| B3 background adversarial-review before plan_approval gate | Task 4 |
| aggressive-loose + pass → auto-close spec_approval | Task 3 (step 3 gate routing) |
| aggressive-loose + pass → auto-close plan_approval | Task 4 (step 6) |
| loose + fail → AUQ with findings option | Tasks 3 and 4 |
| config `adversarial_review: off\|spec\|plan\|both` | Task 2 |
| `--no-adversarial-review` CLI flag | Task 1 |
| B2 foreground (`--wait`) | Task 3 |
| B3 background (`--background`) | Task 4 |
| Companion path discovery (marketplace → cache glob) | Tasks 3 and 4 (inline in step-b.md block) |
| Companion not found → skip, never block | Tasks 3 and 4 |
| Pass/fail heuristic (`critical\|fatal\|...\b`) | Tasks 3 and 4 |
| `adversarial_review_started` event | Tasks 3 and 4 |
| `adversarial_review_complete` event | Tasks 3 and 4 |
| `adversarial_review_skipped` event | Tasks 3 and 4 |
| Doctor check config validity (originally #42, now #44) | Task 5 |
| Doctor check gate-fire audit (originally #43, now #45) | Task 5 |
| CHANGELOG v6.1.0 | Task 6 |

All spec requirements covered. Check number discrepancy (#42/#43 vs #44/#45) documented in plan header and corrected in spec.md via Task 1.
