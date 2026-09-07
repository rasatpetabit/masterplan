// lib/finish-step.mjs — the §2c finalization flow as a re-entrant state machine (T2.4).
//
// finishStep is the finish flow the orchestrator prose used to BE: the re-entry shortcuts,
// the WT snapshot, the dirty-commit, the verified-at-SHA check, retro write-if-absent, the
// adversary-review durable guard + event, the durable branch_finish gate, the chosen disposition
// (local merge / worktree teardown), and the archive-LAST transaction. Each call returns ONE
// typed op; the shell executes it and re-calls with the answer threaded back as flags.
//
// Op contract (• = emitted here; the judgment/network work each op names stays shell-side):
//   • { op:'run_verify', commands, head, wt }     — shell runs verification-before-completion,
//                                                   re-calls with --verify=pass|fail (no command
//                                                   found → the shell's no_verification_command
//                                                   gate via `mp open-gate`, prose-retained)
//   • { op:'write_retro', path }                  — shell writes retro.md, re-calls (re-checked
//                                                   from fs — write-if-absent needs no flag)
//   • { op:'run_adversary_review', base, head, wt, digest_path }
//                                                 — shell runs `the native adversary review --class
//                                                   adversary --base <base>` (whole-branch, network),
//                                                   re-calls --review=done|skipped; the durable
//                                                   event is written HERE on the answer
//   • { op:'ask', ask:'gate', gate, ... }         — a durable gate is open: render its AUQ
//                                                   (branch_finish carries base/branch/codex
//                                                   rehydrate; the PR probe is shell-side gh;
//                                                   docs_normalize carries the candidate *.md
//                                                   list — accept → shell normalizes in WT +
//                                                   commits, re-calls --docs-normalized; the
//                                                   durable event is written HERE on the answer)
//   • { op:'ask', ask:'owner-blocked'|'owner-lost'|'dispatch-error' } — Guard D / loud invariant
//   • { op:'shell', kind:'push_pr', branch, base, wt } — the pr choice's network half; the gate
//                                                   stays open until the shell confirms with
//                                                   --choice=pr --pushed (death before the push
//                                                   re-renders the gate, never silently archives)
//   • { op:'stop', reason:'archived'|'retro_done' } — terminal; archive ran in code
//
// Boundary notes (same seam as wave-commit/continue): LOCAL git only, -C-qualified to MAIN/WT
// loci derived here (snapshot, dirty-commit, merge, worktree remove, bundle commit). Network
// ops (push/gh/the native adversary review) stay shell-side. CD-7: every durable write goes through
// bundle.mjs; the bundle commits happen at the two §2c milestones that owned them in prose —
// gate resolution and archive.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  readState, writeState, openGate, clearGate, setStatus, setVerifiedSha,
  setWorktreeDisposition, appendEvent, inferGoalsCapability, resolveFormatPin, repairFormatPin,
  normalizeLegacyEventShape,
} from './bundle.mjs';
import { acquireOwner, heartbeatOwner, releaseOwner } from './owner-fs.mjs';
import { worktreePathFor, worktreeBranchFor, dispositionAfterTeardown } from './worktree.mjs';
import {
  classifyDirt, detectBase, detectBaseAuto, EMPTY_TREE_SHA,
  collectVerifyCommands, isVerified, dispositionForChoice,
  filterDocCandidates,
} from './finish.mjs';
import { verifyCheckpointEvidence } from './checkpoint-evidence.mjs';
import { orderDeployGroups, classifyStepOutcome, substituteVersionSafe, deployChainHash, liveCheckDigest, versionAtRevision, tagExists, mergeIdentity, mergedTree, auditDeployBoundary, dirtyOutsideBundle, finishCheckpointIdentity } from './finish.mjs';
import { resolveDoneAtRevision, doneDigest } from './config.mjs';
import { selectReentry } from './reentry-guard.mjs';
import { goalsHash, parseGoals, validateGoalCheckReceipt } from './goals.mjs';
import { upsertRetroCompletion } from './retro-goals.mjs';
import { runGit } from './watch-integrity.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

