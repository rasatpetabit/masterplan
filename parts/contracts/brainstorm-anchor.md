# Brainstorm Anchor Contract

## Haiku Fan-out Briefs (Step B1 step 2)

Three Haiku subagents dispatched in ONE assistant message; each reads ONLY its assigned class.

### Haiku A — project-docs

> **Goal.** Extract project-doc facts and hints for the brainstorm anchor. Return JSON ONLY.
>
> **Read source (each Read tool call MUST pass `limit`).**
> - `<repo-root>/AGENTS.md` — limit 500
> - `<repo-root>/CLAUDE.md` — limit 500
> - `<repo-root>/WORKLOG.md` — limit 200 (newest-at-top convention)
>
> **Constraints.** Read-only. Do NOT paste file content. If a file's tail beyond the cap is needed, note it in `notes`.
>
> **Return shape (JSON only).**
> ```json
> {
>   "source_class": "project-docs",
>   "facts": ["AGENTS.md: ...", "CLAUDE.md: ...", "WORKLOG.md: ..."],
>   "extracted": {
>     "repo_role_hint": "<short string or null>",
>     "yocto_ownership_hint": "<distro/image policy|BSP/machine|app recipes|kas composition|builder orchestration|cross-repo|null>",
>     "in_scope_paths_hint": ["..."],
>     "out_of_scope_repos_hint": ["..."],
>     "verification_ceiling_hint": "<local-static|repo-local-tests|requires-build-host|requires-runtime|requires-external-service|null>",
>     "mode_hint": "<feature-ideas|implementation-design|audit-review|deferred-task|execution-resume|unclear|null>"
>   },
>   "notes": "<optional short string>"
> }
> ```

### Haiku B — run-state

> **Goal.** Extract run-state facts and hints from the most recent run bundle. Return JSON ONLY.
>
> **Inputs (provided by orchestrator).** Topic string, `requested_verb`, repo root path, `config.runs_path`, slug of the most-recent bundle (orchestrator pre-resolves via `ls -t <config.runs_path>/*/state.yml | head -1`).
>
> **Read source (each Read tool call MUST pass `limit`).**
> - `<config.runs_path>/<slug>/state.yml` — limit 300
> - `<config.runs_path>/<slug>/events.jsonl` — limit 300
> - `<config.runs_path>/<slug>/spec.md` — limit 300
>
> **Constraints.** Read-only. If no recent bundle exists (`<slug>` is null), return an empty `facts` array and all hints as null with `notes: "no recent bundle"`.
>
> **Return shape (JSON only).** Same shape as Haiku A's return but `source_class: "run-state"`. The `mode_hint` field is the highest-signal output — set to `execution-resume` if the bundle shows in-progress phase and no completed retro; `deferred-task` if events.jsonl shows skipped/deferred entries matching the topic; otherwise null.

### Haiku C — repo-sketch

> **Goal.** Extract repo-structure facts from `rg --files`. Return JSON ONLY.
>
> **Inputs (provided by orchestrator).** Repo root path.
>
> **Read source.** `rg --files <repo-root>` piped through `head -200`; exclude `node_modules/`, `vendor/`, `.git/`, `legacy/.archive/`, `<config.runs_path>`, `<config.specs_path>`, `<config.plans_path>`.
>
> **Constraints.** Read-only. The rg output IS the read; do NOT Read individual files.
>
> **Return shape (JSON only).** Same shape as Haiku A's return but `source_class: "repo-sketch"`. Only `repo_role_hint` and (when derivable) `verification_ceiling_hint` are expected non-null; everything else can be null.

## Merge Rules (Step B1 step 3)

Parse all three Haiku returns as JSON. If any return is malformed or missing `source_class` / `extracted` / `facts`, fall through to the `AskUserQuestion` audit-mode gate with `pending_gate.id: brainstorm_anchor_audit_mode`.

**Field-by-field merge (first-non-null wins per precedence):**
- `repo_role` ← `A.extracted.repo_role_hint` || `C.extracted.repo_role_hint` || `B.extracted.repo_role_hint`
- `yocto_ownership` ← `A.extracted.yocto_ownership_hint` only
- `in_scope_paths` ← union of A + B hints (dedupe; preserve A's ordering)
- `out_of_scope_repos` ← union of A + B hints (dedupe; preserve A's ordering)
- `verification_ceiling` ← most restrictive of all three hints (order: `local-static < repo-local-tests < requires-build-host < requires-runtime < requires-external-service`); null hints ignored; if all null → fall through to AUQ gate
- `mode` ← `B.extracted.mode_hint` (highest signal) || `A.extracted.mode_hint` || topic-derived fallback (below)
- `plan_kind` ← from final `mode`: `audit-review → audit`; all others → `implementation`
- `evidence` ← concat of A.facts + B.facts + C.facts (dedupe exact-match; keep first 8 for source diversity)

**Topic-derived mode fallback** (when B and A both return `mode_hint: null`):
- `feature-ideas` — "new ideas/options/funnel" requests
- `implementation-design` — "buildable design"
- `audit-review` — "reevaluate/review/inspect/audit/simplify/find problems"
- `deferred-task` — topics naming a task/phase/TODO/skipped/error/worklog entry
- `execution-resume` — "continue planned work"
- `unclear` — if still ambiguous

**Validation gate.** If merged `mode == "unclear"` OR any required field (`repo_role`, `evidence`, `verification_ceiling`) is empty/null → fall through to AUQ audit-mode gate. Do NOT silently default.

**Persist.** Write result under `brainstorm_anchor:` in `state.yml`; append `brainstorm_anchor_resolved` to `events.jsonl` before any spec-writing call.

## brainstorm_anchor YAML Shape

Minimum shape (orchestrator canonical writer per CD-7; Haiku subagents never write state):

```yaml
brainstorm_anchor:
  mode: audit-review
  repo_role: yocto-distro-policy-layer
  yocto_ownership: distro/image policy
  in_scope_paths:
    - conf/distro/
    - recipes-*/images/
  out_of_scope_repos:
    - meta-petabit-bsp
    - meta-petabit-apps
  evidence:
    - "AGENTS.md: current repo owns distro and image policy"
  verification_ceiling: requires-build-host
  gate_selection: null
  interview_depth:
    complexity: high
    seriousness: serious
    understanding_level: partial
    target_question_count: "12-20"
```
