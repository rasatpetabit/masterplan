// test/register-pi-agents.test.mjs — guards the pi agent-registration model map.
//
// bin/register-pi-agents.mjs generates ~/.pi/agent/agents/mp-*.md from the CC
// canonical agents/mp-*.md, swapping ONLY the `model:` line per MODEL_MAP. The
// map is the fragile part: a missing or wrong entry means a pi agent either
// throws (no mapping) or runs on the wrong tier. These tests pin the map and
// the line-swap, and assert every CC agent's declared alias is covered.
//
// The script's filesystem side-effects (writing ~/.pi/...) are NOT tested here
// (host state); main() is import-guarded so this import is pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const { MODEL_MAP, COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor, runRegister } = await import(join(repoRoot, 'bin/register-pi-agents.mjs'));

test('MODEL_MAP covers exactly the aliases the mp-* agents declare (opus, fable)', () => {
  // Audit every agents/mp-*.md `model:` line and collect the distinct aliases.
  const agentsDir = join(repoRoot, 'agents');
  const aliases = new Set();
  for (const f of readdirSync(agentsDir).filter((x) => /^mp-.*\.md$/.test(x))) {
    const body = readFileSync(join(agentsDir, f), 'utf8');
    const m = body.match(/^model:\s*(\S+)\s*$/m);
    assert.ok(m, `${f}: missing model: line`);
    aliases.add(m[1]);
  }
  // Every alias used by some agent must have a mapping.
  for (const a of aliases) {
    assert.ok(MODEL_MAP[a], `MODEL_MAP missing entry for alias "${a}" (used by an mp-* agent)`);
  }
  // No sonnet — it is OVERRIDE-ONLY on this host (AGENTS.md §routing); a sonnet
  // agent would collide with routing policy, so the map must not introduce one.
  assert.equal(MODEL_MAP.sonnet, undefined, 'sonnet must not be in MODEL_MAP (routing policy)');
});

test('MODEL_MAP targets resolve to the litellm provider ids in enabledModels', () => {
  // These are the pi-resolvable equivalents of the CC bare aliases. If either
  // changes (e.g. a model is renamed upstream), update the map AND this test.
  assert.equal(MODEL_MAP.opus, 'litellm/opus-4.8');
  assert.equal(MODEL_MAP.fable, 'litellm/fable-5');
});

test('mapModelLine swaps only the model line, leaving the body byte-identical', () => {
  const src = '---\nname: mp-x\ndescription: x\nmodel: opus\ntools: Read, Grep\n---\n\nbody line 1\nbody line 2\n';
  const { alias, mapped, body } = mapModelLine(src, 'mp-x.md');
  assert.equal(alias, 'opus');
  assert.equal(mapped, 'litellm/opus-4.8');
  const outLines = body.split('\n');
  const srcLines = src.split('\n');
  // Same line count, only the `model:` line differs.
  assert.equal(outLines.length, srcLines.length);
  const diffs = outLines.filter((l, i) => l !== srcLines[i]);
  assert.deepEqual(diffs, ['model: litellm/opus-4.8']);
  // Everything before/after the frontmatter model line is untouched.
  assert.ok(body.includes('tools: Read, Grep'), 'tools line must be untouched');
  assert.ok(body.includes('body line 1\nbody line 2'), 'body must be untouched');
});

test('mapModelLine handles fable alias', () => {
  const { alias, mapped } = mapModelLine('---\nmodel: fable\n---\n', 'mp-x.md');
  assert.equal(alias, 'fable');
  assert.equal(mapped, 'litellm/fable-5');
});

test('mapModelLine throws on an unmapped alias (catches a new agent using an unknown model)', () => {
  assert.throws(
    () => mapModelLine('---\nmodel: gemini\n---\n', 'mp-x.md'),
    /has no pi mapping/,
  );
});

test('mapModelLine throws when there is no model line', () => {
  assert.throws(
    () => mapModelLine('---\nname: mp-x\n---\n', 'mp-x.md'),
    /no `model:` frontmatter line/,
  );
});

// ---- runRegister filesystem behavior (the CLI contract) ----
// These exercise runRegister against temp dirs so nothing touches the real host.

