// lib/doctor/pi-agent-registration.mjs — host drift of pi-installed mp-* agents.
//
// After the gateway-wrapper migration every canonical agents/mp-*.md declares
// model: fable; bin/register-pi-agents.mjs maps that to litellm/fable-5 and
// writes bare + masterplan: copies under ~/.pi/agent/agents/. When the install
// drifts (stale opus pins, missing copies, body mismatch) pi silently runs the
// wrong profile.
//
// This check shells out to `node bin/register-pi-agents.mjs --check` (the same
// CLI operators run) so there is one source of truth for "in sync". Sync via
// execFileSync — doctor checks must be synchronous.
//
// Severity:
//   PASS  — exit 0 (0 drift)
//   WARN  — non-zero exit with drift report (re-run write mode)
//   SKIP  — no ~/.pi/agent/agents dir (not a pi host), or script missing
//
// opts.homeDir / opts.execFileSync / opts.repoRoot / opts.nodeBin are injectable
// for tests (never touch the real host from fixtures unless intended).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ID = 'pi-agent-registration';

function defaultRepoRoot() {
  // lib/doctor/ → repo root is ../..
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * @param {string} repoRoot
 * @param {{
 *   homeDir?: string,
 *   execFileSync?: typeof defaultExecFileSync,
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
  const execFileSync = opts.execFileSync ?? defaultExecFileSync;
  const nodeBin = opts.nodeBin ?? process.execPath;

  if (!fs.existsSync(scriptPath)) {
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

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(nodeBin, [scriptPath, '--check'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1;
    stdout = String(e.stdout ?? '');
    stderr = String(e.stderr ?? e.message ?? e);
  }

  const report = `${stdout}\n${stderr}`.trim();
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
