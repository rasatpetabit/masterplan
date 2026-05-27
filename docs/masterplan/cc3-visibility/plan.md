# Plan — CC-3 visibility (v6.4.0)

> Executable implementation plan for bundle `cc3-visibility`.
> Spec: `docs/masterplan/cc3-visibility/spec.md` (1556 lines, decisions D1–D24, 24 verification greps).
> All spec citations below refer to that file.

---

## Plan-v2 revision notes (2026-05-26)

Plan-v1 surfaced 5 HIGH + 2 MEDIUM Codex review findings. Plan-v2 absorbs all 7:

- **HIGH-1** (self-migration rollback) → W3-T5 (rewritten with backup, atomic rename, parse-validate, rollback bash block).
- **HIGH-2** (doctor severity/action table rows) → W3-T1 Edit 5 (NEW) — adds explicit `| 50 |`, `| 51 |`, `| 52 |` table rows. Discovery: Check #50 is also missing from the table (anti-pattern #4 already happened in v6.3.3 — this revision sweeps it back in).
- **HIGH-3** (D4 turn_id join key) → W1-T3 (extended brief, hook emits `turn_id` on every dispatch event) + W3-T1 Check #52 (consumes `turn_id`) + W3-T4 fixture check-52/fail-drift (NEW — events.jsonl and subagents.jsonl intentionally disagree, asserts `model_attribution_drift`).
- **HIGH-4** (Wave 2 gate verification depth) → Wave 2 gate (rewritten — adds 5 explicit greps: `Return: JSON matching`, `Do NOT return prose`, `codex_review_returned`, `raw excerpt:`, `SKIPPED — codex-host recursion guard`).
- **HIGH-5** (CARRY-B scope expansion) → W1-T4 CARRY-B (extended — also sweeps CHANGELOG draft, rollout section, repo-wide patterns) + W4-T4 verification (adds 3 negative-grep patterns).
- **MEDIUM-1** (D8 dual-structure migration) → W2-T4 Edit C (NEW) — updates existing `subagents_this_turn` consumer sites + adds backward-compatibility note to contract.
- **MEDIUM-2** (risk register completeness) → Risk register (NEW rows 6 and 7 for malformed-digest handling and partial-wave-commit recovery).

Critical-path estimate updated: ~195 min → **~215 min** (added: ~10 min W1-T3 turn_id, ~5 min W3-T5 rollback bash, ~5 min Wave 2 gate verification depth).

No restructuring of waves. Same 4-wave, 19-task topology. One sub-task added to W1-T3 (no new tasks). One new fixture added to W3-T4. One additional risk row pair to the register.

---

## Pre-flight (orchestrator-inline before any wave dispatch)

**PF-1.** Confirm worktree is on branch `masterplan/cc3-visibility` and is clean. Abort if dirty uncommitted changes exist outside this bundle's artifact paths.

**PF-2.** Read `docs/internals/doctor.md` to locate the four count-update sites (prose intro, Goal subsection, Return shape array, Partial failure array) so W3-T3 has exact line numbers at dispatch time.

**PF-3.** Note the current line numbers in `commands/masterplan.md` for the CC-3-trampoline block (lines 46–84) and the doctor verb count (line 84) — confirm they match the spec's "current text" quotes before any edits begin. If any line does not match, re-read the file and record the actual line number in the wave brief.

---

## Wave 1 — Foundation (all four tasks are independent; dispatch in parallel)

Wave 1 establishes the three new compliance rails and the new contract file. No task here writes to doctor.md, step-b.md, or step-c-*.md — those are Wave 2. No task here writes fixtures or Python tests — those are Wave 3.

### W1-T1 — CC-3 trampoline edits and marker-emission scaffold

**Tier:** `sonnet` (general-purpose implementer)
**File:** `commands/masterplan.md`
**Depends on:** none
**Carry-fix:** CARRY-D (atomic layered edits — see below)

**Brief:**

Apply five atomic edits to the CC-3-trampoline section (spec.md §`commands/masterplan.md` Changes 1–3 + M2 count fix). Critically, Changes 1 and 3a target the same line (`:52`) — they MUST be applied as a single combined final-form edit, not sequentially. Same for Changes 2 and 3b on lines `:54-56`. Do not apply Change 1 first and then patch Change 3a on top — apply the COMBINED text from spec.md line 129 directly.

Five edits:
1. Line `:52` — apply COMBINED text from spec.md Change 3a (line 129, which incorporates Change 1).
2. Lines `:54-56` — apply COMBINED text from spec.md Change 3b (lines 141-146, which incorporates Change 2).
3. Line `:69` — apply Change 3c text (spec.md lines 156-158).
4. Between current line `:71` (the `> CC-1 compact-suggest…` note) and the verb dispatch table at `:73` — insert the subagent-dispatch marker rule paragraph from spec.md Change 3d (lines 163-166).
5. Line `:84` — change `all 47 checks` to `all 52 checks` (M2 fix).

**Verification greps (spec.md Verification plan):** #1, #2, #3, #20, #23, #24.

---

### W1-T2 — Create `parts/contracts/codex-review.md` (new file)

**Tier:** `sonnet` (general-purpose implementer)
**File:** `parts/contracts/codex-review.md` (new)
**Depends on:** none

**Brief:**

Create the new contract file using the full draft from spec.md §"New contract" (lines 768–989). The file must contain exactly seven top-level `##` sections in this order:
1. When this contract applies
2. Dispatch brief template
3. Codex-host fallback (D13, D20 per-site table)
4. Parse algorithm
5. Inline emit format
6. Persistence
7. Site-specific addendums

Copy the content faithfully. Do not summarize or rephrase.

**Verification greps:** #4, #5.

---

### W1-T3 — Hook: extend telemetry marker parser (D19)

**Tier:** `sonnet` (general-purpose implementer — needs bash expertise)
**File:** `hooks/masterplan-telemetry.sh`
**Depends on:** none
**Carry-fix:** CARRY-C (absorbs the concrete `emit_cc3_marker_events()` implementation blueprint from the dispatch brief)

**Brief:**

Insert a new function `emit_cc3_marker_events()` into `hooks/masterplan-telemetry.sh` per spec.md §`hooks/masterplan-telemetry.sh` (lines 617–660). The function reads the existing `$turn_breadcrumbs` variable (already populated by the existing `grep -oE '<masterplan-trace [^>]+>'` extraction), dispatches on four new event types (`auq_render`, `breadcrumb_emitted`, `summary_block_emitted`, `subagent_dispatched`), and appends typed JSONL rows to `${plans_dir}/events.jsonl` using the existing `with_bundle_lock` pattern.

Insertion anchor: after the `detector_dispatch` call (current hook line 942), before `emit_turn_context_bytes` (current hook line 944). Guard: `if [[ "$is_bundle" -eq 1 ]]; then emit_cc3_marker_events "${plans_dir}/events.jsonl"; fi`.

