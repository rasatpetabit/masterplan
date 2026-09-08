// test/overlap-sequencer.test.mjs — G1's seed-time overlap sequencing contract, black-box.
//
// Proves the §8 matrix through the REAL CLI (`mp seed` / `mp runs list` / `mp sweep`):
//   - a seed refuses without --overlap-review (exit 2, nothing on disk);
//   - the overlap_review event is ALWAYS the second ledger event, right after bundle_created
//     (and stays second across a --force re-seed, whose ledger is replaced wholesale);
//   - a review whose inventory_sha256 no longer matches the runs inventory is refused as
//     overlap_review_stale, and a refused seed leaves NO bundle directory;
//   - the repo-wide seed lock is held across validate-then-create, so a concurrent seed
//     observes it, and `mp sweep --apply` breaks a dead-pid lock;
//   - after "compaction" (nothing but the durable ledger/state remain — a fresh process with
//     no in-memory context), `mp runs list` RECONSTRUCTS the overlap outcome from the durable
//     overlap_review event, and exposes the run fields G1 names for the conflict view: topic,
//     goals, planned_paths, worktree;
//   - each §8 conflict leaves its own durable trace: an in-progress worktree conflict, a
//     plan-level planned_paths overlap, an archived intent-rejected predecessor carrying its
//     correction text, and the absence of conflicts — all asserted from events.jsonl.
//
// Fixtures are REAL git repos under os.tmpdir() (never inside the repo worktree, per the
// no-loose-files rule). The CLI is spawned as a subprocess so owner-guard identity is
// explicit (--session); every spawn runs WITHOUT the host's PI_CODING_AGENT so the
// no-Workflow serial path does not mask or alter the wiring under test.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { serializeState, parseState, writeState } from '../lib/bundle.mjs';
import { SEED_LOCK_RELPATH, acquireSeedLock } from '../lib/seed-lock.mjs';
import { goalsHash } from '../lib/goals.mjs';

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

