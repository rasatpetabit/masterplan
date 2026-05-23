# Retrospective: Improve Subagents Parallelism

**Bundle**: improve-subagents-parallelism  
**Completed**: 2026-05-22  
**Status**: complete  

---

## What Shipped

Three implementation commits, one state commit, on `worktree-improve-subagents-parallelism` branch:

| Commit | Change |
|---|---|
| `f36ce0d` | C3: cap adversarial-review companion stdout+stderr at 8192 chars in `step-b.md`; C1: add `(≤ 100 items)` to coordinator-plan-parser tasks[] in `step-c-dispatch.md` |
| `d8ff44b` | Doctor checks #46 (CC-2 self-enforcement) and #47 (return-shape caps); update low/medium/high check sets |
| `05e1b30` | CC-2 wording in `coordinator-pattern.md` + `wave-dispatch.md`; fix stale `step-c.md` scan in self-host audit (also fixed `check_dispatch_sites()`) |

---

## Plan vs. Reality

### Wave 1 (Audit) — mostly null results

The three parallel Haiku audit agents ran as designed. Dimension C returned exactly the 2 expected violations (C3 + C1). Dimensions A and B were surprising:

**Dimension A (CC-2 inline reads):** Haiku returned 18 hits, but every hit was either a structural state-read (state.yml, eligibility cache) inside an existing coordinator block, or a mandatory boot-sequence read (plugin.json banner). The v6.0.0 coordinator pattern already covered the major CC-2 violations; no new Haiku gates were added.

**Dimension B (parallel-group candidates):** `[]`. The spec forecast `parallel-group: pre-exec-checks` for step-c-verification.md, but the Haiku found every consecutive dispatch pair was output-dependent (parser feeds assembly, verification feeds Codex review gate). No parallel-group annotations added.

### Wave 2 (Fix pass) — two fixes, one commit vs. three

Spec planned three dimension-specific commits. With Dimension A/B returning no actionable hits, one commit covered all Dimension C fixes (C3 + C1 together). Less churn.

### Self-host audit fix — scope expanded in place

The plan specified fixing only `_brief_style_scan_file` in `check_brief_style()`. During verification, `check_dispatch_sites()` also had a stale `step-c.md` reference (would WARN on every run since `step-c.md` no longer exists after the v6.0.0 split). Fixed in the same commit. Also updated the v5.8.0+ comment at line 854.

### Codex dispatch — not used

Plan marked all tasks `Codex: false`. Inline Sonnet/Haiku execution throughout.

### Dimension C re-dispatch

The first Dimension C Haiku agent returned a confused response (referenced "background agents" and tool-use constraints from an unrelated session). Re-dispatched with a clean brief; second run returned correct results.

---

## Outcomes

**Addressed:**
- Adversarial-review companion output (C3): was unbounded stdout+stderr → now capped at 8192 chars. Directly reduces context growth on every plan that runs spec or plan gate adversarial review.
- coordinator-plan-parser tasks[] (C1): was unbounded array → now capped at 100 items. Prevents 50-task plan from landing 50-element JSON verbatim into orchestrator context.
- Doctor checks #46/#47: CC-2 and return-shape cap violations are now lint-detectable at doctor-run time. Persistent enforcement going forward.
- Self-host audit stale reference: `--brief-style` mode now scans the correct 4 sub-files instead of the missing monolith.

**Not addressed (as expected):**
- No new CC-2 Haiku gates in step-c sub-files (Dimension A: all hits were inside coordinator blocks or structural reads).
- No new parallel-group annotations (Dimension B: all dispatch pairs were output-dependent).
- Slice β/γ (parallel committing tasks) — deferred per original scope.
- Guard D owner sentinel — deferred per concurrency-guards spec.

---

## Lessons Learned

1. **v6.0.0 coordinator coverage was more complete than anticipated.** The 5 coordinator dispatch sites absorbed the heavy CC-2 targets. The audit found mostly structural reads that are CC-2-exempt by nature. Future audits can narrow scope to non-coordinator paths.

2. **Dimension A Haiku over-reports on structural reads.** The audit brief didn't distinguish coordinator-gated reads from truly unguarded reads. A tighter brief (exclude reads inside DISPATCH-SITE blocks) would reduce noise.

3. **Two confirmed spec fixes + new doctor checks is the right minimum.** Shipping only what the audit validated (2 fixes) over shipping speculative fixes kept the diff small and the commits reviewable.

4. **Self-host audit had a hidden correctness bug.** `check_dispatch_sites()` would WARN silently on every run after the v6.0.0 split. Not surfaced by the plan spec, caught during verification. Worth running `--brief-style` as part of any post-split migration check.
