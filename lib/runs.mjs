// F5 shared multi-run discovery engine.
//
// - last_activity is DERIVED, never stored, and event-dominant: we prefer the
//   newest timestamp found in events.jsonl, falling back to heartbeat file
//   mtimes, then to state.yml mtime.
// - Per-bundle / per-root WARN+skip error isolation: a bad state.yml or a
//   symlink loop skips just that bundle/root; a corrupt events.jsonl still
//   INCLUDES the bundle with fallback-derived activity so a dangling run is
//   never hidden.
// - Consumed by "mp runs list", the dangling-run doctor check, the sweep
//   report, and "mp status".
// - This module NEVER writes state.yml (read-only).

import fs from 'node:fs';
import path from 'node:path';
import { parseState } from './bundle.mjs';
import { resolveRunsDir } from './paths.mjs';
import { OWNER_TTL_DEFAULT_MS } from './owner.mjs';
import { readIncumbent, readLastHeartbeat } from './owner-fs.mjs';

export const DANGLING_DEFAULT_DAYS = 7;
const DAY_MS = 86400000;
const SKIP_DIRS = new Set(['.worktrees', 'node_modules', '.git']);
const DEFAULT_MAX_DEPTH = 3;   // nested (downward) walk cap
const DEFAULT_MAX_UP = 3;      // enclosing (upward) walk cap

// Recognize a .git FILE gitlink (worktrees/submodules) as well as a .git dir.
function isGitRepoRoot(dir, _fs = fs) {
  try {
    const st = _fs.statSync(path.join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch (err) {
    return false;
  }
}

// Depth-capped recursive walk for nested repo roots beneath mainRoot.
function findNestedRepos(mainRoot, maxDepth, _fs, warnings) {
  const results = [];
  const visited = new Set();

  (function walk(dir, depth) {
    let canon;
    try {
      canon = _fs.realpathSync.native(dir);
    } catch (err) {
      return; // ELOOP or other failure -- skip this subtree
    }
    if (visited.has(canon)) return;
    visited.add(canon);

    let entries;
    try {
      entries = _fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push({
        level: 'WARN',
        scope: 'root',
        path: dir,
        message: `unreadable directory during nested walk: ${err.message}`,
      });
      return;
    }

    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;

      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          const st = _fs.statSync(path.join(dir, ent.name));
          isDir = st.isDirectory();
        } catch (err) {
          continue; // broken symlink -- skip entry
        }
      }
      if (!isDir) continue;

      const child = path.join(dir, ent.name);
      if (isGitRepoRoot(child, _fs)) {
        results.push(child);
      }

      if (depth < maxDepth) {
        walk(child, depth + 1);
      }
    }
  })(mainRoot, 1);

  return results;
}

// Upward walk for enclosing repo roots above mainRoot.
function findEnclosingRepos(mainRoot, maxUp, _fs) {
  const results = [];
  let dir = path.dirname(mainRoot);
  for (let i = 0; i < maxUp; i++) {
    if (dir === path.dirname(dir)) break; // filesystem root
    if (isGitRepoRoot(dir, _fs)) {
      results.push(dir);
    }
    dir = path.dirname(dir);
  }
  return results;
}

// Collect + canonicalize + de-dupe discovery roots.
function collectRoots({ repoRoot, extraRoots, maxDepth, maxUp, _fs }) {
  const warnings = [];
  const candidates = [
    repoRoot,
    ...findNestedRepos(repoRoot, maxDepth, _fs, warnings),
    ...findEnclosingRepos(repoRoot, maxUp, _fs),
    ...extraRoots,
  ];

  const seenCanon = new Set();
  const roots = [];
  for (const candidate of candidates) {
    let canon;
    try {
      canon = _fs.realpathSync.native(candidate);
    } catch (err) {
      warnings.push({
        level: 'WARN',
        scope: 'root',
        path: candidate,
        message: `unresolvable discovery root: ${err.message}`,
      });
      continue;
    }

    try {
      const st = _fs.statSync(canon);
      if (!st.isDirectory()) {
        warnings.push({
          level: 'WARN',
          scope: 'root',
          path: canon,
          message: 'discovery root is not a directory',
        });
        continue;
      }
    } catch (err) {
      warnings.push({
        level: 'WARN',
        scope: 'root',
        path: canon,
        message: `unstatable discovery root: ${err.message}`,
      });
      continue;
    }

    if (!seenCanon.has(canon)) {
      seenCanon.add(canon);
      roots.push(canon);
    }
  }

  return { roots, warnings };
}

