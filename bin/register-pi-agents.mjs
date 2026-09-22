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

// ---------------------------------------------------------------------------
// Host-local lane overrides
//
// MODEL_MAP stays an EXACT mirror of the routing policy — the test suite asserts
// that declared aliases and the map agree — so overrides are applied as a
// SEPARATE layer at the point of use and are never merged into the map.
//
// Why this exists: a lane can be unusable on one host while remaining correct
// fleet-wide, and before this seam the only workaround was hand-editing the
// generated files under ~/.pi/agent/agents, which `install-pi.mjs --check`
// correctly reports as drift and which the next install silently erases.
//
// Three properties are deliberate:
//   - host-local, under $HOME and never in the repo, so one host's workaround is
//     not shipped to every other host;
//   - it requires a `reason` and a `decided_by`, because fleet policy reserves a
//     governed-lane model change to an explicit operator decision and the file
//     must show that one happened rather than leaving an anonymous pin;
//   - it defaults to NO overrides at every exported seam, so the test suite stays
//     deterministic and cannot depend on the state of whichever machine runs it.
//     Only the real entry points (this file's main, and install-pi.mjs) load the
//     host file and pass it in explicitly.
// ---------------------------------------------------------------------------
const LANE_OVERRIDE_PATH = join(homedir(), '.config', 'masterplan', 'lane-overrides.json');

/**
 * Read and validate the host-local override file. A missing file is not an error
 * (it means no overrides); an unreadable or malformed one IS, and is never
 * silently ignored — ignoring it would re-point every governed agent at the lane
 * the file exists to move them off, with no explanation anywhere.
 */
export function loadLaneOverrides(overridePath = LANE_OVERRIDE_PATH) {
  let raw;
  try {
    raw = readFileSync(overridePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw new Error(`lane-overrides: ${overridePath} is unreadable (${e.message}) — refusing to register agents against a lane map I could not fully read`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`lane-overrides: ${overridePath} is not valid JSON (${e.message}) — refusing rather than ignoring, because ignoring it would silently re-point agents at the lane this file exists to move them off`);
  }
  const entries = parsed && parsed.overrides;
  if (entries === undefined || entries === null) return {};
  if (typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(`lane-overrides: ${overridePath} "overrides" must be an object keyed by lane name`);
  }
  for (const [lane, o] of Object.entries(entries)) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      throw new Error(`lane-overrides: ${overridePath} override for lane \`${lane}\` must be an object carrying model, reason and decided_by`);
    }
    for (const k of ['model', 'reason', 'decided_by']) {
      if (typeof o[k] !== 'string' || o[k].trim() === '') {
        throw new Error(`lane-overrides: ${overridePath} override for lane \`${lane}\` is missing a non-empty \`${k}\` — an anonymous pin is exactly what this mechanism replaces`);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(MODEL_MAP, lane)) {
      throw new Error(`lane-overrides: ${overridePath} names lane \`${lane}\`, which the routing policy does not declare — a typo here would silently leave agents on the lane this file exists to move them off`);
    }
    if (!o.model.startsWith('litellm/')) {
      process.stderr.write(`lane-overrides: warning — lane \`${lane}\` -> \`${o.model}\` is not a \`litellm/\` ref, unlike every lane in the routing policy\n`);
    }
  }
  return entries;
}

/** The model a lane resolves to given an override layer: the policy ref, unless overridden. */
export function effectiveModel(alias, overrides = {}) {
  const o = overrides[alias];
  return o ? o.model : MODEL_MAP[alias];
}

/**
 * One stderr line per applied override, so a divergence from fleet routing is
 * visible in every install log rather than only in the generated files.
 */
export function reportLaneOverrides(overrides = {}) {
  const lanes = Object.keys(overrides);
  for (const lane of lanes) {
    const o = overrides[lane];
    process.stderr.write(
      `lane-overrides: ${lane}: ${MODEL_MAP[lane]} -> ${o.model} (decided_by: ${o.decided_by}) — ${o.reason}\n`,
    );
  }
  return lanes.length;
}

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

// Agents that are CC-only by design and must NOT be registered for pi. Empty since
// fresh-eyes-remediation C7 (2026-08-30) deleted mp-implementer.md — the mechanism stays:
// any future CC-only agent is added here (and gets a test via runRegister's skipSet seam).
// Skip bare install; managed colon leftovers for listed names are still cleaned.
const SKIP_FOR_PI = new Set();

