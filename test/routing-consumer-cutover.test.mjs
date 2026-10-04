import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as routing from '../lib/dispatch/routing-policy.mjs';

test('legacy routing authority is absent from the public surface and package', () => {
  for (const name of ['REPO_POLICY_PATH', 'resolveLane', 'resolvePanel',
    'laneAliasMap', 'adversaryFallbackReviewers'])
    assert.equal(Object.hasOwn(routing, name), false, name);
  for (const name of ['workflow-map.json', 'dispatch-map.json'])
    assert.equal(fs.existsSync(new URL(`../policy/${name}`, import.meta.url)), false, name);
});
