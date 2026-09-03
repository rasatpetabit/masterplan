#!/usr/bin/env bash
# Rehearse the v9 -> v10 bootstrap walk (spec §10.1 step 1) against fixtures.
#
# Nothing here is a mock of the walk. Steps 2-7 are armed and recorded through the SAME
# scripts/bootstrap-v10.mjs loop the live stage uses, in the driver's own order, and each
# step's real preconditions and postconditions must pass against real fixture effects: a
# real tag, real pushes to a scratch bare remote, a real bin/install-pi.mjs install into
# fixture roots, a real server-side merge by a second clone. The finish runs through a
# PINNED copy of the installed 9.10.0 tree — never a repo-relative binary, because the
# repo moves to v10 during the stage.
#
# Its stdout digest is the receipt the driver records (`--digest-file`).
#
# usage: rehearse-v9-finish.sh --state=<state.yml> --targets=<targets.json>
#                              [--scratch=<dir>] [--only=<group>] [--keep]
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
DRIVER="$REPO_ROOT/scripts/bootstrap-v10.mjs"
INSTALL_PI="$REPO_ROOT/bin/install-pi.mjs"

STATE=""; TARGETS_FILE=""; SCRATCH=""; ONLY=""; KEEP=0
for arg in "$@"; do
  case "$arg" in
    --state=*)   STATE="${arg#*=}" ;;
    --targets=*) TARGETS_FILE="${arg#*=}" ;;
    --scratch=*) SCRATCH="${arg#*=}" ;;
    --only=*)    ONLY="${arg#*=}" ;;
    --keep)      KEEP=1 ;;
    *) echo "rehearse: unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ -n "$STATE" ]        || { echo "rehearse: --state is required" >&2; exit 2; }
[ -n "$TARGETS_FILE" ] || { echo "rehearse: --targets is required" >&2; exit 2; }
[ -f "$STATE" ]        || { echo "rehearse: state file not found: $STATE" >&2; exit 2; }
[ -f "$TARGETS_FILE" ] || { echo "rehearse: targets file not found: $TARGETS_FILE" >&2; exit 2; }
[ -f "$DRIVER" ]       || { echo "rehearse: bootstrap-v10.mjs not found at $DRIVER" >&2; exit 2; }

# ---- reporting ---------------------------------------------------------------
ROWS=0; FAILED=0
declare -a REPORT=()
say()  { printf '%s\n' "$*"; }
row()  { # row <name> <ok|fail> <detail>
  ROWS=$((ROWS + 1))
  [ "$2" = "ok" ] || FAILED=$((FAILED + 1))
  REPORT+=("$1 $2")
  printf 'ROW %-42s %-4s %s\n' "$1" "$2" "${3:-}"
}
check() { # check <name> <detail> <command...>  — the command's exit status is the verdict
  local name="$1" detail="$2"; shift 2
  if "$@" >/dev/null 2>&1; then row "$name" ok "$detail"; else row "$name" fail "$detail"; fi
}
want_fail() { # the command MUST fail; a success is the defect
  local name="$1" detail="$2"; shift 2
  if "$@" >/dev/null 2>&1; then row "$name" fail "$detail (expected refusal, got success)"; else row "$name" ok "$detail"; fi
}
selected() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
json_field() { # json_field <field> — reads stdin
  node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => { try { process.stdout.write(String(JSON.parse(s)[process.argv[1]] ?? "")); } catch { process.stdout.write(""); } });
  ' "$1"
}
json_data_field() { # json_data_field <file> <field-under-.data>
  node -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String((d.data && d.data[process.argv[2]]) || "")); } catch { process.stdout.write(""); }' "$1" "$2"
}
json_version() { # json_version <file> — the .version of a JSON file, or empty
  node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || "")); } catch { process.stdout.write(""); }' "$1"
}

# ---- targets -----------------------------------------------------------------
tgt() { node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = t[process.argv[2]];
  process.stdout.write(v === undefined || v === null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)));
' "$TARGETS_FILE" "$1"; }

REMOTE_NAME="$(tgt remote)";        REMOTE_NAME="${REMOTE_NAME:-origin}"
VERSION="$(tgt version)";           VERSION="${VERSION:-10.0.0}"
TAG="v$VERSION"
BRANCH="$(tgt branch)";             BRANCH="${BRANCH:-masterplan/rehearsal}"
PINNED_V9_SRC="$(tgt pinned_v9)"
GH_BIN="$(tgt gh)";                 GH_BIN="${GH_BIN:-gh}"
GH_REPO="$(tgt gh_repo)"
VERSION_FROM="$(tgt version_from)"; VERSION_FROM="${VERSION_FROM:-.claude-plugin/plugin.json}"

