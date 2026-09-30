// Instrument the real recorder, not a second implementation of its control flow.
// The inventory below exercises every mutating entry shape; every state/event/
// heartbeat/destructive-git/unlink call must follow the FINAL completed gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('recorder mutating entry inventory passes through final authorizeRecording before every write', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recorder-structure-'));
  try {
    const hook = path.join(tmp, 'hook.mjs');
    const log = path.join(tmp, 'writes');
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
          .replace('if (!ctx?.enabled) return { recovery, recoverySelector, reconciledReviews, episodeRecord };',
            'if (!ctx?.enabled) { globalThis.__recorderGateCount = (globalThis.__recorderGateCount ?? 0) + 1; return { recovery, recoverySelector, reconciledReviews, episodeRecord }; }')
          .replace('  return { recovery, recoverySelector, reconciledReviews, episodeRecord };',
            '  globalThis.__recorderGateCount = (globalThis.__recorderGateCount ?? 0) + 1; return { recovery, recoverySelector, reconciledReviews, episodeRecord };');
        let body = source.slice(record, end);
        body = body.replace('  if (!statePath)', '  const gateStart = globalThis.__recorderGateCount ?? 0;\\n' +
          '  const beforeWrite = (kind) => { if ((globalThis.__recorderGateCount ?? 0) - gateStart < 2) throw new Error("STRUCTURAL UNAUTHORIZED WRITE: " + kind); fs.appendFileSync(process.env.RECORDER_WRITE_LOG, kind + "\\\\n"); };\\n' +
          '  const checkedGit = (repo, args) => { if (["add", "commit", "checkout", "clean", "reset"].includes(args[0])) beforeWrite("git:" + args[0]); return runGit(repo, args); };\\n' +
          '  if (!statePath)');
        for (const name of ['heartbeatOwner', 'writeState', 'appendEvent']) {
          body = body.replaceAll(name + '(', '(beforeWrite("' + name + '"), ' + name + ')(');
        }
        body = body.replaceAll('fs.unlinkSync(', '(beforeWrite("unlink"), fs.unlinkSync)(');
        // Do not rewrite the wrapper's delegation to the original git helper.
        body = body.replaceAll('runGit(', 'checkedGit(').replace('return checkedGit(repo, args)', 'return runGit(repo, args)');
        return { ...loaded, source: source.slice(0, start) + gate + body + source.slice(end) };
      }
    `;
    fs.writeFileSync(hook, `import { register } from 'node:module';\nregister(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url);\n`);
    const env = { ...process.env, HOME: tmp, RECORDER_WRITE_LOG: log,
      NODE_OPTIONS: `--import=${hook}` };
    delete env.MP_DISPATCH_MAP;
    delete env.NODE_TEST_CONTEXT;
    for (const [name, file, pattern] of paths) {
      fs.writeFileSync(log, '');
      const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
      });
      const output = child.stdout;
      assert.equal(child.status, 0, `${name}: ${output} ${child.stderr}`);
      assert.match(output, /# fail 0/, name);
      assert.match(output, /# pass [1-9]/, `${name}: non-vacuous test selection`);
      assert.ok(fs.readFileSync(log, 'utf8').length, `${name}: reached real mutating path`);
      const mutant = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
        env: { ...env, RECORDER_REMOVE_FINAL_GATE: '1' }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
      });
      assert.notEqual(mutant.status, 0, `${name}: removing final authorization must fail`);
      assert.match(mutant.stdout, /STRUCTURAL UNAUTHORIZED WRITE/, `${name}: failure occurs at first write`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
