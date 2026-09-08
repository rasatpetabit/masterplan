// test/design-intent-adapter.test.mjs — the design-intent §2 codec (task 50).
//
// Covers: round-trip of multiline prose, bullets, extensions and reconciliation; the
// anti-goal boundary (bullets inside other section bodies never pollute anti_goals);
// deterministic legacy projection; the persisted-legacy-view-vs-authoritative binding
// failure; byte-stable legacy documents (parse results AND hashes identical to the
// pre-codec parser — the literals below were captured from the parser before the codec
// landed); and rejection of unknown versions, duplicate blocks, and malformed payloads.
//
// The codec under test lives in lib/goals.mjs (INTENT_CODEC_VERSION,
// projectLegacyIntent, encodeIntentBlock, decodeIntent, validateIntentBinding).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGoals,
  goalsHash,
  validateGoals,
  INTENT_CODEC_VERSION,
  projectLegacyIntent,
  encodeIntentBlock,
  decodeIntent,
  validateIntentBinding,
} from '../lib/goals.mjs';

const SCHEMA = { identity: 'design-intent@fixture', format_version: 1 };

function fixtureAuthoritative() {
  return {
    version: INTENT_CODEC_VERSION,
    schema: SCHEMA,
    sections: {
      purpose: {
        body: 'Users need the codec to round-trip.\n\nSecond paragraph with bullets:\n- a bullet inside Purpose prose\n- another bullet\n',
      },
      non_goals: { items: ['no new dependencies', 'no second goals resolver'] },
      top_invariant: { body: 'Legacy documents parse byte-for-byte.\nEvery hash stays put.' },
      direction: { body: 'One native artifact, one narrow adapter.' },
      posture: { body: 'Fail on disagreement; never prefer a copy.' },
    },
    context: {
      outcome: { body: 'The codec lands and later tasks build on it.\nDeeper context line two.' },
      done_means: { body: 'release\nplus run-specific live evidence' },
      audience: { body: 'masterplan maintainers' },
    },
    evidence: [{ section: 'purpose', source: 'operator interview 2026-09-06' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified', note: 'rows match' }],
  };
}

function wrapBlock(block) {
  return `topic: |\n  Fixture run.\n${block}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
}

test('encodeIntentBlock produces a versioned block with both copies', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok, JSON.stringify(enc));
  assert.match(enc.block, /^## Intent\n/);
  assert.ok(enc.block.includes('```mp-intent-schema v1\n'), 'fence marker with explicit version');
  assert.ok(enc.block.includes('why: Users need the codec to round-trip.'), 'legacy view first line of purpose');
  assert.ok(enc.block.includes('- no new dependencies'), 'anti-goal items as legacy bullets');
});

test('round-trip: encode -> decode -> encode is idempotent, all section text preserved', () => {
  const a = fixtureAuthoritative();
  const first = encodeIntentBlock(a);
  assert.ok(first.ok);
  const doc = wrapBlock(first.block);
  const dec = decodeIntent(doc);
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.versioned, true);
  // Lossless bodies, bullets, extensions, reconciliation:
  assert.equal(dec.authoritative.sections.purpose.body, a.sections.purpose.body);
  assert.deepEqual(dec.authoritative.sections.non_goals.items, a.sections.non_goals.items);
  assert.equal(dec.authoritative.sections.top_invariant.body, a.sections.top_invariant.body);
  assert.equal(dec.authoritative.context.outcome.body, a.context.outcome.body);
  assert.equal(dec.authoritative.context.done_means.body, a.context.done_means.body);
  assert.equal(dec.authoritative.context.audience.body, a.context.audience.body);
  assert.deepEqual(dec.authoritative.evidence, a.evidence);
  assert.deepEqual(dec.authoritative.reconciliation, a.reconciliation);
  // Idempotent bytes:
  const second = encodeIntentBlock(dec.authoritative);
  assert.ok(second.ok);
  assert.equal(second.block, first.block);
});

test('bodies containing triple backticks and blank lines round-trip', () => {
  const a = fixtureAuthoritative();
  a.sections.purpose.body = 'Example markdown:\n```\ncode sample\n```\nand more';
  a.context.outcome.body = 'outcome with ``` inside';
  const enc = encodeIntentBlock(a);
  assert.ok(enc.ok);
  const dec = decodeIntent(wrapBlock(enc.block));
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.authoritative.sections.purpose.body, a.sections.purpose.body);
  assert.equal(dec.authoritative.context.outcome.body, a.context.outcome.body);
  assert.equal(dec.legacyView.why, 'Example markdown:'); // first non-empty line, even with fences inside
});