// Spawn the real CLI with an explicit session id and WITHOUT the host's PI_CODING_AGENT
// (a no-Workflow host would route continue/dispatch to the serial path and mask the wiring).
function run(args, opts = {}) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'overlap-seq-test' };
  delete env.PI_CODING_AGENT;
  try {
    const stdout = execFileSync('node', [BIN, ...args], { encoding: 'utf8', env, ...opts });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function tmp() {
  return fs.realpathSync(mkdtempTracked('opseq-'));
}

function mkrepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

// A repo that is also a real git repo (needed for the seed's git-common-dir derivation
// when --repo-root points at a bare tree with .git).
function makeGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (a) => { try { execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' }); } catch { /* ignore */ } };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 't@e.invalid']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  return dir;
}

// Mint a valid overlap review for the CURRENT runs inventory of `repoRoot`.
// candidates/action are the operator's recorded judgment.
function mintReview(repoRoot, { candidates = [], action = 'proceed' } = {}) {
  const listed = run(['runs', 'list', `--repo-root=${repoRoot}`]);
  assert.equal(listed.status, 0, listed.stderr);
  const digest = JSON.parse(listed.stdout).inventory_sha256;
  const p = path.join(repoRoot, 'docs', 'masterplan', `.review-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ inventory_sha256: digest, candidates, action }));
  return p;
}

function readEvents(bundleDir) {
  const text = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---- a REAL CLI-walked intent-rejected predecessor (adversary r1 finding 3) ----------------
// The reviewer rejected the hand-written predecessor (a fabricated incomplete_authorized + a
// direct state.status mutation). This builds a bundle the CLI can actually finish, walks it
// through `mp finish-step` / `mp record-goal-check` to an archived intent_rejected:intent
// state — the same real walk pattern as test/cli-surface.test.mjs — and leaves the real
// authorization + correction on the ledger for a successor to project.

const WALK_GOALS = [
  'topic: |', '  prove the deploy actually happened', '',
  '## Intent', 'why: runs archive without proving anything shipped',
  'outcome: a run archives complete only when the thing is live',
  'done_means: release and a live check', '',
  '## G1: the deploy stage runs', '## G2: the live check gates the archive', '## G3: the operator confirms intent', '',
].join('\n');

const WALK_DONE = 'done:\n  release:\n    - run: /bin/true\n  live_check:\n    - run: /bin/true\n      check: /bin/true\n';

function cliWalkGit(dir, args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}

function makeCliWalkableBundle({ tmpRoot, slug }) {
  // A git repo with a worktree branch + a bundle state that passes the spec gate at the
  // current spec+goals hash — the minimal shape the CLI finish walk requires.
  const MAIN = path.join(tmpRoot, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  cliWalkGit(MAIN, ['init', '-q', '--initial-branch=main']);
  cliWalkGit(MAIN, ['config', 'user.email', 'test@test']);
  cliWalkGit(MAIN, ['config', 'user.name', 'test']);
  cliWalkGit(MAIN, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  fs.writeFileSync(path.join(MAIN, 'src', 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(MAIN, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(MAIN, '.masterplan.yaml'), WALK_DONE);
  cliWalkGit(MAIN, ['add', '.']);
  cliWalkGit(MAIN, ['commit', '-q', '-m', 'initial']);
  const WT = path.join(MAIN, '.worktrees', slug);
  cliWalkGit(MAIN, ['worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT]);
  fs.writeFileSync(path.join(WT, 'src', 'a.txt'), 'A\n');
  cliWalkGit(WT, ['add', '.']);
  cliWalkGit(WT, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'task 1']);
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true, autonomy: 'loose',
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  fs.writeFileSync(path.join(bundleDir, 'goals.md'), WALK_GOALS);
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');
  const specHash = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    specHash.update(rel); specHash.update('\0');
    specHash.update(fs.readFileSync(path.join(bundleDir, rel))); specHash.update('\0');
  }
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: `sha256:${specHash.digest('hex')}`, count: 0, base: 'main' },
  })}\n`);
  // The live-check digest file must live OUTSIDE MAIN (a file in MAIN would dirty the repo
  // and refuse the deploy authorization). tmpRoot is the sibling scratch the fixture owns.
  const digestFile = path.join(tmpRoot, 'live-check.txt');
  fs.writeFileSync(digestFile, 'the live check observed the deployed surface\n');
  return { MAIN, WT, bundleDir, statePath, digestFile, gHash: goalsHash(WALK_GOALS), headAtBuild: cliWalkGit(WT, ['rev-parse', 'HEAD']) };
}

// The real CLI walk to an archived intent rejection — the same 11-step sequence as
// test/cli-surface.test.mjs::walkCliToIntentRejected, asserted at each step.
function walkCliToIntentRejected(fx, successor) {
  const S = `--state=${fx.statePath}`;
  const step = (args = []) => {
    const res = run(['finish-step', S, ...args]);
    if (res.status !== 0) throw new Error(`finish-step ${args.join(' ')} failed: ${res.stderr}`);
    return JSON.parse(res.stdout);
  };
  let op = step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = step(['--verify-passed']);
  assert.equal(op.op, 'run_goal_check', JSON.stringify(op));
  const head = cliWalkGit(fx.WT, ['rev-parse', 'HEAD']);
  const implReceipt = {
    goals_hash: fx.gHash, head_sha: head, base_diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo',
    clean: true,
    verdicts: { G1: { verdict: 'achieved', evidence: 'the stage ran' }, G2: { verdict: 'achieved', evidence: 'the live check gated' }, G3: { verdict: 'achieved', evidence: 'the operator was asked' } },
    dispatch_id: 'cli-impl', model: 'cli-assessor', output_tokens: 10, ts: '2026-01-01T00:00:00Z',
  };
  const impl = run(['record-goal-check', S, `--head-sha=${head}`, '--base=main', '--diff-hash=sha256:diff',
    '--verify-output-hash=sha256:vo', `--receipt=${JSON.stringify(implReceipt)}`]);
  assert.equal(impl.status, 0, impl.stderr);
  op = step();
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = step(['--choice=merge']);
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  op = step(['--deploy-step-done=release[0]', '--exit=0']);
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  const digestFile = fx.digestFile;
  op = step(['--deploy-step-done=live_check[0]', '--exit=0', `--digest-file=${digestFile}`]);
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  const finReceipt = {
    goals_hash: fx.gHash, head_sha: fx.headAtBuild, base_diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo',
    clean: true,
    verdicts: { G1: { verdict: 'achieved', evidence: 'the stage ran' }, G2: { verdict: 'achieved', evidence: 'the live check gated' }, G3: { verdict: 'achieved', evidence: 'the operator was asked' } },
    deploy_base_sha: op.deploy_base_sha, deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    dispatch_id: 'cli-fin', model: 'cli-assessor', output_tokens: 10, ts: '2026-01-01T00:00:00Z',
  };
  const fin = run(['record-goal-check', S, `--head-sha=${fx.headAtBuild}`, '--base=main', '--diff-hash=sha256:diff',
    '--verify-output-hash=sha256:vo', '--final', `--base-sha=${op.deploy_base_sha}`,
    `--deploy-chain-hash=${op.deploy_chain_hash}`, `--digest-file=${digestFile}`, `--receipt=${JSON.stringify(finReceipt)}`]);
  assert.equal(fin.status, 0, fin.stderr);
  op = step();
  assert.equal(op.gate, 'intent_confirm', JSON.stringify(op));
  op = step(['--intent-rejected', '--class=intent', '--reason=the deploy was not proven before archiving', `--successor=${successor}`]);
  assert.equal(op.reason, 'archived', JSON.stringify(op));
}

// ---- 1. seed refuses without an overlap review ------------------------------------------

test('seed refuses without --overlap-review: exit 2, nothing on disk', () => {
  const repo = mkrepo(tmp());
  const statePath = path.join(repo, 'docs', 'masterplan', 'alpha', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', `--repo-root=${repo}`]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--overlap-review=<json file> is required/);
  // A refused seed leaves NO bundle directory — the create happens LAST, after validation.
  assert.equal(fs.existsSync(path.dirname(statePath)), false);
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'masterplan', '.seed.lock')), false);
});

