# Spec — Intent to completion

**Run:** `intent-to-completion` · **Target release:** v10.0.0 · **Shape:** prompt-first, minimal code (user decision, A8)
**Review status:** rev 2 — rewritten after the spec-gate adversary review (18 findings, verdict FAIL); dispositions in §13.

## 1. Problem

Masterplan takes an order literally. The interview asks *how*-level questions, stops before it
understands, and never makes its understanding visible in a form the operator can correct cheaply.
The goals it freezes are a checklist of test-level items, so plan coverage and the finish-time
assessor measure the checklist rather than the intent. The finish flow ends at merge: release,
install, and restart are left as "next steps" in the retro, and the running surface keeps old code
while the run is archived as complete.

Underneath all three is one defect class found during this brainstorm: **knobs with a writer and a
documented meaning but no effective consumer.** `--complexity` and `--autonomy` are accepted,
stored, described in the README, and read by nothing (autonomy is read only by the prompt, and
seeded `null`, so the operator's configured `loose` never engages). No unreferenced-symbol audit
can see this; a "does a different value produce different behavior" test can.

## 2. Outcome (what is true when this ships)

1. A run at `complexity: high` leaves the interview only when the questions asked were about intent
   (why, outcome, anti-goals, what "live" means), a fresh-context critic finds no design-changing
   unknown, and the operator has picked at least one concrete design option without correction —
   inside a bounded budget recorded on disk, not in the model's head.
2. `goals.md` records intent (why / outcome / anti-goals / done-means) above 3–5 outcome goals.
   Plan coverage, the mid-run reminder, the assessor, and the final gate all read the intent.
3. A run archives as **complete** only after the repo's declared definition of done executed on the
   merged base, the live check passed, a post-deploy assessment bound to the deployed commit ran,
   and the operator answered one question: *does this do what you meant?* Any other archive is
   recorded as **incomplete** with its reason and can never satisfy this outcome.
4. `complexity` and `autonomy` resolve from CLI > repo `.masterplan.yaml` > `~/.masterplan.yaml` >
   defaults, are validated, are never `null`, and drive documented behavior. A knob inventory plus
   per-knob behavioral contract tests fail the suite on any future inert knob.
5. Seeding a run first surfaces existing runs that overlap it and records what was reviewed.
6. Every gate reports exact context-window usage and recommends compaction at the boundary where
   it is cheapest; a post-compaction brief keeps run state in context.
7. v10.0.0 is released and installed where it executes by a **recorded bootstrap** (§10), and a
   successor run on the installed v10 exercises the full deploy-to-confirm flow for real.

## 3. Non-goals

- Not an interrogation. The interview never asks the operator to make an implementation choice; it
  proposes options and records the reaction.
- No prose restatement the operator must grade. Understanding is shown through small pick-one
  questions and concrete proposals (operator feedback 2026-09-02).
- Not a general release tool. The `done:` block runs the repo's own commands; masterplan does not
  bump versions or push tags itself.
- Not a return of the v7 `.masterplan.yaml` surface. Only the keys in §4 are recognized; the rest
  warn.
- Deferred follow-ups in retros may remain open (operator decision).
- Not an "auto /compact": the harness has no such lever (§9).

## 4. Config plane (code)

### 4.1 Resolution and schema

`lib/config.mjs` → `resolveRunConfig({ cli, repoRoot, home, env })` returns
`{ values, sources, warnings }`. Precedence (highest first): CLI flags to `mp seed` · repo-local
`<MAIN>/.masterplan.yaml` · user-global `~/.masterplan.yaml` · built-in defaults.

| key | type | CLI flag | allowed sources | default |
|---|---|---|---|---|
| `complexity` | enum `low\|medium\|high` | `--complexity` | all | `medium` |
| `autonomy` | enum `gated\|loose\|full` | `--autonomy` | all | `gated` |
| `planning_mode` | enum `serial\|parallel\|auto` | `--planning-mode` | all | from complexity (§4.2); an explicit value at any source wins |
| `adversary_review` | `on\|off` | `--adversary-review` | all | `on` |
| `render_images` | `on\|off` | `--render-images` | all | `off` |
| `fabric` | `on\|off` | `--fabric` | all | `on` |
| `context_watch` | object `{threshold: 1–99, focus: string}` | — | all | `{threshold: 70, focus: <§9 default>}` |
| `done` | object (§7.1) | — | **repo-local only** | absent |

Rules: nested objects (`context_watch`, `done`) are replaced whole by the highest source that sets
them — no deep merge. `auto_compact` is accepted as a deprecated alias for `context_watch` with a
warning. `done` found in the user-global file or on the CLI is ignored with a warning: executable
steps come only from the reviewed repo file. Unknown keys warn (`unsupported key 'max_wave_size'
(v7) — ignored`), are printed by `mp seed`, and are recorded as one `config_warning` event.
Malformed YAML in either file fails the seed with the parse error (the operator meant to configure
something). An invalid enum value at any source fails the seed with the allowed list.

`mp seed` calls the resolver and writes the resolved values into `state.yml`. `complexity_source`
and the new `autonomy_source` are derived (`cli | repo | user | default`), never user-supplied;
`--complexity-source` and `--predecessor-transcript` are removed (`--predecessor=<slug>` is the live
mechanism). Existing bundles carrying the old fields validate unchanged (`migrate` tolerates them;
no schema bump). `mp config show --repo-root=<MAIN> [--cli=…]` is read-only and prints
`{values, sources, warnings, harness: {autoCompactWindow}}`.

### 4.2 Levels

| complexity | interview floor | interview cap | critic | planning default |
|---|---|---|---|---|
| `low` | 0 | 4 | off | serial |
| `medium` | 4 | 10 | once, before the design options | auto |
| `high` | 8 | 20 | after every round | auto |

A **round** is one `AskUserQuestion` call (1–4 questions) and its answers. The floor is the
minimum number of answered questions before convergence may be claimed; the cap is the maximum
asked. Convergence also requires a valid critic receipt (§5.4); if the critic lane is unavailable,
the interview may not claim convergence — it proceeds only at the cap, records
`critic_unavailable`, and every remaining unknown becomes an `assumed` row.

| autonomy | between waves | deploy steps | user-only steps |
|---|---|---|---|
| `gated` (default) | ask | ask before each step | hand back, wait for evidence |
| `loose` | auto-progress | auto-run; ask only on failure | hand back, wait for evidence |
| `full` | auto-progress | auto-run; ask only on failure | hand back, wait for evidence |

Invariant, unchanged from §2d: the gate set is identical at every autonomy level.
`branch_finish`, a failed `live_check`, `deploy_failed`, `deploy_indeterminate`, and
`intent_confirm` always halt. `full` differs from `loose` only in the existing §2d verification
clause. This table is the single definition; README, SKILL.md, and the sequencer cite it.

### 4.3 Knob remediation (from the audit)

| knob | finding | remedy |
|---|---|---|
| `--complexity` | unvalidated (a bundle carries `moderate`), no reader, README claims "auto-detected" | validated; resolved via §4.1; consumed by the interview budget (§5) and planning default; README corrected |
| `--autonomy` | unvalidated, seeded `null`, prompt-only reader | validated; resolved via §4.1; consumed by the deploy stage (§7) and the §2d contract |
| `--complexity-source` | free text, always `null` | removed; field derived |
| `--predecessor-transcript` | write-only, always `null` | removed; field tolerated on old bundles |
| `--et`, `--new` | in the flag whitelist, never read | removed |
| `plan_path` | stored, never read by code | `merge-plan-fragments` and the planner op default `--plan-md` from it |
| `MP_DISPATCH_WAVE_CONCURRENCY`, `MP_ROUTING_POLICY`, `SKYNET_VERIFY_ALLOWLIST` | read, undocumented | documented in `docs/verbs.md` § Environment and listed in the inventory |
| `~/.masterplan.yaml`, repo `.masterplan.yaml` | no loader | §4.1 |

### 4.4 Inventory and contract guard

Two tests, both required:

1. **`test/knob-inventory.test.mjs`** — a generated inventory of every control surface: `mp` flag
   whitelist entries, §4.1 config keys (nested paths included), every field `buildSeedState` emits
   (nested included), every `process.env.*` read in `lib/`/`bin/`, and every prompt-only control
   the sequencer declares in a `<!-- knob: name -->` marker. Each entry must resolve to either a
   contract test name (below) or an exemption in a closed metadata schema
   (`{created_at, schema_version, slug, topic}` and nothing else). A new entry with neither fails
   the suite. A lexical "has a reader" pass is still run as a cheap early signal, but it is not the
   proof.
2. **`test/knob-contract.test.mjs`** — for every non-metadata entry, a test that two values produce
   the documented difference in an observable output: an `mp` op, a gate, an event, a rendered
   protocol line, or a seeded state field. Examples: `complexity` low vs high → `mp interview status`
   caps differ; `autonomy` gated vs loose → `run_deploy_step.ask` differs; `planning_mode` →
   `resume-phase` op differs; `context_watch.threshold` → the gate line's recommendation differs.
   The suite also seeds a synthetic knob that is *read but ignored* and asserts the guard fails on
   it — the semantic-inertness case, not just the unread case.

## 5. Interview protocol (prose + one agent + a small ledger)

Replaces the sequencer's "invoke `superpowers:brainstorming` directly" with a masterplan-owned
questioning phase; the brainstorming skill still governs the design/spec half.

### 5.1 Steps

1. **Context.** Existing recon, plus the seed-time overlap check (§8).
2. **Budget.** `mp interview status --state=<path>` returns `{asked, answered, floor, cap,
   design_picks, critic_receipts, converged}` derived from the ledger (§5.3) and `state.complexity`.
   The prompt reads it before every round; it never keeps its own count.
3. **Question discipline.** A question may only be about: the problem behind the ask, the outcome
   in the world, what would make it a failure even if tests pass, constraints and taste, what "live"
   means for this change. One fork per question, 2–4 options, recommended option first, no option
   longer than ~25 words. A *how* question (which file, which flag, which library) is forbidden: the
   model proposes 2–3 concrete options with a recommendation and records the operator's pick as a
   `design` entry. The intent-vs-how classification is a judgment the prompt makes and the critic
   reviews (§5.4); it is **not** mechanically enforced, and the docs say so.
4. **Critic round** (per §4.2): dispatch `agents/mp-intent-critic.md` (critic class, breaker role,
   frontier lane, read-only, fresh context) with the verbatim anchor, the ledger, and the current
   intent draft as QUOTED DATA. It returns `{unknowns: [{question, why_it_changes_design,
   options}], misclassified: [ids], contradictions: [...], intent_draft: {...}}` ranked by design
   impact. The orchestrator asks the top unknowns next; a `misclassified` entry is re-asked as a
   proposal.
5. **Convergence.** Claimed only when `mp interview status` reports `converged: true`: floor met,
   ≥ 1 uncorrected design pick, and the latest critic receipt has zero design-changing unknowns. At
   the cap without convergence, the model says so and proceeds with every remaining unknown written
   as an `assumed` row in the Assumptions table.
6. **Output.** The intent block (§6) is written into `goals.md` and the same text appears as
   `## Intent` in `spec.md`. The operator reviews it at the spec gate; there is no separate
   "confirm my restatement" question.

### 5.2 Bootstrap note

This run's own interview ran under the installed v9.10.0 and is recorded only in this spec's
Assumptions table and the WORKLOG; the ledger below exists from v10.0.0 on.

### 5.3 Ledger (decision D1)

Deterministic verbs, each an `events.jsonl` append through the existing single writer:
`mp interview ask --state --id=Q<n> --kind=intent|design --text=…` (refuses a duplicate id, an id
out of sequence, or an ask past the cap), `mp interview answer --state --id --text=… [--corrected]`,
`mp interview critic --state --receipt=<json>` (dispatch id, model, output tokens, unknown count),
and the read-only `mp interview status`. `goals-load` on a v10 bundle refuses when `converged` is
false unless `--interview-waived --reason=…` is given (durable `interview_waived` event). Verbatim
question and answer text is stored so a compaction mid-interview resumes from disk.

The alternative (D1-b, the operator's earlier "budget as generic events") keeps only a count and
cannot refuse an over-cap ask or prove a design pick; the review rated that a blocking gap. D1 is
recommended; the operator decides at approval.

## 6. Intent-first goals (small parser change)

### 6.1 Format v2

```markdown
topic: |
  <verbatim original request>

## Intent
why: <the problem behind the ask, in the operator's framing>
outcome: <what is true in the world when done>
anti_goals: <what would make this a failure even if tests pass>
done_means: <release | install | restart | live check — the done: groups this run needs, plus run-specific live evidence>

## G1: <outcome-level statement>
## G2: <outcome-level statement>
```

3–5 goals: `validateGoals` errors on 0 and on more than 5 for a v2 document. `signal:` and
`evidence:` are optional; if present they are kept in the hash (legacy v1 keeps parsing and
keeps its 3–7 guidance). `goalsHash` covers the Intent block, so amending intent re-arms the spec
gate exactly as amending a goal does. The anchor remains immutable (`validateAmendment`
unchanged). A document with an `## Intent` block is v2; without one it is v1.

**Bootstrap exception (normative).** This run's `goals.md` is v1 because the installed v9.10.0
parser validates it; its intent lives in §2 of this spec. The successor validation run (§10) is the
first v2 bundle.

### 6.2 Consumers

- **Plan coverage:** unchanged; every `G<n>` must be cited by ≥ 1 task.
- **Mid-run reminder:** the wave summary quotes the `outcome:` line.
- **Assessor (`mp-goal-assessor` v2)** runs twice (§7.3): an implementation assessment before the
  disposition (as today, over the branch diff and verify output) and a final assessment after the
  live check, over the deployed commit, the deploy-event chain, and the live-check digest. Both
  return per-goal verdicts; only the final one returns the `intent_verdict`
  `{met | partial | missed, evidence}`. The missing-evidence rule and the receipt tuple are
  unchanged; the final receipt additionally binds `{deployed_sha, deploy_chain_hash,
  live_check_digest}`.
- **`goals_unmet` gate:** opens after either assessment; the final one includes the intent verdict.

## 7. Finish drives to live (prose + durable gates in finish-step)

### 7.1 Definition of done — `done:` block, repo-local `.masterplan.yaml`

```yaml
done:
  version_from: .claude-plugin/plugin.json      # file whose "version" fills ${version}
  release:
    - run: node scripts/release.mjs --version=${version}
      check: git tag --list v${version}         # idempotency probe: non-empty output = already done
  install:
    - run: git push origin main --follow-tags
      check: git ls-remote --tags origin v${version}
    - run: node bin/install-pi.mjs --ref=v${version}
      check: node bin/install-pi.mjs --check --expect=v${version}
  live_check:
    - run: node bin/install-pi.mjs --check
    - run: node bin/doctor.mjs --only=plugin-registry-drift
  user_only:
    - text: "/plugin update masterplan, then /reload-plugins"
      evidence: "mp version from the plugin cache prints v${version}"
```

Each step is `{run, check?}` (or `{text, evidence}` for `user_only`). `${version}` is validated as
semver before substitution and shell-escaped; a step's resolved command and its source (`repo`) are
recorded in its receipt. `release`, `install`, and `live_check` are **mandatory** groups; a run
that skips any of them archives as incomplete (§7.4). `user_only` steps are handed back with the
exact text and the evidence expected; finish waits.

### 7.2 finish-step order and ops

`docs_normalize → run_verify → run_goal_check (implementation) → write_retro →
run_adversary_review → branch_finish → deploy stage → run_final_check → intent_confirm → archive`.

| op | shell does | then |
|---|---|---|
| `run_deploy_step {group, index, run, check, cwd: MAIN, ask}` | finish-step has already written `deploy_step_started {group, index, sha}`. Under `gated` (or `ask: true`) AUQ first; run from MAIN on the base; capture exit + output digest | `--deploy-step-done --group --index --exit=N --digest-file=…` → `deploy_step {group, index, sha, exit, digest, source}` |
| `ask gate:'deploy_indeterminate' {group, index}` | a `deploy_step_started` exists at this sha with no `deploy_step`: a crash mid-step. If the step has `check`, finish-step runs it first and resolves silently (non-empty output → recorded done; empty → re-run). Without `check`, AUQ: mark done with evidence / re-run / abort | `--deploy-step-done` with the evidence digest · `--deploy-rerun` · `--deploy-abort` |
| `ask gate:'deploy_failed' {group, index, error}` | AUQ: retry / abort finish. `live_check` has no other option. For `release`/`install` a third option, *skip with reason*, is offered and produces an incomplete archive (§7.4) | `--deploy-retry` · `--deploy-skip --reason=…` · `--deploy-abort` |
| `handback {group: 'user_only', text, evidence}` | present, wait; the operator answers with evidence | `--deploy-step-done` with the evidence digest |
| `run_final_check {deployed_sha, deploy_chain, live_digest, goals_path}` | dispatch the assessor (§6.2 final) | `mp record-goal-check --final --receipt=…` |
| `ask gate:'intent_confirm' {outcome, intent_verdict, live_check_digest}` | one question: *does this do what you meant?* | `--intent-confirmed` → `finish_confirmed {sha}` → archive complete · `--intent-rejected --class=implementation\|intent --reason=…` (§7.5) |

### 7.3 Dispositions and commit identity

- **`merge`** enters the deploy stage after the merge transaction; the deploy runs on MAIN at the
  merged base tip, recorded as `deploy_base_sha`.
- **`pr`** enters the deploy stage only after `--merged --merge-sha=<sha>`: the shell (or the
  operator) supplies the merge commit, finish-step verifies `git -C MAIN merge-base --is-ancestor
  <sha> HEAD` on the base branch after a fetch, and records it as `deploy_base_sha`. `--pushed`
  alone retires nothing and deploys nothing.
- **`keep`** and **`discard`** archive as **incomplete** (`completion: incomplete:kept` /
  `incomplete:discarded`, §7.4) with `deploy_skipped` and `intent_confirm_skipped` events. They
  are the operator's own "not done" decisions; they never satisfy Outcome 3.

### 7.4 Completion class and the replay guard

`state.completion` is written at archive: `complete` or `incomplete:<reason>`. `runs list`, `mp
status`, and the retro print it, and the doctor's `dangling-run` family gains an
`incomplete-archive` INFO line so incomplete archives stay visible. A missing `done:` block yields
`incomplete:no-done-config` unless the operator supplies run-specific live-evidence commands at
`intent_confirm` time (derived from `done_means`); the doctor WARNs `no-definition-of-done` for
the repo.

The machine's archive shortcut (retired disposition → archive) is replaced: archive requires a
durable `finish_confirmed {sha}` event (written by `--intent-confirmed`, or by the incomplete paths
with their reason) whose `sha` equals `deploy_base_sha`. A retired disposition without it re-enters
the deploy stage at the first step lacking a `deploy_step` event at that sha. This is the
event-keyed re-entry the verified-SHA and adversary-review steps already use.

### 7.5 Intent rejected

`--intent-rejected --class=implementation` records `intent_rejected` and stops finish; the run
stays in `execute` and follow-up tasks are added with `mp amend-plan`. `--class=intent` means the
captured intent itself was wrong: finish stops, the operator amends `goals.md` via `mp goals-amend`
(new hash → spec gate re-armed, prior assessor receipts no longer match), and the run re-plans the
affected tasks before a later finish. Neither class can reuse a stale `goal_check` receipt.

### 7.6 Stalls

"Run stalls mid-execution" is addressed by autonomy finally resolving to the operator's configured
`loose` (§4) so the existing §2d auto-progress contract engages, plus the `stalled-bundle` doctor
check already present. No new mechanism.

## 8. Seed-time overlap check (prose + two fields + one event)

`mp runs list` gains `topic` (first 300 characters) and `worktree` (path or null) per record.
Before `mp seed`, the shell reads the inventory and judges overlap (semantic; prompt-side): any
in-progress run is a potential worktree/file conflict; archived runs whose topic overlaps the new
one are candidates for `--predecessor`. The decision is recorded by
`mp event --type=overlap_review --data='{candidates:[…], action:…}'` before the seed.

AUQ rule: under `gated`, the AUQ lists in-progress conflicts and archived candidates and offers
continue · link as predecessor · resume that run · abort. Under `loose`/`full`, the AUQ fires only
when an in-progress conflict exists; archived candidates are recorded in the event and folded into
the interview context without asking.

## 9. Context watch at gates (small code + prose + a doctor check)

`context_watch: { threshold, focus }` (§4.1). `mp context-status --session=$CLAUDE_CODE_SESSION_ID
--repo-root=<MAIN> [--window=N]` resolves the **main** session transcript
(`<config-dir>/projects/<encoded MAIN path>/<session>.jsonl`, the encoding `lib/paths.mjs` already
uses; subagent transcripts live under the tasks directory and are never read), takes the last
assistant record's `usage` (`input + cache_read + cache_creation` is the exact in-context count),
and returns `{tokens, window, window_source, pct, model, state}`. `state` is `current` when the
last record is an assistant usage record, `post-compaction` when the last record is a compaction
boundary with no usage after it (then `pct: null` and the gate line prints
`context: unknown (just compacted)`), and `unsupported` on a harness with no such transcript (Pi:
the line is omitted; no number is ever fabricated). Window: `--window` > `MP_CONTEXT_WINDOW` >
a `[1m]`-suffixed model in the harness settings → 1,000,000 > 200,000 default.

The CC-3 turn-close prints one line at every gate (`context: 294k / 1M (29%)`). At or above
`threshold` it adds `recommend: /compact <focus>` with the masterplan-authored focus: `run <slug>,
phase <phase>, gate <id>; keep goals.md outcome + open gate; drop tool output`.

Harness facts (verified 2026-09-02 against the Claude Code hooks, settings, and statusline docs):
no tool or hook can initiate compaction; `PreCompact` can only block it and cannot set
`custom_instructions`; automatic compaction fires at the user-scoped `autoCompactWindow` setting
with a `null` focus; a `SessionStart` hook with `source: "compact"` runs after any compaction and
its output is injected into the compacted context. Therefore:

1. **State survival** — `mp resume-brief --state=<path>` prints a 5-line brief (slug, phase, open
   gate, the `outcome:` line, the next `mp` op). The fleet hook system registers a
   `SessionStart(source: compact)` rule that invokes it for the active bundle. This repo ships the
   verb, the rule's documented wiring, and a doctor check `resume-brief-hook` that WARNs when
   `/srv/workflows/hooks/policy.toml` is present but lacks the rule. Registering the rule is a
   `user_only` step in this repo's `done:` block (A18).
2. **Threshold advice** — `mp config show` reports the harness `autoCompactWindow` when readable and
   recommends a value no lower than the run's `threshold`; it never edits harness settings.

## 10. Bootstrap — how v10 gets installed, honestly

This run executes under the installed v9.10.0, whose sequencer and `finish-step` know nothing of
§7. Therefore:

1. This run's finish uses the v9.10.0 flow (verify → goal check → retro → review → `branch_finish`
   merge → archive). Its goals (G1–G5) are assessable from the branch: code, tests, docs, agents.
2. **Recorded bootstrap**, performed by the operator with the orchestrator, after the merge and
   before this bundle is archived: `RELEASING.md` steps 1–10 for v10.0.0 (which from this release
   are executed by `scripts/release.mjs` + the §7.1 `done:` block run by hand), then
   `/plugin update masterplan`, `/reload-plugins`, `install-pi --check`. Each step's evidence is
   appended to this bundle as `bootstrap_step` events via `mp event`, so the retro shows the install
   as a receipt, not a claim.
3. **Successor validation run** (`v10-validation`, seeded with `--predecessor=intent-to-completion`
   on the installed v10): the first v2 `goals.md`, a small real change, and a finish that exercises
   the deploy stage, `run_final_check`, and `intent_confirm` end-to-end. Its archive with
   `completion: complete` is the evidence for Outcome 7. That run is out of this run's scope but is
   named here so nobody mistakes step 2 for it.

## 11. Test plan

Named suites, each required by §4.4's inventory or by a finding in §13:

- `config`: each of the four sources wins in turn; nested whole-object replacement; explicit
  `planning_mode` vs complexity default; `done` ignored outside the repo file with a warning;
  unknown key → warning; malformed YAML → seed fails; invalid enum at every level → fails;
  `*_source` derived; `auto_compact` alias warns; removed flags rejected; legacy state fields
  tolerated by `migrate`.
- `knob-inventory`, `knob-contract` (§4.4), including the read-but-ignored synthetic knob.
- `goals` v2: Intent block parse; hash covers it; v1 still parses; 0 or > 5 goals → error;
  intent amendment re-arms the spec gate; v1/v2 detection.
- `interview-ledger-resume`: duplicate id refused; out-of-sequence refused; ask past cap refused;
  unanswered question blocks convergence; floor unmet blocks; false convergence without a critic
  receipt refused; replay after compaction reconstructs status; `goals-load` refuses unconverged
  without waiver.
- `finish-replay`: restart before disposition retirement, after retirement before the first
  `deploy_step_started`, after `started` before `deploy_step` (with and without `check`), after
  every gate; archive never reachable without `finish_confirmed` at `deploy_base_sha`.
- `deploy-commit-identity`: `pr` without `--merged` deploys nothing; `--merge-sha` not an ancestor
  of the base → `dispatch-error`; `keep`/`discard` → incomplete archive with events; mandatory
  group skipped → `incomplete:<reason>`; `live_check` non-zero → only retry/abort; no `done:` →
  `incomplete:no-done-config` unless run-specific evidence supplied.
- `final-check`: G-goals needing live evidence cannot pass from the implementation assessment;
  final receipt binds `deployed_sha`, `deploy_chain_hash`, `live_check_digest`; `intent_confirm`
  opens only after a final receipt.
- `intent-rejected`: both classes; stale `goal_check` receipts unusable after `goals-amend`.
- `overlap-sequencer`: in-progress conflict, archived overlap, no overlap, predecessor link, resume,
  abort; `overlap_review` event replayed idempotently; `runs list` carries `topic` and `worktree`.
- `context-status-session-lineage`: fixture transcripts for a fresh session, a resumed session, a
  subagent transcript present alongside (ignored), post-compaction with no usage, 200k and 1M
  windows, malformed usage, and Pi (`unsupported`).
- `resume-brief`, doctor `resume-brief-hook` and `no-definition-of-done`, `incomplete-archive`.
- `register-pi-agents`: picks up `mp-intent-critic`; `publish-hygiene`: 10.0.0 everywhere.
- `v9-to-v10-bootstrap`: a scripted walk of §10 steps 1–2 against a fixture install root proving
  every command the bootstrap needs exists on the branch.

## 12. Touch surface

**New:** `lib/config.mjs`, `lib/interview.mjs`, `lib/context-status.mjs`, `scripts/release.mjs`,
`agents/mp-intent-critic.md`, `.masterplan.yaml` (this repo), `docs/design/intent-interview.md`,
tests named in §11.
**Modified:** `bin/masterplan.mjs` (seed resolver, `config show`, `interview *`, `context-status`,
`resume-brief`, `runs list` fields, flag whitelist), `lib/bundle.mjs` (fields, `completion`),
`lib/goals.mjs` (v2), `lib/finish-step.mjs` (deploy stage, `run_final_check`, gates, replay guard),
`lib/runs.mjs` (`topic`, `worktree`), `lib/doctor/*` (three checks), `agents/mp-goal-assessor.md`
(final assessment), `commands/masterplan.md` (§3 interview + overlap, §2c deploy rows, §2d stop-set,
turn-close context line, `<!-- knob -->` markers), `README.md`, `skills/masterplan/SKILL.md`,
`docs/verbs.md`, `CHANGELOG.md`, `RELEASING.md`.

## 13. Adversary review dispositions (rev 1 → rev 2)

| # | severity | disposition |
|---|---|---|
| 1 replay shortcut archives before deploy | P1 | fixed — §7.4 `finish_confirmed` guard keyed to `deploy_base_sha` |
| 2 deploy commands not crash-safe | P1 | fixed — `deploy_step_started`, `check` probes, `deploy_indeterminate` gate (§7.2) |
| 3 goal assessment before deploy evidence | P1 | fixed — two assessments, final receipt bound to deployed commit (§6.2, §7.2) |
| 4 `--pushed` ≠ merged; keep/discard as success | P1 | fixed — `--merged --merge-sha` + ancestor check; keep/discard archive incomplete (§7.3, §7.4) |
| 5 waivable deployment still "complete" | P1 | fixed — mandatory groups, `completion` class, live_check unskippable (§7.1, §7.4) |
| 6 dogfood circularity | P1 | fixed — recorded bootstrap + successor validation run (§10); G6 dropped from goals |
| 7 interview ledger not enforcing | P1 | proposed as D1 (§5.3), operator decides at approval |
| 8 lexical liveness test | P1 | fixed — inventory + behavioral contract tests (§4.4) |
| 9 budget ambiguity | P2 | fixed — floor/cap table, round defined, critic failure policy (§4.2) |
| 10 artifacts not v2; 6 goals; present tense | P2 | fixed — bootstrap exception normative (§6.1), 5 goals, evidence as future receipts |
| 11 context-status robustness | P2 | fixed — lineage, states, window rule, Pi (§9) |
| 12 hook outside touch surface | P2 | fixed — doctor check + user_only step; G5 narrowed (§9) |
| 13 config semantics | P2 | fixed — schema table and rules (§4.1) |
| 14 executable `done` from global/CLI | P2 | fixed — repo-local only, semver validation, source in receipt (§4.1, §7.1) |
| 15 intent rejection classes | P2 | fixed — §7.5 |
| 16 overlap not durable | P2 | fixed — `overlap_review` event, fields, consistent autonomy rule (§8) |
| 17 audit narrowed | P2 | fixed — inventory covers all surfaces; named suites (§4.4, §11) |
| 18 `auto_compact` misnomer | P3 | fixed — `context_watch`, alias with warning (§4.1) |

## Assumptions & Open Decisions

| # | question | decision | rationale | source |
|---|---|---|---|---|
| A1 | Which interview failures to fix? | how-not-why, stops too early, no synthesis | operator's own diagnosis | user-confirmed |
| A2 | Interview budget at high? | floor 8, cap 20 | operator chose bounded over open-ended; exact numbers per review finding 9 | user-confirmed (bounded) / assumed (exact numbers) |
| A3 | Where do probing questions come from? | orchestrator plus a fresh-context cross-vendor critic each round | operator accepted the per-round dispatch cost | user-confirmed |
| A4 | Fate of the G-list checklist? | replaced by an Intent block plus 3–5 outcome goals | operator chose replacement | user-confirmed |
| A5 | What must "done" include? | released and installed where it executes; operator re-confirms intent | deploy left undone in prior retros | user-confirmed |
| A6 | Who performs deploy steps? | masterplan drives them, gated by autonomy | operator chose drive-with-gates | user-confirmed |
| A7 | Where does the definition of done live? | `done:` block in the repo's `.masterplan.yaml` | one file, one loader | user-confirmed |
| A8 | Overall shape? | prompt-first, minimal code | operator overrode the config-plane recommendation with the risk shown | user-confirmed |
| A9 | Code seams beyond prompt-first? | durable finish gates (deploy, final check, intent_confirm) | prose cannot keep archive last after deploy | user-confirmed |
| A10 | Release version? | v10.0.0 | goals.md format change | user-confirmed |
| A11 | Level semantics (§4.2)? | as tabled | presented; no objection raised | assumed |
| A12 | Can the model trigger compaction? | no; usage line, recommendation, post-compaction brief | verified against Claude Code docs 2026-09-02 | user-confirmed (harness fact) |
| A13 | Legacy `.masterplan.yaml` keys? | warn and ignore; malformed YAML fails | operator's fleet repos still carry v7 files | assumed |
| A14 | `full` vs `loose`? | identical for deploy; `full` keeps the §2d verification clause | avoids inventing semantics | assumed |
| A15 | Intent rejected? | two classes: implementation → execute; intent → goals-amend + re-plan | review finding 15 | assumed |
| A16 | No `done:` block? | incomplete archive unless run-specific evidence supplied; doctor WARN | review finding 5 | assumed |
| A17 | This run's goals.md schema? | v1; intent in §2; first v2 bundle is the successor run | installed 9.10.0 validates it | assumed |
| A18 | Who wires the post-compaction hook? | this repo ships verb + docs + doctor check; registration is a `user_only` done step | hooks declared only in policy.toml | assumed |
| A19 | `done` from user-global or CLI? | ignored with warning | executable steps must come from the reviewed repo file | assumed |
| A20 | keep/discard outcome? | archive as `incomplete:<reason>`, never complete | Outcome 3 | assumed |
| A21 | Dogfood evidence? | recorded bootstrap on this bundle; full flow proven by `v10-validation` | installed 9.10.0 cannot drive a v10 finish | assumed |
| **D1** | **Interview ledger verbs (§5.3) or generic events?** | **open — decided at approval** | review finding 7 vs A8 | pending |
