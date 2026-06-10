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
//   • { op:'run_codex_review', base, head, wt, digest_path }
//                                                 — shell resolves `mp codex-companion-path`,
//                                                   runs the whole-branch review (network),
//                                                   re-calls --codex=done|skipped; the durable
//                                                   event is written HERE on the answer
//   • { op:'ask', ask:'gate', gate, ... }         — a durable gate is open: render its AUQ
//                                                   (branch_finish carries base/branch/codex
//                                                   rehydrate; the PR probe is shell-side gh)
//   • { op:'ask', ask:'owner-blocked'|'owner-lost'|'dispatch-error' } — Guard D / loud invariant
//   • { op:'shell', kind:'push_pr', branch, base, wt } — the pr choice's network half
//   • { op:'stop', reason:'archived'|'retro_done' } — terminal; archive ran in code
//
// Boundary notes (same seam as wave-commit/continue): LOCAL git only, -C-qualified to MAIN/WT
// loci derived here (snapshot, dirty-commit, merge, worktree remove, bundle commit). Network
// ops (push/gh/codex-companion) stay shell-side. CD-7: every durable write goes through
// bundle.mjs; the bundle commits happen at the two §2c milestones that owned them in prose —
// gate resolution and archive.

import fs from 'node:fs';
import path from 'node:path';

import {
  readState, writeState, openGate, clearGate, setStatus, setVerifiedSha,
  setWorktreeDisposition, appendEvent,
} from './bundle.mjs';
import { acquireOwner, heartbeatOwner, releaseOwner } from './owner-fs.mjs';
import { worktreePathFor, worktreeBranchFor, dispositionAfterTeardown } from './worktree.mjs';
import { classifyDirt, detectBase, collectVerifyCommands, isVerified, dispositionForChoice } from './finish.mjs';
import { selectCodexReviewForHead } from './codex-companion.mjs';
import { runGit } from './wave-commit.mjs';
import { execFileSync } from 'node:child_process';

