#!/usr/bin/env node
// bin/doctor.mjs — thin dispatcher over lib/doctor/*.mjs (build step 5).
//
// Discovers each check module, runs it against the target bundle dir, and prints
// { id, severity, summary, fix } lines. No check logic lives here — it only
// orchestrates and aggregates. Replaces the 2,116-line bash-in-markdown
// parts/doctor.md with ~12 testable modules.
// TODO(step 5): discover + run lib/doctor/*.mjs, aggregate, exit non-zero on ERROR.
async function main() {
  console.error('masterplan doctor: not yet implemented (build step 5)');
  process.exitCode = 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
