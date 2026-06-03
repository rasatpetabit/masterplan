// lib/codex-companion.mjs — version-agnostic resolver for the codex-companion script.
//
// The codex plugin ships `scripts/codex-companion.mjs` inside its versioned cache dir
// (`<configDir>/plugins/cache/<marketplace>/codex/<version>/scripts/codex-companion.mjs`). The
// `<version>` segment moves with every plugin update, so the §2c finish-gate review must NOT
// hardcode it. The authoritative source for the *active* install is
// `<configDir>/plugins/installed_plugins.json`, whose `installPath` already encodes the live
// version as a real path segment — so we read that install record rather than scanning cache
// dirs by mtime or picking the highest version across them (both resolve a stale/inactive copy
// and break unit-test determinism).
//
// These two functions are PURE (object/string in, object/string out — no fs, no process): the
// file read + existence probe live in the `codex-companion-path` subcommand (bin is the sole
// fs/io boundary), mirroring how lib/finish.mjs stays pure behind `mp finish-status`.
import path from 'node:path';

// Select the active codex install record from a parsed installed_plugins.json object.
// Shape: { version, plugins: { "<name>@<marketplace>": [ {scope, installPath, version, ...} ] } }.
// Returns { key, installPath, version, scope } for the entry whose plugin name (the part before
// '@') is exactly 'codex' (case-insensitive) — stricter than the doctor's presence probe, which
// uses startsWith('codex'); here we want the literal codex plugin, not a 'codex-foo' sibling.
// Returns null when absent/malformed. Among multiple records (a multi-scope install) prefers
// scope 'user', else the first — deterministic, no fs.
export function selectCodexInstall(installedPlugins) {
  const plugins = installedPlugins?.plugins;
  if (!plugins || typeof plugins !== 'object') return null;
  let entryKey = null;
  for (const key of Object.keys(plugins)) {
    const name = String(key).split('@', 1)[0].toLowerCase();
    if (name === 'codex') { entryKey = key; break; }
  }
  if (!entryKey) return null;
  const recs = plugins[entryKey];
  if (!Array.isArray(recs) || recs.length === 0) return null;
  const pick = recs.find((r) => r && r.scope === 'user') ?? recs[0];
  if (!pick || typeof pick.installPath !== 'string' || pick.installPath === '') return null;
  return {
    key: entryKey,
    installPath: pick.installPath,
    version: typeof pick.version === 'string' && pick.version ? pick.version : null,
    scope: typeof pick.scope === 'string' && pick.scope ? pick.scope : null,
  };
}

// Derive the codex-companion script path from an install's installPath. Returns null for a
// missing/empty installPath. (Existence is the caller's concern — see the subcommand.)
export function companionScriptPath(installPath) {
  if (typeof installPath !== 'string' || installPath === '') return null;
  return path.join(installPath, 'scripts', 'codex-companion.mjs');
}

// Scan a bundle's events.jsonl text for a durable whole-branch codex-review record at a given HEAD.
//
// The §2c finish-gate writes a `codex_review` event (type:'codex_review', data:{sha,base,count},
// note:<digest>) AFTER the review runs but BEFORE `open-gate` — so a death anywhere after the review
// completes still leaves this durable marker. On resume, step-5's guard reads this back: a present
// record for the CURRENT HEAD means "already reviewed at this exact tree" → skip the (expensive,
// network-bound) re-run AND rehydrate the findings digest into the re-rendered gate AUQ. That closes
// both halves of the P2 finding: the re-run-on-death window AND digest-loss-on-compaction.
//
// PURE: events-text + sha in, plain object out (the file read lives in the `codex-review-status`
// subcommand — bin is the sole fs boundary). Matches ONLY success records (type === 'codex_review');
// a `codex_review_skipped` (degraded path) is deliberately ignored, so a prior skip never masks a real
// re-run opportunity. `present` keys on the record's EXISTENCE at this sha (NOT count > 0): a clean
// zero-findings review still counts as reviewed. Returns the LAST matching line (a re-review at the
// same sha wins). Malformed/blank lines are skipped.
export function selectCodexReviewForHead(eventsText, sha) {
  const absent = { present: false, digest: null, count: null, base: null };
  if (typeof eventsText !== 'string' || typeof sha !== 'string' || sha === '') return absent;
  let hit = null;
  for (const line of eventsText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || rec.type !== 'codex_review') continue;
    if (!rec.data || rec.data.sha !== sha) continue;
    hit = rec; // keep scanning — last match at this sha wins
  }
  if (!hit) return absent;
  return {
    present: true,
    digest: typeof hit.note === 'string' ? hit.note : null,
    count: hit.data && Number.isFinite(hit.data.count) ? hit.data.count : null,
    base: hit.data && typeof hit.data.base === 'string' ? hit.data.base : null,
  };
}
