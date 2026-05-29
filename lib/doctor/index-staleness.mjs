// lib/doctor/index-staleness.mjs — v8 doctor check (ports v7 #34, plan.index.json staleness).
//
// External surface: <repoRoot>/docs/masterplan/*/plan.md + state.yml (plan_hash) +
// plan.index.json (plan_hash field).
// Plan-scoped: for each bundle that has a plan.md, computes sha256 of the file content and
// compares against any recorded hash. Recorded hash sources (in priority order):
//   1. state.plan_hash — a bare hex digest or "sha256:<hex>" prefixed string.
//   2. plan.index.json .plan_hash field — same format.
// Hash mismatch on either source → WARN. A bundle with plan.md but no recorded hash → no
// finding (not this check's problem — the bundle may never have been indexed). SKIP when no
// bundle has a plan.md. PASS when all hashes match.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

const ID = 'index-staleness';

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Normalise a stored hash: strip leading "sha256:" prefix if present.
function normaliseHash(h) {
  if (typeof h !== 'string') return null;
  const s = h.trim();
  return s.startsWith('sha256:') ? s.slice(7) : s || null;
}

export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, {});
  let slugs;
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }
  if (slugs.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }

  let anyPlan = false;
  const findings = [];

  for (const slug of slugs) {
    const artifacts = bundleArtifacts(repoRoot, slug, {});
    if (!fs.existsSync(artifacts.plan)) continue;
    anyPlan = true;

    let currentHash;
    try {
      currentHash = sha256File(artifacts.plan);
    } catch {
      continue; // can't read plan.md — skip
    }

    // Check state.plan_hash first.
    let checked = false;
    try {
      const state = parseState(fs.readFileSync(artifacts.state, 'utf8'));
      const recorded = normaliseHash(state.plan_hash);
      if (recorded) {
        checked = true;
        if (recorded !== currentHash) {
          findings.push({
            id: ID, severity: 'WARN',
            summary: `bundle ${slug}: plan.md changed since indexing (plan_hash stale) — re-run plan/index`,
            fix: 're-index the plan with the plan-index command to refresh plan_hash in state.yml',
          });
        }
      }
    } catch {
      // no state.yml or parse failed — fall through to plan.index.json
    }

    if (!checked) {
      // Fall back to plan.index.json.
      try {
        const idx = JSON.parse(fs.readFileSync(artifacts.planIndex, 'utf8'));
        const recorded = normaliseHash(idx.plan_hash);
        if (recorded) {
          if (recorded !== currentHash) {
            findings.push({
              id: ID, severity: 'WARN',
              summary: `bundle ${slug}: plan.md changed since indexing (plan_hash stale) — re-run plan/index`,
              fix: 're-index the plan with the plan-index command to refresh plan_hash in plan.index.json',
            });
          }
        }
      } catch {
        // no plan.index.json either — no recorded hash, skip
      }
    }
  }

  if (!anyPlan) {
    return [{ id: ID, severity: 'SKIP', summary: 'no bundle has a plan.md', fix: null }];
  }
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'all plan hashes match (no staleness detected)', fix: null }];
  }
  return findings;
}
