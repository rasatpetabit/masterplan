# Design-intent integration — the masterplan host contract

> How masterplan's intent interview (`mp interview`, spec §5) and the installed
> `/design-intent` skill (behavior-skills) divide the work, and how the skill revision
> masterplan verifies against is pinned. Primary sources: the run bundle's `spec.md` §5
> (interview protocol) and §5.5 (schema ownership, snapshot, and skill identity), the
> design draft `docs/masterplan/intent-to-completion/design-intent-integration-draft.md`,
> and the decision of record in behavior-skills
> `docs/superpowers/specs/2026-09-05-design-intent-design.md` §5 (DECIDED, 2026-09-05).

## Why two implementations stopped being the design

The skill's cross-vendor review found masterplan's `intent-to-completion` branch already
shipped a native intent interview; plan mode as first designed would have been a second
implementation of the same phase. The owner decided (§5 DECIDED): **masterplan delegates the
questioning to the skill** and reads its `schema.json`. One interview implementation, two
consumers. The split that makes that safe:

| Owned by masterplan (the host) | Owned by the skill (plan mode) |
|---|---|
| The ledger (`state.yml`, `events.jsonl`) — every write, through `mp interview` | The questions (one fork per question, rewrite test, option discipline) |
| `goals.md` and its `## G<n>:` goal blocks — owned, written, and validated by masterplan | The section schema (`schema.json` is the authority) |
| The `## Intent` projection's persistence and hashes | Reconciliation of plan intent with the repository `INTENT.md` |
| The lifecycle (`set-phase`, `end`, `waive`, `reopen`, gate integration) | The draft's section bodies and reconciliation rows |

## The host contract (`host_contract_version: 1`)

Plan mode is invoked by a masterplan host, not a bare operator. The contract is a structured
block the host supplies; the skill reads it as data, never as instructions.

**What masterplan provides:**

