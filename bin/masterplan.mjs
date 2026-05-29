#!/usr/bin/env node
// bin/masterplan.mjs — the L1 deterministic adapter (build step 2).
//
// The thin markdown shell (commands/masterplan.md) invokes this CLI for every deterministic,
// zero-LLM-token operation: the version banner, host detection, the resume DECISION, and the
// CD-7 single-writer state mutations. All real logic lives in lib/*.mjs (pure, unit-tested);
// each subcommand here is parse -> call lib -> print. Two hard boundaries (advisor-set):
//   - bin is FILESYSTEM-ONLY. git (commit, and the recover-path `git checkout -- <resetPaths>`)
//     stays in the markdown shell. This is what keeps the write/commit split recoverable
//     (state.yml leads git; a crash between them re-commits idempotently) and bin git-fixture-free.
//   - Results go to STDOUT (action JSON / op result); diagnostics + errors go to STDERR with a
//     non-zero exit, so the shell's stdout parse is always clean.
//
// CD-7: this is a thin front to lib/bundle.mjs (the sole state writer). Wave members never call it.
//
// Subcommands:
//   version [--args=STR] [--cwd=DIR]            -> the CC-2 banner line (the lone CC-2/CC-3 survivor)
//   detect-host [--agent-is-codex] [--native-tools] [--agents-md]
//                                               -> {isCodex, reasons, suppressRescue}
//   decide --state=PATH [--alive]               -> the decideNextAction result (migrates in-memory)
//   migrate-bundle --state=PATH                 -> back up + persist a legacy bundle as v8 (no-op if v8)
//   backfill-waves --state=PATH --plan-index=PATH -> set each task's {wave,files} from plan.index.json
//   mark-task --state=PATH --id=N --status=S    -> CD-7 write: set a task's status
//   open-gate --state=PATH --id=X [--opened-at=T] -> CD-7 write: open the durable approval gate
//   clear-gate --state=PATH                     -> CD-7 write: clear the gate
//   set-active-run --state=PATH --wave=N        -> CD-7 write: phase-1 marker {wave, phase:'launching'}
//   promote-active-run --state=PATH --run-id=X --task-id=Y -> phase-2: attach the launch handles
//   clear-active-run --state=PATH               -> CD-7 write: clear the run marker

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, writeState, openGate, clearGate, setActiveRun, clearActiveRun, markTask } from '../lib/bundle.mjs';
import { migrate, detectSchemaVersion, MigrationError } from '../lib/migrate.mjs';
import { decideNextAction } from '../lib/resume.mjs';
import { detectHost, suppressRescue } from '../lib/codex-host.mjs';
import { resolveConfigDir } from '../lib/paths.mjs';

// ---- tiny arg parser: positional[], flags{} (--k=v, or --k as boolean true) ----
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(obj) {
  process.stdout.write(typeof obj === 'string' ? obj + '\n' : JSON.stringify(obj) + '\n');
}
function die(msg, code = 2) {
  process.stderr.write(`masterplan: ${msg}\n`);
  process.exit(code);
}
function need(flags, key) {
  if (flags[key] === undefined) die(`missing required --${key}`);
  return flags[key];
}

// ---- read helpers: decide migrates in-memory; write ops require an already-v8 bundle ----
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    die(`cannot read state file: ${p}`);
  }
}
// Writes must never silently overwrite an un-migrated legacy bundle (that would lose the original
// before it was backed up). Refuse and point at migrate-bundle, which backs up first.
function loadForWrite(p) {
  const text = readText(p);
  const v = detectSchemaVersion(text);
  const major = v ? Number(v.split('.')[0]) : 0;
  if (major < 6) {
    die(`bundle ${p} is schema ${v ?? 'pre-5.0/unknown'}, not v8 — run \`masterplan migrate-bundle --state=${p}\` first (it backs up the original).`);
  }
  return readState(p);
}

// ---- the CC-2 version banner. plugin.json candidate paths (Read-tool order from v7). ----
function readPluginVersion(cwd, env) {
  const cfg = resolveConfigDir(env, os.homedir());
  const candidates = [
    path.join(cfg, 'plugins/marketplaces/rasatpetabit-masterplan/.claude-plugin/plugin.json'),
    path.join(cwd, '.claude-plugin/plugin.json'),
  ];
  // Best-effort cache path: …/cache/rasatpetabit-masterplan/masterplan/<latest-semver>/.claude-plugin/plugin.json
  const cacheRoot = path.join(cfg, 'plugins/cache/rasatpetabit-masterplan/masterplan');
  try {
    const vers = fs.readdirSync(cacheRoot).filter((d) => /^\d+\.\d+\.\d+/.test(d)).sort(cmpSemver);
    if (vers.length) candidates.push(path.join(cacheRoot, vers[vers.length - 1], '.claude-plugin/plugin.json'));
  } catch { /* no cache dir — fine */ }
  for (const c of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(c, 'utf8'))?.version;
      if (v) return String(v);
    } catch { /* try next */ }
  }
  return null;
}
function cmpSemver(a, b) {
  const pa = a.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : n));
  const pb = b.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : n));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
