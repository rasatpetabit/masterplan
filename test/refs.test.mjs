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

