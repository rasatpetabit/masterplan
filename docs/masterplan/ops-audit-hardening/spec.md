# Spec — masterplan operational hardening (2026-05-27 transcript audit)

- **Slug:** `ops-audit-hardening`
- **Plan kind:** implementation (plugin self-fix)
- **Plugin version at audit:** 7.1.1
- **Driver:** 12-hour audit of Claude Code session transcripts surfaced operational
  issues with `/masterplan`. User scoped four findings into this plan with a
  **repro-first posture** (confirm confounded/unconfirmed signals before speccing fixes).

## Problem statement

A sweep of `~/.claude/projects/*/*.jsonl` from the prior 12 hours (7 parallel
Explore agents bucketed by project) surfaced candidate operational issues with
`/masterplan`. After version-filtering (dropping items already fixed in v7.0.1 /
v7.0.2 / v7.1.1) and reconciling one cross-agent contradiction, four findings
remain in scope. Each is anchored to current v7.1.1 source.

## Audit method (for reproducibility)

- Transcripts bucketed by project dir; signatures searched: boot banner
  (`→ /masterplan v`), `<masterplan-trace>` markers, `breadcrumb_emitted`,
  `gate=fire`, `spec_approval` / `plan_approval`, `summary_block_emitted`,
  `auq_render`, version strings.
- Findings filtered to **current-version relevance**. Excluded as already-fixed:
  routing regression (v7.1.1 / d130302), doctor Check #1 false positives
  (v7.0.2), doctor #18/#41 glob (v7.0.1).
- One contradiction reconciled: "breadcrumbs missing" in sessions `335b66e4` /
  `dba73a41` was **refuted** by raw counts (181/208 `masterplan-trace`, 21/45
  `breadcrumb_emitted` present). Demoted to non-issue.

## Findings (source-anchored)

### F1 — Boot banner under-emission (observability gap)

- **Symptom:** live v7.1.1 session `ab57e7c8` emitted the CC-2 boot banner only
  **3×** while `masterplan-trace` fired **318×** across many `/masterplan`
  invocations.
- **Contract says it must always fire:** `commands/masterplan.md:19–44`
  (CC-2 — Boot banner) and `parts/step-0.md:9–38` (Invocation sentinel).
  `step-0.md:13` — "the FIRST output of every `/masterplan` turn"; `step-0.md:38`
  — "CC-3-TRAMPOLINE does not apply; this is an unconditional first-line render."
  **No exemption** exists for `status` / `next` / bare-resume.
