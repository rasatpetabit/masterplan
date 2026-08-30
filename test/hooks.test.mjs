// test/hooks.test.mjs — D2 contract: the Codex SessionStart shim description and its
// inlined copy in docs/install.md must stay synchronized with the canonical /masterplan
// command description (commands/masterplan.md frontmatter). The shim delegates to the
// plugin command, so its description is user-facing: if it drifts from the real verb set,
// a Codex/offline user is told about verbs that do not exist or is not told about verbs
// that do. Each copy is embedded inside shell/JSON escaping, so the test extracts the
// canonical string and asserts the exact bytes appear in both artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Canonical description — single source of truth for the /masterplan command frontmatter.
const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');
const m = prompt.match(/^description: "(.*)"$/m);
assert.ok(m, 'commands/masterplan.md must carry a `description:` frontmatter line');
const CANON = m[1];
const CANON_LITERAL = `description: "${CANON}"`;

test('hooks/hooks.json SessionStart shim carries the canonical description', () => {
  const hooks = fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8');
  const parsed = JSON.parse(hooks);
  const cmd = parsed.hooks.SessionStart[0].hooks[0].command;
  assert.ok(
    typeof cmd === 'string' && cmd.includes('masterplan-shim: v4'),
    'SessionStart shim command must be present and current (v4)',
  );
  assert.ok(
    cmd.includes(CANON_LITERAL),
    `shim command must embed the canonical /masterplan description; got: ${cmd.slice(0, 120)}…`,
  );
});

test('docs/install.md inlined shim carries the canonical description', () => {
  const install = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8');
  assert.ok(
    install.includes(CANON_LITERAL),
    'install.md shim snippet must embed the canonical /masterplan description',
  );
});

test('both shim copies are synchronized with the canonical verb set', () => {
  // Compare semantic content: hooks.json is JSON — parse it (the arrow glyph survives as
  // \u2192 in the raw file bytes but decodes to the real character); install.md is plain
  // shell text, so read it raw. Both must carry the identical canonical description.
  const hooks = fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8');
  const hooksCmd = JSON.parse(hooks).hooks.SessionStart[0].hooks[0].command;
  const install = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8');
  assert.ok(hooksCmd.includes(CANON_LITERAL), 'hooks.json drifted from canonical description');
  assert.ok(install.includes(CANON_LITERAL), 'install.md drifted from canonical description');
});

test('no stale per-verb / retired-namespace shim text survives in either copy', () => {
  const hooks = fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8');
  const install = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8');
  const STALE = [
    'per-verb',
    '/masterplan:<verb>',
    'Brainstorm, plan, execute, resume, doctor, and retrospect long-running work',
  ];
  // Stale-text scan must run on DECODED content (JSON \u2192 real glyph could otherwise
  // hide behind escaping), so parse hooks.json and read install.md raw.
  const hooksCmd = JSON.parse(hooks).hooks.SessionStart[0].hooks[0].command;
  for (const [name, text] of [['hooks/hooks.json', hooksCmd], ['docs/install.md', install]]) {
    for (const s of STALE) {
      assert.ok(!text.includes(s), `${name} must not contain stale shim text ${JSON.stringify(s)}`);
    }
  }
});
