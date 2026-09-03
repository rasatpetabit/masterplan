# Spec — Intent to completion

**Run:** `intent-to-completion` · **Target release:** v10.0.0 · **Shape:** prompt-first, minimal code (user decision, A8)
**Review status:** rev 12 — after ten single-lane spec-gate adversary rounds (round 1: 18 findings; round 2: 12 new + 10 residual; round 3: 7; round 4: 5 + 1; round 5: 4 + 2; round 6: 2 + 3; round 7: 1 + 2; round 8: 2 + 1; round 9: 1 + 1; all FAIL; round 10: PASS + 1 advisory) and two cross-vendor panels (rev 10: gpt-5.6-sol revise, glm-5.2 reject, 0 blockers / 11 should-fix / 6 nits → rev 11; rev 11: both lanes revise, 2 blockers / 7 should-fix / 5 nits → rev 12; all folded, §13). Approved by the operator 2026-09-02 at rev 4 with D1 (ledger verbs) and D2 (both surfaces inside this run) confirmed; revs 5–6 change only the D2 mechanism and the review fixes; revs 11–12 fold the panels and the round-10 advisory.

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

1. A run at `complexity: high` converges only when the questions asked were about intent (why,
   outcome, anti-goals, what "live" means), a fresh-context critic finds no design-changing
   unknown, and the operator has picked at least one concrete design option without correction —
   inside a bounded budget recorded on disk, not in the model's head. The other bounded exits —
   `exhausted` (cap reached, or critic unavailable, remaining unknowns written as assumptions) and
   `critic_off` (low complexity) — are named durable states with weaker guarantees, and the
   assessor reads them as such (§5.4).
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
   and records what was reviewed as the new bundle's first event after its seed record.
6. Every gate reports measured context usage where the harness exposes it, an explicit unknown
   state where it does not, and recommends compaction at the boundary where it is cheapest; a
   post-compaction brief keeps run state in context.
7. The v10.0 release (v10.0.0, or the corrective v10.0.x that §10.3 names) is released, tagged,
   pushed, CI-green, and installed **and executable** in **both** running surfaces — the Pi
   install root and the Claude plugin cache — by the plan's bootstrap wave before this run's
   finish begins, so the goal check assesses it live (frozen goal G6, §10). This run's own archive
   is class `legacy` (§7.4); the automated deploy-to-confirm flow is proven only by the successor
   run `v10-validation` archiving `completion: complete`, which is a **required** successor
   (§10 step 3), not a deferrable retro follow-up.

## 3. Non-goals

- Not an interrogation. The interview never asks the operator to make an implementation choice; it
  proposes options and records the reaction.
- No prose restatement the operator must grade. Understanding is shown through small pick-one
  questions and concrete proposals (operator feedback 2026-09-02).
- Not a general release tool. The `done:` block runs the repo's own commands; masterplan does not
  bump versions or push tags itself. The version bump is ordinary run-branch work, checked before
  the branch retires (`version_not_bumped`, §7.2); the `release` group stamps and tags what the
  branch already declares (§7.1 release contract).
- Not a return of the v7 `.masterplan.yaml` surface. Only the keys in §4 are recognized; the rest
  warn.
- Deferred follow-ups in retros may remain open (operator decision) — except the required
  successor run `v10-validation` (§10 step 3), on which Outcome 7 depends.
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
  names, a step that is neither `{run, check?}` nor `{text, check}`, or a `${version}` reference
  without a resolvable `version_from` all fail the seed. Seed-time resolution is an **early check
  only**: the deploy stage re-resolves `done` from `<MAIN>/.masterplan.yaml` **at
  `deploy_base_sha`** (`git show <sha>:.masterplan.yaml`) when it enters, validates it the same
  way, and records its digest as `done_sha256` in the `deploy_base` event (§7.3), so a branch that
  adds or changes the block after seed — as this run does (§12) — deploys with the merged
  definition, never the seed-time snapshot.
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

| complexity | interview floor | intent floor | interview cap | critic | planning default |
|---|---|---|---|---|---|
| `low` | 1 | 1 | 4 | off (configured) | serial |
| `medium` | 4 | 3 | 10 | after the last intent round, before the design options; re-run after any unclean payload until clean, cap, or unavailable | auto |
| `high` | 8 | 6 | 20 | after every intent round; same retry rule | auto |

A **round** is one `AskUserQuestion` call (1–4 questions) and its answers, recorded on the ledger
by `--round=<r>` on every ask (§5.3); an *intent round* contains at least one `intent`-kind
question, a *design round* only `design`-kind proposals. Design rounds never require a critic
(they do not move `content_head`, §5.3). At `high`, "after every intent round" is enforced, not
advisory: `converged` requires a critic receipt recorded after each intent round's last content
event (§5.4). The floor is the minimum number of **answered** questions (withdrawn questions
never count toward it) before the interview may end through any non-waived terminal state —
including `exhausted` at the cap — and the **intent floor** is how many of those must be
`intent`-kind: a design-only ledger meets no floor at any level, and `mp interview draft` itself
refuses until an intent-kind answer exists (§5.3), so no draft — and therefore no terminal state
— can rest on design picks alone; the cap is the maximum asked (withdrawn questions do count
against it, so an ask/withdraw loop cannot run unbounded). Reaching the cap with the floor unmet
leaves only the waiver exit (§5.4). Interview terminal states (§5.4): `converged`, `exhausted`,
`critic_off`.

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
   the documented difference in a **consumer-side** observable: an `mp` op's output, a gate, an
   event, or a rendered protocol line. A seeded state field is **not** an accepted observable — it
   is writer-side proof and would pass exactly the inert `--complexity`/`--autonomy` class this
   work closes. Examples: `complexity` low vs high → `mp interview status` caps differ; `autonomy`
   gated vs loose → `run_deploy_step.ask` differs; `planning_mode` → `resume-phase` op differs;
   `context_watch.threshold` → the gate line's recommendation differs. A rendered protocol line
   counts as the observable **only** for prompt-only controls declared with a `<!-- knob -->`
   marker; every `mp` flag, config key, and environment variable needs a code-side observable (op
   output, gate, or event). The inventory generator rejects aliased `process.env` access in
   `lib/`/`bin/` (`const env = process.env`) so a read the lexical scan cannot see fails the
   suite instead of escaping it. The suite also seeds two synthetic knobs and asserts the guard
   fails on both: one that is *read but ignored* (the semantic-inertness case, not just the unread
   case) and one whose only two-value difference is its seeded state field.

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
5. **Exit.** Per §5.4. On `exhausted`, every remaining `unknowns`, `contradictions`, and
   `misclassified` entry of the **latest available** critic payload (the last successful one,
   even when a later dispatch was `unavailable`) is written as an `assumed` row in the spec's
   Assumptions table before the design is presented; the `interview_end` event lists all three.
6. **Output.** The intent block (§6) is written into `goals.md` and the same text appears as
   `## Intent` in `spec.md`. The operator reviews it at the spec gate; there is no separate
   "confirm my restatement" question.

### 5.2 Bootstrap note

This run's own interview ran under the installed v9.10.0 and is recorded only in this spec's
Assumptions table and the WORKLOG; the ledger exists from v10.0.0 on.

### 5.3 Ledger (D1, resolved: verbs)

Deterministic verbs in `lib/interview.mjs`, each an `events.jsonl` append through the existing
single writer:

- `mp interview ask --state --id=Q<n> --round=<r> --kind=intent|design --text=…` — refuses a
  duplicate id, an id out of sequence, a round number other than the current or the next round,
  an ask while a question from an *earlier* round is unanswered, or an ask past the cap. Rounds are
  derived by replay from `--round` (the questions of one `AskUserQuestion` call share a round and
  may all be recorded before their answers).
- `mp interview answer --state --id --text=… [--corrected] [--supersedes=Q<m>]` — `--supersedes`
  retires an earlier design pick; the active pick count is derived by replay (latest per fork).
- `mp interview withdraw --state --id` — retires an asked-but-unanswered question (it still counts
  against the cap); the only way an unanswered question leaves the ledger.
- `mp interview draft --state --file=<json>` — persists the current intent draft
  (`{why, outcome, anti_goals, done_means}`) as `<bundle>/interview-intent-draft.json` and records
  `interview_draft {intent_sha256}`; the draft is what the critic reviews and what §5.1 step 6
  writes into `goals.md`. Refuses while no `intent`-kind question has been answered: a draft with
  nothing behind it is exactly the restatement §3 forbids.
