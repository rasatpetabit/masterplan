# Spec — CC-3 visibility (v6.4.0)

> Wire summary-block emit, enforce breadcrumb-at-AUQ, surface Codex review findings inline.

---

## Problem statement

Three runtime compliance failures observed across 8 real /masterplan transcripts (v6.3.3 baseline):

### Failure 1 — CC-3 step 1: summary-block never emitted (0/25 turns)

`commands/masterplan.md:52` (CC-3-trampoline step 1) mandates: "if `subagents_this_turn` is non-empty, emit the plain-text summary block per the per-turn dispatch tracking contract." In 25 turns that included subagent dispatches, **zero** emitted the required `Subagents this turn: N dispatched (...)` block.

Root cause: the CC-3-trampoline step 1 does not cite `parts/contracts/agent-dispatch.md` inline, so the model does not load the contract at close-site. The variable `subagents_this_turn` is implicit model-memory — never scaffolded, never reset. `parts/step-0.md:299` mentions the contract path ("per §Per-turn dispatch tracking and summary (in `parts/contracts/agent-dispatch.md`)") but only at the CC-3-trampoline anchor comment block, which is rarely re-read at close-sites in parts/*.md.

### Failure 2 — CC-3 step 3: AUQ-site breadcrumb compliance 10% (18/173 turns)

`commands/masterplan.md:55-56` specifies two breadcrumb emission sites: step-entry (after `<masterplan-trace step=X phase=in>`) and AUQ close-site (before every `AskUserQuestion` Closer). Step-entry compliance is high — `parts/step-b.md:15-22, 144-149, 233-238, 253-258` all have explicit breadcrumb emit instructions. AUQ-close-site compliance is 18/173 = 10%.

Root cause: the mandate at `commands/masterplan.md:62-83` has a "skip for routing questions" carve-out that parts/*.md have implicitly over-applied. There are ~95 AUQ close-sites across `parts/*.md`; no check audits runtime compliance. The existing Check #36 (router_ceiling_and_phase_file_sanity) only verifies static text presence, not runtime emission.

### Failure 3 — Codex review findings invisible (0/8 review sessions surfaced findings inline)

Three dispatch sites invoke Codex review:
- `parts/step-b.md:206-214` (B2 spec_approval gate)
- `parts/step-b.md:277-290` (B3 plan_approval gate — background dispatch)
- `parts/step-c-verification.md:55-131` (Step C 4b inline-work review)

All three use the same unstructured return contract at `parts/step-c-verification.md:115`: `"Return: severity-ordered findings (high/medium/low) grounded in file:line, OR the literal string 'no findings' if clean."` There is no `{verdict, dimensions, findings[]}` JSON shape. The orchestrator parses a regex heuristic (`/\b(critical|fatal|serious|blocking|fundamental|wrong assumption)\b/i` per `parts/step-b.md:211`, `parts/step-b.md:285`). Findings are digested per `parts/step-c-verification.md:119`: "drop verbose prose, parse into severity buckets" — but the digest goes only to events.jsonl; **no inline emit in chat**. Users cannot see review results without tailing events.jsonl.

---

## Solution overview

Three parallel tracks, all shipping always-on in v6.4.0:

**Track 1 — Summary-block (D1→D2, D8, D18):** Strengthen CC-3-trampoline step 1 at `commands/masterplan.md:52` to cite `parts/contracts/agent-dispatch.md` inline. Clarify `subagents_this_turn` reset semantics and add a per-step counter (`subagents_this_step`) in `parts/contracts/agent-dispatch.md:210-211`. Add Doctor Check #52 to audit runtime compliance over last N=20 turns. Add CC-2.4 boot banner line for WARN/ERROR cache hits.

**Track 2 — Breadcrumb-at-AUQ (D1, D3→D4, D15, D18):** Remove the "skip for routing questions" carve-out in CC-3-trampoline step 3, making every AUQ Closer require a breadcrumb line. Add Doctor Check #51 to audit breadcrumb-at-AUQ ratio against events.jsonl + subagents.jsonl. Add CC-2.4 boot banner line for compliance misses.

**Track 3 — Codex review inline emit (D3–D7, D12–D14, D16, D20, D21):** Define a new `parts/contracts/codex-review.md` with a structured JSON return shape. Update all three dispatch sites (B2, B3, C4b) to request and parse this shape. Emit inline `↳ codex review (...)` block immediately after each review returns, before any subsequent action. Handle parse failures gracefully (D5 degraded-parse fallback + D21 raw 2KB excerpt preservation). Persist full findings to events.jsonl (D14). Replay unaddressed reviews on resume (D16). Codex-host sites follow D20's per-site degradation table.

**Event instrumentation (D19):** Checks #51/#52 depend on four new event types (`auq_render`, `breadcrumb_emitted`, `summary_block_emitted`, `subagent_dispatched`). These are emitted by `hooks/masterplan-telemetry.sh` at Stop-hook time by scanning the existing `<masterplan-trace>` markers and assistant-text patterns the hook already tails. Single-writer: hook owns these four event types; orchestrator does NOT double-emit. `codex_review_returned` and `findings_addressed` remain orchestrator-emitted.

Schema bump: new bundles get `schema_version: "5.1"` (string) with `cached_compliance` field (D10, D24). Checks #51/#52 skip bundles at `schema_version < "5.1"` silently. The active `cc3-visibility` bundle self-migrates mid-run to dog-food the new schema (D22). Step B0's state template at `parts/step-b.md:128` is updated to write `schema_version: "5.1"` on every new bundle (closes B2 H2).

---

## Architectural decisions (referenced as D1–D23)

| ID | Decision |
|----|----------|
| D1 | Central rule change at `commands/masterplan.md` CC-3-trampoline: remove "skip for routing questions" carve-out at step 3b. Every AUQ Closer requires a breadcrumb. Add Doctor Check #51. |
| D2 | Central rule change at `commands/masterplan.md:52`: cite `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking inline. Add Doctor Check #52. |
| D3 | New file `parts/contracts/codex-review.md` defining structured `{verdict, dimensions, findings[], summary}` JSON return shape for all REVIEW dispatches. |
| D4 | Checks #51 and #52 use events.jsonl + subagents.jsonl cross-reference as evidence source. Flag count divergence as `model_attribution_drift`. |
| D5 | JSON parse failure for Codex review: append `codex_review_contract_breach` event, fall back to regex heuristic, surface inline with `(degraded-parse)` annotation. Do NOT block the gate. |
| D6 | Inline emit fires immediately after Codex review returns, before state write / summary-block / breadcrumb / AUQ. |
| D7 | Apply new contract at all 3 sites: B2 (`parts/step-b.md:206-214`), B3 (`parts/step-b.md:277-290`), C4b (`parts/step-c-verification.md:55-131`). |
| D8 | Two tracking structures: `subagents_this_turn` (list, resets per turn) and `subagents_this_step` (counter, resets per top-level Step entry). Both specified in `parts/contracts/agent-dispatch.md:210-211`. |
| D9 | Always-on; ship in v6.4.0. No opt-in flag. Document in CHANGELOG.md. |
| D10 | `schema_version: "5.1"` (string, per D24) for new bundles. Checks #51/#52 skip bundles at `schema_version < "5.1"` (e.g., legacy int `3`, string `"5.0"`). `bin/masterplan-state.sh` bootstrap path creates `"5.1"` bundles with the `cached_compliance` field. |
| D11 | Version bump to v6.4.0 in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`. (Earlier draft also listed `.agents/plugins/marketplace.json` — that file does not exist in this repo; removed per M3.) |
| D12 | Shape-check only: validate `verdict ∈ {pass, fail, warn}`, `findings` is list, `summary` is string, `dimensions` is list. No logical-invariant enforcement. |
| D13 | Under `codex_host_suppressed == true`, REVIEW dispatches route to `general-purpose` subagent at `model: sonnet`. Inline emit annotates `(sonnet-fallback)`. |
| D14 | Top-3 findings by severity inline; full list in events.jsonl. Persist via `{event: "codex_review_returned", findings, verdict, dimensions, summary}`. |
| D15 | WARN threshold < 0.80, ERROR threshold < 0.50 for both Check #51 and #52. |
| D16 | Resume scan in `parts/step-c-resume.md`: re-emit most-recent unaddressed `codex_review_returned` event as `(resumed)` annotation. Acknowledge option appends `findings_addressed` event. |
| D17 | Full pass + fail fixtures for Check #51 and #52, wired into `tests/doctor-fixtures/`. |
| D18 | Boot banner CC-2.4: if active bundle's cached Check #51/#52 ratio < 0.8, emit a 4th banner line in `parts/step-0.md`. Uses `state.yml.cached_compliance` (field added at `schema_version: "5.1"` per D24). |
| D19 | **Two distinct verbs: orchestrator EMITS markers; hook WRITES events.** The orchestrator MUST emit `<masterplan-trace event=<name> .../>` markers as inert text at the CC-3 / dispatch sites listed in the file-by-file plan. The hook `hooks/masterplan-telemetry.sh` is the single WRITER for the four new event types (`auq_render`, `breadcrumb_emitted`, `summary_block_emitted`, `subagent_dispatched`) into `events.jsonl` — it does so by scanning the transcript stream for the markers the orchestrator emitted and projecting them into typed JSONL records. Orchestrator MUST NOT directly append these four event types to `events.jsonl`; hook MUST NOT emit markers. The two verbs ("emit" = orchestrator-side textual marker; "write" = hook-side JSONL append) are non-interchangeable in this spec. Closes H1 + NEW-H2 + NEW-M2. Existing orchestrator-WRITTEN events (`codex_review_returned`, `findings_addressed`, `wave_*`, `task_*`, etc.) are unchanged. |
| D20 | **Per-site Codex-host degradation table.** When `codex_host_suppressed == true`, each REVIEW dispatch site has a defined fallback: **B2 spec review** → `general-purpose` subagent at `model: sonnet`, foreground (synchronous), annotate `(sonnet-fallback)`; **B3 plan review** → same; **C4b verification review** → SKIP entirely (defer to the existing recursion guard at `parts/step-c-verification.md:63` which already declines codex dispatch when `dispatched_by == "codex"`). `ScheduleWakeup` async pattern is N/A on Codex-host (no background scheduler). Persist `degraded_review: true` flag in the `codex_review_returned` event. Closes H4. Refines D13 (D13 stays as the policy umbrella; D20 specifies per-site behavior). |
| D21 | **Raw 2KB excerpt preservation on JSON parse failure.** When the Codex review return does not parse as JSON, preserve the first 2048 bytes of the raw text in the `codex_review_returned` event (`raw_excerpt` field) AND surface the first ~500 chars inline as `↳ codex review (B2 spec): DEGRADED — JSON parse failed; raw excerpt: <…>`. Then fall through to D5's regex heuristic for verdict extraction. Refines D5 (D5 covers fallback semantics; D21 covers evidence preservation). Closes M1. |
| D22 | **cc3-visibility bundle self-migration.** During Wave 3 (state-schema bump), the cc3-visibility bundle migrates itself from its current `schema_version` (whatever it is at migration time — likely int `3` or string `"5.0"`) → string `"5.1"` mid-run. This is the dog-fooding step — if self-migration fails, the bundle cannot ship the feature it implements. Migration appends `bundle_migrated_to_v5_1` event and writes `state.yml.schema_version: "5.1"` plus the `cached_compliance` stub. Resolves H2 (gives the bumped schema a concrete first consumer beyond the new-bundle template). |
| D23 | **Regex heuristic standardized.** When JSON parse fails, regex fallback for verdict extraction uses (case-insensitive): `\b(verdict|status)\s*[:=]\s*"?(pass|fail|warn)"?\b` (first match wins). Findings count fallback: count occurrences of `^\s*[-*]\s+\[?[HMLhml]\d` (markdown bullet with H/M/L+digit). Annotate inline with `(regex-fallback)`. Defined once here; referenced by D5 and D21. |
| D24 | **schema_version is a STRING `"5.1"`, not int `4`.** Earlier draft used int `4` (continuing the legacy pre-v5 int progression `1, 2, 3, 4`). However, the canonical run-bundle contract at `parts/contracts/run-bundle.md:21` already specifies `schema_version: "5.0"` (a quoted string, semver-shaped). To stay consistent with that contract and to allow additive bumps without colliding with the legacy int sequence, this bundle's schema bump is to string `"5.1"`. The bump is additive: it adds `cached_compliance` and nothing else. Version comparison MUST be string/tuple-aware — `int(...) < 4` no longer works. Use Python tuple compare: `tuple(int(p) for p in str(v).split('.')) < (5, 1)` (with safe fallback to `(0,)` for non-parseable values like legacy int `3`). Closes NEW-M1. |

---

## File-by-file changes

### `commands/masterplan.md`

**Current lines relevant:** CC-3-trampoline section (`:46-83`), CC-2 section (`:22-44`).

**Change 1 — CC-3 step 1: cite contract path inline (D2)**

Current text at `:52`:
```
1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per the per-turn dispatch tracking contract. Emit before any `AskUserQuestion` or terminal render. Zero-dispatch turns: skip silently.
```

Replace with:
```
1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking. Format, record shape, and reset rules defined there. Emit before any `AskUserQuestion` or terminal render. Zero-dispatch turns: skip silently.
```

Why: the contract path must be cited inline so the model loads it at close-site. The current reference at `parts/step-0.md:299` is only visible when that anchor is re-read.

**Change 2 — CC-3 step 3: remove routing-question carve-out (D1)**

Current text at `:56`:
```
- **AUQ close-site** — before every `AskUserQuestion` Closer (skip for `ScheduleWakeup` and non-interactive terminal renders).
```

Replace with:
```
- **AUQ close-site** — before every `AskUserQuestion` Closer. No routing-question exception — every AUQ requires a breadcrumb line. (Skip only for `ScheduleWakeup` and non-interactive terminal renders that never surface to the user.)
```

Why: the implicit "skip for routing questions" carve-out was over-applied to suppress 90% of AUQ close-sites. The breadcrumb is cheap and aids navigation; there is no valid reason to omit it.

**Change 3 — Embed `<masterplan-trace>` marker emission in the CC-3-trampoline sequence (D19, closes NEW-H2)**

This is the concrete patch set that gives the four new event types a textual emission point. Per D19, the orchestrator EMITS markers; the hook WRITES JSONL rows by scanning them. Without these embedded marker instructions, the hook has nothing to scan and Checks #51/#52 forever return SKIP.

**Change 3a — Step 1 (summary block) gains a marker-after-emit clause.**

Current text at `:52`:
```
1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking. Format, record shape, and reset rules defined there. Emit before any `AskUserQuestion` or terminal render. Zero-dispatch turns: skip silently.
```
(This text reflects Change 1 above; Change 3a layers on top.)

Replace with:
```
1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking. Format, record shape, and reset rules defined there. Emit before any `AskUserQuestion` or terminal render. Immediately after the summary block, emit the marker `<masterplan-trace event=summary_block_emitted dispatch_count=<N>>` on its own line (where `<N>` = `len(subagents_this_turn)`); this is the inert textual signal the Stop hook scans to write the corresponding `events.jsonl` row (D19). Zero-dispatch turns: skip silently — emit neither block nor marker.
```

**Change 3b — Step 3 (breadcrumb) gains a marker-after-line clause at BOTH sites.**

Current text at `:54-56` (after Change 2):
```
3. **Breadcrumb render** — emit one plain-text navigation line at **two** sites so the breadcrumb survives manual interruption:
   - **Step entry** — immediately after each `<masterplan-trace step=X phase=in>` marker (every step that emits a phase-in trace must follow it with the breadcrumb on the next line).
   - **AUQ close-site** — before every `AskUserQuestion` Closer. No routing-question exception — every AUQ requires a breadcrumb line. (Skip only for `ScheduleWakeup` and non-interactive terminal renders that never surface to the user.)
```

Replace with:
```
3. **Breadcrumb render** — emit one plain-text navigation line at **two** sites so the breadcrumb survives manual interruption. After each breadcrumb line, emit `<masterplan-trace event=breadcrumb_emitted site=<tag>>` on its own line as the inert textual signal for the Stop hook (D19; the hook converts this to an `events.jsonl` row used by Check #51).
   - **Step entry** — immediately after each `<masterplan-trace step=X phase=in>` marker (every step that emits a phase-in trace must follow it with the breadcrumb on the next line, then the `breadcrumb_emitted` marker on the line after that with `site=step-entry-<phase>`).
   - **AUQ close-site** — before every `AskUserQuestion` Closer. No routing-question exception — every AUQ requires a breadcrumb line, followed by the `breadcrumb_emitted` marker with `site=auq-close-<gate>` (or `site=auq-close-routing` for non-gate AUQs like the plan picker). (Skip only for `ScheduleWakeup` and non-interactive terminal renders that never surface to the user.)
```

**Change 3c — Step 4 (Closer) gains a pre-AUQ marker.**

Current text at `:69`:
```
4. **Closer** — fire the `AskUserQuestion`, `ScheduleWakeup`, or terminal render that ends the turn.
```

Replace with:
```
4. **Closer** — fire the `AskUserQuestion`, `ScheduleWakeup`, or terminal render that ends the turn. **Before** any `AskUserQuestion` tool call, emit `<masterplan-trace event=auq_render site=<tag>>` on its own line (use the same `<tag>` from the preceding breadcrumb's `site=auq-close-<gate>`, normalized — e.g., `b2-spec-approval`, `b3-plan-approval`, `c4b-failure`, `routing-plan-picker`). This is the hook-side signal that drives Check #51's AUQ-side counter (D19). Skip for `ScheduleWakeup` and non-interactive renders (they never present an AUQ to the user).
```

**Change 3d — General rule: every subagent dispatch site gets a marker.**

This rule is added to the CC-3-trampoline section as a new paragraph immediately after the numbered sequence (between the current `> CC-1 compact-suggest…` note at `:71` and the verb dispatch table at `:73`):

```
**Subagent-dispatch marker rule (D19).** Every site that invokes the `Agent`, `Task`, `codex:codex-rescue`, `WebFetch`, or any other dispatch-class tool MUST emit `<masterplan-trace event=subagent_dispatched type=<subagent_type> model=<model> task=<short-label>>` on its own line immediately before the dispatch tool call. `<subagent_type>` matches the tool's `subagent_type` parameter (e.g., `Explore`, `general-purpose`, `Plan`, `feature-dev:code-architect`, `codex:codex-rescue`). `<model>` matches the dispatched tier (`haiku`, `sonnet`, `opus`, or `codex` for codex dispatches). `<short-label>` is a kebab-case identifier ≤32 chars (e.g., `grep-batch`, `B2-spec-review`, `wave-1-task-3`). The Stop hook converts each marker to an `events.jsonl` row that Check #52 cross-references against `subagents.jsonl` for drift detection (D4). This rule is referenced from `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking; the marker MUST be emitted in addition to (not instead of) the `subagents_this_turn` list append.
```

Why (for all of 3a-3d): without these embedded marker emission instructions in the CC-3-trampoline (the single section every turn flows through), the model has no scaffold for emitting the four marker subtypes. Putting the instructions in the trampoline — not scattered across 95 AUQ sites in parts/*.md — is the same architectural choice that closes the original CC-3 non-compliance: single source of truth, single re-read point. The site-specific tag values (`b2-spec-approval`, `c4b-failure`, etc.) are emitted by the parts/*.md callers via the breadcrumb's `{gate-id}` already required by CC-3 step 3 — no new per-site work.

---

### `parts/step-0.md`

**Change — CC-2.4 compliance indicator (D18)**

After the existing CC-2 Step 3 (Codex health indicator, ending at `:44` in `commands/masterplan.md` / corresponding text in `parts/step-0.md`), add a Step CC-2.4 block:

```markdown
**Step CC-2.4 — CC-3 compliance indicator (v6.4.0+).** Fires ONLY when ALL of:
- An active bundle is loaded AND `state.yml.schema_version >= "5.1"`.
- `state.yml.cached_compliance` is present (set by the last `/masterplan doctor` run).
- `cached_compliance.breadcrumb_ratio < 0.8` OR `cached_compliance.summary_block_ratio < 0.8`.

Emit ONE plain-text line (plain stdout, NOT inside CC-3-trampoline):
```
↳ CC-3 compliance: WARN — breadcrumb-at-AUQ N% (last K turns) / summary-block M% (last K turns)
```
Omit any sub-metric that is >= 0.8 (only show the failing ones). If no cache present or schema < 4: skip silently. Do NOT run an audit during boot — too expensive. Use only the cached ratio from `state.yml.cached_compliance`.
```

Why: surfaces a compliance problem at the top of every turn when known-bad, without requiring the user to run `/masterplan doctor`.

---

### `parts/step-b.md`

**Change 0 — Fix H2: schema_version: "5.1" in the new-bundle template (D10, D22)**

Line `:128` currently hardcodes a pre-`"5.1"` state.yml template (legacy int `schema_version: 3`) emitted by the bootstrap path. Update the template so new bundles are created at `schema_version: "5.1"` (string, per D24) directly:
```yaml
schema_version: "5.1"              # was: 3
cached_compliance:             # NEW field (D18) — populated by /masterplan doctor; empty until first doctor run
  breadcrumb_ratio: null
  summary_block_ratio: null
  window_turns: null
  last_audit_ts: null
```
Existing bundles at any `schema_version < "5.1"` (legacy int `3`, string `"5.0"`, etc.) continue to function (Checks #51/#52 skip them per D10); a separate `/masterplan migrate` invocation can upgrade them. The cc3-visibility bundle itself self-migrates mid-run per D22 — see Wave 3 plan.

**Change 1 — B2 spec gate: structured Codex review (D3, D5–D7, D20, D21)**

Lines `:206-214` currently run `node "<companion-path>" adversarial-review ...` and capture raw prose parsed by regex. Replace steps 3–5 with the structured review contract.

New step 3 (foreground review, B2 spec gate):
```
3. **Run foreground review.** Append `{"event":"adversarial_review_started","gate":"spec_approval","ts":"<now>","artifact":"<slug>/spec.md"}`. Dispatch REVIEW per `parts/contracts/codex-review.md` §Dispatch brief template, setting `gate: "B2 spec"` and `artifact: "docs/masterplan/<slug>/spec.md"`. When `codex_host_suppressed == true`, route to `general-purpose` subagent at `model: sonnet`, foreground, per §Codex-host fallback (D20) in that contract; set `degraded_review: true` in the resulting `codex_review_returned` event.
```

New step 4 (parse + inline emit, B2 spec gate):
```
4. **Parse and emit.** Parse the review return per `parts/contracts/codex-review.md` §Parse algorithm. On JSON parse failure (D5, D21): preserve the first 2048 bytes of raw return in `raw_excerpt`, run the D23 regex fallback for verdict and findings count, and annotate inline with `(degraded-parse)`. Immediately emit the inline status block (D6 — before state write, before AUQ):
   ↳ codex review (B2 spec[, degraded-parse][, sonnet-fallback]): <VERDICT> — <N> findings
     • [<sev>] <file>:<line> — <issue>       (top-3 by severity)
     [+ N more in events.jsonl]
   On degraded-parse, append a second inline line: `raw excerpt: <first ~500 chars of raw_excerpt>`.
   Append `{"event":"codex_review_returned","gate":"spec_approval","verdict":"<v>","dimensions":[...],"findings":[...full list...],"summary":"<s>","raw_excerpt":"<≤2KB or null>","degraded_review":<bool>,"ts":"<now>"}`.
```

New step 5 (unchanged — gate routing override for aggressive-loose):
```
5. **Gate routing override (aggressive-loose + pass only).** [existing text unchanged]
```

Why: the regex heuristic silently drops all review content. The structured contract makes findings visible in chat immediately.

**Change 2 — B3 plan gate: structured Codex review (D3, D5–D7, D20, D21)**

Lines `:277-290` currently run a background review via `ScheduleWakeup` and parse the log file with regex on resume. The background dispatch timing is unchanged when running on Claude Code (Codex-host has no async scheduler — see D20: B3 falls back to foreground Sonnet review when `codex_host_suppressed == true`); only the parse + emit on resume changes.

In step 5 (on resume), replace the regex parse block:
```
If complete: read logFile contents (first 8192 chars) as `review_output`. Parse per `parts/contracts/codex-review.md` §Parse algorithm. On JSON parse failure (D5, D21): preserve first 2048 bytes of raw return in `raw_excerpt`, apply D23 regex fallback, annotate `(degraded-parse)`. Immediately emit inline status block (D6 — before clearing pending_gate, before AUQ):
   ↳ codex review (B3 plan[, degraded-parse][, sonnet-fallback]): <VERDICT> — <N> findings
     • [top-3]
   On degraded-parse, append `raw excerpt: <first ~500 chars>` line.
Append `{"event":"codex_review_returned","gate":"plan_approval","verdict":"<v>","dimensions":[...],"findings":[...],"summary":"<s>","raw_excerpt":"<≤2KB or null>","degraded_review":<bool>,"ts":"<now>"}`. Clear `pending_gate` and `adversarial_review_plan_pending_job`. Proceed to B3 close-out gate.
```

Why: plan gate findings were equally invisible. Background timing is acceptable (the review runs while the user does other work); the parse on resume is the fix point. On Codex-host, the foreground Sonnet fallback (D20) runs synchronously — no resume step; emit immediately at dispatch return.

---

### `parts/step-c-verification.md`

**Change — Step C 4b: structured Codex review + inline emit (D3, D5–D7, D20, D21)**

Codex-host behavior (D20): when `codex_host_suppressed == true` AND `dispatched_by == "codex"`, **SKIP** the C4b review entirely — the existing recursion guard at `parts/step-c-verification.md:63` already declines codex:codex-rescue under this condition. No Sonnet fallback at C4b (the parent Codex invocation has already done the verification work; a second pass would be redundant). Annotate the gate decision inline as `↳ codex review (C4b): SKIPPED — codex-host recursion guard`.

Lines `:101-119`: dispatch brief and digest rules.

In step 2 dispatch brief (`:101-116`), replace the `Return:` line:
```
Return: JSON matching the contract in parts/contracts/codex-review.md §Return JSON shape.
        Schema: {"verdict": "pass"|"fail"|"warn", "dimensions": [...], "findings": [{"severity":"high"|"medium"|"low","file":"<path>","line":<int>,"issue":"<text>"}], "summary":"<1-2 line gist>"}
        If findings list is empty, return it as []. Do NOT return prose.
```

Replace step 3 (`:119`) "Digest the response...":
```
3. **Parse and emit inline.** Parse the return per `parts/contracts/codex-review.md` §Parse algorithm. On JSON parse failure (D5, D21): preserve first 2048 bytes in `raw_excerpt`, apply D23 regex fallback, annotate `(degraded-parse)`. Immediately (D6 — before decision matrix, before state write) emit:
   ↳ codex review (C4b[, degraded-parse]): <VERDICT> — <N> findings
     • [top-3 by severity]
   On degraded-parse, append `raw excerpt: <first ~500 chars>` line.
   Append `{"event":"codex_review_returned","gate":"C4b","task":"<task name>","verdict":"<v>","dimensions":[...],"findings":[...full list...],"summary":"<s>","raw_excerpt":"<≤2KB or null>","ts":"<now>"}`.
4. **Decision matrix by autonomy** [existing `:120-130` text — unchanged].
```

Why: C4b was the original invisible-review site. This fix mirrors the B2/B3 changes and closes the full surface.

---

### `parts/step-c-resume.md`

**Change — Resume-time unaddressed review replay (D16)**

After the TaskCreate rehydration / drift-recovery block (around line `:39-54`), add a new section:

```markdown
**Codex review resume replay (v6.4.0+).** After rehydration completes (schema_version >= "5.1" only):

1. Tail-scan `events.jsonl` for the most recent `{"event":"codex_review_returned",...}` entry.
2. If found, check whether any later `{"event":"findings_addressed",...}` entry exists for the same `gate` value.
3. If no `findings_addressed` found → unaddressed review is pending. Re-emit the inline status block annotated with `(resumed)`:
   ```
   ↳ codex review (<gate>, resumed): <VERDICT> — <N> findings
     • [top-3 by severity]
   ```
   Add an explicit option to the first AUQ of this resume turn: `"Acknowledge findings — mark as addressed (appends findings_addressed event)"`.
4. If `findings_addressed` found → skip replay silently.
5. On "Acknowledge findings" selection: append `{"event":"findings_addressed","gate":"<gate>","ts":"<now>","by":"user-ack"}` to events.jsonl. Do NOT suppress the pending gate or alter review_result — the acknowledgement is informational, not an approval.

Schema guard: if `state.yml.schema_version < 4`, skip this section silently.
```

Why: compaction destroys the inline emit from the prior turn. The resume replay ensures findings survive across session boundaries.

---

### `parts/step-c-dispatch.md`

**Change — No structural changes required.**

The spec-trace propagation and wave assembly do not need changes. Codex review under wave (4b) is handled by `parts/step-c-verification.md`. Note for plan authors: ensure that the structured return contract is propagated into any wave-member Codex review brief templates.

---

### `parts/step-c-completion.md`

**Change — No structural changes required.**

The final commit + retro trigger flow is unaffected. The `codex_review_returned` events appended during Step C 4b are already persisted before this file is entered.

---

### `parts/doctor.md`

**Change 1 — Header comment: add Checks #51 and #52 attribution line**

Current `:1`:
```
# Doctor — Self-Host Checks (#1 .. #50)
```
Replace with:
```
# Doctor — Self-Host Checks (#1 .. #52)
```

Current attribution text (end of first line):
```
Check #50 added in v6.3.3 (plugin registry drift ...)
```
Append:
```
Checks #51–#52 added in v6.4.0 (CC-3 runtime compliance — breadcrumb-at-AUQ and summary-block emit).
```

**Change 2 — Parallelization brief: add Checks #51 and #52 to repo-scoped count**

Current `:22` (repo-scoped dispatch brief) lists eleven checks: `#26, #30, #31, #36, #39, #44, #46, #47, #48, #49, #50`. Update to thirteen:
- Brief text: `Run the thirteen repo-scoped doctor checks (#26, #30, #31, #36, #39, #44, #46, #47, #48, #49, #50, #51, #52)`
- `checks_processed` return field: `[26, 30, 31, 36, 39, 44, 46, 47, 48, 49, 50, 51, 52]`
- `contract_id` stays `"doctor.repo_scoped.schema_v1"` (the schema_v1 contract is extended, not versioned here — consistent with prior additions of #49 and #50)

Why: Checks #51 and #52 are repo-scoped (read events.jsonl + subagents.jsonl from active bundles), not per-worktree per-bundle.

**Change 3 — Add Check #51 body**

Append after Check #50 (`:1729`):

```markdown
## Check #51 — CC-3 breadcrumb-at-AUQ runtime compliance

**Severity:** Warning (ratio < 0.80) / Error (ratio < 0.50)
**Action:** Report-only. Caches result to `state.yml.cached_compliance.breadcrumb_ratio` for CC-2.4 boot indicator.
**Scope:** Active bundles with `schema_version >= "5.1"` (string tuple compare per D24). Fires once per doctor run. Skips legacy bundles (`schema_version < "5.1"`) silently.
**Added:** v6.4.0 (CC-3 breadcrumb-at-AUQ compliance audit).

Scans the active bundle's `events.jsonl` for `auq_render` events, computes `breadcrumb_preceded / total` ratio over the most recent N=20 turns. Cross-references against `subagents.jsonl` for ground-truth dispatch counts.

Algorithm: For each `auq_render` event in the last 20 assistant turns (defined as events between successive `turn_start` events), check whether the preceding event in the same turn was a `breadcrumb_emitted` event. Count compliant / total. If any turn in `subagents.jsonl` has a dispatch count that does not match what `events.jsonl` implies, append `model_attribution_drift` note.

```bash
# Check #51 — CC-3 breadcrumb-at-AUQ runtime compliance.
# Fixture runner contract (tests/doctor-fixtures/run.sh): invoked via `bash -c "$block"` with
# NO positional arguments and cwd = fixture directory. Locate state.yml by glob, not $1.
STATE_FILE="$(ls -1d docs/masterplan/*/state.yml 2>/dev/null | head -1)"
[ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ] || { echo "Check #51: SKIP (no state.yml found under docs/masterplan/*/state.yml)"; exit 0; }
events_file="${STATE_FILE%state.yml}events.jsonl"

