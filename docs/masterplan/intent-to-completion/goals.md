topic: |
  Enhance masterplan so it does a better job of interviewing the operator to understand the true intent of the requested feature. The goal isn't to have the operator tell the model exactly what to it, it's to help the model understand the operators' intentions, so it can design its own solution. We currently don't do a good job of this, and our --complexity=high mode isn't nearly high enough in terms of getting the system to ask probing questions until it has a true understanding. We're also poor at recording those "goals", our current goals implementation gathers a large list of specific items which may or may not be helpful, but it doesn't make much effort to try and capture the true "intent". And lastly, we're particularly bad about the end of the project, driving the task to completion, and making sure it is ACTUALLY deployed and completed at the end of the work.

  Mid-brainstorm additions (same session, 2026-09-02): "Are we not using --autonomy either? Look for more issues like this, we should be able to set various levels of masterplan autonomy and complexity." "Review all of the other parameters for issues like this!" "When we first run /masterplan <anything> in a directory, we should load the existing masterplans to see if there are any conflicts first!" "Be sure to watch the context-window usage at gates, and see if we should be doing a /compact automatically."

## G1: The interview asks about intent, within an on-disk budget, and checks for overlapping runs before it starts
signal: test
evidence: Will exist on the branch: the sequencer's interview section and seed-time overlap step; agents/mp-intent-critic.md registered for Claude and Pi; test/interview-ledger-resume.test.mjs proving cap refusal, floor, critic-receipt convergence, and resume from disk; test/overlap-sequencer.test.mjs proving the overlap_review event and the runs-list topic/worktree fields.

## G2: Goals record intent, not a checklist
signal: test
evidence: Will exist on the branch: test/goals.test.mjs v2 cases (Intent block parsed and hashed, 3-5 outcome goals, signal/evidence optional, v1 still parses, intent amendment re-arms the spec gate); agents/mp-goal-assessor.md returning an intent verdict in the final assessment; the wave summary quoting the outcome line.

## G3: A run archives as complete only after its declared definition of done ran on the merged base, the live check passed, and the operator confirmed intent
signal: test
evidence: Will exist on the branch: test/finish-replay, test/deploy-commit-identity, and test/final-check suites proving deploy_step_started receipts, check probes, the deploy_indeterminate and deploy_failed gates, the --merged ancestor check, incomplete archives for keep/discard/skips/no-done-config, the finish_confirmed replay guard, and intent_confirm opening only after a final receipt bound to the deployed commit.

## G4: Complexity and autonomy resolve from the config hierarchy, are validated, drive behavior, and no knob can go inert again
signal: test
evidence: Will exist on the branch: test/config.test.mjs (CLI > repo > user > default, nested whole-object replacement, done repo-local only, malformed YAML fails, invalid enums fail, derived *_source), test/knob-inventory and test/knob-contract (every control surface has a two-value behavioral test or a closed metadata exemption, including the read-but-ignored synthetic case); the audit's dead flags and fields removed; README and SKILL.md describing the hierarchy and levels table.

## G5: Every gate reports exact context usage and a post-compaction brief exists
signal: command
evidence: Will exist on the branch: `mp context-status` returning exact tokens/window/pct with current, post-compaction, and unsupported states (test/context-status-session-lineage); the turn-close context line with the /compact recommendation above threshold; `mp resume-brief` printing the 5-line brief; the resume-brief-hook doctor check.