// Resilient, event-dominant max timestamp reader for events.jsonl.
function readEventsMaxTs(eventsPath, _fs) {
  let text;
  try {
    text = _fs.readFileSync(eventsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ts: null, warning: false };
    return { ts: null, warning: true };
  }

  let max = null;
  let bad = false;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      bad = true;
      continue;
    }
    if (obj && obj.ts != null) {
      const t = Date.parse(obj.ts);
      if (Number.isFinite(t)) {
        if (max == null || t > max) max = t;
      } else {
        bad = true;
      }
    } else {
      bad = true;
    }
  }
  return { ts: max, warning: bad };
}

// Newest mtime across '.owner.hb.*' heartbeat files in a bundle dir.
function newestHeartbeatMtime(bundleDir, _fs) {
  let names;
  try {
    names = _fs.readdirSync(bundleDir);
  } catch (err) {
    return null;
  }
  let max = null;
  for (const f of names) {
    if (!f.startsWith('.owner.hb.')) continue;
    try {
      const st = _fs.statSync(path.join(bundleDir, f));
      if (max == null || st.mtimeMs > max) max = st.mtimeMs;
    } catch (err) {
      // skip this heartbeat file
    }
  }
  return max;
}

// DERIVED, event-dominant last_activity for a bundle (never stored).
export function deriveLastActivity(bundleDir, statePath, _fs = fs) {
  const ev = readEventsMaxTs(path.join(bundleDir, 'events.jsonl'), _fs);
  const hb = newestHeartbeatMtime(bundleDir, _fs);

  if (ev.ts != null || hb != null) {
    const last_activity = Math.max(
      ev.ts != null ? ev.ts : -Infinity,
      hb != null ? hb : -Infinity
    );
    const source =
      ev.ts != null && (hb == null || ev.ts >= hb) ? 'events' : 'heartbeat';
    return { last_activity, source, eventsWarning: ev.warning };
  }

  // Neither events nor heartbeat -- fall back to state.yml mtime.
  try {
    const last_activity = _fs.statSync(statePath).mtimeMs;
    return { last_activity, source: 'state-mtime', eventsWarning: ev.warning };
  } catch (err) {
    return { last_activity: 0, source: 'none', eventsWarning: ev.warning };
  }
}

// Owner presence / staleness for a bundle.
function readOwnerStatus(bundleDir, now, ttlMs, _fs) {
  const incumbent = readIncumbent(bundleDir, _fs);
  if (!incumbent) return { present: false, stale: false };
  const last = readLastHeartbeat(bundleDir, incumbent, _fs);
  const ref = Number.isFinite(last) ? last : incumbent.acquiredAt;
  const stale = (now - ref) > ttlMs;
  return { present: true, stale };
}

// Normalize a refs object into {back:[], forward:[]}.
function normalizeRefs(refs) {
  if (!refs || typeof refs !== 'object') return { back: [], forward: [] };
  return {
    back: Array.isArray(refs.back) ? refs.back : [],
    forward: Array.isArray(refs.forward) ? refs.forward : [],
  };
}

// Path to the .discovery.yml artifact config (read side; not run state).
export function discoveryConfigPath(mainRoot, env = process.env) {
  return path.join(resolveRunsDir(mainRoot, env), '.discovery.yml');
}

