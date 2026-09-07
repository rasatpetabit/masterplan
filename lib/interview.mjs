// lib/interview.mjs — replayable interview ledger (wave task 11).
//
// Deterministic verbs over events.jsonl, each an append through the bundle writer
// (appendEvent, CD-7 single writer). All state is DERIVED BY REPLAY — no in-memory
// counters, no hand-edited state.yml. See spec §4.2 (budgets), §5.3 (verbs), §5.4
// (terminal states).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_PROBING_MINIMUM } from './config.mjs';
import { appendEvent, readState } from './bundle.mjs';

// ---- budgets (spec §4.2) -----------------------------------------------------
// floor: minimum answered questions; intent_floor: minimum answered intent-kind;
// cap: maximum asked (withdrawn counts against it); intent_rounds_min: minimum
// completed intent rounds; critic: configured critic mode. Values are verbatim from
// the §4.2 table (low 1/1/1/4, medium 4/3/2/10, high 8/6/4/20).
export const BUDGETS = {
  low:    { floor: 1, intent_floor: 1, intent_rounds_min: 1, cap: 4,  critic: 'off' },
  medium: { floor: 4, intent_floor: 3, intent_rounds_min: 2, cap: 10, critic: 'on' },
  high:   { floor: 8, intent_floor: 6, intent_rounds_min: 4, cap: 20, critic: 'on' },
};

function budgetFor(state) {
  return BUDGETS[state.complexity] || BUDGETS.medium;
}

// ---- digests ----------------------------------------------------------------

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// sha256 of the canonical JSON of an intent draft — the digest the critic receipt's
// intent_sha256 must name (honesty bound, §5.3).
export function intentSha(intent) {
  return sha256(JSON.stringify(canonicalize(intent)));
}

// ---- event loading -----------------------------------------------------------

function eventsPathFor(statePath) {
  return path.join(path.dirname(statePath), 'events.jsonl');
}

function loadEvents(statePath) {
  const p = eventsPathFor(statePath);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines.map((l) => JSON.parse(l));
}

function bundleDir(statePath) {
  return path.dirname(statePath);
}

// ---- replay ------------------------------------------------------------------

// Replays events.jsonl and derives the full interview ledger state. Pure (no fs
// writes). Returns a rich object consumed by every verb and by the status/replay
// operations.
export function replayInterview(statePath) {
  const state = readState(statePath);
  const events = loadEvents(statePath);
  const budget = budgetFor(state);

  const questions = new Map(); // id -> {id, round, kind, text, answer, corrected, withdrawn, supersedes, resolves}
  const rounds = new Map();    // round -> {sealed, kinds:Set, firstQuestionIndex, lastContentEventIndex}
  const drafts = [];           // {intent, sha, index}
  const criticReceipts = [];   // {n, dispatch_id, model, output_tokens, payload_sha256, content_head, intent_sha256, unknown_count, index, payload}
  const unavailability = [];   // {error, contentHead, index}

  let asked = 0;
  let answered = 0;
  let withdrawn = 0;
  let contentHead = -1;
  let terminal = null;
  let terminalReason = null;
  let reopened = false;

  // active design picks: id -> answer object (design answers not superseded)
  const activeDesignPicks = new Map();

  // Track critic mode: off if budget.critic==='off'; else on unless two consecutive
  // unavailability at the same content_head.
  let criticMode = budget.critic === 'off' ? 'off' : 'on';
  let unavailAtHead = 0;
  let lastUnavailHead = -1;
  let unavailAck = null; // durable critic_unavailable_ack answer, valid only while the critic is unavailable at this head

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const type = ev.type;

    // Terminal / reopen handling
    if (type === 'interview_end') {
      terminal = ev.reason;
      terminalReason = ev.reason;
      reopened = false;
    } else if (type === 'interview_waived') {
      terminal = 'waived';
      terminalReason = ev.reason || null;
      reopened = false;
    } else if (type === 'interview_reopened') {
      terminal = null;
      terminalReason = null;
      reopened = true;
    }

    if (type === 'interview_question') {
      const q = {
        id: ev.id,
        round: ev.round,
        kind: ev.kind,
        text: ev.text,
        answer: null,
        corrected: false,
        withdrawn: false,
        supersedes: ev.supersedes || null,
        resolves: ev.resolves || null,
        index: i,
      };
      questions.set(q.id, q);
      asked += 1;
      if (!rounds.has(q.round)) {
        rounds.set(q.round, { sealed: false, kinds: new Set(), firstQuestionIndex: i, lastContentEventIndex: -1 });
      }
      const r = rounds.get(q.round);
      r.kinds.add(q.kind);
      if (q.kind === 'intent') {
        contentHead = i;
        r.lastContentEventIndex = i;
      }
      // A question itself does not seal the round.
    } else if (type === 'interview_answer') {
      const q = questions.get(ev.id);
      if (q) {
        q.answer = ev.text;
        q.corrected = ev.corrected === true;
        q.resolves = ev.resolves || q.resolves;
        if (ev.supersedes) q.supersedes = ev.supersedes;
        answered += 1;
        // Seal the round on the first answer after any of its questions.
        const r = rounds.get(q.round);
        if (r && !r.sealed) r.sealed = true;
        // Design picks: track active set.
        if (q.kind === 'design') {
          if (q.supersedes) activeDesignPicks.delete(q.supersedes);
          activeDesignPicks.set(q.id, q);
        }
        // Intent answers move the content head.
        if (q.kind === 'intent') {
          contentHead = i;
          if (r) r.lastContentEventIndex = i;
        }
      }
    } else if (type === 'interview_withdraw') {
      const q = questions.get(ev.id);
      if (q) {
        q.withdrawn = true;
        q.resolves = ev.resolves || q.resolves;
        withdrawn += 1;
        const r = rounds.get(q.round);
        if (r && !r.sealed) r.sealed = true;
        // Withdraw of an intent-kind question moves the head.
        if (q.kind === 'intent') {
          contentHead = i;
          if (r) r.lastContentEventIndex = i;
        }
      }
    } else if (type === 'interview_draft') {
      const intent = ev.intent;
      const sha = intentSha(intent);
      drafts.push({ intent, sha, index: i });
      contentHead = i;
      // A draft seals the round it belongs to? Spec: a round seals on the first
      // answer, withdraw, draft, or critic event recorded after any of its questions.
      // We don't know which round a draft belongs to; treat it as sealing the
      // current (last) round if any.
      if (rounds.size > 0) {
        const lastRound = [...rounds.keys()].sort((a, b) => a - b).pop();
        const r = rounds.get(lastRound);
        if (r && !r.sealed) r.sealed = true;
        r.lastContentEventIndex = i;
      }
    } else if (type === 'interview_critic') {
      const receipt = {
        n: ev.n,
        dispatch_id: ev.dispatch_id,
        model: ev.model,
        output_tokens: ev.output_tokens,
        payload_sha256: ev.payload_sha256,
        content_head: ev.content_head,
        intent_sha256: ev.intent_sha256,
        unknown_count: ev.unknown_count,
        ...(Array.isArray(ev.eligible_question_set) ? { eligible_question_set: [...ev.eligible_question_set] } : {}),
        ...(typeof ev.forks_remaining === 'boolean' ? { forks_remaining: ev.forks_remaining } : {}),
        index: i,
        tampered: false,
      };
      // Load the payload artifact to expose unknowns/contradictions/misclassified.
      const payloadPath = path.join(bundleDir(statePath), `interview-critic-${ev.n}.json`);
      if (fs.existsSync(payloadPath)) {
        try {
          const payloadText = fs.readFileSync(payloadPath, 'utf8');
          const payloadSha = sha256(payloadText);
          if (payloadSha === ev.payload_sha256) {
            receipt.payload = JSON.parse(payloadText);
            receipt.tampered = false;
          } else {
            receipt.payload = null;
            receipt.tampered = true;
          }
        } catch {
          receipt.payload = null;
          receipt.tampered = true;
        }
      } else {
        receipt.payload = null;
        receipt.tampered = false;
      }
      // A receipt is evidence only while its digest-bound artifact is present, intact and well-formed.
      receipt.valid = receipt.payload !== null && !receipt.tampered && CRITIC_PAYLOAD_LISTS.every((k) => Array.isArray(receipt.payload[k]));
      criticReceipts.push(receipt);
      // A critic receipt seals the round it follows (the current round).
      if (rounds.size > 0) {
        const lastRound = [...rounds.keys()].sort((a, b) => a - b).pop();
        const r = rounds.get(lastRound);
        if (r && !r.sealed) r.sealed = true;
      }
      // A VALID critic receipt resets the unavailability streak and restores availability; an
      // invalid one (missing/tampered/malformed artifact) is not evidence of anything and changes no state.
      if (receipt.valid) {
        unavailAtHead = 0;
        lastUnavailHead = -1;
        unavailAck = null;
        if (budget.critic !== 'off') criticMode = 'on';
      }
    } else if (type === 'critic_unavailable') {
      unavailability.push({ error: ev.error, contentHead, index: i });
      if (contentHead === lastUnavailHead) {
        unavailAtHead += 1;
      } else {
        // first failure at a NEW head: any stale unavailability from an older head is void
        unavailAtHead = 1;
        lastUnavailHead = contentHead;
        unavailAck = null;
        if (budget.critic !== 'off') criticMode = 'on';
      }
      if (unavailAtHead >= 2 && budget.critic !== 'off') criticMode = 'unavailable'; // off stays off
    } else if (type === 'critic_unavailable_ack') {
      // Acknowledgment does not change critic mode; replay retains it (bound to the unavailable head)
      // so the exhausted exit is derivable from the ledger alone.
      if (criticMode === 'unavailable' && lastUnavailHead === contentHead) unavailAck = ev.answer ?? null;
    }
  }

  // Critic unavailability is bound to the content head it was observed at: once the intent
  // content moved on, the critic must fail twice again at the NEW head before it counts.
  if (criticMode === 'unavailable' && lastUnavailHead !== contentHead) criticMode = budget.critic === 'off' ? 'off' : 'on';
  const criticUnavailableAck = criticMode === 'unavailable' ? unavailAck : null;
  const unavailableAtHead = unavailability.filter((u) => u.contentHead === contentHead).length;

  // Active design picks are derived order-independently: a pick is superseded when ANY answered
  // design question names it, whichever answer was recorded first.
  const supersededIds = new Set();
  for (const q of questions.values()) {
    if (q.kind === 'design' && q.answer !== null && !q.withdrawn && q.supersedes) supersededIds.add(q.supersedes);
  }
  activeDesignPicks.clear();
  for (const q of questions.values()) {
    if (q.kind === 'design' && q.answer !== null && !q.withdrawn && !supersededIds.has(q.id)) activeDesignPicks.set(q.id, q);
  }
  // Compute active uncorrected design picks.
  let activeUncorrectedDesignPicks = 0;
  for (const q of activeDesignPicks.values()) {
    if (!q.corrected) activeUncorrectedDesignPicks += 1;
  }

  // Compute completed intent rounds: a round with at least one intent-kind question
  // that is answered, and every question in the round answered or withdrawn.
  let completedIntentRounds = 0;
  for (const [round, r] of rounds) {
    if (!r.kinds.has('intent')) continue;
    const qs = [...questions.values()].filter((q) => q.round === round);
    const allResolved = qs.every((q) => q.answer !== null || q.withdrawn);
    const hasAnsweredIntent = qs.some((q) => q.kind === 'intent' && q.answer !== null);
    if (allResolved && hasAnsweredIntent) completedIntentRounds += 1;
  }

  const answeredIntent = [...questions.values()].filter((q) => q.kind === 'intent' && q.answer !== null).length;
  const latestDraft = drafts.length ? drafts[drafts.length - 1] : null;
  const latestCriticReceipt = criticReceipts.length ? criticReceipts[criticReceipts.length - 1] : null;

  return {
    state,
    budget,
    events,
    questions,
    rounds,
    drafts,
    criticReceipts,
    unavailability,
    unavailableAtHead,
    criticUnavailableAck,
    asked,
    answered,
    answeredIntent,
    withdrawn,
    contentHead,
    terminal,
    terminalReason,
    reopened,
    activeDesignPicks,
    activeUncorrectedDesignPicks,
    completedIntentRounds,
    latestDraft,
    latestCriticReceipt,
    criticMode,
  };
}

