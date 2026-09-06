# Accepted scope amendment: shared design-intent integration

## User decision

The user selected **Expand the existing run** after being shown:
- sanctioned scope amendment and new planned tasks in `masterplan/intent-to-completion`;
- expanded release scope including design-intent integration;
- affected evidence must be renewed;
- existing blockers remain unresolved; pushes and relay pin remain unchanged.

This authorizes reopening and planning; it is not approval of as-yet-unwritten goals,
design details, task amendments, or release evidence. Do not seed another run.

## Confirmed direction (verbatim source excerpt)

**DECIDED 2026-09-05 — masterplan delegates to this skill.** The owner chose, through the
structured question below, that masterplan's native intent step (§2f on the
`masterplan/intent-to-completion` branch) delegates the questioning to `/design-intent` plan mode
and reads its `schema.json`; the native `why` / `outcome` / `done_means` / `anti_goals` fields map
onto the skill's sections inside the `## Intent` block of `goals.md`, the repo-level `INTENT.md`
reconciliation (§3.1, §5.3) stays owned by the skill, and `mp-intent-critic` judges against the
same schema. One interview implementation, two consumers. The rejected alternative was retiring
the skill's plan mode in favour of §2f. The retargeting itself is the deferred masterplan
session's work, run in `/srv/dev/ras/masterplan` against that branch, not `main`; the rest of §5
remains the design record against `main` and must be rebased onto §2f there.

Source: `/srv/dev/ai/behavior-skills/docs/superpowers/specs/2026-09-05-design-intent-design.md` §5.
Source repository commit: `65eea6a34523899d9392bbff89420f32c1ad3b46`.
Full source file SHA256: `fa710b269b4a10b1a95f5193d7c82a6655ffbdd9346191a952c92e45e1f72529`.
The opening blocked notice and older implementation record are not the new direction.
Do not implement a second standalone intent.md lifecycle from that superseded proposal.

## Boundaries and remaining planning

Preserve the immutable request anchor, all 48 completed task records, existing goal IDs,
and the failed release-review history. Native goals.md Intent and ledger remain the
integration surface. Define the section mapping, schema ownership/binding, skill-owned
repo reconciliation, ledger adapter, and critic contract during the amendment planning.
Any new/changed goals require the exact-artifact goal-amend approval receipt; approved
scope is not a substitute. New tasks must be appended/amended without replacing done work.

Rehearsal lifecycle/negative-control findings and reviewer preset admission remain open.
No automatic release review, rehearsal repair, live deployment, behavior-skills push, or
Sonnet relay change is authorized by this scope choice. Branch code base remains 1f2741f.
