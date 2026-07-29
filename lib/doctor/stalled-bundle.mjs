// lib/doctor/stalled-bundle.mjs — detect a bundle that was seeded, did real work, and
// never recorded any of it (the CD-7 durability contract).
//
// The gap this closes: `dangling-run` covers a run that STARTED a wave and crashed
// (a stranded active_run marker). Nothing covered a bundle that never started one —
// seeded, then driven through an entire brainstorm/plan session whose decisions,
// findings and blockers were left in conversation instead of events.jsonl. Such a
// bundle produced ZERO doctor findings, so the failure was structurally invisible.
//
// Why this matters concretely: on resume, `mp continue` reads phase/tasks/active_run.
// A bundle at phase=brainstorm with tasks:[] and no events is indistinguishable from
// one seeded thirty seconds ago, so the controller offers "continue / restart / stop"
// and every unrecorded decision is gone. events.jsonl IS the persistence surface;
// an unwritten one is data loss waiting for the next compaction.
//
// Signal choice — deliberately the cheap, robust one: `spec.md` exists but
// events.jsonl does not (or holds no parseable event). A spec is proof that real
// design work happened; zero events is proof none of it was recorded. This needs no
// git inspection and no mtime comparison (mtimes are reset by fresh checkouts, which
// would make a timestamp-based check flap in CI and on any clone).
//
// NOT version-scoped, on purpose. `spec-assumptions` grandfathers bundles below
// CURRENT_SCHEMA_VERSION and was thereby dead for 100% of real bundles. CD-7 is a
// universal invariant, not a v9 feature, so this check applies to every readable
// bundle regardless of schema_version.

import fs from 'node:fs';
import path from 'node:path';
import { parseState } from '../bundle.mjs';

const ID = 'stalled-bundle';

// Phases where a spec is expected to exist but tasks/waves have not begun. Past
// `execute`, wave machinery writes events on its own, and a missing events.jsonl
// there is a different (louder) problem that record-result surfaces directly.
const PRE_EXECUTE_PHASES = new Set(['brainstorm', 'plan']);

function hasRecordedEvent(eventsPath) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return false; // missing file — nothing was ever recorded
  }
  // Tolerate a trailing newline / blank lines; require at least one parseable object.
  return raw
    .split('\n')
    .some((line) => {
      const t = line.trim();
      if (!t) return false;
      try {
        return typeof JSON.parse(t) === 'object';
      } catch {
        return false;
      }
    });
}

export function check(repoRoot, _opts = {}) {
  const root = path.join(repoRoot, 'docs', 'masterplan');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no docs/masterplan directory', fix: null }];
  }

  const findings = [];
  let inspected = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const dir = path.join(root, slug);

    let state;
    try {
      state = parseState(fs.readFileSync(path.join(dir, 'state.yml'), 'utf8'));
    } catch {
      continue; // unreadable/missing state.yml — state-schema owns that signal
    }

    if (state.status === 'archived') continue; // frozen historical run
    if (!PRE_EXECUTE_PHASES.has(state.phase)) continue;

    // A spec is the evidence that design work actually happened here.
    if (!fs.existsSync(path.join(dir, 'spec.md'))) continue;

    inspected += 1;
    if (!hasRecordedEvent(path.join(dir, 'events.jsonl'))) {
      findings.push({
        id: ID,
        severity: 'WARN',
        summary: `bundle ${slug}: phase=${state.phase} with a spec.md but no recorded events — session work is not in events.jsonl (CD-7)`,
        fix: `record the run's decisions, findings and blockers: \`mp event --state=${path.join(dir, 'state.yml')} --type=<decision|finding|blocker|progress> --note="..."\``,
      });
    }
  }

  if (findings.length > 0) return findings;
  if (inspected === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no pre-execute bundle with a spec.md to check', fix: null }];
  }
  return [{
    id: ID,
    severity: 'PASS',
    summary: `all ${inspected} pre-execute bundle(s) with a spec.md have recorded events`,
    fix: null,
  }];
}