// ---- status ------------------------------------------------------------------

export function interviewStatus(statePath) {
  const r = replayInterview(statePath);
  return {
    asked: r.asked,
    answered: r.answered,
    floor: r.budget.floor,
    cap: r.budget.cap,
    active_design_picks: r.activeUncorrectedDesignPicks,
    critic: {
      mode: r.criticMode,
      receipts: r.criticReceipts.length,
      latest_unknowns: r.latestCriticReceipt ? r.latestCriticReceipt.unknown_count : 0,
    },
    state: r.terminal,
    content_head: r.contentHead,
    complexity: r.state.complexity,
  };
}

// ---- helpers -----------------------------------------------------------------

function assertNotTerminal(r) {
  if (r.terminal) {
    throw new Error(`interview is ${r.terminal} — mutating verbs are refused until reopen`);
  }
}

function parseQuestionId(id) {
  const m = /^Q(\d+)$/.exec(String(id));
  if (!m) throw new Error(`invalid question id ${JSON.stringify(id)} — expected Q<n>`);
  return Number(m[1]);
}

function currentRound(r) {
  let max = 0;
  for (const round of r.rounds.keys()) {
    if (round > max) max = round;
  }
  return max;
}

function hasUnansweredEarlierRound(r, round) {
  for (const q of r.questions.values()) {
    if (q.round < round && q.answer === null && !q.withdrawn) return true;
  }
  return false;
}

function roundIsSealed(r, round) {
  const rr = r.rounds.get(round);
  return rr ? rr.sealed : false;
}

function previousIntentRound(r, round) {
  // The largest intent-kind round strictly less than `round`.
  let prev = null;
  for (const [rn, rr] of r.rounds) {
    if (rn < round && rr.kinds.has('intent')) {
      if (prev === null || rn > prev) prev = rn;
    }
  }
  return prev;
}

function hasCriticAfterRound(r, round) {
  // True if a critic receipt exists with index > the round's last content event index.
  const rr = r.rounds.get(round);
  if (!rr) return false;
  const lastContent = rr.lastContentEventIndex;
  if (lastContent === -1) return false;
  return r.criticReceipts.some((c) => c.valid && c.index > lastContent);
}

function latestDraftSha(r) {
  return r.latestDraft ? r.latestDraft.sha : null;
}

function readPayload(r, receipt) {
  return receipt.payload;
}

const CRITIC_PAYLOAD_LISTS = ['unknowns', 'contradictions', 'misclassified'];

// A structurally complete critic payload: an object carrying every required list as an array.
function assertCriticPayloadShape(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('critic payload must be a JSON object');
  for (const k of CRITIC_PAYLOAD_LISTS) {
    if (!Array.isArray(payload[k])) throw new Error(`critic payload is missing the ${k} array`);
  }
}

function payloadClean(payload) {
  if (!payload || !CRITIC_PAYLOAD_LISTS.every((k) => Array.isArray(payload[k]))) return false; // malformed is never clean
  return CRITIC_PAYLOAD_LISTS.every((k) => payload[k].length === 0);
}

// ---- mutating verbs ----------------------------------------------------------

// Ledger payload validation: every verb refuses a malformed event BEFORE appending it, so replay
// never has to tolerate an undefined text, a missing intent, or a fabricated critic outcome.
function requireText(value, what) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${what} requires non-empty text`);
}

const INTENT_TEXT_FIELDS = ['why', 'outcome', 'done_means'];
function assertIntentShape(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('draft requires an intent object');
  for (const k of INTENT_TEXT_FIELDS) requireText(intent[k], `intent.${k}`);
  if (!Array.isArray(intent.anti_goals)) throw new Error('intent.anti_goals must be an array');
  for (const g of intent.anti_goals) requireText(g, 'each intent.anti_goals entry');
}

/**
 * §5.5 enforcement at the SCHEMA-BACKED operation boundary (review round 2 — finding 3):
 * on a CAPTURED bundle every schema-backed recorder operation guards the installed
 * skill's identity BEFORE it appends. A legacy bundle (no capture) is exempt — no
 * capture, no identity to guard — and the ONE exemption (`mp interview
 * amend-skill-identity`) never routes through here. The guard's failure vocabulary
 * propagates verbatim (skill_identity_changed, skill_absent, host_contract_unsupported,
 * schema_unsupported, undeclared_dependency, plus the seam/module named failures), and
 * where the installed skill is not RESOLVABLE at the operation the operation FAILS CLOSED
 * with the named refusal — never proceeds on an unresolved identity, never falls back to
 * native questioning or a live schema.
 */
function guardSchemaBackedOperation(statePath, skillRoot) {
  const ledger = replaySchemaCapture(statePath);
  if (!ledger.captured) return; // legacy bundle: exempt — no capture, no identity to guard
  if (skillRoot === undefined || skillRoot === null || String(skillRoot).trim() === '') {
    throw new Error(
      `skill_absent: the installed skill root is not available to this schema-backed operation — the §5.5 identity guard recomputes the installed skill's identity, and an operation that cannot resolve it stops (pass --skill-root / the skillRoot the capture used); there is no fallback to native questioning or a live schema`
    );
  }
  assertSkillIdentity({ statePath, skillRoot });
}

