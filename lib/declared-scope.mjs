// Declared scopes are exact paths, or directory prefixes ending in '/'.
// Keep launch, watch, verification, and partial-wave staging on the same rule.
export function pathWithinDeclaredScope(file, scopes = []) {
  return scopes.some((scope) => file === scope || (scope.endsWith('/') && file.startsWith(scope)));
}