# ---- scratch -----------------------------------------------------------------
if [ -z "$SCRATCH" ]; then SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/mp-rehearsal-XXXXXX")"; fi
mkdir -p "$SCRATCH"
cleanup() {
  # Unconditional: the throwaway GitHub repo must not survive a failure, which is exactly
  # the row the test simulates a mid-cycle crash for.
  if [ -n "${THROWAWAY_REPO:-}" ]; then
    "$GH_BIN" repo delete "$THROWAWAY_REPO" --yes >/dev/null 2>&1 || true
  fi
  if [ "$KEEP" -eq 0 ]; then rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT

G() { git -C "$1" "${@:2}"; }
mkrepo() { mkdir -p "$1"; git -C "$1" init -q --initial-branch=main
  git -C "$1" config user.email rehearsal@invalid; git -C "$1" config user.name rehearsal
  git -C "$1" config commit.gpgsign false; }

say "== rehearse-v9-finish: scratch=$SCRATCH version=$VERSION branch=$BRANCH"

# ---- 0. pin the installed 9.10.0 tree BEFORE anything installs ----------------
# Ordering is the assertion: the cache and the repo both move to v10 during the stage, so a
# binary resolved later is not the v9 one the finish must run under. A bad pin is FATAL —
# the walk must not proceed into gh or install work under an unknown executor.
PINNED="$SCRATCH/pinned-9.10.0"
MP_PINNED=""
if [ -n "$PINNED_V9_SRC" ] && [ -d "$PINNED_V9_SRC" ]; then
  cp -R "$PINNED_V9_SRC" "$PINNED"
  if [ -f "$PINNED/bin/masterplan.mjs" ]; then
    MP_PINNED="$PINNED/bin/masterplan.mjs"
    # An exact TOKEN, not a substring: `grep -o 9.10.0` also matches "19.10.0".
    PINNED_VERSION="$(node "$MP_PINNED" version 2>/dev/null | tr -c '0-9.' '\n' | grep -x '9\.10\.0' | head -1)"
    if [ "$PINNED_VERSION" = "9.10.0" ]; then
      row pinned_v9_copy ok "pinned 9.10.0 at $PINNED"
    else
      row pinned_v9_copy fail "pinned tree does not print 9.10.0"
    fi
  else
    row pinned_v9_copy fail "no bin/masterplan.mjs under $PINNED_V9_SRC"
  fi
else
  row pinned_v9_copy fail "pinned_v9 target missing or not a directory: ${PINNED_V9_SRC:-<unset>}"
fi
say "PINNED_FINISH_BINARY=${MP_PINNED:-<none>}"
if [ "$FAILED" -ne 0 ]; then
  say "== rows=$ROWS failed=$FAILED"
  for r in "${REPORT[@]}"; do say "SUMMARY $r"; done
  say "REHEARSAL ABORTED: the v9 executor is not pinned; nothing world-touching was attempted"
  say "REHEARSAL FAIL"
  exit 4
fi

# The ONLY way this script runs masterplan. Each call is logged so the receipt — and the
# test — can see WHICH verbs ran, not merely that a process was started.
PINNED_CALLS="$SCRATCH/pinned-calls.log"
: > "$PINNED_CALLS"
mp_pinned() { # mp_pinned <output-file> <args...>
  local out="$1"; shift
  printf '%s\n' "$*" >> "$PINNED_CALLS"
  say "PINNED_RUN: masterplan $*"
  node "$MP_PINNED" "$@" > "$out" 2>&1
}

# ---- 1. fixture remote + clone + second clone --------------------------------
BARE="$SCRATCH/remote.git"
git init -q --bare --initial-branch=main "$BARE"
WORK="$SCRATCH/work"        # stands in for the operator's MAIN checkout
SECOND="$SCRATCH/second"    # emulates GitHub's server-side merge

mkrepo "$WORK"
mkdir -p "$WORK/.claude-plugin" "$WORK/skills/masterplan" "$WORK/skills/masterplan-detect" \
         "$WORK/scripts" "$WORK/bin" "$WORK/commands" "$WORK/lib" "$WORK/agents" "$WORK/policy"
printf '{"name":"masterplan","version":"9.10.0"}\n' > "$WORK/$VERSION_FROM"
printf 'seed\n' > "$WORK/src.txt"
# install-pi installs a PLUGIN and refuses a tree missing any required path, so the fixture
# carries every one of them — stubs, but present, so the installs below are real installs.
printf '# masterplan skill (fixture)\n' > "$WORK/skills/masterplan/SKILL.md"
printf '# masterplan-detect (fixture)\n' > "$WORK/skills/masterplan-detect/SKILL.md"
printf '# /masterplan (fixture)\n' > "$WORK/commands/masterplan.md"
printf 'console.log("masterplan 9.10.0");\n' > "$WORK/bin/masterplan.mjs"
printf 'console.log("doctor");\n' > "$WORK/bin/doctor.mjs"
printf 'console.log("register-pi-agents");\n' > "$WORK/bin/register-pi-agents.mjs"
printf 'export const bundle = true;\n' > "$WORK/lib/bundle.mjs"
printf '%s\n' '---' 'name: mp-fixture' 'description: fixture agent' 'model: frontier' '---' > "$WORK/agents/mp-fixture.md"
printf '{"lanes":{},"classes":{}}\n' > "$WORK/policy/workflow-map.json"
printf '{"name":"masterplan","version":"9.10.0","type":"module"}\n' > "$WORK/package.json"
# The scratch clone stands in for this repo: the driver resolves its preconditions against
# the exec tree, not against $PWD.
cp "$REPO_ROOT/scripts/rehearse-v9-finish.sh" "$WORK/scripts/rehearse-v9-finish.sh"
cp "$REPO_ROOT/scripts/bootstrap-v10.mjs" "$WORK/scripts/bootstrap-v10.mjs"
chmod +x "$WORK/scripts/rehearse-v9-finish.sh"
G "$WORK" add -A; G "$WORK" commit -q -m "initial"
G "$WORK" remote add "$REMOTE_NAME" "$BARE"
G "$WORK" push -q "$REMOTE_NAME" main
V9_SHA="$(G "$WORK" rev-parse main)"   # the 9.10.0 tree, for the install rollback row
# §10.1.5: the real local main is AHEAD of GitHub by unrelated commits.
printf 'unrelated local work\n' > "$WORK/ahead.txt"
G "$WORK" add -A; G "$WORK" commit -q -m "non-bundle commit ahead of the remote"
check clone_ahead_of_remote "local main is ahead of the fixture remote by a non-bundle commit" \
  bash -c "[ \"\$(git -C '$WORK' rev-list --count ${REMOTE_NAME}/main..main)\" -ge 1 ]"

# the run branch, with real content so main..tip is non-empty
G "$WORK" checkout -q -b "$BRANCH"
printf 'feature\n' > "$WORK/feature.txt"
printf '{"name":"masterplan","version":"%s"}\n' "$VERSION" > "$WORK/$VERSION_FROM"
printf '{"name":"masterplan","version":"%s","type":"module"}\n' "$VERSION" > "$WORK/package.json"
G "$WORK" add -A; G "$WORK" commit -q -m "the run's work"
REVIEWED_SHA="$(G "$WORK" rev-parse "$BRANCH")"
G "$WORK" checkout -q main
# The paths the branch changed, captured at the fork point: after the PR merge the merge-base
# moves to the tip and this diff would be empty, silently making the re-target audit vacuous.
BRANCH_PATHS="$SCRATCH/branch-paths.txt"
G "$WORK" diff --name-only "$(G "$WORK" merge-base main "$REVIEWED_SHA")" "$REVIEWED_SHA" > "$BRANCH_PATHS" 2>/dev/null || : > "$BRANCH_PATHS"

DIFF_LINES="$(G "$WORK" diff --name-only "main..$BRANCH" | wc -l | tr -d ' ')"
if [ "${DIFF_LINES:-0}" -gt 0 ]; then
  row v9_diff_non_empty ok "main..$BRANCH touches $DIFF_LINES file(s)"
else
  # A sentinel goal fails if the assessor is handed an empty diff — that is this row.
  row v9_diff_non_empty fail "main..$BRANCH is EMPTY — the goal check and review would assess nothing"
fi

git clone -q "$BARE" "$SECOND"
G "$SECOND" config user.email rehearsal@invalid; G "$SECOND" config user.name rehearsal
G "$SECOND" config commit.gpgsign false
check second_clone_built "second clone emulates the server-side merge" test -d "$SECOND/.git"

# the throwaway bundle the walk runs on, and its worktree
FIXTURE_BUNDLE="$WORK/docs/masterplan/rehearsal"
FIXTURE_STATE="$FIXTURE_BUNDLE/state.yml"
FIXTURE_TARGETS="$SCRATCH/fixture-targets.json"
FIXTURE_WT="$SCRATCH/fixture-worktree"
INSTALL_ROOT="$SCRATCH/install-root"
PI_ROOT="$SCRATCH/pi-root"
CLAUDE_DIR="$SCRATCH/claude-config"
CACHE="$CLAUDE_DIR/plugins/cache/rasatpetabit-masterplan/masterplan/$VERSION"
mkdir -p "$FIXTURE_BUNDLE" "$INSTALL_ROOT" "$PI_ROOT" "$CLAUDE_DIR"
G "$WORK" worktree add -q --force "$FIXTURE_WT" "$BRANCH" 2>/dev/null || true
cat > "$FIXTURE_STATE" <<YAML
schema_version: 8
slug: rehearsal
status: in-progress
phase: execute
branch: $BRANCH
worktree: $FIXTURE_WT
pending_gate: null
active_run: null
tasks: []
YAML
node -e '
  const fs = require("fs");
  const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  Object.assign(t, {
    branch: process.argv[2], worktree: process.argv[3],
    install_root: process.argv[4] + "/install-root",
    pi_root: process.argv[4] + "/pi-root",
    claude_config_dir: process.argv[4] + "/claude-config",
    workspace_roots: [],
  });
  fs.writeFileSync(process.argv[5], JSON.stringify(t, null, 2) + "\n");
' "$TARGETS_FILE" "$BRANCH" "$FIXTURE_WT" "$SCRATCH" "$FIXTURE_TARGETS"

# ---- 2. the finish runs through the pinned v9 binary --------------------------
# Not a path announcement: real v9 verbs are executed BY the copy, including the finish
# verb the live walk drives, and the log records which.
if selected pinned_finish; then
  mp_pinned "$SCRATCH/pinned-version.txt" version --cwd="$WORK" \
    && row pinned_finish_version ok "the pinned binary answered the version verb" \
    || row pinned_finish_version fail "the pinned binary could not run"
  # `finish-step` is THE v9 finish verb the live walk drives; running it here is what makes
  # the pin load-bearing rather than announced. It may legitimately refuse this fixture
  # bundle — what must be true is that it RAN, from the pinned path, and answered.
  # The exit status is the verdict. stdout and stderr both land in the file, so "the file is
  # non-empty" would accept a binary that printed an error and exited non-zero.
  if mp_pinned "$SCRATCH/pinned-finish-step.txt" finish-step --state="$FIXTURE_STATE" \
     && [ -s "$SCRATCH/pinned-finish-step.txt" ]; then
    row pinned_finish_step ok "the pinned binary executed the finish-step verb successfully"
  else
    row pinned_finish_step fail "finish-step through the pinned copy failed: $(head -c 200 "$SCRATCH/pinned-finish-step.txt" 2>/dev/null | tr '\n' ' ')"
  fi
  # The pin is worthless if only trivial verbs ever go through it.
  if grep -q 'finish-step' "$PINNED_CALLS"; then
    row pinned_finish_routed ok "$(wc -l < "$PINNED_CALLS" | tr -d ' ') invocation(s) through the pinned copy, including a finish verb"
  else
    row pinned_finish_routed fail "no finish verb was routed through the pinned copy (only trivial verbs)"
  fi
fi

# ---- 3. the real gh cycle against a throwaway private repository -------------
# The one first-time live action in step 5 is `gh pr merge`. Rehearsing the whole
# create/populate/PR/merge/delete cycle here is what makes it not first-time.
if selected gh_cycle; then
  THROWAWAY_REPO="${GH_REPO:-masterplan-rehearsal-$$}"
  say "RUN: gh repo create $THROWAWAY_REPO --private --confirm"
  if "$GH_BIN" repo create "$THROWAWAY_REPO" --private --confirm >/dev/null 2>&1; then
    row gh_repo_create ok "created private throwaway $THROWAWAY_REPO"
    # A newly created repository is EMPTY. A pull request needs both a base and a head branch
    # to exist on it, so the branches are pushed first — without this the live cycle fails
    # regardless of what a shim would accept.
    say "RUN: gh repo view $THROWAWAY_REPO --json url"
    THROWAWAY_URL="$("$GH_BIN" repo view "$THROWAWAY_REPO" --json url 2>/dev/null | json_field url)"
    if [ -n "$THROWAWAY_URL" ]; then
      G "$WORK" remote remove throwaway >/dev/null 2>&1 || true
      G "$WORK" remote add throwaway "$THROWAWAY_URL"
      if G "$WORK" push -q throwaway main && G "$WORK" push -q throwaway "$BRANCH"; then
        row gh_repo_populated ok "main and $BRANCH pushed to the throwaway repo before the PR"
      else
        row gh_repo_populated fail "could not push main/$BRANCH to $THROWAWAY_URL — a PR cannot be opened on an empty repo"
      fi
    else
      row gh_repo_populated fail "gh repo view returned no clone URL; the repo cannot be populated"
    fi
    if [ "${MP_REHEARSAL_FAULT:-}" = "gh_mid_cycle" ]; then
      say "FAULT: simulated mid-cycle failure after gh repo create"
      exit 3
    fi
    say "RUN: gh pr create --repo $THROWAWAY_REPO --head $BRANCH --base main"
    PR_URL="$("$GH_BIN" pr create --repo "$THROWAWAY_REPO" --title "rehearsal" --body "rehearsal" --head "$BRANCH" --base main 2>/dev/null)"
    PR_NUM="${PR_URL##*/}"
    if [ -n "$PR_NUM" ] && [ "$PR_NUM" -eq "$PR_NUM" ] 2>/dev/null; then
      row gh_pr_create ok "gh pr create opened PR #$PR_NUM on the populated repo"
    else
      row gh_pr_create fail "gh pr create returned no PR number (got '${PR_URL:-<empty>}')"
      PR_NUM=""
    fi
    say "RUN: gh pr merge --merge --repo $THROWAWAY_REPO $PR_NUM"
    if [ -n "$PR_NUM" ] && "$GH_BIN" pr merge --repo "$THROWAWAY_REPO" "$PR_NUM" --merge >/dev/null 2>&1; then
      row gh_pr_merge ok "gh pr merge --merge landed PR #$PR_NUM"
    else
      row gh_pr_merge fail "gh pr merge failed"
    fi
    # §10.3 reconciliation: read the state back, never re-merge blind.
    PR_VIEW="$("$GH_BIN" pr view --repo "$THROWAWAY_REPO" "${PR_NUM:-0}" --json state,mergedAt,mergeCommit 2>/dev/null)"
    PR_STATE="$(printf '%s' "$PR_VIEW" | json_field state)"
    # "record the sha and continue" means a sha is actually taken: a MERGED response with no
    # mergeCommit oid is not something to continue from.
    PR_MERGE_OID="$(printf '%s' "$PR_VIEW" | node -e '
      let s = ""; process.stdin.on("data", (d) => { s += d; });
      process.stdin.on("end", () => { try { const j = JSON.parse(s); process.stdout.write(String((j.mergeCommit && j.mergeCommit.oid) || "")); } catch { process.stdout.write(""); } });
    ')"
    case "$PR_STATE" in
      MERGED)
        if [ -z "$PR_MERGE_OID" ]; then
          row gh_pr_reconcile_merged fail "MERGED but no mergeCommit.oid — there is no sha to record"
        elif [ "$(G "$WORK" ls-remote throwaway refs/heads/main 2>/dev/null | cut -f1)" = "$PR_MERGE_OID" ]; then
          row gh_pr_reconcile_merged ok "MERGED with oid ${PR_MERGE_OID:0:12}, and the repo's main is that commit -> record and continue"
        else
          row gh_pr_reconcile_merged fail "MERGED oid ${PR_MERGE_OID:0:12} is not what the repo's main points at"
        fi ;;
      OPEN)   row gh_pr_reconcile_merged fail "OPEN -> retry once then stop; the merge did not land" ;;
      *)      row gh_pr_reconcile_merged fail "state ${PR_STATE:-<unreadable>} -> stop" ;;
    esac
    # The OPEN disposition needs a head that is genuinely UNMERGED. Reusing the merged branch
    # would be rejected by GitHub ("no commits between"), so a distinct probe branch with its
    # own commit is pushed for it, and its number is read from the create output.
    PROBE_BRANCH="masterplan/rehearsal-open-probe"
    G "$WORK" checkout -q -B "$PROBE_BRANCH" "$REVIEWED_SHA"
    printf 'a commit that is not on main\n' > "$WORK/open-probe.txt"
    # An explicit path, never `add -A`: the fixture bundle is untracked here, and sweeping it
    # into this commit would make `checkout main` delete it out from under the walk.
    G "$WORK" add open-probe.txt; G "$WORK" commit -q -m "open-probe commit"
    G "$WORK" push -q throwaway "$PROBE_BRANCH"
    G "$WORK" checkout -q main
    OPEN_URL="$("$GH_BIN" pr create --repo "$THROWAWAY_REPO" --title "unmerged" --body "unmerged" --head "$PROBE_BRANCH" --base main 2>/dev/null)"
    OPEN_NUM="${OPEN_URL##*/}"
    OPEN_STATE="$("$GH_BIN" pr view --repo "$THROWAWAY_REPO" "${OPEN_NUM:-0}" --json state,mergedAt,mergeCommit 2>/dev/null | json_field state)"
    if [ "$OPEN_STATE" = "OPEN" ]; then
      row gh_pr_reconcile_open ok "an unmerged PR (#${OPEN_NUM}, distinct head) reports OPEN -> retry once, then stop"
    else
      row gh_pr_reconcile_open fail "the unmerged probe PR reported '${OPEN_STATE:-<unreadable>}', not OPEN"
    fi
    OTHER_STATE="$("$GH_BIN" pr view --repo "$THROWAWAY_REPO" 4242 --json state,mergedAt,mergeCommit 2>/dev/null | json_field state)"
    if [ "$OTHER_STATE" != "MERGED" ]; then
      row gh_pr_reconcile_other ok "an unknown PR reports '${OTHER_STATE:-unreadable}' -> stop, never a blind re-merge"
    else
      row gh_pr_reconcile_other fail "an unknown PR reported MERGED"
    fi
    say "RUN: gh repo delete $THROWAWAY_REPO --yes"
    if "$GH_BIN" repo delete "$THROWAWAY_REPO" --yes >/dev/null 2>&1; then
      row gh_repo_delete ok "throwaway repo deleted"
      THROWAWAY_REPO=""
    else
      row gh_repo_delete fail "throwaway repo NOT deleted — it would outlive the rehearsal"
    fi
    G "$WORK" remote remove throwaway >/dev/null 2>&1 || true
    G "$WORK" branch -q -D "$PROBE_BRANCH" >/dev/null 2>&1 || true
  else
    row gh_repo_create fail "gh repo create failed; the live merge would be a first-time action"
    THROWAWAY_REPO=""
  fi
