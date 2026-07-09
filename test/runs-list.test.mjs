// test/runs-list.test.mjs — F5 multi-run discovery: the engine (lib/runs.mjs) AND
// the CLI surfaces it powers (`mp runs list`, `mp set-discovery`, and the
// `mp status` other-runs block).
//
// Fixtures are REAL directory trees under os.tmpdir() (never inside the repo
// worktree, per the no-loose-files rule). A repo root is marked by a `.git`
// entry — a plain directory OR a FILE gitlink (the worktree/submodule form) —
// because isGitRepoRoot() only stat-probes `.git`; no real `git` process is
// needed, which keeps the suite hermetic and fast. Unreadable state is modeled
// by making state.yml a DIRECTORY (readFileSync then throws EISDIR regardless
// of uid — robust even if the test host runs as root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverRuns, deriveLastActivity, readDiscoveryConfig } from '../lib/runs.mjs';
import { writeState } from '../lib/bundle.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

// Spawn the real CLI; capture stdout/stderr/exit without throwing.
function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// Canonicalized temp root so /tmp symlink quirks never skew realpath() dedupe.
function tmp(prefix = 'mp-runs-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Mark `dir` as a repo root. gitlink=true writes `.git` as a FILE (the
// worktree/submodule gitlink form); otherwise `.git` is a directory.
function mkrepo(dir, { gitlink = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (gitlink) fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(dir, '.realgit')}\n`);
  else fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

// Write one run bundle under <root>/docs/masterplan/<slug>/.
//   corruptState -> state.yml with no slug/status (malformed -> WARN+skip)
//   unreadable   -> state.yml is a DIRECTORY (readFileSync -> EISDIR -> WARN+skip)
//   events       -> raw events.jsonl body (may be intentionally corrupt)
function bundle(root, slug, opts = {}) {
  const { status = 'in-progress', phase = 'execute', tasks = [], events, corruptState = false, unreadable = false } = opts;
  const dir = path.join(root, 'docs', 'masterplan', slug);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.yml');
  if (unreadable) {
    fs.mkdirSync(statePath, { recursive: true });
  } else if (corruptState) {
    fs.writeFileSync(statePath, 'note: no slug or status on this bundle\nplain text line, not a field\n');
  } else {
    writeState(statePath, { schema_version: 8, slug, status, phase, tasks });
  }
  if (events !== undefined) fs.writeFileSync(path.join(dir, 'events.jsonl'), events);
  return { dir, statePath };
}

// Parse `mp runs list` stdout into its {runs, warnings} record.
function listRuns(repoRoot, extraArgs = []) {
  const r = run(['runs', 'list', `--repo-root=${repoRoot}`, ...extraArgs]);
  assert.equal(r.status, 0, `runs list should exit 0: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const slugsOf = (parsed) => parsed.runs.map((x) => x.slug).sort();
const warnText = (parsed) => parsed.warnings.map((w) => `${w.scope}:${w.message}`).join('\n');

// A layered fixture MAIN with nested repos at varying depths + excluded trees.
function makeInventory() {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  bundle(MAIN, 'main-a');
  bundle(MAIN, 'main-b');

  // depth-1 nested sub-repo (also the enclosing target for the reverse test)
  const SUB = mkrepo(path.join(MAIN, 'sub'));
  bundle(SUB, 'sub-run');

  // `.git` FILE gitlink form must still be recognized as a repo root
  const LINKED = mkrepo(path.join(MAIN, 'linked'), { gitlink: true });
  bundle(LINKED, 'linked-run');

  // depth-3 nested repo — the LAST depth the default cap (3) reaches
  const ATMAX = mkrepo(path.join(MAIN, 'n1', 'n2', 'atmax'));
  bundle(ATMAX, 'atmax-run');

  // depth-4 nested repo — BEYOND the cap; must NOT be discovered
  const DEEP = mkrepo(path.join(MAIN, 'deep', 'l2', 'l3', 'deeprepo'));
  bundle(DEEP, 'deep-run');

  // repos inside excluded dir names must NOT be discovered
  bundle(mkrepo(path.join(MAIN, '.worktrees', 'wt')), 'wt-run');
  bundle(mkrepo(path.join(MAIN, 'node_modules', 'pkg')), 'nm-run');

  return { root, MAIN, SUB };
}

test('runs list inventories MAIN + nested repos, honoring depth cap, exclusions, and .git-file gitlinks', () => {
  const { MAIN } = makeInventory();
  const parsed = listRuns(MAIN);
  const slugs = slugsOf(parsed);
  // present: MAIN's own bundles + depth-1 sub + depth-3 atmax + gitlink repo
  for (const s of ['main-a', 'main-b', 'sub-run', 'atmax-run', 'linked-run']) {
    assert.ok(slugs.includes(s), `expected ${s} in ${JSON.stringify(slugs)}`);
  }
  // absent: depth-4 (cap) + .worktrees + node_modules
  for (const s of ['deep-run', 'wt-run', 'nm-run']) {
    assert.ok(!slugs.includes(s), `did NOT expect ${s} in ${JSON.stringify(slugs)}`);
  }
});

test('runs list reverse direction: from the sub-repo, parent-repo bundles appear via the upward walk', () => {
  const { SUB } = makeInventory();
  const parsed = listRuns(SUB);
  const slugs = slugsOf(parsed);
  assert.ok(slugs.includes('sub-run'), 'sub-repo own bundle present');
  // the enclosing walk finds MAIN -> its bundles surface from inside the child
  assert.ok(slugs.includes('main-a'), `parent bundle main-a via upward walk: ${JSON.stringify(slugs)}`);
});

test('overlapping roots (nested + explicit + symlink alias) yield exactly ONE entry per bundle', () => {
  const { root, MAIN, SUB } = makeInventory();
  const alias = path.join(root, 'sub-alias');
  fs.symlinkSync(SUB, alias, 'dir');
  // SUB is (a) nested under MAIN, (b) passed explicitly, and (c) passed via a
  // symlink alias — all three canonicalize to one root, so `sub-run` de-dupes.
  const parsed = listRuns(MAIN, [`--roots=${SUB},${alias}`]);
  const count = parsed.runs.filter((r) => r.slug === 'sub-run').length;
  assert.equal(count, 1, `sub-run must appear exactly once, got ${count}`);
});

test('engine: the nested-walk depth cap is enforced by maxDepth', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  bundle(mkrepo(path.join(MAIN, 'a', 'repo2')), 'r2'); // repo at depth 2
  const deep = discoverRuns({ repoRoot: MAIN, readConfig: false, maxDepth: 3 });
  const shallow = discoverRuns({ repoRoot: MAIN, readConfig: false, maxDepth: 1 });
  assert.ok(deep.runs.some((r) => r.slug === 'r2'), 'maxDepth 3 discovers the depth-2 repo');
  assert.ok(!shallow.runs.some((r) => r.slug === 'r2'), 'maxDepth 1 does NOT descend to the depth-2 repo');
});

test('per-bundle isolation: corrupt + unreadable state WARN+skip; corrupt events WARN but bundle still lists', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  bundle(MAIN, 'good');
  bundle(MAIN, 'corrupt', { corruptState: true });
  bundle(MAIN, 'unreadable', { unreadable: true });
  bundle(MAIN, 'bad-events', { events: '{ not json\n{"ts":"2021-06-01T00:00:00.000Z"}\n' });

  const parsed = listRuns(MAIN);
  const slugs = slugsOf(parsed);
  // good + bad-events survive; the two broken-state bundles are skipped
  assert.ok(slugs.includes('good'), 'a healthy sibling still lists');
  assert.ok(slugs.includes('bad-events'), 'corrupt events.jsonl STILL lists the bundle (fallback activity)');
  assert.ok(!slugs.includes('corrupt'), 'malformed state.yml is skipped');
  assert.ok(!slugs.includes('unreadable'), 'unreadable state.yml is skipped');
  const w = warnText(parsed);
  assert.match(w, /bundle:malformed state\.yml/);
  assert.match(w, /bundle:unreadable state\.yml/);
  assert.match(w, /events:.*events\.jsonl/);
  // the scan never aborted: both broken bundles produced WARNs yet good survived
  assert.ok(parsed.warnings.filter((x) => x.scope === 'bundle').length >= 2, 'two bundle WARNs isolated');
});

