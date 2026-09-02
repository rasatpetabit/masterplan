# Spec — Intent to completion

**Run:** `intent-to-completion` · **Target release:** v10.0.0 · **Shape:** prompt-first, minimal code (user decision, A8)
**Review status:** rev 4 — after three spec-gate adversary rounds (round 1: 18 findings, FAIL; round 2: 12 new + 10 residual, FAIL; round 3: 7, FAIL); dispositions in §13. Open for the operator: D1 (ledger verbs, resolved by assumption), D2 (Claude surface inside this run).

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
   inside a bounded budget recorded on disk, not in the model's head. Every bounded exit
   (converged, exhausted at the cap, critic configured off) is a named durable state.
2. `goals.md` records intent (why / outcome / anti-goals / done-means) above 3–5 outcome goals.
   Plan coverage, the mid-run reminder, the assessor, and the final gate all read the intent.
3. A run archives as **complete** only after the repo's declared definition of done executed on the
   merged base that contains the run's branch, the live check passed, a post-deploy assessment bound
   to that base ran, and the operator answered one question: *does this do what you meant?* Any
   other archive is recorded as **incomplete** with its reason and can never satisfy this outcome.
4. `complexity` and `autonomy` resolve from CLI > repo `.masterplan.yaml` > `~/.masterplan.yaml` >
   defaults, are validated, are never `null`, and drive documented behavior. A knob inventory plus
   per-knob behavioral contract tests fail the suite on any future inert knob.
5. Seeding a run first surfaces existing runs that overlap it — by topic, goals, and planned paths —
   and records what was reviewed as the new bundle's first event.
6. Every gate reports measured context usage where the harness exposes it, an explicit unknown
   state where it does not, and recommends compaction at the boundary where it is cheapest; a
   post-compaction brief keeps run state in context.
7. v10.0.0 is released, tagged, pushed, and installed into **both** running surfaces — the Pi
   install root before this run's goal check, the Claude plugin cache at this run's held
   `branch_finish` gate — before this run archives (frozen goal G6, §10). A successor run on the
   installed v10 then exercises the automated deploy-to-confirm flow.

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
- Not cryptographic provenance: receipts are honesty-bound (dispatch id, model, positive token
  counts, artifact digests), the same standard `record-gate-review` already applies.

## 4. Config plane (code)

### 4.1 Resolution and schema

`lib/config.mjs` → `resolveRunConfig({ cli, repoRoot, home, env })` returns
`{ values, sources, warnings }`. Precedence (highest first): CLI flags to `mp seed` · repo-local
`<MAIN>/.masterplan.yaml` · user-global `~/.masterplan.yaml` · built-in defaults.

| key | type | CLI flag | allowed sources | default |
|---|---|---|---|---|
| `complexity` | enum `low\|medium\|high` | `--complexity` | all | `medium` |
| `autonomy` | enum `gated\|loose` (`full` = deprecated alias of `loose`, warns) | `--autonomy` | all | `gated` |
| `planning_mode` | enum `serial\|parallel\|auto` | `--planning-mode` | all | from complexity (§4.2); an explicit value at any source wins |
| `adversary_review` | `on\|off` | `--adversary-review` | all | `on` |
| `render_images` | `on\|off` | `--render-images` | all | `off` |
| `fabric` | `on\|off` | `--fabric` | all | `on` |
| `context_watch` | object `{threshold: 1–99, focus: string}` | — | all | `{threshold: 70, focus: <§9 default>}` |
| `done` | object (§7.1) | — | **repo-local only** | absent |

Rules:
- Nested objects (`context_watch`, `done`) are replaced whole by the highest source that sets
  them — no deep merge. A partial `context_watch` object takes defaults for its missing keys;
  unknown nested keys warn.
- `auto_compact` is accepted as a deprecated alias for `context_watch` with a warning; if both are
  present the seed fails (`duplicate alias`).
- `done` found in the user-global file or on the CLI is ignored with a warning: executable steps
  come only from the reviewed repo file. Its schema is validated at seed (§7.1): unknown group
  names, a step that is neither `{run, check?}` nor `{text, evidence}`, or a `${version}` reference
  without a resolvable `version_from` all fail the seed.
- Unknown top-level keys warn (`unsupported key 'max_wave_size' (v7) — ignored`), are printed by
  `mp seed`, and are recorded as one `config_warning` event.
- Malformed YAML in either file fails the seed with the parse error. An invalid enum value at any
  source fails the seed with the allowed list.

`mp seed` calls the resolver and writes the resolved values into `state.yml`. `complexity_source`
and the new `autonomy_source` are derived (`cli | repo | user | default`), never user-supplied;
`--complexity-source` and `--predecessor-transcript` are removed (`--predecessor=<slug>` is the live
mechanism). Existing bundles carrying the old fields, or `autonomy: full`, validate unchanged
(`migrate` tolerates them; no schema bump). `mp config show --repo-root=<MAIN> [--cli=…]` is
read-only and prints `{values, sources, warnings, harness: {autoCompactWindow}}`.

### 4.2 Levels