- `mp interview critic --state --receipt=<json> --payload-file=<path>` — the payload is copied to
  `<bundle>/interview-critic-<n>.json` (artifact, schema-validated: `unknowns[]`,
  `misclassified[]` (question ids), `contradictions[]` (each with an id `C<n>` and the question ids
  involved), `intent_draft`), and the event carries `{dispatch_id, model, output_tokens,
  payload_sha256, content_head, intent_sha256, unknown_count}`. **`content_head`** is the index of
  the last *intent-content* event — an `interview_question` or `interview_answer` of kind
  `intent`, an `interview_withdraw` **of an intent-kind question**, or an `interview_draft` — that
  the critic was shown. Critic events, terminal events, and **`design`-kind questions, answers,
  and withdraws are not content events**: recording a receipt or a design pick does not move the
  head, so a critic run after the intent questions stays fresh through the design-options round
  (this is what lets `medium` converge on its pre-design critic). If a design answer changes what
  the operator wants (not just how), the prompt must record a new `interview_draft`, which moves
  the head and requires a fresh critic. `intent_sha256` is the digest of the draft it reviewed. The recorder computes both from the ledger and refuses a receipt that names different
  values, a receipt without dispatch id, model, and positive output tokens, or a payload whose
  digest does not match — the same honesty bound as `record-gate-review`; it is not tamper-proof
  and is documented as such.
- `mp interview critic --state --unavailable --error=<text>` — records `critic_unavailable` (§5.4).
- `mp interview answer … --resolves=C<n>|Q<m>` and `mp interview withdraw … --resolves=…` — an
  answer or withdraw may name the contradiction id or misclassified question id it addresses.
  `--resolves` is bookkeeping for the *next* critic round (the critic is shown which items were
  addressed); it never satisfies convergence by itself.
- `mp interview end --state --reason=converged|exhausted|critic_off` — writes the terminal state
  after validating it against the ledger (§5.4).
- **Terminal states are absorbing.** After `interview_end` or `interview_waived`, every mutating
  interview verb (`ask`, `answer`, `withdraw`, `draft`, `critic`, `end`) refuses. The only way
  back is `mp interview reopen --state --reason=…`, allowed only while `phase` is `brainstorm` and
  before `goals_frozen`; it writes `interview_reopened`, after which the previous terminal event
  no longer counts and a new terminal state must be reached. Once goals are frozen, intent changes
  go through `mp goals-amend`, never through the interview.
- `mp interview status` — read-only.

Verbatim question and answer text is stored so a compaction mid-interview resumes from disk; the
latest critic payload is re-read from its artifact.

### 5.4 Terminal states and `goals-load`

Every terminal state other than `waived` requires **zero unanswered questions** (answer or
withdraw first), **the floor and the intent floor met** (answered ≥ floor and answered
intent-kind ≥ intent floor, §4.2 — withdrawn questions never count toward either, so twenty asks
and twenty withdraws satisfy nothing, and eight design picks satisfy nothing), **and an
`interview_draft` as the latest
intent-content event** — the draft is the synthesis §5.1 step 6 writes into `goals.md`, so an
intent answer recorded after the latest draft blocks every exit until a new draft is recorded
(and, where a critic is required, reviewed). A cap reached with the floor unmet leaves only the
waiver exit, recorded with reason `floor_unmet_at_cap`.

| state | valid when (in addition to the rule above) | `goals-load` |
|---|---|---|
| `converged` | floor met; ≥ 1 completed intent round; ≥ 1 active uncorrected design pick; the latest critic receipt is valid, its `content_head` equals the current content head (which, per the rule above, is the latest draft) and its `intent_sha256` equals that draft; and its payload is **clean**: zero `unknowns`, zero `contradictions`, zero `misclassified`. An unclean payload is resolved by further intent content, a new draft, and a fresh critic run whose payload is clean; at `high`, additionally every intent round has a critic receipt recorded after that round's last content event (§4.2) | accepts |
| `exhausted` | asked == cap (any complexity), or critic mode is `unavailable`; the `unknowns`, `contradictions`, and `misclassified` entries of the latest available payload (the last successful one, if any) are listed in the event | accepts; the spec must carry the `assumed` rows for all three |
| `critic_off` | `complexity: low`; floor met | accepts |
| `waived` | `goals-load --interview-waived --reason=…` on an open interview; durable `interview_waived` event; the only exit once the cap is reached with the floor unmet | accepts, recorded as waived |
| (none) | interview still open | refuses |

Critic mode is `off` (configured, low), `on`, or `unavailable` (a dispatch failed: durable
`critic_unavailable` event with the error). `unavailable` never counts as `converged`.

The `assumed` rows an `exhausted` exit owes the spec are **reviewer-enforced at the spec gate**
(the operator reviews the spec there; `goals-load` does not parse the spec); the `interview_end`
event is the durable record of all three lists, so a lagging table loses nothing.

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
  After the implementation assessment it offers fix / waiver / abort as today; after the final
  assessment the worktree is gone, so it offers **waiver / abort / reject-intent** only — `fix` is
  never offered post-live, and reject-intent writes `incomplete_authorized` per §7.5 directly.
- **Compatibility contract (bootstrap):** the v2 `mp-goal-assessor` and `mp-adversarial-reviewer`
  prompts are dispatched by this run's pinned v9.10.0 finish while both surfaces already serve
  the v10 prompts (§10 steps 4 and 6). Each v2 prompt therefore declares and handles a **v1
  mode**: a `goals.md` without an `## Intent` block and the v9 single-dispatch shape (no
  final-assessment payload) produce the v9 verdict schema with no `intent_verdict`.
  `test/agents-compat.test.mjs` asserts the declared mode and validates a fixture v1-mode output
  against the v9 `record-goal-check` validator.

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
      check: git ls-remote --exit-code --tags origin refs/tags/v${version} >/dev/null || exit 1
    - run: gh run list --branch v${version} --workflow ci.yml --json databaseId --jq '.[0].databaseId' | xargs gh run watch --exit-status
      check: gh run list --branch v${version} --workflow ci.yml --json conclusion --jq '.[0].conclusion' | grep -qx success
    - run: node bin/install-pi.mjs --ref=v${version}
      check: node bin/install-pi.mjs --check --expect=v${version}
  user_only:
    - text: "/plugin marketplace update rasatpetabit-masterplan, then /plugin update masterplan, then /reload-plugins"
      check: node ~/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/${version}/bin/masterplan.mjs version | grep -q v${version}
    - text: "register the SessionStart(source: compact) resume-brief rule in /srv/workflows/hooks/policy.toml"
      check: node bin/doctor.mjs --only=resume-brief-hook
  live_check:
    - run: node bin/install-pi.mjs --check --expect=v${version}
    - run: node ~/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/${version}/bin/doctor.mjs --only=plugin-registry-drift