export function askQuestion({ statePath, id, round, kind, text, supersedes, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  requireText(text, 'question');
  requireText(kind, 'question kind');
  const qid = parseQuestionId(id);
  if (r.questions.has(id)) throw new Error(`duplicate question id ${id}`);
  // Out-of-sequence id: must be exactly the next integer after the max existing.
  let maxId = 0;
  for (const existing of r.questions.keys()) {
    const n = parseQuestionId(existing);
    if (n > maxId) maxId = n;
  }
  if (qid !== maxId + 1) {
    throw new Error(`question id out of sequence — expected Q${maxId + 1}, got ${id}`);
  }
  if (!Number.isInteger(round) || round < 1) throw new Error(`round must be a positive integer, got ${round}`);
  const cur = currentRound(r);
  if (round !== cur && round !== cur + 1) {
    throw new Error(`round must be current (${cur}) or next (${cur + 1}), got ${round}`);
  }
  if (hasUnansweredEarlierRound(r, round)) {
    throw new Error('an earlier round has an unanswered question — answer or withdraw it first');
  }
  if (roundIsSealed(r, round)) {
    throw new Error(`round ${round} is sealed — the next ask must use round ${round + 1}`);
  }
  if (r.asked >= r.budget.cap) {
    throw new Error(`cap reached (${r.budget.cap}) — no further asks allowed`);
  }
  // High-complexity intent cadence: an intent ask opening a new round is refused
  // while the previous intent round has no critic receipt after its last content event.
  if (r.state.complexity === 'high' && kind === 'intent') {
    const prev = previousIntentRound(r, round); // the latest intent round strictly before this one, however this round was opened
    if (prev !== null && !hasCriticAfterRound(r, prev)) {
      throw new Error(
        `high complexity: previous intent round ${prev} has no critic receipt after its last content event — record one before opening round ${round}`
      );
    }
  }
  const event = { type: 'interview_question', id, round, kind, text };
  if (supersedes) event.supersedes = supersedes;
  appendEvent(statePath, event);
}

export function answerQuestion({ statePath, id, text, corrected, supersedes, resolves, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  const q = r.questions.get(id);
  if (!q) throw new Error(`unknown question id ${id}`);
  if (q.withdrawn) throw new Error(`question ${id} was withdrawn`);
  if (q.answer !== null) throw new Error(`question ${id} already answered`);
  requireText(text, 'answer');
  const event = { type: 'interview_answer', id, text };
  if (corrected) event.corrected = true;
  if (supersedes) event.supersedes = supersedes;
  if (resolves) event.resolves = resolves;
  appendEvent(statePath, event);
}

export function withdrawQuestion({ statePath, id, reason, resolves, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  const q = r.questions.get(id);
  if (!q) throw new Error(`unknown question id ${id}`);
  if (q.withdrawn) throw new Error(`question ${id} already withdrawn`);
  if (q.answer !== null) throw new Error(`question ${id} already answered — cannot withdraw`);
  const event = { type: 'interview_withdraw', id };
  if (reason) event.reason = reason;
  if (resolves) event.resolves = resolves;
  appendEvent(statePath, event);
}

export function recordDraft({ statePath, intent, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  // Refuse while no intent-kind question has been answered.
  const hasIntentAnswer = [...r.questions.values()].some(
    (q) => q.kind === 'intent' && q.answer !== null
  );
  if (!hasIntentAnswer) {
    throw new Error('draft refused — no intent-kind question has been answered yet');
  }
  assertIntentShape(intent);
  appendEvent(statePath, { type: 'interview_draft', intent });
}

export function recordCritic({ statePath, receipt, payloadPath, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  if (!receipt.dispatch_id) throw new Error('critic receipt requires dispatch_id');
  if (!receipt.model) throw new Error('critic receipt requires model');
  if (!(receipt.output_tokens > 0)) throw new Error('critic receipt requires positive output_tokens');
  if (receipt.content_head !== r.contentHead) {
    throw new Error(`stale receipt — content_head ${receipt.content_head} != current ${r.contentHead}`);
  }
  const draftSha = latestDraftSha(r);
  if (!draftSha) throw new Error('stale receipt — no draft recorded yet');
  if (r.latestDraft.index !== r.contentHead) {
    throw new Error('stale receipt — the latest draft is not the current intent-content event (record a new draft first)');
  }
  if (receipt.intent_sha256 !== draftSha) {
    throw new Error(`stale receipt — intent_sha256 ${receipt.intent_sha256} != latest draft ${draftSha}`);
  }
  // Compute payload digest and copy the artifact.
  const payloadText = fs.readFileSync(payloadPath, 'utf8');
  const payloadSha = sha256(payloadText);
  let parsedPayload;
  try { parsedPayload = JSON.parse(payloadText); } catch (e) { throw new Error(`critic payload is not valid JSON: ${e.message}`); }
  assertCriticPayloadShape(parsedPayload);
  const unknownCount = Array.isArray(parsedPayload?.unknowns) ? parsedPayload.unknowns.length : 0;
  if (receipt.unknown_count !== undefined && receipt.unknown_count !== unknownCount) {
    throw new Error(`receipt unknown_count ${receipt.unknown_count} contradicts the payload (${unknownCount} unknowns)`);
  }
  if (receipt.payload_sha256 && receipt.payload_sha256 !== payloadSha) {
    throw new Error(`payload digest mismatch — receipt ${receipt.payload_sha256} != file ${payloadSha}`);
  }
  // §5.3 adjudication (task 53): the critic's eligible set is the ONLY eligibility source
  // where a critic runs — and the RECORDER rejects the whole set if it names an unknown,
  // duplicate, withdrawn, unanswered, or design-kind id. The verdict is a boolean.
  let eligibleQuestionSet;
  let forksRemaining;
  if (parsedPayload.eligible_question_set !== undefined) {
    if (!Array.isArray(parsedPayload.eligible_question_set)) {
      throw new Error('critic payload eligible_question_set must be an array of question ids');
    }
    const seen = new Set();
    for (const id of parsedPayload.eligible_question_set) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error(`eligible_question_set entry ${JSON.stringify(id)} is not a question id`);
      }
      if (seen.has(id)) {
        throw new Error(`eligible_question_set names ${id} more than once — a duplicate is refused with the whole set`);
      }
      seen.add(id);
      const q = r.questions.get(id);
      if (!q) {
        throw new Error(`eligible_question_set names unknown question ${id} — the set is refused, never trimmed`);
      }
      if (q.kind === 'design') {
        throw new Error(`eligible_question_set names design-kind question ${id} — design picks never count toward the probing minimum`);
      }
      if (q.withdrawn) {
        throw new Error(`eligible_question_set names withdrawn question ${id} — withdrawn questions never count`);
      }
      if (q.answer === null) {
        throw new Error(`eligible_question_set names unanswered question ${id} — only answered questions count`);
      }
    }
    eligibleQuestionSet = [...seen];
  }
  if (parsedPayload.forks_remaining !== undefined) {
    if (typeof parsedPayload.forks_remaining !== 'boolean') {
      throw new Error('critic payload forks_remaining must be a boolean verdict');
    }
    forksRemaining = parsedPayload.forks_remaining;
  }
  if ((eligibleQuestionSet === undefined) !== (forksRemaining === undefined)) {
    throw new Error('eligible_question_set and forks_remaining arrive together — an adjudication carries both, or neither');
  }
  const n = r.criticReceipts.length + 1;
  const dest = path.join(bundleDir(statePath), `interview-critic-${n}.json`);
  fs.mkdirSync(bundleDir(statePath), { recursive: true });
  fs.copyFileSync(payloadPath, dest);
  const event = {
    type: 'interview_critic',
    n,
    dispatch_id: receipt.dispatch_id,
    model: receipt.model,
    output_tokens: receipt.output_tokens,
    payload_sha256: payloadSha,
    content_head: receipt.content_head,
    intent_sha256: receipt.intent_sha256,
    unknown_count: unknownCount,
    ...(eligibleQuestionSet !== undefined ? { eligible_question_set: eligibleQuestionSet } : {}),
    ...(forksRemaining !== undefined ? { forks_remaining: forksRemaining } : {}),
  };
  appendEvent(statePath, event);
}

export function recordCriticUnavailable({ statePath, error }) {
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  requireText(error, 'critic failure');
  if (r.budget.critic === 'off') throw new Error('critic failure refused — the critic is off at this complexity');
  // A critic can only fail against a dispatchable draft: the latest draft must be the current head,
  // exactly as recordCritic requires — otherwise unavailability could be fabricated with no draft at all.
  if (!r.latestDraft || r.latestDraft.index !== r.contentHead) {
    throw new Error('critic failure refused — no draft at the current content head (record a draft first)');
  }
  appendEvent(statePath, { type: 'critic_unavailable', error });
}

export function acknowledgeCriticUnavailable({ statePath, answer }) {
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  if (answer === undefined || answer === null) throw new Error('acknowledgement requires an answer');
  if (r.criticMode !== 'unavailable' || r.unavailableAtHead < 2) throw new Error('nothing to acknowledge — the critic is not unavailable at the current content head');
  appendEvent(statePath, { type: 'critic_unavailable_ack', answer });
}

// ---- §5.3/§5.4 schema-backed convergence (task 53) ---------------------------

/**
 * The policy in force: an interview with an approved schema capture is SCHEMA-BACKED —
 * §5.3's two conditions (coverage + probing) replace the three legacy floors. The policy
 * is resolved AT the terminal evaluation and PERSISTED on the event ("Which policy judged
 * an interview", §5.4): a terminal event is read under the policy it was recorded against
 * and never revalidated under a later one — capture on a terminal interview is refused
 * and starts a new interview (§5.5, task 52), so adoption is forward-only by construction.
 */
function interviewPolicy(statePath) {
  return replaySchemaCapture(statePath).captured ? 'schema_backed' : 'legacy';
}

/**
 * §5.3 PROBING: which answered questions count toward the minimum — never the
 * questioner's own judgment. Where a critic runs, only a CURRENT receipt's eligible set
 * counts (a stale set counts for nothing; a receipt without a set cannot satisfy the
 * minimum at all — the acknowledged-unavailable path included); at low complexity the
 * critic is off, so eligibility is the recorder's own MECHANICAL test and the forks
 * verdict is not consulted. Re-verified against the ledger at evaluation time: an id that
 * has since been withdrawn stops counting, and an inconsistent set counts for nothing.
 */
function evaluateProbing({ statePath: _statePath, r, probingMinimum }) {
  const min =
    Number.isInteger(probingMinimum) && probingMinimum >= 1
      ? probingMinimum
      : (DEFAULT_PROBING_MINIMUM[r.state.complexity] ?? DEFAULT_PROBING_MINIMUM.medium);
  if (r.budget.critic === 'off') {
    let count = 0;
    for (const q of r.questions.values()) {
      // Mechanical test (spec §5.3): intent-kind, answered, not withdrawn, fresh in THIS
      // interview (every ledger question is — reused prior-context evidence never enters
      // the ledger as a question, so it can never count here).
      if (q.kind === 'intent' && q.answer !== null && !q.withdrawn) count += 1;
    }
    return { min, eligibleCount: count, source: 'mechanical', met: count >= min };
  }
  const receipt = r.latestCriticReceipt;
  const current =
    receipt && receipt.valid && receipt.content_head === r.contentHead && receipt.intent_sha256 === latestDraftSha(r)
      ? receipt
      : null;
  if (!current) {
    return {
      min, eligibleCount: 0, source: 'critic', met: false,
      unmet: 'no critic receipt is current for the latest draft — a stale eligible set counts for nothing, and without a current one the probing minimum cannot be satisfied at all (§5.3); the interview stays open for the operator',
    };
  }
  if (!Array.isArray(current.eligible_question_set)) {
    return {
      min, eligibleCount: 0, source: 'critic', met: false,
      unmet: 'the current critic receipt carries no eligible set — the probing minimum cannot be satisfied (§5.3); the interview stays open for the operator',
    };
  }
  // The set was validated at recordCritic; re-verify against the CURRENT ledger — a
  // post-receipt withdraw (or any drift) makes the set count for nothing rather than
  // silently trimming it.
  let consistent = true;
  for (const id of current.eligible_question_set) {
    const q = r.questions.get(id);
    if (!q || q.kind !== 'intent' || q.withdrawn || q.answer === null) consistent = false;
  }
  if (!consistent) {
    return {
      min, eligibleCount: 0, source: 'critic', met: false,
      unmet: 'the current eligible set no longer matches the ledger (a withdrawn or changed question) — it counts for nothing; a fresh critic run is required (§5.3)',
    };
  }
  return {
    min,
    eligibleCount: current.eligible_question_set.length,
    source: 'critic',
    met: current.eligible_question_set.length >= min,
    forksRemaining: current.forks_remaining,
  };
}

/**
 * §5.3 COVERAGE: every CHECKED section carries real evidence, each with its provenance
 * and its unresolved uncertainty stated. The checked set is the SCHEMA SNAPSHOT's
 * checked_sections (the §5.5 frozen read — the live skill file is never consulted); the
 * record is validated EXACTLY against it and copied beside state.yml with its digest on
 * the terminal event. A row sourced from prior context COVERS its section but is never an
 * answer (it never enters the probing count — only ledger questions do). A section with a
 * `fights` verdict is an unresolved conflict and refuses convergence; `unavailable`
 * evidence is never approval (draft §5: unavailable, never approval).
 */
function loadAndValidateCoverage({ statePath, coverageFile }) {
  if (coverageFile === undefined || coverageFile === null || String(coverageFile).trim() === '') {
    throw new Error('a schema-backed interview requires its section-coverage record (--coverage-file) — every checked section carries real evidence with provenance and stated uncertainty (§5.3)');
  }
  let raw;
  try {
    raw = fs.readFileSync(String(coverageFile), 'utf8');
  } catch (e) {
    throw new Error(`the section-coverage record is unreadable (${e.message}) — coverage cannot be evaluated from nothing`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the section-coverage record is not valid JSON (${e.message})`);
  }
  const rows = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.sections : null;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('the section-coverage record must be {sections: [{section, source, uncertainty, verdict?}]} — coverage is per checked section');
  }
  // The frozen snapshot is the checked-set authority (§5.5) — never the live skill file.
  const snap = readSchemaSnapshot({ statePath });
  const declared = snap.schema && Array.isArray(snap.schema.checked_sections) ? snap.schema.checked_sections : null;
  if (!declared || declared.length === 0 || declared.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new Error('the schema snapshot declares no checked_sections — coverage has no target set');
  }
  const verdicts = Array.isArray(snap.schema.check_verdicts) ? snap.schema.check_verdicts : [];
  const bySection = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('each coverage row must be an object {section, source, uncertainty, verdict?}');
    }
    if (typeof row.section !== 'string' || row.section.trim() === '') {
      throw new Error('each coverage row names its section');
    }
    if (bySection.has(row.section)) {
      throw new Error(`duplicate coverage row for section ${row.section}`);
    }
    bySection.set(row.section, row);
    if (!declared.includes(row.section)) {
      throw new Error(`coverage names section ${row.section}, which the schema snapshot does not declare as checked (declared: ${declared.join(', ')})`);
    }
    if (typeof row.source !== 'string' || row.source.trim() === '') {
      throw new Error(`coverage row for ${row.section} carries no provenance — every checked section carries real evidence with its source stated (§5.3)`);
    }
    if (typeof row.uncertainty !== 'string') {
      throw new Error(`coverage row for ${row.section} must state its unresolved uncertainty (a string — empty means none unresolved) (§5.3)`);
    }
    if (row.verdict !== undefined) {
      if (!verdicts.includes(row.verdict)) {
        throw new Error(`coverage row for ${row.section} carries verdict ${JSON.stringify(row.verdict)}, which is not a schema check verdict (${verdicts.join(', ')})`);
      }
      if (row.verdict === 'fights') {
        throw new Error(`coverage row for ${row.section} is a FIGHTS verdict — an unresolved conflict prevents convergence and is a real decision for the owner (draft §5)`);
      }
      if (row.verdict === 'unavailable') {
        throw new Error(`coverage row for ${row.section} is UNAVAILABLE — missing or unreadable evidence is unavailable, never approval (draft §5)`);
      }
    }
  }
  for (const section of declared) {
    if (!bySection.has(section)) {
      throw new Error(`coverage is incomplete: checked section ${section} has no row (§5.3 — missing evidence prevents convergence)`);
    }
  }
  // The durable copy: exact bytes beside state.yml, digest on the terminal event.
  const dest = path.join(bundleDir(statePath), 'interview-section-coverage.json');
  fs.mkdirSync(bundleDir(statePath), { recursive: true });
  fs.writeFileSync(dest, raw);
  return { coverageSha256: sha256(raw), rows: [...bySection.values()], sections: [...declared] };
}

export function endInterview({ statePath, reason, criticUnavailableAck, coverageFile, probingMinimum, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  if (!['converged', 'exhausted', 'critic_off'].includes(reason)) {
    throw new Error(`invalid end reason ${JSON.stringify(reason)}`);
  }
  // Zero unanswered questions.
  const unanswered = [...r.questions.values()].some((q) => q.answer === null && !q.withdrawn);
  if (unanswered) throw new Error('there are unanswered questions — answer or withdraw them first');

  const hasDraft = r.latestDraft !== null;
  // The draft must be the latest intent-content event (no intent answer after it).
  const draftIsLatest = hasDraft && r.latestDraft.index === r.contentHead;

  // §5.4 "Which policy judged an interview": resolve the policy HERE, substitute the
  // convergence conditions under it, and persist it on the terminal event. The three legacy
  // floors apply to a LEGACY interview as written; a SCHEMA-BACKED interview is judged by
  // §5.3's two conditions instead (coverage + probing). Everything else — zero unanswered,
  // the latest-draft rule, the per-state critic evidence — governs BOTH unchanged.
  const policy = interviewPolicy(statePath);
  let coverage = null;
  let probing = null;
  if (policy === 'legacy') {
    const floorMet = r.answered >= r.budget.floor;
    const intentFloorMet = r.answeredIntent >= r.budget.intent_floor;
    const roundsMet = r.completedIntentRounds >= r.budget.intent_rounds_min;
    // §5.4: every terminal state other than `waived` needs the floors, the intent-round minimum and a
    // draft as the latest intent-content event — a cap reached with the floor unmet leaves only the waiver.
    if (!floorMet) throw new Error(`${reason} requires the answer floor met (${r.answered}/${r.budget.floor}; withdrawn questions never count)`);
    if (!intentFloorMet) throw new Error(`${reason} requires the intent floor met (${r.answeredIntent}/${r.budget.intent_floor})`);
    if (!roundsMet) throw new Error(`${reason} requires the intent-round minimum met (${r.completedIntentRounds}/${r.budget.intent_rounds_min})`);
  } else {
    coverage = loadAndValidateCoverage({ statePath, coverageFile });
    probing = evaluateProbing({ statePath, r, probingMinimum });
  }
  if (!hasDraft || !draftIsLatest) {
    throw new Error(`${reason} requires an interview_draft as the latest intent-content event`);
  }

  if (reason === 'converged') {
    if (r.activeUncorrectedDesignPicks < 1) {
      throw new Error('converged requires at least one active uncorrected design pick');
    }
    const receipt = r.latestCriticReceipt;
    if (!receipt) throw new Error('converged requires a critic receipt');
    if (receipt.content_head !== r.contentHead) throw new Error('converged requires a fresh critic receipt');
    if (receipt.intent_sha256 !== latestDraftSha(r)) throw new Error('converged requires a critic receipt matching the latest draft');
    if (!payloadClean(readPayload(r, receipt))) {
      throw new Error('converged requires a clean critic payload (zero unknowns/contradictions/misclassified)');
    }
    if (r.state.complexity === 'high') {
      // One distinct receipt per completed intent round.
      const distinct = new Set(r.criticReceipts.filter((c) => c.valid).map((c) => c.content_head));
      if (distinct.size < r.completedIntentRounds) {
        throw new Error('converged at high complexity requires one critic receipt per intent round');
      }
    }
    // §5.3: converged is judged by BOTH conditions — the probing minimum is NOT exempt here.
    if (policy === 'schema_backed' && !probing.met) {
      throw new Error(`converged requires the probing minimum met (${probing.eligibleCount}/${probing.min}${probing.unmet ? ` — ${probing.unmet}` : ''})`);
    }
  } else if (reason === 'exhausted') {
    const atCap = r.asked >= r.budget.cap;
    const ackGiven = criticUnavailableAck !== undefined && criticUnavailableAck !== null;
    const unavailableWithAck =
      r.criticMode === 'unavailable' &&
      r.unavailableAtHead >= 2 &&
      (ackGiven || r.criticUnavailableAck !== null);
    let basis = null;
    if (policy === 'legacy') {
      if (!atCap && !unavailableWithAck) {
        throw new Error('exhausted requires the cap reached or critic unavailable with an acknowledgement');
      }
      if (unavailableWithAck && ackGiven && r.criticUnavailableAck === null) {
        // A transient ack is made durable first; a ledger-recorded one (acknowledgeCriticUnavailable) is reused.
        appendEvent(statePath, { type: 'critic_unavailable_ack', answer: criticUnavailableAck });
      }
    } else {
      // §5.3/§5.4, NO new terminal states — the schema-backed grounds for the EXISTING
      // exhausted state, with the cap taking precedence where both predicates hold:
      if (atCap) {
        if (!probing.met) {
          throw new Error(
            `exhausted refused — the cap is reached with the probing minimum unmet (${probing.eligibleCount}/${probing.min}); the cap leaves only the waiver, whatever the critic said about remaining forks (§5.3/§5.4)`
          );
        }
        // At cap with the minimum met: exhausted by the cap.
      } else if (!probing.met && probing.forksRemaining === false) {
        // Coverage complete + no forks remaining before the minimum is met: forks_exhausted —
        // §5.4's SINGLE probing exemption (coverage and zero-unanswered still hold above).
        basis = 'forks_exhausted';
      } else if (unavailableWithAck) {
        throw new Error(
          'exhausted refused on the acknowledged-unavailable ground — a schema-backed interview has no current eligible set, so the probing minimum cannot be satisfied; the interview STAYS OPEN for the operator\u2019s waiver and never records exhausted first (§5.3)'
        );
      } else {
        throw new Error(
          `exhausted requires the cap reached (with the probing minimum met) or the forks_exhausted ground${probing.unmet ? ` — ${probing.unmet}` : ''} (§5.4)`
        );
      }
    }
    // The exhausted record retains every unresolved item of the latest AVAILABLE (valid) payload
    // and the critic attempts, so the spec's Assumptions table can be checked against it (§5.4).
    const latestValid = [...r.criticReceipts].reverse().find((c) => c.valid) || null;
    const p = latestValid ? latestValid.payload : null;
    const unresolved = {
      unknowns: p ? p.unknowns : [],
      contradictions: p ? p.contradictions : [],
      misclassified: p ? p.misclassified : [],
    };
    const attempts = r.criticReceipts.length + r.unavailability.length;
    appendEvent(statePath, {
      type: 'interview_end', reason, asked: r.asked, cap: r.budget.cap, attempts,
      critic_failures: r.unavailability.map((u) => u.error),
      payload_sha256: latestValid ? latestValid.payload_sha256 : null,
      ...unresolved,
      policy,
      ...(policy === 'schema_backed' ? { probing_minimum: probing.min, coverage_sha256: coverage.coverageSha256 } : {}),
      ...(basis ? { basis } : {}),
    });
    return;
  } else if (reason === 'critic_off') {
    if (r.state.complexity !== 'low') throw new Error('critic_off requires complexity low');
    if (policy === 'schema_backed' && !probing.met) {
      // §5.4 critic_off row: coverage complete and the probing minimum met under the
      // RECORDER's mechanical test (the critic is off at low — there is no adjudicator).
      throw new Error(`critic_off requires the probing minimum met under the recorder's mechanical test (${probing.eligibleCount}/${probing.min}) (§5.4)`);
    }
  }
  appendEvent(statePath, {
    type: 'interview_end', reason, policy,
    ...(policy === 'schema_backed' ? { probing_minimum: probing.min, coverage_sha256: coverage.coverageSha256 } : {}),
  });
}

export function waiveInterview({ statePath, reason, probingMinimum, skillRoot }) {
  guardSchemaBackedOperation(statePath, skillRoot);
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  requireText(reason, 'waiver reason');
  const policy = interviewPolicy(statePath);
  let cause;
  let probing = null;
  if (policy === 'legacy') {
    const floorUnmetAtCap = r.asked >= r.budget.cap && r.answered < r.budget.floor;
    if (floorUnmetAtCap) cause = 'floor_unmet_at_cap';
  } else {
    // §5.3: cap-with-minimum-unmet routes to the EXISTING waiver with the
    // probing_minimum_unmet_at_cap cause — the only exit once the cap is reached with the
    // minimum unmet, and no terminal state is manufactured to reach it.
    probing = evaluateProbing({ statePath, r, probingMinimum });
    if (r.asked >= r.budget.cap && !probing.met) cause = 'probing_minimum_unmet_at_cap';
  }
  appendEvent(statePath, {
    type: 'interview_waived', reason, policy,
    // The resolved minimum is part of the persisted policy identity (review finding, wave 13):
    // a waiver judged under one minimum stays readable under it after the config changes.
    ...(policy === 'schema_backed' ? { probing_minimum: probing.min } : {}),
    ...(cause ? { cause } : {}),
  });
}

export function reopenInterview({ statePath, reason }) {
  const r = replayInterview(statePath);
  if (r.state.phase !== 'brainstorm') {
    throw new Error('reopen allowed only while phase is brainstorm');
  }
  if (r.state.goals_frozen) {
    throw new Error('reopen refused — goals are frozen');
  }
  if (!r.terminal) {
    throw new Error('reopen refused — the interview is not ended or waived');
  }
  appendEvent(statePath, { type: 'interview_reopened', reason });
}

// ---- verbatim ledger replay --------------------------------------------------

export function replayLedger(statePath) {
  const r = replayInterview(statePath);
  const ledger = [];
  for (const ev of r.events) {
    if (ev.type === 'interview_question') {
      ledger.push({ type: 'question', id: ev.id, round: ev.round, kind: ev.kind, text: ev.text, ...(ev.supersedes ? { supersedes: ev.supersedes } : {}) });
    } else if (ev.type === 'interview_answer') {
      ledger.push({ type: 'answer', id: ev.id, text: ev.text, corrected: ev.corrected === true, ...(ev.supersedes ? { supersedes: ev.supersedes } : {}), ...(ev.resolves ? { resolves: ev.resolves } : {}) });
    } else if (ev.type === 'interview_withdraw') {
      ledger.push({ type: 'withdraw', id: ev.id, ...(ev.reason ? { reason: ev.reason } : {}), ...(ev.resolves ? { resolves: ev.resolves } : {}) });
    } else if (ev.type === 'interview_draft') {
      ledger.push({ type: 'draft', intent: ev.intent, intent_sha256: intentSha(ev.intent) });
    } else if (ev.type === 'interview_critic') {
      ledger.push({
        type: 'critic',
        n: ev.n,
        dispatch_id: ev.dispatch_id,
        model: ev.model,
        output_tokens: ev.output_tokens,
        payload_sha256: ev.payload_sha256,
        content_head: ev.content_head,
        intent_sha256: ev.intent_sha256,
        unknown_count: ev.unknown_count,
      });
    } else if (ev.type === 'critic_unavailable') {
      ledger.push({ type: 'critic_unavailable', error: ev.error });
    } else if (ev.type === 'critic_unavailable_ack') {
      ledger.push({ type: 'critic_unavailable_ack', answer: ev.answer });
    } else if (ev.type === 'interview_end') {
      ledger.push({ type: 'end', reason: ev.reason, ...(ev.reason === 'exhausted' ? { asked: ev.asked, cap: ev.cap, attempts: ev.attempts, unknowns: ev.unknowns, contradictions: ev.contradictions, misclassified: ev.misclassified } : {}) });
    } else if (ev.type === 'interview_waived') {
      ledger.push({ type: 'waived', reason: ev.reason });
    } else if (ev.type === 'interview_reopened') {
      ledger.push({ type: 'reopened', reason: ev.reason });
    }
  }
  return ledger;
}

// ---- §5.5/§6.1 schema capture + skill identity (task 58 surface; task 52 mechanics) ----
//
// The two design-intent amendment operations this surface owns:
//   capture-schema         — the approved schema-capture control: snapshot the installed
//                            skill's schema, stamp the durable format pin (§6.1), record the
//                            skill identity the §5.5 guards compare against.
//   amend-skill-identity   — the SINGLE guard-exempt, resumable identity replacement: a
//                            declaration (recomputed, never asserted) plus the operator's
//                            approval bound to the exact new identity. No adoption before
//                            that approval; an interrupted amendment replays from disk.
//
// The snapshot/identity MECHANICS are task 52's lib/schema-snapshot.mjs, registered here
// through the seam (SCHEMA_SNAPSHOT_MODULE_OPS). Until that module lands, the verbs fail
// loudly with the named schema_snapshot_module_not_implemented error — never fake success.
// The five §5.5 named guard failures propagate verbatim from the module through this
// surface. State is derived by replay (replaySchemaCapture) — the only durable writes are
// events: schema_captured, skill_identity_amended, and the pending declaration checkpoint.

export const SKILL_GUARD_FAILURES = [
  'skill_absent',
  'skill_identity_changed',
  'host_contract_unsupported',
  'schema_unsupported',
  'undeclared_dependency',
];

export const SCHEMA_SNAPSHOT_MODULE_OPS = ['captureSchemaSnapshot', 'computeSkillIdentity'];

// The bundle snapshot's filename — exact bytes of the skill's schema.json, copied at
// approved capture, a file beside state.yml. §5.5: a FROZEN bundle (or any later read)
// resolves THIS file, never the live skill file.
export const SCHEMA_SNAPSHOT_FILENAME = 'schema-snapshot.json';

function schemaSnapshotPath(statePath) {
  return path.join(bundleDir(statePath), SCHEMA_SNAPSHOT_FILENAME);
}

let schemaSnapshotModule = null;

/**
 * Register (or with null, unregister) the task-52 seam module. Incomplete modules are
 * refused BEFORE replacing the current registration — a half-module must not silently
 * degrade the surface. Returns the registered module.
 */
export function registerSchemaSnapshotModule(mod) {
  if (mod !== null) {
    for (const op of SCHEMA_SNAPSHOT_MODULE_OPS) {
      if (typeof mod[op] !== 'function') {
        throw new Error(`schema_snapshot_module_incomplete: expected ${SCHEMA_SNAPSHOT_MODULE_OPS.join(' and ')}`);
      }
    }
  }
  schemaSnapshotModule = mod;
  return schemaSnapshotModule;
}

export function registeredSchemaSnapshotModule() {
  return schemaSnapshotModule;
}

function requireSnapshotModule() {
  if (!schemaSnapshotModule) {
    throw new Error(
      'schema_snapshot_module_not_implemented: lib/schema-snapshot.mjs (task 52) has not landed; this verb refuses rather than faking a capture or an identity'
    );
  }
  return schemaSnapshotModule;
}

/**
 * §5.3 absorbing: a terminal interview absorbs further ledger operations. The schema
 * capture and identity amendment are interview operations, so a terminal interview
 * (waived, converged, exhausted) refuses them by name.
 */
function requireOpenInterview(statePath) {
  const r = replayInterview(statePath);
  if (r.terminal === 'waived') {
    throw new Error(`interview is waived${r.terminalReason ? ` (${r.terminalReason})` : ''} — a terminal interview absorbs schema capture (§5.3)`);
  }
  if (r.terminal) {
    throw new Error(`interview is ${r.terminal} — a terminal interview absorbs schema capture (§5.3)`);
  }
}

/**
 * Replay-derived schema-capture ledger. Everything the two verbs and the §5.5 guards
 * need is DERIVED from events.jsonl — nothing is cached in state.yml.
 *
 *   captured                 — the LAST schema_captured event (the snapshot record)
 *   amendments               — every skill_identity_amended event, in order
 *   recorded_skill_identity  — the identity on record (latest captured or amended)
 *   pending_amendment        — { new_skill_identity } while a declaration awaits its
 *                              approval; null once committed (an append-only event log
 *                              needs no deletion — the amended event closes the declaration)
 */
export function replaySchemaCapture(statePath) {
  const events = loadEvents(statePath);
  let captured = null;
  const amendments = [];
  let pending = null;
  let recorded = null;
  for (const ev of events) {
    if (ev.type === 'schema_captured') {
      captured = ev;
      recorded = ev.skill_identity;
    } else if (ev.type === 'skill_identity_amended') {
      amendments.push(ev);
      recorded = ev.new_skill_identity;
      if (pending && pending.new_skill_identity === ev.new_skill_identity) pending = null;
    } else if (
      ev.type === 'interview_checkpoint' && ev.data && ev.data.kind === 'skill_identity_amendment_declared'
    ) {
      pending = { new_skill_identity: ev.data.new_skill_identity };
    }
  }
  return { captured, amendments, recorded_skill_identity: recorded, pending_amendment: pending };
}

/**
 * The approved schema-capture control. The module supplies the snapshot bytes' digest
 * and the closed-set skill identity; the verb owns the terminal-interview refusal, the
 * unchanged-skill refusal (a capture records a schema STATE — recapturing an unchanged
 * skill appends nothing), and the schema_captured event with the §6.1 format pin.
 */
export function captureSchema({ statePath, skillRoot } = {}) {
  if (!statePath) throw new Error('captureSchema: statePath is required');
  requireOpenInterview(statePath);
  const mod = requireSnapshotModule();
  if (!skillRoot) throw new Error('captureSchema: skillRoot is required — the snapshot reads the INSTALLED skill, never a caller-supplied schema');
  // Guard failures (SKILL_GUARD_FAILURES) propagate verbatim from the module.
  const snap = mod.captureSchemaSnapshot({ skillRoot });
  const ledger = replaySchemaCapture(statePath);
  if (ledger.recorded_skill_identity === snap.skill_identity) {
    throw new Error(
      `the skill identity is unchanged (${String(snap.skill_identity).slice(0, 16)}…) — capture-schema records a schema state, and re-capturing an unchanged skill appends nothing (§5.5)`
    );
  }
  if (ledger.recorded_skill_identity !== null) {
    // §5.5's identity replacement is the SINGLE guard-exempt path, and it requires the
    // operator's approval. A changed identity arriving through capture would adopt without
    // approval (and strand any pending declaration whose identity it equals — the amended
    // event then refuses old==new and the declaration can never clear).
    throw new Error(
      `skill_identity_changed: the skill identity changed since the last capture (${String(ledger.recorded_skill_identity).slice(0, 16)}… -> ${String(snap.skill_identity).slice(0, 16)}…) — replace it through mp interview amend-skill-identity (§5.5's single guard-exempt, approval-bound path); capture-schema records the FIRST schema state only`
    );
  }
  // §5.5: the exact schema.json BYTES are copied into the bundle as the snapshot — a frozen
  // bundle (or any later read) resolves this file, never the live skill file. The copied
  // bytes' digest must equal the digest the module returned over the bytes it validated: a
  // mismatch (a torn read, a mid-capture edit) fails closed with NO event and NO snapshot.
  const snapshot = copySchemaSnapshotBytes({ skillRoot, statePath, expectedSchemaSha256: snap.schema_sha256 });
  const event = {
    type: 'schema_captured',
    schema_sha256: snapshot.schema_sha256,
    skill_identity: snap.skill_identity,
    host_contract_version: String(snap.host_contract_version),
    schema_format_version: String(snap.schema_format_version),
    format_pin: 'schema_backed',
  };
  appendEvent(statePath, event);
  return event;
}

// ---- no-follow snapshot file access (wave-12 review fix: a snapshot symlink is not the snapshot) --

/**
 * Open a bundle file WITHOUT following symlinks and read it through the SAME descriptor
 * verified a regular file. A snapshot replaced by a symlink to the live skill file would
 * otherwise make a FROZEN bundle read the live file — digest equality does not establish
 * snapshot independence. ENOENT maps to the caller's missing-failure name; a symlink or
 * non-regular descriptor is ALWAYS `schema_snapshot_not_regular` (both call sites want the
 * tamper named for what it is).
 */
function readBundleFileNoFollow(filePath, missingName, missingDetail) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`${missingName}: ${typeof missingDetail === 'function' ? missingDetail(e) : missingDetail}`);
    }
    if (e.code === 'ELOOP' || e.code === 'ENOTDIR') {
      throw new Error(`schema_snapshot_not_regular: ${filePath} is not a regular snapshot file (it is a symlink or contains one) — a frozen bundle never reads through a symlink, and digest equality is not snapshot independence (§5.5)`);
    }
    throw new Error(`${missingName}: ${typeof missingDetail === 'function' ? missingDetail(e) : missingDetail}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`schema_snapshot_not_regular: ${filePath} is not a regular file (the opened descriptor is ${st.isDirectory() ? 'a directory' : 'not a regular file'}) — a bundle snapshot must be a regular file, never a symlink or device (§5.5)`);
    }
    const chunks = [];
    for (;;) {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The §5.5 snapshot copy: read the installed skill's schema.json bytes, write them beside
 * state.yml as the bundle snapshot, and verify the copied bytes' digest equals the digest
 * the module returned (the digest over the bytes it validated). Any mismatch fails closed
 * and removes the partial file — a refusal is never a partial write.
 *
 * The copy is published via a fresh temp file and an atomic rename: rename replaces the
 * DIRECTORY ENTRY, so a pre-existing or raced `schema-snapshot.json` symlink can never be
 * followed into its target (writeFileSync would follow it and clobber the live file).
 */
function copySchemaSnapshotBytes({ skillRoot, statePath, expectedSchemaSha256 }) {
  const snapshotPath = schemaSnapshotPath(statePath);
  let schemaBytes;
  try {
    schemaBytes = fs.readFileSync(path.join(skillRoot, 'schema.json'));
  } catch {
    throw new Error(
      `undeclared_dependency: the declared schema.json is no longer readable under ${skillRoot} at copy time — the snapshot copy is refused, never taken from a live file that vanished (§5.5)`
    );
  }
  const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
  if (digest(schemaBytes) !== expectedSchemaSha256) {
    throw new Error(
      `schema_snapshot_mismatch: the schema bytes under ${skillRoot} hash to ${digest(schemaBytes)} but the module reported ${expectedSchemaSha256} — the live file changed mid-capture; nothing is captured (§5.5)`
    );
  }
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  // A pre-existing non-regular snapshot (symlink to the live file, directory, device) is
  // refused outright — the snapshot entry itself must be a regular file or absent.
  let pre;
  try {
    pre = fs.lstatSync(snapshotPath);
  } catch {
    pre = null; // absent — the normal case
  }
  if (pre !== null && !pre.isFile()) {
    throw new Error(
      `schema_snapshot_not_regular: the bundle snapshot path ${snapshotPath} already holds a non-regular file (symlink, directory or device) — the copy is refused rather than following or clobbering it (§5.5)`
    );
  }
  const tmpPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, schemaBytes);
  try {
    fs.renameSync(tmpPath, snapshotPath);
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    throw e;
  }
  // Read the published entry back WITHOUT following symlinks and confirm the exact bytes
  // landed (a raced entry swap can't hide behind a following read).
  const written = readBundleFileNoFollow(
    snapshotPath,
    'schema_snapshot_mismatch',
    `the published snapshot ${snapshotPath} vanished or is unreadable after the copy — nothing is recorded (§5.5)`,
  );
  if (digest(written) !== expectedSchemaSha256) {
    fs.rmSync(snapshotPath, { force: true });
    throw new Error(
      `schema_snapshot_mismatch: the copied snapshot's bytes do not hash to the recorded ${expectedSchemaSha256} — the partial file is removed and the capture is refused (§5.5)`
    );
  }
  return { snapshot_path: snapshotPath, schema_sha256: expectedSchemaSha256, bytes: written };
}

