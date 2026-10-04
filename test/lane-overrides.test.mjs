// Retired host pins refuse before registration mutation; no model map is loaded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRegister } from '../bin/register-pi-agents.mjs';
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
for (const value of [{ frontier: 'synthetic-private-choice' }, [], null, '{ malformed']) {
  test(`registration refuses retired override shape ${JSON.stringify(value).length} before writes`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-overrides-')); roots.push(home);
    const agentsDir = path.join(home, 'source'); fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'mp-x.md'), '---\nname: mp-x\npreset: breaker\ntools: read\n---\nbody\n');
    const file = path.join(home, '.config/masterplan/lane-overrides.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = typeof value === 'string' ? value : JSON.stringify(value); fs.writeFileSync(file, bytes);
    const targetDir = path.join(home, 'target');
    assert.throws(() => runRegister({ agentsDir, targetDir, homeDir: home, check: false }), error =>
      /lane-overrides.*retired.*inference routing/.test(error.message) && !error.message.includes('synthetic-private-choice'));
    assert.equal(fs.existsSync(targetDir), false); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    fs.writeFileSync(file, '{}');
    assert.equal(runRegister({ agentsDir, targetDir, homeDir: home, check: false }).written, 1);
  });
}
