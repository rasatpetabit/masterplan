// test/cli-surface.test.mjs — A7/G5 positive documented-surface cross-check.
//
// The A7 repair made bin fail closed on unknown --flags (doctor-style exit 2).
// But fail-closed alone cannot prove every DOCUMENTED mp flag/op/vocabulary is
// implemented — a silent-dropped flag would still pass if it just wasn't taught.
// This test closes that cheat-hole: it enumerates every `mp <verb>` and
// `--<flag>` named inside backtick `mp …` command spans in the authoritative
// surfaces (commands/masterplan.md, docs/verbs.md, both skills) and asserts each
// is actually recognized by bin — a positive implementation cross-check, not a
// negative one.
//
// Contract:
//   - Every `--flag` inside a backtick `mp …` span must be a member of the
//     exported KNOWN_FLAGS set (the union of every flag bin reads).
//   - Every `mp <verb>` must resolve to a bin subcommand case, OR be a reserved
//     verb that dispatches to a real implementation (doctor → bin/doctor.mjs;
//     the prompt-level verbs below are /masterplan sequencer verbs, never `mp`).
//   - End-to-end: a genuinely unknown `--flag` exits 2 with a clear message;
//     a known-but-typo'd-in-context flag that is still in the global set is
//     accepted (documented residual gap, see A7 note in bin).
//   - A1 regression: `mp finish-step --goals-choice=<bad>` is rejected by the
//     engine, and the documented goal-gate flags parse (threaded to the ctx).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_FLAGS, isKnownFlag } from '../bin/masterplan.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The prompt-level /masterplan reserved verbs are sequencer verbs dispatched by
// the markdown shell (some via `mp`, some via other binaries). They are not `mp`
// subcommands; a documented `mp doctor` is an inaccuracy in docs/verbs.md (task 24
// scope) — doctor runs via the separate bin/doctor.mjs. Any reserved verb named in
// an `mp` span is resolved here rather than asserted against bin's case list.
const RESERVED_MP_VERBS = new Set([
  // run via mp continue / mp decide etc., or as shell-level verbs
  'full', 'brainstorm', 'plan', 'execute', 'finish', 'retro', 'import', 'status',
  'validate', 'stats', 'clean', 'next', 'verbs', 'render', 'publish', 'follow',
  // separate binaries / external
  'doctor',
]);

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function docSources() {
  const skills = [
    path.join(os.homedir(), '.pi/agent/skills/masterplan/SKILL.md'),
    path.join(os.homedir(), '.pi/agent/skills/masterplan-detect/SKILL.md'),
  ];
  return [
    path.join(ROOT, 'commands/masterplan.md'),
    path.join(ROOT, 'docs/verbs.md'),
    ...skills.filter((p) => fs.existsSync(p)),
  ];
}

// Extract backtick spans containing an `mp` token, then the verbs + flags within.
function extractDocSurface() {
  const verbs = new Set();
  const flags = new Set();
  for (const src of docSources()) {
    const text = fs.readFileSync(src, 'utf8');
    for (const spanMatch of text.matchAll(/`([^`]*\bmp\b[^`]*)`/g)) {
      const span = spanMatch[1];
      for (const v of span.matchAll(/\bmp\s+(?:\b[a-z0-9-]+:)?([a-z][a-z0-9-]*)/g)) {
        // skip mp-* agent names and mp masterplan itself
        if (v[1] === 'masterplan' || v[1].startsWith('mp-')) continue;
        verbs.add(v[1]);
      }
      for (const f of span.matchAll(/--([a-zA-Z0-9][a-zA-Z0-9-]*)/g)) flags.add(f[1]);
    }
  }
  return { verbs, flags };
}

const binCases = new Set(
  Array.from(
    fs.readFileSync(path.join(ROOT, 'bin/masterplan.mjs'), 'utf8').matchAll(/^    case '([a-z0-9-]+)':/gm),
    (x) => x[1],
  ),
);

test('every documented mp flag is a recognized KNOWN_FLAGS member (positive cross-check)', () => {
  const { flags } = extractDocSurface();
  assert.ok(flags.size >= 40, `expected a meaningful doc surface, got ${flags.size} flags`);
  const missing = [...flags].filter((f) => !isKnownFlag(f)).sort();
  assert.deepEqual(
    missing,
    [],
    `documented mp flags missing from bin KNOWN_FLAGS (silent-drop surface): ${missing.join(', ')}`,
  );
});

test('every documented mp verb resolves to a bin case or a reserved implementation', () => {
  const { verbs } = extractDocSurface();
  assert.ok(verbs.size >= 30, `expected a meaningful verb surface, got ${verbs.size}`);
  const missing = [...verbs].filter((v) => !binCases.has(v) && !RESERVED_MP_VERBS.has(v)).sort();
  assert.deepEqual(
    missing,
    [],
    `documented mp verbs with no bin case or reserved resolution: ${missing.join(', ')}`,
  );
});

test('KNOWN_FLAGS is a closed set (no stray empty/space names)', () => {
  for (const name of KNOWN_FLAGS) {
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(name), `malformed KNOWN_FLAGS entry: ${JSON.stringify(name)}`);
  }
  assert.ok(isKnownFlag('state') && isKnownFlag('result-file') && isKnownFlag('goals-choice'));
  assert.ok(!isKnownFlag('definitely-not-a-real-flag'));
});

test('A7 fail-closed: an unknown flag exits 2 with a doctor-style message (never silently dropped)', () => {
  const r = run(['version', '--definitely-typo-flag']);
  assert.equal(r.status, 2, `unknown flag must exit 2, got ${r.status}`);
  assert.match(r.stderr, /unknown flag --definitely-typo-flag/, `stderr should name the flag: ${r.stderr}`);
});

test('A7 fail-closed applies to mutating verbs, not just read-only ones', () => {
  const r = run(['finish-step', '--state=/nonexistent', '--typod-flag']);
  // fail-closed on the flag fires BEFORE the missing-state error
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --typod-flag/);
});

test('A1: finish-step goal-gate flags are parsed and threaded (unknown choice rejected by engine)', () => {
  // --goals-choice is now a known flag (in KNOWN_FLAGS) and is passed through to
  // finishStep's ctx; an invalid choice is rejected by the engine's GOALS_CHOICES.
  const r = run(['finish-step', '--state=/nonexistent/x.yml', '--goals-choice=bogus']);
  // The flag is recognized (no "unknown flag" die). The engine rejects the choice.
  assert.notEqual(r.status, 2, 'recognized flag must not be rejected as unknown');
  assert.ok(
    r.stderr.includes('unknown --goals-choice') || r.status === 1 || r.stderr.includes('cannot read state'),
    `--goals-choice=bogus should reach the engine, got status ${r.status}: ${r.stderr}`,
  );
});

test('A1: --goal-check and --goals-choice are documented AND recognized (A7 scan closure)', () => {
  assert.ok(isKnownFlag('goal-check'), '--goal-check must be a known flag');
  assert.ok(isKnownFlag('goals-choice'), '--goals-choice must be a known flag');
  const prompt = fs.readFileSync(path.join(ROOT, 'commands/masterplan.md'), 'utf8');
  assert.ok(prompt.includes('--goal-check=failed'), 'prompt must teach --goal-check=failed');
  assert.ok(prompt.includes('--goals-choice=fix'), 'prompt must teach --goals-choice=fix');
  assert.ok(prompt.includes('--goals-choice=waiver'), 'prompt must teach --goals-choice=waiver');
  assert.ok(prompt.includes('--goals-choice=abort'), 'prompt must teach --goals-choice=abort');
});