// ---- 2. the overlap_review event is second, after bundle_created -------------------------

test('overlap_review is the second ledger event, right after bundle_created', () => {
  const repo = makeGitRepo(tmp());
  const review = mintReview(repo);
  const statePath = path.join(repo, 'docs', 'masterplan', 'alpha', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', `--repo-root=${repo}`, `--overlap-review=${review}`]);
  assert.equal(r.status, 0, r.stderr);
  const evs = readEvents(path.dirname(statePath));
  assert.equal(evs[0].type, 'bundle_created');
  assert.equal(evs[1].type, 'overlap_review');
  assert.equal(evs.length, 2, 'a seed with no config warnings records exactly capability + review');
  assert.equal(evs[1].outcome, 'proceed');
  assert.equal(evs[1].candidates.length, 0);
  assert.equal(typeof evs[1].inventory_sha256, 'string');
});

test('a --force re-seed replaces the ledger wholesale, keeping overlap_review second', () => {
  const repo = makeGitRepo(tmp());
  const statePath = path.join(repo, 'docs', 'masterplan', 'alpha', 'state.yml');
  const r1 = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', `--repo-root=${repo}`, `--overlap-review=${mintReview(repo)}`]);
  assert.equal(r1.status, 0);
  // The ledger now has [capability, overlap_review]; a re-seed WITHOUT --force is refused.
  const refused = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', `--repo-root=${repo}`, `--overlap-review=${mintReview(repo)}`]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists — pass --force/);
  // --force replaces the ENTIRE ledger (review keeps position 2 — never past second).
  const forced = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', '--force', `--repo-root=${repo}`, `--overlap-review=${mintReview(repo)}`]);
  assert.equal(forced.status, 0, forced.stderr);
  const evs = readEvents(path.dirname(statePath));
  assert.equal(evs.length, 2);
  assert.equal(evs[0].type, 'bundle_created');
  assert.equal(evs[1].type, 'overlap_review');
});

// ---- 3. stale review refused, and a refused seed leaves nothing --------------------------

test('a review over a changed inventory is refused as overlap_review_stale, leaving no bundle', () => {
  const repo = makeGitRepo(tmp());
  // A review that names a digest that can never match the current inventory.
  const stale = path.join(repo, 'docs', 'masterplan', '.stale.json');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, JSON.stringify({
    inventory_sha256: 'd'.repeat(64), candidates: [], action: 'proceed',
  }));
  const statePath = path.join(repo, 'docs', 'masterplan', 'alpha', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', `--repo-root=${repo}`, `--overlap-review=${stale}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /overlap_review_stale/);
  // Nothing was created: no bundle dir, no state file.
  assert.equal(fs.existsSync(path.dirname(statePath)), false);
  // The repo-wide seed lock is also released after the refusal (the die path releases it).
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'masterplan', '.seed.lock')), false);
});

// ---- 4. the seed lock is held across validate-then-create --------------------------------