| complexity | interview floor | interview cap | critic | planning default |
|---|---|---|---|---|
| `low` | 0 | 4 | off (configured) | serial |
| `medium` | 4 | 10 | once, before the design options | auto |
| `high` | 8 | 20 | after every round | auto |

A **round** is one `AskUserQuestion` call (1–4 questions) and its answers. The floor is the
minimum number of answered questions before the interview may end other than at the cap; the cap
is the maximum asked. Interview terminal states (§5.4): `converged`, `exhausted`, `critic_off`.

| autonomy | between waves | deploy steps | user-only steps |
|---|---|---|---|
| `gated` (default) | ask | ask before each step | hand back, wait for evidence |
| `loose` | auto-progress | auto-run; ask only on failure or indeterminate | hand back, wait for evidence |

`full` is retired as a distinct level: the v8 sequencer never gave it behavior that differed from
`loose`, and inventing one now would be the documented-versus-live mismatch this work removes. It
remains accepted as an alias (warning) so existing files keep working. Invariant, unchanged from
§2d: the gate set is identical at every autonomy level. `branch_finish`, `no_definition_of_done`,
`deploy_failed`, `deploy_indeterminate`, `intent_confirm`, and the seed-time overlap conflict AUQ
always halt. This table is the single definition; README, SKILL.md, and the sequencer cite it.

### 4.3 Knob remediation (from the audit)

| knob | finding | remedy |
|---|---|---|
| `--complexity` | unvalidated (a bundle carries `moderate`), no reader, README claims "auto-detected" | validated; resolved via §4.1; consumed by `mp interview status` caps and the planning default; README corrected |
| `--autonomy` | unvalidated, seeded `null`, prompt-only reader | validated; resolved via §4.1; consumed by `run_deploy_step.ask` and the overlap AUQ rule; `full` retired to alias |
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
   the suite. A lexical "has a reader" pass still runs as a cheap early signal; it is not the proof.
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
   active_design_picks, critic: {mode, receipts, latest_unknowns}, state}` derived from the ledger
   (§5.3) and `state.complexity`. The prompt reads it before every round; it never keeps its own
   count.
3. **Question discipline.** A question may only be about: the problem behind the ask, the outcome
   in the world, what would make it a failure even if tests pass, constraints and taste, what "live"
   means for this change. One fork per question, 2–4 options, recommended option first, no option
   longer than ~25 words. A *how* question (which file, which flag, which library) is forbidden: the
   model proposes 2–3 concrete options with a recommendation and records the operator's pick as a
   `design` entry. The intent-vs-how classification is a judgment the prompt makes and the critic
   reviews; it is **not** mechanically enforced, and the docs say so.
4. **Critic round** (per §4.2): dispatch `agents/mp-intent-critic.md` (critic class, breaker role,
   frontier lane, read-only, fresh context) with the verbatim anchor, the ledger, and the current
   intent draft as QUOTED DATA. Its payload `{unknowns: [{id, question, why_it_changes_design,
   options}], misclassified: [ids], contradictions: [...], intent_draft: {...}}` is persisted (§5.3).
   The orchestrator asks the top unknowns next; a `misclassified` entry is re-asked as a proposal.
5. **Exit.** Per §5.4. On `exhausted`, every remaining unknown from the latest critic payload is
   written as an `assumed` row in the spec's Assumptions table before the design is presented.
6. **Output.** The intent block (§6) is written into `goals.md` and the same text appears as
   `## Intent` in `spec.md`. The operator reviews it at the spec gate; there is no separate
   "confirm my restatement" question.

### 5.2 Bootstrap note

This run's own interview ran under the installed v9.10.0 and is recorded only in this spec's
Assumptions table and the WORKLOG; the ledger exists from v10.0.0 on.

### 5.3 Ledger (D1, resolved: verbs)

Deterministic verbs in `lib/interview.mjs`, each an `events.jsonl` append through the existing
single writer:

- `mp interview ask --state --id=Q<n> --kind=intent|design --text=…` — refuses a duplicate id, an
  id out of sequence, an ask while a question is unanswered, or an ask past the cap.
- `mp interview answer --state --id --text=… [--corrected] [--supersedes=Q<m>]` — `--supersedes`
  retires an earlier design pick; the active pick count is derived by replay (latest per fork).
- `mp interview withdraw --state --id` — retires an asked-but-unanswered question (it still counts
  against the cap); the only way an unanswered question leaves the ledger.
- `mp interview critic --state --receipt=<json> --payload-file=<path>` — the payload is copied to
  `<bundle>/interview-critic-<n>.json` (artifact, schema-validated: `unknowns[]`, `misclassified[]`,
  `contradictions[]`, `intent_draft`), and the event carries `{dispatch_id, model, output_tokens,
  payload_sha256, ledger_head, intent_sha256, unknown_count}`. `ledger_head` is the index of the
  last interview event the critic was shown and `intent_sha256` the digest of the intent draft it
  reviewed; the recorder computes both from the ledger and refuses a receipt that names different
  values, a receipt without dispatch id, model, and positive output tokens, or a payload whose
  digest does not match — the same honesty bound as `record-gate-review`; it is not tamper-proof
  and is documented as such.
- `mp interview end --state --reason=converged|exhausted|critic_off` — writes the terminal state
  after validating it against the ledger (§5.4).
