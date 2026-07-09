// test/refs.test.mjs - pure-unit coverage for lib/refs.mjs (the F1 decision core).
// No disk: every fs-touching helper is exercised through its injected exists/realpath dep.
// The CLI-driven success-criteria matrix (spawning `mp refs ...`) lands in a later task that
// EXTENDS this file; this wave proves the pure core in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DIRECTIONS, SLUG_RE, RefsError,
  isValidTargetSlug, validateTargetSlug,
  assertDirection, reciprocalDirection,
  normalizeRepo, refKey, ensureRefs,
  upsertRef, removeRef, listRefs,
  buildEntry, planRefsAdd, applyRefsAdd,
  resolveTargetBundlePath,
  findRepoRoot, deriveDefaultTargetRepo, canonicalizeRepoRoot,
} from '../lib/refs.mjs';

// --- slug validation / traversal guard ---

test('isValidTargetSlug accepts bare slugs, rejects unsafe', () => {
  for (const ok of ['a', 'a1', 'plan-f3', 'x0-y1-z2']) assert.equal(isValidTargetSlug(ok), true, ok);
  for (const bad of ['../x', 'a/b', 'a\\b', '/abs', 'A', '-lead', '', '..', 'a..b']) {
    assert.equal(isValidTargetSlug(bad), false, bad);
  }
  assert.equal(isValidTargetSlug(42), false);
});

test('validateTargetSlug returns the slug for safe input', () => {
  assert.equal(validateTargetSlug('good-slug'), 'good-slug');
});

test('validateTargetSlug throws RefsError bad_slug on traversal primitives', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', '/etc/passwd', '..', 'a/../b']) {
    assert.throws(() => validateTargetSlug(bad), (e) => e instanceof RefsError && e.code === 'bad_slug', bad);
  }
});

test('validateTargetSlug throws on empty / non-string / uppercase / leading hyphen', () => {
  for (const bad of ['', undefined, null, 123, 'Upper', '-lead']) {
    assert.throws(() => validateTargetSlug(bad), (e) => e instanceof RefsError && e.code === 'bad_slug');
  }
});

test('SLUG_RE anchors both ends', () => {
  assert.equal(SLUG_RE.test('ok-1'), true);
  assert.equal(SLUG_RE.test('ok/1'), false);
});

// --- direction ---

test('DIRECTIONS is back/forward', () => {
  assert.deepEqual(DIRECTIONS, ['back', 'forward']);
});
test('reciprocalDirection flips', () => {
  assert.equal(reciprocalDirection('back'), 'forward');
  assert.equal(reciprocalDirection('forward'), 'back');
});
test('assertDirection rejects junk', () => {
  assert.throws(() => assertDirection('sideways'), (e) => e instanceof RefsError && e.code === 'bad_direction');
});

// --- (repo, slug) identity ---

test('normalizeRepo maps absent repo to the holding repo root', () => {
  assert.equal(normalizeRepo(undefined, '/repo'), '/repo');
  assert.equal(normalizeRepo(null, '/repo'), '/repo');
  assert.equal(normalizeRepo('', '/repo'), '/repo');
  assert.equal(normalizeRepo('/other', '/repo'), '/other');
});

test('refKey treats absent repo and explicit own root as the same identity', () => {
  assert.equal(refKey({ slug: 's' }, '/repo'), refKey({ slug: 's', repo: '/repo' }, '/repo'));
});

test('refKey distinguishes the same slug in two repos', () => {
  assert.notEqual(refKey({ slug: 's', repo: '/a' }, '/x'), refKey({ slug: 's', repo: '/b' }, '/x'));
});

// --- upsert / remove / list ---

const base = () => ({ slug: 'src', topic: 'Source topic', refs: { back: [], forward: [] } });

test('upsertRef adds a new entry (changed true)', () => {
  const r = upsertRef(base(), 'forward', { slug: 'tgt' }, '/repo');
  assert.equal(r.changed, true);
  assert.equal(r.state.refs.forward.length, 1);
  assert.equal(r.state.refs.forward[0].slug, 'tgt');
});

test('upsertRef is idempotent on the (repo,slug) pair (no-op detector)', () => {
  const once = upsertRef(base(), 'forward', { slug: 'tgt' }, '/repo');
  const twice = upsertRef(once.state, 'forward', { slug: 'tgt', label: 'ignored-relabel' }, '/repo');
  assert.equal(twice.changed, false);
  assert.equal(twice.state.refs.forward.length, 1);
  assert.strictEqual(twice.state, once.state);
});