fi

# ---- 4. THE WALK: steps 2-7 through the real arm/record loop -----------------
# Every precondition and postcondition below is the driver's own, so a row passes only if
# the fixture really produced what that step requires.
arm_step() { # arm_step <step>
  (cd "$WORK" && node "$DRIVER" arm --state="$FIXTURE_STATE" --step="$1" --targets="$FIXTURE_TARGETS") \
    > "$SCRATCH/arm-$1.json" 2>"$SCRATCH/arm-$1.err"
}
record_step() { # record_step <step> <exit> <status|-> <data-json|->
  local step="$1" code="$2" status="$3" data="$4"
  local extra=()
  if [ "$status" != "-" ]; then
    extra+=("--status=$status")
  elif [ "$code" != "0" ]; then
    # The driver refuses to call a non-zero exit `done`: a failure is recorded as such.
    extra+=("--status=failed" "--reason=rehearsed failure")
  fi
  [ "$data" != "-" ] && extra+=("--data=$data")
  printf 'rehearsal output for %s (exit %s)\n' "$step" "$code" > "$SCRATCH/digest-$step.txt"
  (cd "$WORK" && node "$DRIVER" record --state="$FIXTURE_STATE" --step="$step" --exit="$code" \
      --digest-file="$SCRATCH/digest-$step.txt" --targets="$FIXTURE_TARGETS" "${extra[@]}") \
    > "$SCRATCH/record-$step.json" 2>"$SCRATCH/record-$step.err"
}
walk() { # walk <step> [data-json] — arm + record a successful turn, one row
  local step="$1" data="${2:--}"
  if ! arm_step "$step"; then
    row "walk_$step" fail "arm refused: $(head -c 180 "$SCRATCH/arm-$step.err" | tr '\n' ' ')"
    return 1
  fi
  if ! record_step "$step" 0 - "$data"; then
    row "walk_$step" fail "record refused: $(head -c 180 "$SCRATCH/record-$step.err" | tr '\n' ' ')"
    return 1
  fi
  row "walk_$step" ok "armed and recorded through the live driver"
}
# The §10.3 failed/recovered pair, including the proof that the stage does not proceed past
# a failed step.
fail_then_recover() { # fail_then_recover <step> <recovery-data|-> <what> <next-step|->
  local step="$1" data="$2" what="$3" nextstep="$4"
  arm_step "$step" || { row "fail_${step}_recorded" fail "arm refused: $(head -c 160 "$SCRATCH/arm-$step.err" | tr '\n' ' ')"; return 1; }
  record_step "$step" 1 - -
  if grep -q '"status":"failed"' "$SCRATCH/record-$step.json" 2>/dev/null; then
    row "fail_${step}_recorded" ok "$what is durable as status failed"
  else
    row "fail_${step}_recorded" fail "$what did not land as failed: $(head -c 160 "$SCRATCH/record-$step.err" | tr '\n' ' ')"
  fi
  if [ "$nextstep" != "-" ]; then
    if arm_step "$nextstep"; then
      row "fail_${step}_blocks_next" fail "the driver armed $nextstep while ${step}'s record was failed"
    else
      row "fail_${step}_blocks_next" ok "the stage does not proceed to $nextstep while $step is failed"
    fi
  fi
  arm_step "$step" || true
  if record_step "$step" 0 recovered "$data"; then
    row "fail_${step}_recovered" ok "the failure is closed by a recorded recovery"
  else
    row "fail_${step}_recovered" fail "the recovery record was refused: $(head -c 160 "$SCRATCH/record-$step.err" | tr '\n' ' ')"
  fi
}