test('last_activity is event-dominant: an old event stream beats a freshly-touched state.yml', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  const OLD = '2020-01-01T00:00:00.000Z';
  const oldMs = Date.parse(OLD);
  const { dir, statePath } = bundle(MAIN, 'stale', {
    events: JSON.stringify({ ts: OLD, type: 'milestone' }) + '\n',
  });
  // state.yml was just written (mtime ~ now); the event stream carries a 2020 stamp.
  const derived = deriveLastActivity(dir, statePath);
  assert.equal(derived.source, 'events', 'events dominate the derivation');
  assert.equal(derived.last_activity, oldMs, 'derived activity is the OLD event ts, not the fresh state mtime');
  assert.ok(derived.last_activity < Date.now() - 1e9, 'reads stale');
  // ...and the CLI record agrees
  const rec = listRuns(MAIN).runs.find((r) => r.slug === 'stale');
  assert.equal(rec.last_activity, oldMs);
  assert.equal(rec.last_activity_source, 'events');
});

test('non-repo and unresolvable --roots WARN+skip without aborting the scan', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  bundle(MAIN, 'keep');
  const afile = path.join(root, 'a-file.txt');
  fs.writeFileSync(afile, 'not a directory\n');
  const missing = path.join(root, 'does', 'not', 'exist');
  const parsed = listRuns(MAIN, [`--roots=${afile},${missing}`]);
  const w = warnText(parsed);
  assert.match(w, /root:discovery root is not a directory/);
  assert.match(w, /root:unresolvable discovery root/);
  assert.ok(slugsOf(parsed).includes('keep'), 'a bad root never aborts the scan');
});