`turn_id` derivation: `"${CLAUDE_SESSION_ID:-unknown}:${ts}"` (no separate per-turn UUID exists in the hook; this is the correct form confirmed in dispatch pre-flight). **CRITICAL:** the SAME `turn_id` value must be emitted on every event written during a single turn — derive it ONCE at the top of `emit_cc3_marker_events()` and reuse it for all four event types AND for the `subagents.jsonl` append path (see sub-task W1-T3b below).

The four `grep -oE` attribute extractions for `site=`, `dispatch_count=`, `type=`, `model=`, `task=` must use `cut -d= -f2 | head -1` to isolate the value token. Attribute values in markers use kebab/snake-case with no spaces (grammar defined in spec.md line 636).

**W1-T3b — turn_id join key for subagents.jsonl (HIGH-3 fix):** in the SAME edit pass, locate the existing `subagents.jsonl` append path in the hook (search for `subagents.jsonl` or the function that records per-Agent dispatch metadata at Stop-hook time). Add a `turn_id` field to every record written. Use the same derivation as above (`"${CLAUDE_SESSION_ID:-unknown}:${ts}"`). This is the join key that Check #52 (`model_attribution_drift`) consumes — without it, the check cannot correlate `subagent_dispatched` events in `events.jsonl` against `subagents.jsonl` records and would always SKIP.

After inserting, run `bash -n hooks/masterplan-telemetry.sh` to confirm zero syntax errors.

**Verification greps:** #13, #16. Additional verification: `grep -nE '"turn_id"' hooks/masterplan-telemetry.sh` → expect ≥2 hits (one in the marker-event emit, one in the subagents.jsonl append).

---

### W1-T4 — Spec carry-fixes: CARRY-A and CARRY-B

**Tier:** `sonnet` (general-purpose implementer)
**File:** `docs/masterplan/cc3-visibility/spec.md`
**Depends on:** none
**Carry-fix:** CARRY-A, CARRY-B

**Brief:**

Two sweeps over the spec itself (the spec is NOT frozen — it is locked at the spec-approval gate but carry-fixes from the conditional approval must be absorbed before plan execution):

**CARRY-A:** At spec.md line 1516, in open question #2 body, delete the claim that `check-degraded-parse/` is compatible with the fixture runner. Replace with a forward reference to the L1'/NEW-H1 resolution already present lower in the file (the Python unit-test tier). Do not change anything else in the open-questions block.

**CARRY-B: D24 tuple-compare sweep (EXPANDED for HIGH-5 fix).** Spec.md lines 302, 680, 1032, 1092, 1278, 1309 contain stale `schema_version < 4` (int-style) guards inside pseudocode/bash examples that will be copied into `parts/doctor.md` Check #51 and #52 bodies during W3-T1. CARRY-B policy: these are corrected **at the copy step in W3-T1** — the implementer applying W3-T1 copies the bash bodies from the spec but substitutes the D24 Python tuple-compare form wherever a `< 4` int guard appears. W3-T1's brief must explicitly state this.

**HIGH-5 expansion: also sweep release-text prose.** CARRY-B v1 only covered guards inside pseudocode; review found that the spec's CHANGELOG draft (spec.md lines 1294–1360) and the rollout section (spec.md lines 1286, 1309-1311) still describe the schema bump as `3→4` or reference `schema_version >= 4` in user-facing prose. Sweep all the following patterns across the entire repo at the start of W1-T4:

