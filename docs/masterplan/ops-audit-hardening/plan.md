# Plan — masterplan operational hardening (ops-audit-hardening)

- **Spec:** `docs/masterplan/ops-audit-hardening/spec.md`
- **Posture:** repro-first. Task 1/Task 2 produce verdicts; Task 3/Task 4 are
  **contingent** on those verdicts and may become docs-only no-ops if the signal
  is refuted (contingency resolved inside the task body — see each task).
- **Autonomy:** loose. Verification is local-static (grep discriminators +
  `bash -n` + doctor); no production-visible actions.
- **Heading note:** `build-index` parses numeric `### Task N:` headings; the task
  graph and bodies below keep the `T1…T7` shorthand for continuity (Task N ≙ TN).

## Task graph

```
T1 (repro F1) ─┐
T2 (repro F2) ─┼─→ T3 (fix-or-note F1, reads verdict-f1) ─┐
               └─→ T4 (fix-or-note F2, reads verdict-f2) ─┤
T5 (F3 generalize) ──────────────────────────────────────┼─→ T7 (doctor + version + sync)
T6 (F4 preflight) ────────────────────────────────────────┘
```

T1, T2, T5, T6 are independent in principle, but T3/T5/T6 all edit
`parts/step-0.md`, so the dispatcher serializes them on that shared file. T3
reads `verdict-f1.md`; T4 reads `verdict-f2.md`; T7 depends on T3/T4/T5/T6.

---

### Task 1: Repro F1 — boot-banner under-emission verdict