```

Two of these steps are behavior-exercising by design, because structural checks alone cannot tell a
broken install from a working one: `install-pi --check --expect=vV` additionally **executes**
`<install-root>/current/bin/masterplan.mjs version` and fails unless its output names V (the one
execution probe on the Pi surface), and the Claude-surface live check runs the doctor **through the
installed cache copy**, not the repo's. The CI step exists because a tag push fires
`.github/workflows/ci.yml` (`test`, then `release-publish`), and a tag whose run is red is not
released, whatever `ls-remote` says; a tag push's Actions run carries the tag name as its head
branch, which is what `--branch v${version}` selects.

**Release contract.** `${version}` is read from `version_from` at `deploy_base_sha`, and the run
branch must already have bumped it: before `branch_finish` opens for `merge`/`pr`, finish-step
resolves `${version}` at `branch_tip` and refuses with the `version_not_bumped` gate (§7.2) when
`refs/tags/v<version>` already exists locally or on `origin` — while the worktree still exists to
fix it. `scripts/release.mjs --version=V` never bumps: it requires the version files to already
say V (else fails, naming the file), inserts the CHANGELOG release header when absent, commits
only if that changed anything, and creates the annotated tag; at an existing tag it succeeds iff
the tag points at HEAD (idempotent replay) and fails otherwise. The commit it may make is
**stage-produced** and does not count as a base move (§7.3).

**Group order is normative and fixed: `release → install → user_only → live_check`**, then the
final assessment (§7.2). Declaration order in the file is irrelevant; a live check that depends on
an operator step (the plugin-drift check above depends on the plugin update) therefore always runs
after it. Each step is `{run, check?}` (or `{text, check}` for `user_only`). **`check` is a predicate on
exit status**: 0 = the step's effect is present, 1 = absent, any other exit (or timeout, or crash)
= indeterminate. Output is never interpreted. Commands run through `sh -c` from MAIN, and **the
exit-code contract is the author's to meet**: `git ls-remote --exit-code` exits 2 on a missing ref
(reproduced), which the raw command would report as indeterminate, so the sample normalizes it with
`|| exit 1`; the `config` suite runs the literal sample against a tagless bare remote (§11).
`${version}` must match
`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` before substitution and is single-quoted into the command; a
step's resolved command and its source (`repo`) are recorded in its receipt. `release`, `install`,
and `live_check` are **mandatory** groups; a run that skips any of them archives as incomplete
(§7.4). `user_only` steps are handed back with the exact text; finish waits, and when the operator
reports back finish-step runs the step's **`check`** and records the step only on exit 0 (1 → the
handback re-opens with a `deploy_step_check_failed` event; other → `deploy_indeterminate`).
Free-text evidence is never accepted as proof — a declared step that did not happen cannot be
talked into the ledger — which is why `user_only` steps carry `check`, not `evidence`.

### 7.2 finish-step order and ops

`docs_normalize → run_verify → run_goal_check (implementation) → write_retro →
run_adversary_review → version_not_bumped (merge/pr only) → branch_finish → deploy stage →
run_final_check → goals_unmet (final) → intent_confirm → archive`.

| op | shell does | then |
|---|---|---|
| `ask gate:'no_definition_of_done'` | opens at deploy-stage entry when `.masterplan.yaml` at `deploy_base_sha` has no `done:` block (§4.1 re-resolution). AUQ: supply run-specific commands now (release/install/live_check as `{run, check?}`) / archive incomplete | `--done-adhoc-file=<json>` (durable `done_adhoc` event; the stage proceeds with those steps) · `--deploy-abort-incomplete --reason=no-done-config` |
| `run_deploy_step {group, index, run, check, cwd: MAIN, ask}` | Under `gated` (or `ask: true`) AUQ first; on approval the shell re-invokes with `--deploy-authorize --group --index` and finish-step writes `deploy_step_authorized {group, index, sha}` (under `loose` it is written at op emission). Only then, immediately before execution, finish-step writes `deploy_step_started`; a `started` without a preceding `authorized` at the same sha is an invariant error. Run from MAIN on the base — after `deploy_step_authorized` has verified that `git -C MAIN status --porcelain` lists nothing outside `docs/masterplan/` (otherwise `dispatch-error: dirty_tree` and nothing runs: an uncommitted edit to a script would execute unrecorded while the receipt names the committed sha) — and capture exit + output digest | `--deploy-step-done --group --index --exit=N --digest-file=…`. **finish-step then runs `check` itself when present, on every path, not only recovery:** `run` exit 0 and `check` exit 0 → `deploy_step {…, exit, check_exit: 0, digest, source}`; `run` exit 0 but `check` exit 1 (effect absent) → `deploy_failed`; `check` any other exit → `deploy_indeterminate`; `run` non-zero → `deploy_failed` without running `check`. A step without `check` is recorded on `run` exit 0 alone |
| `ask gate:'deploy_indeterminate' {group, index}` | a `deploy_step_started` exists at this sha with no `deploy_step`. If the step has `check`, finish-step runs it first: exit 0 → recorded done silently; exit 1 → re-run, **re-asking first under `gated`** (a new `authorized` is required whenever the prior `started` is being replayed); other → this gate. Without `check`, this gate. A step with `authorized` but no `started` simply re-emits `run_deploy_step` without asking again. AUQ: mark done with evidence / re-run / abort | `--deploy-step-done` with the evidence digest · `--deploy-rerun` · `--deploy-abort` |
| `ask gate:'deploy_failed' {group, index, error}` | AUQ: retry / abort finish; for `release` and `install` a third option, *skip with reason*, archives incomplete (§7.4). `live_check` offers no skip | `--deploy-retry` · `--deploy-skip --reason=…` · `--deploy-abort` |
| `handback {group: 'user_only', text, check}` | present, wait; when the operator reports back, re-invoke with `--deploy-step-done`; finish-step runs `check` itself: 0 → `deploy_step`, 1 → the handback re-opens (`deploy_step_check_failed`), other → `deploy_indeterminate` | `--deploy-step-done` (no evidence digest — the check is the evidence) |
| `run_final_check {deploy_base_sha, deploy_chain, live_digest, goals_path}` | dispatch the assessor (§6.2 final) | `mp record-goal-check --final --receipt=…` |
| `ask gate:'goals_unmet'` (final) | opens after the final receipt when any goal is `partial`/`missed` (§6.2): waiver → proceeds to `intent_confirm` with the waived goals named in its payload; abort → stop, nothing archived; reject-intent → §7.5. No `fix` option post-live | `--goals-choice=waiver\|abort` · `--intent-rejected …` |
| `ask gate:'version_not_bumped' {version, tag}` | opens before `branch_finish` (merge/pr) when `${version}` at `branch_tip` names a version whose tag already exists (§7.1 release contract). The worktree still exists: fix on the branch (bump `version_from`, re-run finish) / keep → archives incomplete | `--version-fix` (stop; the run stays resumable) · `--choice=keep` at the following gate (`incomplete_authorized {reason: version_not_bumped}`) |
| `ask gate:'intent_confirm' {outcome, intent_verdict, live_check_digest}` | one question: *does this do what you meant?* | `--intent-confirmed` → `completion_confirmed {deploy_base_sha}` → archive complete · `--intent-rejected --class=implementation\|intent --reason=…` (§7.5) |

`--deploy-abort` stops finish with nothing archived; the run stays resumable and the next finish
re-enters at the first step lacking a `deploy_step` event at the current `deploy_base_sha`.

### 7.3 Dispositions and commit identity

`deploy_base_sha` is always **MAIN's base-branch tip at deploy-stage entry**, recorded in a
`deploy_base {sha, branch_tip}` event, and finish-step verifies before recording it that the run
branch's tip (`branch_tip`, captured at `branch_finish`) is an ancestor of that sha
(`git -C MAIN merge-base --is-ancestor <branch_tip> <sha>`). Every deploy receipt and the final
assessment bind to `deploy_base_sha`. **Every** later boundary — the next `run_deploy_step`,
`run_final_check`, opening `intent_confirm`, and the archive itself — first audits
`<audit base>..<base tip>` with the §10.1.5 per-commit rule, where the **audit base** is the
`base_after` of the latest `deploy_step` receipt (initially `deploy_base_sha`). Two kinds of
commit are **not** a move: (a) single-parent commits touching only `docs/masterplan/*/` — any
bundle's, this run's or a sibling run's — because bundle state commits (gate resolutions,
`bootstrap_step` events, the archive, another session's gate) land on the base branch by design
(§2e), and every deploy-stage gate resolution commits the bundle exactly as other gates do; and
(b) **stage-produced** commits: whatever an authorized step commits between its
`deploy_step_started` and its `deploy_step` receipt (the sample `release` step commits version
files and CHANGELOG) is recorded in that receipt as `commits: [sha…]` with `base_after`, and the
next boundary audits from there. Any other commit is `dispatch-error: base moved`. Re-entry after
a real move writes a new `deploy_base` at the new tip (re-resolving `done` and `${version}` there,
§4.1), discards every receipt bound to the old sha, and re-runs every step's **`run`** — never a
check-only replay, because a check that still exits 0 for an unchanged version literal says
nothing about the moved code (a `release` re-run at an unbumped version then fails on the
existing tag, the correct signal that the base changed without a version bump; this path is only
reachable after a real move, since `version_not_bumped` keeps an already-released version out of
the stage in the first place). The `deploy_base` event also records `done_sha256`, the digest of
the definition resolved at that sha.

- **`merge`** enters the deploy stage after the merge transaction; the ancestor check holds by
  construction.
- **`pr`** enters the deploy stage only after `--merged --merge-sha=<sha>`: finish-step fetches,
  verifies `<sha>` is an ancestor of the base tip **and** that the branch landed in it — either
  `branch_tip` is an ancestor of `<sha>` (merge commit), or `<sha>` is a **squash** whose patch-id
  (`git diff <sha>^ <sha> | git patch-id --stable`) equals the branch's
  (`git diff $(git merge-base <base> branch_tip) branch_tip | git patch-id --stable`) — then
  records `deploy_base` at the base tip with the proof kind. A rebase-merge (several rewritten
  commits, neither ancestry nor a single patch-id) is refused with a message naming the two
  accepted proofs. `--pushed` alone retires nothing and deploys nothing.
- **`keep`** and **`discard`** write `incomplete_authorized {reason: kept|discarded,
  disposition_sha: <branch_tip>}` inside the disposition transaction itself and archive as
  incomplete (§7.4). They are the operator's own "not done" decisions and never satisfy Outcome 3.

### 7.4 Completion class and the replay guard

`state.completion` is written at archive: `complete` or `incomplete:<reason>`. An archived bundle
with **no** `completion` field — every pre-v10 archive, and **this run's own archive**, which the
pinned v9.10.0 finish writes (normative bootstrap exception, parallel to §6.1) — classifies as
`legacy`: never `complete`, never a crash. `runs list`, `mp status`, and the retro print the
class, and the doctor's `dangling-run` family gains an `incomplete-archive` INFO line for
`incomplete:*` and a `legacy-archive` INFO line for `legacy`, so neither is mistaken for complete.

A run that hands work to a successor says so durably: a `required_successor {slug, reason}` event
on the bundle (writable by the pinned v9 `mp event`, so this run can record it before its own
finish), surfaced by `runs list` and `mp status`, and enforced by the doctor check
`required-successor`, which **FAILs** while any archived bundle names a slug whose bundle is
absent or not `completion: complete`. The doctor WARNs `no-definition-of-done` only when a
`.masterplan.yaml` exists without a `done:` block; `done: none` is the explicit opt-out for a repo
with no deploy surface, and a repo with no file at all is not nagged.

Two distinct durable authorizations replace the old "retired disposition → archive" shortcut:

- `completion_confirmed {deploy_base_sha}` — written only by `--intent-confirmed`; archive
  **complete** requires it and requires its sha to equal the latest `deploy_base` event.
- `incomplete_authorized {reason, disposition_sha}` — written by `keep`/`discard` (in the
  disposition transaction; `disposition_sha` = branch tip), by `--deploy-skip` (mandatory group
  skipped; `disposition_sha` = `deploy_base_sha`), by `--deploy-abort-incomplete` (same), and by
  `--intent-rejected` (§7.5; `disposition_sha` = `deploy_base_sha`); archive **incomplete**
  requires it.

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

The decision is recorded as the **first event after the seed's capability event**: `mp seed`
**requires** `--overlap-review=<json file>` (a seed without it is refused, so G1's first-event
property cannot hold vacuously; an empty inventory still yields a review with zero candidates)
and appends `overlap_review {inventory_sha256, candidates: [{slug, axis, status}], action}` as the
second record of the new bundle's `events.jsonl` (the capability event the seed already writes
stays first). Tests assert the complete event array. *Resume that run*
seeds nothing and records the same review on the resumed bundle via `mp record-overlap-review
--state=<resumed> --review-file=<json>` (same schema, appended at the current tail); *abort*
creates nothing durable (nothing was created), and the sequencer says so.

The review is bound to the inventory it judged: `mp runs list` prints `inventory_sha256` (the
digest of the records it returned), the review file carries it, and both recorders recompute the
digest at write time and refuse a mismatch (`overlap_review_stale`). The digest is **staleness
detection, not a lock**: it catches a review computed against an inventory that has since changed
(an earlier session's file, or a sibling that seeded in between). Genuine concurrency is handled
by ordering, not hashing — `mp seed` takes a repo-wide seed lock (atomic `mkdir` of
`<MAIN>/docs/masterplan/.seed.lock`, held only across validate-then-create, released on exit; a
lock whose recorded pid is dead is broken by `mp sweep`), validates the review digest **before**
creating anything, and creates the bundle directory last, so a refused seed leaves nothing on disk
and two seeds can never both pass the same inventory.

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

The constraint that shapes everything below: the v9.10.0 goal check and finish-time adversary
review both read `main..<tip>` with `main` = the **local** base branch, so local `main` must not
contain the tip until both have run; but the Claude plugin cache installs from **GitHub** `main`.
The two are decoupled by merging on GitHub first and fast-forwarding local `main` only at the
`branch_finish` gate.

1. **The bootstrap wave — the plan's final wave, executed by the shell with the operator
   (risky-action AUQs), BEFORE `mp finish`.** Ordered steps, each recorded on this bundle with
   the exact command
   `mp event --state=<path> --type=bootstrap_step --data='{"step":"<name>","cmd":"<cmd>","exit":N}' --note-file=<output digest>`
   — written through the **branch's** `bin/masterplan.mjs` (v10 code), never the pinned v9 binary:
   v10 schema-validates the `bootstrap_step` type (step-name enum in wave order, required `cmd`
   and `exit`, monotone step order, a repeated step refused unless `status: recovered`), so a
   compaction mid-wave cannot re-record or hand-compose a step, while v9's `mp event` accepts any
   JSON; the two binaries share the state schema (§4.1, no bump):
   1. *Rehearsal.* `scripts/rehearse-v9-finish.sh` runs steps 2–7 and the finish of step 2 below
      on a scratch clone with a throwaway bundle, driven by a **pinned** copy of the installed
      9.10.0 tree (copied to a scratch path before anything else and asserted to print
      `9.10.0`; every `mp finish`/`finish-step` invocation in steps 1–2, real or rehearsed, uses
      that pinned path, never a repo-relative binary — the cache and the repo both move to v10
      during the wave). Fixture substitutions are normative: a scratch bare remote stands in for
      GitHub; the server-side PR merge is emulated by a second clone that merges the branch into
      `main` and pushes; `install-pi` runs with `--install-root`/`--pi-root` fixtures; the Claude
      cache is a fixture config dir (`CLAUDE_CONFIG_DIR`, which `lib/paths.mjs` honors) holding an
      `installed_plugins.json` and a cache tree at v10 written by the script in place of the
      operator's slash commands; the user-only handback is simulated by feeding that fixture's
      evidence. It must show: the goal check and the review each ran over a **non-empty**
      `main..tip` diff (a sentinel goal fails if the assessor is handed an empty diff); every
      commit local `main` gains between `main_pre_bootstrap` and the gate touches only the bundle
      directory; the recorded PR-merge sha is an ancestor of the remote `main` and a descendant of
      the branch tip, before and after the gate rebase; the rebase succeeds without conflict;
      `--choice=merge` performs an actual no-op merge and still retires the branch and archives;
      the post-archive push is a fast-forward on the remote; the fixture doctor reports v10
      installed; an unexpected non-bundle commit on `main`, an unexpected remote tip (`origin/main` ≠ the
      recorded merge sha), and a missing PR merge each stop the walk; the fixture clone starts
      **ahead of its remote by a non-bundle commit** (the real local `main` is ahead of GitHub by
      unrelated commits, §10.1.5); the gate is reached with the same uncommitted bundle writes the
      real finish leaves (the script drives the real op sequence through the pinned binary) and
      the bundle commit, clean-tree check, and rebase of §10.2 are asserted in that state; every
      §10.3 failure row has a fixture (partial push, red CI status, `install-pi` failure and
      rollback to 9.10.0, PR-merge reconcile in each state, a rejected step-5 push that must
      stop, a sibling bundle's state commit on `main` that must be accepted, a foreign commit
      that must stop, a `user_only` check exiting 0 / 1 / other, and a corrective 10.0.x release
      through a second PR with no second push of local `main`); and one **real** `gh pr create` /
      `gh pr merge --merge` cycle runs
      against a throwaway private GitHub repository the script creates and deletes, so the merge
      into this repository in step 5 is the only first-time live action. Its output digest is the
      receipt; the real steps run only after it passes.
   2. *Docs normalization* (the finish-time offer's work, done here so the release commit is the
      last commit on the branch); the finish's later `docs_normalize` offer is answered
      *keep as-is* with reason `normalized in bootstrap wave` (durable skip event). Then the
      **pre-publish verify**: the repo's verify command (full test suite plus doctor) at the
      branch tip; red stops the wave before anything leaves the machine (§10.3), and the
      finish-time `run_verify` later repeats it. Then the **pre-publish review**: the native
      cross-vendor `adversarial-review` workflow over `git diff main...branch_tip` (the same diff
      the finish will review) and an implementation assessment of G1–G5 by `mp-goal-assessor`
      over it, both recorded as `bootstrap_step` events carrying the reviewer receipts; a
      `revise`/`reject` verdict or a `missed` goal stops the wave before step 3, while the
      worktree still exists to fix it. The finish-time review and goal check remain the run's
      gate of record; this pass exists so that publishing (steps 3–6) never precedes *every*
      whole-branch review.
   3. *Release commit and tag* on the branch tip: `scripts/release.mjs --version=10.0.0` (version
      files, CHANGELOG, `release: v10.0.0` commit, annotated tag). From here the branch tip does
      not move: bundle writes go to MAIN's base branch, never the run branch, so the tag and the
      finish-time branch tip are the same commit. Identity is checked, not assumed:
      `test "$(git rev-parse refs/tags/v10.0.0^{commit})" = "$(git rev-parse <tip>)"`.
   4. *Push* the branch and the tag; verify the remote tag equals the local one
      (`git ls-remote --tags origin refs/tags/v10.0.0` sha = local); **wait for the tag's CI run**
      (`gh run list --branch v10.0.0 --workflow ci.yml`, then `gh run watch --exit-status`) and
      record both jobs' conclusions (`test`, `release-publish`) in the event — red is a §10.3
      failure and `install-pi` does not run; `install-pi --ref=v10.0.0`; `install-pi --check
      --expect=v10.0.0` (Pi surface live **and executable**: `--expect` runs the installed
      binary's `version`, §7.1).
   5. *Push local `main`* — first `git -C MAIN fetch origin main` and require `origin/main` to be
      an ancestor of local `main` (this workspace is host-local across three machines and
      `origin/main` is unprotected, so a foreign commit can land at any time; a rejected or
      non-fast-forward push is a §10.3 stop: reconcile, never force). Bundle writes land on
      MAIN's base branch (§2e), so local `main` carries this bundle's own state commits **and may
      be ahead of GitHub by unrelated commits** (on 2026-09-02: 16 ahead, 4 of them non-bundle);
      the push carries all of them as ordinary `main` history and moves no local ref, and
      `main_pre_bootstrap` is recorded **after** it,
      so the gate's rebase range and the audit range coincide (a `WORKLOG.md` overlap between
      those commits and the branch surfaces as a PR-merge conflict, handled by §10.3's merge row). Local `main`'s sha is recorded as `main_pre_bootstrap`.
      From here until the gate, local `main` may gain **state-only commits** (every later
      `bootstrap_step` event and every finish-step bundle commit lands there); the invariant is
      not "unchanged" but "every commit in `main_pre_bootstrap..main` is a non-merge commit
      touching only `docs/masterplan/*/`" (any bundle's — a sibling session's gate resolution is
      not this run's business, but it is not foreign either; §7.3 uses the same scope), which the
      rehearsal and the gate step both assert per commit: for each sha in `git rev-list
      main_pre_bootstrap..main`, `git diff-tree --no-commit-id --name-only -r <sha>` lists only
      bundle paths and the commit has one parent (an endpoint diff would miss a change followed
      by its revert). Then the named risky-action AUQ, immediately before the merge: *merging
      publishes v10 to the marketplace; both production surfaces will run it before the
      finish-time review and goal check, and the Claude surface has no downgrade lever (§10.3) —
      proceed?* The answer is recorded as `bootstrap_step {step: publish_ack, answer}` and the
      wave stops on anything but proceed. Then open and merge the pull request
      `masterplan/<slug> → main` on GitHub (`gh pr create`,
      `gh pr merge --merge`). Record the PR merge sha (`gh pr view --json mergeCommit`) in the
      `bootstrap_step` event and verify `branch_tip` is its ancestor. GitHub `main` now contains
      the tip; **local `main` is not fetched or pulled** — its tip stays where it was, so
      `main..<tip>` is still the full branch.
   6. *Claude surface* (user-only, handed back with the exact text): `/plugin marketplace update
      rasatpetabit-masterplan` (the marketplace clone is a GitHub clone tracking `main`, verified
      2026-09-02), `/plugin update masterplan`, `/reload-plugins`. Evidence the operator pastes
      back and the shell verifies before recording: `node bin/doctor.mjs
      --only=plugin-registry-drift` exit 0 reporting v10.0.0, and `node
      ~/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/10.0.0/bin/masterplan.mjs
      version` printing v10.0.0.
   7. *Both surfaces live, local diff intact* — the precondition for step 2.
   G6 is `signal: command` because the installed v9.10.0 assessor's documented contract is to
   verify command-class evidence by running read-only commands itself. For the version V the
   latest `bootstrap_step {step: release}` event names (v10.0.0, or a corrective v10.0.x per
   §10.3): `node bin/install-pi.mjs --check --expect=vV` (which executes the installed binary),
   the tag-identity commands above, `git ls-remote --exit-code --tags origin refs/tags/vV`,
   `gh run list --branch vV --workflow ci.yml --json conclusion`, `node bin/doctor.mjs
   --only=plugin-registry-drift`, and `node ~/.claude/plugins/cache/rasatpetabit-masterplan/
   masterplan/V/bin/masterplan.mjs version` are all runnable from the detached assessment
   worktree (they read the live install roots, the remote, and the Actions API), so no new
   consumer of `bootstrap_step` events is needed for the verdict; the events are the
   human-readable receipt.
2. **Then `mp finish` under v9.10.0:** verify at the tip → goal check over the real `main..tip`
   diff (G1–G5 from the branch, G6 from the live commands above; a `partial` here is a real gap
   and a §10.3 corrective-release trigger, never waived) → retro → the finish-time adversary
   review over the same real diff → `branch_finish` gate opens. At the gate, before answering:
   **commit the pending bundle state first** — `git -C MAIN add docs/masterplan/<slug> && git -C
   MAIN commit` (the pinned v9 finish writes `state.yml`/`events.jsonl` through every op before
   the gate and commits only at gate resolution and archive, so the tree is dirty here by
   construction, and `git rebase` refuses a dirty tracked file — reproduced, exit 1); then require
   `git -C MAIN status --porcelain` to be empty (anything else: stop); `git -C MAIN fetch origin
   main`; require `origin/main` to **equal** the **latest** recorded PR-merge sha (the newest
   `bootstrap_step {step: pr_merge}`; two exist after a corrective pass, §10.3) — not merely
   contain it (the round-10 advisory: a different remote tip means someone else moved GitHub
   `main`: stop) —
   and `branch_tip` to be its ancestor; run the per-commit state-only audit of §10.1.5 over
   `main_pre_bootstrap..main` (anything else means something other than this run moved `main`:
   stop); then **`git -C MAIN rebase origin/main`** — local `main`'s unpushed state-only commits
   replay on top of GitHub `main`, which cannot conflict because the merged code never touches
   the bundle directory; re-verify the ancestry against the new local tip; record all of it as a
   `bootstrap_step`. Then `--choice=merge` through the pinned v9 binary: finish-step's own merge
   is a no-op ("already up to date"), the branch retires, the run archives (class `legacy`,
   §7.4), and the archive commit plus the replayed state commits are pushed to `origin main`.
   History carries one merge commit (GitHub's) followed by linear state commits. D2's outcome
   (both surfaces before archive) is unchanged.
3. **Successor run (`v10-validation`).** Seeded with `--predecessor=intent-to-completion` on the
   installed v10: the first v2 `goals.md`, a small real change, and a finish that exercises the
   deploy stage, `run_final_check`, and `intent_confirm` end-to-end. Its archive with
   `completion: complete` is the evidence for the *automated* flow (Outcome 3's mechanism); the
   *rollout* of v10 itself is complete inside this run per steps 1–2. It is listed in this run's
   retro as the next **required, non-deferrable** run (§3's deferral allowance does not apply to
   it; Outcome 7's second sentence is satisfied by nothing else), and the seed-time overlap check
   (§8) surfaces this bundle and that open step to whoever seeds next.

### 10.3 Failure dispositions inside the bootstrap wave

Every step before 1.3 is reversible (nothing has left the machine). From 1.3 on, each step names
its own disposition, the wave never proceeds past a failed step, and every failure and its
recovery are a `bootstrap_step {step, status: failed|recovered, cmd, exit}` pair on the bundle:

| failure | disposition |
|---|---|
| pre-publish verify (step 2) red | fix on the branch as ordinary execute-phase work; nothing published |
| release commit or tag (step 3) fails | delete the local tag, fix, re-run step 3 — nothing pushed yet |
| branch/tag push (step 4) fails or is partial | idempotent retry (pushing an existing identical tag is a no-op); a remote tag whose sha differs from the local one is **stop** — a public tag is never moved |
| tag CI (step 4) red, or `release-publish` fails | the tag is public: **corrective release** (below); `install-pi` is not run on a red tag |
| `install-pi` (step 4) fails after the tag push | `node bin/install-pi.mjs --ref=v9.10.0` restores the Pi surface (the previous release dir is still under `releases/`; the swap is atomic), then corrective release |
| `gh pr merge` (step 5) fails | reconcile first, never re-merge blind: `gh pr view --json state,mergedAt,mergeCommit` — MERGED → record the sha and continue; OPEN → retry once, then stop; any other state → stop. The throwaway-repo cycle in step 1 rehearses the real command; this row is the named recovery for the one first-time live action |
| step-5 push of local `main` rejected (non-fast-forward: a foreign commit reached `origin/main`) | **stop, never force-push**; reconcile by hand (fetch, inspect the foreign commit, rebase local `main` onto it with the §10.2 audit, re-run the step-5 preconditions); the tag and Pi install from step 4 are unaffected |
| a foreign (non-bundle) commit on local `main` between `main_pre_bootstrap` and the gate | the audit stops the walk: something other than this run moved `main`; inspect, and either revert it (then the range is bundle-only again) or reconcile by hand — never widen the audit to admit it |
| goal check `partial`/`missed`, a blocking finish-time review, or a red `run_verify` after both surfaces are live (step 2 of the walk) | **corrective release**: the fix lands as new commits on the run branch (`branch_tip` moves; the v10.0.0 tag stays where it is), `scripts/release.mjs --version=10.0.x` makes the new tip and tag, steps 4, 6 and 7 re-run for 10.0.x, and step 5 is **reduced** on the corrective pass to: fetch, require `origin/main` to equal the latest recorded merge sha, open and merge the second PR, record its sha (now the latest record, the gate's equality target) — local `main` is **not** pushed again (the first push already carried every non-bundle commit, later local commits are state-only by invariant, and a second push would be non-fast-forward against the first merge), so local `main` stays untouched and `main..tip` still holds the full branch for the finish's goal check and review; the `bootstrap_step {step: release}` event names the new version, and G6 — frozen as "v10.0.0 or the corrective v10.0.x the events name" — is assessed at that version. **Forward-only:** the Claude surface has no downgrade lever short of a revert on GitHub `main`, so a bad v10.0.0 is superseded, not withdrawn; the pre-publish verify and the rehearsal bound the window in which the daily-driver surfaces run rejected code |
| operator declines the corrective release | the run cannot archive complete under any reading: answer the `branch_finish` gate with `keep` (the branch and its tag remain), the archive is class `legacy` (§7.4), and the retro names the corrective release as the required successor's first step |

## 11. Test plan

Named suites, each required by §4.4's inventory or by a finding in §13:

- `config`: each of the four sources wins in turn; nested whole-object replacement; partial
  `context_watch` defaults; explicit `planning_mode` vs complexity default; `done` ignored outside
  the repo file with a warning; `done` schema (unknown group, malformed step, `${version}` without
  `version_from`, hostile version strings rejected and quoted); unknown key → warning; malformed
  YAML → seed fails; invalid enum at every level → fails; `*_source` derived; `auto_compact` alias
  warns, both present fails; `full` alias warns; removed flags rejected; legacy state fields
  tolerated by `migrate`; `done` re-resolved at `deploy_base_sha` (add / change / remove the block
  on the branch after seed → the merged definition runs, `done_sha256` recorded in
  `deploy_base`); the literal §7.1 sample against a tagless bare remote (`ls-remote` normalized to
  exit 1 → absent, not indeterminate); `user_only` steps are `{text, check}` and a `{text,
  evidence}` step fails the seed; `done: none` accepted.
- `knob-inventory`, `knob-contract` (§4.4), including the read-but-ignored synthetic knob, the
  seeded-field-only synthetic knob (guard must fail), and a gated-vs-loose contract.
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
  `incomplete_authorized` (incomplete); `keep`/`discard` cannot reach the deploy stage on replay;
  event order `authorized → started → deploy_step` asserted under gated and loose; authorized
  without started re-emits without re-asking; started without authorized is an invariant error;
  group execution order is `release → install → user_only → live_check` regardless of declaration
  order, with a live check that fails until user-only evidence is recorded; run against a **real
  git repo with the real event writer** (not a stubbed tip): state-only bundle commits after
  `deploy_base` are not a move, a non-bundle commit forces a `run` re-run (a `release` re-run at
  an unbumped version → `deploy_failed` on the existing tag), a sibling bundle's commit is not a
  move, **an authorized step's own commit** (a `release` step that commits version files) is
  recorded as stage-produced and the walk still reaches `install`, a dirty tree outside
  `docs/masterplan/` → `dirty_tree`, `version_not_bumped` opens before `branch_finish` when the
  tag exists and the run archives incomplete on keep, a `user_only` check exiting 0 / 1 / other
  → recorded / re-opened / indeterminate, and the post-final `goals_unmet` gate offers no `fix`
  and routes waiver → `intent_confirm`.
- `deploy-commit-identity`: `pr` without `--merged` deploys nothing; merge-sha not an ancestor of
  base, or branch tip not an ancestor of merge-sha → `dispatch-error`; base moved between steps →
  refused; `deploy_base` re-entry; mandatory group skipped → `incomplete:<reason>`; `live_check`
  non-zero → only retry/abort; no `done:` → `no_definition_of_done` gate; ad-hoc done proceeds;
  abort-incomplete archives incomplete; an archive with no `completion` field is class `legacy`
  in `runs list`, `mp status`, and the doctor's `legacy-archive` line, and is never complete;
  `pr` accepts a merge commit (ancestry) and a squash (patch-id equality) and refuses a
  rebase-merge with the message naming both proofs.
- `final-check`: goals needing live evidence cannot pass from the implementation assessment; final
  receipt binds `deploy_base_sha`, `deploy_chain_hash`, `live_check_digest`; `intent_confirm`
  opens only after a final receipt.
- `intent-rejected`: both classes archive `incomplete:intent_rejected:<class>` with
  `incomplete_authorized` at `deploy_base_sha`; the correction text is stored for `intent`; a
  successor seeded with `--predecessor` sees it; no receipt of the rejected run is accepted by the
  successor's recorders.
- `overlap-sequencer`: in-progress conflict, plan-path conflict with a different topic, archived
  overlap, no overlap, predecessor link, resume (event on the resumed bundle), abort (nothing
  created); a freshly seeded bundle's event array begins `[capability, overlap_review]` (G1's
  "first event" phrasing means first after the seed's own capability record); `runs list`
  carries the new fields and `inventory_sha256`; a review whose digest no longer matches the
  inventory is refused (`overlap_review_stale`) and a refused seed leaves **nothing** on disk
  (validate-then-create); `mp seed` without `--overlap-review` is refused; two seeds holding the
  same inventory digest serialize on the seed lock and the second is refused; a dead-pid lock is
  broken by `mp sweep`.
- `agents-compat`: the v2 assessor and reviewer prompts declare a v1 mode; a fixture v1-mode
  output validates against the v9 `record-goal-check` schema; a v1 `goals.md` yields no
  `intent_verdict`.
- `context-status-session-lineage`: fixture transcripts for a fresh session, a resumed session, a
  subagent transcript alongside (ignored), trailing tool/user records after the last usage
  (`appended_est`), post-compaction with no usage, malformed usage, 200k and 1M windows, and a
  missing transcript (`unsupported`).
- `resume-brief`: zero, one, and several active bundles; doctor `resume-brief-hook` on a policy
  with the rule, without it, with a rule lacking `--repo-root`, and with no policy file; doctor
  `no-definition-of-done` (fires only with a `.masterplan.yaml` lacking `done:`; silent with no
  file or with `done: none`), `incomplete-archive`, `legacy-archive`, and `required-successor`
  (FAIL while the named slug is absent or not complete; OK once its archive is
  `completion: complete`).
- `register-pi-agents`: picks up `mp-intent-critic`; `publish-hygiene`: 10.0.0 everywhere.
- `v9-to-v10-bootstrap`: a scripted walk of §10 step 1 against the fixture substitutions §10.1.1
  defines (bare remote, second-clone PR merge, fixture install roots, fixture `CLAUDE_CONFIG_DIR`),
  proving: the release script, tag, push, and `install-pi` commands exist on the branch and produce
  the `bootstrap_step` receipts G6 expects (schema-validated: a repeated or out-of-order step is
  refused, `status: recovered` is accepted); `release.mjs` refuses unbumped version files and
  replays idempotently at its own tag; annotated-tag object equality and peeled-commit equality
  against the tip; every commit in `main_pre_bootstrap..main` before the gate is a non-merge
  commit touching only `docs/masterplan/*/` (per-commit `git diff-tree` audit, with a
  fixture containing a non-bundle commit plus its revert that must be rejected); the gate rebase
  onto the recorded PR merge succeeds with event state preserved; an actual no-op merge; branch
  retirement; the archive commit; a fast-forward post-archive push; an unexpected remote tip
  (`origin/main` ≠ recorded merge sha), a missing PR merge, and an unexpected merge commit on
  `main` each stop the walk; the gate is reached with the pinned binary's real dirty bundle state
  and the bundle commit + clean-tree check precede the rebase (a dirty non-bundle file stops);
  the fixture clone starts ahead of its remote by a non-bundle commit; each §10.3 row has a
  fixture (partial push, red CI, `install-pi` failure → `--ref=v9.10.0` restores `current`,
  PR-merge reconcile in MERGED / OPEN / other, corrective 10.0.x through a second PR with G6
  assessed at the new version and **no second push of local `main`** — the gate compares against
  the latest merge record, operator-declined corrective → `keep` + `legacy`, a rejected step-5
  push → stop, the pre-publish review's receipts recorded and a `revise` verdict stopping the
  wave before the tag). The throwaway-repo `gh pr` cycle is part of the live rehearsal (step 1),
  not this suite. The live execution is the plan's bootstrap wave, not this test.
- `interview-ledger-resume` additions: dirty payload → intent answer → clean payload → design
  pick → `converged`; clean payload → design withdraw → still `converged`; a design answer that
  records a new draft → stale receipt → fresh critic required; medium reaches `exhausted` only at
  the cap or on `critic_unavailable`; each of `converged`/`exhausted`/`critic_off` refused with no
  draft, refused with an intent answer after the latest draft, accepted after re-drafting; every
  mutating verb refused after each terminal state and after waiver (including on replay);
  `reopen` accepted only in `brainstorm` before `goals_frozen`, refused otherwise; `goals-load`
  after a reopen requires a new terminal state; cap reached with the floor unmet (asks withdrawn)
  → `end` refused for every reason and only the waiver (`floor_unmet_at_cap`) is accepted;
  withdrawn questions count toward the cap and never toward the floor; clean-unknowns payload
  with a contradiction → `critic --unavailable` → `exhausted` lists the contradiction and the
  spec needs its `assumed` row; `--round` other than current/next refused; asks of one round
  recorded before their answers accepted; at `high`, `converged` refused while any intent round
  lacks a following critic receipt; a design-only ledger (eight design picks at `high`) → `draft`
  refused and `end` refused for every reason; intent floor unmet with the floor met → every
  non-waived exit refused; one intent answer + the intent floor → `draft` accepted.

## 12. Touch surface

**New:** `lib/config.mjs`, `lib/interview.mjs`, `lib/context-status.mjs`, `scripts/release.mjs`,
`scripts/rehearse-v9-finish.sh`, `agents/mp-intent-critic.md`, `.masterplan.yaml` (this repo),
`docs/design/intent-interview.md`, tests named in §11 (including `test/agents-compat.test.mjs`).
**Modified:** `bin/masterplan.mjs` (seed resolver + `--overlap-review`, `config show`,
`interview *`, `context-status`, `resume-brief`, `runs list` fields, flag whitelist),
`lib/bundle.mjs` (fields, `completion`), `lib/goals.mjs` (v2), `lib/finish-step.mjs` (deploy stage,
`run_final_check`, gates, authorizations, replay guard), `lib/runs.mjs` (new fields),
`lib/doctor/*` (five checks: `resume-brief-hook`, `no-definition-of-done`, `incomplete-archive`,
`legacy-archive`, `required-successor`), `bin/install-pi.mjs` (`--check --expect=<v>` executes
the installed binary),
`agents/mp-goal-assessor.md` (final assessment + v1 mode), `agents/mp-adversarial-reviewer.md`
(v1 mode),
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

Round 4 (5 blocking, 1 advisory) → rev 5:

| finding | disposition in rev 5 |
|---|---|
| `converged` not deterministic (ledger head moves; no draft verb; no unavailable/resolution ops) | `content_head` excludes receipt events; `interview draft`, `critic --unavailable`, `--resolves` (§5.3, §5.4) |
| intent rejection had two normative paths | A15 replaced; `incomplete_authorized` producer list includes rejection; test rewritten (§7.4, §7.5, §11) |
| a successful `run` could bypass its `check` | `check` runs after every successful `run`; exit map defined (§7.2) |
| G6 could not be established by the pre-finish v9 goal check | both surfaces installed in the bootstrap wave before finish; evidence is command-class the v9 assessor runs (§10) |
| held-gate maneuver untested | replaced by a rehearsed pre-finish merge (`scripts/rehearse-v9-finish.sh`) and exact receipt command (§10) |
| resume-overlap had no named operation | `mp record-overlap-review` (§8) |

Round 5 (4 blocking, 2 advisory) → rev 6:

| finding | disposition in rev 6 |
|---|---|
| pre-finish local merge emptied `main..tip` before the v9 goal check | merge on GitHub (PR), local `main` untouched until the gate, then `pull --ff-only`; rehearsal asserts non-empty diffs (§10) |
| medium cannot converge; unsatisfiable resolution predicate; `withdraw --resolves` undefined | `content_head` counts intent-content only; convergence = clean latest payload; `--resolves` is bookkeeping; `withdraw --resolves` (§4.2, §5.3, §5.4) |
| `deploy_step_started` before the gated ask | `deploy_step_authorized` precedes `started`; replay re-asks under gated (§7.2) |
| group order unspecified; `live_check` before `user_only` deadlocks | fixed order `release → install → user_only → live_check` (§7.1) |
| rehearsal did not assert the review guard | moot: no pre-recorded review; rehearsal asserts non-empty review diff (§10) |
| tag identity not proven | tag-commit = tip and remote = local checks (§10.1 steps 3–4) |

Round 6 (2 blocking, 3 advisory) → rev 7:

| finding | disposition in rev 7 |
|---|---|
| medium critic "once" strands after an unclean payload; design withdraw moved the head | retry rule in the levels table; design-kind withdraws excluded; draft update on intent-changing design answers (§4.2, §5.3) |
| rehearsal could not run `gh pr` / slash commands against a bare remote | normative fixture substitutions (§10.1.1) |
| finish could run the v10 binary | pinned 9.10.0 copy for every finish invocation, asserted (§10.1.1, §10.2) |
| PR merge sha unbound at the gate | recorded at step 5, ancestry verified before and after the fast-forward (§10.1.5, §10.2) |
| rev-6 invariants lacked named tests | added to `finish-replay`, `v9-to-v10-bootstrap`, `interview-ledger-resume` (§11) |

Round 7 (1 blocking, 2 advisory) → rev 8:

| finding | disposition in rev 8 |
|---|---|
| terminal states could lack or trail the intent draft | draft must be the latest intent-content event for every non-waived exit; tests (§5.4, §11) |
| overlap "first event" wording | §11 states the exact array prefix; G1's frozen phrasing is defined as "first after capability" |
| local-main push rationale | clarified: bundle commits already live on local `main` (§2e); `main_pre_bootstrap` recorded (§10.1.5) |

Round 8 (2 blocking, 1 advisory) → rev 9:

| finding | disposition in rev 9 |
|---|---|
| local `main` cannot stay frozen (finish-step commits state to it); `pull --ff-only` impossible after the PR merge | invariant becomes state-only commits in `main_pre_bootstrap..main`; the gate rebases them onto `origin/main`; rehearsal asserts the range and the conflict-free rebase (§10.1.5, §10.2) |
| terminal interview states not absorbing | every mutating verb refuses after `end`/`waived`; `reopen` only in brainstorm before freeze (§5.3, §11) |
| outcome 1 vs `exhausted` | outcome 1 rewritten to name the weaker exits (§2) |

Round 9 (1 blocking, 1 advisory) → rev 10:

| finding | disposition in rev 10 |
|---|---|
| §11 still described the frozen-`main` fast-forward path | `v9-to-v10-bootstrap` rewritten for the state-only range, rebase, no-op merge, retire, archive, push (§11) |
| endpoint diff cannot prove per-commit invariant | per-commit `git diff-tree` audit with single-parent check; revert fixture (§10.1.5, §10.2, §11) |

Round 10 (PASS, 1 advisory) → carried into rev 11: `origin/main` must **equal** the recorded PR-merge sha before the gate rebase (§10.2).

Cross-vendor panel over rev 10 (native `adversarial-review` workflow: openai/gpt-5.6-sol revise, zhipu/glm-5.2 reject, in-repo approach / failure-case / blast-radius lenses revise; 0 blockers survived in-tree verification, 11 should-fix, 6 nits; record in `gate-spec-panel.json`) → rev 11:

| # | finding | disposition in rev 11 |
|---|---|---|
| P1 | no failure disposition after the first irreversible bootstrap step | §10.3: per-step recovery table, pre-publish verify (step 2), corrective v10.0.x release, Pi rollback, PR-merge reconcile, throwaway-repo `gh pr` rehearsal; G6 amended to "v10.0.0 or the corrective v10.0.x the events name" |
| P2 | gate rebase on a dirty bundle tree (reproduced: exit 1) | §10.2: bundle commit + clean-tree check before the rebase; rehearsal reaches the gate in the same dirty state |
| P3 | §7.3 strict tip equality vs state-only commits; check-only re-entry re-certifies | §7.3: per-commit bundle-only audit is not a move; a real move re-runs every `run`; `finish-replay` on a real repo |
| P4 | this run's archive has no completion class; successor deferrable | §7.4 `legacy` class (normative bootstrap exception); Outcome 7 and §3 make `v10-validation` required |
| P5 | `exhausted` reachable with zero answers via withdraw | §4.2/§5.4: floor over answered only, required for every non-waived exit; `floor_unmet_at_cap` waiver |
| P6 | contradictions/misclassified dropped on `critic_unavailable` → `exhausted` | §5.1 step 5, §5.4: all three lists of the latest available payload become `assumed` rows |
| P7 | `done:` resolved at seed, stale at deploy | §4.1/§7.3: re-resolved at `deploy_base_sha`, `done_sha256` recorded |
| P8 | "seeded state field" accepted as a knob observable | §4.4: consumer-side observables only; seeded-field-only synthetic knob must fail |
| P9 | live checks never execute the installed binary | §7.1: `--check --expect` executes `current/bin/masterplan.mjs version`; Claude doctor runs through the cache copy; G6 amended |
| P10 | tag-push CI run never queried | §7.1 sample CI step (`gh run watch --exit-status`); §10.1.4 waits for the run; G6 amended |
| P11 | v2 assessor prompt dispatched by v9 against v1 goals | §6.2 compatibility contract + `agents-compat` suite |
| N12 | `ls-remote --exit-code` exits 2 on absent | §7.1 sample normalized with `\|\| exit 1`; literal sample tested against a tagless remote |
| N13 | "behind by exactly those" is false | §10.1.5 corrected; fixture clone starts ahead of its remote |
| N14 | post-final `goals_unmet` `fix` is dead | §6.2: waiver / abort / reject-intent only after the final assessment |
| N15 | "critic after every intent round" unenforceable | §5.3 `--round`; §5.4 `converged` at `high` requires a receipt per intent round |
| N16 | deploy steps run from a possibly dirty MAIN | §7.2: `dirty_tree` refusal at authorization |
| N17 | overlap check is a check-then-seed race | §8: `inventory_sha256` binding, `overlap_review_stale` |

Cross-vendor panel over rev 11 (same workflow: gpt-5.6-sol revise, glm-5.2 revise, three lenses revise; 2 blockers, 7 should-fix, 5 nits; six reviewer claims dropped after in-tree verification — the v9 assessor's detached-HEAD context, the install-pi split-version hazard, the CI job-skip hazard, the §4.4 exemption "bypass", receipt provenance strength, and "concurrent runs are the normal mode") → rev 12:

| # | finding | disposition in rev 12 |
|---|---|---|
| B1 | the sample `release` step commits to the base and trips §7.3's own audit; an unbumped version dead-ends | §7.1 release contract (bump is branch work; `release.mjs` never bumps, idempotent at its own tag); `version_not_bumped` gate before `branch_finish` (§7.2); stage-produced commits recorded in the receipt (`commits`, `base_after`) and the audit base advances (§7.3); `finish-replay` case |
| B2 | `converged` reachable with zero intent-kind questions | intent floor column (§4.2: 1/3/6); `draft` refuses without an intent answer (§5.3); every non-waived exit requires the intent floor and `converged` a completed intent round (§5.4); design-only ledger tests |
| S3 | base-move audit scoped to this run's slug misclassifies a sibling bundle commit | scope is any `docs/masterplan/*/` path in §7.3, §7.2, §10.1.5, §11; §10.3 row for a genuine foreign commit; fixtures |
| S4 | step-5 push has no fetch/rejection disposition; corrective pass is non-fast-forward; "the recorded merge sha" ambiguous | fetch + ancestry precondition and a rejection row (§10.1.5, §10.3); corrective pass never pushes local `main` again (§10.3); gate compares against the latest merge record (§10.2) |
| S5 | ship-before-review is only an assumed mechanism | pre-publish cross-vendor review + G1–G5 assessment before the tag (§10.1.2); named `publish_ack` AUQ before the merge (§10.1.5); D2/A25 status per the operator's answer recorded below |
| S6 | `user_only` evidence is never executed | `{text, check}` replaces `{text, evidence}`; finish-step runs the check after the handback (§7.1, §7.2, §4.1) |
| S7 | required successor unenforced | `required_successor` event + doctor `required-successor` FAIL (§7.4) |
| S8 | seed race not closed by a digest; refused seed orphans a bundle; `--overlap-review` optional | digest = staleness detection; seed lock + validate-then-create; `--overlap-review` mandatory (§8) |
| S9 | `pr` rejects squash/rebase merges | squash accepted by patch-id equality; rebase-merge refused with a named message (§7.3) |
| N10 | §7.2 omits the post-final `goals_unmet` gate | row added; waiver → `intent_confirm` (§7.2) |
| N11 | `assumed` rows unenforced | stated as reviewer-enforced; the event is the durable record (§5.4) |
| N12 | rendered-line observables too permissive; aliased `process.env` unseen | rendered line only for `<!-- knob -->` controls; aliased access rejected (§4.4) |
| N13 | `bootstrap_step` is a schema-free append | written through the branch's v10 binary, schema-validated (§10.1) |
| N14 | `no-definition-of-done` fires forever for repos with no deploy surface | scoped to a `.masterplan.yaml` without `done:`; `done: none` opt-out (§7.4) |

## Assumptions & Open Decisions

| # | question | decision | rationale | source |
|---|---|---|---|---|
| A1 | Which interview failures to fix? | how-not-why, stops too early, no synthesis | operator's own diagnosis | user-confirmed |
| A2 | Interview budget at high? | floor 8 (intent floor 6), cap 20; medium 4 (3) / 10; low 1 (1) / 4 | operator chose bounded over open-ended; exact numbers per review (intent floor from panel 2, B2) | user-confirmed (bounded) / assumed (numbers) |
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
| A15 | Intent rejected? | two classes, both archive this run incomplete and name a required successor; `intent` additionally stores the correction for the successor's interview (§7.5) | review findings 15 and round-3/4: no `execute` exists after disposition | assumed |
| A16 | No `done:` block? | `no_definition_of_done` gate: ad-hoc steps or incomplete archive; doctor WARN | review findings 5 and 21 | assumed |
| A17 | This run's goals.md schema? | v1; intent in §2; first v2 bundle is the successor run | installed 9.10.0 validates it | assumed |
| A18 | Who wires the post-compaction hook? | this repo ships verb + docs + doctor check; registration is a `user_only` done step | hooks declared only in policy.toml | assumed |
| A19 | `done` from user-global or CLI? | ignored with warning | executable steps must come from the reviewed repo file | assumed |
| A20 | keep/discard outcome? | archive as `incomplete:<reason>`, never complete | Outcome 3 | assumed |
| A21 | Dogfood evidence? | both surfaces installed by the bootstrap wave before `mp finish` via a GitHub PR merge with local `main` untouched until the gate; automated flow proven by the successor | the v9 goal check and review need the local `main..tip` diff; the Claude cache needs GitHub `main`; a local pre-finish merge would empty the diff | assumed |
| A24 | Intent rejected after merge? | archive incomplete; remediation is a successor run | the worktree is gone after disposition; no `execute` to return to | assumed |
| D2 | Claude cache inside this run, or Pi-only scope? | both surfaces on v10 before archive (outcome, user-confirmed); mechanism refined in rev 5 from a held gate to a rehearsed pre-finish merge (§10); the ordering — publish precedes the finish-time review and goal check, bounded by the rev 12 pre-publish review and the `publish_ack` go/no-go — confirmed by the operator 2026-09-03 | the topic's central failure is archiving with a stale running surface; the held gate was untested | user-confirmed (outcome and ordering) |
| A22 | D1 — interview ledger verbs or generic events? | verbs (§5.3) | two adversary rounds rated generic events a blocking gap; operator kept the verbs at approval | user-confirmed |
| A23 | Receipt provenance strength? | honesty-bound (ids, positive tokens, digests), not cryptographic | matches `record-gate-review`; stronger would need a signing dispatcher | assumed |
| A25 | Recovery after a bad publish? | forward-only corrective v10.0.x release; Pi rolls back via `install-pi --ref=v9.10.0`, the Claude surface has no downgrade lever (§10.3) | a public tag is never moved; the marketplace tracks GitHub `main`; the operator confirmed forward-only recovery with the D2 ordering 2026-09-03 | user-confirmed |
| A26 | How is the tag's CI run found? | `gh run list --branch v<V>` (a tag push's run carries the tag name as head branch), then `gh run watch --exit-status` | Actions semantics for tag-push events; the plan verifies it against the live API before the wave | assumed (verify in plan) |
| A27 | Withdrawn questions and the budget? | count toward the cap, never toward the floor; cap with floor unmet → waiver only | bounds ask/withdraw loops without letting withdraws satisfy the floor | assumed |
| A28 | Corrective pass and local `main`? | never pushed a second time; the second PR merges the branch alone; the gate compares against the latest merge record | a second push is non-fast-forward against the first merge, and local `main` must stay untouched so the finish sees the full diff | assumed |
| A29 | Concurrent seeds? | a repo-wide seed lock plus validate-then-create; the inventory digest only detects staleness | a hash is not a lock; a refused seed must leave nothing | assumed |
| A30 | Stage-produced commits? | commits an authorized deploy step makes are recorded in its receipt and advance the audit base | the sample `release` step commits by design; the alternative (forbid committing) would push the version bump out of `done:` entirely | assumed |
