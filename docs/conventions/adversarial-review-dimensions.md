# Codex Review Dimensions

These are the B2/B3 spec/plan-review evaluation axes for the step-7 lifecycle, migrated from `parts/contracts/codex-review.md` ahead of the v8 cutover. The dispatch mechanism, parse algorithm, JSON return contract, and host fallback from that source are NOT ported here — those are superseded by `agents/mp-adversarial-reviewer.md`.

---

## Six Review Dimensions

The following six dimension names are the evaluation axes used in REVIEW dispatch returns. They appear in the `dimensions` field of the JSON return shape (see `agents/mp-adversarial-reviewer.md` for the current return contract):

- `completeness`
- `correctness`
- `security`
- `consistency`
- `naming`
- `scope`

**Note:** The source file (`parts/contracts/codex-review.md`) lists these six names in the `dimensions` array of the return JSON shape but does not provide separate prose definitions for what each dimension evaluates. The names are ported verbatim; per-dimension meaning was not separately defined in the source.
