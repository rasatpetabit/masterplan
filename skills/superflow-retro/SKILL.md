---
name: superflow-retro
description: Generate a retrospective doc when a `/superflow` plan transitions to `status: complete`, when a tracked feature ships, or when a merge commit closes a branch tied to a superflow status file. Captures outcomes, blockers, deviations, follow-ups; saves to docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md and offers to `/schedule` time-bounded follow-ups.
---

# Generating retrospectives for completed /superflow plans

This skill creates a retro doc from a completed superflow plan's status file, plan, spec, and git history. It runs on demand or when a completion signal is detected.

## When to fire

- A status file in the current worktree just transitioned `status: in-progress` → `status: complete`.
- The user says something like "we just shipped X", "the auth refactor is done", "I merged the migration PR" and a status file matches.
- A merge commit closes a branch whose name matches a superflow `slug`.
- The user explicitly asks for a retro.

Don't fire on:
- Trivial bugfixes or one-line PRs.
- Plans completed by other authors (different `git log` author).
- A retro for this slug already exists. Check via glob `docs/superpowers/retros/*-<slug>-retro.md` (the file is date-prefixed, so a fixed-path lookup will always miss).

## What to gather

For the relevant plan slug, read in this order:

1. The status file: `docs/superpowers/plans/<slug>-status.md` — frontmatter, full activity log, blockers section, notes section.
2. The plan: `docs/superpowers/plans/<slug>.md` — task list, intended order.
3. The spec: `docs/superpowers/specs/<slug>-design.md` — original goals, scope, design decisions.
4. Git evidence: `git log --reverse --format='%h %ci %s' <trunk>..<status.branch>` — commits since the plan started.
5. PR (if any): `gh pr list --search "head:<branch>" --state=all --json=number,title,url,mergedAt,additions,deletions`.

## Retro doc structure

Write to `docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md`:

```markdown
# <Feature Name> — Retrospective

**Slug:** <slug>
**Started:** <status.started>
**Completed:** <today's date>
**Branch:** <status.branch>
**PR:** <pr url if available>

## Outcomes

What shipped, in 2–3 bullet points. Tie back to the spec's stated goal.

## Timeline

- Day-by-day or week-by-week from the activity log, summarized. One bullet per ~3 task completions.

## What went well

3–5 bullets. Be specific (cite commit SHAs, task names, the routing tag — `[codex]` vs `[inline]`).

## What blocked

For each entry in the status file's `## Blockers` section: what blocked, what unblocked it, time lost. Pull the CD-4 ladder citations from the activity log to show how the blocker was attacked before escalation.

## Deviations from spec

Tasks that ended up scoped differently from the original spec. Cite spec section vs final commit. Was the change well-motivated? Did it get noted in `## Notes` at the time?

## Codex routing observations

Tally `[codex]` vs `[inline]` from the activity log. If routing was `auto`, did the eligibility heuristic make good calls? Any false positives (delegated → had to rerun inline) or false negatives (kept inline but obviously simple enough for Codex)? This feeds tuning of `config.codex.max_files_for_auto` and similar.

## Follow-ups

For each follow-up identified during the run (TODOs left in code, flags to remove later, monitoring to verify a launch):

- [ ] **<action>** — <when> — `/schedule` candidate? (yes/no)

## Lessons / pattern notes

Anything worth promoting to project memory or to a CLAUDE.md update. Specific, not platitudes.
```

## After writing the retro

1. Show the user the retro path and a one-paragraph summary.
2. For each follow-up marked as `/schedule` candidate, offer specifically: "Want me to /schedule a one-time agent for `<action>` in `<N weeks>`?" One offer at a time, not a wall.
3. If the retro surfaced lessons that fit project memory (per the auto-memory rules), suggest saving them — don't save automatically.

## Operational rules

- Apply CD-3: cite git SHAs, file paths, and concrete numbers. Don't write vague retros.
- Apply CD-10: if you call out problems, ground them in `path:line` so they're actionable.
- Apply CD-7: the retro doc itself becomes durable handoff state for future-you. Write it for someone who wasn't there.
- Don't bury negatives. If a routing decision was bad or a spec assumption broke, name it. The retro is for learning.