test('set-discovery --add-root/--remove-root round-trips through .discovery.yml', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  const extra = mkrepo(path.join(root, 'extra')); // sibling: only reachable via config
  bundle(extra, 'extra-run');
  const extraCanon = fs.realpathSync(extra);

  const added = run(['set-discovery', `--repo-root=${MAIN}`, `--add-root=${extra}`]);
  assert.equal(added.status, 0, added.stderr);
  const addOut = JSON.parse(added.stdout);
  assert.equal(addOut.action, 'add');
  assert.equal(addOut.changed, true);
  assert.deepEqual(addOut.roots, [extraCanon]);
  assert.deepEqual(readDiscoveryConfig(MAIN).roots, [extraCanon], 'config persists the canonical root');
  // the configured root is now inventoried without any --roots argument
  assert.ok(slugsOf(listRuns(MAIN)).includes('extra-run'), 'configured root is scanned');

  const removed = run(['set-discovery', `--repo-root=${MAIN}`, `--remove-root=${extra}`]);
  assert.equal(removed.status, 0, removed.stderr);
  const rmOut = JSON.parse(removed.stdout);
  assert.equal(rmOut.action, 'remove');
  assert.equal(rmOut.changed, true);
  assert.deepEqual(rmOut.roots, []);
  assert.deepEqual(readDiscoveryConfig(MAIN).roots, [], 'root removed from config');
});

test('.discovery.yml entries that are unresolvable WARN+skip; scan continues', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  bundle(MAIN, 'keep');
  const missing = path.join(root, 'ghost'); // non-existent -> stays textual in config
  const added = run(['set-discovery', `--repo-root=${MAIN}`, `--add-root=${missing}`]);
  assert.equal(added.status, 0, added.stderr);
  const parsed = listRuns(MAIN);
  assert.match(warnText(parsed), /root:unresolvable discovery root/);
  assert.ok(slugsOf(parsed).includes('keep'), 'a bad configured root never aborts the scan');
});

test('mp status prints the other-runs block for a second non-archived bundle in a discovery root', () => {
  const root = tmp();
  const MAIN = mkrepo(path.join(root, 'main'));
  const self = bundle(MAIN, 'self-run');
  bundle(MAIN, 'archived-run', { status: 'archived' }); // must be EXCLUDED
  bundle(mkrepo(path.join(MAIN, 'sub')), 'other-run');   // nested discovery root

  const r = run(['status', `--state=${self.statePath}`]);
  assert.equal(r.status, 0, r.stderr);
  // output-level proof (not node --check): the other-run line is present in stdout
  assert.match(r.stdout, /other-run/);
  const parsed = JSON.parse(r.stdout);
  const otherSlugs = parsed.other_runs.map((x) => x.slug);
  assert.ok(otherSlugs.includes('other-run'), `other-run surfaced: ${JSON.stringify(otherSlugs)}`);
  assert.ok(!otherSlugs.includes('self-run'), 'the current bundle is excluded from other-runs');
  assert.ok(!otherSlugs.includes('archived-run'), 'archived bundles are excluded');
});
