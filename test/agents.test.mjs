// test/agents.test.mjs — frontmatter lint for the dedicated plugin-root agents (build step 3).
//
// Agents are prompts, not modules — they can't be unit-tested by behavior here.
// This guards the one thing a typo silently breaks: the frontmatter the harness reads
// to register each agent and pick its model tier. A bad `model:` would otherwise route
// to the default (parent) tier with no error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable']);
const REQUIRED_KEYS = ['name', 'description', 'model', 'tools'];

// Minimal scalar-frontmatter parser: the block between the first two `---` fences, one
// `key: value` per line. These agent frontmatters are flat scalars (no nesting), so a
// full YAML parser would be a dependency we don't need (zero-dep ethos).
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const fm = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: lines.slice(end + 1).join('\n') };
}

const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));

test('there are dedicated agent files to lint', () => {
  assert.ok(files.length >= 4, `expected >=4 agents/*.md, found ${files.length}`);
});

for (const file of files) {
  test(`agent frontmatter is valid: ${file}`, () => {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    const parsed = parseFrontmatter(text);
    assert.ok(parsed, `${file}: missing or malformed --- frontmatter ---`);
    const { fm, body } = parsed;

    for (const key of REQUIRED_KEYS) {
      assert.ok(fm[key] && fm[key].length > 0, `${file}: frontmatter missing "${key}"`);
    }
    assert.ok(
      VALID_MODELS.has(fm.model),
      `${file}: model "${fm.model}" not in {haiku,sonnet,opus,fable}`,
    );
    assert.equal(
      fm.name,
      basename(file, '.md'),
      `${file}: frontmatter name "${fm.name}" must match filename`,
    );
    // tools is a comma-space list of tool names. Allow word chars (letters, digits,
    // underscore) so legitimate MCP-namespaced tools like `mcp__skynet__skynet_edit_file`
    // pass — they are valid in both Claude Code (the `mcp__<server>__<tool>` convention)
    // and pi (which accepts arbitrary tool-name strings).
    assert.match(fm.tools, /^[\w]+(,\s*[\w]+)*$/, `${file}: malformed tools list`);
    // No scaffold TODO headers left behind.
    assert.doesNotMatch(body, /##\s*TODO\(step 3\)/, `${file}: unresolved TODO(step 3) header`);
  });
}
