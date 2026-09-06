# Routing-cache repair — prepared, not published

## Decision (user-confirmed)

The user explicitly chose **Wait for governed review**. The candidate remains committed but unpublished; the installed Claude cache is unchanged; no review requirement was waived. Wave 3 may be unblocked by its owning session through the documented `MP_ROUTING_POLICY` override on the affected invocation. When a governed reviewer lane is repaired, obtain a native verdict on the exact candidate, then publish with a valid review.

## Scope and ownership

User explicitly requested fixing the installed masterplan bounded-edit route whose source fixes were committed but unreleased at the same version. The reported wave is agent-policy wave 3, owned by Claude session `383695f5-b79c-494f-8201-68f603f7d819`, state `/srv/workflows/docs/masterplan/agent-policy/state.yml`. Its owner is handling Pi dispatch; this session has not changed that run's state or launched its workers.

The design-intent amendment remains paused behind its own pending approval gate. Its uncommitted D1 decision edit is preserved. An unrelated root TODO.md appeared during this work and was left untouched.

## Reproduced consumer failure

Installed Claude cache: `~/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/9.10.0`.
Its actual `resolveWorkClass('bounded-edit')` returns `litellm/glm-5.2`, absent from the live gateway catalog. Both the installed version and published marketplace remain 9.10.0. Source routing fixes `5aa3c27`, `abc3b0a`, `aa5f29f` are not on the fetched origin/main.

`claude plugin marketplace update rasatpetabit-masterplan` succeeded, but `claude plugin update masterplan@rasatpetabit-masterplan --scope user` reported already latest 9.10.0. Re-reading the consumed cache confirmed the old route remains. No immutable cache files were hand-edited.

The installed resolver's documented `MP_ROUTING_POLICY=~/.pi/workflows/workflow-map.json` override resolves bounded-edit to the served current code model. This was exercised in an isolated invocation, not installed into another session's environment. Pi's current masterplan install already resolves the current route without this override.

## Prepared release

- Worktree: `/srv/dev/ras/masterplan/.worktrees/routing-cache-release`
- Branch: `fix/routing-cache-release`
- Base: published `origin/main`, `f7e0b2a01d72ee3347d16b359c9e5b1461867159`
- Candidate: `4ec1eedf40892e535364dde3a115c46d16cdcbbc`, version **9.10.1**
- Includes the current committed routing snapshot and its policy-derived effort assertion, plus synchronized release metadata.
- Excludes the 76 unrelated local-main commits and the unfinished v10 branch.
- Also corrects one pre-existing CLI test fixture: missing state and unknown flags both exit2, so exit2 alone cannot prove an unknown flag. The corrected isolated-temp fixture asserts ENOENT and absence of the unknown-flag diagnostic; it no longer claims to test engine threading. Runtime code is unchanged.

## Evidence

Candidate `npm test && node bin/doctor.mjs . && git diff --check` exited0: **1659 tests,1659 pass,0 fail; doctor0errors1warning**. Sole warning identifies the stale installed plugin cache. Full output: `/tmp/masterplan-routing-release-tests.log`.

Actual resolver/catalog differential:
- installed default → glm-5.2: FAIL (not served)
- installed + documented policy override → glm-5.3: PASS
- candidate default → glm-5.3: PASS

A real request using the candidate-derived model returned HTTP200 and a strict `routing_probe({ok:true})` tool call. The returned tool was not executed. Receipt: `/tmp/masterplan-routing-release-probe.json`. This proves route and basic tool capability, not wave completion.

## Review / publication boundary

Native breaker review was attempted for the16-line CLI fixture correction. Two tool preflights rejected brief formatting; the corrected atomic request then failed before model execution because the spawn guard's policy plane path `/srv/workflows/agent-dispatch/runtime/current/policy/generated/dispatch-policy.jsonc` does not exist. The absence was checked directly. No review verdict was returned. Required routing-security review also remains unperformed; no source-copy or passing test is claimed as that review.

A follow-up read of current `policy-authority.md` still names that missing policy plane. Live `subagent({action:"models"})` reports all seven built-in governed roles unresolved, including breaker and judge. No replacement native route was established in this process. This is not a claim that gateway model backends are down: the candidate's direct capability probe succeeded.

Do not restore the retired control plane, invent a raw model override, switch to an ungoverned runner, or count these failures as approval.

**Not executed:** release tag, publication/push, Claude installation of9.10.1, post-install consumer verification. Native review is unavailable in this process. The next decision is whether to wait for the governed review lane to be repaired or explicitly waive this review for the tested narrow patch and authorize its publication.

If authorized to publish: re-fetch/check origin/main for concurrent changes; push only the candidate as a fast-forward of published main (not local main), create/push its annotated9.10.1 tag through RELEASING.md, verify CI/release, refresh marketplace and update the Claude plugin, then resolve bounded-edit from the newly installed cache and exercise that installed route. Respect any plugin-manager restart-only activation step; do not claim an already-running session reloaded automatically. Preserve the unrelated local-main work and do not run the v10 bootstrap as this patch's release path.
