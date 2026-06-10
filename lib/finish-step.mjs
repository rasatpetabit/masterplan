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
import {
  classifyDirt, detectBase, collectVerifyCommands, isVerified, dispositionForChoice,
  filterDocCandidates,
} from './finish.mjs';
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
  docsSuppressed = false, // one-invocation suppression of the docs_normalize offer (no event)
  docs = null, // 'normalized' | 'skipped' — the shell's answer to the docs_normalize gate
  docsCount = null,
  docsReason = null,
  choice = null, // merge | pr | keep | discard — the branch_finish gate resolution
  pushed = false, // the pr choice's second phase: the shell confirms push/PR ran (Codex r5 P1)
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

  if (docs === 'normalized' || docs === 'skipped') {
    // Idempotent replay guard: a death between this append and the clearGate below makes the shell
    // re-answer — presence of either event means the append already landed, so only the gate clears.
    const type = docs === 'normalized' ? 'docs_normalize' : 'docs_normalize_skipped';
    if (!hasEventType(readEvents(absState), type)) {
      const count = Number.isFinite(Number(docsCount)) ? Number(docsCount) : null;
      appendEvent(absState, {
        type,
        ts,
        summary: docs === 'normalized'
          ? `finish docs normalization complete — ${count ?? '?'} file(s) folded into repo docs`
          : `finish docs normalization skipped — ${docsReason ?? 'user kept plan-organized docs'}`,
        data: { sha: wtHead(), ...(docs === 'normalized' ? { count } : {}) },
      });
    }
    if (state.pending_gate?.id === 'docs_normalize') {
      state = clearGate(state);
      writeState(absState, state);
    }
  }

  // ---- B. the branch_finish gate resolution (the prose's "act" turn, now a transaction) ----

  if (choice !== null) {
    if (!FINISH_CHOICES.includes(choice)) {
      throw new Error(`finish-step: unknown --choice '${choice}' — expected one of: ${FINISH_CHOICES.join(', ')}`);
    }
    // The base the gate advertised — read from MAIN's branch list (survives a removed WT).
    const detectedBase = () => {
      try { return detectBase(runGit(MAIN, ['branch', '--format=%(refname:short)'])); } catch { return null; }
    };
    // Re-entry guard: disposition already retired means the action ran AND was recorded in a
    // prior turn (death before clear-gate) — never re-run the action, just resolve the gate.
    if (!RETIRED.has(state.worktree_disposition)) {
      if (choice === 'pr' && !pushed) {
        // Phase 1 of the pr handshake: NOTHING durable changes — the gate stays open so a death
        // before the push re-renders branch_finish instead of silently archiving with no PR
        // (Codex r5 P1). The shell pushes/opens the PR, then re-calls --choice=pr --pushed.
        return { op: 'shell', kind: 'push_pr', branch, base: detectedBase(), wt: WT };
      }
      const branchExists = () => {
        try { runGit(MAIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; }
      };
      if (choice === 'merge' && !(!fs.existsSync(WT) && !branchExists())) {
        // Skipped only on the full-teardown crash replay: branch-gone + WT-gone proves the
        // prior merge landed (the post-merge `-d` is the sole branch deleter), so re-merging
        // a deleted ref would strand the run on dispatch-error (Codex r6 P2). Otherwise:
        // The merge lands on whatever MAIN has checked out — require that to BE the base the
        // gate advertised, never a silent merge into an unrelated branch (Codex r5 P2).
        const base = detectedBase();
        const mainHead = runGit(MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (!base || mainHead !== base) {
          return {
            op: 'ask', ask: 'dispatch-error',
            error: `merge target mismatch: MAIN has '${mainHead}' checked out but the detected base is '${base ?? 'unknown'}' — switch MAIN to the base branch (or resolve manually) and re-issue --choice=merge`,
          };
        }
        try {
          runGit(MAIN, ['merge', '--no-edit', branch]);
        } catch (e) {
          try { runGit(MAIN, ['merge', '--abort']); } catch { /* nothing to abort */ }
          return { op: 'ask', ask: 'dispatch-error', error: `merge of ${branch} into ${base} failed: ${e.message}` };
        }
      }
      let removalConfirmed = false;
      if (choice === 'merge' || choice === 'discard') {
        if (!fs.existsSync(WT)) {
          // A replay after a crash between removal and the disposition write: the path being
          // gone IS the confirmation — prune the dangling admin entry and retire (Codex r5 P2).
          try { runGit(MAIN, ['worktree', 'prune']); } catch { /* best-effort */ }
          removalConfirmed = true;
        } else {
          const args = ['worktree', 'remove'];
          if (choice === 'discard' || removalForce) args.push('--force');
          try {
            runGit(MAIN, [...args, WT]);
            removalConfirmed = true;
          } catch {
            removalConfirmed = false; // disposition stays active → reaped by the next sweep
          }
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
      // Hydrate WT-side facts defensively: a crash inside a merge/discard teardown can leave the
      // gate open with the WT already removed — re-render from MAIN-side refs (the branch tip
      // survives) so the user can re-issue the same --choice (replay is idempotent: the path
      // being gone confirms the removal).
      let head = null;
      try { head = fs.existsSync(WT) ? wtHead() : runGit(MAIN, ['rev-parse', `refs/heads/${branch}`]); } catch { /* branch retired too */ }
      let base = null;
      try { base = detectBase(runGit(MAIN, ['branch', '--format=%(refname:short)'])); } catch { /* no base detectable */ }
      const events = readEvents(absState);
      const review = head ? selectCodexReviewForHead(events, head) : { present: false };
      Object.assign(out, {
        head,
        branch,
        base,
        wt_missing: !fs.existsSync(WT) || undefined,
        dispositions: Object.fromEntries(FINISH_CHOICES.map((c) => [c, dispositionForChoice(c)])),
        codex: review.present ? review : null,
      });
    } else if (gate === 'docs_normalize') {
      // The candidate list is deterministic (diff vs merge-base) — recompute on every re-render
      // rather than persisting it in pending_gate (state.yml scalars stay small; survives
      // compaction for free). Defensive like the branch_finish branch: any failure → nulls.
      let head = null;
      try { head = fs.existsSync(WT) ? wtHead() : null; } catch { /* unreadable WT */ }
      let base = null;
      try { base = detectBase(runGit(WT, ['branch', '--format=%(refname:short)'])); } catch { /* no base detectable */ }
      const candidates = base ? listDocCandidates(WT, base, path.relative(MAIN, bundleDir)) : null;
      Object.assign(out, {
        head,
        base,
        candidates,
        wt_missing: !fs.existsSync(WT) || undefined,
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

  // 4.5 Docs-normalization offer — candidates-gated; durable event guard (presence, not sha —
  //     accepting moves HEAD by design, and the offer fires once per run). Sits BEFORE
  //     verification so the normalization commit lands before verified_sha is recorded: the
  //     suite runs exactly once, over the FINAL tree (and the codex review covers the docs).
  const events = readEvents(absState);
  if (
    docsNormalizeArmed(state.docs?.normalize) && !docsSuppressed && docs === null &&
    !hasEventType(events, 'docs_normalize') && !hasEventType(events, 'docs_normalize_skipped')
  ) {
    const docsBase = detectBase(runGit(WT, ['branch', '--format=%(refname:short)']));
    const candidates = docsBase ? listDocCandidates(WT, docsBase, path.relative(MAIN, bundleDir)) : [];
    if (candidates.length > 0) {
      state = openGate(state, { id: 'docs_normalize', opened_at: ts });
      writeState(absState, state);
      return { op: 'ask', ask: 'gate', gate: 'docs_normalize', candidates, base: docsBase, head, wt: WT };
    }
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
