// scripts/rehearse-v9-finish.sh — the §10.1 step-1 rehearsal walk.
//
// Everything here runs the REAL script against fixtures: a stateful `gh` shim on PATH that
// records every invocation and simulates the repo/PR lifecycle, a pinned-v9 fixture tree, and
// the repo's own bootstrap driver. Real network execution is reserved for the live stage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armStep, targetsDigest } from '../scripts/bootstrap-v10.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'rehearse-v9-finish.sh');

// A stateful gh shim: it logs every invocation and models repo create / pr create /
// pr merge / pr view / repo delete, so the test can assert the whole command sequence
// rather than merely that "gh was called".
const GH_SHIM = `#!/usr/bin/env bash
# A stateful gh shim backed by a REAL bare repository, so the fixtures cannot pass where
# live GitHub would fail: a PR needs both branches to exist on the remote, a merge really
# advances the remote main, and a head already contained in the base cannot open a PR.
LOG="$GH_SHIM_LOG"
STATE="$GH_SHIM_LOG.state"
REPOS="$GH_SHIM_LOG.repos"
BARE="$REPOS/repo.git"
echo "$*" >> "$LOG"
sub="$1 $2"

pr_file() { echo "$STATE.pr.$1"; }
repo_host() {
  case "$1" in
    */*/*) printf '%s' "\${1%%/*}" ;;
    *) printf '%s' "\${GH_SHIM_DEFAULT_HOST:-default.invalid}" ;;
  esac
}
check_host() {
  [ "$(repo_host "$1")" = "$(cat "$STATE.host")" ] || {
    echo "wrong host: $1 addresses an unrelated repository" >&2; return 1;
  }
}
require_repo() {
  local repo=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--repo" ]; then repo="$2"; break; fi
    shift
  done
  check_host "$repo" || return 1
  case "$repo" in */*/*) repo="\${repo#*/}" ;; esac
  [ "$repo" = "\${GH_SHIM_OWNER:-acme}/throwaway" ] || {
    echo "expected canonical [HOST/]OWNER/REPO, got $repo" >&2; return 1;
  }
}

case "$sub" in
  "api user")
    [ "\${GH_SHIM_FAIL:-}" = "auth_identity" ] && exit 1
    printf '%s\\n' "\${GH_SHIM_OWNER:-acme}"
    exit 0 ;;
  "repo create")
    [ "\${GH_SHIM_FAIL:-}" = "repo_create" ] && { echo "repo already exists" >&2; exit 1; }
    grep -q "^created" "$STATE" 2>/dev/null && { echo "repo already exists" >&2; exit 1; }
    mkdir -p "$REPOS"
    git init -q --bare --initial-branch=main "$BARE" || exit 1
    echo created >> "$STATE"
    repo_host "$3" > "$STATE.host"
    echo 0 > "$STATE.counter"
    exit 0 ;;
  "repo view")
    [ "\${GH_SHIM_FAIL:-}" = "repo_view" ] && { echo "metadata unavailable" >&2; exit 1; }
    grep -q "^created" "$STATE" 2>/dev/null || { echo "no such repo" >&2; exit 1; }
    # Model real HTTPS metadata; process-scoped Git config maps only this repository to BARE.
    identity="\${GH_SHIM_OWNER:-acme}/throwaway"
    url="https://$(cat "$STATE.host")/$identity"
    case "\${GH_SHIM_FAIL:-}" in
      meta_owner) identity="unrelated/throwaway" ;;
      meta_name) identity="\${GH_SHIM_OWNER:-acme}/unrelated" ;;
      meta_host) url="https://unrelated.invalid/$identity" ;;
      meta_path) url="https://$(cat "$STATE.host")/unrelated/repository" ;;
      meta_scheme) url="file://$BARE" ;;
      meta_malformed) identity="invalid identity" ;;
    esac
    printf '{"url":"%s","nameWithOwner":"%s"}\\n' "$url" "$identity"
    exit 0 ;;
  "pr create")
    require_repo "$@" || exit 1
    grep -q "^created" "$STATE" 2>/dev/null || { echo "no such repo" >&2; exit 1; }
    [ "\${GH_SHIM_FAIL:-}" = "pr_create" ] && exit 1
    # real gh pr create rejects a bare --repo with the [HOST/]OWNER/REPO format error; the
    # script must pass the canonical nameWithOwner, so a bare name is a fixture failure.
    head=""; base="main"; repo=""
    while [ $# -gt 0 ]; do
      case "$1" in --repo) repo="$2" ;; --head) head="$2" ;; --base) base="$2" ;; esac
      shift
    done
    case "$repo" in */*) ;; *) echo "expected the \\"[HOST/]OWNER/REPO\\" format, got \\"$repo\\"" >&2; exit 1 ;; esac
    [ -n "$head" ] || { echo "no head branch given" >&2; exit 1; }
    git -C "$BARE" rev-parse --verify -q "refs/heads/$base" >/dev/null || { echo "base branch $base does not exist" >&2; exit 1; }
    git -C "$BARE" rev-parse --verify -q "refs/heads/$head" >/dev/null || { echo "head branch $head does not exist" >&2; exit 1; }
    # GitHub refuses a PR whose head is already contained in the base.
    if git -C "$BARE" merge-base --is-ancestor "refs/heads/$head" "refs/heads/$base" 2>/dev/null; then
      echo "No commits between $base and $head" >&2; exit 1
    fi
    n=$(( $(cat "$STATE.counter" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STATE.counter"
    printf 'OPEN %s %s\\n' "$head" "$base" > "$(pr_file "$n")"
    echo pr >> "$STATE"
    echo "https://example.invalid/pr/$n"
    exit 0 ;;
  "pr merge")
    require_repo "$@" || exit 1
    num=""
    for a in "$@"; do case "$a" in ''|*[!0-9]*) ;; *) num="$a"; break ;; esac; done
    [ -n "$num" ] && [ -f "$(pr_file "$num")" ] || { echo "no such pr" >&2; exit 1; }
    [ "\${GH_SHIM_FAIL:-}" = "pr_merge" ] && exit 1
    read -r st head base < "$(pr_file "$num")"
    [ "$st" = "OPEN" ] || { echo "pr is $st" >&2; exit 1; }
    # A real merge on the server side: the base branch actually advances.
    tmp="$REPOS/mergeclone"
    rm -rf "$tmp"
    git clone -q "$BARE" "$tmp" || exit 1
    git -C "$tmp" config user.email shim@invalid
    git -C "$tmp" config user.name shim
    git -C "$tmp" config commit.gpgsign false
    git -C "$tmp" checkout -q "$base" || exit 1
    git -C "$tmp" fetch -q origin "$head:$head" 2>/dev/null || git -C "$tmp" fetch -q origin "$head"
    git -C "$tmp" merge -q --no-ff --no-edit "$head" || exit 1
    git -C "$tmp" push -q origin "$base" || exit 1
    oid=$(git -C "$tmp" rev-parse HEAD)
    printf 'MERGED %s %s %s\\n' "$head" "$base" "$oid" > "$(pr_file "$num")"
    echo merged >> "$STATE"
    exit 0 ;;
  "pr view")
    require_repo "$@" || exit 1
    num=""
    for a in "$@"; do case "$a" in ''|*[!0-9]*) ;; *) num="$a"; break ;; esac; done
    [ -n "$num" ] && [ -f "$(pr_file "$num")" ] || { echo "no pull request found" >&2; exit 1; }
    read -r st head base oid < "$(pr_file "$num")"
    if [ "$st" = "MERGED" ] && [ "\${GH_SHIM_FAIL:-}" = "merged_without_oid" ]; then
      printf '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","mergeCommit":null}\\n'
    elif [ "$st" = "MERGED" ]; then
      printf '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","mergeCommit":{"oid":"%s"}}\\n' "$oid"
    else
      printf '{"state":"OPEN","mergedAt":null,"mergeCommit":null}\\n'
    fi
    exit 0 ;;
  "repo delete")
    check_host "$3" || exit 1
    [ "\${GH_SHIM_FAIL:-}" = "repo_delete" ] && { echo "deletion denied" >&2; exit 1; }
    grep -q "^created" "$STATE" 2>/dev/null || { echo "no such repo" >&2; exit 1; }
    echo deleted >> "$STATE"
    exit 0 ;;
esac
exit 1
`;

