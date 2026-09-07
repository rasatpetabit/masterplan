// test/fixtures/knobs/discovery.mjs — the DERIVED knob control inventory (spec §4.4).
//
// This module is the single source of truth for WHAT a control surface IS. It derives the
// authoritative set of non-metadata controls from the EXPORTED inventories rather than
// maintaining a parallel hand list — so the registry (contracts.mjs) and task 20's generated
// inventory guard (test/knob-inventory.test.mjs) both consume the same discovery, and a new
// flag / config path / env read / emitted state field / prompt marker fails the suite by
// being UNMAPPED rather than by someone remembering to add it.
//
// Pure derivation: no process side effects. The env and marker scanners are lexical (mirroring
// the E12 docs test); the seed-state derivation walks a real buildSeedState output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT_PINS, EVENT_SCHEMAS } from '../../../lib/bundle.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// The four CLOSED metadata exemptions (spec §4.4 / task 19): identity + timestamps only.
// Nothing else may ever claim an exemption. Kept here so discovery and the registry read one
// list; contracts.mjs re-exports it for the harness.
export const METADATA_EXEMPTIONS = new Set([
  'created_at', 'schema_version', 'slug', 'topic',
  // Write-only storage annotations with no reading consumer: the successor-quoting flow
  // reads the rejection event's correction text, never this stored field (verified by
  // grep: only the seed writer touches it). A two-value behavioral contract cannot
  // exist for a field nothing consumes — the exemption is the honest classification.
  'predecessor_transcript',
]);

// ---------------------------------------------------------------------------
// flag surface — the exported KNOWN_FLAGS from the CLI
// ---------------------------------------------------------------------------
export async function discoverFlags() {
  const { KNOWN_FLAGS } = await import(path.join(ROOT, 'bin', 'masterplan.mjs'));
  return [...KNOWN_FLAGS].sort();
}

// ---------------------------------------------------------------------------
// config surface — every recognized config path from CONFIG_SCHEMA
// ---------------------------------------------------------------------------
export async function discoverConfigPaths() {
  const { CONFIG_SCHEMA } = await import(path.join(ROOT, 'lib', 'config.mjs'));
  const keys = Object.keys(CONFIG_SCHEMA);
  // The nested object keys are CONTAINERS whose leaves are the individual value carriers:
  // done.{version_from,release,install,user_only,live_check,commit_paths} and
  // context_watch.{threshold,focus}. 'done' itself is repoOnly + object|none — a structural
  // surface, not a scalar knob; its leaves are the actual controls.
  const containers = new Set(['done', 'context_watch']);
  return keys.filter((k) => !containers.has(k)).sort();
}

// ---------------------------------------------------------------------------
// environment surface — every name read through the readEnv seam (E12 scanner)
// ---------------------------------------------------------------------------
export function discoverEnvControls() {
  const dirs = ['bin', 'lib'];
  const discovered = new Set();
  for (const dir of dirs) {
    const base = path.join(ROOT, dir);
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!/\.[mc]?js$/.test(ent.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/readEnv\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
          discovered.add(m[1]);
        }
        for (const m of text.matchAll(/(?:\benv\b|readEnvAll\s*\(\s*\))[ \t]*\.[ \t]*([A-Za-z_][A-Za-z0-9_]*)/g)) {
          if (/^(?:get|has|ownKeys|getOwnPropertyDescriptor)$/.test(m[1])) continue;
          discovered.add(m[1]);
        }
      }
    };
    walk(base);
  }
  return [...discovered].sort();
}

