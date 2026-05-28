## When this contract applies

Load and follow this contract whenever the orchestrator dispatches a review (adversarial or
inline-work) via `codex:codex-rescue` in REVIEW mode (Claude Code-hosted runs) or via
`general-purpose` subagent at `model: sonnet` (Codex-hosted runs per D13).

---

## Dispatch mechanism — model-invocable, NOT a slash command

REVIEW dispatch is performed by the orchestrator itself, via one of:

- the `codex:codex-rescue` subagent through the **Agent tool**
  (`subagent_type: "codex:codex-rescue"`) — B2 spec review, C4b task review; OR
- the `node <companion> adversarial-review --background` **shell subcommand** run via Bash —
  B3 plan review only (it needs a background job); OR
- a `general-purpose` subagent at `model: sonnet` through the **Agent tool** — **only** when
  `codex_host_suppressed == true`, per §Codex-host fallback below.

All three are fully model-invocable. At a REVIEW dispatch site you MUST NOT:

- refuse, pause, or "punt" citing `disable-model-invocation`;
- tell the user to type `/codex:adversarial-review` (or any slash command);
- treat the dispatch as blocked pending a user action.

**"Adversarial review" names three different things:** (1) this masterplan workflow plus its
`adversarial_review` config key and `adversarial_review_*` events; (2) the codex companion's
`adversarial-review` shell subcommand; (3) the `/codex:adversarial-review` Claude Code
slash-command skill (`disable-model-invocation: true`, named in global `~/.claude/CLAUDE.md`).
This contract uses **(1) and (2)** and NEVER routes through (3). The dispatch here is the
`codex:codex-rescue` Agent subagent (or the companion subcommand / sonnet fallback) — it is
**NOT the /codex:adversarial-review slash command**. Any session priming that notes
`codex:adversarial-review` is `disable-model-invocation` is about (3) and is irrelevant here; it
MUST NOT block this dispatch.

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
```

### Return JSON shape

```json
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
```

Notes:
- `verdict` MUST be one of the three literals — no other values.
- `findings` MUST be a list (may be empty `[]`).
- `dimensions` MUST be a list of the dimensions actually evaluated.
- `summary` MUST be a non-empty string.
- If findings list is empty, set `verdict` to `pass` (not `warn`).
- Do NOT include any prose outside the JSON object.

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