**Files:** docs/masterplan/ops-audit-hardening/verdict-f1.md, docs/masterplan/ops-audit-hardening/events.jsonl
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L33-L48](spec.md#L33-L48)
**Verify:**
```bash
test -f docs/masterplan/ops-audit-hardening/verdict-f1.md
grep -qE "^VERDICT: (confirmed|refuted)" docs/masterplan/ops-audit-hardening/verdict-f1.md
```

- **Goal:** establish the true denominator of banner-requiring invocations in
  session `ab57e7c8` and return a verdict.
- **Inputs:** `~/.claude/projects/-srv-dev-yanos-project/ab57e7c8-*.jsonl`;
  CC-2 contract at `commands/masterplan.md:19-44`, `parts/step-0.md:9-38`.
- **Method:** parse the JSONL; classify each user turn that triggers `/masterplan`
  into {fresh-invocation, bare-resume, status/next subroutine, doc reference /
  non-invocation}. Count how many *required* a banner per contract (contract =
  all turns) vs how many emitted one. Distinguish "model skipped a mandated
  banner" from "string match was not a real invocation."
- **Return / artifact:** write `verdict-f1.md` opening with a line
  `VERDICT: confirmed` or `VERDICT: refuted`, then the required/emitted ratio, a
  representative skipped turn (with JSONL line offset), and the reclassification
  table. No source edit in this task.

### Task 2: Repro F2 — gate re-entrance verdict

**Files:** docs/masterplan/ops-audit-hardening/verdict-f2.md, docs/masterplan/ops-audit-hardening/events.jsonl
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L50-L64](spec.md#L50-L64)
**Verify:**
```bash
test -f docs/masterplan/ops-audit-hardening/verdict-f2.md
grep -qE "^VERDICT: (confirmed|refuted)" docs/masterplan/ops-audit-hardening/verdict-f2.md
```

- **Goal:** determine whether the 30 `gate=fire` events in `335b66e4` include
  genuine same-gate re-fires on a single approval.
- **Inputs:** `~/.claude/projects/-srv-dev-yanos-project/335b66e4-*.jsonl`; gate
  logic at `parts/step-b.md:218`, `:303`, `:220-223`; resume controller
  `parts/step-0.md:172-179`.
- **Method:** extract each `gate=fire` with its `id`, surrounding plan slug, and
  the `phase` value at fire time. A re-entrance = same `id` + same slug firing
  again with no intervening `phase` advance or `pending_gate` clear→advance.
  Tally genuine re-fires vs distinct legitimate gates.
- **Return / artifact:** write `verdict-f2.md` opening with `VERDICT: confirmed`
  or `VERDICT: refuted`, then the fire-event sequence (with line offsets) and the
  re-entrance trace or the distinct-gate accounting. No source edit in this task.

### Task 3: Fix-or-note F1 — banner enforcement + runtime audit (reads verdict-f1)

**Files:** parts/step-0.md, commands/masterplan.md, parts/doctor.md, docs/masterplan/ops-audit-hardening/verdict-f1.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L96-L101](spec.md#L96-L101)
**Verify:**
```bash
grep -qE "^RESOLUTION: (fix-applied|docs-only-refuted)" docs/masterplan/ops-audit-hardening/verdict-f1.md
bash -n parts/doctor.md 2>/dev/null || true   # doctor.md is markdown; bash -n only if a shell snippet was added
```

- **Branch on the Task 1 verdict (read `verdict-f1.md` first):**
  - **If `VERDICT: confirmed`:** (1) raise CC-2 salience in `parts/step-0.md:9-38`
    / `commands/masterplan.md:19-44` (tighten the unconditional-render language;
    add no new exemption). (2) Add a doctor check auditing **runtime**
    banner-emission ratio across recent run transcripts (complements static #36);
    append to `parts/doctor.md`. Then append `RESOLUTION: fix-applied` to
    `verdict-f1.md`.
  - **If `VERDICT: refuted`:** convert to a docs-only note in `verdict-f1.md`
    recording the resume/status reality; skip source/doctor edits. Append
    `RESOLUTION: docs-only-refuted`.
- **Verification (confirmed branch):** negative+positive grep on the new contract
  text; doctor check count synced (R5); `bash -n` if the check shells out.

### Task 4: Fix-or-note F2 — gate idempotency guard (reads verdict-f2)

**Files:** parts/step-b.md, parts/step-0.md, docs/masterplan/ops-audit-hardening/verdict-f2.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L102-L106](spec.md#L102-L106)
**Verify:**
```bash
grep -qE "^RESOLUTION: (fix-applied|docs-only-refuted)" docs/masterplan/ops-audit-hardening/verdict-f2.md
```

- **Branch on the Task 2 verdict (read `verdict-f2.md` first):**
  - **If `VERDICT: confirmed`:** add an idempotency guard near
    `parts/step-b.md:218` / `:303` (and/or resume controller
    `parts/step-0.md:174`) so an already-approved gate cannot re-fire without a
    `phase` advance — record the approved gate id and short-circuit a re-fire
    attempt. Append `RESOLUTION: fix-applied` to `verdict-f2.md`.
  - **If `VERDICT: refuted`:** docs-only note; no source change. Append
    `RESOLUTION: docs-only-refuted`.
- **Verification (confirmed branch):** negative+positive grep; a hand-traced
  re-entrance scenario shows the guard short-circuits.

### Task 5: F3 — generalize summary-first / read-budget to all hosts

**Files:** parts/step-0.md, parts/codex-host.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L66-L76](spec.md#L66-L76)
**Verify:**
```bash
grep -qiE "summary-first|read budget|large-read" parts/step-0.md
grep -qiE "summary-first|read budget" parts/codex-host.md   # host-specific bits retained
```

- **Goal:** reduce context-exhaustion resumptions by making the Codex-host
  context discipline host-agnostic.
- **Changes:** lift the summary-first inventory + large-read-budget rule from
  `parts/codex-host.md:87`, `:98-100` into a host-agnostic context-control rule
  (likely the `parts/step-0.md` context section or a contract under
  `parts/contracts/`), referenced by the router. Keep the Codex-host section's
  host-specific bits; avoid contradiction.
- **Verification:** fresh-eyes Explore read confirms no contradiction between the
  generalized rule and the retained Codex-host text; grep shows the rule is
  reachable from the non-Codex path.

### Task 6: F4 — file-descriptor / ulimit preflight

**Files:** parts/step-0.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L78-L88](spec.md#L78-L88)
**Verify:**
```bash
grep -qiE "ulimit|EMFILE|file descriptor|open files" parts/step-0.md
# bash -n any shell snippet added (extract to a temp file in-task and syntax-check)
```

- **Goal:** Step 0 aborts gracefully on a low/exhausted fd budget instead of
  dying opaquely on EMFILE.
- **Changes:** insert a preflight between `parts/step-0.md:67` (end CC-3
  indicator) and `:107` (first heavy file reads): check `ulimit -n`; if below a
  safe threshold or if a probe read fails with EMFILE, emit a clear remediation
  message (raise `ulimit -n`) and abort before the bootstrap file storm.
- **Safe threshold:** default `1024` open files (soft limit). Step 0 bootstrap
  opens the router + 1-3 phase files + config tiers + state.yml + events.jsonl,
  and a wave dispatch can hold several subagent transcripts open concurrently;
  1024 gives comfortable headroom while still catching a pathologically low
  limit (e.g. 256). Implementer may refine by grepping concurrent file-open call
  sites, but must not set it below 256.
- **Verification:** simulate a low `ulimit -n` in a subshell → preflight aborts
  with the message; normal budget → no-op. `bash -n` on any shell snippet.

### Task 7: Doctor + version + sync (depends on T3/T4/T5/T6)

**Files:** .claude-plugin/plugin.json, .codex-plugin/plugin.json, CHANGELOG.md, README.md, docs/internals.md, parts/doctor.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L114-L116](spec.md#L114-L116)
**Verify:**
```bash
grep -qE "\"version\"" .claude-plugin/plugin.json
grep -q "$(grep -oE '\"version\": \"[0-9.]+\"' .claude-plugin/plugin.json | grep -oE '[0-9.]+')" CHANGELOG.md
```

- **Goal:** finalize and keep all sync'd locations in agreement (R5).
- **Changes:** bump `.claude-plugin/plugin.json` (and Codex manifest if it
  carries a version); add CHANGELOG entry; if a doctor check was added (Task 3
  confirmed branch), update its count everywhere it is asserted (parallelization
  brief, README, internals).
- **Verification:** run doctor end-to-end; confirm no new false positives; grep
  that version + check counts agree across README / internals / doctor.

## Verification summary

- Per-task grep discriminators (negative + positive) for every source edit.
- `bash -n` for any shell touched (preflight, doctor check).
- Doctor full run at Task 7.
- Fresh-eyes Explore pass after the edit waves (anti-pattern #5).
- No production-visible or destructive actions; all changes are local source
  edits on the `main` working tree of this plugin repo.

## Risks / notes

- Task 3/Task 4 may collapse to docs-only if repro refutes the signal — this is
  an expected outcome of the repro-first posture, not a failure. The branch is
  resolved inside the task body (implementer reads the verdict file), so the task
  graph stays stable.
- `doctor.md` is large (~1991 lines); appending a check must not perturb existing
  check numbering relied on elsewhere (R5 sync).
- F3 rule generalization risks contradicting the Codex-host section — the
  fresh-eyes read is the guard.