function mapModelLine(body, file, overrides = {}) {
  // NOTE: the regex anchors on the first `^model:` line. The canonical agents/*.md keep
  // `model:` only in frontmatter, so this is safe for them; it is deliberately simple
  // rather than a full YAML parse. (Accept the low risk: we own agents/*.md.)
  const m = body.match(/^model:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`${file}: no \`model:\` frontmatter line to map`);
  const alias = m[1];
  const mapped = effectiveModel(alias, overrides);
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
// Owned-files manifest: the tool's memory of which target files it manages.
// Write mode removes previously-managed files whose source agent is gone;
// files that never appear in a manifest are NEVER touched (they may be
// user-authored) — they surface as UNEXPECTED for manual review instead.
const MANAGED_MANIFEST = '.masterplan-managed.json';

function loadManagedManifest(targetDir) {
  try {
    const m = JSON.parse(readFileSync(join(targetDir, MANAGED_MANIFEST), 'utf8'));
    if (m && m.schema === 1 && Array.isArray(m.files)) return new Set(m.files.map(String));
  } catch {
    /* missing or corrupt manifest -> pre-manifest adoption semantics: adopt only
       the current canonical outputs, never delete anything unknown */
  }
  return new Set();
}

function writeManagedManifest(targetDir, files) {
  writeFileSync(
    join(targetDir, MANAGED_MANIFEST),
    JSON.stringify({ schema: 1, files: [...files].sort() }, null, 2) + '\n',
    'utf8',
  );
}

export function runRegister({ agentsDir, targetDir, check, skipSet = SKIP_FOR_PI, laneOverrides = {} }) {
  const files = readdirSync(agentsDir).filter((f) => /^mp-.*\.md$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no mp-*.md found under ${agentsDir}`);
  // Report in BOTH modes: a `--check` run that silently applied host overrides
  // would make drift undiagnosable, since the reader could not tell whether the
  // registered model came from the policy or from this host.
  reportLaneOverrides(laneOverrides);

  // Write mode ensures the target dir exists; check mode must NOT create anything.
  if (!check) mkdirSync(targetDir, { recursive: true });

  let drift = 0;
  let written = 0;
  let skipped = 0;
  let removed = 0;
  const report = [];
  const prevManaged = loadManagedManifest(targetDir);
  // Bare rels actually produced from canonical agents this run (the manifest's
  // ownership list). expectedBare is broader: it also covers skip-agent paths
  // purely to suppress UNEXPECTED noise.
  const producedBare = new Set();
  // Dest filenames this run owns for orphan detection (bare only) + managed colon names
  // we deliberately clean (expected so they are not UNEXPECTED, but handled separately).
  const expectedBare = new Set();
  const managedColon = new Set();

  for (const file of files) {
    managedColon.add(managedColonRel(file));

    if (skipSet.has(file)) {
      const why = 'CC-only by design (SKIP_FOR_PI)';
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
    const { alias, mapped, body } = mapModelLine(srcBody, file, laneOverrides);
    for (const out of outputsFor(file, body)) {
      expectedBare.add(out.rel);
      producedBare.add(out.rel);
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
  // prevManaged entries are handled by the manifest sweep below, not here.
  if (existsSync(targetDir)) {
    for (const name of readdirSync(targetDir)) {
      if (!/^mp-.*\.md$/.test(name)) continue; // bare only for unexpected
      if (expectedBare.has(name) || prevManaged.has(name)) continue;
      const note = `UNEXPECTED ${name} (not produced from current agents/*.md — manual review)`;
      if (check) { drift++; report.push(`DRIFT  ${note}`); }
      else { report.push(note); }
    }
  }

  // Managed-manifest sweep: files this tool owned on the previous run but no
  // longer produces (source agent deleted or renamed) are removed in write
  // mode and previewed as drift in check mode. This is the safe cleanup for
  // agent deletions — only tool-owned files are ever touched.
  for (const rel of [...prevManaged].filter((r) => !producedBare.has(r)).sort()) {
    const stalePath = join(targetDir, rel);
    if (!existsSync(stalePath)) continue;
    if (check) {
      drift++;
      report.push(`DRIFT  ${rel} (managed previously; no longer produced — re-run without --check to remove)`);
    } else {
      unlinkSync(stalePath);
      removed++;
      report.push(`REMOVED ${rel}  (managed previously; no longer produced)`);
    }
  }
  if (!check) writeManagedManifest(targetDir, producedBare);

  return { report, drift, written, skipped, removed, registered: files.length - skipped, managedColon: [...managedColon] };
}

// Exported for unit tests (test/register-pi-agents.test.mjs). main() is the only thing
// that touches the real host filesystem; runRegister takes explicit dirs.
export { MODEL_MAP, COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor, managedColonRel };

const USAGE = `Usage: node bin/register-pi-agents.mjs [--check] [--help]

Registers the masterplan agents for a pi host: writes bare mp-*.md copies
under ~/.pi/agent/agents/ with the model: line swapped via the routing-policy
lane map (see docs/development.md). Colon alias copies are retired and cleaned.
Owns a manifest (.masterplan-managed.json) listing which files it manages; in
write mode it removes previously-managed files whose source agent is gone.
Files it never managed are left untouched and reported as UNEXPECTED for
manual review.

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
  const { report, drift, written, skipped, removed, registered } = runRegister({ agentsDir, targetDir, check, laneOverrides: loadLaneOverrides() });

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