function setupTmpAgents(files) {
  // files: { 'mp-x.md': '...body...', ... }
  const agentsDir = mkdtempSync(join(tmpdir(), 'mp-reg-agents-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(agentsDir, name), body);
  const targetDir = mkdtempSync(join(tmpdir(), 'mp-reg-target-'));
  return { agentsDir, targetDir };
}

const VALID_AGENT = '---\nname: mp-x\ndescription: x\nmodel: opus\ntools: Read, Grep\n---\n\nbody\n';

function snapshot(dir) {
  // recursive-ish listing of files under dir, with contents, for mutation detection
  if (!existsSync(dir)) return null;
  const out = {};
  for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), 'utf8');
  return out;
}

test('runRegister --check is READ-ONLY: no writes, no deletes, no file creation', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  const before = snapshot(targetDir);
  const res = runRegister({ agentsDir, targetDir, check: true });
  const after = snapshot(targetDir);
  assert.deepEqual(after, before, 'check mode must not create, modify, or delete any file');
  assert.equal(res.written, 0);
  assert.equal(res.removed, 0);
  // Files are missing (target was empty) → that is drift, reported not fixed.
  assert.ok(res.drift > 0, 'check should report drift for missing files');
});

test('runRegister write mode produces bare + colon alias with swapped model', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(res.registered, 1);
  assert.equal(res.written, 2, 'bare + colon alias');
  const bare = readFileSync(join(targetDir, 'mp-x.md'), 'utf8');
  const colon = readFileSync(join(targetDir, 'masterplan:mp-x.md'), 'utf8');
  assert.ok(bare.includes('model: litellm/opus-4.8'));
  assert.ok(colon.includes('name: masterplan:mp-x'));
  assert.ok(colon.includes('model: litellm/opus-4.8'));
});

test('runRegister --check passes (drift=0) after a clean write', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  runRegister({ agentsDir, targetDir, check: false });
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.equal(res.drift, 0, JSON.stringify(res.report));
});

test('runRegister --check detects a mismatched installed file as drift', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'mp-x.md'), 'stale wrong content');
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.ok(res.drift > 0);
  assert.ok(res.report.some((l) => /DRIFT.*mp-x\.md.*differs/.test(l)));
  // and it must NOT have overwritten the stale file
  assert.equal(readFileSync(join(targetDir, 'mp-x.md'), 'utf8'), 'stale wrong content');
});

test('runRegister --check reports (does NOT delete) stale copies of a skipped agent', () => {
  // mp-implementer is in SKIP_FOR_PI; its source exists in agents/ and stale pi copies linger.
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-implementer.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'mp-implementer.md'), 'stale');
  writeFileSync(join(targetDir, 'masterplan:mp-implementer.md'), 'stale');
  const before = snapshot(targetDir);
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.deepEqual(snapshot(targetDir), before, 'check must not delete stale skipped copies');
  assert.ok(res.drift >= 2, 'both stale copies should count as drift');
});

test('runRegister write mode REMOVES stale copies of a skipped agent (idempotency)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-implementer.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'mp-implementer.md'), 'stale');
  writeFileSync(join(targetDir, 'masterplan:mp-implementer.md'), 'stale');
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(res.removed, 2);
  assert.equal(existsSync(join(targetDir, 'mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-implementer.md')), false);
});

test('runRegister --check flags orphaned generated files (removed/renamed source)', () => {
  // A generated copy exists for a source that is no longer in agents/.
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  runRegister({ agentsDir, targetDir, check: false });
  // now simulate a renamed source: agents/ has mp-x, but an orphan mp-y copy lingers
  writeFileSync(join(targetDir, 'mp-y.md'), '---\nname: mp-y\nmodel: litellm/opus-4.8\n---\n');
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.ok(res.drift > 0, 'orphan mp-y.md should be flagged as drift');
  assert.ok(res.report.some((l) => /UNEXPECTED mp-y\.md/.test(l)));
  // write mode must NOT auto-delete the orphan (conservative — could be unrelated)
  const res2 = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(existsSync(join(targetDir, 'mp-y.md')), true, 'orphans are flagged, never auto-removed');
  assert.ok(res2.report.some((l) => /UNEXPECTED mp-y\.md/.test(l)));
});

