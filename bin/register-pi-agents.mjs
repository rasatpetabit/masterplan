#!/usr/bin/env node
// bin/register-pi-agents.mjs — register the masterplan agents for a pi host.
//
// PROBLEM (why this exists): `agents/mp-*.md` are authored for Claude Code — CC discovers
// them via its plugin loader as the `masterplan:mp-*` namespace, and their `model:` field
// uses CC-style bare aliases (`opus`, `fable`). pi discovers a DIFFERENT set of paths
// (`~/.pi/agent/agents/`, `.pi/agents/`, `.agents/`) and, for three compounding reasons,
// cannot use the CC files directly: (1) pi's default `agentScope:"user"` ignores project
// `.pi/agents/`; (2) the bare `opus`/`fable` aliases resolve ambiguously and leak to
// `amazon-bedrock` (no key), not the configured `litellm/opus-4.8`/`litellm/fable-5`;
// (3) `agentOverrides` applies to builtins only. So a pi host needs adapted copies.
//
// WHAT THIS DOES: for every registered `agents/mp-*.md`, write TWO files under
// `~/.pi/agent/agents/` — a bare copy (`mp-X`, the primary pi name) and a colon alias
// (`masterplan:mp-X`, so existing `masterplan:mp-*` references in CC L1/L2 text resolve on
// pi too). Both swap only the `model:` line (per MODEL_MAP); the colon copy also prefixes
// `name:`. The prompt BODY is copied verbatim — CC's `agents/` is the single source of
// truth; `--check` detects drift, so the surfaces cannot silently diverge. `mp-implementer`
// is SKIPPED (its skynet-MCP edit contract is CC-only; pi uses dispatch_task for edits).
//
// `--check` is READ-ONLY: it reports drift and exits non-zero, never mutating files.
// Idempotent in write mode. User-scope, so the existing L1 sequencer / L2 workflows need
// no `agentScope:"both"` edits.
//
// CD-1 (project-local tooling): invoked as `node bin/register-pi-agents.mjs`. No deps.
// Exit 0 on success / clean check, non-zero on drift or failure.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR); // bin/ is one level under the repo root
const AGENTS_DIR = join(REPO_ROOT, 'agents');
const PI_USER_AGENTS_DIR = join(homedir(), '.pi', 'agent', 'agents');

// CC bare alias → pi-resolvable model id (both are in the host's enabledModels).
// opus and fable are the only models the mp-* agents declare (audited 2026-06-28); both are
// `allow` under pi-subagent policy, so this mapping is policy-compliant.
const MODEL_MAP = {
  opus: 'litellm/opus-4.8',
  fable: 'litellm/fable-5',
};

function resolveRepoRoot() {
  // Prefer git (robust to symlinks/worktrees); fall back to the module's own location.
  // (ESM has no __dirname — REPO_ROOT is derived from import.meta.url via fileURLToPath.)
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch { /* fall through to module-derived root */ }
  return REPO_ROOT;
}

// The CC plugin namespace prefix. pi does not parse `masterplan:` as a package
// delimiter (it uses `.`), but a literal `name: masterplan:mp-X` IS resolvable by
// `subagent({ agent: 'masterplan:mp-X' })` (verified against
// src/runs/foreground/subagent-executor.ts — unknown names hard-error, no silent
// fallback). Generating these alias copies lets existing `masterplan:mp-*` references
// in the CC L1/L2 text resolve on pi too, for max host parity. Note: such colon-named
// agents do NOT appear in `subagent({ action: 'list' })` output (a diagnostic gap, not a
// functional one) — the bare `mp-*` copies are the primary pi registration; the colon
// copies are compatibility aliases.
const COLON_PREFIX = 'masterplan:';

// Agents that are CC-only by design and must NOT be registered for pi. mp-implementer's
// entire contract is "route every edit to the local skynet MCP" — it has no Edit/Write
// tool BY DESIGN (NON-NEGOTIABLE per agents/mp-implementer.md). pi has no skynet MCP
// server (edits go through `dispatch_task` → bounded-edit → dispatch-gateway → skynet),
// and mp-implementer's only caller is the CC L2 wave engine (`workflows/execute.workflow.js`,
// CC-only). So a pi copy would be a broken agent that cannot perform its core function.
// Skip it; pi uses dispatch_task for the equivalent edit path.
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