// A COMMAND-AWARE pinned fixture. A stub that answers everything would let the script's
// "the finish ran through the pinned copy" row pass without a finish ever running, so this
// one records each invocation, refuses an unknown verb, and requires finish-step to name a
// readable --state. The test then asserts the recorded invocations, not merely a row.
function makePinnedV9(dir, version = '9.10.0', { finishFails = false } = {}) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'masterplan.mjs'), `
import fs from 'node:fs';
const argv = process.argv.slice(2);
const log = process.env.MP_PINNED_LOG;
if (log) fs.appendFileSync(log, argv.join(' ') + '\\n');
const verb = argv[0];
if (verb === 'version') { console.log('masterplan ${version}'); process.exit(0); }
if (${finishFails ? 'true' : 'false'} && verb === 'finish-step') {
  // A build that logs the invocation, prints an error, and exits non-zero: the row must not
  // read "it was called" as "it worked".
  console.error('finish-step unsupported by this build');
  process.exit(2);
}
if (verb === 'finish-step' || verb === 'status') {
  const state = (argv.find((a) => a.startsWith('--state=')) || '').slice('--state='.length);
  if (!state || !fs.existsSync(state)) { console.error('no readable --state'); process.exit(2); }
  fs.readFileSync(state, 'utf8');
  console.log(JSON.stringify({ op: 'ask', ask: 'gate', gate: 'branch_finish', verb }));
  process.exit(0);
}
console.error('unexpected verb: ' + verb);
process.exit(2);
`);
  return dir;
}

