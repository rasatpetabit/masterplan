# `implementer.qctl.enabled` flag-flip preconditions

**This is a human-gated judgment document.**
The flip of `implementer.qctl.enabled` from `false` to `true` in a bundle's
`state.yml` MUST NOT happen automatically. An operator reviews and confirms
every item below before making the change.

The flag is checked with strict `=== true` in `lib/wave.mjs`
(`resolveImplementerBackend` short-circuits on anything other than strict
true). Default is `false`. The `qctlEligible` eligibility predicate in
`lib/wave.mjs` is dormant until the flag is on AND `reposAllowlist` is wired
(see precondition 5).

---

## Precondition checklist

All five items must be confirmed before flipping the flag.

### 1. qctl loop proven (P0+P1 green)

The Qwen Work Fabric `qctl` CLI and `gate.py` are shipped and a live offload
round-trip has completed end-to-end. Specifically, the P1 vertical slice
(fix-failing-test against `petabit-sysadmin`, spec §6.4) has run successfully:
a task was routed to `{kind:'qctl'}`, the `qctl` worker picked it up, applied
a patch, `gate.py` ran the repo's verify command, and the result was reported
back without error.

Confirm: P0+P1 both green, no open blocking issues in the qctl/gate pipeline.

### 2. Router-only egress enforced

The sandbox isolation layer (`bwrap --unshare-net` or equivalent) is deployed
and verified. Outbound network traffic from the `qctl` worker process is
restricted to the CODE-lane router endpoint only. This is not aspirational — it
must be demonstrated in the running environment before flip, not promised for
a later hardening pass.

Confirm: router-only egress is enforced; any attempt to reach an arbitrary
external host from inside the worker fails.

### 3. D0 observability live

The minimum viable observability stack is running in production:
`scripts/skynet/qwen-observe.py` + a systemd timer are deployed and collecting
metrics. At minimum, queue depth, job age, dead-letter rate, and router health
alerting are live. Failures are surfaced before they go silent.

Confirm: D0 observability dashboards/alerts are active, not just installed.

### 4. Per-task rollback demonstrated

A full rollback of an applied `qctl` patch has been demonstrated in practice:
a task whose patch was applied to the working tree has been reverted cleanly,
leaving the repo in its pre-task state. The rollback path is known to work, not
only theorized.

Confirm: rollback of an applied qctl patch was demonstrated at least once.

### 5. Eligibility-allowlist production wiring (`--repos-allowlist`) — ✅ WIRED

**Code wiring complete (commit `472f034`).** The L1 shell (`bin/masterplan.mjs`
`prepare-wave` case) now parses an optional `--repos-allowlist` (JSON = parsed
`repos.yml`) and threads it as the sixth argument (`reposAllowlist`) to
`prepareWave`. Malformed JSON, or a non-object value, exits non-zero with a hint
(matching the `enqueue-key --scope` idiom). When the flag is absent the arg is
`undefined`, the `qctlEligible` gate fail-closes, and every `{kind:'qctl'}` route
downgrades to `{kind:'agent'}` — byte-identical to the pre-wiring build. Covered
by `test/bin-masterplan.test.mjs` (qctl-positive, non-covering negative control,
malformed-JSON) and `test/wave.test.mjs` (lib-level 6-arg `prepareWave`).

**Operator action that remains:** at flip time the operator MUST actually pass
`--repos-allowlist` on each `mp prepare-wave` invocation (the loader is plumbed,
but the shell does not auto-read `repos.yml` — it is supplied per call):

```
# shell: load and parse the allowlist
REPOS_ALLOWLIST=$(python3 -c 'import yaml,json,sys; print(json.dumps(yaml.safe_load(sys.stdin)))' \
  < scripts/qwen-fabric/config/repos.yml)

# pass as --repos-allowlist to mp prepare-wave
mp prepare-wave --wave N --repos-allowlist "$REPOS_ALLOWLIST"
```

The `qctlEligible` predicate then enforces that every file in a task's declared
scope falls within an allowlist entry's scope globs before the task is routed
to `{kind:'qctl'}`.

Confirm: `--repos-allowlist` flag is parsed in `bin/masterplan.mjs` AND
`prepareWave` is called with the loaded `reposAllowlist` as its sixth argument.
The single authoritative source for allowlist entries is
`scripts/qwen-fabric/config/repos.yml` (consumed by both fabric workers and
masterplan's eligibility predicate — do not duplicate).

---

## How to flip

Once all five items above are confirmed:

1. Open the bundle's `state.yml`.
2. Set `implementer.qctl.enabled: true` (must be boolean `true`, not the string
   `"true"`).
3. Commit with a message that references which preconditions were verified and by
   whom.
4. Monitor the first wave that routes tasks to `{kind:'qctl'}` — watch D0
   observability for anomalies and have rollback ready.

Flipping the flag in a bundle where the `reposAllowlist` is not wired (precondition 5)
causes `qctlEligible` to reject every task (empty allowlist → no file covered →
returns `false`) and downgrade all `{kind:'qctl'}` routes to `{kind:'agent'}`.
The result is a silent no-op: no `qctl` tasks run, no error is surfaced. Wiring
precondition 5 first prevents this silent fallback.
