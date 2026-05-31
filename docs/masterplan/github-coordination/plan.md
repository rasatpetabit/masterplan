# Plan: GitHub Multi-Agent Coordination (`github-coordination`)

Derived from `spec.md` Draft 3 (Option B — dedicated immutable contract ref +
integration branch). Builds an **opt-in** GitHub-backed coordination layer onto the
existing v8 masterplan codebase. The single-agent fast path stays byte-identical
(spec A9): all new behaviour is gated behind the presence of the `coordination` state
object.

## Strategy

The dependency spine is `lib/github-coord.mjs` — a pure module (no fs, no network)
exporting the ten §7.3 signatures. Everything else imports it, so it lands first and
alone (wave 0). The consumers that touch disjoint files then fan out (wave 1). The
`mp` subcommands depend on the `coordination` state object being persistable, so they
land after `lib/bundle.mjs` (wave 2). The shell prompt + its verb-sync land last as
one task (wave 3) — see the verb-sync coupling note below.

CD invariants honoured: `lib/github-coord.mjs` is pure; `bin/masterplan.mjs` stays
fs-only (all git/gh side effects live in the shell); the shell is the sole durable
writer. No task runs git, commits, or writes `state.yml`.

### Verb-sync coupling (why the prompt + hygiene test are ONE task)

`lib/hygiene.mjs:parseReservedVerbs` reads the `` Reserved verbs: `…` `` line out of
`commands/masterplan.md`, and `test/publish-hygiene.test.mjs:146` asserts that parsed
list `deepEqual`s a **hardcoded** 14-verb array. The instant the prompt's reserved-verb
line gains `publish`/`follow`, the parser returns 16 verbs and that assertion breaks.
So the prompt edit and the test-array edit are **edit-coupled**: split across waves,
the suite would be red between them and the prompt task's (grep-only) verify would not
catch it. Task 7 therefore owns `commands/masterplan.md` + `README.md` + `docs/verbs.md`
+ `test/publish-hygiene.test.mjs` together and runs the **full suite** as its own proof.
(There is **no** `RESERVED_VERBS` constant in `lib/hygiene.mjs`, and `docs/internals.md`
has no verb routing table — spec §11 fact-check; CLAUDE.md anti-pattern #4 overstates the
surface. We plan to the actual files.)

## Waves

### Wave 0 — Pure foundation
- **Task 1** — `lib/github-coord.mjs` + `test/github-coord.test.mjs`. The ten §7.3
  functions, pure (serialization format + label-state-machine edges are design
  choices). Acceptance A1, A2 (round-trip), A3 (claim validation), A4 (disjoint-file /
  wave-order selection), A6 (reconcile idempotence). Everything downstream imports this.
  Routed `codex: "no"` — 10 functions with state-machine + idempotence semantics is the
  design-heavy core, not mechanical.

### Wave 1 — Consumers (disjoint files)
- **Task 2** — `lib/paths.mjs` ephemeral out-of-tree bundle-path helper +
  `test/paths.test.mjs`. `MASTERPLAN_RUNS_DIR` already drives
  `resolveBundleDir`/`resolveStatePath`, so this adds the ephemeral resolver only.
- **Task 3** — `lib/bundle.mjs` `coordination` state object (read/write round-trip) +
  `test/bundle.test.mjs`. Acceptance A5 (write → read → deep-equal). Persists the §6
  schema; single-agent path unchanged when the object is absent (A9).
- **Task 4** — `lib/resume.mjs` `publish_needed` / `coordinate` branches in
  `decideNextAction` + `test/resume.test.mjs`. Acceptance A7 (ordering), A9 (uncoordinated
  decisions byte-identical).
- **Task 5** — Doctor `coord-drift` check: new `lib/doctor/coord-drift.mjs`, wired into
  `bin/doctor.mjs`, plus `test/doctor.test.mjs` (the explicit `expected[]` array MUST go
  11 → 12 AND a fixture dir added — one edit-coupling, all in this task). The check
  returns **SKIP** when no coordinated bundle exists so `node bin/doctor.mjs` stays
  exit-0 on the live repo (verify-command safety). Acceptance A8.

  *All four wave-1 tasks touch strictly disjoint files (each lib paired with its own
  test; the doctor task owns the only edits to `bin/doctor.mjs`).*

### Wave 2 — `mp` surfaces
- **Task 6** — `bin/masterplan.mjs` six fs-only subcommands (`gh-issue-body`,
  `parse-issue`, `validate-claim`, `select-claimable`, `reconcile-integration`,
  `coord-status`) + `test/bin-masterplan.test.mjs`. They wrap the pure logic (Task 1)
  and read/write the `coordination` object (Task 3) — hence wave 2. Acceptance A2, A3,
  A4, A6 at the CLI boundary. Stays fs-only: no git, no gh (shell supplies gh JSON).

### Wave 3 — Shell sequencing + verb-sync (one task)
- **Task 7** — `commands/masterplan.md` (publish/follow verb bodies, §7.1 gh/git
  sequencing incl. ref+branch provisioning, §7.2 per-PR integration-merge loop with
  re-check + diff-scope guard + conflict-abort, frontmatter `description:`, §1
  reserved-verbs + arg-precedence, §3 routing table) **plus** `README.md`, `docs/verbs.md`,
  and the `RESERVED_VERBS` deepEqual array in `test/publish-hygiene.test.mjs` — coupled
  for the reason above. All git/gh side effects live here. Verified by
  `node --test test/publish-hygiene.test.mjs`, a grep that the verbs reached the prompt,
  the **full suite**, and `node bin/doctor.mjs` (A9, A10).

## Final integration gate
Task 7's `verify_commands` run the **full suite** (`node --test test/*.test.mjs`) and
`node bin/doctor.mjs` to prove the whole change set integrates and the single-agent path
is unbroken (A9). This is the last wave, so its full-suite pass is the run-wide gate.

## Out of scope
`agents/*` (the path-agnostic `mp-implementer` is reused unmodified by launching in the
ephemeral bundle cwd); the automated stale-claim reaper / auto-TTL (§13); cross-machine
heartbeat / multi-lead lease (§13); the manual integration smoke (§12 — a human CD-3
acceptance gate, not a plan task). The optional `CLAUDE.md` anti-pattern #4 wording fix
(§11) is left to the orchestrator's discretion at finish; it is not a verifiable build
task.
