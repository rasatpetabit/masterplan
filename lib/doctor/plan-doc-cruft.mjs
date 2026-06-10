// lib/doctor/plan-doc-cruft.mjs — repo-wide leftover plan-organized doc detection.
//
// The finish flow's docs_normalize gate (§2c) offers to fold a run's plan-organized docs into
// the repo's category-organized documentation at finish time — but only for THAT run's touched
// files. This check is the repo-wide backstop: it surfaces markdown OUTSIDE the run bundles
// that still carries provenance of an ARCHIVED run (plan-slug-named files, references into the
// archived bundle's docs/masterplan/<slug>/ path, plan-slug headings), so old cruft from runs
// finished before the gate existed — or runs where the user chose "keep as-is" — eventually
// surfaces and goes away.
//
// Anchored to ARCHIVED bundles only: an active/paused run's docs are work-in-progress and the
// finish gate's job, not cruft. SKIP when there are no archived bundles to anchor on. Signals
// are deliberately low-FP:
//   (a) a file NAME containing an archived slug as a whole token;
//   (b) a file BODY referencing the archived bundle path (<runsRel>/<slug>);
//   (c) a HEADING line containing the slug as a whole word — hyphenated slugs only (short
//       single-word slugs false-positive too easily on prose).
// Exclusions: the runs dir itself (the bundle IS the archived audit record — never cruft),
// docs/superpowers/ (legacy-bundle owns that signal), node_modules, every dot-directory
// (.git/.worktrees/.claude plan+worktree artifacts, legacy/.archive — hidden dirs are not the
// repo's documentation), root history files (WORKLOG/CHANGELOG*/HISTORY legitimately mention
// slugs), files >1 MiB.
// Always WARN, never ERROR — stale docs are advisory, not integrity failures.
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

const ID = 'plan-doc-cruft';
const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);
const ROOT_HISTORY = /^(WORKLOG\.md|CHANGELOG[^/]*\.md|HISTORY\.md)$/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-token match: the slug bounded by non-alphanumerics (hyphens count as boundaries, so
// "<slug>-design.md" matches — plan-named files routinely carry suffixes).
const tokenRe = (slug) => new RegExp(`(?<![A-Za-z0-9])${esc(slug)}(?![A-Za-z0-9])`);

export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, {});
  const runsRel = path.relative(repoRoot, runsDir).replace(/\\/g, '/');

  let slugs = [];
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles directory', fix: null }];
  }

  const archived = [];
  for (const slug of slugs) {
    try {
      const state = parseState(fs.readFileSync(bundleArtifacts(repoRoot, slug, {}).state, 'utf8'));
      if (state?.status === 'archived') archived.push(slug);
    } catch {
      /* unreadable bundle — not an anchor; state-schema reports it */
    }
  }
  if (archived.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no archived run bundles to anchor on', fix: null }];
  }

  const anchors = archived.map((slug) => ({
    slug,
    re: tokenRe(slug),
    bundlePath: `${runsRel}/${slug}`,
    hyphenated: slug.includes('-'),
  }));

  // Recursive *.md walk from repoRoot, honoring the exclusion list above.
  const mdFiles = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (childRel === runsRel || childRel === 'docs/superpowers') continue;
        walk(path.join(dir, e.name), childRel);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (!rel && ROOT_HISTORY.test(e.name)) continue;
        mdFiles.push(childRel);
      }
    }
  };
  walk(repoRoot, '');

  const findings = [];
  for (const relFile of mdFiles) {
    const name = path.basename(relFile);
    let body = null; // lazy-read: filename signal needs no I/O
    const hits = new Map(); // slug -> Set of signal labels
    const hit = (slug, label) => {
      if (!hits.has(slug)) hits.set(slug, new Set());
      hits.get(slug).add(label);
    };
    for (const a of anchors) {
      if (a.re.test(name)) hit(a.slug, 'filename');
      if (body === null) {
        try {
          const st = fs.statSync(path.join(repoRoot, relFile));
          body = st.size > MAX_BYTES ? '' : fs.readFileSync(path.join(repoRoot, relFile), 'utf8');
        } catch { body = ''; }
      }
      if (body.includes(a.bundlePath)) hit(a.slug, 'bundle-path reference');
      if (a.hyphenated) {
        for (const line of body.split('\n')) {
          if (/^#{1,6}\s/.test(line) && a.re.test(line)) { hit(a.slug, 'heading'); break; }
        }
      }
    }
    if (hits.size > 0) {
      const detail = [...hits.entries()]
        .map(([slug, sigs]) => `${slug} (${[...sigs].join(', ')})`)
        .join('; ');
      findings.push({
        id: ID, severity: 'WARN',
        summary: `${relFile}: plan-organized doc cruft from archived run(s) — ${detail}`,
        fix: 'fold the content into the repo\'s category-organized docs, strip plan provenance (slugs, wave/task numbers, "implemented by plan X" phrasing), and delete files that empty out; future runs get this offered automatically at finish (the §2c docs_normalize gate)',
      });
    }
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: `no plan-organized doc cruft from ${archived.length} archived run(s)`, fix: null }];
  }
  return findings;
}
