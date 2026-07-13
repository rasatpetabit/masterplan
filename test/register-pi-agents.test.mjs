// test/register-pi-agents.test.mjs — guards the pi agent-registration model map.
//
// bin/register-pi-agents.mjs generates ~/.pi/agent/agents/mp-*.md from the CC
// canonical agents/mp-*.md, swapping ONLY the `model:` line per MODEL_MAP. The
// map is the fragile part: a missing or wrong entry means a pi agent either
// throws (no mapping) or runs on the wrong tier.
//
// Complete input set of the script: only agents/mp-*.md under agents/, minus
// SKIP_FOR_PI (currently mp-implementer.md). No other profiles/config feeds.
//
// Live alias contract (post gateway-wrapper migration): every canonical agent
// declares model: fable; MODEL_MAP is exactly { fable → litellm/fable-5 }.
// Bidirectional equality (map keys == declared non-skipped aliases) is enforced
// below; unknown aliases fail closed.
//
// The script's filesystem side-effects against the real host (~/.pi/...) are
// NOT tested here; main() is import-guarded so this import is pure. Temp-dir
// runRegister tests cover write/check/SKIP_FOR_PI exclusion + drift detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const { MODEL_MAP, COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor, runRegister } = await import(join(repoRoot, 'bin/register-pi-agents.mjs'));

function agentModelAliases({ includeSkipped = true } = {}) {
  const agentsDir = join(repoRoot, 'agents');
  const aliases = new Set();
  const perFile = [];
  for (const f of readdirSync(agentsDir).filter((x) => /^mp-.*\.md$/.test(x))) {
    if (!includeSkipped && SKIP_FOR_PI.has(f)) continue;
    const body = readFileSync(join(agentsDir, f), 'utf8');
    const m = body.match(/^model:\s*(\S+)\s*$/m);
    assert.ok(m, `${f}: missing model: line`);
    aliases.add(m[1]);
    perFile.push({ file: f, alias: m[1] });
  }
  return { aliases, perFile };
}

test('every canonical agents/mp-*.md frontmatter model: is fable (incl. SKIP_FOR_PI)', () => {
  const { perFile } = agentModelAliases({ includeSkipped: true });
  assert.ok(perFile.length > 0, 'expected at least one mp-*.md agent');
  for (const { file, alias } of perFile) {
    assert.equal(alias, 'fable', `${file}: expected model: fable, got ${alias}`);
  }
});

test('MODEL_MAP keys == model: aliases of non-skipped agents (bidirectional)', () => {
  const { aliases } = agentModelAliases({ includeSkipped: false });
  const mapKeys = new Set(Object.keys(MODEL_MAP));
  assert.deepEqual(
    [...mapKeys].sort(),
    [...aliases].sort(),
    `MODEL_MAP keys ${JSON.stringify([...mapKeys])} must equal non-skipped agent aliases ${JSON.stringify([...aliases])}`,
  );
  // No sonnet — OVERRIDE-ONLY on this host (AGENTS.md §routing).
  assert.equal(MODEL_MAP.sonnet, undefined, 'sonnet must not be in MODEL_MAP (routing policy)');
  // No dormant opus entry (strict live-alias map).
  assert.equal(MODEL_MAP.opus, undefined, 'opus must not be in MODEL_MAP (dead alias pruned)');
});

test('MODEL_MAP targets resolve to the litellm provider ids in enabledModels', () => {
  assert.equal(MODEL_MAP.fable, 'litellm/fable-5');
});

test('mapModelLine swaps only the model line, leaving the body byte-identical', () => {
  const src = '---\nname: mp-x\ndescription: x\nmodel: fable\ntools: Read, Grep\n---\n\nbody line 1\nbody line 2\n';
  const { alias, mapped, body } = mapModelLine(src, 'mp-x.md');
  assert.equal(alias, 'fable');
  assert.equal(mapped, 'litellm/fable-5');
  const outLines = body.split('\n');
  const srcLines = src.split('\n');
  assert.equal(outLines.length, srcLines.length);
  const diffs = outLines.filter((l, i) => l !== srcLines[i]);
  assert.deepEqual(diffs, ['model: litellm/fable-5']);
  assert.ok(body.includes('tools: Read, Grep'), 'tools line must be untouched');
  assert.ok(body.includes('body line 1\nbody line 2'), 'body must be untouched');
});

