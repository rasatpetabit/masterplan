// test/no-agent-dispatch.test.mjs — fail-closed scan: the agent-dispatch system is RETIRED
// fleet-wide and must never re-enter masterplan. The user removed it dozens of times by hand;
// prose reminders failed, so this deterministic gate owns the invariant from now on.
//
// What is retired (matches fail the build):
//   - the agent-dispatch control plane and CLI in any form
//   - the dispatch_task / dispatch_review / dispatch_fanout MCP tools
//   - the broker transport (serve-mcp, broker sessions, adsp adapters/coord)
//   - dispatch-<class> model aliases (litellm/dispatch-*) — lanes come from the
//     repo-local routing policy (policy/workflow-map.json) now
//   - agent-dispatch `subagents:` lineup blocks
//
// What is masterplan's OWN vocabulary (never matched): dispatch-wave, dispatch_fabric,
// dispatch_id, dispatchPlanFanout, lib/dispatch/ paths, routing-policy terms.
//
// Scope: live surfaces only. History (legacy/, docs/masterplan/ bundles, docs/superpowers/,
// docs/design/ retired-architecture records, CHANGELOG.md, WORKLOG.md) records the past and is
// exempt. The detector itself is exempt because it names the retired identifiers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Retired identifiers, word-boundary-precise. Built from fragments so this file
// can stay self-exempt without false negatives elsewhere.
const AD = ['agent', 'dispatch'].join('-');
const RETIRED_PATTERNS = [
  new RegExp(`\\b${AD}\\b`, 'g'),
  /\bdispatch_review\b/g,
  /\bdispatch_task\b/g,
  /\bdispatch_fanout\b/g,
  /\bserve-mcp\b/g,
  /mcp__[a-z]+__dispatch_(task|review|fanout)\b/g,
  /\badsp[-_]/g,
  /\bbroker[-_a-z]*\b/g,
  /\bdispatch-(gateway|agentic-loop|planned-execution|deep-investigation|graph-execution|multi-agent-orchestration|bounded-edit|unknown)\b/g,
  /^subagents:\s*$/gm,
];

// History + detector exemption. Anything else under version control is live surface.
const EXEMPT_PREFIXES = [
  'legacy/',
  'docs/masterplan/',
  'docs/superpowers/',
  'docs/design/',
  'docs/contracts/',
  'test/fixtures/legacy-bundles/',
  'node_modules/',
  '.git/',
  '.claude/',
  '.pi/',
  'test/no-agent-dispatch.test.mjs',
];
const EXEMPT_FILES = new Set(['CHANGELOG.md', 'WORKLOG.md', 'test/e2e-native-wave-report.md']);

function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXEMPT_PREFIXES.some((p) => p.endsWith('/') && relPath.startsWith(p))) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      yield* walk(path.join(dir, entry.name), relPath);
    } else if (entry.isFile()) {
      if (EXEMPT_FILES.has(relPath)) continue;
      if (EXEMPT_PREFIXES.some((p) => (!p.endsWith('/') ? relPath === p : relPath.startsWith(p)))) continue;
      yield { relPath, abs: path.join(dir, entry.name) };
    }
  }
}

const TEXT_EXT = new Set(['.mjs', '.js', '.md', '.json', '.yaml', '.yml', '.txt', '.sh', '.toml']);

test('no retired agent-dispatch identifiers on any live surface', () => {
  const findings = [];
  for (const { relPath, abs } of walk(REPO_ROOT)) {
    const ext = path.extname(relPath).toLowerCase();
    if (!TEXT_EXT.has(ext) && !['Makefile', 'llms.txt'].includes(path.basename(relPath))) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // binary or unreadable — not a text surface
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const re of RETIRED_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) {
          findings.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 120)}`);
          break;
        }
      }
    });
  }
  assert.deepEqual(
    findings,
    [],
    `agent-dispatch is retired fleet-wide; ${findings.length} live reference(s) found:\n${findings.slice(0, 800).join('\n')}\n` +
      'Remove the reference (remap onto policy/workflow-map.json lanes + harness-native dispatch). ' +
      'History surfaces (legacy/, docs/masterplan/, docs/superpowers/, docs/design/, CHANGELOG.md, ' +
      'WORKLOG.md) are exempt.',
  );
});