function mapNameLine(body, file) {
  // For colon alias copies: prefix the `name:` field with the CC namespace.
  const m = body.match(/^name:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`${file}: no \`name:\` frontmatter line to prefix`);
  const base = m[1];
  if (base.startsWith(COLON_PREFIX)) return body; // already namespaced
  return body.replace(/^name:\s*\S+\s*$/m, `name: ${COLON_PREFIX}${base}`);
}

// Each CC agent becomes TWO pi files: a bare copy (primary) + a colon alias.
function outputsFor(file, modelSwappedBody) {
  const base = file.replace(/\.md$/, '');
  return [
    { rel: `${base}.md`, body: modelSwappedBody },
    { rel: `${COLON_PREFIX}${base}.md`, body: mapNameLine(modelSwappedBody, file) },
  ];
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
  const expected = new Set(); // dest filenames this run owns (for orphan detection)

  for (const file of files) {
    const base = file.replace(/\.md$/, '');
    const rels = [`${base}.md`, `${COLON_PREFIX}${base}.md`];

    if (SKIP_FOR_PI.has(file)) {
      const why = 'CC-only (skynet MCP edit contract; no pi caller — pi uses dispatch_task for edits)';
      // Stale copies of a now-skipped agent: in check mode REPORT as drift (read-only);
      // in write mode REMOVE (idempotency for agents moved into SKIP_FOR_PI).
      for (const rel of rels) {
        expected.add(rel);
        const stale = join(targetDir, rel);
        if (existsSync(stale)) {
          if (check) {
            drift++;
            report.push(`DRIFT  ${rel} (stale: ${file} is now CC-only; re-run without --check to remove)`);
          } else {
            unlinkSync(stale);
            removed++;
            report.push(`RMSTALE ${rel}  (${file} is now CC-only)`);
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
      expected.add(out.rel);
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
  }

  // Orphan detection: dest files matching the owned patterns that this run did not
  // produce (e.g. a source agent was removed/renamed, leaving a generated copy behind).
  // Conservative — NEVER auto-delete orphans (a stray mp-*.md could be unrelated); just
  // surface them. In check mode they count as drift; in write mode they are logged only.
  if (existsSync(targetDir)) {
    for (const name of readdirSync(targetDir)) {
      if (!/^(masterplan:)?mp-.*\.md$/.test(name)) continue;
      if (expected.has(name)) continue;
      const note = `UNEXPECTED ${name} (not produced from current agents/*.md — manual review)`;
      if (check) { drift++; report.push(`DRIFT  ${note}`); }
      else { report.push(note); }
    }
  }

  return { report, drift, written, skipped, removed, registered: files.length - skipped };
}

// Exported for unit tests (test/register-pi-agents.test.mjs). main() is the only thing
// that touches the real host filesystem; runRegister takes explicit dirs.
export { MODEL_MAP, COLON_PREFIX, SKIP_FOR_PI, mapModelLine, mapNameLine, outputsFor };

function main() {
  const check = process.argv.slice(2).includes('--check');
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
    console.error(`register-pi-agents: ${registered} agent(s) (${registered * 2} files: bare + colon alias${skipNote}) in sync at ${targetDir}`);
  } else {
    const parts = [`${written} wrote`, `${registered} bare + ${registered} colon-alias`];
    if (removed > 0) parts.push(`${removed} stale removed`);
    if (skipped > 0) parts.push(`${skipped} skipped (CC-only)`);
    console.error(`register-pi-agents: ${parts.join(' · ')} — to ${targetDir}`);
    console.error('register-pi-agents: verify with `node bin/register-pi-agents.mjs --check` (drift) and read-only subagent probes (bare + colon).');
  }
}

// Run main() only when executed directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