// Fixture trees are registered here and removed once when the file finishes, so a shared
// environment can outlive the test that first built it.
const FIXTURE_TMPDIRS = [];
after(() => {
  for (const d of FIXTURE_TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function makeEnv(_t, { version = '9.10.0', ghRepo = 'acme/throwaway', finishFails = false, statePath: statePathOverride = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-rehearse-test-'));
  FIXTURE_TMPDIRS.push(tmp);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const ghPath = path.join(bin, 'gh');
  fs.writeFileSync(ghPath, GH_SHIM);
  fs.chmodSync(ghPath, 0o755);
  const pinned = makePinnedV9(path.join(tmp, 'pinned-src'), version, { finishFails });
  const bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(bundle, { recursive: true });
  const statePath = statePathOverride ?? path.join(bundle, 'state.yml');
  if (!statePathOverride) {
    fs.writeFileSync(statePath, 'schema_version: 8\nslug: rehearsal\nstatus: in-progress\nphase: execute\ntasks: []\n');
  }
  const targetsPath = path.join(tmp, 'targets.json');
  fs.writeFileSync(targetsPath, JSON.stringify({
    remote: 'origin', version: '10.0.0', branch: 'masterplan/rehearsal',
    gh: 'gh', gh_repo: ghRepo, pinned_v9: pinned,
  }, null, 2));
  const ghLog = path.join(tmp, 'gh.log');
  const pinnedLog = path.join(tmp, 'pinned-invocations.log');
  return { tmp, bin, pinned, statePath, targetsPath, ghLog, pinnedLog };
}

// A full walk clones repos, installs, merges and pushes; running one per test would take
// minutes. Identical (env, options) pairs are memoized so the expensive walk happens once
// and every assertion reads the same real run.
const RUN_CACHE = new Map();
function run(env, opts = {}) {
  const key = `${env.tmp}|${JSON.stringify(opts)}`;
  if (!RUN_CACHE.has(key)) RUN_CACHE.set(key, runUncached(env, opts));
  return RUN_CACHE.get(key);
}

function runUncached(env, { only = null, scratch = null, fault = null, ghFail = null, keep = false } = {}) {
  const args = [SCRIPT, `--state=${env.statePath}`, `--targets=${env.targetsPath}`];
  if (only) args.push(`--only=${only}`);
  if (scratch) args.push(`--scratch=${scratch}`);
  if (keep) args.push('--keep');
  const selector = JSON.parse(fs.readFileSync(env.targetsPath, 'utf8')).gh_repo || 'throwaway';
  const host = selector.split('/').length === 3 ? selector.split('/')[0] : 'default.invalid';
  const configIndex = Number(process.env.GIT_CONFIG_COUNT || 0);
  const r = spawnSync('bash', args, {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      ...process.env,
      // Only the expected HTTPS identity maps to the local bare repository; all real
      // network transports are forbidden, including in the deliberately-red regressions.
      GH_HOST: 'default.invalid',
      GH_SHIM_DEFAULT_HOST: 'default.invalid',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_CONFIG_COUNT: String(configIndex + 1),
      [`GIT_CONFIG_KEY_${configIndex}`]: `url.${env.ghLog}.repos/repo.git.insteadOf`,
      [`GIT_CONFIG_VALUE_${configIndex}`]: `https://${host}/acme/throwaway`,
      PATH: `${env.bin}:${process.env.PATH}`,
      GH_SHIM_LOG: env.ghLog,
      MP_PINNED_LOG: env.pinnedLog,
      ...(fault ? { MP_REHEARSAL_FAULT: fault } : {}),
      ...(ghFail ? { GH_SHIM_FAIL: ghFail } : {}),
    },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const rows = new Map();
  for (const line of out.split('\n')) {
    const m = /^ROW\s+(\S+)\s+(ok|fail)/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  const ghLog = fs.existsSync(env.ghLog) ? fs.readFileSync(env.ghLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  const pinnedLog = fs.existsSync(env.pinnedLog) ? fs.readFileSync(env.pinnedLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, out, rows, ghLog, pinnedLog };
}


// The default walk, built once and shared: it is the same real run either way, and doing it
// per test would cost minutes.
let DEFAULT = null;
function defaultRun() {
  if (!DEFAULT) {
    const env = makeEnv(null);
    // Exercise the actual driver-produced resolved artifact, not hand-authored overrides.
    const root = path.join(env.tmp, 'armed');
    const bundle = path.join(root, 'docs', 'masterplan', 'rehearsal');
    fs.mkdirSync(bundle, { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', path.basename(SCRIPT)));
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git('init', '-q', '--initial-branch=masterplan/rehearsal');
    git('add', 'scripts');
    git('commit', '-qm', 'fixture');
    git('branch', 'main');
    const statePath = path.join(bundle, 'state.yml');
    fs.copyFileSync(env.statePath, statePath);
    const targets = JSON.parse(fs.readFileSync(env.targetsPath, 'utf8'));
    const armed = armStep({ statePath, step: 'rehearsal', targets });
    assert.equal(armed.ok, true, JSON.stringify(armed));
    const files = fs.readdirSync(bundle).filter((name) => name.startsWith('.bootstrap-targets-'));
    assert.equal(files.length, 1);
    env.targetsPath = path.join(bundle, files[0]);
    const before = fs.readFileSync(env.targetsPath, 'utf8');
    assert.equal(JSON.parse(before).tag, 'v10.0.0');
    assert.equal(files[0], `.bootstrap-targets-${targetsDigest(JSON.parse(before)).slice(0, 16)}.json`);
    DEFAULT = { env, r: run(env) };
    assert.equal(fs.readFileSync(env.targetsPath, 'utf8'), before, 'rehearsal must preserve the armed receipt bytes');
  }
  return DEFAULT;
}

// ---------------------------------------------------------------------------

test('the whole walk passes against fixtures and reports every row', () => {
  const { r } = defaultRun();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /REHEARSAL PASS/);
  const failed = [...r.rows].filter(([, v]) => v !== 'ok');
  assert.deepEqual(failed, [], `failing rows: ${JSON.stringify(failed)}`);
  assert.ok(r.rows.size >= 55, `expected a broad row set, got ${r.rows.size}`);
});

test('local fixture walk resolves CI identity when live gh_repo is unset', (t) => {
  const r = run(makeEnv(t, { ghRepo: null }), { only: 'walk' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.rows.get('fail_ci_wait_recorded'), 'ok');
  assert.equal(r.rows.get('fail_ci_wait_recovered'), 'ok');
  assert.equal(r.rows.get('walk_surfaces_live'), 'ok');
  assert.deepEqual(r.ghLog, [], 'fixture CI evidence must not call live GitHub');
});

test('bare creation names use canonical metadata for every PR operation', (t) => {
  const r = run(makeEnv(t, { ghRepo: 'throwaway' }), { only: 'gh_cycle' });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.ghLog.some((l) => l === 'api user --jq .login'));
  assert.ok(r.ghLog.some((l) => l.startsWith('repo create acme/throwaway ')));
  const calls = r.ghLog.filter((l) => /^pr (create|merge|view) /.test(l));
  assert.ok(calls.length >= 5);
  for (const call of calls) assert.match(call, /--repo acme\/throwaway(?: |$)/);
  assert.ok(r.ghLog.some((l) => l === 'repo delete acme/throwaway --yes'));
});

test('explicit creation host is preserved for PR operations and cleanup', (t) => {
  const repo = 'enterprise.invalid/acme/throwaway';
  const r = run(makeEnv(t, { ghRepo: repo }), { only: 'gh_cycle' });
  assert.equal(r.status, 0, r.out);
  const calls = r.ghLog.filter((l) => /^pr (create|merge|view) /.test(l));
  assert.ok(calls.length >= 5);
  for (const call of calls) assert.ok(call.includes(`--repo ${repo} `), call);
  assert.deepEqual(r.ghLog.filter((l) => l.startsWith('repo delete ')), [`repo delete ${repo} --yes`]);
});

test('failed creation never deletes a pre-existing repository', (t) => {
  const r = run(makeEnv(t), { only: 'gh_cycle', ghFail: 'repo_create' });
  assert.notEqual(r.status, 0);
  assert.equal(r.rows.get('gh_repo_create'), 'fail');
  assert.equal(r.ghLog.filter((l) => l.startsWith('repo delete ')).length, 0);
});

test('metadata failure retains the successfully created identity for cleanup', (t) => {
  const r = run(makeEnv(t, { ghRepo: 'throwaway' }), { only: 'gh_cycle', ghFail: 'repo_view' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /metadata unavailable/);
  assert.ok(r.ghLog.some((l) => l === 'repo delete acme/throwaway --yes'), r.out);
  assert.equal(r.ghLog.filter((l) => l.startsWith('pr ')).length, 0);
});

for (const fault of ['meta_owner', 'meta_name', 'meta_host', 'meta_path', 'meta_scheme', 'meta_malformed']) {
  test(`metadata mismatch ${fault} stops before push/PR and cannot redirect cleanup`, (t) => {
    const env = makeEnv(t);
    const r = run(env, { only: 'gh_cycle', ghFail: fault });
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.rows.get('gh_repo_resolve'), 'fail', r.out);
    assert.deepEqual(r.ghLog.filter((l) => l.startsWith('repo delete ')), ['repo delete acme/throwaway --yes']);
    assert.deepEqual(r.ghLog.filter((l) => l.startsWith('pr ')), []);
    const refs = spawnSync('git', ['--git-dir', `${env.ghLog}.repos/repo.git`, 'for-each-ref'], { encoding: 'utf8' });
    assert.equal(refs.status, 0, refs.stderr);
    assert.equal(refs.stdout, '', 'no branch may be pushed before metadata identity validation');
  });
}

test('bare creation refuses an unavailable authenticated identity before creating anything', (t) => {
  const r = run(makeEnv(t, { ghRepo: 'throwaway' }), { only: 'gh_cycle', ghFail: 'auth_identity' });
  assert.notEqual(r.status, 0);
  assert.equal(r.ghLog.filter((l) => l.startsWith('repo create ') || l.startsWith('repo delete ')).length, 0);
});

test('cleanup denial reports the owned repository and diagnostic', (t) => {
  const r = run(makeEnv(t), { only: 'gh_cycle', ghFail: 'repo_delete' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /acme\/throwaway/);
  assert.match(r.out, /deletion denied/);
  assert.match(r.out, /cleanup failed.*acme\/throwaway/);
});

// ---- the pinned v9 executor -------------------------------------------------

test('the pinned 9.10.0 copy is what actually runs the finish verb', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('pinned_v9_copy'), 'ok');
  const pinLine = /PINNED_FINISH_BINARY=(\S+)/.exec(r.out);
  assert.ok(pinLine, 'the script must name the binary every rehearsed finish uses');
  // The copy, not the source tree and not a repo-relative binary: the repo and the cache
  // both move to v10 during the stage, so a later-resolved binary is the wrong one.
  assert.match(pinLine[1], /pinned-9\.10\.0\/bin\/masterplan\.mjs$/);
  assert.ok(!pinLine[1].startsWith(REPO), 'the pinned binary must not be the repo-relative one');
  // The invocations are RECORDED BY THE FIXTURE ITSELF, so this cannot pass on an
  // announcement: a finish verb must really have executed, naming a readable state file.
  assert.ok(r.pinnedLog.length >= 2, `expected recorded invocations, got ${JSON.stringify(r.pinnedLog)}`);
  const finish = r.pinnedLog.find((l) => l.startsWith('finish-step'));
  assert.ok(finish, `no finish verb reached the pinned copy: ${JSON.stringify(r.pinnedLog)}`);
  assert.match(finish, /--state=\S+state\.yml/);
  assert.equal(r.rows.get('pinned_finish_step'), 'ok');
  assert.equal(r.rows.get('pinned_finish_routed'), 'ok');
  // and pinning precedes the install work
  assert.ok(r.out.indexOf('ROW pinned_v9_copy') < r.out.indexOf('ROW walk_install_pi'));
});

test('a pinned tree that does not print 9.10.0 ABORTS before anything world-touching', (t) => {
  const env = makeEnv(t, { version: '10.0.0' }); // the wrong version in the pinned slot
  const r = run(env);
  assert.equal(r.rows.get('pinned_v9_copy'), 'fail');
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /REHEARSAL ABORTED/);
  // Nothing may have been attempted under an unknown executor.
  assert.deepEqual(r.ghLog, [], 'no gh call may be made without a pinned v9');
  assert.ok(!r.rows.has('walk_install_pi'), 'no install may run without a pinned v9');
});

// ---- fixtures ---------------------------------------------------------------

test('the bare remote and second clone are built, and the v9 diff the assessor sees is non-empty', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('second_clone_built'), 'ok');
  assert.equal(r.rows.get('clone_ahead_of_remote'), 'ok', 'the fixture clone starts ahead of its remote by a non-bundle commit');
  assert.equal(r.rows.get('v9_diff_non_empty'), 'ok');
  assert.match(r.out, /main\.\.masterplan\/rehearsal touches \d+ file/);
});

// ---- the walk ---------------------------------------------------------------

test('every step of the bootstrap walk is armed and recorded through the real driver', () => {
  const { env, r } = defaultRun();
  // The driver enforces its own order and its own pre/postconditions, so each of these rows
  // passes only because the fixture really produced what that step requires.
  const steps = [
    'rehearsal', 'docs_normalize', 'verify', 'review', 'assess', 'release', 'push',
    'install_pi', 'main_push', 'publish_ack', 'pr_merge', 'claude_surface', 'surfaces_live', 'gate',
  ];
  for (const s of steps) {
    assert.equal(r.rows.get(`walk_${s}`), 'ok', `walk_${s} missing or failing`);
  }
  // The walk is ordered: a later step cannot appear before an earlier one.
  const positions = steps.map((s) => r.out.indexOf(`ROW walk_${s}`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `walk_${steps[i]} ran before walk_${steps[i - 1]}`);
  }
});

test('a failed step is durable, BLOCKS the next step, and is closed by a recovery record', () => {
  const { env, r } = defaultRun();
  // §10.3: every failure and its recovery are a failed/recovered pair, and the stage never
  // proceeds past a failed step.
  assert.equal(r.rows.get('fail_ci_wait_recorded'), 'ok');
  assert.equal(r.rows.get('fail_ci_wait_blocks_next'), 'ok');
  assert.equal(r.rows.get('fail_ci_wait_recovered'), 'ok');
});

test('a red tag CI really blocks the install, and a green one really allows exactly one', () => {
  const { env, r } = defaultRun();
  // Not a variable compared to itself: the install marker is written only when install-pi
  // actually runs, and the red window is bounded by the driver refusing to arm install_pi.
  assert.equal(r.rows.get('ci_red_no_install'), 'ok');
  assert.equal(r.rows.get('ci_green_allows_install'), 'ok');
  assert.match(r.out, /exactly one install ran once the CI record was green: 1/);
  assert.ok(r.out.indexOf('ROW ci_red_no_install') < r.out.indexOf('ROW ci_green_allows_install'));
});

test('the Pi surface is really installed and both surfaces end the walk at v10', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('walk_install_pi'), 'ok', 'a real install-pi run against fixture roots');
  assert.equal(r.rows.get('walk_claude_surface'), 'ok');
  assert.equal(r.rows.get('surfaces_live_at_v10'), 'ok');
  const surfaces = /SURFACES pi=(\S+) claude=(\S+)/.exec(r.out);
  assert.ok(surfaces, 'the receipt names both surfaces');
  assert.equal(surfaces[1], '10.0.0');
  assert.equal(surfaces[2], '10.0.0');
});

test('an induced install failure is refused and the rollback is verified by installed content', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('install_pi_failure_refused'), 'ok');
  assert.equal(r.rows.get('install_pi_surface_intact'), 'ok', 'the failed install left the live surface alone');
  // The failure is a recorded TURN of the driver's install_pi step, not a shell-side aside:
  // it lands as status failed and the stage refuses to move on until a recovery is recorded.
  assert.equal(r.rows.get('fail_install_pi_recorded'), 'ok');
  assert.equal(r.rows.get('fail_install_pi_blocks_next'), 'ok');
  // The recovery records the installer's REAL exit status: a hard-coded 0 would durably
  // record a failed installer as a successful recovery.
  assert.match(r.out, /recorded as recovered/);
  assert.equal(r.rows.get('install_pi_rollback'), 'ok');
  // The rollback row must read installed CONTENT, not a symlink the script just made.
  assert.match(r.out, /restored the Pi surface, verified by installed content/);
});

