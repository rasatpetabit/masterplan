// test/prompt-d4-regressions.test.mjs — D4 structural guard: the prompt dispatches agents by
// their BARE Pi-registered names, never the CC-only colon form, and no longer teaches the
// deleted probe/liveness vocabulary. Re-created after D6 scope revert (wave 3, task 23's
// protection test; re-applied as acknowledged scope expansion per the run's precedent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');

test('D4: no CC-only colon agent names in planner dispatches', () => {
  // Pi registration is bare-only; the colon form is deleted as drift at registration time.
  assert.ok(!/masterplan:mp-[a-z-]+/.test(prompt), 'prompt must not dispatch masterplan:mp-* colon names');
});

test('D4: bare mp-planner name present where the planner is dispatched', () => {
  assert.ok(/`?mp-planner`?/.test(prompt), 'prompt should dispatch the bare mp-planner name');
});

test('D4/C5: no deleted probe/liveness vocabulary remains', () => {
  // The probe (alive/reap) machinery was removed (C5); the prompt named a nonexistent
  // 'liveness-check' op and taught --alive/--dead probe flags.
  assert.ok(!/liveness-check/.test(prompt), 'prompt must not name the nonexistent liveness-check op');
  assert.ok(!/--alive\b/.test(prompt), 'prompt must not teach the deleted --alive probe flag');
  assert.ok(!/--dead\b/.test(prompt), 'prompt must not teach the deleted --dead probe flag');
});

test('D4: probe op itself is not re-taught as a dispatch step', () => {
  // Allow historical/audit mentions only outside imperative dispatch lines: no "`mp probe`"
  // invocation or op-table row teaching probe as a live step.
  assert.ok(!/`mp probe`/.test(prompt), 'prompt must not teach an `mp probe` invocation');
});
