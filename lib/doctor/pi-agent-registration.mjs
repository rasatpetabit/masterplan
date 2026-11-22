// lib/doctor/pi-agent-registration.mjs — host drift of pi-installed mp-* agents.
//
// Calls exported synchronous `runRegister` from bin/register-pi-agents.mjs in-process
// (same single source of truth, without spawning a Node subprocess).
//
// Severity:
//   PASS  — exit 0 (0 drift)
//   WARN  — non-zero exit with drift report (re-run write mode)
//   SKIP  — no ~/.pi/agent/agents dir (not a pi host), or script missing
//
// opts.homeDir / opts.runRegister / opts.agentsDir / opts.execFileSync / opts.repoRoot /
// opts.nodeBin / opts.scriptPath / opts.targetDir are injectable for tests (never touch
// the real host from fixtures unless intended).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../config.mjs';
import { runRegister as defaultRunRegister } from '../../bin/register-pi-agents.mjs';

const ID = 'pi-agent-registration';

function defaultRepoRoot() {
  // lib/doctor/ → repo root is ../..
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * @param {string} repoRoot
 * @param {{
 *   homeDir?: string,
 *   runRegister?: typeof defaultRunRegister,
 *   agentsDir?: string,
 *   execFileSync?: Function,
 *   nodeBin?: string,
 *   scriptPath?: string,
 *   targetDir?: string,
 * }} [opts]
 * @returns {Array<{id:string, severity:string, summary:string, fix:string|null}>}
 */
export function check(repoRoot, opts = {}) {
  const root = repoRoot || defaultRepoRoot();
  const homeDir = opts.homeDir ?? os.homedir();
  const targetDir = opts.targetDir ?? path.join(homeDir, '.pi', 'agent', 'agents');
  const scriptPath = opts.scriptPath ?? path.join(root, 'bin', 'register-pi-agents.mjs');
  const agentsDir = opts.agentsDir ?? path.join(root, 'agents');

  if (!opts.runRegister && !opts.agentsDir && !fs.existsSync(scriptPath)) {
    return [{
      id: ID,
      severity: 'SKIP',
      summary: 'register-pi-agents.mjs not found in this checkout',
      fix: null,
    }];
  }

  // Not a pi host (or never registered): no agents dir → SKIP, not WARN.
  if (!fs.existsSync(targetDir)) {
    return [{
      id: ID,
      severity: 'SKIP',
      summary: `no pi agents dir at ${targetDir} (not a pi host, or never registered)`,
      fix: null,
    }];
  }

  let report = '';
  let exitCode = 0;

  if (typeof opts.execFileSync === 'function') {
    const nodeBin = opts.nodeBin ?? process.execPath;
    let stdout = '';
    let stderr = '';
    try {
      stdout = opts.execFileSync(nodeBin, [scriptPath, '--check'], {
        cwd: root,
        encoding: 'utf8',
        env: childEnv({ HOME: homeDir }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      exitCode = typeof e.status === 'number' ? e.status : 1;
      stdout = String(e.stdout ?? '');
      stderr = String(e.stderr ?? e.message ?? e);
    }
    report = `${stdout}\n${stderr}`.trim();
  } else {
    const runRegister = opts.runRegister ?? defaultRunRegister;
    try {
      const res = runRegister({ agentsDir, targetDir, check: true, homeDir });
      const lines = Array.isArray(res?.report) ? [...res.report] : [];
      const drift = Number(res?.drift ?? 0);
      if (drift > 0) {
        exitCode = 1;
        lines.push(`register-pi-agents: ${drift} drift item(s) — re-run without --check to resync.`);
      }
      report = lines.join('\n').trim();
    } catch (e) {
      exitCode = typeof e?.status === 'number' ? e.status : 2;
      report = String(e?.message ?? e).trim();
    }
  }
  if (exitCode === 0) {
    return [{
      id: ID,
      severity: 'PASS',
      summary: 'pi agent registration in sync (register-pi-agents --check exit 0)',
      fix: null,
    }];
  }

  // Surface a short drift excerpt so the operator knows what to re-run.
  const driftLines = report
    .split('\n')
    .filter((l) => /DRIFT|UNEXPECTED|SKIP|drift item/i.test(l))
    .slice(0, 8);
  const excerpt = driftLines.length ? ` — ${driftLines.join('; ')}` : '';

  return [{
    id: ID,
    severity: 'WARN',
    summary: `pi agent registration drifted${excerpt}`,
    fix: `cd ${root} && node bin/register-pi-agents.mjs  # write mode, then re-run --check`,
  }];
}
