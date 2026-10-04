// test/agents.test.mjs — frontmatter lint for the dedicated plugin-root agents (build step 3).
//
// Source contracts omit model selection and retain host-readable frontmatter.
// Effective Pi prompt/tools are exercised against the joint preparation authority
// in register-pi-agents.test.mjs, not inferred from declarations here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const REQUIRED_KEYS = ['name', 'description', 'tools'];
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

test('source agent contracts do not pin a fleet routing model', () => {
  for (const file of files) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    const parsed = parseFrontmatter(text);
    assert.ok(parsed);
    assert.equal(Object.hasOwn(parsed.fm, 'model'), false, file);
    assert.doesNotMatch(text, /policy\/workflow-map\.json/, file);
  }
});

test('consumer instructions describe model-free host-native dispatch', () => {
  const root = join(AGENTS_DIR, '..');
  for (const file of ['commands/masterplan.md', 'skills/masterplan/SKILL.md',
    'AGENTS.md', 'docs/development.md', 'docs/verbs.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(text, /workflow-map\.json|fallback_reviewers|fallback_reason|review-fallback-reason|frontier lane|Model provenance/, file);
    assert.match(text, /MP_DISPATCH_MAP/, file);
    assert.match(text, /host-native/, file);
  }
});

test('decomposition and recovery instructions explicitly select the plan operation', () => {
  const text = readFileSync(join(AGENTS_DIR, '..', 'commands/masterplan.md'), 'utf8');
  const recovery = text.match(/1\. \*\*Subsystems in hand\.\*\*[\s\S]*?(?=\n2\.)/);
  const decomposition = text.match(/2\. \*\*Decompose \(unless `serial`\)\.\*\*[\s\S]*?(?=\n3\.)/);
  for (const [name, section] of [['recovery', recovery], ['decomposition', decomposition]]) {
    assert.ok(section, `missing ${name} instructions`);
    assert.match(section[0], /usecase: 'plan'/, `${name} must explicitly select Pi's plan operation`);
  }
});

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
    assert.equal(
      fm.name,
      basename(file, '.md'),
      `${file}: frontmatter name "${fm.name}" must match filename`,
    );
    // tools is a comma-space list of tool names. Allow word chars (letters, digits,
    // underscore) plus hyphens so legitimate MCP-namespaced tool IDs pass — the
    // `mcp__<server>__<tool>` convention (Claude Code) and arbitrary tool-name strings
    // (pi).
    assert.match(fm.tools, /^[\w-]+(,\s*[\w-]+)*$/, `${file}: malformed tools list`);
    // No scaffold TODO headers left behind.
    assert.doesNotMatch(body, /##\s*TODO\(step 3\)/, `${file}: unresolved TODO(step 3) header`);
  });
}


// --- harness-native contract lint -------------------------------------------------
// The retired delegation contract is gone: every agent's judgment runs
// in the host's governed execution context. Guard the replacement:
// no retired dispatch surfaces, and the on-lane + fail-closed discipline documented.

test('no agent declares a retired dispatch surface (dispatch tools, model_group)', () => {
  for (const file of files) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    const parsed = parseFrontmatter(text);
    assert.ok(parsed, `${file}: missing frontmatter`);
    const toolList = (parsed.fm.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    assert.ok(
      !toolList.some((t) => new RegExp(['dispatch', 'task'].join('_') + '|' + ['dispatch', 'review'].join('_')).test(t)),
      `${file}: retired dispatch tool in frontmatter tools (${parsed.fm.tools})`,
    );
    assert.equal(parsed.fm.model_group, undefined, `${file}: retired model_group frontmatter`);
    assert.doesNotMatch(text, new RegExp('mcp__' + ['agent', 'dispatch'].join('-') + '__'), `${file}: retired MCP tool reference`);
    assert.doesNotMatch(text, /mcp__skynet__/, `${file}: stale mcp__skynet__ tool reference`);
  }
});

test('agent frontmatter is Pi-portable (native tool names, roster presets)', () => {
  // Pi is the primary harness: children spawn with Pi tool names (read/bash/write/edit).
  // Claude-Code-era names (Read/Grep/Glob/Write/Bash) bind to NOTHING under Pi — a child
  // spawned with them has no usable tools and dies emitting raw markup (measured on
  // mp-planner, 2026-08-28). Presets must name one of the roster roles so the core model
  // resolver preserves the canonical operation owner.
  const PI_TOOLS = new Set(['read', 'bash', 'write', 'edit']);
  const ROSTER_PRESETS = new Set(['sweeper', 'finder', 'tracer', 'builder', 'prover', 'judge', 'breaker']);
  for (const file of files) {
    const parsed = parseFrontmatter(readFileSync(join(AGENTS_DIR, file), 'utf8'));
    assert.ok(parsed, `${file}: missing frontmatter`);
    const toolList = (parsed.fm.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of toolList) {
      assert.ok(PI_TOOLS.has(t), `${file}: non-Pi tool name "${t}" in frontmatter tools (${parsed.fm.tools})`);
    }
    // A preset is REQUIRED, not optional: Pi's subagent runtime registers a
    // preset alias only for an agent whose frontmatter declares one, and denies
    // every spawn of an agent it has no alias for ("unknown agent preset"). An
    // agent that declares none is therefore un-dispatchable in every mode, which
    // is a dispatchability failure, never review success.
    assert.ok(
      parsed.fm.preset !== undefined && parsed.fm.preset !== '',
      `${file}: frontmatter missing "preset" — Pi registers no alias for a presetless agent and refuses every spawn ("unknown agent preset")`,
    );
    assert.ok(ROSTER_PRESETS.has(parsed.fm.preset), `${file}: preset "${parsed.fm.preset}" is not a roster role`);
  }
});

test('every judgment agent documents on-lane execution and fail-closed discipline', () => {
  for (const file of files) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    assert.match(
      text,
      /governed lane|routing policy.s|on-lane/i,
      `${file}: must state that judgment runs on the governed routing-policy lane`,
    );
    assert.match(
      text,
      /fail[- ]closed|never (invent|fabricate|guess)/i,
      `${file}: must document fail-closed / never-fabricate discipline`,
    );
    assert.match(
      text,
      /un-governed spawn/,
      `${file}: must forbid judging on an un-governed spawn`,
    );
  }
});

test('release agent manifest excludes model-fallback bypass agent', () => {
  assert.equal(files.includes('mp-fallback-reviewer.md'), false);
});
