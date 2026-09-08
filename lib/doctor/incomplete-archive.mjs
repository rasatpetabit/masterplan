import fs from 'node:fs';
import path from 'node:path';
import { readState, completionClass } from '../bundle.mjs';

const ID = 'incomplete-archive';

export function check(repoRoot, opts = {}) {
  const base = path.join(repoRoot, 'docs', 'masterplan');
  const findings = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [{ id: ID, severity: 'PASS', summary: 'no incomplete or merged archives', fix: null }];
    }
    return [{ id: ID, severity: 'WARN', summary: `cannot read ${base}: ${err.message}`, fix: null }];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const statePath = path.join(base, slug, 'state.yml');
    let state;
    try {
      state = readState(statePath);
    } catch (err) {
      findings.push({ id: ID, severity: 'WARN', summary: `unreadable state file ${statePath}`, fix: null });
      continue;
    }
    if (state.status !== 'archived') continue;
    const cls = completionClass(state);
    if (cls === 'merged' || cls.startsWith('incomplete:')) {
      findings.push({ id: ID, severity: 'PASS', summary: `${slug}: archived as ${cls}`, fix: null });
    }
  }
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no incomplete or merged archives', fix: null }];
  }
  return findings;
}
