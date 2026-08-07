// lib/finish-step.mjs — the §2c finalization flow as a re-entrant state machine (T2.4).
//
// finishStep is the finish flow the orchestrator prose used to BE: the re-entry shortcuts,
// the WT snapshot, the dirty-commit, the verified-at-SHA check, retro write-if-absent, the
// codex-review durable guard + event, the durable branch_finish gate, the chosen disposition
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
//                                                 — shell runs `agent-dispatch review --class
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
// ops (push/gh/agent-dispatch review) stay shell-side. CD-7: every durable write goes through
// bundle.mjs; the bundle commits happen at the two §2c milestones that owned them in prose —
// gate resolution and archive.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  readState, writeState, openGate, clearGate, setStatus, setVerifiedSha,
  setWorktreeDisposition, appendEvent, inferGoalsCapability,
} from './bundle.mjs';
import { acquireOwner, heartbeatOwner, releaseOwner } from './owner-fs.mjs';
import { worktreePathFor, worktreeBranchFor, dispositionAfterTeardown } from './worktree.mjs';
import {
  classifyDirt, detectBase, detectBaseAuto, EMPTY_TREE_SHA,
  collectVerifyCommands, isVerified, dispositionForChoice,
  filterDocCandidates,
} from './finish.mjs';
import { selectReentry } from './reentry-guard.mjs';
import { goalsHash, parseGoals } from './goals.mjs';
import { runGit } from './watch-integrity.mjs';
import { execFileSync } from 'node:child_process';

// runGit trims output — fatal for porcelain v1, whose first line's leading status column
// (e.g. " M path") would lose its space and shift classifyDirt's path slice. Read it raw.
function gitPorcelain(dir) {
  return String(execFileSync(
    'git', ['-C', dir, '-c', 'core.quotePath=false', 'status', '--porcelain'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
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
function parseEventArray(eventsText) {
  return String(eventsText || '')
    .split('\n')
    .map((l) => { const t = l.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } })
    .filter(Boolean);
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
  const gHash = goalsHash(goalsMd);
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
    if (ctx.state.pending_gate?.id === 'goals_unmet') {
      ctx.state = clearGate(ctx.state);
      writeState(ctx.absState, ctx.state);
    }
    if (ctx.goalsChoice === 'abort') return { op: 'stop', reason: 'finish_aborted_goals_unmet' };
    if (ctx.goalsChoice === 'fix') return { op: 'stop', reason: 'goals_unmet_fix' };
    // 'waiver': gate cleared — fall through to the machine, which re-evaluates and proceeds.
  }

  // ---- B. the branch_finish gate resolution (the prose's "act" turn, now a transaction) ----

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
    if (!RETIRED.has(ctx.state.worktree_disposition)) {
      if (ctx.choice === 'pr' && !ctx.pushed) {
        // Phase 1 of the pr handshake: NOTHING durable changes — the gate stays open so a death
        // before the push re-renders branch_finish instead of silently archiving with no PR
        // (Codex r5 P1). The shell pushes/opens the PR, then re-calls --choice=pr --pushed.
        return { op: 'shell', kind: 'push_pr', branch: ctx.branch, base: detectedBase(), wt: ctx.WT };
      }
      const branchExists = () => {
        try { runGit(ctx.MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`]); return true; } catch { return false; }
      };
      if (ctx.choice === 'merge' && !(!fs.existsSync(ctx.WT) && !branchExists())) {
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
      const disp = dispositionAfterTeardown(ctx.choice, removalConfirmed);
      if (disp !== null) ctx.state = setWorktreeDisposition(ctx.state, disp);
      writeState(ctx.absState, ctx.state);
      appendEvent(ctx.absState, { type: 'branch_finish', ts: ctx.ts, note: ctx.choice });
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

function evaluateFinishMachine(ctx) {
  // ---- C. evaluate the machine top-down (every step re-entrant) ----

  if (ctx.retroOnly) {
    if (!fs.existsSync(ctx.retroPath)) return { op: 'write_retro', path: ctx.retroPath, retro_only: true };
    return { op: 'stop', reason: 'retro_done', path: ctx.retroPath };
  }

  // 1. Re-entry shortcut / archive LAST. Read MAIN-side with NO WT git — the teardown removed
  //    <WT> before this point, so a WT snapshot here would die (the Codex P1 the prose fixed).
  if (RETIRED.has(ctx.state.worktree_disposition)) {
    if (ctx.state.status !== 'archived') {
      ctx.state = setStatus(ctx.state, 'archived');
      writeState(ctx.absState, ctx.state);
    }
    commitBundle(ctx.MAIN, ctx.bundleDir, `masterplan(${ctx.slug}): archive run (finish complete)`);
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

  const ctx = {
    statePath, absState, bundleDir, state, slug,
    MAIN, branch, WT, ts, retroPath, digestPath,
    self, now, ownerLockOff, ttlMs,
    verify, review, reviewCount, reviewBase, reviewDigestFile, reviewReason,
    docsSuppressed, docs, docsCount, docsReason,
    choice, pushed, removalForce, retroOnly,
    goalCheck, goalsChoice, force,
  };
  ctx.wtHead = () => runGit(ctx.WT, ['rev-parse', 'HEAD']);

  const answer = applyShellAnswers(ctx);
  if (answer) return answer;
  return evaluateFinishMachine(ctx);
}