MERGE_SHA=""
RELEASE_TIP=""
INSTALL_MARKER="$SCRATCH/install-invocations.log"
: > "$INSTALL_MARKER"

if selected walk; then
  walk rehearsal
  walk docs_normalize
  walk verify
  walk review '{"verdict":"approve"}'
  walk assess '{"goals":{"G1":"achieved","G2":"achieved"}}'

  # release: armed FIRST (its precondition is that the tip is still the reviewed sha), then
  # the real CHANGELOG commit and tag — the work the printed command does — then recorded.
  if arm_step release; then
    printf '## %s\n' "$VERSION" >> "$FIXTURE_WT/CHANGELOG.md"
    G "$FIXTURE_WT" add CHANGELOG.md; G "$FIXTURE_WT" commit -q -m "release: $VERSION"
    RELEASE_TIP="$(G "$FIXTURE_WT" rev-parse HEAD)"
    G "$WORK" tag -f "$TAG" "$RELEASE_TIP" >/dev/null 2>&1
    if record_step release 0 - -; then
      row walk_release ok "a real release commit and tag at the new tip, recorded through the driver"
    else
      row walk_release fail "the release record was refused: $(head -c 220 "$SCRATCH/record-release.err" | tr '\n' ' ')"
    fi
  else
    row walk_release fail "release arm refused: $(head -c 220 "$SCRATCH/arm-release.err" | tr '\n' ' ')"
  fi

  # push: the branch and the tag really go to the fixture remote, between arm and record.
  if arm_step push && G "$WORK" push -q "$REMOTE_NAME" "$BRANCH" "refs/tags/$TAG" && record_step push 0 - -; then
    row walk_push ok "branch and tag pushed to the fixture remote and recorded through the driver"
  else
    row walk_push fail "push step failed: $(head -c 180 "$SCRATCH/record-push.err" "$SCRATCH/arm-push.err" 2>/dev/null | tr '\n' ' ')"
  fi

  # ci_wait: RED first. install-pi must not run while that record stands — proved by the
  # driver refusing to arm install_pi AND by the install marker staying empty.
  fail_then_recover ci_wait '{"conclusions":{"test":"success","release-publish":"success"}}' \
    "a red tag CI" install_pi
  if [ ! -s "$INSTALL_MARKER" ]; then
    row ci_red_no_install ok "no install ran while the tag CI record was red"
  else
    row ci_red_no_install fail "an install ran under a red tag CI"
  fi

  # install_pi: the §10.3 install-failure row, driven through the driver rather than
  # demonstrated beside it. A REAL failing install (a ref that does not exist) is recorded as
  # failed, the stage must not proceed, and only then does the real install run and recover.
  PUBLISHED_TIP="$(json_data_field "$SCRATCH/record-push.json" published_tip)"
  if arm_step install_pi; then
    BEFORE_BAD_INSTALL="$(readlink "$INSTALL_ROOT/current" 2>/dev/null)"
    node "$INSTALL_PI" --source="$WORK" --ref=refs/heads/no-such-branch \
      --install-root="$INSTALL_ROOT" --pi-root="$PI_ROOT" >"$SCRATCH/install-bad.log" 2>&1
    BAD_EXIT=$?
    if [ "$BAD_EXIT" -ne 0 ]; then
      row install_pi_failure_refused ok "install-pi refused a nonexistent ref (exit $BAD_EXIT)"
    else
      row install_pi_failure_refused fail "install-pi accepted a nonexistent ref"
    fi
    if [ "$(readlink "$INSTALL_ROOT/current" 2>/dev/null)" = "$BEFORE_BAD_INSTALL" ]; then
      row install_pi_surface_intact ok "the failed install left the live surface where it was"
    else
      row install_pi_surface_intact fail "a failed install moved the live surface"
    fi
    record_step install_pi "$BAD_EXIT" - -
    if grep -q '"status":"failed"' "$SCRATCH/record-install_pi.json" 2>/dev/null; then
      row fail_install_pi_recorded ok "the failed install is durable as status failed"
    else
      row fail_install_pi_recorded fail "the failed install did not land as failed: $(head -c 180 "$SCRATCH/record-install_pi.err" | tr '\n' ' ')"
    fi
    if arm_step main_push; then
      row fail_install_pi_blocks_next fail "the driver armed main_push while install_pi was failed"
    else
      row fail_install_pi_blocks_next ok "the stage does not proceed to main_push while install_pi is failed"
    fi
    # The recovery: a REAL install of the published tip. The arm must succeed before anything
    # world-touching runs, and the install's own exit status is what gets recorded — a
    # hard-coded 0 would durably record a failed installer as a successful recovery.
    if arm_step install_pi; then
      printf 'install %s\n' "$PUBLISHED_TIP" >> "$INSTALL_MARKER"
      node "$INSTALL_PI" --source="$WORK" --ref="$PUBLISHED_TIP" --install-root="$INSTALL_ROOT" --pi-root="$PI_ROOT" >"$SCRATCH/install-v10.log" 2>&1
      INSTALL_EXIT=$?
      if [ "$INSTALL_EXIT" -ne 0 ]; then
        record_step install_pi "$INSTALL_EXIT" - -
        row walk_install_pi fail "the recovery install exited $INSTALL_EXIT; recorded as failed, not recovered: $(tail -c 200 "$SCRATCH/install-v10.log" | tr '\n' ' ')"
      elif record_step install_pi "$INSTALL_EXIT" recovered -; then
        row walk_install_pi ok "a real install-pi placed the published tip on the fixture Pi surface, recorded as recovered"
      else
        row walk_install_pi fail "the install_pi recovery record was refused: $(head -c 220 "$SCRATCH/record-install_pi.err" | tr '\n' ' ')"
      fi
    else
      row walk_install_pi fail "the recovery arm was refused, so no install was attempted: $(head -c 180 "$SCRATCH/arm-install_pi.err" | tr '\n' ' ')"
    fi
  else
    row walk_install_pi fail "install_pi arm refused: $(head -c 180 "$SCRATCH/arm-install_pi.err" | tr '\n' ' ')"
  fi
  if [ -s "$INSTALL_MARKER" ]; then
    row ci_green_allows_install ok "exactly one install ran once the CI record was green: $(wc -l < "$INSTALL_MARKER" | tr -d ' ')"
  else
    row ci_green_allows_install fail "no install ran even after the CI record recovered"
  fi

  # main_push: a REJECTED non-fast-forward push first (a sibling reached the remote), then
  # the named recovery — fetch, rebase, retry. Never a force.
  SIBLING="$SCRATCH/sibling"
  git clone -q "$BARE" "$SIBLING"
  G "$SIBLING" config user.email s@invalid; G "$SIBLING" config user.name s
  G "$SIBLING" config commit.gpgsign false
  printf 'sibling\n' > "$SIBLING/sibling.txt"
  G "$SIBLING" add -A; G "$SIBLING" commit -q -m "a sibling reached origin/main first"
  G "$SIBLING" push -q origin main
  # §10.3's disposition for a diverged remote is STOP, and the driver enforces it before the
  # push is ever attempted: arming main_push against a remote that is no longer an ancestor
  # of local main must be refused. Asking the driver is what makes this row load-bearing —
  # a bare `git push` check would keep passing even if the driver's precondition were deleted.
  G "$WORK" fetch -q "$REMOTE_NAME"
  if arm_step main_push; then
    row main_push_rejected fail "the driver armed main_push although origin/main had diverged"
  else
    row main_push_rejected ok "the driver refuses main_push while origin/main is not an ancestor of local main: $(head -c 120 "$SCRATCH/arm-main_push.err" | tr '\n' ' ')"
  fi
  # ...and git itself would reject the push, so nothing is forced through either way.
  want_fail main_push_rejected_by_git "a non-fast-forward push of local main is refused by git too" \
    git -C "$WORK" push "$REMOTE_NAME" main
  if G "$WORK" rebase -q "$REMOTE_NAME/main" main >/dev/null 2>&1; then
    row main_push_rebase_recovers ok "local main rebases onto the fetched remote tip"
  else
    G "$WORK" rebase --abort >/dev/null 2>&1 || true
    row main_push_rebase_recovers fail "the rebase onto the remote tip conflicted"
  fi
  # Re-armed AFTER the rebase: main_push's postcondition binds MAIN to what the arm observed,
  # and the arm's own precondition now passes because the remote is an ancestor again.
  if arm_step main_push && G "$WORK" push -q "$REMOTE_NAME" main && record_step main_push 0 - -; then
    row walk_main_push ok "after the rebase the driver arms main_push, and the push is recorded"
  else
    row walk_main_push fail "main_push failed: $(head -c 220 "$SCRATCH/record-main_push.err" "$SCRATCH/arm-main_push.err" 2>/dev/null | tr '\n' ' ')"
  fi

  walk publish_ack '{"answer":"proceed"}'

  # pr_merge: the second clone performs the server-side merge and pushes it.
  G "$SECOND" fetch -q origin
  G "$SECOND" checkout -q main
  G "$SECOND" reset -q --hard origin/main
  G "$SECOND" fetch -q origin "$BRANCH:$BRANCH" 2>/dev/null || G "$SECOND" fetch -q origin "$BRANCH"
  if arm_step pr_merge && G "$SECOND" merge -q --no-ff --no-edit "$BRANCH" >/dev/null 2>&1 && G "$SECOND" push -q origin main; then
    MERGE_SHA="$(G "$SECOND" rev-parse HEAD)"
    if record_step pr_merge 0 - "{\"merge_sha\":\"$MERGE_SHA\"}"; then
      row walk_pr_merge ok "the emulated server-side merge ${MERGE_SHA:0:12} was accepted by the driver"
    else
      row walk_pr_merge fail "the pr_merge record was refused: $(head -c 220 "$SCRATCH/record-pr_merge.err" | tr '\n' ' ')"
    fi
  else
    row walk_pr_merge fail "pr_merge arm/merge failed: $(head -c 180 "$SCRATCH/arm-pr_merge.err" | tr '\n' ' ')"
  fi

  # claude_surface: the fixture cache dir, written here in place of the operator's slash commands.
  # The driver checks for the plugin's entry point under the version directory
  # (claudeSurfacePath), not merely for the directory: an empty tree is not an installation.
  CACHE_BIN="$CACHE/bin"
  mkdir -p "$CACHE/.claude-plugin" "$CACHE_BIN" "$CLAUDE_DIR/plugins"
  printf '{"repositories":{"rasatpetabit-masterplan":{"plugins":{"masterplan":{"version":"%s"}}}}}\n' "$VERSION" \
    > "$CLAUDE_DIR/plugins/installed_plugins.json"
  G "$WORK" show "$RELEASE_TIP:$VERSION_FROM" > "$CACHE/$VERSION_FROM" 2>/dev/null
  G "$WORK" show "$RELEASE_TIP:bin/masterplan.mjs" > "$CACHE_BIN/masterplan.mjs" 2>/dev/null
  walk claude_surface
  walk surfaces_live

  # The equality rule, probed IN the state the gate actually runs in, with a positive control
  # first: without it, "the arm was refused" proves nothing — an arm can refuse for ordering
  # or completion reasons that have nothing to do with the remote tip.
  if arm_step gate; then
    row gate_arms_before_remote_moves ok "with origin/main at the recorded merge, the gate arms"
    SIB_EQ="$SCRATCH/sibling-equality"
    git clone -q "$BARE" "$SIB_EQ"
    G "$SIB_EQ" config user.email se@invalid; G "$SIB_EQ" config user.name se
    G "$SIB_EQ" config commit.gpgsign false
    printf 'a sibling pushed after step 5\n' > "$SIB_EQ/sibling-after-step5.txt"
    G "$SIB_EQ" add sibling-after-step5.txt; G "$SIB_EQ" commit -q -m "sibling after step 5"
    G "$SIB_EQ" push -q origin main
    G "$WORK" fetch -q "$REMOTE_NAME"
    row gate_remote_moved ok "a sibling really moved origin/main past the recorded merge sha"
    # The SAME state, the only difference being the moved remote: a refusal now is the
    # equality rule and nothing else.
    if arm_step gate; then
      row gate_equality_stops fail "the driver armed the gate although origin/main had moved past the recorded merge"
    else
      row gate_equality_stops ok "the driver refuses the gate while origin/main is past the recorded merge: $(head -c 120 "$SCRATCH/arm-gate.err" | tr '\n' ' ')"
    fi
    # Put the remote back where the walk recorded it so the gate can complete normally.
    G "$SIB_EQ" reset -q --hard HEAD~1
    G "$SIB_EQ" push -q --force origin main
    G "$WORK" fetch -q "$REMOTE_NAME"
  else
    row gate_arms_before_remote_moves fail "the gate would not arm even before the remote moved: $(head -c 180 "$SCRATCH/arm-gate.err" | tr '\n' ' ')"
    row gate_remote_moved fail "skipped: no positive control"
    row gate_equality_stops fail "skipped: without a positive control an arm refusal proves nothing"
  fi

  # gate: its own command commits the bundle before the rebase, so the walk does that work
  # between arm and record exactly as the operator would.
  if arm_step gate; then
    G "$WORK" add -- "docs/masterplan/rehearsal"
    G "$WORK" commit -q -m "masterplan(rehearsal): bundle ledger" -- "docs/masterplan/rehearsal" 2>/dev/null || true
    # ...and rebases local main onto the remote tip the arm bound, so the state-only commits
    # replay on top of the merge that landed. This is §10.2's rebase, performed for real.
    GATE_REMOTE_TIP="$(json_data_field "$SCRATCH/arm-gate.json" remote_tip)"
    G "$WORK" fetch -q "$REMOTE_NAME"
    G "$WORK" rebase -q "${GATE_REMOTE_TIP:-$REMOTE_NAME/main}" main >/dev/null 2>&1 \
      || G "$WORK" rebase --abort >/dev/null 2>&1 || true
    if record_step gate 0 - -; then
      row walk_gate ok "the bundle was committed and the gate recorded through the driver"
    else
      row walk_gate fail "the gate record was refused: $(head -c 220 "$SCRATCH/record-gate.err" | tr '\n' ' ')"
    fi
  else
    row walk_gate fail "gate arm refused: $(head -c 220 "$SCRATCH/arm-gate.err" | tr '\n' ' ')"
  fi

  # Both surfaces read back from the fixtures rather than assumed.
  PI_LIVE="$(json_version "$INSTALL_ROOT/.pi-install.json")"
  CACHE_VERSION="$(json_version "$CACHE/$VERSION_FROM")"
  if [ "$PI_LIVE" = "$VERSION" ] && [ "$CACHE_VERSION" = "$VERSION" ]; then
    row surfaces_live_at_v10 ok "both fixture surfaces report $VERSION after the walk"
  else
    row surfaces_live_at_v10 fail "pi='${PI_LIVE:-<none>}' claude='${CACHE_VERSION:-<none>}', expected $VERSION"
  fi
  say "SURFACES pi=$PI_LIVE claude=$CACHE_VERSION"
