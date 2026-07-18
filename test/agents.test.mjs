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
    // underscore) plus hyphens so legitimate MCP-namespaced tools pass — both
    // `mcp__skynet__skynet_edit_file` and serve-mcp tool IDs whose server name carries a
    // hyphen, like `mcp__agent-dispatch__dispatch_task`. Valid in both Claude Code (the
    // `mcp__<server>__<tool>` convention) and pi (which accepts arbitrary tool-name strings).
    assert.match(fm.tools, /^[\w-]+(,\s*[\w-]+)*$/, `${file}: malformed tools list`);
    // No scaffold TODO headers left behind.
    assert.doesNotMatch(body, /##\s*TODO\(step 3\)/, `${file}: unresolved TODO(step 3) header`);
  });
}

// --- adsp dispatch-contract lint for the five rewired wrapper agents ------------------
// mp-planner / mp-subsystem-planner / mp-spec-decomposer route planning judgment, and
// mp-plan-reviewer / mp-goal-assessor route review judgment, through
// mcp__agent-dispatch__dispatch_task with a policy task class. Their class tokens and
// return-shape assumptions are validated against the checked-in frozen fixture — never
// against a live sibling-repo path, and never via hard-coded assumptions about the
// dispatch_task payload: the fixture IS the contract snapshot.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ADSP_CONTRACT = JSON.parse(readFileSync(join(FIXTURES_DIR, 'adsp-contract.json'), 'utf8'));
const REWIRED_AGENTS = [
  'mp-planner.md',
  'mp-subsystem-planner.md',
  'mp-spec-decomposer.md',
  'mp-plan-reviewer.md',
  'mp-goal-assessor.md',
];

test('rewired wrappers are fail-closed on lane unavailable (no native fallback)', () => {
  const failClosedMarker = /fail[- ]closed|surface\s+loudly/i;
  // Prescriptive native-fallback language, in any phrasing variant, is forbidden.
  const nativeFallback =
    /fall(?:s|ing)?[ -]?back\s+to\s+native|fallback\s+to\s+native|use\s+a\s+native\s+fallback|handle\s+natively|natively\s+synthesi[sz]e|synthesi[sz]e\s+natively/i;
  for (const file of REWIRED_AGENTS) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    assert.match(
      text,
      failClosedMarker,
      `${file}: must document fail-closed / surface-loudly lane-unavailable behavior`,
    );
    assert.doesNotMatch(text, nativeFallback, `${file}: native-fallback language is forbidden`);
    // Belt-and-braces: any remaining mention of native handling must sit inside an
    // explicit negation ("never native", "is NOT a permitted fallback"), so a future
    // prescriptive variant cannot slip past the fixed pattern list above.
    for (const m of text.matchAll(/\bnativ(?:e|ely)\b/gi)) {
      const ctx = text.slice(Math.max(0, m.index - 120), m.index + 120);
      assert.ok(
        /\bnot\b|\bnever\b/i.test(ctx),
        `${file}: mention of native handling lacks an explicit negation: ...${ctx.replace(/\s+/g, ' ').trim()}...`,
      );
    }
    // The tool must be declared in frontmatter `tools:` — a whole-file /dispatch_task/
    // grep would pass on prose alone. Require the exact serve-mcp tool ID the fixture
    // pins, parsed from the frontmatter tools list.
    const parsed = parseFrontmatter(text);
    assert.ok(parsed, `${file}: missing or malformed frontmatter`);
    const toolList = parsed.fm.tools.split(',').map((t) => t.trim());
    assert.ok(
      toolList.includes(ADSP_CONTRACT.dispatch_task.tool),
      `${file}: frontmatter tools must declare ${ADSP_CONTRACT.dispatch_task.tool} (got: ${parsed.fm.tools})`,
    );
    assert.doesNotMatch(text, /mcp__skynet__/, `${file}: stale mcp__skynet__ tool reference`);
  }
});

