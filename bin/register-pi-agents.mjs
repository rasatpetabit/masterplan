// bin/register-pi-agents.mjs — register the masterplan agents for a pi host.
//
// Claude Code discovers agents/mp-*.md via its plugin loader as the
// `masterplan:mp-*` namespace. Pi hosts need adapted copies under
// `~/.pi/agent/agents/` with the `model:` line swapped via MODEL_MAP
// (aliases are the routing-policy lane names, mapped to their lane model refs).
//
// Registration is **bare-only**: one file per agent (`mp-X.md`). Colon alias
// copies (`masterplan:mp-X.md`) are no longer emitted. On write, managed
// leftover colon files (one per agents/mp-*.md basename, including SKIP_FOR_PI)
// are removed. --check reports those leftovers as drift. Unmanaged
// masterplan:mp-*.md files outside the managed set are left alone (UNEXPECTED
// only if they match owned bare patterns that this run did not produce).
//
// CD-1 (project-local tooling): invoked as `node bin/register-pi-agents.mjs`. No deps.
// Fail-closed CLI: only `--check` and `--help` are recognized; any other option or
// unexpected argument is rejected with exit 2 BEFORE any filesystem access. This
// script MUTATES ~/.pi/agent/agents/ in write mode, so an unknown flag must never
// fall through to a write (the A6 repair — previously `--help`/any typo ran a full
// write and exited 0).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { laneAliasMap } from '../lib/dispatch/routing-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PI_USER_AGENTS_DIR = join(homedir(), '.pi', 'agent', 'agents');

// Live-alias map, DERIVED from the repo-local routing policy
// (policy/workflow-map.json): every lane name is an alias for its lane model ref
// (litellm/...). Agent frontmatter declares a LANE (`model: frontier`), and
// registration swaps it for the lane's model ref. The policy file is the only
// place model ids appear, so a fleet model change turns this map over
// automatically; the test suite re-derives the same map from the policy, so any
// drift between a declared alias and the policy fails closed.
const MODEL_MAP = laneAliasMap();

function resolveRepoRoot() {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch { /* fall through to module-derived root */ }
  return REPO_ROOT;
}

// Historical CC plugin namespace prefix. Colon alias *generation* is retired;
// the constant remains so managed cleanup can target leftover masterplan:mp-*.md.
const COLON_PREFIX = 'masterplan:';

// Agents that are CC-only by design and must NOT be registered for pi. worker-digest's
// entire contract is "route every edit to the local skynet MCP" — it has no Edit/Write
// tool BY DESIGN; pi has no skynet MCP server.
// Skip bare install; managed colon leftovers for this name are still cleaned.
const SKIP_FOR_PI = new Set(['mp-implementer.md']);

function mapModelLine(body, file) {
  // NOTE: the regex anchors on the first `^model:` line. The canonical agents/*.md keep
  // `model:` only in frontmatter, so this is safe for them; it is deliberately simple
  // rather than a full YAML parse. (Accept the low risk: we own agents/*.md.)
  const m = body.match(/^model:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`${file}: no \`model:\` frontmatter line to map`);
  const alias = m[1];
  const mapped = MODEL_MAP[alias];
  if (!mapped) throw new Error(`${file}: model alias \`${alias}\` has no pi mapping (extend MODEL_MAP)`);
  return { alias, mapped, body: body.replace(/^model:\s*\S+\s*$/m, `model: ${mapped}`) };
}

// Kept for unit-test compatibility / historical callers; no longer used by write path.
function mapNameLine(body, file) {
  const m = body.match(/^name:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`${file}: no \`name:\` frontmatter line to prefix`);
  const base = m[1];
  if (base.startsWith(COLON_PREFIX)) return body;
  return body.replace(/^name:\s*\S+\s*$/m, `name: ${COLON_PREFIX}${base}`);
}

// Bare-only: one pi file per CC agent (model line swapped; name unchanged).
function outputsFor(file, modelSwappedBody) {
  const base = file.replace(/\.md$/, '');
  return [{ rel: `${base}.md`, body: modelSwappedBody }];
}

/** Managed colon alias path for a source basename (e.g. mp-planner.md → masterplan:mp-planner.md). */
function managedColonRel(file) {
  return `${COLON_PREFIX}${file}`;
}