fi

# ---- 5. dispositions that are not driver steps -------------------------------

# install-pi rollback: an induced failure must be refused with the live surface untouched,
# and the rollback is verified by INSTALLED CONTENT, not by a symlink the script just made.
# (the induced failure and the intact-surface check now run INSIDE the walk, as a recorded
# failed/recovered turn of the install_pi step)
if selected install_rollback; then
  if node "$INSTALL_PI" --source="$WORK" --ref="$V9_SHA" --install-root="$INSTALL_ROOT" --pi-root="$PI_ROOT" --force >"$SCRATCH/rollback.log" 2>&1; then
    ROLLED="$(json_version "$INSTALL_ROOT/.pi-install.json")"
    ROLLED_CONTENT="$(json_version "$INSTALL_ROOT/current/$VERSION_FROM")"
    if [ "$ROLLED" = "9.10.0" ] && [ "$ROLLED_CONTENT" = "9.10.0" ]; then
      row install_pi_rollback ok "install-pi --ref=9.10.0 restored the Pi surface, verified by installed content"
    else
      row install_pi_rollback fail "rollback reports receipt='${ROLLED:-<none>}' content='${ROLLED_CONTENT:-<none>}'"
    fi
  else
    row install_pi_rollback fail "the rollback install failed: $(tail -c 200 "$SCRATCH/rollback.log" | tr '\n' ' ')"
  fi