// ---- merge, audit and gate --------------------------------------------------

test('the PR merge is emulated by the second clone and the finish merge is a real no-op', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('walk_pr_merge'), 'ok');
  assert.equal(r.rows.get('merge_sha_ancestor_of_remote'), 'ok');
  assert.equal(r.rows.get('merge_sha_descendant_of_tip'), 'ok');
  assert.equal(r.rows.get('gate_rebase_clean'), 'ok');
  assert.equal(r.rows.get('merge_sha_ancestor_after_rebase'), 'ok', 'ancestry holds before AND after the gate rebase');
  assert.equal(r.rows.get('finish_merge_is_noop'), 'ok');
});

test('a missing remote merge is detected, with a positive control against an inverted check', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('missing_remote_merge_stops'), 'ok');
  // Without this control the row could pass by testing the ancestry relation backwards.
  assert.equal(r.rows.get('merged_tip_positive_control'), 'ok');
});

test('the base audit accepts bundle commits, stops on a foreign one, and distinguishes dirty state', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('base_audit_bundle_only'), 'ok');
  assert.equal(r.rows.get('base_audit_foreign_stops'), 'ok');
  assert.equal(r.rows.get('dirty_non_bundle_stops'), 'ok');
  assert.equal(r.rows.get('dirty_bundle_allowed'), 'ok', 'a bundle-only write is not non-bundle dirt');
});