test('upsertRef keeps same-slug entries from two different repos distinct', () => {
  const a = upsertRef(base(), 'forward', { slug: 'tgt', repo: '/a' }, '/repo');
  const b = upsertRef(a.state, 'forward', { slug: 'tgt', repo: '/b' }, '/repo');
  assert.equal(b.changed, true);
  assert.equal(b.state.refs.forward.length, 2);
});

test('upsertRef normalizes absent repo against own root', () => {
  const a = upsertRef(base(), 'forward', { slug: 'tgt' }, '/repo');
  const b = upsertRef(a.state, 'forward', { slug: 'tgt', repo: '/repo' }, '/repo');
  assert.equal(b.changed, false);
});

test('upsertRef validates the slug (rejects a traversal slug)', () => {
  assert.throws(() => upsertRef(base(), 'forward', { slug: '../evil' }, '/repo'),
    (e) => e instanceof RefsError && e.code === 'bad_slug');
});

test('removeRef removes a matching pair (changed true)', () => {
  const a = upsertRef(base(), 'back', { slug: 'tgt', repo: '/a' }, '/repo');
  const r = removeRef(a.state, 'back', { slug: 'tgt', repo: '/a' }, '/repo');
  assert.equal(r.changed, true);
  assert.equal(r.state.refs.back.length, 0);
});

test('removeRef of an absent entry is a no-op (changed false)', () => {
  const r = removeRef(base(), 'back', { slug: 'ghost' }, '/repo');
  assert.equal(r.changed, false);
});

test('removeRef targets the correct repo among same-slug entries', () => {
  let s = base();
  s = upsertRef(s, 'forward', { slug: 'tgt', repo: '/a' }, '/repo').state;
  s = upsertRef(s, 'forward', { slug: 'tgt', repo: '/b' }, '/repo').state;
  const r = removeRef(s, 'forward', { slug: 'tgt', repo: '/a' }, '/repo');
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.refs.forward.map((e) => e.repo), ['/b']);
});

test('removeRef matches a stored deleted-repo identity textually', () => {
  const s = { ...base(), refs: { back: [{ slug: 'tgt', repo: '/gone/away' }], forward: [] } };
  const r = removeRef(s, 'back', { slug: 'tgt', repo: '/gone/away' }, '/repo');
  assert.equal(r.changed, true);
  assert.equal(r.state.refs.back.length, 0);
});

test('ensureRefs defaults an absent refs key to empty lists', () => {
  assert.deepEqual(ensureRefs({}), { back: [], forward: [] });
  assert.deepEqual(ensureRefs({ refs: { forward: [{ slug: 'x' }] } }), { back: [], forward: [{ slug: 'x' }] });
});

test('listRefs returns shallow copies of both lists', () => {
  const s = { refs: { back: [{ slug: 'b' }], forward: [{ slug: 'f' }] } };
  const l = listRefs(s);
  assert.deepEqual(l, { back: [{ slug: 'b' }], forward: [{ slug: 'f' }] });
  l.back.push({ slug: 'mutant' });
  assert.equal(s.refs.back.length, 1);
});

// --- entry / reciprocal construction ---

test('buildEntry omits repo for a same-repo target, keeps label', () => {
  const e = buildEntry({ slug: 'tgt', label: 'L', entryRepoRoot: '/repo', holdingRepoRoot: '/repo' });
  assert.deepEqual(e, { slug: 'tgt', label: 'L' });
});

test('buildEntry records repo for a cross-repo target, omits an empty label', () => {
  const e = buildEntry({ slug: 'tgt', label: '', entryRepoRoot: '/other', holdingRepoRoot: '/repo' });
  assert.deepEqual(e, { slug: 'tgt', repo: '/other' });
});

test('planRefsAdd builds source entry + reciprocal on the opposite direction', () => {
  const plan = planRefsAdd({
    direction: 'forward', sourceRepoRoot: '/repo', sourceSlug: 'src', sourceTopic: 'Source topic',
    targetRepoRoot: '/repo', targetSlug: 'tgt', label: 'Explicit label',
  });
  assert.equal(plan.source.direction, 'forward');
  assert.equal(plan.target.direction, 'back');
  assert.deepEqual(plan.source.entry, { slug: 'tgt', label: 'Explicit label' });
});

test('planRefsAdd reciprocal label defaults to the SOURCE topic, never the supplied label', () => {
  const plan = planRefsAdd({
    direction: 'forward', sourceRepoRoot: '/repo', sourceSlug: 'src', sourceTopic: 'Source topic',
    targetRepoRoot: '/repo', targetSlug: 'tgt', label: 'Explicit label',
  });
  assert.equal(plan.target.entry.label, 'Source topic');
  assert.notEqual(plan.target.entry.label, 'Explicit label');
  assert.equal(plan.target.entry.slug, 'src');
});