export function formatBanner(version, args, cwd) {
  const v = version ? `v${version}` : 'vUNKNOWN';
  const a = args && args.length ? args : '(empty)';
  return `→ /masterplan ${v} args: '${a}' cwd: ${cwd}`;
}

// ---- backfill-waves: re-derive each task's {wave, files} from plan.index.json (migrate contract:
// a legacy bundle has no v8 plan.index.json, so migrate leaves wave:null and the shell calls this
// once the plan is (re-)parsed; satisfies decideNextAction's non-integer-wave guard). ----
export function applyPlanIndex(state, planIndex) {
  const list = Array.isArray(planIndex) ? planIndex : Array.isArray(planIndex?.tasks) ? planIndex.tasks : [];
  const byId = new Map(list.map((p) => [p.id ?? p.idx, p]));
  const tasks = (state.tasks ?? []).map((task) => {
    const p = byId.get(task.id);
    if (!p) return task;
    const wave = p.wave ?? p.parallel_group ?? task.wave;
    const files = p.files ?? task.files ?? [];
    return { ...task, wave, files };
  });
  return { ...state, tasks };
}

// ---- subcommand dispatch ----
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);

  switch (cmd) {
    case 'version': {
      const cwd = flags.cwd || process.cwd();
      out(formatBanner(readPluginVersion(cwd, process.env), flags.args || '', cwd));
      break;
    }
    case 'detect-host': {
      const host = detectHost({
        agentIsCodex: !!flags['agent-is-codex'],
        codexNativeTools: !!flags['native-tools'],
        agentsMdPresent: !!flags['agents-md'],
      });
      out({ ...host, suppressRescue: suppressRescue(host) });
      break;
    }
    case 'decide': {
      const text = readText(need(flags, 'state'));
      let state;
      try {
        state = migrate(text); // passthrough for v8, transform for legacy
      } catch (e) {
        if (e instanceof MigrationError) die(e.message);
        throw e;
      }
      try {
        out(decideNextAction(state, { alive: !!flags.alive }));
      } catch (e) {
        die(e.message); // e.g. the non-integer-wave guard: shell must backfill-waves first
      }
      break;
    }
    case 'migrate-bundle': {
      const p = need(flags, 'state');
      const text = readText(p);
      const v = detectSchemaVersion(text);
      const major = v ? Number(v.split('.')[0]) : 0;
      if (major >= 6) {
        out({ migrated: false, reason: 'already-v8', schema_version: v });
        break;
      }
      let migrated;
      try {
        migrated = migrate(text); // throws (no overwrite, original intact) for pre-5.0 / fail-loud
      } catch (e) {
        if (e instanceof MigrationError) die(e.message);
        throw e;
      }
      const backup = `${p}.v${v ?? 'legacy'}.bak`;
      fs.copyFileSync(p, backup); // preserve the original verbatim BEFORE overwriting
      writeState(p, migrated);
      out({ migrated: true, from: v, backup });
      break;
    }
    case 'backfill-waves': {
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const planIndex = JSON.parse(readText(need(flags, 'plan-index')));
      const next = applyPlanIndex(state, planIndex);
      writeState(p, next);
      out({ updated: next.tasks.length });
      break;
    }
    case 'mark-task': {
      const p = need(flags, 'state');
      const id = coerceId(need(flags, 'id'));
      const status = need(flags, 'status');
      writeState(p, markTask(loadForWrite(p), id, status));
      out({ id, status });
      break;
    }
    case 'open-gate': {
      const p = need(flags, 'state');
      const gate = { id: need(flags, 'id'), opened_at: flags['opened-at'] ?? null };
      writeState(p, openGate(loadForWrite(p), gate));
      out({ pending_gate: gate });
      break;
    }
    case 'clear-gate': {
      const p = need(flags, 'state');
      writeState(p, clearGate(loadForWrite(p)));
      out({ pending_gate: null });
      break;
    }
    case 'set-active-run': {
      const p = need(flags, 'state');
      const run = { wave: coerceId(need(flags, 'wave')), phase: 'launching' };
      writeState(p, setActiveRun(loadForWrite(p), run));
      out({ active_run: run });
      break;
    }
    case 'promote-active-run': {
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const prev = state.active_run ?? {};
      const run = { wave: prev.wave, run_id: need(flags, 'run-id'), task_id: need(flags, 'task-id') };
      writeState(p, setActiveRun(state, run));
      out({ active_run: run });
      break;
    }
    case 'clear-active-run': {
      const p = need(flags, 'state');
      writeState(p, clearActiveRun(loadForWrite(p)));
      out({ active_run: null });
      break;
    }
    default:
      die(`unknown subcommand: ${cmd ?? '(none)'}`, 2);
  }
}

function coerceId(v) {
  return /^-?\d+$/.test(String(v)) ? Number(v) : v;
}

// Run only when executed directly (`node bin/masterplan.mjs …`), not when imported by tests
// (which need formatBanner/applyPlanIndex without triggering the CLI dispatch + process.exit).
function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false; // argv[1] not a real path (e.g. `node --test`) -> imported, not executed
  }
}
if (isMain()) main();