test('anti-goal boundary: bullets in other section bodies never pollute anti_goals', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  const doc = wrapBlock(enc.block);
  const dec = decodeIntent(doc);
  assert.ok(!dec.error, dec.error || '');
  // The persisted legacy view (what the existing parser reads) carries ONLY the two
  // non_goals items — the Purpose bullets live inside the masked JSON and cannot leak.
  assert.deepEqual(dec.legacyView.anti_goals, ['no new dependencies', 'no second goals resolver']);
  // The authoritative non_goals preserve item boundaries and order:
  assert.deepEqual(dec.authoritative.sections.non_goals.items, ['no new dependencies', 'no second goals resolver']);
  // And the existing parser agrees with the legacy view:
  const parsed = parseGoals(doc);
  assert.deepEqual(parsed.intent.anti_goals, ['no new dependencies', 'no second goals resolver']);
});

test('projectLegacyIntent is deterministic and follows the first-line rule', () => {
  const a = fixtureAuthoritative();
  const p1 = projectLegacyIntent(a);
  const p2 = projectLegacyIntent(JSON.parse(JSON.stringify(a)));
  assert.deepEqual(p1, p2);
  assert.equal(p1.why, 'Users need the codec to round-trip.');
  assert.equal(p1.outcome, 'The codec lands and later tasks build on it.');
  assert.equal(p1.done_means, 'release');
  assert.deepEqual(p1.anti_goals, ['no new dependencies', 'no second goals resolver']);
});

test('validateIntentBinding passes a freshly encoded document', () => {
  const doc = wrapBlock(encodeIntentBlock(fixtureAuthoritative()).block);
  const v = validateIntentBinding(doc);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.versioned, true);
  // validateGoals still accepts the encoded document (3 goals + intent present):
  const vg = validateGoals(parseGoals(doc));
  assert.ok(vg.ok, vg.error || '');
});

test('validateIntentBinding FAILS when the persisted legacy view disagrees', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  // Edit the legacy why: without touching the authoritative JSON:
  const tampered1 = enc.block.replace('why: Users need the codec to round-trip.', 'why: hand-edited line');
  const v1 = validateIntentBinding(wrapBlock(tampered1));
  assert.equal(v1.ok, false);
  assert.match(v1.error, /legacy view disagrees/);
  assert.match(v1.error, /why differs/);
  // Edit the authoritative JSON purpose without regenerating the legacy view:
  const tampered2 = enc.block.replace('Users need the codec to round-trip.\\n\\nSecond paragraph', 'Rewritten purpose.\\n\\nSecond paragraph');
  const v2 = validateIntentBinding(wrapBlock(tampered2));
  assert.equal(v2.ok, false);
  assert.match(v2.error, /why differs/);
});

test('legacy documents (no codec block) are byte-stable: parse AND hash', () => {
  // Literal expectations captured from the parser BEFORE the codec landed (2026-09-06).
  // If the codec ever moves legacy parse results or hashes, these literals fail.
  const A = 'topic: Ship the widget\n## G1: It works\nsignal: test\nevidence: npm test\n';
  const pa = parseGoals(A);
  assert.equal(pa.topicSeed, 'Ship the widget');
  assert.equal(pa.intent, null);
  assert.equal(pa.version, 1);
  assert.deepEqual(pa.goals, [{ id: 'G1', text: 'It works', signal: 'test', evidence: 'npm test' }]);
  assert.equal(goalsHash(A), 'sha256:4518f972c0bffe5ca9518cf85c9fd3003b6b993be9423dfe69a8049cfea3d237');

  const B = 'topic: |\n  Do the thing.\n## Intent\nwhy: because users need it\noutcome: the feature ships\nanti_goals:\n- no new deps\n- no UI rewrite\ndone_means: release\n\n## G1: Works\n## G2: Fast\n## G3: Documented\n';
  const pb = parseGoals(B);
  assert.equal(pb.topicSeed, 'Do the thing.');
  assert.equal(pb.version, 2);
  assert.deepEqual(pb.intent, {
    why: 'because users need it',
    outcome: 'the feature ships',
    anti_goals: ['no new deps', 'no UI rewrite'],
    done_means: 'release',
  });
  assert.equal(pb.intentOutcomeLine, 'outcome: the feature ships');
  assert.equal(goalsHash(B), 'sha256:1f7d8db4971fe6648f3b71b84c6a59dd92803ed2d2aa7126ca63d4cf10836f06');
  // And decodeIntent reads such documents as legacy:
  const dec = decodeIntent(B);
  assert.equal(dec.versioned, false);
  assert.equal(dec.authoritative, null);
  assert.deepEqual(dec.legacyView, pb.intent);
  const v = validateIntentBinding(B);
  assert.ok(v.ok);
  assert.equal(v.versioned, false);
});

