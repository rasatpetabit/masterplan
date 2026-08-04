# Pi native-spawn wave E2E report

Fixture: `/tmp/claude-1000/-home-ras/d7f4b03d-c361-4d10-84c6-28ba68fefb62/scratchpad/toy-native-wave`  
Evidence directory: `/tmp/claude-1000/-home-ras/d7f4b03d-c361-4d10-84c6-28ba68fefb62/scratchpad/task11-evidence`

The documented command was run first exactly as requested. On this Pi process it did **not** select native spawn because `PI_CODING_AGENT=true` made `codexSuppressed=true`, which outranks `MP_DISPATCH_NATIVE_SPAWN=1`. Its saved output (`native-plan.json`) was:

```text
outcome=dispatched; task 1 done; task 2 blocked ("broker error during dispatch_task"); task 3 done
```

After restoring both fixture loci to `ad45a92f423166647ae353a033f73080e57be4bd`, I reached the branch under test with the explicit workaround `PI_CODING_AGENT=false MP_DISPATCH_NATIVE_SPAWN=1 MP_DISPATCH_WAVE_CONCURRENCY=2`. That returned:

```text
outcome=native-spawn-plan awaiting_launch=True wave=1
token=mp-wave-toy-native-wave-w1-a1 concurrency=2 tasks=3
```

## A1 — zero per-child `dispatch_task`

**Result: MET for the actual native-spawn wave.**

I inspected the structured Pi parent-session JSONL, not a raw text grep, because the prompt and source excerpts themselves contain the string `dispatch_task`.

```text
session=/home/ras/.pi/agent/sessions/--srv-dev-ras-masterplan--/2026-08-04T23-31-42-972Z_019fcf1e-62fc-7e76-8177-0348d74b42f4.jsonl
native_wave_byte_window=[508578,981876) bytes=473298 records=26
exact_dispatch_task_tool_calls=0
tool_counts={'bash': 2, 'ctx_execute': 5, 'read': 2, 'subagent': 4, 'task_list': 1, 'write': 1}
```

This is the observed **zero per-child dispatch_task** result for the window beginning with the native parallel `subagent` launch and ending with the native `record-result` call. The earlier exact documented command is excluded from this native window and is reported separately as a finding because it took the MCP-pool path.

## A2 — detailed TUI badges

**Result: MET.**

The native plan resolved all three descriptors to agent `builder`, lane `litellm/dispatch-agentic-loop`, effort `high`, with descriptor badge `{class: masterplan-implementation, backend: gateway, model: grok-4.5, effort: high}`. The Pi job UI rendered these detailed child lines rather than bare task labels:

```text
builder | litellm/dispatch-agentic-loop | high | src/alpha.txt (builder) running (dispatch-agentic-loop · thinking high)
builder | litellm/dispatch-agentic-loop | high | src/beta.txt  (builder) running (dispatch-agentic-loop · thinking high)
builder | litellm/dispatch-agentic-loop | high | src/gamma.txt (builder) pending (dispatch-agentic-loop · thinking high)
```

The strings expose lane pin, effort, agent role, and per-child scope.

## A3 — `record-result` transaction unchanged

**Result: NOT MET.**

All three real children edited and verified their declared files, but the verbatim descriptors also instructed `Commit locally in your locus`. The children therefore moved the worktree HEAD through three commits before `record-result`:

```text
d7c5911 task11: mark alpha complete       src/alpha.txt
01b2831 task2: set src/beta.txt to BETA-DONE
8a4cfe7 task3: set src/gamma.txt to GAMMA-DONE
```

The exact `record-result` JSON was:

```json
{"outcome":"recorded","mode":"record","wave":1,"recorded":[1,2,3],"failed":[],"qctl":[],"blocking_reviews":[],"scope":{"ok":true,"touched":[],"outOfScope":[]},"watch":{"ok":false,"checked":true,"violations":[{"repo":"/tmp/claude-1000/-home-ras/d7f4b03d-c361-4d10-84c6-28ba68fefb62/scratchpad/toy-native-wave","path":"docs/masterplan/toy-native-wave/.owner.hb.epyc2.d7f4b03d-c361-4d10-84c6-28ba68fefb62","reason":"MAIN changed outside the controller's transaction files: docs/masterplan/toy-native-wave/.owner.hb.epyc2.d7f4b03d-c361-4d10-84c6-28ba68fefb62"},{"repo":"/tmp/claude-1000/-home-ras/d7f4b03d-c361-4d10-84c6-28ba68fefb62/scratchpad/toy-native-wave/.worktrees/toy-native-wave","path":"(HEAD)","reason":"watched repo HEAD moved during the wave: ad45a92f423166647ae353a033f73080e57be4bd -> 8a4cfe77ff308e1c197f715f0020a6b0b039e7ea — a child committed"}]},"reverted":[],"wsLoose":[],"commits":{"code":null,"state":"7ffd3dfa15a9ff5df9fbd02ed1de28704d4a478c"},"cleared":true,"next":{"action":"complete"}}
```

Resulting loci:

```text
MAIN:
7ffd3df (HEAD -> main) masterplan(toy-native-wave): wave 1 state (record)
ad45a92 toy bundle: seed + plan

WORKTREE:
8a4cfe7 task3: set src/gamma.txt to GAMMA-DONE
01b2831 task2: set src/beta.txt to BETA-DONE
d7c5911 task11: mark alpha complete
ad45a92 toy bundle: seed + plan

active_run: null
files: ALPHA-DONE / BETA-DONE / GAMMA-DONE
```