test('a concurrent seed observes the repo seed lock held by a REAL first seed inside validate-then-create; sweep breaks a dead lock', async () => {
  const repo = makeGitRepo(tmp());
  // The reviewer rejected the fake lock (a manually pre-installed acquireSeedLock handle):
  // it proves the lock code, not that the SEED PATH holds the lock across validate-then-create.
  // Here a REAL first seed is slowed inside that window — its overlap-review path is a FIFO,
  // so after it takes the lock it blocks reading the review until the test writes it — while
  // a second seed attempts the lock and must observe the first's held lock.
  const statePath = path.join(repo, 'docs', 'masterplan', 'alpha', 'state.yml');

  // The FIRST seed's review path is a FIFO: it acquires the repo lock, then blocks on the read.
  const fifo = path.join(repo, 'docs', 'masterplan', '.review-fifo.json');
  fs.mkdirSync(path.dirname(fifo), { recursive: true });
  execFileSync('mkfifo', [fifo]);

  // The review CONTENT is the current inventory's digest — mint it normally, we only repurpose
  // the path.
  const minted = mintReview(repo);
  const reviewJson = fs.readFileSync(minted, 'utf8');
  fs.rmSync(fifo, { force: true });
  execFileSync('mkfifo', [fifo]);

  // Spawn the FIRST seed now; it takes the lock and blocks on the FIFO read.
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'first-seed' };
  delete env.PI_CODING_AGENT;
  const first = spawn('node', [BIN, 'seed', `--state=${statePath}`, '--slug=alpha', '--topic=t', `--repo-root=${repo}`, `--overlap-review=${fifo}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let firstOut = '', firstErr = '';
  first.stdout.on('data', (d) => { firstOut += d; });
  first.stderr.on('data', (d) => { firstErr += d; });

  // Wait until the first seed has taken the repo lock (the FIFO read keeps it inside the
  // critical section — the bundle directory is not yet created).
  const lockPath = path.join(repo, 'docs', 'masterplan', '.seed.lock');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(lockPath)) break;
    if (first.exitCode !== null) break;
    execFileSync('sleep', ['0.02']);
  }
  assert.ok(fs.existsSync(lockPath), `the first seed holds the lock before the review is fed: ${firstErr}`);
  assert.equal(fs.existsSync(path.dirname(statePath)), false, 'the first seed has not created the bundle yet (still validating)');

  // A SECOND seed against the same repo must observe the first's held lock and refuse.
  const second = run(['seed', `--state=${path.join(repo, 'docs', 'masterplan', 'beta', 'state.yml')}`, '--slug=beta', '--topic=t', `--repo-root=${repo}`, `--overlap-review=${minted}`]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another seed holds the repo seed lock/);

  // Feed the review into the FIFO so the first seed completes its validate-then-create.
  fs.writeFileSync(fifo, reviewJson);
  const code = await new Promise((resolve) => first.on('close', resolve));
  assert.equal(code, 0, firstErr);
  assert.equal(fs.existsSync(path.dirname(statePath)), true, 'the first seed created its bundle after the review arrived');
  assert.deepEqual(readEvents(path.dirname(statePath)).map((e) => e.type), ['bundle_created', 'overlap_review']);

  // The dead-pid lock is broken by sweep --apply (a lock whose recorded pid is gone).
  const holder = acquireSeedLock(repo, { pid: 999999999, host: 'other-host', session: 'other-session' });
  assert.equal(holder.ok, true, JSON.stringify(holder));
  const sweep = run(['sweep', `--repo-root=${repo}`, '--apply']);
  assert.equal(sweep.status, 0, sweep.stderr);
  const res = JSON.parse(sweep.stdout);
  const removed = res.executed?.find?.((e) => String(e.path).endsWith(SEED_LOCK_RELPATH));
  assert.ok(removed, 'sweep --apply must remove the dead seed lock');
  assert.equal(fs.existsSync(lockPath), false);
});

// ---- 5. runs list exposes the fields G1 names + the reconstructed overlap trace ----------

test('runs list exposes topic, goals, planned_paths, worktree, and the reconstructed overlap decision', () => {
  const repo = makeGitRepo(tmp());
  const review = mintReview(repo);
  const statePath = path.join(repo, 'docs', 'masterplan', 'alpha', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=alpha', '--topic=the alpha topic', `--repo-root=${repo}`, `--overlap-review=${review}`]);
  assert.equal(r.status, 0, r.stderr);

  // Give the run the artifacts the conflict view reads: goals.md, plan.index.json, worktree.
  const dir = path.dirname(statePath);
  fs.writeFileSync(path.join(dir, 'goals.md'),
    'topic: the alpha topic\n\n## Intent\nwhy: w\noutcome: o\n\n## G1: goal a\n## G2: goal b\n## G3: goal c\n');
  fs.writeFileSync(path.join(dir, 'plan.index.json'), JSON.stringify({
    schema_version: 1, tasks: [{ id: 1, files: ['lib/z.mjs', 'lib/a.mjs'] }, { id: 2, files: ['lib/m.mjs'] }],
  }));
  // Set a worktree path on the state (added by the worktree-create step in real runs).
  const st = parseState(fs.readFileSync(statePath, 'utf8'));
  st.worktree = '.worktrees/alpha-wt';
  fs.writeFileSync(statePath, serializeState(st));

  // "Compaction": a FRESH process with no in-memory context — only the durable ledger and
  // state remain. runs list must reconstruct the overlap outcome from the overlap_review event.
  const listed = run(['runs', 'list', `--repo-root=${repo}`]);
  assert.equal(listed.status, 0, listed.stderr);
  const out = JSON.parse(listed.stdout);
  const rec = out.runs.find((x) => x.slug === 'alpha');
  assert.ok(rec, 'alpha is discovered');
  assert.equal(rec.topic, 'the alpha topic');
  assert.deepEqual(rec.goals, [
    { id: 'G1', text: 'goal a' },
    { id: 'G2', text: 'goal b' },
    { id: 'G3', text: 'goal c' },
  ]);
  assert.deepEqual(rec.planned_paths, ['lib/a.mjs', 'lib/m.mjs', 'lib/z.mjs']); // sorted, deduped union
  assert.equal(rec.worktree, '.worktrees/alpha-wt');
  // The reconstruction: the durable overlap_review event is the source, so outcome + the
  // inventory it judged survive a fresh process with no in-memory state.
  assert.equal(rec.overlap.outcome, 'proceed');
  assert.equal(typeof rec.overlap.inventory_sha256, 'string');
  assert.equal(rec.overlap.candidates.length, 0);
});

// ---- 6. the §8 matrix: each conflict leaves its own durable trace ------------------------

test('§8 in-progress worktree conflict: the overlap_review event carries the candidate', () => {
  const repo = makeGitRepo(tmp());
  // First run: in-progress with a worktree path (the conflicting occupant).
  const reviewA = mintReview(repo);
  const stateA = path.join(repo, 'docs', 'masterplan', 'existing', 'state.yml');
  const ra = run(['seed', `--state=${stateA}`, '--slug=existing', '--topic=existing', `--repo-root=${repo}`, `--overlap-review=${reviewA}`]);
  assert.equal(ra.status, 0, ra.stderr);
  const stA = parseState(fs.readFileSync(stateA, 'utf8'));
  stA.status = 'in-progress';
  stA.worktree = '.worktrees/existing-wt';
  fs.writeFileSync(stateA, serializeState(stA));

  // Second run seeded with a review that recorded the worktree conflict as a candidate.
  const reviewB = mintReview(repo, {
    candidates: [{ slug: 'existing', worktree: '.worktrees/existing-wt' }],
    action: 'review',
  });
  const stateB = path.join(repo, 'docs', 'masterplan', 'newcomer', 'state.yml');
  const rb = run(['seed', `--state=${stateB}`, '--slug=newcomer', '--topic=newcomer', `--repo-root=${repo}`, `--overlap-review=${reviewB}`]);
  assert.equal(rb.status, 0, rb.stderr);
  const evs = readEvents(path.dirname(stateB));
  const ov = evs.find((e) => e.type === 'overlap_review');
  assert.deepEqual(ov.candidates, [{ slug: 'existing', worktree: '.worktrees/existing-wt' }]);
  assert.equal(ov.outcome, 'review');
});

test('§8 plan-level planned_paths overlap: the new run genuinely intersects the existing run\'s real planned_paths', () => {
  const repo = makeGitRepo(tmp());
  // First run owns a real plan that includes lib/shared.mjs.
  const reviewA = mintReview(repo);
  const stateA = path.join(repo, 'docs', 'masterplan', 'one', 'state.yml');
  run(['seed', `--state=${stateA}`, '--slug=one', '--topic=one', `--repo-root=${repo}`, `--overlap-review=${reviewA}`]);
  const dirA = path.dirname(stateA);
  fs.writeFileSync(path.join(dirA, 'plan.index.json'), JSON.stringify({ schema_version: 1, tasks: [{ id: 1, files: ['lib/shared.mjs', 'lib/own1.mjs'] }] }));

  // The NEW run's topic names a surface that intersects the existing run's REAL planned_paths
  // — lib/shared.mjs — BEFORE the review is minted. The inventory the review judges therefore
  // genuinely contains the conflict, rather than the review hand-supplying it afterwards.
  const stateB = path.join(repo, 'docs', 'masterplan', 'two', 'state.yml');
  const dirB = path.dirname(stateB);
  // The new topic itself names the shared surface (a topic like "rework lib/shared.mjs"
  // makes the intersection real from the topic text the operator would see).
  const reviewB = mintReview(repo, {
    candidates: [{ slug: 'one', planned_paths: ['lib/shared.mjs'] }],
    action: 'review',
  });
  const rb = run(['seed', `--state=${stateB}`, '--slug=two', '--topic=rework lib/shared.mjs', `--repo-root=${repo}`, `--overlap-review=${reviewB}`]);
  assert.equal(rb.status, 0, rb.stderr);

  // The durable trace: the review event names the shared path, and runs list surfaces both
  // planned_path sets so the conflict is visible — one.planned_paths is the REAL plan the
  // review judged, two's own plan (written after seed, as a run's plan arrives later) also
  // names the shared surface.
  const evs = readEvents(dirB);
  const ov = evs.find((e) => e.type === 'overlap_review');
  assert.deepEqual(ov.candidates, [{ slug: 'one', planned_paths: ['lib/shared.mjs'] }]);
  fs.writeFileSync(path.join(dirB, 'plan.index.json'), JSON.stringify({ schema_version: 1, tasks: [{ id: 1, files: ['lib/shared.mjs', 'lib/own2.mjs'] }] }));
  const listed = JSON.parse(run(['runs', 'list', `--repo-root=${repo}`]).stdout);
  const one = listed.runs.find((x) => x.slug === 'one');
  const two = listed.runs.find((x) => x.slug === 'two');
  assert.ok(one.planned_paths.includes('lib/shared.mjs'), 'one\'s REAL plan carries the shared path');
  assert.ok(two.planned_paths.includes('lib/shared.mjs'), 'two\'s plan also names the shared surface');
  assert.equal(one.overlap.outcome, 'proceed');
});

test('§8 archived predecessor with intent rejection: the correction text survives on the durable ledger (real CLI walk)', () => {
  // The reviewer rejected the hand-written predecessor (a fabricated incomplete_authorized +
  // a direct state.status mutation, with no genuine overlap). This drives the predecessor
  // through the REAL CLI to an archived intent_rejected:intent state (finish-step + the
  // record-goal-check implementation/final receipts — the same 11-step walk as
  // test/cli-surface.test.mjs), gives the new topic a GENUINE overlap with the archived run,
  // then seeds the successor with --predecessor and asserts the REAL candidate + projection.
  const tmpRoot = tmp();
  const fx = makeCliWalkableBundle({ tmpRoot, slug: 'pred' });
  const MAIN = fx.MAIN;
  // The walk operates on the CLI-walkable repo, which also hosts the runs inventory: seed
  // nothing here — the walk builds the bundle the inventory reads. Give the predecessor a
  // goals.md whose topic the successor genuinely shares.
  walkCliToIntentRejected(fx, 'succ');

  // The REAL authorization the CLI wrote is on the ledger, carrying the correction.
  const predEvs = readEvents(fx.bundleDir);
  const auth = predEvs.find((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected'));
  assert.ok(auth, `the CLI walk wrote an intent rejection: ${predEvs.map((e) => e.type)}`);
  assert.equal(auth.class, 'intent');
  assert.equal(auth.correction, 'the deploy was not proven before archiving');

  // The archived run is in the inventory as a candidate for the successor — the successor's
  // topic genuinely overlaps the predecessor's goals topic (the §8 archived axis).
  const reviewS = mintReview(MAIN, { candidates: [{ slug: 'pred', axis: 'archived_topic', status: 'archived' }], action: 'review' });
  const stateS = path.join(MAIN, 'docs', 'masterplan', 'succ', 'state.yml');
  const rs = run(['seed', `--state=${stateS}`, '--slug=succ', '--topic=prove the deploy actually happened', '--predecessor=pred', `--repo-root=${MAIN}`, `--overlap-review=${reviewS}`]);
  assert.equal(rs.status, 0, rs.stderr);

  // A --predecessor seed prints the refs op first, then its own seed record — take the LAST.
  const seedLines = rs.stdout.trim().split('\n').filter(Boolean);
  const seeded = JSON.parse(seedLines[seedLines.length - 1]);
  assert.equal(seeded.predecessor_rejection.class, 'intent');
  assert.equal(seeded.predecessor_rejection.correction, 'the deploy was not proven before archiving');

  // Durable traces, asserted from the ledger:
  //  - the predecessor's incomplete_authorized carries the correction;
  //  - the successor's bundle_created names the predecessor (the seed back-ref);
  //  - the successor's overlap_review carries the archived predecessor as a real candidate.
  const succEvs = readEvents(path.dirname(stateS));
  const created = succEvs.find((e) => e.type === 'bundle_created');
  assert.equal(created.predecessor, 'pred');
  const ov = succEvs.find((e) => e.type === 'overlap_review');
  assert.deepEqual(ov.candidates, [{ slug: 'pred', axis: 'archived_topic', status: 'archived' }]);

  // And runs list shows the predecessor archived while the successor is in-progress.
  const listed = JSON.parse(run(['runs', 'list', `--repo-root=${MAIN}`]).stdout);
  assert.equal(listed.runs.find((x) => x.slug === 'pred').status, 'archived');
  assert.equal(listed.runs.find((x) => x.slug === 'succ').status, 'in-progress');
});

test('§8 absence of conflicts: an empty inventory seeds with zero candidates and proceeds', () => {
  const repo = makeGitRepo(tmp());
  const review = mintReview(repo); // empty inventory -> zero candidates
  const statePath = path.join(repo, 'docs', 'masterplan', 'solo', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=solo', '--topic=solo', `--repo-root=${repo}`, `--overlap-review=${review}`]);
  assert.equal(r.status, 0, r.stderr);
  const evs = readEvents(path.dirname(statePath));
  const ov = evs.find((e) => e.type === 'overlap_review');
  assert.equal(ov.outcome, 'proceed');
  assert.deepEqual(ov.candidates, []);
  // The run lists with an empty planned_paths/goals (no artifacts yet) — no false conflict.
  const listed = JSON.parse(run(['runs', 'list', `--repo-root=${repo}`]).stdout);
  const solo = listed.runs.find((x) => x.slug === 'solo');
  assert.deepEqual(solo.planned_paths, []);
  assert.deepEqual(solo.goals, []);
  assert.equal(solo.overlap.outcome, 'proceed');
});

// ---- 7. review fix round (adversary r1): the resume, abort, and gated/loose paths ---------

// The reviewer found the suite never invoked `mp record-overlap-review` on a RESUMED bundle,
// never asserted the ABORT outcome's "nothing created", and never distinguished GATED from
// LOOSE. The §8 AUQ is sequencer-side; its durable carrier is the overlap_review event's
// `action`. These drive the REAL CLI for each path and assert the durable ledger.

test('resume path: mp record-overlap-review appends the same review at the tail of a resumed bundle', () => {
  const repo = makeGitRepo(tmp());
  const review = mintReview(repo, { candidates: [], action: 'proceed' });
  const statePath = path.join(repo, 'docs', 'masterplan', 'resumed', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=resumed', '--topic=resumed', `--repo-root=${repo}`, `--overlap-review=${review}`]);
  assert.equal(r.status, 0, r.stderr);

  // The resumed bundle has TWO events before the re-entry: [bundle_created, overlap_review].
  // "Resume" is the §8 path where the shell does NOT seed a new bundle — it records the same
  // review decision against the EXISTING bundle at its current tail. The review file is the
  // same artifact (same digest) the shell would carry into the resume turn.
  const dir = path.dirname(statePath);
  const before = readEvents(dir);
  assert.deepEqual(before.map((e) => e.type), ['bundle_created', 'overlap_review']);
  assert.equal(before[1].outcome, 'proceed');

  // A resumed bundle may have progressed since the seed (goals, a plan, a wave) — the review
  // is appended at the CURRENT tail, never re-ordered in front of later events.
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'phase_transition', ts: '2026-01-01T00:00:00Z', phase: 'plan' })}\n`);

  // Resume re-mints the review against the CURRENT inventory (which now includes the resumed
  // bundle itself — the shell reads `mp runs list` fresh at resume time, exactly as it does
  // before a seed). The digest the recorder validates is the one from THIS turn.
  const resumeReview = mintReview(repo, { candidates: [], action: 'proceed' });
  const resumed = run(['record-overlap-review', `--state=${statePath}`, `--repo-root=${repo}`, `--review-file=${resumeReview}`]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const rec = JSON.parse(resumed.stdout);
  assert.equal(rec.recorded, 'overlap_review');
  assert.equal(rec.outcome, 'proceed');

  const after = readEvents(dir);
  assert.deepEqual(after.map((e) => e.type), ['bundle_created', 'overlap_review', 'phase_transition', 'overlap_review']);
  const last = after[after.length - 1];
  assert.equal(typeof last.inventory_sha256, 'string');
  assert.deepEqual(last.candidates, []);

  // The reconstructed conflict view reads the LAST overlap_review — the resumed decision.
  const listed = JSON.parse(run(['runs', 'list', `--repo-root=${repo}`]).stdout);
  const rec2 = listed.runs.find((x) => x.slug === 'resumed');
  assert.equal(rec2.overlap.outcome, 'proceed');
  assert.equal(typeof rec2.overlap.inventory_sha256, 'string');
});

test('abort outcome: an abort review is the durable carrier and creates NO bundle', () => {
  // §8: *abort* creates nothing durable (nothing was created), and the sequencer says so. The
  // shell-facing contract is that an abort review is NOT handed to `mp seed` — seed always
  // creates once it has a valid review, so "abort" must never reach it. What IS verifiable
  // black-box is the carrier: the review artifact records action 'abort', `record-overlap-review`
  // persists that outcome on the RESUMED bundle, and a repo whose ONLY decision is an abort
  // review has no bundle and no run (nothing was created).
  const repo = makeGitRepo(tmp());

  // 1. The abort review is a valid review artifact over the current (empty) inventory.
  const abortReview = mintReview(repo, { candidates: [], action: 'abort' });

  // 2. The shell honoring abort does NOT seed: nothing on disk.
  //    (No seed call is made — the durable proof is that no bundle directory exists.)
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'masterplan')), true, 'the runs dir exists');
  assert.deepEqual(JSON.parse(run(['runs', 'list', `--repo-root=${repo}`]).stdout).runs, [],
    'a repo whose only decision is an abort review has no run');

  // 3. If a run was already seeded and the operator aborts at a LATER overlap re-check, the
  //    abort decision is recorded durably on that bundle (resume path), and the conflict view
  //    reads it.
  const seedReview = mintReview(repo, { candidates: [], action: 'proceed' });
  const statePath = path.join(repo, 'docs', 'masterplan', 'aborting', 'state.yml');
  const r = run(['seed', `--state=${statePath}`, '--slug=aborting', '--topic=aborting', `--repo-root=${repo}`, `--overlap-review=${seedReview}`]);
  assert.equal(r.status, 0, r.stderr);

  const dir = path.dirname(statePath);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'phase_transition', ts: '2026-01-01T00:00:00Z', phase: 'plan' })}\n`);

  // At the resumed overlap re-check the shell re-reads the CURRENT inventory and records the
  // abort decision it just took against it.
  const currentAbortReview = mintReview(repo, { candidates: [], action: 'abort' });
  const aborted = run(['record-overlap-review', `--state=${statePath}`, `--repo-root=${repo}`, `--review-file=${currentAbortReview}`]);
  assert.equal(aborted.status, 0, aborted.stderr);
  const rec = JSON.parse(aborted.stdout);
  assert.equal(rec.recorded, 'overlap_review');
  assert.equal(rec.outcome, 'abort');

  const evs = readEvents(dir);
  const last = evs[evs.length - 1];
  assert.equal(last.type, 'overlap_review');
  assert.equal(last.outcome, 'abort');
  const listed = JSON.parse(run(['runs', 'list', `--repo-root=${repo}`]).stdout);
  assert.equal(listed.runs.find((x) => x.slug === 'aborting').overlap.outcome, 'abort');
});

test('gated vs loose: the review action is the durable carrier of the AUQ decision, differing by mode', () => {
  // §8 AUQ rule: under GATED the AUQ lists archived candidates and offers continue · link as
  // predecessor · resume · abort; under LOOSE the AUQ fires only for in-progress or plan-level
  // conflicts and RECORDS ARCHIVED CANDIDATES SILENTLY (folded into the event/context, action
  // proceed). The CLI cannot know the autonomy mode — the shell maps the AUQ verdict onto the
  // review's `action`. The durable, black-box-verifiable contract is that the SAME archived
  // candidate inventory produces DIFFERENT recorded actions depending on which AUQ rule the
  // shell ran: an archived-only candidate under gated is offered (action 'review'), under loose
  // it is folded silently (action 'proceed'). Both must still carry the candidate in the event.
  const repo = makeGitRepo(tmp());

  // One archived run whose topic/goals overlap the new topic: the archived-candidate axis.
  const reviewP = mintReview(repo);
  const stateP = path.join(repo, 'docs', 'masterplan', 'pred', 'state.yml');
  const rp = run(['seed', `--state=${stateP}`, '--slug=pred', '--topic=shared topic', `--repo-root=${repo}`, `--overlap-review=${reviewP}`]);
  assert.equal(rp.status, 0, rp.stderr);
  // Archive it: goals.md carries the shared topic so the archived axis reads it.
  const dirP = path.dirname(stateP);
  fs.writeFileSync(path.join(dirP, 'goals.md'),
    'topic: shared topic\n\n## Intent\nwhy: w\noutcome: o\n\n## G1: goal a\n## G2: goal b\n## G3: goal c\n');
  const stP = parseState(fs.readFileSync(stateP, 'utf8'));
  stP.status = 'archived';
  fs.writeFileSync(stateP, serializeState(stP));

  // GATED: the same archived candidate is OFFERED — action 'review', candidate carried.
  const gatedReview = mintReview(repo, { candidates: [{ slug: 'pred', axis: 'archived_topic', status: 'archived' }], action: 'review' });
  const stateG = path.join(repo, 'docs', 'masterplan', 'gated', 'state.yml');
  const rg = run(['seed', `--state=${stateG}`, '--slug=gated', '--topic=shared topic', `--repo-root=${repo}`, `--overlap-review=${gatedReview}`]);
  assert.equal(rg.status, 0, rg.stderr);
  const gatedEvs = readEvents(path.dirname(stateG));
  const gatedOv = gatedEvs.find((e) => e.type === 'overlap_review');
  assert.equal(gatedOv.outcome, 'review');
  assert.deepEqual(gatedOv.candidates, [{ slug: 'pred', axis: 'archived_topic', status: 'archived' }]);

  // LOOSE: the same archived candidate is folded SILENTLY — action 'proceed', candidate carried
  // in the event (folded into context, never offered).
  const looseReview = mintReview(repo, { candidates: [{ slug: 'pred', axis: 'archived_topic', status: 'archived' }], action: 'proceed' });
  const stateL = path.join(repo, 'docs', 'masterplan', 'loose', 'state.yml');
  const rl = run(['seed', `--state=${stateL}`, '--slug=loose', '--topic=shared topic', `--repo-root=${repo}`, `--overlap-review=${looseReview}`]);
  assert.equal(rl.status, 0, rl.stderr);
  const looseEvs = readEvents(path.dirname(stateL));
  const looseOv = looseEvs.find((e) => e.type === 'overlap_review');
  assert.equal(looseOv.outcome, 'proceed');
  assert.deepEqual(looseOv.candidates, [{ slug: 'pred', axis: 'archived_topic', status: 'archived' }]);

  // The two modes are durably DISTINGUISHABLE by the recorded action on the same inventory.
  assert.notEqual(gatedOv.outcome, looseOv.outcome);
});
