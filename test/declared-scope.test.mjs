// test/declared-scope.test.mjs — path-overlap rule for same-wave disjointness.
// pathWithinDeclaredScope's launch/watch/verification behaviour is intentionally not
// re-specified here; these tests cover declarationsOverlap only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationsOverlap } from '../lib/declared-scope.mjs';

test('declarationsOverlap: equal declarations overlap', () => {
  assert.equal(declarationsOverlap('src/f', 'src/f'), true);
  assert.equal(declarationsOverlap('src/', 'src/'), true);
});

test('declarationsOverlap: a directory overlaps a child', () => {
  assert.equal(declarationsOverlap('src/', 'src/f'), true);
  assert.equal(declarationsOverlap('src/f', 'src/'), true);
});

test('declarationsOverlap: a directory overlaps a nested grandchild', () => {
  assert.equal(declarationsOverlap('src/', 'src/a/b'), true);
  assert.equal(declarationsOverlap('src/a/b', 'src/'), true);
});

test('declarationsOverlap: a directory overlaps the same path without a trailing slash', () => {
  assert.equal(declarationsOverlap('src/', 'src'), true);
  assert.equal(declarationsOverlap('src', 'src/'), true);
});

test('declarationsOverlap: dot segments normalize to the same path', () => {
  assert.equal(declarationsOverlap('a/./b', 'a/b'), true);
  assert.equal(declarationsOverlap('a/b', 'a/./b'), true);
});

test('declarationsOverlap: duplicate slashes normalize to the same path', () => {
  assert.equal(declarationsOverlap('a//b', 'a/b'), true);
  assert.equal(declarationsOverlap('a/b', 'a//b'), true);
});

test('declarationsOverlap: a non-slash boundary is not an overlap either way', () => {
  assert.equal(declarationsOverlap('src/foo', 'src/foobar'), false);
  assert.equal(declarationsOverlap('src/foobar', 'src/foo'), false);
  assert.equal(declarationsOverlap('src/', 'srcx/f'), false);
  assert.equal(declarationsOverlap('srcx/f', 'src/'), false);
});

test('declarationsOverlap: two disjoint directories do not overlap', () => {
  assert.equal(declarationsOverlap('src/', 'lib/'), false);
  assert.equal(declarationsOverlap('lib/', 'src/'), false);
});

test('declarationsOverlap: .. inside a declaration is lexical and does not need the filesystem', () => {
  // Neither path exists. realpath or cwd resolution would throw or disagree with 'a/c'.
  assert.equal(declarationsOverlap('a/b/../c', 'a/c'), true);
  assert.equal(declarationsOverlap('does-not-exist/../keep', 'keep'), true);
  assert.equal(declarationsOverlap('/no/such/dir/../x', '/no/such/x'), true);
  // '..' that would climb above '/' stays at the root lexically, still with no filesystem.
  assert.equal(declarationsOverlap('/a/../../b', '/b'), true);
  // A relative '..' that cannot collapse inside the declaration is kept, not resolved via cwd.
  assert.equal(declarationsOverlap('a/../../b', '../b'), true);
  assert.equal(declarationsOverlap('../b', 'b'), false);
});

test('declarationsOverlap: a directory that normalizes to the current directory overlaps its child', () => {
  assert.equal(declarationsOverlap('a/../', 'a/../f'), true);
  assert.equal(declarationsOverlap('a/../f', 'a/../'), true);
});

test('declarationsOverlap: ./ overlaps a relative child', () => {
  assert.equal(declarationsOverlap('./', 'f'), true);
  assert.equal(declarationsOverlap('f', './'), true);
});

test('declarationsOverlap: ./ does not overlap a path that climbs out', () => {
  assert.equal(declarationsOverlap('./', '../x'), false);
  assert.equal(declarationsOverlap('../x', './'), false);
});

test('declarationsOverlap: a bare dot is the current directory', () => {
  assert.equal(declarationsOverlap('.', 'f'), true);
  assert.equal(declarationsOverlap('src/a', '.'), true);
  assert.equal(declarationsOverlap('.', '../x'), false);
  assert.equal(declarationsOverlap('../x', '.'), false);
});

test('declarationsOverlap: a backslash is a separator and a trailing directory marker', () => {
  assert.equal(declarationsOverlap('src\\', 'src\\f'), true);
  assert.equal(declarationsOverlap('src\\f', 'src\\'), true);
  assert.equal(declarationsOverlap('sibling\\src\\', 'sibling/src/f'), true);
  assert.equal(declarationsOverlap('sibling/src/f', 'sibling\\src\\'), true);
  assert.equal(declarationsOverlap('a\\b', 'a/b'), true);
  assert.equal(declarationsOverlap('a/b', 'a\\b'), true);
  assert.equal(declarationsOverlap('src\\foo', 'src\\foobar'), false);
  assert.equal(declarationsOverlap('src\\foobar', 'src\\foo'), false);
});

test('declarationsOverlap: absolute and relative declarations do not cover each other', () => {
  assert.equal(declarationsOverlap('./', '/f'), false);
  assert.equal(declarationsOverlap('/f', './'), false);
  assert.equal(declarationsOverlap('.', '/abs'), false);
  assert.equal(declarationsOverlap('/', 'f'), false);
  assert.equal(declarationsOverlap('f', '/'), false);
  assert.equal(declarationsOverlap('src/', '/src/f'), false);
  assert.equal(declarationsOverlap('/src/', 'src/f'), false);
});

test('declarationsOverlap: an empty declaration is not the relative root', () => {
  assert.equal(declarationsOverlap('', 'f'), false);
  assert.equal(declarationsOverlap('f', ''), false);
  assert.equal(declarationsOverlap('', ''), true);
});