test('planRefsAdd cross-repo records each side foreign repo root', () => {
  const plan = planRefsAdd({
    direction: 'back', sourceRepoRoot: '/repoA', sourceSlug: 'src', sourceTopic: 'T',
    targetRepoRoot: '/repoB', targetSlug: 'tgt', label: null,
  });
  assert.equal(plan.source.entry.repo, '/repoB');
  assert.equal(plan.target.entry.repo, '/repoA');
});

test('planRefsAdd validates both target and source slugs', () => {
  assert.throws(() => planRefsAdd({ direction: 'forward', sourceRepoRoot: '/r', sourceSlug: 'src', targetRepoRoot: '/r', targetSlug: '../evil' }),
    (e) => e instanceof RefsError && e.code === 'bad_slug');
  assert.throws(() => planRefsAdd({ direction: 'forward', sourceRepoRoot: '/r', sourceSlug: 'a/b', targetRepoRoot: '/r', targetSlug: 'tgt' }),
    (e) => e instanceof RefsError && e.code === 'bad_slug');
});

test('applyRefsAdd writes the reciprocal into both states and is idempotent on re-apply', () => {
  const plan = planRefsAdd({
    direction: 'forward', sourceRepoRoot: '/repo', sourceSlug: 'src', sourceTopic: 'Source topic',
    targetRepoRoot: '/repo', targetSlug: 'tgt', label: 'L',
  });
  const src = { slug: 'src', refs: { back: [], forward: [] } };
  const tgt = { slug: 'tgt', refs: { back: [], forward: [] } };
  const r1 = applyRefsAdd(src, tgt, plan);
  assert.equal(r1.sourceChanged, true);
  assert.equal(r1.targetChanged, true);
  assert.equal(r1.sourceState.refs.forward[0].slug, 'tgt');
  assert.equal(r1.targetState.refs.back[0].slug, 'src');
  assert.equal(r1.targetState.refs.back[0].label, 'Source topic');
  const r2 = applyRefsAdd(r1.sourceState, r1.targetState, plan);
  assert.equal(r2.sourceChanged, false);
  assert.equal(r2.targetChanged, false);
});

// --- path resolution + stored-slug re-validation ---

test('resolveTargetBundlePath builds repo/docs/masterplan/slug/state.yml', () => {
  assert.equal(resolveTargetBundlePath('/repo', 'tgt'), path.join('/repo', 'docs', 'masterplan', 'tgt', 'state.yml'));
});

test('resolveTargetBundlePath re-validates a malicious stored slug before building a path', () => {
  assert.throws(() => resolveTargetBundlePath('/repo', '../../etc'),
    (e) => e instanceof RefsError && e.code === 'bad_slug');
});

// --- injectable fs helpers (no real disk) ---

test('findRepoRoot walks up to the nearest .git via injected exists', () => {
  const gitAt = '/srv/dev/repo';
  const exists = (p) => p === path.join(gitAt, '.git');
  const root = findRepoRoot('/srv/dev/repo/docs/masterplan/slug/state.yml', { exists });
  assert.equal(root, gitAt);
});

test('findRepoRoot returns null when no .git ancestor exists', () => {
  assert.equal(findRepoRoot('/a/b/c/state.yml', { exists: () => false }), null);
});

test('deriveDefaultTargetRepo returns the SOURCE bundle repo root from the state path (never MAIN)', () => {
  const sub = '/srv/dev/parent/sub';
  const exists = (p) => p === path.join(sub, '.git');
  const root = deriveDefaultTargetRepo('/srv/dev/parent/sub/docs/masterplan/run/state.yml', { exists });
  assert.equal(root, sub);
});

test('deriveDefaultTargetRepo throws when the state path is not inside a repo', () => {
  assert.throws(() => deriveDefaultTargetRepo('/nowhere/state.yml', { exists: () => false }),
    (e) => e instanceof RefsError && e.code === 'no_repo_root');
});

test('canonicalizeRepoRoot realpaths a symlink alias and requires a real repo root', () => {
  const realpath = (p) => (p === '/alias' ? '/srv/dev/repo' : p);
  const exists = (p) => p === '/srv/dev/repo/.git';
  assert.equal(canonicalizeRepoRoot('/alias', { realpath, exists }), '/srv/dev/repo');
});

test('canonicalizeRepoRoot rejects a non-repo path (no .git)', () => {
  assert.throws(() => canonicalizeRepoRoot('/tmp/plain', { realpath: (p) => p, exists: () => false }),
    (e) => e instanceof RefsError && e.code === 'bad_repo');
});

