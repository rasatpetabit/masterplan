// lib/doctor/required-successor.mjs — doctor check: every required_successor event must be
// matched by a bundle whose slug equals the required slug AND whose seed record names the
// obligation source via predecessor. Absent linked successor → WARN with seed command;
// linked non-archived → PASS; archived complete → PASS; archived incomplete:*, merged, or
// legacy → ERROR.
import fs from 'node:fs';
import path from 'node:path';
import { completionClass } from '../bundle.mjs';
import { getBundles } from './_bundles.mjs';

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

export function check(repoRoot, opts = {}) {
  const bundles = getBundles(repoRoot, opts);
  if (!bundles.exists) {
    if (bundles.dirError) {
      return [{
        id: ID, severity: 'WARN',
        summary: `cannot read ${bundles.runsDir}: ${bundles.dirError.message}`,
        fix: null,
      }];
    }
    return [{ id: ID, severity: 'PASS', summary: 'no required-successor obligations', fix: null }];
  }

  const findings = [];
  const eventsCache = new Map();
  const getEvents = (dir) => {
    if (!eventsCache.has(dir)) eventsCache.set(dir, readEvents(dir));
    return eventsCache.get(dir);
  };
  const seedNamesPredecessor = (cand, slug, sourceSlug) => {
    if (cand.state && cand.state.predecessor === sourceSlug) return true;
    for (const ev of getEvents(cand.dir)) {
      if (
        ev.type === 'bundle_created' &&
        ev.slug === slug &&
        ev.predecessor === sourceSlug
      ) {
        return true;
      }
    }
    return false;
  };

  let foundObligation = false;

  for (const b of bundles.list) {
    const events = getEvents(b.dir);
    for (const ev of events) {
      if (ev.type !== 'required_successor' || !ev.slug) continue;
      foundObligation = true;
      const requiredSlug = ev.slug;
      const source = b.slug;
      const reason = ev.reason ?? null;

      const cand = bundles.bySlug[requiredSlug] || null;
      const linked = cand && seedNamesPredecessor(cand, requiredSlug, source) ? cand : null;

      if (!linked) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `${requiredSlug}: required successor of ${source} not found`,
          fix: `node bin/masterplan.mjs seed --slug=${shellQuote(requiredSlug)} --predecessor=${shellQuote(source)}`,
        });
        continue;
      }

      if (linked.stateError || !linked.state) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `${requiredSlug}: required successor of ${source} has an unreadable state.yml`,
          fix: null,
        });
        continue;
      }
      const state = linked.state;

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
