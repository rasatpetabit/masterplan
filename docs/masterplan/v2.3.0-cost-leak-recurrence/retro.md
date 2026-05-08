# v2.3.0 Cost Leak Recurrence Prevention — Retrospective

**Slug:** v2.3.0-cost-leak-recurrence
**Started:** 2026-05-04 (v2.3.0 release, SHA a9b79bb)
**Completed:** 2026-05-05 (v2.4.1 release, SHA 4279eec; v2.8.0 extended the layer, SHA ec42e39)
**Branch:** main (direct-to-main shipping)
**PR:** none

---

## Outcomes

- **Model-dispatch contract enforced structurally (v2.3.0, a9b79bb).** All 14 inline dispatch sites in `commands/masterplan.md` now carry explicit `model:` parameters. Previously they were prose-only suggestions; subagents silently inherited the orchestrator's Opus 4.7 context, producing the documented $458-of-$487 session cost at petabit-os-mgmt.
- **Per-subagent telemetry layer (v2.3.0, a9b79bb).** Stop hook captures one JSONL record per Agent dispatch to `<plan>-subagents.jsonl`, including `model`, `dispatch_site`, and full token breakdown. The `opus_share` health metric (healthy `< 0.1`, regression `> 0.3`) makes passthrough leakage visible at end-of-turn instead of requiring manual transcript forensics.
- **Codex routing observability + silent-skip prevention (v2.4.0, c3429dc).** Doctor checks #20 and #21 surface the silent-skip failure mode from two angles (missing cache file / missing activity-log evidence). Step C step 1 now emits a mandatory `eligibility cache:` evidence entry per invocation. Step C step 3a halts instead of silently falling through to inline when the cache is missing. Pre-dispatch `routing→CODEX` / `routing→INLINE` banners added.
- **`/masterplan stats` verb (v2.4.0, c3429dc).** Codex-vs-inline routing distribution accessible in one tap; smoke on optoe-ng correctly flagged `silent-skips=5`.

---

## Timeline

- **2026-05-04 11:30 — v2.3.0** (SHA a9b79bb): Model-dispatch contract + per-subagent telemetry. Triggered by a concrete cost event: 94% Opus ($458/$487) across a 2-day session. Bundled two threads — structural fix to dispatch sites and the telemetry layer to make future recurrences detectable.
- **2026-05-04 12:29 — v2.3.1** (SHA 669f69a): Telemetry sidecar files protected from accidental commits; bare `/masterplan` made resume-first. Adjacent hardening, not prevention-layer changes.
- **2026-05-04 18:33 — v2.4.0** (SHA c3429dc): Codex routing observability and silent-skip prevention (Fixes P1–P5). Doctor checks #20 and #21 added. `/masterplan stats` verb. Step C step 3a precondition halt. `unavailable_policy` config key.
- **2026-05-05 12:30 — v2.4.1** (SHA 4279eec): Competing-scheduler check. Not a cost-leak item; closes adjacent footgun around externally-created crons targeting the same plan.
- **2026-05-05 21:39 — v2.8.0** (SHA ec42e39): Doctor check #23 (model-passthrough leakage detection, `commands/masterplan.md:1514`). Extends the prevention layer with telemetry-driven post-mortem detection: scans `<slug>-subagents.jsonl` for SDD/wave/Step-C-step-1 dispatches running on Opus. Ping-based codex availability detection replaces fragile string-scan. Eligibility cache schema versioning.

---

## What went well

- **Structural fix confirmed in the wild (v2.3.0, a9b79bb).** The second-recurrence plan documents a downstream petabit-os-mgmt installation at v2.2.x: 6 agent dispatches, all to `codex:codex-rescue` (out-of-process), zero Haiku/Sonnet implementers — the Sonnet leg was simply never on the menu. The mandatory `model:` requirement at all 14 dispatch sites closes exactly that gap.
- **Dual-angle doctor design (v2.4.0, c3429dc).** Checks #20 and #21 fire together: #20 catches the missing cache-file footprint, #21 catches the missing activity-log footprint. The optoe-ng project-review plan exhibited both — zero `eligibility cache:` entries across an entire plan's lifetime — making the silent-skip failure unmissable at lint time.
- **Evidence-of-attempt mandate is structurally unforgeable (v2.4.0, c3429dc).** Step C step 1 must emit `eligibility cache: <verdict>` per invocation including the `codex_routing == off` skip. Doctor check #21 (`commands/masterplan.md:1512`) surfaces absence as a Warning.
- **Smoke on real failure data before shipping (v2.4.0).** Stats ran against optoe-ng (5 `silent-skips` flagged) and petabit-os-mgmt (31/32 codex/inline split, 49.2% codex) before tagging. WORKLOG confirms three output formats validated.
- **Doctor check #23 extended detection post-hoc (v2.8.0, SHA 7608d38).** Scans `<slug>-subagents.jsonl` for SDD/wave/Step-C-step-1 dispatches running on Opus (`commands/masterplan.md:1514`). Catches contract violations that slip through at runtime — SDD upstream drift, new dispatch sites added without `model:` params.