# D24: schema_version is a STRING (e.g. "5.1"); int-style `-lt 4` won't work.
# Use Python tuple compare with safe fallback for non-parseable legacy ints.
skip_check="$(python3 - "$STATE_FILE" <<'PYEOF'
import yaml, sys
try:
    with open(sys.argv[1]) as f:
        s = yaml.safe_load(f) or {}
    v = s.get('schema_version', '0')
    try:
        parts = tuple(int(p) for p in str(v).split('.'))
    except ValueError:
        parts = (0,)
    print('skip' if parts < (5, 1) else 'run')
except Exception:
    print('skip')
PYEOF
)"

if [ "$skip_check" = "skip" ]; then
  echo "Check #51: SKIP (schema_version < \"5.1\", pre-v6.4.0 bundle)"
elif [ ! -f "$events_file" ]; then
  echo "Check #51: SKIP (no events.jsonl at $events_file)"
else
  result="$(python3 - "$events_file" <<'PYEOF'
import json, sys
events_file = sys.argv[1]
events = []
with open(events_file) as f:
    for line in f:
        line = line.strip()
        if line:
            try: events.append(json.loads(line))
            except: pass

# Split into turns (between turn_start events)
turns = []
current = []
for e in events:
    if e.get('event') == 'turn_start':
        if current: turns.append(current)
        current = [e]
    else:
        current.append(e)