/**
 * The declaration half of amend-skill-identity: record that the changed skill recomputes
 * to a NEW identity. The identity is recomputed from the skill through the module — an
 * asserted identity that does not recompute is refused. The declaration is durable
 * (an interview_checkpoint event), so an interrupted amendment resumes.
 */
export function declareSkillIdentityAmendment({ statePath, newSkillIdentity, skillRoot } = {}) {
  if (!statePath) throw new Error('declareSkillIdentityAmendment: statePath is required');
  const ledger = replaySchemaCapture(statePath);
  if (!ledger.captured) {
    throw new Error('no schema_captured event on this bundle — capture the schema first (mp interview capture-schema)');
  }
  requireOpenInterview(statePath);
  const mod = requireSnapshotModule();
  if (!skillRoot) {
    throw new Error('missing --skill-root: the declared identity must be RECOMPUTED from the changed skill, not asserted from a file');
  }
  // Guard failures propagate verbatim from the module.
  const recomputed = mod.computeSkillIdentity({ skillRoot });
  if (newSkillIdentity !== recomputed) {
    throw new Error(
      `the declared identity does not equal the recomputed identity of the changed skill (declared ${String(newSkillIdentity).slice(0, 16)}…, recomputed ${String(recomputed).slice(0, 16)}…) — identity is computed, never asserted`
    );
  }
  if (newSkillIdentity === ledger.recorded_skill_identity) {
    throw new Error(
      `the declared identity equals the one on record (${String(ledger.recorded_skill_identity).slice(0, 16)}…) — an amendment replaces a CHANGE; there is nothing to amend`
    );
  }
  appendEvent(statePath, {
    type: 'interview_checkpoint',
    data: { kind: 'skill_identity_amendment_declared', new_skill_identity: newSkillIdentity },
  });
  return replaySchemaCapture(statePath).pending_amendment;
}

