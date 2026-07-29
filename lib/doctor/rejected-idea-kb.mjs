// lib/doctor/rejected-idea-kb.mjs — validate durable rejected-idea KB files.
//
// Convention: docs/conventions/out-of-scope.md
//   .out-of-scope/<concept-slug>.md at the target repo root, with required
//   sections "## Why this is out of scope" and "## Prior requests".
//
// This is NOT D6 path-scope (verify-scope / wave-commit outOfScope paths) and
// NOT the run-bundle spec.md "Out of Scope" section. See the convention doc
// name-disambiguation table.
//
// Semantics:
//   - no .out-of-scope/ directory          → SKIP
//   - empty directory / only non-md        → SKIP
//   - each *.md has both required headings → PASS (one aggregate finding)
//   - any *.md missing a required heading  → WARN per file
import fs from 'node:fs';
import path from 'node:path';

const ID = 'rejected-idea-kb';
const WHY_RE = /^##\s+Why this is out of scope\s*$/mi;
const PRIOR_RE = /^##\s+Prior requests\s*$/mi;

export function check(repoRoot, opts = {}) {
  const root = opts.repoRoot ?? repoRoot;
  const dir = path.join(root, '.out-of-scope');

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return [{
        id: ID,
        severity: 'SKIP',
        summary: 'no .out-of-scope/ directory (rejected-idea KB unused)',
        fix: null,
      }];
    }
    return [{
      id: ID,
      severity: 'WARN',
      summary: `cannot read .out-of-scope/: ${err.message}`,
      fix: 'fix permissions or recreate .out-of-scope/ per docs/conventions/out-of-scope.md',
    }];
  }

  const mdFiles = entries
    .filter((d) => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

  if (mdFiles.length === 0) {
    return [{
      id: ID,
      severity: 'SKIP',
      summary: '.out-of-scope/ exists but has no concept .md files',
      fix: null,
    }];
  }

  const findings = [];
  for (const name of mdFiles) {
    const fp = path.join(dir, name);
    let body;
    try {
      body = fs.readFileSync(fp, 'utf8');
    } catch (err) {
      findings.push({
        id: ID,
        severity: 'WARN',
        summary: `.out-of-scope/${name}: unreadable (${err.message})`,
        fix: 'fix or remove the file',
      });
      continue;
    }
    const missing = [];
    if (!WHY_RE.test(body)) missing.push('## Why this is out of scope');
    if (!PRIOR_RE.test(body)) missing.push('## Prior requests');
    if (missing.length) {
      findings.push({
        id: ID,
        severity: 'WARN',
        summary: `.out-of-scope/${name}: missing required section(s): ${missing.join(', ')}`,
        fix: 'add the missing section(s) per docs/conventions/out-of-scope.md (see docs/conventions/out-of-scope.template.md)',
      });
    }
  }

  if (findings.length > 0) return findings;
  return [{
    id: ID,
    severity: 'PASS',
    summary: `all ${mdFiles.length} .out-of-scope/*.md file(s) carry required sections`,
    fix: null,
  }];
}