The state-side commit, marker clear, and `next:{action:"complete"}` occurred, but the standard split transaction did **not** create the code-side commit (`commits.code:null`) because children had already committed. The watch correctly reported the HEAD move. Therefore A3 fails.

## A4 — concurrency bound honoured

**Result: MET.**

At `2026-08-04T23:40:13Z`, Pi reported:

```text
parallel group: 2 agents running · 0/3 done
alpha running
beta running
gamma pending
```

At `2026-08-04T23:40:47Z`, after beta had become terminal, Pi reported:

```text
parallel group: 2 agents running · 0/3 done · 1 failed
alpha running
beta failed
gamma running
```

Thus the third child did not become live until a slot opened. No observation showed three live children; the configured hard bound of two was observed directly.

## A5 — integrity vectors

**Result: MET (5/5 vectors produced vector-specific structured failures).**

Each vector started from fixture SHA `ad45a92f423166647ae353a033f73080e57be4bd`, re-ran `mp continue`, and re-armed the native watch baseline. Post-launch vectors were planted by fresh Pi `sweeper` children. `record-result` exits zero but returns `watch.ok:false`; the exact vector-specific violation is quoted below.

### 1. Uncommitted MAIN write

Plant command:

```bash
printf 'MAIN-BREACH\n' > child-main.txt
```

Observed child status: `?? child-main.txt`.

Wave result:

```text
watch.ok=false
path=child-main.txt
reason=MAIN changed outside the controller's transaction files: child-main.txt
```

### 2. Staged-only change

Plant command:

```bash
printf 'STAGED-BREACH\n' > child-staged.txt && git add child-staged.txt
```

Observed child status: `A  child-staged.txt`.

Wave result:

```text
watch.ok=false
path=child-staged.txt
reason=MAIN changed outside the controller's transaction files: child-staged.txt
```

### 3. MAIN commit with clean child delta

Plant command:

```bash
git commit --allow-empty -m 'vector3 child MAIN commit'
```

Observed HEAD: `994d9950f195e6af899ccb279ae4fadaf795ded7`; porcelain excluding the controller-owned dirty `state.yml` was empty.

Wave result:

```text
watch.ok=false
path=(HEAD)
reason=watched repo HEAD moved during the wave: ad45a92f423166647ae353a033f73080e57be4bd -> 994d9950f195e6af899ccb279ae4fadaf795ded7 — a child committed
```

### 4. Dirty-file overwrite precheck

Plant command, before `dispatch-wave`:

```bash
TOY=/tmp/claude-1000/-home-ras/d7f4b03d-c361-4d10-84c6-28ba68fefb62/scratchpad/toy-native-wave
printf 'USER-WIP\n' > "$TOY/.worktrees/toy-native-wave/src/alpha.txt"
```

The frozen baseline contained `src/alpha.txt`. No child was launched. Dispatcher result:

```text
outcome=precheck-failed
dispatched=false
path=src/alpha.txt
xy=.M
reason=task-scoped file was already dirty when this run started — dispatching would overwrite uncommitted user work (CD-2)
```

### 5. Watch-listed sibling write

A scratch sibling repo was seeded at `.../scratchpad/toy-native-sibling`. The active run scope was expanded through `mp set-active-run` to name the sibling's absolute `allowed.txt`; the saved watch baseline listed the sibling repo at HEAD `53e0e162efd822941ab820773bbfe014dd8c360c`. A child then modified a different tracked file:

```bash
printf 'SIBLING-BREACH\n' > other.txt
```

Observed child status: `M other.txt`.

Wave result:

```text
watch.ok=false
repo=/tmp/claude-1000/-home-ras/d7f4b03d-c361-4d10-84c6-28ba68fefb62/scratchpad/toy-native-sibling
path=other.txt
reason=file created during the wave but is outside every task scope
```

The vector was detected, though the reason misclassified a tracked modification as creation and the transaction did not restore the sibling file; I restored and removed the scratch sibling manually.

## Findings

1. **Native force flag is ineffective under the normal Pi environment.** `PI_CODING_AGENT=true` makes `shouldSuppressWorkflow` return true; `selectLaunchPath` checks `codexSuppressed` before the environment force flag. The exact requested command entered MCP-pool dispatch. Native spawn required the test-only workaround `PI_CODING_AGENT=false`.
2. **Native descriptors have `cwd:null`.** I had to supply the already-created worktree path at the Pi harness call boundary.
3. **Descriptor/transaction contradiction.** The verbatim native prompt says `Commit locally in your locus`, while cross-locus integrity correctly rejects any child HEAD movement. This caused A3 to fail.
4. **Handle promotion is not durable in the dispatch record.** Three successful `mp promote-run` calls overwrote the single `active_run.task_id`; after recording, `wave-1.dispatch.json` still showed `status:'pending'` and `handles:[]`.
5. **All three child executions were rejected by Pi's acceptance validator** because claimed shell commands lacked matching structured child tool calls, even though the files, commits, and independent greps proved the mutations occurred.
6. **Builder wrapper widened scope outside the fixture.** Children created `/srv/dev/ras/masterplan/progress.md`; it was untracked and was removed. No product file other than this report remains from that wrapper write.
7. **Owner heartbeat is reported as a watch breach.** Every post-launch `record-result` included the controller's own `.owner.hb...` path as `MAIN changed outside the controller's transaction files`, independently of the planted vector.
8. **Sibling breach cleanup is incomplete.** The sibling violation was detected, but absolute-scope mapping reported the tracked modification as `file created` and left `other.txt` dirty; cleanup required an explicit reset.

E2E: FAIL — 4/5 assertions met
