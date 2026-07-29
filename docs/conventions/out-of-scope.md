# Out-of-scope knowledge base

Convention grafted from mattpocock/skills' `triage` skill during the 2026-07-28
behavior-skills adoption (`/srv/dev/ai/behavior-skills`).

When an idea, enhancement, or approach is **deliberately rejected** during brainstorm or
spec gates — not deferred, rejected — record it so future sessions and agents stop
re-litigating it:

- One file per **concept** (not per occurrence): `.out-of-scope/<concept-slug>.md` at the
  repo root of the repo the decision applies to.
- Relaxed design-doc prose with two required sections: `## Why this is out of scope` and
  `## Prior requests` (append a dated line each time the idea resurfaces).
- Before proposing or triaging an enhancement, check `.out-of-scope/` first; if a match
  exists, cite it instead of re-arguing — and if the user *overrides* it, delete or amend
  the file in the same turn.
- This complements, not replaces, the run bundle: bundle `spec.md` "Out of Scope" sections
  scope one run; `.out-of-scope/` records durable, repo-level rejections that outlive any
  run.