function validateOperatorApproval(approval, declaredIdentity) {
  if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) {
    throw new Error('the operator approval must be an object (the user-attested receipt)');
  }
  if (approval.attested_by !== 'user') {
    throw new Error("the operator approval must be user-attested (approval.attested_by must be 'user')");
  }
  for (const k of ['purpose', 'question', 'answer', 'ts']) {
    if (typeof approval[k] !== 'string' || approval[k].trim() === '') {
      throw new Error(`approval.${k} must be a non-empty string`);
    }
  }
  if (approval.skill_identity !== declaredIdentity) {
    throw new Error(
      `no adoption before the operator's approval: the approval binds ${JSON.stringify(approval.skill_identity)} but the declared identity is ${declaredIdentity}`
    );
  }
}

/**
 * Count the receipts the amendment strands: events carrying the OLD identity in any
 * tuple position. §5.5's old-identity receipt invalidation is REPORTED, not silently
 * performed — the count rides the skill_identity_amended event.
 */
function countInvalidatedReceipts(statePath, oldIdentity) {
  if (!oldIdentity) return 0;
  let count = 0;
  for (const ev of loadEvents(statePath)) {
    if (ev.type === 'schema_captured' || ev.type === 'skill_identity_amended') continue;
    if (
      ev.type === 'interview_checkpoint' && ev.data && ev.data.kind === 'skill_identity_amendment_declared'
    ) {
      continue; // a declaration is the replacement's own record, not a receipt it strands
    }
    if (hasIdentityBoundReceipt(ev, oldIdentity)) count += 1;
  }
  return count;
}

