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
import { getBundles } from './_bundles.mjs';

const ID = 'plan-doc-cruft';
const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);
const ROOT_HISTORY = /^(WORKLOG\.md|CHANGELOG[^/]*\.md|HISTORY\.md)$/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-token match: the slug bounded by non-alphanumerics (hyphens count as boundaries, so
// "<slug>-design.md" matches — plan-named files routinely carry suffixes).
const tokenRe = (slug) => new RegExp(`(?<![A-Za-z0-9])${esc(slug)}(?![A-Za-z0-9])`);
const combinedTokenRe = (slugs) =>
  new RegExp(`(?<![A-Za-z0-9])(?:${slugs.map(esc).join('|')})(?![A-Za-z0-9])`);

export function check(repoRoot, opts = {}) {
  const bundles = getBundles(repoRoot, opts);
  if (!bundles.exists) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles directory', fix: null }];
  }
  const runsRel = path.relative(repoRoot, bundles.runsDir).replace(/\\/g, '/');

  const archived = [];
  for (const { slug, state } of bundles.list) {
    if (state?.status === 'archived') archived.push(slug);
  }
  if (archived.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no archived run bundles to anchor on', fix: null }];
  }

  // Sort longest-first in combined regexes so shorter prefix slugs cannot mask longer matches;
  // individual anchor checks run on hit to preserve exact overlapping-slug finding semantics.
  const sortedByLen = [...archived].sort((a, b) => b.length - a.length);
  const anySlugRe = combinedTokenRe(sortedByLen);
  const hyphenatedSlugs = sortedByLen.filter((s) => s.includes('-'));
  const anyHyphenatedRe = hyphenatedSlugs.length > 0 ? combinedTokenRe(hyphenatedSlugs) : null;
  const bundlePrefix = `${runsRel}/`;

  const anchors = archived.map((slug) => ({
    slug,
    re: tokenRe(slug),
    bundlePath: `${bundlePrefix}${slug}`,
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
    const hits = new Map(); // slug -> Set of signal labels
    const hit = (slug, label) => {
      if (!hits.has(slug)) hits.set(slug, new Set());
      hits.get(slug).add(label);
    };

    if (anySlugRe.test(name)) {
      for (const a of anchors) {
        if (a.re.test(name)) hit(a.slug, 'filename');
      }
    }

    let body = '';
    try {
      const fullPath = path.join(repoRoot, relFile);
      const st = fs.statSync(fullPath);
      if (st.size <= MAX_BYTES) body = fs.readFileSync(fullPath, 'utf8');
    } catch {
      body = '';
    }

    if (body) {
      if (body.includes(bundlePrefix)) {
        for (const a of anchors) {
          if (body.includes(a.bundlePath)) hit(a.slug, 'bundle-path reference');
        }
      }
      if (anyHyphenatedRe && anyHyphenatedRe.test(body)) {
        const headings = body.match(/^#{1,6}\s[^\n]*/gm);
        if (headings && anyHyphenatedRe.test(headings.join('\n'))) {
          for (const a of anchors) {
            if (!a.hyphenated) continue;
            for (const line of headings) {
              if (a.re.test(line)) { hit(a.slug, 'heading'); break; }
            }
          }
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
