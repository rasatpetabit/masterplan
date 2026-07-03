// lib/dispatch/adsp-coord.mjs — masterplan-side coord lifecycle for wave dispatch (T11).
//
// The agent-dispatch coord blackboard (packages/blackboard, exposed as dispatch_coord_*
// MCP tools + the `agent-dispatch coord` CLI) lets wave workers exchange messages.
// This module owns the masterplan side of the coord lifecycle for a multi-task wave:
// open a coord job, register one worker per task, attach per-task coord context
// (root/jobId/agentId) to the routed task payloads, and close the job after the wave.
//
// Workers consume coord via the ARG-BASED coord tool surface (dispatch_coord_post /
// inbox / ask take root+jobId+agentId as args) — no L1-runtime env-threading required,
// because the coord context rides on the task payload into the worker brief. (The
// ~/.pi bridge auto-register T10 is a separate, env-based convenience, not required.)
//
// Sync + fail-open: coord never blocks wave dispatch. Uses the `agent-dispatch` CLI
// over an injectable execFileSync seam (no shell, array args — safe + testable).

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ADSP_BIN = process.env.AGENT_DISPATCH_BIN ?? 'agent-dispatch';
const DEFAULT_COORD_ROOT =
  process.env.ADSP_COORD_ROOT ?? join(homedir(), '.local', 'state', 'agent-dispatch', 'coord');

const defaultExecFile = (bin, args, opts) => execFileSync(bin, args, opts);

function parseJsonOut(buf) {
  try {
    return JSON.parse(String(buf));
  } catch {
    return null;
  }
}

/** Resolve the coord blackboard root (explicit > env > default). */
export function resolveCoordRoot(explicit) {
  return explicit ?? DEFAULT_COORD_ROOT;
}

/**
 * Open a coord job for a wave and register one worker per task. Returns a handle
 * the caller uses to attach per-task coord context and to close the job.
 *
 * Fail-open: any CLI error / degraded result returns an enabled:false handle
 * (attachToTask is identity, close is a no-op) — wave dispatch proceeds without coord.
 *
 * @param {object} opts
 * @param {string} [opts.root]        — blackboard root (default: resolveCoordRoot)
 * @param {number|string} [opts.wave] — wave id (used in jobId/workerIds)
 * @param {object[]} [opts.tasks]     — the wave's routed task payloads (>=1)
 * @param {string} [opts.lead]        — lead agent id (default 'mp-lead')
 * @param {string} [opts.goal]        — job goal text
 * @param {Function} [opts.execFile]  — injectable execFileSync seam (tests)
 * @returns {{enabled:boolean, jobId:string, root:string, lead:string, workerIds:string[], attachToTask:Function, close:Function, reason?:string}}
 */
export function openWaveCoord({ root, wave, tasks, lead, goal, execFile = defaultExecFile } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const bbRoot = resolveCoordRoot(root);
  const leadId = lead ?? 'mp-lead';
  const w = wave ?? 'x';
  const jobId = `mp-wave-${w}-${randomBytes(4).toString('hex')}`;
  const workerIds = list.map((_, i) => `mp-${w}-${i}`);

  // Single (or zero) task — coord adds no value; disabled, no CLI calls.
  if (workerIds.length <= 1) {
    return disabled(bbRoot, jobId, 'single-task wave — coord not needed');
  }

  try {
    const openRes =
      parseJsonOut(
        execFile(ADSP_BIN, ['coord', 'job', 'open', '--job', jobId, '--goal', goal ?? `wave ${w}`, '--lead', leadId, '--root', bbRoot], { stdio: ['ignore', 'pipe', 'pipe'] }),
      ) ?? {};
    if (openRes.degraded) return disabled(bbRoot, jobId, openRes.reason);

    for (const wid of workerIds) {
      const regRes =
        parseJsonOut(
          execFile(ADSP_BIN, ['coord', 'register', '--job', jobId, '--agent', wid, '--root', bbRoot], { stdio: ['ignore', 'pipe', 'pipe'] }),
        ) ?? {};
      // best-effort: a degraded register is non-fatal (the worker may self-register)
    }
  } catch (err) {
    return disabled(bbRoot, jobId, err.message);
  }

  return {
    enabled: true,
    jobId,
    root: bbRoot,
    lead: leadId,
    workerIds,
    /**
     * Attach per-task coord context (root/jobId/agentId/lead) to a routed task payload.
     * Pure: returns a NEW object; does not mutate the input task.
     */
    attachToTask(task, idx) {
      if (!task || idx == null || !workerIds[idx]) return task;
      return { ...task, coord: { root: bbRoot, jobId, agentId: workerIds[idx], lead: leadId } };
    },
    /** Close the coord job best-effort (never throws). */
    close: () => closeWaveCoord({ root: bbRoot, jobId, execFile }),
  };
}

function disabled(root, jobId, reason) {
  return {
    enabled: false,
    jobId,
    root,
    reason,
    workerIds: [],
    attachToTask: (task) => task,
    close: () => ({ skipped: true }),
  };
}

/**
 * Close a coord job best-effort. Never throws — coord must not block teardown.
 * (coord_close is idempotent: returns existing closed_ts if already closed.)
 *
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {string} opts.jobId
 * @param {Function} [opts.execFile] — injectable execFileSync seam (tests)
 * @returns {object} coord_close result, or a degraded envelope on failure
 */
export function closeWaveCoord({ root, jobId, execFile = defaultExecFile } = {}) {
  if (!jobId) return { skipped: true };
  const bbRoot = resolveCoordRoot(root);
  try {
    return (
      parseJsonOut(
        execFile(ADSP_BIN, ['coord', 'job', 'close', '--job', jobId, '--root', bbRoot], { stdio: ['ignore', 'pipe', 'pipe'] }),
      ) ?? { ok: true }
    );
  } catch (err) {
    return { ok: false, degraded: true, reason: `close failed: ${err.message}` };
  }
}