test('the equality rule is enforced by the DRIVER, with a positive control in the same state', () => {
  const { r } = defaultRun();
  // Without the control, "the arm was refused" proves nothing: an arm can refuse for ordering
  // or completion reasons unrelated to the remote tip.
  assert.equal(r.rows.get('gate_arms_before_remote_moves'), 'ok', 'the gate arms while the remote still matches');
  assert.equal(r.rows.get('gate_remote_moved'), 'ok', 'the sibling really moved the remote');
  assert.equal(r.rows.get('gate_equality_stops'), 'ok');
  // The only thing that changed between the two arms is the remote tip, and the refusal names
  // the equality precondition by name rather than any incidental one.
  assert.match(r.out, /the driver refuses the gate while origin\/main is past the recorded merge/);
  assert.match(r.out, /remote_main_equals_pr_merge/);
  assert.ok(r.out.indexOf('ROW gate_arms_before_remote_moves') < r.out.indexOf('ROW gate_equality_stops'));
});

test('the diverged-remote disposition is a DRIVER refusal, not just a git rejection', () => {
  const { r } = defaultRun();
  assert.equal(r.rows.get('main_push_rejected'), 'ok');
  assert.match(r.out, /the driver refuses main_push while origin\/main is not an ancestor/);
  assert.equal(r.rows.get('main_push_rejected_by_git'), 'ok', 'nothing is forced through by hand either');
  // ...and after the named recovery the driver arms it and the push is recorded.
  assert.equal(r.rows.get('main_push_rebase_recovers'), 'ok');
  assert.equal(r.rows.get('walk_main_push'), 'ok');
});

