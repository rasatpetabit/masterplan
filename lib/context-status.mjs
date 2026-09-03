// lib/context-status.mjs — context watch at gates (§9).
//
// Resolves the MAIN session transcript (Claude Code's project-path encoding), measures the
// last assistant usage and the trailing estimate, resolves the context window with
// explicit > MP_CONTEXT_WINDOW > [1m] harness model > 200k default, and produces the
// recommendation consumed by the turn-close. Pure functions plus fs reads; the only
// process.env access is through readEnv from lib/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { readEnv } from './config.mjs';

// ---------------------------------------------------------------------------
// Project-path encoding.
// ---------------------------------------------------------------------------

export function encodeProjectPath(mainRoot) {
  return mainRoot.replace(/\//g, '-');
}

// ---------------------------------------------------------------------------
// Transcript lineage.
// ---------------------------------------------------------------------------

export function resolveTranscript({ sessionId, mainRoot, home }) {
  const encoded = encodeProjectPath(mainRoot);
  const projectsDir = path.join(home, '.claude', 'projects');
  const primary = path.join(projectsDir, encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(primary)) {
    return { path: primary, lineage: 'main' };
  }
  // Fall back only to a DIRECT sibling project directory of the encoded main whose name
  // starts with the encoded main plus '-' (a subdirectory project) containing the session.
  // Subagent transcripts (under subagents/) are never read.
  // Enumerate real subdirectories of mainRoot (depth <= 3, skipping node_modules/.git).
  const subdirs = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(mainRoot, rel) : mainRoot;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childDepth = childRel.split(path.sep).length;
      if (childDepth > 3) continue; // lineage fallback is bounded to three levels below MAIN
      subdirs.push(childRel);
      if (childDepth < 3) stack.push(childRel);
    }
  }
  for (const rel of subdirs) {
    const encodedSub = encodeProjectPath(path.join(mainRoot, rel));
    const candidate = path.join(projectsDir, encodedSub, `${sessionId}.jsonl`); // a project dir, never a subagents/ transcript
    if (fs.existsSync(candidate)) {
      return { path: candidate, lineage: 'subdirectory' };
    }
  }
  return { path: null, lineage: 'not-found' };
}

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

export function measureTranscript(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { state: 'not-found', tokens_at_last_request: null, appended_est: null };
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A non-JSON line is not a usable record; skip it.
    }
  }
  let lastUsageIndex = -1;
  let tokens = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || r.type !== 'assistant' || !r.message || !r.message.usage || typeof r.message.usage !== 'object') continue;
    const u = r.message.usage;
    const hasInput = u.input_tokens !== undefined && Number.isFinite(u.input_tokens);
    const hasOutput = u.output_tokens !== undefined && Number.isFinite(u.output_tokens);
    if (!hasInput && !hasOutput) continue;
    const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    if (Number.isFinite(t)) {
      lastUsageIndex = i;
      tokens = t;
    }
  }
  if (lastUsageIndex === -1) {
    return { state: 'malformed', tokens_at_last_request: null, appended_est: null };
  }
  let postCompaction = false;
  let appendedChars = 0;
  for (let i = lastUsageIndex + 1; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.type === 'summary' || r.isCompactSummary) postCompaction = true;
    appendedChars += JSON.stringify(r).length;
  }
  return {
    state: postCompaction ? 'post-compaction' : 'current',
    tokens_at_last_request: tokens,
    appended_est: Math.ceil(appendedChars / 4),
  };
}

// ---------------------------------------------------------------------------
// Window resolution.
// ---------------------------------------------------------------------------

export function resolveWindow({ explicit, env, harnessModel }) {
  if (explicit !== undefined && explicit !== null) {
    return { window: explicit, window_source: 'explicit' };
  }
  const envWindow = env ? readEnv('MP_CONTEXT_WINDOW', env) : readEnv('MP_CONTEXT_WINDOW');
  if (envWindow !== undefined && envWindow !== null && envWindow !== '') {
    const n = Number(envWindow);
    if (Number.isFinite(n) && n > 0) {
      return { window: n, window_source: 'env' };
    }
  }
  if (harnessModel && /\[1m\]/.test(harnessModel)) {
    return { window: 1000000, window_source: 'harness-model' };
  }
  return { window: 200000, window_source: 'default' };
}

// ---------------------------------------------------------------------------
// Recommendation.
// ---------------------------------------------------------------------------

function generatedFocus(activeRuns) {
  if (activeRuns && activeRuns.length > 0) {
    const run = activeRuns[0];
    const slug = run.slug || run.id || 'current';
    return `masterplan run ${slug}: continue from the bundle state`;
  }
  return 'the current task';
}

export function contextStatus({ sessionId, mainRoot, home, explicitWindow, harnessModel, threshold = 70, focus, activeRuns = [], env }) {
  const baseRecommendation = (compact) => ({ compact, focus: focus || generatedFocus(activeRuns) });
  if (!sessionId) {
    return {
      state: 'unsupported',
      tokens_at_last_request: null,
      appended_est: null,
      window: null,
      window_source: null,
      used_pct: null,
      recommendation: baseRecommendation(false),
    };
  }
  const { path: transcriptPath, lineage } = resolveTranscript({ sessionId, mainRoot, home });
  if (!transcriptPath) {
    const expected = path.join(home, '.claude', 'projects', encodeProjectPath(mainRoot), `${sessionId}.jsonl`);
    return {
      state: 'not-found',
      tokens_at_last_request: null,
      appended_est: null,
      window: null,
      window_source: null,
      used_pct: null,
      recommendation: baseRecommendation(false),
      expected_path: expected,
      lineage,
    };
  }
  const { window, window_source } = resolveWindow({ explicit: explicitWindow, env, harnessModel });
  const measured = measureTranscript(transcriptPath);
  if (measured.state === 'not-found' || measured.state === 'malformed') {
    return {
      state: measured.state,
      tokens_at_last_request: null,
      appended_est: null,
      window,
      window_source,
      used_pct: null,
      recommendation: baseRecommendation(false),
      lineage,
      transcript_path: transcriptPath,
    };
  }
  const rawUtil = measured.state === 'post-compaction'
    ? null
    : 100 * (measured.tokens_at_last_request + measured.appended_est) / window;
  const usedPct = rawUtil === null ? null : Math.round(rawUtil);
  const compact = rawUtil !== null && rawUtil >= threshold;
  return {
    state: measured.state,
    tokens_at_last_request: measured.tokens_at_last_request,
    appended_est: measured.appended_est,
    window,
    window_source,
    used_pct: usedPct,
    recommendation: baseRecommendation(compact),
    lineage,
    transcript_path: transcriptPath,
  };
}