// Tolerant dependency-free parser for the small .discovery.yml format.
export function parseDiscoveryConfig(text) {
  const roots = [];
  const lines = text.split('\n');
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === 'discovery:') continue;

    // Inline form: roots: ["/a","/b"]
    const inlineMatch = line.match(/^roots:\s*\[(.*)\]\s*$/);
    if (inlineMatch && !inBlock) {
      try {
        const arr = JSON.parse('[' + inlineMatch[1] + ']');
        if (Array.isArray(arr)) {
          for (const r of arr) {
            if (typeof r === 'string' && r.trim()) roots.push(r.trim());
          }
        }
      } catch (err) {
        // ignore malformed inline list
      }
      continue;
    }

    // Block opener: "roots:"
    if (/^roots:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }

    if (inBlock) {
      const m = line.match(/^-\s+(.*)$/);
      if (m) {
        let val = m[1].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        val = val.trim();
        if (val) roots.push(val);
      } else if (line === '') {
        continue;
      } else {
        inBlock = false;
      }
    }
  }

  return { roots };
}

// Serialize a list of extra roots back to .discovery.yml text.
export function serializeDiscoveryConfig(roots) {
  const out = ['# masterplan discovery roots (managed by mp config)'];
  out.push('roots:');
  for (const r of roots) out.push('  - ' + r);
  return out.join('\n') + '\n';
}

// Read .discovery.yml from disk; tolerant of absence and parse failures.
export function readDiscoveryConfig(mainRoot, { env = process.env, _fs = fs } = {}) {
  const cfgPath = discoveryConfigPath(mainRoot, env);
  let text;
  try {
    text = _fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { roots: [], warnings: [] };
    return {
      roots: [],
      warnings: [
        {
          level: 'WARN',
          scope: 'discovery-config',
          path: cfgPath,
          message: `unreadable .discovery.yml: ${err.message}`,
        },
      ],
    };
  }

  try {
    const { roots } = parseDiscoveryConfig(text);
    return { roots, warnings: [] };
  } catch (err) {
    return {
      roots: [],
      warnings: [
        {
          level: 'WARN',
          scope: 'discovery-config',
          path: cfgPath,
          message: `unparsable .discovery.yml: ${err.message}`,
        },
      ],
    };
  }
}

// Return a NEW array with root appended iff not already present.
export function addDiscoveryRoot(roots, root) {
  if (roots.includes(root)) return roots.slice();
  return roots.concat([root]);
}

// Return a NEW array with all entries strictly-equal to root removed.
export function removeDiscoveryRoot(roots, root) {
  return roots.filter((r) => r !== root);
}

