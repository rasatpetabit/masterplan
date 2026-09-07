#!/usr/bin/env node
// scripts/bootstrap-v10.mjs — one-off v9→v10 bootstrap driver (implemented by wave task 44).
//
// Part 1 of 2: the durable, event-backed driver. Part 2 (a later wave) replaces the
// placeholder step implementations (ci_wait, install_pi, pr_merge, claude_surface,
// surfaces_live) with real ones. This module is the single writer of bootstrap_armed /
// bootstrap_step / bootstrap_pass events (CD-7 single-writer via appendEvent).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The target set an arm was evaluated against, as a digest: a record must present the same one.
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
export function targetsDigest(targets) {
  return createHash('sha256').update(canonicalJson(targets)).digest('hex'); // every nested key counts
}
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendEvent, readState, validateEvent, BOOTSTRAP_STEPS } from '../lib/bundle.mjs';

// The bundle's event ledger, read from disk on every call (status is never reconstructed from memory).
export function readBundleEvents(statePath) {
  const file = join(dirname(statePath), 'events.jsonl');
  if (!existsSync(file)) return [];
  const events = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  // REPLAY-TIME validation (finding 5): every event with a PERMANENT schema is validated
  // against it as the ledger is read — appendEvent already gates writes, but the reviewer's
  // hand-append bypassed it, so an invalid typed event must be the named refusal HERE too,
  // never silently honored by the status the pass switch is derived from. bootstrap_pass
  // transitions are additionally checked for PASS-SEQUENCE correctness below: a hand-appended
  // pass that skips one, re-declares pass 1, or opens without its corrective trigger is
  // drift, and drift refuses loudly.
  const problems = [];
  let passSoFar = 1;
  events.forEach((e, i) => {
    const p = validateEvent(e);
    if (p.length) problems.push(`event ${i} (${e && e.type}) is invalid: ${p.join('; ')}`);
    if (e && e.type === 'bootstrap_pass') {
      const seq = (next) => {
        if (!Number.isInteger(e.pass) || e.pass !== passSoFar + 1) {
          problems.push(`event ${i} (bootstrap_pass) declares pass ${e.pass} but the ledger is at pass ${passSoFar} — the next pass must be exactly ${passSoFar + 1}; the ledger never silently switches passes (§10.3)`);
          return;
        }
        if (!CORRECTIVE_TRIGGERS.includes(e.triggered_by && events[e.triggered_by] && events[e.triggered_by].type)) {
          problems.push(`event ${i} (bootstrap_pass) names event ${e.triggered_by} as its corrective trigger, which is not a blocking corrective finding (${CORRECTIVE_TRIGGERS.join(', ')}) — a corrective pass opens on a finding, never by hand (§10.3)`);
          return;
        }
        if (!isBlockingFinding(events[e.triggered_by])) {
          problems.push(`event ${i} (bootstrap_pass) names event ${e.triggered_by}, which is not a blocking finding — a corrective pass needs a partial/missed goal, a revise/reject review or a red verify (§10.3)`);
          return;
        }
        passSoFar = e.pass;
      };
      seq();
    }
  });
  if (problems.length) {
    throw new Error(`the bundle ledger carries invalid events — refusing to derive the bootstrap status from drift: ${problems.slice(0, 3).join(' | ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
  }
  return events;
}
import { readEnv } from '../lib/config.mjs';
import { versionAtRevision, tagExists, dirtyOutsideBundle } from '../lib/finish.mjs';

// ---- constants ---------------------------------------------------------------

export const STEP_ORDER = BOOTSTRAP_STEPS;

// finish-step's durable markers that the v9 finish has begun (branch disposition, archive classes,
// the finish-time review): from then on only `gate` may be armed or recorded in the same pass.
export const FINISH_EVENT_TYPES = ['branch_finish', 'adversary_review', 'archived', 'incomplete_authorized', 'completion_confirmed', 'retro_written'];
export const PASS2_OMITTED = ['rehearsal', 'docs_normalize', 'main_push'];

export function stepsForPass(pass) {
  if (pass >= 2) return STEP_ORDER.filter((s) => !PASS2_OMITTED.includes(s));
  return STEP_ORDER;
}

export const STEP_SHAPES = {
  rehearsal: 'local',
  docs_normalize: 'git',
  verify: 'git',
  review: 'git',
  assess: 'git',
  release: 'git',
  push: 'git',
  ci_wait: 'gh',
  install_pi: 'fs',
  main_push: 'git',
  publish_ack: 'local',
  pr_merge: 'gh',
  claude_surface: 'fs',
  surfaces_live: 'fs',
  gate: 'git',
};

// ---- shell quoting ------------------------------------------------------------
// Every path, ref and target value interpolated into a printed command is single-quoted (POSIX):
// a fixture root with a space or an apostrophe must route the command, not break it.
export function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ---- git helpers -------------------------------------------------------------

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function isAncestor(repo, a, b) {
  try {
    git(repo, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}
function tryGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

// ---- target resolution -------------------------------------------------------

const TARGET_KEYS = new Set([
  'remote',
  'gh_repo',
  'version',
  'version_from',
  'branch',
  'worktree',
  'install_root',
  'pi_root',
  'claude_config_dir',
  'gh',
  'workspace_roots',
  'rehearsal_script',
  'verify_cmd',
  'pinned_v9',
]);

export function resolveTargets(MAIN, state, overrides = {}) {
  const home = readEnv('HOME') || '';
  const base = {
    remote: 'origin',
    version: '10.0.0',
    version_from: '.claude-plugin/plugin.json',
    branch: state.branch || `masterplan/${state.slug}`,
    worktree: state.worktree || null,
    install_root: `${home}/.local/share/masterplan`,
    pi_root: `${home}/.pi`,
    claude_config_dir: readEnv('CLAUDE_CONFIG_DIR') || `${home}/.claude`,
    gh: 'gh',
    gh_repo: null, // owner/repo for gh --repo; derived from the remote's GitHub URL when null
    workspace_roots: [],
    rehearsal_script: 'scripts/rehearse-v9-finish.sh',
    verify_cmd: 'npm test',
    pinned_v9: null,
  };
  for (const key of Object.keys(overrides)) {
    if (!TARGET_KEYS.has(key)) {
      throw new Error(`unknown target: ${key}`);
    }
  }
  const merged = { ...base, ...overrides };
  // Validate workspace_roots
  if (!Array.isArray(merged.workspace_roots)) {
    throw new Error('workspace_roots must be an array');
  }
  for (const wr of merged.workspace_roots) {
    if (!wr || typeof wr !== 'object' || typeof wr.dir !== 'string' || !Number.isInteger(wr.depth) || wr.depth < 0) {
      throw new Error('workspace_roots entries need {dir: string, depth: int >= 0}');
    }
  }
  // Always recompute tag from version after overrides
  merged.tag = `v${merged.version}`;
  return merged;
}

// ---- bundle loading ----------------------------------------------------------

export function loadBundle(statePath) {
  const bundleDir = dirname(statePath);
  const MAIN = join(bundleDir, '..', '..', '..'); // <MAIN>/docs/masterplan/<slug>
  const state = readState(statePath);
  const events = readBundleEvents(statePath);
  return { statePath, bundleDir, MAIN, state, events };
}

// ---- event helpers -----------------------------------------------------------

const isDone = (r) => !!r && (r.status === 'done' || r.status === 'recovered');

// The §10.2 pre-publish chain steps whose records bind data.tip to the tip they ran at
// (each one's precondition demands its predecessor's data.tip equal the CURRENT tip).
const STALE_RERUN_STEPS = ['verify', 'review', 'assess'];

// The ONE designed tip move past a recorded chain: the release commit (§10.2, the `release`
// postcondition's own rule) — exactly one CHANGELOG-only commit.
function isReleaseDelta(MAIN, from, to) {
  if (!from || !to || from === to) return false;
  const count = Number(tryGit(MAIN, ['rev-list', '--count', `${from}..${to}`]) ?? -1);
  if (count !== 1) return false;
  const changed = (tryGit(MAIN, ['diff', '--name-only', from, to]) || '').split('\n').filter(Boolean);
  return changed.length === 1 && changed[0] === 'CHANGELOG.md';
}

// A done/recovered record is STALE — the step must re-run at the current tip — when the step is
// one of the §10.2 chain, the branch has moved past its recorded tip, the move is not the one
// designed release commit, and the pass has not yet recorded `release` (once the tag is cut the
// chain is frozen; later tip moves are §10.3 dispositions handled by the later steps' own
// bindings — tip_is_published, the push postconditions — never by re-running the chain).
// Without staleness, a fixed pre-publish review deadlock: review's precondition demands verify
// at the current tip while the order guard refuses the verify re-record because verify's slot
// has a record. An unresolvable branch tip (null) cannot be compared; never stale then.
function recordIsStale({ MAIN, events, pass, step, rec, tip }) {
  if (!tip || !rec || !rec.data || !rec.data.tip || rec.data.tip === tip) return false;
  if (!STALE_RERUN_STEPS.includes(step)) return false;
  if (isReleaseDelta(MAIN, rec.data.tip, tip)) return false;
  const release = latestRecord(events, pass, 'release');
  if (release && isDone(release)) return false;
  return true;
}

function latestRecord(events, pass, step) {
  // Return the last event (by index) that is bootstrap_armed or bootstrap_step for this pass/step.
  let found = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && (e.type === 'bootstrap_armed' || e.type === 'bootstrap_step') && e.pass === pass && e.step === step) {
      found = { ...e, index: i };
    }
  }
  return found;
}

function latestOfType(events, type, pass, step) {
  let found = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.type === type && e.pass === pass && e.step === step) found = { ...e, index: i };
  }
  return found;
}

// Structural surface checks shared by install_pi / claude_surface / surfaces_live (§10.1 steps 4, 6, 7).
function readJsonVersion(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).version ?? null; } catch { return null; }
}
export function piSurfaceVersion(installRoot) {
  return readJsonVersion(join(installRoot, 'current', '.claude-plugin', 'plugin.json'));
}
export function claudeSurfacePath(claudeConfigDir, version) {
  return join(claudeConfigDir, 'plugins', 'cache', 'rasatpetabit-masterplan', 'masterplan', version, 'bin', 'masterplan.mjs');
}
export function piSurfaceEntry(installRoot) {
  return join(installRoot, 'current', 'bin', 'masterplan.mjs');
}

/**
 * RUN the installed entry point and read the version it reports. G6 requires the release to be
 * "installed and executable in both running surfaces" — a plugin.json naming the right version
 * is not that. An install can carry perfect metadata over an entry point that is absent, has a
 * broken import, or dies on start, and a metadata-only probe accepts every one of them.
 *
 * Returns the reported version, or null when the surface cannot be executed at all.
 */
export function surfaceExecVersion(entry) {
  if (!existsSync(entry)) return null;
  try {
    const out = execFileSync(process.execPath, [entry, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    // An EXACT contract, anchored on the whole trimmed output. Hunting a semver out of
    // arbitrary stdout accepts an entry point that ignores its argument and prints its own
    // path — `.../masterplan/10.0.0/bin/masterplan.mjs` contains a perfectly good 10.0.0 — so
    // the probe would pass a surface that has no version command at all.
    const m = /^masterplan v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(out).trim());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
// owner/repo from a GitHub remote URL (ssh or https, with or without .git), else null.
export function ghRepoFromRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
// The GitHub repository every gh command is bound to: an explicit target, else the one the
// configured remote points at. gh must never infer it from the checkout's default remote.
function resolveGhRepo(ctx) {
  if (ctx.targets.gh_repo) return ctx.targets.gh_repo;
  return ghRepoFromRemoteUrl(tryGit(ctx.MAIN, ['remote', 'get-url', ctx.targets.remote]));
}
// The tip a successful push published in this pass (the reviewed, released commit): every later step
// is authorised against it, never against the mutable branch ref.
function publishedTip(events, pass) {
  const rec = latestOfType(events, 'bootstrap_step', pass, 'push');
  if (!isDone(rec)) return null;
  return (rec.data && rec.data.published_tip) || (rec.armed && rec.armed.tip) || null;
}
// A precondition shared by every step after the push: ctx.tip is still the published tip.
function tipIsPublished(ctx) {
  const published = publishedTip(ctx.events, ctx.status.pass);
  if (!published) return { name: 'tip_is_published', ok: false, detail: 'no successful push record in this pass' };
  return { name: 'tip_is_published', ok: ctx.tip === published, detail: `tip ${ctx.tip ?? 'unresolvable'} vs the published tip ${published}` };
}
// A tag NAME can be force-moved on either side after the push; every step that consumes the tag
// (CI's run selection, the Pi install's --ref) is bound to the object the push published.
function tagIsPublished(ctx) {
  const rec = latestOfType(ctx.events, 'bootstrap_step', ctx.status.pass, 'push');
  const publishedTag = isDone(rec) && rec.data ? rec.data.published_tag : null;
  const published = publishedTip(ctx.events, ctx.status.pass);
  if (!publishedTag) return { name: 'tag_is_published', ok: false, detail: 'the push record does not name the published tag object' };
  const localTag = tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}`]);
  const peeled = tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}^{commit}`]);
  const remote = tryGit(ctx.MAIN, ['ls-remote', '--tags', ctx.targets.remote, `refs/tags/${ctx.tag}`]);
  const remoteTag = remote ? remote.split('\t')[0] : null;
  const ok = localTag === publishedTag && remoteTag === publishedTag && peeled === published;
  return { name: 'tag_is_published', ok, detail: `local ${localTag ?? 'none'} → ${peeled ?? 'none'}, remote ${remoteTag ?? 'absent'} vs published ${publishedTag} → ${published ?? 'unknown'}` };
}
// The remote's copies of the run branch and the release tag: {branch, tag} shas, null when absent.
function remoteRefs(ctx) {
  const out = tryGit(ctx.MAIN, ['ls-remote', ctx.targets.remote, `refs/heads/${ctx.targets.branch}`, `refs/tags/${ctx.tag}`]);
  const refs = { branch: null, tag: null };
  if (out === null) return null;
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    if (ref === `refs/heads/${ctx.targets.branch}`) refs.branch = sha;
    if (ref === `refs/tags/${ctx.tag}`) refs.tag = sha;
  }
  return refs;
}
// The version a corrective pass publishes is bound when the pass opens (§10.3) and outranks the
// targets: a differing override is a refusal, not a silent re-target.
function passVersion(events, pass) {
  let v = null;
  for (const e of events) if (e && e.type === 'bootstrap_pass' && e.pass === pass && typeof e.version === 'string') v = e.version;
  return v;
}
function bindPassVersion(resolved, overrides, events, pass) {
  const bound = passVersion(events, pass);
  if (!bound) return resolved;
  if (overrides && typeof overrides.version === 'string' && overrides.version !== bound) {
    throw new Error(`pass ${pass} is bound to version ${bound} (recorded when the pass opened); --targets version ${overrides.version} disagrees`);
  }
  return { ...resolved, version: bound, tag: `v${bound}` };
}
function ghAvailable(gh) {
  // No shell: a target value is data. A path is checked as a file; a bare name is resolved on PATH.
  if (typeof gh !== 'string' || gh === '') return false;
  const executable = (p) => { try { const st = statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } };
  if (gh.includes('/')) return executable(gh);
  if (!/^[A-Za-z0-9._-]+$/.test(gh)) return false;
  const dirs = (readEnv('PATH') || '').split(':').filter(Boolean);
  return dirs.some((d) => executable(join(d, gh)));
}
// §10.1 step 4: every non-archived bundle under the workspace roots (dir + depth) — the Pi install
// root is a host-wide singleton, so the operator sees who else switches to v10 with this install.
export function scanWorkspaceBundles(roots) {
  const out = [];
  const visit = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const mp = join(dir, 'docs', 'masterplan');
    if (existsSync(mp)) {
      for (const slugEnt of (() => { try { return readdirSync(mp, { withFileTypes: true }); } catch { return []; } })()) {
        if (!slugEnt.isDirectory()) continue;
        const sp = join(mp, slugEnt.name, 'state.yml');
        if (!existsSync(sp)) continue;
        let st = null;
        try { st = readState(sp); } catch { st = null; }
        if (!st || st.status === 'archived') continue;
        out.push({ repo: dir, slug: slugEnt.name, status: st.status ?? null, phase: st.phase ?? null, hook_policy: /(^|\/)workflows(\/|$)/.test(dir) || existsSync(join(dir, 'hooks', 'policy.toml')) });
      }
    }
    if (depth <= 0) return;
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
      visit(join(dir, ent.name), depth - 1);
    }
  };
  for (const r of roots) visit(r.dir, r.depth);
  return out;
}

function tipSha(ctx) {
  return tryGit(ctx.MAIN, ['rev-parse', `refs/heads/${ctx.targets.branch}`]) || null;
}

function reviewedSha(ctx) {
  // The sha carried by the latest done verify/review/assess records (data.tip).
  let sha = null;
  for (const step of ['verify', 'review', 'assess']) {
    const rec = latestRecord(ctx.events, ctx.status.pass, step);
    if (rec && isDone(rec) && rec.data && rec.data.tip) {
      sha = rec.data.tip;
    }
  }
  return sha;
}

function cleanTree(ctx) {
  // Only THIS run's ledger may be dirty (the driver's own events); a sibling bundle's dirt is dirt.
  return dirtyOutsideBundle(ctx.MAIN, `docs/masterplan/${ctx.state.slug}`).length === 0;
}

// The legal delta a release may present at the reviewed sha: exactly ONE commit that touches
// CHANGELOG.md alone (the release header scripts/release.mjs inserts), or — for an idempotent
// replay — zero commits only if the tip's CHANGELOG.md already carries the version header. This
// is the single_commit contract. It is shared so the record-time PREFLIGHT (which runs before
// the release's side effects are trusted and rolls a stray tag back) and the postcondition
// (the after-the-fact invariant) can never disagree about what a legal release is.
export function releaseDeltaProblems(ctx, newTip) {
  const problems = [];
  const count = Number(tryGit(ctx.MAIN, ['rev-list', '--count', `${reviewedSha(ctx)}..${newTip}`]) ?? -1);
  const changed = (tryGit(ctx.MAIN, ['diff', '--name-only', reviewedSha(ctx), newTip]) || '').split('\n').filter(Boolean);
  if (count === 1) {
    if (changed.length !== 1 || changed[0] !== 'CHANGELOG.md') {
      problems.push({ name: 'only_changelog', ok: false, detail: `the release commit must change CHANGELOG.md only; it changed ${changed.join(', ') || 'nothing'}` });
    }
  } else if (count === 0) {
    const changelog = tryGit(ctx.MAIN, ['show', `${newTip}:CHANGELOG.md`]) ?? '';
    if (!changelog.split('\n').some((l) => new RegExp(`^##\\s+\\[?${ctx.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l))) {
      problems.push({ name: 'release_commit', ok: false, detail: `no release commit since the reviewed sha and CHANGELOG.md at the tip carries no '## ${ctx.version}' header` });
    }
  } else {
    problems.push({ name: 'single_commit', ok: false, detail: `expected exactly the release commit since review, found ${count}` });
  }
  return problems;
}

