// lib/resume-brief.mjs — active-run brief resolution and rendering.
//
// - resolveResumeBrief({ repoRoot }) returns { active, obligations, warnings }.
// - renderResumeBrief(brief) renders open required_successor obligations first
//   (with the exact seed command), then the active-run section: zero active
//   bundles → nothing; exactly one → five durable lines (slug, phase, open
//   gate, goals.md outcome, next mp operation); several → one summary line each.
// - projectObligations({ repoRoot }) scans every bundle's events.jsonl for
//   required_successor events and reports each as open unless a bundle exists
//   whose slug matches AND whose seed record (bundle_created event or state
//   predecessor field) names the obligation source via predecessor.
//
// Read-only: never writes state.yml or events.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { discoverRuns } from './runs.mjs';
import { readState } from './bundle.mjs';
import { parseGoals } from './goals.mjs';

function shellQuote(s) {
  if (/^[A-Za-z0-9_\/.,:=+@-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const SEED_CMD = (slug, source) =>
  `node bin/masterplan.mjs seed --slug=${shellQuote(slug)} --predecessor=${shellQuote(source)}`;

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

function seedNamesPredecessor(run, sourceSlug) {
  try {
    const state = readState(run.statePath);
    if (state && state.predecessor === sourceSlug) return true;
  } catch {
    // fall through to events
  }
  for (const ev of readEvents(run.bundleDir)) {
    if (
      ev.type === 'bundle_created' &&
      ev.slug === run.slug &&
      ev.predecessor === sourceSlug
    ) {
      return true;
    }
  }
  return false;
}

export function projectObligations({ repoRoot }) {
  const { runs } = discoverRuns({ repoRoot });
  const bySlug = new Map(runs.map((r) => [r.slug, r]));
  const obligations = [];
  for (const r of runs) {
    for (const ev of readEvents(r.bundleDir)) {
      if (ev.type !== 'required_successor' || !ev.slug) continue;
      const target = bySlug.get(ev.slug);
      const discharged = target && seedNamesPredecessor(target, r.slug);
      if (!discharged) {
        obligations.push({
          slug: ev.slug,
          source: r.slug,
          reason: ev.reason ?? null,
        });
      }
    }
  }
  return obligations;
}

function openGate(state) {
  // pending_gate is the ONE durable approval marker: null, or {id, opened_at}.
  const g = state && state.pending_gate;
  return g && typeof g === 'object' && typeof g.id === 'string' ? g.id : null;
}

function openGateFromRun(run) {
  try {
    return openGate(readState(run.statePath));
  } catch {
    return null;
  }
}

function goalsOutcome(bundleDir) {
  try {
    const text = fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8');
    const parsed = parseGoals(text);
    return parsed.intent?.outcome ?? null;
  } catch {
    return null;
  }
}

function nextOp(run) {
  // The durable next operation for any active run is the resume controller (CD-7):
  // `mp continue` derives the next op from state.yml itself.
  return `node bin/masterplan.mjs continue --state=${shellQuote(run.statePath)}`;
}

export function resolveResumeBrief({ repoRoot }) {
  const { runs, warnings } = discoverRuns({ repoRoot });
  const active = [];
  for (const r of runs) {
    if (r.status === 'in-progress') {
      active.push(r);
    } else if (r.status == null) {
      warnings.push({
        level: 'WARN',
        scope: 'bundle',
        path: r.statePath,
        message: `missing status in state.yml for run ${r.slug}`,
      });
    }
  }
  const obligations = projectObligations({ repoRoot });
  return { active, obligations, warnings };
}

export function renderResumeBrief(brief) {
  const lines = [];
  for (const ob of brief.obligations) {
    lines.push(`obligation: ${ob.slug} (required by ${ob.source})`);
    lines.push(`  ${SEED_CMD(ob.slug, ob.source)}`);
  }
  if (brief.active.length === 1) {
    const r = brief.active[0];
    lines.push(`slug: ${r.slug}`);
    lines.push(`phase: ${r.phase ?? 'unknown'}`);
    lines.push(`gate: ${openGateFromRun(r) ?? 'none'}`);
    lines.push(`outcome: ${goalsOutcome(r.bundleDir) ?? 'none'}`);
    lines.push(`next: ${nextOp(r)}`);
  } else if (brief.active.length > 1) {
    for (const r of brief.active) {
      lines.push(`${r.slug}: ${r.phase ?? 'unknown'} (${r.status ?? 'unknown'})`);
    }
  }
  return lines.join('\n');
}