- `mp interview status` — read-only.

Verbatim question and answer text is stored so a compaction mid-interview resumes from disk; the
latest critic payload is re-read from its artifact.

### 5.4 Terminal states and `goals-load`

Every terminal state requires **zero unanswered questions** (answer or withdraw first).

| state | valid when (in addition to the rule above) | `goals-load` |
|---|---|---|
| `converged` | floor met; ≥ 1 active uncorrected design pick; the latest critic receipt is valid, its `ledger_head` equals the current ledger head (no question or answer after it) and its `intent_sha256` equals the current intent draft; its payload has zero `unknowns`, and every `contradictions` and `misclassified` entry has a later answer or withdraw event referencing it | accepts |
| `exhausted` | asked == cap (any complexity), or critic mode is `unavailable` with floor met; the unknowns of the latest payload (if any) are listed in the event | accepts; the spec must carry the `assumed` rows |
| `critic_off` | `complexity: low`; floor met | accepts |
| `waived` | `goals-load --interview-waived --reason=…` on an open interview; durable `interview_waived` event | accepts, recorded as waived |
| (none) | interview still open | refuses |

Critic mode is `off` (configured, low), `on`, or `unavailable` (a dispatch failed: durable
`critic_unavailable` event with the error). `unavailable` never counts as `converged`.

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

A document with an `## Intent` block is v2; without one it is v1. For v2, `validateGoals` errors
when the goal count is below 3 or above 5. `signal:` and `evidence:` are optional; if present they
are kept in the hash (legacy v1 keeps parsing with its 3–7 guidance). `goalsHash` covers the Intent
block, so amending intent re-arms the spec gate exactly as amending a goal does. The anchor remains
immutable (`validateAmendment` unchanged).

**Bootstrap exception (normative).** This run's `goals.md` is v1 because the installed v9.10.0
parser validates it; its intent lives in §2 of this spec. The successor validation run (§10) is the
first v2 bundle.

### 6.2 Consumers

- **Plan coverage:** unchanged; every `G<n>` must be cited by ≥ 1 task.
- **Mid-run reminder:** the wave summary quotes the `outcome:` line.
- **Assessor (`mp-goal-assessor` v2)** runs twice (§7.2): an implementation assessment before the
  disposition (as today, over the branch diff and verify output) and a final assessment after the
  live check, over the deployed base, the deploy-event chain, and the live-check digest. Both
  return per-goal verdicts; only the final one returns the `intent_verdict`
  `{met | partial | missed, evidence}`. The missing-evidence rule and the receipt tuple are
  unchanged; the final receipt additionally binds `{deploy_base_sha, deploy_chain_hash,
  live_check_digest}`.
- **`goals_unmet` gate:** opens after either assessment; the final one includes the intent verdict.

## 7. Finish drives to live (prose + durable gates in finish-step)

### 7.1 Definition of done — `done:` block, repo-local `.masterplan.yaml`

```yaml
done:
  version_from: .claude-plugin/plugin.json      # file whose "version" fills ${version}
  release:
    - run: node scripts/release.mjs --version=${version}
      check: git rev-parse -q --verify refs/tags/v${version}
  install:
    - run: git push origin main --follow-tags
      check: git ls-remote --exit-code --tags origin refs/tags/v${version}
    - run: node bin/install-pi.mjs --ref=v${version}
      check: node bin/install-pi.mjs --check --expect=v${version}
  live_check:
    - run: node bin/install-pi.mjs --check
    - run: node bin/doctor.mjs --only=plugin-registry-drift
  user_only:
    - text: "/plugin update masterplan, then /reload-plugins"
      evidence: "mp version from the plugin cache prints v${version}"
    - text: "register the SessionStart(source: compact) resume-brief rule in /srv/workflows/hooks/policy.toml"
      evidence: "node bin/doctor.mjs --only=resume-brief-hook reports OK"
```

Each step is `{run, check?}` (or `{text, evidence}` for `user_only`). **`check` is a predicate on
exit status**: 0 = the step's effect is present, 1 = absent, any other exit (or timeout, or crash)
= indeterminate. Output is never interpreted. `${version}` must match
`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` before substitution and is single-quoted into the command; a
step's resolved command and its source (`repo`) are recorded in its receipt. `release`, `install`,
and `live_check` are **mandatory** groups; a run that skips any of them archives as incomplete
(§7.4). `user_only` steps are handed back with the exact text and the evidence expected; finish
waits.

### 7.2 finish-step order and ops

`docs_normalize → run_verify → run_goal_check (implementation) → write_retro →
run_adversary_review → branch_finish → deploy stage → run_final_check → intent_confirm → archive`.