- **Existing anchor and evidence** — the verbatim bundle `topic:` (the anchor) and the
  survey/recon inputs: the repository `INTENT.md` when present, `spec.md` when present. The
  skill re-reads these from the contract block, not from a disk path the host did not name
  (the reconciliation source resolves from the run's integration target, spec §6.3).
- **Current draft** — the live intent projection (`why` / `outcome` / `anti_goals` /
  `done_means`) when one exists, else an explicit "no draft yet". The interview edits that
  projection in place; the skill never authors a separate `<bundle>/intent.md` unless the
  owner asks for one by name.
- **Ledger status** — the host's own budget block from
  `mp interview status --state=<path>`: `{asked, answered, floor, cap, active_design_picks,
  critic: {mode, receipts, latest_unknowns}, state, complexity}`. The skill never keeps its
  own count and re-reads it before every round.
- **Permitted recorder operations** — the exact `mp interview` verbs the host permits this
  interview to run: `ask`, `answer`, `withdraw`, `draft`, and critic /
  critic-unavailable recording, each with its flag contract (spec §5.3). Recording an
  operation the host did not permit is out of contract and must be refused. The lifecycle
  verbs (`set-phase`, `end`, `waive`, `reopen`) are never the skill's.

**What the skill returns each round:**

- the structured question(s) it asked — asked *through the host's recorder* so they are
  durable in `events.jsonl`;
- the answers the owner gave;
- when a picture forms, the updated **draft** — the intent projection plus its section
  bodies and the reconciliation rows (`repo_intent:` header + one row per repository
  `INTENT.md` section) — rendered for the owner's `Approve` before anything is persisted.

The approved draft travels back through the permitted `mp interview draft` verb; masterplan
writes its own `goals.md` / `spec.md`. The skill never writes `state.yml` or `events.jsonl`
directly — `mp interview` remains the only recorder (CD-7 single-writer discipline holds:
L1's subcommands are the sole writers of bundle state).

## Boundary rules (goal blocks and the shared validator)

- Goal blocks (`## G<n>:`) are masterplan's own artifact, written at spec approval. A
  `goals.md` carrying them is the **normal, expected plan-mode input**, never a refusal
  ground. The skill never interviews, edits, validates, or refuses them — amend them
  through masterplan.
- The skill presents **only the intent projection** to `validate-intent.mjs`
  (`--mode plan`), so the shared validator never sees the goal blocks at all. Goal-block
  validation stays owned by masterplan (`lib/goals.mjs`).
- The repo and assess modes of the skill keep their existing public behavior byte-for-byte;
  the host contract is plan-mode only.

## Skill identity and the pin (`policy/design-intent-skill.json`)

Schema bytes do not identify the code that reads them, so capture also records a **skill
identity** (spec §5.5): a sha256 digest over a *closed* file set — `SKILL.md`,
`schema.json`, the manifest itself, and every file the manifest declares — together with the
skill's declared `host_contract_version` and `schema_format_version`.

- **The set is closed.** The skill's `manifest.json` declares every behavior-affecting
  asset it consists of; loading an undeclared file at runtime is the named failure
  `undeclared_dependency`, not a silent read. Tests are declared assets: they pin public
  behavior, so a behavioral drift through a test edit is also detected.
- **The digest is deterministic.** Entries sort in ascending byte order of the
  manifest-relative POSIX path; each contributes its path, a newline, the lowercase hex
  sha256 of its exact bytes, and a newline, into one running sha256. A listed file that is
  missing, or a path escaping the skill root, fails closed. Filesystem enumeration order
  cannot change the identity.
- **The digest is the identity.** The declared versions are supplementary; an ordinary
  edit that changes behavior without bumping a version still changes the identity and is
  detected.

`policy/design-intent-skill.json` — a repo-side pin beside `policy/workflow-map.json`,
**not** a bundle artifact (bundle state lives on `main` and is written only by L1 per
CD-7) — records:

| Field | Meaning |
|---|---|
| `repo` | absolute path of the behavior-skills repository |
| `skill_path` | repo-relative skill directory (`skills/productivity/design-intent`) |
| `commit` | the 40-hex behavior-skills commit the integration is verified against |
| `manifest_digest` | the recomputed skill identity over the closed file set at that commit |
| `host_contract_version` / `schema_format_version` | the manifest's declared versions |

`test/design-intent-host-contract.test.mjs` verifies the pin against the real repo: the
pinned commit exists, the skill path is clean (the tested bytes are the committed bytes),
the manifest at the pinned commit declares the pinned versions, the closed set covers every
tracked skill file, the digest recomputes over the **committed** tree and matches the pin,
and the pinned skill still teaches the host contract (both directions) without the retired
goal-block refusal.

Later tasks (52/53) implement the same identity computation masterplan-side from the
captured snapshot and must stay byte-identical in algorithm to the recomputation in that
test. At every later operation the installed skill's recomputed identity must equal the
run's recorded identity, with the named failures `skill_absent`, `skill_identity_changed`,
`host_contract_unsupported`, `schema_unsupported`, `undeclared_dependency` — no fallback
to native questioning and none to a newer live schema. A routine skill update is not a dead
end: `mp interview amend-skill-identity` (spec §5.5) is the one guard-exempt operation, so
an identity change lands through an explicit, recorded, operator-approved amendment — never
adopted in place or by inference. The pin file here is updated in the same flow: recompute
over the new commit's tree, record the new `commit` and `manifest_digest`, and keep the
versions in step with the manifest.

## Version contract

- `host_contract_version: 1` — the contract above. A host or skill that does not support
  the other's declared version fails closed (`host_contract_unsupported`); there is no
  silent downgrade.
- `schema_format_version: 1` — the format of `schema.json` (its `version` field is the
  schema's own content version; the manifest's `schema_format_version` is the reader's
  contract with the file's shape). A missing, malformed, or unsupported schema fails
  closed (`schema_unsupported`); a schema upgrade is an explicit amendment, never a silent
  migration (spec §5.5).
## The landed integration (waves 11–16, task 57 record)

The sections above describe the contract as agreed. This section describes the integration
**as landed** — every file and verb named exists on the branch, and the tests that prove each
property are named beside it. Read this after the contract sections; it is the map an agent
follows to the real surfaces.

### The host contract, pinned and dispatched

- **Pin:** `policy/design-intent-skill.json` (repo-side, beside `policy/workflow-map.json`).
  `test/design-intent-host-contract.test.mjs` recomputes the identity over the pinned
  behavior-skills commit's tree and compares against the pin's `manifest_digest`.
- **Identity mechanics:** `lib/schema-snapshot.mjs` (`captureSchemaSnapshot`,
  `computeSkillIdentity`) — the module behind the `SCHEMA_SNAPSHOT_MODULE_OPS` seam
  (`lib/interview.mjs` `registerSchemaSnapshotModule`). Every guard failure is named from
  the closed §5.5 list and thrown verbatim.
- **Dispatch (the cutover, task 59):** `commands/masterplan.md` §2 dispatches the pinned
  skill's plan mode over the host-contract block and records through the `mp interview`
  verbs; the duplicate native questioner is deleted and `test/interview-cutover.test.mjs`
  proves dispatch, disk resume, and the named refusals against BOTH installed surfaces (the
  Claude plugin cache and the Pi install root) — behaviorally, with a mutation control whose
  stub SKILL.md must fail the proof. `test/interview-sequencer-delegation.test.mjs` proves the
  sequencer-side contract; `test/interview-cli-surface.test.mjs` owns the two public verbs.

### The ledger — verbs are the only recorder

`lib/interview.mjs` is the ledger: `askQuestion`, `answerQuestion`, `withdrawQuestion`,
`recordDraft`, `recordCritic` (with the §5.3 `eligible_question_set` / `forks_remaining`
adjudication pair), `recordCriticUnavailable` / `acknowledgeCriticUnavailable`, `endInterview`,
`waiveInterview`, `reopenInterview`, `interviewStatus`, `replayInterview`. Every one is an
`appendEvent` through `lib/bundle.mjs`'s single writer (CD-7); the CLI (`mp interview …`,
`bin/masterplan.mjs` `case 'interview'`) only parses flags and forwards. The replay
(`replayInterview`) reconstructs budget, rounds, content head and critic mode from
`events.jsonl` alone, which is what makes an interrupted interview resumable from disk.

### Convergence — the policy substitution

`interviewPolicy(statePath)` derives the policy from the capture ledger
(`replaySchemaCapture(statePath).captured ? 'schema_backed' : 'legacy'`) and
`endInterview`/`waiveInterview` substitute the convergence conditions under it:

- **Schema-backed (§5.3's two conditions):** `loadAndValidateCoverage` — one row per checked
  section of the FROZEN snapshot (`readSchemaSnapshot`; the live skill file is never
  consulted), each with provenance and stated uncertainty, a `fights` verdict refusing
  convergence; and `evaluateProbing` — the resolved `interview.probing_minimum` against the
  critic's current eligible set (the recorder's mechanical test at `low`, where the critic is
  off). Cap-with-minimum-unmet routes to the existing waiver with cause
  `probing_minimum_unmet_at_cap`; coverage-with-no-forks-remaining is the existing `exhausted`
  with basis `forks_exhausted` — the single probing exemption. No new terminal states.
- **Legacy:** the three floors (answer floor, intent floor, intent-round minimum) as written;
  their role is legacy-only.

The terminal event persists the policy identity it was judged under (`policy`,
`probing_minimum`, `coverage_sha256`; validated in `lib/bundle.mjs` `EVENT_SCHEMAS`), so a
later policy adoption never revalidates a completed interview.
`test/interview-design-intent.test.mjs` is the matrix: a schema-backed interview converges
with all three floors deliberately unmet while its legacy twin refuses the same ledger.
`interview.probing_minimum` resolves through the §4 config hierarchy
(`lib/config.mjs` `resolveRunConfig` → `resolveProbingMinimum`, `validateProbingMinimum`
fail-closed) and is consumed by `mp interview end` / `mp interview waive` / the
`goals-load --interview-waived` route (all three resolve it identically in
`bin/masterplan.mjs`).

### The format pin and the schema snapshot

- **The pin** (`format_pin` on `state.yml`, domain `FORMAT_PINS = ['legacy', 'schema_backed']`)
  selects the canonicalizer `goalsHash(text, { formatPin })` (`lib/goals.mjs`) — the legacy
  flavor byte-identical to the pre-versioning hash, the `schema_backed` flavor covering every
  section body, the plan context, the reconciliation, the schema digest and the
  source-evidence provenance. Every consumer dispatches on the SAME pin through
  `resolveFormatPin` (`lib/bundle.mjs`): the checkpoint identity
  (`lib/checkpoint-evidence.mjs` `buildIntentIdentity`), the finish tuple and split-brain
  guard (`bin/masterplan.mjs` `pinnedGoalsHash`), `record-goal-check`, and `lib/finish-step.mjs`.
  A missing pin with a capture event REFUSES to parse as legacy and is repaired from that
  history (`repairFormatPin`, idempotent, the §6.1 sanctioned repair); a present-but-unknown
  pin is an error; stripping the versioned representation from a schema_backed bundle is a
  rejected downgrade. Oracles: `test/goals-hash-versioning.test.mjs`.
- **The snapshot** is the exact `schema.json` bytes copied beside `state.yml`
  (`SCHEMA_SNAPSHOT_FILENAME`), digest on the `schema_captured` event; a frozen bundle reads
  it (`readSchemaSnapshot`) with a no-follow read and digest equality — never the live skill
  file. Capture is forward-only: `captureSchema` records the FIRST schema state, refuses a
  recapture of an unchanged skill, and routes a changed identity to
  `mp interview amend-skill-identity` (the single guard-exempt, operator-approved, resumable
  replacement — `declareSkillIdentityAmendment` + `amendSkillIdentity` in
  `lib/interview.mjs`). `assertSkillIdentity` enforces the equality guard at every later
  operation.

### Reconciliation with the repository INTENT.md

`lib/reconcile-intent.mjs`: the integration target is an identity —
`resolveReconciliationTarget` (authorization `{repository, remote, ref, repo_intent_digest}`
beside observation `{resolved_commit, resolved_at}`; the two halves are never compared
together), `readTargetIntent` (reads at the recorded commit, never a moving ref or a
worktree), `buildReconciliationRows` (one row per repository `INTENT.md` section, with
`REPO_INTENT_DIGEST_ABSENT` the explicit verified absence), `compareReconciliations` (the four
freshness outcomes — unchanged-refresh, drift, retarget, unknown/unavailable — as distinct
dispositions), and `recordReconciliation` / `readRecordedReconciliation` (the durable record
beside `state.yml`, `RECONCILIATION_FILENAME`). Receipts bind the authorization only;
observation refreshes invalidate nothing. Proofs: `test/intent-reconciliation.test.mjs`.

### The promotion transaction

`lib/promote.mjs` — approval binds base hashes, a unified diff and result hashes
(`validatePromotionApproval`; `applyUnifiedDiff` must reproduce both result hashes before
anything is written), the transaction doc is written before any mutation
(`beginPromotion`, `PROMOTION_DOC_PREFIX` + `transaction_id`), the bases are pinned against
gc (`PROMOTION_REFS_PREFIX`), recovery classifies each artifact against its approved
identities and applies the §5.6 decision table with symmetric refusal
(`recoverPromotion` / `classifyArtifact`), and recording is exactly-once by transaction id
(`commitPromotion`). The entry path is the real one — `lib/wave-commit.mjs`
`promoteAmendment` (the existing amendment path's seam) holds the bundle write lock across
both file writes and the record. Proofs: `test/promotion-transaction.test.mjs`.

### Checkpoint integration — the identity tuples

`lib/checkpoint-evidence.mjs` is the shared verifier:

- `buildIntentIdentity` — the current tuple `{goals_hash, schema_snapshot_digest,
  skill_identity, reconciliation_digest}` (`INTENT_IDENTITY_MEMBERS`), family-aware
  (`legacy: true` + `goals_hash` makes a legacy absence explicit, never a schema-backed pass);
  goals.md hashes under the DURABLE pin.
- `buildFinishTuple` — `FINISH_TUPLE_MEMBERS` (`deploy_base_sha`, `deploy_chain_hash`,
  `live_check_digest`) named outright.
- `specGateArtifactHash` / `anchorArtifactHash` / `planArtifactHash` — artifact identity
  (exact bytes, what approval binds) computed at the checkpoint from the bundle's own
  artifacts, kept distinct from the canonical evidence identity the tuple members carry.
- `resolveReviewerIdentity` — the unresolved reviewer is `reviewer_unavailable`, never approval.
- `verifyCheckpointEvidence` — the shared rejection vocabulary
  (`REJECTION_STATUSES = ['missing','partial','unreadable','stale','mismatched',
  'reviewer_unavailable']`) across all four checkpoints (`CHECKPOINTS`), and
  `checkedSectionsOf` / `requiredCoverageSections` — the checked-section set from the FROZEN
  snapshot, never a copied list of today's headings (alternate snapshot content drives
  different required coverage).

The consumers are the real seams: the spec gate (`bin/masterplan.mjs`), the alignment audit
and finish assessment (`lib/finish.mjs`, `lib/finish-step.mjs`), and per-task review
(`lib/task-review.mjs`) all call `verifyCheckpointEvidence`; the reviewer prompts
(`agents/mp-alignment-auditor.md`, `agents/mp-adversarial-reviewer.md`,
`agents/mp-goal-assessor.md`) emit the tuple-carrying receipts. Proofs:
`test/intent-checkpoints.test.mjs` (including the mutation test that bypasses the validator
and the alternate-schema data-driven proof).

### The knob-contract verification (this task)

The §4.4 guard now covers every control this amendment adds — the inventory derives them, so
a future edit that orphans one fails the suite rather than passing as inert:

- **`interview.probing_minimum.{low,medium,high}`** — derived per-level config paths
  (`test/fixtures/knobs/discovery.mjs` `discoverConfigPaths`). Each registry contract
  (`test/fixtures/knobs/contracts.mjs`) proves a CONFIGURED minimum vs the shipped default
  changes the RECORDED waiver outcome on an identical capped ledger: cause
  `probing_minimum_unmet_at_cap` + the resolved minimum under the configured value, no cause
  under the default — driven through the real
  `resolveRunConfig` → `resolveProbingMinimum` → `waiveInterview` chain on a repo-local
  `.masterplan.yaml`, never the resolver in isolation.
- **`format_pin`** — a derived durable bundle control (`discoverDurableControls`, from
  `lib/bundle.mjs`'s exported `FORMAT_PINS` domain). The contract proves `legacy` vs
  `schema_backed` changes the canonical goals hash byte-for-byte through the real consumer
  chain `resolveFormatPin` → `goalsHash` — the same chain `pinnedGoalsHash` and
  `buildIntentIdentity` run.
- **`schema_capture`** — likewise derived (from `EVENT_SCHEMAS.schema_captured`, the event
  `interviewPolicy` reads). The contract proves a captured vs uncaptured bundle changes the
  convergence policy `endInterview` enforces on an IDENTICAL twin ledger: captured converges
  under §5.3's two conditions (the floors deliberately unmet) and persists
  `policy: schema_backed`; uncaptured refuses the same ledger on the legacy floor.

The alternate-schema end-to-end proof lives in `test/knob-contract.test.mjs` (the
"alternate schema content" test): an alternate snapshot content — different
`checked_sections` — flows capture → frozen read → coverage validation → terminal evaluation,
and the consumer DEMANDS the alternate sections (own coverage converges on both bundles;
crossed coverage is refused naming the snapshot; a missing own section is refused), with a
scan proving no checked-section heading literal exists in the control path
(`lib/interview.mjs`, `lib/checkpoint-evidence.mjs`, `lib/schema-snapshot.mjs`).

**Installed-surface reachability** is verified read-only by `node bin/doctor.mjs`
(`plugin-registry-drift` for the Claude plugin-cache surface,
`pi-agent-registration` for the Pi agent surface) and `node bin/install-pi.mjs --check`
(the Pi install root: `current` resolves, metadata agrees, skill links resolve under
`current`, agent registration drift-free); the installed binaries on both surfaces answer
`version`. Doctor warnings name real environment drift (a stale marketplace runtime cache, a
 drifted Pi agent registration) — the checks surface them, they are not gated here.
