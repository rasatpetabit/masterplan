# Goals — blocked-task-injection

## G1: Dispatch skips fully-blocked waves
signal: test
evidence: test/resume.test.mjs — decideNextAction selects the next runnable wave when an entire wave is blocked; blocked tasks are excluded from the dispatch/recovery/wave-count filters.

## G2: Blocked runs do not silently finalize
signal: test
evidence: test/resume.test.mjs — a bundle whose only non-done tasks are blocked returns awaiting_waiver, never complete.

## G3: Explicit waivers close a blocked run
signal: test
evidence: test/bin-masterplan.test.mjs — mp waive-task (per-id and --all) converts blocked to waived under operator consent with --reason required; waived is terminal and unblocks finalize.

## G4: Status-preserving task injection
signal: test
evidence: test/bundle.test.mjs — upsertTasks appends new ids as pending, refreshes existing wave/files, preserves accumulated statuses and reason fields; --prune drops absent ids.

## G5: Adversarial review runs during execution
signal: artifact
evidence: docs/masterplan/blocked-task-injection/state.yml carries state.review.adversary=true armed at seed; prepare-wave reads the canonical nested key; bin-masterplan test asserts prepare-wave resolves review from the nested key.

## G6: Green and documented
signal: test
evidence: npm test passes; mp doctor exits 0 with zero FATALs; CHANGELOG.md and docs/verbs.md and docs/internals updated.
