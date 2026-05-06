# Auto-compact nudge fixes (v2.9.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the auto-compact nudge's misleading "in another shell or session" wording, add a config validator that prevents silent degrade-to-dynamic-mode, and add doctor check #26 to verify a `/compact` cron is actually attached when nudged. Ship as v2.9.1 patch.

**Architecture:** All edits are to the markdown orchestrator prompt at `commands/masterplan.md` plus the plugin manifests + CHANGELOG. There is no source code. Verification is grep-based: each task confirms exact text presence/absence before and after the edit. Commits are per-task to keep diffs focused.

**Tech Stack:** markdown prompt orchestrator, JSON manifests (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), git.

**Spec:** `docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md` (committed as `2fb872c`).

---

## File Structure

| File | Change | Why |
|---|---|---|
| `commands/masterplan.md:606` | Replace nudge text (one block) | Wording fix (Spec Change 1) |
| `commands/masterplan.md:30-31` | Append validator bullet under existing flag-conflict warnings | Validator (Spec Change 2) |
| `commands/masterplan.md:~1501` | Append new doctor table row for #26 | Doctor check (Spec Change 3) |
| `commands/masterplan.md:1460` | Adjust parallelization-brief wording (repo-scoped checks #25 + #26) | Anti-pattern #4 sync |
| `.claude-plugin/plugin.json` | `"version": "2.9.0"` → `"2.9.1"` | Plugin manifest |
| `.claude-plugin/marketplace.json` | `"version": "2.9.0"` → `"2.9.1"` (two occurrences) | Marketplace catalog |
| `CHANGELOG.md` | Prepend v2.9.1 section | Release notes |
| `WORKLOG.md` | Append dated entry | Per-repo handoff convention |

The orchestrator file is the dominant change surface. Each subsequent task makes a focused, independently-verifiable edit.

---

## Task 1: Wording fix — Step B3 / Step C step 1 nudge text

**Files:**
- Modify: `commands/masterplan.md:606`

- [ ] **Step 1: Pre-edit grep — confirm current backward wording exists**

```bash
grep -nF "in another shell or session for automatic context compaction" commands/masterplan.md
```

Expected: exactly 1 match at line 606.

- [ ] **Step 2: Apply the wording change**

Use Edit tool with these exact strings:

```
old_string:
> *(Recommended: pair this run with `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` in another shell or session for automatic context compaction. Set `auto_compact.enabled: false` in `.masterplan.yaml` to silence this notice.)*

new_string:
> *(Recommended: pair this run with `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` in this same session. Note: this fires `/compact` every {config.auto_compact.interval} regardless of current context size, which may run unnecessary compactions on shorter plans. Set `auto_compact.enabled: false` in `.masterplan.yaml` to silence; consider `60m` or `90m` via `auto_compact.interval` for reduced waste.)*
```

- [ ] **Step 3: Post-edit grep — verify the change landed and the old text is gone**

```bash
grep -cF "in another shell or session" commands/masterplan.md
grep -cF "in this same session" commands/masterplan.md
grep -cF "regardless of current context size" commands/masterplan.md
grep -cF "60m\` or \`90m\`" commands/masterplan.md
```

Expected:
- `in another shell or session`: **0**
- `in this same session`: **1** (or more if existing text already used the phrase elsewhere — accept any non-zero)
- `regardless of current context size`: **1**
- `` `60m` or `90m` ``: **1**

If `in this same session` was already used elsewhere in the file, do a more targeted grep to confirm THE NUDGE LINE specifically has the new text:

```bash
grep -F "regardless of current context size, which may run unnecessary compactions" commands/masterplan.md
```

Expected: 1 match (the nudge line at ~606).

- [ ] **Step 4: Commit**

```bash
git add commands/masterplan.md
git commit -m "$(cat <<'EOF'
fix(orchestrator): #v2.9.1 auto-compact nudge wording

Replace "in another shell or session" — which was backward, since
CronCreate jobs are session-scoped and the cron fires into the
session that created it — with "in this same session". Also disclose
the unconditional-firing tradeoff (every N min regardless of context
size) so users on shorter plans can self-select longer intervals or
opt out.

Spec: docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Config validator — Step 0 flag-conflict warning

**Files:**
- Modify: `commands/masterplan.md:30-31` (append a bullet under existing flag-conflict warnings)

- [ ] **Step 1: Pre-edit grep — locate the existing warning anchor**

```bash
grep -n "Flag-conflict warnings\|codex_routing == off.*codex_review == on" commands/masterplan.md | head -5
```

Expected: line 29 starts `5. **Flag-conflict warnings.** ...`; line 30 has the `codex_routing == off` bullet. The new bullet appends after line 30.

- [ ] **Step 2: Pre-edit grep — confirm the new validator text is not yet present**

```bash
grep -cF "auto_compact_nudge_suppressed" commands/masterplan.md
grep -cF "auto_compact.interval is empty" commands/masterplan.md
```

Expected: both `0`.

- [ ] **Step 3: Apply the edit**

Use Edit tool. The existing bullet ends with a period and a newline. Append the new bullet on the next line.

```
old_string:
   - `codex_routing == off` AND `codex_review == on` — review will not fire; the flag is ignored for this run.

new_string:
   - `codex_routing == off` AND `codex_review == on` — review will not fire; the flag is ignored for this run.
   - `auto_compact.enabled == true` AND `auto_compact.interval` is empty/null/missing — the substituted command would degrade to dynamic-mode `/loop` (no interval) which routes through `ScheduleWakeup` and cannot fire built-in `/compact`. Set in-memory `auto_compact_nudge_suppressed: true` (read by the Step B3 / Step C step 1 nudge logic to skip rendering this run) and emit: *"⚠️ auto_compact.enabled is true but auto_compact.interval is empty — auto-compact nudge skipped. Set a non-empty interval (e.g. `\"30m\"`) to re-enable."*
```

- [ ] **Step 4: Wire the suppression flag into the nudge logic at line 605**

The Step B3 nudge condition currently reads `If config.auto_compact.enabled && compact_loop_recommended == false`. It must also check the suppression flag.

```bash
grep -nF "If \`config.auto_compact.enabled && compact_loop_recommended == false\`" commands/masterplan.md
```

Expected: 1 match at line 605.

Use Edit tool:

```
old_string:
**Auto-compact nudge** (fires once per plan; respects `config.auto_compact.enabled`). If `config.auto_compact.enabled && compact_loop_recommended == false`, output one passive notice immediately before the kickoff approval prompt below:

new_string:
**Auto-compact nudge** (fires once per plan; respects `config.auto_compact.enabled`). If `config.auto_compact.enabled && compact_loop_recommended == false && !auto_compact_nudge_suppressed`, output one passive notice immediately before the kickoff approval prompt below:
```

Repeat for the resume site:

```bash
grep -n "Auto-compact nudge (resume)" commands/masterplan.md
```

Expected: 1 match at line 769.

```
old_string:
   **Auto-compact nudge (resume).** If `config.auto_compact.enabled && compact_loop_recommended == false`, output the same one-line passive notice as Step B3, then flip `compact_loop_recommended: true` in the status file.

new_string:
   **Auto-compact nudge (resume).** If `config.auto_compact.enabled && compact_loop_recommended == false && !auto_compact_nudge_suppressed`, output the same one-line passive notice as Step B3, then flip `compact_loop_recommended: true` in the status file.
```

- [ ] **Step 5: Post-edit grep — verify all three references are wired**

```bash
grep -c "auto_compact_nudge_suppressed" commands/masterplan.md
```

Expected: **3** (validator definition + Step B3 condition + Step C step 1 condition).

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "$(cat <<'EOF'
feat(orchestrator): #v2.9.1 validate auto_compact.interval

Catch the silent degrade-to-dynamic-mode case at config-load time.
When auto_compact.enabled is true but auto_compact.interval is
empty/null, the substituted /loop command would have no interval
and route through ScheduleWakeup, which cannot fire built-in
/compact. Set in-memory auto_compact_nudge_suppressed flag, skip
the nudge for this run, warn the user.

Spec: docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Doctor check #26 — `auto_compact_loop_attached`

**Files:**
- Modify: `commands/masterplan.md` (insert new row in the doctor checks table after row #25)

- [ ] **Step 1: Pre-edit grep — locate the table boundary and confirm #26 is unused**

```bash
grep -nE "^\| 25 \|" commands/masterplan.md
grep -cE "^\| 26 \|" commands/masterplan.md
grep -nE "auto_compact_loop_attached" commands/masterplan.md
```

Expected:
- Row #25 found (1 match around line 1501).
- Row #26 absent (`0`).
- `auto_compact_loop_attached` absent (`0`).

- [ ] **Step 2: Read the row #25 line in full to anchor the insertion**

Use the Read tool on `commands/masterplan.md` at offset 1501, limit 5. Capture the exact line ending of row #25 — it ends with `|` after the action column.

- [ ] **Step 3: Apply the edit — append row #26 immediately after row #25**

Use Edit tool. Identify the end of row #25 (terminating `|`) and append a newline + the new row.

```
old_string:
| 25 | **Self-host deployment drift** (v2.9.0+; **repo-scoped** — fires once per doctor run, NOT per plan). Skipped silently when `git config --get remote.origin.url` does not match `superpowers-masterplan` (this check only fires inside this repo). Otherwise compares md5 of three runtime files the user's Claude Code session loads against the project HEAD: (a) `~/.claude/commands/masterplan.md` vs `<repo-root>/commands/masterplan.md`; (b) `~/.claude/hooks/masterplan-telemetry.sh` vs `<repo-root>/hooks/masterplan-telemetry.sh`; (c) `~/.claude/bin/masterplan-routing-stats.sh` vs `<repo-root>/bin/masterplan-routing-stats.sh`. Each file flagged when md5 differs OR the user-level file is missing AND the plugin is NOT registered in `~/.claude/plugins/installed_plugins.json` (plugin install replaces the legacy file path entirely; absence is correct in that case). Indicates a fix that shipped in the project repo but never reached the user's loaded slash command, hook, or stats script — the recurring deployment-drift bug pattern that prompted v2.9.0. Concrete recurrence in the v2.8.0 release session: ~593 lines of fixes shipped across v2.0.0 → v2.8.0 (model-passthrough contract from v2.0.0/v2.3.0, per-subagent JSONL emitter from v2.3.0/v2.4.0, `/masterplan stats` verb from v2.4.0, doctor check #23 from v2.8.0) sat at HEAD in `commands/masterplan.md` and `hooks/masterplan-telemetry.sh` while the user's runtime kept loading pre-v2.0 manual-copy files at `~/.claude/commands/masterplan.md` and `~/.claude/hooks/masterplan-telemetry.sh`. The bin/ stats script never even existed at the user level. Drift on any of the three files surfaces as a finding under this check. | Warning | `--fix`: per-file, backup user-level as `<path>.bak-pre-<utc-ts>` then `cp` project HEAD over it; `chmod +x` for the hook + bin script; re-compute md5 + verify match; mkdir `~/.claude/bin/` if absent. Only syncs the files that actually drifted. No-`--fix`: list each drifted/missing file with both md5s and a one-line `cp` command suggestion. The reason this is repo-scoped (not plan-scoped) is the failure mode is at the runtime-deployment layer, not at any single plan's state. |

new_string:
| 25 | **Self-host deployment drift** (v2.9.0+; **repo-scoped** — fires once per doctor run, NOT per plan). Skipped silently when `git config --get remote.origin.url` does not match `superpowers-masterplan` (this check only fires inside this repo). Otherwise compares md5 of three runtime files the user's Claude Code session loads against the project HEAD: (a) `~/.claude/commands/masterplan.md` vs `<repo-root>/commands/masterplan.md`; (b) `~/.claude/hooks/masterplan-telemetry.sh` vs `<repo-root>/hooks/masterplan-telemetry.sh`; (c) `~/.claude/bin/masterplan-routing-stats.sh` vs `<repo-root>/bin/masterplan-routing-stats.sh`. Each file flagged when md5 differs OR the user-level file is missing AND the plugin is NOT registered in `~/.claude/plugins/installed_plugins.json` (plugin install replaces the legacy file path entirely; absence is correct in that case). Indicates a fix that shipped in the project repo but never reached the user's loaded slash command, hook, or stats script — the recurring deployment-drift bug pattern that prompted v2.9.0. Concrete recurrence in the v2.8.0 release session: ~593 lines of fixes shipped across v2.0.0 → v2.8.0 (model-passthrough contract from v2.0.0/v2.3.0, per-subagent JSONL emitter from v2.3.0/v2.4.0, `/masterplan stats` verb from v2.4.0, doctor check #23 from v2.8.0) sat at HEAD in `commands/masterplan.md` and `hooks/masterplan-telemetry.sh` while the user's runtime kept loading pre-v2.0 manual-copy files at `~/.claude/commands/masterplan.md` and `~/.claude/hooks/masterplan-telemetry.sh`. The bin/ stats script never even existed at the user level. Drift on any of the three files surfaces as a finding under this check. | Warning | `--fix`: per-file, backup user-level as `<path>.bak-pre-<utc-ts>` then `cp` project HEAD over it; `chmod +x` for the hook + bin script; re-compute md5 + verify match; mkdir `~/.claude/bin/` if absent. Only syncs the files that actually drifted. No-`--fix`: list each drifted/missing file with both md5s and a one-line `cp` command suggestion. The reason this is repo-scoped (not plan-scoped) is the failure mode is at the runtime-deployment layer, not at any single plan's state. |
| 26 | **`auto_compact_loop_attached`** (v2.9.1+; **repo-scoped** — fires once per doctor run, NOT per plan). Skipped silently when `config.auto_compact.enabled == false` after Step 0 merge, or when no plan in `docs/superpowers/plans/*-status.md` has `compact_loop_recommended: true`. Otherwise calls `ToolSearch(query="select:CronList")` to load the deferred-tool schema (mirrors the competing-scheduler pattern at line 803 — silent skip with a one-line note if `CronList` is unavailable in this session). Calls `CronList()` and filters returned entries for any whose `prompt` field contains the substring `/compact` (case-sensitive). Zero matches indicates the user saw the auto-compact nudge for one or more plans but did not run `/loop … /compact …` in this session — a likely user error (ran the loop in a different shell, or copy-pasted into the wrong terminal). | Warning | No `--fix` available — the resolution is for the user to run the loop in this session, and an automated fix would risk creating multiple competing crons. Report includes the exact copy-pasteable command derived from current config: `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}`, plus the list of plan slugs whose status files have `compact_loop_recommended: true`. Suggest setting `auto_compact.enabled: false` to silence the nudge if the user intentionally opted out. |
```

- [ ] **Step 4: Update the parallelization brief at line 1460 — repo-scoped checks #25 + #26**

```bash
grep -n "Repo-scoped check #25" commands/masterplan.md
```

Expected: 1 match at line 1460.

```
old_string:
Repo-scoped check #25 (self-host deployment drift, v2.9.0+) fires ONCE per doctor run regardless of worktree/plan count and runs inline at the orchestrator (its inputs are user-level paths + the current repo's HEAD files, not per-plan state).

new_string:
Repo-scoped checks #25 (self-host deployment drift, v2.9.0+) and #26 (`auto_compact_loop_attached`, v2.9.1+) fire ONCE per doctor run regardless of worktree/plan count and run inline at the orchestrator. Their inputs are session-level state (user-level paths + repo HEAD for #25; `CronList` output for #26), not per-plan state. The plan-scoped check count (24) is unchanged.
```

- [ ] **Step 5: Post-edit verification grep**

```bash
grep -cE "^\| 26 \|" commands/masterplan.md
grep -c "auto_compact_loop_attached" commands/masterplan.md
grep -c "Repo-scoped checks #25.*and #26" commands/masterplan.md
```

Expected:
- Row #26: **1**
- `auto_compact_loop_attached` total occurrences: **2** (table row + parallelization brief)
- Repo-scoped wording: **1**

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "$(cat <<'EOF'
feat(doctor): #26 auto_compact_loop_attached

Verify a /compact cron is attached to the current session when one
or more plans were nudged to enable /loop /compact and
auto_compact.enabled is on. Repo-scoped (runs once per doctor
invocation), Warning severity, no auto-fix (resolution is user-only
— automated would risk competing crons). Surfaces the user error of
running /loop in the wrong shell.

Spec: docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Version bumps + CHANGELOG entry + WORKLOG entry

**Files:**
- Modify: `.claude-plugin/plugin.json` (version field)
- Modify: `.claude-plugin/marketplace.json` (two version fields)
- Modify: `CHANGELOG.md` (prepend v2.9.1 section)
- Modify: `WORKLOG.md` (append dated entry — note: ignored by git per `7dbd409`, edit anyway for local handoff)

- [ ] **Step 1: Pre-edit grep — confirm current version is 2.9.0**

```bash
grep '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
```

Expected: all matches show `"2.9.0"`.

- [ ] **Step 2: Bump plugin.json**

```
old_string:
  "version": "2.9.0",

new_string:
  "version": "2.9.1",
```

(In `.claude-plugin/plugin.json`. There is exactly one occurrence.)

- [ ] **Step 3: Bump marketplace.json (two occurrences — top-level and inside `plugins[0]`)**

`.claude-plugin/marketplace.json` has the version twice. Use Edit with `replace_all: true`.

```
old_string: "version": "2.9.0"
new_string: "version": "2.9.1"
replace_all: true
```

Verify both changed:

```bash
grep '"version"' .claude-plugin/marketplace.json
```

Expected: 2 lines, both `"2.9.1"`.

- [ ] **Step 4: Prepend CHANGELOG.md entry**

Read the first ~30 lines of CHANGELOG.md to find the existing v2.9.0 entry's heading style, then prepend a v2.9.1 section above it. The new section should follow this template (adapt punctuation/heading style to whatever the existing CHANGELOG uses):

```markdown
## v2.9.1 — 2026-05-06 — auto-compact nudge fixes

### Fixed

- **Auto-compact nudge wording.** The kickoff/resume nudge previously advised running `/loop … /compact …` "in another shell or session" — backward, since `CronCreate` jobs are session-scoped and the cron fires into the session that *created* it. Reworded to "in this same session" and added disclosure of the unconditional-firing tradeoff so users on shorter plans can self-select longer intervals or opt out via `auto_compact.enabled: false`.

### Added

- **Config validator** for `auto_compact.interval` empty/null when `auto_compact.enabled == true`. Prevents the silent degrade-to-dynamic-mode failure (no-interval `/loop` routes through `ScheduleWakeup`, which cannot fire built-in `/compact`). Skips the nudge for this run and warns.
- **Doctor check #26** `auto_compact_loop_attached`. Verifies a `/compact` cron is actually attached to the current session when one or more plans were nudged. Repo-scoped (runs once per doctor invocation), Warning severity. Surfaces the user error of running the loop in the wrong shell.

### Notes

- Mechanism critique resolved (no behavior change needed): fixed-interval `/loop 30m /compact …` does fire built-in compaction via the harness's `CronCreate`-mode interception path, per the documented `<<autonomous-loop>>` sentinel. Dynamic-mode `/loop /compact` (no interval) does NOT fire built-ins — the new validator is the guardrail against accidentally landing in dynamic mode.
- See spec: `docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md`.
```

If the existing CHANGELOG style differs (e.g. uses different heading depth, dash style, bold/italic conventions), match the existing style — these are guidelines only.

- [ ] **Step 5: Append WORKLOG.md entry (local handoff, gitignored)**

Append a terse dated entry following the same format as the existing 2026-05-06 entry. Example:

```markdown

---

## 2026-05-06 — v2.9.1 — auto-compact nudge fixes (Phase C followthrough)

**Scope:** Wording correction at line 606 + Step 0 validator + doctor check #26. Spec at `docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md`. All edits to `commands/masterplan.md` plus manifests + CHANGELOG.

**Why this shape:**

- **Wording over mechanism change.** Mechanism was correct (CronCreate path fires built-ins); only the "in another shell or session" advice was backward. Smallest fix that resolves the user-visible bug.
- **Disclose unconditional-firing tradeoff in text** rather than restructure cadence. There is no clean way to make `/compact` conditional on context size from outside the session — the harness has no "skip if low" form, and the model can't gate built-ins (Skill tool excludes them). User chose to keep 30m default and explain the tradeoff so users can self-tune.
- **Validator + doctor #26 bundled** to avoid leaving the silent-degrade and wrong-shell failure modes uncovered.

**Phase B still pending:** v2.10.0 should add masterplan-shim sentinel recognition to check #25 so the user-level shim doesn't get re-flagged as drift. Plan file: `~/.claude/plans/curious-coalescing-rose.md`.
```

- [ ] **Step 6: Final post-edit verification**

```bash
grep '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
head -3 CHANGELOG.md
```

Expected:
- All three version fields show `"2.9.1"`.
- CHANGELOG starts with the new v2.9.1 section.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
# WORKLOG.md is gitignored; do not stage.
git commit -m "$(cat <<'EOF'
release: v2.9.1 — auto-compact nudge fixes

Wording correction + Step 0 validator + doctor check #26
(auto_compact_loop_attached). See CHANGELOG for details.

Spec: docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: End-to-end verification

**Files:** none modified — read-only smoke test.

- [ ] **Step 1: Run the spec's verification checklist**

For each numbered item in `docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md` § Verification, run the corresponding command and capture output. Items 1, 2, 6, 7 are static / grep-based and runnable here. Items 3, 4, 5 require an interactive `/masterplan` session and are deferred to manual smoke.

```bash
# Item 1: wording smoke
grep -c "another shell or session" commands/masterplan.md   # Expect: 0
grep -c "this same session" commands/masterplan.md          # Expect: ≥1

# Item 6: backward compat — no schema change
grep -F "compact_loop_recommended" commands/masterplan.md | wc -l   # Expect: ≥4 (unchanged from pre-edit)

# Item 7: plugin manifest sync
grep '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json   # Expect: all 3 = 2.9.1
```

- [ ] **Step 2: Confirm no syntax breakage in the orchestrator**

Markdown has no syntax checker per se, but `bash -n` syntax-checks any embedded bash if applicable to the changed sections. The auto-compact section has no bash — skip.

Run a structural check: confirm the doctor checks table did not get its row separator mangled.

```bash
awk '/^\| 25 \|/,/^\| 26 \|/' commands/masterplan.md | head -3
```

Expected: row #25 line, row #26 line (the new one), each starting with `|` and ending with `|`.

- [ ] **Step 3: Manual smoke test (deferred — requires interactive session)**

Document, do not execute here. The implementer should run these in a fresh `/masterplan` session after this plan completes:

  - **Validator behavior:** create temporary `~/.masterplan.yaml` with `auto_compact: { enabled: true, interval: "" }`. Run `/masterplan brainstorm verify-validator`. Expect: warning emitted (visible in output), kickoff nudge NOT rendered. Restore original config.
  - **Doctor check positive:** in a session running `/masterplan execute <slug>` after kickoff, type `/loop 30m /compact focus on current task + active plan; drop tool output and old reasoning`. Run `/masterplan doctor`. Expect: no `auto_compact_loop_attached` finding.
  - **Doctor check negative:** in a session that saw the nudge but did NOT run the loop, run `/masterplan doctor`. Expect: warning finding listing the plan slug + the copy-pasteable `/loop` command.

If any manual smoke fails, file as v2.9.2 followup; do not block the v2.9.1 ship.

- [ ] **Step 4: Push (if and only if user explicitly confirms)**

```bash
# Do NOT auto-push. User-confirmed only:
git log --oneline -5
# Show the 4 commits from this plan + the spec commit. If user says "push", then:
# git push origin main
```

---

## Self-Review

Spec coverage:
- ✅ Wording fix (Spec Change 1) → Task 1
- ✅ Validator (Spec Change 2) → Task 2 (steps 3-4 wire validator + suppression flag at both nudge sites)
- ✅ Doctor check (Spec Change 3) → Task 3 (steps 3-4 add row + parallelization brief)
- ✅ Files-to-modify table from spec → Task 1-4 collectively
- ✅ Verification 1, 2, 6, 7 from spec → Task 5 step 1
- ✅ Verification 3, 4, 5 (manual smoke) → Task 5 step 3 (documented but deferred)

Placeholder scan: none. Each step has exact commands, exact `old_string`/`new_string`, expected counts.

Type consistency:
- `auto_compact_nudge_suppressed` flag name used consistently in Task 2 (3 occurrences).
- `auto_compact_loop_attached` check name used consistently in Task 3 (table row + parallelization brief + verification grep).
- Version `2.9.1` used consistently across plugin.json, marketplace.json, CHANGELOG.

Edge case noted: `replace_all: true` in Task 4 step 3 because `marketplace.json` has the version field twice (top-level + inside `plugins[0]`). Caught at plan-write time, not runtime.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-06-auto-compact-nudge-fixes.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Best fit for this small-but-multi-task patch where each task is independently verifiable.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. Lower overhead but interleaves with this conversation.

**Which approach?**