if current: turns.append(current)

# Last 20 turns
turns = turns[-20:]
total_auq = 0
compliant = 0
for turn in turns:
    for i, e in enumerate(turn):
        if e.get('event') == 'auq_render':
            total_auq += 1
            if i > 0 and turn[i-1].get('event') == 'breadcrumb_emitted':
                compliant += 1

if total_auq == 0:
    print("SKIP:no_auq_renders")
else:
    ratio = compliant / total_auq
    print(f"RATIO:{ratio:.3f}:{compliant}:{total_auq}")
PYEOF
)"

  if echo "$result" | grep -q "^SKIP:"; then
    reason="${result#SKIP:}"
    echo "Check #51: SKIP ($reason in last 20 turns)"
  else
    ratio_str="${result#RATIO:}"
    ratio_val="${ratio_str%%:*}"
    rest="${ratio_str#*:}"
    compliant_n="${rest%%:*}"
    total_n="${rest#*:}"
    ratio_pct="$(python3 -c "print(f'{float($ratio_val)*100:.0f}')")"
    if python3 -c "import sys; sys.exit(0 if float('$ratio_val') >= 0.80 else 1)"; then
      echo "Check #51: PASS (breadcrumb-at-AUQ ${ratio_pct}% — ${compliant_n}/${total_n} AUQ events in last 20 turns)"
    elif python3 -c "import sys; sys.exit(0 if float('$ratio_val') >= 0.50 else 1)"; then
      echo "WARN: Check #51: breadcrumb-at-AUQ compliance ${ratio_pct}% (${compliant_n}/${total_n}) — below 80% threshold"
    else
      echo "ERROR: Check #51: breadcrumb-at-AUQ compliance ${ratio_pct}% (${compliant_n}/${total_n}) — below 50% error threshold"
    fi
  fi
fi
```

After running, cache result to `state.yml.cached_compliance.breadcrumb_ratio = <ratio_val>` and `cached_compliance.turns_audited = <total_n>` and `cached_compliance.audited_at = <now>`. Report-only; `fix_available: false`.
```

**Change 4 — Add Check #52 body**

Append after Check #51:

```markdown
## Check #52 — CC-3 summary-block runtime compliance

**Severity:** Warning (ratio < 0.80) / Error (ratio < 0.50)
**Action:** Report-only. Caches result to `state.yml.cached_compliance.summary_block_ratio`.
**Scope:** Active bundles with `schema_version >= "5.1"` (string tuple compare per D24). Fires once per doctor run. Skips legacy bundles (`schema_version < "5.1"`) silently.
**Added:** v6.4.0 (CC-3 summary-block emit compliance audit).

For each turn in `events.jsonl` with one or more `subagent_dispatched` events, verify the assistant message text (captured via `assistant_message_text` event if present, or inferred from turn context) contains a `Subagents this turn: N dispatched` line. Cross-references against `subagents.jsonl` for ground-truth dispatch counts; flags count divergence as `model_attribution_drift`.

```bash
# Check #52 — CC-3 summary-block runtime compliance.
# Fixture runner contract: cwd = fixture dir, no positional args. Locate state.yml by glob.
STATE_FILE="$(ls -1d docs/masterplan/*/state.yml 2>/dev/null | head -1)"
[ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ] || { echo "Check #52: SKIP (no state.yml found under docs/masterplan/*/state.yml)"; exit 0; }
events_file="${STATE_FILE%state.yml}events.jsonl"
subagents_file="${STATE_FILE%state.yml}subagents.jsonl"

# D24: schema_version is a STRING; tuple compare with safe fallback.
skip_check="$(python3 - "$STATE_FILE" <<'PYEOF'
import yaml, sys
try:
    with open(sys.argv[1]) as f:
        s = yaml.safe_load(f) or {}
    v = s.get('schema_version', '0')
    try:
        parts = tuple(int(p) for p in str(v).split('.'))
    except ValueError:
        parts = (0,)
    print('skip' if parts < (5, 1) else 'run')
except Exception:
    print('skip')
PYEOF
)"

if [ "$skip_check" = "skip" ]; then
  echo "Check #52: SKIP (schema_version < \"5.1\", pre-v6.4.0 bundle)"
elif [ ! -f "$events_file" ]; then
  echo "Check #52: SKIP (no events.jsonl at $events_file)"
else
  result="$(python3 - "$events_file" "$subagents_file" <<'PYEOF'
import json, sys, os

events_file = sys.argv[1]
subagents_file = sys.argv[2] if len(sys.argv) > 2 else None

events = []
with open(events_file) as f:
    for line in f:
        line = line.strip()
        if line:
            try: events.append(json.loads(line))
            except: pass

# Split into turns
turns = []
current = []
for e in events:
    if e.get('event') == 'turn_start':
        if current: turns.append(current)
        current = [e]
    else:
        current.append(e)
if current: turns.append(current)

turns = turns[-20:]
turns_with_dispatch = 0
compliant = 0

for turn in turns:
    dispatch_count = sum(1 for e in turn if e.get('event') == 'subagent_dispatched')
    if dispatch_count == 0:
        continue
    turns_with_dispatch += 1
    has_summary = any(
        e.get('event') == 'summary_block_emitted' or
        'Subagents this turn' in str(e.get('text', ''))
        for e in turn
    )
    if has_summary:
        compliant += 1

if turns_with_dispatch == 0:
    print("SKIP:no_dispatch_turns")
else:
    ratio = compliant / turns_with_dispatch
    print(f"RATIO:{ratio:.3f}:{compliant}:{turns_with_dispatch}")
PYEOF
)"

  if echo "$result" | grep -q "^SKIP:"; then
    reason="${result#SKIP:}"
    echo "Check #52: SKIP ($reason in last 20 turns)"
  else
    ratio_str="${result#RATIO:}"
    ratio_val="${ratio_str%%:*}"
    rest="${ratio_str#*:}"
    compliant_n="${rest%%:*}"
    total_n="${rest#*:}"
    ratio_pct="$(python3 -c "print(f'{float($ratio_val)*100:.0f}')")"
    if python3 -c "import sys; sys.exit(0 if float('$ratio_val') >= 0.80 else 1)"; then
      echo "Check #52: PASS (summary-block compliance ${ratio_pct}% — ${compliant_n}/${total_n} dispatch-turns in last 20 turns)"
    elif python3 -c "import sys; sys.exit(0 if float('$ratio_val') >= 0.50 else 1)"; then
      echo "WARN: Check #52: summary-block compliance ${ratio_pct}% (${compliant_n}/${total_n}) — below 80% threshold"
    else
      echo "ERROR: Check #52: summary-block compliance ${ratio_pct}% (${compliant_n}/${total_n}) — below 50% error threshold"
    fi
  fi