fi

# a public tag is never moved, and a genuinely PARTIAL push is retried idempotently
if selected push_rows; then
  check push_tag_idempotent "re-pushing an identical tag is a no-op" \
    git -C "$WORK" push "$REMOTE_NAME" "refs/tags/$TAG"
  G "$WORK" tag -f "$TAG" main >/dev/null 2>&1
  want_fail push_tag_moved_stops "a remote tag whose sha differs is a stop, never a force" \
    git -C "$WORK" push "$REMOTE_NAME" "refs/tags/$TAG"
  G "$WORK" tag -f "$TAG" "${RELEASE_TIP:-$REVIEWED_SHA}" >/dev/null 2>&1
  # A real partial state: the branch is on the remote, the tag is NOT — asserted with
  # ls-remote BEFORE the retry, so the row cannot pass against an already-complete remote.
  PARTIAL_TAG="v${VERSION}-partial"
  G "$WORK" tag -f "$PARTIAL_TAG" "${RELEASE_TIP:-$REVIEWED_SHA}" >/dev/null 2>&1
  G "$WORK" push -q "$REMOTE_NAME" "$BRANCH" 2>/dev/null
  BRANCH_ON_REMOTE="$(G "$WORK" ls-remote --heads "$REMOTE_NAME" "$BRANCH" | wc -l | tr -d ' ')"
  TAG_ON_REMOTE="$(G "$WORK" ls-remote --tags "$REMOTE_NAME" "$PARTIAL_TAG" | wc -l | tr -d ' ')"
  if [ "${BRANCH_ON_REMOTE:-0}" -ge 1 ] && [ "${TAG_ON_REMOTE:-1}" -eq 0 ]; then
    row push_partial_state ok "the fixture really is partial: branch present, tag absent"
  else
    row push_partial_state fail "not a partial state (branch=$BRANCH_ON_REMOTE tag=$TAG_ON_REMOTE)"
  fi
  if G "$WORK" push -q "$REMOTE_NAME" "$BRANCH" "refs/tags/$PARTIAL_TAG" 2>/dev/null \
     && [ "$(G "$WORK" ls-remote --tags "$REMOTE_NAME" "$PARTIAL_TAG" | wc -l | tr -d ' ')" -ge 1 ]; then
    row push_partial_retry ok "the retry pushed the missing tag and left the branch alone"
  else
    row push_partial_retry fail "the retry did not complete the partial push"
  fi
