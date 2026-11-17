// test/declared-scope.test.mjs — path overlap for same-wave disjointness, and the
// same canonical coverage for launch, watch, verification, and partial-wave staging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationsOverlap, pathWithinDeclaredScope } from '../lib/declared-scope.mjs';
import { verifyScope } from '../lib/wave.mjs';

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

// file, scope, expected. Scope is one declaration; pathWithinDeclaredScope takes a list.
const coverage = [
  ['src/f', 'src/f', true],
  ['a/./b', 'a/b', true],
  ['a/b', 'a/./b', true],
  ['a/b', 'a//b', true],
  ['a//b', 'a/b', true],
  ['src\\x', 'src/x', true],
  ['src/x', 'src\\x', true],
  ['/a/./b', '/a/b', true],
  ['src/f', 'src/', true],
  ['src/a/b', 'src/', true],
  ['src//f', 'src/', true],
  ['src/f', 'src//', true],
  ['src/f', 'src\\', true],
  ['src\\f', 'src\\', true],
  ['src/f', 'src\\/', true],
  ['sibling/src/f', 'sibling\\src\\', true],
  ['src/f', 'src', false],
  ['src', 'src/', false],
  ['src', 'src\\', false],
  ['src', 'src//', false],
  ['src/', 'src', false],
  ['srcx/f', 'src/', false],
  ['srcx/f', 'src\\', false],
  ['srcx/f', 'src//', false],
  ['src/foobar', 'src/foo', false],
  ['src/foo', 'src/foobar', false],
  ['src\\foo', 'src\\foobar', false],
  ['lib/a', 'src/', false],
  ['lib/a', 'src\\', false],
  ['f', '.', true],
  ['src/a', '.', true],
  ['./f', '.', true],
  ['f', './', true],
  ['src/a', './', true],
  ['f', 'a/..', true],
  ['f', 'a/../', true],
  ['a/../f', 'a/../', true],
  ['a/../f', 'a/..', true],
  ['src/a', '.\\', true],
  ['src/a', '././', true],
  ['foo/../bar', '.', true],
  ['../x', '.', false],
  ['..', '.', false],
  ['./..', '.', false],
  ['./..', './', false],
  ['./../x', './', false],
  ['../x', './', false],
  ['..', './', false],
  ['../x', 'a/../', false],
  ['..', 'a/..', false],
  // A file path with interior '..' is judged by its canonical form.
  ['a/b/../c', 'a/b/', false],
  ['a/b/../b/c', 'a/b/', true],
  ['/a/b/../c', '/a/b/', false],
  ['/a/b/../b/c', '/a/b/', true],
  ['foo/../../x', '.', false],
  ['foo/../../x', './', false],
  ['/f', '.', false],
  ['/f', './', false],
  ['/abs', '.', false],
  ['f', '/', false],
  ['/src/f', 'src/', false],
  ['src/f', '/src/', false],
  ['/src/f', '/src/', true],
  ['', 'f', false],
  ['f', '', false],
  ['', '.', false],
  ['.', '', false],
  ['', '', true],
  // A non-string scope entry covers nothing and does not throw.
  ['f', null, false],
];

test('pathWithinDeclaredScope: coverage table', () => {
  for (const [file, scope, expected] of coverage) {
    assert.equal(
      pathWithinDeclaredScope(file, [scope]),
      expected,
      `${JSON.stringify(file)} in ${JSON.stringify(scope)}`,
    );
  }
});

test('pathWithinDeclaredScope: canonical spelling covers a child', () => {
  assert.equal(pathWithinDeclaredScope('src/f', ['src\\']), true);
  assert.equal(pathWithinDeclaredScope('src\\x', ['src\\']), true);
  assert.equal(pathWithinDeclaredScope('src/f', ['src//']), true);
  assert.equal(pathWithinDeclaredScope('a/b', ['a/./b']), true);
  assert.equal(pathWithinDeclaredScope('a/./b', ['a/b']), true);
  assert.equal(pathWithinDeclaredScope('srcx/f', ['src\\']), false);
  assert.equal(pathWithinDeclaredScope('srcx/f', ['src//']), false);
});

