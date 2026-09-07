# Handoff — intent-to-completion: all waves executed; the finale (pickup → whole-scope review → rehearsal → G1–G6 release → merge/push/deploy → archive)

Session: 01a06a67-f929-794e-875e-c862aeb3f083 (epyc2), 2026-09-07. State: **every task of the design-intent amendment (49–59) is executed, recorded, adversarially reviewed, and fixed** — `mp continue` returns `next: complete`. Full suite **2710/2710**. This handoff covers the remaining finish-stage pipeline.

## Repo state

- MAIN `/srv/dev/ras/masterplan` (branch `main`, tip `133c53c`): state records + review records per wave (`wave-11..16-reviews.json` in the bundle); state tip `5342c29`.
- WT `/srv/dev/ras/masterplan/.worktrees/intent-to-completion` (branch `masterplan/intent-to-completion`, tip `27ee2c1`): the full code line. Key commits: `ef5f472` (wave-16 code), `0e0e64e` (restore), `27ee2c1` (wave-16 fix round).
- Suite: `env -u PI_CODING_AGENT CLAUDE_CODE_SESSION_ID=<id> bash -c 'ls test/*.test.mjs | xargs node --test'` → 2710/2710. `record-result` runs FROM MAIN with `--state=docs/masterplan/intent-to-completion/state.yml`.
- Origin/main is at `723e8d6` (v9.10.1); local main is 106 ahead / 1 behind — reconcile at merge time.

## The remaining pipeline, in order

1. **The `/intent` handoff pickup** (todo #26 — fully scoped there; DO THIS FIRST): behavior-skills merged `feat/intent-verbs` (`395ce9f`); the pin re-point to `skills/productivity/intent` @ `0b6cd83` + identity recomputed over the NEW 19-file closed set; reconcile `interview-sequencer-delegation` + `interview-cutover` to the contract's new home in `verbs/plan.md` (none of the old SKILL.md strings survive); `mp interview amend-skill-identity` ledger amendment (the bundle's captures have the guard ARMED — mandatory); the fresh-grep prose sweep covering t57's new docs. All together, never one and stop. Frozen snapshots stay frozen.
2. **Waves-11–16 whole-scope adversarial review** (todo #21): the full diff `81303d3..HEAD` — waves 11–16 include every disclosed fix/restore; one fix round max.
3. **Live rehearsal + row-1 diagnosis** (todo #22): repairs 2+3 landed (`ede3f12`); the `pinned_finish_step` live behavior is diagnosed at the finish stage; `scripts/rehearse-v9-finish.sh` live green is a G6 prerequisite.
4. **G1–G6 + the live v10.0.0 release** (todo #23): G6 demands released, tagged, pushed, CI-green, installed + executable in BOTH surfaces BEFORE finish; bootstrap_step events record each command (the rehearsal, the throwaway-repo PR cycle, pre-publish verify, the GitHub PR merge, the push, the operator's plugin update). The reviewer's honest WARNs to resolve: stale Claude plugin cache (`plugin-registry-drift`), Pi agent drift (`pi-agent-registration`).
5. **Merge/push/deploy** (todo #24): the WT branch merges to main (reconcile origin/main `723e8d6`), push, install both surfaces, doctor green.
6. **Archive + records** (todo #25): archive LAST; successor run `v10-validation`; deferred `review_round_cap` hook.

## Standing constraints (unchanged)

- Builders never commit; verify-scope reverts out-of-scope edits → the disclose/restore dance (waves 11–16 precedent); never hand-edit `state.yml`; `record-result` from MAIN; one review round + one fix round per task; retroactive adversarial reviews via workflow at `litellm/gpt-6-astra` (subagent spawns are guard-broken fleet-wide — the workflow transport is the standing workaround); glm-5.3 builders succeed on prescriptive pointer-rich briefs, drown on dense synthesis (in-session fallback is proven); the write-scope guard misparses bash heredocs containing path-like strings — use the `edit`/`write` tools for file appends with regex-laden content.
- The operator's TODO.md (root, untracked): wrap up/merge/deploy rather than abandoning worktrees; make same-repo operations aware of each other.