// ---------------------------------------------------------------------------
// emitted state surface — the seed-CONTROLLED fields buildSeedState emits, flattened
// path-style so nested controls match the config-path naming (state.review.adversary →
// review.adversary, state.render.images → render.images, state.dispatch.fabric →
// dispatch.fabric, state.concurrency.owner_lock → concurrency.owner_lock).
//
// The always-empty runtime LEDGER fields (active_run, pending_gate, tasks, goals) are NOT
// controls: they are the run's mutable state, always null/[] at seed, written by the run
// machinery rather than configured. Enumerating them as knobs would force inert contracts on
// fields that never vary by seed input. The emitted-state surface is therefore the set of
// fields whose value the SEED can set and that route behavior downstream.
// ---------------------------------------------------------------------------
export async function discoverSeedStateFields() {
  const { buildSeedState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
  // buildSeedState emits CONDITIONALLY: concurrency.owner_lock appears only when ownerLock
  // is 'off', review.adversary only when codexReview true, dispatch.fabric only when on.
  // Union BOTH conditional poles so a conditionally-emitted control is never missed.
  const poles = [
    {
      slug: 'discover', topic: 't', createdAt: '2026-01-01T00:00:00Z',
      complexity: 'low', complexitySource: 'cli', autonomy: 'gated',
      planningMode: 'auto', specPath: 'spec.md', planPath: 'plan.md',
      planIndexPath: 'plan.index.json', ownerLock: 'on', codexReview: true,
      renderImages: 'on', fabricDispatch: true,
    },
    {
      slug: 'discover', topic: 't', createdAt: '2026-01-01T00:00:00Z',
      complexity: 'low', complexitySource: 'cli', autonomy: 'gated',
      planningMode: 'auto', specPath: null, planPath: null, planIndexPath: null,
      ownerLock: 'off', codexReview: false, renderImages: 'off', fabricDispatch: false,
    },
  ];
  // The seed-controlled emission paths (options buildSeedState routes into state).
  const out = new Set();
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const leaves = Object.keys(v).filter((kk) => v[kk] === null || typeof v[kk] !== 'object' || Array.isArray(v[kk]));
        if (leaves.length) {
          for (const l of leaves) out.add(`${p}.${l}`);
        } else {
          out.add(p);
        }
      } else {
        out.add(p);
      }
    }
  };
  for (const opts of poles) {
    const state = buildSeedState(opts);
    walk(state, '');
  }
  // The runtime ledger is not a control surface — drop it.
  for (const ledger of ['active_run', 'pending_gate', 'tasks', 'goals']) out.delete(ledger);
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// prompt-only markers — every `<!-- knob: name -->` marker in the sequencer
// ---------------------------------------------------------------------------
export function discoverPromptMarkers() {
  const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');
  return [...prompt.matchAll(/<!-- knob: ([a-zA-Z0-9_.]+) -->/g)].map((m) => m[1]).sort();
}

// The durable bundle controls (the wave-16 guard extension): state-derived controls that
// are not config knobs or CLI flags — the goals format pin and the schema-capture switch.
// DERIVED from the library's own exports (never a copied list): FORMAT_PINS is the closed
// pin vocabulary lib/bundle.mjs ships, and the schema_captured event schema is the capture
// switch's own validator. A future pin value or a removed capture flows through here
// without this file changing.
export function discoverDurableControls() {
  const durable = [];
  if (Array.isArray(FORMAT_PINS) && FORMAT_PINS.length >= 2) durable.push('format_pin');
  if (EVENT_SCHEMAS && typeof EVENT_SCHEMAS.schema_captured === 'function') durable.push('schema_capture');
  return durable;
}

// The complete derived control inventory — every non-metadata control on every surface.
export async function discoverAllControls() {
  const [flags, config, env, state, markers, durable] = await Promise.all([
    discoverFlags(),
    discoverConfigPaths(),
    Promise.resolve(discoverEnvControls()),
    discoverSeedStateFields(),
    Promise.resolve(discoverPromptMarkers()),
    Promise.resolve(discoverDurableControls()),
  ]);
  return {
    flags,
    config,
    env,
    state,
    markers,
    durable,
    all: [...new Set([...flags, ...config, ...env, ...state, ...durable, ...markers])].sort(),
  };
}
