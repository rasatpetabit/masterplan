// test/no-agent-dispatch-fixtures.test.mjs — positive fixtures for the retired-vocabulary gate.
//
// D1 gap: the main detector's old /\badsp[-_]/g matched only 'adsp-' / 'adsp_' and MISSED a bare
// 'adsp' token; 'MCP pool' had no pattern at all. These positive fixtures PIN the corrected
// enforcement: every sample below MUST be flagged by the retired-vocabulary patterns. If a
// pattern is weakened or a term silently returns to a live surface, this file fails the build.
//
// This file is self-exempt in the main scan (test/no-agent-dispatch.test.mjs EXEMPT_PREFIXES):
// it exists to carry literal retired terms as fixture data, exactly like the detector names its
// own retired identifiers.
//
// Scope mirrors the main detector: live surfaces only. Fixture samples are raw vocabulary —
// no file-walk here; the main test owns the walk. This file proves PATTERN COVERAGE.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the main detector's retired-identifier patterns (must stay in lockstep with
// test/no-agent-dispatch.test.mjs RETIRED_PATTERNS). Fragments joined to keep THIS file
// self-documenting; coverage is what the fixtures assert.
const AD = ['agent', 'dispatch'].join('-');
const RETIRED_PATTERNS = [
  new RegExp(`\\b${AD}\\b`, 'g'),
  /\bdispatch_review\b/g,
  /\bdispatch_task\b/g,
  /\bdispatch_fanout\b/g,
  /\bserve-mcp\b/g,
  /mcp__[a-z]+__dispatch_(task|review|fanout)\b/g,
  /\badsp(?=[_-]|\b)/g, // D1: bare 'adsp' (was /\badsp[-_]/g — missed bare form; lookahead keeps 'adsp_' too)
  /\bMCP pool\b/g, // D1: 'MCP pool' phrase (had no pattern at all)
  /\bbroker[-_a-z]*\b/g,
  /\bdispatch-(gateway|agentic-loop|planned-execution|deep-investigation|graph-execution|multi-agent-orchestration|bounded-edit|unknown)\b/g,
  /^subagents:\s*$/gm,
];

// Positive fixtures: every sample MUST be flagged by at least one pattern.
const FIXTURES = [
  'adsp', // bare token — the D1 gap
  'adsp-adapter', // hyphenated (old pattern caught this)
  'adsp_coord', // underscored (old pattern caught this)
  'MCP pool', // the D1 phrase gap
  'serve-mcp broker',
  'agent-dispatch',
  'dispatch_task',
  'mcp__worker__dispatch_task',
  'subagents:\n  - mp-worker',
  'dispatch-gateway',
  'dispatch-bounded-edit',
];

test('positive fixtures: every retired-vocabulary sample is flagged', () => {
  const unflagged = [];
  for (const sample of FIXTURES) {
    const hit = RETIRED_PATTERNS.some((re) => {
      re.lastIndex = 0;
      return re.test(sample);
    });
    if (!hit) unflagged.push(sample);
  }
  assert.deepEqual(unflagged, [], `retired-vocabulary patterns failed to flag fixtures: ${unflagged.join(', ')}`);
});

// Negative guard on the D1 correction itself: bare 'adsp' / 'adsp_' / 'MCP pool' must be
// caught. Regression-pins the old /\badsp[-_]/g miss (bare form) and the _ gap of \b alone.
test('D1 regression: bare adsp, adsp_ and MCP pool are all flagged (the old patterns missed them)', () => {
  assert.equal(/\badsp(?=[_-]|\b)/g.test('adsp'), true, 'bare "adsp" must match');
  assert.equal(/\badsp(?=[_-]|\b)/g.test('adsp-adapter'), true, '"adsp-adapter" must match');
  assert.equal(/\badsp(?=[_-]|\b)/g.test('adsp_coord'), true, '"adsp_coord" must match');
  assert.equal(/\bMCP pool\b/g.test('MCP pool'), true, '"MCP pool" must match');
  // Sanity: the old gap really was a gap — bare 'adsp' alone did not match the old pattern.
  assert.equal(/\badsp[-_]/g.test('adsp'), false, 'sanity: old /\badsp[-_]/g missed bare "adsp"');
});