// The tree a step's command executes in (targets.worktree, else MAIN's checkout of the branch): it
// must be a checkout of the run branch at exactly ctx.tip, and clean — otherwise the receipt would
// describe code other than the recorded tip (§10.1 same-SHA authorisation).
export function execTreeProblems(ctx) {
  const problems = [];
  const wt = ctx.targets.worktree;
  if (!wt) {
    // No linked worktree: the command runs in MAIN, so MAIN itself must be the branch at the tip and
    // clean outside the bundle (the ledger in docs/masterplan is dirty by construction during the stage).
    const head = tryGit(ctx.MAIN, ['rev-parse', 'HEAD']);
    const ref = tryGit(ctx.MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']);
    problems.push({ name: 'worktree_at_tip', ok: !!head && head === ctx.tip && ref === ctx.targets.branch, detail: `MAIN has ${ref ?? 'unknown'} at ${head ?? 'unknown'}; the commands need ${ctx.targets.branch} at ${ctx.tip}` });
    const dirty = dirtyOutsideBundle(ctx.MAIN, `docs/masterplan/${ctx.state.slug}`);
    problems.push({ name: 'worktree_clean', ok: dirty.length === 0, detail: dirty.length ? dirty.slice(0, 5).join(', ') : 'clean' });
    return problems;
  }
  if (!existsSync(wt)) return [{ name: 'worktree_exists', ok: false, detail: `${wt} does not exist` }];
  const head = tryGit(wt, ['rev-parse', 'HEAD']);
  problems.push({ name: 'worktree_at_tip', ok: !!head && head === ctx.tip, detail: `${wt} HEAD ${head ?? 'unknown'} vs tip ${ctx.tip}` });
  const common = tryGit(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainGit = tryGit(ctx.MAIN, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  problems.push({ name: 'worktree_linked_to_main', ok: !!common && common === mainGit, detail: `${common ?? 'unknown'} vs ${mainGit ?? 'unknown'}` });
  const dirty = tryGit(wt, ['status', '--porcelain', '--untracked-files=all']);
  problems.push({ name: 'worktree_clean', ok: dirty === '', detail: dirty ? dirty.split('\n').slice(0, 5).join(', ') : 'clean' });
  return problems;
}

// ---- bootstrap status --------------------------------------------------------

export function bootstrapStatus(statePath) {
  const { MAIN, state, events } = loadBundle(statePath);
  // pass = highest bootstrap_pass event's pass, else 1
  let pass = 1;
  for (const e of events) {
    if (e && e.type === 'bootstrap_pass' && Number.isInteger(e.pass) && e.pass > pass) {
      pass = e.pass;
    }
  }
  const steps = {};
  const completed = [];
  const failed = [];
  const stepList = stepsForPass(pass);
  for (const step of stepList) {
    const rec = latestRecord(events, pass, step);
    if (!rec) {
      steps[step] = { status: null, exit: null, sha: null, index: null };
      continue;
    }
    const status = rec.type === 'bootstrap_armed' ? 'armed' : rec.status;
    steps[step] = {
      status,
      exit: rec.exit ?? null,
      sha: rec.sha ?? null,
      index: rec.index,
    };
    if (status === 'done' || status === 'recovered') completed.push(step);
    if (status === 'failed') failed.push(step);
  }
  // next step: first step whose latest record is not done/recovered — or is STALE (recordIsStale):
  // §10.2's pre-publish chain (verify → review → assess) re-runs at the CURRENT tip after a
  // failed-review fix moves the branch. A done-at-an-old-tip record is not current, so the step
  // is next again and re-armable (its re-record is the repeated-step status: recovered, answering
  // a fresh arm at the new tip).
  const tip = tipSha({ MAIN, targets: resolveTargets(MAIN, state, {}) });
  const staleTip = (rec, step) => recordIsStale({ MAIN, events, pass, step, rec, tip });
  let next = null;
  let blockedBy = null;
  for (let i = 0; i < stepList.length; i++) {
    const step = stepList[i];
    const rec = latestRecord(events, pass, step);
    if (!rec || !isDone(rec) || staleTip(rec, step)) {
      next = step;
      // What is holding the stage. A failed step STAYS `next` (that is the blocking rule), so
      // reporting only "the PREVIOUS step failed" could never fire: the previous step of a
      // `next` is always done or recovered. The field names the failed step itself.
      if (rec && rec.status === 'failed') {
        blockedBy = `failed:${step}`;
      } else if (i > 0) {
        const prev = stepList[i - 1];
        const prevRec = latestRecord(events, pass, prev);
        if (prevRec && prevRec.status === 'failed') {
          blockedBy = `failed:${prev}`;
        }
      }
      break;
    }
  }
  // finish_begun: a finish-step event recorded in THIS pass's window (after the latest bootstrap_pass).
  // A corrective pass is opened by a finish-time finding, so the finish events that triggered it must
  // not lock the new pass down to `gate` — the lock applies to the pass the finish ran in (§10.3).
  let passStart = -1;
  events.forEach((e, i) => { if (e && e.type === 'bootstrap_pass' && e.pass === pass) passStart = i; });
  const finishBegun = events.slice(passStart + 1).some((e) => e && FINISH_EVENT_TYPES.includes(e.type));
  return {
    pass,
    version: passVersion(events, pass), // null on pass 1 (the targets' version); bound at start on a corrective pass
    steps,
    completed,
    failed,
    next: { step: next, blocked_by: blockedBy },
    finish_begun: finishBegun,
  };
}

// ---- armStep ----------------------------------------------------------------

export function armStep({ statePath, step, targets = {}, now = Date.now() }) {
  const { MAIN, state, events } = loadBundle(statePath);
  const status = bootstrapStatus(statePath);
  const resolvedTargets = bindPassVersion(resolveTargets(MAIN, state, targets), targets, events, status.pass);
  const ctx = { statePath, MAIN, state, events, status, targets: resolvedTargets, tip: tipSha({ MAIN, targets: resolvedTargets }), version: resolvedTargets.version, tag: resolvedTargets.tag };

  if (!STEP_ORDER.includes(step)) {
    return { ok: false, refusals: [`unknown step: ${step}`] };
  }
  const refusals = [];
  // A step omitted from THIS pass is refused on its own terms. Ordering happens to refuse it
  // too — the pass sits at its first step, so anything else is out of order — but ordering is a
  // sequencing rule that moves as the pass advances, while omission is permanent. Relying on
  // the coincidence would let the omission rule be deleted without any refusal changing, and
  // `release` and `push` are among the omitted steps: they are irreversible.
  if (!stepsForPass(status.pass).includes(step)) {
    refusals.push(`${step} is not part of pass ${status.pass} — a corrective pass omits it`);
  }
  if (status.next.step !== step) {
    if (status.next.step === null) {
      refusals.push('all steps already done');
    } else {
      refusals.push(`out of order: expected ${status.next.step}, got ${step}`);
    }
  }
  if (status.finish_begun && step !== 'gate') {
    refusals.push('finish has begun; only gate may be armed');
  }
  if (!ctx.tip) {
    refusals.push(`the run branch ${resolvedTargets.branch} has no resolvable tip — every step is authorised against it`);
  }
  if (refusals.length) {
    return { ok: false, refusals };
  }

  const stepDef = STEPS[step];
  // ONE snapshot, taken first: the preconditions validate exactly the values the printed command is
  // built from and the record binds — a ref that moves between two reads can never be authorised.
  const data = stepDef.data ? stepDef.data(ctx) : undefined;
  const pre = stepDef.pre(ctx, data);
  if (pre.some((p) => !p.ok)) {
    return { ok: false, preconditions: pre, refusals: [] };
  }
  const cmd = stepDef.cmd(ctx, data);
  const sha = git(MAIN, ['rev-parse', 'HEAD']);
  const record = {
    type: 'bootstrap_armed',
    ts: now,
    pass: status.pass,
    step,
    cmd,
    sha,
    tip: ctx.tip, // the run-branch tip the command was authorised against
    targets_sha256: targetsDigest(resolvedTargets), // the target set the preconditions saw
    preconditions: pre,
  };
  if (data !== undefined) record.data = data;
  appendEvent(statePath, record);
  return { ok: true, step, sha, cmd, pass: status.pass, preconditions: pre, data: record.data };
}

// ---- recordStep --------------------------------------------------------------

export function recordStep({ statePath, step, exit, digestFile = null, status = null, data = {}, reason = null, targets = {}, now = Date.now() }) {
  const { MAIN, state, events } = loadBundle(statePath);
  const statusInfo = bootstrapStatus(statePath);
  const resolvedTargets = bindPassVersion(resolveTargets(MAIN, state, targets), targets, events, statusInfo.pass);
  const ctx = { MAIN, state, events, status: statusInfo, targets: resolvedTargets, tip: tipSha({ MAIN, targets: resolvedTargets }), version: resolvedTargets.version, tag: resolvedTargets.tag };

  if (!STEP_ORDER.includes(step)) throw new Error(`unknown step: ${step}`);
  if (status !== null && status !== 'done' && status !== 'failed' && status !== 'recovered') throw new Error(`invalid --status ${status}`);
  ctx.statePath = statePath;
  // The latest bootstrap_step of this step, and the arm recorded AFTER it (§10.1: every record answers
  // its own arm; a stale arm from before an earlier record never authorises a second record).
  const prior = latestOfType(events, 'bootstrap_step', statusInfo.pass, step);
  const armed = latestOfType(events, 'bootstrap_armed', statusInfo.pass, step);
  if (!armed || (prior && prior.index > armed.index)) {
    throw new Error(`no bootstrap_armed for ${step} in pass ${statusInfo.pass} after its latest record — arm it first`);
  }
  const head = git(MAIN, ['rev-parse', 'HEAD']);
  if (step === 'gate') {
    // The gate's own command (the rebase) moves MAIN HEAD by design: its binding is the remote tip
    // the arm evaluated the equality against (§10.2) — a remote that moved since is a re-arm, and a
    // remote that cannot be fetched now is not evidence of anything (a stale tracking ref proves nothing).
    if (tryGit(MAIN, ['fetch', resolvedTargets.remote, 'main']) === null) {
      throw new Error(`cannot fetch ${resolvedTargets.remote} main — the gate is recorded only against a freshly verified remote tip`);
    }
    const remoteNow = tryGit(MAIN, ['rev-parse', `${resolvedTargets.remote}/main`]);
    if (!armed.data || armed.data.remote_tip !== remoteNow) {
      throw new Error(`remote main moved since the gate was armed: armed at ${armed.data ? armed.data.remote_tip : 'unknown'}, now ${remoteNow} — re-arm`);
    }
    // The printed command committed the bundle (the arm's own event included) before the rebase; a
    // ledger that is still uncommitted means the command did not run as printed.
    if (status === null || status === 'done' || status === 'recovered') {
      const bundleDirty = tryGit(MAIN, ['status', '--porcelain', '--untracked-files=all', '--', `docs/masterplan/${state.slug}`]);
      if (bundleDirty !== '') throw new Error(`the bundle ledger is not committed (${(bundleDirty || 'status unavailable').split('\n')[0]}) — the gate command commits docs/masterplan/${state.slug} before the rebase; run it as printed`);
      const dirtyElsewhere = dirtyOutsideBundle(MAIN, `docs/masterplan/${state.slug}`);
      if (dirtyElsewhere.length) throw new Error(`the tree is dirty after the gate command (${dirtyElsewhere.slice(0, 5).join(', ')}) — the gate is recorded on a clean checkout only`);
    }
  } else if (armed.sha !== head) {
    // With no linked worktree the release command runs in MAIN itself, so a successful release moves
    // MAIN HEAD by exactly its own commit; the release postcondition binds that commit to the reviewed sha.
    const releaseMovedMain = step === 'release' && !resolvedTargets.worktree && tryGit(MAIN, ['rev-parse', `${head}~1`]) === armed.sha;
    if (!releaseMovedMain) throw new Error(`base moved since arm: armed at ${armed.sha}, HEAD is ${head} — re-arm`);
  }
  if (step === 'rehearsal' && (status === null || status === 'done' || status === 'recovered')) {
    const targetsFile = join(dirname(statePath), `.bootstrap-targets-${armed.targets_sha256.slice(0, 16)}.json`);
    let fileDigest = null;
    try { fileDigest = targetsDigest(JSON.parse(readFileSync(targetsFile, 'utf8'))); } catch { fileDigest = null; }
    if (fileDigest !== armed.targets_sha256) throw new Error(`the rehearsal targets file ${targetsFile} no longer matches the armed target set — re-arm`);
  }
  if (armed.targets_sha256 !== targetsDigest(resolvedTargets)) {
    throw new Error(`targets differ from the arm's (${armed.targets_sha256.slice(0, 12)} vs ${targetsDigest(resolvedTargets).slice(0, 12)}) — record with the same --targets`);
  }
  if (statusInfo.finish_begun && step !== 'gate') {
    // The finish lock is a sequencing rule and takes precedence over content validation: once
    // the finish has begun, no non-gate step may be recorded AT ALL, whatever its content.
    throw new Error('finish has begun; only gate may be recorded');
  }
  if (step === 'release' && (status === null || status === 'done' || status === 'recovered')) {
    // §10.3 pre-tag validation, run at RECORD time (the tag is created between arm and record
    // by the release command): the to-be-recorded tip must be exactly one CHANGELOG-only commit
    // past the reviewed sha (or an idempotent header replay). A malformed range is refused HERE,
    // before the tag is trusted and before any record lands — and any local tag created on the
    // unverified tip is rolled back, so a refused release leaves no tag behind. The postcondition
    // keeps the same check as the after-the-fact invariant (defense in depth). This guard runs
    // BEFORE the execution-tree position check below, so a too-far release is refused on the
    // single-commit contract itself, not masked as a tree-position error.
    const preflight = releaseDeltaProblems(ctx, ctx.tip);
    if (preflight.some((p) => !p.ok)) {
      const bad = preflight.filter((p) => !p.ok).map((p) => `${p.name}: ${p.detail}`).join('; ');
      // Roll the tag back: the refusal must not leave the tag it was refused over (the release
      // command may have created it before the malformed state was noticed).
      try { git(ctx.MAIN, ['tag', '-d', ctx.tag]); } catch { /* no local tag to delete */ }
      throw new Error(`release preflight refused: ${bad} — the release was not recorded and any tag on the unverified tip was removed`);
    }
  }
  if (['rehearsal', 'verify', 'release', 'install_pi', 'surfaces_live'].includes(step) && (status === null || status === 'done' || status === 'recovered')) {
    // The receipt describes the armed tip only if the execution tree is still that tip and clean.
    // A release moves the tip by exactly its own commit; everything else must not have moved at all.
    const tree = ctx.targets.worktree || MAIN;
    const problems = execTreeProblems({ ...ctx, tip: step === 'release' ? ctx.tip : armed.tip }).filter((p) => !p.ok);
    if (problems.length) throw new Error(`execution tree ${tree} is not the armed tree: ${problems.map((p) => `${p.name} (${p.detail})`).join('; ')} — re-arm`);
    const head = tryGit(tree, ['rev-parse', 'HEAD']);
    if (step === 'release') {
      if (head !== armed.tip && tryGit(tree, ['rev-parse', `${head}~1`]) !== armed.tip) throw new Error(`execution tree ${tree} is at ${head ?? 'unknown'}, not the armed tip ${armed.tip} plus the release commit — re-arm`);
    } else if (head !== armed.tip) {
      throw new Error(`execution tree ${tree} is at ${head ?? 'unknown'}, not the armed tip ${armed.tip} — re-arm`);
    }
  }
  if (armed.tip !== undefined && ctx.tip !== armed.tip) {
    // release moves the tip by exactly the release commit; every other step must see the armed tip.
    const parentOfTip = step === 'release' && ctx.tip ? tryGit(MAIN, ['rev-parse', `${ctx.tip}~1`]) : null;
    if (!(step === 'release' && parentOfTip === armed.tip)) {
      throw new Error(`branch tip moved since arm: armed at ${armed.tip}, now ${ctx.tip} — re-arm`);
    }
  }
  // Independently of the arm: an arm receipt left behind by an earlier pass, or written before
  // the pass was corrected, must not be enough to record a step this pass does not run.
  if (!stepsForPass(statusInfo.pass).includes(step)) {
    throw new Error(`step ${step} is not part of pass ${statusInfo.pass} — a corrective pass omits it, so it cannot be recorded`);
  }
  const priorStale = recordIsStale({ MAIN, events, pass: statusInfo.pass, step, rec: prior, tip: ctx.tip });
  if (prior && (isDone(prior) || prior.status === 'recovered') && !priorStale) {
    throw new Error(`step ${step} is already ${prior.status} in pass ${statusInfo.pass} — a step is recorded once`);
  }
  if (status === 'recovered' && !(prior && prior.status === 'failed') && !priorStale) {
    throw new Error('recovered requires the latest record of the step to be failed');
  }
  if (prior && prior.status === 'failed' && status !== 'recovered' && status !== 'failed') {
    throw new Error(`step ${step} failed earlier — record the retry with --status=recovered (or another --status=failed)`);
  }
  if (status === 'failed' && exit === 0 && !reason) {
    throw new Error('failed requires a non-zero exit or a reason');
  }
  if (status !== 'failed' && exit !== 0) {
    throw new Error(`${status || 'done'} requires exit 0; record a failure with --status=failed`);
  }

  let digest = null;
  if (digestFile) {
    const buf = readFileSync(digestFile);
    digest = createHash('sha256').update(buf).digest('hex');
  }

  const stepDef = STEPS[step];
  const finalStatus = status || 'done';
  if (finalStatus === 'done' || finalStatus === 'recovered') {
    const post = stepDef.post(ctx, { exit, digest, data, armed });
    if (post.some((p) => !p.ok)) {
      throw new Error(`postcondition failed: ${post.filter((p) => !p.ok).map((p) => p.name).join(', ')}`);
    }
  }

  if ((step === 'verify' || step === 'review' || step === 'assess') && armed.tip) data = { ...data, tip: armed.tip };
  if (step === 'main_push' && (finalStatus === 'done' || finalStatus === 'recovered')) {
    // The carried list AND the identity of the main that went out are the arm's git-derived values;
    // caller data can never replace them (§10.1 step 5) — pr_merge binds its base to main_sha, so a
    // forged one would let an unreported commit become the PR base.
    const armedCarried = armed.data && Array.isArray(armed.data.carried) ? armed.data.carried : [];
    const armedMain = armed.data ? armed.data.main_sha : null;
    data = { ...data, carried: armedCarried, main_sha: armedMain, main_pre_bootstrap: armedMain };
  }
  const record = {
    type: 'bootstrap_step',
    ts: now,
    pass: statusInfo.pass,
    step,
    cmd: armed.cmd,
    exit,
    status: finalStatus,
    ...(digest ? { digest } : {}),
    data,
  };
  if (reason) record.reason = reason;
  if (data.carried) record.carried = data.carried;
  if (data.remote_tip) record.remote_tip = data.remote_tip;
  appendEvent(statePath, record);
  return record;
}

// ---- startPass ---------------------------------------------------------------

// The finish-time findings that open a corrective pass (§10.3): a partial/missed goal check, a
// blocking finish-time review, a red verify after both surfaces are live.
export const CORRECTIVE_TRIGGERS = ['goal_check', 'goals_unmet', 'adversary_review', 'run_verify', 'verify_failed'];
// Trigger types that DENOTE the failure: the record exists only because the check did not pass, so
// the type alone is the finding (no verdict/exit/ok field needed). The others are outcome records
// that carry a verdict and block only when it is a blocking one.
export const SELF_BLOCKING_TRIGGERS = ['goals_unmet', 'verify_failed'];
const BLOCKING_VERDICTS = new Set(['partial', 'missed', 'revise', 'rework', 'reject', 'error', 'fail', 'failed', 'red']);
// A finding is corrective only when it actually blocks: a self-describing failure type, a
// partial/missed goal, a revise/reject/error review verdict, a failed verify (ok:false, status
// failed, non-zero exit, or blocking:true).
export function isBlockingFinding(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (SELF_BLOCKING_TRIGGERS.includes(ev.type)) return true;
  if (ev.blocking === true || ev.ok === false || ev.status === 'failed') return true;
  if (typeof ev.exit === 'number' && ev.exit !== 0) return true;
  for (const key of ['verdict', 'outcome', 'final_verdict', 'result']) {
    if (typeof ev[key] === 'string' && BLOCKING_VERDICTS.has(ev[key])) return true;
  }
  if (ev.type === 'goal_check' && ev.goals && typeof ev.goals === 'object') {
    return Object.values(ev.goals).some((v) => v === 'partial' || v === 'missed' || (v && typeof v === 'object' && BLOCKING_VERDICTS.has(v.verdict)));
  }
  return false;
}

// The blocking finish-time findings raised after this pass's surfaces_live that no corrective pass
// has consumed yet: each is a reason the gate must NOT be recorded on this pass (§10.3 — a finding
// opens a corrective pass; the gate is recorded once, on the pass that ends clean).
export function openCorrectiveFindings(events, pass) {
  // Every pass's surfaces_live opens a window; a finding raised in ANY of them keeps blocking until
  // a corrective pass consumes it, so one pass cannot strand the findings it did not name.
  const windows = [];
  for (let p = 1; p <= pass; p++) {
    const live = latestOfType(events, 'bootstrap_step', p, 'surfaces_live');
    if (live && isDone(live)) windows.push(live.index);
  }
  if (windows.length === 0) return [];
  const earliest = Math.min(...windows);
  const consumed = new Set();
  for (const e of events) {
    if (!e || e.type !== 'bootstrap_pass') continue;
    if (Number.isInteger(e.triggered_by)) consumed.add(e.triggered_by);
    for (const i of Array.isArray(e.consumed) ? e.consumed : []) consumed.add(i);
  }
  const open = [];
  events.forEach((e, i) => {
    if (i > earliest && e && CORRECTIVE_TRIGGERS.includes(e.type) && isBlockingFinding(e) && !consumed.has(i)) open.push({ index: i, type: e.type });
  });
  return open;
}

// Every version a previous pass released or bound, in pass order: pass 1's from its release arm
// (durable on the bootstrap_armed record), later ones from the bootstrap_pass records.
export function priorVersions(events) {
  const out = [];
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'bootstrap_armed' && e.step === 'release' && e.data && typeof e.data.version === 'string' && !out.includes(e.data.version)) out.push(e.data.version);
    if (e.type === 'bootstrap_pass' && typeof e.version === 'string' && !out.includes(e.version)) out.push(e.version);
  }
  return out;
}
const semver = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = semver(a); const y = semver(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };

export function startPass({ statePath, pass, triggeredBy, version = null, targets = {}, now = Date.now() }) {
  const { MAIN, state, events } = loadBundle(statePath);
  const status = bootstrapStatus(statePath);
  const resolvedTargets = resolveTargets(MAIN, state, targets);
  if (!Number.isInteger(pass) || pass < 2) {
    throw new Error('pass must be an integer >= 2');
  }
  // §10.3: a corrective pass publishes a NEW version in the series pass 1 released (10.0.x), newer
  // than every version a previous pass bound, and tagged nowhere yet — locally or on the remote.
  // The version is bound here and every later arm/record reads it from the ledger.
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('a corrective pass needs --version=<major.minor.patch> — the new version it publishes');
  }
  if (tagExists(MAIN, `v${version}`, { remote: false })) {
    throw new Error(`version ${version} is already tagged (v${version}) — a corrective pass publishes a version that has not been released`);
  }
  let remoteTag;
  try { remoteTag = tagExists(MAIN, `v${version}`, { remote: resolvedTargets.remote }); } catch { remoteTag = null; }
  if (remoteTag !== false) {
    throw new Error(remoteTag === null ? `cannot query ${resolvedTargets.remote} for tag v${version} — the corrective version is not bound until the remote answers` : `version ${version} already exists on ${resolvedTargets.remote} (v${version})`);
  }
  for (const e of events) {
    if (e && e.type === 'bootstrap_pass' && e.version === version) throw new Error(`version ${version} was already bound to pass ${e.pass}`);
  }
  const prior = priorVersions(events);
  if (prior.length === 0) prior.push(resolvedTargets.version); // pass 1 never armed a release here: its targets' version
  const [major, minor] = semver(prior[0]);
  const [vMajor, vMinor] = semver(version);
  if (vMajor !== major || vMinor !== minor) {
    throw new Error(`version ${version} is outside the ${major}.${minor}.x series pass 1 released (${prior[0]}) — a corrective pass is a patch release of that series`);
  }
  for (const p of prior) {
    if (!newer(version, p)) throw new Error(`version ${version} is not newer than ${p}, which pass ${prior.indexOf(p) + 1} already bound`);
  }
  if (pass !== status.pass + 1) {
    throw new Error(`pass must be exactly ${status.pass + 1}, got ${pass}`);
  }
  // Fixed pass ordering: the previous pass must have reached surfaces_live (every step but the gate,
  // which is recorded once on the latest pass) before a corrective pass may open.
  const required = stepsForPass(status.pass).filter((st) => st !== 'gate');
  const missing = required.filter((st) => !isDone(latestOfType(events, 'bootstrap_step', status.pass, st)));
  if (missing.length) {
    throw new Error(`pass ${status.pass} is not complete through surfaces_live (missing: ${missing.join(', ')}) — a corrective pass cannot open`);
  }
  // The gate ends the bootstrap: once it is recorded on a pass, that pass is the last one. A finding
  // raised after a recorded gate needs a new run, never a pass behind the gate's back.
  const gate = latestRecord(events, status.pass, 'gate');
  if (gate && gate.type === 'bootstrap_step' && isDone(gate)) {
    throw new Error(`pass ${status.pass}'s gate is already recorded (event ${gate.index}) — the bootstrap is complete; a later finding needs a new run, not a corrective pass`);
  }
  if (!Number.isInteger(triggeredBy) || triggeredBy < 0 || triggeredBy >= events.length) {
    throw new Error(`triggeredBy must be a valid event index (0..${events.length - 1})`);
  }
  const trigger = events[triggeredBy];
  if (!trigger || !CORRECTIVE_TRIGGERS.includes(trigger.type)) {
    throw new Error(`triggeredBy must name a corrective finding event (${CORRECTIVE_TRIGGERS.join(', ')}), got ${trigger ? trigger.type : 'nothing'}`);
  }
  if (!isBlockingFinding(trigger)) {
    throw new Error(`event ${triggeredBy} (${trigger.type}) is not a blocking finding — a corrective pass needs a partial/missed goal, a revise/reject review or a red verify`);
  }
  const live = latestOfType(events, 'bootstrap_step', status.pass, 'surfaces_live');
  if (!live || triggeredBy <= live.index) {
    throw new Error(`event ${triggeredBy} precedes pass ${status.pass}'s surfaces_live record — only a finding raised after both surfaces went live opens a corrective pass`);
  }
  if (events.some((e) => e && e.type === 'bootstrap_pass' && e.triggered_by === triggeredBy)) {
    throw new Error(`event ${triggeredBy} already opened a corrective pass`);
  }
  // The pass consumes EVERY finding open when it starts — it re-runs the whole step-2 walk at the
  // new tip, so a finding it did not name is addressed by the same corrective release.
  const consumed = openCorrectiveFindings(events, status.pass).map((f) => f.index);
  if (!consumed.includes(triggeredBy)) consumed.push(triggeredBy);
  const record = { type: 'bootstrap_pass', ts: now, pass, triggered_by: triggeredBy, version, consumed };
  appendEvent(statePath, record);
  return bootstrapStatus(statePath);
}

