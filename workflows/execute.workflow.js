// workflows/execute.workflow.js — the L2 within-session execution engine (build step 4).
//
// A Workflow-tool script: it runs under the Workflow runtime (NOT plain node), using the injected
// agent()/pipeline()/parallel()/phase()/log()/args/budget globals. It does ALL dispatching itself —
// agents never spawn agents (one-level nesting cap). It executes EXACTLY ONE wave per launch: L1
// (the shell) drives the wave loop (decide -> dispatch_wave -> launch -> record digests -> commit ->
// decide -> next wave), so a crash leaves a single-wave active_run that recovers by resetting just
// that one wave's declared scope. A multi-wave workflow would make active_run/recovery ambiguous.
//
// THE L1<->L2 SEAM (load-bearing). A Workflow script has NO module/fs/git access, so it CANNOT
// import lib/routing.mjs and CANNOT run git. "L2 consumes routing.mjs" therefore means L1 PRE-
// RESOLVES routing (`mp prepare-wave`, which runs routeTask) and passes lean, already-routed task
// payloads down via `args`. The git baseline for the D6/F-SCOPE check is likewise captured by the
// shell and threaded through `args.baseline`; this workflow only ECHOES it back in its result so the
// completion-turn controller can diff it against a fresh `after` capture (`mp verify-scope`). All
// timestamps / IDs / git stay in L1 — never here (Date.now()/Math.random() are unavailable anyway).
//
// INVARIANT: returns digests only. NEVER writes state.yml, NEVER commits — L1 is the single durable
// writer, post-barrier. That is exactly what keeps crash re-dispatch idempotent (CD-7).
//
// DESIGN DECISION — inline-only implementation (Fork 1, resolved 2026-05-28: keep inline; no
// codex-implementer). The agent roster is mp-implementer (sonnet) + mp-codex-reviewer ONLY; there is
// intentionally no codex-IMPLEMENTER. A codex-implementer needs WRITE access, which drags back the
// whole v7 sandbox/worktree-git/silent-exit/empty-diff/orphan hardening series that v8 exists to
// delete — and parity ranks below durable-state/token-efficiency in the v8 rubric, so it buys nothing
// the rubric rewards. The codex-REVIEWER is kept because a foreground `timeout codex exec` is
// read-only and cannot orphan (the unsafe write-path is the implementer, not the reviewer; see
// agents/mp-codex-reviewer.md + WORKLOG). So every task is IMPLEMENTED inline by mp-implementer
// regardless of its routed `target`. `target` (from routeTask) is informational/logged-only: it
// neither gates implementation (always inline) nor gates review (review is CONFIG-gated — see
// review() below). It records which tasks a future codex-implementer COULD offload, never a silent cap.

export const meta = {
  name: 'masterplan-execute',
  description: 'masterplan single-wave execution: one mp-implementer per task in parallel, optional config-gated Codex review, returns digests only (never writes state / never commits)',
  phases: [
    { title: 'Dispatch', detail: 'one mp-implementer per task (wave barrier)' },
    { title: 'Review', detail: 'config-gated mp-codex-reviewer per done task' },
  ],
};

// ---- args (resolved by L1: `mp prepare-wave` output + the shell's git/host probes) ----
const wave = args?.wave;
const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
const baseline = Array.isArray(args?.baseline) ? args.baseline : []; // git-touched set BEFORE launch (D6)
const repoRoot = args?.repoRoot ?? '(launch cwd)';
const reviewOn = (args?.review ?? 'off') === 'on';

// The mp-implementer digest, schema-validated at the tool boundary (mirror of agents/mp-implementer.md
// — keep byte-aware-synced). A validated return removes a retry round-trip (design goal 2). Lenient
// (additionalProperties) but pins the critical fields + the status enum.
const IMPL_DIGEST = {
  type: 'object',
  required: ['task_id', 'status', 'files_changed', 'summary'],
  additionalProperties: true,
  properties: {
    task_id: { type: 'integer' },
    status: { type: 'string', enum: ['done', 'failed', 'blocked'] },
    start_sha: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    verify: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          passed: { type: 'boolean' },
          output: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    blockers: { type: ['string', 'null'] },
  },
};

function implementerPrompt(t) {
  return [
    `Implement masterplan task ${t.id}. Your launch cwd IS the target repo (${repoRoot}); treat every path as relative to it and never write outside it.`,
    ``,
    `Task: ${t.description}`,
    `Declared file scope — edit ONLY these: ${(t.files ?? []).join(', ') || '(none declared)'}`,
    `Verify commands — run every one and cite real output: ${(t.verify_commands ?? []).join(' ; ') || '(none provided — report that the task could not be verified)'}`,
    ``,
    `Capture the start SHA (git rev-parse HEAD) before your first edit. Return the digest object exactly. NEVER commit, NEVER write state.yml.`,
  ].join('\n');
}

function reviewerPrompt(task, files) {
  return [
    `Adversarially review masterplan task ${task.id} (Codex second opinion).`,
    `Task intent: ${task.description}`,
    `Focus on these changed files: ${files || "(use git in your launch cwd to find the wave's changes)"}`,
    'Run the Codex CLI per your invocation contract (read-only, time-capped). Return the CD-10 severity-first findings + a closing `verdict:` line. Never block on a wedged Codex.',
  ].join('\n');
}

