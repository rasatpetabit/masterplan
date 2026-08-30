// test/register-pi-agents.test.mjs — guards the pi agent-registration model map.
//
// bin/register-pi-agents.mjs generates ~/.pi/agent/agents/mp-*.md from the CC
// canonical agents/mp-*.md, swapping ONLY the `model:` line per MODEL_MAP. The
// map is the fragile part: a missing or wrong entry means a pi agent either
// throws (no mapping) or runs on the wrong tier.
//
// Complete input set of the script: only agents/mp-*.md under agents/, minus
// SKIP_FOR_PI (empty since C7 deleted mp-implementer; tests inject a sentinel via
// runRegister's skipSet seam). No other profiles/config feeds.
//
// Live alias contract: every canonical agent declares a routing-policy LANE name
// (frontier/longform/…); MODEL_MAP maps every lane to its lane model ref. The map
// is DERIVED from the checked-in policy/workflow-map.json below — never hardcoded
// here — so a fleet model change turns this suite red instead of silently registering
// a retired model. Declared aliases must be a subset of the map keys; unknown
// aliases fail closed.
//
// The script's filesystem side-effects against the real host (~/.pi/...) are
// NOT tested here; main() is import-guarded so this import is pure. Temp-dir
// runRegister tests cover write/check/SKIP_FOR_PI exclusion + drift detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const { MODEL_MAP, COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor, runRegister, parseCliArgs } = await import(join(repoRoot, 'bin/register-pi-agents.mjs'));

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