// ---- step table --------------------------------------------------------------

export const STEPS = {
  rehearsal: {
    shape: 'local',
    cmd(ctx) {
      const script = ctx.targets.rehearsal_script;
      const base = ctx.targets.worktree || ctx.MAIN;
      // targets travel as a digest-named file (a JSON blob inside a shell string breaks on apostrophes);
      // record re-hashes the file, so an edit after the arm is refused.
      const targetsFile = join(dirname(ctx.statePath), `.bootstrap-targets-${targetsDigest(ctx.targets).slice(0, 16)}.json`);
      writeFileSync(targetsFile, JSON.stringify(ctx.targets, null, 2) + '\n');
      return `cd ${q(base)} && bash ${q(script)} --state=${q(ctx.statePath)} --targets=${q(targetsFile)}`;
    },
    pre(ctx) {
      const problems = [];
      if (!cleanTree(ctx)) problems.push({ name: 'clean_tree', ok: false, detail: 'dirty files outside docs/masterplan' });
      const script = ctx.targets.rehearsal_script;
      const base = ctx.targets.worktree || ctx.MAIN;
      if (!existsSync(join(base, script))) problems.push({ name: 'rehearsal_script', ok: false, detail: `${script} not found in ${base}` });
      problems.push(...execTreeProblems(ctx).filter((p) => !p.ok));
      return problems.length ? problems : [{ name: 'clean_tree', ok: true, detail: 'clean' }, { name: 'rehearsal_script', ok: true, detail: 'present' }, { name: 'exec_tree', ok: true, detail: base }];
    },
    post(ctx, record) {
      // The rehearsal's output digest IS its receipt (§10.1 step 1).
      return [{ name: 'digest_recorded', ok: typeof record.digest === 'string' && record.digest.length === 64, detail: record.digest ? 'digest present' : 'record the rehearsal output with --digest-file' }];
    },
  },
  docs_normalize: {
    shape: 'git',
    cmd() {
      return `echo ${q('docs normalized (no-op marker)')}`;
    },
    pre(ctx) {
      const problems = [];
      if (!cleanTree(ctx)) problems.push({ name: 'clean_tree', ok: false, detail: 'dirty files outside docs/masterplan' });
      if (!ctx.tip) problems.push({ name: 'tip', ok: false, detail: 'branch tip not resolvable' });
      return problems.length ? problems : [{ name: 'clean_tree', ok: true, detail: 'clean' }, { name: 'tip', ok: true, detail: ctx.tip }];
    },
    post() {
      return [];
    },
  },
  verify: {
    shape: 'git',
    cmd(ctx) {
      const base = ctx.targets.worktree || ctx.MAIN;
      return `cd ${q(base)} && ${ctx.targets.verify_cmd} && node bin/doctor.mjs .`;
    },
    pre(ctx) {
      const problems = [];
      if (!cleanTree(ctx)) problems.push({ name: 'clean_tree', ok: false, detail: 'dirty files outside docs/masterplan' });
      if (!ctx.tip) problems.push({ name: 'tip', ok: false, detail: 'branch tip not resolvable' });
      problems.push(...execTreeProblems(ctx).filter((p) => !p.ok));
      return problems.length ? problems : [{ name: 'clean_tree', ok: true, detail: 'clean' }, { name: 'tip', ok: true, detail: ctx.tip }, { name: 'exec_tree', ok: true, detail: ctx.targets.worktree || ctx.MAIN }];
    },
    post() {
      return [];
    },
  },
  review: {
    shape: 'git',
    cmd(ctx) {
      return `git -C ${q(ctx.MAIN)} diff main...${q(ctx.tip)} --stat`;
    },
    pre(ctx) {
      const problems = [];
      const verify = latestRecord(ctx.events, ctx.status.pass, 'verify');
      if (!verify || !isDone(verify) || !verify.data || verify.data.tip !== ctx.tip) {
        problems.push({ name: 'verify_done_at_tip', ok: false, detail: 'verify must be done at the current tip' });
      }
      return problems.length ? problems : [{ name: 'verify_done_at_tip', ok: true, detail: 'verify done at tip' }];
    },
    post(ctx, record) {
      const problems = [];
      if (record.data.verdict !== 'approve') {
        problems.push({ name: 'verdict_approve', ok: false, detail: `verdict must be approve, got ${record.data.verdict}` });
      }
      return problems;
    },
  },
  assess: {
    shape: 'git',
    cmd(ctx) {
      return `git -C ${q(ctx.MAIN)} diff main...${q(ctx.tip)} --stat`;
    },
    pre(ctx) {
      const problems = [];
      const review = latestRecord(ctx.events, ctx.status.pass, 'review');
      if (!review || !isDone(review) || !review.data || review.data.tip !== ctx.tip) {
        problems.push({ name: 'review_done_at_tip', ok: false, detail: 'review must be done at the current tip' });
      }
      return problems.length ? problems : [{ name: 'review_done_at_tip', ok: true, detail: 'review done at tip' }];
    },
    post(ctx, record) {
      const problems = [];
      const goals = record.data.goals;
      if (!goals || typeof goals !== 'object' || Array.isArray(goals) || Object.keys(goals).length === 0) {
        problems.push({ name: 'goals_object', ok: false, detail: 'data.goals must be a non-empty object of goal → verdict' });
      } else {
        for (const [k, v] of Object.entries(goals)) {
          if (v !== 'achieved') {
            problems.push({ name: `goal_${k}`, ok: false, detail: `${k} is ${v}, expected achieved` });
          }
        }
      }
      return problems;
    },
  },
  release: {
    shape: 'git',
    cmd(ctx) {
      const base = ctx.targets.worktree || ctx.MAIN;
      return `cd ${q(base)} && node scripts/release.mjs --version=${q(ctx.version)}`;
    },
    data(ctx) {
      // The version this pass releases, durable on the arm (a corrective pass is checked against it).
      return { version: ctx.version, tag: ctx.tag };
    },
    pre(ctx) {
      const problems = [];
      const reviewed = reviewedSha(ctx);
      if (reviewed !== ctx.tip) {
        problems.push({ name: 'reviewed_at_tip', ok: false, detail: `reviewed sha ${reviewed} != tip ${ctx.tip}` });
      }
      const v = versionAtRevision(ctx.MAIN, ctx.tip, ctx.targets.version_from);
      if (v !== ctx.version) {
        problems.push({ name: 'version_matches', ok: false, detail: `version at tip ${v} != ${ctx.version}` });
      }
      if (tagExists(ctx.MAIN, ctx.tag, { remote: false })) {
        problems.push({ name: 'tag_absent', ok: false, detail: `tag ${ctx.tag} already exists locally` });
      }
      // The release becomes final here, but the tag only becomes public at push: a tag of that name
      // already on the remote would fail the push with no way back. Refuse it — and an unreachable
      // remote — before anything is recorded.
      let remoteTag;
      try { remoteTag = tagExists(ctx.MAIN, ctx.tag, { remote: ctx.targets.remote }); } catch { remoteTag = null; }
      if (remoteTag !== false) {
        problems.push({ name: 'remote_tag_absent', ok: false, detail: remoteTag === null ? `cannot query ${ctx.targets.remote} for tag ${ctx.tag}` : `tag ${ctx.tag} already exists on ${ctx.targets.remote}` });
      }
      problems.push(...execTreeProblems(ctx).filter((p) => !p.ok));
      return problems.length ? problems : [{ name: 'reviewed_at_tip', ok: true, detail: 'reviewed at tip' }, { name: 'version_matches', ok: true, detail: 'version matches' }, { name: 'tag_absent', ok: true, detail: 'tag absent' }, { name: 'remote_tag_absent', ok: true, detail: `absent on ${ctx.targets.remote}` }, { name: 'exec_tree', ok: true, detail: ctx.targets.worktree || ctx.MAIN }];
    },
    post(ctx, record) {
      const problems = [];
      const newTip = tipSha(ctx); // the release commit lands on the run branch, never on MAIN's checkout
      if (!tagExists(ctx.MAIN, ctx.tag, { remote: false })) {
        problems.push({ name: 'tag_created', ok: false, detail: `tag ${ctx.tag} not created` });
      } else {
        const tagCommit = tryGit(ctx.MAIN, ['rev-parse', `${ctx.tag}^{commit}`]);
        if (tagCommit !== newTip) {
          problems.push({ name: 'tag_at_tip', ok: false, detail: `tag points at ${tagCommit}, not ${newTip}` });
        }
      }
      // scripts/release.mjs never bumps: the only legal delta from the reviewed sha is ONE commit that
      // touches CHANGELOG.md alone (the release header); a replay whose header already exists adds none.
      // Shared with the record-time preflight so the two can never disagree.
      problems.push(...releaseDeltaProblems(ctx, newTip));
      return problems;
    },
  },
  push: {
    shape: 'git',
    cmd(ctx, data) {
      // The ARMED objects go out (tip → branch, tag object → tag), never whatever the local refs
      // point at when the command runs; --atomic: both or neither; the leases refuse a remote that
      // moved since the arm.
      const lease = (ref, before) => `--force-with-lease=${q(`${ref}:${before ?? ''}`)}`;
      return `git -C ${q(ctx.MAIN)} push --atomic ${lease(`refs/heads/${ctx.targets.branch}`, data.remote_branch_before)} ${lease(`refs/tags/${ctx.tag}`, data.remote_tag_before)} ${q(ctx.targets.remote)} ${q(`${ctx.tip}:refs/heads/${ctx.targets.branch}`)} ${q(`${data.tag_sha}:refs/tags/${ctx.tag}`)}`;
    },
    data(ctx) {
      // The tag as authorised: its object and the commit it peels to (must be the released tip); and
      // the remote refs the push was authorised against.
      const refs = remoteRefs(ctx);
      return { tag_sha: tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}`]), tag_commit: tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}^{commit}`]), remote_branch_before: refs ? refs.branch : null, remote_tag_before: refs ? refs.tag : null, remote_reachable: refs !== null };
    },
    pre(ctx, data) {
      const problems = [];
      const release = latestRecord(ctx.events, ctx.status.pass, 'release');
      if (!release || !isDone(release)) {
        problems.push({ name: 'release_done', ok: false, detail: 'release must be done' });
      }
      // Everything below judges the SNAPSHOT the command will push — never a second read.
      if (!data.tag_sha) {
        problems.push({ name: 'tag_exists', ok: false, detail: `tag ${ctx.tag} missing locally` });
      } else if (data.tag_commit !== ctx.tip) {
        problems.push({ name: 'tag_at_tip', ok: false, detail: `${ctx.tag} → ${data.tag_commit ?? 'none'} vs tip ${ctx.tip}` });
      }
      if (!data.remote_reachable) {
        problems.push({ name: 'remote_reachable', ok: false, detail: `remote ${ctx.targets.remote} not reachable` });
      } else {
        // Authorised against the remote refs in the snapshot: the tag must be absent (or already
        // exactly ours — a retry after a push whose record failed) and the branch absent or
        // fast-forwardable to the tip. Anything else would be rejected by the remote after the fact.
        if (data.remote_tag_before !== null && data.remote_tag_before !== data.tag_sha) {
          problems.push({ name: 'remote_tag_absent', ok: false, detail: `${ctx.tag} already exists on ${ctx.targets.remote} as ${data.remote_tag_before} (local ${data.tag_sha ?? 'none'})` });
        }
        if (data.remote_branch_before !== null && !isAncestor(ctx.MAIN, data.remote_branch_before, ctx.tip)) {
          problems.push({ name: 'remote_branch_fast_forward', ok: false, detail: `remote ${ctx.targets.branch} ${data.remote_branch_before} is not an ancestor of the tip ${ctx.tip}` });
        }
      }
      return problems.length ? problems : [{ name: 'release_done', ok: true, detail: 'release done' }, { name: 'tag_exists', ok: true, detail: 'tag exists' }, { name: 'remote_reachable', ok: true, detail: 'remote reachable' }, { name: 'remote_tag_absent', ok: true, detail: `absent on ${ctx.targets.remote}` }, { name: 'remote_branch_fast_forward', ok: true, detail: 'fast-forward' }];
    },
    post(ctx, record) {
      const problems = [];
      const armedTag = record.armed && record.armed.data ? record.armed.data.tag_sha : null;
      const armedTip = record.armed ? record.armed.tip : null;
      record.data.published_tip = armedTip; // the released commit every later step is bound to
      record.data.published_tag = armedTag; // …and the tag OBJECT that carries it (a name can be moved)
      const localTag = tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}`]);
      const peeled = tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}^{commit}`]);
      // The tag that went out is the tag that was authorised, and it still peels to the released tip.
      if (!armedTag || localTag !== armedTag || peeled !== armedTip) {
        problems.push({ name: 'tag_unchanged_since_arm', ok: false, detail: `local ${localTag ?? 'none'} → ${peeled ?? 'none'} vs armed ${armedTag ?? 'unknown'} → ${armedTip ?? 'unknown'}` });
      }
      const remoteTag = tryGit(ctx.MAIN, ['ls-remote', '--tags', ctx.targets.remote, `refs/tags/${ctx.tag}`]);
      if (!remoteTag || !armedTag || remoteTag.split('\t')[0] !== armedTag) {
        problems.push({ name: 'remote_tag_matches', ok: false, detail: `remote ${remoteTag ? remoteTag.split('\t')[0] : 'absent'} vs armed ${armedTag ?? 'unknown'}` });
      }
      const remoteBranch = tryGit(ctx.MAIN, ['ls-remote', ctx.targets.remote, `refs/heads/${ctx.targets.branch}`]);
      if (!remoteBranch || remoteBranch.split('\t')[0] !== armedTip) {
        problems.push({ name: 'remote_branch_is_tip', ok: false, detail: `remote ${ctx.targets.branch} ${remoteBranch ? remoteBranch.split('\t')[0] : 'absent'} vs tip ${armedTip ?? 'unknown'}` });
      }
      return problems;
    },
  },
  main_push: {
    shape: 'git',
    cmd(ctx, data) {
      // The armed main_sha goes out — the carried report described exactly it — leased against the
      // remote main the arm fetched.
      return `git -C ${q(ctx.MAIN)} push ${q(`--force-with-lease=refs/heads/main:${data.remote_main ?? ''}`)} ${q(ctx.targets.remote)} ${q(`${data.main_sha}:refs/heads/main`)}`;
    },
    pre(ctx, data) {
      // Judged on the snapshot the lease and the carried report were built from.
      const problems = [];
      if (!data.fetch_ok) {
        problems.push({ name: 'fetch_main', ok: false, detail: `fetch ${ctx.targets.remote} main failed` });
      } else {
        const remoteMain = data.remote_main;
        const localMain = data.main_sha;
        if (!remoteMain || !localMain) {
          problems.push({ name: 'main_refs', ok: false, detail: 'could not resolve main refs' });
        } else {
          if (!isAncestor(ctx.MAIN, remoteMain, localMain)) {
            problems.push({ name: 'remote_main_ancestor', ok: false, detail: 'remote main is not an ancestor of local main' });
          }
        }
      }
      return problems.length ? problems : [{ name: 'fetch_main', ok: true, detail: 'fetch ok' }, { name: 'remote_main_ancestor', ok: true, detail: 'remote main ancestor' }];
    },
    data(ctx) {
      // §10.1 step 5: every non-bundle commit that leaves the machine unreviewed is named — for the
      // local main as it is NOW (main_sha); the record refuses a main that moved since. The remote
      // is fetched here because this hook runs before the preconditions.
      const fetched = tryGit(ctx.MAIN, ['fetch', ctx.targets.remote, 'main']);
      const mainSha = tryGit(ctx.MAIN, ['rev-parse', 'main']);
      const remoteMain = fetched === null ? null : tryGit(ctx.MAIN, ['rev-parse', `${ctx.targets.remote}/main`]);
      const list = remoteMain ? tryGit(ctx.MAIN, ['rev-list', '--reverse', `${remoteMain}..main`]) : '';
      const carried = [];
      for (const sha of (list || '').split('\n').filter(Boolean)) {
        // First-parent file list: a merge commit's carried changes are what it brought onto main.
        const paths = (tryGit(ctx.MAIN, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', `${sha}^1`, sha]) ?? tryGit(ctx.MAIN, ['show', '--format=', '--name-only', sha]) ?? '').split('\n').filter(Boolean);
        if (paths.some((p) => !p.startsWith('docs/masterplan/'))) {
          carried.push({ sha, subject: tryGit(ctx.MAIN, ['log', '-1', '--format=%s', sha]) || '', paths });
        }
      }
      return { carried, main_sha: mainSha, remote_main: remoteMain, fetch_ok: fetched !== null };
    },
    post(ctx, record) {
      const problems = [];
      const armedMain = record.armed && record.armed.data ? record.armed.data.main_sha : null;
      const localMain = tryGit(ctx.MAIN, ['rev-parse', 'main']);
      if (!armedMain || localMain !== armedMain) {
        problems.push({ name: 'main_unchanged_since_arm', ok: false, detail: `local main ${localMain ?? 'unknown'} vs armed ${armedMain ?? 'unknown'} (the carried report described the armed main)` });
      }
      const remoteMain = tryGit(ctx.MAIN, ['ls-remote', ctx.targets.remote, 'refs/heads/main']);
      if (!remoteMain || !armedMain || remoteMain.split('\t')[0] !== armedMain) {
        problems.push({ name: 'remote_main_matches', ok: false, detail: `remote ${remoteMain ? remoteMain.split('\t')[0] : 'absent'} vs armed ${armedMain ?? 'unknown'}` });
      }
      return problems;
    },
  },
  publish_ack: {
    shape: 'local',
    cmd() {
      return 'echo publish_ack';
    },
    pre(ctx) {
      const problems = [];
      if (ctx.status.pass === 1) {
        const mp = latestRecord(ctx.events, 1, 'main_push');
        if (!mp || !isDone(mp)) {
          problems.push({ name: 'main_push_done', ok: false, detail: 'main_push must be done in pass 1' });
        }
      } else {
        const ci = latestRecord(ctx.events, ctx.status.pass, 'ci_wait');
        if (!ci || !isDone(ci)) {
          problems.push({ name: 'ci_wait_done', ok: false, detail: 'ci_wait must be done in pass >= 2' });
        }
      }
      return problems.length ? problems : [{ name: 'prereq', ok: true, detail: 'prereq done' }];
    },
    post(ctx, record) {
      return record.data.answer === 'proceed' ? [] : [{ name: 'answer_proceed', ok: false, detail: `answer must be proceed, got ${record.data.answer}` }];
    },
  },
  gate: {
    shape: 'git',
    cmd(ctx, data) {
      // §10.2: the bundle (including this arm's own event) is committed first — a rebase refuses a
      // dirty tracked ledger — as a state-only commit the post-rebase audit accepts; then the rebase
      // onto the ARMED remote tip OBJECT (a tracking ref can be repointed between arm and run).
      const bundle = `docs/masterplan/${ctx.state.slug}`;
      return `git -C ${q(ctx.MAIN)} add ${q(bundle)} && git -C ${q(ctx.MAIN)} commit -q -m ${q(`masterplan(${ctx.state.slug}): bootstrap gate armed`)} && git -C ${q(ctx.MAIN)} rebase ${q(data.remote_tip ?? '')}`;
    },
    data(ctx) {
      // The snapshot is taken after a fresh fetch (this hook runs before the preconditions): a stale
      // tracking ref would bind the gate to a remote tip that is already history.
      const fetched = tryGit(ctx.MAIN, ['fetch', ctx.targets.remote, 'main']);
      const tip = fetched === null ? null : tryGit(ctx.MAIN, ['rev-parse', `${ctx.targets.remote}/main`]);
      return { remote_tip: tip, merge_base: tip, fetch_ok: fetched !== null };
    },
    pre(ctx, data) {
      const problems = [];
      // A blocking finish-time finding on this pass opens a corrective pass; it is never gated past.
      const open = openCorrectiveFindings(ctx.events, ctx.status.pass);
      if (open.length) {
        problems.push({ name: 'no_open_corrective_finding', ok: false, detail: `blocking finding(s) after pass ${ctx.status.pass}'s surfaces_live: ${open.map((f) => `${f.type}@${f.index}`).join(', ')} — start the corrective pass (start --pass=${ctx.status.pass + 1} --triggered-by=${open[0].index})` });
      }
      const checkedOut = tryGit(ctx.MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (checkedOut !== 'main') {
        problems.push({ name: 'main_checked_out', ok: false, detail: `MAIN has ${checkedOut ?? 'unknown'} checked out — the rebase must act on main` });
      }
      // The bundle ledger is dirty by construction (this driver's own events land there); the printed
      // command commits it as a state-only commit before the rebase. Anything else dirty is a stop.
      const dirtyOutside = dirtyOutsideBundle(ctx.MAIN, `docs/masterplan/${ctx.state.slug}`);
      if (dirtyOutside.length > 0) {
        problems.push({ name: 'clean_tree', ok: false, detail: `dirty outside this bundle: ${dirtyOutside.slice(0, 5).join(', ')}` });
      }
      // The SNAPSHOT the printed command rebases onto is what is judged here — never a second read.
      if (!data.fetch_ok || !data.remote_tip) {
        problems.push({ name: 'fetch_main', ok: false, detail: `fetch ${ctx.targets.remote} main failed` });
      } else {
        const remoteMain = data.remote_tip;
        const prMerge = latestRecord(ctx.events, ctx.status.pass, 'pr_merge');
        if (!prMerge || !prMerge.data || prMerge.data.merge_sha !== remoteMain) {
          problems.push({ name: 'remote_main_equals_pr_merge', ok: false, detail: 'remote main does not equal latest pr_merge merge_sha' });
        }
        // The branch the gate audits is the branch the PR merged: the merge's second parent is its tip.
        const mergedParents = prMerge && prMerge.data && prMerge.data.merge_sha ? (tryGit(ctx.MAIN, ['rev-list', '--parents', '-n', '1', prMerge.data.merge_sha]) || '').split(/\s+/).slice(1) : [];
        if (!ctx.tip || mergedParents[1] !== ctx.tip) {
          problems.push({ name: 'tip_is_merged_branch', ok: false, detail: `tip ${ctx.tip ?? 'unresolvable'} vs the merged PR's branch parent ${mergedParents[1] ?? 'unknown'}` });
        }
        if (ctx.tip && !isAncestor(ctx.MAIN, ctx.tip, remoteMain)) {
          problems.push({ name: 'tip_ancestor_of_remote', ok: false, detail: 'tip is not an ancestor of remote main' });
        }
        const mainPre = latestRecord(ctx.events, 1, 'main_push');
        const mainPreSha = mainPre && mainPre.data && mainPre.data.main_pre_bootstrap;
        if (mainPreSha) {
          const commits = tryGit(ctx.MAIN, ['rev-list', `${mainPreSha}..main`, `^${ctx.targets.remote}/main`]);
          if (commits) {
            for (const c of commits.split('\n').filter(Boolean)) {
              const parents = tryGit(ctx.MAIN, ['rev-list', '--parents', '-n', '1', c]);
              if (parents && parents.split(' ').length !== 2) {
                problems.push({ name: 'single_parent', ok: false, detail: `commit ${c} has multiple parents` });
              }
              const paths = tryGit(ctx.MAIN, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', c]);
              if (paths && paths.split('\n').filter(Boolean).some((p) => !p.startsWith('docs/masterplan/'))) {
                problems.push({ name: 'bundle_only', ok: false, detail: `commit ${c} touches non-bundle paths` });
              }
            }
          }
        }
        // Per commit, not the net tree: an add-and-revert of a bundle path is still a bundle write on
        // the branch (§10.2 branch-path check). The range is the MERGED PR's own — the merge's first
        // parent (the base it landed on) to its branch parent — so a local main moved onto the merged
        // remote cannot collapse it to nothing.
        const mergedParentsAll = prMerge && prMerge.data && prMerge.data.merge_sha ? (tryGit(ctx.MAIN, ['rev-list', '--parents', '-n', '1', prMerge.data.merge_sha]) || '').split(/\s+/).slice(1) : [];
        const rangeFrom = mergedParentsAll[0] ?? tryGit(ctx.MAIN, ['merge-base', 'main', ctx.tip]);
        const rangeTo = mergedParentsAll[1] ?? ctx.tip;
        const branchCommits = rangeFrom ? (tryGit(ctx.MAIN, ['rev-list', `${rangeFrom}..${rangeTo}`]) || '').split('\n').filter(Boolean) : [];
        for (const c of branchCommits) {
          const paths = (tryGit(ctx.MAIN, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-m', '-r', c]) || '').split('\n').filter(Boolean);
          if (paths.some((p) => p.startsWith('docs/masterplan/'))) {
            problems.push({ name: 'no_bundle_diff', ok: false, detail: `branch commit ${c} touches docs/masterplan` });
          }
        }
      }
      return problems.length ? problems : [{ name: 'clean_tree', ok: true, detail: 'clean' }, { name: 'remote_main_equals_pr_merge', ok: true, detail: 'remote main matches pr_merge' }];
    },
    post(ctx, record) {
      const problems = [];
      // A finding raised between the arm and the record blocks the record too (same rule as the arm).
      const open = openCorrectiveFindings(ctx.events, ctx.status.pass);
      if (open.length) {
        problems.push({ name: 'no_open_corrective_finding', ok: false, detail: `blocking finding(s) after pass ${ctx.status.pass}'s surfaces_live: ${open.map((f) => `${f.type}@${f.index}`).join(', ')}` });
      }
      const remoteMain = tryGit(ctx.MAIN, ['rev-parse', `${ctx.targets.remote}/main`]);
      const localMain = tryGit(ctx.MAIN, ['rev-parse', 'main']);
      // The rebase must have reconciled LOCAL main with the remote tip: remote/main is now its ancestor.
      if (!remoteMain || !localMain || !isAncestor(ctx.MAIN, remoteMain, localMain)) {
        problems.push({ name: 'main_rebased_onto_remote', ok: false, detail: `local main ${localMain ?? 'unknown'} does not contain ${ctx.targets.remote}/main ${remoteMain ?? 'unknown'} — the rebase did not land on main` });
      }
      if (tryGit(ctx.MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
        problems.push({ name: 'main_checked_out', ok: false, detail: 'MAIN no longer has main checked out' });
      }
      if (ctx.tip && !isAncestor(ctx.MAIN, ctx.tip, remoteMain)) {
        problems.push({ name: 'tip_ancestor_of_remote', ok: false, detail: 'tip is not an ancestor of remote main after rebase' });
      }
      const commits = tryGit(ctx.MAIN, ['rev-list', `${remoteMain}..main`]);
      if (commits) {
        for (const c of commits.split('\n').filter(Boolean)) {
          const parents = tryGit(ctx.MAIN, ['rev-list', '--parents', '-n', '1', c]);
          if (parents && parents.split(' ').length !== 2) {
            problems.push({ name: 'single_parent', ok: false, detail: `commit ${c} has multiple parents` });
          }
          const paths = tryGit(ctx.MAIN, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', c]);
          if (paths && paths.split('\n').filter(Boolean).some((p) => !p.startsWith('docs/masterplan/'))) {
            problems.push({ name: 'bundle_only', ok: false, detail: `commit ${c} touches non-bundle paths` });
          }
        }
      }
      return problems;
    },
  },
  ci_wait: {
    shape: 'gh',
    cmd(ctx) {
      const gh = ctx.targets.gh;
      // Bound to the repository the configured remote points at (--repo), never inferred from the
      // checkout's default remote; run from MAIN whatever directory the operator is in. The run is
      // selected by the COMMIT the push published (--commit), never by the mutable tag name.
      const repo = q(resolveGhRepo(ctx));
      const commit = q(publishedTip(ctx.events, ctx.status.pass) ?? '');
      return `cd ${q(ctx.MAIN)} && ${q(gh)} run list --repo ${repo} --commit ${commit} --workflow ci.yml --json databaseId --jq '.[0].databaseId' | xargs ${q(gh)} run watch --repo ${repo} --exit-status`;
    },
    pre(ctx) {
      // §10.1 step 4: the tag is public and identical on the remote before CI is waited on.
      const problems = [];
      const push = latestRecord(ctx.events, ctx.status.pass, 'push');
      problems.push({ name: 'push_done', ok: !!(push && isDone(push)), detail: push ? push.status : 'no push record' });
      const remoteTag = tryGit(ctx.MAIN, ['ls-remote', '--tags', ctx.targets.remote, `refs/tags/${ctx.tag}`]);
      const localTag = tryGit(ctx.MAIN, ['rev-parse', `refs/tags/${ctx.tag}`]);
      const same = !!remoteTag && !!localTag && remoteTag.split('\t')[0] === localTag;
      problems.push({ name: 'remote_tag_equals_local', ok: same, detail: same ? ctx.tag : `remote ${remoteTag ? remoteTag.split('\t')[0] : 'absent'} vs local ${localTag}` });
      problems.push(tagIsPublished(ctx)); // CI is watched for the tag the push published, not a moved name
      problems.push({ name: 'gh_available', ok: ghAvailable(ctx.targets.gh), detail: ctx.targets.gh });
      const repo = resolveGhRepo(ctx);
      problems.push({ name: 'gh_repo_resolved', ok: !!repo, detail: repo ?? `no gh_repo target and ${ctx.targets.remote} is not a GitHub URL` });
      return problems;
    },
    data(ctx) {
      return { gh_repo: resolveGhRepo(ctx) };
    },
    post(ctx, record) {
      // Both jobs' conclusions come from the shell (--data): red is a §10.3 failure, install_pi never runs.
      const c = record.data && record.data.conclusions;
      const ok = !!c && c.test === 'success' && c['release-publish'] === 'success';
      // The tag must still be the published object at record time: a name moved during the wait
      // means the evidence describes something else.
      return [{ name: 'ci_conclusions_success', ok, detail: c ? JSON.stringify(c) : 'data.conclusions missing' }, tagIsPublished(ctx)];
    },
  },
  install_pi: {
    shape: 'fs',
    cmd(ctx) {
      // --ref is the published COMMIT: a tag name can be force-moved between the arm and the run.
      let cmd = `cd ${q(ctx.targets.worktree || ctx.MAIN)} && node bin/install-pi.mjs --ref=${q(publishedTip(ctx.events, ctx.status.pass) ?? ctx.tag)}`;
      if (ctx.targets.install_root !== `${readEnv('HOME')}/.local/share/masterplan`) {
        cmd += ` --install-root=${q(ctx.targets.install_root)}`;
      }
      if (ctx.targets.pi_root !== `${readEnv('HOME')}/.pi`) {
        cmd += ` --pi-root=${q(ctx.targets.pi_root)}`;
      }
      return cmd;
    },
    pre(ctx) {
      const problems = [];
      const ci = latestRecord(ctx.events, ctx.status.pass, 'ci_wait');
      problems.push({ name: 'ci_wait_done', ok: !!(ci && isDone(ci)), detail: ci ? ci.status : 'no ci_wait record' });
      problems.push(tipIsPublished(ctx)); // the installed release is the pushed one, not a moved branch
      problems.push({ name: 'install_root_parent', ok: existsSync(dirname(ctx.targets.install_root)), detail: ctx.targets.install_root });
      problems.push(tagIsPublished(ctx)); // --ref=<tag> installs the published object, not a moved name
      problems.push(...execTreeProblems(ctx));
      return problems;
    },
    data(ctx) {
      // The scanned bundle list (recorded on the arm; the AUQ carries it and says it may be incomplete).
      return { workspace_roots: ctx.targets.workspace_roots, bundles: scanWorkspaceBundles(ctx.targets.workspace_roots) };
    },
    post(ctx) {
      // The installed source identity, not merely its version string: the install record names the
      // commit it resolved, and it must be the one the push published.
      const v = piSurfaceVersion(ctx.targets.install_root);
      const published = publishedTip(ctx.events, ctx.status.pass);
      let installed = null;
      try { installed = JSON.parse(readFileSync(join(ctx.targets.install_root, '.pi-install.json'), 'utf8')); } catch { installed = null; }
      return [
        { name: 'pi_current_version', ok: v === ctx.version, detail: `current → ${v ?? 'none'} (expected ${ctx.version})` },
        { name: 'pi_installed_sha', ok: !!installed && !!published && installed.sha === published, detail: `installed ${installed ? installed.sha : 'unknown'} vs published ${published ?? 'unknown'}` },
        tagIsPublished(ctx),
      ];
    },
  },
  pr_merge: {
    shape: 'gh',
    cmd(ctx) {
      const gh = ctx.targets.gh;
      // Bound to --repo (see ci_wait) and idempotent: a PR that already exists for this head/base
      // (a retry after `pr create` succeeded and the merge failed) is found, not created again, and
      // the merge names the PR by number.
      const repo = q(resolveGhRepo(ctx));
      const find = `${q(gh)} pr list --repo ${repo} --head ${q(ctx.targets.branch)} --base main --state open --json number --jq '.[0].number // empty'`;
      // --match-head-commit: GitHub merges the ARMED tip or refuses — a head that moved after the arm
      // never lands.
      return `cd ${q(ctx.MAIN)} && n=$(${find}) && { [ -n "$n" ] || { ${q(gh)} pr create --repo ${repo} --base main --head ${q(ctx.targets.branch)} --fill >/dev/null && n=$(${find}); }; } && [ -n "$n" ] && ${q(gh)} pr merge --repo ${repo} "$n" --merge --match-head-commit ${q(ctx.tip)}`;
    },
    pre(ctx, data) {
      // §10.1 step 5 / §10.3 corrective pass: the ack said proceed, and origin/main is where the pass
      // expects it — judged on the SAME snapshot the command and the record carry.
      const problems = [];
      if (!data.fetch_ok) problems.push({ name: 'fetch_main', ok: false, detail: `fetch ${ctx.targets.remote} main failed` });
      const ack = latestRecord(ctx.events, ctx.status.pass, 'publish_ack');
      problems.push({ name: 'publish_ack_proceed', ok: !!(ack && isDone(ack)), detail: ack ? ack.status : 'no publish_ack record' });
      const remoteMain = data.remote_main;
      let expected = null;
      if (ctx.status.pass === 1) {
        // The base the PR lands on is the main that main_push actually published — a commit added to
        // main after that push is in no carried report and would slip past every later audit.
        const mainPush = latestOfType(ctx.events, 'bootstrap_step', 1, 'main_push');
        expected = isDone(mainPush) && mainPush.data ? (mainPush.data.main_sha ?? mainPush.data.main_pre_bootstrap ?? null) : null;
      } else {
        const prev = latestOfType(ctx.events, 'bootstrap_step', ctx.status.pass - 1, 'pr_merge');
        expected = prev && prev.data ? prev.data.merge_sha ?? null : null;
      }
      problems.push({ name: 'remote_main_expected', ok: !!remoteMain && remoteMain === expected, detail: `remote ${remoteMain ?? 'unreachable'} vs expected ${expected ?? 'unknown'}` });
      // What GitHub will merge is what was released: the tip the push published, on the remote and
      // locally. A branch that moved after the push (local, remote, or both) is refused here.
      const published = publishedTip(ctx.events, ctx.status.pass);
      problems.push(tipIsPublished(ctx));
      problems.push({ name: 'remote_head_is_tip', ok: !!data.remote_head_now && !!published && data.remote_head_now === published, detail: `remote ${ctx.targets.branch} ${data.remote_head_now ?? 'unreachable'} vs the published tip ${published ?? 'unknown'}` });
      problems.push({ name: 'gh_available', ok: ghAvailable(ctx.targets.gh), detail: ctx.targets.gh });
      const repo = resolveGhRepo(ctx);
      problems.push({ name: 'gh_repo_resolved', ok: !!repo, detail: repo ?? `no gh_repo target and ${ctx.targets.remote} is not a GitHub URL` });
      return problems;
    },
    data(ctx) {
      // The remote base the merge is authorised onto (the record requires the merge to land on it)
      // and the repository the PR is opened in.
      // This hook runs before the preconditions, so it takes the whole network snapshot they judge.
      const fetched = tryGit(ctx.MAIN, ['fetch', ctx.targets.remote, 'main']);
      const fetchedHead = tryGit(ctx.MAIN, ['fetch', ctx.targets.remote, ctx.targets.branch]);
      return {
        remote_main: fetched === null ? null : tryGit(ctx.MAIN, ['rev-parse', `${ctx.targets.remote}/main`]),
        remote_head_now: fetchedHead === null ? null : tryGit(ctx.MAIN, ['rev-parse', 'FETCH_HEAD']),
        remote_head: ctx.tip,
        gh_repo: resolveGhRepo(ctx),
        fetch_ok: fetched !== null,
      };
    },
    post(ctx, record) {
      const merge = record.data && record.data.merge_sha;
      const problems = [{ name: 'merge_sha_recorded', ok: typeof merge === 'string' && merge.length > 0, detail: merge ?? 'data.merge_sha missing' }];
      if (!merge) return problems;
      // Read the remote itself: a stale tracking ref after a failed fetch is not evidence.
      const lsRemote = tryGit(ctx.MAIN, ['ls-remote', ctx.targets.remote, 'refs/heads/main']);
      const remoteMain = lsRemote ? lsRemote.split('\t')[0] : null;
      problems.push({ name: 'remote_main_is_merge', ok: !!remoteMain && remoteMain === merge, detail: `remote ${remoteMain ?? 'unreachable'} vs merge ${merge}` });
      tryGit(ctx.MAIN, ['fetch', ctx.targets.remote, 'main']); // keep the tracking ref current for later steps
      // The merge's first parent must be the remote base the arm observed (§10.3: a moved base is a re-arm).
      const armedBase = record.armed && record.armed.data ? record.armed.data.remote_main : null;
      const armedTip = record.armed ? record.armed.tip : null;
      const parents = (tryGit(ctx.MAIN, ['rev-list', '--parents', '-n', '1', merge]) || '').split(/\s+/).slice(1);
      problems.push({ name: 'merged_onto_armed_base', ok: !!armedBase && parents[0] === armedBase, detail: `merge parent ${parents[0] ?? 'unknown'} vs armed remote base ${armedBase ?? 'unknown'}` });
      // `gh pr merge --merge` lands exactly the armed tip: a two-parent merge of [base, tip]. Anything
      // else (an extra commit under a different ref, a squash, a rebase) carries unreviewed content.
      problems.push({ name: 'merged_exact_tip', ok: parents.length === 2 && parents[1] === armedTip, detail: `merge parents [${parents.map((p) => p.slice(0, 12)).join(', ')}] vs [base, armed tip ${armedTip ? armedTip.slice(0, 12) : 'unknown'}]` });
      problems.push({ name: 'tip_ancestor_of_merge', ok: !!ctx.tip && isAncestor(ctx.MAIN, ctx.tip, merge), detail: `${ctx.tip} → ${merge}` });
      return problems;
    },
  },
  claude_surface: {
    shape: 'fs',
    cmd() {
      return 'echo "/plugin marketplace update rasatpetabit-masterplan, then /plugin update masterplan, then /reload-plugins"';
    },
    pre(ctx) {
      const pr = latestRecord(ctx.events, ctx.status.pass, 'pr_merge');
      return [{ name: 'pr_merge_done', ok: !!(pr && isDone(pr)), detail: pr ? pr.status : 'no pr_merge record' }, tipIsPublished(ctx)];
    },
    post(ctx) {
      // §10.1 step 6: the Claude cache holds the released version (evidence the operator pasted is in data).
      const p = claudeSurfacePath(ctx.targets.claude_config_dir, ctx.version);
      return [{ name: 'claude_cache_present', ok: existsSync(p), detail: p }];
    },
  },
  surfaces_live: {
    shape: 'fs',
    cmd(ctx) {
      const base = ctx.targets.worktree || ctx.MAIN;
      const roots = ctx.targets.install_root !== `${readEnv('HOME')}/.local/share/masterplan` || ctx.targets.pi_root !== `${readEnv('HOME')}/.pi`
        ? ` --install-root=${q(ctx.targets.install_root)} --pi-root=${q(ctx.targets.pi_root)}` : '';
      return `cd ${q(base)} && node bin/install-pi.mjs --check --expect=${q(ctx.tag)}${roots}`;
    },
    pre(ctx) {
      const pi = latestRecord(ctx.events, ctx.status.pass, 'install_pi');
      const cs = latestRecord(ctx.events, ctx.status.pass, 'claude_surface');
      return [
        { name: 'install_pi_done', ok: !!(pi && isDone(pi)), detail: pi ? pi.status : 'no install_pi record' },
        { name: 'claude_surface_done', ok: !!(cs && isDone(cs)), detail: cs ? cs.status : 'no claude_surface record' },
        // The check runs FROM the execution tree: it must be the released code, not a moved branch.
        tipIsPublished(ctx),
        ...execTreeProblems(ctx),
      ];
    },
    post(ctx) {
      // §10.1 step 7: both surfaces live — the precondition for the v9 finish.
      const v = piSurfaceVersion(ctx.targets.install_root);
      const p = claudeSurfacePath(ctx.targets.claude_config_dir, ctx.version);
      // Metadata AND execution. The metadata says what was installed; running it says the
      // install works. G6 requires both, and this is the last gate before the v9 finish, so a
      // surface that cannot start must fail HERE rather than after the run has archived.
      const piEntry = piSurfaceEntry(ctx.targets.install_root);
      const piExec = surfaceExecVersion(piEntry);
      const claudeExec = surfaceExecVersion(p);
      return [
        { name: 'pi_current_version', ok: v === ctx.version, detail: `current → ${v ?? 'none'}` },
        { name: 'claude_cache_present', ok: existsSync(p), detail: p },
        { name: 'pi_executable', ok: piExec === ctx.version, detail: `${piEntry} → ${piExec ?? 'did not run'}` },
        { name: 'claude_executable', ok: claudeExec === ctx.version, detail: `${p} → ${claudeExec ?? 'did not run'}` },
      ];
    },
  },
};

// ---- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { command: null, state: null, step: null, targets: null, exit: null, digestFile: null, status: null, data: null, reason: null, pass: null, triggeredBy: null, version: null };
  for (const arg of argv) {
    if (arg === 'status' || arg === 'arm' || arg === 'record' || arg === 'start') {
      args.command = arg;
    } else if (arg.startsWith('--state=')) {
      args.state = arg.slice('--state='.length);
    } else if (arg.startsWith('--step=')) {
      args.step = arg.slice('--step='.length);
    } else if (arg.startsWith('--targets=')) {
      args.targets = arg.slice('--targets='.length);
    } else if (arg.startsWith('--exit=')) {
      args.exit = Number(arg.slice('--exit='.length));
    } else if (arg.startsWith('--digest-file=')) {
      args.digestFile = arg.slice('--digest-file='.length);
    } else if (arg.startsWith('--status=')) {
      args.status = arg.slice('--status='.length);
    } else if (arg.startsWith('--data=')) {
      args.data = arg.slice('--data='.length);
    } else if (arg.startsWith('--reason=')) {
      args.reason = arg.slice('--reason='.length);
    } else if (arg.startsWith('--pass=')) {
      args.pass = Number(arg.slice('--pass='.length));
    } else if (arg.startsWith('--triggered-by=')) {
      args.triggeredBy = Number(arg.slice('--triggered-by='.length));
    } else if (arg.startsWith('--version=')) {
      args.version = arg.slice('--version='.length);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.command) {
    console.error('usage: node scripts/bootstrap-v10.mjs <status|arm|record|start> --state=<path> [--step=] [--targets=] [--exit=N] [--digest-file=] [--status=failed|recovered] [--data=<json>] [--reason=] [--pass=N] [--triggered-by=N] [--version=X.Y.Z]');
    process.exit(2);
  }
  if (!args.state) {
    console.error('--state=<path> is required');
    process.exit(2);
  }
  return args;
}

function parseTargets(raw) {
  if (!raw) return {};
  let value = raw;
  if (raw.endsWith('.json') && existsSync(raw)) {
    value = readFileSync(raw, 'utf8');
  }
  try {
    return JSON.parse(value);
  } catch {
    console.error(`invalid --targets JSON: ${raw}`);
    process.exit(2);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const statePath = args.state;
  const targets = parseTargets(args.targets);

  try {
    if (args.command === 'status') {
      const status = bootstrapStatus(statePath);
      console.log(JSON.stringify(status));
      process.exit(0);
    } else if (args.command === 'arm') {
      if (!args.step) {
        console.error('--step is required for arm');
        process.exit(2);
      }
      const result = armStep({ statePath, step: args.step, targets });
      if (!result.ok) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      // The whole arm result: the operator reads `data` (carried commits, the workspace scan, the
      // bound tag/main shas) before running `cmd`, exactly as the library caller would.
      console.log(JSON.stringify({ ok: true, step: result.step, sha: result.sha, cmd: result.cmd, pass: result.pass, preconditions: result.preconditions, data: result.data }));
      console.log(result.cmd);
      process.exit(0);
    } else if (args.command === 'record') {
      if (!args.step) {
        console.error('--step is required for record');
        process.exit(2);
      }
      if (args.exit === null) {
        console.error('--exit is required for record');
        process.exit(2);
      }
      let data = {};
      if (args.data) {
        try {
          data = JSON.parse(args.data);
        } catch {
          console.error(`invalid --data JSON: ${args.data}`);
          process.exit(2);
        }
      }
      const record = recordStep({
        statePath,
        step: args.step,
        exit: args.exit,
        digestFile: args.digestFile,
        status: args.status,
        data,
        reason: args.reason,
        targets,
      });
      console.log(JSON.stringify(record));
      process.exit(0);
    } else if (args.command === 'start') {
      if (args.pass === null || args.triggeredBy === null || args.version === null) {
        console.error('--pass, --triggered-by and --version are required for start');
        process.exit(2);
      }
      const status = startPass({ statePath, pass: args.pass, triggeredBy: args.triggeredBy, version: args.version, targets });
      console.log(JSON.stringify(status));
      process.exit(0);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
