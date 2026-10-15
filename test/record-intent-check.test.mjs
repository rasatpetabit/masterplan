// test/goals-record-check.test.mjs — the `record-intent-check` bin verb (anti-fabrication
// FINAL Intent-assessment recorder; renamed from `record-goal-check --final`, whose wire
// event name `goal_check` with `final: true` it keeps). Spawns the real CLI over temp
// bundles. Branch facts are NEVER caller-supplied: the recorder reads the ledger's
// independently recorded binding source (the verify_passed event, or a legacy
// implementation goal_check) and the receipt must echo THOSE; the Intent hash is recomputed
// from goals.md under the durable format pin; the deploy tuple comes from the recorder's
// own flags and the --digest-file evidence.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const GOALS_MD = 'topic: cover the widget\n\n## Intent\nwhy: the widget needs covering\noutcome: the widget ships covered\ndone_means: release\n';
const G_HASH = goalsHash(GOALS_MD);
const HEAD = 'a'.repeat(40);
const BASE = 'main';
const DIFF = 'sha256:diff-1';
const VOUT = 'sha256:verify-1';
const DEPLOY_BASE = 'd'.repeat(40);
const CHAIN = 'sha256:deploy-chain';

// The binding-source record the ledger carries (a verify_passed written by the finish
// machinery; the generic `mp event` writer refuses the type, so the fixture writes the line
// exactly as appendEvent would).
function verifyPassedEvent({ head = HEAD, base = BASE, diffHash = DIFF, vout = VOUT } = {}) {
  return {
    type: 'verify_passed',
    ts: '2026-01-01T00:00:00Z',
    data: {
      head_sha: head,
      base,
      diff_hash: diffHash,
      ...(vout ? { verify_output_hash: vout } : {}),
    },
  };
}

// The retirement record the real flow always carries by final-assessment time (the deploy
// stage follows branch_finish): its branch_tip IS the finish HEAD every binding selection
// resolves through (resolveFinishHead).
function branchFinishEvent({ tip = HEAD } = {}) {
  return { type: 'branch_finish', ts: '2026-01-01T00:00:00Z', note: 'merge', branch_tip: tip };
}

// Build a goals_enabled bundle on disk, optionally seeded with a binding source and the
// retirement record that fixes the finish HEAD.
function makeBundle({ binding = verifyPassedEvent(), retire = branchFinishEvent() } = {}) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-gcheck-'));
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(
    statePath,
    serializeState({ schema_version: 8, slug: 'demo', status: 'active', phase: 'execute', goals_enabled: true, goals_md_hash: G_HASH })
  );
  fs.writeFileSync(path.join(dir, 'goals.md'), GOALS_MD);
  if (binding) fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(binding)}\n`);
  if (retire) fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(retire)}\n`);
  return { dir, statePath, eventsPath: path.join(dir, 'events.jsonl') };
}

function events(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const countEvents = (eventsPath, type) => events(eventsPath).filter((e) => e.type === type).length;

// The live-check evidence file, digested exactly as the recorder does.
const LIVE_FILE = path.join(os.tmpdir(), `mp-icheck-live-${process.pid}.txt`);
fs.writeFileSync(LIVE_FILE, 'the live check observed the deployed surface\n');
after(() => { try { fs.rmSync(LIVE_FILE, { force: true }); } catch { /* gone */ } });

// A valid final receipt echoing the binding source and the recorder-supplied deploy tuple.
function finalReceipt({ head = HEAD, diff = DIFF, vout = VOUT, over = {} } = {}) {
  return {
    goals_hash: G_HASH,
    head_sha: head,
    base_diff_hash: diff,
    verify_output_hash: vout,
    clean: true,
    deploy_base_sha: DEPLOY_BASE,
    deploy_chain_hash: CHAIN,
    live_check_digest: liveDigestOf(LIVE_FILE),
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    dispatch_id: 'disp-final-1',
    model: 'assessor',
    output_tokens: 256,
    ts: '2026-07-01T00:00:00Z',
    ...over,
  };
}

// liveCheckDigest is lib-internal; compute the same sha256 over the file bytes.
import { createHash } from 'node:crypto';
function liveDigestOf(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

const baseFlags = (statePath) => [
  `--state=${statePath}`,
  `--base-sha=${DEPLOY_BASE}`,
  `--deploy-chain-hash=${CHAIN}`,
  `--digest-file=${LIVE_FILE}`,
];

test('a receipt echoing the ledger binding records a final goal_check; re-entry is idempotent', () => {
  const b = makeBundle();
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt())}`]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.recorded, 'goal_check');
  assert.equal(parsed.mode, 'final');
  assert.equal(parsed.provenance_kind, 'assessor');
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 1);
  // The event keeps the historical wire name and carries final: true + the intent verdict.
  const ev = events(b.eventsPath).find((e) => e.type === 'goal_check');
  assert.equal(ev.data.final, true);
  assert.equal(ev.data.intent_verdict.verdict, 'met');
  assert.equal(ev.data.head_sha, HEAD, 'the binding source head is what the event records');

  // Re-entry at the SAME tuple: idempotent skip, no double-append.
  const r2 = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt())}`]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).record_intent_check, 'idempotent');
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 1);
});