// Derive the lineup (lane alias → lane model ref) from the checked-in routing policy —
// the single declared source of model ids. Fails loud if the policy is unreadable; a
// silent fallback would let this suite rot into a pin.
function lineupFromRoutingPolicy() {
  const policyPath = join(repoRoot, 'policy', 'workflow-map.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  assert.ok(policy.lanes && typeof policy.lanes === 'object', `${policyPath}: no lanes section`);
  const lineup = {};
  for (const [lane, entry] of Object.entries(policy.lanes)) {
    assert.ok(entry && entry.model, `${policyPath}: lane "${lane}" has no model ref`);
    lineup[lane] = entry.model;
  }
  assert.ok(Object.keys(lineup).length > 0, `${policyPath}: empty lane lineup`);
  return lineup;
}

test('every canonical agents/mp-*.md frontmatter model: is a routing-policy lane alias (incl. SKIP_FOR_PI)', () => {
  const { perFile } = agentModelAliases({ includeSkipped: true });
  assert.ok(perFile.length > 0, 'expected at least one mp-*.md agent');
  const lineup = lineupFromRoutingPolicy();
  for (const { file, alias } of perFile) {
    assert.ok(
      alias in lineup,
      `${file}: model: ${alias} is not a routing-policy lane alias (${Object.keys(lineup).join(', ')})`,
    );
  }
});

test('declared aliases are a subset of MODEL_MAP keys; retired aliases fail closed', () => {
  const { aliases } = agentModelAliases({ includeSkipped: false });
  const mapKeys = new Set(Object.keys(MODEL_MAP));
  for (const alias of aliases) {
    assert.ok(mapKeys.has(alias), `declared alias "${alias}" missing from MODEL_MAP`);
  }
  // Retired aliases — reintroduction must fail closed, not map.
  for (const dead of ['fable', 'sonnet', 'haiku', 'opus']) {
    assert.equal(MODEL_MAP[dead], undefined, `${dead} must not be in MODEL_MAP (retired)`);
  }
});

test('MODEL_MAP targets match the lane model refs the checked-in policy declares', () => {
  const lineup = lineupFromRoutingPolicy();
  assert.deepEqual(
    MODEL_MAP,
    lineup,
    'MODEL_MAP must mirror the routing-policy lane lineup (alias → model ref) exactly',
  );
});

test('mapModelLine swaps only the model line, leaving the body byte-identical', () => {
  const [liveAlias] = Object.keys(MODEL_MAP);
  const src = `---\nname: mp-x\ndescription: x\nmodel: ${liveAlias}\ntools: Read, Grep\n---\n\nbody line 1\nbody line 2\n`;
  const { alias, mapped, body } = mapModelLine(src, 'mp-x.md');
  assert.equal(alias, liveAlias);
  assert.equal(mapped, MODEL_MAP[liveAlias]);
  const outLines = body.split('\n');
  const srcLines = src.split('\n');
  assert.equal(outLines.length, srcLines.length);
  const diffs = outLines.filter((l, i) => l !== srcLines[i]);
  assert.deepEqual(diffs, [`model: ${MODEL_MAP[liveAlias]}`]);
  assert.ok(body.includes('tools: Read, Grep'), 'tools line must be untouched');
  assert.ok(body.includes('body line 1\nbody line 2'), 'body must be untouched');
});

test('mapModelLine throws on an unmapped alias (fail-closed; not a live alias fixture)', () => {
  assert.throws(
    () => mapModelLine('---\nmodel: gemini\n---\n', 'mp-x.md'),
    /has no pi mapping/,
  );
  // fable left the lineup 2026-08-04 — reintroduction fails closed rather than silently shipping.
  assert.throws(
    () => mapModelLine('---\nmodel: fable\n---\n', 'mp-x.md'),
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

const LIVE_ALIAS = Object.keys(MODEL_MAP)[0];
const LIVE_TARGET = MODEL_MAP[LIVE_ALIAS];
const VALID_AGENT = `---\nname: mp-x\ndescription: x\nmodel: ${LIVE_ALIAS}\ntools: Read, Grep\n---\n\nbody\n`;
const IMPLEMENTER_AGENT = `---\nname: worker-digest\ndescription: x\nmodel: ${LIVE_ALIAS}\ntools: Read\n---\n\nbody\n`;

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
  assert.ok(bare.includes(`model: ${LIVE_TARGET}`));
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-x.md')), false, 'no colon alias emitted');
});

test('runRegister never emits worker-digest or masterplan:mp-implementer targets', () => {
  const { agentsDir, targetDir } = setupTmpAgents({
    'mp-x.md': VALID_AGENT,
    'mp-implementer.md': IMPLEMENTER_AGENT,
  });
  const skipSet = new Set(['mp-implementer.md']);
  const res = runRegister({ agentsDir, targetDir, check: false, skipSet });
  assert.equal(res.registered, 1, 'only non-skipped agents register');
  assert.equal(existsSync(join(targetDir, 'mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'mp-x.md')), true);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-x.md')), false, 'bare-only: no colon for non-skipped either');
  const check = runRegister({ agentsDir, targetDir, check: true, skipSet });
  assert.equal(check.drift, 0, JSON.stringify(check.report));
  assert.ok(!check.report.some((l) => /worker-digest/.test(l) && /WROTE|OK/.test(l)));
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
  const res = runRegister({ agentsDir, targetDir, check: true, skipSet: new Set(['mp-implementer.md']) });
  assert.deepEqual(snapshot(targetDir), before, 'check must not delete stale skipped copies');
  assert.ok(res.drift >= 2, 'both stale copies should count as drift');
});

test('runRegister write mode REMOVES stale copies of a skipped agent (idempotency)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-implementer.md': IMPLEMENTER_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'mp-implementer.md'), 'stale');
  writeFileSync(join(targetDir, 'masterplan:mp-implementer.md'), 'stale');
  const res = runRegister({ agentsDir, targetDir, check: false, skipSet: new Set(['mp-implementer.md']) });
  assert.equal(res.removed, 2);
  assert.equal(existsSync(join(targetDir, 'mp-implementer.md')), false);
  assert.equal(existsSync(join(targetDir, 'masterplan:mp-implementer.md')), false);
});

test('runRegister --check flags orphaned generated files (removed/renamed source)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  runRegister({ agentsDir, targetDir, check: false });
  writeFileSync(join(targetDir, 'mp-y.md'), `---\nname: mp-y\nmodel: ${LIVE_TARGET}\n---\n`);
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
  const src = `---\nname: mp-x\ndescription: x\nmodel: ${LIVE_ALIAS}\ntools: Read, Grep\n---\n\nbody\n`;
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
    () => mapNameLine(`---\nmodel: ${LIVE_ALIAS}\n---\n`, 'mp-x.md'),
    /no `name:` frontmatter line/,
  );
});

test('outputsFor yields a bare copy only (no colon alias)', () => {
  const swapped = `---\nname: mp-x\nmodel: ${LIVE_TARGET}\ntools: Read\n---\n\nbody\n`;
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

test('SKIP_FOR_PI is empty post-C7: no canonical agent is CC-only today', () => {
  // mp-implementer.md (the sole historical member) was deleted by fresh-eyes-remediation C7.
  // The skip MECHANISM stays covered via runRegister's skipSet seam (tests above inject a
  // sentinel). If a future agent is CC-only by design, add it to SKIP_FOR_PI and extend
  // this assertion to name it.
  assert.equal(SKIP_FOR_PI.size, 0, 'expected no CC-only agents in the current canonical set');
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
      /^[\w-]+(,\s*[\w-]+)*$/,
      `${f}: tool list no longer matches the (widened) agents.test.mjs regex`,
    );
  }
});


