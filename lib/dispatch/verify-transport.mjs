// lib/dispatch/verify-transport.mjs — local edit-verify transport (orchestrator side).
//
// Wave children (harness-native spawn) report their worker digest; the FULL
// verify_commands list is re-run locally here as the orchestrator's completion
// duty — one real shell per command, fail-closed on any non-zero exit or
// timeout.

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Contract version (pinned; both sides must agree)
// ---------------------------------------------------------------------------

/** Pinned handoff contract version for the native fabric seam. */
export const CONTRACT_VERSION = 'fabric-native-v1';

/** Default verify timeout (seconds) when state.dispatch.verify_timeout_s is unset. */
export const DEFAULT_VERIFY_TIMEOUT_S = 300;

/**
 * Default recorded verify allowlist for audit continuity. Historical name kept
 * because fleet runbooks set SKYNET_VERIFY_ALLOWLIST; local verification does
 * not gate on it — the value is surfaced in the wave record for audit only.
 */
export const DEFAULT_SKYNET_VERIFY_ALLOWLIST = 'bash -c';

/**
 * Run the FULL verify_commands list under a real shell (bash -c per command).
 * Fail-closed: any non-zero exit or timeout marks that entry failed.
 *
 * @param {string[]} commands
 * @param {{ cwd?: string, timeoutS?: number, _exec?: Function }} [opts]
 * @returns {Array<{command: string, passed: boolean, output: string}>}
 */
export function runLocalVerifyCommands(commands, opts = {}) {
  const list = Array.isArray(commands) ? commands : [];
  const cwd = opts.cwd ?? process.cwd();
  const timeoutS = Number.isFinite(opts.timeoutS) && opts.timeoutS > 0
    ? opts.timeoutS
    : DEFAULT_VERIFY_TIMEOUT_S;
  const execFn = opts._exec;
  const out = [];
  for (const raw of list) {
    const command = typeof raw === 'string'
      ? raw
      : (raw && typeof raw === 'object' && typeof raw.command === 'string' ? raw.command : '');
    if (!command.trim()) {
      out.push({ command: String(raw ?? ''), passed: false, output: 'empty verify command' });
      continue;
    }
    try {
      let stdout;
      if (typeof execFn === 'function') {
        stdout = execFn(command, { cwd, timeoutS });
      } else {
        // Real shell — the whole point of the orchestrator-side full-list duty.
        stdout = execFileSync('bash', ['-c', command], {
          cwd,
          encoding: 'utf8',
          timeout: timeoutS * 1000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      out.push({ command, passed: true, output: String(stdout ?? '').slice(0, 8000) });
    } catch (err) {
      const stderr = err?.stderr != null ? String(err.stderr) : '';
      const stdout = err?.stdout != null ? String(err.stdout) : '';
      const msg = stderr || stdout || (err?.message ?? String(err));
      // node:child_process sets killed=true on timeout; code may be null.
      const timedOut = err?.killed === true
        || err?.code === 'ETIMEDOUT'
        || /ETIMEDOUT|timed out/i.test(String(msg));
      const prefix = timedOut ? `[timeout after ${timeoutS}s] ` : '';
      out.push({
        command,
        passed: false,
        output: (prefix + String(msg || (timedOut ? 'process killed' : 'verify failed'))).slice(0, 8000),
      });
    }
  }
  return out;
}