test('re-target eligibility has a positive AND a negative fixture', () => {
  const { r } = defaultRun();
  assert.equal(r.rows.get('gate_equality_stops'), 'ok');
  assert.equal(r.rows.get('gate_retarget_eligible'), 'ok');
  // Without the negative row the eligibility check could pass everything and still look green.
  assert.equal(r.rows.get('gate_retarget_refuses_branch_path'), 'ok',
    'a foreign change to a branch path must NOT be re-targetable');
});

test('a partial push is a REAL partial state before the retry completes it', () => {
  const { env, r } = defaultRun();
  // The precondition row is what stops this being an idempotent re-push dressed up as a retry.
  assert.equal(r.rows.get('push_partial_state'), 'ok');
  assert.match(r.out, /the fixture really is partial: branch present, tag absent/);
  assert.equal(r.rows.get('push_partial_retry'), 'ok');
  assert.ok(r.out.indexOf('ROW push_partial_state') < r.out.indexOf('ROW push_partial_retry'));
  assert.equal(r.rows.get('push_tag_idempotent'), 'ok');
  assert.equal(r.rows.get('push_tag_moved_stops'), 'ok');
});

test('every 10.3 failure row has a fixture and lands on its named disposition', () => {
  const { env, r } = defaultRun();
  const expected = [
    'push_tag_idempotent',        // repeated push: an identical tag is a no-op
    'push_tag_moved_stops',       // a differing remote tag: stop, never move a public tag
    'push_partial_state',         // a genuinely partial push...
    'push_partial_retry',         // ...completed by an idempotent retry
    'fail_ci_wait_recorded',      // red tag CI, durable
    'fail_ci_wait_blocks_next',   // ...and install-pi is not reachable while it stands
    'ci_red_no_install',
    'install_pi_rollback',        // install-pi failure rolls back to 9.10.0
    'gh_pr_reconcile_merged',     // gh pr merge: MERGED -> record and continue
    'gh_pr_reconcile_open',       // OPEN -> retry once, then stop
    'gh_pr_reconcile_other',      // any other state -> stop
    'main_push_rejected',         // step-5: the DRIVER refuses to arm against a diverged remote
    'main_push_rejected_by_git',  // ...and git refuses the push too; nothing is forced
    'main_push_rebase_recovers',
    'walk_main_push',
    'fail_install_pi_recorded',   // install-pi failure, recorded through the driver
    'fail_install_pi_blocks_next',
    'gate_remote_moved',
    'base_audit_foreign_stops',   // a foreign commit on main stops the walk
    'base_audit_bundle_only',     // a sibling bundle's commit is accepted
    'dirty_non_bundle_stops',
    'gate_equality_stops',        // a sibling pushed after step 5
    'gate_retarget_refuses_branch_path',
    'missing_remote_merge_stops',
    'release_changelog_allowed',  // the tag may be one CHANGELOG commit past the reviewed sha
    'release_extra_commit_refused', // ... and no more
    'user_only_check_done', 'user_only_check_absent', 'user_only_check_indeterminate',
  ];
  for (const row of expected) {
    assert.equal(r.rows.get(row), 'ok', `${row} missing or failing: ${JSON.stringify([...r.rows])}`);
  }
});