/**
 * Identity-bound receipt detection: the event carries the OLD identity in a field named
 * `skill_identity` at ANY depth (the §5.5 tuple positions — data.skill_identity,
 * intent_identity.skill_identity, …). Value equality at a named field, never a textual
 * mention: prose that merely quotes the digest is not a receipt.
 */
function hasIdentityBoundReceipt(value, oldIdentity, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    if (k === 'skill_identity' && v === oldIdentity) return true;
    if (v !== null && typeof v === 'object' && hasIdentityBoundReceipt(v, oldIdentity, seen)) return true;
  }
  return false;
}

/**
 * The resumable identity replacement. Two entry shapes, one event:
 *   { newSkillIdentity, skillRoot [, approval] } — declare (recompute + durable
 *     checkpoint), then either commit under the approval or leave it pending.
 *   { approval } — replay a pending declaration from disk and commit it.
 * No identity is adopted before the approval; the approval binds the exact declared
 * identity; a committed amendment is exactly-once (re-declaring the on-record identity
 * refuses as "nothing to amend").
 */
export function amendSkillIdentity({ statePath, newSkillIdentity, skillRoot, approval } = {}) {
  if (!statePath) throw new Error('amendSkillIdentity: statePath is required');
  let ledger = replaySchemaCapture(statePath);
  let declaredIdentity = null;
  if (typeof newSkillIdentity !== 'string' || newSkillIdentity === '') {
    if (!ledger.pending_amendment) {
      throw new Error(
        'nothing to amend: declare a changed skill identity (--identity-file plus --skill-root, so it is recomputed) or supply the operator approval to commit a pending declaration (--approval)'
      );
    }
    // Approval-only replay of a pending declaration. The seam is still REQUIRED here:
    // the amendment is a §5.5 operation, and a replay with the module absent must report
    // the named schema_snapshot_module_not_implemented failure, not commit from ledger
    // memory. (The identity itself was recomputed when the declaration was written and
    // rides the durable checkpoint; recomputation without a skillRoot is the declaration
    // step's job, and the approval still binds the exact recorded identity.)
    requireSnapshotModule();
    declaredIdentity = ledger.pending_amendment.new_skill_identity;
  } else {
    declaredIdentity = newSkillIdentity;
    declareSkillIdentityAmendment({ statePath, newSkillIdentity, skillRoot });
  }
  if (approval === undefined || approval === null) {
    throw new Error(
      `amendment_pending: the declaration for ${declaredIdentity.slice(0, 16)}… is recorded and durable; supply the operator approval (--approval) to commit it — no identity is adopted before the operator's approval (§5.5)`
    );
  }
  validateOperatorApproval(approval, declaredIdentity);
  // Re-replay AFTER the declaration so old identity and stranded-receipt counts are exact.
  ledger = replaySchemaCapture(statePath);
  const event = {
    type: 'skill_identity_amended',
    old_skill_identity: ledger.recorded_skill_identity,
    new_skill_identity: declaredIdentity,
    approval,
    invalidated_receipts: countInvalidatedReceipts(statePath, ledger.recorded_skill_identity),
  };
  appendEvent(statePath, event);
  return event;
}

