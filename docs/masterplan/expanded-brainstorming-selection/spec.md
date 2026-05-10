# Brainstorm Intent Anchor

## Summary

The prior `expanded-brainstorming-selection` direction tried to solve broad brainstorming by adding more idea pages and multi-select selection mechanics. Transcript review showed a more basic failure: Step B1 accepts a raw topic, invokes `superpowers:brainstorming`, and lets audit-shaped or deferred-task prompts become unconstrained creative planning before repo ownership is established.

This spec replaces the multi-select idea funnel as the primary fix. Step B1 now creates a durable `brainstorm_anchor` before invoking the brainstorming skill. The anchor records user intent, repo role, in-scope paths, out-of-scope sibling repos, evidence, and verification ceiling. The brainstorming brief must use that anchor and the resulting spec must include an `Intent Anchor` / `Scope Boundary` section.

## Intent Anchor

- Mode: implementation-design.
- Repo role: masterplan orchestrator plugin.
- In scope: `commands/masterplan.md`, `docs/internals.md`, `README.md`, `CHANGELOG.md`, `bin/masterplan-self-host-audit.sh`, and this run bundle.
- Out of scope: replacing the upstream `superpowers:brainstorming` skill, native multi-select UI dependencies, or a broad idea-management redesign.
- Evidence:
  - `commands/masterplan.md`: Step B1 previously invoked brainstorming with only the topic before writing a spec.
  - `docs/masterplan/expanded-brainstorming-selection/events.jsonl`: prior direction stalled around bundle and individual idea selection gates.
  - meta-petabit transcripts: broad Yocto audit prompts crossed repo boundaries and turned deferred tasks into feature-like planning.
- Verification ceiling: local-static. This repo has no compile pipeline; validation is prompt diff review, self-host audits, JSON parsing, and fixture dry-runs.

## Scope Boundary

Step B1 may inspect cheap local truth to classify intent, but it must remain a thin orchestrator. It should not deeply analyze source code, perform the audit itself, or duplicate the upstream brainstorming skill's design-writing work. The orchestrator only prepares the brief, persists state, and gates unsafe ambiguity.

For Yocto layer repos, the anchor must preserve ownership boundaries:

- Distro/image policy belongs to a policy layer such as `meta-petabit`.
- BSP/machine, kernel, U-Boot, and WIC work belongs to BSP repos.
- App recipes and defaults belong to app-layer repos.
- Kas composition belongs to composition repos.
- Builder orchestration belongs to builder repos.

## Behavior

Before invoking `superpowers:brainstorming`, Step B1:

1. Updates `state.yml` to `phase: brainstorming` and appends `brainstorm_started`.
2. Reads bounded local truth: repo guidance, worklog, recent masterplan bundles, and obvious file layout.
3. Classifies mode as `feature-ideas`, `implementation-design`, `audit-review`, `deferred-task`, `execution-resume`, or `unclear`.
4. Classifies repo role and Yocto ownership when applicable.
5. Persists `brainstorm_anchor` and appends `brainstorm_anchor_resolved`.
6. Surfaces structured `AskUserQuestion` gates only for ambiguity that would otherwise cause drift.
7. Invokes brainstorming with the anchor and requires the spec to include an `Intent Anchor` / `Scope Boundary`.

## Gates

- Audit/review ambiguity: choose fix-as-you-go, report-only, narrow deferred task, or abort.
- Cross-repo ownership: stay current repo, split sibling follow-up runs, or abort.
- Deferred task: reuse prior plan/worklog evidence and avoid broad idea questions.
- Unclear: ask one foundational question only when the wrong default is unsafe.

## Regression Fixtures

The fixtures in `regressions.json` cover four transcript-derived prompts:

- `meta-petabit-yocto-config-review`: broad Yocto review should classify as audit/review and gate execution semantics plus repo boundaries.
- `meta-petabit-error-qa`: deferred Task 6 should classify as deferred-task and remain static/build-backed, not feature ideation.
- `meta-petabit-image-package-policy`: image/package policy should classify as implementation-design with explicit policy-vs-scaffold choice.
- `superpowers-masterplan-feature-ideas`: explicit "more brainstorming for feature ideas" remains the idea-funnel case, but Codex must not depend on native multi-select or arbitrary ID-entry UI.

## Non-goals

- Do not ship the previous individual-selection-page design as v1.
- Do not require native multi-select support in Codex.
- Do not make Step B1 perform the repo audit itself.
- Do not add heavy transcript parsing or build-host probing to normal brainstorming startup.

## Acceptance

- Step B1 documents and persists `brainstorm_anchor`.
- Specs generated after B1 must include `Intent Anchor` / `Scope Boundary`.
- Anchor gates use structured `AskUserQuestion` and persist `pending_gate` first.
- Self-host audit covers the prompt contract and fixture file.
- The stale run bundle no longer points future work at individual idea selection pages.
