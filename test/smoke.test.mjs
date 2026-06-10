// test/smoke.test.mjs — scaffold smoke test (build step 0).
//
// Proves the node:test harness runs green and that every lib stub is valid,
// importable ESM. Real per-module unit tests arrive in build step 1 (TDD).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const stubs = [
  '../lib/paths.mjs',
  '../lib/bundle.mjs',
  '../lib/resume.mjs',
  '../lib/dispatch/index.mjs',
  '../lib/dispatch/routing.mjs',
  '../lib/dispatch/backend.mjs',
  '../lib/dispatch/host.mjs',
  '../lib/dispatch/ops.mjs',
  '../lib/migrate.mjs',
];

for (const rel of stubs) {
  test(`stub module is valid ESM: ${rel}`, async () => {
    const mod = await import(new URL(rel, import.meta.url));
    assert.ok(mod, `${rel} should import without throwing`);
  });
}
