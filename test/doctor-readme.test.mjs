// test/doctor-readme.test.mjs — E9 guard: the lib/doctor/README.md module-inventory table
// must exactly match the auto-discovered doctor modules on the filesystem.
//
// The dispatcher (bin/doctor.mjs) globs lib/doctor/*.mjs — there is no registry, so the README
// is the only human index of what runs. Without this test a new module that ships without a
// README row (or a deleted module that leaves a stale row) silently drifts: the README claims a
// check surface that no longer matches reality. This test makes that a hard failure.
//
// It reads the ids through discoverChecks() — the SAME function the dispatcher uses — rather
// than re-globbing, so the comparison is against what actually runs, not a second implementation
// of the discovery glob that could itself drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverChecks } from '../bin/doctor.mjs';

const DOCTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'doctor');
const README_PATH = path.join(DOCTOR_DIR, 'README.md');

/** Extract the module inventory ids from the README table: each row starts with a backticked id. */
function readmeModuleIds() {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const inTable = readme.split('## Module inventory')[1];
  assert.ok(inTable, 'README must have a "## Module inventory" section');
  // Match backticked ids on table rows only (rows start with '| `'). This deliberately does not
  // match inline code mentions elsewhere.
  const rows = inTable.split('\n').filter((l) => l.trim().startsWith('| `'));
  const ids = rows.map((l) => {
    const m = l.match(/^\|\s*`([a-z0-9-]+)`/);
    assert.ok(m, `README inventory row missing a backticked module id: ${l}`);
    return m[1];
  });
  return ids;
}

test('E9: README module-inventory ids exactly match the auto-discovered doctor modules', async () => {
  const readmeIds = readmeModuleIds();
  const discovered = await discoverChecks(DOCTOR_DIR);
  const fsIds = discovered.map((c) => c.name).sort();

  assert.deepEqual(
    [...readmeIds].sort(),
    fsIds,
    `README inventory must match filesystem modules.\n` +
      `  in README but not on disk: ${readmeIds.filter((i) => !fsIds.includes(i)).join(', ') || '(none)'}\n` +
      `  on disk but not in README: ${fsIds.filter((i) => !readmeIds.includes(i)).join(', ') || '(none)'}`,
  );
});

test('E9: README inventory is non-empty and complete (all modules carry a row)', async () => {
  const readmeIds = readmeModuleIds();
  const discovered = await discoverChecks(DOCTOR_DIR);
  assert.ok(readmeIds.length >= 10, `inventory should list the full module set, got ${readmeIds.length}`);
  assert.equal(readmeIds.length, discovered.length, 'README row count must equal discovered module count');
});
