// test/canonical.test.mjs — lib/canonical.mjs unit tests.
//
// strict stableStringify is the identity/hash serializer: it must reject non-JSON input
// (BigInt/circular/undefined/functions/symbols/nonfinite) with a TypeError rather than
// substituting ordinary string markers that collide with real values. diagnosticStringify
// is the separate nonthrowing formatter for error messages only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify, diagnosticStringify, sha256hex } from '../lib/canonical.mjs';

test('canonical: strict stableStringify preserves valid JSON byte-for-byte (sorted keys)', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: [1, 2, { c: 3 }], b: null, d: true }), '{"a":[1,2,{"c":3}],"b":null,"d":true}');
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify(42), '42');
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(true), 'true');
  assert.equal(stableStringify(''), '""');
  // Empty containers.
  assert.equal(stableStringify([]), '[]');
  assert.equal(stableStringify({}), '{}');
});

test('canonical: strict stableStringify REJECTS non-JSON scalar values', () => {
  assert.throws(() => stableStringify(1n), TypeError, 'BigInt rejected');
  assert.throws(() => stableStringify(undefined), TypeError, 'undefined rejected');
  assert.throws(() => stableStringify(() => {}), TypeError, 'function rejected');
  assert.throws(() => stableStringify(Symbol('s')), TypeError, 'symbol rejected');
  assert.throws(() => stableStringify(NaN), TypeError, 'NaN rejected');
  assert.throws(() => stableStringify(Infinity), TypeError, 'Infinity rejected');
  assert.throws(() => stableStringify(-Infinity), TypeError, '-Infinity rejected');
});

test('canonical: strict stableStringify REJECTS non-JSON input nested in objects/arrays', () => {
  assert.throws(() => stableStringify({ id: 1n }), TypeError, 'nested bigint rejected');
  assert.throws(() => stableStringify({ id: undefined }), TypeError, 'nested undefined rejected');
  assert.throws(() => stableStringify({ id: Infinity }), TypeError, 'nested Infinity rejected');
  assert.throws(() => stableStringify({ id: NaN }), TypeError, 'nested NaN rejected');
  assert.throws(() => stableStringify([1, 2n]), TypeError, 'array bigint rejected');
  assert.throws(() => stableStringify({ f: () => {} }), TypeError, 'nested function rejected');
  assert.throws(() => stableStringify({ s: Symbol('x') }), TypeError, 'nested symbol rejected');
});

test('canonical: strict stableStringify REJECTS circular references (never marker substitution)', () => {
  const circ = { x: 1 };
  circ.self = circ;
  assert.throws(() => stableStringify(circ), TypeError, 'direct cycle rejected');
  const a = { v: 1 };
  const b = { a };
  a.b = b;
  assert.throws(() => stableStringify(a), TypeError, 'mutual cycle rejected');
  // A shared (non-cyclic) reference is fine and renders twice.
  const shared = { v: 1 };
  assert.equal(stableStringify({ p: shared, q: shared }), '{"p":{"v":1},"q":{"v":1}}');
  // The literal marker string is ordinary JSON and does NOT collide with a cycle.
  assert.equal(stableStringify({ self: '<circular>' }), '{"self":"<circular>"}');
});

test('canonical: collision regression — BigInt and literal string are NOT equal identities', () => {
  // Regression: the old renderer mapped BigInt 1n to the string "1n", so a BigInt identity
  // byte-collided with the literal string '1n'. Strict serialization rejects the BigInt.
  assert.throws(() => stableStringify({ id: 1n }), TypeError);
  assert.equal(stableStringify({ id: '1n' }), '{"id":"1n"}');
  // Likewise undefined vs the literal string 'undefined'.
  assert.throws(() => stableStringify({ id: undefined }), TypeError);
  assert.equal(stableStringify({ id: 'undefined' }), '{"id":"undefined"}');
  // NaN/Infinity vs null: JSON.stringify would silently emit null; strict rejects.
  assert.throws(() => stableStringify({ id: NaN }), TypeError);
  assert.throws(() => stableStringify({ id: Infinity }), TypeError);
  assert.equal(stableStringify({ id: null }), '{"id":null}');
});

test('canonical: strict stableStringify hashes deterministically over valid JSON', () => {
  const h1 = sha256hex(stableStringify({ b: 1, a: 2 }));
  const h2 = sha256hex(stableStringify({ a: 2, b: 1 }));
  assert.equal(h1, h2, 'key order does not change the hash');
  assert.equal(h1.length, 64, 'sha256 hex length');
  assert.notEqual(h1, sha256hex(stableStringify({ a: 2, b: 3 })), 'different values hash differently');
});

test('canonical: diagnosticStringify never throws and marks invalid data', () => {
  assert.equal(typeof diagnosticStringify(undefined), 'string');
  assert.equal(typeof diagnosticStringify(() => {}), 'string');
  assert.equal(typeof diagnosticStringify(Symbol('s')), 'string');
  assert.ok(diagnosticStringify({ id: 1n }).includes('BigInt'), 'bigint marked');
  assert.ok(diagnosticStringify(Infinity).includes('Infinity'), 'Infinity marked');
  assert.ok(diagnosticStringify(-Infinity).includes('Infinity'), '-Infinity marked');
  assert.ok(diagnosticStringify(NaN).includes('NaN'), 'NaN marked');
  const circ = { x: 1 };
  circ.self = circ;
  assert.ok(diagnosticStringify(circ).includes('circular'), 'circular marked');
});

test('canonical: diagnosticStringify contains a throwing getter to that property', () => {
  const g = { a: 1 };
  Object.defineProperty(g, 'boom', { enumerable: true, get: () => { throw new Error('boom'); } });
  const out = diagnosticStringify(g);
  assert.ok(out.includes('boom'), `getter error surfaced: ${out}`);
  assert.ok(out.includes('"a":1'), `sibling property still rendered: ${out}`);
  // Top-level getter throw is contained too.
  const g2 = {};
  Object.defineProperty(g2, 'x', { enumerable: true, get: () => { throw new RangeError('top'); } });
  const out2 = diagnosticStringify(g2);
  assert.ok(out2.includes('top'), `top-level getter contained: ${out2}`);
});

test('canonical: diagnosticStringify renders valid JSON identically to strict stableStringify', () => {
  const samples = [
    { b: 1, a: 'x' },
    { a: [1, 2, { c: 3 }], b: null, d: true },
    { nested: { z: [9, 8], k: '' } },
    42,
    'plain',
    null,
    [],
    {},
  ];
  for (const s of samples) {
    assert.equal(diagnosticStringify(s), stableStringify(s), `sample ${JSON.stringify(s)}`);
  }
});

test('canonical: diagnosticStringify handles deeply nested valid data without stack issues at test depth', () => {
  let obj = null;
  for (let i = 0; i < 100; i++) obj = { next: obj, i };
  const out = diagnosticStringify(obj);
  assert.ok(out.startsWith('{') && out.endsWith('}'));
  assert.equal(stableStringify(obj), out);
});