// Pull the verdict word out of the reviewer's prose (its contract closes with `verdict: <word>`).
// Lenient + fail-safe: default to 'inconclusive' when absent so a malformed review never reads clean.
function extractVerdict(text) {
  const m = /verdict:\s*(blocking|advisory|clean|inconclusive)/i.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : 'inconclusive';
}

// Stage 1: implement one task. Always returns an object (never throws) so the item never silently
// nulls out of the pipeline — a vanished item would read as "wave smaller than it is".
async function implement(t) {
  let digest = null;
  try {
    digest = await agent(implementerPrompt(t), {
      label: `impl:task-${t.id}`,
      phase: 'Dispatch',
      agentType: 'masterplan:mp-implementer',
      schema: IMPL_DIGEST,
    });
  } catch (e) {
    log(`  task ${t.id}: implementer dispatch errored (${String(e?.message ?? e)})`);
  }
  if (!digest) {
    // Skipped (user) or errored: synthesize a failed digest so the task is RECORDED + surfaced.
    // L1 leaves it pending → the next decide recovers + re-dispatches it idempotently.
    log(`  task ${t.id}: no digest (skipped/errored) → recorded failed`);
    return {
      task_id: t.id,
      target: t.target,
      digest: { task_id: t.id, status: 'failed', files_changed: [], summary: 'no digest (agent skipped or errored)', blockers: 'no-digest' },
      review: null,
    };
  }
  return { task_id: t.id, target: t.target, digest, review: null };
}

// Stage 2: optional Codex second opinion — PER-TASK single-pass (Fork 2, resolved 2026-05-28: keep
// per-task; NOT per-wave, NOT spec+quality two-stage). Per-task is failure-isolated (one wedged Codex
// degrades one task's review, never the whole wave's), maps each finding to a task for re-dispatch,
// and — since review is config-gated OFF by default — a fewer-calls topology wins nothing on the
// common path. Two-stage's 2N Codex calls violate token-efficiency; v8 trims that self-checking.
// Gated by CONFIG only — NOT by `target`/eligibility:
// judgment-heavy (inline-routed) tasks need a second opinion MORE, not less, so gating review by
// codex-eligibility would skip exactly the riskiest work. Only review a task that actually got
// `done` (a failed/blocked non-edit has nothing to review and surfaces to the user instead).
// Signature: pipeline() invokes every stage with (prevResult, originalItem, index) — so `item` is
// implement()'s output and `task` is the ORIGINAL routed task (its .id/.description), not a
// re-derivation. That contract is why reviewerPrompt(task, …) can read task.id/description directly.
async function review(item, task) {
  if (!reviewOn || item.digest?.status !== 'done') return item;
  const files = (item.digest.files_changed ?? []).join(', ');
  let verdict = 'inconclusive';
  let findings = 'NOTE — Codex review inconclusive (no output). verdict: inconclusive';
  try {
    const text = await agent(reviewerPrompt(task, files), {
      label: `review:task-${item.task_id}`,
      phase: 'Review',
      agentType: 'masterplan:mp-codex-reviewer',
    });
    if (text) {
      findings = String(text);
      verdict = extractVerdict(text);
    }
  } catch (e) {
    log(`  task ${item.task_id}: reviewer errored (${String(e?.message ?? e)}) → inconclusive`);
  }
  return { ...item, review: { verdict, findings } };
}

// ---- run the single wave ----
if (tasks.length === 0) {
  // An empty wave is not an error here (L1's decide picks the wave; a 0-task wave means all its
  // tasks were already done before launch). Return a well-formed empty result.
  log(`masterplan-execute: wave ${wave} has no tasks to dispatch.`);
  return { wave, baseline, tasks: [], summary: { total: 0, done: 0, failed: 0, reviewed: 0, reviewOn } };
}

log(`masterplan-execute: wave ${wave} — ${tasks.length} task(s); review ${reviewOn ? 'ON' : 'off'}`);
for (const t of tasks) log(`  task ${t.id} → routed ${t.target} (${t.reason})`);
const codexCount = tasks.filter((t) => t.target === 'codex').length;
if (codexCount) {
  log(`  note: ${codexCount} task(s) codex-eligible by routing, implemented INLINE by design ` +
      '(v8 has no codex-implementer — see header). target is logged, never a silent cap.');
}

// pipeline (NOT a barrier between stages): task A's review starts the instant A implements, while B
// is still implementing — A's review never depends on B's edit (disjoint same-wave scope is the
// planner's invariant). The workflow still resolves only when ALL items clear both stages; THAT is
// the wave barrier L1 awaits via the completion notification.
const results = (await pipeline(tasks, implement, review)).filter(Boolean);

const done = results.filter((r) => r.digest?.status === 'done').length;
const failed = results.length - done;
const reviewed = results.filter((r) => r.review).length;
log(`masterplan-execute: wave ${wave} complete — ${done}/${results.length} done, ${failed} not-done, ${reviewed} reviewed. Spent ~${Math.round(budget.spent() / 1000)}k output tok.`);

// Digests only. L1 records each done task (`mp mark-task`), surfaces failed/blocked, runs the D6
// `mp verify-scope` using `baseline` as `before` vs a fresh `after`, then commits + advances.
return { wave, baseline, tasks: results, summary: { total: tasks.length, done, failed, reviewed, reviewOn } };