fi
```

After running, cache result to `state.yml.cached_compliance.summary_block_ratio = <ratio_val>`. Report-only; `fix_available: false`.
```

---

### `parts/contracts/agent-dispatch.md`

**Change — Dual-structure reset semantics (D8)**

Current lines `:210-211`:
```
The orchestrator MUST maintain a session-local `subagents_this_turn` list.
Reset at the start of every top-level Step entry (A, B, C, I, S, R, D, CL).
```

Replace with:
```
The orchestrator MUST maintain TWO tracking structures:

**`subagents_this_turn`** — list of dispatch records. Resets at the start of every assistant turn (before the CC-2 banner and before the first tool call of each turn). Drives the CC-3 step 1 summary block.

**`subagents_this_step`** — running counter. Resets at the start of every top-level Step entry (A, B, C, I, S, R, D, CL). Feeds telemetry roll-up and `/masterplan stats`. Does NOT reset between assistant turns within a session — it accumulates across turns within a step.
```

Why: the prior spec was ambiguous about turn-level vs step-level reset boundaries. The 0/25 compliance failure suggests models were treating turn-reset as step-reset or skipping reset entirely.

---

### `parts/contracts/codex-review.md` (NEW FILE)

See "New contract" section below for full draft.

---

### `hooks/masterplan-telemetry.sh`

**Change — Hook becomes the single writer for the four new event types (D19, closes H1).**

The prior spec assumed the orchestrator prompt would emit `auq_render`, `breadcrumb_emitted`, `summary_block_emitted`, and `subagent_dispatched` events to `events.jsonl`. That is incorrect: there is no orchestrator-side code path to append those events, and adding inline emission instructions to every Closer / AUQ / dispatch site is brittle (the same root cause as CC-3 non-compliance). **Per D19, the Stop hook is the single writer for these four event types.**

The hook already tails the assistant transcript and parses `<masterplan-trace>` markers (current implementation around `:631+`). Extend the parser to recognize five marker subtypes and append a corresponding event per marker to the active bundle's `events.jsonl`. The orchestrator emits ONLY markers — it does NOT append these event types directly.

**Marker grammar (extended).** The hook's existing marker grammar is **attribute-on-tag, single open tag** (no closing tag, no self-closing slash) — see `hooks/masterplan-telemetry.sh:84-88` (`file-load path=<p> bytes=<n>`) and `:641-647` (turn-trace `step=<x> phase=<in|out>`). The four new markers MUST follow the same shape so the existing extraction regex `grep -oE '<masterplan-trace [^>]+>'` picks them up unchanged.

Add the following recognized marker shapes (existing markers like `gate=fire`, `step=`, `skill-invoke`, `state-write` remain unchanged):

| Marker text in transcript | Hook action |
|---|---|
| `<masterplan-trace event=auq_render site=<site-tag>>` | Append `{"event":"auq_render","site":"<site-tag>","turn_id":"<id>","ts":"<now>"}` |
| `<masterplan-trace event=breadcrumb_emitted site=<site-tag>>` | Append `{"event":"breadcrumb_emitted","site":"<site-tag>","turn_id":"<id>","ts":"<now>"}` |
| `<masterplan-trace event=summary_block_emitted dispatch_count=<n>>` | Append `{"event":"summary_block_emitted","dispatch_count":<n>,"turn_id":"<id>","ts":"<now>"}` |
| `<masterplan-trace event=subagent_dispatched type=<type> model=<model> task=<short>>` | Append `{"event":"subagent_dispatched","type":"<type>","model":"<model>","task":"<short>","turn_id":"<id>","ts":"<now>"}` |

`<turn_id>` is the hook's existing per-turn UUID (already computed for `subagents.jsonl`). `<site-tag>` is a short identifier (e.g., `b2-gate`, `c4b-failure`, `step-0-routing`) emitted by the orchestrator at the marker site. Marker grammar rules: attribute values are unquoted token strings (no spaces inside a single value; use kebab/snake-case); the tag has NO body and NO self-closing slash (matches the hook's existing `<masterplan-trace step=X>` style).

**Active-bundle resolution.** The hook already resolves the active bundle path for `subagents.jsonl` writes. Reuse that resolution; append to `<active-bundle>/events.jsonl` using the same atomic-append pattern. If no active bundle is loaded, drop the event silently (no-op) — same fallback as today.

**Cross-validation source.** Check #51 reads `breadcrumb_emitted` + `auq_render` from `events.jsonl`. Check #52 reads `summary_block_emitted` + `subagent_dispatched` from `events.jsonl`. The hook's existing `subagents.jsonl` remains the ground-truth oracle for subagent counts — Checks #51/#52 cross-reference the two to detect drift (`model_attribution_drift` per D4).

**Orchestrator marker emission.** The orchestrator MUST emit attribute-on-tag `<masterplan-trace event=… …>` markers at the sites below (these are NOT direct `events.jsonl` appends — the hook is the single writer per D19):

- Every `AskUserQuestion` Closer → emit `<masterplan-trace event=auq_render site=<tag>>` on its own line immediately before the AUQ tool call.
- Every CC-3 breadcrumb emit (the `/masterplan {verb} › ...` navigation line, both at step-entry and at AUQ close-site) → emit `<masterplan-trace event=breadcrumb_emitted site=<tag>>` on the line immediately after the breadcrumb text.
- Every CC-3 summary-block emit (the `Subagents this turn: N dispatched (...)` block) → emit `<masterplan-trace event=summary_block_emitted dispatch_count=<n>>` on the line immediately after the summary block.
- Every Agent / Task / codex dispatch → emit `<masterplan-trace event=subagent_dispatched type=<type> model=<model> task=<short>>` on a line immediately before the dispatch tool call.

Concrete examples (showing the literal tag form):
```
<masterplan-trace event=auq_render site=b2-spec-approval>
<masterplan-trace event=breadcrumb_emitted site=auq-close-spec-approval>
<masterplan-trace event=summary_block_emitted dispatch_count=3>
<masterplan-trace event=subagent_dispatched type=general-purpose model=sonnet task=B2-spec-review>
```

Markers are inert text — they do not call tools. They survive transcript capture and are parsed by the Stop hook offline. They use the SAME tag grammar as the existing `<masterplan-trace step=X phase=in>` and `<masterplan-trace file-load path=P bytes=N>` markers — attribute-on-tag, no body, no self-closing slash. The hook's existing extraction regex `<masterplan-trace [^>]+>` matches them without modification; only the per-attribute parser branch is new.

**Verification.** `bash -n hooks/masterplan-telemetry.sh` for syntax. Smoke test: run a turn with one AUQ + one dispatch; confirm `events.jsonl` gains exactly one `auq_render`, one `breadcrumb_emitted`, one `summary_block_emitted`, and one `subagent_dispatched` entry, and that the `turn_id` matches across all four.

---

### `bin/masterplan-state.sh`

**Change — `schema_version: "5.1"` in bootstrap path (D10, D24)**

The `migrate-state` subcommand currently targets `"5.0"` (plan-format migration). The bundle creation / bootstrap path for new bundles must set `schema_version: "5.1"`.

Locate the section where new `state.yml` content is written (around `:418-467` the migration path; the bootstrap for new bundles should be nearby or in a separate `bootstrap` subcommand). Add:

```bash
schema_version: "5.1"
cached_compliance:
  breadcrumb_ratio: null
  summary_block_ratio: null
  turns_audited: 0
  audited_at: null
```

For existing bundles, Checks #51 and #52 skip silently when `schema_version < 4` — no retroactive migration.

---

### `commands/masterplan-contracts.md`

**Change — Update `doctor.repo_scoped.schema_v1` purpose count + algorithm + checks_processed (closes H3)**

Lines `:73-97` define the `doctor.repo_scoped.schema_v1` contract with the embedded checks list:
- **Purpose** line: currently states the contract runs 11 repo-scoped checks → change to 13.
- **Algorithm** prose: lists the 11 check IDs explicitly → expand to include `#51, #52`.
- **Return shape** sample: hardcodes `"checks_processed": [26,30,31,36,39,44,46,47,48,49,50]` → expand to `[26,30,31,36,39,44,46,47,48,49,50,51,52]`.

Without this update, the orchestrator dispatching repo-scoped Haiku for doctor will brief 11 checks while `parts/doctor.md` is the authoritative source for 13. The mismatch silently skips #51/#52 (Anti-pattern #4 from CLAUDE.md: "drift here breaks autocomplete or silently skips checks").

Verification grep: `grep "checks_processed" commands/masterplan-contracts.md` — expect the array to contain 13 entries.

---

### `docs/internals/doctor.md`

**Change — Add Checks #51 and #52 to the Adding-a-New-Check workflow (closes H3 doc-side)**

The internals doc currently documents the workflow with reference to "all 50 checks" or similar count at four sites:
- Prose intro line (around `:22`) referencing total check count → update to 52.
- "Goal" subsection (around `:29`) referencing repo-scoped count "11" → update to 13.
- "Return shape" array example (around `:32`) hardcoding `[26,30,31,36,39,44,46,47,48,49,50]` → expand to include 51, 52.
- "Partial failure" array example (around `:35`) → same expansion.

This is the human-facing internals doc; it must agree with the contract file and parts/doctor.md or the next person adding a check will copy a stale template.

Verification grep: `grep -E "\b(11|50)\b" docs/internals/doctor.md` — expect 0 hits in count contexts (allow incidental hits in line numbers / unrelated prose; manual review.)

---

### `README.md`

**Change — Doctor check count updates (closes M2)**

Two sites carry stale counts:
- Line `:207`: "Runs 47 proactive lint checks" → "Runs 52 proactive lint checks"
- Line `:239`: "runs 48 structural audits" → "runs 52 structural audits"

Both numbers were stale even before this work (the actual check count at v6.3.3 was 50). This bundle is the convenient moment to fix.

Verification grep: `grep -E "\b(47|48|50)\s+(proactive|structural|lint|checks)\b" README.md` — expect 0 hits.

---

### `commands/masterplan.md` (count update site — separate from CC-3 changes above)

**Change — Doctor verb description count (closes M2)**

Line `:84` currently reads `doctor | ... | all 47 checks` → update to `all 52 checks`.

Verification grep: `grep -E "\b47\b" commands/masterplan.md` — expect 0 hits except in changelog/historical contexts.

---

### `parts/contracts/agent-dispatch.md` (additional change beyond D8 dual-structure)

**Change — Align `subagent_dispatched` emission with D19 (hook is single writer)**

Beyond the D8 dual-structure reset semantics already specified above (`:504-525`), add a note that the `subagent_dispatched` event in `events.jsonl` is written by the Stop hook from the `<masterplan-trace event=subagent_dispatched type=<type> model=<model> task=<short>>` marker (attribute-on-tag, no body) — NOT directly by the orchestrator. The orchestrator's responsibility is:
1. Emit the marker at every dispatch site.
2. Append the dispatch record to `subagents_this_turn` (list-state, in-memory).
3. Increment `subagents_this_step` (counter, in-memory).

The hook is the canonical writer for the `events.jsonl` row. Cross-validate via `subagents.jsonl` (hook ground truth) ↔ `events.jsonl#subagent_dispatched` for Check #52 drift detection.

This note prevents future drift where someone adds an orchestrator-side `events.jsonl` append for `subagent_dispatched` and creates double-emission.

---

### `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`

**Change — version bump to 6.4.0 (D11, closes M3)**

All THREE manifest files: set `version: "6.4.0"`. Pattern already established for prior releases; follow the same diff pattern as the v6.3.3 bump.

**Note (M3 fix):** an earlier draft of D11 listed a fourth file `.agents/plugins/marketplace.json`. That file does NOT exist in this repository — the Codex marketplace path is mounted via the `plugins/superpowers-masterplan -> ..` symlink referenced in `CLAUDE.md`, and there is no checked-in `.agents/plugins/marketplace.json`. Removing the dangling reference. Verification grep #12 (below) confirms zero hits.

---

## New contract: `parts/contracts/codex-review.md`

Full draft (to be created as a new file):

```markdown
# Codex Review Contract

> **Scope:** This contract governs every REVIEW dispatch from `/masterplan` — at B2 spec gate,
> B3 plan gate, and Step C 4b inline-work review. It defines the bounded brief template, the
> structured return JSON shape, the parse algorithm, the inline emit format, and error handling.

---

## When this contract applies

Load and follow this contract whenever the orchestrator dispatches a review (adversarial or
inline-work) via `codex:codex-rescue` in REVIEW mode (Claude Code-hosted runs) or via
`general-purpose` subagent at `model: sonnet` (Codex-hosted runs per D13).

---

## Dispatch brief template

Every REVIEW dispatch MUST use this bounded brief:

```
DISPATCH-SITE: <site-id>   (B2-spec-review | B3-plan-review | C4b-task-review)

Goal: Adversarial review of <artifact-description> against spec and acceptance criteria.
Inputs:
  Gate: <gate-label>            (e.g. "B2 spec_approval", "B3 plan_approval", "C4b task N")
  Artifact: <path or diff range>
  Spec excerpt: <relevant section>
  Acceptance criteria: <list from plan, if applicable>
  Files in scope: <list>
  Verification output: <captured 4a output, if C4b>

