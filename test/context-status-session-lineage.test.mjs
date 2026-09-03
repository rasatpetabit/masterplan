// test/context-status-session-lineage.test.mjs — tests for lib/context-status.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  encodeProjectPath,
  resolveTranscript,
  measureTranscript,
  resolveWindow,
  contextStatus,
} from '../lib/context-status.mjs';

function makeTempDirs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-home-'));
  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-main-'));
  return { home, mainRoot, encoded: encodeProjectPath(mainRoot) };
}

function usageRecord(input, cacheRead, cacheCreation, output) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
      },
    },
  });
}

function writeTranscript(home, mainRoot, sessionId, lines, location = 'main') {
  const encoded = encodeProjectPath(mainRoot);
  const projectsDir = path.join(home, '.claude', 'projects');
  let dir;
  if (location === 'main') {
    dir = path.join(projectsDir, encoded);
  } else if (location === 'subdirectory') {
    dir = path.join(projectsDir, `${encoded}-sub`);
  } else if (location === 'subagents') {
    dir = path.join(projectsDir, encoded, 'subagents');
  } else {
    throw new Error(`unknown location: ${location}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

test('fresh transcript with two usage records', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's1';
  const lines = [
    usageRecord(100, 0, 0, 0),
    usageRecord(1000, 500, 0, 100),
    JSON.stringify({ type: 'user' }),
  ];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'current');
  assert.equal(result.tokens_at_last_request, 1600);
  const userRecord = JSON.stringify({ type: 'user' });
  assert.equal(result.appended_est, Math.ceil(userRecord.length / 4));
});

test('summary after last usage -> post-compaction', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's2';
  const lines = [
    usageRecord(100, 0, 0, 0),
    usageRecord(200, 0, 0, 0),
    JSON.stringify({ type: 'summary', summary: 'compacted' }),
  ];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'post-compaction');
  assert.equal(result.tokens_at_last_request, 200);
  assert.equal(result.used_pct, null);
});

test('no usage -> malformed', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's3';
  const lines = [JSON.stringify({ type: 'user' })];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'malformed');
  assert.equal(result.tokens_at_last_request, null);
  assert.equal(result.appended_est, null);
});

test('no session file -> not-found with expected_path', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 'missing';
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'not-found');
  const encoded = encodeProjectPath(mainRoot);
  const expected = path.join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  assert.equal(result.expected_path, expected);
  assert.equal(result.lineage, 'not-found');
});

test('subdirectory lineage', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's5';
  const lines = [usageRecord(100, 0, 0, 0)];
  fs.mkdirSync(path.join(mainRoot, 'sub'), { recursive: true });
  writeTranscript(home, mainRoot, sessionId, lines, 'subdirectory');
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.lineage, 'subdirectory', JSON.stringify(result));
  assert.equal(result.state, 'current');
  assert.equal(result.tokens_at_last_request, 100);
});

test('unrelated sibling project dir is not used', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's5c';
  const lines = [usageRecord(100, 0, 0, 0)];
  const encoded = encodeProjectPath(mainRoot);
  const projectsDir = path.join(home, '.claude', 'projects');
  const siblingDir = path.join(projectsDir, `${encoded}-tools`);
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.writeFileSync(path.join(siblingDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'not-found');
  assert.equal(result.lineage, 'not-found');
});

test('trailing empty usage record does not reset tokens', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's5d';
  const lines = [
    usageRecord(100, 0, 0, 0),
    JSON.stringify({ type: 'assistant', message: { usage: {} } }),
  ];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'current');
  assert.equal(result.tokens_at_last_request, 100);
});

test('env MP_CONTEXT_WINDOW is honored', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's5e';
  const lines = [usageRecord(100, 0, 0, 0)];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result = contextStatus({ sessionId, mainRoot, home, env: { MP_CONTEXT_WINDOW: '400000' } });
  assert.equal(result.window, 400000);
  assert.equal(result.window_source, 'env');
});

test('69.6% utilization does not compact at threshold 70', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's5f';
  const lines = [usageRecord(696, 0, 0, 0)];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result = contextStatus({ sessionId, mainRoot, home, explicitWindow: 1000, threshold: 70 });
  assert.equal(result.used_pct, 70);
  assert.equal(result.recommendation.compact, false);
});

test('subagents transcript is not used', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's5b';
  const lines = [usageRecord(100, 0, 0, 0)];
  writeTranscript(home, mainRoot, sessionId, lines, 'subagents');
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'not-found');
  assert.equal(result.lineage, 'not-found');
});

test('resolveWindow precedence', () => {
  assert.deepEqual(
    resolveWindow({ explicit: 300000, env: {}, harnessModel: 'x' }),
    { window: 300000, window_source: 'explicit' }
  );
  assert.deepEqual(
    resolveWindow({ explicit: undefined, env: { MP_CONTEXT_WINDOW: '400000' }, harnessModel: 'x' }),
    { window: 400000, window_source: 'env' }
  );
  assert.deepEqual(
    resolveWindow({ explicit: undefined, env: {}, harnessModel: 'claude-opus[1m]' }),
    { window: 1000000, window_source: 'harness-model' }
  );
  assert.deepEqual(
    resolveWindow({ explicit: undefined, env: {}, harnessModel: 'claude-opus' }),
    { window: 200000, window_source: 'default' }
  );
});

test('recommendation with threshold', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });
  const sessionId = 's7';
  const lines = [usageRecord(150000, 0, 0, 0)];
  writeTranscript(home, mainRoot, sessionId, lines);
  const result1 = contextStatus({ sessionId, mainRoot, home, threshold: 50, focus: 'ship it' });
  assert.equal(result1.used_pct, 75);
  assert.equal(result1.recommendation.compact, true);
  assert.equal(result1.recommendation.focus, 'ship it');
  const result2 = contextStatus({ sessionId, mainRoot, home, threshold: 50, activeRuns: [{ slug: 'r1' }] });
  assert.equal(result2.recommendation.compact, true);
  assert.ok(result2.recommendation.focus.includes('r1'));
});

test('sessionId falsy -> unsupported', () => {
  const result = contextStatus({ sessionId: '', mainRoot: '/tmp/x', home: '/tmp/y' });
  assert.equal(result.state, 'unsupported');
  assert.equal(result.recommendation.compact, false);
});

test('lineage fallback is bounded to three levels below MAIN', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(mainRoot, { recursive: true, force: true }); });
  const sessionId = 's6';
  fs.mkdirSync(path.join(mainRoot, 'a', 'b', 'c', 'd'), { recursive: true });
  const deep = path.join(home, '.claude', 'projects', encodeProjectPath(path.join(mainRoot, 'a', 'b', 'c', 'd')));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, `${sessionId}.jsonl`), usageRecord(100, 0, 0, 0) + '\n');
  assert.equal(contextStatus({ sessionId, mainRoot, home }).state, 'not-found');
  const ok = path.join(home, '.claude', 'projects', encodeProjectPath(path.join(mainRoot, 'a', 'b', 'c')));
  fs.mkdirSync(ok, { recursive: true });
  fs.writeFileSync(path.join(ok, `${sessionId}.jsonl`), usageRecord(100, 0, 0, 0) + '\n');
  assert.equal(contextStatus({ sessionId, mainRoot, home }).lineage, 'subdirectory');
});

test('a resolved but unreadable transcript never fabricates usage', (t) => {
  const { home, mainRoot } = makeTempDirs();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(mainRoot, { recursive: true, force: true }); });
  const sessionId = 's7x';
  const dir = path.join(home, '.claude', 'projects', encodeProjectPath(mainRoot));
  fs.mkdirSync(path.join(dir, `${sessionId}.jsonl`), { recursive: true }); // a directory where the file should be
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.state, 'not-found');
  assert.equal(result.used_pct, null);
  assert.equal(result.tokens_at_last_request, null);
});

test('a MAIN path containing "subagents" still resolves its subdirectory lineage', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-home-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const mainRoot = path.join(base, 'my-subagents-repo');
  fs.mkdirSync(path.join(mainRoot, 'app'), { recursive: true });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); });
  const sessionId = 's8';
  const dir = path.join(home, '.claude', 'projects', encodeProjectPath(path.join(mainRoot, 'app')));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), usageRecord(100, 0, 0, 0) + '\n');
  const result = contextStatus({ sessionId, mainRoot, home });
  assert.equal(result.lineage, 'subdirectory');
});
