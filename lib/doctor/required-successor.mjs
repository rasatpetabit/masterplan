// lib/doctor/required-successor.mjs — doctor check: every required_successor event must be
// matched by a bundle whose slug equals the required slug AND whose seed record names the
// obligation source via predecessor. Absent linked successor → WARN with seed command;
// linked non-archived → PASS; archived complete → PASS; archived incomplete:*, merged, or
// legacy → ERROR.
import fs from 'node:fs';
import path from 'node:path';
import { readState, completionClass } from '../bundle.mjs';

const ID = 'required-successor';

function shellQuote(s) {
  if (/^[A-Za-z0-9_\/.,:=+@-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function readEvents(bundleDir) {
  try {
    const text = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        // skip malformed line
      }
    }
    return events;
  } catch {
    return [];
  }
}

function seedNamesPredecessor(bundleDir, slug, sourceSlug) {
  try {
    const state = readState(path.join(bundleDir, 'state.yml'));
    if (state && state.predecessor === sourceSlug) return true;
  } catch {
    // fall through to events
  }
  for (const ev of readEvents(bundleDir)) {
    if (
      ev.type === 'bundle_created' &&
      ev.slug === slug &&
      ev.predecessor === sourceSlug
    ) {
      return true;
    }
  }
  return false;
}

export function check(repoRoot, opts = {}) {
  const findings = [];
  const baseDir = path.join(repoRoot, 'docs', 'masterplan');

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [{ id: ID, severity: 'PASS', summary: 'no required-successor obligations', fix: null }];
    }
    return [{
      id: ID, severity: 'WARN',
      summary: `cannot read ${baseDir}: ${err.message}`,
      fix: null,
    }];
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const bundles = dirs.map((d) => ({ slug: d.name, dir: path.join(baseDir, d.name) }));
  let foundObligation = false;

  for (const b of bundles) {
    const events = readEvents(b.dir);
    for (const ev of events) {
      if (ev.type !== 'required_successor' || !ev.slug) continue;
      foundObligation = true;
      const requiredSlug = ev.slug;
      const source = b.slug;
      const reason = ev.reason ?? null;

      let linked = null;
      for (const cand of bundles) {
        if (cand.slug === requiredSlug && seedNamesPredecessor(cand.dir, requiredSlug, source)) {
          linked = cand;
          break;
        }
      }

      if (!linked) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `${requiredSlug}: required successor of ${source} not found`,
          fix: `node bin/masterplan.mjs seed --slug=${shellQuote(requiredSlug)} --predecessor=${shellQuote(source)}`,
        });
        continue;
      }

      let state;
      try {
        state = readState(path.join(linked.dir, 'state.yml'));
      } catch {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `${requiredSlug}: required successor of ${source} has an unreadable state.yml`,
          fix: null,
        });
        continue;
      }

      if (state.status !== 'archived') {
        findings.push({
          id: ID, severity: 'PASS',
          summary: `${requiredSlug}: required successor of ${source} in progress`,
          fix: null,
        });
        continue;
      }

      const cls = completionClass(state);
      if (cls === 'complete') {
        findings.push({
          id: ID, severity: 'PASS',
          summary: `${requiredSlug}: required successor of ${source} complete`,
          fix: null,
        });
      } else if (cls === 'merged' || cls === 'legacy' || (typeof cls === 'string' && cls.startsWith('incomplete:'))) {
        findings.push({
          id: ID, severity: 'ERROR',
          summary: `${requiredSlug}: required successor of ${source} archived as ${cls} without completing`,
          fix: null,
        });
      } else {
        findings.push({
          id: ID, severity: 'ERROR',
          summary: `${requiredSlug}: required successor of ${source} archived as ${cls} without completing`,
          fix: null,
        });
      }
    }
  }

  if (!foundObligation) {
    findings.push({ id: ID, severity: 'PASS', summary: 'no required-successor obligations', fix: null });
  }

  return findings;
}
