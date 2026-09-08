// test/goals-hash-versioning.test.mjs — Task 51: versioned hash coverage and the durable
// format pin (§6.1).
//
// The pin selects the canonicalizer: legacy for a v1 document (byte-identical hashes to the
// pre-versioning canonicalizer — no in-flight receipt is voided), the richer full-coverage
// one for a versioned document (every section body, plan context, reconciliation, schema
// digest, and source-evidence provenance). The pin is durable bundle state (state.yml
// format_pin), never derived from the document; a missing pin with a capture event refuses
// to parse as legacy and is repaired from that history; stripping the representation from
// a schema_backed bundle is a rejected downgrade; duplicate fields in the canonical JSON are
// rejected, never collapsed last-wins; equivalent object key ordering does not move the hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGoals,
  goalsHash,
  encodeIntentBlock,
  decodeIntent,
  validateIntentBinding,
  INTENT_CODEC_VERSION,
} from '../lib/goals.mjs';
import {
  buildSeedState,
  writeState,
  appendEvent,
  readState,
  resolveFormatPin,
  repairFormatPin,
} from '../lib/bundle.mjs';

const SCHEMA = { identity: 'design-intent@fixture', format_version: 1 };

function fixtureAuthoritative(patch = {}) {
  const base = {
    version: INTENT_CODEC_VERSION,
    schema: SCHEMA,
    sections: {
      purpose: { body: 'Round-trip the versioned hash coverage.\nSecond paragraph.' },
      non_goals: { items: ['no second resolver'] },
      top_invariant: { body: 'Legacy hashes are byte-stable.' },
      direction: { body: 'One pin, every consumer.' },
      posture: { body: 'Refuse downgrades loudly.' },
    },
    context: {
      outcome: { body: 'The richer hash covers everything.' },
      done_means: { body: 'release' },
    },
    evidence: [{ section: 'purpose', source: 'operator interview 2026-09-06' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  };
  return {
    ...base,
    ...patch, // top-level: schema, evidence, reconciliation replace wholesale
    sections: { ...base.sections, ...(patch.sections || {}) },
    context: { ...base.context, ...(patch.context || {}) },
  };
}

function versionedDoc(a) {
  const enc = encodeIntentBlock(a);
  assert.ok(enc.ok, JSON.stringify(enc));
  return `topic: |\n  Versioned fixture.\n${enc.block}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
}

// ---- legacy flavor: byte-identical to the pre-versioning canonicalizer --------------

test('legacy documents hash byte-identically with or without the legacy pin', () => {
  const A = 'topic: Ship the widget\n## G1: It works\nsignal: test\nevidence: npm test\n';
  const B = 'topic: |\n  Do the thing.\n## Intent\nwhy: because users need it\noutcome: the feature ships\nanti_goals:\n- no new deps\n- no UI rewrite\ndone_means: release\n\n## G1: Works\n## G2: Fast\n## G3: Documented\n';
  // Literals captured from the pre-versioning canonicalizer (test/design-intent-adapter.test.mjs).
  assert.equal(goalsHash(A), 'sha256:4518f972c0bffe5ca9518cf85c9fd3003b6b993be9423dfe69a8049cfea3d237');
  assert.equal(goalsHash(B), 'sha256:1f7d8db4971fe6648f3b71b84c6a59dd92803ed2d2aa7126ca63d4cf10836f06');
  assert.equal(goalsHash(A, {}), goalsHash(A));
  assert.equal(goalsHash(A, { formatPin: 'legacy' }), goalsHash(A));
});

test('an unknown pin value is refused, never guessed', () => {
  assert.throws(() => goalsHash('topic: x\n## G1: y\n', { formatPin: 'v3-neither' }), /unknown format pin/);
});

// ---- richer flavor: full-coverage hashing ---------------------------------------------

test('the richer hash covers every section body, context, reconciliation, and schema', () => {
  const base = versionedDoc(fixtureAuthoritative());
  const h0 = goalsHash(base, { formatPin: 'schema_backed' });
  assert.match(h0, /^sha256:[0-9a-f]{64}$/);
  // A section-body edit moves the hash:
  const hDirection = goalsHash(versionedDoc(fixtureAuthoritative({ sections: { direction: { body: 'CHANGED direction text.' } } })), { formatPin: 'schema_backed' });
  assert.notEqual(hDirection, h0);
  // A context (plan) edit moves it:
  const hOutcome = goalsHash(versionedDoc(fixtureAuthoritative({ context: { outcome: { body: 'CHANGED outcome.' } } })), { formatPin: 'schema_backed' });
  assert.notEqual(hOutcome, h0);
  // A reconciliation edit moves it:
  const hRecon = goalsHash(versionedDoc(fixtureAuthoritative({ reconciliation: [{ target: 'repository INTENT.md §1', status: 'drifted' }] })), { formatPin: 'schema_backed' });
  assert.notEqual(hRecon, h0);
  // A schema-identity edit moves it (the schema digest is covered):
  const hSchema = goalsHash(versionedDoc(fixtureAuthoritative({ schema: { identity: 'design-intent@v2', format_version: 1 } })), { formatPin: 'schema_backed' });
  assert.notEqual(hSchema, h0);
});

test('a provenance edit invalidates: evidence rows are covered by the richer hash', () => {
  const h0 = goalsHash(versionedDoc(fixtureAuthoritative()), { formatPin: 'schema_backed' });
  const hEvidence = goalsHash(
    versionedDoc(fixtureAuthoritative({ evidence: [{ section: 'purpose', source: 'operator interview 2026-09-07' }] })),
    { formatPin: 'schema_backed' },
  );
  assert.notEqual(hEvidence, h0, 'source-evidence provenance must be covered (§6.1: a provenance edit invalidates the receipts bound to it)');
});

test('equivalent object key ordering does not move the richer hash; real edits do', () => {
  const a = fixtureAuthoritative();
  // Same content, different literal key order in sections/context construction:
  const b = {
    version: INTENT_CODEC_VERSION,
    schema: a.schema,
    context: { done_means: a.context.done_means, outcome: a.context.outcome },
    reconciliation: a.reconciliation,
    evidence: a.evidence,
    sections: {
      posture: a.sections.posture,
      direction: a.sections.direction,
      top_invariant: a.sections.top_invariant,
      non_goals: a.sections.non_goals,
      purpose: a.sections.purpose,
    },
  };
  const hA = goalsHash(versionedDoc(a), { formatPin: 'schema_backed' });
  const hB = goalsHash(versionedDoc(b), { formatPin: 'schema_backed' });
  assert.equal(hB, hA, 'canonical key order is fixed — literal order must not matter');
  // And a goals edit still moves it (the native goals remain covered):
  const docWithExtraGoal = versionedDoc(a).replace('## G3: Documented', '## G3: Documented even more thoroughly');
  assert.notEqual(goalsHash(docWithExtraGoal, { formatPin: 'schema_backed' }), hA);
});

test('the richer path needs the document text, not a pre-parsed object', () => {
  const doc = versionedDoc(fixtureAuthoritative());
  const parsed = parseGoals(doc);
  assert.throws(() => goalsHash(parsed, { formatPin: 'schema_backed' }), /needs the DOCUMENT TEXT/);
});

// ---- downgrade + malformed refusal ------------------------------------------------------

test('stripping the representation from a schema_backed bundle is a rejected downgrade', () => {
  const legacyOnly = 'topic: |\n  Do the thing.\n## Intent\nwhy: because\noutcome: ships\nanti_goals:\n- no deps\ndone_means: release\n\n## G1: Works\n## G2: Fast\n## G3: Documented\n';
  assert.throws(
    () => goalsHash(legacyOnly, { formatPin: 'schema_backed' }),
    /downgrade refused/,
  );
  // Same for a doc with no Intent block at all:
  assert.throws(
    () => goalsHash('topic: x\n## G1: y\n', { formatPin: 'schema_backed' }),
    /downgrade refused/,
  );
});

test('a malformed versioned document under the schema_backed pin fails the hash loudly', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const broken = enc.block.replace('"version": 1', '"version": 9');
  const doc = `topic: |\n  Fixture.\n${broken}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  assert.throws(() => goalsHash(doc, { formatPin: 'schema_backed' }), /unknown intent codec version 9/);
});

test('duplicate fields in the canonical JSON are rejected, never collapsed last-wins', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const jsonStart = enc.block.indexOf('{');
  const jsonEnd = enc.block.lastIndexOf('}') + 1;
  const dup = enc.block.slice(0, jsonStart) + '{"version":1,"schema":{"identity":"x","format_version":1},"schema":{"identity":"y","format_version":1},' +
    enc.block.slice(jsonStart).replace(/^\{/, '');
  const doc = `topic: |\n  Fixture.\n${dup}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  const dec = decodeIntent(doc);
  assert.equal(dec.versioned, true);
  assert.match(dec.error, /duplicate field "schema"/);
  assert.throws(() => goalsHash(doc, { formatPin: 'schema_backed' }), /duplicate field "schema"/);
  // A nested duplicate section field is rejected too (whitespace-flexible surgery: the
  // canonical JSON is pretty-printed, so match the entry structurally, not by exact bytes):
  const nested = enc.block.slice(0, jsonStart) + enc.block.slice(jsonStart).replace(
    /"purpose": \{\s*"body": "[^"]*"\s*\},/,
    '"purpose": { "body": "first" }, "purpose": { "body": "second" },',
  );
  const doc2 = `topic: |\n  Fixture.\n${nested}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  const dec2 = decodeIntent(doc2);
  assert.match(dec2.error, /duplicate field "purpose"/);
});

// ---- the durable pin: resolution, refusal, repair ---------------------------------------

function mkbundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  const statePath = path.join(dir, 'state.yml');
  writeState(
    statePath,
    buildSeedState({ slug: 'pin', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' }),
  );
  return { dir, statePath };
}
const TMPDIRS = [];
test.after(() => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

test('a bundle with no pin and no capture history resolves legacy', () => {
  const { statePath } = mkbundle();
  const r = resolveFormatPin(statePath);
  assert.deepEqual(r, { pin: 'legacy' });
});

test('a capture event without a pin refuses legacy and repairs from history', () => {
  const { statePath } = mkbundle();
  appendEvent(statePath, {
    type: 'schema_captured',
    schema_sha256: 'a'.repeat(64),
    skill_identity: 'b'.repeat(64),
    host_contract_version: '1',
    schema_format_version: '1',
    format_pin: 'schema_backed',
  });
  const refused = resolveFormatPin(statePath);
  assert.ok(refused.error, 'missing pin with capture history must refuse, not read as legacy');
  assert.equal(refused.repairable, true);
  assert.match(refused.error, /repair the pin from the capture history/);
  // The repair writes the pin from the event and is idempotent:
  const repaired = repairFormatPin(statePath);
  assert.deepEqual(repaired, { format_pin: 'schema_backed', repaired_from: 'schema_captured' });
  assert.deepEqual(resolveFormatPin(statePath), { pin: 'schema_backed' });
  const again = repairFormatPin(statePath);
  assert.equal(again.noop, true);
  assert.equal(readState(statePath).format_pin, 'schema_backed');
});

test('a present pin wins; an unknown pin value refuses; a conflicting repair refuses', () => {
  const { statePath } = mkbundle();
  appendEvent(statePath, {
    type: 'schema_captured',
    schema_sha256: 'a'.repeat(64),
    skill_identity: 'b'.repeat(64),
    host_contract_version: '1',
    schema_format_version: '1',
    format_pin: 'schema_backed',
  });
  repairFormatPin(statePath);
  assert.deepEqual(resolveFormatPin(statePath), { pin: 'schema_backed' });
  // An unknown value is never guessed:
  writeState(statePath, { ...readState(statePath), format_pin: 'v3-neither' });
  const bad = resolveFormatPin(statePath);
  assert.match(bad.error, /unknown format pin/);
  // A repair that would CHANGE a recorded pin refuses (an explicit amendment owns that):
  writeState(statePath, { ...readState(statePath), format_pin: 'legacy' });
  assert.throws(() => repairFormatPin(statePath), /explicit amendment/);
});

test('repair without capture history names the absence', () => {
  const { statePath } = mkbundle();
  assert.throws(() => repairFormatPin(statePath), /no schema_captured event/);
});

// ---- wave-12 review fix-round regressions (adversary findings, 2026-09-06) ------------

test('an accepted extension section body moves the richer hash (review finding: dropped extensions)', () => {
  const withA = versionedDoc(fixtureAuthoritative({ sections: { extra: { body: 'A' } } }));
  const withB = versionedDoc(fixtureAuthoritative({ sections: { extra: { body: 'B' } } }));
  const plain = versionedDoc(fixtureAuthoritative());
  const hA = goalsHash(withA, { formatPin: 'schema_backed' });
  const hB = goalsHash(withB, { formatPin: 'schema_backed' });
  const h0 = goalsHash(plain, { formatPin: 'schema_backed' });
  assert.notEqual(hA, h0, 'an added extension section must move the richer hash');
  assert.notEqual(hB, hA, 'an edited extension section body must move the richer hash');
  // Extension key ORDER does not matter (canonical sort):
  const withAB = versionedDoc(fixtureAuthoritative({ sections: { zeta: { body: 'z' }, extra: { body: 'A' } } }));
  const withBA = versionedDoc(fixtureAuthoritative({ sections: { extra: { body: 'A' }, zeta: { body: 'z' } } }));
  assert.equal(goalsHash(withBA, { formatPin: 'schema_backed' }), goalsHash(withAB, { formatPin: 'schema_backed' }));
  // A non-body-shaped extension is rejected loudly by the codec (encode and decode share the
  // validator), never silently accepted-then-dropped:
  const encBad = encodeIntentBlock(fixtureAuthoritative({ sections: { extra: { items: ['x'] } } }));
  assert.equal(encBad.ok, false);
  assert.match(encBad.error, /sections\.extra must be \{body: string\}/);
});

test('raw control characters inside canonical-JSON strings are rejected (review finding: lenient reader)', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  // Inject a literal TAB into a body string (JSON forbids raw U+0000–U+001F):
  const jsonStart = enc.block.indexOf('{');
  const patched = enc.block.slice(0, jsonStart) +
    enc.block.slice(jsonStart).replace(
      /("purpose": \{\s*"body": ")Round-trip/,
      '$1Round-trip\tX ',
    );
  assert.notEqual(patched, enc.block, 'the injection must have landed');
  const doc = `topic: |\n  Fixture.\n${patched}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  const dec = decodeIntent(doc);
  assert.match(dec.error, /unescaped control character/);
  assert.throws(() => goalsHash(doc, { formatPin: 'schema_backed' }), /unescaped control character/);
  // The escaped form (\\t) remains perfectly legal:
  const esc = enc.block.slice(0, jsonStart) +
    enc.block.slice(jsonStart).replace(
      /("purpose": \{\s*"body": ")Round-trip/,
      '$1Round-trip\\\\tX ',
    );
  const docEsc = `topic: |\n  Fixture.\n${esc}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  assert.equal(decodeIntent(docEsc).error, undefined);
});

test('non-string notes are rejected, never insertion-order-hashed (review finding: note shape)', () => {
  // An object note would round-trip insertion-ordered, letting equivalent key order move
  // the richer hash. The declared shape is string-only — reject it at decode.
  const withObjNote = versionedDoc(fixtureAuthoritative({
    evidence: [{ section: 'purpose', source: 's', note: 'text note' }],
  }));
  assert.equal(decodeIntent(withObjNote).error, undefined);
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const jsonStart = enc.block.indexOf('{');
  const patched = enc.block.slice(0, jsonStart) +
    enc.block.slice(jsonStart).replace(
      /(\[\s*\{\s*"section": "purpose",\s*"source": "operator interview 2026-09-06"\s*\})/,
      '$1, { "section": "purpose", "source": "s", "note": {"a":1,"b":2} }',
    );
  assert.notEqual(patched, enc.block, 'the note injection must have landed');
  const doc = `topic: |\n  Fixture.\n${patched}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  const dec = decodeIntent(doc);
  assert.match(dec.error, /evidence notes must be strings/);
  assert.throws(() => goalsHash(doc, { formatPin: 'schema_backed' }), /evidence notes must be strings/);
  // Same for a reconciliation row:
  const patched2 = enc.block.slice(0, jsonStart) +
    enc.block.slice(jsonStart).replace(
      /(\[\s*\{\s*"target": "repository INTENT\.md §1",\s*"status": "verified"\s*\})/,
      '$1, { "target": "t", "status": "s", "note": {"b":2,"a":1} }',
    );
  const doc2 = `topic: |\n  Fixture.\n${patched2}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  assert.match(decodeIntent(doc2).error, /reconciliation notes must be strings/);
});

// ---- end-to-end pin dispatch --------------------------------------------------------

test('the versioned document hashes richer under schema_backed and legacy-identical under legacy', () => {
  const doc = versionedDoc(fixtureAuthoritative());
  // The same document under the LEGACY pin hashes the LEGACY canonicalizer's way
  // (its legacy view + goals) — a different string from the richer hash, and both are
  // stable:
  const rich = goalsHash(doc, { formatPin: 'schema_backed' });
  const leg = goalsHash(doc, { formatPin: 'legacy' });
  assert.notEqual(rich, leg);
  assert.equal(goalsHash(doc, { formatPin: 'legacy' }), leg);
  assert.equal(goalsHash(doc, { formatPin: 'schema_backed' }), rich);
  // The document is internally consistent either way (binding passes):
  assert.ok(validateIntentBinding(doc).ok);
  assert.ok(decodeIntent(doc).authoritative);
});