---

## What blocked

No blockers in the conventional sense — postmortem-driven work with clear scope at each release boundary. Reconstruction limitation: the v2.8.0 hardening (check #23, ping-based detection) falls outside this plan's nominal scope; those decisions live in the WORKLOG and CHANGELOG, not in the plan file.

Post-v2.4.1 signal that the prevention was incomplete: the v2.8.0 audit found Step 0's codex availability detection was a fragile string-scan and the eligibility cache lacked schema versioning — a stale cache could silently consume routing decisions under changed eligibility rules. Both were closed in v2.8.0 (SHAs 8ed9384, 9cd135c). The v2.3.0–v2.4.1 layer addressed model-passthrough and silent-skip; availability-detection and cache-integrity required another cycle.

---

## Deviations from spec

The plan file is a 4KB informational retrospective document for a second observed recurrence, not a forward-looking spec. It describes an already-shipped fix set and recommends two optional README additions (explicit post-v2.2.x version requirement notice; a post-install sanity check on `opus_share`). Neither recommendation appears in any v2.3.x–v2.4.x CHANGELOG entry. The README was updated in v2.3.1 (install docs, Claude Desktop path), but not with the specific "install ≥ v2.3.0" one-liner suggested in the plan. This plan served as dogfooding evidence documentation rather than a driver of new implementation.

---

## Codex routing observations

This plan is about routing prevention, not a plan that used codex routing during execution. No routing tally is possible. The plan cites concrete data from downstream sessions: petabit-os-mgmt pre-fix showed `opus_share = 1.0` (756 messages, 885K output tokens, zero Haiku/Sonnet). Post-fix smoke showed 31/32 codex/inline split (49.2% codex routing).

Doctor checks targeting the failure modes:
- **#18** (`commands/masterplan.md:1509`): Codex config on but plugin missing — lint-time persistent-misconfiguration warning.
- **#20** (`commands/masterplan.md:1511`): Codex routing configured but eligibility cache file missing.
- **#21** (`commands/masterplan.md:1512`): Step C step 1 cache-build evidence missing from activity log. Fires together with #20 on the optoe-ng pattern.
- **#23** (`commands/masterplan.md:1514`, v2.8.0): Opus on bounded-mechanical dispatch sites — telemetry-driven post-mortem detection.

---

## Follow-ups

- [ ] **README one-liner** — "install ≥ v2.3.0; older versions silently route everything to the orchestrator's parent model" near the install instructions — never shipped per CHANGELOG. Low urgency since plugin install enforces the version. Not a `/schedule` candidate.
- [ ] **Post-install `opus_share` guard** — plan suggested warning if `opus_share > 0.5` after first kickoff — not shipped. The `/masterplan stats` verb partially covers this for users who run it deliberately. Not a `/schedule` candidate; low priority.
- [ ] **`--watch` flag for stats script** — noted in WORKLOG as a future enhancement for live tail during long `/masterplan` loops. Open.

---

## Lessons / pattern notes

- **Cost failures are invisible during the run.** Tasks complete, commits land, status files update — while burning 5–10× the design cost. The only signal before v2.3.0 was the bill or a deliberate 50-line Python one-liner against raw JSONL. End-of-turn telemetry and lint-time doctor checks are load-bearing for this failure class, not nice-to-have.
- **Postmortem-driven prevention is the recurring pattern.** v2.3.0 followed a $458 cost event. v2.8.0 check #23 followed an audit revealing the v2.3.0 contract could drift at the SDD layer. v2.9.0 check #25 followed session-level deployment drift. Each cycle: failure observed → failure mode formalized → check added → contract extended. Budget one hardening cycle after each new dispatch site or routing surface.
- **Dual-angle detection is more robust.** Checks #20 and #21 fire together by design: each catches a distinct artifact of the same failure (cache-file footprint vs. activity-log footprint). Worth preserving this pattern on future check pairs.
- **Downstream installations stay on old versions invisibly.** A second confirmed recurrence at a downstream v2.2.x installation showed no visible symptoms. Check #25 (v2.9.0) and `opus_share` telemetry together provide a post-install detection path, but only for users who actively run them.