// ---- the gh cycle -----------------------------------------------------------

test('the throwaway repo is POPULATED before the PR — an empty repo cannot take one', () => {
  const { env, r } = defaultRun();
  assert.equal(r.rows.get('gh_repo_populated'), 'ok');
  const verbs = r.ghLog.map((l) => l.split(/\s+/).slice(0, 2).join(' '));
  // repo view (for the clone URL) and the branch pushes come between create and pr create.
  assert.ok(verbs.indexOf('repo view') > verbs.indexOf('repo create'));
  assert.ok(verbs.indexOf('pr create') > verbs.indexOf('repo view'));
  // The shim's bare repo is real and rejects a PR whose branches were never pushed, so this
  // row failing would mean the LIVE cycle fails too.
  assert.equal(r.rows.get('gh_pr_create'), 'ok');
});

test('the OPEN reconciliation uses a DISTINCT unmerged head, as real GitHub requires', () => {
  const { env, r } = defaultRun();
  // Reusing the merged branch would be rejected live ("no commits between"), and the shim
  // rejects it too — so this row proves a separate probe branch was pushed and opened.
  assert.equal(r.rows.get('gh_pr_reconcile_open'), 'ok');
  assert.match(r.out, /distinct head\) reports OPEN/);
  const creates = r.ghLog.filter((l) => l.startsWith('pr create'));
  assert.equal(creates.length, 2, `expected two PR creations, got ${JSON.stringify(creates)}`);
  assert.notEqual(
    /--head (\S+)/.exec(creates[0])?.[1],
    /--head (\S+)/.exec(creates[1])?.[1],
    'the second PR must not reuse the merged head',
  );
});

test('the gh cycle runs create, view, pr create, merge, view and delete on a private repo', () => {
  const { env, r } = defaultRun();
  const verbs = r.ghLog.map((l) => l.split(/\s+/).slice(0, 2).join(' '));
  assert.equal(verbs[0], 'repo create');
  assert.equal(verbs.at(-1), 'repo delete');
  assert.ok(verbs.includes('pr merge'));
  assert.ok(verbs.filter((v) => v === 'pr view').length >= 3, 'MERGED, OPEN and other states are each reconciled');
  // The throwaway repository is private — a rehearsal must not publish anything.
  assert.match(r.ghLog[0], /--private/);
  const mergeCall = r.ghLog.find((l) => l.startsWith('pr merge'));
  assert.ok(mergeCall && mergeCall.includes('--merge'), 'the rehearsed merge is the --merge strategy');
  assert.ok(r.ghLog.some((l) => l.includes('--json state,mergedAt,mergeCommit')), 'reconcile by reading state, never re-merge blind');
});

test('the throwaway repo is deleted after success and after a mid-cycle failure', (t) => {
  const env = makeEnv(t);
  const ok = run(env);
  assert.equal(ok.ghLog.at(-1).startsWith('repo delete'), true, JSON.stringify(ok.ghLog));
  assert.match(fs.readFileSync(`${env.ghLog}.state`, 'utf8'), /deleted/);

  const env2 = makeEnv(t);
  // The script dies between create and its own delete; only the EXIT trap can clean up.
  const bad = run(env2, { fault: 'gh_mid_cycle' });
  assert.equal(bad.status, 3, bad.out);
  assert.match(bad.out, /simulated mid-cycle failure/);
  assert.equal(bad.ghLog.at(-1).startsWith('repo delete'), true, JSON.stringify(bad.ghLog));
  assert.match(fs.readFileSync(`${env2.ghLog}.state`, 'utf8'), /deleted/, 'the trap deleted the throwaway repo');
});

test('a failing gh pr merge is reported as a failed row and still cleans up', (t) => {
  const env = makeEnv(t);
  const r = run(env, { ghFail: 'pr_merge' });
  assert.equal(r.rows.get('gh_pr_merge'), 'fail');
  // pr view then reports OPEN, which is the "retry once, then stop" row — not a silent pass.
  assert.equal(r.rows.get('gh_pr_reconcile_merged'), 'fail');
  assert.notEqual(r.status, 0);
  assert.ok(r.ghLog.some((l) => l.startsWith('repo delete')), 'cleanup still ran');
});

// ---- hygiene and arguments --------------------------------------------------