// Parse a comma-separated 'a,b,c' roots argument.
export function parseRootsArg(arg) {
  if (!arg) return [];
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Flatten, trim, drop empties, and de-dupe (first-seen wins) root groups.
export function mergeRoots(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group) {
      const s = String(entry).trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// Single shared dangling-run classification used by doctor + sweep + status.
export function classifyDangling(record, opts = {}) {
  const now = opts.now ?? Date.now();
  const thresholdMs = Number.isFinite(opts.thresholdMs)
    ? opts.thresholdMs
    : (Number.isFinite(opts.thresholdDays)
        ? opts.thresholdDays
        : DANGLING_DEFAULT_DAYS) * DAY_MS;

  if (record.archived) {
    return { dangling: false, reason: null, staleActivity: false, staleOwner: false };
  }

  const staleActivity =
    Number.isFinite(record.last_activity) &&
    now - record.last_activity > thresholdMs;

  const staleOwner = !!(
    record.owner &&
    record.owner.present &&
    record.owner.stale &&
    record.status === 'in-progress'
  );

  const dangling = staleActivity || staleOwner;

  let reason = null;
  if (dangling) {
    const parts = [];
    if (staleActivity) {
      const ageDays = Math.floor((now - record.last_activity) / DAY_MS);
      parts.push(`stale-activity (age ${ageDays}d)`);
    }
    if (staleOwner) {
      parts.push('stale in-progress owner lock');
    }
    reason = parts.join('; ');
  }

  return { dangling, reason, staleActivity, staleOwner };
}

// The engine: scan discovery roots, build per-bundle records, isolate failures.
export function discoverRuns({
  repoRoot,
  rootsArg = null,
  extraRoots = [],
  readConfig = true,
  env = process.env,
  now = Date.now(),
  ttlMs = OWNER_TTL_DEFAULT_MS,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxUp = DEFAULT_MAX_UP,
  _fs = fs,
} = {}) {
  if (!repoRoot) {
    throw new Error('discoverRuns: repoRoot is required');
  }

  const warnings = [];

  let cfg;
  if (readConfig) {
    cfg = readDiscoveryConfig(repoRoot, { env, _fs });
    for (const w of cfg.warnings) warnings.push(w);
  } else {
    cfg = { roots: [] };
  }

  const extra = mergeRoots(parseRootsArg(rootsArg), cfg.roots, extraRoots);

  const { roots, warnings: rootWarnings } = collectRoots({
    repoRoot,
    extraRoots: extra,
    maxDepth,
    maxUp,
    _fs,
  });
  for (const w of rootWarnings) warnings.push(w);

  const seen = new Set(); // key = canonicalRoot + ' ' + slug
  const runs = [];

  for (const root of roots) {
    const runsDir = resolveRunsDir(root, env);

    let dirNames;
    try {
      dirNames = _fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err) {
      // No docs/masterplan here is normal, not a warning.
      continue;
    }

    for (const dirName of dirNames) {
      const bundleDir = path.join(runsDir, dirName);
      const statePath = path.join(bundleDir, 'state.yml');

      let state;
      try {
        state = parseState(_fs.readFileSync(statePath, 'utf8'));
      } catch (err) {
        warnings.push({
          level: 'WARN',
          scope: 'bundle',
          path: statePath,
          message: `unreadable state.yml: ${err.message}`,
        });
        continue;
      }

      if (!state || (state.slug == null && state.status == null)) {
        warnings.push({
          level: 'WARN',
          scope: 'bundle',
          path: statePath,
          message: 'malformed state.yml (no slug/status)',
        });
        continue;
      }

      const slug = state.slug != null ? String(state.slug) : dirName;
      const key = root + ' ' + slug;
      if (seen.has(key)) continue;
      seen.add(key);

      const activity = deriveLastActivity(bundleDir, statePath, _fs);
      if (activity.eventsWarning) {
        warnings.push({
          level: 'WARN',
          scope: 'events',
          path: path.join(bundleDir, 'events.jsonl'),
          message:
            'corrupt/unparsable events.jsonl -- bundle still included with fallback-derived activity',
        });
      }

      const owner = readOwnerStatus(bundleDir, now, ttlMs, _fs);
      const tasks = Array.isArray(state.tasks) ? state.tasks : [];

      const record = {
        repo: root,
        slug,
        status: state.status ?? null,
        phase: state.phase ?? null,
        tasks_done: tasks.filter((t) => t && t.status === 'done').length,
        tasks_total: tasks.length,
        last_activity: activity.last_activity,
        last_activity_source: activity.source,
        owner,
        refs: normalizeRefs(state.refs),
        archived: state.status === 'archived',
        statePath,
        bundleDir,
      };

      runs.push(record);
    }
  }

  return { runs, warnings };
}

// Convenience wrapper: discover + classify, returning only the dangling ones.
export function findDanglingRuns(opts = {}) {
  const { runs, warnings } = discoverRuns(opts);
  const now = opts.now ?? Date.now();
  const dangling = [];
  for (const record of runs) {
    const c = classifyDangling(record, {
      now,
      thresholdDays: opts.thresholdDays,
      thresholdMs: opts.thresholdMs,
    });
    if (c.dangling) {
      dangling.push({
        record,
        reason: c.reason,
        staleActivity: c.staleActivity,
        staleOwner: c.staleOwner,
      });
    }
  }
  return { dangling, runs, warnings };
}
