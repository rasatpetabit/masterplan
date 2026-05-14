# Retrospective: expanded-brainstorming-selection

**Date:** 2026-05-13
**Status:** complete
**Outcome:** Replaced individual idea-selection pages with a `brainstorm_anchor` system that classifies intent and gates scope before invoking the brainstorming skill.

## What happened

The prior direction attempted to build multi-select funnel pages for expanded brainstorming output, but stalled because the brainstorming skill was being invoked without scoping the repo boundary first. Root cause: Step B1 briefed the brainstorming skill with only the topic, causing Yocto-style audit prompts to cross repo boundaries before scope was anchored. This run pivoted to a `brainstorm_anchor` record in state.yml — capturing repo role, in-scope paths, and out-of-scope repos — inserted into Step B1 as an explicit gate. Four tasks completed: B1 anchor logic, durable docs update, stale run supersession, and self-host audit coverage for `--brainstorm-anchor`. All verification commands passed.

## What went well

- Pivot decision was clean: old direction was clearly stalled, new direction was well-scoped from the start
- `brainstorm_anchor` schema is minimal and composable — fits the existing state.yml structure without a schema version bump
- Self-host audit coverage (`--brainstorm-anchor` flag) means the new gate is regression-tested going forward
- All static verifications passed on first run: `bash -n`, `jq empty`, `git diff --check`, all audit flags

## What could improve

- The root cause (unanchored brainstorm briefs) should have been caught at v1 design time; a "repo role" field in the original brainstorm brief template would have prevented the detour
- The individual-selection-pages direction consumed design work that wasn't recoverable; earlier scope anchoring would have avoided that sunk cost
- events.jsonl for this run lacked a `verification_passed` event timestamp — future runs should emit that with a UTC timestamp for cleaner audit trails

## Follow-up items

- Consider adding `repo_role` as a required field in the Step B0 brainstorm brief template (not just persisted post-hoc in state.yml)
- Evaluate whether `gate_selection: null` in brainstorm_anchor should be a reserved sentinel or dropped when not applicable