Scope: Review only — no writes, no commits, no file modifications.
Constraints: CD-10. Be adversarial about correctness and completeness, not style.
Return: JSON matching the shape below. Do NOT return prose. Return only the JSON object.

Return JSON shape:
{
  "verdict": "pass" | "fail" | "warn",
  "dimensions": ["completeness", "correctness", "security", "consistency", "naming", "scope"],
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "file": "<path or 'general'>",
      "line": <integer or null>,
      "issue": "<concise description>"
    }
  ],
  "summary": "<1-2 line gist of the review>"
}

Notes:
- "verdict" MUST be one of the three literals — no other values.
- "findings" MUST be a list (may be empty []).
- "dimensions" MUST be a list of the dimensions actually evaluated.
- "summary" MUST be a non-empty string.
- If findings list is empty, set "verdict" to "pass" (not "warn").
- Do NOT include any prose outside the JSON object.
```

---

## Codex-host fallback (D13, D20 per-site table)

When `codex_host_suppressed == true` (orchestrator is running inside Codex), each REVIEW site
has a defined fallback per the table below. `ScheduleWakeup` async pattern is N/A on Codex-host
(no background scheduler) — all foreground sites stay foreground; the B3 background path
collapses to foreground Sonnet.

| Site | Fallback target | Mode | Annotation | Notes |
|---|---|---|---|---|
| B2 spec review | `general-purpose` subagent at `model: sonnet` | foreground | `sonnet-fallback` | Same brief template (minus the Codex-exempt note). Set `degraded_review: true` in `codex_review_returned`. |
| B3 plan review | `general-purpose` subagent at `model: sonnet` | foreground | `sonnet-fallback` | NOT scheduled via `ScheduleWakeup` (not available on Codex-host). Emit inline immediately at dispatch return. Set `degraded_review: true`. |
| C4b verification review | SKIP — do not dispatch | n/a | `skipped: codex-host` | Existing recursion guard at `parts/step-c-verification.md:63` already declines when `dispatched_by == "codex"`. The parent Codex invocation has already done the verification work; a second Sonnet pass would be redundant. Emit `↳ codex review (C4b): SKIPPED — codex-host recursion guard` inline. |

Example inline emit (B2 spec, Sonnet fallback, JSON parse OK):
```
↳ codex review (B2 spec, sonnet-fallback): FAIL — 2 findings
```

The `sonnet-fallback` annotation appears in parentheses alongside any other annotations
(`degraded-parse`, `resumed`). Multiple annotations: separate with comma-space.

---

## Parse algorithm

On receiving the REVIEW return:

1. **Attempt JSON parse.** Extract the returned text. Strip any leading/trailing whitespace and
   code fences (` ```json ` / ` ``` `). Attempt `JSON.parse()` (or `json.loads()` in Python).

2. **Shape validation (D12 — shape-check only):**
   - `verdict ∈ {"pass", "fail", "warn"}` — if not, treat as parse failure.
   - `isinstance(findings, list)` — if not, treat as parse failure.
   - `isinstance(summary, str)` — if not, treat as parse failure.
   - `isinstance(dimensions, list)` — if not, treat as parse failure.
   - No logical-invariant enforcement (e.g., no "fail ⇒ findings non-empty" check).

3. **On parse success:** proceed to inline emit below.

4. **On parse failure (D5, D21, D23):**
   a. Preserve the first 2048 bytes of the raw return text as `raw_excerpt` (D21). This is the evidence trail for downstream debugging.
   b. Append event:
      ```json
      {"event":"codex_review_contract_breach","gate":"<gate>","reviewer":"codex","raw_excerpt":"<first 2048 bytes of return text>","ts":"<ISO>"}
      ```
   c. Apply D23 regex fallback (case-insensitive):
      - Verdict: match `\b(verdict|status)\s*[:=]\s*"?(pass|fail|warn)"?\b` — first hit wins. If no hit, secondary check: if text matches `\b(critical|fatal|serious|blocking|fundamental|wrong assumption)\b` → `verdict = "fail"`; else `verdict = "warn"` (never "pass" — unknown means uncertain).
      - Findings count: count occurrences of `^\s*[-*]\s+\[?[HMLhml]\d` (markdown bullet with H/M/L+digit). Surface as `<N> findings (regex-fallback count)` in the inline emit when degraded.
   d. Set `findings = []` (full list unparseable), `dimensions = []`, `summary = "(parse failed — degraded heuristic)"`. Keep `raw_excerpt` populated in the `codex_review_returned` event (D14, D21).
   e. Mark `degraded = true` for annotation in inline emit. Inline emit MUST include a second line: `raw excerpt: <first ~500 chars of raw_excerpt>` so the user sees what the reviewer actually said.
   f. Do NOT block the gate. Continue to inline emit and gate AUQ.

---

## Inline emit format (D6, D14)

Emit immediately after parsing (success or degraded), BEFORE:
- Any state write
- Any summary-block emit (CC-3 step 1)
- Any breadcrumb emit (CC-3 step 3)
- Any AUQ

Format:

```
↳ codex review (<gate-label>[, <annotations>]): <VERDICT> — <N> findings
  • [<sev>] <file>:<line> — <issue>
  • [<sev>] <file>:<line> — <issue>
  • [<sev>] <file>:<line> — <issue>
  [+ N more in events.jsonl]
```

Rules:
- `<gate-label>`: one of `B2 spec`, `B3 plan`, `C4b`, or the literal gate name.
- `<annotations>` (if any): `degraded-parse`, `sonnet-fallback`, `resumed` — comma-separated.
- `<VERDICT>`: uppercase `PASS`, `FAIL`, `WARN`.
- `<N> findings`: total count across all severities. If 0: "0 findings" (not omitted).
- **Top-3 by severity** (high → medium → low): emit at most 3 bullet lines. Sort stably.
- If total > 3: append `  [+ N more in events.jsonl]` where N = total - 3.
- If `line` is null: omit the `:line` segment (show just `<file>`).
- If `file` is `"general"`: show `general` without a path prefix.
- PASS with 0 findings: omit bullet lines entirely.

Example (FAIL, 5 findings):
```
↳ codex review (B2 spec): FAIL — 5 findings
  • [high] parts/step-b.md:213 — missing breadcrumb emit before AUQ
  • [high] parts/step-c-verification.md:88 — review return contract not enforced
  • [med]  parts/step-b.md:277 — B3 background review emit timing unclear
  [+ 2 more in events.jsonl]
```

Example (PASS):
```
↳ codex review (C4b): PASS — 0 findings
```

Example (degraded-parse):
```
↳ codex review (B2 spec, degraded-parse): WARN — 0 findings
```

---

## Persistence (D14, D20, D21)

After inline emit, append to `events.jsonl`:

```json
{
  "event": "codex_review_returned",
  "gate": "<gate-label>",
  "verdict": "<verdict>",
  "dimensions": ["<dim1>", ...],
  "findings": [
    {"severity": "high|medium|low", "file": "<path>", "line": <int|null>, "issue": "<text>"}
  ],
  "summary": "<text>",
  "degraded": <true|false>,
  "degraded_review": <true|false>,
  "raw_excerpt": "<≤2048 bytes of raw return text, or null when JSON parsed cleanly>",
  "ts": "<ISO>"
}
```

Field semantics:
- `degraded` (existing, D5): the JSON parse + shape-check failed; verdict and findings came from the D23 regex fallback.
- `degraded_review` (new, D20): the review ran on the Sonnet fallback path (Codex-host) rather than `codex:codex-rescue`. The dimensions and findings depth may differ from a Codex review.
- `raw_excerpt` (new, D21): first 2048 bytes of the unparsed return text when `degraded == true`. Null when JSON parsed cleanly. This is the evidence preservation surface — without it, parse failures leave no trail of what the reviewer actually said.

Full findings list (not top-3). This is the canonical record; the inline emit is the visibility surface.

---

## Site-specific addendums

### B2 spec gate

- Dispatch site ID: `B2-spec-review`
- Artifact: `docs/masterplan/<slug>/spec.md`
- Run foreground (not background). Return before gating.
- After inline emit: proceed to `halt_mode` routing per `parts/step-b.md:216`.

### B3 plan gate

- Dispatch site ID: `B3-plan-review`
- Artifact: `docs/masterplan/<slug>/plan.md`
- Run background via ScheduleWakeup (existing architecture preserved).
- Inline emit fires on resume after reading log file, before clearing `pending_gate`.
- After inline emit: proceed to B3 close-out gate.

### Step C 4b

- Dispatch site ID: `C4b-task-review`
- Artifact: diff range `<task-start-SHA>..HEAD`
- Run inline (foreground). Return before decision matrix.
- After inline emit: proceed to decision matrix (`:120-130`).
- Codex sites are exempt from `model:` parameter per existing rule.
```

---

## New state.yml schema_version: "5.1"

Schema `"5.1"` adds one top-level field relative to its predecessor (whether legacy int `3` or string `"5.0"`). The diff vs any `schema_version < "5.1"`:

```yaml
# New field added at schema_version: "5.1"
cached_compliance:
  breadcrumb_ratio: null        # float 0.0-1.0 or null if never audited
  summary_block_ratio: null     # float 0.0-1.0 or null if never audited
  turns_audited: 0              # integer — number of turns in last audit window
  audited_at: null              # ISO 8601 or null
```

**Schema bump rule:** New bundles created by `bin/masterplan-state.sh` bootstrap path → set `schema_version: "5.1"` (string) and include `cached_compliance` with null values. Existing bundles remain at their current `schema_version` (legacy int `3`, string `"5.0"`, etc.); Checks #51/#52 and the CC-2.4 banner skip any bundle with `schema_version < "5.1"` (tuple compare) silently.

**Doctor write-back:** After Checks #51 and #52 complete, the orchestrator (not the Haiku subagent) writes the computed ratios back to the active bundle's `state.yml.cached_compliance`. The Haiku returns raw check output; the orchestrator parses and writes.

**No retroactive migration:** Archived bundles (status=complete, status=archived) at schema_version 3 are NOT migrated. Only active in-flight bundles ever produce cached_compliance data.

---

## New Doctor Checks #51 and #52

### Check #51 — CC-3 breadcrumb-at-AUQ runtime compliance

| Field | Value |
|-------|-------|
| **ID** | 51 |
| **Severity** | WARNING (ratio < 0.80) / ERROR (ratio < 0.50) |
| **Summary** | Audits whether AUQ close-sites are preceded by a `breadcrumb_emitted` event in events.jsonl |
| **Evidence source (D4)** | `events.jsonl` (primary: `auq_render`, `breadcrumb_emitted` events) + `subagents.jsonl` (cross-validation) |
| **Scope** | Active bundles with `schema_version >= "5.1"`; latest 20 turns |
| **fix_available** | false |
| **Added** | v6.4.0 |

**Algorithm (pseudocode):**

```
function check_51(state_file):
  if state.schema_version < 4: return SKIP

  events = parse_jsonl(state_dir/events.jsonl)
  turns = split_by_turn_start(events)[-20:]

  total_auq = 0
  compliant = 0
  for turn in turns:
    for i, event in enumerate(turn):
      if event.type == "auq_render":
        total_auq += 1
        if i > 0 and turn[i-1].type == "breadcrumb_emitted":
          compliant += 1

  if total_auq == 0: return SKIP("no auq_render events in last 20 turns")

  ratio = compliant / total_auq
  # Cross-validate against subagents.jsonl
  subagent_turns = count_dispatch_turns(subagents.jsonl, last_20_turns)
  events_dispatch_turns = count_dispatch_turns(events.jsonl, last_20_turns)
  if abs(subagent_turns - events_dispatch_turns) > 2:
    append_event("model_attribution_drift", ...)

  if ratio >= 0.80: return PASS(ratio, compliant, total_auq)
  elif ratio >= 0.50: return WARN(ratio, compliant, total_auq)
  else: return ERROR(ratio, compliant, total_auq)

  write_back state.cached_compliance.breadcrumb_ratio = ratio
  write_back state.cached_compliance.turns_audited = total_auq
  write_back state.cached_compliance.audited_at = now()
```

**Thresholds (D15):**
- PASS: ratio ≥ 0.80
- WARN: 0.50 ≤ ratio < 0.80
- ERROR: ratio < 0.50

**Relevant event types emitted at compliance (for fixture authoring):**
- `auq_render` — orchestrator is about to fire an AskUserQuestion
- `breadcrumb_emitted` — orchestrator emitted the `/masterplan {verb} › ...` breadcrumb line
- `turn_start` — boundary between assistant turns

---

### Check #52 — CC-3 summary-block runtime compliance

| Field | Value |
|-------|-------|
| **ID** | 52 |
| **Severity** | WARNING (ratio < 0.80) / ERROR (ratio < 0.50) |
| **Summary** | Audits whether turns with subagent dispatches emitted the `Subagents this turn: N dispatched` summary block |
| **Evidence source (D4)** | `events.jsonl` (primary: `subagent_dispatched`, `summary_block_emitted` events) + `subagents.jsonl` (ground-truth dispatch counts) |
| **Scope** | Active bundles with `schema_version >= "5.1"`; latest 20 turns |
| **fix_available** | false |
| **Added** | v6.4.0 |

**Algorithm (pseudocode):**

```
function check_52(state_file):
  if state.schema_version < 4: return SKIP

  events = parse_jsonl(state_dir/events.jsonl)
  turns = split_by_turn_start(events)[-20:]
  subagent_records = parse_jsonl(state_dir/subagents.jsonl)

  turns_with_dispatch = 0
  compliant = 0
  drift_count = 0

  for turn in turns:
    dispatch_events = [e for e in turn if e.type == "subagent_dispatched"]
    if not dispatch_events: continue
    turns_with_dispatch += 1

    has_summary = any(e.type == "summary_block_emitted" for e in turn)
    if has_summary: compliant += 1

    # Cross-validate count vs subagents.jsonl
    events_dispatch_count = len(dispatch_events)
    jsonl_dispatch_count = count_dispatches_in_subagents_jsonl(turn.turn_id, subagent_records)
    if events_dispatch_count != jsonl_dispatch_count:
      drift_count += 1

  if drift_count > 0:
    append_event("model_attribution_drift", {drift_count, "check": 52})

  if turns_with_dispatch == 0: return SKIP("no dispatch turns in last 20 turns")

  ratio = compliant / turns_with_dispatch
  if ratio >= 0.80: return PASS(ratio, compliant, turns_with_dispatch)
  elif ratio >= 0.50: return WARN(ratio, compliant, turns_with_dispatch)
  else: return ERROR(ratio, compliant, turns_with_dispatch)

  write_back state.cached_compliance.summary_block_ratio = ratio
  write_back state.cached_compliance.audited_at = now()
```

**Thresholds (D15):** Same as Check #51.

**Note on event instrumentation (D19 — two distinct verbs):** `subagent_dispatched` and `summary_block_emitted` are new event types. Per D19, the orchestrator **EMITS** the inert `<masterplan-trace event=… …>` markers at the dispatch / summary-block sites (textual; visible in the transcript); the Stop hook `hooks/masterplan-telemetry.sh` **WRITES** the typed JSONL rows to `events.jsonl` by scanning those markers. The two verbs are non-interchangeable — orchestrator does not append directly to `events.jsonl` for these four event types, and the hook does not emit markers. Prior turns (bundles at `schema_version < "5.1"`) will have neither markers NOR JSONL rows — hence the schema_version guard. The fixture files for check-52/fail should simulate the v6.3.3 baseline (0 `summary_block_emitted` rows, N `subagent_dispatched` rows per turn).

---

## Test fixtures

### `tests/doctor-fixtures/check-51/`

**`pass/` — synthetic 100%-compliant turns:**

`pass/events.jsonl` — 5 turns, each with one `auq_render` preceded by `breadcrumb_emitted`:
```jsonl
{"event":"turn_start","ts":"2026-05-26T10:00:00Z"}
{"event":"breadcrumb_emitted","text":"/masterplan full › Brainstorm [test-bundle]","ts":"2026-05-26T10:00:01Z"}
{"event":"auq_render","gate":"spec_approval","ts":"2026-05-26T10:00:02Z"}
{"event":"turn_start","ts":"2026-05-26T10:01:00Z"}
{"event":"breadcrumb_emitted","text":"/masterplan full › Plan [test-bundle]","ts":"2026-05-26T10:01:01Z"}
{"event":"auq_render","gate":"plan_approval","ts":"2026-05-26T10:01:02Z"}
```
(Continue for 5 turns; 5/5 = 1.0 ratio.)

`pass/subagents.jsonl` — empty or minimal (no cross-validation drift needed for pass case).

`pass/home/` — minimal stub (empty `~/.codex/auth.json` not needed for this check).

`pass/expected.txt`:
```
Check #51: PASS
```

**`fail/` — synthetic 30%-compliant turns:**

`fail/events.jsonl` — 10 turns. 3 have `breadcrumb_emitted` before `auq_render`; 7 do not:
```jsonl
{"event":"turn_start","ts":"2026-05-26T10:00:00Z"}
{"event":"auq_render","gate":"spec_approval","ts":"2026-05-26T10:00:01Z"}
{"event":"turn_start","ts":"2026-05-26T10:01:00Z"}
{"event":"auq_render","gate":"plan_approval","ts":"2026-05-26T10:01:01Z"}
...
```
(7 non-compliant + 3 compliant = 0.30 ratio → ERROR threshold.)

`fail/expected.txt`:
```
ERROR: Check #51:
```
(Substring match.)

---

### `tests/doctor-fixtures/check-52/`

**`pass/` — synthetic 100% summary-block compliance:**

`pass/events.jsonl` — 5 turns each with `subagent_dispatched` followed by `summary_block_emitted`:
```jsonl
{"event":"turn_start","ts":"2026-05-26T10:00:00Z"}
{"event":"subagent_dispatched","dispatch_site":"Step B2","model":"haiku","ts":"2026-05-26T10:00:01Z"}
{"event":"summary_block_emitted","count":1,"ts":"2026-05-26T10:00:05Z"}
{"event":"turn_start","ts":"2026-05-26T10:01:00Z"}
{"event":"subagent_dispatched","dispatch_site":"Step C wave","model":"sonnet","ts":"2026-05-26T10:01:01Z"}
{"event":"subagent_dispatched","dispatch_site":"Step C wave","model":"sonnet","ts":"2026-05-26T10:01:02Z"}
{"event":"summary_block_emitted","count":2,"ts":"2026-05-26T10:01:05Z"}
```

`pass/subagents.jsonl` — matching dispatch records (same count as events.jsonl).

`pass/expected.txt`:
```
Check #52: PASS
```

**`fail/` — synthetic 0% compliance (v6.3.3 observed baseline):**

`fail/events.jsonl` — 5 turns, each with `subagent_dispatched` events but NO `summary_block_emitted`:
```jsonl
{"event":"turn_start","ts":"2026-05-26T10:00:00Z"}
{"event":"subagent_dispatched","dispatch_site":"Step B2","model":"haiku","ts":"2026-05-26T10:00:01Z"}
{"event":"turn_start","ts":"2026-05-26T10:01:00Z"}
{"event":"subagent_dispatched","dispatch_site":"Step C wave","model":"sonnet","ts":"2026-05-26T10:01:01Z"}
{"event":"subagent_dispatched","dispatch_site":"Step C wave","model":"sonnet","ts":"2026-05-26T10:01:02Z"}
{"event":"turn_start","ts":"2026-05-26T10:02:00Z"}
{"event":"subagent_dispatched","dispatch_site":"Step C step 4b","model":"codex","ts":"2026-05-26T10:02:01Z"}
```
(0 summary_block_emitted = 0.0 ratio → ERROR.)

`fail/subagents.jsonl` — matching dispatch records.

`fail/expected.txt`:
```
ERROR: Check #52:
```

---

### Degraded-parse path validation — moved to Python unit test (L1, NEW-H1 fix)

The degraded-parse path (D5, D21, D23) is validated by a Python unit test, not a doctor-fixture entry. Rationale: `tests/doctor-fixtures/run.sh` extracts ONE `bash` block per `^## Check #NN` header (see runner regex `s/^check-0*([1-9][0-9]*|0)$/\1/`) — non-numeric directories like `check-degraded-parse/` are silently skipped. Co-locating the fixture under `tests/doctor-fixtures/check-51/` or `check-52/` is also wrong: the runner would invoke the breadcrumb-ratio or summary-block bash block against `codex_review_contract_breach` events that have nothing to do with those checks (category mismatch). Degraded-parse is a **contract-parse-algorithm test**, not a **doctor-check runtime-compliance test** — the two belong in different test tiers.

**Target location:** `tests/test_codex_review_parse.py` (new file). The repo wires Python unit tests via the existing `tests/run-tests.sh --full` harness (see existing `tests/test_*.py` modules).

**Test cases (each a separate function):**

1. `test_degraded_parse_preserves_raw_excerpt()` — synthesize a malformed Codex review string (~3 KB of non-JSON prose); invoke the parse algorithm; assert the returned record has `degraded == True`, `raw_excerpt` is non-null and ≤ 2048 bytes, and `raw_excerpt` matches the first 2048 bytes of the input.
2. `test_degraded_parse_verdict_keyword_fail()` — input contains the keyword `fatal`; assert D23 regex fallback returns `verdict == "fail"`.
3. `test_degraded_parse_verdict_keyword_warn_default()` — input contains no verdict/severity keywords; assert `verdict == "warn"` (never `pass`).
4. `test_degraded_parse_findings_count_via_markdown_bullets()` — input has 5 markdown bullets matching `^\s*[-*]\s+\[?[HMLhml]\d`; assert `findings_count == 5` annotated as `(regex-fallback count)`.
5. `test_degraded_parse_event_record_shape()` — assert the resulting `codex_review_returned` event includes all of: `degraded: true`, `raw_excerpt` (string, ≤2048), `verdict` (from regex), `findings: []`, `dimensions: []`, `summary: "(parse failed — degraded heuristic)"`.

**Wire-up:** Add `tests/test_codex_review_parse.py` to the `tests/run-tests.sh --full` discovery (already globs `tests/test_*.py`); no Makefile / runner changes required. Run via `bash tests/run-tests.sh --full` and confirm all 5 test functions PASS.

**Why not a doctor fixture:** the doctor-fixtures harness is purpose-built for "extract bash block from `parts/doctor.md`, run it under cwd=fixture, grep for expected output." That contract is incompatible with parse-algorithm validation (no bash block to extract; assertions need direct Python access to the parser, not output-text grepping). Forcing the fixture into the doctor harness would require either (a) inventing a Check #53 that wraps the parse algorithm — six sync sites of cascade work per Anti-pattern #4 from `CLAUDE.md` for zero runtime benefit, or (b) co-locating under check-51/52 and accepting category-mismatched bash execution — silent test failure.

---

## Boot banner CC-2.4

**Placement:** In `parts/step-0.md`, add Step CC-2.4 as a 4th step of the CC-2 boot banner section, after the existing Step 3 (Codex health indicator, `:40-44` of `commands/masterplan.md` which mirrors step-0 text).

**Condition (all must be true):**
1. An active bundle is loaded (Step 0 has resolved a `slug` from `state.yml`).
2. `state.yml.schema_version >= "5.1"`.
3. `state.yml.cached_compliance` is non-null.
4. At least one of: `cached_compliance.breadcrumb_ratio < 0.8` OR `cached_compliance.summary_block_ratio < 0.8`.

**Emit format (plain stdout, not inside CC-3-trampoline, not inside tool calls):**

When only breadcrumb is failing:
```
↳ CC-3 compliance: WARN — breadcrumb-at-AUQ 42% (last 20 turns)
```

When only summary-block is failing:
```
↳ CC-3 compliance: WARN — summary-block 0% (last 20 turns)
```

When both are failing:
```
↳ CC-3 compliance: WARN — breadcrumb-at-AUQ 42%, summary-block 0% (last 20 turns)
```

**Upgrade note:** use `cached_compliance.turns_audited` for the turn count, not a hardcoded 20.

**Cost:** Zero extra tool calls. The cached ratios are already in-memory from the state.yml read at Step 0.

**No-cache path:** If `cached_compliance.audited_at == null` or `schema_version < 4`: skip silently. Do NOT run an audit during boot.

---

## Rollout

### Version

v6.4.0 — minor bump (new features + behavioral clarifications; no removals). Schema bump from 3→4 is additive (new field only).

### Always-on (D9)

No opt-in flag. CC-3 changes are clarifications to existing mandates + new observable contract. Codex review inline emit is a net-additive display; it does not change gate logic. Checks #51/#52 are report-only.

### CHANGELOG.md entry draft

```markdown
## v6.4.0 — CC-3 visibility (YYYY-MM-DD)

### Added
- **Check #51** — CC-3 breadcrumb-at-AUQ runtime compliance audit (WARN < 80%, ERROR < 50%,
  last 20 turns). Evidence: events.jsonl `auq_render`/`breadcrumb_emitted` + subagents.jsonl
  cross-validation.
- **Check #52** — CC-3 summary-block runtime compliance audit (WARN < 80%, ERROR < 50%).
  Evidence: events.jsonl `subagent_dispatched`/`summary_block_emitted` + subagents.jsonl.
- **Codex review inline emit** — all three REVIEW dispatch sites (B2 spec gate, B3 plan gate,
  Step C 4b) now emit `↳ codex review (...): VERDICT — N findings` immediately after parsing
  the review return, before the gate AUQ. Top-3 findings inline; full list in events.jsonl.
- **`parts/contracts/codex-review.md`** — new contract file defining structured JSON return
  shape for all REVIEW dispatches, parse algorithm, degraded-parse fallback, and inline emit
  format.
- **CC-2.4 boot indicator** — when active bundle (schema_version ≥ 4) has a cached compliance
  ratio < 0.8 from the last doctor run, a 4th banner line surfaces the issue at turn start.
- **`state.yml.cached_compliance`** field (added at `schema_version: "5.1"` per D24) caches
  last-doctor ratios for zero-cost boot-time compliance display.

### Changed
- **CC-3-trampoline step 1** now cites `parts/contracts/agent-dispatch.md` §Per-turn dispatch
  tracking inline, so the model loads the contract at close-site.
- **CC-3-trampoline step 3** removes "skip for routing questions" carve-out. Every AUQ Closer
  requires a breadcrumb line (only `ScheduleWakeup` and non-interactive terminal renders are
  exempt).
- **`parts/contracts/agent-dispatch.md`** clarifies dual-structure reset semantics:
  `subagents_this_turn` (per-turn list) vs `subagents_this_step` (per-step counter).
- **`hooks/masterplan-telemetry.sh`** extended to parse four new `<masterplan-trace>` marker
  subtypes using the existing attribute-on-tag grammar (`event=auq_render site=…`,
  `event=breadcrumb_emitted site=…`, `event=summary_block_emitted dispatch_count=…`,
  `event=subagent_dispatched type=… model=… task=…`) and append corresponding events to
  the active bundle's `events.jsonl` (D19). The hook is the single writer for these four
  event types; the orchestrator emits markers only.
- **`commands/masterplan.md` CC-3-trampoline** gains explicit marker-emission instructions
  inside the existing turn-close sequence: step 1 emits `summary_block_emitted` after the
  summary block; step 3 emits `breadcrumb_emitted` at both step-entry and AUQ-close sites;
  step 4 emits `auq_render` immediately before every `AskUserQuestion`. A new
  "Subagent-dispatch marker rule" paragraph mandates `subagent_dispatched` at every
  Agent/Task/codex dispatch site. This is the textual scaffold the hook scans (D19 / NEW-H2).
- **`commands/masterplan-contracts.md`** `doctor.repo_scoped.schema_v1` purpose count
  updated 11 → 13 repo-scoped checks; `checks_processed` array now includes 51 and 52.
- **`docs/internals/doctor.md`** Adding-a-New-Check workflow examples updated for #51/#52.
- **`README.md`** doctor check counts updated (47, 48 → 52).
- **`commands/masterplan.md` line 84** doctor verb description count updated 47 → 52.
- **`parts/step-b.md` line 128** new-bundle template now writes `schema_version: "5.1"` directly,
  so freshly created bundles support Checks #51/#52 immediately (no migration needed).

### Fixed
- Codex review findings were silently digested into events.jsonl without any inline chat
  visibility. All three review sites now surface findings immediately.
- Summary-block emit was 0% compliant in observed transcripts (no contract path reference at
  close-site). CC-3 step 1 now cites the contract inline.
- Breadcrumb-at-AUQ compliance was 10% (18/173) in observed transcripts. CC-3 step 3 routing-
  question carve-out removed; all AUQ sites are now unambiguously in scope.

### Migration
- New bundles: `schema_version: "5.1"` (string, semver-shaped per `parts/contracts/run-bundle.md` precedent — see D24) with `cached_compliance` stub.
- Existing bundles (any `schema_version < "5.1"`, including legacy int `3` and string `"5.0"`):
  Checks #51/#52 and CC-2.4 skip silently. Version compare is string/tuple-aware
  (`tuple(int(p) for p in str(v).split('.')) < (5, 1)`).
- **cc3-visibility bundle self-migrates** mid-run during Wave 3 (D22). This dog-foods the
  schema bump — appends a `bundle_migrated_to_v5_1` event, rewrites
  `state.yml.schema_version` (whatever its current form) → string `"5.1"`, adds the
  `cached_compliance` field with null values.
- No archived-bundle migration.
```

---

## Verification plan

### Static checks (run after edits, no runtime required)

```bash
# 1. Confirm CC-3 step 1 contract cite present
grep -n "parts/contracts/agent-dispatch.md" commands/masterplan.md
# Expected: at least one match citing "§Per-turn dispatch tracking"

# 2. Confirm routing-question carve-out removed
grep -n "routing questions" commands/masterplan.md
# Expected: 0 matches (or only in negation/historical contexts)

# 3. Confirm CC-3 step 3 exemption is narrowed to ScheduleWakeup only
grep -A3 "AUQ close-site" commands/masterplan.md
# Expected: only "ScheduleWakeup and non-interactive terminal renders" exempted

# 4. Confirm codex-review.md exists
ls parts/contracts/codex-review.md
# Expected: file present

# 5. Confirm codex-review.md has all required top-level sections
grep "^## " parts/contracts/codex-review.md
# Expected: Dispatch brief template, Codex-host fallback, Parse algorithm,
#            Inline emit format, Persistence, Site-specific addendums

# 6. Confirm Check #51 and #52 bodies present in doctor.md
grep "## Check #51\|## Check #52" parts/doctor.md
# Expected: 2 matches

# 7. Confirm doctor.md header updated to #52
grep "^# Doctor" parts/doctor.md
# Expected: "Self-Host Checks (#1 .. #52)"

# 8. Confirm repo-scoped check list updated to include 51 and 52
grep "51, #52\|51.*52" parts/doctor.md
# Expected: matches in the parallelization brief and contract dispatch

# 9. Confirm CC-2.4 section in step-0.md
grep "CC-2.4\|cached_compliance" parts/step-0.md
# Expected: at least one match

# 10. Confirm schema_version "5.1" (string) in bin/masterplan-state.sh bootstrap (D24)
grep -F 'schema_version: "5.1"' bin/masterplan-state.sh
# Expected: at least one match in the bootstrap / new-bundle creation path

# 11. Confirm cached_compliance field in state bootstrap
grep "cached_compliance" bin/masterplan-state.sh
# Expected: field present in new-bundle template

# 12. Confirm version bump in all three manifest files (M3: .agents/plugins/marketplace.json does not exist)
grep '"version"' .claude-plugin/plugin.json .codex-plugin/plugin.json \
  .claude-plugin/marketplace.json
# Expected: all show 6.4.0
# Negative check:
ls .agents/plugins/marketplace.json 2>/dev/null && echo "UNEXPECTED: .agents/plugins/marketplace.json exists"
# Expected: silent (file does not exist)

# 13. Bash syntax check on telemetry hook (extended for D19 markers)
bash -n hooks/masterplan-telemetry.sh
# Expected: silent (no syntax errors)

# 14. Confirm dual-structure reset semantics in agent-dispatch.md
grep "subagents_this_step\|subagents_this_turn" parts/contracts/agent-dispatch.md
# Expected: both terms present, with reset semantics described

# 15. Run fixture tests (now includes check-51 and check-52; degraded-parse moved to Python unit tests per L1/NEW-H1)
bash tests/doctor-fixtures/run.sh 2>&1 | grep -E "PASS|FAIL|check-51|check-52"
# Expected: both fixture trees PASS

# 15b. Run the degraded-parse Python unit tests (L1/NEW-H1 fix — replaces the dropped doctor-fixture)
bash tests/run-tests.sh --full 2>&1 | grep -E "test_codex_review_parse|test_degraded_parse_"
# Expected: 5 test functions PASS (test_degraded_parse_preserves_raw_excerpt, _verdict_keyword_fail, _verdict_keyword_warn_default, _findings_count_via_markdown_bullets, _event_record_shape)

# 16. Confirm hook parses the four new marker subtypes (D19, H1) — attribute-on-tag grammar
grep -E "event=auq_render|event=breadcrumb_emitted|event=summary_block_emitted|event=subagent_dispatched" hooks/masterplan-telemetry.sh
# Expected: all four event-name attribute patterns present in the hook's parser dispatch

# 17. Confirm contracts file purpose count + checks_processed updated (H3)
grep -E "(thirteen|13)\s+repo-scoped|checks_processed.*51.*52" commands/masterplan-contracts.md
# Expected: at least one hit (purpose updated AND/OR checks_processed includes 51, 52)

# 18. Confirm internals doctor doc updated (H3)
grep -E "51|52" docs/internals/doctor.md
# Expected: at least one match in the Adding-a-New-Check workflow

# 19. Confirm README doctor count updated (M2)
grep -E "\b(47|48)\s+(proactive|structural)" README.md
# Expected: 0 hits
grep "52 proactive\|52 structural" README.md
# Expected: 2 hits

# 20. Confirm commands/masterplan.md doctor count updated (M2)
grep -E "all\s+52\s+checks" commands/masterplan.md
# Expected: 1 hit

# 21. Confirm schema_version "5.1" (string) in parts/step-b.md new-bundle template (H2, D24)
grep -F 'schema_version: "5.1"' parts/step-b.md
# Expected: at least 1 hit (the new-bundle bootstrap template)

# 22. Confirm NO stale `schema_version: 4` (int) references survived the D24 string-bump (NEW-M1)
grep -nE 'schema_version:[[:space:]]+4([^.0-9]|$)' \
  docs/masterplan/cc3-visibility/spec.md parts/ bin/ commands/ 2>/dev/null
# Expected: 0 hits (string "5.1" is the canonical form; int 4 is forbidden)

# 23. Confirm the four new marker emission instructions appear in commands/masterplan.md (D19, NEW-H2)
grep -c 'event=summary_block_emitted' commands/masterplan.md
# Expected: >= 1
grep -c 'event=breadcrumb_emitted' commands/masterplan.md
# Expected: >= 2 (step-entry site + AUQ-close site)
grep -c 'event=auq_render' commands/masterplan.md
# Expected: >= 1
grep -c 'event=subagent_dispatched' commands/masterplan.md
# Expected: >= 1 (the subagent-dispatch marker rule)

# 24. Confirm marker grammar is attribute-on-tag (no body-style residue) (D19)
grep -nE 'masterplan-trace>(auq=render|breadcrumb=emit|summary-block=emit|subagent=dispatch)' \
  docs/masterplan/cc3-visibility/spec.md commands/masterplan.md parts/ 2>/dev/null
# Expected: 0 hits (the old body-style form is forbidden; attribute-on-tag is canonical)
```

### Runtime smoke (manual)

1. After implementing Track 3 (codex-review contract), run `/masterplan execute` on the cc3-visibility bundle itself (a naturally compact bundle). Verify: `↳ codex review (C4b): ...` appears inline before the gate AUQ.

2. Run `/masterplan doctor` on the cc3-visibility bundle. Verify: Check #51 and #52 appear in output. If `cached_compliance.breadcrumb_ratio` is not yet populated (first run): checks should return SKIP or WARN. Verify `state.yml.cached_compliance` is updated after doctor run.

3. Run a second `/masterplan` invocation (any verb). Verify: if prior doctor run cached a ratio < 0.8, the CC-2.4 banner line appears after the Codex health line.

---

## Out of scope (explicit non-goals)

- **`hooks/masterplan-telemetry.sh` legacy schema fields:** The hook's existing `subagents.jsonl` schema is unchanged — only the marker parser is extended (D19, H1). Pre-existing telemetry fields (`hook_event`, `subagent_type`, `model`, etc.) remain stable.
- **`/masterplan stats` output changes:** The only change implied by D8 (dual-structure) is internal variable naming. No stats display changes.
- **Existing Checks #1–#50:** No changes to any existing check logic, thresholds, or fixture files. Header counts ("47 checks", "48 checks") in README.md / commands/masterplan.md ARE updated to 52 (M2 fix below) — that is a count update, not a logic change.
- **Archived bundle migration:** Schema-v3 bundles (status=complete or archived) are not touched. The `schema_version: "5.1"` bump applies to new bundles + the cc3-visibility self-migration (D22).
- **Inline breadcrumb patching across 95 parts/*.md AUQ sites:** The fix is a central rule removal at `commands/masterplan.md`, not per-site patches. Parts/*.md sites are not individually edited.
- **B3 background dispatch architecture (Claude Code-hosted):** The background review + ScheduleWakeup pattern is preserved on Claude Code. Only the parse + emit on resume changes. On Codex-host, D20 specifies foreground Sonnet fallback (no background scheduler available).
- **`parts/step-c-dispatch.md` structural changes:** Wave assembly is unaffected. No edits to this file.
- **`parts/step-c-completion.md` structural changes:** Final commit + retro trigger is unaffected.
- **Degraded-parse fixture under `tests/doctor-fixtures/`:** Out of scope per L1/NEW-H1 fix. Degraded-parse validation lives in `tests/test_codex_review_parse.py` (Python unit-test tier) — see "Degraded-parse path validation" section above for the rationale (runner extracts one bash block per numeric `check-NN` dir; non-numeric `check-degraded-parse/` is silently skipped; co-locating under check-51/52 would cause category-mismatched bash execution).
- **A new Check #53 wrapping the parse algorithm:** Considered and rejected per Anti-pattern #4 from `CLAUDE.md`. Adding a new doctor check requires updating 6+ sync sites (parts/doctor.md header, parallelization brief, `commands/masterplan-contracts.md`, `docs/internals/doctor.md`, README, `commands/masterplan.md`) — disproportionate cost for what is fundamentally a unit test of a parse function.

---

## Open questions for plan phase

All seven open questions from the first-draft spec are resolved below. No outstanding questions remain — the plan phase can proceed.

1. **Event emission mechanism for `auq_render` / `breadcrumb_emitted` / `summary_block_emitted` / `subagent_dispatched`** — RESOLVED by D19. The Stop hook `hooks/masterplan-telemetry.sh` is the single writer for all four event types. It tails the assistant transcript, parses `<masterplan-trace>` markers (existing mechanism — extended with four new marker subtypes), and appends events to the active bundle's `events.jsonl`. The orchestrator emits markers only; it does NOT directly append these four event types. This makes the hook the canonical source of truth and avoids the brittle per-site emission-instruction pattern that caused the original CC-3 non-compliance.

2. **Fixture test driver compatibility** — RESOLVED. `tests/doctor-fixtures/run.sh` is compatible with the new fixture layout (`check-51/pass/{events.jsonl, state.yml, expected.txt}`, same for `check-52/` and the new `check-degraded-parse/`). The runner extracts bash blocks from `parts/doctor.md` and runs them with the fixture directory as CWD; the bash blocks in Checks #51/#52 read `events.jsonl` from `$PWD`. No runner changes required. A shell wrapper for the degraded-parse fixture (which asserts on event content, not output text) is documented in the new `tests/doctor-fixtures/README.md`.

3. **`subagents_this_turn` reset trigger** — RESOLVED by D8 (refined in this revision). The reset fires at the start of every assistant turn — operationally, this means the orchestrator resets `subagents_this_turn` at CC-2 banner emit (first action of every turn). `parts/step-0.md` CC-3 anchor must be updated to clarify: turn-level reset for `subagents_this_turn`, step-level reset for `subagents_this_step`. The plan phase's first task is the agent-dispatch.md edit (already in scope above).

4. **B3 sonnet-fallback timing on Codex-host** — RESOLVED by D20. When `codex_host_suppressed == true`, B3 plan review runs **foreground** (synchronous) on the Sonnet fallback path — ScheduleWakeup is not available on Codex-host. The inline emit fires immediately at dispatch return, no resume step required. On Claude Code (with `codex_host_suppressed == false`), the existing ScheduleWakeup background pattern is preserved.

5. **Check #51/#52 write-back to state.yml** — RESOLVED. The repo-scoped Haiku's return shape (`doctor.repo_scoped.schema_v1`) is extended to include `cached_compliance` fields per check: `{check_id: 51, ratio: <float>, compliant: <int>, total: <int>, ...}`. The orchestrator parses the Haiku return and writes the ratios to `state.yml.cached_compliance` as a post-step. This is an extension of `schema_v1`, not a versioned bump, consistent with how #49 and #50 were added. Spec'd in the contracts-file edit above.

6. **Standardized regex pattern for degraded-parse fallback** — RESOLVED by D23. The canonical regex (case-insensitive) is `\b(verdict|status)\s*[:=]\s*"?(pass|fail|warn)"?\b` for verdict extraction; secondary fallback if no match: `\b(critical|fatal|serious|blocking|fundamental|wrong assumption)\b` → verdict=fail. Findings count: `^\s*[-*]\s+\[?[HMLhml]\d`. The pattern is defined once in D23 and referenced from D5, D21, and the contract file's Parse algorithm section.

7. **`parts/contracts/codex-review.md` citation in step-b.md** — RESOLVED. The B2 and B3 blocks REPLACE the companion-script discovery logic with direct `codex:codex-rescue` dispatch per the new contract (same as C4b). The two-path companion-script discovery is REMOVED — it was an artifact of an earlier era when REVIEW dispatches used a different mechanism. New step 3 in both B2 and B3 (spec'd above) cites the contract path explicitly. The orchestrator loads the contract content via the cite at the dispatch site.

---

## Reviewer Findings Addressed

This section maps each finding from the first adversarial review to the spec edits that close it. File:line cites refer to the post-revision spec.

| # | Severity | Finding (paraphrased) | Resolution | Spec cites (this file) |
|---|---|---|---|---|
| H1 | high | Spec lacked an emission mechanism for the four event types (`auq_render`, `breadcrumb_emitted`, `summary_block_emitted`, `subagent_dispatched`) that Checks #51/#52 cross-reference. As-spec'd, the checks would always SKIP on real bundles. | Added **D19**: hook is the single writer for the four event types. The Stop hook parses four new `<masterplan-trace>` marker subtypes and writes the events to `events.jsonl`. Orchestrator emits markers only. Eliminates the per-site emission-instruction failure mode that caused the original CC-3 non-compliance. | D19 row at `spec.md:72`; full `hooks/masterplan-telemetry.sh` section at `spec.md:533-587`; matching `parts/contracts/agent-dispatch.md` D19-sync note at `spec.md:644-657`; verification grep #16 at `spec.md` Verification plan. |
| H2 | high | The new `schema_version: "5.1"` had no concrete first consumer — `bin/masterplan-state.sh` bootstrap was the only writer, but the `parts/step-b.md:128` template still hardcoded `schema_version: 3`, so any new bundle created via the orchestrator path stayed at v3 and Checks #51/#52 would always SKIP. | Added **D22** (cc3-visibility self-migration as the dog-fooding consumer) and **Change 0** in `parts/step-b.md` section: line `:128` template now emits `schema_version: "5.1"` + `cached_compliance` stub directly. Migration entry in CHANGELOG. | D22 row at `spec.md:75`; Change 0 block at `spec.md:141-152`; verification grep #21 (`schema_version: "5.1" in parts/step-b.md`); Migration section of CHANGELOG at `spec.md` Rollout. |
| H3 | high | The `doctor.repo_scoped.schema_v1` contract in `commands/masterplan-contracts.md` and the Adding-a-New-Check workflow in `docs/internals/doctor.md` were not in scope. The contract hardcoded 11 check IDs and `checks_processed: [26,30,31,36,39,44,46,47,48,49,50]`. Without updating these, the repo-scoped Haiku would brief 11 checks while `parts/doctor.md` documented 13 — silently skipping #51/#52 (Anti-pattern #4). | Added file-by-file sections for **`commands/masterplan-contracts.md`** (update purpose count 11→13 + algorithm + `checks_processed` array) and **`docs/internals/doctor.md`** (update 4 sites: prose intro, Goal subsection, Return shape array, Partial failure array). | `commands/masterplan-contracts.md` section at `spec.md:589-602`; `docs/internals/doctor.md` section at `spec.md:604-618`; verification greps #17 and #18 at `spec.md` Verification plan. |
| H4 | high | Codex-host fallback (D13) was a single policy line. Each REVIEW site needs distinct semantics: B2/B3 can fall back to Sonnet; C4b cannot (the parent Codex invocation is the verification — a second Sonnet pass would be redundant + would race the existing recursion guard at `parts/step-c-verification.md:63`). ScheduleWakeup is N/A on Codex-host. | Added **D20**: explicit per-site fallback table. B2 spec → Sonnet foreground; B3 plan → Sonnet foreground (no background); C4b → SKIP (defer to existing recursion guard). New `degraded_review` flag in `codex_review_returned` event. Section in contract file expanded with the table. | D20 row at `spec.md:73`; Codex-host fallback section at `spec.md:736-758` (now includes per-site table); B2 step 3 update at `spec.md:166-168`; B3 update at `spec.md:177-190`; C4b note at `spec.md:201-203`. |
| M1 | medium | On JSON parse failure (D5 fallback), the original spec discarded the raw return text — only the first 200 chars were preserved in `codex_review_contract_breach`. No raw excerpt persisted in the `codex_review_returned` event itself. Operators investigating a degraded review had no trail of what the reviewer actually said. | Added **D21**: preserve first 2048 bytes of raw text as `raw_excerpt` field in `codex_review_returned` event. Inline emit surfaces first ~500 chars under a `raw excerpt:` line. Parse algorithm and Persistence sections updated. | D21 row at `spec.md:74`; Parse algorithm steps a-e at `spec.md:759-810` (D5/D21/D23 references); Persistence section at `spec.md:840-866` (field semantics for `raw_excerpt`); inline emit format in B2/B3/C4b sections all show degraded-parse line. |
| M2 | medium | README.md ("47 proactive lint checks" / "48 structural audits") and `commands/masterplan.md` line 84 ("all 47 checks") all carried stale counts. After adding #51/#52 the total is 52. Drift here breaks user-facing documentation (Anti-pattern #4). | Added file-by-file sections for **`README.md`** (two count sites: `:207` and `:239`) and **`commands/masterplan.md`** (line `:84` count update). Verification greps assert zero hits on stale counts. | README section at `spec.md:620-630`; commands/masterplan.md count site at `spec.md:632-642`; verification greps #19 and #20 at `spec.md` Verification plan. |
| M3 | medium | D11 listed four manifest files including `.agents/plugins/marketplace.json`. That file does NOT exist in this repo — the Codex marketplace path is mounted via the `plugins/superpowers-masterplan -> ..` symlink referenced in CLAUDE.md. Verification grep #12 would fail. | Removed the dangling file reference from D11, the manifest section heading, and verification grep #12. Added a negative-check `ls` in grep #12 confirming the file does not exist. Note in D11 explains the removal. | D11 row (updated) at `spec.md:64`; manifest section heading at `spec.md:659`; manifest section body note at `spec.md:664-665`; verification grep #12 at `spec.md` Verification plan (now lists only 3 files + negative check). |
| L1 | low | No fixture covering the degraded-parse path. Without one, the JSON parse failure handling (D5/D21/D23) cannot be validated mechanically — only via runtime smoke tests. | **Round 1 fix superseded.** Round-2 review (L1' below) determined the doctor-fixture approach is incompatible with `tests/doctor-fixtures/run.sh`'s regex contract. Final fix: 5-test Python unit-test suite in `tests/test_codex_review_parse.py`. See L1' row. | (Superseded — see L1' for live cites.) |

### Round-2 review findings (added in ROUND 3 revision)

| # | Severity | Finding (round 2) | Resolution | Spec cites (this file) |
|---|---|---|---|---|
| H1' | high (carry-over) | Round-1 D19 closed the "who writes the event" question but left the "where does the orchestrator emit the marker" question implicit. Without concrete before/after patches in `commands/masterplan.md` showing the marker-emission sites inside CC-3-trampoline steps 1, 3, and 4, the hook has no scaffold to scan — Checks #51/#52 would still return SKIP at runtime. | **D19 row rewritten** to make the emit-vs-write distinction explicit and non-interchangeable. Added file-by-file **Change 3** (3a / 3b / 3c / 3d) to `commands/masterplan.md` section with the literal old-text / new-text patches for: step 1 `summary_block_emitted` after the summary block; step 3 `breadcrumb_emitted` at both breadcrumb sites (step-entry + AUQ-close); step 4 `auq_render` before every AUQ Closer; and a new subagent-dispatch marker rule paragraph. Verification grep #23 asserts each marker text appears in `commands/masterplan.md`. | D19 row at `spec.md` decisions table; Change 3a-3d block in `commands/masterplan.md` section; verification grep #23. |
| L1' | low (carry-over) | The Round-1 `tests/doctor-fixtures/check-degraded-parse/` plan was incompatible with the fixture runner: `tests/doctor-fixtures/run.sh` extracts one bash block per `^## Check #NN` header and runs it via `bash -c "$block"` with NO positional args (`$1` is empty); non-numeric directory names like `check-degraded-parse/` are silently skipped by the runner's regex (`^check-0*([1-9][0-9]*|0)$`). | **Approach (b) — move degraded-parse validation to the Python unit-test tier.** Removed the `check-degraded-parse/` fixture entry; replaced with a 5-function test suite in `tests/test_codex_review_parse.py` (preserves_raw_excerpt, verdict_keyword_fail, verdict_keyword_warn_default, findings_count_via_markdown_bullets, event_record_shape). Wired into existing `tests/run-tests.sh --full` discovery. Added "Out of scope" entries explaining why neither a doctor fixture nor a new Check #53 is appropriate (Anti-pattern #4 cascade). | "Degraded-parse path validation" section replacing the old fixture block; Out-of-scope entries appended; verification grep #15 narrowed; new grep #15b added for the Python tests. |
| NEW-H1 | high | Overlap with L1: the proposed `check-degraded-parse/` directory cannot be invoked by the existing fixture runner. | Closed via the same L1' fix above (move to Python tests). | Same as L1'. |
| NEW-H2 | high | Overlap with H1: D19 declared the orchestrator emits markers but the spec did not show WHERE in the CC-3-trampoline those marker emissions are inserted, nor at which dispatch sites the `subagent_dispatched` marker fires. | Closed via the same H1' fix above (concrete CC-3 marker emission patches in `commands/masterplan.md` Change 3a-3d). | Same as H1'. |
| NEW-M1 | medium | Spec used int `schema_version: 4`, continuing the legacy int progression (1, 2, 3, 4). However, `parts/contracts/run-bundle.md:21` already specifies `schema_version: "5.0"` (a quoted string, semver-shaped). The two formats collide: `int(4) < "5.0"` is meaningless and `[ "$schema_version" -lt 4 ]` breaks under a string. | **Added D24.** Bumped `schema_version` to string `"5.1"` (one ahead of the run-bundle contract's `"5.0"`, additive — adds only the `cached_compliance` field). All bash-level `-lt 4` compares replaced with Python tuple compare `tuple(int(p) for p in str(v).split('.')) < (5, 1)` and a safe-fallback `except ValueError: parts = (0,)` for legacy int values. `replace_all` swept the spec for `schema_version: 4` and `schema_version >= 4` references. Verification grep #22 asserts zero stale int forms survive. | D24 row at decisions table; updated `parts/step-b.md` Change 0 template; updated Check #51 + Check #52 bash bodies; updated state.yml-schema section; updated CHANGELOG Migration block; verification greps #21 and #22. |
| NEW-M2 | medium | D19 in Round 1 said "Stop hook is the single writer" but `spec.md:1037` simultaneously asserted "subagent_dispatched and summary_block_emitted are new event types that the orchestrator must emit." The two statements used "emit" in incompatible senses (textual marker vs JSONL append) and read as a self-contradiction. | **D19 rewritten to introduce two distinct verbs**, used non-interchangeably throughout the spec: orchestrator **EMITS** markers (textual, in transcript); hook **WRITES** events (JSONL append). Spec.md note that contradicted this was rewritten to use the two verbs and reference D19 explicitly. | D19 row at decisions table; note at `spec.md` Check #52 body (`subagent_dispatched and summary_block_emitted` explanation rewritten); marker emission instructions in `commands/masterplan.md` Change 3. |

All findings (including round-2) closed. Open Questions remain at 0. The spec is ready for round-3 adversarial review.
