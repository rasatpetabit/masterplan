// lib/doctor/legacy-archive.mjs — doctor check: archived bundles that predate v10 have no
// completion class and are therefore not complete. Emit a PASS informational finding for each
// such bundle; never treat the absence as a schema error. Exclude active bundles and archived
// bundles that carry a real completion class (complete, merged, incomplete:*).
import fs from 'node:fs';
import path from 'node:path';
import { readState, completionClass } from '../bundle.mjs';

const ID = 'legacy-archive';

export function check(repoRoot, opts = {}) {
  const findings = [];
  const baseDir = path.join(repoRoot, 'docs', 'masterplan');

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No docs/masterplan directory — no bundles, so nothing to report.
      return [{ id: ID, severity: 'PASS', summary: 'no legacy archives', fix: null }];
    }
    return [{
      id: ID, severity: 'WARN',
      summary: `cannot read ${baseDir}: ${err.message}`,
      fix: null,
    }];
  }

  const dirs = entries.filter((e) => e.isDirectory());
  let foundLegacy = false;

  for (const dir of dirs) {
    const statePath = path.join(baseDir, dir.name, 'state.yml');
    let state;
    try {
      state = readState(statePath);
    } catch (err) {
      findings.push({
        id: ID, severity: 'WARN',
        summary: `unreadable state file ${statePath}: ${err.message}`,
        fix: null,
      });
      continue;
    }

    if (state && state.status === 'archived' && completionClass(state) === 'legacy') {
      foundLegacy = true;
      findings.push({
        id: ID, severity: 'PASS',
        summary: `${dir.name}: legacy archive (pre-v10, no completion class — not complete)`,
        fix: null,
      });
    }
  }

  if (!foundLegacy) {
    findings.push({ id: ID, severity: 'PASS', summary: 'no legacy archives', fix: null });
  }

  return findings;
}