test('REFUSES with no binding source on the ledger — the receipt cannot validate its own branch facts', () => {
  const b = makeBundle({ binding: null });
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt())}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no verify_passed/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});

test('a receipt whose branch facts do not echo the binding source is rejected', () => {
  // A verify_passed whose head moved (a later commit): the receipt still pinned to the OLD
  // head → rejected. With the finish head fixed by the retirement record (tip = HEAD), the
  // only binding is for another head, so selection itself refuses, naming the finish head.
  const b = makeBundle({ binding: verifyPassedEvent({ head: 'c'.repeat(40) }) });
  const stale = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt({ head: HEAD }))}`]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /finish head/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);

  // A claimed verify output hash that is not the recorded one → rejected.
  const b2 = makeBundle();
  const vout = run(['record-intent-check', ...baseFlags(b2.statePath), `--receipt=${JSON.stringify(finalReceipt({ vout: 'sha256:STALE' }))}`]);
  assert.notEqual(vout.status, 0);
  assert.match(vout.stderr, /verify_output_hash/);
  assert.equal(countEvents(b2.eventsPath, 'goal_check'), 0);
});

test('a verify_passed binding with NO verify_output_hash is an incomplete binding and is refused; a legacy goal_check keeps the non-empty rule', () => {
  // finish-bindings-2: every pass answer records the hashed --verify-output evidence, so a
  // verify_passed without one is incomplete — never a looser non-empty rule for the receipt.
  // It is not a binding source at all (finish-step re-arms verification to repair it before
  // teardown), so the recorder refuses for want of a binding for the finish head.
  const b = makeBundle({ binding: verifyPassedEvent({ vout: null }) });
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt({ vout: 'sha256:any-nonempty' }))}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no verify_passed .* bound to the finish head/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
  // A LEGACY implementation goal_check binding keeps the hash it recorded — the legacy
  // recorder accepted an optional --verify-output-hash, so absent there the receipt owes
  // only a non-empty string (in-flight bundles, unchanged contract).
  const legacyNoVout = {
    type: 'goal_check', ts: '2026-01-01T00:00:00Z',
    data: { goals_hash: 'sha256:older-doc', head_sha: HEAD, base: BASE, diff_hash: DIFF, provenance_kind: 'assessor' },
  };
  const b2 = makeBundle({ binding: legacyNoVout });
  const r2 = run(['record-intent-check', ...baseFlags(b2.statePath), `--receipt=${JSON.stringify(finalReceipt({ vout: 'sha256:any-nonempty' }))}`]);
  assert.equal(r2.status, 0, r2.stderr);
});

test('a LEGACY implementation goal_check is an acceptable binding source (in-flight bundles)', () => {
  const legacyBinding = {
    type: 'goal_check', ts: '2026-01-01T00:00:00Z',
    data: {
      goals_hash: 'sha256:older-doc', head_sha: HEAD, base: BASE,
      diff_hash: DIFF, verify_output_hash: VOUT, provenance_kind: 'assessor',
      verdicts: { G1: { verdict: 'achieved', evidence: 'e' } },
    },
  };
  const b = makeBundle({ binding: legacyBinding });
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt())}`]);
  assert.equal(r.status, 0, r.stderr);
  const ev = events(b.eventsPath).filter((e) => e.type === 'goal_check');
  assert.equal(ev.length, 2, 'the legacy receipt and the new final receipt');
  assert.equal(ev[1].data.final, true);
  // ...and verify_passed is preferred over a legacy check when BOTH match the finish HEAD:
  // the receipt must echo the verify_passed's facts, not the legacy receipt's.
  const b2 = makeBundle({ binding: null });
  fs.appendFileSync(b2.eventsPath, `${JSON.stringify(legacyBinding)}\n`);
  fs.appendFileSync(b2.eventsPath, `${JSON.stringify(verifyPassedEvent({ diffHash: 'sha256:diff-vp' }))}\n`);
  fs.appendFileSync(b2.eventsPath, `${JSON.stringify(branchFinishEvent())}\n`);
  const mixed = run(['record-intent-check', ...baseFlags(b2.statePath), `--receipt=${JSON.stringify(finalReceipt({ diff: DIFF }))}`]);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /base_diff_hash/);
  assert.equal(countEvents(b2.eventsPath, 'goal_check'), 1, 'only the pre-seeded legacy receipt');
  const echoVp = run(['record-intent-check', ...baseFlags(b2.statePath), `--receipt=${JSON.stringify(finalReceipt({ diff: 'sha256:diff-vp' }))}`]);
  assert.equal(echoVp.status, 0, echoVp.stderr);
});

