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
//                                               -> {isCodex, reasons}
//   decide --state=PATH [--alive]               -> the decideNextAction result (migrates in-memory)
//   seed --state=PATH --slug=S --topic=STR [--phase=P] [--status=S] [--schema-version=N]
//        [--created-at=T] [--complexity=C] [--complexity-source=SRC] [--autonomy=A]
//        [--planning-mode=serial|parallel|auto] [--predecessor-transcript=PATH]
//        [--spec-path=P] [--plan-path=P] [--plan-index-path=P] [--force]
//                                               -> CD-7 write: create a fresh v8 brainstorm bundle (refuse if exists)
//   seed-tasks --state=PATH --plan-index=PATH [--force]
//                                               -> CD-7 write: populate state.tasks {id,status,wave,files} from plan.index.json
//                                                  (the fresh-plan path; refuse clobber of a non-empty task list w/o --force)
//   event --state=PATH --type=T [--phase=P] [--note=STR | --note-file=PATH] [--summary=STR] [--data=JSON] [--ts=T]
//                                               -> append one JSON line to the bundle's events.jsonl
//                                                  (--summary is the audit-scanned signal channel vs the
//                                                  free-text --note; --note-file is the shell-safe transport
//                                                  for untrusted note text — reads PATH's bytes verbatim,
//                                                  mutually exclusive with --note; see the case body)
//   migrate-bundle --state=PATH                 -> back up + persist a legacy bundle as v8 (no-op if v8)
//   backfill-waves --state=PATH --plan-index=PATH -> set each task's {wave,files} from plan.index.json
//   load-plan --state=PATH --plan-index=PATH    -> CD-7 write: materialize state.tasks from a fresh
//                                                  plan.index.json AND advance phase→execute, ATOMICALLY
//                                                  (the plan→execute seam; refuses a bundle with tasks;
//                                                  also best-effort auto-emits the rendered plan.html artifact)
//   render-plan --state=PATH [--plan-index=PATH] [--plan-html=PATH]
//                                               -> re-render plan.html with LIVE status from state.tasks
//                                                  (READ-ONLY: no state write); backs the `render` verb
//   prepare-wave --state=PATH --plan-index=PATH --wave=N [--routing=M] [--codex-suppressed]
//                [--linked-worktree] [--review=on|off]
//                                               -> {wave, tasks:[lean routed payload], review} for the L2 `args`
//                                                  (--review overrides state.codex.review; else read from state)
//   verify-scope --state=PATH --wave=N --before=JSON --after=JSON -> {ok, touched, outOfScope} (D6 post-barrier;
//                                                  allow-set = the immutable active_run.scope launch snapshot,
//                                                  else state-only declaredScope fallback — never re-reads plan.index)
//   mark-task --state=PATH --id=N --status=S    -> CD-7 write: set a task's status
//   set-phase --state=PATH --phase=P [--force]  -> CD-7 write: advance the lifecycle phase (brainstorm|plan|execute)
//                                                  (refuse entering execute with 0 tasks — run seed-tasks first — w/o --force)
//   set-status --state=PATH --status=S          -> CD-7 write: set the run status (in-progress|archived)
//   set-worktree-disposition --state=PATH --disposition=D
//                                               -> CD-7 write: record the worktree's disposition
//                                                  (active|removed_after_merge|kept_by_user); the
//                                                  doctor's worktree-integrity check SKIPs on retirement
//   set-review-config --state=PATH [--review=B] [--routing=R]  (alias: set-codex-config)
//                                               -> CD-7 write: arm state.review.adversary (review:
//                                                  true|false); --routing is the legacy per-task
//                                                  dispatch default (state.codex.routing: auto|on|off)
//   open-gate --state=PATH --id=X [--opened-at=T] -> CD-7 write: open the durable approval gate
//   clear-gate --state=PATH                     -> CD-7 write: clear the gate
//   set-active-run --state=PATH --wave=N [--scope=JSON] [--baseline=JSON] [--ws-baseline=JSON]
//                                                  -> CD-7 write: phase-1 marker {wave, phase:'launching'
//                                                  [, scope, baseline, wsBaseline]}; --ws-baseline captures
//                                                  workspace root entries at launch for post-wave drift detection
//   set-active-run --state=PATH --kind=plan     -> CD-7 write: planning marker {kind:'plan', phase:'launching'}
//   promote-active-run --state=PATH --run-id=X --task-id=Y -> phase-2: attach the launch handles
//   clear-active-run --state=PATH               -> CD-7 write: clear the run marker
//   merge-plan-fragments --fragments=PATH --out=PATH [--plan-md=PATH] [--meta=JSON] [--generated-at=T]
//                                               -> ARTIFACT write: deterministic plan.index.json + plan.md
//                                                  from subsystem fragments (assigns ids/waves, normalises
//                                                  codex, validates before writing; NOT CD-7 state)
//   validate-plan-index --plan-index=PATH       -> strict structural validation (exit!=0 on any error)
//   finish-status --state=PATH [--head=SHA] [--porcelain=STR] [--branches=STR]
//                                               -> the §2 finish-flow snapshot {task_scope_dirty,
//                                                  unrelated_dirty, base, retro_present, head_sha,
//                                                  verified_sha, verified, verify_commands,
//                                                  worktree_disposition, adversary_review, dispositions}.
//                                                  adversary_review mirrors the dispatch predicate (state.
//                                                  review.adversary ?? legacy state.codex.review) — arms §2c.
//                                                  git facts are PASSED IN (bin is fs-only); all git
//                                                  flags optional (a fs-only call still reports
//                                                  retro/verified/commands). verify_commands is read
//                                                  from plan.index.json (the exec projection state drops)
//   record-verification --state=PATH --sha=SHA  -> CD-7 write: record verified_sha (the verified-at-SHA
//                                                  skip — re-entry at unchanged HEAD won't re-run the suite)
//   adversary-review-status --state=PATH --sha=SHA  -> READ-ONLY: is there a durable whole-branch review
//                                                  (alias: codex-review-status)
//                                                  record at SHA? { present, digest, count, base } — matches
//                                                  both adversary_review and legacy codex_review events. The §2c
//                                                  step-7 guard reads this on (re-)entry: present at HEAD ⇒
//                                                  skip the network-bound re-run AND rehydrate the findings
//                                                  digest into the re-rendered gate AUQ (closes the P2 re-run-
//                                                  on-death + digest-loss-on-compaction window). Absent
//                                                  events.jsonl == no review yet.
//   gh-issue-body --task=JSON [--run-slug=S] [--contract-ref=R] [--integration-branch=B]
//                 [--base-sha=SHA] [--plan-hash=H] [--wave=N]
//                                               -> raw markdown string: the GitHub issue body for a plan task
//                                                  (A1/A2 serialization; the shell calls `gh issue create`)
//   parse-issue                                 -> parse metadata block from GitHub issue body on stdin
//                                                  (A2 deserialization; body is multiline, passed via stdin)
//   validate-claim --issue=JSON --actor=STRING [--prs=JSON]
//                                               -> { result: 'won' | 'lost' } (A3 settle rule)
//   select-claimable --issues=JSON [--merged=JSON] [--plan-deps=JSON]
//                                               -> { claimable: [issue, ...] } (A4 dep-satisfaction filter)
//   reconcile-integration --state=PATH          -> { actions: [...] } (A6 pure-state reconcile; gh JSON on stdin)
//   set-coord --state=PATH [--wave=N] [--base-sha=SHA] [--contract-ref=R] [--integration-branch=B]
//             [--local-run-branch=L] [--mode=M] [--mark-published] [--bootstrap]
//                                               -> CD-7 write: per-key merge of coordination fields;
//                                                  --base-sha/--mark-published require --wave; emits {coordination}.
//                                                  --bootstrap derives {contract_ref, integration_branch}
//                                                  from slug + plan_hash (idempotent, all-or-nothing).
//   update-issue-map --state=PATH --task-id=N [--issue=N] [--pr=N] [--merge-sha=SHA]
//                    [--status=S] [--wave=N]
//                                               -> CD-7 write: create/shallow-merge issue_map[task_id];
//                                                  requires at least one mutating flag; emits {task_id,entry}
//   coord-status --state=PATH [--fail-if-unconfigured] [--fail-if-unpublishable]
//                                               -> { coordination: {...} | null } (READ-ONLY snapshot;
//                                                  non-zero exit on guard flag violations)
//
// ---- qctl async-loop subcommands (§6 — drive the async qctl backend) ----
//   record-qctl-job --state=PATH --task-id=N --job-id=S --key=S
//                                               -> CD-7 write: persist {job_id, key} into state.qctl_jobs[task_id]
//                                                  (the durable job_id path — CD-7 single-writer)
//   enqueue-key --state=PATH --run-slug=S --wave=N --task-id=N --base=SHA [--scope=JSON]
//                                               -> { action:'reuse'|'upsert', key, job } (idempotency check;
//                                                  action:'upsert' -> shell must enqueue + record-qctl-job)
//   artifact-verify --declared-sha256=S --bytes-file=PATH
//                   OR --result=JSON            -> verifyArtifact or parseQctlDigest result
//   status-map --producer-status=S [--apply-ok=B] [--d6-ok=B]
//                                               -> { task_status, flags, producer_status } (§6.2 mapping)
//   base-drift --recorded-base=SHA --current-head=SHA [--scope=JSON]
//                                               -> { action:'apply'|'requeue', requeueBase } (base-drift check)
//   acquire-owner  --state=PATH [--session=ID] [--host=H] [--now=MS] [--ttl-ms=N] [--force]
//   heartbeat-owner --state=PATH [--session=ID] [--host=H] [--now=MS]
//   release-owner  --state=PATH [--session=ID] [--host=H] [--now=MS] [--ttl-ms=N] [--force]
//                                               -> Guard D NFS-safe owner sentinel (lib/owner-fs.mjs).
//                                                  Identity is the LLM SESSION (CLAUDE_CODE_SESSION_ID),
//                                                  NOT the ephemeral mp process; lock dir = dirname(state).
//                                                  acquire → {outcome: acquire|held-by-self|steal|force|
//                                                  blocked}; heartbeat → held-by-self|lost-to-other;
//                                                  release → released|not-owner|stale-not-released (the
//                                                  freshness gate: a stale owned lock is left for reclaim).
//                                                  fs-only (link/stat/
//                                                  rename/unlink); the .owner.lock is NOT CD-7 state.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, writeState, openGate, clearGate, setActiveRun, clearActiveRun, markTask, setPhase, setStatus, setWorktree, setWorktreeDisposition, setVerifiedSha, setCodexConfig, setReviewConfig, loadPlanTasks, buildSeedState, buildTasksFromPlanIndex, appendEvent, setCoordination, applyPlanIndex, rebasePaths, GOAL_LIFECYCLE_EVENT_TYPES } from '../lib/bundle.mjs';
import { parseGoals, validateGoals, goalsHash, validateUserApprovalReceipt, validateAmendment, amendmentDiff } from '../lib/goals.mjs';
import { planWorktreeCreate, parseWorktreeList, classifyWorktrees, normalizeDisposition, dispositionAfterTeardown, VALID_DISPOSITIONS as VALID_WORKTREE_DISPOSITION } from '../lib/worktree.mjs';
import { collectDiskDirs, collectBundleRecords } from '../lib/worktree-fs.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner, heartbeatOwner, releaseOwner } from '../lib/owner-fs.mjs';
import { issueBodyForTask, parseIssueBody, validateClaimSettle, selectClaimableUnits, reconcileIntegration, isTerminalIssueStatus, isValidIssueStatus, ISSUE_MAP_STATUSES, computeCoordDefaults } from '../lib/github-coord.mjs';
import { migrate, detectSchemaVersion, MigrationError } from '../lib/migrate.mjs';
import { decideNextAction } from '../lib/resume.mjs';
import { prepareWave, declaredScope, verifyScope } from '../lib/wave.mjs';
import { detectHost } from '../lib/dispatch/index.mjs';
import { selectCodexReviewForHead } from '../lib/review-companion.mjs';
import { selectGateReview, gateEventTypes, validateGateReceipt } from '../lib/gate-review.mjs';
import { resolveConfigDir } from '../lib/paths.mjs';
import { createHash } from 'node:crypto';
import { mergePlanFragments, validatePlanIndex, renderPlanMd, renderPlanHtml } from '../lib/plan-merge.mjs';
import { classifyDirt, detectBase, collectVerifyCommands, isVerified, dispositionForChoice, summarizePr } from '../lib/finish.mjs';
import { computeEnqueueKey, decideEnqueue } from '../lib/qctl-enqueue.mjs';
import { verifyArtifact, parseQctlDigest } from '../lib/qctl-artifact.mjs';
import { mapQctlStatus } from '../lib/qctl-status.mjs';
import { decideBaseDrift } from '../lib/qctl-requeue.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { continueRun } from '../lib/continue.mjs';
import { finishStep } from '../lib/finish-step.mjs';
import { sweepWorktrees } from '../lib/sweep.mjs';

