# Plan — dispatch-subagent-reconcile

Serial debt-cleanup plan. One foundation wave (code + tests), then host resync + verification.
Same-wave tasks are file-disjoint. Spec-gate and plan-gate adversary findings (P1/P2) are folded
into T1–T2.

## Wave 0 — Map, agents, tests (atomic)

These three files are one logical change: the live-alias contract must hold in the map, the agent
prose, and the unit tests together. Ship in one wave so a half-applied map cannot green the suite.

- **T1 — Strict live-alias MODEL_MAP** (`bin/register-pi-agents.mjs`, `test/register-pi-agents.test.mjs`).
  Set `MODEL_MAP = { fable: 'litellm/fable-5' }`. Update header comments that still claim
  “opus and fable are the only models…”. Rewrite tests to fable fixtures; assert **bidirectional
  equality**: `MODEL_MAP` keys **==** the set of `model:` aliases from non-skipped `agents/mp-*.md`
  (not one-direction ⊆). Keep an explicit **fail-closed negative fixture** (unsupported alias
  throws via `mapModelLine` / register) so pruning `opus` cannot become a silent passthrough
  (spec-gate P2). **Additionally assert every canonical `agents/mp-*.md` frontmatter `model:` is
  `fable` (including `mp-implementer`, which is SKIP_FOR_PI and would otherwise evade the
  map-equality check — plan-gate P2).** **Retain existing coverage** for colon-alias naming,
  `SKIP_FOR_PI` membership, and drift-detection (`--check` / runRegister check mode) so a test
  rewrite cannot green while dropping those behaviors (plan-gate P2). Document in the test header
  that the script’s complete input set is only `agents/mp-*.md` filtered by `SKIP_FOR_PI`
  (spec-gate P1). Goals: G2, G3.

- **T2 — Explorer prose consistency** (`agents/mp-explorer.md`). Replace “Runs on haiku…” with
  accurate thin-wrapper language: cheap read-only recon on the checked-in `fable` default; no
  invented haiku pin; no false model_group judgment claim. Verify with a **case-insensitive**
  forbidden-model check (haiku/opus/sonnet as wrapper claims) **and** a positive assertion that
  the body describes the fable wrapper default (plan-gate P2). Goals: G1.

## Wave 1 — Host resync + scope check

- **T3 — Pi host resync + verify** (host-local `~/.pi/agent/agents/`; no repo files required
  beyond re-running the script). Run `node bin/register-pi-agents.mjs` (write), then
  `--check` → exit 0 / 0 drift. Spot-check installed bare copies show `model: litellm/fable-5`.
  Confirm git diff for the run stays inside T1–T2 paths (plus run-bundle artifacts) — G5.
  Goals: G4, G5.

## Notes

- **Non-goals** (fabric default, dual-registration redesign, doctor/CI, workflow/doc scrub,
  agent-dispatch policy) are out of scope; do not expand tasks to cover them.
- **mp-implementer** remains in `SKIP_FOR_PI` — unchanged.
- **Serial only** — no parallel subsystem split; three tasks, two waves.

## Gate-review findings (advisory, folded)

### Spec gate (`rv-mreyf7my`, approve, 0 blocking)

1. P1 → T1 test header documents complete input set (`agents/mp-*.md` − SKIP_FOR_PI).
2. P2 bidirectional equality → T1 test assertion.
3. P2 fail-closed negative fixture → T1 test.

### Plan gate (`rv-mreyi2i5`, approve, 0 blocking — re-run after this fold)

1. P2 mp-implementer evasion → T1 asserts all canonical frontmatters are `fable`.
2. P2 weak T2 verify → case-insensitive forbidden models + positive fable wording.
3. P2 retained coverage → T1 keeps colon-alias / SKIP_FOR_PI / drift-detection tests.

### Plan gate re-run residual (folded into index verify)

4. P2 positive fable wording must check **body only** (not frontmatter) — T2 verify_commands.
5. P2 SKIP_FOR_PI: assert generated/checked targets **exclude** both `mp-implementer` and `masterplan:mp-implementer` — T1.
