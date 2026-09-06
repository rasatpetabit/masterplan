# v9.10.1 release review receipt

## Review invocation

Native `workflow({ name: "code-review" })` (the documented primary review route; run id
`code-review-mtp96r2o-w9z5r1`), foreground, on the exact frozen candidate diff
(`4ec1eed` HEAD^..HEAD, 520 diff lines, not truncated). 13 agents: 7 finders → verify → synthesis.
Direct `subagent()` reviewer routes were unavailable this session: the spawn-guard policy plane
(`/srv/workflows/agent-dispatch/runtime/current/policy/generated/dispatch-policy.jsonc`) went ENOENT
mid-session when the sibling `agent-policy` run retired the old dispatch runtime — `breaker` and
`mp-adversarial-reviewer` spawns were both guard-denied. The workflow route does not depend on that
plane. My earlier "review is unroutable" conclusion was wrong: the workflow route was available the
whole time, and the user ordered it used.

## Verdict and findings (all verify-CONFIRMED against the repo)

5 findings returned, 2 actionable, 3 informational; every claim was traced by the verify pass:

1. **E (actionable)** — `test/routing-policy.test.mjs:44`: the effort assertion
   `assert.equal(r.effort, loadRoutingPolicy().classes.adversary.effort)` was self-referential — it
   could fail only if the field were dropped, never if the value were wrong (a typo like `hgi` would
   ship into wave dispatch; empirically reproduced by the verify pass). **Fixed**: the assertion now
   validates the effort VALUE against the dispatch transport vocabulary
   (`low|medium|high|xhigh`).
2. **F (low)** — same line: second uncached `loadRoutingPolicy()` disk read. **Fixed**: policy is
   loaded once and injected via `resolveWorkClass('adversary', { policy })` (its documented contract).
3. **E (informational, pre-existing)** — version literal duplicated across five manifests; guarded by
   `publish-hygiene` + CI. Verifier additionally found real drift this release introduced:
   `llms.txt:5` and `.okf/index.md:15` still said v9.10.0. **Fixed**: both synced to v9.10.1.
4. **D (informational)** — cli-surface temp-dir idiom matches suite convention, cleans up correctly. No action.
5. **D (informational)** — the effort-derivation direction itself was correct (old pinned `xhigh`
   would have failed against the new policy). No action.

## Degraded coverage, honestly stated

Finders A (line-by-line correctness), B (removed-behavior), C (cross-file) timed out at the 900s cap
and returned no findings. Compensated deterministically on the fixed tree (not by re-review):

- Full suite `npm test && node bin/doctor.mjs . && git diff --check` → exit 0, **1659/1659 pass,
  doctor 0 errors**.
- Policy integrity: every lane/class/panel/agent reference in `policy/workflow-map.json` resolves;
  every lane model and every chain entry is served on the live gateway catalog (1503 models);
  retired refs (`glm-5.2`, `gemini-3.1-pro-preview`, `qwen3.7-plus`, `gpt-5.6-sol`, `mid` lane)
  absent; `resolveWorkClass('bounded-edit')` → `litellm/glm-5.3` (served).
- Intentional removals confirmed against the fleet regeneration provenance (commit `aa5f29f` sync,
  `abc3b0a` qwen lane removal, `5aa3c27` glm remap).

Per the operator's standing one-review/one-fix-round discipline, the fix round was NOT re-submitted
for LLM review; the fixes are the review's own confirmed fix directions applied mechanically.

## Released artifact

Final release commit `723e8d6609da55749c3e73fe9e2b8ddec7020580` (the reviewed `4ec1eed` amended with
the fix round; tree re-verified before amend). Published as **v9.10.1**.

Review cost: 13 agents, 10.4M tokens (~$17.23).
