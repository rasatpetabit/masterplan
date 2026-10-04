# Plan 07 Task 5 — C7/panel integration evidence

Task label: `p07-t5-c7`. Build-only handoff; not independent review, integration, release or activation approval.

## Source identities and entry gate

- Masterplan worktree: `/srv/dev/ras/masterplan/.worktrees/model-routing-07`.
- Branch: `model-routing/07-masterplan`.
- Entry HEAD: `c153a9115c7780f0c92010d38a85cdf809557a64`.
- Entry `git status --short`: empty, exit 0.
- `/proc/*/cwd` scan against this worktree: only the executing shell and its scan child; no other writer found.
- Read-only joint checkout (`W`): `/srv/workflows/.worktrees/model-routing-r1`.
- `git -C "$W" rev-parse HEAD`: `005d0e500573872cd716dc3cc5f648986b9bf70a`, exit 0.
- `git -C "$W" merge-base --is-ancestor c5c5de62 HEAD`: exit 0. Accepted plan 04 T8 is present.
- Read the named plan Task 5, common brief, full design spec, amendments X22/X22a, root INTENT, development conventions, diagnosing-bugs skill and hooks README.
- INTENT judgment: serves. Real evidence replaces a missing integration placeholder, without moving panel ownership into masterplan.

## Inventory and implementation

Searched `test/` with `rg -n 'skip\\s*:|\\.skip\\(|process.env.W|WORKFLOWS' test` and searched panel/C7/coordinator references. Exactly one missing-plan-04-T8 skip existed: the empty `Task 8 panel coordinator integration: C7 isolated counters exhaust the same subject` test in `test/dispatch-wave.native.test.mjs` (entry line 205). Other conditional skips are host-local interview/schema/goal/repo fixtures, not this dependency. No second C7 conditional skip was found.

Prior-art search found plan 04's `dispatch-panel-execution.test.ts`, `dispatch-admission.test.ts`, pure `executePanel`, native `resolvedReviewSpec`/`admitReviewLaunch`, and shared C3 receipt lifecycle. Reused these accepted interfaces; copied no plan 04 source and added no resolver/coordinator to masterplan. No upstream feature discovery was needed beyond the operator-named accepted implementation and shared contracts.

The former placeholder now creates real masterplan critical-review descriptors across ordinary and committed-recovery producer paths. Each launch changes artifact/job identity, attempt and token; committed recovery also changes HEAD. Descriptor assertions bind current `job_id`/`diff_sha` to the emitted artifact while keeping the persisted subject and emitting exactly one model-free descriptor.

A test-only helper imports accepted modules by absolute file URL beneath `W/pi-subagents`, running with cwd there and `--import tsx`. Missing/relative/nonexistent W or missing modules/exports fails, never skips or falls back to an installed checkout. This is the plan's existing W contract, newly wired into the former empty test. All subsequent full suites must export the recorded W.

Real native C7 admission expands the resolved panel at its owned boundary. Real C5 `executePanel` owns seats/recovery/adjudication, using injected synthetic runners only. This does not launch live Pi/provider processes or exercise full native child-process execution. The helper verifies:

- Policy-derived ceiling (8 here), never a copied budget literal.
- Three reports and one adjudication on complete panels.
- One recovered seat, cumulative C3 receipt, and no second round for the same launch ID.
- Incomplete panel retains two reports and an unfilled seat, with no adjudicator.
- C3 raw subject preserved in seats and adjudicator; served model/effort and attempt served effort null until synthetic observed output supplies them.
- Native C7 accounting in a disposable SQLite database has exactly one stable hook-owned counter; each logical panel consumes exactly one round.
- Primary and linked-worktree cwd alternate without splitting the subject budget; bounded reviewer wording changes too.
- Ninth launch is refused before any synthetic runner starts: zero denied children.

No Task 5 implementation failure surfaced, so no production-code repair was required. One test-development assertion initially expected a raw subject as the SQLite key; accepted hooks intentionally hash that key. Corrected the assertion to retain and compare the hook-owned key, not duplicate its hashing algorithm. That diagnostic run exited 1 (0 pass / 1 fail / 0 skip); it was a test assumption, not a product defect.

## Exact verification commands, exits and counts

