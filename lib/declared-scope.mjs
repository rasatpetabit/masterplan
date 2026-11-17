import path from 'node:path';

// Declared scopes are exact paths, or directory prefixes ending in '/'.
// Keep launch, watch, verification, and partial-wave staging on the same rule.
export function pathWithinDeclaredScope(file, scopes = []) {
  return scopes.some((scope) => file === scope || (scope.endsWith('/') && file.startsWith(scope)));
}

// Two declarations overlap when, after lexical POSIX normalization, they are the
// same path, or one is a directory (ends in '/') and the other is that path or
// lies under it. A directory and the same path without the trailing slash overlap.
// A prefix that is not on a '/' boundary does not (`src/foo` vs `src/foobar`,
// `src/` vs `srcx/f`).
//
// Normalization collapses '.' and duplicate '/', keeps the trailing '/' that
// marks a directory, and collapses '..' only lexically. It does not touch the
// filesystem, does not resolve a relative '..' against the process cwd, and does
// not climb above '/' on an absolute path. Relative and absolute spellings of one
// path are not equated: this function has no repository root.
export function declarationsOverlap(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return a === b;
  const na = path.posix.normalize(a);
  const nb = path.posix.normalize(b);
  if (na === nb) return true;
  return directoryCovers(na, nb) || directoryCovers(nb, na);
}

// `dir` must already be normalized. The trailing '/' is the boundary: coverage is
// startsWith(dir), never startsWith of the slash-stripped path.
function directoryCovers(dir, other) {
  if (!dir.endsWith('/')) return false;
  if (other.startsWith(dir)) return true;
  const bare = dir.slice(0, -1);
  return bare.length > 0 && other === bare;
}
