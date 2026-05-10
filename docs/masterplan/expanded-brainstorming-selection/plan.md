# Plan: Brainstorm Intent Anchor

## Task 1: Replace Step B1 raw brainstorm handoff

**Files:**
- `commands/masterplan.md`

Add a pre-brainstorm intent anchor that reads cheap local truth, classifies mode, records repo ownership, persists `brainstorm_anchor`, appends `brainstorm_anchor_resolved`, and gates only ambiguity that would otherwise cause drift.

## Task 2: Update durable docs

**Files:**
- `docs/internals.md`
- `README.md`
- `CHANGELOG.md`

Document anchored brainstorming as a runtime behavior, an operational non-negotiable, and an unreleased fix.

## Task 3: Replace stale self-host run bundle

**Files:**
- `docs/masterplan/expanded-brainstorming-selection/spec.md`
- `docs/masterplan/expanded-brainstorming-selection/ideas.md`
- `docs/masterplan/expanded-brainstorming-selection/state.yml`
- `docs/masterplan/expanded-brainstorming-selection/events.jsonl`
- `docs/masterplan/expanded-brainstorming-selection/plan.md`
- `docs/masterplan/expanded-brainstorming-selection/regressions.json`

Supersede the previous individual-selection-page design and record the transcript-derived regression fixtures.

## Task 4: Add self-host audit coverage

**Files:**
- `bin/masterplan-self-host-audit.sh`

Add a lightweight `--brainstorm-anchor` check and include it in the default audit.

## Task 5: Verify

Run:

- `git diff --check`
- `bash bin/masterplan-self-host-audit.sh --cd9`
- `bash bin/masterplan-self-host-audit.sh --codex`
- `bash bin/masterplan-self-host-audit.sh --brainstorm-anchor`
- `jq empty .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json .agents/plugins/marketplace.json docs/masterplan/expanded-brainstorming-selection/regressions.json`
- JSONL validation for `docs/masterplan/expanded-brainstorming-selection/events.jsonl`
