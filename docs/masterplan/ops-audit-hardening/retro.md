# Retro — masterplan operational hardening (ops-audit-hardening)

**Run:** ops-audit-hardening · **Completed:** 2026-05-27 · **Version shipped:** v7.2.0
**Posture:** repro-first · **Autonomy:** loose · **Complexity:** high

## What this run did

Audited ~12 hours of Claude Code transcripts for `/masterplan` operational
issues. Four findings (F1–F4) entered scope under a repro-first posture: repro
task produces a verdict, fix task branches on it.

| ID | Finding | Verdict | Resolution |
|----|---------|---------|------------|
| F1 | Boot-banner under-emission | **confirmed** | fix-applied |
| F2 | Gate re-entrance | **refuted** | docs-only |
| F3 | Context-budget discipline Codex-only | (behavioral) | generalized |
| F4 | No fd/ulimit preflight | (environmental) | preflight added |

## Outcomes

- **F1 (confirmed, fixed).** The raw 3/318 ratio was an artifact of grepping
  every line containing `/masterplan`. True denominator: 9 banners / 24 real
  invocations. The miss is concentrated *entirely* in compaction-resume /
  `invoked_skills` re-injection turns (83% miss) — fresh invocations are 100%
  compliant. Fix scoped the CC-2 salience raise to the re-injection path
  (`parts/step-0.md`, `commands/masterplan.md`) and added runtime doctor
  Check #53 that excludes fresh invocations from the denominator.
- **F2 (refuted).** 30 raw `gate=fire` matches collapse to 6 real fires, all
  distinct legitimate gates. The 3 `spec_approval` re-fires are *designed*
  resume-controller re-renders after free-text / "Request changes" responses,
  both of which preserve `pending_gate` by contract. The planned idempotency
  guard would have converted a working feature into a dropped-gate bug — so no
  source change. This is the repro-first posture working as intended: the repro
  prevented a harmful "fix."
- **F3 (generalized).** Lifted the summary-first inventory + ≤2 large-read
  budget out of the Codex-host-only section into a host-agnostic
  Context-control discipline in `parts/step-0.md`; codex-host.md retained as the
  host-specific hard-stop extension via cross-reference.
- **F4 (preflight added).** Always-runs fd preflight before the bootstrap file
  storm: `ulimit -n < 1024` aborts early with remediation, `unlimited`
  proceeds, an unresolvable probe warns and continues.

## What worked

- **Repro-first paid off twice.** F1's corrected denominator changed the *fix*
  (scope to the resume path, not a blanket raise). F2's repro refuted the
  premise and blocked a regression.
- **Raw-count skepticism.** Both F1 and F2 raw signals were inflated by the
  orchestrator prompt body appearing as user-role context lines. Always
  separate "string match" from "real event" before sizing a problem.

## Lessons / follow-ups

- **Cross-manifest version drift is easy to miss.** The T7 implementer brief
  omitted `.claude-plugin/marketplace.json` (two version fields); the
  cross-manifest sanity check caught it. Doctor Check #30 exists precisely for
  this — the brief should enumerate *all four* version locations next time.
- **Forward-wired telemetry.** Check #53 reads `invoked_skills_reinjection`,
  `compaction_recent`, and `cc2_banner_emitted` events that the Stop hook does
  not yet emit. Until `hooks/masterplan-telemetry.sh` writes them, #53 will
  SKIP (no compaction-resume evidence). **Follow-up:** wire those three events
  into the telemetry hook so #53 has data to audit.
- **Version-stamp guess.** The implementer stamped Check #53 as `v6.4.1` by
  pattern-matching the prior check's version rather than the live plugin
  version (7.x). Sync tasks should hand the implementer the target version
  string explicitly.
- **T7 "run doctor end-to-end" verify was partial.** The cross-manifest
  version-drift sanity check (Check #30 surface) and `bash -n` on changed
  snippets were run and passed. The full `/masterplan doctor` verb was *not*
  executed — it requires a recursive orchestrator invocation that the
  local-static verification ceiling for this run did not cover. Check #53's
  own runtime audit is dormant regardless (forward-wired, SKIPs). Net: static
  correctness is verified; a full doctor sweep is deferred to the next run that
  legitimately invokes the verb.