All commands below ran from the masterplan worktree. Every temporary HOME was removed after the invocation. MP_DISPATCH_MAP was unset. Helper Python processes explicitly unset PYTHONOPTIMIZE and set PYTHONDONTWRITEBYTECODE=1; TSX_DISABLE_CACHE=1 prevents compilation cache writes in the dependency checkout.

### Focused C7 integration

```bash
H=$(mktemp -d)
env -u MP_DISPATCH_MAP HOME="$H" W=/srv/workflows/.worktrees/model-routing-r1 \
  node --test --test-name-pattern='Task 8 panel coordinator integration' \
  test/dispatch-wave.native.test.mjs > /tmp/p07-t5-c7-focused.log 2>&1
rc=$?
rm -rf "$H"
cat /tmp/p07-t5-c7-focused.log
echo EXIT:$rc
```

Exit **0**; **1 pass / 0 fail / 0 skip** (final rerun duration 6336.274275 ms).

Decisive output:

```text
# C7 panel evidence: {"admissions":8,"denials":1,"deniedChildren":0,"complete":7,"incomplete":1,"recoveryAttempts":1,"subject":"/tmp/mp-native-Upsayi/main::docs/masterplan/c7-panel-episode/wave-1/task-1"}
# tests 1
# pass 1
# fail 0
# skipped 0
```

### Fail-closed configuration control

```bash
H=$(mktemp -d)
env -u MP_DISPATCH_MAP -u W HOME="$H" \
  node --test --test-name-pattern='Task 8 panel coordinator integration' \
  test/dispatch-wave.native.test.mjs > /tmp/p07-t5-c7-missing-w.log 2>&1
rc=$?
rm -rf "$H"
tail -22 /tmp/p07-t5-c7-missing-w.log
echo EXIT:$rc
test "$rc" -eq 1
```

Node exit **1**, expected refusal: **0 pass / 1 fail / 0 skip**. Control assertion exit 0. Decisive diagnostic: `W must name the absolute joint integration checkout`.

### Requested Task 5 suites, including CLI surface

```bash
H=$(mktemp -d)
env -u MP_DISPATCH_MAP HOME="$H" W=/srv/workflows/.worktrees/model-routing-r1 \
  node --test test/dispatch-wave.native.test.mjs test/plan-work-item.test.mjs \
  test/continue.test.mjs test/wave.test.mjs test/dispatch.test.mjs \
  test/cli-surface.test.mjs > /tmp/p07-t5-c7-targeted.log 2>&1
rc=$?
rm -rf "$H"
tail -18 /tmp/p07-t5-c7-targeted.log
echo EXIT:$rc
```

Exit **0**; **236 pass / 0 fail / 0 skip**, 1 suite, duration 45835.519303 ms.

### Full isolated-HOME suite

```bash
H=$(mktemp -d)
env -u MP_DISPATCH_MAP HOME="$H" W=/srv/workflows/.worktrees/model-routing-r1 \
  node --test test/*.test.mjs > /tmp/p07-t5-c7-full.log 2>&1
rc=$?
rm -rf "$H"
tail -18 /tmp/p07-t5-c7-full.log
echo EXIT:$rc
```

Exit **0**; **3021 pass / 0 fail / 0 skip**, 4 suites, duration 161062.490161 ms. Entry evidence was 3020 pass / 0 fail / 1 skip: the single placeholder is now exercised, not deleted or replaced with another skip.

## Decisions, constraints and residual handoff

No new product or architecture choice; reused plan 07's W loading contract, plan 04 C5/native admission and C3, and isolated C7 storage. No historical receipt migration/binding, operator episode dispositions or real-bundle changes. No model IDs added outside synthetic fixtures; selection stays in accepted C2/C5.

No other worktree writes, systemd manager, namespace/container execution, production requests, live key store, deployment/install/restart/activation, ansible, merge or push. Hindsight recall/retain would require a prohibited production-service request and was not performed; this file/WORKLOG is durable handoff, not canonical memory retention. No independent review launched or invented: the eight-round boundary in X22a remains operator adjudication. Existing mixed-batch repair remains unreviewed. DF-4 and other pre-existing deferred work stay outside this build brief.

Build work complete and tested. Broader Task 6–8 work, full native child-process execution, independent acceptance, integration and activation remain separate gates, not evidence supplied here.