test('the scratch tree is removed on exit, and --keep preserves it', (t) => {
  const env = makeEnv(t);
  const scratch = path.join(env.tmp, 'scratch-removed');
  run(env, { scratch });
  assert.equal(fs.existsSync(scratch), false, 'the scratch tree must not survive the run');

  const env2 = makeEnv(t);
  const kept = path.join(env2.tmp, 'scratch-kept');
  run(env2, { scratch: kept, keep: true });
  assert.equal(fs.existsSync(kept), true, '--keep preserves the scratch tree for inspection');
  assert.equal(fs.existsSync(path.join(kept, 'remote.git')), true, 'the bare fixture remote was built there');
  assert.equal(fs.existsSync(path.join(kept, 'pinned-9.10.0', 'bin', 'masterplan.mjs')), true, 'the pinned copy is a real tree');
});

test('--only runs one selected group', (t) => {
  const env = makeEnv(t);
  const r = run(env, { only: 'gh_cycle' });
  assert.equal(r.rows.has('gh_repo_create'), true);
  assert.equal(r.rows.has('walk_install_pi'), false, 'unselected groups do not run');
});

test('bad arguments are refused rather than half-run', (t) => {
  const env = makeEnv(t);
  const missing = spawnSync('bash', [SCRIPT, `--targets=${env.targetsPath}`], { encoding: 'utf8', cwd: REPO });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--state is required/);
  const unknown = spawnSync('bash', [SCRIPT, `--state=${env.statePath}`, `--targets=${env.targetsPath}`, '--bogus'], { encoding: 'utf8', cwd: REPO });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument/);
  const noTargets = spawnSync('bash', [SCRIPT, `--state=${env.statePath}`, '--targets=/nonexistent/targets.json'], { encoding: 'utf8', cwd: REPO });
  assert.equal(noTargets.status, 2);
  assert.match(noTargets.stderr, /targets file not found/);
});

// ---- negative fixtures: each proves a row would actually catch its failure --------

test('a pinned tree reporting 19.10.0 does not satisfy the exact-9.10.0 pin', (t) => {
  // A substring match would accept this; the pin invariant is an exact version token.
  const env = makeEnv(t, { version: '19.10.0' });
  const r = run(env, { scratch: path.join(env.tmp, 'scratch-1910') });
  assert.equal(r.rows.get('pinned_v9_copy'), 'fail');
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /REHEARSAL ABORTED/);
  assert.deepEqual(r.ghLog, [], 'nothing world-touching ran under the wrong executor');
});

test('a pinned finish-step that exits non-zero fails the rehearsal, however loudly it prints', (t) => {
  // stdout and stderr both land in the capture file, so "the file is non-empty" would accept
  // an error message. The exit status is what the row reads.
  const env = makeEnv(t, { finishFails: true });
  const r = run(env, { only: 'pinned_finish', scratch: path.join(env.tmp, 'scratch-badfinish') });
  assert.equal(r.rows.get('pinned_finish_step'), 'fail', r.out);
  assert.match(r.out, /finish-step through the pinned copy failed/);
  assert.notEqual(r.status, 0);
  // The invocation still happened — it simply is not evidence of success.
  assert.ok(r.pinnedLog.some((l) => l.startsWith('finish-step')));
});

test('a state file that does not exist is refused before any gh call', (t) => {
  const env = makeEnv(t, { statePath: '/nonexistent/rehearsal-state.yml' });
  const r = run(env);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /state file not found/);
  assert.deepEqual(r.ghLog, [], 'no gh command may run under an unreadable state');
});

test('a MERGED response with no mergeCommit oid fails the reconciliation row', (t) => {
  // "record the sha and continue" is only honest if a sha was actually taken.
  const env = makeEnv(t);
  const r = run(env, { ghFail: 'merged_without_oid', scratch: path.join(env.tmp, 'scratch-nooid') });
  assert.equal(r.rows.get('gh_pr_reconcile_merged'), 'fail', r.out);
  assert.match(r.out, /MERGED but no mergeCommit\.oid/);
});

// ---- the wave-11 rehearsal repairs: --only validation + the real release contract ------

test("a typo'd --only group is refused at startup — zero evidence is never a pass", (t) => {
  const env = makeEnv(t);
  const r = run(env, { only: 'realease_rows' }); // the typo that used to select nothing and PASS
  assert.equal(r.status, 2, `expected exit 2 on the unknown group, got ${r.status}`);
  assert.match(r.out, /unknown --only group: realease_rows/);
  assert.match(r.out, /known: /);
  assert.ok(!/REHEARSAL PASS/.test(r.out), 'zero rows must never print REHEARSAL PASS');
});

test("the release rows drive the REAL single_commit contract, not the row's own arithmetic", (t) => {
  // release_changelog_allowed: the real validator ACCEPTS the legitimate CHANGELOG-only
  // release (empty problem set); release_extra_commit_refused: the real validator NAMES
  // the sneaky extra commit (single_commit). The old extra row counted the commit it had
  // just made itself — a tautology; this pins the load-bearing seam.
  // The FULL run: the walk group builds the release tip the release rows judge (a bare
  // --only=release_rows fixture has no release to accept).
  const env = makeEnv(t);
  const r = run(env, { scratch: path.join(env.tmp, 'scratch-realcontract') });
  assert.equal(r.rows.get('release_changelog_allowed'), 'ok',
    `the real contract must accept the CHANGELOG-only release: ${r.out}`);
  assert.equal(r.rows.get('release_extra_commit_refused'), 'ok',
    `the real contract must name the extra commit: ${r.out}`);
  assert.match(r.out, /NAMES the sneaky extra commit/);
});