test('mapModelLine throws on an unmapped alias (fail-closed; not a live alias fixture)', () => {
  assert.throws(
    () => mapModelLine('---\nmodel: gemini\n---\n', 'mp-x.md'),
    /has no pi mapping/,
  );
  // opus is no longer mapped — reintroduction fails closed rather than silently shipping.
  assert.throws(
    () => mapModelLine('---\nmodel: opus\n---\n', 'mp-x.md'),
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

function setupTmpAgents(files) {
  const agentsDir = mkdtempSync(join(tmpdir(), 'mp-reg-agents-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(agentsDir, name), body);
  const targetDir = mkdtempSync(join(tmpdir(), 'mp-reg-target-'));
  return { agentsDir, targetDir };
}

const VALID_AGENT = '---\nname: mp-x\ndescription: x\nmodel: fable\ntools: Read, Grep\n---\n\nbody\n';
const IMPLEMENTER_AGENT = '---\nname: mp-implementer\ndescription: x\nmodel: fable\ntools: Read\n---\n\nbody\n';

function snapshot(dir) {
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
  assert.ok(res.drift > 0, 'check should report drift for missing files');
});

test('runRegister write mode produces bare-only with swapped model', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(res.registered, 1);
  assert.equal(res.written, 1, 'bare only');
  const bare = readFileSync(join(targetDir, 'mp-x.md'), 'utf8');
  assert.ok(bare.includes('model: litellm/fable-5'));
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-x.md')), false, 'no colon alias emitted');
});

test('runRegister never emits mp-implementer or masterplan:mp-implementer targets', () => {
  const { agentsDir, targetDir } = setupTmpAgents({
    'mp-x.md': VALID_AGENT,
    'mp-implementer.md': IMPLEMENTER_AGENT,
  });
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(res.registered, 1, 'only non-skipped agents register');
  assert.equal(existsSync(join(targetDir, 'mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'mp-x.md')), true);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-x.md')), false, 'bare-only: no colon for non-skipped either');
  const check = runRegister({ agentsDir, targetDir, check: true });
  assert.equal(check.drift, 0, JSON.stringify(check.report));
  assert.ok(!check.report.some((l) => /mp-implementer/.test(l) && /WROTE|OK/.test(l)));
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
  assert.equal(readFileSync(join(targetDir, 'mp-x.md'), 'utf8'), 'stale wrong content');
});

test('runRegister --check reports (does NOT delete) stale copies of a skipped agent', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-implementer.md': IMPLEMENTER_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'mp-implementer.md'), 'stale');
  writeFileSync(join(targetDir, 'masterplan:mp-implementer.md'), 'stale');
  const before = snapshot(targetDir);
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.deepEqual(snapshot(targetDir), before, 'check must not delete stale skipped copies');
  assert.ok(res.drift >= 2, 'both stale copies should count as drift');
});

test('runRegister write mode REMOVES stale copies of a skipped agent (idempotency)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-implementer.md': IMPLEMENTER_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'mp-implementer.md'), 'stale');
  writeFileSync(join(targetDir, 'masterplan:mp-implementer.md'), 'stale');
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(res.removed, 2);
  assert.equal(existsSync(join(targetDir, 'mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-implementer.md')), false);
});

test('runRegister --check flags orphaned generated files (removed/renamed source)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  runRegister({ agentsDir, targetDir, check: false });
  writeFileSync(join(targetDir, 'mp-y.md'), '---\nname: mp-y\nmodel: litellm/fable-5\n---\n');
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.ok(res.drift > 0, 'orphan mp-y.md should be flagged as drift');
  assert.ok(res.report.some((l) => /UNEXPECTED mp-y\.md/.test(l)));
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
  const src = '---\nname: mp-x\ndescription: x\nmodel: fable\ntools: Read, Grep\n---\n\nbody\n';
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
    () => mapNameLine('---\nmodel: fable\n---\n', 'mp-x.md'),
    /no `name:` frontmatter line/,
  );
});

test('outputsFor yields a bare copy only (no colon alias)', () => {
  const swapped = '---\nname: mp-x\nmodel: litellm/fable-5\ntools: Read\n---\n\nbody\n';
  const outs = outputsFor('mp-x.md', swapped);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].rel, 'mp-x.md');
  assert.equal(outs[0].body, swapped, 'bare copy body is the model-swapped body verbatim');
});


