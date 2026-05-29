// lib/doctor/scalar-cap.mjs — v8 doctor check (ports v7 #32, scalar-cap integrity).
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml (+ sibling overflow-target files).
// Plan-scoped + pure over the filesystem (no host state, so opts is unused): every flat
// `key: value` line's value must be <= 200 chars, and any `*overflow at <file> L<n>*` pointer
// must resolve to a real file/line under the same bundle. Returns one WARN finding per
// violation, a single PASS when all bundles are clean, or SKIP when there are no bundles.
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';

const ID = 'scalar-cap';
const MAX = 200;
const KEY_RE = /^([A-Za-z_][\w-]*):\s?(.*)$/;
const OVERFLOW_RE = /\*overflow at ([^\s*]+) L(\d+)\*/;

export function check(repoRoot) {
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

  const findings = [];
  for (const slug of slugs) {
    const bundleDir = path.dirname(bundleArtifacts(repoRoot, slug, {}).state);
    const statePath = path.join(bundleDir, 'state.yml');
    let text;
    try {
      text = fs.readFileSync(statePath, 'utf8');
    } catch {
      continue; // a slug dir without state.yml is not this check's concern (legacy-bundle owns that)
    }
    for (const rawLine of text.split('\n')) {
      const m = rawLine.replace(/\r$/, '').match(KEY_RE);
      if (!m) continue;
      const [, key, value] = m;
      if (value.length > MAX) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: '${key}' value is ${value.length} chars (> ${MAX})`,
          fix: 'move the value to an overflow file and replace it with `*overflow at <file> L<n>*`',
        });
      }
      const ov = value.match(OVERFLOW_RE);
      if (ov) {
        const [, relFile, lineNoStr] = ov;
        const lineNo = Number(lineNoStr);
        const target = path.join(bundleDir, relFile);
        let ok = false;
        try {
          const count = fs.readFileSync(target, 'utf8').split('\n').length;
          ok = lineNo >= 1 && lineNo <= count;
        } catch {
          ok = false;
        }
        if (!ok) {
          findings.push({
            id: ID, severity: 'WARN',
            summary: `bundle ${slug}: '${key}' overflow pointer -> ${relFile} L${lineNo} does not resolve`,
            fix: 'fix the overflow pointer to an existing file and valid line number',
          });
        }
      }
    }
  }
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: `all bundle scalar values within ${MAX} chars; overflow pointers resolve`, fix: null }];
  }
  return findings;
}