test('pathWithinDeclaredScope: relative root covers a relative child', () => {
  assert.equal(pathWithinDeclaredScope('f', ['.']), true);
  assert.equal(pathWithinDeclaredScope('src/a', ['./']), true);
  assert.equal(pathWithinDeclaredScope('f', ['a/..']), true);
  assert.equal(pathWithinDeclaredScope('a/../f', ['a/../']), true);
  assert.equal(pathWithinDeclaredScope('../x', ['.']), false);
  assert.equal(pathWithinDeclaredScope('..', ['./']), false);
  assert.equal(pathWithinDeclaredScope('./..', ['./']), false);
  assert.equal(pathWithinDeclaredScope('./../x', ['.']), false);
  assert.equal(pathWithinDeclaredScope('/f', ['.']), false);
  assert.equal(pathWithinDeclaredScope('/f', ['./']), false);
});

test('pathWithinDeclaredScope: directory does not cover its bare path', () => {
  assert.equal(pathWithinDeclaredScope('src', ['src/']), false);
  assert.equal(pathWithinDeclaredScope('src', ['src\\']), false);
  assert.equal(pathWithinDeclaredScope('src', ['src//']), false);
  assert.equal(pathWithinDeclaredScope('src/f', ['src/']), true);
});

test('pathWithinDeclaredScope: empty and non-strings are not directories', () => {
  assert.equal(pathWithinDeclaredScope('f', ['']), false);
  assert.equal(pathWithinDeclaredScope('', ['f']), false);
  assert.equal(pathWithinDeclaredScope('', ['']), true);
  assert.equal(pathWithinDeclaredScope('f', [null]), false);
  assert.equal(pathWithinDeclaredScope(null, ['src/']), false);
  assert.equal(pathWithinDeclaredScope(null, [null]), true);
  assert.equal(pathWithinDeclaredScope('f', [1]), false);
});

test('pathWithinDeclaredScope: coverage implies declarationsOverlap', () => {
  const vocabulary = [
    '', '.', './', '.\\', '..', '../x', 'f', 'src', 'src/', 'src\\', 'src//', 'src\\x',
    'src/f', 'src/x', 'srcx/f', 'a/..', 'a/../', 'a/../f', 'a/./b', 'a/b', 'a//b',
    '/f', '/src/', '/src/f', 'src/foo', 'src/foobar', 'sibling/src/f', 'sibling\\src\\',
    'foo/../../x', 'foo/../bar', './f', 'src\\/', 'lib/a', 'src/',
  ];
  const pairs = [];
  const seen = new Set();
  const add = (file, scope) => {
    const key = `${JSON.stringify(file)}\0${JSON.stringify(scope)}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([file, scope]);
  };
  for (const [file, scope] of coverage) add(file, scope);
  for (const file of vocabulary) {
    for (const scope of vocabulary) add(file, scope);
  }
  const segs = ['a', 'b', '.', '..', 'src'];
  for (const left of segs) {
    for (const right of segs) {
      add(`${left}/${right}`, `${left}/${right}`);
      add(`${left}/${right}`, `${left}/`);
      add(`${left}\\${right}`, `${left}\\`);
      add(`${left}//${right}`, `${left}//`);
      add(`${left}/./${right}`, `${left}/${right}`);
      add(`/${left}/${right}`, `${left}/`);
      add(`/${left}/${right}`, `/${left}/`);
    }
  }
  for (const [file, scope] of pairs) {
    if (!pathWithinDeclaredScope(file, [scope])) continue;
    assert.equal(
      declarationsOverlap(file, scope),
      true,
      `covered but no overlap: ${JSON.stringify(file)} in ${JSON.stringify(scope)}`,
    );
  }
});

test('verifyScope: a dot or backslash directory accepts an edit inside it and refuses one outside', () => {
  const dot = verifyScope(['.'], [], ['src/inside.js', '../outside.js']);
  assert.equal(dot.ok, false);
  assert.deepEqual(dot.outOfScope, ['../outside.js']);
  const slash = verifyScope(['src\\'], [], ['src/inside.js', 'lib/outside.js']);
  assert.equal(slash.ok, false);
  assert.deepEqual(slash.outOfScope, ['lib/outside.js']);
  const held = verifyScope(['.'], ['../outside.js'], ['../outside.js', 'src/inside.js']);
  assert.equal(held.ok, true);
  assert.deepEqual(held.outOfScope, []);
});
