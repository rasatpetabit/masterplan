// mp-adversarial-reviewer dispatches its review OUT-OF-PROCESS via the CLI call
// "agent-dispatch review --class adversary", which bypasses overlay route_class routing.
// The agent-dispatch masterplan overlay was therefore reconciled (2026-07-15) to carry
// NO route_class pin for that agent. This test reads BOTH artifacts and proves they agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_MD_PATH = join(REPO_ROOT, 'agents', 'mp-adversarial-reviewer.md');

function resolveAgentDispatchRoot() {
  if (process.env.AGENT_DISPATCH_ROOT && existsSync(process.env.AGENT_DISPATCH_ROOT)) {
    return process.env.AGENT_DISPATCH_ROOT;
  }
  try {
    const where = execFileSync('agent-dispatch', ['where'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (where && existsSync(where)) return where;
  } catch {
    // fall through
  }
  if (existsSync('/srv/dev/ai/agent-dispatch')) {
    return '/srv/dev/ai/agent-dispatch';
  }
  return null;
}

function stripJsoncComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      // preserve the newline (if any)
      continue;
    }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractInvokedClasses(mdText) {
  return Array.from(
    mdText.matchAll(/agent-dispatch\s+review\s+--class\s+([A-Za-z0-9_-]+)/g),
    (m) => m[1],
  );
}

const mdText = readFileSync(AGENT_MD_PATH, 'utf8');
const invokedClasses = extractInvokedClasses(mdText);
const root = resolveAgentDispatchRoot();
let overlayRaw;
let overlay;
if (root !== null) {
  const overlayPath = join(root, 'policy', 'overlays', 'masterplan.jsonc');
  overlayRaw = readFileSync(overlayPath, 'utf8');
  overlay = JSON.parse(stripJsoncComments(overlayRaw));
}

test('agent md invokes the review CLI with exactly one class: adversary', () => {
  assert.ok(
    invokedClasses.length >= 2,
    'md should state the invocation in prose and in command blocks',
  );
  assert.deepEqual(new Set(invokedClasses), new Set(['adversary']));
});

test('overlay path resolves and parses', () => {
  assert.ok(
    root !== null,
    'agent-dispatch root unresolved: set AGENT_DISPATCH_ROOT or install agent-dispatch',
  );
  assert.equal(typeof overlay, 'object');
  assert.ok(overlay !== null);
  assert.equal(typeof overlay.overrides.compiled_frontmatter, 'object');
  assert.ok(overlay.overrides.compiled_frontmatter !== null);
});

test('overlay entry for mp-adversarial-reviewer has no inert route_class and documents the invoked lane', () => {
  assert.ok(overlay !== undefined, 'overlay not loaded: root resolution must succeed first');
  const entry = overlay.overrides.compiled_frontmatter['mp-adversarial-reviewer'];
  assert.equal(typeof entry, 'object');
  assert.ok(entry !== null);
  assert.equal(typeof entry.model, 'string');
  assert.ok(entry.model.length > 0);
  assert.ok(
    !Object.hasOwn(entry, 'route_class'),
    'CLI --class flag bypasses overlay routes so a pin here would be inert and misleading',
  );

  const lines = overlayRaw.split('\n');
  const keyIdx = lines.findIndex((line) => line.includes('"mp-adversarial-reviewer"'));
  assert.ok(keyIdx >= 0, 'overlay must contain a quoted "mp-adversarial-reviewer" key');
  const commentLines = [];
  for (let i = keyIdx - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith('//')) {
      commentLines.unshift(lines[i]);
    } else {
      break;
    }
  }
  const block = commentLines.join('\n');
  assert.ok(block.length > 0, 'entry must carry its advisory annotation comment block');
  assert.ok(
    block.includes('--class ' + invokedClasses[0]),
    'annotation must name exactly the lane the md invokes',
  );
});

test('every remaining route_class pin references a class defined in the overlay', () => {
  assert.ok(overlay !== undefined, 'overlay not loaded: root resolution must succeed first');
  for (const [name, cfg] of Object.entries(overlay.overrides.compiled_frontmatter)) {
    if (cfg && Object.hasOwn(cfg, 'route_class')) {
      assert.equal(typeof cfg.route_class, 'string');
      assert.ok(
        Object.hasOwn(overlay.classes ?? {}, cfg.route_class),
        `dangling route_class pin on agent "${name}": class "${cfg.route_class}" not defined in overlay.classes`,
      );
    }
  }
});
