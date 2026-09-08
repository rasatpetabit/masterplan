# Intent interview — design

## Overview

The intent interview is the interactive phase that turns the verbatim anchor into a confirmed
intent draft before goals are frozen. It is driven by `lib/interview.mjs` (deterministic verbs,
each an `events.jsonl` append through the existing single writer) and reviewed each round by the
fresh-context critic `agents/mp-intent-critic.md` (critic class, breaker role, frontier lane).

## Budgets

- `mp interview status --state=<path>` returns `{asked, answered, floor, cap,
  active_design_picks, critic: {mode, receipts, latest_unknowns}, state}` derived from the ledger
  and `state.complexity`.
- The prompt reads the budget before every round; it never keeps its own count.
- `floor` and `cap` are set by complexity. Withdrawn questions count against the cap but never
  toward the floors.
- At `high`, an intent-kind ask opening a new round is refused while the previous intent round has
  no critic receipt after that round's last content event.

## Round cadence

- One `AskUserQuestion` call is one round; all its questions share a round number and may all be
  recorded before their answers; the first answer seals the round.
- After the intent questions of a round, the orchestrator dispatches the critic with the verbatim
  anchor, the ledger, and the current intent draft as QUOTED DATA.
- The critic's payload is persisted; the orchestrator asks the top unknowns next; a
  `misclassified` entry is re-asked as a proposal.
- A sealed round cannot be asked into again; the next ask must use `r+1`.
- An ask while a question from an earlier round is unanswered is refused.

## Durable artifacts

- `<bundle>/interview-intent-draft.json` — the current intent draft, written by
  `mp interview draft`.
- `<bundle>/interview-critic-<n>.json` — each critic payload, written by
  `mp interview critic --receipt=<json> --payload-file=<path>`.
- `events.jsonl` — the single durable ledger; every verb is an append.
- Verbatim question and answer text is stored so a compaction mid-interview resumes from disk.

## Honesty-bound receipts

- `mp interview critic --receipt=<json> --payload-file=<path>` copies the payload to
  `<bundle>/interview-critic-<n>.json` and records the event with `{dispatch_id, model,
  output_tokens, payload_sha256, content_head, intent_sha256, unknown_count}`.
- The recorder computes `content_head` and `intent_sha256` from the ledger and refuses a receipt
  that names different values, a receipt without dispatch id, model, and positive output tokens,
  or a payload whose digest does not match — the same honesty bound as `record-gate-review`; it
  is not tamper-proof and is documented as such.
- `content_head` is the index of the last *intent-content* event — an `interview_question` or
  `interview_answer` of kind `intent`, an `interview_withdraw` of an intent-kind question, or an
  `interview_draft` — that the critic was shown. Critic events, terminal events, and
  `design`-kind questions, answers, and withdraws are not content events: recording a receipt or
  a design pick does not move the head, so a critic run after the intent questions stays fresh
  through the design-options round.
- `mp interview critic --state --unavailable --error=<text>` records `critic_unavailable` with
  the error. One failure licenses nothing: the prompt retries the dispatch at least once (a second
  `critic_unavailable` at the same `content_head`), then asks the operator — an AUQ naming both
  errors, at every autonomy level — and only `mp interview end --reason=exhausted
  --critic-unavailable-ack=<answer>` may then close the interview on that ground.

## Terminal states

Every terminal state other than `waived` requires **zero unanswered questions**, **the floor, the
intent floor, and the intent-round minimum met**, and **an `interview_draft` as the latest
intent-content event**.

| state | valid when | `goals-load` |
|---|---|---|
| `converged` | floors met; completed intent rounds ≥ the level's minimum; ≥ 1 active uncorrected design pick; the latest critic receipt is valid, its `content_head` equals the current content head and its `intent_sha256` equals that draft; and its payload is **clean**: zero `unknowns`, zero `contradictions`, zero `misclassified`. At `high`, additionally every intent round has its **own** critic receipt. | accepts |
| `exhausted` | asked == cap (any complexity), or critic mode is `unavailable` after one retry and the operator's acknowledgement; the `unknowns`, `contradictions`, and `misclassified` entries of the latest available payload are listed in the event. | accepts; the spec must carry the `assumed` rows for all three |
| `critic_off` | `complexity: low`; floor met. | accepts |
| `waived` | `goals-load --interview-waived --reason=…` on an open interview; the only exit once the cap is reached with the floor unmet. | accepts, recorded as waived |
| (none) | interview still open. | refuses |

Critic mode is `off` (configured, low), `on`, or `unavailable` (two consecutive dispatches failed
at the same `content_head`). `unavailable` never counts as `converged`.

## Disk-based resume

- The ledger is the source of truth: rounds, kinds, answers, withdraws, drafts, critic receipts,
  and terminal events are all replayed from `events.jsonl`.
- `content_head` is derived by replay, so a compaction mid-interview resumes from disk: the latest
  critic payload is re-read from its artifact, and the next critic dispatch is compared against
  the current `content_head`.
- Terminal states are absorbing. After `interview_end` or `interview_waived`, every mutating
  interview verb refuses. The only way back is `mp interview reopen --state --reason=…`, allowed
  only while `phase` is `brainstorm` and before `goals_frozen`; it writes `interview_reopened`,
  after which the previous terminal event no longer counts and a new terminal state must be
  reached. Once goals are frozen, intent changes go through `mp goals-amend`, never through the
  interview.