test('runRegister leaves non-mp files and non-managed files untouched', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'README.md'), 'keep me');
  writeFileSync(join(targetDir, 'scout.md'), 'unrelated agent');
  runRegister({ agentsDir, targetDir, check: false });
  assert.equal(readFileSync(join(targetDir, 'README.md'), 'utf8'), 'keep me');
  assert.equal(readFileSync(join(targetDir, 'scout.md'), 'utf8'), 'unrelated agent');
});

test('COLON_PREFIX is the CC plugin namespace delimiter', () => {
  assert.equal(COLON_PREFIX, 'masterplan:');
});

test('mapNameLine prefixes name: with the CC namespace, leaving everything else untouched', () => {
  const src = '---\nname: mp-x\ndescription: x\nmodel: opus\ntools: Read, Grep\n---\n\nbody\n';
  const out = mapNameLine(src, 'mp-x.md');
  const diffs = out.split('\n').filter((l, i) => l !== src.split('\n')[i]);
  assert.deepEqual(diffs, ['name: masterplan:mp-x']);
  assert.ok(out.includes('tools: Read, Grep'), 'tools untouched');
  assert.ok(out.includes('body'), 'body untouched');
});

test('mapNameLine is idempotent (already-namespaced name is not double-prefixed)', () => {
  const src = '---\nname: masterplan:mp-x\n---\n';
  assert.equal(mapNameLine(src, 'mp-x.md'), src);
});

test('mapNameLine throws when there is no name line', () => {
  assert.throws(
    () => mapNameLine('---\nmodel: opus\n---\n', 'mp-x.md'),
    /no `name:` frontmatter line/,
  );
});

test('outputsFor yields a bare copy and a colon alias copy per agent', () => {
  const swapped = '---\nname: mp-x\nmodel: litellm/opus-4.8\ntools: Read\n---\n\nbody\n';
  const outs = outputsFor('mp-x.md', swapped);
  assert.equal(outs.length, 2);
  assert.equal(outs[0].rel, 'mp-x.md');
  assert.equal(outs[0].body, swapped, 'bare copy body is the model-swapped body verbatim');
  assert.equal(outs[1].rel, 'masterplan:mp-x.md', 'colon alias filename uses the CC namespace');
  assert.ok(outs[1].body.includes('name: masterplan:mp-x'), 'colon alias name is namespaced');
  assert.ok(outs[1].body.includes('model: litellm/opus-4.8'), 'colon alias keeps the swapped model');
  assert.ok(!outs[1].body.match(/^name: mp-x$/m), 'colon alias does not leave the bare name');
});

test('SKIP_FOR_PI excludes mp-implementer (CC-only skynet MCP contract)', () => {
  // mp-implementer's whole identity is routing edits to the skynet MCP, which pi does not
  // host; its only caller is the CC L2 wave engine. Registering it on pi would ship a
  // broken agent. This pins the skip so it cannot silently regress.
  assert.ok(SKIP_FOR_PI.has('mp-implementer.md'), 'mp-implementer must be skipped for pi');
});

test('every non-skipped agent that declares tools covers its MCP-namespaced names', () => {
  // Guards the agents.test.mjs regex fix: mcp__server__tool names are legitimate and must
  // not be treated as malformed. Confirms the tool-list regex in test/agents.test.mjs
  // accepts underscores (the mcp__ convention).
  const agentsDir = join(repoRoot, 'agents');
  for (const f of readdirSync(agentsDir).filter((x) => /^mp-.*\.md$/.test(x))) {
    const body = readFileSync(join(agentsDir, f), 'utf8');
    const m = body.match(/^tools:\s*(.+)$/m);
    if (!m) continue;
    const toolsLine = m[1];
    // The same shape test/agents.test.mjs enforces — now widened to \w.
    assert.match(
      toolsLine,
      /^[\w]+(,\s*[\w]+)*$/,
      `${f}: tool list no longer matches the (widened) agents.test.mjs regex`,
    );
  }
});