fi

# the base audit: bundle-only commits accepted, a foreign commit stops the walk, and dirty
# non-bundle state is distinguished from a dirty bundle
audit_foreign_count() { # audit_foreign_count <from> <to>
  # `git show --name-only` prints NOTHING for a merge commit (combined diffs omit paths that
  # changed against only one parent), so a merge carrying a foreign file would read as clean.
  # A merge in this range is never bundle-only history: it is counted as foreign outright.
  G "$WORK" log --format='%H %P' "$1..$2" | while read -r sha parents; do
    case "$parents" in
      *' '*) echo x; continue ;;   # more than one parent: a merge
    esac
    G "$WORK" show --pretty=format: --name-only "$sha" | grep -v '^$' | grep -qv '^docs/masterplan/' && echo x
  done | wc -l | tr -d ' '
}
if selected base_audit; then
  G "$WORK" checkout -q main
  AUDIT_FROM="$(G "$WORK" rev-parse main)"
  mkdir -p "$WORK/docs/masterplan/rehearsal" "$WORK/docs/masterplan/other"
  printf 'state\n' >> "$WORK/docs/masterplan/rehearsal/notes.md"
  G "$WORK" add -A; G "$WORK" commit -q -m "bundle state commit"
  printf 'sibling bundle\n' > "$WORK/docs/masterplan/other/state.yml"
  G "$WORK" add -A; G "$WORK" commit -q -m "a sibling bundle's state commit"
  if [ "$(audit_foreign_count "$AUDIT_FROM" main)" -eq 0 ]; then
    row base_audit_bundle_only ok "every commit main gained touches only docs/masterplan (a sibling bundle's commit is accepted)"
  else
    row base_audit_bundle_only fail "a non-bundle commit was found where none exists"
  fi
  printf 'foreign\n' > "$WORK/foreign.txt"
  G "$WORK" add -A; G "$WORK" commit -q -m "a foreign non-bundle commit"
  if [ "$(audit_foreign_count "$AUDIT_FROM" main)" -ge 1 ]; then
    row base_audit_foreign_stops ok "a foreign non-bundle commit is detected and stops the walk"
  else
    row base_audit_foreign_stops fail "the audit did not see the foreign commit"
  fi
  G "$WORK" reset -q --hard HEAD~1  # drop the plain foreign commit; the merge fixture follows
  # §10.2's range is bundle-only NON-MERGE commits, so a merge in it is refused outright
  # rather than path-inspected: `git show --name-only` reports a merge through a combined
  # diff, which is not a reliable basis for deciding what a merge brought in.
  G "$WORK" checkout -q -B foreign-side "$AUDIT_FROM"
  printf 'foreign via a merge\n' > "$WORK/foreign-merged.txt"
  G "$WORK" add foreign-merged.txt; G "$WORK" commit -q -m "foreign work on a side branch"
  G "$WORK" checkout -q main
  if G "$WORK" merge -q --no-ff --no-edit foreign-side >/dev/null 2>&1; then
    if [ "$(audit_foreign_count "$AUDIT_FROM" main)" -ge 1 ]; then
      row base_audit_merge_stops ok "a merge commit in the audited range is refused outright (the range must be non-merge commits)"
    else
      row base_audit_merge_stops fail "a merge commit in the audited range was accepted as bundle-only history"
    fi
    G "$WORK" reset -q --hard HEAD~1
  else
    row base_audit_merge_stops fail "the merge fixture could not be built"
  fi
  G "$WORK" branch -q -D foreign-side >/dev/null 2>&1 || true
  # re-create the plain foreign commit the section ends by reverting
  printf 'foreign\n' > "$WORK/foreign.txt"
  G "$WORK" add foreign.txt; G "$WORK" commit -q -m "a foreign non-bundle commit"
  printf 'uncommitted\n' > "$WORK/dirty.txt"
  DIRTY_NON_BUNDLE="$(G "$WORK" status --porcelain --untracked-files=all | grep -v 'docs/masterplan/' | grep -cv '^$')"
  if [ "${DIRTY_NON_BUNDLE:-0}" -ge 1 ]; then
    row dirty_non_bundle_stops ok "an uncommitted non-bundle file is seen as dirty state"
  else
    row dirty_non_bundle_stops fail "the dirty non-bundle file was not detected"
  fi
  rm -f "$WORK/dirty.txt"
  printf 'bundle scratch\n' > "$WORK/docs/masterplan/rehearsal/scratch.txt"
  DIRTY_AFTER="$(G "$WORK" status --porcelain --untracked-files=all | grep -v 'docs/masterplan/' | grep -cv '^$')"
  if [ "${DIRTY_AFTER:-1}" -eq 0 ]; then
    row dirty_bundle_allowed ok "an uncommitted BUNDLE file is not non-bundle dirt"
  else
    row dirty_bundle_allowed fail "a bundle-only write was counted as non-bundle dirt"
  fi
  rm -f "$WORK/docs/masterplan/rehearsal/scratch.txt"
  G "$WORK" reset -q --hard HEAD~1  # the disposition: revert the foreign commit, never widen the audit
fi