test('runRegister write removes managed colon leftovers; check flags them as drift', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'masterplan:mp-x.md'), 'retired colon alias');
  const checkBefore = runRegister({ agentsDir, targetDir, check: true });
  assert.ok(checkBefore.drift > 0, 'managed colon leftover is drift');
  assert.ok(checkBefore.report.some((l) => /DRIFT.*masterplan:mp-x\.md/.test(l)));
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-x.md')), true, 'check is read-only');
  const write = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-x.md')), false, 'write removes managed colon');
  assert.ok(write.removed >= 1);
  const checkAfter = runRegister({ agentsDir, targetDir, check: true });
  assert.equal(checkAfter.drift, 0, JSON.stringify(checkAfter.report));
});

test('runRegister does not delete unmanaged masterplan:mp-custom.md and does not count it as drift', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'masterplan:mp-custom.md'), 'operator-owned custom agent');
  runRegister({ agentsDir, targetDir, check: false });
  assert.equal(readFileSync(join(targetDir, 'masterplan:mp-custom.md'), 'utf8'), 'operator-owned custom agent');
  const check = runRegister({ agentsDir, targetDir, check: true });
  assert.equal(check.drift, 0, JSON.stringify(check.report));
  assert.ok(!check.report.some((l) => /mp-custom/.test(l)), 'unmanaged colon must not appear in report');
});

test('runRegister cleans preseeded masterplan:mp-implementer.md (SKIP_FOR_PI managed colon)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({
    'mp-x.md': VALID_AGENT,
    'mp-implementer.md': IMPLEMENTER_AGENT,
  });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'masterplan:mp-implementer.md'), 'stale colon implementer');
  const check = runRegister({ agentsDir, targetDir, check: true });
  assert.ok(check.drift > 0);
  assert.ok(check.report.some((l) => /masterplan:mp-implementer/.test(l)));
  runRegister({ agentsDir, targetDir, check: false });
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-implementer.md')), false);
});

test('SKIP_FOR_PI excludes mp-implementer (CC-only skynet MCP contract)', () => {
  assert.ok(SKIP_FOR_PI.has('mp-implementer.md'), 'mp-implementer must be skipped for pi');
});

test('every non-skipped agent that declares tools covers its MCP-namespaced names', () => {
  const agentsDir = join(repoRoot, 'agents');
  for (const f of readdirSync(agentsDir).filter((x) => /^mp-.*\.md$/.test(x))) {
    const body = readFileSync(join(agentsDir, f), 'utf8');
    const m = body.match(/^tools:\s*(.+)$/m);
    if (!m) continue;
    const toolsLine = m[1];
    assert.match(
      toolsLine,
      /^[\w]+(,\s*[\w]+)*$/,
      `${f}: tool list no longer matches the (widened) agents.test.mjs regex`,
    );
  }
});

test('mp-explorer body asserts fable wrapper default (not frontmatter-only; no forbidden wrapper claims)', () => {
  // Residual plan-gate P2: a positive /fable/i on the whole file would pass on frontmatter alone.
  // Require the BODY to name the checked-in fable default / thin-wrapper shape, and forbid
  // haiku|opus|sonnet as wrapper claims (case-insensitive) in the body only.
  const raw = readFileSync(join(repoRoot, 'agents', 'mp-explorer.md'), 'utf8');
  const parts = raw.split(/^---$/m);
  assert.ok(parts.length >= 3, 'mp-explorer.md must have YAML frontmatter delimiters');
  const body = parts.slice(2).join('---');
  assert.equal(
    /\b(haiku|opus|sonnet)\b/i.test(body),
    false,
    'explorer body must not claim haiku/opus/sonnet as the wrapper model',
  );
  assert.match(
    body,
    /checked-in\s+`?fable`?\s+default/i,
    'explorer body must state the checked-in fable default (not merely mention fable somewhere)',
  );
  assert.match(
    body,
    /thin wrapper|read-only/i,
    'explorer body must describe thin-wrapper / read-only recon semantics',
  );
  assert.equal(
    /model_group\s*:\s*["']?dispatch-/i.test(body),
    false,
    'explorer is pure recon — body must not invent a dispatch-* judgment lane',
  );
});
