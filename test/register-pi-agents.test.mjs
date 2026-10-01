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

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const { COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor, runRegister, parseCliArgs } = await import(join(repoRoot, 'bin/register-pi-agents.mjs'));

test('mapModelLine strips synthetic model only in frontmatter and accepts model-free source', () => {
  const src = '---\nname: mp-x\nmodel: frontier\npreset: breaker\ntools: read, bash\n---\n\nbody\nmodel: prose\n';
  const expected = src.replace('model: frontier\n', '');
  assert.deepEqual(mapModelLine(src, 'mp-x.md'), { mapped: null, body: expected });
  assert.deepEqual(mapModelLine(expected, 'mp-x.md'), { mapped: null, body: expected });
});
test('canonical registration excludes the retired fallback reviewer', () => {
  assert.equal(existsSync(join(repoRoot, 'agents/mp-fallback-reviewer.md')), false);
});

// ---- runRegister filesystem behavior (the CLI contract) ----

function setupTmpAgents(files) {
  const agentsDir = mkdtempTracked(join(tmpdir(), 'mp-reg-agents-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(agentsDir, name), body);
  const targetDir = mkdtempTracked(join(tmpdir(), 'mp-reg-target-'));
  return { agentsDir, targetDir };
}

const LIVE_ALIAS = 'frontier';
const LIVE_TARGET = 'synthetic-stale-hint';
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

test('runRegister write mode produces bare-only with NO model hint (preset class policy routes)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(res.registered, 1);
  assert.equal(res.written, 1, 'bare only');
  const bare = readFileSync(join(targetDir, 'mp-x.md'), 'utf8');
  assert.ok(!/^model:/m.test(bare), `registered agent must carry no model: hint:\n${bare}`);
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
  const body = `---\nname: mp-x\ntools: Read\n---\n\nbody\n`;
  const outs = outputsFor('mp-x.md', body);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].rel, 'mp-x.md');
  assert.equal(outs[0].body, body, 'bare copy body is the mapped body verbatim');
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
  const home = mkdtempTracked(join(tmpdir(), 'mp-reg-home-'));
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

test('nonempty or malformed lane overrides refuse without mutation or value disclosure', () => {
  const home = mkdtempTracked(join(tmpdir(), 'mp-reg-home-'));
  const configDir = join(home, '.config', 'masterplan'); mkdirSync(configDir, { recursive: true });
  const file = join(configDir, 'lane-overrides.json');
  for (const contents of ['{ not json', '{"frontier":"synthetic-private-value"}']) {
    writeFileSync(file, contents);
    const res = spawnSync(process.execPath, [BIN, '--check'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(res.status, 2, res.stderr); assert.match(res.stderr, /lane-overrides.*retired.*inference routing/);
    assert.doesNotMatch(res.stderr, /synthetic-private-value/); assert.equal(readFileSync(file, 'utf8'), contents);
  }
});

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

// --- Managed-manifest sweep (safe cleanup for agent deletions) -----------------------

test('manifest: write mode records the produced files in .masterplan-managed.json', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  runRegister({ agentsDir, targetDir, check: false });
  const manifest = JSON.parse(readFileSync(join(targetDir, '.masterplan-managed.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.files, ['mp-x.md']);
});

test('manifest: previously-managed file whose source is gone is REMOVED in write mode', () => {
  const { agentsDir, targetDir } = setupTmpAgents({
    'mp-x.md': VALID_AGENT,
    'mp-gone.md': VALID_AGENT.replace(/mp-x/g, 'mp-gone'),
  });
  runRegister({ agentsDir, targetDir, check: false });
  assert.ok(existsSync(join(targetDir, 'mp-gone.md')));
  unlinkSync(join(agentsDir, 'mp-gone.md')); // source agent deleted
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.ok(res.report.some((l) => /REMOVED mp-gone\.md/.test(l)), JSON.stringify(res.report));
  assert.ok(!existsSync(join(targetDir, 'mp-gone.md')));
  const manifest = JSON.parse(readFileSync(join(targetDir, '.masterplan-managed.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['mp-x.md']);
});

test('manifest: colon entries from a prior manifest are pruned too', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'masterplan:mp-retired.md'), 'legacy colon');
  writeFileSync(
    join(targetDir, '.masterplan-managed.json'),
    JSON.stringify({ schema: 1, files: ['masterplan:mp-retired.md'] }) + '\n',
  );
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.ok(res.report.some((l) => /REMOVED masterplan:mp-retired\.md/.test(l)), JSON.stringify(res.report));
  assert.ok(!existsSync(join(targetDir, 'masterplan:mp-retired.md')));
});

test('manifest: unmanaged files are never deleted (pre-manifest adoption + user-authored)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  writeFileSync(join(targetDir, 'mp-mine.md'), 'user-authored agent');
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.ok(existsSync(join(targetDir, 'mp-mine.md')), 'unknown file must survive the first write');
  assert.ok(res.report.some((l) => /UNEXPECTED mp-mine\.md/.test(l)));
  const res2 = runRegister({ agentsDir, targetDir, check: false });
  assert.ok(existsSync(join(targetDir, 'mp-mine.md')), 'unknown file must survive later writes');
  assert.ok(res2.report.some((l) => /UNEXPECTED mp-mine\.md/.test(l)));
});

test('manifest: --check previews stale-managed drift but never mutates', () => {
  const { agentsDir, targetDir } = setupTmpAgents({
    'mp-x.md': VALID_AGENT,
    'mp-gone.md': VALID_AGENT.replace(/mp-x/g, 'mp-gone'),
  });
  runRegister({ agentsDir, targetDir, check: false });
  const before = snapshot(targetDir);
  unlinkSync(join(agentsDir, 'mp-gone.md'));
  const res = runRegister({ agentsDir, targetDir, check: true });
  assert.ok(res.drift >= 1);
  assert.ok(res.report.some((l) => /DRIFT\s+mp-gone\.md \(managed previously/.test(l)), JSON.stringify(res.report));
  assert.ok(existsSync(join(targetDir, 'mp-gone.md')), 'check mode must not delete');
  assert.deepEqual(snapshot(targetDir), before, 'check mode must not mutate anything (manifest included)');
});

test('manifest: corrupt manifest degrades to adoption semantics (nothing deleted)', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  writeFileSync(join(targetDir, 'mp-old.md'), 'stale');
  writeFileSync(join(targetDir, '.masterplan-managed.json'), 'not-json{');
  const res = runRegister({ agentsDir, targetDir, check: false });
  assert.ok(existsSync(join(targetDir, 'mp-old.md')), 'corrupt manifest must never license a deletion');
  assert.ok(res.report.some((l) => /UNEXPECTED mp-old\.md/.test(l)));
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

// ---- mp-intent-critic registration (generic registrar discovery) ----
//
// The registrar is generic: it discovers any agents/mp-*.md entry, maps its
// `model:` lane alias via the routing-policy map, writes the bare copy into the
// managed manifest, and reports clean under --check. This suite proves that for
// mp-intent-critic.md using a minimal temp fixture — it never touches the real
// agents/ tree or the real ~/.pi, so it takes no ownership of the agent prompt.

test('register-pi-agents discovers mp-intent-critic.md, maps its lane model, and reports clean under --check', () => {
  const intentCritic = `---\nname: mp-intent-critic\ndescription: Fresh-context intent critic (critic class, breaker role)\nmodel: frontier\npreset: breaker\ntools: read, bash\n---\n\nbody\n`;
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-intent-critic.md': intentCritic });

  const write = runRegister({ agentsDir, targetDir, check: false });
  assert.equal(write.registered, 1, 'the generic registrar must discover mp-intent-critic.md');
  assert.equal(write.written, 1, 'bare copy must be written');

  const installed = readFileSync(join(targetDir, 'mp-intent-critic.md'), 'utf8');
  assert.ok(!/^model:/m.test(installed), 'the registered agent must carry no model: hint (the preset routes it)');
  assert.ok(installed.includes('name: mp-intent-critic'), 'name must be preserved');
  assert.ok(installed.includes('preset: breaker'), 'preset must be preserved');
  assert.ok(installed.includes('tools: read, bash'), 'tools must be preserved');

  const manifest = JSON.parse(readFileSync(join(targetDir, '.masterplan-managed.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.files, ['mp-intent-critic.md'], 'the produced bare copy must be recorded in the managed manifest');

  const check = runRegister({ agentsDir, targetDir, check: true });
  assert.equal(check.drift, 0, JSON.stringify(check.report));
  assert.ok(check.report.some((l) => /OK\s+mp-intent-critic\.md/.test(l)), JSON.stringify(check.report));
});

test('manifest prunes managed fallback reviewer copies and preserves unmanaged copies', () => {
  const { agentsDir, targetDir } = setupTmpAgents({ 'mp-x.md': VALID_AGENT });
  for (const rel of ['mp-fallback-reviewer.md', 'masterplan:mp-fallback-reviewer.md']) writeFileSync(join(targetDir, rel), 'historical managed');
  writeFileSync(join(targetDir, '.masterplan-managed.json'), JSON.stringify({ schema: 1, files: ['mp-fallback-reviewer.md', 'masterplan:mp-fallback-reviewer.md'] }));
  assert.equal(runRegister({ agentsDir, targetDir, check: true }).removed, 0);
  assert.equal(runRegister({ agentsDir, targetDir, check: false }).removed, 2);
  writeFileSync(join(targetDir, 'mp-fallback-reviewer.md'), 'unmanaged');
  runRegister({ agentsDir, targetDir, check: false });
  assert.equal(readFileSync(join(targetDir, 'mp-fallback-reviewer.md'), 'utf8'), 'unmanaged');
});
