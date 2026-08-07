// lib/dispatch/broker-client.mjs — MCP stdio client for the agent-dispatch broker.
//
// Spawns `agent-dispatch serve-mcp` (or the injected binary) and manages the
// request/response lifecycle. This is the only I/O seam the adapter uses —
// injectable for tests via `options._brokerClient` so no real broker process
// is spawned in unit tests. Caller is responsible for calling client.close()
// when done (the broker process is killed).

import { spawn } from 'node:child_process';
import {
  assertAllowlistAcceptsBashC,
  CONTRACT_VERSION,
  DEFAULT_SKYNET_VERIFY_ALLOWLIST,
} from './verify-transport.mjs';

/** Default agent-dispatch binary name (resolved via PATH). */
const DEFAULT_BROKER_BIN = 'agent-dispatch';

// ---------------------------------------------------------------------------
// MCP stdio client (broker wire protocol)
// ---------------------------------------------------------------------------

/**
 * Create a minimal MCP stdio client that speaks newline-delimited JSON-RPC.
 *
 * Spawns `agent-dispatch serve-mcp` (or the injected binary) and manages the
 * request/response lifecycle. Caller is responsible for calling client.close()
 * when done (the broker process is killed).
 *
 * This is the only I/O seam the adapter uses — injectable for tests via
 * `options._brokerClient` so no real broker process is spawned in unit tests.
 *
 * @param {{ bin?: string }} [opts]
 * @returns {{ callTool: Function, initialize: Function, close: Function }}
 */
export function createBrokerClient(opts = {}) {
  const bin = opts.bin ?? DEFAULT_BROKER_BIN;
  // Fabric verify packaging wraps verify[0] as `bash -c …`. Unless the caller
  // already set SKYNET_VERIFY_ALLOWLIST, inject the default so the gateway
  // accepts the wrapped form. Caller-set values are preserved (and must
  // include bash -c — assertAllowlistAcceptsBashC enforces that at prepare).
  const env = { ...process.env, ...(opts.env ?? {}) };
  if (env.SKYNET_VERIFY_ALLOWLIST == null || String(env.SKYNET_VERIFY_ALLOWLIST).trim() === '') {
    env.SKYNET_VERIFY_ALLOWLIST = DEFAULT_SKYNET_VERIFY_ALLOWLIST;
  }
  const child = spawn(bin, ['serve-mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  // Expose the effective allowlist so dispatch-wave can stamp it on the record.
  const effectiveAllowlist = env.SKYNET_VERIFY_ALLOWLIST;

  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message ?? 'broker error'));
      } else {
        waiter.resolve(msg.result);
      }
    }
  });

  child.on('error', (err) => {
    for (const w of pending.values()) w.reject(err);
    pending.clear();
  });

  child.on('close', (code, signal) => {
    if (pending.size === 0) return;
    const err = new Error(`broker process exited: code=${code} signal=${signal}`);
    for (const w of pending.values()) w.reject(err);
    pending.clear();
  });

  function request(method, params) {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(frame);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  return {
    /** Effective SKYNET_VERIFY_ALLOWLIST for the spawned serve-mcp child. */
    skynetVerifyAllowlist: effectiveAllowlist,
    /** Send the MCP initialize handshake (required before any tool/method calls). */
    async initialize() {
      const result = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'adsp-adapter', version: CONTRACT_VERSION },
      });
      notify('notifications/initialized', {});
      return result;
    },

    /**
     * Call a broker tool by name.
     * @param {string} name   Tool name (e.g. 'dispatch_task').
     * @param {object} args   Tool arguments object.
     * @returns {Promise<object>}
     */
    async callTool(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      // MCP tools/call returns { content: [{type:'text', text: ...}] }
      if (Array.isArray(result?.content)) {
        const text = result.content.map((c) => c.text ?? '').join('');
        try {
          return JSON.parse(text);
        } catch {
          return { _raw: text };
        }
      }
      return result;
    },

    /** Kill the broker process and clean up pending requests. */
    close() {
      child.kill();
    },
  };
}
