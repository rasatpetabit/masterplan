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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KNOWN_FLAGS, isKnownFlag } from '../bin/masterplan.mjs';
import { writeState } from '../lib/bundle.mjs';
import { intentSha } from '../lib/interview.mjs';
import { goalsHash } from '../lib/goals.mjs';
import { liveCheckDigest } from '../lib/finish.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

// A minimal real bundle: state.yml plus an empty ledger, enough for the ledger verbs and the
// reporting surfaces to operate on. Torn down by the caller.
function seedInterviewBundle({ slug = 'cli-surface', complexity = 'high' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cli-'));
  const bundleDir = path.join(tmp, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  fs.writeFileSync(statePath, [
    'schema_version: 8',
    `slug: ${slug}`,
    'status: in-progress',
    'phase: brainstorm',
    `complexity: ${complexity}`,
    'pending_gate: null',
    'active_run: null',
    'tasks: []',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');
  return { tmp, bundleDir, statePath, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
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
  // Canonical repo sources, NOT installed copies: the installed skill under
  // ~/.pi/agent/skills/ is a consumer artifact (symlink today, copied release
  // snapshot after install-pi) and must never drive the documented-surface
  // contract — tests would silently follow a stale install.
  return [
    path.join(ROOT, 'commands/masterplan.md'),
    path.join(ROOT, 'docs/verbs.md'),
    path.join(ROOT, 'skills/masterplan/SKILL.md'),
    path.join(ROOT, 'skills/masterplan-detect/SKILL.md'),
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
    r.stderr.includes('unknown --goals-choice') || r.status === 1 || r.status === 4 || r.stderr.includes('cannot read state'),
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

// ---------------------------------------------------------------------------
// The v10 CLI surface (wave task 3)
//
// Smoke cases only: ONE accepted invocation per new verb and per new finish-step flag, plus the
// forwarding contracts the sequencer depends on. The exhaustive behavioural matrix lives in the
// orchestration-integration CLI-contract suite.
// ---------------------------------------------------------------------------

test('every new flag is a member of the exported KNOWN_FLAGS set', () => {
  const added = [
    'interview-waived', 'spec-path', 'payload-file', 'resolves', 'round', 'text', 'corrected',
    'unavailable', 'error', 'critic-unavailable-ack', 'file',
    'deploy-authorize', 'deploy-retry', 'deploy-rerun', 'deploy-skip', 'deploy-attest',
    'deploy-abort', 'deploy-step-done', 'exit', 'version-fix',
    'intent-confirmed', 'intent-rejected', 'class', 'successor', 'final',
  ];
  for (const f of added) {
    assert.equal(isKnownFlag(f), true, `--${f} must be known to bin`);
    assert.equal(KNOWN_FLAGS.has(f), true, `--${f} must be in the exported set`);
  }
  // KNOWN_FLAGS stays authoritative: a flag nobody reads is still a hard error.
  assert.equal(isKnownFlag('not-a-real-flag'), false);
  assert.equal(run(['status', '--state=/tmp/nope.yml', '--not-a-real-flag']).status, 2);
});

test('a bootstrap verb is refused by name, with the reason', () => {
  for (const verb of ['bootstrap', 'bootstrap-arm', 'bootstrap-record', 'bootstrap-status']) {
    const r = run([verb]);
    assert.equal(r.status, 2, verb);
    assert.match(r.stderr, /not an mp verb/, verb);
    assert.match(r.stderr, /scripts\/bootstrap-v10\.mjs/, verb);
  }
});

test('the generic event verb is preserved', () => {
  // A typed verb never replaced `event`: the shell records lifecycle milestones through it.
  const r = run(['event']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing required --state/);
});

test('mp config show reports the resolved config and the harness auto-compact window', () => {
  const r = run(['config', 'show', `--repo-root=${REPO}`]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.values, 'the resolved values');
  assert.ok(parsed.sources, 'and where each came from');
  // The harness window is REPORTED, never written: an unreadable settings file says so.
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.harness, 'autoCompactWindow'));
  assert.equal(typeof parsed.harness.readable, 'boolean');
  assert.equal(typeof parsed.harness.source, 'string');
  // The recommendation never sits below the run's own context-watch threshold.
  if (parsed.harness.recommended_min !== null) {
    assert.ok(parsed.harness.recommended_min >= parsed.values.context_watch.threshold);
  }
  assert.equal(run(['config', 'bogus', `--repo-root=${REPO}`]).status, 1);
});

test('mp config show never writes the harness settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cfg-'));
  try {
    const settings = path.join(dir, 'settings.json');
    const before = fs.existsSync(settings);
    const r = run(['config', 'show', `--repo-root=${REPO}`], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(settings), before, 'config show must not create the settings file');
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.harness.readable, false, 'an absent settings file reads as unreadable, not as a default');
    assert.equal(parsed.harness.autoCompactWindow, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the interview ledger verbs ------------------------------------------

test('every documented interview subcommand is accepted, and an unknown one is refused', () => {
  const r = run(['interview', 'not-a-subcommand', '--state=/tmp/nope.yml']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown interview subcommand/);
  // The documented surface, verbatim from spec §5.3.
  for (const sub of ['ask', 'answer', 'withdraw', 'draft', 'critic', 'critic-unavailable',
    'critic-unavailable-ack', 'end', 'waive', 'reopen', 'status', 'replay']) {
    assert.match(r.stderr, new RegExp(sub.replace(/[-]/g, '\\-')), `${sub} must be named in the usage`);
  }
});

test('the interview flag surface parses, and a real ledger round-trips through replay', () => {
  const fx = seedInterviewBundle();
  try {
    assert.equal(run(['interview', 'ask', `--state=${fx.statePath}`, '--id=Q1', '--round=1',
      '--kind=intent', '--text=what problem is this solving?']).status, 0);
    assert.equal(run(['interview', 'answer', `--state=${fx.statePath}`, '--id=Q1',
      '--text=the finish never proves the thing was deployed']).status, 0);
    const replay = run(['interview', 'replay', `--state=${fx.statePath}`]);
    assert.equal(replay.status, 0, replay.stderr);
    const { ledger } = JSON.parse(replay.stdout);
    // The VERBATIM ledger: what was asked and what was answered, in order.
    assert.equal(ledger[0].type, 'question');
    assert.equal(ledger[0].id, 'Q1');
    assert.equal(ledger[0].kind, 'intent');
    assert.match(ledger[0].text, /what problem/);
    assert.equal(ledger[1].type, 'answer');
    assert.match(ledger[1].text, /never proves/);
    const status = run(['interview', 'status', `--state=${fx.statePath}`]);
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).answered, 1);
  } finally {
    fx.cleanup();
  }
});

test('goals-load forwards --interview-waived to the interview waiver operation', () => {
  const fx = seedInterviewBundle();
  try {
    // The waiver is a DURABLE ledger event, not a flag goals-load interprets itself: it lands
    // even though the load then fails for its own (unrelated) reasons.
    run(['goals-load', `--state=${fx.statePath}`, '--goals=/nonexistent/goals.md',
      '--approval=/nonexistent/approval.json', '--interview-waived', '--reason=operator call']);
    const evs = fs.readFileSync(path.join(path.dirname(fx.statePath), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const waived = evs.find((e) => e.type === 'interview_waived');
    assert.ok(waived, `expected a durable interview_waived event, got ${JSON.stringify(evs.map((e) => e.type))}`);
    assert.equal(waived.reason, 'operator call');
    // ...and the waiver requires its reason.
    const noReason = run(['goals-load', `--state=${fx.statePath}`, '--goals=/x', '--approval=/y', '--interview-waived']);
    assert.equal(noReason.status, 2);
    assert.match(noReason.stderr, /missing required --reason/);
  } finally {
    fx.cleanup();
  }
});

// ---- the deploy-stage answer flags ---------------------------------------

test('every deploy flag names its step as group[index], and a malformed ref is refused', () => {
  for (const flag of ['deploy-authorize', 'deploy-retry', 'deploy-rerun', 'deploy-skip', 'deploy-attest', 'deploy-step-done']) {
    const bad = run(['finish-step', '--state=/tmp/nope.yml', `--${flag}=release`, '--session=mp-w6-legacy']);
    assert.equal(bad.status, 2, flag);
    assert.match(bad.stderr, /expects <group>\[<index>\]/, flag);
  }
});

test('--deploy-retry and --deploy-rerun are distinct verbs for distinct states', () => {
  // retry answers a FAILED step; rerun answers an INDETERMINATE one. Both parse; the engine
  // decides which state each is legal in (test/finish-replay.test.mjs owns that contract).
  const fx = seedInterviewBundle();
  try {
    for (const flag of ['deploy-retry', 'deploy-rerun']) {
      const r = run(['finish-step', `--state=${fx.statePath}`, `--${flag}=release[0]`]);
      // It reaches the engine (which refuses on this bundle's state) rather than failing to parse.
      assert.notEqual(r.status, 2, `${flag}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /expects <group>\[<index>\]/);
    }
  } finally {
    fx.cleanup();
  }
});

test('--intent-rejected requires both a class and a named successor', () => {
  const noClass = run(['finish-step', '--state=/tmp/nope.yml', '--intent-rejected', '--reason=x', '--successor=next', '--session=mp-w6-legacy']);
  assert.equal(noClass.status, 2);
  assert.match(noClass.stderr, /--class=implementation\|intent/);
  const badClass = run(['finish-step', '--state=/tmp/nope.yml', '--intent-rejected', '--class=other', '--reason=x', '--successor=next', '--session=mp-w6-legacy']);
  assert.equal(badClass.status, 2);
  // An obligation with no named successor is one nobody can close.
  const noSuccessor = run(['finish-step', '--state=/tmp/nope.yml', '--intent-rejected', '--class=intent', '--reason=x', '--session=mp-w6-legacy']);
  assert.equal(noSuccessor.status, 2);
  assert.match(noSuccessor.stderr, /--successor=<slug>/);
  const noReason = run(['finish-step', '--state=/tmp/nope.yml', '--intent-rejected', '--class=intent', '--successor=next', '--session=mp-w6-legacy']);
  assert.equal(noReason.status, 2);
  assert.match(noReason.stderr, /missing required --reason/);
});

// ---- the reporting surfaces ----------------------------------------------

test('mp status reports the completion class, the push visibility, and open obligations', () => {
  const fx = seedInterviewBundle();
  try {
    const r = run(['status', `--state=${fx.statePath}`]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    // An unarchived run has no class yet, and is not pushed.
    assert.equal(parsed.completion_class, null);
    assert.equal(parsed.pushed, 'no', 'pushed: no until an archive_pushed event lands');
    assert.ok(Array.isArray(parsed.obligations));
  } finally {
    fx.cleanup();
  }
});

test('an archived bundle with no class reads as legacy, and archive_pushed flips pushed', () => {
  const fx = seedInterviewBundle();
  try {
    const evPath = path.join(path.dirname(fx.statePath), 'events.jsonl');
    const state = fs.readFileSync(fx.statePath, 'utf8').replace(/^status: .*$/m, 'status: archived');
    fs.writeFileSync(fx.statePath, state);
    let parsed = JSON.parse(run(['status', `--state=${fx.statePath}`]).stdout);
    assert.equal(parsed.completion_class, 'legacy', 'a bundle archived before the field existed');
    assert.equal(parsed.pushed, 'no');
    fs.appendFileSync(evPath, `${JSON.stringify({ type: 'archive_pushed', ts: '2026-01-01T00:00:00Z', sha: 'abc' })}\n`);
    parsed = JSON.parse(run(['status', `--state=${fx.statePath}`]).stdout);
    assert.equal(parsed.pushed, 'yes');
  } finally {
    fx.cleanup();
  }
});

test('every interview verb has an ACCEPTED invocation, not merely a usage string', () => {
  const fx = seedInterviewBundle();
  try {
    const ok = (args, why) => {
      const r = run(['interview', ...args, `--state=${fx.statePath}`]);
      assert.equal(r.status, 0, `${why}: ${r.stderr}`);
      return r;
    };
    // A real interview, driven through the verbs in the order the ledger allows.
    ok(['ask', '--id=Q1', '--round=1', '--kind=intent', '--text=what is this for?'], 'ask');
    ok(['answer', '--id=Q1', '--text=to prove the deploy happened'], 'answer');
    // A round seals on its first answer, so the next ask opens round 2 — the ledger's rule,
    // not a detail of this fixture.
    ok(['ask', '--id=Q2', '--round=2', '--kind=design', '--text=gate or no gate?'], 'ask design');
    ok(['withdraw', '--id=Q2', '--reason=answered by Q1'], 'withdraw');

    const intentFile = path.join(fx.tmp, 'intent.json');
    fs.writeFileSync(intentFile, JSON.stringify({
      why: 'runs archive without proving deployment',
      outcome: 'a run archives complete only when the thing is live',
      done_means: 'the live check passed and the operator confirmed intent',
      anti_goals: ['a green test suite standing in for a deployment'],
    }));
    ok(['draft', `--file=${intentFile}`], 'draft');

    ok(['critic-unavailable', '--error=the lane timed out'], 'critic-unavailable');
    ok(['critic-unavailable', '--error=the lane timed out again'], 'critic-unavailable twice');
    ok(['critic-unavailable-ack', '--reason=proceed without the critic'], 'critic-unavailable-ack');

    const st = ok(['status'], 'status');
    assert.equal(JSON.parse(st.stdout).answered, 1);
    const rp = ok(['replay'], 'replay');
    assert.ok(Array.isArray(JSON.parse(rp.stdout).ledger));

    // waive is a terminal exit; reopen returns from it. Both are accepted here, in that order.
    ok(['waive', '--reason=the operator called it'], 'waive');
    ok(['reopen', '--reason=more was learned'], 'reopen');
    // ...and `end` is exercised for its refusal contract, which is the engine's to enforce:
    // it must reach lib/interview.mjs rather than failing to parse.
    const ended = run(['interview', 'end', `--state=${fx.statePath}`, '--reason=converged']);
    assert.notEqual(ended.status, 2, `end must reach the engine: ${ended.stderr}`);
    assert.match(ended.stderr + ended.stdout, /converged|floor|draft|receipt|ok/i);
  } finally {
    fx.cleanup();
  }
});

test('every deploy flag has an ACCEPTED shape that reaches the engine', () => {
  const fx = seedInterviewBundle();
  try {
    // A well-formed step ref parses and is forwarded; the engine then refuses on this bundle's
    // state. What matters here is that the flag is not a usage error (exit 2).
    for (const flag of ['deploy-authorize', 'deploy-retry', 'deploy-rerun', 'deploy-skip', 'deploy-attest']) {
      const r = run(['finish-step', `--state=${fx.statePath}`, `--${flag}=release[0]`]);
      assert.notEqual(r.status, 2, `--${flag} must parse: ${r.stderr}`);
    }
    for (const flag of ['deploy-abort', 'version-fix', 'intent-confirmed', 'merged']) {
      const r = run(['finish-step', `--state=${fx.statePath}`, `--${flag}`]);
      assert.notEqual(r.status, 2, `--${flag} must parse: ${r.stderr}`);
    }
    const done = run(['finish-step', `--state=${fx.statePath}`, '--deploy-step-done=release[0]', '--exit=0']);
    assert.notEqual(done.status, 2, `--deploy-step-done must parse: ${done.stderr}`);
    const rejected = run(['finish-step', `--state=${fx.statePath}`, '--intent-rejected',
      '--class=intent', '--reason=it does not do what I meant', '--successor=next-run']);
    assert.notEqual(rejected.status, 2, `--intent-rejected must parse: ${rejected.stderr}`);
  } finally {
    fx.cleanup();
  }
});

test('--deploy-step-done refuses to synthesize a success from a missing or malformed exit', () => {
  const fx = seedInterviewBundle();
  try {
    // The exit status IS the report: defaulting it to 0 would record an unobserved result as
    // a success, which is exactly what §7.1 exists to prevent.
    const missing = run(['finish-step', `--state=${fx.statePath}`, '--deploy-step-done=release[0]', '--session=mp-w6-legacy']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /requires --exit/);
    for (const bad of ['garbage', '-1', '999', '1.5']) {
      const r = run(['finish-step', `--state=${fx.statePath}`, '--deploy-step-done=release[0]', `--exit=${bad}`, '--session=mp-w6-legacy']);
      assert.equal(r.status, 2, `--exit=${bad} must be refused`);
      assert.match(r.stderr, /integer 0-255/);
    }
  } finally {
    fx.cleanup();
  }
});

test('goals-load never skips the interview gate on an unreadable ledger', () => {
  const fx = seedInterviewBundle();
  try {
    // A ledger that cannot be replayed is a hard failure: swallowing the error would make an
    // unreadable ledger the easiest way past the §5.4 exit gate.
    fs.writeFileSync(path.join(path.dirname(fx.statePath), 'events.jsonl'), '{not json at all\n');
    const r = run(['goals-load', `--state=${fx.statePath}`, '--goals=/nonexistent/goals.md', '--approval=/x']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cannot replay the interview ledger|interview/i);
  } finally {
    fx.cleanup();
  }
});

test('an archived bundle without a completion class reads as legacy, never inferred from events', () => {
  const fx = seedInterviewBundle();
  try {
    // Inferring `complete` from ledger events would report a class the run never decided.
    fs.writeFileSync(fx.statePath, fs.readFileSync(fx.statePath, 'utf8').replace(/^status: .*$/m, 'status: archived'));
    fs.appendFileSync(path.join(path.dirname(fx.statePath), 'events.jsonl'),
      `${JSON.stringify({ type: 'incomplete_authorized', ts: '2026-01-01T00:00:00Z', reason: 'deploy_abort' })}\n`);
    const parsed = JSON.parse(run(['status', `--state=${fx.statePath}`]).stdout);
    assert.equal(parsed.completion_class, 'legacy', 'an absent field means legacy, whatever the ledger says');
  } finally {
    fx.cleanup();
  }
});

test('mp context-status and mp resume-brief are wired and read-only', () => {
  const status = run(['context-status', `--repo-root=${REPO}`]);
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  // One of the documented states — never a guessed number.
  assert.ok(['current', 'post-compaction', 'malformed', 'unsupported', 'not-found'].includes(parsed.state), parsed.state);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'tokens_at_last_request'));
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'window'));

  const brief = run(['resume-brief', `--repo-root=${REPO}`]);
  assert.equal(brief.status, 0, brief.stderr);
  const porcelain = run(['resume-brief', `--repo-root=${REPO}`, '--porcelain']);
  assert.equal(porcelain.status, 0, porcelain.stderr);
  const pb = JSON.parse(porcelain.stdout);
  assert.ok(Array.isArray(pb.active));
  assert.ok(Array.isArray(pb.obligations));
  // An obligation always carries the exact command that discharges it.
  // The printed command is RUNNABLE: it carries every argument seed requires.
  for (const o of pb.obligations) {
    assert.match(o.seed_command, /^mp seed /);
    for (const required of ['--state=', '--slug=', '--topic=', '--repo-root=', '--predecessor=', '--overlap-review=']) {
      assert.ok(o.seed_command.includes(required), `${required} missing from: ${o.seed_command}`);
    }
  }
});

test('interview end returns zero once its floors are met', () => {
  // At `low` the budget is one answer, one intent answer, one round — reachable in a smoke
  // test, so `end` is exercised as an ACCEPTED invocation rather than only as routing.
  const fx = seedInterviewBundle({ slug: 'cli-end', complexity: 'low' });
  try {
    const ok = (args, why) => {
      const r = run(['interview', ...args, `--state=${fx.statePath}`]);
      assert.equal(r.status, 0, `${why}: ${r.stderr}`);
      return r;
    };
    ok(['ask', '--id=Q1', '--round=1', '--kind=intent', '--text=what is this for?'], 'ask');
    ok(['answer', '--id=Q1', '--text=to prove the deploy happened'], 'answer');
    const intentFile = path.join(fx.tmp, 'intent.json');
    fs.writeFileSync(intentFile, JSON.stringify({
      why: 'runs archive without proving deployment',
      outcome: 'a run archives complete only when the thing is live',
      done_means: 'the live check passed and the operator confirmed intent',
      anti_goals: ['a green suite standing in for a deployment'],
    }));
    ok(['draft', `--file=${intentFile}`], 'draft');
    // critic_off is the low-complexity terminal state; the floors are met, so it is accepted.
    ok(['end', '--reason=critic_off'], 'end');
    const status = JSON.parse(run(['interview', 'status', `--state=${fx.statePath}`]).stdout);
    assert.equal(status.state, 'critic_off', JSON.stringify(status));
    // ...and a terminal interview refuses further mutation until it is reopened.
    const after = run(['interview', 'ask', `--state=${fx.statePath}`, '--id=Q2', '--round=2', '--kind=intent', '--text=too late?']);
    assert.notEqual(after.status, 0);
    assert.match(after.stderr, /critic_off|terminal|refused/i);
  } finally {
    fx.cleanup();
  }
});

test('the advertised successor command carries every argument mp seed requires', () => {
  // A printed command that exits 2 is not a command. Rather than execute a real successor seed
  // here (that is the sequencer's job), assert the invocation is COMPLETE by feeding its own
  // flags back through the CLI: the only thing left unsupplied is the review file, which the
  // operator produces from `mp runs list`.
  const brief = JSON.parse(run(['resume-brief', `--repo-root=${REPO}`, '--porcelain']).stdout);
  for (const o of brief.obligations) {
    const args = o.seed_command.replace(/^mp seed /, '').split(' ');
    const flagNames = args.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')[0]);
    for (const name of flagNames) {
      assert.equal(isKnownFlag(name), true, `--${name} in the advertised command must be a real flag`);
    }
    assert.ok(flagNames.includes('overlap-review'), 'the §8 review is part of the command');
  }
});

test('record-overlap-review records a review at the tail of a resumed bundle', () => {
  const fx = seedInterviewBundle({ slug: 'cli-overlap' });
  try {
    const repoRoot = path.join(fx.tmp);
    const listed = run(['runs', 'list', `--repo-root=${repoRoot}`]);
    assert.equal(listed.status, 0, listed.stderr);
    const digest = JSON.parse(listed.stdout).inventory_sha256;
    assert.equal(typeof digest, 'string');
    const reviewPath = path.join(fx.tmp, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({ inventory_sha256: digest, candidates: [], action: 'resume' }));
    const r = run(['record-overlap-review', `--state=${fx.statePath}`, `--repo-root=${repoRoot}`, `--review-file=${reviewPath}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).outcome, 'resume');
    const evs = fs.readFileSync(path.join(path.dirname(fx.statePath), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(evs.at(-1).type, 'overlap_review', 'appended at the CURRENT tail');
    assert.equal(evs.at(-1).inventory_sha256, digest);

    // A stale digest is refused rather than recorded.
    fs.writeFileSync(reviewPath, JSON.stringify({ inventory_sha256: 'deadbeef', candidates: [], action: 'resume' }));
    const stale = run(['record-overlap-review', `--state=${fx.statePath}`, `--repo-root=${repoRoot}`, `--review-file=${reviewPath}`]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /overlap_review_stale/);
  } finally {
    fx.cleanup();
  }
});

test('mp seed refuses without a review, refuses a stale one, and leaves nothing behind', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-seedtx-'));
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main', tmp]);
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 't@e.invalid']);
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmp, 'README.md'), '# r\n');
    execFileSync('git', ['-C', tmp, 'add', '-A']);
    execFileSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);
    const statePath = (slug) => path.join(tmp, 'docs', 'masterplan', slug, 'state.yml');

    // No review at all: refused, so the "first event is the review" property cannot hold vacuously.
    const noReview = run(['seed', `--state=${statePath('a')}`, '--slug=a', '--topic=t', `--repo-root=${tmp}`]);
    assert.equal(noReview.status, 2);
    assert.match(noReview.stderr, /--overlap-review=<json file> is required/);

    // A stale digest: refused, and NOTHING is left on disk.
    const stalePath = path.join(tmp, 'stale.json');
    fs.writeFileSync(stalePath, JSON.stringify({ inventory_sha256: 'deadbeef', candidates: [], action: 'proceed' }));
    const stale = run(['seed', `--state=${statePath('b')}`, '--slug=b', '--topic=t', `--repo-root=${tmp}`, `--overlap-review=${stalePath}`]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /overlap_review_stale/);
    assert.equal(fs.existsSync(statePath('b')), false, 'a refused seed leaves nothing on disk');

    // A fresh review: accepted, and the ledger begins [bundle_created, overlap_review].
    const digest = JSON.parse(run(['runs', 'list', `--repo-root=${tmp}`]).stdout).inventory_sha256;
    const okPath = path.join(tmp, 'review.json');
    fs.writeFileSync(okPath, JSON.stringify({ inventory_sha256: digest, candidates: [], action: 'proceed' }));
    const ok = run(['seed', `--state=${statePath('c')}`, '--slug=c', '--topic=t', `--repo-root=${tmp}`, `--overlap-review=${okPath}`]);
    assert.equal(ok.status, 0, ok.stderr);
    const evs = fs.readFileSync(path.join(path.dirname(statePath('c')), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(evs[0].type, 'bundle_created', JSON.stringify(evs.map((e) => e.type)));
    assert.equal(evs[1].type, 'overlap_review', 'the review is the SECOND record');
    assert.equal(evs[1].inventory_sha256, digest);

    // A --force reseed replaces the ledger too, so the review stays second.
    const digest2 = JSON.parse(run(['runs', 'list', `--repo-root=${tmp}`]).stdout).inventory_sha256;
    fs.writeFileSync(okPath, JSON.stringify({ inventory_sha256: digest2, candidates: [], action: 'proceed' }));
    const forced = run(['seed', `--state=${statePath('c')}`, '--slug=c', '--topic=t', `--repo-root=${tmp}`, `--overlap-review=${okPath}`, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    const evs2 = fs.readFileSync(path.join(path.dirname(statePath('c')), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(evs2[0].type, 'bundle_created');
    assert.equal(evs2[1].type, 'overlap_review', 'a reseed does not push the review past second');

    // A predecessor that does not exist is refused BEFORE the bundle is created.
    const digest3 = JSON.parse(run(['runs', 'list', `--repo-root=${tmp}`]).stdout).inventory_sha256;
    fs.writeFileSync(okPath, JSON.stringify({ inventory_sha256: digest3, candidates: [], action: 'proceed' }));
    const badPred = run(['seed', `--state=${statePath('d')}`, '--slug=d', '--topic=t', `--repo-root=${tmp}`,
      `--overlap-review=${okPath}`, '--predecessor=no-such-run']);
    assert.notEqual(badPred.status, 0);
    assert.equal(fs.existsSync(statePath('d')), false, 'a link that cannot be made leaves no bundle behind');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the advertised seed command survives a shell, spaces and metacharacters included', () => {
  // A command that changes meaning when pasted is not a command. The rendered line is parsed
  // back with a POSIX-ish splitter and every argument must arrive intact.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-quote test-'));
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main', tmp]);
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 't@e.invalid']);
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmp, 'README.md'), '# r\n');
    execFileSync('git', ['-C', tmp, 'add', '-A']);
    execFileSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);

    // A bundle that owes a successor, with a reason carrying shell metacharacters.
    const bundleDir = path.join(tmp, 'docs', 'masterplan', 'owes');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'state.yml'),
      'schema_version: 8\nslug: owes\nstatus: in-progress\nphase: execute\ntasks: []\n');
    fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
      type: 'required_successor', ts: '2026-01-01T00:00:00Z', slug: 'the-successor',
      reason: "fix $(whoami) and `hostname` — it's urgent",
    })}\n`);

    const brief = JSON.parse(run(['resume-brief', `--repo-root=${tmp}`, '--porcelain']).stdout);
    const ob = brief.obligations.find((o) => o.slug === 'the-successor');
    assert.ok(ob, JSON.stringify(brief.obligations));
    const cmd = ob.seed_command;
    // No unquoted redirection or substitution can survive into a pasted command.
    assert.doesNotMatch(cmd, /--overlap-review=</, 'no placeholder carrying shell redirection');
    // The tmp dir name contains a space, so the paths must be quoted.
    assert.match(cmd, /'/, 'arguments carrying spaces are quoted');
    // Round-trip it through the shell itself: printf the args and check each survived.
    const parsed = execFileSync('sh', ['-c', `for a in ${cmd.replace(/^mp seed /, '')}; do printf '%s\\n' "$a"; done`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const byName = Object.fromEntries(parsed.map((a) => {
      const i = a.indexOf('=');
      return [a.slice(2, i), a.slice(i + 1)];
    }));
    assert.equal(byName['repo-root'], tmp, 'the repo path arrives intact, space and all');
    assert.equal(byName.topic, "fix $(whoami) and `hostname` — it's urgent", 'the topic is not evaluated');
    assert.equal(byName.slug, 'the-successor');
    assert.equal(byName.predecessor, 'owes');
    assert.ok(byName['overlap-review'].endsWith('.json'), byName['overlap-review']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('interview critic --unavailable records the unavailability instead of demanding a receipt', () => {
  const fx = seedInterviewBundle({ slug: 'cli-unavail' });
  try {
    // A critic result — available or not — is judged against the current draft, so the ledger
    // is driven to one first.
    const ok = (args) => {
      const r = run(['interview', ...args, `--state=${fx.statePath}`]);
      assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    };
    ok(['ask', '--id=Q1', '--round=1', '--kind=intent', '--text=what is this for?']);
    ok(['answer', '--id=Q1', '--text=to prove the deploy happened']);
    const intentFile = path.join(fx.tmp, 'intent.json');
    fs.writeFileSync(intentFile, JSON.stringify({
      why: 'runs archive without proving deployment',
      outcome: 'a run archives complete only when the thing is live',
      done_means: 'the live check passed',
      anti_goals: ['a green suite standing in for a deployment'],
    }));
    ok(['draft', `--file=${intentFile}`]);

    // A flag that is accepted but changes nothing is worse than an unknown one: it looks like
    // it worked. This asserts the LEDGER effect, not merely that the flag parses.
    const r = run(['interview', 'critic', `--state=${fx.statePath}`, '--unavailable', '--error=the lane timed out']);
    assert.equal(r.status, 0, r.stderr);
    const evs = fs.readFileSync(path.join(path.dirname(fx.statePath), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const unavailable = evs.find((e) => e.type === 'critic_unavailable');
    assert.ok(unavailable, `expected a critic_unavailable event, got ${JSON.stringify(evs.map((e) => e.type))}`);
    assert.match(unavailable.error, /timed out/);
    // ...and it did NOT demand the receipt/payload a real critic result needs.
    assert.equal(evs.some((e) => e.type === 'critic_receipt'), false);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Wave task 6: the CLI-surface matrix's remaining gaps.
//
// Covers the items the task names that earlier smoke rounds did not pin down:
//   - retired flags removed from the whitelist are rejected (not silently dropped);
//   - the black-box successor case: seeding with --predecessor whose finish recorded
//     an INTENT-class rejection carries the correction text in the seed record;
//   - an archived bundle with no completion field reads `legacy` in BOTH `runs list`
//     and `status` (never inferred from events);
//   - BOTH surfaces print an open required_successor obligation with the exact seed
//     command that discharges it;
//   - config show's recommendation is never below the configured threshold AND the
//     harness settings file is byte-identical after the call;
//   - `runs list` and `status` both print `pushed: no` for an archived bundle until an
//     archive_pushed event lands.
// ---------------------------------------------------------------------------

test('interview critic forwards the receipt and the payload onto the ledger and into the artifact', () => {
  // The §5.3 critic verdict is TWO artifacts: a validated receipt on the ledger AND the payload
  // copied verbatim beside the bundle. A critic verb that recorded one without the other would
  // look like it worked while losing half the evidence. This drives the REAL CLI and asserts
  // both durable effects — never a shape this test invented.
  const fx = seedInterviewBundle({ slug: 'cli-critic-fwd' });
  try {
    // A draft first: the critic judges the latest draft at the current content head.
    const ask = run(['interview', 'ask', `--state=${fx.statePath}`, '--id=Q1', '--round=1', '--kind=intent', '--text=what should this be?']);
    assert.equal(ask.status, 0, ask.stderr);
    const answer = run(['interview', 'answer', `--state=${fx.statePath}`, '--id=Q1', '--text=it should prove the deployment']);
    assert.equal(answer.status, 0, answer.stderr);
    const intent = { why: 'runs archive without proof', outcome: 'a run archives complete only when live', anti_goals: ['a green suite'], done_means: 'release and a live check' };
    const intentPath = path.join(fx.tmp, 'intent.json');
    fs.writeFileSync(intentPath, JSON.stringify(intent));
    const draft = run(['interview', 'draft', `--state=${fx.statePath}`, `--file=${intentPath}`]);
    assert.equal(draft.status, 0, draft.stderr);

    // The receipt the shell would build black-box: the status line names the content head, and
    // the draft sha is the hash of the recorded intent — the same way recordCritic computes it.
    const status = JSON.parse(run(['interview', 'status', `--state=${fx.statePath}`]).stdout);
    const ledger = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const draftEv = ledger.find((e) => e.type === 'interview_draft');
    assert.ok(draftEv, 'the draft is on the ledger');
    const payload = { unknowns: [], contradictions: [], misclassified: [] };
    const payloadPath = path.join(fx.tmp, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const receipt = {
      dispatch_id: 'cli-d1', model: 'cli-model', output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(draftEv.intent),
    };
    const receiptPath = path.join(fx.tmp, 'receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const critic = run(['interview', 'critic', `--state=${fx.statePath}`, `--receipt=${receiptPath}`, `--payload-file=${payloadPath}`]);
    assert.equal(critic.status, 0, critic.stderr);

    // Durable effect 1: the interview_critic event carries the receipt fields verbatim.
    const after = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ev = after.find((e) => e.type === 'interview_critic');
    assert.ok(ev, `expected an interview_critic event, got ${after.map((e) => e.type)}`);
    assert.equal(ev.dispatch_id, 'cli-d1');
    assert.equal(ev.model, 'cli-model');
    assert.equal(ev.output_tokens, 10);
    assert.equal(ev.content_head, status.content_head);
    assert.equal(ev.intent_sha256, intentSha(draftEv.intent));

    // Durable effect 2: the payload is copied verbatim beside the bundle, and its digest is on
    // the event — the artifact a later process (resume, the intent critic) reads.
    const artifact = path.join(fx.bundleDir, 'interview-critic-1.json');
    assert.ok(fs.existsSync(artifact), 'the payload artifact must be copied beside the bundle');
    assert.deepEqual(JSON.parse(fs.readFileSync(artifact, 'utf8')), payload);
    const expectedSha = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    assert.equal(ev.payload_sha256, expectedSha, 'the event binds the payload it stored');
  } finally {
    fx.cleanup();
  }
});

// Drive a goals_enabled run through the finish step machine via the CLI, recording the
// implementation and final goal checks through `mp record-goal-check` exactly as the shell
// would, returning { bundleDir, statePath, events, completion, head, gHash, ... }.
function walkCliToIntentRejected({ tmp, MAIN, WT, bundleDir, statePath, slug, gHash, headAtBuild }) {
  const S = `--state=${statePath}`;
  const step = (args = []) => JSON.parse(run(['finish-step', S, ...args]).stdout);
  // 1. run_verify
  let op = step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  // 2. --verify-passed -> the goal gate asks for the implementation assessment.
  op = step(['--verify-passed']);
  assert.equal(op.op, 'run_goal_check', JSON.stringify(op));
  assert.equal(op.goals_hash, gHash, 'the goal-check op names the current goals hash');
  // 3. record-goal-check (implementation receipt) through the CLI.
  const head = git(WT, 'rev-parse', 'HEAD');
  const implReceipt = {
    goals_hash: gHash, head_sha: head, base_diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo',
    clean: true,
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'the stage ran' },
      G2: { verdict: 'achieved', evidence: 'the live check gated the archive' },
      G3: { verdict: 'achieved', evidence: 'the operator was asked' },
    },
    dispatch_id: 'cli-impl', model: 'cli-assessor', output_tokens: 10, ts: '2026-01-01T00:00:00Z',
  };
  const impl = run(['record-goal-check', S, `--head-sha=${head}`, '--base=main', '--diff-hash=sha256:diff',
    '--verify-output-hash=sha256:vo', `--receipt=${JSON.stringify(implReceipt)}`]);
  assert.equal(impl.status, 0, impl.stderr);
  // 4. finish-step -> write_retro, then write the retro and step again.
  op = step();
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  // 6. --choice=merge -> the deploy stage: release then live_check.
  op = step(['--choice=merge']);
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'release', JSON.stringify(op));
  // 7. release step done (loose autonomy needs no authorize).
  op = step(['--deploy-step-done=release[0]', '--exit=0']);
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  // 8. live_check done with its evidence file.
  const digestFile = path.join(tmp, 'live-check.txt');
  fs.writeFileSync(digestFile, 'the live check observed the deployed surface\n');
  op = step(['--deploy-step-done=live_check[0]', '--exit=0', `--digest-file=${digestFile}`]);
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  assert.equal(op.deploy_base_sha, git(MAIN, 'rev-parse', 'HEAD'), 'the final check binds the merged base');
  assert.ok(op.deploy_chain_hash && op.live_digest, `the final check carries its chain+digest: ${JSON.stringify(op)}`);
  // 9. record the FINAL assessment through the CLI, binding the deploy tuple the recorder supplies.
  const finReceipt = {
    goals_hash: gHash, head_sha: headAtBuild, base_diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo',
    clean: true,
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'the stage ran' },
      G2: { verdict: 'achieved', evidence: 'the live check gated the archive' },
      G3: { verdict: 'achieved', evidence: 'the operator was asked' },
    },
    deploy_base_sha: op.deploy_base_sha, deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    dispatch_id: 'cli-fin', model: 'cli-assessor', output_tokens: 10, ts: '2026-01-01T00:00:00Z',
  };
  const fin = run(['record-goal-check', S, `--head-sha=${headAtBuild}`, '--base=main', '--diff-hash=sha256:diff',
    '--verify-output-hash=sha256:vo', '--final', `--base-sha=${op.deploy_base_sha}`,
    `--deploy-chain-hash=${op.deploy_chain_hash}`, `--digest-file=${digestFile}`, `--receipt=${JSON.stringify(finReceipt)}`]);
  assert.equal(fin.status, 0, fin.stderr);
  // 10. finish-step -> the intent_confirm gate.
  op = step();
  assert.equal(op.gate, 'intent_confirm', JSON.stringify(op));
  // 11. answer with an intent rejection naming the successor.
  op = step(['--intent-rejected', '--class=intent', '--reason=the operator wanted the deploy proven, not just the code merged', '--successor=succ']);
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  return { bundleDir, statePath, headAtBuild };
}

// A git repo with a masterplan bundle walked to an archived intent-rejected state via the CLI.
function cliIntentRejectedFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cliwalk-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  const gitCmd = (args) => execFileSync('git', ['-C', MAIN, ...args], { encoding: 'utf8' });
  gitCmd(['init', '-q', '--initial-branch=main']);
  gitCmd(['config', 'user.email', 'test@test']);
  gitCmd(['config', 'user.name', 'test']);
  gitCmd(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  fs.writeFileSync(path.join(MAIN, 'src', 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(MAIN, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(MAIN, '.masterplan.yaml'), DONE_YAML);
  gitCmd(['add', '.']);
  gitCmd(['commit', '-q', '-m', 'initial']);
  const slug = 'pred';
  const WT = path.join(MAIN, '.worktrees', slug);
  gitCmd(['worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT]);
  fs.writeFileSync(path.join(WT, 'src', 'a.txt'), 'A\n');
  execFileSync('git', ['-C', WT, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', WT, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'task 1'], { encoding: 'utf8' });
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true, autonomy: 'loose',
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  fs.writeFileSync(path.join(bundleDir, 'goals.md'), GOALS_MD);
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');
  // Satisfy the spec gate at the CURRENT spec+goals hash.
  const specHash = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    specHash.update(rel); specHash.update('\0');
    specHash.update(fs.readFileSync(path.join(bundleDir, rel))); specHash.update('\0');
  }
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: `sha256:${specHash.digest('hex')}`, count: 0, base: 'main' },
  })}\n`);
  const gHash = goalsHash(GOALS_MD);
  const headAtBuild = execFileSync('git', ['-C', WT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { tmp, MAIN, WT, bundleDir, statePath, slug, gHash, headAtBuild, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const GOALS_MD = [
  'topic: |', '  prove the deploy actually happened', '',
  '## Intent', 'why: runs archive without proving anything shipped',
  'outcome: a run archives complete only when the thing is live',
  'anti_goals: a green suite standing in for a deployment',
  'done_means: release and a live check', '',
  '## G1: the deploy stage runs', '## G2: the live check gates the archive', '## G3: the operator confirms intent', '',
].join('\n');

const DONE_YAML = 'done:\n  release:\n    - run: /bin/true\n  live_check:\n    - run: /bin/true\n      check: /bin/true\n';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}

test('record-goal-check --final forwards the deploy tuple into the goal_check event', () => {
  // The final assessment binds what was DEPLOYED: the merged base, the deploy-event chain, the
  // live-check digest and the intent verdict. A recorder that validated them but never WROTE
  // them would leave the machine's finalReceiptFor blind — the exact dead-forwarding defect the
  // reviewer found. This drives the CLI and asserts the event carries every binding, plus the
  // idempotency fence that separates a final check from the implementation check on the same
  // tuple.
  const GOALS = '## G1: Cover it\nsignal: test\n\n## G2: Flag it\nsignal: command\n';
  const GH = goalsHash(GOALS);
  const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), DIFF = 'sha256:diff-1', VOUT = 'sha256:verify-1';
  const DEPLOY_BASE = 'd'.repeat(40), CHAIN = 'sha256:deploy-chain';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gcfin-'));
  try {
    const dir = path.join(tmp, 'docs', 'masterplan', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, 'state.yml');
    fs.writeFileSync(statePath, [
      'schema_version: 8', 'slug: demo', 'status: active', 'phase: execute',
      'goals_enabled: true', `goals_md_hash: ${GH}`, 'pending_gate: null', 'active_run: null', 'tasks: []', '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'goals.md'), GOALS);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    // --digest-file names the file the live check wrote; the binding is the digest of its CONTENT.
    const liveFile = path.join(tmp, 'live.txt');
    fs.writeFileSync(liveFile, 'the live check observed the deployed surface\n');
    const LIVE = liveCheckDigest(liveFile);
    const receipt = (over = {}) => JSON.stringify({
      goals_hash: GH, head_sha: HEAD, base_diff_hash: DIFF, verify_output_hash: VOUT, clean: true,
      verdicts: {
        G1: { verdict: 'achieved', evidence: 'the suite passes' },
        G2: { verdict: 'achieved', evidence: 'the flag is wired' },
      },
      dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256, ts: '2026-07-01T00:00:00Z',
      ...over,
    });
    const S = `--state=${statePath}`;
    const baseFlags = [`--head-sha=${HEAD}`, `--base=${BASE}`, `--diff-hash=${DIFF}`, `--verify-output-hash=${VOUT}`];
    const r = run(['record-goal-check', ...baseFlags, S, '--final',
      `--base-sha=${DEPLOY_BASE}`, `--deploy-chain-hash=${CHAIN}`, `--digest-file=${liveFile}`,
      `--receipt=${receipt({
        deploy_base_sha: DEPLOY_BASE, deploy_chain_hash: CHAIN, live_check_digest: LIVE,
        intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
      })}`]);
    assert.equal(r.status, 0, r.stderr);
    const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const gc = evs.find((e) => e.type === 'goal_check');
    assert.ok(gc, `expected a goal_check event, got ${evs.map((e) => e.type)}`);
    assert.equal(gc.data.final, true, 'the event is marked final');
    assert.equal(gc.data.deploy_base_sha, DEPLOY_BASE, 'the merged base is bound');
    assert.equal(gc.data.deploy_chain_hash, CHAIN, 'the deploy-event chain is bound');
    assert.equal(gc.data.live_check_digest, LIVE, 'the live-check digest is bound');
    assert.deepEqual(gc.data.intent_verdict, { verdict: 'met', evidence: 'the deployed surface answers as intended' });

    // Idempotency: a repeat on the SAME tuple is skipped, and the event count stays at one — the
    // same recording on the same tuple must not double-append (re-entry guard).
    const repeat = run(['record-goal-check', ...baseFlags, S, '--final',
      `--base-sha=${DEPLOY_BASE}`, `--deploy-chain-hash=${CHAIN}`, `--digest-file=${liveFile}`,
      `--receipt=${receipt({
        deploy_base_sha: DEPLOY_BASE, deploy_chain_hash: CHAIN, live_check_digest: LIVE,
        intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
      })}`]);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).record_goal_check, 'idempotent');
    assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1,
      'a repeated final check on the same tuple is a no-op');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reindex-plan with only --state reads the bundle\'s stored plan_index_path', () => {
  // reindex-plan's plan-index defaults from the BUNDLE when no --plan-index is given: the
  // recorded plan_index_path, else the conventional sibling. A verb that defaulted to the
  // sibling would restamp the WRONG file when a bundle records its own index elsewhere — the
  // exact divergence the default exists to prevent. This proves the stored path wins by putting
  // a DIFFERENT index beside state.yml and asserting only the stored one is restamped.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reidx-'));
  try {
    const dir = path.join(tmp, 'docs', 'masterplan', 'r');
    fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, 'state.yml');
    const storedIndex = path.join(tmp, 'stored-index.json');
    const siblingIndex = path.join(dir, 'plan.index.json');
    const planMd = path.join(tmp, 'plan.md');
    const oldHash = 'sha256:' + createHash('sha256').update('# plan v1\n').digest('hex');
    const newHash = 'sha256:' + createHash('sha256').update('# plan v2\n').digest('hex');
    fs.writeFileSync(storedIndex, JSON.stringify({ schema_version: 2, plan_hash: oldHash, tasks: [] }));
    // A DIFFERENT hash in the sibling: if reindex-plan defaulted there, it would restamp THIS file.
    fs.writeFileSync(siblingIndex, JSON.stringify({ schema_version: 2, plan_hash: 'sha256:deadbeef', tasks: [] }));
    fs.writeFileSync(statePath, [
      'schema_version: 8', 'slug: r', 'status: in-progress', 'phase: plan',
      `plan_index_path: ${storedIndex}`, `plan_path: ${planMd}`,
      'pending_gate: null', 'active_run: null', 'tasks: []', '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    fs.writeFileSync(planMd, '# plan v2\n');

    const r = run(['reindex-plan', `--state=${statePath}`, `--plan=${planMd}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).path, storedIndex, 'the verb restamped the STORED index');
    const storedAfter = JSON.parse(fs.readFileSync(storedIndex, 'utf8'));
    assert.equal(storedAfter.plan_hash, newHash, 'the stored index carries the fresh hash');
    const siblingAfter = JSON.parse(fs.readFileSync(siblingIndex, 'utf8'));
    assert.equal(siblingAfter.plan_hash, 'sha256:deadbeef', 'the conventional sibling was NOT touched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('the black-box successor case: an intent-rejected predecessor seeds the correction into the successor', () => {
  // §7.5: a successor seeded from a run rejected on INTENT starts from that rejection. The
  // class and the operator's correction text are projected into the NEW bundle's seed record
  // (and ledger), so the interview opens holding what went wrong rather than asking the
  // operator to remember it.
  //
  // This is the REAL flow, not a hand-written fixture: the predecessor is a git repo driven
  // through the actual CLI (finish-step + record-goal-check) to an archived
  // intent_rejected:intent state, and the successor is seeded with --predecessor=pred. The
  // projection is read off the ledger the CLI actually wrote.
  const fx = cliIntentRejectedFixture();
  try {
    // Walk the predecessor through the CLI to the archived intent rejection.
    walkCliToIntentRejected(fx);

    // The CLI walk left the REAL authorization on the ledger, with the correction text.
    const predEvents = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const auth = predEvents.find((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected'));
    assert.ok(auth, `the CLI walk wrote an intent rejection: ${predEvents.map((e) => e.type)}`);
    assert.equal(auth.class, 'intent');
    assert.match(auth.correction, /deploy proven/);

    // Seed the successor from that real ledger.
    const succPath = path.join(fx.MAIN, 'docs', 'masterplan', 'succ', 'state.yml');
    const digest = JSON.parse(run(['runs', 'list', `--repo-root=${fx.MAIN}`]).stdout).inventory_sha256;
    const reviewPath = path.join(fx.tmp, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({ inventory_sha256: digest, candidates: [], action: 'proceed' }));
    const r = run(['seed', `--state=${succPath}`, '--slug=succ', '--topic=the successor run',
      '--predecessor=pred', `--repo-root=${fx.MAIN}`, `--overlap-review=${reviewPath}`, '--session=mp-w6-seed']);
    assert.equal(r.status, 0, r.stderr);

    // seed prints the refs op, then its own record; the seed record is the last line.
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const parsed = JSON.parse(lines.at(-1));
    assert.ok(parsed.predecessor_rejection, `expected a projection: ${r.stdout}`);
    assert.equal(parsed.predecessor_rejection.class, 'intent');
    assert.match(parsed.predecessor_rejection.correction, /deploy proven/);

    // The projection is durable — it lands in the successor's own ledger, not just stdout.
    const evs = fs.readFileSync(path.join(path.dirname(succPath), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const projected = evs.find((e) => e.type === 'predecessor_rejection');
    assert.ok(projected, 'the projection is durable, not just printed');
    assert.equal(projected.predecessor, 'pred');
    assert.equal(projected.class, 'intent');
    assert.match(projected.correction, /deploy proven/);
  } finally {
    fx.cleanup();
  }
});

test('an archived bundle with no completion field reads legacy in runs list AND status', () => {
  // A bundle archived before the field existed must read `legacy` everywhere it is reported —
  // never `complete` inferred from a green ledger, and never `null`/absent in one surface but
  // filled in the other. runs list and status must AGREE.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-legacy2-'));
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main', tmp]);
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 't@e.invalid']);
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmp, 'README.md'), '# r\n');
    execFileSync('git', ['-C', tmp, 'add', '-A']);
    execFileSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);

    const dir = path.join(tmp, 'docs', 'masterplan', 'arch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.yml'),
      'schema_version: 8\nslug: arch\nstatus: archived\nphase: execute\ntasks: []\n');
    // A ledger that LOOKS complete — but the run never recorded a completion class.
    fs.writeFileSync(path.join(dir, 'events.jsonl'),
      `${JSON.stringify({ type: 'archive_pushed', ts: '2026-01-01T00:00:00Z', sha: 'abc' })}\n`);

    const inList = JSON.parse(run(['runs', 'list', `--repo-root=${tmp}`]).stdout)
      .runs.find((r) => r.slug === 'arch');
    assert.ok(inList, 'the archived bundle appears in runs list');
    assert.equal(inList.completion_class, 'legacy');

    const inStatus = JSON.parse(run(['status', `--state=${dir}/state.yml`]).stdout);
    assert.equal(inStatus.completion_class, 'legacy');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runs list and status both print pushed: no until archive_pushed lands', () => {
  // A locally-complete run is not visible to another host or to GitHub's doctor; reporting
  // `pushed: yes` before the archive_pushed event would claim a visibility it lacks. BOTH
  // surfaces must agree, before AND after the event.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pushed-'));
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main', tmp]);
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 't@e.invalid']);
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmp, 'README.md'), '# r\n');
    execFileSync('git', ['-C', tmp, 'add', '-A']);
    execFileSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);

    const dir = path.join(tmp, 'docs', 'masterplan', 'arch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.yml'),
      'schema_version: 8\nslug: arch\nstatus: archived\nphase: execute\ntasks: []\n');
    const evPath = path.join(dir, 'events.jsonl');
    fs.writeFileSync(evPath, '');

    const pushedInList = () => JSON.parse(run(['runs', 'list', `--repo-root=${tmp}`]).stdout)
      .runs.find((r) => r.slug === 'arch').pushed;
    const pushedInStatus = () => JSON.parse(run(['status', `--state=${dir}/state.yml`]).stdout).pushed;

    assert.equal(pushedInList(), 'no', 'runs list: pushed: no before the event');
    assert.equal(pushedInStatus(), 'no', 'status: pushed: no before the event');

    fs.appendFileSync(evPath, `${JSON.stringify({ type: 'archive_pushed', ts: '2026-01-01T00:00:00Z', sha: 'abc' })}\n`);

    assert.equal(pushedInList(), 'yes', 'runs list: pushed: yes after the event');
    assert.equal(pushedInStatus(), 'yes', 'status: pushed: yes after the event');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runs list and status print an open required_successor obligation with the exact seed command', () => {
  // A run that still owes a successor must not be readable as finished. BOTH reporting
  // surfaces carry the obligation AND the exact `mp seed` command that discharges it — the
  // same runnable form the resume-brief surface guarantees.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-oblig2-'));
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main', tmp]);
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 't@e.invalid']);
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmp, 'README.md'), '# r\n');
    execFileSync('git', ['-C', tmp, 'add', '-A']);
    execFileSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);

    const dir = path.join(tmp, 'docs', 'masterplan', 'owes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.yml'),
      'schema_version: 8\nslug: owes\nstatus: in-progress\nphase: execute\ntasks: []\n');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({
      type: 'required_successor', ts: '2026-01-01T00:00:00Z', slug: 'the-successor', reason: 'handoff',
    })}\n`);

    const fromList = JSON.parse(run(['runs', 'list', `--repo-root=${tmp}`]).stdout).obligations;
    const obList = fromList.find((o) => o.slug === 'the-successor');
    assert.ok(obList, `runs list must print the obligation: ${JSON.stringify(fromList)}`);
    assert.equal(obList.source, 'owes');
    assert.equal(obList.reason, 'handoff');
    assert.match(obList.seed_command, /^mp seed /);
    for (const required of ['--state=', '--slug=the-successor', '--topic=', '--repo-root=', '--predecessor=owes', '--overlap-review=']) {
      assert.ok(obList.seed_command.includes(required), `${required} missing from runs list command: ${obList.seed_command}`);
    }

    const fromStatus = JSON.parse(run(['status', `--state=${dir}/state.yml`]).stdout).obligations;
    const obStatus = fromStatus.find((o) => o.slug === 'the-successor');
    assert.ok(obStatus, `status must print the obligation: ${JSON.stringify(fromStatus)}`);
    assert.equal(obStatus.seed_command, obList.seed_command, 'both surfaces print the SAME exact command');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('config show leaves a pre-existing harness settings file byte-identical', () => {
  // config show is read-only: it must REPORT the harness window, never modify the settings
  // file it reads. The never-writes test covers the absent-file case; this one covers the
  // stronger case where a real settings file exists and must survive the call byte-for-byte.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cfg-bytes-'));
  try {
    const settings = path.join(dir, 'settings.json');
    const original = '{"autoCompactWindow": 42, "other": "keep me exactly"}';
    fs.writeFileSync(settings, original);

    const r = run(['config', 'show', `--repo-root=${REPO}`], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.harness.readable, true);
    assert.equal(parsed.harness.autoCompactWindow, 42);
    // Byte-identical: not just re-serialized, the ORIGINAL bytes.
    assert.equal(fs.readFileSync(settings, 'utf8'), original, 'config show must not rewrite the settings file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