test('unknown version markers and malformed payloads are rejected, never guessed', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const body = enc.block.replace('```mp-intent-schema v1', '```mp-intent-schema v2').replace(
    '"version": 1',
    '"version": 2',
  );
  const v2 = validateIntentBinding(wrapBlock(body));
  assert.equal(v2.ok, false);
  assert.match(v2.error, /unknown or malformed intent codec version marker/);

  const noVersion = enc.block.replace('```mp-intent-schema v1', '```mp-intent-schema');
  const nv = validateIntentBinding(wrapBlock(noVersion));
  assert.equal(nv.ok, false);
  assert.match(nv.error, /unknown or malformed intent codec version marker/);

  const badJson = enc.block.replace('"identity": "design-intent@fixture"', '"identity": ');
  const bj = validateIntentBinding(wrapBlock(badJson));
  assert.equal(bj.ok, false);
  assert.match(bj.error, /not valid JSON/);

  // A payload whose JSON version field disagrees with the fence:
  const misVersion = enc.block.replace('"version": 1', '"version": 9');
  const mv = validateIntentBinding(wrapBlock(misVersion));
  assert.equal(mv.ok, false);
  assert.match(mv.error, /unknown intent codec version 9/);
});

test('duplicate codec blocks are rejected', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const fenceStart = enc.block.indexOf('```mp-intent-schema v1');
  const fenceEnd = enc.block.indexOf('```', fenceStart + 3) + 3;
  const doubled =
    enc.block.slice(0, fenceEnd) + '\n' + enc.block.slice(fenceStart, fenceEnd) + enc.block.slice(fenceEnd);
  const v = validateIntentBinding(wrapBlock(doubled));
  assert.equal(v.ok, false);
  assert.match(v.error, /duplicate intent codec blocks/);
});

test('ordinary quoted code inside the Intent block is not a codec block', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const withSample = enc.block.replace(
    'done_means: release',
    'done_means: release\n\n```\nwhy: a quoted example, not intent\n```',
  );
  const dec = decodeIntent(wrapBlock(withSample));
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.versioned, true);
  assert.equal(dec.legacyView.why, 'Users need the codec to round-trip.');
});

test('encodeIntentBlock rejects invalid authoritative shapes with named problems', () => {
  const a = fixtureAuthoritative();
  delete a.sections.top_invariant;
  const r = encodeIntentBlock(a);
  assert.equal(r.ok, false);
  assert.match(r.error, /top_invariant/);
  const b = fixtureAuthoritative();
  b.sections.non_goals.items = [42];
  const rb = encodeIntentBlock(b);
  assert.equal(rb.ok, false);
  assert.match(rb.error, /non_goals/);
  const c = fixtureAuthoritative();
  delete c.schema;
  const rc = encodeIntentBlock(c);
  assert.equal(rc.ok, false);
  assert.match(rc.error, /schema must be/);
});

// ---- review fix-round regressions (wave-11 adversary findings, 2026-09-06) --------

test('an unclosed codec fence is an error, never a silent legacy downgrade', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const unclosed = enc.block.replace(/\n```\n$/m, '\n'); // remove the closing fence
  const v = validateIntentBinding(wrapBlock(unclosed));
  assert.equal(v.ok, false);
  assert.match(v.error, /not closed/);
});

test('a tab-mangled version marker claims the form and is rejected', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const mangled = enc.block.replace('```mp-intent-schema v1', '```mp-intent-schema\tv99');
  const v = validateIntentBinding(wrapBlock(mangled));
  assert.equal(v.ok, false);
  assert.match(v.error, /unknown or malformed intent codec version marker/);
});

test('a codec fence nested inside a longer quotation is quoted content, not a claim', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  // MOVE the codec portion inside a 4-backtick quotation (a copy would leave the real
  // fence in place outside it and trivially claim the form).
  const fenceStart = enc.block.indexOf('```mp-intent-schema v1');
  const quoted = enc.block.slice(0, fenceStart) + '````\n' + enc.block.slice(fenceStart) + '````\n';
  const v = validateIntentBinding(wrapBlock(quoted));
  // The only codec fence sits inside the 4-backtick quotation: quoted content, not a
  // claim. The document degrades to its legacy view — the honest read, not a false pairing.
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.versioned, false);
});

test('a heading inside an ordinary fence does not hide the codec block that follows', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  const withSample = enc.block.replace(
    'done_means: release',
    'done_means: release\n\n```\n## sample heading inside quoted code\n```',
  );
  const dec = decodeIntent(wrapBlock(withSample));
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.versioned, true);
});