| Pattern | Files to sweep | Action |
|---|---|---|
| `schema_version.*< 4` / `schema_version.*<4` | spec.md, parts/*.md, bin/*.sh, commands/*.md, docs/internals/*.md | Replace with D24 tuple-compare form `tuple(int(p) for p in str(v).split('.')) < (5, 1)` in normative prose; leave pseudocode for W3-T1 copy-time substitution |
| `schema_version.*>= *4` / `schema_version.*>=4` | spec.md, CHANGELOG.md (when drafted in W4-T4), README.md | Replace with `>= "5.1"` |
| `3→4` / `3->4` / `from 3 to 4` | spec.md rollout section + CHANGELOG draft + any docs referencing the bump | Replace with `3 → "5.1"` (note the string quote in the target) |
| `schema_version: 4` (literal, non-pseudocode) | all repo files | Replace with `schema_version: "5.1"` |

Files to scan (full enumeration, not "repo-wide"):
- `docs/masterplan/cc3-visibility/spec.md` — primary target; sweep normative prose only, leave pseudocode/bash blocks for W3-T1
- `CHANGELOG.md` — not yet written at W1-T4 time, but W4-T4 must produce a CHANGELOG entry using `"5.1"`/`3 → "5.1"` form (W4-T4 brief enforces)
- `README.md` — current version references at lines `:207`, `:239` (count edits in W4-T3); no schema_version mentions today, but verify
- `parts/contracts/run-bundle.md` — current says `schema_version: "5.0"`; this is the existing baseline; do NOT change
- `parts/contracts/agent-dispatch.md` — verify no stale int forms (W2-T4 touches this file; sweep there)
- `parts/doctor.md` — pseudocode bodies for #51/#52 copied in W3-T1 with substitution
- `parts/step-0.md`, `parts/step-b.md`, `parts/step-c-resume.md`, `parts/step-c-verification.md` — touched by Wave 2; verify no stale int forms after Wave 2 commits
- `bin/masterplan-state.sh` — W4-T2 explicitly updates schema_version targets; verify
- `commands/masterplan.md`, `commands/masterplan-contracts.md` — no schema_version mentions expected; verify with grep
- `hooks/masterplan-telemetry.sh` — no schema_version mentions expected; verify with grep

CARRY-A: At spec.md line 1516, in open question #2 body, delete the claim that `check-degraded-parse/` is compatible with the fixture runner. Replace with a forward reference to the L1'/NEW-H1 resolution already present lower in the file (the Python unit-test tier). Do not change anything else in the open-questions block.

**Verification greps (W1-T4 gate):**
1. `grep -nE 'schema_version.*< *4($|[^.0-9])' docs/masterplan/cc3-visibility/spec.md parts/*.md docs/internals/*.md bin/*.sh commands/*.md` — expect 0 hits in normative prose; any survivors must be inside fenced bash blocks marked as W3-T1 copy targets.
2. `grep -nE 'schema_version.*>= *4($|[^.0-9])' docs/masterplan/cc3-visibility/spec.md CHANGELOG.md README.md 2>/dev/null` — expect 0 hits.
3. `grep -nE '3 *(→|->) *4|from 3 to 4' docs/masterplan/cc3-visibility/spec.md` — expect 0 hits.

---

### Wave 1 gate verification

Before advancing to Wave 2, verify all six greps listed above (W1-T1 greps #1/#2/#3/#20/#23/#24, W1-T2 greps #4/#5, W1-T3 greps #13/#16) pass. Run `bash -n hooks/masterplan-telemetry.sh` (grep #13). On any failure, halt and re-engage the relevant task before proceeding.

---

## Wave 2 — Surface integrations

W2-T1 and W2-T2 are independent; W2-T3 and W2-T4 are independent; all four can run in parallel.

Wave 2 wires the new codex-review.md contract into the three dispatch sites (B2, B3, C4b) and clarifies the agent-dispatch contract. These tasks read the contract file created in W1-T2 — Wave 2 must not begin until W1-T2 is committed.

### W2-T1 — `parts/step-b.md`: three structured-review edits

**Tier:** `sonnet`
**File:** `parts/step-b.md`
**Depends on:** W1-T2 (reads contract path)

**Brief:**

Three edits, each at a distinct location in the file:

**Edit A (line :128, new-bundle template, Change 0):** Replace the hardcoded `schema_version: 3` template with the D24 / D10 form per spec.md §`parts/step-b.md` Change 0 (lines 197–208). New template includes `schema_version: "5.1"` (string, quoted) and the `cached_compliance` stub with four null fields: `breadcrumb_ratio`, `summary_block_ratio`, `window_turns`, `last_audit_ts`.

**Edit B (lines :206-214, B2 spec gate, Change 1):** Replace the companion-script discovery + regex steps 3–5 with the two structured-review steps from spec.md §`parts/step-b.md` Change 1 (lines 210–234): new step 3 (foreground review dispatch per codex-review.md §Dispatch brief template) and new step 4 (parse + inline emit per codex-review.md §Parse algorithm + D6 ordering). Step 5 (gate routing override for aggressive-loose) is unchanged.

**Edit C (lines :277-290, B3 plan gate, Change 2):** In step 5 (on resume), replace the regex parse block with the structured parse + inline emit block from spec.md §`parts/step-b.md` Change 2 (lines 236–249). Background dispatch timing is unchanged. The `codex_review_returned` event append, `pending_gate` clear, and gate close-out proceed per the spec text.

**Verification greps:** #21 (schema_version "5.1" in step-b.md).

---

### W2-T2 — `parts/step-c-verification.md`: structured C4b review

**Tier:** `sonnet`
**File:** `parts/step-c-verification.md`
**Depends on:** W1-T2

**Brief:**

Three edits per spec.md §`parts/step-c-verification.md` (lines 253–277):

**Edit 1 (lines :101-116, dispatch brief Return line):** Replace the `Return:` line with the structured JSON return shape citing `parts/contracts/codex-review.md §Return JSON shape`. Schema: `{"verdict": "pass"|"fail"|"warn", "dimensions": [...], "findings": [...], "summary":"<text>"}`. "Do NOT return prose." per spec.md line 264.

**Edit 2 (line :119, digest replacement):** Replace `"Digest the response..."` with the parse + inline emit step from spec.md lines 268–275 (step 3). The emit fires immediately per D6 ordering: before decision matrix, before state write. On degraded-parse, surface `raw excerpt:` line. Append `codex_review_returned` event with `gate: "C4b"`.

**Edit 3 (skip path annotation, context around line :63):** At the C4b skip path where `dispatched_by == "codex"` causes the existing recursion guard to fire, add the inline annotation `↳ codex review (C4b): SKIPPED — codex-host recursion guard` per spec.md line 257.

**Verification greps:** None specific to this task; covered by Wave 2 gate grep #14 (agent-dispatch) and overall static checks.

---

### W2-T3 — `parts/step-c-resume.md`: unaddressed review replay (D16)

**Tier:** `sonnet`
**File:** `parts/step-c-resume.md`
**Depends on:** W1-T2

**Brief:**

After the TaskCreate rehydration / drift-recovery block (approximately lines :39-54), insert the "Codex review resume replay (v6.4.0+)" section from spec.md §`parts/step-c-resume.md` (lines 287–305). The section is guarded: `schema_version >= "5.1"` only (tuple compare per D24). Steps:
1. Tail-scan events.jsonl for most recent `codex_review_returned` entry.
2. Check for subsequent `findings_addressed` entry for same gate.
3. If none found: re-emit inline block annotated `(resumed)` and add acknowledge option to first AUQ.
4. If found: skip silently.
5. On acknowledge selection: append `findings_addressed` event. Informational only — does not change gate state.

Schema guard for the entire section: if `state.yml.schema_version < "5.1"` (tuple compare, D24), skip silently. The guard text in the spec's Change block (spec.md line 302) says `schema_version < 4` — this is a CARRY-B instance. Apply the D24 tuple-compare form: `tuple(int(p) for p in str(v).split('.')) < (5, 1)` with safe fallback.

**Verification greps:** None task-specific; validated by Wave 2 gate.

---

### W2-T4 — `parts/contracts/agent-dispatch.md`: dual-structure + D19 single-writer note

**Tier:** `sonnet`
**File:** `parts/contracts/agent-dispatch.md`
**Depends on:** none

**Brief:**

Two edits per spec.md §`parts/contracts/agent-dispatch.md` (lines 588–750):

**Edit A (lines :210-211, D8 dual-structure):** Replace the single `subagents_this_turn` spec with the two-structure definition from spec.md lines 599–605: `subagents_this_turn` (list, resets per assistant turn — NOT per step) and `subagents_this_step` (counter, resets per top-level Step entry). The per-turn reset fires at CC-2 banner emit (first action of each turn), not at Step entry.

**Edit B (after the D8 section, D19 single-writer note):** Add the anti-double-emission note from spec.md lines 742–750. The note clarifies that `subagent_dispatched` events in events.jsonl are written by the Stop hook from markers, NOT by the orchestrator. The orchestrator's three responsibilities at every dispatch site: (1) emit the marker, (2) append to `subagents_this_turn`, (3) increment `subagents_this_step`.

**Edit C (D8 dual-structure consumer migration — MEDIUM-1 fix):** After Edit A defines the new dual-structure semantics (`subagents_this_turn` per-turn + `subagents_this_step` per-step), existing references to `subagents_this_turn` in other files may continue working but their reset semantics changed (was-per-Step now per-turn). Two sub-edits:

1. **Backward-compatibility note (in this file, immediately after the D8 dual-structure definition block):** Add a paragraph: *"Migration: pre-v6.4.0 code that read `subagents_this_turn` as a per-Step counter continues to work — readers now see a per-turn list (which can span multiple steps within one turn) instead of a per-step list. Step-level consumers needing per-step granularity must migrate to `subagents_this_step`. The two structures coexist; both are populated on every dispatch."*

2. **Consumer-site sweep (search-only sub-edit; no orchestrator file edits unless found):** Run `grep -nE 'subagents_this_turn' parts/*.md commands/*.md` to enumerate existing consumers. For each hit, verify the consumer-site reasoning still holds under the new per-turn (not per-step) reset semantics. If a consumer site explicitly relies on per-step granularity (e.g., "reset at Step A entry"), flag it for follow-up in the W2-T4 return shape; do NOT auto-rewrite (the orchestrator-prompt edits are deliberate semantic choices per CD-7). Expected: ≤3 sites; most existing references are in CC-3-trampoline + per-turn dispatch tracking, both of which are now correctly per-turn.

**Verification greps:** #14. Additional: `grep -nE 'subagents_this_step' parts/contracts/agent-dispatch.md` → expect ≥2 hits (Edit A + backward-compat note from Edit C). `grep -cE 'subagents_this_turn' parts/contracts/agent-dispatch.md` → expect ≥3 hits (definition + reset note + migration note).

---

### Wave 2 gate verification

Run greps #14, #21 first (baseline). Then run the structured-review-wiring depth verification (HIGH-4 fix — the v1 gate was too shallow and a stub implementation that omitted inline emits or used prose returns would still pass):

1. **JSON return shape required at B2, B3, C4b.** `grep -nE 'Return: JSON matching|Return JSON matching' parts/step-b.md parts/step-c-verification.md parts/contracts/codex-review.md` — expect ≥2 hits (C4b inlines the directive at step-c-verification.md; contract carries the canonical template at parts/contracts/codex-review.md:27; B2 and B3 cite the contract by path per spec.md §Change 1/2). Plan-v3.1 fix: original gate expected ≥3 hits in step-b.md + step-c-verification.md, but the spec explicitly routes step-b.md sites to cite the contract by reference rather than inline the literal — this gate was over-strict and missed the contract file. The canonical literal MUST exist exactly once in the contract; dispatch sites MUST cite the contract path.

2. **"Do NOT return prose" guard at all three sites.** `grep -nE 'Do NOT return prose' parts/step-b.md parts/step-c-verification.md parts/contracts/codex-review.md` — expect ≥2 hits (same routing as #1 above: contract carries the directive once, B2/B3 cite by path, C4b inlines). The literal phrase is the prose-return blocker per spec.md line 264; the contract is the single authoritative copy.

3. **`codex_review_returned` event emit at all three gates.** `grep -nE '"event": *"codex_review_returned"|codex_review_returned' parts/step-b.md parts/step-c-verification.md` — expect ≥3 hits across B2 (`gate: "spec_approval"`), B3 (`gate: "plan_approval"`), C4b (`gate: "C4b"`).

4. **`raw excerpt:` ≤2KB preservation (D21).** `grep -nE 'raw excerpt:|raw_excerpt' parts/step-b.md parts/step-c-verification.md parts/contracts/codex-review.md` — expect ≥2 hits (the contract spec + at least one site cross-reference). Confirms the degraded-parse path preserves the raw text per D21.

5. **C4b recursion-skip annotation literal.** `grep -nE 'SKIPPED — codex-host recursion guard|SKIPPED -- codex-host recursion guard' parts/step-c-verification.md` — expect ≥1 hit. Confirms the codex-host recursion guard (the existing :62-63 site) renders the inline-emit annotation when it fires under codex_host_suppressed.

6. **Contract loaded by dispatch sites.** `grep -nE 'parts/contracts/codex-review.md|codex-review\.md' parts/step-b.md parts/step-c-verification.md` — expect ≥3 hits (B2 + B3 + C4b each cite the contract path inline).

On ANY failure (zero hits where ≥N expected, or grep count below threshold), halt and re-engage the relevant task. A shallow implementation must not pass this gate.

---

## Wave 3 — Doctor, tests, and self-migration

W3-T1 through W3-T4 are independent; W3-T5 is orchestrator-inline after the others commit.

### W3-T1 — `parts/doctor.md`: header + parallelization brief + Check #51 + Check #52 + severity-table rows

**Tier:** `sonnet`
**File:** `parts/doctor.md`
**Depends on:** W1-T4 (CARRY-B: W3-T1 must apply D24 tuple-compare form when copying bash bodies)

**Brief:**

FIVE edits per spec.md §`parts/doctor.md` (lines 325–584). Edit 5 was added to plan-v2 to address HIGH-2 (severity/action table drift).

**Edit 1 (line :1, header):** `#1 .. #50` → `#1 .. #52`. Append attribution line: `Checks #51–#52 added in v6.4.0 (CC-3 runtime compliance — breadcrumb-at-AUQ and summary-block emit).`

**Edit 2 (line :22, parallelization brief):** `Run the eleven repo-scoped doctor checks (#26, #30, #31, #36, #39, #44, #46, #47, #48, #49, #50)` → `Run the thirteen repo-scoped doctor checks (#26, #30, #31, #36, #39, #44, #46, #47, #48, #49, #50, #51, #52)`. Update `checks_processed` return field accordingly.

**Edit 3 (after Check #50, append Check #51):** Copy the Check #51 bash body from spec.md lines 371–462. CARRY-B application: the spec's pseudocode at spec.md line 1032 (Check #51 algorithm) uses `schema_version < 4` — but the bash body in the spec at lines 371–462 already has the correct D24 Python tuple-compare form (the spec was written post-D24). Copy the bash body from lines 371–462 verbatim — no substitution needed there. If any `< 4` int guard appears in the copied text, substitute with the D24 tuple-compare form.

**Edit 4 (after Check #51, append Check #52):** Copy the Check #52 bash body from spec.md lines 482–580. Same CARRY-B verification: copy verbatim, substitute any stale `< 4` int guard with D24 tuple-compare form. **HIGH-3 turn_id consumption:** Check #52 reads `subagents.jsonl` for model attribution. The check JOINS on the `turn_id` field that W1-T3b adds to subagents.jsonl. The bash body must use `turn_id` (not implicit timestamp matching) as the join key — verify the copied body's JOIN/correlation logic correctly uses `turn_id`. If the spec's bash body at lines 482–580 omits the `turn_id` join, ADD it: query subagents.jsonl entries by `turn_id == <events.jsonl event's turn_id>` and assert `model` field matches the model declared in the `subagent_dispatched` event for that turn. Mismatch = drift fire.

Both checks: add the post-run write-back instruction (cache result to `state.yml.cached_compliance`).

**Edit 5 (severity/action table rows — HIGH-2 fix):** The severity/action table in `parts/doctor.md` (lines ~65–117 in the current file) ends at row `| 49 |` — Check #50 (added in v6.3.3) was appended to the file as a detail body without ever getting a table row. This is exactly the anti-pattern #4 instance HIGH-2 caught. Plan-v2 fixes both: add THREE rows in one sub-edit, immediately after the `| 49 |` row and before the `---` table-end boundary.

Exact row content (matches column structure `| # | Check | Severity | --fix action |`):

```markdown
| 50 | **Plugin registry drift** — `~/.claude/plugins/installed_plugins.json` version differs from `~/.claude/plugins/marketplaces/rasatpetabit-masterplan/.claude-plugin/plugin.json` version. | Warning | Report-only; suggest updating registry pointer and restarting Claude Code. |
| 51 | **CC-3 breadcrumb-at-AUQ runtime compliance** — In the latest 20 turns (active bundle, `schema_version >= "5.1"`), the ratio of `auq_render` events preceded immediately by a `breadcrumb_emitted` event is below 0.8. | Warning | Report-only; cached to `state.yml.cached_compliance.breadcrumb_ratio`. Suggest re-running `/masterplan doctor` after authoring fixes to CC-3-trampoline if ratio is persistently low. |
| 52 | **CC-3 summary-block emit runtime compliance** — In the latest 20 turns (active bundle, `schema_version >= "5.1"`), the ratio of turns with ≥1 `subagent_dispatched` event that also have a `summary_block_emitted` event is below 0.8. Sub-fire (model attribution drift): events.jsonl `subagent_dispatched.model` mismatches `subagents.jsonl.model` for the same `turn_id`. | Warning | Report-only; cached to `state.yml.cached_compliance.summary_block_ratio`. Sub-fire (drift): report per-turn mismatches. |
```

**Verification greps:** #6, #7, #8. Additional (HIGH-2 verification): `grep -cE '^\| 5[012] \|' parts/doctor.md` → expect 3 hits (rows for 50, 51, 52). `grep -nE 'severity/action table' parts/doctor.md || grep -nE '## Severity / Action Table' parts/doctor.md` to confirm the table's anchor exists.

---

### W3-T2 — `commands/masterplan-contracts.md`: doctor.repo_scoped count update

**Tier:** `sonnet`
**File:** `commands/masterplan-contracts.md`
**Depends on:** none

**Brief:**

Three sub-edits to the `doctor.repo_scoped.schema_v1` contract block (spec.md §`commands/masterplan-contracts.md`, lines 684–695):
1. Purpose line: `eleven` → `thirteen`.
2. Algorithm prose: add `#51, #52` to the explicit check ID list.
3. `checks_processed` return field sample: add 51 and 52 to the array.

**Verification greps:** #17.

---

### W3-T3 — `docs/internals/doctor.md`: Adding-a-New-Check workflow count updates

**Tier:** `sonnet`
**File:** `docs/internals/doctor.md`
**Depends on:** none

**Brief:**

Update four count sites per spec.md §`docs/internals/doctor.md` (lines 699–711):
1. Prose intro line (~`:22`): total check count → 52.
2. Goal subsection (~`:29`): repo-scoped count `eleven` → `thirteen`.
3. Return shape array example (~`:32`): hardcoded `[26,30,31,36,39,44,46,47,48,49,50]` → add 51, 52.
4. Partial failure array example (~`:35`): same expansion.

**Verification greps:** #18.

---

### W3-T4 — Tests: doctor fixtures (check-51, check-52) + Python codex-review parser tests

**Tier:** `sonnet`
**Files:** `tests/doctor-fixtures/check-51/{pass,fail}/`, `tests/doctor-fixtures/check-52/{pass,fail}/`, `tests/test_codex_review_parse.py` (new)
**Depends on:** none

**Brief:**

**Fixture trees (check-51 and check-52).** Each fixture directory layout: `docs/masterplan/test-bundle/state.yml` (with `schema_version: "5.1"`, `slug: test-bundle`) + `events.jsonl` + optionally `subagents.jsonl` + `expected.txt`. CWD at test time is the fixture root; the bash block reads `events.jsonl` via `ls -1d docs/masterplan/*/state.yml | head -1`.

- check-51/pass: 5 turns, each with `breadcrumb_emitted` immediately before `auq_render` in events.jsonl → ratio 1.0 → `expected.txt: Check #51: PASS` (substring match).
- check-51/fail: 10 turns, 7 without breadcrumb before auq_render + 3 compliant → ratio 0.30 → `expected.txt: ERROR: Check #51:` (substring match).
- check-52/pass: 5 turns, each with `subagent_dispatched` + `summary_block_emitted` in events.jsonl → ratio 1.0 → `expected.txt: Check #52: PASS`.
- check-52/fail: 3 turns with `subagent_dispatched` but zero `summary_block_emitted` events → ratio 0.0 → `expected.txt: ERROR: Check #52:`.
- **check-52/fail-drift (NEW — HIGH-3 fix):** 5 turns, each with BOTH `subagent_dispatched` (events.jsonl) and a matching record in `subagents.jsonl` correlated by `turn_id` — so the ratio-only assertion would PASS. BUT in 3 of the 5 turns, the `model` field in events.jsonl `subagent_dispatched.model` does NOT match the `model` field in the joined `subagents.jsonl` record for the same `turn_id` (e.g., events.jsonl says `"model":"sonnet"` but subagents.jsonl says `"model":"haiku"`). Compliance ratio = 1.0 (no missing summary blocks), but the model-attribution-drift sub-fire MUST trigger. Expected: `expected.txt: ERROR: Check #52: model attribution drift` (substring match — Check #52 reports a sub-fire even when the primary ratio passes). This fixture proves the join key is `turn_id` (not implicit timestamp matching) and proves the drift sub-fire is wired. If the implementer omits the join, this fixture's `expected.txt` will not match.

Exact event jsonl shapes from spec.md lines 1142–1224. For the `fail-drift` fixture, the `subagents.jsonl` records must include the `turn_id` field that W1-T3b adds to the hook output (see W1-T3 brief) — the fixture's `subagents.jsonl` is hand-crafted to include this field even though the live hook writes it dynamically.

**Python unit test (`tests/test_codex_review_parse.py`, new file).** Self-contained: define `CodexReviewParser` class inline in the test file implementing the D5/D21/D23 algorithm from spec.md §Parse algorithm (lines 854–881). Five test functions per spec.md lines 1233–1239:
1. `test_degraded_parse_preserves_raw_excerpt` — 3 KB non-JSON input → `degraded == True`, `raw_excerpt` ≤ 2048 bytes, matches first 2048 bytes of input.
2. `test_degraded_parse_verdict_keyword_fail` — input contains `fatal` → D23 regex → `verdict == "fail"`.
3. `test_degraded_parse_verdict_keyword_warn_default` — no keywords → `verdict == "warn"`.
4. `test_degraded_parse_findings_count_via_markdown_bullets` — 5 `^\s*[-*]\s+\[?[HMLhml]\d` bullets → `findings_count == 5`.
5. `test_degraded_parse_event_record_shape` — resulting event has `degraded: true`, `raw_excerpt` (string ≤2048), `findings: []`, `dimensions: []`, `summary: "(parse failed — degraded heuristic)"`.

No external lib import — `CodexReviewParser` is defined in the test file itself. No `lib/` directory exists in this repo.

**Verification greps:** #15, #15b. Also run `bash tests/run-tests.sh --full` and confirm the python-unit-tests suite row shows PASS.

---

### W3-T5 — Self-migration: cc3-visibility bundle → schema_version "5.1" (ORCHESTRATOR-INLINE, CD-7)

**Tier:** orchestrator-inline (no subagent dispatch — CD-7 requires orchestrator to be canonical state.yml writer)
**Files:** `docs/masterplan/cc3-visibility/state.yml`, `docs/masterplan/cc3-visibility/events.jsonl`
**Depends on:** W3-T1, W3-T2, W3-T3, W3-T4 all committed (schema features must exist before self-migration)

**Brief:**

This is D22 — the cc3-visibility bundle dog-foods the schema bump. HIGH-1 fix (plan-v2 → v3): the orchestrator must apply this with **explicit backup, atomic rename, post-write YAML parse validation, and rollback-on-failure at EVERY mutating step (not just parse-validate)**. Plan-v2 scoped rollback to step 4 only, which left two regression gaps that round-2 Codex review caught (steps 5 `mv` failure and events.jsonl append failure had no rollback path; and `${ts}` shell variable lifetime across tool calls was implicit). Plan-v3 closes both with a fixed-name backup path and explicit failure-mode-per-step disposition.

**Fixed backup path (no shell-variable lifetime dependency):** `docs/masterplan/cc3-visibility/state.yml.bak.pre-v5_1-migration`. This name is stable across the entire procedure — every step that needs to reference the backup uses this literal path, NOT a `${ts}`-derived name. The orchestrator's tool-call-to-tool-call execution model means each Bash invocation is a fresh shell, so any `${ts}` set in step 1 does NOT survive to step 6. The fixed name eliminates that footgun.

Procedure (orchestrator runs each step inline; explicit failure disposition per step):

1. **Backup with fixed name.** Run:
   ```bash
   cp docs/masterplan/cc3-visibility/state.yml \
      docs/masterplan/cc3-visibility/state.yml.bak.pre-v5_1-migration
   ```
   Verify the backup exists with `ls -1 docs/masterplan/cc3-visibility/state.yml.bak.pre-v5_1-migration` (1 line expected). **Failure disposition (cp non-zero or backup missing):** halt Wave 3, do not proceed. No rollback needed — original file untouched.

2. **Read current schema.** Read `docs/masterplan/cc3-visibility/state.yml`, capture the current `schema_version` value into the orchestrator's task-tracking notes (NOT a shell variable — orchestrator carries this across tool calls). This value is the `from_schema` for the event record in step 5.

3. **Write to temp file (NOT in place).** Construct the updated YAML in memory (Edit semantics — copy current contents, set `schema_version: "5.1"` as a quoted string, add the `cached_compliance` block with `breadcrumb_ratio: null`, `summary_block_ratio: null`, `turns_audited: null`, `audited_at: null`) and write the full new contents to `docs/masterplan/cc3-visibility/state.yml.tmp`. **Failure disposition (Write tool error):** delete temp file if present (`rm -f docs/masterplan/cc3-visibility/state.yml.tmp`), halt Wave 3. No restoration needed — original file untouched.

4. **Validate the temp file via Python YAML parse.** Run:
   ```bash
   python3 -c "
   import yaml, sys
   d = yaml.safe_load(open('docs/masterplan/cc3-visibility/state.yml.tmp'))
   assert d['schema_version'] == '5.1', f'schema_version mismatch: {d.get(\"schema_version\")!r}'
   assert 'cached_compliance' in d, 'cached_compliance missing'
   cc = d['cached_compliance']
   for k in ('breadcrumb_ratio','summary_block_ratio','turns_audited','audited_at'):
       assert k in cc, f'cached_compliance.{k} missing'
       assert cc[k] is None, f'cached_compliance.{k} must be null, got {cc[k]!r}'
   print('OK')
   "
   ```
   Expect exit code 0 and `OK` on stdout. **Failure disposition (non-zero exit, AssertionError, or missing `OK`):** go to step 7 (rollback). Original file still untouched at this point, but use rollback to clean up the temp file and journal the failure event.

5. **Atomic rename.** Run `mv docs/masterplan/cc3-visibility/state.yml.tmp docs/masterplan/cc3-visibility/state.yml`. **Failure disposition (mv non-zero):** the temp file may or may not have replaced the original — restore from the fixed-name backup to guarantee consistency. Go to step 7 (rollback). Even if `mv` failed before touching the original, the rollback is safe and idempotent.

6. **Append event record.** Run:
   ```bash
   printf '{"event":"bundle_migrated_to_v5_1","from_schema":"%s","to_schema":"5.1","ts":"%s"}\n' \
     "<from-schema captured in step 2>" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     >> docs/masterplan/cc3-visibility/events.jsonl
   ```
   Substitute the literal `<from-schema captured in step 2>` with the value the orchestrator carried from step 2. **Failure disposition (printf/append fails — disk full, permission denied):** the state.yml migration already succeeded at step 5. Do NOT rollback state.yml (that would corrupt the now-valid v5.1 state). Instead, journal the failure via a second attempt to events.jsonl with `bundle_migration_event_journal_failed` — if THAT also fails, halt Wave 3 with an explicit AUQ surfacing the dual failure for human disposition. State.yml is in the correct v5.1 form; only the journal is missing.

7. **Rollback (reached on step 4 OR step 5 failure).** Run:
   ```bash
   rm -f docs/masterplan/cc3-visibility/state.yml.tmp
   cp docs/masterplan/cc3-visibility/state.yml.bak.pre-v5_1-migration \
      docs/masterplan/cc3-visibility/state.yml
   ```
   Then append a `bundle_migration_failed` event with the failure reason and the step that failed (4 or 5):
   ```bash
   printf '{"event":"bundle_migration_failed","failed_at_step":%d,"reason":"%s","ts":"%s"}\n' \
     <step> "<short reason>" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     >> docs/masterplan/cc3-visibility/events.jsonl
   ```
   Halt Wave 3, do NOT advance to Wave 4. Surface the failure via AUQ for human disposition.

**Verification (replaces the prior grep-only check):**

- `python3 -c "import yaml; d=yaml.safe_load(open('docs/masterplan/cc3-visibility/state.yml')); assert d['schema_version']=='5.1'; assert d['cached_compliance']['audited_at'] is None; print('OK')"` → expect `OK` on stdout, exit 0.
- `grep 'bundle_migrated_to_v5_1' docs/masterplan/cc3-visibility/events.jsonl` → expect ≥1 hit.
- `ls -1 docs/masterplan/cc3-visibility/state.yml.bak.pre-v5_1-migration` → expect 1 line (fixed-name backup retained for post-migration audit; can be cleaned up after Wave 4 ships).
- Negative check: `ls docs/masterplan/cc3-visibility/state.yml.tmp 2>/dev/null` → expect no output (temp file must be cleaned up by the atomic rename in step 5, or by the rollback in step 7).
- Negative check on failure-mode marker: `grep -c '"event":"bundle_migration_failed"' docs/masterplan/cc3-visibility/events.jsonl` → expect 0 on a successful migration. If ≥1, the rollback ran — investigate.

---

### Wave 3 gate verification

Run greps #6, #7, #8, #15, #15b, #17, #18. Confirm self-migration: `grep '"5.1"' docs/masterplan/cc3-visibility/state.yml`. Run `bash tests/doctor-fixtures/run.sh 2>&1 | grep -E "check-51|check-52"` (both PASS). Run `bash tests/run-tests.sh --full 2>&1 | grep test_codex_review_parse` (PASS). On any failure, halt and re-engage the relevant task.

---

## Wave 4 — Public surface and release (all four tasks independent; dispatch in parallel)

### W4-T1 — `parts/step-0.md`: CC-2.4 compliance indicator

**Tier:** `sonnet`
**File:** `parts/step-0.md`
**Depends on:** W3-T5 (schema exists; ensures the CC-2.4 banner has a real consumer)

**Brief:**

After the existing CC-2 Step 3 (Codex health indicator), add Step CC-2.4 per spec.md §`parts/step-0.md` (lines 172–191). Four conditions (all must be true): active bundle loaded, `schema_version >= "5.1"` (tuple compare), `cached_compliance` non-null, at least one ratio < 0.8. Emit one plain-text line: `↳ CC-3 compliance: WARN — <failing sub-metrics> (last K turns)`. K comes from `cached_compliance.turns_audited`, not hardcoded 20. Sub-metrics: only show the failing ones (< 0.8). Zero tool calls at boot — read only from in-memory state.yml data already loaded at Step 0.

The `schema_version < 4` guard at spec.md line 1278 (no-cache path) is a CARRY-B instance in normative prose — apply D24 tuple-compare form here: skip silently when `cached_compliance.audited_at == null` OR `schema_version < "5.1"` (tuple compare).

**Verification greps:** #9.

---

### W4-T2 — `bin/masterplan-state.sh`: schema_version "5.1" in bootstrap path

**Tier:** `sonnet`
**File:** `bin/masterplan-state.sh`
**Depends on:** none

**Brief:**

Locate the new-bundle bootstrap / creation path (around lines :418-467 in the current file). Update the state.yml template it emits to use `schema_version: "5.1"` (string, quoted) and include the `cached_compliance` stub with four fields per spec.md §`bin/masterplan-state.sh` (lines 663–679). No changes to the migrate subcommand's existing `"5.0"` targeting (that is a separate migration path for a different schema transition).

**Verification greps:** #10, #11.

---

### W4-T3 — `README.md` + `docs/verbs.md`: doctor check count updates

**Tier:** `sonnet`
**Files:** `README.md`, `docs/verbs.md`
**Depends on:** none

**Brief:**

Two count edits in `README.md` per spec.md §`README.md` (lines 715–726):
- Line `:207`: `47 proactive lint checks` → `52 proactive lint checks`.
- Line `:239`: `48 structural audits` → `52 structural audits`.

One count edit in `docs/verbs.md` (drift gap detected during Wave 1 gate verification — surface text not enumerated in plan-v3):
- Line `:26`: `Run all 47 doctor checks against the repo + active run bundles.` → `Run all 52 doctor checks against the repo + active run bundles.`

**Verification greps:** #19, plus `grep -nE 'all 4[0-9] doctor checks' docs/verbs.md` → expect 0 hits (negative discriminator confirms count was bumped).

---

### W4-T4 — Version bump + CHANGELOG entry

**Tier:** `sonnet`
**Files:** `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`
**Depends on:** none

**Brief:**

Three manifest files: set `version: "6.4.0"` in each (M3 fix: `.agents/plugins/marketplace.json` does NOT exist in this repo — do not create or reference it). Negative check: confirm `ls .agents/plugins/marketplace.json 2>/dev/null` produces no output.

Prepend CHANGELOG entry per spec.md §CHANGELOG (lines 1294–1360). Entry heading: `## v6.4.0 — CC-3 visibility (2026-05-26)`. Three sections: Added, Changed, Fixed. Also add Migration section per spec.md lines 1351–1360.

**Verification greps:** #12. Additionally (HIGH-5 plan-v2 — stale-prose negative sweep on the new CHANGELOG block):

- `grep -nE 'schema_version[^"]*< 4([^.0-9]|$)' CHANGELOG.md` → expect 0 hits. (Stale CARRY-B int-compare phrasing in narrative prose.)
- `grep -nE '(schema_version[^"]*>= 4([^.0-9]|$)|tuple-compare.*\(4,[[:space:]]*0\))' CHANGELOG.md` → expect 0 hits. (Stale int-tuple references — schema baseline is `"5.0"`, target is `"5.1"`.)
- `grep -nE '3[[:space:]]*(->|→|to)[[:space:]]*4([^.0-9]|$)' CHANGELOG.md` → expect 0 hits. (Stale "schema bump 3 → 4" prose. The historical bump was 3 → 4 in an earlier release; this release bumps 5.0 → 5.1.)

If any of these greps return hits, the CHANGELOG was written against stale schema versioning and must be rewritten before tagging v6.4.0.

---

### Wave 4 gate verification (full 24-grep sweep)

Run all 24 verification greps from spec.md lines 1368–1483 in sequence. All must pass before declaring Wave 4 complete. The full sweep covers: greps #1–#24. Additionally run `bash -n hooks/masterplan-telemetry.sh` (subsumes grep #13).

On grep #22 (`grep -nE 'schema_version:[[:space:]]+4([^.0-9]|$)'`): expect 0 hits across spec, parts/, bin/, commands/. If any hit: that is a CARRY-B instance that was not swept. Re-engage the affected task.

---

## Acceptance criteria

- All 24 verification greps from spec.md pass.
- `bash -n hooks/masterplan-telemetry.sh` exits 0.
- `bash tests/doctor-fixtures/run.sh` shows PASS for check-51 and check-52.
- `bash tests/run-tests.sh --full` shows PASS for python-unit-tests (5 functions in test_codex_review_parse.py).
- `grep '"5.1"' docs/masterplan/cc3-visibility/state.yml` exits 0 (D22 self-migration complete).
- All three manifest files show version `6.4.0`.
- `.agents/plugins/marketplace.json` does not exist.

---

## Dependency graph

```
W1-T1 (commands/masterplan.md)  ──────────────────────────────────────── Wave 2 ──┐
W1-T2 (codex-review.md)         ─── W2-T1, W2-T2, W2-T3 depend on this ──────────┤
W1-T3 (hook)                    ──────────────────────────────────────── Wave 3 ──┤
W1-T4 (spec carry-fixes)        ─── W3-T1 CARRY-B awareness depends on this ──────┤
                                                                                    │
W2-T1 (step-b.md)               ─────────────────────────────────────────────────-┤
W2-T2 (step-c-verification.md)  ─────────────────────────────────────────────────-┤
W2-T3 (step-c-resume.md)        ─────────────────────────────────────────────────-┤
W2-T4 (agent-dispatch.md)       ─────────────────────────────────────────────────-┤
                                                                                    │
W3-T1 (doctor.md)               ─────────────────────────────────────── W3-T5 ────┤
W3-T2 (masterplan-contracts.md) ─────────────────────────────────────── W3-T5 ────┤
W3-T3 (internals/doctor.md)     ─────────────────────────────────────── W3-T5 ────┤
W3-T4 (fixtures + python tests) ─────────────────────────────────────── W3-T5 ────┤
W3-T5 (self-migration, inline)  ──────── must commit before Wave 4 ───────────────┤
                                                                                    │
W4-T1 (step-0.md)               ── depends on W3-T5 ─────────────────────────────-┤
W4-T2 (bin/masterplan-state.sh) ─────────────────────────────────────────────────-┤
W4-T3 (README.md)               ─────────────────────────────────────────────────-┤
W4-T4 (manifests + CHANGELOG)   ─────────────────────────────────────────────────-┘
```

---

## Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Hook marker grammar drift — implementer uses `event=auq-render` (hyphen) vs `event=auq_render` (underscore) or adds self-closing `/>`; Check #51/#52 return SKIP permanently | Medium | High | Grep #24 explicitly checks for forbidden body-style forms; grep #16 checks for all four attribute patterns in the hook. W1-T3 brief cites spec.md line 636 on grammar rules. |
| W1-T1 layered edit ordering — implementer applies Change 1 then Change 3a sequentially, leaving intermediate text that partially matches neither form | Medium | High | W1-T1 brief is explicit: apply COMBINED final-form text from spec.md line 129 directly. Five edits not eight. Grep #23 verifies the marker-emission texts are present. |
| Python parser test file missing CodexReviewParser class — 5 tests fail immediately with NameError | Low | High | W3-T4 brief explicitly states: define CodexReviewParser inline in test file (no lib/ directory exists). |
| CARRY-B propagation failure — stale `< 4` int guard copied from spec pseudocode into parts/doctor.md Check #51/#52 bash bodies | Low | Medium | W3-T1 brief explicitly calls out CARRY-B: substitute D24 tuple-compare form when copying bash bodies. Grep #22 sweeps all target files after edits. |
| W3-T5 self-migration failure — state.yml write fails or leaves partial update | Low | High | W3-T5 is orchestrator-inline (no subagent). HIGH-1 plan-v3 closes the corruption window: fixed-name backup (`state.yml.bak.pre-v5_1-migration` — no shell-variable lifetime dependency) → temp-file write → Python YAML parse-validate → atomic mv → events.jsonl append. Step 4 (parse) OR step 5 (mv) failure both route to step 7 (rollback from the fixed-name backup). Step 6 (journal append) failure does NOT roll back the already-valid migrated state; instead double-attempts the journal write and surfaces dual-failure via AUQ. Do not advance to Wave 4 without the post-write Python assertion `schema_version == "5.1"` returning `OK`. |
| Malformed digest from a wave member — returns prose / truncated JSON / wrong field names, orchestrator parses and writes garbage into events.jsonl, downstream consumers (Checks #51/#52, CC-2.4) read corrupted state | Medium | Medium | All wave members are dispatched with explicit "Return shape:" JSON contracts in their briefs. Orchestrator MUST treat any non-JSON-parseable digest as a fail-soft event: append `{"event":"digest_parse_failed","task_id":<id>,"raw_excerpt":<≤2KB string>,"ts":<now>}` to events.jsonl (D21 raw_excerpt preservation), do NOT mutate state.yml from the malformed digest, surface via AUQ for human disposition. Cross-ref: D21 in spec.md, applies symmetrically to Codex review digests (W2 gate) and wave-member completion digests (all waves). |
| Partial wave commit — Wave N completes 3 of 4 tasks before a member fails; orchestrator has committed 3 task-completion edits to source files but the 4th never lands. Resume from Step C must NOT re-dispatch the 3 completed tasks (would create duplicate edits) nor skip the 4th (would leave a half-applied wave) | Medium | High | Per-task completion is journaled to events.jsonl as `wave_task_completed` with `task_id`, BEFORE the orchestrator advances to the next task in the wave. On Step C resume, the orchestrator reads events.jsonl to compute completed-task set and only dispatches the complement. If a wave is partially complete on resume, log `partial_wave_resume` event, re-dispatch ONLY the missing task IDs, then re-run the full wave gate (greps for that wave) before advancing. Cross-ref: CD-7 (events.jsonl is the canonical wave-progress ledger). |

---

## Critical path duration estimate

W1 (parallel, 4 tasks; W1-T3 expanded with T3b turn_id sub-task; W1-T4 expanded with 4-pattern sweep): ~55 min
W2 (parallel, 4 tasks; gate verification expanded to 6 explicit greps): ~50 min
W3 (parallel + inline step; W3-T5 expanded to 7-step backup/temp/parse/atomic/rollback procedure; W3-T4 adds check-52/fail-drift fixture): ~75 min
W4 (parallel, 4 tasks; W4-T4 adds 3 negative-grep stale-prose sweep): ~35 min
Total: ~215 minutes on critical path (excluding gate verification time)

Round-1 (plan-v1) estimate was ~195 min for the leaner brief; plan-v2/v3 adds ~20 min total across the four waves to absorb the seven Codex review findings and the two W3-T5 regression closures.

---

## Plan summary

| Metric | Value |
|---|---|
| Waves | 4 |
| Total tasks | 19 (18 dispatched + 1 orchestrator-inline) |
| Tasks per wave | W1=4, W2=4, W3=5, W4=4 |
| Pre-flight steps | 3 |
| Verification grep count | 24 |
| Carry-fix coverage | CARRY-A[W1-T4], CARRY-B[W1-T4+W3-T1+W4-T1+W4-T4], CARRY-C[W1-T3], CARRY-D[W1-T1] |
| Critical-path duration estimate | 215 minutes (plan-v3) |
| Total estimated subagent dispatches | 18 |
| Open questions for plan_approval gate | 0 |
