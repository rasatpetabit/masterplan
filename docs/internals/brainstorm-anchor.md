# Brainstorm Anchor — Internals

> **Audience:** Maintainers changing Step B1 anchor logic.
> **Phase file:** `parts/step-b.md` §Step B1.
> **Coordinator:** `coordinator-brainstorm-anchor` (Sonnet tier).

## Coordinator Dispatch

The orchestrator dispatches 1 Sonnet coordinator with topic + repo-root. The coordinator calls Haiku A, B, C in parallel internally, merges returns, classifies the anchor, and returns compact JSON.

**Return shape:**
```json
{
  "mode": "implementation-design",
  "repo_role": "...",
  "yocto_ownership": null,
  "verification_ceiling": "local-static",
  "in_scope_paths": ["commands/", "parts/"],
  "out_of_scope_repos": [],
  "evidence": ["CLAUDE.md: ...", "WORKLOG.md: ..."],
  "interview_depth": {"complexity": "high", "target_question_count": "8-12"},
  "coordinator_version": "1"
}
```

## Haiku A — project-docs (full brief)

**Goal:** Extract project-doc facts and hints. Return JSON only.

**Read source** (each Read call MUST pass `limit`):
- `<repo-root>/AGENTS.md` — limit 500
- `<repo-root>/CLAUDE.md` — limit 500
- `<repo-root>/WORKLOG.md` — limit 200

**Constraints:** Read-only. Do not paste file content. Note overflows in `notes`.

**Return shape:**
```json
{
  "source_class": "project-docs",
  "facts": ["AGENTS.md: ...", "CLAUDE.md: ...", "WORKLOG.md: ..."],
  "extracted": {
    "repo_role_hint": "<string or null>",
    "yocto_ownership_hint": "<bsp|app|distro or null — non-null only for Yocto/BSP repos>",
    "in_scope_paths_hint": ["..."],
    "out_of_scope_repos_hint": ["..."],
    "verification_ceiling_hint": "<ceiling or null>",
    "mode_hint": "<mode or null>"
  },
  "notes": "<optional>"
}
```

## Haiku B — run-state (full brief)

**Goal:** Extract run-state facts from the most recent bundle. Return JSON only.

**Read source** (each Read call MUST pass `limit`):
- `<config.runs_path>/<slug>/state.yml` — limit 300
- `<config.runs_path>/<slug>/events.jsonl` — limit 300
- `<config.runs_path>/<slug>/spec.md` — limit 300

**Constraints:** Read-only. If no recent bundle, return empty `facts` and all hints null with `notes: "no recent bundle"`.

**Return shape:** Same structure as Haiku A with `source_class: "run-state"`. `mode_hint` is highest-signal: `execution-resume` if bundle in-progress; `deferred-task` if deferred events match topic; otherwise null.

## Haiku C — repo-sketch (full brief)

**Goal:** Extract repo-structure facts from `rg --files`. Return JSON only.

**Read source:** `rg --files <repo-root> | head -200` (exclude node_modules/, vendor/, .git/, legacy/.archive/, config.runs_path, config.specs_path, config.plans_path).

**Return shape:** Same structure as Haiku A with `source_class: "repo-sketch"`. Only `repo_role_hint` and `verification_ceiling_hint` expected non-null.

## Merge Rules

Field-by-field, first-non-null wins per precedence:
- `repo_role` ← A || C || B
- `yocto_ownership` ← A || C (project-docs primary; null for non-Yocto repos — passed into the brainstorming brief and the `commands/masterplan-contracts.md` anchor return so BSP/app/distro ownership survives to the scope-boundary gate)
- `in_scope_paths` ← union(A, B), A-ordering preserved
- `out_of_scope_repos` ← union(A, B), A-ordering preserved
- `verification_ceiling` ← most restrictive of the three hints
- `mode` ← B || A || topic-derived (see topic-derived fallback in `parts/step-b.md §Step B1`)
- `evidence` ← concat(A.facts, B.facts, C.facts), max 8 entries

## Classification Gate

When merged `mode == "unclear"` OR any required field (`repo_role`, `evidence`, `verification_ceiling`) is null → fall through to AUQ gate with `pending_gate.id: brainstorm_anchor_audit_mode`. Do not silently default.