| op | shell does | then |
|---|---|---|
| `ask gate:'no_definition_of_done'` | opens at deploy-stage entry when the repo has no `done:` block. AUQ: supply run-specific commands now (release/install/live_check as `{run, check?}`) / archive incomplete | `--done-adhoc-file=<json>` (durable `done_adhoc` event; the stage proceeds with those steps) · `--deploy-abort-incomplete --reason=no-done-config` |
| `run_deploy_step {group, index, run, check, cwd: MAIN, ask}` | finish-step has already written `deploy_step_started {group, index, sha}`. Under `gated` (or `ask: true`) AUQ first; run from MAIN on the base; capture exit + output digest | `--deploy-step-done --group --index --exit=N --digest-file=…` → `deploy_step {group, index, sha, exit, digest, source}` |
| `ask gate:'deploy_indeterminate' {group, index}` | a `deploy_step_started` exists at this sha with no `deploy_step`. If the step has `check`, finish-step runs it first: exit 0 → recorded done silently; exit 1 → re-run silently; other → this gate. Without `check`, this gate. AUQ: mark done with evidence / re-run / abort | `--deploy-step-done` with the evidence digest · `--deploy-rerun` · `--deploy-abort` |
| `ask gate:'deploy_failed' {group, index, error}` | AUQ: retry / abort finish; for `release` and `install` a third option, *skip with reason*, archives incomplete (§7.4). `live_check` offers no skip | `--deploy-retry` · `--deploy-skip --reason=…` · `--deploy-abort` |
| `handback {group: 'user_only', text, evidence}` | present, wait; the operator answers with evidence | `--deploy-step-done` with the evidence digest |
| `run_final_check {deploy_base_sha, deploy_chain, live_digest, goals_path}` | dispatch the assessor (§6.2 final) | `mp record-goal-check --final --receipt=…` |
| `ask gate:'intent_confirm' {outcome, intent_verdict, live_check_digest}` | one question: *does this do what you meant?* | `--intent-confirmed` → `completion_confirmed {deploy_base_sha}` → archive complete · `--intent-rejected --class=implementation\|intent --reason=…` (§7.5) |

`--deploy-abort` stops finish with nothing archived; the run stays resumable and the next finish
re-enters at the first step lacking a `deploy_step` event at the current `deploy_base_sha`.

### 7.3 Dispositions and commit identity

`deploy_base_sha` is always **MAIN's base-branch tip at deploy-stage entry**, recorded in a
`deploy_base {sha, branch_tip}` event, and finish-step verifies before recording it that the run
branch's tip (`branch_tip`, captured at `branch_finish`) is an ancestor of that sha
(`git -C MAIN merge-base --is-ancestor <branch_tip> <sha>`). Every deploy receipt and the final
assessment bind to `deploy_base_sha`. **Every** later boundary — the next `run_deploy_step`,
`run_final_check`, opening `intent_confirm`, and the archive itself — first checks that MAIN's
base tip still equals `deploy_base_sha`; a mismatch is `dispatch-error: base moved`, and re-entry
writes a new `deploy_base` at the new tip, re-runs every step's `check` (steps whose check exits 0
are not re-run), and discards any final receipt bound to the old sha.

- **`merge`** enters the deploy stage after the merge transaction; the ancestor check holds by
  construction.
- **`pr`** enters the deploy stage only after `--merged --merge-sha=<sha>`: finish-step fetches,
  verifies `<sha>` is an ancestor of the base tip **and** `branch_tip` is an ancestor of `<sha>`,
  then records `deploy_base` at the base tip. `--pushed` alone retires nothing and deploys nothing.
- **`keep`** and **`discard`** write `incomplete_authorized {reason: kept|discarded,
  disposition_sha: <branch_tip>}` inside the disposition transaction itself and archive as
  incomplete (§7.4). They are the operator's own "not done" decisions and never satisfy Outcome 3.

### 7.4 Completion class and the replay guard

`state.completion` is written at archive: `complete` or `incomplete:<reason>`. `runs list`, `mp
status`, and the retro print it, and the doctor's `dangling-run` family gains an
`incomplete-archive` INFO line so incomplete archives stay visible. The doctor also WARNs
`no-definition-of-done` for a repo without a `done:` block.

Two distinct durable authorizations replace the old "retired disposition → archive" shortcut:

- `completion_confirmed {deploy_base_sha}` — written only by `--intent-confirmed`; archive
  **complete** requires it and requires its sha to equal the latest `deploy_base` event.
- `incomplete_authorized {reason, disposition_sha}` — written by `keep`/`discard` (in the
  disposition transaction), by `--deploy-skip` (mandatory group skipped), and by
  `--deploy-abort-incomplete`; archive **incomplete** requires it.

Replay rule: a retired disposition with neither event re-enters the deploy stage (for `merge` /
`pr`-merged) at the first step lacking a `deploy_step` at the current `deploy_base_sha`; because
`keep`/`discard` write their authorization inside the disposition transaction, there is no state
in which they can reach the deploy stage. This is the event-keyed re-entry the verified-SHA and
adversary-review steps already use.

### 7.5 Intent rejected

By the time `intent_confirm` opens, the branch is merged and the run worktree is gone, so there is
no `execute` phase to return to. `--intent-rejected --class=implementation|intent --reason=…`
therefore writes `incomplete_authorized {reason: intent_rejected:<class>, disposition_sha}` and
archives this run as `incomplete:intent_rejected:<class>`; the retro names the remediation as a
required successor run. The successor is seeded with `--predecessor=<slug>`; for `--class=intent`
the operator's correction text is stored in the event and the successor's interview opens with it
as context, and the successor's `goals.md` is a fresh document (the rejected intent is never
amended in place, because this run's receipts are bound to it). No receipt from the rejected run is
reusable by the successor.