// ---- spec/plan gate-review enforcement (the two PRE-EXECUTE adversary gates) ----
// The bin fs boundary for lib/gate-review.mjs (the pure scanner). These two functions recompute a
// content hash over the CURRENT bytes of a gate's reviewed artifacts so editing any input RE-ARMS the
// gate (H1: never trust a hash stamped inside a mutable artifact). The plan gate NORMALIZES
// plan.index.json — load-plan itself stamps plan_hash/generated_at DURING the load, so stripping those
// fields keeps the gate key stable across that stamping (no spurious re-review on resume).
// Resolve a gate's reviewed artifacts to CONFINED, role-tagged descriptors — the SINGLE source of truth
// for enforce / record / gate-hash so a record and its guard can never hash different bytes. Every
// candidate is realpathSync'd (existence is fail-closed; symlinks are resolved) then CONFINED to the
// bundle dir: a path that escapes (../, or absolute after realpath — e.g. a symlink spec.md → /tmp/ok)
// is refused on ALL ops, regardless of --force. set-phase NEVER honors path flags (canonical bundle
// paths only), so a caller can't pass --plan-index=/tmp/reviewed to dodge the gate; load-plan / record /
// gate-hash honor --plan-index/--plan-md because there the flag IS the operation target (still confined).
function gateConfine(candidateAbs, bundleDirReal, label) {
  let real;
  try {
    real = fs.realpathSync(candidateAbs);
  } catch (e) {
    die(`gate-review: ${label} unreadable (${candidateAbs}): ${e.message} — refusing (fail-closed: cannot gate a missing/unresolvable artifact).`, 1);
  }
  const rel = path.relative(bundleDirReal, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    die(`gate-review: ${label} resolves outside the bundle (${real} not under ${bundleDirReal}) — refusing (path/symlink escape).`, 1);
  }
  return { absPath: real, relName: rel };
}
function resolveGateArtifacts({ gate, statePath, state, flags, op }) {
  let bundleDirReal;
  try {
    bundleDirReal = fs.realpathSync(path.dirname(statePath));
  } catch (e) {
    die(`gate-review: bundle directory unreadable: ${e.message}`, 1);
  }
  const honorFlags = op === 'load-plan' || op === 'record' || op === 'gate-hash';
  const specRaw =
    state && typeof state.spec_path === 'string' && state.spec_path
      ? state.spec_path
      : path.join(bundleDirReal, 'spec.md');
  const spec = gateConfine(path.resolve(bundleDirReal, specRaw), bundleDirReal, 'spec.md');
  if (gate === 'spec') return [{ role: 'spec', ...spec }];
  if (gate === 'plan') {
    const idxRaw = honorFlags && flags['plan-index'] ? flags['plan-index'] : path.join(bundleDirReal, 'plan.index.json');
    const planIndex = gateConfine(path.resolve(bundleDirReal, idxRaw), bundleDirReal, 'plan.index.json');
    const mdRaw = honorFlags && flags['plan-md'] ? flags['plan-md'] : path.join(path.dirname(planIndex.absPath), 'plan.md');
    const planMd = gateConfine(path.resolve(bundleDirReal, mdRaw), bundleDirReal, 'plan.md');
    // FIXED order — the hash is order-sensitive: spec, plan.md, plan.index.json.
    return [{ role: 'spec', ...spec }, { role: 'planMd', ...planMd }, { role: 'planIndex', ...planIndex }];
  }
  throw new Error(`gate-review: unknown gate '${gate}' — expected 'spec' or 'plan'`);
}
// Strip the two SELF-STAMPED, mutable fields (load-plan writes plan_hash + generated_at DURING the load)
// and re-serialize with sorted TOP-LEVEL keys, so the gate key is stable across that stamping and across
// any top-level reordering. Nested order (the task list) is preserved — it is semantic.
function normalizeIndexBytes(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return Buffer.from(JSON.stringify(obj));
  const copy = { ...obj };
  delete copy.plan_hash;
  delete copy.generated_at;
  const sorted = {};
  for (const k of Object.keys(copy).sort()) sorted[k] = copy[k];
  return Buffer.from(JSON.stringify(sorted));
}
// Read a descriptor's gate-relevant bytes by ROLE (not basename — a --plan-index not literally named
// plan.index.json must still be normalized). planIndex: JSON.parse (unparseable → fail-closed die on
// EVERY path, never an empty-buffer pass) then normalize; spec/planMd: raw bytes. `preread` (load-plan's
// already-parsed index) closes the read→hash TOCTOU: we hash the exact object we validate + materialize.
function readGateArtifactBytes(descriptor, preread) {
  if (descriptor.role === 'planIndex') {
    let obj = preread;
    if (obj === undefined) {
      let text;
      try {
        text = fs.readFileSync(descriptor.absPath, 'utf8');
      } catch (e) {
        die(`gate-review: ${descriptor.relName} unreadable: ${e.message} — refusing (fail-closed).`, 1);
      }
      try {
        obj = JSON.parse(text);
      } catch (e) {
        die(`gate-review: ${descriptor.relName} is not valid JSON (${e.message}) — refusing to gate an unparseable plan index.`, 1);
      }
    }
    return normalizeIndexBytes(obj);
  }
  try {
    return fs.readFileSync(descriptor.absPath);
  } catch (e) {
    die(`gate-review: ${descriptor.relName} unreadable: ${e.message} — refusing (fail-closed).`, 1);
  }
}
function computeGateHash(descriptors, prereadIndex) {
  const h = createHash('sha256');
  for (const d of descriptors) {
    h.update(d.relName);
    h.update('\0');
    h.update(readGateArtifactBytes(d, d.role === 'planIndex' ? prereadIndex : undefined));
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}
// The guard. UNCONDITIONAL: it never reads state.review.adversary — a missing/off flag must NOT be able
// to silently disable enforcement (H5 fail-closed). A recorded done OR skipped event at the CURRENT hash
// satisfies it (fail-soft: a degraded lane records a skip and the flow advances — docs/policy/dispatch.md,
// the lane never hard-blocks). --force is the explicit escape hatch: it appends a `<gate>_gate_bypassed`
// audit event and returns (no resolve/hash, so recovery works even with missing/escaping artifacts).
// Otherwise it writes the actionable run_gate_review op to fd 1 with a SYNCHRONOUS write (never out()+exit
// — process.exit can truncate a buffered large write) and EXITS NONZERO (3): a dumb caller fails loudly,
// while the masterplan shell parses the op and satisfies it.
function enforceGateReview(gate, statePath, flags, state, opts = {}) {
  gateEventTypes(gate); // validate the gate name up front (throws on caller bug, even under --force)
  if (flags.force) {
    try {
      appendEvent(statePath, {
        type: `${gate}_gate_bypassed`,
        ts: new Date().toISOString(),
        data: { reason: 'force' },
        summary: `${gate} gate bypassed via --force`,
      });
    } catch {
      /* audit is best-effort — never block a --force recovery on an events.jsonl write */
    }
    return;
  }
  const op = opts.op || (gate === 'spec' ? 'set-phase' : 'load-plan');
  const descriptors = resolveGateArtifacts({ gate, statePath, state, flags, op });
  const hash = computeGateHash(descriptors, opts.prereadIndex);
  const eventsPath = path.join(path.dirname(statePath), 'events.jsonl');
  let text = '';
  try {
    text = fs.readFileSync(eventsPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') die(`gate-review: events.jsonl unreadable: ${e.message}`, 1);
  }
  if (selectGateReview(text, gate, hash).present) return;
  const opObj = {
    op: 'run_gate_review',
    gate,
    hash,
    artifacts: descriptors.map((d) => d.relName),
    message:
      `${gate} gate: no cross-vendor adversarial review is recorded for the CURRENT ${gate} artifacts. ` +
      `Run the adversary lane (agent-dispatch review --class adversary) over them, then record it: ` +
      `\`mp record-gate-review --state=${statePath} --gate=${gate} --status=done --receipt=<receipt.json>\` ` +
      `(or --status=skipped --reason=<why> --digest-file=<notes> if the lane is degraded), then retry this ` +
      `transition. (--force bypasses for recovery/scripting and is audited.)`,
  };
  fs.writeSync(1, JSON.stringify(opObj) + '\n');
  process.exit(3);
}

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

// Guard D owner identity, resolved once for every verb that touches the sentinel
// (acquire/heartbeat/release-owner + record-result). Identity is the LLM SESSION
// (CLAUDE_CODE_SESSION_ID), not the ephemeral mp process; slug is best-effort lock metadata.
function resolveOwnerSelf(flags, statePath) {
  const bundleDir = path.dirname(statePath);
  const host =
    typeof flags.host === 'string' && flags.host.trim() ? flags.host.trim() : os.hostname();
  const session =
    typeof flags.session === 'string' && flags.session.trim()
      ? flags.session.trim()
      : String(process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (!session) {
    die('owner: no session id — pass --session or set CLAUDE_CODE_SESSION_ID', 1);
  }
  let slug = typeof flags.slug === 'string' ? flags.slug : undefined;
  if (slug == null) {
    try {
      slug = readState(statePath).slug;
    } catch {
      /* bundle not yet readable — leave slug undefined */
    }
  }
  const now = Number.isFinite(Number(flags.now)) ? Number(flags.now) : Date.now();
  const ttlMs = Number.isFinite(Number(flags['ttl-ms'])) ? Number(flags['ttl-ms']) : undefined;
  let self;
  try {
    self = buildOwnerIdentity({ host, session, slug, now });
  } catch (e) {
    die(`owner: ${e.message}`, 1);
  }
  return { bundleDir, self, now, ttlMs };
}

// Valid task statuses the v8 shell may WRITE via mark-task. Minimal + decide-consistent:
// decideNextAction treats anything !== 'done' as "still needs work", so pending/in_progress map
// correctly and a typo ('doen', 'complete') is rejected rather than silently mis-recorded. (Legacy
// v7 statuses like 'skipped'/'in-progress' live only in pre-migration bundles — migrate's concern.)
const VALID_TASK_STATUS = ['pending', 'in_progress', 'done'];

// Valid bundle phases (the brainstorm→plan→execute lifecycle) and run statuses the shell may WRITE
// via set-phase/set-status. Enum-validated at the bin boundary (mirror of VALID_TASK_STATUS):
// validateCoreState only PRESENCE-checks phase/status, so a typo'd 'archive'/'plann' would pass the
// schema yet break the §2 discover filter (keys on status==='archived') or the resume.mjs pre-execute
// guard (keys on phase ∈ {brainstorm,plan}). Reject at the source. Value-enum only — NO transition
// ordering (recovery/restart legitimately moves phase backward; a re-opened run goes archived→in-progress).
const VALID_PHASE = ['brainstorm', 'plan', 'execute'];
const VALID_STATUS = ['in-progress', 'archived'];
const VALID_PLANNING_MODE = ['serial', 'parallel', 'auto'];

// Worktree dispositions the shell may WRITE via set-worktree-disposition come from
// lib/worktree.mjs VALID_DISPOSITIONS (imported above as VALID_WORKTREE_DISPOSITION —
// single source; a premature retirement is reverted via the SAME verb, no CD-7 hand-edit).

// Valid codex routing values the shell may WRITE via set-codex-config. The codex routing annotation is
// informational-only in v8 (no Codex implementer; see docs/conventions/plan-annotations.md). 'off'
// disengages it, 'auto'/'on' keep it engaged. Writes the NESTED state.codex.routing (the shape the
// dispatch path reads) — NOT the flat codex_routing key the old fix text named. Value-enum only — no
// transition ordering (a bundle may re-engage codex later).
const VALID_CODEX_ROUTING = ['auto', 'on', 'off'];

// The four resolved choices the §2 finish-flow's durable `branch_finish` gate offers (merge to base /
// push+PR / keep as-is / discard). finish-status maps each to its worktree disposition via
// lib/finish.mjs dispositionForChoice, so the shell reads the value data-driven from the emitted
// `dispositions` map rather than hardcoding the {removed_after_merge|kept_by_user} enum in prose.
const BRANCH_CHOICES = ['merge', 'pr', 'keep', 'discard'];

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

export function shouldSuppressWorkflow(flags = {}, env = process.env) {
  // `codexSuppressed` is the historical internal name for the no-Workflow path:
  // the host runs wave tasks foreground-sequential and records the standard result.
  // Pi exposes subagents/tools but not Claude Code's Workflow launch/promote handle,
  // so returning `launch_workflow` there strands a phase-1 `{wave,phase:'launching'}`
  // marker at the user-facing `/masterplan next` boundary. Treat Pi as no-Workflow by
  // default; callers can still pass the explicit flag on any host.
  return !!flags['codex-suppressed'] || !!flags['no-workflow'] || env.PI_CODING_AGENT === 'true';
}

// applyPlanIndex (backfill-waves) moved to lib/bundle.mjs for T2.3 so lib/continue.mjs can
// backfill without importing the CLI; re-exported here to keep bin's public import surface.
export { applyPlanIndex };

// ---- subcommand dispatch ----
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

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
      out(host);
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
    case 'seed': {
      // Create a fresh v8 brainstorm bundle. The shell's "seed the bundle" step (§3) routes HERE
      // instead of raw-Writing state.yml — keeps bin the sole writer (CD-7) and emits no screen-
      // flooding diff (anti-flood). Refuse an existing bundle unless --force (seed is for NEW runs;
      // the resume controller only calls it when no active bundle was found).
      const p = need(flags, 'state');
      if (fs.existsSync(p) && !flags.force) {
        die(`seed: ${p} already exists — pass --force to overwrite (this replaces the bundle's core state).`, 1);
      }
      if (flags['planning-mode'] !== undefined && !VALID_PLANNING_MODE.includes(flags['planning-mode'])) {
        die(`invalid --planning-mode '${flags['planning-mode']}' — expected one of: ${VALID_PLANNING_MODE.join(', ')}`);
      }
      if (flags['owner-lock'] !== undefined && !['on', 'off'].includes(flags['owner-lock'])) {
        die(`invalid --owner-lock '${flags['owner-lock']}' — expected on or off`);
      }
      // --adversary-review: opt-out for the default-on finish-time review (--codex-review is a hidden
      // back-compat alias). Accepts on|off (the set-review-config subcommand accepts the same
      // vocabulary). Undefined → buildSeedState's default-true applies (spec §4.1).
      const reviewFlag = flags['adversary-review'] ?? flags['codex-review'];
      if (reviewFlag !== undefined && !['on', 'off'].includes(reviewFlag)) {
        die(`invalid --adversary-review '${reviewFlag}' — expected on or off`);
      }
      const dir = path.dirname(p);
      let state;
      try {
        state = buildSeedState({
          slug: need(flags, 'slug'),
          topic: need(flags, 'topic'),
          createdAt: flags['created-at'] ?? new Date().toISOString(),
          phase: flags.phase ?? 'brainstorm',
          status: flags.status ?? 'in-progress',
          schemaVersion: flags['schema-version'] !== undefined ? Number(flags['schema-version']) : 8,
          complexity: flags.complexity,
          complexitySource: flags['complexity-source'],
          autonomy: flags.autonomy,
          planningMode: flags['planning-mode'],
          predecessorTranscript: flags['predecessor-transcript'],
          // Path fields default to siblings of the BUNDLE DIR (its authoritative location), so a
          // non-canonical seed path stays self-consistent; explicit flags override.
          specPath: flags['spec-path'] ?? path.join(dir, 'spec.md'),
          planPath: flags['plan-path'] ?? path.join(dir, 'plan.md'),
          planIndexPath: flags['plan-index-path'] ?? path.join(dir, 'plan.index.json'),
          ownerLock: flags['owner-lock'],
          codexReview: reviewFlag === undefined ? true : reviewFlag === 'on',
        });
      } catch (e) {
        die(e.message, 1);
      }
      writeState(p, state);
      out({ seeded: state.slug, phase: state.phase, status: state.status, path: p }); // terse: no full-state echo (anti-flood)
      break;
    }
    case 'seed-tasks': {
      // Populate state.tasks from plan.index.json — the fresh-plan path's missing CD-7 writer. After
      // the planner writes plan.index.json (§3), this loads those tasks into the bundle so the execute
      // loop has a wave/task list. Without it the shell had to hand-rewrite state.yml (CD-7 violation +
      // screen-flooding diff), and — worse — a `decide` at phase=execute over tasks:[] FINALIZES an
      // empty run (resume.mjs's zero-task diversion only covers brainstorm|plan). So §3 MUST run this
      // BEFORE `set-phase --phase=execute`. Refuse to clobber a non-empty task list unless --force
      // (mid-run safety, mirror of `seed`). Reuse backfill-waves' integer-wave stuck-guard so a
      // string/missing wave fails loud HERE, before writing, not on the next `decide`.
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const existing = state.tasks ?? [];
      if (existing.length && !flags.force) {
        die(`seed-tasks: ${p} already has ${existing.length} task(s) — pass --force to replace them ` +
            `(discards their statuses). seed-tasks is the initial plan→state population, not a re-sync.`, 1);
      }
      let tasks;
      try {
        tasks = buildTasksFromPlanIndex(JSON.parse(readText(need(flags, 'plan-index'))));
      } catch (e) {
        die(e.message, 1);
      }
      const stuck = tasks.filter((task) => task.status !== 'done' && !Number.isInteger(task.wave));
      if (stuck.length) {
        die(`seed-tasks: ${stuck.length} task(s) have no integer wave (ids: ${stuck.map((t) => t.id).join(', ')}) ` +
            `— missing wave/parallel_group or a non-integer value (e.g. "2" instead of 2) in plan.index.json.`, 1);
      }
      writeState(p, { ...state, tasks });
      out({ seeded_tasks: tasks.length, waves: [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b) }); // terse (anti-flood)
      break;
    }
    case 'event': {
      // Append one activity line to the bundle's events.jsonl. Sole writer of that file alongside
      // seed; the shell records lifecycle milestones HERE, never via raw Write/Edit (CD-7 + anti-flood).
      const p = need(flags, 'state');
      const record = { type: need(flags, 'type'), ts: flags.ts ?? new Date().toISOString() };
      if (flags.phase !== undefined) record.phase = flags.phase;
      if (flags.note !== undefined) record.note = flags.note;
      // --note-file is the SHELL-SAFE transport for free-text the caller can't trust on a command line.
      // The §2c finish-gate's codex-review digest is review-derived text — a stray quote/backtick/$()/
      // newline interpolated into `mp event --note="<digest>"` would break the bash word (dropping the
      // event → re-introducing the P2) or inject. So the shell `Write`s the digest to a file (Write is
      // not shell-evaluated) and passes the PATH; bin reads the bytes verbatim into record.note. The
      // path itself is caller-controlled (safe). Mutually exclusive with --note.
      if (flags['note-file'] !== undefined) {
        if (flags.note !== undefined) die('event: --note and --note-file are mutually exclusive', 1);
        try {
          record.note = fs.readFileSync(String(flags['note-file']), 'utf8');
        } catch (e) {
          die(`event: --note-file unreadable: ${e.message}`, 1);
        }
      }
      // --summary is the SIGNAL channel (vs free-text --note): the session audit's _event_text scans
      // type/kind/event/message/detail/summary/notes/status — NOT note. So a milestone whose phrasing
      // a policy-watcher must COUNT (e.g. the §2c whole-branch "codex review" gate, which trips
      // codex_review_configured_but_zero_invocations when uncounted) puts that phrasing here.
      if (flags.summary !== undefined) record.summary = flags.summary;
      if (flags.data !== undefined) {
        try {
          record.data = JSON.parse(flags.data);
        } catch {
          die(`event: --data must be valid JSON (got ${JSON.stringify(flags.data)})`, 1);
        }
      }
      let eventsPath;
      try {
        eventsPath = appendEvent(p, record);
      } catch (e) {
        die(e.message, 1);
      }
      out({ event: record.type, ts: record.ts, path: eventsPath }); // terse confirmation
      break;
    }
    case 'goals-load': {
      // Freeze goals.md into the bundle: parse/validate via lib/goals.mjs, cache into state.goals,
      // record the goals.md content hash, and append goals_frozen (the COMMIT point) carrying the
      // user-approval receipt keyed to the exact goals hash. One-shot semantics: any prior goal
      // LIFECYCLE event (goals_frozen/goal_amended/goal_check/goal_waived) — NOT the seed-time
      // capability event — or a phase past capture (anything other than brainstorm) rejects, so a
      // re-freeze can never launder a new goal set in. A re-run at the IDENTICAL goals hash is an
      // idempotent roll-forward (crash-safe): re-materialize the derived artifacts/cache but NEVER
      // double-append the commit event. Multi-file write ordering is artifacts-FIRST (goals.md
      // temp+rename, then state.yml temp+rename via the single-writer writeState), event append LAST.
      const p = need(flags, 'state');
      const dir = path.dirname(p);
      const state = loadForWrite(p);
      let goalsMd;
      try {
        goalsMd = fs.readFileSync(String(need(flags, 'goals')), 'utf8');
      } catch (e) {
        die(`goals-load: --goals unreadable: ${e.message}`, 1);
      }
      const parsed = parseGoals(goalsMd);
      const val = validateGoals(parsed);
      if (!val.ok) die(`goals-load: invalid goals.md — ${val.error}`, 1);
      const hash = goalsHash(goalsMd);
      let approval;
      try {
        approval = JSON.parse(fs.readFileSync(String(need(flags, 'approval')), 'utf8'));
      } catch (e) {
        die(`goals-load: --approval unreadable or not JSON: ${e.message}`, 1);
      }
      const ar = validateUserApprovalReceipt(approval, { goalsHash: hash, purpose: 'goal_load' });
      if (!ar.ok) die(`goals-load: invalid approval receipt — ${ar.error}`, 1);
      // Read events for the one-shot check (absent file == no events yet; any non-ENOENT read error
      // fails loud rather than masquerading as an empty log).
      const goalsEventsPath = path.join(dir, 'events.jsonl');
      let goalsEventsText = '';
      try {
        goalsEventsText = fs.readFileSync(goalsEventsPath, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') die(`goals-load: events.jsonl unreadable: ${e.message}`, 1);
      }
      const goalEvents = goalsEventsText
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      // PLAN-GATE FINDING: one-shot rejection counts only goal LIFECYCLE events; the seed-time
      // capability event (bundle_created) does NOT block the first goals-load.
      const priorFrozen = goalEvents.filter((e) => e.type === 'goals_frozen');
      const otherGoalEvents = goalEvents.filter(
        (e) => GOAL_LIFECYCLE_EVENT_TYPES.includes(e.type) && e.type !== 'goals_frozen'
      );
      if (otherGoalEvents.length) {
        die(
          `goals-load: rejected — a goal lifecycle event (${[...new Set(otherGoalEvents.map((e) => e.type))].join(', ')}) already exists; goals are past initial capture (use goals-amend for sanctioned changes)`,
          1
        );
      }
      if (priorFrozen.length) {
        const priorHash = priorFrozen[priorFrozen.length - 1]?.data?.goals_hash;
        if (priorHash === hash) {
          // Idempotent roll-forward: a prior freeze already committed at THIS exact hash. A crash
          // could have died between the artifact writes and the event append, or after — either way
          // re-materialize the derived artifacts + cache to converge, but never re-append the event.
          const goalsMdTmp = path.join(dir, 'goals.md.tmp');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(goalsMdTmp, goalsMd, 'utf8');
          fs.renameSync(goalsMdTmp, path.join(dir, 'goals.md'));
          writeState(p, { ...state, goals: parsed.goals, goals_md_hash: hash });
          out({ goals_load: 'idempotent', goals_hash: hash, goals: parsed.goals.length });
          break;
        }
        die(
          `goals-load: rejected — goals already frozen at a different hash (${priorHash}); a re-freeze would launder a new goal set (use goals-amend)`,
          1
        );
      }
      // One-shot phase gate: capture is the brainstorm->plan boundary; any phase other than
      // brainstorm is past the capture window.
      if (state.phase !== undefined && state.phase !== null && state.phase !== 'brainstorm') {
        die(
          `goals-load: rejected — phase is '${state.phase}', past the goal-capture window (brainstorm); goals can only be frozen before planning`,
          1
        );
      }
      // ---- multi-file write: artifacts FIRST (each temp+rename), event append LAST as commit ----
      const goalsMdTmp = path.join(dir, 'goals.md.tmp');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(goalsMdTmp, goalsMd, 'utf8');
      fs.renameSync(goalsMdTmp, path.join(dir, 'goals.md'));
      writeState(p, { ...state, goals: parsed.goals, goals_md_hash: hash });
      const goalsFrozenRecord = {
        type: 'goals_frozen',
        ts: flags.ts ?? new Date().toISOString(),
        data: { goals_hash: hash, approval: ar.normalized },
        summary: `goals frozen (${parsed.goals.length} goals) at ${hash}`,
      };
      appendEvent(p, goalsFrozenRecord);
      out({
        goals_load: 'frozen',
        goals_hash: hash,
        goals: parsed.goals.length,
        event: 'goals_frozen',
        ts: goalsFrozenRecord.ts,
      });
      break;
    }
    case 'goals-amend': {
      // The ONLY sanctioned mid-run goal change. Requires a FRESH user-approval receipt bound to BOTH
      // the prior (old) goals hash AND the new goals hash (purpose 'goal_amend') — never autonomous.
      // IDs stay stable (renumbering rejected via validateAmendment); a removed goal must arrive as a
      // tombstone {reason, amended_at} (a bare deletion is rejected). Appends a goal_amended event
      // recording old->new hash + reason plus the full old/new content (text+signal) of every changed
      // goal (amendmentDiff). Because every goal_check receipt and goal_waived waiver is keyed to the
      // goals hash, advancing the frozen hash structurally invalidates them all (their validators reject
      // a receipt/waiver whose goals_hash no longer matches) — the event records how many it strands.
      // Reuses the goals-load multi-file write ordering: artifacts (goals.md temp+rename) FIRST, state
      // via the single-writer writeState, event append LAST as the commit point.
      const p = need(flags, 'state');
      const dir = path.dirname(p);
      const state = loadForWrite(p);
      let goalsMd;
      try {
        goalsMd = fs.readFileSync(String(need(flags, 'goals')), 'utf8');
      } catch (e) {
        die(`goals-amend: --goals unreadable: ${e.message}`, 1);
      }
      const reason = String(need(flags, 'reason')).trim();
      if (!reason) die('goals-amend: --reason must be a non-empty amendment justification', 1);
      const parsed = parseGoals(goalsMd);
      const newHash = goalsHash(goalsMd);
      // Read events: an amendment requires an already-committed goal set (goals_frozen), and drives the
      // idempotent roll-forward off the latest goal_amended (absent file == no events; a non-ENOENT read
      // error fails loud rather than masquerading as an empty log).
      const amendEventsPath = path.join(dir, 'events.jsonl');
      let amendEventsText = '';
      try {
        amendEventsText = fs.readFileSync(amendEventsPath, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') die(`goals-amend: events.jsonl unreadable: ${e.message}`, 1);
      }
      const amendAllEvents = amendEventsText
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const priorFrozenForAmend = amendAllEvents.filter((e) => e.type === 'goals_frozen');
      if (!priorFrozenForAmend.length) {
        die(
          'goals-amend: rejected — no goals_frozen event exists; nothing to amend (use goals-load to freeze the initial goal set first)',
          1
        );
      }
      const amendEvents = amendAllEvents.filter((e) => e.type === 'goal_amended');
      const lastAmend = amendEvents[amendEvents.length - 1];
      // Idempotent roll-forward: the latest amendment already committed at THIS new hash (a crash could
      // have died after the event append, or between the artifact writes and it). Re-materialize the
      // derived artifacts + cache to converge, but NEVER double-append the event.
      if (lastAmend && lastAmend.data && lastAmend.data.new_goals_hash === newHash) {
        const goalsMdTmp = path.join(dir, 'goals.md.tmp');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(goalsMdTmp, goalsMd, 'utf8');
        fs.renameSync(goalsMdTmp, path.join(dir, 'goals.md'));
        writeState(p, { ...state, goals: parsed.goals, goals_md_hash: newHash });
        out({ goals_amend: 'idempotent', new_goals_hash: newHash, goals: parsed.goals.length });
        break;
      }
      // Old (currently committed) goal set + hash: state.goals is the derived cache, keyed by goals_md_hash.
      const oldGoals = Array.isArray(state.goals) ? state.goals : [];
      const oldHash =
        state.goals_md_hash ??
        (lastAmend ? lastAmend.data.new_goals_hash : priorFrozenForAmend[priorFrozenForAmend.length - 1].data.goals_hash);
      // Amendment structural rules: new doc valid, IDs stable (no renumbering), removals are tombstones.
      const amv = validateAmendment(oldGoals, parsed.goals);
      if (!amv.ok) die(`goals-amend: invalid amendment — ${amv.error}`, 1);
      if (newHash === oldHash) {
        die('goals-amend: rejected — new goals are identical to the current goals (nothing to amend)', 1);
      }
      // Fresh user-approval receipt bound to BOTH the old and new hash (never autonomous).
      let approval;
      try {
        approval = JSON.parse(fs.readFileSync(String(need(flags, 'approval')), 'utf8'));
      } catch (e) {
        die(`goals-amend: --approval unreadable or not JSON: ${e.message}`, 1);
      }
      const ar = validateUserApprovalReceipt(approval, { goalsHash: newHash, oldGoalsHash: oldHash, purpose: 'goal_amend' });
      if (!ar.ok) die(`goals-amend: invalid approval receipt — ${ar.error}`, 1);
      const changes = amendmentDiff(oldGoals, parsed.goals);
      // Count the receipts/waivers this amendment strands: all are hash-keyed, so advancing the goals
      // hash invalidates every goal_check / goal_waived recorded against the OLD hash.
      const invalidated = amendAllEvents.filter(
        (e) =>
          (e.type === 'goal_check' || e.type === 'goal_waived') &&
          (e.data?.goals_hash === oldHash ||
            e.data?.receipt?.goals_hash === oldHash ||
            e.data?.waiver?.goals_hash === oldHash)
      ).length;
      // ---- multi-file write: artifacts FIRST (temp+rename), event append LAST as the commit ----
      const goalsMdTmp = path.join(dir, 'goals.md.tmp');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(goalsMdTmp, goalsMd, 'utf8');
      fs.renameSync(goalsMdTmp, path.join(dir, 'goals.md'));
      writeState(p, { ...state, goals: parsed.goals, goals_md_hash: newHash });
      const goalAmendedRecord = {
        type: 'goal_amended',
        ts: flags.ts ?? new Date().toISOString(),
        data: {
          old_goals_hash: oldHash,
          new_goals_hash: newHash,
          goals_hash: newHash,
          reason,
          changes,
          invalidated_receipts: invalidated,
          approval: ar.normalized,
        },
        summary: `goals amended (${changes.length} changed) ${oldHash} -> ${newHash}: ${reason}`,
      };
      appendEvent(p, goalAmendedRecord);
      out({
        goals_amend: 'amended',
        old_goals_hash: oldHash,
        new_goals_hash: newHash,
        changes: changes.length,
        invalidated_receipts: invalidated,
        event: 'goal_amended',
        ts: goalAmendedRecord.ts,
      });
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
    case 'load-plan': {
      // The plan→execute seam. Materialize state.tasks from a freshly-built plan.index.json AND advance
      // phase→execute in ONE writeState. This is the single crash-safe ordering: decideNextAction
      // dispatches off the task list (not the phase label), so a `set-phase execute` that left tasks:[]
      // would make the next `decide` return `complete` → ARCHIVE the just-planned bundle (data loss).
      // loadPlanTasks bundles tasks + phase into one state object; the atomic tmp+rename lands both or
      // neither. Validate the index FIRST — the serial path's mp-planner Writes plan.index.json directly
      // (unguarded by merge-plan-fragments' pre-write validation), so this is the compensating gate.
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      // Clobber guard FIRST (P3a): a bundle that already has tasks (a double-load / crash-recovery re-run
      // on a populated bundle) is a cheap STRUCTURAL rejection — refuse it BEFORE reading/parsing/
      // validating/gating an index we would never apply, so the operator sees the real "already populated"
      // message rather than a confusing downstream parse/validate error. loadPlanTasks keeps its own
      // identical guard (defense in depth for its other callers); this is the bin-layer hoist so the
      // refusal precedes both index validation and the gate (mirrors set-phase's 0-task guard ordering).
      if (state.tasks?.length) {
        die(
          `load-plan: ${p} already has ${state.tasks.length} task(s) — refusing to overwrite execution ` +
            `state. (To re-derive waves on an existing task list, use backfill-waves.)`,
          1
        );
      }
      const planIndexPath = need(flags, 'plan-index');
      // Read + parse the index ONCE; reuse this object for validate + gate + stamp + materialize (closes
      // the read→hash TOCTOU — the gate hashes the exact bytes we validated and will materialize).
      let index;
      try {
        index = JSON.parse(readText(planIndexPath));
      } catch (e) {
        die(`load-plan: ${planIndexPath} is not valid JSON (${e.message})`, 1);
      }
      // Schema floor: refuse to materialize a pre-v8 index. Mirrors the doctor's plan-index-schema
      // gate (lib/doctor/plan-index-schema.mjs) and loadForWrite's `major < 6` guard — parse the
      // major the same way so both '6.0' (string, from merge-plan-fragments) and 6 (number) pass.
      const major = Number(String(index?.schema_version ?? '').split('.')[0]);
      if (!Number.isInteger(major) || major < 6) {
        die(
          `load-plan: ${planIndexPath} has schema_version ${JSON.stringify(index?.schema_version)} — ` +
            `expected the v8 floor (>= 6, canonical '6.0'). Rebuild with merge-plan-fragments, or ` +
            `migrate a legacy index, before materializing.`,
          1
        );
      }
      const errors = validatePlanIndex(index);
      if (errors.length) {
        for (const e of errors) process.stderr.write(`  - ${e}\n`);
        die(`load-plan: ${errors.length} error(s) in ${planIndexPath} — refusing to materialize an invalid plan.`, 1);
      }
      // §plan gate: the plan→execute seam requires a recorded cross-vendor adversarial review of the
      // CURRENT plan artifacts (spec.md + plan.md + normalized plan.index.json). AFTER the clobber guard
      // (hoisted above) and index validation (don't gate a malformed plan), BEFORE the plan_hash stamping
      // below (the gate hash normalizes that stamp out). Pass the already-parsed index as prereadIndex so
      // the gate hashes exactly the bytes we validated and will materialize. Exits nonzero unless --force.
      enforceGateReview('plan', p, flags, state, { op: 'load-plan', prereadIndex: index });
      // A3: plan_hash parity — if the loaded index lacks plan_hash, compute sha256:<hex of plan.md>
      // in the exact merge-plan-fragments form and stamp it + generated_at into the index file.
      // Graceful: skip silently if plan_hash already present OR plan.md is not readable (the test
      // fixtures don't create plan.md, so a hard die would break existing tests). Idempotent: a
      // second load-plan at unchanged plan.md leaves the index byte-for-byte the same.
      if (!index.plan_hash) {
        const planMdPath = flags['plan-md'] ?? path.join(path.dirname(planIndexPath), 'plan.md');
        let planMdText;
        try {
          planMdText = fs.readFileSync(planMdPath, 'utf8');
        } catch {
          planMdText = null; // plan.md absent or unreadable — skip stamping
        }
        if (planMdText !== null) {
          index.plan_hash = `sha256:${createHash('sha256').update(planMdText).digest('hex')}`;
          if (!index.generated_at) index.generated_at = new Date().toISOString();
          fs.writeFileSync(planIndexPath, JSON.stringify(index, null, 2) + '\n');
        }
      }
      let next;
      try {
        next = loadPlanTasks(state, index); // throws: bundle already has tasks / empty index / non-integer wave
      } catch (e) {
        die(e.message, 1);
      }
      // Auto-emit the rendered plan.html artifact (additive; plan.md stays canonical). BEST-EFFORT
      // and BEFORE the state write: a render/write failure logs a warning and is swallowed — it must
      // never fail load-plan or perturb the single atomic writeState below. Freshly materialized tasks
      // are all 'pending', so the static emit has no live status map. Artifact write (fs), not CD-7 state.
      try {
        const planHtmlPath = flags['plan-html'] ?? path.join(path.dirname(planIndexPath), 'plan.html');
        fs.writeFileSync(planHtmlPath, renderPlanHtml(index, { title: state.slug ?? 'Plan' }));
      } catch (e) {
        process.stderr.write(`load-plan: plan.html not emitted (${e.message})\n`);
      }
      writeState(p, next);
      out({ loaded: next.tasks.length, waves: new Set(next.tasks.map((t) => t.wave)).size, phase: next.phase });
      break;
    }
    case 'render-plan': {
      // The `render` verb's engine. Re-render plan.html with LIVE status from state.tasks. READ-ONLY
      // w.r.t. state — no writeState, no owner-lock mutation; state.yml bytes stay untouched. fs-only:
      // no network, no secrets, deterministic. (Auto-emit at load-plan covers the static plan-finalize
      // artifact; this regenerates it on demand with execution status.)
      const p = need(flags, 'state');
      const state = readState(p);
      const planIndexPath = flags['plan-index'] ?? path.join(path.dirname(p), 'plan.index.json');
      let index;
      try {
        index = JSON.parse(readText(planIndexPath));
      } catch (e) {
        die(`render-plan: ${planIndexPath} is not valid JSON (${e.message})`, 1);
      }
      const taskStatus = {};
      for (const t of state.tasks ?? []) taskStatus[Number(t.id)] = t.status;
      const planHtmlPath = flags['plan-html'] ?? path.join(path.dirname(planIndexPath), 'plan.html');
      fs.writeFileSync(planHtmlPath, renderPlanHtml(index, { title: state.slug ?? 'Plan', taskStatus }));
      out({ rendered: planHtmlPath, tasks: (state.tasks ?? []).length });
      break;
    }
    case 'prepare-wave': {
      // Pre-resolve everything the L2 workflow needs for one wave, since a Workflow script has
      // NO module/fs access — "L2 consumes lib/dispatch/" can only mean L1 resolves routing here and
      // hands lean payloads down via `args`. loadForWrite is the strict-v8 guard (this is a read,
      // but mid-run the bundle is already v8; a legacy one reaching here should fail loud, not route).
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const planIndex = JSON.parse(readText(need(flags, 'plan-index')));
      const wave = coerceId(need(flags, 'wave'));
      // routing config: persisted `codex.routing` wins; --routing overrides; default 'auto'. env facts
      // (host-suppression, linked-worktree) are git/host-probed by the shell and passed as flags.
      const config = {
        routing: state.codex?.routing ?? flags.routing ?? 'auto',
        // Pluggable implementer backend (contract-first; default OFF). Always {} today since
        // buildSeedState never emits `implementer` -> resolveImplementerBackend returns
        // {kind:'agent'} -> byte-identical to shipping. Flipping the live qctl binding is a
        // binding-time concern (design spec §5).
        implementer: state.implementer ?? {},
      };
      const env = {
        codexHostSuppressed: !!flags['codex-suppressed'],
        linkedWorktree: !!flags['linked-worktree'],
      };
      // Flag-flip precondition #5: the production repos.yml loader. Optional --repos-allowlist carries
      // the parsed repos.yml (the shell does `python3 -c 'yaml->json' < repos.yml`); it is threaded as
      // prepareWave's 6th arg so the qctlEligible gate can pass. Absent → undefined → the gate
      // fail-closes (every qctl route downgrades to {kind:agent}), so omitting it is byte-identical to
      // the pre-wiring build. Parsed leniently (any JSON-decodable value Object.values can walk).
      let reposAllowlist;
      if (flags['repos-allowlist'] !== undefined) {
        try {
          reposAllowlist = JSON.parse(flags['repos-allowlist']);
        } catch (e) {
          die(`prepare-wave: --repos-allowlist must be valid JSON (${e.message})`, 1);
        }
        if (reposAllowlist === null || typeof reposAllowlist !== 'object') {
          die('prepare-wave: --repos-allowlist must be a JSON object (parsed repos.yml)', 1);
        }
      }
      let result;
      try {
        result = prepareWave(state, planIndex, wave, config, env, reposAllowlist); // throws: non-integer wave / drift
      } catch (e) {
        die(e.message);
      }
      // Surface the review mode from the SAME read so the shell needn't parse state.yml itself; the
      // workflow gates review on `=== 'on'`. Normalize leniently (config schema is finalized in step 7).
      const rawReview = state.review?.adversary ?? state.codex?.review ?? flags.review;
      const review = rawReview === true || rawReview === 'on' || rawReview === 'true' ? 'on' : 'off';
      out({ ...result, review });
      break;
    }
    case 'verify-scope': {
      // The D6/F-SCOPE post-barrier check. The allow-set is the IMMUTABLE launch-time scope snapshot
      // (active_run.scope), captured by `set-active-run --scope` from prepareWave's resolved file union
      // BEFORE any agent ran. We deliberately do NOT re-derive scope from plan.index.json/state.yml here:
      // re-reading a mutable artifact post-barrier lets a rogue agent widen its own allow-set mid-wave
      // (edit plan.index to add rogue.js, then edit rogue.js) — the Codex tamper MAJOR. before/after are
      // the git-touched path sets the SHELL captures (git stays in the shell; bin is fs-only) and passes
      // as JSON arrays; verifyScope does the (after - before) ⊆ declared math. Fallback: a run with no
      // snapshot (predates this field) uses the state-only declaredScope — best-effort, frozen-at-seed.
      const p = need(flags, 'state');
      const wave = coerceId(need(flags, 'wave'));
      const state = loadForWrite(p);
      const snapshot = Array.isArray(state.active_run?.scope) ? state.active_run.scope : null;
      const declared = snapshot ?? declaredScope(state, wave);
      let before;
      let after;
      try {
        // --before fallback: on the normal completion path the shell passes the workflow's echoed
        // `before`; on a finalize_run RESUME after a crash (the workflow result is gone) it is omitted, so
        // fall back to the baseline persisted in the marker (set-active-run --baseline) — the Codex P1 fix
        // that makes verify-scope re-runnable on resume rather than silently skipped.
        const persistedBaseline = Array.isArray(state.active_run?.baseline) ? state.active_run.baseline : null;
        before =
          flags.before !== undefined ? JSON.parse(flags.before) : persistedBaseline ?? [];
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
      if (flags.kind !== undefined) {
        if (flags.kind !== 'plan') {
          die(`invalid --kind '${flags.kind}' — expected: plan`);
        }
        const run = { kind: 'plan', phase: 'launching' };
        writeState(p, setActiveRun(loadForWrite(p), run));
        out({ active_run: run });
        break;
      }
      const wave = coerceId(need(flags, 'wave'));
      // set-active-run is the SOLE ORIGIN of the active_run wave; enforce the integer-wave invariant
      // HERE at the source (mirror of promote's guard below). Without it a `--wave=2.0`/`--wave=foo`/
      // bare `--wave` persists a phase-1 marker that decideNextAction then throws on at the next
      // `decide`, wedging the loop until a manual clear-active-run. Fail loud on bad input instead.
      if (!Number.isInteger(wave)) {
        die(`set-active-run: --wave must be an integer (got ${JSON.stringify(flags.wave)}) — it is the ` +
            `phase-1 launching marker's wave that decideNextAction resumes on.`);
      }
      // Optional --scope (JSON array): the IMMUTABLE F-SCOPE allow-set snapshot, captured at LAUNCH from
      // prepareWave's resolved file union and frozen into the phase-1 marker. verify-scope reads it
      // post-barrier instead of re-deriving scope from mutable plan.index/state — closing the tamper hole
      // where a rogue agent widens its own allow-set mid-wave. Absent → no snapshot (verify-scope falls
      // back to state-only declaredScope, the back-compat path).
      const run = { wave, phase: 'launching' };
      if (flags.scope !== undefined) {
        let scope;
        try {
          scope = JSON.parse(flags.scope);
        } catch (e) {
          die(`set-active-run: --scope must be a JSON array of paths (${e.message})`);
        }
        if (!Array.isArray(scope)) {
          die('set-active-run: --scope must be a JSON array of paths');
        }
        run.scope = scope;
      }
      // Optional --baseline (JSON array): the D6 `before` touched-set captured at LAUNCH (before any
      // agent ran). Persisted so that if the session dies AFTER `mp mark-task` but BEFORE the wave's
      // verify-scope/code-commit, the resume `finalize_run` can RE-RUN verify-scope (the workflow result
      // carrying `before` is gone, but the marker still has it) — closing the Codex P1 crash-trace gap
      // where verify-scope was silently skipped. verify-scope falls back to this when --before is omitted.
      if (flags.baseline !== undefined) {
        let baseline;
        try {
          baseline = JSON.parse(flags.baseline);
        } catch (e) {
          die(`set-active-run: --baseline must be a JSON array of paths (${e.message})`);
        }
        if (!Array.isArray(baseline)) {
          die('set-active-run: --baseline must be a JSON array of paths');
        }
        run.baseline = baseline;
      }
      // Optional --ws-baseline (JSON array): workspace root entries captured at LAUNCH.
      // Post-wave, any new non-hidden entries in the workspace root (vs this baseline)
      // are removed — agents must never create loose files in the workspace root.
      if (flags['ws-baseline'] !== undefined) {
        let wsBaseline;
        try {
          wsBaseline = JSON.parse(flags['ws-baseline']);
        } catch (e) {
          die(`set-active-run: --ws-baseline must be a JSON array of entries (${e.message})`);
        }
        if (!Array.isArray(wsBaseline)) {
          die('set-active-run: --ws-baseline must be a JSON array of entries');
        }
        run.wsBaseline = wsBaseline;
      }
      writeState(p, setActiveRun(loadForWrite(p), run));
      out({ active_run: run });
      break;
    }
    case 'promote-active-run': {
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const prev = state.active_run ?? {};
      if (prev.kind === 'plan') {
        const run = { kind: 'plan', run_id: need(flags, 'run-id'), task_id: need(flags, 'task-id') };
        writeState(p, setActiveRun(state, run));
        out({ active_run: run });
        break;
      }
      // Phase-2 promotion MUST follow a phase-1 launching marker carrying an integer wave
      // (set-active-run --wave=N). Promoting without it writes a wave-less active_run that
      // decideNextAction then mis-finalizes while tasks pend (orphan / double-dispatch). Fail loud.
      if (!Number.isInteger(prev.wave)) {
        die(`promote-active-run: no phase-1 launching marker with an integer wave ` +
            `(active_run=${JSON.stringify(state.active_run ?? null)}) — call \`set-active-run --wave=N\` first.`);
      }
      // Carry the launch-time F-SCOPE snapshot forward: promotion replaces active_run wholesale, so
      // without this the phase-2 marker would drop active_run.scope and verify-scope would silently fall
      // back to the mutable state-only path. Preserve the frozen array set at phase-1.
      const run = { wave: prev.wave, run_id: need(flags, 'run-id'), task_id: need(flags, 'task-id') };
      if (Array.isArray(prev.scope)) run.scope = prev.scope;
      // Carry the launch-time D6 baseline forward too (mirror of scope): the phase-2 marker is what a
      // post-completion-crash resume reads, so without this the finalize_run reconciliation would lose the
      // `before` set it needs to re-run verify-scope.
      if (Array.isArray(prev.baseline)) run.baseline = prev.baseline;
      if (Array.isArray(prev.wsBaseline)) run.wsBaseline = prev.wsBaseline;
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
    case 'set-phase': {
      const p = need(flags, 'state');
      const phase = need(flags, 'phase');
      if (!VALID_PHASE.includes(phase)) {
        die(`invalid --phase '${phase}' — expected one of: ${VALID_PHASE.join(', ')}`);
      }
      const state = loadForWrite(p);
      // §3 ordering invariant + data-loss guard: decideNextAction dispatches off the TASK LIST, not the
      // phase label, so entering execute with 0 tasks is the degenerate state decide refuses to finalize
      // (it would mis-archive a planned-but-unseeded run — data loss). Refuse HERE, at the violation point,
      // so the operator materializes tasks first: `mp seed-tasks` (populate state.tasks only) or `mp load-plan`
      // (populate AND advance phase atomically). --force still moves the phase pointer (recovery / scripting)
      // but does NOT suppress the decide-layer backstop: an unseeded execute run is never "complete".
      if (phase === 'execute' && !(state.tasks?.length) && !flags.force) {
        die(`set-phase: refusing to enter 'execute' with 0 tasks — run \`mp seed-tasks --state=${p} ` +
            `--plan-index=<bundle>/plan.index.json\` (or \`mp load-plan\`, which advances phase atomically) ` +
            `first to load the plan into state.tasks (§3 ordering). Pass --force to advance the phase anyway.`, 1);
      }
      // §spec/plan gate enforcement: --phase=plan is the brainstorm→plan (SPEC) advance; --phase=execute
      // is the alt plan→execute (PLAN) path (load-plan is the normal one, gated identically below — H3
      // closes this bypass). Emits run_gate_review + exits nonzero when unsatisfied; --force bypasses.
      if (phase === 'plan') enforceGateReview('spec', p, flags, state, { op: 'set-phase' });
      if (phase === 'execute') enforceGateReview('plan', p, flags, state, { op: 'set-phase' });
      writeState(p, setPhase(state, phase));
      out({ phase });
      break;
    }
    case 'set-status': {
      const p = need(flags, 'state');
      const status = need(flags, 'status');
      if (!VALID_STATUS.includes(status)) {
        die(`invalid --status '${status}' — expected one of: ${VALID_STATUS.join(', ')}`);
      }
      writeState(p, setStatus(loadForWrite(p), status));
      out({ status });
      break;
    }
    // Parallel-planning: assemble subsystem fragments → canonical plan.index.json + plan.md.
    // The LLM drafters return fragments only; deterministic JS (lib/plan-merge.mjs) owns ids,
    // waves, and codex normalisation. This is an ARTIFACT write (plain fs), NOT a CD-7 state
    // mutation — plan.index.json/plan.md are products, not bundle state. We validate BEFORE
    // writing, so an invalid merge never lands on disk.
    case 'merge-plan-fragments': {
      const fragsPath = need(flags, 'fragments');
      const outIndex = need(flags, 'out');
      const planMdPath = flags['plan-md'] ?? path.join(path.dirname(outIndex), 'plan.md');
      const meta = flags.meta ? JSON.parse(flags.meta) : {};
      let fragments;
      try {
        fragments = JSON.parse(readText(fragsPath));
      } catch (e) {
        die(`merge-plan-fragments: --fragments must be valid JSON (${e.message})`, 1);
      }
      let index;
      try {
        // schemaVersion left to mergePlanFragments' own SCHEMA_VERSION default (single source of truth).
        index = mergePlanFragments(fragments, { schemaVersion: meta.schemaVersion });
      } catch (e) {
        die(`merge-plan-fragments: ${e.message}`, 1);
      }
      const errors = validatePlanIndex(index);
      if (errors.length) {
        die(`merge-plan-fragments: produced an invalid index:\n  - ${errors.join('\n  - ')}`, 1);
      }
      const planMd = renderPlanMd(index, meta);
      // Stamp plan_hash = sha256 of plan.md (mirrors the index-staleness doctor check's source).
      index.plan_hash = `sha256:${createHash('sha256').update(planMd).digest('hex')}`;
      index.generated_at = flags['generated-at'] ?? new Date().toISOString();
      fs.writeFileSync(planMdPath, planMd);
      fs.writeFileSync(outIndex, JSON.stringify(index, null, 2) + '\n');
      out({
        tasks: index.tasks.length,
        waves: new Set(index.tasks.map((t) => t.wave)).size,
        plan_index: outIndex,
        plan_md: planMdPath,
        plan_hash: index.plan_hash,
      });
      break;
    }
    // Standalone strict validator for an existing plan.index.json (CI / manual / pre-execute gate).
    case 'validate-plan-index': {
      const p = need(flags, 'plan-index');
      let index;
      try {
        index = JSON.parse(readText(p));
      } catch (e) {
        die(`validate-plan-index: ${p} is not valid JSON (${e.message})`, 1);
      }
      const errors = validatePlanIndex(index);
      if (errors.length) {
        for (const e of errors) process.stderr.write(`  - ${e}\n`);
        die(`validate-plan-index: ${errors.length} error(s) in ${p}`, 1);
      }
      out({ valid: true, tasks: Array.isArray(index.tasks) ? index.tasks.length : 0, path: p });
      break;
    }
    case 'set-worktree-disposition': {
      const p = need(flags, 'state');
      const disposition = need(flags, 'disposition');
      if (!VALID_WORKTREE_DISPOSITION.includes(disposition)) {
        die(`invalid --disposition '${disposition}' — expected one of: ${VALID_WORKTREE_DISPOSITION.join(', ')}`);
      }
      writeState(p, setWorktreeDisposition(loadForWrite(p), disposition));
      out({ worktree_disposition: disposition });
      break;
    }
    case 'rebase-paths': {
      // CD-7-compliant writer for the bundle's absolute path fields (spec_path / plan_path /
      // plan_index_path / worktree) after a repo relocation. The ONLY writer for these fields besides
      // `seed`; the hand-edit the 2026-06-22 user-owned workstream used was a CD-7 violation. Pure
      // transform lives in lib/bundle.mjs `rebasePaths`; bin does the load/validate/write + reports
      // the per-field count so the operator can confirm the rebased fields. Re-runnable: a second
      // rebase against the already-rebased state is a no-op (the `from` prefix no longer matches).
      const p = need(flags, 'state');
      const fromRoot = need(flags, 'from');
      const toRoot = need(flags, 'to');
      let st;
      try {
        st = rebasePaths(loadForWrite(p), fromRoot, toRoot);
      } catch (e) {
        die(e.message, 1);
      }
      writeState(p, st);
      out({ rebased: st._rebased ?? 0, from: fromRoot, to: toRoot });
      break;
    }
    case 'worktree': {
      // The worktree-lifecycle subcommands (Phase 1). All decidable logic is the PURE lib/worktree.mjs
      // core; bin only does fs (readdir/read) + state writes. git (`worktree add|repair|remove|prune`)
      // stays in the SHELL (CD-7): `plan`/`reconcile` EMIT a plan the shell executes; `record` persists
      // the confirmed outcome. Sub-dispatch on the first positional.
      const sub = positional[0];
      switch (sub) {
        case 'plan': {
          // Create-or-reuse decision at kickoff (READ-ONLY: the shell runs the emitted gitArgs, then
          // records via `worktree record`). slug/existing come from --state when given, else flags.
          const repoRoot = need(flags, 'repo-root');
          let slug = flags.slug;
          let existing = flags.existing ?? null;
          if (flags.state) {
            const st = loadForWrite(flags.state);
            slug = slug ?? st.slug;
            if (existing == null) existing = st.worktree ?? null;
          }
          if (!slug) die('worktree plan: --slug (or --state carrying a slug) is required', 1);
          let plan;
          try {
            plan = planWorktreeCreate({
              slug,
              repoRoot,
              branch: typeof flags.branch === 'string' ? flags.branch : undefined,
              existing,
              branchExists: !!flags['branch-exists'],
              // The crash-window idempotency signal (Codex P1): the shell sets --worktree-registered when
              // the canonical WT path already appears in `git worktree list` (a crash between `worktree
              // add` and `worktree record` left a live worktree with no state.worktree). Then plan = reuse,
              // not a doomed second `worktree add` on the already-present dir.
              registered: !!flags['worktree-registered'],
            });
          } catch (e) {
            die(e.message, 1);
          }
          out(plan);
          break;
        }
        case 'record': {
          // Persist the confirmed outcome (WRITE). Three (composable) modes:
          //   --worktree=PATH                         record the owned worktree path.
          //   --disposition=D                         record an EXPLICIT lifecycle value, NORMALIZED
          //                                           (legacy 'missing' → removed_after_merge; unknown dies).
          //   --choice=C [--removal-confirmed]        record the CRASH-SAFE teardown disposition computed by
          //                                           lib/worktree.dispositionAfterTeardown(choice, confirmed)
          //                                           — merge/discard flip to removed_after_merge ONLY when the
          //                                           shell confirmed the git removal; an unconfirmed teardown
          //                                           stays `active` (reaped on the next reconcile), never the
          //                                           phantom `missing`. This is the §2c teardown's writer:
          //                                           the decision stays in lib (CD-7), invoked through mp, not
          //                                           reconstructed in orchestrator prose.
          // --disposition and --choice both write the disposition field, so they are mutually exclusive.
          const p = need(flags, 'state');
          const hasWt = flags.worktree !== undefined;
          const hasDisp = flags.disposition !== undefined;
          const hasChoice = flags.choice !== undefined;
          if (!hasWt && !hasDisp && !hasChoice) {
            die('worktree record: provide at least one of --worktree, --disposition, or --choice', 1);
          }
          if (hasDisp && hasChoice) {
            die('worktree record: --disposition and --choice are mutually exclusive (both set the disposition)', 1);
          }
          let st = loadForWrite(p);
          if (hasWt) st = setWorktree(st, flags.worktree);
          if (hasDisp) {
            const norm = normalizeDisposition(flags.disposition);
            if (norm === null) {
              die(
                `worktree record: invalid --disposition '${flags.disposition}' — expected one of: ${VALID_WORKTREE_DISPOSITION.join(', ')} (legacy 'missing' is accepted and normalized)`,
                1
              );
            }
            st = setWorktreeDisposition(st, norm);
          }
          if (hasChoice) {
            const disp = dispositionAfterTeardown(flags.choice, !!flags['removal-confirmed']);
            if (disp === null) {
              die(
                `worktree record: unknown --choice '${flags.choice}' — expected one of: ${BRANCH_CHOICES.join(', ')}`,
                1
              );
            }
            st = setWorktreeDisposition(st, disp);
          }
          writeState(p, st);
          out({ worktree: st.worktree ?? null, worktree_disposition: st.worktree_disposition ?? null });
          break;
        }
        case 'reconcile': {
          // The global orphan sweep (READ-ONLY: emits {actions, findings}). bin fs-collects the disk
          // dirs + bundle records; the shell passes git's `worktree list --porcelain` and the absolute
          // common git dir in (git stays in the shell). The shell then runs git repair/remove/prune for
          // each action and `worktree record` for normalize. Re-runnable (no side effects).
          const repoRoot = need(flags, 'repo-root');
          const repoGitDir = typeof flags['repo-git-dir'] === 'string' && flags['repo-git-dir'].trim()
            ? flags['repo-git-dir'].trim()
            : path.join(repoRoot, '.git');
          // Canonicalize the admin dir so classifyWorktrees can match an OUR-repo worktree reached
          // through a symlink / NFS alias (realpath is an fs read — bin's boundary, not git). MUST stay
          // NULL when it can't resolve — NOT a lexical fallback — so a canonical mismatch we couldn't fully
          // prove can never trigger a foreign `remove` (the Codex Round-2 BLOCKER); classifyWorktrees
          // downgrades such a stray to `manual`.
          let repoGitDirCanonical = null;
          try {
            repoGitDirCanonical = fs.realpathSync.native(repoGitDir);
          } catch {
            /* unresolvable — leave NULL so remove can never fire on a canonical mismatch */
          }
          const gitList = parseWorktreeList(typeof flags['worktree-list'] === 'string' ? flags['worktree-list'] : '');
          out(
            classifyWorktrees({
              repoGitDir,
              repoGitDirCanonical,
              gitList,
              diskDirs: collectDiskDirs(repoRoot),
              bundleRecords: collectBundleRecords(repoRoot),
            })
          );
          break;
        }
        default:
          die(`unknown worktree subcommand '${sub ?? ''}' — expected: plan | record | reconcile`, 1);
      }
      break;
    }
    case 'set-review-config':
    case 'set-codex-config': { // hidden back-compat alias for the pre-rename command name
      const p = need(flags, 'state');
      // --review arms/disarms the finish-time adversary review → state.review.adversary (the key the
      // finish-step gate reads). --routing is the LEGACY per-task dispatch default (state.codex.routing,
      // still read by prepare-wave for in-flight bundles); new bundles never write it.
      const hasRouting = flags.routing !== undefined;
      const hasReview = flags.review !== undefined;
      if (!hasRouting && !hasReview) {
        die('set-review-config: provide at least one of --routing or --review', 1);
      }
      if (hasRouting && !VALID_CODEX_ROUTING.includes(flags.routing)) {
        die(`invalid --routing '${flags.routing}' — expected one of: ${VALID_CODEX_ROUTING.join(', ')}`);
      }
      let state = loadForWrite(p);
      const result = {};
      if (hasRouting) {
        state = setCodexConfig(state, { routing: flags.routing });
        result.routing = flags.routing;
      }
      if (hasReview) {
        // --review=true|on enables; --review=false|off disables; bare --review (=== true) enables.
        // Normalize to the BOOLEAN the dispatch path compares against (adversary === true).
        if (!['true', 'on', 'false', 'off'].includes(String(flags.review))) {
          die(`invalid --review '${flags.review}' — expected one of: true, false, on, off`);
        }
        const armed = flags.review === true || flags.review === 'true' || flags.review === 'on';
        state = setReviewConfig(state, { adversary: armed });
        result.adversary = armed;
      }
      writeState(p, state);
      out({ review: result });
      break;
    }
    case 'finish-status': {
      // The §2 finish-flow snapshot (READ-ONLY): the `complete` handler sequences on this. bin stays
      // fs/compute-only — the SHELL runs git and passes its output as flags (the verify-scope pattern):
      //   --head=<git rev-parse HEAD>           current commit, for the verified-at-SHA skip
      //   --porcelain=<git status --porcelain>  raw, for task-scope-vs-unrelated dirt classification
      //   --branches=<git branch ...>           raw (one name/line), for base detection (main|master)
      // All git flags are OPTIONAL: a fs-only call (no git facts) still reports retro/verified/commands.
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const dir = path.dirname(p);
      const head = typeof flags.head === 'string' && flags.head.trim() ? flags.head.trim() : null;
      const taskFiles = (Array.isArray(state.tasks) ? state.tasks : []).flatMap((t) =>
        Array.isArray(t.files) ? t.files : []
      );
      const dirt = classifyDirt(typeof flags.porcelain === 'string' ? flags.porcelain : '', taskFiles);
      const base = detectBase(typeof flags.branches === 'string' ? flags.branches : '');
      const retroPresent = fs.existsSync(path.join(dir, 'retro.md'));
      const verifiedSha = state.verified_sha ?? null;
      // The branch_finish RE-ENTRY shortcut: a retirement disposition means the gate already resolved
      // AND executed in a prior turn (a compaction landed between resolve and the archive-LAST step), so
      // the §2c handler jumps straight to archive instead of re-opening the gate (the double-prompt gap).
      const worktreeDisposition = state.worktree_disposition ?? null;
      // verify_commands lives in plan.index.json (the exec projection bundle.mjs drops from state.tasks).
      // Prefer the bundle's recorded plan_index_path, else the conventional sibling. SOFT read: an
      // absent/invalid index → [] (the shell falls back to verification-before-completion's IDENTIFY
      // step), never a hard die — finish-status must stay queryable on a partially-built bundle.
      const planIndexPath =
        typeof state.plan_index_path === 'string' && state.plan_index_path
          ? state.plan_index_path
          : path.join(dir, 'plan.index.json');
      let verifyCommands = [];
      try {
        verifyCommands = collectVerifyCommands(JSON.parse(fs.readFileSync(planIndexPath, 'utf8')));
      } catch {
        /* no/invalid plan.index.json — fall back to the skill's IDENTIFY step */
      }
      // adversary_review: whether the §2c whole-branch finish-gate review is ARMED. Reads the new
      // state.review.adversary key, falling back to the legacy state.codex.review for in-flight
      // bundles, with the EXACT dispatch/prepare-wave predicate (raw === true|'on'|'true') so the gate
      // and the wave workflow agree on what "review is on" means from one config field.
      const rawReview = state.review?.adversary ?? state.codex?.review;
      const adversaryReview = rawReview === true || rawReview === 'on' || rawReview === 'true';
      out({
        task_scope_dirty: dirt.taskScopeDirty,
        unrelated_dirty: dirt.unrelatedDirty,
        task_scope_paths: dirt.taskScopePaths,
        unrelated_paths: dirt.unrelatedPaths,
        base,
        retro_present: retroPresent,
        head_sha: head,
        verified_sha: verifiedSha,
        verified: isVerified(verifiedSha, head),
        verify_commands: verifyCommands,
        worktree_disposition: worktreeDisposition,
        adversary_review: adversaryReview,
        dispositions: Object.fromEntries(BRANCH_CHOICES.map((c) => [c, dispositionForChoice(c)])),
      });
      break;
    }
    case 'pr-summary': {
      // Open-PR awareness for the report verbs (status / next / clean) + the branch_finish gate label.
      // bin stays fs/compute-only: the SHELL runs `gh pr list --head <branch> --state open --json
      // number,title,mergeable,url` (best-effort, `2>/dev/null`) and passes the JSON in via --gh-json.
      // An absent/unauthed gh, no remote, or a non-GitHub origin → '' → { hasPr:false }. Pure transform,
      // REPORT-ONLY (never triggers a merge), no state write.
      out(summarizePr(typeof flags['gh-json'] === 'string' ? flags['gh-json'] : ''));
      break;
    }
    case 'adversary-review-status':
    case 'codex-review-status': { // hidden back-compat alias for the pre-rename command name
      // READ-ONLY: does a durable whole-branch review record exist at a given HEAD? The §2c
      // finish-gate's step-7 guard calls this on (re-)entry — a present record for the current HEAD
      // means the review already ran at this exact tree, so skip the network-bound re-run AND rehydrate
      // the findings digest into the re-rendered gate AUQ. The `adversary_review` event is written BEFORE
      // `open-gate`, so a death in between still skips on resume (closes the P2 durability window). bin
      // owns the fs read; lib/review-companion.mjs scans the text purely (matching both the new and
      // legacy event families). Absent events.jsonl == no review yet → { present:false }.
      const p = need(flags, 'state');
      const sha = String(need(flags, 'sha'));
      const eventsPath = path.join(path.dirname(p), 'events.jsonl');
      let text = '';
      try {
        text = fs.readFileSync(eventsPath, 'utf8');
      } catch (e) {
        // ENOENT == no events yet → the pure helper returns { present:false } for ''. Any OTHER
        // error (EACCES, EISDIR, I/O) must fail loud, not silently masquerade as "no review yet" —
        // a swallowed read error would falsely re-run the network gate (or worse, look "skipped").
        if (e.code !== 'ENOENT') die(`adversary-review-status: events.jsonl unreadable: ${e.message}`, 1);
      }
      out(selectCodexReviewForHead(text, sha));
      break;
    }
    case 'record-verification': {
      // Persist the verified-at-SHA marker after the finish-flow verification suite passes (the shell
      // passes the HEAD it just verified + cited). A re-entry of the complete handler at unchanged HEAD
      // then skips re-running it (isVerified). CD-7 write via the bundle.mjs setter; bin enum-free
      // (a sha is free-form — serializeState round-trips any key/value).
      const p = need(flags, 'state');
      const sha = String(need(flags, 'sha'));
      writeState(p, setVerifiedSha(loadForWrite(p), sha));
      out({ verified_sha: sha });
      break;
    }
    case 'record-gate-review': {
      // CD-7 write (events.jsonl): record the cross-vendor adversarial review of a spec/plan gate's
      // CURRENT artifacts so the guard (enforceGateReview) lets the transition proceed. Artifacts + hash
      // come from the SAME resolver the guard uses — bin owns them; the shell never passes a hash, so a
      // record and its guard can never disagree about what was reviewed. --status=done REQUIRES a
      // structured --receipt that echoes THIS hash + artifact set and carries real lane provenance
      // (validateGateReceipt); --status=skipped (degraded lane, fail-soft) REQUIRES a non-empty --reason
      // AND a readable, non-empty --digest-file — evidence the operator looked, not a bare bypass.
      const p = need(flags, 'state');
      const gate = String(need(flags, 'gate'));
      if (gate !== 'spec' && gate !== 'plan') {
        die(`record-gate-review: --gate must be 'spec' or 'plan' (got ${JSON.stringify(gate)})`, 1);
      }
      const status = flags.status === undefined ? 'done' : String(flags.status);
      if (status !== 'done' && status !== 'skipped') {
        die(`record-gate-review: --status must be 'done' or 'skipped' (got ${JSON.stringify(status)})`, 1);
      }
      const state = loadForWrite(p);
      const descriptors = resolveGateArtifacts({ gate, statePath: p, state, flags, op: 'record' });
      const hash = computeGateHash(descriptors);
      const artifacts = descriptors.map((d) => d.relName);
      const { done, skipped } = gateEventTypes(gate);
      const data = { hash };
      // --count: findings tally — when given it must be a non-negative integer.
      if (flags.count !== undefined) {
        const n = Number(flags.count);
        if (!Number.isInteger(n) || n < 0) {
          die(`record-gate-review: --count must be a non-negative integer (got ${JSON.stringify(flags.count)})`, 1);
        }
        data.count = n;
      }
      let note;
      if (status === 'done') {
        // Structured receipt binding. --receipt is inline JSON (value starts with '{') or a path to a
        // JSON file (shell-safe, like --digest-file). It must validate against the hash + artifacts above.
        const receiptRaw = String(need(flags, 'receipt'));
        let receiptText;
        if (receiptRaw.trimStart().startsWith('{')) {
          receiptText = receiptRaw;
        } else {
          try {
            receiptText = fs.readFileSync(receiptRaw, 'utf8');
          } catch (e) {
            die(`record-gate-review: --receipt file unreadable: ${e.message}`, 1);
          }
        }
        let receipt;
        try {
          receipt = JSON.parse(receiptText);
        } catch (e) {
          die(`record-gate-review: --receipt is not valid JSON (${e.message})`, 1);
        }
        const v = validateGateReceipt(receipt, { gate, hash, artifacts });
        if (!v.ok) die(`record-gate-review: receipt rejected — ${v.error}`, 1);
        data.receipt = {
          dispatch_id: v.normalized.dispatch_id,
          provider: v.normalized.provider,
          model: v.normalized.model,
          output_tokens: v.normalized.output_tokens,
          ts: v.normalized.ts,
        };
        if (v.normalized.base) data.base = v.normalized.base;
        else if (flags.base !== undefined) data.base = String(flags.base);
        note = v.normalized.digest; // selectGateReview surfaces note as the findings digest
      } else {
        // skipped — degraded lane. Evidence required: non-empty reason AND a readable, non-empty digest.
        const reason = String(need(flags, 'reason'));
        if (!reason.trim()) die('record-gate-review: --reason must be non-empty for --status=skipped', 1);
        const digestPath = String(need(flags, 'digest-file'));
        let digestText;
        try {
          digestText = fs.readFileSync(digestPath, 'utf8');
        } catch (e) {
          die(`record-gate-review: --digest-file unreadable: ${e.message}`, 1);
        }
        if (!digestText.trim()) {
          die(`record-gate-review: --digest-file is empty (${digestPath}) — record the degraded-lane evidence`, 1);
        }
        data.reason = reason;
        if (flags.base !== undefined) data.base = String(flags.base);
        note = digestText;
      }
      // --summary is the audit-scanned signal channel (the session audit counts \b(codex|adversary)\s+
      // review\b) — default to that literal phrasing for parity with the finish-gate summary.
      const record = {
        type: status === 'done' ? done : skipped,
        ts: flags.ts ?? new Date().toISOString(),
        data,
        note,
        summary:
          flags.summary !== undefined
            ? String(flags.summary)
            : status === 'done'
              ? `${gate} adversary review complete${data.count !== undefined ? ` — ${data.count} findings` : ''}`
              : `${gate} adversary review skipped (degraded) — ${data.reason}`,
      };
      let eventsPath;
      try {
        eventsPath = appendEvent(p, record);
      } catch (e) {
        die(e.message, 1);
      }
      out({ recorded: record.type, gate, status, hash, path: eventsPath });
      break;
    }
    case 'gate-review-status': {
      // READ-ONLY: is a spec/plan gate review recorded for the CURRENT artifacts? The shell calls this
      // to decide whether it must run the review before a transition; enforceGateReview enforces it
      // independently at the transition itself. Absent events.jsonl == no review yet → { present:false }.
      const p = need(flags, 'state');
      const gate = String(need(flags, 'gate'));
      if (gate !== 'spec' && gate !== 'plan') {
        die(`gate-review-status: --gate must be 'spec' or 'plan' (got ${JSON.stringify(gate)})`, 1);
      }
      const state = loadForWrite(p);
      const descriptors = resolveGateArtifacts({ gate, statePath: p, state, flags, op: 'gate-hash' });
      const hash = computeGateHash(descriptors);
      const eventsPath = path.join(path.dirname(p), 'events.jsonl');
      let text = '';
      try {
        text = fs.readFileSync(eventsPath, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') die(`gate-review-status: events.jsonl unreadable: ${e.message}`, 1);
      }
      out({ gate, hash, artifacts: descriptors.map((d) => d.relName), ...selectGateReview(text, gate, hash) });
      break;
    }
    case 'gate-hash': {
      // READ-ONLY: compute the gate hash + the relative artifact names for the CURRENT artifacts. The
      // caller (the masterplan shell, or a test) runs this to learn the exact { hash, artifacts } to echo
      // back into a --receipt for record-gate-review. Same resolver as enforce/record, so the values
      // match what the guard will demand.
      const p = need(flags, 'state');
      const gate = String(need(flags, 'gate'));
      if (gate !== 'spec' && gate !== 'plan') {
        die(`gate-hash: --gate must be 'spec' or 'plan' (got ${JSON.stringify(gate)})`, 1);
      }
      const state = loadForWrite(p);
      const descriptors = resolveGateArtifacts({ gate, statePath: p, state, flags, op: 'gate-hash' });
      const hash = computeGateHash(descriptors);
      out({ gate, hash, artifacts: descriptors.map((d) => d.relName) });
      break;
    }

    // ---- GitHub coordination subcommands (§7.3) ----
    // These subcommands wrap lib/github-coord.mjs logic and coordination state writes. ALL are fs-only:
    // no git, no gh. The shell supplies gh JSON on stdin (exactly like pr-summary). State reads/writes
    // go through loadForWrite/writeState; set-coord and update-issue-map are the CD-7 writers for
    // coordination state (via setCoordination → writeState). Read-only subcommands never write state.

    case 'set-coord': {
      // CD-7 write: per-key merge of coordination fields onto state.coordination.
      // --base-sha and --mark-published both require --wave (they address a per-wave slot).
      // Scalar fields (contract-ref, integration-branch, local-run-branch, mode) are applied
      // without --wave. base_sha_by_wave and published_waves are merged against existing values
      // (not overwritten wholesale) so idempotent re-runs are safe.
      const p = need(flags, 'state');
      const state = loadForWrite(p);

      // Guard: --base-sha / --mark-published require --wave
      const hasBaseSha = flags['base-sha'] !== undefined;
      const hasMarkPublished = flags['mark-published'] !== undefined && flags['mark-published'] !== false;
      const hasWave = flags.wave !== undefined;
      if ((hasBaseSha || hasMarkPublished) && !hasWave) {
        die('set-coord: --base-sha and --mark-published require --wave', 1);
      }

      const wave = hasWave ? coerceId(flags.wave) : undefined;
      const existing = state.coordination && typeof state.coordination === 'object' ? state.coordination : {};

      const patch = {};
      if (flags.mode !== undefined) patch.mode = flags.mode;
      if (flags['contract-ref'] !== undefined) patch.contract_ref = flags['contract-ref'];
      if (flags['integration-branch'] !== undefined) patch.integration_branch = flags['integration-branch'];
      if (flags['local-run-branch'] !== undefined) patch.local_run_branch = flags['local-run-branch'];

      // --bootstrap: derive {contract_ref, integration_branch} from state.slug + the bundle's
      // plan_hash (§7.1 publish default-enable). Idempotent + all-or-nothing:
      //   - no-op if BOTH refs are already set (explicit flags or a prior bootstrap),
      //   - refuse a partial provision when plan_hash is absent (computeCoordDefaults → contract_ref
      //     null): a contract ref needs a plan hash to be resumable, so we pin NEITHER ref and let the
      //     publish preflight's `coord-status --fail-if-unconfigured` fail loud instead.
      // Explicit --contract-ref / --integration-branch still win (they're applied above; bootstrap
      // only fills a key the caller didn't set and the state doesn't already carry).
      if (flags.bootstrap !== undefined && flags.bootstrap !== false) {
        const bothSet = existing.contract_ref && existing.integration_branch;
        if (!bothSet) {
          // Soft-read plan_hash from the bundle's plan.index.json (sibling of state.yml, or the
          // recorded plan_index_path). Absent/invalid index → planHash null → no contract_ref.
          const planIndexPath =
            typeof state.plan_index_path === 'string' && state.plan_index_path
              ? state.plan_index_path
              : path.join(path.dirname(p), 'plan.index.json');
          let planHash = null;
          try {
            planHash = JSON.parse(fs.readFileSync(planIndexPath, 'utf8'))?.plan_hash ?? null;
          } catch {
            planHash = null; // index absent/unreadable — not bootstrappable yet
          }
          const defaults = computeCoordDefaults(state.slug, planHash);
          // All-or-nothing: only provision when BOTH derived refs are non-null (plan_hash present).
          if (defaults.contract_ref && defaults.integration_branch) {
            if (patch.contract_ref === undefined && !existing.contract_ref) {
              patch.contract_ref = defaults.contract_ref;
            }
            if (patch.integration_branch === undefined && !existing.integration_branch) {
              patch.integration_branch = defaults.integration_branch;
            }
          }
        }
      }

      // base_sha_by_wave: merge the per-wave entry rather than overwriting the whole object
      if (hasBaseSha) {
        patch.base_sha_by_wave = { ...(existing.base_sha_by_wave ?? {}), [wave]: flags['base-sha'] };
      }

      // published_waves: dedup-union of existing + wave
      if (hasMarkPublished) {
        const prev = Array.isArray(existing.published_waves) ? existing.published_waves : [];
        patch.published_waves = [...new Set([...prev, wave])];
      }

      // No effective change — e.g. `--bootstrap` on a not-bootstrappable bundle (no plan_hash), or no
      // mutating flags at all. Do NOT materialize an empty coordination object: decideNextAction treats
      // ANY non-null coordination as a coordinated run (resume.mjs §4 — empty issue_map ⇒ all wave tasks
      // "unpublished"), so writing {} onto an uncoordinated bundle would hijack later resumes into
      // publish_needed/coordinate while `coord-status --fail-if-unconfigured` still fails — stranding
      // normal local dispatch behind the publish flow. Emit the current coordination, write nothing.
      if (Object.keys(patch).length === 0) {
        out({ coordination: state.coordination ?? null });
        break;
      }

      const next = setCoordination(state, patch);
      writeState(p, next);
      out({ coordination: next.coordination ?? null });
      break;
    }
    case 'update-issue-map': {
      // CD-7 write: create or shallow-merge an issue_map entry for task_id.
      // Requires at least one mutating field beyond --task-id; no mutation → die.
      // Numeric ids (--issue / --pr) are coerced; other fields are stored as provided.
      const p = need(flags, 'state');
      const taskId = String(coerceId(need(flags, 'task-id')));
      const state = loadForWrite(p);

      // Collect provided mutating fields
      const hasIssue = flags.issue !== undefined;
      const hasPr = flags.pr !== undefined;
      const hasMergeSha = flags['merge-sha'] !== undefined;
      const hasStatus = flags.status !== undefined;
      const hasWave = flags.wave !== undefined;

      if (!hasIssue && !hasPr && !hasMergeSha && !hasStatus && !hasWave) {
        die('update-issue-map: provide at least one of --issue, --pr, --merge-sha, --status, --wave', 1);
      }
      // Typo-guard: a misspelled --status would otherwise silently write an off-vocabulary value
      // that no consumer (coord-status terminal check, coord-drift doctor) recognizes.
      if (hasStatus && !isValidIssueStatus(flags.status)) {
        die(`update-issue-map: invalid --status '${flags.status}' (expected one of: ${ISSUE_MAP_STATUSES.join(', ')})`, 1);
      }

      const existing = state.coordination && typeof state.coordination === 'object' ? state.coordination : {};
      const issueMap = existing.issue_map && typeof existing.issue_map === 'object' ? existing.issue_map : {};
      const prev = issueMap[taskId] && typeof issueMap[taskId] === 'object' ? issueMap[taskId] : {};

      // Build the updated entry — shallow merge, only assign provided fields
      const entry = { ...prev };
      if (hasIssue) entry.issue = coerceId(flags.issue);
      if (hasPr) entry.pr = coerceId(flags.pr);
      if (hasMergeSha) entry.merge_sha = flags['merge-sha'];
      if (hasStatus) entry.status = flags.status;
      if (hasWave) entry.wave = coerceId(flags.wave);

      const nextIssueMap = { ...issueMap, [taskId]: entry };
      const next = setCoordination(state, { issue_map: nextIssueMap });
      writeState(p, next);
      out({ task_id: taskId, entry });
      break;
    }
    case 'gh-issue-body': {
      // Build a GitHub issue body for a single plan task (A1/A2).
      // Input: task JSON via --task=JSON, opts as flags.
      // Output: the raw markdown string (stdout), not a JSON wrapper — the body is multiline markdown.
      // bin stays fs-only: no git calls, no gh calls.
      let task;
      try {
        task = JSON.parse(need(flags, 'task'));
      } catch (e) {
        die(`gh-issue-body: --task must be valid JSON (${e.message})`, 1);
      }
      const opts = {};
      if (flags['run-slug'] !== undefined) opts.runSlug = flags['run-slug'];
      if (flags['contract-ref'] !== undefined) opts.contractRef = flags['contract-ref'];
      if (flags['integration-branch'] !== undefined) opts.integrationBranch = flags['integration-branch'];
      if (flags['base-sha'] !== undefined) opts.baseSha = flags['base-sha'];
      if (flags['plan-hash'] !== undefined) opts.planHash = flags['plan-hash'];
      if (flags.wave !== undefined) opts.wave = coerceId(flags.wave);
      let body;
      try {
        body = issueBodyForTask(task, opts);
      } catch (e) {
        die(`gh-issue-body: ${e.message}`, 1);
      }
      process.stdout.write(body + '\n');
      break;
    }
    case 'parse-issue': {
      // Parse the metadata block from a GitHub issue body (A2).
      // Input: issue body on stdin (multiline markdown — not suitable as a flag value).
      // Output: the parsed metadata JSON object.
      // bin stays fs-only: no git calls, no gh calls.
      // Use fd 0 (not /dev/stdin) so the read works both with shell pipes and execFileSync's { input }.
      let body;
      try {
        body = fs.readFileSync(0, 'utf8');
      } catch (e) {
        die(`parse-issue: failed to read stdin (${e.message})`, 1);
      }
      let meta;
      try {
        meta = parseIssueBody(body);
      } catch (e) {
        die(`parse-issue: ${e.message}`, 1);
      }
      out(meta);
      break;
    }
    case 'validate-claim': {
      // Settle a claim attempt: won | lost (A3).
      // Input: issue JSON via --issue=JSON (the re-read issue after the claim attempt),
      //        --actor=STRING (the claimant's GitHub login),
      //        --prs=JSON (array of open PRs already filed for this task — defaults to []).
      // Output: { result: 'won' | 'lost' }
      let issue;
      try {
        issue = JSON.parse(need(flags, 'issue'));
      } catch (e) {
        die(`validate-claim: --issue must be valid JSON (${e.message})`, 1);
      }
      const actor = need(flags, 'actor');
      let prs = [];
      if (flags.prs !== undefined) {
        try {
          prs = JSON.parse(flags.prs);
        } catch (e) {
          die(`validate-claim: --prs must be valid JSON (${e.message})`, 1);
        }
      }
      const result = validateClaimSettle(issue, actor, prs);
      out({ result });
      break;
    }
    case 'select-claimable': {
      // Return the subset of issues that are currently claimable (A4).
      // Input: --issues=JSON (array of issue objects with body + labels),
      //        --merged=JSON (array of already-merged task IDs — defaults to []),
      //        --plan-deps=JSON (optional: object mapping task_id->dep_ids[], for override).
      // Output: { claimable: [issue, ...] }
      let issues;
      try {
        issues = JSON.parse(need(flags, 'issues'));
      } catch (e) {
        die(`select-claimable: --issues must be valid JSON (${e.message})`, 1);
      }
      let mergedTaskIds = [];
      if (flags.merged !== undefined) {
        try {
          mergedTaskIds = JSON.parse(flags.merged);
        } catch (e) {
          die(`select-claimable: --merged must be valid JSON (${e.message})`, 1);
        }
      }
      let planIndexDeps = null;
      if (flags['plan-deps'] !== undefined) {
        try {
          const depsObj = JSON.parse(flags['plan-deps']);
          planIndexDeps = new Map(Object.entries(depsObj));
        } catch (e) {
          die(`select-claimable: --plan-deps must be valid JSON object (${e.message})`, 1);
        }
      }
      const claimable = selectClaimableUnits(issues, mergedTaskIds, planIndexDeps);
      out({ claimable });
      break;
    }
    case 'reconcile-integration': {
      // Compare lead's local state vs GitHub issue state and return ordered write-back actions (A6).
      // Input: --state=PATH (the bundle's state.yml), gh issues JSON on stdin.
      // Output: { actions: [...] }
      // Read-only: never writes state (mark_done actions are applied by the shell via mark-task).
      // bin stays fs-only: the shell runs gh and pipes the JSON here.
      // Use fd 0 (not /dev/stdin) so the read works both with shell pipes and execFileSync's { input }.
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      let ghJson;
      try {
        ghJson = fs.readFileSync(0, 'utf8');
      } catch (e) {
        die(`reconcile-integration: failed to read stdin (${e.message})`, 1);
      }
      let ghIssues;
      try {
        ghIssues = JSON.parse(ghJson);
      } catch (e) {
        die(`reconcile-integration: stdin must be a JSON array of gh issues (${e.message})`, 1);
      }
      const actions = reconcileIntegration(state, ghIssues);
      out({ actions });
      break;
    }
    case 'coord-status': {
      // Report the coordination object from the bundle (READ-ONLY snapshot).
      // Output: the state.coordination object (or null if the run is not GitHub-coordinated).
      // --fail-if-unconfigured: exit non-zero if coordination is absent OR missing contract_ref/integration_branch.
      // --fail-if-unpublishable: exit non-zero if phase!=='execute' OR tasks empty OR the most-recently-published
      //   wave still has a non-terminal (neither 'merged' nor 'closed') issue_map entry.
      // Both flags absent → emit {coordination} exit 0 unchanged.
      const p = need(flags, 'state');
      const state = loadForWrite(p);
      const coord = state.coordination && typeof state.coordination === 'object' ? state.coordination : null;

      if (flags['fail-if-unconfigured']) {
        if (!coord || !coord.contract_ref || !coord.integration_branch) {
          process.stderr.write('masterplan: coord-status: coordination not configured (missing contract_ref or integration_branch)\n');
          process.exit(1);
        }
      }

      if (flags['fail-if-unpublishable']) {
        // Guard 1: must be in execute phase with tasks
        if (state.phase !== 'execute') {
          process.stderr.write(`masterplan: coord-status: not publishable — phase is '${state.phase}' (expected 'execute')\n`);
          process.exit(1);
        }
        const tasks = Array.isArray(state.tasks) ? state.tasks : [];
        if (tasks.length === 0) {
          process.stderr.write('masterplan: coord-status: not publishable — no tasks\n');
          process.exit(1);
        }
        // Guard 2: if any waves have been published, the most-recently-published wave must have all
        // issue_map entries in a terminal state ('merged' or 'closed') before we can re-publish (advance).
        // The G9 reconcile write-back sets entries to 'merged', so 'merged' MUST count as terminal —
        // otherwise a fully-followed prior wave would wrongly block the next publish (the publish↔follow
        // hand-off this path exists to repair).
        const publishedWaves = Array.isArray(coord?.published_waves) ? coord.published_waves : [];
        if (publishedWaves.length > 0) {
          const mostRecentWave = Math.max(...publishedWaves);
          const issueMap = coord?.issue_map && typeof coord.issue_map === 'object' ? coord.issue_map : {};
          // Find issue_map entries belonging to the most recent published wave
          const waveEntries = Object.values(issueMap).filter(
            (entry) => entry && typeof entry === 'object' && coerceId(entry.wave) === mostRecentWave
          );
          // Terminal set is the single source of truth in lib/github-coord.mjs (isTerminalIssueStatus).
          const nonTerminal = waveEntries.filter((entry) => !isTerminalIssueStatus(entry.status));
          if (nonTerminal.length > 0) {
            process.stderr.write(
              `masterplan: coord-status: not publishable — wave ${mostRecentWave} has ${nonTerminal.length} non-terminal issue_map entry(ies)\n`
            );
            process.exit(1);
          }
        }
      }

      out({ coordination: coord });
      break;
    }

    // ---- qctl async-loop subcommands (§6 — drive the async qctl backend) ----
    // ALL are fs-only: no git, no qctl subprocess. The shell owns UUIDs, git, and subprocess calls;
    // these subcommands compute + persist only. The CD-7 single-writer invariant applies: state writes
    // go via loadForWrite/writeState, never via raw file manipulation.

    case 'record-qctl-job': {
      // CD-7 write: persist {job_id, key} into state.qctl_jobs[task_id].
      // This is the durable job_id path — the shell calls it immediately after `qctl enqueue` returns
      // the new job_id (and after computing the key via the `enqueue-key` subcommand). Idempotent:
      // re-running with the same (task_id, job_id, key) overwrites with identical data.
      const p = need(flags, 'state');
      const taskId = String(coerceId(need(flags, 'task-id')));
      const jobId = String(need(flags, 'job-id'));
      const key = String(need(flags, 'key'));

      const state = loadForWrite(p);
      const existing = state.qctl_jobs && typeof state.qctl_jobs === 'object' ? state.qctl_jobs : {};
      const entry = { job_id: jobId, key };
      const next = { ...state, qctl_jobs: { ...existing, [taskId]: entry } };
      writeState(p, next);
      out({ task_id: taskId, job_id: jobId, key });
      break;
    }
    case 'enqueue-key': {
      // Compute the enqueue key and decide reuse vs upsert for the qctl async-loop (§6.1).
      // Reads the stored qctl_jobs[task_id] from the bundle and runs decideEnqueue.
      // action:'reuse' → job is already in flight, shell waits on it.
      // action:'upsert' → shell must call `qctl enqueue`, then `mp record-qctl-job`.
      // --scope is optional; pass as a JSON array of file paths.
      const p = need(flags, 'state');
      const runSlug = need(flags, 'run-slug');
      const wave = coerceId(need(flags, 'wave'));
      const taskId = coerceId(need(flags, 'task-id'));
      const base = need(flags, 'base');
      let scope = [];
      if (flags.scope !== undefined) {
        try {
          scope = JSON.parse(flags.scope);
        } catch (e) {
          die(`enqueue-key: --scope must be a JSON array (${e.message})`, 1);
        }
        if (!Array.isArray(scope)) die('enqueue-key: --scope must be a JSON array', 1);
      }

      const state = loadForWrite(p);
      const jobs = state.qctl_jobs && typeof state.qctl_jobs === 'object' ? state.qctl_jobs : {};
      const existingJob = jobs[String(taskId)] ?? null;
      const key = computeEnqueueKey({ run_slug: runSlug, wave, task_id: taskId, base, scope });
      const { action, job } = decideEnqueue(existingJob, key);
      out({ action, key, job });
      break;
    }
    case 'artifact-verify': {
      // Two modes:
      //   --declared-sha256=S --bytes-file=PATH  → verifyArtifact (integrity check; shell passes file path)
      //   --result=JSON                          → parseQctlDigest (extract IMPL_DIGEST projection)
      // bin is fs-only: bytes are read from a file the shell passes in (not from qctl directly).
      if (flags['result'] !== undefined) {
        // parseQctlDigest mode
        const digest = parseQctlDigest(flags['result']);
        out(digest);
      } else {
        // verifyArtifact mode
        const declaredSha256 = need(flags, 'declared-sha256');
        const bytesFile = need(flags, 'bytes-file');
        let bytes;
        try {
          bytes = fs.readFileSync(bytesFile);
        } catch (e) {
          die(`artifact-verify: cannot read --bytes-file ${bytesFile} (${e.message})`, 1);
        }
        out(verifyArtifact({ declaredSha256, bytes }));
      }
      break;
    }
    case 'status-map': {
      // Map a qctl producer status to the masterplan task_status (§6.2 lossless mapping).
      // --producer-status is required; --apply-ok and --d6-ok are booleans (tri-state: absent=not tested).
      const producerStatus = need(flags, 'producer-status');
      const applyResult = flags['apply-ok'] !== undefined ? { ok: flags['apply-ok'] === 'true' || flags['apply-ok'] === true } : undefined;
      const d6Result = flags['d6-ok'] !== undefined ? { ok: flags['d6-ok'] === 'true' || flags['d6-ok'] === true } : undefined;
      out(mapQctlStatus({ producerStatus, applyResult, d6Result }));
      break;
    }
    case 'base-drift': {
      // Decide whether a qctl patch's recorded base still matches the current HEAD (§6.3 requeue).
      // action:'apply' → safe to git-apply; action:'requeue' → shell must re-enqueue against currentHead.
      // git facts are passed in by the shell (bin is fs-only — git stays in the markdown shell).
      // --scope is optional and carried through for consumer context; does not affect the decision.
      const recordedBase = need(flags, 'recorded-base');
      const currentHead = need(flags, 'current-head');
      let declaredScope$1 = undefined;
      if (flags.scope !== undefined) {
        try {
          declaredScope$1 = JSON.parse(flags.scope);
        } catch (e) {
          die(`base-drift: --scope must be a JSON array (${e.message})`, 1);
        }
      }
      out(decideBaseDrift({ recordedBase, currentHead, declaredScope: declaredScope$1 }));
      break;
    }

    case 'record-result': {
      // T2.2: the §2a wave-completion transaction in code — owner heartbeat → mark digests →
      // verify-scope → out-of-scope revert → split commit (code in WT, state in MAIN) → decide.
      // The ONE deliberate v9 relaxation of "bin is fs-only": record-result runs LOCAL git,
      // -C-qualified to loci lib/wave-commit.mjs derives itself (MAIN from the bundle's
      // --git-common-dir, WT from state/--worktree). Network git (push/gh) stays shell-side.
      const statePath = need(flags, 'state');
      // The L2 workflow's WHOLE result object ({wave, baseline, tasks:[{task_id, digest,
      // review}]}) via --result-file (preferred — no shell-quoting hazards) or --result inline.
      // --reconcile runs the finalize_run crash-reconciliation with NO result: no marks, the
      // verify → revert → commit → clear tail only (a clean WT degrades to pure no-ops).
      let result = null;
      if (flags['result-file'] !== undefined || flags.result !== undefined) {
        try {
          const raw =
            flags['result-file'] !== undefined
              ? fs.readFileSync(String(flags['result-file']), 'utf8')
              : String(flags.result);
          result = JSON.parse(raw);
        } catch (e) {
          die(`record-result: could not parse workflow result (${e.message})`);
        }
        if (result === null || typeof result !== 'object') {
          die('record-result: workflow result must be a JSON object');
        }
      } else if (!flags.reconcile) {
        die('record-result: pass --result-file/--result, or --reconcile for the crash-reconcile path');
      }
      // Guard D identity is resolved ONLY when the bundle hasn't opted out (mirror of the
      // `continue` case below) — resolveOwnerSelf dies without a session id, and an
      // owner_lock=off bundle legitimately has none (Codex P2, 2026-06-10).
      let lockOff = false;
      try {
        lockOff = readState(statePath)?.concurrency?.owner_lock === 'off';
      } catch {
        /* unreadable — recordWaveResult fails loudly itself; assume lock on */
      }
      let self = null;
      let now = Number.isFinite(Number(flags.now)) ? Number(flags.now) : Date.now();
      if (!lockOff) {
        ({ self, now } = resolveOwnerSelf(flags, statePath));
      }
      let res;
      try {
        res = recordWaveResult({
          statePath,
          result,
          self,
          now,
          worktree: typeof flags.worktree === 'string' ? flags.worktree : undefined,
        });
      } catch (e) {
        die(e.message);
      }
      // lost-to-other exits 0 with JSON — a valid outcome the shell surfaces as an AUQ
      // (with `mp acquire-owner --force` as an option), not an mp error.
      out(res);
      break;
    }

    case 'continue': {
      // T2.3: the trampoline — migrate-on-load → Guard D acquire/confirm → wave backfill →
      // alive-probe gating → the bounded decide loop, returning ONE typed op per call
      // ({op: launch_workflow|dispatch_foreground|run_skill|record_result|ask|probe|shell|stop|…}).
      // The shell stops sequencing §2 by prose: it calls `mp continue`, executes the op, repeats.
      // Hosts without Claude Code Workflow handles (PI_CODING_AGENT or --no-workflow) are routed
      // to dispatch_foreground so a phase-1 launch marker is consumed instead of user-stranded.
      // Same git-in-bin seam as record-result: LOCAL git only, network ops stay shell-side.
      const statePath = need(flags, 'state');
      // Guard D identity is resolved ONLY when the bundle hasn't opted out — resolveOwnerSelf
      // dies without a session id, and an owner_lock=off bundle legitimately has none.
      let lockOff = false;
      try {
        lockOff = readState(statePath)?.concurrency?.owner_lock === 'off';
      } catch {
        /* unreadable/legacy — continueRun's migrate-on-load handles it; assume lock on */
      }
      let self = null;
      let now = Number.isFinite(Number(flags.now)) ? Number(flags.now) : Date.now();
      let ttlMs = Number.isFinite(Number(flags['ttl-ms'])) ? Number(flags['ttl-ms']) : undefined;
      if (!lockOff) {
        ({ self, now, ttlMs } = resolveOwnerSelf(flags, statePath));
      }
      // --alive/--dead: the shell's answer to a prior {op:'probe'}; absent = not yet probed.
      const alive = flags.alive ? true : flags.dead ? false : null;
      let reposAllowlist;
      if (flags['repos-allowlist'] !== undefined) {
        try {
          reposAllowlist = JSON.parse(flags['repos-allowlist']);
        } catch (e) {
          die(`continue: --repos-allowlist must be JSON (${e.message})`, 1);
        }
      }
      let op;
      try {
        op = continueRun({
          statePath,
          self,
          now,
          ttlMs,
          alive,
          staleReconciled: !!flags['stale-reconciled'],
          force: !!flags.force,
          codexSuppressed: shouldSuppressWorkflow(flags, process.env),
          routing: typeof flags.routing === 'string' ? flags.routing : undefined,
          review: flags.review,
          reposAllowlist,
        });
      } catch (e) {
        die(e.message);
      }
      out(op);
      break;
    }

    case 'finish-step': {
      // T2.4: the §2c finalization flow as a re-entrant state machine — re-entry shortcuts,
      // WT snapshot + dirty-commit, verified-at-SHA check, retro write-if-absent, the codex
      // durable guard + event, the branch_finish gate, the chosen disposition (local merge +
      // worktree teardown), archive-LAST + owner release. ONE typed op per call; the shell's
      // answers thread back as --verify/--codex/--docs/--choice. Same git-in-bin seam as record-result
      // and continue: LOCAL git only, network ops (push/gh/agent-dispatch review) stay shell-side.
      const statePath = need(flags, 'state');
      let lockOff = false;
      try {
        lockOff = readState(statePath)?.concurrency?.owner_lock === 'off';
      } catch {
        /* unreadable — finishStep fails loudly itself; assume lock on */
      }
      let self = null;
      let now = Number.isFinite(Number(flags.now)) ? Number(flags.now) : Date.now();
      let ttlMs = Number.isFinite(Number(flags['ttl-ms'])) ? Number(flags['ttl-ms']) : undefined;
      if (!lockOff) {
        ({ self, now, ttlMs } = resolveOwnerSelf(flags, statePath));
      }
      const verify = flags['verify-passed'] ? 'pass' : flags['verify-failed'] ? 'fail' : null;
      // --review-done/--review-skipped are the model-generic flags; --codex-done/--codex-skipped are
      // hidden back-compat aliases for in-flight orchestrator prose that still emits the old names.
      const reviewAns = (flags['review-done'] || flags['codex-done']) ? 'done'
                      : (flags['review-skipped'] || flags['codex-skipped']) ? 'skipped' : null;
      const docsAns = flags['docs-normalized'] ? 'normalized' : flags['docs-skipped'] ? 'skipped' : null;
      const reviewCountFlag = flags['review-count'] ?? flags['codex-count'];
      const reviewBaseFlag = flags['review-base'] ?? flags['codex-base'];
      const reviewDigestFlag = flags['review-digest-file'] ?? flags['codex-digest-file'];
      const reviewReasonFlag = flags['review-reason'] ?? flags['codex-reason'];
      let op;
      try {
        op = finishStep({
          statePath,
          self,
          now,
          ttlMs,
          force: !!flags.force,
          verify,
          review: reviewAns,
          reviewCount: reviewCountFlag,
          reviewBase: typeof reviewBaseFlag === 'string' ? reviewBaseFlag : null,
          reviewDigestFile: typeof reviewDigestFlag === 'string' ? reviewDigestFlag : null,
          reviewReason: typeof reviewReasonFlag === 'string' ? reviewReasonFlag : null,
          docsSuppressed: !!flags['docs-suppressed'],
          docs: docsAns,
          docsCount: flags['docs-count'],
          docsReason: typeof flags['docs-reason'] === 'string' ? flags['docs-reason'] : null,
          choice: typeof flags.choice === 'string' ? flags.choice : null,
          pushed: !!flags.pushed,
          removalForce: !!flags['removal-force'],
          retroOnly: !!flags['retro-only'],
        });
      } catch (e) {
        die(e.message);
      }
      out(op);
      break;
    }

    case 'sweep': {
      // T2.3: the §2e orphan sweep with the safety inversion the user ruled on — DRY-RUN
      // by default (reports {actions, findings} only); --apply executes repair/remove/prune/
      // normalize. `manual` actions are never executed in either mode.
      const repoRoot = need(flags, 'repo-root');
      let res;
      try {
        res = sweepWorktrees({ repoRoot, apply: !!flags.apply });
      } catch (e) {
        die(e.message);
      }
      out(res);
      break;
    }

    case 'acquire-owner':
    case 'heartbeat-owner':
    case 'release-owner': {
      // Guard D: NFS-safe cross-session owner sentinel (lib/owner.mjs decision + lib/owner-fs.mjs fs).
      // The bundle dir (where .owner.lock lives) is dirname(--state). All ops are filesystem
      // (link/stat/rename/unlink) — squarely inside bin's fs-only mandate; no git, no CD-7 conflict.
      const statePath = need(flags, 'state');
      const { bundleDir, self, now, ttlMs } = resolveOwnerSelf(flags, statePath);
      if (cmd === 'acquire-owner') {
        // The bundle dir must exist to hold the lock; a kickoff acquire may run just before/at seed.
        try {
          fs.mkdirSync(bundleDir, { recursive: true });
        } catch {
          /* exists or unwritable — acquire will surface a real error if it can't write */
        }
        out(acquireOwner(bundleDir, self, { now, force: !!flags.force, ttlMs }));
      } else if (cmd === 'heartbeat-owner') {
        out(heartbeatOwner(bundleDir, self, { now }));
      } else {
        // Thread now+ttlMs so releaseOwner's freshness gate engages: a path-unlink is safe only when our
        // lock is still within TTL (a successor can only steal a STALE lock).
        out(releaseOwner(bundleDir, self, { force: !!flags.force, now, ttlMs }));
      }
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
