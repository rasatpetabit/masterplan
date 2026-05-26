# Retro: cc3-visibility

**Slug:** cc3-visibility
**Completed:** 2026-05-26
**Complexity:** high
**Autonomy:** loose
**Version released:** v6.4.0

---

## What we built

Wired CC-3 from a documented contract into a runtime-enforceable system. Three
gaps closed:

1. **Summary-block emit (CC-3 step 1).** Added `subagents_this_turn` (list) +
   `subagents_this_step` (counter) dual-structure tracking in
   `parts/contracts/agent-dispatch.md`, scaffolded reset/append rules, and made
   the Stop-hook scanner consume four canonical marker literals
   (`subagent_dispatched`, `breadcrumb_emitted`, `summary_block_emitted`,
   `auq_render`) emitted via `<masterplan-trace event=... ...>` tags.
2. **Breadcrumb-at-AUQ enforcement (CC-3 step 3).** Patched every AUQ
   close-site in `parts/step-b.md` to emit the breadcrumb line before the
   `AskUserQuestion` Closer, so the navigation line survives manual
   interruption.
3. **Codex review findings surfaced inline.** New contract at
   `parts/contracts/codex-review.md` defines a structured JSON return shape
   (`{verdict, dimensions, findings[], summary}`) for B2/B3/C4b adversarial
   reviews, with a degraded-parse regex fallback (D23) and a Codex-host
   fallback table (D13/D20) when running inside Codex itself.

Plus two new doctor checks audit runtime CC-3 compliance:

- **Check #51** — CC-3 breadcrumb-at-AUQ ratio across the recent window,
  cached to `state.yml.cached_compliance.breadcrumb_ratio`.
- **Check #52** — CC-3 summary-block ratio, with a HIGH-3 sub-fire for
  model-attribution drift via `turn_id` join against `subagents.jsonl`.

And a state.yml schema bump (3 → "5.1", string tuple-compare per D24) with a
new `cached_compliance` field (4 sub-fields: `breadcrumb_ratio`,
`summary_block_ratio`, `window_turns`, `last_audit_ts`).

**Files changed (16 across 4 waves):**

- Wave 1 (primitives): `parts/contracts/agent-dispatch.md`,
  `parts/contracts/codex-review.md` (new), `hooks/masterplan-telemetry.sh`,
  `commands/masterplan.md`
- Wave 2 (call-site wiring): `parts/step-b.md`,
  `parts/step-c-verification.md`, `parts/contracts/agent-dispatch.md`
- Wave 3 (doctor + tests): `parts/doctor.md`, 5 fixtures, 5 pytest cases
- Wave 4 (release prep): `parts/step-0.md` (CC-2.4 boot indicator),
  `bin/masterplan-state.sh` (bootstrap schema_v5.1), `README.md`,
  `docs/verbs.md`, `CHANGELOG.md`, all three plugin manifests bumped to 6.4.0

---

## What went well

- **Wave parallelism delivered as designed.** Wave 1 (4 primitive tasks)
  and Wave 3 (2 doctor checks + fixtures) ran cleanly with independent
  files. Wave 2 had a sequential dependency on Wave 1's marker grammar,
  but inside Wave 2 the three call-site patches landed in parallel.
- **D22 self-migration canary worked.** The cc3-visibility bundle migrated
  itself first (W3-T5: schema_version `3` → `"5.1"`, added the
  `cached_compliance` stub, retained `.bak.pre-v5_1-migration`) before
  the migration code shipped to other bundles. This validated the D24
  string-tuple-compare end-to-end against a real bundle, not just a fixture.
- **Fresh-eyes audit caught 3 real issues that wave-by-wave gates missed.**
  Post-Wave-4 grep audit (per CLAUDE.md anti-pattern #5) surfaced:
  doctor.md using non-canonical field names that would have broken the
  CC-2.4 boot indicator, CHANGELOG.md listing a marker literal that was
  never implemented, and a section-anchor heading rendered inside a fence
  block so the cross-reference from `parts/step-c-verification.md:115`
  pointed nowhere. All three fixed in commit `22789fe`.

## Issues encountered

- **Explore subagent confabulated reads twice.** First dispatch refused
  tool use citing a stale "TEXT ONLY" directive from a prior session;
  second dispatch (with an explicit tool-use authorization preamble) still
  produced fabricated "findings" without actually reading files —
  subagents have no session history, so this was hallucination, not
  leakage. Abandoned the subagent path and ran the audit inline with
  concrete `grep` greps. The inline audit produced the 3 real findings
  above; the subagent path produced zero verifiable findings.
- **CHANGELOG marker-literal list drifted from the implementation.** The
  CHANGELOG was written from the spec's original 4-literal list
  (which included `subagent_returned`) before the implementation
  decision to use `auq_render` instead landed. The plan-vs-implementation
  drift was invisible until the fresh-eyes audit grepped both sides.
- **Section anchor inside a fenced block.** The `### Return JSON shape`
  heading in `parts/contracts/codex-review.md` was added inside the outer
  dispatch-brief ``` fence, so it rendered as literal text and the
  cross-reference `§Return JSON shape` from
  `parts/step-c-verification.md:115` resolved to nothing. Fix: closed the
  outer fence, made the heading real markdown, properly enclosed the
  JSON example in its own ```json block.

---

## What to watch

- **Check #51 and #52 will fire WARN/ERROR against pre-v6.4.0 bundles** on
  next `/masterplan doctor` run unless those bundles migrate to
  `schema_version: "5.1"` and accumulate at least one window's worth of
  compliance data. The check explicitly skips legacy bundles
  (`schema_version < "5.1"`) per D24 string-tuple-compare, so this is
  graceful — but expect the first real run to surface the migration
  question for active long-running bundles.
- **D23 regex fallback may surface false-positive FAIL verdicts.** When a
  Codex review returns malformed JSON, the regex secondary check looks
  for `critical|fatal|serious|blocking|fundamental|wrong assumption` to
  decide between WARN and FAIL. Real reviews sometimes use these words
  in non-blocking context ("not critical, but..."); first real degraded-
  parse case may need the regex tightened.
- **Model-attribution drift detection (HIGH-3) is opt-in via `turn_id`.**
  The `subagents.jsonl` row now carries `turn_id`, but only Stop-hook v2+
  emits it. Bundles using older hooks won't trigger the drift sub-fire;
  Check #52 will degrade silently to ratio-only mode. Doctor #36 covers
  the static presence of the hook version; runtime detection lives in
  Check #52's count-divergence path.

---

*Auto-generated by masterplan Step C completion retro (v6.4.0)*