// ---- §5.5 enforcement: the later-operation guard + the frozen-bundle read --------

/**
 * §5.5's identity-equality guard: at every later operation the installed skill's recomputed
 * identity must equal the run's recorded identity, or the operation stops with a named
 * failure. This is THE enforcement primitive — every §5.5 operation calls it; the ONE
 * exemption is mp interview amend-skill-identity itself. The module's four other named
 * failures (skill_absent, host_contract_unsupported, schema_unsupported,
 * undeclared_dependency) propagate verbatim; a mismatch is skill_identity_changed. There
 * is NO fallback to native questioning and NO fallback to a live schema.
 */
export function assertSkillIdentity({ statePath, skillRoot } = {}) {
  if (!statePath) throw new Error('assertSkillIdentity: statePath is required');
  const ledger = replaySchemaCapture(statePath);
  if (!ledger.captured) {
    throw new Error('no schema_captured event on this bundle — capture the schema first (mp interview capture-schema)');
  }
  if (!skillRoot) {
    throw new Error('assertSkillIdentity: skillRoot is required — the guard recomputes the installed skill\'s identity, never accepts an asserted one');
  }
  const mod = requireSnapshotModule();
  // Guard failures from the module propagate verbatim (SKILL_GUARD_FAILURES).
  const recomputed = mod.computeSkillIdentity({ skillRoot });
  if (recomputed !== ledger.recorded_skill_identity) {
    throw new Error(
      `skill_identity_changed: the installed skill recomputes to ${recomputed.slice(0, 16)}… but this run recorded ${ledger.recorded_skill_identity.slice(0, 16)}… — replace it through mp interview amend-skill-identity (§5.5's single guard-exempt, approval-bound path); there is no fallback to native questioning or a live schema`
    );
  }
  return { skill_identity: recomputed, schema_sha256: ledger.captured.schema_sha256, ok: true };
}

