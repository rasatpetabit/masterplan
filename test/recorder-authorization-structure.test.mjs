// Instrument the real recorder, not a second implementation of its control flow.
// The inventory below exercises every mutating entry shape; every state/event/
// heartbeat/destructive-git/unlink call must follow the FINAL completed gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';


const RECORDER_POOL = 5;

function spawnNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

const paths = [
  ['submitted ordinary', 'test/dispatch-wave.test.mjs', 'D6 independence'],
  ['null reconciliation', 'test/dispatch-wave.native.test.mjs', 'X22 R3 F3 approve reconciles after code commit \\(ordinary\\)'],
  ['partial submitted/omitted', 'test/dispatch-wave.native.test.mjs', 'X22 R3 F3 partial result restores omitted fresh rejection'],
  ['submitted recovery/deferred', 'test/recovery-controller.test.mjs', 'recovery phase B: a matching receipt binds'],
  ['committed reconciliation', 'test/dispatch-wave.native.test.mjs', 'X22 R3 F3 approve reconciles after code commit \\(recovery\\)'],
  ['CLI legacy', 'test/wave-commit.test.mjs', 'bin record-result honors owner_lock=off'],
  ['CLI native Phase B', 'test/bin-masterplan.test.mjs', 'record-result awaits native review'],
  ['CLI recovery Phase B', 'test/bin-masterplan.test.mjs', 'recovery CLI: --recovery-repo/--recovery-head reproduce'],
  ['legacy dirty reconcile', 'test/wave-commit.test.mjs', 'dirty-WT crash reconcile'],
  ['failed partial wave', 'test/wave-commit.test.mjs', 'failed task: left pending'],
  ['qctl', 'test/wave-commit.test.mjs', 'qctl digest: stays pending'],
  ['watch revert', 'test/wave-commit.test.mjs', 'watch-list breach in a SIBLING'],
  ['workspace unlink', 'test/wave-commit.test.mjs', 'A8 record-result drift check reverts'],
];

test('recorder mutating entry inventory passes through final authorizeRecording before every write', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recorder-structure-'));
  try {
    const hook = path.join(tmp, 'hook.mjs');
    const loader = `
      import fs from 'node:fs';
      export async function load(url, context, next) {
        const loaded = await next(url, context);
        if (!url.endsWith('/lib/wave-commit.mjs')) return loaded;
        let source = String(loaded.source);
        if (process.env.RECORDER_REMOVE_FINAL_GATE === '1') {
          source = source.replace('  authorization = authorizeRecording({ statePath, state, result, deferredEvents, worktree,\\n    recovery, recoverySelector, skillRoot });', '  // mutation: omit final gate');
        }
        const start = source.indexOf('export function authorizeRecording(');
        const record = source.indexOf('export function recordWaveResult(');
        const end = source.indexOf('export function promoteAmendment(');
        let gate = source.slice(start, record)
          .replaceAll('  return { recovery, recoverySelector, reconciledReviews, episodeRecord };',
            '  globalThis.__recorderGateCount = (globalThis.__recorderGateCount ?? 0) + 1; return { recovery, recoverySelector, reconciledReviews, episodeRecord };');
        let body = source.slice(record, end);
        body = 'let gateStart;\\n' +
          'const beforeWrite = (kind) => { if ((globalThis.__recorderGateCount ?? 0) - gateStart < 2) throw new Error("STRUCTURAL UNAUTHORIZED WRITE: " + kind); fs.appendFileSync(process.env.RECORDER_WRITE_LOG, kind + "\\\\n"); };\\n' +
          'const checkedGit = (repo, args) => { const command = args.find((arg) => !arg.startsWith("-")); if (["add", "commit", "checkout", "clean", "reset"].includes(command)) beforeWrite("git:" + command); return runGit(repo, args); };\\n' +
          body.replace('  if (!statePath)', '  gateStart = globalThis.__recorderGateCount ?? 0;\\n  if (!statePath)');
        for (const name of ['heartbeatOwner', 'saveWaveRecording', 'appendRecordingSuffix', 'writeState', 'writeWaveDispatchRecord', 'finishWaveRecording']) {
          body = body.replaceAll(name + '(', '(beforeWrite("' + name + '"), ' + name + ')(');
        }
        body = body.replaceAll('fs.unlinkSync(', '(beforeWrite("unlink"), fs.unlinkSync)(');
        // Do not rewrite the wrapper's delegation to the original git helper.
        body = body.replaceAll('runGit(', 'checkedGit(').replace('return checkedGit(repo, args)', 'return runGit(repo, args)');
        return { ...loaded, source: source.slice(0, start) + gate + body + source.slice(end) };
      }
    `;
    fs.writeFileSync(hook, `import { register } from 'node:module';\nregister(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url);\n`);
    const baseEnv = { ...process.env, HOME: tmp, NODE_OPTIONS: `--import=${hook}` };
    delete baseEnv.MP_DISPATCH_MAP;
    delete baseEnv.NODE_TEST_CONTEXT;
    delete baseEnv.RECORDER_REMOVE_FINAL_GATE;
    delete baseEnv.RECORDER_WRITE_LOG;
    const jobs = [];
    for (const [name, file, pattern] of paths) {
      jobs.push({ name, file, pattern, mutant: false });
      jobs.push({ name, file, pattern, mutant: true });
    }
    const results = await mapPool(jobs, RECORDER_POOL, async (job, index) => {
      const writeLog = path.join(tmp, `writes-${index}`);
      fs.writeFileSync(writeLog, '');
      const env = { ...baseEnv, RECORDER_WRITE_LOG: writeLog };
      if (job.mutant) env.RECORDER_REMOVE_FINAL_GATE = '1';
      const child = await spawnNode(['--test', `--test-name-pattern=${job.pattern}`, job.file], env);
      return { ...job, child, writeLog };
    });
    const byName = new Map();
    for (const row of results) {
      const slot = byName.get(row.name) ?? {};
      slot[row.mutant ? 'mutant' : 'base'] = row;
      byName.set(row.name, slot);
    }
    for (const [name] of paths) {
      const slot = byName.get(name);
      const output = slot.base.child.stdout;
      assert.equal(slot.base.child.status, 0, `${name}: ${output} ${slot.base.child.stderr}`);
      assert.match(output, /# fail 0/, name);
      assert.match(output, /# pass [1-9]/, `${name}: non-vacuous test selection`);
      assert.ok(fs.readFileSync(slot.base.writeLog, 'utf8').length, `${name}: reached real mutating path`);
      assert.notEqual(slot.mutant.child.status, 0, `${name}: removing final authorization must fail`);
      assert.match(slot.mutant.child.stdout, /STRUCTURAL UNAUTHORIZED WRITE/, `${name}: failure occurs at first write`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
