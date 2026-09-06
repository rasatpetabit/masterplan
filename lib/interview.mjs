// lib/interview.mjs — replayable interview ledger (wave task 11).
//
// Deterministic verbs over events.jsonl, each an append through the bundle writer
// (appendEvent, CD-7 single writer). All state is DERIVED BY REPLAY — no in-memory
// counters, no hand-edited state.yml. See spec §4.2 (budgets), §5.3 (verbs), §5.4
// (terminal states).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

export function askQuestion({ statePath, id, round, kind, text, supersedes }) {
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

export function answerQuestion({ statePath, id, text, corrected, supersedes, resolves }) {
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

export function withdrawQuestion({ statePath, id, reason, resolves }) {
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

export function recordDraft({ statePath, intent }) {
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

export function recordCritic({ statePath, receipt, payloadPath }) {
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

export function endInterview({ statePath, reason, criticUnavailableAck }) {
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  if (!['converged', 'exhausted', 'critic_off'].includes(reason)) {
    throw new Error(`invalid end reason ${JSON.stringify(reason)}`);
  }
  // Zero unanswered questions.
  const unanswered = [...r.questions.values()].some((q) => q.answer === null && !q.withdrawn);
  if (unanswered) throw new Error('there are unanswered questions — answer or withdraw them first');

  const floorMet = r.answered >= r.budget.floor;
  const intentFloorMet = r.answeredIntent >= r.budget.intent_floor;
  const roundsMet = r.completedIntentRounds >= r.budget.intent_rounds_min;
  const hasDraft = r.latestDraft !== null;
  // The draft must be the latest intent-content event (no intent answer after it).
  const draftIsLatest = hasDraft && r.latestDraft.index === r.contentHead;

  // §5.4: every terminal state other than `waived` needs the floors, the intent-round minimum and a
  // draft as the latest intent-content event — a cap reached with the floor unmet leaves only the waiver.
  if (!floorMet) throw new Error(`${reason} requires the answer floor met (${r.answered}/${r.budget.floor}; withdrawn questions never count)`);
  if (!intentFloorMet) throw new Error(`${reason} requires the intent floor met (${r.answeredIntent}/${r.budget.intent_floor})`);
  if (!roundsMet) throw new Error(`${reason} requires the intent-round minimum met (${r.completedIntentRounds}/${r.budget.intent_rounds_min})`);
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
  } else if (reason === 'exhausted') {
    const atCap = r.asked >= r.budget.cap;
    const ackGiven = criticUnavailableAck !== undefined && criticUnavailableAck !== null;
    const unavailableWithAck =
      r.criticMode === 'unavailable' &&
      r.unavailableAtHead >= 2 &&
      (ackGiven || r.criticUnavailableAck !== null);
    if (!atCap && !unavailableWithAck) {
      throw new Error('exhausted requires the cap reached or critic unavailable with an acknowledgement');
    }
    if (unavailableWithAck && ackGiven && r.criticUnavailableAck === null) {
      // A transient ack is made durable first; a ledger-recorded one (acknowledgeCriticUnavailable) is reused.
      appendEvent(statePath, { type: 'critic_unavailable_ack', answer: criticUnavailableAck });
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
    });
    return;
  } else if (reason === 'critic_off') {
    if (r.state.complexity !== 'low') throw new Error('critic_off requires complexity low');
  }
  appendEvent(statePath, { type: 'interview_end', reason });
}

export function waiveInterview({ statePath, reason }) {
  const r = replayInterview(statePath);
  assertNotTerminal(r);
  requireText(reason, 'waiver reason');
  const floorUnmetAtCap = r.asked >= r.budget.cap && r.answered < r.budget.floor;
  appendEvent(statePath, { type: 'interview_waived', reason, ...(floorUnmetAtCap ? { cause: 'floor_unmet_at_cap' } : {}) });
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
      `the skill identity changed since the last capture (${String(ledger.recorded_skill_identity).slice(0, 16)}… -> ${String(snap.skill_identity).slice(0, 16)}…) — replace it through mp interview amend-skill-identity (§5.5's single guard-exempt, approval-bound path); capture-schema records the FIRST schema state only`
    );
  }
  const event = {
    type: 'schema_captured',
    schema_sha256: snap.schema_sha256,
    skill_identity: snap.skill_identity,
    host_contract_version: String(snap.host_contract_version),
    schema_format_version: String(snap.schema_format_version),
    format_pin: 'schema_backed',
  };
  appendEvent(statePath, event);
  return event;
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