// ---- A6: fail-closed CLI + subprocess mutation guards ----
//
// These run the REAL bin via spawnSync against a temp HOME (never ~/.pi). A
// pre-seeded target file acts as a canary: --help and typo paths must leave it
// untouched (the old behavior ran a full write on ANY flag and could rewrite or
// delete it). A fresh HOME also proves --help creates nothing.
const BIN = join(repoRoot, 'bin', 'register-pi-agents.mjs');

function runCli(args, { withCanary = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mp-reg-home-'));
  if (withCanary) {
    const piAgents = join(home, '.pi', 'agent', 'agents');
    mkdirSync(piAgents, { recursive: true });
    writeFileSync(join(piAgents, 'mp-canary.md'), 'CANARY-ORIGINAL');
  }
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  return { res, home };
}

function homeTree(home) {
  const out = {};
  for (const f of readdirSync(join(home, '.pi', 'agent', 'agents'), { recursive: true })) {
    const p = join(home, '.pi', 'agent', 'agents', String(f));
    out[String(f)] = existsSync(p) ? (readFileSync(p, 'utf8') === 'CANARY-ORIGINAL' ? 'CANARY-ORIGINAL' : readFileSync(p, 'utf8')) : null;
  }
  return out;
}

test('parseCliArgs accepts only --check/--help; unknown flags and positionals throw', () => {
  assert.deepEqual(parseCliArgs([]), { check: false, help: false });
  assert.deepEqual(parseCliArgs(['--check']), { check: true, help: false });
  assert.deepEqual(parseCliArgs(['--help']), { check: false, help: true });
  assert.deepEqual(parseCliArgs(['--check', '--help']), { check: true, help: true });
  for (const bad of ['--chek', '-c', '--write', '--force', 'typo', 'mp-x.md']) {
    assert.throws(() => parseCliArgs([bad]), /unknown option|unexpected argument/, `${bad} must be rejected`);
  }
});

test('A6: --help exits 0, prints usage, and writes nothing (fresh temp HOME)', () => {
  const { res, home } = runCli(['--help']);
  assert.equal(res.status, 0, `--help should exit 0: ${res.stderr}`);
  assert.match(res.stdout, /Usage: node bin\/register-pi-agents\.mjs/, 'help should print usage');
  assert.match(res.stdout, /--check/, 'help should document --check');
  assert.equal(existsSync(join(home, '.pi', 'agent', 'agents')), false, '--help must not create the target dir');
});

test('A6: --help leaves a pre-seeded canary untouched (read-only)', () => {
  const { res, home } = runCli(['--help'], { withCanary: true });
  assert.equal(res.status, 0, `--help should exit 0: ${res.stderr}`);
  assert.deepEqual(homeTree(home), { 'mp-canary.md': 'CANARY-ORIGINAL' }, '--help must not rewrite or delete canary');
});

test('A6: typo flag exits 2 and leaves a pre-seeded canary untouched', () => {
  const { res, home } = runCli(['--chek'], { withCanary: true });
  assert.equal(res.status, 2, `unknown flag must exit 2: ${res.stderr}`);
  assert.match(res.stderr, /unknown option: --chek/, 'stderr should name the offending flag');
  assert.deepEqual(homeTree(home), { 'mp-canary.md': 'CANARY-ORIGINAL' }, 'typo must not rewrite or delete canary');
});

test('A6: positional arg exits 2 and writes nothing (fresh temp HOME)', () => {
  const { res, home } = runCli(['mp-x.md']);
  assert.equal(res.status, 2, `positional must exit 2: ${res.stderr}`);
  assert.equal(existsSync(join(home, '.pi', 'agent', 'agents')), false, 'rejected arg must not create the target dir');
});

test('A6: bare invocation (write mode) still works and is the only mutating path', () => {
  // Regression guard: the fix must not break the legitimate write-mode call.
  const { res } = runCli([]);
  assert.equal(res.status, 0, `bare write should exit 0: ${res.stderr}`);
  assert.match(res.stderr, /wrote/, 'write mode should report what it wrote');
});