// runGit trims output — fatal for porcelain v1, whose first line's leading status column
// (e.g. " M path") would lose its space and shift classifyDirt's path slice. Read it raw.
function gitPorcelain(dir) {
  return String(execFileSync(
    'git', ['-C', dir, '-c', 'core.quotePath=false', 'status', '--porcelain'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
}

export const FINISH_CHOICES = ['merge', 'pr', 'keep', 'discard'];
const RETIRED = new Set(['removed_after_merge', 'kept_by_user']);
const VERIFY_GATES = new Set(['verification_failed', 'no_verification_command']);

function codexArmed(raw) {
  return raw === true || raw === 'on' || raw === 'true';
}

function readEvents(statePath) {
  try {
    return fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

function hasCodexSkipAtSha(eventsText, sha) {
  for (const line of eventsText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec?.type === 'codex_review_skipped' && rec.data?.sha === sha) return true;
  }
  return false;
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

export function finishStep({
  statePath,
  self = null,
  now,
  ttlMs,
  force = false,
  codexSuppressed = false,
  verify = null, // 'pass' | 'fail' — the shell's answer to a run_verify op (or a gate override)
  codex = null, // 'done' | 'skipped' — the shell's answer to a run_codex_review op
  codexCount = null,
  codexBase = null,
  codexDigestFile = null,
  codexReason = null,
  choice = null, // merge | pr | keep | discard — the branch_finish gate resolution
  removalForce = false, // intended-dirty teardown: pass --force to `worktree remove`
  retroOnly = false,
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
  const digestPath = path.join(bundleDir, 'codex-review-digest.txt');

  const wtHead = () => runGit(WT, ['rev-parse', 'HEAD']);

  // ---- A. apply the shell's answers (each is a durable transaction in its own right) ----

  if (verify === 'pass') {
    // PASS (or a reviewed "proceed anyway" override on a verification gate): record the SHA so
    // a re-entry at unchanged HEAD skips the re-run — then resolve any verification gate.
    state = setVerifiedSha(state, wtHead());
    if (state.pending_gate && VERIFY_GATES.has(state.pending_gate.id)) state = clearGate(state);
    writeState(absState, state);
  } else if (verify === 'fail') {
    state = openGate(state, { id: 'verification_failed', opened_at: ts });
    writeState(absState, state);
    return { op: 'ask', ask: 'gate', gate: 'verification_failed', head: wtHead(), wt: WT };
  }

  if (codex === 'done') {
    const head = wtHead();
    let note;
    if (codexDigestFile) {
      try { note = fs.readFileSync(codexDigestFile, 'utf8'); } catch { /* digest optional */ }
    }
    const record = {
      type: 'codex_review',
      ts,
      // the literal "codex review" is the audit signal (\bcodex\s+review\b)
      summary: `codex review complete (whole-branch, base ${codexBase ?? 'unknown'}) — ${codexCount ?? '?'} findings`,
      data: { sha: head, base: codexBase ?? null, count: Number.isFinite(Number(codexCount)) ? Number(codexCount) : null },
    };
    if (note !== undefined) record.note = note;
    appendEvent(absState, record);
  } else if (codex === 'skipped') {
    // Fail-soft, never wedge finish — the hyphenated phrasing deliberately does NOT match the
    // audit's \bcodex\s+review\b, so a degraded finish still trips configured-but-zero-invocations.
    appendEvent(absState, {
      type: 'codex_review_skipped',
      ts,
      summary: `whole-branch codex-companion review skipped (degraded) — ${codexReason ?? 'unspecified'}`,
      data: { sha: wtHead() },
    });
  }

  // ---- B. the branch_finish gate resolution (the prose's "act" turn, now a transaction) ----

  if (choice !== null) {
    if (!FINISH_CHOICES.includes(choice)) {
      throw new Error(`finish-step: unknown --choice '${choice}' — expected one of: ${FINISH_CHOICES.join(', ')}`);
    }
    // Re-entry guard: disposition already retired means the action ran AND was recorded in a
    // prior turn (death before clear-gate) — never re-run the action, just resolve the gate.
    if (!RETIRED.has(state.worktree_disposition)) {
      if (choice === 'merge') {
        try {
          runGit(MAIN, ['merge', '--no-edit', branch]);
        } catch (e) {
          try { runGit(MAIN, ['merge', '--abort']); } catch { /* nothing to abort */ }
          return { op: 'ask', ask: 'dispatch-error', error: `merge of ${branch} into base failed: ${e.message}` };
        }
      }
      let removalConfirmed = false;
      if (choice === 'merge' || choice === 'discard') {
        const args = ['worktree', 'remove'];
        if (choice === 'discard' || removalForce) args.push('--force');
        try {
          runGit(MAIN, [...args, WT]);
          removalConfirmed = true;
        } catch {
          removalConfirmed = false; // disposition stays active → reaped by the next sweep
        }
        if (removalConfirmed) {
          // branch retire is best-effort: -d after merge (proven merged), -D on discard
          try { runGit(MAIN, ['branch', choice === 'discard' ? '-D' : '-d', branch]); } catch { /* leave it */ }
        }
      }
      const disp = dispositionAfterTeardown(choice, removalConfirmed);
      if (disp !== null) state = setWorktreeDisposition(state, disp);
      writeState(absState, state);
      appendEvent(absState, { type: 'branch_finish', ts, note: choice });
    }
    state = clearGate(state);
    writeState(absState, state);
    commitBundle(MAIN, bundleDir, `masterplan(${slug}): branch_finish resolved (${choice})`);
    if (choice === 'pr') {
      // the network half stays shell-side; re-call after the push archives (disposition retired)
      let base = null;
      try { base = detectBase(runGit(WT, ['branch', '--format=%(refname:short)'])); } catch { /* WT gone — shell knows the base */ }
      return { op: 'shell', kind: 'push_pr', branch, base, wt: WT };
    }
    if (!RETIRED.has(state.worktree_disposition)) {
      // merge/discard whose worktree removal failed: nothing is lost, but the run cannot
      // retire — surface it rather than silently re-opening the same gate.
      return {
        op: 'ask', ask: 'dispatch-error',
        error: `worktree removal failed for ${WT} — disposition stays 'active'; remove it (or re-run with --removal-force) and re-enter finish`,
      };
    }
    // fall through to the archive shortcut below
  }

  // ---- C. evaluate the machine top-down (every step re-entrant) ----

  if (retroOnly) {
    if (!fs.existsSync(retroPath)) return { op: 'write_retro', path: retroPath, retro_only: true };
    return { op: 'stop', reason: 'retro_done', path: retroPath };
  }

  // 1. Re-entry shortcut / archive LAST. Read MAIN-side with NO WT git — the teardown removed
  //    <WT> before this point, so a WT snapshot here would die (the Codex P1 the prose fixed).
  if (RETIRED.has(state.worktree_disposition)) {
    if (state.status !== 'archived') {
      state = setStatus(state, 'archived');
      writeState(absState, state);
    }
    commitBundle(MAIN, bundleDir, `masterplan(${slug}): archive run (finish complete)`);
    if (!ownerLockOff && self) {
      releaseOwner(bundleDir, self, { now, ttlMs }); // the bundle is done; never block a successor
    }
    return { op: 'stop', reason: 'archived', slug, disposition: state.worktree_disposition };
  }

  // 2. A still-open gate (no resolving answer arrived this call) → re-render it (CD-9).
  if (state.pending_gate) {
    const gate = state.pending_gate.id;
    const out = { op: 'ask', ask: 'gate', gate, wt: WT };
    if (gate === 'branch_finish') {
      const head = wtHead();
      const events = readEvents(absState);
      const review = selectCodexReviewForHead(events, head);
      Object.assign(out, {
        head,
        branch,
        base: detectBase(runGit(WT, ['branch', '--format=%(refname:short)'])),
        dispositions: Object.fromEntries(FINISH_CHOICES.map((c) => [c, dispositionForChoice(c)])),
        codex: review.present ? review : null,
      });
    }
    return out;
  }

  // 3. Snapshot — from WT (isolates MAIN-side dirt; protect-user-work for free).
  if (!fs.existsSync(WT)) {
    return {
      op: 'ask', ask: 'dispatch-error',
      error: `worktree ${WT} is missing but worktree_disposition is '${state.worktree_disposition ?? 'unset'}' (not retired) — reconcile with mp sweep, or record the disposition`,
    };
  }
  let head = wtHead();
  const taskFiles = (state.tasks ?? []).flatMap((t) => t.files ?? []);
  const dirt = classifyDirt(gitPorcelain(WT), taskFiles);

  // 4. Dirty-commit (thin net): task-scope paths commit in WT; unrelated dirt stays untouched.
  if (dirt.taskScopeDirty) {
    runGit(WT, ['add', '--', ...dirt.taskScopePaths]);
    runGit(WT, ['commit', '-q', '-m', `masterplan(${slug}): finish dirty-commit (task scope)`]);
    head = wtHead(); // verified must reflect the NEW commit — never skip on a stale SHA
  }

  // 5. Verification gate — verified-at-SHA skip; otherwise the shell runs the skill.
  if (!isVerified(state.verified_sha ?? null, head)) {
    let commands = [];
    const planIndexPath = state.plan_index_path ?? path.join(bundleDir, 'plan.index.json');
    if (fs.existsSync(planIndexPath)) {
      try { commands = collectVerifyCommands(JSON.parse(fs.readFileSync(planIndexPath, 'utf8'))); } catch { /* empty union */ }
    }
    return { op: 'run_verify', commands, head, wt: WT };
  }

  // 6. Retro (write-if-absent).
  if (!fs.existsSync(retroPath)) return { op: 'write_retro', path: retroPath };

  // 7. Whole-branch codex review — durable re-entry guard keyed on the WT code tip. The
  //    review run itself is network → shell; suppression/skip is recorded durably above.
  const base = detectBase(runGit(WT, ['branch', '--format=%(refname:short)']));
  const events = readEvents(absState);
  if (
    codexArmed(state.codex?.review) && base && !codexSuppressed && codex === null &&
    !selectCodexReviewForHead(events, head).present && !hasCodexSkipAtSha(events, head)
  ) {
    return { op: 'run_codex_review', base, head, wt: WT, digest_path: digestPath };
  }

  // 8. Open the durable branch_finish gate (the v8 regression §2c restored) and ask.
  state = openGate(state, { id: 'branch_finish', opened_at: ts });
  writeState(absState, state);
  const review = selectCodexReviewForHead(events, head);
  return {
    op: 'ask',
    ask: 'gate',
    gate: 'branch_finish',
    head,
    branch,
    base,
    wt: WT,
    dispositions: Object.fromEntries(FINISH_CHOICES.map((c) => [c, dispositionForChoice(c)])),
    codex: review.present ? review : null,
  };
}