test('class tokens in rewired wrappers resolve against the frozen adsp contract', () => {
  const validClasses = new Set(ADSP_CONTRACT.classes);
  for (const file of REWIRED_AGENTS) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    // Class-token extraction: accept both unquoted (`class: "critic"`, `descriptor.class:
    // "critic"`) and JSON-quoted (`"class": "critic"`) property styles; the lookbehind
    // rejects lookalikes such as `subclass:`. Scan complete invocation BLOCKS
    // (blank-line-delimited chunks that mention dispatch_task or the descriptor), not
    // single lines: a multiline payload puts `class: "..."` on its own line, where a
    // line-scoped scan would miss it or be masked by prose mentioning the class elsewhere.
    const classProp = /(?<![\w-])["']?class["']?\s*:\s*["']([a-z][a-z0-9-]*)["']/g;
    const tokens = [];
    for (const block of text.split(/\n[ \t]*\n/)) {
      if (!/dispatch_task|descriptor/.test(block)) continue;
      for (const m of block.matchAll(classProp)) tokens.push(m[1]);
    }
    assert.ok(tokens.length > 0, `${file}: no class token found in invocation prose`);
    for (const token of tokens) {
      assert.ok(
        validClasses.has(token),
        `${file}: class token "${token}" is not a resolvable policy class ID ` +
          `(fixture classes: ${ADSP_CONTRACT.classes.join(', ')})`,
      );
    }
    const expected = ADSP_CONTRACT.wrapper_classes[file];
    assert.ok(expected, `fixture wrapper_classes has no entry for ${file}`);
    assert.ok(
      tokens.every((t) => t === expected),
      `${file}: expected class "${expected}", found ${JSON.stringify([...new Set(tokens)])}`,
    );
  }
});

test('dispatch_task return shape expresses each wrapper verdict vocabulary', () => {
  const response = ADSP_CONTRACT.dispatch_task.response;
  assert.equal(response.fixed_record, false, 'fixture: dispatch_task response must not be a fixed record');
  assert.equal(
    response.carries_arbitrary_verdict_vocabulary,
    true,
    'fixture: dispatch_task response must carry arbitrary verdict vocabularies',
  );
  const vocabularies = ADSP_CONTRACT.verdict_vocabularies;
  // The vocabulary map must exactly cover the review (critic-class) wrappers — derived
  // from the fixture's wrapper class map, not a hard-coded count.
  const reviewWrappers = Object.entries(ADSP_CONTRACT.wrapper_classes)
    .filter(([, cls]) => cls === 'critic')
    .map(([agentFile]) => agentFile)
    .sort();
  assert.ok(vocabularies, 'fixture must declare verdict_vocabularies');
  assert.deepEqual(
    Object.keys(vocabularies).sort(),
    reviewWrappers,
    'fixture verdict vocabularies must exactly cover the critic-class review wrappers',
  );
  for (const [file, vocabulary] of Object.entries(vocabularies)) {
    assert.ok(REWIRED_AGENTS.includes(file), `fixture declares vocabulary for unknown agent ${file}`);
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    for (const term of vocabulary) {
      assert.ok(
        text.includes(term),
        `${file}: declared verdict term "${term}" missing from the agent contract`,
      );
    }
  }
});

test('documented invocations carry the required descriptor fields (class nested under descriptor)', () => {
  const required = ADSP_CONTRACT.dispatch_task.request.descriptor_required;
  assert.ok(
    Array.isArray(required) && required.length > 0,
    'fixture must declare dispatch_task.request.descriptor_required',
  );
  for (const file of REWIRED_AGENTS) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    for (const field of required) {
      // Accept the dot style (`descriptor.repo`) or the field documented on the same
      // line as the descriptor (e.g. "(descriptor declaring `class: ...`, `repo` = ...)").
      const fieldRe = new RegExp('descriptor\\.' + field + '\\b|descriptor[^\\n]*`' + field + '`');
      assert.match(
        text,
        fieldRe,
        `${file}: documented invocation must carry required descriptor field "${field}"`,
      );
    }
    // The class argument must be documented nested under the descriptor, never as a
    // top-level dispatch_task argument.
    assert.match(
      text,
      /descriptor\.class|descriptor[^\n]*class:/,
      `${file}: the class argument must be documented nested under the descriptor`,
    );
  }
});
