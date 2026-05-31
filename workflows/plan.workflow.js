// workflows/plan.workflow.js — the L2 within-session PLANNING engine (parallel-planning feature).
//
// Sibling of execute.workflow.js, same runtime contract: a Workflow-tool script using the injected
// agent()/parallel()/phase()/log()/args/budget globals. It does ALL dispatching itself (agents never
// spawn agents — one-level nesting cap), and it returns DIGESTS ONLY: a set of subsystem plan
// FRAGMENTS. It NEVER writes plan.index.json/plan.md and NEVER commits — assembly is deterministic and
// happens in L1 (`mp merge-plan-fragments`, which owns global ids/waves/codex-normalisation). That
// split is the whole point: the LLM drafts subsystem task lists in parallel; deterministic JS owns the
// final index bytes, so neither anomaly the feature targets (object-codex drift, wave re-authoring) can
// originate in an LLM.
//
// THE L1<->L2 SEAM. A Workflow script has NO module/fs/git access, so it CANNOT import lib/plan-merge
// and CANNOT read the spec from disk for itself. L1 PRE-RESOLVES the decomposition — "these N
// subsystems, each with this slice of the spec" — and passes it down via `args.subsystems`. Producing
// that subsystem list from the spec is design judgment that belongs to L1 (the brainstorm→plan
// lifecycle wiring, step 7); this engine only fans out one drafter per already-decided subsystem and
// collects their fragments. All timestamps / ids / waves / git stay out of here (and Date.now() /
// Math.random() are unavailable anyway).
//
// INVARIANT: returns fragments only. NEVER writes artifacts, NEVER commits — L1 merges + is the single
// durable writer. A drafter that is skipped or errors nulls out and is dropped (a missing subsystem is
// surfaced by L1 diffing returned keys against the requested set), never silently faked.

export const meta = {
  name: 'masterplan-plan',
  description: 'masterplan parallel planning: one mp-subsystem-planner per subsystem (parallel), returns plan FRAGMENTS only — L1 deterministically merges them into plan.index.json/plan.md (never writes artifacts / never commits)',
  phases: [
    { title: 'Draft', detail: 'one mp-subsystem-planner per subsystem (parallel barrier)' },
  ],
};

// ---- args (resolved by L1: the spec path + the decided subsystem decomposition) ----
// SEAM NORMALIZATION (identical to execute.workflow.js:51). The `Workflow` TOOL boundary delivers
// object `args` JSON-STRINGIFIED, so the script's `args` global is a STRING; the in-script
// workflow(ref,obj) path delivers a real object. Accept both. A string that isn't valid JSON is a
// launch bug — JSON.parse throws loud, which beats silently drafting a zero-subsystem plan.
const A = (typeof args === 'string') ? JSON.parse(args) : (args ?? {});
const subsystems = Array.isArray(A.subsystems) ? A.subsystems : [];
const specPath = A.specPath ?? '(spec.md in the bundle)';
const repoRoot = A.repoRoot ?? '(launch cwd)';

// DOGFOOD SEAM (mirror of execute.workflow.js:66). Production NEVER sets these; the defaults reproduce
// shipping behaviour (the `masterplan:` agent on its frontmatter model, opus for the drafter). L1 may
// inject a resolvable agentType + explicit model to exercise the engine from an uninstalled worktree.
const draftAgentType = A.draftAgentType ?? 'masterplan:mp-subsystem-planner';
const draftModel = A.draftModel; // undefined in prod → frontmatter model (opus) governs

