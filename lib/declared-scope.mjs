import path from 'node:path';

// Launch, watch, verification, and partial-wave staging use the same canonical
// paths as declarationsOverlap. A scope covers a file when the canonical paths
// are equal, or the scope is a canonical directory and the file lies under it
// (absolute only with absolute, relative only with relative), or the scope is
// the relative root and the file is relative and does not climb out. A directory
// does not cover the same path without its trailing slash (`src/` does not cover
// `src`). Empty strings and non-strings are not canonicalized: normalize('') is
// '.', which would otherwise become the relative root. Exact equality, including
// empty and non-string identity, is unchanged.
export function pathWithinDeclaredScope(file, scopes = []) {
  return scopes.some((scope) => declarationCovers(scope, file));
}

function declarationCovers(scope, file) {
  if (file === scope) return true;
  if (typeof file !== 'string' || typeof scope !== 'string') return false;
  if (file.length === 0 || scope.length === 0) return false;
  const nf = canonicalDeclaration(file);
  const ns = canonicalDeclaration(scope);
  if (nf === ns) return true;
  if (ns === '') return relativeRootCovers(nf);
  if (!ns.endsWith('/')) return false;
  if (ns.startsWith('/') !== nf.startsWith('/')) return false;
  return nf.startsWith(ns);
}

// Two declarations overlap when, after canonicalization, they are the same path,
// or one is a directory and the other is that path or lies under it. A directory
// and the same path without the trailing slash overlap. A prefix that is not on a
// separator boundary does not (`src/foo` vs `src/foobar`, `src/` vs `srcx/f`).
//
// pathWithinDeclaredScope uses this same canonicalization. `\` is read as `/`
// before normalization, in the separators and in the trailing directory marker —
// the path format resolveFileLocus splits on and canonicalizeScopePaths treats as
// a directory.
// Lexical POSIX normalization then collapses `.` and duplicate `/`, keeps a trailing
// `/` that marks a directory, and collapses `..` only lexically. It does not touch
// the filesystem, does not resolve a relative `..` against the process cwd, and does
// not climb above `/` on an absolute path.
//
// A normalized relative path has no leading `./`. The current directory — a bare
// `.`, or a directory that normalizes to `./` — is the relative root (the empty
// canonical path). That directory covers every relative path that does not climb
// out (`..` or a `../` prefix). An absolute path is never covered by a relative
// declaration, and a relative path is never covered by an absolute one. Relative
// and absolute spellings of one path are not equated: this function has no
// repository root. An empty input is not the relative root.
export function declarationsOverlap(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return a === b;
  const na = canonicalDeclaration(a);
  const nb = canonicalDeclaration(b);
  if (na === nb) return true;
  return directoryCovers(na, nb) || directoryCovers(nb, na);
}

// Backslash to slash, then POSIX-normalize. Relative `.` and `./` become the
// empty relative root; any other leading `./` is stripped. Absolute paths are
// returned unchanged.
function canonicalDeclaration(decl) {
  const slashed = decl.replaceAll('\\', '/');
  const norm = path.posix.normalize(slashed);
  if (norm.startsWith('/')) return norm;
  if (norm === '.') return '';
  if (norm.startsWith('./')) return norm.slice(2);
  return norm;
}

// `dir` is already canonical. A trailing `/` is the boundary: coverage is
// startsWith(dir), never startsWith of the slash-stripped path. The empty
// string is the relative-root directory, not a prefix of every string.
function directoryCovers(dir, other) {
  if (dir === '') return relativeRootCovers(other);
  if (!dir.endsWith('/')) return false;
  if (dir.startsWith('/') !== other.startsWith('/')) return false;
  if (other.startsWith(dir)) return true;
  const bare = dir.slice(0, -1);
  return bare.length > 0 && other === bare;
}

function relativeRootCovers(other) {
  if (other.length === 0 || other.startsWith('/')) return false;
  if (other === '..' || other.startsWith('../')) return false;
  return true;
}