### 7.6 Stalls

"Run stalls mid-execution" is addressed by autonomy finally resolving to the operator's configured
`loose` (§4) so the existing §2d auto-progress contract engages, plus the `stalled-bundle` doctor
check already present. No new mechanism.

## 8. Seed-time overlap check (prose + inventory fields + one event)

`mp runs list` gains per record: `topic` (full text), `phase`, `worktree` (path or null),
`goals` (`[{id, text}]` from `goals.md` when present), and `planned_paths` (the union of task
`files` from `plan.index.json` when present). Before `mp seed`, the shell reads the inventory and
judges overlap (semantic; prompt-side) on three axes: an in-progress run is a potential
worktree/file conflict; an archived run whose topic or goals overlap the new topic is a
`--predecessor` candidate; any run whose `planned_paths` intersect the surface the new topic
names is a plan-level conflict even when topics differ.

The decision is recorded as the **first event after the seed's capability event**: `mp seed
--overlap-review=<json file>` appends `overlap_review {candidates: [{slug, axis, status}],
action}` as the second record of the new bundle's `events.jsonl` (the capability event the seed
already writes stays first). Tests assert the complete event array. *Resume that run* seeds nothing and appends the same event to the resumed
bundle; *abort* creates nothing durable (nothing was created), and the sequencer says so.

AUQ rule: under `gated`, the AUQ lists in-progress conflicts, plan-level conflicts, and archived
candidates and offers continue · link as predecessor · resume that run · abort. Under `loose`, the
AUQ fires only when an in-progress or plan-level conflict exists; archived candidates are recorded
in the event and folded into the interview context without asking.

## 9. Context watch at gates (small code + prose + a doctor check)

`context_watch: { threshold, focus }` (§4.1). `mp context-status --session=$CLAUDE_CODE_SESSION_ID
--repo-root=<MAIN> [--window=N]` resolves the **main** session transcript
(`<config-dir>/projects/<encoded MAIN path>/<session>.jsonl`, the encoding `lib/paths.mjs` already
uses; subagent transcripts live under the tasks directory and are never read) and returns
`{tokens_at_last_request, appended_est, window, window_source, pct, model, state}`:

- `tokens_at_last_request` = `input + cache_read + cache_creation` from the last assistant record's
  `usage` — the exact context size **as of that request**.
- `appended_est` = an estimate (4 characters per token, labeled `est.`) of transcript records
  appended after that record (the assistant's own output, tool results, user turns), so the gate
  line is honest about what the number covers: `context: 294k + ~6k est. / 1M (30%)`.
- `state` ∈ `current` (usage record found, no compaction boundary after it) · `post-compaction`
  (a compaction boundary is the last model-side record; `pct: null`; the line prints
  `context: unknown (just compacted)`) · `malformed` (usage present but not numeric; `pct: null`;
  `context: unknown (malformed usage)`) · `unsupported` (no such transcript exists, e.g. Pi; the
  line prints `context: unknown (unsupported)` so an absent line always means a broken
  turn-close, never a quiet skip). A number is never fabricated.
- Window: `--window` > `MP_CONTEXT_WINDOW` > a `[1m]`-suffixed model in the harness settings →
  1,000,000 > 200,000 default; `window_source` reports which.

The CC-3 turn-close prints the line at every gate. At or above `threshold` it adds
`recommend: /compact <focus>` with the masterplan-authored focus: `run <slug>, phase <phase>, gate
<id>; keep goals.md outcome + open gate; drop tool output`.

Harness facts (verified 2026-09-02 against the Claude Code hooks, settings, and statusline docs):
no tool or hook can initiate compaction; `PreCompact` can only block it and cannot set
`custom_instructions`; automatic compaction fires at the user-scoped `autoCompactWindow` setting
with a `null` focus; a `SessionStart` hook with `source: "compact"` runs after any compaction and
its output is injected into the compacted context. Therefore:

1. **State survival** — `mp resume-brief --repo-root=<cwd repo>` resolves the active bundle the way
   §2 does (non-archived bundles under `<MAIN>/docs/masterplan`): exactly one → a 5-line brief
   (slug, phase, open gate, the `outcome:` line, the next `mp` op); several → one line per bundle;
   zero → no output. The fleet hook system registers a `SessionStart(source: compact)` rule whose
   command is `node <installed mp> resume-brief --repo-root=$CWD`. This repo ships the verb, the
   rule's documented wiring, and a doctor check `resume-brief-hook` that reads
   `/srv/workflows/hooks/policy.toml` when present and WARNs unless a `session_start` rule invokes
   `resume-brief` with `--repo-root`. Registering the rule is a `user_only` done step (§7.1).
2. **Threshold advice** — `mp config show` reports the harness `autoCompactWindow` when readable and
   recommends a value no lower than the run's `threshold`; it never edits harness settings.

## 10. Bootstrap — how v10 gets installed, honestly

This run executes under the installed v9.10.0, whose sequencer and `finish-step` know nothing of
§7 and which cannot hold a run open past its disposition. The rollout is therefore split into what
this run can prove and what only a run on v10 can prove, and both halves are frozen:

1. **Before `mp finish` — the bootstrap wave (Pi surface, G6 part 1).** The plan's final wave is
   executed by the shell with the operator (risky-action AUQs): run `scripts/release.mjs` on the
   branch tip (version files, CHANGELOG, `release: v10.0.0` commit, annotated tag), push the
   branch and the tag, `install-pi --ref=v10.0.0`, `install-pi --check`. Each step is recorded on
   this bundle as a `bootstrap_step` event (command, exit, output digest). G6 is `signal: command`
   because the installed v9.10.0 assessor's documented contract is to verify command-class
   evidence by running read-only commands itself: `node bin/install-pi.mjs --check` (reads the
   live install root), `git rev-parse -q --verify refs/tags/v10.0.0`, and `git ls-remote
   --exit-code --tags origin refs/tags/v10.0.0` are all runnable from the detached assessment
   worktree, so no new consumer of `bootstrap_step` events is needed for the verdict; the events
   are the human-readable receipt. Invariant: the release commit is the branch tip at finish —
   bundle writes go to MAIN's base branch, never the run branch — so the tag and the finish-time
   branch tip are the same commit.
2. **At the `branch_finish` gate — the Claude surface (G6 part 2, decision D2).** The Claude
   plugin cache updates only from the marketplace's tracked branch (`main`), which this run's
   branch reaches only through the finish merge, and the installed v9.10.0 finish archives in the
   same transaction as that merge. The documented "not ready" escape closes the gap: at
   `branch_finish` the shell answers free-text, which holds the gate with nothing archived; then,
   gated by risky-action AUQs, it merges the run branch into `main` in MAIN (`git -C MAIN merge
   --no-edit masterplan/<slug>`), pushes `main`, and hands back the user-only step (`/plugin update
   masterplan`, `/reload-plugins`; evidence: `mp version` from the cache prints v10.0.0, and
   `node bin/doctor.mjs --only=plugin-registry-drift` is clean), recording each as a
   `bootstrap_step` event. Only then does the shell resume with `--choice=merge`: finish-step's
   own merge is a no-op ("already up to date"), the branch retires normally, and the run archives
   with both surfaces on v10. The finish-time adversary review already ran over the real
   `base..head` diff before the gate, so the early merge does not blank it. The operator confirms
   the Claude evidence at the held gate; the v9.10.0 goal check (which ran earlier) assesses the
   Pi half.
3. **Successor run (`v10-validation`).** Seeded with `--predecessor=intent-to-completion` on the
   installed v10: the first v2 `goals.md`, a small real change, and a finish that exercises the
   deploy stage, `run_final_check`, and `intent_confirm` end-to-end. Its archive with
   `completion: complete` is the evidence for the *automated* flow (Outcome 3's mechanism); the
   *rollout* of v10 itself is complete inside this run per steps 1–2. It is listed in this run's
   retro as the next required run, and the seed-time overlap check (§8) surfaces this bundle and
   that open step to whoever seeds next.

## 11. Test plan

Named suites, each required by §4.4's inventory or by a finding in §13:

- `config`: each of the four sources wins in turn; nested whole-object replacement; partial
  `context_watch` defaults; explicit `planning_mode` vs complexity default; `done` ignored outside
  the repo file with a warning; `done` schema (unknown group, malformed step, `${version}` without
  `version_from`, hostile version strings rejected and quoted); unknown key → warning; malformed
  YAML → seed fails; invalid enum at every level → fails; `*_source` derived; `auto_compact` alias
  warns, both present fails; `full` alias warns; removed flags rejected; legacy state fields
  tolerated by `migrate`.
- `knob-inventory`, `knob-contract` (§4.4), including the read-but-ignored synthetic knob and a
  gated-vs-loose contract.
- `goals` v2: Intent block parse; hash covers it; v1 still parses; 1, 2, or 6 goals → error for
  v2; intent amendment re-arms the spec gate; v1/v2 detection.
- `interview-ledger-resume`: duplicate id, out-of-sequence id, ask with an unanswered question,
  ask past cap → refused; `--supersedes` changes the active pick count; forged critic receipt
  (missing dispatch id / zero tokens / digest mismatch) → refused; malformed payload → refused;
  `end` refused for each state whose conditions fail; low-complexity `critic_off` path; cap
  reached → `exhausted`; `critic_unavailable` + floor → `exhausted`; replay after compaction
  reconstructs status from events and the payload artifact; `goals-load` accepts converged /
  exhausted / critic_off and refuses open without waiver.
- `finish-replay`: restart before disposition retirement, after retirement before the first
  `deploy_step_started`, after `started` before `deploy_step` (check exit 0 / 1 / other / absent),
  after every gate; archive never reachable without `completion_confirmed` (complete) or
  `incomplete_authorized` (incomplete); `keep`/`discard` cannot reach the deploy stage on replay.
- `deploy-commit-identity`: `pr` without `--merged` deploys nothing; merge-sha not an ancestor of
  base, or branch tip not an ancestor of merge-sha → `dispatch-error`; base moved between steps →
  refused; `deploy_base` re-entry; mandatory group skipped → `incomplete:<reason>`; `live_check`
  non-zero → only retry/abort; no `done:` → `no_definition_of_done` gate; ad-hoc done proceeds;
  abort-incomplete archives incomplete.
- `final-check`: goals needing live evidence cannot pass from the implementation assessment; final
  receipt binds `deploy_base_sha`, `deploy_chain_hash`, `live_check_digest`; `intent_confirm`
  opens only after a final receipt.
- `intent-rejected`: both classes; stale `goal_check` receipts unusable after `goals-amend`.
- `overlap-sequencer`: in-progress conflict, plan-path conflict with a different topic, archived
  overlap, no overlap, predecessor link, resume (event on the resumed bundle), abort (nothing
  created); `overlap_review` is the first event after seed; `runs list` carries the new fields.
- `context-status-session-lineage`: fixture transcripts for a fresh session, a resumed session, a
  subagent transcript alongside (ignored), trailing tool/user records after the last usage
  (`appended_est`), post-compaction with no usage, malformed usage, 200k and 1M windows, and a
  missing transcript (`unsupported`).
- `resume-brief`: zero, one, and several active bundles; doctor `resume-brief-hook` on a policy
  with the rule, without it, with a rule lacking `--repo-root`, and with no policy file; doctor
  `no-definition-of-done`, `incomplete-archive`.
- `register-pi-agents`: picks up `mp-intent-critic`; `publish-hygiene`: 10.0.0 everywhere.
- `v9-to-v10-bootstrap`: a scripted walk of §10 step 1 against a fixture install root and a fixture
  remote, proving the release script, tag, push, and `install-pi` commands exist on the branch and
  produce the `bootstrap_step` receipts G6 expects. The live execution is the plan's bootstrap
  wave, not this test.

## 12. Touch surface

**New:** `lib/config.mjs`, `lib/interview.mjs`, `lib/context-status.mjs`, `scripts/release.mjs`,
`agents/mp-intent-critic.md`, `.masterplan.yaml` (this repo), `docs/design/intent-interview.md`,
tests named in §11.
**Modified:** `bin/masterplan.mjs` (seed resolver + `--overlap-review`, `config show`,
`interview *`, `context-status`, `resume-brief`, `runs list` fields, flag whitelist),
`lib/bundle.mjs` (fields, `completion`), `lib/goals.mjs` (v2), `lib/finish-step.mjs` (deploy stage,
`run_final_check`, gates, authorizations, replay guard), `lib/runs.mjs` (new fields),
`lib/doctor/*` (three checks), `agents/mp-goal-assessor.md` (final assessment),
`commands/masterplan.md` (§3 interview + overlap, §2c deploy rows, §2d stop-set, turn-close context
line, `<!-- knob -->` markers), `README.md`, `skills/masterplan/SKILL.md`, `docs/verbs.md`,
`CHANGELOG.md`, `RELEASING.md`.

## 13. Adversary review dispositions

Round 1 (18 findings) and round 2 (12 new, 10 residual). Each row is the round-2 numbering.

| # | severity | disposition in rev 3 |
|---|---|---|
| 1 / 22 | P1 | separate `completion_confirmed` and `incomplete_authorized` events; keep/discard authorize inside the disposition transaction (§7.3, §7.4) |
| 2 / 19 | P1 | `check` is an exit-status predicate; examples rewritten; indeterminate on any other exit (§7.1, §7.2) |
| 3 | P1 | closed in rev 2 (two assessments, final receipt bound to the deploy base) |
| 4 | P1 | `deploy_base_sha` = base tip at stage entry; branch-tip ancestry verified; base-moved refusal (§7.3) |
| 5 | P1 | `no_definition_of_done` gate at stage entry with ad-hoc steps or incomplete archive (§7.2) |
| 6 / 23 | P1 | rollout frozen as G6 inside this run (bootstrap wave before finish) + successor first wave (§10) |
| 7 | P1 | D1 resolved: ledger verbs (§5.3); operator may veto at approval |
| 8 | P1 | closed in rev 2 |
| 9 / 21 | P2 / P1 | terminal states `converged` / `exhausted` / `critic_off`; `goals-load` accepts all three (§5.4) |
| 10 | P2 | closed in rev 2 |
| 11 / 25 | P2 | `tokens_at_last_request` + `appended_est`; four states; G5 narrowed (§9) |
| 12 / 30 | P2 | `resume-brief --repo-root` active-run resolution; doctor validates the command (§9) |
| 13, 14, 15, 17, 18 | P2 / P3 | closed in rev 2 |
| 16 | P2 | `overlap_review` is the seed's first event via `--overlap-review`; resume/abort defined (§8) |
| 20 | P1 | critic payload persisted as an artifact with digest; forged/malformed receipts refused (§5.3) |
| 24 | P2 | v2 count `<3 \|\| >5` rejected (§6.1) |
| 26 | P2 | `full` retired to a warned alias of `loose` (§4.1, §4.2) |
| 27 | P2 | `done`/`context_watch` schema validation at seed; tests (§4.1, §11) |
| 28 | P2 | `--supersedes` and replay-derived active picks (§5.3) |
| 29 | P2 | overlap on topic, goals, and `planned_paths`; full topic text (§8) |

Round 3 (7 findings) → rev 4:

| finding | severity | disposition in rev 4 |
|---|---|---|
| intent rejection has no replay path after disposition | P1 | rejection archives incomplete with a required successor; no return to `execute` (§7.5) |
| commit identity unchecked at final boundaries | P1 | base-tip equality checked before final check, intent_confirm, and archive (§7.3) |
| terminal guard accepts invalid state | P1 | zero-unanswered rule, `withdraw`, receipt bound to `ledger_head` + `intent_sha256`, contradictions/misclassified must be resolved, `waived` named (§5.3, §5.4) |
| v9 assessor consumption of bootstrap receipts asserted | P1 | G6 evidence is command-class the v9 assessor runs itself; tag/branch-tip invariant stated (§10.1) |
| Claude surface deferred | P1 | both surfaces inside this run via the held `branch_finish` gate (§10.2, D2 for the operator) |
| overlap "first event" contradiction | P2 | "first event after capability", full-array test (§8) |
| unsupported context line omitted | P2 | `context: unknown (unsupported)` printed (§9) |

## Assumptions & Open Decisions

| # | question | decision | rationale | source |
|---|---|---|---|---|
| A1 | Which interview failures to fix? | how-not-why, stops too early, no synthesis | operator's own diagnosis | user-confirmed |
| A2 | Interview budget at high? | floor 8, cap 20 | operator chose bounded over open-ended; exact numbers per review | user-confirmed (bounded) / assumed (numbers) |
| A3 | Where do probing questions come from? | orchestrator plus a fresh-context cross-vendor critic each round | operator accepted the per-round dispatch cost | user-confirmed |
| A4 | Fate of the G-list checklist? | replaced by an Intent block plus 3–5 outcome goals | operator chose replacement | user-confirmed |
| A5 | What must "done" include? | released and installed where it executes; operator re-confirms intent | deploy left undone in prior retros | user-confirmed |
| A6 | Who performs deploy steps? | masterplan drives them, gated by autonomy | operator chose drive-with-gates | user-confirmed |
| A7 | Where does the definition of done live? | `done:` block in the repo's `.masterplan.yaml` | one file, one loader | user-confirmed |
| A8 | Overall shape? | prompt-first, minimal code | operator overrode the config-plane recommendation with the risk shown | user-confirmed |
| A9 | Code seams beyond prompt-first? | durable finish gates (deploy, final check, intent_confirm) and an on-disk interview budget | prose cannot keep archive last after deploy or count across compaction | user-confirmed |
| A10 | Release version? | v10.0.0 | goals.md format change | user-confirmed |
| A11 | Level semantics (§4.2)? | as tabled; `full` retired to alias | presented; no objection raised; review finding 26 | assumed |
| A12 | Can the model trigger compaction? | no; usage line, recommendation, post-compaction brief | verified against Claude Code docs 2026-09-02 | user-confirmed (harness fact) |
| A13 | Legacy `.masterplan.yaml` keys? | warn and ignore; malformed YAML fails | operator's fleet repos still carry v7 files | assumed |
| A14 | `full` vs `loose`? | `full` is a warned alias of `loose` | no v8 behavior ever distinguished them | assumed |
| A15 | Intent rejected? | two classes: implementation → execute; intent → goals-amend + re-plan | review finding 15 | assumed |
| A16 | No `done:` block? | `no_definition_of_done` gate: ad-hoc steps or incomplete archive; doctor WARN | review findings 5 and 21 | assumed |
| A17 | This run's goals.md schema? | v1; intent in §2; first v2 bundle is the successor run | installed 9.10.0 validates it | assumed |
| A18 | Who wires the post-compaction hook? | this repo ships verb + docs + doctor check; registration is a `user_only` done step | hooks declared only in policy.toml | assumed |
| A19 | `done` from user-global or CLI? | ignored with warning | executable steps must come from the reviewed repo file | assumed |
| A20 | keep/discard outcome? | archive as `incomplete:<reason>`, never complete | Outcome 3 | assumed |
| A21 | Dogfood evidence? | Pi install + tag before the goal check; Claude cache at the held `branch_finish` gate; automated flow proven by the successor | the 9.10.0 finish archives with the merge, but its documented "not ready" escape holds the gate | assumed |
| A24 | Intent rejected after merge? | archive incomplete; remediation is a successor run | the worktree is gone after disposition; no `execute` to return to | assumed |
| **D2** | **Claude cache inside this run via the held gate, or Pi-only scope for this run?** | **held gate (both surfaces) — operator confirms at approval** | the topic's central failure is archiving with a stale running surface | pending |
| A22 | D1 — interview ledger verbs or generic events? | verbs (§5.3) | the operator accepted code seams wherever prose cannot enforce; two adversary rounds rated generic events a blocking gap | assumed — operator may veto at approval |
| A23 | Receipt provenance strength? | honesty-bound (ids, positive tokens, digests), not cryptographic | matches `record-gate-review`; stronger would need a signing dispatcher | assumed |
