// lib/hygiene.mjs — pure, exported release-hygiene + publish-safety detectors (build step 6).
//
// HOME: lib/ ROOT, deliberately NOT lib/doctor/. bin/doctor.mjs auto-discovers ONLY lib/doctor/*.mjs
// (readdirSync → import → call check()), so nothing here ever becomes a runtime doctor module —
// which is correct per lib/doctor/README.md:63-66: "Release-hygiene checks (cross-manifest version
// sync, router-size/prose, namespace collision) move to CI / pre-commit, since end users don't have
// the repo." These detectors are driven by test/publish-hygiene.test.mjs under ng-ci
// (`node --test test/*.test.mjs`); a future pre-commit hook / rebuilt release-gate imports the SAME
// functions. Zero deps, synchronous, and PURE — callers read files and pass text in, so every rule
// is unit-testable against planted inputs with no filesystem coupling.
//
// The three release-hygiene concerns named above map to:
//   1. fixture-identifier leak  -> scanForRealIdentifiers()   (the headline publish-safety guard)
//   2. cross-manifest version   -> readReleaseVersion() + findVersionDrift()
//   3. namespace collision      -> parseReservedVerbs() + findNamespaceCollisions()
// "router-size/prose" is intentionally NOT ported: it was a v7 heuristic with no v8 contract (the
// orchestrator prompt has no enforced size budget in the clean-core rebuild). Documented in WORKLOG.

// ---------------------------------------------------------------------------
// 1. Fixture-identifier scan — CUTOVER publish-safety guard.
//
// test/fixtures/ holds bundles FROZEN from real runs (the migrate/doctor compat surface). They were
// sanitized at the Phase-3 cutover; this guard keeps them that way: it FAILS the build if a real
// identifier (dev host path, owner org, product code, codename) reappears in fixture *content*.
//
// Scope is fixture file CONTENTS, not paths: the leak risk lives in the VERBATIM-frozen bundle text,
// while fixture directory names are deliberately structured (`pass-`/`warn-` scenario prefixes, the
// legitimate `rasatpetabit-masterplan` marketplace dir). The caller (the test) walks test/fixtures/
// and passes each file's text here.
//
// Allowed (never flagged): `rasatpetabit` / `rasatpetabit-masterplan` (the real marketplace id — the
// `\b` before `petabit` cannot fire inside `rasatpetabit`, so no allowlist clause is even needed);
// `/home/user/` (the synthetic home convention); `masterplan`; and bare 64-hex digests (e.g. the
// index-staleness sha256(plan.md) content hash) — we never match raw hex, only named tokens.
//
// NOT covered (documented coverage boundary, no silent cap): slugified path leaks like
// `srv-home-<name>` are not heuristically detected — a `-home-<word>-` rule false-positives on
// legitimate feature slugs (`home-page`, `home-screen`). Absolute `/srv/` and `/home/<name>/` cover
// the content-form path-leak vector instead.
const DENY_RULES = [
  // Absolute dev-host paths.
  { token: 'srv-path', re: /\/srv\//g },
  // A real home directory. The synthetic convention is exactly `/home/user/`; anything else leaks a
  // developer login name.
  { token: 'home-path', re: /\/home\/([A-Za-z0-9._-]+)\//g, allow: (m) => m[1] === 'user' },
  // The owner org. `\b` is a no-op inside `rasatpetabit` (t→p is not a word boundary), so the
  // legitimate `rasatpetabit-masterplan` is never matched; `petabitscale`, `petabit-portal`, etc. are.
  { token: 'petabit-org', re: /\bpetabit[A-Za-z0-9-]*/g },
  // Codenames / product codes from the source population (canonical deny set).
  { token: 'coherent-codename', re: /\bcoherent\b/gi },
  { token: 'ftcd-code', re: /\bFTCD\b/g },
  { token: 'xcvr-code', re: /\bXCVR-/g },
  { token: 'wbn-codename', re: /\bwbn\b/g },
];

// Scan text for real-identifier leaks. Returns [] when clean, else one hit per match:
//   { token, match, index }  — token names the violated rule, match is the offending substring.
// PURE: module-level regexes are safe to reuse because String.prototype.matchAll clones the regex
// internally (it does not advance the original's lastIndex).
export function scanForRealIdentifiers(text = '') {
  const s = String(text);
  const hits = [];
  for (const rule of DENY_RULES) {
    for (const m of s.matchAll(rule.re)) {
      if (rule.allow && rule.allow(m)) continue;
      hits.push({ token: rule.token, match: m[0], index: m.index });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 2. Cross-manifest version sync.
//
// README.md is the single source of truth for the release version (CI's release-gate seeds the
// gitignored plugin manifests from it). Every tracked manifest version field must agree. package.json
// is EXCLUDED by the caller — it carries the private dev marker (`8.0.0-ng.0`) until parity cutover.

// `Current release: **vX.Y.Z**` on README.md line 5.
const README_VERSION_RE = /Current release:\s*\*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/;

export function readReleaseVersion(readmeText = '') {
  const m = String(readmeText).match(README_VERSION_RE);
  return m ? m[1] : null;
}

// Given the release version and manifest entries [{ file, field, version }], return the entries that
// DISAGREE. Empty array = all in sync. PURE (the caller parses the JSON and supplies entries).
export function findVersionDrift(releaseVersion, manifestVersions = []) {
  return manifestVersions.filter((mv) => mv.version !== releaseVersion);
}

// ---------------------------------------------------------------------------
// 3. Namespace collision — no skill dir shadows a reserved built-in slash command.
//
// Two complementary checks, both grounded in the orchestrator's verb contract:
//   - 'shadows-builtin': a skill dir named in FORBIDDEN_SKILL_NAMES hijacks a Claude Code built-in.
//     Seeded from the v7.2.2 regression — `skills/plan/` shadowed CC's `/plan` (plan mode). `plan`
//     stays a reserved masterplan VERB (reachable as `/masterplan plan`) but must NOT be a top-level
//     skill dir. Extend this set if another built-in proves harmful to shadow.
//   - 'unwired-verb': a skill dir whose name is neither a reserved verb nor an allowed infra dir —
//     i.e. a stray/typo skill not wired into the verb router.

// Built-ins masterplan must never expose as a top-level skill dir.
export const FORBIDDEN_SKILL_NAMES = ['plan'];
// Skill dirs that are infrastructure, not verbs: the orchestrator skill + the legacy detector.
export const INFRA_SKILL_NAMES = ['masterplan', 'masterplan-detect'];

// Parse the reserved-verb list from the orchestrator prompt (commands/masterplan.md), so the verb
// set is single-sourced from the prompt rather than re-declared here. Matches the body line
// "Reserved verbs: `full, brainstorm, …, verbs`." (the backtick span may wrap across a newline).
export function parseReservedVerbs(commandText = '') {
  const m = String(commandText).match(/Reserved verbs:\s*`([^`]+)`/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

// Return namespace problems for the given skill dir names. [] = clean.
export function findNamespaceCollisions(skillDirNames = [], reservedVerbs = [], opts = {}) {
  const forbidden = opts.forbidden ?? FORBIDDEN_SKILL_NAMES;
  const infra = opts.infra ?? INFRA_SKILL_NAMES;
  const verbs = new Set(reservedVerbs);
  const problems = [];
  for (const name of skillDirNames) {
    if (forbidden.includes(name)) problems.push({ name, kind: 'shadows-builtin' });
    else if (!verbs.has(name) && !infra.includes(name)) problems.push({ name, kind: 'unwired-verb' });
  }
  return problems;
}