test('the binding is selected FOR THE FINISH HEAD — a verify_passed for another head is not selected', () => {
  // finish-bindings-1: the run verified at A, moved to B (a second verify_passed), and
  // retired at A. The retirement record's branch_tip (A) is the finish HEAD, so the latest
  // event regardless of HEAD (B's) must NOT be the binding the receipt echoes.
  const b = makeBundle({
    binding: verifyPassedEvent({ head: HEAD }),
    retire: branchFinishEvent({ tip: HEAD }),
  });
  fs.appendFileSync(b.eventsPath, `${JSON.stringify(verifyPassedEvent({ head: 'b'.repeat(40), diffHash: 'sha256:diff-b' }))}\n`);
  // A receipt echoing B's (latest) facts is refused; one echoing A's records cleanly.
  const bFacts = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt({ head: 'b'.repeat(40), diff: 'sha256:diff-b' }))}`]);
  assert.notEqual(bFacts.status, 0);
  assert.match(bFacts.stderr, /head_sha/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
  const aFacts = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt())}`]);
  assert.equal(aFacts.status, 0, aFacts.stderr);
});

test('a legacy receipt carrying a per-goal verdict table is tolerated (verdicts are inert)', () => {
  const b = makeBundle();
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt({
    over: { verdicts: { G1: { verdict: 'achieved', evidence: 'historical' } } },
  }))}`]);
  assert.equal(r.status, 0, r.stderr);
  const ev = events(b.eventsPath).find((e) => e.type === 'goal_check');
  assert.equal(ev.data.intent_verdict.verdict, 'met', 'the intent verdict is the assessment');
});

test('the intent verdict and deploy bindings are validated, not trusted', () => {
  const b = makeBundle();
  const bad = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt({
    over: { intent_verdict: { verdict: 'yes-ish', evidence: 'e' } },
  }))}`]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /intent_verdict/);

  const b2 = makeBundle();
  const foreign = run(['record-intent-check', ...baseFlags(b2.statePath), `--receipt=${JSON.stringify(finalReceipt({
    over: { deploy_base_sha: `${DEPLOY_BASE}-tampered` },
  }))}`]);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /deploy_base_sha/);
});

test('user-attested (manual) receipt records with provenance_kind=user', () => {
  const b = makeBundle();
  const receipt = {
    ...finalReceipt(),
    attested_by: 'user',
    approval_receipt: {
      attested_by: 'user',
      purpose: 'goal_check',
      goals_hash: G_HASH,
      question: 'Attest this verdict?',
      answer: 'yes',
      ts: '2026-07-01T00:00:00Z',
    },
  };
  delete receipt.dispatch_id;
  delete receipt.model;
  delete receipt.output_tokens;
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(receipt)}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).provenance_kind, 'user');
  const line = events(b.eventsPath).find((e) => e.type === 'goal_check');
  assert.equal(line.data.provenance_kind, 'user');
  assert.equal(line.data.provenance.attested_by, 'user');
});

test('a receipt with neither assessor provenance nor attestation records no event', () => {
  const b = makeBundle();
  const receipt = finalReceipt();
  delete receipt.dispatch_id;
  delete receipt.model;
  delete receipt.output_tokens;
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(receipt)}`]);
  assert.notEqual(r.status, 0);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});

test('a stale Intent hash is rejected (any Intent amendment re-arms)', () => {
  const b = makeBundle();
  const r = run(['record-intent-check', ...baseFlags(b.statePath), `--receipt=${JSON.stringify(finalReceipt({
    over: { goals_hash: 'sha256:' + 'f'.repeat(64) },
  }))}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /goals_hash/);
  assert.equal(countEvents(b.eventsPath, 'goal_check'), 0);
});
