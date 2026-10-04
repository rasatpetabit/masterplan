# Gateway outage (nested systemd) and wave-isolation work in flight (2026-09-29)

## Objective and authorization

Make `/codebase-simplify` work end to end (operator: "fix all of it!!!"). Approved this session:
push masterplan main as reviewed commits land; land the #21 brief-vs-tools rule through the
`/srv/workflows` worktree route; install (not release) the first masterplan release that carries
`460e1b5` — no standalone v10.0.15 (it ships with the model-routing plan 07 session's release);
deploy the gateway dispatch vocabulary when idle (blocked on the litellm owner, todo #32).

## Verified current state (checked 2026-09-29 ~01:05 PDT)

| Fact | Command | Observation |
|---|---|---|
| Gateway down | `curl -m 8 http://127.0.0.1:4000/health/liveliness` (also :4001 :4002 :4010, 192.168.100.200:4000) | `000`, refused in <1 ms |
| Host PID 1 unreachable | `systemctl show … litellm-gateway-proxy` | `Failed to connect to system scope bus via local transport: Connection refused` |
| Sockets replaced | `stat -c %y /run/systemd/{private,notify,journal/socket} /run/dbus/system_bus_socket` | 00:47:02, 00:47:02, 00:47:02, 00:47:13 |
| Cause | `sudo journalctl --since 00:46:56 --until 00:47:40` | 00:47:01 `sudo … timeout 5 unshare -m -p -f --mount-proc sh -c 'mount --make-rprivate /; exec /usr/lib/systemd/systemd --system'` (PWD `/srv/dev/petabit/litellm`); a nested systemd then booted a full unit set (udevd, resolved, ufw, netplan, tmpfiles-setup, litellm-gateway-proxy, kimi-code sidecar, getty) against the shared `/run` |
| Symptom | `ps` | systemd restarting gateway containers in a loop (`podman rm -v -f -i litellm`, `podman run --name litellm-external … --sdnotify=conmon`) |
| masterplan | `git rev-parse --short main origin/main` | local `7197a42` (docs, unpushed), origin `460e1b5` |
| behavior-skills | `git ls-remote origin refs/heads/main` | `5f42072` (#35 landed) |
| wave-isolation | `git -C /srv/dev/ai/behavior-skills/.worktrees/wave-isolation log --oneline -3` | `6b8d3ab`, `a07f6b0`, `ef06c0a`; clean |
| #21 | `git -C /srv/workflows/.worktrees/brief-tools-rule log -1` | `b29004cd` (judge SOUND), 5 behind origin/master, no file overlap |

Every subagent, workflow agent and `advisor()` call fails with "Connection error." until the
gateway is back.

## Environment changes + restore

None by this session this turn. Frame stack: frame 2 (behavior-skills, #36/#37) is open; the lane
gate refuses `/srv/workflows` writes until it pops.

## In flight

Nothing running. The last two children failed on the outage: judge `a9910006` (round-2 review) and
engineer `97fc48e1` (review-3 test gap; made no commits).

## Key findings

- **#36/#37 round 2 (partial, judge gpt-6-astra before the outage):** npm test 1315/1315,
  typecheck, `VERIFY_OK`; reverting the finding-1, 2, 4 and 5 fixes each turns its `review-N`
  test red, but reverting the finding-3 positional-ingestion fix leaves all five green —
  `review-3` does not narrow before the sibling is ingested. Its "branch removes loader-parity"
  remark is an artifact of origin/main moving to `5f42072`; the branch base is `364b620`.
- **#34:** landed at `460e1b5`; round-1 judge UNSOUND (malformed class primaries) fixed test-first,
  re-review SOUND.
- Rejected: removing legacy narrowing (advisor: it strands `424df1b4`); parallel writers on the
  wave-isolation fixes (shared attempt provenance).

## Risks and gating items

- Recovering PID 1's sockets is an operator decision (reboot vs re-exec). Whoever ran the nested
  systemd must not repeat it: `unshare -m` with `--make-rprivate` does not isolate `/run`.
- Do not deploy wave-isolation before a frontier review passes on the corrected `review-3`.

## Next steps

1. After the gateway answers (`curl …:4000/health/liveliness` = 200), rerun the review-3 engineer
   brief (make `review-3` narrow before sibling ingestion; full mutation table), then a round-3
   frontier review of `origin/main(364b620)..fix/wave-isolation`.
2. On SOUND: rebase onto `5f42072`, check `git range-diff`, npm test, push, deploy from a clean
   clone, `hookctl stack check` then `pop`.
3. Finish `424df1b4` in the owning session: `codebase_run status` → `advance` → `retry`
   (narrowed to step 8) → issue exactly the returned dispatch as one async call → `advance` to done.
4. Rebase and land `b29004cd` via `/srv/workflows/.worktrees/brief-tools-rule`, then
   `git -C /srv/workflows pull --ff-only`.
5. Push `7197a42` with the next approved masterplan push; install plan 07's release (todo #38).

## User preferences and corrections

No AUQ for agent-doable mechanics; no wasteful model lineups; do not celebrate a small diff as
the outcome; evidence before "done".
