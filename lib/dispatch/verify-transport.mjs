// lib/dispatch/verify-transport.mjs — fabric edit-verify transport packaging
// (orchestrator side of the seam).
//
// Gateway (skynet-mcp / packages/core/gateway-edit.mjs) shlex-parses verify[0]
// with NO shell: bare `cd X && …` ENOENTs and `$(…)` false-fails. We package
// verify_commands[0] as `bash -c '…'` in the object form {command,cwd,timeout}
// that normalizeVerifyForGateway already honors. Elements 1+ are the
// orchestrator's duty (runLocalVerifyCommands below, invoked from dispatch-wave).

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Contract version (pinned; both sides must agree)
// ---------------------------------------------------------------------------

/** Pinned contract version for this adapter. */
export const CONTRACT_VERSION = 'adsp-v1.1';

/** Default gateway verify timeout (seconds) when state.dispatch.verify_timeout_s is unset. */
export const DEFAULT_VERIFY_TIMEOUT_S = 300;

/** Default SKYNET_VERIFY_ALLOWLIST when the dispatcher owns the serve-mcp spawn. */
export const DEFAULT_SKYNET_VERIFY_ALLOWLIST = 'bash -c';

// ---------------------------------------------------------------------------
// Fabric edit-verify transport packaging
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escape for embedding `raw` inside `bash -c '…'`.
 * Byte-preserving: only `'` → `'"'"'`.
 * @param {string} raw
 * @returns {string}
 */
export function posixSingleQuote(raw) {
  return String(raw ?? '').replace(/'/g, `'"'"'`);
}

/**
 * Wrap a verify command for the gateway: `bash -c '<escaped>'`.
 * Idempotent — already-prefixed `bash -c …` forms are returned unchanged
 * (whitespace-tolerant on the prefix only).
 * @param {string} command
 * @returns {string}
 */
export function wrapVerifyCommandForGateway(command) {
  const cmd = String(command ?? '');
  if (/^\s*bash\s+-c\s+/.test(cmd)) return cmd;
  return `bash -c '${posixSingleQuote(cmd)}'`;
}

/**
 * Assert a caller-set SKYNET_VERIFY_ALLOWLIST can accept our bash -c wrapper.
 * Fail loud at PREPARE time — never dispatch a wave the gateway will reject.
 * @param {string|null|undefined} allowlist
 * @throws {Error} when set and missing `bash -c`
 */
export function assertAllowlistAcceptsBashC(allowlist) {
  if (allowlist == null || String(allowlist).trim() === '') return;
  const raw = String(allowlist);
  // Allowlist is typically space-or-comma separated tokens / command prefixes.
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const ok = tokens.some((t) => t === 'bash' || t === 'bash -c' || t.startsWith('bash '))
    || /\bbash\s+-c\b/.test(raw)
    || tokens.includes('bash -c');
  // Also accept a single entry that is exactly the default.
  if (ok || raw.trim() === 'bash -c') return;
  throw new Error(
    `SKYNET_VERIFY_ALLOWLIST is set but does not include 'bash -c' (got ${JSON.stringify(raw)}). ` +
    `prepareDispatch wraps verify[0] as bash -c; the gateway will reject every wrapped verify. ` +
    `Add 'bash -c' to the allowlist or unset SKYNET_VERIFY_ALLOWLIST so the fabric default applies.`,
  );
}

/**
 * Package verify_commands for the gateway wire form.
 * Returns an array whose [0] is {command, cwd, timeout} (or empty when no cmds).
 * Original list is NOT mutated; task-spec hash still uses the raw strings.
 *
 * @param {string[]} verifyCommands
 * @param {{ cwd?: string, timeoutS?: number, allowlist?: string|null }} [opts]
 * @returns {Array<{command: string, cwd?: string, timeout: number}|string>}
 */
export function packageGatewayVerify(verifyCommands, opts = {}) {
  const list = Array.isArray(verifyCommands) ? verifyCommands : [];
  if (list.length === 0) return [];
  assertAllowlistAcceptsBashC(opts.allowlist);
  const timeout = Number.isFinite(opts.timeoutS) && opts.timeoutS > 0
    ? opts.timeoutS
    : DEFAULT_VERIFY_TIMEOUT_S;
  const cwd = opts.cwd;
  const first = list[0];
  const rawCmd = typeof first === 'string'
    ? first
    : (first && typeof first === 'object' && typeof first.command === 'string' ? first.command : '');
  if (!rawCmd.trim()) return [];
  const wrapped = wrapVerifyCommandForGateway(rawCmd);
  /** @type {{command: string, cwd?: string, timeout: number}} */
  const entry = { command: wrapped, timeout };
  if (cwd != null && String(cwd).length > 0) entry.cwd = String(cwd);
  // Gateway only runs [0]; keep any remaining raw strings for audit visibility
  // (orchestrator re-runs the FULL original list locally).
  return [entry, ...list.slice(1)];
}

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