/**
 * The §5.5 read path: resolve the bundle's schema snapshot — the exact bytes copied at
 * approved capture — NEVER the live skill file. A FROZEN bundle (status archived) reads
 * here exactly like an in-progress one; the function takes only statePath, so it
 * structurally CANNOT fall back to a live file. Failures are named and fail closed:
 * no capture on the bundle, snapshot file missing, snapshot bytes not matching the
 * recorded digest.
 */
export function readSchemaSnapshot({ statePath } = {}) {
  if (!statePath) throw new Error('readSchemaSnapshot: statePath is required');
  const ledger = replaySchemaCapture(statePath);
  if (!ledger.captured) {
    throw new Error('no schema_captured event on this bundle — there is no snapshot to read (mp interview capture-schema writes it)');
  }
  const snapshotPath = schemaSnapshotPath(statePath);
  // NO-FOLLOW read (wave-12 review finding): a snapshot replaced by a symlink to the live
  // skill file must fail closed here, not read the live file through the symlink — the
  // frozen bundle reads ITS snapshot bytes only, and digest equality does not establish
  // snapshot independence.
  let bytes;
  bytes = readBundleFileNoFollow(
    snapshotPath,
    'schema_snapshot_missing',
    (e) => `the bundle snapshot ${snapshotPath} is missing or unreadable (${e.code}) while a schema_captured event exists — never fall back to the live skill file (§5.5); re-capture is impossible on a recorded bundle, so the snapshot must be restored from the bundle's own history`,
  );
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== ledger.captured.schema_sha256) {
    throw new Error(
      `schema_snapshot_mismatch: the bundle snapshot ${snapshotPath} hashes to ${digest} but the schema_captured event records ${ledger.captured.schema_sha256} — a mismatched schema fails closed, never reads the live file (§5.5)`
    );
  }
  let schema;
  try {
    schema = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new Error(`schema_unsupported: the recorded snapshot is not valid JSON (${e.message}) — impossible after a digest match unless the event is forged; fails closed (§5.5)`);
  }
  return {
    snapshot_path: snapshotPath,
    bytes,
    schema,
    schema_sha256: digest,
    skill_identity: ledger.recorded_skill_identity,
    host_contract_version: ledger.captured.host_contract_version,
    schema_format_version: ledger.captured.schema_format_version,
    format_pin: ledger.captured.format_pin,
  };
}
