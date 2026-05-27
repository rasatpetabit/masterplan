VERDICT: confirmed

## Corrected ratio vs raw claim

- **Raw claim:** 3 banners vs 318 "trace fires" — implying ~99% under-emission.
- **Corrected denominator:** 9 banners emitted vs **24 true invocations** = **15 missing banners (62.5% under-emission)**.

The raw ratio was wildly inflated: the "318" figure conflates every JSONL line that contains the string `/masterplan` (grep of the raw file), including skill-listing attachments, hook_success payloads, state.yml file injections, CLAUDE.md content, and intra-turn tool-result echoes — none of which are invocations. The 9 banner emissions are accurate; only the denominator was wrong.

## Reclassification table

| Category | Count | Banners emitted | Compliance |
|---|---|---|---|
| fresh-invocation (new topic / explicit user command) | 6 | 6 | 100% |
| compaction-resume (invoked_skills re-fires after context compaction or ctrl+O compact) | 18 | 3 | 17% |
| bare-resume (standalone `--resume` without skill re-injection) | 0 | — | — |
| status/next subroutine (counted inside above; no distinct category) | 0 | — | — |
| doc-reference / non-invocation (CLAUDE.md, hook outputs, state.yml content, raw grep hits) | ~1146+ | — | N/A |
| **Total real invocations** | **24** | **9** | **37.5%** |

The "status/next" sub-category is fully absorbed into the compaction-resume bucket (5 of the 18 compaction-resume turns used the `next` verb).

## Representative miss: line 575 (JSONL offset)

JSONL line **575** — `invoked_skills` attachment carrying `<!-- masterplan-shim: v4 --> /masterplan:masterplan execute docs/masterplan/openxcvr-refactor/state.yml` — fires as a compaction-resume after a context-window rollover (preceding user turn at line 569 begins with "This session is being continued from a previous conversation…"). The next assistant text appears at line **602** and reads *"All 4 fixes are unstaged. Let me commit them cleanly…"* — zero banner, zero Read of `plugin.json`. CC-2 Step 1 (mandatory Read) and Step 2 (emit sentinel) were both skipped.

## Reasoning

F1 is **confirmed**, but the operative failure mode is more specific than the raw audit suggested. The model achieves perfect CC-2 compliance (100%) on fresh, user-typed invocations where the skill body is injected cold into a new conversation context — it consistently reads `plugin.json` and emits the sentinel before anything else. The failure is concentrated entirely in **compaction-resume** turns, where the harness re-injects the skill via `invoked_skills` attachment after a context rollover or ctrl+O compact. In those turns, 15 of 18 (83%) skip the banner entirely, jumping straight to in-progress task execution. CC-2 step-0.md line 38 is explicit that the sentinel is "unconditional" and explicitly calls out compaction-aware re-invocation as the exact scenario the banner exists to guard against ("a missing sentinel line signals the harness ate the invocation"). The under-emission is real, concentrated, and reproducible.

RESOLUTION: fix-applied
