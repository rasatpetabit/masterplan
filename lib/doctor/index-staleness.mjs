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

    // Check state.plan_hash independently. This is a LEGACY-COMPAT read: born-v8 bundles never
    // carry state.plan_hash (no `mp` verb writes it; v8 stamps plan_hash into plan.index.json only),
    // so this branch is dormant on a v8 bundle (WL:84's dormant-gap finding stands). A stale
    // state.plan_hash can therefore only surface on a migrated-in-place 5.x bundle, whose canonical
    // remedy is `mp migrate-bundle` — migrate whitelist-rebuilds state.yml and DROPS plan_hash
    // (verified empirically). The prior fix-text named a "plan-index command", but the only such
    // command (build-index) writes plan.index.json, not state.yml, so it never cleared this WARN —
    // the same non-completing fix-text defect class fixed for set-worktree-disposition/set-codex-config.
    let anyRecorded = false;
    try {
      const state = parseState(fs.readFileSync(artifacts.state, 'utf8'));
      const recorded = normaliseHash(state.plan_hash);
      if (recorded) {
        anyRecorded = true;
        if (recorded !== currentHash) {
          findings.push({
            id: ID, severity: 'WARN',
            summary: `bundle ${slug}: plan.md changed since indexing (plan_hash stale) — re-run plan/index`,
            fix: `run 'mp migrate-bundle --state=${artifacts.state}' to drop the stale legacy plan_hash from state.yml (v8 stamps plan_hash in plan.index.json only)`,
          });
        }
      }
    } catch {
      // no state.yml or parse failed — fall through to plan.index.json
    }

    // Check plan.index.json independently (not a fallback — both sources are checked when present).
    try {
      const idx = JSON.parse(fs.readFileSync(artifacts.planIndex, 'utf8'));
      const recorded = normaliseHash(idx.plan_hash);
      if (recorded) {
        anyRecorded = true;
        if (recorded !== currentHash) {
          findings.push({
            id: ID, severity: 'WARN',
            summary: `bundle ${slug}: plan.md changed since indexing (plan_hash stale) — re-run plan/index`,
            fix: 're-index the plan with the plan-index command to refresh plan_hash in plan.index.json',
          });
        }
      }
    } catch {
      // no plan.index.json — not an error
    }

    // If neither source recorded a hash, nothing to check for this bundle.
    void anyRecorded;
  }

  if (!anyPlan) {
    return [{ id: ID, severity: 'SKIP', summary: 'no bundle has a plan.md', fix: null }];
  }
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'all plan hashes match (no staleness detected)', fix: null }];
  }
  return findings;
}