test('canonicalizeRepoRoot rejects a path that does not exist (realpath throws)', () => {
  assert.throws(() => canonicalizeRepoRoot('/gone', { realpath: () => { throw new Error('ENOENT'); }, exists: () => true }),
    (e) => e instanceof RefsError && e.code === 'bad_repo');
});

// ===========================================================================
// CLI-driven success-criteria matrix — spawns the real `mp refs add|remove|list`
// (+ `status`) over temp bundles on disk. This EXTENDS the pure-core coverage
// above (which must land first, since both share this file). Every fs-touching
// behavior of lib/refs.mjs is exercised end-to-end through bin/masterplan.mjs.
import { spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serializeState } from '../lib/bundle.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

function run(args, opts = {}) {
  // spawnSync (not execFileSync) so BOTH stdout and stderr are captured even on a zero exit — the
  // dangling-ref source-only removal succeeds (exit 0) yet WARNs on stderr, and we assert that WARN.
  const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// A real repo root is a dir containing `.git` (findRepoRoot walks up to it). realpath the root so
// expectations survive an os.tmpdir() that itself contains a symlink component.
function mkRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}
function mkBundle(repoRoot, slug, extra = {}) {
  const dir = path.join(repoRoot, 'docs', 'masterplan', slug);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(statePath, serializeState({
    schema_version: 9, slug, status: 'in-progress', phase: 'execute',
    topic: `${slug} topic`, tasks: [], ...extra,
  }));
  return statePath;
}
const bundleDir = (statePath) => path.dirname(statePath);
const listRefsCli = (statePath) => JSON.parse(run(['refs', 'list', `--state=${statePath}`]).stdout);
const readEvents = (statePath) => {
  const p = path.join(bundleDir(statePath), 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const PLAN_INDEX = JSON.stringify({
  schema_version: '6.0',
  tasks: [{ id: 1, wave: 0, description: 't', files: ['a.txt'], verify_commands: ['true'], codex: null }],
});
// Guard-D identity flags every locking refs op needs (resolveOwnerSelf dies without a session).
const ident = (session = 'sess-test', host = 'host-test', now = 1000) =>
  [`--session=${session}`, `--host=${host}`, `--now=${now}`];

// --- add / reciprocal-write / idempotent-upsert / events ---

test('CLI refs add: writes the reciprocal into BOTH bundles, appends refs_added to BOTH events.jsonl', () => {
  const repo = mkRepo('mp-refs-add-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  const r = run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { refs: 'add', direction: 'forward', target: 'tgt', source_changed: true, target_changed: true });
  // source forward → tgt (same-repo, so no repo field); target back → src with the SOURCE topic as label.
  assert.deepEqual(listRefsCli(src), { back: [], forward: [{ slug: 'tgt' }] });
  assert.deepEqual(listRefsCli(tgt), { back: [{ slug: 'src', label: 'src topic' }], forward: [] });
  const srcEv = readEvents(src).filter((e) => e.type === 'refs_added');
  const tgtEv = readEvents(tgt).filter((e) => e.type === 'refs_added');
  assert.equal(srcEv.length, 1);
  assert.equal(tgtEv.length, 1);
  assert.equal(srcEv[0].direction, 'forward');
  assert.equal(srcEv[0].target, 'tgt');
  assert.equal(tgtEv[0].direction, 'back');
  assert.equal(tgtEv[0].slug, 'src');
});

test('CLI refs add: reciprocal label defaults to the SOURCE topic (never the --label)', () => {
  const repo = mkRepo('mp-refs-label-');
  const src = mkBundle(repo, 'src', { topic: 'Distinct Source Topic' });
  const tgt = mkBundle(repo, 'tgt');
  run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', '--label=Explicit Label', ...ident()]);
  // the source entry carries the explicit label; the reciprocal carries the source TOPIC.
  assert.deepEqual(listRefsCli(src).forward, [{ slug: 'tgt', label: 'Explicit Label' }]);
  assert.deepEqual(listRefsCli(tgt).back, [{ slug: 'src', label: 'Distinct Source Topic' }]);
});

test('CLI refs add: idempotent re-add is a no-op that appends NO event to either side', () => {
  const repo = mkRepo('mp-refs-idem-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  const before = { src: readEvents(src).length, tgt: readEvents(tgt).length };
  const r = run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident('sess-test', 'host-test', 1001)]);
  assert.deepEqual(JSON.parse(r.stdout), { refs: 'add', direction: 'forward', target: 'tgt', source_changed: false, target_changed: false });
  assert.equal(readEvents(src).length, before.src, 'no-op add must append NO source event');
  assert.equal(readEvents(tgt).length, before.tgt, 'no-op add must append NO target event');
});

test('CLI refs add: a missing target bundle is refused (add is strict) — nothing written', () => {
  const repo = mkRepo('mp-refs-miss-');
  const src = mkBundle(repo, 'src');
  const r = run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=ghost', ...ident()]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not exist — nothing written/);
  assert.deepEqual(listRefsCli(src), { back: [], forward: [] });
});

// --- remove / reciprocal / no-op / dangling ---

test('CLI refs remove: a resolved remove clears BOTH sides and appends refs_removed to BOTH events.jsonl', () => {
  const repo = mkRepo('mp-refs-rm-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  const r = run(['refs', 'remove', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident('sess-test', 'host-test', 1001)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { refs: 'remove', direction: 'forward', target: 'tgt', source_changed: true, target_changed: true, target_resolved: true });
  assert.deepEqual(listRefsCli(src), { back: [], forward: [] });
  assert.deepEqual(listRefsCli(tgt), { back: [], forward: [] });
  assert.equal(readEvents(src).filter((e) => e.type === 'refs_removed').length, 1);
  assert.equal(readEvents(tgt).filter((e) => e.type === 'refs_removed').length, 1);
});

test('CLI refs remove: a no-op remove of an absent ref appends NO event', () => {
  const repo = mkRepo('mp-refs-rm-noop-');
  const src = mkBundle(repo, 'src');
  mkBundle(repo, 'tgt');
  const r = run(['refs', 'remove', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).source_changed, false);
  assert.equal(readEvents(src).length, 0, 'no-op remove must append NO event');
});

test('CLI refs remove: an unresolvable (deleted-repo) target is removed SOURCE-only via textual --repo match, source-only event', () => {
  // A dangling cross-repo ref (its repo no longer exists on disk) stands in for a deleted target repo.
  // Remove matches the STORED identity as text, canonicalizing only when the path still exists.
  const repo = mkRepo('mp-refs-dangling-');
  const gonePath = '/nonexistent/deleted-repo';
  const src = mkBundle(repo, 'src', { refs: { back: [], forward: [{ slug: 'gone', repo: gonePath }] } });
  const r = run(['refs', 'remove', `--state=${src}`, '--direction=forward', '--target=gone', `--repo=${gonePath}`, ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.source_changed, true);
  assert.equal(out.target_changed, false);
  assert.equal(out.target_resolved, false);
  assert.match(r.stderr, /did not resolve — removing the SOURCE side only/);
  assert.deepEqual(listRefsCli(src), { back: [], forward: [] });
  const ev = readEvents(src).filter((e) => e.type === 'refs_removed');
  assert.equal(ev.length, 1, 'source-side refs_removed event present');
});

// --- (repo, slug) identity + cross-repo reciprocals ---

test('CLI refs add: the SAME slug in two repos resolves as distinct identities (cross-repo reciprocals written across repos)', () => {
  const repoA = mkRepo('mp-refs-idA-');
  const repoB = mkRepo('mp-refs-idB-');
  const a = mkBundle(repoA, 'shared', { topic: 'A topic' });
  const b = mkBundle(repoB, 'shared', { topic: 'B topic' });
  const r = run(['refs', 'add', `--state=${a}`, '--direction=forward', '--target=shared', `--repo=${repoB}`, ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  // A's forward ref carries repoB (cross-repo → repo field present, keyed on the OTHER repo).
  assert.deepEqual(listRefsCli(a).forward, [{ slug: 'shared', repo: repoB }]);
  // B (same slug, different repo) got the reciprocal keyed back on repoA — NOT confused with A's own bundle.
  assert.deepEqual(listRefsCli(b).back, [{ slug: 'shared', label: 'A topic', repo: repoA }]);
  assert.deepEqual(listRefsCli(b).forward, []);
});

test('CLI refs add: a same-slug parent/sub-repo pair stays distinct (identity is (repo,slug), not slug)', () => {
  const parent = mkRepo('mp-refs-parent-');
  const sub = path.join(parent, 'sub');
  fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
  const pBundle = mkBundle(parent, 'dup', { topic: 'parent dup' });
  const sBundle = mkBundle(sub, 'dup', { topic: 'sub dup' });
  const r = run(['refs', 'add', `--state=${pBundle}`, '--direction=forward', '--target=dup', `--repo=${sub}`, ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listRefsCli(pBundle).forward, [{ slug: 'dup', repo: sub }]);
  assert.deepEqual(listRefsCli(sBundle).back, [{ slug: 'dup', label: 'parent dup', repo: parent }]);
});

// --- live-foreign-owner refusal on BOTH source and target ---

test('CLI refs add: a LIVE foreign owner on the SOURCE bundle refuses the write (names the owner) — nothing written', () => {
  const repo = mkRepo('mp-refs-fown-src-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  // Plant a live foreign lock on the SOURCE via the real acquire-owner verb (fresh at now=2000).
  assert.equal(run(['acquire-owner', `--state=${src}`, ...ident('foreign-sess', 'foreign-host', 2000)]).status, 0);
  const r = run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident('me-sess', 'me-host', 2001)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /source bundle .* is owned by foreign-host\/foreign-sess — nothing written/);
  assert.deepEqual(listRefsCli(src), { back: [], forward: [] }, 'nothing written on refusal');
  assert.deepEqual(listRefsCli(tgt), { back: [], forward: [] });
});

test('CLI refs add: a LIVE foreign owner on the TARGET bundle refuses the write (names the owner) — nothing written', () => {
  const repo = mkRepo('mp-refs-fown-tgt-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  assert.equal(run(['acquire-owner', `--state=${tgt}`, ...ident('foreign-sess', 'foreign-host', 2000)]).status, 0);
  const r = run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident('me-sess', 'me-host', 2001)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /target bundle .* is owned by foreign-host\/foreign-sess — nothing written/);
  assert.deepEqual(listRefsCli(src), { back: [], forward: [] }, 'nothing written on refusal');
  assert.deepEqual(listRefsCli(tgt), { back: [], forward: [] });
});

// --- default-target-repo derivation from the --state path (sub-repo, not MAIN) ---

test('CLI refs add: default target repo derives from the --state path — a sub-repo bundle driven from a PARENT cwd links within the SUB-repo, not MAIN', () => {
  const parent = mkRepo('mp-refs-subderive-');
  const sub = path.join(parent, 'sub');
  fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
  const runx = mkBundle(sub, 'runx');
  const runy = mkBundle(sub, 'runy');
  // Run with cwd = PARENT (the session MAIN); --state points into the SUB-repo. No --repo → the default
  // target repo must be the sub-repo (derived from the state path), so runy resolves inside the sub-repo.
  const r = run(['refs', 'add', `--state=${runx}`, '--direction=forward', '--target=runy', ...ident()], { cwd: parent });
  assert.equal(r.status, 0, r.stderr);
  // same-repo (sub) → no repo field; the reciprocal landed in the SUB-repo's runy bundle.
  assert.deepEqual(listRefsCli(runx).forward, [{ slug: 'runy' }]);
  assert.deepEqual(listRefsCli(runy).back, [{ slug: 'runx', label: 'runx topic' }]);
  // MAIN (parent) was never targeted — no bundle materialized under the parent.
  assert.equal(fs.existsSync(path.join(parent, 'docs', 'masterplan', 'runy')), false);
});

// --- --repo realpath canonicalization + non-repo rejection ---

test('CLI refs add: --repo through a symlink alias is canonicalized to the real repo root; a non-repo --repo exits non-zero', () => {
  const repoA = mkRepo('mp-refs-canonA-');
  const repoB = mkRepo('mp-refs-canonB-');
  const a = mkBundle(repoA, 'src');
  mkBundle(repoB, 'tgt');
  // A symlink alias pointing at repoB — the stored ref must record the REALPATH (repoB), not the alias.
  const alias = path.join(fs.realpathSync(os.tmpdir()), `mp-refs-alias-${process.pid}-${Date.now()}`);
  fs.symlinkSync(repoB, alias);
  const r = run(['refs', 'add', `--state=${a}`, '--direction=forward', '--target=tgt', `--repo=${alias}`, ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listRefsCli(a).forward, [{ slug: 'tgt', repo: repoB }], 'symlink alias normalized to realpath');
  fs.unlinkSync(alias);
  // A --repo that exists but is NOT a git repo root exits non-zero (strict add-side canonicalization).
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-refs-plain-'));
  const bad = run(['refs', 'add', `--state=${a}`, '--direction=back', '--target=tgt', `--repo=${plain}`, ...ident()]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /is not a git repo root/);
});

// --- target-slug validation + malicious stored slug inertness ---

test('CLI refs add/remove: an unsafe --target (../x, a/b, absolute) exits non-zero on BOTH verbs', () => {
  const repo = mkRepo('mp-refs-badslug-');
  const src = mkBundle(repo, 'src');
  for (const bad of ['../x', 'a/b', '/abs/path']) {
    const add = run(['refs', 'add', `--state=${src}`, '--direction=forward', `--target=${bad}`, ...ident()]);
    assert.notEqual(add.status, 0, `add ${bad} must exit non-zero`);
    assert.match(add.stderr, /target slug/);
    const rm = run(['refs', 'remove', `--state=${src}`, '--direction=forward', `--target=${bad}`, ...ident()]);
    assert.notEqual(rm.status, 0, `remove ${bad} must exit non-zero`);
    assert.match(rm.stderr, /target slug/);
  }
});

test('CLI refs list/status: a malicious STORED slug renders inert — it is echoed verbatim, never turned into a path, and never crashes', () => {
  const repo = mkRepo('mp-refs-inert-');
  const src = mkBundle(repo, 'src', { refs: { back: [{ slug: '../../etc/evil', repo: '/x' }], forward: [] } });
  // list echoes the stored entry verbatim (no path is built from it) and does not crash.
  assert.deepEqual(listRefsCli(src), { back: [{ slug: '../../etc/evil', repo: '/x' }], forward: [] });
  // status also renders the refs block without building a path or crashing.
  const s = run(['status', `--state=${src}`]);
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(JSON.parse(s.stdout).refs.back, [{ slug: '../../etc/evil', repo: '/x' }]);
  // No stray path was ever materialized from the malicious slug.
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'masterplan', '..')), true); // the real ancestor only
  assert.equal(fs.existsSync(path.join(repo, 'etc', 'evil')), false);
});

// --- G2: `mp status` PRINTS the refs block (proven by OUTPUT, not node --check) ---

test('G2: `mp status` on a refs-carrying bundle PRINTS the refs block — back AND forward entries appear in the emitted output', () => {
  const repo = mkRepo('mp-refs-status-');
  const src = mkBundle(repo, 'src');
  mkBundle(repo, 'fwd-tgt');
  mkBundle(repo, 'back-src');
  run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=fwd-tgt', ...ident()]);
  run(['refs', 'add', `--state=${src}`, '--direction=back', '--target=back-src', ...ident('sess-test', 'host-test', 1001)]);
  const s = run(['status', `--state=${src}`]);
  assert.equal(s.status, 0, s.stderr);
  // The raw emitted stdout must carry both directions (output-proven, not merely structurally present).
  assert.match(s.stdout, /fwd-tgt/, 'forward entry appears in the printed status output');
  assert.match(s.stdout, /back-src/, 'back entry appears in the printed status output');
  const parsed = JSON.parse(s.stdout);
  assert.deepEqual(parsed.refs.forward, [{ slug: 'fwd-tgt' }]);
  assert.deepEqual(parsed.refs.back, [{ slug: 'back-src' }]);
});

// --- render-freshness: add + resolved remove re-render BOTH bundles' plan.html ---

function seedPlanArtifacts(statePath, placeholder) {
  const dir = bundleDir(statePath);
  fs.writeFileSync(path.join(dir, 'plan.index.json'), PLAN_INDEX);
  fs.writeFileSync(path.join(dir, 'plan.html'), placeholder);
}

test('render-freshness: `refs add` re-renders BOTH bundles existing plan.html (content changes on each side)', () => {
  const repo = mkRepo('mp-refs-render-add-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  seedPlanArtifacts(src, 'STALE-PLACEHOLDER-SRC');
  seedPlanArtifacts(tgt, 'STALE-PLACEHOLDER-TGT');
  const r = run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  assert.equal(r.status, 0, r.stderr);
  const srcHtml = fs.readFileSync(path.join(bundleDir(src), 'plan.html'), 'utf8');
  const tgtHtml = fs.readFileSync(path.join(bundleDir(tgt), 'plan.html'), 'utf8');
  assert.ok(srcHtml.startsWith('<!DOCTYPE html>'), 'source plan.html was re-rendered (placeholder replaced)');
  assert.ok(tgtHtml.startsWith('<!DOCTYPE html>'), 'target plan.html was re-rendered (placeholder replaced)');
  assert.ok(!srcHtml.includes('STALE-PLACEHOLDER-SRC'));
  assert.ok(!tgtHtml.includes('STALE-PLACEHOLDER-TGT'));
  // the freshly-added refs are reflected in the rendered header (content, not just mtime, changed).
  assert.match(srcHtml, /tgt/);
  assert.match(tgtHtml, /src/);
});

test('render-freshness: a resolved `refs remove` re-renders BOTH bundles existing plan.html', () => {
  const repo = mkRepo('mp-refs-render-rm-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  seedPlanArtifacts(src, 'x');
  seedPlanArtifacts(tgt, 'x');
  run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  // Re-stale BOTH plan.html so the remove-driven re-render is detectable.
  fs.writeFileSync(path.join(bundleDir(src), 'plan.html'), 'STALE-BEFORE-REMOVE-SRC');
  fs.writeFileSync(path.join(bundleDir(tgt), 'plan.html'), 'STALE-BEFORE-REMOVE-TGT');
  const r = run(['refs', 'remove', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident('sess-test', 'host-test', 1001)]);
  assert.equal(r.status, 0, r.stderr);
  const srcHtml = fs.readFileSync(path.join(bundleDir(src), 'plan.html'), 'utf8');
  const tgtHtml = fs.readFileSync(path.join(bundleDir(tgt), 'plan.html'), 'utf8');
  assert.ok(srcHtml.startsWith('<!DOCTYPE html>'), 'source plan.html re-rendered on remove');
  assert.ok(tgtHtml.startsWith('<!DOCTYPE html>'), 'target plan.html re-rendered on remove');
  assert.ok(!srcHtml.includes('STALE-BEFORE-REMOVE-SRC'));
  assert.ok(!tgtHtml.includes('STALE-BEFORE-REMOVE-TGT'));
});

test('render-freshness: a FORCED render failure after a refs mutation leaves the mutation DURABLE, WARNs naming each stale bundle, and exits non-zero', () => {
  const repo = mkRepo('mp-refs-render-fail-');
  const src = mkBundle(repo, 'src');
  const tgt = mkBundle(repo, 'tgt');
  run(['refs', 'add', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident()]);
  // Corrupt BOTH plan.index.json while keeping plan.html present → the inline re-render throws on each side.
  fs.writeFileSync(path.join(bundleDir(src), 'plan.html'), 'placeholder');
  fs.writeFileSync(path.join(bundleDir(tgt), 'plan.html'), 'placeholder');
  fs.writeFileSync(path.join(bundleDir(src), 'plan.index.json'), 'not-json{');
  fs.writeFileSync(path.join(bundleDir(tgt), 'plan.index.json'), 'not-json{');
  const r = run(['refs', 'remove', `--state=${src}`, '--direction=forward', '--target=tgt', ...ident('sess-test', 'host-test', 1001)]);
  assert.notEqual(r.status, 0, 'a post-commit render failure exits non-zero');
  // the mutation still committed (durable) despite the render failure.
  assert.deepEqual(listRefsCli(src), { back: [], forward: [] }, 'mutation stands durable');
  assert.deepEqual(listRefsCli(tgt), { back: [], forward: [] });
  // each stale bundle is named in a WARN on stderr.
  assert.match(r.stderr, /plan\.html is now STALE/);
  assert.ok(r.stderr.includes(bundleDir(src)), 'WARN names the source bundle');
  assert.ok(r.stderr.includes(bundleDir(tgt)), 'WARN names the target bundle');
});

// --- concurrency: two refs ops on the same pair serialize via the held locks ---

test('concurrency: two concurrent `refs add`s to the SAME source serialize via the held locks — no corruption; every landed ref maps to a winner', async () => {
  const repo = mkRepo('mp-refs-conc-');
  const src = mkBundle(repo, 'src');
  mkBundle(repo, 't1');
  mkBundle(repo, 't2');
  const spawnAdd = (target, session) => new Promise((resolve) => {
    execFile('node', [BIN, 'refs', 'add', `--state=${src}`, '--direction=forward', `--target=${target}`,
      `--session=${session}`, '--host=host-test', '--now=1000'], { encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ target, status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
  const results = await Promise.all([spawnAdd('t1', 'sess-a'), spawnAdd('t2', 'sess-b')]);
  // The source state.yml is never corrupted — status parses cleanly.
  const s = run(['status', `--state=${src}`]);
  assert.equal(s.status, 0, `source must parse cleanly after concurrent writers: ${s.stderr}`);
  // A blocked loser (different live session) must have been REFUSED by the lock (never a partial write),
  // and every ref that landed corresponds to a winner (exit 0). Losers name the owner.
  const winners = results.filter((r) => r.status === 0).map((r) => r.target).sort();
  const losers = results.filter((r) => r.status !== 0);
  assert.ok(winners.length >= 1, 'at least one concurrent add wins');
  for (const l of losers) assert.match(l.stderr, /is owned by .* — nothing written/, 'a loser was refused by the lock, not corrupted');
  const landed = listRefsCli(src).forward.map((e) => e.slug).sort();
  assert.deepEqual(landed, winners, 'exactly the winning targets are present (no torn/duplicate writes)');
});

