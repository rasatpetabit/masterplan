/**
 * test/jsonc.test.mjs — the string-aware JSONC parser.
 *
 * Each case here is a shape that the previous whole-line-only regex strippers in
 * lib/dispatch-wave.mjs and lib/doctor/adversary-lane-health.mjs got WRONG, and
 * got wrong silently: both call sites catch a parse throw and fall back to an
 * empty value, so a policy file that grew a trailing comment would have degraded
 * wave dispatch (agent:null on every task) with nothing reported.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonc, stripJsonc } from '../lib/jsonc.mjs';

test('trailing line comment after a value — the case the old stripper threw on', () => {
  const text = `{
  "routes": {
    "dispatch-sol-edit": "gpt-5.6-sol", // why this lane exists
    "dispatch-tester": "gpt-5.6"
  }
}`;
  // Proof the OLD approach failed, so this test cannot silently become vacuous
  // if someone reintroduces it.
  const oldStrip = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.throws(() => JSON.parse(oldStrip), 'the old whole-line-only strip must fail here');

  const parsed = parseJsonc(text);
  assert.equal(parsed.routes['dispatch-sol-edit'], 'gpt-5.6-sol');
  assert.equal(parsed.routes['dispatch-tester'], 'gpt-5.6');
});

test('`//` inside a string literal is content, not a comment', () => {
  const text = '{ "api_base": "http://127.0.0.1:8790/v1", "n": 1 }';
  // The `//`-anywhere variant truncated the string mid-literal.
  const worseStrip = text.replace(/\/\/.*$/gm, '');
  assert.throws(() => JSON.parse(worseStrip), 'the `//`-anywhere strip must fail here');

  assert.equal(parseJsonc(text).api_base, 'http://127.0.0.1:8790/v1');
});

test('whole-line and block comments still strip', () => {
  const parsed = parseJsonc(`{
  // a leading line comment
  /* and a
     block comment */
  "a": 1
}`);
  assert.deepEqual(parsed, { a: 1 });
});

test('block comment markers inside a string are preserved', () => {
  assert.equal(parseJsonc('{ "s": "a /* not a comment */ b" }').s, 'a /* not a comment */ b');
});

test('escaped quote inside a string does not end the string early', () => {
  assert.equal(parseJsonc('{ "s": "he said \\"//\\" loudly", "n": 2 }').s, 'he said "//" loudly');
  assert.equal(parseJsonc('{ "s": "trailing backslash \\\\", "n": 3 }').n, 3);
});

test('trailing commas are tolerated in objects and arrays', () => {
  assert.deepEqual(parseJsonc('{ "a": [1, 2, 3,], "b": 1, }'), { a: [1, 2, 3], b: 1 });
});

test('a comma inside a string is not treated as a trailing comma', () => {
  assert.equal(parseJsonc('{ "s": "a, ]" }').s, 'a, ]');
});

test('a block comment between tokens does not merge them into new valid data', () => {
  // Splicing the comment out would turn the MALFORMED {"n":1/*x*/2} into the
  // VALID {"n":12} — silent data corruption. Space-filling makes it throw.
  // Found by the dispatch-gateway diff-review lane, 2026-08-05.
  assert.throws(() => parseJsonc('{"n":1/*x*/2}'));
  assert.throws(() => parseJsonc('{"n":1/**/2}'));
  // A block comment in a harmless position still parses.
  assert.equal(parseJsonc('{"n": /* one */ 1}').n, 1);
});

test('unterminated block comment throws rather than silently truncating', () => {
  assert.throws(() => stripJsonc('{ "a": 1 } /* never closed'), /Unterminated block comment/);
});

test('non-string input is a TypeError', () => {
  assert.throws(() => parseJsonc(null), TypeError);
  assert.throws(() => parseJsonc({}), TypeError);
});

test('the real dispatch-policy.jsonc parses and carries a route map', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  let root;
  try {
    root = String(execFileSync('agent-dispatch', ['where'], { encoding: 'utf8' })).trim();
  } catch {
    return; // agent-dispatch CLI unavailable — the unit cases above still cover the parser
  }
  const p = path.join(root, 'policy', 'dispatch-policy.jsonc');
  if (!fs.existsSync(p)) return;
  const policy = parseJsonc(fs.readFileSync(p, 'utf8'));
  assert.ok(
    Object.keys(policy.agent_mapping ?? {}).length > 0,
    'the live policy yields a non-empty agent_mapping — the value dispatch-wave depends on',
  );
});
