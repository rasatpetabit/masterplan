# v2.8.0 Subagent Execution Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 7 highest-severity findings from `docs/audit-2026-05-05-subagent-execution.md` — make subagent dispatch and verification structurally enforceable rather than convention-only.

**Architecture:** Surgical markdown edits to `commands/masterplan.md` (the orchestrator prompt) plus one new doctor check (#22), schema-versioned eligibility cache, and a config-toggleable wave timeout. No code-language changes; "implementation" is targeted edits to the orchestrator prompt + CHANGELOG entry + version bump per project convention.

**Tech Stack:** Markdown (orchestrator prompt). Bash (telemetry hook — read-only for this plan). No test framework — verification via grep discriminators + `bash -n` + hand-crafted runtime smoke runs. Git worktrees per project convention (`.worktrees/` is gitignored).

**Source audit:** `docs/audit-2026-05-05-subagent-execution.md` — every task below cites a specific finding from that doc.

---

## Setup

### Task 0: Create isolated worktree

**Files:**
- Create: `.worktrees/subagent-exec-hardening/` (gitignored)

**Codex:** no
**parallel-group:** _(none — setup task is serial)_

- [ ] **Step 1: Verify .worktrees/ is gitignored**

```bash
git check-ignore -q .worktrees && echo "OK"
```
Expected: `OK`

- [ ] **Step 2: Create the worktree**

```bash
git worktree add .worktrees/subagent-exec-hardening -b subagent-exec-hardening
cd .worktrees/subagent-exec-hardening
```

- [ ] **Step 3: Set local git identity per project convention**

```bash
git config --local user.name "Richard A Steenbergen"
git config --local user.email "ras@petabitscale.com"
```

- [ ] **Step 4: Verify clean baseline**

```bash
bash -n hooks/masterplan-telemetry.sh
git status --porcelain
```
Expected: hook syntax-clean, no staged changes.

---

## Cluster 1: D.2 — schema_version on eligibility cache

The lowest-effort highest-leverage finding. Adds a single field to the cache JSON shape; on load, mismatch → rebuild.

### Task 1: Add `cache_schema_version` to eligibility cache JSON shape

**Files:**
- Modify: `commands/masterplan.md:688-702` (cache JSON schema doc) and `commands/masterplan.md:660` (inline-build emit)

**Codex:** ok
**parallel-group:** _(none — sequential within cluster)_

- [ ] **Step 1: Update the schema definition at line 688-702**

Add a new top-level field to the cache JSON shape:

```json
{
  "cache_schema_version": "1.0",
  "tasks": { /* existing per-task records */ }
}
```

Wrap the existing per-task map under a `tasks:` key (was at top level previously).

- [ ] **Step 2: Update the Step C step 1 inline-build path (line 660)**

Add to the inline-build emission step: stamp `cache_schema_version: "1.0"` on every cache write. Update the Haiku brief at line 720 to also emit this field.

- [ ] **Step 3: Add load-side validation at line 657**

Modify the cache load decision tree: after loading JSON from disk, if `cache_schema_version` is missing OR != `"1.0"`, treat as cache-miss → enter Build path. Add an activity-log entry variant: `eligibility cache: rebuilt — schema version mismatch`.

- [ ] **Step 4: Update the cache schema documentation**

In the cache schema subsection (~line 685), add: *"`cache_schema_version` is bumped when the eligibility checklist or annotation parser changes; mismatch triggers rebuild. Current version: 1.0."*

- [ ] **Step 5: Verify**

```bash
grep -n "cache_schema_version" commands/masterplan.md
# Expected: ≥ 4 hits (schema doc + inline-build + Haiku brief + load-side check + activity-log variant)
grep -nE "eligibility cache: rebuilt — schema version mismatch" commands/masterplan.md
# Expected: 1 hit
```

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "feat(step-c): cache_schema_version on eligibility cache (D.2)"
```

---

## Cluster 2: D.4 — Step 4b mid-plan availability re-check

Folds a lightweight Codex availability re-check into Step 4b's gate so a mid-plan plugin uninstall surfaces a degradation marker instead of silently skipping review.

### Task 2: Add re-check to Step 4b precondition

**Files:**
- Modify: `commands/masterplan.md:1015-1019` (Step 4b gate conditions)

**Codex:** ok
**parallel-group:** _(none)_

- [ ] **Step 1: Read the current gate**

```bash
sed -n '1015,1025p' commands/masterplan.md
```

- [ ] **Step 2: Replace the third gate condition**

Change line 1018 from `The codex plugin is available (codex:codex-rescue is installed).` to:

```
The codex plugin is available (re-check inline at gate time per the heuristic in Step 0). On miss, write the same degradation marker as Step 0's degrade-loudly path (activity log + ## Notes one-liner), set in-memory codex_review = off for the rest of the session, and skip 4b. This catches mid-plan plugin uninstall.
```

- [ ] **Step 3: Verify**

```bash
grep -n "re-check inline at gate time" commands/masterplan.md
# Expected: 1 hit at ~1018
grep -n "mid-plan plugin uninstall" commands/masterplan.md
# Expected: 1 hit
```

- [ ] **Step 4: Commit**

```bash
git add commands/masterplan.md
git commit -m "feat(step-4b): mid-plan codex availability re-check (D.4)"
```

---

## Cluster 3: D.1 — Codex availability ping

Replaces the fragile `codex:` prefix string scan with an actual no-op dispatch ping. Cached per-session.

### Task 3: Replace Step 0 string-scan with ping-based detection

**Files:**
- Modify: `commands/masterplan.md:35-55` (Codex availability detection)

**Codex:** no

- [ ] **Step 1: Read the current heuristic**

```bash
sed -n '35,55p' commands/masterplan.md
```

- [ ] **Step 2: Rewrite line 37's heuristic**

Replace the prose at line 37:
- Was: `Heuristic: scan the system-reminder skills list for any entry prefixed codex:`
- New: `Detection: dispatch a 5-token bounded ping to codex:codex-rescue with brief Goal=health-check. Inputs=none. Scope=read-only. Constraints=return only "ok". Return shape={status:"ok"}. On dispatch error (subagent_type not found, plugin uninstalled, API error) → codex unavailable. On successful return → codex available. Cache result on per-invocation state as codex_ping_result. Subsequent steps consult cache, never re-ping. Ping cost: ~5 tokens; runs once per /masterplan invocation.`

- [ ] **Step 3: Add a config flag for users who want to skip the ping**

In `.masterplan.yaml` schema (search for `codex:` config block), add:

```yaml
codex:
  detection_mode: ping  # ping | scan | trust  (default ping)
```

Document at the config schema section:
- `ping` (default) — dispatch a no-op ping; most accurate.
- `scan` — legacy `codex:` prefix string scan; faster but fragile.
- `trust` — assume available; skip detection entirely (for users on locked-down accounts where the ping itself fails for unrelated reasons).

- [ ] **Step 4: Update the activity log marker for the new detection path**

The Step 0 degraded path at line 49 says `codex degraded — plugin not detected`. Add a sub-variant: `codex degraded — ping returned error: <error>` so future debugging can distinguish "plugin missing" from "plugin present but dispatch broken".

- [ ] **Step 5: Verify**

```bash
grep -n "codex_ping_result" commands/masterplan.md
# Expected: ≥ 2 hits
grep -nE "codex degraded — ping returned error" commands/masterplan.md
# Expected: 1 hit
grep -n "detection_mode:" commands/masterplan.md
# Expected: 1 hit (config schema)
```

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "feat(step-0): ping-based codex availability detection (D.1)"
```

---

## Cluster 4: C.1 — Doctor check #22 for model-passthrough leakage

Telemetry-driven doctor check that surfaces SDD/wave dispatches running on Opus.

### Task 4: Add doctor check #22

**Files:**
- Modify: `commands/masterplan.md` (Step D doctor section, around line 1432; add new check definition; bump check count in summary)

**Codex:** ok

- [ ] **Step 1: Locate the Step D check list**

```bash
grep -n "^| 21 \|" commands/masterplan.md
# Expected: 1 hit (the table row for check #21)
grep -n "Doctor checks" commands/masterplan.md | head -3
```

- [ ] **Step 2: Add check #22 to the doctor table**

After the row for check #21 in the doctor table, add:

```
| 22 | Telemetry shows Opus on SDD/wave/Step-C-step-1 dispatch site | Warning | Report only | Indicates model-passthrough override leaked or was missing; cost regression and quality variance |
```

- [ ] **Step 3: Add the check definition**

In the per-check definitions section (search for "#21 — Eligibility cache evidence-of-attempt" or the equivalent doctor-detail block), add:

```markdown
**#22 — Opus on bounded-mechanical dispatch sites.**

Checks the most recent N entries in `<plan>-subagents.jsonl` (where N = `min(20, len(jsonl))`) for records whose `dispatch_site` matches `Step C step 1`, `Step C step 2 wave member`, `superpowers:subagent-driven-development`, or `superpowers:executing-plans` AND whose `model` is `opus`. Excludes records whose `prompt_first_line` matches `re-dispatched with model=opus per blocker gate` (intentional escalation).

**Severity:** Warning (cost issue, not correctness — but warns of a contract drift that COULD become a correctness issue).

**Fix:** review the orchestrator's most recent SDD invocation brief; verify the model-passthrough override clause is present per `commands/masterplan.md:231,840`. If present, suspect upstream SDD prompt-template drift.
```

- [ ] **Step 4: Update the parallelization brief count**

Search for `22 checks` or `21 checks` in the doctor section; update count to `23 checks` (the table now has 22 + the new #22 = 23 rows).

Wait — re-check: the table has rows 1-21 plus the new #22 = 22 rows total. So count goes from `22 checks` to `22 checks` if it already said 22 (because #22 is the new addition). Verify by grepping:

```bash
grep -nE "[0-9]+ checks" commands/masterplan.md
```

Update wherever the count appears.

- [ ] **Step 5: Verify**

```bash
grep -n "^| 22 |" commands/masterplan.md
# Expected: 1 hit
grep -n "Opus on bounded-mechanical dispatch sites" commands/masterplan.md
# Expected: 1 hit (in check definitions)
grep -n "re-dispatched with model=opus per blocker gate" commands/masterplan.md
# Expected: ≥ 2 hits (one in original gate text at ~864, one in the new check exclusion)
```

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "feat(doctor): #22 model-passthrough leakage detection (C.1)"
```

---

## Cluster 5: E.1 — Wave-completion barrier timeout

Adds per-member timeout + graceful partial-completion path so a hung Sonnet doesn't strand the wave.

### Task 5: Add config + timeout semantics for wave members

**Files:**
- Modify: `commands/masterplan.md:836` (wave-completion barrier paragraph)
- Modify: `commands/masterplan.md:870-880` (wave-level outcome rules)
- Modify: `commands/masterplan.md` config schema section (search for `parallelism:`)

**Codex:** no

- [ ] **Step 1: Read current barrier and outcome paragraphs**

```bash
sed -n '836,884p' commands/masterplan.md
```

- [ ] **Step 2: Add timeout config to parallelism block**

In the config schema, under `parallelism:`, add:

```yaml
parallelism:
  member_timeout_sec: 600  # default 10 minutes; per-wave-member soft timeout
  on_member_timeout: blocker  # blocker | abort_wave  (default blocker)
```

Document:
- `blocker` (default) — timed-out member is reclassified as `blocked` with reason `wave-member-timeout`; surviving members complete normally; blocker re-engagement gate fires for the timed-out member at wave-end.
- `abort_wave` — first timeout aborts the entire wave; surviving members' digests are dropped; all N tasks re-classified as blocked.

- [ ] **Step 3: Update the wave-completion barrier description at line 836**

Replace:
- Was: `Orchestrator waits for all N Agent calls to return before proceeding.`
- New: `Orchestrator waits for all N Agent calls to return OR per-member timeout (config.parallelism.member_timeout_sec, default 600s) per the on_member_timeout policy. Returns aggregate as a digest list. Wave-end clears cache_pinned_for_wave (sets to false).`

- [ ] **Step 4: Add a new per-member outcome at line 870-872**

After the existing `protocol_violation` outcome (line 872), add:

```markdown
   - `timed_out` — **detected by orchestrator post-barrier-deadline** (not returned by SDD). When member_timeout_sec elapses for a member that hasn't returned, orchestrator cancels the dispatch and reclassifies as `timed_out`. Treated as `blocked` for wave-level outcome computation, with blocker reason `wave-member-timeout (Ns elapsed; config.parallelism.member_timeout_sec=N)`.
```

- [ ] **Step 5: Update the wave-level outcome rules at lines 874-880**

Add a new bullet:

```
- **Mixed completed + timed_out** → treated identically to `Partial (K completed, N-K blocked)` per the existing partial-failure path. The single-writer 4d funnel applies the K completed digests; the N-K timed-out members get `## Blockers` entries.
```

- [ ] **Step 6: Verify**

```bash
grep -n "member_timeout_sec" commands/masterplan.md
# Expected: ≥ 3 hits (config + barrier + outcome)
grep -n "timed_out" commands/masterplan.md
# Expected: ≥ 2 hits (per-member outcome + wave-level)
grep -n "wave-member-timeout" commands/masterplan.md
# Expected: 1 hit (blocker reason string)
```

- [ ] **Step 7: Commit**

```bash
git add commands/masterplan.md
git commit -m "feat(step-c): wave-member timeout + partial-completion (E.1)"
```

---

## Cluster 6: F.4 — Status file rotation flock

Wraps Step 4d's atomic write in a file lock so concurrent user-editor saves don't race.

### Task 6: Add flock guard to Step 4d status write

**Files:**
- Modify: `commands/masterplan.md:1098-1115` (Step 4d rotation + atomic write)

**Codex:** no

- [ ] **Step 1: Read current 4d rotation block**

```bash
sed -n '1098,1115p' commands/masterplan.md
```

- [ ] **Step 2: Add flock semantics to the rotation paragraph**

Insert a new paragraph after line 1106 (after the wave-aware rotation rule):

```markdown
   **Concurrent-write guard (F.4 mitigation).** The atomic write (temp + fsync + rename) assumes no concurrent writer. To protect against user-editor saves racing the orchestrator, wrap the rotation+append+rename in `flock <status-file> -c '<the-write-sequence>'` with a 5-second timeout. On contention (lock not acquired within 5s), do NOT block: write the entry to a sidecar queue file `<slug>-status.queue.jsonl` and surface a one-line stdout warning *"Status write contention — entry queued; retry on next 4d cycle."* The next 4d run drains the queue before its own append. Idempotent — replaying queued entries with already-applied state is a no-op.
```

- [ ] **Step 3: Add doctor check observation for queue file**

In the doctor check section (Step D), add a check #23 that flags a non-empty `<slug>-status.queue.jsonl` after a session has ended (suggests the orchestrator was killed before drain):

```
| 23 | Status-write queue file <slug>-status.queue.jsonl present and non-empty | Warning | --fix replays queue entries into status file | Indicates a previous session hit write contention without subsequent drain |
```

- [ ] **Step 4: Verify**

```bash
grep -n "F.4 mitigation" commands/masterplan.md
# Expected: 1 hit
grep -n "status.queue.jsonl" commands/masterplan.md
# Expected: ≥ 2 hits (mitigation paragraph + doctor row)
grep -n "^| 23 |" commands/masterplan.md
# Expected: 1 hit
```

- [ ] **Step 5: Commit**

```bash
git add commands/masterplan.md
git commit -m "feat(step-4d): flock guard + queue file for status writes (F.4)"
```

---

## Cluster 7: G.1 — Trust-contract verification (BRAINSTORM-GATED)

The audit doc flagged G.1 as design-level. The first task here is a brainstorm gate that surfaces design choices via `AskUserQuestion`; subsequent tasks are conditional on the choice. Do NOT pre-implement a single approach — let the user pick at execution time.

### Task 7: Brainstorm gate — pick the trust-contract verifier approach

**Files:**
- _(no edits in this task — surfaces an `AskUserQuestion`)_

**Codex:** no
**non-committing:** true

- [ ] **Step 1: Surface AskUserQuestion with 4 design options**

Question: *"Step 4a's trust contract currently honors `tests_passed: true` + `commands_run: [...]` from the implementer with no verification of execution. Pick a design for closing G.1 (the audit doc spells out the tradeoffs):"*

Options (4 — within CD-9 cap):

1. **Verification output excerpt validation (Recommended)** — Implementer returns 1-3 lines of verification output per command (already partly captured per CD-8). Orchestrator validates each excerpt contains a recognizable PASS/OK/0-error signal before honoring trust-skip. Lightest touch; asymmetric (orchestrator validates).

2. **Expected-output regex per task** — Plan author writes a regex per verification command; orchestrator's trust-skip requires regex match against captured output. Mid-weight; requires plan-author discipline.

3. **Eliminate trust contract entirely** — Drop the `tests_passed` skip optimization. Always re-run verification at Step 4a. Most robust; cost regresses ~1 implementer-equivalent run per task on commands the implementer already ran.

4. **Cryptographic command-execution receipt** — Implementer wraps each verification command in a script producing a hash-chained log (start-time + command + exit-code + output-hash); orchestrator verifies the chain. Heaviest; most tamper-resistant but most invasive.

Wait for user pick before proceeding to Task 8.

- [ ] **Step 2: Record the pick in `## Notes`**

Append to status file: `G.1 design decision: <option N> — <one-line rationale from user, if provided>`.

- [ ] **Step 3: Set in-memory `g1_design = <pick>` for downstream tasks**

This is read by Task 8 to choose its sub-implementation path.

### Task 8: Implement G.1 per Task 7's pick

**Files:** _(depends on Task 7's pick — see per-pick sub-plans below)_

**Codex:** no  _(deferred until Task 7 resolves — re-evaluate then)_

This task is a placeholder. Its concrete implementation is one of four sub-plans, gated on Task 7's decision:

#### If pick == 1 (Verification output excerpt validation)

- [ ] **Step 1:** Modify `commands/masterplan.md:996-1003` (Step 4a trust contract) to add an output-excerpt requirement to the trust-skip path.
- [ ] **Step 2:** Update the implementer-return contract in `commands/masterplan.md:199` (dispatch model table) to add `commands_run_excerpts: {cmd → [str]}` as a required field.
- [ ] **Step 3:** Add an excerpt-validator inline at line 999-1000: regex-match each excerpt against a default PASS pattern (`PASSED?|OK|0 errors|exit 0`); allow per-task override via plan annotation `**verify-pattern:** <regex>`.
- [ ] **Step 4:** Update Step 4a activity-log entry format to record `(verify: trusted implementer; excerpts validated for <N> commands)`.
- [ ] **Step 5:** Verify with grep + bash -n.
- [ ] **Step 6:** Commit.

#### If pick == 2 (Expected-output regex per task)

- [ ] **Step 1:** Add `**verify-pattern:** <regex>` plan annotation to the writing-plans skill's per-task brief (`commands/masterplan.md:540` writing-plans high-complexity).
- [ ] **Step 2:** Eligibility cache parses `**verify-pattern:**` per task; cache schema bumps to `1.1`.
- [ ] **Step 3:** Step 4a trust-skip path requires a verify-pattern match against the implementer's captured output for each command.
- [ ] **Step 4:** Verify, commit.

#### If pick == 3 (Eliminate trust contract)

- [ ] **Step 1:** Strip lines 996-1003's trust-skip logic; Step 4a always runs full verification per CD-1.
- [ ] **Step 2:** Update `tests_passed`+`commands_run` to be informational-only fields (still requested in implementer return, but not used for skip decisions).
- [ ] **Step 3:** Remove the protocol-violation trigger at line 1001 — under always-re-run, the existing autonomy-policy blocker handles failures naturally.
- [ ] **Step 4:** Verify, commit.

#### If pick == 4 (Cryptographic receipt)

- [ ] **Step 1:** Design + implement the receipt-wrapper script. (Defer to a separate /masterplan brainstorm — this option is heavy enough to warrant its own spec.)
- [ ] **Step 2-N:** TBD per the brainstorm.

If pick == 4: Halt this plan. Open a new /masterplan brainstorm for the receipt design. Tasks 9-11 below proceed independently.

---

## Cluster 8: Release

### Task 9: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Codex:** ok
**parallel-group:** docs

- [ ] **Step 1: Add v2.8.0 section**

Under the existing `## [Unreleased]` section, add:

```markdown
## [2.8.0] — 2026-XX-XX  <!-- fill in commit date -->

### Added
- `cache_schema_version: "1.0"` on the eligibility cache JSON shape; load-side check rebuilds on mismatch (closes audit finding D.2).
- Step 4b mid-plan Codex availability re-check; degradation marker on miss (closes D.4).
- Step 0 ping-based Codex availability detection (replaces fragile prefix scan); new `codex.detection_mode` config flag with `ping` default (closes D.1).
- Doctor check #22 — flags Opus on SDD/wave/Step-C-step-1 dispatch sites via `<plan>-subagents.jsonl` post-mortem (closes C.1).
- Wave-member timeout (`config.parallelism.member_timeout_sec`, default 600s) + new `timed_out` per-member outcome integrated with the partial-completion path (closes E.1).
- Step 4d concurrent-write guard via `flock` over the status file; on contention, entries queue to `<slug>-status.queue.jsonl` and replay on next cycle. New doctor check #23 surfaces non-empty queue files (closes F.4).

### Changed
- Trust-contract verifier behavior at Step 4a — see G.1 cluster (specific Changed entry to be filled in based on Task 7's pick).

### Why
The v2.8.0 cycle is the first defensive-correctness pass driven by `docs/audit-2026-05-05-subagent-execution.md`. Each closed finding had a documented gap between "convention" and "structurally enforceable"; this release converts the load-bearing cases.
```

- [ ] **Step 2: Verify and commit**

```bash
grep -nE "^## \[2\.8\.0\]" CHANGELOG.md  # Expected: 1 hit
git add CHANGELOG.md
git commit -m "docs(changelog): v2.8.0 entry"
```

### Task 10: Bump version to 2.8.0

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Codex:** ok
**parallel-group:** docs

- [ ] **Step 1: Read both files**

```bash
grep -n '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
```

- [ ] **Step 2: Replace `"2.7.0"` → `"2.8.0"` in both files**

Use Edit tool with `replace_all: true` per file.

- [ ] **Step 3: Verify**

```bash
grep -n '"version": "2.8.0"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
# Expected: 1 hit in plugin.json, 2 hits in marketplace.json (top-level + plugin entry)
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "release: v2.8.0 — subagent execution hardening"
```

### Task 11: Merge to main + tag

**Files:** _(none — git operations only)_

**Codex:** no

- [ ] **Step 1: Merge to main**

```bash
cd ../..  # back to main checkout
git merge --ff-only subagent-exec-hardening
```

- [ ] **Step 2: Tag**

```bash
git tag -a v2.8.0 -m "v2.8.0 — subagent execution hardening"
```

- [ ] **Step 3: Push + push tag**

```bash
git push origin main
git push origin v2.8.0
```

- [ ] **Step 4: Verify tag on origin**

```bash
git ls-remote --tags origin v2.8.0
# Expected: 1 line; SHA matches HEAD of main
```

- [ ] **Step 5: Clean up worktree + branch**

```bash
git worktree remove .worktrees/subagent-exec-hardening
git branch -d subagent-exec-hardening
```

---

## Verification matrix (post-release)

Per project convention (no test framework — grep + bash -n + hand-crafted runtime smoke):

1. **Grep discriminators** — every Task above ends with grep verification. Aggregate into one run:

```bash
grep -nE "cache_schema_version|re-check inline at gate time|codex_ping_result|^| 22 \||member_timeout_sec|F.4 mitigation|status.queue.jsonl|^| 23 \|" commands/masterplan.md
# Expected: ≥ 12 hits across all clusters
```

2. **Hook syntax check** — orchestrator changes do not modify the hook, but verify it remains clean:

```bash
bash -n hooks/masterplan-telemetry.sh
# Expected: clean exit
```

3. **Hand-crafted runtime smoke (T-series, post-merge)**:

- **T1 — D.2 schema-version migration:** create a v2.7.0-format cache (no `cache_schema_version` field) on disk; resume Step C; confirm activity log shows `rebuilt — schema version mismatch`.
- **T2 — D.4 mid-plan availability change:** run a plan with codex_review on; mid-plan, uninstall the codex plugin via `/plugin`; complete next task; confirm `## Notes` shows the degradation marker.
- **T3 — D.1 ping vs scan:** run with `codex.detection_mode: ping` (default); confirm a small Codex dispatch fires at Step 0; run with `codex.detection_mode: scan`; confirm no dispatch.
- **T4 — C.1 doctor #22:** synthesize a `<plan>-subagents.jsonl` with a fabricated SDD record showing `model: "opus"`; run `/masterplan doctor`; confirm #22 fires.
- **T5 — E.1 timeout:** run a wave where one member is artificially slow (e.g., `bash -c 'sleep 700; exit 0'` as a verification command); confirm timeout fires at 600s and the member is reclassified `timed_out`.
- **T6 — F.4 contention:** run a plan; mid-Step-4d, edit the status file in another session; confirm the queue file is created and drains on the next cycle.
- **T7 — G.1:** depends on Task 7's pick. Add a runtime test to validate the chosen verifier path.

4. **Cross-section consistency** (per anti-pattern #4 in CLAUDE.md): doctor check count, verb routing table, reserved-tokens list — none touched by this plan, but spot-check after merge.

5. **Fresh-eyes audit** (per anti-pattern #5): dispatch one Explore subagent (haiku, model: "haiku" per §Agent dispatch contract) to read the modified Step C step 1, Step 4a/4b, Step 4d, Step 0, Step D end-to-end and report any contradictions or dangling references introduced by the seven clusters.

---

## Footprint estimate

- `commands/masterplan.md`: ~120 lines added across 7 clusters (D.2: ~15, D.4: ~5, D.1: ~25, C.1: ~25, E.1: ~25, F.4: ~15, G.1: variable per pick).
- `CHANGELOG.md`: ~25 lines.
- `.claude-plugin/{plugin,marketplace}.json`: 3 version bumps.
- New surfaces: doctor checks #22 + #23, config flags `codex.detection_mode`, `parallelism.member_timeout_sec`, `parallelism.on_member_timeout`, cache field `cache_schema_version`, queue sidecar `<slug>-status.queue.jsonl`.

## Out of scope (deferred to future plans)

- **G.2-G.6** — additional trust-contract / Codex-review variants. G.1 is the highest-leverage; the rest are follow-ups once G.1's design pattern is in place.
- **A.1 model-passthrough programmatic enforcement at dispatch time** — the doctor check #22 (this plan) catches it post-mortem; a pre-dispatch lint that scans the assistant's pending Agent calls for missing `model:` is a separate design.
- **F.1, F.2, F.3** — finer mtime hardening (content-hash fallback, cross-process invalidation). The audit notes these as high-severity but they're more invasive than F.4's flock fix; defer.
- **H-class findings** — `git`/`gh`/atomic-write/sandbox edge cases. Best handled per-environment as user reports surface them.
- **E.2-E.5** — wave-dispatch sub-cases (sequential `git log` misattribution, mid-wave plan edits, idempotency edge cases, 4c filter ambiguity). The high-severity item E.1 is in this plan; the rest are medium and can be batched into v2.9.0 if needed.