test('two Intent sections: the binding pairs the LAST section (parser last-wins)', () => {
  const a = fixtureAuthoritative();
  const b = fixtureAuthoritative();
  b.sections.purpose.body = 'Second section purpose.\nWith more prose.';
  const encA = encodeIntentBlock(a);
  const encB = encodeIntentBlock(b);
  assert.ok(encA.ok && encB.ok);
  // Tamper only the FIRST section's legacy why: the last section is the document.
  const first = encA.block.replace('why: Users need the codec to round-trip.', 'why: tampered first section');
  const doc = `topic: |\n  Fixture run.\n${first}\n## G1: Works\n\n${encB.block}\n## G2: Fast\n## G3: Documented\n`;
  const okV = validateIntentBinding(doc);
  assert.ok(okV.ok, JSON.stringify(okV));
  assert.equal(okV.versioned, true);
  const dec = decodeIntent(doc);
  assert.equal(dec.legacyView.why, 'Second section purpose.');
  // Tampering the LAST section's copy FAILS the binding.
  const lastTampered = doc.replace('why: Second section purpose.', 'why: tampered last section');
  const bad = validateIntentBinding(lastTampered);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /legacy view disagrees/);
});

test('non-goal items that cannot be one legacy bullet are rejected, never mangled', () => {
  for (const badItem of ['', ' untrimmed ', 'first\n- second', 'with\rcarriage']) {
    const a = fixtureAuthoritative();
    a.sections.non_goals.items = ['ok item', badItem];
    const r = encodeIntentBlock(a);
    assert.equal(r.ok, false, JSON.stringify(badItem));
    assert.match(r.error, /single-line, trimmed, non-empty/);
    // And decode rejects them too (both share codecValidateAuthoritative):
    const enc = encodeIntentBlock(fixtureAuthoritative());
    assert.ok(enc.ok);
    const jsonStart = enc.block.indexOf('{');
    const obj = JSON.parse(enc.block.slice(jsonStart, enc.block.lastIndexOf('}') + 1));
    obj.sections.non_goals.items = ['ok item', badItem];
    const doc = wrapBlock(enc.block.slice(0, jsonStart) + JSON.stringify(obj, null, 2) + enc.block.slice(enc.block.lastIndexOf('}') + 1));
    const v = validateIntentBinding(doc);
    assert.equal(v.ok, false, JSON.stringify(badItem));
  }
});

test('the projection uses the parser line grammar: a CR cannot inject a second line', () => {
  const a = fixtureAuthoritative();
  a.sections.purpose.body = 'why\r- injected';
  const enc = encodeIntentBlock(a);
  assert.ok(enc.ok);
  const dec = decodeIntent(wrapBlock(enc.block));
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.legacyView.why, 'why');
  assert.deepEqual(dec.legacyView.anti_goals, ['no new dependencies', 'no second goals resolver']);
  const v = validateIntentBinding(wrapBlock(enc.block));
  assert.ok(v.ok, JSON.stringify(v));
});

test('a __proto__ context key corrupting the object prototype is rejected at encode', () => {
  const a = fixtureAuthoritative();
  a.context['__proto__'] = { body: 'keep me' }; // invokes the prototype setter
  const r = encodeIntentBlock(a);
  assert.equal(r.ok, false);
  assert.match(r.error, /corrupted prototype/);
});

test('a __proto__ own key from JSON round-trips instead of disappearing', () => {
  const enc = encodeIntentBlock(fixtureAuthoritative());
  assert.ok(enc.ok);
  // An own __proto__ key can only come from JSON.parse — plain-object assignment invokes
  // the prototype setter instead (covered by the corrupted-prototype test above). Inject it
  // as JSON text so the decoder receives exactly what a round-tripped document carries.
  const jsonStart = enc.block.indexOf('{');
  const jsonEnd = enc.block.lastIndexOf('}') + 1;
  const objText = enc.block.slice(jsonStart, jsonEnd);
  assert.ok(objText.includes('"context": {'));
  const injected = objText.replace('"context": {', '"context": {\n    "__proto__": { "body": "keep me" },');
  const rewritten = enc.block.slice(0, jsonStart) + injected + enc.block.slice(jsonEnd);
  const dec = decodeIntent(wrapBlock(rewritten));
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.authoritative.context['__proto__'].body, 'keep me');
  // Re-encoded bytes keep it:
  const re = encodeIntentBlock(dec.authoritative);
  assert.ok(re.ok);
  const dec2 = decodeIntent(wrapBlock(re.block));
  assert.equal(dec2.authoritative.context['__proto__'].body, 'keep me');
});
