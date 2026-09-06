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