// The mp-subsystem-planner FRAGMENT digest, schema-validated at the tool boundary. NOTE what is
// ABSENT: no `id`, no `wave`. Those are global properties only the deterministic merge may assign —
// a drafter that volunteers them is ignored. `codex` is pinned to the STRING enum here (LAYER 1 of the
// anomaly-1 defence): the object/boolean shape cannot even be RETURNED at the tool boundary, so
// normalisation in plan-merge is belt-and-suspenders rather than the only guard.
const FRAGMENT = {
  type: 'object',
  required: ['key', 'tasks'],
  additionalProperties: true,
  properties: {
    key: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'description', 'files', 'verify_commands'],
        additionalProperties: true,
        properties: {
          key: { type: 'string' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          verify_commands: { type: 'array', items: { type: 'string' } },
          deps: { type: 'array', items: { type: 'string' } },
          codex: { type: ['string', 'null'], enum: ['ok', 'no', null] },
          sensitive: { type: 'boolean' },
          conversational: { type: 'boolean' },
          spec_refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

function drafterPrompt(s) {
  return [
    `Draft the plan FRAGMENT for the "${s.key}" subsystem of this build. Your launch cwd IS the target repo (${repoRoot}); read for context, do NOT write.`,
    ``,
    `Subsystem: ${s.title ?? s.key}`,
    `Scope / responsibility: ${s.description ?? '(see the spec section below)'}`,
    s.spec_refs?.length ? `Relevant spec sections: ${s.spec_refs.join(', ')}` : `Spec: ${specPath}`,
    s.files_hint?.length ? `Likely files in this subsystem: ${s.files_hint.join(', ')}` : ``,
    ``,
    `Return a fragment: { key: "${s.key}", tasks: [ { key, description, files, verify_commands, deps?, codex?, spec_refs? } ] }.`,
    `Task keys must be UNIQUE across the whole plan — prefix them with the subsystem (e.g. "${s.key}.<short-name>").`,
    `Use deps to reference tasks (yours or another subsystem's) that must finish first; do NOT assign global ids or waves — those are computed deterministically after merge.`,
    `Same-wave parallelism is derived from file-disjointness, so keep each task's file set tight and declare deps wherever two tasks must touch the same file.`,
  ].filter(Boolean).join('\n');
}

// Draft one subsystem. Always resolves (never throws) so a failed drafter nulls out cleanly rather
// than rejecting the whole parallel() barrier.
async function draft(s) {
  const opts = { label: `draft:${s.key}`, phase: 'Draft', agentType: draftAgentType, schema: FRAGMENT };
  if (draftModel) opts.model = draftModel; // omitted in prod → frontmatter model (opus) governs
  try {
    const fragment = await agent(drafterPrompt(s), opts);
    if (fragment) return fragment;
    log(`  subsystem ${s.key}: drafter returned no fragment (skipped/errored)`);
  } catch (e) {
    log(`  subsystem ${s.key}: drafter dispatch errored (${String(e?.message ?? e)})`);
  }
  return null;
}

// ---- run the fan-out ----
if (subsystems.length === 0) {
  log('masterplan-plan: no subsystems to draft (L1 passed an empty decomposition).');
  return { subsystems: [], specPath, repoRoot };
}

log(`masterplan-plan: drafting ${subsystems.length} subsystem(s) in parallel.`);
for (const s of subsystems) log(`  subsystem ${s.key} → ${s.title ?? s.key}`);

// parallel() is a BARRIER and that is correct here: there is no inter-drafter pipelining to exploit
// (each drafts independently), and L1 wants the full fragment set together to merge in one shot.
const fragments = (await parallel(subsystems.map((s) => () => draft(s)))).filter(Boolean);

log(`masterplan-plan: ${fragments.length}/${subsystems.length} subsystem fragment(s) returned. Spent ~${Math.round(budget.spent() / 1000)}k output tok.`);

// Fragments only. L1 runs `mp merge-plan-fragments` (deterministic ids/waves/codex), validates, writes
// plan.index.json + plan.md, then dispatches mp-plan-reviewer for coverage/consistency. That L1
// post-merge sequencing (merge → validate → review → gate) is the brainstorm→plan lifecycle wiring
// deferred to step 7; this engine's contract ends at returning the fragment set.
return { subsystems: fragments, specPath, repoRoot };