- **Gap:** the contract mandates emission on every turn, but runtime compliance
  is low, and there is **no doctor check that audits runtime banner-emission
  ratio** (doctor #36 checks only static *presence* of the contract text).
- **Confounder (why repro-first):** many `/masterplan` string hits are resumes /
  status / doc references, not fresh invocations — the true "should-have-emitted"
  denominator is unknown until classified.

### F2 — Gate re-entrance risk (spec_approval / plan_approval)

- **Symptom:** session `335b66e4` shows 68 `spec_approval` mentions and 30
  `gate=fire` events — suggesting a single approval may re-fire the gate.
- **Anchors:** `spec_approval` fires at `parts/step-b.md:218`; `plan_approval`
  at `parts/step-b.md:303`. `pending_gate` is written at the fire site and
  cleared only by explicit option routing (`step-b.md:220–223`, `:303`).
- **Gap:** **no idempotency / "already-fired" guard exists.** The only protection
  is the resume controller (`parts/step-0.md:174` — "If `pending_gate` is
  non-null, re-render that exact gate"). A re-entrance path exists if code clears
  `pending_gate` then routes back into B2 without advancing `phase`.
- **Confounder (why repro-first):** raw counts cannot distinguish genuine
  re-fires of one gate from legitimate distinct gates across a long multi-plan
  session. Must classify by gate `id` + plan slug + phase transition before
  concluding a bug.

### F3 — Context-budget friction (context exhaustion → repeated resumption)

- **Symptom:** one session required ~16 context-exhaustion resumptions.
- **Anchors:** lazy-load is structural (`commands/masterplan.md:100–102`,
  `parts/step-0.md:3`), but the **summary-first / large-read-budget guidance is
  scoped to the Codex host only** (`parts/codex-host.md:87`, `:98–100`) and is
  not generalized to Claude Code runs. No named "don't pre-read full
  plans/specs/transcripts" rule applies outside the Codex section.
- **Classification:** behavioral tuning, not a discrete bug. Mitigation =
  generalize the summary-first + large-read-budget discipline to all hosts and
  tighten orchestrator offloading.

### F4 — EMFILE / file-descriptor exhaustion aborts a run

- **Symptom:** an `EMFILE` ("No file descriptors available (os error 24)")
  aborted a `/masterplan:plan` run mid-Step-0 (banner emitted, no phase load).
- **Root cause:** environmental (low `ulimit -n`), **not** a plugin logic bug.
- **Gap:** Step 0 has **no fd / ulimit preflight** (`ulimit`, `EMFILE`,
  "file descriptor", "open files" appear nowhere in bootstrap). Insertion point:
  after the CC-3 indicator (`parts/step-0.md:67`) and before the first heavy
  file reads at config load (`parts/step-0.md:107`).
- **Goal:** the plugin should detect a low/exhausted fd budget and **abort
  gracefully with a remediation message** instead of dying opaquely mid-bootstrap.

## Requirements

**Posture (user-confirmed): repro-first.** The plan MUST open with bounded
investigation tasks that confirm or refute F1 and F2 against the cited
transcripts before any fix task is committed. Fix tasks for F1/F2 are
**contingent** on a confirmed signal.

- **R1 (F1):** Determine the true denominator of banner-requiring invocations in
  `ab57e7c8` (classify fresh-invocation vs resume/status). If under-emission is
  confirmed: raise the salience of the CC-2 unconditional-render rule AND add a
  doctor check that audits past-run banner-emission ratio. If refuted: document
  the resume/status reality and close F1 with no source change.
- **R2 (F2):** Classify the 30 `gate=fire` events in `335b66e4` by gate `id`,
  plan slug, and phase transition. If genuine same-gate re-entrance is confirmed:
  add an idempotency guard so an already-approved gate cannot re-fire without a
  phase advance. If refuted (distinct legitimate gates): close F2 with no source
  change.
- **R3 (F3):** Generalize the summary-first inventory + large-read-budget
  discipline from `parts/codex-host.md` to apply to all hosts (a host-agnostic
  context-control rule), reducing orchestrator context pressure on long runs.
- **R4 (F4):** Add a file-descriptor preflight to Step 0 bootstrap (between
  `step-0.md:67` and `:107`) that checks `ulimit -n` headroom and, on a low or
  exhausted budget, aborts with a clear remediation message rather than failing
  opaquely.
- **R5 (cross-cutting):** Any new doctor check, verb, or contract text must be
  synced across all locations per CLAUDE.md anti-pattern #4 (routing table,
  README, internals, doctor count). Version bump + CHANGELOG entry on completion.

## Success criteria

1. F1 and F2 each have a written **repro verdict** (confirmed / refuted) grounded
   in transcript evidence, recorded in the run bundle before any fix lands.
2. Confirmed fixes land with a negative+positive grep discriminator and
   `bash -n` where shell is touched.
3. F3 produces a host-agnostic context-control rule that a fresh-eyes read
   confirms does not contradict the existing Codex-host section.
4. F4 preflight aborts gracefully on a simulated low `ulimit -n` and is a no-op
   under a normal budget.
5. Doctor passes; version + CHANGELOG updated; all sync'd locations agree.

## In scope

- `commands/masterplan.md`, `parts/step-0.md`, `parts/step-b.md`,
  `parts/doctor.md`, `parts/codex-host.md` (rule generalization),
  `.claude-plugin/plugin.json` (version), `CHANGELOG.md`, `README.md` /
  `docs/internals.md` (sync only if a check/verb count changes).

## Out of scope

- Already-fixed items (routing, doctor #1, #18/#41).
- The reconciled breadcrumb non-issue.
- Environmental remediation of the host's `ulimit` itself (F4 is graceful
  handling only, not changing the OS limit).
- Any transcript-audit tooling productization beyond this one-off sweep.

## Evidence anchors

- `commands/masterplan.md:19–44` — CC-2 boot banner contract.
- `parts/step-0.md:9–38` — invocation sentinel; `:38` unconditional render.
- `parts/step-0.md:67` / `:107` — F4 preflight insertion window.
- `parts/step-0.md:172–179` — resume controller / pending_gate re-render.
- `parts/step-b.md:218` — spec_approval fire; `:303` — plan_approval fire;
  `:220–223` — pending_gate clear routing.
- `parts/codex-host.md:87`, `:98–100` — Codex-only summary-first / read budget.
- `parts/doctor.md` — 1991 lines; latest checks ~#46–#50; #36 static CC-3 presence.
- Transcripts: `ab57e7c8` (F1), `335b66e4` / `dba73a41` (F2 + reconciled
  contradiction), all under `~/.claude/projects/-srv-dev-yanos-project/`.