// Pure, filesystem-driven core. main() wraps this with real dirs + argv; tests call it
// with temp dirs. `check` mode is strictly read-only (no writes, no deletes, no mkdir);
// it reports drift (mismatch, missing, stale, or unexpected files) and returns a count.
export function runRegister({ agentsDir, targetDir, check }) {
  const files = readdirSync(agentsDir).filter((f) => /^mp-.*\.md$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no mp-*.md found under ${agentsDir}`);

  // Write mode ensures the target dir exists; check mode must NOT create anything.
  if (!check) mkdirSync(targetDir, { recursive: true });

  let drift = 0;
  let written = 0;
  let skipped = 0;
  let removed = 0;
  const report = [];
  // Dest filenames this run owns for orphan detection (bare only) + managed colon names
  // we deliberately clean (expected so they are not UNEXPECTED, but handled separately).
  const expectedBare = new Set();
  const managedColon = new Set();

  for (const file of files) {
    managedColon.add(managedColonRel(file));

    if (SKIP_FOR_PI.has(file)) {
      const why = 'CC-only (skynet MCP edit contract; no pi caller)';
      // Stale bare + managed colon for skipped agents: check → drift; write → remove.
      for (const rel of [`${file}`, managedColonRel(file)]) {
        expectedBare.add(rel); // suppress UNEXPECTED for these managed paths
        const stale = join(targetDir, rel);
        if (existsSync(stale)) {
          if (check) {
            drift++;
            report.push(`DRIFT  ${rel} (stale: ${file} is now CC-only / colon retired; re-run without --check to remove)`);
          } else {
            unlinkSync(stale);
            removed++;
            report.push(`RMSTALE ${rel}  (${file} is now CC-only / colon retired)`);
          }
        }
      }
      report.push(`SKIP   ${file}  (${why})`);
      skipped++;
      continue;
    }

    const srcBody = readFileSync(join(agentsDir, file), 'utf8');
    const { alias, mapped, body } = mapModelLine(srcBody, file);
    for (const out of outputsFor(file, body)) {
      expectedBare.add(out.rel);
      const dstPath = join(targetDir, out.rel);
      if (check) {
        const installed = existsSync(dstPath) ? readFileSync(dstPath, 'utf8') : null;
        if (installed !== out.body) {
          drift++;
          report.push(`DRIFT  ${out.rel} (installed ${installed === null ? 'MISSING' : 'differs from canonical+map'})`);
        } else {
          report.push(`OK     ${out.rel}  ${alias} → ${mapped}`);
        }
      } else {
        writeFileSync(dstPath, out.body, 'utf8');
        written++;
        report.push(`WROTE  ${out.rel}  (${alias} → ${mapped})`);
      }
    }

    // Managed colon leftover for non-skipped agents (retired dual-reg).
    const colonRel = managedColonRel(file);
    expectedBare.add(colonRel);
    const colonPath = join(targetDir, colonRel);
    if (existsSync(colonPath)) {
      if (check) {
        drift++;
        report.push(`DRIFT  ${colonRel} (retired colon alias; re-run without --check to remove)`);
      } else {
        unlinkSync(colonPath);
        removed++;
        report.push(`RMCOLON ${colonRel}  (bare-only registration)`);
      }
    }
  }

  // Orphan detection for bare mp-*.md not produced this run.
  // Unmanaged masterplan:mp-*.md outside managedColon are IGNORED (not drift, not deleted).
  if (existsSync(targetDir)) {
    for (const name of readdirSync(targetDir)) {
      if (!/^mp-.*\.md$/.test(name)) continue; // bare only for unexpected
      if (expectedBare.has(name)) continue;
      const note = `UNEXPECTED ${name} (not produced from current agents/*.md — manual review)`;
      if (check) { drift++; report.push(`DRIFT  ${note}`); }
      else { report.push(note); }
    }
  }

  return { report, drift, written, skipped, removed, registered: files.length - skipped, managedColon: [...managedColon] };
}

// Exported for unit tests (test/register-pi-agents.test.mjs). main() is the only thing
// that touches the real host filesystem; runRegister takes explicit dirs.
export { MODEL_MAP, COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor, managedColonRel };

const USAGE = `Usage: node bin/register-pi-agents.mjs [--check] [--help]

Registers the masterplan agents for a pi host: writes bare mp-*.md copies
under ~/.pi/agent/agents/ with the model: line swapped via the routing-policy
lane map (see docs/development.md). Colon alias copies are retired and cleaned.

Options:
  --check   Read-only drift check: compare installed files against canonical
            agents/mp-*.md + model map. Reports drift; exits 1 on drift, 0 when
            in sync. Never writes, deletes, or creates anything.
  --help    Print this help and exit. Read-only — performs no writes.

Any unrecognized option or unexpected argument is rejected with exit 2.
This script MUTATES ~/.pi/agent/agents/ in write mode, so an unknown flag
must never fall through to a write. (--help and typo paths are safe: they
change nothing on disk.)
`;

/**
 * Strict, fail-closed CLI parser. Recognized options only: --check, --help.
 * Anything else — unknown flags OR positional args — throws; main() maps the
 * throw to stderr + exit 2 before any filesystem access. `--help` short-circuits
 * in main() and returns before runRegister is ever called.
 */
export function parseCliArgs(argv) {
  const opts = { check: false, help: false };
  for (const arg of argv) {
    if (arg === '--check') { opts.check = true; continue; }
    if (arg === '--help') { opts.help = true; continue; }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}\n\n${USAGE}`);
    }
    throw new Error(`unexpected argument: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`register-pi-agents: ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const check = opts.check;
  const agentsDir = join(resolveRepoRoot(), 'agents');
  const targetDir = PI_USER_AGENTS_DIR;
  const { report, drift, written, skipped, removed, registered } = runRegister({ agentsDir, targetDir, check });

  for (const line of report) console.error(line);
  if (check) {
    if (drift > 0) {
      console.error(`register-pi-agents: ${drift} drift item(s) — re-run without --check to resync.`);
      process.exit(1);
    }
    const skipNote = skipped > 0 ? `, ${skipped} skipped (CC-only)` : '';
    console.error(`register-pi-agents: ${registered} agent(s) (bare-only${skipNote}) in sync at ${targetDir}`);
  } else {
    const parts = [`${written} wrote`, `${registered} bare`];
    if (removed > 0) parts.push(`${removed} retired/stale removed`);
    if (skipped > 0) parts.push(`${skipped} skipped (CC-only)`);
    console.error(`register-pi-agents: ${parts.join(' · ')} — to ${targetDir}`);
    console.error('register-pi-agents: verify with `node bin/register-pi-agents.mjs --check` (drift) and bare subagent probes.');
  }
}

// Run main() only when executed directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
