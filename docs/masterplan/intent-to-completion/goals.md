topic: |
  Enhance masterplan so it does a better job of interviewing the operator to understand the true intent of the requested feature. The goal isn't to have the operator tell the model exactly what to it, it's to help the model understand the operators' intentions, so it can design its own solution. We currently don't do a good job of this, and our --complexity=high mode isn't nearly high enough in terms of getting the system to ask probing questions until it has a true understanding. We're also poor at recording those "goals", our current goals implementation gathers a large list of specific items which may or may not be helpful, but it doesn't make much effort to try and capture the true "intent". And lastly, we're particularly bad about the end of the project, driving the task to completion, and making sure it is ACTUALLY deployed and completed at the end of the work.

  Mid-brainstorm additions (same session, 2026-09-02): "Are we not using --autonomy either? Look for more issues like this, we should be able to set various levels of masterplan autonomy and complexity." "Review all of the other parameters for issues like this!" "When we first run /masterplan <anything> in a directory, we should load the existing masterplans to see if there are any conflicts first!" "Be sure to watch the context-window usage at gates, and see if we should be doing a /compact automatically."

## G1: The interview asks about intent, exits only through a named on-disk state, and checks for overlapping runs before it starts
signal: test
evidence: Will exist on the branch: the sequencer's interview section and seed-time overlap step; agents/mp-intent-critic.md registered for Claude and Pi; test/interview-ledger-resume.test.mjs proving cap refusal, floor, the converged/exhausted/critic_off terminal states, critic payload persistence, and resume from disk; test/overlap-sequencer.test.mjs proving the overlap_review first event and the runs-list topic/goals/planned_paths/worktree fields.

## G2: Goals record intent, not a checklist
signal: test
evidence: Will exist on the branch: test/goals.test.mjs v2 cases (Intent block parsed and hashed, 3-5 outcome goals enforced, signal/evidence optional, v1 still parses, intent amendment re-arms the spec gate); agents/mp-goal-assessor.md returning an intent verdict in the final assessment; the wave summary quoting the outcome line.

## G3: A run archives as complete only after its declared definition of done ran on a base containing its branch, the live check passed, and the operator confirmed intent
signal: test
evidence: Will exist on the branch: test/finish-replay, test/deploy-commit-identity, and test/final-check suites proving deploy_step_started receipts, exit-status check probes, the no_definition_of_done / deploy_indeterminate / deploy_failed gates, the merged-base ancestry checks, the separate completion_confirmed and incomplete_authorized authorizations, incomplete archives for keep/discard/skips, and intent_confirm opening only after a final receipt bound to the deploy base.

## G4: The knob guard fails the suite on any control surface that lacks a two-value behavioral contract, and complexity and autonomy resolve from the config hierarchy with validation
signal: test
evidence: Will exist on the branch: test/config.test.mjs (CLI > repo > user > default, nested whole-object replacement, done repo-local only and schema-validated, malformed YAML fails, invalid enums fail, derived *_source, full and auto_compact aliases warn), test/knob-inventory and test/knob-contract (every control surface has a two-value behavioral test or a closed metadata exemption, including the read-but-ignored synthetic case); the audit's dead flags and fields removed; README and SKILL.md describing the hierarchy and levels table.

## G5: Gates report measured context usage where the harness exposes it and an explicit unknown state where it does not, and a post-compaction brief exists
signal: command
evidence: Will exist on the branch: `mp context-status` returning tokens_at_last_request, appended_est, window, and one of the current / post-compaction / malformed / unsupported states (test/context-status-session-lineage); the turn-close context line with the /compact recommendation above threshold; `mp resume-brief --repo-root` resolving zero, one, or several active bundles; the resume-brief-hook doctor check.

## G6: v10.0.0 is released, tagged, pushed, and installed into the Pi install root by this run before it finishes
signal: command
evidence: Will exist on this bundle before finish: bootstrap_step events (recorded via mp event) for scripts/release.mjs on the branch tip, the pushed branch and v10.0.0 tag, `node bin/install-pi.mjs --ref=v10.0.0`, and `node bin/install-pi.mjs --check` reporting check_ok at v10.0.0; the release commit is the branch HEAD the finish verifies.