// runGit trims output — fatal for porcelain v1, whose first line's leading status column
// (e.g. " M path") would lose its space and shift classifyDirt's path slice. Read it raw.
function gitPorcelain(dir) {
  return String(execFileSync(
    'git', ['-C', dir, '-c', 'core.quotePath=false', 'status', '--porcelain'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
}

function runCheck(check, cwd) {
  if (!check) return null;
  try {
    const res = spawnSync('bash', ['-c', check], { cwd, encoding: 'utf8' });
    return res.status;
  } catch {
    return null;
  }
}

// Whole-branch review record at a HEAD sha, projected to the legacy 4-field shape
// ({present,digest,count,base} — no status) that the branch_finish gate AUQ payload
// carries; selectReentry's head-sha kind ignores skips exactly like the retired
// selectCodexReviewForHead did.
function selectReviewAtHead(eventsText, sha) {
  const { present, digest, count, base } = selectReentry(eventsText, { kind: 'head-sha', key: sha });
  return { present, digest, count, base };
}

export const FINISH_CHOICES = ['merge', 'pr', 'keep', 'discard'];
export const FINISH_OPS = [
  'run_verify', 'write_retro', 'run_adversary_review', 'ask', 'shell', 'stop',
  'run_deploy_step', 'deploy_indeterminate', 'deploy_failed', 'handback', 'no_definition_of_done',
];
const RETIRED = new Set(['removed_after_merge', 'kept_by_user']);
const VERIFY_GATES = new Set(['verification_failed', 'no_verification_command']);

function codexArmed(raw) {
  return raw === true || raw === 'on' || raw === 'true';
}

// Default-armed (inverse polarity of codexArmed): the docs-normalization offer is candidates-gated
// and only ever ASKS, so opting out is the exception (state.docs.normalize: off).
function docsNormalizeArmed(raw) {
  return !(raw === false || raw === 'off' || raw === 'false');
}

function readEvents(statePath) {
  try {
    return fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

const GOALS_CHOICES = new Set(['fix', 'waiver', 'abort']);

// Parse events.jsonl text into an array of records (blank/malformed lines dropped).
// Legacy data-wrapped required_successor records are lifted to the canonical shape on read
// (lib/bundle.mjs normalizeLegacyEventShape — the file's bytes are never rewritten).
export function parseEventArray(eventsText) {
  return String(eventsText || '')
    .split('\n')
    .map((l) => { const t = l.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } })
    .filter(Boolean)
    .map(normalizeLegacyEventShape);
}

// Is this bundle goals-capable? Authority: state.yml goals_enabled marker OR any capability/goal event
// in the log (inferGoalsCapability). Pre-feature bundles (neither) return false and skip goal gating
// entirely — no event spam.
function goalsEnabledFor(state, eventsText) {
  if (state && typeof state === 'object' && state.goals_enabled === true) return true;
  try { return inferGoalsCapability(parseEventArray(eventsText)).enabled === true; } catch { return false; }
}

// Recompute the spec-gate content hash over spec.md + goals.md, byte-identical to the bin layer's
// computeGateHash for a goals_enabled bundle (each descriptor: relName + '\0' + bytes + '\0'). Returns
// null if either artifact is unreadable (finish-step's check then fails soft — bin owns the hard gate).
function computeSpecGateHash(bundleDir, state) {
  const specRel = (state && typeof state.spec_path === 'string' && state.spec_path) ? state.spec_path : 'spec.md';
  const descriptors = [
    { rel: path.relative(bundleDir, path.resolve(bundleDir, specRel)), abs: path.resolve(bundleDir, specRel) },
    { rel: 'goals.md', abs: path.join(bundleDir, 'goals.md') },
  ];
  const h = createHash('sha256');
  for (const d of descriptors) {
    let bytes;
    try { bytes = fs.readFileSync(d.abs); } catch { return null; }
    h.update(d.rel); h.update('\0'); h.update(bytes); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

// Evaluate goal completion against the current tuple (goals hash + HEAD sha — the same identity
// record-goal-check keys on). Reads goals.md + the recorded goal_check / goal_waived events. Returns
// { readable, goalsHash, hasCheck, active, unmet, waived, nAchieved, nPartial, nWaived, summary }.
// A goal is resolved when it is waived (goal_waived at the tuple) OR its recorded verdict is 'achieved';
// anything else (partial/missed/unassessed) is unmet.
function evaluateGoalCompletion(bundleDir, eventsText, head) {
  let goalsMd;
  try { goalsMd = fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8'); } catch { return { readable: false }; }
  // §6.1: under the DURABLE format pin — the same hash record-goal-check records, so
  // a recorded check on a schema-backed bundle matches instead of silently going stale.
  let gHash;
  try {
    gHash = pinnedGoalsHashOf(path.join(bundleDir, 'state.yml'), goalsMd);
  } catch {
    gHash = goalsHash(goalsMd); // a pin-less bundle is the legacy shape; the unpinned hash IS its canonical one
  }
  const active = (parseGoals(goalsMd).goals || []).filter((g) => !g.tombstone);
  const recs = parseEventArray(eventsText);
  const checks = recs.filter((e) => e.type === 'goal_check' && e.data?.goals_hash === gHash && e.data?.head_sha === head);
  const check = checks.length ? checks[checks.length - 1] : null;
  const waivedIds = new Set();
  for (const e of recs) {
    if (e.type === 'goal_waived' && e.data?.goals_hash === gHash && e.data?.head_sha === head) {
      for (const id of Object.keys(e.data?.reasons || {})) waivedIds.add(id);
    }
  }
  const verdicts = check?.data?.verdicts || {};
  const unmet = [];
  const waived = [];
  let nAchieved = 0; let nPartial = 0; let nWaived = 0;
  for (const g of active) {
    if (waivedIds.has(g.id)) { waived.push({ id: g.id }); nWaived += 1; continue; }
    const v = verdicts[g.id]?.verdict;
    if (v === 'achieved') { nAchieved += 1; } else {
      unmet.push({ id: g.id, verdict: v || 'unassessed', evidence: verdicts[g.id]?.evidence ?? null });
      nPartial += 1;
    }
  }
  const summary = `${nAchieved} achieved / ${nPartial} partial / ${nWaived} waived`;
  return { readable: true, goalsHash: gHash, hasCheck: !!check, active, unmet, waived, nAchieved, nPartial, nWaived, summary };
}

// Matches BOTH event families (codex_review_skipped / adversary_review_skipped) so an in-flight
// bundle resumed across the codex→adversary rename is not re-reviewed.
const REVIEW_SKIP_TYPES = new Set(['codex_review_skipped', 'adversary_review_skipped']);
function hasCodexSkipAtSha(eventsText, sha) {
  for (const line of eventsText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (REVIEW_SKIP_TYPES.has(rec?.type) && rec.data?.sha === sha) return true;
  }
  return false;
}

// Presence scan (NOT sha-keyed): the docs-normalization guard fires once per RUN — accepting the
// offer moves HEAD by design, so a sha key would re-offer forever.
function hasEventType(eventsText, type) {
  for (const line of eventsText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec?.type === type) return true;
  }
  return false;
}

// Candidate docs for the §2c docs_normalize offer: every *.md the branch created/modified vs the
// merge-base (three-dot — an advanced base must not pollute the run's own work), minus the bundle
// dir. Fail-soft: any git error → no candidates → the offer stays silent (never wedge finish).
function listDocCandidates(WT, base, bundleRel) {
  try {
    return filterDocCandidates(
      runGit(WT, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', '*.md']),
      bundleRel,
    );
  } catch {
    return [];
  }
}

// Bundle state commit in MAIN — pathspec-scoped, Guard D sentinels excluded (the
// wave-commit.mjs convention; committing .owner* would ship a stale lock to every clone).
function commitBundle(MAIN, bundleDir, message) {
  const bundleRel = path.relative(MAIN, bundleDir) || '.';
  const pathspec = [bundleRel, `:(exclude)${bundleRel}/.owner*`];
  if (!runGit(MAIN, ['status', '--porcelain', '--', ...pathspec])) return null;
  runGit(MAIN, ['add', '--', ...pathspec]);
  runGit(MAIN, ['commit', '-q', '-m', message, '--', ...pathspec]);
  return runGit(MAIN, ['rev-parse', 'HEAD']);
}

// Update the bundle's retro.md `## Completion` block IN PLACE from the durable state + ledger
// (adversary r1 finding 1: renderRetroSummary had no production caller, and the `write_retro` op
// runs before disposition/completion/archive/push, so retro.md was born without a completion
// block and never gained one).
//
// Called AFTER archive (completion is now on state) and AGAIN after the push_archive answer
// lands (archive_pushed / archive_push_skipped is now on the ledger). Idempotent: an existing
// `## Completion` block is replaced wholesale, absent it is appended — re-entry after a crash
// re-upserts the same block to the same bytes. A no-op when retro.md is absent (the machine
// never creates the file here; the shell's `write_retro` op owns write-if-absent creation) and
// when there is no state to render. Commits the bundle so the durable retro reflects the
// archive/push in the same transaction.
function upsertRetroCompletionBlock(ctx, stateForRender) {
  try {
    if (!fs.existsSync(ctx.retroPath)) return;
    const current = fs.readFileSync(ctx.retroPath, 'utf8');
    const events = parseEventArray(readEvents(ctx.absState));
    const next = upsertRetroCompletion(current, { state: stateForRender ?? ctx.state, events });
    if (next === current) return;
    fs.writeFileSync(ctx.retroPath, next, 'utf8');
    // No commit here: the caller's commitBundle (the archive commit, or the push-answer commit)
    // lands in the SAME transaction, so the retro.md update is not a separate commit and the
    // archive/push commit message stays the last one on the ledger (the split-commit discipline
    // tests assert exactly that).
  } catch {
    // A retro update is never fatal to the archive/push transaction — the durable ledger and
    // state are the source of truth; retro.md is a rendering. A failure here must not roll back
    // an already-recorded archive or push.
  }
}

function applyShellAnswers(ctx) {
  // ---- A. apply the shell's answers (each is a durable transaction in its own right) ----

  if (ctx.verify === 'pass') {
    // PASS (or a reviewed "proceed anyway" override on a verification gate): record the SHA so
    // a re-entry at unchanged HEAD skips the re-run — then resolve any verification gate.
    ctx.state = setVerifiedSha(ctx.state, ctx.wtHead());
    if (ctx.state.pending_gate && VERIFY_GATES.has(ctx.state.pending_gate.id)) ctx.state = clearGate(ctx.state);
    writeState(ctx.absState, ctx.state);
  } else if (ctx.verify === 'fail') {
    ctx.state = openGate(ctx.state, { id: 'verification_failed', opened_at: ctx.ts });
    writeState(ctx.absState, ctx.state);
    return { op: 'ask', ask: 'gate', gate: 'verification_failed', head: ctx.wtHead(), wt: ctx.WT };
  }

  if (ctx.review === 'done') {
    ctx.head = ctx.wtHead();
    let note;
    if (ctx.reviewDigestFile) {
      try { note = fs.readFileSync(ctx.reviewDigestFile, 'utf8'); } catch { /* digest optional */ }
    }
    const record = {
      type: 'adversary_review',
      ts: ctx.ts,
      // the literal "adversary review" is the audit signal (\b(codex|adversary)\s+review\b)
      summary: `adversary review complete (whole-branch, base ${ctx.reviewBase ?? 'unknown'}) — ${ctx.reviewCount ?? '?'} findings`,
      data: { sha: ctx.head, base: ctx.reviewBase ?? null, count: Number.isFinite(Number(ctx.reviewCount)) ? Number(ctx.reviewCount) : null },
    };
    if (note !== undefined) record.note = note;
    appendEvent(ctx.absState, record);
  } else if (ctx.review === 'skipped') {
    // Fail-soft, never wedge finish — the hyphenated phrasing deliberately does NOT match the
    // audit's \b(codex|adversary)\s+review\b, so a degraded finish still trips configured-but-zero-invocations.
    appendEvent(ctx.absState, {
      type: 'adversary_review_skipped',
      ts: ctx.ts,
      summary: `whole-branch adversary-review skipped (degraded) — ${ctx.reviewReason ?? 'unspecified'}`,
      data: { sha: ctx.wtHead() },
    });
  }

  if (ctx.docs === 'normalized' || ctx.docs === 'skipped') {
    // Idempotent replay guard: a death between this append and the clearGate below makes the shell
    // re-answer — presence of either event means the append already landed, so only the gate clears.
    const type = ctx.docs === 'normalized' ? 'docs_normalize' : 'docs_normalize_skipped';
    if (!hasEventType(readEvents(ctx.absState), type)) {
      const count = Number.isFinite(Number(ctx.docsCount)) ? Number(ctx.docsCount) : null;
      appendEvent(ctx.absState, {
        type,
        ts: ctx.ts,
        summary: ctx.docs === 'normalized'
          ? `finish docs normalization complete — ${count ?? '?'} file(s) folded into repo docs`
          : `finish docs normalization skipped — ${ctx.docsReason ?? 'user kept plan-organized docs'}`,
        data: { sha: ctx.wtHead(), ...(ctx.docs === 'normalized' ? { count } : {}) },
      });
    }
    if (ctx.state.pending_gate?.id === 'docs_normalize') {
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
    }
  }

  // goals_unmet gate resolution (goal tracking). finish-step ONLY sequences: the goal_waived waiver and
  // any user-attested verdict receipts are appended by the capture-owned recorder verb, NEVER here.
  // 'waiver' clears the gate and falls through so re-evaluation sees the recorder's goal_waived event;
  // 'fix' / 'abort' stop the finish flow so the user can amend code (a later finish re-runs the check).
  if (ctx.goalsChoice !== null) {
    if (!GOALS_CHOICES.has(ctx.goalsChoice)) {
      throw new Error(`finish-step: unknown --goals-choice '${ctx.goalsChoice}' — expected one of: ${[...GOALS_CHOICES].join(', ')}`);
    }
    // `fix` is unavailable on the FINAL gate, and refusing it here is what makes that real:
    // the rendered choices omit it, but a caller can submit any flag, and post-live there is
    // no worktree left to fix in. Refused BEFORE the gate is cleared — a rejected answer must
    // leave the gate exactly as it found it.
    if (ctx.state.pending_gate?.id === 'goals_unmet' && ctx.state.pending_gate?.mode === 'final' && ctx.goalsChoice === 'fix') {
      throw new Error("finish-step: --goals-choice=fix is not available on the final goals_unmet gate — the deployment is live and the worktree is gone; waive, abort, or reject the intent with --intent-rejected");
    }
    // A waiver on the FINAL gate has to be terminal in its own right. The implementation-phase
    // waiver is deliberately not stage-terminal (the run goes on to deploy), so reusing it here
    // would clear the gate and leave the same partial receipt in place — and the very next
    // evaluation would reopen the identical gate, forever.
    const finalUnmet = ctx.state.pending_gate?.id === 'goals_unmet' && ctx.state.pending_gate?.mode === 'final';
    if (finalUnmet && ctx.goalsChoice === 'waiver') {
      const evs = parseEventArray(readEvents(ctx.absState));
      const base = evs.find((e) => e.type === 'deploy_base');
      if (!base) throw new Error('finish-step: a final goals_unmet waiver without a deploy_base');
      assertDeployAuthorizable(ctx, base.sha, resolveBoundDone(ctx, base));
      appendEvent(ctx.absState, {
        type: 'incomplete_authorized', ts: ctx.ts, reason: 'intent_waived',
        deploy_base_sha: base.sha,
        head_after: runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim(),
      });
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
      return { op: 'stop', reason: 'intent_waived' };
    }
    if (ctx.state.pending_gate?.id === 'goals_unmet') {
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
    }
    if (ctx.goalsChoice === 'abort') return { op: 'stop', reason: 'finish_aborted_goals_unmet' };
    if (ctx.goalsChoice === 'fix') return { op: 'stop', reason: 'goals_unmet_fix' };
    // 'waiver': gate cleared — fall through to the machine, which re-evaluates and proceeds.
  }

  // ---- A.5 deploy stage answers ----

  if (ctx.deployAuthorize) {
    const { group, index } = ctx.deployAuthorize;
    const eventsText = readEvents(ctx.absState);
    const deployBase = parseEventArray(eventsText).find((e) => e.type === 'deploy_base');
    const deployBaseSha = deployBase ? deployBase.sha : null;
    if (!deployBaseSha) throw new Error('finish-step: --deploy-authorize before deploy_base — no step has been exposed for authorization yet');
    {
      const evs = parseEventArray(eventsText);
      const def = resolveBoundDone(ctx, deployBase);
      if (!def || def === 'none') throw new Error('finish-step: --deploy-authorize without a done definition');
      const step = def[group] && def[group][index];
      if (!step) throw new Error(`finish-step: --deploy-authorize for unknown step ${group}[${index}]`);
      if (group === 'user_only') throw new Error(`finish-step: ${group}[${index}] is a user_only step — it is handed back, never authorized`);
      // Only the step the ordered chain currently exposes can be authorized (§7.2): no pre-recording
      // an authorization for a later step to skip its gated prompt.
      const current = nextPendingStep(def, evs, deployBaseSha);
      if (!current || current.group !== group || current.index !== index) {
        throw new Error(`finish-step: --deploy-authorize for ${group}[${index}] is out of order — the current step is ${current ? `${current.group}[${current.index}]` : 'none'}`);
      }
      const halted = latestStepOutcome(evs, group, index, deployBaseSha);
      if (halted === 'failed' || halted === 'indeterminate') {
        throw new Error(`finish-step: ${group}[${index}] is halted (${halted}) — resolve it with --deploy-retry / --deploy-rerun / --deploy-skip / --deploy-attest / --deploy-abort, not a plain authorization`);
      }
      assertDeployAuthorizable(ctx, deployBaseSha, def);
      const exists = parseEventArray(eventsText).some(
        (e) => e.type === 'deploy_step_authorized' && e.group === group && e.index === index && e.sha === deployBaseSha,
      );
      if (!exists) {
        appendEvent(ctx.absState, { type: 'deploy_step_authorized', ts: ctx.ts, group, index, sha: deployBaseSha });
      }
    }
  }

  if (ctx.deployRetry || ctx.deployRerun) {
    const { group, index } = ctx.deployRetry || ctx.deployRerun;
    const evs = parseEventArray(readEvents(ctx.absState));
    const base = evs.find((e) => e.type === 'deploy_base');
    if (!base) throw new Error('finish-step: deploy retry/rerun without deploy_base');
    const outcome = latestStepOutcome(evs, group, index, base.sha);
    const wanted = ctx.deployRetry ? 'failed' : 'indeterminate';
    if (outcome !== wanted) {
      const given = ctx.deployRetry ? '--deploy-retry' : '--deploy-rerun';
      if (outcome !== 'failed' && outcome !== 'indeterminate') throw new Error(`finish-step: ${group}[${index}] is not halted — ${given} refused`);
      const answer = outcome === 'failed' ? '--deploy-retry' : '--deploy-rerun';
      throw new Error(`finish-step: ${group}[${index}] is ${outcome} — a deploy_${outcome} gate is answered by ${answer}, not ${given}`);
    }
    // A retry/rerun always needs a FRESH authorization (§7.2); the stage re-emits started + run.
    assertDeployAuthorizable(ctx, base.sha, resolveBoundDone(ctx, base));
    appendEvent(ctx.absState, { type: 'deploy_step_authorized', ts: ctx.ts, group, index, sha: base.sha });
  }
  if (ctx.deploySkip) {
    const { group, index } = ctx.deploySkip;
    const evs = parseEventArray(readEvents(ctx.absState));
    const base = evs.find((e) => e.type === 'deploy_base');
    if (!base || latestStepOutcome(evs, group, index, base.sha) !== 'failed') throw new Error(`finish-step: ${group}[${index}] is not a failed step — only a halted failure can be skipped`);
    // The gate never offers skip for live_check; the verb refuses it too, so a caller cannot
    // reach past the offer to waive the run's own liveness evidence.
    if (group === 'live_check') throw new Error(`finish-step: live_check[${index}] cannot be skipped — it is the evidence the deployment works; retry it or abort the finish`);
    // A skip advances the ordered chain past a halted step: the boundary is audited first, exactly as
    // an authorization is, so history that appeared while the gate was open is a base move.
    assertDeployAuthorizable(ctx, base.sha, resolveBoundDone(ctx, base));
    appendEvent(ctx.absState, { type: 'incomplete_authorized', ts: ctx.ts, reason: `deploy_skip:${group}[${index}]`, head_after: runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim() });
  }
  if (ctx.deployAttest) {
    const { group, index } = ctx.deployAttest;
    const evs = parseEventArray(readEvents(ctx.absState));
    const base = evs.find((e) => e.type === 'deploy_base');
    if (!base) throw new Error('finish-step: deploy attest without deploy_base');
    const def = resolveBoundDone(ctx, base);
    const step = def && def !== 'none' && def[group] && def[group][index];
    if (!step) throw new Error(`finish-step: attest for unknown step ${group}[${index}]`);
    if (step.check) throw new Error(`finish-step: ${group}[${index}] has a check — attestation is only for check-less steps`);
    if (latestStepOutcome(evs, group, index, base.sha) !== 'indeterminate') throw new Error(`finish-step: ${group}[${index}] is not indeterminate`);
    // No step runs while a gate is open, so an attestation claims NO output of its own. The boundary
    // is audited exactly as an authorization is (§7.3): commits into this bundle are legal while the
    // gate is open, an unreceipted commit_paths commit or any foreign commit is a base move.
    assertDeployAuthorizable(ctx, base.sha, def);
    const headNow = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
    appendEvent(ctx.absState, { type: 'deploy_step', ts: ctx.ts, group, index, exit: 0, status: 'attested', sha: base.sha, commits: [], head_after: headNow });
    // §7.4: an attestation is a durable, operator-signed record that is NOT proof — a mandatory
    // group containing an attested step archives as `incomplete:attested`, never `complete`.
    // The authorization is written AT the attestation, not inferred at archive: the completion
    // class derives from what the ledger authorizes, and an attestation whose operator-signed
    // record somehow vanished would archive with no reason at all.
    appendEvent(ctx.absState, { type: 'incomplete_authorized', ts: ctx.ts, reason: 'attested', group, index, sha: base.sha, head_after: headNow });
  }
  // Exactly ONE final-gate answer per call, checked before any of them writes. Applied in
  // sequence, a conflicting pair records the first and then throws on the second: the caller
  // sees a failure while `completion_confirmed` is already durable, and the next re-entry
  // archives on an authorization nobody meant to give.
  {
    const answers = [
      ctx.intentConfirmed ? '--intent-confirmed' : null,
      ctx.intentRejected ? '--intent-rejected' : null,
      ctx.deployAbort ? '--deploy-abort' : null,
      ctx.goalsChoice !== null && ctx.goalsChoice !== undefined ? `--goals-choice=${ctx.goalsChoice}` : null,
    ].filter(Boolean);
    if (answers.length > 1) {
      throw new Error(`finish-step: ${answers.join(' and ')} were supplied together — a gate takes exactly one answer, and applying them in sequence would record the first before refusing the second`);
    }
  }

  // §7.3: the operator's answer to intent_confirm. The boundary is re-audited HERE, not only
  // when the gate opened: the gate is durable, so an arbitrary amount of time — and any number
  // of commits — can pass between the question and the answer.
  if (ctx.intentConfirmed) {
    const evs = parseEventArray(readEvents(ctx.absState));
    const base = evs.find((e) => e.type === 'deploy_base');
    if (!base) throw new Error('finish-step: --intent-confirmed without a deploy_base — there is no deployment to confirm');
    if (ctx.state.pending_gate?.id !== 'intent_confirm') {
      throw new Error('finish-step: --intent-confirmed with no open intent_confirm gate — the confirmation answers that gate only');
    }
    const def = resolveBoundDone(ctx, base);
    const inputs = finalAssessmentInputs(ctx, base.sha, def);
    // The receipt must STILL validate against the deployment as it stands now.
    const found = finalReceiptFor(ctx, { deployBaseSha: base.sha, ...inputs });
    if (found.kind !== 'ok') {
      throw new Error(
        found.kind === 'invalid'
          ? `finish-step: --intent-confirmed against an INVALID final assessment receipt: ${found.error}`
          : 'finish-step: --intent-confirmed without a final assessment receipt bound to this deployment — record one first',
      );
    }
    const receipt = found.event;
    // The receipt the GATE named, not merely the newest valid one. A receipt appended while
    // the durable gate sat open is an assessment the operator never saw, and confirming it
    // would put their name on a verdict they were not shown.
    const bound = ctx.state.pending_gate?.receipt ?? null;
    if (bound && receiptIdentity(receipt) !== bound) {
      throw new Error('finish-step: --intent-confirmed but the final assessment changed since the gate opened — re-enter to review the current one before confirming');
    }
    // ...and it must still say `met`. Only a met verdict opens intent_confirm, so anything else
    // here is a receipt that replaced the one on screen.
    if (receipt.data?.intent_verdict?.verdict !== 'met') {
      throw new Error(`finish-step: --intent-confirmed against a ${receipt.data?.intent_verdict?.verdict ?? 'missing'} intent verdict — only a met assessment can be confirmed`);
    }
    assertDeployAuthorizable(ctx, base.sha, def);
    // §7.3 idempotency (adversary r1 finding 3): the first ledger answer for the bound gate/base is
    // authoritative. A crash between the append and the gate-clear would otherwise let a re-issued
    // --intent-confirmed append a second confirmation, or a later --intent-rejected record a
    // contradictory terminal decision after a confirmation already landed. Replay of the SAME answer
    // for the SAME base appends nothing and returns the (already-cleared) machine state; a
    // CONFLICTING answer for an already-answered gate is refused before writing.
    const priorConfirmed = evs.filter((e) => e.type === 'completion_confirmed' && e.deploy_base_sha === base.sha);
    if (priorConfirmed.length) {
      // Replay: the gate already got its answer for this base. Return success without a second append.
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
      return;
    }
    const priorRejected = evs.filter((e) => e.type === 'incomplete_authorized' && String(e.reason ?? '').startsWith('intent_rejected:') && e.deploy_base_sha === base.sha);
    if (priorRejected.length) {
      throw new Error('finish-step: --intent-confirmed refused — this deployment was already rejected on intent; a confirmation cannot contradict the terminal rejection on the ledger');
    }
    appendEvent(ctx.absState, {
      type: 'completion_confirmed', ts: ctx.ts,
      deploy_base_sha: base.sha,
      // The scalar verdict, not the whole {verdict, evidence} object: the receipt already
      // holds the evidence, and this event is read for the completion class.
      intent_verdict: receipt.data?.intent_verdict?.verdict ?? null,
      // The full binding, so the authorization stays auditable without re-deriving it.
      receipt: receiptIdentity(receipt),
      deploy_chain_hash: inputs.chainHash,
      live_check_digest: inputs.liveDigest,
    });
    ctx.state = clearGate(ctx.state);
    writeState(ctx.absState, ctx.state);
  }
  // §7.5: the operator's REJECTION of the deployed result — from either final gate
  // (`rejected` on intent_confirm, `reject-intent` on the final goals_unmet). It is the mirror
  // of a confirmation and needs the same durability: an obligation nobody recorded is one
  // nobody can discharge, so the class, the reason and the named successor all land in one
  // event before the gate is cleared.
  if (ctx.intentRejected) {
    const evs = parseEventArray(readEvents(ctx.absState));
    const base = evs.find((e) => e.type === 'deploy_base');
    if (!base) throw new Error('finish-step: --intent-rejected without a deploy_base — there is no deployment to reject');
    const openId = ctx.state.pending_gate?.id ?? null;
    if (openId !== 'intent_confirm' && !(openId === 'goals_unmet' && ctx.state.pending_gate?.mode === 'final')) {
      throw new Error('finish-step: --intent-rejected with no open intent_confirm or final goals_unmet gate — the rejection answers one of those gates only');
    }
    const { class: cls, reason, successor } = ctx.intentRejected;
    // Validated, not merely truthy. Every `intent_rejected:` reason is stage-terminal, so a
    // typo'd class permanently ends the run under a label no reader understands, and a
    // whitespace successor is an obligation nobody can discharge.
    if (!INTENT_REJECTION_CLASSES.has(cls)) {
      throw new Error(`finish-step: --intent-rejected class ${JSON.stringify(cls)} is not one of ${[...INTENT_REJECTION_CLASSES].join('/')}`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error('finish-step: --intent-rejected requires a non-empty reason');
    }
    if (typeof successor !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(successor.trim())) {
      throw new Error(`finish-step: --intent-rejected successor ${JSON.stringify(successor)} is not a bundle slug — an obligation with no named successor is one nobody can close`);
    }
    // The boundary is audited on the rejection path too: this event names the deployment being
    // rejected, and a base that moved means it names the wrong one.
    assertDeployAuthorizable(ctx, base.sha, resolveBoundDone(ctx, base));
    // §7.5 idempotency (adversary r1 finding 3): the first ledger answer for this base is
    // authoritative. A prior confirmation or rejection for the SAME base must not be contradicted
    // by a later answer; a same-answer replay (a crash after the authorization append, before the
    // successor append) is recovered by the §0.6 transaction and needs no second write here.
    const priorConfirmed = evs.filter((e) => e.type === 'completion_confirmed' && e.deploy_base_sha === base.sha);
    if (priorConfirmed.length) {
      throw new Error('finish-step: --intent-rejected refused — this deployment was already confirmed; a rejection cannot contradict the confirmation on the ledger');
    }
    const priorRejected = evs.filter((e) => e.type === 'incomplete_authorized' && String(e.reason ?? '').startsWith('intent_rejected:') && e.deploy_base_sha === base.sha);
    if (priorRejected.length) {
      // Replay of the same answer for the same base is idempotent: the gate was already answered.
      // (The successor projection is healed by the §0.6 recovery if it never landed.)
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
      return;
    }
    // ONE event, shaped for the reader that already exists: projectPredecessorRejection reads
    // an `incomplete_authorized` whose reason starts `intent_rejected` and takes `class` and
    // `correction` off that same record, so the successor's interview can be corrected by an
    // `intent`-class rejection. A separate `intent_rejected` event would be invisible to it.
    // The class rides in the reason so the archive class names the cause without a second read.
    appendEvent(ctx.absState, {
      type: 'incomplete_authorized', ts: ctx.ts,
      reason: `intent_rejected:${cls}`,
      class: cls,
      // An `intent`-class rejection means the goal was misunderstood, so its reason IS the
      // correction the successor's interview should start from.
      ...(cls === 'intent' ? { correction: reason.trim() } : {}),
      rejection_reason: reason.trim(),
      successor: successor.trim(),
      gate: openId,
      deploy_base_sha: base.sha,
      head_after: runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim(),
    });
    // §7.4/§7.5: the rejection hands work to a successor, and the run says so durably. The
    // `required_successor {slug, reason}` event is what runs list / mp status / resume-brief
    // project as an open obligation, and what the doctor check enforces. Both classes emit it;
    // the `intent` class carries the operator's correction text as the remediation the
    // successor's interview opens with (the seed's projectPredecessorRejection reads the
    // `incomplete_authorized` record for the correction; this event names the obligation).
    appendEvent(ctx.absState, {
      type: 'required_successor', ts: ctx.ts,
      slug: successor.trim(),
      reason: cls === 'intent'
        ? `the deployed result was rejected on intent: ${reason.trim()}`
        : `the deployed result was rejected on implementation: ${reason.trim()}`,
      source: ctx.slug,
      class: cls,
    });
    ctx.state = clearGate(ctx.state);
    writeState(ctx.absState, ctx.state);
  }

  if (ctx.deployAbort) {
    // Abort answers a halted step's gate (deploy_failed / deploy_indeterminate) OR the
    // live-evidence gate. The latter has no halted step to point at — its steps all exited
    // zero; what is missing is the evidence — but abort is the ONLY answer that gate offers,
    // so it has to be executable from here or the gate is a dead end.
    const evs = parseEventArray(readEvents(ctx.absState));
    const base = evs.find((e) => e.type === 'deploy_base');
    if (!base) throw new Error('finish-step: --deploy-abort before deploy_base — no deploy gate is open');
    const def = resolveBoundDone(ctx, base);
    // The FINAL gates all offer `abort`, and none of them has a halted step to point at: their
    // deploy steps all exited zero, and what is wrong is the evidence, the receipt or the
    // verdict. Abort has to be executable from each of them or every one is a dead end — which
    // is the same defect the live-evidence gate was found to have.
    const FINAL_ABORT_GATES = new Set(['live_check_evidence_missing', 'final_check_invalid', 'goals_unmet']);
    const openGateId = ctx.state.pending_gate?.id ?? null;
    const finalGate = FINAL_ABORT_GATES.has(openGateId)
      && (openGateId !== 'goals_unmet' || ctx.state.pending_gate?.mode === 'final');
    const evidenceGate = finalGate;
    const current = def && def !== 'none' ? nextPendingStep(def, evs, base.sha) : null;
    const halted = current ? latestStepOutcome(evs, current.group, current.index, base.sha) : null;
    if (!finalGate && halted !== 'failed' && halted !== 'indeterminate') {
      throw new Error(`finish-step: --deploy-abort refused — ${current ? `${current.group}[${current.index}] is not halted` : 'no deploy step is pending'}; abort answers a deploy_failed / deploy_indeterminate gate`);
    }
    // An abort ends the stage and archives the run: the boundary is audited first, exactly as an
    // authorization is, so a foreign commit made while the gate was open is a base move, not history
    // the archive silently accepts.
    assertDeployAuthorizable(ctx, base.sha, def);
    appendEvent(ctx.absState, {
      type: 'incomplete_authorized', ts: ctx.ts,
      // The reason NAMES the gate that was aborted, so the archive class says which of the
      // final checks the run stopped at rather than a bare `deploy_abort`.
      reason: finalGate
        ? `deploy_abort:${openGateId === 'live_check_evidence_missing' ? (ctx.state.pending_gate?.cause ?? openGateId) : openGateId}`
        : 'deploy_abort',
      head_after: runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim(),
    });
    if (finalGate) {
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
    }
  }

  if (ctx.deployStepDone) {
    const { group, index, exit, digestFile } = ctx.deployStepDone;
    // The recorder names a FILE; the event carries the digest of what is in it. Reading it here
    // (before any event is appended) means an unreadable or blank evidence file fails the report
    // outright rather than silently recording a step with no evidence behind it.
    const digest = digestFile ? liveCheckDigest(digestFile) : null;
    // ...and the evidence is INGESTED into the bundle, content-addressed by that digest. The
    // file the shell hands us is caller-owned and usually a temp path: it can be deleted, be
    // overwritten by the next run, or simply not exist on the host that resumes the finish. A
    // durable ledger that points at /tmp records a promise it cannot keep, and the final
    // assessment — which may run days later, in another process — has to be able to read the
    // bytes the digest was taken over.
    const evidenceRel = digest ? path.join('evidence', `${digest.replace(':', '-')}.txt`) : null;
    if (digest) {
      const dest = path.join(ctx.bundleDir, evidenceRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(digestFile, dest);
    }
    const eventsText = readEvents(ctx.absState);
    const deployBase = parseEventArray(eventsText).find((e) => e.type === 'deploy_base');
    const deployBaseSha = deployBase ? deployBase.sha : null;
    if (!deployBaseSha) throw new Error('finish-step: deploy_step_done without deploy_base');
    const def = resolveBoundDone(ctx, deployBase);
    if (def === undefined || def === 'none') throw new Error('finish-step: deploy_step_done without done definition');
    const priorEvents = parseEventArray(eventsText);
    // The report must belong to the ACTIVE attempt: a start after the latest authorization and no outcome since.
    let lastAuthIdx = -1;
    priorEvents.forEach((e, k) => { if (e.type === 'deploy_step_authorized' && e.group === group && e.index === index && e.sha === deployBaseSha) lastAuthIdx = k; });
    const hasAuth = lastAuthIdx >= 0;
    const hasStart = priorEvents.slice(lastAuthIdx + 1).some((e) => e.type === 'deploy_step_started' && e.group === group && e.index === index && e.sha === deployBaseSha);
    if (group !== 'user_only' && (!hasAuth || !hasStart)) throw new Error(`finish-step: deploy_step_done for ${group}[${index}] without authorization/start`);
    const halted = latestStepOutcome(priorEvents, group, index, deployBaseSha);
    if (halted === 'failed' || halted === 'indeterminate') throw new Error(`finish-step: ${group}[${index}] is halted (${halted}) — a report needs a fresh --deploy-retry / --deploy-rerun first`);
    if (priorEvents.some((e) => e.type === 'deploy_step' && e.group === group && e.index === index && e.sha === deployBaseSha)) throw new Error(`finish-step: ${group}[${index}] already recorded`);
    const step = def[group] && def[group][index];
    if (!step) throw new Error(`finish-step: deploy_step_done for unknown step ${group}[${index}]`);
    // Reports are accepted only for the step the ordered chain currently exposes (§7.2): a later
    // user_only step cannot be reported past a pending release/install step.
    const current = nextPendingStep(def, priorEvents, deployBaseSha);
    if (!current || current.group !== group || current.index !== index) {
      throw new Error(`finish-step: deploy_step_done for ${group}[${index}] is out of order — the current step is ${current ? `${current.group}[${current.index}]` : 'none'}`);
    }
    // Every report — success, failure or indeterminate — audits what the step AND its check did to
    // MAIN before anything is recorded: the check runs first (it may commit too), then the audit; a
    // foreign commit is a base move whatever the exit code, and no outcome is recorded for it.
    if (group === 'user_only') {
      const checkExit = runCheck(step.check, ctx.MAIN);
      const produced = stepCommitsSince(ctx, priorEvents, deployBaseSha, def);
      if (checkExit === 0) {
        appendEvent(ctx.absState, { type: 'deploy_step', ts: ctx.ts, group, index, exit: 0, status: 'done', check_exit: 0, sha: deployBaseSha, ...produced });
      } else if (checkExit === 1) {
        appendEvent(ctx.absState, { type: 'deploy_step_check_failed', ts: ctx.ts, group, index, sha: deployBaseSha, ...produced });
        return { op: 'ask', ask: 'handback', group, index, text: step.text, check: step.check };
      } else {
        appendEvent(ctx.absState, { type: 'deploy_indeterminate', ts: ctx.ts, group, index, exit: 0, check_exit: checkExit, sha: deployBaseSha, ...produced });
        return { op: 'ask', ask: 'gate', gate: 'deploy_indeterminate', group, index, choices: indeterminateChoices(step) };
      }
    } else {
      let checkExit = null;
      if (step.check) checkExit = runCheck(step.check, ctx.MAIN);
      const produced = stepCommitsSince(ctx, priorEvents, deployBaseSha, def);
      const outcome = classifyStepOutcome({ runExit: exit, checkExit });
      if (outcome === 'done') {
        // §7.2 push_archive producer: an install step that moved origin/<base> to its own
        // head_after records pushed_base on the receipt (the archive push gate reads it later).
        const receipt = recordPushedBase(ctx, produced, group, index, detectBase(runGit(ctx.MAIN, ['branch', '--format=%(refname:short)'])), deployBaseSha);
        appendEvent(ctx.absState, { type: 'deploy_step', ts: ctx.ts, group, index, exit, status: 'done', ...(checkExit === null ? {} : { check_exit: checkExit }), ...(digest ? { digest, digest_path: evidenceRel } : {}), sha: deployBaseSha, ...receipt });
      } else if (outcome === 'failed') {
        appendEvent(ctx.absState, { type: 'deploy_failed', ts: ctx.ts, group, index, exit, ...(exit === 0 && checkExit === 1 ? { check_exit: 1 } : {}), sha: deployBaseSha, ...produced });
        return { op: 'ask', ask: 'gate', gate: 'deploy_failed', group, index, error: 'step failed', choices: failedChoices(group) };
      } else {
        appendEvent(ctx.absState, { type: 'deploy_indeterminate', ts: ctx.ts, group, index, exit, check_exit: checkExit, sha: deployBaseSha, ...produced });
        return { op: 'ask', ask: 'gate', gate: 'deploy_indeterminate', group, index, choices: indeterminateChoices(step) };
      }
    }
  }

  // ---- B. the branch_finish gate resolution (the prose's "act" turn, now a transaction) ----

  // §7.2 push_archive answers. Only on an ARCHIVED bundle (the gate opens post-archive), and only
  // when the archive_pushed / archive_push_skipped decision is still outstanding. The events are
  // appended directly (not via appendEvent) because the bundle is already archived and appendEvent
  // refuses everything but archive_pushed after archived — so the decline needs the direct write too.
  if (ctx.archivePushed || ctx.archivePushSkipped) {
    if (ctx.archivePushed && ctx.archivePushSkipped) {
      throw new Error('finish-step: --archive-pushed and --archive-push-skipped were supplied together — the push_archive gate takes exactly one answer');
    }
    const state = readState(ctx.absState);
    if (state.status !== 'archived') {
      throw new Error('finish-step: the push_archive answer requires an archived bundle');
    }
    const evs = parseEventArray(readEvents(ctx.absState));
    // Adversary r1 finding 3: the first terminal answer on the ledger is authoritative. A replay
    // after a death between the append and the gate clear is accepted ONLY when it is an IDENTICAL
    // replay (same answer type, same sha/reason); an opposite answer type or a mismatched
    // sha/reason is refused before writing — mirroring the wave-6 final-gate conflict-refusal
    // (completion_confirmed / intent_rejected). Re-issuing the SAME answer clears the gate and
    // stops idempotently.
    const priorPushed = evs.filter((e) => e.type === 'archive_pushed');
    const priorSkipped = evs.filter((e) => e.type === 'archive_push_skipped');
    if (priorPushed.length || priorSkipped.length) {
      const priorP = priorPushed[priorPushed.length - 1];
      const priorS = priorSkipped[priorSkipped.length - 1];
      if (ctx.archivePushed) {
        const sha = typeof ctx.archivePushed.sha === 'string' ? ctx.archivePushed.sha.trim() : '';
        if (!priorP) {
          throw new Error('finish-step: --archive-pushed refused — the archive push was already DECLINED (archive_push_skipped is on the ledger); a pushed claim cannot contradict the decline');
        }
        if (priorP.sha !== sha) {
          throw new Error(`finish-step: --archive-pushed --sha=${sha} refused — the archive push is already recorded with sha ${priorP.sha.slice(0, 12)}; a replayed push must name the same sha`);
        }
      } else if (ctx.archivePushSkipped) {
        const reason = typeof ctx.archivePushSkipped.reason === 'string' && ctx.archivePushSkipped.reason.trim()
          ? ctx.archivePushSkipped.reason.trim()
          : 'the operator declined to push the archive';
        if (!priorS) {
          throw new Error('finish-step: --archive-push-skipped refused — the archive push is already RECORDED (archive_pushed is on the ledger); a decline cannot contradict the recorded push');
        }
        if (priorS.reason !== reason) {
          throw new Error('finish-step: --archive-push-skipped refused — the decline is already recorded with a different reason; a replayed decline must repeat the recorded reason');
        }
      }
      // Identical replay (or a bare re-entry carrying no answer): the answer already landed —
      // re-resolve idempotently rather than refusing (the pending_gate may or may not be open).
      ctx.state = clearGate(state);
      writeState(ctx.absState, ctx.state);
      return { op: 'stop', reason: 'archived', slug: ctx.slug, disposition: state.worktree_disposition };
    }
    // The answer resolves the push_archive gate only: an --archive-pushed on a run whose push gate
    // is not (or never was) open is refused, exactly as --intent-confirmed requires the open
    // intent_confirm gate. The durable gate holds the pushed_base the claim must extend.
    if (state.pending_gate?.id !== 'push_archive') {
      throw new Error('finish-step: --archive-pushed / --archive-push-skipped with no open push_archive gate — the push gate opens at archive for install-pushed runs only');
    }
    if (ctx.archivePushed) {
      const sha = typeof ctx.archivePushed.sha === 'string' ? ctx.archivePushed.sha.trim() : '';
      if (!sha) throw new Error('finish-step: --archive-pushed requires --sha=<sha> (the pushed base sha)');
      // The pushed sha is the archive HEAD the gate offered — the operator pushes `origin <base>`
      // to exactly that commit. Recording an unrelated sha would launder a non-push (or a push of
      // the wrong tip) into the ledger, so the claim must name the current archive HEAD.
      const headNow = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
      if (sha !== headNow) {
        throw new Error(`finish-step: --archive-pushed --sha=${sha} does not match the archive HEAD ${headNow.slice(0, 12)} — the push must carry the current archive commit`);
      }
      // ...and the fast-forward premise must hold: the pushed sha extends the install receipt's
      // pushed_base (the sha the install push carried), never rewinds past it. An explicit
      // is-ancestor check (mirroring evaluatePushArchive's finding-6 invariant), so a divergent
      // pushed_base cannot launder a range that is not a fast-forward.
      const baseEv = [...evs].reverse().find((e) => e.type === 'deploy_base');
      const pushedBase = [...evs].reverse().find(
        (e) => e.type === 'deploy_step' && e.group === 'install' && e.sha === (baseEv ? baseEv.sha : null) && typeof e.pushed_base === 'string',
      )?.pushed_base ?? null;
      if (pushedBase) {
        let contains = false;
        try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', pushedBase, sha]); contains = true; } catch { contains = false; }
        if (!contains) {
          throw new Error(`finish-step: --archive-pushed --sha=${sha.slice(0, 12)} does not contain the install receipt's pushed_base ${pushedBase.slice(0, 12)} — the archive push must be a fast-forward of the offered range`);
        }
      }
      // Adversary r1 findings 4+5: the answer is bound to the REMOTE, not trusted from the
      // operator's word or a stale local ref. Fetch origin/<base> and verify the remote actually
      // carries the archive head before recording archive_pushed; when the remote has diverged
      // (a non-fast-forward — another host moved origin), run the real recovery inside the lib:
      // audit every fetched commit, rebase the local archive onto the remote tip, push once with
      // one retry, and record the rebased head. A remote that does not carry the sha (the operator
      // never pushed) REFUSES — the push must actually land first.
      const baseBranch = detectBase(runGit(ctx.MAIN, ['branch', '--format=%(refname:short)'])) ?? 'main';
      const verifiedSha = verifyOrRecoverArchivePush(ctx, evs, baseBranch, sha, pushedBase);
      // archive_pushed is the ONE event appendEvent accepts after archived (and the bundle
      // schema validates its `sha`); the decline below has no such route and is written directly.
      appendEvent(ctx.absState, { type: 'archive_pushed', ts: ctx.ts, sha: verifiedSha });
    } else {
      const reason = typeof ctx.archivePushSkipped.reason === 'string' && ctx.archivePushSkipped.reason.trim()
        ? ctx.archivePushSkipped.reason.trim()
        : 'the operator declined to push the archive';
      fs.appendFileSync(path.join(ctx.bundleDir, 'events.jsonl'), `${JSON.stringify({ type: 'archive_push_skipped', ts: ctx.ts, reason })}\n`, 'utf8');
    }
    ctx.state = clearGate(state);
    writeState(ctx.absState, ctx.state);
    // Post-push retro completion block: archive_pushed / archive_push_skipped is now on the
    // ledger, so the `## Completion` block's pushed line flips to its terminal value (adversary
    // r1 finding 1). Idempotent — re-upserting the same answer re-renders the same block.
    // Written BEFORE the commit so the push-answer commit carries the retro update (the split-
    // commit discipline asserts the push commit is the last on the ledger).
    upsertRetroCompletionBlock(ctx, ctx.state);
    commitBundle(ctx.MAIN, ctx.bundleDir, `masterplan(${ctx.slug}): archive push recorded`);
    if (!ctx.ownerLockOff && ctx.self) {
      releaseOwner(ctx.bundleDir, ctx.self, { now: ctx.now, ttlMs: ctx.ttlMs });
    }
    return { op: 'stop', reason: 'archived', slug: ctx.slug, disposition: state.worktree_disposition };
  }

  if (ctx.choice !== null) {
    if (!FINISH_CHOICES.includes(ctx.choice)) {
      throw new Error(`finish-step: unknown --choice '${ctx.choice}' — expected one of: ${FINISH_CHOICES.join(', ')}`);
    }
    // The base the gate advertised — read from MAIN's branch list (survives a removed WT).
    const detectedBase = () => {
      try { return detectBase(runGit(ctx.MAIN, ['branch', '--format=%(refname:short)'])); } catch { return null; }
    };
    // Re-entry guard: disposition already retired means the action ran AND was recorded in a
    // prior turn (death before clear-gate) — never re-run the action, just resolve the gate.
    // The release contract is checked before a LANDING (merge / PR retirement). `keep` retires
    // nothing, so it is checked only when it answers a version_not_bumped gate this run opened —
    // proven by the durable record the gate writes, never by the bare word 'keep'.
    // The gate is scoped to the VERSION it named: a later, different tagged version opens its own,
    // and `keep` answers whichever one is currently standing.
    const latestVersionGate = () => [...parseEventArray(readEvents(ctx.absState))].reverse().find((e) => e.type === 'version_gate' && e.phase === 'pre_landing') ?? null;
    const versionGateOpen = () => latestVersionGate() !== null;
    if (!RETIRED.has(ctx.state.worktree_disposition) && (ctx.choice === 'merge' || ctx.choice === 'pr' || (ctx.choice === 'keep' && versionGateOpen()))) {
      // §7.1 release contract: a branch whose ${version} is already tagged (locally or on origin)
      // cannot be released — open version_not_bumped BEFORE the merge / PR retirement.
      // A retirement record for THIS choice proves the landing already happened (a crash replay):
      // the pre-landing guard ran before it and has nothing left to decide. Re-running it here would
      // offer `fix` on a branch that is already merged — a second landing the boundary audit would
      // then reject. The deploy base re-checks the release contract at the real landing.
      const landed = [...parseEventArray(readEvents(ctx.absState))].reverse().find((e) => (e.type === 'branch_finish' || e.type === 'branch_finish_intent') && e.note === ctx.choice);
      let vnb = landed ? null : versionNotBumped(ctx);
      // A gate opened earlier for this very version stands until it is answered: a deleted tag or an
      // unreachable origin is not the version bump the gate asked for.
      if (!landed && (!vnb || (!vnb.unverifiable && !vnb.where?.length))) {
        const evsNow = parseEventArray(readEvents(ctx.absState));
        const recorded = [...evsNow].reverse().find((e) => e.type === 'version_gate' && e.phase === 'pre_landing');
        if (recorded) {
          let current = null;
          try {
            const tip = runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`]).trim();
            const head = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
            const eff = effectiveMergeRev(ctx, head, tip);
            if (!eff.conflict) {
              let def = resolveDoneForBase(ctx, eff.rev);
              if (def === undefined && ctx.doneAdhocFile) def = JSON.parse(fs.readFileSync(ctx.doneAdhocFile, 'utf8'));
              if (def && def !== 'none' && def.version_from) current = versionAtRevision(ctx.MAIN, eff.rev, def.version_from);
            }
          } catch { current = null; }
          // Only an actual bump clears it; anything else (unreadable, unchanged) keeps it standing.
          if (current === null || current === recorded.version) vnb = { version: recorded.version, tag: recorded.tag, where: recorded.where, recorded: true };
        }
      }
      if (vnb && vnb.unverifiable) {
        return { op: 'ask', ask: 'dispatch-error', error: `${vnb.unverifiable} — the release guard fails closed before ${ctx.choice === 'pr' ? 'PR retirement' : 'the merge'}` };
      }
      if (vnb && vnb.origin_unverified && vnb.where.length === 0) {
        return { op: 'ask', ask: 'dispatch-error', error: `cannot verify whether ${vnb.tag} already exists on origin (${vnb.origin_unverified}) — the release guard fails closed; retry when origin is reachable`, version: vnb.version, tag: vnb.tag };
      }
      if (vnb) {
        if (ctx.versionFix) return { op: 'stop', reason: 'version_fix', ...vnb, branch: ctx.branch };
        if (ctx.choice === 'keep') {
          const evs = parseEventArray(readEvents(ctx.absState));
          if (!evs.some((e) => e.type === 'incomplete_authorized' && e.reason === 'version_not_bumped')) {
            appendEvent(ctx.absState, { type: 'incomplete_authorized', ts: ctx.ts, reason: 'version_not_bumped', ...vnb });
          }
        } else {
          // Durable: a `keep` in a later turn is the answer to THIS gate, not an ordinary retention.
          const prior = latestVersionGate();
          if (!prior || prior.version !== vnb.version) appendEvent(ctx.absState, { type: 'version_gate', ts: ctx.ts, phase: 'pre_landing', ...vnb });
          return { op: 'ask', ask: 'gate', gate: 'version_not_bumped', ...vnb, choices: ['fix', 'keep'] };
        }
      }
    }
    if (!RETIRED.has(ctx.state.worktree_disposition)) {
      // The branch tip at retirement is the durable identity the deploy base is later proven against
      // (§7.3): captured BEFORE the merge and the branch deletion that follow.
      let branchTipAtRetire = null;
      try { branchTipAtRetire = runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`]).trim() || null; } catch { branchTipAtRetire = null; }
      let mergeShaAtRetire = null;
      if (ctx.choice === 'pr' && !ctx.pushed) {
        // Phase 1 of the pr handshake: NOTHING durable changes — the gate stays open so a death
        // before the push re-renders branch_finish instead of silently archiving with no PR
        // (Codex r5 P1). The shell pushes/opens the PR, then re-calls --choice=pr --pushed.
        return { op: 'shell', kind: 'push_pr', branch: ctx.branch, base: detectedBase(), wt: ctx.WT };
      }
      const branchExists = () => {
        try { runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`]); return true; } catch { return false; }
      };
      // A replay reads its own intent record: the tip when the branch is already gone, and — always —
      // the landing the first attempt recorded. Re-deriving the landing from HEAD would move it past
      // commits that landed after the merge, laundering them into the deploy base.
      let recordedLanding = null;
      {
        const intents = parseEventArray(readEvents(ctx.absState)).filter((e) => e.type === 'branch_finish_intent');
        const intent = intents[intents.length - 1];
        if (intent && intent.note === ctx.choice) {
          if (!branchTipAtRetire) branchTipAtRetire = intent.branch_tip ?? null;
          if (typeof intent.merge_sha === 'string') recordedLanding = intent.merge_sha;
        }
      }
      // The landing on the base's first-parent line: the tip itself when the merge fast-forwarded,
      // else the commit that merged it (the tip is one of its non-first parents). Used by every
      // replay — the merge already happened, so HEAD (which may have moved on since) is never it.
      const recoverLanding = (tip) => {
        const lines = runGit(ctx.MAIN, ['rev-list', '--first-parent', '--parents', '-n', '500', 'HEAD']).trim().split('\n').map((l) => l.split(/\s+/));
        if (lines.some((p) => p[0] === tip)) return tip;
        const landing = lines.find((p) => p.slice(2).includes(tip));
        return landing ? landing[0] : null;
      };
      const alreadyLanded = (tip) => { try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', tip, 'HEAD']); return true; } catch { return false; } };
      if (ctx.choice === 'merge' && !fs.existsSync(ctx.WT) && !branchExists()) {
        // The full-teardown replay: the prior merge landed (the post-merge `-d` is the sole branch
        // deleter). No tip, no landing → the historical relaxed path.
        if (branchTipAtRetire) {
          mergeShaAtRetire = recoverLanding(branchTipAtRetire);
          if (!mergeShaAtRetire) return { op: 'ask', ask: 'dispatch-error', error: `replay of --choice=merge: the branch ${ctx.branch} is gone but no commit on the base's first-parent line carries its recorded tip ${branchTipAtRetire.slice(0, 12)}` };
        }
      } else if (ctx.choice === 'merge' && branchTipAtRetire && alreadyLanded(branchTipAtRetire)) {
        // A replay whose branch still exists: the merge already landed (a re-run would report
        // "already up to date" and HEAD may have moved on since). Recover the real landing —
        // taking HEAD would launder every commit that landed after it into the deploy base.
        mergeShaAtRetire = recoverLanding(branchTipAtRetire);
        if (!mergeShaAtRetire) return { op: 'ask', ask: 'dispatch-error', error: `replay of --choice=merge: ${ctx.branch}'s tip ${branchTipAtRetire.slice(0, 12)} is already in the base but no commit on its first-parent line carries it` };
      }
      if (ctx.choice === 'merge' && !mergeShaAtRetire && !(!fs.existsSync(ctx.WT) && !branchExists())) {
        // Skipped only on the full-teardown crash replay: branch-gone + WT-gone proves the
        // prior merge landed (the post-merge `-d` is the sole branch deleter), so re-merging
        // a deleted ref would strand the run on dispatch-error (Codex r6 P2). Otherwise:
        // The merge lands on whatever MAIN has checked out — require that to BE the base the
        // gate advertised, never a silent merge into an unrelated branch (Codex r5 P2).
        const base = detectedBase();
        const mainHead = runGit(ctx.MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (!base || mainHead !== base) {
          return {
            op: 'ask', ask: 'dispatch-error',
            error: `merge target mismatch: MAIN has '${mainHead}' checked out but the detected base is '${base ?? 'unknown'}' — switch MAIN to the base branch (or resolve manually) and re-issue --choice=merge`,
          };
        }
        try {
          runGit(ctx.MAIN, ['merge', '--no-edit', ctx.branch]);
        } catch (e) {
          try { runGit(ctx.MAIN, ['merge', '--abort']); } catch { /* nothing to abort */ }
          return { op: 'ask', ask: 'dispatch-error', error: `merge of ${ctx.branch} into ${base} failed: ${e.message}` };
        }
        mergeShaAtRetire = recordedLanding ?? runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
      }
      if (recordedLanding) mergeShaAtRetire = recordedLanding;
      // Retirement intent: the branch identity is durable BEFORE the destructive teardown (worktree
      // removal, branch deletion) that follows (§7.3), so a death anywhere in it replays with the tip
      // in hand. It lands after the merge — a merge that conflicts aborts with a clean MAIN and an
      // untouched ledger — and the merge itself is replay-safe while the branch still exists.
      {
        const intents = parseEventArray(readEvents(ctx.absState)).filter((e) => e.type === 'branch_finish_intent');
        const intent = intents[intents.length - 1];
        if (branchTipAtRetire && !(intent && intent.note === ctx.choice && intent.branch_tip === branchTipAtRetire)) {
          appendEvent(ctx.absState, { type: 'branch_finish_intent', ts: ctx.ts, note: ctx.choice, branch_tip: branchTipAtRetire, ...(mergeShaAtRetire ? { merge_sha: mergeShaAtRetire } : {}) });
        }
      }
      let removalConfirmed = false;
      if (ctx.choice === 'merge' || ctx.choice === 'discard') {
        if (!fs.existsSync(ctx.WT)) {
          // A replay after a crash between removal and the disposition write: the path being
          // gone IS the confirmation — prune the dangling admin entry and retire (Codex r5 P2).
          try { runGit(ctx.MAIN, ['worktree', 'prune']); } catch { /* best-effort */ }
          removalConfirmed = true;
        } else {
          const args = ['worktree', 'remove'];
          if (ctx.choice === 'discard' || ctx.removalForce) args.push('--force');
          try {
            runGit(ctx.MAIN, [...args, ctx.WT]);
            removalConfirmed = true;
          } catch {
            removalConfirmed = false; // disposition stays active → reaped by the next sweep
          }
        }
        if (removalConfirmed) {
          // branch retire is best-effort: -d after merge (proven merged), -D on discard
          try { runGit(ctx.MAIN, ['branch', ctx.choice === 'discard' ? '-D' : '-d', ctx.branch]); } catch { /* leave it */ }
        }
      }
      // The identity record lands BEFORE the disposition (§7.3): a death between the two leaves a
      // replayable gate that already holds its record, never a retired state without one. A replay
      // that finds its own record (same choice; same tip, or a tip the first attempt already
      // deleted) does not write a second.
      const finishes = parseEventArray(readEvents(ctx.absState)).filter((e) => e.type === 'branch_finish');
      const last = finishes[finishes.length - 1];
      const replayed = !!last && last.note === ctx.choice && (!branchTipAtRetire || last.branch_tip === branchTipAtRetire);
      if (!replayed) appendEvent(ctx.absState, { type: 'branch_finish', ts: ctx.ts, note: ctx.choice, ...(branchTipAtRetire ? { branch_tip: branchTipAtRetire } : {}), ...(mergeShaAtRetire ? { merge_sha: mergeShaAtRetire } : {}) });
      // §7.4: keep and discard are the operator's own "not done" decisions and never satisfy
      // Outcome 3. The authorization is written HERE, transactionally with the disposition, so
      // the completion class derives from a durable ledger record and the archive is refused if
      // it ever goes missing — never inferred from the bare word `keep`/`discard`.
      if (ctx.choice === 'keep' || ctx.choice === 'discard') {
        const reason = ctx.choice === 'keep' ? 'kept' : 'discarded';
        const evsNow = parseEventArray(readEvents(ctx.absState));
        // A `keep` answering a version_not_bumped gate has ALREADY written its authorization
        // (reason version_not_bumped) earlier in this handler — the completion class must name
        // the gate it answered, not the bare retention, so no second reason is written.
        const answeredVersionGate = ctx.choice === 'keep' && evsNow.some((e) => e.type === 'incomplete_authorized' && e.reason === 'version_not_bumped');
        if (!answeredVersionGate && !evsNow.some((e) => e.type === 'incomplete_authorized' && e.reason === reason)) {
          appendEvent(ctx.absState, {
            type: 'incomplete_authorized', ts: ctx.ts, reason,
            ...(branchTipAtRetire ? { branch_tip: branchTipAtRetire } : {}),
            head_after: runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim(),
          });
        }
      }
      const disp = dispositionAfterTeardown(ctx.choice, removalConfirmed);
      if (disp !== null) ctx.state = setWorktreeDisposition(ctx.state, disp);
      writeState(ctx.absState, ctx.state);
    }
    ctx.state = clearGate(ctx.state);
    writeState(ctx.absState, ctx.state);
    commitBundle(ctx.MAIN, ctx.bundleDir, `masterplan(${ctx.slug}): branch_finish resolved (${ctx.choice})`);
    if (!RETIRED.has(ctx.state.worktree_disposition)) {
      // merge/discard whose worktree removal failed: nothing is lost, but the run cannot
      // retire — surface it rather than silently re-opening the same gate.
      return {
        op: 'ask', ask: 'dispatch-error',
        error: `worktree removal failed for ${ctx.WT} — disposition stays 'active'; remove it (or re-run with --removal-force) and re-enter finish`,
      };
    }
    // fall through to the archive shortcut below
  }
  return null;
}

// The incomplete_authorized reasons that TERMINATE the deploy stage: once one is recorded the
// run is bound for an incomplete archive, and neither the stage nor the final assessment has
// anything left to ask. Defined once — the stage evaluator and the final assessment must agree
// on what "resolved" means, or one of them deadlocks the other.
const STAGE_TERMINAL = new Set(['no_definition_of_done', 'deploy_abort', 'version_not_bumped', 'kept', 'discarded', 'attested']);
// §7.5: an intent rejection names WHY the deployed result was rejected. `intent` means the goal
// was misunderstood — its reason becomes the successor interview's correction; `implementation`
// means the build was wrong, which corrects nothing about the goal.
const INTENT_REJECTION_CLASSES = new Set(['intent', 'implementation']);

// An abort or skip may qualify its reason (`deploy_abort:digest_missing`, `deploy_skip:live_check[0]`,
// `intent_rejected:intent`) so the archive class names the cause. The prefix is what makes it
// terminal; matching on the bare set alone would miss every qualified form.
function isStageTerminalReason(reason) {
  const r = String(reason ?? '');
  if (STAGE_TERMINAL.has(r)) return true;
  // A waived intent is terminal too: the operator has accepted a partial or missed result, and
  // the run archives incomplete on that authorization rather than re-asking.
  if (r === 'intent_waived') return true;
  return ['deploy_skip:', 'deploy_abort:', 'intent_rejected:'].some((p) => r.startsWith(p));
}

// §7.4 completion-class derivation at archive. The class comes from the LEDGER, never from the
// bare disposition or a guessed `complete`: an archive is `complete` only when the operator
// confirmed the deployed intent, `merged` only for a `done: none` deployment (which has no
// intent to confirm — the absence of deploy evidence IS the distinction), `incomplete:<reason>`
// only when a stage-terminal authorization was recorded, and otherwise `null` (legacy — no
// completion field written, every pre-v10 archive).
//
// Order matters and is deliberate:
//   1. A stage-terminal `incomplete_authorized` wins over everything — the latest terminal reason
//      names the cause (intent_rejected:<class>, deploy_skip:<g>[<i>], deploy_abort:<gate>, …).
//   2. An attested mandatory step archives `incomplete:attested` even after `completion_confirmed`
//      (§7.2/§11 S3): a signed "did not happen" record never becomes `complete` because the
//      operator later confirmed intent.
//   3. A `done: none` deployment is `merged`, never `complete`: nothing was deployed, so there
//      is no intent to confirm — and it is never `legacy` either, because the run did complete
//      its own work (verify + retro + merge).
//   4. `complete` is only for a deployed, confirmed run.
// Returns the completion string to write, or null to leave the field absent (legacy).
function deriveCompletionClass(ctx, events) {
  const evs = events ?? parseEventArray(readEvents(ctx.absState));
  // 1. The latest stage-terminal authorization, in ledger order.
  const terminal = evs.filter((e) => e.type === 'incomplete_authorized' && isStageTerminalReason(e.reason));
  if (terminal.length) {
    return `incomplete:${terminal[terminal.length - 1].reason}`;
  }
  // 2. An attested mandatory step never archives complete, whatever the confirmation state.
  if (evs.some((e) => e.type === 'deploy_step' && e.status === 'attested')) {
    return 'incomplete:attested';
  }
  const base = [...evs].reverse().find((e) => e.type === 'deploy_base'); // LATEST base (adversary r1 finding 5)
  const isNone = base && base.done_sha256 && base.done_sha256 === doneDigest('none');
  // 3. done: none → merged, without needing a confirmation (there is no intent to confirm).
  if (isNone) return 'merged';
  // 4. complete needs a confirmation BOUND TO THE LATEST base. A stale or wrong-base confirmation
  //    (a receipt for an earlier deployment) must not authorize a `complete` archive of a run whose
  //    latest deployment was never confirmed (adversary r1 finding 5).
  const confirmations = evs.filter((e) => e.type === 'completion_confirmed');
  if (confirmations.some((c) => c.deploy_base_sha === (base ? base.sha : null))) return 'complete';
  // A deployed run that never confirmed and never failed is a pre-v10 legacy shape.
  return null;
}

// ---- the post-deploy final assessment (§6.2 final mode, §7.3) -----------------
//
// The deploy chain and the live-check digest are what a final verdict is bound to: they name
// the deployment being judged. `done: none` deploys nothing, so its chain is empty and its
// live digest is null — stated explicitly rather than left undefined, because "no live check"
// and "a live check nobody recorded" must not look the same.
function finalAssessmentInputs(ctx, deployBaseSha, def) {
  const evs = parseEventArray(readEvents(ctx.absState));
  if (def === 'none' || def === undefined) {
    return { chain: [], chainHash: deployChainHash([]), liveDigest: null };
  }
  // The chain is this base's deploy_step receipts, in the order they were recorded.
  // Every deployment-relevant field of each receipt, not just its status skeleton: two
  // releases that exited 0 at the same index but produced different evidence, different
  // commits or a different resulting head are DIFFERENT deployments, and a chain hash that
  // cannot tell them apart cannot bind a verdict to one of them. `ts` is excluded on purpose —
  // it is not semantic, and including it would make the hash unreproducible on replay.
  const chain = evs
    .filter((e) => e.type === 'deploy_step' && e.sha === deployBaseSha)
    .map((e) => ({
      group: e.group,
      index: e.index,
      status: e.status,
      exit: e.exit ?? null,
      check_exit: e.check_exit ?? null,
      digest: e.digest ?? null,
      commits: e.commits ?? null,
      head_after: e.head_after ?? null,
    }));
  // The live check's own digest: the evidence that the deployed thing answers. A live_check
  // group with no recorded digest yields null, which the gate treats as missing evidence.
  const live = [...evs].reverse().find((e) => e.type === 'deploy_step' && e.sha === deployBaseSha && e.group === 'live_check');
  // The evidence FILE, alongside its digest: --digest-file now names a file to hash, so an
  // operation that emitted only the digest would advertise a recorder command nobody can run
  // (`--digest-file=sha256:…` is not a path). Re-entry in a fresh process has nothing else to
  // go on, so the path has to be durable on the receipt.
  // The ingested evidence, resolved against the bundle and RE-VERIFIED: a stored artifact that
  // no longer hashes to the recorded digest is not the evidence this verdict binds to, and
  // handing the assessor a command over changed bytes would produce a receipt that can never
  // bind back.
  let liveDigestPath = null;
  if (live?.digest_path) {
    const abs = path.resolve(ctx.bundleDir, live.digest_path);
    try {
      if (liveCheckDigest(abs) === live.digest) liveDigestPath = abs;
    } catch { liveDigestPath = null; }
  }
  return {
    chain,
    chainHash: deployChainHash(chain),
    liveDigest: live?.digest ?? null,
    liveDigestPath,
  };
}

// The durable §6.1 format pin for a bundle's goals.md — the pin selects the
// canonicalizer, and every goals_hash the finish surfaces computes under it (the same
// seam record-goal-check uses; hashing unpinned here would re-derive a legacy hash on
// a schema-backed bundle and mark every recorded check stale).
function pinnedGoalsHashOf(statePath, goalsMd) {
  let pin = resolveFormatPin(statePath);
  if (!pin.pin && pin.repairable) {
    // §6.1's sanctioned repair, idempotent and writes only the pin — the same repair
    // buildIntentIdentity performs; refusing here would deadlock a capture that is
    // otherwise complete.
    try { repairFormatPin(statePath); } catch { /* fall through to the refusal below */ }
    pin = resolveFormatPin(statePath);
  }
  if (!pin.pin) {
    throw new Error(pin.repairable ? 'the durable format pin is missing on this bundle (repairable from the capture history)' : (pin.error ?? 'the durable format pin could not be resolved'));
  }
  return goalsHash(goalsMd, { formatPin: pin.pin });
}

// A receipt's identity: the canonical hash of the recorded event data. It is what binds an open
// gate to the assessment the operator was actually shown, so a later receipt cannot be confirmed
// in its place.
function receiptIdentity(event) {
  return `sha256:${createHash('sha256').update(stableJson(event?.data ?? null)).digest('hex')}`;
}

// Deterministic JSON: key order must not change an identity.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

// The final goal_check receipt for THIS deployment, if one has been recorded. It is matched on
// the full binding tuple: a receipt bound to another base, chain or live digest is a receipt
// about a different deployment.
//
// Returns {kind:'none'} when no candidate is bound to this deployment, {kind:'ok', event} when
// one is bound AND valid, and {kind:'invalid', error} when one is bound but its shape is not a
// valid final assessment. The three are kept distinct because collapsing `invalid` into `none`
// makes a malformed receipt indistinguishable from an unrecorded one — the machine would ask
// for the assessment again, forever, and never say why.
function finalReceiptFor(ctx, { deployBaseSha, chainHash, liveDigest }) {
  const evs = parseEventArray(readEvents(ctx.absState));
  const goalsMd = (() => {
    try { return fs.readFileSync(path.join(ctx.bundleDir, 'goals.md'), 'utf8'); } catch { return null; }
  })();
  const parsed = goalsMd ? parseGoals(goalsMd) : { goals: [] };
  // Derived from the CURRENT goals document, never from the candidate: a receipt supplying its
  // own expected hash validates its own claim, and an assessment made against a goals.md that
  // has since been amended is stale however well-formed it looks. Hashed under the DURABLE
  // format pin (§6.1) — the same seam record-goal-check and every checkpoint use — and when
  // the pin cannot be established there is no hash to expect, so no candidate can validate:
  // the surface reports the unestablishable state instead of quietly comparing against a
  // legacy hash.
  let expectedGoalsHash = null;
  if (goalsMd) {
    try {
      expectedGoalsHash = pinnedGoalsHashOf(ctx.absState, goalsMd);
    } catch (e) {
      return { kind: 'invalid', error: `the current goals hash could not be established under the durable format pin (${e.message}) — a final assessment cannot be re-validated against a hash that cannot be derived` };
    }
  }
  // The implementation assessment is the independent source for the branch-state bindings.
  // It was validated against real git facts when it was recorded, so binding the final receipt
  // to ITS values checks the final receipt against something outside itself.
  const impl = [...evs].reverse().find((e) => e.type === 'goal_check' && e.data && e.data.final !== true) ?? null;
  // No implementation receipt means there is nothing INDEPENDENT to check the final receipt's
  // branch bindings against. Passing undefined expectations to the validator would leave those
  // fields unconstrained — the self-validation this whole function exists to stop — so the
  // absence is itself a refusal, not an empty set of expectations.
  if (!impl) {
    return { kind: 'invalid', error: 'no implementation goal_check receipt to bind the final assessment against — the final receipt would validate its own branch bindings' };
  }
  let invalid = null;
  for (const e of [...evs].reverse()) {
    if (e.type !== 'goal_check' || !e.data || e.data.final !== true) continue;
    if (e.data.deploy_base_sha !== deployBaseSha) continue;
    if (e.data.deploy_chain_hash !== chainHash) continue;
    // An OMITTED live digest is not the same as an explicit null: only a receipt that carries
    // the field, matching the deployment's, is bound to it.
    if (!Object.prototype.hasOwnProperty.call(e.data, 'live_check_digest')) continue;
    if (e.data.live_check_digest !== liveDigest) continue;
    // The shape is the SIBLING validator's to judge (§6.2 / task 14). Every field is passed
    // through EXACTLY as recorded — no `?? 'recorded'` defaults, no `!== false` coercion. A
    // receipt with no provenance or no `clean` is not a receipt with default provenance and a
    // clean tree; it is an invalid receipt, and repairing it here would validate a claim
    // nobody made.
    const prov = e.data.provenance ?? {};
    const v = validateGoalCheckReceipt(
      {
        goals_hash: e.data.goals_hash,
        head_sha: e.data.head_sha,
        base_diff_hash: e.data.base_diff_hash ?? e.data.diff_hash,
        verify_output_hash: e.data.verify_output_hash,
        clean: e.data.clean,
        verdicts: e.data.verdicts,
        deploy_base_sha: e.data.deploy_base_sha,
        deploy_chain_hash: e.data.deploy_chain_hash,
        live_check_digest: e.data.live_check_digest,
        intent_verdict: e.data.intent_verdict,
        ts: e.data.ts ?? e.ts,
        // ONLY the two supported kinds are mapped. Treating everything-that-is-not-`user` as
        // assessor provenance silently repairs a malformed or future-schema discriminator into
        // a shape the validator accepts — which is the fabrication this function was rewritten
        // to remove. An unknown kind falls through to no provenance at all, and the validator
        // refuses it.
        ...(e.data.provenance_kind === 'user'
          ? { attested_by: 'user', approval_receipt: e.data.approval_receipt }
          : e.data.provenance_kind === 'assessor'
            ? { dispatch_id: prov.dispatch_id, model: prov.model, output_tokens: prov.output_tokens }
            : {}),
      },
      {
        goalsHash: expectedGoalsHash,
        headSha: impl?.data?.head_sha,
        baseDiffHash: impl?.data?.base_diff_hash ?? impl?.data?.diff_hash,
        verifyOutputHash: impl?.data?.verify_output_hash,
        clean: true,
        goals: parsed.goals ?? [],
        final: true,
        deployBaseSha,
        deployChainHash: chainHash,
        liveCheckDigest: liveDigest,
      },
    );
    if (v.ok) {
      // The §5.5 identity binding, RE-VALIDATED at selection (task 56): the sibling
      // validator above judges the receipt's branch/deploy shape; this judges the run
      // state it claims to have judged under. The bundle's CURRENT finish identity is
      // composed from the bundle alone (never from the candidate), and the recorded
      // receipt's own `intent_identity` + provenance are compared against it — a
      // receipt that crossed an identity boundary (an amended goals.md, a drifted
      // reconciliation, a replaced skill identity, a foreign LEGACY tuple) is
      // INVALID here, never selectable: the same rule the recorder enforced at record
      // time, applied to the ledger a replay trusts. The receipt handed to the
      // identity verifier is the recorded event's OWN shape — its intent_identity and
      // its provenance, exactly as written — so the check reads the ledger, not a
      // projection of it.
      const finIdentity = finishCheckpointIdentity({ statePath: ctx.absState, skillRoot: ctx.skillRoot });
      if (!finIdentity.ok) {
        const err = `the finish checkpoint's intent identity could not be established — ${finIdentity.reason}`;
        if (!invalid) invalid = { kind: 'invalid', error: err, event: e };
      } else {
        // The FULL finish tuple, composed from the deployment this selection is for —
        // the same members the sibling validator judged — so the identity check runs
        // the whole checkpoint, not just its identity half.
        const iv = verifyCheckpointEvidence({
          checkpoint: 'finish',
          receipt: {
            deploy_base_sha: e.data.deploy_base_sha,
            deploy_chain_hash: e.data.deploy_chain_hash,
            live_check_digest: e.data.live_check_digest,
            ...(e.data.intent_identity !== undefined ? { intent_identity: e.data.intent_identity } : {}),
            ...(e.data.provenance_kind === 'user'
              ? { attested_by: 'user', purpose: e.data.approval_receipt?.purpose }
              : {
                  dispatch_id: e.data.provenance?.dispatch_id,
                  model: e.data.provenance?.model,
                  output_tokens: e.data.provenance?.output_tokens,
                }),
          },
          current: { ok: true, family: finIdentity.family, identity: finIdentity.intent_identity },
          finishTuple: { ok: true, tuple: { deploy_base_sha: deployBaseSha, deploy_chain_hash: chainHash, live_check_digest: liveDigest } },
          goalsArtifactDigest: finIdentity.goals_artifact_digest,
        });
        if (!iv.ok) {
          const err = `the final receipt does not verify against the current finish checkpoint identity — [${iv.status}] ${iv.reason}`;
          if (!invalid) invalid = { kind: 'invalid', error: err, event: e };
        } else {
          return { kind: 'ok', event: e };
        }
      }
    } else if (!invalid) {
      // Keep the NEWEST bound-but-invalid candidate so the operator is told what is wrong with
      // the receipt they actually recorded.
      invalid = { kind: 'invalid', error: v.error, event: e };
    }
  }
  return invalid ?? { kind: 'none' };
}

function evaluateFinalAssessment(ctx) {
  // The final assessment judges the run's INTENT against what was deployed, so it applies only
  // to a bundle that declared goals. A run with none has no intent statement to judge, and the
  // deploy stage's own receipts are its whole record.
  if (!goalsEnabledFor(ctx.state, ctx.events)) return null;
  const evs = parseEventArray(readEvents(ctx.absState));
  const base = evs.find((e) => e.type === 'deploy_base');
  if (!base) return null; // no deploy stage ran on this bundle
  if (evs.some((e) => e.type === 'completion_confirmed')) return null; // already answered
  // A stage the operator ABORTED or SKIPPED out of is already bound for an incomplete archive
  // (§7.2). Intercepting it here with a live-evidence gate would deadlock exactly the runs
  // whose whole point is that they did not finish deploying: an incomplete run owes no intent
  // verdict, and its authorization already records why.
  if (evs.some((e) => e.type === 'incomplete_authorized' && isStageTerminalReason(e.reason))) {
    return null;
  }
  const def = resolveBoundDone(ctx, base);
  const inputs = finalAssessmentInputs(ctx, base.sha, def);

  // `done: none` deploys NOTHING: there is no deployment to assess and no live evidence to bind
  // a verdict to, so no final assessment is issued. Such a run archives `merged` (§7.1) — never
  // `complete` — so nothing here is being waved through: the class already says what happened.
  if (def === 'none' || def === undefined) return null;

  // A deployed run's final verdict is bound to its live evidence. A definition that declares a
  // live_check but recorded no digest has NOT produced that evidence, and issuing the
  // assessment anyway would bind a verdict to nothing.
  const declaresLiveCheck = Array.isArray(def.live_check) && def.live_check.length > 0;
  if (!declaresLiveCheck || !inputs.liveDigest) {
    // Two distinct causes, one gate. Both are dead ends for a `complete` archive: §7.1 makes
    // live evidence the thing a final verdict binds to, and there is none. The gate is DURABLE
    // — a fresh process must find it in pending_gate rather than re-deriving an unanswerable
    // op — and `abort` is the only answer offered, because it is the only one the machine can
    // actually execute from here: the live step is already recorded `done`, so there is no
    // failed step for a retry to re-run. Aborting archives the run incomplete, which is the
    // honest class for a deployment that produced no evidence.
    const cause = declaresLiveCheck ? 'digest_missing' : 'no_live_check_group';
    const reason = declaresLiveCheck
      ? 'the live_check step recorded no digest — the final assessment binds its verdict to that evidence, and there is none to bind'
      : 'this done: block declares no live_check group — a deployed run needs live evidence before its intent can be assessed (§7.1)';
    if (ctx.state.pending_gate?.id !== 'live_check_evidence_missing') {
      ctx.state = openGate(ctx.state, { id: 'live_check_evidence_missing', opened_at: ctx.ts, cause });
      writeState(ctx.absState, ctx.state);
    }
    return {
      op: 'ask', ask: 'gate', gate: 'live_check_evidence_missing',
      deploy_base_sha: base.sha,
      cause,
      reason,
      choices: ['abort'],
    };
  }

  const found = finalReceiptFor(ctx, { deployBaseSha: base.sha, ...inputs });
  if (found.kind === 'invalid') {
    // Bound to this deployment but not a valid assessment. Surfaced as its own gate rather
    // than re-requesting the check: re-requesting would loop forever on a receipt the operator
    // already recorded, never saying what is wrong with it.
    if (ctx.state.pending_gate?.id !== 'final_check_invalid') {
      ctx.state = openGate(ctx.state, { id: 'final_check_invalid', opened_at: ctx.ts });
      writeState(ctx.absState, ctx.state);
    }
    return {
      op: 'ask', ask: 'gate', gate: 'final_check_invalid',
      deploy_base_sha: base.sha,
      error: found.error,
      reason: `a final assessment bound to this deployment was recorded, but it is not valid: ${found.error}`,
      // `re-record` is not a flag to submit — it is the act of recording a valid receipt, which
      // the machine then picks up on re-entry. So the gate carries EVERY input a replacement
      // needs, including a runnable command: a fresh process holding only an error string
      // could not produce one, which is what made this an advertised-but-unexecutable choice.
      deploy_chain: inputs.chain,
      deploy_chain_hash: inputs.chainHash,
      live_digest: inputs.liveDigest,
      live_digest_path: inputs.liveDigestPath,
      goals_path: path.join(ctx.bundleDir, 'goals.md'),
      next: `mp record-goal-check --final --base-sha=${base.sha} --deploy-chain-hash=${inputs.chainHash} --digest-file=${inputs.liveDigestPath ?? '<the live check evidence file>'} --receipt=<a corrected receipt>`,
      choices: ['re-record', 'abort'],
    };
  }
  if (found.kind === 'none') {
    // The boundary is re-audited before the assessment: a base that moved since the stage
    // finished means the thing being assessed is not the thing that was deployed.
    assertDeployAuthorizable(ctx, base.sha, def);
    return {
      op: 'run_final_check',
      deploy_base_sha: base.sha,
      deploy_chain: inputs.chain,
      deploy_chain_hash: inputs.chainHash,
      live_digest: inputs.liveDigest,
      // The evidence FILE, not the digest: --digest-file hashes what it opens, so the command
      // below has to name a path a fresh process can actually read.
      live_digest_path: inputs.liveDigestPath,
      goals_path: path.join(ctx.bundleDir, 'goals.md'),
      next: `mp record-goal-check --final --base-sha=${base.sha} --deploy-chain-hash=${inputs.chainHash} --digest-file=${inputs.liveDigestPath ?? '<the live check evidence file>'} --receipt=<receipt>`,
    };
  }
  const receipt = found.event;

  const verdict = receipt.data?.intent_verdict?.verdict ?? null;
  if (verdict !== 'met') {
    // A partial or missed INTENT verdict after the deployment is live. `fix` is not offered:
    // the worktree is gone, so there is nothing left to fix in place (§6.2). What remains is
    // to waive, to abort, or to reject the intent and name a successor. The answers themselves
    // are executed in applyShellAnswers; this only renders the gate when one is outstanding.
    if (ctx.state.pending_gate?.id !== 'goals_unmet') {
      ctx.state = openGate(ctx.state, { id: 'goals_unmet', opened_at: ctx.ts, mode: 'final' });
      writeState(ctx.absState, ctx.state);
    }
    return {
      op: 'ask', ask: 'gate', gate: 'goals_unmet', mode: 'final',
      deploy_base_sha: base.sha,
      intent_verdict: receipt.data?.intent_verdict ?? null,
      live_check_digest: inputs.liveDigest,
      // No `fix`: post-live there is no worktree to fix in.
      choices: ['waiver', 'abort', 'reject-intent'],
      reason: `the final assessment returned intent ${verdict ?? 'unknown'} — the deployment is live, so fix is not on offer`,
    };
  }

  // Re-audited again here: the operator is about to confirm THIS deployment, and a base that
  // moved between the assessment and the confirmation is a different one.
  assertDeployAuthorizable(ctx, base.sha, def);
  // The gate names the EXACT receipt whose evidence the operator is being shown. Without it the
  // confirmation would later re-select "the newest valid receipt", which is not necessarily the
  // one on screen — a `partial` receipt appended while the durable gate sat open would be
  // confirmed as though the operator had agreed to it.
  const receiptId = receiptIdentity(receipt);
  if (ctx.state.pending_gate?.id !== 'intent_confirm' || ctx.state.pending_gate?.receipt !== receiptId) {
    ctx.state = openGate(ctx.state, { id: 'intent_confirm', opened_at: ctx.ts, receipt: receiptId });
    writeState(ctx.absState, ctx.state);
  }
  return {
    op: 'ask', ask: 'gate', gate: 'intent_confirm',
    outcome: receipt.data?.intent_verdict?.evidence ?? null,
    intent_verdict: receipt.data?.intent_verdict ?? null,
    live_check_digest: inputs.liveDigest,
    deploy_base_sha: base.sha,
    choices: ['confirmed', 'rejected'],
  };
}

// The §7.2 post-archive push gate. Emitted only when an install-group receipt PROVED it pushed
// the base (the producer stamped `pushed_base` on the receipt) AND the archive push decision is
// still outstanding — no archive_pushed, no archive_push_skipped. Re-entry on an archived bundle
// without either event re-emits the gate. The gate ALWAYS halts (operator approval) under gated
// and loose autonomy alike, and lists exactly `pushed_base..HEAD` (the archive commit and any
// gate commits since — the only history past the sha the install push carried). A repo with no
// done block, done: none, or an install chain that never moved the remote has no pushed_base and
// stops without a push gate.
//
// Returns the gate ask, or null when no push gate applies (the caller returns the plain archived
// stop). Opens the durable gate itself when one is outstanding.
function evaluatePushArchive(ctx) {
  const evs = parseEventArray(readEvents(ctx.absState));
  if (evs.some((e) => e.type === 'archive_pushed' || e.type === 'archive_push_skipped')) return null;
  const base = [...evs].reverse().find((e) => e.type === 'deploy_base');
  if (!base) return null;
  // The LATEST install receipt at this deploy base — whether or not it carried a pushed_base.
  // A later install step that moved the remote again would be a different pushed_base; the
  // newest one is what HEAD must be fast-forwarded past.
  const install = [...evs].reverse().find(
    (e) => e.type === 'deploy_step' && e.group === 'install' && e.sha === base.sha,
  );
  if (!install) return null;
  const baseBranch = detectBase(runGit(ctx.MAIN, ['branch', '--format=%(refname:short)'])) ?? 'main';

  // Adversary r1 finding 1: an INDETERMINATE push probe (the producer's fetch failed, so we
  // never learned whether the install push landed) must NOT degrade to a plain archived stop
  // (`pushed: no`). Re-probe the remote: if it now confirms, open the gate; if it confirms
  // NOT-pushed, stop plainly; if still indeterminate, halt with a retry ask.
  // Adversary r1 finding 1: the install's pushed_base may be ABSENT because the producer's
  // probe was INDETERMINATE (a network blip, not a confirmed non-push). That must not degrade
  // to a plain archived stop (`pushed: no`). Re-probe the remote here: if it now confirms the
  // push, adopt the probe's head_after as the pushed_base (the install receipt never got it);
  // if it confirms NOT-pushed, a plain stop is honest; if still indeterminate, halt with a
  // retry ask. `probePushedBase` is the effective pushed_base for the gate, or null.
  let probePushedBase = install.pushed_base ?? null;
  const probe = [...evs].reverse().find(
    (e) => e.type === 'push_probe' && e.group === 'install' && e.index === install.index && e.sha === base.sha,
  );
  if (probe && probe.status === 'indeterminate') {
    const re = reProbeRemotePush(ctx, baseBranch, install);
    if (re === 'pushed') {
      // The remote now carries the install head — the push is proven. Adopt the probe's
      // head_after (the install push carried exactly that sha) so the gate opens.
      probePushedBase = probePushedBase ?? (typeof install.head_after === 'string' ? install.head_after : null);
    } else if (re === 'indeterminate') {
      return {
        op: 'ask', ask: 'push-probe-indeterminate', group: install.index,
        sha: base.sha, head_after: install.head_after ?? null,
        reason: 'the install push could not be verified (the remote probe is indeterminate) — the run is NOT recorded as pushed: no',
        next: `re-run: mp finish-step --state=${ctx.statePath}  # re-probes origin/${baseBranch} before the archive stop`,
        wt: ctx.WT,
      };
    }
    // re === 'not-pushed': the remote fetch now succeeds and does not carry the install head —
    // a confirmed non-push, so a plain archived stop (no gate) is honest.
  }

  if (!probePushedBase) return null;
  const gate = ctx.state.pending_gate;
  if (gate?.id !== 'push_archive' || gate?.pushed_base !== probePushedBase) {
    ctx.state = openGate(ctx.state, { id: 'push_archive', opened_at: ctx.ts, pushed_base: probePushedBase });
    writeState(ctx.absState, ctx.state);
    // The gate state is committed here, so re-entry (which lands on the archived bundle and
    // commits any dirty bundle state) is stable: the offered range is "the archive commit and any
    // gate commits since" (§7.2) — a fixed, known history, not a range that grows one commit per
    // re-entry. The gate stays durable in state.pending_gate regardless.
    commitBundle(ctx.MAIN, ctx.bundleDir, `masterplan(${ctx.slug}): push_archive gate`);
  }
  const head = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
  // Adversary r1 finding 6: an explicit `merge-base --is-ancestor` check BEFORE listing the
  // range. `rev-list pushed_base..HEAD` succeeds even when the two have diverged, so a stale or
  // forged pushed_base would otherwise open a misleading gate listing a range that cannot be a
  // fast-forward. The invariant error is the surface, not a gate listing.
  let isAncestor = false;
  try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', probePushedBase, head]); isAncestor = true; } catch { isAncestor = false; }
  if (!isAncestor) {
    return {
      op: 'ask', ask: 'dispatch-error',
      error: `push_archive: install receipt's pushed_base ${probePushedBase.slice(0, 12)} is NOT an ancestor of MAIN HEAD ${head.slice(0, 12)} (diverged or forged) — the archive cannot be a fast-forward of the offered range`,
    };
  }
  const commits = runGit(ctx.MAIN, ['rev-list', '--reverse', '--first-parent', `${probePushedBase}..${head}`])
    .split('\n').filter(Boolean);
  return {
    op: 'ask', ask: 'gate', gate: 'push_archive',
    branch: baseBranch,
    sha: head,
    remote: 'origin',
    pushed_base: probePushedBase,
    commits,
    wt: ctx.WT,
    choices: ['push', 'skip'],
    next: `git -C ${ctx.MAIN} push origin ${baseBranch}  # then: finish-step --archive-pushed --sha=${head}`,
  };
}

// The --archive-pushed remote verification + non-fast-forward recovery (adversary r1 findings
// 4+5). The RECEIPT (the install receipt's pushed_base) is the trigger and the ANSWER is bound to
// the remote: this function FETCHES origin/<base>, verifies the remote actually carries the
// archive head, and only then returns the sha to record. Returns the sha that archive_pushed
// records (the supplied sha on a verified fast-forward push; the REBASED head when the lib
// recovered a non-fast-forward).
//
// Remote states after fetch:
//   - remote tip == sha           → verified fast-forward push; return sha.
//   - sha is an ancestor of tip   → the archive head is already on the remote (the operator
//                                  pushed it, then the remote moved past); still a verified push.
//   - tip is an ancestor of sha   → the remote does NOT carry the archive head — the operator
//                                  has not pushed it; REFUSE (finding 5: the push must land first).
//   - diverged (neither ancestor) → non-fast-forward: another host moved origin/<base>. Run the
//                                  real recovery (finding 4): audit every fetched commit, rebase
//                                  the local archive onto the remote tip, push once with one
//                                  retry, and return the rebased head. On audit refusal or push
//                                  failure, THROW with the surfaced reason (nothing recorded).
function verifyOrRecoverArchivePush(ctx, evs, baseBranch, sha, pushedBase) {
  const remoteTip = fetchRemoteTip(ctx, baseBranch);
  if (remoteTip === null) {
    throw new Error(`finish-step: --archive-pushed could not verify origin/${baseBranch} (fetch failed) — the push is NOT recorded; re-probe or push explicitly`);
  }
  const isAnc = (a, b) => { try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  if (remoteTip === sha) return sha;                       // verified: the operator pushed exactly the archive head
  if (isAnc(sha, remoteTip)) return sha;                   // verified: the archive head is on the remote (remote moved past it)
  if (isAnc(remoteTip, sha)) {
    throw new Error(`finish-step: --archive-pushed refused — origin/${baseBranch} (${remoteTip.slice(0, 12)}) does not carry the archive head ${sha.slice(0, 12)}; push the archive to origin/${baseBranch} first, then answer`);
  }
  // Diverged — another host moved origin/<base> past the archive head. Real recovery (finding 4):
  return recoverNonFastForwardPush(ctx, evs, baseBranch, sha, pushedBase);
}

// Fetch origin/<base> and return the remote tip sha, or null when the fetch/rev-parse fails
// (the remote is unreachable — verification is impossible, so the caller must NOT record).
function fetchRemoteTip(ctx, base) {
  try {
    runGit(ctx.MAIN, ['fetch', 'origin', base]);
    return runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).trim() || null;
  } catch {
    return null;
  }
}

// The non-fast-forward recovery: the remote tip diverged from the archive head. Audit every
// fetched commit (a fetched commit is acceptable iff its sha appears in the run's own ledger OR
// it is an ancestor of the local base — a foreign commit refuses), rebase the local archive
// onto the remote tip, push ONCE with ONE retry, and return the rebased head. Any failure
// (audit refusal, rebase conflict, exhausted push retries) THROWS with the surfaced reason, so
// nothing is recorded and the gate stays open.
function recoverNonFastForwardPush(ctx, evs, baseBranch, sha, pushedBase) {
  const head = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
  // Every commit on the remote that is not on local — the fetched commits to audit.
  let fetched = [];
  try {
    fetched = runGit(ctx.MAIN, ['rev-list', `${baseBranch}..refs/remotes/origin/${baseBranch}`])
      .split('\n').filter(Boolean);
  } catch {
    throw new Error('finish-step: --archive-pushed non-fast-forward recovery could not enumerate the fetched commits (origin/' + baseBranch + ' diverged)');
  }
  const ledgerShas = new Set();
  for (const e of evs) {
    for (const [k, v] of Object.entries(e ?? {})) {
      // Every sha-like field — including `head_after` (a push receipt/probe records the sha the
      // remote carried) and `branch_tip`/`merge_sha` — is a commit the run's own history knows.
      if ((k.includes('sha') || k === 'head_after' || k === 'branch_tip' || k === 'merge_sha')
        && typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)) ledgerShas.add(v);
    }
    if (e && typeof e.sha === 'string') ledgerShas.add(e.sha);
  }
  const localBase = pushedBase ?? baseBranch;
  const isKnown = (c) => {
    if (ledgerShas.has(c)) return true;
    try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', c, localBase]); return true; } catch { return false; }
  };
  for (const c of fetched) {
    if (!isKnown(c)) {
      throw new Error(`finish-step: --archive-pushed non-fast-forward recovery refused — fetched commit ${c.slice(0, 12)} is foreign (not in this run's ledger and not an ancestor of the local base); origin/${baseBranch} moved with history this run cannot attest. Stop; reconcile the remote manually.`);
    }
  }
  // The archive/gate state is committed before the rebase: MAIN must be clean for a rebase, and
  // any bundle write made since the gate opened (e.g. a probe receipt) is legitimate state that
  // belongs in the archive history, not a working-tree obstruction.
  try { commitBundle(ctx.MAIN, ctx.bundleDir, `masterplan(${ctx.slug}): archive push recovery`); } catch { /* nothing dirty */ }
  // Rebase the local archive commits onto the remote tip, then push ONCE with ONE retry. On a
  // rebase failure the working tree is left mid-conflict — abort to restore a clean MAIN before
  // surfacing the stop reason (the run stays archived, nothing recorded, gate re-emits).
  try {
    runGit(ctx.MAIN, ['rebase', `refs/remotes/origin/${baseBranch}`]);
  } catch (e) {
    try { runGit(ctx.MAIN, ['rebase', '--abort']); } catch { /* already clean or nothing to abort */ }
    throw new Error(`finish-step: --archive-pushed non-fast-forward recovery rebase failed — ${e.message.replace(/^.*failed: /, '')}`);
  }
  const newHead = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
  let pushed = false;
  for (const attempt of [1, 2]) {
    try {
      runGit(ctx.MAIN, ['push', '-q', 'origin', `${newHead}:refs/heads/${baseBranch}`]);
      pushed = true;
      break;
    } catch {
      if (attempt === 2) break; // exhausted the single retry
    }
  }
  if (!pushed) {
    throw new Error(`finish-step: --archive-pushed non-fast-forward recovery push failed (one retry exhausted) — origin/${baseBranch} did not accept ${newHead.slice(0, 12)}; the archive is NOT recorded as pushed`);
  }
  return newHead;
}

// Re-probe the remote after an indeterminate push probe (adversary r1 finding 1). Returns
// 'pushed' when origin/<base> now carries the install head_after, 'not-pushed' when the fetch
// succeeds but the remote does not carry it, and 'indeterminate' when the remote is still
// unreachable.
function reProbeRemotePush(ctx, base, install) {
  const headAfter = typeof install.head_after === 'string' ? install.head_after : null;
  let hasOrigin = false;
  try { runGit(ctx.MAIN, ['remote', 'get-url', 'origin']); hasOrigin = true; } catch { hasOrigin = false; }
  if (!hasOrigin) return 'not-pushed';
  try {
    runGit(ctx.MAIN, ['fetch', 'origin', base]);
    const remoteTip = runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).trim();
    if (headAfter && remoteTip === headAfter) return 'pushed';
    return 'not-pushed';
  } catch {
    return 'indeterminate';
  }
}

function evaluateFinishMachine(ctx) {
  // ---- C. evaluate the machine top-down (every step re-entrant) ----

  // 0.5 Deploy stage (merge/pr-merged only) — runs after disposition retirement, before archive.
  // The deploy stage runs once the code is on the base: a local merge (removed_after_merge), or a
  // PR merged on the remote — signalled by --merged with the merge commit as --merge-sha (§7.2).
  const disp = ctx.state.worktree_disposition;
  const prMerged = ctx.merged === true && disp === 'kept_by_user';
  // Once deploy_base is durable the stage is active on EVERY re-entry — the merge flags are only the
  // way in for a PR merge; a follow-up call never has to repeat them.
  const hasDeployBase = parseEventArray(readEvents(ctx.absState)).some((e) => e.type === 'deploy_base');
  if (ctx.merged === true && !ctx.mergeSha && !hasDeployBase) throw new Error('finish-step: --merged requires --merge-sha (the merge commit on the base)');
  // A discard retired the run as NOT-DONE (disposition removed_after_merge, the same value a merge
  // lands) — it must never enter the deploy stage, however real its `done:` surface looks (adversary
  // r1 BLOCKER). Skip straight to the archive shortcut, which archives incomplete:discarded.
  const discardedRun = parseEventArray(readEvents(ctx.absState)).some(
    (e) => e.type === 'incomplete_authorized' && e.reason === 'discarded',
  );
  if (ctx.state.status !== 'archived' && !discardedRun && (disp === 'removed_after_merge' || prMerged || hasDeployBase)) {
    const deployOp = evaluateDeployStage(ctx);
    if (deployOp) return deployOp;
    // The stage is complete. §6.2/§7.3: the FINAL assessment runs over what was actually
    // deployed, and the archive waits on the operator's own answer to "does this do what you
    // meant?" — neither is derivable from the branch diff the implementation pass saw.
    const finalOp = evaluateFinalAssessment(ctx);
    if (finalOp) return finalOp;
  }

  if (ctx.retroOnly) {
    if (!fs.existsSync(ctx.retroPath)) return { op: 'write_retro', path: ctx.retroPath, retro_only: true };
    return { op: 'stop', reason: 'retro_done', path: ctx.retroPath };
  }

  // 0.6 §7.5 crash recovery: an intent rejection is TWO appends (the canonical incomplete_authorized,
  // then the required_successor projection). A death between them leaves a terminal authorization
  // with no successor obligation, and once archived nothing may append the missing event. Recovery
  // here is deterministic and idempotent: re-derive the obligation from the authorization record and
  // re-emit it if absent — the successor slug, class and correction live on the SAME record, so the
  // projection is exact. Runs before the archive shortcut so a recovered run archives complete.
  {
    const evs = parseEventArray(readEvents(ctx.absState));
    const missing = evs.filter((e) => e.type === 'incomplete_authorized' && String(e.reason ?? '').startsWith('intent_rejected:'))
      .filter((auth) => {
        const slug = auth.successor;
        return !slug || !evs.some((r) => r.type === 'required_successor' && r.slug === slug);
      });
    if (missing.length) {
      for (const auth of missing) {
        const cls = auth.class ?? auth.reason.replace('intent_rejected:', '');
        const reason = typeof auth.rejection_reason === 'string' ? auth.rejection_reason : 'the deployed result was rejected';
        // A record with no successor slug cannot be projected — leave it for the archive guard to
        // refuse (a nameless handoff must never be archived silently).
        if (typeof auth.successor !== 'string' || auth.successor.trim() === '') continue;
        appendEvent(ctx.absState, {
          type: 'required_successor', ts: ctx.ts,
          slug: auth.successor,
          reason: cls === 'intent'
            ? `the deployed result was rejected on intent: ${reason}`
            : `the deployed result was rejected on implementation: ${reason}`,
          source: ctx.slug,
          class: cls,
        });
      }
    }
    // §7.4 crash recovery (adversary r1 finding 4): an attestation is also a two-append transaction
    // (the signed deploy_step {status:attested}, then its incomplete_authorized {reason:attested}). A
    // death between them leaves a completed attested step whose authorization never landed — the
    // step cannot be re-attested (it is no longer indeterminate) and the archive refuses for the
    // missing authorization. Recovery is deterministic and idempotent: re-derive the authorization
    // from the attested step record and re-emit it if absent, exactly as the reject-obligation above.
    const attestedSteps = evs.filter((e) => e.type === 'deploy_step' && e.status === 'attested');
    for (const step of attestedSteps) {
      const group = step.group, index = step.index, sha = step.sha;
      const hasAuth = evs.some((e) => e.type === 'incomplete_authorized' && e.reason === 'attested' && e.group === group && e.index === index && e.sha === sha);
      if (!hasAuth) {
        appendEvent(ctx.absState, {
          type: 'incomplete_authorized', ts: ctx.ts, reason: 'attested',
          group, index, sha,
          head_after: typeof step.head_after === 'string' ? step.head_after : runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim(),
          recovered: true,
        });
      }
    }
  }

  // 1. Re-entry shortcut / archive LAST. Read MAIN-side with NO WT git — the teardown removed
  //    <WT> before this point, so a WT snapshot here would die (the Codex P1 the prose fixed).
  if (RETIRED.has(ctx.state.worktree_disposition)) {
    // A PR retirement with a deploy surface waits for the merge (§7.2): the run is not archived until
    // --merged --merge-sha bring the branch onto the base and the deploy stage runs. `keep` (no PR)
    // and done: none / no definition archive as before.
    if (ctx.state.worktree_disposition === 'kept_by_user' && ctx.state.status !== 'archived') {
      const evs = parseEventArray(readEvents(ctx.absState));
      const finishes = evs.filter((e) => e.type === 'branch_finish');
      const retire = [...finishes].reverse().find((e) => typeof e.branch_tip === 'string') ?? finishes[finishes.length - 1];
      // Only the stage-terminal reasons resolve the wait (the same set evaluateDeployStage honours):
      // an unrelated incomplete authorization — a waived verify, a forced goal — never does.
      const stageResolved = evs.some((e) => e.type === 'incomplete_authorized' && isStageTerminalReason(e.reason));
      if (retire && retire.note === 'pr' && !evs.some((e) => e.type === 'deploy_base') && !stageResolved) {
        // The deploy base of a PR is its merge commit — under `done: none` too (§7.1: deploy_base is
        // recorded and no group runs). Nothing is decided against a base that can still move while
        // the PR is open: the run stays resumable until --merged --merge-sha names the landing.
        return { op: 'stop', reason: 'await_merge', slug: ctx.slug, branch: ctx.branch, branch_tip: retire.branch_tip ?? null, next: 'finish-step --merged --merge-sha=<merge commit> once the PR is merged' };
      }
    }
    if (ctx.state.status !== 'archived') {
      // §7.4: the completion class is written AT archive, from the ledger, and the archive is
      // refused when the class it would claim has no matching authorization: `complete`/`merged`
      // require `completion_confirmed`, `incomplete:<reason>` requires the terminal
      // `incomplete_authorized` that names it. A run with NO class (legacy) archives as before.
      const events = parseEventArray(readEvents(ctx.absState));
      const completion = deriveCompletionClass(ctx, events);
      if (completion === null) {
        // legacy — no authorization needed. BUT a legacy re-derivation must not silently preserve
        // a completion field an earlier (pre-fix) archive or a corrupt state wrote: `complete`
        // carried with no confirmation on the ledger is exactly the unconfirmed archive the guard
        // exists to refuse, so a SET state.completion that the ledger no longer supports is a
        // contradiction, not a legacy shape (adversary r1 finding 6).
        if (ctx.state.completion != null && ctx.state.completion !== 'legacy') {
          throw new Error(`finish-step: refusing to archive ${ctx.slug} — state carries completion ${JSON.stringify(ctx.state.completion)} but the ledger derives no completion class (no authorization/confirmation on the ledger); clear the stale field or record the authorization the class requires`);
        }
      } else if (completion.startsWith('incomplete:')) {
        const reason = completion.slice('incomplete:'.length);
        if (!events.some((e) => e.type === 'incomplete_authorized' && isStageTerminalReason(e.reason) && (e.reason === reason || (reason === 'attested' && e.reason === 'attested')))) {
          throw new Error(`finish-step: refusing to archive ${ctx.slug} as ${completion} — no matching incomplete_authorized authorization is on the ledger; re-run the gate that records it`);
        }
        // §7.5 fail-closed: an intent rejection is TWO responsibilities — the terminal authorization
        // AND the successor obligation it names. An archived run that rejected on intent/implementation
        // but never emitted the required_successor would strand the handoff permanently (appendEvent
        // refuses everything but archive_pushed after archived), so the archive refuses rather than
        // close that window (adversary r1 finding 2).
        if (reason.startsWith('intent_rejected:')) {
          const auth = [...events].reverse().find((e) => e.type === 'incomplete_authorized' && e.reason === reason);
          const slug = auth?.successor;
          if (!slug || !events.some((e) => e.type === 'required_successor' && e.slug === slug)) {
            throw new Error(`finish-step: refusing to archive ${ctx.slug} as ${completion} — the intent rejection named successor ${JSON.stringify(slug ?? '(none)')} but no matching required_successor obligation is on the ledger; re-enter to recover the obligation`);
          }
        }
      } else if (completion === 'merged') {
        // merged needs no confirmation — a done: none deployment has no intent to confirm — but
        // it must be a genuine done: none archive, which deriveCompletionClass already proved by
        // reading the deploy_base's done_sha256.
      } else if (!events.some((e) => e.type === 'completion_confirmed')) {
        throw new Error(`finish-step: refusing to archive ${ctx.slug} as ${completion} — a ${completion} archive requires completion_confirmed on the ledger; the operator must confirm (or reject) the deployed intent first`);
      } else {
        // The confirmation must be bound to the LATEST deploy base — deriveCompletionClass already
        // proved this for `complete` (it requires a matching deploy_base_sha), but the guard
        // re-checks so a `complete` that reached here through any future path is still refused on a
        // wrong-base confirmation (adversary r1 finding 5).
        const base = [...events].reverse().find((e) => e.type === 'deploy_base');
        if (!base || !events.some((e) => e.type === 'completion_confirmed' && e.deploy_base_sha === base.sha)) {
          throw new Error(`finish-step: refusing to archive ${ctx.slug} as ${completion} — no completion_confirmed is bound to the latest deploy base ${base ? base.sha.slice(0, 12) : '(none)'}; a stale or wrong-base confirmation cannot authorize a ${completion} archive`);
        }
      }
      ctx.state = completion === null
        // legacy — the field stays ABSENT, exactly as every pre-v10 archive left it. Writing
        // `completion: null` would make an explicit-null look like a decision; the contract is
        // that absence means legacy.
        ? setStatus(ctx.state, 'archived')
        : setStatus({ ...ctx.state, completion }, 'archived');
      writeState(ctx.absState, ctx.state);
      // Post-archive retro completion block: the `write_retro` op ran before the completion
      // class existed, so retro.md has no `## Completion` block yet — upsert it now, from the
      // durable state and ledger, inside the same transaction (adversary r1 finding 1).
      upsertRetroCompletionBlock(ctx);
    }
    commitBundle(ctx.MAIN, ctx.bundleDir, `masterplan(${ctx.slug}): archive run (finish complete)`);
    // §7.2 push_archive: the archive is not terminal for an install-pushed run until the operator
    // either pushes the archive (archive_pushed) or declines (archive_push_skipped). The gate
    // replaces the plain archived stop when a pushed_base is on the ledger and the decision is
    // outstanding; the bundle is already archived, so re-entry lands here again and re-emits it.
    const pushGate = evaluatePushArchive(ctx);
    if (pushGate) return pushGate;
    if (!ctx.ownerLockOff && ctx.self) {
      releaseOwner(ctx.bundleDir, ctx.self, { now: ctx.now, ttlMs: ctx.ttlMs }); // the bundle is done; never block a successor
    }
    return { op: 'stop', reason: 'archived', slug: ctx.slug, disposition: ctx.state.worktree_disposition };
  }

  // 2. A still-open gate (no resolving answer arrived this call) → re-render it (CD-9).
  if (ctx.state.pending_gate) {
    const gate = ctx.state.pending_gate.id;
    const out = { op: 'ask', ask: 'gate', gate, wt: ctx.WT };
    if (gate === 'branch_finish') {
      // Hydrate WT-side facts defensively: a crash inside a merge/discard teardown can leave the
      // gate open with the WT already removed — re-render from MAIN-side refs (the branch tip
      // survives) so the user can re-issue the same --choice (replay is idempotent: the path
      // being gone confirms the removal).
      ctx.head = null;
      try { ctx.head = fs.existsSync(ctx.WT) ? ctx.wtHead() : runGit(ctx.MAIN, ['rev-parse', `refs/heads/${ctx.branch}`]); } catch { /* branch retired too */ }
      let base = null;
      try { base = detectBase(runGit(ctx.MAIN, ['branch', '--format=%(refname:short)'])); } catch { /* no base detectable */ }
      ctx.events = readEvents(ctx.absState);
      const reviewRecord = ctx.head ? selectReviewAtHead(ctx.events, ctx.head) : { present: false };
      Object.assign(out, {
        head: ctx.head,
        branch: ctx.branch,
        base,
        wt_missing: !fs.existsSync(ctx.WT) || undefined,
        dispositions: Object.fromEntries(FINISH_CHOICES.map((c) => [c, dispositionForChoice(c)])),
        review: reviewRecord.present ? reviewRecord : null,
      });
    } else if (gate === 'docs_normalize') {
      // The candidate list is deterministic (diff vs merge-base) — recompute on every re-render
      // rather than persisting it in pending_gate (state.yml scalars stay small; survives
      // compaction for free). Defensive like the branch_finish branch: any failure → nulls.
      ctx.head = null;
      try { ctx.head = fs.existsSync(ctx.WT) ? ctx.wtHead() : null; } catch { /* unreadable WT */ }
      let base = null;
      try { base = detectBase(runGit(ctx.WT, ['branch', '--format=%(refname:short)'])); } catch { /* no base detectable */ }
      const candidates = base ? listDocCandidates(ctx.WT, base, path.relative(ctx.MAIN, ctx.bundleDir)) : null;
      Object.assign(out, {
        head: ctx.head,
        base,
        candidates,
        wt_missing: !fs.existsSync(ctx.WT) || undefined,
      });
    } else if (gate === 'goals_unmet') {
      ctx.head = null;
      try { ctx.head = fs.existsSync(ctx.WT) ? ctx.wtHead() : null; } catch { /* unreadable WT */ }
      const evText = readEvents(ctx.absState);
      const g = ctx.head ? evaluateGoalCompletion(ctx.bundleDir, evText, ctx.head) : { readable: false };
      Object.assign(out, {
        head: ctx.head,
        mode: ctx.state.pending_gate?.mode === 'manual' ? 'manual' : 'assess',
        summary: g.readable ? g.summary : null,
        unmet: g.readable ? g.unmet : null,
        waived: g.readable ? g.waived : null,
        choices: ['fix', 'waiver', 'abort'],
      });
    }
    return out;
  }

  // 3. Snapshot — from WT (isolates MAIN-side dirt; protect-user-work for free).
  if (!fs.existsSync(ctx.WT)) {
    return {
      op: 'ask', ask: 'dispatch-error',
      error: `worktree ${ctx.WT} is missing but worktree_disposition is '${ctx.state.worktree_disposition ?? 'unset'}' (not retired) — reconcile with mp sweep, or record the disposition`,
    };
  }
  ctx.head = ctx.wtHead();
  const taskFiles = (ctx.state.tasks ?? []).flatMap((t) => t.files ?? []);
  const dirt = classifyDirt(gitPorcelain(ctx.WT), taskFiles);

  // 4. Dirty-commit (thin net): task-scope paths commit in WT; unrelated dirt stays untouched.
  if (dirt.taskScopeDirty) {
    runGit(ctx.WT, ['add', '--', ...dirt.taskScopePaths]);
    runGit(ctx.WT, ['commit', '-q', '-m', `masterplan(${ctx.slug}): finish dirty-commit (task scope)`]);
    ctx.head = ctx.wtHead(); // verified must reflect the NEW commit — never skip on a stale SHA
  }

  // 4.5 Docs-normalization offer — candidates-gated; durable event guard (presence, not sha —
  //     accepting moves HEAD by design, and the offer fires once per run). Sits BEFORE
  //     verification so the normalization commit lands before verified_sha is recorded: the
  //     suite runs exactly once, over the FINAL tree (and the codex review covers the docs).
  ctx.events = readEvents(ctx.absState);
  if (
    docsNormalizeArmed(ctx.state.docs?.normalize) && !ctx.docsSuppressed && ctx.docs === null &&
    !hasEventType(ctx.events, 'docs_normalize') && !hasEventType(ctx.events, 'docs_normalize_skipped')
  ) {
    const docsBase = detectBase(runGit(ctx.WT, ['branch', '--format=%(refname:short)']));
    const candidates = docsBase ? listDocCandidates(ctx.WT, docsBase, path.relative(ctx.MAIN, ctx.bundleDir)) : [];
    if (candidates.length > 0) {
      ctx.state = openGate(ctx.state, { id: 'docs_normalize', opened_at: ctx.ts });
      writeState(ctx.absState, ctx.state);
      return { op: 'ask', ask: 'gate', gate: 'docs_normalize', candidates, base: docsBase, head: ctx.head, wt: ctx.WT };
    }
  }

  // 5. Verification gate — verified-at-SHA skip; otherwise the shell runs the skill.
  if (!isVerified(ctx.state.verified_sha ?? null, ctx.head)) {
    let commands = [];
    const planIndexPath = ctx.state.plan_index_path ?? path.join(ctx.bundleDir, 'plan.index.json');
    if (fs.existsSync(planIndexPath)) {
      try { commands = collectVerifyCommands(JSON.parse(fs.readFileSync(planIndexPath, 'utf8'))); } catch { /* empty union */ }
    }
    return { op: 'run_verify', commands, head: ctx.head, wt: ctx.WT };
  }

  // 5.4 Spec-gate re-arm refusal (plan-review finding 2 / residual finding 5). On a goals_enabled bundle
  //     the spec gate covers spec.md + goals.md, so a post-plan `mp goals-amend` re-arms it. Refuse to
  //     proceed past run_verify (goal check / retro / archive) until a fresh spec-gate review is recorded
  //     at the CURRENT spec.md+goals.md hash. finish-step only CHECKS; it never records the review.
  // 5.5 Goal-completeness gate (goal tracking). Assessor verdict over every active goal, gated on
  //     goals_enabled: all-achieved (or waived) → silent auto-progress; any partial/missed → the durable
  //     goals_unmet AUQ (fix / waiver / abort). Assessor-dispatch failure is FAIL-CLOSED — open the gate
  //     in manual mode for user-attested verdicts or a waiver, never a silent path to archived.
  let goalsSummary = null;
  if (goalsEnabledFor(ctx.state, ctx.events)) {
    const specHash = computeSpecGateHash(ctx.bundleDir, ctx.state);
    if (specHash && !selectReentry(ctx.events, { kind: 'artifact-hash', gate: 'spec', key: specHash }).present) {
      return {
        op: 'ask', ask: 'spec_gate_rearmed', gate: 'spec', hash: specHash,
        reason: 'goals.md was amended after planning — re-run the spec adversary-review gate before finishing',
      };
    }
    const g = evaluateGoalCompletion(ctx.bundleDir, ctx.events, ctx.head);
    if (!g.readable) {
      return { op: 'ask', ask: 'dispatch-error', error: 'goals.md unreadable on a goals_enabled bundle — cannot assess goal completion' };
    }
    goalsSummary = { summary: g.summary, achieved: g.nAchieved, partial: g.nPartial, waived: g.nWaived };
    if (g.active.length > 0) {
      if (!g.hasCheck) {
        if (ctx.goalCheck === 'failed') {
          ctx.state = openGate(ctx.state, { id: 'goals_unmet', opened_at: ctx.ts, mode: 'manual' });
          writeState(ctx.absState, ctx.state);
          return {
            op: 'ask', ask: 'gate', gate: 'goals_unmet', mode: 'manual', head: ctx.head, wt: ctx.WT,
            goals_hash: g.goalsHash, summary: g.summary, unmet: g.unmet, waived: g.waived,
            choices: ['fix', 'waiver', 'abort'],
            reason: 'goal assessor dispatch failed — attest verdicts or waive to proceed (fail-closed)',
          };
        }
        return { op: 'run_goal_check', head: ctx.head, wt: ctx.WT, goals_hash: g.goalsHash };
      }
      if (g.unmet.length > 0) {
        ctx.state = openGate(ctx.state, { id: 'goals_unmet', opened_at: ctx.ts, mode: 'assess' });
        writeState(ctx.absState, ctx.state);
        return {
          op: 'ask', ask: 'gate', gate: 'goals_unmet', mode: 'assess', head: ctx.head, wt: ctx.WT,
          goals_hash: g.goalsHash, summary: g.summary, unmet: g.unmet, waived: g.waived,
          choices: ['fix', 'waiver', 'abort'],
        };
      }
      // all active goals achieved or waived → proceed silently (auto-progress preserved).
    }
  }

  // 6. Retro (write-if-absent).
  if (!fs.existsSync(ctx.retroPath)) return { op: 'write_retro', path: ctx.retroPath };

  // 7. Whole-branch adversary review — durable re-entry guard keyed on the WT code tip.
  //
  // 7a. Effective review setting (spec §4.2-C defensive arm). The arm bit reads the NEW key
  //     state.review.adversary, falling back to the legacy state.codex.review for in-flight bundles
  //     seeded before the rename. Truly-legacy bundles seeded before review became default-on have
  //     NEITHER block; codexArmed(undefined) is false, so the gate would silently fall through.
  //     Defensively arm those once — emit a durable event so the audit trail shows the legacy state
  //     was rescued (NOT a silent re-arm). The event is presence-scoped (not sha-scoped): a
  //     defensive arm is a one-time per-bundle fact.
  const stateCodexArmed = codexArmed(ctx.state.review?.adversary ?? ctx.state.codex?.review);
  const defensiveArmed = ctx.state.review === undefined && ctx.state.codex === undefined; // legacy: neither block
  const effectiveArmed = stateCodexArmed || defensiveArmed;
  if (defensiveArmed && !hasEventType(ctx.events, 'adversary_review_defensively_armed')) {
    appendEvent(ctx.absState, {
      type: 'adversary_review_defensively_armed',
      ts: ctx.ts,
      summary: 'adversary review defensively armed — legacy bundle missing state.review.adversary; finish-step gate would otherwise silently skip',
      data: { sha: ctx.head },
    });
  }

  // 7b. Expanded base resolution (spec §4.2-A auto-detect). Local main/master first, then origin,
  //     then any remote, then the empty-tree SHA as the universal-diff last resort. The empty-tree
  //     baseline is applied HERE (not inside detectBaseAuto) so a missing-everything repo still
  //     produces a typed skip event when the caller's intent is "never silently review whole-branch".
  const branchesText = runGit(ctx.WT, ['branch', '--format=%(refname:short)']);
  const remoteBranchesText = runGit(ctx.WT, ['branch', '-r', '--format=%(refname:short)']);
  const baseAuto = detectBaseAuto(branchesText, remoteBranchesText);
  const base = baseAuto?.base ?? (effectiveArmed ? EMPTY_TREE_SHA : null);
  const baseSource = baseAuto?.source ?? (effectiveArmed ? 'empty-tree' : null);

  // 7c. Typed skip events (spec §4.2-B). The re-entry guard (hasCodexSkipAtSha) keeps this
  //     append-or-fall-through idempotent at the same HEAD. Each skip reason is searchable in
  //     events.jsonl; the SUCCESS summary ("adversary review complete ...") matches the
  //     \b(codex|adversary)\s+review\b audit regex, but the skip summary uses a hyphenated phrase
  //     ("adversary-review skipped ...") so the proposed-but-not-implemented
  //     adversary_review_configured_but_zero_invocations audit can still fire when configured + skipped.
  const skipReason = !effectiveArmed ? 'state.review.adversary not armed'
                   : !base ? 'no_base_branch'
                   : null;
  if (skipReason && !hasCodexSkipAtSha(ctx.events, ctx.head)) {
    appendEvent(ctx.absState, {
      type: 'adversary_review_skipped',
      ts: ctx.ts,
      summary: `adversary-review skipped — ${skipReason}`,
      data: { sha: ctx.head, reason: skipReason, defensive: defensiveArmed },
    });
  }

  // 7d. Run review only when armed AND base resolved AND not suppressed AND no prior review/skip
  //     at this HEAD. The empty-tree base is allowed through here (it's a valid diff baseline);
  //     reviewers see "whole-branch" in the AUQ and can reject.
  if (
    effectiveArmed && base && ctx.review === null &&
    !selectReviewAtHead(ctx.events, ctx.head).present && !hasCodexSkipAtSha(ctx.events, ctx.head)
  ) {
    return { op: 'run_adversary_review', base, head: ctx.head, wt: ctx.WT, digest_path: ctx.digestPath, base_source: baseSource };
  }

  // 8. Open the durable branch_finish gate (the v8 regression §2c restored) and ask.
  ctx.state = openGate(ctx.state, { id: 'branch_finish', opened_at: ctx.ts });
  writeState(ctx.absState, ctx.state);
  const reviewRecord = selectReviewAtHead(ctx.events, ctx.head);
  // Spec §4.2-D: surface the skip reason in the AUQ payload so the user can see WHY
  // review didn't run, not just that it didn't. Skipped at SHA → typed reason from the event
  // (incl. a legacy `codex_host_suppressed` reason on pre-rename bundles, read-through for
  // back-compat); defensive-armed → the audit-trail note. Re-read events here (NOT reuse the
  // in-memory `events` from step 7): the just-emitted skip event must be visible to lastSkip,
  // and events was read before the appendEvent above.
  const freshEvents = readEvents(ctx.absState);
  const lastSkip = (() => {
    const lines = (typeof freshEvents === 'string' ? freshEvents : '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = (lines[i] || '').trim(); if (!t) continue;
      let rec; try { rec = JSON.parse(t); } catch { continue; }
      if (REVIEW_SKIP_TYPES.has(rec?.type) && rec.data?.sha === ctx.head) return rec.data.reason ?? null;
    }
    return null;
  })();
  const reviewNotice = lastSkip ? `adversary review skipped — ${lastSkip}`
                     : defensiveArmed ? 'adversary review defensively armed (legacy bundle missing state.review.adversary)'
                     : undefined;
  return {
    op: 'ask',
    ask: 'gate',
    gate: 'branch_finish',
    head: ctx.head,
    branch: ctx.branch,
    base,
    wt: ctx.WT,
    dispositions: Object.fromEntries(FINISH_CHOICES.map((c) => [c, dispositionForChoice(c)])),
    review: reviewRecord.present ? reviewRecord : null,
    notice: reviewNotice,
    ...(goalsSummary ? { goals: goalsSummary } : {}),
  };
}

// Definition of done at a deploy base: the repo-local .masterplan.yaml at that sha, or the
// ad-hoc definition persisted by the no_definition_of_done gate (bundle/done-adhoc.json).
function resolveDoneForBase(ctx, sha) {
  const { done } = resolveDoneAtRevision(ctx.MAIN, sha);
  if (done !== undefined) return done;
  const adhocPath = path.join(ctx.bundleDir, 'done-adhoc.json');
  if (fs.existsSync(adhocPath)) return JSON.parse(fs.readFileSync(adhocPath, 'utf8'));
  return undefined;
}

// The revision the merge of branchTip onto baseHead will produce — git's own merge (renames and all)
// as a tree id usable with `show <tree>:<path>` — so the definition of done and ${version} are read
// exactly as the merge lands them (§7.1 re-resolves at deploy_base_sha). {rev} or {conflict: why}:
// a conflicting merge, or a git too old to compute one, cannot be known before the merge.
function effectiveMergeRev(ctx, baseHead, branchTip) {
  if (!baseHead) return { rev: branchTip };
  if (!branchTip) return { rev: baseHead };
  let r;
  try { r = mergedTree(ctx.MAIN, baseHead, branchTip); } catch (e) { return { conflict: `cannot compute the merge of ${branchTip.slice(0, 12)} onto ${baseHead.slice(0, 12)}: ${e.message}` }; }
  if (r.unsupported) return { conflict: r.unsupported };
  if (r.conflict) return { conflict: `the merge of ${branchTip.slice(0, 12)} onto ${baseHead.slice(0, 12)} conflicts` };
  return { rev: r.tree };
}

// §7.1 release contract: the version the branch tip names must not already be tagged. Returns
// {version, tag, where} when it is (locally, on origin, or both), else null. No done block, done: none,
// or no version_from → nothing to check.
function versionNotBumped(ctx) {
  let branchTip = null;
  try { branchTip = runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`]).trim(); } catch { branchTip = null; }
  if (!branchTip) return null;
  // Everything is read from the tree the merge will produce (§7.1 re-resolves at deploy_base_sha):
  // the definition (.masterplan.yaml) and then ${version} from its version_from, exactly as git's
  // merge lands them — renames, base-side changes and all. A conflict is unverifiable.
  let baseHead = null;
  try { baseHead = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim(); } catch { baseHead = null; }
  // The ad-hoc definition the caller supplies is a release surface wherever a checked-in one would be.
  let adhoc = null;
  if (ctx.doneAdhocFile) {
    try { adhoc = JSON.parse(fs.readFileSync(ctx.doneAdhocFile, 'utf8')); } catch (e) { return { unverifiable: `cannot read the ad-hoc definition of done (${ctx.doneAdhocFile}): ${e.message}` }; }
  }
  const eff = effectiveMergeRev(ctx, baseHead, branchTip);
  if (eff.conflict) {
    // Nothing to guard when NO side declares a release surface (the merge itself will fail and abort
    // cleanly downstream); with one — the ad-hoc definition included — the merged version cannot be
    // known → unverifiable.
    const surfaces = [];
    if (adhoc && adhoc !== 'none' && adhoc.version_from) surfaces.push('adhoc');
    for (const rev of [baseHead, branchTip].filter(Boolean)) {
      try { const d = resolveDoneForBase(ctx, rev); if (d && d !== 'none' && d.version_from) surfaces.push(rev); } catch { surfaces.push(rev); }
    }
    if (surfaces.length === 0) return null;
    return { unverifiable: `${eff.conflict} — the merged definition of done and version cannot be known before the merge` };
  }
  let def;
  try { def = resolveDoneForBase(ctx, eff.rev); } catch (e) { return { unverifiable: `cannot resolve the definition of done at the merged tree ${eff.rev.slice(0, 12)}: ${e.message}` }; }
  // A repository with no definition deploys through the ad-hoc one, which binds the release contract
  // exactly as a checked-in definition does (§7.1).
  if (def === undefined && adhoc) def = adhoc;
  if (!def || def === 'none' || !def.version_from) return null;
  let version;
  try { version = versionAtRevision(ctx.MAIN, eff.rev, def.version_from); } catch (e) { return { unverifiable: `cannot read ${def.version_from} at the merged tree ${eff.rev.slice(0, 12)}: ${e.message}` }; }
  const tag = `v${version}`;
  const where = [];
  if (tagExists(ctx.MAIN, tag)) where.push('local');
  let hasOrigin = false;
  try { runGit(ctx.MAIN, ['remote', 'get-url', 'origin']); hasOrigin = true; } catch { hasOrigin = false; }
  if (hasOrigin) {
    // An unreachable origin is NOT evidence of an absent tag: the guard fails closed (§7.1).
    try { if (tagExists(ctx.MAIN, tag, { remote: 'origin' })) where.push('origin'); } catch (e) { return { version, tag, where, origin_unverified: String(e.message || e) }; }
  }
  return where.length ? { version, tag, where } : null;
}

// The branch tip the deploy base carries (§7.3): a local merge's second parent (or the tip itself on
// a fast-forward), or — for a PR — the kept branch, whose landing on --merge-sha must be a real merge
// (ancestry) or a proven single squash; rebase merges, whitespace-different squashes and unsupported
// git versions are refused with the diagnostic.
function resolveBranchTipInBase(ctx, sha, { strict = true } = {}) {
  let parents = [];
  try { parents = runGit(ctx.MAIN, ['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/); } catch { parents = [sha]; }
  let localTip = null;
  try { localTip = runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`]).trim(); } catch { localTip = null; }
  // The identity is the branch tip recorded at retirement (branch_finish.branch_tip) — a durable sha,
  // never the mutable branch ref (which can be force-moved after the PR was opened) and never an
  // inference from the current HEAD. Legacy bundles without the record fall back to the ref.
  // The durable retirement identity: the branch_finish record, else the intent that preceded it (a
  // crash between the two leaves only the intent).
  const evsForTip = parseEventArray(readEvents(ctx.absState));
  const retire = [...evsForTip].reverse().find((e) => e.type === 'branch_finish' && typeof e.branch_tip === 'string')
    ?? [...evsForTip].reverse().find((e) => e.type === 'branch_finish_intent' && typeof e.branch_tip === 'string');
  // A bundle whose retirement wrote a record at all is held to it: a record without a branch_tip is
  // corruption, not legacy. A bundle with NO retirement record (a pre-v10 flow) keeps the relaxed
  // inference below.
  const hasRetireRecord = evsForTip.some((e) => e.type === 'branch_finish' || e.type === 'branch_finish_intent');
  if (ctx.mergeSha) {
    // Strict identity is proven ONLY against the durable retirement tip: the branch ref can be
    // force-moved after the PR was opened, so it is evidence on the relaxed path alone.
    if (strict && hasRetireRecord && !retire) throw new Error(`finish-step: no retirement identity for ${ctx.branch} (no branch_finish/branch_finish_intent record carries a branch_tip) — the deploy base ${sha.slice(0, 12)} cannot be proven; re-run the branch_finish gate or archive incomplete`);
    const provenTip = retire ? retire.branch_tip : localTip;
    if (!provenTip) throw new Error(`finish-step: --merge-sha needs a recorded retirement tip or the branch ${ctx.branch} present locally to prove its identity`);
    const baseBefore = parents[1] || sha;
    const identity = mergeIdentity(ctx.MAIN, { baseBefore, branchTip: provenTip, mergeSha: sha });
    // Whatever the definition says (done: none deploys nothing but still archives on this base), a
    // landing that does not carry the tip is not this run's: refused wherever a tip is known.
    if (!identity.ok) throw new Error(`finish-step: --merge-sha ${sha.slice(0, 12)} does not carry the retired tip ${provenTip.slice(0, 12)} of ${ctx.branch} (${identity.kind}): ${identity.reason}`);
    if (identity.ok && Array.isArray(identity.beyond_tip) && identity.beyond_tip.length) {
      // Ancestry holds (§7.3) but the merged ref moved past the retired tip: visible on the record.
      appendEvent(ctx.absState, { type: 'deploy_base_note', ts: ctx.ts, sha, branch_tip: provenTip, beyond_tip: identity.beyond_tip });
    }
    return provenTip;
  }
  // Local merge: the recorded merge result must sit under the base with nothing but bundle commits
  // in between.
  if (retire) {
    const tip = retire.branch_tip;
    const isAnc = (a, b) => { try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
    if (tip !== sha && !isAnc(tip, sha)) {
      if (strict) throw new Error(`finish-step: deploy base ${sha.slice(0, 12)} does not contain the retired branch tip ${tip.slice(0, 12)}`);
      return tip;
    }
    if (retire.merge_sha && retire.merge_sha !== sha) {
      if (!isAnc(retire.merge_sha, sha)) {
        if (strict) throw new Error(`finish-step: deploy base ${sha.slice(0, 12)} does not contain the recorded merge ${retire.merge_sha.slice(0, 12)}`);
        return tip;
      }
      const between = auditDeployBoundary(ctx.MAIN, { from: retire.merge_sha, to: sha, bundlePrefix: 'docs/masterplan', commitPaths: [], versionFrom: null, expectedVersion: null, stageCommits: [] });
      if (!between.ok && strict) {
        const foreign = between.commits.find((c) => c.kind === 'foreign');
        throw new Error(`finish-step: base moved between the merge ${retire.merge_sha.slice(0, 12)} and ${sha.slice(0, 12)}: commit ${foreign.sha.slice(0, 12)} (${foreign.files.slice(0, 5).join(', ') || 'merge or empty commit'}) is not a bundle commit`);
      }
    }
    return tip;
  }
  // No recorded tip. Strict identity cannot be satisfied by inference — a single-parent base would
  // otherwise "prove" itself (tip === sha) — so it fails closed; the pre-v10 inference stays for the
  // relaxed path only (informational).
  if (strict && hasRetireRecord) {
    throw new Error(`finish-step: no retirement identity for ${ctx.branch} (no branch_finish/branch_finish_intent record carries a branch_tip) — the deploy base ${sha.slice(0, 12)} cannot be proven; re-run the branch_finish gate or archive incomplete`);
  }
  // No durable retirement tip. Strict identity may still be met by the surviving branch REF — an
  // independent witness — but never by the proposed base's own parent: a commit's parent proves
  // nothing about which branch it was, so a merge of anything at all would certify itself.
  if (strict && !localTip) {
    throw new Error(`finish-step: no retirement identity for ${ctx.branch} (no branch_finish/branch_finish_intent record carries a branch_tip and the branch ref is gone) — the deploy base ${sha.slice(0, 12)} cannot be proven; re-run the branch_finish gate or archive incomplete`);
  }
  const tip = strict ? localTip : (parents.length >= 3 ? parents[2] : (localTip || sha));
  let isAncestor = tip === sha;
  if (!isAncestor) {
    try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', tip, sha]); isAncestor = true; } catch { isAncestor = false; }
  }
  if (!isAncestor && strict) throw new Error(`finish-step: deploy base ${sha.slice(0, 12)} does not contain the branch tip ${tip.slice(0, 12)}`);
  return tip;
}

// Deploy outcome records that carry what the step did to MAIN (commits + head_after), whatever the outcome.
const DEPLOY_OUTCOME_TYPES = new Set(['deploy_step', 'deploy_failed', 'deploy_indeterminate', 'deploy_step_check_failed']);

// The commits MAIN gained since the last deploy receipt (or deploy_base): a step's own output. Each
// must be a bundle commit or a stage commit inside done.commit_paths with ${version} unchanged; any
// other commit moved the base (§7.3) and the report is refused before anything is recorded.
function stepCommitsSince(ctx, events, deployBaseSha, def) {
  const last = [...events].reverse().find((e) => DEPLOY_OUTCOME_TYPES.has(e.type) && e.sha === deployBaseSha && typeof e.head_after === 'string');
  const from = last ? last.head_after : deployBaseSha;
  const head = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
  if (from !== head) {
    // A step may only ADD history on top of the audited head: a rewound or replaced MAIN is a base
    // move, and the report is refused before any receipt could describe it.
    let contains = false;
    try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', from, head]); contains = true; } catch { contains = false; }
    if (!contains) throw new Error(`finish-step: base moved — MAIN HEAD ${head.slice(0, 12)} no longer contains the audited head ${from.slice(0, 12)} (rewound or replaced); the step is not recorded and the receipts at deploy_base ${deployBaseSha.slice(0, 12)} are invalid`);
  }
  const versionFrom = def && def !== 'none' && def.version_from ? def.version_from : null;
  const commitPaths = def && def !== 'none' ? (def.commit_paths || [versionFrom, 'CHANGELOG.md'].filter(Boolean)) : [];
  const expectedVersion = versionFrom ? versionAtRevision(ctx.MAIN, deployBaseSha, versionFrom) : null;
  const list = from === head ? [] : runGit(ctx.MAIN, ['rev-list', '--reverse', '--first-parent', `${from}..${head}`]).trim().split('\n').filter(Boolean);
  // Provisionally treat every commit in the range as this step's output; the audit's path/version
  // rules still apply, so a stray commit outside commit_paths is a base move, not a receipt.
  const audit = auditDeployBoundary(ctx.MAIN, { from, to: head, bundlePrefix: 'docs/masterplan', commitPaths, versionFrom, expectedVersion, stageCommits: list });
  if (!audit.ok) {
    const foreign = audit.commits.find((c) => c.kind === 'foreign');
    throw new Error(`finish-step: base moved — commit ${foreign.sha.slice(0, 12)} (${foreign.files.length ? foreign.files.slice(0, 5).join(', ') : 'merge or empty commit'}) produced while running a deploy step is outside the bundle and done.commit_paths; the step is not recorded and the receipts at deploy_base ${deployBaseSha.slice(0, 12)} are invalid`);
  }
  return { commits: audit.commits.filter((c) => c.kind === 'stage').map((c) => c.sha), head_after: head };
}

// The §7.2 push_archive producer: after every INSTALL-group deploy_step receipt, fetch
// `origin/<base>` and, when the remote tip moved to that receipt's `head_after`, stamp
// `pushed_base` on the receipt. An install chain that never moved the remote records no
// pushed_base and never reaches push_archive. A repo with no origin remote records nothing
// (there is nothing to have pushed, so there is nothing to gate on).
//
// The probe has THREE durable outcomes, and the archive must be able to tell them apart
// (adversary r1 finding 1): a CONFIRMED push (remote tip == head_after, `pushed_base`
// stamped), a CONFIRMED non-push (fetch succeeded but the remote tip is not head_after, no
// `pushed_base`), and an INDETERMINATE probe (fetch/rev-parse failed — the remote was
// unreachable, so we genuinely do not know whether the install push landed). The indeterminate
// case is written as a durable `push_probe {status:'indeterminate'}` side record so the
// archive does NOT silently stop as `pushed: no`: a successful push followed by a network blip
// would otherwise permanently mislabel the run. `evaluatePushArchive` re-probes and halts
// while an indeterminate probe for the latest install step is unresolved.
//
// `produced` is the stepCommitsSince receipt ({commits, head_after}); it is returned UNCHANGED
// for non-install groups (release/user_only/live_check never gate the archive push) and for any
// install step whose push cannot be proven.
function recordPushedBase(ctx, produced, group, index, base, deployBaseSha) {
  if (group !== 'install') return produced;
  if (!produced || typeof produced.head_after !== 'string') return produced;
  let hasOrigin = false;
  try { runGit(ctx.MAIN, ['remote', 'get-url', 'origin']); hasOrigin = true; } catch { hasOrigin = false; }
  if (!hasOrigin) return produced;
  let status = 'confirmed_not_pushed';
  const probeBase = { type: 'push_probe', ts: ctx.ts, group, index, sha: deployBaseSha, head_after: produced.head_after, base };
  try {
    runGit(ctx.MAIN, ['fetch', 'origin', base]);
    const remoteTip = runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).trim();
    if (remoteTip && remoteTip === produced.head_after) {
      appendEvent(ctx.absState, { ...probeBase, status: 'confirmed_pushed' });
      return { ...produced, pushed_base: produced.head_after };
    }
  } catch {
    // A fetch that fails (unreachable origin, unknown base ref) is not a license to refuse a
    // step that already completed — but it is NOT a confirmed non-push either. Record the
    // probe as indeterminate so the archive halts for a re-probe instead of silently stopping
    // as `pushed: no` (adversary r1 finding 1).
    status = 'indeterminate';
  }
  appendEvent(ctx.absState, { ...probeBase, status });
  return produced;
}

// Every deploy authorization re-audits the base (§7.3): MAIN must be clean outside the bundle, MAIN's
// HEAD must contain deploy_base, and every commit since deploy_base must be a bundle commit or a
// stage-produced commit inside done.commit_paths with ${version} unchanged — anything else moved the
// base and invalidates the receipts recorded against it.
function assertDeployAuthorizable(ctx, deployBaseSha, def) {
  const dirty = dirtyOutsideBundle(ctx.MAIN, 'docs/masterplan');
  if (dirty.length) throw new Error(`finish-step: MAIN is dirty outside docs/masterplan (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}) — deploy authorization refused`);
  const head = runGit(ctx.MAIN, ['rev-parse', 'HEAD']).trim();
  const isAnc = (a, b) => { try { runGit(ctx.MAIN, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  if (head !== deployBaseSha && !isAnc(deployBaseSha, head)) {
    throw new Error(`finish-step: MAIN HEAD ${head.slice(0, 12)} does not contain deploy_base ${deployBaseSha.slice(0, 12)} — fast-forward MAIN to the base first`);
  }
  const outcomes = parseEventArray(readEvents(ctx.absState)).filter((e) => DEPLOY_OUTCOME_TYPES.has(e.type) && e.sha === deployBaseSha);
  // The latest audited head must still be under HEAD: a MAIN rewound below a receipt is a base move,
  // refused BEFORE any command runs on the invalidated history (not merely at the next report).
  const lastAudited = [...outcomes].reverse().find((e) => typeof e.head_after === 'string');
  if (lastAudited && lastAudited.head_after !== head && !isAnc(lastAudited.head_after, head)) {
    throw new Error(`finish-step: base moved — MAIN HEAD ${head.slice(0, 12)} no longer contains the audited head ${lastAudited.head_after.slice(0, 12)} (rewound or replaced); the receipts at deploy_base ${deployBaseSha.slice(0, 12)} are invalid`);
  }
  const versionFrom = def && def !== 'none' && def.version_from ? def.version_from : null;
  const commitPaths = def && def !== 'none' ? (def.commit_paths || [versionFrom, 'CHANGELOG.md'].filter(Boolean)) : [];
  const expectedVersion = versionFrom ? versionAtRevision(ctx.MAIN, deployBaseSha, versionFrom) : null;
  // Provenance: only commits a deploy receipt recorded as its output may count as stage commits.
  const stageCommits = outcomes.filter((e) => Array.isArray(e.commits)).flatMap((e) => e.commits);
  const audit = auditDeployBoundary(ctx.MAIN, { from: deployBaseSha, to: head, bundlePrefix: 'docs/masterplan', commitPaths, versionFrom, expectedVersion, stageCommits });
  if (!audit.ok) {
    const foreign = audit.commits.find((c) => c.kind === 'foreign');
    throw new Error(`finish-step: base moved — commit ${foreign.sha.slice(0, 12)} (${foreign.files.length ? foreign.files.slice(0, 5).join(', ') : 'merge commit'}) is neither a bundle commit nor a stage commit inside done.commit_paths with the version unchanged; receipts recorded at deploy_base ${deployBaseSha.slice(0, 12)} are invalid`);
  }
}

// The definition of done bound to a durable deploy_base: replay must see the SAME definition the
// event recorded (done_sha256), whether it comes from .masterplan.yaml at the sha or done-adhoc.json.
function resolveBoundDone(ctx, deployBaseEvent) {
  const def = resolveDoneForBase(ctx, deployBaseEvent.sha);
  if (def === undefined) return undefined;
  const digest = doneDigest(def);
  if (digest !== deployBaseEvent.done_sha256) {
    throw new Error(`finish-step: the definition of done at ${deployBaseEvent.sha} no longer matches deploy_base.done_sha256 (${deployBaseEvent.done_sha256} != ${digest}) — replay refused`);
  }
  return def;
}

// Attestation is only valid for a check-less step, so only such a gate advertises it.
function indeterminateChoices(step) {
  return step && step.check ? ['rerun', 'abort'] : ['rerun', 'attest', 'abort'];
}

// §7.2: `release` and `install` offer a third option, skip-with-reason, which archives the run
// incomplete. `live_check` does NOT — it is the group that proves the deployment actually works,
// and a run that waived its own liveness evidence has nothing left to be complete about.
function failedChoices(group) {
  return group === 'live_check' ? ['retry', 'abort'] : ['retry', 'skip', 'abort'];
}

// The first step of the ordered chain with neither a deploy_step record nor an operator skip.
function nextPendingStep(def, events, sha) {
  for (const group of orderDeployGroups(def)) {
    const steps = def[group] || [];
    for (let index = 0; index < steps.length; index++) {
      if (events.some((e) => e.type === 'deploy_step' && e.group === group && e.index === index && e.sha === sha)) continue;
      if (events.some((e) => e.type === 'incomplete_authorized' && e.reason === `deploy_skip:${group}[${index}]`)) continue;
      return { group, index };
    }
  }
  return null;
}

// The latest deploy outcome for a step at a base sha: 'done' | 'failed' | 'indeterminate' | null.
function latestStepOutcome(events, group, index, sha) {
  let out = null;
  for (const e of events) {
    if (e.group !== group || e.index !== index || e.sha !== sha) continue;
    if (e.type === 'deploy_step') out = 'done';
    else if (e.type === 'deploy_failed') out = 'failed';
    else if (e.type === 'deploy_indeterminate') out = 'indeterminate';
    else if (e.type === 'deploy_step_authorized') out = null; // a fresh authorization clears a halt
  }
  return out;
}

function evaluateDeployStage(ctx) {
  const eventsText = readEvents(ctx.absState);
  const events = parseEventArray(eventsText);
  // Stage-stopping reasons only. A per-step skip (deploy_skip:<g>[<i>]) does NOT stop the
  // whole stage — the ordered chain continues past the skipped step — so it is deliberately
  // excluded here even though it is terminal for the completion class (§7.4). The completion
  // class derives from isStageTerminalReason at archive; the STAGE keeps running until one of
  // these (or a deploy_abort/skip-by-choice) resolves it.
  //
  // keep/discard are in the stage-stop set even though the stage is entered only by a merge /
  // PR retirement: a `discard` records disposition `removed_after_merge` (the same value a merge
  // lands), so a discard of a branch carrying a real `done:` surface would otherwise satisfy the
  // deploy-stage entry condition and authorize+start release/install commands on a run the
  // operator retired as not-done (adversary r1 BLOCKER).
  if (events.some((e) => e.type === 'incomplete_authorized' && (e.reason === 'no_definition_of_done' || e.reason === 'deploy_abort' || e.reason === 'version_not_bumped' || e.reason === 'kept' || e.reason === 'discarded'))) return null; // stage resolved: the run archives incomplete
  const deployBaseEvent = events.find((e) => e.type === 'deploy_base');
  let deployBaseSha = deployBaseEvent ? deployBaseEvent.sha : null;

  if (!deployBaseEvent) {
    let sha = runGit(ctx.MAIN, ['rev-parse', 'HEAD']);
    if (ctx.mergeSha) {
      // The option IS a sha: a symbolic or moving revision (HEAD, main, a tag) would be persisted as
      // deploy_base.sha and re-resolved by every later audit — following whatever it points at then.
      // A full object id in THIS repository's object format (sha1 → 40 hex, sha256 → 64): never a
      // ref, an expression or an abbreviation, which would be re-resolved by every later audit.
      let hexLen = 40;
      try { hexLen = runGit(ctx.MAIN, ['rev-parse', '--show-object-format']).trim() === 'sha256' ? 64 : 40; } catch { hexLen = 40; }
      if (!new RegExp(`^[0-9a-f]{${hexLen}}$`).test(ctx.mergeSha)) throw new Error(`finish-step: --merge-sha must be a full ${hexLen}-hex commit id, got ${ctx.mergeSha}`);
      let kind = null;
      try { kind = runGit(ctx.MAIN, ['cat-file', '-t', ctx.mergeSha]).trim(); } catch { kind = null; }
      if (kind !== 'commit') throw new Error(`finish-step: --merge-sha ${ctx.mergeSha} is not a commit in MAIN`);
      sha = ctx.mergeSha;
    }
    deployBaseSha = sha;
    const doneDef = resolveDoneForBase(ctx, sha);
    // Identity is strict for every deploy-capable definition, the ad-hoc one included: an ad-hoc
    // definition supplied for a base with no repository definition must not relax the merge proof.
    const deployCapable = (doneDef !== undefined && doneDef !== 'none') || (doneDef === undefined && !!ctx.doneAdhocFile);
    // Identity is proven whenever the retirement recorded a tip, whatever the definition says: a
    // `done: none` landing still becomes the archived deploy base, and an unrelated commit must never
    // take that place. Only a legacy bundle with NO recorded tip falls back to the relaxed path.
    const provenTipRecorded = parseEventArray(eventsText).some((e) => e.type === 'branch_finish' && typeof e.branch_tip === 'string' && (e.note === 'merge' || e.note === 'pr'));
    if (deployCapable) {
      // The base is recorded clean: dirt outside the bundle at stage entry is refused before any
      // deploy_base exists (§7.3), not merely at the first authorization.
      const dirty = dirtyOutsideBundle(ctx.MAIN, 'docs/masterplan');
      if (dirty.length) throw new Error(`finish-step: MAIN is dirty outside docs/masterplan (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}) — the deploy base is not recorded until the tree is clean`);
    }
    const branchTip = resolveBranchTipInBase(ctx, sha, { strict: deployCapable || provenTipRecorded });
    // §7.1 at the real base: the version the landing carries must not be tagged already. The
    // pre-merge guard read a hypothetical merge; this is the commit that will be released. After
    // the merge there is no `fix` — only `keep` (archive incomplete, reason version_not_bumped).
    // The effective definition includes the ad-hoc one: it deploys, so it is bound by the contract.
    let effectiveDone = doneDef;
    if (effectiveDone === undefined && ctx.doneAdhocFile) {
      try { effectiveDone = JSON.parse(fs.readFileSync(ctx.doneAdhocFile, 'utf8')); } catch (e) { return { op: 'ask', ask: 'dispatch-error', error: `cannot read the ad-hoc definition of done (${ctx.doneAdhocFile}): ${e.message}` }; }
    }
    if (effectiveDone && effectiveDone !== 'none' && effectiveDone.version_from) {
      const doneDefForVersion = effectiveDone;
      let version;
      try { version = versionAtRevision(ctx.MAIN, sha, doneDefForVersion.version_from); } catch (e) { return { op: 'ask', ask: 'dispatch-error', error: `cannot read ${doneDefForVersion.version_from} at the deploy base ${sha.slice(0, 12)}: ${e.message} — the release guard fails closed before deploy_base` }; }
      const tag = `v${version}`;
      // The gate, once opened for this base, is DURABLE and is read before any live lookup: a
      // deleted tag, or an origin that has since gone away, is not the version bump it asked for, so
      // it keeps standing — and `keep` can always answer it — without consulting the network at all.
      const recordedGate = [...events].reverse().find((e) => e.type === 'version_gate' && e.phase === 'deploy_base' && e.sha === sha);
      if (recordedGate) {
        if (ctx.choice === 'keep') {
          appendEvent(ctx.absState, { type: 'incomplete_authorized', ts: ctx.ts, reason: 'version_not_bumped', version: recordedGate.version, tag: recordedGate.tag, where: recordedGate.where, disposition_sha: sha });
          return null; // the run archives incomplete through the existing archive step
        }
        return { op: 'ask', ask: 'gate', gate: 'version_not_bumped', version: recordedGate.version, tag: recordedGate.tag, where: recordedGate.where, after_merge: true, sha, choices: ['keep'], recorded: true };
      }
      const where = [];
      if (tagExists(ctx.MAIN, tag)) where.push('local');
      let hasOrigin = false;
      try { runGit(ctx.MAIN, ['remote', 'get-url', 'origin']); hasOrigin = true; } catch { hasOrigin = false; }
      if (hasOrigin) {
        // An unreachable origin is NOT evidence of an absent tag: fail closed (§7.1).
        try { if (tagExists(ctx.MAIN, tag, { remote: 'origin' })) where.push('origin'); } catch (e) {
          if (where.length === 0) return { op: 'ask', ask: 'dispatch-error', error: `cannot verify whether ${tag} already exists on origin (${e.message}) — the release guard fails closed before deploy_base; retry when origin is reachable`, version, tag };
        }
      }
      if (where.length) {
        appendEvent(ctx.absState, { type: 'version_gate', ts: ctx.ts, phase: 'deploy_base', version, tag, where, sha });
        return { op: 'ask', ask: 'gate', gate: 'version_not_bumped', version, tag, where, after_merge: true, sha, choices: ['keep'] };
      }
    }
    if (doneDef === undefined) {
      if (ctx.doneAdhocFile) {
        fs.copyFileSync(ctx.doneAdhocFile, path.join(ctx.bundleDir, 'done-adhoc.json'));
        const adhoc = JSON.parse(fs.readFileSync(ctx.doneAdhocFile, 'utf8'));
        const digest = doneDigest(adhoc);
        appendEvent(ctx.absState, { type: 'done_adhoc', ts: ctx.ts, digest });
        appendEvent(ctx.absState, { type: 'deploy_base', ts: ctx.ts, sha, branch_tip: branchTip, done_sha256: digest });
        ctx.doneDefinition = adhoc;
      } else if (ctx.deployAbortIncomplete) {
        appendEvent(ctx.absState, { type: 'incomplete_authorized', ts: ctx.ts, reason: 'no_definition_of_done', disposition_sha: sha });
        return null; // the run archives incomplete through the existing archive step
      } else {
        return { op: 'ask', ask: 'gate', gate: 'no_definition_of_done', choices: ['adhoc', 'abort-incomplete'] };
      }
    } else if (doneDef === 'none') {
      const digest = doneDigest('none');
      appendEvent(ctx.absState, { type: 'deploy_base', ts: ctx.ts, sha, branch_tip: branchTip, done_sha256: digest });
      return null;
    } else {
      const digest = doneDigest(doneDef);
      appendEvent(ctx.absState, { type: 'deploy_base', ts: ctx.ts, sha, branch_tip: branchTip, done_sha256: digest });
      ctx.doneDefinition = doneDef;
    }
  } else {
    const doneDef = resolveBoundDone(ctx, deployBaseEvent);
    if (doneDef === undefined) {
      return { op: 'ask', ask: 'gate', gate: 'no_definition_of_done', choices: ['adhoc', 'abort-incomplete'] };
    } else if (doneDef === 'none') {
      return null;
    } else {
      ctx.doneDefinition = doneDef;
    }
  }

  const groups = orderDeployGroups(ctx.doneDefinition);
  for (const group of groups) {
    const steps = ctx.doneDefinition[group] || [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const index = i;
      const stepEvent = events.find((e) => e.type === 'deploy_step' && e.group === group && e.index === index && e.sha === deployBaseSha);
      if (stepEvent) continue;
      if (events.some((e) => e.type === 'incomplete_authorized' && e.reason === `deploy_skip:${group}[${index}]`)) continue; // operator skipped it (archives incomplete)
      const outcome = latestStepOutcome(events, group, index, deployBaseSha);
      if (outcome === 'failed' || outcome === 'indeterminate') {
        // A recorded failure halts the stage until the operator resolves it (§7.2).
        const gate = outcome === 'failed' ? 'deploy_failed' : 'deploy_indeterminate';
        return { op: 'ask', ask: 'gate', gate, group, index, choices: outcome === 'failed' ? failedChoices(group) : indeterminateChoices(step) };
      }
      // Authorizations and starts are PAIRED in ledger order: every start consumes exactly one
      // preceding authorization. Merely asking whether an authorization exists somewhere would
      // accept `authorized, start, start` (the second start is an unauthorized rerun, and the
      // command it ran is exactly what the recovery probe would then record as this run's) and
      // `start, authorized` (an orphan start read as an authorization awaiting one).
      let pendingAuth = 0;
      let authorizedEvent = null;
      let sawStart = false;
      for (const e of events) {
        if (e.group !== group || e.index !== index || e.sha !== deployBaseSha) continue;
        if (e.type === 'deploy_step_authorized') {
          pendingAuth += 1;
          authorizedEvent = e;
        } else if (e.type === 'deploy_step_started') {
          if (pendingAuth === 0) {
            throw new Error(`finish-step: ${group}[${index}] has a deploy_step_started with no preceding deploy_step_authorized at ${deployBaseSha.slice(0, 12)} — the ledger is inconsistent and recovery is refused`);
          }
          pendingAuth -= 1;
          sawStart = true;
        }
      }
      // pendingAuth > 0: the latest authorization has no start (a death in that window).
      // pendingAuth === 0 with a start seen: the latest authorization was started — the crash window.
      const startedEvent = pendingAuth === 0 && sawStart;
      if (group === 'user_only') {
        return { op: 'ask', ask: 'handback', group, index, text: step.text, check: step.check };
      }
      if (!authorizedEvent) {
        if (ctx.autonomy === 'gated' && !(ctx.deployAuthorize && ctx.deployAuthorize.group === group && ctx.deployAuthorize.index === index)) {
          return { op: 'run_deploy_step', group, index, run: step.run, check: step.check, cwd: ctx.MAIN, ask: true };
        } else {
          assertDeployAuthorizable(ctx, deployBaseSha, ctx.doneDefinition);
          appendEvent(ctx.absState, { type: 'deploy_step_authorized', ts: ctx.ts, group, index, sha: deployBaseSha });
        }
      } else if (!startedEvent) {
        // An authorization recovered from a prior turn (a death before the start was recorded) is not
        // a licence to launch now: the base may have moved or the tree gone dirty since. Re-audit
        // before every start, never only at the authorization.
        assertDeployAuthorizable(ctx, deployBaseSha, ctx.doneDefinition);
      }
      if (startedEvent) {
        // Crash window: the command was started but never reported. Never rerun blindly — probe the
        // step's check (§7.2 recovery): 0 → recorded done from the probe; 1 → failed (fresh
        // authorization needed); anything else, or no check to probe → indeterminate gate.
        const probe = step.check ? runCheck(step.check, ctx.MAIN) : null;
        if (step.check && probe === 0) {
          const produced = stepCommitsSince(ctx, events, deployBaseSha, ctx.doneDefinition);
          // §7.2 push_archive producer: the check-only recovery record is a deploy_step receipt
          // like any other — an install step it proves pushed the base carries pushed_base too.
          const receipt = recordPushedBase(ctx, produced, group, index, detectBase(runGit(ctx.MAIN, ['branch', '--format=%(refname:short)'])), deployBaseSha);
          appendEvent(ctx.absState, { type: 'deploy_step', ts: ctx.ts, group, index, exit: 0, status: 'done', check_exit: 0, sha: deployBaseSha, source: 'recovery-probe', ...receipt });
          continue;
        }
        const producedOnProbe = stepCommitsSince(ctx, events, deployBaseSha, ctx.doneDefinition);
        if (step.check && probe === 1) {
          appendEvent(ctx.absState, { type: 'deploy_failed', ts: ctx.ts, group, index, exit: 0, check_exit: 1, sha: deployBaseSha, ...producedOnProbe });
          return { op: 'ask', ask: 'gate', gate: 'deploy_failed', group, index, error: 'started step absent on recovery probe', choices: failedChoices(group) };
        }
        appendEvent(ctx.absState, { type: 'deploy_indeterminate', ts: ctx.ts, group, index, exit: 0, check_exit: step.check ? probe : -1, sha: deployBaseSha, ...producedOnProbe });
        return { op: 'ask', ask: 'gate', gate: 'deploy_indeterminate', group, index, choices: indeterminateChoices(step) };
      }
      appendEvent(ctx.absState, { type: 'deploy_step_started', ts: ctx.ts, group, index, sha: deployBaseSha });
      return { op: 'run_deploy_step', group, index, run: step.run, check: step.check, cwd: ctx.MAIN, ask: false };
    }
  }
  // Every step is recorded: the last boundary audit before the stage completes (§7.3), so a final
  // step's stray output can never reach the archive unaudited.
  assertDeployAuthorizable(ctx, deployBaseSha, ctx.doneDefinition);
  return null;
}

export function finishStep({
  statePath,
  self = null,
  now,
  ttlMs,
  force = false,
  verify = null, // 'pass' | 'fail' — the shell's answer to a run_verify op (or a gate override)
  review = null, // 'done' | 'skipped' — the shell's answer to a run_adversary_review op
  reviewCount = null,
  reviewBase = null,
  reviewDigestFile = null,
  reviewReason = null,
  docsSuppressed = false, // one-invocation suppression of the docs_normalize offer (no event)
  docs = null, // 'normalized' | 'skipped' — the shell's answer to the docs_normalize gate
  docsCount = null,
  docsReason = null,
  choice = null, // merge | pr | keep | discard — the branch_finish gate resolution
  pushed = false, // the pr choice's second phase: the shell confirms push/PR ran (Codex r5 P1)
  removalForce = false, // intended-dirty teardown: pass --force to `worktree remove`
  retroOnly = false,
  goalCheck = null, // null | 'failed' — the shell's signal that assessor dispatch FAILED (fail-closed → manual goals_unmet gate)
  goalsChoice = null, // 'fix' | 'waiver' | 'abort' — the shell's answer to the goals_unmet gate
  deployAuthorize = null, // {group, index} — the shell's answer to a run_deploy_step ask
  deployStepDone = null, // {group, index, exit, digest} — the shell's report after running a step
  doneAdhocFile = null, // path to a JSON file with ad-hoc done steps (no_definition_of_done gate)
  deployAbortIncomplete = false, // archive incomplete on no_definition_of_done
  deployRetry = null, // {group,index} — fresh authorization after deploy_failed
  deployRerun = null, // {group,index} — fresh authorization after deploy_indeterminate
  deploySkip = null, // {group,index} — skip a failed step (archives incomplete)
  deployAttest = null, // {group,index} — attest a check-less indeterminate step
  deployAbort = false, // abort the deploy stage (archives incomplete)
  intentConfirmed = false, // §7.3: the operator's answer to intent_confirm — archives COMPLETE
  intentRejected = null, // §7.5: {class, reason, successor} — archives incomplete
  merged = false, // PR path: the branch was merged on the remote
  mergeSha = null, // PR path: the merge commit that becomes the deploy base
  versionFix = false, // version_not_bumped gate: stop so the branch can bump version_from (the run stays resumable)
  archivePushed = null, // §7.2 push_archive: {sha} — the archive was pushed to origin (archive_pushed event)
  archivePushSkipped = null, // §7.2 push_archive: {reason} — decline; the archive stays pushed: no (archive_push_skipped)
  skillRoot = null, // §5.5 finding 3: the installed skill root the finish checkpoint's identity guard recomputes under
} = {}) {
  if (!statePath) throw new Error('finish-step: statePath is required');
  const absState = path.resolve(statePath);
  const bundleDir = path.dirname(absState);
  let state = readState(absState);
  const slug = state.slug ?? path.basename(bundleDir);

  // Guard D — same default-on acquire/confirm as continueRun; finish mutates the bundle and
  // tears down the worktree, so a concurrent owner is a hard stop, never an auto-steal.
  const ownerLockOff = state.concurrency?.owner_lock === 'off';
  if (!ownerLockOff) {
    if (!self) throw new Error('finish-step: owner identity required (Guard D is on) — pass self, or seed with --owner-lock=off');
    const acq = acquireOwner(bundleDir, self, { now, force, ttlMs });
    if (acq.outcome === 'blocked') {
      return { op: 'ask', ask: 'owner-blocked', reason: acq.reason, incumbent: acq.incumbent ?? null };
    }
    const hb = heartbeatOwner(bundleDir, self, { now });
    if (hb.outcome !== 'held-by-self') {
      return { op: 'ask', ask: 'owner-lost', reason: hb.reason, incumbent: hb.incumbent ?? null };
    }
  }

  const MAIN = path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const branch = worktreeBranchFor(slug);
  const WT = state.worktree ?? worktreePathFor(MAIN, slug);
  const ts = new Date(now ?? Date.now()).toISOString();
  const retroPath = path.join(bundleDir, 'retro.md');
  const digestPath = path.join(bundleDir, 'adversary-review-digest.txt');

  const autonomy = state.autonomy === 'full' ? 'loose' : (state.autonomy ?? 'gated');
  const ctx = {
    statePath, absState, bundleDir, state, slug,
    MAIN, branch, WT, ts, retroPath, digestPath,
    self, now, ownerLockOff, ttlMs, skillRoot,
    verify, review, reviewCount, reviewBase, reviewDigestFile, reviewReason,
    docsSuppressed, docs, docsCount, docsReason,
    choice, pushed, removalForce, retroOnly,
    goalCheck, goalsChoice, force,
    deployAuthorize, deployStepDone, doneAdhocFile, deployAbortIncomplete, autonomy,
    deployRetry, deployRerun, deploySkip, deployAttest, deployAbort, merged, mergeSha, versionFix,
    intentConfirmed, intentRejected,
    archivePushed, archivePushSkipped,
  };
  ctx.wtHead = () => runGit(ctx.WT, ['rev-parse', 'HEAD']);

  const answer = applyShellAnswers(ctx);
  if (answer) return answer;
  return evaluateFinishMachine(ctx);
}
