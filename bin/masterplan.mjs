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
//   prepare-wave --state=PATH --plan-index=PATH --wave=N [--routing=M] [--codex-suppressed]
//                [--linked-worktree] [--review=on|off]
//                                               -> {wave, tasks:[lean routed payload], review} for the L2 `args`
//                                                  (--review overrides state.codex.review; else read from state)
//   verify-scope --state=PATH --wave=N --before=JSON --after=JSON -> {ok, touched, outOfScope} (D6 post-barrier)
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
import { prepareWave, declaredScope, verifyScope } from '../lib/wave.mjs';
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

// Valid task statuses the v8 shell may WRITE via mark-task. Minimal + decide-consistent:
// decideNextAction treats anything !== 'done' as "still needs work", so pending/in_progress map
// correctly and a typo ('doen', 'complete') is rejected rather than silently mis-recorded. (Legacy
// v7 statuses like 'skipped'/'in-progress' live only in pre-migration bundles — migrate's concern.)
const VALID_TASK_STATUS = ['pending', 'in_progress', 'done'];

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
export function readPluginVersion(cwd, env) {
  const cfg = resolveConfigDir(env, os.homedir());
  const candidates = [
    // candidate #0: the actually-loaded plugin root (Claude Code sets CLAUDE_PLUGIN_ROOT when the
    // shell runs `mp`). Authoritative + marketplace-name-agnostic, so a registry swap under a
    // non-canonical marketplace name (e.g. the masterplan-v8 scoped deploy) still reports the
    // running version instead of falling back to a stale same-named clone.
    env.CLAUDE_PLUGIN_ROOT && path.join(env.CLAUDE_PLUGIN_ROOT, '.claude-plugin/plugin.json'),
    path.join(cfg, 'plugins/marketplaces/rasatpetabit-masterplan/.claude-plugin/plugin.json'),
    path.join(cwd, '.claude-plugin/plugin.json'),
  ].filter(Boolean);
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
  // Key by STRING id on both sides: plan.index.json ids are often strings ("1") while migrated
  // state task ids are numbers (1). A raw-keyed Map misses on that type mismatch, leaving wave:null
  // (then decide's non-integer-wave guard throws). Normalize so the lookup is type-insensitive.
  const byId = new Map(list.map((p) => [String(p.id ?? p.idx), p]));
  const tasks = (state.tasks ?? []).map((task) => {
    const p = byId.get(String(task.id));
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
      const tasks = next.tasks ?? [];
      // Don't report success while pending tasks remain wave-less — decide would throw on the next
      // resume. Fail loud (before writing) with the offending ids so the user can fix plan.index.
      const stuck = tasks.filter((task) => task.status !== 'done' && !Number.isInteger(task.wave));
      if (stuck.length) {
        die(`backfill-waves: ${stuck.length} pending task(s) still have no integer wave after applying ` +
            `plan-index (ids: ${stuck.map((t) => t.id).join(', ')}) — id mismatch, missing wave/parallel_group, ` +
            `or a non-integer wave value (e.g. "2" instead of 2) in plan.index.json.`, 1);
      }
      writeState(p, next);
      out({ updated: tasks.filter((task) => Number.isInteger(task.wave)).length, total: tasks.length });
      break;
    }
    case 'prepare-wave': {
      // Pre-resolve everything the L2 workflow needs for one wave, since a Workflow script has
      // NO module/fs access — "L2 consumes routing.mjs" can only mean L1 resolves routing here and
      // hands lean payloads down via `args`. loadForWrite is the strict-v8 guard (this is a read,
      // but mid-run the bundle is already v8; a legacy one reaching here should fail loud, not route).
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const planIndex = JSON.parse(readText(need(flags, 'plan-index')));
      const wave = coerceId(need(flags, 'wave'));
      // routing config: persisted `codex.routing` wins; --routing overrides; default 'auto'. env facts
      // (host-suppression, linked-worktree) are git/host-probed by the shell and passed as flags.
      const config = { routing: state.codex?.routing ?? flags.routing ?? 'auto' };
      const env = {
        codexHostSuppressed: !!flags['codex-suppressed'],
        linkedWorktree: !!flags['linked-worktree'],
      };
      let result;
      try {
        result = prepareWave(state, planIndex, wave, config, env); // throws: non-integer wave / drift
      } catch (e) {
        die(e.message);
      }
      // Surface the review mode from the SAME read so the shell needn't parse state.yml itself; the
      // workflow gates review on `=== 'on'`. Normalize leniently (config schema is finalized in step 7).
      const rawReview = state.codex?.review ?? flags.review;
      const review = rawReview === true || rawReview === 'on' || rawReview === 'true' ? 'on' : 'off';
      out({ ...result, review });
      break;
    }
    case 'verify-scope': {
      // The D6/F-SCOPE post-barrier check. declared = every wave-N task's files (done included — at
      // the barrier nothing is committed yet); before/after are the git-touched path sets the SHELL
      // captures (git stays in the shell; bin is fs-only) and passes as JSON arrays. verifyScope does
      // the (after - before) ⊆ declared set math. The shell resets/ surfaces any outOfScope path.
      const p = need(flags, 'state');
      const wave = coerceId(need(flags, 'wave'));
      const declared = declaredScope(loadForWrite(p), wave);
      let before;
      let after;
      try {
        before = JSON.parse(flags.before ?? '[]');
        after = JSON.parse(flags.after ?? '[]');
      } catch (e) {
        die(`verify-scope: --before/--after must be JSON arrays of paths (${e.message})`);
      }
      out(verifyScope(declared, before, after));
      break;
    }
    case 'mark-task': {
      const p = need(flags, 'state');
      const id = coerceId(need(flags, 'id'));
      const status = need(flags, 'status');
      if (!VALID_TASK_STATUS.includes(status)) {
        die(`invalid --status '${status}' — expected one of: ${VALID_TASK_STATUS.join(', ')}`);
      }
      let next;
      try {
        next = markTask(loadForWrite(p), id, status); // throws on unknown id — refuse a phantom success
      } catch (e) {
        die(e.message);
      }
      writeState(p, next);
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
      const wave = coerceId(need(flags, 'wave'));
      // set-active-run is the SOLE ORIGIN of the active_run wave; enforce the integer-wave invariant
      // HERE at the source (mirror of promote's guard below). Without it a `--wave=2.0`/`--wave=foo`/
      // bare `--wave` persists a phase-1 marker that decideNextAction then throws on at the next
      // `decide`, wedging the loop until a manual clear-active-run. Fail loud on bad input instead.
      if (!Number.isInteger(wave)) {
        die(`set-active-run: --wave must be an integer (got ${JSON.stringify(flags.wave)}) — it is the ` +
            `phase-1 launching marker's wave that decideNextAction resumes on.`);
      }
      const run = { wave, phase: 'launching' };
      writeState(p, setActiveRun(loadForWrite(p), run));
      out({ active_run: run });
      break;
    }
    case 'promote-active-run': {
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const prev = state.active_run ?? {};
      // Phase-2 promotion MUST follow a phase-1 launching marker carrying an integer wave
      // (set-active-run --wave=N). Promoting without it writes a wave-less active_run that
      // decideNextAction then mis-finalizes while tasks pend (orphan / double-dispatch). Fail loud.
      if (!Number.isInteger(prev.wave)) {
        die(`promote-active-run: no phase-1 launching marker with an integer wave ` +
            `(active_run=${JSON.stringify(state.active_run ?? null)}) — call \`set-active-run --wave=N\` first.`);
      }
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