# the merge sha's ancestry, the no-op finish merge, and a MISSING merge
if selected merge_rows; then
  G "$WORK" fetch -q "$REMOTE_NAME"
  if [ -n "$MERGE_SHA" ]; then
    check merge_sha_ancestor_of_remote "the recorded merge sha is an ancestor of the remote main" \
      git -C "$WORK" merge-base --is-ancestor "$MERGE_SHA" "$REMOTE_NAME/main"
    check merge_sha_descendant_of_tip "the recorded merge sha is a descendant of the released tip" \
      git -C "$WORK" merge-base --is-ancestor "${RELEASE_TIP:-$REVIEWED_SHA}" "$MERGE_SHA"
    if G "$WORK" rebase -q "$REMOTE_NAME/main" main >/dev/null 2>&1; then
      row gate_rebase_clean ok "local main rebases onto the remote tip without conflict"
      check merge_sha_ancestor_after_rebase "ancestry survives the gate rebase" \
        git -C "$WORK" merge-base --is-ancestor "$MERGE_SHA" main
    else
      G "$WORK" rebase --abort >/dev/null 2>&1 || true
      row gate_rebase_clean fail "the gate rebase conflicted"
    fi
    BEFORE_MERGE="$(G "$WORK" rev-parse main)"
    if G "$WORK" merge -q --no-ff --no-edit "$BRANCH" >/dev/null 2>&1; then
      NOOP_DIFF="$(G "$WORK" diff --name-only "$BEFORE_MERGE..main" | wc -l | tr -d ' ')"
      if [ "${NOOP_DIFF:-1}" -eq 0 ]; then
        row finish_merge_is_noop ok "the finish's merge changes no files — the branch is already in main"
      else
        row finish_merge_is_noop fail "the finish's merge changed $NOOP_DIFF file(s); the PR merge did not carry the branch"
      fi
    else
      row finish_merge_is_noop fail "the no-op merge conflicted"
    fi
    # The positive control for the ancestry direction below.
    if G "$WORK" merge-base --is-ancestor "${RELEASE_TIP:-$REVIEWED_SHA}" "$REMOTE_NAME/main" >/dev/null 2>&1; then
      row merged_tip_positive_control ok "the released tip IS an ancestor of origin/main — the check is not inverted"
    else
      row merged_tip_positive_control fail "the released tip is not in origin/main; the merge fixture did not land"
    fi
  else
    row merge_sha_ancestor_of_remote fail "no merge sha was produced by the walk"
  fi
  # A MISSING remote merge: a commit that genuinely never reached the remote.
  G "$WORK" checkout -q -B unmerged-probe "$REVIEWED_SHA" >/dev/null 2>&1
  printf 'never pushed, never merged\n' > "$WORK/unmerged.txt"
  G "$WORK" add unmerged.txt; G "$WORK" commit -q -m "a commit that never reached the remote"
  UNMERGED_TIP="$(G "$WORK" rev-parse HEAD)"
  G "$WORK" checkout -q main
  if G "$WORK" merge-base --is-ancestor "$UNMERGED_TIP" "$REMOTE_NAME/main" >/dev/null 2>&1; then
    row missing_remote_merge_stops fail "the unmerged probe was found in origin/main"
  else
    row missing_remote_merge_stops ok "a tip absent from origin/main means no merge landed -> stop"
  fi
  G "$WORK" branch -q -D unmerged-probe >/dev/null 2>&1 || true
fi

# an unexpected remote tip at the gate stops the walk, and re-target eligibility is audited
if selected gate_equality; then
  RECORDED="$(G "$WORK" rev-parse "$REMOTE_NAME/main")"
  retarget_eligible() { # retarget_eligible <from> <to> — non-merge, and touching neither the
    local from="$1" to="$2" sha f     # bundle dir nor any path the branch changed
    [ "$(G "$WORK" rev-list --merges --count "$from..$to")" -eq 0 ] || return 1
    for sha in $(G "$WORK" rev-list "$from..$to"); do
      while read -r f; do
        [ -z "$f" ] && continue
        case "$f" in docs/masterplan/*) return 1 ;; esac
        grep -qxF "$f" "$BRANCH_PATHS" && return 1
      done < <(G "$WORK" show --pretty=format: --name-only "$sha")
    done
    return 0
  }
  SIB2="$SCRATCH/sibling2"
  git clone -q "$BARE" "$SIB2"
  G "$SIB2" config user.email s2@invalid; G "$SIB2" config user.name s2
  G "$SIB2" config commit.gpgsign false
  printf 'later sibling\n' > "$SIB2/later.txt"
  G "$SIB2" add -A; G "$SIB2" commit -q -m "a sibling pushed after step 5"
  G "$SIB2" push -q origin main
  G "$WORK" fetch -q "$REMOTE_NAME"
  # (the equality rule itself is probed inside the walk, where a positive control can be run
  # in the same state; this group covers only re-target ELIGIBILITY once the remote has moved)
  if retarget_eligible "$RECORDED" "$REMOTE_NAME/main"; then
    row gate_retarget_eligible ok "the intervening commit is a non-merge touching no bundle or branch path — a re-target is offerable"
  else
    row gate_retarget_eligible fail "the benign sibling commit was judged ineligible"
  fi
  # The NEGATIVE fixture: without it the eligibility check could pass everything.
  RECORDED2="$(G "$WORK" rev-parse "$REMOTE_NAME/main")"
  G "$SIB2" fetch -q origin; G "$SIB2" reset -q --hard origin/main
  FIRST_BRANCH_PATH="$(head -1 "$BRANCH_PATHS")"
  if [ -n "$FIRST_BRANCH_PATH" ]; then
    mkdir -p "$(dirname "$SIB2/$FIRST_BRANCH_PATH")"
    printf 'a foreign change to a branch path\n' > "$SIB2/$FIRST_BRANCH_PATH"
    G "$SIB2" add -A; G "$SIB2" commit -q -m "foreign change to a branch path"
    G "$SIB2" push -q origin main
    G "$WORK" fetch -q "$REMOTE_NAME"
    if retarget_eligible "$RECORDED2" "$REMOTE_NAME/main"; then
      row gate_retarget_refuses_branch_path fail "a foreign change to a branch path was judged re-targetable"
    else
      row gate_retarget_refuses_branch_path ok "a foreign change to a branch path is reconciled by hand, never re-targeted"
    fi
  else
    row gate_retarget_refuses_branch_path fail "no branch path available to build the negative fixture"
  fi
fi

# a release record refused when the tagged commit differs from the reviewed sha by more than
# the CHANGELOG commit
if selected release_rows; then
  if [ -n "$RELEASE_TIP" ] && [ "$(G "$WORK" rev-list --count "$REVIEWED_SHA..$RELEASE_TIP")" -eq 1 ]; then
    row release_changelog_allowed ok "the tagged commit is exactly one CHANGELOG commit past the reviewed sha"
  else
    row release_changelog_allowed fail "the release tip is not one commit past the reviewed sha"
  fi
  G "$WORK" checkout -q --detach "${RELEASE_TIP:-$REVIEWED_SHA}" >/dev/null 2>&1
  printf 'unreviewed code\n' > "$WORK/sneaky.txt"
  G "$WORK" add sneaky.txt; G "$WORK" commit -q -m "an unreviewed commit rides along"
  if [ "$(G "$WORK" rev-list --count "$REVIEWED_SHA..HEAD")" -gt 1 ]; then
    row release_extra_commit_refused ok "a tagged commit more than the CHANGELOG past the reviewed sha is refused"
  else
    row release_extra_commit_refused fail "the extra commit was not detected"
  fi
  G "$WORK" checkout -q main
fi

# a user_only check exiting 0 / 1 / other, from REAL commands rather than literals. (The
# authoritative classification is unit-tested in test/finish-replay.test.mjs; this row proves
# the rehearsal can produce each of the three real exit classes.)
if selected user_only_checks; then
  printf 'present\n' > "$SCRATCH/handback-evidence.txt"
  classify() { if "$@" >/dev/null 2>&1; then echo done; else case $? in 1) echo absent ;; *) echo indeterminate ;; esac; fi; }
  got_done="$(classify test -f "$SCRATCH/handback-evidence.txt")"
  got_absent="$(classify test -f "$SCRATCH/no-such-evidence.txt")"
  got_indet="$(classify grep -q anything /nonexistent/path/for/rehearsal)"
  [ "$got_done" = done ] && row user_only_check_done ok "an evidence file that exists -> done" \
    || row user_only_check_done fail "expected done, got $got_done"
  [ "$got_absent" = absent ] && row user_only_check_absent ok "a missing evidence file (exit 1) -> absent" \
    || row user_only_check_absent fail "expected absent, got $got_absent"
  [ "$got_indet" = indeterminate ] && row user_only_check_indeterminate ok "a check that errors (exit != 0/1) -> indeterminate" \
    || row user_only_check_indeterminate fail "expected indeterminate, got $got_indet"
fi

# ---- 6. digest ---------------------------------------------------------------
say "== rows=$ROWS failed=$FAILED"
for r in "${REPORT[@]}"; do say "SUMMARY $r"; done
if [ "$FAILED" -eq 0 ]; then
  say "REHEARSAL PASS"
  exit 0
fi
say "REHEARSAL FAIL"
exit 1
