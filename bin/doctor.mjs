#!/usr/bin/env node
// bin/doctor.mjs — thin dispatcher over lib/doctor/*.mjs (build step 5, the L4 layer).
//
// Each lib/doctor/<name>.mjs exports a SYNCHRONOUS `check(repoRoot, opts) -> Finding[]`,
// where a Finding is { id, severity: 'PASS'|'WARN'|'ERROR'|'SKIP', summary, fix }. A module
// OWNS ITS SCOPE: plan-scoped checks glob `<repoRoot>/docs/masterplan/*` internally and emit
// one finding per problem (a single PASS when clean, SKIP when nothing applies); user-scoped
// checks ignore repoRoot and read host paths via opts (homeDir / now / gitExec), which keeps
// them unit-testable without touching the real host. This dispatcher only DISCOVERS, RUNS
// (crash-isolated), aggregates, prints, and exits non-zero iff any finding is ERROR. No check
// logic lives here. Replaces v7's 2,116-line parts/doctor.md (53 prose checks; deleted at the cutover) with 13
// testable modules; the ~38 self-instrumentation checks are deleted, release-hygiene -> CI.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEV_RANK = { SKIP: 0, PASS: 1, WARN: 2, ERROR: 3 };

// Import every lib/doctor/*.mjs that exports a check(); README.md and non-modules are skipped.
export async function discoverChecks(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const checks = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    if (typeof mod.check === 'function') {
      checks.push({ name: f.replace(/\.mjs$/, ''), check: mod.check });
    }
  }
  return checks;
}

// Run every check, crash-isolated: a module that throws becomes ONE ERROR finding so a single
// buggy check can never abort the whole doctor run (a doctor that dies on its own bug is worse
// than useless). Returns flattened findings + the exit code (1 iff any ERROR).
export function runChecks(checks, repoRoot, opts = {}) {
  const findings = [];
  for (const { name, check } of checks) {
    try {
      const out = check(repoRoot, opts);
      const arr = Array.isArray(out) ? out : [out];
      for (const f of arr) findings.push(normalizeFinding(name, f));
    } catch (e) {
      findings.push({
        id: name,
        severity: 'ERROR',
        summary: `check threw: ${String(e?.message ?? e)}`,
        fix: 'this is a doctor bug — report it; the check could not run',
      });
    }
  }
  const exitCode = findings.some((f) => f.severity === 'ERROR') ? 1 : 0;
  return { findings, exitCode };
}

// A finding with an unknown/absent severity is forced to ERROR (fail loud — a malformed
// finding must never read as clean), and id defaults to the module name.
function normalizeFinding(name, f) {
  const sev = SEV_RANK[f?.severity] === undefined ? 'ERROR' : f.severity;
  return {
    id: f?.id ?? name,
    severity: sev,
    summary: f?.summary ?? '(no summary)',
    fix: f?.fix ?? null,
  };
}

export function formatFinding(f) {
  const head = `${f.severity.padEnd(5)} ${f.id}: ${f.summary}`;
  return f.fix && (f.severity === 'WARN' || f.severity === 'ERROR')
    ? `${head}\n      fix: ${f.fix}`
    : head;
}

async function main() {
  const repoRoot = process.argv[2] || process.cwd();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const checksDir = path.join(here, '..', 'lib', 'doctor');
  const checks = await discoverChecks(checksDir);
  const { findings, exitCode } = runChecks(checks, repoRoot, {
    homeDir: process.env.HOME,
    now: Date.now(),
  });
  for (const f of findings) console.log(formatFinding(f));
  const errs = findings.filter((f) => f.severity === 'ERROR').length;
  const warns = findings.filter((f) => f.severity === 'WARN').length;
  console.log(`\nmasterplan doctor: ${findings.length} finding(s) — ${errs} error, ${warns} warn.`);
  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
