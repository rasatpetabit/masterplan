# Known issues

Findings raised against masterplan during real runs, recorded rather than fixed
in place so the run that found them stayed on its own scope. Each entry names how
it was hit, so a fix can be verified against the same path.

## 1. The spec gate's review requirement contradicts the 2026-08-07 operator ruling

**Hit during:** `hindsight-integration` run, spec gate, 2026-08-08.

`enforceGateReview` blocks the spec -> plan transition until a cross-vendor
adversarial review of the current spec artifacts is recorded. The host behavior
policy (`docs/policy/outcome-evidence.md` § "Review before approval", propagated
into every harness through the managed `behavior-policy` block) says the opposite
for this specific artifact:

> **Spec** — no review gate. Write it and put it in front of the user.

The same policy does require a review at the *plan* gate ("one fresh-context
cross-vendor adversarial review of the exact artifact before asking for
approval"), so the conflict is narrow: it is the **spec** gate only, and the plan
gate is correct as implemented.

The practical effect is that a run either burns adversary-lane rounds the policy
says it should not need, or records a `skipped` to get past a gate the policy
never wanted. Neither is a good default.

Note the review itself was not wasted in that run — 19 findings were accepted
into the frozen goals. The issue is that the gate is mandatory, not that review
is worthless.

**Options, none taken yet:** drop the spec-gate review requirement to match the
ruling; keep it but default to `skipped` with a policy citation; or make it
configurable per bundle.

## 2. `goals-amend` reports `changes: 0` for substantive edits

**Hit during:** the same run — four separate goal amendments, each rewriting
evidence clauses across multiple goals, every one reporting `changes: 0`.

```
{"goals_amend":"amended","old_goals_hash":"sha256:9eff0bf4...","new_goals_hash":"sha256:9591fb19...","changes":0,...}
```

The hashes move, so the amendment is recorded correctly and nothing downstream is
wrong. But the counter appears to tally heading-level changes only: adding,
removing, or renaming a `## G<n>:` line. Rewriting the body of an existing goal —
which is what an amendment responding to review findings almost always does —
counts as zero.

A `changes: 0` on a real amendment reads as a no-op to anyone scanning
`events.jsonl` later, which is the opposite of what the field is for. Counting
goals whose *body* hash changed would be more faithful.

## 3. `agent-dispatch review` output carries no timestamp

**Hit during:** building a gate receipt from a review result, 2026-08-08.

The review result records `reviewers[].{provider,model,dispatch_id,output_tokens,duration_ms}`
but no completion time at any level. `record-gate-review --review-json` therefore
falls back to the result file's own mtime to decide whether a review predates the
artifacts it would certify (see the staleness guard in `bin/masterplan.mjs`).

That works, but it is a proxy: copying the file forward, or restoring it from a
backup, resets the mtime and would let a stale review certify current artifacts.
A `completed_at` field in the review output — or better, the artifact hashes the
review actually read — would make the check exact. The fix belongs in
agent-dispatch, not here.
