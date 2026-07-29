# Rejected-idea knowledge base (`.out-of-scope/`)

Convention grafted from mattpocock/skills' `triage` skill during the 2026-07-28
behavior-skills adoption (`/srv/dev/ai/behavior-skills`).

## Name disambiguation (read this first)

Masterplan already uses the phrase **out of scope** for two *different* things.
Do not conflate them:

| Concept | What it is | Where it lives |
|---|---|---|
| **D6 path-scope** | Files a wave was allowed to touch; out-of-scope *paths* are reverted at wave-commit | `mp verify-scope`, `lib/wave-commit.mjs` (`scope.outOfScope`) |
| **Run-bundle Out of Scope** | Ideas excluded from *this run's* `spec.md` | `docs/masterplan/<slug>/spec.md` section |
| **Rejected-idea KB** (this doc) | Durable, repo-level rejections that outlive any run — stop re-litigating | `.out-of-scope/<concept-slug>.md` at the **target repo root** |

This document is **only** about the rejected-idea KB.

## When to write a file

When an idea, enhancement, or approach is **deliberately rejected** during brainstorm
or spec gates — not deferred, **rejected** — record it so future sessions and agents
stop re-proposing it.

## File shape

- One file per **concept** (not per occurrence): `.out-of-scope/<concept-slug>.md`
  at the repo root of the repo the decision applies to.
- Two **required** sections:
  - `## Why this is out of scope`
  - `## Prior requests` (append a dated line each time the idea resurfaces)
- Optional: `## Related` (links to ADRs, issues, or the run that rejected it).

Template (also at `docs/conventions/out-of-scope.template.md`):

```markdown
# <Concept title>

## Why this is out of scope

<One short paragraph: what was rejected and why. Not "later" — rejected.>

## Prior requests

- YYYY-MM-DD — <who/session>: <one-line context of the request>
```

## Agent checklist (brainstorm / spec gates)

1. Before proposing or triaging an enhancement, list `.out-of-scope/` in the target
   repo (if the directory exists).
2. If a file matches the concept, **cite it** instead of re-arguing.
3. If the user **overrides** a rejection, delete or amend that file in the same turn
   (and note the override under `## Prior requests`).
4. After a deliberate reject at a brainstorm/spec gate, create or update the file
   before closing the gate.

## Relationship to other scope mechanisms

- Complements, does not replace, the run bundle: bundle `spec.md` "Out of Scope"
  sections scope **one run**; `.out-of-scope/` records **durable** rejections.
- Complements, does not replace, D6 path-scope: path-scope is mechanical file
  allowlisting; this KB is product/design decision memory.
- `mp doctor` check `rejected-idea-kb` WARNs if any `.out-of-scope/*.md` is missing a
  required section (it does **not** invent rejections for you).
